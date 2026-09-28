// Weather window: NWS forecast highs vs Kalshi daily-high markets, severe alerts, tropical systems.
(() => {
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = v => v ? new Date(v).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const deg = v => v === null || v === undefined ? '—' : `${v}°F`;
  const tone = v => Number(v) > 0 ? 'pm-up' : Number(v) < 0 ? 'pm-down' : '';
  let data = null, error = '', busy = false, stamp = 0, drawn = '', lastFetch = 0, filter = 'ALL';
  const api = async p => { const r = await fetch('/api/platform' + p, { cache: 'no-store' }); const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
  const table = (head, rows, empty) => `<div class="core-table-wrap"><table class="table"><thead><tr>${head.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}">${escape(empty)}</td></tr>`}</tbody></table></div>`;
  const bucketLabel = b => b.hi === null || b.hi === Infinity || b.hi === undefined ? `${b.lo}+` : b.lo === null || b.lo === -Infinity || b.lo === undefined ? `≤${b.hi}` : b.lo === b.hi ? `${b.lo}` : `${b.lo}–${b.hi}`;
  function view() {
    if (!data) return busy ? '<p>Loading NWS, NHC and Kalshi…</p>' : '<p>Loading…</p>';
    const rows = data.cities.flatMap(c => c.markets.length ? c.markets.map(m => ({ c, m })) : [{ c, m: null }]);
    const alerts = data.alerts.filter(a => filter === 'ALL' || (filter === 'HEAT' && /heat/i.test(a.event)) || (filter === 'FLOOD' && /flood/i.test(a.event)) || (filter === 'TROPICAL' && /tropical|hurricane|storm surge/i.test(a.event)) || (filter === 'WINTER' && /winter|blizzard|ice|cold|freeze/i.test(a.event)) || (filter === 'FIRE' && /fire|red flag/i.test(a.event)));
    return `<div class="core-heading"><h2>WEATHER</h2><span class="mpo-badge">NWS · NHC · KALSHI</span></div>
      <p class="core-notice">${escape(data.note)}</p>
      <h3>Daily highs: NWS forecast vs Kalshi market</h3>
      ${table(['City', 'Date', 'NWS forecast high', 'Market median bucket', 'Market expected', 'Forecast − market', 'Kalshi closes', 'Distribution'], rows.map(({ c, m }) => m ? `<tr><td><b>${escape(c.label)}</b></td><td>${escape(m.date || '—')}</td><td>${deg(m.nwsHigh)}</td><td>${escape(m.medianBucket || '—')}</td><td>${deg(m.expectedHigh)}</td><td class="${tone(m.gap)}">${m.gap === null ? '—' : (m.gap > 0 ? '+' : '') + m.gap + '°'}</td><td>${when(m.closeAt)}</td><td><div class="wx-dist">${m.buckets.map(b => `<i title="${escape(bucketLabel(b))}°F: ${(b.p * 100).toFixed(0)}%" style="--p:${Math.min(100, b.p * 100).toFixed(0)}%"></i>`).join('')}</div><small>Σ mids ${m.sumOfMids}</small></td></tr>`
        : `<tr><td><b>${escape(c.label)}</b></td><td colspan="7"><small>${escape(c.marketError || c.forecastError || 'No open Kalshi event')}</small></td></tr>`).join(''), 'No cities.')}
      <p class="core-muted">A large forecast − market gap is a question, not a signal: the market may know about station quirks, model updates or the settlement source that the NWS point forecast does not.</p>
      <h3>Tropical systems <small>NHC</small></h3>
      ${data.stormsError ? `<p class="core-error">${escape(data.stormsError)}</p>` : table(['Storm', 'Class', 'Wind (kt)', 'Pressure (mb)', 'Position', 'Updated', 'Possible exposure (speculative)'], data.storms.map(s => `<tr><td><b>${escape(s.name)}</b> <small>${escape(s.id)}</small></td><td>${escape(s.classification)}</td><td>${s.intensityKt ?? '—'}</td><td>${s.pressureMb ?? '—'}</td><td>${s.lat ?? '?'}, ${s.lon ?? '?'}</td><td>${when(s.updated)}</td><td><small>${escape(s.analysis.sectors.join(', '))}${s.analysis.markets.length ? ' · ' + escape(s.analysis.markets.map(m => m.title).join('; ')) : ''}</small></td></tr>`).join(''), 'No active tropical systems.')}
      <h3>Severe and extreme alerts <small>NWS, ${data.alerts.length} active</small></h3>
      <div class="core-toolbar">${['ALL', 'HEAT', 'FLOOD', 'TROPICAL', 'WINTER', 'FIRE'].map(f => `<button class="btn ${f === filter ? 'on' : ''}" type="button" data-wx-filter="${f}">${f}</button>`).join('')}</div>
      ${data.alertsError ? `<p class="core-error">${escape(data.alertsError)}</p>` : table(['Sent', 'Event', 'Severity', 'Area', 'Expires', 'Possible exposure (speculative)'], alerts.slice(0, 60).map(a => `<tr><td>${when(a.sent)}</td><td><b>${escape(a.event)}</b></td><td>${escape(a.severity)} / ${escape(a.urgency || '')}</td><td><small>${escape(String(a.area || '').slice(0, 140))}</small></td><td>${when(a.expires)}</td><td><small>${escape(a.analysis.sectors.join(', ')) || '—'}</small></td></tr>`).join(''), 'No alerts in this filter.')}
      <p class="core-muted">NWS ${escape(data.nws.status)} · loaded ${when(data.at)} · refreshes every 10 minutes while open.</p>`;
  }
  const win = () => document.querySelector('.window[data-app="command"]');
  const root = () => document.getElementById('body-weather');
  const visible = () => { const w = win(), r = root(); return !!(w && r && r.classList.contains('on') && !w.classList.contains('hidden') && !w.classList.contains('glance')); };
  function draw(force = false) { const r = root(); if (!visible() || (!force && drawn === r.id + ':' + stamp)) return; drawn = r.id + ':' + stamp; const top = r.scrollTop; r.innerHTML = `<div class="core-app wx-app">${error ? `<p class="core-error" role="alert">${escape(error)}</p>` : ''}${view()}</div>`; r.scrollTop = top; }
  async function refresh() { if (busy || !visible() || Date.now() - lastFetch < 600000) return; busy = true; lastFetch = Date.now(); stamp++; draw(true); try { data = await api('/weather'); error = ''; } catch (e) { error = e.message; lastFetch = 0; } finally { busy = false; stamp++; draw(true); } }
  document.addEventListener('click', e => { const b = e.target.closest('[data-wx-filter]'); if (!b || !root()?.contains(b)) return; filter = b.dataset.wxFilter; stamp++; draw(true); });
  window.MPOWeather = { render() { draw(); refresh(); } };
})();
