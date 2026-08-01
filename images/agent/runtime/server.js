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
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { StringDecoder } = require('string_decoder');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { createRetryProxy } = require('./retry-proxy');

const PORT = parseInt(process.env.TERMINALS_PORT || '7681', 10);
const HOME = process.env.AGENT_HOME || '/home/agent';
const SHELL = process.env.AGENT_SHELL || '/usr/bin/fish';
const FIRST_CMD = process.env.FIRST_CMD || 'claude --dangerously-skip-permissions';
const PUBLIC = path.join(__dirname, 'public');
const CLAUDE_DIR = path.join(HOME, '.claude');
const IDENTITY_FILE = path.join(HOME, '.swarm', 'identity.json');

const sessions = new Map(); // name -> { name, pty, title, clients:Set }
let counter = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AUTH_FILE = path.join(HOME, '.swarm', 'auth');

// In-agent opencode-proxy stack:
//   claude  ──HTTP──►  retry-proxy (8765)  ──HTTP──►  oc-go-cc (8766)  ──TLS──►  opencode.ai
//
// oc-go-cc (https://github.com/samueltuyizere/oc-go-cc) translates Anthropic
// Messages requests into OpenCode Go's API. It listens on a private port and
// has its own model-fallback chain.
//
// The retry-proxy in front of it catches the case oc-go-cc surfaces as a 502
// when ALL fallback models hit a transient upstream error (the same minute, a
// retry usually succeeds). On 5xx/connection-reset, it replays the request up
// to RETRY_MAX times with exponential backoff. Streaming SSE bodies are piped
// straight through once the response status comes back ≤499 — we only swap on
// the initial status, never mid-stream.
//
// ANTHROPIC_BASE_URL is set to the retry-proxy (8765); the swap is invisible
// to claude.
const OPENCODE_PROXY_PORT = parseInt(process.env.OPENCODE_PROXY_PORT || '8765', 10);
const OC_GO_CC_INTERNAL_PORT = parseInt(process.env.OC_GO_CC_INTERNAL_PORT || '8766', 10);
const OPENCODE_PROXY_BIN = '/usr/local/bin/oc-go-cc';
// Codex/ChatGPT proxy (8765/8766 are taken by the opencode-go chain).
const CHATGPT_PROXY_PORT = parseInt(process.env.CHATGPT_PROXY_PORT || '8767', 10);
const CHATGPT_INTERNAL_PORT = parseInt(process.env.CHATGPT_INTERNAL_PORT || '8768', 10);
const CHATGPT_CREDS_FILE = path.join(HOME, '.swarm', 'chatgpt-creds.json');
const OPENCODE_KEY_FILE = path.join(HOME, '.swarm', 'opencode-go-key');
const OPENCODE_CONFIG_FILE = path.join(HOME, '.swarm', 'oc-go-cc-config.json');

// Per-agent env the gateway provisions on disk, read fresh on each (re)spawn so
// a stop→start picks up changes without a container recreate:
//   - `.swarm/auth`            → CLAUDE_CODE_OAUTH_TOKEN (subscription auth)
//   - identity.autoCompactPct  → CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (auto-compact %)
//   - identity.provider        → routes claude through opencode-proxy when 'opencodeGo'
function settingsEnv() {
  const env = {};
  let identity = null;
  try {
    identity = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
  } catch {
    /* no identity — defaults below */
  }
  const provider = (identity && identity.provider) || 'anthropic';
  // Anthropic stays on OAuth (auth file → CLAUDE_CODE_OAUTH_TOKEN, no base URL
  // override or Claude Code disables OAuth and bails). OpenCode Go uses the
  // local proxy: ANTHROPIC_BASE_URL points at it; ANTHROPIC_AUTH_TOKEN is a
  // placeholder Claude Code requires when an explicit base URL is set (the
  // proxy reads the real key from disk).
  if (provider === 'opencodeGo') {
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${OPENCODE_PROXY_PORT}`;
    env.ANTHROPIC_AUTH_TOKEN = 'opencode-go-via-proxy';
  } else if (provider === 'chatgpt') {
    // Codex/ChatGPT goes through its own local translating proxy, same shape as
    // opencodeGo. Deliberately does NOT fall through to the Anthropic branch:
    // that branch hands over the operator's real Claude OAuth token, so an
    // unrecognised provider used to silently spend the Anthropic subscription.
    // If the proxy isn't installed yet, claude fails loudly against a dead port
    // instead of quietly billing the wrong account.
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${CHATGPT_PROXY_PORT}`;
    env.ANTHROPIC_AUTH_TOKEN = 'chatgpt-via-proxy';
  } else if (provider === 'anthropic') {
    try {
      const token = fs.readFileSync(AUTH_FILE, 'utf8').trim();
      if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    } catch {
      /* no token on disk — claude will prompt */
    }
  } else {
    // Unknown provider (e.g. an agent created by a newer gateway). Give it
    // nothing rather than defaulting to the Anthropic credential.
    console.error(`[settings] unknown provider ${JSON.stringify(provider)} — no credential applied`);
  }
  if (identity) {
    const pct = identity.autoCompactPct;
    if (typeof pct === 'number' && pct >= 1 && pct <= 100)
      env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(Math.round(pct));
    if (typeof identity.model === 'string' && identity.model.trim())
      env.ANTHROPIC_MODEL = identity.model.trim();
    // Reasoning effort. CLAUDE_CODE_EFFORT_LEVEL (unlike the --effort flag)
    // accepts "ultracode" (= max effort + Workflow orchestration). Unset →
    // claude's default effort.
    if (typeof identity.effort === 'string' && identity.effort.trim()) {
      env.CLAUDE_CODE_EFFORT_LEVEL = identity.effort.trim().toLowerCase();
      env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1';
    }
  }
  // Bound ultracode/Workflow subagent fan-out to what the container's real
  // cgroup limits can hold, so a big workflow doesn't OOM-kill the session (the
  // container's /proc over-reports host cpu/mem — see toolConcurrencyCap).
  const cap = toolConcurrencyCap();
  if (cap !== null) env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = String(cap);
  return env;
}

