/* MPOPriceWorkspace — the Command Center's price workspace (2026-10-03).
   Real timestamped history from GET /api/market-history drawn with MPOChartKit; current values, change over the
   selected range, source and freshness per instrument. Contracts are accounted for by venue coverage, a group
   heatmap (GET /api/market-groups) and a virtualized list (GET /api/market-quotes) instead of thousands of lines.
   Nothing here simulates motion: a missing series says so, gaps stay gaps, and session closes are not live quotes.
   The DOM is built once and patched; cards are keyed by instrument id and keep their canvases across refreshes. */
window.MPOPriceWorkspace=(()=>{
  'use strict';
  const K=()=>window.MPOChartKit;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
  const arr=v=>Array.isArray(v)?v:[];
  const fmtN=v=>num(v)==null?'Unknown':v.toLocaleString('en-US');
  const MIN=60000,HOUR=3600000,DAY=86400000;
  const RANGES=[['1h',HOUR],['6h',6*HOUR],['24h',DAY],['7d',7*DAY],['Max',null]];
  const TABS=[['all','All markets'],['watch','Watchlist'],['crypto','Crypto'],['stocks','Stocks & ETFs'],['pump','Pump tokens'],['pred','Prediction markets']];
  const STALE={crypto:2*MIN,pump:10*MIN,contract:15*MIN};
  const REFRESH={'1h':20000,'6h':60000,'24h':120000,'7d':300000,'Max':300000};
  const ROW_H=30,PAGE=100,BATCH=40;
  const categoryOf=a=>a.venue==='Robinhood crypto'||String(a.id).startsWith('crypto:')?'crypto':a.venue==='Stocks & ETFs'||String(a.id).startsWith('equity:')?'stocks':/Pump/i.test(a.venue)||String(a.id).startsWith('pump:')?'pump':String(a.id).startsWith('contract:')?'contract':'other';
  const unitOf=a=>categoryOf(a)==='contract'?'PROB':a.currency==='SOL'?'SOL':'USD';
  const prefs=()=>window.MPOHud?.preferences;
  const readPref=(k,d)=>{try{return prefs()?.read(k,d)??d;}catch{return d;}};
  const writePref=(k,v)=>{try{prefs()?.write(k,v);}catch{}};

  // ---- Pure helpers (exported for tests) -------------------------------------------------------------
  function freshness(a,now=Date.now()){
    const cat=categoryOf(a);
    if(a.kind==='SESSION_CLOSE'||a.session&&!num(a.at))return {tone:'stale',label:`Session close ${a.session||''}`.trim(),title:'Daily session close; not a live quote'};
    if(!num(a.at))return {tone:'unknown',label:'Time unknown',title:'Observation time not reported'};
    const age=now-a.at,limit=STALE[cat]||STALE.contract;
    return {tone:age>limit?'stale':'fresh',label:K().formatAge(age),title:`Observed ${new Date(a.at).toLocaleString()}`};
  }
  const UNAVAILABLE={NO_TAPE:'No crypto tape recorded',NO_SESSION_BARS:'No session bars stored',NO_CAPTURED_TICKS:'No captured ticks (only the latest ~240 per watched token are kept)',NO_STORED_OBSERVATIONS:'No stored observations',NO_CONTRACT_STORE:'Contract store unavailable',INVALID_ID:'Not a history-capable id',INVALID_SYMBOL:'Symbol not in the tape'};
  const unavailableText=u=>u?(UNAVAILABLE[u]||String(u).replace(/_/g,' ').toLowerCase()):null;
  function sourceLabel(a){
    const s=String(a.source||'unknown source');
    if(categoryOf(a)==='crypto')return s==='v2'?'Robinhood BBO':s;
    if(categoryOf(a)==='stocks')return (s==='alpaca'?'Alpaca daily bars':s);
    if(categoryOf(a)==='pump')return 'Pump listing';
    return s==='market-metadata'?'Venue listing':s;
  }
  function currentValue(a){if(categoryOf(a)==='contract'){const b=num(a.bid),k=num(a.ask);return b!=null&&k!=null?(b+k)/2:k??b;}return num(a.price)??(num(a.bid)!=null&&num(a.ask)!=null?(a.bid+a.ask)/2:null);}
  function groupKeyOf(q){
    if(q.group)return q.group;
    if(q.venue==='kalshi'){const s=String(q.symbol||'').split('-')[0];return s||'Kalshi (unlabelled)';}
    return q.category||(q.venue==='polymarket'?'Polymarket (category not in summary)':String(q.venue||'Unknown venue'));
  }
  // Local fallback only, used while /api/market-groups is unavailable. Medians of observed mids; unknown stays unknown.
  function groupLocally(quotes,venue,now=Date.now()){
    const m=new Map();
    for(const q of quotes){if(venue&&venue!=='all'&&q.venue!==venue)continue;const key=q.venue+'|'+groupKeyOf(q);let g=m.get(key);if(!g){g={key,venue:q.venue,label:groupKeyOf(q),count:0,quoted:0,stale:0,mids:[],freshestAt:null};m.set(key,g);}g.count++;const mid=currentValue(q);if(mid!=null){g.quoted++;g.mids.push(mid);}if(num(q.at)&&now-q.at>STALE.contract)g.stale++;if(num(q.at)&&(g.freshestAt==null||q.at>g.freshestAt))g.freshestAt=q.at;}
    return [...m.values()].map(g=>{const s=g.mids.sort((a,b)=>a-b);return {key:g.key,venue:g.venue,label:g.label,count:g.count,quoted:g.quoted,stale:g.stale,medianMid:s.length?s[Math.floor(s.length/2)]:null,change:null,freshestAt:g.freshestAt};}).sort((a,b)=>b.count-a.count||String(a.label).localeCompare(String(b.label)));
  }
  function coverageLocally(quotes,now=Date.now()){
    const out={};for(const q of quotes){const v=out[q.venue]||(out[q.venue]={total:0,quoted:0,stale:0,unknown:0,executable:0,withHistory:null});v.total++;if(currentValue(q)==null)v.unknown++;else v.quoted++;if(num(q.at)&&now-q.at>STALE.contract)v.stale++;if(q.executable)v.executable++;}
    return out;
  }
  function filterQuotes(quotes,{venue,group,q}){
    const needle=String(q||'').trim().toLowerCase();
    return quotes.filter(x=>(!venue||venue==='all'||x.venue===venue)&&(!group||x.venue+'|'+groupKeyOf(x)===group)&&(!needle||String(x.title||'').toLowerCase().includes(needle)||String(x.symbol||'').toLowerCase().includes(needle)));
  }
  function seriesList(body){
    if(!body)return [];if(Array.isArray(body))return body;
    for(const k of ['series','items','results','history'])if(Array.isArray(body[k]))return body[k];
    if(typeof body==='object'&&!body.error)return Object.entries(body).filter(([,v])=>v&&typeof v==='object'&&(v.points||v.unavailable)).map(([id,v])=>({id,...v}));
    return [];
  }
  function rowsOf(body){for(const k of ['rows','quotes','items','contracts'])if(Array.isArray(body?.[k]))return body[k];return Array.isArray(body)?body:[];}
  function groupsOf(body){for(const k of ['groups','rows','items'])if(Array.isArray(body?.[k]))return body[k];return Array.isArray(body)?body:[];}
  function normalizeGroup(g){const label=g.label??g.title??g.group??g.key??g.id;return {key:g.key??g.id??((g.venue||'')+'|'+label),venue:g.venue||null,label:String(label??'Unlabelled'),count:num(g.count)??num(g.total),quoted:num(g.quoted),stale:num(g.stale),medianMid:num(g.medianMid)??num(g.median),change:num(g.change)??num(g.change?.median),changeMeasured:num(g.change?.measured),freshestAt:num(g.freshestAt)??num(g.freshest)??num(g.at),omitted:num(g.omitted)??num(g.change?.omitted),omittedReason:g.omittedReason||g.change?.omittedReason||null};}

  // ---- Workspace -------------------------------------------------------------------------------------
  function create(host,opts={}){
    const state={
      tab:readPref('mpo-cc-tab','all'),range:readPref('mpo-cc-range','24h'),q:'',venue:readPref('mpo-cc-venue','all'),group:null,
      watch:new Set(arr(readPref('mpo-cc-watch',[])).filter(x=>typeof x==='string').slice(0,300)),selected:readPref('mpo-cc-selected',null)
    };
    if(!TABS.some(t=>t[0]===state.tab))state.tab='all';if(!RANGES.some(r=>r[0]===state.range))state.range='24h';
    let assets=[],byId=new Map(),coverage={},fallbackQuotes=null,summaryAt=null;
    const contractRows=new Map();             // id -> latest quote row seen (list pages / fallback)
    const history=new Map();                  // key id|range -> {series, at, error}
    let historyApi=null,historyRetryAt=0;     // null unknown, true available, false missing (404)
    let groupsApi=null,quotesApi=null,groups=null,groupsAt=0,groupsBusy=false;
    const pages=new Map();let total=null,listKey='',listBusy=new Set(),selectedIndex=-1,pagesAt=0;
    const queue=new Set();let flushTimer=0,firstPaint=null;const createdAt=performance.now();
    const bytes=opts.onBytes||(()=>{});

    host.innerHTML=`<section class="pw" aria-label="Price workspace">
      <div class="pw-bar"><label class="pw-market-select"><select aria-label="Market workspace">${TABS.map(([k,l])=>`<option value="${k}">${esc(l)}</option>`).join('')}</select></label><div class="pw-tabs" role="tablist" aria-label="Market groups"></div>
        <div class="pw-tools"><div class="pw-range" role="group" aria-label="Time range for every chart"></div>
        <input class="pw-search" type="search" placeholder="Search symbols or contracts" aria-label="Search instruments and contracts" spellcheck="false"></div></div>
      <div class="pw-coverage" aria-live="polite"></div>
      <div class="pw-view pw-all" data-view="all"></div>
      <div class="pw-view pw-grid" data-view="grid" role="list"></div>
      <div class="pw-view pw-pred" data-view="pred">
        <div class="pw-pred-top"><div class="pw-venues" role="group" aria-label="Venue"></div><span class="pw-group-chip" hidden></span></div>
        <div class="pw-heat-wrap"><canvas class="pw-heat"></canvas><div class="pw-heat-read" aria-live="polite"></div></div>
        <div class="pw-pred-split"><div class="pw-list" role="listbox" tabindex="0" aria-label="Contracts"><div class="pw-list-space"></div></div><div class="pw-detail" aria-live="polite"></div></div>
      </div>
      <p class="pw-readout mpd-visually-hidden" aria-live="polite"></p></section>`;
    const $=s=>host.querySelector(s);
    const el={tabs:$('.pw-tabs'),range:$('.pw-range'),search:$('.pw-search'),coverage:$('.pw-coverage'),all:$('.pw-all'),grid:$('.pw-grid'),pred:$('.pw-pred'),venues:$('.pw-venues'),chip:$('.pw-group-chip'),heat:$('.pw-heat'),heatRead:$('.pw-heat-read'),list:$('.pw-list'),space:$('.pw-list-space'),detail:$('.pw-detail'),readout:$('.pw-readout')};
    const set=(node,html)=>{if(node._h!==html){const active=document.activeElement,key=node.contains(active)?active.dataset?.pwTab??active.dataset?.pwVenue??active.dataset?.id:null;node._h=html;node.innerHTML=html;if(key){[...node.querySelectorAll('button')].find(b=>(b.dataset.pwTab??b.dataset.pwVenue??b.dataset.id)===key)?.focus({preventScroll:true});}}};
    const text=(node,t)=>{if(node&&node.textContent!==t)node.textContent=t;};

    // Range + tabs (buttons are built once; state shown with aria-pressed / aria-selected).
    el.range.innerHTML=RANGES.map(([k])=>`<button type="button" data-pw-range="${k}">${k}</button>`).join('');
    function paintControls(){
      $('.pw-market-select select').value=state.tab;
      for(const b of el.range.children)b.setAttribute('aria-pressed',String(b.dataset.pwRange===state.range));
      const counts={all:assets.length+contractTotal(),watch:state.watch.size,crypto:assets.filter(a=>categoryOf(a)==='crypto').length,stocks:assets.filter(a=>categoryOf(a)==='stocks').length,pump:assets.filter(a=>categoryOf(a)==='pump').length,pred:contractTotal()};
      set(el.tabs,TABS.map(([k,l])=>`<button type="button" role="tab" data-pw-tab="${k}" aria-selected="${k===state.tab}" tabindex="${k===state.tab?0:-1}">${esc(l)} <span class="pw-count">${counts[k]==null?'?':fmtN(counts[k])}</span></button>`).join(''));
      const vs=[['all','All venues'],...Object.keys(coverage).map(v=>[v,v==='kalshi'?'Kalshi':v==='polymarket'?'Polymarket':v==='polymarket-us'?'Polymarket US':v])];
      set(el.venues,vs.map(([k,l])=>`<button type="button" data-pw-venue="${esc(k)}" aria-pressed="${k===state.venue}">${esc(l)}${k==='all'?'':` <span class="pw-count">${fmtN(coverage[k]?.total)}</span>`}</button>`).join(''));
    }
    const contractTotal=()=>{const vs=Object.values(coverage);return vs.length?vs.reduce((n,v)=>n+(num(v.total)||0),0):null;};
    const rangeMs=()=>RANGES.find(r=>r[0]===state.range)?.[1]??null;
    const window_=()=>{const now=Date.now(),r=rangeMs();return {from:r?now-r:null,to:now};};

    // ---- Cards ----------------------------------------------------------------------------------------
    const cards=new Map();
    const cardObserver=typeof IntersectionObserver==='function'?new IntersectionObserver(es=>{for(const e of es){const c=e.target._card;if(c){c.visible=e.isIntersecting;if(c.visible)need(c.id);}}},{root:null,rootMargin:'80px'}):null;
    function instrument(id){return byId.get(id)||contractRows.get(id)||(id.startsWith('contract:')?{id,venue:id.split(':')[1],title:id.split(':').slice(2).join(':'),symbol:id.split(':').slice(2).join(':')}:{id,symbol:id});}
    function card(id){
      let c=cards.get(id);if(c)return c;
      const node=document.createElement('article');node.className='pw-card';node.dataset.id=id;node.setAttribute('role','listitem');
      node.innerHTML=`<header><b class="pw-sym"></b><button type="button" class="pw-star" data-pw-star aria-pressed="false" title="Add to watchlist">☆</button><span class="pw-val mpd-num"></span><span class="pw-chg mpd-num"></span></header><canvas class="pw-chart"></canvas><footer><span class="pw-src"></span><span class="pw-age"></span></footer>`;
      c={id,node,visible:false,sym:node.querySelector('.pw-sym'),star:node.querySelector('.pw-star'),val:node.querySelector('.pw-val'),chg:node.querySelector('.pw-chg'),src:node.querySelector('.pw-src'),age:node.querySelector('.pw-age'),canvas:node.querySelector('canvas'),chart:null,inspecting:false};
      node._card=c;c.star.dataset.id=id;cards.set(id,c);cardObserver?.observe(node);
      c.chart=K().chart(c.canvas,{type:'spark',series:null});
      return c;
    }
    function paintCard(c){
      const a=instrument(c.id),cat=categoryOf(a),unit=unitOf(a),h=history.get(c.id+'|'+state.range),series=h?.series||null,{from,to}=window_();
      text(c.sym,cat==='contract'?(a.title||a.symbol||c.id):(a.symbol||c.id));c.sym.title=cat==='contract'?`${a.venue||''} · ${a.symbol||''}\n${a.title||''}`:`${a.symbol} · ${a.venue}`;
      const watched=state.watch.has(c.id);text(c.star,watched?'★':'☆');c.star.setAttribute('aria-pressed',String(watched));c.star.title=watched?'Remove from watchlist':'Add to watchlist';c.star.setAttribute('aria-label',(watched?'Remove ':'Add ')+(a.symbol||c.id)+(watched?' from':' to')+' watchlist');
      const ch=series?K().changeOver(series.points.filter(p=>from==null||p.t>=from)):null;
      if(!c.inspecting){
        const v=currentValue(a)??(series?.points?.length?series.points[series.points.length-1].mid:null);
        text(c.val,cat==='contract'?(v==null?'Unknown':'YES '+K().formatValue(v,'PROB')):K().formatValue(v,unit));
        const f=freshness(a);text(c.age,f.label);c.age.className='pw-age '+f.tone;c.age.title=f.title;
        text(c.src,sourceLabel(a)+(series?.session?' · daily':''));
      }
      text(c.chg,ch?K().formatChange(ch.abs,ch.pct,unit)+' '+state.range:series?'':'');
      c.chg.className='pw-chg mpd-num '+(ch?(ch.abs>0?'up':ch.abs<0?'down':''):'');
      c.chg.title=ch?`Change from first to last observation in the ${state.range} window`:'';
      const empty=historyApi===false?'History service not installed yet':h?.error?'History request failed':series?.unavailable?unavailableText(series.unavailable):h?'No observations in range':'Loading history…';
      c.chart.set({type:c.node.classList.contains('big')?'line':'spark',axes:'auto',unit,series,from:from??series?.points?.[0]?.t??null,to,band:true,empty,label:`${a.symbol||a.title||c.id} ${state.range} history`,onInspect:p=>{c.inspecting=!!p;if(!p){paintCard(c);return;}const span=(to-(from??(series?.points?.[0]?.t||to)));text(c.val,K().formatValue(p.mid,unit));text(c.age,K().formatTime(p.t,span));text(c.src,num(p.bid)!=null||num(p.ask)!=null?`bid ${K().formatValue(p.bid,unit)} · ask ${K().formatValue(p.ask,unit)}`:num(p.o)!=null?`O ${K().formatValue(p.o,unit)} H ${K().formatValue(p.h,unit)} L ${K().formatValue(p.l,unit)}`:'mid only');text(el.readout,`${a.symbol||c.id} ${K().formatTime(p.t,span)} ${K().formatValue(p.mid,unit)}`);}});
      if(h&&!firstPaint&&series?.points?.length){firstPaint=performance.now()-createdAt;opts.onFirstPaint?.(firstPaint);}
    }

    // ---- History requests (visible cards only, batched, refreshed by range) -------------------------
    function need(id){
      const h=history.get(id+'|'+state.range);if(h&&Date.now()-h.at<(REFRESH[state.range]||60000))return;
      if(historyApi===false&&Date.now()<historyRetryAt)return;
      queue.add(id);if(!flushTimer)flushTimer=setTimeout(flush,120);
    }
    async function flush(){
      flushTimer=0;const ids=[...queue].slice(0,BATCH);ids.forEach(id=>queue.delete(id));if(!ids.length)return;
      const range=state.range,{from,to}=window_(),points=cards.get(ids[0])?.node.classList.contains('big')?360:160;
      const qs=new URLSearchParams({ids:ids.join(','),points:String(points)});if(from!=null)qs.set('from',String(Math.floor(from)));qs.set('to',String(Math.floor(to)));
      try{
        const r=await fetch('/api/market-history?'+qs,{signal:AbortSignal.timeout(15000)});
        if(r.status===404){historyApi=false;historyRetryAt=Date.now()+60000;for(const id of ids)history.set(id+'|'+range,{series:null,at:Date.now(),missing:true});}
        else{const t=await r.text();bytes('/api/market-history',t.length);if(!r.ok)throw Error('HTTP '+r.status);historyApi=true;const list=seriesList(JSON.parse(t));const got=new Map(list.map(s=>[s.id,s]));for(const id of ids){const raw=got.get(id);history.set(id+'|'+range,{series:raw?K().normalizeSeries(raw):{id,unit:'USD',points:[],candles:[],gaps:[],unavailable:'Not returned by the history service'},at:Date.now()});}}
      }catch(e){for(const id of ids)history.set(id+'|'+range,{series:null,at:Date.now()-((REFRESH[range]||60000)-15000),error:e.message});}
      for(const id of ids){const c=cards.get(id);if(c)paintCard(c);if(id===state.selected)paintDetail();}
      paintCoverage();
      if(queue.size&&!flushTimer)flushTimer=setTimeout(flush,60);
    }

    // ---- Views -----------------------------------------------------------------------------------------
    function place(container,ids,big=false){
      const want=ids.map(id=>card(id).node);
      for(const n of want)n.classList.toggle('big',big);
      const current=[...container.children];
      if(current.length!==want.length||current.some((n,i)=>n!==want[i])){const frag=document.createDocumentFragment();want.forEach(n=>frag.appendChild(n));container.replaceChildren(frag);}
      for(const id of ids)paintCard(cards.get(id));
    }
    function matches(a,needle){return !needle||String(a.symbol||'').toLowerCase().includes(needle)||String(a.title||'').toLowerCase().includes(needle)||String(a.venue||'').toLowerCase().includes(needle);}
    function idsFor(cat){const needle=state.q.trim().toLowerCase();const list=assets.filter(a=>(cat==='any'||categoryOf(a)===cat)&&matches(a,needle));const w=list.filter(a=>state.watch.has(a.id)),o=list.filter(a=>!state.watch.has(a.id));return [...w,...o].map(a=>a.id);}
    function showView(name){for(const v of host.querySelectorAll('.pw-view'))v.hidden=v.dataset.view!==name;}
    function paintAll(){
      // One band per market family. Each band says how many it shows of how many; nothing is dropped silently.
      const bands=[['crypto','Crypto','Robinhood crypto BBO'],['stocks','Stocks & ETFs','daily session bars'],['pump','Pump tokens','captured listings']];
      if(!el.all._built){el.all.innerHTML=bands.map(([k,l])=>`<section class="pw-band" data-band="${k}"><div class="pw-band-head"><h4>${esc(l)}</h4><span class="pw-band-count"></span><button type="button" class="pw-more" data-pw-tab="${k}">View all</button></div><div class="pw-band-cards" role="list"></div></section>`).join('')+`<section class="pw-band pw-band-pred" data-band="pred"><div class="pw-band-head"><h4>Prediction markets</h4><span class="pw-band-count"></span><button type="button" class="pw-more" data-pw-tab="pred">Open list</button></div><canvas class="pw-heat-mini"></canvas><div class="pw-heat-mini-read pw-note" aria-live="polite"></div></section>`;el.all._built=true;
        el.miniHeat=K().chart(el.all.querySelector('.pw-heat-mini'),{type:'heat',cells:[]});
        if(typeof ResizeObserver==='function'){el.allRO=new ResizeObserver(()=>{if(state.tab==='all'&&!state.q)paintAll();});el.allRO.observe(el.all);}
      }
      for(const [k,,note] of bands){
        const band=el.all.querySelector(`[data-band="${k}"]`),box=band.querySelector('.pw-band-cards'),ids=idsFor(k);
        const width=box.clientWidth||600,fit=Math.max(1,Math.floor((width+8)/200)),show=ids.slice(0,fit);
        place(box,show);text(band.querySelector('.pw-band-count'),ids.length?`${show.length} of ${fmtN(ids.length)} shown · ${note}${ids.length>show.length?(state.watch.size?' · watchlist first':' · feed order'):''}`:'None reported');
      }
      paintMiniHeat();
    }
    function heatCells(list){return list.map(g=>({key:g.key,label:g.label,value:g.medianMid,sub:`${fmtN(g.count)} · ${g.medianMid==null?'no quote':'median '+Math.round(g.medianMid*100)+'¢'}`,group:g}));}
    function describeGroup(g){if(!g)return '';return `${g.label} · ${g.venue||''} · ${fmtN(g.count)} contracts · ${fmtN(g.quoted)} quoted${num(g.stale)?` · ${fmtN(g.stale)} stale`:''} · median YES mid ${g.medianMid==null?'Unknown':Math.round(g.medianMid*100)+'¢'}${num(g.change)!=null?` · change ${K().formatChange(g.change,null,'PROB')}`:''}${g.omitted?` · ${g.omitted} omitted (${g.omittedReason||'reason not given'})`:''}`;}
    function paintMiniHeat(){
      const band=el.all.querySelector('[data-band="pred"]');if(!band)return;const gs=currentGroups();
      const cov=Object.entries(coverage).map(([v,c])=>`${v==='kalshi'?'Kalshi':v==='polymarket'?'Polymarket':v} ${fmtN(c.total)}`).join(' · ');
      text(band.querySelector('.pw-band-count'),gs?`${fmtN(contractTotal())} contracts in ${fmtN(gs.length)} groups · ${cov}`:cov||'Contract coverage not reported');
      el.miniHeat.set({type:'heat',cells:heatCells(gs||[]),minCellW:gs&&gs.length>60?26:64,label:'Contract groups by median YES price',empty:groupsBusy?'Loading groups…':'Groups not reported',onInspect:cell=>text(band.querySelector('.pw-heat-mini-read'),cell?describeGroup(cell.group):'Colour = median YES mid (darker = higher); hatched = no quote. Select a group to list its contracts.'),onSelect:cell=>{state.tab='pred';state.group=cell.key;state.venue=cell.group.venue||'all';resetList();paint();}});
      if(!band.querySelector('.pw-heat-mini-read').textContent)text(band.querySelector('.pw-heat-mini-read'),'Colour = median YES mid (darker = higher); hatched = no quote. Select a group to list its contracts.');
    }
    function paintGrid(){
      const needle=state.q.trim().toLowerCase();
      let ids;
      if(state.tab==='watch')ids=[...state.watch].filter(id=>matches(instrument(id),needle));
      else if(state.tab==='all')ids=idsFor('any');
      else ids=idsFor(state.tab);
      if(!ids.length){el.grid.innerHTML=`<p class="pw-empty">${state.tab==='watch'?'Your watchlist is empty. Use ☆ on any card or contract to add it.':state.q?'No instruments match this search.':'No instruments reported for this group.'}</p>`;return;}
      if(el.grid.querySelector('.pw-empty'))el.grid.replaceChildren();
      place(el.grid,ids,ids.length<=16);
    }

    // ---- Prediction markets: groups heatmap + virtualized list + detail --------------------------------
    function currentGroups(){
      if(groups&&groupsApi)return state.venue==='all'?groups:groups.filter(g=>!g.venue||g.venue===state.venue);
      if(fallbackQuotes)return groupLocally(fallbackQuotes,state.venue);
      return groups;
    }
    async function loadGroups(force){
      if(groupsBusy||groupsApi===false&&!force||!force&&Date.now()-groupsAt<60000)return;
      groupsBusy=true;groupsAt=Date.now();
      try{const r=await fetch('/api/market-groups?by=category&window='+encodeURIComponent(state.range==='Max'?'7d':state.range),{signal:AbortSignal.timeout(15000)});if(r.status===404){groupsApi=false;return;}const t=await r.text();bytes('/api/market-groups',t.length);if(!r.ok)throw Error('HTTP '+r.status);groupsApi=true;groups=groupsOf(JSON.parse(t)).map(normalizeGroup);}
      catch{/* keep previous groups; the band says when none are available */}
      finally{groupsBusy=false;if(state.tab==='pred')paintPred();else if(state.tab==='all')paintMiniHeat();}
    }
    const listParams=()=>({venue:state.venue,group:state.group,q:state.q.trim()});
    function resetList(){pages.clear();total=null;selectedIndex=-1;pagesAt=Date.now();listKey=JSON.stringify(listParams());el.list.scrollTop=0;}
    async function loadPage(p){
      const key=listKey,busyKey=key+'|'+p;if(pages.has(p)||listBusy.has(busyKey))return;
      if(quotesApi!==false){
        listBusy.add(busyKey);
        try{const qs=new URLSearchParams({offset:String(p*PAGE),limit:String(PAGE)});const lp=listParams();if(lp.venue&&lp.venue!=='all')qs.set('venue',lp.venue);if(lp.group)qs.set('group',lp.group);if(lp.q)qs.set('q',lp.q);
          const r=await fetch('/api/market-quotes?'+qs,{signal:AbortSignal.timeout(15000)});
          if(r.status===404){quotesApi=false;}else{const t=await r.text();bytes('/api/market-quotes',t.length);if(!r.ok)throw Error('HTTP '+r.status);quotesApi=true;const body=JSON.parse(t);if(key!==listKey)return;const rows=rowsOf(body);rows.forEach(x=>contractRows.set(x.id,x));pages.set(p,rows);total=num(body.total)??num(body.count)??(rows.length<PAGE?p*PAGE+rows.length:total);}
        }catch(e){if(key===listKey)pages.set(p,{error:e.message});}
        finally{listBusy.delete(busyKey);}
      }
      if(quotesApi===false&&fallbackQuotes){const all=filterQuotes(fallbackQuotes,listParams());total=all.length;for(let i=0;i*PAGE<Math.max(1,all.length);i++)pages.set(i,all.slice(i*PAGE,(i+1)*PAGE));}
      if(key===listKey)paintList();
    }
    function rowAt(i){const pg=pages.get(Math.floor(i/PAGE));return Array.isArray(pg)?pg[i%PAGE]:null;}
    function paintList(){
      const n=total??0;el.space.style.height=Math.max(n,1)*ROW_H+'px';
      const top=el.list.scrollTop,h=el.list.clientHeight||300,start=Math.max(0,Math.floor(top/ROW_H)-6),end=Math.min(n,Math.ceil((top+h)/ROW_H)+6);
      for(let p=Math.floor(start/PAGE);p<=Math.floor(Math.max(start,end-1)/PAGE);p++)if(!pages.has(p))loadPage(p);
      if(total==null){set(el.space,`<p class="pw-empty">${quotesApi===false&&!fallbackQuotes?'Contract list service not installed yet and no contract rows in this payload.':'Loading contracts…'}</p>`);return;}
      if(!n){set(el.space,'<p class="pw-empty">No contracts match.</p>');return;}
      let html='';
      for(let i=start;i<end;i++){
        const q=rowAt(i);
        if(!q){html+=`<div class="pw-row pending" style="top:${i*ROW_H}px">Loading…</div>`;continue;}
        const f=freshness({...q,id:q.id||'contract:'}),w=state.watch.has(q.id),sel=q.id===state.selected,b=num(q.bid),a=num(q.ask);
        html+=`<div class="pw-row${sel?' sel':''}" role="option" aria-selected="${sel}" data-pw-row="${esc(q.id)}" style="top:${i*ROW_H}px"><button type="button" class="pw-star" data-pw-star data-id="${esc(q.id)}" aria-pressed="${w}" aria-label="${w?'Remove from':'Add to'} watchlist">${w?'★':'☆'}</button><span class="pw-row-title" title="${esc(q.title||q.symbol)}">${esc(q.title||q.symbol||q.id)}</span><span class="pw-row-q mpd-num" title="YES bid / ask">${b==null&&a==null?'<i class="mpd-unknown">Unknown</i>':`${b==null?'?':Math.round(b*1000)/10}¢ / ${a==null?'?':Math.round(a*1000)/10}¢`}</span><span class="pw-row-age ${f.tone}" title="${esc(f.title)}">${esc(f.label)}</span><span class="pw-row-venue">${esc(q.venue==='kalshi'?'Kalshi':q.venue==='polymarket'?'Polymarket':q.venue)}${q.executable?' · executable':''}</span></div>`;
      }
      set(el.space,html);
    }
    let detailChart=null;
    function paintDetail(){
      const id=state.selected;
      if(!id||!id.startsWith('contract:')){detailChart?.destroy();set(el.detail,'<p class="pw-empty">Select a contract to see its YES price history, bid/ask band and source.</p>');detailChart=null;return;}
      const q=instrument(id),key=id+'|'+state.range,h=history.get(key),{from,to}=window_();
      if(!el.detail.querySelector(`canvas[data-for="${CSS.escape(id)}"]`)){
        detailChart?.destroy();
        el.detail._h=null;el.detail.innerHTML=`<div class="pw-detail-head"><b class="pw-detail-title"></b><button type="button" class="pw-star" data-pw-star data-id="${esc(id)}"></button></div><div class="pw-detail-meta"></div><canvas class="pw-detail-chart" data-for="${esc(id)}"></canvas><div class="pw-detail-foot"></div>`;
        detailChart=K().chart(el.detail.querySelector('canvas'),{type:'line'});
      }
      const w=state.watch.has(id),star=el.detail.querySelector('.pw-star');text(star,w?'★ Watching':'☆ Watch');star.setAttribute('aria-pressed',String(w));
      text(el.detail.querySelector('.pw-detail-title'),q.title||q.symbol||id);
      const f=freshness(q),b=num(q.bid),a=num(q.ask);
      text(el.detail.querySelector('.pw-detail-meta'),`${q.venue==='kalshi'?'Kalshi':q.venue==='polymarket'?'Polymarket':q.venue||'Venue unknown'} · ${q.symbol||''} · YES ${b==null?'?':(b*100).toFixed(1)+'¢'} / ${a==null?'?':(a*100).toFixed(1)+'¢'} · ${f.label} · ${q.status||'status unknown'}`);
      text(el.detail.querySelector('.pw-detail-foot'),`${sourceLabel(q)}${q.executable?'':' · listing price, not an executable fill'} · axis in ¢ probability`);
      detailChart?.set({type:'line',unit:'PROB',series:h?.series||null,from:from??h?.series?.points?.[0]?.t??null,to,band:true,label:`${q.title||id} YES price`,empty:historyApi===false?'History service not installed yet':unavailableText(h?.series?.unavailable)||(h?'No observations in range':'Loading history…')});
      if(!h||Date.now()-h.at>(REFRESH[state.range]||60000))need(id);
    }
    function paintPred(){
      if(listKey!==JSON.stringify(listParams()))resetList();
      const gs=currentGroups();
      if(!el.heatChart)el.heatChart=K().chart(el.heat,{type:'heat',cells:[]});
      el.heatChart.set({type:'heat',cells:heatCells(gs||[]),minCellW:gs&&gs.length>80?30:gs&&gs.length>30?56:96,label:'Contract groups',empty:groupsBusy?'Loading groups…':'Groups not reported',onInspect:cell=>text(el.heatRead,cell?describeGroup(cell.group):groupHint(gs)),onSelect:cell=>{state.group=state.group===cell.key?null:cell.key;resetList();paintPred();}});
      if(!el.heatRead.textContent||!el.heatRead._hover)text(el.heatRead,groupHint(gs));
      const g=state.group&&gs?.find(x=>x.key===state.group);
      el.chip.hidden=!state.group;if(state.group)set(el.chip,`Group: ${esc(g?.label||state.group)} <button type="button" data-pw-clear-group aria-label="Clear group filter">×</button>`);
      paintList();paintDetail();
    }
    const groupHint=gs=>gs?`${fmtN(gs.length)} groups · colour = median YES mid, hatched = no quote${groupsApi?'':' · grouped locally by series (group service not installed yet)'} · click or Enter to filter the list`:'Groups not reported';

    // ---- Coverage line ------------------------------------------------------------------------------------
    function paintCoverage(){
      const hs=[...history.entries()].filter(([k])=>k.endsWith('|'+state.range)).map(([,v])=>v),withPts=hs.filter(h=>h.series?.points?.length||h.series?.candles?.length).length,unav=hs.filter(h=>h.series&&!h.series.points?.length&&!h.series.candles?.length).length;
      const hist=historyApi===false?'history service not installed in this build — current values only':hs.length?`${withPts} of ${hs.length} requested series have history in ${state.range}${unav?` · ${unav} unavailable`:''}`:'history loads for visible charts';
      let lead;
      const cov=Object.entries(coverage),ct=contractTotal();
      if(state.tab==='pred'){lead=cov.map(([v,c])=>`${v==='kalshi'?'Kalshi':v==='polymarket'?'Polymarket':v}: ${fmtN(c.total)} total · ${fmtN(c.quoted)} quoted · ${fmtN(c.stale)} stale · ${fmtN(c.unknown)} unknown · ${c.executable==null?'?':fmtN(c.executable)} executable · ${c.withHistory==null?'history ?':fmtN(c.withHistory)+' with history'}`).join('  |  ')||'Contract coverage not reported';}
      else{const n=state.tab==='watch'?state.watch.size:state.tab==='all'?assets.length:assets.filter(a=>categoryOf(a)===state.tab).length;lead=`${fmtN(n)} ${state.tab==='watch'?'watched':'tracked'} instruments${state.tab==='all'&&ct!=null?` + ${fmtN(ct)} contracts`:''}`;}
      text(el.coverage,`${lead} · ${hist}${summaryAt?` · snapshot ${K().formatAge(Date.now()-summaryAt)}`:''}`);
    }

    function paint(){
      paintControls();
      const view=state.tab==='pred'?'pred':state.tab==='all'&&!state.q?'all':'grid';showView(view);
      if(view==='all')paintAll();else if(view==='grid')paintGrid();else{loadGroups();paintPred();}
      if(state.tab==='all')loadGroups();
      paintCoverage();
      for(const c of cards.values())if(c.visible&&c.node.isConnected)need(c.id);
    }

    // ---- Events -----------------------------------------------------------------------------------------
    host.addEventListener('click',e=>{
      const t=e.target.closest('button,[data-pw-row]');if(!t||!host.contains(t))return;
      if(t.dataset.pwTab){state.tab=t.dataset.pwTab;writePref('mpo-cc-tab',state.tab);paint();host.querySelector(`[data-pw-tab="${state.tab}"][role=tab]`)?.focus();return;}
      if(t.dataset.pwRange){state.range=t.dataset.pwRange;writePref('mpo-cc-range',state.range);groupsAt=0;paint();return;}
      if(t.dataset.pwVenue){state.venue=t.dataset.pwVenue;state.group=null;writePref('mpo-cc-venue',state.venue);resetList();paint();return;}
      if(t.hasAttribute('data-pw-clear-group')){state.group=null;resetList();paintPred();return;}
      if(t.hasAttribute('data-pw-star')){const id=t.dataset.id||t.closest('[data-id]')?.dataset.id;if(!id)return;if(state.watch.has(id))state.watch.delete(id);else state.watch.add(id);writePref('mpo-cc-watch',[...state.watch]);const c=cards.get(id);if(c)paintCard(c);paintControls();if(state.tab==='pred'){el.space._h=null;paintList();paintDetail();}else if(state.tab==='watch')paintGrid();return;}
      if(t.dataset.pwRow){state.selected=t.dataset.pwRow;selectedIndex=Math.round(parseFloat(t.style.top)/ROW_H);writePref('mpo-cc-selected',state.selected);el.space._h=null;paintList();paintDetail();}
    });
    el.tabs.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const i=TABS.findIndex(t=>t[0]===state.tab),n=TABS.length,j=e.key==='Home'?0:e.key==='End'?n-1:(i+(e.key==='ArrowRight'?1:-1)+n)%n;state.tab=TABS[j][0];writePref('mpo-cc-tab',state.tab);paint();el.tabs.querySelector(`[data-pw-tab="${state.tab}"]`)?.focus();});
    $('.pw-market-select select').addEventListener('change',e=>{state.tab=e.target.value;writePref('mpo-cc-tab',state.tab);paint();});
    let searchTimer=0;
    el.search.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.q=el.search.value;if(state.tab==='pred')resetList();paint();},180);});
    el.list.addEventListener('scroll',()=>{if(!el.list._raf)el.list._raf=requestAnimationFrame(()=>{el.list._raf=0;paintList();});},{passive:true});
    el.list.addEventListener('keydown',e=>{
      if(!['ArrowDown','ArrowUp','Enter','Home','End','PageDown','PageUp'].includes(e.key))return;e.preventDefault();
      const n=total||0;if(!n)return;let i=selectedIndex;if(i<0){for(const [page,rows] of pages)if(Array.isArray(rows)){const k=rows.findIndex(r=>r.id===state.selected);if(k>=0){i=page*PAGE+k;break;}}}
      const step={ArrowDown:1,ArrowUp:-1,PageDown:10,PageUp:-10}[e.key];i=e.key==='Home'?0:e.key==='End'?n-1:Math.max(0,Math.min(n-1,(i<0?0:i)+(step||0)));
      const q=rowAt(i);if(!q){el.list.scrollTop=i*ROW_H;paintList();return;}selectedIndex=i;state.selected=q.id;writePref('mpo-cc-selected',state.selected);
      if(i*ROW_H<el.list.scrollTop)el.list.scrollTop=i*ROW_H;else if((i+1)*ROW_H>el.list.scrollTop+el.list.clientHeight)el.list.scrollTop=(i+1)*ROW_H-el.list.clientHeight;
      el.space._h=null;paintList();paintDetail();text(el.readout,`${q.title||q.symbol} YES ${num(q.bid)==null?'?':(q.bid*100).toFixed(1)}¢ / ${num(q.ask)==null?'?':(q.ask*100).toFixed(1)}¢`);
    });
    el.heat.addEventListener('pointerenter',()=>{el.heatRead._hover=true;});el.heat.addEventListener('pointerleave',()=>{el.heatRead._hover=false;});

    // ---- Public -----------------------------------------------------------------------------------------
    function update(snapshot){
      assets=arr(snapshot?.assets);byId=new Map(assets.map(a=>[a.id,a]));summaryAt=num(snapshot?.at);
      if(Array.isArray(snapshot?.predictions)){fallbackQuotes=snapshot.predictions;for(const q of fallbackQuotes)contractRows.set(q.id,q);}
      coverage=snapshot?.coverage&&typeof snapshot.coverage==='object'?snapshot.coverage:fallbackQuotes?coverageLocally(fallbackQuotes):{};
      if(fallbackQuotes&&quotesApi===false){resetList();}
      paint();
    }
    function refreshCharts(){for(const c of cards.values())if(c.visible&&c.node.isConnected)need(c.id);if(state.tab==='pred'&&state.selected)need(state.selected);if(state.tab==='pred'||state.tab==='all')loadGroups();if(state.tab==='pred'&&Date.now()-pagesAt>30000){pagesAt=Date.now();pages.clear();paintList();}}
    function metrics(){return {cards:cards.size,firstPaintMs:firstPaint,historyApi,groupsApi,quotesApi,historySeries:history.size};}
    return {update,refreshCharts,metrics,state,paint};
  }
  return {create,unavailableText,freshness,groupLocally,coverageLocally,filterQuotes,seriesList,normalizeGroup,categoryOf,currentValue,groupKeyOf};
})();
