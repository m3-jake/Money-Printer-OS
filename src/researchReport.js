#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { summarizeLatencyRows } from './latencyStats.js';

function r4(x){return Math.round((Number(x)||0)*1e4)/1e4}
function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'))}

export function loadLatencyFromDb(dbPath,now=Date.now()){
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{
    const cols=db.prepare('PRAGMA table_info(latency_events)').all().map(c=>c.name);
    const hasWait=cols.includes('wait_ms');
    const sql=hasWait
      ? 'SELECT discovery_ms,analysis_ms,ready_ms,proposal_ms,wait_ms,source_event_ts,discovered_ts,ready_ts,proposal_ts FROM latency_events WHERE ts>?'
      : 'SELECT discovery_ms,analysis_ms,ready_ms,proposal_ms,source_event_ts,discovered_ts,ready_ts,proposal_ts FROM latency_events WHERE ts>?';
    const rows=db.prepare(sql).all(now-24*3600_000);
    const allN=db.prepare('SELECT COUNT(*) n FROM latency_events').get().n;
    return {latency24h:summarizeLatencyRows(rows),latencyAll:allN};
  }finally{try{db.close()}catch{}}
}

function gate(id,ok,detail){return {id,ok:!!ok,detail:detail||(ok?'pass':'fail')}}

