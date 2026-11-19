import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import net from 'node:net';
import httpProxy from 'http-proxy';
import type { ProxyTarget } from './types.js';

// http-proxy handles ordinary HTTP fine. We deliberately do NOT use it for
// WebSocket upgrades: it rewrites the 101 response and drops
// `Sec-WebSocket-Protocol`, which makes browsers (noVNC requests the `binary`
// subprotocol) silently fail the socket. WS upgrades use a raw TCP relay below
// so the upstream's 101 — subprotocol header included — is forwarded verbatim.
const proxy = httpProxy.createProxyServer({ xfwd: true });

/** Requests headed for an agent container (see proxyHttp). */
const toAgent = new WeakSet<IncomingMessage>();

/** Request headers never forwarded to an agent. The operator's session cookie
 *  is the key to the whole control plane (and, through the Docker socket, the
 *  host); an agent is root in its own container and could log it. */
const AGENT_STRIPPED = new Set(['cookie', 'authorization']);

// Agent responses: an agent must not be able to set cookies on the dashboard's
// origin, and anything it serves that a browser would render as a page gets an
// opaque origin with no script, so it can't act as the operator. The dashboard
// only fetch()es JSON/images from agents, which CSP doesn't affect.
proxy.on('proxyRes', (proxyRes, req) => {
  if (!toAgent.has(req)) return;
  delete proxyRes.headers['set-cookie'];
  proxyRes.headers['content-security-policy'] = "sandbox; default-src 'none'";
  proxyRes.headers['x-content-type-options'] = 'nosniff';
});

proxy.on('error', (err, _req, res) => {
  if ('writeHead' in res && !res.headersSent) {
    // ETIMEDOUT/ECONNRESET from a wedged upstream is a gateway timeout, not a
    // bad gateway — 504 lets the caller tell "agent is sick" from "no route".
    const timedOut = /ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET/.test(err.message);
    res.writeHead(timedOut ? 504 : 502, { 'content-type': 'text/plain' });
    res.end(`proxy error: ${err.message}`);
  } else if ('destroy' in res) {
    res.destroy();
  }
});

/**
 * Forward an HTTP request to an agent `target`, rewriting the path to `rest`.
 * Credentials are stripped on the way in and cookies/rendering on the way out
 * (see AGENT_STRIPPED and the proxyRes hook above).
 *
 * `timeoutMs` bounds how long we'll wait on the upstream. It matters most for
 * the screenshot endpoint: an agent whose X server has wedged never answers at
 * all, and because the dashboard refreshes previews every 2.5s, a handful of
 * those exhausts the browser's ~6-connections-per-origin budget — so healthy
 * agents' previews stop loading too and the whole fleet reads as "connecting…".
 * Failing fast keeps one sick agent from taking the dashboard down with it.
 */
export function proxyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  target: ProxyTarget,
  rest: string,
  timeoutMs?: number,
): void {
  req.url = rest;
  for (const h of AGENT_STRIPPED) delete req.headers[h];
  toAgent.add(req);
  proxy.web(req, res, {
    target: `http://${target.host}:${target.port}`,
    ...(timeoutMs ? { proxyTimeout: timeoutMs, timeout: timeoutMs } : {}),
  });
}

/** Forward an HTTP request to the dashboard upstream unchanged (URL preserved). */
export function proxyToUpstream(req: IncomingMessage, res: ServerResponse, upstream: string): void {
  proxy.web(req, res, { target: upstream });
}

/**
 * Raw TCP relay for a WebSocket upgrade: open a socket to host:port, replay the
 * upgrade request with its path rewritten to `path`, then pipe both ways. The
 * upstream's 101 (and `Sec-WebSocket-Protocol`) passes through untouched.
 */
export function relayWs(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  host: string,
  port: number,
  path: string,
  opts: { toAgent?: boolean } = {},
): void {
  const upstream = net.connect(port, host, () => {
    // Terminal keystrokes (up) and cursor/redraw deltas (down) are tiny, latency-
    // sensitive writes. Disable Nagle on both legs so they aren't held ~40ms
    // waiting to coalesce — that delay is what makes the console feel laggy. Also
    // helps noVNC input. setNoDelay exists on both sockets (clientSocket is the
    // upgrade's TCP socket); guard defensively in case a non-TCP duplex appears.
    upstream.setNoDelay(true);
    (clientSocket as Partial<net.Socket>).setNoDelay?.(true);
    const lines = [`${req.method ?? 'GET'} ${path} HTTP/1.1`];
    const h = req.rawHeaders;
    for (let i = 0; i < h.length; i += 2) {
      if (opts.toAgent && AGENT_STRIPPED.has(h[i]!.toLowerCase())) continue;
      lines.push(`${h[i]}: ${h[i + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const bail = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on('error', bail);
  clientSocket.on('error', bail);
}
