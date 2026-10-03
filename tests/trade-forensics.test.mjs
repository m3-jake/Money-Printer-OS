import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {diagnoseCloses,diagnoseStalePurge,cohortStats,effectiveMaxHold} from '../tools/tradeForensics.js';

function trade(i,{reason='stop-loss',ret=-8,pnl=-0.001,hold=2,liq=40000,mfe=0,mae=-6}={}){
  const opened=1_000_000+i*60_000;
  return {
    strategy:'UNIFIED_EDGE',reason,returnPct:ret,pnlSol:pnl,feesSol:0.0002,
    entrySlippageBps:80,exitSlippageBps:80,lastLiquidityUsd:liq,
    maxFavorablePct:mfe,maxAdversePct:mae,openedAt:opened,closedAt:opened+hold*60_000,
    entryPrice:1,lastPrice:1+ret/100,exitPrice:1+ret/100,
  };
}

test('negative-median 1500-close diagnosis and stale-purge timer cause',()=>{
  const history=[];
  for(let i=0;i<670;i++)history.push(trade(i,{reason:'take-profit-1',ret:5.2,pnl:0.002,hold:1.3,mfe:6.6,mae:-0.8,liq:39000}));
  for(let i=0;i<586;i++)history.push(trade(1000+i,{reason:'stop-loss',ret:-8.1,pnl:-0.005,hold:1.6,mfe:0,mae:-6.9,liq:43000}));
  for(let i=0;i<229;i++)history.push(trade(2000+i,{reason:'stale-purge',ret:-2.24,pnl:-0.0016,hold:25.03,mfe:0.13,mae:-2.01,liq:512000}));
  for(let i=0;i<15;i++)history.push(trade(3000+i,{reason:'break-even',ret:0,pnl:-0.0002,hold:4,liq:20000}));
  const d=diagnoseCloses(history,{profile:'SPRINT'});
  assert.equal(d.n,1500);
  assert.equal(d.negativeMedian,true);
  assert.ok(d.overall.medianReturnPct<0);
  assert.equal(d.reasons['stale-purge'].n,229);
  assert.equal(d.stalePurge.n,229);
  assert.match(d.stalePurge.cause,/maxHold 25/);
  assert.ok(d.stalePurge.medianHoldMin>24&&d.stalePurge.medianHoldMin<26);
  assert.equal(d.verdict.dominantLossReason,'stop-loss');
});

test('friction flip is detected when gross median is non-negative and net is negative',()=>{
  const history=Array.from({length:7},(_,i)=>{
    const t=trade(i,{reason:'stop-loss',ret:-1.4,pnl:-0.001,hold:2});
    t.lastPrice=1.0014;
    t.returnPct=-1.4;
    return t;
  });
  const d=diagnoseCloses(history,{profile:'SPRINT'});
  assert.equal(d.verdict.frictionFlip,true);
  assert.equal(d.negativeMedian,true);
});

test('stale-purge helper is deterministic',()=>{
  const xs=Array.from({length:10},(_,i)=>trade(i,{reason:'stale-purge',hold:25,ret:-2}));
  assert.deepEqual(diagnoseStalePurge(xs),diagnoseStalePurge(xs));
  assert.equal(cohortStats(xs).n,10);
});

test('CLI refuses to write into the app data directory and import fence holds',()=>{
  const src=fs.readFileSync(new URL('../tools/tradeForensics.js',import.meta.url),'utf8').toLowerCase();
  for(const bad of ['jupiter','./rpc','polymarket','from \'ws\'','from \'./store','from \'./index'])assert.equal(src.includes(bad),false,`forbidden ${bad}`);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-forensics-'));
  try{
    const state=path.join(dir,'state.json');
    fs.writeFileSync(state,JSON.stringify({runtime:{profile:'SPRINT'},history:[trade(0,{reason:'stale-purge',hold:25,ret:-2})]}));
    const out=path.join(dir,'out.json');
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('../tools/tradeForensics.js',import.meta.url)),'--state',state,'--out',out],{encoding:'utf8',timeout:10000});
    assert.equal(child.status,0,child.stderr);
    const report=JSON.parse(fs.readFileSync(out,'utf8'));
    assert.equal(report.stalePurge.n,1);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

// index.js:312 takes maxHold from the applied evolution champion, whose only bound in
// learner.js is Math.max(1, ...). diagnoseStalePurge used to compare every run against a
// hardcoded 25, so a champion on a 2-minute hold reported "hold time does not match SPRINT
// maxHold 25" forever - and researchReport.js gates on that string, so the gate was useless.
test('stale-purge is judged against the maxHold actually in force', () => {
  const xs = Array.from({ length: 6 }, (_, i) => trade(i, { reason: 'stale-purge', ret: 12, pnl: 0.01, hold: 2 }));

  const wrong = diagnoseStalePurge(xs);                                   // legacy default of 25
  assert.equal(wrong.matchesMaxHold, false);
  assert.match(wrong.cause, /does not match maxHold 25/);

  const right = diagnoseStalePurge(xs, { maxHoldMin: 2, maxHoldSource: 'champion X-1' });
  assert.equal(right.matchesMaxHold, true, 'a 2-minute hold matches a 2-minute maxHold');
  assert.match(right.cause, /maxHold 2-min timer \(champion X-1\)/);
});

test('effectiveMaxHold prefers the applied champion, then the preset, then the default', () => {
  const champ = { id: 'C-9', variant: { maxHoldMin: 2 } };

  assert.deepEqual(
    effectiveMaxHold({ evolutionLoop: { champion: champ }, runtime: { activeEvolutionChampionId: 'C-9', exitPreset: 'yolo' } }),
    { maxHoldMin: 2, maxHoldSource: 'champion C-9' });

  // a champion that exists but is NOT the applied one must not be used
  assert.deepEqual(
    effectiveMaxHold({ evolutionLoop: { champion: champ }, runtime: { activeEvolutionChampionId: null, exitPreset: 'sprint' } }),
    { maxHoldMin: 25, maxHoldSource: 'preset sprint' });

  assert.deepEqual(effectiveMaxHold({ runtime: { exitPreset: 'yolo' } }), { maxHoldMin: 360, maxHoldSource: 'preset yolo' });
  assert.deepEqual(effectiveMaxHold({}), { maxHoldMin: 25, maxHoldSource: 'default' });
});
