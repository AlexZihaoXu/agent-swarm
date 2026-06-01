import { test } from 'node:test';
import assert from 'node:assert/strict';
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
