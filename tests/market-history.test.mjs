import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { marketHistory, marketGroups, marketQuotes, contractCoverage, classifyContract, sessionCloseMs, buildSeries, closeMarketHistoryHandles, handleMarketQuotesRequest, handleMarketHistoryRequest, LIMITS } from '../src/marketHistory.js';
import { commandCenterSummary, summarizeLeaderReplay, createBuildCache } from '../src/commandCenter.js';

const NOW = 1791000000000, MIN = 60000, H = 3600e3;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-history-'));
const ctx = { dataDir: dir, json: () => {} };
const line = r => JSON.stringify(r) + '\n';
const tapeFile = path.join(dir, 'robinhood-tape', 'BTC-USD.ndjson');
const m0 = Math.floor((NOW - 3 * H) / MIN) * MIN;

function fixture() {
  fs.mkdirSync(path.join(dir, 'robinhood-tape'), { recursive: true });
  let text = '';
  // one candle minute expanded to four samples (only :45 is a close), then live quotes every 15 s, then a 1 h hole
  for (const s of [0, 15, 30, 45]) text += line({ t: m0 + s * 1000, bid: 100 + s, ask: 100 + s, src: 'coinbase-candles' });
  for (let i = 0; i < 40; i++) text += line({ t: m0 + MIN + i * 15000, bid: 200 + i, ask: 201 + i, src: 'robinhood' });
  const after = m0 + MIN + 40 * 15000 + H;
  for (let i = 0; i < 20; i++) text += line({ t: after + i * 15000, bid: 300 + i, ask: 300.5 + i, src: 'coinbase-public-paper' });
  text += line({ t: m0 + MIN + 7500, bid: 250, ask: 251, src: 'robinhood' }); // out-of-order backfill
  text += 'not json\n' + line({ t: m0 + 2 * MIN, bid: 5, ask: 4 }); // malformed and crossed rows are ignored
  fs.writeFileSync(tapeFile, text);
  fs.mkdirSync(path.join(dir, 'robinhood-equities'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'robinhood-equities', 'bars.json'), JSON.stringify({ provider: 'alpaca', lastSession: '2026-09-30', fetchedAt: NOW, bars: { SPY: [
    { d: '2026-01-05', o: 1, h: 3, l: 0.5, c: 2, v: 1 }, { d: '2026-01-06', o: 2, h: 4, l: 1, c: 3, v: 1 },
    { d: '2026-01-20', o: 3, h: 5, l: 2, c: 4, v: 1 }, { d: '2026-07-01', o: 4, h: 6, l: 3, c: 5, v: 1 } ] } }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ tickHistory: { MINT1: [{ ts: NOW - 2 * MIN, price: 0.001, liq: 5 }, { ts: NOW - MIN, price: 0.0012 }] } }));
  const db = new DatabaseSync(path.join(dir, 'mpos-core.sqlite'));
  db.exec(`CREATE TABLE entities(id TEXT PRIMARY KEY, kind TEXT NOT NULL, provider TEXT NOT NULL, source_id TEXT NOT NULL, observed_at INTEGER NOT NULL, available_at INTEGER NOT NULL, source_url TEXT, fact INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX entities_kind ON entities(kind,provider,available_at);
    CREATE TABLE entity_versions(id TEXT NOT NULL, observed_at INTEGER NOT NULL, available_at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id,observed_at));`);
  const put = (provider, sid, data, versions) => {
    const id = `contract:${provider}:${sid}`, last = versions.at(-1);
    db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)').run(id, 'Contract', provider, sid, last.o, last.a, null, 1, JSON.stringify({ ...data, yesBid: last.b, yesAsk: last.k, quoteSource: 'market-metadata', quoteExecutable: false, status: 'ACTIVE' }));
    for (const v of versions) db.prepare('INSERT INTO entity_versions VALUES(?,?,?,?)').run(id, v.o, v.a, JSON.stringify({ id, availableAt: v.a, observedAt: v.o, data: { ...data, yesBid: v.b, yesAsk: v.k, quoteSource: 'market-metadata', quoteExecutable: false } }));
  };
  put('kalshi', 'KXHIGHNY-26OCT01-B70', { title: 'NY high 70?', eventId: 'event:kalshi:KXHIGHNY-26OCT01' }, [{ o: NOW - 30 * H, a: NOW - 30 * H + 5, b: 0.2, k: 0.3 }, { o: NOW - 2 * H, a: NOW - 2 * H + 5, b: 0.2, k: 0.3 }, { o: NOW - 10 * MIN, a: NOW - 10 * MIN + 7, b: 0.4, k: 0.5 }]);
  put('kalshi', 'KXNFLGAME-26OCT04KCBUF-KC', { title: 'KC win?', eventId: 'event:kalshi:KXNFLGAME-26OCT04KCBUF' }, [{ o: NOW - 5 * H, a: NOW - 5 * H, b: null, k: 0.6 }]);
  put('polymarket', '111', { title: 'Will Bitcoin reach $100,000 by December 31, 2026?', eventId: 'event:polymarket:9' }, [{ o: NOW - 26 * H, a: NOW - 26 * H, b: 0.1, k: 0.12 }, { o: NOW - MIN, a: NOW - MIN, b: 0.15, k: 0.17 }]);
  put('polymarket', '222', { title: 'Something nobody can classify', eventId: 'event:polymarket:10' }, [{ o: NOW - MIN, a: NOW - MIN, b: null, k: null }]);
  db.close();
}
fixture();
test.after(() => { closeMarketHistoryHandles(); fs.rmSync(dir, { recursive: true, force: true }); });

