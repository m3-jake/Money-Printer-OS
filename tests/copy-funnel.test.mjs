import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyBookFunnel, readCopyFunnel,handleCopyFunnelRequest } from '../src/copyFunnel.js';
import { LeaderDiscovery } from '../src/leaderDiscovery.js';

test('funnel counts a completed follower position once across partial exit slices', () => {
  const out = copyBookFunnel({follows:[],open:[{id:'still-open'}],history:[{id:'slice-a',parentPositionId:'done',pnlUsd:-2},{id:'slice-b',parentPositionId:'done',pnlUsd:1},{id:'slice-c',parentPositionId:'still-open',pnlUsd:2}],decisions:[{reason:'depth'},{reason:'depth'}],drawdownPause:{active:true}}, {platform:'polymarket-global',catalogue:{candidates:[],observed:20,rejected:5}});
  assert.equal(out.funnel.copied,2);assert.equal(out.funnel.exited,1);assert.equal(out.funnel.evaluated,1);
  assert.equal(out.afterCost.netPnl,1);assert.equal(out.afterCost.qualified,false);assert.equal(out.paused,true);assert.equal(out.reasons.depth,2);
});
test('missing/malformed book remains unavailable with a visible error and is never rewritten', () => {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-funnel-'));
  try { const file=path.join(dataDir,'polymarket-copy-paper.json');fs.writeFileSync(file,'broken');const r=readCopyFunnel({dataDir});assert.equal(r.books.length,0);assert.equal(r.errors.length,1);assert.equal(fs.readFileSync(file,'utf8'),'broken'); }
  finally {fs.rmSync(dataDir,{recursive:true,force:true});}
});
test('candidate first observation survives removal, rediscovery and process restart', async () => {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-member-')); let at=10000,include=true;
  const wallet='0x'+'a'.repeat(40),fetchImpl=async()=>Response.json(include?[{proxyWallet:wallet,pnl:100,vol:1000}]:[]);
  try {let discovery=new LeaderDiscovery({dataDir,fetchImpl,now:()=>at});await discovery.run();include=false;at=20000;await discovery.run();
    discovery=new LeaderDiscovery({dataDir,fetchImpl,now:()=>at});include=true;at=30000;const out=await discovery.run();assert.equal(out.candidates[0].firstObservedAt,10000);assert.equal(out.membership[wallet].observations,2);
  } finally {fs.rmSync(dataDir,{recursive:true,force:true});}
});

test('unknown partial outcomes cannot claim completed evaluation or zero measured profit',()=>{
 const out=copyBookFunnel({follows:[],open:[],history:[{id:'a',parentPositionId:'p',pnlUsd:2},{id:'b',parentPositionId:'p',pnlUsd:null}]},{platform:'polymarket-global'});
 assert.equal(out.funnel.exited,1);assert.equal(out.funnel.evaluated,0);assert.equal(out.afterCost.unknownPnlSlices,1);
 assert.equal(copyBookFunnel({history:[{id:'unknown'}]},{platform:'polymarket-global'}).afterCost.netPnl,null);
});

test('copy funnel exposes every stored scorecard wallet through bounded paging and explicit coverage',async()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-copy-pages-'));
 try{const wallets=Array.from({length:81},(_,i)=>({wallet:`wallet-${i}`}));
  fs.writeFileSync(path.join(dataDir,'wallet-scorecard.json'),JSON.stringify({asOf:1000,summary:{wallets:81},wallets}));
  let out;const ctx={dataDir,json:(_res,value)=>{out=value}};
  await handleCopyFunnelRequest({},null,new URL('http://localhost/api/copy-funnel?walletOffset=75&walletLimit=10'),ctx);
  assert.equal(out.walletDirectory.persisted,81);assert.equal(out.walletDirectory.returned,6);assert.equal(out.walletDirectory.wallets[5].wallet,'wallet-80');
  fs.writeFileSync(path.join(dataDir,'wallet-scorecard.json'),'bad');
  await handleCopyFunnelRequest({},null,new URL('http://localhost/api/copy-funnel?walletOffset=0&walletLimit=500'),ctx);
  assert.equal(out.walletDirectory.persisted,81,'page changes reuse bounded cache rather than rescanning all books');assert.equal(out.walletDirectory.limit,200);
 }finally{fs.rmSync(dataDir,{recursive:true,force:true});}
});

