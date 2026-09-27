import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {lateGameEstimate as estimate,comboCapacity} from '../src/sportsTiming.js';
test('early baseball never matches overtime or a late generic clock',()=>{
 for(const period of ['Bot 1st','Bot 3rd','Bottom 7th','Top 8th'])assert.equal(estimate({event:'MLB baseball'},{period,elapsed:'95',score:'4-1'}).nearEndScore,0);
 assert.equal(estimate({event:'MLB baseball'},{period:'Bot 9th'}).etaMinutes,15);
 assert.equal(estimate({event:'MLB baseball'},{period:'End 9'}).nearEndScore,0);
});
test('late clock is specific to the sport and market',()=>{
 assert.equal(estimate({},{period:'2H',elapsed:'61'}).nearEndScore,0);
 assert.equal(estimate({},{period:'2H',elapsed:'88'}).etaMinutes,12);
 assert.equal(estimate({},{period:'Q4',elapsed:'11:30'}).nearEndScore,0);
 assert.ok(estimate({},{period:'Q4',elapsed:'02:30'}).etaMinutes<=15);
 assert.equal(estimate({},{period:'1H',elapsed:'44'}).nearEndScore,0);
 assert.ok(estimate({type:'first_half_totals'},{period:'1H',elapsed:'44'}).etaMinutes<=15);
 assert.equal(estimate({event:'CS2'},{period:'3/3',elapsed:'90'}).nearEndScore,0);
});
test('closing tennis and table tennis outrank long or unknown matches',()=>{
 assert.equal(estimate({event:'WTA tennis'},{period:'Set 1',score:'5-2'}).nearEndScore,0);
 assert.equal(estimate({event:'WTA tennis'},{period:'Set 3',score:'1-0'}).nearEndScore,0);
 assert.equal(estimate({event:'WTA tennis'},{period:'Set 3',score:'5-3'}).etaMinutes,12);
 assert.equal(estimate({event:'Table tennis BO5'},{period:'Set 5',score:'9-7'}).etaMinutes,5);
 assert.equal(estimate({event:'Table tennis BO5'},{period:'Set 2',score:'9-7'}).nearEndScore,0);
 assert.equal(estimate({event:'WTA tennis'},{period:'Set 2',score:'6-3,5-2'}).etaMinutes,12);
 assert.equal(estimate({event:'WTA tennis'},{period:'Set 2',score:'3-6,5-2'}).nearEndScore,0);
});
test('combo slots depend on settled profits and current bankroll, not deposits or stale wins',()=>{
 const won=(pnl,at=2)=>({status:'WON',pnlUsd:pnl,settledAt:at,settlementSource:'gamma-market'});
 const p={startUsd:25,cashUsd:25,positions:[],createdAt:1,history:[]};
 assert.equal(comboCapacity(p).comboLimit,1);
 assert.equal(comboCapacity({...p,cashUsd:100}).comboLimit,1);
 assert.equal(comboCapacity({...p,cashUsd:26,history:[won(1)]}).comboLimit,2);
 assert.equal(comboCapacity({...p,cashUsd:30,history:[won(2),won(3)]}).comboLimit,3);
 assert.equal(comboCapacity({...p,cashUsd:25,history:[won(2),won(3)]}).comboLimit,1);
 assert.equal(comboCapacity({...p,cashUsd:30,lastAutoResetAt:10,history:[won(2),won(3)]}).comboLimit,1);
 assert.equal(comboCapacity({...p,cashUsd:30,history:[{status:'WON',pnlUsd:2,settledAt:2,settlementSource:'early-exit'}]}).comboLimit,1);
});
test('baseline autopilot requires calibrated positive EV while paper exploration can bootstrap earned combo slots',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-turnover-')),savedFetch=globalThis.fetch;
 process.env.MONEY_PRINTER_DATA_DIR=dir;process.env.POLYMARKET_AUTOSTART='false';
 const events=Array.from({length:8},(_,i)=>({id:'e'+i,gameId:'g'+i,title:'Soccer '+i,live:true,ended:false,period:i===7?'Bot 3rd':'2H',elapsed:i===7?'95':'90',score:'2-0',sport:{sport:i===7?'mlb':'soccer'},markets:[{id:'m'+i,sportsMarketType:'moneyline',outcomes:['Yes','No'],outcomePrices:[.9,.1],clobTokenIds:['t'+i,'n'+i],bestAsk:.9,bestBid:.89,liquidity:10000,acceptingOrders:true}]}));
 globalThis.fetch=async(url,options={})=>{
  const u=new URL(url);
  if(u.pathname==='/events')return Response.json(events);
  if(u.pathname==='/books')return Response.json(JSON.parse(options.body).map(x=>({asset_id:x.token_id,asks:[{price:'.9',size:'1000'}],bids:[{price:'.89',size:'1000'}]})));
  if(u.pathname==='/markets')return Response.json(u.searchParams.getAll('id').map(id=>({id,closed:false,outcomes:['Yes','No'],outcomePrices:[.9,.1]})));
  throw Error('Unexpected test request '+url);
 };
 const api=await import('../src/polymarket.js');
 const file=path.join(dir,'polymarket-paper.json');
 const read=()=>JSON.parse(fs.readFileSync(file,'utf8'));
 const calibration=(pnl=.05)=>Array.from({length:20},(_,i)=>({id:'cal'+i,kind:'single',status:'WON',stakeUsd:1,pnlUsd:pnl,createdAt:Date.now()-100000-i*1000,settledAt:Date.now()-50000-i*1000,settlementSource:'gamma-market',potentialPayoutUsd:1.1,legs:[{result:'won',price:.9,fillPrice:.9,feesEnabled:false}]}));
 try{
  api.resetPolymarketPaper(25);api.setAutopilot({mode:'combos',bootstrapExploration:false});
  let r=await api.runAutopilotOnce();assert.equal(r.placed,0);assert.ok(r.skipped.some(x=>x.reason==='ev-uncalibrated'));
  api.setAutopilot({bootstrapExploration:true});
  r=await api.runAutopilotOnce();assert.equal(r.placed,1,'explicit PAPER exploration may bootstrap calibration evidence');
  let s=read();assert.equal(s.positions[0].legs.length,2);assert.equal(s.autopilot.bootstrapExploration,true);
  api.resetPolymarketPaper(25);api.setAutopilot({mode:'combos',bootstrapExploration:false});
  s=read();s.createdAt=Date.now()-300000;s.history=calibration(.15);s.cashUsd=25;fs.writeFileSync(file,JSON.stringify(s));
  r=await api.runAutopilotOnce();assert.equal(r.placed,1);
  assert.equal((await api.runAutopilotOnce()).placed,0);
  s=read();assert.equal(s.positions.length,1);assert.equal(s.positions[0].legs.length,2);assert.ok(s.positions[0].research.expectedRoi>0);
  s.cashUsd=23.5;fs.writeFileSync(file,JSON.stringify(s));
  assert.equal((await api.runAutopilotOnce()).placed,1);
  s=read();s.cashUsd=25;s.history=calibration(.30);fs.writeFileSync(file,JSON.stringify(s));
  assert.equal((await api.runAutopilotOnce()).placed,1);
  s=read();assert.equal(s.positions.length,3);
  const games=s.positions.flatMap(p=>p.legs.map(l=>l.gameId));assert.equal(new Set(games).size,6);assert.ok(!games.includes('g7'));
  assert.equal((await api.runAutopilotOnce()).placed,0);
  api.resetPolymarketPaper(25);api.setAutopilot({mode:'combos',maxOpenPct:1});
  s=read();s.createdAt=Date.now()-300000;s.history=calibration(.15);fs.writeFileSync(file,JSON.stringify(s));
  assert.equal((await api.runAutopilotOnce()).placed,0);
 }finally{api.stopPolymarketLoops();globalThis.fetch=savedFetch;fs.rmSync(dir,{recursive:true,force:true})}
});
