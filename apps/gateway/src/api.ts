import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import type { AgentManager } from './docker.js';
import { config } from './config.js';
import { getSettings, updateSettings } from './settings.js';

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
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

// /api/agents, /api/agents/:id, /api/agents/:id/(start|stop|upgrade)
const AGENT_API = /^\/api\/agents(?:\/([^/]+)(?:\/(start|stop|upgrade))?)?$/;

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
    if (pathname === '/api/image') return await handleImageStatus(res, manager, method);
    if (pathname === '/api/image/build') return await handleImageBuild(res, manager, method);
    if (pathname.startsWith('/api/agents')) return await handleAgents(req, res, manager, method);
    sendJson(res, 404, { error: 'unknown endpoint' });
  } catch (err) {
    sendJson(res, errStatus(err), { error: err instanceof Error ? err.message : String(err) });
  }
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
      const created = await manager.create({ hostname: body.hostname, username: body.username });
      return (sendJson(res, 201, created), true);
    }
  } else if (!action) {
    if (method === 'DELETE')
      return (await manager.remove(id), sendJson(res, 200, { ok: true }), true);
  } else if (action === 'upgrade') {
    if (method === 'GET') return (sendJson(res, 200, await manager.upgradeInfo(id)), true);
    if (method === 'POST') return (sendJson(res, 200, await manager.upgrade(id)), true);
  } else if (method === 'POST') {
    if (action === 'start') await manager.start(id);
    else await manager.stop(id);
    return (sendJson(res, 200, { ok: true }), true);
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
  // Default to the directory of the currently-selected credentials file.
  const path = url.searchParams.get('path') || dirname(getSettings().credentialsFile);
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
    return (sendJson(res, 200, { ...getSettings(), default: config.credentialsFile }), true);
  }
  if (method === 'PUT') {
    const body = await readJson(req);
    // Validate the host path before committing it (advisory: null = unverified).
    let valid: boolean | null = null;
    if (body.credentialsFile) valid = await manager.validateHostFile(body.credentialsFile);
    if (valid === false) {
      return (sendJson(res, 400, { error: `no file found at "${body.credentialsFile}"` }), true);
    }
    const next = updateSettings({ credentialsFile: body.credentialsFile });
    return (sendJson(res, 200, { ...next, validated: valid }), true);
  }
  sendJson(res, 405, { error: 'method not allowed' });
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
async function readJson(
  req: IncomingMessage,
): Promise<{ hostname?: string; username?: string; credentialsFile?: string }> {
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
