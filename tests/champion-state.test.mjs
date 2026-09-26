import test from 'node:test';
import assert from 'node:assert/strict';
import { championState, championPaperAllowed, ChampionState, CHAMPION_STATE_SCHEMA } from '../src/championState.js';

const doc = extra => ({ paperPromotionAllowed: true, stateSchema: CHAMPION_STATE_SCHEMA, ...extra });

test('missing, unknown or newer-schema states fail closed to SHADOW', () => {
  assert.equal(championState(null).state, ChampionState.INCUBATOR);
  assert.equal(championState({ paperPromotionAllowed: true }).state, ChampionState.SHADOW);
  assert.equal(championState(doc({ state: 'ROCKET' })).state, ChampionState.SHADOW);
  assert.equal(championState(doc({ state: 'PAPER', stateSchema: 'mpo.champion-state.v2' })).state, ChampionState.SHADOW);
  assert.equal(championState(doc({ champion: { state: 'paper' } })).state, ChampionState.PAPER, 'nested and lower-case accepted');
});

test('paper needs PAPER-or-higher AND the existing paper-review gate', () => {
  for (const s of ['INCUBATOR', 'SHADOW']) assert.equal(championPaperAllowed(doc({ state: s })), false, s);
  assert.equal(championPaperAllowed(doc({ state: 'PAPER' })), true);
  assert.equal(championPaperAllowed(doc({ state: 'LIVE' })), true, 'LIVE is treated as PAPER, never real money');
  assert.equal(championPaperAllowed(doc({ state: 'PAPER', paperPromotionAllowed: false })), false);
  assert.equal(championPaperAllowed({ paperPromotionAllowed: true }), false, 'legacy record without state stays SHADOW');
});
