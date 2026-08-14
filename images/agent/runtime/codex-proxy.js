'use strict';
/**
 * Anthropic Messages  ⇄  ChatGPT Codex Responses.
 *
 * Claude Code only speaks the Anthropic Messages API, so a ChatGPT-provider
 * agent needs someone to translate. The opencodeGo provider solves the same
 * problem with the prebuilt `oc-go-cc` binary, but that one targets OpenAI
 * *Chat Completions*; Codex speaks the *Responses* API, which is a different
 * shape (input items rather than messages, and a different event stream). So
 * this is a second translator rather than a base-URL swap.
 *
 * Written in Node, inside runtime/, on purpose: that makes it part of the
 * agent's SOFT layer, so it ships via a migration instead of requiring a full
 * image rebuild + container recreate the way a downloaded binary would.
 *
 *   claude ──► retry-proxy (8767) ──► THIS (8768) ──TLS──► chatgpt.com
 *
 * Credentials come from ~/.swarm/chatgpt-creds.json, which the gateway writes
 * (0600) and refreshes. We re-read it per request so a refreshed token is
 * picked up without restarting the agent.
 *
 * CAVEAT: the Codex backend is not a documented public API. The endpoint,
 * headers and event names below are what the Codex CLI itself uses. They work,
 * but they are not a contract.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HOME = process.env.AGENT_HOME || '/home/agent';
const CREDS_FILE = path.join(HOME, '.swarm', 'chatgpt-creds.json');
const UPSTREAM = 'https://chatgpt.com/backend-api/codex/responses';
/** Sent verbatim by the Codex CLI; the backend rejects unknown originators. */
const ORIGINATOR = 'codex_cli_rs';
// The `-codex` ids are API-key-only and 400 here, so this default MUST NOT be
// one. Of the ids a ChatGPT account does accept, gpt-5.4 also has by far the
// largest context window (~910k measured, vs ~355k for the gpt-5.6 family and
// ~245k for gpt-5.5 / gpt-5.4-mini), which makes it the right default for
// long-running agents.
const DEFAULT_MODEL = 'gpt-5.4';

/** Latest rate-limit snapshot seen on a response, for the dashboard's usage
 *  ring. The backend reports these on real calls, which is the only reliable
 *  source — there is no documented usage endpoint. */
let rateLimits = null;
function getRateLimits() {
  return rateLimits;
}

function readCreds() {
  try {
    const j = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    return {
      accessToken: j.access_token || '',
      accountId: j.account_id || '',
      expiresAt: Number(j.expires_at) || 0,
    };
  } catch {
    return null;
  }
}

/** Anthropic `system` is a string or a block array; Responses wants one string. */
function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === 'string' ? b : b && b.type === 'text' ? b.text || '' : ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

/**
 * Anthropic messages → Responses `input` items.
 *
 * The interesting part is tool traffic: Anthropic carries a tool call as a
 * `tool_use` block inside an assistant message and its result as a `tool_result`
 * block inside the NEXT user message, whereas Responses wants them as sibling
 * top-level items (`function_call` / `function_call_output`). So blocks get
 * lifted out of their message rather than nested.
 */
