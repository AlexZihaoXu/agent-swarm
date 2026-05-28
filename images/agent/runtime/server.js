'use strict';
// Agent terminal supervisor (VS Code-style: xterm.js <-> node-pty).
// The supervisor owns one pty per session, so:
//   - sessions run at container boot, with or without a viewer (always-on);
//   - WE control the exact pty size, so it can never desync from the display;
//   - viewers stream live output (native xterm.js scrollback).
// On attach we trigger ONE repaint (a tiny resize jiggle) so a fresh viewer
// sees the current screen — we deliberately do NOT replay raw history (that
// was the earlier cause of duplicated screens).
//
// HTTP:
//   GET    /api/sessions          -> [{name, title}]
//   POST   /api/sessions {name?,command?} -> {name}
//   DELETE /api/sessions/:name    -> {ok}
// WebSocket:
//   /ws?session=NAME&cols=C&rows=R   server->client: pty bytes;
//                                    client->server: JSON {type:'data'|'resize'}

const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const PORT = parseInt(process.env.TERMINALS_PORT || '7681', 10);
const HOME = process.env.AGENT_HOME || '/home/agent';
const SHELL = process.env.AGENT_SHELL || '/usr/bin/fish';
const FIRST_CMD = process.env.FIRST_CMD || 'claude --dangerously-skip-permissions';
const PUBLIC = path.join(__dirname, 'public');
const CLAUDE_DIR = path.join(HOME, '.claude');
const IDENTITY_FILE = path.join(HOME, '.swarm', 'identity.json');

const sessions = new Map(); // name -> { name, pty, title, clients:Set }
let counter = 0;

// Per-agent settings the gateway writes into the identity file. Read fresh on
// each (re)spawn so a stop→start picks up changes without a container recreate.
// `autoCompactPct` maps to CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (the % of the context
// window at which claude auto-compacts); unset = the claude default.
function settingsEnv() {
  try {
    const id = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    const pct = id && id.autoCompactPct;
    if (typeof pct === 'number' && pct >= 1 && pct <= 100)
      return { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(Math.round(pct)) };
  } catch {
    /* no identity / setting unset — use defaults */
  }
  return {};
}

// --- Claude session stats -------------------------------------------------
// Merges three on-disk sources the Claude Code session leaves behind:
//   - statusline.json  (model display name, cost, lines) written by our
//     statusLine command on every TUI update;
//   - the newest transcript JSONL (exact token usage, summed);
//   - the newest sessions/*.json (idle/busy status).
function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function newestFile(dir, ext) {
  let best = null;
  let bestMtime = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      const inner = newestFile(fp, ext);
      if (inner && inner.mtime > bestMtime) {
        best = inner;
        bestMtime = inner.mtime;
      }
    } else if (e.name.endsWith(ext)) {
      let mt = 0;
      try {
        mt = fs.statSync(fp).mtimeMs;
      } catch {
        continue;
      }
      if (mt > bestMtime) {
        bestMtime = mt;
        best = { path: fp, mtime: mt };
      }
    }
  }
  return best;
}

// Per-million-token pricing (USD), published Anthropic API rates. `cw` = cache
// write (5-min), `cr` = cache read. Edit here if rates change.
function modelRates(model, ctxTokens) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return { in: 15, out: 75, cw: 18.75, cr: 1.5 };
  if (m.includes('haiku')) return { in: 1, out: 5, cw: 1.25, cr: 0.1 };
  // Sonnet: long-context (>200K input) tier is priced higher.
  if (ctxTokens > 200000) return { in: 6, out: 22.5, cw: 7.5, cr: 0.6 };
  return { in: 3, out: 15, cw: 3.75, cr: 0.3 };
}

