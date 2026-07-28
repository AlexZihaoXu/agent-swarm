import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type Docker from 'dockerode';
import { AgentManager, resolveHostPort } from './docker.js';
import { config } from './config.js';

test('resolveHostPort maps an internal port to its published host port', () => {
  const ports = { '7681/tcp': [{ HostIp: '0.0.0.0', HostPort: '49160' }] };
  assert.deepEqual(resolveHostPort(ports, 7681), { host: '127.0.0.1', port: 49160 });
});

test('resolveHostPort throws when the port is unpublished', () => {
  assert.throws(() => resolveHostPort({ '7681/tcp': null }, 7681));
  assert.throws(() => resolveHostPort(undefined, 6080));
});

test('network mode resolves a target by container name (no Docker call)', async () => {
  const manager = new AgentManager({} as Docker, { ...config, mode: 'network' });
  assert.deepEqual(await manager.resolveTarget('abc', 'desktop'), {
    host: 'swarm-agent-abc',
    port: 6080,
  });
  assert.deepEqual(await manager.resolveTarget('abc', 'terminal'), {
    host: 'swarm-agent-abc',
    port: 7681,
  });
});

test('ports mode inspects the container and uses the published port', async () => {
  const fakeDocker = {
    getContainer(name: string) {
      assert.equal(name, 'swarm-agent-xyz');
      return {
        inspect: async () => ({
          NetworkSettings: { Ports: { '6080/tcp': [{ HostPort: '32770' }] } },
        }),
      };
    },
  } as unknown as Docker;
  const manager = new AgentManager(fakeDocker, { ...config, mode: 'ports' });
  assert.deepEqual(await manager.resolveTarget('xyz', 'desktop'), {
    host: '127.0.0.1',
    port: 32770,
  });
});

// --- compactAgent debounce -------------------------------------------------
// The TUI accumulates typed text from rapid Esc+/compact+Enter injections
// when claude isn't immediately in input mode, producing `/compact/compact/
// /compact/...` strings in the prompt. The debounce drops duplicate calls
// inside a fixed window (current default: 30s) so the in-flight compaction
// runs to completion before a new injection lands.

function stubManager(opts: { running?: boolean } = {}) {
  const manager = new AgentManager({} as Docker, { ...config, mode: 'network' });
  const calls: { id: string; text: string; interrupt: boolean }[] = [];
  // The HTTP fetch in injectToTerminal would otherwise try to reach a real
  // terminal; stub it to record the call instead.
  (
    manager as unknown as {
      injectToTerminal: (id: string, text: string, interrupt?: boolean) => Promise<void>;
    }
  ).injectToTerminal = async (id, text, interrupt = false) => {
    calls.push({ id, text, interrupt });
  };
  // getAgent normally inspects Docker; stub with the requested status.
  (manager as unknown as { getAgent: (id: string) => Promise<unknown> }).getAgent = async (id) => ({
    id,
    name: id,
    image: 'agent-swarm/agent:test',
    status: opts.running === false ? 'exited' : 'running',
    createdAt: 0,
    username: id,
  });
  return { manager, calls };
}

test('compactAgent injects /compact with interrupt=true on first call', async () => {
  const { manager, calls } = stubManager();
  const fired = await manager.compactAgent('alpha');
  assert.equal(fired, true);
  assert.deepEqual(calls, [{ id: 'alpha', text: '/compact', interrupt: true }]);
});

test('compactAgent is debounced: second call inside the window is a no-op', async () => {
  const { manager, calls } = stubManager();
  await manager.compactAgent('alpha');
  const fired = await manager.compactAgent('alpha');
  assert.equal(fired, false, 'second call should report not fired');
  assert.equal(calls.length, 1, 'only the first call should have injected');
});

test('compactAgent debounce is per-agent (alpha + beta both fire)', async () => {
  const { manager, calls } = stubManager();
  await manager.compactAgent('alpha');
  await manager.compactAgent('beta');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.id, 'alpha');
  assert.equal(calls[1]!.id, 'beta');
});

test('compactAgent throws 409 when the agent is not running', async () => {
  const { manager } = stubManager({ running: false });
  await assert.rejects(manager.compactAgent('alpha'), {
    message: 'agent is not running',
  });
});

test('isCompacting flips to true after a successful fire and reads progress', async () => {
  const { manager } = stubManager();
  assert.equal(manager.isCompacting('alpha'), false, 'no compaction → false');
  assert.equal(manager.compactingProgress('alpha'), 0, 'no compaction → 0');
  await manager.compactAgent('alpha');
  assert.equal(manager.isCompacting('alpha'), true, 'after fire → true');
  const p = manager.compactingProgress('alpha');
  assert.ok(p >= 0 && p < 1, `progress should be in [0,1); got ${p}`);
});

