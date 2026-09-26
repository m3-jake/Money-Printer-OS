// Lab link: how this trader talks to the Money Printer Evolution Lab (a separate app that
// runs on the research workhorse) now that the evolution service no longer lives in-process.
//
//   inbound   <data>/lab-link/status.json, champion.json   (lab on this machine)
//             <bridge>/lab-link/status.json, champion.json  (lab on another machine, HMAC-signed)
//   outbound  <data>/lab-link/dataset.json, trader-status.json          (for a lab on this machine)
//             <bridge>/lab-feed/<node>.dataset.json, <node>.trader-status.json (signed, for a remote lab)
//
// The trader never scores variants. It re-validates every champion with evolutionChampionPolicy
// (same gates as before), applies it only in paper mode, and live activation stays manual. This
// replaces the evolution-sync action queue that filled the Windows disk on 2026-09-18.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const LAB_LINK_SCHEMA = { status: 'mpo.lab-status.v1', champion: 'mpo.lab-champion.v1', dataset: 'mpo.lab-dataset.v1', trader: 'mpo.lab-trader-status.v1' };
export const LOCAL_FRESH_MS = 5 * 60_000;
export const BRIDGE_FRESH_MS = 30 * 60_000;
export const DATASET_LOCAL_MS = 60_000;
export const DATASET_BRIDGE_MS = 5 * 60_000;
export const TRADER_STATUS_MS = 60_000;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

const dataDir = () => path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data');
const bridgeDir = () => String(process.env.MONEY_PRINTER_BRIDGE_DIR || '').trim();
const bridgeKey = () => String(process.env.MONEY_PRINTER_BRIDGE_KEY || '').trim();
export const traderNodeId = () => process.env.MONEY_PRINTER_NODE_ID || crypto.createHash('sha1').update(os.hostname()).digest('hex').slice(0, 10);
export const traderNodeName = () => process.env.MONEY_PRINTER_NODE_NAME || os.hostname();

export function readJson(file) {
  try {
    if (fs.statSync(file).size > MAX_RECORD_BYTES) return null;
    const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, file); return true; }
  catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}
