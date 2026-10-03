// The trader owns the shared strategy core; the Evolution Lab must score byte-identical copies (see shared-core.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'shared-core.json'), 'utf8'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r/g, '')).digest('hex');
const labRoot = process.env.MPO_LAB_ROOT || path.join(root, '..', 'money-printer-evolution-lab');

test('every shared-core file matches its stamped hash (edit, then run scripts/sync-shared-core.mjs)', () => {
  assert.equal(manifest.owner, 'money-printer-os');
  for (const [file, entry] of Object.entries(manifest.files)) assert.equal(sha(path.join(root, file)), entry.sha256, `${file} changed without a shared-core sync`);
});

test('the sibling Evolution Lab checkout runs the same shared core', { skip: !fs.existsSync(path.join(labRoot, 'shared-core.json')) && 'no Lab checkout beside this one' }, () => {
  for (const [file, entry] of Object.entries(manifest.files)) assert.equal(sha(path.join(labRoot, entry.lab)), entry.sha256, `Lab ${entry.lab} differs from trader ${file}`);
});
