/* Shared programs inside the existing MPOS desktop. Provider calls stay on the server. */
window.MPOSPlatform = (() => {
  const escape = v => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dollars = v => v===null||v===undefined?'Unavailable':'$'+Number(v).toLocaleString(undefined,{maximumFractionDigits:4});
  const pct = v => v===null||v===undefined?'—':(Number(v)*100).toFixed(1)+'%';
  const when = v => v?new Date(v).toLocaleString():'Unavailable';
  const states={kalshi:{rows:[],cursor:null,search:'',category:'',detail:null},predictionmarkets:{rows:[],cursor:null,search:'',category:'',detail:null}};
  let snapshot=null,contracts=[],comparison=null,candidates=null,lastPair=null,error='',busy=false,hostApi=null;
  let scoreboard=null,scoreboardError='',intelligence=null;
  const mirrorLabel=a=>{const source=a.venue==='solana-paper'?'solana':a.venue==='robinhood-practice'?'robinhood-practice':null,m=snapshot?.legacy?.mirror?.find(x=>x.source===source);return !m?'UNVERIFIED MIRROR':a.account!==`legacy-${m.epoch}`?'HISTORICAL MIRROR / not current cash':m.status==='RECONCILED'?'CURRENT MIRROR / RECONCILED':`UNVERIFIED MIRROR / ${m.status} / use the source book`;};
  const expandedDetails=new Set();
  const detailPanel=(id,label,content)=>`<details data-core-detail="${id}" ${expandedDetails.has(id)?'open':''}><summary>${escape(label)}</summary>${expandedDetails.has(id)?content():''}</details>`;
  const currencyAmount=(value,currency)=>value==null?'Unavailable':currency==='USD'?dollars(value):`${Number(value).toLocaleString(undefined,{maximumFractionDigits:6})} ${escape(currency||'UNKNOWN UNIT')}`;
  const venues={kalshi:'kalshi',predictionmarkets:'polymarket'};
  const ids=['command','kalshi','arbitrage','predictionmarkets'];
  const hostOf=id=>id==='predictionmarkets'?'sportsbook':id==='arbitrage'?'command':id;
  function paneVisible(id){
    const host=hostOf(id),w=document.querySelector(`.window[data-app="${host}"]`);if(!w||w.classList.contains('hidden'))return false;
    if(w.classList.contains('glance'))return id===host&&!window.MPOProgramActive?.(host);
    const pane=document.getElementById('body-'+id);return !!pane&&(!pane.classList.contains('tabpane')||pane.classList.contains('on'));
  }
  function overviewVisible(){
    if(ids.some(paneVisible))return true;
    const money=document.querySelector('.window[data-app="money"]');return !!money&&!money.classList.contains('hidden');
  }
  function platformGlance(id){
    const s=scoreboard?.summary||{},bad=diag?.sources?.filter(x=>!['CONNECTED','IDLE','DISABLED'].includes(x.status)).length||0;
    if(id==='command'&&typeof glance==='function')return commandGlance(bad);
    if(id==='command')return `<div class="core-app"><div class="core-heading"><h2>COMMAND CENTER</h2><span class="mpo-badge">PAPER / RESEARCH</span></div>${commandOverview()}</div>`;
    if(id==='kalshi'&&typeof glance==='function')return kalshiGlance();
    return `<div class="core-app"><div class="core-heading"><h2>${escape(id==='kalshi'?'KALSHI':'POLYMARKET')}</h2><span class="mpo-badge">PAPER</span></div><p class="core-muted">Open Advanced for books, orders, depth and execution detail.</p></div>`;
  }
  const overviewArray=v=>Array.isArray(v)?v:[];
  const overviewNumber=v=>v==null||v===''||typeof v==='boolean'||!Number.isFinite(Number(v))?null:Number(v);
  const overviewCount=v=>overviewNumber(v)==null?'Unknown':String(overviewNumber(v));
  const overviewMoney=(v,unit='USD')=>overviewNumber(v)==null?'Unknown':currencyAmount(overviewNumber(v),unit);
  const overviewNav=(id,label,detail=false)=>`<button class="btn" type="button" data-overview-open="${escape(id)}"${detail?' data-overview-detail="true"':''}>${escape(label)}</button>`;
  const overviewCard=(title,body,nav='')=>`<section class="overview-card"><div class="overview-head"><h3>${escape(title)}</h3></div>${body}${nav?`<div class="overview-nav">${nav}</div>`:''}</section>`;
  const overviewLine=(title,note,value='')=>`<li><div><b>${escape(title)}</b><small>${escape(note)}</small></div>${value?`<span>${escape(value)}</span>`:''}</li>`;
  function overviewModules(){
    const modules=[['trade','Pump.fun',/^Pump|Solana/i,['solana']],['robinhood','Robinhood',/^Robinhood/i,['robinhood','robinhood-equities']],['predictionmarkets','Polymarket',/^Polymarket/i,['polymarket','polymarket-us']],['kalshi','Kalshi',/^Kalshi/i,['kalshi']],['evolution','Research & Lab',/^Evolution Lab|Market Lab/i,['market-lab','arbitrage']]];
    const capabilities=overviewArray(snapshot?.capabilities?.rows||snapshot?.capabilities);
    return modules.map(([id,label,match,keys])=>{
      const rows=overviewArray(scoreboard?.rows).filter(r=>match.test(String(r.module||''))),caps=capabilities.filter(c=>keys.includes(c.id));
      const stale=rows.filter(r=>['STALE','UNREADABLE','ERROR'].includes(r.freshness?.status)).length;
      const note=rows.length?`${rows.length} reported ${id==='evolution'?'research lanes':'books'} · ${rows.filter(r=>r.beatsBaseline==='YES').length} beating baseline${stale?` · ${stale} stale`:''}`:'Results not reported';
      const decisions=[...new Set(caps.map(c=>typeof c.decision==='string'?c.decision:c.decision?.state).filter(Boolean))];
      const body=`<p class="overview-note">${escape(note)}</p><ul class="overview-list">${rows.slice(0,2).map(r=>overviewLine(r.book||r.module,`${r.kind==='lab'?'RESEARCH':r.mode||'UNKNOWN MODE'} · ${overviewCount(r.closes)} closes · ${r.freshness?.status||'freshness unknown'}`,overviewNumber(r.netPnl)==null?'Unknown':sbAmount(overviewNumber(r.netPnl),r.unit))).join('')}${!rows.length?overviewLine('Evidence',decisions.join(' · ')||'Open the desk to inspect data and paper readiness.'):''}</ul>`;
      return overviewCard(label,body,overviewNav(id,'Open '+label));
    }).join('');
  }
  function overviewAttention(){
    const issues=[];
    if(snapshot?.risk?.halted)issues.push(['Paper execution paused','The persistent stop is active. Review existing orders and risk controls.']);
    if(error||scoreboardError)issues.push(['Refresh unavailable',error||scoreboardError]);
    for(const s of overviewArray(diag?.sources).filter(s=>!['CONNECTED','IDLE','DISABLED'].includes(s.status)))issues.push([s.id,s.lastError||s.note||s.status||'Status unknown']);
    for(const m of overviewArray(snapshot?.legacy?.mirror).filter(m=>m.status!=='RECONCILED'))issues.push([m.source+' mirror',m.status+' · inspect the source book before trusting mirrored cash']);
    for(const r of overviewArray(scoreboard?.rows).filter(r=>['STALE','UNREADABLE','ERROR'].includes(r.freshness?.status)))issues.push([r.module+' / '+r.book,r.freshness.status]);
    const bots=window.MPOBots?.data;for(const [label,b] of [['Kalshi weather',bots?.kalshi?.weather],['Kalshi NWS control',bots?.kalshi?.['weather-nws']],['Kalshi BTC',bots?.kalshi?.btc],['Polymarket copy',bots?.polycopy],['Kalshi copy mirror',bots?.mirror],['Variant farm',bots?.farm]])if(b?.lastError||b?.error)issues.push([label,b.lastError||b.error]);
    if(snapshot?.journalError)issues.push(['Journal',snapshot.journalError]);
    const body=issues.length?`<ul class="overview-list">${issues.slice(0,5).map(([title,note])=>overviewLine(title,note)).join('')}</ul>${issues.length>5?`<p class="overview-note">${issues.length-5} more items in detailed diagnostics.</p>`:''}`:`<p class="overview-note">${overviewArray(diag?.sources).length?'No active source warnings reported.':'Source health has not been reported yet.'}</p>`;
    return overviewCard('Needs attention',body,overviewNav('risk','Risk controls')+overviewNav('command','Detailed diagnostics',true));
  }
  function overviewBooks(){
    const books=overviewArray(snapshot?.legacy?.books).filter(b=>b.mode==='PAPER').map(b=>({label:b.label||b.source,note:`${b.status||'status unknown'} · ${overviewCount(b.openPositions)} open`,value:overviewMoney(b.cash,b.currency||'UNKNOWN UNIT')+' cash'}));
    // Current source books and core mirrors are alternative views of the same cash, never additive.
    for(const a of overviewArray(snapshot?.portfolio?.accounts).filter(a=>!String(a.account||'').startsWith('legacy-'))){books.push({label:`${a.venue||'Core'} / ${a.account||'paper account'}`,note:`PAPER · ${Array.isArray(a.positions)?a.positions.length:'Unknown'} open · ${a.currency||'unit unknown'}`,value:overviewMoney(a.cash,a.currency||'UNKNOWN UNIT')+' cash'});}
    const data=window.MPOBots?.data;
    for(const [label,b] of [['Kalshi weather',data?.kalshi?.weather],['Kalshi NWS control',data?.kalshi?.['weather-nws']],['Kalshi BTC',data?.kalshi?.btc],['Polymarket copy',data?.polycopy],['Kalshi copy mirror',data?.mirror]])if(b)books.push({label,note:`PAPER · ${Array.isArray(b.open)?b.open.length:'Unknown'} open · ${b.settings?.enabled===true?'enabled':b.settings?.enabled===false?'paused':'state unknown'}`,value:overviewMoney(b.equityUsd)+' modeled equity'});
    return overviewCard('Independent paper books',books.length?`<ul class="overview-list">${books.map(b=>overviewLine(b.label,b.note,b.value)).join('')}</ul><p class="overview-note">Original units and source books stay separate. Cash and modeled equity are different measures.</p>`:'<p class="overview-note">Paper balances have not been reported yet.</p>',overviewNav('money','Paper accounts'));
  }
  function commandOverview(){
    const proposals=overviewArray(snapshot?.proposals).filter(p=>!['FILLED','REJECTED','CANCELED','CANCELLED','EXPIRED'].includes(p.status)),caps=overviewArray(snapshot?.capabilities?.rows||snapshot?.capabilities);
    const sources=overviewArray(diag?.sources),known=sources.filter(s=>['CONNECTED','IDLE'].includes(s.status)),rows=overviewArray(scoreboard?.rows),labs=rows.filter(r=>r.kind==='lab');
    const research=overviewArray(intelligence?.research).filter(r=>r.status==='NEEDS_EVIDENCE');
    const recent=overviewArray(snapshot?.ledger).slice(0,3);
    const activity=`<ul class="overview-list">${overviewLine('Core order proposals',Array.isArray(snapshot?.proposals)?`${proposals.length} pending or under review`:'Not reported')}${recent.map(r=>overviewLine(`${r.mode||'UNKNOWN MODE'} · ${r.venue||'venue unknown'} · ${r.kind||'activity'}`,when(r.at),overviewMoney(r.gross,r.currency||'UNKNOWN UNIT'))).join('')}</ul>`;
    const evidence=`<ul class="overview-list">${overviewLine('Research lanes',scoreboard?`${labs.length} reported · research results do not grant trading authority`:'Results not reported · research results do not grant trading authority')}${overviewLine('Paper evidence',caps.length?`${caps.filter(c=>c.evidenceReady===true).length} capability checks ready · applied strategy is checked separately`:'Readiness not reported')}${research.slice(0,2).map(r=>overviewLine(r.module||'Research',r.nextTest||r.reason||'More observations needed')).join('')}</ul>`;
    return `<div class="mpo-overview"><p class="overview-note">See what each trading module is observing, how its paper books are doing and which research or data issues need attention. Open a desk to investigate or use its controls.</p><div class="overview-grid">${overviewModules()}${overviewAttention()}${overviewBooks()}${overviewCard('Open activity',activity,overviewNav('journal','Journal'))}${overviewCard('Research & qualification',evidence,overviewNav('evolution','Evolution Lab')+overviewNav('marketlab','Market Lab'))}${overviewCard('Data health',`<ul class="overview-list">${overviewLine('Sources',diag?`${known.length} connected or idle / ${sources.length} reported`:'Not reported')}${overviewLine('Latest platform snapshot',when(snapshot?.at))}${overviewLine('Market coverage',snapshot?`${contracts.length} loaded listings across venues · partial snapshot`:'Not reported')}${overviewLine('Live core',snapshot?.executionModes?.liveCore||'Status not reported')}</ul>`,overviewNav('wire','Wire')+overviewNav('macro','Macro'))}</div></div>`;
  }
  function commandGlance(bad){
    const ps=scoreboard?.paperSummary,beat=overviewNumber(ps?.beating),notBeat=overviewNumber(ps?.notBeating),judged=beat==null||notBeat==null?null:beat+notBeat;
    return glance({title:'Command Center',pill:bad?{label:`${bad} sources need attention`,tone:'warn'}:diag?{label:'Paper · research',tone:''}:{label:'Health not reported',tone:'warn'},
      hero:judged==null?'—':`${beat} / ${judged}`,heroSub:'paper books beating their own baseline · suite overview',heroText:false,
      stats:[{label:'Beating',value:overviewCount(beat),tone:beat>0?'g-pos':''},{label:'Not beating',value:overviewCount(notBeat),tone:notBeat>0?'g-neg':''},{label:'Need more data',value:overviewCount(ps?.notEnoughData)}],
      visual:`<div class="g-scroll">${commandOverview()}</div>`,foot:gFoot(['Open a desk to inspect its data, paper book and controls','Balances remain in their original currencies'])});
  }
  // Weather is one preview in the wider Kalshi overview; the existing Weather desk retains its detail.
  // Data is GET /api/platform/weather (server-cached); fetched at most every 10 minutes while this glance shows.
  let kalshiWx=null,kalshiWxAt=0,kalshiWxBusy=false,kalshiWxError='';
  function loadKalshiWx(){
    if(kalshiWxBusy||Date.now()-kalshiWxAt<(kalshiWx?600000:60000))return;kalshiWxBusy=true;kalshiWxAt=Date.now();
    request('/weather').then(v=>{kalshiWx=v;kalshiWxError='';}).catch(e=>{kalshiWxError=e.message;}).finally(()=>{kalshiWxBusy=false;draw('kalshi');});
  }
  function kalshiOverview(){
    const loaded=[...new Map([...overviewArray(contracts).filter(c=>c.provider==='kalshi'),...states.kalshi.rows].map(c=>[c.id||c.sourceId,c])).values()];
    const categories=new Map();for(const c of loaded){const name=c.data?.category||'Uncategorized';categories.set(name,(categories.get(name)||0)+1);}
    const cats=[...categories].sort((a,b)=>b[1]-a[1]);
    const coverage=overviewCard('Market universe',`<ul class="overview-list">${overviewLine('Loaded Kalshi listings',snapshot?`${loaded.length} cached listings · ${cats.length} observed categories`:'Coverage not reported')}${cats.slice(0,4).map(([name,n])=>overviewLine(name,'Among loaded listings',String(n))).join('')}</ul><p class="overview-note">This is a partial public-data snapshot. Load or search active markets in Advanced to explore the venue.</p>`,overviewNav('kalshi','Market desk',true)+overviewNav('macro','Macro events'));
    const data=window.MPOBots?.data;
    const books=[['Weather model',data?.kalshi?.weather],['NWS forecast control',data?.kalshi?.['weather-nws']],['Bitcoin range model',data?.kalshi?.btc],['Copy mirror',data?.mirror]];
    const bookLines=books.map(([label,b])=>overviewLine(label,b?`PAPER · ${b.settings?.enabled===true?'enabled':b.settings?.enabled===false?'paused':'state unknown'} · ${Array.isArray(b.open)?b.open.length:'Unknown'} open · ${overviewCount(b.stats?.settled??b.stats?.closed)} settled${b.lastError?' · '+b.lastError:''}`:'Paper book not reported',b?overviewMoney(b.equityUsd)+' modeled equity':'Unknown')).join('');
    const paper=overviewCard('Separate paper books',`<ul class="overview-list">${bookLines}</ul><p class="overview-note">Each model keeps its own simulated funds and results. Compare evidence before changing settings.</p>`,overviewNav('kalshibots','Paper bots')+overviewNav('pmcopy','Copy research'));
    const farm=data?.farm,variants=overviewArray(farm?.variants),positive=variants.filter(v=>String(v.verdict?.text||'').startsWith('making money'));
    const researchRows=overviewArray(scoreboard?.rows).filter(r=>/^Kalshi|Evolution Lab/i.test(String(r.module||''))&&r.kind==='lab');
    const research=overviewCard('Farm & qualification',`<ul class="overview-list">${overviewLine('Forward variant farm',farm?`${variants.length} independent PAPER variants · ${overviewCount(farm.minSettled)} settled bets required for a verdict`:'Farm snapshot not reported')}${overviewLine('Profitability evidence',farm?`${positive.length} positive reported farm verdicts · a per-bet P/L test, not full strategy qualification`:'Not reported')}${overviewLine('Historical research',scoreboard?`${researchRows.length} reported lanes · diagnostic results require prospective validation`:'Results not reported')}</ul><p class="overview-note">A farm result or model forecast alone does not grant live trading authority.</p>`,overviewNav('kalshibots','Farm evidence')+overviewNav('evolution','Evolution Lab'));
    const soon=loaded.map(c=>({c,at:new Date(c.data?.expiresAt).getTime()})).filter(x=>Number.isFinite(x.at)&&x.at>Date.now()).sort((a,b)=>a.at-b.at).slice(0,3);
    const activity=overviewCard('Upcoming markets & activity',`<ul class="overview-list">${soon.length?soon.map(({c,at})=>overviewLine(c.data?.title||c.sourceId||'Market',`${c.data?.category||'Category unknown'} · closes ${when(at)}`)).join(''):overviewLine('Upcoming closes','No upcoming closes in the loaded snapshot')}${overviewLine('Core paper proposals',Array.isArray(snapshot?.proposals)?String(snapshot.proposals.filter(p=>p.payload?.venue==='kalshi'&&!['FILLED','REJECTED','CANCELED','CANCELLED','EXPIRED'].includes(p.status)).length)+' pending or under review':'Not reported')}</ul>`,overviewNav('kalshi','Inspect markets',true)+overviewNav('journal','Journal'));
    const provider=overviewArray(snapshot?.providers).find(p=>p.id==='kalshi'),health=overviewArray(diag?.sources).filter(s=>/kalshi|weather|botfarm/i.test(String(s.id||'')));
    const status=overviewCard('Data health',`<ul class="overview-list">${overviewLine('Kalshi provider',provider?.status||'Status not reported',provider?.lastSuccess?when(provider.lastSuccess):'')}${health.slice(0,3).map(s=>overviewLine(s.id,s.status||'Unknown',s.lastError||'')).join('')}${overviewLine('Core execution',snapshot?.executionModes?.kalshi||'Status not reported')}${overviewLine('Paper snapshot',data?when(data.at):'Not reported')}</ul>`,overviewNav('command','Detailed diagnostics',true));
    const weatherRows=overviewArray(kalshiWx?.cities).map(c=>{const m=overviewArray(c.markets).find(m=>m.closeAt>Date.now()&&overviewArray(m.buckets).length&&Math.max(...m.buckets.map(b=>overviewNumber(b.p)??0))<0.9);return m?{c,m}:null;}).filter(Boolean).slice(0,3);
    const degree=v=>overviewNumber(v)==null?'Unknown':Number(v).toFixed(1)+'°F';
    const weather=overviewCard('Weather preview',weatherRows.length?`<ul class="overview-list">${weatherRows.map(({c,m})=>overviewLine(c.label||c.id,`${m.date||'Date unknown'} · NWS ${degree(m.nwsHigh)} · market ${degree(m.expectedHigh)}`,overviewNumber(m.gap)==null?'Unknown gap':`${m.gap>0?'+':''}${Number(m.gap).toFixed(1)}°F gap`)).join('')}</ul><p class="overview-note">Forecast gaps are context. Tradable asks, fees and observed depth are checked by the paper bots.</p>`:`<p class="overview-note">${escape(kalshiWxError?'Weather preview unavailable: '+kalshiWxError:kalshiWx?'No upcoming weather markets in this snapshot.':'Weather preview is loading.')}</p>`,overviewNav('weather','Weather desk'));
    return `<div class="mpo-overview"><p class="overview-note">Explore Kalshi event markets and observed probabilities, then compare the weather, Bitcoin and copy models in their separate paper books. Follow current activity and research before opening a detailed desk.</p><div class="overview-grid">${coverage}${paper}${research}${activity}${status}${weather}</div></div>`;
  }
  function kalshiGlance(){
    loadKalshiWx();
    const loaded=overviewArray(contracts).filter(c=>c.provider==='kalshi'),categories=new Set(loaded.map(c=>c.data?.category).filter(Boolean)),bots=window.MPOBots?.data?.kalshi;
    const source=overviewArray(snapshot?.providers).find(p=>p.id==='kalshi');
    return glance({title:'Kalshi overview',pill:{label:source?.status||'Health not reported',tone:source&&source.status==='CONNECTED'?'ok':'warn'},hero:snapshot?String(loaded.length):'—',heroSub:'loaded public listings · partial market coverage',
      stats:[{label:'Categories',value:snapshot?String(categories.size):'Unknown'},{label:'Paper model books',value:bots?String(Object.keys(bots).length):'Unknown'},{label:'Core mode',value:snapshot?.executionModes?.kalshi||'Unknown'}],
      visual:`<div class="g-scroll">${kalshiOverview()}</div>`,foot:gFoot(['Markets · paper bots · copy mirror · research','Original books remain separate · Advanced opens depth and controls'])});
  }
  const button=(action,label,extra='')=>`<button class="btn" data-core-action="${action}" ${extra} ${busy&&action!=='halt'?'disabled':''}>${label}</button>`;
  async function request(route,data){
    const r=await fetch('/api/platform'+route,data===undefined?{cache:'no-store'}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
    const value=await r.json();if(!r.ok||value.ok===false)throw new Error(value.error||'Request failed');return data===undefined?value:value.result;
  }
  const table=(headers,rows,empty='No records yet.')=>`<div class="core-table-wrap"><table class="table"><thead><tr>${headers.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows||`<tr><td colspan="${headers.length}">${escape(empty)}</td></tr>`}</tbody></table></div>`;
  // SCOREBOARD: every module's paper book, after fees, against its own baseline (GET /api/scoreboard).
  const sbAmount=(v,unit)=>{if(v===null||v===undefined)return '—';const n=Number(v),sign=n>0?'+':n<0?'−':'',a=Math.abs(n);
    return unit==='USD'?sign+'$'+a.toFixed(2):unit==='SOL'?sign+a.toFixed(4)+' SOL':unit==='%'?sign+a.toFixed(2)+'%':sign+a.toFixed(4);};
  const sbAge=ms=>ms===null||ms===undefined?'':ms<60e3?Math.round(ms/1e3)+'s':ms<3600e3?Math.round(ms/60e3)+'m':ms<172800e3?Math.round(ms/3600e3)+'h':Math.round(ms/86400e3)+'d';
  const sbSpark=c=>{if(!Array.isArray(c)||c.length<2)return '';const lo=Math.min(0,...c),hi=Math.max(0,...c),span=hi-lo||1,y=v=>(15-(v-lo)/span*14).toFixed(1);
    return `<svg class="core-spark" viewBox="0 0 60 16" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="60" y1="${y(0)}" y2="${y(0)}" class="zero"/><polyline class="${c.at(-1)>=0?'up':'down'}" points="${c.map((v,i)=>(i*60/(c.length-1)).toFixed(1)+','+y(v)).join(' ')}"/></svg>`;};
  function scoreboardCard(){
    if(!scoreboard)return `<h3>Scoreboard</h3><p class="core-muted">${escape(scoreboardError||'Reading every module…')}</p>`;
    const s=scoreboard.summary,led=v=>v==='YES'?'yes':v==='NO'?'no':'wait';
    const rows=scoreboard.rows.map(r=>{const pf=r.profitFactor==='infinity'?'∞':r.profitFactor===null||r.profitFactor===undefined?'—':Number(r.profitFactor).toFixed(2),f=r.freshness||{};
      return `<tr class="sb-${led(r.beatsBaseline)}"><td><span class="core-led ${led(r.beatsBaseline)}" aria-hidden="true"></span>${escape(r.module)}<small>${escape(r.mode|| (r.kind==='lab'?'BACKTEST':'PAPER'))} · ${escape(r.book)}${r.kind==='lab'?' · '+escape(r.state):''}</small></td>
        <td class="num">${sbAmount(r.netPnl,r.unit)}${sbSpark(r.curve)}</td><td class="num">${r.closes}${r.per==='session'?'<small>sessions</small>':''}</td>
        <td class="num">${r.hitRate===null||r.hitRate===undefined?'—':(r.hitRate*100).toFixed(0)+'%'} · ${pf}</td><td class="num">${sbAmount(r.netPerTrade,r.unit)}<small>avg win ${sbAmount(r.averageWin,r.unit)} / loss ${sbAmount(r.averageLoss,r.unit)} · closed-outcome DD ${sbAmount(r.realizedDrawdown,r.unit)}</small></td>
        <td>${escape(r.baseline.label)}<small>${r.baseline.netPnl===null?'unavailable':sbAmount(r.baseline.netPnl,r.unit)}</small></td>
        <td title="${escape(r.reason||'')}"><b class="sb-verdict">${escape(r.beatsBaseline)}</b></td>
        <td class="num${r.outlier?' sb-outlier':''}" title="${r.bestTrade?'Best trade '+sbAmount(r.bestTrade.pnl,r.unit):''}">${sbAmount(r.netWithoutBest,r.unit)}${r.outlier?'<small>ONE TRADE</small>':''}</td>
        <td class="sb-fresh ${escape(String(f.status||'').toLowerCase())}">${escape(f.status||'—')}<small>${sbAge(f.ageMs)}</small></td></tr>`;}).join('');
    return `<h3>Scoreboard <small>Is each module working? Net after fees, against its own baseline. Paper and shadow only.</small></h3>
      <div class="core-lcd" role="status"><span><span class="core-led yes"></span>${scoreboard.paperSummary?.beating??s.beating} paper books beating</span><span><span class="core-led no"></span>${scoreboard.paperSummary?.notBeating??s.notBeating} paper books not</span><span><span class="core-led wait"></span>${scoreboard.paperSummary?.notEnoughData??s.notEnoughData} paper books awaiting evidence</span><span>${s.outlierDriven} one-trade</span><span>${s.stale} stale</span></div>
      ${table(['Module / mode / book','Net after fees','Closes','Hit · PF','Net / trade','Baseline','Beats?','Without best','Data'],rows,'No modules reported.')}
      <p class="core-muted">${escape(scoreboard.rules)}${scoreboard.errors?.length?' Unreadable: '+escape(scoreboard.errors.map(e=>e.source).join(', '))+'.':''}</p>`;
  }
  function missionCard(){
    const desks=[['kalshi','Kalshi','Kalshi'],['poly','Polymarket','Polymarket'],['pump','Pump.fun','Pump.fun'],['robinhood','Robinhood','Robinhood crypto'],['stocks','Stocks','Robinhood equities'],['lab','Market Lab',null],['evolution','Evolution Lab','Evolution Lab']];
    const cards=desks.map(([id,label,match])=>{const rows=(scoreboard?.rows||[]).filter(r=>match&&r.module.startsWith(match)&&!r.id.startsWith('platform-robinhood'));
      return `<section class="mission-desk">${button('open-'+id,label)}<small>${rows.length?rows.length+' reported books / lanes':id==='lab'?'Replay / walk-forward validation':'No paper results reported'}</small>${rows.slice(0,3).map(r=>`<p>${escape(r.book)}<br><b>${sbAmount(r.netPnl,r.unit)}</b> · n=${r.closes}<small>${escape(r.freshness?.status||'UNKNOWN')} · ${escape(r.beatsBaseline)}</small></p>`).join('')}</section>`;}).join('');
    const b=intelligence?.budget;
    return `<h3>Mission control <small>Paper execution only · real-money promotion requires future approval</small></h3><div class="mission-grid">${cards}</div>
      <h3>Research attention <small>Local evidence triage · no model calls · findings never auto-promote strategies</small></h3>
      ${intelligence?.lastError?'<p class="core-error">'+escape(intelligence.lastError)+'</p>':''}
      ${table(['Priority / module','Why now','Finding / next test'],(intelligence?.research||[]).filter(r=>r.status==='NEEDS_EVIDENCE').slice(0,8).map(r=>`<tr><td>${r.priority} · ${escape(r.module)}<small>${escape(r.book)}</small></td><td>${escape(r.reason)}<small>${when(r.at)}</small></td><td>${escape(r.nextTest)}</td></tr>`).join(''),'No new evidence problems identified; continue forward observation.')}
      ${b?`<p class="core-muted">Paid models DISABLED / local research enabled. SEC adapter budget: ${b.calls}/${b.limits.calls} calls · ${b.reservedTokens}/${b.limits.tokens} reserved tokens · ${b.actualTokens} reported tokens · ${b.uncertain} uncertain calls. ${escape(b.scope)}.</p>`:''}
      <details><summary>Cross-venue opportunity memory</summary>${table(['Markets','Status','Conditional payoff','Evidence / blockers'],(intelligence?.opportunities||[]).map(o=>`<tr><td>${escape(o.market.join(' / '))}</td><td>${o.stale?'STALE':escape(o.status)}</td><td>${dollars(o.conditionalPayoffUsd)}</td><td>${escape([...o.supportingEvidence,...o.contradictingEvidence].join(' · '))}</td></tr>`).join(''),'Compare contracts in Arbitrage to record observed differences.')}<p class="core-muted">Conditional payoffs are not expected returns. Quotes expire after 30 seconds; settlement and non-atomic execution risks remain.</p></details>`;
  }
  function capabilityCard(value){
    const rows=Array.isArray(value)?value:value?.rows;if(!Array.isArray(rows))return '';
    const label=v=>typeof v==='string'?v:v?.state||v?.status||v?.id||'Unknown';
    return '<h3>Module evidence and paper readiness</h3><p class="core-muted">Declared capabilities, data readiness, evaluator coverage, and applied paper state are separate checks.</p>'+table(['Module / role','Collection','Evaluator','Paper / applied hash','Decision','Blockers'],rows.map(r=>'<tr><td>'+escape(r.id)+'<small>'+escape(r.role)+'</small></td><td>'+escape(label(r.collection))+'</td><td>'+escape(label(r.evaluator))+'</td><td>'+escape(label(r.paper))+'<small>'+escape(r.appliedStrategy?.paramsHash||r.appliedStrategy?.hash||r.appliedStrategy?.strategyHash||'No applied hash reported')+'</small></td><td>'+escape(label(r.decision))+'</td><td>'+escape((r.blockers||[]).join(' · '))+'</td></tr>').join(''));
  }
  function markedRiskCard(metrics){
    if(!metrics)return '<p class="core-notice">Marked risk valuation is not reported by this service.</p>';
    const m=metrics,num=v=>v===null||v===undefined?'Unknown':dollars(v),limitations=m.limitations||[],excluded=m.excludedAccounts||[];
    return `<h3>Marked paper equity <small>${escape(m.scope||'Scope unknown')} · ${m.consolidatedComplete?'all reported currencies included':'limited coverage'}</small></h3><div class="core-lcd"><span>PAPER equity ${num(m.equityUsd)}</span><span>PAPER cash ${num(m.cashUsd)}</span><span>PAPER unrealized P/L ${num(m.unrealizedPnlUsd)}</span><span>PAPER daily P/L ${num(m.dailyPnlUsd)}</span><span>PAPER high-water drawdown ${m.drawdownPct==null?'Unknown':Number(m.drawdownPct).toFixed(2)+'%'}</span></div><p class="core-muted">${escape(m.method||'Method unavailable')} · history begins ${when(m.historySince)}. Deposits and withdrawals are treated separately from performance.</p>${limitations.length?'<p class="core-error">Valuation incomplete: '+limitations.map(x=>escape([x.venue,x.account,x.instrumentId,x.reason].filter(Boolean).join(' / '))).join(' · ')+'</p>':''}${excluded.length?'<p class="core-notice">Excluded from USD totals: '+excluded.map(x=>escape([x.venue,x.account,x.currency,x.reason].filter(Boolean).join(' / '))).join(' · ')+'. No unverified currency conversion is applied.</p>':''}`;
  }
  function command(){
    if(!snapshot)return `<div class="core-heading"><h2>COMMAND CENTER</h2><span class="mpo-badge">PAPER / RESEARCH</span></div>${commandOverview()}`;
    const r=snapshot.risk||{},accounts=overviewArray(snapshot.portfolio?.accounts);
    return `<div class="core-heading"><span class="core-light ${String(r.state||'unknown').toLowerCase()}"></span><h2>COMMAND CENTER</h2><span class="mpo-badge">CORE · PAPER</span></div>
      ${commandOverview()}
      <div class="core-risk"><strong>${escape(r.state||'Risk state unknown')}</strong>${(r.stateReasons||[]).length&&!r.halted?`<span class="core-muted">${escape(r.stateReasons.join(' · '))}</span>`:''}<span>${r.halted?'All further live submissions and core paper fills are stopped.': 'Core paper proposals are checked before every fill.'}</span>${button('halt','STOP ALL LIVE TRADING','class="core-stop"')}</div>
      <p class="core-muted">The stop persists across restarts. Orders already at a venue require reconciliation or cancellation in that program.</p>
      ${r.halted?button('resume','Resume core paper trading'):''}
      <div class="core-toolbar">${button('open-kalshi','Kalshi')}${button('open-poly','Polymarket')}${button('open-arbitrage','Arbitrage')}${button('refresh','Refresh')}</div>
      ${(snapshot.legacy?.mirror||[]).some(m=>m.status!=='RECONCILED')?'<p class="core-error">Ledger mirror needs attention: '+(snapshot.legacy.mirror.filter(m=>m.status!=='RECONCILED').map(m=>escape(m.source+' '+m.status)).join(' / '))+'. Trading books are separate; inspect Legacy reconciliation below.</p>':''}
      ${detailPanel('mission','Research attention and cross-venue opportunity memory',()=>missionCard())}
      ${detailPanel('scoreboard','Full scoreboard and baseline comparisons',()=>scoreboardCard())}
      ${detailPanel('pumpstudies','Pump.fun profit capture and wallet crowd studies',()=>(window.mpoPumpProfitHTML?.(window.__MPO_PROFIT_CAPTURE,true)||'')+(window.mpoWalletCrowdHTML?.(window.__MPO_WALLET_CROWD,true)||''))}
      ${detailPanel('events','Cross-market events and supporting evidence',()=>eventsCard())}
      ${detailPanel('markedrisk','Marked paper valuation and coverage',()=>markedRiskCard(r.metrics))}
      ${snapshot.practiceMarkSync?`<p class="core-muted">Practice valuation: ${escape(snapshot.practiceMarkSync.status)} / ${snapshot.practiceMarkSync.marks} observed-depth marks. Source: cached public Coinbase quotes with practice fee/slippage assumptions, not Robinhood execution. ${(snapshot.practiceMarkSync.issues||[]).map(i=>escape(i.reason)).join(' / ')}</p>`:''}
      ${detailPanel('capabilities','Module readiness and evidence coverage',()=>capabilityCard(snapshot.capabilities))}
      ${detailPanel("accounts","Paper accounts and historical mirrors",()=>`      <h3>Ledger accounts <small>PAPER simulated funds · P/L below is PAPER</small></h3>
      ${table(['Venue / account','Currency','PAPER Cash','PAPER Realized P/L','PAPER Fees','Positions'],accounts.map(a=>{const amt=v=>a.currency==='USD'?dollars(v):`${Number(v).toLocaleString(undefined,{maximumFractionDigits:6})} ${escape(a.currency)}`;return `<tr><td>${escape(a.venue)} / ${escape(a.account)}${String(a.account).startsWith('legacy-')?` <small>${escape(mirrorLabel(a))}</small>`:''}</td><td>${escape(a.currency)}</td><td>${amt(a.cash)}</td><td>${amt(a.realized)}</td><td>${amt(a.fees)}</td><td>${a.positions.length}</td></tr>`}).join(''),'No core accounts have been funded. Add an explicit simulated deposit in Markets to begin.')}
      <p class="core-notice">${escape(snapshot.coverage?.note||'Legacy and currency coverage not reported.')}</p>
`)}
      ${detailPanel("providers","Provider connectivity and read-only venue accounts",()=>`      <h3>Provider connectivity</h3>${table(['Provider','State','Last success','Latency','WebSocket'],snapshot.providers.map(p=>`<tr><td>${escape(p.id)}</td><td>${escape(p.status)}</td><td>${when(p.lastSuccess)}</td><td>${p.latencyMs===null?'—':p.latencyMs+' ms'}</td><td>${escape(p.websocket)}</td></tr>`).join(''))}
      <h3>Venue accounts <small>Read-only reconciliation against the LIVE ledger · live trading stays locked either way</small></h3>
      ${table(['Venue','State','Venue cash','Ledger cash','Differences','Checked','Notes'],(snapshot.venueAccounts||[]).map(v=>`<tr><td>${escape(v.venue)}</td><td><span class="core-light ${v.state==='RECONCILED'?'':['NOT_IN_LEDGER','DIFFERENCE','NO_CREDENTIALS'].includes(v.state)?'yellow':'red'}"></span> ${escape(v.state)}</td><td>${v.venueCash==null?'—':dollars(v.venueCash)}${v.cashLabel?` <small>${escape(v.cashLabel)}</small>`:''}</td><td>${v.ledgerCash==null?'—':dollars(v.ledgerCash)}</td><td><small>${escape((v.differences||[]).map(d=>`${d.field}: venue ${d.venue} vs ledger ${d.ledger}`).join(' · '))}</small></td><td>${when(v.at)}</td><td><small>${escape(v.detail||'')}</small>${v.state==='NOT_IN_LEDGER'?`<form data-core-form="opening" class="core-inline"><input type="hidden" name="venue" value="${escape(v.venue)}"><input name="confirmation" required placeholder="RECORD VENUE OPENING BALANCE" style="width:210px"><button class="btn" type="submit">Record cash</button></form>`:''}</td></tr>`).join(''),'Not checked yet.')}${button('reconcile','Reconcile venue accounts now')}
`)}
      ${detailPanel("legacy","Legacy reconciliation and source books",()=>`      <h3>Legacy books <small>Books kept by their own programs; currencies never converted</small></h3>
      ${table(['Ledger mirror','Status','Book cash','Ledger cash','Difference','Last sync','Notes'],((snapshot.legacy||{}).mirror||[]).map(m=>`<tr><td>${escape(m.source)} <small>epoch ${m.epoch}</small></td><td><span class="core-light ${m.status==='RECONCILED'?'':m.status==='DIFFERENCE'?'yellow':'red'}"></span> ${escape(m.status)}</td><td>${m.detail.bookCash??'—'}</td><td>${m.detail.ledgerCash??'—'}</td><td>${m.detail.diff??'—'}</td><td>${when(m.synced_at)}</td><td><small>${escape([m.detail.failed,...(m.detail.notes||[])].filter(Boolean).join(' · '))}</small></td></tr>`).join(''),'Not synced yet. The app syncs every minute.')}${button('legacy-sync','Sync legacy books now')}${table(['Book','Mode','Status','Cash','Open','Open cost','Realized P/L'],((snapshot.legacy||{}).books||[]).map(b=>{const amt=v=>v===null||v===undefined?'unavailable':`${Number(v).toFixed(b.currency==='SOL'?4:2)} ${escape(b.currency)}`;return `<tr><td>${escape(b.label)}</td><td>${escape(b.mode)}</td><td>${escape(b.status)}${b.reason?`<small>${escape(b.reason)}</small>`:''}${b.unverifiedFills?`<small>${b.unverifiedFills} fill(s) unverified</small>`:''}</td><td>${amt(b.cash)}</td><td>${b.openPositions??'—'}</td><td>${amt(b.openCost)}</td><td>${amt(b.realized)}${b.realizedScope?`<small>${escape(b.realizedScope)}</small>`:''}</td></tr>`;}).join(''),'Legacy coverage unavailable.')}
`)}
      ${detailPanel("strategies","Strategy lifecycle and promotion evidence",()=>`      <h3>Strategies <small>Lifecycle DRAFT → BACKTESTING → PAPER → CANDIDATE; promotion needs sample, out-of-sample net after costs, drawdown and fold stability</small></h3>${table(['Strategy','Version','Markets','State','Mode','Evidence','Lab state','Gate blockers','Move to'],(snapshot.strategies||[]).map(x=>{const l=(snapshot.labSync?.results||[]).find(r=>r.id===x.id),ev=x.evidence||{};
        const evText=Object.keys(ev).length?`n=${ev.sampleSize??'?'} · OOS ${ev.outOfSampleNetUsd??ev.outOfSampleNetPct??'?'}${ev.outOfSampleNetPct!==undefined?'%':''} · folds+ ${ev.positiveFoldShare===undefined||ev.positiveFoldShare===null?'?':(ev.positiveFoldShare*100).toFixed(0)+'%'} · DD ${ev.maxDrawdownPct??'?'}% · costs ${ev.costsModeled===true?'yes':'no'}`:'none';
        return `<tr><td>${escape(x.name)}</td><td>${escape(String(x.version).slice(0,28))}</td><td>${escape(x.markets.join(', '))}</td><td><b>${escape(x.state)}</b></td><td>${escape(x.executionMode)}</td><td><small>${escape(evText)}</small></td><td>${l?escape(l.labState||'none'):'—'}</td><td>${l?.blockers?.length?escape(l.blockers.join(', ')):l?.skipped?`<small>${escape(l.skipped)}</small>`:'—'}</td>
          <td>${x.state==='RETIRED'?'—':`<form data-core-form="strategy" class="core-inline"><input type="hidden" name="id" value="${escape(x.id)}"><select name="to">${['DRAFT','BACKTESTING','PAPER','CANDIDATE','PAUSED','RETIRED'].filter(s=>s!==x.state).map(s=>`<option>${s}</option>`).join('')}</select><input name="reason" required maxlength="200" placeholder="reason"><button class="btn" type="submit">Apply</button></form>`}</td></tr>`}).join(''),'No strategies registered in the core yet.')}
      <p class="core-muted">Moves are checked by the server: allowed edges only, promotions to PAPER/CANDIDATE need the stored evidence to pass the gate, LIVE is unavailable. Attach evidence from Market Lab → Walk-forward.</p>
`)}
      ${detailPanel('diagnostics','Detailed source diagnostics',()=>diagnosticsCard())}
      ${detailPanel("proposals","Order proposals and decisions",()=>`      <h3>Order proposals</h3>${table(['Time','Venue / outcome','Mode','Status','Risk decision'],snapshot.proposals.map(p=>`<tr><td>${when(p.created_at)}</td><td>${escape(p.payload.venue)} / ${escape(p.payload.outcome)}</td><td>${escape(p.payload.mode)}</td><td>${escape(p.status)}</td><td>${escape(p.decision.reasons.join(', ')||p.decision.state)}</td></tr>`).join(''))}
`)}
      <details><summary>Risk limits / diagnostics</summary><form data-core-form="limits" class="core-limit-grid">${Object.entries(r.limits||{}).map(([k,v])=>`<label>${escape(k)}<input name="${escape(k)}" type="number" min="0.001" step="any" value="${v}" required></label>`).join('')}<button class="btn" type="submit">Save limits</button></form><p>Database ${escape(snapshot.database?.status||'Unknown')}; ${overviewCount(snapshot.database?.ledgerEntries)} ledger entries; event queue ${overviewCount(snapshot.eventBus?.queueDepth)}; dropped ${overviewCount(snapshot.eventBus?.dropped)}; listener errors ${overviewCount(snapshot.eventBus?.listenerErrors)}.</p></details>
      ${detailPanel("ledger","Recent ledger / original currencies",()=>`      <h3>Recent ledger <small>Mode is explicit on every row</small></h3>${table(['Time','Mode','Venue','Kind','Quantity','Gross','Fee'],snapshot.ledger.slice(0,30).map(e=>`<tr><td>${when(e.at)}</td><td><b>${escape(e.mode)}</b></td><td>${escape(e.venue)}</td><td>${escape(e.kind)}</td><td>${escape(e.quantity)}</td><td>${currencyAmount(e.gross,e.currency)}</td><td>${currencyAmount(e.fee,e.currency)}</td></tr>`).join(''))}`)}
`;
  }
  function marketProgram(id){
    const st=states[id],venue=venues[id],categories=[...new Set(st.rows.map(m=>m.data.category).filter(Boolean))];
    const watched=new Set((snapshot?.watchlist||[]).map(w=>w.entity_id));
    const rows=st.rows.filter(m=>(!st.search||`${m.data.title} ${m.sourceId}`.toLowerCase().includes(st.search.toLowerCase()))&&(!st.category||m.data.category===st.category));
    return `<div class="core-heading"><h2>${venue==='kalshi'?'KALSHI':'POLYMARKET · MARKETS'}</h2><span class="mpo-badge">PUBLIC DATA · PAPER EXECUTION · PAPER P/L</span></div>
      <div class="core-toolbar">${button('load','Load active markets')}${button('next','Next page',!st.cursor?'disabled':'')}<label>Search loaded markets <input name="search" value="${escape(st.search)}" placeholder="Event or ticker"></label><label>Category <select name="category"><option value="">All available</option>${categories.map(c=>`<option ${st.category===c?'selected':''}>${escape(c)}</option>`).join('')}</select></label></div>
      <p class="core-muted">${venue==='polymarket'?'Global Polymarket order books. The US Combo Engine remains a separate venue in this suite.':'Kalshi public market metadata and reciprocal YES/NO order-book depth.'} Prices are observations, not model forecasts. ${st.rows.length} loaded.</p>
      ${table(['Watch','Event / contract','YES bid / ask','NO bid / ask','Volume','Expiry',''],rows.map(m=>`<tr><td>${button('watch',watched.has(m.id)?'★':'☆',`data-id="${escape(m.id)}" data-on="${!watched.has(m.id)}" aria-label="Watch ${escape(m.data.title)}"`)}</td><td>${escape(m.data.title)}<small>${escape(m.sourceId)}</small></td><td>${pct(m.data.yesBid)} / ${pct(m.data.yesAsk)}</td><td>${pct(m.data.noBid)} / ${pct(m.data.noAsk)}</td><td>${m.data.volume===null?'—':Number(m.data.volume).toLocaleString()}</td><td>${when(m.data.expiresAt)}</td><td>${button('inspect','Inspect',`data-id="${escape(m.sourceId)}"`)}</td></tr>`).join(''),'Load active markets to fetch provider data.')}
      ${st.detail?marketDetail(id,st.detail):''}
      <details><summary>Fund this paper account</summary><p>No real deposit is made. This creates an explicit simulated funding entry.</p><form data-core-form="fund" class="core-toolbar"><label>Simulated USD <input name="amount" type="number" min="0.01" max="1000000" step="0.01" required placeholder="Amount"></label><button class="btn" type="submit">Record paper deposit</button></form></details>`;
  }
  function marketDetail(id,{contract:c,book:b,proposal}){
    const d=c.data,levels=side=>b[side].asks.slice(0,6).map(l=>`${pct(l.price)} × ${l.quantity}`).join(' · ')||'No asks';
    return `<section class="core-detail"><h3>${escape(d.title)}</h3><p><a href="${escape(c.sourceUrl||'#')}" target="_blank" rel="noreferrer">Open original market</a> · Received ${when(b.observedAt)} · ${escape(b.timeQuality)}</p>
      <div class="core-depth"><div><b>${d.yesLabel?escape(d.yesLabel)+' (YES)':'YES'} asks</b><p>${escape(levels('yes'))}</p></div><div><b>${d.noLabel?escape(d.noLabel)+' (NO)':'NO'} asks</b><p>${escape(levels('no'))}</p></div></div>
      <details><summary>Settlement conditions and known gaps</summary><p>${escape(d.settlementRules||'Settlement rules unavailable')}</p><p>${escape(d.secondaryRules||'')}</p><p>Resolution source: ${escape(d.resolutionSource||'Unavailable')} · Cancellation rules: ${escape(d.cancellationRules||'Unavailable')} · Fee schedule: unavailable.</p></details>
      <form data-core-form="propose" class="core-toolbar"><label>Outcome<select name="outcome"><option value="YES">${d.yesLabel?escape(d.yesLabel)+' (YES)':'YES'}</option><option value="NO">${d.noLabel?escape(d.noLabel)+' (NO)':'NO'}</option></select></label><label>Action<select name="side"><option>BUY</option><option>SELL</option></select></label><label>Contracts<input name="quantity" type="number" min="1" step="1" value="1" required></label><label>Mode<select name="mode"><option>PAPER</option><option>MANUAL_APPROVAL</option></select></label><label>Fee bps (blank = venue schedule)<input name="feeBps" type="number" min="0" max="10000" step="1" value="" placeholder="venue"></label><button class="btn" type="submit">Preview through Risk Governor</button></form>
      <p class="core-muted">Simulated fills use observed depth and the fee assumption shown above. No live order can be sent here.</p>
      ${proposal?`<div class="core-proposal"><b>${escape(proposal.status)} · ${escape(proposal.decision?.state||'')}</b><p>${escape(proposal.decision?.reasons?.join(', ')||'Risk checks passed at preview time. Checks repeat at execution.')} · Estimated cost ${dollars(proposal.decision?.costUsd)}</p>${['PROPOSED','AWAITING_APPROVAL'].includes(proposal.status)?button('execute','Confirm simulated order',`data-id="${escape(proposal.id)}"`):''}</div>`:''}</section>`;
  }
  function executionRiskCard(value){
    const directions=value?.directions||[],risks=[...new Set(directions.flatMap(d=>d.executionRisks||[]))],blocked=[...new Set(directions.flatMap(d=>d.blocked||[]))];
    const scenarios=directions.flatMap(d=>(d.failureScenarios||[]).map(s=>`<tr><td>${escape(d.sideA)} + ${escape(d.sideB)}</td><td>${escape(s.scenario)}</td><td>${dollars(s.capitalAtRisk)}</td><td>${dollars(s.observedImmediateUnwindPnl)}</td><td>Not guaranteed<small>${escape(s.reason)}</small></td></tr>`)).join('');
    return `<p class="core-notice">${escape([...blocked,...risks].join(' · '))}</p><p class="core-muted">Conditional payoff assumes both legs fill and settle as matched. Separate venue orders can leave one unhedged leg; observed unwind prices may disappear.</p>${scenarios?table(['Legs','Failed hedge scenario','Capital at risk','Observed unwind P/L','Unwind'],scenarios):''}`;
  }
  function arbitrage(){
    const options=v=>contracts.filter(c=>c.provider===v).map(c=>`<option value="${escape(c.sourceId)}">${escape(c.data.title)}</option>`).join('');
    return `<div class="core-heading"><h2>ARBITRAGE</h2><span class="mpo-badge">RESEARCH / NO AUTO EXECUTION</span></div><p>Compare complementary contracts using current depth. Settlement equivalence is assessed separately from the price difference.</p>
      <form data-core-form="compare" class="core-compare"><label>Kalshi<select name="a" required><option value="">Select a loaded contract</option>${options('kalshi')}</select></label><label>Polymarket<select name="b" required><option value="">Select a loaded contract</option>${options('polymarket')}</select></label><label>Contracts<input name="quantity" type="number" min="1" step="1" value="1" required></label><button class="btn" type="submit">Compare rules and depth</button></form><p class="core-muted">Load markets in each venue first. Missing rules or fees block a conditional payoff calculation. Execution on separate venues is not atomic.</p>
      <h3>Candidate pairs <small>Heuristic matches among loaded contracts (game, date, side, line)</small></h3>${button('scan','Scan loaded contracts')}
      ${candidates?`<p class="core-muted">Scanned ${candidates.scanned.kalshi} Kalshi and ${candidates.scanned.polymarket} Polymarket contracts. ${escape(candidates.note)}</p>${table(['Match','Kalshi','Polymarket','Orientation','Residual risks',''],candidates.pairs.map(p=>`<tr><td>${escape(p.classification)}</td><td>${escape(p.aTitle)}</td><td>${escape(p.bTitle)}</td><td>${escape(p.orientation||'—')}</td><td><small>${escape([...p.reasons,...p.residualRisks].join(' · ')||'none found')}</small></td><td>${button('compare-pair','Compare',`data-a="${escape(p.a.sourceId)}" data-b="${escape(p.b.sourceId)}"`)}</td></tr>`).join(''),'No candidate pairs among loaded contracts. Load more markets in both venues.')}`:''}
      ${comparison?`<h3>${escape(comparison.classification)}${comparison.orientation?` <small>${comparison.orientation==='INVERTED'?'Inverted: YES on Kalshi pays when NO on Polymarket pays':'Same direction'}</small>`:''}</h3><p>${escape(comparison.note)}</p>${comparison.extraction?`<p class="core-notice">Terms were extracted automatically from venue text and can be wrong.${(comparison.residualRisks||[]).length?' Residual risks: '+escape(comparison.residualRisks.join(' · ')):''}${comparison.differences?.length?' Differences: '+escape(comparison.differences.join(' · ')):''}</p>`:''}${comparison.attestation?`<p class="core-muted">Attested ${when(comparison.attestation.at)}${comparison.attestation.valid?'':' — <b>no longer valid</b>: a venue changed its rule text or the orientation changed'}${comparison.attestation.note?': '+escape(comparison.attestation.note):''}</p>`:''}${comparison.classification==='STRONG MATCH'?`<details><summary>Verify settlement terms (upgrades to EXACT MATCH)</summary><p>Open both markets, read both full rule texts (overtime, postponement, cancellation, resolution source). Only attest if they settle identically in every case. The attestation is void if either venue edits its rules.</p><p><a href="${escape(comparison.a?.sourceUrl||'#')}" target="_blank" rel="noreferrer">Kalshi market</a> · <a href="${escape(comparison.b?.sourceUrl||'#')}" target="_blank" rel="noreferrer">Polymarket market</a></p><form data-core-form="verify" class="core-toolbar"><label>Note<input name="note" maxlength="500" placeholder="What you checked"></label><label>Type: I READ BOTH RULE TEXTS AND THEY SETTLE IDENTICALLY<input name="confirmation" required autocomplete="off"></label><button class="btn" type="submit">Attest</button></form></details>`:''}${table(['Settlement field','Kalshi','Polymarket'],comparison.fields.map(f=>`<tr><td>${escape(f.field)}</td><td>${escape(f.a??'Unavailable')}</td><td>${escape(f.b??'Unavailable')}</td></tr>`).join(''))}
      ${comparison.fees?`<p class="core-muted">Kalshi fees: ${escape(comparison.fees.a)}<br>Polymarket fees: ${escape(comparison.fees.b)}</p>`:''}${table(['Legs','A / B prices','Gross spread','Available size','Fees A / B','After fees','Conditional payoff'],comparison.directions.map(d=>`<tr><td>${d.sideA} + ${d.sideB}</td><td>${pct(d.venueA.averagePrice)} / ${pct(d.venueB.averagePrice)}</td><td><span class="core-spread" style="--spread:${Math.min(100,Math.abs(d.grossSpread||0)*100)}%">${pct(d.grossSpread)}</span></td><td>${Number(d.availableExecutableSize).toLocaleString(undefined,{maximumFractionDigits:2})}</td><td>${d.feeA===null||d.feeA===undefined?'Unavailable':dollars(d.feeA)+' / '+dollars(d.feeB)}</td><td>${pct(d.effectiveSpread)}</td><td>${d.conditionalMatchedPayoff==null?'Unavailable':dollars(d.conditionalMatchedPayoff)}</td></tr>`).join(''))}${executionRiskCard(comparison)}`:''}`;
  }
  function draw(id){
    if(!paneVisible(id))return;const host=hostOf(id),w=document.querySelector(`.window[data-app="${host}"]`),simple=w.classList.contains('glance');
    const root=document.getElementById(simple?'glance-'+host:'body-'+id);if(!root)return;
    if(root.contains(document.activeElement)&&document.activeElement.matches('input,select,textarea'))return;
    const top=root.scrollTop;
    const html=simple?platformGlance(id):`<div class="core-app" data-core-id="${id}">${error?`<p class="core-error" role="alert">${escape(error)}</p>`:''}${busy?'<p role="status">Working…</p>':''}${id==='command'?command():id==='arbitrage'?arbitrage():marketProgram(id)}</div>`;
    if(root._mpoHTML===html)return;root._mpoHTML=html;root.innerHTML=html;root.scrollTop=top;
  }
  // Simple view for Arbitrage: candidate Kalshi–Polymarket pairs among the loaded contracts (scanned at most every 10 minutes while shown).
  let arbScanAt=0;
  function arbGlance(){
    const k=contracts.filter(c=>c.provider==='kalshi').length,p=contracts.filter(c=>c.provider==='polymarket').length,pairs=candidates?.pairs||[];
    return glance({title:'Arbitrage · research',pill:{label:'No auto execution',tone:''},
      hero:String(pairs.length),heroUnit:'candidate pairs',heroSub:candidates?`scanned ${candidates.scanned.kalshi} Kalshi and ${candidates.scanned.polymarket} Polymarket contracts · matches are heuristics, not arbitrage`:'Scanning loaded contracts…',
      stats:[{label:'Kalshi contracts',value:String(k)},{label:'Polymarket contracts',value:String(p)},{label:'Inverted pairs',value:String(pairs.filter(x=>x.orientation==='INVERTED').length)}],
      visual:`<div class="g-rows g-scroll">${pairs.slice(0,12).map(x=>gRow(`${x.aTitle} ↔ ${x.bTitle}`,`${x.classification}${x.orientation?' · '+x.orientation.toLowerCase():''}`,'',/EQUIVALENT|MATCH/i.test(x.classification)?'ok':'warn')).join('')||`<div class="g-empty">${escape(error||'No candidate pairs among the loaded contracts.')}</div>`}</div>`,
      foot:gFoot(['settlement terms are checked separately','Advanced: compare rules and depth'])});
  }
  function marketsGlance(){
    const poly=contracts.filter(c=>c.provider==='polymarket'),mid=c=>{const d=c.data||{};return d.yesBid!=null&&d.yesAsk!=null?(d.yesBid+d.yesAsk)/2:d.yesAsk??d.yesBid??null};
    return glance({title:'Polymarket · markets',pill:{label:'Research · paper',tone:''},hero:String(poly.length),heroUnit:'contracts loaded',heroSub:'Polymarket listings in the shared market snapshot (YES price shown)',
      stats:[{label:'With a price',value:String(poly.filter(c=>mid(c)!=null).length)},{label:'Kalshi contracts',value:String(contracts.filter(c=>c.provider==='kalshi').length)},{label:'Errors',value:error?'1':'0',tone:error?'g-neg':''}],
      visual:`<div class="g-rows g-scroll">${poly.slice(0,14).map(c=>{const m=mid(c);return gRow(c.data?.title||c.sourceId,c.data?.category||'polymarket',m==null?'—':Math.round(m*100)+'¢','ok')}).join('')||'<div class="g-empty">No Polymarket contracts loaded yet.</div>'}</div>`,
      foot:gFoot(['Advanced: search, order books, details'])});
  }
  globalThis.addEventListener?.('DOMContentLoaded',()=>window.MPOProgramGlance?.register('predictionmarkets',{render:marketsGlance,sig:()=>[contracts.length,error]}));
  globalThis.addEventListener?.('DOMContentLoaded',()=>window.MPOProgramGlance?.register('arbitrage',{render:arbGlance,sig:()=>[contracts.length,candidates?.pairs?.length,error]}));
  function render(){
    ids.forEach(draw);
    if(window.MPOProgramVisible?.('arbitrage')&&!busy&&Date.now()-arbScanAt>600000){arbScanAt=Date.now();request('/arbitrage/candidates').then(v=>{candidates=v;}).catch(e=>{error=e.message;});}
  }
  async function refreshScoreboard(){try{const r=await fetch('/api/scoreboard',{cache:'no-store'});const v=await r.json();if(!r.ok||!Array.isArray(v.rows))throw new Error(v.error||'Scoreboard unavailable');scoreboard=v;scoreboardError='';}catch(e){scoreboardError=e.message;}}
  let diag=null;
  function diagnosticsCard(){
    if(!diag)return '';const d=diag,age=ms=>ms===null||ms===undefined?'—':ms<60000?Math.round(ms/1000)+'s':Math.round(ms/60000)+'m';
    const bad=d.sources.filter(s=>!['CONNECTED','IDLE'].includes(s.status));
    return `<details ${bad.length?'open':''}><summary>System diagnostics · ${d.sources.length} sources${bad.length?` · <b>${bad.length} need attention</b>`:''}</summary>
      ${table(['Source','Kind','State','Last success','Last error','Latency'],d.sources.map(s=>`<tr><td>${escape(s.id)}</td><td>${escape(s.kind)}</td><td><span class="core-light ${s.status==='CONNECTED'?'':s.status==='IDLE'?'yellow':'red'}"></span> ${escape(s.status)}</td><td>${when(s.lastSuccess)}</td><td>${escape(s.lastError||'')}</td><td>${s.latencyMs===null||s.latencyMs===undefined?'—':s.latencyMs+' ms'}</td></tr>`).join(''))}
      <p class="core-muted">Event bus: ${d.eventBus.published} published · ${d.eventBus.delivered} delivered · ${d.eventBus.dropped} dropped · queue ${d.eventBus.queueDepth} · listener errors ${d.eventBus.listenerErrors}${d.eventBus.lastError?' ('+escape(d.eventBus.lastError)+')':''}</p>
      <p class="core-muted">Database: ${escape(d.database.status)} · ${d.database.bytes===null?'size unavailable':(d.database.bytes/1048576).toFixed(1)+' MB'} · ${Object.entries(d.database.tables).map(([k,v])=>`${k} ${v??'?'}`).join(' · ')}</p>
      <p class="core-muted">Caches: macro ${age(d.caches.macroAgeMs)} · weather ${age(d.caches.weatherAgeMs)} · sports ${age(d.caches.sportsAgeMs)} · events ${age(d.caches.eventsAgeMs)} · open replays ${d.caches.openReplays}</p>
      <p class="core-muted">Engine process: ${d.process.rssMb} MB RSS · heap ${d.process.heapUsedMb} MB · up ${Math.round(d.process.uptimeSec/60)} min · ${d.process.cpuCount} CPUs · load ${escape(String(d.process.loadAvg1))} · GPU ${escape(d.process.gpu)}${d.journalError?' · journal: '+escape(d.journalError):''}</p></details>`;
  }
  // Event pages (one event, many markets). Heavier than /status, so fetched every 5 minutes while
  // Command Center is open, without blocking the rest of the window.
  let events=null,eventsAt=0,eventsBusy=false,openEvent=null,eventKind='ALL';
  function loadEvents(force=false){
    const w=document.querySelector('.window[data-app="command"]');if(!paneVisible('command')||w?.classList.contains('glance')||eventsBusy||(!force&&Date.now()-eventsAt<300000))return;
    eventsBusy=true;request('/events'+(force?'?force=1':'')).then(v=>{events=v;eventsAt=Date.now();}).catch(e=>{events={error:e.message,pages:[]};eventsAt=Date.now()-240000;}).finally(()=>{eventsBusy=false;render();});
  }
  function eventsCard(){
    if(!events)return `<h3>Events <small>One event → many markets</small></h3><p class="core-muted">${eventsBusy?'Joining macro, Kalshi, Polymarket, assets and the Wire…':'Loading…'}</p>`;
    const fmt=(v,u)=>v===null||v===undefined?'—':`${Number(v).toLocaleString(undefined,{maximumFractionDigits:3})}${u==='%'?'%':u?' '+u:''}`;
    // Non-macro pages share one generic shape: metrics + sections (correlation.js).
    const generic=pg=>{const open=openEvent===pg.id;
      return `<section class="event-card kind-${escape(pg.kind.toLowerCase())} ${open?'open':''}"><header><button class="linkbtn" type="button" data-core-action="event" data-id="${escape(pg.id)}"><b>${escape(pg.title)}</b></button><small>${escape(pg.kind)} · ${pg.when?escape(new Date(pg.when).toLocaleString()):'—'} · ${escape(pg.whenLabel||'')}</small></header>
        <div class="event-grid">${pg.metrics.map(m=>`<div><small>${escape(m.label)}</small><b>${escape(m.value)}</b><small>${escape(m.sub||'')}</small></div>`).join('')}</div>
        ${open?`<div class="event-detail">${pg.sections.map(s=>`<h4>${escape(s.title)}${s.note?` <small>${escape(s.note)}</small>`:''}</h4>${s.items.length?s.items.map(i=>`<p>${i.url?`<a href="${escape(i.url)}" target="_blank" rel="noreferrer">${escape(i.text)}</a>`:escape(i.text)}${i.sub?` <small>${escape(i.sub)}</small>`:''}</p>`).join(''):'<p class="core-muted">None.</p>'}`).join('')}
          <h4>Exposure</h4><p>${pg.exposure.contracts.length?`${pg.exposure.contracts.length} held contract(s), cost ${dollars(pg.exposure.costUsd)}`:'No core-ledger positions linked.'}</p><p class="core-muted">${escape(pg.provenance)}</p></div>`:''}</section>`;};
    const card=pg=>{if(pg.kind!=='MACRO')return generic(pg);const k=pg.predictionMarkets.kalshi,open=openEvent===pg.id;
      return `<section class="event-card ${open?'open':''}"><header><button class="linkbtn" type="button" data-core-action="event" data-id="${escape(pg.id)}"><b>${escape(pg.title)}</b></button><small>${escape(new Date(pg.when).toLocaleString())} · ${escape(pg.whenLabel)}</small></header>
        <div class="event-grid"><div><small>Kalshi</small><b>${fmt(k.impliedMedian,k.unit)}</b><small>implied median</small></div>
          <div><small>Polymarket</small><b>${pg.predictionMarkets.polymarket.length}</b><small>linked markets</small></div>
          <div><small>MPOS exposure</small><b>${pg.exposure.contracts.length?dollars(pg.exposure.costUsd):'none'}</b><small>core ledger</small></div>
          <div><small>Signals</small><b>${pg.signalCount}</b><small>Wire items</small></div></div>
        ${open?`<div class="event-detail"><h4>Macro</h4><p>${pg.macro.map(m=>`${escape(m.label)}: <b>${fmt(m.value,m.unit)}</b> <small>${escape(m.date||'')}</small>`).join(' · ')}</p>
          <h4>Kalshi ladder <small>${escape(k.eventTicker)} (same Kalshi event)</small></h4><div class="macro-ladder">${k.rungs.map(r=>`<div><span>&gt; ${fmt(r.strike,k.unit)}</span><i style="--p:${(r.p*100).toFixed(0)}%"></i><em>${(r.p*100).toFixed(0)}%</em></div>`).join('')||'<small>No rungs</small>'}</div>
          <h4>Polymarket <small>topic + same window (rule-based)</small></h4>${table(['Market','Event','YES'],pg.predictionMarkets.polymarket.map(x=>`<tr><td>${escape(x.title)}</td><td><small>${escape(x.event||'')}</small></td><td>${pct(x.yes)}</td></tr>`).join(''),'No linked Polymarket markets.')}
          <h4>Markets</h4><p>${pg.assets.map(a=>`${escape(a.symbol)} <b>${a.price===null?'unavailable':Number(a.price).toLocaleString(undefined,{maximumFractionDigits:2})}</b>${a.source?` <small>${escape(a.source)}</small>`:''}`).join(' · ')}</p>
          <h4>Exposure</h4><p>${pg.exposure.contracts.map(c=>`${escape(c.title)} ${dollars(c.costUsd)}`).join('<br>')||'No core-ledger positions in this event.'} <small>${escape(pg.exposure.note)}</small></p>
          <h4>Signals</h4>${pg.signals.map(s=>`<p><small>${escape(new Date(s.at).toLocaleString())} · ${escape(s.source)} · ${s.importance}</small><br>${s.url?`<a href="${escape(s.url)}" target="_blank" rel="noreferrer">${escape(s.title)}</a>`:escape(s.title)}</p>`).join('')||'<p class="core-muted">None.</p>'}
          <p class="core-muted">${escape(pg.provenance)}</p></div>`:''}</section>`;};
    return `<h3>Events <small>One event → many markets · ${escape(events.note||'')}</small></h3>${events.error?`<p class="core-error">${escape(events.error)}</p>`:''}
      <div class="core-toolbar">${['ALL','MACRO','SPORTS','WEATHER','CORPORATE'].map(k=>`<button class="btn ${eventKind===k?'on':''}" type="button" data-core-action="event-kind" data-kind="${k}">${k}${k!=='ALL'&&events.counts?` <small>${events.counts[k]??0}</small>`:''}</button>`).join('')}</div><div class="event-list">${(events.pages||[]).filter(p=>eventKind==='ALL'||p.kind===eventKind).map(card).join('')||'<p class="core-muted">No upcoming events with Kalshi ladders.</p>'}</div>${(events.errors||[]).length?`<p class="core-muted">${events.errors.map(escape).join(' · ')}</p>`:''}`;
  }
  let refreshing=null;
  function refresh(){if(refreshing)return refreshing;refreshing=(async()=>{const [s,e,d,i]=await Promise.all([request('/status'),request('/entities?kind=Contract'),request('/diagnostics').catch(()=>null),request('/intelligence').catch(e=>({lastError:e.message})),refreshScoreboard()]);intelligence=i;snapshot=s;contracts=overviewArray(e.entities);diag=d;error='';loadEvents();render();if(typeof CustomEvent==='function')globalThis.dispatchEvent?.(new CustomEvent('mpo:overview-data'));})().finally(()=>{refreshing=null});return refreshing;}
  async function action(fn){if(busy)return;busy=true;error='';render();try{await fn();await refresh();}catch(e){error=e.message;}finally{busy=false;render();}}
  function install(api){
    hostApi=api;
    document.addEventListener('toggle',e=>{const d=e.target;if(!d.matches?.('details[data-core-detail]')||!document.contains(d))return;const id=d.dataset.coreDetail;if(d.open===expandedDetails.has(id))return;if(d.open)expandedDetails.add(id);else expandedDetails.delete(id);render();},true);
    document.addEventListener('click',e=>{
      const btn=e.target.closest('[data-core-action]');if(!btn)return;const id=btn.closest('[data-core-id]')?.dataset.coreId,a=btn.dataset.coreAction,st=states[id];
      // Expanding an event page is local UI state: never blocked by a refresh in progress.
      if(a==='event'){openEvent=openEvent===btn.dataset.id?null:btn.dataset.id;render();return;}
      if(a==='event-kind'){eventKind=btn.dataset.kind;render();return;}
      if(a==='halt'){request('/risk/halt',{}).then(refresh).catch(e=>{error=e.message;render();});return;}
      if(a.startsWith('open-')){const dest={kalshi:'kalshi',poly:'predictionmarkets',arbitrage:'arbitrage',pump:'trade',robinhood:'robinhood',stocks:'stocks',lab:'marketlab',evolution:'evolution'}[a.slice(5)];api.open(dest);render();return;}
      action(async()=>{
        if(a==='refresh'){loadEvents(true);return;}
        if(a==='legacy-sync'){await request('/legacy/sync',{});return;}
        if(a==='reconcile'){await request('/accounts/reconcile',{});return;}
        if(a==='halt')await request('/risk/halt',{});
        else if(a==='resume')await request('/risk/resume-paper',{confirmation:'RESUME PAPER TRADING'});
        else if(a==='load'||a==='next'){const data=await request(`/markets?venue=${venues[id]}${a==='next'?'&cursor='+encodeURIComponent(st.cursor):''}`);st.rows=data.markets;st.cursor=data.cursor;st.detail=null;}
        else if(a==='inspect')st.detail=await request(`/book?venue=${venues[id]}&id=${encodeURIComponent(btn.dataset.id)}`);
        else if(a==='watch')await request('/watchlist',{id:btn.dataset.id,on:btn.dataset.on==='true'});
        else if(a==='scan')candidates=await request('/arbitrage/candidates');
        else if(a==='compare-pair'){lastPair={a:btn.dataset.a,b:btn.dataset.b,quantity:1};comparison=await request('/compare',{a:{venue:'kalshi',sourceId:lastPair.a},b:{venue:'polymarket',sourceId:lastPair.b},quantity:1});}
        else if(a==='execute'){const r=await request('/orders/execute',{id:btn.dataset.id,confirmation:'EXECUTE PAPER ORDER'});st.detail.proposal={...st.detail.proposal,...r};}
      });
    });
    document.addEventListener('change',e=>{const id=e.target.closest('[data-core-id]')?.dataset.coreId;if(states[id]&&['search','category'].includes(e.target.name)){states[id][e.target.name]=e.target.value;e.target.blur();draw(id);}});
    document.addEventListener('submit',e=>{
      const form=e.target.closest('[data-core-form]');if(!form)return;e.preventDefault();const id=form.closest('[data-core-id]').dataset.coreId,input=Object.fromEntries(new FormData(form));
      action(async()=>{
        if(form.dataset.coreForm==='fund')await request('/paper/fund',{venue:venues[id],amount:input.amount,id:crypto.randomUUID()});
        else if(form.dataset.coreForm==='limits')await request('/risk/limits',Object.fromEntries(Object.entries(input).map(([k,v])=>[k,Number(v)])));
        else if(form.dataset.coreForm==='propose')states[id].detail.proposal=await request('/orders/propose',{...input,venue:venues[id],sourceId:states[id].detail.contract.sourceId,id:crypto.randomUUID()});
        else if(form.dataset.coreForm==='compare'){lastPair={a:input.a,b:input.b,quantity:Number(input.quantity)};comparison=await request('/compare',{a:{venue:'kalshi',sourceId:input.a},b:{venue:'polymarket',sourceId:input.b},quantity:lastPair.quantity});}
        else if(form.dataset.coreForm==='opening')await request('/accounts/opening-balance',{venue:input.venue,confirmation:input.confirmation});
        else if(form.dataset.coreForm==='strategy')await request('/strategies/transition',{id:input.id,to:input.to,reason:input.reason});
        else if(form.dataset.coreForm==='verify'&&lastPair){await request('/compare/verify',{a:{venue:'kalshi',sourceId:lastPair.a},b:{venue:'polymarket',sourceId:lastPair.b},confirmation:input.confirmation,note:input.note});comparison=await request('/compare',{a:{venue:'kalshi',sourceId:lastPair.a},b:{venue:'polymarket',sourceId:lastPair.b},quantity:lastPair.quantity});}
      });
    });
    action(refresh);
    setInterval(()=>{if(!document.hidden&&!busy&&overviewVisible())refresh().catch(e=>{error=e.message;render();});},10000);
  }
  Object.defineProperty(render,'overview',{get:()=>({snapshot,diag,scoreboard,contracts})});
  return {install,render};
})();
Object.defineProperty(window.MPOSPlatform,'overview',{get:()=>window.MPOSPlatform.render.overview});
