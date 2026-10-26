import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let sequence=0;
// Each case gets a fresh module/cache, temporary book, fixed clock and mocked read-only feeds.
// No installed application data or provider requests are used.
async function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-bootstrap-'));
 const saved={...process.env},savedFetch=globalThis.fetch;
 let now=1_800_000_000_000,resolved=false;
 t.mock.method(Date,'now',()=>now);
 Object.assign(process.env,{MONEY_PRINTER_DATA_DIR:dir,POLYMARKET_AUTOSTART:'false',POLYMARKET_BOOTSTRAP_EXPLORATION:options.envBootstrap??'true'});
 for(const k of Object.keys(process.env))if(k.startsWith('MPO_PAPER_POLYMARKET_'))delete process.env[k];
 const events=Array.from({length:3},(_,i)=>({id:'e'+i,gameId:'g'+i,title:'Soccer '+i,live:true,ended:false,period:'2H',elapsed:'90',score:'2-0',sport:{sport:'soccer'},
  markets:[{id:'m'+i,sportsMarketType:'moneyline',outcomes:['Yes','No'],outcomePrices:[.9,.1],clobTokenIds:['t'+i,'n'+i],bestAsk:.9,bestBid:.89,liquidity:10000,acceptingOrders:true,...options.market}],...options.event}));
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(url);
  assert.ok(['gamma-api.polymarket.com','clob.polymarket.com'].includes(u.hostname),'unexpected host');
  if(u.pathname==='/events')return Response.json(events);
  if(u.pathname==='/books'){
   now+=options.bookDelayMs||0;
   return Response.json(options.noBooks?[]:JSON.parse(init.body).map(x=>({asset_id:x.token_id,asks:[{price:options.ask??.9,size:options.depthSize??1000}],bids:[{price:options.bid??.89,size:1000}]})));
  }
  if(u.pathname==='/markets')return Response.json(u.searchParams.getAll('id').map(id=>({id,closed:resolved,outcomes:['Yes','No'],outcomePrices:resolved?[1,0]:[.9,.1]})));
  throw Error('Unexpected request '+u.pathname);
 };
 const api=await import(`../src/polymarket.js?bootstrap=${++sequence}`),file=path.join(dir,'polymarket-paper.json');
 const read=()=>JSON.parse(fs.readFileSync(file,'utf8'));
 const write=s=>fs.writeFileSync(file,JSON.stringify(s));
 t.after(()=>{api.stopPolymarketLoops();globalThis.fetch=savedFetch;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);fs.rmSync(dir,{recursive:true,force:true});});
 api.resetPolymarketPaper(25);
 api.setAutopilot({enabled:true,mode:options.mode||'singles',...options.autopilot});
 return {api,read,write,resolve(){resolved=true;api.__testing.resetSettlement();},now:()=>now};
}

function candidate({samples=0,fair=.9,net=.9045,source='QUOTE_PRIOR'}={}){
 return {calibrationSamples:samples,fairProbability:fair,fillPrice:.9,netPrice:net,edgeAfterFriction:fair-net,expectedRoi:fair/net-1,evEvidence:source};
}

test('bootstrap bypasses only missing evidence; negative/thin/unknown estimates and live mode stay blocked',async t=>{
 const {api}=await fixture(t),fresh=candidate(),opts={bootstrapExploration:true};
 assert.equal(api.candidateEvGate(fresh).reason,'ev-uncalibrated');
 assert.equal(api.candidateAutopilotGate(fresh).ok,false);
 assert.equal(api.candidateAutopilotGate(fresh,opts).lane,'EXPLORATION');
 for(const mode of ['LIVE','live','UNKNOWN'])assert.equal(api.candidateAutopilotGate(fresh,{...opts,mode}).ok,false);
 for(const samples of [1,11,12,25,50]){
  const bad=candidate({samples,source:'PAPER_CALIBRATION'});
  assert.equal(api.candidateAutopilotGate(bad,opts).reason,'negative-or-thin-ev',`negative at n=${samples}`);
 }
 assert.equal(api.candidateAutopilotGate(candidate({samples:11,fair:.91,source:'PAPER_CALIBRATION'}),opts).reason,'negative-or-thin-ev');
 assert.equal(api.candidateAutopilotGate(candidate({samples:11,fair:.96,source:'PAPER_CALIBRATION'}),opts).lane,'EXPLORATION');
 assert.equal(api.candidateAutopilotGate(candidate({samples:12,fair:.96,source:'PAPER_CALIBRATION'}),opts).lane,'BASELINE');
 assert.equal(api.candidateAutopilotGate(candidate({source:'MODEL'}),opts).ok,false,'negative model EV is not a quote prior');
 assert.equal(api.candidateAutopilotGate(candidate({fair:.7}),opts).ok,false,'a prior label cannot hide a negative forecast');
 for(const key of ['expectedRoi','edgeAfterFriction','fillPrice','netPrice','fairProbability'])for(const v of [null,undefined,NaN,Infinity]){
  assert.equal(api.candidateAutopilotGate({...fresh,[key]:v},opts).ok,false,`${key}=${v}`);
 }
});

