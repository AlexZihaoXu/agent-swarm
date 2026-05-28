import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import type Docker from 'dockerode';
import tar from 'tar-fs';
import { config as defaultConfig, type Config } from './config.js';
import { getSettings } from './settings.js';
import { LATEST_VERSION, migrations, VERSION_MARKER, type MigrationCtx } from './migrations.js';
import { DiscordBridge, testDiscordToken } from './discord-bridge.js';
import * as integrations from './integrations.js';
import type {
  Agent,
  CreateAgentOptions,
  IntegrationPatch,
  IntegrationPublic,
  IntegrationType,
} from './types.js';
import type { ProxyTarget, ServiceName } from './types.js';

export interface UpgradeInfo {
  installed: number;
  latest: number;
  outdated: boolean;
  pending: { version: number; name: string }[];
}

/** Label key for the agent's friendly display name (seed value; the on-disk
 *  identity file is the editable source of truth thereafter). */
const USERNAME_LABEL = 'swarm.username';
/** Labels recording the resource limits chosen at creation (for display). */
const CPUS_LABEL = 'swarm.cpus';
const MEMORY_LABEL = 'swarm.memoryMb';
const TZ_LABEL = 'swarm.timezone';
/** Hostname-safe id: alphanumerics + hyphens, 1–31 chars. */
const VALID_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,30}$/;

/** The agent's self-identity, written to its disk so it (and its MCP tools)
 *  can read its own name/id within the swarm. */
interface AgentIdentity {
  id: string;
  name: string;
  hostname: string;
  project: string;
  timezone: string | null;
  createdAt: number;
  /** CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (1–100); null = use the claude default. */
  autoCompactPct?: number | null;
}

/** Per-million-token USD pricing (mirrors the agent runtime's modelRates).
 *  cw = cache write (5-min), cr = cache read. */
