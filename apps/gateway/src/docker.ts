import { execFile } from 'node:child_process';
import {
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import type Docker from 'dockerode';
import tar from 'tar-fs';
import { config as defaultConfig, type Config } from './config.js';
import { getSettings } from './settings.js';
import { LATEST_VERSION, migrations, VERSION_MARKER, type MigrationCtx } from './migrations.js';
import { DiscordBridge, sanitizeInbound, testDiscordToken } from './discord-bridge.js';
import * as integrations from './integrations.js';
import { CAPABILITIES, getRoles, rolesGrant } from './roles.js';
import { canCommunicate, listGroups } from './groups.js';
import { appendGroupMessage } from './group-chats.js';
import type {
  Agent,
  Capability,
  CreateAgentOptions,
  GroupMessage,
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
/** How long the persisted cpu/mem resource history is kept (7 days). */
const USAGE_RETAIN_MS = 7 * 24 * 3_600_000;

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
  /** ANTHROPIC_MODEL the agent's claude runs (alias like "opus"/"sonnet"/"haiku"
   *  or a full model id); null/empty = the claude default. */
  model?: string | null;
  /** Assigned role ids + group ids (resolved against the global registries). */
  roles?: string[];
  groups?: string[];
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
  /** Live per-agent resource usage (cpu% + memory), fed by docker stats streams
   *  (one per running agent), so the dashboard can poll it cheaply/often. */
  private readonly usage = new Map<string, { cpuPct: number; memUsed: number; memLimit: number }>();
  private readonly usageStreams = new Map<string, Readable>();
  /** 12h per-agent cpu/mem history (sampled ~1/min) for the dashboard graphs,
   *  plus id→name for the line labels. In-memory (resets on gateway restart). */
  private usageHistory: { t: number; cpu: Record<string, number>; mem: Record<string, number> }[] =
    [];
  private readonly usageNames = new Map<string, string>();

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
      model: patch.model !== undefined ? patch.model : (cur?.model ?? null),
      roles: patch.roles !== undefined ? patch.roles : (cur?.roles ?? []),
      groups: patch.groups !== undefined ? patch.groups : (cur?.groups ?? []),
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
    patch: {
      username?: string;
      autoCompactPct?: number | null;
      model?: string | null;
      roles?: string[];
      groups?: string[];
    },
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
    if (patch.model !== undefined) {
      const m = patch.model?.trim();
      idPatch.model = m ? m : null; // empty/whitespace → clear back to default
    }
    if (Array.isArray(patch.roles)) idPatch.roles = patch.roles;
    if (Array.isArray(patch.groups)) idPatch.groups = patch.groups;
    const prevModel = this.readIdentity(id)?.model ?? null;
    const prevRoles = JSON.stringify(this.readIdentity(id)?.roles ?? []);
    this.writeIdentity(id, idPatch);
    const info = await this.docker.getContainer(this.containerName(id)).inspect();

    // Roles changed → rewrite the agent's roles doc and nudge it to (re)read.
    if (patch.roles !== undefined && JSON.stringify(idPatch.roles ?? []) !== prevRoles) {
      this.writeRolesDoc(id);
      if (info.State.Running) {
        this.queueDeliver(id, {
          text: `**[sys://role]** Your roles were updated. Read ~/.swarm/roles.md to understand your responsibilities.`,
          attachments: [],
        });
      }
    }

    // Switch the model LIVE by typing `/model <x>` into the running claude
    // session — env (ANTHROPIC_MODEL) only takes effect on a fresh boot, and a
    // `--continue` resume keeps the prior session's model, so a restart wouldn't
    // reliably switch it. (The identity write above still persists the choice
    // for the next fresh boot / recreate.)
    if (patch.model !== undefined && idPatch.model !== prevModel && info.State.Running) {
      void this.injectToTerminal(id, `/model ${idPatch.model || 'default'}`).catch(() => {});
    }
    return this.toAgent(info);
  }

  /**
   * Ensure the agent's persistent home exists and, if brand new (empty), seed
   * it from the image's `/home/agent` skeleton via a one-shot helper (cp -a
   * preserves ownership/permissions). An empty bind mount would otherwise
   * shadow the image's prepared home and break the agent.
   */
  private async seedAgentDisk(id: string): Promise<void> {
    const local = this.agentDataDir(id);
    mkdirSync(local, { recursive: true });
    if (readdirSync(local).length > 0) return; // existing disk — reuse as-is
    // Seed the image's `/home/agent` skeleton into the (empty) bind mount via a
    // one-shot helper (cp -a preserves ownership/permissions). Auth is handled
    // separately by writeAuthToken (CLAUDE_CODE_OAUTH_TOKEN), not a creds file.
    const helper = await this.docker.createContainer({
      Image: this.cfg.agentImage,
      Entrypoint: ['sh', '-c'],
      Cmd: ['cp -a /home/agent/. /seed/ 2>/dev/null || true'],
      HostConfig: { Binds: [`${this.agentHostDir(id)}:/seed`] },
    });
    try {
      await helper.start();
      await helper.wait();
    } finally {
      await helper.remove({ force: true }).catch(() => {});
    }
  }

  /** Write the operator's Claude OAuth token to the agent's disk at
   *  `.swarm/auth`; the supervisor injects it as CLAUDE_CODE_OAUTH_TOKEN when it
   *  (re)launches claude (see runtime/server.js settingsEnv). The gateway has the
   *  agent data dir mounted, so it writes directly — no helper container. Called
   *  on create + every start so a rotated token applies on the next restart. */
  private writeAuthToken(id: string): void {
    const token = getSettings().oauthToken;
    const dir = join(this.agentDataDir(id), '.swarm');
    const file = join(dir, 'auth');
    try {
      mkdirSync(dir, { recursive: true });
      if (token) writeFileSync(file, token, { mode: 0o600 });
      else rmSync(file, { force: true }); // no token configured → ensure none stale
    } catch {
      /* best-effort */
    }
  }

  /** Write the agent's assigned roles + descriptions to ~/.swarm/roles.md so the
   *  agent can read what it's expected to do. Rewritten on assignment/role edits
   *  and on (re)start. Removed when the agent has no roles. */
  writeRolesDoc(id: string): void {
    const ids = this.readIdentity(id)?.roles ?? [];
    const file = join(this.agentDataDir(id), '.swarm', 'roles.md');
    try {
      if (!ids.length) {
        rmSync(file, { force: true });
        return;
      }
      const roles = getRoles(ids);
      const granted = CAPABILITIES.filter((c) => rolesGrant(ids, c.key));
      const perms = granted.length
        ? `\n\n## Your special permissions\n\n` +
          `Your role(s) grant you these abilities over agents that share a group with you ` +
          `(group membership scopes who you can act on) — use the swarm tools to exercise them:\n\n` +
          granted.map((c) => `- **${c.label}** — ${c.description}`).join('\n') +
          '\n'
        : '';
      const body =
        `# Your roles\n\n` +
        `You have been assigned the following role(s) in this swarm. Act according to them.\n\n` +
        roles.map((r) => `## ${r.name}\n\n${r.description || '(no description)'}`).join('\n\n') +
        perms +
        '\n';
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    } catch {
      /* best-effort */
    }
  }

  /** Rewrite roles docs + nudge every running agent assigned a given role (used
   *  when a role's description changes or it's deleted). */
  async refreshAgentsWithRole(roleId: string): Promise<void> {
    try {
      for (const a of await this.list()) {
        if (!(this.readIdentity(a.id)?.roles ?? []).includes(roleId)) continue;
        this.writeRolesDoc(a.id);
        if (a.status === 'running') {
          this.queueDeliver(a.id, {
            text: `**[sys://role]** A role you hold was updated. Re-read ~/.swarm/roles.md.`,
            attachments: [],
          });
        }
      }
    } catch {
      /* best-effort */
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
    /** Per-agent live-resource history over the last 12h (cpu% + memory bytes). */
    usage: {
      series: { id: string; name: string }[];
      points: { t: number; cpu: Record<string, number>; mem: Record<string, number> }[];
    };
  }> {
    const HOUR = 3_600_000;
    const WINDOW_H = 12;
    const base = Math.floor(Date.now() / HOUR) * HOUR - (WINDOW_H - 1) * HOUR;
    const buckets = Array.from({ length: WINDOW_H }, (_, i) => ({
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
          if (idx < 0 || idx >= WINDOW_H) continue;
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
      if (changed) {
        this.lastRateLimitsChangedAt = Date.now();
        this.saveState(); // persist the fresh rate-limit values
      }
      result = { ...rateLimits, updatedAt: this.lastRateLimitsChangedAt };
      this.lastRateLimits = result;
    } else {
      result = this.lastRateLimits;
    }
    // Graphs show the last 12h; the full history (up to 7d) stays on disk.
    const graphCutoff = Date.now() - 12 * 3_600_000;
    return {
      rateLimits: result,
      agents,
      buckets,
      usage: {
        series: [...this.usageNames.entries()].map(([id, name]) => ({ id, name })),
        points: this.usageHistory.filter((p) => p.t >= graphCutoff),
      },
    };
  }
  private lastRateLimits: {
    fiveHour: { usedPercent: number; resetsAt: number };
    sevenDay: { usedPercent: number; resetsAt: number };
    updatedAt: number;
  } | null = null;
  private lastRateLimitsChangedAt = 0;

  /** Start a docker stats stream for one agent (idempotent), parsing each frame
   *  into a cached cpu%/memory snapshot. Docker emits ~1 frame/s and includes
   *  precpu_stats for the CPU delta, so we don't have to sample ourselves. */
  private ensureUsageStream(id: string): void {
    if (this.usageStreams.has(id)) return;
    void this.docker
      .getContainer(this.containerName(id))
      .stats({ stream: true })
      .then((stream) => {
        const s = stream as unknown as Readable;
        this.usageStreams.set(id, s);
        let buf = '';
        s.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            try {
              const d = JSON.parse(line);
              const cpuDelta =
                (d.cpu_stats?.cpu_usage?.total_usage ?? 0) -
                (d.precpu_stats?.cpu_usage?.total_usage ?? 0);
              const sysDelta =
                (d.cpu_stats?.system_cpu_usage ?? 0) - (d.precpu_stats?.system_cpu_usage ?? 0);
              const cores =
                d.cpu_stats?.online_cpus || d.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
              const cpuPct = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cores * 100 : 0;
              const memUsed =
                (d.memory_stats?.usage ?? 0) - (d.memory_stats?.stats?.inactive_file ?? 0);
              const memLimit = d.memory_stats?.limit ?? 0;
              this.usage.set(id, { cpuPct, memUsed, memLimit });
            } catch {
              /* skip a malformed frame */
            }
          }
        });
        const drop = () => {
          this.usageStreams.delete(id);
          this.usage.delete(id);
        };
        s.on('error', drop);
        s.on('close', drop);
        s.on('end', drop);
      })
      .catch(() => {});
  }

  /** Live resource usage across running agents (cpu% = cores×100, memory bytes).
   *  Lazily starts/stops the per-agent stats streams to match the fleet. */
  async usageSnapshot(): Promise<{
    cpuPct: number;
    memUsed: number;
    memLimit: number;
    agents: { id: string; name: string; cpuPct: number; memUsed: number; memLimit: number }[];
  }> {
    const all = await this.list();
    const running = all.filter((a) => a.status === 'running');
    const live = new Set(running.map((a) => a.id));
    for (const a of running) this.ensureUsageStream(a.id);
    // Tear down streams for agents that are no longer running.
    for (const id of [...this.usageStreams.keys()]) {
      if (!live.has(id)) {
        try {
          this.usageStreams.get(id)?.destroy();
        } catch {
          /* ignore */
        }
        this.usageStreams.delete(id);
        this.usage.delete(id);
      }
    }
    const agents = running.map((a) => {
      const u = this.usage.get(a.id) ?? { cpuPct: 0, memUsed: 0, memLimit: 0 };
      return { id: a.id, name: a.username || a.id, ...u };
    });
    return {
      cpuPct: agents.reduce((s, a) => s + a.cpuPct, 0),
      memUsed: agents.reduce((s, a) => s + a.memUsed, 0),
      memLimit: agents.reduce((s, a) => s + a.memLimit, 0),
      agents,
    };
  }

  /** Sample current usage into the 12h per-agent history (called on an interval). */
  private async sampleUsage(): Promise<void> {
    try {
      const u = await this.usageSnapshot();
      const t = Date.now();
      const cpu: Record<string, number> = {};
      const mem: Record<string, number> = {};
      for (const a of u.agents) {
        cpu[a.id] = Math.round(a.cpuPct);
        mem[a.id] = a.memUsed;
        this.usageNames.set(a.id, a.name);
      }
      this.usageHistory.push({ t, cpu, mem });
      const cutoff = t - USAGE_RETAIN_MS;
      while (this.usageHistory.length && this.usageHistory[0]!.t < cutoff)
        this.usageHistory.shift();
      this.saveState();
    } catch {
      /* sampling is best-effort */
    }
  }

  /** Begin periodic resource sampling (idempotent). Called once at startup. */
  startUsageSampling(): void {
    if (this.samplingTimer) return;
    this.loadState();
    void this.sampleUsage();
    this.samplingTimer = setInterval(() => void this.sampleUsage(), 60_000);
    // Disk watch: prune transient inboxes + warn the agent when its home > 1GB.
    this.diskTimer = setInterval(() => void this.checkDisks(), 5 * 60_000);
    void this.checkDisks();
    // Memory watchdog: warn at 80%/90% of the cap with hysteresis (reads the
    // live per-agent usage the stats streams already provide — cheap).
    this.memTimer = setInterval(() => this.checkMemory(), 10_000);
  }
  private samplingTimer: ReturnType<typeof setInterval> | null = null;
  private diskTimer: ReturnType<typeof setInterval> | null = null;
  private memTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-agent memory-warning latches for hysteresis (avoid repeat warnings). */
  private readonly memState = new Map<string, { warned80: boolean; warned90: boolean }>();

  /** Memory watchdog with hysteresis: warn once at ≥80% (re-arm after dropping
   *  below 70%) and once at ≥90% (re-arm after dropping below 80%). */
  private checkMemory(): void {
    for (const [id, u] of this.usage) {
      if (!u.memLimit) continue;
      const pct = (u.memUsed / u.memLimit) * 100;
      const st = this.memState.get(id) ?? { warned80: false, warned90: false };
      if (pct < 70) st.warned80 = false; // re-arm 80 warning
      if (pct < 80) st.warned90 = false; // re-arm 90 warning
      const usedGb = (u.memUsed / 1024 ** 3).toFixed(2);
      const capGb = (u.memLimit / 1024 ** 3).toFixed(2);
      if (pct >= 90 && !st.warned90) {
        st.warned90 = true;
        st.warned80 = true; // crossed 80 too — don't also fire the 80 warning
        this.queueDeliver(id, {
          text:
            `**[sys://mem]** Critical: memory at ${Math.round(pct)}% (${usedGb} / ${capGb} GB). ` +
            `Free memory NOW — you risk being OOM-killed.`,
          attachments: [],
        });
      } else if (pct >= 80 && !st.warned80) {
        st.warned80 = true;
        this.queueDeliver(id, {
          text:
            `**[sys://mem]** Memory at ${Math.round(pct)}% (${usedGb} / ${capGb} GB). ` +
            `Free up memory — close heavy processes before you hit the cap.`,
          attachments: [],
        });
      }
      this.memState.set(id, st);
    }
  }

  /** Restore persisted runtime state (resource history + cached rate limits) so
   *  the dashboard's graphs/rings survive a gateway restart. Trims to retention. */
  private loadState(): void {
    try {
      const s = JSON.parse(readFileSync(this.cfg.stateFile, 'utf8')) as {
        usage?: {
          names?: Record<string, string>;
          points?: { t: number; cpu: Record<string, number>; mem: Record<string, number> }[];
        };
        rateLimits?: {
          fiveHour: { usedPercent: number; resetsAt: number };
          sevenDay: { usedPercent: number; resetsAt: number };
          updatedAt: number;
        } | null;
        rateLimitsChangedAt?: number;
      };
      const cutoff = Date.now() - USAGE_RETAIN_MS;
      this.usageHistory = (s.usage?.points ?? []).filter((p) => p && p.t >= cutoff);
      for (const [id, name] of Object.entries(s.usage?.names ?? {})) this.usageNames.set(id, name);
      if (s.rateLimits) this.lastRateLimits = s.rateLimits;
      if (typeof s.rateLimitsChangedAt === 'number')
        this.lastRateLimitsChangedAt = s.rateLimitsChangedAt;
    } catch {
      /* no prior state — start fresh */
    }
  }

  /** Persist runtime state (debounced to ~10s; writes are small JSON). */
  private saveState(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(dirname(this.cfg.stateFile), { recursive: true });
        writeFileSync(
          this.cfg.stateFile,
          JSON.stringify({
            usage: { names: Object.fromEntries(this.usageNames), points: this.usageHistory },
            rateLimits: this.lastRateLimits,
            rateLimitsChangedAt: this.lastRateLimitsChangedAt,
          }),
        );
      } catch {
        /* best-effort */
      }
    }, 10_000);
  }
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly diskWarnedAt = new Map<string, number>();

  /** Total bytes of a directory via `du` (null if it can't be measured). */
  private async dirBytes(dir: string): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync('du', ['-sb', dir]);
      const n = parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  /** Delete oldest files in `dir` until its total is under `budget`. Returns
   *  bytes freed. Used to reclaim transient inbox drops, not real work. */
  private pruneDirToBudget(dir: string, budget: number): number {
    let files: { p: string; size: number; mt: number }[];
    try {
      files = readdirSync(dir)
        .map((f) => {
          const p = join(dir, f);
          const st = statSync(p);
          return { p, size: st.size, mt: st.mtimeMs, isFile: st.isFile() };
        })
        .filter((f) => f.isFile);
    } catch {
      return 0;
    }
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= budget) return 0;
    files.sort((a, b) => a.mt - b.mt); // oldest first
    let freed = 0;
    for (const f of files) {
      if (total <= budget) break;
      try {
        rmSync(f.p, { force: true });
        total -= f.size;
        freed += f.size;
      } catch {
        /* ignore */
      }
    }
    return freed;
  }

  /** Per running agent: if its home exceeds 1GB, prune the transient inboxes and
   *  warn it via a throttled `[sys://disk]` message. */
  private async checkDisks(): Promise<void> {
    const GB = 1024 ** 3;
    try {
      for (const a of await this.list()) {
        if (a.status !== 'running') continue;
        const dir = this.agentDataDir(a.id);
        const bytes = await this.dirBytes(dir);
        if (bytes === null || bytes <= GB) continue;
        const budget = 100 * 1024 * 1024; // keep each inbox under 100MB
        let freed = 0;
        freed += this.pruneDirToBudget(join(dir, '.swarm', 'shared-inbox'), budget);
        freed += this.pruneDirToBudget(join(dir, '.swarm', 'discord-inbox'), budget);
        const now = Date.now();
        if (now - (this.diskWarnedAt.get(a.id) ?? 0) > 3_600_000) {
          this.diskWarnedAt.set(a.id, now);
          const gb = (bytes / GB).toFixed(2);
          const note =
            freed > 0 ? ` Cleared ${(freed / (1 << 20)).toFixed(0)} MB of old inbox files.` : '';
          this.queueDeliver(a.id, {
            text:
              `**[sys://disk]** Your home disk is using ${gb} GB (over 1 GB).${note} ` +
              `Delete build artifacts and large files you no longer need.`,
            attachments: [],
          });
        }
      }
    } catch {
      /* best-effort */
    }
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
    const model = opts.model?.trim() || undefined;
    const name = this.containerName(id);
    const portMode = this.cfg.mode === 'ports';

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

    // Persistent disk: seed the home skeleton (first time only), then bind-mount
    // it. Write the identity + auth token afterwards so the agent can read its
    // own name/id and authenticate (CLAUDE_CODE_OAUTH_TOKEN).
    await this.seedAgentDisk(id);
    this.writeIdentity(id, {
      name: username,
      timezone: timezone ?? null,
      model: model ?? null,
      roles: Array.isArray(opts.roles) ? opts.roles : [],
      groups: Array.isArray(opts.groups) ? opts.groups : [],
    });
    this.writeAuthToken(id);
    this.writeRolesDoc(id);

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
        model: this.readIdentity(id)?.model ?? null,
        roles: this.readIdentity(id)?.roles ?? [],
        groups: this.readIdentity(id)?.groups ?? [],
      };
    });
  }

  async start(id: string): Promise<void> {
    // Refresh the auth token + roles doc onto the disk so a restart picks up any
    // change (e.g. an edited role description).
    this.writeAuthToken(id);
    this.writeRolesDoc(id);
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
   *  Right after a (re)start the terminal/claude session may not be listening
   *  yet, so we retry — but ONLY on "not ready" signals (a connection error, or
   *  404 = session not registered yet), where the message definitely was not
   *  typed. A real HTTP response (success or a permanent error like 400) is never
   *  retried, so a message the server already processed can't be typed twice. */
  private async injectToTerminal(id: string, text: string, interrupt = false): Promise<void> {
    const MAX = 5;
    for (let attempt = 0; ; attempt++) {
      try {
        const t = await this.resolveTarget(id, 'terminal');
        const res = await fetch(`http://${t.host}:${t.port}/api/inject`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: 'claude', text, interrupt }),
        });
        if (res.ok) return;
        // 404 = the claude session isn't up yet (transient on (re)start); retry.
        // Anything else is permanent (e.g. 400) — fail without retrying.
        if (res.status !== 404 || attempt >= MAX - 1)
          throw new Error(`inject failed: HTTP ${res.status}`);
      } catch (e) {
        // Permanent HTTP errors (thrown above) propagate; connection-level errors
        // (terminal not listening yet) are retriable until we run out of tries.
        if (e instanceof Error && /inject failed: HTTP/.test(e.message)) throw e;
        if (attempt >= MAX - 1) throw e;
      }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }

  /** Per-agent delivery chain so concurrent inbound messages are injected one at
   *  a time (typing two messages into the terminal at once merges them and one
   *  gets lost). Each link injects, then settles briefly so claude registers a
   *  distinct message before the next is typed. */
  private deliverChain = new Map<string, Promise<unknown>>();
  private queueDeliver(
    id: string,
    msg: { text: string; attachments: { url: string; name: string }[]; interrupt?: boolean },
  ): void {
    // Interrupts jump the queue: deliver immediately (Esc + message) instead of
    // waiting behind serialized plain messages.
    if (msg.interrupt) {
      void this.deliverInbound(id, msg).catch(() => {});
      return;
    }
    const prev = this.deliverChain.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        await this.deliverInbound(id, msg);
        await new Promise((r) => setTimeout(r, 450));
      });
    this.deliverChain.set(id, next);
    void next.catch(() => {});
  }

  /** Deliver one accepted inbound message: download its attachments onto the
   *  agent's disk (so the agent can read/view them) and inject the line, with
   *  any saved paths appended inline. Attachments land in the agent's home at
   *  /home/agent/.swarm/discord-inbox/ (world-readable). */
  private async deliverInbound(
    id: string,
    msg: { text: string; attachments: { url: string; name: string }[]; interrupt?: boolean },
  ): Promise<void> {
    let text = msg.text;
    if (msg.attachments.length) {
      const dir = join(this.agentDataDir(id), '.swarm', 'discord-inbox');
      const paths: string[] = [];
      for (const a of msg.attachments.slice(0, 5)) {
        try {
          const res = await fetch(a.url);
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.byteLength > 25 * 1024 * 1024) continue; // 25MB cap
          mkdirSync(dir, { recursive: true });
          const safe = a.name.replace(/[^\w.-]/g, '_');
          const fname = `${Date.now()}-${safe}`;
          writeFileSync(join(dir, fname), buf);
          paths.push(`/home/agent/.swarm/discord-inbox/${fname}`);
        } catch {
          /* skip an attachment that fails to download */
        }
      }
      if (paths.length) text += `  [attachment saved — read to view: ${paths.join(', ')}]`;
    }
    await this.injectToTerminal(id, text, msg.interrupt);
  }

  /** Swarm agent-communication: deliver a message from one agent to another. It
   *  lands in the target's terminal as `[swarm://<from>] <text>` (the target
   *  replies with its own swarm_send). `from`/`text` are sanitized so an agent
   *  can't forge a trusted routing prefix. Queued (non-interrupt) so coordinating
   *  agents don't violently interrupt each other's work. */
  async sendSwarmMessage(fromId: string, from: string, to: string, text: string): Promise<void> {
    const sender = sanitizeInbound(from).slice(0, 64) || 'agent';
    const body = sanitizeInbound(text);
    if (!body) throw Object.assign(new Error('text required'), { statusCode: 400 });
    const target = (await this.list()).find((a) => a.id === to || a.username === to);
    if (!target) throw Object.assign(new Error(`agent not found: ${to}`), { statusCode: 404 });
    if (target.status !== 'running')
      throw Object.assign(new Error('target agent is not running'), { statusCode: 409 });
    if (!this.sharesGroup(fromId, target.id))
      throw Object.assign(new Error(`you don't share a group with ${to}`), { statusCode: 403 });
    this.queueDeliver(target.id, { text: `**[swarm://${sender}]** ${body}`, attachments: [] });
  }

  /** Whether two agents may swarm together (share a group, or both ungrouped). */
  private sharesGroup(aId: string, bId: string): boolean {
    return canCommunicate(
      this.readIdentity(aId)?.groups ?? [],
      this.readIdentity(bId)?.groups ?? [],
    );
  }

  /** Swarm file-share: copy a file from the sender agent's home to the target
   *  agent's `~/.swarm/shared-inbox/` and notify the target via a [swarm://]
   *  message with the saved path. Both disks are mounted into the gateway, so we
   *  copy directly. Only files under the sender's home (its persistent disk) are
   *  reachable this way; /tmp etc. is not. Returns the in-container dest path. */
  async sendSwarmFile(
    fromId: string,
    fromName: string,
    to: string,
    path: string,
    note?: string,
  ): Promise<string> {
    const sender = sanitizeInbound(fromName).slice(0, 64) || 'agent';
    if (!existsSync(this.agentDataDir(fromId)))
      throw Object.assign(new Error('sender not found'), { statusCode: 404 });
    const target = (await this.list()).find((a) => a.id === to || a.username === to);
    if (!target) throw Object.assign(new Error(`agent not found: ${to}`), { statusCode: 404 });
    if (target.status !== 'running')
      throw Object.assign(new Error('target agent is not running'), { statusCode: 409 });
    if (!this.sharesGroup(fromId, target.id))
      throw Object.assign(new Error(`you don't share a group with ${to}`), { statusCode: 403 });

    // Map the in-container path to the mounted disk (home == the persistent disk).
    const HOME = '/home/agent/';
    const rel = (path.startsWith(HOME) ? path.slice(HOME.length) : path).replace(/^\/+/, '');
    const senderRoot = this.agentDataDir(fromId);
    const src = join(senderRoot, rel);
    if (src !== senderRoot && !src.startsWith(senderRoot + sep))
      throw Object.assign(new Error('path must be under the agent home'), { statusCode: 400 });
    if (!existsSync(src) || !statSync(src).isFile())
      throw Object.assign(new Error(`file not found: ${path}`), { statusCode: 404 });
    if (statSync(src).size > 100 * 1024 * 1024)
      throw Object.assign(new Error('file too large (>100MB)'), { statusCode: 400 });

    const base = basename(src).replace(/[^\w.-]/g, '_');
    const destDir = join(this.agentDataDir(target.id), '.swarm', 'shared-inbox');
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, `${Date.now()}-${base}`);
    copyFileSync(src, dest);
    try {
      chownSync(dest, 1000, 1000); // owned by the agent user inside the container
    } catch {
      /* best-effort */
    }
    const inContainer = `/home/agent/.swarm/shared-inbox/${basename(dest)}`;
    const tail = note ? ` — ${sanitizeInbound(note)}` : '';
    this.queueDeliver(target.id, {
      text: `**[swarm://${sender}]** shared a file → ${inContainer}${tail}`,
      attachments: [],
    });
    return inContainer;
  }

  /** Group chat: broadcast a message to a group. An agent sender (fromId set)
   *  must be a member, and the message fans out to every OTHER running member
   *  (the sender already knows it sent the message — it made the tool call). A
   *  human sender (no fromId — the dashboard operator) reaches ALL running
   *  members. Every message is also recorded in the group's log so the dashboard
   *  can render the running conversation. Recipients see a `[group://<name>]`
   *  prefix; the body marks whether the sender was a teammate agent or a human. */
  async sendGroupMessage(opts: {
    fromId?: string;
    fromName?: string;
    group: string;
    text: string;
  }): Promise<GroupMessage> {
    const body = sanitizeInbound(opts.text);
    if (!body) throw Object.assign(new Error('text required'), { statusCode: 400 });
    const grp = listGroups().find((g) => g.id === opts.group || g.name === opts.group);
    if (!grp) throw Object.assign(new Error(`group not found: ${opts.group}`), { statusCode: 404 });

    const isAgent = !!opts.fromId;
    let senderName: string;
    if (isAgent) {
      const mine = this.readIdentity(opts.fromId!)?.groups ?? [];
      if (!mine.includes(grp.id))
        throw Object.assign(new Error(`you're not in group ${grp.name}`), { statusCode: 403 });
      senderName =
        sanitizeInbound(opts.fromName || this.readIdentity(opts.fromId!)?.name || 'agent').slice(
          0,
          64,
        ) || 'agent';
    } else {
      senderName = sanitizeInbound(opts.fromName || 'operator').slice(0, 64) || 'operator';
    }

    const record = appendGroupMessage(grp.id, {
      from: senderName,
      kind: isAgent ? 'agent' : 'human',
      text: body,
      ts: Date.now(),
    });

    const label = grp.name.replace(/[[\]\n]/g, ' ').trim() || grp.id;
    const line = isAgent
      ? `**[group://${label}]** ${senderName}: ${body}`
      : `**[group://${label}]** ${senderName} (human, via dashboard): ${body}`;

    const members = (await this.list()).filter(
      (a) => (a.groups ?? []).includes(grp.id) && a.status === 'running',
    );
    for (const m of members) {
      if (isAgent && m.id === opts.fromId) continue; // sender doesn't get a copy
      this.queueDeliver(m.id, { text: line, attachments: [] });
    }
    return record;
  }

  /** Whether an agent's assigned roles grant a special capability. */
  private agentCan(id: string, cap: Capability): boolean {
    return rolesGrant(this.readIdentity(id)?.roles ?? [], cap);
  }

  /** Resolve a peer by id or display name (404 if unknown). Used by the
   *  capability-gated cross-agent actions below. */
  private async resolvePeer(to: string): Promise<Agent> {
    const target = (await this.list()).find((a) => a.id === to || a.username === to);
    if (!target) throw Object.assign(new Error(`agent not found: ${to}`), { statusCode: 404 });
    return target;
  }

  /** Capability-gated lifecycle control over a peer (the `manage_agents` role
   *  permission), scoped to agents that share a group with the caller. Start/stop
   *  only — never remove, by design. */
  async manageAgent(fromId: string, to: string, action: 'start' | 'stop'): Promise<Agent> {
    if (!this.agentCan(fromId, 'manage_agents'))
      throw Object.assign(new Error('your role does not permit managing agents'), {
        statusCode: 403,
      });
    if (action !== 'start' && action !== 'stop')
      throw Object.assign(new Error("action must be 'start' or 'stop'"), { statusCode: 400 });
    const target = await this.resolvePeer(to);
    if (target.id === fromId)
      throw Object.assign(new Error('cannot manage yourself'), { statusCode: 400 });
    if (!this.sharesGroup(fromId, target.id))
      throw Object.assign(new Error(`you don't share a group with ${to}`), { statusCode: 403 });
    if (action === 'start') await this.start(target.id);
    else await this.stop(target.id);
    return this.getAgent(target.id);
  }

  /** Capability-gated screen capture of a peer (the `view_screen` role
   *  permission): grab the target's live screenshot via its terminal supervisor
   *  and save it to the caller's `~/.swarm/views/`. Returns the in-container path
   *  the caller can Read. */
  async viewAgent(fromId: string, to: string): Promise<string> {
    if (!this.agentCan(fromId, 'view_screen'))
      throw Object.assign(new Error('your role does not permit viewing screens'), {
        statusCode: 403,
      });
    if (!existsSync(this.agentDataDir(fromId)))
      throw Object.assign(new Error('caller not found'), { statusCode: 404 });
    const target = await this.resolvePeer(to);
    if (!this.sharesGroup(fromId, target.id))
      throw Object.assign(new Error(`you don't share a group with ${to}`), { statusCode: 403 });
    if (target.status !== 'running')
      throw Object.assign(new Error('target agent is not running'), { statusCode: 409 });

    const { host, port } = await this.resolveTarget(target.id, 'terminal');
    const resp = await fetch(`http://${host}:${port}/api/screenshot`);
    if (!resp.ok)
      throw Object.assign(new Error(`could not capture ${to}'s screen`), { statusCode: 502 });
    const buf = Buffer.from(await resp.arrayBuffer());
    const ext = (resp.headers.get('content-type') || '').includes('png') ? 'png' : 'jpg';

    const destDir = join(this.agentDataDir(fromId), '.swarm', 'views');
    mkdirSync(destDir, { recursive: true });
    const safeName = (target.username || target.id).replace(/[^\w.-]/g, '_');
    const dest = join(destDir, `${safeName}-${Date.now()}.${ext}`);
    writeFileSync(dest, buf);
    try {
      chownSync(dest, 1000, 1000);
    } catch {
      /* best-effort */
    }
    return `/home/agent/.swarm/views/${basename(dest)}`;
  }

  /** On gateway startup, reconnect bridges for every running agent that has an
   *  active integration (bridge connections don't survive a gateway restart). */
  async reconnectAllIntegrations(): Promise<void> {
    try {
      for (const a of await this.list()) {
        if (a.status === 'running') await this.reconnectIntegrations(a.id).catch(() => {});
      }
    } catch {
      /* docker not ready / no agents — nothing to reconnect */
    }
  }

  /** On (re)start, bring back any integration that was left `active`. */
  private async reconnectIntegrations(id: string): Promise<void> {
    for (const i of integrations.listIntegrations(this.agentDataDir(id))) {
      if (i.type === 'discord' && i.status === 'active' && i.credentials.botToken) {
        await this.discord
          .connect(id, i.credentials.botToken, i.rules, (m) => this.queueDeliver(id, m))
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
      await this.discord.connect(id, cur.credentials.botToken, cur.rules, (m) =>
        this.queueDeliver(id, m),
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
      model: this.readIdentity(id)?.model ?? null,
      roles: this.readIdentity(id)?.roles ?? [],
      groups: this.readIdentity(id)?.groups ?? [],
    };
  }
}
