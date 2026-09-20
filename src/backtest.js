import { readJournal } from './store.js';
import { estimateRoundTripFrictionPct } from './executionSim.js';

const rows=readJournal(250_000).filter(x=>['scan','scan-candidate'].includes(x.type)&&x.a?.priceUsd&&x.a?.mint),byMint=new Map();for(const row of rows){if(!byMint.has(row.a.mint))byMint.set(row.a.mint,[]);byMint.get(row.a.mint).push(row)}
const horizons=[1,5,10,30,60],results=Object.fromEntries(horizons.map(h=>[h,[]])),cohorts={'EDGE 90+':[],'EDGE 80-89':[],'EDGE 70-79':[],'EDGE <70':[]};
for(const xs of byMint.values()){
 xs.sort((a,b)=>a.ts-b.ts);const entry=xs.find(x=>x.a.eligible);if(!entry)continue;const edge=Number(entry.a.fastEdgeScore??entry.a.edgeScore??entry.a.score??0),cohort=edge>=90?'EDGE 90+':edge>=80?'EDGE 80-89':edge>=70?'EDGE 70-79':'EDGE <70';
 for(const h of horizons){const future=xs.find(x=>x.ts-entry.ts>=h*60_000);if(!future)continue;const raw=(future.a.priceUsd/entry.a.priceUsd-1)*100,friction=estimateRoundTripFrictionPct({liquidity:Number(entry.a.liq||0),executionScore:Number(entry.a.executionScore||50),rawReturnPct:raw,feeBps:25}),adjusted=raw-friction;results[h].push(adjusted);if(h===30)cohorts[cohort].push(adjusted)}
}
function stats(values){if(!values.length)return{n:0,win:0,avg:0,med:0,best:0,worst:0};const sorted=[...values].sort((a,b)=>a-b);return{n:values.length,win:values.filter(x=>x>0).length/values.length*100,avg:values.reduce((q,x)=>q+x,0)/values.length,med:sorted[Math.floor(sorted.length/2)],best:sorted.at(-1),worst:sorted[0]}}
console.log('\nMONEY PRINTER ENGINE 12.6 — EXECUTION-ADJUSTED JOURNAL BACKTEST');for(const h of horizons){const s=stats(results[h]);console.log(`${String(h).padStart(2)}m: ${s.n} independent entries | win ${s.win.toFixed(1)}% | avg ${s.avg.toFixed(2)}% | median ${s.med.toFixed(2)}% | best ${s.best.toFixed(1)}% | worst ${s.worst.toFixed(1)}%`)}
console.log('\n30M FAST EDGE COHORTS:');for(const [name,values] of Object.entries(cohorts)){const s=stats(values);console.log(`${name.padEnd(12)} ${String(s.n).padStart(4)} | win ${s.win.toFixed(1)}% | avg adjusted ${s.avg.toFixed(2)}%`)}
if(!rows.length)console.log('No snapshots yet. Run the scanner to build a dataset.');
