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
  /** Friendly display name (stored as a container label; the OS user stays `agent`). */
  username?: string;
  /** Docker container state, e.g. "running", "exited", "created". */
  status: string;
  createdAt: number;
}

/** Options accepted when creating an agent. */
export interface CreateAgentOptions {
  /** Desired hostname → becomes the agent id + container name + Docker hostname. */
  hostname?: string;
  /** Friendly display name shown in the dashboard. */
  username?: string;
}
