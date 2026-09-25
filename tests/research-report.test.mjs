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

// The stale-purge gate used to regex the forensics prose for the literal "maxHold 25", which
// hardcoded the SPRINT preset. An applied evolution champion sets its own maxHold (index.js:312,
// bounded only by Math.max(1, ...)), so any champion not on 25 minutes failed the gate forever
// regardless of whether its stale-purges were explained. Read the structured boolean instead.
test('the stale-purge gate follows the champion maxHold, not a hardcoded 25', () => {
  const base = {
    cold: { pass: true, sentinelExcluded: true, chronological: { pass: true }, walkForward: { pass: true } },
    latency: { bottleneck: 'DISCOVERY', wait: 100, medians: { wait: 100 } },
    replay: {},
  };
  const forensicsWith = sp => ({
    n: 247, negativeMedian: true,
    overall: { medianReturnPct: -2.8, medianGrossReturnPct: 0.1 },
    stalePurge: sp, verdict: { frictionFlip: true, dominantLossReason: 'stop-loss' },
  });
  const gateOf = r => r.gates.find(g => g.id === 'forensics-stale-purge-maxhold');

  // a champion on a 2-minute hold whose closes DO match it: explained, so the gate holds
  const ok = assembleMemeAlphaReport({ ...base, forensics: forensicsWith({
    n: 124, matchesMaxHold: true, maxHoldMin: 2, maxHoldSource: 'champion C-1',
    cause: 'maxHold 2-min timer (champion C-1)' }) });
  assert.equal(gateOf(ok).ok, true, 'a 2-minute champion timer is a valid explanation');

  // closes that do NOT match the configured hold are genuinely unexplained
  const bad = assembleMemeAlphaReport({ ...base, forensics: forensicsWith({
    n: 124, matchesMaxHold: false, maxHoldMin: 25, maxHoldSource: 'preset sprint',
    cause: 'hold time 2.1 min does not match maxHold 25 (preset sprint)' }) });
  assert.equal(gateOf(bad).ok, false, 'an unexplained hold time must still fail');

  // a report written before matchesMaxHold existed still parses via the prose fallback
  const legacy = assembleMemeAlphaReport({ ...base, forensics: forensicsWith({
    n: 229, cause: 'SPRINT maxHold 25-min timer' }) });
  assert.equal(gateOf(legacy).ok, true, 'older forensics files must not regress');
});