test('crypto tape keeps per-point provenance, candle closes only, and no invented points', async () => {
  const r = await marketHistory(ctx, { ids: ['crypto:BTC-USD'], points: 2000 }), s = r.series[0];
  assert.equal(s.unit, 'USD'); assert.deepEqual(r.fields, ['t', 'bid', 'ask', 'mid', 'availableAt', 'src', 'lo', 'hi', 'n']);
  const names = s.sources.map(x => x.id);
  const candles = s.points.filter(p => names[p[5]] === 'coinbase-candles');
  assert.equal(candles.length, 1, 'only the :45 close survives'); assert.equal(candles[0][0], m0 + 45000); assert.equal(candles[0][4], m0 + MIN, 'available at minute end');
  assert.equal(s.sources.find(x => x.id === 'coinbase-candles').quote, false); assert.equal(s.sources.find(x => x.id === 'robinhood').quote, true);
  assert.equal(s.coverage.raw, 1 + 40 + 20 + 1); assert.equal(s.coverage.downsample, 'none');
  const raw = new Set(fs.readFileSync(tapeFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l).t; } catch { return null; } }));
  for (const p of s.points) assert.ok(raw.has(p[0]), 'every timestamp is a stored observation');
  for (let i = 1; i < s.points.length; i++) assert.ok(s.points[i][0] > s.points[i - 1][0]);
  const live = s.points.find(p => names[p[5]] === 'robinhood'); assert.equal(live[4], live[0]); assert.equal(live[3], (live[1] + live[2]) / 2);
  assert.ok(s.gaps.some(g => g[2] === 'no-observation' && g[1] - g[0] >= H), 'the hour without quotes is reported');
});

test('downsampling is bounded, keeps the last real observation per bucket and its range', async () => {
  const r = await marketHistory(ctx, { ids: ['crypto:BTC-USD'], points: 5 }), s = r.series[0];
  assert.ok(s.points.length <= 5 + 1); assert.equal(s.coverage.downsample, 'last-in-bucket'); assert.equal(s.coverage.raw, 62);
  assert.equal(s.points.reduce((n, p) => n + p[8], 0), 62, 'bucket counts add up to raw');
  for (const p of s.points) assert.ok(p[6] <= p[3] && p[3] <= p[7]);
  assert.equal(s.points.at(-1)[1], 319, 'last bucket ends on the newest quote');
  const many = await marketHistory(ctx, { ids: Array.from({ length: 64 }, (_, i) => i ? 'pump:M' + i : 'crypto:BTC-USD'), points: 5000 });
  assert.equal(many.query.points, Math.floor(LIMITS.totalPoints / 64)); assert.equal(many.query.budgetLimited, true);
  assert.equal((await marketHistory(ctx, { ids: Array.from({ length: 65 }, (_, i) => 'pump:' + i) })).status, 400);
});

test('the tape is read incrementally and restarts after compaction', async () => {
  const before = (await marketHistory(ctx, { ids: ['crypto:BTC-USD'], points: 2000 })).series[0].coverage.raw;
  const t = m0 + 5 * H;
  fs.appendFileSync(tapeFile, line({ t, bid: 400, ask: 401, src: 'robinhood' }) + '{"t":' + (t + 15000));
  let s = (await marketHistory(ctx, { ids: ['crypto:BTC-USD'], points: 2000, from: t - 1 })).series[0];
  assert.equal(s.coverage.raw, 1, 'partial trailing line is held back'); assert.equal(s.coverage.first, t);
  fs.appendFileSync(tapeFile, ',"bid":402,"ask":403,"src":"robinhood"}\n');
  s = (await marketHistory(ctx, { ids: ['crypto:BTC-USD'], points: 2000 })).series[0];
  assert.equal(s.coverage.raw, before + 2);
  fs.writeFileSync(tapeFile, line({ t: t + 30000, bid: 500, ask: 501, src: 'robinhood' }));
  s = (await marketHistory(ctx, { ids: ['crypto:BTC-USD'], points: 2000 })).series[0];
  assert.equal(s.coverage.raw, 1); assert.equal(s.points[0][1], 500);
});

