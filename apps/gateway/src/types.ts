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
  /** Backend the agent's claude talks to. 'anthropic' = the Anthropic API
   *  (OAuth subscription); 'opencodeGo' = OpenCode Go via the in-agent proxy.
   *  Default is 'anthropic'. */
  provider?: Provider;
  /** Configured model override (ANTHROPIC_MODEL: alias or full id); null = the
   *  claude default. Applied by the supervisor on (re)launch. */
  model?: string | null;
  /** Reasoning effort (CLAUDE_CODE_EFFORT_LEVEL): low/medium/high/xhigh/max/
   *  ultracode; null = the claude default. "ultracode" adds Workflow orchestration.
   *  Shared by the on-disk identity and the dashboard-facing Agent shape. */
  effort?: string | null;
  /** Ids of roles assigned to this agent (descriptions live in the role registry). */
  roles?: string[];
  /** Ids of groups this agent belongs to (scopes who it can swarm with). */
  groups?: string[];
  /** Direct per-agent capability grants (union'd with role-based permissions). */
  permissions?: Capability[];
  /** Whether the in-container GNOME desktop + noVNC stack is enabled. Default
   *  true; turning it off saves ~2 GB of RSS (gnome-shell, mutter, etc.) for
   *  agents that don't need a browser/desktop UI. The terminal supervisor +
   *  claude TUI keep running either way. */
  desktop?: boolean;
  /** True when a /compact has been injected recently and the compaction is
   *  presumed still in flight (TTL-based — Claude doesn't expose actual state).
   *  Drives the "Compacting…" indicator on the dashboard's agent card. */
  compacting?: boolean;
  /** Fraction (0..1) of the compaction TTL elapsed — a rough progress hint
   *  for the dashboard; 0 when not compacting. */
  compactingProgress?: number;
  /** Seed for this agent's identicon avatar. Defaults to the id; reshuffleable. */
  avatarSeed?: string;
  /** Shared volumes attached to this agent (mounted at ~/Shared/<name>).
   *  Binds are fixed at container create — changes land on the next recreate. */
  volumes?: string[];
  /** Per-agent guidance, written to this agent's own ~/.claude/CLAUDE.md (its
   *  user-level memory, distinct per agent). Only populated on a single-agent
   *  fetch (getAgent), not in the fleet list. Applies on the next restart. */
  guidance?: string;
}

// --- Roles -----------------------------------------------------------------
// A role is a reusable, named responsibility with a description the agent reads
// to understand what it's expected to do. An agent can hold many roles.

export interface Role {
  /** Stable slug id (derived from the name at creation). */
  id: string;
  name: string;
  description: string;
  /** Special capability keys this role grants (see CAPABILITIES in roles.ts).
   *  An agent's effective capabilities are the union across its roles. */
  permissions?: Capability[];
  createdAt: number;
}

/** Special capabilities a role can grant over the rest of the swarm. */
export type Capability =
  | 'manage_agents'
  | 'view_screen'
  | 'compact_agents'
  | 'view_stats'
  | 'dashboard_alerts'
  | 'toggle_desktop'
  | 'set_effort'
  | 'restart_self';

/** Which upstream the agent's claude session uses. 'anthropic' = direct OAuth
 *  to Anthropic (Claude); 'opencodeGo' = the OpenCode Go subscription routed
 *  through the in-agent opencode-proxy. */
export type Provider = 'anthropic' | 'opencodeGo' | 'chatgpt';

/** The single source of truth for valid providers. Used to validate BOTH the
 *  create and patch paths — create previously accepted any string, so an agent
 *  could be created with a provider the runtime didn't understand. */
export const PROVIDERS: readonly Provider[] = ['anthropic', 'opencodeGo', 'chatgpt'];
export function isProvider(v: unknown): v is Provider {
  return typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);
}

/** Catalog entry for a provider in the UI: its label + the available models. */
export interface ProviderInfo {
  key: Provider;
  /** How this provider is authenticated, so the dashboard can render a
   *  "Connect" flow instead of a paste-a-key field. */
  auth?: 'oauth' | 'apiKey' | 'account';
  label: string;
  /** Models surfaced in the dashboard's model dropdown. */
  models: { label: string; value: string }[];
}

/** A group scopes swarm comms: agents only reach peers sharing a group. */
export interface Group {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}

/** One message in a group chat. `kind` distinguishes a peer agent from the
 *  human operator chatting via the dashboard. */
export interface GroupMessage {
  id: string;
  /** Group id the message belongs to. */
  group: string;
  /** Display name of the sender (agent name, or "operator" for the human). */
  from: string;
  /** Sender's agent id (for a stable avatar); omitted for the human operator. */
  fromId?: string;
  kind: 'agent' | 'human';
  text: string;
  ts: number;
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
  /** If non-empty, only DMs from these user IDs are forwarded (DM allow-list).
   *  Does not restrict channel messages. */
  allowedUserIds: string[];
  /** Ignore messages authored by bots (including itself). */
  ignoreBots: boolean;
  /** In server channels, only forward messages that @-mention the bot (DMs are
   *  always forwarded). Keeps the agent from reacting to unrelated chatter. */
  requireMention: boolean;
  /** When a channel watch-list is set, also forward a single @mention/reply from
   *  channels OUTSIDE the watch-list (just that message — no history/buffering),
   *  so the agent can be pulled into other channels by name. */
  respondToMentionsAnywhere: boolean;
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
  /** Initial provider ('anthropic' default; 'opencodeGo' routes via the proxy). */
  provider?: Provider;
  /** Start with the GNOME desktop disabled to save memory. Default true (on). */
  desktop?: boolean;
  /** Initial model override (ANTHROPIC_MODEL: alias/full id). Applied at first
   *  boot (a fresh session, so the env takes effect). Omit for the default. */
  model?: string;
  /** Initial reasoning effort (CLAUDE_CODE_EFFORT_LEVEL): low/medium/high/xhigh/
   *  max/ultracode. Applied at first boot. Omit for the claude default. */
  effort?: string;
  /** Role + group ids to assign at creation. */
  roles?: string[];
  groups?: string[];
  /** Initial identicon avatar seed; omit to default to the agent id. */
  avatarSeed?: string;
  /** Shared volumes to attach at creation (mounted at ~/Shared/<name>). */
  volumes?: string[];
}
