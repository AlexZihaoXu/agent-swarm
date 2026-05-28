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
}

export interface CreateAgentOptions {
  hostname?: string;
  username?: string;
  /** Hard CPU limit in cores. Omit for unlimited. */
  cpus?: number;
  /** Hard memory limit in MB. Omit for unlimited. */
  memoryMb?: number;
  /** IANA timezone, e.g. "America/New_York". */
  timezone?: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GATEWAY_BASE}${path}`, init);
  if (!res.ok) {
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
  credentialsFile: string;
  default: string;
}

export interface ImageStatus {
  image: string;
  present: boolean;
  building: boolean;
}

export const getSettings = () => api<Settings>('/api/settings');
export const updateSettings = (credentialsFile: string) =>
  api<Settings & { validated: boolean | null }>('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialsFile }),
  });

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
  kind: 'text' | 'tool' | 'plan' | 'todos';
  text?: string;
  name?: string;
  detail?: string;
  todos?: ChatTodo[];
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
}
/** Host hardware limits, to cap the per-agent resource sliders. */
export const getHostInfo = () => api<HostInfo>('/api/host');

export const listAgents = () => api<Agent[]>('/api/agents');
export const createAgent = (opts: CreateAgentOptions = {}) =>
  api<Agent>('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
export const startAgent = (id: string) => api(`/api/agents/${id}/start`, { method: 'POST' });
export const stopAgent = (id: string) => api(`/api/agents/${id}/stop`, { method: 'POST' });
export const removeAgent = (id: string) => api(`/api/agents/${id}`, { method: 'DELETE' });

/** Rename an agent's display name (live — updates the on-disk identity). */
export const renameAgent = (id: string, username: string) =>
  api<Agent>(`/api/agents/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });

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