test('debounced second call does NOT reset the compacting clock', async () => {
  const { manager } = stubManager();
  await manager.compactAgent('alpha');
  const beforeProgress = manager.compactingProgress('alpha');
  // Wait a beat so progress would advance if we re-clocked
  await new Promise((r) => setTimeout(r, 10));
  const fired = await manager.compactAgent('alpha');
  assert.equal(fired, false, 'debounced');
  const afterProgress = manager.compactingProgress('alpha');
  assert.ok(
    afterProgress >= beforeProgress,
    'progress should keep advancing forward, never rewind',
  );
});

// --- applyEffortLive sequence ----------------------------------------------
// A bare "type /effort <level> + Enter" isn't enough: the slash command opens a
// selector that redraws, and the caller is often the agent itself, mid-turn,
// with a half-typed line in the composer. The scripted sequence (and the waits
// between the confirmation Enters) is the contract — assert it exactly, since
// getting it early is precisely what breaks the switch.

function stubEffortManager() {
  const manager = new AgentManager({} as Docker, { ...config, mode: 'network' });
  const keys: { id: string; steps: unknown[] }[] = [];
  const texts: { id: string; text: string }[] = [];
  (
    manager as unknown as { injectKeys: (id: string, steps: unknown[]) => Promise<void> }
  ).injectKeys = async (id, steps) => {
    keys.push({ id, steps });
  };
  (
    manager as unknown as { injectToTerminal: (id: string, text: string) => Promise<void> }
  ).injectToTerminal = async (id, text) => {
    texts.push({ id, text });
  };
  return { manager, keys, texts };
}

test('applyEffortLive drives Esc → 1s → Enter → command → 5s → Enter → 3s → Enter → 2s', async () => {
  const { manager, keys } = stubEffortManager();
  await (
    manager as unknown as { applyEffortLive: (id: string, level: string) => Promise<void> }
  ).applyEffortLive('alpha', 'ultracode');

  assert.equal(keys.length, 1, 'one scripted sequence');
  assert.equal(keys[0]?.id, 'alpha');
  assert.deepEqual(keys[0]?.steps, [
    { key: 'esc' },
    { waitMs: 1_000 },
    { key: 'enter' },
    { text: '/effort ultracode' },
    { waitMs: 5_000 },
    { key: 'enter' },
    { waitMs: 3_000 },
    { key: 'enter' },
    { waitMs: 2_000 },
  ]);
});

test('applyEffortLive confirms with a sys nudge after the sequence', async () => {
  const { manager, texts } = stubEffortManager();
  await (
    manager as unknown as { applyEffortLive: (id: string, level: string) => Promise<void> }
  ).applyEffortLive('alpha', 'ultracode');

  assert.equal(texts.length, 1, 'exactly one confirmation');
  assert.match(texts[0]?.text ?? '', /^\*\*\[sys:\/\/effort\]\*\*/);
  assert.match(texts[0]?.text ?? '', /effort is now ultracode/);
  assert.match(texts[0]?.text ?? '', /pick up where you left off/i);
});

test('applyEffortLive carries the level through, including default', async () => {
  const { manager, keys, texts } = stubEffortManager();
  await (
    manager as unknown as { applyEffortLive: (id: string, level: string) => Promise<void> }
  ).applyEffortLive('beta', 'default');
  // Find the typed step rather than indexing, so adding a leading key to the
  // script doesn't silently break this into a false pass.
  const typed = (keys[0]?.steps ?? []).find(
    (s) => typeof (s as { text?: string }).text === 'string',
  );
  assert.deepEqual(typed, { text: '/effort default' });
  assert.match(texts[0]?.text ?? '', /effort is now default/);
});

// --- installedVersion in both container states ------------------------------
// Neither read works in both states, and they fail in OPPOSITE directions on
// sysbox-runc: while RUNNING, getArchive 404s (the marker is in a runtime layer
// the archive API can't see) but exec works; while STOPPED, exec 409s but
// getArchive works. Reading the wrong way round silently yields v0, which would
// offer a bogus "v0 → latest" upgrade on every healthy agent.

/** Minimal single-file tar: 512-byte header (octal size at 124) + content. */
function tarOf(content: string): Buffer {
  const buf = Buffer.alloc(1024);
  buf.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
  buf.write(content, 512, 'utf8');
  return buf;
}

function fakeDockerFor(state: 'running' | 'stopped') {
  const running = state === 'running';
  return {
    getContainer() {
      return {
        inspect: async () => ({ State: { Running: running } }),
        exec: async () => {
          if (!running)
            throw Object.assign(new Error('container stopped/paused'), { statusCode: 409 });
          return {
            start: async () => Readable.from([Buffer.from('15\n', 'utf8')]),
          };
        },
        getArchive: async () => {
          if (running)
            throw Object.assign(new Error('Could not find the file'), { statusCode: 404 });
          return Readable.from([tarOf('15\n')]);
        },
      };
    },
  } as unknown as Docker;
}

