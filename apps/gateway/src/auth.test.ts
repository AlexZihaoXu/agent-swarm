import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swarmTokenMayAccess } from './auth.js';

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