// Start oc-go-cc as a long-lived child of the supervisor. It listens on
// 127.0.0.1 only (never reachable from outside the container) and serves every
// agent regardless of provider — the env wiring above only points claude at
// it when the agent is set to opencodeGo, so anthropic agents pay nothing for
// it being up. The API key is read from disk on each (re)spawn so an operator
// edit propagates without a recreate.
function startOpencodeProxy() {
  if (!fs.existsSync(OPENCODE_PROXY_BIN)) return;
  // oc-go-cc writes its PID file under ~/.config/oc-go-cc/ — ensure the dir
  // exists before the first spawn, otherwise it errors out and the supervisor
  // loops on restart forever.
  try {
    fs.mkdirSync(path.join(HOME, '.config', 'oc-go-cc'), { recursive: true });
  } catch {
    /* best-effort — the proxy reports its own dir-error if this somehow fails */
  }
  const start = () => {
    let apiKey = '';
    try {
      apiKey = fs.readFileSync(OPENCODE_KEY_FILE, 'utf8').trim();
    } catch {
      /* no key — the proxy will start anyway and 401 until one's provisioned */
    }
    const env = {
      ...process.env,
      OC_GO_CC_API_KEY: apiKey || 'unset',
      OC_GO_CC_HOST: '127.0.0.1',
      OC_GO_CC_PORT: String(OC_GO_CC_INTERNAL_PORT),
      HOME,
    };
    const args = ['serve'];
    if (fs.existsSync(OPENCODE_CONFIG_FILE)) args.push('-c', OPENCODE_CONFIG_FILE);
    const child = cp.spawn(OPENCODE_PROXY_BIN, args, {
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => {
      // Restart on unexpected exit — no systemd unit keeps it up, so a one-off
      // crash shouldn't kill the agent's ability to reach OpenCode Go.
      console.warn(`[opencode-proxy] exited (${code}) — restarting in 2s`);
      setTimeout(start, 2000);
    });
  };
  start();
}

// Bring up the retry-proxy in front of oc-go-cc. The proxy itself lives in
// retry-proxy.js so its retry/backoff logic can be unit-tested without booting
// the rest of the supervisor; we just instantiate + listen here.
/** Codex/ChatGPT translator + its own retry proxy. Started for every agent, in
 *  the same spirit as the opencode chain: the env wiring in settingsEnv() is
 *  what decides whether claude actually points at it. Guarded so an older image
 *  without the module simply no-ops. */
function startChatgptProxy() {
  let createCodexProxy;
  try {
    ({ createCodexProxy } = require('./codex-proxy.js'));
  } catch {
    return; // not shipped yet on this agent
  }
  try {
    const inner = createCodexProxy({ logger: console });
    inner.listen(CHATGPT_INTERNAL_PORT, '127.0.0.1', () =>
      console.log(`codex-proxy listening on 127.0.0.1:${CHATGPT_INTERNAL_PORT}`),
    );
    inner.on('error', (e) => console.error('[codex-proxy]', e && e.message));
    const retry = createRetryProxy({
      upstreamHost: '127.0.0.1',
      upstreamPort: CHATGPT_INTERNAL_PORT,
      logger: console,
    });
    retry.listen(CHATGPT_PROXY_PORT, '127.0.0.1', () =>
      console.log(`codex retry-proxy listening on 127.0.0.1:${CHATGPT_PROXY_PORT}`),
    );
    retry.on('error', (e) => console.error('[codex-retry]', e && e.message));
  } catch (e) {
    console.error('[codex-proxy] failed to start:', e && e.message);
  }
}

function startRetryProxy() {
  const server = createRetryProxy({
    upstreamHost: '127.0.0.1',
    upstreamPort: OC_GO_CC_INTERNAL_PORT,
  });
  server.on('error', (e) => console.error('[retry-proxy] server error:', e));
  server.listen(OPENCODE_PROXY_PORT, '127.0.0.1', () => {
    console.log(
      `[retry-proxy] listening on 127.0.0.1:${OPENCODE_PROXY_PORT} → ` +
        `127.0.0.1:${OC_GO_CC_INTERNAL_PORT} (oc-go-cc)`,
    );
  });
}

// --- System (CPU + memory) sampling ---------------------------------------
// `docker stats` on a sysbox-runc container only sees its outer cgroup, not
// the nested per-service cgroups systemd creates inside, so it under-reports
// memory by ~500x (atlas: 5 MB via docker stats vs 2.7 GB of real process
// RSS). And /proc/stat inside the container is host-wide (every container
// reads the same numbers), so naive os.cpus() can't distinguish per-agent CPU
// either. We read both from the container's own cgroup v2 view:
//
//   CPU: /sys/fs/cgroup/cpu.stat exposes usage_usec — total microseconds the
//   cgroup's tasks have spent on-CPU. Delta over wall time → cores busy →
//   cpu% (1 core fully busy = 100%, scales up to cores*100). Falls back to
//   /proc/stat if cgroup is unreadable so this still works outside sysbox.
//
//   Memory: sum VmRSS from /proc/*/status (the pid namespace scopes it to
//   this container's process tree). See sumProcessRss below.
const CGROUP_CPU_STAT = '/sys/fs/cgroup/cpu.stat';

function readCgroupUsec() {
  try {
    const s = fs.readFileSync(CGROUP_CPU_STAT, 'utf8');
    const m = s.match(/^usage_usec\s+(\d+)/m);
    if (m) return parseInt(m[1], 10);
  } catch {
    /* cgroup v1 or unreadable — fall back */
  }
  return null;
}

let lastCpuSample = null; // either {usec, time} (cgroup) or {idle, total} (host)
let cpuPctCached = 0;

function sampleCpu() {
  const usec = readCgroupUsec();
  if (usec !== null) {
    const now = Date.now();
    if (lastCpuSample && typeof lastCpuSample.usec === 'number') {
      const usecDelta = usec - lastCpuSample.usec;
      const wallUsec = (now - lastCpuSample.time) * 1000;
      if (wallUsec > 0 && usecDelta >= 0) {
        // Cores busy this interval = cgroup usec / wall usec. Convert to a
        // "% of one core" scale (cpu% = cores_busy * 100). A 4-core spinning
        // load reads 400, capped at cores * 100.
        const coresBusy = usecDelta / wallUsec;
        cpuPctCached = Math.max(0, Math.min(os.cpus().length * 100, coresBusy * 100));
      }
    }
    lastCpuSample = { usec, time: now };
    return;
  }
  // Fallback: host-wide /proc/stat (less useful — all containers read the
  // same numbers — but keeps us alive outside sysbox/cgroup v2 setups).
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  if (lastCpuSample && typeof lastCpuSample.total === 'number') {
    const idleDelta = idle - lastCpuSample.idle;
    const totalDelta = total - lastCpuSample.total;
    if (totalDelta > 0) {
      const busyFrac = 1 - idleDelta / totalDelta;
      cpuPctCached = Math.max(0, Math.min(cpus.length * 100, busyFrac * cpus.length * 100));
    }
  }
  lastCpuSample = { idle, total };
}
sampleCpu(); // seed
setInterval(sampleCpu, 1000);

// /proc/meminfo inside the container exposes the HOST's view (same numbers in
// every container), so os.totalmem() / freemem() can't tell us per-agent
// memory — every agent would read 9 GB even when one is idle and another is
// thrashing. Sum VmRSS from /proc/*/status instead: the pid namespace scopes
// it to the container's own process tree, so we get true per-agent usage.
function sumProcessRss() {
  let rss = 0;
  let pids;
  try {
    pids = fs.readdirSync('/proc');
  } catch {
    return 0;
  }
  for (const name of pids) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const s = fs.readFileSync(`/proc/${name}/status`, 'utf8');
      const m = s.match(/^VmRSS:\s+(\d+)\s+kB/m);
      if (m) rss += parseInt(m[1], 10) * 1024;
    } catch {
      /* process exited between readdir and read — ignore */
    }
  }
  return rss;
}

