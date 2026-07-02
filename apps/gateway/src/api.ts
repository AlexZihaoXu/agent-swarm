import { createReadStream, createWriteStream, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename } from 'node:path';
import type { AgentManager } from './docker.js';
import { config } from './config.js';
import { getSettings, updateSettings, tokenDaysLeft, TOKEN_WARN_DAYS } from './settings.js';
import {
  isConfigured,
  isAuthed,
  setupCredentials,
  verifyPassword,
  changePassword,
  issueToken,
  sessionCookie,
  clearCookie,
  loginThrottle,
  noteLoginFailure,
  noteLoginSuccess,
} from './auth.js';
import { CAPABILITIES, listRoles, createRole, updateRole, deleteRole } from './roles.js';
import {
  auditLog,
  logEvent,
  type AuditActor,
  type AuditCategory,
  type AuditEvent,
  type AuditQuery,
} from './audit.js';
import { listProviders } from './providers.js';
import type { Capability, Provider } from './types.js';
import { listGroups, createGroup, updateGroup, deleteGroup } from './groups.js';
import { listGroupMessages, clearGroupMessages } from './group-chats.js';
import {
  listDir,
  readText,
  writeText,
  makeDir,
  move as moveFile,
  remove as removeFile,
  fileForDownload,
  zipDir,
  writeUpload,
  MAX_UPLOAD_BYTES,
} from './files.js';
import type { DiscordRules, IntegrationType } from './types.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': config.corsOrigin,
  });
  res.end(JSON.stringify(body));
}

function errStatus(err: unknown): number {
  const s = (err as { statusCode?: number })?.statusCode;
  return s && s >= 400 && s < 600 ? s : 500;
}

function headerValue(h: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(h) ? h[0] : h;
  const v = raw?.trim();
  return v || undefined;
}

/** Client IP for rate-limiting. Forwarding headers are CLIENT-CONTROLLED unless
 *  a trusted reverse proxy sets them, so they're only honored when TRUST_PROXY
 *  is on; otherwise an attacker could forge a unique IP per request and slip
 *  the throttle (and balloon its map). Behind the proxy, prefer headers the
 *  proxy chain OVERWRITES over ones it merely appends to:
 *   - cf-connecting-ip — set authoritatively by Cloudflare (replaces any
 *     client-sent value) and passed through by the origin proxy.
 *   - x-real-ip — set by nginx to ITS immediate peer; not client-spoofable.
 *   - X-Forwarded-For's LAST hop — appended by the nearest proxy. The first
 *     entry is whatever the client sent (Cloudflare appends, it doesn't
 *     replace), so it must never be the throttle key.
 *  None of this is bulletproof against an attacker who finds and hits the
 *  origin directly — the global login breaker in auth.ts is the backstop. */
function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const cf = headerValue(req.headers['cf-connecting-ip']);
    if (cf) return cf;
    const real = headerValue(req.headers['x-real-ip']);
    if (real) return real;
    const xff = headerValue(req.headers['x-forwarded-for']);
    const last = xff?.split(',').at(-1)?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress || 'unknown';
}

/** Audit actor for an operator request (the human via the dashboard). */
function opActor(req: IncomingMessage): AuditActor {
  return { kind: 'operator', ip: clientIp(req) };
}
/** Audit actor for an agent-originated /api/swarm/* request (fromId/from in body).
 *  Falls back to the operator when fromId is absent (e.g. operator group-send). */
function agentActor(
  req: IncomingMessage,
  body: { fromId?: string; from?: string; fromName?: string },
): AuditActor {
  const id = body.fromId?.trim();
  if (!id) return opActor(req);
  return { kind: 'agent', id, name: body.from || body.fromName || undefined };
}

/** Whether the request reached us over HTTPS — gates the `Secure` cookie. Direct
 *  TLS always counts; X-Forwarded-Proto is client-forgeable, so it's only trusted
 *  behind a configured proxy (TRUST_PROXY) — otherwise a forged `https` header
 *  over plain HTTP would attach Secure and silently break login. */
function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted === true) return true;
  return config.trustProxy && req.headers['x-forwarded-proto'] === 'https';
}

/** Apply permissive CORS for the dashboard origin; answer preflight directly. */
export function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  res.setHeader('access-control-allow-origin', config.corsOrigin);
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

const AUDIT_CATEGORIES: AuditCategory[] = [
  'auth',
  'agent',
  'docker',
  'swarm',
  'integration',
  'settings',
  'file',
  'system',
];

/** Parse the shared audit filter params from a request URL. */
function parseAuditQuery(req: IncomingMessage): AuditQuery {
  const p = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const numParam = (k: string) => {
    const v = p.get(k);
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  const cat = p.get('category') as AuditCategory | null;
  const actor = p.get('actor');
  const level = p.get('level');
  return {
    from: numParam('from'),
    to: numParam('to'),
    category: cat && AUDIT_CATEGORIES.includes(cat) ? cat : undefined,
    action: p.get('action') || undefined,
    agentId: p.get('agentId') || undefined,
    actorKind: actor === 'operator' || actor === 'agent' || actor === 'system' ? actor : undefined,
    level: level === 'info' || level === 'warn' || level === 'error' ? level : undefined,
    q: p.get('q') || undefined,
    limit: numParam('limit'),
    before: p.get('before') || undefined,
  };
}

/** GET /api/audit — filtered, newest-first, paginated query of the event log. */
function handleAudit(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (method !== 'GET') return (sendJson(res, 405, { error: 'method not allowed' }), true);
  const { events, hasMore } = auditLog.query(parseAuditQuery(req));
  return (sendJson(res, 200, { events, hasMore, timezone: config.auditTimezone }), true);
}

/** GET /api/audit/stream — live NDJSON tail (same filters), recent events first
 *  as a backfill, then each new event as it happens. */
function handleAuditStream(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (method !== 'GET') return (sendJson(res, 405, { error: 'method not allowed' }), true);
  const query = parseAuditQuery(req);
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'access-control-allow-origin': config.corsOrigin,
    'x-accel-buffering': 'no', // tell nginx/NPM not to buffer the stream
  });
  // Backfill the most recent matching events oldest→newest so a live tail starts
  // populated and stays chronological.
  const backfill = auditLog.query({ ...query, limit: Math.min(query.limit ?? 200, 500) }).events;
  for (let i = backfill.length - 1; i >= 0; i--) res.write(JSON.stringify(backfill[i]) + '\n');
  const unsub = auditLog.subscribe((ev: AuditEvent) => {
    try {
      res.write(JSON.stringify(ev) + '\n');
    } catch {
      /* socket gone */
    }
  }, query);
  const heartbeat = setInterval(() => {
    try {
      res.write('\n');
    } catch {
      /* gone */
    }
  }, 25_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    unsub();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  return true;
}

