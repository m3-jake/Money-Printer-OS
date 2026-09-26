// Lab link contract on the trader side: champions arrive from the lab (local files or the
// signed bridge), are re-validated by the same gates as before, and the trader publishes its
// labeled dataset without ever scoring anything itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-lab-link-'));
const DATA = path.join(DIR, 'data'), BRIDGE = path.join(DIR, 'bridge');
process.env.MONEY_PRINTER_DATA_DIR = DATA;
process.env.MONEY_PRINTER_BRIDGE_DIR = BRIDGE;
process.env.MONEY_PRINTER_BRIDGE_KEY = 'shared-secret';

const { readLabLink, syncLabLink, publishLabFeed, datasetRecord, resetLabLinkMemory, signRecord, verifyRecord, LAB_LINK_SCHEMA, LOCAL_FRESH_MS, BRIDGE_FRESH_MS } = await import('../src/labLink.js');
const { evolutionChampionPolicy } = await import('../src/learner.js');

const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v)); };
const goodChampion = (id = 'LAB-CHAMP', promotedAt = 5_000) => ({ id, stage: 'SHADOW', promotedAt, previousId: 'BASE', variant: { id, threshold: 62, stopPct: 1.5, takePct: 100, maxHoldMin: 2, weights: { edge: .05, explosion: .16, execution: .08, momentum: .34, liquidity: .08, freshness: .07, flow: .11, volumeAccel: .04, priceAccel: .07 } }, metrics: { heldOutN: 22, samples: 60, activityPct: 8.1, monteCarloPassPct: 100, stressAvgPct: 18, consistencyPct: 100, robustScore: 40 } });
const championDoc = (c, now, extra = {}) => ({ schema: LAB_LINK_SCHEMA.champion, labNodeId: 'lab-1', labName: 'WITCHDOCTOR', labVersion: '0.1.0', publishedAt: now, generation: 42, variantsTested: 9000, champion: c, paperPromotionAllowed: true, qualificationStage: 'PAPER_COMPARISON', liveActivationAllowed: false, automaticLivePromotionAllowed: false, stateSchema: 'mpo.champion-state.v1', state: 'PAPER', ...extra });
const statusDoc = (now, extra = {}) => ({ schema: LAB_LINK_SCHEMA.status, labNodeId: 'lab-1', labName: 'WITCHDOCTOR', labVersion: '0.1.0', updatedAt: now, status: 'RUNNING', generation: 42, variantsTested: 9000, workerCount: 24, researchMode: 'BEAST', challengers: Array.from({ length: 20 }, (_, i) => ({ id: `C${i}`, metrics: { robustScore: i } })), events: Array.from({ length: 40 }, (_, i) => ({ ts: i, type: 'INFO', message: 'm' })), ...extra });

test('no lab files means not connected, and the trader keeps its BASE policy', () => {
  resetLabLinkMemory();
  const s = { runtime: { activeEvolutionChampionId: 'BASE' } };
  assert.equal(syncLabLink(s, { now: 1_000 }), false);
  assert.equal(s.labLink.connected, false); assert.equal(s.labLink.source, 'none');
  assert.equal(s.evolutionLoop, undefined);
  assert.equal(evolutionChampionPolicy(s), null);
});

test('a local lab champion is applied through the existing gates and the loop view is compact', () => {
  resetLabLinkMemory();
  const now = 100_000;
  write(path.join(DATA, 'lab-link', 'status.json'), statusDoc(now - 1_000));
  write(path.join(DATA, 'lab-link', 'champion.json'), championDoc(goodChampion(), now - 2_000));
  const s = {};
  assert.equal(syncLabLink(s, { now }), true);
  assert.equal(s.labLink.connected, true); assert.equal(s.labLink.source, 'local'); assert.equal(s.labLink.labName, 'WITCHDOCTOR');
  assert.equal(s.evolutionLoop.source, 'evolution-lab'); assert.equal(s.evolutionLoop.generation, 42);
  assert.equal(s.evolutionLoop.challengers.length, 12); assert.equal(s.evolutionLoop.events.length, 25);
  const p = evolutionChampionPolicy(s);
  assert.equal(p.id, 'LAB-CHAMP'); assert.equal(p.threshold, 62); assert.equal(p.takePct, 100);
  assert.equal(syncLabLink(s, { now: now + 500 }), false, 'unchanged publications are not re-applied');
  // A weak champion from the lab is still refused by the trader's own gates.
  write(path.join(DATA, 'lab-link', 'champion.json'), championDoc(goodChampion('WEAK', 6_000), now, {}));
  fs.writeFileSync(path.join(DATA, 'lab-link', 'champion.json'), JSON.stringify(championDoc({ ...goodChampion('WEAK', 6_000), metrics: { ...goodChampion().metrics, heldOutN: 3 } }, now)));
  assert.equal(syncLabLink(s, { now: now + 1_000 }), true);
  assert.equal(evolutionChampionPolicy(s), null, 'gates are enforced by the trader, not trusted from the lab');
  // A record that claims live authority is rejected outright.
  fs.writeFileSync(path.join(DATA, 'lab-link', 'champion.json'), JSON.stringify(championDoc(goodChampion('EVIL', 7_000), now, { liveActivationAllowed: true })));
  assert.equal(readLabLink({ now: now + 2_000 }).champion, null);
});