// Memory cap from cgroup v2's memory.max (set by docker --memory at agent
// creation). Fall back to host total when uncapped or unreadable, so the
// dashboard ring still has a sensible denominator.
function cgroupMemLimit() {
  try {
    const v = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (v && v !== 'max') {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    /* cgroup v1 / unreadable — fall through */
  }
  return os.totalmem();
}

// Real CPU quota (cores) from cgroup v2's cpu.max ("quota period"). null when
// uncapped. Like memory, the container's /proc/cpuinfo reports the HOST's cores,
// so this is the only honest per-agent core count.
function cgroupCpuQuota() {
  try {
    const v = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim();
    const [q, p] = v.split(/\s+/);
    if (q && q !== 'max') {
      const quota = parseInt(q, 10);
      const period = parseInt(p, 10) || 100000;
      if (quota > 0 && period > 0) return quota / period;
    }
  } catch {
    /* cgroup v1 / unreadable */
  }
  return null;
}

// Cap on concurrent tool/subagent spawns for this agent's claude.
//
// The container's /proc reports the HOST's cpu + memory (e.g. 16 cores / 30 GB)
// even though cgroups hard-cap it far lower (default 2 cores / 4 GB). Claude
// Code's ultracode/Workflow orchestration sizes its subagent fan-out from that
// inflated core count (~min(16, cores-2) = 14 subagents) and believes it has
// 30 GB — so a workflow spawns far more subagent processes (~0.5 GB RSS each)
// than fit and the cgroup OOM-kills the whole session. We derive a cap from the
// REAL cgroup limits and export it as CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY so
// fan-out scales to what actually fits, regardless of the agent's size.
function toolConcurrencyCap() {
  const memBytes = cgroupMemLimit(); // real cap, or host total if uncapped
  const cores = cgroupCpuQuota(); // real quota (cores), or null if uncapped
  const memCapped = memBytes < os.totalmem() * 0.95;
  // Genuinely unconstrained (bare metal / no limits) → let claude decide.
  if (!memCapped && cores === null) return null;
  const memMB = memBytes / (1024 * 1024);
  const RESERVE_MB = 2048; // parent claude + GNOME desktop + supervisor headroom
  const PER_AGENT_MB = 550; // ~RSS of one extra claude subagent
  const byMem = Math.floor((memMB - RESERVE_MB) / PER_AGENT_MB);
  const byCpu = cores ? Math.max(1, Math.round(cores) * 2) : 12;
  return Math.max(1, Math.min(byMem, byCpu, 12));
}

function systemSnapshot() {
  return {
    cpuPct: Math.round(cpuPctCached * 100) / 100, // 0..(cores*100)
    cores: os.cpus().length,
    memUsed: sumProcessRss(),
    memLimit: cgroupMemLimit(),
  };
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
  // Codex runs against a ChatGPT subscription, not metered API billing, so
  // there is no per-token cost to report. Rating these at Anthropic's prices
  // would invent a dollar figure out of nothing — and now that the proxy
  // reports real input tokens, that figure would climb fast. Turns from an
  // agent's earlier Anthropic life are rated per-entry, so they still count.
  if (m.startsWith('gpt-') || m.includes('codex')) return { in: 0, out: 0, cw: 0, cr: 0 };
  if (m.includes('opus')) return { in: 15, out: 75, cw: 18.75, cr: 1.5 };
  if (m.includes('haiku')) return { in: 1, out: 5, cw: 1.25, cr: 0.1 };
  // Sonnet: long-context (>200K input) tier is priced higher.
  if (ctxTokens > 200000) return { in: 6, out: 22.5, cw: 7.5, cr: 0.6 };
  return { in: 3, out: 15, cw: 3.75, cr: 0.3 };
}

/**
 * Whether setuid binaries can actually elevate.
 *
 * Under sysbox the container's rootfs is a userns-remapped view (uid_map maps
 * container 0 to a host subuid). The shared read-only image layers stay owned by
 * host root on disk, so they are only readable as root INSIDE the container
 * because sysbox applies an ID-mapped mount over them at container start
 * (shiftfs, its older mechanism, is not loaded on this kernel). When that mount
 * is missing, every root-owned file — /usr/bin/sudo, /bin/ls, /usr/bin/apt —
 * reports uid 65534 (the overflow uid) instead of 0. The setuid bit only
 * elevates for a root-owned file, so sudo becomes silently inert.
 *
 * Root cause, confirmed: sysbox chowns a container's overlay upper layer
 * 0 -> BASE on start and BASE -> 0 on stop. An affected container gets stuck
 * SHIFTED — its upper layer reads BASE even while stopped — so on every start
 * sysbox sees a rootfs that already looks mapped, does nothing, and the shared
 * lower layers stay owned by host root (an unmapped uid inside the userns).
 * That is why restarting never helps and why the migration version is
 * irrelevant: migrations ship files, not mount configuration.
 *
 * Repaired in place by shifting the upper layer back down while the container
 * is stopped — see scripts/fix-sysbox-idmap.py. Verified on a live agent: sudo
 * and apt both work again and it survives subsequent restarts.
 *
 * It went unnoticed because nothing fails until something needs apt — one agent
 * happened to check at startup, which is the whole reason for this check.
 *
 * Cheap and cached: ownership cannot change while the container runs.
 */
let privilegeCheck;
function privilegeHealth() {
  if (privilegeCheck) return privilegeCheck;
  try {
    const uid = fs.statSync('/usr/bin/sudo').uid;
    privilegeCheck =
      uid === 0
        ? { ok: true, sudoOwnerUid: uid }
        : {
            ok: false,
            sudoOwnerUid: uid,
            detail:
              `/usr/bin/sudo is owned by uid ${uid}, not root, so its setuid bit cannot ` +
              'elevate and every privileged operation (apt, systemctl) will fail. The ' +
              "container's overlay upper layer is stuck in sysbox's shifted frame, so " +
              'sysbox thinks the rootfs is already mapped and never sets up the mapping. ' +
              'Restarting does NOT help (each start re-confirms it). Fix in place with ' +
              'scripts/fix-sysbox-idmap.py — stop the agent, shift the upper layer back, ' +
              'start it. No recreate needed. Nothing breaks until something needs apt.',
          };
  } catch (e) {
    // Absent sudo is a different problem; don't claim a mapping fault.
    privilegeCheck = { ok: true, sudoOwnerUid: null, detail: `could not check: ${e.message}` };
  }
  return privilegeCheck;
}

// Context-window size by model name, used when Claude Code's statusline omits
// it (which happens for non-Anthropic models served through the opencode-proxy).
// Best-effort: when in doubt we return 0 and the ring shows no denominator
// (better than a wrong percentage). Values mirror each provider's published
// limits at the time of writing.
function modelContextLimit(model) {
  const m = (model || '').toLowerCase();
  if (!m) return 0;
  // Deliberately NO entry for the Codex (gpt-*) models, even though their
  // physical windows are known (~910k for gpt-5.4, ~355k for the gpt-5.6
  // family, ~245k for gpt-5.5 / gpt-5.4-mini — measured 2026-07-28 by finding
  // where the backend starts returning context_length_exceeded).
  //
  // The physical window is NOT what constrains the agent: Claude Code doesn't
  // recognise these ids, so it applies its own 200k default and auto-compacts
  // at a fraction of that. Putting 910k here would show the ring at 18% full at
  // the exact moment Claude Code decides to compact. The statusline value below
  // is what Claude Code actually enforces, so let it win — and it keeps being
  // right if CLAUDE_CODE_MAX_CONTEXT_TOKENS is ever set to lift that ceiling.
  if (m.includes('kimi-k2')) return 256_000;
  if (m.includes('glm-5')) return 128_000;
  if (m.includes('deepseek-v4')) return 128_000;
  if (m.includes('minimax')) return 1_000_000;
  if (m.includes('qwen3.7')) return 256_000;
  if (m.includes('qwen3')) return 128_000;
  if (m.includes('mimo')) return 128_000;
  if (m.includes('hy3')) return 128_000;
  return 0;
}

// Incremental, chunked Claude-session stats. We must NEVER read a whole
// transcript into a string: past Node's ~512MiB max string length,
// readFileSync('utf8') throws ERR_STRING_TOO_LONG — which silently zeroed stats
// for large transcripts, and because the gateway's auto-compact watchdog reads
// `context` from here, that ALSO stopped auto-compaction, letting the file grow
// unbounded (atlas reached 591MB). Instead we keep a running per-message usage
// map and only parse the bytes appended since the last call.
//
// Two reasons claude writes the same `message.id` more than once:
//   1. `claude --continue` replays prior assistant messages into the resume;
//   2. streaming providers flush the record on message_start (usage=0) and again
//      on message_delta (final usage).
// So we key by id and keep the MAX of each field (final values strictly grow vs.
// partial ones), and pick `context` from the latest non-empty turn.
const EMPTY_STATS = () => ({
  totals: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  model: null,
  turns: 0,
  lastTs: null,
  context: 0,
  cost: 0,
});
// Running incremental state for the newest transcript.
let statsState = null; // { path, size, byId:Map, leftover, order, lastTs }
// Memoized aggregation keyed by (path, mtime, size) — an unchanged file is free.
let transcriptStatsCache = { key: null, value: null };

function accumulateStatsLine(state, line) {
  if (!line || !line.trim()) return;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (o.timestamp) state.lastTs = o.timestamp;
  if (o.type !== 'assistant' || !o.message) return;
  const mid = o.message.id || `__noid_${state.order}`; // unique key for missing ids
  const usage = o.message.usage || {};
  const cur = state.byId.get(mid) || {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    model: null,
    order: state.order++,
  };
  cur.input = Math.max(cur.input, usage.input_tokens || 0);
  cur.output = Math.max(cur.output, usage.output_tokens || 0);
  cur.cacheRead = Math.max(cur.cacheRead, usage.cache_read_input_tokens || 0);
  cur.cacheCreation = Math.max(cur.cacheCreation, usage.cache_creation_input_tokens || 0);
  if (o.message.model) cur.model = o.message.model;
  state.byId.set(mid, cur);
}

function transcriptStats() {
  const newest = newestFile(path.join(CLAUDE_DIR, 'projects'), '.jsonl');
  if (!newest) return EMPTY_STATS();
  let st;
  try {
    st = fs.statSync(newest.path);
  } catch {
    return EMPTY_STATS();
  }
  const cacheKey = `${newest.path}:${st.mtimeMs}:${st.size}`;
  if (transcriptStatsCache.key === cacheKey) return transcriptStatsCache.value;

  // Reuse the running state when the same file only grew (append); otherwise
  // (new session file, or the file shrank/rotated) start clean.
  let state = statsState;
  if (!state || state.path !== newest.path || st.size < state.size) {
    state = { path: newest.path, size: 0, byId: new Map(), leftover: '', order: 0, lastTs: null };
  }
  // Read only [state.size .. st.size) in chunks, decoding UTF-8 across chunk
  // boundaries so we never materialise the whole (possibly >512MiB) file.
  let fd;
  try {
    fd = fs.openSync(newest.path, 'r');
    const CHUNK = 4 * 1024 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK);
    const decoder = new StringDecoder('utf8');
    let pos = state.size;
    while (pos < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const text = state.leftover + decoder.write(buf.subarray(0, n));
      const lines = text.split('\n');
      state.leftover = lines.pop() || '';
      for (const line of lines) accumulateStatsLine(state, line);
    }
    state.leftover += decoder.end();
  } catch {
    /* keep whatever we accumulated */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  state.size = st.size;
  statsState = state;

  // Aggregate from the per-id map. Include the trailing not-yet-newline-
  // terminated record (if valid) as a tentative entry so the most recent turn
  // shows immediately; it becomes a permanent byId entry once its '\n' arrives.
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let model = null;
  let context = 0;
  let cost = 0;
  const entries = [...state.byId.values()].sort((a, b) => a.order - b.order);
  let tentative = null;
  if (state.leftover && state.leftover.trim()) {
    try {
      const o = JSON.parse(state.leftover);
      if (o.timestamp) state.lastTs = o.timestamp;
      if (o.type === 'assistant' && o.message && !state.byId.has(o.message.id)) {
        const u = o.message.usage || {};
        tentative = {
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheCreation: u.cache_creation_input_tokens || 0,
          model: o.message.model || null,
        };
      }
    } catch {
      /* partial line — ignore until complete */
    }
  }
  const all = tentative ? [...entries, tentative] : entries;
  for (const e of all) {
    totals.input += e.input;
    totals.output += e.output;
    totals.cacheRead += e.cacheRead;
    totals.cacheCreation += e.cacheCreation;
    if (e.model) model = e.model;
    const ctx = e.input + e.cacheRead + e.cacheCreation;
    if (ctx > 0) context = ctx;
    const r = modelRates(e.model, ctx);
    cost +=
      (e.input * r.in + e.output * r.out + e.cacheCreation * r.cw + e.cacheRead * r.cr) / 1_000_000;
  }
  const result = { totals, model, turns: all.length, lastTs: state.lastTs, context, cost };
  transcriptStatsCache = { key: cacheKey, value: result };
  return result;
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
    // Fall back to the first array of scalars (computer-use `hotkey` passes
    // `keys: ["ctrl","c"]`, which the string search above never matched — so
    // hotkeys used to render with no detail at all).
    (Object.values(input).find((x) => Array.isArray(x) && x.every((e) => typeof e !== 'object')) ||
      [])
      .join('+') ||
    '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 140) + '…' : s;
}

/** Cap on one stringified arg value in the transcript payload. */
const TOOL_ARG_MAX = 120;

/**
 * A compact, size-bounded copy of a tool call's input, so the chat can render
 * the SPECIFICS (which keys a hotkey pressed, where a click landed) instead of
 * just the tool's name. Deliberately not the raw input: a transcript carries
 * thousands of these, and some tools take whole file contents.
 */
function toolArgs(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(input)) {
    if (n >= 8) break;
    let val;
    if (v == null) continue;
    else if (typeof v === 'string') val = v.length > TOOL_ARG_MAX ? v.slice(0, TOOL_ARG_MAX) + '…' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') val = v;
    else if (Array.isArray(v) && v.every((e) => typeof e !== 'object'))
      val = v.slice(0, 12).map((e) => String(e));
    else if (
      typeof v === 'object' &&
      Object.keys(v).length <= 6 &&
      Object.values(v).every((e) => e === null || typeof e !== 'object')
    ) {
      // One level of small, flat objects — the desktop tools pass coordinates
      // as `pos: {x, y, sys}`, and dropping those loses exactly the detail
      // worth showing. Deeper/larger structures still aren't worth the payload.
      val = Object.fromEntries(Object.entries(v).map(([k2, v2]) => [k2, String(v2)]));
    } else continue;
    out[k] = val;
    n++;
  }
  return n ? out : undefined;
}

