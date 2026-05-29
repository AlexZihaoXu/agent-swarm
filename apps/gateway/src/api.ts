import { createReadStream, createWriteStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename } from 'node:path';
import type { AgentManager } from './docker.js';
import { config } from './config.js';
import { getSettings, updateSettings } from './settings.js';
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
    if (pathname === '/api/swarm/send') {
      if (method !== 'POST') return (sendJson(res, 405, { error: 'method not allowed' }), true);
      const body = await readJson(req);
      await manager.sendSwarmMessage(body.from ?? '', body.to ?? '', body.text ?? '');
      return (sendJson(res, 200, { ok: true }), true);
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
      });
      return (sendJson(res, 201, created), true);
    }
  } else if (!action) {
    if (method === 'GET') return (sendJson(res, 200, await manager.getAgent(id)), true);
    if (method === 'DELETE')
      return (await manager.remove(id), sendJson(res, 200, { ok: true }), true);
    if (method === 'PATCH') {
      const body = await readJson(req);
      const patch: { username?: string; autoCompactPct?: number | null } = {};
      if (body.username !== undefined) patch.username = body.username;
      if (body.autoCompactPct !== undefined) patch.autoCompactPct = body.autoCompactPct;
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
  type?: IntegrationType;
  credentials?: { botToken?: string };
  rules?: Partial<DiscordRules>;
  from?: string;
  to?: string;
  text?: string;
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
