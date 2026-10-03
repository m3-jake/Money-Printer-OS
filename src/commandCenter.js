const rows = x => Array.isArray(x) ? x : Object.values(x || {});
const finite = x => typeof x === 'number' && Number.isFinite(x) ? x : null;
export const RESEARCH_PROFILES = Object.freeze(['MAX_RESEARCH','BURST_RESEARCH','FAST_PAPER_STEADY']);

export function commandCenterSnapshot({state={},bots={},board={},lab=null,labError=null,loops={},discovery=null,now=Date.now()}={}) {
  const modules = rows(lab?.resourceCoverage?.platforms).map(x=>({id:x.id,title:x.title,state:x.state,cpu:x.cpu,gpu:x.gpu,pipeline:x.pipeline,workers:x.workers,blockers:rows(lab?.modules).find(m=>(m.id||m.module)===x.id)?.traderFitness?.blockers||[]}));
  const copy = [bots.polycopy,...(bots.copyExperiments||[])].filter(Boolean).map(x=>({id:x.experiment?.id||'incumbent',policy:x.experiment?.policy||'incumbent',status:x.status,leaders:rows(x.follows).map(f=>({wallet:f.wallet,name:f.name,followedAt:f.followedAt})),open:rows(x.open).length,closes:x.stats?.closed??null,netPnlUsd:finite(x.stats?.pnlUsd),lastRunAt:x.lastRunAt||null,running:x.running===true,paused:x.drawdownPause?.active===true,reason:x.lastError||x.drawdownPause?.active&&x.drawdownPause.reason||x.lastNote||'Waiting for copy receipts',decisions:rows(x.decisions).slice(0,4).map(d=>({at:d.at,action:d.action,reason:d.reason}))}));
  const freshness = lab?.now ? Math.max(0,now-lab.now) : null;
  return {schema:'mpo.command-center.v1',at:now,paperOnly:true,profiles:{trader:state.runtime?.profile||null,lab:lab?.schedulerPolicy?.profile||null,available:RESEARCH_PROFILES},controls:{paused:state.system?.paused===true,killSwitch:state.system?.killSwitch===true,paidModelsEnabled:false},lab:{connected:!!lab,error:labError,ageMs:freshness,resources:lab?.resources||null,scheduler:lab?.scheduler?{resources:lab.scheduler.resources,profile:lab.scheduler.profile,active:rows(lab.scheduler.jobs).filter(j=>j.state==='RUNNING').map(j=>({module:j.module,startedAt:j.startedAt,slots:j.grantedSlots})),queued:rows(lab.scheduler.jobs).filter(j=>j.state==='QUEUED').length}:null,modules,workbench:lab?.workbench?{activeJobs:lab.workbench.activeJobs,jobs:lab.workbench.jobs,standing:lab.workbench.standing,leaderboards:lab.workbench.leaderboards,leaderReplay:lab.workbench.leaderReplay,forwardExperiments:lab.workbench.forwardExperiments}:null},copy:{books:copy,uniqueLeaders:copy.length?new Set(copy.flatMap(x=>x.leaders.map(f=>f.wallet))).size:null,catalogue:discovery,pump:bots.pumpCopy||null,pumpExperiments:bots.pumpCopyExperiments||[],mirror:bots.mirror?{leaders:bots.mirror.sportsLeaders?.watching,matcher:bots.mirror.matcher,lastRunAt:bots.mirror.lastRunAt,reason:bots.mirror.lastError||bots.mirror.lastNote}:null},summary:board.summary||null,paperSummary:board.paperSummary||null,loops,limitations:['Independent paper accounts keep separate capital and currencies.','Leaderboard profit is a discovery lead; follower net results determine improvement.','Changed evidence wakes research; unchanged or missing evidence is backed off.']};
}

export function createLabConnection({fetchImpl=globalThis.fetch,now=Date.now}={}) {
  let cached=null,checkedAt=0,pending=null,lastError=null;
  async function request(route,body){
    const r=await fetchImpl('http://127.0.0.1:8793'+route,{signal:AbortSignal.timeout(5000),redirect:'error',...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
    if(!r.ok)throw Error(`Lab HTTP ${r.status}`);return r.json();
  }
  return {
    async state(){if(pending)return pending;if(checkedAt&&now()-checkedAt<5000)return {lab:cached,error:lastError};pending=(async()=>{try{const value=await request('/api/state');if(!value?.schedulerPolicy||!value?.build)throw Error('Lab identity unavailable');cached=value;lastError=null;}catch(e){lastError=String(e.message);cached=null;}checkedAt=now();return {lab:cached,error:lastError};})().finally(()=>{pending=null;});return pending;},
    async profile(profile){if(!RESEARCH_PROFILES.includes(profile))throw Error('Unknown research profile');const value=await request('/api/scheduler-profile',{profile});if(value?.ok!==true||value.policy?.profile!==profile)throw Error('Lab did not acknowledge profile');checkedAt=0;return value;},
  };
}
