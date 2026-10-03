'use strict';
// Local desktop alerts (run item D3, 2026-10-03). Windows toasts through Electron's Notification; no external
// service. Pure: the supervisor (main.cjs) feeds it what the trader and the Lab already serve, and it returns the
// alerts to show. It alerts on a change of state, never on a state that was already true when the app started,
// and it rate-limits: one alert per subject per KEY_GAP_MS, at most MAX_PER_HOUR in any hour.
const KEY_GAP_MS = 30 * 60_000, MAX_PER_HOUR = 6, FEED_STALE_MS = 30 * 60_000, LAB_OFFLINE_MISSES = 3;

// The conditions that are true right now, as { key: { title, body } }.
function conditions({ health = null, scoreboard = null, bots = null, labOnline = null, labMisses = 0 } = {}) {
  const out = {};
  if (health?.health === 'STALLED') out['engine-stalled'] = { title: 'Pump.fun engine stalled', body: `No engine cycle for ${Math.round((health.stall?.lastCycleAgeMs || 0) / 60_000)} min. The supervisor restarts it; paper books are unaffected.` };
  for (const v of health?.stalledVenues || []) out['venue-stalled:' + v] = { title: `${v} stalled`, body: 'Its last run has not finished. The other venues keep running.' };
  for (const r of scoreboard?.rows || []) {
    if (r.kind === 'lab') continue;
    if (r.beatsBaseline === 'YES') out['beats:' + r.id] = { title: `${r.module}: beats its baseline`, body: `${r.book}: net ${r.netPnl} ${r.unit} over ${r.closes} closes, also without its best trade. Paper only.` };
    const f = r.freshness || {};
    if (r.active !== false && f.status === 'STALE' && f.ageMs > FEED_STALE_MS) out['stale:' + r.id] = { title: `${r.module}: data stale`, body: `${r.book}: nothing new for ${Math.round(f.ageMs / 60_000)} min (${f.source || 'feed'}).` };
    if (/^kalshi-farm-lab-/.test(r.id) && !r.withdrawn) out['proposal:' + r.id] = { title: 'Evolution Lab proposal arrived', body: `${r.book} is now forward-testing on paper in the Kalshi farm.` };
  }
  const k = bots?.kalshi || {};
  for (const [id, b] of Object.entries(k)) if (b?.standDown?.active) out['standdown:kalshi-' + id] = { title: `${b.label || 'Kalshi ' + id}: observe-only`, body: 'Its model was less accurate than the market over its recent bets, so it stopped spending paper cash.' };
  for (const v of bots?.farm?.variants || []) if (v?.standDown?.active) out['standdown:farm-' + v.id] = { title: `Farm variant ${v.id}: observe-only`, body: 'Its model trails the market; it records bets without cash until it beats the market.' };
  if (bots?.polycopy?.drawdownPause?.active) out['drawdown:polycopy'] = { title: 'Polymarket copy bot paused', body: String(bots.polycopy.drawdownPause.reason || 'Drawdown limit reached.').slice(0, 200) };
  if (labOnline === false && labMisses >= LAB_OFFLINE_MISSES) out['lab-offline'] = { title: 'Evolution Lab offline', body: `No answer from the Lab for ${labMisses} checks in a row.` };
  return out;
}

function createAlerter({ now = () => Date.now(), keyGapMs = KEY_GAP_MS, maxPerHour = MAX_PER_HOUR } = {}) {
  let previous = null; const lastShown = new Map(), shown = [];
  return {
    // Returns the alerts to show for this observation.
    observe(input) {
      const current = conditions(input), t = now();
      if (previous === null) { previous = current; return []; } // startup: learn the baseline silently
      const fresh = Object.entries(current).filter(([key]) => !(key in previous));
      previous = current;
      const out = [];
      for (const [key, a] of fresh) {
        while (shown.length && t - shown[0] > 3600_000) shown.shift();
        if (shown.length >= maxPerHour) break;
        if (t - (lastShown.get(key) ?? -Infinity) < keyGapMs) continue;
        lastShown.set(key, t); shown.push(t); out.push({ key, ...a });
      }
      return out;
    },
  };
}

module.exports = { conditions, createAlerter, KEY_GAP_MS, MAX_PER_HOUR, FEED_STALE_MS, LAB_OFFLINE_MISSES };
