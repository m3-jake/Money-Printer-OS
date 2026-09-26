import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSelfReport, latestSelfReport, readSelfReport, buildSelfReport, renderSelfReportMd, localDate } from '../src/selfReport.js';
import { appendProjectJournal, readProjectJournal } from '../src/projectJournal.js';

const fitness = (closes, pnl, verdict = 'BLOCKED') => ({ modules: {
  solana: { verdict, paperRecord: { closes, netPnl: pnl, unit: 'SOL', hitRate: 0.5, profitFactor: 1.1 }, blockers: ['no executable venue prices'], trial: null },
  robinhood: { verdict: 'BLOCKED', paperRecord: { closes: 3, netPnl: -1, unit: 'USD', hitRate: null, profitFactor: null }, blockers: [], trial: { status: 'RUNNING' } } } });

test('a day report is rewritten hourly, then finalized and journaled once on the next day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-self-'));
  try {
    const day1 = new Date(2026, 8, 25, 10).getTime(), day2 = new Date(2026, 8, 26, 9).getTime(), journal = path.join(dir, 'project-journal.ndjson');
    appendProjectJournal(journal, { kind: 'paper-trial', title: 'Robinhood Lab trial abc started', module: 'robinhood', at: day1 + 60000 });
    appendProjectJournal(journal, { id: 'git:1', kind: 'git-milestone', title: 'commit', at: day1 + 120000 });
    let r = runSelfReport({ dataDir: dir, fitness: fitness(10, 0.1), state: { mode: 'paper', system: { health: 'HEALTHY' } }, now: day1 });
    assert.deepEqual([r.wrote, r.finalized, r.error], [true, null, null]);
    runSelfReport({ dataDir: dir, fitness: fitness(12, 0.15), state: {}, now: day1 + 3600000 });
    const d1 = readSelfReport(dir, localDate(day1));
    assert.equal(d1.final, false); assert.equal(d1.modules.solana.closes, 12); assert.equal(d1.commits, 1);
    assert.deepEqual(d1.decisions.map(x => x.title), ['Robinhood Lab trial abc started']);
    assert.ok(fs.existsSync(path.join(dir, 'reports', 'self', `${localDate(day1)}.md`)));
    r = runSelfReport({ dataDir: dir, fitness: fitness(20, 0.05, 'PARK'), state: {}, now: day2 });
    assert.equal(r.finalized, localDate(day1)); assert.equal(readSelfReport(dir, localDate(day1)).final, true);
    const d2 = latestSelfReport(dir);
    assert.equal(d2.date, localDate(day2)); assert.deepEqual(d2.modules.solana.delta, { closes: 8, netPnl: -0.1, verdictChanged: 'BLOCKED -> PARK' });
    runSelfReport({ dataDir: dir, fitness: fitness(21, 0.05), state: {}, now: day2 + 3600000 });
    const entries = readProjectJournal(journal).filter(x => x.kind === 'daily-report');
    assert.equal(entries.length, 1, 'yesterday is journaled exactly once'); assert.match(entries[0].title, new RegExp(localDate(day1)));
    assert.equal(entries[0].detail, 'solana BLOCKED, 12 closes, net 0.15 SOL; robinhood BLOCKED, 3 closes, net -1 USD');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('markdown reads cleanly and a broken data dir reports an error instead of throwing', () => {
  const r = buildSelfReport({ date: '2026-09-26', fitness: fitness(5, 0.01), previous: null, state: { mode: 'paper', system: { health: 'HEALTHY', paused: true } }, journal: [], now: Date.UTC(2026, 8, 26) });
  const md = renderSelfReportMd(r);
  assert.match(md, /# Money Printer OS daily report, 2026-09-26 \(in progress\)/); assert.match(md, /PAUSED/); assert.match(md, /\*\*robinhood\*\*: BLOCKED, trial RUNNING/); assert.match(md, /- none/);
  const file = path.join(os.tmpdir(), `mpo-self-file-${process.pid}`); fs.writeFileSync(file, 'x');
  try { assert.match(runSelfReport({ dataDir: file, fitness: fitness(1, 0), now: Date.now() }).error, /./); }
  finally { fs.rmSync(file, { force: true }); }
});