test('installedVersion reads the marker via exec while the agent is RUNNING', async () => {
  const manager = new AgentManager(fakeDockerFor('running'), { ...config, mode: 'network' });
  assert.equal(await manager.installedVersion('alpha'), 15);
});

test('installedVersion reads the marker via getArchive while the agent is STOPPED', async () => {
  const manager = new AgentManager(fakeDockerFor('stopped'), { ...config, mode: 'network' });
  assert.equal(await manager.installedVersion('alpha'), 15);
});

test('installedVersion reports 0 when the container is gone', async () => {
  const gone = {
    getContainer: () => ({
      inspect: async () => {
        throw new Error('no such container');
      },
    }),
  } as unknown as Docker;
  const manager = new AgentManager(gone, { ...config, mode: 'network' });
  assert.equal(await manager.installedVersion('ghost'), 0);
});

// --- upgrade concurrency ----------------------------------------------------
// Two clicks used to start two independent upgrades of the same agent. Each had
// its own `finally` that stopped the container, so one run's cleanup killed the
// container while the other was still applying migrations — the fleet logged a
// string of "starting stopped agent…" boots that never converged. A second call
// must JOIN the first, not race it.

test('upgrade() joins an in-flight run instead of starting a second one', async () => {
  const manager = new AgentManager({} as Docker, { ...config, mode: 'network' });
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  (manager as unknown as { runUpgrade: (id: string) => Promise<unknown> }).runUpgrade =
    async () => {
      runs++;
      await gate;
      return { installed: 18, latest: 18, outdated: false, pending: [] };
    };

  const a = manager.upgrade('alpha');
  const b = manager.upgrade('alpha');
  assert.equal(runs, 1, 'second call must not start another run');

  release();
  // Both callers observe the same single run's result. (Identity can't be
  // asserted: upgrade() is async, so each call gets its own wrapper promise.)
  assert.deepEqual(await a, await b);
  assert.equal(runs, 1, 'still only one run after both settled');

  // Once settled the entry is cleared, so a later upgrade can run again.
  await manager.upgrade('alpha');
  assert.equal(runs, 2, 'a subsequent upgrade starts a fresh run');
});

test('upgrade() locks per agent, not globally', async () => {
  const manager = new AgentManager({} as Docker, { ...config, mode: 'network' });
  const started: string[] = [];
  (manager as unknown as { runUpgrade: (id: string) => Promise<unknown> }).runUpgrade = async (
    id,
  ) => {
    started.push(id);
    return { installed: 18, latest: 18, outdated: false, pending: [] };
  };
  await Promise.all([manager.upgrade('alpha'), manager.upgrade('beta')]);
  assert.deepEqual(started.sort(), ['alpha', 'beta']);
});

// --- auto-compact back-off --------------------------------------------------
// lumen sat at 40.3% against a 40% threshold with claude not in a state to run
// the slash command, so /compact was injected every 5 minutes indefinitely. The
// guard watches the OUTCOME rather than trying to enumerate the states where
// compaction can't work: if the context didn't fall, wait longer.

/** Mirrors the escalation in checkAutoCompact. */
function nextWait(
  prev: { pct: number; ineffective: number } | undefined,
  contextPct: number,
  base = 5 * 60 * 1000,
  cap = 60 * 60 * 1000,
  minDrop = 3,
) {
  if (!prev) return { waitMs: base, ineffective: 0 };
  const dropped = prev.pct - contextPct >= minDrop;
  const ineffective = dropped ? 0 : prev.ineffective + 1;
  return { waitMs: Math.min(base * 2 ** ineffective, cap), ineffective };
}

test('auto-compact keeps the base cooldown on the first fire', () => {
  assert.deepEqual(nextWait(undefined, 40.3), { waitMs: 300_000, ineffective: 0 });
});

test('auto-compact escalates while the context refuses to drop', () => {
  // The exact lumen case: 40.3% every time, never falling.
  let prev = { pct: 40.3, ineffective: 0 };
  const waits: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = nextWait(prev, 40.3);
    waits.push(r.waitMs);
    prev = { pct: 40.3, ineffective: r.ineffective };
  }
  assert.deepEqual(waits, [600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]);
});

test('auto-compact resets as soon as a compaction actually works', () => {
  const prev = { pct: 92, ineffective: 4 };
  const r = nextWait(prev, 45); // a real compaction drops far more than 3 points
  assert.equal(r.ineffective, 0, 'a genuine drop clears the back-off');
  assert.equal(r.waitMs, 300_000, 'and returns to the base cooldown');
});

test('auto-compact treats a trivial drop as ineffective', () => {
  // 1.5 points is noise, not a compaction.
  const r = nextWait({ pct: 40.3, ineffective: 0 }, 38.8);
  assert.equal(r.ineffective, 1);
});
