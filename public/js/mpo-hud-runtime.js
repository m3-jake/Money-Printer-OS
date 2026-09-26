/* Shared HUD read transport and preference recovery. Mutations retain their original transport. */
(function(root){
 'use strict';
 const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
 function createPreferences(getStorage,onError=()=>{}){
  const memory=new Map();
  return {
   read(key,fallback){try{const raw=memory.has(key)?memory.get(key):getStorage().getItem(key);if(raw===null||raw===undefined)return fallback;const v=JSON.parse(raw);return Array.isArray(fallback)?(Array.isArray(v)?v:fallback):object(fallback)?(object(v)?v:fallback):v===null?fallback:typeof v===typeof fallback?v:fallback}catch(e){onError(key,e);return fallback}},
   write(key,value){try{const raw=JSON.stringify(value);memory.set(key,raw);getStorage().setItem(key,raw);return true}catch(e){onError(key,e);return false}},
   remove(key){memory.delete(key);try{getStorage().removeItem(key);return true}catch(e){onError(key,e);return false}}
  };
 }
 function sanitizeLayout(value,hosts,fallback){
  const result={};if(!object(value))return result;
  for(const id of hosts){const v=value[id];if(!object(v))continue;const base=fallback(id),item={};
   for(const key of ['x','y','w','h']){const n=v[key];item[key]=typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=50000&&(key==='x'||key==='y'||n>0)?n:base[key]}
   item.w=Math.max(260,item.w);item.h=Math.max(150,item.h);item.min=v.min===true;item.max=v.max===true;result[id]=item;
  }return result;
 }
 function createTransport(nativeFetch,{concurrency=4,maxQueue=32,timeoutMs=12000,now=Date.now,onChange=()=>{}}={}){
  const pending=new Map(),states=new Map(),queue=[];let active=0,disposed=false;
  const notify=()=>{try{onChange()}catch{}};
  const cancelled=()=>new DOMException('Refresh cancelled','AbortError');
  const pump=()=>{while(!disposed&&active<concurrency&&queue.length){const job=queue.shift();if(job.controller.signal.aborted)continue;active++;job.start()}};
  function fetchRead(input,options={}){
   const key=String(input),method=String(options.method||'GET').toUpperCase();
   if(method!=='GET'||!key.startsWith('/api/'))return nativeFetch(input,options);
   if(disposed)return Promise.reject(cancelled());
   // Sharing a completed body gives each caller its own Response; one stream is never consumed twice.
   const existing=pending.get(key);if(existing)return existing.promise.then(packet=>new Response(packet.body,packet.init));
   const previous=states.get(key)||{lastSuccess:0,failures:0,error:null};
   if(previous.retryAt>now())return Promise.reject(Error(previous.error||'Refresh backing off'));
   if(queue.length>=maxQueue)return Promise.reject(Error('HUD refresh queue full; retry on next poll'));
   const controller=new AbortController();let done=false,started=false,timer,resolve,reject;
   const job={key,controller,promise:new Promise((res,rej)=>{resolve=res;reject=rej})};
   pending.set(key,job);
   function finish(error,packet){if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abortExternal);pending.delete(key);const qi=queue.indexOf(job);if(qi>=0)queue.splice(qi,1);if(started)active--;
    if(error){if(error.name!=='AbortError'){const failures=previous.failures+1;states.set(key,{...previous,error:error.message,failures,retryAt:now()+Math.min(30000,1000*2**Math.min(failures-1,5))})}reject(error)}else{states.set(key,{lastSuccess:now(),error:null,failures:0,retryAt:0});resolve(packet)}while(states.size>256)states.delete(states.keys().next().value);notify();pump();
   }
   const abortExternal=()=>controller.abort(options.signal?.reason||cancelled());
   controller.signal.addEventListener('abort',()=>finish(controller.signal.reason||cancelled()),{once:true});
   options.signal?.addEventListener('abort',abortExternal,{once:true});
   timer=setTimeout(()=>controller.abort(new DOMException('Local request timed out','TimeoutError')),timeoutMs);
   job.start=async()=>{started=true;try{
    const response=await nativeFetch(input,{...options,signal:controller.signal});
    if(!response.ok&&response.status!==304)throw Error('HTTP '+response.status+' · '+key);
    const body=response.status===304?null:await response.text();
    if(done)return;
    // Parse before releasing the slot; malformed JSON cannot mark retained values as fresh.
    if(body!==null&&response.headers.get('content-type')?.includes('json'))JSON.parse(body);
    finish(null,{body,init:{status:response.status,statusText:response.statusText,headers:response.headers}});
   }catch(e){finish(e)}};
   if(options.signal?.aborted)abortExternal();else{queue.push(job);pump()}
   return job.promise.then(packet=>new Response(packet.body,packet.init));
  }
  return {fetch:fetchRead,state:key=>({...states.get(key)}),status:()=>({active,queued:queue.length,pending:pending.size,failures:[...states].filter(([,v])=>v.error).map(([key,v])=>({key,...v}))}),cancel:match=>{for(const job of [...pending.values()])if(!match||match(job.key))job.controller.abort(cancelled())},dispose(){disposed=true;this.cancel();queue.length=0}};
 }
 const api={createPreferences,sanitizeLayout,createTransport};
 if(root.document){
  const samples=new Map();let longTasks=0,longTaskMs=0,lastFrame=0,raf=0;
  api.measure=(key,ms)=>{if(!Number.isFinite(ms)||ms<0)return;const values=samples.get(key)||[];values.push(ms);if(values.length>360)values.shift();samples.set(key,values)};
  api.metrics=()=>({longTasks,longTaskMs,...Object.fromEntries([...samples].map(([key,values])=>{const s=values.slice().sort((a,b)=>a-b);return[key,{n:s.length,p50:s[Math.floor((s.length-1)*.5)],p95:s[Math.floor((s.length-1)*.95)],max:s.at(-1)}]}))});
  const frame=t=>{raf=0;if(root.document.hidden){lastFrame=0;return}if(lastFrame)api.measure('frame',t-lastFrame);lastFrame=t;raf=root.requestAnimationFrame(frame)};
  raf=root.requestAnimationFrame(frame);
  root.document.addEventListener('click',()=>{const at=performance.now();root.requestAnimationFrame(()=>api.measure('feedback',performance.now()-at))},true);
  let observer;try{observer=new PerformanceObserver(list=>{for(const e of list.getEntries()){longTasks++;longTaskMs+=e.duration}});observer.observe({entryTypes:['longtask']})}catch{}
  const storageErrors=new Set();api.preferences=createPreferences(()=>root.localStorage,key=>storageErrors.add(key));api.storageErrors=storageErrors;
  api.transport=createTransport(root.fetch.bind(root),{onChange:()=>root.dispatchEvent(new Event('mpo:read-status'))});api.fetch=api.transport.fetch;
  root.document.addEventListener('visibilitychange',()=>{if(root.document.hidden){api.transport.cancel();root.cancelAnimationFrame(raf);raf=0;lastFrame=0}else if(!raf)raf=root.requestAnimationFrame(frame)});
  root.addEventListener('pagehide',()=>{api.transport.cancel();root.cancelAnimationFrame(raf);raf=0;observer?.disconnect()});
 }
 root.MPOHud=api;
})(typeof window==='object'?window:globalThis);
