import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, isProvider } from './types.js';

// Provider validation is security-relevant, not cosmetic. The agent runtime
// picks a credential by provider name, and its `else` branch used to hand over
// the operator's Anthropic OAuth token — so an unvalidated provider string
// meant an agent could silently spend the wrong subscription. `create` did not
// validate at all (only `patch` did), which made that reachable.

test('every declared provider is accepted', () => {
  for (const p of PROVIDERS) assert.equal(isProvider(p), true, `${p} should be valid`);
});

test('chatgpt is a first-class provider', () => {
  assert.equal(isProvider('chatgpt'), true);
  assert.ok(PROVIDERS.includes('chatgpt'));
});

test('unknown or malformed providers are rejected', () => {
  for (const bad of ['', 'openai', 'ChatGPT', 'anthropic ', 'gpt', '../etc/passwd']) {
    assert.equal(isProvider(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('non-strings are rejected', () => {
  for (const bad of [null, undefined, 0, 1, {}, [], true]) {
    assert.equal(isProvider(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('the provider list has no duplicates', () => {
  assert.equal(new Set(PROVIDERS).size, PROVIDERS.length);
});
