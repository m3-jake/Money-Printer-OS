import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { copyWalletSignals, rankCopyWallets } from '../src/walletTracker.js';
import { copyTradeSignals } from '../src/copyTrade.js';

const wallet = () => Keypair.generate().publicKey.toBase58();

test('only tracked signer Pump.fun buys become source-tagged copy signals', () => {
  const w = wallet(), other = wallet();
  const rows = [
    { wallet: w, mint: 'M1', side: 'BUY', signer: true, raw: { program: 'pump' }, ts: 4 },
    { wallet: w, mint: 'M2', side: 'SELL', signer: true, raw: { program: 'pump' } },
    { wallet: w, mint: 'M3', side: 'BUY', signer: false, raw: { program: 'pump' } },
    { wallet: other, mint: 'M4', side: 'BUY', signer: true, raw: { program: 'pump' } },
    { wallet: w, mint: 'M5', side: 'BUY', signer: true, raw: { program: 'jupiter' } },
  ];
  assert.deepEqual(copyWalletSignals(rows, { wallets: [w] }), [{ ts: 4, mint: 'M1', wallet: w, source: `copy:${w}`, side: 'BUY', score: 0, signature: null, solDelta: 0 }]);
});

test('copy-trading layer refuses non-paper mode and journals allowed signals', () => {
  const w = wallet(), event = { wallet: w, mint: 'M', side: 'BUY', signer: true, raw: { program: 'pump' } }, logged = [];
  assert.deepEqual(copyTradeSignals([event], { mode: 'live', wallets: [w], log: x => logged.push(x) }), []);
  const signals = copyTradeSignals([event], { mode: 'paper', wallets: [w], log: x => logged.push(x) });
  assert.equal(signals[0].source, `copy:${w}`); assert.equal(logged.length, 1); assert.equal(logged[0].type, 'copy-trade-signal');
});

test('trailing scorecard window qualifies and automatically demotes losing wallets', () => {
  const now = Date.now(), cutoff = now - 30 * 86_400_000;
  const ranked = rankCopyWallets([
    { wallet: 'winner', lastTs: now, roundTrips: 4, realizedPnlSol: 0.5 },
    { wallet: 'loser', lastTs: now, roundTrips: 3, realizedPnlSol: -0.2 },
    { wallet: 'stale', lastTs: cutoff - 1, roundTrips: 20, realizedPnlSol: 10 },
  ], { asOf: now, minTrips: 3, demoteBelowSol: 0 });
  assert.equal(ranked.find(x => x.wallet === 'winner').eligible, true);
  assert.equal(ranked.find(x => x.wallet === 'loser').autoDemoted, true);
  assert.equal(ranked.find(x => x.wallet === 'stale').qualified, false);
});
