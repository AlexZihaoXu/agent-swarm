import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addIntegration, getIntegration, patchIntegration } from './integrations.js';

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'integrations-'));
  return { state: join(root, 'state'), disk: join(root, 'disk') };
}
const diskFile = (d: { disk: string }) => join(d.disk, '.swarm', 'integrations.json');

test('writes go to the gateway copy and the disk mirror', () => {
  const d = dirs();
  addIntegration(d, 'discord', 1);
  patchIntegration(d, 'discord', { rules: { allowedUserIds: ['42'] } }, 2);
  const mirror = JSON.parse(readFileSync(diskFile(d), 'utf8'));
  assert.deepEqual(mirror.discord.rules.allowedUserIds, ['42']);
});

test("an agent rewriting its disk copy doesn't change what the gateway reads", () => {
  const d = dirs();
  addIntegration(d, 'discord', 1);
  const tampered = JSON.parse(readFileSync(diskFile(d), 'utf8'));
  tampered.discord.rules.allowedUserIds = ['attacker'];
  writeFileSync(diskFile(d), JSON.stringify(tampered));
  assert.deepEqual(getIntegration(d, 'discord')?.rules.allowedUserIds, []);
});

test('an existing disk copy is adopted once when the gateway has none', () => {
  const d = dirs();
  mkdirSync(join(d.disk, '.swarm'), { recursive: true });
  writeFileSync(diskFile(d), JSON.stringify({ discord: { type: 'discord', status: 'active' } }));
  assert.equal(getIntegration(d, 'discord')?.status, 'active');
  writeFileSync(diskFile(d), JSON.stringify({}));
  assert.equal(getIntegration(d, 'discord')?.status, 'active');
});
