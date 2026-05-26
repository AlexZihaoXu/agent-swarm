import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentManager } from './docker.js';
import { config } from './config.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': config.corsOrigin,
  });
  res.end(payload);
}

/** Apply permissive CORS for the dashboard origin; answer preflight directly. */
export function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  res.setHeader('access-control-allow-origin', config.corsOrigin);
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

// /api/agents, /api/agents/:id, /api/agents/:id/(start|stop)
const AGENT_API = /^\/api\/agents(?:\/([^/]+)(?:\/(start|stop))?)?$/;

/**
 * Handle the agents REST API. Returns true if the request was an /api/* route
 * (and has been answered), false to let the caller fall through to the proxy.
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AgentManager,
): Promise<boolean> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (!pathname.startsWith('/api/')) return false;

  const m = AGENT_API.exec(pathname);
  if (!m) {
    sendJson(res, 404, { error: 'unknown endpoint' });
    return true;
  }
  const [, id, action] = m;
  const method = req.method ?? 'GET';

  try {
    if (!id) {
      if (method === 'GET') return (void sendJson(res, 200, await manager.list()), true);
      if (method === 'POST') {
        const body = await readJson(req);
        const created = await manager.create({ hostname: body.hostname, username: body.username });
        return (void sendJson(res, 201, created), true);
      }
    } else if (!action) {
      if (method === 'DELETE') {
        await manager.remove(id);
        return (void sendJson(res, 200, { ok: true }), true);
      }
    } else if (method === 'POST') {
      if (action === 'start') await manager.start(id);
      else await manager.stop(id);
      return (void sendJson(res, 200, { ok: true }), true);
    }
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    // Docker reports a name clash as 409; our validation tags 400.
    const status = (err as { statusCode?: number })?.statusCode ?? 500;
    sendJson(res, status === 409 ? 409 : status >= 400 && status < 500 ? status : 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

/** Read and parse a JSON request body; tolerate an empty/invalid body. */
async function readJson(req: IncomingMessage): Promise<{ hostname?: string; username?: string }> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as { hostname?: string; username?: string };
  } catch {
    return {};
  }
}
