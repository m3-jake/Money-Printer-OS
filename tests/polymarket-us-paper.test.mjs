import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const DIR=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-poly-paper-'));
process.env.MONEY_PRINTER_DATA_DIR=DIR;
process.env.POLYMARKET_AUTOSTART='false';
process.env.POLYMARKET_US_COMBO_FEE_MODE='standard';
process.env.POLYMARKET_US_COMBO_BBO='false';

const paper=await import('../src/polymarketUSPaper.js');
const savedFetch=globalThis.fetch;
// Any network call the paper book makes on its own is a bug: settlement always gets an explicit fetchImpl.
globalThis.fetch=async url=>{throw new Error(`unexpected fetch ${url}`)};
test.after(()=>{globalThis.fetch=savedFetch;fs.rmSync(DIR,{recursive:true,force:true})});

const SETTINGS={priceMin:0.6,maxMinutesLeft:15,maxLegs:3,window:'NEAR_END'};
test('paper bounds support single stakes and expanded open/leg limits',()=>{assert.deepEqual(paper.PAPER_BOUNDS,{startUsd:{min:1,max:1_000_000},stakeUsd:{min:1,max:500},maxOpen:{min:1,max:25},maxLegs:{min:1,max:6}})});
function cand(i,price=0.9,over={}){
 return {key:`k${i}`,symbol:`mkt-${i}`,side:'SIDE_BUY',event:`Game ${i}`,eventSlug:`ev-${i}`,outcome:`Team ${i}`,price,
  freshnessSec:1,at:Date.now(),liveState:{period:'Q4',score:'1-0'},etaMinutes:5,nearEndScore:1,rank:10-i,eligible:true,feeCoefficient:0.06,...over};
}
const resolved=(slug,longWon)=>({slug,status:'MARKET_STATUS_RESOLVED',marketSides:[{long:true,price:longWon?'1':'0'},{long:false,price:longWon?'0':'1'}]});
const mockFetch=markets=>async url=>{const want=new URL(url).searchParams.getAll('slug');return {ok:true,status:200,text:async()=>JSON.stringify({markets:markets.filter(m=>want.includes(m.slug))})}};
function fresh(){paper.resetPaperBook();paper.__testing.reload();paper.__testing.setMarkup(0.03)}

test('paper price is the leg ask product plus markup, and cost comes out of paper cash', ()=>{
 fresh();
 const cands=[cand(1,0.9),cand(2,0.8)];
 const e=paper.placePaperCombo({legKeys:['k1','k2'],stakeUsd:5,candidates:cands,settings:SETTINGS,markup:0.03});
 assert.equal(e.rawPrice,0.72);
 assert.equal(e.price,0.75);
 assert.ok(e.costUsd<=5&&e.costUsd>4.5,`cost ${e.costUsd}`);
 const v=paper.paperBookView();
 assert.equal(v.open.length,1);
 assert.equal(v.cashUsd,Math.round((100-e.costUsd)*100)/100);
 assert.equal(v.equityUsd,100);
 assert.equal(v.paperOnly,true);
});

test('a game with an open paper combo cannot be used again, and stake bounds hold', ()=>{
 fresh();
 const cands=[cand(1),cand(2),cand(3)];
 paper.placePaperCombo({legKeys:['k1','k2'],stakeUsd:5,candidates:cands,settings:SETTINGS});
 assert.throws(()=>paper.placePaperCombo({legKeys:['k1','k3'],stakeUsd:5,candidates:cands,settings:SETTINGS}),/already has an open paper combo/);
 assert.throws(()=>paper.placePaperCombo({legKeys:['k2','k3'],stakeUsd:501,candidates:cands,settings:SETTINGS}),/Paper stake/);
 assert.throws(()=>paper.placePaperCombo({legKeys:['k3'],stakeUsd:5,candidates:cands,settings:SETTINGS}),/at least 2 legs/);
});

