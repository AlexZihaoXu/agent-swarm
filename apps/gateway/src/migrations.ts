/**
 * ===========================================================================
 *  AGENT MIGRATIONS — how live agents are upgraded without recreating them
 * ===========================================================================
 *
 * An agent container has a "soft layer" that can change between releases — the
 * terminal supervisor (`/opt/agent-runtime`), the statusLine script, the Claude
 * `settings.json`, the noVNC page — plus things you can change with a shell
 * command (config, packages already in the image, service restarts). The base
 * image (GNOME, systemd, apt packages, node) is the "hard layer" and still needs
 * a rebuild + recreate to change.
 *
 * Each agent records the highest migration version it has applied in
 * `VERSION_MARKER`. The gateway compares that to `LATEST_VERSION` and, on
 * upgrade, runs every migration with a higher number, in order, stamping the
 * marker after each so a mid-way failure leaves a known state. Fresh agents are
 * stamped at `LATEST_VERSION` on create (they ship current).
 *
 * ── To add a migration ──────────────────────────────────────────────────────
 *   1. Append ONE entry with `version` = previous + 1 (never reuse/reorder; the
 *      numbers are the upgrade order and the on-disk marker).
 *   2. Give it a short, accurate `name` (shown in the dashboard upgrade dialog).
 *   3. In `apply`, use the ctx helpers:
 *        - putDir(srcRel, dest)  — copy a bundled dir (relative to the agent
 *          build context, e.g. 'runtime') into the container at `dest`.
 *        - putFile(srcRel, dest) — copy one bundled file; it's renamed to
 *          `dest`'s basename on the way in.
 *        - exec(cmd)             — run `sh -c <cmd>` in the container.
 *      `srcRel` paths must exist in images/agent (the bundled build context).
 *   4. Restart any service whose files you changed (e.g.
 *      `systemctl restart agent-terminals novnc`). Restarting agent-terminals
 *      restarts the always-on claude session (its transcript persists on disk).
 *
 * ── Rules ────────────────────────────────────────────────────────────────────
 *   - Make `apply` idempotent: it may run on agents at any older version, and a
 *     retried upgrade may re-run a step. Prefer overwrite/`mkdir -p`/`|| true`.
 *   - Keep migrations forward-only (no down-migrations).
 *   - Touch only the soft layer + shell-reachable state. Anything needing new
 *     apt packages or image changes belongs in images/agent/Dockerfile (hard
 *     layer) and a fresh image, not here.
 *   - New files you ship must be added to images/agent so they're in the bundled
 *     context, and (if they belong in fresh agents too) installed by the image.
 */
export interface MigrationCtx {
  /** Copy a dir from the bundled agent context into the container at `dest`. */
  putDir(srcRel: string, dest: string): Promise<void>;
  /** Copy a single bundled file to `dest` (renamed to dest's basename). */
  putFile(srcRel: string, dest: string): Promise<void>;
  /** Run `sh -c <cmd>` in the container, returning its output. */
  exec(cmd: string): Promise<string>;
}

export interface Migration {
  version: number;
  name: string;
  apply: (ctx: MigrationCtx) => Promise<void>;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'terminal stats API, statusLine capture, proxy-relative pages',
    apply: async (ctx) => {
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.putFile('swarm-statusline.sh', '/usr/local/bin/swarm-statusline');
      await ctx.putFile('claude-settings.json', '/home/agent/.claude/settings.json');
      await ctx.putFile('novnc-index.html', '/usr/share/novnc/index.html');
      await ctx.exec(
        [
          'chmod +x /usr/local/bin/swarm-statusline',
          'mkdir -p /home/agent/.claude',
          'chown -R agent:agent /home/agent/.claude /opt/agent-runtime',
          'systemctl restart agent-terminals novnc',
        ].join('; '),
      );
    },
  },
  {
    version: 2,
    name: 'stats: report current context-window usage',
    apply: async (ctx) => {
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 3,
    name: 'stats WebSocket stream + low-res screenshot endpoint',
    apply: async (ctx) => {
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 4,
    name: 'cost: compute from token usage × per-model pricing',
    apply: async (ctx) => {
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 5,
    name: 'transcript endpoint for the chat view',
    apply: async (ctx) => {
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 6,
    name: 'chat attachment upload endpoint',
    apply: async (ctx) => {
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 7,
    name: 'transcript: include tool call details',
    apply: async (ctx) => {
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 8,
    name: 'stats: flag pending interactive prompts (AskUserQuestion/plan)',
    apply: async (ctx) => {
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 9,
    name: 'transcript: flag API-error messages',
    apply: async (ctx) => {
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 10,
    name: 'stats: parse interactive-prompt options for one-click answers',
    apply: async (ctx) => {
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 11,
    name: 'stats: parse multi-select prompt checkboxes',
    apply: async (ctx) => {
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 12,
    name: 'stats: detect confirm/review screens (cursor-on-option)',
    apply: async (ctx) => {
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
];

/** Highest migration version (the version a fully up-to-date agent is at). */
export const LATEST_VERSION = migrations.reduce((m, x) => Math.max(m, x.version), 0);

/** File inside the agent recording the highest applied migration version. */
export const VERSION_MARKER = '/opt/agent-runtime/.swarm-version';