export function signRecord(value, key) {
  const payload = JSON.stringify(value);
  return { payload, signature: crypto.createHmac('sha256', String(key)).update(payload).digest('hex') };
}
export function verifyRecord(record, key) {
  if (!record || typeof record.payload !== 'string' || typeof record.signature !== 'string' || !key) return null;
  const expected = crypto.createHmac('sha256', String(key)).update(record.payload).digest('hex');
  if (record.signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(record.signature))) return null;
  try { const v = JSON.parse(record.payload); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

// ---------------------------------------------------------------- inbound
const finite = x => { const n = Number(x); return Number.isFinite(n) ? n : null; };
function validChampion(doc) {
  if (!doc || doc.schema !== LAB_LINK_SCHEMA.champion) return null;
  if (typeof doc.labNodeId !== 'string' || !doc.labNodeId.trim()) return null;
  const c = doc.champion;
  if (!c || typeof c !== 'object' || !c.id || !c.variant || typeof c.variant !== 'object' || !c.metrics || typeof c.metrics !== 'object') return null;
  if (doc.liveActivationAllowed === true || doc.automaticLivePromotionAllowed === true) return null; // never trust a record that claims live authority
  return doc;
}
function validStatus(doc) {
  return doc && doc.schema === LAB_LINK_SCHEMA.status && typeof doc.labNodeId === 'string' && doc.labNodeId.trim() && Number.isFinite(Number(doc.updatedAt)) ? doc : null;
}

// Reads the lab's publications and picks the freshest trustworthy source.
export function readLabLink({ dir = dataDir(), bridge = bridgeDir(), key = bridgeKey(), now = Date.now() } = {}) {
  const candidates = [];
  const localStatus = validStatus(readJson(path.join(dir, 'lab-link', 'status.json')));
  const localChampion = validChampion(readJson(path.join(dir, 'lab-link', 'champion.json')));
  if (localStatus || localChampion) candidates.push({ source: 'local', status: localStatus, champion: localChampion, freshMs: LOCAL_FRESH_MS });
  if (bridge && key) {
    const bs = validStatus(verifyRecord(readJson(path.join(bridge, 'lab-link', 'status.json')), key));
    const bc = validChampion(verifyRecord(readJson(path.join(bridge, 'lab-link', 'champion.json')), key));
    if (bs || bc) candidates.push({ source: 'bridge', status: bs, champion: bc, freshMs: BRIDGE_FRESH_MS });
  }
  if (!candidates.length) return { connected: false, source: 'none', status: null, champion: null, ageMs: null };
  // Keep status and champion on the same source. A disconnected source has no policy authority.
  const fresh = candidate => candidate.status && now >= Number(candidate.status.updatedAt) && now - Number(candidate.status.updatedAt) <= candidate.freshMs;
  candidates.sort((a, b) => Number(!!fresh(b)) - Number(!!fresh(a)) || Number(b.status?.updatedAt || 0) - Number(a.status?.updatedAt || 0));
  const best = candidates[0];
  const ageMs = best.status ? now - Number(best.status.updatedAt) : null;
  const connected = ageMs != null && ageMs >= 0 && ageMs <= best.freshMs;
  const champion = connected && best.champion?.labNodeId === best.status?.labNodeId ? best.champion : null;
  return { connected, source: best.source, status: best.status, champion, ageMs };
}

// Family champions (batch 13): <data>/lab-link/champion-<family>.json, or the signed bridge copy. Same
// mpo.lab-champion.v1 schema with `family`, flat `params`/`paramsHash` and the Lab's `evidence`. Capped at 64 KB;
// the family's own module decides whether the evidence is good enough. Freshest valid source wins.
export const FAMILY_CHAMPION_MAX_BYTES = 64 * 1024;
const FAMILY_RE = /^[a-z0-9-]{1,40}$/;
function validFamilyChampion(doc, family) {
  if (!doc || doc.schema !== LAB_LINK_SCHEMA.champion || doc.family !== family) return null;
  if (typeof doc.labNodeId !== 'string' || !doc.labNodeId.trim() || typeof doc.paramsHash !== 'string') return null;
  if (!doc.params || typeof doc.params !== 'object' || Array.isArray(doc.params) || !doc.evidence || typeof doc.evidence !== 'object') return null;
  if (doc.liveActivationAllowed === true || doc.automaticLivePromotionAllowed === true) return null;
  return Number.isFinite(Number(doc.publishedAt)) ? doc : null;
}
export function readFamilyChampion(family, { dir = dataDir(), bridge = bridgeDir(), key = bridgeKey() } = {}) {
  if (!FAMILY_RE.test(String(family || ''))) return null;
  const small = file => { try { return fs.statSync(file).size <= FAMILY_CHAMPION_MAX_BYTES ? readJson(file) : null; } catch { return null; } };
  const found = [];
  const local = validFamilyChampion(small(path.join(dir, 'lab-link', `champion-${family}.json`)), family);
  if (local) found.push({ ...local, source: 'local' });
  if (bridge && key) {
    const remote = validFamilyChampion(verifyRecord(small(path.join(bridge, 'lab-link', `champion-${family}.json`)), key), family);
    if (remote) found.push({ ...remote, source: 'bridge' });
  }
  return found.sort((a, b) => Number(b.publishedAt) - Number(a.publishedAt))[0] || null;
}

// The evolutionLoop view the dashboard/control plane already understand, built from lab records.
export function loopViewFromLab(status, championDoc) {
  const st = status || {};
  const c = championDoc?.champion || null;
  return {
    enabled: true,
    source: 'evolution-lab',
    paperPromotionAllowed: championDoc?.paperPromotionAllowed === true,
    qualificationStage: championDoc?.qualificationStage || st.qualificationStage || 'RESEARCH_ONLY',
    labNodeId: st.labNodeId || championDoc?.labNodeId || null,
    labName: st.labName || championDoc?.labName || null,
    labVersion: st.labVersion || championDoc?.labVersion || null,
    status: st.status || (c ? 'RUNNING' : 'COLLECTING'),
    lastError: st.lastError || null,
    generation: Number(st.generation ?? championDoc?.generation ?? 0),
    activeGeneration: st.activeGeneration ?? null,
    variantsTested: Number(st.variantsTested ?? championDoc?.variantsTested ?? 0),
    survivors: Number(st.survivors || 0),
    researchMode: st.researchMode || 'NORMAL',
    researchProfile: st.researchProfile || null,
    beastProfile: st.beastProfile || null,
    workerCount: Number(st.workerCount || 0),
    currentBatchSize: Number(st.currentBatchSize || 0),
    currentBatchCompleted: Number(st.currentBatchCompleted || 0),
    currentBatchStatus: st.currentBatchStatus || null,
    nextGenerationProgress: Number(st.nextGenerationProgress || 0),
    lastGenerationMs: Number(st.lastGenerationMs || 0),
    lastGenerationCompletedAt: st.lastGenerationCompletedAt || null,
    datasetSamples: Number(st.datasetSamples ?? championDoc?.datasetSamples ?? 0),
    sealedSamples: Number(st.sealedSamples || 0),
    sealedSplit: st.sealedSplit || null,
    searchCoverage: st.searchCoverage || null,
    sealedValidation: st.sealedValidation || null,
    evidenceRecording: st.evidenceRecording || null,
    cluster: st.cluster || { enabled: false },
    champion: c ? { id: c.id, stage: c.stage || 'SHADOW', promotedAt: finite(c.promotedAt), previousId: c.previousId || null, variant: c.variant || null, metrics: c.metrics || {} } : null,
    challengers: Array.isArray(st.challengers) ? st.challengers.slice(0, 12).map(x => ({ id: x.id, parentId: x.parentId || null, stage: x.stage || 'RESEARCH', ...(x.metrics || {}) })) : [],
    events: Array.isArray(st.events) ? st.events.slice(0, 25) : [],
    history: Array.isArray(st.history) ? st.history.slice(0, 12) : [],
    updatedAt: Number(st.updatedAt || championDoc?.publishedAt || 0) || null,
  };
}

const outbound = { datasetLocalAt: 0, datasetBridgeAt: 0, statusAt: 0, datasetSig: '', bridgeSig: '' };
let lastApplied = { key: '', at: 0 };
export function resetLabLinkMemory() { lastApplied = { key: '', at: 0 }; outbound.datasetLocalAt = 0; outbound.datasetBridgeAt = 0; outbound.statusAt = 0; outbound.datasetSig = ''; outbound.bridgeSig = ''; }

// Called once per engine cycle. Cheap when nothing changed (two stats + small JSON reads).
export function syncLabLink(s, opts = {}) {
  const now = opts.now || Date.now();
  const link = readLabLink({ ...opts, now });
  s.labLink = {
    connected: link.connected, source: link.source, ageMs: link.ageMs,
    labNodeId: link.status?.labNodeId || link.champion?.labNodeId || null,
    labName: link.status?.labName || link.champion?.labName || null,
    labVersion: link.status?.labVersion || link.champion?.labVersion || null,
    generation: Number(link.status?.generation ?? link.champion?.generation ?? 0),
    status: link.status?.status || null,
    championId: link.champion?.champion?.id || null,
    championPublishedAt: link.champion?.publishedAt || null,
    paperPromotionAllowed: link.connected && link.champion?.paperPromotionAllowed === true,
    qualificationStage: link.champion?.qualificationStage || link.status?.qualificationStage || 'RESEARCH_ONLY',
    checkedAt: now,
  };
  if (!link.status && !link.champion) {
    const changed = !!s.evolutionLoop?.champion;
    if (s.evolutionLoop) {
      s.evolutionLoop = { ...s.evolutionLoop, champion: null, status: 'DISCONNECTED' };
      s.evolution = { ...(s.evolution || {}), loop: s.evolutionLoop };
    }
    lastApplied = { key: '', at: now };
    return changed;
  }
  const key = `${link.status?.updatedAt || 0}:${link.champion?.publishedAt || 0}:${link.champion?.champion?.id || ''}:${s.labLink.connected}:${s.labLink.paperPromotionAllowed}`;
  if (key === lastApplied.key) return false;
  lastApplied = { key, at: now };
  s.evolutionLoop = loopViewFromLab(link.status, link.champion);
  s.evolution = { ...(s.evolution || {}), loop: s.evolutionLoop };
  return true;
}

// ---------------------------------------------------------------- outbound
const usable = o => !!o && Number(o.horizonMin) === 5 && Number.isFinite(Number(o.returnPct)) && o.features && typeof o.features === 'object' && Number.isFinite(Number(o.ts));

export function datasetRecord(s, { nodeId = traderNodeId(), name = traderNodeName(), version = process.env.MONEY_PRINTER_VERSION || null, now = Date.now() } = {}) {
  const rows = (s?.research?.learner?.outcomes || []).filter(usable).map(o => ({ ts: o.ts, entryTs: o.entryTs, sampleKey: o.sampleKey, mint: o.mint, symbol: o.symbol, horizonMin: 5, entryPrice: o.entryPrice, exitPrice: o.exitPrice, returnPct: Number(o.returnPct), predicted: o.predicted, stage: o.stage, entryThreshold: o.entryThreshold, context: o.context || null, isValidation: !!o.isValidation, features: o.features }));
  return { schema: LAB_LINK_SCHEMA.dataset, nodeId, name, version, updatedAt: now, rows: rows.length, latestTs: rows.length ? Math.max(...rows.map(r => Number(r.ts))) : null, rows_: undefined, ...{ rows } };
}
export function traderStatusRecord(s, { nodeId = traderNodeId(), name = traderNodeName(), version = process.env.MONEY_PRINTER_VERSION || null, mode = 'paper', now = Date.now() } = {}) {
  const p = s?.portfolio || {};
  return { schema: LAB_LINK_SCHEMA.trader, nodeId, name, version, platform: process.platform, mode, updatedAt: now, equitySol: finite(p.equitySol), sessionPnlSol: finite(s?.dailyPnlSol), openPositions: Array.isArray(s?.positions) ? s.positions.length : 0, activeEvolutionChampionId: s?.runtime?.activeEvolutionChampionId || 'BASE', activeStage: s?.system?.activeEvolutionPolicy?.stage || 'BASE', labLink: s?.labLink ? { connected: !!s.labLink.connected, source: s.labLink.source } : null };
}

// Publishes the labeled dataset and a small status line for the lab, throttled and only when
// the dataset changed. Never blocks trading on a failed write.
export function publishLabFeed(s, { dir = dataDir(), bridge = bridgeDir(), key = bridgeKey(), now = Date.now(), mode = 'paper', force = false, version } = {}) {
  const out = { datasetLocal: false, datasetBridge: false, status: false };
  try {
    const outcomes = s?.research?.learner?.outcomes || [];
    const sig = `${outcomes.length}:${Number(outcomes[0]?.ts || 0)}`;
    const changed = sig !== outbound.datasetSig;
    const nodeId = traderNodeId(), name = traderNodeName();
    if ((force || (changed && now - outbound.datasetLocalAt >= DATASET_LOCAL_MS))) {
      const doc = datasetRecord(s, { nodeId, name, version, now });
      if (doc.rows.length) { writeJsonAtomic(path.join(dir, 'lab-link', 'dataset.json'), doc); outbound.datasetLocalAt = now; outbound.datasetSig = sig; out.datasetLocal = true; }
    }
    // The bridge copy has its own change marker so it catches up with the local file once its
    // (longer) window opens, instead of missing a change that happened between two windows.
    if (bridge && key && (force || (sig !== outbound.bridgeSig && now - outbound.datasetBridgeAt >= DATASET_BRIDGE_MS))) {
      const doc = datasetRecord(s, { nodeId, name, version, now });
      if (doc.rows.length) { writeJsonAtomic(path.join(bridge, 'lab-feed', `${nodeId}.dataset.json`), signRecord(doc, key)); outbound.datasetBridgeAt = now; outbound.bridgeSig = sig; out.datasetBridge = true; }
    }
    if (force || now - outbound.statusAt >= TRADER_STATUS_MS) {
      const st = traderStatusRecord(s, { nodeId, name, version, mode, now });
      writeJsonAtomic(path.join(dir, 'lab-link', 'trader-status.json'), st);
      if (bridge && key) writeJsonAtomic(path.join(bridge, 'lab-feed', `${nodeId}.trader-status.json`), signRecord(st, key));
      outbound.statusAt = now; out.status = true;
    }
  } catch (e) {
    out.error = String(e?.code || e?.message || e);
  }
  return out;
}
