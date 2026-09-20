import { computeEdgeProof, writeEdgeProof } from './edgeProof.js';
const p=writeEdgeProof();
console.log(`\nMONEY PRINTER ENGINE 12.6 // EDGE PROVER`);
console.log(`VERDICT: ${p.status} // PROOF ${p.proofScore}% // independent launches ${p.independentMints}`);
console.log(`Production learning: ${p.productionLearningUnlocked?'UNLOCKED':'LOCKED'}`);
for(const h of [5,30,120]){const x=p.horizons[h];if(!x)continue;console.log(`${h===120?'2H':h+'M'}: holdout ${x.holdout}, top ${x.topAvgAdjustedPct.toFixed(2)}%, rest ${x.restAvgAdjustedPct.toFixed(2)}%, delta ${x.deltaPct.toFixed(2)}%, CI ${x.ciLow==null?'—':x.ciLow.toFixed(2)}..${x.ciHigh==null?'—':x.ciHigh.toFixed(2)}, regimes ${x.positiveRegimes}`)}
console.log(`NEXT: ${p.nextAction}`);
if(p.blockers?.length){console.log('BLOCKERS:');for(const b of p.blockers)console.log(`- ${b}`)}
