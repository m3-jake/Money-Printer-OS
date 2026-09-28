import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArbitragePoller } from '../src/arbitragePoller.js';
import { arbitrageQuote } from '../src/core/contracts.js';

test('recurring public-book scan creates a funded paper pair and settles both observed outcomes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-arb-poll-'));
  let now = Date.now(), resolved = false, calls = 0;
  const a = { venue: 'kalshi', sourceId: 'K', data: { venue: 'kalshi', title: 'same verified event' } }, b = { venue: 'polymarket', sourceId: 'P', data: { venue: 'polymarket', title: 'same verified event' } };
  const book = price => ({ observedAt: now, yes: { bids: [{ price: price - .01, quantity: 10 }], asks: [{ price, quantity: 10 }] }, no: { bids: [{ price: .99 - price, quantity: 10 }], asks: [{ price: 1.01 - price, quantity: 10 }] } });
  const fee = { rate: 0, rounding: '5DP' };
  const platform = {
    markets: async () => { calls++; return { markets: [] }; },
    arbitrageCandidates: () => ({ pairs: [{ a: { venue: a.venue, sourceId: a.sourceId }, b: { venue: b.venue, sourceId: b.sourceId } }] }),
    compare: async () => ({ a, b, ...arbitrageQuote(a.data, b.data, book(.3), book(.6), { now, match: { classification: 'EXACT MATCH' }, feeModels: { a: fee, b: fee } }) }),
    contract: async venue => ({ data: { settlementOutcome: resolved ? 'YES' : null } })
  };
  const state = { runtime: { profile: 'AGGRESSIVE_PAPER' }, proposals: [] }, poller = createArbitragePoller({ platform, dataDir: dir, now: () => now });
  try {
    assert.equal((await poller.tick({ state, mode: 'live' })).enabled, false); assert.equal(calls, 0);
    const opened = await poller.tick({ state, mode: 'paper' }); assert.equal(opened.filled, 1); assert.equal(opened.ordersSubmitted, 0);
    const account = JSON.parse(fs.readFileSync(poller.file)); assert.equal(account.open.length, 1); assert.ok(account.cashUsd < 1000);
    assert.equal(state.proposals[0].status, 'FILLED'); assert.equal(account.open[0].realVenueAtomicity, false);
    assert.equal((await poller.tick({ state, mode: 'paper' })).cached, true);
    resolved = true; now += 60000; platform.arbitrageCandidates = () => ({ pairs: [] });
    const closed = await poller.tick({ state, mode: 'paper' }); assert.equal(closed.settled, 1);
    const settled = JSON.parse(fs.readFileSync(poller.file)); assert.equal(settled.open.length, 0); assert.equal(settled.history[0].payoutUsd, 1); assert.ok(settled.cashUsd > 1000);
    assert.match(fs.readFileSync(poller.journal, 'utf8'), /arbitrage-paper-settlement/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unverified settlement terms are recorded but cannot create an arbitrage fill', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-arb-block-'));
  const platform = { markets: async () => ({ markets: [] }), arbitrageCandidates: () => ({ pairs: [{ a: { venue: 'kalshi', sourceId: 'K' }, b: { venue: 'polymarket', sourceId: 'P' } }] }),
    compare: async () => ({ a: { data: { title: 'event' } }, classification: 'STRONG MATCH', directions: [{ sideA: 'YES', sideB: 'NO', venueA: { averagePrice: .3 }, venueB: { averagePrice: .4 }, grossSpread: .3, effectiveSpread: .3, capitalRequired: .7, blocked: ['SETTLEMENT_NOT_VERIFIED_EQUIVALENT'] }] }) };
  try {
    const poller = createArbitragePoller({ platform, dataDir: dir }), state = { runtime: { profile: 'AGGRESSIVE_PAPER' }, proposals: [] };
    assert.equal((await poller.tick({ state })).filled, 0); assert.equal(state.proposals.length, 0); assert.match(fs.readFileSync(poller.journal, 'utf8'), /SETTLEMENT_NOT_VERIFIED_EQUIVALENT/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
