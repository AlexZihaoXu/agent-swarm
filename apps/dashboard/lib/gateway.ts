// Thin client for the gateway's lifecycle API + URL builders for the per-agent
// proxy routes. In dev GATEWAY_BASE points at :8080; in prod it's '' (the
// gateway serves the dashboard same-origin) so every URL is relative.
export const GATEWAY_BASE = process.env.NEXT_PUBLIC_GATEWAY_URL ?? '';

export interface Agent {
  id: string;
  name: string;
  image: string;
  username?: string;
  status: string;
  createdAt: number;
  cpus?: number;
  memoryMb?: number;
  timezone?: string;
  /** Per-agent CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (1–100); null = claude default. */
  autoCompactPct?: number | null;
  /** Backend the agent's claude talks to. Default 'anthropic'. */
  provider?: Provider;
  /** Configured model override (ANTHROPIC_MODEL); null = claude default. */
  model?: string | null;
  /** Reasoning effort (CLAUDE_CODE_EFFORT_LEVEL); null = claude default. */
  effort?: string | null;
  /** Assigned role ids + group ids. */
  roles?: string[];
  groups?: string[];
  /** Direct per-agent capability grants (union'd with role-based permissions). */
  permissions?: Capability[];
  /** Whether the in-container GNOME desktop + noVNC stack is on. Default true.
   *  Turning it off saves ~2 GB RSS per agent; the terminal supervisor + claude
   *  TUI keep running either way. */
  desktop?: boolean;
  /** True while a /compact is presumed still in flight — the dashboard shows a
   *  "Compacting…" chip on the card. Set when the gateway injects /compact;
   *  clears after a ~75s TTL (Claude doesn't expose actual progress). */
  compacting?: boolean;
  /** Rough progress hint (0..1) for the compacting indicator's bar. */
  compactingProgress?: number;
  /** Identicon avatar seed (defaults to the id; reshuffleable). */
  avatarSeed?: string;
  /** Shared volumes attached to this agent (mounted at ~/Shared/<name>).
   *  Binds are fixed at container create — changes land on the next recreate. */
  volumes?: string[];
  /** Per-agent guidance written to this agent's own ~/.claude/CLAUDE.md (its
   *  user-level memory, distinct per agent). Only present on a single-agent
   *  fetch (getAgent), not the fleet list. Applies on the next restart. */
  guidance?: string;
}

// --- Roles & groups --------------------------------------------------------

/** A special capability a role can grant over the rest of the swarm. */
export type Capability =
  | 'manage_agents'
  | 'view_screen'
  | 'compact_agents'
  | 'view_stats'
  | 'dashboard_alerts'
  | 'toggle_desktop'
  | 'set_effort'
  | 'restart_self';

export interface Role {
  id: string;
  name: string;
  description: string;
  /** Special capabilities this role grants (roles only; groups never have any). */
  permissions?: Capability[];
  createdAt: number;
}
export type Group = Role; // same shape

export interface CapabilityInfo {
  key: Capability;
  label: string;
  description: string;
  /** Verbose description of the exact agent-side MCP tool this capability
   *  unlocks — surfaced behind a "?" popover next to the toggle so the
   *  operator can read, before granting, what the agent will actually be
   *  able to do. */
  mcpHelp?: string;
}
export const listCapabilities = () => api<CapabilityInfo[]>('/api/capabilities');

export const listRoles = () => api<Role[]>('/api/roles');
export const createRole = (name: string, description: string, permissions?: Capability[]) =>
  api<Role>('/api/roles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, description, permissions }),
  });
export const updateRole = (
  id: string,
  patch: { name?: string; description?: string; permissions?: Capability[] },
) =>
  api<Role>(`/api/roles/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
export const deleteRole = (id: string) =>
  api<{ ok: true }>(`/api/roles/${id}`, { method: 'DELETE' });

export const listGroups = () => api<Group[]>('/api/groups');
export const createGroup = (name: string, description: string) =>
  api<Group>('/api/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, description }),
  });
export const updateGroup = (id: string, patch: { name?: string; description?: string }) =>
  api<Group>(`/api/groups/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
export const deleteGroup = (id: string) =>
  api<{ ok: true }>(`/api/groups/${id}`, { method: 'DELETE' });

// --- Group chat -------------------------------------------------------------

export interface GroupMessage {
  id: string;
  group: string;
  /** Sender display name (agent name, or "operator" for the human). */
  from: string;
  /** Sender's agent id (for a stable avatar); absent for the human operator. */
  fromId?: string;
  kind: 'agent' | 'human';
  text: string;
  ts: number;
}
/** The running chat log for a group (oldest first). */
export const listGroupMessages = (id: string) => api<GroupMessage[]>(`/api/groups/${id}/messages`);
/** Send a message to a group's chat as the human operator (fans out to all
 *  agents in the group). */
export const sendGroupMessage = (group: string, text: string) =>
  api<{ ok: true; message: GroupMessage }>('/api/swarm/group-send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ group, text }),
  });

