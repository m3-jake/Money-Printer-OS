import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { computeWalletScorecards, walletScorecardSnapshot, gradedScores, poolWallets, __testing } from '../src/walletScorecard.js';

const W = 'Wallet1111111111111111111111111111111111111', X = 'Other22222222222222222222222222222222222222', RAY = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
const ev = (wallet, mint, side, ts, tokens, sol) => ({ wallet, mint, side, ts, token_delta: side === 'BUY' ? tokens : -tokens, sol_delta: sol });
const MIN = 60000;

test('round trips are matched FIFO with realized SOL, hold time and entry timing', () => {
  const rows = [
    ev(X, 'm1', 'BUY', 0, 100, -1),                 // first buyer of m1
    ev(W, 'm1', 'BUY', 2 * MIN, 100, -1), ev(W, 'm1', 'BUY', 4 * MIN, 100, -2),
    ev(W, 'm1', 'SELL', 12 * MIN, 150, 3),           // 100 @0.01 + 50 @0.02 = cost 2, proceeds 3
    ev(W, 'm2', 'BUY', 20 * MIN, 10, -1), ev(W, 'm2', 'SELL', 30 * MIN, 10, 0.5),
    ev(W, 'm3', 'BUY', 40 * MIN, 10, -1), ev(W, 'm3', 'SELL', 41 * MIN, 10, 1.2),
  ];
  const r = computeWalletScorecards(rows, { minRoundTrips: 3 });
  const w = r.wallets.find(x => x.wallet === W);
  assert.equal(w.roundTrips, 3); assert.equal(w.wins, 2); assert.equal(w.winRate, 0.667);
  assert.equal(w.realizedSol, 0.7, '+1 - 0.5 + 0.2'); assert.equal(w.graded, true);
  assert.equal(w.medianEntryAfterFirstBuyMin, 0, 'first buyer of m2 and m3, 2 min after on m1');
  assert.ok(w.medianHoldMin > 0); assert.ok(w.score > 50 && w.score < 70, 'three trips barely move the score');
  assert.equal(gradedScores(r).get(W), w.score); assert.equal(gradedScores(r).has(X), false);
});

test('pools and program authorities are excluded; unpriced legs never make a trip', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) { rows.push(ev(`Buyer${i}`.padEnd(44, 'b'), 'm', 'BUY', i * MIN, 10, -0.1)); rows.push(ev('PoolVault'.padEnd(44, 'p'), 'm', 'SELL', i * MIN, 10, 0.1)); }
  rows.push(ev('PoolVault'.padEnd(44, 'p'), 'm', 'BUY', 99 * MIN, 5, -0.05));
  rows.push(ev(RAY, 'm', 'SELL', 100 * MIN, 1, 0.01), ev(RAY, 'm', 'BUY', 101 * MIN, 1, -0.01));
  assert.ok(poolWallets(rows.map(r => ({ ...r }))).has('PoolVault'.padEnd(44, 'p')));
  const r = computeWalletScorecards(rows);
  assert.ok(r.excludedPools >= 1); assert.ok(!r.wallets.some(x => x.wallet === RAY || x.wallet.startsWith('PoolVault')));
  const unpriced = computeWalletScorecards([ev(W, 'z', 'BUY', 0, 10, 0), ev(W, 'z', 'SELL', MIN, 10, 0.5)]);
  assert.equal(unpriced.walletsWithTrips, 0); assert.equal(unpriced.pricedShare, 0.5);
});

test('the snapshot reads the DB read-only, releases the file, and treats a missing DB as empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-scorecard-')), file = path.join(dir, 'alpha-lab.sqlite');
  try {
    __testing.resetCache();
    assert.equal(walletScorecardSnapshot({ file, force: true }).wallets.length, 0);
    assert.equal(fs.existsSync(file), false, 'never creates the DB');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE tx_events(signature TEXT,event_index INT,ts INT,slot INT,mint TEXT,wallet TEXT,side TEXT,token_delta REAL,sol_delta REAL,source TEXT,raw_json TEXT)');
    const ins = db.prepare('INSERT INTO tx_events(ts,mint,wallet,side,token_delta,sol_delta) VALUES(?,?,?,?,?,?)'), now = Date.now();
    for (let i = 0; i < 4; i++) { ins.run(now - 10 * MIN + i, `m${i}`, W, 'BUY', 10, -1); ins.run(now - 5 * MIN + i, `m${i}`, W, 'SELL', -10, 1.5); }
    db.close();
    const snap = walletScorecardSnapshot({ file, force: true, now });
    assert.equal(snap.graded, 1); assert.equal(snap.wallets[0].realizedSol, 2); assert.ok(snap.lastEventAt > 0);
    assert.equal(walletScorecardSnapshot({ file, now: now + 1000 }), snap, 'cached');
    fs.rmSync(file); assert.equal(fs.existsSync(file), false, 'no handle left open');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
