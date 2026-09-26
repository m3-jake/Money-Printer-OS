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
      <h3>US combos <small>Real venue orders placed from Live combos · not reconciled with the venue</small></h3>
      ${table(['Opened', 'Legs', 'Fill price', 'Qty', 'Cost', 'Status', 'Fill'], open.map(x => `<tr><td>${when(x.at)}</td><td>${escape(legs(x))}</td><td>${pct(x.fillPrice)}</td><td>${escape(x.quantity)}</td><td>${usd(x.costUsd)}</td><td>${escape(x.status)}</td><td>${x.fillVerified === true ? 'verified' : '<b>unverified</b>'}</td></tr>`).join(''), 'No open US combos.')}
      <h3>Core paper positions <small>Simulated fills in the common ledger</small></h3>
      ${table(['Instrument', 'Strategy', 'Quantity', 'Cost basis'], paper.map(p => `<tr><td>${escape(p.instrumentId)}</td><td>${escape(p.strategyId)}</td><td>${escape(p.quantity)}</td><td>${usd(p.costBasis)}</td></tr>`).join(''), 'No core paper positions on Polymarket.')}`;
  }
  function history() {
    const rows = journal?.history || [], ledger = (core?.ledger || []).filter(e => e.venue === 'polymarket');
    return `<div class="core-heading"><h2>HISTORY</h2><span class="mpo-badge">LAST ${rows.length}</span></div>
      <h3>US combos</h3>
      ${table(['Settled', 'Legs', 'Fill price', 'Cost', 'Payout', 'P/L', 'Result'], rows.map(x => `<tr><td>${when(x.settledAt || x.at)}</td><td>${escape(legs(x))}</td><td>${pct(x.fillPrice)}</td><td>${usd(x.costUsd)}</td><td>${usd(x.payoutUsd)}</td><td class="${tone(x.pnlUsd)}">${usd(x.pnlUsd)}</td><td>${escape(x.status)}</td></tr>`).join(''), 'No settled US combos yet.')}
      <h3>Core paper ledger <small>Polymarket entries</small></h3>
      ${table(['Time', 'Kind', 'Quantity', 'Gross', 'Fee', 'Reference'], ledger.map(e => `<tr><td>${when(e.at)}</td><td>${escape(e.kind)}</td><td>${escape(e.quantity)}</td><td>${usd(e.gross)}</td><td>${usd(e.fee)}</td><td>${escape(e.reference)}</td></tr>`).join(''), 'No core ledger entries for Polymarket.')}`;
  }
  function performance() {
    const p = journal?.performance;
    if (!p) return '<p>Loading performance…</p>';
    const ci = p.winRateCi95 ? `${pct(p.winRateCi95.low)}–${pct(p.winRateCi95.high)}` : '—';
    const tile = (label, value, cls = '') => `<div class="pm-tile"><small>${escape(label)}</small><b class="${cls}">${value}</b></div>`;
    if (window.MPOViz) {
      MPOViz.set('pm-perf-curve', 'lines', { series: [{ label: 'net P/L', color: '#ffb000', points: p.curve }], unit: '$', empty: 'Cumulative P/L appears once combos settle' });
      MPOViz.set('pm-perf-cal', 'scatter', { lo: 0.5, hi: 1, points: p.calibration.map(c => ({ x: c.implied, y: c.winRate, n: c.n })), empty: 'Calibration fills in as combos settle' });
    }
    return `<div class="core-heading"><h2>PERFORMANCE</h2><span class="mpo-badge">US COMBOS · SETTLED ONLY</span></div>
      ${p.sampleNote ? `<p class="core-notice">${escape(p.sampleNote)}</p>` : ''}
      <div class="pm-tiles">${tile('Net P/L', usd(p.netPnlUsd), tone(p.netPnlUsd))}${tile('ROI on cost', p.roiPct === null ? '—' : p.roiPct.toFixed(1) + '%', tone(p.roiPct))}${tile('Settled / placed', `${p.settled} / ${p.placed}`)}${tile('Won / lost', `${p.won} / ${p.lost}`)}
        ${tile('Win rate', pct(p.winRate))}${tile('95% interval', ci)}${tile('Avg implied', pct(p.avgImplied))}${tile('Realized − implied', p.edge === null ? '—' : (p.edge * 100).toFixed(1) + ' pts', tone(p.edge))}
        ${tile('Open', `${p.open} (${p.unverifiedOpen} unverified)`)}${tile('Open cost', usd(p.openCostUsd))}</div>
      ${window.MPOViz ? `<div class="mpo-viz-grid">${MPOViz.canvas('pm-perf-curve', 130, 'cumulative net P/L')}${MPOViz.canvas('pm-perf-cal', 130, 'won vs implied (fill price)')}</div>` : ''}
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
    if (busy || (!force && Date.now() - lastFetch < 10000) || !IDS.some(visible)) return;
    busy = true; lastFetch = Date.now();
    try {
      const [j, c] = await Promise.all([fetch('/api/polymarket-us/combos/journal', { cache: 'no-store' }), fetch('/api/platform/status', { cache: 'no-store' })]);
      if (!j.ok) throw new Error(`Combo journal unavailable (HTTP ${j.status})`);
      journal = await j.json(); core = c.ok ? await c.json() : null; error = journal.recoveryRequired ? journal.recoveryError || 'Combo journal needs recovery' : '';
    } catch (e) { error = e.message; }
    finally { busy = false; stamp++; IDS.forEach(draw); }
  }
  function render() { IDS.forEach(draw); refresh(); }
  setInterval(() => { if (!document.hidden) refresh(); }, 10000);
  window.MPOPolymarket = { render, refresh: () => refresh(true) };
})();
