import fs from 'node:fs';
import path from 'node:path';

const dataDir=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');
const metricsDir=path.join(dataDir,'api-unit-economics');
const startedAt=Date.now();
const providers=new Map();
const PURPOSES=['scan','research','index','other'];
const PURPOSE_KEYS=['requests','pricedRequests','unpricedRequests','configuredCostUsd','cacheHits','coalescedHits','avoidedCostUsd'];
const ROW_KEYS=['requests','cacheHits','coalescedHits','capRejects','failures','pricedRequests','unpricedRequests','configuredCostUsd','avoidedCostUsd','spendCapRejects','roiGuardRejects'];

function money(n){return Math.round(Number(n||0)*1e8)/1e8}
function validCost(v){const n=Number(v);return v!==null&&v!==undefined&&v!==''&&Number.isFinite(n)&&n>=0?n:null}
function positiveCap(v){const n=validCost(v);return n!==null&&n>0?n:null}
function utcDay(ts){return new Date(ts).toISOString().slice(0,10)}
function purposeName(p){const k=String(p||'').toLowerCase();return PURPOSES.includes(k)?k:'other'}
function emptyPurpose(){return {requests:0,pricedRequests:0,unpricedRequests:0,configuredCostUsd:0,cacheHits:0,coalescedHits:0,avoidedCostUsd:0}}
function emptyPurposes(){return Object.fromEntries(PURPOSES.map(k=>[k,emptyPurpose()]))}
function emptyRow(){return {requests:0,cacheHits:0,coalescedHits:0,capRejects:0,failures:0,pricedRequests:0,unpricedRequests:0,configuredCostUsd:0,avoidedCostUsd:0,spendCapRejects:0,roiGuardRejects:0,purposes:emptyPurposes()}}
function envNum(k){const v=process.env[k];if(v===undefined||String(v).trim()==='')return null;return validCost(v)}
function policyFromEnv(){return {dailySpendCapUsd:positiveCap(envNum('API_DAILY_SPEND_CAP_USD')),roiValueUsd:envNum('API_RESEARCH_VALUE_USD'),roiMinRoi:positiveCap(envNum('API_ROI_GUARD_MIN_ROI'))||1}}

let policy={...policyFromEnv(),now:Date.now};
let dayKey='';
let daySpendUsd=0;
let attribution={scans:0,candidates:0,ready:0,watch:0,outcomesSettled:0,lastMarkCostUsd:0,attributedCostUsd:0};

function row(provider='unknown'){
  const key=String(provider||'unknown').toLowerCase();
  let x=providers.get(key);
  if(!x){x=emptyRow();providers.set(key,x)}
  x.purposes||=emptyPurposes();
  return x;
}
function purposeBucket(x,purpose){
  x.purposes||=emptyPurposes();
  const k=purposeName(purpose);
  return x.purposes[k]||(x.purposes[k]=emptyPurpose());
}
function rollDay(ts){
  const d=utcDay(ts);
  if(d!==dayKey){dayKey=d;daySpendUsd=0}
  return d;
}
function currentConfiguredCost(purpose=null){
  let t=0;
  if(purpose){
    const k=purposeName(purpose);
    for(const x of providers.values())t+=Number(x.purposes?.[k]?.configuredCostUsd||0);
  }else{
    for(const x of providers.values())t+=Number(x.configuredCostUsd||0);
  }
  return money(t);
}
function spendEfficiency(configured,avoided){
  const c=money(configured),a=money(avoided),d=c+a;
  return d?Math.round(a/d*1e6)/1e6:0;
}
function requestAvoidance(requests,cacheHits,coalescedHits){
  const saved=Number(cacheHits||0)+Number(coalescedHits||0);
  const total=Number(requests||0)+saved;
  return total?Math.round(saved/total*1e6)/1e6:0;
}
function decoratePurpose(p=emptyPurpose()){
  const configured=money(p.configuredCostUsd),avoided=money(p.avoidedCostUsd);
  return {
    requests:Number(p.requests||0),pricedRequests:Number(p.pricedRequests||0),unpricedRequests:Number(p.unpricedRequests||0),
    configuredCostUsd:configured,cacheHits:Number(p.cacheHits||0),coalescedHits:Number(p.coalescedHits||0),avoidedCostUsd:avoided,
    efficiency:spendEfficiency(configured,avoided),
    cacheAvoidanceRate:requestAvoidance(p.requests,p.cacheHits,p.coalescedHits),
  };
}
function purposeSpendView(purposes){
  const out={};
  for(const k of PURPOSES){
    const p=decoratePurpose(purposes?.[k]);
    out[k]={configuredCostUsd:p.configuredCostUsd,avoidedCostUsd:p.avoidedCostUsd,efficiency:p.efficiency};
  }
  return out;
}