export interface CreateAgentOptions {
  hostname?: string;
  username?: string;
  /** Hard CPU limit in cores. Omit for unlimited. */
  cpus?: number;
  /** Hard memory limit in MB. Omit for unlimited. */
  memoryMb?: number;
  /** IANA timezone, e.g. "America/New_York". */
  timezone?: string;
  /** Initial provider ('anthropic' default; 'opencodeGo' routes via the proxy). */
  provider?: Provider;
  /** Initial model override (ANTHROPIC_MODEL alias/id); omit for default. */
  model?: string;
  /** Initial reasoning effort (low/medium/high/xhigh/max/ultracode); omit for default. */
  effort?: string;
  /** Role + group ids to assign at creation. */
  roles?: string[];
  groups?: string[];
  /** Start with the GNOME desktop on (default true). Set false to save ~2GB
   *  RSS for agents that don't need a browser. */
  desktop?: boolean;
  /** Initial identicon avatar seed; omit to default to the agent id. */
  avatarSeed?: string;
  /** Shared volumes to attach at creation (mounted at ~/Shared/<name>). */
  volumes?: string[];
}

// --- Shared volumes ----------------------------------------------------------
// Loop-image-backed ext4 filesystems shared between agents; the fixed fs size
// is the hard cap (writes past it fail with ENOSPC). Attached volumes appear
// inside the agent at ~/Shared/<name>; attach/detach applies on the agent's
// next recreate (binds are fixed at container create).

export interface SharedVolume {
  name: string;
  sizeMb: number;
  createdAt: number;
  /** Live used MB (null when unmounted / not yet propagated). */
  usedMb: number | null;
  /** Whether the loop filesystem is currently mounted on the host. */
  mounted: boolean;
  /** Agents whose identity lists this volume. */
  attachedTo: { id: string; name: string }[];
}

export const VOLUME_MIN_MB = 64;
export const VOLUME_MAX_MB = 16384;

export const listVolumes = () => api<SharedVolume[]>('/api/volumes');
export const createVolume = (name: string, sizeMb: number) =>
  api<SharedVolume>('/api/volumes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, sizeMb }),
  });
export const deleteVolume = (name: string) =>
  api<{ ok: true }>(`/api/volumes/${encodeURIComponent(name)}`, { method: 'DELETE' });
/** Recreate the agent's container (new HostConfig — applies volume attach/detach
 *  immediately). The home disk persists; the claude session resumes via
 *  --continue. */
export const recreateAgent = (id: string) =>
  api<Agent>(`/api/agents/${id}/recreate`, { method: 'POST' });

/** Anthropic-provider model choices ('' = claude's default). Aliases stay
 *  current across model releases, so they're preferred over ids. Kept as a
 *  fallback when the live /api/providers/info call fails. */
export const MODEL_OPTIONS: { label: string; value: string }[] = [
  { label: 'Default', value: '' },
  { label: 'Opus', value: 'opus' },
  { label: 'Sonnet', value: 'sonnet' },
  { label: 'Haiku', value: 'haiku' },
];

// --- Providers --------------------------------------------------------------
// The backend the agent's claude talks to. 'anthropic' = direct OAuth (the
// historical default); 'opencodeGo' = the OpenCode Go subscription routed
// through the in-agent opencode-proxy.

export type Provider = 'anthropic' | 'opencodeGo';

export interface ProviderInfo {
  key: Provider;
  label: string;
  models: { label: string; value: string }[];
}

/** Catalog of providers + their model lists, served by the gateway so the
 *  dashboard's dropdowns stay in sync when models are added without a
 *  front-end change. */
export const listProviders = () => api<ProviderInfo[]>('/api/providers/info');

export interface ProvidersStatus {
  opencodeGo: { hasKey: boolean; keyHint: string | null };
}
export const getProviders = () => api<ProvidersStatus>('/api/providers');
/** Update one or more provider credentials. Pass `opencodeGo: { apiKey: '' }`
 *  to clear; omit a provider to leave it unchanged. */
