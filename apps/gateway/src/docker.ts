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
  statfsSync,
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
import { swarmToken } from './auth.js';
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
  Provider,
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
  /** Upstream the agent's claude talks to. Default 'anthropic'. */
  provider?: Provider;
  /** ANTHROPIC_MODEL the agent's claude runs (alias like "opus"/"sonnet"/"haiku"
   *  or a full model id); null/empty = the claude default. */
  model?: string | null;
  /** Assigned role ids + group ids (resolved against the global registries). */
  roles?: string[];
  groups?: string[];
  /** Direct per-agent capability grants (union'd with role-based permissions). */
  permissions?: Capability[];
  /** Identicon avatar seed (defaults to the id; reshuffleable from the UI). */
  avatarSeed?: string;
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

/** Human "resets in …" label from an epoch-MS reset time (mirrors the
 *  dashboard's resetsIn): minutes under an hour, hours under a day, else days. */
function resetsInLabel(at: number): string {
  const ms = at - Date.now();
  if (ms <= 0) return 'imminently';
  const h = ms / 3_600_000;
  if (h < 1) return `in ${Math.round(ms / 60_000)}m`;
  if (h < 24) return `in ${Math.round(h)}h`;
  return `in ${Math.round(h / 24)}d`;
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
  /** The agent's home root as the gateway sees it (404 if the agent's disk is
   *  absent) — the root the file-explorer API confines all operations to. */
  agentHome(id: string): string {
    const dir = this.agentDataDir(id);
    if (!existsSync(dir)) throw Object.assign(new Error('agent not found'), { statusCode: 404 });
    return dir;
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
      provider: patch.provider !== undefined ? patch.provider : (cur?.provider ?? 'anthropic'),
      model: patch.model !== undefined ? patch.model : (cur?.model ?? null),
      roles: patch.roles !== undefined ? patch.roles : (cur?.roles ?? []),
      groups: patch.groups !== undefined ? patch.groups : (cur?.groups ?? []),
      permissions: patch.permissions !== undefined ? patch.permissions : (cur?.permissions ?? []),
      avatarSeed: patch.avatarSeed !== undefined ? patch.avatarSeed : cur?.avatarSeed,
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
      provider?: Provider;
      model?: string | null;
      roles?: string[];
      groups?: string[];
      permissions?: Capability[];
      avatarSeed?: string;
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
    if (patch.provider !== undefined) {
      if (patch.provider !== 'anthropic' && patch.provider !== 'opencodeGo')
        throw Object.assign(new Error('provider must be "anthropic" or "opencodeGo"'), {
          statusCode: 400,
        });
      idPatch.provider = patch.provider;
    }
    if (patch.model !== undefined) {
      const m = patch.model?.trim();
      idPatch.model = m ? m : null; // empty/whitespace → clear back to default
    }
    if (Array.isArray(patch.roles)) idPatch.roles = patch.roles;
    if (Array.isArray(patch.groups)) idPatch.groups = patch.groups;
    if (Array.isArray(patch.permissions)) idPatch.permissions = patch.permissions as Capability[];
    // Empty string explicitly resets the avatar to the default (id-seeded).
    if (patch.avatarSeed !== undefined) idPatch.avatarSeed = patch.avatarSeed.trim() || id;
    const prevModel = this.readIdentity(id)?.model ?? null;
    const prevProvider = this.readIdentity(id)?.provider ?? 'anthropic';
    const prevRoles = JSON.stringify(this.readIdentity(id)?.roles ?? []);
    this.writeIdentity(id, idPatch);
    const info = await this.docker.getContainer(this.containerName(id)).inspect();

    // Provider changed → resync the opencode-go key onto disk (added when
    // switching to opencodeGo, removed when switching back to anthropic). The
    // claude process picks it up on the next (re)spawn — same constraint as
    // ANTHROPIC_MODEL (env vars are read once at process start). Model change
    // on an opencodeGo agent re-writes oc-go-cc's config so the proxy maps
    // every Claude tier to the newly chosen model.
    if (patch.provider !== undefined && idPatch.provider !== prevProvider) {
      this.writeOpencodeGoKey(id);
    } else if (
      patch.model !== undefined &&
      idPatch.model !== prevModel &&
      (idPatch.provider ?? prevProvider) === 'opencodeGo'
    ) {
      this.writeOpencodeGoConfig(id);
    }

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

  /** Ensure the agent's `~/.swarm` dir exists AND is owned by the agent user
   *  (uid 1000). The gateway writes here as root; if the *directory* stays
   *  root-owned, the agent-user runtime (uid 1000) can't create or delete files
   *  in it — which silently broke the heartbeat write and the restart-marker
   *  delete (both done by the runtime). chown the dir, not just the files. */
  private ensureSwarmDir(id: string): string {
    const dir = join(this.agentDataDir(id), '.swarm');
    mkdirSync(dir, { recursive: true });
    try {
      chownSync(dir, 1000, 1000);
    } catch {
      /* macOS bind-mounts don't enforce ownership; best-effort on Linux */
    }
    return dir;
  }

  /** Write the operator's Claude OAuth token to the agent's disk at
   *  `.swarm/auth`; the supervisor injects it as CLAUDE_CODE_OAUTH_TOKEN when it
   *  (re)launches claude (see runtime/server.js settingsEnv). The gateway has the
   *  agent data dir mounted, so it writes directly — no helper container. Called
   *  on create + every start so a rotated token applies on the next restart. */
  private writeAuthToken(id: string): void {
    const token = getSettings().oauthToken;
    const dir = this.ensureSwarmDir(id);
    const file = join(dir, 'auth');
    try {
      if (token) {
        writeFileSync(file, token, { mode: 0o600 });
        // The terminal supervisor runs as the agent user (uid 1000); the gateway
        // writes as root. Without this chown the 0600 file is unreadable by the
        // supervisor on Linux (macOS bind-mounts don't enforce it) → the token
        // never reaches claude and it shows "Not logged in".
        chownSync(file, 1000, 1000);
      } else {
        rmSync(file, { force: true }); // no token configured → ensure none stale
      }
    } catch {
      /* best-effort */
    }
  }

  /** Write the shared swarm token to the agent's disk at `.swarm/gateway-token`
   *  so swarm.py can authenticate its calls to the gateway (which is gated by the
   *  operator login). Called on create + every start; also backfilled to all
   *  existing agents on gateway boot so running agents keep working. */
  private writeSwarmToken(id: string): void {
    const dir = this.ensureSwarmDir(id);
    const file = join(dir, 'gateway-token');
    try {
      writeFileSync(file, swarmToken(), { mode: 0o600 });
      chownSync(file, 1000, 1000);
    } catch {
      /* best-effort */
    }
  }

  /** Sync the operator's OpenCode Go key onto the agent's disk at
   *  `.swarm/opencode-go-key`. Only writes for opencodeGo-provider agents; for
   *  anthropic agents the file is removed (so a provider switch back to
   *  anthropic doesn't leak credentials into the proxy). Called on create,
   *  start, and whenever provider or the key changes. */
  private writeOpencodeGoKey(id: string): void {
    const dir = this.ensureSwarmDir(id);
    const file = join(dir, 'opencode-go-key');
    const ident = this.readIdentity(id);
    const key = getSettings().providers?.opencodeGo?.apiKey ?? '';
    try {
      if (ident?.provider === 'opencodeGo' && key) {
        writeFileSync(file, key, { mode: 0o600 });
        chownSync(file, 1000, 1000); // readable by the in-agent proxy (uid 1000)
      } else {
        rmSync(file, { force: true });
      }
    } catch {
      /* best-effort */
    }
    this.writeOpencodeGoConfig(id);
  }

  /** Write the per-agent oc-go-cc config (`.swarm/oc-go-cc-config.json`),
   *  mapping the user's chosen OpenCode Go model into every Claude Code tier
   *  (default/think/complex/background/fast/long_context). Writing all six
   *  tiers to the same model means the dashboard's model dropdown drives the
   *  whole session — power users can still hand-edit this file for tier-
   *  specific routing. Skipped for anthropic-provider agents. */
  private writeOpencodeGoConfig(id: string): void {
    const dir = this.ensureSwarmDir(id);
    const file = join(dir, 'oc-go-cc-config.json');
    const ident = this.readIdentity(id);
    if (ident?.provider !== 'opencodeGo') {
      try {
        rmSync(file, { force: true });
      } catch {
        /* best-effort */
      }
      return;
    }
    const model = (ident.model && ident.model.trim()) || 'kimi-k2.6';
    const tier = (model_id: string) => ({ provider: 'opencode-go', model_id, temperature: 0.7 });
    const config = {
      host: '127.0.0.1',
      // oc-go-cc runs on an internal port behind the retry-proxy. The
      // supervisor (images/agent/runtime/server.js) overrides this anyway via
      // OC_GO_CC_PORT, but writing it here keeps the file self-consistent if
      // the operator inspects it.
      port: 8766,
      models: {
        default: { ...tier(model), max_tokens: 8192 },
        background: { ...tier(model), max_tokens: 4096 },
        think: { ...tier(model), max_tokens: 16384 },
        complex: { ...tier(model), max_tokens: 16384 },
        long_context: { ...tier(model), max_tokens: 32768, context_threshold: 80000 },
        fast: { ...tier(model), max_tokens: 4096 },
      },
      opencode_go: {
        base_url: 'https://opencode.ai/zen/go/v1/chat/completions',
        timeout_ms: 300_000,
      },
      logging: { level: 'info', requests: false },
    };
    try {
      writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o644 });
      chownSync(file, 1000, 1000);
    } catch {
      /* best-effort */
    }
  }

  /** Resync the OpenCode Go key onto every opencodeGo agent's disk (used after
   *  the operator updates the key in settings, so running agents pick up the
   *  new value on the next claude (re)spawn — no recreate needed). */
  writeOpencodeGoKeyAll(): void {
    try {
      const base = join(this.cfg.swarmDataMount, 'agents');
      for (const id of readdirSync(base)) this.writeOpencodeGoKey(id);
    } catch {
      /* no agents dir yet */
    }
  }

  /** Drop a one-shot marker on the agent's disk so its runtime, on the next boot,
   *  emits a `[sys://restart]` notice. This marks a *deliberate* operator restart
   *  (recreate / start) — worth announcing even when the bounce is quick — as
   *  distinct from the runtime's own heartbeat-gap resume nudge, which only fires
   *  after real unexpected downtime. The runtime consumes (deletes) the marker. */
  private markDeliberateRestart(id: string): void {
    const dir = this.ensureSwarmDir(id); // dir owned by uid 1000 so the runtime can delete the marker
    const file = join(dir, 'restart');
    try {
      writeFileSync(file, String(Date.now()), { mode: 0o644 });
      chownSync(file, 1000, 1000); // readable by the agent-user supervisor (uid 1000)
    } catch {
      /* best-effort — a missing notice is not worth failing the restart over */
    }
  }

  /** Backfill the swarm token onto every existing agent's disk (gateway boot), so
   *  agents created before the login feature can still reach the gateway. */
  writeSwarmTokenAll(): void {
    try {
      const base = join(this.cfg.swarmDataMount, 'agents');
      for (const id of readdirSync(base)) this.writeSwarmToken(id);
    } catch {
      /* no agents dir yet */
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
      this.ensureSwarmDir(id); // make sure the dir exists and is agent-owned
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
      this.ensureSwarmDir(id); // dir already exists+chowned; keep roles.md write self-contained
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
  async hostInfo(): Promise<{
    cpus: number;
    memoryMb: number;
    diskTotalMb: number;
    diskUsedMb: number;
  }> {
    const info = await this.docker.info();
    return {
      cpus: Number(info.NCPU) || 0,
      memoryMb: Math.round(Number(info.MemTotal || 0) / (1024 * 1024)),
      ...this.hostDisk(),
    };
  }

  /** Host disk usage (MB) for the filesystem holding agent data. statfs the
   *  swarm-data mount — a bind-mount from the host, so it reflects the HOST disk,
   *  not the gateway container. Best-effort. */
  private hostDisk(): { diskTotalMb: number; diskUsedMb: number } {
    try {
      const s = statfsSync(this.cfg.swarmDataMount);
      const bsize = Number(s.bsize);
      const total = Number(s.blocks) * bsize;
      const used = (Number(s.blocks) - Number(s.bfree)) * bsize;
      const mb = (n: number) => Math.round(n / (1024 * 1024));
      return { diskTotalMb: mb(total), diskUsedMb: mb(used) };
    } catch {
      return { diskTotalMb: 0, diskUsedMb: 0 };
    }
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
    const points = this.usageHistory.filter((p) => p.t >= graphCutoff);
    // Build the line series from ids that actually have data in the window, and
    // collapse same-named ids into one line. An agent deleted then recreated
    // under the same display name leaves two ids in usageNames; without this the
    // chart drew (and the tooltip listed) "atlas" twice. When a name has several
    // ids we keep the most-recently-active one. Ids with no data in the window
    // (long-gone agents) are dropped entirely.
    const lastActive = new Map<string, number>(); // id → newest t with usage > 0
    for (const p of points)
      for (const id of this.usageNames.keys())
        if ((p.cpu[id] ?? 0) > 0 || (p.mem[id] ?? 0) > 0) lastActive.set(id, p.t);
    const byName = new Map<string, { id: string; name: string }>();
    for (const [id, t] of lastActive) {
      const name = this.usageNames.get(id) ?? id;
      const cur = byName.get(name);
      if (!cur || t > (lastActive.get(cur.id) ?? 0)) byName.set(name, { id, name });
    }
    return {
      rateLimits: result,
      agents,
      buckets,
      usage: { series: [...byName.values()], points },
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
    // Usage watchdog: warn capable agents when a rate-limit window is projected
    // to hit 100% (or actually reaches 90%). Limits change slowly, so 60s is plenty.
    this.usageAlertTimer = setInterval(() => void this.checkUsageAlerts(), 60_000);
    void this.checkUsageAlerts();
    // Auto-compact watchdog: the REAL auto-compact for the swarm. The in-claude
    // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE env proved unreliable, so the gateway drives
    // it instead — poll each agent's context-window usage and run /compact when it
    // crosses the agent's threshold. Context grows slowly, so 60s is plenty.
    this.autoCompactTimer = setInterval(() => void this.checkAutoCompact(), 60_000);
  }
  private samplingTimer: ReturnType<typeof setInterval> | null = null;
  private diskTimer: ReturnType<typeof setInterval> | null = null;
  private memTimer: ReturnType<typeof setInterval> | null = null;
  private usageAlertTimer: ReturnType<typeof setInterval> | null = null;
  private autoCompactTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-agent memory-warning latches for hysteresis (avoid repeat warnings). */
  private readonly memState = new Map<string, { warned80: boolean; warned90: boolean }>();
  /** Per-agent auto-compact cooldown: epoch ms until which the watchdog is
   *  suppressed after firing /compact. See AUTO_COMPACT_COOLDOWN_MS. */
  private readonly autoCompactCooldownUntil = new Map<string, number>();
  /** Per-agent "last /compact at" timestamp (epoch ms) for debouncing — claude's
   *  TUI takes a beat to consume an `Esc + /compact + Enter` injection, and a
   *  second injection landing mid-receive piles the slash-command text into the
   *  still-busy input buffer (we've seen `/compact/compact/compact/...` strings
   *  in the prompt). Compaction itself runs for ~30-60s; we drop any duplicate
   *  request inside this window since the in-flight compaction is what the
   *  caller wanted anyway. Doubles as the "compacting in progress" signal for
   *  the dashboard UI: an agent is shown as compacting for COMPACTING_TTL_MS
   *  after the last successful injection (see isCompacting). */
  private readonly lastCompactAt = new Map<string, number>();
  /** How long after a /compact injection we report the agent as `compacting`
   *  in the dashboard UI. Slightly under COMPACT_DEBOUNCE_MS so the UI badge
   *  clears just before the next click would be allowed. */
  private static readonly COMPACTING_TTL_MS = 75_000;

  /** Whether an agent is currently compacting (injected /compact within the
   *  last COMPACTING_TTL_MS). Surfaced as `compacting` on the Agent type so the
   *  dashboard can show a "Compacting…" chip on the card. */
  isCompacting(id: string): boolean {
    const t = this.lastCompactAt.get(id) ?? 0;
    return t > 0 && Date.now() - t < AgentManager.COMPACTING_TTL_MS;
  }

  /** Fraction of the compaction TTL elapsed (0..1) so the dashboard can render
   *  a progress bar. Returns 0 when not compacting. The TTL is an estimate of
   *  how long /compact takes (Claude doesn't expose actual progress) — the bar
   *  is a hint, not a precise readout. */
  compactingProgress(id: string): number {
    const t = this.lastCompactAt.get(id) ?? 0;
    if (t === 0) return 0;
    const elapsed = Date.now() - t;
    if (elapsed >= AgentManager.COMPACTING_TTL_MS) return 0;
    return elapsed / AgentManager.COMPACTING_TTL_MS;
  }
  /** Global per-window rate-limit alert latches (limits are account-shared, so the
   *  state is the same for every agent). Re-armed when the window drops well below
   *  the threshold (or resets). Avoids re-spamming capable agents each tick. */
  private readonly usageAlertState = {
    fiveHour: { warned: false, level: null as 'warning' | 'critical' | null },
    sevenDay: { warned: false, level: null as 'warning' | 'critical' | null },
  };

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

  /** After firing an auto-compact, suppress the watchdog for this long. Five
   *  minutes is well above a typical /compact's ~30-60s runtime — claude has
   *  time to actually shrink the context before we consider re-firing. The
   *  old "re-arm when context < 50%" approach broke for thresholds < 50%:
   *  46% > 40% threshold would re-fire every tick (the fill < 50% so the
   *  latch re-armed even though we'd just fired). The cooldown is absolute
   *  in time, so the threshold value doesn't matter. */
  private static readonly AUTO_COMPACT_COOLDOWN_MS = 5 * 60 * 1000;

  /** Auto-compact watchdog — the swarm's REAL auto-compact (gateway-driven),
   *  since the in-claude CLAUDE_AUTOCOMPACT_PCT_OVERRIDE env was unreliable.
   *  For each running agent: read its live context-window fill and, when it
   *  crosses the agent's threshold (identity.autoCompactPct, default 85;
   *  >=100 disables), run Claude Code's native `/compact` (Esc + /compact —
   *  interrupts a busy turn, which is intended). A per-agent cooldown holds
   *  the watchdog off for AUTO_COMPACT_COOLDOWN_MS after each fire so the
   *  compaction can complete before the next tick reconsiders. Best-effort +
   *  per-agent try/catch so the timer never throws (a missed tick just
   *  retries 60s later). */
  private async checkAutoCompact(): Promise<void> {
    let agents: Agent[];
    try {
      agents = await this.list();
    } catch {
      return; // docker not ready — try again next tick
    }
    for (const a of agents) {
      if (a.status !== 'running') continue;
      try {
        const threshold = this.readIdentity(a.id)?.autoCompactPct ?? 85;
        if (threshold >= 100) {
          this.autoCompactCooldownUntil.delete(a.id); // "off" — drop the cooldown
          continue;
        }
        // Still cooling down from the last fire? Skip this tick.
        const cooldownUntil = this.autoCompactCooldownUntil.get(a.id) ?? 0;
        if (Date.now() < cooldownUntil) continue;

        const { host, port } = await this.resolveTarget(a.id, 'terminal');
        const resp = await fetch(`http://${host}:${port}/api/stats`);
        if (!resp.ok) continue;
        const s = (await resp.json()) as {
          context?: number | null;
          contextLimit?: number | null;
        };
        const context = typeof s.context === 'number' ? s.context : 0;
        const contextLimit = typeof s.contextLimit === 'number' ? s.contextLimit : 0;
        const contextPct = contextLimit > 0 ? (context / contextLimit) * 100 : null;
        if (contextPct === null) continue;
        if (contextPct >= threshold) {
          this.autoCompactCooldownUntil.set(
            a.id,
            Date.now() + AgentManager.AUTO_COMPACT_COOLDOWN_MS,
          );
          await this.compactAgent(a.id);
          console.log(
            `[auto-compact] ${a.username || a.id}: context ${Math.round(contextPct)}% ` +
              `>= ${threshold}% — ran /compact (cooldown ${Math.round(
                AgentManager.AUTO_COMPACT_COOLDOWN_MS / 1000,
              )}s)`,
          );
        }
      } catch {
        /* best-effort per agent — a missed auto-compact is never worth a crash */
      }
    }
  }

  /** Project a rate-limit window's end-of-window usage at the current burn rate
   *  (linear extrapolation), mirroring the dashboard's UsageRing math. `resetsAt`
   *  is epoch MILLISECONDS (lastRateLimits stores the statusline seconds × 1000),
   *  matched here against Date.now(). The first 5% of the window is too noisy to
   *  trust, so we fall back to the raw used% there. */
  private projectWindow(w: { usedPercent: number; resetsAt: number }, windowMs: number): number {
    const elapsedFrac = Math.min(1, Math.max(0, 1 - (w.resetsAt - Date.now()) / windowMs));
    return elapsedFrac > 0.05 ? w.usedPercent / elapsedFrac : w.usedPercent;
  }

  /** Window length in ms for projection/labels (mirrors the dashboard). */
  private static readonly WINDOW_MS = { fiveHour: 5 * 3_600_000, sevenDay: 7 * 86_400_000 };

  /** Usage watchdog: warn capable agents (the `dashboard_alerts` permission) when
   *  a shared rate-limit window is in trouble — actual ≥90% (critical) or, failing
   *  that, projected ≥100% at the current burn rate (warning). Rate limits are
   *  account-global, so a single latch per (window, level) gates the broadcast and
   *  re-arms only when usage drops well below 90% / the window resets (so a brand-
   *  new grant or a gateway restart doesn't re-spam). Best-effort; never throws. */
  private async checkUsageAlerts(): Promise<void> {
    const rl = this.lastRateLimits;
    if (!rl) return;
    try {
      const windows: { key: 'fiveHour' | 'sevenDay'; label: string }[] = [
        { key: 'fiveHour', label: '5h' },
        { key: 'sevenDay', label: '7d' },
      ];
      // Figure out, per window, whether to fire and what message — before touching
      // the agent list (so we skip the docker call entirely when nothing's due).
      const due: { label: string; level: 'warning' | 'critical'; text: string }[] = [];
      for (const { key, label } of windows) {
        const w = rl[key];
        const st = this.usageAlertState[key];
        const actual = w.usedPercent;
        const projected = this.projectWindow(w, AgentManager.WINDOW_MS[key]);
        // Re-arm once usage eases back below 75% (mirrors checkMemory's reset) and
        // the projection no longer threatens to blow the window.
        if (actual < 75 && projected < 100) {
          st.warned = false;
          st.level = null;
        }
        const level: 'warning' | 'critical' | null =
          actual >= 90 ? 'critical' : projected >= 100 ? 'warning' : null;
        if (!level) continue;
        // Already warned at this (or a higher) level for this window → stay quiet.
        if (st.warned && (st.level === level || st.level === 'critical')) continue;
        st.warned = true;
        st.level = level;
        const when = resetsInLabel(w.resetsAt);
        const pct = Math.round(actual);
        const text =
          level === 'critical'
            ? `**[sys://usage]** Heads up: the ${label} usage window is at ${pct}% (resets ${when}). ` +
              `You're close to the cap — pace heavy work or pause non-urgent tasks.`
            : `**[sys://usage]** Heads up: at the current burn rate the ${label} usage window is ` +
              `projected to hit 100% before it resets (${when}); currently ${pct}%. Consider slowing down.`;
        due.push({ label, level, text });
      }
      if (!due.length) return;
      for (const a of await this.list()) {
        if (a.status !== 'running') continue;
        if (!rolesGrant(this.readIdentity(a.id)?.roles ?? [], 'dashboard_alerts')) continue;
        for (const d of due) this.queueDeliver(a.id, { text: d.text, attachments: [] });
      }
    } catch {
      /* best-effort — a missed usage warning is never worth crashing the timer */
    }
  }

  /** Compact usage summary for a capable agent (the `dashboard_alerts` permission):
   *  the 5h & 7d windows (used%, projected%, resetsAt ms) plus 12h total tokens +
   *  cost. Throws 403 if the agent's roles don't grant the capability. */
  async usageForAgent(fromId: string): Promise<{
    rateLimits: {
      fiveHour: { usedPercent: number; projected: number; resetsAt: number };
      sevenDay: { usedPercent: number; projected: number; resetsAt: number };
      updatedAt: number;
    } | null;
    totals: { tokens: number; cost: number; windowHours: number };
  }> {
    if (!rolesGrant(this.readIdentity(fromId)?.roles ?? [], 'dashboard_alerts'))
      throw Object.assign(new Error('your role does not permit reading dashboard usage'), {
        statusCode: 403,
      });
    const m = await this.metrics();
    const rl = m.rateLimits;
    const rateLimits = rl
      ? {
          fiveHour: {
            usedPercent: rl.fiveHour.usedPercent,
            projected: this.projectWindow(rl.fiveHour, AgentManager.WINDOW_MS.fiveHour),
            resetsAt: rl.fiveHour.resetsAt,
          },
          sevenDay: {
            usedPercent: rl.sevenDay.usedPercent,
            projected: this.projectWindow(rl.sevenDay, AgentManager.WINDOW_MS.sevenDay),
            resetsAt: rl.sevenDay.resetsAt,
          },
          updatedAt: rl.updatedAt,
        }
      : null;
    return {
      rateLimits,
      totals: {
        tokens: m.agents.reduce((s, a) => s + a.tokens, 0),
        cost: m.agents.reduce((s, a) => s + a.cost, 0),
        windowHours: 12,
      },
    };
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

  /** Delete the oldest entries ACROSS the given dirs until their COMBINED total
   *  is under `budget`. Returns bytes freed. Caps the file-sharing pool (incoming
   *  shares/attachments/views), not the whole home. */
  private async prunePoolToBudget(dirs: string[], budget: number): Promise<number> {
    const files: { p: string; size: number; mt: number }[] = [];
    for (const dir of dirs) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue; // dir doesn't exist / unreadable
      }
      for (const f of names) {
        const p = join(dir, f);
        try {
          const st = statSync(p);
          const size = st.isDirectory() ? ((await this.dirBytes(p)) ?? 0) : st.size;
          files.push({ p, size, mt: st.mtimeMs });
        } catch {
          /* skip unstattable entry */
        }
      }
    }
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= budget) return 0;
    files.sort((a, b) => a.mt - b.mt); // oldest first
    let freed = 0;
    for (const f of files) {
      if (total <= budget) break;
      try {
        rmSync(f.p, { recursive: true, force: true });
        total -= f.size;
        freed += f.size;
      } catch {
        /* ignore */
      }
    }
    return freed;
  }

  /** Per running agent: cap the file-SHARING pool (incoming peer shares, Discord
   *  attachments, and saved agent views under ~/.swarm/) at 1 GB by pruning the
   *  oldest, and tell the agent (throttled) when that happens. The agent's overall
   *  home/disk is intentionally NOT limited — that's the host's concern, surfaced
   *  separately as the host disk metric. */
  private async checkDisks(): Promise<void> {
    const POOL_BUDGET = 1024 ** 3; // 1 GB across the sharing pool, not the whole home
    try {
      for (const a of await this.list()) {
        if (a.status !== 'running') continue;
        const dir = this.agentDataDir(a.id);
        const pool = ['shared-inbox', 'discord-inbox', 'views'].map((d) => join(dir, '.swarm', d));
        const freed = await this.prunePoolToBudget(pool, POOL_BUDGET);
        if (freed <= 0) continue;
        const now = Date.now();
        if (now - (this.diskWarnedAt.get(a.id) ?? 0) > 12 * 3_600_000) {
          this.diskWarnedAt.set(a.id, now);
          this.queueDeliver(a.id, {
            text:
              `**[sys://disk]** Your file-sharing pool (incoming shares + Discord attachments + ` +
              `saved agent views under ~/.swarm/) hit its 1 GB cap, so the oldest ` +
              `${(freed / (1 << 20)).toFixed(0)} MB were auto-cleared. Your overall home disk ` +
              `is not limited — move anything you want to keep out of those inboxes.`,
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
      provider: opts.provider ?? 'anthropic',
      model: model ?? null,
      roles: Array.isArray(opts.roles) ? opts.roles : [],
      groups: Array.isArray(opts.groups) ? opts.groups : [],
      avatarSeed: opts.avatarSeed?.trim() || undefined,
    });
    this.writeAuthToken(id);
    this.writeOpencodeGoKey(id);
    this.writeSwarmToken(id);
    this.writeRolesDoc(id);

    return this.spawnContainer(id, name, labels, cpus, memoryMb, timezone);
  }

  /** Build the HostConfig + create & start the container for an agent id (shared
   *  by create + recreate). Adds the bigger /dev/shm and, when enabled, the GPU
   *  render nodes — falling back to software render if the device is missing. */
  private async spawnContainer(
    id: string,
    name: string,
    labels: Record<string, string>,
    cpus: number | undefined,
    memoryMb: number | undefined,
    timezone: string | undefined,
  ): Promise<Agent> {
    const portMode = this.cfg.mode === 'ports';
    // GPU passthrough (opt-in): map the host's DRM render nodes in so Chrome/Mesa
    // can use the GPU. A boot service grants the agent user the device group;
    // browser flags fall back to software if the GPU context fails.
    const gpuDevices = this.cfg.agentGpu
      ? [
          {
            PathOnHost: '/dev/dri/renderD128',
            PathInContainer: '/dev/dri/renderD128',
            CgroupPermissions: 'rwm',
          },
          {
            PathOnHost: '/dev/dri/card0',
            PathInContainer: '/dev/dri/card0',
            CgroupPermissions: 'rwm',
          },
        ]
      : undefined;
    // Sysbox runs systemd/GNOME unprivileged inside a user namespace (container
    // root → unprivileged host uid). When it's the runtime we DROP the escape
    // surface the privileged `runc` path needs (SYS_ADMIN, unconfined
    // seccomp/apparmor, cgroupns=host, the host cgroup bind). Sysbox virtualizes
    // /sys, /proc and cgroups itself, and ID-maps the home bind-mount so the
    // gateway's uid-1000 writes still appear as the agent user inside.
    const sysbox = this.cfg.agentRuntime === 'sysbox-runc';
    const homeBind = `${this.agentHostDir(id)}:/home/agent`;
    const hostConfig = {
      // Hard resource caps (omitted → unlimited). NanoCpus is cores × 1e9.
      NanoCpus: cpus ? Math.round(cpus * 1e9) : undefined,
      Memory: memoryMb ? memoryMb * 1024 * 1024 : undefined,
      // Chrome needs a real /dev/shm (64MB default → SIGTRAP under load).
      ShmSize: this.cfg.agentShmMb * 1024 * 1024,
      NetworkMode: this.cfg.networkName,
      // Resolve external names via public DNS, not the host's resolver — so an
      // agent can't resolve or enumerate the host's tailnet (*.ts.net) names,
      // and the tailnet search domain isn't leaked into the agent's resolv.conf.
      // Container names (e.g. the gateway) still resolve via Docker's embedded
      // DNS (127.0.0.11); only outbound lookups use these upstreams.
      Dns: ['1.1.1.1', '8.8.8.8'],
      DnsSearch: ['.'],
      ...(gpuDevices ? { Devices: gpuDevices } : {}),
      // Dev (macOS): let Docker assign ephemeral host ports so the host-run
      // gateway can reach them on 127.0.0.1 — no manual port juggling.
      PortBindings: portMode
        ? { '6080/tcp': [{ HostPort: '' }], '7681/tcp': [{ HostPort: '' }] }
        : undefined,
      RestartPolicy: { Name: 'unless-stopped' },
      ...(sysbox
        ? {
            // Unprivileged: Sysbox provides the rest. Just the home bind-mount.
            Runtime: 'sysbox-runc',
            Binds: [homeBind],
          }
        : {
            // Privileged `runc` fallback (e.g. macOS dev): systemd/GNOME need
            // these. `CgroupnsMode` is cast in — a valid Docker API field the
            // current @types/dockerode HostConfig doesn't declare yet.
            CgroupnsMode: 'host',
            Binds: ['/sys/fs/cgroup:/sys/fs/cgroup:rw', homeBind],
            Tmpfs: { '/run': '', '/run/lock': '', '/tmp': '' },
            CapAdd: ['SYS_BOOT', 'SYS_ADMIN'],
            SecurityOpt: ['seccomp=unconfined', 'apparmor=unconfined'],
          }),
    } as Docker.ContainerCreateOptions['HostConfig'];

    const createWith = (hc: Docker.ContainerCreateOptions['HostConfig']) =>
      this.docker.createContainer({
        name,
        Image: this.cfg.agentImage,
        Hostname: id,
        Labels: labels,
        // TZ is read at boot by the agent-timezone service to set /etc/localtime,
        // and respected directly by CLI tools (claude, node) for timestamps.
        Env: timezone ? [`TZ=${timezone}`] : undefined,
        ExposedPorts: { '6080/tcp': {}, '7681/tcp': {} },
        HostConfig: hc,
      });
    let container;
    try {
      container = await createWith(hostConfig);
    } catch (e) {
      // GPU device missing/unusable on this host → fall back to software render.
      if (
        gpuDevices &&
        /\/dev\/dri|device|no such file/i.test(e instanceof Error ? e.message : '')
      ) {
        const soft = { ...(hostConfig as Record<string, unknown>) };
        delete soft.Devices;
        container = await createWith(soft as Docker.ContainerCreateOptions['HostConfig']);
      } else {
        throw e;
      }
    }
    await container.start();
    await this.stampVersion(container);
    return this.toAgent(await container.inspect());
  }

  /** Recreate an agent's container in place (same id, home, name, caps) so that
   *  changes only applied at create time — a bigger /dev/shm, GPU devices, a
   *  rebuilt agent image — take effect on an EXISTING agent. The home is a host
   *  bind-mount, so removing the container preserves everything on disk. */
  async recreate(id: string): Promise<Agent> {
    if (!existsSync(this.agentDataDir(id)))
      throw Object.assign(new Error('agent not found'), { statusCode: 404 });
    const name = this.containerName(id);
    const prev = await this.docker
      .getContainer(name)
      .inspect()
      .catch(() => null);
    const labels: Record<string, string> = (prev?.Config?.Labels as Record<string, string>) ?? {
      'swarm.managed': 'true',
      'com.docker.compose.project': this.cfg.project,
      [USERNAME_LABEL]: this.readIdentity(id)?.name ?? id,
    };
    const cpus = labels[CPUS_LABEL] ? Number(labels[CPUS_LABEL]) : undefined;
    const memoryMb = labels[MEMORY_LABEL] ? Number(labels[MEMORY_LABEL]) : undefined;
    const timezone = labels[TZ_LABEL] || undefined;
    // Drop the old container (the host bind-mounted home is untouched).
    await this.docker
      .getContainer(name)
      .remove({ force: true })
      .catch(() => {});
    // Refresh on-disk provisioning so a rebuilt image starts with current state.
    this.writeAuthToken(id);
    this.writeSwarmToken(id);
    this.writeOpencodeGoKey(id);
    this.writeRolesDoc(id);
    this.markDeliberateRestart(id); // → [sys://restart] notice once the new container boots
    return this.spawnContainer(id, name, labels, cpus, memoryMb, timezone);
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
        avatarSeed: this.readIdentity(id)?.avatarSeed ?? id,
      };
    });
  }

  async start(id: string): Promise<void> {
    // Refresh the auth token + roles doc onto the disk so a restart picks up any
    // change (e.g. an edited role description).
    this.writeAuthToken(id);
    this.writeSwarmToken(id);
    this.writeOpencodeGoKey(id);
    this.writeRolesDoc(id);
    this.markDeliberateRestart(id); // → [sys://restart] notice once it boots
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
    // `raw` (real newlines/markdown preserved) is stored in the log + rendered in
    // the dashboard; `flat` is the single-line, prefix-safe form injected into the
    // peers' terminals (the routing protocol is one line per message).
    const raw = (opts.text || '').trim().slice(0, 4000);
    const flat = sanitizeInbound(opts.text);
    if (!flat) throw Object.assign(new Error('text required'), { statusCode: 400 });
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
      fromId: isAgent ? opts.fromId : undefined,
      kind: isAgent ? 'agent' : 'human',
      text: raw,
      ts: Date.now(),
    });

    // Run the group name through the same sanitizer as every other injected
    // token so a group name can't forge a routing prefix in the peers' terminals.
    const label = sanitizeInbound(grp.name).slice(0, 64) || grp.id;
    const line = isAgent
      ? `**[group://${label}]** ${senderName}: ${flat}`
      : `**[group://${label}]** ${senderName} (human, via dashboard): ${flat}`;

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
    const identity = this.readIdentity(id);
    if (identity?.permissions?.includes(cap)) return true;
    return rolesGrant(identity?.roles ?? [], cap);
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

  /** Minimum gap between back-to-back /compact injections for the same agent.
   *  Compaction itself takes ~30-60s; we hold off longer than that so two
   *  injections never overlap and pile typed text into the TUI buffer. This is
   *  the manual/peer-path gate; the auto-compact watchdog has its own (longer)
   *  cooldown in AUTO_COMPACT_COOLDOWN_MS. */
  private static readonly COMPACT_DEBOUNCE_MS = 90_000;

  /** Run Claude Code's own native `/compact` slash command in an agent's claude
   *  session (the operator button + the `compact_agents` peer tool + the
   *  auto-compact watchdog all funnel through here). Nothing about Claude Code
   *  is modified — we just type `/compact` into the live TUI, pressing Esc first
   *  (interrupt=true) so it runs NOW even if the agent is mid-turn.
   *
   *  Debounced: if a /compact was already injected for this agent within the
   *  last COMPACT_DEBOUNCE_MS, the call is a silent no-op. Returns `false` in
   *  that case so callers can distinguish (the HTTP layer still surfaces
   *  {ok:true} either way, since the compaction the caller wanted is in
   *  flight). Always returns `true` after a fresh injection. */
  async compactAgent(id: string): Promise<boolean> {
    let agent: Agent;
    try {
      agent = await this.getAgent(id);
    } catch {
      throw Object.assign(new Error('agent not found'), { statusCode: 404 });
    }
    if (agent.status !== 'running')
      throw Object.assign(new Error('agent is not running'), { statusCode: 409 });
    const now = Date.now();
    const last = this.lastCompactAt.get(id) ?? 0;
    if (now - last < AgentManager.COMPACT_DEBOUNCE_MS) {
      console.log(
        `[compact] ${agent.username || id}: debounced (${Math.round((now - last) / 1000)}s since last)`,
      );
      return false;
    }
    this.lastCompactAt.set(id, now);
    await this.injectToTerminal(id, '/compact', true);
    return true;
  }

  /** Capability-gated context compaction of a peer (the `compact_agents` role
   *  permission), scoped to agents that share a group with the caller. Runs the
   *  target's native `/compact` (Esc + /compact). Returns the target's name. */
  async compactPeer(fromId: string, to: string): Promise<{ ok: true; name: string }> {
    if (!this.agentCan(fromId, 'compact_agents'))
      throw Object.assign(new Error('your role does not permit compacting agents'), {
        statusCode: 403,
      });
    const target = await this.resolvePeer(to);
    if (target.id === fromId)
      throw Object.assign(new Error('cannot compact yourself'), { statusCode: 400 });
    if (!this.sharesGroup(fromId, target.id))
      throw Object.assign(new Error(`you don't share a group with ${to}`), { statusCode: 403 });
    await this.compactAgent(target.id);
    return { ok: true, name: target.username || target.id };
  }

  /** Capability-gated live-stats read of a peer (the `view_stats` role
   *  permission), scoped to agents that share a group with the caller. Returns a
   *  compact summary of the target's session (context-window usage, model,
   *  activity, tokens). Best-effort: an unreachable runtime yields `{error}`. */
  async statsForPeer(
    fromId: string,
    to: string,
  ): Promise<{
    name: string;
    status: string | null;
    model: string | null;
    context: number | null;
    contextLimit: number | null;
    contextPct: number | null;
    tokens: number | null;
    error?: string;
  }> {
    if (!this.agentCan(fromId, 'view_stats'))
      throw Object.assign(new Error('your role does not permit reading agent stats'), {
        statusCode: 403,
      });
    const target = await this.resolvePeer(to);
    if (!this.sharesGroup(fromId, target.id))
      throw Object.assign(new Error(`you don't share a group with ${to}`), { statusCode: 403 });
    const name = target.username || target.id;
    if (target.status !== 'running')
      throw Object.assign(new Error('target agent is not running'), { statusCode: 409 });
    try {
      const { host, port } = await this.resolveTarget(target.id, 'terminal');
      const resp = await fetch(`http://${host}:${port}/api/stats`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const s = (await resp.json()) as {
        status?: string | null;
        model?: string | null;
        context?: number | null;
        contextLimit?: number | null;
        tokens?: { total?: number } | null;
      };
      const context = typeof s.context === 'number' ? s.context : null;
      const contextLimit = typeof s.contextLimit === 'number' ? s.contextLimit : null;
      const contextPct =
        context !== null && contextLimit && contextLimit > 0
          ? Math.round((context / contextLimit) * 100)
          : null;
      return {
        name,
        status: s.status ?? null,
        model: s.model ?? null,
        context,
        contextLimit,
        contextPct,
        tokens: typeof s.tokens?.total === 'number' ? s.tokens.total : null,
      };
    } catch (e) {
      return {
        name,
        status: null,
        model: null,
        context: null,
        contextLimit: null,
        contextPct: null,
        tokens: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
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
      provider: this.readIdentity(id)?.provider ?? 'anthropic',
      model: this.readIdentity(id)?.model ?? null,
      roles: this.readIdentity(id)?.roles ?? [],
      groups: this.readIdentity(id)?.groups ?? [],
      permissions: this.readIdentity(id)?.permissions ?? [],
      compacting: this.isCompacting(id),
      compactingProgress: this.compactingProgress(id),
      avatarSeed: this.readIdentity(id)?.avatarSeed ?? id,
    };
  }
}
