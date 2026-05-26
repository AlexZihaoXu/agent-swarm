import http from 'node:http';
import Docker from 'dockerode';
import { config } from './config.js';
import { AgentManager } from './docker.js';
import { parseAgentPath } from './router.js';
import { applyCors, handleApi } from './api.js';
import { proxyHttp, proxyToUpstream, relayWs } from './proxy.js';

const dashboard = new URL(config.dashboardUpstream);
const dashboardHost = dashboard.hostname;
const dashboardPort = Number(dashboard.port) || (dashboard.protocol === 'https:' ? 443 : 80);

const docker = new Docker({ socketPath: config.dockerSocket });
const manager = new AgentManager(docker);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
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
});