test('equity bars stay session closes with honest missing-session gaps', async () => {
  const s = (await marketHistory(ctx, { ids: ['equity:SPY'] })).series[0];
  assert.equal(s.session, true); assert.equal(s.unit, 'USD');
  assert.equal(s.points[0][0], Date.parse('2026-01-05T21:00:00Z'), 'EST close'); assert.equal(sessionCloseMs('2026-07-01'), Date.parse('2026-07-01T20:00:00Z'), 'EDT close');
  for (const p of s.points) { assert.equal(p[1], null); assert.equal(p[2], null); assert.equal(p[4], null); }
  assert.deepEqual([s.points[0][6], s.points[0][7]], [0.5, 3]);
  assert.ok(s.gaps.some(g => g[2] === 'missing-sessions' && g[0] === sessionCloseMs('2026-01-06')));
  assert.ok(!s.gaps.some(g => g[0] === sessionCloseMs('2026-01-05')), 'consecutive sessions are not gaps');
  const ds = buildSeries([[1, null, null, 2, null, 'x', 1, 3], [2, null, null, 4, null, 'x', 0, 9], [3, null, null, 5, null, 'x', 4, 6]], { kind: 'equity', points: 2, ohlc: true });
  assert.equal(ds.coverage.downsample, 'ohlc'); assert.deepEqual(ds.points[0].slice(6), [0, 9, 2]);
});

test('session charts preserve early closes and SIP repair provenance',async()=>{
 const extra=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-session-history-'));
 try{
  fs.mkdirSync(path.join(extra,'robinhood-equities'));fs.writeFileSync(path.join(extra,'robinhood-equities','bars.json'),JSON.stringify({provider:'alpaca',bars:{SPY:[{d:'2026-11-25',o:1,h:2,l:1,c:2},{d:'2026-11-27',o:2,h:3,l:1,c:3,f:'sip'}]}}));
  const s=(await marketHistory({dataDir:extra},{ids:['equity:SPY']})).series[0];
  assert.equal(new Date(s.points[1][0]).toISOString(),'2026-11-27T18:00:00.000Z');
  assert.match(s.sources[s.points[1][5]].id,/sip/);assert.match(s.sources[s.points[0][5]].id,/iex/);
  assert.equal(s.points[1][4],null);assert.equal(s.sources[s.points[1][5]].quote,false);
 }finally{fs.rmSync(extra,{recursive:true,force:true});}
});

test('contract history keeps PROB units, availability and missing sides', async () => {
  const r = await marketHistory(ctx, { ids: ['contract:kalshi:KXHIGHNY-26OCT01-B70', 'contract:kalshi:KXNFLGAME-26OCT04KCBUF-KC', 'contract:kalshi:MISSING', 'pump:MINT1', 'bogus', 'crypto:../x'] });
  const [a, b, c, p, bad, trav] = r.series;
  assert.equal(a.unit, 'PROB'); assert.equal(a.points.length, 3); assert.equal(a.points.at(-1)[4], NOW - 10 * MIN + 7); assert.equal(a.points.at(-1)[3], 0.45);
  assert.ok(a.gaps.some(g => g[2] === 'no-observation'), '28 h without observations is a gap'); assert.equal(a.meta.title, 'NY high 70?');
  assert.equal(b.points[0][1], null); assert.equal(b.points[0][3], null, 'no mid from one side');
  assert.equal(c.unavailable, 'NO_STORED_OBSERVATIONS'); assert.equal(bad.unavailable, 'INVALID_ID'); assert.equal(trav.unavailable, 'INVALID_SYMBOL');
  assert.equal(p.unit, 'USD'); assert.equal(p.points.length, 2); assert.equal(p.sources[0].id, 'captured token ticks');
  const ranged = await marketHistory(ctx, { ids: ['contract:kalshi:KXHIGHNY-26OCT01-B70'], from: NOW - 3 * H, to: NOW });
  assert.equal(ranged.series[0].coverage.raw, 2); assert.ok(ranged.series[0].gaps.some(g => g[2] === 'before-first-observation') === false);
  assert.equal((await marketHistory(ctx, { ids: ['pump:x'], from: 'nope' })).status, 400);
  assert.equal((await marketHistory(ctx, { ids: [] })).status, 400);
});

