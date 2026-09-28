// P5.1: the documents of record are part of the deliverable. P0-P4 changed the engine's behaviour and
// its export surface, and three documents plus one test comment went on describing the pre-remediation
// tree — including the exact premise P4.3 had just disproved. This is the drift test for that class of
// failure, in the shape P0.5 gave docs/RUNBOOK-PANIC.md: each claim a reader would act on is checked
// against the source of truth (the export list from src/index.js, the suite count from tests/, the
// reachability from package.json), so a claim that drifts fails here with the reader's name.
//
// Scope note: AUDIT.md and PROGRESS.md are excluded from the premise scan on purpose. Quoting a finding
// in order to disprove it is what the ledger does, and those rows say so in the same paragraph; the
// scan targets the documents a reader trusts as description, not the ones that record the dispute.
//
// P5.3 carried the same treatment to the other end of the same problem: the two `.agent-state` entry
// points still opened at 2026-09-27 alpha.67 while the tree had moved through P0-P5, so a session that
// reads those files first got a state description with no route to the record and no signal that
// anything had changed. Their pin is indirect on purpose — see the last test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const status = read('MONEY_PRINTER_STATUS.md');
const bugs = read('.agent-state/KNOWN_BUGS.md');
const engine = read('src/index.js');
const pkg = JSON.parse(read('package.json'));
const scripts = pkg.scripts || {};

