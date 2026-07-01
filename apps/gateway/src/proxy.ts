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

proxy.on('error', (err, _req, res) => {
  if ('writeHead' in res && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`proxy error: ${err.message}`);
  } else if ('destroy' in res) {
    res.destroy();
  }
});

/** Forward an HTTP request to `target`, rewriting the path to `rest`. */
export function proxyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  target: ProxyTarget,
  rest: string,
): void {
  req.url = rest;
  proxy.web(req, res, { target: `http://${target.host}:${target.port}` });
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
    for (let i = 0; i < h.length; i += 2) lines.push(`${h[i]}: ${h[i + 1]}`);
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
