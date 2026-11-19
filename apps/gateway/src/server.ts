import http from 'node:http';
import Docker from 'dockerode';
import { config } from './config.js';
import { AgentManager } from './docker.js';
import { parseAgentPath } from './router.js';
import { applyCors, fromTrustedProxy, handleApi } from './api.js';
import { isAuthed, swarmTokenMayAccess, validSwarmToken } from './auth.js';
import { proxyHttp, proxyToUpstream, relayWs } from './proxy.js';
import { logEvent, SYSTEM_ACTOR } from './audit.js';
import { isCrossSite, isPublicRequest, isUnsafeMethod } from './gate.js';

const dashboard = new URL(config.dashboardUpstream);
const dashboardHost = dashboard.hostname;
const dashboardPort = Number(dashboard.port) || (dashboard.protocol === 'https:' ? 443 : 80);

const docker = new Docker({ socketPath: config.dockerSocket });
const manager = new AgentManager(docker);

/** Baseline security headers on every response (API, proxied dashboard, agent
 *  streams). SAMEORIGIN (not DENY): the dashboard embeds agent desktops in
 *  same-origin iframes. HSTS only once we know we're on HTTPS (direct TLS or a
 *  trusted proxy's X-Forwarded-Proto) — sending it over plain HTTP is invalid. */
function applySecurityHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('referrer-policy', 'same-origin');
  const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
  // Peer check as well as TRUST_PROXY: the header only means anything when it
  // actually came from the proxy, not from a direct caller.
  const proxiedTls =
    config.trustProxy && fromTrustedProxy(req) && req.headers['x-forwarded-proto'] === 'https';
  if (encrypted || proxiedTls) {
    res.setHeader('strict-transport-security', 'max-age=15552000'); // 180 days
  }
}

/** Options for isCrossSite: a trusted proxy may have rewritten Host, and the
 *  host-run dev setup calls the gateway from the Next dev origin. */
function crossSiteOpts(req: http.IncomingMessage) {
  return {
    trustForwarded: config.trustProxy && fromTrustedProxy(req),
    allowOrigin: process.env.NODE_ENV === 'production' ? undefined : config.corsOrigin,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    applySecurityHeaders(req, res);
    // 0. Auth gate. API preflights pass (no cookie/side effects); everything else
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
    if (!authorized && !isPublicRequest(req.method ?? 'GET', url.pathname)) {
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

    // 0b. Cross-site guard. SameSite=Lax keeps other sites' requests cookie-
    //     less, but not sibling subdomains', so refuse any browser request from
    //     another site that could change state, and any cross-site request at
    //     all into the API or the agent proxy (no legitimate flow needs one).
    const method = req.method ?? 'GET';
    const sensitive = url.pathname.startsWith('/api/') || url.pathname.startsWith('/a/');
    if ((isUnsafeMethod(method) || sensitive) && isCrossSite(req.headers, crossSiteOpts(req))) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'cross-site request refused' }));
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
      // The screenshot is a preview: a stuck one must never hold a browser
      // connection open, since the dashboard polls it for every agent.
      const isShot = route.rest.startsWith('/api/screenshot');
      proxyHttp(req, res, target, route.rest + url.search, isShot ? 6_000 : undefined);
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
    // Every upgrade needs a session (browsers send the cookie on the upgrade
    // request): agent terminal/desktop streams obviously, and the dashboard's
    // own sockets too, so an anonymous caller can't open one to Next.js. Only
    // the dev server's HMR socket is public, and only under `next dev`.
    if (
      (!isAuthed(req.headers.cookie) && !isPublicRequest('GET', url.pathname)) ||
      isCrossSite(req.headers, crossSiteOpts(req))
    ) {
      socket.destroy();
      return;
    }
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
  logEvent({
    category: 'system',
    action: 'system.boot',
    message: `gateway started on :${config.port} (mode=${config.mode}, network=${config.networkName})`,
    actor: SYSTEM_ACTOR,
    meta: { port: config.port, mode: config.mode, auditTimezone: config.auditTimezone },
  });
  // Backfill the swarm token onto every agent disk so agents (incl. ones created
  // before login was enabled) can authenticate their gateway calls.
  manager.writeSwarmTokenAll();
  // Bridge connections live in memory, so reconnect active integrations for
  // already-running agents after a gateway (re)start.
  void manager.reconnectAllIntegrations();
  // Begin sampling per-agent cpu/mem into the 12h history for the dashboard.
  manager.startUsageSampling();
  // Warm the metrics cache in the background so the first dashboard load after a
  // (re)start hits a ready snapshot instead of paying the cold transcript scan.
  void manager.metrics().catch(() => {});
  // Re-mount shared volumes (loop images) — they don't survive a host reboot
  // on their own; agents' rslave binds pick the remount up live.
  void manager.ensureVolumesMounted();
});
