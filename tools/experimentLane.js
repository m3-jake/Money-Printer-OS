import crypto from 'node:crypto';
const stableStringify=v=>JSON.stringify(v,Object.keys(v||{}).sort());
export const hashObject=v=>crypto.createHash('sha256').update(stableStringify(v)).digest('hex');
export const SAFE_MODES=new Set(['backtest','shadow','paper']);

export function machineRole({platform='',cpus=0,name=''}={}){
 const p=String(platform).toLowerCase();
 return p.startsWith('win')?{role:'compute-qa',jobs:['replay','sweep','build','windows-qa'],maxReplayWorkers:Math.max(1,Number(cpus||4)-4)}:{role:'orchestrator-stable',jobs:['plan','stable-benchmark','integration','light-tests'],maxReplayWorkers:Math.max(1,Math.min(4,Number(cpus||4)-2))};
}
export function createExperiment({stableConfig,datasetHash,versionHash,createdAt=Date.now()}={}){
 if(!stableConfig||!datasetHash||!versionHash)throw new Error('stableConfig, datasetHash and versionHash are required');
 const stable={config:Object.freeze(structuredClone(stableConfig)),configHash:hashObject(stableConfig),datasetHash:String(datasetHash),versionHash:String(versionHash),metrics:null};
 return {schema:1,id:`exp-${createdAt.toString(36)}`,createdAt,stable,challengers:[],events:[]};
}
export function addChallenger(exp,{config,mode='backtest',datasetHash=exp.stable.datasetHash,versionHash=exp.stable.versionHash}={}){
 if(!SAFE_MODES.has(mode))throw new Error('Challengers may only run in backtest, shadow, or paper');
 if(!config)throw new Error('challenger config required');
 const c={id:`ch-${exp.challengers.length+1}`,config:structuredClone(config),configHash:hashObject(config),datasetHash:String(datasetHash),versionHash:String(versionHash),mode,status:'queued',metrics:null,createdAt:Date.now()};
 exp.challengers.push(c);return c;
}
export function recordResult(exp,id,metrics){const c=exp.challengers.find(x=>x.id===id);if(!c)throw new Error('unknown challenger');c.metrics=structuredClone(metrics||{});c.status='measured';c.measuredAt=Date.now();return c}
export function promotionDecision(exp,id,{minTrades=50,maxDrawdownPct=20,minProfitFactor=1.05,minPositiveSplitShare=.66,maxTop3PnlConcentrationPct=80}={}){
 const c=exp.challengers.find(x=>x.id===id);if(!c||c.status!=='measured')return {eligible:false,reason:'not-measured',live:false};
 if(c.config&&c.config.promotable===false)return {eligible:false,reason:'not-promotable',nextMode:null,live:false};
 const m=c.metrics||{};
 if(Number(m.n||0)<minTrades)return {eligible:false,reason:'sample-too-small'};
 if(Number(m.maxDrawdownPct||Infinity)>maxDrawdownPct)return {eligible:false,reason:'drawdown'};
 if(Number(m.realizedPnl||0)<=0||Number(m.expectancy||0)<=0)return {eligible:false,reason:'no-positive-edge'};
 if(Number.isFinite(Number(m.profitFactor))&&Number(m.profitFactor)<minProfitFactor)return {eligible:false,reason:'weak-profit-factor'};
 const totalSplits=Number(m.totalSplits||0),positiveSplits=Number(m.positiveSplits||0);
 if(totalSplits>0&&positiveSplits/totalSplits<minPositiveSplitShare)return {eligible:false,reason:'split-inconsistent'};
 const concentration=Math.abs(Number(m.top3PnlConcentrationPct||0));
 if(concentration>maxTop3PnlConcentrationPct)return {eligible:false,reason:'top-trade-concentration'};
 return {eligible:true,reason:'shadow-candidate',nextMode:'shadow',live:false};
}
export function setStableMetrics(exp,metrics){exp.stable.metrics=structuredClone(metrics||{});return exp.stable}
export function assertNoLiveChallengers(exp){for(const c of exp.challengers)if(!SAFE_MODES.has(c.mode))throw new Error(`unsafe challenger mode ${c.mode}`);return true}