test('combo bootstrap cannot mask a losing leg or waive measured joint EV just because a leg is exploratory',async t=>{
 const {api}=await fixture(t),fresh=candidate(),opts={bootstrapExploration:true};
 assert.equal(api.comboExpectedValue([fresh,fresh]).ok,false);
 assert.equal(api.comboExpectedValue([fresh,fresh],opts).ok,true);
 assert.equal(api.comboExpectedValue([fresh,fresh],{...opts,mode:'LIVE'}).ok,false);
 for(const samples of [1,11,20])assert.equal(api.comboExpectedValue([fresh,candidate({samples,source:'PAPER_CALIBRATION'})],opts).ok,false);
 // Both legs clear their individual edge floors; their joint ROI remains below 2.5%.
 const partial=candidate({samples:11,net:.9,fair:.9151,source:'PAPER_CALIBRATION'});
 const mature=candidate({samples:50,net:.9,fair:.9061,source:'PAPER_CALIBRATION'});
 assert.equal(api.candidateAutopilotGate(partial,{...opts,combo:true}).ok,true);
 assert.equal(api.candidateAutopilotGate(mature,{...opts,combo:true}).ok,true);
 assert.equal(api.comboExpectedValue([partial,mature],opts).ok,false,'joint EV restriction retained');
});

for(const mode of ['singles','combos'])test(`${mode}: a fresh paper book fills with real modeled fees and preserves exploration provenance through settlement`,async t=>{
 const {api,read,resolve}=await fixture(t,{mode});
 const r=await api.runAutopilotOnce();assert.ok(r.placed>0);
 const s=read();assert.ok(s.cashUsd<25);assert.equal(s.mode,'PAPER');
 assert.ok(Math.abs(s.cashUsd+s.positions.reduce((n,p)=>n+p.stakeUsd,0)-25)<.0001);
 for(const p of s.positions){
  assert.equal(p.placedBy,'autopilot');assert.equal(p.mode,'PAPER');assert.ok(p.feeUsd>0);
  assert.equal(p.research.lane,'EXPLORATION');assert.equal(p.research.evidenceQuality,'UNCALIBRATED');
  assert.ok(p.research.expectedRoi<0,'quote-prior fee drag remains visible, not labeled profit');
  for(const l of p.legs){assert.equal(l.autopilotLane,'EXPLORATION');assert.equal(l.evidenceQuality,'UNCALIBRATED');assert.equal(l.evEvidence,'QUOTE_PRIOR');}
 }
 if(mode==='combos')assert.equal(s.positions.length,1,'existing earned-slot growth limit');
 assert.equal((await api.runAutopilotOnce()).placed,0,'no duplicate markets or games');
 resolve();await api.settlePaperPositions();
 const settled=read();assert.equal(settled.positions.length,0);assert.equal(settled.history.length,s.positions.length);
 assert.ok(settled.history.every(p=>p.research.lane==='EXPLORATION'&&p.legs.every(l=>l.evidenceQuality==='UNCALIBRATED')));
 assert.equal(api.realPolymarketReadiness().enabled,false);
});

test('exploration is independently disableable and persisted false overrides the default',async t=>{
 const {api,read}=await fixture(t,{envBootstrap:'false'});
 assert.equal(read().autopilot.bootstrapExploration,false);
 assert.equal((await api.runAutopilotOnce()).placed,0);
 process.env.POLYMARKET_BOOTSTRAP_EXPLORATION='true';
 assert.equal((await api.runAutopilotOnce()).placed,0);
 api.setAutopilot({bootstrapExploration:true});assert.ok((await api.runAutopilotOnce()).placed>0);
 assert.throws(()=>api.setAutopilot({bootstrapExploration:'false'}),/boolean/);
});