export function configureApiSpendPolicy(patch={}){
  if('dailySpendCapUsd' in patch)policy.dailySpendCapUsd=positiveCap(patch.dailySpendCapUsd);
  if('roiValueUsd' in patch)policy.roiValueUsd=validCost(patch.roiValueUsd);
  if('roiMinRoi' in patch)policy.roiMinRoi=positiveCap(patch.roiMinRoi)||1;
  if(typeof patch.now==='function')policy.now=patch.now;
  return apiSpendPolicy();
}
export function apiSpendPolicy(){return {dailySpendCapUsd:policy.dailySpendCapUsd,roiValueUsd:policy.roiValueUsd,roiMinRoi:policy.roiMinRoi}}

export function apiProviderFromUrl(url=''){
  let host='';try{host=new URL(url).hostname.toLowerCase()}catch{}
  if(host==='api.dexscreener.com'||host.endsWith('.dexscreener.com'))return 'dexscreener';
  if(host==='api.geckoterminal.com'||host.endsWith('.geckoterminal.com'))return 'geckoterminal';
  if(host==='api.helius.xyz'||host.endsWith('.helius.xyz'))return 'helius';
  return host||'unknown';
}

export function evaluateDailySpendCap({costUsd=null,now}={}){
  const ts=now??policy.now();
  rollDay(ts);
  const cap=policy.dailySpendCapUsd,cost=validCost(costUsd);
  if(cap==null)return {ok:true,active:false,reason:'unlimited',spentUsd:money(daySpendUsd),capUsd:null,remainingUsd:null,costUsd:cost};
  if(cost===null)return {ok:true,active:false,reason:'unpriced-not-capped',spentUsd:money(daySpendUsd),capUsd:cap,remainingUsd:money(Math.max(0,cap-daySpendUsd)),costUsd:null};
  if(daySpendUsd+cost>cap+1e-12)return {ok:false,active:true,reason:'daily-spend-cap',spentUsd:money(daySpendUsd),capUsd:cap,remainingUsd:money(Math.max(0,cap-daySpendUsd)),costUsd:cost};
  return {ok:true,active:true,reason:'within-cap',spentUsd:money(daySpendUsd),capUsd:cap,remainingUsd:money(Math.max(0,cap-(daySpendUsd+cost))),costUsd:cost};
}

export function evaluateRoiGuard({costUsd=null,valueUsd=null,minRoi=null}={}){
  const c=validCost(costUsd),v=validCost(valueUsd);
  const floor=validCost(minRoi);const min=floor===null?1:floor;
  if(c===null||v===null)return {active:false,ok:true,reason:'inactive-missing-inputs',costUsd:c,valueUsd:v,roi:null,minRoi:min};
  const roi=c>0?money(v/c):null;
  const ok=c===0?true:(v/c)>=min;
  return {active:true,ok,reason:ok?'roi-ok':'roi-below-min',costUsd:c,valueUsd:v,roi,minRoi:min};
}

export function admitApiSpend({costUsd=null,valueUsd,now,purpose=null}={}){
  const ts=now??policy.now();
  const cap=evaluateDailySpendCap({costUsd,now:ts});
  if(!cap.ok)return {ok:false,kind:'daily-spend-cap',cap,roi:null};
  const c=validCost(costUsd);
  const scopedPurpose=purposeName(purpose);
  // API_RESEARCH_VALUE_USD is a per-request research value estimate. It must not
  // silently gate baseline scan/index traffic, and each request is judged on its
  // own incremental cost rather than cumulative daily spend.
  const v=valueUsd===undefined?(scopedPurpose==='research'?policy.roiValueUsd:null):validCost(valueUsd);
  const roi=evaluateRoiGuard({costUsd:c,valueUsd:v,minRoi:policy.roiMinRoi});
  if(roi.active&&!roi.ok)return {ok:false,kind:'roi-guard',cap,roi};
  return {ok:true,kind:'admit',cap,roi};
}