export const updateProviders = (patch: { opencodeGo?: { apiKey: string } }) =>
  api<{ ok: true }>('/api/providers', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GATEWAY_BASE}${path}`, init);
  if (!res.ok) {
    // A 401 on a normal route means the session expired/absent → bounce to login.
    // (The /api/auth/* routes surface their own 401s — e.g. a wrong password.)
    if (
      res.status === 401 &&
      !path.startsWith('/api/auth/') &&
      typeof window !== 'undefined' &&
      window.location.pathname !== '/login'
    ) {
      window.location.href = '/login';
      throw new Error('unauthorized');
    }
    // Prefer the gateway's {error} message; fall back to the status line.
    const msg = await res
      .clone()
      .json()
      .then((b: { error?: string }) => b.error)
      .catch(() => undefined);
    throw new Error(msg ?? `${init?.method ?? 'GET'} ${path} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface Settings {
  /** Whether a Claude OAuth token is configured (the value is never returned). */
  hasToken: boolean;
  /** Last 4 chars of the token, for a "••••1a2b" display. */
  tokenHint: string | null;
  /** Whether the token came from the CLAUDE_CODE_OAUTH_TOKEN env (vs set in UI). */
  fromEnv: boolean;
  /** Days until the token's assumed ~1y expiry; null if unknown. */
  daysLeft: number | null;
  /** Warn (banner) when daysLeft is at or below this. */
  warnDays: number;
}

export interface ImageStatus {
  image: string;
  present: boolean;
  building: boolean;
}

// --- Auth (operator login) --------------------------------------------------

export interface AuthStatus {
  /** Whether an operator login has been created (false → first-run setup). */
  configured: boolean;
  /** Whether the current request carries a valid session. */
  authed: boolean;
}
const authPost = (path: string, body: Record<string, string>) =>
  api<{ ok: true }>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
export const getAuthStatus = () => api<AuthStatus>('/api/auth/status');
/** First-run: create the operator login (also logs in). */
export const setupLogin = (username: string, password: string) =>
  authPost('/api/auth/setup', { username, password });
export const login = (username: string, password: string) =>
  authPost('/api/auth/login', { username, password });
export const logout = () => authPost('/api/auth/logout', {});
export const changePassword = (currentPassword: string, newPassword: string) =>
  authPost('/api/auth/password', { currentPassword, newPassword });

export const getSettings = () => api<Settings>('/api/settings');
/** Reveal the full stored OAuth token (operator-only). */
export const getOauthToken = () => api<{ token: string }>('/api/settings/token');
/** Set/clear the Claude OAuth token (`claude setup-token`). Empty clears it back
 *  to the env default. */
export const updateSettings = (oauthToken: string) =>
  api<{ hasToken: boolean }>('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oauthToken }),
  });

// --- Discord client (operator posts as the agent's bot) ----------------------

export interface DiscordGuild {
  id: string;
  name: string;
  iconUrl: string | null;
}
export interface DiscordChannel {
  id: string;
  type: number;
  name: string;
  parentId: string | null;
  position: number;
  topic: string | null;
}
export interface DiscordAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  bot: boolean;
}
export interface DiscordAttachment {
  id: string;
  filename: string;
  url: string;
  contentType: string | null;
  width: number | null;
  height: number | null;
  size: number;
}
export interface DiscordEmbed {
  title: string | null;
  description: string | null;
  url: string | null;
  color: number | null;
  timestamp: string | null;
  footer: string | null;
  authorName: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  fields: { name: string; value: string; inline: boolean }[];
}

export interface DiscordMessage {
  id: string;
  channelId: string;
  content: string;
  /** Discord message type; anything other than 0/19 is a system event whose
   *  text Discord synthesizes client-side (see SYSTEM_TEXT in DiscordClient). */
  type: number;
  timestamp: string;
  editedTimestamp: string | null;
  author: DiscordAuthor;
  attachments: DiscordAttachment[];
  embeds: DiscordEmbed[];
  mentions: { id: string; displayName: string }[];
  reactions: { emoji: string; count: number; me: boolean }[];
  replyTo: { id: string; author: string; content: string } | null;
  self: boolean;
}

/** Category channels group the text channels beneath them in the sidebar. */
export const DISCORD_CATEGORY = 4;

const dcBase = (id: string) => `/api/agents/${encodeURIComponent(id)}/discord`;

/** The bot's identity plus its LIVE presence, so the client can show what the
 *  bot actually looks like in Discord (online/idle + its status quote). */
export interface DiscordSelf extends DiscordAuthor {
  connected: boolean;
  presence: 'online' | 'idle' | null;
  customStatus: string | null;
}
export const discordWhoami = (id: string) => api<DiscordSelf>(`${dcBase(id)}/whoami`);
export const discordUser = (id: string, user: string) =>
  api<DiscordAuthor>(`${dcBase(id)}/user?id=${encodeURIComponent(user)}`);