// /api/agents, /api/agents/:id, /api/agents/:id/(start|stop|compact|upgrade|paths|package)
const AGENT_API =
  /^\/api\/agents(?:\/([^/]+)(?:\/(start|stop|compact|recreate|upgrade|paths|package))?)?$/;
// /api/agents/:id/files — the per-agent file explorer (op via ?op=…).
const AGENT_FILES_API = /^\/api\/agents\/([^/]+)\/files$/;
// /api/agents/:id/integrations[/:type[/(test|apply|disable)]]
const INTEGRATION_API =
  /^\/api\/agents\/([^/]+)\/integrations(?:\/([^/]+)(?:\/(test|apply|disable))?)?$/;
// /api/packages, /api/packages/upload, /api/packages/:file[/(download|import)]
const PACKAGE_API = /^\/api\/packages(?:\/([^/]+)(?:\/(download|import))?)?$/;
// /api/roles, /api/roles/:id  •  /api/groups, /api/groups/:id
const ROLE_API = /^\/api\/roles(?:\/([^/]+))?$/;
const GROUP_API = /^\/api\/groups(?:\/([^/]+))?$/;
// /api/volumes, /api/volumes/:name — shared loop-image volumes.
const VOLUME_API = /^\/api\/volumes(?:\/([^/]+))?$/;
// /api/volumes/:name/files — file-explorer ops on a shared volume's root.
const VOLUME_FILES_API = /^\/api\/volumes\/([^/]+)\/files$/;
// /api/groups/:id/messages — the group's running chat log.
const GROUP_MSG_API = /^\/api\/groups\/([^/]+)\/messages$/;

