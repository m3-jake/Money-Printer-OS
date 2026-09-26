// Polymarket public-data paper-combo ledger.
//
// This is intentionally isolated from polymarketUSCombos.js: it has its own file, settings,
// fills, settlement, and recovery path, and its only network primitive is an unauthenticated GET
// against the documented public market feed. It never imports signedFetch, quoteUSCombo, placeUSCombo,
// the real combo journal, or a credential gate. `realAccess` is always false in its output.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from './robinhoodEquitiesData.js';

export const PAPER_COMBO_SCHEMA = 'mpo.polymarket-paper-combos.v1';
export const PAPER_COMBO_DEFAULTS = Object.freeze({
  startBudgetUsd: 250, stakeMode: 'fixed', fixedStakeUsd: 5, stakePct: .1,
  maxOpenCombos: 4, dailyLossCapUsd: 25, reservedCapitalUsd: 100,
  priceFloor: .8, maxMinutesRemaining: 25, maxLegs: 3, strategyWindow: 'LATE',
  quoteMaxAgeMs: 90_000, slippageBps: 12, autopilot: false,
  rankWeights: { price: 1, depth: 1, eta: 1, spread: 1 },
});
const GATEWAY = () => process.env.POLYMARKET_US_GATEWAY || 'https://gateway.polymarket.us';
const r2 = n => Math.round(Number(n) * 100) / 100;
const r3 = n => Math.floor(Number(n) * 1000) / 1000;
const n = (v, d = null) => Number.isFinite(Number(v)) ? Number(v) : d;
const stable = v => Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v);
const day = at => new Date(Number(at)).toISOString().slice(0, 10);

export function paperComboFile(dataDir) { return path.join(dataDir, 'polymarket-paper-combos.json'); }
export function paperComboSettingsHash(settings) { return crypto.createHash('sha256').update(stable(normalizePaperComboSettings(settings))).digest('hex').slice(0, 16); }

export function normalizePaperComboSettings(patch = {}, base = PAPER_COMBO_DEFAULTS) {
  const src = patch && typeof patch === 'object' ? patch : {}, out = { ...PAPER_COMBO_DEFAULTS, ...(base || {}) };
  const clamp = (key, lo, hi) => { const v = n(src[key], out[key]); out[key] = v === null ? PAPER_COMBO_DEFAULTS[key] : Math.max(lo, Math.min(hi, v)); };
  clamp('startBudgetUsd', 10, 1_000_000); clamp('fixedStakeUsd', 1, 100_000); clamp('stakePct', .01, 1);
  clamp('maxOpenCombos', 1, 100); out.maxOpenCombos = Math.round(out.maxOpenCombos);
  clamp('dailyLossCapUsd', 0, 1_000_000); clamp('reservedCapitalUsd', 0, 1_000_000);
  clamp('priceFloor', .01, .985); clamp('maxMinutesRemaining', 1, 24 * 60); out.maxMinutesRemaining = Math.round(out.maxMinutesRemaining);
  clamp('maxLegs', 2, 8); out.maxLegs = Math.round(out.maxLegs); clamp('quoteMaxAgeMs', 1000, 15 * 60_000); out.quoteMaxAgeMs = Math.round(out.quoteMaxAgeMs);
  clamp('slippageBps', 0, 500); out.autopilot = src.autopilot === undefined ? !!out.autopilot : src.autopilot === true;
  out.stakeMode = src.stakeMode === 'percent' ? 'percent' : 'fixed';
  out.strategyWindow = String(src.strategyWindow ?? out.strategyWindow).toUpperCase().slice(0, 32);
  out.rankWeights = { ...PAPER_COMBO_DEFAULTS.rankWeights, ...(out.rankWeights || {}) };
  for (const key of Object.keys(out.rankWeights)) out.rankWeights[key] = Math.max(0, Math.min(3, n(src.rankWeights?.[key], out.rankWeights[key])));
  return out;
}

