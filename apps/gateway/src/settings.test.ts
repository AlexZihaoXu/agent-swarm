import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIp, validateIpNames } from './settings.js';

// The known-IP map is only useful if a name set for one spelling of an address
// still matches when the same peer arrives spelled differently — Node hands us
// v4-mapped v6 on dual-stack sockets, and proxies can append a source port.
// These are pure functions; getSettings()'s module cache is deliberately not
// exercised here.

test('normalizeIp folds v4-mapped v6 to the plain v4 literal', () => {
  assert.equal(normalizeIp('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeIp('::FFFF:192.168.1.5'), '192.168.1.5');
});

test('normalizeIp strips a port from a dotted quad', () => {
  assert.equal(normalizeIp('203.0.113.7:54321'), '203.0.113.7');
  assert.equal(normalizeIp('203.0.113.7'), '203.0.113.7');
});

test('normalizeIp unwraps a bracketed v6 literal, with or without a port', () => {
  assert.equal(normalizeIp('[::1]:54321'), '::1');
  assert.equal(normalizeIp('[2001:db8::1]'), '2001:db8::1');
});

test('normalizeIp leaves a bare v6 address alone (its colons are not a port)', () => {
  assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
  assert.equal(normalizeIp('::1'), '::1');
});

test('normalizeIp trims and lowercases', () => {
  assert.equal(normalizeIp('  2001:DB8::AB  '), '2001:db8::ab');
  assert.equal(normalizeIp(''), '');
});

test('validateIpNames normalizes on the way in', () => {
  assert.deepEqual(validateIpNames([{ ip: '::ffff:10.0.0.4', name: ' home ' }]), [
    { ip: '10.0.0.4', name: 'home' },
  ]);
});

test('validateIpNames dedupes by normalized ip, last one wins', () => {
  const out = validateIpNames([
    { ip: '10.0.0.4', name: 'old' },
    { ip: '::ffff:10.0.0.4', name: 'new' },
  ]);
  assert.deepEqual(out, [{ ip: '10.0.0.4', name: 'new' }]);
});

test('validateIpNames drops fully blank rows but rejects half-filled ones', () => {
  assert.deepEqual(validateIpNames([{ ip: '', name: '' }]), []);
  assert.throws(() => validateIpNames([{ ip: '10.0.0.4', name: '' }]), { statusCode: 400 });
  assert.throws(() => validateIpNames([{ ip: '', name: 'home' }]), { statusCode: 400 });
});

test('validateIpNames rejects a non-array and an oversized list', () => {
  assert.throws(() => validateIpNames('nope'), { statusCode: 400 });
  assert.throws(() => validateIpNames(null), { statusCode: 400 });
  const many = Array.from({ length: 201 }, (_, i) => ({ ip: `10.0.0.${i}`, name: `n${i}` }));
  assert.throws(() => validateIpNames(many), { statusCode: 400 });
});

test('validateIpNames caps name length', () => {
  const [entry] = validateIpNames([{ ip: '10.0.0.4', name: 'x'.repeat(200) }]);
  assert.equal(entry?.name.length, 60);
});
