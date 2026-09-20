const finite=xs=>xs.filter(v=>v!=null&&v!=='').map(Number).filter(Number.isFinite);

export function percentile(xs,p=0.5){
  const a=finite(xs).sort((x,y)=>x-y);
  if(!a.length)return null;
  const i=Math.min(a.length-1,Math.max(0,Math.floor((a.length-1)*p)));
  return a[i];
}
export function mean(xs){
  const a=finite(xs);
  return a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
}
function pack(xs){
  const a=finite(xs);
  return {n:a.length,median:percentile(a,.5),p90:percentile(a,.9),mean:mean(a)};
}
export function waitMsOf(r){
  if(r?.wait_ms!=null&&r.wait_ms!==''&&Number.isFinite(Number(r.wait_ms))&&Number(r.wait_ms)>=0)return Number(r.wait_ms);
  if(Number(r?.proposal_ts)>0&&Number(r?.ready_ts)>0&&Number(r.proposal_ts)>=Number(r.ready_ts))return Number(r.proposal_ts)-Number(r.ready_ts);
  return null;
}
function col(rows,key){return rows.map(r=>r?.[key])}

export function summarizeLatencyRows(rows=[]){
  const list=Array.isArray(rows)?rows:[];
  const sourceBased=list.filter(r=>Number(r.source_event_ts)>0);
  const discoveredBased=list.filter(r=>!(Number(r.source_event_ts)>0));
  const waits=list.map(waitMsOf).filter(x=>x!=null&&Number.isFinite(x));
  const feed=col(sourceBased,'discovery_ms');
  const analysis=col(list,'analysis_ms');
  const ready=col(list,'ready_ms');
  const proposal=col(list,'proposal_ms');
  const stages={
    discovery:pack(feed),
    analysis:pack(analysis),
    ready:pack(ready),
    proposal:pack(proposal),
    wait:pack(waits),
  };
  const vote={
    DISCOVERY:Number(stages.discovery.median||0),
    ANALYSIS:Number(stages.analysis.median||0),
    READY:Number(stages.ready.median||0),
    WAIT:Number(stages.wait.median||0),
  };
  let bottleneck='INSUFFICIENT DATA';
  const usable=Object.entries(vote).filter(([,v])=>v>0);
  if(list.length>=10&&usable.length)bottleneck=usable.sort((a,b)=>b[1]-a[1])[0][0];
  const readyToProp=list.map(waitMsOf).filter(x=>x!=null&&Number.isFinite(x));
  const within2s=readyToProp.filter(x=>x<=2000).length;
  const queue=readyToProp.filter(x=>x>2000);
  const firstSeenToReady=list.filter(r=>Number(r.ready_ts)>0&&Number(r.discovered_ts)>0).map(r=>Math.max(0,Number(r.ready_ts)-Number(r.discovered_ts)));
  const z=x=>Number(x||0);
  const summary={
    samples:list.length,
    discovery:z(stages.discovery.median),
    analysis:z(stages.analysis.median),
    ready:z(stages.ready.median),
    proposal:z(stages.proposal.median),
    wait:z(stages.wait.median),
    means:{discovery:z(stages.discovery.mean),analysis:z(stages.analysis.mean),ready:z(stages.ready.mean),proposal:z(stages.proposal.mean),wait:z(stages.wait.mean)},
    p90:{discovery:z(stages.discovery.p90),analysis:z(stages.analysis.p90),ready:z(stages.ready.p90),proposal:z(stages.proposal.p90),wait:z(stages.wait.p90)},
    medians:{discovery:z(stages.discovery.median),analysis:z(stages.analysis.median),ready:z(stages.ready.median),proposal:z(stages.proposal.median),wait:z(stages.wait.median)},
    bottleneck,
    breakdown:{
      feed:pack(feed),
      pipeline:{firstSeenToReady:pack(firstSeenToReady),readyToProposal:pack(readyToProp),within2sPct:readyToProp.length?within2s/readyToProp.length*100:null},
      queue:{n:queue.length,...pack(queue)},
      sourceBased:{n:sourceBased.length,proposal:pack(col(sourceBased,'proposal_ms')),discovery:pack(feed)},
      discoveredBased:{n:discoveredBased.length,proposal:pack(col(discoveredBased,'proposal_ms'))},
    },
  };
  summary.proposalDiagnosis=diagnoseProposalLatency(summary);
  return summary;
}

export function diagnoseProposalLatency(s={}){
  const mean=Number(s.means?.proposal||0);
  const med=Number(s.medians?.proposal||s.proposal||0);
  const wait=Number(s.medians?.wait||s.wait||0);
  const disc=Number(s.medians?.discovery||s.discovery||0);
  const ratio=med>0?mean/med:null;
  const proposalTracksDiscovery=med>0&&disc>0&&Math.abs(med-disc)<=Math.max(5000,med*0.2);
  const around500s=mean>=350_000;
  const cause=proposalTracksDiscovery
    ?'proposal_ms is source-event-to-proposal (includes discovery); ~500s mean is outlier-inflated end-to-end, not proposal-stage queue'
    : wait>=350_000
      ?'proposal-stage wait (ready-to-proposal) is itself the delay'
      :'proposal mean inflated by outliers; median proposal-stage wait is short';
  const fail=[];
  if(!(s.samples>=10))fail.push('insufficient-samples');
  if(!(s.breakdown?.pipeline?.readyToProposal?.n>=10))fail.push('insufficient-proposal-stage-samples');
  if(s.bottleneck!=='DISCOVERY')fail.push('bottleneck-not-discovery');
  if(!(wait<5_000))fail.push('proposal-stage-wait-not-short');
  if(s.samples>=10&&!proposalTracksDiscovery)fail.push('proposal-ms-not-end-to-end');
  return {
    measuredProposalMeanMs:mean,
    measuredProposalMedianMs:med,
    proposalStageMedianMs:wait,
    discoveryMedianMs:disc,
    meanInflationRatio:ratio,
    around500s,
    proposalIncludesDiscovery:proposalTracksDiscovery,
    cause,
    bottleneck:s.bottleneck||'INSUFFICIENT DATA',
    pass:fail.length===0,
    fail,
    criteria:{
      minSamples:10,
      bottleneck:'DISCOVERY',
      maxProposalStageMedianMs:5000,
      meanAround500sExplainedByOutliers:true,
      proposalMsIsEndToEnd:true,
    },
  };
}
