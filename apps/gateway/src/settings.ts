import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

/** Runtime-adjustable settings, persisted to config.settingsFile as JSON. */
export interface Settings {
  /** Host path to the Claude credentials file mounted into new agents. */
  credentialsFile: string;
}

let cache: Settings | null = null;

function defaults(): Settings {
  return { credentialsFile: config.credentialsFile };
}

export function getSettings(): Settings {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(config.settingsFile, 'utf8')) as Partial<Settings>;
    cache = { credentialsFile: parsed.credentialsFile?.trim() || config.credentialsFile };
  } catch {
    cache = defaults();
  }
  return cache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings() };
  if (typeof patch.credentialsFile === 'string' && patch.credentialsFile.trim()) {
    next.credentialsFile = patch.credentialsFile.trim();
  }
  mkdirSync(dirname(config.settingsFile), { recursive: true });
  writeFileSync(config.settingsFile, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}
