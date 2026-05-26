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
}

export interface CreateAgentOptions {
  hostname?: string;
  username?: string;
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
