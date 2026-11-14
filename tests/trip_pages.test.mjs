import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('generated trip pages are in sync with the shared template', () => {
  assert.doesNotThrow(
    () => execFileSync(process.execPath, ['scripts/build_trip_pages.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' }),
    'trip_2026_dec_japan.html / trip_2026_dec_china.html are out of date; run: node scripts/build_trip_pages.mjs',
  );
});