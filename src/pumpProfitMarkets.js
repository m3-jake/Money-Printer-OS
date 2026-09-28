// Bounded exact-pool observations for research positions that leave the active watchlist.
import fs from 'node:fs';import path from 'node:path';
import {writeFileAtomicSync} from './atomicRename.js';
const read=(p,f)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return f}};
export function observationTargets(books=[],now=Date.now()){
 const rows=books.flatMap(b=>[...(b.positions||[]),...(b.history||[]).filter(p=>now-p.closedAt<=121*60000)]);
 return [...new Map(rows.filter(p=>p.mint&&p.pairAddress).map(p=>[p.mint+':'+p.pairAddress,{mint:p.mint,pairAddress:p.pairAddress}])).values()];
}
export async function collectPumpProfitMarkets({dir,now=Date.now(),refreshImpl=null}={}){
 const request=read(path.join(dir,'pump-profit-requests.json'),null);
 if(request?.mode!=='PAPER'||request.liveExecutionAllowed!==false||request.expiresAt<now)return {calls:0,reason:'no-active-paper-study'};
 const file=path.join(dir,'pump-profit-markets.json'),old=read(file,null);
 const cache=old?.protocolHash===request.protocolHash?old:{protocolHash:request.protocolHash,lastAt:0,calls:0,ticks:[],errors:[]};
 if(now-cache.lastAt<15000||cache.calls>=20000)return {calls:0,totalCalls:cache.calls,reason:'bounded-rate-or-total-budget'};
 const seen=new Map(cache.ticks.map(t=>[t.mint+':'+t.pairAddress,t.at]));
 const targets=[...new Map((request.observations||[]).filter(p=>/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.mint)&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.pairAddress)).map(p=>[p.mint+':'+p.pairAddress,p])).values()].sort((a,b)=>(seen.get(a.mint+':'+a.pairAddress)||0)-(seen.get(b.mint+':'+b.pairAddress)||0)).slice(0,30);
 if(!targets.length)return {calls:0,reason:'no-observation-targets'};
 cache.lastAt=now;cache.calls++;
 try{
  const refresh=refreshImpl||(await import('./dexscreener.js')).refreshPositionPairs;
  const rows=await refresh(targets),state=read(path.join(dir,'state.json'),{}),solUsd=Number(state.market?.solUsd);
  const map=new Map(cache.ticks.map(t=>[t.mint+':'+t.pairAddress,t]));
  for(const {p,pair} of rows){if(!pair||pair.pairAddress!==p.pairAddress||pair.baseToken?.address!==p.mint||!(Number(pair.priceUsd)>0)||!(solUsd>0))continue;
   const at=Number(pair.priceObservedAt);if(!(at>0)||now-at>30000||at>now+10000)continue;
   map.set(p.mint+':'+p.pairAddress,{mint:p.mint,pairAddress:p.pairAddress,priceUsd:Number(pair.priceUsd),liquidityUsd:Number(pair.liquidity?.usd||0),liq:Number(pair.liquidity?.usd||0),solUsd,at,integrityPassed:true,source:'exact-pool-public-market-observation'});
  }
  cache.ticks=[...map.values()].filter(t=>now-t.at<180000).slice(-60);
 }catch(e){cache.errors=[...cache.errors,{at:now,message:String(e.message||e)}].slice(-10)}
 writeFileAtomicSync(file,JSON.stringify(cache));return {calls:1,totalCalls:cache.calls,targets:targets.length,observations:cache.ticks.length,maxCalls:20000,paidCalls:0,liveExecutionAllowed:false};
}