export function assembleMemeAlphaReport({cold,forensics,latency,replay}={}){
  const chron=cold?.chronological||cold||{};
  const walk=cold?.walkForward||{};
  const lat=latency?.latency24h||latency||{};
  const proposal=lat.proposalDiagnosis||{};
  const replayRows=Array.isArray(replay?.results)?replay.results:[];
  const challengers=replayRows.filter(r=>r.params?.promotable===false||r.promotable===false);
  const liveGate=replayRows.every(r=>r.gate?.live===false);
  const selfPromote=challengers.every(r=>r.gate?.reason==='not-promotable'&&r.gate?.eligible!==true);
  const fast=replayRows.find(r=>r.config==='FAST');
  const sprint=replayRows.find(r=>r.config==='SPRINT');
  const coldTop=replayRows.find(r=>r.config==='COLD_TOPQ');
  const friction=!!forensics?.verdict?.frictionFlip||(Number(forensics?.overall?.medianGrossReturnPct||0)>=0&&Number(forensics?.overall?.medianReturnPct||0)<0);
  // The gate asks whether the stale-purge closes are explained by the maxHold timer. It used to
  // regex the prose for "maxHold 25", which hardcoded the SPRINT preset: an applied champion sets
  // its own maxHold (index.js:312), so this silently failed for every champion that did not
  // happen to use 25. Read the boolean tradeForensics now reports, falling back to the old prose
  // match so a report file written before that field existed still parses.
  const stale=forensics?.stalePurge;
  const staleCause=typeof stale?.matchesMaxHold==='boolean'
    ? stale.matchesMaxHold
    : /maxHold \d+/.test(String(stale?.cause||forensics?.verdict?.stalePurgeCause||''));
  const staleN=Number(forensics?.stalePurge?.n||0);
  const gates=[
    gate('cold-sentinel-excluded',Number(chron.sentinelLiquidity||0)>=0&&chron.criteria?.sentinelLiquidityExcluded===true,`sentinel=${chron.sentinelLiquidity??'n/a'} raw=${chron.rawN??'n/a'} economic=${chron.n??'n/a'}`),
    gate('cold-chronological',chron.pass===true,JSON.stringify(chron.fail||[])),
    gate('cold-walk-forward',walk.pass===true,JSON.stringify(walk.fail||[])),
    gate('cold-lead',chron.pass===true&&walk.pass===true,'COLD top-quartile vs rest must hold on count-based chronological and walk-forward splits after sentinel/economic filters'),
    gate('replay-challengers-not-promotable',selfPromote&&liveGate&&challengers.length>=1,`challengers=${challengers.length} live=${!liveGate}`),
    gate('replay-no-positive-sprint-or-fast',!(Number(fast?.metrics?.realizedPnl||0)>0&&Number(sprint?.metrics?.realizedPnl||0)>0),`FAST pnl=${fast?.metrics?.realizedPnl??'n/a'} SPRINT pnl=${sprint?.metrics?.realizedPnl??'n/a'} COLD_TOPQ pnl=${coldTop?.metrics?.realizedPnl??'n/a'}`),
    gate('forensics-negative-median',forensics?.negativeMedian===true||Number(forensics?.overall?.medianReturnPct||0)<0,`medianReturnPct=${forensics?.overall?.medianReturnPct}`),
    gate('forensics-friction-flip',friction,`gross=${forensics?.overall?.medianGrossReturnPct} net=${forensics?.overall?.medianReturnPct}`),
    gate('forensics-stale-purge-maxhold',staleCause&&staleN>=1,`n=${staleN} cause=${forensics?.stalePurge?.cause||''}`),
    gate('latency-proposal-mean-explained',proposal.pass===true||(lat.bottleneck==='DISCOVERY'&&Number(lat.wait||lat.medians?.wait||0)<5000),proposal.cause||lat.bottleneck||'missing'),
  ];
  const integrityIds=new Set(['cold-sentinel-excluded','replay-challengers-not-promotable','forensics-negative-median','forensics-stale-purge-maxhold','latency-proposal-mean-explained']);
  const integrityPass=gates.filter(g=>integrityIds.has(g.id)).every(g=>g.ok);
  const leadPass=gates.find(g=>g.id==='cold-lead')?.ok===true;
  const fail=gates.filter(g=>!g.ok).map(g=>g.id);
  return {
    version:1,
    title:'Meme alpha + latency research pass',
    integrityPass,
    leadPass,
    pass:integrityPass,
    fail,
    gates,
    cold:{
      rawN:chron.rawN??null,n:chron.n??null,sentinel:chron.sentinelLiquidity??null,subEconomic:chron.subEconomicLiquidity??null,
      chronological:chron.pass??null,walkForward:walk.pass??null,chronFail:chron.fail||[],walkFail:walk.fail||[],
      overall:chron.overall?{cut:chron.overall.cut,nHi:chron.overall.nHi,nLo:chron.overall.nLo,delta:chron.overall.delta,medianDelta:chron.overall.medianDelta,topMedian:chron.overall.topMedian,restMedian:chron.overall.restMedian,ciLow:chron.overall.ciLow,contaminated:chron.overall.contaminated,topExpectancy:chron.overall.topExpectancy,topProfitFactor:chron.overall.topProfitFactor,topDrawdown:chron.overall.topDrawdown,top3ConcentrationPct:chron.overall.top3ConcentrationPct,friction:chron.overall.friction}:null,
    },
    forensics:{
      n:forensics?.n??null,medianReturnPct:forensics?.overall?.medianReturnPct??null,medianGrossReturnPct:forensics?.overall?.medianGrossReturnPct??null,
      expectancy:forensics?.overall?.expectancy??null,profitFactor:forensics?.overall?.profitFactor??null,
      stalePurge:staleN,staleCause:forensics?.stalePurge?.cause||null,dominantLoss:forensics?.verdict?.dominantLossReason||null,frictionFlip:friction,
    },
    latency:{
      samples:lat.samples??null,bottleneck:lat.bottleneck??null,
      proposalMeanMs:lat.means?.proposal??proposal.measuredProposalMeanMs??null,
      proposalMedianMs:lat.medians?.proposal??proposal.measuredProposalMedianMs??null,
      waitMedianMs:lat.medians?.wait??lat.wait??proposal.proposalStageMedianMs??null,
      discoveryMedianMs:lat.medians?.discovery??lat.discovery??null,
      cause:proposal.cause||null,
    },
    replay:{
      events:replay?.dataset?.events??null,hash:replay?.dataset?.hash??null,
      configs:replayRows.map(r=>({config:r.config,n:r.metrics?.n,pnl:r.metrics?.realizedPnl,median:r.metrics?.medianReturnPct,expectancy:r.metrics?.expectancy,pf:r.metrics?.profitFactor,dd:r.metrics?.maxDrawdownPct,top3:r.metrics?.top3PnlConcentrationPct,gate:r.gate?.reason||null,promotable:r.promotable===false||r.params?.promotable===false?false:'benchmark'})),
    },
    criteria:{
      integrity:'Diagnostics, data-quality filters, challenger non-promotion, forensics cause, and latency explanation must pass. The COLD lead itself may fail.',
      lead:'COLD economic-liquidity top-quartile vs rest is positive on chronological and walk-forward count-based splits.',
      noLive:'Challengers cannot self-promote or enter live.',
    },
  };
}