export const discordGuilds = (id: string) => api<DiscordGuild[]>(`${dcBase(id)}/guilds`);
export const discordChannels = (id: string, guild: string) =>
  api<DiscordChannel[]>(`${dcBase(id)}/channels?guild=${encodeURIComponent(guild)}`);
export const discordMessages = (
  id: string,
  channel: string,
  opts: { limit?: number; before?: string; self?: string } = {},
) => {
  const qs = new URLSearchParams({ channel });
  if (opts.limit) qs.set('limit', String(opts.limit));
  if (opts.before) qs.set('before', opts.before);
  if (opts.self) qs.set('self', opts.self);
  return api<DiscordMessage[]>(`${dcBase(id)}/messages?${qs}`);
};
/** Guild-wide search. Rides Discord's bot search preview — verified working
 *  here, but it can 403 on other apps, so callers must surface the error. */
export const discordSearch = (
  id: string,
  guild: string,
  q: string,
  opts: { channel?: string; limit?: number } = {},
) => {
  const qs = new URLSearchParams({ guild, q });
  if (opts.channel) qs.set('channel', opts.channel);
  if (opts.limit) qs.set('limit', String(opts.limit));
  return api<DiscordMessage[]>(`${dcBase(id)}/search?${qs}`);
};
export const discordSend = (id: string, channel: string, content: string, replyTo?: string) =>
  api<DiscordMessage>(`${dcBase(id)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, content, replyTo }),
  });
export const discordReact = (id: string, channel: string, message: string, emoji: string) =>
  api<{ ok: true }>(`${dcBase(id)}/react`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, message, emoji }),
  });
/** Bots can't enumerate their DMs, so a DM is addressed by user id. */
export const discordOpenDm = (id: string, user: string) =>
  api<{ channelId: string }>(`${dcBase(id)}/dm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user }),
  });

// --- Known IPs ---------------------------------------------------------------

/** An operator-assigned friendly name for a client IP, so the auth log reads
 *  "operator@home" for an address you recognize. */
export interface IpNameEntry {
  ip: string;
  name: string;
}

export const listIpNames = () => api<IpNameEntry[]>('/api/settings/ip-names');
/** Whole-list replace — the settings card edits the map as a unit. */
export const updateIpNames = (ipNames: IpNameEntry[]) =>
  api<{ ok: true }>('/api/settings/ip-names', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ipNames }),
  });

/** Same canonicalization the gateway applies, so a name set for "1.2.3.4"
 *  still matches an event logged as "::ffff:1.2.3.4". */
export function normalizeIp(raw: string): string {
  let ip = String(raw ?? '')
    .trim()
    .toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1] ?? ip;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  if (ip.startsWith('::ffff:') && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip.slice(7))) ip = ip.slice(7);
  return ip;
}

export const getImageStatus = () => api<ImageStatus>('/api/image');

export interface DirListing {
  path: string;
  parent: string | null;
  entries: { name: string; dir: boolean }[];
}

export const listHostDir = (path?: string) =>
  api<DirListing>(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ''}`);

/** POST the build and stream the daemon's progress text line-by-line. */
export async function buildImage(onChunk: (text: string) => void): Promise<void> {
  const res = await fetch(`${GATEWAY_BASE}/api/image/build`, { method: 'POST' });
  if (!res.body) throw new Error('build produced no output stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
}

// --- Audit / event log ------------------------------------------------------

export type AuditCategory =
  | 'auth'
  | 'agent'
  | 'docker'
  | 'swarm'
  | 'integration'
  | 'settings'
  | 'file'
  | 'system';
export type AuditLevel = 'info' | 'warn' | 'error';

export interface AuditEvent {
  id: string;
  ts: number;
  category: AuditCategory;
  action: string;
  level: AuditLevel;
  message: string;
  actor: { kind: 'operator' | 'agent' | 'system'; id?: string; name?: string; ip?: string };
  agentId?: string;
  target?: string;
  durationMs?: number;
  ok?: boolean;
  meta?: Record<string, unknown>;
}

export interface AuditMeta {
  timezone: string;
  categories: AuditCategory[];
  levels: AuditLevel[];
  total: number;
  byCategory: Record<string, number>;
  byLevel: Record<string, number>;
}

export interface AuditFilters {
  from?: number;
  to?: number;
  category?: AuditCategory | '';
  action?: string;
  agentId?: string;
  actor?: 'operator' | 'agent' | 'system' | '';
  level?: AuditLevel | '';
  q?: string;
  limit?: number;
  before?: string;
}

function auditQs(f: AuditFilters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== '' && v !== null) p.set(k, String(v));
  }
  return p.toString();
}

export const getAuditMeta = () => api<AuditMeta>('/api/audit/meta');

export const listAudit = (f: AuditFilters = {}) =>
  api<{ events: AuditEvent[]; hasMore: boolean; timezone: string }>(`/api/audit?${auditQs(f)}`);

/** Open the live NDJSON stream and call `onEvent` per event until aborted. */
export async function streamAudit(
  f: AuditFilters,
  onEvent: (ev: AuditEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${GATEWAY_BASE}/api/audit/stream?${auditQs(f)}`, { signal });
  if (!res.body) throw new Error('audit stream produced no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? ''; // keep the trailing partial line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as AuditEvent);
      } catch {
        /* skip a malformed line */
      }
    }
  }
}

