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
