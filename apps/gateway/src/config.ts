import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Gateway mode decides how the proxy reaches an agent container:
 *  - `network`: by container name over the shared Docker network (prod / Linux,
 *    where agents publish no host ports). Most isolated.
 *  - `ports`:   via the agent's Docker-assigned ephemeral host port, reached on
 *    127.0.0.1 (dev on macOS, where the host can't route to container IPs/DNS).
 */
export type GatewayMode = 'network' | 'ports';

function num(value: string | undefined, fallback: number): number {
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  /** Single published port — the only door into the whole swarm. */
  port: num(process.env.GATEWAY_PORT ?? process.env.PORT, 8080),
  dockerSocket: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
  mode: (process.env.GATEWAY_MODE as GatewayMode) ?? 'ports',
  /** User-defined Docker network every agent (and, in prod, the gateway) joins. */
  networkName: process.env.SWARM_NETWORK ?? 'swarm-net',
  /**
   * Compose project that spawned agents are tagged with, so Docker UIs
   * (Portainer) nest them under the dashboard stack. Defaults to this stack's
   * own project name when run via compose.
   */
  project: process.env.SWARM_PROJECT ?? process.env.COMPOSE_PROJECT_NAME ?? 'agent-swarm',
  agentImage: process.env.AGENT_IMAGE ?? 'agent-swarm/agent:dev',
  /** Container name = `${agentNamePrefix}${id}`; the id is what the URL carries. */
  agentNamePrefix: 'swarm-agent-',
  /** Host credentials file bind-mounted into each agent so it reuses host login. */
  credentialsFile:
    process.env.CLAUDE_CREDENTIALS_FILE ?? join(homedir(), '.agent-swarm', '.credentials.json'),
  /** Where to send everything that isn't /api or /a/:id — the Next.js dashboard. */
  dashboardUpstream: process.env.DASHBOARD_UPSTREAM ?? 'http://localhost:3000',
  /** In-container service ports (fixed by the agent image). */
  desktopPort: 6080,
  terminalPort: 7681,
  /** Allow the dev dashboard origin to call the API cross-origin. */
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
} as const;

export type Config = typeof config;
