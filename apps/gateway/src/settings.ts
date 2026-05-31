import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

/** Operator login credentials. The password is stored only as a scrypt hash +
 *  salt — never in plaintext, never returned over the API. */
export interface AuthCreds {
  username: string;
  salt: string;
  hash: string;
}

/** Per-provider credentials. Each provider is independent; an agent uses one. */
export interface ProvidersConfig {
  /** OpenCode Go (https://opencode.ai/go) — a subscription-billed gateway for
   *  GLM / Kimi / DeepSeek / etc. The key (sk-opencode-…) is presented as
   *  `Authorization: Bearer <key>` to opencode.ai/zen/go/v1; the in-agent
   *  opencode-proxy reads it from `~/.swarm/opencode-go-key` and translates
   *  Claude Code's Anthropic Messages requests into OpenAI Chat Completions. */
  opencodeGo?: { apiKey: string };
}

/** Runtime-adjustable settings, persisted to config.settingsFile as JSON. */
export interface Settings {
  /** Claude Code OAuth token (`claude setup-token`) injected into each agent as
   *  CLAUDE_CODE_OAUTH_TOKEN. A secret — masked when surfaced over the API. */
  oauthToken: string;
  /** Epoch ms when the current token was saved via the dashboard. Used to warn
   *  before its ~1-year expiry. Undefined for env-provided tokens. */
  tokenSetAt?: number;
  /** Operator login (set on first-run). Absent until configured. */
  auth?: AuthCreds;
  /** Random secret used to sign session cookies; generated at first setup so
   *  sessions survive gateway restarts. */
  sessionSecret?: string;
  /** Random shared token agents present (x-swarm-token) so their machine-to-
   *  machine calls to /api/swarm/* pass the operator-login gate. */
  swarmSecret?: string;
  /** Per-provider credentials. The Anthropic OAuth token lives at the top level
   *  (above) for historical reasons; new providers nest here. */
  providers?: ProvidersConfig;
}

/** Assumed validity of a `claude setup-token` token, and how early to warn. */
export const TOKEN_VALIDITY_DAYS = 365;
export const TOKEN_WARN_DAYS = 30;

let cache: Settings | null = null;

function defaults(): Settings {
  return { oauthToken: config.oauthToken };
}

export function getSettings(): Settings {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(config.settingsFile, 'utf8')) as Partial<Settings>;
    // Fall back to the env-provided token until the operator sets one.
    cache = {
      oauthToken: parsed.oauthToken?.trim() || config.oauthToken,
      tokenSetAt: typeof parsed.tokenSetAt === 'number' ? parsed.tokenSetAt : undefined,
      auth: parsed.auth,
      sessionSecret: parsed.sessionSecret,
      swarmSecret: parsed.swarmSecret,
      providers: parsed.providers,
    };
  } catch {
    cache = defaults();
  }
  return cache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings() };
  if (typeof patch.oauthToken === 'string') {
    const token = patch.oauthToken.trim();
    // Empty clears back to the env default; a value overrides it.
    next.oauthToken = token || config.oauthToken;
    // Stamp the set time for the expiry reminder (cleared when no token).
    next.tokenSetAt = token ? Date.now() : undefined;
  }
  if (patch.auth !== undefined) next.auth = patch.auth;
  if (patch.sessionSecret !== undefined) next.sessionSecret = patch.sessionSecret;
  if (patch.swarmSecret !== undefined) next.swarmSecret = patch.swarmSecret;
  if (patch.providers !== undefined) next.providers = patch.providers;
  mkdirSync(dirname(config.settingsFile), { recursive: true });
  writeFileSync(config.settingsFile, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}

/** Days until the configured token is assumed to expire (null if unknown — e.g.
 *  an env-provided token we never stamped). Negative = already past. */
export function tokenDaysLeft(): number | null {
  const { oauthToken, tokenSetAt } = getSettings();
  if (!oauthToken || !tokenSetAt) return null;
  const expiresAt = tokenSetAt + TOKEN_VALIDITY_DAYS * 86_400_000;
  return Math.ceil((expiresAt - Date.now()) / 86_400_000);
}
