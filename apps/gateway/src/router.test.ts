import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentPath } from './router.js';

test('parses a service root path', () => {
  assert.deepEqual(parseAgentPath('/a/abc/desktop'), {
    id: 'abc',
    service: 'desktop',
    rest: '/',
  });
});

test('parses a path with a rest segment (WS endpoint)', () => {
  assert.deepEqual(parseAgentPath('/a/abc/terminal/ws'), {
    id: 'abc',
    service: 'terminal',
    rest: '/ws',
  });
});

test('parses a deeply nested asset path', () => {
  assert.deepEqual(parseAgentPath('/a/x1/desktop/core/rfb.js'), {
    id: 'x1',
    service: 'desktop',
    rest: '/core/rfb.js',
  });
});

test('decodes a percent-encoded id', () => {
  assert.deepEqual(parseAgentPath('/a/my%2Dagent/terminal'), {
    id: 'my-agent',
    service: 'terminal',
    rest: '/',
  });
});

test('returns null for non-agent paths', () => {
  assert.equal(parseAgentPath('/'), null);
  assert.equal(parseAgentPath('/api/agents'), null);
  assert.equal(parseAgentPath('/a/abc'), null);
  assert.equal(parseAgentPath('/a/abc/unknown'), null);
});

test('rejects ids that try to traverse out of the namespace', () => {
  assert.equal(parseAgentPath('/a/..%2f/desktop'), null); // decodes to "../"
  assert.equal(parseAgentPath('/a/../desktop'), null);
});
