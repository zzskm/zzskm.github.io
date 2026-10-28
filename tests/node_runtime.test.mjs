import test from 'node:test';
import assert from 'node:assert/strict';
import { isPatchedNode } from '../scripts/check-node-runtime.mjs';

test('rejects affected Node releases and unsupported/prerelease runtimes', () => {
  for (const version of ['20.20.0', '22.23.3', '24.20.0', '24.22.0', '25.0.0', '26.12.0', '24.22.1-rc.1', 'unknown']) {
    assert.equal(isPatchedNode(version), false, version);
  }
});

test('accepts security backports and later patches on supported release lines', () => {
  for (const version of ['v22.23.4', '22.23.5', '22.24.0', '24.22.1', '24.23.0', '26.12.1']) {
    assert.equal(isPatchedNode(version), true, version);
  }
});