export function newPaperComboLedger({ settings = {}, now = Date.now() } = {}) {
  const s = normalizePaperComboSettings(settings);
  return { schema: PAPER_COMBO_SCHEMA, version: 1, createdAt: now, updatedAt: now, settings: s, settingsHash: paperComboSettingsHash(s),
    startBudgetUsd: s.startBudgetUsd, cashUsd: s.startBudgetUsd, reservedUsd: 0, open: [], history: [], realizedPnlUsd: 0,
    recoveryRequired: false, recoveryReason: null, telemetry: { loopStatus: 'IDLE', lastTickAt: null, source: null, freshnessMs: null,
      candidates: 0, eligible: 0, placed: 0, fills: 0, partialFills: 0, rejections: {}, lastDecision: { action: 'WAIT', reason: 'no cycle yet' },
      candidatesChecked: [], depthSamples: [], settlement: { open: 0, unresolved: 0, unknown: 0 } }, lastError: null };
}

export function loadPaperComboLedger(dataDir, { settings = {}, now = Date.now() } = {}) {
  const file = paperComboFile(dataDir); let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return newPaperComboLedger({ settings, now }); return { ...newPaperComboLedger({ settings, now }), recoveryRequired: true, recoveryReason: `unreadable: ${e.code || 'file'}` }; }
  if (!raw || raw.schema !== PAPER_COMBO_SCHEMA || raw.version !== 1 || !Array.isArray(raw.open) || !Array.isArray(raw.history) || !raw.settings) return { ...newPaperComboLedger({ settings, now }), recoveryRequired: true, recoveryReason: 'corrupt paper-combo ledger; reset it after review' };
  const s = normalizePaperComboSettings(raw.settings); return { ...newPaperComboLedger({ settings: s, now }), ...raw, settings: s, settingsHash: paperComboSettingsHash(s) };
}
export function savePaperComboLedger(dataDir, ledger) { if (!ledger || ledger.recoveryRequired) return false; writeJsonAtomic(paperComboFile(dataDir), { ...ledger, schema: PAPER_COMBO_SCHEMA, version: 1, updatedAt: Date.now(), settingsHash: paperComboSettingsHash(ledger.settings) }); return true; }

function reject(t, reason) { t.rejections[reason] = Number(t.rejections[reason] || 0) + 1; }
function quoteFresh(leg, now, maxAge) { const at = n(leg.quoteAt); return at !== null && at <= now && now - at <= maxAge; }
function normalizeLeg(leg, now) {
  const price = n(leg.ask ?? leg.price), bid = n(leg.bid ?? price), depthUsd = n(leg.depthUsd ?? leg.liquidityUsd ?? leg.openInterest, 0);
  return { ...leg, key: String(leg.key || leg.symbol || `${leg.eventSlug || 'event'}:${leg.side || leg.outcome || 'side'}`), eventSlug: String(leg.eventSlug || leg.event || ''), symbol: String(leg.symbol || ''), side: String(leg.side || leg.outcome || ''), bid, ask: price, price, depthUsd, feePerContract: n(leg.feePerContract ?? leg.fee, null), quoteAt: n(leg.quoteAt ?? leg.at, now), etaMinutes: n(leg.etaMinutes, null), resolutionRule: String(leg.resolutionRule || leg.resolution || '') };
}

