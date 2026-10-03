// Trader-owned thresholds and reproducible family-wise bootstrap intervals for forward farm evidence.
export const FARM_MIN_SETTLED=30, FARM_EARLY_STOP_SETTLED=20;
export function bootstrapMeanCI(xs,{alpha=0.05,resamples=2000,seed=7}={}){
 if(xs.length<2||!xs.every(Number.isFinite))return null;
 let state=seed>>>0;
 const rng=()=>{state=(state+0x6D2B79F5)>>>0;let t=state;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296};
 const means=[];
 for(let i=0;i<resamples;i++){let s=0;for(let j=0;j<xs.length;j++)s+=xs[Math.floor(rng()*xs.length)];means.push(s/xs.length)}
 means.sort((a,b)=>a-b);
 return {lo:means[Math.floor(alpha/2*resamples)],hi:means[Math.min(resamples-1,Math.floor((1-alpha/2)*resamples))]};
}
export function farmEarlyStop(history,trials=1){
 const pnls=(history||[]).filter(r=>!r.observed&&Number.isFinite(r.pnlUsd)).map(r=>r.pnlUsd);
 const ci=pnls.length>=FARM_EARLY_STOP_SETTLED?bootstrapMeanCI(pnls,{alpha:0.05/Math.max(1,trials)}):null;
 return {retire:ci?.hi<0,n:pnls.length,ciLo:ci?.lo??null,ciHi:ci?.hi??null,baseline:'cash',trials};
}
