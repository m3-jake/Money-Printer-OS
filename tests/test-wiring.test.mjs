import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// P1.4: a suite that is not reachable from `test:all` does not exist, and because `test:all` chains with
// `&&` the first failing target silently skips every target after it — which is exactly how five targets
// stayed unrun until the P0 baseline. This is the drift test for that: it fails when a test file is
// unreachable, when a script names a file that is not there, and it prints the map so the coverage of
// every target is visible instead of assumed.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};
const filesOf = name => (scripts[name] || '').split(/\s+/).filter(x => x.startsWith('tests/'));
const targetsOf = name => [...(scripts[name] || '').matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map(m => m[1]);
const testFilesOnDisk = () => fs.readdirSync(path.join(root, 'tests')).filter(f => /\.test\.(mjs|cjs)$/.test(f)).map(f => 'tests/' + f).sort();

// Reachability from test:all follows the npm-run edge (that is how test:all chains its targets).
const reachable = new Map();
const walk = (name, via, seen = new Set()) => {
  if (seen.has(name)) return seen;
  seen.add(name);
  for (const f of filesOf(name)) if (!reachable.has(f)) reachable.set(f, via || name);
  for (const t of targetsOf(name)) walk(t, via || name, seen);
  return seen;
};
walk('test:all', 'test:all');

test('every suite on disk is reachable from npm run test:all', () => {
  const unreachable = testFilesOnDisk().filter(f => !reachable.has(f));
  assert.deepEqual(unreachable, [], `not run by test:all: ${unreachable.join(', ')}`);
  assert.ok(testFilesOnDisk().length >= 40, 'the scan found the test directory');
});

test('every test path a script names exists, and no file is named twice in one target', () => {
  const missing = [], duplicated = [];
  for (const [name, command] of Object.entries(scripts)) {
    const files = filesOf(name);
    for (const f of files) if (!fs.existsSync(path.join(root, f))) missing.push(`${name} -> ${f}`);
    if (new Set(files).size !== files.length) duplicated.push(name);
  }
  assert.deepEqual(missing, [], `scripts name missing files: ${missing.join(', ')}`);
  assert.deepEqual(duplicated, [], `targets name the same file twice: ${duplicated.join(', ')}`);
});

test('the coverage map is complete and printed (telemetry, not a guess)', () => {
  const byTarget = {};
  for (const name of Object.keys(scripts).filter(n => n.startsWith('test:') && n !== 'test:all')) {
    const files = filesOf(name);
    if (files.length) byTarget[name] = files.length;
  }
  const mapped = new Set(Object.keys(byTarget).flatMap(n => filesOf(n)));
  const onDisk = testFilesOnDisk();
  assert.deepEqual(onDisk.filter(f => !mapped.has(f)), [], 'a suite that no target names');
  const lines = Object.entries(byTarget).sort().map(([n, c]) => `  ${n}: ${c} file${c === 1 ? '' : 's'}`);
  console.log(`test coverage map (${onDisk.length} suites across ${Object.keys(byTarget).length} targets):\n${lines.join('\n')}`);
  assert.equal(reachable.size, onDisk.filter(f => reachable.has(f)).length, 'reachable count matches the disk');
});

// The Robinhood panel used to be embedded in dashboard.html and kept in step by a sync gate whose CRLF bug once hid
// five targets. Since run D2 the HUD loads public/js/mpo-robinhood-panel.js directly, so there is no copy and no gate.
test('no embedded Robinhood panel copy is left to drift', () => {
  assert.ok(!fs.existsSync(path.join(root, 'scripts/sync-robinhood-panel.mjs')));
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), /sync-robinhood-panel/);
});