// Strip ANSI SGR escape sequences (e.g. the [1m…[22m in slash-command output).
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\[[0-9;]*m/g, '');
}

// Slash commands (e.g. an injected `/model opus`) are recorded by Claude Code as
// user messages wrapped in <command-name>/<command-args>/<local-command-stdout>/
// <local-command-caveat> tags. Rendered raw they're noise — turn them into a
// clean command badge + its output, and drop the internal caveat/message lines.
// Returns an items[] (possibly empty = skip), or null when not a command message.
function parseCommandMessage(text) {
  const t = stripAnsi(text);
  if (/<local-command-caveat>/.test(t)) return []; // internal instruction — hide
  const nameM = t.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (nameM) {
    const name = nameM[1].trim();
    const argsM = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const args = argsM ? argsM[1].trim() : '';
    return [{ kind: 'tool', name: name.startsWith('/') ? name : `/${name}`, detail: args }];
  }
  const outM = t.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (outM) {
    const inner = outM[1].trim();
    return inner ? [{ kind: 'text', text: inner }] : [];
  }
  return null;
}

// Module-level cache keyed by (path, mtimeMs, size). The dashboard ChatPanel
// polls /api/transcript every 2s per open chat; the file is large (atlas's
// hit 43MB) but only changes when claude writes a turn — so for an idle agent
// the cache hits and we skip both the disk read AND the JSON parsing.
let transcriptCache = { key: null, value: [] };
// Tail-read budget for large transcripts: 1.5 MB covers the last 500 lines
// for typical chats (the dashboard only ever shows .slice(-500)). Reading the
// whole file is what was burning CPU.
const TRANSCRIPT_TAIL_BYTES = 1_500_000;

