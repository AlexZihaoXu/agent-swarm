import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Where persisted gateway state lives. In the container SETTINGS_FILE points at
 *  the gateway-data volume (/data); the state file sits beside it so both
 *  survive a restart. */
const settingsFile =
  process.env.SETTINGS_FILE ?? join(homedir(), '.agent-swarm', 'gateway-settings.json');

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
  /** Docker build context for the agent image, so the gateway can build it on
   * demand. In the container this is bundled at /app/agent-context; for host-dev
   * it resolves to the repo's images/agent. */
  agentContextDir:
    process.env.AGENT_CONTEXT_DIR ??
    fileURLToPath(new URL('../../../images/agent', import.meta.url)),
  /** Tiny image used to probe whether a host path exists (pulled if missing). */
  probeImage: process.env.PROBE_IMAGE ?? 'busybox',
  /** Container name = `${agentNamePrefix}${id}`; the id is what the URL carries. */
  agentNamePrefix: 'swarm-agent-',
  /** Claude Code OAuth token (`claude setup-token`) injected into each agent as
   * CLAUDE_CODE_OAUTH_TOKEN so it authenticates against the operator's
   * subscription. Bootstrapped from the env; overridable at runtime via the
   * settings API / dashboard. A long-lived token — no rotation/sync needed. */
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
  /** Where runtime settings are persisted. */
  settingsFile,
  /** Persisted gateway runtime state (resource history, cached rate limits) so
   *  the dashboard restores its graphs after a restart. Beside the settings file
   *  (i.e. in the gateway-data volume). */
  stateFile: process.env.GATEWAY_STATE_FILE ?? join(dirname(settingsFile), 'gateway-state.json'),
  /** Global role registry (name + description), assignable to agents. */
  rolesFile: process.env.ROLES_FILE ?? join(dirname(settingsFile), 'roles.json'),
  /** Global group registry (scopes swarm communication). */
  groupsFile: process.env.GROUPS_FILE ?? join(dirname(settingsFile), 'groups.json'),
  /** Per-group chat logs (the running group-chat transcript shown in the UI). */
  groupChatsFile: process.env.GROUP_CHATS_FILE ?? join(dirname(settingsFile), 'group-chats.json'),
  /** Shared-volume registry (name + size of each loop-image-backed volume). */
  volumesFile: process.env.VOLUMES_FILE ?? join(dirname(settingsFile), 'volumes.json'),
  /**
   * Persistent agent disks. Each agent's home is bind-mounted from
   * `${swarmDataHost}/agents/<id>` on the HOST (the daemon resolves this), and
   * the gateway sees that same tree at `${swarmDataMount}` (mounted into this
   * container) so it can seed / package / delete it directly. Packages live in
   * `${swarmDataMount}/packages`.
   */
  swarmDataHost: process.env.SWARM_DATA_HOST ?? join(homedir(), '.agent-swarm', 'swarm_data'),
  swarmDataMount: process.env.SWARM_DATA_MOUNT ?? '/swarmdata',
  /** Where to send everything that isn't /api or /a/:id — the Next.js dashboard. */
  dashboardUpstream: process.env.DASHBOARD_UPSTREAM ?? 'http://localhost:3000',
  /** Shared-memory size for agent containers (MB). Chrome shuttles compositor
   *  textures through /dev/shm; the 64MB default crashes it (SIGTRAP). */
  agentShmMb: num(process.env.AGENT_SHM_MB, 512),
  /** Pass the host GPU (/dev/dri) into agents for hardware-accelerated graphics.
   *  Opt-in (only set on hosts with a GPU); creation falls back to software if
   *  the device is missing. */
  agentGpu: /^(1|true|yes|on)$/i.test(process.env.AGENT_GPU ?? ''),
  /** Container runtime for agents. Set to `sysbox-runc` on a host with Sysbox
   *  installed to run the systemd/GNOME desktop UNPRIVILEGED inside a user
   *  namespace (container-root maps to an unprivileged host uid) — this lets us
   *  drop SYS_ADMIN + the unconfined seccomp/apparmor profiles + cgroupns=host.
   *  Empty = the default `runc` (which still needs those privileges to boot
   *  systemd/GNOME — the macOS dev path, where Sysbox isn't available). */
  agentRuntime: process.env.AGENT_RUNTIME?.trim() || '',
  /** Trust X-Forwarded-* headers (client IP for rate-limiting, proto for the
   *  Secure cookie). Only enable when a trusted reverse proxy sets them — these
   *  headers are forgeable by clients reaching the gateway directly, so the
   *  default is OFF (use the real socket peer / direct TLS only). */
  trustProxy: /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY ?? ''),
  /** In-container service ports (fixed by the agent image). */
  desktopPort: 6080,
  terminalPort: 7681,
  /** Allow the dev dashboard origin to call the API cross-origin. */
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
} as const;

export type Config = typeof config;
