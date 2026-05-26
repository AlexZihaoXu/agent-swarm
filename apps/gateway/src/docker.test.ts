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