function readTranscriptRawTail(filePath, size) {
  if (size <= TRANSCRIPT_TAIL_BYTES) {
    return safeRead(filePath);
  }
  // Open + read the last TRANSCRIPT_TAIL_BYTES, then discard the first
  // (partial) line so JSON.parse below never sees a truncated record.
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(TRANSCRIPT_TAIL_BYTES);
    fs.readSync(fd, buf, 0, TRANSCRIPT_TAIL_BYTES, size - TRANSCRIPT_TAIL_BYTES);
    const s = buf.toString('utf8');
    const nl = s.indexOf('\n');
    return nl === -1 ? s : s.slice(nl + 1);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// Normalized conversation for the dashboard chat view: user/assistant turns,
// each with text and tool-call items (tool results & thinking are omitted).
function readTranscript() {
  const newest = newestFile(path.join(CLAUDE_DIR, 'projects'), '.jsonl');
  if (!newest) return [];
  let st;
  try {
    st = fs.statSync(newest.path);
  } catch {
    return [];
  }
  const key = `${newest.path}:${st.mtimeMs}:${st.size}`;
  if (transcriptCache.key === key) return transcriptCache.value;
  const raw = readTranscriptRawTail(newest.path, st.size);
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
      if (content.trim()) {
        const cmd = parseCommandMessage(content);
        if (cmd) items.push(...cmd);
        else items.push({ kind: 'text', text: content });
      }
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
          items.push({
            kind: 'tool',
            name: b.name,
            detail: toolDetail(b.input),
            args: toolArgs(b.input),
          });
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
  transcriptCache = { key, value: out };
  return out;
}

let shotCache = { at: 0, buf: null };
/** How long `import` gets before we give up on it. The X server can wedge (a
 *  hung GNOME session, a stuck GPU) and then `import` never exits — with no
 *  bound the HTTP response never completes either, which is far worse for the
 *  dashboard than a fast failure: it polls this for every agent. */
const SHOT_TIMEOUT_MS = 4000;

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
  let timer = null;
  const finish = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const fail = (why) => {
    if (done) return;
    done = true;
    finish();
    // Make sure a wedged capture can't linger and pile up on every poll.
    try {
      p.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/plain' });
    res.end(`screenshot unavailable${why ? ` (${why})` : ''}`);
  };
  timer = setTimeout(() => fail('timeout'), SHOT_TIMEOUT_MS);
  p.stdout.on('data', (d) => chunks.push(d));
  p.on('error', () => fail('spawn failed'));
  p.on('close', (code) => {
    if (done) return;
    if (code !== 0 || !chunks.length) return fail(`exit ${code}`);
    done = true;
    finish();
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
    // Authoritative context-window size: trust our per-model lookup first for
    // non-Anthropic models (claude defaults to 200k for anything it doesn't
    // recognize — e.g. kimi-k2.6 is actually 256k), and fall back to Claude
    // Code's own statusline value for everything else (it carries the right
    // number for Anthropic models, where "Opus 4.7" alone wouldn't).
    contextLimit:
      modelContextLimit((sl.model && sl.model.display_name) || t.model) ||
      (sl.context_window && sl.context_window.context_window_size) ||
      null,
    turns: t.turns,
    // Computed from token usage × per-model rates; fall back to Claude Code's
    // own statusLine figure if we have no turns yet.
    cost:
      t.turns > 0 ? t.cost : typeof cost.total_cost_usd === 'number' ? cost.total_cost_usd : null,
    linesAdded: cost.total_lines_added || 0,
    linesRemoved: cost.total_lines_removed || 0,
    exceeds200k: !!sl.exceeds_200k_tokens,
    // Surfaced so a broken rootfs mapping shows up on the dashboard instead of
    // waiting for an agent to trip over a failing apt. See privilegeHealth().
    privileges: privilegeHealth(),
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

// Update Claude Code to the latest release right before launching the session,
// so the agent always runs the newest version (the autoupdater is disabled in
// the unit). Best-effort: `;` (not `&&`) means an offline/failed update still
// falls through to the baked-in version. `sudo` because the global npm prefix
// is root-owned; this runs synchronously in the claude pty BEFORE claude, and
// only delays that session (the rest of the supervisor is already up).
const CLAUDE_UPDATE_CMD =
  'echo "Updating Claude Code..."; sudo /usr/bin/npm install -g @anthropic-ai/claude-code@latest --no-audit --no-fund 2>&1 | tail -n 1';

// Fired between the update and the claude launch: tells this supervisor that
// the slow part is done and the TUI is starting, so a boot nudge can be timed
// off reality instead of a guess. `command -v` keeps it a no-op on an older
// image that doesn't ship the script yet.
const READY_SIGNAL_CMD = 'command -v swarm-signal-ready >/dev/null && swarm-signal-ready';
/** Settle after the ready signal — the update has finished, but claude itself
 *  still needs a few seconds to render its prompt. */
const READY_SETTLE_MS = parseInt(process.env.SWARM_READY_SETTLE_MS || '5000', 10);
/** Safety net if the signal never arrives (script missing, curl gone, supervisor
 *  not yet listening when it fired). Generous, because the whole point is that
 *  an update can be slow — this only has to beat "never". */
const READY_FALLBACK_MS = parseInt(process.env.SWARM_READY_FALLBACK_MS || '180000', 10);

/** Bounds on a scripted /api/inject key sequence. The sequence holds the
 *  session's write chain for its whole duration (that's the point — nothing
 *  else may interleave into the pty mid-script), so a caller must not be able
 *  to wedge the chain with a huge or unbounded script. */
const STEP_MAX_COUNT = 32;
const STEP_MAX_WAIT_MS = 30_000;

// Resume across container restarts. The agent's home is a persistent disk, so
// Claude's transcripts survive a restart. If one exists for the working dir,
// continue the most recent conversation (with a fresh session as fallback if
// the resume fails); on first boot there's nothing to continue, so start clean
// (`--continue` errors with no prior conversation). An explicit FIRST_CMD wins.
function claudeBootCommand() {
  let launch = FIRST_CMD;
  if (!process.env.FIRST_CMD) {
    try {
      const projDir = path.join(CLAUDE_DIR, 'projects', HOME.replace(/[^a-zA-Z0-9]/g, '-'));
      if (fs.readdirSync(projDir).some((f) => f.endsWith('.jsonl')))
        launch = `claude --continue --dangerously-skip-permissions || ${FIRST_CMD}`;
    } catch {
      /* no prior transcripts — start fresh */
    }
  }
  // `;` between every step, never `&&`: a failed update, or a missing
  // swarm-signal-ready (older image), must still fall through to claude.
  return `${CLAUDE_UPDATE_CMD}; ${READY_SIGNAL_CMD}; ${launch}`;
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
  // The claude boot chain reporting that the pre-launch update is done and the
  // TUI is coming up. Local-only (the supervisor port isn't published) and
  // side-effect-light, so GET is accepted too for a dumb `curl`.
  if (u.pathname === '/api/session-ready' && (req.method === 'POST' || req.method === 'GET')) {
    signalSessionReady();
    return sendJson(res, 200, { ok: true, readyAt });
  }
  if (u.pathname === '/api/stats' && req.method === 'GET') {
    let codexLimits = null;
    try {
      // Only meaningful for a chatgpt-provider agent; null everywhere else.
      ({ getRateLimits: codexLimits } = require('./codex-proxy.js'));
      codexLimits = codexLimits();
    } catch {
      codexLimits = null;
    }
    return sendJson(res, 200, { ...readStats(), readyAt, codexLimits });
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
  //
  // `interrupt: true` sends Esc first (the claude TUI interrupt key) so the
  // message is handled NOW instead of queued behind the current turn. With no
  // `text`, it's a pure interrupt (e.g. a Stop action).
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
    const interrupt = !!body.interrupt;
    // `steps` drives a scripted key sequence (bare Enter, typed text, waits) —
    // needed for TUI flows that a single text+Enter can't express, e.g. the
    // /effort selector, which wants an Enter to clear the line, then the
    // command, then confirmation Enters spaced out while the TUI redraws.
    const steps = Array.isArray(body.steps) ? body.steps.slice(0, STEP_MAX_COUNT) : null;
    const sess = sessions.get(name);
    if (!sess) return sendJson(res, 404, { error: 'session not found' });
    if (!steps && !text.trim() && !interrupt)
      return sendJson(res, 400, { error: 'text, steps, or interrupt required' });

    // Serialize the full write sequence (Esc / text / Enter) per session so two
    // concurrent injects — e.g. an interrupt arriving while a queued message is
    // mid-write — can't interleave their bytes in the pty. We await completion
    // before responding so the caller knows the message was actually typed.
    const perform = async () => {
      if (steps) {
        for (const s of steps) {
          if (!s || typeof s !== 'object') continue;
          try {
            if (typeof s.waitMs === 'number') {
              await sleep(Math.min(Math.max(s.waitMs, 0), STEP_MAX_WAIT_MS));
            } else if (s.key === 'enter') {
              sess.pty.write('\r');
            } else if (s.key === 'esc') {
              sess.pty.write('\x1b');
            } else if (typeof s.text === 'string' && s.text) {
              sess.pty.write(s.text.replace(/\r\n?/g, '\n'));
            }
          } catch {
            return; /* session closed mid-sequence */
          }
        }
        return;
      }
      if (interrupt) {
        sess.pty.write('\x1b'); // claude TUI interrupt key
        await sleep(350); // let it settle back to the prompt
      }
      if (text.trim()) {
        sess.pty.write(text.replace(/\r\n?/g, '\n'));
        await sleep(150); // the TUI needs a beat before the carriage return
        try {
          sess.pty.write('\r');
        } catch {
          /* session may have closed */
        }
      }
    };
    sess.writeChain = (sess.writeChain || Promise.resolve()).then(perform).catch(() => {});
    await sess.writeChain;
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
  // Container-wide CPU% and memory totals computed from /proc as seen INSIDE
  // the container. The gateway polls this in place of `docker stats` because
  // sysbox-runc's nested cgroups defeat the outer stats — atlas reads ~5 MB
  // via `docker stats` while its process tree actually uses ~2.7 GB. Reading
  // /proc inside the user namespace gets the real numbers.
  if (u.pathname === '/api/system' && req.method === 'GET') {
    return sendJson(res, 200, systemSnapshot());
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

// Heartbeat: write the current time to disk every 15s so that, after a
// container shutdown, the next boot can tell how long we were down. A small gap
// (supervisor-only restart) is ignored; a real downtime gap triggers a resume nudge.
const HEARTBEAT_FILE = path.join(HOME, '.swarm', 'heartbeat');
const DOWNTIME_THRESHOLD_MS = 90_000;

function readHeartbeat() {
  try {
    const n = parseInt(fs.readFileSync(HEARTBEAT_FILE, 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
function writeHeartbeat() {
  try {
    fs.mkdirSync(path.dirname(HEARTBEAT_FILE), { recursive: true });
    fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()));
  } catch {
    /* best-effort */
  }
}

// One-shot marker the gateway drops just before a *deliberate* restart
// (recreate / operator start). Lets us tell an operator-driven bounce apart from
// an unexpected shutdown — the former is worth announcing even when it's quick
// (gap < the heartbeat threshold), the latter only when downtime was real.
const RESTART_MARKER = path.join(HOME, '.swarm', 'restart');

// On boot, surface to claude (once it's at the prompt) why it just restarted:
//  - a gateway-marked deliberate restart → always notify, any duration; or
//  - an unexpected shutdown whose heartbeat gap exceeds the threshold.
// A small gap with no marker (a supervisor-only restart) stays silent.
function maybeNudgeResume() {
  const prev = readHeartbeat();
  const now = Date.now();
  const fmt = (ms) => new Date(ms).toLocaleString();
  let deliberate = false;
  try {
    fs.statSync(RESTART_MARKER);
    deliberate = true;
    fs.rmSync(RESTART_MARKER, { force: true }); // consume it — fire once
  } catch {
    /* no marker */
  }
  let text = null;
  if (deliberate) {
    text =
      `**[sys://restart]** You were just restarted by the operator and are back online as of ${fmt(now)}. ` +
      `Pick up where you left off — check your recent work/tasks and continue. If you were mid-task or ` +
      `in a conversation, briefly let people know you're back.`;
  } else if (prev && now - prev > DOWNTIME_THRESHOLD_MS) {
    text =
      `**[sys://resume]** You were shut down around ${fmt(prev)} and started again at ${fmt(now)}. ` +
      `Pick up where you left off — check your recent work/tasks and continue.`;
  }
  if (!text) return;
  // Hold the nudge until claude is actually at its prompt. The boot chain tells
  // us via /api/session-ready; the fallback timer only covers the case where
  // that signal never comes.
  pendingBootNudge = text;
  bootNudgeFallback = setTimeout(deliverBootNudge, READY_FALLBACK_MS);
  bootNudgeFallback.unref?.();
}

/** Boot nudge text waiting for claude to be ready ('' once delivered/none). */
let pendingBootNudge = null;
let bootNudgeFallback = null;
/** When the boot chain reported the TUI was starting (null until signalled). */
let readyAt = null;

/** Type the pending boot nudge into the claude session, once. */
function deliverBootNudge() {
  if (!pendingBootNudge) return;
  const sess = sessions.get('claude');
  if (!sess) return; // session gone; drop it rather than resurrect later
  const text = pendingBootNudge;
  pendingBootNudge = null;
  if (bootNudgeFallback) {
    clearTimeout(bootNudgeFallback);
    bootNudgeFallback = null;
  }
  try {
    sess.pty.write(text);
  } catch {
    return; /* session closed */
  }
  setTimeout(() => {
    try {
      sess.pty.write('\r');
    } catch {
      /* session closed */
    }
  }, 200);
}

/** The boot chain finished updating and is launching claude. Record it and
 *  schedule the nudge a short settle later. Idempotent — a repeated signal
 *  (e.g. a session respawn) just refreshes the timestamp. */
function signalSessionReady() {
  readyAt = Date.now();
  if (!pendingBootNudge) return;
  if (bootNudgeFallback) {
    clearTimeout(bootNudgeFallback);
    bootNudgeFallback = null;
  }
  const t = setTimeout(deliverBootNudge, READY_SETTLE_MS);
  t.unref?.();
}

server.listen(PORT, () => {
  console.log(`agent-runtime terminal supervisor listening on :${PORT}`);
  maybeNudgeResume(); // checks the gap BEFORE we overwrite the heartbeat below
  writeHeartbeat();
  setInterval(writeHeartbeat, 15_000);
  // Start the opencode-proxy chain BEFORE the first claude session so an
  // opencodeGo-provider agent's claude finds the proxy already listening.
  // Order matters: oc-go-cc first (so by the time the retry proxy receives a
  // request, the upstream is ready), then the retry proxy in front of it.
  startOpencodeProxy();
  startRetryProxy();
  startChatgptProxy();
  try {
    createSession({ name: 'claude', command: claudeBootCommand() }); // always-on, from boot
  } catch (e) {
    console.error('failed to start first session:', e);
  }
});
