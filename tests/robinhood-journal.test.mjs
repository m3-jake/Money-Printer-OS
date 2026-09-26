import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-rh-journal-'));
process.env.MONEY_PRINTER_DATA_DIR=DIR;
process.env.POLYMARKET_AUTOSTART='false';
process.env.ROBINHOOD_AUTOSTART='false';
for(const k of Object.keys(process.env))if(/^ROBINHOOD_(QUAL_|DAILY_LOSS|PAPER_START|FEE_RATIO|TICK)/.test(k))delete process.env[k];

const J=await import('../src/robinhoodJournal.js');
const {__testing:T}=J;

function reset(){
 T.resetJournal();T.resetPaper();
 fs.rmSync(DIR,{recursive:true,force:true});
 fs.mkdirSync(DIR,{recursive:true});
}
const tmpFiles=()=>fs.existsSync(DIR)?fs.readdirSync(DIR).filter(f=>f.endsWith('.tmp')):[];
const H=3600e3,D=864e5;
function paperClose(over={}){
 const closedAt=over.closedAt??Date.now()-H;
 return {id:J.newPaperId(),symbol:'BTC-USD',status:'CLOSED',placedBy:'paper-autopilot',qty:0.001,entryAsk:60000,fillPrice:60030,feeUsd:0.51,costUsd:60.54,
  at:closedAt-H,stopPct:0.0185,takePct:0.074,trailArmPct:0.037,trailPct:0.0185,peakBid:null,trailStop:null,maxFavorablePct:0,maxAdversePct:0,
  paramsHash:'abc123abc123',quoteSource:'v2',exit:{reason:'take',bid:64000,fillPrice:63970,feeUsd:0.54,proceedsUsd:63.43,at:closedAt,source:'model'},
  pnlUsd:2.89,closedBy:'strategy',closedAt,...over};
}
function makePaper(closes,over={}){
 return {...J.defaultPaper(),paramsHash:'abc123abc123',history:closes,...over};
}
function winners(n,opts={}){return Array.from({length:n},(_,i)=>paperClose({closedAt:Date.now()-H*(i+1),pnlUsd:3,...opts}))}
function losers(n,opts={}){return Array.from({length:n},(_,i)=>paperClose({closedAt:Date.now()-H*(i+1)-1,pnlUsd:-1,...opts}))}

test.after(()=>{try{fs.rmSync(DIR,{recursive:true,force:true})}catch{}});

// ---------------------------------------------------------------- files + contract
test('file paths live under MONEY_PRINTER_DATA_DIR and constants match the contract',()=>{
 assert.equal(J.JOURNAL_FILE,path.join(DIR,'robinhood-auto-trader.json'));
 assert.equal(J.PAPER_FILE,path.join(DIR,'robinhood-paper.json'));
 assert.equal(T.journalFile,J.JOURNAL_FILE);assert.equal(T.paperFile,J.PAPER_FILE);
 assert.deepEqual(J.OPEN_STATUSES,['PENDING_SUBMIT','SUBMITTED','SUBMITTED_UNCERTAIN','OPEN','CLOSING','CLOSING_UNCERTAIN']);
 assert.deepEqual(J.TERMINAL_STATUSES,['CLOSED','CANCELLED','REJECTED','FAILED','FORGOTTEN']);
 assert.equal(T.TAPE_FLUSH_MS,30000);assert.equal(T.TAPE_CAP,720);assert.equal(T.HISTORY_CAP,200);assert.equal(T.PAPER_HISTORY_CAP,500);
});

test('ENOENT -> defaults with autopilot off; default shapes pin the spec keys',()=>{
 reset();
 const j=J.loadJournal();
 assert.equal(j.recoveryRequired,undefined);
 assert.equal(j.autopilot.enabled,false);
 assert.deepEqual(Object.keys(j),['version','open','history','stats','autopilot','cooldowns','account','lastReconcileAt','lastError']);
 assert.deepEqual(j.autopilot,{enabled:false,orderUsd:10,maxOpen:2,dailyLossCapUsd:25,symbols:['BTC-USD','ETH-USD'],orderType:'market',lastRunAt:0,lastAction:null,skipped:[],disabledReason:null,disabledAt:0,enabledAt:0,paramsHash:null});
 assert.deepEqual(j.stats,{placed:0,closed:0,won:0,lost:0,pnlUsd:0,feesUsd:0,hitRate:null,profitFactor:null,unverified:0});
 const p=J.loadPaper();
 assert.equal(p.recoveryRequired,undefined);
 assert.equal(p.cashUsd,1000);assert.equal(p.startUsd,1000);assert.equal(p.feeRatio,0.0095);
 assert.deepEqual(p.autopilot,{enabled:false,orderUsd:25,maxOpen:3,symbols:['BTC-USD','ETH-USD'],lastRunAt:0,lastAction:null,skipped:[]});
 assert.deepEqual(Object.keys(p.qualification),['qualified','paramsHash','closes','hitRate','profitFactor','pnlUsd','grossPnlUsd','feesUsd','feeDragPct','maxDrawdownUsd','requiredHitRate','lastCloseAt','windowDays','reasons','at']);
 assert.deepEqual(p.qualification.reasons,['closes 0 < 20']);
 assert.equal(fs.existsSync(J.JOURNAL_FILE),false,'load never writes');
});

