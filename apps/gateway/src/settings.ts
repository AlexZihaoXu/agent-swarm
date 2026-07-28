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
  /** ChatGPT / Codex, authenticated by OAuth rather than a pasted key — so we
   *  hold tokens, not a secret the operator can retype. Server-side only. */
  chatgpt?: {
    accessToken: string;
    refreshToken: string | null;
    /** Epoch ms; the access token is short-lived and gets refreshed. */
    expiresAt: number;
    /** Sent as the `chatgpt-account-id` header when calling the backend. */
    accountId: string | null;
    /** Display label for the dashboard (email/name), never a credential. */
    account: string | null;
  };
}

/** An operator-assigned friendly name for a client IP. Purely cosmetic, but it
 *  is what makes the auth log readable at a glance: a familiar address renders
 *  as "home" while anything unnamed stands out as an unknown location. */
export interface IpNameEntry {
  ip: string;
  name: string;
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
  /** Friendly names for known client IPs, in operator-chosen order. */
  ipNames?: IpNameEntry[];
}

/** Bounds on the IP name map — generous, but keeps a runaway PUT from bloating
 *  the settings blob that every request path reads through a module cache. */
const IP_NAME_MAX_ENTRIES = 200;
const IP_NAME_MAX_LEN = 60;

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
      ipNames: Array.isArray(parsed.ipNames) ? parsed.ipNames : undefined,
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
  if (patch.ipNames !== undefined) next.ipNames = patch.ipNames;
  mkdirSync(dirname(config.settingsFile), { recursive: true });
  writeFileSync(config.settingsFile, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}

/** Canonical form of a client address, so a name set for "192.168.1.5" still
 *  matches when the same peer arrives as "::ffff:192.168.1.5" or "[::1]:54321".
 *  Node hands us v4-mapped v6 on dual-stack sockets, and proxies sometimes
 *  append a source port — both must fold to the same key. */
export function normalizeIp(raw: string): string {
  let ip = String(raw ?? '')
    .trim()
    .toLowerCase();
  // "[::1]:5432" / "[::1]" → "::1" (brackets always delimit a v6 literal).
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1] ?? ip;
  // "1.2.3.4:5432" → "1.2.3.4". A lone colon on a dotted quad is a port, never v6.
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  // v4-mapped v6 → the plain v4 literal.
  if (ip.startsWith('::ffff:') && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip.slice(7))) ip = ip.slice(7);
  return ip;
}

/** Validate + normalize an operator-supplied IP name map. Throws a 400-shaped
 *  error on anything unusable; silently drops blank rows so a half-filled form
 *  round-trips cleanly. Later entries win on duplicate IPs. */
export function validateIpNames(input: unknown): IpNameEntry[] {
  if (!Array.isArray(input)) {
    throw Object.assign(new Error('ipNames must be an array'), { statusCode: 400 });
  }
  if (input.length > IP_NAME_MAX_ENTRIES) {
    throw Object.assign(new Error(`too many entries (max ${IP_NAME_MAX_ENTRIES})`), {
      statusCode: 400,
    });
  }
  const byIp = new Map<string, IpNameEntry>();
  for (const row of input) {
    const ip = normalizeIp((row as IpNameEntry)?.ip ?? '');
    const name = String((row as IpNameEntry)?.name ?? '')
      .trim()
      .slice(0, IP_NAME_MAX_LEN);
    if (!ip && !name) continue; // an empty row is a no-op, not an error
    if (!ip) {
      throw Object.assign(new Error(`"${name}" is missing an IP address`), { statusCode: 400 });
    }
    if (!name) {
      throw Object.assign(new Error(`${ip} is missing a name`), { statusCode: 400 });
    }
    byIp.set(ip, { ip, name });
  }
  return [...byIp.values()];
}

/** The IP name map as a plain lookup, keyed by normalized address. */
export function ipNameMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { ip, name } of getSettings().ipNames ?? []) out[normalizeIp(ip)] = name;
  return out;
}

/** Days until the configured token is assumed to expire (null if unknown — e.g.
 *  an env-provided token we never stamped). Negative = already past. */
export function tokenDaysLeft(): number | null {
  const { oauthToken, tokenSetAt } = getSettings();
  if (!oauthToken || !tokenSetAt) return null;
  const expiresAt = tokenSetAt + TOKEN_VALIDITY_DAYS * 86_400_000;
  return Math.ceil((expiresAt - Date.now()) / 86_400_000);
}