export function validatePaperComboLegs(legs = [], { settings = PAPER_COMBO_DEFAULTS, now = Date.now() } = {}) {
  const s = normalizePaperComboSettings(settings), rows = legs.map(x => normalizeLeg(x, now)), reasons = [];
  if (rows.length < 2) reasons.push('minimum-two-legs'); if (rows.length > s.maxLegs) reasons.push('max-legs');
  const events = rows.map(x => x.eventSlug).filter(Boolean); if (new Set(events).size !== events.length) reasons.push('duplicate-event');
  for (const l of rows) {
    if (!l.eventSlug) reasons.push('unknown-event');
    if (!quoteFresh(l, now, s.quoteMaxAgeMs)) reasons.push(`stale-quote:${l.key}`);
    if (!(l.bid > 0 && l.ask >= l.bid && l.ask < 1)) reasons.push(`invalid-quote:${l.key}`);
    if (!(l.depthUsd > 0)) reasons.push(`unknown-depth:${l.key}`);
    if (!(l.feePerContract !== null && l.feePerContract >= 0)) reasons.push(`unknown-fee:${l.key}`);
    if (!l.resolutionRule) reasons.push(`unknown-resolution:${l.key}`);
    if (l.price < s.priceFloor) reasons.push(`price-floor:${l.key}`);
    if (l.etaMinutes !== null && l.etaMinutes > s.maxMinutesRemaining) reasons.push(`outside-window:${l.key}`);
  }
  return { ok: reasons.length === 0, legs: rows, reasons: [...new Set(reasons)] };
}

export function rankPaperLeg(leg, settings = PAPER_COMBO_DEFAULTS) {
  const s = normalizePaperComboSettings(settings), spread = Math.max(0, leg.ask - leg.bid), depth = Math.min(35, Math.log10(Math.max(1, leg.depthUsd)) * 8);
  return s.rankWeights.price * (100 - Math.abs(leg.ask - .9) * 260) + s.rankWeights.depth * depth - s.rankWeights.eta * (leg.etaMinutes ?? 60) * 8 - s.rankWeights.spread * spread * 500;
}

export function buildPaperComboQuote(legs, stakeUsd, { settings = PAPER_COMBO_DEFAULTS, now = Date.now() } = {}) {
  const check = validatePaperComboLegs(legs, { settings, now }); if (!check.ok) throw Object.assign(new Error(`paper combo rejected: ${check.reasons.join(', ')}`), { code: 'paperComboRejected', reasons: check.reasons });
  const s = normalizePaperComboSettings(settings), stake = Math.max(0, n(stakeUsd, 0));
  const price = check.legs.reduce((x, l) => x * l.ask, 1), depthUsd = Math.min(...check.legs.map(l => l.depthUsd));
  const depthRatio = depthUsd > 0 ? Math.min(1, stake / depthUsd) : 1, slip = (s.slippageBps / 10_000) * (1 + depthRatio);
  const slippedPrice = Math.min(.999, price * (1 + slip)), feePerUnit = check.legs.reduce((x, l) => x + l.feePerContract, 0);
  const costPerUnit = slippedPrice + feePerUnit, fillableStake = Math.min(stake, depthUsd), quantity = r3(fillableStake / Math.max(costPerUnit, .000001));
  const costUsd = r2(quantity * costPerUnit);
  if (!(quantity > 0) || !(costUsd > 0)) throw Object.assign(new Error('paper combo has no executable depth'), { code: 'noDepth' });
  return { at: now, legs: check.legs, price: r3(slippedPrice), feePerUnit: r3(feePerUnit), quantity, costUsd, requestedStakeUsd: r2(stake), partial: fillableStake + 1e-9 < stake, depthUsd: r2(depthUsd), slippageBps: r2(slip * 10_000) };
}

function stakeFor(ledger) { const s = ledger.settings; return r2(Math.min(ledger.cashUsd, ledger.startBudgetUsd - ledger.reservedUsd, s.reservedCapitalUsd > 0 ? s.reservedCapitalUsd - ledger.reservedUsd : Infinity, s.stakeMode === 'percent' ? ledger.cashUsd * s.stakePct : s.fixedStakeUsd)); }
function realizedLossToday(ledger, now) { return ledger.history.filter(x => x.settledAt && day(x.settledAt) === day(now)).reduce((v, x) => v + Math.min(0, n(x.pnlUsd, 0)), 0); }