test('groups account for every contract and report window change only where history exists', () => {
  assert.deepEqual(classifyContract({ provider: 'kalshi', sourceId: 'KXHIGHNY-1' }), { category: 'weather', series: 'KXHIGHNY' });
  const g = marketGroups(ctx, { window: '24h', now: NOW });
  assert.equal(g.accounting.total, 4); assert.equal(g.accounting.grouped, 4); assert.equal(g.accounting.allAccounted, true); assert.equal(g.accounting.other, 1);
  const weather = g.groups.find(x => x.key === 'kalshi/weather'), crypto = g.groups.find(x => x.key === 'polymarket/crypto'), other = g.groups.find(x => x.key === 'polymarket/other');
  assert.equal(weather.change.measured, 1); assert.ok(Math.abs(weather.change.median - 0.2) < 1e-9);
  assert.ok(Math.abs(crypto.change.median - 0.05) < 1e-9);
  assert.equal(other.unknown, 1); assert.equal(other.change.omitted, 1); assert.equal(other.medianMid, null);
  assert.equal(g.groups.find(x => x.key === 'kalshi/sports').stale, 1);
  const series = marketGroups(ctx, { venue: 'kalshi', by: 'series', now: NOW });
  assert.equal(series.groups.reduce((n, x) => n + x.count, 0), series.accounting.total); assert.deepEqual(series.groups.map(x => x.group).sort(), ['KXHIGHNY', 'KXNFLGAME']);
  assert.equal(marketGroups(ctx, { window: '3y', now: NOW }).status, 400);
  const cov = contractCoverage(ctx, { now: NOW });
  assert.deepEqual(cov.venues.kalshi, { total: 2, quoted: 2, twoSided: 1, stale: 1, unknown: 0, executable: 0, withHistory: 1 });
});

