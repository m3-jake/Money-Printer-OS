/* Shared programs inside the existing MPOS desktop. Provider calls stay on the server. */
window.MPOSPlatform = (() => {
  const escape = v => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dollars = v => v===null||v===undefined?'Unavailable':'$'+Number(v).toLocaleString(undefined,{maximumFractionDigits:4});
  const pct = v => v===null||v===undefined?'—':(Number(v)*100).toFixed(1)+'%';
  const when = v => v?new Date(v).toLocaleString():'Unavailable';
  const states={kalshi:{rows:[],cursor:null,search:'',category:'',detail:null},predictionmarkets:{rows:[],cursor:null,search:'',category:'',detail:null}};
  let snapshot=null,contracts=[],comparison=null,candidates=null,lastPair=null,error='',busy=false,hostApi=null;
  let scoreboard=null,scoreboardError='';
  const venues={kalshi:'kalshi',predictionmarkets:'polymarket'};
  const ids=['command','kalshi','arbitrage','predictionmarkets'];
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
      return `<tr class="sb-${led(r.beatsBaseline)}"><td><span class="core-led ${led(r.beatsBaseline)}" aria-hidden="true"></span>${escape(r.module)}<small>${escape(r.book)}${r.kind==='lab'?' · '+escape(r.state):''}</small></td>
        <td class="num">${sbAmount(r.netPnl,r.unit)}${sbSpark(r.curve)}</td><td class="num">${r.closes}${r.per==='session'?'<small>sessions</small>':''}</td>
        <td class="num">${r.hitRate===null||r.hitRate===undefined?'—':(r.hitRate*100).toFixed(0)+'%'} · ${pf}</td><td class="num">${sbAmount(r.netPerTrade,r.unit)}</td>
        <td>${escape(r.baseline.label)}<small>${r.baseline.netPnl===null?'unavailable':sbAmount(r.baseline.netPnl,r.unit)}</small></td>
        <td title="${escape(r.reason||'')}"><b class="sb-verdict">${escape(r.beatsBaseline)}</b></td>
        <td class="num${r.outlier?' sb-outlier':''}" title="${r.bestTrade?'Best trade '+sbAmount(r.bestTrade.pnl,r.unit):''}">${sbAmount(r.netWithoutBest,r.unit)}${r.outlier?'<small>ONE TRADE</small>':''}</td>
        <td class="sb-fresh ${escape(String(f.status||'').toLowerCase())}">${escape(f.status||'—')}<small>${sbAge(f.ageMs)}</small></td></tr>`;}).join('');
    return `<h3>Scoreboard <small>Is each module working? Net after fees, against its own baseline. Paper and shadow only.</small></h3>
      <div class="core-lcd" role="status"><span><span class="core-led yes"></span>${s.beating} beating</span><span><span class="core-led no"></span>${s.notBeating} not</span><span><span class="core-led wait"></span>${s.notEnoughData} not enough data</span><span>${s.outlierDriven} one-trade</span><span>${s.stale} stale</span></div>
      ${table(['Module / book','Net after fees','Closes','Hit · PF','Net / trade','Baseline','Beats?','Without best','Data'],rows,'No modules reported.')}
      <p class="core-muted">${escape(scoreboard.rules)}${scoreboard.errors?.length?' Unreadable: '+escape(scoreboard.errors.map(e=>e.source).join(', '))+'.':''}</p>`;
  }
  function command(){
    if(!snapshot)return '<p>Connecting to the common ledger…</p>';
    const r=snapshot.risk,accounts=snapshot.portfolio.accounts;
    return `<div class="core-heading"><span class="core-light ${String(r.state).toLowerCase()}"></span><h2>COMMAND CENTER</h2><span class="mpo-badge">CORE · PAPER</span></div>
      <div class="core-risk"><strong>${r.state}</strong>${(r.stateReasons||[]).length&&!r.halted?`<span class="core-muted">${r.stateReasons.join(' · ')}</span>`:''}<span>${r.halted?'All further live submissions and core paper fills are stopped.': 'Core paper proposals are checked before every fill.'}</span>${button('halt','STOP ALL LIVE TRADING','class="core-stop"')}</div>
      <p class="core-muted">The stop persists across restarts. Orders already at a venue require reconciliation or cancellation in that program.</p>
      ${r.halted?button('resume','Resume core paper trading'):''}
      <div class="core-toolbar">${button('open-kalshi','Kalshi')}${button('open-poly','Polymarket')}${button('open-arbitrage','Arbitrage')}${button('refresh','Refresh')}</div>
      ${scoreboardCard()}
      <h3>Ledger accounts <small>Simulated funds</small></h3>
      ${table(['Venue / account','Cash','Realized P/L','Fees','Positions'],accounts.map(a=>`<tr><td>${escape(a.venue)} / ${escape(a.account)}</td><td>${dollars(a.cash)}</td><td>${dollars(a.realized)}</td><td>${dollars(a.fees)}</td><td>${a.positions.length}</td></tr>`).join(''),'No core accounts have been funded. Add an explicit simulated deposit in Markets to begin.')}
      <p class="core-notice">${escape(snapshot.coverage.note)} Risk currently values these paper positions at cost basis; live account reconciliation and marked drawdown are unavailable.</p>
      <h3>Provider connectivity</h3>${table(['Provider','State','Last success','Latency','WebSocket'],snapshot.providers.map(p=>`<tr><td>${escape(p.id)}</td><td>${escape(p.status)}</td><td>${when(p.lastSuccess)}</td><td>${p.latencyMs===null?'—':p.latencyMs+' ms'}</td><td>${escape(p.websocket)}</td></tr>`).join(''))}
      <h3>Legacy books <small>Read-only; not in the core ledger; currencies never converted</small></h3>${table(['Book','Mode','Status','Cash','Open','Open cost','Realized P/L'],((snapshot.legacy||{}).books||[]).map(b=>{const amt=v=>v===null||v===undefined?'unavailable':`${Number(v).toFixed(b.currency==='SOL'?4:2)} ${escape(b.currency)}`;return `<tr><td>${escape(b.label)}</td><td>${escape(b.mode)}</td><td>${escape(b.status)}${b.reason?`<small>${escape(b.reason)}</small>`:''}${b.unverifiedFills?`<small>${b.unverifiedFills} fill(s) unverified</small>`:''}</td><td>${amt(b.cash)}</td><td>${b.openPositions??'—'}</td><td>${amt(b.openCost)}</td><td>${amt(b.realized)}${b.realizedScope?`<small>${escape(b.realizedScope)}</small>`:''}</td></tr>`;}).join(''),'Legacy coverage unavailable.')}
      <h3>Strategies <small>Lifecycle DRAFT → BACKTESTING → PAPER → CANDIDATE; promotion needs sample, out-of-sample net after costs, drawdown and fold stability</small></h3>${table(['Strategy','Version','Markets','State','Mode','Lab state','Gate blockers','Updated'],(snapshot.strategies||[]).map(x=>{const l=(snapshot.labSync?.results||[]).find(r=>r.id===x.id);return `<tr><td>${escape(x.name)}</td><td>${escape(String(x.version).slice(0,28))}</td><td>${escape(x.markets.join(', '))}</td><td>${escape(x.state)}</td><td>${escape(x.executionMode)}</td><td>${l?escape(l.labState||'none'):'—'}</td><td>${l?.blockers?.length?escape(l.blockers.join(', ')):l?.skipped?`<small>${escape(l.skipped)}</small>`:'—'}</td><td>${when(x.updatedAt)}</td></tr>`}).join(''),'No strategies registered in the core yet.')}
      <h3>Order proposals</h3>${table(['Time','Venue / outcome','Mode','Status','Risk decision'],snapshot.proposals.map(p=>`<tr><td>${when(p.created_at)}</td><td>${escape(p.payload.venue)} / ${escape(p.payload.outcome)}</td><td>${escape(p.payload.mode)}</td><td>${escape(p.status)}</td><td>${escape(p.decision.reasons.join(', ')||p.decision.state)}</td></tr>`).join(''))}
      <details><summary>Risk limits / diagnostics</summary><form data-core-form="limits" class="core-limit-grid">${Object.entries(r.limits).map(([k,v])=>`<label>${escape(k)}<input name="${escape(k)}" type="number" min="0.001" step="any" value="${v}" required></label>`).join('')}<button class="btn" type="submit">Save limits</button></form><p>Database ${snapshot.database.status}; ${snapshot.database.ledgerEntries} ledger entries; event queue ${snapshot.eventBus.queueDepth}; dropped ${snapshot.eventBus.dropped}; listener errors ${snapshot.eventBus.listenerErrors}.</p></details>
      <h3>Recent ledger</h3>${table(['Time','Venue','Kind','Quantity','Gross','Fee'],snapshot.ledger.slice(0,30).map(e=>`<tr><td>${when(e.at)}</td><td>${escape(e.venue)}</td><td>${escape(e.kind)}</td><td>${escape(e.quantity)}</td><td>${dollars(e.gross)}</td><td>${dollars(e.fee)}</td></tr>`).join(''))}`;
  }
  function marketProgram(id){
    const st=states[id],venue=venues[id],categories=[...new Set(st.rows.map(m=>m.data.category).filter(Boolean))];
    const watched=new Set((snapshot?.watchlist||[]).map(w=>w.entity_id));
    const rows=st.rows.filter(m=>(!st.search||`${m.data.title} ${m.sourceId}`.toLowerCase().includes(st.search.toLowerCase()))&&(!st.category||m.data.category===st.category));
    return `<div class="core-heading"><h2>${venue==='kalshi'?'KALSHI':'POLYMARKET · MARKETS'}</h2><span class="mpo-badge">PUBLIC DATA / PAPER</span></div>
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
  function arbitrage(){
    const options=v=>contracts.filter(c=>c.provider===v).map(c=>`<option value="${escape(c.sourceId)}">${escape(c.data.title)}</option>`).join('');
    return `<div class="core-heading"><h2>ARBITRAGE</h2><span class="mpo-badge">RESEARCH / NO AUTO EXECUTION</span></div><p>Compare complementary contracts using current depth. Settlement equivalence is assessed separately from the price difference.</p>
      <form data-core-form="compare" class="core-compare"><label>Kalshi<select name="a" required><option value="">Select a loaded contract</option>${options('kalshi')}</select></label><label>Polymarket<select name="b" required><option value="">Select a loaded contract</option>${options('polymarket')}</select></label><label>Contracts<input name="quantity" type="number" min="1" step="1" value="1" required></label><button class="btn" type="submit">Compare rules and depth</button></form><p class="core-muted">Load markets in each venue first. Missing rules or fees block a locked-return calculation.</p>
      <h3>Candidate pairs <small>Heuristic matches among loaded contracts (game, date, side, line)</small></h3>${button('scan','Scan loaded contracts')}
      ${candidates?`<p class="core-muted">Scanned ${candidates.scanned.kalshi} Kalshi and ${candidates.scanned.polymarket} Polymarket contracts. ${escape(candidates.note)}</p>${table(['Match','Kalshi','Polymarket','Orientation','Residual risks',''],candidates.pairs.map(p=>`<tr><td>${escape(p.classification)}</td><td>${escape(p.aTitle)}</td><td>${escape(p.bTitle)}</td><td>${escape(p.orientation||'—')}</td><td><small>${escape([...p.reasons,...p.residualRisks].join(' · ')||'none found')}</small></td><td>${button('compare-pair','Compare',`data-a="${escape(p.a.sourceId)}" data-b="${escape(p.b.sourceId)}"`)}</td></tr>`).join(''),'No candidate pairs among loaded contracts. Load more markets in both venues.')}`:''}
      ${comparison?`<h3>${escape(comparison.classification)}${comparison.orientation?` <small>${comparison.orientation==='INVERTED'?'Inverted: YES on Kalshi pays when NO on Polymarket pays':'Same direction'}</small>`:''}</h3><p>${escape(comparison.note)}</p>${comparison.extraction?`<p class="core-notice">Terms were extracted automatically from venue text and can be wrong.${(comparison.residualRisks||[]).length?' Residual risks: '+escape(comparison.residualRisks.join(' · ')):''}${comparison.differences?.length?' Differences: '+escape(comparison.differences.join(' · ')):''}</p>`:''}${comparison.attestation?`<p class="core-muted">Attested ${when(comparison.attestation.at)}${comparison.attestation.valid?'':' — <b>no longer valid</b>: a venue changed its rule text or the orientation changed'}${comparison.attestation.note?': '+escape(comparison.attestation.note):''}</p>`:''}${comparison.classification==='STRONG MATCH'?`<details><summary>Verify settlement terms (upgrades to EXACT MATCH)</summary><p>Open both markets, read both full rule texts (overtime, postponement, cancellation, resolution source). Only attest if they settle identically in every case. The attestation is void if either venue edits its rules.</p><p><a href="${escape(comparison.a?.sourceUrl||'#')}" target="_blank" rel="noreferrer">Kalshi market</a> · <a href="${escape(comparison.b?.sourceUrl||'#')}" target="_blank" rel="noreferrer">Polymarket market</a></p><form data-core-form="verify" class="core-toolbar"><label>Note<input name="note" maxlength="500" placeholder="What you checked"></label><label>Type: I READ BOTH RULE TEXTS AND THEY SETTLE IDENTICALLY<input name="confirmation" required autocomplete="off"></label><button class="btn" type="submit">Attest</button></form></details>`:''}${table(['Settlement field','Kalshi','Polymarket'],comparison.fields.map(f=>`<tr><td>${escape(f.field)}</td><td>${escape(f.a??'Unavailable')}</td><td>${escape(f.b??'Unavailable')}</td></tr>`).join(''))}
      ${comparison.fees?`<p class="core-muted">Kalshi fees: ${escape(comparison.fees.a)}<br>Polymarket fees: ${escape(comparison.fees.b)}</p>`:''}${table(['Legs','A / B prices','Gross spread','Available size','Fees A / B','After fees','Locked return'],comparison.directions.map(d=>`<tr><td>${d.sideA} + ${d.sideB}</td><td>${pct(d.venueA.averagePrice)} / ${pct(d.venueB.averagePrice)}</td><td><span class="core-spread" style="--spread:${Math.min(100,Math.abs(d.grossSpread||0)*100)}%">${pct(d.grossSpread)}</span></td><td>${Number(d.availableExecutableSize).toLocaleString(undefined,{maximumFractionDigits:2})}</td><td>${d.feeA===null||d.feeA===undefined?'Unavailable':dollars(d.feeA)+' / '+dollars(d.feeB)}</td><td>${pct(d.effectiveSpread)}</td><td>${d.theoreticalLockedReturn===null?'Unavailable':dollars(d.theoreticalLockedReturn)}</td></tr>`).join(''))}<p class="core-notice">${escape([...new Set(comparison.directions.flatMap(d=>d.blocked))].join(' · '))}</p>`:''}`;
  }
  function draw(id){
    const host=id==='predictionmarkets'?'sportsbook':id,w=document.querySelector(`.window[data-app="${host}"]`);if(!w||w.classList.contains('hidden'))return;
    const root=document.getElementById((w.classList.contains('glance')?'glance-':'body-')+id);if(!root)return;
    if(root.contains(document.activeElement)&&document.activeElement.matches('input,select,textarea'))return;
    const top=root.scrollTop;
    root.innerHTML=`<div class="core-app" data-core-id="${id}">${error?`<p class="core-error" role="alert">${escape(error)}</p>`:''}${busy?'<p role="status">Working…</p>':''}${id==='command'?command():id==='arbitrage'?arbitrage():marketProgram(id)}</div>`;root.scrollTop=top;
  }
  function render(){ids.forEach(draw);}
  async function refreshScoreboard(){try{const r=await fetch('/api/scoreboard',{cache:'no-store'});const v=await r.json();if(!r.ok||!Array.isArray(v.rows))throw new Error(v.error||'Scoreboard unavailable');scoreboard=v;scoreboardError='';}catch(e){scoreboardError=e.message;}}
  async function refresh(){const [s,e]=await Promise.all([request('/status'),request('/entities?kind=Contract'),refreshScoreboard()]);snapshot=s;contracts=e.entities;render();}
  async function action(fn){if(busy)return;busy=true;error='';render();try{await fn();await refresh();}catch(e){error=e.message;}finally{busy=false;render();}}
  function install(api){
    hostApi=api;
    document.addEventListener('click',e=>{
      const btn=e.target.closest('[data-core-action]');if(!btn)return;const id=btn.closest('[data-core-id]')?.dataset.coreId,a=btn.dataset.coreAction,st=states[id];
      if(a==='halt'){request('/risk/halt',{}).then(refresh).catch(e=>{error=e.message;render();});return;}
      if(a.startsWith('open-')){const dest={kalshi:'kalshi',poly:'predictionmarkets',arbitrage:'arbitrage'}[a.slice(5)];api.open(dest);render();return;}
      action(async()=>{
        if(a==='refresh')return;
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
        else if(form.dataset.coreForm==='verify'&&lastPair){await request('/compare/verify',{a:{venue:'kalshi',sourceId:lastPair.a},b:{venue:'polymarket',sourceId:lastPair.b},confirmation:input.confirmation,note:input.note});comparison=await request('/compare',{a:{venue:'kalshi',sourceId:lastPair.a},b:{venue:'polymarket',sourceId:lastPair.b},quantity:lastPair.quantity});}
      });
    });
    action(refresh);
    setInterval(()=>{if(!document.hidden&&!busy&&ids.some(id=>{const w=document.querySelector(`.window[data-app="${id}"]`);return w&&!w.classList.contains('hidden');}))refresh().catch(e=>{error=e.message;render();});},10000);
  }
  return {install,render};
})();
