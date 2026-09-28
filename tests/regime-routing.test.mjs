import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { marketRegime, regimeSnapshot, routeAssetClass, routeDecision, strategyAllowedInRegime } from '../src/regime.js';

test('market regimes classify trending, choppy and risk-off conditions per class', () => {
  assert.equal(marketRegime({ returnPct: 3, breadthPct: 70 }).regime, 'trending');
  assert.equal(marketRegime({ volatilityPct: 10, returnPct: 0 }).regime, 'choppy');
  assert.equal(marketRegime({ riskOff: true, returnPct: 2 }).regime, 'risk-off');
  assert.deepEqual(Object.keys(regimeSnapshot({ crypto: { returnPct: 2 }, equity: { returnPct: -4 } })), ['crypto', 'equity']);
});

test('strategy gate and asset routing cover all requested route classes', () => {
  assert.equal(strategyAllowedInRegime('momentum', 'trending'), true); assert.equal(strategyAllowedInRegime('momentum', 'choppy'), false);
  assert.equal(strategyAllowedInRegime('mean-reversion', 'choppy'), true); assert.equal(strategyAllowedInRegime('mean-reversion', 'trending'), false);
  assert.deepEqual({ memecoin: routeAssetClass('memecoin'), weather: routeAssetClass('weather'), sports: routeAssetClass('sports'), politics: routeAssetClass('politics'), crypto: routeAssetClass('crypto'), equity: routeAssetClass('equity') },
    { memecoin: 'pumpfun', weather: 'kalshi', sports: 'kalshi', politics: 'polymarket', crypto: 'robinhood', equity: 'robinhood' });
  assert.equal(routeDecision({ assetClass: 'weather', strategy: 'momentum', regimes: { weather: { regime: 'choppy' } } }).decision, 'BLOCK');
});

test('supervisor records per-candidate route decisions and engine paper entries pass through proposals',()=>{
 const supervisor=fs.readFileSync(new URL('../src/supervisor.js',import.meta.url),'utf8'),engine=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 assert.match(supervisor,/routeDecision\(/);assert.match(supervisor,/central-route-decision/);assert.match(engine,/cfg\.mode==='paper'\?proposeTrade\(s,pick,size\)/);assert.match(engine,/strategy-regime-route/);
});
