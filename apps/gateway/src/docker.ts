import { readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Readable } from 'node:stream';
import type Docker from 'dockerode';
import { config as defaultConfig, type Config } from './config.js';
import { getSettings } from './settings.js';
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
  private building = false;

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
    if (!(await this.imagePresent())) {
      throw Object.assign(new Error(`agent image "${this.cfg.agentImage}" is not built`), {
        statusCode: 409,
      });
    }
    const username = opts.username?.trim();
    const name = this.containerName(id);
    const portMode = this.cfg.mode === 'ports';
    // The credentials path is operator-selectable at runtime (settings).
    const credentialsFile = getSettings().credentialsFile;

    // Tag with the stack's compose project so Docker UIs (Portainer) nest the
    // agent under the dashboard, plus our own marker for management.
    const labels: Record<string, string> = {
      'swarm.managed': 'true',
      'com.docker.compose.project': this.cfg.project,
    };
    if (username) labels[USERNAME_LABEL] = username;

    const container = await this.docker.createContainer({
      name,
      Image: this.cfg.agentImage,
      Hostname: id,
      Labels: labels,
      ExposedPorts: { '6080/tcp': {}, '7681/tcp': {} },
      HostConfig: {
        // systemd as PID 1 + GNOME Shell need these — mirrors README run flags.
        // `CgroupnsMode` is cast in: it's a valid Docker API field that the
        // current @types/dockerode HostConfig doesn't declare yet.
        CgroupnsMode: 'host',
        Binds: [
          '/sys/fs/cgroup:/sys/fs/cgroup:rw',
          `${credentialsFile}:/home/agent/.claude/.credentials.json`,
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

  /** Whether the agent image exists locally. */
  async imagePresent(): Promise<boolean> {
    try {
      await this.docker.getImage(this.cfg.agentImage).inspect();
      return true;
    } catch {
      return false;
    }
  }

  /** Whether an agent-image build is currently running. */
  get isBuilding(): boolean {
    return this.building;
  }

  /**
   * Build the agent image from the bundled context, forwarding each daemon
   * progress event to `onLine` as a text line. Resolves when the build
   * finishes; rejects if it fails. Guards against concurrent builds.
   */
  async buildAgentImageStreaming(onLine: (text: string) => void): Promise<void> {
    if (this.building)
      throw Object.assign(new Error('a build is already running'), {
        statusCode: 409,
      });
    this.building = true;
    try {
      const src = readdirSync(this.cfg.agentContextDir);
      const stream = (await this.docker.buildImage(
        { context: this.cfg.agentContextDir, src },
        { t: this.cfg.agentImage },
      )) as unknown as Readable;
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(
          stream,
          (err) => (err ? reject(err) : resolve()),
          (ev: { stream?: string; status?: string; progress?: string; error?: string }) => {
            if (ev.error) onLine(`ERROR: ${ev.error}\n`);
            else if (ev.stream) onLine(ev.stream);
            else if (ev.status) onLine(`${ev.status}${ev.progress ? ' ' + ev.progress : ''}\n`);
          },
        );
      });
    } finally {
      this.building = false;
    }
  }

  /** Pull `image` if it isn't present locally. */
  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      /* not present — pull below */
    }
    const stream = (await this.docker.pull(image)) as unknown as Readable;
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Check whether a host path points at an existing regular file, by mounting
   * its parent directory read-only into a throwaway probe container (Docker
   * Desktop resolves bind sources under shared dirs like /Users). Returns null
   * if the check itself couldn't run (advisory, never blocks saving).
   */
  async validateHostFile(path: string): Promise<boolean | null> {
    if (!path || !path.startsWith('/')) return false;
    let container;
    try {
      await this.ensureImage(this.cfg.probeImage);
      container = await this.docker.createContainer({
        Image: this.cfg.probeImage,
        Cmd: ['test', '-f', `/probe/${basename(path)}`],
        HostConfig: { Binds: [`${dirname(path)}:/probe:ro`] },
      });
      await container.start();
      const { StatusCode } = await container.wait();
      return StatusCode === 0;
    } catch {
      return null;
    } finally {
      if (container) await container.remove({ force: true }).catch(() => {});
    }
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
