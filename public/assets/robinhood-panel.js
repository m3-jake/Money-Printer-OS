// Robinhood panel. This release is paper-only: API credentials feed authenticated market data,
// while the backend hard-rejects Robinhood real-order, cancel, reconcile and real-autopilot mutations.
let rhState=null,rhSubmitting=false,rhRefreshBusy=false,rhMessage='',rhDraft={},rhPreview=null;
// View and chart range/symbol survive restarts.
const rhPref=(k,d)=>{try{const v=JSON.parse(localStorage.getItem(k));return v??d}catch{return d}};
const rhSave=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch{}};
let rhView=rhPref('mpo-rh-view','paper');
const RH_VIEWS={paper:['head','cryptohead','live','order','autopilot','qual','positions','closes'],why:['head','cryptohead','live','signals','gauges'],charts:['head','cryptohead','charts'],explore:['head','cryptohead','explore'],daily:['head','cryptohead','daily'],stocks:['head','stocks'],practice:['head','practice'],more:['head','cryptohead','connection','evolution','real','reset']};
if(!RH_VIEWS[rhView])rhView='paper';
// Each view fits the window without scrolling; nothing is deleted, other views' parts are just not shown.
// Multi-asset suite: crypto (strict book + its views), stocks & ETFs (§25 paper lane), and the isolated practice sandbox.
const RH_VIEW_LABELS={paper:'Crypto paper',why:'Why not trading',charts:'Charts',explore:'Exploration',daily:'Daily bars',stocks:'Stocks & ETFs',practice:'Practice',more:'More'};
const RH_VIEW_SUB={daily:'CRYPTO · DAILY BARS · PAPER ONLY',stocks:'STOCKS & ETFS · PAPER · ALPACA DATA',practice:'CRYPTO PRACTICE SANDBOX · NEVER COUNTS'};
function rhViewTabs(){return `<div class="rh-tabs">${Object.keys(RH_VIEWS).map(v=>`<button class="btn ${v===rhView?'on':''}" data-rh-view="${v}">${RH_VIEW_LABELS[v]}</button>`).join('')}</div>`}
// Stocks & ETFs lane: read-only GET /api/robinhood-equities (§25), at most once a minute unless forced.
let rhEq=null,rhEqAt=0,rhEqBusy=false,rhEqError=null;
async function rhLoadEquities(force=false){
 if(rhEqBusy||(!force&&Date.now()-rhEqAt<60000))return;rhEqBusy=true;
 try{const r=await fetch('/api/robinhood-equities');const d=await r.json();if(!r.ok||d.ok===false)throw Error(d.error||'stocks & ETFs request failed');rhEq=d;rhEqError=null}
 catch(e){rhEqError=e.message}
 finally{rhEqAt=Date.now();rhEqBusy=false;if(windowVisible('robinhood')&&rhView==='stocks')renderRobinhood()}
}
// Honest one-line readiness for the whole suite. Fee: the account's tier when authenticated, else the 0.95%/side fallback.
function rhReadinessText(st){
 const f=Number(st?.account?.feeRatio),fee=Number.isFinite(f)&&f>=0?f:0.0095;
 return `Crypto: Robinhood Crypto API, paper only; fee ${fmt(fee*100,2)}%/side${st?.account?'':' (fallback until keys authenticate)'}, so about ${fmt(fee*200,1)}% round trip before spread. Stocks & ETFs: paper only on Alpaca public end-of-day bars, not Robinhood quotes; real orders would go only through Robinhood's official Agentic Trading MCP, which is NOT wired in this app. Practice: an isolated sandbox that never counts.`;
}
const RH_EQ_TONE={FRESH:'green',STALE:'amber',ERROR:'red',NO_DATA:'red'};
function rhEqStatusHtml(e){
 const d=e?.data||{},s=d.status||'NO_DATA',needKey=s==='NO_DATA'&&!d.configured;
 return `<span class="mpo-badge" id="rhEqStatus"><b class="${RH_EQ_TONE[s]||''}">${needKey?'NO DATA · ADD A FREE ALPACA KEY':polyEscape(s.replace('_',' '))}</b></span>`;
}
function rhEqCurveSvg(daily,o={}){
 const pts=(daily||[]).filter(p=>Number.isFinite(p.equityUsd)),cid=o.id||'rhEqCurve';
 if(pts.length<2)return `<div class="mpo-empty" id="${cid}">${o.empty||'The equity curve starts at the first marked session close'}${pts.length?' (1 so far)':''}; it is drawn next to ${o.bench||'buy-and-hold SPY'} and cash from that day.</div>`;
 const W=460,H=190,pl=6,pr=62,pt=10,pb=18,vals=pts.flatMap(p=>[p.equityUsd,p.benchUsd,p.cashUsd]).filter(Number.isFinite);
 let lo=Math.min(...vals),hi=Math.max(...vals);const pad=Math.max(0.5,(hi-lo)*0.1);lo-=pad;hi+=pad;
 const x=i=>pl+i/Math.max(1,pts.length-1)*(W-pl-pr),y=v=>pt+(hi-v)/(hi-lo)*(H-pt-pb);
 const line=k=>pts.map((p,i)=>Number.isFinite(p[k])?(i?'L':'M')+x(i).toFixed(1)+' '+y(p[k]).toFixed(1):'').join('');
 const tag=(k,c)=>{const v=pts.at(-1)[k];return Number.isFinite(v)?`<text x="${W-pr+4}" y="${(y(v)+4).toFixed(1)}" fill="${c}" font-size="11">${rhMoney(v)}</text>`:''};
 return `<svg id="${cid}" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${o.aria||'Stocks and ETFs paper equity vs buy-and-hold SPY and cash'}" style="display:block;background:#0d1419;border:1px solid ${RH_C.grid}">
 <path class="rh-eq-cash" d="${line('cashUsd')}" fill="none" stroke="${RH_C.text}" stroke-width="1" stroke-dasharray="4 3"/>
 <path class="rh-eq-spy" d="${line('benchUsd')}" fill="none" stroke="#00c8ff" stroke-width="1.4"/>
 <path class="rh-eq-strategy" d="${line('equityUsd')}" fill="none" stroke="${RH_C.ef}" stroke-width="2"/>
 ${tag('equityUsd',RH_C.ef)}${tag('benchUsd','#00c8ff')}
 <text x="${pl+2}" y="${H-5}" fill="${RH_C.text}" font-size="11">${polyEscape(pts[0].d)}</text><text x="${W-pr}" y="${H-5}" fill="${RH_C.text}" font-size="11" text-anchor="end">${polyEscape(pts.at(-1).d)}</text></svg>`;
}
function rhStocksSection(e){
 if(!e)return `<fieldset class="mpo-fieldset" id="rhStocks"><legend>Stocks &amp; ETFs · paper</legend><p>${polyEscape(rhEqError||'Loading the stocks & ETFs lane...')}</p></fieldset>`;
 const d=e.data||{},b=e.book||{},s=e.strategy||{},m=e.market||{},bl=e.benchmark?.live,rp=e.benchmark?.replay,dec=s.lastDecision,pend=b.pending;
 const pos=Object.entries(b.positions||{}),metric=(label,value,cls='')=>`<div class="mpo-metric"><label>${label}</label><strong class="${cls}">${value}</strong></div>`;
 const weights=Object.entries(pend?.targets||dec?.weights||{}).sort((a,z)=>z[1]-a[1]);
 const pctTxt=v=>v==null||!Number.isFinite(Number(v))?'--':(v>0?'+':'')+fmt(v,2)+'%';
 const stat=(label,x)=>`<tr><td>${label}</td><td>${pctTxt(x?.returnPct)}</td><td>${pctTxt(x?.cagrPct)}</td><td>${pctTxt(x?.maxDrawdownPct)}</td><td>${x?.sharpe==null?'--':fmt(x.sharpe,2)}</td></tr>`;
 return `<fieldset class="mpo-fieldset" id="rhStocks"><legend>Stocks &amp; ETFs · paper · ${polyEscape(s.title||s.id||'')}</legend>
 <p>${rhEqStatusHtml(e)} <span class="mpo-badge">MARKET ${polyEscape(String(m.state||'--').replace('_',' '))}</span> <span class="mpo-badge">PAPER ONLY · NO ROBINHOOD ORDERS</span> <small>${polyEscape(d.providerLabel||'no provider')} · latest bar ${polyEscape(d.latestBar||'--')} · last completed session ${polyEscape(m.lastCompletedSession||'--')}</small></p>
 ${d.status==='NO_DATA'&&!d.configured?`<div class="mpo-empty" id="rhEqNeedKey">Add a free Alpaca key to start this lane: set <code>ALPACA_KEY_ID</code> and <code>ALPACA_SECRET_KEY</code> (Alpaca Basic, market data only) in .env and restart. Without a key the lane never fetches or trades.</div>`:''}
 ${d.lastError||e.lastError?`<div class="mpo-error">${polyEscape((d.lastError?.message||d.lastError||e.lastError?.message||e.lastError)+'')}</div>`:''}
 ${b.recoveryRequired?`<div class="mpo-error">STOCKS BOOK RECOVERY REQUIRED: ${polyEscape(b.recoveryReason||'review the book file')}</div>`:''}
 <div class="metric-grid">${metric('Paper equity',rhMoney(b.equityUsd))}${metric('Return',pctTxt(b.returnPct),(b.returnPct||0)>=0?'green':'red')}${metric('Buy-and-hold SPY',bl?rhMoney(bl.buyHoldSpyUsd)+' ('+pctTxt(bl.buyHoldSpyReturnPct)+')':'--')}${metric('Cash baseline',bl?rhMoney(bl.cashUsd):rhMoney(b.startUsd))}${metric('Cash (settled)',rhMoney(b.cashUsd)+' ('+rhMoney(b.settledCashUsd)+')')}${metric('Next session',polyEscape(m.nextSession||'--'))}</div>
 <div class="mpo-split"><div>
 ${rhEqCurveSvg(b.equityDaily)}
 <div style="font-size:11px;margin:4px 0;color:${RH_C.text}"><span style="color:${RH_C.ef}">— strategy (paper book)</span> · <span style="color:#00c8ff">— buy-and-hold SPY</span> · <span>- - cash (0%)</span> · marked at each session close${bl?.since?' since '+polyEscape(bl.since):''}</div>
 <table class="mpo-table" id="rhEqReplay"><thead><tr><th>Replay${rp?.from?' from '+polyEscape(rp.from):''}</th><th>Return</th><th>CAGR</th><th>Max DD</th><th>Sharpe</th></tr></thead><tbody>${rp?stat('Strategy',rp.strategy)+stat('Buy-and-hold SPY',rp.buyHoldSpy)+stat('Cash',rp.cash):'<tr><td colspan="5">Replay needs fetched history.</td></tr>'}</tbody></table>
 <small>${polyEscape(rp?.note||'Expectation: drawdown control, not alpha.')}</small>
 </div><div>
 <table class="mpo-table" id="rhEqWeights"><thead><tr><th>${pend?'Pending target':'Target weight'}</th><th>Weight</th><th></th></tr></thead><tbody>${weights.length?weights.map(([sym,w])=>`<tr><td>${polyEscape(sym)}</td><td>${fmt(w*100,1)}%</td><td>${rhBar(w,'#39ff68')}</td></tr>`).join(''):'<tr><td colspan="3">No target yet: the first decision needs FRESH data after a completed session.</td></tr>'}</tbody></table>
 <table class="mpo-table" id="rhEqPositions"><thead><tr><th>Position</th><th>Shares</th><th>Avg</th><th>Last</th><th>Value</th></tr></thead><tbody>${pos.length?pos.map(([sym,p])=>`<tr><td>${polyEscape(sym)}</td><td>${fmt(p.qty,4)}</td><td>${rhMoney(p.avgPx)}</td><td>${rhMoney(p.lastPx)}</td><td>${rhMoney((p.qty||0)*(p.lastPx||0))}</td></tr>`).join(''):'<tr><td colspan="5">No stock or ETF positions.</td></tr>'}</tbody></table>
 <p id="rhEqDecision"><b>Last decision:</b> ${dec?polyEscape(dec.session+' · '+(dec.ready?'ready':'not ready')+(dec.reasons?.length?' · '+dec.reasons.join('; '):'')):'none yet'}${pend?` · <b>queued</b> for the ${polyEscape(pend.executeAtOpenOf||'--')} open`:''}${b.lastFill?` · last fill ${polyEscape(b.lastFill.session)}${b.lastFill.late?' (late)':''}`:''} · <b>next session</b> ${polyEscape(m.nextSession||'--')}${b.missedSessions?` · ${polyEscape(String(b.missedSessions))} missed (never decided after the fact)`:''}</p>
 <small>$0 commission + ${polyEscape(String(b.costs?.slippageBps??'--'))} bps slippage + SEC/FINRA sell fees · ${polyEscape(b.costs?.settlement||'T+1')} · long-only, no margin.</small>
 </div></div>
 <p><small>${polyEscape(e.readiness?.text||'')}</small></p></fieldset>`;
}
// Daily-bar crypto book (src/robinhoodDailyBook.js): one decision per closed UTC bar, fills at the next open,
// paper only. rhDailyVerdictLine reads the Lab's raw `daily` block that robinhoodEvolveView passes through.
const rhSignedPct=v=>v==null||!Number.isFinite(Number(v))?'--':(v>0?'+':'')+fmt(Number(v),2)+'%';
const RH_DAILY_TONE={PAPER_REVIEW_READY:'green',NO_EDGE:'amber',INSUFFICIENT_HISTORY:'amber',NO_DATA:'red',ERROR:'red'};
function rhDailyVerdictLine(d){
 if(!d)return '<p class="muted" id="rhDailyVerdict"><small>Daily bars (Lab): no verdict published yet.</small></p>';
 const l=d.leader,h=l?.holdout,ph=String(d.phase||'--');
 const parts=[l?'leader '+polyEscape(l.id||l.family||'--'):'no leader',h?'holdout '+rhSignedPct(h.strategy?.totalReturnPct)+' vs buy-and-hold '+rhSignedPct(h.buyHold?.totalReturnPct):null,d.proposal?'proposal '+polyEscape(d.proposal.id)+' (paper review)':'no proposal',d.blockers?.length?polyEscape(d.blockers[0]):null].filter(Boolean);
 return `<p id="rhDailyVerdict"><small>Daily bars (Lab): <b class="${RH_DAILY_TONE[ph]||''}">${polyEscape(ph.replace(/_/g,' '))}</b> · ${parts.join(' · ')}</small></p>`;
}
function rhDailySection(dy,labDaily){
 if(!dy)return '<fieldset class="mpo-fieldset" id="rhDaily"><legend>Daily bars · crypto paper book</legend><p>Loading the daily-bar book...</p></fieldset>';
 const b=dy.book||{},src=dy.source||{},q=dy.qualification||{},qm=q.metrics||{},dec=b.lastDecision,metric=(label,value,cls='')=>`<div class="mpo-metric"><label>${label}</label><strong class="${cls}">${value}</strong></div>`;
 const params=Object.entries(src.params||{}).map(([k,v])=>k+' '+v).join(', ');
 return `<fieldset class="mpo-fieldset" id="rhDaily"><legend>Daily bars · crypto paper book</legend>
 <p><span class="mpo-badge" id="rhDailyLabel"><b class="${src.kind==='lab-proposal'?'green':'amber'}">${polyEscape(dy.label||src.label||'')}</b></span> <span class="mpo-badge">PAPER ONLY · NEVER LIVE</span> <small>${polyEscape(src.family||'--')} (${polyEscape(params||'--')}) · hash ${polyEscape(src.paramsHash||'--')}</small></p>
 ${src.kind!=='lab-proposal'&&src.reasons?.length?`<p class="muted" id="rhDailyWhyDefault"><small>Not on a Lab proposal: ${polyEscape(src.reasons.join('; '))}</small></p>`:''}
 ${rhDailyVerdictLine(labDaily)}
 ${b.recoveryRequired?`<div class="mpo-error">DAILY BOOK RECOVERY REQUIRED: ${polyEscape(b.recoveryReason||'review the book file')}</div>`:''}
 ${dy.lastError||dy.data?.lastError?`<div class="mpo-error">${polyEscape(String(dy.lastError?.message||dy.data?.lastError?.message||''))}</div>`:''}
 <div class="metric-grid">${metric('Paper equity',rhMoney(b.equityUsd))}${metric('Return',rhSignedPct(b.returnPct),(b.returnPct||0)>=0?'green':'red')}${metric('Buy-and-hold',b.buyHoldUsd==null?'--':rhMoney(b.buyHoldUsd)+' ('+rhSignedPct(b.buyHoldReturnPct)+')')}${metric('Last decided bar',polyEscape(b.lastDecidedDay||'--'))}${metric('Missed days',polyEscape(String(b.missedDays||0)))}${metric('Qualification',q.qualified?'QUALIFIED (paper)':'NOT QUALIFIED',q.qualified?'green':'')}</div>
 <div class="mpo-split"><div>
 ${rhEqCurveSvg(b.equityDaily,{id:'rhDailyCurve',aria:'Daily-bar crypto paper equity vs buy-and-hold and cash',empty:'The daily curve starts at the first marked UTC close',bench:'buy-and-hold'})}
 <div style="font-size:11px;margin:4px 0;color:${RH_C.text}"><span style="color:${RH_C.ef}">— daily book</span> · <span style="color:#00c8ff">— buy-and-hold (same sleeves, same costs)</span> · <span>- - cash (0%)</span> · marked at each UTC close</div>
 <p id="rhDailyQual"><small><b>${q.qualified?'Qualified on paper':'Not qualified'}:</b> ${polyEscape((q.reasons||[]).join('; ')||'all gates pass')} · rules: ${polyEscape(String(q.rules?.minClosedTrades??'--'))}+ closed round trips and ${polyEscape(String(q.rules?.minRunDays??'--'))}+ paper days in a ${polyEscape(String(q.rules?.windowDays??'--'))}-day window, return above cash and above buy-and-hold, drawdown no deeper than buy-and-hold, profit factor ${polyEscape(String(q.rules?.minProfitFactor??'--'))}+ · ${polyEscape(String(qm.closedTrades??0))} trades, ${polyEscape(String(qm.runDays??0))} days · never unlocks live.</small></p>
 </div><div>
 <table class="mpo-table" id="rhDailyPositions"><thead><tr><th>Pair</th><th>State</th><th>Entry</th><th>Last close</th><th>Value</th><th>Open P/L</th></tr></thead><tbody>${(b.positions||[]).map(p=>`<tr><td>${polyEscape(p.symbol)}</td><td class="${p.long?'green':''}">${p.long?'LONG':'FLAT'}</td><td>${p.entry?polyEscape(p.entry.day)+' @ '+rhMoney(p.entry.fillPrice):'--'}</td><td>${rhMoney(p.lastClose)}</td><td>${rhMoney(p.valueUsd)}</td><td>${rhMoney(p.unrealizedUsd)}</td></tr>`).join('')||'<tr><td colspan="6">No sleeves yet.</td></tr>'}</tbody></table>
 <p id="rhDailyDecision"><b>Last decision:</b> ${dec?polyEscape(dec.day+' close · '+Object.entries(dec.bySymbol||{}).map(([s,x])=>s.replace('-USD','')+' '+x.action).join(', ')):'none yet'}${(b.pending||[]).length?' · <b>pending</b> '+polyEscape(b.pending.map(o=>o.side+' '+o.symbol+' at the '+o.fillDay+' open').join(', ')):''}</p>
 <small>${polyEscape(dy.rules||'')} Costs: ${fmt((b.costs?.feeRatio??0.0095)*100,2)}%/side + ${polyEscape(String(b.costs?.slipBps??'--'))} bps slippage.</small>
 <table class="mpo-table" id="rhDailyTrades"><thead><tr><th>Pair</th><th>Entry</th><th>Exit</th><th>Days</th><th>Net</th><th>Exit price from</th></tr></thead><tbody>${(b.history||[]).slice(0,8).map(t=>`<tr><td>${polyEscape(t.symbol)}</td><td>${polyEscape(t.entryDay||'--')}</td><td>${polyEscape(t.exitDay)}</td><td>${polyEscape(String(t.holdDays??'--'))}</td><td class="${(t.pnlUsd||0)>=0?'green':'red'}">${rhMoney(t.pnlUsd)}</td><td><small>${polyEscape(t.priceSource?.exit||'--')}</small></td></tr>`).join('')||'<tr><td colspan="6">No closed daily trades yet (expect one or two a month).</td></tr>'}</tbody></table>
 <div><button id="rhDailyRun">Run daily pass</button><button id="rhDailyReset">Reset daily book…</button></div>
 </div></div></fieldset>`;
}
// Isolated practice sandbox (src/robinhoodPractice.js): its own ledger; never counts toward qualification, promotion or real authority.
function rhPracticeSection(pr){
 if(!pr)return `<fieldset class="mpo-fieldset" id="rhPractice"><legend>Practice sandbox</legend><p>Practice book not loaded yet.</p></fieldset>`;
 const s=pr.settings||{},t=pr.telemetry||{},pos=pr.positions||[],hist=pr.history||[],dis=rhSubmitting?'disabled':'',ld=t.lastDecision||{};
 const metric=(label,value,cls='')=>`<div class="mpo-metric"><label>${label}</label><strong class="${cls}">${value}</strong></div>`;
 const opt=(list,cur)=>list.map(v=>`<option value="${v}" ${v===cur?'selected':''}>${v.replace(/_/g,' ').toLowerCase()}</option>`).join('');
 // Realized curve from the retained closes (oldest first): net after both fees, dashed line before fees.
 let net=0,gross=0,fees=0;const pts=hist.filter(x=>x.status==='CLOSED').slice().reverse().map(x=>{const f=(Number(x.feeUsd)||0)+(Number(x.exit?.feeUsd)||0);net+=Number(x.pnlUsd)||0;fees+=f;gross=net+fees;return {t:x.closedAt||x.at,net:(pr.budgetUsd||0)+net,gross:(pr.budgetUsd||0)+gross}});
 const curve=rhEquitySvg({points:pts.length?[{t:pts[0].t-1,net:pr.budgetUsd||0,gross:pr.budgetUsd||0},...pts]:[],startUsd:pr.budgetUsd||0,netUsd:net,feesUsd:fees,grossUsd:gross,closes:pts.length},'PRACTICE (REALIZED, LAST '+pts.length+' CLOSES)','rhPrEquity');
 return `<fieldset class="mpo-fieldset" id="rhPractice" style="border-color:#00c8ff"><legend>Practice sandbox · isolated paper ledger</legend>
 <p><span class="mpo-badge">LOOP ${polyEscape(t.loopStatus||'--')}</span> <span class="mpo-badge">${s.autopilot?'PRACTICE AUTOPILOT ON':'PRACTICE AUTOPILOT OFF'}</span> <span class="mpo-badge">NEVER COUNTS TOWARD QUALIFICATION, PROMOTION OR REAL AUTHORITY</span> <small>${polyEscape(s.mode||'--')} · ${polyEscape(s.strategyMode||'--')} · fee ${fmt((s.feeBps||0)/100,2)}%/side + ${polyEscape(String(s.slippageBps??'--'))} bps slippage · source ${polyEscape(t.lastSource||'--')} · hash ${polyEscape(pr.settingsHash||'--')}</small></p>
 ${pr.recoveryRequired?`<div class="mpo-error">PRACTICE RECOVERY REQUIRED: ${polyEscape(pr.recoveryReason||'reset after review')}</div>`:''}${pr.lastError?`<div class="mpo-error">${polyEscape(pr.lastError)}</div>`:''}
 <div class="metric-grid">${metric('Practice equity',rhMoney(pr.equityUsd))}${metric('Budget',rhMoney(pr.budgetUsd))}${metric('Cash',rhMoney(pr.cashUsd))}${metric('Realized',rhMoney(pr.realizedPnlUsd),(pr.realizedPnlUsd||0)>=0?'green':'red')}${metric('Unrealized',rhMoney(pr.unrealizedPnlUsd),(pr.unrealizedPnlUsd||0)>=0?'green':'red')}${metric('Fills / fees',polyEscape(String(t.fills||0))+' / '+rhMoney(t.feesUsd))}</div>
 <p id="rhPrDecision"><b>Last decision:</b> ${polyEscape([ld.action,ld.symbol,ld.reason].filter(Boolean).join(' · ')||'--')}${ld.at?' · '+rhAge(Date.now()-ld.at)+' ago':''} · <b>blocking:</b> ${polyEscape(t.blockingReason||'nothing')}${Object.keys(t.rejectionReasons||{}).length?' · skipped: '+polyEscape(Object.entries(t.rejectionReasons).map(([k,n])=>k+' '+n).join(', ')):''}</p>
 <div class="mpo-split"><div>
 ${curve}
 <table class="mpo-table" id="rhPrPositions"><thead><tr><th>Open</th><th>Qty</th><th>Cost</th><th>Open P/L</th><th>Age</th><th></th></tr></thead><tbody>${pos.length?pos.map(x=>`<tr><td>${polyEscape(x.symbol)}</td><td>${fmt(x.qty,6)}</td><td>${rhMoney(x.costUsd)}</td><td class="${(x.unrealizedPnlUsd||0)>=0?'green':'red'}">${rhMoney(x.unrealizedPnlUsd)}</td><td>${rhHold(x.ageMs)}</td><td><button data-rh-pr-close="${polyEscape(x.id)}" ${dis}>Close</button></td></tr>`).join(''):'<tr><td colspan="6">No open practice positions.</td></tr>'}</tbody></table>
 <small>Recent: ${hist.length?hist.slice(0,6).map(x=>polyEscape(x.symbol+' '+(x.exit?.reason||'')+' ')+rhMoney(x.pnlUsd)).join(' · '):'no practice closes yet'}</small>
 </div><div>
 <label>Mode <select id="rhPrMode">${opt(['PRACTICE','BUY_AND_HOLD','OBSERVE_ONLY'],rhVal('rhPrMode',s.mode))}</select></label>
 <label>Strategy <select id="rhPrStrategy">${opt(['MOMENTUM','MEAN_REVERSION','BUY_AND_HOLD'],rhVal('rhPrStrategy',s.strategyMode))}</select></label>
 <label>Pairs <input id="rhPrSymbols" value="${polyEscape(rhVal('rhPrSymbols',(s.symbols||[]).join(',')))}" size="22"></label>
 <label>USD/order <input id="rhPrOrderUsd" type="number" min="1" value="${polyEscape(rhVal('rhPrOrderUsd',s.orderUsd))}" style="width:70px"></label>
 <label>Max open <input id="rhPrMaxOpen" type="number" min="1" max="100" value="${polyEscape(rhVal('rhPrMaxOpen',s.maxOpenPositions))}" style="width:55px"></label>
 <label>Daily loss cap <input id="rhPrLossCap" type="number" min="0" value="${polyEscape(rhVal('rhPrLossCap',s.dailyLossCapUsd))}" style="width:70px"></label>
 <div><button id="rhPrSave" ${dis}>Save practice settings</button><button id="rhPrAuto" ${dis}>${s.autopilot?'Stop practice autopilot':'Start practice autopilot'}</button><button id="rhPrRun" ${dis}>Run one cycle</button></div>
 <div><label>Pair <input id="rhPrSymbol" value="${polyEscape(rhVal('rhPrSymbol',(s.symbols||['BTC-USD'])[0]))}" maxlength="14" size="10"></label><button id="rhPrBuy" ${dis}>Practice buy ${rhMoney(s.orderUsd)}</button></div>
 <div><label>Reset budget USD <input id="rhPrBudget" type="number" min="50" value="${polyEscape(rhVal('rhPrBudget',pr.budgetUsd||500))}" style="width:80px"></label><button id="rhPrReset" ${dis}>Reset practice…</button></div>
 <small>Public quotes only, no signed Robinhood calls. Fills use the observed ask/bid plus modeled slippage and fee. This sandbox exists to exercise the controls; it is not evidence and cannot promote anything.</small>
 </div></div></fieldset>`;
}
let rhChart={symbol:null,range:'6h',data:null,at:0,busy:false,error:null};
{const c=rhPref('mpo-rh-chart',{});if(c&&typeof c==='object'){if(['1h','6h','24h'].includes(c.range))rhChart.range=c.range;if(typeof c.symbol==='string'&&c.symbol)rhChart.symbol=c.symbol}}
const rhSaveChart=()=>rhSave('mpo-rh-chart',{range:rhChart.range,symbol:rhChart.symbol});
const RH_FOCUS_IDS=['rhSymbol','rhUsd','rhSymbols','rhOrderUsd','rhMaxOpen','rhBank','rhParams','rhResetConfirm','rhRealSymbol','rhRealUsd','rhRealType','rhApOrderUsd','rhApMaxOpen','rhApLossCap','rhApSymbols','rhApType','rhPrMode','rhPrStrategy','rhPrSymbols','rhPrOrderUsd','rhPrMaxOpen','rhPrLossCap','rhPrSymbol','rhPrBudget'];
const RH_SECRET_IDS=['rhApiKey','rhSecret','rhConfirm','rhAutoConfirm'];
const RH_PHRASES={place:'PLACE REAL CRYPTO ORDER',cancel:'CANCEL REAL CRYPTO ORDER',cancelAll:'CANCEL REAL CRYPTO ORDERS',autopilot:'ENABLE REAL CRYPTO AUTOPILOT',forget:'FORGET'};
const rhMoney=n=>typeof n==='number'&&Number.isFinite(n)?money(n):'--';
const rhPct=n=>typeof n==='number'&&Number.isFinite(n)?fmt(n*100,2)+'%':'--';
const rhVal=(id,fallback)=>rhDraft[id]===undefined?fallback:rhDraft[id];
const rhAge=ms=>typeof ms==='number'&&Number.isFinite(ms)?(ms<90000?Math.round(ms/1000)+'s':Math.round(ms/60000)+'m'):'--';
function rhCapture(){for(const id of RH_FOCUS_IDS){const el=document.getElementById(id);if(el)rhDraft[id]=el.value}}
function rhTyping(){const ae=document.activeElement;if(ae&&(RH_FOCUS_IDS.includes(ae.id)||RH_SECRET_IDS.includes(ae.id)))return true;return RH_SECRET_IDS.some(id=>{const el=document.getElementById(id);return el&&el.value})}
async function refreshRobinhood(){
 if(rhRefreshBusy)return;rhRefreshBusy=true;
 try{const r=await fetch('/api/robinhood');if(!r.ok)throw Error('Robinhood status request failed');rhState=await r.json();trackRobinhoodProfitBurst(rhState);rhLoadEquities();if(windowVisible('robinhood')){renderRobinhood();rhLoadChart()}}
 catch(e){rhMessage=e.message;if(windowVisible('robinhood'))renderRobinhood()}finally{rhRefreshBusy=false}
}
async function rhAction(action,body,label){
 if(rhSubmitting)return;rhCapture();rhSubmitting=true;rhMessage='Working...';renderRobinhood(true);
 try{const r=await post('/api/robinhood/'+action,body);if(!r.ok)throw Error((r.code?'['+r.code+'] ':'')+(r.error||'Action failed'));rhMessage=label||(r.result&&r.result.reason?'Result: '+r.result.reason:'Done.');return r.result}
 catch(e){rhMessage=e.message}finally{rhSubmitting=false;await refreshRobinhood();renderRobinhood(true)}
}
function rhPrompt(phrase,text){const v=window.prompt((text||'')+'\nType '+phrase+' to confirm.');return v===null?null:v}
// §23 "why not trading" gauge: one row per symbol and book. Bars are plain inline elements, no chart library.
function rhBar(frac,color,marker){const w=Math.max(0,Math.min(1,Number(frac)||0))*100,m=marker==null?'':`<i style="position:absolute;left:${Math.max(0,Math.min(100,marker*100))}%;top:-2px;bottom:-2px;width:2px;background:#fff"></i>`;return `<span class="rh-bar" style="position:relative;display:inline-block;width:90px;height:8px;background:#26313a;border-radius:2px;vertical-align:middle"><i style="display:block;height:100%;width:${w}%;background:${color};border-radius:2px"></i>${m}</span>`}
function rhGaugeRows(book,label,gs){return Object.entries(gs||{}).map(([s,g])=>{
 const mv=g.move||{},sp=g.spread||{},bo=g.breakout||{},wu=g.warmup||{};
 const moveFrac=mv.expectedPct!=null&&mv.requiredPct>0?mv.expectedPct/(Math.max(mv.expectedPct,mv.requiredPct)*1.25):0,moveMark=mv.expectedPct!=null&&mv.requiredPct>0?mv.requiredPct/(Math.max(mv.expectedPct,mv.requiredPct)*1.25):null;
 return `<tr data-rh-gauge="${polyEscape(book+':'+s)}"><td>${polyEscape(s)}</td><td>${label}</td>
 <td>${rhBar(wu.pct,wu.pct>=1?'#39ff68':'#ffb000')} <small>${polyEscape(String(wu.n??0))}/${polyEscape(String(wu.need??0))}</small></td>
 <td class="${sp.ok===false?'red':''}">${sp.bps==null?'--':fmt(sp.bps,1)} / ${polyEscape(String(sp.capBps??'--'))} bps</td>
 <td title="bar = expected move, white tick = required move">${rhBar(moveFrac,mv.ok?'#39ff68':'#ff5b70',moveMark)} <small>${rhPct(mv.expectedPct)} vs ${rhPct(mv.requiredPct)}</small></td>
 <td class="${bo.ok?'green':''}">${bo.distancePct==null?'--':(bo.distancePct>=0?'+':'')+fmt(bo.distancePct*100,2)+'%'}</td>
 <td class="${g.trend?.ok?'green':'red'}">${g.trend?.ok==null?'--':g.trend.ok?'OK':'not up'}</td>
 <td><b class="${g.ready?'green':'amber'}">${polyEscape(g.blockingText||'--')}</b></td></tr>`}).join('')}
