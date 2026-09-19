// Coalesce reads, cancel timed-out transports and respect upstream retry windows.
// Cache timestamps belong to the fetched data, never to the consumer's read.
export function createMarketRequester({fetcher=(...args)=>globalThis.fetch(...args),now=Date.now,timeoutMs=6500}={}) {
  const cache=new Map(),pending=new Map(),hosts=new Map();
  const stats={requests:0,cacheHits:0,rateLimits:0,timeouts:0};
  async function get(url,label='market feed',{ttlMs=20000,headers={}}={}) {
    const ts=now(),cached=cache.get(url);
    if(cached&&ts-cached.fetchedAt<ttlMs){stats.cacheHits++;return cached;}
    if(pending.has(url))return pending.get(url);
    const host=new URL(url).host;
    const state=hosts.get(host)||{retryAt:0,failures:0,window:[]};
    hosts.set(host,state);
    if(ts<state.retryAt)throw new Error(`${label}: rate limit backoff until ${new Date(state.retryAt).toISOString()}`);
    state.window=state.window.filter(t=>ts-t<60000);
    if(state.window.length>=120)throw new Error(`${label}: local request budget exhausted`);
    state.window.push(ts);stats.requests++;
    const task=(async()=>{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),timeoutMs);
      try{
        const response=await fetcher(url,{headers,signal:controller.signal});
        if(!response.ok){
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
        const data=await response.json();
        if(state.retryAt<=now())state.failures=0;
        const result={data,fetchedAt:now(),latencyMs:now()-ts};
        cache.delete(url);cache.set(url,result);
        while(cache.size>512)cache.delete(cache.keys().next().value);
        return result;
      }catch(error){if(controller.signal.aborted){stats.timeouts++;throw new Error(`${label} timed out after ${timeoutMs}ms`);}throw error;}
      finally{clearTimeout(timer);}
    })().finally(()=>pending.delete(url));
    pending.set(url,task);return task;
  }
  return {get,health(){return {...stats,cached:cache.size,inFlight:pending.size,
    retryAt:Math.max(0,...[...hosts.values()].map(h=>h.retryAt)),
    ok:![...hosts.values()].some(h=>h.retryAt>now())};}};
}
