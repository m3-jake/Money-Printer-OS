// Market Lab: historical replay and sequential backtests (src/core/replay.js). Data is revealed by the
// time it became available, never by the period it describes, so strategies cannot see the future.
// Every run is stored as a reproducible experiment (dataset fingerprint, code version, machine).
(() => {
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = v => v ? new Date(v).toLocaleString() : '—';
  const pctv = v => v === null || v === undefined ? '—' : Number(v).toFixed(2) + '%';
  const tone = v => Number(v) > 0 ? 'pm-up' : Number(v) < 0 ? 'pm-down' : '';
  const localInput = ms => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
  let wf = null, strategies = [], sources = null, runs = [], result = null, replay = null, error = '', busy = false, stamp = 0, drawn = '', form = { source: 'tape', key: '', start: null, minutes: 60, strategy: 'momentum', lookback: 20, thresholdBps: 10, stepMs: 15000, feeBps: 10, cash: 1000 }, timer = null, speed = 60, loadAfter = 0;

  const api = async (p, body) => { const r = await fetch('/api/platform' + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) } : { cache: 'no-store', signal: AbortSignal.timeout(10000) }); const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
  const table = (head, rows, empty) => `<div class="core-table-wrap"><table class="table"><thead><tr>${head.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}">${escape(empty)}</td></tr>`}</tbody></table></div>`;
  const btn = (a, label, attrs = '') => `<button class="btn" type="button" data-lab="${a}" ${attrs}>${escape(label)}</button>`;
  const keysFor = src => src === 'tape' ? (sources?.tape || []) : src === 'book' ? (sources?.books || []) : [];
  const tile = (label, value, cls = '') => `<div class="pm-tile"><small>${escape(label)}</small><b class="${cls}">${value}</b></div>`;

  function view() {
    if (!sources) return '<p>Loading data sources…</p>';
    const keys = keysFor(form.source), sel = keys.find(k => k.key === form.key) || keys[0];
    if (sel && !form.key) form.key = sel.key;
    if (sel && !form.start) form.start = Math.max(sel.first, sel.last - form.minutes * 60000);
    const st = sources.strategies[form.strategy]?.params || {};
    return `<div class="core-heading"><h2>MARKET LAB</h2><span class="mpo-badge">REPLAY · NO LOOK-AHEAD</span></div>
      <p class="core-muted">Records are revealed in the order they became available. Candle-derived samples appear only after their minute closes and are counted as synthetic. Orders fill on the next quote after the decision (ask to buy, bid to sell).</p>
      <form data-lab-form="run" class="core-toolbar">
        <label>Source<select name="source">${[['tape', 'Recorded crypto tape'], ['book', 'Recorded order books (Kalshi / Polymarket)'], ['alpaca', 'Alpaca minute bars (stocks)']].map(([v, l]) => `<option value="${v}" ${form.source === v ? 'selected' : ''} ${v === 'alpaca' && !sources.alpaca.configured ? 'disabled' : ''}>${l}</option>`).join('')}</select></label>
        <label>Instrument${form.source === 'alpaca' ? `<input name="key" value="${escape(form.key || 'AAPL')}" maxlength="8">` : `<select name="key">${keys.map(k => `<option value="${escape(k.key)}" ${k.key === form.key ? 'selected' : ''}>${escape(k.key)} (${k.records})</option>`).join('') || '<option value="">No recorded data</option>'}</select>`}</label>
        <label>Start<input name="start" type="datetime-local" value="${form.start ? localInput(form.start) : ''}" required></label>
        <label>Minutes<input name="minutes" type="number" min="1" max="10080" value="${form.minutes}"></label>
        <label>Strategy<select name="strategy">${Object.entries(sources.strategies).map(([k, v]) => `<option value="${k}" ${k === form.strategy ? 'selected' : ''}>${escape(v.label)}</option>`).join('')}</select></label>
        ${'lookback' in st ? `<label>Lookback<input name="lookback" type="number" min="1" max="1000" value="${form.lookback}"></label><label>Threshold bps<input name="thresholdBps" type="number" min="1" max="1000" value="${form.thresholdBps}"></label>` : ''}
        <label>Step s<input name="stepSec" type="number" min="1" max="3600" value="${form.stepMs / 1000}"></label>
        <label>Fee bps<input name="feeBps" type="number" min="0" max="1000" value="${form.feeBps}"></label>
        <label>Cash<input name="cash" type="number" min="1" value="${form.cash}"></label>
        <button class="btn" type="submit" name="mode" value="run">Run backtest</button>${btn('replay', 'Start replay')}</form>
      ${sel ? `<p class="core-muted">${escape(sel.key)}: ${sel.records} records, ${when(sel.first)} → ${when(sel.last)}${sel.syntheticShare !== undefined && sel.syntheticShare !== null ? ` · ${(sel.syntheticShare * 100).toFixed(0)}% synthetic` : ''}</p>` : `<p class="core-notice">${form.source === 'alpaca' ? escape(sources.alpaca.note) : 'No recorded data for this source yet. The crypto tape fills while the Robinhood loops run; order books are stored when you inspect markets.'}</p>`}
      ${replay ? `<h3>Replay <small>${escape(replay.key)} · clock ${when(replay.clock)} · ${replay.revealed}/${replay.total} revealed${replay.done ? ' · finished' : ''}</small></h3>
        <div class="core-toolbar">${btn(timer ? 'pause' : 'play', timer ? 'Pause' : 'Play')}${btn('step', 'Step')}<label>Speed<select data-lab-speed>${[10, 60, 300, 1800].map(x => `<option value="${x}" ${x === speed ? 'selected' : ''}>${x}×</option>`).join('')}</select></label>${btn('close-replay', 'Close')}</div>
        ${window.MPOViz ? MPOViz.canvas('lab-replay', 130, 'mid price as revealed') : ''}` : ''}
      ${result ? `<h3>Result <small>${escape(result.strategy)} · ${escape(result.key)} · run ${escape(result.id.slice(0, 8))}</small></h3>
        <div class="pm-tiles">${tile('Return', pctv(result.returnPct), tone(result.returnPct))}${tile('Buy & hold', pctv(result.buyHoldPct), tone(result.buyHoldPct))}${tile('Max drawdown', pctv(result.maxDrawdownPct))}${tile('Trades', result.trades.length)}${tile('Records', result.records)}${tile('Synthetic share', result.syntheticShare === null ? '—' : (result.syntheticShare * 100).toFixed(0) + '%')}${tile('Look-ahead violations', result.lookAheadViolations, result.lookAheadViolations ? 'pm-down' : 'pm-up')}${tile('Dataset', escape(result.datasetFp.slice(0, 10)))}</div>
        ${window.MPOViz ? `<div class="mpo-viz-grid">${MPOViz.canvas('lab-equity', 120, 'equity')}${MPOViz.canvas('lab-price', 120, 'mid price')}</div>` : ''}
        ${result.syntheticShare > 0.1 ? `<p class="core-notice">${(result.syntheticShare * 100).toFixed(0)}% of this window is candle-derived (no real spread). Treat fills as optimistic.</p>` : ''}
        <p class="core-muted">Code ${escape(result.codeVersion)} · machine ${escape(result.machine)} · deterministic (no random seed)</p>` : ''}
      <h3>Walk-forward validation <small>Parameters chosen on the previous fold only; judged on the next</small></h3>
      <form data-lab-form="wf" class="core-toolbar"><label>Folds<input name="folds" type="number" min="2" max="12" value="4"></label><label>Lookbacks<input name="lookbacks" value="10,20,40" placeholder="10,20,40"></label><label>Thresholds bps<input name="thresholds" value="5,10,20"></label><label>Seed<input name="seed" type="number" min="1" value="1"></label>
        <label>Attach evidence to<select name="strategyId"><option value="">(don't attach)</option>${strategies.filter(s => s.state !== 'RETIRED').map(s => `<option value="${escape(s.id)}">${escape(s.name)} · ${escape(s.state)}</option>`).join('')}</select></label><button class="btn" type="submit">Run walk-forward</button></form>
      <p class="core-muted">Uses the source, window, strategy, step and fee above. Buy-and-hold has no parameters to choose.</p>
      ${wf ? `<div class="pm-tiles">${tile('Out-of-sample net', pctv(wf.evidence.outOfSampleNetPct), tone(wf.evidence.outOfSampleNetPct))}${tile('Positive folds', wf.evidence.positiveFoldShare === null ? '—' : (wf.evidence.positiveFoldShare * 100).toFixed(0) + '%')}${tile('Test trades', wf.evidence.sampleSize)}${tile('Worst fold DD', pctv(wf.evidence.maxDrawdownPct))}${tile('MC p5 / p50 / p95', wf.monteCarlo.runs ? `${wf.monteCarlo.p5} / ${wf.monteCarlo.p50} / ${wf.monteCarlo.p95}%` : '—')}${tile('MC P(loss)', wf.monteCarlo.runs ? (wf.monteCarlo.probLoss * 100).toFixed(0) + '%' : '—')}${tile('Look-ahead violations', wf.evidence.lookAheadViolations, wf.evidence.lookAheadViolations ? 'pm-down' : 'pm-up')}</div>
        ${table(['Fold', 'Chosen on train', 'Train return', 'Test return', 'Test B&H', 'Test trades', 'Test DD'], wf.folds.map(f => `<tr><td>${f.fold}</td><td><small>${escape(JSON.stringify(f.train.params))}</small></td><td>${pctv(f.train.returnPct)}</td><td class="${tone(f.test.returnPct)}">${pctv(f.test.returnPct)}</td><td>${pctv(f.test.buyHoldPct)}</td><td>${f.test.trades}</td><td>${pctv(f.test.maxDrawdownPct)}</td></tr>`).join(''), 'No folds.')}
        <p class="core-muted">Promotion gate preview — PAPER: ${wf.checks.PAPER.allowed ? 'passes' : escape(wf.checks.PAPER.blockers.join(', '))} · CANDIDATE: ${wf.checks.CANDIDATE.allowed ? 'passes' : escape(wf.checks.CANDIDATE.blockers.join(', '))}${wf.attached ? ` · Evidence attached to <b>${escape(wf.attached.name)}</b> (${escape(wf.attached.state)}); promote it from Command Center when the gate passes.` : ''}</p>
        <p class="core-muted">Run ${escape(wf.id.slice(0, 8))} · dataset ${escape(wf.datasetFp.slice(0, 10))} · seed ${wf.seed} · ${escape(wf.evidence.method)}</p>` : ''}
      <h3>Experiment history <small>Append-only; same dataset + parameters + code reproduce the same result</small></h3>
      ${table(['Time', 'Source', 'Instrument', 'Strategy', 'Params', 'Records', 'Return', 'B&H', 'Max DD', 'Dataset', 'Code'], runs.slice(0,80).map(r => `<tr><td>${when(r.at)}</td><td>${escape(r.source)}</td><td>${escape(r.key)}</td><td>${escape(r.strategy)}</td><td><small>${escape(JSON.stringify(r.params))}</small></td><td>${r.records}</td><td class="${tone(r.result.returnPct)}">${pctv(r.result.returnPct)}</td><td>${pctv(r.result.buyHoldPct)}</td><td>${pctv(r.result.maxDrawdownPct)}</td><td>${escape(r.dataset_fp.slice(0, 10))}</td><td><small>${escape(r.code_version)}</small></td></tr>`).join(''), 'No runs yet.')}`;
  }
  const win = () => document.querySelector('.window[data-app="command"]');
  const root = () => document.getElementById('body-marketlab');
  const visible = () => { const w = win(), r = root(); return !!(w && r && r.classList.contains('on') && !w.classList.contains('hidden') && !w.classList.contains('glance')); };
  function draw(force = false) {
    const r = root(); if (!visible() || (!force && drawn === r.id + ':' + stamp)) return;
    if (!force && r.contains(document.activeElement) && document.activeElement.matches('input,select,textarea')) return;
    drawn = r.id + ':' + stamp; const top = r.scrollTop;
    r.innerHTML = `<div class="core-app lab-app">${error ? `<p class="core-error" role="alert">${escape(error)}</p>` : ''}${busy ? '<p role="status">Working…</p>' : ''}${view()}</div>`;
    if (window.MPOViz && result) { MPOViz.set('lab-equity', 'lines', { series: [{ label: 'equity', color: '#ffb000', points: result.curve.map(c => c.equity) }], unit: '$', zero: false }); MPOViz.set('lab-price', 'lines', { series: [{ label: 'mid', color: '#7fd3ff', points: result.curve.filter(c => c.mid !== null).map(c => c.mid) }], zero: false }); }
    if (window.MPOViz && replay) MPOViz.set('lab-replay', 'lines', { series: [{ label: replay.key, color: '#7fe39a', points: replay.mids.slice(-600) }], empty: 'Nothing revealed yet', zero: false });
    r.scrollTop = top;
  }
  async function load() { try { const [s, h, st] = await Promise.all([api('/lab/sources'), api('/lab/runs'), api('/strategies')]); sources = s; runs = h.runs; strategies = st.strategies || []; error = ''; loadAfter = 0; } catch (e) { error = e.message; loadAfter = Date.now() + 30000; } stamp++; draw(); }
  async function act(fn) { if (busy) return; busy = true; error = ''; stamp++; draw(true); try { await fn(); } catch (e) { error = e.message; } finally { busy = false; stamp++; draw(true); } }
  const readForm = () => { const f = root()?.querySelector('[data-lab-form=run]'); if (!f) return; const i = Object.fromEntries(new FormData(f)); Object.assign(form, { source: i.source, key: i.key, strategy: i.strategy, minutes: Number(i.minutes) || 60, feeBps: Number(i.feeBps) || 0, cash: Number(i.cash) || 1000, stepMs: (Number(i.stepSec) || 15) * 1000, start: i.start ? new Date(i.start).getTime() : form.start }); if (i.lookback) form.lookback = Number(i.lookback); if (i.thresholdBps) form.thresholdBps = Number(i.thresholdBps); };
  const query = () => ({ source: form.source, key: form.key, start: form.start, end: form.start + form.minutes * 60000 });
  const stopTimer = () => { if (timer) clearInterval(timer); timer = null; };
  let stepping=false;
  async function step(ms) { if (!replay||stepping) return;const id=replay.id;stepping=true;try{ const r = await api('/lab/replay/step', { id, ms });if(!replay||replay.id!==id)return; const res = r.result; replay = { ...replay, clock: res.clock, revealed: res.revealed, done: res.done, mids: replay.mids.concat(res.fresh.map(x => (x.bid + x.ask) / 2)) }; if (res.done) stopTimer(); stamp++; draw(true); }finally{stepping=false} }
  window.addEventListener('mpo:window-close',e=>{if(e.detail?.id==='command'){stopTimer();stamp++}});
  window.addEventListener('mpo:tab-change',e=>{if(e.detail?.host==='command'&&e.detail?.id!=='marketlab'){stopTimer();stamp++}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stopTimer();stamp++}});
  window.addEventListener('pagehide',stopTimer);

  document.addEventListener('change', e => {
    if (!root()?.contains(e.target)) return;
    if (e.target.matches('[data-lab-speed]')) { speed = Number(e.target.value); return; }
    if (e.target.name === 'source') { readForm(); form.key = ''; form.start = null; stamp++; draw(true); }
    else if (['key', 'strategy'].includes(e.target.name)) { readForm(); if (e.target.name === 'key') form.start = null; stamp++; draw(true); }
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-lab]'); if (!b || !root()?.contains(b)) return;
    const a = b.dataset.lab;
    if (a === 'play') { stopTimer(); timer = setInterval(() => step(speed * 500).catch(err => { error = err.message; stopTimer(); stamp++; draw(true); }), 500); stamp++; draw(true); return; }
    if (a === 'pause') { stopTimer(); stamp++; draw(true); return; }
    if (a === 'close-replay') { stopTimer(); replay = null; stamp++; draw(true); return; }
    act(async () => {
      if (a === 'replay') { readForm(); stopTimer(); const r = (await api('/lab/replay/start', query())).result; replay = { ...r, revealed: r.visible.length, mids: r.visible.map(x => (x.bid + x.ask) / 2) }; }
      else if (a === 'step') await step(form.stepMs);
    });
  });
  document.addEventListener('submit', e => {
    const f = e.target.closest('[data-lab-form]'); if (!f || !root()?.contains(f)) return; e.preventDefault(); readForm();
    if (f.dataset.labForm === 'wf') {
      const i = Object.fromEntries(new FormData(f)), list = v => String(v || '').split(',').map(x => Number(x.trim())).filter(n => n > 0);
      act(async () => { wf = (await api('/lab/walkforward', { ...query(), strategy: form.strategy, grid: { lookback: list(i.lookbacks), thresholdBps: list(i.thresholds) }, folds: Number(i.folds) || 4, seed: Number(i.seed) || 1, stepMs: form.stepMs, feeBps: form.feeBps, cash: form.cash, strategyId: i.strategyId || null })).result; runs = (await api('/lab/runs')).runs; });
      return;
    }
    act(async () => { result = (await api('/lab/run', { ...query(), strategy: form.strategy, params: { lookback: form.lookback, thresholdBps: form.thresholdBps }, stepMs: form.stepMs, feeBps: form.feeBps, cash: form.cash })).result; runs = (await api('/lab/runs')).runs; });
  });
  // Simple view: what the replay lab holds (recorded tapes and books) and how recent strategy runs did vs buy-and-hold.
  function glanceCard() {
    if (!sources) return glance({ title: 'Market Lab · replay', pill: { label: error ? 'Unavailable' : 'Loading', tone: error ? 'bad' : 'warn' }, hero: null, visual: `<div class="g-empty">${escape(error || 'Loading data sources…')}</div>` });
    const last = runs[0], pct = v => v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
    return glance({ title: 'Market Lab · replay', pill: { label: 'Research only', tone: '' },
      hero: last ? pct(last.result?.returnPct) : String(runs.length), heroUnit: last ? '' : 'runs', heroSub: last ? `last run: ${escape(last.strategy)} on ${escape(last.key)} · buy and hold ${pct(last.result?.buyHoldPct)}` : 'No runs yet: replay a recorded tape in Advanced',
      stats: [{ label: 'Recorded tapes', value: String((sources.tape || []).length) }, { label: 'Order books', value: String((sources.books || []).length) }, { label: 'Strategies', value: String(strategies.length) }],
      visual: `<div class="g-rows g-scroll">${runs.slice(0, 10).map(r => gRow(`${r.strategy} · ${r.key}`, `${r.records} records · buy and hold ${pct(r.result?.buyHoldPct)}`, `<span class="${r.result?.returnPct > 0 ? 'g-pos' : r.result?.returnPct < 0 ? 'g-neg' : ''}">${pct(r.result?.returnPct)}</span>`, r.result?.returnPct > (r.result?.buyHoldPct ?? 0) ? 'ok' : 'warn')).join('') || '<div class="g-empty">No strategy runs yet.</div>'}</div>`,
      foot: gFoot(['replays recorded data only', 'past runs are not forward results']) });
  }
  globalThis.addEventListener?.('DOMContentLoaded', () => window.MPOProgramGlance?.register('marketlab', { render: glanceCard, sig: () => [stamp, error, runs.length] }));
  window.MPOMarketLab = { render() { if (!visible() && window.MPOProgramVisible?.('marketlab') && !sources && !busy && Date.now() >= loadAfter) { busy = true; load().finally(() => { busy = false; stamp++; }); } if (!visible()) return; if (!sources && !busy && Date.now() >= loadAfter) { busy = true; load().finally(() => { busy = false; stamp++; draw(true); }); } draw(); } };
})();
