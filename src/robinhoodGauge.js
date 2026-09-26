// "Why not trading" gauge per symbol and book (docs/ROBINHOOD-AUTO-TRADER.md §23). Pure.
// Turns computeFeatures + entrySignal into the numbers the HUD draws as bars.
const fin=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
export const BLOCK_TEXT={warmup:'warming up',stale:'quote stale',gaps:'tape has gaps',invalid:'tape invalid',spread:'spread above cap',lowVol:'expected move below required move',noBreakout:'no Donchian breakout',noTrend:'EMA trend not up',holding:'already holding',cooldown:'cooling down',autopilotOff:'autopilot off'};
export function gauge({features={},signal={},params={},holding=false,cooldownUntil=null,autopilotEnabled=true,now=Date.now()}={}){
 const f=features||{},need=Math.max(Number(params.warmupSamples)||0,Number(params.minSamples)||0),n=Number(f.n)||0;
 const level=fin(f.donchianHigh)!==null?f.donchianHigh*(1+(Number(params.breakoutBufferPct)||0)):null;
 const expected=fin(f.expectedMovePct),required=fin(signal.requiredMovePct);
 const trendOk=f.ok?!!(f.emaFast>f.emaSlow&&f.emaSlow>f.emaSlowPrev):null;
 const cooling=Number.isFinite(cooldownUntil)&&cooldownUntil>now;
 let blocking=null;
 if(holding)blocking='holding';
 else if(!signal.enter)blocking=signal.reason||f.reason||'warmup';
 else if(cooling)blocking='cooldown';
 else if(!autopilotEnabled)blocking='autopilotOff';
 return {
  warmup:{n,need,pct:need?Math.min(1,n/need):1},
  spread:{bps:fin(f.spreadBps),capBps:Number(params.maxSpreadBps)||null,ok:fin(f.spreadBps)===null?null:f.spreadBps<=params.maxSpreadBps},
  move:{expectedPct:expected,requiredPct:required,ratio:expected!==null&&required>0?expected/required:null,ok:expected!==null&&required!==null?expected>=required:null},
  breakout:{mid:fin(f.mid),level,distancePct:level&&fin(f.mid)!==null?f.mid/level-1:null,ok:level&&fin(f.mid)!==null?f.mid>level:null},
  trend:{ok:trendOk,emaFast:fin(f.emaFast),emaSlow:fin(f.emaSlow),slopeUp:f.ok?f.emaSlow>f.emaSlowPrev:null},
  cooldownUntil:cooling?cooldownUntil:null,
  blocking,blockingText:blocking?BLOCK_TEXT[blocking]||blocking:'ready: breakout signal',ready:blocking===null,
 };
}
