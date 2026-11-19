// Per-agent integration storage, keyed by integration type (one per type per
// agent for now). The gateway's own copy (under config.agentStateDir) is the
// one it reads: the Discord rules decide who may talk to the agent, and the
// agent can rewrite anything on its own disk. The disk copy at
// `.swarm/integrations.json` is a mirror, so the in-agent MCP server can read
// its own credentials.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  DiscordRules,
  Integration,
  IntegrationPatch,
  IntegrationPublic,
  IntegrationType,
} from './types.js';

type Store = Partial<Record<IntegrationType, Integration>>;

/** Where one agent's integrations live: `state` is the gateway's directory for
 *  the agent, `disk` its persistent home (as the gateway sees it). */
export interface StoreDirs {
  state: string;
  disk: string;
}

const stateFile = (dirs: StoreDirs): string => join(dirs.state, 'integrations.json');
const diskFile = (dirs: StoreDirs): string => join(dirs.disk, '.swarm', 'integrations.json');

function parse(file: string): Store | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Store;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return null;
  }
}

/** Defaults a brand-new Discord integration starts with. */
export const DEFAULT_DISCORD_RULES: DiscordRules = {
  forwardChannelIds: [],
  forwardDms: true,
  allowedUserIds: [],
  ignoreBots: true,
  requireMention: true,
  respondToMentionsAnywhere: false,
};

/** The gateway's copy. Before one exists (agents from before it did), the disk
 *  copy is adopted once, as it stands then. */
export function readStore(dirs: StoreDirs): Store {
  if (existsSync(stateFile(dirs))) return parse(stateFile(dirs)) ?? {};
  const adopted = parse(diskFile(dirs));
  if (adopted) writeStore(dirs, adopted);
  return adopted ?? {};
}

function writeStore(dirs: StoreDirs, store: Store): void {
  const json = JSON.stringify(store, null, 2);
  for (const f of [stateFile(dirs), diskFile(dirs)]) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, json);
  }
}

export function listIntegrations(dirs: StoreDirs): Integration[] {
  return Object.values(readStore(dirs)).filter((i): i is Integration => !!i);
}

export function getIntegration(dirs: StoreDirs, type: IntegrationType): Integration | null {
  return readStore(dirs)[type] ?? null;
}

/** Create the integration shell if missing (status `added`, default rules). */
export function addIntegration(dirs: StoreDirs, type: IntegrationType, now: number): Integration {
  const store = readStore(dirs);
  if (store[type]) return store[type]!;
  const created: Integration = {
    type,
    status: 'added',
    rules: { ...DEFAULT_DISCORD_RULES },
    credentials: { botToken: '' },
    lastTest: null,
    updatedAt: now,
  };
  store[type] = created;
  writeStore(dirs, store);
  return created;
}

/** Merge credentials/rules into an integration. Saving credentials moves a
 *  bare `added` integration to `configured`; any change clears a prior pass
 *  (back to `configured`) so it must be re-tested before re-applying. */
export function patchIntegration(
  dirs: StoreDirs,
  type: IntegrationType,
  patch: IntegrationPatch,
  now: number,
): Integration {
  const store = readStore(dirs);
  const cur = store[type];
  if (!cur) throw Object.assign(new Error('integration not found'), { statusCode: 404 });

  if (patch.credentials) cur.credentials = { ...cur.credentials, ...patch.credentials };
  if (patch.rules) cur.rules = { ...cur.rules, ...patch.rules };

  const hasToken = !!cur.credentials.botToken;
  if (cur.status === 'added' && hasToken) cur.status = 'configured';
  // Editing config invalidates a previous green test / active run; require a
  // fresh test+apply. (Disabled stays disabled until explicitly re-applied.)
  else if (cur.status === 'tested-ok' || cur.status === 'active' || cur.status === 'error')
    cur.status = hasToken ? 'configured' : 'added';

  cur.updatedAt = now;
  store[type] = cur;
  writeStore(dirs, store);
  return cur;
}

/** Persist an arbitrary status/test update (used after test/apply/disable). */
export function setIntegration(dirs: StoreDirs, type: IntegrationType, next: Integration): void {
  const store = readStore(dirs);
  store[type] = next;
  writeStore(dirs, store);
}

export function removeIntegration(dirs: StoreDirs, type: IntegrationType): void {
  const store = readStore(dirs);
  delete store[type];
  writeStore(dirs, store);
}

/** Strip secrets for the API: token → presence flag + last-4 hint. */
export function toPublic(i: Integration): IntegrationPublic {
  const token = i.credentials?.botToken ?? '';
  return {
    type: i.type,
    status: i.status,
    rules: i.rules,
    hasCredentials: !!token,
    tokenHint: token ? token.slice(-4) : null,
    lastTest: i.lastTest ?? null,
    updatedAt: i.updatedAt,
  };
}