/** `YYYY-MM-DD HH:MM:SS` for an epoch-ms time in an IANA timezone (mirrors the
 *  gateway's Minecraft-style timestamp). */
export function formatAuditTimestamp(ts: number, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(ts);
    const g = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
    return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`;
  } catch {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  }
}

export interface AgentTask {
  id: string;
  subject: string;
  activeForm?: string;
  status: string;
}

export interface AgentStats {
  model: string | null;
  status: string | null;
  sessionId: string | null;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
  };
  /** Current context-window usage (most recent turn's input side). */
  context: number;
  /** The model's context-window size (from statusline), for the usage ring. */
  contextLimit?: number | null;
  /** Live spinner state while busy (scraped from the TUI): the playful gerund
   *  ("Honking"), elapsed time ("10m 5s"), generated tokens, and whether it's
   *  thinking — mirrors the TUI's flashing indicator. */
  activity?: {
    thinking: boolean;
    genTokens: number | null;
    verb?: string | null;
    elapsed?: string | null;
  } | null;
  turns: number;
  cost: number | null;
  linesAdded: number;
  linesRemoved: number;
  exceeds200k: boolean;
  lastActivity: string | number | null;
  /** An interactive selector (AskUserQuestion/plan/permission) is open and
   * waiting. TUI-only, but answerable from chat by driving the selector. */
  awaitingInput?: boolean;
  /** Best-effort text of the pending question, if we could read it. */
  promptText?: string | null;
  /** Parsed numbered choices of the open selector (for one-click answers). */
  promptOptions?: { n: number; label: string; checkable?: boolean; checked?: boolean }[];
  /** The open selector is a multi-select (checkboxes + Submit). */
  promptMultiSelect?: boolean;
  /** The agent's current task list (TaskCreate/TaskUpdate), for a live checklist. */
  tasks?: AgentTask[];
}

/** Live session stats for one agent, served by the agent's terminal supervisor. */
export const getAgentStats = (id: string) => api<AgentStats>(`/a/${id}/terminal/api/stats`);
/** WebSocket that streams the stats snapshot ~1/s. */
export const statsStreamUrl = (id: string) => `${wsOrigin()}/a/${id}/terminal/stats`;
/** Low-res desktop screenshot (for fleet-card previews). */
export const screenshotUrl = (id: string) => `${GATEWAY_BASE}/a/${id}/terminal/api/screenshot`;

export interface ChatTodo {
  content: string;
  activeForm?: string;
  status: string;
}
export interface ChatItem {
  kind: 'text' | 'tool' | 'plan' | 'todos' | 'image' | 'thinking';
  text?: string;
  name?: string;
  detail?: string;
  todos?: ChatTodo[];
  /** For kind 'image': the saved screenshot filename, served at
   *  /a/<id>/terminal/api/shots/<file>. */
  file?: string;
}
export interface ChatTurn {
  role: 'user' | 'assistant';
  ts: string | number | null;
  items: ChatItem[];
  /** Set when this is an API/transport error message, not a real reply. */
  error?: boolean;
}

/** Normalized conversation (user/assistant turns) for the chat view. */
export const getTranscript = (id: string) => api<ChatTurn[]>(`/a/${id}/terminal/api/transcript`);

/** Faithful colored HTML of the open interactive selector (null when none). */
export const getPromptHtml = (id: string) =>
  api<{ html: string | null }>(`/a/${id}/terminal/api/prompt`);
/** WebSocket to a terminal session — used to send chat input to `claude`. */
export const terminalWsUrl = (id: string, session = 'claude') =>
  `${wsOrigin()}/a/${id}/terminal/ws?session=${encodeURIComponent(session)}&cols=80&rows=24`;

/** Upload a file into the agent (~/uploads); returns its in-agent path. */
export async function uploadToAgent(id: string, file: File): Promise<string> {
  const res = await fetch(
    `${GATEWAY_BASE}/a/${id}/terminal/api/upload?name=${encodeURIComponent(file.name)}`,
    { method: 'POST', body: file },
  );
  if (!res.ok) throw new Error(`upload failed → ${res.status}`);
  return (await res.json()).path as string;
}

export interface UpgradeInfo {
  installed: number;
  latest: number;
  outdated: boolean;
  pending: { version: number; name: string }[];
}

/** Migration/upgrade status for one agent. */
export const getUpgradeInfo = (id: string) => api<UpgradeInfo>(`/api/agents/${id}/upgrade`);
/** Run pending migrations against a live agent (no recreate). */
export const upgradeAgent = (id: string) =>
  api<UpgradeInfo>(`/api/agents/${id}/upgrade`, { method: 'POST' });

// --- Packaging (persistent disk → portable .7z) ---------------------------
export interface AgentPath {
  name: string;
  dir: boolean;
}
export interface PackageInfo {
  file: string;
  bytes: number;
  createdAt?: number;
}

/** Top-level folders/files of an agent's persistent home (for the picker). */
export const getAgentPaths = (id: string) => api<AgentPath[]>(`/api/agents/${id}/paths`);
/** Stop the agent and 7z the selected sub-paths of its disk. */
export const packageAgent = (id: string, paths: string[]) =>
  api<PackageInfo>(`/api/agents/${id}/package`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths }),
  });
/** Direct download URL for a built package (.7z). */
export const packageDownloadUrl = (file: string) =>
  `${GATEWAY_BASE}/api/packages/${encodeURIComponent(file)}/download`;
/** Create a NEW agent restored from a package (duplicate / import). */
export const importPackage = (file: string, opts: CreateAgentOptions = {}) =>
  api<Agent>(`/api/packages/${encodeURIComponent(file)}/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
/** All built/uploaded packages, newest first. */
export const listPackages = () => api<PackageInfo[]>('/api/packages');
/** Delete a package. */
export const deletePackage = (file: string) =>
  api(`/api/packages/${encodeURIComponent(file)}`, { method: 'DELETE' });
/** Upload a .7z brought from another swarm into this one's packages. */
export async function uploadPackage(file: File): Promise<{ file: string }> {
  const res = await fetch(
    `${GATEWAY_BASE}/api/packages/upload?name=${encodeURIComponent(file.name)}`,
    { method: 'POST', body: file },
  );
  if (!res.ok) throw new Error(`upload failed → ${res.status}`);
  return res.json();
}

export interface HostInfo {
  cpus: number;
  memoryMb: number;
  /** Host disk (MB) for the filesystem holding agent data. */
  diskTotalMb: number;
  diskUsedMb: number;
}
/** Host hardware limits, to cap the per-agent resource sliders. */
export const getHostInfo = () => api<HostInfo>('/api/host');

export interface RateWindow {
  usedPercent: number;
  resetsAt: number;
}
export interface Metrics {
  /** Account-level 5h / 7d usage windows (shared across agents). `updatedAt` is
   *  when the values last changed (= last API activity); used to mark the rings
   *  outdated when the account has been idle for >5m. */
  rateLimits: { fiveHour: RateWindow; sevenDay: RateWindow; updatedAt: number } | null;
  /** Window length in hours the rest of this payload covers (echoes the
   *  requested ?hours, clamped to [1..168]). */
  rangeHours: number;
  /** Per-agent totals (tokens + computed cost) over the requested window. */
  agents: { id: string; name: string; tokens: number; cost: number }[];
  /** Aggregate (oldest→newest) buckets summed across agents. Bucket width
   *  scales with the range so the chart stays around 24 bars. */
  buckets: { t: number; tokens: number; cost: number }[];
  /** Per-agent cpu%/memory history over the requested window. Downsampled to
   *  ≤300 points server-side so long ranges stay responsive. */
  usage: {
    series: { id: string; name: string }[];
    points: { t: number; cpu: Record<string, number>; mem: Record<string, number> }[];
  };
}
/** Time-range options offered in the graph context menus. Drives the
 *  rangeHours state at the top of DashboardMetrics; the gateway clamps to
 *  [1..168] so a bogus value just falls back to 12h. */
export const METRICS_RANGES: { key: string; label: string; hours: number }[] = [
  { key: '12h', label: '12 hours', hours: 12 },
  { key: '24h', label: '24 hours', hours: 24 },
  { key: '3d', label: '3 days', hours: 72 },
  { key: '7d', label: '7 days', hours: 168 },
];

/** Reasoning-effort options for the agent's claude session. `''` = the model's
 *  default. "ultracode" is max effort + multi-agent Workflow orchestration. */
export const EFFORT_OPTIONS: { label: string; value: string }[] = [
  { label: 'Default', value: '' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Extra high', value: 'xhigh' },
  { label: 'Max', value: 'max' },
  { label: 'Ultracode', value: 'ultracode' },
];
/** Global usage metrics over the requested window (defaults to 12h). */
export const getMetrics = (hours = 12) => api<Metrics>(`/api/metrics?hours=${hours}`);

export interface Usage {
  /** Total CPU across running agents (cores × 100, like `docker stats` %). */
  cpuPct: number;
  /** Total memory in use (bytes) and the summed limit. */
  memUsed: number;
  memLimit: number;
  agents: { id: string; name: string; cpuPct: number; memUsed: number; memLimit: number }[];
}
/** Live resource usage across running agents (poll fast — it's cheap). */
export const getUsage = () => api<Usage>('/api/usage');

export const listAgents = () => api<Agent[]>('/api/agents');
export const createAgent = (opts: CreateAgentOptions = {}) =>
  api<Agent>('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
export const startAgent = (id: string) => api(`/api/agents/${id}/start`, { method: 'POST' });
export const stopAgent = (id: string) => api(`/api/agents/${id}/stop`, { method: 'POST' });
/** Run Claude Code's native `/compact` in the agent's session (operator-driven). */
export const compactAgent = (id: string) =>
  api<{ ok: true }>(`/api/agents/${id}/compact`, { method: 'POST' });
export const removeAgent = (id: string) => api(`/api/agents/${id}`, { method: 'DELETE' });

/** Fetch a single agent (incl. its editable per-agent settings). */
export const getAgent = (id: string) => api<Agent>(`/api/agents/${id}`);

// --- Agent file explorer ----------------------------------------------------

export interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
  /** Modified time, epoch ms. */
  mtime: number;
}
export interface DirView {
  /** Path relative to the agent home ('' = home root). */
  path: string;
  entries: FileEntry[];
}
// --- File explorer (agent home OR shared volume) ----------------------------
// All explorer ops take a `base` URL fragment so the same component can browse
// either an agent's /home/agent (`/api/agents/<id>/files`) or a shared volume's
// root (`/api/volumes/<name>/files`).

export const agentFilesBase = (id: string) => `/api/agents/${id}/files`;
export const volumeFilesBase = (name: string) => `/api/volumes/${encodeURIComponent(name)}/files`;

export const listFiles = (base: string, path: string) =>
  api<DirView>(`${base}?op=list&path=${encodeURIComponent(path)}`);
export const readFile = (base: string, path: string) =>
  api<{ content: string }>(`${base}?op=read&path=${encodeURIComponent(path)}`);
const filesPost = (base: string, op: string, body: Record<string, string>) =>
  api<{ ok: true }>(`${base}?op=${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
export const writeFile = (base: string, path: string, content: string) =>
  filesPost(base, 'write', { path, content });
export const mkdirFile = (base: string, path: string) => filesPost(base, 'mkdir', { path });
export const renameFile = (base: string, from: string, to: string) =>
  filesPost(base, 'rename', { from, to });
export const deleteFile = (base: string, path: string) => filesPost(base, 'delete', { path });
/** Direct URL for downloading a file (same-origin → the session cookie is sent). */
export const fileDownloadUrl = (base: string, path: string) =>
  `${GATEWAY_BASE}${base}?op=download&path=${encodeURIComponent(path)}`;
/** Direct URL for downloading a folder as a .zip (same-origin → cookie is sent). */
export const folderZipUrl = (base: string, path: string) =>
  `${GATEWAY_BASE}${base}?op=zip&path=${encodeURIComponent(path)}`;
/** Upload a File into `dir` (raw body; filename in the query). Uses XHR (not
 *  fetch) so `onProgress` can report the upload fraction (0..1) for a progress
 *  UI. Same-origin cookies ride along automatically (no withCredentials, matching
 *  the rest of the API client). */
export function uploadFile(
  base: string,
  dir: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const url = `${GATEWAY_BASE}${base}?op=upload&path=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`;
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
      } else {
        let msg: string | undefined;
        try {
          msg = (JSON.parse(xhr.responseText) as { error?: string }).error;
        } catch {
          /* non-JSON error body */
        }
        reject(new Error(msg ?? `upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('upload failed (network error)'));
    xhr.send(file);
  });
}

