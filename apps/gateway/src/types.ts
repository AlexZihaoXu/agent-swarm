/** The two web services every agent container exposes. */
export type ServiceName = 'desktop' | 'terminal';

/** A parsed `/a/:id/<service>/<rest>` request. */
export interface AgentRoute {
  id: string;
  service: ServiceName;
  /** Path to forward to the agent, prefix stripped; always starts with `/`. */
  rest: string;
}

/** Where the proxy should connect to reach an agent's service. */
export interface ProxyTarget {
  host: string;
  port: number;
}

/** Lifecycle view of an agent, as surfaced to the dashboard. */
export interface Agent {
  /** URL-facing id = the hostname (container name minus the prefix). */
  id: string;
  name: string;
  image: string;
  /** Friendly display name (editable; source of truth is the on-disk identity
   *  file so the agent can read it and it can change without recreating). */
  username?: string;
  /** Docker container state, e.g. "running", "exited", "created". */
  status: string;
  createdAt: number;
  /** Hard CPU limit in cores (if set at creation). */
  cpus?: number;
  /** Hard memory limit in MB (if set at creation). */
  memoryMb?: number;
  /** IANA timezone the agent runs in (if set at creation). */
  timezone?: string;
  /** Per-agent CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (1–100). null/omitted = the
   *  claude default (~83%). Applied by the supervisor on (re)launch. */
  autoCompactPct?: number | null;
}

// --- Integrations ----------------------------------------------------------
// A per-agent "integration" connects the agent to an outside platform. Discord
// is the first connector; future ones (slack, telegram, …) reuse this shell and
// the `scheme://` message-routing convention (see docs/discord-mcp-plan.md).

/** Connector kind. Extend the union as connectors are added. */
export type IntegrationType = 'discord';

/** Lifecycle of one configured integration — drives the dashboard UI state.
 *  added → configured → tested-ok → active, plus error / disabled. */
export type IntegrationStatus =
  | 'added'
  | 'configured'
  | 'tested-ok'
  | 'active'
  | 'error'
  | 'disabled';

/** Editable, non-secret behaviour rules for a Discord integration. */
export interface DiscordRules {
  /** Forward messages from these channel IDs into the agent. Empty = none. */
  forwardChannelIds: string[];
  /** Also forward direct messages sent to the bot. */
  forwardDms: boolean;
  /** If non-empty, only forward messages authored by these user IDs. */
  allowedUserIds: string[];
  /** Ignore messages authored by bots (including itself). */
  ignoreBots: boolean;
}

/** Secret credentials for Discord. Never returned in full over the API. */
export interface DiscordCredentials {
  botToken: string;
}

/** Summary of the most recent "test connection" attempt. */
export interface IntegrationTestResult {
  ok: boolean;
  at: number;
  detail?: string;
  /** Bot identity (e.g. "myagent#1234") + the guilds it's in, on success. */
  botTag?: string;
  guilds?: { id: string; name: string }[];
}

/** One configured integration, persisted per-agent in `.swarm/integrations.json`. */
export interface Integration {
  type: IntegrationType;
  status: IntegrationStatus;
  rules: DiscordRules;
  credentials: DiscordCredentials;
  lastTest?: IntegrationTestResult | null;
  updatedAt: number;
}

/** API-safe view: the raw token is replaced by a presence flag + a 4-char hint. */
export interface IntegrationPublic {
  type: IntegrationType;
  status: IntegrationStatus;
  rules: DiscordRules;
  hasCredentials: boolean;
  /** Last 4 chars of the bot token, for a "••••1a2b" display. */
  tokenHint?: string | null;
  lastTest?: IntegrationTestResult | null;
  updatedAt: number;
}

/** Patch accepted when updating an integration's credentials and/or rules. */
export interface IntegrationPatch {
  credentials?: Partial<DiscordCredentials>;
  rules?: Partial<DiscordRules>;
}

/** Options accepted when creating an agent. */
export interface CreateAgentOptions {
  /** Desired hostname → becomes the agent id + container name + Docker hostname. */
  hostname?: string;
  /** Friendly display name shown in the dashboard. */
  username?: string;
  /** Hard CPU limit in cores (e.g. 2 = two cores). Omit for unlimited. */
  cpus?: number;
  /** Hard memory limit in MB. Omit for unlimited. */
  memoryMb?: number;
  /** IANA timezone, e.g. "America/New_York". Omit to inherit the image default (UTC). */
  timezone?: string;
}
