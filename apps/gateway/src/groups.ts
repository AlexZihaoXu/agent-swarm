// Global group registry. A group scopes swarm communication: agents can only
// message / share files with peers that share at least one group (ungrouped
// agents form a default open pool). Persisted to config.groupsFile.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { slugify } from './roles.js';
import type { Group } from './types.js';

export function listGroups(): Group[] {
  try {
    const raw = JSON.parse(readFileSync(config.groupsFile, 'utf8')) as Group[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeGroups(groups: Group[]): void {
  mkdirSync(dirname(config.groupsFile), { recursive: true });
  writeFileSync(config.groupsFile, JSON.stringify(groups, null, 2));
}

export function createGroup(name: string, description: string, now: number): Group {
  const trimmed = name.trim();
  if (!trimmed) throw Object.assign(new Error('group name required'), { statusCode: 400 });
  const groups = listGroups();
  let id = slugify(trimmed);
  if (groups.some((g) => g.id === id)) {
    let n = 2;
    while (groups.some((g) => g.id === `${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  const group: Group = { id, name: trimmed, description: description.trim(), createdAt: now };
  groups.push(group);
  writeGroups(groups);
  return group;
}

export function updateGroup(id: string, patch: { name?: string; description?: string }): Group {
  const groups = listGroups();
  const group = groups.find((g) => g.id === id);
  if (!group) throw Object.assign(new Error('group not found'), { statusCode: 404 });
  if (patch.name !== undefined && patch.name.trim()) group.name = patch.name.trim();
  if (patch.description !== undefined) group.description = patch.description.trim();
  writeGroups(groups);
  return group;
}

export function deleteGroup(id: string): void {
  writeGroups(listGroups().filter((g) => g.id !== id));
}

/** Two agents may communicate iff they share a group, or both are ungrouped. */
export function canCommunicate(a: string[], b: string[]): boolean {
  if (a.length === 0 && b.length === 0) return true;
  return a.some((g) => b.includes(g));
}
