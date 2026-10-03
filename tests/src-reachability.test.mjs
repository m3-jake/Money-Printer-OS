// Run C4: src/ holds only what ships and runs. Offline tools and test-only modules live in tools/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reachableFrom, srcFiles, specifiers } from './helpers/src-reachability.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Work in progress that is deliberately not wired yet. Add to this list only with a reason.
const ALLOWED_UNREACHABLE = new Map([['src/paperBookStore.js', 'another agent\'s untracked work in progress (run brief C4)']]);

test('every file in src/ is reachable from a runtime entry point', () => {
  const reach = reachableFrom(root);
  const stray = srcFiles(root).filter(f => !reach.has(f) && !ALLOWED_UNREACHABLE.has(f));
  assert.deepEqual(stray, [], `move offline tools to tools/ or delete dead code: ${stray.join(', ')}`);
});

test('the reachability walk sees every import form the app uses', () => {
  const src = `import a from './a.js'; import { b } from "../b.js"; export * from './c.js'; await import('./d.js');
    new Worker(new URL('./e.js', import.meta.url)); require('./f.cjs'); path.join(root, 'src', 'g.js'); import './h.js';`;
  assert.deepEqual(specifiers(src).sort(), ['../b.js', './a.js', './c.js', './d.js', './e.js', './f.cjs', './h.js', 'g.js']);
});

test('runtime code never imports from tools/', () => {
  const reach = reachableFrom(root);
  for (const f of reach) if (f.startsWith('src/')) for (const spec of specifiers(fs.readFileSync(path.join(root, f), 'utf8')))
    assert.ok(!path.resolve(root, path.dirname(f), spec).includes(path.sep + 'tools' + path.sep), `${f} imports ${spec}`);
});
