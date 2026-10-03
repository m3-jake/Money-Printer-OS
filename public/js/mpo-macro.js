// Macro window: FRED indicators with Kalshi release ladders (src/core/macro.js). Revised values and
// as-of (vintage) values are labelled differently; Kalshi probabilities are market prices, not a model.
(() => {
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = v => v ? new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const fmt = (v, unit) => v === null || v === undefined ? '—' : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 3 })}${unit === '%' ? '%' : unit ? ' ' + unit : ''}`;
  let data = null, error = '', busy = false, stamp = 0, drawn = '', asof = null, lastFetch = 0;
  const api = async p => { const r = await fetch('/api/platform' + p, { cache: 'no-store' }); const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
  const table = (head, rows, empty) => `<div class="core-table-wrap"><table class="table"><thead><tr>${head.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}">${escape(empty)}</td></tr>`}</tbody></table></div>`;

  function card(i) {
    const chg = i.last && i.prev ? i.last.value - i.prev.value : null, l = i.ladder;
    return `<section class="macro-card"><header><b>${escape(i.label)}</b><small>FRED ${escape(i.fred)}${i.kalshi ? ' · Kalshi ' + escape(i.kalshi) : ''}</small></header>
      ${i.error ? `<p class="core-error">${escape(i.error)}</p>` : `<p class="macro-last">${fmt(i.last?.value, i.unit)} <small>${escape(i.last?.date || '')}${chg === null ? '' : ` · ${chg >= 0 ? '+' : ''}${fmt(chg, i.unit)} vs prior`}</small></p>${window.MPOViz ? MPOViz.canvas('macro-' + i.id, 46, '') : ''}`}
      ${l ? l.error ? `<p class="core-muted">Kalshi: ${escape(l.error)}</p>` : `<p class="core-muted">${escape(l.title)}${l.subTitle ? ' · ' + escape(l.subTitle) : ''} — trading closes ${when(l.closeAt)}. Implied median <b>${fmt(l.impliedMedian, i.unit)}</b></p>
        <div class="macro-ladder">${l.rungs.map(r => `<div title="${escape(r.title)}"><span>&gt; ${fmt(r.strike, i.unit)}</span><i style="--p:${(r.p * 100).toFixed(0)}%"></i><em>${(r.p * 100).toFixed(0)}%</em></div>`).join('')}</div>` : ''}</section>`;
  }
  function view() {
    if (!data) return busy ? '<p>Loading FRED and Kalshi (first load takes a few seconds)…</p>' : '<p>Loading…</p>';
    return `<div class="core-heading"><h2>MACRO</h2><span class="mpo-badge">${data.vintageMode ? 'FRED VINTAGES' : 'FRED LATEST (REVISED)'}</span></div>
      <p class="core-notice">${escape(data.note)}</p>
      <h3>Upcoming releases <small>Kalshi trading closes minutes before each official release</small></h3>
      ${table(['When (Kalshi close)', 'Indicator', 'Event', 'Implied median'], data.calendar.map(c => { const i = data.indicators.find(x => x.id === c.id); return `<tr><td>${when(c.closeAt)}</td><td>${escape(c.label)}</td><td>${escape(c.title)} <small>${escape(c.eventTicker)}</small></td><td>${fmt(c.impliedMedian, i?.unit)}</td></tr>`; }).join(''), 'No open Kalshi release markets found.')}
      <h3>Indicators</h3><div class="macro-grid">${data.indicators.map(card).join('')}</div>
      <h3>As-of history <small>What was published by a given moment</small></h3>
      ${data.vintageMode ? `<form data-macro-form="asof" class="core-toolbar"><label>Indicator<select name="id">${data.indicators.map(i => `<option value="${i.id}">${escape(i.label)}</option>`).join('')}</select></label><label>As of<input name="asOf" type="datetime-local" required></label><button class="btn" type="submit">Show</button></form>
        ${asof ? `<p class="core-muted">${escape(asof.rule)}</p>${table(['Observation', 'Value', 'First published'], asof.rows.slice().reverse().map(r => `<tr><td>${escape(r.date)}</td><td>${fmt(r.value)}</td><td>${escape(r.published)}</td></tr>`).join(''), 'Nothing published by then.')}` : ''}`
        : '<p class="core-muted">Set FRED_API_KEY (free at fred.stlouisfed.org) to query history as it was known on past dates. Without it, revised values would leak into backtests, so the query is disabled.</p>'}
      <p class="core-muted">FRED: ${escape(data.fred.status)} · ${escape(data.fred.mode)} · loaded ${when(data.at)}</p>`;
  }
  const win = () => document.querySelector('.window[data-app="command"]');
  const root = () => document.getElementById('body-macro');
  const visible = () => { const w = win(), r = root(); return !!(w && r && r.classList.contains('on') && !w.classList.contains('hidden') && !w.classList.contains('glance')); };
  function draw(force = false) {
    const r = root(); if (!visible() || (!force && drawn === r.id + ':' + stamp)) return;
    if (!force && r.contains(document.activeElement) && document.activeElement.matches('input,select,textarea')) return;
    drawn = r.id + ':' + stamp; const top = r.scrollTop;
    r.innerHTML = `<div class="core-app macro-app">${error ? `<p class="core-error" role="alert">${escape(error)}</p>` : ''}${view()}</div>`;
    if (window.MPOViz && data) for (const i of data.indicators) MPOViz.set('macro-' + i.id, 'lines', { series: [{ label: i.id, color: '#7fd3ff', points: (i.history || []).map(h => h.value) }], zero: false, empty: '' });
    r.scrollTop = top;
  }
  async function refresh() {
    if (busy || !(visible() || window.MPOProgramVisible?.('macro')) || Date.now() - lastFetch < 600000) return;
    busy = true; lastFetch = Date.now(); stamp++; draw(true);
    try { data = await api('/macro'); error = ''; } catch (e) { error = e.message; lastFetch = 0; } finally { busy = false; stamp++; draw(true); }
  }
  document.addEventListener('submit', async e => {
    const f = e.target.closest('[data-macro-form]'); if (!f || !root()?.contains(f)) return; e.preventDefault();
    const i = Object.fromEntries(new FormData(f));
    try { asof = await api(`/macro/asof?id=${encodeURIComponent(i.id)}&asOf=${new Date(i.asOf).getTime()}`); error = ''; } catch (err) { error = err.message; }
    stamp++; draw(true);
  });
  // Simple view: the next official release Kalshi is trading, and every indicator's latest print.
  function glanceCard() {
    if (!data) return glance({ title: 'Macro · FRED + Kalshi', pill: { label: error ? 'Unavailable' : 'Loading', tone: error ? 'bad' : 'warn' }, hero: null, visual: `<div class="g-empty">${escape(error || 'Loading FRED and Kalshi (first load takes a few seconds)…')}</div>` });
    const next = (data.calendar || []).filter(c => c.closeAt > Date.now()).sort((a, b) => a.closeAt - b.closeAt)[0];
    const until = t => { const h = (t - Date.now()) / 3600e3; return h < 1 ? Math.round(h * 60) + ' min' : h < 48 ? Math.round(h) + ' h' : Math.round(h / 24) + ' days'; };
    const ind = data.indicators || [];
    return glance({ title: 'Macro · FRED + Kalshi', pill: { label: data.vintageMode ? 'FRED vintages' : 'FRED latest', tone: data.fred?.status === 'OK' || data.fred?.status === 'CONNECTED' ? 'ok' : '' },
      hero: next ? escape(next.label) : '—', heroText: true, heroSub: next ? `next release Kalshi trades · closes in ${until(next.closeAt)} (${when(next.closeAt)})` : 'No upcoming release on Kalshi',
      stats: [{ label: 'Indicators', value: String(ind.length) }, { label: 'Upcoming releases', value: String((data.calendar || []).length) }, { label: 'FRED', value: escape(String(data.fred?.status || '—')) }],
      visual: `<div class="g-rows g-scroll">${ind.map(i => { const chg = i.last && i.prev ? i.last.value - i.prev.value : null; return gRow(i.label, `FRED ${i.fred}${i.last?.date ? ' · ' + i.last.date : ''}`, `${fmt(i.last?.value, i.unit)}${chg === null ? '' : ` <span class="${chg > 0 ? 'g-pos' : chg < 0 ? 'g-neg' : ''}">${chg > 0 ? '▲' : chg < 0 ? '▼' : '='}</span>`}`, i.error ? 'bad' : 'ok'); }).join('')}</div>`,
      foot: gFoot(['Kalshi prices are markets, not a model', 'Advanced: release ladders, as-of history']) });
  }
  addEventListener('DOMContentLoaded', () => window.MPOProgramGlance?.register('macro', { render: glanceCard, sig: () => [stamp, error, busy] }));
  window.MPOMacro = { render() { draw(); refresh(); } };
})();
