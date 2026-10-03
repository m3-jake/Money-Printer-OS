import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChallenger, atrChallengerSignal, equityChallengerTargets } from '../src/strategyChallengers.js';
import { dailySignal, validateDailyParams, warmupDays, pickDailyStrategy } from '../src/robinhoodDailyBook.js';
import { targetWeights, normalizeParams, DEFAULT_STRATEGY } from '../src/robinhoodEquitiesStrategy.js';
const rows = n => Array.from({ length:n }, (_,i) => {
  const c = 100 + i * .12 + Math.sin(i/5)*2;
  return { d: new Date(Date.UTC(2025,0,1)+i*86400e3).toISOString().slice(0,10), t: Date.UTC(2025,0,1)+i*86400e3, o:c-.1,h:c+.5,l:c-.5,c };
});
const atr = { entryDays:20,exitDays:10,atrDays:14,atrMultiple:.5 };

test('ATR adapter is bounded, uses only visible bars and cannot replace the incumbent daily policy', () => {
  assert.equal(validateDailyParams('atr-breakout',atr).ok,true);
  assert.equal(warmupDays('atr-breakout',atr),21);
  assert.equal(validateChallenger('atr-breakout',{...atr,atrMultiple:2}).ok,false);
  assert.equal(validateChallenger('atr-breakout',{...atr,exitDays:20}).ok,false);
  const bars=rows(60);bars[50]={...bars[50],c:150,h:151};
  assert.equal(dailySignal('atr-breakout',atr,bars,50,false),true);
  const before=atrChallengerSignal(atr,bars,40,false);
  for(let i=41;i<bars.length;i++)bars[i]={...bars[i],c:10000,h:10001};
  assert.equal(atrChallengerSignal(atr,bars,40,false),before);
  const picked=pickDailyStrategy({paperPromotionAllowed:true,proposal:{id:'fixture',family:'atr-breakout',params:atr,qualificationStage:'PAPER',paperPromotionAllowed:true}});
  assert.equal(picked.kind,'lab-default');assert.match(picked.reasons.join(';'),/separate frozen exploratory cohort/);
});

test('equity adapters match shared research targets at every close and future bars never alter a past decision', () => {
  const bars=rows(260);
  for(const [family,params] of [['lagged-volatility-scaled-trend',{lookback:20,targetVol:.15}],['long-only-mean-reversion',{lookback:20,entryDiscount:.02,maxHold:10}]]){
    const targets=equityChallengerTargets(bars,{family,params});
    assert.equal(targets[199],null);
    for(let i=200;i<bars.length;i++){
      const result=targetWeights(family,params,{SPY:bars},bars[i].d);
      assert.deepEqual(result.weights,targets[i]);assert.equal(result.ready,true);
      assert.ok(Object.values(result.weights).reduce((a,b)=>a+b,0)<=1);
      assert.equal(result.detail.qualificationEffect,'NONE');
    }
    const before=targetWeights(family,params,{SPY:bars},bars[220].d);
    const changed=bars.map((b,i)=>i>220?{...b,c:b.c*5,h:b.h*5,o:b.o*5,l:b.l*5}:b);
    assert.deepEqual(targetWeights(family,params,{SPY:changed},bars[220].d),before);
    assert.throws(()=>normalizeParams(family,{...params,lookback:300}),/outside declared bounds/);
  }
  assert.equal(DEFAULT_STRATEGY,'tactical-a');
});
