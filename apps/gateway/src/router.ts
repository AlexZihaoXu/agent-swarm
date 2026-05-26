import type { AgentRoute, ServiceName } from './types.js';

// /a/:id/(desktop|terminal)[/rest...]
//   group 1: id        (no slashes)
//   group 2: service   (desktop|terminal)
//   group 3: rest      (optional, includes leading slash)
const AGENT_PATH = /^\/a\/([^/]+)\/(desktop|terminal)(\/.*)?$/;

/**
 * Parse an incoming pathname into an agent route, or null if it isn't one.
 * `rest` is what gets forwarded to the agent (the `/a/:id/<service>` prefix is
 * stripped) so the agent's own absolute paths (`/ws`, `/api/sessions`,
 * `/websockify`) resolve unchanged.
 */
export function parseAgentPath(pathname: string): AgentRoute | null {
  const m = AGENT_PATH.exec(pathname);
  if (!m) return null;
  const [, rawId, service, rest] = m;
  const id = decodeURIComponent(rawId!);
  // Reject ids that could escape the container-name namespace.
  if (!id || id.includes('/') || id.includes('..')) return null;
  return { id, service: service as ServiceName, rest: rest && rest.length > 0 ? rest : '/' };
}
