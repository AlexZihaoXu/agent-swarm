import http from 'node:http';
import Docker from 'dockerode';
import { config } from './config.js';
import { AgentManager } from './docker.js';
import { parseAgentPath } from './router.js';
import { applyCors, handleApi } from './api.js';
import { isAuthed, swarmTokenMayAccess, validSwarmToken } from './auth.js';
import { proxyHttp, proxyToUpstream, relayWs } from './proxy.js';

/** Paths reachable without a session: the login page + its assets, the auth API,
 *  and CORS preflights. Everything else (dashboard, API, agent proxy) is gated. */
function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/__next') || // Next dev internals
    pathname === '/favicon.ico' ||
    // PWA assets must load without a session (install + service worker + icon).
    pathname === '/manifest.webmanifest' ||
    pathname === '/sw.js' ||
    pathname === '/icon.svg'
  );
}

const dashboard = new URL(config.dashboardUpstream);
const dashboardHost = dashboard.hostname;
const dashboardPort = Number(dashboard.port) || (dashboard.protocol === 'https:' ? 443 : 80);

const docker = new Docker({ socketPath: config.dockerSocket });
const manager = new AgentManager(docker);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    // 0. Auth gate. Preflights pass (no cookie/side effects); everything else
    //    that isn't public needs either a valid operator session (browser) or a
    //    valid swarm token (agents' machine-to-machine /api/swarm/* calls). The
    //    operator session grants full access; the swarm token is confined to the
    //    agent-facing endpoints (swarmTokenMayAccess) so it can't be reused to
    //    reach operator-only APIs. API/agent routes get 401/403; page requests
    //    redirect to the login screen.
    const byCookie = isAuthed(req.headers.cookie);
    const byToken = !byCookie && validSwarmToken(req.headers['x-swarm-token']);
    const authorized =
      byCookie || (byToken && swarmTokenMayAccess(req.method ?? 'GET', url.pathname));
    if (req.method !== 'OPTIONS' && !isPublicPath(url.pathname) && !authorized) {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/a/')) {
        // A valid-but-out-of-scope swarm token is forbidden (403), not 401.
        res.writeHead(byToken ? 403 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: byToken ? 'forbidden' : 'unauthorized' }));
      } else {
        res.writeHead(302, { location: '/login' });
        res.end();
      }
      return;
    }

    // 1. Lifecycle API.
    if (url.pathname.startsWith('/api/')) {
      if (applyCors(req, res)) return;
      if (await handleApi(req, res, manager)) return;
    }

    // 2. Per-agent proxy: /a/:id/(desktop|terminal)/* → the agent container.
    //    Preserve the query string (the terminal WS needs ?session=&cols=&rows=).
    const route = parseAgentPath(url.pathname);
    if (route) {
      const target = await manager.resolveTarget(route.id, route.service);
      proxyHttp(req, res, target, route.rest + url.search);
      return;
    }

    // 3. Everything else is the dashboard UI.
    proxyToUpstream(req, res, config.dashboardUpstream);
  } catch (err) {
    const status = isNotFound(err) ? 404 : 502;
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(`gateway error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

/** dockerode surfaces a missing container as an Engine 404. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode === 404
  );
}

// WebSocket upgrades: agent streams (noVNC, terminal) or the dashboard's HMR.
server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = parseAgentPath(url.pathname);
    if (route) {
      // Agent terminal/desktop streams are sensitive — require a valid session
      // (browsers send the cookie on the upgrade request).
      if (!isAuthed(req.headers.cookie)) {
        socket.destroy();
        return;
      }
      const target = await manager.resolveTarget(route.id, route.service);
      relayWs(req, socket, head, target.host, target.port, route.rest + url.search);
      return;
    }
    // Dashboard HMR socket (Next.js dev) and anything else → the dashboard.
    relayWs(req, socket, head, dashboardHost, dashboardPort, req.url ?? '/');
  } catch {
    socket.destroy();
  }
});

server.listen(config.port, () => {
  console.log(
    `gateway on :${config.port} — mode=${config.mode}, network=${config.networkName}, ` +
      `dashboard=${config.dashboardUpstream}`,
  );
  // Backfill the swarm token onto every agent disk so agents (incl. ones created
  // before login was enabled) can authenticate their gateway calls.
  manager.writeSwarmTokenAll();
  // Bridge connections live in memory, so reconnect active integrations for
  // already-running agents after a gateway (re)start.
  void manager.reconnectAllIntegrations();
  // Begin sampling per-agent cpu/mem into the 12h history for the dashboard.
  manager.startUsageSampling();
  // Re-mount shared volumes (loop images) — they don't survive a host reboot
  // on their own; agents' rslave binds pick the remount up live.
  void manager.ensureVolumesMounted();
});
