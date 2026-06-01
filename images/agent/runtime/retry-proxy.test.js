'use strict';
// Integration tests for the retry-proxy: spin up a synthetic upstream HTTP
// server that returns scripted responses, point the proxy at it, drive
// requests, and assert the right number of retries + final outcome.
//
// Run with `node --test images/agent/runtime/retry-proxy.test.js`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRetryProxy } = require('./retry-proxy');

const silentLogger = { warn: () => {}, error: () => {}, log: () => {} };

/** Spin up an upstream that returns each scripted response in sequence. Each
 *  entry is `{ status, body? }` for a normal response, or `{ drop: true }` to
 *  hard-close the socket without responding (simulating a transport error). */
function scriptedUpstream(script) {
  let i = 0;
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    const step = script[Math.min(i++, script.length - 1)];
    if (step.drop) {
      res.socket.destroy();
      return;
    }
    res.writeHead(step.status, { 'content-type': 'text/plain' });
    res.end(step.body ?? `step-${i}`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, hits: () => hits, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function startProxy(upstreamPort) {
  const proxy = createRetryProxy({ upstreamPort, logger: silentLogger });
  return new Promise((resolve) => {
    proxy.listen(0, '127.0.0.1', () => {
      resolve({
        port: proxy.address().port,
        close: () => new Promise((r) => proxy.close(r)),
      });
    });
  });
}

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () =>
          resolve({ status: resp.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('passes a 200 response through verbatim, no retries', async () => {
  const upstream = await scriptedUpstream([{ status: 200, body: 'ok' }]);
  const proxy = await startProxy(upstream.port);
  try {
    const r = await postJson(proxy.port, '/v1/messages', { hello: 'world' });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'ok');
    assert.equal(upstream.hits(), 1, 'no retries on a clean 200');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('retries a 502 and forwards the eventual 200', async () => {
  const upstream = await scriptedUpstream([
    { status: 502, body: 'all models failed' },
    { status: 200, body: 'recovered' },
  ]);
  const proxy = await startProxy(upstream.port);
  try {
    const r = await postJson(proxy.port, '/v1/messages', { hello: 'world' });
    assert.equal(r.status, 200, 'final response should be the 200');
    assert.equal(r.body, 'recovered');
    assert.equal(upstream.hits(), 2, 'one retry after the initial 502');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('retries 5xx up to RETRY_MAX times then surfaces the last response', async () => {
  // Upstream returns 502 forever; proxy attempts 4 times (initial + 3 retries)
  // then forwards the last 502 verbatim.
  const upstream = await scriptedUpstream([{ status: 502, body: 'still down' }]);
  const proxy = await startProxy(upstream.port);
  try {
    const r = await postJson(proxy.port, '/v1/messages', { hello: 'world' });
    assert.equal(r.status, 502, 'persistent failure surfaces real upstream status');
    assert.equal(r.body, 'still down');
    assert.equal(upstream.hits(), 4, 'should attempt 4 times before giving up');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('does NOT retry on 4xx (client error)', async () => {
  const upstream = await scriptedUpstream([{ status: 401, body: 'unauthorized' }]);
  const proxy = await startProxy(upstream.port);
  try {
    const r = await postJson(proxy.port, '/v1/messages', {});
    assert.equal(r.status, 401);
    assert.equal(upstream.hits(), 1, "4xx is the client's problem — no retries");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('retries transport errors (upstream drops the socket)', async () => {
  const upstream = await scriptedUpstream([
    { drop: true },
    { drop: true },
    { status: 200, body: 'after-drops' },
  ]);
  const proxy = await startProxy(upstream.port);
  try {
    const r = await postJson(proxy.port, '/v1/messages', {});
    assert.equal(r.status, 200);
    assert.equal(r.body, 'after-drops');
    assert.equal(upstream.hits(), 3, 'two transport failures then success');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('synthesizes a 502 only when ALL transport attempts fail (never got a response)', async () => {
  // Point the proxy at a port that nothing is listening on. Every attempt
  // hits ECONNREFUSED. After RETRY_MAX, the proxy must synthesize a 502
  // (there's no upstream response to forward).
  const proxy = await startProxy(1); // privileged port, nothing there as agent user
  try {
    const r = await postJson(proxy.port, '/v1/messages', {});
    assert.equal(r.status, 502);
    const parsed = JSON.parse(r.body);
    assert.equal(parsed.type, 'error');
    assert.match(parsed.error.message, /upstream unreachable after/);
  } finally {
    await proxy.close();
  }
});
