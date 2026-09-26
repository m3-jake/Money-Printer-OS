import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-usev-'));
process.env.MONEY_PRINTER_DATA_DIR=DIR;
process.env.POLYMARKET_AUTOSTART='false';
process.env.POLYMARKET_US_COMBO_FEE_MODE='standard';
process.env.POLYMARKET_US_COMBO_BBO='false';
const ev=await import('../src/polymarketUSEvidence.js');
const combos=await import('../src/polymarketUSCombos.js');
test.after(()=>{combos.stopUSComboLoops?.();fs.rmSync(DIR,{recursive:true,force:true})});

function market(slug,ask=.9,bid=.89){
 return {slug,question:'Q',sportsMarketType:'soccer_team_full_time_winner',comboEnabled:true,status:'MARKET_STATUS_OPEN',
  bestAskQuote:{value:String(ask)},bestBidQuote:{value:String(bid)},outcomes:'["Yes","No"]',
  marketSides:[{long:true,tradable:true,description:'Yes'},{long:false,tradable:true,description:'No'}]};
}
const soccer=(slug,minute,now)=>({slug,title:slug,live:true,period:`${minute}'`,score:'2-0',tags:[{slug:'soccer'}],markets:[market('m-'+slug)],__fetchedAt:now});
const settings={priceMin:0.8,maxMinutesLeft:15,maxLegs:2};
const res=(obj,status=200)=>({ok:status<300,status,text:async()=>JSON.stringify(obj)});
const resolvedMarket=(slug,longPx)=>({slug,status:'MARKET_STATUS_RESOLVED',marketSides:[{long:true,price:String(longPx)},{long:false,price:String(1-longPx)}]});

test('price buckets',()=>{
 assert.equal(ev.priceBucket(.5),'<0.60');
 assert.equal(ev.priceBucket(.82),'0.80-0.85');
 assert.equal(ev.priceBucket(.99),'0.985+');
});

test('longSettlement trusts only RESOLVED markets priced exactly 0 or 1',()=>{
 assert.equal(ev.longSettlement(resolvedMarket('a',1)),1);
 assert.equal(ev.longSettlement(resolvedMarket('a',0)),0);
 assert.equal(ev.longSettlement({status:'MARKET_STATUS_OPEN',marketSides:[{long:true,price:'1'}]}),null);
 assert.equal(ev.longSettlement({status:'MARKET_STATUS_RESOLVED',marketSides:[{long:true,price:'0.5'}]}),null);
 assert.equal(ev.legWon('SIDE_BUY',1),true);assert.equal(ev.legWon('SIDE_SELL',1),false);assert.equal(ev.legWon('SIDE_SELL',0),true);
});

test('legs tape: every window verdict per leg, deduped until something changes or the heartbeat',()=>{
 const now=Date.now();
 const events=[soccer('near',88,now),soccer('mid',60,now),soccer('early',7,now)];
 const byWindow=ev.scanWindows(events,now,settings);
 const a=ev.legTapeRows(byWindow,now);
 assert.equal(a.rows.length,3);
 const near=a.rows.find(r=>r.eventSlug==='near'),mid=a.rows.find(r=>r.eventSlug==='mid');
 assert.deepEqual([near.windows.NEAR_END.ok,near.windows.LATE.ok,near.windows.ANY_LIVE.ok],[true,true,true]);
 assert.deepEqual([mid.windows.NEAR_END.ok,mid.windows.LATE.ok],[false,true]);
 assert.equal(near.bid,.89);assert.equal(near.ask,.9);assert.ok(near.clock.period);
 const b=ev.legTapeRows(byWindow,now+1000,{legHashes:a.legHashes});
 assert.equal(b.rows.length,0,'unchanged legs are not re-logged');
 const c=ev.legTapeRows(byWindow,now+ev.LEG_HEARTBEAT_MS+1,{legHashes:a.legHashes});
 assert.equal(c.rows.length,3,'heartbeat re-logs');
 const est=ev.comboEstimateRows(byWindow,now,2);
 assert.deepEqual(est.map(r=>r.window).sort(),['ANY_LIVE','LATE']);
 assert.equal(est[0].askProduct,0.81);
});

