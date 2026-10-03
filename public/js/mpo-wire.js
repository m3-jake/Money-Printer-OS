// Wire window: MPOS's live event terminal (src/core/wire.js). Titles, times and links are source
// facts; entities, related markets, "my positions" and importance are rule-based analysis.
(() => {
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = v => { if (!v) return '—'; const d = new Date(v), s = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); return v > Date.now() ? 'in ' + s : s; };
  let data = null, error = '', busy = false, stamp = 0, drawn = '', lastFetch = 0, filter = 'ALL', sort = 'time', q = '';
  const api = async p => { const r = await fetch('/api/platform' + p, { cache: 'no-store' }); const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
  function view() {
    if (!data) return busy ? '<p>Loading the wire…</p>' : '<p>Loading…</p>';
    let items = data.items.filter(i => filter === 'ALL' || i.categories.includes(filter));
    if (q) { const s = q.toLowerCase(); items = items.filter(i => `${i.title} ${i.source} ${(i.entities || []).map(e => e.label).join(' ')}`.toLowerCase().includes(s)); }
    if (sort === 'importance') items = [...items].sort((a, b) => b.importance - a.importance || b.at - a.at);
    return `<div class="core-heading"><h2>WIRE</h2><span class="mpo-badge">LIVE EVENT TERMINAL</span></div>
      <p class="core-muted">${escape(data.note)}</p>
      <p class="core-muted">Feeds: ${data.feeds.map(f => `${escape(f.label)} <b>${escape(f.status)}</b>${f.error ? ' (' + escape(f.error) + ')' : ''}`).join(' · ')}. Filings, weather, sports and the macro calendar appear once their windows have loaded them.</p>
      <div class="core-toolbar">${data.filters.map(f => `<button class="btn ${f === filter ? 'on' : ''}" type="button" data-wire-filter="${f}">${f} <small>${data.counts[f] ?? 0}</small></button>`).join('')}</div>
      <div class="core-toolbar"><label>Search<input data-wire-q value="${escape(q)}" placeholder="ticker, team, topic"></label><label>Sort<select data-wire-sort><option value="time" ${sort === 'time' ? 'selected' : ''}>Newest</option><option value="importance" ${sort === 'importance' ? 'selected' : ''}>Importance</option></select></label></div>
      <div class="wire-list">${items.slice(0, 200).map(i => `<article class="wire-item ${i.myPositions ? 'mine' : ''}">
        <div class="wire-meta"><span class="wire-imp" title="Importance ${i.importance} (rule-based)" style="--imp:${i.importance}%"></span><b>${escape(i.kind)}</b> · ${escape(i.source)} · ${when(i.at)}${i.myPositions ? ' · <span class="mpo-badge">MY POSITIONS</span>' : ''}</div>
        <div class="wire-title">${i.url ? `<a href="${escape(i.url)}" target="_blank" rel="noreferrer">${escape(i.title)}</a>` : escape(i.title)}</div>
        ${(i.entities || []).length ? `<div class="wire-ents">${i.entities.slice(0, 8).map(e => `<span>${escape(e.type)}: ${escape(e.label)}</span>`).join('')}</div>` : ''}
        ${(i.relatedMarkets || []).length ? `<div class="wire-rel"><small>Related markets: ${i.relatedMarkets.slice(0, 4).map(m => escape(`${m.venue}: ${m.title}`)).join(' · ')}</small></div>` : ''}
      </article>`).join('') || '<p>No items in this view.</p>'}</div>`;
  }
  const win = () => document.querySelector('.window[data-app="command"]');
  const root = () => document.getElementById('body-wire');
  const visible = () => { const w = win(), r = root(); return !!(w && r && r.classList.contains('on') && !w.classList.contains('hidden') && !w.classList.contains('glance')); };
  function draw(force = false) { const r = root(); if (!visible() || (!force && drawn === r.id + ':' + stamp)) return; if (!force && r.contains(document.activeElement) && document.activeElement.matches('input,select')) return; drawn = r.id + ':' + stamp; const top = r.scrollTop; r.innerHTML = `<div class="core-app wire-app">${error ? `<p class="core-error" role="alert">${escape(error)}</p>` : ''}${view()}</div>`; r.scrollTop = top; }
  async function refresh() { if (busy || !(visible() || window.MPOProgramVisible?.('wire')) || Date.now() - lastFetch < 30000) return; busy = true; lastFetch = Date.now(); stamp++; draw(true); try { data = await api('/wire'); error = ''; } catch (e) { error = e.message; lastFetch = 0; } finally { busy = false; stamp++; draw(); } }
  document.addEventListener('click', e => { const b = e.target.closest('[data-wire-filter]'); if (!b || !root()?.contains(b)) return; filter = b.dataset.wireFilter; stamp++; draw(true); });
  document.addEventListener('change', e => { if (!root()?.contains(e.target)) return; if (e.target.matches('[data-wire-sort]')) { sort = e.target.value; stamp++; draw(true); } });
  document.addEventListener('input', e => { if (!root()?.contains(e.target) || !e.target.matches('[data-wire-q]')) return; q = e.target.value; const pos = e.target.selectionStart; stamp++; draw(true); const el = root().querySelector('[data-wire-q]'); if (el) { el.focus(); el.setSelectionRange(pos, pos); } });
  setInterval(() => { if (!document.hidden) refresh(); }, 10000);
  // Simple view: what moved in the last hour, the most important items, feed health.
  function glanceCard() {
    if (!data) return glance({ title: 'Wire · live event terminal', pill: { label: error ? 'Unavailable' : 'Loading', tone: error ? 'bad' : 'warn' }, hero: null, visual: `<div class="g-empty">${escape(error || 'Loading the wire…')}</div>` });
    const items = data.items || [], hour = items.filter(i => Date.now() - i.at < 3600e3), hot = items.filter(i => i.importance >= 70), feeds = data.feeds || [], ok = feeds.filter(f => /ok|live|connected/i.test(String(f.status))).length;
    const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'now' : m < 90 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
    const top = items.slice().sort((a, b) => b.importance - a.importance || b.at - a.at).slice(0, 10);
    return glance({ title: 'Wire · live event terminal', pill: ok === feeds.length ? { label: 'All feeds up', tone: 'ok' } : { label: `${feeds.length - ok} feed${feeds.length - ok === 1 ? '' : 's'} down`, tone: 'warn' },
      hero: String(hour.length), heroUnit: 'items / hour', heroSub: items[0] ? 'Newest: ' + escape(items[0].title).slice(0, 90) : 'No items yet',
      stats: [{ label: 'Items', value: String(items.length) }, { label: 'High importance', value: String(hot.length), tone: hot.length ? 'g-pos' : '' }, { label: 'Feeds up', value: `${ok}/${feeds.length}` }],
      visual: `<div class="g-rows g-scroll">${top.map(i => gRow(i.title, `${i.source} · ${ago(i.at)}`, String(i.importance), i.importance >= 70 ? 'warn' : 'ok')).join('') || '<div class="g-empty">Quiet wire.</div>'}</div>`,
      foot: gFoot(['most important first', 'importance is rule-based', 'Advanced: search, filters, related markets']) });
  }
  globalThis.addEventListener?.('DOMContentLoaded', () => window.MPOProgramGlance?.register('wire', { render: glanceCard, sig: () => [stamp, error, busy] }));
  window.MPOWire = { render() { draw(); refresh(); } };
})();
