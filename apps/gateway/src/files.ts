// Agent file-explorer backend: sandboxed filesystem ops on one agent's home.
// The agent's /home/agent is the host bind-mount the gateway already sees at
// agentDataDir(id), so we operate on it directly (no container exec). Every path
// is resolved and confined to the home root — traversal out is rejected. Files
// we create/modify are chowned to the agent user (uid 1000) so the in-container
// agent can read/write them too.
import {
  chownSync,
  createReadStream,
  existsSync,
  lstatSync,
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { ReadStream } from 'node:fs';
import type { Readable } from 'node:stream';

/** Max size we'll return for in-browser text editing. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Max size for an uploaded file. */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
/**
 * Largest single request body the client should send.
 *
 * Not a limit of ours — the gateway happily streams the full MAX_UPLOAD_BYTES.
 * It exists because the dashboard is served through Cloudflare, which caps
 * request bodies at the EDGE by plan (100 MB on Free and Pro, 200 MB Business,
 * 500 MB Enterprise) and rejects anything larger with a 413 and its own HTML
 * error page, before the origin sees a byte. That is not configurable from our
 * side at any plan below Enterprise, so the fix is to never send a body that
 * big: the client slices the file and uploads it in pieces.
 *
 * 32 MB rather than something just under 100 MB so it stays well clear of the
 * lowest plan limit and of any intermediate proxy with its own tighter cap, and
 * so a failed piece is cheap to retry.
 */
export const UPLOAD_CHUNK_BYTES = 32 * 1024 * 1024;

export interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
  /** Modified time, epoch ms. */
  mtime: number;
}
export interface DirView {
  /** Path relative to the agent home (forward slashes, '' = home root). */
  path: string;
  entries: FileEntry[];
}

function err(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Resolve a client-supplied relative path inside `root`; reject any escape.
 *
 * Lexical containment (resolve + prefix check) alone isn't enough: the tree is
 * writable by the agent, which could plant a symlink pointing OUTSIDE its home
 * (e.g. at the gateway's settings file) and let the operator's file explorer
 * read or write through it. So the deepest existing ancestor of the target is
 * also realpath'd and must still land inside the (realpath'd) root.
 *
 * `followLeaf: false` exempts the final component from that check — for ops
 * that act on a link itself (delete, rename-source) rather than through it.
 */
function safe(root: string, rel: string, followLeaf = true): string {
  const clean = (rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw err('path escapes the agent home', 400);
  }
  const rootReal = realpathSync(root);
  // Walk up to the deepest component that exists and realpath-vet it. lstat
  // (not stat): a dangling symlink still "exists" as something realpath must
  // judge — writeFileSync would happily follow it and create its target.
  let probe = abs;
  if (!followLeaf && probe !== root) probe = dirname(probe);
  let probeReal: string;
  for (;;) {
    if (lstatSync(probe, { throwIfNoEntry: false })) {
      try {
        probeReal = realpathSync(probe);
      } catch {
        // Exists but won't resolve → dangling symlink. Never operate through it.
        throw err('path escapes the agent home', 400);
      }
      break;
    }
    if (probe === root) throw err('not found', 404);
    probe = dirname(probe);
  }
  if (probeReal !== rootReal && !probeReal.startsWith(rootReal + sep)) {
    throw err('path escapes the agent home', 400);
  }
  return abs;
}

function chownAgent(p: string): void {
  try {
    chownSync(p, 1000, 1000);
  } catch {
    /* best-effort — gateway runs as root; agent user is uid 1000 */
  }
}

export function listDir(root: string, rel: string): DirView {
  const dir = safe(root, rel);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw err('not a directory', 404);
  const out: FileEntry[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    try {
      const st = statSync(join(dir, e.name));
      out.push({
        name: e.name,
        dir: st.isDirectory(),
        size: st.size,
        mtime: Math.round(st.mtimeMs),
      });
    } catch {
      /* skip entries we can't stat (broken symlink, perms) */
    }
  }
  // Folders first, then case-insensitive by name.
  out.sort((a, b) =>
    a.dir === b.dir
      ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      : a.dir
        ? -1
        : 1,
  );
  return { path: (rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''), entries: out };
}

export function readText(root: string, rel: string): string {
  const f = safe(root, rel);
  if (!existsSync(f) || !statSync(f).isFile()) throw err('not a file', 404);
  if (statSync(f).size > MAX_TEXT_BYTES) throw err('file is too large to edit in the browser', 413);
  return readFileSync(f, 'utf8');
}

export function writeText(root: string, rel: string, content: string): void {
  const f = safe(root, rel);
  if (existsSync(f) && statSync(f).isDirectory()) throw err('path is a directory', 400);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, content ?? '');
  chownAgent(f);
}