test('settlement tracker resolves off-board legs into the calibration table; unresolved stays, void is UNKNOWN',async()=>{
 const now=Date.now();
 const st=ev.defaultEvidenceState();
 const events=[soccer('g1',88,now),soccer('g2',89,now),soccer('g3',88,now)];
 ev.trackLegs(st,ev.scanWindows(events,now,settings),now);
 assert.equal(Object.keys(st.tracked).length,9,'3 legs x 3 windows');
 const calls=[];
 const fetchImpl=async url=>{calls.push(String(url));return res({markets:[resolvedMarket('m-g1',1),resolvedMarket('m-g2',0),{slug:'m-g3',status:'MARKET_STATUS_OPEN',marketSides:[{long:true,price:'0.97'}]}]})};
 const r=await ev.resolveTracked(st,{now:now+1,fetchImpl});
 assert.equal(calls.length,1,'one batched lookup');
 for(const g of ["m-g1","m-g2","m-g3"])assert.match(calls[0],new RegExp("slug="+g));
 assert.equal(r.outcomes.filter(o=>o.outcome==='WON').length,3);
 assert.equal(r.outcomes.filter(o=>o.outcome==='LOST').length,3);
 assert.equal(Object.keys(st.tracked).length,3,'g3 still pending');
 const t=ev.calibrationTable(st).find(c=>c.window==='NEAR_END');
 assert.deepEqual([t.bucket,t.sport,t.n,t.wins],['0.90-0.95','soccer',2,1]);
 assert.equal(t.edgeAfterFee,+(0.5-0.9-t.sumFee/2).toFixed(4));
 // void market and give-up become UNKNOWN, never wins
 const r2=await ev.resolveTracked(st,{now:now+2,fetchImpl:async()=>res({markets:[{slug:'m-g3',status:'MARKET_STATUS_RESOLVED',marketSides:[{long:true,price:'0.5'}]}]})});
 assert.equal(r2.outcomes.every(o=>o.outcome==='UNKNOWN'),true);assert.equal(st.stats.unknown,3);
});

test('settlement tracker backs off on 429 without losing legs',async()=>{
 const now=Date.now(),st=ev.defaultEvidenceState();
 ev.trackLegs(st,ev.scanWindows([soccer('g1',88,now)],now,settings),now);
 const r=await ev.resolveTracked(st,{now,fetchImpl:async()=>res({},429)});
 assert.equal(r.rateLimited,true);assert.equal(Object.keys(st.tracked).length,3);
});

test('markup: conservative until enough real RFQ quotes, then the median',()=>{
 assert.equal(ev.medianMarkup([.01,.02]),null);
 assert.equal(ev.medianMarkup([.01,.02,.03,.04,.05]),.03);
 assert.equal(ev.effectiveMarkup({markup:{median:null}}),ev.CONSERVATIVE_MARKUP);
 assert.equal(ev.effectiveMarkup({markup:{median:.012}}),.012);
});

test('shadow auto: places with the auto logic at ask-product + markup, settles on real outcomes, voids on UNKNOWN',()=>{
 const now=Date.now(),st=ev.defaultEvidenceState();
 const byWindow=ev.scanWindows([soccer('g1',88,now),soccer('g2',89,now),soccer('g3',88,now),soccer('g4',89,now)],now,settings);
 ev.shadowStep(st,byWindow,{now,legs:2});
 const ne=st.shadow.NEAR_END;
 assert.equal(ne.open.length,1,'one combo per tick');
 const c=ne.open[0];
 assert.equal(c.askProduct,0.81);assert.equal(c.price,+(0.81+ev.CONSERVATIVE_MARKUP).toFixed(4));
 assert.ok(c.costUsd<=ev.SHADOW_STAKE_USD+1e-9);
 ev.shadowStep(st,byWindow,{now:now+1,legs:2});
 assert.equal(ne.open.length,2,'no event reused across open shadow combos');
 const used=ne.open.flatMap(x=>x.legs.map(l=>l.eventSlug));assert.equal(new Set(used).size,4);
 ev.shadowStep(st,byWindow,{now:now+2,legs:2});
 assert.equal(ne.open.length,2,'max open');
 assert.equal(ne.decisions[0].action,'skipped');
 // settle: first combo wins, second has an UNKNOWN leg
 const [a,b]=ne.open;
 const out=(leg,w)=>w!=='NEAR_END'?null:a.legs.some(l=>l.key===leg.key)?'WON':leg.key===b.legs[0].key?'UNKNOWN':'WON';
 ev.shadowStep(st,{},{now:now+3,legs:2,legOutcome:out});
 const rec=ev.shadowRecord(st).NEAR_END;
 assert.equal(rec.settled,1);assert.equal(rec.won,1);assert.equal(rec.voided,1);
 assert.equal(rec.pnlUsd,+(a.quantity-a.costUsd).toFixed(2));
 assert.ok(rec.roi>0);
});

