// Sports window: canonical SportsEvents across Kalshi and Polymarket with official live state.
(() => {
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = v => v ? new Date(v).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const pc = v => v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%';
  const FILTERS = { ALL: () => true, MLB: e => e.family === 'MLB', NFL: e => e.family === 'NFL', NCAA: e => e.family === 'NCAA', BASKETBALL: e => ['NBA', 'WNBA'].includes(e.family), NHL: e => e.family === 'NHL', SOCCER: e => e.family === 'SOCCER', TENNIS: e => ['ATP', 'WTA'].includes(e.family), 'TABLE TENNIS': e => e.family === 'TABLE_TENNIS', ESPORTS: e => e.family === 'ESPORTS', UFC: e => e.family === 'UFC' };
  let data = null, error = '', busy = false, stamp = 0, drawn = '', lastFetch = 0, filter = 'ALL', cross = false, liveOnly = false, fast = false;
  const api = async p => { const r = await fetch('/api/platform' + p, { cache: 'no-store' }); const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
  const table = (head, rows, empty) => `<div class="core-table-wrap"><table class="table"><thead><tr>${head.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}">${escape(empty)}</td></tr>`}</tbody></table></div>`;
  const price = v => `${v.kalshi !== undefined ? `K ${pc(v.kalshi)}` : ''}${v.polymarket !== undefined ? ` · P ${pc(v.polymarket)}` : v.polymarketComplement !== undefined ? ` · P ${pc(v.polymarketComplement)}*` : ''}` || '—';
  function view() {
    if (!data) return busy ? '<p>Loading sports markets and live feeds…</p>' : '<p>Loading…</p>';
    const rows = data.events.filter(FILTERS[filter]).filter(e => !cross || e.venues.length > 1).filter(e => !liveOnly || e.live).filter(e => !fast || e.fastSettling);
    return `<div class="core-heading"><h2>SPORTS</h2><span class="mpo-badge">ONE EVENT · MANY MARKETS</span></div>
      <p class="core-muted">${escape(data.note)}</p>
      <p class="core-muted">Feeds: ${data.feeds.map(f => `${escape(f.sport)} ${escape(f.status)}${f.games !== undefined ? ` (${f.games})` : ''}${f.error ? ' — ' + escape(f.error) : ''}`).join(' · ')} · ${data.loaded} contracts → ${data.events.length} events · ${when(data.at)}</p>
      ${data.errors.length ? `<details><summary>${data.errors.length} load issue(s)</summary><p class="core-muted">${data.errors.map(escape).join('<br>')}</p></details>` : ''}
      <div class="core-toolbar">${Object.keys(FILTERS).map(f => `<button class="btn ${f === filter ? 'on' : ''}" type="button" data-sp-filter="${f}">${f}</button>`).join('')}</div>
      <div class="core-toolbar"><label class="inline"><input type="checkbox" data-sp-toggle="cross" ${cross ? 'checked' : ''}> Both venues</label><label class="inline"><input type="checkbox" data-sp-toggle="live" ${liveOnly ? 'checked' : ''}> Live state</label><label class="inline"><input type="checkbox" data-sp-toggle="fast" ${fast ? 'checked' : ''}> Fast-settling (tennis, table tennis)</label></div>
      ${table(['Sport', 'Day', 'Participants', 'Live', 'Winner: first', 'Winner: second', 'Venue gap', 'Markets'], rows.slice(0, 300).map(e => {
        const w = e.winner || [], a = w[0]?.venues || {}, b = w[1]?.venues || {}, gap = a.kalshi !== undefined && a.polymarket !== undefined ? Math.abs(a.kalshi - a.polymarket) : b.kalshi !== undefined && (b.polymarket ?? b.polymarketComplement) !== undefined ? Math.abs(b.kalshi - (b.polymarket ?? b.polymarketComplement)) : null;
        const live = e.live ? `${escape(e.live.state)}${e.live.score?.[0] !== null && e.live.score?.[0] !== undefined ? ` ${e.live.orientation === 'SWAPPED' ? e.live.score[1] + '–' + e.live.score[0] : e.live.score[0] + '–' + e.live.score[1]}` : ''}${e.live.period ? ` · ${escape(e.live.period)}` : ''}` : '<small>no feed</small>';
        return `<tr><td>${escape(e.sport)}${e.fastSettling ? ' <span class="mpo-badge">FAST</span>' : ''}</td><td>${escape(e.day)}</td><td><b>${escape(e.participants[0])}</b> vs <b>${escape(e.participants[1])}</b></td><td>${live}</td><td>${price(a)}</td><td>${price(b)}</td><td>${gap === null ? '—' : (gap * 100).toFixed(1) + ' pts'}</td><td><small>${e.contracts.length} (${escape(e.venues.join(', '))})</small></td></tr>`;
      }).join(''), 'No events in this filter.')}
      <p class="core-muted">K = Kalshi, P = Polymarket listing mids. * = Polymarket price of the other named outcome, shown as its complement. A venue gap is not an arbitrage: check terms and depth in Arbitrage.</p>`;
  }
  const win = () => document.querySelector('.window[data-app="command"]');
  const root = () => document.getElementById('body-sports');
  const visible = () => { const w = win(), r = root(); return !!(w && r && r.classList.contains('on') && !w.classList.contains('hidden') && !w.classList.contains('glance')); };
  function draw(force = false) { const r = root(); if (!visible() || (!force && drawn === r.id + ':' + stamp)) return; drawn = r.id + ':' + stamp; const top = r.scrollTop; r.innerHTML = `<div class="core-app sports-app">${error ? `<p class="core-error" role="alert">${escape(error)}</p>` : ''}${view()}</div>`; r.scrollTop = top; }
  async function refresh() { if (busy || !visible() || Date.now() - lastFetch < 60000) return; busy = true; lastFetch = Date.now(); stamp++; draw(true); try { data = await api('/sports'); error = ''; } catch (e) { error = e.message; lastFetch = 0; } finally { busy = false; stamp++; draw(true); } }
  document.addEventListener('click', e => { const b = e.target.closest('[data-sp-filter]'); if (!b || !root()?.contains(b)) return; filter = b.dataset.spFilter; stamp++; draw(true); });
  document.addEventListener('change', e => { const t = e.target.closest('[data-sp-toggle]'); if (!t || !root()?.contains(t)) return; if (t.dataset.spToggle === 'cross') cross = t.checked; if (t.dataset.spToggle === 'live') liveOnly = t.checked; if (t.dataset.spToggle === 'fast') fast = t.checked; stamp++; draw(true); });
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  window.MPOSports = { render() { draw(); refresh(); } };
})();
