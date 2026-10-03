/* Command Center (2026-10-03): chart-first price workspace + coordinated system view + compact status strip.
   The platform renderer receives a constant mount string from html(), so its innerHTML diffing never replaces
   this window; the Command Center owns one persistent element tree that is re-attached if the mount is rebuilt
   and patched region by region. Polling runs only while the view is visible, and one request is in flight at a time.
   All mutations use the existing local control endpoints (unchanged). */
window.MPOCommandCenter=(()=>{
  'use strict';
  const MOUNT='<div class="command-brain" data-cc-mount></div>';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
  const arr=v=>Array.isArray(v)?v:[];
  const G=()=>window.MPOCommandGraphs;
  const pct=v=>num(v)==null?'Unknown':(v>=10?Math.round(v):v.toFixed(1))+'%';
  const gb=mib=>num(mib)==null?'Unknown':(mib/1024).toFixed(mib>=10240?0:1)+' GB';
  const ago=t=>num(t)==null?'Unknown':Date.now()-t<60000?Math.max(0,Math.round((Date.now()-t)/1000))+'s':Date.now()-t<3600000?Math.round((Date.now()-t)/60000)+'m':Math.round((Date.now()-t)/3600000)+'h';
  let data=null,coord=null,coordAt=0,coordMissingUntil=0,procs=null,procsAt=0,funnel=null,funnelAt=0,funnelMissingUntil=0;
  let loading=null,error='',message='',pending=false,lastAt=0,payloadView=null;
  let rootEl=null,ws=null,sysTab='modules',attachQueued=false,firstLoadAt=null,firstPaintMs=null;
  const traffic=[];   // [at, bytes, path] over the last minute
  const prefs=()=>window.MPOHud?.preferences;
  try{sysTab=prefs()?.read('mpo-cc-systab','modules')||'modules';}catch{}
  const bytes=(path,n)=>{const now=Date.now();traffic.push([now,n,path]);while(traffic.length&&now-traffic[0][0]>60000)traffic.shift();};

  // ---- Pure section builders (also used by tests) ------------------------------------------------------
  function stripHTML(d,p=procs){
    const lab=d?.lab,r=lab?.resources,cpu=r?.cpu,mem=r?.memory,gpu=arr(r?.gpus)[0],sh=r?.sharedCpu,sched=lab?.scheduler;
    const loops=Object.entries(d?.loops||{}),bad=loops.filter(([,l])=>['ERROR','STALLED'].includes(l.state));
    const exceptions=[...bad.map(([id,l])=>`${id}: ${l.lastError||l.state}`),...(lab&&lab.connected===false?[`Lab: ${lab.error||'not connected'}`]:[]),...(error?[error]:[])];
    const running=[...arr(sched?.active).map(j=>`${j.module} (${num(j.slots)??'?'} slots)`),...arr(lab?.workbench?.activeJobs)];
    const copy=d?.copy,cand=copy?.catalogue?.candidates?.length,open=arr(copy?.books).reduce((n,b)=>n+(num(b.open)||0),0);
    const item=(label,value,title='',tone='')=>`<span class="cc-si ${tone}" title="${esc(title)}"><span class="cc-sl">${esc(label)}</span> <b class="mpd-num">${esc(value)}</b></span>`;
    const conn=!d?'Connecting':lab?.connected?`Lab ✓ · data ${ago(d.at)}`:'Lab unavailable';
    return `<span class="cc-si"><span class="mpd-dot ${!d?'unknown':lab?.connected&&Date.now()-d.at<30000?'up':'warn'}"></span> <b>${esc(conn)}</b></span>`+
      item('Profile',`${d?.profiles?.lab||'?'} / ${d?.profiles?.trader||'?'}`,'Lab / trader research profile · paid models '+(d?.controls?.paidModelsEnabled?'ON':'off'))+
      item('Lab',`${pct(cpu?.labPct)} CPU · ${gb(mem?.labWorkingSetMiB)}`,`Measured Lab processes (${cpu?.scope||'scope not reported'})`)+
      item('Trader',p?`${pct(p.cpuPctOfMachine)} CPU · ${gb(p.workingSetMiB)}`:'Unknown',p?`Measured trader processes: ${p.processCount??'?'} · ${p.cpuPctOfOneCore==null?'':Math.round(p.cpuPctOfOneCore)+'% of one core · '}${p.scope||''}`:'Trader process metrics not available')+
      item('Machine',pct(cpu?.machinePct),`${cpu?.logicalProcessors??'?'} logical processors · ${gb(mem?.freeMiB)} free RAM`)+
      item('GPU',gpu?pct(gpu.utilizationPct):'Unknown',gpu?`${gpu.name} · whole device, includes other apps`:'GPU not reported')+
      item('Reserved',sh?`${num(sh.slotsInUse)??'?'}/${num(sh.ceiling)??'?'} slots`:'Unknown','Shared CPU slot reservations (leases), not measured usage','cc-reserved')+
      item('Running',running.length?running.join(' · '):'idle',running.join('\n')||'No module job running')+
      item('Copy',`${num(cand)??'?'} found → ${num(copy?.uniqueLeaders)??'?'} watched → ${copy?open:'?'} open`,'Polymarket copy discovery → watched leaders → open paper copies')+
      `<span class="cc-si ${exceptions.length?'cc-exc':''}" title="${esc(exceptions.join('\n')||'No failing loops or connection errors')}"><span class="mpd-dot ${exceptions.length?'down':'up'}"></span> <b>${exceptions.length?exceptions.length+' exception'+(exceptions.length===1?'':'s'):'No exceptions'}</b></span>`;
  }
  const SYS_TABS=[['modules','Modules'],['copy','Copy'],['research','Research'],['books','Books']];
  function sysHTML(d,tab=sysTab){
    if(!d)return `<p class="cc-empty">${esc(error||'Connecting to the coordination service…')}</p>`;
    const g=G();if(!g)return '';
    return tab==='copy'?g.copy(d,funnel):tab==='research'?g.research(d):tab==='books'?g.books(d):g.modules(d,coord);
  }

  // ---- DOM ----------------------------------------------------------------------------------------------
  function build(){
    const el=document.createElement('div');el.className='cc mpd-root';
    el.innerHTML=`<div class="cc-top"><div class="cc-strip" data-r="strip" aria-label="System status"></div>
      <div class="cc-controls"><button class="cc-btn primary" type="button" data-cc-profile="MAX_RESEARCH">Use available capacity</button><button class="cc-btn" type="button" data-cc-profile="FAST_PAPER_STEADY">Steady research</button><button class="cc-btn" type="button" data-cc-refresh>Refresh</button><button class="cc-btn" type="button" data-overview-open="evolution">Open Lab</button></div></div>
      <div class="cc-msg" role="status" data-r="msg"></div>
      <div class="cc-main"><div class="cc-ws"></div>
        <aside class="cc-sys" aria-label="Coordinated system view"><div class="cc-sys-tabs" role="tablist">${SYS_TABS.map(([k,l])=>`<button type="button" role="tab" data-cc-sys="${k}">${l}</button>`).join('')}</div><div class="cc-sys-body" data-r="sys" tabindex="-1"></div></aside></div>
      <div class="cc-legend" aria-label="Chart legend">${G()?.legend()||''}</div>`;
    ws=window.MPOPriceWorkspace?.create(el.querySelector('.cc-ws'),{onBytes:bytes,onFirstPaint:ms=>{firstPaintMs=ms;}});
    el.addEventListener('click',onClick);
    return el;
  }
  function patch(name,html){
    const node=rootEl?.querySelector(`[data-r="${name}"]`);if(!node||node._h===html)return;
    const active=document.activeElement,key=node.contains(active)?(active.closest('[data-focus]')?.dataset.focus||active.dataset?.overviewOpen):null,top=node.scrollTop;
    const opened=[...node.querySelectorAll('details[open][data-focus]')].map(d=>d.dataset.focus);
    node._h=html;node.innerHTML=html;node.scrollTop=top;
    for(const id of opened){const detail=node.querySelector(`details[data-focus="${CSS.escape(id)}"]`);if(detail)detail.open=true;}
    if(key){const again=node.querySelector(`[data-focus="${CSS.escape(key)}"] button, [data-focus="${CSS.escape(key)}"] summary, [data-overview-open="${CSS.escape(key)}"]`);again?.focus({preventScroll:true});}
  }
  function paint(){
    if(!rootEl)return;
    patch('strip',stripHTML(data));
    patch('msg',esc(pending?'Applying research settings…':message||error||(payloadView==='full'?'Summary view unavailable from this trader build; using the full payload.':'')));
    for(const b of rootEl.querySelectorAll('[data-cc-profile],[data-cc-refresh]'))b.disabled=pending;
    for(const b of rootEl.querySelectorAll('[data-cc-sys]')){const on=b.dataset.ccSys===sysTab;b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;}
    patch('sys',sysHTML(data));
  }
  function visible(){return !!rootEl&&rootEl.isConnected&&rootEl.offsetParent!==null&&!document.hidden;}
  function attach(){
    attachQueued=false;if(typeof document==='undefined'||!document.querySelectorAll)return;
    const mounts=[...document.querySelectorAll('[data-cc-mount]')];if(!mounts.length)return;
    const mount=mounts.find(m=>m.offsetParent!==null)||mounts[0];
    if(!rootEl){rootEl=build();firstLoadAt=performance.now();}
    if(rootEl.parentElement!==mount){mount.appendChild(rootEl);paint();if(data)ws?.update(data.markets?{...data.markets,at:data.at}:null);}
    if(!data&&!loading)load();
  }
  function html(){
    if(!attachQueued&&typeof queueMicrotask==='function'){attachQueued=true;queueMicrotask(attach);}
    return MOUNT;
  }

  // ---- Data -----------------------------------------------------------------------------------------------
  async function getJSON(path,timeout=10000){
    const r=await fetch(path,{signal:AbortSignal.timeout(timeout)});const t=await r.text();bytes(path,t.length);
    let body=null;try{body=JSON.parse(t);}catch{}
    return {status:r.status,ok:r.ok,body};
  }
  function compactPredictions(list){return arr(list).map(q=>({id:q.id,symbol:q.symbol,title:q.title,venue:q.venue,bid:q.bid,ask:q.ask,at:q.at,status:q.status,source:q.source,executable:q.executable}));}
  async function load(force=false){
    if(loading)return loading;if(!force&&Date.now()-lastAt<5000)return data;
    loading=(async()=>{
      try{
        const {ok,status,body}=await getJSON('/api/command-center?view=summary',15000);
        if(!ok)throw Error(`Coordination service HTTP ${status}`);
        if(body?.schema!=='mpo.command-center.v1')throw Error('Coordination status unavailable');
        payloadView=body.view==='summary'||body.markets?.coverage?'summary':'full';
        if(Array.isArray(body.markets?.predictions)){body.markets={...body.markets,predictions:compactPredictions(body.markets.predictions)};}
        data=body;error='';lastAt=Date.now();
        ws?.update({...body.markets,at:body.at});
      }catch(e){error=e.message;}
      finally{loading=null;paint();}
      side();
      return data;
    })();
    return loading;
  }
  async function side(){
    const now=Date.now(),jobs=[];
    if(now-procsAt>9000){procsAt=now;jobs.push(getJSON('/api/trader-processes').then(r=>{procs=r.ok?r.body:null;}).catch(()=>{procs=null;}));}
    if(now>coordMissingUntil&&now-coordAt>30000){coordAt=now;jobs.push(getJSON('/api/coordinator').then(r=>{if(r.status===404){coord=null;coordMissingUntil=now+300000;}else if(r.ok)coord=r.body;}).catch(()=>{}));}
    if(sysTab==='copy'&&now>funnelMissingUntil&&now-funnelAt>30000){funnelAt=now;jobs.push(getJSON('/api/copy-funnel').then(r=>{if(r.status===404){funnel=null;funnelMissingUntil=now+300000;}else if(r.ok)funnel=r.body;}).catch(()=>{}));}
    if(jobs.length){await Promise.allSettled(jobs);paint();}
  }
  async function onClick(e){
    const tab=e.target.closest('[data-cc-sys]');
    if(tab){sysTab=tab.dataset.ccSys;try{prefs()?.write('mpo-cc-systab',sysTab);}catch{}paint();if(sysTab==='copy')side();return;}
    const b=e.target.closest('[data-cc-profile],[data-cc-refresh]');if(!b||pending)return;
    if(b.hasAttribute('data-cc-refresh')){await load(true);ws?.refreshCharts();return;}
    pending=true;message='';paint();
    try{const r=await fetch('/api/command-center/research',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({profile:b.dataset.ccProfile}),signal:AbortSignal.timeout(8000)}),reply=await r.json();if(!r.ok||!reply.ok)throw Error(reply.error||'Settings not applied');message='Lab acknowledged '+reply.labProfile+'; trader setting queued. Applied profiles appear above.';await load(true);}
    catch(err){error=err.message;}
    finally{pending=false;paint();}
  }
  if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('keydown',e=>{
    const t=e.target;if(!t?.matches?.('[data-cc-sys]')||!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();
    const i=SYS_TABS.findIndex(x=>x[0]===sysTab),j=(i+(e.key==='ArrowRight'?1:-1)+SYS_TABS.length)%SYS_TABS.length;sysTab=SYS_TABS[j][0];paint();rootEl?.querySelector(`[data-cc-sys="${sysTab}"]`)?.focus();if(sysTab==='copy')side();
  });
  if(typeof addEventListener==='function')addEventListener('mpo:tab-change',e=>{if(e.detail?.host==='command'&&e.detail?.id==='command'){if(typeof queueMicrotask==='function')queueMicrotask(attach);load();}});
  if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('visibilitychange',()=>{if(visible()){load();ws?.refreshCharts();}});
  setInterval(()=>{if(!visible())return;load();ws?.refreshCharts();},10000);
  function metrics(){const now=Date.now(),win=traffic.filter(x=>now-x[0]<=60000);return {bytesPerMinute:win.reduce((n,x)=>n+x[1],0),requestsPerMinute:win.length,byPath:win.reduce((m,x)=>{const k=x[2].split('?')[0];m[k]=(m[k]||0)+x[1];return m;},{}),payloadView,firstPaintMs,domNodes:rootEl?rootEl.querySelectorAll('*').length:0,workspace:ws?.metrics?.()||null};}
  return {html,load,metrics,stripHTML,sysHTML,get data(){return data;}};
})();