test('normalizers survive garbage input and never carry sessionArmed',()=>{
 for(const g of [null,undefined,42,'x',[],{open:'nope',history:{},stats:null,autopilot:'y',cooldowns:[1],account:3,sessionArmed:true}]){
  const j=J.normalizeJournal(g);
  assert.deepEqual(j.open,[]);assert.deepEqual(j.history,[]);assert.equal(j.autopilot.enabled,false);assert.deepEqual(j.cooldowns,{});
  assert.equal('sessionArmed' in j,false);
  const p=J.normalizePaper(g);
  assert.deepEqual(p.positions,[]);assert.deepEqual(p.history,[]);assert.deepEqual(p.tape,{});assert.equal(p.autopilot.enabled,false);
  assert.equal('sessionArmed' in p,false);
 }
 const j=J.normalizeJournal({autopilot:{enabled:'true',orderUsd:-5,maxOpen:'3.7',symbols:['btc-usd','bad','ETH-USD','ETH-USD'],orderType:'weird',skipped:Array(20).fill({})},
  open:[{id:'a',status:'OPEN'},{id:'b',status:'CLOSED'},null,'x'],cooldowns:{'BTC-USD':'12',x:-1},sessionArmed:true});
 assert.equal(j.autopilot.enabled,false,'string true is not true');
 assert.equal(j.autopilot.orderUsd,10);assert.equal(j.autopilot.maxOpen,3);assert.deepEqual(j.autopilot.symbols,['BTC-USD','ETH-USD']);
 assert.equal(j.autopilot.orderType,'market');assert.equal(j.autopilot.skipped.length,8);
 assert.deepEqual(j.open.map(e=>e.id),['a'],'terminal rows are never kept in open[]');
 assert.deepEqual(j.cooldowns,{'BTC-USD':12});
 const p=J.normalizePaper({cashUsd:'12.5',feeRatio:0,tape:{'BTC-USD':{samples:[[3,1,2],[1,1,2],[2,0,2],[1,5,6],'x']},bad:{samples:[[1,1,1]]}},positions:[{status:'OPEN',id:'p'},{status:'CLOSED',id:'q'}]});
 assert.equal(p.cashUsd,12.5);assert.equal(p.feeRatio,0.0095);
 assert.deepEqual(p.tape['BTC-USD'].samples,[[1,5,6],[3,1,2]],'sorted, deduped, invalid dropped');
 assert.equal(p.tape.bad,undefined);
 assert.deepEqual(p.positions.map(x=>x.id),['p']);
 assert.equal(JSON.stringify(J.normalizeJournal({sessionArmed:true})).includes('sessionArmed'),false);
});

// ---------------------------------------------------------------- fail-closed recovery
test('corrupt journal -> recoveryRequired, autopilot forced off, paper untouched',()=>{
 reset();
 fs.writeFileSync(J.JOURNAL_FILE,'{not json');
 const j=J.loadJournal();
 assert.equal(j.recoveryRequired,true);
 assert.match(j.recoveryError,/^STATE RECOVERY REQUIRED: /);
 assert.equal(j.autopilot.enabled,false);
 assert.equal(J.loadPaper().recoveryRequired,undefined);
 assert.equal(J.loadPaper().cashUsd,1000);
});

test('corrupt journal keeps autopilot off even when the file said enabled (normalizer path)',()=>{
 const j=J.normalizeJournal({recoveryRequired:true,autopilot:{enabled:true}});
 assert.equal(j.recoveryRequired,true);assert.equal(j.autopilot.enabled,false);
});

test('corrupt paper -> cashUsd 0, autopilot off, qualification revoked, real journal untouched',()=>{
 reset();
 J.saveJournal({...J.defaultJournal(),autopilot:{...J.defaultRealAutopilot(),enabled:true,paramsHash:'x'}});
 T.resetJournal();
 fs.writeFileSync(J.PAPER_FILE,'\u0000garbage');
 const p=J.loadPaper();
 assert.equal(p.recoveryRequired,true);
 assert.match(p.recoveryError,/^STATE RECOVERY REQUIRED/);
 assert.equal(p.cashUsd,0);
 assert.equal(p.autopilot.enabled,false);
 assert.equal(p.qualification.qualified,false);
 assert.ok(p.qualification.reasons.includes('paperRecovery'));
 const q=J.evaluateQualification(p);
 assert.equal(q.qualified,false);assert.ok(q.reasons.includes('paperRecovery'));
 const j=J.loadJournal();
 assert.equal(j.recoveryRequired,undefined);
 assert.equal(j.autopilot.enabled,true,'paper corruption never edits the money file');
 assert.equal(JSON.parse(fs.readFileSync(J.JOURNAL_FILE,'utf8')).autopilot.enabled,true);
});

