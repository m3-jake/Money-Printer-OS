import { finite } from './model.js';
import { awaitAbortable } from '../requestAbort.js';

export class ProviderError extends Error { constructor(code,message){super(message);this.code=code;} }
export class JsonProvider {
  constructor(id,{fetchImpl=globalThis.fetch,timeoutMs=9000,minIntervalMs=0}={}) {this.id=id;this.fetch=fetchImpl;this.timeoutMs=timeoutMs;this.minIntervalMs=minIntervalMs;this.health={status:'IDLE',lastSuccess:null,lastError:null,latencyMs:null,requests:0,backoffUntil:0};this.inflight=new Map();this.cache=new Map();this.lastRequest=0;this.observedTimes=new WeakMap();}
  copy(entry){const data=structuredClone(entry.data);this.observedTimes.set(data,entry.at);return data;}
  observedAt(data){return this.observedTimes.get(data)??null;}
  async get(url,{ttlMs=5000,headers={}}={}) {
    const key=String(url),cached=this.cache.get(key),now=Date.now();
    if(cached&&now-cached.at<ttlMs)return this.copy(cached);
    if(this.inflight.has(key))return this.inflight.get(key);
    if(now<this.health.backoffUntil)throw new ProviderError('RATE_LIMITED',`${this.id}: retry after ${new Date(this.health.backoffUntil).toISOString()}`);
    if(this.inflight.size>=4)throw new ProviderError('RATE_LIMITED',`${this.id}: request concurrency limit`);
    if(now-this.lastRequest<this.minIntervalMs)throw new ProviderError('RATE_LIMITED',`${this.id}: request pacing active`);
    this.lastRequest=now;
    const request=(async()=>{
      this.health.requests++;
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(new ProviderError('TIMEOUT',`${this.id}: request deadline exceeded`)),this.timeoutMs);
      try{
        const r=await awaitAbortable(this.fetch(key,{headers:{accept:'application/json',...headers},signal:controller.signal}),controller.signal);
        if(!r.ok){
          if(r.status===429){const h=r.headers?.get?.('retry-after'),seconds=finite(h);this.health.backoffUntil=Date.now()+Math.min(300000,Math.max(1000,seconds!==null?seconds*1000:30000));throw new ProviderError('RATE_LIMITED',`${this.id}: rate limited`);}
          throw new ProviderError([401,403].includes(r.status)?'AUTH_ERROR':'HTTP_ERROR',`${this.id}: HTTP ${r.status}`);
        }
        let data;try{data=await awaitAbortable(r.json(),controller.signal);}catch(e){if(controller.signal.aborted)throw controller.signal.reason;throw new ProviderError('MALFORMED_DATA',`${this.id}: invalid JSON response`);}
        if(controller.signal.aborted)throw controller.signal.reason;
        if(!data||typeof data!=='object')throw new ProviderError('MALFORMED_DATA',`${this.id}: expected structured data`);
        this.health={...this.health,status:'CONNECTED',lastSuccess:Date.now(),lastError:null,latencyMs:Date.now()-now};
        this.cache.set(key,{at:Date.now(),data});if(this.cache.size>200)this.cache.delete(this.cache.keys().next().value);
        return this.copy(this.cache.get(key));
      }catch(e){this.health.status=e.code==='AUTH_ERROR'?'AUTH ERROR':e.code==='RATE_LIMITED'?'DEGRADED':'DISCONNECTED';this.health.lastError=e.code||'NETWORK_ERROR';throw e;}
      finally{clearTimeout(timer);this.inflight.delete(key);}
    })();this.inflight.set(key,request);return request;
  }
  status(now=Date.now()){return {...this.health,status:this.health.status==='CONNECTED'&&now-this.health.lastSuccess>60000?'STALE':this.health.status,id:this.id,websocket:'UNAVAILABLE',queueDepth:this.inflight.size};}
}
export class ProviderRegistry {
  constructor(){this.providers=new Map();}
  register(provider){if(this.providers.has(provider.id))throw new Error('Duplicate provider');this.providers.set(provider.id,provider);return provider;}
  get(id){const p=this.providers.get(id);if(!p)throw new ProviderError('UNKNOWN_PROVIDER','Unknown provider');return p;}
  status(){return [...this.providers.values()].map(p=>p.status());}
}

// Brokers implement this contract in an adapter; UI code never holds credentials or SDKs.
export const BROKER_METHODS=Object.freeze(['account','positions','instruments','quotes','preview','submit','orderStatus','cancel','history']);
export function validateBroker(provider){for(const method of BROKER_METHODS)if(typeof provider[method]!=='function')throw new Error(`Broker missing ${method}`);return provider;}