test('stale local status hands over to a fresher signed bridge; bad signatures are ignored', () => {
  resetLabLinkMemory();
  const now = 1_000_000;
  write(path.join(DATA, 'lab-link', 'status.json'), statusDoc(now - LOCAL_FRESH_MS - 10_000, { generation: 1 }));
  fs.rmSync(path.join(DATA, 'lab-link', 'champion.json'), { force: true });
  write(path.join(BRIDGE, 'lab-link', 'status.json'), signRecord(statusDoc(now - 30_000, { generation: 77 }), 'shared-secret'));
  write(path.join(BRIDGE, 'lab-link', 'champion.json'), signRecord(championDoc(goodChampion('BRIDGE-CHAMP'), now - 40_000), 'shared-secret'));
  let link = readLabLink({ now });
  assert.equal(link.source, 'bridge'); assert.equal(link.connected, true); assert.equal(link.status.generation, 77); assert.equal(link.champion.champion.id, 'BRIDGE-CHAMP');
  write(path.join(BRIDGE, 'lab-link', 'champion.json'), signRecord(championDoc(goodChampion('FORGED'), now), 'other-key'));
  link = readLabLink({ now });
  assert.equal(link.champion, null, 'forged bridge champion is dropped');
  write(path.join(BRIDGE, 'lab-link', 'status.json'), signRecord(statusDoc(now - BRIDGE_FRESH_MS - 1, { generation: 78 }), 'shared-secret'));
  link = readLabLink({ now });
  assert.equal(link.connected, false, 'a lab silent for over 30 minutes is reported as not connected');
  assert.equal(verifyRecord(signRecord({ a: 1 }, 'k'), 'k').a, 1);
});

test('stale or forged publications cannot retain a policy or smuggle one through status', () => {
  resetLabLinkMemory();
  const dir = path.join(DIR, 'authority');
  const now = 1_000_000;
  write(path.join(dir, 'lab-link', 'status.json'), statusDoc(now, { champion: goodChampion('STATUS-INJECTION') }));
  write(path.join(dir, 'lab-link', 'champion.json'), championDoc(goodChampion('VALID'), now));
  const s = {};
  syncLabLink(s, { dir, bridge: '', now });
  assert.equal(evolutionChampionPolicy(s).id, 'VALID');
  syncLabLink(s, { dir, bridge: '', now: now + LOCAL_FRESH_MS + 1 });
  assert.equal(s.labLink.connected, false);
  assert.equal(evolutionChampionPolicy(s), null, 'losing the lab heartbeat revokes the prior policy');
  assert.equal(s.evolutionLoop.champion, null, 'status cannot restore a rejected champion');
  write(path.join(dir, 'lab-link', 'champion.json'), championDoc(goodChampion('OTHER-LAB'), now, { labNodeId: 'different-lab' }));
  assert.equal(readLabLink({ dir, bridge: '', now }).champion, null);
  assert.equal(readLabLink({ dir, bridge: '', now: now - 1 }).connected, false, 'a future heartbeat is not fresh evidence');
  write(path.join(dir, 'lab-link', 'status.json'), statusDoc(now, { labNodeId: undefined }));
  write(path.join(dir, 'lab-link', 'champion.json'), championDoc(goodChampion('NO-ID'), now, { labNodeId: undefined }));
  assert.equal(readLabLink({ dir, bridge: '', now }).champion, null);
  fs.rmSync(path.join(dir, 'lab-link', 'status.json'));
  fs.rmSync(path.join(dir, 'lab-link', 'champion.json'));
  s.evolutionLoop.champion = goodChampion('PREVIOUS');
  assert.equal(syncLabLink(s, { dir, bridge: '', now }), true);
  assert.equal(s.evolutionLoop.champion, null, 'deleting all publications revokes the displayed champion too');
});

