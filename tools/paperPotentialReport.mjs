// Local, bounded operational evidence. No mutations, credentials, or historical fill invention.
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
const out=path.resolve(process.argv[2]||'reports/paper-potential-2026-10-03');
const tag=process.argv[3]||'current';
const data=path.join(process.env.APPDATA||'', 'Money Printer OS','data');
fs.mkdirSync(out,{recursive:true});
const api=async(port,endpoint)=>{try{const r=await fetch(`http://127.0.0.1:${port}/api/${endpoint}`,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json();}catch(e){return {error:e.message};}};
const [state,health,bots,scoreboard,lab,intelligence,profiles]=await Promise.all([api(8792,'state'),api(8792,'health'),api(8792,'bots'),api(8792,'scoreboard'),api(8793,'state'),api(8792,'platform/intelligence'),api(8792,'operating-profiles')]);
const samples=[];for(let i=0;i<20;i++){const start=performance.now();const r=await api(8792,'health');if(r.ok)samples.push(performance.now()-start);}
samples.sort((a,b)=>a-b);const percentile=q=>samples.length?Math.round(samples[Math.min(samples.length-1,Math.floor(q*samples.length))]):null;
const files=[];
function walk(dir,depth=0){if(depth>3)return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory()){if(['experiments','daily-shadow','robinhood-equities','robinhood-daily','lab-link'].includes(e.name)||depth>0&&depth<3)walk(file,depth+1);continue;}if(!e.name.endsWith('.json')||/backup|\.pre-|checkpoint|manifest|bars|quote|policy|capture|budget|config|monitor|research/.test(e.name)&&!e.name.includes('paper'))continue;
 try{const b=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(b.open)&&!Array.isArray(b.positions)&&!b.books&&!b.bots&&!b.sleeves)continue;const entries=b.books?Object.values(b.books).map(x=>[x.id,x]):b.bots?Object.entries(b.bots):[[b.id||e.name,b]];
 for(const [id,book]of entries){const history=book.history||[],open=book.open||book.positions||Object.values(book.sleeves||{}).filter(s=>s.qty>0);const unit=Number.isFinite(book.cashSol)||book.startSol!==undefined?'SOL':'USD';const pnl=unit==='SOL'?'pnlSol':'pnlUsd';files.push({file:path.relative(data,file).replaceAll('\\','/'),id,unit,capital:unit==='SOL'?book.startSol:book.startUsd,cash:unit==='SOL'?book.cashSol:book.cashUsd??book.settledCashUsd??(book.sleeves?Object.values(book.sleeves).reduce((s,x)=>s+x.cashUsd,0):null),open:open.length,openCost:open.reduce((s,p)=>s+Number((unit==='SOL'?p.costSol:p.costUsd??p.entry?.costUsd)||0),0),closed:history.length,retainedRealizedPnl:history.reduce((s,p)=>s+Number(p[pnl]||0),0),experiment:book.experiment?.id||book.experimentId||book.candidateId||null,recoveryRequired:book.recoveryRequired||false});}
 }catch(e){files.push({file:path.relative(data,file),recoveryError:e.message});}
 }}
if(fs.existsSync(data))walk(data);
const closed=(scoreboard.rows||[]).filter(r=>r.kind==='paper').map(r=>({id:r.id,module:r.module,book:r.book,verdict:r.beatsBaseline,reason:r.reason,performance:r.performance||r.paper,baseline:r.baseline,extra:r.extra,freshness:r.freshness}));
const report={schema:'mpo.paper-potential-report.v1',at:new Date().toISOString(),tag,build:state.build,operatingProfile:state.runtime?.profile||profiles.active,profilePolicy:profiles,safety:{...health.switches,paidModelsEnabled:intelligence.budget?.paidModelsEnabled,cachePaidModelsEnabled:intelligence.cache?.paidModelsEnabled},health:health.health,metrics:health.metrics,healthLatencyMs:{samples:samples.length,p50:percentile(.5),p95:percentile(.95)},venues:health.venues,apiUse:health.marketRequests,books:files,scoreboard:scoreboard.summary,paperSummary:scoreboard.paperSummary,rows:closed,copy:{incumbent:{equityUsd:bots.polycopy?.equityUsd,stats:bots.polycopy?.stats,drawdownPause:bots.polycopy?.drawdownPause,open:bots.polycopy?.open?.length,attribution:bots.polycopy?.attribution},experiments:(bots.copyExperiments||[]).map(b=>({experiment:b.experiment,stats:b.stats,cashUsd:b.cashUsd,open:b.open?.length,lastError:b.lastError,decisions:b.decisions?.slice(0,10)})),mirror:bots.mirror?.matcher},lab:{build:lab.build,schedulerPolicy:lab.schedulerPolicy,workbench:lab.workbench,modules:lab.modules},measurementLimits:['Retained history may be bounded; lifetime P/L stays in original books and ledger','Health endpoint latency is not source-to-fill latency','New capture receipts are prospective; no historical executable copy profits are imputed','Different experimental books are independent hypothetical portfolios; do not sum as deployable capital','No elapsed-market forward profitability claim from installation smoke tests']};
report.copy.incumbent.latency=bots.polycopy?.latency||null;
report.copy.incumbent.discoveryCache=bots.polycopy?.discoveryCache||null;
report.copy.experiments.forEach((b,i)=>{b.latency=bots.copyExperiments[i]?.latency||null;b.discoveryCache=bots.copyExperiments[i]?.discoveryCache||null;b.policySupport=bots.copyExperiments[i]?.policySupport||null;});
report.copy.mirrorLatency=bots.mirror?.latency||null;
report.copy.mirrorFunnel=bots.mirror?.funnel||bots.mirror?.stats||null;
fs.writeFileSync(path.join(out,`${tag}-report.json`),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({file:path.join(out,`${tag}-report.json`),build:report.build?.version,profile:report.operatingProfile,health:report.health,books:files.length,scoreboard:report.scoreboard,latency:report.healthLatencyMs},null,2));
