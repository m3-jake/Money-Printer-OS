/* Two overview graphs use observed prices and independent recorded book results only. */
window.MPOCommandGraphs=(()=>{
  let current=null,selected=null;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
  const arr=v=>Array.isArray(v)?v:[];
  const money=v=>num(v)==null?'Unknown':'$'+v.toLocaleString(undefined,{maximumFractionDigits:v<1?8:2});
  const cents=v=>num(v)==null?'?':(v*100).toFixed(1)+'¢';
  const age=q=>q.session?'Session close '+q.session:q.at?Math.max(0,Math.floor((Date.now()-q.at)/60000))+'m old':'Observation time unknown';
  const tip=q=>`${q.venue} · ${q.symbol||q.title}\n${q.title||''}\n${q.price!=null?'Price '+money(q.price)+' · ':''}Bid ${q.venue?.includes('polymarket')||q.venue==='kalshi'?cents(q.bid):money(q.bid)} / ask ${q.venue?.includes('polymarket')||q.venue==='kalshi'?cents(q.ask):money(q.ask)}${q.noBid!=null||q.noAsk!=null?' · NO '+cents(q.noBid)+' / '+cents(q.noAsk):''}\n${age(q)} · ${q.source||'unknown source'} · ${q.kind||'listing, not an executable fill'}`;
  const idFor=b=>/pump/i.test(b.module)?'pumpfun':/equities|Stocks/i.test(b.module)?'robinhood-equities':/Robinhood/i.test(b.module)?'robinhood':/Kalshi/i.test(b.module)?'kalshi':/US|combo/i.test(b.module)?'polymarket-combo':/Polymarket/i.test(b.module)?'polymarket':null;
  const venueFor=q=>q.venue==='kalshi'?'kalshi':q.venue==='polymarket-us'?'polymarket-combo':q.venue==='polymarket'?'polymarket':q.venue==='Stocks & ETFs'?'robinhood-equities':/Pump/.test(q.venue)?'pumpfun':'robinhood';
  const color=q=>num(q.ask)==null?'#b1bbb0':q.at&&Date.now()-q.at>15*60000?'#a8b3a9':`hsl(${Math.round(190-q.ask*90)} 44% ${Math.round(89-q.ask*43)}%)`;
  function inspector(){
    const all=[...arr(current?.markets?.assets),...arr(current?.markets?.predictions)],q=all.find(q=>q.id===selected)||all[0];
    return q?`<b>${esc(q.symbol||q.title)}</b><span>${esc(q.price!=null?money(q.price):'YES '+cents(q.bid)+' / '+cents(q.ask))}</span><small>${esc(age(q)+' · '+q.source+' · '+(q.kind||'listing'))}</small>`:'Observed prices are connecting. Unknown prices stay unknown.';
  }
  function html(data){
    current=data;
    const assets=arr(data?.markets?.assets),predictions=arr(data?.markets?.predictions),modules=arr(data?.lab?.modules),books=arr(data?.books),paper=books.filter(b=>b.kind!=='lab');
    const groups=[...new Set(predictions.map(q=>q.venue))];
    const assetsHtml=assets.filter(q=>q.venue!=='Pump.fun').map(q=>`<button class="cc-price-asset" data-cc-price="${esc(q.id)}" title="${esc(tip(q))}"><b>${esc(q.symbol)}</b><span>${esc(money(q.price))}</span><small>${esc(q.kind==='SESSION_CLOSE'?q.session:q.at?age(q):'Time unknown')}</small></button>`).join('');
    if(assets.some(q=>q.venue==='Pump.fun'))groups.push('Pump.fun');
    const maps=groups.map(venue=>{const quotes=(venue==='Pump.fun'?assets:predictions).filter(q=>q.venue===venue);return `<div class="cc-price-map"><div><b>${esc(venue)}</b><span>${quotes.length} ${venue==='Pump.fun'?'token listing prices':'contracts'} · ${quotes.filter(q=>num(venue==='Pump.fun'?q.price:q.ask)==null).length} unknown</span></div><canvas data-cc-price-map="${esc(venue)}" tabindex="0" role="img" aria-label="${esc(venue)} price heatmap, ${quotes.length} stored prices; use arrow keys for exact quotes" width="960" height="100"></canvas></div>`}).join('');
    const flow=modules.map(m=>{
      const n=assets.filter(q=>venueFor(q)===m.id).length+predictions.filter(q=>venueFor(q)===m.id).length,related=paper.filter(b=>idFor(b)===m.id),active=arr(data?.lab?.scheduler?.active).some(j=>j.module===m.id),blocked=!['RESEARCHING','RESEARCH_ONLY'].includes(m.state);
      return `<div class="cc-flow-row"><b>${esc(m.title.replace('Robinhood ','RH '))}</b><span title="Recorded listings and quotes, not fills">${n} prices</span><i>→</i><span class="${blocked?'cc-flow-blocked':'cc-flow-ready'}" title="${esc(m.blockers?.[0]||m.pipeline)}">${active?'Searching':esc(m.state?.replaceAll('_',' ')||'Unknown')}</span><i>→</i><span>${m.id==='pumpfun'?(data?.activity?.pump?.open??'?')+' open':related.length+' books'}</span></div>`;
    }).join('');
    const booksHtml=paper.map(b=>{const v=num(b.pnl),title=`${b.module} · ${b.label}\nNet ${v==null?'Unknown':v+' '+b.unit} · ${b.closes??'?'} closes\nBaseline ${b.baseline??'?'} ${b.unit} · ${b.verdict}\n${b.reason||''}`;return `<span tabindex="0" class="cc-book-dot ${v==null?'unknown':v<0?'loss':v>0?'gain':'flat'}" title="${esc(title)}"><b>${esc(b.id.replace(/polymarket-|robinhood-|pumpfun-/g,'').slice(0,12))}</b><small>${v==null?'?':v.toFixed(b.unit==='SOL'?3:2)} ${esc(b.unit)}</small></span>`;}).join('');
    const discovery=data?.copy?.catalogue,copyBooks=arr(data?.copy?.books),open=copyBooks.reduce((n,b)=>n+b.open,0),pauses=copyBooks.filter(b=>b.paused).length;
    return `<div class="cc-graphs"><section class="cc-graph-card"><div class="cc-graph-title"><h3>Market & price atlas</h3><span>${assets.length} assets / ${predictions.length} contracts</span></div><div class="cc-price-assets">${assetsHtml||'<p>Asset prices not reported</p>'}</div>${maps||'<p class="cc-note">Contract listings not reported</p>'}<div class="cc-price-key"><span>YES ask / 0¢</span><i></i><span>100¢</span><span>Grey: stale or unknown</span></div><div class="cc-price-inspector" aria-live="polite">${inspector()}</div><small class="cc-graph-foot">Every stored contract is mapped. Hover or use arrows for exact bid/ask. Stock session closes and listings retain their source and age.</small></section>
      <section class="cc-graph-card"><div class="cc-graph-title"><h3>System → research → paper results</h3><span>${paper.length} independent books</span></div><div class="cc-flow-header"><span>Module / feed</span><span>Observed</span><span>Evolution Lab</span><span>Paper</span></div><div class="cc-flow">${flow||'<p>Lab module states not reported</p>'}</div><div class="cc-signal-chain"><b>Copy</b><span>${discovery?.candidates?.length??'?'} discovered</span><i>→</i><span>${data?.copy?.uniqueLeaders??'?'} watched</span><i>→</i><span>${data?.copy?open:'?'} open</span><small>${pauses} loss pauses · 1 min Lab feedback</small></div><div class="cc-signal-chain"><b>Pump copy</b><span>${esc(data?.activity?.pumpCopy?.status||'Not reported')}</span><small>Wallet evidence is separate from the ${data?.activity?.pump?.open??'?'} open token trades above.</small></div><div class="cc-book-map">${booksHtml||'<p>Book results not reported</p>'}</div><div class="cc-book-key"><span class="gain">Positive net</span><span class="loss">Negative net</span><span class="flat">Flat</span><span>Every book keeps its own USD or SOL</span></div><small class="cc-graph-foot">Results are net after costs; green does not mean qualified. Hover a book for baseline, closes and blockers.</small></section></div>`;
  }
  function paint(){
    if(!document.querySelectorAll)return;
    for(const canvas of document.querySelectorAll('[data-cc-price-map]')){
      const quotes=arr(canvas.dataset.ccPriceMap==='Pump.fun'?current?.markets?.assets:current?.markets?.predictions).filter(q=>q.venue===canvas.dataset.ccPriceMap),ctx=canvas.getContext('2d');if(!ctx)continue;
      const cols=Math.max(1,Math.ceil(Math.sqrt(quotes.length*9.6))),rows=Math.max(1,Math.ceil(quotes.length/cols)),w=960/cols,h=100/rows;ctx.clearRect(0,0,960,100);
      quotes.forEach((q,i)=>{ctx.fillStyle=q.venue==='Pump.fun'?(num(q.price)==null?'#b1bbb0':'#b3d4c3'):color(q);ctx.fillRect((i%cols)*w,Math.floor(i/cols)*h,Math.max(1,w-1),Math.max(1,h-1));});
      let index=0;
      const select=i=>{const q=quotes[Math.max(0,Math.min(quotes.length-1,i))];if(!q)return;selected=q.id;canvas.title=tip(q);canvas.setAttribute('aria-label',tip(q));const box=document.querySelector('.cc-price-inspector');if(box)box.innerHTML=inspector();};
      canvas.onpointermove=e=>{const r=canvas.getBoundingClientRect();index=Math.floor((e.clientY-r.top)/r.height*rows)*cols+Math.floor((e.clientX-r.left)/r.width*cols);select(index);};
      canvas.onfocus=()=>select(index);canvas.onkeydown=e=>{if(!['ArrowRight','ArrowLeft','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();index=Math.max(0,Math.min(quotes.length-1,index+({ArrowRight:1,ArrowLeft:-1,ArrowUp:-cols,ArrowDown:cols}[e.key])));select(index);};
    }
  }
  document.addEventListener('click',e=>{const b=e.target.closest('[data-cc-price]');if(!b)return;selected=b.dataset.ccPrice;const box=document.querySelector('.cc-price-inspector');if(box)box.innerHTML=inspector();});
  return {html,paint};
})();
