/* Compact, bounded Wallet & Crowd panel; no charts, polling loops or synthetic profit. */
(()=>{
 const esc=x=>String(x??'Unknown').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const num=(x,d=4)=>x==null||!Number.isFinite(Number(x))?'Unknown':Number(x).toFixed(d);
 const short=x=>x?String(x).slice(0,7)+'…':'Unknown';
 const seconds=x=>x==null?'Unknown':num(x/1000,1)+' s';
 window.mpoWalletCrowdHTML=(v,advanced=false)=>{
  const c=v?.coverage||{},s=v?.study||{},model=v?.model,e=v?.evaluation||{},mode=v?.control?.mode||v?.mode||'SHADOW_COMPARISON',blocks=e.blockers||['AWAITING_EVIDENCE'];
  const button=(m,label)=>`<button class="btn wallet-crowd-mode" data-crowd-mode="${m}" ${mode===m?'disabled':''}>${label}</button>`;
  return `<section class="mpo-module core-detail wallet-crowd-card"><header class="core-heading"><span>WALLET &amp; CROWD</span> <b class="mpo-badge mpo-badge--paper">PAPER RESEARCH · ${esc(mode)}</b></header><div class="mpo-module-body">
   <div class="mpo-status"><strong>${v?.collectorFresh?'Collector reporting':'Collector stale / awaiting startup'}</strong> · Age ${seconds(v?.collectorAgeMs)} · Capital per alternative ${num(s.capitalSol??v?.budgetSol)} SOL · Real orders locked</div>
   <p>${esc(e.state||v?.state||'AWAITING_COLLECTOR')} · ${esc(c.state||'No capture yet')} · ${num(c.events,0)} accepted events · ${num(c.completeWindows,0)} complete selected-mint intervals · Detection lag ${seconds(c.detectionLagMs)}</p>
   <div class="core-toolbar">${button('OBSERVE_ONLY','Observe Only')}${button('SHADOW_COMPARISON','Shadow Comparison')}${button('PAPER_EXPERIMENT','Opt-In Paper Experiment')}</div>
   <p class="core-muted">The incumbent is unchanged. Comparisons are alternative portfolios, never profits to add together. Stopping entries does not abandon open experimental positions.</p>
   <p class="core-notice">${esc(blocks.slice(0,3).join(' · '))}</p>
   ${(s.lastDecisions||[]).slice(-3).map(d=>`<p><b>${esc(d.action)}</b> ${esc(short(d.asset))} · ${esc(d.reason)}</p>`).join('')||'<p>No eligible forward observation has produced a decision yet.</p>'}
   <details ${advanced?'open':''}><summary>Evidence, comparisons and capability limits</summary>
    <p>Selected mint references only, not the whole market. Anonymous trades never become named followers. Watcher/subscriber counts are unknown. ${esc(c.indexerError||'')}</p>
    <div class="core-table-wrap"><table class="table mpo-table"><thead><tr><th>Alternative / phase</th><th>Cash SOL</th><th>Net realized SOL</th><th>Marked equity SOL</th><th>Drawdown SOL</th><th>Open / closed</th></tr></thead><tbody>
    ${(s.books||[]).map(b=>`<tr><td>${esc(b.policy)}<br><small>${esc(b.phase)} · ${esc(b.operatorMode)}</small></td><td>${num(b.cashSol)}</td><td>${num(b.realizedNetSol)}</td><td>${num(b.markedEquitySol)}</td><td>${num(b.drawdownSol)}</td><td>${b.open} / ${b.closed}</td></tr>`).join('')||'<tr><td colspan="6">Baseline, direct-copy and crowd-aware books await common eligible observations. No profit evidence exists yet.</td></tr>'}
    </tbody></table></div><p class="core-muted">Exact-route quote simulations are provisional, not submitted transactions. Unknown costs, missing liquidation evidence and unfinished holdout block qualification.</p>
    <p>Exact-size quotes retained: ${num(v?.quoteCoverage?.retainedQuotes,0)} ? shared calls ${num(v?.quoteCoverage?.totalCalls,0)} / 4096 ? ${esc((v?.quoteCoverage?.errors||[]).map(e=>e.message).join(' ? ')||'No provider error reported')}</p>
    <p>Phase ${esc(s.phase||'Not started')} · ${s.holdoutBlinded?'Holdout results blinded':'No qualified promotion'} · ${num(s.decisions,0)} / 512 decisions · One registered model configuration.</p>
    ${(model?.candidates||[]).slice(0,5).map(w=>`<p>Wallet ${esc(short(w.wallet))}: ${w.eligibleEpisodes} episodes / ${w.independentClusters} independent groups; estimated follower activity ${w.estimatedFollowerActivity}; median delay ${seconds(w.delayMedianMs)}; copy-realizable lower bound ${num(w.copyRealizable?.lower,2)}% (${w.copyRealizable?.allCostsKnown?'cost evidence present':'cost evidence incomplete'}).</p>`).join('')||'<p>No evaluated wallet/follower model is available yet.</p>'}
    <p>${esc(model?.caveat||'Repeated timing is observational; it does not prove copying, common ownership or a profitable edge.')}</p>
    <p>Leader-wallet results are descriptive history, not copy-realizable results. More detailed leader history remains in the existing wallet scorecard.</p>
    <p>Blocked: ${esc(blocks.join(' · '))}</p>
    ${(v?.capabilities||[]).map(x=>`<p><b>${esc(x.venue)}</b>: ${esc(x.configured)} · ${esc(x.coverage)} · ${esc(x.status)}</p>`).join('')}
    <p>Exit adjustment and reversal execution are not enabled in this first entry-filtering slice. No shorting, leverage or subscriber counts are invented.</p>
   </details><p class="wallet-crowd-message" role="status"></p></div></section>`;
 };
 document.addEventListener('click',async event=>{
  const b=event.target.closest?.('.wallet-crowd-mode');if(!b)return;event.preventDefault();
  const message=b.closest('.wallet-crowd-card')?.querySelector('.wallet-crowd-message'),mode=b.dataset.crowdMode,body={mode};
  if(mode==='PAPER_EXPERIMENT'){const answer=window.prompt('This starts a separate PAPER experiment. It cannot place real orders or replace the incumbent. Type START ISOLATED PAPER EXPERIMENT to confirm.');if(answer!=='START ISOLATED PAPER EXPERIMENT')return;body.confirmation=answer;}
  b.disabled=true;
  try{const r=await fetch('/api/wallet-crowd/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),x=await r.json();if(!r.ok||!x.ok)throw Error(x.error||'Control request refused');if(message)message.textContent='Saved '+x.control.mode+'. Open experimental positions keep their existing exits.';if(window.__MPO_WALLET_CROWD)window.__MPO_WALLET_CROWD.control=x.control;}
  catch(e){if(message)message.textContent=e.message;}finally{b.disabled=false;}
 });
})();