/** Patch an agent's editable settings (display name and/or auto-compact %).
 *  Live for the name; the auto-compact % applies on the next stop→start. */
export const updateAgent = (
  id: string,
  patch: {
    username?: string;
    /** Hard CPU cap in cores; null/0 = unlimited. Applies on the next rebuild. */
    cpus?: number | null;
    /** Hard memory cap in MB; null/0 = unlimited. Applies on the next rebuild. */
    memoryMb?: number | null;
    /** IANA timezone (the container's TZ); empty clears it back to UTC. Applies
     *  on the next rebuild. */
    timezone?: string | null;
    /** Per-agent guidance (this agent's ~/.claude/CLAUDE.md); empty clears it.
     *  Applies on the next restart. */
    guidance?: string | null;
    autoCompactPct?: number | null;
    provider?: Provider;
    model?: string | null;
    /** Reasoning effort (low/medium/high/xhigh/max/ultracode); empty clears it.
     *  Switches live via `/effort`, and persists across the next restart. */
    effort?: string | null;
    roles?: string[];
    groups?: string[];
    permissions?: Capability[];
    desktop?: boolean;
    avatarSeed?: string;
    volumes?: string[];
  },
) =>
  api<Agent>(`/api/agents/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });

/** Rename an agent's display name (live — updates the on-disk identity). */
export const renameAgent = (id: string, username: string) => updateAgent(id, { username });

// --- Integrations ----------------------------------------------------------
// Per-agent platform connectors (Discord first). Mirrors the gateway's
// IntegrationPublic — credentials are never returned, only a presence flag + hint.

export type IntegrationType = 'discord';
export type IntegrationStatus =
  | 'added'
  | 'configured'
  | 'tested-ok'
  | 'active'
  | 'error'
  | 'disabled';

export interface DiscordRules {
  forwardChannelIds: string[];
  forwardDms: boolean;
  /** DM allow-list (does not restrict channel messages). */
  allowedUserIds: string[];
  ignoreBots: boolean;
  requireMention: boolean;
  /** Let a single @mention/reply through from channels outside the watch-list. */
  respondToMentionsAnywhere: boolean;
}

export interface IntegrationTestResult {
  ok: boolean;
  at: number;
  detail?: string;
  botTag?: string;
  guilds?: { id: string; name: string }[];
}

export interface Integration {
  type: IntegrationType;
  status: IntegrationStatus;
  rules: DiscordRules;
  hasCredentials: boolean;
  tokenHint?: string | null;
  lastTest?: IntegrationTestResult | null;
  updatedAt: number;
}

export interface IntegrationPatch {
  credentials?: { botToken?: string };
  rules?: Partial<DiscordRules>;
}

const intBase = (id: string, type?: IntegrationType) =>
  `/api/agents/${id}/integrations${type ? `/${type}` : ''}`;

export const listIntegrations = (id: string) => api<Integration[]>(intBase(id));

export const addIntegration = (id: string, type: IntegrationType) =>
  api<Integration>(intBase(id), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type }),
  });

export const updateIntegration = (id: string, type: IntegrationType, patch: IntegrationPatch) =>
  api<Integration>(intBase(id, type), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });

export const testIntegration = (id: string, type: IntegrationType) =>
  api<Integration>(`${intBase(id, type)}/test`, { method: 'POST' });

export const applyIntegration = (id: string, type: IntegrationType) =>
  api<Integration>(`${intBase(id, type)}/apply`, { method: 'POST' });

export const disableIntegration = (id: string, type: IntegrationType) =>
  api<Integration>(`${intBase(id, type)}/disable`, { method: 'POST' });

export const removeIntegration = (id: string, type: IntegrationType) =>
  api<{ ok: true }>(intBase(id, type), { method: 'DELETE' });

/** Embeddable desktop (noVNC) URL for an agent. */
export const desktopUrl = (id: string) => `${GATEWAY_BASE}/a/${id}/desktop/`;
/** Base URL of an agent's terminal service (HTTP). */
export const terminalHttpBase = (id: string) => `${GATEWAY_BASE}/a/${id}/terminal/`;

/** Origin (http) used by the terminal client, resolving '' to the page origin. */
export function httpOrigin(): string {
  if (GATEWAY_BASE) return GATEWAY_BASE;
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/** ws(s):// origin matching httpOrigin(). */
export function wsOrigin(): string {
  return httpOrigin().replace(/^http/, 'ws');
}
