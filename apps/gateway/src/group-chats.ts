// Per-group chat logs — the running group-chat transcript surfaced in the
// dashboard. Messages are recorded here whoever the sender is (a peer agent via
// swarm_send_group, or the human operator from the dashboard), so the UI can
// render the whole conversation. Persisted to config.groupChatsFile so it
// survives a gateway restart. Stdlib-only, mirroring roles.ts/groups.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import type { GroupMessage } from './types.js';

/** Cap per group so the file (and the dashboard render) stays bounded. */
const MAX_PER_GROUP = 200;

type Store = Record<string, GroupMessage[]>;

function load(): Store {
  try {
    const raw = JSON.parse(readFileSync(config.groupChatsFile, 'utf8')) as Store;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function save(store: Store): void {
  mkdirSync(dirname(config.groupChatsFile), { recursive: true });
  writeFileSync(config.groupChatsFile, JSON.stringify(store, null, 2));
}

/** The chat log for one group (oldest first). */
export function listGroupMessages(groupId: string): GroupMessage[] {
  return load()[groupId] ?? [];
}

/** Append a message to a group's log (trimmed to the cap) and return it. */
export function appendGroupMessage(
  groupId: string,
  msg: Omit<GroupMessage, 'id' | 'group'>,
): GroupMessage {
  const store = load();
  const list = store[groupId] ?? [];
  const record: GroupMessage = { id: `${msg.ts}-${list.length}`, group: groupId, ...msg };
  list.push(record);
  store[groupId] = list.slice(-MAX_PER_GROUP);
  save(store);
  return record;
}

/** Drop a group's log entirely (used when the group is deleted). */
export function clearGroupMessages(groupId: string): void {
  const store = load();
  if (store[groupId]) {
    delete store[groupId];
    save(store);
  }
}
