import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { journalReport, writeReport } from '../src/analytics/journalReport.js';
const T = Date.UTC(2026, 8, 27), H = 3_600_000;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-phase0-'));
  const input = path.join(root, 'input'); fs.mkdirSync(input);
  const trade = { id: 'fixture-1', mint: 'm', mode: 'PAPER', strategy: 'TEST', openedAt: T + 1000,
    closedAt: T + H, pnlSol: -.1, sizeSol: .2 };
  fs.writeFileSync(path.join(input, 'state.json'), JSON.stringify({ mode: 'PAPER', paperStartSol: 1,
    cashSol: .9, history: [trade], positions: [], realizedLifetimePnlSol: -.1, system: { lastCycle: T + 4 * H } }));
  fs.writeFileSync(path.join(input, 'market.ndjson'), [
    { type: 'paper-reset', ts: T, amountSol: 1 },
    { type: 'scan-candidate', ts: T + 500, a: { mint: 'm', dominantSignal: 'momentum' } },
    { type: 'trade-close', ts: T + H, trade },
    { type: 'scan-summary', ts: T + 4 * H, regime: 'COLD' },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  return { root, input };
}
function hashes(dir) {
  return Object.fromEntries(fs.readdirSync(dir).map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')]));
}
test('reporting is read-only, makes zero network calls, and reconciles fixtures', async () => {
  const { root, input } = fixture(), before = hashes(input), previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('Network forbidden in Phase 0'); };
  try {
    const report = await journalReport({ dataDir: input });
    assert.equal(report.currentBook.metrics[0].tradeCount, 1);
    assert.ok(Math.abs(report.currentBook.accountingGap) < 1e-10);
    assert.equal(report.currentBook.attribution.rows[0].strategyId, 'momentum');
    assert.equal(report.retainedJournal.tradeCount, 1);
    assert.deepEqual(hashes(input), before); assert.equal(calls, 0);
    const files = writeReport(report, path.join(root, 'output', 'report'), input);
    assert.equal(JSON.parse(fs.readFileSync(files.json)).schema, 'mpo.phase0.journal-report.v1');
    assert.match(fs.readFileSync(files.markdown, 'utf8'), /EDGE_NOT_PROVEN/);
    assert.throws(() => writeReport(report, path.join(root, 'output', 'report'), input), /overwrite/);
    assert.throws(() => writeReport(report, path.join(input, 'nested', 'bad'), input), /outside/);
    assert.equal(fs.existsSync(path.join(input, 'nested')), false);
    assert.deepEqual(hashes(input), before);
  } finally { globalThis.fetch = previousFetch; fs.rmSync(root, { recursive: true, force: true }); }
});
test('corrupt sources fail rather than reporting fake empty success', async () => {
  const { root, input } = fixture();
  try {
    fs.writeFileSync(path.join(input, 'state.json'), '{not-json');
    await assert.rejects(journalReport({ dataDir: input }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('filtered-window P&L stays separate from lifetime accounting', async () => {
  const { root, input } = fixture();
  try {
    const report = await journalReport({ dataDir: input, from: T + H + 1, to: T + 4 * H });
    assert.equal(report.currentBook.metrics[0].tradeCount, 0);
    assert.equal(report.currentBook.windowClosedPnl, 0);
    assert.equal(report.currentBook.closedPnl, -.1);
    assert.ok(Math.abs(report.currentBook.accountingGap) < 1e-10);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
