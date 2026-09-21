import fs from 'node:fs';
import path from 'node:path';

const dataDir=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');
const metricsDir=path.join(dataDir,'api-unit-economics');
const startedAt=Date.now();
const providers=new Map();

function row(provider='unknown'){
  const key=String(provider||'unknown').toLowerCase();
  let x=providers.get(key);
  if(!x){x={requests:0,cacheHits:0,coalescedHits:0,capRejects:0,failures:0,pricedRequests:0,unpricedRequests:0,configuredCostUsd:0};providers.set(key,x)}
  return x;
}
function money(n){return Math.round(Number(n||0)*1e8)/1e8}
function validCost(v){const n=Number(v);return v!==null&&v!==undefined&&v!==''&&Number.isFinite(n)&&n>=0?n:null}
export function apiProviderFromUrl(url=''){
  let host='';try{host=new URL(url).hostname.toLowerCase()}catch{}
  if(host==='api.dexscreener.com'||host.endsWith('.dexscreener.com'))return 'dexscreener';
  if(host==='api.geckoterminal.com'||host.endsWith('.geckoterminal.com'))return 'geckoterminal';
  if(host==='api.helius.xyz'||host.endsWith('.helius.xyz'))return 'helius';
  return host||'unknown';
}
export function recordApiRequest(provider,{costPerRequestUsd=null}={}){
  const x=row(provider);x.requests++;
  const c=validCost(costPerRequestUsd);
  if(c===null)x.unpricedRequests++;else{x.pricedRequests++;x.configuredCostUsd=money(x.configuredCostUsd+c)}
}
export function recordApiCacheHit(provider){row(provider).cacheHits++}
export function recordApiCoalescedHit(provider){row(provider).coalescedHits++}
export function recordApiCapReject(provider){row(provider).capRejects++}
export function recordApiFailure(provider){row(provider).failures++}

function normalizedRows(source=providers){
  const out={};
  for(const [provider,x] of [...source.entries()].sort(([a],[b])=>a.localeCompare(b))){
    const saved=x.cacheHits+x.coalescedHits,total=x.requests+saved;
    out[provider]={...x,configuredCostUsd:money(x.configuredCostUsd),cacheAvoidanceRate:total?Math.round(saved/total*1e6)/1e6:0};
  }
  return out;
}
function totals(rows){
  const t={requests:0,cacheHits:0,coalescedHits:0,capRejects:0,failures:0,pricedRequests:0,unpricedRequests:0,configuredCostUsd:0};
  for(const x of Object.values(rows))for(const k of Object.keys(t))t[k]+=Number(x[k]||0);
  t.configuredCostUsd=money(t.configuredCostUsd);
  const saved=t.cacheHits+t.coalescedHits,total=t.requests+saved;
  t.cacheAvoidanceRate=total?Math.round(saved/total*1e6)/1e6:0;
  return t;
}
export function apiUnitEconomicsSnapshot(){
  const rows=normalizedRows();
  return {schema:'mpo.api-unit-economics.v1',startedAt,updatedAt:Date.now(),providers:rows,totals:totals(rows),costSemantics:'configured per-request costs only; unpriced requests are reported separately'};
}
export function persistApiUnitEconomics(role='trader'){
  const safe=String(role||'process').replace(/[^a-z0-9._-]+/gi,'-');
  const snap={...apiUnitEconomicsSnapshot(),role:safe,pid:process.pid};
  fs.mkdirSync(metricsDir,{recursive:true});
  const file=path.join(metricsDir,`${safe}.json`),tmp=`${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp,JSON.stringify(snap,null,2));fs.renameSync(tmp,file);return snap;
}
export function readApiUnitEconomics({maxAgeMs=10*60_000}={}){
  const now=Date.now(),roles={};
  try{
    for(const name of fs.readdirSync(metricsDir).filter(x=>x.endsWith('.json'))){
      try{const x=JSON.parse(fs.readFileSync(path.join(metricsDir,name),'utf8'));if(now-Number(x.updatedAt||0)<=maxAgeMs)roles[x.role||name.replace(/\.json$/,'')]=x}catch{}
    }
  }catch{}
  const merged=new Map();
  for(const snap of Object.values(roles))for(const [provider,x] of Object.entries(snap.providers||{})){
    const m=merged.get(provider)||{requests:0,cacheHits:0,coalescedHits:0,capRejects:0,failures:0,pricedRequests:0,unpricedRequests:0,configuredCostUsd:0};
    for(const k of Object.keys(m))m[k]+=Number(x[k]||0);merged.set(provider,m);
  }
  const providersOut=normalizedRows(merged);
  return {schema:'mpo.api-unit-economics.v1',updatedAt:now,roles,providers:providersOut,totals:totals(providersOut),costSemantics:'configured per-request costs only; unpriced requests are reported separately'};
}
export function resetApiUnitEconomicsForTests(){providers.clear()}
