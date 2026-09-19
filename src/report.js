import { loadState, readJournal } from './store.js';
import { evolutionSnapshot } from './research.js';
import { edgeProofSnapshot } from './edgeProof.js';
import { alphaInsightsSnapshot } from './alphaInsights.js';

const s=loadState(),history=s.history||[],wins=history.filter(x=>(x.pnlSol||0)>=0),losses=history.filter(x=>(x.pnlSol||0)<0),pnl=history.reduce((q,x)=>q+(x.pnlSol||0),0),avg=a=>a.length?a.reduce((q,x)=>q+x,0)/a.length:0;
let peak=0,equity=0,maxDd=0;for(const x of history){equity+=x.pnlSol||0;peak=Math.max(peak,equity);maxDd=Math.min(maxDd,equity-peak)}
const e=evolutionSnapshot(s),p=edgeProofSnapshot(),ins=alphaInsightsSnapshot();
console.log(`\nMONEY PRINTER ENGINE 12.6 — DATA QUALITY BRIEF\nClosed trades: ${history.length}\nWin rate: ${history.length?(wins.length/history.length*100).toFixed(1):0}%\nRealized P&L: ${pnl.toFixed(4)} SOL\nAvg winner: ${avg(wins.map(x=>x.pnlSol||0)).toFixed(4)} SOL\nAvg loser: ${avg(losses.map(x=>x.pnlSol||0)).toFixed(4)} SOL\nMax local drawdown: ${maxDd.toFixed(4)} SOL\nMarket regime: ${s.market?.regime||'UNKNOWN'} ${s.market?.score||0}/100\nSystem health: ${s.system?.health||'UNKNOWN'}\nEDGE VERDICT: ${p.status} (${p.proofScore}%)\nIndependent 30m launches: ${p.independentMints}\nProduction learning: ${p.productionLearningUnlocked?'UNLOCKED':'LOCKED'}\nNext move: ${p.nextAction}\n`);
for(const h of [5,30,120]){const x=p.horizons?.[h];if(x)console.log(`${h===120?'2H':h+'M'} proof: n=${x.holdout}, delta=${x.deltaPct.toFixed(2)}%, CI=${x.ciLow==null?'—':x.ciLow.toFixed(2)}..${x.ciHigh==null?'—':x.ciHigh.toFixed(2)}, positive regimes=${x.positiveRegimes}`)}
console.log('\nStrongest validated Alpha:');console.table((p.bestAlpha||[]).slice(0,8));
console.log('\nAlpha leaderboard:');console.table((ins.leaderboard||[]).slice(0,8));
console.log('Delayed-entry study:');console.table(ins.delayedEntry?.rows||[]);
console.log(`Execution calibration: ${ins.calibration?.status||'UNCALIBRATED'} (n=${ins.calibration?.samples||0})`);
console.log('Strategy tournament:');console.table(e.tournament.slice(0,10));
console.log('Newest lessons:');for(const x of e.lessons.slice(0,6))console.log(`- ${x.text} (conf ${Math.round(x.confidence)}%, n=${x.samples})`);
console.log(`Recent saved market snapshots: ${readJournal(5000).filter(x=>['scan','scan-candidate'].includes(x.type)).length}`);
