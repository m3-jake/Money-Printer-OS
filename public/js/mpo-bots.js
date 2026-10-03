// Paper bots (2026-10-02): Kalshi weather + BTC range bots (Kalshi → Paper bots tab) and the Polymarket copy bot
// (Polymarket → Copy trading tab). Reads GET /api/bots; actions POST /api/bots/{config,run,reset,unfollow}.
// Everything here is PAPER: the engine has no order code for these bots.
(() => {
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = v => v == null || !Number.isFinite(Number(v)) ? '—' : (Number(v) < 0 ? '−$' : '$') + Math.abs(Number(v)).toFixed(2);
  const pct = v => v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
  const ago = t => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); return s < 90 ? s + 's ago' : s < 5400 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; };
  const when = t => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
  let data = null, error = '', busy = false, lastFetch = 0, msg = '';
  const SETTINGS = {
    weather: [['stakeUsd', 'USD per bet'], ['maxOpen', 'Max open'], ['minEdge', 'Min edge'], ['maxDisagreement', 'Max model–market gap'], ['biasF', 'Forecast bias °F'], ['sigmaBaseF', 'Sigma °F'], ['sigmaPerDayF', 'Sigma per day °F']],
    btc: [['stakeUsd', 'USD per bet'], ['maxOpen', 'Max open'], ['minEdge', 'Min edge'], ['maxDisagreement', 'Max model–market gap'], ['volMultiple', 'Vol multiple'], ['maxHoursToClose', 'Max hours to close']],
    polycopy: [['stakeUsd', 'USD per copy'], ['maxOpen', 'Max open'], ['follows', 'Leaders followed'], ['minLeaderTradeUsd', 'Min leader trade $'], ['maxChase', 'Max chase'], ['refollowDays', 'Refollow after days']],
  };
  async function load(force = false) {
    if (busy || (!force && Date.now() - lastFetch < 15000)) return; lastFetch = Date.now();
    try { const r = await fetch('/api/bots', { cache: 'no-store' }); const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status); data = j; error = ''; } catch (e) { error = e.message; }
    draw(true); window.MPOSPlatform?.render?.();
  }
  async function act(action, body, note) {
    if (busy) return; busy = true; msg = 'Working…'; draw(true);
    try { const r = await fetch('/api/bots/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status); msg = note || 'Done.'; }
    catch (e) { msg = e.message; } finally { busy = false; lastFetch = 0; await load(true); }
  }
  const curvePts = b => (b.curve || []).map(x => x.equityUsd);
  function header(b) {
    const st = b.stats || {};
    return `<div class="core-heading"><h2>${escape(b.label.toUpperCase())}</h2><span class="mpo-badge">PAPER ONLY</span><span class="mpo-badge">${b.settings.enabled ? 'ON' : 'OFF'}</span></div>
      <div class="core-lcd"><span>Paper equity ${usd(b.equityUsd)} (${pct(b.returnPct)})</span><span>Cash ${usd(b.cashUsd)}</span><span>Open ${b.open.length}</span><span>Settled ${st.settled ?? st.closed ?? 0} · wins ${st.wins ?? 0}</span><span>P/L ${usd(st.pnlUsd)} · fees ${usd(st.feesUsd)}</span>${st.brierModel != null ? `<span title="Lower is better. Brier score of the bot's probability vs the price it paid, over settled bets.">Brier model ${st.brierModel} vs market ${st.brierMarket}</span>` : ''}</div>
      <p class="core-muted">Last run ${ago(b.lastRunAt)}${b.lastNote ? ' · ' + escape(b.lastNote) : ''}</p>${b.lastError ? `<p class="core-error">${escape(b.lastError)}</p>` : ''}`;
  }
  function controls(id, b) {
    const s = b.settings, f = SETTINGS[id];
    return `<details><summary>Settings and reset</summary><form class="core-toolbar" data-bot-form="config" data-bot="${id}">${f.map(([k, l]) => `<label>${l}<input name="${k}" type="number" step="any" value="${escape(s[k])}" style="width:80px"></label>`).join('')}<button class="btn" type="submit">Save</button></form>
      <form class="core-toolbar" data-bot-form="reset" data-bot="${id}"><label>Start USD<input name="startUsd" type="number" min="10" value="${escape(b.startUsd)}" style="width:90px"></label><label>Type RESET BOT<input name="confirmation" autocomplete="off" style="width:110px"></label><button class="btn" type="submit">Reset this paper book</button></form></details>`;
  }
  const toolbar = (id, b) => `<div class="core-toolbar"><button class="btn" data-bot-act="toggle" data-bot="${id}" ${busy ? 'disabled' : ''}>${b.settings.enabled ? 'Pause bot' : 'Start bot'}</button><button class="btn" data-bot-act="run" data-bot="${id}" ${busy ? 'disabled' : ''}>Run now</button></div>`;
  const table = (head, rows, empty) => `<div class="core-table-wrap"><table class="table"><thead><tr>${head.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}">${escape(empty)}</td></tr>`}</tbody></table></div>`;
  function kalshiBot(id, b) {
    return `<section class="bot-card">${header(b)}${toolbar(id, b)}${window.MPOViz ? MPOViz.canvas('bot-' + id, 110, 'paper equity after each settled bet') : ''}
      <h3>Open bets</h3>${table(['Market', 'Side', 'Contracts', 'Paid', 'Model p', 'Mark', 'Closes'], b.open.map(p => `<tr><td>${escape(p.label)}</td><td>${p.side}</td><td>${p.qty}</td><td>${usd(p.costUsd + p.feeUsd)} @ ${p.avgPrice}</td><td>${(p.pModel * 100).toFixed(0)}%</td><td>${usd(p.markUsd)}</td><td>${when(p.closeAt)}</td></tr>`).join(''), 'No open bets.')}
      <h3>Settled</h3>${table(['Market', 'Side', 'Result', 'P/L', 'Model p', 'Price'], b.history.slice(0, 15).map(p => `<tr><td>${escape(p.label)}</td><td>${p.side}</td><td>${p.won ? 'WON' : 'LOST'} (${p.outcome})</td><td class="${p.pnlUsd >= 0 ? 'pm-up' : 'pm-down'}">${usd(p.pnlUsd)}</td><td>${(p.pModel * 100).toFixed(0)}%</td><td>${p.marketPrice}</td></tr>`).join(''), 'Nothing settled yet. Weather bets settle the morning after; BTC bets at their hour.')}
      <details><summary>Recent decisions (why it bet or skipped)</summary>${table(['When', 'Market', 'Action', 'Model p', 'Price', 'Edge', 'Why'], b.decisions.map(d => `<tr><td>${when(d.at)}</td><td>${escape(d.label || d.event || '')}</td><td>${escape(d.action)} ${escape(d.side || '')}</td><td>${d.pModel != null ? (d.pModel * 100).toFixed(0) + '%' : ''}</td><td>${d.price ?? ''}</td><td>${d.edge ?? ''}</td><td>${escape(d.reason || '')}</td></tr>`).join(''), 'No decisions yet.')}</details>
      ${controls(id, b)}</section>`;
  }
  function kalshiView() {
    if (!data) return `<p>${escape(error || 'Loading paper bots…')}</p>`;
    const k = data.kalshi;
    return `<p class="core-notice">Paper only. The weather bot turns the National Weather Service forecast into odds for each temperature bucket; the BTC bot prices Kalshi's Bitcoin range and above/below markets from Coinbase spot and recent volatility. Both buy only when their odds beat the ask after Kalshi's fee, fill against the live order book, and settle on Kalshi's own result. The Brier scores say whether the model is actually better than the market (lower is better).</p>${msg ? `<p role="status">${escape(msg)}</p>` : ''}${kalshiBot('weather', k.weather)}${kalshiBot('btc', k.btc)}`;
  }
  function copyView() {
    if (!data) return `<p>${escape(error || 'Loading copy bot…')}</p>`;
    const b = data.polycopy;
    return `<p class="core-notice">Paper copy trading on global Polymarket (polymarket.com prices, not Polymarket US). Leaders come from the weekly profit leaderboard at the moment they are followed, and only trades they make after that are copied — never their past wins. Copies fill at the live order book when the bot notices the trade (up to a minute late), so the result includes the cost of being late.</p>${msg ? `<p role="status">${escape(msg)}</p>` : ''}
      <section class="bot-card">${header(b)}${toolbar('polycopy', b)}${window.MPOViz ? MPOViz.canvas('bot-polycopy', 110, 'paper equity after each closed copy') : ''}
      <h3>Following</h3>${table(['Leader', 'Rank at follow', 'Week P/L at follow', 'Volume', 'Since', ''], b.follows.map(f => `<tr><td>${escape(f.name)}</td><td>#${f.rank}</td><td>${usd(f.pnlAtFollow)}</td><td>${usd(f.volAtFollow)}</td><td>${when(f.followedAt)}</td><td><button class="btn" data-bot-act="unfollow" data-bot="polycopy" data-wallet="${escape(f.wallet)}">Unfollow</button></td></tr>`).join(''), 'Picks leaders on the first run.')}
      <h3>Results by leader</h3>${table(['Leader', 'Copies', 'Closed', 'P/L'], b.byLeader.map(r => `<tr><td>${escape(r.leader)}</td><td>${r.copies}</td><td>${r.settled}</td><td class="${r.pnlUsd >= 0 ? 'pm-up' : 'pm-down'}">${usd(r.pnlUsd)}</td></tr>`).join(''), 'No copies yet.')}
      <h3>Open copies</h3>${table(['Market', 'Outcome', 'Leader', 'Leader price', 'Our price', 'Cost', 'Mark'], b.open.map(p => `<tr><td>${escape(p.title)}</td><td>${escape(p.outcome)}</td><td>${escape(p.leaderName)}</td><td>${p.leaderPrice}</td><td>${p.avgPrice}</td><td>${usd(p.costUsd + p.feeUsd)}</td><td>${usd(p.markUsd)}</td></tr>`).join(''), 'No open copies.')}
      <h3>Closed</h3>${table(['Market', 'Outcome', 'How', 'P/L'], b.history.slice(0, 15).map(p => `<tr><td>${escape(p.title)}</td><td>${escape(p.outcome)}</td><td>${escape(p.status === 'RESOLVED' ? (p.won ? 'resolved WON' : 'resolved LOST') : 'sold: ' + (p.reason || ''))}</td><td class="${p.pnlUsd >= 0 ? 'pm-up' : 'pm-down'}">${usd(p.pnlUsd)}</td></tr>`).join(''), 'Nothing closed yet.')}
      <details><summary>Recent decisions</summary>${table(['When', 'Leader', 'Market', 'Action', 'Why'], b.decisions.map(d => `<tr><td>${when(d.at)}</td><td>${escape(d.leader || '')}</td><td>${escape(d.title || '')}</td><td>${escape(d.action)}${d.price ? ' @ ' + d.price : ''}${d.lagSec ? ' · ' + d.lagSec + 's late' : ''}</td><td>${escape(d.reason || '')}</td></tr>`).join(''), 'No decisions yet.')}</details>
      ${controls('polycopy', b)}</section>`;
  }
  const PANES = { kalshibots: { host: 'kalshi', view: kalshiView, charts: () => data && ['weather', 'btc'].map(id => ['bot-' + id, data.kalshi[id]]) }, pmcopy: { host: 'sportsbook', view: copyView, charts: () => data && [['bot-polycopy', data.polycopy]] } };
  const visible = id => { const w = document.querySelector(`.window[data-app="${PANES[id].host}"]`), r = document.getElementById('body-' + id); return !!(w && r && r.classList.contains('on') && !w.classList.contains('hidden') && !w.classList.contains('glance')); };
  const drawn = {};
  function draw(force = false) {
    for (const id of Object.keys(PANES)) {
      const r = document.getElementById('body-' + id); if (!r || !visible(id)) continue;
      if (r.contains(document.activeElement) && document.activeElement.matches('input,select,textarea')) continue;
      const html = `<div class="core-app bots-app">${PANES[id].view()}</div>`; if (!force && drawn[id] === html) continue; drawn[id] = html;
      const top = r.scrollTop; r.innerHTML = html; r.scrollTop = top;
      for (const [key, b] of PANES[id].charts() || []) if (window.MPOViz && b) MPOViz.set(key, 'lines', { series: [{ label: 'paper equity', color: '#39ff68', points: curvePts(b) }], unit: '$', empty: 'Curve starts at the first settled bet', zero: false });
    }
  }
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-bot-act]'); if (!btn) return; const bot = btn.dataset.bot, a = btn.dataset.botAct;
    const b = bot === 'polycopy' ? data?.polycopy : data?.kalshi?.[bot];
    if (a === 'run') act('run', { bot }, 'Ran one pass.');
    else if (a === 'toggle' && b) act('config', { bot, settings: { enabled: !b.settings.enabled } }, b.settings.enabled ? 'Bot paused.' : 'Bot started.');
    else if (a === 'unfollow') act('unfollow', { bot, wallet: btn.dataset.wallet }, 'Unfollowed.');
  });
  document.addEventListener('submit', e => {
    const f = e.target.closest('[data-bot-form]'); if (!f) return; e.preventDefault();
    const input = Object.fromEntries(new FormData(f)), bot = f.dataset.bot;
    if (f.dataset.botForm === 'config') act('config', { bot, settings: input }, 'Settings saved.');
    else act('reset', { bot, startUsd: Number(input.startUsd), confirmation: input.confirmation }, 'Paper book reset.');
  });
  setInterval(() => { if (!document.hidden && (Object.keys(PANES).some(visible) || document.querySelector('.window[data-app="kalshi"]:not(.hidden)') || document.querySelector('.window[data-app="sportsbook"]:not(.hidden)'))) load(); }, 15000);
  window.MPOBots = { render() { draw(); load(); }, get data() { return data; }, load };
})();