test('settlement: binary outcomes pay or lose; nonbinary and missing outcomes keep capital reserved', async()=>{
 fresh();
 paper.setPaperAutopilot({maxOpen:4});
 const cands=[1,2,3,4,5,6,7,8].map(i=>cand(i));
 const won=paper.placePaperCombo({legKeys:['k1','k2'],stakeUsd:5,candidates:cands,settings:SETTINGS});
 const lost=paper.placePaperCombo({legKeys:['k3','k4'],stakeUsd:5,candidates:cands,settings:SETTINGS});
 const voided=paper.placePaperCombo({legKeys:['k5','k6'],stakeUsd:5,candidates:cands,settings:SETTINGS});
 const waiting=paper.placePaperCombo({legKeys:['k7','k8'],stakeUsd:5,candidates:cands,settings:SETTINGS});
 const markets=[resolved('mkt-1',true),resolved('mkt-2',true),resolved('mkt-3',true),resolved('mkt-4',false),
  resolved('mkt-5',true),{slug:'mkt-6',status:'MARKET_STATUS_RESOLVED',marketSides:[{long:true,price:'0.5'}]},
  resolved('mkt-7',true),{slug:'mkt-8',status:'MARKET_STATUS_OPEN',marketSides:[]}];
 const r=await paper.settlePaperCombos({fetchImpl:mockFetch(markets),now:Date.now()+4*86400e3});
 assert.equal(r.settled,2);
 const v=paper.paperBookView(),by=Object.fromEntries(v.history.map(x=>[x.id,x]));
 assert.equal(by[won.id].status,'WON');assert.equal(by[won.id].pnlUsd,Math.round((won.quantity-won.costUsd)*100)/100);
 assert.equal(by[lost.id].status,'LOST');assert.equal(by[lost.id].pnlUsd,-lost.costUsd);
 assert.equal(by[voided.id],undefined);
 assert.deepEqual(v.open.map(x=>x.id),[voided.id,waiting.id]);
 assert.match(v.open[0].settlementReason,/UNKNOWN/);
 assert.equal(v.stats.won,1);assert.equal(v.stats.lost,1);assert.equal(v.stats.voided,0);
 const expectCash=100-waiting.costUsd-voided.costUsd-lost.costUsd+(won.quantity-won.costUsd);
 assert.ok(Math.abs(v.cashUsd-expectCash)<0.02,`cash ${v.cashUsd} vs ${expectCash}`);
});

test('paper autopilot places from eligible in-window legs only and respects max open and off', async()=>{
 fresh();
 paper.setPaperAutopilot({enabled:true,stakeUsd:4,maxOpen:1,maxLegs:2});
 const pool=[cand(1),cand(2,0.9,{outsideWindow:true}),cand(3),cand(4,0.9,{eligible:false})];
 const r1=await paper.runPaperAutopilotOnce({pool});
 assert.equal(r1.ran,true);
 assert.deepEqual(r1.entry.legs.map(l=>l.symbol).sort(),['mkt-1','mkt-3']);
 assert.equal(r1.entry.placedBy,'paper-autopilot');
 const r2=await paper.runPaperAutopilotOnce({pool});
 assert.equal(r2.ran,false);assert.match(r2.reason,/max open/);
 paper.setPaperAutopilot({enabled:false});
 assert.equal((await paper.runPaperAutopilotOnce({pool})).reason,'off');
});

test('a lone eligible leg is rejected as an incomplete combo, not displayed as a paper selection',async()=>{
 fresh();paper.setPaperAutopilot({enabled:true,maxLegs:2});
 const r=await paper.runPaperAutopilotOnce({pool:[cand(1)]});assert.equal(r.ran,false);
 const row=paper.paperBookView().evaluation.rows[0];assert.equal(row.decision,'REJECTED');assert.match(row.reason,/only 1 of 2 distinct legs/);
});

test('reset refills the bankroll and keeps autopilot settings; the book never touches the real journal', ()=>{
 fresh();
 paper.setPaperAutopilot({stakeUsd:7});
 paper.placePaperCombo({legKeys:['k1','k2'],stakeUsd:5,candidates:[cand(1),cand(2)],settings:SETTINGS});
 const b=paper.resetPaperBook({startUsd:250});
 assert.equal(b.cashUsd,250);assert.equal(b.open.length,0);assert.equal(b.autopilot.stakeUsd,7);
 assert.equal(b.priorEpochs.length>0,true);
 const archive=path.join(DIR,'polymarket-us-paper-epochs',b.priorEpochs[0].file);
 assert.equal(fs.existsSync(archive),true);
 assert.equal(JSON.parse(fs.readFileSync(archive,'utf8')).open.length,1);
 assert.equal(fs.existsSync(path.join(DIR,'polymarket-us-combos.json')),false);
 assert.equal(fs.existsSync(path.join(DIR,'polymarket-us-paper.json')),true);
});

