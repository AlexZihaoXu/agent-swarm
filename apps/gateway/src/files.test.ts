import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listDir, readText, writeText, move, remove, streamUpload } from './files.js';

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

// ── Chunked upload ───────────────────────────────────────────────────────────
// Files bigger than a CDN's edge body limit are sliced by the client and
// appended server-side. The risk here is a corrupt file that still LOOKS
// complete, so these cover assembly order and the declared-size contract.

/** Feed a Buffer through streamUpload the way the HTTP layer does. */
async function upload(
  relDir: string,
  name: string,
  data: Buffer,
  chunk?: { offset: number; total: number },
) {
  return await streamUpload(root, relDir, name, Readable.from([data]), chunk);
}

test('chunked upload reassembles slices into the original bytes', async () => {
  const whole = Buffer.from('abcdefghijklmnopqrstuvwxyz');
  const a = whole.subarray(0, 10);
  const b = whole.subarray(10, 20);
  const c = whole.subarray(20);

  let r = await upload('', 'big.bin', a, { offset: 0, total: whole.length });
  assert.equal(r.complete, false, 'not done after the first slice');
  assert.ok(!existsSync(join(root, 'big.bin')), 'no final file until the last slice');

  r = await upload('', 'big.bin', b, { offset: 10, total: whole.length });
  assert.equal(r.complete, false);

  r = await upload('', 'big.bin', c, { offset: 20, total: whole.length });
  assert.equal(r.complete, true, 'complete once the declared total is reached');
  assert.equal(r.size, whole.length);
  assert.deepEqual(readFileSync(join(root, 'big.bin')), whole);
  assert.ok(!existsSync(join(root, 'big.bin.part')), '.part promoted, not left behind');
});

test('an out-of-order slice is refused rather than silently corrupting', async () => {
  const total = 30;
  await upload('', 'x.bin', Buffer.alloc(10, 1), { offset: 0, total });
  // Skips bytes 10..19 — appending here would produce a file of the right
  // length with a hole in it, which is worse than failing.
  await assert.rejects(
    () => upload('', 'x.bin', Buffer.alloc(10, 3), { offset: 20, total }),
    (e: Error & { statusCode?: number; resumeFrom?: number }) => {
      assert.equal(e.statusCode, 409);
      assert.equal(e.resumeFrom, 10, 'tells the client where to resume');
      return true;
    },
  );
  assert.ok(!existsSync(join(root, 'x.bin')), 'no final file from a rejected sequence');
});

test('a slice overrunning the declared total is rejected', async () => {
  await assert.rejects(
    () => upload('', 'y.bin', Buffer.alloc(50), { offset: 0, total: 10 }),
    (e: Error & { statusCode?: number }) => (assert.equal(e.statusCode, 413), true),
  );
});

test('restarting at offset 0 discards an abandoned partial', async () => {
  await upload('', 'z.bin', Buffer.alloc(10, 9), { offset: 0, total: 40 });
  // Second attempt at the same name, different content and size.
  const fresh = Buffer.from('hello');
  const r = await upload('', 'z.bin', fresh, { offset: 0, total: fresh.length });
  assert.equal(r.complete, true);
  assert.deepEqual(readFileSync(join(root, 'z.bin')), fresh, 'no stale bytes from attempt 1');
});

test('chunked upload still cannot escape the root', async () => {
  await assert.rejects(() =>
    upload('../..', 'escape.bin', Buffer.from('x'), { offset: 0, total: 1 }),
  );
  assert.ok(!existsSync(join(outside, 'escape.bin')));
});

test('a whole-file upload is unaffected and reports complete', async () => {
  const data = Buffer.from('single shot');
  const r = await upload('sub', 'plain.txt', data);
  assert.equal(r.complete, true);
  assert.equal(r.size, data.length);
  assert.deepEqual(readFileSync(join(root, 'sub', 'plain.txt')), data);
});
