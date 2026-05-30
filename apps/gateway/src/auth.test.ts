import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  swarmTokenMayAccess,
  loginThrottle,
  noteLoginFailure,
  noteLoginSuccess,
  _resetLoginThrottle,
} from './auth.js';

// The swarm token is confined to the agent-facing endpoints swarm.py uses.
test('swarm token may reach the agent↔agent messaging API', () => {
  for (const p of [
    '/api/swarm/send',
    '/api/swarm/send-file',
    '/api/swarm/group-send',
    '/api/swarm/manage',
    '/api/swarm/view',
  ]) {
    assert.equal(swarmTokenMayAccess('POST', p), true, p);
  }
});

test('swarm token may read the roster and groups (GET only)', () => {
  assert.equal(swarmTokenMayAccess('GET', '/api/agents'), true);
  assert.equal(swarmTokenMayAccess('GET', '/api/groups'), true);
});

test('swarm token may NOT reach operator-only endpoints', () => {
  // Credential, cross-agent files, agent lifecycle, settings, dashboard.
  assert.equal(swarmTokenMayAccess('GET', '/api/settings/token'), false);
  assert.equal(swarmTokenMayAccess('GET', '/api/settings'), false);
  assert.equal(swarmTokenMayAccess('GET', '/api/agents/other/files'), false);
  assert.equal(swarmTokenMayAccess('POST', '/api/agents/other/files'), false);
  assert.equal(swarmTokenMayAccess('POST', '/api/agents/other/recreate'), false);
  assert.equal(swarmTokenMayAccess('POST', '/api/agents/other/stop'), false);
  assert.equal(swarmTokenMayAccess('POST', '/api/agents'), false); // create
  assert.equal(swarmTokenMayAccess('GET', '/api/metrics'), false);
});

test('swarm token cannot mutate the roster/groups (write methods blocked)', () => {
  assert.equal(swarmTokenMayAccess('POST', '/api/agents'), false);
  assert.equal(swarmTokenMayAccess('DELETE', '/api/agents'), false);
  assert.equal(swarmTokenMayAccess('POST', '/api/groups'), false);
});

// ── Login brute-force throttle ────────────────────────────────────────────────

test('login throttle: a clean IP (and a correct first try) is never blocked', () => {
  _resetLoginThrottle();
  const ip = '203.0.113.7';
  assert.equal(loginThrottle(ip).blocked, false);
  // A few misses below the free-fail threshold still must not block.
  noteLoginFailure(ip);
  noteLoginFailure(ip);
  assert.equal(loginThrottle(ip).blocked, false);
  // A success on a never-failed IP is obviously unaffected.
  noteLoginSuccess('198.51.100.1');
  assert.equal(loginThrottle('198.51.100.1').blocked, false);
});

test('login throttle: blocks after exceeding the free-fail allowance, with Retry-After', () => {
  _resetLoginThrottle();
  const ip = '203.0.113.9';
  // 5 free fails — still open.
  for (let i = 0; i < 5; i++) noteLoginFailure(ip);
  assert.equal(loginThrottle(ip).blocked, false);
  // 6th fail arms the backoff.
  noteLoginFailure(ip);
  const t = loginThrottle(ip);
  assert.equal(t.blocked, true);
  assert.ok(t.retryAfterSec > 0, 'retryAfterSec should be positive while blocked');
  assert.ok(t.retryAfterSec <= 30, `first backoff is ~30s, got ${t.retryAfterSec}`);
});

test('login throttle: a successful login clears the IP', () => {
  _resetLoginThrottle();
  const ip = '203.0.113.11';
  for (let i = 0; i < 8; i++) noteLoginFailure(ip);
  assert.equal(loginThrottle(ip).blocked, true);
  noteLoginSuccess(ip);
  assert.equal(loginThrottle(ip).blocked, false);
  assert.equal(loginThrottle(ip).retryAfterSec, 0);
});
