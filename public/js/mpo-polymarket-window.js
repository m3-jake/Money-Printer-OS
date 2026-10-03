// Polymarket window (sportsbook): its Advanced view, live combo builder, quotes and the combo placement flow.
// Moved out of public/dashboard.html's inline script in run D2 (2026-10-03). It is loaded by a classic <script src> at
// the exact position the code used to occupy, so it shares the page's global scope and runs in the same order.
// ---- Polymarket: one module. Live games near the end -> tick up to maxLegs -> one confirmed combo.
const POLY_MODS=['combos'];
let polyModuleSig='';
function polyShellHtml(){
 return `<div class="poly-strip" id="polyStatus"></div><section class="poly-mod" data-mod="combos"><header><span>POLYMARKET US · COMBOS · PAPER + LIVE (SEPARATED)</span></header><div class="poly-body" id="poly-combos" data-scroll="poly-combos"></div></section>`;
}
function renderSportsbook(){
 const body=$('#body-sportsbook');if(!body)return;
 if(body.dataset.shell!=='2'){const keep=captureScroll(body);body.innerHTML=polyShellHtml();body.dataset.shell='2';polyModuleSig='';restoreScroll(body,keep)}
 const ucf=(polyUSComboState||{}).feed||{};
 const strip=$('#polyStatus');
 const shadowTop=polyShadowHeadline(polyUSEvidence,(polyUSComboState||{}).settings?.window||'NEAR_END');
 if(strip)strip.innerHTML=`<div style="display:flex;justify-content:space-between;gap:8px"><div><div class="green" style="font-size:22px">POLYMARKET US</div><div class="muted">Live games about to end · tick up to ${Number((polyUSComboState||{}).settings?.maxLegs||3)} · one confirmed combo</div></div><div style="text-align:right"><b>${ucf.ok===false?'FEED DOWN':'LIVE FEED'}</b><br><span class="${ucf.ok===false?'red':'green'}">${ucf.ok===false?polyEscape(ucf.error||'offline'):`${Number(ucf.eventsLive||0)} live games · ${Number(ucf.candidates||0)} candidates`}</span></div></div>`+shadowTop;
 const box=$('#poly-combos');if(!box)return;
 // Never rebuild under the operator's cursor or mid-placement.
 const ae=document.activeElement;
 if(ae&&box.contains(ae)&&POLY_FOCUS_IDS.includes(ae.id))return;
 if(usComboSubmitting)return;
 const key=JSON.stringify([polyUSComboState,[...usComboSelected],usComboBuildState]);if(polyModuleSig===key)return;
 polyModuleSig=key;
 const keep=captureScroll(body);
 try{renderPolyCombos(box)}catch(err){box.innerHTML=`<div class="mpo-error"><b>Polymarket render error</b> — ${polyEscape(err&&err.message||String(err))}</div>`}
 restoreScroll(body,keep);
}
function renderPolyCombos(box){
 const ucs=polyUSComboState||{},rd=ucs.readiness||{},fd=ucs.feed||{},jr=ucs.journal||{},stats=jr.stats||{},beta=ucs.betaAccess||'unknown',err=ucs.error||ucs.lastError||null;
 const open=Array.isArray(jr.open)?jr.open:[],hist=Array.isArray(jr.history)?jr.history:[];
 const cands=(Array.isArray(ucs.candidates)?ucs.candidates:[]).slice().sort((a,b)=>(polyNum(a.etaMinutes)??1e9)-(polyNum(b.etaMinutes)??1e9));
 const st={priceMin:0.8,maxMinutesLeft:15,maxLegs:3,...(ucs.settings||{})},bounds=ucs.settingsBounds||{},sd={...st,...usComboSettingsDraft};
 const bound=(k,f,d)=>polyNum(bounds[k]?.[f])??d;
 const maxLegs=Number(st.maxLegs)||3;
 // A tick on a game that left the live list can no longer be priced; drop it rather than keep a stale leg.
 const boardRows=Array.isArray(ucs.board)?ucs.board:cands.map(c=>({...c,eligible:true,addable:true}));
 if(ucs.candidates){const live=new Set(boardRows.filter(c=>c.key&&(c.eligible||c.addable)).map(c=>String(c.key)));let dropped=false;for(const k of [...usComboSelected])if(!live.has(k)){usComboSelected.delete(k);dropped=true}if(dropped)scheduleUSComboBuild()}
 const chosen=[...usComboSelected];
 const acct=polyUSAccount||{},keyBad=rd.authCode==='keyNotFound'||acct.keyStatus==='REJECTED',keyOk=!keyBad&&(rd.authCode==='ok'||acct.keyStatus==='VERIFIED'),needKeys=!rd.credentialsReady||keyBad;
 // CONNECTED only after a signed call has succeeded.
 const keyText=keyBad?'KEY REJECTED':!rd.credentialsReady?'KEYS NEEDED':keyOk?'CONNECTED':'KEY NOT VERIFIED',keyCls=keyBad?'red':keyOk?'green':'amber';
 const bal=acct.balance||null,balText=bal&&bal.currentBalance!=null?'$'+Number(bal.currentBalance).toFixed(2):'—';
 const betaDenied=beta==='denied';
 const betaText=beta==='enabled'?'COMBOS ENABLED':betaDenied?'BETA PENDING':'NOT YET TESTED',betaCls=beta==='enabled'?'green':betaDenied?'amber':'muted';
 const status=`<div class="metric-grid"><div class="metric"><label>KEY</label><b class="${keyCls}">${keyText}</b><label>${keyBad?'regenerate at polymarket.us/developer':keyOk?'signed call OK':'no signed call has succeeded yet'}</label></div><div class="metric"><label>LIVE BALANCE</label><b id="usBalance">${balText}</b><label>${bal&&bal.buyingPower!=null?'buying power $'+Number(bal.buyingPower).toFixed(2):'—'}${acct.openOrders!=null?' · '+acct.openOrders+' open orders':''}</label></div><div class="metric"><label>COMBOS</label><b class="${betaCls}">${betaText}</b><label>${betaDenied?'Polymarket has not enabled combos here':'shown after the first combo call'}</label></div><div class="metric"><label>SESSION</label><b class="${rd.sessionArmed?'red':'amber'}">${rd.sessionArmed?'ARMED':'SAFE'}</b>${rd.credentialsReady&&!keyBad?`<button class="btn" id="usArm">${rd.sessionArmed?'Disarm':'Arm real money'}</button>`:'<label>connect a key to arm</label>'}</div><div class="metric"><label>FEED</label><b class="${fd.ok===false?'red':'green'}">${Number(fd.eventsLive||0)} live</b><label>age ${polyAgeS(fd.ageMs)}</label></div></div>`;
 const keyFormOpen=needKeys||!keyOk;
 const keyForm=keyFormOpen?`<details class="inset" style="padding:6px;margin:6px 0" ${needKeys?'open':''}><summary>${keyBad?'Replace your Polymarket US key':needKeys?'Connect your Polymarket US account':'Replace key (not verified yet)'}</summary><div><b>${keyBad?'Replace your Polymarket US key':'Connect your Polymarket US account'}</b><div class="formrow"><input class="field" id="usKeyId" autocomplete="off" spellcheck="false" placeholder="Key ID"><button class="btn usPaste" data-target="usKeyId">Paste</button><input class="field" id="usSecret" type="password" autocomplete="off" spellcheck="false" placeholder="Secret key (stored locally)"><button class="btn usPaste" data-target="usSecret">Paste</button><button class="btn" id="usSaveKeys">Connect</button></div><span class="muted">Generate these at polymarket.us/developer. The secret is never shown again.</span></div></details>`:'';
 const floorPct=v=>(Number(v)*100).toFixed(1);
 const settings=`<div class="toolbar" style="margin:6px 0;flex-wrap:wrap;gap:8px"><label>Win % from <input class="field" id="usSetFloor" type="number" min="${floorPct(bound('priceMin','min',.6))}" max="${floorPct(bound('priceMin','max',.985))}" step="0.5" value="${floorPct(sd.priceMin)}" style="width:70px"></label><label>Max minutes left <input class="field" id="usSetMinutes" type="number" min="${bound('maxMinutesLeft','min',1)}" max="${bound('maxMinutesLeft','max',30)}" step="1" value="${Number(sd.maxMinutesLeft)}" style="width:60px"></label><label title="${polyEscape((ucs.windowRules||{})[sd.window||'NEAR_END']||'')}">Window <select class="field" id="usSetWindow">${(ucs.windows||['NEAR_END','LATE','ANY_LIVE']).map(w=>`<option value="${w}" ${(sd.window||'NEAR_END')===w?'selected':''}>${w.replace('_',' ')}</option>`).join('')}</select></label><label>Max legs <select class="field" id="usSetLegs">${[2,3,4].map(v=>`<option value="${v}" ${Number(sd.maxLegs)===v?'selected':''}>${v}</option>`).join('')}</select></label><button class="btn" id="usSetSave" ${Object.keys(usComboSettingsDraft).length?'':'disabled'}>Save settings</button></div>`;
 const legRow=c=>{
  const k=String(c.key||''),on=usComboSelected.has(k),full=!on&&chosen.length>=maxLegs,ls=c.liveState||{};
  const eta=polyNum(c.etaMinutes)==null?'—':'~'+Math.max(1,Math.round(Number(c.etaMinutes)))+'m';
  const tag=c.eligible?'<span class="green" style="font-size:10px">eligible</span>':`<span class="${c.addable?'amber':'muted'}" style="font-size:10px">${c.addable?'outside strategy window · ':''}${polyEscape(c.reason||'rejected')}</span>`;
  const box=k&&(c.eligible||c.addable)?`<input type="checkbox" class="usComboLeg" data-key="${polyEscape(k)}" ${on?'checked':''} ${full?`disabled title="Max ${maxLegs} legs"`:''}>`:'';
  return `<tr class="${c.eligible?'':'mpo-dim'}"><td style="white-space:normal;min-width:160px"><b>${polyEscape(c.event||'—')}</b><br><span class="muted" style="font-size:10px">${polyEscape(String(c.league||'').toUpperCase())}</span></td><td style="font-size:10px;white-space:normal">${polyEscape([ls.period,ls.elapsed,ls.score].filter(Boolean).join(' · ')||'—')}</td><td style="white-space:normal">${polyEscape(c.outcome||c.side||'—')}</td><td><b>${c.price==null?'—':polyPct(c.price)}</b></td><td style="font-size:10px">${c.spread==null?'—':polyCents(c.spread)}</td><td>${eta}</td><td style="white-space:normal">${tag}</td><td>${box}</td></tr>`;
 };
 const bySport=new Map();for(const c of boardRows){const sp=String(c.sport||c.league||'other');if(!bySport.has(sp))bySport.set(sp,[]);bySport.get(sp).push(c)}
 const rows=[...bySport.entries()].sort((a,b)=>b[1].filter(x=>x.eligible).length-a[1].filter(x=>x.eligible).length||b[1].length-a[1].length).map(([sp,list])=>`<tr><th colspan=8 style="text-align:left">${polyEscape(sp.toUpperCase())} · ${list.length} live · ${list.filter(x=>x.eligible).length} eligible</th></tr>`+list.sort((a,b)=>(b.eligible-a.eligible)||(b.addable-a.addable)||(polyNum(a.etaMinutes)??1e9)-(polyNum(b.etaMinutes)??1e9)).map(legRow).join('')).join('');
 const sg=ucs.suggested,sgLine=sg&&Array.isArray(sg.legs)&&sg.legs.length>=2?`<div class="inset" style="padding:6px;margin:6px 0"><b>Suggested</b> <span class="muted" style="font-size:11px">${sg.legs.map(k=>polyEscape((boardRows.find(c=>c.key===k)||{}).outcome||k)).join(' + ')} · est. ${polyCents(sg.price)} · stake ${polyUsd(sg.stakeUsd)} · pays ${polyUsd(sg.payoutUsd)} · profit ${polyUsd(sg.profitUsd)}</span> <button class="btn" id="usUseSuggested" style="font-size:10px">Use these legs</button></div>`:'';

 const rej=Object.entries(fd.rejections||{}).sort((a,b)=>Number(b[1])-Number(a[1])).slice(0,6).map(([k,v])=>`${polyEscape(k)} ${Number(v)}`).join(' · ');
 const empty=fd.ok===false?`Feed down: ${polyEscape(fd.error||'offline')}`:`No live game in the ${String(st.window||'NEAR_END').replace('_',' ')} window with a side at ${floorPct(st.priceMin)}% or better.`;
 const bs=usComboBuildState,bErr=bs&&bs.error?bs.error:null,bOk=bs&&!bs.error&&Array.isArray(bs.legs)?bs:null;
 const buildLine=chosen.length<2?`Tick 2${maxLegs>2?' or '+maxLegs:''} games to build a combo.`:bErr?`<span class="red">${polyEscape(bErr)}</span>`:bOk?`${bOk.outsideWindow?'<span class="amber">OUTSIDE STRATEGY WINDOW · </span>':''}<b>${bOk.legs.length} legs · pays ${polyUsd(bOk.payoutUsd)}</b> <span class="muted">if every leg wins · est. ${polyCents(bOk.price)} · fees ${polyUsd(bOk.feeUsd)} · profit ${polyUsd(bOk.profitUsd)}</span>`:'Pricing…';
 const canPlace=rd.sessionArmed&&!needKeys&&!betaDenied&&chosen.length>=2&&chosen.length<=maxLegs&&!!bOk;
 const placeHint=needKeys?(keyBad?'Key rejected: replace it above.':'Connect your key first.'):!rd.sessionArmed?'Arm the session to place.':betaDenied?'Combos beta pending: Polymarket has not enabled combos for this account yet.':'Place gets a live quote first; nothing is sent until you type the phrase.';
 const entryRow=(e,isOpen)=>{
  const legs=Array.isArray(e.legs)?e.legs:[],names=legs.map(l=>polyEscape((l&&l.outcome)||(l&&l.event)||(l&&l.symbol)||'leg')).join(' + ')||'—';
  const pnl=polyNum(e.pnlUsd),status=String(e.status||'—'),cls=status==='WON'?'green':status==='LOST'?'red':status==='CANCELLED'||status==='FORGOTTEN'?'muted':'amber';
  const flags=[e.acceptUncertain?'accept unconfirmed':'',e.confirmError?'confirm failed':''].filter(Boolean).join(' · ');
  return `<tr><td style="white-space:normal;min-width:150px">${names}</td><td>${polyNum(e.fillPrice??e.estPrice)==null?'—':polyCents(e.fillPrice??e.estPrice)} × ${fmt(e.quantity,2)}</td><td>${polyUsd(e.stakeUsd)}</td><td><b class="${cls}">${polyEscape(status)}</b><br><span class="${e.fillVerified?'green':'amber'}" style="font-size:10px">${e.fillVerified?'fill verified':'fill unverified'}</span>${flags?`<br><span class="amber" style="font-size:10px">${polyEscape(flags)}</span>`:''}</td><td class="${pnl==null?'':pnl>=0?'green':'red'}">${pnl==null?'—':(pnl>=0?'+':'')+'$'+fmt(pnl,2)}</td>${isOpen?`<td><button class="btn usComboForget" data-id="${polyEscape(String(e.id||''))}" style="font-size:10px">Forget…</button></td>`:''}</tr>`;
 };
 const openRows=open.map(e=>entryRow(e,true)).join('')||'<tr><td colspan=6>No open combos.</td></tr>';
 const histRows=hist.slice(0,8).map(e=>entryRow(e,false)).join('')||'<tr><td colspan=5>No settled combos yet.</td></tr>';
 const paperBox=usPaperHtml(ucs.paper,chosen,bOk);
 box.innerHTML=`<div class="dark terminal" style="padding:8px">${paperBox}<fieldset class="mpo-danger-fieldset" style="margin-top:6px"><legend>LIVE COMBOS · POLYMARKET US · REAL</legend>
  ${status}<div class="mpo-split"><div class="poly-left">${usBoardViz(ucs,boardRows,st,chosen)}${keyForm}${(()=>{const bw=stats.byWindow||{},ks=Object.keys(bw);return `<div class="muted" style="font-size:10px;margin:3px 0">Window rule: ${polyEscape((ucs.windowRules||{})[st.window||'NEAR_END']||'—')}${ks.length?' · Record by window: '+ks.map(k=>{const r=bw[k];return `${polyEscape(k)} ${Number(r.won)}W-${Number(r.lost)}L${r.open?' ('+Number(r.open)+' open)':''}${r.roi==null?'':' ROI '+(Number(r.roi)*100).toFixed(0)+'%'}`}).join(' · '):''}</div>`})()}${err?`<div class="mpo-error"><b>Polymarket US</b> — ${polyEscape(err)}</div>`:''}${settings}
  <div data-scroll="combo-cands" style="overflow:auto;max-height:240px"><table class="table terminal"><thead><tr><th>Event</th><th>Clock / score</th><th>Side</th><th>Win %</th><th>Spread</th><th>Left</th><th>Status</th><th></th></tr></thead><tbody>${rows||`<tr><td colspan=8>${empty}</td></tr>`}</tbody></table></div>${sgLine}
  <div class="muted" style="font-size:10px;margin:3px 0">Feed: ${Number(fd.total??fd.eventsInPlay??0)} sports events scanned${fd.pages?' over '+Number(fd.pages)+' pages':''}${fd.capped?' (CAPPED)':''} · ${Number(fd.eventsLive||0)} live · ${fd.comboLive==null?'—':Number(fd.comboLive)} combo-enabled live · ${Number(fd.candidates||0)} eligible${rej?' · Filtered: '+rej:''}</div></div>
  <div class="poly-right"><div class="inset" style="padding:6px;margin-top:6px"><div class="toolbar" style="flex-wrap:wrap;gap:8px"><label>Stake $ <input class="field" id="usComboStake" type="number" min="1" max="${Number(ucs.limits?.maxStakeUsd||25)}" step="0.5" value="${polyEscape(usComboStakeValue||5)}" style="width:70px"></label><span style="font-size:11px">${buildLine}</span></div>
  <div class="toolbar" style="margin-top:4px"><button class="btn" id="usComboPlace" ${canPlace?'':'disabled'}>${betaDenied?'Place (combos beta pending)':'Place combo…'}</button><span class="muted" style="font-size:10px">${polyEscape(placeHint)}</span></div></div>
  <details class="mpo-fold" data-keep="poly-auto" ${keepOpen('poly-auto')}><summary>AUTO COMBO · ${ucs.autopilot?.enabled?'ON':'off'}</summary>${usAutoHtml(ucs.autopilot)}</details>
  <div class="grid2" style="margin-top:6px"><fieldset><legend>Open combos · ${open.length}</legend><div class="toolbar" style="margin-bottom:4px"><button class="btn" id="usComboSettle">Check settlement</button></div><div data-scroll="combo-open" style="overflow:auto;max-height:160px"><table class="table terminal"><thead><tr><th>Legs</th><th>Price × Qty</th><th>Stake</th><th>Status</th><th>P/L</th><th></th></tr></thead><tbody>${openRows}</tbody></table></div></fieldset><fieldset><legend>History</legend><div data-scroll="combo-hist" style="overflow:auto;max-height:160px"><table class="table terminal"><thead><tr><th>Legs</th><th>Price × Qty</th><th>Stake</th><th>Status</th><th>P/L</th></tr></thead><tbody>${histRows}</tbody></table></div><div class="muted" style="font-size:10px;margin-top:3px">${Number(stats.placed||0)} placed · ${Number(stats.won||0)} won · ${Number(stats.lost||0)} lost · P/L ${polyUsd(stats.pnlUsd)} · hit rate ${stats.hitRate==null?'—':polyPct(stats.hitRate)}</div></fieldset></div>
 <details class="mpo-fold" data-keep="poly-research" ${keepOpen('poly-research')}><summary>Research · shadow record · calibration · Lab proposal</summary>${usResearchHtml(polyUSEvidence)}</details></div></div>
 </fieldset></div>`;
 const rerender=()=>{polyModuleSig='';renderSportsbook()};
 $$('.usComboLeg').forEach(el=>el.onchange=()=>{const k=el.dataset.key;if(!k)return;if(el.checked&&usComboSelected.size>=maxLegs){el.checked=false;return}if(el.checked)usComboSelected.add(k);else usComboSelected.delete(k);scheduleUSComboBuild();rerender()});
 $('#usUseSuggested')?.addEventListener('click',()=>{const sgl=(ucs.suggested&&ucs.suggested.legs)||[];usComboSelected=new Set(sgl.slice(0,maxLegs));scheduleUSComboBuild();rerender()});
 bindUSAuto(ucs.autopilot);
 bindUSPaper(ucs.paper,chosen);
 $('#usApplyLab')?.addEventListener('click',async()=>{
  const r=await post('/api/polymarket-us/combos/apply-lab',{}).catch(e=>({ok:false,error:e.message}));
  if(!r?.ok)return showDialog('Polymarket US','Lab proposal not applied',r?.error||'The server refused the proposal.');
  await refreshUSComboSnapshot();
 });
 $('#usComboStake')?.addEventListener('input',e=>{usComboStakeValue=e.target.value;scheduleUSComboBuild()});
 const draft=(id,k,conv)=>$('#'+id)?.addEventListener(id==='usSetLegs'?'change':'input',e=>{usComboSettingsDraft[k]=conv(e.target.value);const b=$('#usSetSave');if(b)b.disabled=false});
 draft('usSetFloor','priceMin',v=>Number(v)/100);draft('usSetMinutes','maxMinutesLeft',Number);draft('usSetLegs','maxLegs',Number);
 $('#usSetWindow')?.addEventListener('change',e=>{usComboSettingsDraft.window=e.target.value;const b=$('#usSetSave');if(b)b.disabled=false});
 $('#usSetSave')?.addEventListener('click',async()=>{
  const r=await post('/api/polymarket-us/combos/settings',{...usComboSettingsDraft}).catch(e=>({ok:false,error:e.message}));
  if(!r?.ok)return showDialog('Polymarket US','Settings not saved',r?.error||'The server rejected the settings.');
  usComboSettingsDraft={};
  while(usComboSelected.size>Number(r.settings?.maxLegs||maxLegs))usComboSelected.delete([...usComboSelected].pop());
  scheduleUSComboBuild();await refreshUSComboSnapshot();
 });
 $$('.usPaste').forEach(b=>b.onclick=async()=>{const el=$('#'+b.dataset.target);if(!el)return;try{const text=await navigator.clipboard.readText();if(!text)throw new Error('Clipboard is empty');el.value=text.trim();el.focus()}catch{el.focus();showDialog('Paste','Clipboard could not be read automatically','The field is focused now. Press Ctrl+V, or right-click the field and choose Paste.')}});
 $('#usSaveKeys')?.addEventListener('click',async()=>{const r=await post('/api/polymarket-us/config',{keyId:$('#usKeyId')?.value,secretKey:$('#usSecret')?.value,realEnabled:true}).catch(e=>({ok:false,error:e.message}));if(!r?.ok)return showDialog('Polymarket US','Connection failed',r?.error||'Could not save credentials.');showDialog('Polymarket US','Key saved','Stored locally with restricted file permissions. Placing still needs an armed session and the typed phrase.');await refreshUSComboSnapshot()});
 $('#usArm')?.addEventListener('click',async()=>{const r=await post('/api/polymarket-us/arm',{armed:!rd.sessionArmed}).catch(e=>({ok:false,error:e.message}));if(!r?.ok)return showDialog('Polymarket US','Arm failed',r?.error||'Could not change the session state.');await refreshUSComboSnapshot()});
 $('#usComboPlace')?.addEventListener('click',()=>usComboPlaceFlow(chosen.slice(),Number(usComboStakeValue)||5));
 $('#usComboSettle')?.addEventListener('click',async()=>{
  try{const r=await post('/api/polymarket-us/combos/settle',{});if(!r?.ok)showDialog('Polymarket US','Settlement check failed',r?.error||'Could not check settlement.')}
  catch(e){showDialog('Polymarket US','Settlement check failed',e.message||'Unknown error')}
  finally{await refreshUSComboSnapshot()}
 });
 $$('.usComboForget').forEach(b=>b.onclick=async()=>{
  const id=b.dataset.id;if(!id)return;
  const confirmation=await polyConfirm({title:'Forget combo',head:'Drop this entry from the local book?',
   html:'<p>This does <b>not</b> cancel or close anything on Polymarket US. Check your real positions there first. It books no P/L and starts no cooldown.</p>',
   phrase:'FORGET',confirmLabel:'Forget entry'});
  if(confirmation!=='FORGET')return;
  try{const r=await post('/api/polymarket-us/combos/forget',{id,confirmation});if(!r?.ok)showDialog('Polymarket US','Entry not dropped',r?.error||'Server refused.')}
  catch(e){showDialog('Polymarket US','Entry not dropped',e.message||'Unknown error')}
  finally{await refreshUSComboSnapshot()}
 });
}
// In-page confirmation (Electron has no window.prompt). Resolves to the typed phrase, or null when dismissed.
// The phrase field is never pre-filled; with an expiry, confirm locks at zero and Re-quote is offered.
function polyConfirm({title,head,html,phrase,confirmLabel='Confirm',expiresAt=null,requote=null}){
 return new Promise(resolve=>{
  const dlg=$('#polyConfirm'),layer=$('#dialogLayer'),input=$('#polyConfirmPhrase'),ok=$('#polyConfirmOk'),rq=$('#polyConfirmRequote'),cd=$('#polyConfirmCountdown'),bodyEl=$('#polyConfirmBody');
  $('#polyConfirmTitle').textContent=title;$('#polyConfirmHead').textContent=head;bodyEl.innerHTML=html;
  input.value='';input.placeholder='Type '+phrase;ok.textContent=confirmLabel;
  let exp=expiresAt,busy=false,timer=null;const previousFocus=document.activeElement;
  const expired=()=>exp!=null&&Date.now()>=exp;
  const sync=()=>{
   if(exp==null)cd.textContent='';
   else{const left=Math.max(0,Math.ceil((exp-Date.now())/1000));cd.textContent=left>0?`Quote expires in ${left}s`:'Quote expired: re-quote to continue.';cd.className=left>0?'':'red'}
   ok.disabled=busy||input.value!==phrase||expired();
   rq.hidden=!(requote&&expired());rq.disabled=busy;
  };
  const close=v=>{clearInterval(timer);dlg.classList.add('hidden');layer.classList.remove('mpo-modal-open');input.oninput=ok.onclick=rq.onclick=null;$('#polyConfirmCancel').onclick=$('#polyConfirmX').onclick=null;previousFocus?.focus();resolve(v)};
  input.oninput=sync;
  ok.onclick=()=>{if(input.value===phrase&&!expired())close(input.value)};
  $('#polyConfirmCancel').onclick=$('#polyConfirmX').onclick=()=>close(null);
  rq.onclick=async()=>{
   busy=true;sync();
   try{const next=await requote();bodyEl.innerHTML=next.html;exp=next.expiresAt}
   catch(e){bodyEl.insertAdjacentHTML('beforeend',`<p class="red">Re-quote failed: ${polyEscape(e&&e.message||e)}</p>`)}
   finally{busy=false;sync()}
  };
  dlg.classList.remove('hidden');layer.classList.add('mpo-modal-open');
  timer=setInterval(sync,250);sync();setTimeout(()=>input.focus(),0);
 });
}
async function usComboQuote(legKeys,stakeUsd){
 const r=await post('/api/polymarket-us/combos/quote',{legKeys,stakeUsd});
 if(!r?.ok)throw new Error(r?.error||'Polymarket US returned no quote.');
 return r.quote;
}
function usQuoteHtml(q,stakeUsd){
 const legs=Array.isArray(q?.legs)?q.legs:[],qty=polyNum(q?.buyQtyDecimal),price=polyNum(q?.buyPrice);
 const list=legs.map(l=>`<li>${polyEscape(l.event||l.symbol||'leg')}: <strong>${polyEscape(l.outcome||l.side||'')}</strong> @ ${polyPct(l.price)}</li>`).join('');
 return `<ul style="margin:4px 0 6px 16px;padding:0">${list}</ul><p>Stake <strong>${polyUsd(stakeUsd)}</strong> (fees included) · quoted price <strong>${polyCents(price)}</strong> for ${qty==null?'—':fmt(qty,2)} contracts.</p><p>Pays <strong>${qty==null?'—':polyUsd(qty)}</strong> only if every leg wins. One losing leg loses the whole stake.</p>`;
}
async function usComboPlaceFlow(legKeys,stakeUsd){
 if(usComboSubmitting||legKeys.length<2)return;
 usComboSubmitting=true;
 let quote=null;
 try{
  try{quote=await usComboQuote(legKeys,stakeUsd)}
  catch(e){return showDialog('Polymarket US','No quote',e.message||'Unknown error')}
  const phrase=await polyConfirm({title:'Place real combo',head:`${legKeys.length} legs · ${polyUsd(stakeUsd)} stake · REAL MONEY`,html:usQuoteHtml(quote,stakeUsd),
   phrase:'PLACE REAL COMBO',confirmLabel:'Place real combo',expiresAt:polyNum(quote.expiresAt),
   requote:async()=>{
    try{await post('/api/polymarket-us/combos/cancel-rfq',{rfqId:quote.rfqId})}catch{}
    quote=await usComboQuote(legKeys,stakeUsd);
    return {html:usQuoteHtml(quote,stakeUsd),expiresAt:polyNum(quote.expiresAt)};
   }});
  if(phrase!=='PLACE REAL COMBO'){try{await post('/api/polymarket-us/combos/cancel-rfq',{rfqId:quote.rfqId})}catch{}return}
  const r=await post('/api/polymarket-us/combos/place',{legKeys,stakeUsd,mode:'rfq',rfqId:quote.rfqId,quoteId:quote.quoteId,confirmation:phrase});
  if(!r?.ok)return showDialog('Polymarket US','Combo not placed',r?.error||'Polymarket US rejected the combo.');
  showDialog('Polymarket US','Combo submitted',`${legKeys.length} legs · ${polyUsd(r.entry?.stakeUsd)} stake · ${r.entry?.status||'SUBMITTED'}. The fill is checked against the exchange before any P/L is booked.`);
  usComboSelected.clear();usComboBuildState=null;
 }catch(e){showDialog('Polymarket US','Combo not placed',e.message||'Unknown error')}
 finally{usComboSubmitting=false;polyModuleSig='';await refreshUSComboSnapshot()}
}
