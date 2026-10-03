// Polymarket suite tabs: Positions, History, Performance. The Live combos and Markets tabs are
// rendered elsewhere (dashboard.html and mpo-platform.js). Data comes from the US combo journal
// (real venue orders, unreconciled) and the core ledger (simulated paper fills); the two are
// always labelled and never summed together.
(() => {
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = v => v === null || v === undefined || !Number.isFinite(Number(v)) ? 'unavailable' : (Number(v) < 0 ? '-$' : '$') + Math.abs(Number(v)).toFixed(2);
  const pct = v => v === null || v === undefined ? '—' : (Number(v) * 100).toFixed(1) + '%';
  const when = v => v ? new Date(v).toLocaleString() : '—';
  const tone = v => Number(v) > 0 ? 'pm-up' : Number(v) < 0 ? 'pm-down' : '';
  const IDS = ['pmpositions', 'pmhistory', 'pmperformance'];
  let journal = null, core = null, error = '', lastFetch = 0, busy = false, stamp = 0;
  const drawn = {};

  const table = (head, rows, empty) => `<div class="core-table-wrap"><table class="table"><thead><tr>${head.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}">${escape(empty)}</td></tr>`}</tbody></table></div>`;
  const legs = x => Array.isArray(x.legs) ? x.legs.map(l => l.title || l.name || l.key || l.symbol || '').filter(Boolean).join(' + ') || `${x.legs.length} legs` : escape(x.symbol || '—');
  const corePoly = () => (core?.portfolio?.accounts || []).filter(a => a.venue === 'polymarket');

  function positions() {
    const open = journal?.open || [], paper = corePoly().flatMap(a => a.positions.map(p => ({ ...p, account: a.account })));
    return `<div class="core-heading"><h2>POSITIONS</h2><span class="mpo-badge">READ ONLY</span></div>
      <h3>US combos · LIVE UNRECONCILED <small>Real venue orders placed from Live combos · not reconciled with the venue</small></h3>
      ${table(['Opened', 'Legs', 'LIVE Fill price', 'Qty', 'LIVE Cost', 'Status', 'Fill'], open.map(x => `<tr><td>${when(x.at)}</td><td>${escape(legs(x))}</td><td>${pct(x.fillPrice)}</td><td>${escape(x.quantity)}</td><td>${usd(x.costUsd)}</td><td>${escape(x.status)}</td><td>${x.fillVerified === true ? 'verified' : '<b>unverified</b>'}</td></tr>`).join(''), 'No open US combos.')}
      <h3>Core paper positions <small>Simulated fills in the common ledger</small></h3>
      ${table(['Instrument', 'Strategy', 'Quantity', 'PAPER Cost basis'], paper.map(p => `<tr><td>${escape(p.instrumentId)}</td><td>${escape(p.strategyId)}</td><td>${escape(p.quantity)}</td><td>${usd(p.costBasis)}</td></tr>`).join(''), 'No core paper positions on Polymarket.')}`;
  }
  function history() {
    const rows = journal?.history || [], ledger = (core?.ledger || []).filter(e => e.venue === 'polymarket');
    return `<div class="core-heading"><h2>HISTORY</h2><span class="mpo-badge">LAST ${rows.length}</span></div>
      <h3>US combos · LIVE UNRECONCILED</h3>
      ${table(['Settled', 'Legs', 'LIVE Fill price', 'LIVE Cost', 'LIVE Payout', 'LIVE P/L', 'Result'], rows.map(x => `<tr><td>${when(x.settledAt || x.at)}</td><td>${escape(legs(x))}</td><td>${pct(x.fillPrice)}</td><td>${usd(x.costUsd)}</td><td>${usd(x.payoutUsd)}</td><td class="${tone(x.pnlUsd)}">${usd(x.pnlUsd)}</td><td>${escape(x.status)}</td></tr>`).join(''), 'No settled US combos yet.')}
      <h3>Core paper ledger <small>Polymarket entries</small></h3>
      ${table(['Time', 'Kind', 'Quantity', 'PAPER Gross', 'PAPER Fee', 'Reference'], ledger.map(e => `<tr><td>${when(e.at)}</td><td>${escape(e.kind)}</td><td>${escape(e.quantity)}</td><td>${usd(e.gross)}</td><td>${usd(e.fee)}</td><td>${escape(e.reference)}</td></tr>`).join(''), 'No core ledger entries for Polymarket.')}`;
  }
  function performance() {
    const p = journal?.performance;
    if (!p) return '<p>Loading performance…</p>';
    const ci = p.winRateCi95 ? `${pct(p.winRateCi95.low)}–${pct(p.winRateCi95.high)}` : '—';
    const tile = (label, value, cls = '') => `<div class="pm-tile"><small>${escape(label)}</small><b class="${cls}">${value}</b></div>`;
    if (window.MPOViz) {
      MPOViz.set('pm-perf-curve', 'lines', { series: [{ label: 'LIVE net P/L', color: '#ffb000', points: p.curve }], unit: '$', empty: 'Cumulative P/L appears once combos settle' });
      MPOViz.set('pm-perf-cal', 'scatter', { lo: 0.5, hi: 1, points: p.calibration.map(c => ({ x: c.implied, y: c.winRate, n: c.n })), empty: 'Calibration fills in as combos settle' });
    }
    return `<div class="core-heading"><h2>PERFORMANCE</h2><span class="mpo-badge">US COMBOS · LIVE UNRECONCILED · SETTLED ONLY</span></div>
      ${p.sampleNote ? `<p class="core-notice">${escape(p.sampleNote)}</p>` : ''}
      <div class="pm-tiles">${tile('LIVE Net P/L', usd(p.netPnlUsd), tone(p.netPnlUsd))}${tile('LIVE ROI on cost', p.roiPct === null ? '—' : p.roiPct.toFixed(1) + '%', tone(p.roiPct))}${tile('Settled / placed', `${p.settled} / ${p.placed}`)}${tile('Won / lost', `${p.won} / ${p.lost}`)}
        ${tile('Win rate', pct(p.winRate))}${tile('95% interval', ci)}${tile('Avg implied', pct(p.avgImplied))}${tile('Realized − implied', p.edge === null ? '—' : (p.edge * 100).toFixed(1) + ' pts', tone(p.edge))}
        ${tile('LIVE Open', `${p.open} (${p.unverifiedOpen} unverified)`)}${tile('LIVE Open cost', usd(p.openCostUsd))}</div>
      ${window.MPOViz ? `<div class="mpo-viz-grid">${MPOViz.canvas('pm-perf-curve', 130, 'LIVE cumulative net P/L')}${MPOViz.canvas('pm-perf-cal', 130, 'won vs implied (fill price)')}</div>` : ''}
      <h3>Calibration by fill price</h3>
      ${table(['Fill price', 'Combos', 'Avg implied', 'Won', 'Difference'], p.calibration.map(c => `<tr><td>${pct(c.lo)}–${pct(c.hi)}</td><td>${c.n}</td><td>${pct(c.implied)}</td><td>${pct(c.winRate)}</td><td class="${tone(c.winRate - c.implied)}">${((c.winRate - c.implied) * 100).toFixed(1)} pts</td></tr>`).join(''), 'No settled combos with a fill price yet.')}
      <p class="core-muted">Implied probability is the fill price per $1 contract. Fees are inside cost and P/L. Past settlement rates do not predict future results; small samples swing widely.</p>`;
  }

  const visible = id => { const pane = document.getElementById('body-' + id), w = pane?.closest('.window'); return pane && pane.classList.contains('on') && w && !w.classList.contains('hidden') && !w.classList.contains('glance'); };
  // Redraw only when data changed, so frequent dashboard renders do not rebuild tables or charts.
  function draw(id) {
    if (!visible(id) || drawn[id] === stamp) return;
    drawn[id] = stamp;
    const root = document.getElementById('body-' + id), top = root.scrollTop;
    root.innerHTML = `<div class="core-app pm-suite">${error ? `<p class="core-error" role="alert">${escape(error)}</p>` : ''}${id === 'pmpositions' ? positions() : id === 'pmhistory' ? history() : performance()}</div>`;
    root.scrollTop = top;
  }
  async function refresh(force = false) {
    if (busy || (!force && Date.now() - lastFetch < 10000) || !IDS.some(id => visible(id) || window.MPOProgramVisible?.(id))) return;
    busy = true; lastFetch = Date.now();
    try {
      const [j, c] = await Promise.all([fetch('/api/polymarket-us/combos/journal', { cache: 'no-store' }), fetch('/api/platform/status', { cache: 'no-store' })]);
      if (!j.ok) throw new Error(`Combo journal unavailable (HTTP ${j.status})`);
      journal = await j.json(); core = c.ok ? await c.json() : null; error = journal.recoveryRequired ? journal.recoveryError || 'Combo journal needs recovery' : '';
    } catch (e) { error = e.message; }
    finally { busy = false; stamp++; IDS.forEach(draw); }
  }
  // Simple views for Positions, History and Performance.
  const waiting = title => glance({ title, pill: { label: error ? 'Unavailable' : 'Loading', tone: error ? 'bad' : 'warn' }, hero: null, visual: `<div class="g-empty">${escape(error || 'Loading the combo journal…')}</div>` });
  const CARDS = {
    pmpositions() {
      if (!journal) return waiting('Polymarket · positions');
      const open = journal.open || [], paper = corePoly().flatMap(a => a.positions.map(p => ({ ...p, account: a.account }))), cost = paper.reduce((t, p) => t + (Number(p.costBasis) || 0), 0);
      return glance({ title: 'Polymarket · positions', pill: open.length ? { label: `${open.length} live unreconciled`, tone: 'warn' } : { label: 'Paper only', tone: 'ok' },
        hero: String(paper.length + open.length), heroUnit: 'open', heroSub: `${paper.length} paper positions · ${open.length} live combos`,
        stats: [{ label: 'Paper cost basis', value: usd(cost) }, { label: 'Live combos', value: String(open.length) }, { label: 'Unverified fills', value: String(open.filter(x => x.fillVerified !== true).length) }],
        visual: `<div class="g-rows g-scroll">${[...open.map(x => gRow(legs(x), `LIVE · ${x.status} · ${when(x.at)}`, usd(x.costUsd), x.fillVerified === true ? 'ok' : 'warn')), ...paper.map(p => gRow(p.instrumentId, `paper · ${p.strategyId}`, usd(p.costBasis), 'ok'))].join('') || '<div class="g-empty">No open positions.</div>'}</div>`,
        foot: gFoot(['read only', 'Advanced: fills, ledger, verification']) });
    },
    pmhistory() {
      if (!journal) return waiting('Polymarket · history');
      const rows = journal.history || [], pnl = rows.reduce((t, x) => t + (Number(x.pnlUsd) || 0), 0), won = rows.filter(x => Number(x.pnlUsd) > 0).length;
      return glance({ title: 'Polymarket · history', pill: { label: `last ${rows.length}`, tone: '' },
        hero: usd(pnl), heroSub: `net over ${rows.length} settled combos (live, unreconciled)`,
        stats: [{ label: 'Settled', value: String(rows.length) }, { label: 'Won', value: String(won), tone: won ? 'g-pos' : '' }, { label: 'Lost', value: String(rows.length - won), tone: rows.length - won ? 'g-neg' : '' }],
        visual: `<div class="g-rows g-scroll">${rows.slice(0, 14).map(x => gRow(legs(x), `${when(x.settledAt || x.at)} · ${x.result || x.status || ''}`, `<span class="${Number(x.pnlUsd) >= 0 ? 'g-pos' : 'g-neg'}">${usd(x.pnlUsd)}</span>`, Number(x.pnlUsd) >= 0 ? 'ok' : 'bad')).join('') || '<div class="g-empty">Nothing settled yet.</div>'}</div>`,
        foot: gFoot(['fees are inside cost and P/L', 'Advanced: core paper ledger']) });
    },
    pmperformance() {
      const p = journal?.performance; if (!p) return waiting('Polymarket · performance');
      if (window.MPOViz) MPOViz.set('pm-perf-g', 'lines', { series: [{ label: 'net P/L', color: '#ffb000', points: p.curve }], unit: '$', empty: 'Cumulative P/L appears once combos settle' });
      return glance({ title: 'Polymarket · performance', pill: { label: `${p.settled} settled`, tone: p.settled >= 30 ? 'ok' : 'warn' },
        hero: usd(p.netPnlUsd ?? 0), heroSub: `net P/L · ROI ${p.roiPct === null ? '—' : p.roiPct.toFixed(1) + '%'} · win rate ${pct(p.winRate)}${p.winRateCi95 ? ` (95%: ${pct(p.winRateCi95.low)}–${pct(p.winRateCi95.high)})` : ''}`,
        stats: [{ label: 'Won / lost', value: `${p.won} / ${p.lost}` }, { label: 'Avg implied', value: pct(p.avgImplied) }, { label: 'Realized − implied', value: p.edge === null ? '—' : (p.edge * 100).toFixed(1) + ' pts', tone: p.edge > 0 ? 'g-pos' : p.edge < 0 ? 'g-neg' : '' }],
        visual: window.MPOViz ? `<div class="g-fill">${MPOViz.canvas('pm-perf-g', 120, 'cumulative net P/L')}</div>` : '',
        foot: gFoot([p.sampleNote || 'small samples swing widely', 'Advanced: calibration by fill price']) });
    },
  };
  addEventListener('DOMContentLoaded', () => { for (const id of IDS) window.MPOProgramGlance?.register(id, { render: CARDS[id], sig: () => [stamp, error] }); });
  function render() { IDS.forEach(draw); refresh(); }
  setInterval(() => { if (!document.hidden) refresh(); }, 10000);
  window.MPOPolymarket = { render, refresh: () => refresh(true) };
})();