function transcriptStats() {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let model = null;
  let turns = 0;
  let lastTs = null;
  let cost = 0;
  // Current context-window usage = the most recent turn's input side
  // (fresh input + cache read + cache creation all occupy the window).
  let context = 0;
  // `claude --continue` re-writes prior assistant messages into the resumed
  // transcript, so the same message.id can appear twice in one file. Summing
  // every line double-counts the cumulative totals — dedupe by message.id.
  const seen = new Set();
  const newest = newestFile(path.join(CLAUDE_DIR, 'projects'), '.jsonl');
  const raw = newest && safeRead(newest.path);
  if (!raw) return { totals, model, turns, lastTs, context, cost };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.timestamp) lastTs = o.timestamp;
    if (o.type === 'assistant' && o.message) {
      const mid = o.message.id;
      if (mid) {
        if (seen.has(mid)) continue;
        seen.add(mid);
      }
      const usage = o.message.usage || {};
      const input = usage.input_tokens || 0;
      const output = usage.output_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const cacheCreation = usage.cache_creation_input_tokens || 0;
      totals.input += input;
      totals.output += output;
      totals.cacheRead += cacheRead;
      totals.cacheCreation += cacheCreation;
      context = input + cacheRead + cacheCreation;
      if (o.message.model) model = o.message.model;
      // Cost this turn, at the message's own model's rates.
      const r = modelRates(o.message.model, context);
      cost += (input * r.in + output * r.out + cacheCreation * r.cw + cacheRead * r.cr) / 1_000_000;
      turns++;
    }
  }
  return { totals, model, turns, lastTs, context, cost };
}

// A short, human one-liner of what a tool call did (command, path, pattern…).
function toolDetail(input) {
  if (!input || typeof input !== 'object') return '';
  const v =
    input.command ||
    input.file_path ||
    input.path ||
    input.pattern ||
    input.url ||
    input.prompt ||
    Object.values(input).find((x) => typeof x === 'string') ||
    '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 140) + '…' : s;
}

// Normalized conversation for the dashboard chat view: user/assistant turns,
// each with text and tool-call items (tool results & thinking are omitted).
function readTranscript() {
  const newest = newestFile(path.join(CLAUDE_DIR, 'projects'), '.jsonl');
  const raw = newest && safeRead(newest.path);
  if (!raw) return [];
  const lines = raw.split('\n').slice(-500);
  // Pre-scan tool_results for screenshot markers: a tool that saved a shot puts
  // `[shot:<file>]` in its result text, keyed back to the tool_use by id.
  const shotByTool = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o.message && o.message.content;
    if (o.type !== 'user' || !Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type !== 'tool_result' || !b.tool_use_id) continue;
      const txt =
        typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content)
            ? b.content.map((c) => c.text || '').join(' ')
            : '';
      const mk = txt.match(/\[shot:([\w.\-]+\.jpg)\]/);
      if (mk) shotByTool[b.tool_use_id] = mk[1];
    }
  }
  const out = [];
  let lastTodos = null; // signature of the last emitted todo list (dedup repeats)
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if ((o.type !== 'user' && o.type !== 'assistant') || !o.message) continue;
    const content = o.message.content;
    const items = [];
    if (typeof content === 'string') {
      if (content.trim()) items.push({ kind: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text) items.push({ kind: 'text', text: b.text });
        else if (b.type === 'thinking' && b.thinking)
          // Extended thinking — the chat shows it as a collapsible block.
          items.push({ kind: 'thinking', text: String(b.thinking) });
        else if (b.type === 'tool_use' && shotByTool[b.id])
          // A captured screenshot (glance/look_at/show_image) — render the image
          // inline instead of a tool badge.
          items.push({ kind: 'image', file: shotByTool[b.id] });
        else if (b.type === 'tool_use' && /^exit_?plan_?mode$/i.test(b.name || '') && b.input?.plan)
          // Plan mode: surface the full plan markdown so the chat can render it
          // as a plan card (rather than a truncated tool one-liner).
          items.push({ kind: 'plan', text: String(b.input.plan) });
        else if (
          b.type === 'tool_use' &&
          /^todo_?write$/i.test(b.name || '') &&
          Array.isArray(b.input?.todos)
        ) {
          // Todo list: render as a checklist. Each TodoWrite rewrites the whole
          // list, so collapse runs that didn't change (skip identical repeats).
          const todos = b.input.todos.map((td) => ({
            content: String(td.content || td.activeForm || ''),
            activeForm: String(td.activeForm || ''),
            status: String(td.status || 'pending'),
          }));
          const sig = JSON.stringify(todos);
          if (sig !== lastTodos) {
            items.push({ kind: 'todos', todos });
            lastTodos = sig;
          }
        } else if (
          b.type === 'tool_use' &&
          /^task(create|update|get|list|stop|output)$/i.test(b.name || '')
        ) {
          /* skip — the task list is rendered as a live checklist from /api/stats */
        } else if (b.type === 'tool_use')
          items.push({ kind: 'tool', name: b.name, detail: toolDetail(b.input) });
      }
    }
    if (items.length) {
      const turn = { role: o.message.role, ts: o.timestamp || null, items };
      // Claude Code marks API/transport failures (e.g. "API Error: 500 …") with
      // this flag — surface it so the chat can render them distinctly.
      if (o.isApiErrorMessage) turn.error = true;
      out.push(turn);
    }
  }
  return out;
}

