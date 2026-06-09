import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listDir, readText, writeText, move, remove } from './files.js';

// The file-explorer root is writable by the agent, so an agent can plant
// symlinks pointing anywhere. The operator's ops must never follow one out.
let outside: string; // simulates e.g. the gateway's /data
let root: string; // simulates the agent home

beforeEach(() => {
  outside = mkdtempSync(join(tmpdir(), 'files-outside-'));
  root = mkdtempSync(join(tmpdir(), 'files-root-'));
  writeFileSync(join(outside, 'secret.txt'), 'gateway secret');
  writeFileSync(join(root, 'ok.txt'), 'fine');
  mkdirSync(join(root, 'sub'));
});

afterEach(() => {
  rmSync(outside, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test('plain dot-dot traversal is rejected', () => {
  assert.throws(() => readText(root, '../outside'), /escapes/);
  assert.throws(() => writeText(root, '../x.txt', 'pwn'), /escapes/);
});

test('reading through a symlink that escapes the root is rejected', () => {
  symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));
  assert.throws(() => readText(root, 'leak.txt'), /escapes/);
});

test('listing through an escaping directory symlink is rejected', () => {
  symlinkSync(outside, join(root, 'door'));
  assert.throws(() => listDir(root, 'door'), /escapes/);
  assert.throws(() => readText(root, 'door/secret.txt'), /escapes/);
});

test('writing through an escaping symlink is rejected (existing target)', () => {
  symlinkSync(join(outside, 'secret.txt'), join(root, 'edit-me.txt'));
  assert.throws(() => writeText(root, 'edit-me.txt', 'overwritten'), /escapes/);
  assert.equal(readText(root, 'ok.txt'), 'fine'); // sanity: in-root ops still work
});

test('writing through a DANGLING escaping symlink is rejected (would create the target)', () => {
  symlinkSync(join(outside, 'not-yet.txt'), join(root, 'trap.txt'));
  assert.throws(() => writeText(root, 'trap.txt', 'pwn'), /escapes/);
  assert.equal(existsSync(join(outside, 'not-yet.txt')), false);
});

test('deleting an escaping symlink removes the link, never the target', () => {
  symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));
  remove(root, 'leak.txt');
  assert.equal(existsSync(join(root, 'leak.txt')), false);
  assert.equal(existsSync(join(outside, 'secret.txt')), true, 'target must survive');
});

test('renaming an escaping symlink moves the link itself', () => {
  symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));
  move(root, 'leak.txt', 'sub/leak.txt');
  assert.equal(existsSync(join(outside, 'secret.txt')), true);
});

test('in-root symlinks still work', () => {
  symlinkSync(join(root, 'ok.txt'), join(root, 'alias.txt'));
  assert.equal(readText(root, 'alias.txt'), 'fine');
});

test('normal operations are unaffected', () => {
  writeText(root, 'sub/new.txt', 'hello');
  assert.equal(readText(root, 'sub/new.txt'), 'hello');
  const view = listDir(root, '');
  assert.ok(view.entries.some((e) => e.name === 'ok.txt'));
  move(root, 'sub/new.txt', 'sub/renamed.txt');
  remove(root, 'sub/renamed.txt');
  assert.equal(existsSync(join(root, 'sub', 'renamed.txt')), false);
});