// ---------------------------------------------------------------- atomic save
test('saves are atomic: tmp file pattern, and no tmp survives a write or rename failure',()=>{
 reset();
 const j=J.saveJournal(J.defaultJournal());
 assert.equal(j.version,1);
 assert.deepEqual(tmpFiles(),[]);
 assert.deepEqual(JSON.parse(fs.readFileSync(J.JOURNAL_FILE,'utf8')).open,[]);
 const origWrite=fs.writeSync,origOpen=fs.openSync,origRename=fs.renameSync;
 const seen=[];
 try{
  // Saves go through writeFileSynced (open, write, fsync): fail the write after the tmp is opened.
  fs.openSync=(f,...a)=>{seen.push(path.basename(String(f)));return origOpen(f,...a)};
  fs.writeSync=()=>{throw new Error('EIO write')};
  assert.throws(()=>J.saveJournal(J.defaultJournal()),/EIO write/);
  assert.throws(()=>J.savePaper(J.defaultPaper(),{force:true}),/EIO write/);
  fs.writeSync=origWrite;fs.openSync=origOpen;
  fs.renameSync=()=>{throw new Error('EPERM rename')};
  assert.throws(()=>J.saveJournal(J.defaultJournal()),/EPERM rename/);
  assert.throws(()=>J.savePaper(J.defaultPaper(),{force:true}),/EPERM rename/);
 }finally{fs.writeSync=origWrite;fs.openSync=origOpen;fs.renameSync=origRename}
 assert.deepEqual(tmpFiles(),[]);
 assert.match(seen[0],/^\.robinhood-auto-trader\.\d+\.[0-9a-z]+\.tmp$/);
 assert.match(seen[1],/^\.robinhood-paper\.\d+\.[0-9a-z]+\.tmp$/);
 assert.deepEqual(JSON.parse(fs.readFileSync(J.JOURNAL_FILE,'utf8')).open,[],'original file intact');
});

test('saveJournal strips sessionArmed and the file never contains it',()=>{
 reset();
 J.saveJournal({...J.defaultJournal(),sessionArmed:true});
 assert.equal(fs.readFileSync(J.JOURNAL_FILE,'utf8').includes('sessionArmed'),false);
 J.savePaper({...J.defaultPaper(),sessionArmed:true},{force:true});
 assert.equal(fs.readFileSync(J.PAPER_FILE,'utf8').includes('sessionArmed'),false);
});

test('load is memoised; save refreshes the cache; reset re-reads the disk',()=>{
 reset();
 const a=J.loadJournal();assert.equal(J.loadJournal(),a);
 const saved=J.saveJournal({...a,lastReconcileAt:77});
 assert.equal(J.loadJournal(),saved);assert.equal(J.loadJournal().lastReconcileAt,77);
 T.resetJournal();
 assert.equal(J.loadJournal().lastReconcileAt,77);
});

