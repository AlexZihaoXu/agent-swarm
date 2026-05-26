import type Docker from 'dockerode';
import { config as defaultConfig, type Config } from './config.js';
import type { Agent, CreateAgentOptions, ProxyTarget, ServiceName } from './types.js';

/** Label key for the agent's friendly display name. */
const USERNAME_LABEL = 'swarm.username';
/** Hostname-safe id: alphanumerics + hyphens, 1–31 chars. */
const VALID_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,30}$/;

/** Random `workspace-XXXXXX` id, suffix from 0-9 + A-Z. */
export function generateAgentId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `workspace-${suffix}`;
}

type PortBindings =
  | Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>
  | undefined;

/**
 * Pick the loopback target for a container's published port (ports mode).
 * Pure so it can be unit-tested without Docker.
 */
export function resolveHostPort(ports: PortBindings, internalPort: number): ProxyTarget {
  const binding = ports?.[`${internalPort}/tcp`]?.find((b) => b.HostPort);
  if (!binding?.HostPort) {
    throw new Error(`agent has no published host port for ${internalPort}/tcp`);
  }
  return { host: '127.0.0.1', port: Number(binding.HostPort) };
}

/** Drives the Docker engine for agent lifecycle + proxy target resolution. */
export class AgentManager {
  constructor(
    private readonly docker: Docker,
    private readonly cfg: Config = defaultConfig,
  ) {}

  containerName(id: string): string {
    return `${this.cfg.agentNamePrefix}${id}`;
  }

  private idFromName(name: string): string {
    return name.replace(/^\//, '').slice(this.cfg.agentNamePrefix.length);
  }

  /** Create the shared network if it doesn't exist yet (idempotent). */
  async ensureNetwork(): Promise<void> {
    const nets = await this.docker.listNetworks({
      filters: JSON.stringify({ name: [this.cfg.networkName] }),
    });
    if (!nets.some((n) => n.Name === this.cfg.networkName)) {
      await this.docker.createNetwork({ Name: this.cfg.networkName, Driver: 'bridge' });
    }
  }

  /** Spawn a new agent container with the systemd/GNOME-required flags. */
  async create(opts: CreateAgentOptions = {}): Promise<Agent> {
    await this.ensureNetwork();
    const id = opts.hostname?.trim() || generateAgentId();
    if (!VALID_ID.test(id)) {
      throw Object.assign(
        new Error(`invalid hostname "${id}": use letters, digits, hyphens (max 31 chars)`),
        { statusCode: 400 },
      );
    }
    const username = opts.username?.trim();
    const name = this.containerName(id);
    const portMode = this.cfg.mode === 'ports';

    const container = await this.docker.createContainer({
      name,
      Image: this.cfg.agentImage,
      Hostname: id,
      Labels: username ? { [USERNAME_LABEL]: username } : undefined,
      ExposedPorts: { '6080/tcp': {}, '7681/tcp': {} },
      HostConfig: {
        // systemd as PID 1 + GNOME Shell need these — mirrors README run flags.
        // `CgroupnsMode` is cast in: it's a valid Docker API field that the
        // current @types/dockerode HostConfig doesn't declare yet.
        CgroupnsMode: 'host',
        Binds: [
          '/sys/fs/cgroup:/sys/fs/cgroup:rw',
          `${this.cfg.credentialsFile}:/home/agent/.claude/.credentials.json`,
        ],
        Tmpfs: { '/run': '', '/run/lock': '', '/tmp': '' },
        CapAdd: ['SYS_BOOT', 'SYS_ADMIN'],
        SecurityOpt: ['seccomp=unconfined', 'apparmor=unconfined'],
        NetworkMode: this.cfg.networkName,
        // Dev (macOS): let Docker assign ephemeral host ports so the host-run
        // gateway can reach them on 127.0.0.1 — no manual port juggling.
        PortBindings: portMode
          ? { '6080/tcp': [{ HostPort: '' }], '7681/tcp': [{ HostPort: '' }] }
          : undefined,
        RestartPolicy: { Name: 'unless-stopped' },
      } as Docker.ContainerCreateOptions['HostConfig'],
    });
    await container.start();
    return this.toAgent(await container.inspect());
  }

  async list(): Promise<Agent[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ name: [this.cfg.agentNamePrefix] }),
    });
    return containers.map((c) => ({
      id: this.idFromName(c.Names[0] ?? ''),
      name: (c.Names[0] ?? '').replace(/^\//, ''),
      image: c.Image,
      username: c.Labels?.[USERNAME_LABEL],
      status: c.State,
      createdAt: c.Created * 1000,
    }));
  }

  async start(id: string): Promise<void> {
    await this.docker.getContainer(this.containerName(id)).start();
  }

  async stop(id: string): Promise<void> {
    await this.docker.getContainer(this.containerName(id)).stop();
  }

  async remove(id: string): Promise<void> {
    await this.docker.getContainer(this.containerName(id)).remove({ force: true });
  }

  /** Resolve where the proxy should connect to reach an agent's service. */
  async resolveTarget(id: string, service: ServiceName): Promise<ProxyTarget> {
    const internalPort = service === 'desktop' ? this.cfg.desktopPort : this.cfg.terminalPort;
    if (this.cfg.mode === 'network') {
      return { host: this.containerName(id), port: internalPort };
    }
    const info = await this.docker.getContainer(this.containerName(id)).inspect();
    return resolveHostPort(info.NetworkSettings?.Ports as PortBindings, internalPort);
  }

  private toAgent(info: Docker.ContainerInspectInfo): Agent {
    const name = info.Name.replace(/^\//, '');
    return {
      id: this.idFromName(info.Name),
      name,
      image: info.Config.Image,
      username: info.Config.Labels?.[USERNAME_LABEL],
      status: info.State.Status,
      createdAt: Date.parse(info.Created),
    };
  }
}
