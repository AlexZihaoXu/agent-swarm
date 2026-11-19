// The agent desktop viewer (noVNC), served by the gateway from its own bundled
// copy instead of being proxied from the agent.
//
// Everything under /a/:id/* is same-origin with the dashboard. An agent is
// root in its own container, so if the viewer page came from the agent, any
// agent (say, one steered by a prompt injection) could replace it and run
// script in the dashboard's origin whenever the operator opened its desktop,
// with the operator's session. Only the VNC WebSocket (`websockify`) is
// relayed to the agent; the HTML and JavaScript that handle it are ours.
import { createReadStream, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, normalize, sep } from 'node:path';
import { config } from './config.js';

const require = createRequire(import.meta.url);
/** noVNC's ES-module sources (core/ + vendor/), the same release the agent
 *  image ships (Ubuntu 24.04's novnc 1.3.0). */
const novncRoot = dirname(require.resolve('@novnc/novnc/package.json'));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/** Map a desktop path (the part after /a/:id/desktop) to a bundled file, or
 *  null when it isn't part of the viewer. */
export function desktopAsset(rest: string): string | null {
  const path = rest.split('?')[0] ?? '/';
  if (path === '/' || path === '/index.html')
    return join(config.agentContextDir, 'novnc-index.html');
  const rel = normalize(path).replace(/^[/\\]+/, '');
  if (!rel.startsWith(`core${sep}`) && !rel.startsWith(`vendor${sep}`)) return null;
  const abs = join(novncRoot, rel);
  return abs.startsWith(novncRoot + sep) ? abs : null;
}

/** Answer a non-WebSocket desktop request from the bundled viewer. */
export function serveDesktop(method: string, rest: string, res: ServerResponse): void {
  const file = method === 'GET' || method === 'HEAD' ? desktopAsset(rest) : null;
  let size = -1;
  try {
    if (file && statSync(file).isFile()) size = statSync(file).size;
  } catch {
    /* missing → 404 below */
  }
  if (!file || size < 0) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const ext = file.slice(file.lastIndexOf('.'));
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': 'no-cache',
  });
  if (method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}