test('a future local heartbeat cannot mask a fresh authenticated bridge', () => {
  const dir = path.join(DIR, 'future-local'), bridge = path.join(DIR, 'valid-bridge');
  const now = 1_500_000;
  write(path.join(dir, 'lab-link', 'status.json'), statusDoc(now + 60_000));
  write(path.join(bridge, 'lab-link', 'status.json'), signRecord(statusDoc(now - 1_000), 'key'));
  write(path.join(bridge, 'lab-link', 'champion.json'), signRecord(championDoc(goodChampion('BRIDGE'), now - 2_000), 'key'));
  const link = readLabLink({ dir, bridge, key: 'key', now });
  assert.equal(link.connected, true);
  assert.equal(link.source, 'bridge');
  assert.equal(link.champion.champion.id, 'BRIDGE');
});

test('research-only and legacy champions remain visible but never replace the paper incumbent', () => {
  const dir = path.join(DIR, 'unqualified');
  const now = 1_800_000;
  write(path.join(dir, 'lab-link', 'status.json'), statusDoc(now));
  const s = {};
  for (const allowed of [undefined, false]) {
    resetLabLinkMemory();
    write(path.join(dir, 'lab-link', 'champion.json'), championDoc(goodChampion('RESEARCH'), now, { paperPromotionAllowed: allowed, qualificationStage: 'RESEARCH_ONLY' }));
    syncLabLink(s, { dir, bridge: '', now });
    assert.equal(s.labLink.connected, true);
    assert.equal(s.evolutionLoop.champion.id, 'RESEARCH');
    assert.equal(evolutionChampionPolicy(s), null);
    assert.equal(evolutionChampionPolicy({ evolutionLoop: s.evolutionLoop }), null);
  }
});

test('the trader publishes only usable 5m rows, throttled, plus a signed bridge copy', () => {
  resetLabLinkMemory();
  const now = 2_000_000;
  const outcomes = [
    { ts: 10, entryTs: 5, sampleKey: 'M1:0', mint: 'M1', horizonMin: 5, returnPct: 3.5, features: { edge: .3 }, predicted: 50 },
    { ts: 11, entryTs: 6, sampleKey: 'M1:0', mint: 'M1', horizonMin: 30, returnPct: 9, features: { edge: .3 } },
    { ts: 12, entryTs: 7, sampleKey: 'M2:0', mint: 'M2', horizonMin: 5, returnPct: 'bad', features: { edge: .1 } },
    { ts: 13, entryTs: 8, sampleKey: 'M3:0', mint: 'M3', horizonMin: 5, returnPct: -2, features: null },
  ];
  const s = { research: { learner: { outcomes } }, portfolio: { equitySol: 1.5 }, positions: [], runtime: { activeEvolutionChampionId: 'LAB-CHAMP' }, system: { activeEvolutionPolicy: { stage: 'PAPER_CANARY' } } };
  const rec = datasetRecord(s, { nodeId: 'n1', name: 'MAC', now });
  assert.equal(rec.schema, LAB_LINK_SCHEMA.dataset); assert.equal(rec.rows.length, 1); assert.equal(rec.rows[0].mint, 'M1');
  let out = publishLabFeed(s, { now, mode: 'paper' });
  assert.equal(out.datasetLocal, true); assert.equal(out.datasetBridge, true); assert.equal(out.status, true);
  const local = JSON.parse(fs.readFileSync(path.join(DATA, 'lab-link', 'dataset.json'), 'utf8'));
  assert.equal(local.rows.length, 1);
  const bridgeName = fs.readdirSync(path.join(BRIDGE, 'lab-feed')).find(n => n.endsWith('.dataset.json'));
  assert.ok(bridgeName);
  assert.equal(verifyRecord(JSON.parse(fs.readFileSync(path.join(BRIDGE, 'lab-feed', bridgeName), 'utf8')), 'shared-secret').rows.length, 1);
  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'lab-link', 'trader-status.json'), 'utf8'));
  assert.equal(st.schema, LAB_LINK_SCHEMA.trader); assert.equal(st.activeEvolutionChampionId, 'LAB-CHAMP'); assert.equal(st.mode, 'paper');
  out = publishLabFeed(s, { now: now + 5_000, mode: 'paper' });
  assert.deepEqual([out.datasetLocal, out.datasetBridge, out.status], [false, false, false], 'nothing changed: nothing written');
  outcomes.unshift({ ts: 20, entryTs: 15, sampleKey: 'M9:0', mint: 'M9', horizonMin: 5, returnPct: 1, features: { edge: .9 } });
  out = publishLabFeed(s, { now: now + 61_000, mode: 'paper' });
  assert.equal(out.datasetLocal, true);
  assert.equal(out.datasetBridge, false, 'bridge copy waits for its own 5 minute window');
  out = publishLabFeed(s, { now: now + 6 * 60_000, mode: 'paper' });
  assert.equal(out.datasetBridge, true);
});

