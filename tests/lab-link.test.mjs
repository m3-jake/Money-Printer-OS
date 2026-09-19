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
const championDoc = (c, now, extra = {}) => ({ schema: LAB_LINK_SCHEMA.champion, labNodeId: 'lab-1', labName: 'WITCHDOCTOR', labVersion: '0.1.0', publishedAt: now, generation: 42, variantsTested: 9000, champion: c, liveActivationAllowed: false, automaticLivePromotionAllowed: false, ...extra });
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