let shotCache = { at: 0, buf: null };
function sendScreenshot(res) {
  if (shotCache.buf && Date.now() - shotCache.at < 1000) {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
    return res.end(shotCache.buf);
  }
  const p = cp.spawn(
    'import',
    ['-silent', '-window', 'root', '-resize', '854x480', '-quality', '55', 'jpeg:-'],
    { env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1' } },
  );
  const chunks = [];
  let done = false;
  const fail = () => {
    if (done) return;
    done = true;
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('screenshot unavailable');
  };
  p.stdout.on('data', (d) => chunks.push(d));
  p.on('error', fail);
  p.on('close', (code) => {
    if (done) return;
    if (code !== 0 || !chunks.length) return fail();
    done = true;
    const buf = Buffer.concat(chunks);
    shotCache = { at: Date.now(), buf };
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

function latestSession() {
  const newest = newestFile(path.join(CLAUDE_DIR, 'sessions'), '.json');
  if (!newest) return {};
  try {
    return JSON.parse(safeRead(newest.path) || '{}');
  } catch {
    return {};
  }
}

// Plain text of the claude session's CURRENT visible screen (no ANSI), read
// from the authoritative headless terminal we already maintain per session.
function claudeScreenText() {
  const sess = sessions.get('claude');
  if (!sess || !sess.term) return '';
  const buf = sess.term.buffer.active;
  const rows = sess.term.rows;
  const start = Math.max(0, buf.length - rows);
  const lines = [];
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n');
}

// Claude Code's interactive selectors (AskUserQuestion, ExitPlanMode, the
// permission prompt) are TUI-only — they never reach the transcript. The
// "↑/↓ to navigate" footer is unique to these selectors (idle shows
// "? for shortcuts"; busy shows "esc to interrupt"), so it's a reliable,
// low-false-positive signal that one is open. We also parse the numbered
// options off the screen so the chat can offer them as one-click answers
// (driven by sending the matching arrow-key sequence back to the pty).
// Shapes handled (all share the "↑/↓ to navigate" footer):
//   - single-select: "1. Label" rows, one Enter picks one;
//   - multi-select:   "1. [ ] Label" checkbox rows + a "Submit" row (Space
//     toggles, then Enter on Submit → a review screen, itself single-select);
//   - plan approval / permission prompts: single-select Yes/No-style rows.
// We parse the numbered options (and any checkbox state) so the chat can drive
// the selector with the matching key sequence.
function detectAwaiting(screen) {
  // A selector is open if the footer says so, OR the cursor (❯) is sitting on a
  // numbered row. The latter catches screens whose footer scrolls out of view
  // (e.g. the multi-select "Submit answers / Cancel" review).
  // The selector footer is "↑↓ to navigate · …"; require the arrow glyphs on
  // the SAME line as "navigate" so it can't fire on the model's prose (e.g.
  // "Want me to navigate somewhere…").
  const navFooter = screen.split('\n').some((l) => /navigate/i.test(l) && /[↑↓⬆⬇]/.test(l));
  let cursorOnOption = false;
  let prompt = null;
  let multiSelect = false;
  let hasSubmit = false;
  const options = [];
  for (const raw of screen.split('\n')) {
    if (/^[\s│┃┆╎]*[❯›]\s?\d+\./.test(raw)) cursorOnOption = true;
    // Drop box rules + a leading cursor marker so the row starts at its label.
    const line = raw
      .replace(/[│┃┆╎]/g, ' ')
      .replace(/^\s*[❯>›]\s?/, '')
      .trim();
    if (/^Submit$/i.test(line)) {
      hasSubmit = true;
      continue;
    }
    const mo = line.match(/^(\d+)\.\s+(.*)$/);
    if (mo) {
      let label = mo[2].trim();
      let checkable = false;
      let checked = false;
      const cb = label.match(/^\[\s*([xX✔✓●]?)\s*\]\s*(.*)$/);
      if (cb) {
        checkable = true;
        checked = !!cb[1];
        label = cb[2].trim();
        multiSelect = true;
      }
      // A side-by-side preview sits on the same row, separated by 2+ spaces —
      // keep only the label, drop the mockup.
      label = label.split(/\s{2,}/)[0].trim();
      if (label && label.length <= 120)
        options.push({ n: parseInt(mo[1], 10), label, checkable, checked });
      continue;
    }
    // Auto-provided escape hatches are navigable but often unnumbered (below a
    // rule). Capture them so they're clickable too, numbered after the rest.
    const meta = line.match(/^(Chat about this|Type something\.?)$/i);
    if (meta && !options.some((o) => /^(chat about|type someth)/i.test(o.label))) {
      options.push({ n: options.length + 1, label: meta[1], checkable: false, checked: false });
      continue;
    }
    const s = raw.replace(/[│┃┆╎|>❯●○◯◉*✻·•\s]+/g, ' ').trim();
    if (s.endsWith('?') && s.length > 4 && s.length <= 160) prompt = s;
  }
  if (!navFooter && !cursorOnOption) return null;
  return { prompt, options, multiSelect, hasSubmit };
}

// Render the open selector to faithful, colored HTML (exact TUI layout incl.
// ASCII previews/mockups). Text-parsing structured/preview prompts is lossy;
// this shows the real thing. We serialize the visible screen to HTML, then keep
// only the selector's rows (box top → footer). Returns <pre>…</pre> or null.
function renderPromptHtml() {
  const sess = sessions.get('claude');
  if (!sess || !sess.serializer) return null;
  const full = sess.serializer.serializeAsHTML({ scrollback: 0 });
  // Shape: <pre><div style='WRAP'><div>row</div>…</div></pre>
  const wrap = full.match(/<pre><div style='([^']*)'>([\s\S]*?)<\/div><\/pre>/);
  if (!wrap) return null;
  const wrapStyle = wrap[1];
  const rowDivs = wrap[2].match(/<div>[\s\S]*?<\/div>/g) || [];
  const text = (d) =>
    d
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trimEnd();
  // Footer marks the bottom; else the row below a cursored numbered option.
  let footer = -1;
  rowDivs.forEach((d, i) => {
    if (/to navigate/i.test(text(d))) footer = i;
  });
  if (footer < 0)
    rowDivs.forEach((d, i) => {
      if (/^\s*[❯›]\s?\d+\./.test(text(d))) footer = Math.min(rowDivs.length - 1, i + 1);
    });
  if (footer < 0) return null;
  // Start just above the question line; trim leading blank rows.
  let qi = -1;
  for (let i = 0; i <= footer; i++) {
    const s = text(rowDivs[i])
      .replace(/[│┃|>❯·•]/g, ' ')
      .trim();
    if (s.endsWith('?') && s.length > 4) qi = i;
  }
  let start = Math.max(0, qi >= 0 ? qi - 1 : footer - 14);
  while (start < footer && !text(rowDivs[start]).trim()) start++;
  const rows = rowDivs.slice(start, footer + 1).join('');
  return `<pre><div style='${wrapStyle}'>${rows}</div></pre>`;
}

// Scrape the busy spinner line for live state, e.g.
// "✶ Honking… (10m 5s · ↓ 28.3k tokens · almost done thinking with high effort)".
// We surface the playful gerund ("Honking"), the elapsed time ("10m 5s") and the
// generated-token count so the chat can mirror the TUI's flashing indicator.
function readActivity(screen) {
  if (!screen) return null;
  for (const line of screen.split('\n')) {
    if (!line.includes('…') || !/tokens/i.test(line)) continue;
    const tm = line.match(/([\d.]+)\s*([km]?)\s*tokens/i);
    let genTokens = null;
    if (tm) {
      const n = parseFloat(tm[1]);
      const u = (tm[2] || '').toLowerCase();
      genTokens = Math.round(u === 'k' ? n * 1e3 : u === 'm' ? n * 1e6 : n);
    }
    // The gerund word right before the ellipsis (skip the leading spinner glyph).
    const vm = line.match(/([A-Za-z][A-Za-z'-]*)…/);
    // The elapsed time is the first "(…·…)" segment, e.g. "10m 5s" or "34s".
    const em = line.match(/\(\s*(\d[\dhms\s]*?)\s*[·)]/);
    return {
      thinking: /thinking/i.test(line),
      genTokens,
      verb: vm ? vm[1] : null,
      elapsed: em ? em[1].trim() : null,
    };
  }
  return null;
}

function readStats() {
  let sl = {};
  try {
    sl = JSON.parse(safeRead(path.join(CLAUDE_DIR, 'statusline.json')) || '{}');
  } catch {
    /* ignore */
  }
  const t = transcriptStats();
  const sess = latestSession();
  // Claude Code itself records when it's blocked on an interactive prompt:
  // the session file flips status to "waiting" with a "waitingFor" label
  // (e.g. "permission prompt"). That's the authoritative signal. We also scan
  // the screen as a fallback and, when it works, for the nicer question text.
  const screenText = claudeScreenText();
  const screen = detectAwaiting(screenText);
  const waiting = sess.status === 'waiting';
  const awaitingInput = waiting || !!screen;
  const promptText = (screen && screen.prompt) || (waiting ? sess.waitingFor : null) || null;
  const promptOptions = (screen && screen.options) || [];
  const promptMultiSelect = !!(screen && screen.multiSelect);
  // While busy, scrape the spinner line for the live thinking/token state, e.g.
  // "Honking… (10m 5s · ↓ 28.3k tokens · almost done thinking with high effort)".
  const activity = sess.status === 'busy' ? readActivity(screenText) : null;
  const total = t.totals.input + t.totals.output + t.totals.cacheRead + t.totals.cacheCreation;
  const cost = sl.cost || {};
  return {
    model: (sl.model && sl.model.display_name) || t.model || null,
    status: sess.status || null,
    sessionId: sess.sessionId || null,
    tokens: { ...t.totals, total },
    context: t.context,
    // Authoritative context-window size from Claude Code's statusline (the model
    // display name doesn't always carry it, e.g. "Opus 4.7").
    contextLimit: (sl.context_window && sl.context_window.context_window_size) || null,
    turns: t.turns,
    // Computed from token usage × per-model rates; fall back to Claude Code's
    // own statusLine figure if we have no turns yet.
    cost:
      t.turns > 0 ? t.cost : typeof cost.total_cost_usd === 'number' ? cost.total_cost_usd : null,
    linesAdded: cost.total_lines_added || 0,
    linesRemoved: cost.total_lines_removed || 0,
    exceeds200k: !!sl.exceeds_200k_tokens,
    lastActivity: t.lastTs || sess.updatedAt || null,
    // True when an interactive selector (AskUserQuestion/plan/permission) is
    // open and waiting; promptOptions lists its numbered choices so the chat
    // can answer by sending the matching arrow-key sequence to the pty.
    awaitingInput,
    promptText,
    promptOptions,
    promptMultiSelect,
    // The agent's current task list (TaskCreate/TaskUpdate), so the chat can
    // render a live checklist that marks steps off as it works.
    tasks: readTasks(),
    // Live spinner state while busy: { thinking, genTokens } (null when idle).
    activity,
  };
}

// The session's current task list, persisted by Claude Code under
// ~/.claude/tasks/<sessionId>/<n>.json. Returns it sorted by id.
function readTasks() {
  const newest = newestFile(path.join(CLAUDE_DIR, 'projects'), '.jsonl');
  if (!newest) return [];
  const dir = path.join(CLAUDE_DIR, 'tasks', path.basename(newest.path, '.jsonl'));
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const tasks = [];
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      tasks.push({
        id: String(t.id),
        subject: String(t.subject || ''),
        activeForm: String(t.activeForm || ''),
        status: String(t.status || 'pending'),
      });
    } catch {
      /* skip a malformed/locked file */
    }
  }
  tasks.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  return tasks;
}

// Resume across container restarts. The agent's home is a persistent disk, so
// Claude's transcripts survive a restart. If one exists for the working dir,
// continue the most recent conversation (with a fresh session as fallback if
// the resume fails); on first boot there's nothing to continue, so start clean
// (`--continue` errors with no prior conversation). An explicit FIRST_CMD wins.
function claudeBootCommand() {
  if (process.env.FIRST_CMD) return FIRST_CMD;
  try {
    const projDir = path.join(CLAUDE_DIR, 'projects', HOME.replace(/[^a-zA-Z0-9]/g, '-'));
    if (fs.readdirSync(projDir).some((f) => f.endsWith('.jsonl')))
      return `claude --continue --dangerously-skip-permissions || ${FIRST_CMD}`;
  } catch {
    /* no prior transcripts — start fresh */
  }
  return FIRST_CMD;
}

function spawnPty(command) {
  const args = command ? ['-l', '-c', `${command}; exec ${SHELL}`] : ['-l'];
  return pty.spawn(SHELL, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: HOME,
    env: { ...process.env, TERM: 'xterm-256color', HOME, SHELL, ...settingsEnv() },
  });
}

function createSession({ name, command } = {}) {
  if (!name) name = `term-${++counter}`;
  if (sessions.has(name)) throw new Error(`session "${name}" already exists`);
  const p = spawnPty(command);
  // Authoritative server-side terminal: captures the full screen + scrollback
  // so a (re)connecting viewer can be sent a clean snapshot incl. history.
  const term = new Terminal({
    cols: 120,
    rows: 30,
    scrollback: 10000,
    allowProposedApi: true,
    // Theme drives default fg/bg in serializeAsHTML (the chat's prompt render) —
    // match the dashboard terminal so the rendered selector looks native.
    theme: { background: '#16130e', foreground: '#e6e1d6' },
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  const sess = { name, pty: p, title: command || 'shell', clients: new Set(), term, serializer };
  p.onData((d) => {
    sess.term.write(d);
    for (const ws of sess.clients) if (ws.readyState === 1) ws.send(d);
  });
  p.onExit(() => {
    for (const ws of sess.clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    sessions.delete(name);
  });
  sessions.set(name, sess);
  return sess;
}

function killSession(name) {
  const s = sessions.get(name);
  if (!s) return false;
  try {
    s.pty.kill();
  } catch {
    /* ignore */
  }
  sessions.delete(name);
  return true;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  if (u.pathname === '/api/sessions' && req.method === 'GET') {
    return sendJson(
      res,
      200,
      [...sessions.values()].map((s) => ({ name: s.name, title: s.title })),
    );
  }
  if (u.pathname === '/api/sessions' && req.method === 'POST') {
    let opts = {};
    try {
      const body = await readBody(req);
      opts = body ? JSON.parse(body) : {};
    } catch {
      /* ignore */
    }
    try {
      const s = createSession(opts);
      return sendJson(res, 201, { name: s.name });
    } catch (e) {
      return sendJson(res, 409, { error: String((e && e.message) || e) });
    }
  }
  if (u.pathname === '/api/stats' && req.method === 'GET') {
    return sendJson(res, 200, readStats());
  }
  if (u.pathname === '/api/transcript' && req.method === 'GET') {
    return sendJson(res, 200, readTranscript());
  }
  // Faithful colored HTML of the open interactive selector (for the chat).
  if (u.pathname === '/api/prompt' && req.method === 'GET') {
    let html = null;
    try {
      html = renderPromptHtml();
    } catch {
      /* ignore */
    }
    return sendJson(res, 200, { html });
  }
  // Inject a message into a session's pty as if typed by a human — used by the
  // gateway's integration bridges (e.g. Discord) to deliver an incoming message
  // to claude. Types the text, then submits with Enter after a short beat (the
  // TUI needs a moment between the pasted text and the carriage return), exactly
  // like the dashboard chat send. Callers are trusted (gateway-side) and are
  // responsible for sanitizing untrusted content before calling.
  if (u.pathname === '/api/inject' && req.method === 'POST') {
    let body = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* ignore */
    }
    const name = body.session || 'claude';
    const text = typeof body.text === 'string' ? body.text : '';
    const sess = sessions.get(name);
    if (!sess) return sendJson(res, 404, { error: 'session not found' });
    if (!text.trim()) return sendJson(res, 400, { error: 'text required' });
    const clean = text.replace(/\r\n?/g, '\n');
    sess.pty.write(clean);
    setTimeout(() => {
      try {
        sess.pty.write('\r');
      } catch {
        /* session may have closed */
      }
    }, 150);
    return sendJson(res, 200, { ok: true });
  }
  // Attachment upload: raw body → ~/uploads/<name>; returns the in-agent path
  // so the chat can reference it for claude to read.
  if (u.pathname === '/api/upload' && req.method === 'POST') {
    const name = path
      .basename(u.searchParams.get('name') || 'upload.bin')
      .replace(/[^\w.\-]/g, '_');
    const dir = path.join(HOME, 'uploads');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    const dest = path.join(dir, name);
    const out = fs.createWriteStream(dest);
    req.pipe(out);
    out.on('finish', () => sendJson(res, 200, { path: dest }));
    out.on('error', () => sendJson(res, 500, { error: 'upload failed' }));
    return;
  }
  // Low-res JPEG of the desktop for fleet-card previews (cheap; full live view
  // is the noVNC stream). Cached ~1s so multiple viewers don't hammer X.
  if (u.pathname === '/api/screenshot' && req.method === 'GET') {
    return sendScreenshot(res);
  }
  // Saved computer-use / show_image screenshots (the chat renders these inline).
  const shot = u.pathname.match(/^\/api\/shots\/([\w.\-]+\.jpg)$/);
  if (shot && req.method === 'GET') {
    const file = path.join('/tmp/swarm-shots', shot[1]);
    try {
      const buf = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' });
      return res.end(buf);
    } catch {
      return sendJson(res, 404, { error: 'shot not found' });
    }
  }
  const m = u.pathname.match(/^\/api\/sessions\/(.+)$/);
  if (m && req.method === 'DELETE') {
    const ok = killSession(decodeURIComponent(m[1]));
    return sendJson(res, ok ? 200 : 404, { ok });
  }

  const rel = u.pathname === '/' ? '/index.html' : u.pathname;
  const fp = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (fp.startsWith(PUBLIC) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const ext = path.extname(fp);
    const ct = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : 'text/plain';
    res.writeHead(200, { 'content-type': ct });
    return fs.createReadStream(fp).pipe(res);
  }
  res.writeHead(404);
  res.end('not found');
});

// Live stats stream: push the current stats snapshot once per second. The
// dashboard fetches one snapshot then subscribes here for real-time updates.
const statsWss = new WebSocketServer({ noServer: true });
statsWss.on('connection', (ws) => {
  const send = () => {
    if (ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(readStats()));
    } catch {
      /* ignore */
    }
  };
  send();
  const timer = setInterval(send, 1000);
  ws.on('close', () => clearInterval(timer));
  ws.on('error', () => clearInterval(timer));
});

const wss = new WebSocketServer({ noServer: true });
// Single upgrade router — multiple WebSocketServers can't each bind the same
// HTTP server's 'upgrade' event (they'd abort each other's sockets).
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/stats') {
    statsWss.handleUpgrade(req, socket, head, (ws) => statsWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});
wss.on('connection', (ws, req) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const sess = sessions.get(u.searchParams.get('session'));
  if (!sess) {
    ws.close(1008, 'no such session');
    return;
  }
  const cols = parseInt(u.searchParams.get('cols') || '120', 10) || 120;
  const rows = parseInt(u.searchParams.get('rows') || '30', 10) || 30;
  // Size to this viewer (claude repaints into the authoritative term), let it
  // settle, then send ONE snapshot (history + current screen) and only THEN
  // start streaming live deltas — registering after the snapshot is what avoids
  // a duplicate render.
  try {
    sess.pty.resize(cols, rows);
    sess.term.resize(cols, rows);
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    if (ws.readyState !== 1) return;
    try {
      ws.send(sess.serializer.serialize());
    } catch {
      /* ignore */
    }
    sess.clients.add(ws);
  }, 120);

  ws.on('message', (data) => {
    let msg = null;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      /* not JSON */
    }
    if (msg && msg.type === 'resize') {
      try {
        sess.pty.resize(msg.cols, msg.rows);
        sess.term.resize(msg.cols, msg.rows);
      } catch {
        /* ignore */
      }
      // After the resize settles, push a clean snapshot of the authoritative
      // screen to this viewer (clear + serialized state) so a grow/shrink can't
      // leave a stale or blank screen. Debounced per-connection.
      clearTimeout(ws._snapTimer);
      ws._snapTimer = setTimeout(() => {
        if (ws.readyState !== 1) return;
        try {
          ws.send('\x1b[H\x1b[2J\x1b[3J' + sess.serializer.serialize());
        } catch {
          /* ignore */
        }
      }, 140);
      return;
    }
    if (msg && msg.type === 'data') {
      sess.pty.write(msg.data);
      return;
    }
    sess.pty.write(data.toString());
  });
  ws.on('close', () => sess.clients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`agent-runtime terminal supervisor listening on :${PORT}`);
  try {
    createSession({ name: 'claude', command: claudeBootCommand() }); // always-on, from boot
  } catch (e) {
    console.error('failed to start first session:', e);
  }
});
