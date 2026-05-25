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
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const PORT = parseInt(process.env.TERMINALS_PORT || '7681', 10);
const HOME = process.env.AGENT_HOME || '/home/agent';
const SHELL = process.env.AGENT_SHELL || '/usr/bin/fish';
const FIRST_CMD = process.env.FIRST_CMD || 'claude --dangerously-skip-permissions';
const PUBLIC = path.join(__dirname, 'public');

const sessions = new Map(); // name -> { name, pty, title, clients:Set }
let counter = 0;

function spawnPty(command) {
  const args = command ? ['-l', '-c', `${command}; exec ${SHELL}`] : ['-l'];
  return pty.spawn(SHELL, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: HOME,
    env: { ...process.env, TERM: 'xterm-256color', HOME, SHELL },
  });
}

function createSession({ name, command } = {}) {
  if (!name) name = `term-${++counter}`;
  if (sessions.has(name)) throw new Error(`session "${name}" already exists`);
  const p = spawnPty(command);
  // Authoritative server-side terminal: captures the full screen + scrollback
  // so a (re)connecting viewer can be sent a clean snapshot incl. history.
  const term = new Terminal({ cols: 120, rows: 30, scrollback: 10000, allowProposedApi: true });
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

const wss = new WebSocketServer({ server, path: '/ws' });
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
    createSession({ name: 'claude', command: FIRST_CMD }); // always-on, from boot
  } catch (e) {
    console.error('failed to start first session:', e);
  }
});