test('corrupt paper state blocks entry and reset archives the original bytes',()=>{
 fresh();
 fs.writeFileSync(paper.PAPER_FILE,'{broken-paper');paper.__testing.reload();
 assert.equal(paper.paperBookView().recoveryRequired,true);
 assert.throws(()=>paper.placePaperCombo({legKeys:['k1','k2'],stakeUsd:5,candidates:[cand(1),cand(2)],settings:SETTINGS}),/needs recovery/);
 const b=paper.resetPaperBook();
 assert.equal(b.recoveryRequired,undefined);
 assert.equal(fs.readFileSync(path.join(DIR,'polymarket-us-paper-epochs',b.priorEpochs[0].file),'utf8'),'{broken-paper');
});

test('an eligible Lab proposal changes only paper policy and a losing trial rolls back',async()=>{
 fresh();paper.setPaperAutopilot({enabled:true,maxLegs:2,stakeUsd:5});
 const {usComboSettings}=await import('../src/polymarketUSCombos.js');const realBefore=usComboSettings();
 const proposal={valid:true,paperAllowed:true,positiveEdge:true,publishedAt:Date.now(),id:'lab-candidate',params:{window:'LATE',priceMin:0.85,maxLegs:2},
  datasetHash:'a'.repeat(64),evaluatorVersion:'combo-replay.v1',independentOutcomes:25,holdout:{combos:20,roi:0.02}};
 const policy=paper.setPaperLabPolicy(proposal);
 assert.equal(policy.status,'RUNNING');assert.equal(policy.settings.window,'LATE');assert.deepEqual(usComboSettings(),realBefore);
 const run=await paper.runPaperAutopilotOnce({pool:[cand(1,0.9),cand(2,0.9)]});
 assert.equal(run.ran,true);assert.equal(run.entry.window,'LATE');assert.equal(run.entry.policyHash,policy.appliedHash);
 await paper.settlePaperCombos({fetchImpl:mockFetch([resolved('mkt-1',true),resolved('mkt-2',false)])});
 const view=paper.paperBookView();assert.equal(view.policy,null);assert.equal(view.policyHistory[0].status,'REVERTED');
 assert.match(view.policyHistory[0].rollbackReason,/loss budget/);assert.deepEqual(usComboSettings(),realBefore);
});

test('running paper loop selects, persists, settles and displays a virtual combo without transport',async()=>{
 fresh();paper.setPaperAutopilot({enabled:true,stakeUsd:5,maxOpen:1,maxLegs:2});
 const pool={feed:{ok:true,live:3},candidates:[cand(1),cand(2)],board:[cand(1),cand(2),cand(3,0.8,{eligible:false,reason:'stale-live'})],rejections:{'stale-live':1}};
 let markets=[];const waitFor=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}assert.fail('paper loop did not reach expected state')};
 process.env.POLYMARKET_AUTOSTART='true';
 try{
  paper.startPaperLoops({autoMs:20,settleMs:20,autoPass:()=>paper.runPaperAutopilotOnce({pool}),settlePass:()=>paper.settlePaperCombos({fetchImpl:mockFetch(markets)})});
  await waitFor(()=>paper.paperBookView().open.length===1);
  let view=paper.paperBookView();
  assert.equal(view.open[0].placedBy,'paper-autopilot');
  assert.equal(view.open[0].priceEvidence.observedComboQuote,false);
  assert.equal(view.evaluation.rows.find(r=>r.symbol==='mkt-3').reason,'stale-live');
  markets=[resolved('mkt-1',true),resolved('mkt-2',true)];
  await waitFor(()=>paper.paperBookView().history.length===1);
  paper.stopPaperLoops();paper.__testing.reload();view=paper.paperBookView();
  assert.equal(view.history[0].status,'WON');assert.ok(view.stats.pnlUsd>0);
  const html=fs.readFileSync(new URL('../public/dashboard.html',import.meta.url),'utf8');
  const start=html.indexOf('function usPaperHtml('),end=html.indexOf('function bindUSPaper(',start);
  const context={usPaperDraft:{},usPaperBusy:false,usComboStakeValue:5,polyEscape:x=>String(x),polyTime:x=>String(x),polyNum:Number,
   polyCents:x=>String(x),polyUsd:x=>String(x),fmt:x=>Number(x).toFixed(2)};
  const rendered=vm.runInNewContext(`${html.slice(start,end)};usPaperHtml(paperView,[],false)`,{...context,paperView:view});
  assert.match(rendered,/Team 1 \+ Team 2/);assert.match(rendered,/WON/);assert.match(rendered,/stale-live/);
 }finally{paper.stopPaperLoops();process.env.POLYMARKET_AUTOSTART='false'}
});