function modelRates(model: string | undefined, ctxTokens: number) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return { in: 15, out: 75, cw: 18.75, cr: 1.5 };
  if (m.includes('haiku')) return { in: 1, out: 5, cw: 1.25, cr: 0.1 };
  if (ctxTokens > 200000) return { in: 6, out: 22.5, cw: 7.5, cr: 0.6 };
  return { in: 3, out: 15, cw: 3.75, cr: 0.3 };
}

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
  /** Receive-side Discord connections, keyed by agent id (apply → connect). */
  private readonly discord = new DiscordBridge();

  constructor(
    private readonly docker: Docker,
    private readonly cfg: Config = defaultConfig,
  ) {}

  containerName(id: string): string {
    return `${this.cfg.agentNamePrefix}${id}`;
  }

  /** Agent's persistent home as the HOST sees it (for bind mounts → daemon). */
  private agentHostDir(id: string): string {
    return join(this.cfg.swarmDataHost, 'agents', id);
  }
  /** Same tree as THIS container sees it (for seed/package/delete). */
  private agentDataDir(id: string): string {
    return join(this.cfg.swarmDataMount, 'agents', id);
  }
  /** Where built packages (.7z) are stored (gateway-local view). */
  private packagesDir(): string {
    return join(this.cfg.swarmDataMount, 'packages');
  }
  /** The agent's identity file, on its persistent disk (gateway-local view).
   *  Bind-mounted to /home/agent/.swarm/identity.json inside the agent. */
  private identityFile(id: string): string {
    return join(this.agentDataDir(id), '.swarm', 'identity.json');
  }

  /** Read an agent's self-identity from its disk (null if not yet written). */
  private readIdentity(id: string): AgentIdentity | null {
    try {
      return JSON.parse(readFileSync(this.identityFile(id), 'utf8')) as AgentIdentity;
    } catch {
      return null;
    }
  }

  /** Write/merge the agent's identity to its disk so it can read its own name. */
  private writeIdentity(id: string, patch: Partial<AgentIdentity>): AgentIdentity {
    const cur = this.readIdentity(id);
    const next: AgentIdentity = {
      id,
      name: patch.name ?? cur?.name ?? id,
      hostname: id,
      project: this.cfg.project,
      timezone: patch.timezone !== undefined ? patch.timezone : (cur?.timezone ?? null),
      createdAt: cur?.createdAt ?? Date.now(),
      autoCompactPct:
        patch.autoCompactPct !== undefined ? patch.autoCompactPct : (cur?.autoCompactPct ?? null),
    };
    mkdirSync(dirname(this.identityFile(id)), { recursive: true });
    writeFileSync(this.identityFile(id), JSON.stringify(next, null, 2));
    return next;
  }

  /** Inspect a single agent (404 if its disk doesn't exist). */
  async getAgent(id: string): Promise<Agent> {
    if (!existsSync(this.agentDataDir(id)))
      throw Object.assign(new Error('agent not found'), { statusCode: 404 });
    return this.toAgent(await this.docker.getContainer(this.containerName(id)).inspect());
  }

  /** Patch an agent's editable per-agent settings (live — updates the on-disk
   *  identity the agent reads). Docker labels can't change on a running
   *  container, so the identity file is the source of truth. The auto-compact
   *  threshold takes effect when the supervisor next (re)launches claude
   *  (i.e. on the next stop→start). */
  async patchAgent(
    id: string,
    patch: { username?: string; autoCompactPct?: number | null },
  ): Promise<Agent> {
    if (!existsSync(this.agentDataDir(id)))
      throw Object.assign(new Error('agent not found'), { statusCode: 404 });
    const idPatch: Partial<AgentIdentity> = {};
    if (patch.username !== undefined) {
      const display = patch.username.trim();
      if (!display) throw Object.assign(new Error('name cannot be empty'), { statusCode: 400 });
      idPatch.name = display;
    }
    if (patch.autoCompactPct !== undefined) {
      const v = patch.autoCompactPct;
      if (v !== null && (!Number.isFinite(v) || v < 1 || v > 100))
        throw Object.assign(new Error('autoCompactPct must be between 1 and 100'), {
          statusCode: 400,
        });
      idPatch.autoCompactPct = v === null ? null : Math.round(v);
    }
    this.writeIdentity(id, idPatch);
    return this.toAgent(await this.docker.getContainer(this.containerName(id)).inspect());
  }

  /**
   * Ensure the agent's persistent home exists and, if brand new (empty), seed
   * it from the image's `/home/agent` skeleton via a one-shot helper (cp -a
   * preserves ownership/permissions). An empty bind mount would otherwise
   * shadow the image's prepared home and break the agent.
   */
  private async seedAgentDisk(id: string, credentialsFile: string): Promise<void> {
    const local = this.agentDataDir(id);
    mkdirSync(local, { recursive: true });
    if (readdirSync(local).length > 0) return; // existing disk — reuse as-is
    // Seed the home skeleton AND drop in the credentials. We copy credentials in
    // (rather than bind-mounting the file into the home) because Docker Desktop
    // can't nest a file bind inside a bind-mounted dir; the agent then maintains
    // its own ~/.claude/.credentials.json on its persistent disk thereafter.
    const helper = await this.docker.createContainer({
      Image: this.cfg.agentImage,
      Entrypoint: ['sh', '-c'],
      Cmd: [
        'cp -a /home/agent/. /seed/ 2>/dev/null || true; ' +
          'mkdir -p /seed/.claude; ' +
          'cp /seed-cred /seed/.claude/.credentials.json 2>/dev/null || true; ' +
          'chown -R 1000:1000 /seed/.claude 2>/dev/null || true',
      ],
      HostConfig: {
        Binds: [`${this.agentHostDir(id)}:/seed`, `${credentialsFile}:/seed-cred:ro`],
      },
    });
    try {
      await helper.start();
      await helper.wait();
    } finally {
      await helper.remove({ force: true }).catch(() => {});
    }
  }

  /**
   * Copy the CURRENT host credentials file into an agent's disk (best-effort),
   * via a one-shot helper that binds the host file. Run before every (re)start
   * so the agent boots with fresh credentials: OAuth tokens rotate, and the
   * copy seeded at create time would otherwise go stale → 401 "run /login".
   */
  private async pushCredentials(id: string): Promise<void> {
    const credentialsFile = getSettings().credentialsFile;
    const helper = await this.docker.createContainer({
      Image: this.cfg.agentImage,
      Entrypoint: ['sh', '-c'],
      Cmd: [
        'mkdir -p /seed/.claude; ' +
          'cp /seed-cred /seed/.claude/.credentials.json 2>/dev/null && ' +
          'chown 1000:1000 /seed/.claude/.credentials.json 2>/dev/null || true',
      ],
      HostConfig: {
        Binds: [`${this.agentHostDir(id)}:/seed`, `${credentialsFile}:/seed-cred:ro`],
      },
    });
    try {
      await helper.start();
      await helper.wait();
    } finally {
      await helper.remove({ force: true }).catch(() => {});
    }
  }

  private idFromName(name: string): string {
    return name.replace(/^\//, '').slice(this.cfg.agentNamePrefix.length);
  }

  /** Host hardware limits (from the Docker daemon), so the UI can cap the
   *  per-agent CPU/memory sliders at what the machine actually has. */
  async hostInfo(): Promise<{ cpus: number; memoryMb: number }> {
    const info = await this.docker.info();
    return {
      cpus: Number(info.NCPU) || 0,
      memoryMb: Math.round(Number(info.MemTotal || 0) / (1024 * 1024)),
    };
  }

  /** Recursively yield every *.jsonl transcript under a directory. */
  private *walkJsonl(dir: string): Generator<string> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) yield* this.walkJsonl(p);
      else if (e.name.endsWith('.jsonl')) yield p;
    }
  }

  /**
   * Global usage metrics for the dashboard, read straight off the agent disks:
   *  - per-agent 24h totals (tokens + computed cost) — x=agent bar chart;
   *  - 24 hourly slots summed across agents (tokens + cost) — x=time chart;
   *  - the account-level 5h / 7d rate-limit windows (from any agent's
   *    statusline.json — they're shared across agents on one account).
   */
  async metrics(): Promise<{
    rateLimits: {
      fiveHour: { usedPercent: number; resetsAt: number };
      sevenDay: { usedPercent: number; resetsAt: number };
      /** When the rate-limit values last changed (= last API activity). The
       *  dashboard greys the rings as "outdated" when this is >5m old. */
      updatedAt: number;
    } | null;
    agents: { id: string; name: string; tokens: number; cost: number }[];
    buckets: { t: number; tokens: number; cost: number }[];
  }> {
    const HOUR = 3_600_000;
    const base = Math.floor(Date.now() / HOUR) * HOUR - 23 * HOUR;
    const buckets = Array.from({ length: 24 }, (_, i) => ({
      t: base + i * HOUR,
      tokens: 0,
      cost: 0,
    }));
    const agents: { id: string; name: string; tokens: number; cost: number }[] = [];
    let rateLimits: {
      fiveHour: { usedPercent: number; resetsAt: number };
      sevenDay: { usedPercent: number; resetsAt: number };
    } | null = null;
    let rlMtime = 0;

    for (const a of await this.list()) {
      let tokens = 0;
      let cost = 0;
      // `claude --continue` re-writes prior assistant messages into the new
      // transcript, so the same message.id appears in multiple files/lines.
      // Counting every line double-counts (~2x here) — dedupe by message.id.
      const seen = new Set<string>();
      for (const file of this.walkJsonl(join(this.agentDataDir(a.id), '.claude', 'projects'))) {
        let raw: string;
        try {
          raw = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        for (const line of raw.split('\n')) {
          if (!line) continue;
          let o: {
            type?: string;
            timestamp?: string;
            message?: { id?: string; usage?: Record<string, number>; model?: string };
          };
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          const u = o.message?.usage;
          const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
          if (o.type !== 'assistant' || !u || !Number.isFinite(ts)) continue;
          const mid = o.message?.id;
          if (mid) {
            if (seen.has(mid)) continue;
            seen.add(mid);
          }
          const inp = u.input_tokens || 0;
          const out = u.output_tokens || 0;
          const cr = u.cache_read_input_tokens || 0;
          const cc = u.cache_creation_input_tokens || 0;
          // Tokens "burnt" = new tokens (fresh input + output + cache writes).
          // cache_read is the SAME context re-read every turn — summing it over
          // turns wildly over-counts — but it IS billed, so cost below keeps it.
          const tk = inp + out + cc;
          const idx = Math.floor((ts - base) / HOUR);
          if (idx < 0 || idx >= 24) continue;
          const r = modelRates(o.message?.model, inp + cr + cc);
          const c = (inp * r.in + out * r.out + cc * r.cw + cr * r.cr) / 1_000_000;
          tokens += tk;
          cost += c;
          buckets[idx]!.tokens += tk;
          buckets[idx]!.cost += c;
        }
      }
      agents.push({ id: a.id, name: a.username || a.id, tokens, cost });

      // Rate-limit windows are account-global; take the freshest statusline.
      try {
        const slPath = join(this.agentDataDir(a.id), '.claude', 'statusline.json');
        const mt = statSync(slPath).mtimeMs;
        if (mt > rlMtime) {
          const sl = JSON.parse(readFileSync(slPath, 'utf8')) as {
            rate_limits?: {
              five_hour?: { used_percentage?: number; resets_at?: number };
              seven_day?: { used_percentage?: number; resets_at?: number };
            };
          };
          const rl = sl.rate_limits;
          if (rl) {
            rateLimits = {
              fiveHour: {
                usedPercent: rl.five_hour?.used_percentage ?? 0,
                resetsAt: (rl.five_hour?.resets_at ?? 0) * 1000,
              },
              sevenDay: {
                usedPercent: rl.seven_day?.used_percentage ?? 0,
                resetsAt: (rl.seven_day?.resets_at ?? 0) * 1000,
              },
            };
            rlMtime = mt;
          }
        }
      } catch {
        /* no statusline for this agent */
      }
    }
    // Claude only writes rate_limits after API activity, so a freshly-(re)started
    // idle agent may lack it. They're account-global and change slowly, so cache
    // the last seen and fall back to it rather than dropping the rings. We stamp
    // `updatedAt` with the moment the values last *changed* (not every poll), so
    // an idle account whose numbers stop moving reads as outdated after 5m.
    let result: {
      fiveHour: { usedPercent: number; resetsAt: number };
      sevenDay: { usedPercent: number; resetsAt: number };
      updatedAt: number;
    } | null = null;
    if (rateLimits) {
      const prev = this.lastRateLimits;
      const changed =
        !prev ||
        prev.fiveHour.usedPercent !== rateLimits.fiveHour.usedPercent ||
        prev.fiveHour.resetsAt !== rateLimits.fiveHour.resetsAt ||
        prev.sevenDay.usedPercent !== rateLimits.sevenDay.usedPercent ||
        prev.sevenDay.resetsAt !== rateLimits.sevenDay.resetsAt;
      if (changed) this.lastRateLimitsChangedAt = Date.now();
      result = { ...rateLimits, updatedAt: this.lastRateLimitsChangedAt };
      this.lastRateLimits = result;
    } else {
      result = this.lastRateLimits;
    }
    return { rateLimits: result, agents, buckets };
  }
  private lastRateLimits: {
    fiveHour: { usedPercent: number; resetsAt: number };
    sevenDay: { usedPercent: number; resetsAt: number };
    updatedAt: number;
  } | null = null;
  private lastRateLimitsChangedAt = 0;

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
    // Name defaults to the id so there's always a readable identity; the
    // dashboard makes it mandatory for human creation.
    const username = opts.username?.trim() || id;
    // Clamp resource caps to the host's actual hardware (the UI does too, but
    // the API could be called directly).
    const hw = await this.hostInfo();
    const cpus = opts.cpus && opts.cpus > 0 ? Math.min(opts.cpus, hw.cpus || opts.cpus) : undefined;
    const memoryMb =
      opts.memoryMb && opts.memoryMb > 0
        ? Math.min(Math.round(opts.memoryMb), hw.memoryMb || Math.round(opts.memoryMb))
        : undefined;
    const timezone = opts.timezone?.trim() || undefined;
    const name = this.containerName(id);
    const portMode = this.cfg.mode === 'ports';
    // The credentials path is operator-selectable at runtime (settings).
    const credentialsFile = getSettings().credentialsFile;

    // Tag with the stack's compose project so Docker UIs (Portainer) nest the
    // agent under the dashboard, plus our own marker for management.
    const labels: Record<string, string> = {
      'swarm.managed': 'true',
      'com.docker.compose.project': this.cfg.project,
      [USERNAME_LABEL]: username,
    };
    if (cpus) labels[CPUS_LABEL] = String(cpus);
    if (memoryMb) labels[MEMORY_LABEL] = String(memoryMb);
    if (timezone) labels[TZ_LABEL] = timezone;

    // Persistent disk: seed the home skeleton + credentials (first time only),
    // then bind-mount it. Write the identity afterwards so the agent can read
    // its own name/id (the agent-timezone service + whoami MCP tool use it).
    await this.seedAgentDisk(id, credentialsFile);
    this.writeIdentity(id, { name: username, timezone: timezone ?? null });

    const container = await this.docker.createContainer({
      name,
      Image: this.cfg.agentImage,
      Hostname: id,
      Labels: labels,
      // TZ is read at boot by the agent-timezone service to set /etc/localtime,
      // and respected directly by CLI tools (claude, node) for timestamps.
      Env: timezone ? [`TZ=${timezone}`] : undefined,
      ExposedPorts: { '6080/tcp': {}, '7681/tcp': {} },
      HostConfig: {
        // systemd as PID 1 + GNOME Shell need these — mirrors README run flags.
        // `CgroupnsMode` is cast in: it's a valid Docker API field that the
        // current @types/dockerode HostConfig doesn't declare yet.
        CgroupnsMode: 'host',
        // Hard resource caps (omitted → unlimited). NanoCpus is cores × 1e9.
        NanoCpus: cpus ? Math.round(cpus * 1e9) : undefined,
        Memory: memoryMb ? memoryMb * 1024 * 1024 : undefined,
        Binds: [
          '/sys/fs/cgroup:/sys/fs/cgroup:rw',
          // Persistent home (host folder). Credentials are seeded into it (see
          // seedAgentDisk) rather than bind-mounted — Docker Desktop can't nest
          // a file bind inside a bind-mounted dir.
          `${this.agentHostDir(id)}:/home/agent`,
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
    await this.stampVersion(container);
    return this.toAgent(await container.inspect());
  }

  async list(): Promise<Agent[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ name: [this.cfg.agentNamePrefix] }),
    });
    return containers.map((c) => {
      const id = this.idFromName(c.Names[0] ?? '');
      return {
        id,
        name: (c.Names[0] ?? '').replace(/^\//, ''),
        image: c.Image,
        // Display name: the on-disk identity is the editable source of truth;
        // fall back to the seed label, then the id.
        username: this.readIdentity(id)?.name ?? c.Labels?.[USERNAME_LABEL] ?? id,
        status: c.State,
        createdAt: c.Created * 1000,
        cpus: c.Labels?.[CPUS_LABEL] ? Number(c.Labels[CPUS_LABEL]) : undefined,
        memoryMb: c.Labels?.[MEMORY_LABEL] ? Number(c.Labels[MEMORY_LABEL]) : undefined,
        timezone: c.Labels?.[TZ_LABEL],
        autoCompactPct: this.readIdentity(id)?.autoCompactPct ?? null,
      };
    });
  }

  async start(id: string): Promise<void> {
    // Refresh credentials into the disk first so a restart reloads them.
    await this.pushCredentials(id).catch(() => {});
    await this.docker.getContainer(this.containerName(id)).start();
    // Reconnect any `active` integrations once the terminal is reachable.
    void this.reconnectIntegrations(id);
  }

  async stop(id: string): Promise<void> {
    await this.discord.disconnect(id);
    await this.docker.getContainer(this.containerName(id)).stop();
  }

  async remove(id: string): Promise<void> {
    await this.discord.disconnect(id);
    await this.docker.getContainer(this.containerName(id)).remove({ force: true });
    // Also delete the agent's persistent disk (the caller must have warned the
    // user — this is irreversible).
    rmSync(this.agentDataDir(id), { recursive: true, force: true });
  }

  // --- Integrations --------------------------------------------------------
  // CRUD + test + apply for per-agent platform connectors (Discord first). The
  // receive side (incoming messages) is the DiscordBridge, which types accepted
  // messages into the agent's claude terminal; the send side is the in-agent
  // Discord MCP server, which reads these same credentials off the disk.

  /** Inject a single line into the agent's claude terminal (the receive path).
   *  Retries with backoff: right after a (re)start the terminal/claude session
   *  may not be listening yet, and we don't want to silently drop the message. */
  private async injectToTerminal(id: string, text: string): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const t = await this.resolveTarget(id, 'terminal');
        const res = await fetch(`http://${t.host}:${t.port}/api/inject`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: 'claude', text }),
        });
        if (res.ok) return;
        lastErr = new Error(`inject failed: HTTP ${res.status}`);
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
    throw lastErr ?? new Error('inject failed');
  }

  /** On (re)start, bring back any integration that was left `active`. */
  private async reconnectIntegrations(id: string): Promise<void> {
    for (const i of integrations.listIntegrations(this.agentDataDir(id))) {
      if (i.type === 'discord' && i.status === 'active' && i.credentials.botToken) {
        await this.discord
          .connect(id, i.credentials.botToken, i.rules, (text) => this.injectToTerminal(id, text))
          .catch(() => {});
      }
    }
  }

  private requireAgentDir(id: string): string {
    const dir = this.agentDataDir(id);
    if (!existsSync(dir)) throw Object.assign(new Error('agent not found'), { statusCode: 404 });
    return dir;
  }

  listIntegrations(id: string): IntegrationPublic[] {
    return integrations.listIntegrations(this.requireAgentDir(id)).map(integrations.toPublic);
  }

  addIntegration(id: string, type: IntegrationType): IntegrationPublic {
    return integrations.toPublic(
      integrations.addIntegration(this.requireAgentDir(id), type, Date.now()),
    );
  }

  updateIntegration(id: string, type: IntegrationType, patch: IntegrationPatch): IntegrationPublic {
    const dir = this.requireAgentDir(id);
    if (!integrations.getIntegration(dir, type))
      throw Object.assign(new Error('integration not found'), { statusCode: 404 });
    // Editing config invalidates a running connection until re-applied.
    void this.discord.disconnect(id);
    return integrations.toPublic(integrations.patchIntegration(dir, type, patch, Date.now()));
  }

  /** Validate the bot token over REST and record the result. */
  async testIntegration(id: string, type: IntegrationType): Promise<IntegrationPublic> {
    const dir = this.requireAgentDir(id);
    const cur = integrations.getIntegration(dir, type);
    if (!cur) throw Object.assign(new Error('integration not found'), { statusCode: 404 });
    if (!cur.credentials.botToken)
      throw Object.assign(new Error('add a bot token first'), { statusCode: 400 });
    const result = await testDiscordToken(cur.credentials.botToken);
    cur.lastTest = result;
    // A test never changes a live `active` integration — record the result only,
    // so a transient failure can't leave status `error` while the bridge stays up.
    if (cur.status !== 'active') {
      if (result.ok && (cur.status === 'configured' || cur.status === 'error'))
        cur.status = 'tested-ok';
      else if (!result.ok) cur.status = 'error';
    }
    cur.updatedAt = Date.now();
    integrations.setIntegration(dir, type, cur);
    return integrations.toPublic(cur);
  }

  /** Activate an integration: connect the bridge live (if the agent is running). */
  async applyIntegration(id: string, type: IntegrationType): Promise<IntegrationPublic> {
    const dir = this.requireAgentDir(id);
    const cur = integrations.getIntegration(dir, type);
    if (!cur) throw Object.assign(new Error('integration not found'), { statusCode: 404 });
    if (!cur.credentials.botToken)
      throw Object.assign(new Error('add a bot token first'), { statusCode: 400 });
    if (type === 'discord') {
      await this.discord.connect(id, cur.credentials.botToken, cur.rules, (text) =>
        this.injectToTerminal(id, text),
      );
    }
    cur.status = 'active';
    cur.updatedAt = Date.now();
    integrations.setIntegration(dir, type, cur);
    return integrations.toPublic(cur);
  }

  /** Disable an integration: drop the live connection, keep the config. */
  async disableIntegration(id: string, type: IntegrationType): Promise<IntegrationPublic> {
    const dir = this.requireAgentDir(id);
    const cur = integrations.getIntegration(dir, type);
    if (!cur) throw Object.assign(new Error('integration not found'), { statusCode: 404 });
    await this.discord.disconnect(id);
    cur.status = 'disabled';
    cur.updatedAt = Date.now();
    integrations.setIntegration(dir, type, cur);
    return integrations.toPublic(cur);
  }

  async removeIntegration(id: string, type: IntegrationType): Promise<void> {
    const dir = this.requireAgentDir(id);
    await this.discord.disconnect(id);
    integrations.removeIntegration(dir, type);
  }

  /** Top-level entries of an agent's persistent home (for the package picker). */
  listAgentPaths(id: string): { name: string; dir: boolean }[] {
    const dir = this.agentDataDir(id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  }

  /**
   * Package selected sub-paths of an agent's home into a .7z. The agent MUST be
   * stopped first (so files are at rest) — we stop it if it's running.
   */
  async packageAgent(id: string, paths: string[]): Promise<{ file: string; bytes: number }> {
    const dir = this.agentDataDir(id);
    if (!existsSync(dir))
      throw Object.assign(new Error('agent has no persistent disk'), { statusCode: 404 });
    try {
      const info = await this.docker.getContainer(this.containerName(id)).inspect();
      if (info.State.Running) await this.stop(id);
    } catch {
      /* no container (disk-only) — fine */
    }
    // Sanitize: relative, no traversal, must exist.
    const safe = [...new Set(paths.map((p) => p.replace(/^[/\s]+|[/\s]+$/g, '')))].filter(
      (p) => p && !p.split('/').includes('..') && existsSync(join(dir, p)),
    );
    if (!safe.length)
      throw Object.assign(new Error('no valid paths selected'), { statusCode: 400 });
    mkdirSync(this.packagesDir(), { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = `${id}-${ts}.7z`;
    await execFileAsync(
      '7z',
      ['a', '-mx=5', '-bso0', '-bsp0', join(this.packagesDir(), file), ...safe],
      {
        cwd: dir,
        maxBuffer: 1 << 26,
      },
    );
    return { file, bytes: statSync(join(this.packagesDir(), file)).size };
  }

  /** Built packages, newest first. */
  listPackages(): { file: string; bytes: number; createdAt: number }[] {
    const dir = this.packagesDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.7z'))
      .map((f) => {
        const st = statSync(join(dir, f));
        return { file: f, bytes: st.size, createdAt: st.mtimeMs };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Absolute path of a package by name, or null if it doesn't exist. */
  packageFilePath(file: string): string | null {
    const p = join(this.packagesDir(), basename(file));
    return existsSync(p) ? p : null;
  }

  /** Delete a built/uploaded package. */
  deletePackage(file: string): void {
    const p = this.packageFilePath(file);
    if (p) rmSync(p, { force: true });
  }

  /** Destination path for an uploaded package (sanitized, .7z), for streaming
   * a package brought from another swarm into this one. */
  uploadDestination(name: string): string {
    mkdirSync(this.packagesDir(), { recursive: true });
    let safe = basename(name).replace(/[^\w.-]/g, '_') || 'package';
    if (!safe.endsWith('.7z')) safe += '.7z';
    return join(this.packagesDir(), safe);
  }

  /** Create a NEW agent and restore a package over its seeded home (duplicate /
   * import from another swarm). */
  async importPackage(file: string, opts: CreateAgentOptions = {}): Promise<Agent> {
    const src = this.packageFilePath(file);
    if (!src) throw Object.assign(new Error('package not found'), { statusCode: 404 });
    const agent = await this.create(opts);
    await this.stop(agent.id).catch(() => {});
    const dir = this.agentDataDir(agent.id);
    await execFileAsync('7z', ['x', '-y', '-bso0', '-bsp0', src, `-o${dir}`], {
      maxBuffer: 1 << 26,
    });
    // 7z may restore files as root; the agent runs as uid 1000.
    await execFileAsync('chown', ['-R', '1000:1000', dir]).catch(() => {});
    await this.start(agent.id);
    return agent;
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
   * List a host directory's entries by mounting it read-only into a probe
   * container and running `ls`. Lets the dashboard offer a host file browser
   * (the gateway can't read host files directly, only via a mount). Returns the
   * directory's parent for "up" navigation.
   */
  async listHostDir(
    path: string,
  ): Promise<{ path: string; parent: string | null; entries: { name: string; dir: boolean }[] }> {
    if (!path.startsWith('/'))
      throw Object.assign(new Error('path must be absolute'), {
        statusCode: 400,
      });
    await this.ensureImage(this.cfg.probeImage);
    let container;
    try {
      container = await this.docker.createContainer({
        Image: this.cfg.probeImage,
        Tty: true, // plain (non-multiplexed) log output
        // Pipe through `cat` so ls's stdout isn't a TTY → no ANSI colorization.
        Cmd: ['sh', '-c', 'ls -1Ap /probe | cat'],
        HostConfig: { Binds: [`${path}:/probe:ro`] },
      });
      await container.start();
      await container.wait();
      const buf = (await container.logs({ stdout: true, stderr: true })) as unknown as Buffer;
      const entries = buf
        .toString('utf8')
        .split('\n')
        .map((s) => s.trim())
        .filter((n) => n && n !== './' && n !== '../')
        .map((n) =>
          n.endsWith('/') ? { name: n.slice(0, -1), dir: true } : { name: n, dir: false },
        )
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      return { path, parent: path === '/' ? null : dirname(path), entries };
    } finally {
      if (container) await container.remove({ force: true }).catch(() => {});
    }
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

  /** Run a command in a container and return its combined stdout/stderr. */
  private async exec(container: Docker.Container, cmd: string[]): Promise<string> {
    const ex = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    const stream = await ex.start({ Tty: true });
    return await new Promise<string>((resolve) => {
      let out = '';
      stream.on('data', (d: Buffer) => (out += d.toString('utf8')));
      stream.on('end', () => resolve(out));
      stream.on('error', () => resolve(out));
    });
  }

  /** Migration helpers bound to one container (used by migration `apply`). */
  private migrationCtx(container: Docker.Container): MigrationCtx {
    const base = this.cfg.agentContextDir;
    return {
      putDir: async (srcRel, dest) => {
        await container.putArchive(tar.pack(join(base, srcRel)), { path: dest });
      },
      putFile: async (srcRel, dest) => {
        const src = join(base, srcRel);
        const pack = tar.pack(dirname(src), {
          entries: [basename(src)],
          map: (header) => ((header.name = basename(dest)), header),
        });
        await container.putArchive(pack, { path: dirname(dest) });
      },
      exec: (cmd) => this.exec(container, ['sh', '-c', cmd]),
    };
  }

  /** Highest migration version applied in an agent (0 = none/old). */
  async installedVersion(id: string): Promise<number> {
    try {
      const out = await this.exec(this.docker.getContainer(this.containerName(id)), [
        'sh',
        '-c',
        `cat ${VERSION_MARKER} 2>/dev/null || echo 0`,
      ]);
      const n = parseInt(out.trim(), 10);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  async upgradeInfo(id: string): Promise<UpgradeInfo> {
    const installed = await this.installedVersion(id);
    const pending = migrations
      .filter((m) => m.version > installed)
      .sort((a, b) => a.version - b.version)
      .map((m) => ({ version: m.version, name: m.name }));
    return { installed, latest: LATEST_VERSION, outdated: installed < LATEST_VERSION, pending };
  }

  /** Stamp a freshly created container as fully up to date (it ships current). */
  private async stampVersion(container: Docker.Container): Promise<void> {
    await this.exec(container, ['sh', '-c', `echo ${LATEST_VERSION} > ${VERSION_MARKER}`]).catch(
      () => {},
    );
  }

  /**
   * Run every pending migration in order against a live agent, recording the
   * version after each so a failure leaves a known state. Migrations restart the
   * terminal supervisor (and thus the always-on claude session — its transcript
   * is preserved on disk); no recreate.
   */
  async upgrade(id: string): Promise<UpgradeInfo> {
    const container = this.docker.getContainer(this.containerName(id));
    const ctx = this.migrationCtx(container);
    const installed = await this.installedVersion(id);
    for (const m of migrations
      .filter((x) => x.version > installed)
      .sort((a, b) => a.version - b.version)) {
      await m.apply(ctx);
      await ctx.exec(`echo ${m.version} > ${VERSION_MARKER}`);
    }
    return this.upgradeInfo(id);
  }

  private toAgent(info: Docker.ContainerInspectInfo): Agent {
    const name = info.Name.replace(/^\//, '');
    const id = this.idFromName(info.Name);
    const labels = info.Config.Labels ?? {};
    return {
      id,
      name,
      image: info.Config.Image,
      username: this.readIdentity(id)?.name ?? labels[USERNAME_LABEL] ?? id,
      status: info.State.Status,
      createdAt: Date.parse(info.Created),
      cpus: labels[CPUS_LABEL] ? Number(labels[CPUS_LABEL]) : undefined,
      memoryMb: labels[MEMORY_LABEL] ? Number(labels[MEMORY_LABEL]) : undefined,
      timezone: labels[TZ_LABEL],
      autoCompactPct: this.readIdentity(id)?.autoCompactPct ?? null,
    };
  }
}
