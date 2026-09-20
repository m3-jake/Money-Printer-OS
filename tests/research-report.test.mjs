import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assembleMemeAlphaReport,markdownReport} from '../src/researchReport.js';

test('integrity can pass while the COLD lead fails, and challengers cannot self-promote',()=>{
  const cold={
    chronological:{
      pass:false,fail:['no-positive-delta'],sentinelLiquidity:4000,rawN:4800,n:350,subEconomicLiquidity:70,
      criteria:{sentinelLiquidityExcluded:true},
      overall:{cut:40000,nHi:80,nLo:60,delta:-2,medianDelta:-1,topMedian:-3,restMedian:-2,ciLow:-5,contaminated:false,topExpectancy:-1,topProfitFactor:.8,topDrawdown:10,top3ConcentrationPct:12,friction:{dragPct:3}},
    },
    walkForward:{pass:false,fail:['split-inconsistent']},
  };
  const forensics={
    n:1500,negativeMedian:true,
    overall:{medianReturnPct:-1.4,medianGrossReturnPct:0.14,expectancy:-0.0006,profitFactor:0.67},
    stalePurge:{n:229,cause:'SPRINT maxHold 25-min timer'},
    verdict:{dominantLossReason:'stop-loss',frictionFlip:true,stalePurgeCause:'SPRINT maxHold 25-min timer'},
  };
  const latency={latency24h:{
    samples:80,bottleneck:'DISCOVERY',wait:69,discovery:94000,
    means:{proposal:500000},medians:{proposal:95000,wait:69,discovery:94000},
    proposalDiagnosis:{pass:true,cause:'proposal_ms is source-event-to-proposal (includes discovery); ~500s mean is outlier-inflated end-to-end, not proposal-stage queue',bottleneck:'DISCOVERY'},
  }};
  const replay={
    dataset:{events:10,hash:'abc'},
    results:[
      {config:'FAST',params:{promotable:undefined},promotable:null,metrics:{n:51,realizedPnl:-0.05,medianReturnPct:-5,expectancy:-0.001,profitFactor:0.3,maxDrawdownPct:6,top3PnlConcentrationPct:13},gate:{live:false,reason:'no-positive-edge',eligible:false}},
      {config:'COLD_TOPQ',params:{promotable:false},promotable:false,metrics:{n:14,realizedPnl:-0.01,medianReturnPct:-8,expectancy:-0.001,profitFactor:0.4,maxDrawdownPct:1,top3PnlConcentrationPct:15},gate:{live:false,reason:'not-promotable',eligible:false}},
    ],
  };
  const a=assembleMemeAlphaReport({cold,forensics,latency,replay});
  const b=assembleMemeAlphaReport({cold,forensics,latency,replay});
  assert.deepEqual(a,b);
  assert.equal(a.integrityPass,true);
  assert.equal(a.leadPass,false);
  assert.equal(a.pass,true);
  assert.ok(a.fail.includes('cold-lead'));
  assert.equal(a.gates.find(g=>g.id==='replay-challengers-not-promotable').ok,true);
  const md=markdownReport(a);
  assert.match(md,/Integrity: \*\*PASS\*\*/);
  assert.match(md,/COLD lead: \*\*FAIL\*\*/);
  assert.match(md,/not-promotable/);
});

test('winning metrics cannot mark a challenger promotable in the assembled report',()=>{
  const r=assembleMemeAlphaReport({
    cold:{chronological:{pass:true,fail:[],sentinelLiquidity:0,rawN:100,n:100,criteria:{sentinelLiquidityExcluded:true}},walkForward:{pass:true,fail:[]}},
    forensics:{n:1500,negativeMedian:true,overall:{medianReturnPct:-1,medianGrossReturnPct:0.1},stalePurge:{n:2,cause:'SPRINT maxHold 25-min timer'},verdict:{frictionFlip:true}},
    latency:{latency24h:{samples:20,bottleneck:'DISCOVERY',wait:10,medians:{wait:10,proposal:90,discovery:90},means:{proposal:400000},proposalDiagnosis:{pass:true,cause:'x'}}},
    replay:{results:[{config:'COLD_TOPQ',params:{promotable:false},promotable:false,metrics:{n:200,realizedPnl:9,expectancy:1,profitFactor:3,maxDrawdownPct:1,top3PnlConcentrationPct:10},gate:{live:false,eligible:false,reason:'not-promotable'}}]},
  });
  assert.equal(r.gates.find(g=>g.id==='replay-challengers-not-promotable').ok,true);
  assert.equal(r.replay.configs[0].promotable,false);
});

test('CLI refuses app-data writes and import fence holds',()=>{
  const src=fs.readFileSync(new URL('../src/researchReport.js',import.meta.url),'utf8').toLowerCase();
  for(const bad of ['jupiter','./rpc','polymarket','from \'ws\'','from \'./store','from \'./index'])assert.equal(src.includes(bad),false,`forbidden ${bad}`);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-report-'));
  try{
    const cold=path.join(dir,'cold.json');
    fs.writeFileSync(cold,JSON.stringify({chronological:{pass:false,fail:['no-positive-delta'],sentinelLiquidity:1,rawN:2,n:1,criteria:{sentinelLiquidityExcluded:true}},walkForward:{pass:false,fail:[]}}));
    const out=path.join(dir,'out.json');
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('../src/researchReport.js',import.meta.url)),'--cold',cold,'--out',out],{encoding:'utf8',timeout:10000});
    assert.equal(child.status,0,child.stderr);
    assert.equal(JSON.parse(fs.readFileSync(out,'utf8')).version,1);
    assert.equal(fs.existsSync(out.replace(/\.json$/,'.md')),true);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
