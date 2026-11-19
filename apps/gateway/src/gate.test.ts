import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCrossSite, isPublicRequest } from './gate.js';

test('the login page and its static assets are public for GET/HEAD', () => {
  for (const p of ['/login', '/_next/static/chunks/app.js', '/sw.js', '/manifest.webmanifest'])
    assert.equal(isPublicRequest('GET', p, false), true, p);
  assert.equal(isPublicRequest('HEAD', '/login', false), true);
});

test('the auth API is public for any method', () => {
  assert.equal(isPublicRequest('POST', '/api/auth/login', false), true);
  assert.equal(isPublicRequest('GET', '/api/auth/status', false), true);
});

test('no request with a body reaches Next.js anonymously', () => {
  // Server-action probes POST to a public page with a Next-Action header.
  assert.equal(isPublicRequest('POST', '/login', false), false);
  assert.equal(isPublicRequest('PUT', '/_next/static/x.js', false), false);
});

test('other Next.js routes need a session in production', () => {
  for (const p of ['/_next/image', '/_next/data/build/index.json', '/__nextjs_source', '/'])
    assert.equal(isPublicRequest('GET', p, false), false, p);
  // ...but the dev server's internals stay reachable under `next dev`.
  assert.equal(isPublicRequest('GET', '/_next/webpack-hmr', true), true);
});

test('preflights pass only for the API, never into the agent proxy', () => {
  assert.equal(isPublicRequest('OPTIONS', '/api/agents', false), true);
  assert.equal(isPublicRequest('OPTIONS', '/a/x/terminal/api/inject', false), false);
  assert.equal(isPublicRequest('OPTIONS', '/login', false), false);
});

test('fetch metadata decides when present', () => {
  assert.equal(isCrossSite({ 'sec-fetch-site': 'same-origin' }), false);
  assert.equal(isCrossSite({ 'sec-fetch-site': 'none' }), false); // typed URL / bookmark
  // A sibling subdomain is same-site, and SameSite=Lax would send the cookie.
  assert.equal(
    isCrossSite({ 'sec-fetch-site': 'same-site', origin: 'https://x.example.com' }),
    true,
  );
  assert.equal(isCrossSite({ 'sec-fetch-site': 'cross-site' }), true);
});

test('falls back to Origin against Host, then passes non-browser clients', () => {
  const host = 'dash.example.com';
  assert.equal(isCrossSite({ origin: `https://${host}`, host }), false);
  assert.equal(isCrossSite({ origin: 'https://evil.example.com', host }), true);
  assert.equal(isCrossSite({ origin: 'null', host }), true); // sandboxed / opaque
  assert.equal(isCrossSite({ host }), false); // agents' swarm calls, curl
});

test('a forwarded host counts only from a trusted proxy', () => {
  const h = {
    origin: 'https://dash.example.com',
    host: '10.0.0.2:8080',
    'x-forwarded-host': 'dash.example.com',
  };
  assert.equal(isCrossSite(h), true);
  assert.equal(isCrossSite(h, { trustForwarded: true }), false);
});

test('the configured dev origin is allowed explicitly', () => {
  const h = { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' };
  assert.equal(isCrossSite(h, { allowOrigin: 'http://localhost:3000' }), false);
});
