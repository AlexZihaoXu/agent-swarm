import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipMatches } from './api.js';

// These gate whether a caller may set X-Forwarded-* / cf-connecting-ip. A false
// positive lets any direct caller forge its client IP and slip the per-IP login
// throttle, so the negative cases matter as much as the positive ones.

test('matches an exact address', () => {
  assert.equal(ipMatches('10.1.2.3', '10.1.2.3'), true);
  assert.equal(ipMatches('10.1.2.4', '10.1.2.3'), false);
});

test('matches inside an IPv4 CIDR and rejects outside it', () => {
  assert.equal(ipMatches('172.18.0.5', '172.16.0.0/12'), true);
  assert.equal(ipMatches('172.31.255.254', '172.16.0.0/12'), true);
  // 172.32.x is the first address past a /12 — the classic off-by-one.
  assert.equal(ipMatches('172.32.0.1', '172.16.0.0/12'), false);
  assert.equal(ipMatches('192.168.1.1', '10.0.0.0/8'), false);
});

test('normalizes IPv4-mapped IPv6 peers', () => {
  // Node reports v4 peers this way on a dual-stack listener; without
  // normalizing, every rule would miss and the proxy would never be trusted.
  assert.equal(ipMatches('::ffff:127.0.0.1', '127.0.0.0/8'), true);
  assert.equal(ipMatches('::ffff:8.8.8.8', '127.0.0.0/8'), false);
});

test('matches IPv6 loopback exactly', () => {
  assert.equal(ipMatches('::1', '::1'), true);
  assert.equal(ipMatches('2001:db8::1', '::1'), false);
});

test('rejects an IPv6 address against an IPv4 CIDR', () => {
  // Must not fall through to a permissive default: an unparseable pair is a
  // non-match, never a match.
  assert.equal(ipMatches('2001:db8::1', '10.0.0.0/8'), false);
  assert.equal(ipMatches('10.0.0.1', '2001:db8::/32'), false);
});

test('rejects malformed rules and addresses rather than matching', () => {
  assert.equal(ipMatches('10.0.0.1', '10.0.0.0/33'), false);
  assert.equal(ipMatches('10.0.0.1', '10.0.0.0/abc'), false);
  assert.equal(ipMatches('10.0.0.999', '10.0.0.0/8'), false);
  assert.equal(ipMatches('not-an-ip', '10.0.0.0/8'), false);
});

test('/0 matches any IPv4 address', () => {
  // Explicitly supported so an operator can opt back into the old behaviour.
  assert.equal(ipMatches('8.8.8.8', '0.0.0.0/0'), true);
});

test('/32 behaves as a single host', () => {
  assert.equal(ipMatches('10.0.0.1', '10.0.0.1/32'), true);
  assert.equal(ipMatches('10.0.0.2', '10.0.0.1/32'), false);
});
