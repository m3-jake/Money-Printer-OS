// Stocks window: equities and ETFs through the MPOS paper broker (src/core/brokers.js).
// Every order is previewed through the Risk Governor and filled against a fresh quote into the unified
// ledger. No real brokerage is connected. Missing quotes are shown as unavailable, never estimated.
(() => {
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = v => v === null || v === undefined || !Number.isFinite(Number(v)) ? 'unavailable' : (Number(v) < 0 ? '-$' : '$') + Math.abs(Number(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const px = v => v === null || v === undefined ? '—' : Number(v).toFixed(2);
  const when = v => v ? new Date(v).toLocaleString() : '—';
  const tone = v => Number(v) > 0 ? 'pm-up' : Number(v) < 0 ? 'pm-down' : '';
  const readWatch = () => { try { const v = JSON.parse(localStorage.getItem('mpo-stocks-watch') || 'null'); return Array.isArray(v) && v.length ? v : null; } catch { return null; } };
  let watch = readWatch() || ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TLT'];
  const saveWatch = () => { try { localStorage.setItem('mpo-stocks-watch', JSON.stringify(watch)); } catch {} };
  let status = null, error = '', loadError = '', busy = false, preview = null, chart = null, lastFetch = 0, stamp = 0, drawn = '';

  const api = async (path, body) => {
    const r = await fetch('/api/platform' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`); return j;
  };
  const table = (head, rows, empty) => `<div class="core-table-wrap"><table class="table"><thead><tr>${head.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}">${escape(empty)}</td></tr>`}</tbody></table></div>`;
  const btn = (action, label, attrs = '') => `<button class="btn" type="button" data-stk="${action}" ${attrs}>${escape(label)}</button>`;

  function view() {
    if (!status) return '<p>Loading stocks…</p>';
    const a = status.account, s = status.session, q = status.quotes || {}, ds = status.dataSource;
    const tile = (label, value, cls = '') => `<div class="pm-tile"><small>${escape(label)}</small><b class="${cls}">${value}</b></div>`;
    const totalMv = status.positions.reduce((t, p) => t + (p.marketValue || 0), 0);
    return `<div class="core-heading"><h2>STOCKS</h2><span class="mpo-badge">PAPER · NO REAL BROKER</span></div>
      <p class="core-muted">NYSE ${escape(String(s.state).replace('_', ' '))}${s.date ? ' · ' + escape(s.date) : ''} · Quotes: ${escape(ds.status)} (${escape(ds.feed || '')})${ds.lastSuccess ? ' · last ' + when(ds.lastSuccess) : ''}</p>
      ${status.quoteError ? `<p class="core-notice">${escape(status.quoteError)}</p>` : ''}
      <div class="pm-tiles">${tile('Cash', usd(a.cash))}${tile('Buying power', usd(a.buyingPower))}${tile('Market value', usd(a.marketValue))}${tile('Equity', usd(a.equity))}${tile('Realized P/L', usd(a.realized), tone(a.realized))}${tile('Fees paid', usd(a.fees))}</div>
      ${!a.funded ? `<p class="core-notice">This paper account has no funds yet. Record a simulated deposit below.</p>` : ''}
      <h3>Watchlist <small>Stored in this browser</small></h3>
      <form data-stk-form="watch" class="core-toolbar"><label>Add symbol<input name="symbol" maxlength="8" placeholder="e.g. IWM" autocomplete="off"></label><button class="btn" type="submit">Add</button>${btn('refresh', 'Refresh quotes')}</form>
      ${table(['Symbol', 'Bid', 'Ask', 'Last', 'Change', 'Quote time', ''], watch.map(sym => { const x = q[sym] || {}, chg = x.last && x.prevClose ? (x.last / x.prevClose - 1) * 100 : null;
        return `<tr><td><b>${escape(sym)}</b></td><td>${px(x.bid)}</td><td>${px(x.ask)}</td><td>${px(x.last)}</td><td class="${tone(chg)}">${chg === null ? '—' : chg.toFixed(2) + '%'}</td><td>${when(x.quoteAt)}</td><td>${btn('chart', 'Chart', `data-sym="${escape(sym)}"`)}${btn('ticket', 'Trade', `data-sym="${escape(sym)}"`)}${btn('unwatch', '✕', `data-sym="${escape(sym)}" aria-label="Remove ${escape(sym)}"`)}</td></tr>`; }).join(''), 'Watchlist is empty.')}
      ${chart ? `<h3>${escape(chart.symbol)} daily closes <small>${escape(chart.note)}${chart.bars.length ? ` · last bar ${escape(chart.bars.at(-1).d)}` : ''}</small></h3>${window.MPOViz ? MPOViz.canvas('stk-chart', 140, `${chart.symbol} close`) : ''}` : ''}
      <h3>Order ticket <small>Market or marketable limit; regular session only; nothing rests</small></h3>
      <form data-stk-form="preview" class="core-toolbar">
        <label>Symbol<input name="symbol" required maxlength="8" value="${escape(preview?.order?.symbol || watch[0] || '')}" autocomplete="off"></label>
        <label>Side<select name="side"><option>BUY</option><option>SELL</option></select></label>
        <label>Shares<input name="quantity" type="number" min="0.000001" step="any" placeholder="or $"></label>
        <label>Dollars<input name="notionalUsd" type="number" min="1" step="0.01" placeholder="amount"></label>
        <label>Type<select name="type"><option value="market">Market</option><option value="limit">Limit</option></select></label>
        <label>Limit<input name="limitPrice" type="number" min="0.01" step="0.01"></label>
        <label>Mode<select name="mode"><option>PAPER</option><option>MANUAL_APPROVAL</option></select></label>
        <button class="btn" type="submit">Preview</button></form>
      ${preview ? `<div class="core-proposal"><b>${escape(preview.status)}</b> · ${escape(preview.order.side)} ${preview.order.quantity} ${escape(preview.order.symbol)} @ ${px(preview.order.price)} = ${usd(preview.order.gross)} + fees ${usd(preview.order.fee)}
        <br><small>Quote ${px(preview.order.quote?.bid)} / ${px(preview.order.quote?.ask)} from ${escape(preview.order.quote?.source)} · Risk: ${escape(preview.decision.state)}${preview.decision.reasons.length ? ' — ' + escape(preview.decision.reasons.join(', ')) : ''}${preview.decision.warnings?.length ? ' · ' + escape(preview.decision.warnings.join(', ')) : ''}</small>
        ${['PROPOSED', 'AWAITING_APPROVAL'].includes(preview.status) ? `<p>${btn('submit', preview.status === 'AWAITING_APPROVAL' ? 'Approve and fill (paper)' : 'Fill paper order', `data-id="${escape(preview.id)}"`)} ${btn('cancel', 'Cancel', `data-id="${escape(preview.id)}"`)}</p><p class="core-muted">The Risk Governor re-checks the order (including quote age) at fill time.</p>` : ''}</div>` : ''}
      <h3>Positions</h3>
      ${table(['Symbol', 'Shares', 'Avg cost', 'Mark (bid)', 'Market value', 'Unrealized', 'Allocation'], status.positions.map(p => `<tr><td><b>${escape(p.symbol)}</b></td><td>${p.quantity}</td><td>${px(p.avgCost)}</td><td>${px(p.mark)}</td><td>${usd(p.marketValue)}</td><td class="${tone(p.unrealized)}">${usd(p.unrealized)}</td><td>${p.marketValue !== null && totalMv > 0 ? `<span class="core-spread" style="--spread:${(p.marketValue / totalMv * 100).toFixed(1)}%">${(p.marketValue / totalMv * 100).toFixed(1)}%</span>` : '—'}</td></tr>`).join(''), 'No positions.')}
      <h3>Orders</h3>
      ${table(['Time', 'Symbol', 'Side', 'Shares', 'Price', 'Fees', 'Status', 'Risk', ''], status.orders.map(o => `<tr><td>${when(o.created_at)}</td><td>${escape(o.payload.symbol)}</td><td>${escape(o.payload.side)}</td><td>${o.payload.quantity}</td><td>${px(o.payload.price)}</td><td>${usd(o.payload.fee)}</td><td>${escape(o.status)}</td><td><small>${escape((o.decision.reasons || []).join(', '))}</small></td><td>${['PROPOSED', 'AWAITING_APPROVAL'].includes(o.status) ? btn('cancel', 'Cancel', `data-id="${escape(o.id)}"`) : ''}</td></tr>`).join(''), 'No orders yet.')}
      <details><summary>Fund this paper account</summary><p>No real deposit is made. This records an explicit simulated funding entry in the unified ledger.</p><form data-stk-form="fund" class="core-toolbar"><label>Simulated USD<input name="amount" type="number" min="0.01" max="1000000" step="0.01" required></label><button class="btn" type="submit">Record paper deposit</button></form></details>
      <p class="core-muted">${escape(status.fees)}. Brokers: ${status.brokers.map(b => escape(b.label + (b.live ? '' : ' (not live)') + (b.note ? ' — ' + b.note : ''))).join(' · ')}. Order limits come from the Risk Governor (Command Center → Risk limits).</p>`;
  }

  // Simple (glance) and Advanced modes use different panes; draw into whichever is showing.
  const win = () => document.querySelector('.window[data-app="command"]');
  const root = () => document.getElementById('body-stocks');
  const visible = () => { const w = win(), r = root(); return !!(w && r && r.classList.contains('on') && !w.classList.contains('hidden') && !w.classList.contains('glance')); };
  function draw(force = false) {
    const r = root(); if (!visible() || (!force && drawn === r.id + ':' + stamp)) return;
    if (r.contains(document.activeElement) && document.activeElement.matches('input,select,textarea')) return;
    drawn = r.id + ':' + stamp; const top = r.scrollTop;
    r.innerHTML = `<div class="core-app stocks-app">${[error, loadError].filter(Boolean).map(m => `<p class="core-error" role="alert">${escape(m)}</p>`).join('')}${busy ? '<p role="status">Working…</p>' : ''}${view()}</div>`;
    if (chart && window.MPOViz) MPOViz.set('stk-chart', 'lines', { series: [{ label: chart.symbol, color: '#7fd3ff', points: chart.bars.map(b => b.c) }], unit: '$', empty: 'No stored daily bars for this symbol', zero: false });
    r.scrollTop = top;
  }
  async function refresh(force = false) {
    if (busy || !(visible() || window.MPOProgramVisible?.('stocks')) || (!force && Date.now() - lastFetch < 15000)) return;
    lastFetch = Date.now();
    // Load errors are kept apart from action errors, so a refresh never hides why an order was refused.
    try { status = await api('/stocks/status?symbols=' + encodeURIComponent(watch.join(','))); loadError = ''; } catch (e) { loadError = e.message; }
    stamp++; draw();
  }
  async function act(fn) { if (busy) return; busy = true; error = ''; stamp++; draw(true); try { await fn(); } catch (e) { error = e.message; } finally { busy = false; lastFetch = 0; await refresh(true); stamp++; draw(true); } }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-stk]'); if (!b || !root()?.contains(b)) return;
    const a = b.dataset.stk, sym = b.dataset.sym, id = b.dataset.id;
    if (a === 'unwatch') { watch = watch.filter(x => x !== sym); saveWatch(); act(async () => {}); return; }
    if (a === 'ticket') { const f = root().querySelector('[data-stk-form=preview]'); if (f) { f.symbol.value = sym; f.quantity.focus(); } return; }
    act(async () => {
      if (a === 'chart') chart = await api('/stocks/bars?symbol=' + encodeURIComponent(sym));
      else if (a === 'submit') { const r = await api('/stocks/submit', { id }); preview = { ...preview, status: r.result.status, decision: r.result.decision || preview.decision }; }
      else if (a === 'cancel') { await api('/stocks/cancel', { id }); if (preview?.id === id) preview = { ...preview, status: 'CANCELLED' }; }
    });
  });
  document.addEventListener('submit', e => {
    const f = e.target.closest('[data-stk-form]'); if (!f || !root()?.contains(f)) return; e.preventDefault();
    const input = Object.fromEntries(new FormData(f)), kind = f.dataset.stkForm;
    if (kind === 'watch') { const s = String(input.symbol || '').trim().toUpperCase(); if (/^[A-Z]{1,5}(?:[.-][A-Z]{1,2})?$/.test(s) && !watch.includes(s)) { watch = [...watch, s].slice(0, 30); saveWatch(); } else error = s ? `Not a valid symbol: ${s}` : ''; act(async () => {}); return; }
    act(async () => {
      if (kind === 'fund') await api('/stocks/fund', { amount: input.amount, id: crypto.randomUUID() });
      else if (kind === 'preview') { const body = { symbol: input.symbol, side: input.side, type: input.type, mode: input.mode, id: crypto.randomUUID() }; for (const k of ['quantity', 'notionalUsd', 'limitPrice']) if (input[k] !== '') body[k] = Number(input[k]); preview = (await api('/stocks/preview', body)).result; }
    });
  });
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  // Simple view: the paper stock account, the session, and the watchlist's moves today.
  function glanceCard() {
    if (!status) return glance({ title: 'Stocks · paper', pill: { label: loadError ? 'Unavailable' : 'Loading', tone: loadError ? 'bad' : 'warn' }, hero: null, visual: `<div class="g-empty">${escape(loadError || 'Loading stocks…')}</div>` });
    const a = status.account || {}, se = status.session || {}, q = status.quotes || {}, ds = status.dataSource || {}, pos = status.positions || [];
    const open = String(se.state || '').toUpperCase() === 'OPEN';
    return glance({ title: 'Stocks · paper', pill: { label: `NYSE ${String(se.state || '—').replace('_', ' ').toLowerCase()}`, tone: open ? 'ok' : '' },
      hero: usd(a.equity), heroSub: `paper equity · quotes ${escape(String(ds.status || '—').toLowerCase())}${ds.feed ? ' (' + escape(ds.feed) + ')' : ''} · not a real broker`,
      stats: [{ label: 'Cash', value: usd(a.cash) }, { label: 'Positions', value: String(pos.length) }, { label: 'Realized P/L', value: usd(a.realized), tone: a.realized > 0 ? 'g-pos' : a.realized < 0 ? 'g-neg' : '' }],
      visual: `<div class="g-rows g-scroll">${watch.map(sym => { const x = q[sym] || {}, chg = x.last && x.prevClose ? (x.last / x.prevClose - 1) * 100 : null, held = pos.find(p => p.symbol === sym); return gRow(sym, held ? `holding ${held.qty} · ${usd(held.marketValue)}` : 'watching', `${x.last ? usd(x.last) : '—'}${chg === null ? '' : ` <span class="${chg > 0 ? 'g-pos' : chg < 0 ? 'g-neg' : ''}">${chg > 0 ? '+' : ''}${chg.toFixed(2)}%</span>`}`, chg === null ? null : chg >= 0 ? 'ok' : 'bad'); }).join('')}</div>`,
      foot: gFoot([se.date && 'session ' + se.date, 'paper fills', 'Advanced: orders, charts, funding']) });
  }
  addEventListener('DOMContentLoaded', () => window.MPOProgramGlance?.register('stocks', { render: glanceCard, sig: () => [stamp, loadError, status?.account?.equity] }));
  window.MPOStocks = { render() { draw(); refresh(); } };
})();