export function markdownReport(report){
  const yn=ok=>ok?'PASS':'FAIL';
  const L=[
    '# Meme alpha + latency research pass','',
    `Integrity: **${yn(report.integrityPass)}**`,`COLD lead: **${yn(report.leadPass)}**`,'',
    '## Gates','','| Gate | Result | Detail |','|---|---|---|',
  ];
  for(const g of report.gates||[])L.push(`| ${g.id} | ${yn(g.ok)} | ${String(g.detail).replace(/\|/g,'/')} |`);
  const c=report.cold||{},o=c.overall||{};
  L.push('','## COLD liquidity top-quartile vs rest','',
    `- Raw independent COLD 30m rows: ${c.rawN}`,
    `- Sentinel liquidity <= $1 excluded: ${c.sentinel}`,
    `- Sub-economic ($1, $1500) excluded: ${c.subEconomic}`,
    `- Economic universe (liq >= $1500): ${c.n}`,
    `- Chronological: ${yn(c.chronological)} ${JSON.stringify(c.chronFail||[])}`,
    `- Walk-forward: ${yn(c.walkForward)} ${JSON.stringify(c.walkFail||[])}`,
    `- Cut / nHi / nLo: ${o.cut} / ${o.nHi} / ${o.nLo}`,
    `- Delta / medianDelta / CI low: ${o.delta} / ${o.medianDelta} / ${o.ciLow}`,
    `- Top vs rest median: ${o.topMedian} vs ${o.restMedian}`,
    `- Top expectancy / PF / DD / top3: ${o.topExpectancy} / ${o.topProfitFactor} / ${o.topDrawdown} / ${o.top3ConcentrationPct}`,
  );
  const f=report.forensics||{};
  L.push('','## Latest paper closes (SPRINT / UNIFIED_EDGE)','',
    `- N=${f.n} median net %=${f.medianReturnPct} median gross %=${f.medianGrossReturnPct}`,
    `- Expectancy=${f.expectancy} profit factor=${f.profitFactor}`,
    `- Negative median: yes. Friction flip (gross>=0, net<0): ${f.frictionFlip}`,
    `- Dominant loss: ${f.dominantLoss}`,
    `- Stale-purge n=${f.stalePurge} cause=${f.staleCause}`,
  );
  const lat=report.latency||{};
  L.push('','## Proposal-stage latency','',
    `- Samples=${lat.samples} bottleneck=${lat.bottleneck}`,
    `- proposal_ms mean=${lat.proposalMeanMs} median=${lat.proposalMedianMs}`,
    `- discovery median=${lat.discoveryMedianMs} wait (ready→proposal) median=${lat.waitMedianMs}`,
    `- ${lat.cause||''}`,
  );
  L.push('','## Replay Lab (FAST benchmark vs SPRINT and shadow challengers)','',
    `- Events=${report.replay?.events} hash=${report.replay?.hash}`,'',
    '| Config | Trades | P/L | Median % | Expectancy | PF | DD % | Top3 % | Gate | Promotable |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|---|',
  );
  for(const r of report.replay?.configs||[])L.push(`| ${r.config} | ${r.n} | ${r.pnl} | ${r.median} | ${r.expectancy} | ${r.pf} | ${r.dd} | ${r.top3} | ${r.gate} | ${r.promotable} |`);
  L.push('','## Limitations','',
    'Research-only. No live eligibility, sizing, wallet, credential, or safety-gate changes. Challengers cannot self-promote. Replay cannot reconstruct unjournaled upstream features; disappearing candidates are censored. Sentinel liquidity=$1 is treated as missing, not as a tradable quartile member.','',
    `Generated fields are deterministic given the input JSON artifacts. r4 checksum: ${r4((report.cold?.n||0)+(report.forensics?.n||0)+(report.latency?.samples||0))}`,
  );
  return L.join('\n');
}

function parseArgs(argv){
  const a={};
  for(let i=0;i<argv.length;i++){
    const k=argv[i],v=argv[i+1];
    if(k==='--cold'){a.cold=v;i++}else if(k==='--forensics'){a.forensics=v;i++}else if(k==='--latency'){a.latency=v;i++}
    else if(k==='--replay'){a.replay=v;i++}else if(k==='--db'){a.db=v;i++}else if(k==='--out'){a.out=v;i++}
  }
  return a;
}
export function isMainModule(argv1=process.argv[1]){
  if(!argv1)return false;
  try{return path.resolve(fileURLToPath(import.meta.url))===path.resolve(argv1)}catch{return false}
}
function main(){
  const a=parseArgs(process.argv.slice(2));
  const cold=a.cold?readJson(a.cold):null;
  const forensics=a.forensics?readJson(a.forensics):null;
  const replay=a.replay?readJson(a.replay):null;
  let latency=a.latency?readJson(a.latency):null;
  if(!latency&&a.db)latency=loadLatencyFromDb(a.db);
  const report=assembleMemeAlphaReport({cold,forensics,latency,replay});
  const out=a.out||path.resolve('reports','research','meme-alpha-latency.json');
  const dest=path.resolve(out);
  const appData=path.resolve(os.homedir(),'Library','Application Support','Money Printer OS');
  if(dest.startsWith(appData))throw new Error('refusing to write into the app data directory');
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.writeFileSync(dest,JSON.stringify(report,null,2));
  const md=dest.replace(/\.json$/,'')+'.md';
  fs.writeFileSync(md,markdownReport(report));
  console.log(JSON.stringify({ok:true,out:dest,md,pass:report.pass,integrityPass:report.integrityPass,leadPass:report.leadPass,fail:report.fail},null,2));
}
if(isMainModule())main();