export function placePaperCombo({ dataDir, legs, stakeUsd, now = Date.now() } = {}) {
  const ledger = loadPaperComboLedger(dataDir, { now }); if (ledger.recoveryRequired) throw new Error('paper combo ledger requires recovery');
  const s = ledger.settings, loss = realizedLossToday(ledger, now);
  if (ledger.open.length >= s.maxOpenCombos) throw new Error('paper combo max-open limit reached');
  if (s.dailyLossCapUsd > 0 && loss <= -s.dailyLossCapUsd) throw new Error('paper combo daily loss cap reached');
  const quote = buildPaperComboQuote(legs, Math.min(n(stakeUsd, stakeFor(ledger)), stakeFor(ledger)), { settings: s, now });
  if (quote.costUsd > stakeFor(ledger) + .01) throw new Error('paper combo reserved capital limit reached');
  const entry = { id: `pm-paper-${now.toString(36)}-${ledger.history.length}-${ledger.open.length}`, status: 'OPEN', placedBy: 'paper', at: now, legs: quote.legs,
    quote: { price: quote.price, feePerUnit: quote.feePerUnit, depthUsd: quote.depthUsd, slippageBps: quote.slippageBps, quoteAt: now }, quantity: quote.quantity, costUsd: quote.costUsd,
    filledStakeUsd: quote.costUsd, requestedStakeUsd: quote.requestedStakeUsd, partial: quote.partial, outcome: null, payoutUsd: null, pnlUsd: null };
  ledger.cashUsd = r2(ledger.cashUsd - entry.costUsd); ledger.reservedUsd = r2(ledger.reservedUsd + entry.costUsd); ledger.open.unshift(entry);
  ledger.telemetry.placed++; ledger.telemetry.fills++; if (entry.partial) ledger.telemetry.partialFills++;
  ledger.telemetry.lastDecision = { at: now, action: 'PLACE', id: entry.id, reason: entry.partial ? 'depth-partial-fill' : 'paper-fill' };
  savePaperComboLedger(dataDir, ledger); return entry;
}

export function settlePaperCombos({ dataDir, outcomes = {}, now = Date.now() } = {}) {
  const ledger = loadPaperComboLedger(dataDir, { now }); if (ledger.recoveryRequired) throw new Error('paper combo ledger requires recovery');
  let settled = 0, unresolved = 0; const keep = [];
  for (const entry of ledger.open) {
    const values = entry.legs.map(l => outcomes[l.eventSlug] ?? outcomes[l.symbol] ?? outcomes[l.key]);
    if (values.some(v => v === undefined || v === null || v === 'UNRESOLVED')) { unresolved++; keep.push(entry); continue; }
    if (values.some(v => v === 'VOID' || v === 'INVALIDATED')) { keep.push({ ...entry, status: 'UNKNOWN', unknownReason: 'invalidated or void resolution', resolvedAt: now }); ledger.telemetry.settlement.unknown++; continue; }
    if (!values.every(v => Number(v) === 0 || Number(v) === 1)) { unresolved++; keep.push(entry); continue; }
    const won = values.every(v => Number(v) === 1), payoutUsd = won ? r2(entry.quantity) : 0, pnlUsd = r2(payoutUsd - entry.costUsd);
    ledger.cashUsd = r2(ledger.cashUsd + entry.costUsd + pnlUsd); ledger.reservedUsd = r2(Math.max(0, ledger.reservedUsd - entry.costUsd)); ledger.realizedPnlUsd = r2(ledger.realizedPnlUsd + pnlUsd);
    ledger.history.unshift({ ...entry, status: won ? 'WON' : 'LOST', payoutUsd, pnlUsd, settledAt: now }); settled++;
  }
  ledger.open = keep; ledger.telemetry.settlement.open = ledger.open.length; ledger.telemetry.settlement.unresolved = unresolved; savePaperComboLedger(dataDir, ledger); return { settled, unresolved, open: ledger.open.length };
}
export function cancelPaperCombo({ dataDir, id, reason = 'operator-cancelled', now = Date.now() } = {}) {
  const ledger = loadPaperComboLedger(dataDir, { now }), i = ledger.open.findIndex(x => x.id === id); if (i < 0) throw new Error('paper combo not found');
  const [entry] = ledger.open.splice(i, 1); ledger.cashUsd = r2(ledger.cashUsd + entry.costUsd); ledger.reservedUsd = r2(Math.max(0, ledger.reservedUsd - entry.costUsd)); ledger.history.unshift({ ...entry, status: 'CANCELLED', cancelReason: reason, settledAt: now }); savePaperComboLedger(dataDir, ledger); return ledger.history[0];
}
export function resetPaperCombos({ dataDir, budgetUsd, now = Date.now() } = {}) { const old = loadPaperComboLedger(dataDir, { now }), file = paperComboFile(dataDir); if (old.recoveryRequired && fs.existsSync(file)) fs.copyFileSync(file, `${file}.corrupt-${now}.bak`); const next = newPaperComboLedger({ settings: { ...old.settings, startBudgetUsd: budgetUsd ?? old.settings.startBudgetUsd, autopilot: false }, now }); savePaperComboLedger(dataDir, next); return next; }
export function configurePaperCombos({ dataDir, patch = {}, now = Date.now() } = {}) { const ledger = loadPaperComboLedger(dataDir, { now }); if (ledger.recoveryRequired) throw new Error('paper combo ledger requires recovery'); ledger.settings = normalizePaperComboSettings(patch, ledger.settings); ledger.settingsHash = paperComboSettingsHash(ledger.settings); savePaperComboLedger(dataDir, ledger); return ledger.settings; }

