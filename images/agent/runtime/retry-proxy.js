'use strict';
// Retry proxy: a thin pass-through HTTP server that sits between Claude Code
// and an upstream (oc-go-cc) and retries 5xx responses + transport errors
// with exponential backoff. Streaming response bodies pipe through unchanged
// once the initial status comes back ≤499 — we never swap mid-stream.
//
// Lives in its own module so the retry/backoff logic can be unit-tested
// without booting the rest of the terminal supervisor.
//
// Behavior:
//   - Request body is buffered (Anthropic Messages requests are JSON,
//     typically a few MB at most) so the same payload can be replayed.
//   - On `response.statusCode in [500..599]`, the response body is drained
//     and the request is re-issued after `RETRY_BACKOFFS_MS[n]` ms.
//   - On `request.error` (ECONNREFUSED, ECONNRESET, EPIPE, …), same retry.
//   - On a 400 with "Invalid `signature` in `thinking` block" (model switch
//     mid-conversation — the prior model's thinking-block signatures don't
//     validate against the new one), strip thinking blocks from the request
//     body and replay ONCE. Done in the proxy so model switches just work
//     without losing the transcript.
//   - After RETRY_MAX attempts, the last upstream response is forwarded
//     verbatim — caller sees the real failure, not a synthetic 502.
//     The exception is exhausted transport errors (we never got a response):
//     those map to 502 since we have no upstream response to forward.
//   - If the client disconnects (e.g., user closes the chrome tab), the
//     in-flight upstream request is aborted to free its socket.
const http = require('http');

const RETRY_MAX = 4; // initial attempt + up to 3 retries
const RETRY_BACKOFFS_MS = [500, 2000, 5000]; // gap BEFORE attempt n+1

/** True when the upstream 400 response is the "Invalid `signature` in
 *  `thinking` block" rejection. Anthropic returns this when a thinking
 *  block in `messages[]` was signed by a different model than the one
 *  serving the current request (i.e. the operator switched models
 *  mid-conversation, and claude is replaying the old transcript). */
function isThinkingSignatureError(respBodyBuf) {
  try {
    const j = JSON.parse(respBodyBuf.toString('utf8'));
    const m = j?.error?.message;
    return typeof m === 'string' && m.includes('thinking') && /signature/i.test(m);
  } catch {
    return false;
  }
}

/** Strip `thinking` / `redacted_thinking` blocks from every assistant
 *  message in the request body. Returns the rewritten buffer, or null if
 *  the body isn't parseable JSON or there was nothing to strip (in which
 *  case there's no point replaying). */
function stripThinkingBlocks(reqBodyBuf) {
  let parsed;
  try {
    parsed = JSON.parse(reqBodyBuf.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.messages)) return null;
  let changed = false;
  for (const m of parsed.messages) {
    if (!Array.isArray(m.content)) continue;
    const before = m.content.length;
    m.content = m.content.filter(
      (c) => c && c.type !== 'thinking' && c.type !== 'redacted_thinking',
    );
    if (m.content.length !== before) changed = true;
  }
  if (!changed) return null;
  return Buffer.from(JSON.stringify(parsed));
}

/** Create — but do NOT start — the retry-proxy http.Server. The caller is
 *  responsible for `.listen()`-ing it. Exported separately so tests can spin
 *  up the server against ephemeral ports without going through the global
 *  startup path. */
function createRetryProxy({ upstreamHost = '127.0.0.1', upstreamPort, logger = console } = {}) {
  if (!upstreamPort) throw new Error('createRetryProxy: upstreamPort is required');

  return http.createServer((req, res) => {
    const chunks = [];
    let clientGone = false;
    res.on('close', () => {
      clientGone = true;
    });
    req.on('aborted', () => {
      clientGone = true;
    });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      // One-shot guard: only strip thinking blocks once per client request,
      // so a second 400 after stripping surfaces to the caller verbatim
      // instead of looping forever.
      let strippedThinking = false;

      const attempt = (n) => {
        if (clientGone) return;
        const headers = { ...req.headers };
        delete headers['content-length']; // we set our own based on the buffered body
        headers['host'] = `${upstreamHost}:${upstreamPort}`;
        headers['content-length'] = body.length;

        const upstream = http.request(
          {
            host: upstreamHost,
            port: upstreamPort,
            path: req.url,
            method: req.method,
            headers,
          },
          (resp) => {
            // 400 thinking-block signature: buffer the response, peek at the
            // error message, and replay with thinking blocks stripped if it
            // matches. We only do this once per request.
            if (resp.statusCode === 400 && !strippedThinking) {
              const errChunks = [];
              resp.on('data', (c) => errChunks.push(c));
              resp.on('end', () => {
                if (clientGone) return;
                const respBody = Buffer.concat(errChunks);
                if (isThinkingSignatureError(respBody)) {
                  const stripped = stripThinkingBlocks(body);
                  if (stripped) {
                    logger.warn(
                      `[retry-proxy] ${req.method} ${req.url} → 400 thinking-block signature; ` +
                        `stripping thinking blocks and replaying once`,
                    );
                    body = stripped;
                    strippedThinking = true;
                    attempt(n);
                    return;
                  }
                }
                if (!res.headersSent) {
                  res.writeHead(resp.statusCode, resp.headers);
                  res.end(respBody);
                }
              });
              return;
            }

            const transient = resp.statusCode >= 500 && resp.statusCode < 600;
            const canRetry = transient && n + 1 < RETRY_MAX;
            if (canRetry) {
              const wait = RETRY_BACKOFFS_MS[n] ?? RETRY_BACKOFFS_MS[RETRY_BACKOFFS_MS.length - 1];
              logger.warn(
                `[retry-proxy] ${req.method} ${req.url} → ${resp.statusCode} ` +
                  `(attempt ${n + 1}/${RETRY_MAX}); retrying in ${wait}ms`,
              );
              resp.resume(); // drain so the socket can be reused / closed cleanly
              setTimeout(() => attempt(n + 1), wait);
              return;
            }
            // Forward (possibly streaming) response to the client unchanged.
            res.writeHead(resp.statusCode, resp.headers);
            resp.pipe(res);
          },
        );
        upstream.on('error', (e) => {
          const canRetry = n + 1 < RETRY_MAX;
          if (canRetry) {
            const wait = RETRY_BACKOFFS_MS[n] ?? RETRY_BACKOFFS_MS[RETRY_BACKOFFS_MS.length - 1];
            logger.warn(
              `[retry-proxy] ${req.method} ${req.url} transport error ` +
                `(${e.code || e.message}) attempt ${n + 1}/${RETRY_MAX}; retrying in ${wait}ms`,
            );
            setTimeout(() => attempt(n + 1), wait);
          } else if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                type: 'error',
                error: {
                  type: 'api_error',
                  message:
                    `retry-proxy: upstream unreachable after ${RETRY_MAX} attempts ` +
                    `(${e.code || e.message})`,
                },
              }),
            );
          }
        });
        res.on('close', () => upstream.destroy());
        upstream.end(body);
      };

      attempt(0);
    });
  });
}

module.exports = {
  createRetryProxy,
  RETRY_MAX,
  RETRY_BACKOFFS_MS,
  stripThinkingBlocks,
  isThinkingSignatureError,
};
