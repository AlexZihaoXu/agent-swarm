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
  {
    version: 13,
    name: 'prompt: faithful colored HTML render of the open selector',
    apply: async (ctx) => {
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 14,
    name: 'prompt: clean preview labels + capture Chat-about-this/Type-something',
    apply: async (ctx) => {
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 15,
    name: 'guide: explain mention-only delivery from unwatched channels',
    apply: async (ctx) => {
      // Refresh the operator guide so existing agents learn that an @mention
      // from a channel they don't watch arrives as a lone message (no context),
      // and that they should discord_read_messages before replying.
      await ctx.putFile('agent-claude.md', '/home/agent/CLAUDE.md');
      // Restart the claude session so it re-reads CLAUDE.md (transcript persists).
      await ctx.exec('chown agent:agent /home/agent/CLAUDE.md; systemctl restart agent-terminals');
    },
  },
  {
    version: 16,
    name: 'swarm tools: swarm_set_effort (self-enable ultracode at runtime)',
    apply: async (ctx) => {
      // Ship the MCP tool script itself, not the whole tools/ dir — the image
      // builds discord-mcp's node_modules in place under /opt/agent-tools, and
      // a putDir would overwrite that tree with the un-built source.
      await ctx.putFile('tools/swarm.py', '/opt/agent-tools/swarm.py');
      // Restart the claude session so it re-registers the swarm MCP tool list
      // (transcript persists).
      await ctx.exec(
        'chown agent:agent /opt/agent-tools/swarm.py; systemctl restart agent-terminals',
      );
    },
  },
  {
    version: 17,
    name: 'boot: wait for a real ready signal before the restart nudge',
    apply: async (ctx) => {
      // The supervisor used to type its [sys://restart] / [sys://resume] nudge
      // after a fixed 12s, which lands in the middle of a slow pre-launch
      // `npm install -g claude-code` and is lost. The boot chain now signals
      // when the update is actually done.
      await ctx.putFile('swarm-signal-ready.sh', '/usr/local/bin/swarm-signal-ready');
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec(
        'chmod +x /usr/local/bin/swarm-signal-ready; ' +
          'chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals',
      );
    },
  },
  {
    version: 18,
    name: 'inject: scripted key sequences (drives the /effort switch)',
    apply: async (ctx) => {
      // /api/inject gains a `steps` form (bare Enter, typed text, waits) so the
      // gateway can drive the /effort selector, which a single text+Enter can't
      // express. Separate from 17 even though both ship `runtime`: an agent that
      // already applied 17 has the pre-steps supervisor and still needs this.
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 19,
    name: 'swarm_set_effort: warn that the switch interrupts the current turn',
    apply: async (ctx) => {
      // The /effort switch now leads with Esc so the new level applies
      // immediately. That interrupts whatever the agent is doing, so the tool
      // reply — the last thing it reads before being cut off — has to say so.
      await ctx.putFile('tools/swarm.py', '/opt/agent-tools/swarm.py');
      await ctx.exec(
        'chown agent:agent /opt/agent-tools/swarm.py; systemctl restart agent-terminals',
      );
    },
  },
  {
    version: 20,
    name: 'screenshot: time out a wedged capture instead of hanging forever',
    apply: async (ctx) => {
      // `import` against a hung X server never exits, so /api/screenshot never
      // responded. The dashboard polls it per agent every 2.5s, so a few stuck
      // agents exhausted the browser's connection budget and the whole fleet
      // showed "connecting…" despite being responsive.
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 21,
    name: 'desktop: restart tigervnc/novnc automatically if the session dies',
    apply: async (ctx) => {
      // A dying Xvnc exits 0, so systemd treated it as a clean stop and left
      // the desktop down — found on 4 of 7 agents, which is what broke their
      // previews. Restart=always brings it back; the existing
      // ConditionPathExists is re-checked on restart, so a desktop the operator
      // turned OFF stays off instead of looping.
      await ctx.exec(
        [
          'install -d /etc/systemd/system/tigervncserver@:1.service.d',
          "printf '[Unit]\\nConditionPathExists=!/home/agent/.swarm/desktop-disabled\\n[Service]\\nRestart=always\\nRestartSec=5\\n' > /etc/systemd/system/tigervncserver@:1.service.d/50-desktop-toggle.conf",
          'install -d /etc/systemd/system/novnc.service.d',
          "printf '[Unit]\\nConditionPathExists=!/home/agent/.swarm/desktop-disabled\\n[Service]\\nRestart=always\\nRestartSec=5\\n' > /etc/systemd/system/novnc.service.d/50-desktop-toggle.conf",
          'systemctl daemon-reload',
          // Only bring it up if the operator hasn't disabled the desktop.
          'test -e /home/agent/.swarm/desktop-disabled || systemctl start tigervncserver@:1 novnc || true',
        ].join('; '),
      );
    },
  },
  {
    version: 22,
    name: 'transcript: include tool arguments (which keys a hotkey sent, etc.)',
    apply: async (ctx) => {
      // The chat only had the tool's NAME plus the first string in its input,
      // so computer-use calls were unreadable: a hotkey's keys are an array and
      // clicks/moves are numbers, so both rendered with no detail at all.
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 23,
    name: 'chatgpt provider: Codex translating proxy + credential-safe provider switch',
    apply: async (ctx) => {
      // Ships codex-proxy.js (Anthropic Messages <-> Codex Responses) and the
      // rewritten settingsEnv(). Deliberately written in Node rather than a
      // downloaded binary so it lives in the SOFT layer and can ship here at
      // all — a binary would need a Dockerfile change and a container recreate.
      //
      // Also carries a SECURITY fix: settingsEnv() used to fall through to the
      // Anthropic branch for any provider it didn't recognise, handing that
      // agent the operator's Claude OAuth token. Agents that skip this
      // migration keep the old behaviour, so apply it before using chatgpt.
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 24,
    name: 'chatgpt provider: report input tokens + real Codex context windows',
    apply: async (ctx) => {
      // The Codex proxy never reported input_tokens, so every turn landed in
      // the transcript as input_tokens=0. Claude Code therefore believed the
      // context was permanently empty and NEVER auto-compacted — a session grew
      // unchecked until the backend rejected it with context_length_exceeded,
      // which it cannot recover from since every retry is equally oversized.
      // The dashboard ring was stuck at whatever the agent last reported under
      // a different provider, which is why one read "276.2k/200k".
      //
      // Also stops rating Codex turns at Anthropic's per-token prices — those
      // run against a ChatGPT subscription and cost nothing per token.
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 25,
    name: 'swarm tools: re-push swarm.py for agents stamped past migration 16',
    apply: async (ctx) => {
      // Repairs agents that were created from an image older than migration 16
      // and stamped at LATEST_VERSION anyway (see stampVersion). They never ran
      // 16 or 19, so `swarm_set_effort` was missing from their swarm.py while
      // the capability showed as granted — the tool didn't 403, it didn't exist.
      //
      // Re-pushing the file is idempotent, so agents that already have it are
      // unaffected. putFile rather than putDir: the image builds discord-mcp's
      // node_modules in place under /opt/agent-tools and a putDir would
      // overwrite that tree with un-built source.
      await ctx.putFile('tools/swarm.py', '/opt/agent-tools/swarm.py');
      // Claude re-registers the MCP tool list only on session start, so the tool
      // stays invisible until this restart (the transcript persists).
      await ctx.exec(
        'chown agent:agent /opt/agent-tools/swarm.py; systemctl restart agent-terminals',
      );
    },
  },
  {
    version: 26,
    name: 'stats: report when sudo cannot elevate (missing ID-mapped rootfs mount)',
    apply: async (ctx) => {
      // Four agents came up with no ID-mapped rootfs mount, so every root-owned
      // file read as uid 65534 and sudo was silently inert. Nothing fails until
      // something needs apt, so it was found only because one agent happened to
      // check at startup. /api/stats now reports it and the dashboard shows a
      // "no sudo" flag. Detection only — the repair is scripts/fix-sysbox-idmap.py
      // (upper layer stuck shifted) or scripts/fix-sysbox-overshift.py (shifted
      // one time too many). A plain stop/start does NOT clear either.
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 27,
    name: 'opencode-proxy: stop respawning a proxy that cannot start',
    apply: async (ctx) => {
      // oc-go-cc refuses to start without a config file, and nothing ever ran
      // `oc-go-cc init`, so on EVERY agent the supervisor forked it, watched it
      // exit(1), and forked it again 2s later — forever. It went unnoticed
      // because the proxy is only load-bearing for opencodeGo agents and there
      // were none; the visible damage was a console full of the same usage
      // banner ~30x/minute and a journal growing without bound.
      //
      // Two independent fixes, since either alone would have prevented this:
      // the supervisor now starts the chain only for an agent that can actually
      // use it and gives up after bounded backoff, and the config it wanted is
      // created here (and at image build) so opencodeGo agents still work.
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec(
        [
          'chown -R agent:agent /opt/agent-runtime',
          // runuser, not su: PAM is what breaks on an ID-map fault, and this
          // must not become the thing that fails on an otherwise fine agent.
          'test -f /home/agent/.config/oc-go-cc/config.json || ' +
            'HOME=/home/agent runuser -u agent -- /usr/local/bin/oc-go-cc init || true',
          // The loop wrote ~10 GB of identical usage banners across the fleet and
          // pushed two agents to journald's 4 GB default cap, where it began
          // evicting the real history. Cap it and reclaim what it took.
          'install -d /etc/systemd/journald.conf.d',
          "printf '[Journal]\\nSystemMaxUse=300M\\nRuntimeMaxUse=100M\\n' > /etc/systemd/journald.conf.d/50-swarm-size.conf",
          'systemctl restart systemd-journald || true',
          'journalctl --rotate || true',
          'journalctl --vacuum-size=300M || true',
          'systemctl restart agent-terminals',
        ].join('; '),
      );
    },
  },
  {
    version: 28,
    name: 'desktop: let Ctrl-C/Ctrl-V reach the agent’s own session',
    apply: async (ctx) => {
      // noVNC preventDefaults every keydown and forwards the keysym, so once it
      // holds focus these are copy/paste INSIDE the container, against its own X
      // selection — nothing is bridged to or from the host clipboard. The bug was
      // only ever about focus: noVNC grabs it on click alone, so a click anywhere
      // else quietly handed the shortcuts back to the browser and Ctrl-C copied
      // the surrounding page instead of the agent's selection.
      //
      // Staged through /opt/agent-runtime rather than written straight to
      // /usr/share/novnc: putArchive resolves the destination in the container's
      // rootfs, and on a running sysbox agent that fails for a path still sitting
      // in a lower image layer. /opt/agent-runtime is already copied up.
      await ctx.putFile('novnc-index.html', '/opt/agent-runtime/novnc-index.html');
      // Static file — websockify reads it per request, so nothing restarts and no
      // session is interrupted.
      await ctx.exec(
        'install -m 0644 /opt/agent-runtime/novnc-index.html /usr/share/novnc/index.html',
      );
    },
  },
  {
    version: 29,
    name: 'cups: mask the printing stack that filled the host disk',
    apply: async (ctx) => {
      // An agent has no printer, but ubuntu-desktop-minimal's recommends pull in
      // cups-daemon and systemd starts it. On an agent carrying the sysbox
      // ID-shift fault, /usr/lib/cups/notifier/dbus reads as uid 65534, cupsd
      // refuses to run a notifier whose permissions it cannot trust, and the
      // dbus subscription retries forever -- two lines per iteration, no backoff.
      // /var/log/cups/error_log reached ~50 GB on each of four agents (202 GB)
      // and took the host to 100% full twice before anyone looked, because the
      // file lives in the container's writable layer rather than under
      // .swarm_data, so it is invisible to a du of the agent workspaces.
      //
      // Migration 27's journald cap cannot catch this: cupsd writes error_log
      // directly and never goes through the journal.
      //
      // Every step is `|| true`. On an ID-shifted agent /etc and /var/log are
      // owned outside the container's userns map, so the persistent mask and the
      // truncate can both legitimately fail with EACCES -- and a migration that
      // throws there would block every later migration on the agents that need
      // them most. `mask --runtime` writes to /run (tmpfs, always writable) and
      // holds until the next container start, by which point an agent recreated
      // from the current image is masked at build time anyway.
      await ctx.exec(
        [
          'systemctl stop cups.service cups.socket cups.path cups-browsed.service || true',
          'systemctl mask cups.service cups.socket cups.path cups-browsed.service || ' +
            'systemctl mask --runtime cups.service cups.socket cups.path cups-browsed.service || true',
          // Reclaim what the loop already wrote. truncate, not rm: on an agent
          // where cupsd somehow survived the stop it still holds the fd, and an
          // unlinked inode would hold the blocks until it exits.
          'truncate -s 0 /var/log/cups/error_log 2>/dev/null || true',
          // Secondary net, matching the image: bound the file even if something
          // later unmasks cups.
          "grep -q '^MaxLogSize' /etc/cups/cupsd.conf 2>/dev/null || " +
            "printf 'MaxLogSize 16m\\nMaxLogFiles 1\\n' >> /etc/cups/cupsd.conf 2>/dev/null || true",
        ].join('; '),
      );
    },
  },
  {
    version: 30,
    name: 'codex: the Default model id was one OpenAI has since dropped',
    apply: async (ctx) => {
      // The proxy's DEFAULT_MODEL was gpt-5.4, which the ChatGPT/Codex backend
      // now refuses outright ("not supported when using Codex with a ChatGPT
      // account"), so every chatgpt-provider agent left on Default was talking
      // to a model that no longer exists for it. Re-probed 2026-09-08: the
      // accepted set is gpt-6-astra, gpt-5.6-sol/terra/luna, gpt-5.5 and
      // gpt-5.4-mini; the default is now gpt-6-astra, which is also the largest
      // context of the set. An agent with an explicit model keeps it.
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.exec('chown -R agent:agent /opt/agent-runtime; systemctl restart agent-terminals');
    },
  },
  {
    version: 31,
    name: "security: only the gateway may reach the agent's terminal and desktop",
    apply: async (ctx) => {
      // The terminal runtime (:7681) and websockify (:6080) accepted anyone on
      // swarm-net, so one agent could open a shell in, or drive the desktop
      // of, another. Both now require the per-agent key the gateway writes to
      // ~/.swarm/runtime-key (callers on loopback, i.e. the agent's own tools,
      // are exempt). Restarting agent-terminals restarts the claude session;
      // its transcript persists. try-restart leaves a turned-off desktop off.
      // The unit is staged through /opt/agent-runtime, like novnc-index.html in
      // migration 28 (putArchive can't write into a lower sysbox image layer).
      await ctx.putDir('runtime', '/opt/agent-runtime');
      await ctx.putFile('novnc.service', '/opt/agent-runtime/novnc.service');
      await ctx.exec(
        [
          'install -m 0644 /opt/agent-runtime/novnc.service /etc/systemd/system/novnc.service',
          'chown -R agent:agent /opt/agent-runtime',
          'systemctl daemon-reload',
          'systemctl restart agent-terminals',
          'systemctl try-restart novnc || true',
        ].join('; '),
      );
    },
  },
];

/** Highest migration version (the version a fully up-to-date agent is at). */
export const LATEST_VERSION = migrations.reduce((m, x) => Math.max(m, x.version), 0);

/** File inside the agent recording the highest applied migration version. */
export const VERSION_MARKER = '/opt/agent-runtime/.swarm-version';