test('trader status still refreshes when the bulky local dataset write fails', () => {
  resetLabLinkMemory();
  const dir=path.join(DIR,'status-survives-dataset-failure');
  fs.mkdirSync(path.join(dir,'lab-link','dataset.json'),{recursive:true});
  const s={research:{learner:{outcomes:[{ts:10,entryTs:5,sampleKey:'M1:0',mint:'M1',horizonMin:5,returnPct:1,features:{edge:.2}}]}},portfolio:{equitySol:1},positions:[],runtime:{activeEvolutionChampionId:'BASE'},system:{activeEvolutionPolicy:{stage:'BASE'}}};
  const out=publishLabFeed(s,{dir,bridge:'',now:3_000_000,mode:'paper',force:true});
  assert.equal(out.datasetLocal,false);assert.equal(out.status,true);assert.ok(out.errors.some(x=>x.startsWith('dataset-local:')));
  const st=JSON.parse(fs.readFileSync(path.join(dir,'lab-link','trader-status.json'),'utf8'));
  assert.equal(st.equitySol,1);assert.equal(st.openPositions,0);assert.equal(st.mode,'paper');
});

test('engine wiring: the lab link runs every cycle, the feed is published, and no scorer ships', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  assert.match(src, /import \{ syncLabLink, publishLabFeed \} from '\.\/labLink\.js'/);
  const cycleAt = src.indexOf('async function cycle()');
  const syncAt = src.indexOf('syncLabLink(s)', cycleAt);
  const policyAt = src.indexOf("const hotPolicy=cfg.mode==='paper'?evolutionChampionPolicy(s):null", cycleAt);
  assert.ok(syncAt > cycleAt && syncAt < policyAt, 'the lab link is synced before the champion policy is resolved');
  assert.match(src, /publishLabFeed\(s, \{ mode: cfg\.mode/);
  for (const gone of ['evolutionEngine.js', 'evolutionLoop.js', 'evolutionPool.js', 'evolutionScoring.js', 'evolutionGpu.js', 'clusterHub.js', 'researchAudit.js']) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'src', gone)), `${gone} must live in the Evolution Lab, not the trader`);
  }
  const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  assert.doesNotMatch(main, /evolutionLoop\.js|clusterHub\.js|researchAudit\.js/);
  assert.doesNotMatch(main, /start\('evolution'\)/);
});

test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

test('champion gate pins: PAPER_CANARY without promotion, a missing field, a foreign labNodeId and a stale bridge all give no policy', () => {
  const dir = path.join(DIR, 'pins'), now = 2_500_000;
  const canary = { ...goodChampion('CANARY'), stage: 'PAPER_CANARY' };
  const run = (champ, st = statusDoc(now)) => { resetLabLinkMemory(); write(path.join(dir, 'lab-link', 'status.json'), st); write(path.join(dir, 'lab-link', 'champion.json'), champ); const s = {}; syncLabLink(s, { dir, bridge: '', now }); return s; };
  // The same champion with promotion allowed is a policy, so each refusal below is the gate, not the fixture.
  assert.equal(evolutionChampionPolicy(run(championDoc(canary, now))).id, 'CANARY');
  assert.equal(evolutionChampionPolicy(run(championDoc(canary, now, { paperPromotionAllowed: false, qualificationStage: 'PAPER_CANARY' }))), null, 'PAPER_CANARY stage alone grants nothing');
  const missing = championDoc(canary, now); delete missing.paperPromotionAllowed;
  assert.equal(evolutionChampionPolicy(run(missing)), null, 'a missing paperPromotionAllowed is not true');
  const foreign = run(championDoc(canary, now, { labNodeId: 'lab-OTHER' }));
  assert.equal(foreign.labLink.championId, null); assert.equal(evolutionChampionPolicy(foreign), null, 'champion from a different lab node than the status');
  // Bridge only (no local files): a status older than BRIDGE_FRESH_MS is disconnected and carries no champion.
  const bdir = path.join(DIR, 'pins-bridge'), empty = path.join(DIR, 'pins-empty');
  write(path.join(bdir, 'lab-link', 'status.json'), signRecord(statusDoc(now - BRIDGE_FRESH_MS - 1), 'shared-secret'));
  write(path.join(bdir, 'lab-link', 'champion.json'), signRecord(championDoc(canary, now - BRIDGE_FRESH_MS - 1), 'shared-secret'));
  const link = readLabLink({ dir: empty, bridge: bdir, key: 'shared-secret', now });
  assert.equal(link.source, 'bridge'); assert.equal(link.connected, false); assert.equal(link.champion, null);
  resetLabLinkMemory(); const s = {}; syncLabLink(s, { dir: empty, bridge: bdir, key: 'shared-secret', now });
  assert.equal(s.labLink.connected, false); assert.equal(s.labLink.paperPromotionAllowed, false); assert.equal(evolutionChampionPolicy(s), null);
});