export function recordApiRequest(provider,{costPerRequestUsd=null,purpose=null,now}={}){
  const x=row(provider);x.requests++;
  const p=purposeBucket(x,purpose);p.requests++;
  const c=validCost(costPerRequestUsd);
  if(c===null){x.unpricedRequests++;p.unpricedRequests++;}
  else{
    x.pricedRequests++;p.pricedRequests++;
    x.configuredCostUsd=money(x.configuredCostUsd+c);p.configuredCostUsd=money(p.configuredCostUsd+c);
    rollDay(now??policy.now());daySpendUsd=money(daySpendUsd+c);
  }
}
export function recordApiCacheHit(provider,{costPerRequestUsd=null,purpose=null}={}){
  const x=row(provider);x.cacheHits++;
  const p=purposeBucket(x,purpose);p.cacheHits++;
  const c=validCost(costPerRequestUsd);
  if(c!==null){x.avoidedCostUsd=money(x.avoidedCostUsd+c);p.avoidedCostUsd=money(p.avoidedCostUsd+c)}
}
export function recordApiCoalescedHit(provider,{costPerRequestUsd=null,purpose=null}={}){
  const x=row(provider);x.coalescedHits++;
  const p=purposeBucket(x,purpose);p.coalescedHits++;
  const c=validCost(costPerRequestUsd);
  if(c!==null){x.avoidedCostUsd=money(x.avoidedCostUsd+c);p.avoidedCostUsd=money(p.avoidedCostUsd+c)}
}
export function recordApiCapReject(provider){row(provider).capRejects++}
export function recordApiSpendCapReject(provider){row(provider).spendCapRejects++}
export function recordApiRoiGuardReject(provider){row(provider).roiGuardRejects++}
export function recordApiFailure(provider){row(provider).failures++}

export function attributeScanCycle({candidates=0,ready=0,watch=0,outcomesSettled=0}={}){
  const current=currentConfiguredCost('scan');
  const delta=money(Math.max(0,current-attribution.lastMarkCostUsd));
  attribution.lastMarkCostUsd=current;
  attribution.scans++;
  attribution.candidates+=Number(candidates)||0;
  attribution.ready+=Number(ready)||0;
  attribution.watch+=Number(watch)||0;
  attribution.outcomesSettled+=Number(outcomesSettled)||0;
  attribution.attributedCostUsd=money(attribution.attributedCostUsd+delta);
  return scanAttributionView(attribution);
}

export function strategyNetPnlAfterDataCost({grossPnlSol=null,dataCostUsd=null,solUsd=null}={}){
  const gross=Number.isFinite(Number(grossPnlSol))?Number(grossPnlSol):null;
  const cost=validCost(dataCostUsd);
  const px=Number(solUsd);const solPx=Number.isFinite(px)&&px>0?px:null;
  const dataCostSol=cost!==null&&solPx!==null?money(cost/solPx):null;
  let netPnlSol=null;
  if(gross!==null&&dataCostSol!==null)netPnlSol=money(gross-dataCostSol);
  else if(gross!==null&&cost===null)netPnlSol=gross;
  return {grossPnlSol:gross,dataCostUsd:cost,dataCostSol,netPnlSol,solUsd:solPx,adjusted:dataCostSol!==null};
}

function scanAttributionView(a=attribution){
  const cost=money(a.attributedCostUsd??a.scanConfiguredCostUsd??a.configuredCostUsd??0);
  const per=(n)=>n?money(cost/n):null;
  return {
    scans:Number(a.scans||0),candidates:Number(a.candidates||0),ready:Number(a.ready||0),watch:Number(a.watch||0),
    outcomesSettled:Number(a.outcomesSettled||0),configuredCostUsd:cost,
    costPerScan:per(a.scans),costPerCandidate:per(a.candidates),costPerReady:per(a.ready),costPerOutcome:per(a.outcomesSettled),
    costBasis:'scan-purpose-configured-spend',
  };
}

function clonePurpose(p=emptyPurpose()){
  return decoratePurpose(p);
}
function clonePurposes(src){
  const out=emptyPurposes();
  for(const k of PURPOSES)out[k]=clonePurpose(src?.[k]);
  return out;
}
function normalizedRows(source=providers){
  const out={};
  for(const [provider,x] of [...source.entries()].sort(([a],[b])=>a.localeCompare(b))){
    const saved=x.cacheHits+x.coalescedHits,total=x.requests+saved;
    out[provider]={
      ...x,
      configuredCostUsd:money(x.configuredCostUsd),avoidedCostUsd:money(x.avoidedCostUsd||0),
      spendCapRejects:Number(x.spendCapRejects||0),roiGuardRejects:Number(x.roiGuardRejects||0),
      cacheAvoidanceRate:total?Math.round(saved/total*1e6)/1e6:0,
      efficiency:spendEfficiency(x.configuredCostUsd,x.avoidedCostUsd||0),
      purposes:clonePurposes(x.purposes),
    };
  }
  return out;
}
function totals(rows){
  const t=emptyRow();delete t.purposes;
  t.purposes=emptyPurposes();
  for(const x of Object.values(rows)){
    for(const k of ROW_KEYS)t[k]+=Number(x[k]||0);
    for(const k of PURPOSES){
      const p=x.purposes?.[k]||emptyPurpose();
      for(const pk of PURPOSE_KEYS)t.purposes[k][pk]+=Number(p[pk]||0);
    }
  }
  t.configuredCostUsd=money(t.configuredCostUsd);t.avoidedCostUsd=money(t.avoidedCostUsd);
  for(const k of PURPOSES)t.purposes[k]=decoratePurpose(t.purposes[k]);
  const saved=t.cacheHits+t.coalescedHits,total=t.requests+saved;
  t.cacheAvoidanceRate=total?Math.round(saved/total*1e6)/1e6:0;
  t.efficiency=spendEfficiency(t.configuredCostUsd,t.avoidedCostUsd);
  return t;
}
function dailyView(now){
  const ts=now??policy.now();rollDay(ts);
  const cap=policy.dailySpendCapUsd;
  return {day:dayKey,spentUsd:money(daySpendUsd),capUsd:cap,remainingUsd:cap==null?null:money(Math.max(0,cap-daySpendUsd))};
}

