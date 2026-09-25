// Robinhood paper dashboard. Browser controls never submit real orders.
let rhState=null,rhSubmitting=false,rhRefreshBusy=false,rhMessage='',rhDraft={};
const RH_FOCUS_IDS=['rhSymbol','rhUsd','rhSymbols','rhOrderUsd','rhMaxOpen','rhBank','rhParams','rhResetConfirm'];
const rhMoney=n=>typeof n==='number'&&Number.isFinite(n)?money(n):'--';
const rhPct=n=>typeof n==='number'&&Number.isFinite(n)?fmt(n*100,2)+'%':'--';
const rhVal=(id,fallback)=>rhDraft[id]===undefined?fallback:rhDraft[id];
function rhCapture(){for(const id of RH_FOCUS_IDS){const el=document.getElementById(id);if(el)rhDraft[id]=el.value}}
async function refreshRobinhood(){
 if(rhRefreshBusy)return;rhRefreshBusy=true;
 try{const r=await fetch('/api/robinhood');if(!r.ok)throw Error('Robinhood status request failed');rhState=await r.json();if(windowVisible('robinhood'))renderRobinhood()}
 catch(e){rhMessage=e.message;if(windowVisible('robinhood'))renderRobinhood()}finally{rhRefreshBusy=false}
}
async function rhAction(action,body){
 if(rhSubmitting)return;rhCapture();rhSubmitting=true;rhMessage='Working...';renderRobinhood(true);
 try{const r=await post('/api/robinhood/'+action,body);if(!r.ok)throw Error(r.error||'Paper action failed');rhMessage=r.result?.reason?'Result: '+r.result.reason:'Paper action saved.';return r.result}
 catch(e){rhMessage=e.message}finally{rhSubmitting=false;await refreshRobinhood();renderRobinhood(true)}
}
function renderRobinhood(force=false){
 const root=document.getElementById('body-robinhood');if(!root)return;
 if(!force&&RH_FOCUS_IDS.includes(document.activeElement?.id))return;rhCapture();
 if(!rhState){setBody('robinhood',`<div class="mpo-surface-dark"><h2>ROBINHOOD AUTO TRADER</h2><p>${polyEscape(rhMessage||'Loading paper suite...')}</p></div>`);return}
 const r=rhState.readiness||{},p=rhState.paper||{},a=p.autopilot||{},q=p.qualification||{},j=rhState.journal||{},disabled=rhSubmitting?'disabled':'';
 const positions=p.positions||[],history=p.history||[],quoteMap=Object.fromEntries((rhState.quotes||[]).map(q=>[q.symbol,q]));
 const symbol=rhVal('rhSymbol','BTC-USD'),usd=rhVal('rhUsd',10),maxOpen=rhVal('rhMaxOpen',a.maxOpen||3),orderUsd=rhVal('rhOrderUsd',a.orderUsd||25),watch=rhVal('rhSymbols',(a.symbols||['BTC-USD','ETH-USD']).join(','));
 const metric=(label,value)=>`<div class="mpo-metric"><label>${label}</label><strong>${value}</strong></div>`;
 setBody('robinhood',`<div class="mpo-surface-dark" style="padding:14px">
 <h2>ROBINHOOD AUTO TRADER <small> / PAPER LAB</small></h2>
 <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"><span class="mpo-badge">${r.credentialsReady?'KEYS PRESENT':'READ-ONLY KEYS NEEDED'}</span><span class="mpo-badge">${a.enabled?'PAPER AUTOPILOT ON':'PAPER AUTOPILOT OFF'}</span><span class="mpo-badge">REAL EXECUTION UNAVAILABLE</span><button id="rhRefresh" ${disabled}>Refresh</button></div>
 <div class="metric-grid">${metric('Paper equity',rhMoney(p.equityUsd))}${metric('Paper cash',rhMoney(p.cashUsd))}${metric('Open P/L',rhMoney(p.unrealizedUsd))}${metric('Recent closes P/L',rhMoney(p.stats?.pnlUsd))}</div>
 <p role="status" id="rhMessage">${polyEscape(rhMessage)}</p>
 ${p.recoveryRequired?`<div class="mpo-error">PAPER RECOVERY REQUIRED: ${polyEscape(p.recoveryError||'Review the book before resetting.')}</div>`:''}
 ${rhState.lastError?`<div class="mpo-error">${polyEscape(rhState.lastError.message)}</div>`:''}
 <details><summary>Connection and safety</summary><p>Use read-only Robinhood Crypto API permissions. Configure ROBINHOOD_API_KEY and a base64 32-byte Ed25519 seed as ROBINHOOD_PRIVATE_KEY in the local .env, then restart. This build does not save credentials from the browser.</p><p>Account: ${polyEscape(rhState.account?.accountNumber||'not authenticated')} | API: ${polyEscape(r.authCode||'not checked')} | Fee estimate: ${rhPct(rhState.account?.feeRatio)}</p><p>Live order placement, cancellation, arming, and live autopilot are not installed. No environment flag can activate them in this build. Stocks/options use a separate Agentic Trading MCP integration.</p></details>
 <fieldset class="mpo-fieldset"><legend>Paper order</legend>
 <label>Pair <input id="rhSymbol" value="${polyEscape(symbol)}" maxlength="14"></label>
 <label>USD <input id="rhUsd" type="number" min="1" max="${rhState.limits.maxOrderUsd}" step="1" value="${polyEscape(usd)}"></label>
 <button id="rhBuy" ${disabled||(!r.credentialsReady?'disabled':'')}>Buy in paper book</button>
 <p>Simulated fills include spread, slippage and estimated fees. They are not actual Robinhood executions.</p></fieldset>
 <fieldset class="mpo-fieldset"><legend>Paper autopilot</legend>
 <label>Pairs <input id="rhSymbols" value="${polyEscape(watch)}" size="26"></label>
 <label>USD/order <input id="rhOrderUsd" type="number" min="1" max="${rhState.limits.maxOrderUsd}" value="${polyEscape(orderUsd)}" style="width:70px"></label>
 <label>Max positions <input id="rhMaxOpen" type="number" min="1" max="${rhState.limits.maxOpen}" value="${polyEscape(maxOpen)}" style="width:55px"></label>
 <button id="rhSave" ${disabled}>Save settings</button><button id="rhToggle" ${disabled||(!a.enabled&&!r.credentialsReady?'disabled':'')}>${a.enabled?'Stop paper':'Start paper'}</button><button id="rhTick" ${disabled}>Sample / check exits</button>
 <details><summary>Strategy parameters</summary><textarea id="rhParams" rows="5" style="width:100%">${polyEscape(rhVal('rhParams',JSON.stringify(p.params,null,2)))}</textarea><p>Changing parameters invalidates qualification for the old strategy. Sampling interval follows the actual loop.</p></details>
 <p>Sampling every ${fmt(rhState.loop.tickMs/1000,0)} seconds. Warm-up requires ${Math.max(p.params?.warmupSamples||120,p.params?.minSamples||120)} observations. ${a.lastAction?polyEscape('Last action: '+a.lastAction.action+' '+a.lastAction.symbol):'No strategy action yet.'}</p>
 </fieldset>
 <fieldset class="mpo-fieldset"><legend>Signals and costs</legend><table class="mpo-table"><thead><tr><th>Pair</th><th>Bid / ask</th><th>Samples</th><th>Move estimate</th><th>Round-trip cost</th><th>Decision</th></tr></thead><tbody>
 ${Object.entries(rhState.tape||{}).map(([s,t])=>`<tr><td>${polyEscape(s)}</td><td>${rhMoney(quoteMap[s]?.bid)} / ${rhMoney(quoteMap[s]?.ask)}</td><td>${t.n}</td><td>${rhPct(t.expectedMovePct)}</td><td>${rhPct(t.costPct)}</td><td>${polyEscape(t.reason||'--')}</td></tr>`).join('')}
 </tbody></table><p>The move estimate measures volatility, not predicted profit. Fees and fill costs are modeled, not verified.</p></fieldset>
 <fieldset class="mpo-fieldset"><legend>Paper research qualification</legend>
 <b>${q.qualified?'RESEARCH THRESHOLDS MET':'NOT QUALIFIED'}</b><p>${q.closes||0} eligible strategy closes / ${rhState.qualificationThresholds.minCloses} required | Hit rate ${rhPct(q.hitRate)} | Net sample P/L ${rhMoney(q.pnlUsd)} | Max drawdown ${rhMoney(q.maxDrawdownUsd)}</p>
 <p>${polyEscape((q.reasons||[]).join('; ')||'Paper evidence only. This does not unlock real trading or establish future profitability.')}</p>
 <small>Manual entries and manual exits never count. Only the current strategy hash ${polyEscape(p.paramsHash||'--')} and the configured rolling window are evaluated.</small></fieldset>
 <fieldset class="mpo-fieldset"><legend>Open paper positions</legend><table class="mpo-table"><thead><tr><th>Pair</th><th>Quantity</th><th>Entry cost</th><th>Open P/L</th><th>Source</th><th>Action</th></tr></thead><tbody>
 ${positions.length?positions.map(x=>`<tr><td>${polyEscape(x.symbol)}</td><td>${fmt(x.qty,8)}</td><td>${rhMoney(x.costUsd)}</td><td>${rhMoney(x.unrealizedUsd)}</td><td>${polyEscape(x.placedBy)}</td><td><button data-rh-close="${polyEscape(x.id)}" ${disabled}>Close paper</button></td></tr>`).join(''):'<tr><td colspan="6">No open simulated positions.</td></tr>'}</tbody></table></fieldset>
 <fieldset class="mpo-fieldset"><legend>Recent paper closes</legend><table class="mpo-table"><thead><tr><th>Pair</th><th>Net P/L</th><th>Reason</th><th>Closed by</th></tr></thead><tbody>
 ${history.length?history.map(x=>`<tr><td>${polyEscape(x.symbol)}</td><td>${rhMoney(x.pnlUsd)}</td><td>${polyEscape(x.exit?.reason||'--')}</td><td>${polyEscape(x.closedBy||'--')}</td></tr>`).join(''):'<tr><td colspan="4">No paper closes yet.</td></tr>'}</tbody></table><small>Recent performance statistics use up to 500 retained closes; this table shows the latest eight.</small></fieldset>
 <fieldset class="mpo-fieldset"><legend>Existing real journal - read only</legend><p>${(j.open||[]).length} existing records preserved. This build does not reconcile, change, close, or forget real exposures.</p>${j.recoveryRequired?'<p class="mpo-error">Real journal requires recovery. It has not been overwritten.</p>':''}</fieldset>
 <fieldset class="mpo-fieldset"><legend>Reset simulated book</legend><label>Starting USD <input id="rhBank" type="number" min="50" max="100000" value="${polyEscape(rhVal('rhBank',p.startUsd||1000))}"></label><label>Type RESET PAPER <input id="rhResetConfirm" value="${polyEscape(rhVal('rhResetConfirm',''))}" autocomplete="off"></label><button id="rhReset" ${disabled}>Reset paper only</button><p>Clears simulated positions, history and qualification; stops paper autopilot. Real balances and the real journal are untouched.</p></fieldset>
 </div>`);
 root.querySelector('#rhRefresh').onclick=()=>refreshRobinhood();
 root.querySelector('#rhBuy').onclick=()=>rhAction('paper-order',{symbol:root.querySelector('#rhSymbol').value,usd:Number(root.querySelector('#rhUsd').value)});
 root.querySelector('#rhTick').onclick=()=>rhAction('paper-autopilot/run',{});
 root.querySelector('#rhToggle').onclick=()=>rhAction('paper-autopilot',{enabled:!a.enabled});
 root.querySelector('#rhSave').onclick=()=>{try{const params=JSON.parse(root.querySelector('#rhParams').value);rhAction('paper-autopilot',{symbols:root.querySelector('#rhSymbols').value,orderUsd:Number(root.querySelector('#rhOrderUsd').value),maxOpen:Number(root.querySelector('#rhMaxOpen').value),params})}catch{rhMessage='Strategy parameters must be valid JSON.';renderRobinhood(true)}};
 root.querySelector('#rhReset').onclick=()=>{const amountUsd=Number(root.querySelector('#rhBank').value),confirmation=root.querySelector('#rhResetConfirm').value;if(confirmation==='RESET PAPER')rhAction('paper-reset',{amountUsd,confirmation});else{rhMessage='Type RESET PAPER to confirm.';renderRobinhood(true)}};
 root.querySelectorAll('[data-rh-close]').forEach(button=>button.onclick=()=>rhAction('paper-close',{id:button.dataset.rhClose}));
}
