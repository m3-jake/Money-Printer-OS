import {apiProviderFromUrl,recordApiRequest,recordApiCacheHit,recordApiCoalescedHit,recordApiCapReject,recordApiFailure,admitApiSpend,recordApiSpendCapReject,recordApiRoiGuardReject} from './apiUnitEconomics.js';
import { awaitAbortable } from './requestAbort.js';

// Coalesce reads, cancel timed-out transports and respect upstream retry windows.
// Cache timestamps belong to the fetched data, never to the consumer's read.
export function createMarketRequester({fetcher=(...args)=>globalThis.fetch(...args),now=Date.now,timeoutMs=6500,requestsPerMinute=120}={}) {
  const cache=new Map(),pending=new Map(),hosts=new Map();
  const stats={requests:0,cacheHits:0,coalescedHits:0,rateLimits:0,timeouts:0,budgetRejects:0,spendCapRejects:0,roiGuardRejects:0,failures:0};
  const cap=Math.max(0,Number(requestsPerMinute)||0);
  async function get(url,label='market feed',{ttlMs=20000,headers={},costPerRequestUsd=null,purpose=null,signal=null}={}) {
    // A caller signal (the per-cycle budget) cancels in-flight work and rejects immediately when the
    // cycle is already over; without one, behaviour is exactly as before.
    if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:new Error(`${label}: aborted`);
    const ts=now(),cached=cache.get(url),provider=apiProviderFromUrl(url);
    if(cached&&ts-cached.fetchedAt<ttlMs){stats.cacheHits++;recordApiCacheHit(provider,{costPerRequestUsd,purpose});return cached;}
    if(pending.has(url)){stats.coalescedHits++;recordApiCoalescedHit(provider,{costPerRequestUsd,purpose});return awaitAbortable(pending.get(url),signal);}
    const host=new URL(url).host;
    const state=hosts.get(host)||{retryAt:0,failures:0,window:[]};
    hosts.set(host,state);
    if(ts<state.retryAt)throw new Error(`${label}: rate limit backoff until ${new Date(state.retryAt).toISOString()}`);
    state.window=state.window.filter(t=>ts-t<60000);
    if(cap>0&&state.window.length>=cap){stats.budgetRejects++;recordApiCapReject(provider);throw new Error(`${label}: local request budget exhausted (${cap}/min)`);}
    const admit=admitApiSpend({costUsd:costPerRequestUsd,now:ts,purpose});
    if(!admit.ok){
      if(admit.kind==='daily-spend-cap'){stats.spendCapRejects++;recordApiSpendCapReject(provider);throw new Error(`${label}: daily USD spend cap exhausted`);}
      if(admit.kind==='roi-guard'){stats.roiGuardRejects++;recordApiRoiGuardReject(provider);throw new Error(`${label}: ROI guard blocked spend`);}
    }
    state.window.push(ts);stats.requests++;recordApiRequest(provider,{costPerRequestUsd,purpose,now:ts});
    const task=(async()=>{
      const controller=new AbortController();
      const onCallerAbort=()=>controller.abort(signal.reason);
      if(signal)signal.addEventListener('abort',onCallerAbort,{once:true});
      const timer=setTimeout(()=>controller.abort(),timeoutMs);
      try{
        const response=await awaitAbortable(fetcher(url,{headers,signal:controller.signal}),controller.signal);
        if(!response.ok){
          stats.failures++;recordApiFailure(provider);
          if(response.status===429){
            const retry=response.headers?.get?.('retry-after');
            const seconds=retry==null?NaN:Number(retry);
            const explicit=Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-now();
            // Concurrent 429s extend the same window only once.
            if(state.retryAt<=now())state.failures++;
            const delay=Math.max(Number.isFinite(explicit)?explicit:0,Math.min(300000,30000*2**Math.min(4,state.failures-1)));
            state.retryAt=Math.max(state.retryAt,now()+delay);stats.rateLimits++;
          }
          throw new Error(`${label}: HTTP ${response.status}`);
        }
        const data=await awaitAbortable(response.json(),controller.signal);
        if(controller.signal.aborted)throw controller.signal.reason;
        if(state.retryAt<=now())state.failures=0;
        const result={data,fetchedAt:now(),latencyMs:now()-ts};
        cache.delete(url);cache.set(url,result);
        while(cache.size>512)cache.delete(cache.keys().next().value);
        return result;
      }catch(error){
        // A caller abort is a cancellation, not a provider timeout: report it as such and leave the
        // failure/limit counters to real failures.
        if(signal?.aborted&&controller.signal.aborted)throw signal.reason instanceof Error?signal.reason:new Error(`${label}: aborted`);
        if(controller.signal.aborted){stats.timeouts++;stats.failures++;recordApiFailure(provider);throw new Error(`${label} timed out after ${timeoutMs}ms`);}
        throw error;
      }
      finally{clearTimeout(timer);if(signal)signal.removeEventListener('abort',onCallerAbort);}
    })().finally(()=>pending.delete(url));
    pending.set(url,task);return task;
  }
  return {get,health(){const saved=stats.cacheHits+stats.coalescedHits,total=stats.requests+saved;return {...stats,requestsPerMinute:cap||null,cacheAvoidanceRate:total?Math.round(saved/total*1e6)/1e6:0,cached:cache.size,inFlight:pending.size,
    // Per-host window usage, so a caller sharing this budget with its own fan-out can size itself
    // against what is actually left instead of guessing (see dexscreener discoveryBatchBudget).
    hosts:[...hosts].map(([host,state])=>({host,windowCalls:state.window.filter(t=>now()-t<60000).length,retryAt:state.retryAt})),
    retryAt:Math.max(0,...[...hosts.values()].map(h=>h.retryAt)),
    ok:![...hosts.values()].some(h=>h.retryAt>now())};}};
}
