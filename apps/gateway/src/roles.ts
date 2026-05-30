// Global role registry. Roles are reusable {name, description} records agents
// can be assigned; the description is what an agent reads to understand the
// role. Persisted to config.rolesFile (in the gateway-data volume).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import type { Capability, Role } from './types.js';

/** Catalog of special capabilities a role can grant, with human-readable copy
 *  for the role editor and the agent's roles.md doc. */
export const CAPABILITIES: { key: Capability; label: string; description: string }[] = [
  {
    key: 'manage_agents',
    label: 'Manage agents',
    description: 'Start and stop other agents in the swarm (cannot remove them).',
  },
  {
    key: 'view_screen',
    label: 'View screens',
    description: "Capture and view another agent's live screen image.",
  },
  {
    key: 'dashboard_alerts',
    label: 'Dashboard usage alerts',
    description:
      'Read the swarm dashboard usage (5h/7d rate-limit windows, tokens, cost) and receive proactive warnings when usage is projected to hit 100% or actually reaches 90% of a window.',
  },
];

const CAPABILITY_KEYS = new Set<string>(CAPABILITIES.map((c) => c.key));

/** Drop unknown/duplicate capability keys from a permissions list. */
function cleanPermissions(perms: unknown): Capability[] {
  if (!Array.isArray(perms)) return [];
  return [...new Set(perms.filter((p): p is Capability => CAPABILITY_KEYS.has(p as string)))];
}

/** Whether any of the given roles grants a capability (the effective check). */
export function rolesGrant(roleIds: string[], cap: Capability): boolean {
  return getRoles(roleIds).some((r) => r.permissions?.includes(cap));
}

/** name → stable slug id (lowercase, hyphenated, alnum). */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'role'
  );
}

export function listRoles(): Role[] {
  try {
    const raw = JSON.parse(readFileSync(config.rolesFile, 'utf8')) as Role[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeRoles(roles: Role[]): void {
  mkdirSync(dirname(config.rolesFile), { recursive: true });
  writeFileSync(config.rolesFile, JSON.stringify(roles, null, 2));
}

export function getRoles(ids: string[]): Role[] {
  const by = new Map(listRoles().map((r) => [r.id, r]));
  return ids.map((id) => by.get(id)).filter((r): r is Role => !!r);
}

/** Create a role (unique id; if the slug collides, suffix it). */
export function createRole(
  name: string,
  description: string,
  now: number,
  permissions?: unknown,
): Role {
  const trimmed = name.trim();
  if (!trimmed) throw Object.assign(new Error('role name required'), { statusCode: 400 });
  const roles = listRoles();
  let id = slugify(trimmed);
  if (roles.some((r) => r.id === id)) {
    let n = 2;
    while (roles.some((r) => r.id === `${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  const role: Role = {
    id,
    name: trimmed,
    description: description.trim(),
    permissions: cleanPermissions(permissions),
    createdAt: now,
  };
  roles.push(role);
  writeRoles(roles);
  return role;
}

export function updateRole(
  id: string,
  patch: { name?: string; description?: string; permissions?: unknown },
): Role {
  const roles = listRoles();
  const role = roles.find((r) => r.id === id);
  if (!role) throw Object.assign(new Error('role not found'), { statusCode: 404 });
  if (patch.name !== undefined && patch.name.trim()) role.name = patch.name.trim();
  if (patch.description !== undefined) role.description = patch.description.trim();
  if (patch.permissions !== undefined) role.permissions = cleanPermissions(patch.permissions);
  writeRoles(roles);
  return role;
}

export function deleteRole(id: string): void {
  writeRoles(listRoles().filter((r) => r.id !== id));
}
