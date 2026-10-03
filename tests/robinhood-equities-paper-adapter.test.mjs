import test from 'node:test';
import assert from 'node:assert/strict';
import { paperEquityOrder } from '../tools/robinhoodEquitiesPaper.js';

test('Robinhood equities paper adapter refuses non-paper mode', () => {
  assert.throws(() => paperEquityOrder({ symbol: 'SPY', side: 'BUY', quantity: 1, price: 500, mode: 'live' }), /refuses non-paper/);
});

test('adapter accepts stock and ETF symbols and uses aggressive execution only for the paper profile', () => {
  const regular = paperEquityOrder({ symbol: 'SPY', side: 'BUY', quantity: 1, price: 500, mode: 'paper' });
  const aggressive = paperEquityOrder({ symbol: 'QQQ', side: 'BUY', quantity: 1, price: 500, mode: 'paper', runtime: { profile: 'AGGRESSIVE_PAPER' } });
  assert.equal(regular.mode, 'PAPER'); assert.equal(regular.executionModel, 'ROBINHOOD_PAPER');
  assert.equal(aggressive.executionModel, 'AGGRESSIVE_PAPER'); assert.throws(() => paperEquityOrder({ symbol: 'BTC-USD', side: 'BUY', quantity: 1, price: 500 }), /ticker/);
});
