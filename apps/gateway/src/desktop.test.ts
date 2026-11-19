import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { desktopAsset } from './desktop.js';

test('the viewer page and noVNC modules map to bundled files', () => {
  assert.match(desktopAsset('/') ?? '', /novnc-index\.html$/);
  const rfb = desktopAsset('/core/rfb.js');
  assert.ok(rfb && existsSync(rfb), 'core/rfb.js is bundled');
});

test('nothing outside the viewer is served, including traversal', () => {
  for (const p of ['/vnc.html', '/core/../package.json', '/core/../../../etc/passwd', '/app/ui.js'])
    assert.equal(desktopAsset(p), null, p);
});
