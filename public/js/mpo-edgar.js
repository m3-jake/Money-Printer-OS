// EDGAR window: SEC filings as declared facts, with MPOS's rule-based analysis shown separately.
(() => {
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = v => v ? new Date(v).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
  let summaries = {}, status = null, list = null, company = null, form4 = {}, error = '', busy = false, stamp = 0, drawn = '', form = '8-K', mode = 'latest', ticker = '';
  const post = async (p, body) => { const r = await fetch('/api/platform' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`); return j.result; };
  // AI summary panel: always labelled, shows the model, and every sentence with the filing passages it cites.
  const aiPanel = s => s.error ? `<div class="edgar-ai"><b>Filing excerpts unavailable:</b> ${escape(s.error)}</div>` : s.status === 'REFUSED' ? `<div class="edgar-ai"><b>AI summary declined</b> (${escape(s.category || 'no category')}). Read the filing directly.</div>`
    : `<details class="edgar-ai" open><summary><span class="mpo-badge">${s.kind==='LOCAL_EXTRACTIVE_SUMMARY'?'LOCAL SOURCE EXCERPTS / ZERO CREDITS':'CACHED AI-GENERATED ANALYSIS'}</span> ${escape(s.model)}${s.cached ? ' · stored' : ''} · ${s.citedShare === null || s.citedShare === undefined ? '' : Math.round(s.citedShare * 100) + '% of claims cited'}${s.status === 'TRUNCATED_OUTPUT' ? ' · <b>output hit its length limit</b>' : ''}</summary>
      ${(s.blocks||[]).map(b => `<span class="${b.citations.length ? 'ai-cited' : 'ai-uncited'}" title="${escape(b.citations.map(c => c.quote).join(' | ').slice(0, 900) || 'no citation')}">${escape(b.text).split(String.fromCharCode(10)).join('<br>')}</span>`).join('<br><br>')}
      <p class="core-muted">${s.kind==='LOCAL_EXTRACTIVE_SUMMARY'?escape(s.scope):'Stored model analysis from the filing text only; no new model call was made. Hover a sentence to inspect its citation. This is not the filing and not advice.'}</p></details>`;
  const api = async p => { const r = await fetch('/api/platform' + p, { cache: 'no-store' }); const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
  const table = (head, rows, empty) => `<div class="core-table-wrap"><table class="table"><thead><tr>${head.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}">${escape(empty)}</td></tr>`}</tbody></table></div>`;
  const row = f => { const x = f.facts, a = f.analysis, f4 = form4[x.accession];
    return `<tr><td>${when(x.acceptedAt)}</td><td><b>${escape(x.form)}</b></td><td>${escape(x.company)}${x.ticker ? ` <small>${escape(x.ticker)}</small>` : ''}</td>
      <td>${x.items.map(i => `<div><small>${escape(i.code)}</small> ${escape(i.name)}</div>`).join('') || '—'}${x.rawXmlUrl ? `<button class="btn" type="button" data-edgar="form4" data-acc="${escape(x.accession)}" data-url="${escape(x.rawXmlUrl)}">Transactions</button>` : ''}
        ${f4 ? `<div class="edgar-f4">${escape(f4.owner || '')} (${escape((f4.roles || []).join(', '))}): ${f4.transactions.map(t => `${escape(t.meaning)} ${t.shares ?? '?'} @ ${t.price ?? '—'} on ${escape(t.date)}`).join('; ') || 'no non-derivative rows'}</div>` : ''}</td>
      <td class="edgar-analysis">${a.catalysts.map(c => `<span class="mpo-badge">${escape(c)}</span>`).join(' ') || '—'}${a.relatedMarkets.length ? `<div><small>Related: ${a.relatedMarkets.map(m => escape(m.venue + ': ' + m.title)).join(' · ')}</small></div>` : ''}</td>
      <td>${x.url ? `<a href="${escape(x.url)}" target="_blank" rel="noreferrer">Filing</a>` : ''} ${x.indexUrl && x.indexUrl !== x.url ? `<a href="${escape(x.indexUrl)}" target="_blank" rel="noreferrer">Index</a>` : ''}${x.url ? `<br><button class="btn" type="button" data-edgar="ai" data-acc="${escape(x.accession)}" title="Cached research or local source excerpts; no model credits">Filing excerpts</button>` : ''}</td></tr>${summaries[x.accession] ? `<tr><td colspan="6">${aiPanel(summaries[x.accession])}</td></tr>` : ''}`; };
  function view() {
    const st = status || {}, rows = mode === 'company' ? company?.filings : list?.filings;
    return `<div class="core-heading"><h2>EDGAR</h2><span class="mpo-badge">SEC FILINGS · FACTS + LABELLED ANALYSIS</span></div>
      <p class="core-muted">SEC: ${escape(st.status || '…')}${st.lastSuccess ? ' · last ' + when(st.lastSuccess) : ''}</p>
      ${st.note ? `<p class="core-notice">${escape(st.note)} Add it to %APPDATA%\\Money Printer OS\\.env and restart. SEC asks every automated client to identify itself; MPOS never sends a contact it wasn't given.</p>` : ''}
      <div class="core-toolbar"><label>Latest<select data-edgar-form>${['8-K', '10-Q', '10-K', '4', 'SC 13D', 'SC 13G'].map(f => `<option ${f === form ? 'selected' : ''}>${f}</option>`).join('')}</select></label><button class="btn" type="button" data-edgar="latest">Load latest</button>
        <form data-edgar-company class="core-toolbar"><label>Company<input name="ticker" maxlength="8" value="${escape(ticker)}" placeholder="Ticker"></label><button class="btn" type="submit">Load filings</button></form></div>
      ${mode === 'company' && company ? `<h3>${escape(company.company)} <small>CIK ${escape(company.cik)} · ${escape((company.tickers || []).join(', '))}${company.sic ? ' · ' + escape(company.sic) : ''}</small></h3>` : ''}
      ${rows ? table(['Accepted (public)', 'Form', 'Company', 'Facts: items / transactions', 'Analysis (rule-based)', 'Source'], rows.map(row).join(''), 'No filings.') : ''}
      <p class="core-muted">Facts are exactly what the filer declared. The analysis column maps item numbers to catalyst labels and matches loaded market titles; it is not investment advice and never replaces the filing.</p>`;
  }
  const win = () => document.querySelector('.window[data-app="command"]');
  const root = () => document.getElementById('body-edgar');
  const visible = () => { const w = win(), r = root(); return !!(w && r && r.classList.contains('on') && !w.classList.contains('hidden') && !w.classList.contains('glance')); };
  function draw(force = false) {
    const r = root(); if (!visible() || (!force && drawn === r.id + ':' + stamp)) return;
    if (!force && r.contains(document.activeElement) && document.activeElement.matches('input,select,textarea')) return;
    drawn = r.id + ':' + stamp; const top = r.scrollTop;
    r.innerHTML = `<div class="core-app edgar-app">${error ? `<p class="core-error" role="alert">${escape(error)}</p>` : ''}${busy ? '<p role="status">Loading…</p>' : ''}${view()}</div>`; r.scrollTop = top;
  }
  async function act(fn) { if (busy) return; busy = true; error = ''; stamp++; draw(true); try { await fn(); } catch (e) { error = e.message; } finally { try { status = (await api('/edgar/status')).status; } catch {} busy = false; stamp++; draw(true); } }
  document.addEventListener('change', e => { if (root()?.contains(e.target) && e.target.matches('[data-edgar-form]')) form = e.target.value; });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-edgar]'); if (!b || !root()?.contains(b)) return;
    if (b.dataset.edgar === 'latest') act(async () => { mode = 'latest'; list = await api('/edgar/latest?form=' + encodeURIComponent(form)); });
    if (b.dataset.edgar === 'ai') act(async () => { try { summaries[b.dataset.acc] = await post('/edgar/summary', { accession: b.dataset.acc }); } catch (e) { summaries[b.dataset.acc] = { error: e.message }; } });
    if (b.dataset.edgar === 'form4') act(async () => { form4[b.dataset.acc] = (await api('/edgar/form4?url=' + encodeURIComponent(b.dataset.url))).facts; });
  });
  document.addEventListener('submit', e => { const f = e.target.closest('[data-edgar-company]'); if (!f || !root()?.contains(f)) return; e.preventDefault(); ticker = String(new FormData(f).get('ticker') || '').trim().toUpperCase(); act(async () => { mode = 'company'; company = await api('/edgar/company?ticker=' + encodeURIComponent(ticker)); }); });
  // Simple view: SEC EDGAR status and the latest filings of the selected form type.
  let cardAt = 0;
  function glanceCard() {
    const st = status?.status || (status ? 'UNKNOWN' : 'LOADING'), ok = /OK|CONNECTED|LIVE/.test(st), rows = Array.isArray(list?.filings) ? list.filings : Array.isArray(list?.items) ? list.items : Array.isArray(list) ? list : [];
    return glance({ title: 'EDGAR · SEC filings', pill: { label: ok ? 'Connected' : st.replace(/_/g, ' ').toLowerCase(), tone: ok ? 'ok' : 'warn' },
      hero: ok ? String(rows.length) : st === 'NOT CONFIGURED' ? 'Not set up' : '—', heroUnit: ok ? form + ' filings' : '', heroText: !ok, heroSub: ok ? 'latest from the SEC, newest first' : escape(status?.note || 'EDGAR needs a declared contact (SEC fair-access policy).'),
      stats: [{ label: 'Form', value: escape(form) }, { label: 'Last success', value: status?.lastSuccess ? new Date(status.lastSuccess).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—' }, { label: 'Mode', value: escape(mode) }],
      visual: ok ? `<div class="g-rows g-scroll">${rows.slice(0, 12).map(f => gRow(f.company || f.title || f.name || '—', `${f.form || form}${f.ticker ? ' · ' + f.ticker : ''}${f.filedAt || f.date ? ' · ' + new Date(f.filedAt || f.date).toLocaleDateString() : ''}`, '', 'ok')).join('') || '<div class="g-empty">No filings loaded yet.</div>'}</div>`
        : `<div class="g-empty">${escape(status?.note || 'Set SEC_USER_AGENT="Your Name you@example.com" to read EDGAR.')}</div>`,
      foot: gFoot(['SEC EDGAR', 'Advanced: company search, Form 4 insider facts']) });
  }
  addEventListener('DOMContentLoaded', () => window.MPOProgramGlance?.register('edgar', { render: glanceCard, sig: () => [stamp, error, status?.status, form] }));
  window.MPOEdgar = { render() {
    const card = window.MPOProgramVisible?.('edgar');
    if ((visible() || card) && !status && !busy) act(async () => {});
    // While the card shows and EDGAR is connected, keep the latest filings at most 10 minutes old.
    else if (card && /OK|CONNECTED|LIVE/.test(status?.status || '') && !busy && Date.now() - cardAt > 600000) { cardAt = Date.now(); act(async () => { mode = 'latest'; list = await api('/edgar/latest?form=' + encodeURIComponent(form)); }); }
    draw();
  } };
})();