// ---------------------------------------------------------------- entries + transitions
test('makeRealEntry matches the Entry shape with a persisted uuid clientOrderId',()=>{
 const e=J.makeRealEntry({symbol:'btc-usd',requestedQty:0.000153,requestedUsd:10,refAsk:65010.2,refBid:64990.5,previewFeeUsd:0.085,placedBy:'autopilot',stopPct:0.0185,takePct:0.074,trailArmPct:0.037,trailPct:0.0185,paramsHash:'abc'});
 assert.match(e.id,/^rh-[0-9a-z]+$/);
 assert.equal(e.kind,'real');assert.equal(e.symbol,'BTC-USD');assert.equal(e.side,'buy');assert.equal(e.status,'PENDING_SUBMIT');assert.equal(e.placedBy,'autopilot');
 assert.match(e.clientOrderId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 assert.equal(e.orderId,null);assert.equal(e.orderType,'market');assert.equal(e.limitPrice,null);assert.equal(e.timeInForce,'gtc');
 assert.equal(e.fillVerified,false);assert.equal(e.filledQty,0);assert.equal(e.exit,null);assert.equal(e.pnlUsd,null);
 assert.deepEqual(e.reconcile,{attempts:0,successfulListings:0,firstListingAt:0,lastAt:0});
 assert.deepEqual(e.notes,[]);assert.equal(e.paramsHash,'abc');assert.ok(e.at>0);
 assert.deepEqual(Object.keys(e),['id','kind','symbol','side','status','placedBy','clientOrderId','orderId','orderType','limitPrice','timeInForce','requestedQty','requestedUsd','refAsk','refBid','refAt','previewFeeUsd','fillVerified','filledQty','avgPrice','feeUsd','costUsd','exit','stopPct','takePct','trailArmPct','trailPct','peakBid','trailStop','markBid','unrealizedUsd','pnlUsd','submittedAt','openedAt','closedAt','at','reconcile','paramsHash','notes']);
 assert.notEqual(J.makeRealEntry({symbol:'BTC-USD'}).clientOrderId,e.clientOrderId);
 assert.match(J.newPaperId(),/^rp-[0-9a-z]+$/);
});

const GRAPH={
 PENDING_SUBMIT:['SUBMITTED','SUBMITTED_UNCERTAIN','REJECTED','FAILED','FORGOTTEN'],
 SUBMITTED:['OPEN','CANCELLED','FAILED','SUBMITTED','FORGOTTEN'],
 SUBMITTED_UNCERTAIN:['OPEN','CANCELLED','FAILED','SUBMITTED','FORGOTTEN'],
 OPEN:['CLOSING','FORGOTTEN'],
 CLOSING:['CLOSING_UNCERTAIN','OPEN','CLOSED','FORGOTTEN'],
 CLOSING_UNCERTAIN:['CLOSED','OPEN','CLOSING','FORGOTTEN'],
};
const ALL=[...J.OPEN_STATUSES,...J.TERMINAL_STATUSES];
function entryAt(status){
 const e=J.makeRealEntry({symbol:'BTC-USD',requestedQty:0.001,requestedUsd:60});
 e.status=status;
 if(['OPEN','CLOSING','CLOSING_UNCERTAIN'].includes(status)){e.fillVerified=true;e.filledQty=0.001;e.avgPrice=60000;e.costUsd=60.5;e.orderId='o1'}
 return e;
}
test('transition graph: every allowed edge passes and every forbidden edge throws code unknown',()=>{
 let allowed=0,forbidden=0;
 for(const from of J.OPEN_STATUSES)for(const to of ALL){
  const j={...J.defaultJournal(),open:[entryAt(from)],history:[]};
  const id=j.open[0].id;
  const patch=to==='CLOSED'?{fillVerified:true,exit:{reason:'take',filledQty:0.001,avgPrice:61000,feeUsd:0.5,proceedsUsd:60.5},pnlUsd:0}:{};
  if(GRAPH[from].includes(to)){
   const e=J.transition(j,id,to,patch);
   assert.equal(e.status,to);
   assert.equal(j.open.length+j.history.length,1,`${from}->${to} count`);
   if(J.TERMINAL_STATUSES.includes(to)){assert.equal(j.open.length,0);assert.equal(j.history[0].id,id);assert.ok(j.history[0].closedAt>0)}
   else{assert.equal(j.history.length,0);assert.equal(j.open[0].status,to)}
   allowed++;
  }else{
   assert.throws(()=>J.transition(j,id,to,patch),e=>e.code==='unknown'&&e.name==='RobinhoodError',`${from}->${to} must be illegal`);
   assert.equal(j.open[0].status,from,'illegal transition changes nothing');
   assert.equal(j.history.length,0);
   forbidden++;
  }
 }
 assert.equal(allowed,Object.values(GRAPH).reduce((n,a)=>n+a.length,0));assert.equal(forbidden,6*11-allowed);
});

test('transition on a missing id throws notFound; terminal rows cannot be transitioned',()=>{
 const j={...J.defaultJournal(),open:[entryAt('OPEN')],history:[]};
 assert.throws(()=>J.transition(j,'nope','CLOSING'),e=>e.code==='notFound');
 const id=j.open[0].id;
 J.transition(j,id,'FORGOTTEN');
 assert.throws(()=>J.transition(j,id,'OPEN'),e=>e.code==='notFound');
 assert.equal(j.history[0].pnlUsd,null,'FORGOTTEN carries pnlUsd null');
});

test('CLOSED requires fillVerified && exit.filledQty > 0',()=>{
 for(const from of ['CLOSING','CLOSING_UNCERTAIN']){
  let j={...J.defaultJournal(),open:[entryAt(from)],history:[]};
  assert.throws(()=>J.transition(j,j.open[0].id,'CLOSED'),e=>e.code==='unknown','no exit');
  assert.throws(()=>J.transition(j,j.open[0].id,'CLOSED',{exit:{filledQty:0}}),e=>e.code==='unknown','zero exit fill');
  j.open[0].fillVerified=false;
  assert.throws(()=>J.transition(j,j.open[0].id,'CLOSED',{exit:{filledQty:0.001}}),e=>e.code==='unknown','unverified entry');
  assert.equal(j.open.length,1);assert.equal(j.history.length,0);
  j.open[0].fillVerified=true;
  const e=J.transition(j,j.open[0].id,'CLOSED',{exit:{filledQty:0.001,avgPrice:61000,feeUsd:0.5,proceedsUsd:60.5},pnlUsd:1.25,closedAt:123});
  assert.equal(e.status,'CLOSED');assert.equal(e.closedAt,123);assert.equal(j.history.length,1);assert.equal(j.open.length,0);
 }
});

test('open + history count invariant across a full lifecycle and history cap 200 newest-first',()=>{
 const j={...J.defaultJournal(),open:[],history:[]};
 for(let i=0;i<205;i++){
  const e=J.makeRealEntry({symbol:'BTC-USD',requestedQty:0.001,requestedUsd:60});
  j.open.push(e);
  const before=j.open.length+j.history.length;
  J.transition(j,e.id,'SUBMITTED',{orderId:`o${i}`});
  J.transition(j,e.id,'OPEN',{fillVerified:true,filledQty:0.001,avgPrice:60000,costUsd:60.5});
  J.transition(j,e.id,'CLOSING',{exit:{reason:'take',clientOrderId:'x',filledQty:0}});
  J.transition(j,e.id,'CLOSED',{exit:{reason:'take',filledQty:0.001,avgPrice:61000,feeUsd:0.5,proceedsUsd:60.5},pnlUsd:1,closedAt:1000+i});
  assert.equal(j.open.length+j.history.length,Math.min(before,200));
  assert.equal(j.history[0].id,e.id,'newest first');
 }
 assert.equal(j.open.length,0);assert.equal(j.history.length,200);
 assert.equal(j.history[0].closedAt,1204);assert.equal(j.history[199].closedAt,1005);
 assert.equal(J.normalizeJournal({history:Array(300).fill({status:'CLOSED'})}).history.length,200);
});

// ---------------------------------------------------------------- stats + P/L
test('recomputeStats counts only verified CLOSED rows, fees on both legs, unverified open rows',()=>{
 const j={...J.defaultJournal(),open:[entryAt('SUBMITTED_UNCERTAIN'),entryAt('OPEN'),entryAt('PENDING_SUBMIT')],history:[
  {status:'CLOSED',fillVerified:true,exit:{filledQty:0.001,feeUsd:0.5},feeUsd:0.5,pnlUsd:4},
  {status:'CLOSED',fillVerified:true,exit:{filledQty:0.001,feeUsd:0.25},feeUsd:0.25,pnlUsd:-1},
  {status:'CLOSED',fillVerified:true,exit:{filledQty:0.001,feeUsd:0.25},feeUsd:0.25,pnlUsd:-1},
  {status:'CLOSED',fillVerified:false,exit:{filledQty:0.001},pnlUsd:100},
  {status:'CLOSED',fillVerified:true,exit:{filledQty:0},pnlUsd:100},
  {status:'FORGOTTEN',fillVerified:true,exit:null,pnlUsd:null},
  {status:'REJECTED',pnlUsd:50},
 ]};
 J.recomputeStats(j);
 assert.equal(j.stats.closed,3);assert.equal(j.stats.won,1);assert.equal(j.stats.lost,2);
 assert.equal(j.stats.pnlUsd,2);assert.equal(j.stats.feesUsd,2);
 assert.equal(j.stats.hitRate,1/3);assert.equal(j.stats.profitFactor,2);
 assert.equal(j.stats.unverified,2);
 assert.equal(j.stats.placed,10);
 assert.deepEqual(Object.keys(j.stats),['placed','closed','won','lost','pnlUsd','feesUsd','hitRate','profitFactor','unverified']);
 const none=J.recomputeStats({...J.defaultJournal()});
 assert.equal(none.stats.hitRate,null);assert.equal(none.stats.profitFactor,null);
 const onlyWins=J.recomputeStats({...J.defaultJournal(),history:[{status:'CLOSED',fillVerified:true,exit:{filledQty:1},pnlUsd:2}]});
 assert.equal(onlyWins.stats.profitFactor,Infinity);
});

test('realizedTodayUsd uses local startOfDay and ignores FORGOTTEN null P/L',()=>{
 const now=new Date(2026,8,25,13,0,0,0).getTime();
 const sod=J.startOfDay(now);
 assert.equal(sod,new Date(2026,8,25,0,0,0,0).getTime());
 assert.equal(new Date(sod).getHours(),0);
 const j={...J.defaultJournal(),history:[
  {status:'CLOSED',closedAt:sod,pnlUsd:2.5},
  {status:'CLOSED',closedAt:now-60e3,pnlUsd:-4},
  {status:'CLOSED',closedAt:sod-1,pnlUsd:-100},
  {status:'FORGOTTEN',closedAt:now,pnlUsd:null},
 ]};
 assert.equal(J.realizedTodayUsd(j,now),-1.5);
 assert.equal(J.realizedTodayUsd(j,sod-1),-100);
});

test('cooldowns work on journal and paper alike',()=>{
 const now=1_000_000;
 for(const s of [J.defaultJournal(),J.defaultPaper()]){
  assert.equal(J.inCooldown(s,'BTC-USD',now),false);
  J.setCooldown(s,'btc-usd',now+5000);
  assert.equal(s.cooldowns['BTC-USD'],now+5000);
  assert.equal(J.inCooldown(s,'BTC-USD',now),true);
  assert.equal(J.inCooldown(s,'btc-usd',now+4999),true);
  assert.equal(J.inCooldown(s,'BTC-USD',now+5000),false);
  assert.equal(J.inCooldown(s,'ETH-USD',now),false);
 }
 const broken={cooldowns:null};
 J.setCooldown(broken,'BTC-USD',now+1);
 assert.equal(J.inCooldown(broken,'BTC-USD',now),true);
});

// ---------------------------------------------------------------- tape
test('appendTape dedupes on t, keeps ascending order, ring-caps at 720 and tapeFor returns the mid shape',()=>{
 const p=J.defaultPaper();
 J.appendTape(p,'btc-usd',{bid:100,ask:101,at:2000,quoteSource:'v2'});
 J.appendTape(p,'BTC-USD',{bid:99,ask:100,at:1000});
 J.appendTape(p,'BTC-USD',{bid:105,ask:106,at:2000});
 J.appendTape(p,'BTC-USD',{bid:0,ask:106,at:3000});
 J.appendTape(p,'BTC-USD',{bid:106,ask:NaN,at:3000});
 J.appendTape(p,'BTC-USD',{bid:110,ask:111,at:3000,quoteSource:'v1'});
 assert.deepEqual(p.tape['BTC-USD'].samples,[[1000,99,100],[2000,105,106],[3000,110,111]]);
 assert.equal(p.tape['BTC-USD'].quoteSource,'v1');
 assert.equal(p.tape['BTC-USD'].intervalMs,15000);
 assert.equal(p.tapeAt,3000);
 assert.deepEqual(J.tapeFor(p,'BTC-USD'),[{t:1000,bid:99,ask:100,mid:99.5},{t:2000,bid:105,ask:106,mid:105.5},{t:3000,bid:110,ask:111,mid:110.5}]);
 assert.deepEqual(J.tapeFor(p,'ETH-USD'),[]);
 assert.deepEqual(J.tapeFor({},'ETH-USD'),[]);
 J.appendTape(p,'bad symbol',{bid:1,ask:2,at:5});
 assert.equal(Object.keys(p.tape).length,1);
 for(let i=0;i<1000;i++)J.appendTape(p,'ETH-USD',{bid:10+i,ask:11+i,at:10_000+i*15_000});
 const s=p.tape['ETH-USD'].samples;
 assert.equal(s.length,720);
 assert.equal(s[0][0],10_000+280*15_000);
 assert.equal(s[719][0],10_000+999*15_000);
 for(let i=1;i<s.length;i++)assert.ok(s[i][0]>s[i-1][0]);
 J.appendTape(p,'SOL-USD',{bid:1,ask:2,at:1});J.appendTape(p,'SOL-USD',{bid:1,ask:2,at:2});J.appendTape(p,'SOL-USD',{bid:1,ask:2,at:3});
 J.appendTape(p,'SOL-USD',{bid:1,ask:2,at:4},2);
 assert.deepEqual(p.tape['SOL-USD'].samples.map(r=>r[0]),[3,4],'custom cap');
 const saved=J.normalizePaper(JSON.parse(JSON.stringify(p)));
 assert.equal(saved.tape['ETH-USD'].samples.length,720);
});

test('savePaper throttles unforced writes to 30 s but forced saves and cache updates land immediately',()=>{
 reset();
 const p=J.defaultPaper();
 p.cashUsd=500;
 J.savePaper(p,{force:true});
 assert.equal(JSON.parse(fs.readFileSync(J.PAPER_FILE,'utf8')).cashUsd,500);
 p.cashUsd=400;
 const cached=J.savePaper(p);
 assert.equal(cached.cashUsd,400,'cache refreshed');
 assert.equal(J.loadPaper().cashUsd,400);
 assert.equal(JSON.parse(fs.readFileSync(J.PAPER_FILE,'utf8')).cashUsd,500,'disk untouched inside the throttle window');
 p.cashUsd=300;
 J.savePaper(p,{force:true});
 assert.equal(JSON.parse(fs.readFileSync(J.PAPER_FILE,'utf8')).cashUsd,300);
 T.resetPaper();
 assert.equal(J.loadPaper().cashUsd,300);
 p.cashUsd=200;
 J.savePaper(p);
 assert.equal(JSON.parse(fs.readFileSync(J.PAPER_FILE,'utf8')).cashUsd,200,'first save after reset is not throttled');
 assert.deepEqual(tmpFiles(),[]);
});

test('paper history caps at 500 and positions keep only OPEN rows',()=>{
 const p=J.normalizePaper({history:Array(600).fill({status:'CLOSED'}),positions:[{status:'OPEN'},{status:'CLOSED'}]});
 assert.equal(p.history.length,500);assert.equal(p.positions.length,1);
});

// ---------------------------------------------------------------- qualification
test('qualificationThresholds reads env with defaults 20 / 0.45 / 1.3 / 30',()=>{
 assert.deepEqual(J.qualificationThresholds(),{minCloses:20,minHitRate:0.45,minProfitFactor:1.3,windowDays:30});
 process.env.ROBINHOOD_QUAL_MIN_CLOSES='5';process.env.ROBINHOOD_QUAL_MIN_HIT_RATE='0.6';process.env.ROBINHOOD_QUAL_MIN_PROFIT_FACTOR='2';process.env.ROBINHOOD_QUAL_WINDOW_DAYS='7';
 try{assert.deepEqual(J.qualificationThresholds(),{minCloses:5,minHitRate:0.6,minProfitFactor:2,windowDays:7})}
 finally{delete process.env.ROBINHOOD_QUAL_MIN_CLOSES;delete process.env.ROBINHOOD_QUAL_MIN_HIT_RATE;delete process.env.ROBINHOOD_QUAL_MIN_PROFIT_FACTOR;delete process.env.ROBINHOOD_QUAL_WINDOW_DAYS}
 process.env.ROBINHOOD_QUAL_MIN_CLOSES='-3';process.env.ROBINHOOD_QUAL_MIN_HIT_RATE='abc';
 try{assert.deepEqual(J.qualificationThresholds(),{minCloses:20,minHitRate:0.45,minProfitFactor:1.3,windowDays:30})}
 finally{delete process.env.ROBINHOOD_QUAL_MIN_CLOSES;delete process.env.ROBINHOOD_QUAL_MIN_HIT_RATE}
});

test('evaluateQualification: a clean paper record qualifies and carries the full shape',()=>{
 const now=Date.now();
 const p=makePaper([...winners(12),...losers(8)]);
 const q=J.evaluateQualification(p,now);
 assert.deepEqual(Object.keys(q),['qualified','paramsHash','closes','hitRate','profitFactor','pnlUsd','grossPnlUsd','feesUsd','feeDragPct','maxDrawdownUsd','requiredHitRate','lastCloseAt','windowDays','reasons','at']);
 assert.equal(q.qualified,true,JSON.stringify(q.reasons));
 assert.deepEqual(q.reasons,[]);
 assert.equal(q.closes,20);assert.equal(q.hitRate,0.6);assert.equal(q.profitFactor,36/8);
 assert.equal(q.pnlUsd,28);
 assert.equal(q.feesUsd,r2(20*1.05));
 assert.equal(q.grossPnlUsd,r2(28+21));
 assert.ok(Math.abs(q.feeDragPct-21/49)<1e-12);
 assert.equal(q.paramsHash,'abc123abc123');assert.equal(q.windowDays,30);assert.equal(q.at,now);
 assert.ok(q.lastCloseAt>=now-H-1&&q.lastCloseAt<=now);
 assert.ok(q.requiredHitRate>0.2&&q.requiredHitRate<0.5,`requiredHitRate ${q.requiredHitRate}`);
 assert.ok(q.maxDrawdownUsd>=0&&q.maxDrawdownUsd<=8);
 function r2(v){return Math.round(v*100)/100}
});

test('evaluateQualification filters: placedBy, closedBy, paramsHash, window, status',()=>{
 const now=Date.now();
 const good=winners(20);
 const base=J.evaluateQualification(makePaper(good),now);
 assert.equal(base.closes,20);
 const cases=[
  ['manual placement',{placedBy:'manual'}],
  ['manual close',{closedBy:'manual'}],
  ['other paramsHash',{paramsHash:'ffffffffffff'}],
  ['outside the window',{closedAt:now-31*D}],
  ['still open',{status:'OPEN'}],
 ];
 for(const [label,over] of cases){
  const q=J.evaluateQualification(makePaper([...good.slice(0,19),paperClose({...over,pnlUsd:3,...(over.closedAt?{}:{closedAt:now-H})})]),now);
  assert.equal(q.closes,19,label);
  assert.equal(q.qualified,false,label);
  assert.ok(q.reasons.some(r=>r.startsWith('closes 19 < 20')),label);
 }
 assert.equal(J.evaluateQualification(makePaper(good.map(x=>({...x,closedAt:now-29*D}))),now).closes,20,'inside the window counts');
 const changed=J.evaluateQualification(makePaper(good,{paramsHash:'new'}),now);
 assert.equal(changed.closes,0);assert.equal(changed.paramsHash,'new');
 assert.equal(J.evaluateQualification(makePaper(good),now,{windowDays:0.01}).closes,0,'threshold windowDays override');
});

test('evaluateQualification reasons: closes, hitRate, profitFactor, pnl, drawdown vs dailyLossCapUsd, stale, paperRecovery',()=>{
 const now=Date.now();
 const zero=J.evaluateQualification(makePaper([]),now);
 assert.deepEqual(zero.reasons,['closes 0 < 20']);
 assert.equal(zero.hitRate,null);assert.equal(zero.profitFactor,null);assert.equal(zero.feeDragPct,null);assert.equal(zero.requiredHitRate,null);assert.equal(zero.lastCloseAt,null);
 // 8 wins / 12 losses: hit 0.4 < 0.45; PF 24/12 = 2 ok; pnl 12 > 0
 const lowHit=J.evaluateQualification(makePaper([...winners(8),...losers(12)]),now);
 assert.ok(lowHit.reasons.some(r=>r.startsWith('hitRate 0.400 < 0.45')),JSON.stringify(lowHit.reasons));
 assert.equal(lowHit.reasons.some(r=>r.startsWith('profitFactor')),false);
 // 10 wins of +1 / 10 losses of -1: PF 1 < 1.3, pnl 0 <= 0, hit 0.5 ok
 const flat=J.evaluateQualification(makePaper([...winners(10,{pnlUsd:1}),...losers(10,{pnlUsd:-1})]),now);
 assert.ok(flat.reasons.some(r=>r.startsWith('profitFactor 1.00 < 1.3')),JSON.stringify(flat.reasons));
 assert.ok(flat.reasons.some(r=>r.startsWith('pnlUsd 0 <= 0')));
 assert.equal(flat.reasons.some(r=>r.startsWith('hitRate')),false);
 // all wins -> PF Infinity, never a PF reason
 const allWin=J.evaluateQualification(makePaper(winners(20)),now);
 assert.equal(allWin.profitFactor,Infinity);assert.equal(allWin.qualified,true,JSON.stringify(allWin.reasons));
 // drawdown: 12 wins first (oldest) then 8 losses of -10 in a row -> drawdown 80 > 50 default cap
 const ddRows=[...winners(12,{pnlUsd:20}).map((x,i)=>({...x,closedAt:now-D-H*i})),...losers(8,{pnlUsd:-10}).map((x,i)=>({...x,closedAt:now-H*(i+1)}))];
 const dd=J.evaluateQualification(makePaper(ddRows),now);
 assert.equal(dd.maxDrawdownUsd,80);
 assert.ok(dd.reasons.some(r=>r.startsWith('maxDrawdownUsd 80 > dailyLossCapUsd 50')),JSON.stringify(dd.reasons));
 assert.equal(J.evaluateQualification(makePaper(ddRows),now,undefined,{dailyLossCapUsd:100}).reasons.some(r=>r.startsWith('maxDrawdown')),false,'limits override');
 process.env.ROBINHOOD_DAILY_LOSS_CAP_USD='200';
 try{assert.equal(J.evaluateQualification(makePaper(ddRows),now).reasons.some(r=>r.startsWith('maxDrawdown')),false,'env cap')}
 finally{delete process.env.ROBINHOOD_DAILY_LOSS_CAP_USD}
 // stale: last close 73 h ago
 const stale=J.evaluateQualification(makePaper(winners(20).map((x,i)=>({...x,closedAt:now-73*H-H*i}))),now);
 assert.ok(stale.reasons.includes('stale'),JSON.stringify(stale.reasons));
 assert.equal(stale.reasons.length,1);
 const fresh=J.evaluateQualification(makePaper(winners(20).map((x,i)=>({...x,closedAt:now-71*H-H*i}))),now);
 assert.equal(fresh.reasons.includes('stale'),false);
 // paperRecovery
 const rec=J.evaluateQualification(makePaper(winners(20),{recoveryRequired:true}),now);
 assert.ok(rec.reasons.includes('paperRecovery'));assert.equal(rec.qualified,false);
 // env thresholds are honoured by default
 process.env.ROBINHOOD_QUAL_MIN_CLOSES='25';
 try{assert.ok(J.evaluateQualification(makePaper(winners(20)),now).reasons.some(r=>r.startsWith('closes 20 < 25')))}
 finally{delete process.env.ROBINHOOD_QUAL_MIN_CLOSES}
 assert.equal(J.evaluateQualification(makePaper(winners(20)),now,{minCloses:25}).qualified,false,'explicit thresholds');
});

test('requiredHitRate is the median of (stop + C)/(take + stop) across counted closes',()=>{
 const now=Date.now();
 const rows=[
  paperClose({closedAt:now-H,stopPct:0.01,takePct:0.04,costPct:0.01}),   // (0.01+0.01)/(0.05) = 0.4
  paperClose({closedAt:now-2*H,stopPct:0.02,takePct:0.02,costPct:0.02}), // 0.04/0.04 = 1
  paperClose({closedAt:now-3*H,stopPct:0.01,takePct:0.09,costPct:0.01}), // 0.02/0.10 = 0.2
 ];
 const q=J.evaluateQualification(makePaper(rows),now);
 assert.ok(Math.abs(q.requiredHitRate-0.4)<1e-12);
 const two=J.evaluateQualification(makePaper(rows.slice(0,2)),now);
 assert.ok(Math.abs(two.requiredHitRate-0.7)<1e-12);
});

// ---------------------------------------------------------------- separation of files
test('paper save cannot touch the real journal file and vice versa',()=>{
 reset();
 J.saveJournal({...J.defaultJournal(),open:[entryAt('OPEN')]});
 const before=fs.readFileSync(J.JOURNAL_FILE,'utf8');
 J.savePaper({...J.defaultPaper(),cashUsd:1},{force:true});
 assert.equal(fs.readFileSync(J.JOURNAL_FILE,'utf8'),before);
 const pBefore=fs.readFileSync(J.PAPER_FILE,'utf8');
 J.saveJournal(J.defaultJournal());
 assert.equal(fs.readFileSync(J.PAPER_FILE,'utf8'),pBefore);
 assert.deepEqual(fs.readdirSync(DIR).sort(),['robinhood-auto-trader.json','robinhood-paper.json']);
});