// The export surface, taken from the source rather than from the document.
const exported = [...engine.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap(m => m[1].split(',').map(s => s.trim()).filter(Boolean));

const sectionOf = (doc, heading) => {
  const at = doc.indexOf(heading);
  assert.ok(at >= 0, `the document of record lost its "${heading}" heading`);
  const body = doc.slice(at + heading.length);
  const end = body.search(/\n## /);
  return end < 0 ? body : body.slice(0, end);
};

const filesOf = name => (scripts[name] || '').split(/\s+/).filter(x => x.startsWith('tests/'));
const targetsOf = name => [...(scripts[name] || '').matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map(m => m[1]);

// Reachability from test:all follows the npm-run edge, the same way tests/test-wiring.test.mjs walks it.
const walk = (name, files = new Set(), targets = new Set(), seen = new Set()) => {
  if (seen.has(name)) return { files, targets };
  seen.add(name);
  if (name !== 'test:all') targets.add(name);
  for (const f of filesOf(name)) files.add(f);
  for (const t of targetsOf(name)) walk(t, files, targets, seen);
  return { files, targets };
};
const reachable = walk('test:all');
test('the engine line states the export surface and the guard src/index.js actually has', () => {
  const line = status.split('\n').find(l => l.includes('**Engine / HUD:**'));
  assert.ok(line, 'the architecture list lost its Engine / HUD line');
  assert.deepEqual(exported, ['main', 'cycle', 'enter', 'updatePositions'],
    'the export surface moved — name the new set here and in the Engine / HUD line together');
  for (const name of exported) {
    assert.ok(line.includes('`' + name + '`'), `the Engine / HUD line does not name the export ${name}`);
  }
  assert.match(line, /isMainModule/, 'the Engine / HUD line no longer says what keeps an import side-effect free');
  assert.match(engine, /const isMainModule\s*=/, 'the guard the documents rely on is gone');
  assert.match(engine, /if \(isMainModule\)/, 'main() is no longer behind the guard, so importing the engine now starts it');
});

test('the counts the documents of record quote are the counts on disk', () => {
  const onDisk = fs.readdirSync(path.join(root, 'tests')).filter(f => /\.test\.(mjs|cjs)$/.test(f));
  const suites = status.match(/(\d+) suites in `tests\/`/);
  assert.ok(suites, 'the tests line no longer quotes a suite count');
  assert.equal(Number(suites[1]), onDisk.length, 'MONEY_PRINTER_STATUS.md quotes a stale suite count');
  const targets = status.match(/across (\d+) targets/);
  assert.ok(targets, 'the tests line no longer quotes a target count');
  assert.equal(Number(targets[1]), reachable.targets.size, 'the quoted target count is not what test:all reaches');
});

test('the enter() open item is closed and the suite that closed it is reached by test:all', () => {
  const open = sectionOf(status, '## Broken / unfinished / open');
  assert.doesNotMatch(open, /no direct end-to-end test/, 'the open list still claims enter() has no end-to-end test');
  const oracle = 'tests/trade-path.test.mjs';
  assert.ok(fs.existsSync(path.join(root, oracle)), 'the suite the correction points at is gone');
  for (const [name, doc] of [['MONEY_PRINTER_STATUS.md', status], ['.agent-state/KNOWN_BUGS.md', bugs]]) {
    assert.ok(doc.includes(oracle), `${name} does not name the suite that closed the item`);
  }
  assert.ok(reachable.files.has(oracle), `${oracle} is not reached by test:all, so the closure rests on a suite that never runs`);
  const suite = read(oracle);
  for (const fn of ['enter', 'updatePositions', 'cycle']) {
    assert.ok(suite.includes(`engine.${fn}(`), `the suite no longer calls ${fn}(), which is the closure the documents claim`);
  }
});

// The disproven premise, in the wordings that were actually written down. A paragraph that talks about
// src/index.js and restates one of these must also say it was wrong — otherwise the next reader resolves
// the contradiction by trusting the wrong sentence.
const PREMISE = [/calls main\(\) at import time/i, /exports nothing/i, /cannot be imported by a test/i, /exports only `main`/i];
const CORRECTED = /disproven|disprove|superseded|supersedes|no longer|used to|was believed|P4\.3|never import/i;
const mdFiles = dir => fs.readdirSync(path.join(root, dir || '.'))
  .filter(f => f.endsWith('.md'))
  .map(f => (dir ? `${dir}/${f}` : f))
  .filter(f => !/(?:^|\/)(?:AUDIT|PROGRESS)\.md$/.test(f));
const walkDir = (dir, re) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walkDir(`${dir}/${e.name}`, re) : (re.test(e.name) ? [`${dir}/${e.name}`] : []));
const SOURCES = [...mdFiles(''), ...mdFiles('.agent-state'), ...mdFiles('docs'), ...walkDir('src', /\.c?js$/), ...walkDir('tests', /\.test\.(mjs|cjs)$/)];

test('the disproven import premise survives only as a labelled correction', () => {
  const offenders = [];
  for (const rel of SOURCES) {
    read(rel).split(/\r?\n\s*\r?\n/).forEach((paragraph, i) => {
      if (!paragraph.includes('src/index.js')) return;
      if (!PREMISE.some(re => re.test(paragraph))) return;
      if (CORRECTED.test(paragraph)) return;
      offenders.push(`${rel} paragraph ${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `the disproven premise is restated as current fact in: ${offenders.join(', ')}`);
  assert.ok(SOURCES.length > 20, 'the scan found the documents and sources it is supposed to cover');
});

// The entry points a session opens before it touches anything. The pin is deliberately indirect: each
// file must name the ledger of record, and neither may be older than the pass the ledger records. A pass
// that changes behaviour and leaves these silent fails here, and no edit to the ledger alone can satisfy
// it — which is the failure mode that produced this file.
const ENTRY_POINTS = ['.agent-state/CURRENT_TASKS.md', '.agent-state/PROJECT_STATE.md'];
const datesIn = doc => [...doc.matchAll(/20\d\d-\d\d-\d\d/g)].map(m => m[0]).sort();
const newest = doc => datesIn(doc).at(-1);

test('the agent-state entry points are not older than the record they describe', () => {
  const ledger = read('PROGRESS.md');
  assert.match(ledger, /^\*\*P\d+\.\d+ /m, 'PROGRESS.md no longer holds dated pass items, so the entry points route to nothing');
  const newestLedger = newest(ledger);
  assert.ok(newestLedger, 'PROGRESS.md carries no date for the pass it records');
  for (const rel of ENTRY_POINTS) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is gone — the entry point a session reads first moved`);
    const doc = read(rel);
    assert.match(doc, /PROGRESS\.md/, `${rel} does not route the reader to the ledger of record`);
    assert.ok(newest(doc) >= newestLedger,
      `${rel} is older (${newest(doc)}) than the pass the ledger records (${newestLedger}) — a pass changed the tree and left the entry point silent`);
  }
});

