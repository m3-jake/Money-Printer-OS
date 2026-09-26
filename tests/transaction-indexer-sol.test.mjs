// Copy-trading step 2: every swap event carries the wallet's real SOL amount (native + wrapped SOL),
// and the Helius indexer has a daily call cap so a key can be added without draining the plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-idx-sol-'));
process.env.MONEY_PRINTER_DATA_DIR = dataDir;
process.env.HELIUS_API_KEY = 'test-key';
process.env.HELIUS_REQUESTS_PER_MINUTE = '100';
process.env.HELIUS_DAILY_CALLS = '2';
const savedFetch = globalThis.fetch, WALLET = 'W'.repeat(44), POOL = 'P'.repeat(44), MINT = 'M'.repeat(44);
const WSOL = 'So11111111111111111111111111111111111111112';
let calls = [];
globalThis.fetch = async url => {
  calls.push(String(url));
  if (!String(url).startsWith('https://api.helius.xyz/')) throw Error(`unexpected network call ${url}`);
  return Response.json([{ signature: 'sig1', timestamp: 1790000000, slot: 5, type: 'SWAP',
    tokenTransfers: [{ mint: MINT, toUserAccount: WALLET, fromUserAccount: POOL, tokenAmount: 1000 }],
    accountData: [{ account: WALLET, nativeBalanceChange: -5000, tokenBalanceChanges: [{ mint: WSOL, userAccount: WALLET, rawTokenAmount: { tokenAmount: '-250000000', decimals: 9 } }] },
      { account: POOL, nativeBalanceChange: 0, tokenBalanceChanges: [{ mint: WSOL, userAccount: POOL, rawTokenAmount: { tokenAmount: '250000000', decimals: 9 } }] }] }]);
};
const { indexMintTransactions, transactionIndexerHealth, rpcSolDelta, heliusSolDelta, __testing } = await import('../src/transactionIndexer.js');
test.after(() => { globalThis.fetch = savedFetch; fs.rmSync(dataDir, { recursive: true, force: true }); });

test('public RPC: SOL spent through wrapped SOL is counted, not recorded as 0', () => {
  const tx = { transaction: { message: { accountKeys: [{ pubkey: WALLET }, { pubkey: POOL }] } },
    meta: { preBalances: [2_000_000_000, 0], postBalances: [1_999_995_000, 0],
      preTokenBalances: [{ mint: WSOL, owner: WALLET, uiTokenAmount: { uiAmountString: '0.4' } }],
      postTokenBalances: [{ mint: WSOL, owner: WALLET, uiTokenAmount: { uiAmountString: '0.15' } }] } };
  assert.equal(Math.round(rpcSolDelta(tx, WALLET) * 1e9) / 1e9, -0.250005, 'fee in lamports plus 0.25 WSOL');
  assert.equal(rpcSolDelta(tx, 'nobody'), 0);
});

test('Helius: the SOL amount comes from accountData, with nativeTransfers as a fallback', async () => {
  __testing.resetHeliusDay(); calls = [];
  const events = await indexMintTransactions(MINT, 10);
  const buy = events.find(e => e.side === 'BUY' && e.wallet === WALLET), sell = events.find(e => e.side === 'SELL');
  assert.equal(buy.solDelta, -0.250005); assert.equal(sell.wallet, POOL); assert.equal(sell.solDelta, 0.25);
  assert.equal(heliusSolDelta({ nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: POOL, amount: 3e8 }] }, WALLET), -0.3);
});

test('the daily Helius cap stops calls and falls back to nothing for funding lookups', async () => {
  __testing.resetHeliusDay(); calls = [];
  const { indexWalletFunding } = await import('../src/transactionIndexer.js');
  await indexMintTransactions(MINT, 10); await indexWalletFunding(WALLET);
  assert.equal(calls.length, 2);
  assert.deepEqual(await indexWalletFunding(WALLET), [], 'over the cap');
  assert.equal(calls.length, 2, 'no third Helius request');
  const h = transactionIndexerHealth().helius;
  assert.equal(h.callsToday, 2); assert.equal(h.dailyCap, 2); assert.equal(h.dailySkips, 1);
});
