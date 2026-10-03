import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { routePaperProposal } from '../src/paperRouting.js';
import { regimesForTick } from '../src/regime.js';
import { placeKalshiPaperOrder } from '../tools/kalshiPaper.js';
import { resetPaperSingles, placePaperSingle } from '../src/polymarketUSSinglesPaper.js';

test('all requested asset classes share proposals and decisions with actual IDs, without implicit FX', () => {
  const state = { proposals: [], runtime: { profile: 'AGGRESSIVE_PAPER' } }, rows = [];
  const mapping = { memecoin: 'pumpfun', weather: 'kalshi', sports: 'kalshi', politics: 'polymarket', culture: 'polymarket', crypto: 'robinhood', equity: 'robinhood', etf: 'robinhood' };
  for (const [assetClass, platform] of Object.entries(mapping)) {
    const { proposal, decision } = routePaperProposal({ state, pick: { instrumentKey: `${assetClass}:instrument` }, assetClass, stakeUsd: 10, logger: row => rows.push(row) });
    assert.equal(proposal.platform, platform); assert.equal(decision.proposalId, proposal.id); assert.equal(proposal.sizeSol, 0); assert.equal(proposal.stakeUsd, 10);
  }
  assert.equal(new Set(state.proposals.map(x => x.id)).size, 8); assert.equal(rows.length, 8);
  assert.equal(routePaperProposal({ state, mode: 'live', automatic: true }).proposal, null);
});

test('regime snapshots include every class and preserve unknown observations; automatic strategies are gated', () => {
  const regimes = regimesForTick([{ assetClass: 'memecoin', pc5: 5 }, { assetClass: 'memecoin', pc5: 3 }], { weather: { returnPct: -5, volatilityPct: 20 } });
  assert.equal(regimes.memecoin.regime, 'trending'); assert.equal(regimes.weather.regime, 'choppy'); assert.equal(regimes.equity.regime, 'unknown');
  const state = { proposals: [], runtime: { profile: 'AGGRESSIVE_PAPER' }, system: { regimes } };
  const blocked = routePaperProposal({ state, pick: { ticker: 'KXHIGH' }, assetClass: 'weather', strategy: 'momentum', automatic: true, logger: () => {} });
  assert.equal(blocked.proposal, null); assert.equal(blocked.decision.reason, 'strategy-regime-mismatch');
  assert.equal(state.proposals.length, 0);
});

test('Kalshi and Polymarket paper placements persist their central proposal IDs and route records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-routes-'));
  try {
    const kalshi = path.join(dir, 'kalshi.json'), poly = path.join(dir, 'poly.json');
    const k = placeKalshiPaperOrder({ ticker: 'KXNFL-1', side: 'yes', stakeUsd: 10 }, { file: kalshi });
    const kBook = JSON.parse(fs.readFileSync(kalshi)); assert.equal(k.proposalId, kBook.proposals[0].id); assert.equal(kBook.routeDecisions[0].platform, 'kalshi');
    assert.throws(() => placeKalshiPaperOrder({ ticker: 'KXNFL-1', stakeUsd: 10 }, { file: kalshi, mode: 'live' }), /non-paper/);
    resetPaperSingles({ file: poly, startUsd: 100 });
    const input = { market: { slug: 'p1', bid: .4, ask: .5, category: 'politics' }, stakeUsd: 10, file: poly, mode: 'paper' };
    const p = placePaperSingle(input), next = placePaperSingle(input), pBook = JSON.parse(fs.readFileSync(poly));
    assert.notEqual(p.proposalId, next.proposalId); assert.ok(pBook.proposals.some(x => x.id === p.proposalId)); assert.equal(pBook.routeDecisions[0].platform, 'polymarket');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
