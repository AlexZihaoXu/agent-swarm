// Per-agent integration storage. Integrations live on the agent's persistent
// disk at `.swarm/integrations.json` (the same place as identity.json), so the
// in-agent MCP server can read its own credentials and the gateway can manage
// them. Keyed by integration type (one per type per agent for now).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  DiscordRules,
  Integration,
  IntegrationPatch,
  IntegrationPublic,
  IntegrationType,
} from './types.js';

type Store = Partial<Record<IntegrationType, Integration>>;

const fileFor = (dataDir: string): string => join(dataDir, '.swarm', 'integrations.json');

/** Defaults a brand-new Discord integration starts with. */
export const DEFAULT_DISCORD_RULES: DiscordRules = {
  forwardChannelIds: [],
  forwardDms: true,
  allowedUserIds: [],
  ignoreBots: true,
};

export function readStore(dataDir: string): Store {
  try {
    const raw = JSON.parse(readFileSync(fileFor(dataDir), 'utf8')) as Store;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeStore(dataDir: string, store: Store): void {
  const f = fileFor(dataDir);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(store, null, 2));
}

export function listIntegrations(dataDir: string): Integration[] {
  return Object.values(readStore(dataDir)).filter((i): i is Integration => !!i);
}

export function getIntegration(dataDir: string, type: IntegrationType): Integration | null {
  return readStore(dataDir)[type] ?? null;
}

/** Create the integration shell if missing (status `added`, default rules). */
export function addIntegration(dataDir: string, type: IntegrationType, now: number): Integration {
  const store = readStore(dataDir);
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
  writeStore(dataDir, store);
  return created;
}

/** Merge credentials/rules into an integration. Saving credentials moves a
 *  bare `added` integration to `configured`; any change clears a prior pass
 *  (back to `configured`) so it must be re-tested before re-applying. */
export function patchIntegration(
  dataDir: string,
  type: IntegrationType,
  patch: IntegrationPatch,
  now: number,
): Integration {
  const store = readStore(dataDir);
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
  writeStore(dataDir, store);
  return cur;
}

/** Persist an arbitrary status/test update (used after test/apply/disable). */
export function setIntegration(dataDir: string, type: IntegrationType, next: Integration): void {
  const store = readStore(dataDir);
  store[type] = next;
  writeStore(dataDir, store);
}

export function removeIntegration(dataDir: string, type: IntegrationType): void {
  const store = readStore(dataDir);
  delete store[type];
  writeStore(dataDir, store);
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