function rhGaugeSection(st){
 const g=st.gauges||{};
 return `<fieldset class="mpo-fieldset" id="rhGauges"><legend>Why not trading (per symbol, both books)</legend><div class="mpo-table-wrap"><table class="mpo-table"><thead><tr><th>Pair</th><th>Book</th><th>Warm-up</th><th>Spread / cap</th><th>Expected vs required move</th><th>Breakout distance</th><th>Trend</th><th>Blocking</th></tr></thead><tbody>
 ${rhGaugeRows('strict','STRICT',g.strict)}${rhGaugeRows('explore','EXPLORE',g.explore)||''}</tbody></table></div>
 <small>Breakout distance is mid vs the Donchian high plus buffer; positive means above. ${st.loop?.alwaysOn?'Quotes are collected on every tick while the app runs.':'Quotes are collected only while a book needs them.'}${st.loop?.warmStart?.ran?' Warm start: '+Object.entries(st.loop.warmStart.bySymbol||{}).map(([s,w])=>polyEscape(s)+' '+w.disk+' tape + '+w.candles+' candle rows').join(' · '):''}</small></fieldset>`;
}
function rhExploreSection(st){
 const e=st.explore;if(!e)return '';const s=e.stats||{},pos=e.positions||[],hist=e.history||[];
 const pf=s.profitFactor==='infinity'?'inf':typeof s.profitFactor==='number'?fmt(s.profitFactor,2):'--';
 return `<fieldset class="mpo-fieldset" id="rhExplore" style="border-color:#ffb000"><legend><b class="amber">${polyEscape(e.label)}</b></legend>
 <p><span class="mpo-badge">${e.enabled?'RUNNING':'OFF'}</span> <span class="mpo-badge">NEVER COUNTS TOWARD QUALIFICATION OR PROMOTION</span> <small>own $${fmt(e.startUsd,0)} bank · costMultiple ${polyEscape(String(e.overrides?.costMultiple))} · lookback ${polyEscape(String(e.overrides?.lookbackSamples))} · max hold ${polyEscape(String(e.overrides?.maxHoldMin))} min · same fees, spread and fill model · hash ${polyEscape(e.paramsHash||'--')}</small></p>
 <div class="metric-grid"><div class="mpo-metric"><label>Equity</label><strong>${rhMoney(e.equityUsd)}</strong></div><div class="mpo-metric"><label>Net P/L after fees</label><strong class="${(s.pnlUsd||0)>=0?'green':'red'}">${rhMoney(s.pnlUsd)}</strong></div><div class="mpo-metric"><label>Fees paid</label><strong>${rhMoney(s.feesUsd)}</strong></div><div class="mpo-metric"><label>Closes</label><strong>${s.closes||0}</strong></div><div class="mpo-metric"><label>Hit rate</label><strong>${rhPct(s.hitRate)}</strong></div><div class="mpo-metric"><label>Profit factor</label><strong>${pf}</strong></div></div>
 <table class="mpo-table"><thead><tr><th>Open</th><th>Qty</th><th>Cost</th><th>Open P/L</th><th>Stop / take</th></tr></thead><tbody>${pos.length?pos.map(x=>`<tr><td>${polyEscape(x.symbol)}</td><td>${fmt(x.qty,8)}</td><td>${rhMoney(x.costUsd)}</td><td>${rhMoney(x.unrealizedUsd)}</td><td>${rhPct(x.stopPct)} / ${rhPct(x.takePct)}</td></tr>`).join(''):'<tr><td colspan="5">No open exploration positions.</td></tr>'}</tbody></table>
 <small>Recent: ${hist.length?hist.map(x=>polyEscape(x.symbol+' '+(x.exit?.reason||'')+' ')+rhMoney(x.pnlUsd)).join(' · '):'no exploration closes yet'}. This book exists to generate data; it is not a strategy.</small></fieldset>`;
}
// §24 charts: inline SVG fed by the read-only GET /api/robinhood/chart (at most 800 points per series).
async function rhLoadChart(force=false){
 if(rhChart.busy||(!force&&Date.now()-rhChart.at<15000))return;
 const sym=rhChart.symbol||Object.keys(rhState?.tape||{})[0]||'BTC-USD',range=rhChart.range;rhChart.busy=true;
 const current=()=>sym===(rhChart.symbol||Object.keys(rhState?.tape||{})[0]||'BTC-USD')&&range===rhChart.range;
 try{const r=await fetch('/api/robinhood/chart?symbol='+encodeURIComponent(sym)+'&range='+encodeURIComponent(range));const d=await r.json();if(!r.ok||d.ok===false)throw Error(d.error||'chart request failed');if(current())rhChart={...rhChart,symbol:sym,data:d,at:Date.now(),error:null}}
 catch(e){if(current()&&e.name!=='AbortError')rhChart={...rhChart,at:0,error:e.message}}
 finally{rhChart.busy=false;if(windowVisible('robinhood')){if(!current())rhLoadChart(true);else renderRobinhood()}}
}
const RH_C={band:'rgba(0,200,255,.16)',mid:'#e6f3ff',don:'#ffb000',ef:'#39ff68',es:'#ff5bd0',entry:'#39ff68',exit:'#ff5b70',explore:'#ffb000',stop:'#ff5b70',take:'#39ff68',trail:'#ffffff',grid:'#2b3640',text:'#b8c7d3'};
function rhChartDims(h){h=Math.round(h*0.8);const narrow=typeof window!=='undefined'&&window.innerWidth<600;return {W:narrow?420:800,H:narrow?Math.round(h*0.9):h,pl:6,pr:narrow?58:72,pt:12,pb:20}}
function rhTimeLabel(t,range){const d=new Date(t);return range==='24h'?d.toLocaleTimeString([],{hour:'numeric'}):d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}
function rhPath(pts,x,y,key){let s='',pen=false;for(const p of pts){const v=p[key];if(v==null||!Number.isFinite(v)){pen=false;continue}s+=(pen?'L':'M')+x(p.t).toFixed(1)+' '+y(v).toFixed(1);pen=true}return s}
function rhMarker(m,x,y){const cx=x(m.t),cy=y(m.price),c=m.book==='explore'?RH_C.explore:(m.kind==='entry'?RH_C.entry:RH_C.exit),tip=`<title>${polyEscape(m.book+' '+m.kind+(m.reason?' '+m.reason:'')+' @ '+fmt(m.price,2))}</title>`;
 if(m.book==='explore')return m.kind==='entry'?`<circle class="rh-mk rh-mk-explore-entry" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="none" stroke="${c}" stroke-width="2">${tip}</circle>`:`<rect class="rh-mk rh-mk-explore-exit" x="${(cx-4.5).toFixed(1)}" y="${(cy-4.5).toFixed(1)}" width="9" height="9" fill="none" stroke="${c}" stroke-width="2">${tip}</rect>`;
 return m.kind==='entry'?`<path class="rh-mk rh-mk-strict-entry" d="M${cx.toFixed(1)} ${(cy-7).toFixed(1)}L${(cx+6).toFixed(1)} ${(cy+4).toFixed(1)}L${(cx-6).toFixed(1)} ${(cy+4).toFixed(1)}Z" fill="${c}">${tip}</path>`:`<path class="rh-mk rh-mk-strict-exit" d="M${cx.toFixed(1)} ${(cy+7).toFixed(1)}L${(cx+6).toFixed(1)} ${(cy-4).toFixed(1)}L${(cx-6).toFixed(1)} ${(cy-4).toFixed(1)}Z" fill="${c}">${tip}</path>`;
}
function rhPriceSvg(d){
 const pts=d?.points||[];if(!pts.length)return `<div class="mpo-empty" id="rhPriceChart">No tape for ${polyEscape(d?.symbol||'--')} in the last ${polyEscape(d?.range||'--')} yet.</div>`;
 const {W,H,pl,pr,pt,pb}=rhChartDims(280),from=d.from,to=d.to,lines=d.lines||[],marks=d.markers||[];
 const vals=[];for(const p of pts){vals.push(p.bid,p.ask);if(p.dh!=null)vals.push(p.dh);if(p.dl!=null)vals.push(p.dl)}for(const m of marks)vals.push(m.price);for(const l of lines)for(const k of ['stop','take','trail'])if(l[k]!=null)vals.push(l[k]);
 let lo=Math.min(...vals),hi=Math.max(...vals);const pad=(hi-lo||hi*0.001)*0.06;lo-=pad;hi+=pad;
 const x=t=>pl+(t-from)/Math.max(1,to-from)*(W-pl-pr),y=v=>pt+(hi-v)/(hi-lo)*(H-pt-pb);
 const band='M'+pts.map(p=>x(p.t).toFixed(1)+' '+y(p.ask).toFixed(1)).join('L')+'L'+pts.slice().reverse().map(p=>x(p.t).toFixed(1)+' '+y(p.bid).toFixed(1)).join('L')+'Z';
 const grid=[0,0.5,1].map(f=>{const v=lo+(hi-lo)*(1-f),yy=y(v);return `<line x1="${pl}" x2="${W-pr}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="${RH_C.grid}"/><text x="${W-pr+4}" y="${(yy+4).toFixed(1)}" fill="${RH_C.text}" font-size="11">${fmt(v,2)}</text>`}).join('');
 const times=[from,(from+to)/2,to].map((tt,i)=>`<text x="${x(tt).toFixed(1)}" y="${H-5}" fill="${RH_C.text}" font-size="11" text-anchor="${['start','middle','end'][i]}">${polyEscape(rhTimeLabel(tt,d.range))}</text>`).join('');
 const hline=(v,c,dash,label,cls)=>v==null?'':`<g class="${cls}"><line x1="${pl}" x2="${W-pr}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${c}" stroke-width="1.2" stroke-dasharray="${dash}"/><text x="${W-pr+4}" y="${(y(v)-3).toFixed(1)}" fill="${c}" font-size="10">${label}</text></g>`;
 const posLines=lines.map(l=>{const b=l.book==='explore'?'X':'S';return hline(l.stop,RH_C.stop,'6 4','STOP '+b,'rh-line-stop')+hline(l.take,RH_C.take,'6 4','TAKE '+b,'rh-line-take')+hline(l.trail,RH_C.trail,'2 3','TRAIL '+b,'rh-line-trail')}).join('');
 return `<svg id="rhPriceChart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${polyEscape(d.symbol)} price, last ${polyEscape(d.range)}" style="display:block;background:#0d1419;border:1px solid ${RH_C.grid}">${grid}
 <path class="rh-band" d="${band}" fill="${RH_C.band}" stroke="none"/>
 <path class="rh-don-high" d="${rhPath(pts,x,y,'dh')}" fill="none" stroke="${RH_C.don}" stroke-width="1" stroke-dasharray="4 3"/><path class="rh-don-low" d="${rhPath(pts,x,y,'dl')}" fill="none" stroke="${RH_C.don}" stroke-width="1" stroke-dasharray="4 3"/>
 <path class="rh-ema-fast" d="${rhPath(pts,x,y,'ef')}" fill="none" stroke="${RH_C.ef}" stroke-width="1.2"/><path class="rh-ema-slow" d="${rhPath(pts,x,y,'es')}" fill="none" stroke="${RH_C.es}" stroke-width="1.2"/>
 <path class="rh-mid" d="${rhPath(pts,x,y,'mid')}" fill="none" stroke="${RH_C.mid}" stroke-width="1.6"/>
 ${posLines}${marks.map(m=>rhMarker(m,x,y)).join('')}${times}</svg>`;
}
function rhEquitySvg(e,label,id){
 const pts=e?.points||[];const head=`<div style="font-size:12px;margin:6px 0 2px"><b class="${id==='rhEquityExplore'?'amber':''}">${polyEscape(label)}</b> net ${rhMoney(e?.netUsd)} · fees ${rhMoney(e?.feesUsd)} · gross ${rhMoney(e?.grossUsd)} · ${e?.closes||0} closes</div>`;
 if(pts.length<2)return head+`<div class="mpo-empty" id="${id}">No closes yet.</div>`;
 const {W,H,pl,pr,pt,pb}=rhChartDims(130),from=pts[0].t,to=pts[pts.length-1].t,vals=pts.flatMap(p=>[p.net,p.gross]).concat(e.startUsd);
 let lo=Math.min(...vals),hi=Math.max(...vals);const pad=Math.max(0.5,(hi-lo)*0.1);lo-=pad;hi+=pad;
 const x=t=>pl+(t-from)/Math.max(1,to-from)*(W-pl-pr),y=v=>pt+(hi-v)/(hi-lo)*(H-pt-pb);
 const verts=key=>pts.flatMap((p,i)=>i?[[x(p.t),y(pts[i-1][key])],[x(p.t),y(p[key])]]:[[x(p.t),y(p[key])]]),line=v=>v.map((q,i)=>(i?'L':'M')+q[0].toFixed(1)+' '+q[1].toFixed(1)).join(''),step=key=>line(verts(key));
 const drag=line([...verts('gross'),...verts('net').reverse()])+'Z';
 return head+`<svg id="${id}" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${polyEscape(label)} equity" style="display:block;background:#0d1419;border:1px solid ${RH_C.grid}">
 <line x1="${pl}" x2="${W-pr}" y1="${y(e.startUsd).toFixed(1)}" y2="${y(e.startUsd).toFixed(1)}" stroke="${RH_C.grid}" stroke-dasharray="3 3"/><text x="${W-pr+4}" y="${(y(e.startUsd)+4).toFixed(1)}" fill="${RH_C.text}" font-size="11">${rhMoney(e.startUsd)}</text>
 <path class="rh-fee-drag" d="${drag}" fill="rgba(255,91,112,.28)" stroke="none"><title>fee drag</title></path>
 <path class="rh-eq-gross" d="${step('gross')}" fill="none" stroke="${RH_C.text}" stroke-width="1" stroke-dasharray="4 3"/>
 <path class="rh-eq-net" d="${step('net')}" fill="none" stroke="${id==='rhEquityExplore'?RH_C.explore:RH_C.ef}" stroke-width="1.8"/>
 <text x="${W-pr+4}" y="${(y(pts[pts.length-1].net)+4).toFixed(1)}" fill="${RH_C.text}" font-size="11">${rhMoney(pts[pts.length-1].net)}</text></svg>`;
}
function rhHold(ms){return typeof ms==='number'&&Number.isFinite(ms)?(ms<3600e3?Math.round(ms/60000)+'m':(ms/3600e3).toFixed(1)+'h'):'--'}
function rhTradeTable(rows){
 const list=(rows||[]).slice(0,30);
 return `<div class="mpo-table-wrap" style="max-height:260px;overflow:auto"><table class="mpo-table" id="rhTradeTable"><thead><tr><th>Book</th><th>Pair</th><th>Entry</th><th>Exit</th><th>Reason</th><th>Hold</th><th>Gross</th><th>Fees</th><th>Net</th></tr></thead><tbody>
 ${list.length?list.map(r=>`<tr><td class="${r.book==='explore'?'amber':''}">${r.book==='explore'?'EXPLORE':'STRICT'}</td><td>${polyEscape(r.symbol)}</td><td>${rhMoney(r.entry)}</td><td>${rhMoney(r.exit)}</td><td>${polyEscape(r.reason||'--')}</td><td>${rhHold(r.holdMs)}</td><td>${rhMoney(r.grossUsd)}</td><td>${rhMoney(r.feesUsd)}</td><td class="${(r.netUsd||0)>=0?'green':'red'}">${rhMoney(r.netUsd)}</td></tr>`).join(''):'<tr><td colspan="9">No closed paper trades yet.</td></tr>'}</tbody></table></div>`;
}
// Live strip: sampling heartbeat, quote ticker and per-pair edge meter (expected move vs the required move).
function rhLiveViz(st){
 if(!window.MPOViz)return '';
 const tape=st.tape||{},quotes=Object.fromEntries((st.quotes||[]).map(q=>[q.symbol,q]));
 const rows=Object.entries(tape).map(([sym,t])=>({label:sym.replace('-USD',''),primary:!!t.primary,spark:t.spark||[],move:t.expectedMovePct,required:t.requiredMovePct??(Number(t.costPct)*1.5)}));
 MPOViz.set('rh-edge','edge',{rows});
 const sigCol={BUY:'#39ff68',ENTER:'#39ff68',WAIT:'#ffb000',EXIT:'#ff5b70',SELL:'#ff5b70'};
 MPOViz.set('rh-ticker','ticker',{speed:38,items:Object.entries(tape).flatMap(([sym,t])=>{const q=quotes[sym]||{},sp=(t.spark||[]).map(Number),ch=sp.length>1?(sp.at(-1)/sp[0]-1)*100:null;return [{text:`${sym} ${q.bid!=null?'$'+Number(q.bid).toLocaleString(undefined,{maximumFractionDigits:2}):'—'}${ch==null?'':(ch>=0?' ▲':' ▼')+Math.abs(ch).toFixed(2)+'%'}`,color:ch==null?'#9fbfa8':ch>=0?'#39ff68':'#ff5b70'},{text:`${t.signal||'—'} · ${t.n} samples`,color:sigCol[String(t.signal||'').toUpperCase()]||'#9fbfa8'}]})});
 const loop=st.loop||{};
 MPOViz.set('rh-pulse','pulse',{beats:MPOViz.beat('rh-loop',loop.lastTickAt),label:`sampling every ${Math.round(Number(loop.tickMs||0)/1000)}s`,extra:loop.running?'loop running':'loop stopped',color:loop.running?'#39ff68':'#ff5b70'});
 return `${MPOViz.canvas('rh-ticker',22)}<div class="mpo-viz-grid">${MPOViz.canvas('rh-pulse',30)}</div>${MPOViz.canvas('rh-edge',Math.max(60,rows.length*30),'edge meter · expected move vs required (red line = 1.5× round-trip cost)')}`;
}
function rhChartSection(st){
 const d=rhChart.data,syms=Object.keys(st.tape||{}),cur=rhChart.symbol||syms[0]||'BTC-USD',src=d?.sources?Object.entries(d.sources).map(([k,n])=>polyEscape(k)+' '+n).join(' · '):'';
 return `<fieldset class="mpo-fieldset" id="rhCharts"><legend>Charts</legend>
 <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px">${syms.map(s=>`<button class="btn ${s===cur?'on':''}" data-rh-chart-symbol="${polyEscape(s)}">${polyEscape(s)}</button>`).join('')}<span style="flex:1"></span>${['1h','6h','24h'].map(r=>`<button class="btn ${r===rhChart.range?'on':''}" data-rh-chart-range="${r}">${r}</button>`).join('')}</div>
 ${rhChart.error?`<div class="mpo-error">${polyEscape(rhChart.error)}</div>`:''}
 ${d?rhPriceSvg(d):'<div class="mpo-empty" id="rhPriceChart">Loading chart...</div>'}
 <div style="font-size:11px;margin:4px 0 8px;color:${RH_C.text}"><span style="color:${RH_C.mid}">— mid</span> · <span style="color:#00c8ff">▮ bid/ask band</span> · <span style="color:${RH_C.don}">- - Donchian ${polyEscape(String(d?.indicators?.lookbackSamples??''))}</span> · <span style="color:${RH_C.ef}">— EMA ${polyEscape(String(d?.indicators?.emaFast??''))}</span> · <span style="color:${RH_C.es}">— EMA ${polyEscape(String(d?.indicators?.emaSlow??''))}</span> · <span style="color:${RH_C.entry}">▲</span>/<span style="color:${RH_C.exit}">▼</span> strict entry/exit · <span style="color:${RH_C.explore}">○/□</span> exploration entry/exit · stop/take lines for open positions (S strict, X exploration)${d?` · ${d.points.length} of ${d.rawCount} samples${src?' ('+src+')':''}`:''}</div>
 ${d?rhEquitySvg(d.equity?.strict,'STRICT BOOK','rhEquityStrict')+rhEquitySvg(d.equity?.explore,'EXPLORATION (NOT A STRATEGY)','rhEquityExplore'):''}
 <div style="font-size:11px;margin:4px 0;color:${RH_C.text}">Solid: realized equity after fees. Dashed: before fees. Red shading: fee drag.</div>
 ${d?rhTradeTable(d.trades):''}</fieldset>`;
}
function renderRobinhood(force=false){
 const root=document.getElementById('body-robinhood');if(!root)return;
 if(!force&&rhTyping())return;rhCapture();
 if(!rhState){setBody('robinhood',`<div class="mpo-surface-dark"><h2>ROBINHOOD</h2><p>${polyEscape(rhMessage||'Loading...')}</p></div>`);return}
 const r=rhState.readiness||{},p=rhState.paper||{},a=p.autopilot||{},q=p.qualification||{},j=rhState.journal||{},ap=j.autopilot||{},lim=rhState.limits||{},prim=(rhState.strategy||{}).primary||{},paperLocked=r.paperOnlyBuild===true,disabled=rhSubmitting?'disabled':'',liveDisabled=(rhSubmitting||paperLocked)?'disabled':'';
 const positions=p.positions||[],history=p.history||[],quoteMap=Object.fromEntries((rhState.quotes||[]).map(q=>[q.symbol,q]));
 const symbol=rhVal('rhSymbol','BTC-USD'),usd=rhVal('rhUsd',10),maxOpen=rhVal('rhMaxOpen',a.maxOpen||3),orderUsd=rhVal('rhOrderUsd',a.orderUsd||25),watch=rhVal('rhSymbols',(a.symbols||['BTC-USD','ETH-USD']).join(','));
 const realSymbol=rhVal('rhRealSymbol',prim.symbol||'BTC-USD'),realUsd=rhVal('rhRealUsd',10),realType=rhVal('rhRealType','market');
 const apOrderUsd=rhVal('rhApOrderUsd',ap.orderUsd||10),apMaxOpen=rhVal('rhApMaxOpen',ap.maxOpen||2),apLossCap=rhVal('rhApLossCap',ap.dailyLossCapUsd||25),apSymbols=rhVal('rhApSymbols',(ap.symbols||[]).join(',')),apType=rhVal('rhApType',ap.orderType||'market');
 const metric=(label,value)=>`<div class="mpo-metric"><label>${label}</label><strong>${value}</strong></div>`;
 const check=(ok,label)=>`<span class="mpo-badge">${ok?'OK':'--'} ${label}</span>`;
 const previewFresh=rhPreview&&rhPreview.expiresAt>Date.now()&&rhPreview.symbol===String(realSymbol).toUpperCase();
 const gateRows=previewFresh?Object.entries(rhPreview.gates).map(([g,ok])=>`<tr><td>${polyEscape(g)}</td><td>${ok?'PASS':'FAIL'}</td></tr>`).join(''):'';
 const openReal=j.open||[],realHist=j.history||[];
 const ev=rhState.evolve||{},evLab=ev.source==='evolution-lab',evReady=!evLab||ev.paperPromotionAllowed===true,evNum=(v,d)=>typeof v==='number'&&Number.isFinite(v)?fmt(v,d):v==='infinity'?'inf':'--';
 const evRow=(label,c)=>{const m=(c&&c.metrics)||{};return `<tr><td>${label}</td><td>${polyEscape(c?c.paramsHash:'--')}</td><td>${evNum(c?c.score:null,3)}</td><td>${polyEscape(String(m.closes??'--'))}</td><td>${rhPct(m.hitRate)}</td><td>${evNum(m.profitFactor,2)}</td><td>${rhMoney(m.pnlUsd)}</td><td>${rhMoney(m.maxDrawdownUsd)}</td><td>${evNum(m.tradesPerDay,2)}</td></tr>`};
 setBody('robinhood',`<div class="mpo-surface-dark rh-v-${rhView}" style="padding:10px">
<div data-rh-part="head"> <h2>ROBINHOOD <small> / ${RH_VIEW_SUB[rhView]||'CRYPTO · BITCOIN PRIMARY'}</small> <button id="rhRefresh" ${disabled}>Refresh</button></h2>
 <small id="rhReadiness">${polyEscape(rhReadinessText(rhState))}</small>
 <div data-rh-part="cryptohead"><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"><span class="mpo-badge">${r.credentialsReady?'RH KEYS PRESENT':'RH KEYS OPTIONAL FOR PAPER'}</span><span class="mpo-badge">${paperLocked?'PAPER ONLY · LIVE LOCKED':(r.realEnabled?'REAL ENABLED':'REAL DISABLED')}</span><span class="mpo-badge">PAPER FEED · ${polyEscape(r.paperQuoteSource||'CONNECTING')}</span><span class="mpo-badge">${a.enabled?'PAPER AUTOPILOT ON':'PAPER AUTOPILOT OFF'}</span>${r.recoveryRequired?'<span class="mpo-badge">RECOVERY</span>':''}</div>
 <div class="metric-grid">${metric('Buying power',rhMoney(rhState.account?.buyingPowerUsd))}${metric('Fee tier',rhPct(rhState.account?.feeRatio))}${metric('Paper equity',rhMoney(p.equityUsd))}${metric('Paper P/L',rhMoney(p.stats?.pnlUsd))}${metric('Real open / unverified',(openReal.length)+' / '+(j.stats?.unverified||0))}${metric('Realized today / cap',rhMoney(j.realizedTodayUsd)+' / '+rhMoney(lim.dailyLossCapUsd))}</div>
 ${p.recoveryRequired?`<div class="mpo-error">PAPER RECOVERY REQUIRED: ${polyEscape(p.recoveryError||'Review the book before resetting.')}</div>`:''}
 ${j.recoveryRequired?`<div class="mpo-error">REAL JOURNAL RECOVERY REQUIRED: ${polyEscape(j.recoveryError||'Review data/robinhood-auto-trader.json before any real action.')}</div>`:''}
 ${rhState.lastError?`<div class="mpo-error">${polyEscape(rhState.lastError.stage+': '+rhState.lastError.message)}</div>`:''}
 ${r.paperFallbackReason?`<div class="mpo-empty">Robinhood authenticated quotes unavailable (${polyEscape(r.paperFallbackReason.code||'unknown')}); simulation is using public Coinbase market data until Robinhood credentials work.</div>`:''}</div>
 <p role="status" id="rhMessage">${polyEscape(rhMessage)}</p>${rhViewTabs()}</div>
<div data-rh-part="live">${rhLiveViz(rhState)}</div>
<div data-rh-part="connection"> <details><summary>Connection and safety</summary><p>Paper mode can use a public read-only market feed when Robinhood authentication is unavailable. For Robinhood-authenticated quotes later, generate a key pair locally with <code>node -e "import('./src/robinhoodSigner.js').then(m=>console.log(JSON.stringify(m.generateRobinhoodKeyPair(),null,2)))"</code>, paste the public key into the Robinhood portal, then connect the API key and matching private seed below.</p><p>Account: ${polyEscape(rhState.account?.accountNumber||'not authenticated')} | Robinhood API: ${polyEscape(r.authCode||'not checked')} | Paper quote source: ${polyEscape(r.paperQuoteSource||'connecting')} | Public key: ${polyEscape(r.publicKey||'--')}</p><p>Stocks and ETFs run only as a paper lane on Alpaca public end-of-day bars (Stocks &amp; ETFs tab). Real stock, ETF or option orders would go only through Robinhood's official Agentic Trading MCP, which is NOT wired in this app, and this app never uses mobile-app impersonation.</p></details></div>
<div data-rh-part="order"> <fieldset class="mpo-fieldset"><legend>Paper order</legend>
 <label>Pair <input id="rhSymbol" value="${polyEscape(symbol)}" maxlength="14"></label>
 <label>USD <input id="rhUsd" type="number" min="1" max="${lim.maxOrderUsd}" step="1" value="${polyEscape(usd)}"></label>
 <button id="rhBuy" ${disabled}>Buy in paper book</button>
 <p>Simulated fills include observed spread, modeled slippage and conservative estimated fees. Feed: ${polyEscape(r.paperQuoteSource||'connecting')}. They are not actual Robinhood executions.</p></fieldset></div>
<div data-rh-part="autopilot"> <fieldset class="mpo-fieldset"><legend>Paper autopilot</legend>
 <label>Pairs <input id="rhSymbols" value="${polyEscape(watch)}" size="26"></label>
 <label>USD/order <input id="rhOrderUsd" type="number" min="1" max="${lim.maxOrderUsd}" value="${polyEscape(orderUsd)}" style="width:70px"></label>
 <label>Max positions <input id="rhMaxOpen" type="number" min="1" max="${lim.maxOpen}" value="${polyEscape(maxOpen)}" style="width:55px"></label>
 <button id="rhSave" ${disabled}>Save settings</button><button id="rhToggle" ${disabled}>${a.enabled?'Stop paper':'Start paper'}</button><button id="rhTick" ${disabled}>Sample / check exits</button>
 <details><summary>Strategy parameters</summary><textarea id="rhParams" rows="5" style="width:100%">${polyEscape(rhVal('rhParams',JSON.stringify(p.params,null,2)))}</textarea><p>Changing parameters invalidates qualification for the old strategy. Sampling interval follows the actual loop.</p></details>
 <p>Sampling every ${fmt(rhState.loop.tickMs/1000,0)} seconds. Warm-up requires ${Math.max(p.params?.warmupSamples||120,p.params?.minSamples||120)} observations. ${a.lastAction?polyEscape('Last action: '+a.lastAction.action+' '+a.lastAction.symbol):'No strategy action yet.'}</p>
 </fieldset></div>
<div data-rh-part="signals"> <fieldset class="mpo-fieldset"><legend>Signals and costs</legend><table class="mpo-table"><thead><tr><th>Pair</th><th>Bid / ask</th><th>Quote source / age</th><th>Samples</th><th>Move estimate</th><th>Round-trip cost</th><th>Signal</th><th>Why</th></tr></thead><tbody>
 ${Object.entries(rhState.tape||{}).map(([s,t])=>`<tr><td>${polyEscape(s)}${t.primary?' <span class="mpo-badge">PRIMARY x'+polyEscape(String(prim.weight||1))+'</span>':''}</td><td>${rhMoney(quoteMap[s]?.bid)} / ${rhMoney(quoteMap[s]?.ask)}</td><td>${polyEscape(t.quoteSource||'unknown')} / ${t.quoteAgeMs==null?'--':fmt(t.quoteAgeMs/1000,1)+'s'}</td><td>${t.n}</td><td>${rhPct(t.expectedMovePct)}</td><td>${rhPct(t.costPct)}</td><td><span class="mpo-badge">${polyEscape(t.signal||'--')}</span></td><td>${polyEscape(t.reason||'--')}</td></tr>`).join('')}
 </tbody></table><p>The move estimate measures volatility, not predicted profit. Fees and fill costs are modeled, not verified.</p></fieldset></div>
<div data-rh-part="charts"> ${rhChartSection(rhState)}</div>
<div data-rh-part="gauges"> ${rhGaugeSection(rhState)}</div>
<div data-rh-part="explore"> ${rhExploreSection(rhState)}</div>
<div data-rh-part="daily" style="grid-column:1/-1"> ${rhView==='daily'?rhDailySection(rhState.daily,ev.daily):''}</div>
<div data-rh-part="stocks" style="grid-column:1/-1"> ${rhView==='stocks'?rhStocksSection(rhEq):''}</div>
<div data-rh-part="practice" style="grid-column:1/-1"> ${rhView==='practice'?rhPracticeSection(rhState.practice):''}</div>
<div data-rh-part="qual"> <fieldset class="mpo-fieldset"><legend>Paper research qualification</legend>
 <b>${q.qualified?'QUALIFIED under params '+polyEscape(p.paramsHash||'--'):'NOT QUALIFIED'}</b><p>${q.closes||0} eligible strategy closes / ${rhState.qualificationThresholds.minCloses} required | Hit rate ${rhPct(q.hitRate)} vs required ${rhPct(q.requiredHitRate)} | PF ${polyEscape(String(q.profitFactor??'--'))} | Net sample P/L ${rhMoney(q.pnlUsd)} | Max drawdown ${rhMoney(q.maxDrawdownUsd)}</p>
 <p>${polyEscape((q.reasons||[]).join('; ')||'Paper evidence only. This does not establish future profitability; live trading remains locked in this build.')}</p>
 <small>Manual entries and manual exits never count. Only the current strategy hash ${polyEscape(p.paramsHash||'--')} and the configured rolling window are evaluated.</small></fieldset></div>
<div data-rh-part="positions"> <fieldset class="mpo-fieldset"><legend>Open paper positions</legend><table class="mpo-table"><thead><tr><th>Pair</th><th>Quantity</th><th>Entry cost</th><th>Open P/L</th><th>Source</th><th>Action</th></tr></thead><tbody>
 ${positions.length?positions.map(x=>`<tr><td>${polyEscape(x.symbol)}</td><td>${fmt(x.qty,8)}</td><td>${rhMoney(x.costUsd)}</td><td>${rhMoney(x.unrealizedUsd)}</td><td>${polyEscape(x.placedBy)}</td><td><button data-rh-close="${polyEscape(x.id)}" ${disabled}>Close paper</button></td></tr>`).join(''):'<tr><td colspan="6">No open simulated positions.</td></tr>'}</tbody></table></fieldset></div>
<div data-rh-part="closes"> <fieldset class="mpo-fieldset"><legend>Recent paper closes</legend><table class="mpo-table"><thead><tr><th>Pair</th><th>Net P/L</th><th>Reason</th><th>Closed by</th></tr></thead><tbody>
 ${history.length?history.map(x=>`<tr><td>${polyEscape(x.symbol)}</td><td>${rhMoney(x.pnlUsd)}</td><td>${polyEscape(x.exit?.reason||'--')}</td><td>${polyEscape(x.closedBy||'--')}</td></tr>`).join(''):'<tr><td colspan="4">No paper closes yet.</td></tr>'}</tbody></table><small>Recent performance statistics use up to 500 retained closes; this table shows the latest eight.</small></fieldset></div>
<div data-rh-part="evolution"><details class="rh-more evolution-lab-panel"><summary>Evolution Lab (paper-only research)</summary> <fieldset class="mpo-fieldset"><legend>Evolution Lab · Robinhood research lane</legend>
 <p><span class="mpo-badge">GEN ${polyEscape(String(ev.generation||0))}</span> <span class="mpo-badge">${evLab?'EVOLUTION LAB':(ev.enabled?'LOCAL FALLBACK':'DISABLED')}</span> <span class="mpo-badge">${polyEscape(String(ev.phase||'RESEARCH'))}</span> ${ev.running?'<span class="mpo-badge">RUNNING</span>':''} ${evLab?`<span class="mpo-badge">${evReady?'PAPER REVIEW READY':'RESEARCH ONLY'}</span>`:''} <small>${evLab?'parallel Lab worker':`every ${polyEscape(String(ev.intervalMin||'--'))} min`} · last run ${ev.lastRunAt?rhAge(Date.now()-ev.lastRunAt)+' ago':'never'}</small></p>
 <p>Tape coverage: ${Object.entries(ev.tapeDays||{}).map(([s,d])=>polyEscape(s)+' '+polyEscape(String(d))+'d').join(' · ')||'--'} (needs ${polyEscape(String(ev.minTapeDays||3))}d on the primary pair)${(()=>{const src=Object.values(ev.tapeSources||{}).reduce((a,x)=>{for(const [k,n] of Object.entries(x||{}))a[k]=(a[k]||0)+n;return a},{});const keys=Object.keys(src);return keys.length?' · quotes: '+keys.map(k=>polyEscape(k)+' '+polyEscape(String(src[k]))).join(' · '):''})()}${ev.lastError?' | <span class="mpo-error">'+polyEscape(ev.lastError.stage+': '+ev.lastError.message)+'</span>':''}</p>
 ${rhDailyVerdictLine(ev.daily)}
 <table class="mpo-table"><thead><tr><th>Split test</th><th>Hash</th><th>Score</th><th>Closes</th><th>Hit</th><th>PF</th><th>Net P/L</th><th>Drawdown</th><th>Trades/day</th></tr></thead><tbody>
 ${evRow('Incumbent',ev.incumbent)}${evRow(ev.proposed?'Champion (proposed)':'Champion',ev.champion)}</tbody></table>
 <button id="rhEvolveRun" ${evLab?'disabled':(disabled||(ev.running?'disabled':''))}>${evLab?'Lab runs automatically':'Run local fallback'}</button><button id="rhEvolveApply" ${disabled||(!ev.proposed||!evReady?'disabled':'')}>Apply Lab candidate to paper</button>
 <small>${evLab?'Evolution Lab owns the search on the research machine and runs this lane in parallel with Pump.fun and Polymarket US.':'Local evolution is only a fallback when no Lab publication is available.'} Applying a candidate changes only the paper strategy hash and resets qualification. Live Robinhood execution stays locked; the Lab cannot activate it.</small>
 ${ev.note?`<p class="muted">${polyEscape(ev.note)}</p>`:''}${ev.proposed?`<details><summary>${evReady?'Paper-review candidate':'Best research candidate'} ${polyEscape(ev.proposed.paramsHash)}</summary><pre>${polyEscape(JSON.stringify(ev.proposed.params,null,1))}</pre></details>`:''}
 </fieldset></details></div>
<div data-rh-part="real"><details class="rh-more"><summary>Robinhood connection and locked real-money controls</summary> <fieldset class="mpo-danger-fieldset"><legend>ROBINHOOD CONNECTION · PAPER-ONLY LOCK</legend>
 <div class="mpo-error">PAPER-ONLY BUILD: real orders, cancellations, reconciliation and real autopilot are hard-disabled in the backend.</div>
 <p>${check(r.hasApiKey&&r.hasPrivateKey,'keys present')} ${check(r.keyValid,'key valid')} ${check(r.realEnabled,'real enabled')} ${check(r.sessionArmed,'armed')} ${check(r.qualified,'qualified')} <span class="mpo-badge">PRIMARY ${polyEscape(prim.symbol||'BTC-USD')}</span> <small>limits: ${rhMoney(lim.maxOrderUsd)}/order · ${polyEscape(String(lim.maxOpen))} open · ${rhMoney(lim.dailyLossCapUsd)}/day</small></p>
 <details ${r.credentialsReady?'':'open'}><summary>Configure credentials</summary>
 <label>API key <input id="rhApiKey" autocomplete="off" placeholder="rh-api-..." size="40"></label>
 <label>Private key seed <input id="rhSecret" type="password" autocomplete="new-password" placeholder="base64 32-byte seed" size="40"></label>
 <label><input id="rhRealEnable" type="checkbox" disabled> real trading locked for this build</label>
 <button id="rhConfigure" ${disabled}>Save paper-feed credentials</button><p>These credentials are used for authenticated Robinhood market data. The app always writes ROBINHOOD_REAL_ENABLED=false in this build; the seed is never shown again.</p></details>
 ${paperLocked?'<p class="mpo-empty">Live Robinhood execution is intentionally unavailable in this build.</p>':(r.realEnabled?`<button id="rhArm" ${disabled||(!r.credentialsReady||r.recoveryRequired?'disabled':'')}>${r.sessionArmed?'DISARM':'ARM this session'}</button>`:'<p class="mpo-empty">Real trading is disabled.</p>')}
 <div><label>Pair <input id="rhRealSymbol" value="${polyEscape(realSymbol)}" maxlength="14"></label>
 <label>USD <input id="rhRealUsd" type="number" min="1" max="${lim.maxOrderUsd}" step="1" value="${polyEscape(realUsd)}"></label>
 <label>Type <select id="rhRealType"><option value="market" ${realType==='market'?'selected':''}>market</option><option value="limit" ${realType==='limit'?'selected':''}>limit</option></select></label>
 <button id="rhPreviewBtn" ${liveDisabled||(!r.credentialsReady?'disabled':'')}>Preview future live order</button></div>
 <div id="rhPreviewOut">${previewFresh?`<p>qty ${polyEscape(rhPreview.qtyStr)} · est cost ${rhMoney(rhPreview.estTotalUsd)} · fee ${rhMoney(rhPreview.estFeeUsd)} · ref ask ${rhMoney(rhPreview.refAsk)}${rhPreview.limitPrice?' · limit '+polyEscape(rhPreview.limitPrice):''} · round trip ${rhPct(rhPreview.costPct)} · expires in ${Math.max(0,Math.round((rhPreview.expiresAt-Date.now())/1000))}s · <b>${rhPreview.wouldPass?'WOULD PASS':'WOULD FAIL'}</b></p><table class="mpo-table"><tbody>${gateRows}</tbody></table>${(rhPreview.warnings||[]).length?'<p>'+polyEscape(rhPreview.warnings.join(' | '))+'</p>':''}`:'<p>No fresh preview.</p>'}</div>
 <label>Confirm <input id="rhConfirm" autocomplete="off" placeholder="Type PLACE REAL CRYPTO ORDER" size="34"></label>
 <button id="rhPlace" disabled>Place real order</button>
 <table class="mpo-table"><thead><tr><th>Pair</th><th>Status</th><th>By</th><th>Qty</th><th>Avg</th><th>Mark</th><th>Unrealized</th><th>Age</th><th>Actions</th></tr></thead><tbody>
 ${openReal.length?openReal.map(e=>`<tr><td>${polyEscape(e.symbol)}</td><td>${polyEscape(e.status)}${e.lastNote?' <small>'+polyEscape(e.lastNote)+'</small>':''}</td><td>${polyEscape(e.placedBy||'')}</td><td>${fmt(e.filledQty||e.requestedQty,8)}</td><td>${rhMoney(e.avgPrice)}</td><td>${rhMoney(e.markBid)}</td><td>${rhMoney(e.unrealizedUsd)}</td><td>${rhAge(e.ageMs)}</td><td>${e.status==='OPEN'&&e.fillVerified?`<button data-rh-sell="${polyEscape(e.id)}" ${liveDisabled}>Sell…</button>`:''}<button data-rh-cancel="${polyEscape(e.id)}" ${liveDisabled}>Cancel…</button><button data-rh-forget="${polyEscape(e.id)}" ${disabled}>Forget…</button></td></tr>`).join(''):'<tr><td colspan="9">No open real entries.</td></tr>'}</tbody></table>
 <button id="rhCancelAll" ${liveDisabled||(!r.credentialsReady?'disabled':'')}>Cancel all…</button><button id="rhReconcile" ${liveDisabled||(!r.credentialsReady?'disabled':'')}>Reconcile now</button>
 <details><summary>Real history (last ${realHist.length})</summary><table class="mpo-table"><tbody>${realHist.map(e=>`<tr><td>${polyEscape(e.symbol)}</td><td>${polyEscape(e.status)}</td><td>${polyEscape(e.exitReason||'')}</td><td>${rhMoney(e.pnlUsd)}</td></tr>`).join('')}</tbody></table></details>
 <div class="mpo-module"><b>REAL AUTOPILOT</b> ${ap.enabled?'<span class="mpo-badge">ON</span>':'<span class="mpo-badge">OFF</span>'}
 <label>USD/order <input id="rhApOrderUsd" type="number" min="1" max="${lim.maxOrderUsd}" value="${polyEscape(apOrderUsd)}" style="width:70px"></label>
 <label>Max open <input id="rhApMaxOpen" type="number" min="1" max="${lim.maxOpen}" value="${polyEscape(apMaxOpen)}" style="width:55px"></label>
 <label>Daily loss cap <input id="rhApLossCap" type="number" min="1" max="${lim.dailyLossCapUsd}" value="${polyEscape(apLossCap)}" style="width:70px"></label>
 <label>Pairs <input id="rhApSymbols" value="${polyEscape(apSymbols)}" size="26"></label>
 <label>Type <select id="rhApType"><option value="market" ${apType==='market'?'selected':''}>market</option><option value="limit" ${apType==='limit'?'selected':''}>limit</option></select></label>
 <button id="rhApSave" ${liveDisabled}>Save settings</button>
 <label>Confirm <input id="rhAutoConfirm" autocomplete="off" placeholder="Type ENABLE REAL CRYPTO AUTOPILOT" size="36"></label>
 <button id="rhApEnable" ${liveDisabled||(!r.sessionArmed||!r.qualified||ap.enabled?'disabled':'')}>Enable real autopilot</button><button id="rhApDisable" ${liveDisabled||(!ap.enabled?'disabled':'')}>Disable</button><button id="rhApRun" ${liveDisabled||(!ap.enabled?'disabled':'')}>Run once</button>
 <p>Last action: ${ap.lastAction?polyEscape(ap.lastAction.action+' '+(ap.lastAction.ids||[ap.lastAction.symbol||'']).join(',')):'--'} | skipped: ${polyEscape((ap.skipped||[]).map(s=>s.symbol+':'+s.reason).join(', ')||'--')}</p>
 ${ap.disabledReason?`<div class="mpo-error">Autopilot disabled: ${polyEscape(ap.disabledReason)}</div>`:''}
 <small>Future live controls are retained for testing but are unreachable while the paper-only build lock is active. The active Robinhood strategy is the simulated paper engine above.</small></div>
 </fieldset></details></div>
<div data-rh-part="reset"><details class="rh-more"><summary>Reset simulated book</summary> <fieldset class="mpo-fieldset"><legend>Reset simulated book</legend><label>Starting USD <input id="rhBank" type="number" min="50" max="100000" value="${polyEscape(rhVal('rhBank',p.startUsd||1000))}"></label><label>Type RESET PAPER <input id="rhResetConfirm" value="${polyEscape(rhVal('rhResetConfirm',''))}" autocomplete="off"></label><button id="rhReset" ${disabled}>Reset paper only</button><p>Clears simulated positions, history and qualification; stops paper autopilot. Real balances and the real journal are untouched.</p></fieldset></details></div>
 </div>`);
 const keep=RH_VIEWS[rhView]||RH_VIEWS.paper;root.querySelectorAll('[data-rh-part]').forEach(n=>{if(!keep.includes(n.dataset.rhPart))n.remove()});
 root.querySelectorAll('[data-rh-view]').forEach(b=>b.onclick=()=>{rhView=b.dataset.rhView;rhSave('mpo-rh-view',rhView);renderRobinhood(true);if(rhView==='charts')rhLoadChart(true);if(rhView==='stocks')rhLoadEquities(true)});
 const el=id=>root.querySelector('#'+id)||{};
 el('rhRefresh').onclick=()=>{refreshRobinhood();rhLoadEquities(true)};
 // Practice sandbox: POST /api/robinhood/practice/{config,run,order,close,reset}; all isolated from the strict book.
 const prPatch=()=>({mode:el('rhPrMode').value,strategyMode:el('rhPrStrategy').value,symbols:el('rhPrSymbols').value,orderUsd:Number(el('rhPrOrderUsd').value),maxOpenPositions:Number(el('rhPrMaxOpen').value),dailyLossCapUsd:Number(el('rhPrLossCap').value)});
 el('rhPrSave').onclick=()=>rhAction('practice/config',prPatch(),'Practice settings saved.');
 el('rhPrAuto').onclick=()=>{const on=!rhState.practice?.settings?.autopilot;rhAction('practice/config',{...prPatch(),autopilot:on},on?'Practice autopilot on (sandbox only).':'Practice autopilot off.')};
 el('rhPrRun').onclick=()=>rhAction('practice/run',{},'Practice cycle ran.');
 el('rhPrBuy').onclick=()=>rhAction('practice/order',{symbol:el('rhPrSymbol').value},'Practice buy filled in the sandbox.');
 root.querySelectorAll('[data-rh-pr-close]').forEach(b=>b.onclick=()=>rhAction('practice/close',{id:b.dataset.rhPrClose},'Practice position closed.'));
 el('rhPrReset').onclick=()=>{const confirmation=rhPrompt('RESET PRACTICE','Reset the practice sandbox? Its positions and history are cleared and its autopilot stops. The strict book is untouched.');if(confirmation===null)return;if(confirmation==='RESET PRACTICE')rhAction('practice/reset',{budgetUsd:Number(el('rhPrBudget').value)},'Practice sandbox reset.');else{rhMessage='Type RESET PRACTICE to confirm.';renderRobinhood(true)}};
 // Daily-bar book: run one pass (still one decision per closed bar) or reset with a typed phrase. Paper only.
 el('rhDailyRun').onclick=()=>rhAction('daily/run',{},'Daily pass ran.');
 el('rhDailyReset').onclick=()=>{const confirmation=rhPrompt('RESET DAILY','Reset the daily-bar paper book? Its sleeves, trades and curve are cleared. Other books are untouched.');if(confirmation===null)return;if(confirmation==='RESET DAILY')rhAction('daily/reset',{confirmation},'Daily book reset.');else{rhMessage='Type RESET DAILY to confirm.';renderRobinhood(true)}};
 root.querySelectorAll('[data-rh-chart-symbol]').forEach(b=>b.onclick=()=>{rhChart.symbol=b.dataset.rhChartSymbol;rhChart.data=null;rhSaveChart();rhLoadChart(true);renderRobinhood(true)});
 root.querySelectorAll('[data-rh-chart-range]').forEach(b=>b.onclick=()=>{rhChart.range=b.dataset.rhChartRange;rhSaveChart();rhLoadChart(true);renderRobinhood(true)});
 el('rhBuy').onclick=()=>rhAction('paper-order',{symbol:el('rhSymbol').value,usd:Number(el('rhUsd').value)});
 el('rhTick').onclick=()=>rhAction('paper-autopilot/run',{});
 el('rhToggle').onclick=()=>rhAction('paper-autopilot',{enabled:!a.enabled});
 el('rhSave').onclick=()=>{try{const params=JSON.parse(el('rhParams').value);rhAction('paper-autopilot',{symbols:el('rhSymbols').value,orderUsd:Number(el('rhOrderUsd').value),maxOpen:Number(el('rhMaxOpen').value),params})}catch{rhMessage='Strategy parameters must be valid JSON.';renderRobinhood(true)}};
 el('rhReset').onclick=()=>{const amountUsd=Number(el('rhBank').value),confirmation=el('rhResetConfirm').value;if(confirmation==='RESET PAPER')rhAction('paper-reset',{amountUsd,confirmation});else{rhMessage='Type RESET PAPER to confirm.';renderRobinhood(true)}};
 root.querySelectorAll('[data-rh-close]').forEach(button=>button.onclick=()=>rhAction('paper-close',{id:button.dataset.rhClose}));
 el('rhConfigure').onclick=()=>{const apiKey=el('rhApiKey').value,privateKey=el('rhSecret').value;el('rhSecret').value='';rhAction('config',{apiKey,privateKey,realEnabled:false},'Paper-feed credentials saved; live trading remains locked.')};
 if(el('rhArm'))el('rhArm').onclick=()=>rhAction('arm',{armed:!r.sessionArmed},r.sessionArmed?'Disarmed.':'Armed for this session only.');
 el('rhPreviewBtn').onclick=async()=>{const result=await rhAction('preview',{symbol:el('rhRealSymbol').value,usd:Number(el('rhRealUsd').value),orderType:el('rhRealType').value},'Preview ready.');if(result){rhPreview=result;renderRobinhood(true)}};
 const place=el('rhPlace'),confirm=el('rhConfirm');
 const gate=()=>{place.disabled=rhSubmitting||!(r.sessionArmed&&previewFresh&&rhPreview.wouldPass&&confirm.value===RH_PHRASES.place)};
 confirm.oninput=gate;gate();
 place.onclick=()=>{const confirmation=confirm.value;confirm.value='';rhPreview=null;rhAction('order',{symbol:el('rhRealSymbol').value,usd:Number(el('rhRealUsd').value),orderType:el('rhRealType').value,confirmation},'Real order submitted; reconcile verifies the fill.')};
 root.querySelectorAll('[data-rh-sell]').forEach(b=>b.onclick=()=>{const confirmation=rhPrompt(RH_PHRASES.place,'Sell this real position at market?');if(confirmation!==null)rhAction('order',{entryId:b.dataset.rhSell,side:'sell',confirmation})});
 root.querySelectorAll('[data-rh-cancel]').forEach(b=>b.onclick=()=>{const confirmation=rhPrompt(RH_PHRASES.cancel,'Cancel the resting order for this entry?');if(confirmation!==null)rhAction('cancel',{entryId:b.dataset.rhCancel,confirmation})});
 root.querySelectorAll('[data-rh-forget]').forEach(b=>b.onclick=()=>{const confirmation=rhPrompt(RH_PHRASES.forget,'Forget drops this entry from the local journal only. It does NOT cancel anything on Robinhood; the coin stays in your account.');if(confirmation!==null)rhAction('forget',{entryId:b.dataset.rhForget,confirmation,acknowledgeHolding:true})});
 el('rhCancelAll').onclick=()=>{const confirmation=rhPrompt(RH_PHRASES.cancelAll,'Cancel every resting real order?');if(confirmation!==null)rhAction('cancel-all',{confirmation})};
 el('rhReconcile').onclick=()=>rhAction('reconcile',{},'Reconciled.');
 el('rhEvolveRun').onclick=()=>rhAction('evolve/run',{},'Evolution generation finished.');
 el('rhEvolveApply').onclick=()=>{if(ev.proposed)rhAction('evolve/apply',{paramsHash:ev.proposed.paramsHash},'Champion applied to the paper autopilot; qualification reset.')};
 const apBody=()=>({orderUsd:Number(el('rhApOrderUsd').value),maxOpen:Number(el('rhApMaxOpen').value),dailyLossCapUsd:Number(el('rhApLossCap').value),symbols:el('rhApSymbols').value,orderType:el('rhApType').value});
 el('rhApSave').onclick=()=>rhAction('autopilot',apBody(),'Real autopilot settings saved.');
 el('rhApEnable').onclick=()=>{const confirmation=el('rhAutoConfirm').value;el('rhAutoConfirm').value='';rhAction('autopilot',{...apBody(),enabled:true,confirmation},'Real autopilot enabled for this armed session.')};
 el('rhApDisable').onclick=()=>rhAction('autopilot',{enabled:false},'Real autopilot disabled.');
 el('rhApRun').onclick=()=>rhAction('autopilot/run',{});
}