async function publicJson(pathname, fetchImpl = globalThis.fetch) {
  const r = await fetchImpl(new URL(pathname, GATEWAY()).toString(), { method: 'GET', headers: { accept: 'application/json', 'user-agent': 'MoneyPrinterOS-paper-combos' }, signal: AbortSignal.timeout?.(10_000) });
  if (!r?.ok) throw new Error(`public market feed HTTP ${r?.status || 'unknown'}`); return typeof r.json === 'function' ? r.json() : JSON.parse(await r.text());
}
export async function fetchPublicPaperCandidates({ now = Date.now(), fetchImpl = globalThis.fetch, limit = 300 } = {}) {
  const body = await publicJson(`/v1/events?active=true&closed=false&limit=${limit}`, fetchImpl), events = Array.isArray(body?.events) ? body.events : [];
  const out = [];
  for (const event of events) for (const market of Array.isArray(event?.markets) ? event.markets : []) {
    const base = { eventSlug: String(event.slug || event.id || ''), resolutionRule: String(market.resolutionRule || event.resolutionRule || market.resolution || event.resolution || ''), etaMinutes: n(market.etaMinutes ?? event.etaMinutes, null) };
    const rows = Array.isArray(market.outcomes) ? market.outcomes : [market];
    for (const row of rows) {
      const ask = n(row.bestAsk ?? row.ask ?? row.price ?? market.bestAsk ?? market.price), bid = n(row.bestBid ?? row.bid ?? ask ?? market.bestBid);
      if (!(ask > 0 && ask < 1 && bid > 0)) continue;
      out.push({ ...base, key: `${base.eventSlug}:${row.symbol || row.outcome || market.symbol || market.slug}`, symbol: String(row.symbol || market.symbol || market.slug || ''), side: String(row.side || row.outcome || ''), bid, ask, depthUsd: n(row.depthUsd ?? market.depthUsd ?? market.openInterest, 0), feePerContract: n(row.feePerContract ?? market.feePerContract ?? market.feeCoefficient, null), quoteAt: n(row.quoteAt ?? market.quoteAt ?? now), comboEnabled: market.comboEnabled === true });
    }
  }
  return { source: 'polymarket-public-events', at: now, candidates: out.filter(x => x.comboEnabled || x.eventSlug).slice(0, 500) };
}

