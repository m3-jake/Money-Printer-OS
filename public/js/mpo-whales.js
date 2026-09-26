// Whale Watch window: Solana token/wallet relationships from data the engine already records.
// Observations and rule-based flags only; wallet behaviour is never presented as identity or intent.
(() => {
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = v => v ? new Date(v).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const short = a => a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '';
  let data = null, token = null, wallet = null, error = '', busy = false, stamp = 0, drawn = '', lastFetch = 0, minSol = 10;
  const api = async (p, body) => { const r = await fetch('/api/platform' + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' }); const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
  const table = (head, rows, empty) => `<div class="core-table-wrap"><table class="table"><thead><tr>${head.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}">${escape(empty)}</td></tr>`}</tbody></table></div>`;
  const addr = (a, label) => `<button class="linkbtn" type="button" data-whale="wallet" data-a="${escape(a)}" title="${escape(a)}">${escape(label?.label || label || short(a))}</button>`;
  const mintBtn = (m, sym) => `<button class="linkbtn" type="button" data-whale="token" data-m="${escape(m)}" title="${escape(m)}">${escape(sym || short(m))}</button>`;
  // Radial graph: token centre, mint authority above with sibling tokens, holders and early buyers around.
  function graph(g) {
    const W = 520, H = 300, cx = 260, cy = 170, pos = new Map([[g.mint, [cx, cy]]]);
    if (g.authority) pos.set(g.authority.address, [cx, 40]);
    const place = (ids, r, a0, a1) => ids.forEach((id, i) => { if (pos.has(id)) return; const a = a0 + (a1 - a0) * (ids.length === 1 ? 0.5 : i / (ids.length - 1)); pos.set(id, [cx + r * Math.cos(a), cy + r * Math.sin(a)]); });
    place(g.siblings.slice(0, 10).map(s => s.mint), 150, -Math.PI + 0.3, -0.3);
    place(g.nodes.filter(n => n.type === 'holder' || n.type === 'early-buyer').slice(0, 24).map(n => n.id), 115, 0.25, Math.PI - 0.25);
    const col = { token: '#ffb000', 'mint-authority': '#ff8f8f', 'sibling-token': '#ffd479', holder: '#7fd3ff', 'early-buyer': '#7fe39a' };
    const lines = g.edges.filter(e => pos.has(e.from) && pos.has(e.to)).map(e => { const [x1, y1] = pos.get(e.from), [x2, y2] = pos.get(e.to); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${e.relation === 'EARLY_BUY' ? '#3e7a52' : e.relation === 'MINT_AUTHORITY_OF' ? '#7a3e3e' : '#2f5a6e'}" stroke-width="1"/>`; }).join('');
    const dots = g.nodes.filter(n => pos.has(n.id)).map(n => { const [x, y] = pos.get(n.id); return `<g><circle cx="${x}" cy="${y}" r="${n.type === 'token' ? 9 : 5}" fill="${col[n.type] || '#ccc'}"><title>${escape(n.type + ': ' + n.id)}</title></circle><text x="${x + 7}" y="${y + 3}" font-size="8" fill="#cfe5dc">${escape(n.label)}</text></g>`; }).join('');
    return `<svg class="whale-graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="Relationship graph for ${escape(g.symbol || g.mint)}">${lines}${dots}</svg>
      <p class="core-muted"><span style="color:#ff8f8f">●</span> mint authority · <span style="color:#ffd479">●</span> its other tokens · <span style="color:#7fd3ff">●</span> top holders observed · <span style="color:#7fe39a">●</span> early buyers</p>`;
  }
  function tokenView(g) {
    return `<h3>${escape(g.symbol || short(g.mint))} <small>${escape(g.mint)}${g.firstSeen ? ' · first seen ' + when(g.firstSeen) : ''}</small></h3>
      ${g.flags.length ? `<div class="whale-flags">${g.flags.map(f => `<p class="core-notice"><b>${escape(f.code)}</b> — ${escape(f.detail)}</p>`).join('')}</div>` : '<p class="core-muted">No rule-based flags from the recorded data.</p>'}
      ${graph(g)}
      <div class="core-compare"><div><b>Mint authority</b><p>${g.authority ? `${addr(g.authority.address, g.authority.label)} · ${g.authority.tokens} tokens` : 'Not recorded'}</p>
        ${table(['Other tokens from this authority', 'First seen'], g.siblings.slice(0, 20).map(s => `<tr><td>${mintBtn(s.mint, s.symbol)}</td><td>${when(s.firstSeen)}</td></tr>`).join(''), 'None recorded.')}</div>
      <div>${table(['Early buyer', 'SOL', 'When', 'Early in siblings'], g.early.map(b => `<tr><td>${addr(b.wallet)}</td><td>${b.sol?.toFixed?.(3) ?? '—'}</td><td>${when(b.ts)}</td><td>${g.repeatEarly.find(r => r.wallet === b.wallet)?.siblingTokensEarly || ''}</td></tr>`).join(''), 'No indexed swaps for this token.')}
        ${table(['Large swap', 'Side', 'SOL', 'When'], g.bigSwaps.map(s => `<tr><td>${addr(s.wallet)}</td><td>${escape(s.side)}</td><td>${s.sol.toFixed(2)}</td><td>${when(s.ts)}</td></tr>`).join(''), 'No large swaps.')}</div></div>
      <p class="core-muted">Holders also holding this authority's tokens: ${g.overlap.length}. Exchange flows: ${escape(g.exchangeFlows)}.</p>`;
  }
  function walletPane(v) {
    return `<h3>Wallet ${escape(short(v.address))} <small>${escape(v.address)}</small></h3><p class="core-muted">${escape(v.note)}</p>
      <form data-whale-label class="core-toolbar"><input type="hidden" name="address" value="${escape(v.address)}"><label>Your label<input name="label" maxlength="60" value="${escape(v.label?.label || '')}"></label><label>Note<input name="note" maxlength="500" value="${escape(v.label?.note || '')}"></label><button class="btn" type="submit">Save label</button></form>
      <p>Holder of: ${v.holderOf.map(t => mintBtn(t.mint, t.symbol)).join(' ') || '—'} · Mint authority of: ${v.mintAuthorityOf.map(t => mintBtn(t.mint, t.symbol)).join(' ') || '—'} · Net SOL from indexed swaps: ${v.netSolFromSwaps ?? '—'}${v.score ? ` · Scorecard: ${escape(JSON.stringify(v.score)).slice(0, 160)}` : ''}</p>
      ${table(['When', 'Token', 'Side', 'SOL'], v.swaps.slice(0, 30).map(s => `<tr><td>${when(s.ts)}</td><td>${mintBtn(s.mint)}</td><td>${escape(s.side)}</td><td>${s.solDelta === null ? '—' : Number(s.solDelta).toFixed(3)}</td></tr>`).join(''), 'No indexed swaps for this wallet.')}`;
  }
  function view() {
    if (!data) return busy ? '<p>Loading Solana research data…</p>' : '<p>Loading…</p>';
    const av = data.available;
    return `<div class="core-heading"><h2>WHALE WATCH</h2><span class="mpo-badge">SOLANA · OBSERVATIONS</span></div>
      <p class="core-notice">${escape(data.note)}</p>
      <p class="core-muted">Research state: ${av.research ? 'loaded' : 'unavailable'}${av.researchError ? ' (' + escape(av.researchError) + ')' : ''} · indexed swaps (7 days): ${av.events}${av.eventsError ? ' (' + escape(av.eventsError) + ')' : ''} · wallet indexer: ${escape(data.scorecard?.indexer?.status || 'unknown')}</p>
      <form data-whale-find class="core-toolbar"><label>Token mint or wallet<input name="q" maxlength="44" placeholder="base58 address"></label><button class="btn" type="submit" name="kind" value="token">Token graph</button><button class="btn" type="submit" name="kind" value="wallet">Wallet</button></form>
      ${token ? tokenView(token) : ''}${wallet ? walletPane(wallet) : ''}
      <h3>Whale flow <small>Swaps of at least <input data-whale-min type="number" min="0.1" step="0.1" value="${minSol}" style="width:60px"> SOL</small></h3>
      ${table(['When', 'Wallet', 'Side', 'SOL', 'Token'], data.flow.slice(0, 60).map(f => `<tr><td>${when(f.ts)}</td><td>${addr(f.wallet, f.label)}</td><td>${escape(f.side)}</td><td>${f.sol.toFixed(2)}</td><td>${mintBtn(f.mint, f.symbol)}</td></tr>`).join(''), av.events ? 'No swaps above this size.' : 'No indexed swaps. The capped wallet indexer needs a Helius key and records Pump.fun signer swaps.')}
      <div class="core-compare"><div>${table(['Mint authority', 'Tokens', 'Last seen'], data.authorities.map(a => `<tr><td>${addr(a.address, a.label)}</td><td>${a.tokens}</td><td>${when(a.lastSeen)}</td></tr>`).join(''), 'No mint authorities recorded yet.')}</div>
        <div>${table(['Recurring holder', 'Tokens seen', 'Recurrence'], data.recurring.map(w => `<tr><td>${addr(w.address, w.label)}</td><td>${w.tokensSeen}</td><td>${w.recurrenceScore ?? '—'}</td></tr>`).join(''), 'No recurring holders recorded yet.')}</div></div>
      <h3>Recently scanned tokens</h3>${table(['Token', 'Last seen', 'Mint authority'], data.tokens.slice(0, 30).map(t => `<tr><td>${mintBtn(t.mint, t.symbol)}</td><td>${when(t.lastSeen)}</td><td>${t.authority ? addr(t.authority) : '—'}</td></tr>`).join(''), 'No tokens scanned yet.')}`;
  }
  // A tab of the Solana (Pump.fun) window: draw only while its tab pane is showing.
  const root = () => document.getElementById('body-whales');
  const visible = () => { const p = root(), w = p?.closest('.window'); return !!(p && w && p.classList.contains('on') && !w.classList.contains('hidden') && !w.classList.contains('glance')); };
  function draw(force = false) { const r = root(); if (!visible() || (!force && drawn === r.id + ':' + stamp)) return; if (!force && r.contains(document.activeElement) && document.activeElement.matches('input,select')) return; drawn = r.id + ':' + stamp; const top = r.scrollTop; r.innerHTML = `<div class="core-app whale-app">${error ? `<p class="core-error" role="alert">${escape(error)}</p>` : ''}${view()}</div>`; r.scrollTop = top; }
  async function act(fn) { if (busy) return; busy = true; error = ''; stamp++; draw(true); try { await fn(); } catch (e) { error = e.message; } finally { busy = false; stamp++; draw(true); } }
  async function refresh(force = false) { if (!visible() || (!force && Date.now() - lastFetch < 30000)) return; lastFetch = Date.now(); await act(async () => { data = await api('/whales?minSol=' + minSol); }); }
  document.addEventListener('click', e => { const b = e.target.closest('[data-whale]'); if (!b || !root()?.contains(b)) return; if (b.dataset.whale === 'token') act(async () => { token = await api('/whales/token?mint=' + encodeURIComponent(b.dataset.m)); wallet = null; }); if (b.dataset.whale === 'wallet') act(async () => { wallet = await api('/whales/wallet?address=' + encodeURIComponent(b.dataset.a)); }); });
  document.addEventListener('change', e => { if (root()?.contains(e.target) && e.target.matches('[data-whale-min]')) { minSol = Number(e.target.value) || 10; refresh(true); } });
  document.addEventListener('submit', e => {
    const f = e.target.closest('[data-whale-find],[data-whale-label]'); if (!f || !root()?.contains(f)) return; e.preventDefault();
    if (f.matches('[data-whale-label]')) { const i = Object.fromEntries(new FormData(f)); act(async () => { await api('/whales/label', i); wallet = await api('/whales/wallet?address=' + encodeURIComponent(i.address)); data = await api('/whales?minSol=' + minSol); }); return; }
    const q = String(new FormData(f).get('q') || '').trim(), kind = e.submitter?.value || 'token';
    act(async () => { if (kind === 'wallet') wallet = await api('/whales/wallet?address=' + encodeURIComponent(q)); else { token = await api('/whales/token?mint=' + encodeURIComponent(q)); wallet = null; } });
  });
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  window.MPOWhales = { render() { draw(); refresh(); } };
})();