/**
 * Handle the REST API. Returns true if the request was an /api/* route (and has
 * been answered), false to fall through to the proxy.
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AgentManager,
): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (!pathname.startsWith('/api/')) return false;
  const method = req.method ?? 'GET';

  try {
    if (pathname.startsWith('/api/auth/')) return await handleAuth(req, res, method);
    if (pathname === '/api/fs') return await handleFs(req, res, manager, method);
    // Reveal the full stored OAuth token (operator-only — the gate already
    // requires a session). Lets the operator copy back what they pasted.
    if (pathname === '/api/settings/token') {
      if (method !== 'GET') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      return (sendJson(res, 200, { token: getSettings().oauthToken ?? '' }), true);
    }
    if (pathname === '/api/settings') return await handleSettings(req, res, manager, method);
    if (pathname === '/api/providers/info') {
      if (method !== 'GET') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      return (sendJson(res, 200, await listProviders()), true);
    }
    if (pathname === '/api/providers') return await handleProviders(req, res, manager, method);
    if (pathname === '/api/host') return await handleHost(res, manager, method);
    if (pathname === '/api/metrics') return await handleMetrics(req, res, manager, method);
    if (pathname === '/api/roles' || pathname.startsWith('/api/roles/'))
      return await handleRoles(req, res, manager, method);
    if (pathname === '/api/groups' || pathname.startsWith('/api/groups/'))
      return await handleGroups(req, res, manager, method);
    if (pathname === '/api/usage') {
      if (method !== 'GET') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      return (sendJson(res, 200, await manager.usageSnapshot()), true);
    }
    // Audit / event log — operator-only (not in swarmTokenMayAccess).
    if (pathname === '/api/audit') return handleAudit(req, res, method);
    if (pathname === '/api/audit/stream') return handleAuditStream(req, res, method);
    if (pathname === '/api/audit/meta') {
      if (method !== 'GET') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      return (
        sendJson(res, 200, {
          timezone: config.auditTimezone,
          categories: AUDIT_CATEGORIES,
          levels: ['info', 'warn', 'error'],
          ...auditLog.stats(),
        }),
        true
      );
    }
    if (pathname === '/api/swarm/send') {
      if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      const body = await readJson(req);
      await manager.sendSwarmMessage(
        body.fromId ?? '',
        body.from ?? '',
        body.to ?? '',
        body.text ?? '',
      );
      logEvent({
        category: 'swarm',
        action: 'swarm.send',
        message: `message ${body.from || body.fromId || '?'} → ${body.to || '?'}`,
        actor: agentActor(req, body),
        agentId: body.fromId || undefined,
        target: body.to || undefined,
        meta: { chars: (body.text ?? '').length }, // metadata only, not content
      });
      return (sendJson(res, 200, { ok: true }), true);
    }
    if (pathname === '/api/swarm/send-file') {
      if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      const body = await readJson(req);
      const dest = await manager.sendSwarmFile(
        body.fromId ?? '',
        body.fromName ?? body.from ?? '',
        body.to ?? '',
        body.path ?? '',
        body.note,
      );
      logEvent({
        category: 'swarm',
        action: 'swarm.send_file',
        message: `file ${body.fromName || body.from || body.fromId || '?'} → ${body.to || '?'}: ${body.path ?? ''}`,
        actor: agentActor(req, body),
        agentId: body.fromId || undefined,
        target: body.to || undefined,
      });
      return (sendJson(res, 200, { ok: true, path: dest }), true);
    }
    if (pathname === '/api/swarm/manage') {
      if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      const body = await readJson(req);
      const agent = await manager.manageAgent(
        body.fromId ?? '',
        body.to ?? '',
        (body.action ?? '') as 'start' | 'stop',
      );
      logEvent({
        category: 'swarm',
        action: 'swarm.manage',
        message: `${body.fromId || '?'} ${body.action}ed peer ${body.to || '?'}`,
        actor: agentActor(req, body),
        agentId: body.fromId || undefined,
        target: body.to || undefined,
        meta: { peerAction: body.action },
      });
      return (sendJson(res, 200, { ok: true, agent }), true);
    }
    if (pathname === '/api/swarm/view') {
      if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      const body = await readJson(req);
      const savedPath = await manager.viewAgent(body.fromId ?? '', body.to ?? '');
      logEvent({
        category: 'swarm',
        action: 'swarm.view',
        message: `${body.fromId || '?'} captured peer ${body.to || '?'} screen`,
        actor: agentActor(req, body),
        agentId: body.fromId || undefined,
        target: body.to || undefined,
      });
      return (sendJson(res, 200, { ok: true, path: savedPath }), true);
    }
    if (pathname === '/api/swarm/compact') {
      if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      const body = await readJson(req);
      const result = await manager.compactPeer(body.fromId ?? '', body.to ?? '');
      logEvent({
        category: 'swarm',
        action: 'swarm.compact',
        message: `${body.fromId || '?'} ran /compact on peer ${body.to || '?'}`,
        actor: agentActor(req, body),
        agentId: body.fromId || undefined,
        target: body.to || undefined,
      });
      return (sendJson(res, 200, result), true);
    }
    if (pathname === '/api/swarm/stats') {
      if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      const body = await readJson(req);
      const stats = await manager.statsForPeer(body.fromId ?? '', body.to ?? '');
      logEvent({
        category: 'swarm',
        action: 'swarm.stats',
        message: `${body.fromId || '?'} read peer ${body.to || '?'} stats`,
        actor: agentActor(req, body),
        agentId: body.fromId || undefined,
        target: body.to || undefined,
      });
      return (sendJson(res, 200, stats), true);
    }
    if (pathname === '/api/swarm/usage') {
      if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      const body = await readJson(req);
      const usage = await manager.usageForAgent(body.fromId ?? '');
      logEvent({
        category: 'swarm',
        action: 'swarm.usage',
        message: `${body.fromId || '?'} read swarm usage`,
        actor: agentActor(req, body),
        agentId: body.fromId || undefined,
      });
      return (sendJson(res, 200, usage), true);
    }
    if (pathname === '/api/swarm/desktop') {
      if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      const body = await readJson(req);
      const enabled = body.desktop !== false; // any non-explicit-false = enable
      const result = await manager.toggleDesktopSelf(body.fromId ?? '', enabled);
      logEvent({
        category: 'swarm',
        action: 'swarm.desktop_toggle',
        message: `${body.fromId || '?'} turned its desktop ${enabled ? 'on' : 'off'}`,
        actor: agentActor(req, body),
        agentId: body.fromId || undefined,
        meta: { enabled },
      });
      return (sendJson(res, 200, result), true);
    }
    if (pathname === '/api/swarm/append-guidance') {
      if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      const body = await readJson(req);
      const result = await manager.appendAgentGuidance(body.fromId ?? '', body.text ?? '');
      logEvent({
        category: 'swarm',
        action: 'swarm.append_guidance',
        message: `${body.fromId || '?'} appended to its own guidance`,
        actor: agentActor(req, body),
        agentId: body.fromId || undefined,
        meta: { chars: (body.text ?? '').length },
      });
      return (sendJson(res, 200, result), true);
    }
    if (pathname === '/api/swarm/restart-self') {
      if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      const body = await readJson(req);
      const result = await manager.restartSelf(body.fromId ?? '');
      logEvent({
        category: 'swarm',
        action: 'swarm.restart_self',
        message: `${body.fromId || '?'} requested a self-restart`,
        actor: agentActor(req, body),
        agentId: body.fromId || undefined,
      });
      return (sendJson(res, 200, result), true);
    }
    if (pathname === '/api/swarm/discord-status') {
      if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      const body = await readJson(req);
      const text = String(body.text ?? '');
      const applied = manager.setDiscordStatus(body.fromId ?? '', text);
      logEvent({
        category: 'swarm',
        action: 'swarm.discord_status',
        message: `${body.fromId || '?'} set its Discord status${text ? `: ${text.slice(0, 60)}` : ' (cleared)'}`,
        actor: agentActor(req, body),
        agentId: body.fromId || undefined,
      });
      return (
        sendJson(res, applied ? 200 : 409, {
          ok: applied,
          error: applied ? undefined : 'discord bot not connected',
        }),
        true
      );
    }
    if (pathname === '/api/swarm/group-send') {
      if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      const body = await readJson(req);
      // fromId set = a peer agent; omitted = the human operator (dashboard).
      const msg = await manager.sendGroupMessage({
        fromId: body.fromId || undefined,
        fromName: body.fromName ?? body.from,
        group: body.group ?? '',
        text: body.text ?? '',
      });
      logEvent({
        category: 'swarm',
        action: 'swarm.group_send',
        message: `group message ${body.fromName || body.from || (body.fromId ? body.fromId : 'operator')} → group ${body.group || '?'}`,
        actor: agentActor(req, body),
        agentId: body.fromId || undefined,
        target: body.group || undefined,
        meta: { chars: (body.text ?? '').length },
      });
      return (sendJson(res, 200, { ok: true, message: msg }), true);
    }
    // The capability catalog (for the role editor's permission toggles).
    if (pathname === '/api/capabilities') {
      if (method !== 'GET') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      return (sendJson(res, 200, CAPABILITIES), true);
    }
    if (pathname === '/api/image') return await handleImageStatus(res, manager, method);
    if (pathname === '/api/image/build') return await handleImageBuild(res, manager, method);
    if (pathname.startsWith('/api/packages'))
      return await handlePackages(req, res, manager, method);
    if (VOLUME_FILES_API.test(pathname)) return await handleVolumeFiles(req, res, manager, method);
    if (VOLUME_API.test(pathname)) return await handleVolumes(req, res, manager, method);
    if (AGENT_FILES_API.test(pathname)) return await handleAgentFiles(req, res, manager, method);
    if (INTEGRATION_API.test(pathname)) return await handleIntegrations(req, res, manager, method);
    if (pathname.startsWith('/api/agents')) return await handleAgents(req, res, manager, method);
    sendJson(res, 404, { error: 'unknown endpoint' });
  } catch (err) {
    const status = errStatus(err);
    // Audit unexpected server errors (5xx); 4xx are expected client/validation
    // errors and would be noise.
    if (status >= 500)
      logEvent({
        category: 'system',
        action: 'system.error',
        level: 'error',
        message: `${method} ${pathname} → ${status}: ${err instanceof Error ? err.message : String(err)}`,
        actor: opActor(req),
        meta: { status, path: pathname },
      });
    sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

// /api/auth/(status|setup|login|logout|password) — operator login. These are the
// only API routes reachable without a session (the gate in server.ts allows them).
async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const authed = isAuthed(req.headers.cookie);

  if (pathname === '/api/auth/status') {
    if (method !== 'GET') return (sendJson(res, 405, { error: 'method not allowed' }), true);
    return (sendJson(res, 200, { configured: isConfigured(), authed }), true);
  }
  const isSecure = isSecureRequest(req);
  if (pathname === '/api/auth/setup') {
    if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
    if (isConfigured()) return (sendJson(res, 409, { error: 'already configured' }), true);
    const body = await readJson(req, MAX_AUTH_JSON_BYTES);
    setupCredentials(body.username ?? '', body.password ?? '');
    logEvent({
      category: 'auth',
      action: 'auth.setup',
      message: `first-run operator setup completed (user "${(body.username ?? '').trim()}")`,
      actor: opActor(req),
    });
    res.setHeader('set-cookie', sessionCookie(issueToken((body.username ?? '').trim()), isSecure));
    return (sendJson(res, 200, { ok: true }), true);
  }
  if (pathname === '/api/auth/login') {
    if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
    // Brute-force guard: a blocked source IP is turned away with 429 + Retry-After
    // BEFORE the password is even checked. A correct first-try login never trips it.
    const ip = clientIp(req);
    const throttle = loginThrottle(ip);
    if (throttle.blocked) {
      logEvent({
        category: 'auth',
        action: 'auth.login.throttled',
        level: 'warn',
        message: `login blocked by rate limit (retry in ${throttle.retryAfterSec}s)`,
        actor: { kind: 'operator', ip },
        meta: { retryAfterSec: throttle.retryAfterSec },
      });
      res.setHeader('retry-after', String(throttle.retryAfterSec));
      return (
        sendJson(res, 429, {
          error: 'too many login attempts, try again later',
          retryAfter: throttle.retryAfterSec,
        }),
        true
      );
    }
    const body = await readJson(req, MAX_AUTH_JSON_BYTES);
    if (!verifyPassword(body.username ?? '', body.password ?? '')) {
      noteLoginFailure(ip);
      logEvent({
        category: 'auth',
        action: 'auth.login.fail',
        level: 'warn',
        message: `failed login (user "${(body.username ?? '').trim() || '?'}")`,
        actor: { kind: 'operator', ip },
      });
      return (sendJson(res, 401, { error: 'invalid username or password' }), true);
    }
    noteLoginSuccess(ip);
    logEvent({
      category: 'auth',
      action: 'auth.login.success',
      message: `login succeeded (user "${(body.username ?? '').trim()}")`,
      actor: { kind: 'operator', ip },
    });
    res.setHeader('set-cookie', sessionCookie(issueToken((body.username ?? '').trim()), isSecure));
    return (sendJson(res, 200, { ok: true }), true);
  }
  if (pathname === '/api/auth/logout') {
    if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
    res.setHeader('set-cookie', clearCookie(isSecure));
    if (authed)
      logEvent({
        category: 'auth',
        action: 'auth.logout',
        message: 'operator signed out',
        actor: opActor(req),
      });
    return (sendJson(res, 200, { ok: true }), true);
  }
  if (pathname === '/api/auth/password') {
    if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
    if (!authed) return (sendJson(res, 401, { error: 'unauthorized' }), true);
    // Same brute-force guard as login: a stolen session cookie must not allow
    // grinding the current password through this endpoint.
    const ip = clientIp(req);
    const throttle = loginThrottle(ip);
    if (throttle.blocked) {
      res.setHeader('retry-after', String(throttle.retryAfterSec));
      return (
        sendJson(res, 429, {
          error: 'too many attempts, try again later',
          retryAfter: throttle.retryAfterSec,
        }),
        true
      );
    }
    const body = await readJson(req, MAX_AUTH_JSON_BYTES);
    try {
      changePassword(body.currentPassword ?? '', body.newPassword ?? '');
    } catch (err) {
      // Only a WRONG current password counts as a guess; validation errors
      // (e.g. a too-short new password) don't arm the throttle.
      if ((err as { statusCode?: number })?.statusCode === 403) {
        noteLoginFailure(ip);
        logEvent({
          category: 'auth',
          action: 'auth.password.fail',
          level: 'warn',
          message: 'failed password change (wrong current password)',
          actor: { kind: 'operator', ip },
        });
      }
      throw err;
    }
    noteLoginSuccess(ip);
    logEvent({
      category: 'auth',
      action: 'auth.password.change',
      message: 'operator password changed',
      actor: { kind: 'operator', ip },
    });
    // The change rotates the session secret (invalidating other sessions); mint a
    // fresh cookie so the operator who changed it stays logged in.
    const username = getSettings().auth?.username ?? '';
    res.setHeader('set-cookie', sessionCookie(issueToken(username), isSecure));
    return (sendJson(res, 200, { ok: true }), true);
  }
  sendJson(res, 404, { error: 'unknown endpoint' });
  return true;
}

// /api/agents/:id/files?op=… — per-agent file explorer (operator-only; gated).
// ops: list/read/download (GET), upload/write/mkdir/rename/delete (POST).
/** Shared file-explorer dispatch: drives the same op/path query-string
 *  protocol against any filesystem root (agent home, shared volume). The
 *  caller resolves the root (and throws 404 if it doesn't exist). */