test('evidenceTick appends the legs tape (newline-safe after a NUL tail) and persists state',async()=>{
 const now=Date.now(),raw=path.join(DIR,'raw-test'),stateFile=path.join(DIR,'ev-state.json');
 fs.mkdirSync(raw,{recursive:true});
 const d=new Date(now),day=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
 const tape=path.join(raw,`polymarket-us-legs-${day}.ndjson`);
 fs.writeFileSync(tape,'{"old":1}\n\0\0\0');
 const r=await ev.evidenceTick({now,events:[soccer('g1',88,now),soccer('g2',89,now)],settings,rawDir:raw,stateFile,state:ev.defaultEvidenceState(),fetchImpl:async()=>res({markets:[]})});
 assert.equal(r.legRows,2);
 const lines=fs.readFileSync(tape,'utf8').split('\n');
 assert.equal(lines[0],'{"old":1}');
 const parsed=lines.filter(l=>l.startsWith('{')).map(l=>JSON.parse(l));
 assert.equal(parsed.filter(x=>x.schema==='mpo.polymarket-us-legs.v1').length,2);
 const saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));
 assert.equal(saved.stats.scans,1);
 assert.equal(ev.evidenceSummary(saved).shadow.NEAR_END.open,1);
});

test('Lab proposal: read-only, rejects live claims, and applies only through the trader settings bounds',()=>{
 const f=path.join(DIR,'champ.json');
 const doc={schema:'mpo.lab-module-champion.v1',module:'polymarket-combo',liveActivationAllowed:false,qualificationStage:'PROVISIONAL',
  candidate:{id:'LATE-0.85-2L-w0',params:{window:'LATE',priceMin:0.85,maxLegs:2,rankWeights:{eta:0.5}},train:{combos:25,roi:0.04},holdout:{combos:8,roi:0.02}},evidence:{positiveEdge:true,trials:120}};
 fs.writeFileSync(f,JSON.stringify(doc));
 const p=ev.labComboProposal(f);
 assert.equal(p.valid,true);assert.deepEqual(p.params,{window:'LATE',priceMin:0.85,maxLegs:2,rankWeights:{eta:0.5}});
 const s=combos.setUSComboSettings(p.params);
 assert.equal(s.window,'LATE');assert.equal(s.priceMin,0.85);assert.equal(s.maxLegs,2);assert.equal(s.rankWeights.eta,0.5);
 fs.writeFileSync(f,JSON.stringify({...doc,liveActivationAllowed:true}));
 assert.equal(ev.labComboProposal(f).valid,false);
 fs.writeFileSync(f,JSON.stringify({...doc,candidate:{...doc.candidate,params:{window:'LATE',priceMin:0.5,maxLegs:9}}}));
 assert.throws(()=>combos.setUSComboSettings(ev.labComboProposal(f).params),/between/);
 assert.equal(ev.labComboProposal(path.join(DIR,'missing.json')),null);
});

test('polymarketFitness: per-window settled/open, hit rate, P/L, calibration; search blocked until 20 settled everywhere',()=>{
 const st=ev.defaultEvidenceState(),W=Object.keys(ev.shadowRecord(st));
 const f0=ev.polymarketFitness(st);
 assert.equal(f0.verdict,'BLOCKED');assert.equal(f0.searchAllowed,false);assert.equal(f0.blockers.length,W.length);assert.equal(f0.combosParked,true);
 for(const w of W)st.shadow[w]={open:[{}],history:Array.from({length:20},(_,i)=>({status:i<12?'WON':'LOST',pnlUsd:i<12?1:-1,costUsd:2}))};
 st.calibration={k:{bucket:'0.5',sport:'nba',window:W[0],n:3,wins:2,sumPrice:1.5,sumFee:0.03}};
 const f=ev.polymarketFitness(st);
 assert.equal(f.searchAllowed,true);assert.equal(f.verdict,'KEEP_RESEARCHING');assert.deepEqual(f.blockers,[]);
 assert.deepEqual(f.byWindow[W[0]],{settled:20,open:1,hitRate:0.6,pnlUsd:4,roi:0.1,calibrationRows:1});
 assert.equal(f.calibrationRows,1);
 st.shadow[W[0]].history.pop();assert.equal(ev.polymarketFitness(st).verdict,'BLOCKED','one window short blocks the search');
 assert.ok(ev.evidenceSummary(st).fitness);
});
