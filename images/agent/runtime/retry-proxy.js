'use strict';
// Retry proxy: a thin pass-through HTTP server that sits between Claude Code
// and an upstream (oc-go-cc) and retries 5xx responses + transport errors
// with exponential backoff. Streaming response bodies pipe through unchanged
// once the initial status comes back ≤499 — we never swap mid-stream.
//
// Lives in its own module so the retry/backoff logic can be unit-tested
// without booting the rest of the terminal supervisor.
//
// Behavior:
//   - Request body is buffered (Anthropic Messages requests are JSON,
//     typically a few MB at most) so the same payload can be replayed.
//   - On `response.statusCode in [500..599]`, the response body is drained
//     and the request is re-issued after `RETRY_BACKOFFS_MS[n]` ms.
//   - On `request.error` (ECONNREFUSED, ECONNRESET, EPIPE, …), same retry.
//   - After RETRY_MAX attempts, the last upstream response is forwarded
//     verbatim — caller sees the real failure, not a synthetic 502.
//     The exception is exhausted transport errors (we never got a response):
//     those map to 502 since we have no upstream response to forward.
//   - If the client disconnects (e.g., user closes the chrome tab), the
//     in-flight upstream request is aborted to free its socket.
const http = require('http');

const RETRY_MAX = 4; // initial attempt + up to 3 retries
const RETRY_BACKOFFS_MS = [500, 2000, 5000]; // gap BEFORE attempt n+1

/** Create — but do NOT start — the retry-proxy http.Server. The caller is
 *  responsible for `.listen()`-ing it. Exported separately so tests can spin
 *  up the server against ephemeral ports without going through the global
 *  startup path. */
function createRetryProxy({ upstreamHost = '127.0.0.1', upstreamPort, logger = console } = {}) {
  if (!upstreamPort) throw new Error('createRetryProxy: upstreamPort is required');

  return http.createServer((req, res) => {
    const chunks = [];
    let clientGone = false;
    res.on('close', () => {
      clientGone = true;
    });
    req.on('aborted', () => {
      clientGone = true;
    });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);

      const attempt = (n) => {
        if (clientGone) return;
        const headers = { ...req.headers };
        delete headers['content-length']; // we set our own based on the buffered body
        headers['host'] = `${upstreamHost}:${upstreamPort}`;
        headers['content-length'] = body.length;

        const upstream = http.request(
          {
            host: upstreamHost,
            port: upstreamPort,
            path: req.url,
            method: req.method,
            headers,
          },
          (resp) => {
            const transient = resp.statusCode >= 500 && resp.statusCode < 600;
            const canRetry = transient && n + 1 < RETRY_MAX;
            if (canRetry) {
              const wait = RETRY_BACKOFFS_MS[n] ?? RETRY_BACKOFFS_MS[RETRY_BACKOFFS_MS.length - 1];
              logger.warn(
                `[retry-proxy] ${req.method} ${req.url} → ${resp.statusCode} ` +
                  `(attempt ${n + 1}/${RETRY_MAX}); retrying in ${wait}ms`,
              );
              resp.resume(); // drain so the socket can be reused / closed cleanly
              setTimeout(() => attempt(n + 1), wait);
              return;
            }
            // Forward (possibly streaming) response to the client unchanged.
            res.writeHead(resp.statusCode, resp.headers);
            resp.pipe(res);
          },
        );
        upstream.on('error', (e) => {
          const canRetry = n + 1 < RETRY_MAX;
          if (canRetry) {
            const wait = RETRY_BACKOFFS_MS[n] ?? RETRY_BACKOFFS_MS[RETRY_BACKOFFS_MS.length - 1];
            logger.warn(
              `[retry-proxy] ${req.method} ${req.url} transport error ` +
                `(${e.code || e.message}) attempt ${n + 1}/${RETRY_MAX}; retrying in ${wait}ms`,
            );
            setTimeout(() => attempt(n + 1), wait);
          } else if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                type: 'error',
                error: {
                  type: 'api_error',
                  message:
                    `retry-proxy: upstream unreachable after ${RETRY_MAX} attempts ` +
                    `(${e.code || e.message})`,
                },
              }),
            );
          }
        });
        res.on('close', () => upstream.destroy());
        upstream.end(body);
      };

      attempt(0);
    });
  });
}

module.exports = { createRetryProxy, RETRY_MAX, RETRY_BACKOFFS_MS };