async function dispatchFileOp(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  method: string,
  ctx: { agentId?: string; target?: string } = {},
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const op = url.searchParams.get('op') ?? '';
  const qpath = url.searchParams.get('path') ?? '';
  const logFile = (action: string, detail: string, level?: 'info' | 'warn') =>
    logEvent({
      category: 'file',
      action: `file.${action}`,
      level,
      message: `${action} ${detail}`,
      actor: opActor(req),
      agentId: ctx.agentId,
      target: ctx.target ?? detail,
    });

  if (method === 'GET') {
    if (op === 'list') return (sendJson(res, 200, listDir(root, qpath)), true);
    if (op === 'read') return (sendJson(res, 200, { content: readText(root, qpath) }), true);
    if (op === 'download') {
      logFile('download', qpath);
      const { name, stream } = fileForDownload(root, qpath);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${name.replace(/["\\]/g, '_')}"`,
      });
      stream.pipe(res);
      stream.on('error', () => res.destroyed || res.end());
      return true;
    }
    if (op === 'zip') {
      logFile('zip', qpath || '(root)');
      const { name, stream } = zipDir(root, qpath);
      // Hold headers until the archive actually starts producing bytes: if 7z
      // fails to spawn or errors before any output, we can still return a 500
      // instead of a truncated 200. 'readable' keeps the stream paused so no
      // chunk is lost between writeHead and pipe.
      stream.once('readable', () => {
        if (res.headersSent) return;
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${name.replace(/["\\]/g, '_')}"`,
        });
        stream.pipe(res);
      });
      stream.on('error', () => {
        if (!res.headersSent) sendJson(res, 500, { error: 'failed to create archive' });
        else if (!res.destroyed) res.destroy();
      });
      return true;
    }
    return (sendJson(res, 400, { error: 'unknown op' }), true);
  }

  if (method === 'POST') {
    if (op === 'upload') {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_UPLOAD_BYTES) return (sendJson(res, 413, { error: 'file too large' }), true);
        chunks.push(c as Buffer);
      }
      const name = url.searchParams.get('name') ?? 'upload';
      const saved = writeUpload(root, qpath, name, Buffer.concat(chunks));
      logFile('upload', `${qpath ? qpath + '/' : ''}${saved} (${size} bytes)`);
      return (sendJson(res, 200, { ok: true, name: saved }), true);
    }
    const body = await readJson(req);
    if (op === 'write') {
      writeText(root, body.path ?? '', body.content ?? '');
      logFile('write', body.path ?? '');
      return (sendJson(res, 200, { ok: true }), true);
    }
    if (op === 'mkdir') {
      makeDir(root, body.path ?? '');
      logFile('mkdir', body.path ?? '');
      return (sendJson(res, 200, { ok: true }), true);
    }
    if (op === 'rename') {
      moveFile(root, body.from ?? '', body.to ?? '');
      logFile('move', `${body.from ?? ''} → ${body.to ?? ''}`);
      return (sendJson(res, 200, { ok: true }), true);
    }
    if (op === 'delete') {
      removeFile(root, body.path ?? '');
      logFile('delete', body.path ?? '', 'warn');
      return (sendJson(res, 200, { ok: true }), true);
    }
    return (sendJson(res, 400, { error: 'unknown op' }), true);
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

