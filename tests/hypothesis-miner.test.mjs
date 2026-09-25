import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-miner-'));
process.env.MONEY_PRINTER_DATA_DIR=root;

const {alphaDb,closeAlphaDb,insertObservation,insertOutcome,insertLatency,updateLatencyStage} = await import('../src/alphaDb.js');
const {mineHypotheses,featureValueOf,observationClusterOf,OUTCOME_FEATURE_SQL} = await import('../src/hypothesisMiner.js');
const {latencyDiagnosis,isImpossibleOutcome,clampAdjustedReturn} = await import('../src/edgeProof.js');

function hash(s=''){let h=2166136261;for(const c of String(s)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}
function holdoutMint(prefix,n){
  const ids=[];
  for(let i=0;ids.length<n;i++){const m=`${prefix}${i}`;if(hash(m)%5===0)ids.push(m)}
  return ids;
}

test('featureValueOf uses entry liquidity, not first-obs zero',()=>{
  assert.equal(featureValueOf({liquidity:12345,obs_liquidity:0},'liquidity'),12345);
  assert.ok(Number.isFinite(featureValueOf({explosion:8},'explosion')));
  assert.ok(Number.isNaN(featureValueOf({liquidity:1,obs_liquidity:1},'liquidity')));
  assert.ok(Number.isNaN(featureValueOf({liquidity:0},'liquidity')));
});

test('impossible outcome filter and adjusted clamp',()=>{
  assert.equal(isImpossibleOutcome({raw_return:2500}),true);
  assert.equal(isImpossibleOutcome({raw_return:-101}),true);
  assert.equal(isImpossibleOutcome({raw_return:12}),false);
  assert.equal(clampAdjustedReturn(9000),500);
  assert.equal(clampAdjustedReturn(-400),-100);
});

test('mining uses entry-time liquidity and overwrites a stale POSITIVE degenerate row',()=>{
  const d=alphaDb();
  d.prepare(`INSERT OR REPLACE INTO hypothesis_results(id,updated_ts,title,feature,regime,samples,clusters,delta,ci_low,ci_high,p_positive,status,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('COLD:liquidity',1,'liquidity top quartile vs rest','liquidity','COLD',64,64,77,20,100,1,'POSITIVE EVIDENCE',JSON.stringify({cut:0}));
  const mints=holdoutMint('LQ',40);
  mints.forEach((mint,i)=>{
    insertObservation({ts:1000,mint,symbol:mint,regime:'COLD',price:1,liquidity:0,edge:40,explosion:10,execution:40,momentum5:0,velocity:0,flowAccel:0,crowding:0,holderQuality:50,clusterId:mint});
    insertOutcome({mint,horizonMin:30,entryTs:2000+i,rawReturn:i>=20?15:-5,adjustedReturn:i>=20?10:-8,regime:'COLD',edge:40,execution:40,liquidity:i>=20?80_000:5_000,clusterId:mint});
  });
  mineHypotheses(d);
  const row=d.prepare(`SELECT * FROM hypothesis_results WHERE id='COLD:liquidity'`).get();
  const payload=JSON.parse(row.payload_json||'{}');
  assert.ok(Number(payload.cut)>0,'entry-time liquidity must set a positive cut, not the first-obs zero');
  assert.notEqual(payload.cut,0);
  assert.ok(Number(row.updated_ts)>1,'stale POSITIVE row must be refreshed');
});

test('impossible raw returns are quarantined from mining counts',()=>{
  const d=alphaDb();
  const mints=holdoutMint('IMP',5);
  mints.forEach((mint,i)=>{
    insertObservation({ts:1,mint,symbol:mint,regime:'NORMAL',price:1,liquidity:10,edge:10,explosion:1,execution:10,momentum5:0,velocity:0,flowAccel:0,crowding:0,clusterId:mint});
    insertOutcome({mint,horizonMin:30,entryTs:2,rawReturn:50_000,adjustedReturn:49_000,regime:'NORMAL',edge:10,execution:10,liquidity:10,clusterId:mint});
  });
  const out=mineHypotheses(d);
  assert.ok(out.quarantined>=5);
});

test('PROPOSAL stage records wait_ms from READY and diagnosis uses medians',()=>{
  const now=Date.now();
  for(let i=0;i<12;i++){
    const mint=`LAT${i}`;
    insertLatency({ts:now-1000,mint,sourceEventTs:now-90_000,discoveredTs:now-1000,analyzedTs:now-990,readyTs:null,proposalTs:null,discoveryMs:89_000,analysisMs:10,readyMs:null,proposalMs:null});
    updateLatencyStage(mint,'READY',now-900);
    updateLatencyStage(mint,'PROPOSAL',now-800);
  }
  const d=alphaDb();
  const row=d.prepare(`SELECT wait_ms,proposal_ms,ready_ts,proposal_ts FROM latency_events WHERE mint='LAT0' ORDER BY id DESC LIMIT 1`).get();
  assert.equal(row.wait_ms,100);
  const diag=latencyDiagnosis(d,now);
  assert.ok(diag.samples>=12);
  assert.ok(diag.medians.wait===100||diag.wait===100);
  assert.ok(['DISCOVERY','WAIT','READY','ANALYSIS'].includes(diag.bottleneck));
});

test('alphaDb wait_ms migration is additive',()=>{
  const cols=alphaDb().prepare(`PRAGMA table_info(latency_events)`).all().map(c=>c.name);
  assert.ok(cols.includes('wait_ms'));
});

test('observation funding-cluster identity is retained when x.cluster_id is present',()=>{
  assert.match(OUTCOME_FEATURE_SQL,/x\.cluster_id AS obs_cluster_id/);
  assert.equal(observationClusterOf({obs_cluster_id:'FUNDER-A',cluster_id:null,mint:'MINT-Z'}),'FUNDER-A');
  assert.equal(observationClusterOf({cluster_id:'OUTCOME-C',mint:'MINT-Z'}),'OUTCOME-C');
  assert.equal(observationClusterOf({mint:'MINT-Z'}),'MINT-Z');
});

// after-hooks run in registration order, so the sqlite handle must be closed before the temp tree is
// removed; unlinking an open file is fine on POSIX but fails with EPERM on Windows.
test.after(()=>{closeAlphaDb();fs.rmSync(root,{recursive:true,force:true})});