const rejections=[
 ['liquidity',{market:{liquidity:999}},'liquidity'],
 ['price band',{market:{bestAsk:.79,outcomePrices:[.79,.21]}},'price-band'],
 ['spread',{market:{bestBid:.6}},'spread'],
 ['market type',{market:{sportsMarketType:'player_prop'}},'market-type'],
 ['not live',{event:{live:false}},'not-live'],
 ['ended',{event:{ended:true}},'not-live'],
 ['combo disabled',{market:{comboStatus:'disabled'}},'combo-disabled'],
 ['orders closed',{market:{acceptingOrders:false}},null],
 ['no executable book',{noBooks:true},'no-fill-price'],
 ['depth',{depthSize:1.5},'thin-depth'],
 ['exposure',{autopilot:{maxOpenPct:1}},'exposure-cap'],
 ['combo depth',{mode:'combos',depthSize:4},'combo-needs-2-research-eligible-games'],
 ['combo exposure',{mode:'combos',autopilot:{maxOpenPct:1}},'combo-exposure-cap'],
 ['bankroll',{autopilot:{stakeSingleUsd:30,maxOpenPct:100}},'exposure-cap'],
 ['combo bankroll',{mode:'combos',autopilot:{stakeComboUsd:30,maxOpenPct:100}},'combo-exposure-cap'],
 ['stale live data',{bookDelayMs:95000},'stale'],
 ['autopilot disabled',{autopilot:{enabled:false}},'autopilot-off'],
 ['simulated fill rejected',{fillReject:true},'Paper fill rejected: simulated-no-fill'],
];
for(const [label,options,reason] of rejections)test(`exploration retains ${label} rejection`,async t=>{
 const {api,read,write}=await fixture(t,options);
 if(options.fillReject)process.env.MPO_PAPER_POLYMARKET_REJECT_PROBABILITY='1';
 const before=read(),r=await api.runAutopilotOnce(),after=read();
 assert.equal(r.placed,0);assert.equal(after.cashUsd,before.cashUsd);assert.deepEqual(after.positions,before.positions);
 if(reason){
  const snapshot=await api.polymarketSnapshot();
  assert.ok(r.skipped.some(x=>x.reason===reason)||snapshot.strategy.candidateDiagnostics.rejections[reason]>0,JSON.stringify({label,skipped:r.skipped,diagnostics:snapshot.strategy.candidateDiagnostics}));
 }
});

test('a single observed loss is not hidden behind insufficient calibration',async t=>{
 const {api,read,write}=await fixture(t),s=read();
 s.history=[{id:'loss',kind:'single',status:'LOST',stakeUsd:1,pnlUsd:-1,createdAt:Date.now()-900000,settledAt:Date.now()-600000,settlementSource:'gamma-market',legs:[{result:'lost',price:.9,fillPrice:.9}]}];
 write(s);const r=await api.runAutopilotOnce();assert.equal(r.placed,0);assert.ok(r.skipped.some(x=>x.reason==='negative-or-thin-ev'));
});

test('settlement backlog and corrupt paper state remain closed to exploration',async t=>{
 const {api,read,write}=await fixture(t),s=read();
 s.positions=[{id:'old',kind:'single',status:'OPEN',createdAt:Date.now()-12*3600000,stakeUsd:1,legs:[{marketId:'old',fillPrice:.9,timing:{etaMinutes:5}}]}];
 write(s);assert.equal((await api.runAutopilotOnce()).placed,0);
 assert.equal(read().autopilot.skipped[0].reason,'settlement-bias-drop');
 fs.writeFileSync(api.__testing.STATE_FILE,'broken JSON');
 assert.equal((await api.runAutopilotOnce()).placed,0);assert.equal(read().recoveryRequired,true);assert.equal(read().cashUsd,0);
});


test('placement rechecks cash even when called directly with exploration-tagged legs',async t=>{
 const {api,read}=await fixture(t),before=read();
 const leg={...candidate(),marketId:'m0',gameId:'g0',liveState:{period:'2H'},nearEndScore:90,price:.9,askDepthUsd:1000,autopilotLane:'EXPLORATION',evidenceQuality:'UNCALIBRATED'};
 assert.throws(()=>api.placePaperSingle({leg,stakeUsd:30,placedBy:'autopilot'}),/Insufficient paper cash/);
 assert.throws(()=>api.placePaperCombo({legs:[leg,{...leg,marketId:'m1',gameId:'g1'}],stakeUsd:30,placedBy:'autopilot'}),/Insufficient paper cash/);
 assert.deepEqual(read(),before);
});
