import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { PUMP_SDK, PUMP_PROGRAM_ID, pumpIdl } from '@pump-fun/pump-sdk';
import { parsePumpfunLaunch } from '../src/pumpfun.js';
import { buildNativePaperPlan, createNativePaperAdapter } from '../src/pumpfunNativePaper.js';
import { createPumpfunPaperLane } from '../src/pumpfunPaper.js';

const mint = 'So11111111111111111111111111111111111111112', user = PublicKey.default.toBase58(), runtime = { profile: 'AGGRESSIVE_PAPER', paperOverrides: { tradeSizeSol: 1, maxPositionSol: 3, maxTotalExposureSol: 10 } };
const bn = x => new BN(String(x));
const snapshot = () => ({ global: { feeBasisPoints: bn(100), creatorFeeBasisPoints: bn(0) }, feeConfig: null,
  bondingCurve: { virtualTokenReserves: bn('1073000000000000'), virtualQuoteReserves: bn('30000000000'), realTokenReserves: bn('793100000000000'), realQuoteReserves: bn('10000000000'), tokenTotalSupply: bn('1000000000000000'), complete: false, creator: PublicKey.default, quoteMint: PublicKey.default, creatorFeeBps: bn(0), isMayhemMode: false, isCashbackCoin: false }, observedAt: Date.now() });

test('binary Anchor CreateEvent decodes a launch before an indexed market is available', () => {
  const str = x => { const b = Buffer.from(x), n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
  const integer = x => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(x)); return b; };
  const pk = x => new PublicKey(x).toBuffer();
  const data = Buffer.concat([Buffer.from(pumpIdl.events.find(e => e.name === 'CreateEvent').discriminator), str('New coin'), str('NEW'), str('https://example.com/meta'), pk(mint), pk(user), pk(user), pk(user), integer(100), ...[1,2,3,4].map(integer), pk(user), Buffer.from([0,0]), pk(user), integer(2), integer(0), Buffer.from([0])]);
  const event = parsePumpfunLaunch([`Program data: ${data.toString('base64')}`]);
  assert.equal(event.mint, mint); assert.equal(event.symbol, 'NEW'); assert.equal(event.binaryEvent, true);
  assert.equal(parsePumpfunLaunch(['Program data: Zm9v']), null);
});

test('official SDK generates unsigned create/buy/sell instruction plans with priority and bundle costs', async () => {
  const sdk = { createV2Instruction: args => PUMP_SDK.createV2Instruction(args),
    buyV2Instructions: async args => [await PUMP_SDK.getBuyV2InstructionRaw({ ...args, creator: PublicKey.default, feeRecipient: PublicKey.default, buybackFeeRecipient: PublicKey.default })],
    sellV2Instructions: async args => [await PUMP_SDK.getSellV2InstructionRaw({ ...args, creator: PublicKey.default, feeRecipient: PublicKey.default, buybackFeeRecipient: PublicKey.default })] };
  for (const action of ['CREATE','BUY','SELL']) {
    const plan = await buildNativePaperPlan({ action, mint, user, runtime, snapshot: snapshot(), sizeSol: .01, rawAmount: '1000000', metadata: { name: 'Paper', symbol: 'PAPER', uri: 'https://example.com/meta' }, sdk, tipAccount: user });
    assert.ok(plan.instructions.some(ix => ix.programId === PUMP_PROGRAM_ID.toBase58())); assert.equal(plan.unsigned, true); assert.equal(plan.orderSubmitted, false); assert.equal(plan.jito.submitted, false); assert.equal(plan.jito.tipLamports, 1000); assert.ok(plan.priorityFeeLamports > 0);
    if (action !== 'CREATE') { assert.ok(Number(plan.quote.rawAmount) > 0); assert.ok(plan.quote.solAmount > 0); }
  }
  await assert.rejects(buildNativePaperPlan({ action: 'BUY', mint, user, runtime, mode: 'live' }), /AGGRESSIVE_PAPER/);
});

test('native transport and Jupiter fallback use account/quote reads and never submit an order', async () => {
  const methods = [], online = { fetchGlobal: async () => { throw new Error('curve unavailable'); } };
  const fetchImpl = async (url, init) => {
    if (String(url).includes('jito')) { const method = JSON.parse(init.body).method; methods.push(method); assert.equal(method, 'getTipAccounts'); return Response.json({ result: [user] }); }
    assert.match(String(url), /\/quote\?/); assert.equal(init.method, undefined); methods.push('quote'); return Response.json({ outAmount: '1000000', routePlan: [] });
  };
  online.fetchFeeConfig = async () => null;
  const adapter = createNativePaperAdapter({ online, fetchImpl });
  assert.equal((await adapter.quote({ mint, user, action: 'BUY', sizeSol: .01, runtime })).source, 'jupiter-quote-fallback');
  assert.deepEqual(methods, ['getTipAccounts', 'quote', 'quote']);
  const count = methods.length; await assert.rejects(adapter.quote({ mint, user, runtime, mode: 'live' }), /AGGRESSIVE_PAPER/); assert.equal(methods.length, count);
});

test('launch-to-fill-to-exit paper lane accounts for cash and stays unreachable in live mode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-native-paper-')); let at = Date.now(), multiplier = 1, calls = 0; const rows = [];
  const adapter = { quote: async ({ action, sizeSol, rawAmount }) => { calls++; const raw = action === 'BUY' ? Math.floor(sizeSol * 1e9) : Number(rawAmount); return { rawAmount: String(raw), solAmount: raw / 1e9 * multiplier, priceSolPerRaw: multiplier / 1e9, observedAt: at, liquiditySol: 30, source: 'pumpfun-native-curve', plan: null }; } };
  const lane = createPumpfunPaperLane({ dataDir: dir, adapter, now: () => at, logger: r => rows.push(r) });
  try {
    assert.equal((await lane.onLaunch({ mint, slot: 1 }, { runtime, mode: 'live', solUsd: 200 })).accepted, false); assert.equal(calls, 0);
    assert.equal((await lane.onLaunch({ mint, slot: 1 }, { runtime, mode: 'paper', solUsd: 200 })).accepted, true);
    assert.equal(lane.view().open.length, 1); assert.ok(lane.view().cashSol >= .02); assert.equal(lane.view().open[0].orderSubmitted, false);
    multiplier = 1.5; at += 20000; assert.equal((await lane.maintain({ runtime: {profile:'FAIR'}, solUsd: 200 })).closed, 1);
    assert.equal(lane.view().open.length, 0); assert.ok(lane.view().cashSol > 1); assert.ok(rows.some(r => r.type === 'trade-close'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