async function handleAgentFiles(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const id = AGENT_FILES_API.exec(url.pathname)?.[1];
  if (!id) return (sendJson(res, 404, { error: 'unknown endpoint' }), true);
  const root = manager.agentHome(id); // throws 404 if the agent disk is absent
  return dispatchFileOp(req, res, root, method, { agentId: id });
}

async function handleVolumeFiles(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const name = VOLUME_FILES_API.exec(url.pathname)?.[1];
  if (!name) return (sendJson(res, 404, { error: 'unknown endpoint' }), true);
  const root = manager.volumeHome(decodeURIComponent(name)); // 404 if unregistered
  return dispatchFileOp(req, res, root, method, { target: `volume:${decodeURIComponent(name)}` });
}

// /api/agents/:id/integrations[/:type[/(test|apply|disable)]]
async function handleIntegrations(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const m = INTEGRATION_API.exec(pathname);
  if (!m || !m[1]) return (sendJson(res, 404, { error: 'unknown endpoint' }), true);
  const id: string = m[1];
  const type = m[2];
  const op = m[3];

  if (!type) {
    if (method === 'GET') return (sendJson(res, 200, manager.listIntegrations(id)), true);
    if (method === 'POST') {
      const body = await readJson(req);
      const t = (body.type ?? 'discord') as IntegrationType;
      const added = manager.addIntegration(id, t);
      logEvent({
        category: 'integration',
        action: 'integration.add',
        message: `added ${t} integration to ${id}`,
        actor: opActor(req),
        agentId: id,
        target: t,
      });
      return (sendJson(res, 201, added), true);
    }
  } else if (!op) {
    if (method === 'PATCH') {
      const body = await readJson(req);
      const patched = manager.updateIntegration(id, type as IntegrationType, {
        credentials: body.credentials,
        rules: body.rules,
      });
      logEvent({
        category: 'integration',
        action: 'integration.update',
        message: `updated ${type} integration on ${id}`,
        actor: opActor(req),
        agentId: id,
        target: type,
        meta: {
          changed: [body.credentials ? 'credentials' : null, body.rules ? 'rules' : null].filter(
            Boolean,
          ),
        },
      });
      return (sendJson(res, 200, patched), true);
    }
    if (method === 'DELETE') {
      await manager.removeIntegration(id, type as IntegrationType);
      logEvent({
        category: 'integration',
        action: 'integration.remove',
        level: 'warn',
        message: `removed ${type} integration from ${id}`,
        actor: opActor(req),
        agentId: id,
        target: type,
      });
      return (sendJson(res, 200, { ok: true }), true);
    }
  } else if (method === 'POST') {
    const t = type as IntegrationType;
    if (op === 'test' || op === 'apply' || op === 'disable') {
      const result =
        op === 'test'
          ? await manager.testIntegration(id, t)
          : op === 'apply'
            ? await manager.applyIntegration(id, t)
            : await manager.disableIntegration(id, t);
      logEvent({
        category: 'integration',
        action: `integration.${op}`,
        message: `${op} ${t} integration on ${id}`,
        actor: opActor(req),
        agentId: id,
        target: t,
      });
      return (sendJson(res, 200, result), true);
    }
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

// Global role registry: list/create, and update/delete by id (editing/removing
// a role refreshes the docs of agents holding it).
async function handleRoles(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const id = ROLE_API.exec(pathname)?.[1];
  if (!id) {
    if (method === 'GET') return (sendJson(res, 200, listRoles()), true);
    if (method === 'POST') {
      const body = await readJson(req);
      const role = createRole(
        body.name ?? '',
        body.description ?? '',
        Date.now(),
        body.permissions,
      );
      logEvent({
        category: 'settings',
        action: 'role.create',
        message: `created role "${role.name}" (${role.id})`,
        actor: opActor(req),
        target: role.id,
        meta: { permissions: role.permissions },
      });
      return (sendJson(res, 201, role), true);
    }
  } else if (method === 'PATCH') {
    const body = await readJson(req);
    const role = updateRole(id, {
      name: body.name,
      description: body.description,
      permissions: body.permissions,
    });
    await manager.refreshAgentsWithRole(id);
    logEvent({
      category: 'settings',
      action: 'role.update',
      message: `updated role "${role.name}" (${id})`,
      actor: opActor(req),
      target: id,
    });
    return (sendJson(res, 200, role), true);
  } else if (method === 'DELETE') {
    deleteRole(id);
    await manager.refreshAgentsWithRole(id); // they no longer hold it → doc cleared
    logEvent({
      category: 'settings',
      action: 'role.delete',
      level: 'warn',
      message: `deleted role ${id}`,
      actor: opActor(req),
      target: id,
    });
    return (sendJson(res, 200, { ok: true }), true);
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

// Global group registry (scopes swarm comms). No per-agent doc to refresh —
// membership is read live from each agent's identity at send time.
async function handleGroups(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  // The running chat log for a group (the dashboard renders + appends to this).
  const msgGroupId = GROUP_MSG_API.exec(pathname)?.[1];
  if (msgGroupId) {
    if (method === 'GET') return (sendJson(res, 200, listGroupMessages(msgGroupId)), true);
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  const id = GROUP_API.exec(pathname)?.[1];
  if (!id) {
    if (method === 'GET') return (sendJson(res, 200, listGroups()), true);
    if (method === 'POST') {
      const body = await readJson(req);
      const group = createGroup(body.name ?? '', body.description ?? '', Date.now());
      logEvent({
        category: 'settings',
        action: 'group.create',
        message: `created group "${group.name}" (${group.id})`,
        actor: opActor(req),
        target: group.id,
      });
      return (sendJson(res, 201, group), true);
    }
  } else if (method === 'PATCH') {
    const body = await readJson(req);
    const group = updateGroup(id, { name: body.name, description: body.description });
    logEvent({
      category: 'settings',
      action: 'group.update',
      message: `updated group "${group.name}" (${id})`,
      actor: opActor(req),
      target: id,
    });
    return (sendJson(res, 200, group), true);
  } else if (method === 'DELETE') {
    deleteGroup(id);
    clearGroupMessages(id);
    logEvent({
      category: 'settings',
      action: 'group.delete',
      level: 'warn',
      message: `deleted group ${id}`,
      actor: opActor(req),
      target: id,
    });
    return (sendJson(res, 200, { ok: true }), true);
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

// Shared volumes: list (with usage + attachments), create, delete.
async function handleVolumes(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const m = VOLUME_API.exec(pathname);
  const name = m?.[1] ? decodeURIComponent(m[1]) : undefined;
  if (!name) {
    if (method === 'GET') return (sendJson(res, 200, manager.listVolumes()), true);
    if (method === 'POST') {
      const body = await readJson(req);
      const vol = await manager.createVolume(body.name, body.sizeMb);
      logEvent({
        category: 'settings',
        action: 'volume.create',
        message: `created shared volume "${body.name}" (${body.sizeMb} MB)`,
        actor: opActor(req),
        target: body.name,
      });
      return (sendJson(res, 201, vol), true);
    }
    return (sendJson(res, 405, { error: 'method not allowed' }), true);
  }
  if (method === 'DELETE') {
    await manager.deleteVolume(name);
    logEvent({
      category: 'settings',
      action: 'volume.delete',
      level: 'warn',
      message: `deleted shared volume "${name}"`,
      actor: opActor(req),
      target: name,
    });
    return (sendJson(res, 200, { ok: true }), true);
  }
  return (sendJson(res, 405, { error: 'method not allowed' }), true);
}

async function handleAgents(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const m = AGENT_API.exec(pathname);
  if (!m) return (sendJson(res, 404, { error: 'unknown endpoint' }), true);
  const [, id, action] = m;

  if (!id) {
    if (method === 'GET') return (sendJson(res, 200, await manager.list()), true);
    if (method === 'POST') {
      const body = await readJson(req);
      const created = await manager.create({
        hostname: body.hostname,
        username: body.username,
        cpus: body.cpus ?? undefined,
        memoryMb: body.memoryMb ?? undefined,
        timezone: body.timezone ?? undefined,
        provider: body.provider,
        model: body.model ?? undefined,
        roles: body.roles,
        groups: body.groups,
        desktop: body.desktop,
        avatarSeed: body.avatarSeed,
        volumes: body.volumes,
      });
      logEvent({
        category: 'agent',
        action: 'agent.create',
        message: `created agent ${created.id}${created.username && created.username !== created.id ? ` (${created.username})` : ''}`,
        actor: opActor(req),
        agentId: created.id,
        meta: {
          cpus: body.cpus,
          memoryMb: body.memoryMb,
          provider: body.provider,
          model: body.model,
        },
      });
      return (sendJson(res, 201, created), true);
    }
  } else if (!action) {
    if (method === 'GET') return (sendJson(res, 200, await manager.getAgent(id)), true);
    if (method === 'DELETE') {
      await manager.remove(id);
      logEvent({
        category: 'agent',
        action: 'agent.remove',
        level: 'warn',
        message: `removed agent ${id} (container + persistent disk deleted)`,
        actor: opActor(req),
        agentId: id,
      });
      return (sendJson(res, 200, { ok: true }), true);
    }
    if (method === 'PATCH') {
      const body = await readJson(req);
      const patch: {
        username?: string;
        cpus?: number | null;
        memoryMb?: number | null;
        timezone?: string | null;
        guidance?: string | null;
        autoCompactPct?: number | null;
        provider?: Provider;
        model?: string | null;
        roles?: string[];
        groups?: string[];
        permissions?: Capability[];
        desktop?: boolean;
        avatarSeed?: string;
        volumes?: string[];
      } = {};
      if (body.username !== undefined) patch.username = body.username;
      if (body.cpus !== undefined) patch.cpus = body.cpus;
      if (body.memoryMb !== undefined) patch.memoryMb = body.memoryMb;
      if (body.timezone !== undefined) patch.timezone = body.timezone;
      if (body.guidance !== undefined) patch.guidance = body.guidance;
      if (body.autoCompactPct !== undefined) patch.autoCompactPct = body.autoCompactPct;
      if (body.provider !== undefined) patch.provider = body.provider;
      if (body.model !== undefined) patch.model = body.model;
      if (body.roles !== undefined) patch.roles = body.roles;
      if (body.groups !== undefined) patch.groups = body.groups;
      if (Array.isArray(body.permissions)) patch.permissions = body.permissions as Capability[];
      if (typeof body.desktop === 'boolean') patch.desktop = body.desktop;
      if (body.avatarSeed !== undefined) patch.avatarSeed = body.avatarSeed;
      if (Array.isArray(body.volumes)) patch.volumes = body.volumes;
      const updated = await manager.patchAgent(id, patch);
      const fields = Object.keys(patch);
      logEvent({
        category: 'agent',
        action: 'agent.patch',
        message: `updated agent ${id} settings (${fields.join(', ') || 'no change'})`,
        actor: opActor(req),
        agentId: id,
        meta: { fields }, // field NAMES only — never log guidance/token values
      });
      return (sendJson(res, 200, updated), true);
    }
  } else if (action === 'upgrade') {
    if (method === 'GET') return (sendJson(res, 200, await manager.upgradeInfo(id)), true);
    if (method === 'POST') {
      const info = await manager.upgrade(id);
      logEvent({
        category: 'agent',
        action: 'agent.upgrade',
        message: `upgraded agent ${id} (now v${info.installed}/${info.latest})`,
        actor: opActor(req),
        agentId: id,
      });
      return (sendJson(res, 200, info), true);
    }
  } else if (action === 'paths') {
    if (method === 'GET') return (sendJson(res, 200, manager.listAgentPaths(id)), true);
  } else if (action === 'package') {
    if (method === 'POST') {
      const body = await readJson(req);
      const result = await manager.packageAgent(id, Array.isArray(body.paths) ? body.paths : []);
      logEvent({
        category: 'agent',
        action: 'agent.package',
        message: `packaged agent ${id} → ${result.file}`,
        actor: opActor(req),
        agentId: id,
        target: result.file,
      });
      return (sendJson(res, 200, result), true);
    }
  } else if (action === 'compact') {
    if (method === 'POST') {
      // `fired` is false when the call was debounced (a /compact for this agent
      // landed less than 30s ago — the in-flight compaction is what the caller
      // wanted anyway, so the HTTP outcome is still {ok:true}).
      const fired = await manager.compactAgent(id);
      logEvent({
        category: 'agent',
        action: 'agent.compact',
        message: `ran /compact on ${id}${fired ? '' : ' (debounced)'}`,
        actor: opActor(req),
        agentId: id,
        meta: { debounced: !fired },
      });
      return (sendJson(res, 200, { ok: true, debounced: !fired }), true);
    }
  } else if (method === 'POST') {
    if (action === 'recreate') {
      const agent = await manager.recreate(id);
      logEvent({
        category: 'agent',
        action: 'agent.recreate',
        message: `recreated agent ${id} (fresh container, disk preserved)`,
        actor: opActor(req),
        agentId: id,
      });
      return (sendJson(res, 200, agent), true);
    }
    if (action === 'start') await manager.start(id);
    else await manager.stop(id);
    logEvent({
      category: 'agent',
      action: `agent.${action}`,
      message: `${action === 'start' ? 'started' : 'stopped'} agent ${id}`,
      actor: opActor(req),
      agentId: id,
    });
    return (sendJson(res, 200, { ok: true }), true);
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

async function handlePackages(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const m = PACKAGE_API.exec(pathname);
  if (!m) return (sendJson(res, 404, { error: 'unknown endpoint' }), true);
  const [, file, action] = m;

  if (!file) {
    if (method === 'GET') return (sendJson(res, 200, manager.listPackages()), true);
  } else if (file === 'upload' && !action) {
    // Stream a .7z brought from another swarm into this one's packages dir.
    if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const dest = manager.uploadDestination(url.searchParams.get('name') || 'package.7z');
    // Cap the stream at MAX_UPLOAD_BYTES (mirrors the agent-file upload guard): on
    // overflow stop reading, tear down both streams, drop the partial file, and 413.
    const tooLarge = await new Promise<boolean>((resolve, reject) => {
      const out = createWriteStream(dest);
      let size = 0;
      let aborted = false;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_UPLOAD_BYTES && !aborted) {
          aborted = true;
          req.unpipe(out);
          out.destroy();
          // Remove the partial file only AFTER the write stream has fully torn
          // down — out.destroy() is async, so a queued write could otherwise
          // re-create the file just after a synchronous rmSync.
          out.on('close', () => {
            try {
              rmSync(dest, { force: true });
            } catch {
              /* best-effort cleanup of the partial file */
            }
          });
          // Drain (and discard) the rest of the body rather than destroying req:
          // req and res share one TCP socket, so req.destroy() would reset it
          // before the 413 flushes, and the client would get ECONNRESET instead.
          req.resume();
          resolve(true);
        }
      });
      req.pipe(out);
      out.on('finish', () => {
        if (!aborted) resolve(false);
      });
      out.on('error', (e) => {
        if (!aborted) reject(e);
      });
      req.on('error', (e) => {
        if (!aborted) reject(e);
      });
    });
    if (tooLarge) return (sendJson(res, 413, { error: 'package too large' }), true);
    return (sendJson(res, 200, { file: basename(dest) }), true);
  } else if (action === 'download' && method === 'GET') {
    const path = manager.packageFilePath(file);
    if (!path) return (sendJson(res, 404, { error: 'package not found' }), true);
    res.writeHead(200, {
      'content-type': 'application/x-7z-compressed',
      'content-disposition': `attachment; filename="${file}"`,
    });
    createReadStream(path).pipe(res);
    return true;
  } else if (action === 'import' && method === 'POST') {
    const body = await readJson(req);
    const agent = await manager.importPackage(file, {
      hostname: body.hostname,
      username: body.username,
    });
    return (sendJson(res, 201, agent), true);
  } else if (!action && method === 'DELETE') {
    return (manager.deletePackage(file), sendJson(res, 200, { ok: true }), true);
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

async function handleFs(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  if (method !== 'GET') return (sendJson(res, 405, { error: 'method not allowed' }), true);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.searchParams.get('path') || process.env.HOME || '/';
  sendJson(res, 200, await manager.listHostDir(path));
  return true;
}

async function handleSettings(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  if (method === 'GET') {
    // The token is a secret: surface presence + a last-4 hint, never the value.
    const { oauthToken } = getSettings();
    return (
      sendJson(res, 200, {
        hasToken: !!oauthToken,
        tokenHint: oauthToken ? oauthToken.slice(-4) : null,
        fromEnv: !!config.oauthToken,
        // Days until the token's assumed ~1y expiry (null if unknown).
        daysLeft: tokenDaysLeft(),
        warnDays: TOKEN_WARN_DAYS,
      }),
      true
    );
  }
  if (method === 'PUT') {
    const body = await readJson(req);
    if (typeof body.oauthToken !== 'string') {
      return (sendJson(res, 400, { error: 'oauthToken (string) required' }), true);
    }
    const next = updateSettings({ oauthToken: body.oauthToken });
    logEvent({
      category: 'settings',
      action: next.oauthToken ? 'settings.token.set' : 'settings.token.clear',
      message: next.oauthToken
        ? 'Claude OAuth token updated'
        : 'Claude OAuth token cleared (falls back to env)',
      actor: opActor(req),
    });
    return (sendJson(res, 200, { hasToken: !!next.oauthToken }), true);
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

/** Per-provider credentials beyond the headline Anthropic OAuth token (which
 *  lives at /api/settings). Currently: OpenCode Go. Keys are secrets — returned
 *  only as a presence flag + last-4 hint. PATCH accepts `opencodeGo.apiKey` and
 *  the gateway syncs it onto each opencodeGo-provider agent's disk so the
 *  in-agent proxy can read it (and changes propagate without a recreate). */
async function handleProviders(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  if (method === 'GET') {
    const key = getSettings().providers?.opencodeGo?.apiKey ?? '';
    return (
      sendJson(res, 200, {
        opencodeGo: {
          hasKey: !!key,
          keyHint: key && key.length >= 4 ? key.slice(-4) : null,
        },
      }),
      true
    );
  }
  if (method === 'PATCH') {
    const body = await readJson(req);
    const cur = getSettings().providers ?? {};
    const next: typeof cur = { ...cur };
    if (body.opencodeGo !== undefined) {
      const raw = typeof body.opencodeGo?.apiKey === 'string' ? body.opencodeGo.apiKey.trim() : '';
      next.opencodeGo = raw ? { apiKey: raw } : undefined;
    }
    updateSettings({ providers: next });
    // Push the new (or removed) key onto every opencodeGo-provider agent's disk
    // so running agents pick it up on the next claude (re)spawn — no recreate.
    manager.writeOpencodeGoKeyAll();
    logEvent({
      category: 'settings',
      action: 'settings.provider.set',
      message: `OpenCode Go key ${next.opencodeGo ? 'updated' : 'cleared'}`,
      actor: opActor(req),
      target: 'opencodeGo',
    });
    return (sendJson(res, 200, { ok: true }), true);
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

async function handleHost(
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  if (method !== 'GET') return (sendJson(res, 405, { error: 'method not allowed' }), true);
  sendJson(res, 200, await manager.hostInfo());
  return true;
}

async function handleMetrics(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  if (method !== 'GET') return (sendJson(res, 405, { error: 'method not allowed' }), true);
  // ?hours=N picks the window the bar chart + resource history cover. Clamped
  // server-side so a bogus value just falls back to the 12h default.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const raw = url.searchParams.get('hours');
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const hours = Number.isFinite(parsed) ? parsed : undefined;
  sendJson(res, 200, await manager.metrics({ hours }));
  return true;
}

async function handleImageStatus(
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  if (method !== 'GET') return (sendJson(res, 405, { error: 'method not allowed' }), true);
  sendJson(res, 200, {
    image: config.agentImage,
    present: await manager.imagePresent(),
    building: manager.isBuilding,
  });
  return true;
}

async function handleImageBuild(
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
  // Stream build progress as plain text lines as the daemon emits them.
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'access-control-allow-origin': config.corsOrigin,
    'x-content-type-options': 'nosniff',
  });
  logEvent({
    category: 'settings',
    action: 'image.build',
    message: `agent image build started (${config.agentImage})`,
    actor: { kind: 'operator' },
  });
  try {
    await manager.buildAgentImageStreaming((line) => res.write(line));
    logEvent({
      category: 'settings',
      action: 'image.build',
      message: `agent image build complete (${config.agentImage})`,
      actor: { kind: 'operator' },
      ok: true,
    });
    res.end('\n✓ build complete\n');
  } catch (err) {
    logEvent({
      category: 'settings',
      action: 'image.build',
      level: 'error',
      message: `agent image build failed: ${err instanceof Error ? err.message : String(err)}`,
      actor: { kind: 'operator' },
      ok: false,
    });
    res.end(`\n✗ build failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return true;
}

/** Default cap on a JSON request body. Generous because the file editor sends
 *  whole text files (≤ MAX_TEXT_BYTES) as JSON; everything else is tiny. */
const MAX_JSON_BYTES = 5 * 1024 * 1024;
/** Tight cap for the unauthenticated auth endpoints — credentials are short,
 *  and an uncapped body there would be a free memory-exhaustion DoS. */
const MAX_AUTH_JSON_BYTES = 16 * 1024;

/** Read and parse a JSON request body; tolerate an empty/invalid body. Bodies
 *  over `maxBytes` abort with a 413 instead of buffering without bound. */
async function readJson(
  req: IncomingMessage,
  maxBytes: number = MAX_JSON_BYTES,
): Promise<{
  hostname?: string;
  username?: string;
  oauthToken?: string;
  paths?: string[];
  cpus?: number | null;
  memoryMb?: number | null;
  guidance?: string | null;
  timezone?: string | null;
  autoCompactPct?: number | null;
  provider?: Provider;
  opencodeGo?: { apiKey?: string };
  model?: string | null;
  type?: IntegrationType;
  credentials?: { botToken?: string };
  rules?: Partial<DiscordRules>;
  from?: string;
  to?: string;
  text?: string;
  fromId?: string;
  fromName?: string;
  path?: string;
  note?: string;
  roles?: string[];
  groups?: string[];
  name?: string;
  description?: string;
  permissions?: string[];
  desktop?: boolean;
  enabled?: boolean;
  action?: string;
  group?: string;
  avatarSeed?: string;
  content?: string;
  password?: string;
  currentPassword?: string;
  newPassword?: string;
  sizeMb?: number;
  volumes?: string[];
}> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) {
      // Pause (don't destroy) the stream: req and res share the socket, so a
      // destroy here would reset the connection before the 413 can flush —
      // surfacing as an opaque 502 at the reverse proxy. Node closes the
      // connection itself after responding to an incompletely-read request.
      req.pause();
      throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    }
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
