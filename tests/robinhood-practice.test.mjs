import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as RP from '../src/robinhoodPractice.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-rh-practice-'));
// Public-feed stand-in: one quote per call, from a mutable price table.
function feed(prices) {
  const calls = [];
  const fetchMarket = async (symbols, { now }) => {
    calls.push(symbols);
    return { source: 'test-public', quotes: symbols.filter(s => prices[s]).map(s => ({ symbol: s, bid: prices[s] * 0.9995, ask: prices[s] * 1.0005, at: now })) };
  };
  return { fetchMarket, calls };
}

test('settings are clamped and the snapshot never claims authority', () => {
  const s = RP.normalizePracticeSettings({ budgetUsd: 1, feeBps: 99999, symbols: 'junk,,eth-usd', stopPct: 5, autopilot: 'yes' });
  assert.equal(s.budgetUsd, 1); assert.equal(s.feeBps, 2500); assert.deepEqual(s.symbols, ['ETH-USD']); assert.equal(s.stopPct, 0.95); assert.equal(s.autopilot, false);
  const dir = tmp();
  try {
    const snap = RP.practiceSnapshot({ dataDir: dir });
    assert.equal(snap.isolated, true); assert.equal(snap.realAuthority, false); assert.equal(snap.countsTowardQualification, false); assert.equal(snap.countsTowardLabPromotion, false);
    assert.deepEqual(snap.safety, { paperOnly: true, signedCalls: false, realJournal: false, qualification: false, promotion: false, maxQuoteAgeMs: 30000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('manual order and close pay spread, slippage and fees, and write only the practice file', async () => {
  const dir = tmp(), prices = { 'BTC-USD': 100000 }, { fetchMarket } = feed(prices);
  try {
    const now = Date.UTC(2026, 8, 26, 12);
    const pos = await RP.placePracticeOrder({ dataDir: dir, symbol: 'btc-usd', now, fetchMarket });
    assert.equal(pos.symbol, 'BTC-USD'); assert.equal(pos.placedBy, 'manual'); assert.ok(pos.costUsd > 25 && pos.costUsd < 25.3, 'orderUsd is notional; the 95 bps fee is on top');
    await assert.rejects(RP.placePracticeOrder({ dataDir: dir, symbol: 'BTC-USD', now: now + 1000, fetchMarket }), /already open/);
    const closed = await RP.closePracticeOrder({ dataDir: dir, id: pos.id, now: now + 2000, fetchMarket });
    assert.equal(closed.status, 'CLOSED'); assert.ok(closed.pnlUsd < 0, 'a flat round trip loses the costs');
    const snap = RP.practiceSnapshot({ dataDir: dir, now: now + 3000 });
    assert.equal(snap.positions.length, 0); assert.equal(snap.history.length, 1); assert.equal(snap.realizedPnlUsd, closed.pnlUsd);
    assert.equal(snap.cashUsd, Math.round((500 + closed.pnlUsd) * 100) / 100);
    assert.deepEqual(fs.readdirSync(dir).filter(f => !f.endsWith('.tmp')), ['robinhood-paper-practice.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('momentum autopilot warms up, ignores a flat tape and enters on a real move', async () => {
  const dir = tmp(), prices = { 'BTC-USD': 100000, 'ETH-USD': 4000 }, { fetchMarket } = feed(prices);
  try {
    RP.configurePractice({ dataDir: dir, patch: { autopilot: true, strategyMode: 'MOMENTUM', entryMovePct: 0.002 } });
    const t0 = Date.UTC(2026, 8, 26, 12);
    let snap = await RP.runPracticeCycle({ dataDir: dir, now: t0, fetchMarket });
    assert.equal(snap.positions.length, 0, 'first tick is warmup');
    snap = await RP.runPracticeCycle({ dataDir: dir, now: t0 + 15000, fetchMarket });
    assert.equal(snap.positions.length, 0, 'flat prices do not trigger momentum');
    prices['BTC-USD'] = 100500;
    snap = await RP.runPracticeCycle({ dataDir: dir, now: t0 + 30000, fetchMarket });
    assert.deepEqual(snap.positions.map(p => p.symbol), ['BTC-USD']); assert.equal(snap.positions[0].placedBy, 'practice-autopilot');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mean reversion does not fire on the spread alone', async () => {
  const dir = tmp(), prices = { 'BTC-USD': 100000 }, { fetchMarket } = feed(prices);
  try {
    RP.configurePractice({ dataDir: dir, patch: { autopilot: true, strategyMode: 'MEAN_REVERSION', entryMovePct: 0.0001, symbols: ['BTC-USD'] } });
    const t0 = Date.UTC(2026, 8, 26, 12);
    for (let i = 0; i < 3; i++) await RP.runPracticeCycle({ dataDir: dir, now: t0 + i * 15000, fetchMarket });
    assert.equal(RP.practiceSnapshot({ dataDir: dir }).positions.length, 0);
    prices['BTC-USD'] = 99000;
    const snap = await RP.runPracticeCycle({ dataDir: dir, now: t0 + 60000, fetchMarket });
    assert.equal(snap.positions.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stale quotes, observe-only mode and a dead feed block fills', async () => {
  const dir = tmp();
  try {
    const now = Date.UTC(2026, 8, 26, 12);
    const stale = async (symbols) => ({ quotes: symbols.map(s => ({ symbol: s, bid: 99, ask: 101, at: now - 120000 })) });
    await assert.rejects(RP.placePracticeOrder({ dataDir: dir, symbol: 'BTC-USD', now, fetchMarket: stale }), /fresh public quote/);
    RP.configurePractice({ dataDir: dir, patch: { mode: 'OBSERVE_ONLY' } });
    await assert.rejects(RP.placePracticeOrder({ dataDir: dir, symbol: 'BTC-USD', now, fetchMarket: feed({ 'BTC-USD': 100 }).fetchMarket }), /OBSERVE_ONLY/);
    const snap = await RP.runPracticeCycle({ dataDir: dir, now, fetchMarket: async () => { throw new Error('offline'); } });
    assert.equal(snap.telemetry.loopStatus, 'BLOCKED'); assert.match(snap.telemetry.blockingReason, /offline/);
    const back = await RP.runPracticeCycle({ dataDir: dir, now: now + 15000, fetchMarket: feed({ 'BTC-USD': 100, 'ETH-USD': 10 }).fetchMarket });
    assert.equal(back.lastError, null, 'a good fetch clears the old error'); assert.doesNotMatch(String(back.telemetry.blockingReason), /offline/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the default public feed path works (the feed takes a clock function, not a timestamp)', async () => {
  const dir = tmp(), realFetch = globalThis.fetch, urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    if (!/api\.exchange\.coinbase\.com\/products\/[A-Z]+-USD\/book\?level=1$/.test(String(url))) throw new Error('unexpected ' + url);
    const body = { bids: [['100000.00', '1']], asks: [['100010.00', '1']], time: new Date(Date.now() - 1000).toISOString() };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const snap = await RP.runPracticeCycle({ dataDir: dir });
    assert.equal(snap.telemetry.loopStatus, 'IDLE'); assert.equal(snap.lastError, null);
    assert.equal(snap.telemetry.lastCycle.freshQuotes, 2); assert.equal(snap.telemetry.lastSource, 'coinbase-public-paper');
    assert.equal(urls.length, 2, 'one book request per symbol, no pair metadata');
  } finally { globalThis.fetch = realFetch; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt ledger is never overwritten; reset keeps a backup', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(RP.practiceFile(dir), '{"schema":"wrong"}');
    const book = RP.loadPracticeBook(dir);
    assert.equal(book.recoveryRequired, true); assert.equal(RP.savePracticeBook(dir, book), false);
    assert.throws(() => RP.configurePractice({ dataDir: dir, patch: { autopilot: true } }), /recovery/);
    const snap = await RP.runPracticeCycle({ dataDir: dir, fetchMarket: feed({ 'BTC-USD': 100 }).fetchMarket });
    assert.equal(snap.recoveryRequired, true); assert.equal(fs.readFileSync(RP.practiceFile(dir), 'utf8'), '{"schema":"wrong"}');
    const fresh = RP.resetPractice({ dataDir: dir, budgetUsd: 200 });
    assert.equal(fresh.cashUsd, 200); assert.equal(fresh.settings.autopilot, false);
    assert.equal(fs.readdirSync(dir).filter(f => f.includes('.corrupt-')).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real-time practice uses receipt-time freshness instead of rejecting quotes fetched after cycle start',async()=>{
  const dir=tmp();
  const fetchMarket=async symbols=>{await new Promise(r=>setTimeout(r,20));return {source:'test-public',quotes:symbols.map(symbol=>({symbol,bid:100,ask:101,at:Date.now()}))};};
  try{
    const cycle=await RP.runPracticeCycle({dataDir:dir,fetchMarket});assert.equal(cycle.telemetry.lastCycle.freshQuotes,2);
    const position=await RP.placePracticeOrder({dataDir:dir,symbol:'BTC-USD',fetchMarket});assert.equal(position.status,'OPEN');
    const closed=await RP.closePracticeOrder({dataDir:dir,id:position.id,fetchMarket});assert.equal(closed.status,'CLOSED');
    await assert.rejects(RP.placePracticeOrder({dataDir:dir,symbol:'BTC-USD',fetchMarket:async()=>({quotes:[{symbol:'BTC-USD',bid:100,ask:101,at:null}]})}),/fresh public quote/);
  }finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});
