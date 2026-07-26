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
): Promise<{ name: string; size: number }> {
  const safeName = basename(name || 'upload').replace(/[^\w.\- ]/g, '_') || 'upload';
  const dir = safe(root, relDir);
  mkdirSync(dir, { recursive: true });
  const dest = safe(root, join((relDir || '').replace(/^\/+/, ''), safeName));
  const tmp = `${dest}.part`;
  const out = createWriteStream(tmp);
  let size = 0;
  try {
    for await (const chunk of body) {
      const buf = chunk as Buffer;
      size += buf.byteLength;
      if (size > MAX_UPLOAD_BYTES) throw err('file too large', 413);
      // Respect backpressure — without this a fast client outruns the disk and
      // the write buffer grows without bound, undoing the point of streaming.
      if (!out.write(buf)) await once(out, 'drain');
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    renameSync(tmp, dest);
    chownAgent(dest);
    return { name: safeName, size };
  } catch (e) {
    out.destroy();
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw e;
  }
}
