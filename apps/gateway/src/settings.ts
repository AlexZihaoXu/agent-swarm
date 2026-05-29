import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

/** Runtime-adjustable settings, persisted to config.settingsFile as JSON. */
export interface Settings {
  /** Claude Code OAuth token (`claude setup-token`) injected into each agent as
   *  CLAUDE_CODE_OAUTH_TOKEN. A secret — masked when surfaced over the API. */
  oauthToken: string;
}

let cache: Settings | null = null;

function defaults(): Settings {
  return { oauthToken: config.oauthToken };
}

export function getSettings(): Settings {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(config.settingsFile, 'utf8')) as Partial<Settings>;
    // Fall back to the env-provided token until the operator sets one.
    cache = { oauthToken: parsed.oauthToken?.trim() || config.oauthToken };
  } catch {
    cache = defaults();
  }
  return cache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings() };
  if (typeof patch.oauthToken === 'string') {
    // Empty clears back to the env default; a value overrides it.
    next.oauthToken = patch.oauthToken.trim() || config.oauthToken;
  }
  mkdirSync(dirname(config.settingsFile), { recursive: true });
  writeFileSync(config.settingsFile, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}
