import {bootstrapMeanCI} from './farmEvidence.js';
const finite=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
// A prediction must be captured when the candidate starts forward paper, never backfilled from today's winner.
export function forwardScorecard(prediction=null,history=[]){
 const pnls=history.filter(r=>!r.observed&&Number.isFinite(r.pnlUsd)).map(r=>r.pnlUsd),n=pnls.length;
 const mean=n?pnls.reduce((s,x)=>s+x,0)/n:null,ci=n>=2?bootstrapMeanCI(pnls):null;
 const predicted={n:Number.isInteger(prediction?.n)&&prediction.n>=0?prediction.n:null,meanPerBet:finite(prediction?.meanPerBet),
  ciLo:finite(prediction?.ciLo),ciHi:finite(prediction?.ciHi),ciUnit:prediction?.ciUnit||'unknown',unit:prediction?.unit||'USD',capturedAt:prediction?.capturedAt??null};
 return {predicted,forward:{n,meanPerBet:mean,ciLo:ci?.lo??null,ciHi:ci?.hi??null,ciUnit:'USD per bet (unclustered diagnostic)',unit:'USD'},
  shrinkage:predicted.unit==='USD'&&predicted.meanPerBet!==null&&predicted.meanPerBet!==0&&mean!==null?mean/predicted.meanPerBet:null,
  qualificationEffect:'NONE',note:'Realized / predicted after-cost return per bet. Missing admission-time predictions stay unknown; CIs retain their original units. Forward CI is descriptive, not a promotion gate.'};
}