test('quotes page, filter and answer If-None-Match with 304', async () => {
  const all = marketQuotes(ctx, { limit: 2, now: NOW });
  assert.equal(all.total, 4); assert.equal(all.rows.length, 2); assert.equal(all.offset, 0);
  const next = marketQuotes(ctx, { limit: 2, offset: 2, now: NOW }); assert.deepEqual([...all.rows, ...next.rows].map(r => r.id).length, 4);
  assert.equal(new Set([...all.rows, ...next.rows].map(r => r.id)).size, 4);
  assert.equal(marketQuotes(ctx, { group: 'kalshi/weather', now: NOW }).total, 1);
  assert.equal(marketQuotes(ctx, { group: 'series:KXNFLGAME', now: NOW }).total, 1);
  assert.equal(marketQuotes(ctx, { q: 'bitcoin', now: NOW }).rows[0].id, 'contract:polymarket:111');
  assert.equal(marketQuotes(ctx, { limit: 9999, now: NOW }).limit, LIMITS.quotePage);
  const out = []; const res = { writeHead: (s, h) => out.push([s, h]), end: () => {} };
  const jctx = { ...ctx, json: (r, body, status = 200, headers = {}) => out.push([status, headers, body]) };
  const url = new URL('http://x/api/market-quotes?venue=kalshi&limit=1');
  assert.equal(await handleMarketQuotesRequest({ headers: {} }, res, url, jctx), true);
  const etag = out[0][1].etag; assert.match(etag, /^W\/"mq-/); assert.equal(out[0][2].rows.length, 1);
  await handleMarketQuotesRequest({ headers: { 'if-none-match': etag } }, res, url, jctx); assert.equal(out[1][0], 304);
  assert.equal(await handleMarketHistoryRequest({ headers: {} }, res, new URL('http://x/api/market-other'), jctx), false);
  await handleMarketHistoryRequest({ headers: {} }, res, new URL('http://x/api/market-history?ids='), jctx); assert.equal(out.at(-1)[0], 400);
});

test('command-center summary drops contract rows but accounts for them, and summarizes leader replay', async () => {
  const full = { schema: 'mpo.command-center.v1', at: NOW, markets: { assets: [{ id: 'crypto:BTC-USD' }], predictions: [{ venue: 'polymarket-us', bid: 0.4, ask: null, at: NOW, executable: false }, { venue: 'kalshi', bid: null, ask: null, at: 0 }] },
    lab: { connected: true, workbench: { jobs: [], leaderReplay: { phase: 'RESEARCH_ONLY', outcomes: Array.from({ length: 30 }, (_, i) => ({ i })), leaders: [], candidateResearch: { candidates: [{ proxyWallet: 'a', byPolicy: [{ closes: 0, decision: 'AWAIT' }] }, { proxyWallet: 'b', byPolicy: [{ closes: 2, decision: 'KEEP' }, { closes: 0, decision: 'AWAIT' }] }] } } } },
    copy: { catalogue: { status: 'OK', candidates: [{ proxyWallet: 'a', userName: 'A', pnl: 1.234, vol: 5, note: 'long', sources: [{ period: 'DAY', category: 'ALL', rank: 1, pnl: 9 }] }] } } };
  const s = commandCenterSummary(full, { coverage: contractCoverage(ctx, { now: NOW }) });
  assert.equal(s.view, 'summary'); assert.equal(s.markets.predictions, undefined); assert.equal(s.markets.assets.length, 1);
  assert.equal(s.markets.coverage.kalshi.total, 2, 'stored coverage wins over in-process rows'); assert.equal(s.markets.coverage['polymarket-us'].quoted, 1);
  assert.equal(s.markets.predictionsOmitted.count, 2 + 2 + 1);
  const lr = s.lab.workbench.leaderReplay; assert.equal(lr.outcomes.total, 30); assert.equal(lr.outcomes.rows.length, 20); assert.equal(lr.outcomes.omitted, 10);
  assert.equal(lr.candidateResearch.total, 2); assert.deepEqual(lr.candidateResearch.candidates.map(c => c.proxyWallet), ['b']); assert.equal(lr.candidateResearch.omitted.count, 1);
  assert.deepEqual(lr.candidateResearch.policyDecisions, { AWAIT: 2, KEEP: 1 });
  assert.deepEqual(s.copy.catalogue.candidates[0], { proxyWallet: 'a', userName: 'A', pnl: 1.23, vol: 5, firstObservedAt: null, qualification: null, sources: [{ period: 'DAY', category: 'ALL', rank: 1 }] });
  assert.equal(full.markets.predictions.length, 2, 'input untouched'); assert.equal(summarizeLeaderReplay(null), null);
  let t = 0, builds = 0; const cache = createBuildCache({ ttlMs: 100, now: () => t });
  const [x, y] = await Promise.all([cache.get('s', async () => ++builds), cache.get('s', async () => ++builds)]);
  assert.equal(x, 1); assert.equal(y, 1); assert.equal(await cache.get('s', async () => ++builds), 1); t = 200; assert.equal(await cache.get('s', async () => ++builds), 2);
});

test('history and window-baseline caches remain isolated between data stores', async () => {
  const otherDir=path.join(dir,'other-store');fs.mkdirSync(otherDir);
  fs.copyFileSync(path.join(dir,'mpos-core.sqlite'),path.join(otherDir,'mpos-core.sqlite'));
  const db=new DatabaseSync(path.join(otherDir,'mpos-core.sqlite'));
  db.exec(`UPDATE entity_versions SET payload=json_set(payload,'$.data.yesBid',0.7,'$.data.yesAsk',0.9) WHERE id='contract:polymarket:111'; UPDATE entities SET payload=json_set(payload,'$.yesBid',0.7,'$.yesAsk',0.9) WHERE id='contract:polymarket:111'`);db.close();
  const a=(await marketHistory(ctx,{ids:['contract:polymarket:111']})).series[0],b=(await marketHistory({dataDir:otherDir},{ids:['contract:polymarket:111']})).series[0];
  assert.equal(a.points.at(-1)[3],0.16);assert.equal(b.points.at(-1)[3],0.8);
  const groups=marketGroups({dataDir:otherDir},{venue:'polymarket',now:NOW});assert.equal(groups.groups.find(g=>g.group==='crypto').change.median,0,'second store baseline must come from second store');
});

test('a current contract observation refreshes history even without a new archived version',async()=>{
  const id='contract:polymarket:222';await marketHistory(ctx,{ids:[id]});
  const db=new DatabaseSync(path.join(dir,'mpos-core.sqlite'));db.prepare("UPDATE entities SET observed_at=?,available_at=?,payload=json_set(payload,'$.yesBid',0.2,'$.yesAsk',0.4) WHERE id=?").run(NOW+1,NOW+2,id);db.close();
  const s=(await marketHistory(ctx,{ids:[id]})).series[0];assert.equal(s.points.at(-1)[3],0.3);assert.equal(s.points.at(-1)[0],NOW+1);assert.equal(s.points.at(-1)[4],NOW+2);
});