export function makeDir(root: string, rel: string): void {
  const d = safe(root, rel);
  if (existsSync(d)) throw err('already exists', 409);
  mkdirSync(d, { recursive: true });
  chownAgent(d);
}

export function move(root: string, from: string, to: string): void {
  // followLeaf=false on the source: renaming moves a symlink itself, so a link
  // pointing outside is fine to relocate (it's never dereferenced here).
  const src = safe(root, from, false);
  const dst = safe(root, to);
  if (src === root) throw err('cannot move the home root', 400);
  if (!lstatSync(src, { throwIfNoEntry: false })) throw err('source not found', 404);
  if (existsSync(dst)) throw err('destination already exists', 409);
  mkdirSync(dirname(dst), { recursive: true });
  renameSync(src, dst);
  chownAgent(dst);
}

export function remove(root: string, rel: string): void {
  // followLeaf=false: deleting a symlink removes the link, not its target, so
  // the operator can clean up even a link that points outside the home.
  const t = safe(root, rel, false);
  if (t === root) throw err('cannot delete the home root', 400);
  if (!lstatSync(t, { throwIfNoEntry: false })) throw err('not found', 404);
  rmSync(t, { recursive: true, force: true });
}

/** Resolve a file for download (must exist + be a regular file). */
export function fileForDownload(
  root: string,
  rel: string,
): { path: string; name: string; stream: ReadStream } {
  const f = safe(root, rel);
  if (!existsSync(f) || !statSync(f).isFile()) throw err('not a file', 404);
  return { path: f, name: basename(f), stream: createReadStream(f) };
}

/** Stream a folder as a .zip download. Uses 7z (p7zip-full is in the image),
 *  archiving the folder's contents with cwd set to the folder so entries inside
 *  the zip are relative to it. Returns the suggested filename + the stdout stream
 *  (pure zip bytes; logs/progress go to the ignored stderr). */
