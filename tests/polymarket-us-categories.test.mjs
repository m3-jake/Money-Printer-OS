import test from 'node:test';
import assert from 'node:assert/strict';
import { filterUSMarketsByCategory, US_CATEGORIES } from '../src/polymarketUS.js';

test('Polymarket US paper category filter recognizes weather, sports, culture and politics', () => {
  assert.deepEqual(US_CATEGORIES, ['weather', 'sports', 'culture', 'politics']);
  const rows = [{ category: 'weather' }, { sport: 'sports' }, { eventCategory: 'culture' }, { category: 'politics' }, { category: 'finance' }];
  assert.deepEqual(filterUSMarketsByCategory(rows).length, 4);
  assert.deepEqual(filterUSMarketsByCategory(rows, ['sports']).map(x => x.sport), ['sports']);
});
