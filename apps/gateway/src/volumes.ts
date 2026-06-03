import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Shared-volume registry. Each volume is a loop-image-backed ext4 filesystem:
 * a sparse file `<swarmData>/volumes/<name>.img` mounted on the HOST at
 * `<swarmData>/volumes/<name>` and bind-mounted into attached agents at
 * `/home/agent/Shared/<name>`. The fixed filesystem size is the hard cap —
 * writes past it fail with ENOSPC, no quota bookkeeping needed.
 *
 * This module is just the metadata registry (a JSON file beside the gateway
 * settings); the mount/mkfs lifecycle lives in AgentManager since it needs
 * the Docker API (mounts happen in the HOST mount namespace via a privileged
 * one-shot helper container — the gateway itself runs unprivileged).
 */
export interface SharedVolumeMeta {
  name: string;
  sizeMb: number;
  createdAt: number;
}

/** Volume names are path/hostname-safe: lowercase alphanumerics + hyphens. */
export const VALID_VOLUME_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** Size bounds (MB). The floor keeps ext4 happy (tiny fs ≈ all overhead);
 *  the ceiling keeps a fat-fingered request from eating the host disk. */
export const VOLUME_MIN_MB = 64;
export const VOLUME_MAX_MB = 16384;

function load(file: string): SharedVolumeMeta[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { volumes?: SharedVolumeMeta[] };
    return Array.isArray(parsed.volumes) ? parsed.volumes : [];
  } catch {
    return [];
  }
}

function save(file: string, volumes: SharedVolumeMeta[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ volumes }, null, 2));
}

export function listVolumeMeta(file: string): SharedVolumeMeta[] {
  return load(file);
}

export function getVolumeMeta(file: string, name: string): SharedVolumeMeta | undefined {
  return load(file).find((v) => v.name === name);
}

export function addVolumeMeta(file: string, meta: SharedVolumeMeta): void {
  const volumes = load(file);
  if (volumes.some((v) => v.name === meta.name))
    throw Object.assign(new Error(`volume "${meta.name}" already exists`), { statusCode: 409 });
  volumes.push(meta);
  save(file, volumes);
}

export function removeVolumeMeta(file: string, name: string): void {
  const volumes = load(file);
  save(
    file,
    volumes.filter((v) => v.name !== name),
  );
}

/** Validate a create request; throws 400 with a helpful message. */
export function validateVolumeRequest(
  name: unknown,
  sizeMb: unknown,
): { name: string; sizeMb: number } {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!VALID_VOLUME_NAME.test(n))
    throw Object.assign(
      new Error('volume name must be lowercase letters, digits, hyphens (max 31 chars)'),
      { statusCode: 400 },
    );
  const s = typeof sizeMb === 'number' ? Math.round(sizeMb) : NaN;
  if (!Number.isFinite(s) || s < VOLUME_MIN_MB || s > VOLUME_MAX_MB)
    throw Object.assign(new Error(`sizeMb must be between ${VOLUME_MIN_MB} and ${VOLUME_MAX_MB}`), {
      statusCode: 400,
    });
  return { name: n, sizeMb: s };
}

/** True when the registry file's directory exists (sanity for first boot). */
export function ensureVolumesDirFor(file: string): void {
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
}
