// Robinhood Auto Trader panel. This release is paper-only: API credentials feed authenticated market data,
// while the backend hard-rejects Robinhood real-order, cancel, reconcile and real-autopilot mutations.
let rhState=null,rhSubmitting=false,rhRefreshBusy=false,rhMessage='',rhDraft={},rhPreview=null;
const RH_FOCUS_IDS=['rhSymbol','rhUsd','rhSymbols','rhOrderUsd','rhMaxOpen','rhBank','rhParams','rhResetConfirm','rhRealSymbol','rhRealUsd','rhRealType','rhApOrderUsd','rhApMaxOpen','rhApLossCap','rhApSymbols','rhApType'];
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
 try{const r=await fetch('/api/robinhood');if(!r.ok)throw Error('Robinhood status request failed');rhState=await r.json();if(windowVisible('robinhood'))renderRobinhood()}
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
function renderRobinhood(force=false){
 const root=document.getElementById('body-robinhood');if(!root)return;
 if(!force&&rhTyping())return;rhCapture();
 if(!rhState){setBody('robinhood',`<div class="mpo-surface-dark"><h2>ROBINHOOD AUTO TRADER</h2><p>${polyEscape(rhMessage||'Loading...')}</p></div>`);return}
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
 const ev=rhState.evolve||{},evNum=(v,d)=>typeof v==='number'&&Number.isFinite(v)?fmt(v,d):v==='infinity'?'inf':'--';
 const evRow=(label,c)=>{const m=(c&&c.metrics)||{};return `<tr><td>${label}</td><td>${polyEscape(c?c.paramsHash:'--')}</td><td>${evNum(c?c.score:null,3)}</td><td>${polyEscape(String(m.closes??'--'))}</td><td>${rhPct(m.hitRate)}</td><td>${evNum(m.profitFactor,2)}</td><td>${rhMoney(m.pnlUsd)}</td><td>${rhMoney(m.maxDrawdownUsd)}</td><td>${evNum(m.tradesPerDay,2)}</td></tr>`};
 setBody('robinhood',`<div class="mpo-surface-dark" style="padding:14px">
 <h2>ROBINHOOD AUTO TRADER <small> / CRYPTO · BITCOIN PRIMARY</small></h2>
 <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"><span class="mpo-badge">${r.credentialsReady?'RH KEYS PRESENT':'RH KEYS OPTIONAL FOR PAPER'}</span><span class="mpo-badge">${paperLocked?'PAPER ONLY · LIVE LOCKED':(r.realEnabled?'REAL ENABLED':'REAL DISABLED')}</span><span class="mpo-badge">PAPER FEED · ${polyEscape(r.paperQuoteSource||'CONNECTING')}</span><span class="mpo-badge">${a.enabled?'PAPER AUTOPILOT ON':'PAPER AUTOPILOT OFF'}</span>${r.recoveryRequired?'<span class="mpo-badge">RECOVERY</span>':''}<button id="rhRefresh" ${disabled}>Refresh</button></div>
 <div class="metric-grid">${metric('Buying power',rhMoney(rhState.account?.buyingPowerUsd))}${metric('Fee tier',rhPct(rhState.account?.feeRatio))}${metric('Paper equity',rhMoney(p.equityUsd))}${metric('Paper P/L',rhMoney(p.stats?.pnlUsd))}${metric('Real open / unverified',(openReal.length)+' / '+(j.stats?.unverified||0))}${metric('Realized today / cap',rhMoney(j.realizedTodayUsd)+' / '+rhMoney(lim.dailyLossCapUsd))}</div>
 <p role="status" id="rhMessage">${polyEscape(rhMessage)}</p>
 ${p.recoveryRequired?`<div class="mpo-error">PAPER RECOVERY REQUIRED: ${polyEscape(p.recoveryError||'Review the book before resetting.')}</div>`:''}
 ${j.recoveryRequired?`<div class="mpo-error">REAL JOURNAL RECOVERY REQUIRED: ${polyEscape(j.recoveryError||'Review data/robinhood-auto-trader.json before any real action.')}</div>`:''}
 ${rhState.lastError?`<div class="mpo-error">${polyEscape(rhState.lastError.stage+': '+rhState.lastError.message)}</div>`:''}
 ${r.paperFallbackReason?`<div class="mpo-empty">Robinhood authenticated quotes unavailable (${polyEscape(r.paperFallbackReason.code||'unknown')}); simulation is using public Coinbase market data until Robinhood credentials work.</div>`:''}
 <details><summary>Connection and safety</summary><p>Paper mode can use a public read-only market feed when Robinhood authentication is unavailable. For Robinhood-authenticated quotes later, generate a key pair locally with <code>node -e "import('./src/robinhoodSigner.js').then(m=>console.log(JSON.stringify(m.generateRobinhoodKeyPair(),null,2)))"</code>, paste the public key into the Robinhood portal, then connect the API key and matching private seed below.</p><p>Account: ${polyEscape(rhState.account?.accountNumber||'not authenticated')} | Robinhood API: ${polyEscape(r.authCode||'not checked')} | Paper quote source: ${polyEscape(r.paperQuoteSource||'connecting')} | Public key: ${polyEscape(r.publicKey||'--')}</p><p>Stocks and options are not automated here; Robinhood's Agentic Trading MCP is the only sanctioned route and this app never uses mobile-app impersonation.</p></details>
 <fieldset class="mpo-fieldset"><legend>Paper order</legend>
 <label>Pair <input id="rhSymbol" value="${polyEscape(symbol)}" maxlength="14"></label>
 <label>USD <input id="rhUsd" type="number" min="1" max="${lim.maxOrderUsd}" step="1" value="${polyEscape(usd)}"></label>
 <button id="rhBuy" ${disabled}>Buy in paper book</button>
 <p>Simulated fills include observed spread, modeled slippage and conservative estimated fees. Feed: ${polyEscape(r.paperQuoteSource||'connecting')}. They are not actual Robinhood executions.</p></fieldset>
 <fieldset class="mpo-fieldset"><legend>Paper autopilot</legend>
 <label>Pairs <input id="rhSymbols" value="${polyEscape(watch)}" size="26"></label>
 <label>USD/order <input id="rhOrderUsd" type="number" min="1" max="${lim.maxOrderUsd}" value="${polyEscape(orderUsd)}" style="width:70px"></label>
 <label>Max positions <input id="rhMaxOpen" type="number" min="1" max="${lim.maxOpen}" value="${polyEscape(maxOpen)}" style="width:55px"></label>
 <button id="rhSave" ${disabled}>Save settings</button><button id="rhToggle" ${disabled}>${a.enabled?'Stop paper':'Start paper'}</button><button id="rhTick" ${disabled}>Sample / check exits</button>
 <details><summary>Strategy parameters</summary><textarea id="rhParams" rows="5" style="width:100%">${polyEscape(rhVal('rhParams',JSON.stringify(p.params,null,2)))}</textarea><p>Changing parameters invalidates qualification for the old strategy. Sampling interval follows the actual loop.</p></details>
 <p>Sampling every ${fmt(rhState.loop.tickMs/1000,0)} seconds. Warm-up requires ${Math.max(p.params?.warmupSamples||120,p.params?.minSamples||120)} observations. ${a.lastAction?polyEscape('Last action: '+a.lastAction.action+' '+a.lastAction.symbol):'No strategy action yet.'}</p>
 </fieldset>
 <fieldset class="mpo-fieldset"><legend>Signals and costs</legend><table class="mpo-table"><thead><tr><th>Pair</th><th>Bid / ask</th><th>Samples</th><th>Move estimate</th><th>Round-trip cost</th><th>Signal</th><th>Why</th></tr></thead><tbody>
 ${Object.entries(rhState.tape||{}).map(([s,t])=>`<tr><td>${polyEscape(s)}${t.primary?' <span class="mpo-badge">PRIMARY x'+polyEscape(String(prim.weight||1))+'</span>':''}</td><td>${rhMoney(quoteMap[s]?.bid)} / ${rhMoney(quoteMap[s]?.ask)}</td><td>${t.n}</td><td>${rhPct(t.expectedMovePct)}</td><td>${rhPct(t.costPct)}</td><td><span class="mpo-badge">${polyEscape(t.signal||'--')}</span></td><td>${polyEscape(t.reason||'--')}</td></tr>`).join('')}
 </tbody></table><p>The move estimate measures volatility, not predicted profit. Fees and fill costs are modeled, not verified.</p></fieldset>
 ${rhGaugeSection(rhState)}
 ${rhExploreSection(rhState)}
 <fieldset class="mpo-fieldset"><legend>Paper research qualification</legend>
 <b>${q.qualified?'QUALIFIED under params '+polyEscape(p.paramsHash||'--'):'NOT QUALIFIED'}</b><p>${q.closes||0} eligible strategy closes / ${rhState.qualificationThresholds.minCloses} required | Hit rate ${rhPct(q.hitRate)} vs required ${rhPct(q.requiredHitRate)} | PF ${polyEscape(String(q.profitFactor??'--'))} | Net sample P/L ${rhMoney(q.pnlUsd)} | Max drawdown ${rhMoney(q.maxDrawdownUsd)}</p>
 <p>${polyEscape((q.reasons||[]).join('; ')||'Paper evidence only. This does not establish future profitability; live trading remains locked in this build.')}</p>
 <small>Manual entries and manual exits never count. Only the current strategy hash ${polyEscape(p.paramsHash||'--')} and the configured rolling window are evaluated.</small></fieldset>
 <fieldset class="mpo-fieldset"><legend>Open paper positions</legend><table class="mpo-table"><thead><tr><th>Pair</th><th>Quantity</th><th>Entry cost</th><th>Open P/L</th><th>Source</th><th>Action</th></tr></thead><tbody>
 ${positions.length?positions.map(x=>`<tr><td>${polyEscape(x.symbol)}</td><td>${fmt(x.qty,8)}</td><td>${rhMoney(x.costUsd)}</td><td>${rhMoney(x.unrealizedUsd)}</td><td>${polyEscape(x.placedBy)}</td><td><button data-rh-close="${polyEscape(x.id)}" ${disabled}>Close paper</button></td></tr>`).join(''):'<tr><td colspan="6">No open simulated positions.</td></tr>'}</tbody></table></fieldset>
 <fieldset class="mpo-fieldset"><legend>Recent paper closes</legend><table class="mpo-table"><thead><tr><th>Pair</th><th>Net P/L</th><th>Reason</th><th>Closed by</th></tr></thead><tbody>
 ${history.length?history.map(x=>`<tr><td>${polyEscape(x.symbol)}</td><td>${rhMoney(x.pnlUsd)}</td><td>${polyEscape(x.exit?.reason||'--')}</td><td>${polyEscape(x.closedBy||'--')}</td></tr>`).join(''):'<tr><td colspan="4">No paper closes yet.</td></tr>'}</tbody></table><small>Recent performance statistics use up to 500 retained closes; this table shows the latest eight.</small></fieldset>
 <fieldset class="mpo-fieldset"><legend>Evolution (paper-only self-improvement)</legend>
 <p><span class="mpo-badge">GEN ${polyEscape(String(ev.generation||0))}</span> <span class="mpo-badge">${ev.enabled?'ENABLED':'DISABLED'}</span> <span class="mpo-badge">${ev.autopromote?'AUTOPROMOTE ON':'PROPOSE ONLY'}</span> ${ev.running?'<span class="mpo-badge">RUNNING</span>':''} <small>every ${polyEscape(String(ev.intervalMin||'--'))} min · ${polyEscape(String(ev.candidates||'--'))} candidates · min gain ${polyEscape(String(ev.minGainPct||'--'))}% · last run ${ev.lastRunAt?rhAge(Date.now()-ev.lastRunAt)+' ago':'never'}</small></p>
 <p>Tape coverage: ${Object.entries(ev.tapeDays||{}).map(([s,d])=>polyEscape(s)+' '+polyEscape(String(d))+'d').join(' · ')||'--'} (needs ${polyEscape(String(ev.minTapeDays||3))}d on the primary pair)${(()=>{const src=Object.values(ev.tapeSources||{}).reduce((a,x)=>{for(const [k,n] of Object.entries(x||{}))a[k]=(a[k]||0)+n;return a},{});const keys=Object.keys(src);return keys.length?' · quotes: '+keys.map(k=>polyEscape(k)+' '+polyEscape(String(src[k]))).join(' · '):''})()}${ev.lastError?' | <span class="mpo-error">'+polyEscape(ev.lastError.stage+': '+ev.lastError.message)+'</span>':''}</p>
 <table class="mpo-table"><thead><tr><th>Split test</th><th>Hash</th><th>Score</th><th>Closes</th><th>Hit</th><th>PF</th><th>Net P/L</th><th>Drawdown</th><th>Trades/day</th></tr></thead><tbody>
 ${evRow('Incumbent',ev.incumbent)}${evRow(ev.proposed?'Champion (proposed)':'Champion',ev.champion)}</tbody></table>
 <button id="rhEvolveRun" ${disabled||(ev.running?'disabled':'')}>Run now</button><button id="rhEvolveApply" ${disabled||(!ev.proposed?'disabled':'')}>Apply to paper</button>
 <small>Candidates are bounded mutations of the current paper parameters replayed walk-forward on the recorded tape (train 70% / test 30%). Applying changes only the paper strategy hash, which resets qualification and disables real autopilot; real parameters are never touched. Autopromote needs ROBINHOOD_EVOLVE_AUTOPROMOTE=true.</small>
 ${ev.proposed?`<details><summary>Champion parameters ${polyEscape(ev.proposed.paramsHash)}</summary><pre>${polyEscape(JSON.stringify(ev.proposed.params,null,1))}</pre></details>`:''}
 </fieldset>
 <fieldset class="mpo-danger-fieldset"><legend>ROBINHOOD CONNECTION · PAPER-ONLY LOCK</legend>
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
 </fieldset>
 <fieldset class="mpo-fieldset"><legend>Reset simulated book</legend><label>Starting USD <input id="rhBank" type="number" min="50" max="100000" value="${polyEscape(rhVal('rhBank',p.startUsd||1000))}"></label><label>Type RESET PAPER <input id="rhResetConfirm" value="${polyEscape(rhVal('rhResetConfirm',''))}" autocomplete="off"></label><button id="rhReset" ${disabled}>Reset paper only</button><p>Clears simulated positions, history and qualification; stops paper autopilot. Real balances and the real journal are untouched.</p></fieldset>
 </div>`);
 const el=id=>root.querySelector('#'+id);
 el('rhRefresh').onclick=()=>refreshRobinhood();
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