export async function runPaperComboCycle({ dataDir, now = Date.now(), fetchCandidates = fetchPublicPaperCandidates } = {}) {
  let ledger = loadPaperComboLedger(dataDir, { now }); if (ledger.recoveryRequired) return paperComboSnapshot({ ledger, now });
  const t = ledger.telemetry = { ...ledger.telemetry, loopStatus: 'RUNNING', lastTickAt: now, rejections: {}, candidatesChecked: [] };
  let feed;
  try { feed = await fetchCandidates({ now }); } catch (e) { t.loopStatus = 'BLOCKED'; t.lastDecision = { at: now, action: 'WAIT', reason: `public feed unavailable: ${String(e?.message || e).slice(0, 160)}` }; ledger.lastError = t.lastDecision.reason; savePaperComboLedger(dataDir, ledger); return paperComboSnapshot({ ledger, now }); }
  const candidates = (feed?.candidates || []).map(x => normalizeLeg(x, now)); t.source = feed?.source || 'public-observed'; t.candidates = candidates.length; t.candidatesChecked = candidates.slice(0, 50).map(x => x.key); t.freshnessMs = candidates.length ? Math.max(...candidates.map(x => now - x.quoteAt)) : null;
  const eligible = candidates.filter(x => validatePaperComboLegs([x, { ...x, eventSlug: `${x.eventSlug}-pair`, key: `${x.key}-pair` }], { settings: ledger.settings, now }).reasons.length === 0);
  t.eligible = eligible.length;
  if (ledger.settings.autopilot && eligible.length >= 2 && ledger.open.length < ledger.settings.maxOpenCombos) {
    const groups = new Map(); for (const x of eligible) { const row = groups.get(x.eventSlug) || []; row.push(x); groups.set(x.eventSlug, row); }
    const picked = [...groups.values()].map(rows => rows.sort((a, b) => rankPaperLeg(b, ledger.settings) - rankPaperLeg(a, ledger.settings))[0]).slice(0, ledger.settings.maxLegs);
    const distinct = [...new Set(picked.map(x => x.eventSlug))];
    if (picked.length >= 2 && distinct.length === picked.length) { try { placePaperCombo({ dataDir, legs: picked, stakeUsd: stakeFor(ledger), now }); } catch (e) { reject(t, e.code || String(e.message).slice(0, 80)); } }
  } else if (!ledger.settings.autopilot) t.lastDecision = { at: now, action: 'WAIT', reason: 'paper autopilot disabled' };
  t.loopStatus = 'IDLE'; ledger.updatedAt = now; savePaperComboLedger(dataDir, ledger); return paperComboSnapshot({ dataDir, ledger, now });
}
export function paperComboSnapshot({ dataDir, ledger = loadPaperComboLedger(dataDir), now = Date.now() } = {}) { return { schema: PAPER_COMBO_SCHEMA, at: now, isolated: true, realAccess: false, credentialsRequired: false, settings: ledger.settings, settingsHash: ledger.settingsHash, budgetUsd: ledger.startBudgetUsd, cashUsd: ledger.cashUsd, reservedUsd: ledger.reservedUsd, open: ledger.open.slice(0, 50), history: ledger.history.slice(0, 50), realizedPnlUsd: ledger.realizedPnlUsd, telemetry: ledger.telemetry, recoveryRequired: !!ledger.recoveryRequired, recoveryReason: ledger.recoveryReason || null, lastError: ledger.lastError || null, safety: { signedCalls: false, realJournal: false, realOrders: false, unknownOutcomesRemainOpen: true } }; }

let timer = null;
export function startPaperComboLoop({ dataDir, tickMs = 15_000 } = {}) { if (timer || String(process.env.POLYMARKET_PAPER_AUTOSTART ?? 'true').toLowerCase() === 'false') return timer; timer = setInterval(() => runPaperComboCycle({ dataDir }).catch(() => {}), Math.max(5_000, tickMs)); timer.unref?.(); runPaperComboCycle({ dataDir }).catch(() => {}); return timer; }
export function stopPaperComboLoop() { if (timer) clearInterval(timer); timer = null; }
export const paperComboLoopRunning = () => !!timer;