const COST_SEMANTICS='configured per-request costs only; unpriced requests are reported separately; avoidedCostUsd is configured cost of cache and coalesced hits; daily spend caps apply only to priced requests; ROI guard applies only to purpose=research priced requests with explicit research value and cost inputs; scanAttribution outcome costs use scan-purpose configured spend only; strategy net P&L uses total priced configured cost; purposeSpend reports configured and avoided spend and spend-avoidance efficiency per purpose';

export function apiUnitEconomicsSnapshot(){
  const rows=normalizedRows();
  const t=totals(rows);
  const roi={scope:'research',mode:'per-request',configured:policy.roiValueUsd!==null,valueUsd:policy.roiValueUsd,minRoi:policy.roiMinRoi,rejects:t.roiGuardRejects};
  return {
    schema:'mpo.api-unit-economics.v1',startedAt,updatedAt:Date.now(),providers:rows,totals:t,
    daily:dailyView(),scanAttribution:scanAttributionView(),purposeSpend:purposeSpendView(t.purposes),roiGuard:roi,spendPolicy:apiSpendPolicy(),
    costSemantics:COST_SEMANTICS,
  };
}
export function persistApiUnitEconomics(role='trader'){
  const safe=String(role||'process').replace(/[^a-z0-9._-]+/gi,'-');
  const snap={...apiUnitEconomicsSnapshot(),role:safe,pid:process.pid};
  fs.mkdirSync(metricsDir,{recursive:true});
  const file=path.join(metricsDir,`${safe}.json`),tmp=`${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp,JSON.stringify(snap,null,2));fs.renameSync(tmp,file);return snap;
}
function mergeRow(into,src){
  const m=into||emptyRow();
  for(const k of ROW_KEYS)m[k]=Number(m[k]||0)+Number(src[k]||0);
  m.purposes=m.purposes||emptyPurposes();
  for(const k of PURPOSES){
    m.purposes[k]=m.purposes[k]||emptyPurpose();
    const p=src.purposes?.[k];if(!p)continue;
    for(const pk of PURPOSE_KEYS)m.purposes[k][pk]=Number(m.purposes[k][pk]||0)+Number(p[pk]||0);
  }
  return m;
}
export function readApiUnitEconomics({maxAgeMs=10*60_000}={}){
  const now=Date.now(),roles={};
  try{
    for(const name of fs.readdirSync(metricsDir).filter(x=>x.endsWith('.json'))){
      try{const x=JSON.parse(fs.readFileSync(path.join(metricsDir,name),'utf8'));if(now-Number(x.updatedAt||0)<=maxAgeMs)roles[x.role||name.replace(/\.json$/,'')]=x}catch{}
    }
  }catch{}
  const merged=new Map();
  const attr={scans:0,candidates:0,ready:0,watch:0,outcomesSettled:0,configuredCostUsd:0};
  for(const snap of Object.values(roles)){
    for(const [provider,x] of Object.entries(snap.providers||{}))merged.set(provider,mergeRow(merged.get(provider),x));
    const a=snap.scanAttribution;if(a){for(const k of ['scans','candidates','ready','watch','outcomesSettled','configuredCostUsd'])attr[k]+=Number(a[k]||0)}
  }
  const providersOut=normalizedRows(merged);
  const t=totals(providersOut);
  return {
    schema:'mpo.api-unit-economics.v1',updatedAt:now,roles,providers:providersOut,totals:t,
    scanAttribution:scanAttributionView(attr),purposeSpend:purposeSpendView(t.purposes),
    costSemantics:COST_SEMANTICS,
  };
}
export function resetApiUnitEconomicsForTests(){
  providers.clear();
  policy={dailySpendCapUsd:null,roiValueUsd:null,roiMinRoi:1,now:Date.now};
  dayKey='';daySpendUsd=0;
  attribution={scans:0,candidates:0,ready:0,watch:0,outcomesSettled:0,lastMarkCostUsd:0,attributedCostUsd:0};
}
