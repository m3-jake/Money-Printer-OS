// Fresh audit probes. No network, production credentials, accounts, or running services.
// Run from either directory: node docs/audit-2026-10-03/trader-engine-probes.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertLiveDispatchAllowed } from '../../src/core/executionBoundary.js';
import { assessPortfolioRisk } from '../../src/portfolioRisk.js';
import { scoreWallets } from '../../src/walletScorecard.js';
import { Keypair } from '@solana/web3.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-engine-audit-'));
process.env.MONEY_PRINTER_DATA_DIR = scratch;
const results = {};
try {
  const empty = path.join(scratch, 'no-ledger');
  let dispatch;
  try { assertLiveDispatchAllowed({ dataDir: empty }); dispatch = 'ALLOWED_WITH_NO_LEDGER'; }
  catch (e) { dispatch = e.code; }
  assert.equal(dispatch, 'ALLOWED_WITH_NO_LEDGER');
  results.standaloneLiveBoundary = { dispatch, submitted: false, networkCalls: 0 };

  const holdings = Array.from({ length: 4 }, (_, i) => ({ symbol: 'SOL', mint: `mint${i}`, narrativeTag: 'SAME', remainingSol: 2 }));
  const correlations = Object.fromEntries(holdings.flatMap(p => holdings.map(q => [`${p.mint}|${q.mint}`, 1])));
  const risk = assessPortfolioRisk({ positions: holdings, runtime: { profile: 'AGGRESSIVE_PAPER' }, portfolio: { equitySol: 10 }, paperStartSol: 10 },
    { symbol: 'NEW', narrativeTag: 'OTHER' }, { maxNarrativeExposureSol: 100, maxEffectiveExposureSol: 5, correlations });
  assert.equal(risk.averageCorrelation, 0); assert.equal(risk.effectiveExposureSol, 2); assert.equal(risk.allowed, true);
  results.perfectCorrelation = { totalExposureSol: risk.totalExposureSol, effectiveExposureSol: risk.effectiveExposureSol, averageCorrelation: risk.averageCorrelation, allowed: risk.allowed, capSol: 5 };

  const wallet = Keypair.generate().publicKey.toBase58(); // Disposable public identity, never printed or used on network.
  const lateRows = [
    { ts: 1000, mint: 'X', wallet, side: 'BUY', tokenDelta: 1, solDelta: -1, signer: true, firstObservedAt: 9000 },
    { ts: 2000, mint: 'X', wallet, side: 'SELL', tokenDelta: -1, solDelta: 2, signer: true, firstObservedAt: 9000 },
  ];
  const score = scoreWallets(lateRows, { asOf: 5000, minTrips: 1 });
  assert.equal(score.wallets[0].roundTrips, 1); assert.equal(score.wallets[0].realizedPnlSol, 1);
  results.arrivalTime = { asOf: 5000, firstObservedAt: 9000, countedRoundTrips: score.wallets[0].roundTrips, countedPnlSol: score.wallets[0].realizedPnlSol };

  const { creditLedger } = await import('../../src/transactionIndexer.js');
  const file = path.join(scratch, 'budget.json');
  const ledger = creditLedger({ file, env: { INDEXER_DAILY_CREDITS: '5' }, now: () => Date.parse('2026-10-03T23:00:00Z') });
  const first = ledger.charge(5); fs.writeFileSync(file, '{broken-json');
  const second = ledger.charge(5);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  results.corruptSpendLedger = { dailyCap: 5, permittedCredits: 10, retainedCredits: ledger.health().credits, first, second };
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
} finally {
  const resolved = path.resolve(scratch), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(temporaryRoot) || !path.basename(resolved).startsWith('mpo-engine-audit-')) throw new Error('Unexpected scratch cleanup target');
  fs.rmSync(resolved, { recursive: true, force: true });
}