function toInput(messages) {
  const input = [];
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = m.content;
    if (typeof content === 'string') {
      if (content) {
        input.push({
          type: 'message',
          role,
          content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }],
        });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && b.text) {
        parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: b.text });
      } else if (b.type === 'image' && b.source && b.source.data) {
        parts.push({
          type: 'input_image',
          image_url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}`,
        });
      } else if (b.type === 'tool_use') {
        // Flush any text collected so far so ordering survives.
        if (parts.length) {
          input.push({ type: 'message', role, content: parts.splice(0) });
        }
        input.push({
          type: 'function_call',
          name: b.name,
          call_id: b.id,
          arguments: JSON.stringify(b.input ?? {}),
        });
      } else if (b.type === 'tool_result') {
        if (parts.length) {
          input.push({ type: 'message', role, content: parts.splice(0) });
        }
        const out = Array.isArray(b.content)
          ? b.content.map((c) => (c && c.type === 'text' ? c.text : '')).join('')
          : typeof b.content === 'string'
            ? b.content
            : JSON.stringify(b.content ?? '');
        input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: out });
      }
      // `thinking` blocks are Anthropic-only; dropping them is correct here.
    }
    if (parts.length) input.push({ type: 'message', role, content: parts });
  }
  return input;
}

function toTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description || '',
    parameters: t.input_schema || { type: 'object', properties: {} },
    strict: false,
  }));
}

/** Anthropic stop reasons don't map 1:1; pick the closest. */
function stopReason(status, hadToolCall) {
  if (hadToolCall) return 'tool_use';
  if (status === 'incomplete') return 'max_tokens';
  return 'end_turn';
}

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/**
 * Capture the rate-limit snapshot from the RESPONSE HEADERS.
 *
 * Verified against the live backend: these arrive as `x-codex-*` headers, NOT
 * in the SSE body — an earlier version parsed the stream and would have
 * recorded nothing forever. "primary" is the rolling short window and
 * "secondary" the weekly one; the percentages are USED, so the Codex CLI's
 * "96% left" display is 100 minus this.
 */
function captureRateLimits(headers) {
  const num = (k) => {
    const v = headers.get(k);
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const win = (kind) => {
    const used = num(`x-codex-${kind}-used-percent`);
    if (used === null) return null;
    const resetAt = num(`x-codex-${kind}-reset-at`);
    const resetIn = num(`x-codex-${kind}-reset-after-seconds`);
    return {
      usedPercent: used,
      windowMinutes: num(`x-codex-${kind}-window-minutes`),
      // reset-at is unix SECONDS; fall back to the relative form.
      resetsAt: resetAt ? resetAt * 1000 : resetIn !== null ? Date.now() + resetIn * 1000 : null,
    };
  };
  const primary = win('primary');
  const secondary = win('secondary');
  if (!primary && !secondary) return;
  rateLimits = {
    primary,
    secondary,
    plan: headers.get('x-codex-plan-type') || null,
    at: Date.now(),
  };
}

/**
 * Translate one Responses SSE stream into an Anthropic Messages SSE stream.
 * Claude Code is strict about the event order, so the shape here matters:
 * message_start → (content_block_start → deltas → content_block_stop)* →
 * message_delta → message_stop.
 */
async function pipeStream(upstream, res, model) {
  const msgId = `msg_${Date.now().toString(36)}`;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let blockIndex = -1;
  let openBlock = null; // 'text' | 'tool'
  let hadToolCall = false;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let status = 'completed';
  const closeBlock = () => {
    if (openBlock !== null) {
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
      openBlock = null;
    }
  };

  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of upstream.body) {
    buf += decoder.decode(chunk, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }

      switch (ev.type) {
        case 'response.output_text.delta': {
          if (openBlock !== 'text') {
            closeBlock();
            blockIndex++;
            openBlock = 'text';
            sse(res, 'content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'text', text: '' },
            });
          }
          sse(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: ev.delta ?? '' },
          });
          break;
        }
        case 'response.output_item.added': {
          const item = ev.item || {};
          if (item.type === 'function_call') {
            closeBlock();
            blockIndex++;
            openBlock = 'tool';
            hadToolCall = true;
            sse(res, 'content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: {
                type: 'tool_use',
                id: item.call_id || item.id || `call_${blockIndex}`,
                name: item.name || '',
                input: {},
              },
            });
          }
          break;
        }
        case 'response.function_call_arguments.delta': {
          if (openBlock === 'tool') {
            sse(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: ev.delta ?? '' },
            });
          }
          break;
        }
        case 'response.output_item.done': {
          if (openBlock === 'tool') closeBlock();
          break;
        }
        case 'response.completed':
        case 'response.incomplete':
        case 'response.failed': {
          status = ev.type === 'response.completed' ? 'completed' : 'incomplete';
          const u = (ev.response && ev.response.usage) || {};
          usage = {
            input_tokens: Number(u.input_tokens) || 0,
            output_tokens: Number(u.output_tokens) || 0,
          };
          break;
        }
        default:
          break;
      }
    }
  }
  closeBlock();
  // Report input tokens too. Codex only knows them at `response.completed`, so
  // they can't go in message_start (where the real Anthropic API puts them) —
  // Claude Code merges message_delta.usage over it, so reporting them here is
  // what lands in the transcript. Without this every turn recorded
  // input_tokens=0, which meant Claude Code believed the context was always
  // empty and so NEVER auto-compacted: a session would grow until the Codex
  // backend hard-rejected it with context_length_exceeded, from which it cannot
  // recover. It also froze the dashboard's context ring at whatever the agent
  // last reported on a different provider.
  //
  // OpenAI's input_tokens already INCLUDES cached tokens, whereas Anthropic
  // counts cache reads separately and Claude Code sums the three. So report the
  // whole thing as input_tokens and leave the cache fields at zero — splitting
  // them out here would double-count the cached portion.
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason(status, hadToolCall), stop_sequence: null },
    usage: {
      input_tokens: usage.input_tokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: usage.output_tokens,
    },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function createCodexProxy({ logger = console } = {}) {
  return http.createServer((req, res) => {
    // The supervisor polls this for the dashboard's usage ring.
    if (req.method === 'GET' && req.url && req.url.startsWith('/__usage')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(getRateLimits() ?? {}));
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { message: 'invalid JSON' } }));
      }
      const creds = readCreds();
      if (!creds || !creds.accessToken) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'authentication_error',
              message:
                'No ChatGPT credential on disk. Connect a ChatGPT (Codex) account in the dashboard Settings.',
            },
          }),
        );
      }
      const model = body.model && !/claude/i.test(body.model) ? body.model : DEFAULT_MODEL;
      const payload = {
        model,
        instructions: systemText(body.system),
        input: toInput(body.messages),
        tools: toTools(body.tools),
        stream: true,
        store: false,
      };
      try {
        const upstream = await fetch(UPSTREAM, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${creds.accessToken}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'chatgpt-account-id': creds.accountId || '',
            originator: ORIGINATOR,
            'openai-beta': 'responses=experimental',
          },
          body: JSON.stringify(payload),
        });
        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text().catch(() => '');
          logger.error(`[codex-proxy] upstream ${upstream.status}: ${text.slice(0, 300)}`);
          res.writeHead(upstream.status, { 'content-type': 'application/json' });
          return res.end(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'api_error',
                message: `Codex backend ${upstream.status}: ${text.slice(0, 300)}`,
              },
            }),
          );
        }
        captureRateLimits(upstream.headers);
        await pipeStream(upstream, res, model);
      } catch (e) {
        logger.error(`[codex-proxy] ${e && e.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: String((e && e.message) || e) },
            }),
          );
        } else {
          res.end();
        }
      }
    });
  });
}

module.exports = { createCodexProxy, getRateLimits };
