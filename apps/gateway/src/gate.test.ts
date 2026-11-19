import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicRequest } from './gate.js';

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
