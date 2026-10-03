/* MPOCommandGraphs — the Command Center's coordinated system view (2026-10-03).
   Pure HTML builders over the summary payload (+ optional /api/coordinator and /api/copy-funnel). Every module row
   shows feed health, research activity, paper outcomes (one bar per independent book, USD and SOL kept apart),
   its blocker and the next action. Unknown stays "Unknown"; a positive number never implies qualification. */
window.MPOCommandGraphs=(()=>{
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
  const arr=v=>Array.isArray(v)?v:[];
  const words=s=>String(s??'').replace(/_/g,' ').toLowerCase().replace(/^\w/,c=>c.toUpperCase());
  const ago=(t,now=Date.now())=>num(t)==null?'never':now-t<60000?Math.max(0,Math.round((now-t)/1000))+'s ago':now-t<3600000?Math.round((now-t)/60000)+'m ago':now-t<172800000?Math.round((now-t)/3600000)+'h ago':Math.round((now-t)/86400000)+'d ago';
  const amount=(v,unit)=>num(v)==null?'Unknown':unit==='SOL'?(v<0?'−':v>0?'+':'')+Math.abs(v).toFixed(3)+' SOL':(v<0?'−':v>0?'+':'')+'$'+Math.abs(v).toFixed(2);
  const chip=(label,tone='')=>`<span class="mpd-chip ${tone}">${esc(label)}</span>`;
  const open=(id,label)=>`<button class="cc-link" type="button" data-overview-open="${esc(id)}">${esc(label)}</button>`;

  // Module map: Lab module id, loop ids (trader feeds/evaluators), paper book modules, desk to open.
  const MODULES=[
    {id:'pumpfun',title:'Pump.fun',lab:'pumpfun',loops:/^pumpfun/,books:/^Pump/,nav:'trade'},
    {id:'pump-wallet-copy',title:'Pump wallet copy',lab:null,loops:/^pumpfun-copy/,books:/^Pump.*copy/i,nav:'wallet'},
    {id:'robinhood-crypto',title:'Robinhood crypto',lab:'robinhood',loops:/^robinhood/,books:/^Robinhood (crypto|external)/,nav:'robinhood'},
    {id:'robinhood-equities',title:'Stocks & ETFs',lab:'robinhood-equities',loops:/^(disclosure|edgar)/,books:/equities|^Stocks/,nav:'stocks'},
    {id:'kalshi-weather',title:'Kalshi weather',lab:'kalshi',loops:/^kalshi.*weather|^weather/,books:/^Kalshi.*[Ww]eather/,nav:'kalshi'},
    {id:'kalshi-btc',title:'Kalshi BTC ranges',lab:'kalshi',loops:/^kalshi.*btc/,books:/^Kalshi.*BTC/,nav:'kalshi'},
    {id:'polymarket-clob',title:'Polymarket global CLOB',lab:'polymarket',loops:/^polymarket-(?!copy)/,books:/^Polymarket global/,nav:'marketlab'},
    {id:'polymarket-copy',title:'Polymarket copy',lab:null,loops:/^(polymarket-copy|copy-)/,books:/^Polymarket copy/,nav:'pmcopy'},
    {id:'kalshi-mirror',title:'Kalshi mirror',lab:null,loops:/^kalshi-mirror/,books:/^Kalshi mirror/,nav:'kalshi'},
    {id:'polymarket-us',title:'Polymarket US',lab:'polymarket-combo',loops:/^us-/,books:/^Polymarket US/,nav:'sportsbook'},
    {id:'arbitrage',title:'Arbitrage',lab:null,loops:/^arbitrage/,books:/^Arbitrage/,nav:'arbitrage'}
  ];
  const READY=new Set(['RESEARCHING','RESEARCH_ONLY','SEARCHING']);
  function feedOf(loops,re){
    const own=Object.entries(loops||{}).filter(([id])=>re.test(id));
    if(!own.length)return {tone:'unknown',label:'No feed loop reported',detail:''};
    const bad=own.filter(([,l])=>['ERROR','STALLED'].includes(l.state)),last=Math.max(0,...own.map(([,l])=>num(l.lastOkAt)||0));
    if(bad.length)return {tone:'down',label:`${bad.length} of ${own.length} loops ${bad.some(([,l])=>l.state==='STALLED')?'stalled':'failing'}`,detail:bad.map(([id,l])=>`${id}: ${l.lastError||l.state}`).join('\n')};
    const waiting=own.filter(([,l])=>['WAITING','BACKOFF','PAUSED','STALE'].includes(l.state)),running=own.filter(([,l])=>l.state==='RUNNING');
    const detail=own.map(([id,l])=>`${id}: ${l.state} · last ok ${ago(l.lastOkAt)} · p95 ${num(l.p95Ms)==null?'?':Math.round(l.p95Ms)+' ms'}`).join('\n');
    return {tone:waiting.length||!last?'warn':'up',label:`${own.length} loops · ${running.length?running.length+' collecting · ':''}${waiting.length?waiting.length+' waiting · ':''}last success ${ago(last||null)}`,detail};
  }
  function coordFor(coord,m){
    const list=arr(coord?.modules);return list.find(x=>x.id===m.id||x.module===m.id)||null;
  }
  function moduleRows(data,coord,now=Date.now()){
    const labMods=new Map(arr(data?.lab?.modules).map(m=>[m.id,m])),active=arr(data?.lab?.scheduler?.active),books=arr(data?.books).filter(b=>b.kind!=='lab');
    return MODULES.map(m=>{
      const lab=m.lab?labMods.get(m.lab):null,own=books.filter(b=>m.books.test(b.module||'')),feed=feedOf(data?.loops,m.loops),c=coordFor(coord,m);
      const job=active.find(j=>j.module===m.lab);
      const research=job?{tone:'up',label:`Running · ${num(job.slots)??'?'} slots · ${ago(job.startedAt,now).replace(' ago','')}`}:lab?{tone:READY.has(lab.state)?'':'warn',label:words(lab.state)}:{tone:'unknown',label:m.lab?'Lab state not reported':'No Lab module'};
      const units=['USD','SOL'].map(u=>{const bs=own.filter(b=>b.unit===u);if(!bs.length)return null;const known=bs.filter(b=>num(b.pnl)!=null);return {unit:u,books:bs,net:known.length?known.reduce((n,b)=>n+b.pnl,0):null,closes:bs.reduce((n,b)=>n+(num(b.closes)||0),0),beating:bs.filter(b=>/BEAT/i.test(b.verdict)&&!/NOT/i.test(b.verdict)).length};}).filter(Boolean);
      const blocker=c?.bottleneck||c?.blocker||lab?.blockers?.[0]||(feed.tone==='down'?feed.label:null);
      const next=c?.nextAction||c?.next||null;
      return {m,lab,feed,research,units,blocker,next,retry:c?.retry?.reason||c?.retryReason||null,change:c?.plain?.changed||c?.lastChange||c?.changed||null,objective:c?.objective||null,doing:c?.plain?.doing||null,needs:c?.plain?.needs||null,present:!!(lab||own.length||feed.tone!=='unknown'||c)};
    }).filter(r=>r.present);
  }
  function bars(u){
    const max=Math.max(1e-9,...u.books.map(b=>Math.abs(num(b.pnl)||0)));
    return `<span class="cc-bars" role="img" aria-label="${esc(u.books.length+' '+u.unit+' paper books, net '+amount(u.net,u.unit))}">${u.books.map(b=>{const v=num(b.pnl),h=v==null?100:Math.max(8,Math.abs(v)/max*100);return `<i class="${v==null?'unknown':v>0?'up':v<0?'down':'flat'}" style="height:${h.toFixed(0)}%" title="${esc(`${b.label||b.id} · net ${amount(v,b.unit)} · ${b.closes??'?'} closes · ${b.verdict||'verdict unknown'}${b.reason?' · '+b.reason:''}`)}"></i>`;}).join('')}</span>`;
  }
  function modules(data,coord,now=Date.now()){
    const rows=moduleRows(data,coord,now);
    const lines=arr(coord?.lines).length?arr(coord.lines):Object.entries(coord?.summary||{}).filter(([k,v])=>['doing','why','next'].includes(k)&&typeof v==='string').map(([,v])=>v);
    const head=coord?`<ul class="cc-coord-lines">${lines.map(l=>`<li>${esc(l)}</li>`).join('')||'<li>Coordinator reported no plain-language status.</li>'}</ul>`:`<p class="cc-note">Coordinator service not available in this build; next actions are shown where the Lab reports them.</p>`;
    if(!rows.length)return head+'<p class="cc-empty">Waiting for module status. No healthy state is assumed.</p>';
    return head+`<div class="cc-modrows" role="list">${rows.map(r=>`<article class="cc-mod" role="listitem" data-focus="mod-${esc(r.m.id)}">
      <div class="cc-mod-top"><span class="mpd-dot ${r.feed.tone}" title="${esc(r.feed.detail||r.feed.label)}"></span><b>${esc(r.m.title)}</b>${chip(r.research.label,r.research.tone)}${open(r.m.nav,'Open')}</div>
      <div class="cc-mod-grid"><span class="cc-k">Feed</span><span title="${esc(r.feed.detail)}">${esc(r.feed.label)}</span>
      ${r.doing?`<span class="cc-k">Doing</span><span>${esc(r.doing)}</span>`:''}
      ${r.needs?`<span class="cc-k">Needs</span><span>${esc(r.needs)}</span>`:''}
      <span class="cc-k">Paper</span><span class="cc-paper">${r.units.length?r.units.map(u=>`${bars(u)}<span class="mpd-num ${num(u.net)==null?'':u.net>0?'mpd-up':u.net<0?'mpd-down':''}">${esc(u.books.length+' book'+(u.books.length===1?'':'s')+' · '+amount(u.net,u.unit))}</span><span class="cc-sub">${esc(u.closes+' closes · '+u.beating+' above baseline')}</span>`).join(''):'<span class="mpd-unknown">No paper book</span>'}</span>
      ${r.blocker?`<span class="cc-k">Blocker</span><span class="cc-blocker">${esc(r.blocker)}</span>`:''}
      <span class="cc-k">Next</span><span>${r.next?esc(r.next):'<span class="mpd-unknown">Not reported</span>'}${r.retry?` <span class="cc-sub">· retry: ${esc(r.retry)}</span>`:''}</span>
      ${r.change?`<span class="cc-k">Changed</span><span>${esc(r.change)}</span>`:''}</div></article>`).join('')}</div>`;
  }
  function copy(data,funnel,now=Date.now()){
    const c=data?.copy,cat=c?.catalogue,books=arr(c?.books),open_=books.reduce((n,b)=>n+(num(b.open)||0),0);
    const funnelBooks=arr(funnel?.books);
    const stages=funnelBooks.length?funnelBooks.map(b=>({...b,stages:Object.entries(b.funnel||{}).map(([stage,count])=>({stage:words(stage.replace(/([a-z])([A-Z])/g,'$1 $2')),count}))})):arr(funnel?.platforms||funnel?.rows).length?arr(funnel.platforms||funnel.rows):null;
    const flow=stages?stages.map(p=>`<div class="cc-funnel"><b>${esc(p.platform||p.id||'Platform')}${p.policy?' · '+esc(p.policy):''}</b>${arr(p.stages||p.funnel).map(s=>`<span><strong class="mpd-num">${esc(num(s.count)??s.value??'?')}</strong> ${esc(s.stage||s.label||s.id)}</span>`).join('<i>→</i>')}</div>`).join(''):
      `<div class="cc-funnel"><b>Polymarket</b><span><strong class="mpd-num">${esc(num(cat?.candidates?.length)??'?')}</strong> discovered</span><i>→</i><span><strong class="mpd-num">${esc(num(c?.uniqueLeaders)??'?')}</strong> watched</span><i>→</i><span><strong class="mpd-num">${c?open_:'?'}</strong> open copies</span></div><p class="cc-note">Full funnel (rejected → eligible → followed → copied → exited → evaluated) appears when the copy-funnel service is installed. Discovery ${esc(cat?.status||'not reported')} · ${esc(ago(cat?.lastSuccessAt,now))}${num(cat?.rejected)!=null?` · ${cat.rejected} source rows rejected`:''}.</p>`;
    const rows=books.map(b=>`<tr><td><b>${esc(b.policy||b.id)}</b><span class="cc-sub">${esc(b.reason||'')}</span></td><td class="mpd-num">${esc(arr(b.leaders).length)}</td><td class="mpd-num">${esc(num(b.open)??'?')}</td><td class="mpd-num">${esc(num(b.closes)??'?')}</td><td class="mpd-num ${num(b.netPnlUsd)<0?'mpd-down':num(b.netPnlUsd)>0?'mpd-up':''}">${esc(amount(b.netPnlUsd,'USD'))}</td><td>${b.paused?chip('Loss pause','warn'):chip(words(b.status||'Unknown'))}<span class="cc-sub">${b.running?'checking signals':esc(ago(b.lastRunAt,now))}</span></td></tr>`).join('');
    const pump=c?.pump?`<p class="cc-note"><b>Pump.fun copy:</b> ${esc(words(c.pump.status))} · ${esc(num(c.pump.leaders)??'?')} qualifying leaders · ${esc(num(c.pump.open)??'?')} open · ${esc(arr(c.pumpExperiments).length)} separate exploratory books. ${esc(c.pump.lastError||c.pump.lastDecision?.reason||'')}</p>`:'';
    const mirror=c?.mirror?`<p class="cc-note"><b>Kalshi mirror:</b> ${esc(num(c.mirror.leaders)??'?')} leaders · ${esc(num(c.mirror.matcher?.checked)??'?')} signals checked · ${esc(num(c.mirror.matcher?.matched)??'?')} matched. ${esc(c.mirror.reason||'')}</p>`:'';
    const details=funnelBooks.map(b=>`<details class="cc-copy-detail" data-focus="copy-${esc(b.id)}"><summary>${esc(b.platform||b.id)} · ${esc(b.policy||'policy')} · ${esc(b.qualification||'Qualification unknown')}${b.paused?' · Loss pause':''}</summary><p class="cc-note">${esc(b.eligibilityScope||'Eligibility scope not reported')}</p><p class="cc-note">Follower outcome ${esc(amount(num(b.afterCost?.netPnl)??num(b.afterCost?.netPnlUsd),b.unit||'USD'))} · no-trade ${esc(amount(b.afterCost?.baselineNoTrade,b.unit||'USD'))} · ${esc(b.afterCost?.independentPositions??'?')} evaluated positions · ${esc(b.afterCost?.partialExitSlices??'?')} partial exit slices.</p><p class="cc-note">Reasons: ${esc(Object.entries(b.reasons||{}).map(([reason,count])=>words(reason)+' ('+count+')').join('; ')||'None retained')} · ${esc(b.reasonsScope?.retained??'?')} retained decisions; not all-time totals.</p><p class="cc-note">${esc(b.historyScope||'')}</p></details>`).join('');
    return flow+details+`<div class="cc-table-wrap"><table class="cc-table"><thead><tr><th>Policy</th><th>Leaders</th><th>Open</th><th>Closes</th><th>Net USD</th><th>State</th></tr></thead><tbody>${rows||'<tr><td colspan="6">Copy books not reported</td></tr>'}</tbody></table></div>${pump}${mirror}<p class="cc-note">A leaderboard lead is not proven profitable for a follower; outcomes are net after costs.</p>`;
  }
  function research(data,now=Date.now()){
    const wb=data?.lab?.workbench,jobs=Object.entries(wb?.jobs||{}),fw=wb?.forwardExperiments,sched=data?.lab?.scheduler;
    const active=arr(sched?.active).map(j=>`${j.module} (${num(j.slots)??'?'} slots, ${ago(j.startedAt,now).replace(' ago','')})`);
    const fam=Object.entries(wb?.standing?.families||{}).map(([k,f])=>`<li><b>${esc(k)}</b><span class="cc-sub">${esc(`${num(f.units)??'?'} units · ${num(f.trials)?.toLocaleString?.()??'?'} trials · corpus budget ${num(f.corpusTrials)??'?'}/${num(f.corpusBudget)??'?'}${num(f.corpusTrials)!=null&&f.corpusTrials>=f.corpusBudget?' (exhausted — needs new evidence)':''}`)}</span></li>`).join('');
    return `<p class="cc-note"><b>Running now:</b> ${active.length?esc(active.join(' · ')):'no module job'}${arr(wb?.activeJobs).length?' · workbench: '+esc(arr(wb.activeJobs).join(', ')):''} · ${esc(num(sched?.queued)??'?')} queued</p>
      ${fw?`<p class="cc-note"><b>Forward experiments:</b> ${esc(['proposed','admitted','active','completed'].map(k=>`${num(fw.counts?.[k])??'?'} ${k}`).join(' · '))}${arr(fw.pending).length?` · pending: ${esc(arr(fw.pending).map(p=>`${p.module}: ${p.reason}`).join('; '))}`:''}</p>`:''}
      <ul class="cc-jobs">${jobs.map(([id,j])=>`<li><span><b>${esc(id.replaceAll('-',' '))}</b><span class="cc-sub">${esc(j.error||`every ${num(j.everyMin)??'?'} min · ${ago(j.lastRunAt,now)}${num(j.ms)!=null?` · ${Math.round(j.ms/1000)} s`:''}`)}</span></span>${chip(j.running?'Running':j.ok===false?'Retry waiting':j.skippedUnchanged?'Awaiting new data':j.ok?'Complete':'Waiting',j.running?'up':j.ok===false?'warn':'')}</li>`).join('')||'<li>Research jobs not reported</li>'}</ul>
      ${fam?`<h5 class="cc-h5">Standing search families</h5><ul class="cc-jobs">${fam}</ul>`:''}`;
  }
  function booksView(data){
    const books=arr(data?.books).filter(b=>b.kind!=='lab'),mods=[...new Set(books.map(b=>b.module))];
    if(!books.length)return '<p class="cc-empty">Paper books not reported.</p>';
    const ps=data?.paperSummary;
    return `<p class="cc-note">${esc(`${num(ps?.books)??books.length} independent books · ${num(ps?.beating)??'?'} above baseline · ${num(ps?.notBeating)??'?'} below · ${num(ps?.notEnoughData)??'?'} gathering evidence`)}. Each book keeps its own currency; USD and SOL are never added together.</p><div class="cc-table-wrap"><table class="cc-table"><thead><tr><th>Book</th><th>Net</th><th>Closes</th><th>Baseline</th><th>Verdict</th></tr></thead><tbody>${mods.map(m=>`<tr class="cc-group"><th colspan="5">${esc(m)}</th></tr>`+books.filter(b=>b.module===m).map(b=>`<tr><td>${esc(b.label||b.id)}<span class="cc-sub">${esc(b.reason||'')}</span></td><td class="mpd-num ${num(b.pnl)==null?'':b.pnl>0?'mpd-up':b.pnl<0?'mpd-down':''}">${esc(amount(b.pnl,b.unit))}</td><td class="mpd-num">${esc(num(b.closes)??'?')}</td><td class="mpd-num">${esc(amount(b.baseline,b.unit))}</td><td>${chip(words(b.verdict||'Unknown'),/NOT ENOUGH/i.test(b.verdict)?'':/NOT/i.test(b.verdict)?'warn':'')}</td></tr>`).join('')).join('')}</tbody></table></div>`;
  }
  function legend(){
    return `<span class="cc-leg"><i class="lg-market"></i>Market price (observed)</span><span class="cc-leg"><i class="lg-band"></i>Bid/ask band</span><span class="cc-leg"><i class="lg-session"></i>Daily session close (not live)</span><span class="cc-leg"><i class="lg-pred"></i>Research prediction</span><span class="cc-leg"><i class="lg-quote"></i>Executable quote</span><span class="cc-leg"><i class="lg-paper"></i>Paper result (net, own currency)</span><span class="cc-leg"><i class="lg-gap"></i>No data (never filled in)</span>`;
  }
  // Compatibility: a static rendering of the system view for callers that still ask for html(data).
  function html(data){return `<div class="cc-sysview">${modules(data,null)}</div>`;}
  function paint(){}
  return {MODULES,moduleRows,modules,copy,research,books:booksView,legend,html,paint,amount};
})();
