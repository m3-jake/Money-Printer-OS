// Durable price tape (docs/ROBINHOOD-AUTO-TRADER.md §22): buffered NDJSON append, dedupe, rotation to 45 days, load/coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-rh-tape-'));
process.env.MONEY_PRINTER_DATA_DIR=path.join(root,'data');
const T=await import('../src/robinhoodTape.js');
const DAY=864e5,t0=1700000000000;
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
function reset(){T.__testing.reset();fs.rmSync(T.TAPE_DIR,{recursive:true,force:true})}

test('tape dir lives under MONEY_PRINTER_DATA_DIR and constants match the contract',()=>{
 assert.equal(path.dirname(T.TAPE_DIR),process.env.MONEY_PRINTER_DATA_DIR);assert.equal(path.basename(T.TAPE_DIR),'robinhood-tape');
 assert.equal(T.TAPE_FLUSH_MS,30000);assert.equal(T.TAPE_KEEP_DAYS,45);assert.equal(T.tapeFile('btc-usd'),path.join(T.TAPE_DIR,'BTC-USD.ndjson'));
});
test('buffer rejects malformed, crossed and repeated samples and touches no disk until flush',()=>{
 reset();
 assert.equal(T.bufferTape('BTC-USD',{t:t0,bid:100,ask:100.1}),true);
 assert.equal(T.bufferTape('BTC-USD',{t:t0,bid:101,ask:101.1}),false,'same timestamp is a repeat');
 assert.equal(T.bufferTape('BTC-USD',{t:t0-1,bid:101,ask:101.1}),false,'older than the last row');
 assert.equal(T.bufferTape('BTC-USD',{t:t0+15000,bid:100,ask:99}),false,'crossed');
 assert.equal(T.bufferTape('AAPL',{t:t0+15000,bid:100,ask:101}),false,'not a crypto USD pair');
 assert.equal(T.bufferTape('BTC-USD',{t:t0+15000,bid:0,ask:1}),false);
 assert.equal(T.bufferTape('BTC-USD',{t:t0+15000,bid:100.2,ask:100.3}),true);
 assert.equal(T.pendingTapeRows(),2);assert.equal(fs.existsSync(T.TAPE_DIR),false);
 assert.equal(T.loadTape('BTC-USD').length,2,'unflushed rows are visible to loadTape');
});
test('flush is throttled to 30 s unless forced, appends NDJSON and reports fs errors instead of throwing',()=>{
 reset();T.bufferTape('BTC-USD',{t:t0,bid:100,ask:100.1});
 let r=T.flushTape({now:t0});assert.equal(r.flushed,1);
 T.bufferTape('BTC-USD',{t:t0+15000,bid:100,ask:100.1});
 r=T.flushTape({now:t0+10000});assert.equal(r.skipped,true);assert.equal(T.pendingTapeRows(),1);
 r=T.flushTape({now:t0+10000,force:true});assert.equal(r.flushed,1);assert.equal(T.pendingTapeRows(),0);
 const lines=fs.readFileSync(T.tapeFile('BTC-USD'),'utf8').trim().split('\n');assert.equal(lines.length,2);assert.deepEqual(JSON.parse(lines[0]),{t:t0,bid:100,ask:100.1});
 const original=fs.appendFileSync;T.bufferTape('BTC-USD',{t:t0+30000,bid:100,ask:100.1});
 try{fs.appendFileSync=()=>{throw new Error('disk full')};r=T.flushTape({now:t0+60000,force:true});assert.equal(r.flushed,0);assert.match(r.error.message,/disk full/);assert.equal(T.pendingTapeRows(),1,'rows stay buffered after a failed write')}
 finally{fs.appendFileSync=original}
 r=T.flushTape({now:t0+90000,force:true});assert.equal(r.flushed,1);assert.equal(r.error,null);assert.equal(T.tapeStatus().flushedRows,3);
});
test('loadTape sorts, dedupes, filters by sinceMs and adds mid; coverage reports days',()=>{
 reset();fs.mkdirSync(T.TAPE_DIR,{recursive:true});
 const rows=[{t:t0+30000,bid:102,ask:102.1},{t:t0,bid:100,ask:100.1},'garbage',{t:t0,bid:100.5,ask:100.6},{t:t0+15000,bid:101,ask:101.1},{t:t0+45000,bid:5,ask:4}];
 fs.writeFileSync(T.tapeFile('ETH-USD'),rows.map(r=>typeof r==='string'?r:JSON.stringify(r)).join('\n')+'\n');
 const all=T.loadTape('ETH-USD');assert.deepEqual(all.map(r=>r.t),[t0,t0+15000,t0+30000]);assert.equal(all[0].bid,100.5,'last duplicate wins');assert.equal(all[1].mid,101.05);
 assert.deepEqual(T.loadTape('ETH-USD',t0+15000).map(r=>r.t),[t0+15000,t0+30000]);assert.deepEqual(T.loadTape('SOL-USD'),[]);
 const c=T.tapeCoverage('ETH-USD');assert.equal(c.rows,3);assert.equal(c.firstAt,t0);assert.equal(c.lastAt,t0+30000);assert.ok(c.days>0&&c.days<0.001);
 assert.deepEqual(T.tapeCoverage('SOL-USD'),{symbol:'SOL-USD',rows:0,firstAt:null,lastAt:null,days:0,sources:{}});assert.deepEqual(T.listTapeSymbols(),['ETH-USD']);
});
test('compaction keeps only the newest 45 days and runs from flush at most every 6 hours',()=>{
 reset();fs.mkdirSync(T.TAPE_DIR,{recursive:true});
 const now=t0+100*DAY,rows=[];for(let d=0;d<=60;d++)rows.push({t:now-d*DAY,bid:100+d,ask:100.1+d});
 fs.writeFileSync(T.tapeFile('BTC-USD'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const c=T.compactTape('BTC-USD',{now});assert.equal(c.rows,46);assert.equal(c.dropped,15);
 const kept=T.loadTape('BTC-USD');assert.equal(kept.length,46);assert.ok(kept[0].t>=now-45*DAY);assert.equal(kept[kept.length-1].t,now);
 assert.equal(fs.readdirSync(T.TAPE_DIR).filter(n=>n.endsWith('.tmp')).length,0,'no tmp left behind');
 fs.appendFileSync(T.tapeFile('BTC-USD'),JSON.stringify({t:now-70*DAY,bid:1,ask:1.1})+'\n');
 T.bufferTape('ETH-USD',{t:now,bid:10,ask:10.1});T.flushTape({now,force:true});
 assert.equal(T.loadTape('BTC-USD').length,46,'the first flush compacts every symbol file');
 fs.appendFileSync(T.tapeFile('BTC-USD'),JSON.stringify({t:now-70*DAY,bid:1,ask:1.1})+'\n');
 T.bufferTape('ETH-USD',{t:now+60000,bid:10,ask:10.1});T.flushTape({now:now+3600e3,force:true});
 assert.equal(T.loadTape('BTC-USD').length,47,'no compaction inside the 6 h window');
 T.bufferTape('ETH-USD',{t:now+120000,bid:10,ask:10.1});T.flushTape({now:now+7*3600e3,force:true});
 assert.equal(T.loadTape('BTC-USD').length,45,'compacted again 7 h later; the 45-day-old row aged out');assert.equal(T.tapeStatus().lastCompactAt,now+7*3600e3);
});
test('rows carry their quote source; unknown or malformed sources read back as null and are counted',()=>{
 T.__testing.reset();fs.rmSync(T.TAPE_DIR,{recursive:true,force:true});const t0=1_800_000_000_000;
 assert.equal(T.bufferTape('BTC-USD',{t:t0,bid:100,ask:101,src:'robinhood'}),true);
 assert.equal(T.bufferTape('BTC-USD',{t:t0+15000,bid:100,ask:101,src:'coinbase-public-paper'}),true);
 assert.equal(T.bufferTape('BTC-USD',{t:t0+30000,bid:100,ask:101,src:'<script>'}),true);
 T.flushTape({force:true,now:t0+30000});
 fs.appendFileSync(T.tapeFile('BTC-USD'),JSON.stringify({t:t0+45000,bid:100,ask:101})+'\n');
 assert.deepEqual(T.loadTape('BTC-USD').map(r=>r.src),['robinhood','coinbase-public-paper',null,null]);
 assert.deepEqual(T.tapeCoverage('BTC-USD').sources,{robinhood:1,'coinbase-public-paper':1,unknown:2});
});