export function zipDir(root: string, rel: string): { name: string; stream: Readable } {
  const dir = safe(root, rel);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw err('not a directory', 404);
  const name = `${dir === root ? 'home' : basename(dir)}.zip`;
  const child = spawn('7z', ['a', '-tzip', '-mx=1', '-so', 'archive.zip', '.'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const stream = child.stdout;
  // Surface a failed spawn (e.g. 7z missing → ENOENT) or a non-zero exit as a
  // stream error, so the caller can still send a 5xx if it hasn't sent headers
  // yet (rather than streaming an empty/truncated "zip" under a 200).
  child.on('error', (e) => stream.destroy(e));
  child.on('close', (code) => {
    if (code) stream.destroy(new Error(`7z exited with code ${code}`));
  });
  return { name, stream };
}

/**
 * Stream an upload straight to disk under a sanitized filename.
 *
 * Buffering the body first (collect chunks -> Buffer.concat) meant a 130 MB
 * upload briefly held ~260 MB in the gateway, and anything near the 256 MB cap
 * could exhaust the heap outright — so the failure mode got worse exactly as
 * the file got bigger. Streaming keeps memory flat regardless of size.
 *
 * Writes to a `.part` file and renames on success, so a failed or aborted
 * upload never leaves a truncated file looking like a complete one.
 */
export async function streamUpload(
  root: string,
  relDir: string,
  name: string,
  body: Readable,
  /**
   * Set for a CHUNKED upload — one slice of a larger file that had to be split
   * to get past Cloudflare's edge body limit (see UPLOAD_CHUNK_BYTES).
   * `offset` is where this slice starts in the finished file and `total` is that
   * file's full size. Absent for an ordinary single-request upload.
   */
  chunk?: { offset: number; total: number },
): Promise<{ name: string; size: number; complete: boolean }> {
  const safeName = basename(name || 'upload').replace(/[^\w.\- ]/g, '_') || 'upload';
  const dir = safe(root, relDir);
  mkdirSync(dir, { recursive: true });
  const dest = safe(root, join((relDir || '').replace(/^\/+/, ''), safeName));
  const tmp = `${dest}.part`;
  if (chunk) return await appendChunk(dest, tmp, safeName, body, chunk);
  const out = createWriteStream(tmp);
  let size = 0;
  try {
    // `part` not `chunk`: the parameter of that name is the chunked-upload
    // descriptor, and shadowing it here would be a trap for the next edit.
    for await (const part of body) {
      const buf = part as Buffer;
      size += buf.byteLength;
      if (size > MAX_UPLOAD_BYTES) throw err('file too large', 413);
      // Respect backpressure — without this a fast client outruns the disk and
      // the write buffer grows without bound, undoing the point of streaming.
      if (!out.write(buf)) await once(out, 'drain');
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    renameSync(tmp, dest);
    chownAgent(dest);
    return { name: safeName, size, complete: true };
  } catch (e) {
    // Same lazy-open hazard as appendChunk: a late failure on a destroyed
    // stream would otherwise land as an unhandled 'error'.
    out.on('error', () => {});
    out.destroy();
    if (!out.closed) await once(out, 'close').catch(() => {});
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw e;
  }
}

/**
 * Append one slice of a chunked upload to the `.part` file, and promote it to
 * the real filename once the last slice lands.
 *
 * `offset` is checked against what is already on disk rather than trusted. A
 * mismatch means slices arrived out of order or one was lost, and appending
 * anyway would silently produce a corrupt file that still looks complete — so
 * it 409s with the offset the client should resume from instead. That also
 * makes a retry of an already-applied slice safe to reason about.
 */
async function appendChunk(
  dest: string,
  tmp: string,
  safeName: string,
  body: Readable,
  { offset, total }: { offset: number; total: number },
): Promise<{ name: string; size: number; complete: boolean }> {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(total) || total <= 0)
    throw err('invalid chunk offset/total', 400);
  if (total > MAX_UPLOAD_BYTES) throw err('file too large', 413);

  const onDisk = offset === 0 ? 0 : existsSync(tmp) ? statSync(tmp).size : 0;
  // Starting over truncates any abandoned .part from an earlier failed attempt.
  if (offset === 0) rmSync(tmp, { force: true });
  else if (onDisk !== offset)
    throw Object.assign(new Error(`chunk out of order (have ${onDisk}, got ${offset})`), {
      statusCode: 409,
      resumeFrom: onDisk,
    });

  const out = createWriteStream(tmp, { flags: offset === 0 ? 'w' : 'a' });
  let size = offset;
  try {
    for await (const part of body) {
      const buf = part as Buffer;
      size += buf.byteLength;
      // The declared total is the contract; a client that overruns it is either
      // buggy or probing, and either way must not write past what we vetted.
      if (size > total || size > MAX_UPLOAD_BYTES) throw err('upload exceeds declared size', 413);
      if (!out.write(buf)) await once(out, 'drain');
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
  } catch (e) {
    // A write stream opens lazily, so tearing it down before the open lands
    // leaves the failed open to surface later as an unhandled 'error' — which
    // crashes the process rather than failing this one request. Swallow it: we
    // are already throwing something more useful, and wait for the close so no
    // stray activity outlives the request.
    out.on('error', () => {});
    out.destroy();
    if (!out.closed) await once(out, 'close').catch(() => {});
    // Keep the .part on a mid-transfer failure so the client can resume from
    // the byte we actually have, rather than restarting a multi-GB upload.
    throw e;
  }
  if (size < total) return { name: safeName, size, complete: false };
  renameSync(tmp, dest);
  chownAgent(dest);
  return { name: safeName, size, complete: true };
}
