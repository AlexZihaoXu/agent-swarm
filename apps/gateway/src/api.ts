import { createReadStream, createWriteStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename } from 'node:path';
import type { AgentManager } from './docker.js';
import { config } from './config.js';
import { getSettings, updateSettings, tokenDaysLeft, TOKEN_WARN_DAYS } from './settings.js';
import { CAPABILITIES, listRoles, createRole, updateRole, deleteRole } from './roles.js';
import { listGroups, createGroup, updateGroup, deleteGroup } from './groups.js';
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

// /api/agents, /api/agents/:id, /api/agents/:id/(start|stop|upgrade|paths|package)
const AGENT_API = /^\/api\/agents(?:\/([^/]+)(?:\/(start|stop|upgrade|paths|package))?)?$/;
// /api/agents/:id/integrations[/:type[/(test|apply|disable)]]
const INTEGRATION_API =
  /^\/api\/agents\/([^/]+)\/integrations(?:\/([^/]+)(?:\/(test|apply|disable))?)?$/;
// /api/packages, /api/packages/upload, /api/packages/:file[/(download|import)]
const PACKAGE_API = /^\/api\/packages(?:\/([^/]+)(?:\/(download|import))?)?$/;
// /api/roles, /api/roles/:id  •  /api/groups, /api/groups/:id
const ROLE_API = /^\/api\/roles(?:\/([^/]+))?$/;
const GROUP_API = /^\/api\/groups(?:\/([^/]+))?$/;

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
    if (pathname === '/api/fs') return await handleFs(req, res, manager, method);
    if (pathname === '/api/settings') return await handleSettings(req, res, manager, method);
    if (pathname === '/api/host') return await handleHost(res, manager, method);
    if (pathname === '/api/metrics') return await handleMetrics(res, manager, method);
    if (pathname.startsWith('/api/roles')) return await handleRoles(req, res, manager, method);
    if (pathname.startsWith('/api/groups')) return await handleGroups(req, res, method);
    if (pathname === '/api/usage') {
      if (method !== 'GET') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      return (sendJson(res, 200, await manager.usageSnapshot()), true);
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
      return (sendJson(res, 200, { ok: true, agent }), true);
    }
    if (pathname === '/api/swarm/view') {
      if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      const body = await readJson(req);
      const savedPath = await manager.viewAgent(body.fromId ?? '', body.to ?? '');
      return (sendJson(res, 200, { ok: true, path: savedPath }), true);
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
    if (INTEGRATION_API.test(pathname)) return await handleIntegrations(req, res, manager, method);
    if (pathname.startsWith('/api/agents')) return await handleAgents(req, res, manager, method);
    sendJson(res, 404, { error: 'unknown endpoint' });
  } catch (err) {
    sendJson(res, errStatus(err), { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
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
      return (
        sendJson(res, 201, manager.addIntegration(id, (body.type ?? 'discord') as IntegrationType)),
        true
      );
    }
  } else if (!op) {
    if (method === 'PATCH') {
      const body = await readJson(req);
      const patched = manager.updateIntegration(id, type as IntegrationType, {
        credentials: body.credentials,
        rules: body.rules,
      });
      return (sendJson(res, 200, patched), true);
    }
    if (method === 'DELETE')
      return (
        await manager.removeIntegration(id, type as IntegrationType),
        sendJson(res, 200, { ok: true }),
        true
      );
  } else if (method === 'POST') {
    const t = type as IntegrationType;
    if (op === 'test') return (sendJson(res, 200, await manager.testIntegration(id, t)), true);
    if (op === 'apply') return (sendJson(res, 200, await manager.applyIntegration(id, t)), true);
    if (op === 'disable')
      return (sendJson(res, 200, await manager.disableIntegration(id, t)), true);
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
      return (
        sendJson(
          res,
          201,
          createRole(body.name ?? '', body.description ?? '', Date.now(), body.permissions),
        ),
        true
      );
    }
  } else if (method === 'PATCH') {
    const body = await readJson(req);
    const role = updateRole(id, {
      name: body.name,
      description: body.description,
      permissions: body.permissions,
    });
    await manager.refreshAgentsWithRole(id);
    return (sendJson(res, 200, role), true);
  } else if (method === 'DELETE') {
    deleteRole(id);
    await manager.refreshAgentsWithRole(id); // they no longer hold it → doc cleared
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
  method: string,
): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const id = GROUP_API.exec(pathname)?.[1];
  if (!id) {
    if (method === 'GET') return (sendJson(res, 200, listGroups()), true);
    if (method === 'POST') {
      const body = await readJson(req);
      return (
        sendJson(res, 201, createGroup(body.name ?? '', body.description ?? '', Date.now())),
        true
      );
    }
  } else if (method === 'PATCH') {
    const body = await readJson(req);
    return (
      sendJson(res, 200, updateGroup(id, { name: body.name, description: body.description })),
      true
    );
  } else if (method === 'DELETE') {
    return (deleteGroup(id), sendJson(res, 200, { ok: true }), true);
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
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
        cpus: body.cpus,
        memoryMb: body.memoryMb,
        timezone: body.timezone,
        model: body.model ?? undefined,
        roles: body.roles,
        groups: body.groups,
      });
      return (sendJson(res, 201, created), true);
    }
  } else if (!action) {
    if (method === 'GET') return (sendJson(res, 200, await manager.getAgent(id)), true);
    if (method === 'DELETE')
      return (await manager.remove(id), sendJson(res, 200, { ok: true }), true);
    if (method === 'PATCH') {
      const body = await readJson(req);
      const patch: {
        username?: string;
        autoCompactPct?: number | null;
        model?: string | null;
        roles?: string[];
        groups?: string[];
      } = {};
      if (body.username !== undefined) patch.username = body.username;
      if (body.autoCompactPct !== undefined) patch.autoCompactPct = body.autoCompactPct;
      if (body.model !== undefined) patch.model = body.model;
      if (body.roles !== undefined) patch.roles = body.roles;
      if (body.groups !== undefined) patch.groups = body.groups;
      return (sendJson(res, 200, await manager.patchAgent(id, patch)), true);
    }
  } else if (action === 'upgrade') {
    if (method === 'GET') return (sendJson(res, 200, await manager.upgradeInfo(id)), true);
    if (method === 'POST') return (sendJson(res, 200, await manager.upgrade(id)), true);
  } else if (action === 'paths') {
    if (method === 'GET') return (sendJson(res, 200, manager.listAgentPaths(id)), true);
  } else if (action === 'package') {
    if (method === 'POST') {
      const body = await readJson(req);
      const result = await manager.packageAgent(id, Array.isArray(body.paths) ? body.paths : []);
      return (sendJson(res, 200, result), true);
    }
  } else if (method === 'POST') {
    if (action === 'start') await manager.start(id);
    else await manager.stop(id);
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
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(dest);
      req.pipe(out);
      out.on('finish', () => resolve());
      out.on('error', reject);
    });
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
    return (sendJson(res, 200, { hasToken: !!next.oauthToken }), true);
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
  res: ServerResponse,
  manager: AgentManager,
  method: string,
): Promise<boolean> {
  if (method !== 'GET') return (sendJson(res, 405, { error: 'method not allowed' }), true);
  sendJson(res, 200, await manager.metrics());
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
  try {
    await manager.buildAgentImageStreaming((line) => res.write(line));
    res.end('\n✓ build complete\n');
  } catch (err) {
    res.end(`\n✗ build failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return true;
}

/** Read and parse a JSON request body; tolerate an empty/invalid body. */
async function readJson(req: IncomingMessage): Promise<{
  hostname?: string;
  username?: string;
  oauthToken?: string;
  paths?: string[];
  cpus?: number;
  memoryMb?: number;
  timezone?: string;
  autoCompactPct?: number | null;
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
  action?: string;
}> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
