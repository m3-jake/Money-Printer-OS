import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildScoreboard } from '../src/scoreboard.js';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const botSource = read('public/js/mpo-bots.js');
const dashboard = read('public/dashboard.html');
const platformSource = read('public/js/mpo-platform.js');
const classes = (...names) => ({ contains: name => names.includes(name) });

test('coordinated command view preserves unknowns, escapes leaders and keeps readable scrolling',async()=>{
 const window={MPOSPlatform:{render(){}}},document={hidden:false,addEventListener(){},querySelector(){return null;}};
 let reply={schema:'mpo.command-center.v1',at:Date.now(),lab:{connected:false},copy:{books:[],uniqueLeaders:null,catalogue:{candidates:[{proxyWallet:'a',userName:'<script>bad</script>',sources:[]}]}}};
 const context=vm.createContext({window,document,Date,AbortSignal,fetch:async()=>({ok:true,json:async()=>reply}),setInterval(){},addEventListener(){}});
 vm.runInContext(read('public/js/mpo-command-center.js'),context);
 assert.match(window.MPOCommandCenter.html(),/Unknown/);await window.MPOCommandCenter.load(true);
 const html=window.MPOCommandCenter.html();assert.match(html,/command-brain/);assert.match(html,/&lt;script&gt;bad/);assert.doesNotMatch(html,/<script>bad/);assert.match(html,/Lab unavailable/);assert.match(html,/data-cc-profile="MAX_RESEARCH"/);
 reply={...reply,lab:{connected:true,modules:[{id:'pumpfun',title:'Pump.fun',state:'COLLECTING'}]}};await window.MPOCommandCenter.load(true);assert.match(window.MPOCommandCenter.html(),/COLLECTING/);
});

test('two overview graphs map all quotes and independent paper books with exact price inspection',()=>{
 const window={},document={addEventListener(){}};const context=vm.createContext({window,document,Date});vm.runInContext(read('public/js/mpo-command-graphs.js'),context);
 const d={markets:{assets:[{id:'btc',symbol:'BTC-USD',venue:'Robinhood crypto',price:101,bid:100,ask:102,at:Date.now(),source:'v2',kind:'BBO'}],predictions:Array.from({length:1001},(_,i)=>({id:'c'+i,symbol:'<unsafe>',title:'Market',venue:'kalshi',bid:.2,ask:null}))},books:[{id:'a',module:'Pump.fun',label:'A',kind:'paper',unit:'SOL',pnl:-.1,closes:3},{id:'b',module:'Robinhood',label:'B',kind:'paper',unit:'USD',pnl:1,closes:4}],lab:{modules:[{id:'pumpfun',title:'Pump.fun',state:'COLLECTING'}]},activity:{pump:{open:5}}};
 const html=window.MPOCommandGraphs.html(d);assert.match(html,/1001 contracts/);assert.match(html,/1001 unknown/);assert.match(html,/Market & price atlas/);assert.match(html,/System → research/);assert.match(html,/5 open/);assert.match(html,/\$101/);assert.match(html,/-0.100 SOL/);assert.match(html,/1.00 USD/);assert.doesNotMatch(html,/<unsafe>/);
});

function botHarness({ hosts = [], active = null, hidden = false, reply = () => ({ ok: true, at: 1 }) } = {}) {
  let now = 100000, calls = 0;
  const timers = [], events = [], listeners = {};
  const window = { MPOProgramActive: () => active, MPOSPlatform: { render() {} } };
  const document = {
    hidden,
    addEventListener(type, fn) { listeners[type] = fn; },
    getElementById: () => null,
    querySelector(selector) {
      const host = selector.match(/data-app="([^"]+)"/)?.[1];
      return hosts.includes(host) ? { classList: classes('glance') } : null;
    },
  };
  const context = vm.createContext({
    window, document,
    Date: class extends Date { static now() { return now; } },
    fetch: async (url, options) => { if (options?.method !== 'POST') calls++; const body = await reply(url, options); return { ok: true, json: async () => body }; },
    setInterval: fn => { timers.push(fn); },
    addEventListener() {},
    CustomEvent: class { constructor(type) { this.type = type; } },
    dispatchEvent: e => events.push(e.type),
  });
  vm.runInContext(botSource, context);
  return { window, document, timers, events, calls: () => calls, advance: ms => { now += ms; },
    click: dataset => listeners.click({ target: { closest: () => ({ dataset }) } }),
  };
}

test('overview consumers load bot data without opening either bot detail pane', async () => {
  for (const host of ['command', 'money', 'kalshi', 'sportsbook']) {
    const h = botHarness({ hosts: [host] });
    h.window.MPOBots.render();
    await h.window.MPOBots.load();
    assert.equal(h.calls(), 1, host);
    assert.equal(h.window.MPOBots.data.at, 1, host);
    assert.deepEqual(h.events, ['mpo:overview-data']);
    for (let i = 0; i < 20; i++) h.window.MPOBots.render();
    h.advance(14999); h.timers[0]();
    assert.equal(h.calls(), 1, 'painting and the timer share the 15-second budget');
    h.advance(1); h.timers[0]();
    await h.window.MPOBots.load();
    assert.equal(h.calls(), 2, 'a visible overview refreshes when the cache budget expires');
  }
});

test('closed desktops and background tabs do not fetch bots; visible Lab does', async () => {
  for (const options of [{}, { hosts: ['money'], hidden: true }, { hosts: ['trade'] }]) {
    const h = botHarness(options);
    h.window.MPOBots.render(); h.timers[0]();
    assert.equal(h.calls(), 0);
    assert.equal(h.window.MPOBots.data, null);
  }
  const lab = botHarness({ hosts: ['trade'], active: 'evolution' });
  lab.window.MPOBots.render(); await lab.window.MPOBots.load();
  assert.equal(lab.calls(), 1);
});

test('slow bot refreshes and forced refreshes share one in-flight request', async () => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const h = botHarness({ hosts: ['money'], reply: () => response });
  h.window.MPOBots.render();
  const pending = h.window.MPOBots.load(true);
  h.advance(30000); h.timers[0](); h.window.MPOBots.render();
  assert.equal(h.calls(), 1);
  assert.equal(h.window.MPOBots.data, null, 'loading exposes unknown, never a fabricated empty account');
  finish({ ok: true, at: 33 }); await pending;
  assert.equal(h.window.MPOBots.data.at, 33);
  assert.deepEqual(h.events, ['mpo:overview-data']);
});

test('a failed refresh preserves the last real snapshot and releases the request lock', async () => {
  let fail = false;
  const h = botHarness({ hosts: ['command'], reply: () => {
    if (fail) throw new Error('offline');
    return { ok: true, at: 7, polycopy: { equityUsd: null } };
  } });
  h.window.MPOBots.render(); await h.window.MPOBots.load();
  const original = h.window.MPOBots.data;
  fail = true; h.advance(15000); h.timers[0](); await h.window.MPOBots.load();
  assert.equal(h.window.MPOBots.data, original);
  assert.equal(h.window.MPOBots.data.polycopy.equityUsd, null);
  fail = false; h.advance(15000); h.timers[0](); await h.window.MPOBots.load();
  assert.equal(h.calls(), 3);
});

test('an action followed by refresh cannot reuse a snapshot started before the action', async () => {
  let finish, gets = 0, posts = 0;
  const first = new Promise(resolve => { finish = resolve; });
  const h = botHarness({ hosts: ['money'], reply: (url, options) => {
    if (options?.method === 'POST') { posts++; return { ok: true }; }
    return ++gets === 1 ? first : { ok: true, at: 2 };
  } });
  h.window.MPOBots.render();
  h.click({ bot: 'weather', botAct: 'run' });
  await new Promise(setImmediate);
  assert.equal(posts, 1); assert.equal(gets, 1);
  finish({ ok: true, at: 1 });
  await new Promise(setImmediate);
  await h.window.MPOBots.load();
  assert.equal(gets, 2, 'the action requests a snapshot taken after the mutation');
  assert.equal(h.window.MPOBots.data.at, 2);
});

const appIds = new Set(vm.runInNewContext(dashboard.match(/const APPS=\[([\s\S]*?)\n\];/)[0] + '\nAPPS.map(a=>a[0])'));
const navIds = html => [...html.matchAll(/data-overview-open="([^"]+)"/g)].map(m => m[1]);
function assertNavigation(html, required = []) {
  const ids = navIds(html);
  assert.ok(ids.length > 0, 'the overview includes direct navigation');
  for (const id of ids) assert.ok(appIds.has(id), 'registered app destination: ' + id);
  for (const id of required) assert.ok(ids.includes(id), 'overview covers ' + id);
}

function platformHarness(seed = {}, bots = null) {
  const marker = 'return {install,render};';
  assert.ok(platformSource.includes(marker));
  const exposed = platformSource.replace(marker, `return {install,render,commandOverview,commandGlance,overviewModules,overviewAttention,overviewBooks,kalshiOverview,kalshiGlance,
    seed(s) { snapshot=s.snapshot??null; scoreboard=s.scoreboard??null; diag=s.diag??null; contracts=s.contracts??[]; intelligence=s.intelligence??null; kalshiWx=s.kalshiWx??null; kalshiWxAt=Date.now(); }
  };`);
  const window = { MPOBots: { data: bots } };
  const context = vm.createContext({ window, document: {}, glance: options => options,
    gFoot: values => values.filter(Boolean).join(' · '), addEventListener() {},
  });
  vm.runInContext(exposed, context);
  window.MPOSPlatform.seed(seed);
  return window.MPOSPlatform;
}

test('Command Center starts with unknown balances and evidence, not zero or healthy claims', () => {
  const p = platformHarness();
  const card = p.commandGlance(0), html = card.visual;
  assert.equal(card.hero, null);
  assert.match(html, /Paper books<\/label><b>Unknown<\/b>/);
  assert.match(html, /Awaiting evidence<\/label><b>Unknown<\/b>/);
  assert.match(card.pill.label, /not reported/i);
  assert.match(html, /Paper balances have not been reported/);
  assert.doesNotMatch(html, /\$0(?:\.00)?|All data sources ok|All systems normal/);
  assertNavigation(html, ['trade', 'robinhood', 'sportsbook', 'kalshi', 'evolution', 'money', 'journal']);
});

test('Command Center uses separate real source books, original units and unreadable diagnostics', () => {
  const p = platformHarness({
    scoreboard: { paperSummary: { books: 3, beating: 1, notBeating: 1, notEnoughData: 1 }, rows: [
      { module: 'Pump.fun', book: 'strategy', mode: 'PAPER', unit: 'SOL', netPnl: 0.22, closes: 4, beatsBaseline: 'YES', freshness: { status: 'FRESH' } },
      { module: 'Robinhood crypto', book: 'strict', mode: 'PAPER', unit: 'USD', netPnl: -2.1, closes: 2, beatsBaseline: 'NO', freshness: { status: 'STALE' } },
      { module: 'Kalshi', book: 'weather', mode: 'PAPER', unit: 'USD', netPnl: null, closes: null, beatsBaseline: 'WAIT', freshness: { status: 'UNREADABLE' } },
    ] },
    snapshot: { at: 100000, portfolio: { mode: 'PAPER', accounts: [
      { venue: 'kalshi', account: 'manual', currency: 'USD', cash: null, positions: [] },
      { venue: 'solana-paper', account: 'legacy-old', currency: 'SOL', cash: 777, positions: [] },
    ] }, livePortfolio: { accounts: [{ account: 'real', currency: 'USD', cash: 776655 }] },
      legacy: { books: [
        { label: 'Pump strategy', mode: 'PAPER', currency: 'SOL', cash: 0.42, openPositions: 1 },
        { label: 'Missing book', mode: 'PAPER', currency: 'USD', cash: null, openPositions: null },
        { label: 'Real source', mode: 'LIVE', currency: 'USD', cash: 998877 },
      ], mirror: [{ source: 'solana', status: 'MISMATCH' }] },
      risk: { halted: true }, ledger: [],
    }, diag: { sources: [{ id: 'weather <upstream>', status: 'ERROR', lastError: 'offline & retrying' }] },
  }, { kalshi: { weather: { equityUsd: null, open: [], settings: { enabled: true } }, btc: { equityUsd: 9.25, open: [], settings: { enabled: false } } } });
  const card = p.commandGlance(1), html = card.visual;
  assert.equal(card.hero, null);
  assert.match(html, /Paper books<\/label><b>3<\/b>/);
  assert.match(html, /Awaiting evidence<\/label><b>1<\/b>/);
  for (const text of ['+0.2200 SOL', '−$2.10', '0.42 SOL cash', 'Unknown cash', 'Unknown modeled equity', '$9.25 modeled equity', 'Paper execution paused', 'MISMATCH', 'UNREADABLE']) assert.ok(html.includes(text), text);
  assert.match(html, /weather &lt;upstream&gt;/);
  assert.match(html, /offline &amp; retrying/);
  assert.doesNotMatch(html, /Real source|776,?655|998,?877|777 SOL/);
  assert.match(html, /Cash and modeled equity are different measures/);
  assertNavigation(html);
});

function dashboardHarness(values = {}) {
  const rendered = {};
  const segment = (start, end) => {
    const a = dashboard.indexOf(start), b = dashboard.indexOf(end, a);
    assert.ok(a >= 0 && b > a, start + ' is a bounded dashboard block');
    return dashboard.slice(a, b);
  };
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const context = vm.createContext({
    state: null, rhState: null, rhEq: null, polyUSComboState: null, polyUSAccount: null, polyUSEvidence: null, networkState: null,
    window: { MPOSPlatform: { overview: {} }, MPOBots: { data: null } },
    document: { getElementById: () => null }, $: () => null,
    polyEscape: escape, money: v => '$' + Number(v).toFixed(2), fmt: (v, n) => Number(v).toFixed(n),
    setGlance: (id, html) => { rendered[id] = html; }, drawGlanceChart() {},
    ...values,
  });
  const code = [
    segment('const gTone=', 'function glanceTrade()'),
    dashboard.split('\n').filter(line => /^function pumpCopy(?:Label|Row)\(/.test(line)).join('\n'),
    segment('function glanceTrade()', '// Task Manager style graph:'),
    segment('function glanceSportsbook()', '// Polymarket copy bot'),
    segment('function rhWhyRows(', '// CPU / memory history'),
    segment('function glanceMoney()', 'const GLANCE='),
  ].join('\n');
  vm.runInContext(code, context);
  return { rendered, run: code => vm.runInContext(code, context) };
}

test('Money Printer OS overview covers the suites, operating tools and evidence workflow', () => {
  const h = dashboardHarness();
  const html = h.run('moneyOverviewHTML()');
  for (const label of ['Pump.fun', 'Polymarket', 'Kalshi', 'Robinhood', 'Evolution Lab', 'Command Center', 'From an idea to evidence', 'More tools on your desk', 'Start here']) assert.ok(html.includes(label), label);
  assert.match(html, /Each book keeps its own balance and evidence/);
  assertNavigation(html, ['trade', 'sportsbook', 'kalshi', 'robinhood', 'evolution', 'command', 'system', 'journal', 'settings']);
  assert.match(html, /Waiting for scoreboard/);
  assert.doesNotMatch(html, /\$0\.00|\$NaN|\$undefined/);
});

test('native module overviews preserve unavailable balances and provide valid drill-downs', () => {
  const h = dashboardHarness({
    state: { mode: 'PAPER', portfolio: { equitySol: null }, dailyPnlSol: null, market: { solUsd: null } },
    rhState: { paper: { equityUsd: null }, daily: { book: { equityUsd: null } }, explore: { equityUsd: null }, practice: { equityUsd: null } },
    rhEq: { book: { equityUsd: null } },
    polyUSAccount: { keyStatus: 'VERIFIED', balance: { currentBalance: null } },
    window: { MPOSPlatform: { overview: {} }, MPOBots: { data: { polycopy: { equityUsd: null } } } },
  });
  h.run('glanceTrade(); glanceSportsbook(); glanceRobinhood()');
  for (const [host, html] of Object.entries(h.rendered)) {
    assert.match(html, /mpo-overview/, host);
    assert.match(html, /Unavailable|Unpriced/, host);
    assert.doesNotMatch(html, /\$0\.00|\$NaN|0\.0000 SOL/, host);
    if (host !== 'robinhood') assertNavigation(html);
  }
  assert.match(h.rendered.trade, /<label>Today<\/label><b[^>]*>—<\/b>/);
  const sections = [...h.rendered.robinhood.matchAll(/data-overview-section="([^"]+)"/g)].map(m => m[1]);
  const valid = new Set(['paper', 'why', 'charts', 'explore', 'daily', 'stocks', 'practice', 'more']);
  assert.ok(sections.length >= 8);
  for (const section of sections) assert.ok(valid.has(section));
  for (const section of valid) assert.ok(sections.includes(section), section);
});

test('Polymarket shows verified real cash separately and hides unverified balance values', () => {
  const fixture = {
    polyUSComboState: { feed: { ok: true, eventsLive: 2, candidates: 3 }, readiness: {} },
    polyUSAccount: { keyStatus: 'VERIFIED', balance: { currentBalance: 123 } },
    polyUSEvidence: { shadow: { near_end: { settled: 4, pnlUsd: 3, open: 1 } } },
    window: { MPOSPlatform: { overview: { contracts: [], snapshot: { providers: [] }, scoreboard: { rows: [{ id: 'platform-polymarket', closes: 2, netPnl: 17 }] } } },
      MPOBots: { data: { polycopy: { equityUsd: 9, settings: { enabled: true }, follows: [], open: [], stats: { closed: 0 } } } } },
  };
  const h = dashboardHarness(fixture); h.run('glanceSportsbook()');
  const html = h.rendered.sportsbook;
  for (const value of ['$123.00', '$17.00', '$9.00', '$3.00']) assert.ok(html.includes(value), value);
  assert.equal((html.match(/\$123\.00/g) || []).length, 1);
  assert.match(html, /Verified read-only account/);
  assert.match(html, /never added to their returns/);
  assert.doesNotMatch(html, /\$(?:140|149|152)\.00/);
  const unavailable = dashboardHarness({ ...fixture, polyUSAccount: { ...fixture.polyUSAccount, keyStatus: 'KEYS_NEEDED' } });
  unavailable.run('glanceSportsbook()');
  assert.doesNotMatch(unavailable.rendered.sportsbook, /\$123\.00/);
  assert.match(unavailable.rendered.sportsbook, /Not configured/);
});

test('Robinhood retains every independent book and keeps real account cash off the paper overview', () => {
  const h = dashboardHarness({
    rhState: { account: { buyingPowerUsd: 987 }, paper: { equityUsd: 25 }, daily: { book: { equityUsd: 20, positions: { BTC: { qty: 1 } } } }, explore: { equityUsd: 9 }, practice: { equityUsd: 10 } },
    rhEq: { book: { equityUsd: 19 }, data: { status: 'FRESH' } },
  });
  h.run('glanceRobinhood()');
  const html = h.rendered.robinhood;
  for (const value of ['$25.00', '$20.00', '$19.00', '$10.00', '$9.00']) assert.ok(html.includes(value), value);
  assert.match(html, /1 active positions · holding/);
  assert.match(html, /never qualify the strategy/);
  assert.doesNotMatch(html, /\$987\.00|\$83\.00/);
});

test('Kalshi opens a whole-suite overview with missing balances and coverage left unknown', () => {
  const p = platformHarness();
  const card = p.kalshiGlance(), html = card.visual;
  assert.equal(card.hero, null);
  assert.match(html, /Public listings<\/label><b>Unknown<\/b>/);
  assert.match(html, /Model books<\/label><b>Unknown<\/b>/);
  assert.match(html, /Variants<\/label><b>Unknown<\/b>/);
  for (const label of ['Market universe', 'Separate paper books', 'Farm &amp; qualification', 'Upcoming markets &amp; activity', 'Data health', 'Weather preview']) assert.ok(html.includes(label), label);
  assert.match(html, /Coverage not reported/);
  assert.match(html, /Paper book not reported/);
  assert.doesNotMatch(html, /\$0\.00|\$NaN/);
  assertNavigation(html, ['kalshi', 'kalshibots', 'pmcopy', 'evolution', 'weather', 'command']);
});

test('Kalshi renders supported farm evidence, partial venue coverage and independent paper balances', () => {
  const future = Date.now() + 86400000;
  const p = platformHarness({ snapshot: { at: Date.now(), executionModes: { kalshi: 'PAPER' }, providers: [{ id: 'kalshi', status: 'STALE' }], proposals: [] },
    contracts: [
      { id: 'k1', provider: 'kalshi', data: { title: 'Daily high', category: 'Weather', expiresAt: new Date(future).toISOString() } },
      { id: 'k2', provider: 'kalshi', data: { title: 'BTC range', category: 'Crypto' } },
      { id: 'p1', provider: 'polymarket', data: { title: 'Other venue' } },
    ], scoreboard: { rows: [{ module: 'Kalshi historical weather', kind: 'lab' }] },
    kalshiWx: { cities: [{ label: 'Chicago <NWS>', markets: [{ date: '2026-10-03', closeAt: future, buckets: [{ p: 0.2 }], nwsHigh: null, expectedHigh: 69, gap: null }] }] },
  }, { at: Date.now(), kalshi: {
    weather: { equityUsd: 12.25, open: [], stats: { settled: 0 }, settings: { enabled: true } },
    'weather-nws': { equityUsd: 25, open: [], stats: { settled: 0 }, settings: { enabled: true } },
    btc: { equityUsd: 11, open: [], stats: { settled: 0 }, settings: { enabled: false } },
  }, mirror: { equityUsd: null, open: [], stats: { settled: 0 }, settings: { enabled: false }, lastError: 'Recovery required' },
  farm: { minSettled: 30, variants: [{ settled: 40, pnlUsd: 5, verdict: { t: 2.5, text: 'making money (t 2.5)' } }] } });
  const card = p.kalshiGlance(), html = card.visual;
  assert.equal(card.hero, null);
  assert.match(html, /Public listings<\/label><b>2<\/b>/);
  assert.match(html, /Model books<\/label><b>3<\/b>/);
  assert.match(html, /Variants<\/label><b>1<\/b>/);
  assert.equal(card.pill.label, 'STALE');
  for (const text of ['$12.25 modeled equity', '$25 modeled equity', '$11 modeled equity', 'Unknown modeled equity', 'Recovery required', 'Weather', 'Crypto', '1 independent PAPER variants', '30 settled bets required', 'NWS Unknown', 'Unknown gap']) assert.ok(html.includes(text), text);
  assert.match(html, /positive|making money|per-bet P\/L/i);
  assert.match(html, /partial public-data snapshot/);
  assert.match(html, /Chicago &lt;NWS&gt;/);
  assert.doesNotMatch(html, /\$48\.25|Other venue|NWS 0(?:\.0)?°F|0\.0°F gap/);
});

test('Pump.fun labels the scanner mode and the separate copy paper book without adding their equity', () => {
  const h = dashboardHarness({ state: { mode: 'LIVE', portfolio: { equitySol: 1 }, dailyPnlSol: null, market: { solUsd: 100 }, walletIntel: { copy: { equityUsd: 25, status: 'PAPER_READY', leaders: 1, open: 0 } } } });
  h.run('glanceTrade()');
  const html = h.rendered.trade;
  assert.match(html, /LIVE results for this book only/);
  assert.match(html, /1\.0000(?: SOL|<small>SOL<\/small>)/);
  assert.match(html, /Pump copy · paper/);
  assert.match(html, /\$25\.00/);
  assert.doesNotMatch(html, /\$125\.00/);
});

function navigationHarness() {
  const apps = vm.runInNewContext(dashboard.match(/const APPS=\[([\s\S]*?)\n\];/)[0] + '\nAPPS');
  const calls = [], reads = [], listeners = {};
  const record = name => (...args) => calls.push([name, ...args]);
  const document = { hidden: false, addEventListener(type, callback) { listeners[type] = callback; } };
  const context = vm.createContext({
    document, RH_VIEWS: Object.fromEntries(['paper', 'why', 'charts', 'explore', 'daily', 'stocks', 'practice', 'more'].map(id => [id, id])), rhView: 'paper',
    appMeta: id => apps.find(a => a[0] === id), hostOf: id => apps.find(a => a[0] === id)?.[4] || id,
    openApp: record('open'), setDetail: record('detail'), rhSave: record('save'), renderRobinhood: record('renderRH'), renderAll: record('renderAll'),
    rhLoadChart: force => { calls.push(['chart', force]); reads.push('/api/robinhood/chart'); },
    rhLoadEquities: force => { calls.push(['equities', force]); reads.push('/api/robinhood-equities'); },
    fetch: (url, options) => { assert.notEqual(options?.method, 'POST'); reads.push(url); return Promise.resolve({ ok: true }); },
    post: () => assert.fail('overview navigation must not submit a trading action'),
    addEventListener(type, callback) { listeners[type] = callback; },
  });
  vm.runInContext(read('public/js/mpo-overview-navigation.js'), context);
  const click = dataset => {
    let prevented = false;
    listeners.click({ target: { closest: () => ({ dataset }) }, preventDefault() { prevented = true; } });
    return prevented;
  };
  return { calls, reads, document, context, click, event: type => listeners[type]?.() };
}

test('overview navigation opens child programs in Advanced and keeps host homes in Simple', () => {
  for (const [id, host] of [['weather', 'command'], ['wallet', 'trade'], ['pmcopy', 'sportsbook'], ['kalshibots', 'kalshi'], ['settings', 'system']]) {
    const h = navigationHarness();
    assert.equal(h.click({ overviewOpen: id }), true);
    assert.deepEqual(h.calls, [['open', id], ['detail', host, true]]);
    assert.deepEqual(h.reads, []);
  }
  for (const id of ['money', 'trade', 'robinhood', 'sportsbook', 'kalshi', 'command']) {
    const h = navigationHarness();
    assert.equal(h.click({ overviewOpen: id }), true);
    assert.deepEqual(h.calls, [['open', id]], 'a host link preserves its opening overview: ' + id);
    assert.deepEqual(h.reads, []);
    const detail = navigationHarness();
    assert.equal(detail.click({ overviewOpen: id, overviewDetail: 'true' }), true);
    assert.deepEqual(detail.calls, [['open', id], ['detail', id, true]]);
  }
});

test('Robinhood overview links select and persist the intended section with only necessary GET loaders', () => {
  for (const section of ['paper', 'why', 'charts', 'explore', 'daily', 'stocks', 'practice', 'more']) {
    const h = navigationHarness();
    assert.equal(h.click({ overviewSection: section }), true);
    assert.equal(h.context.rhView, section);
    assert.deepEqual(h.calls.slice(0, 4), [['open', 'robinhood'], ['detail', 'robinhood', true], ['save', 'mpo-rh-view', section], ['renderRH', true]]);
    assert.deepEqual(h.reads, section === 'charts' ? ['/api/robinhood/chart'] : section === 'stocks' ? ['/api/robinhood-equities'] : []);
    assert.equal(h.calls.length, section === 'charts' || section === 'stocks' ? 5 : 4);
  }
});

test('overview navigation ignores invalid destinations and never treats inherited names as Robinhood sections', () => {
  for (const dataset of [{ overviewOpen: 'missing' }, { overviewOpen: '__proto__' }, { overviewSection: 'constructor' }, { overviewSection: '__proto__' }, { overviewSection: 'missing', overviewOpen: 'trade' }]) {
    const h = navigationHarness();
    assert.equal(h.click(dataset), false);
    assert.deepEqual(h.calls, []); assert.deepEqual(h.reads, []);
  }
  const h = navigationHarness();
  h.event('mpo:overview-data');
  assert.deepEqual(h.calls, [['renderAll']]);
  h.document.hidden = true; h.event('mpo:overview-data');
  assert.equal(h.calls.length, 1, 'background pages do not repaint');
});

test('same-host detail buttons emit the explicit dataset instead of linking back to the overview', () => {
  const native = dashboardHarness();
  const nav = native.run("overviewNav([['trade','Portfolio details',true],['trade','Open Pump.fun']])");
  assert.match(nav, /data-overview-open="trade" data-overview-detail="true"/);
  assert.equal((nav.match(/data-overview-detail/g) || []).length, 1);
  const p = platformHarness();
  assert.match(p.kalshiOverview(), /data-overview-open="kalshi" data-overview-detail="true"/);
  assert.match(p.commandOverview(), /data-overview-open="command" data-overview-detail="true"/);
});

test('Money alone keeps platform and scoreboard snapshots flowing without a detail window', async () => {
  let snapshots = 0;
  const requests = [], events = [], timers = [];
  const window = {};
  const document = { hidden: false, addEventListener() {}, getElementById: () => null,
    querySelector: selector => selector.includes('data-app="money"') ? { classList: classes('glance') } : null,
  };
  const context = vm.createContext({ window, document, addEventListener() {},
    setInterval: fn => { timers.push(fn); },
    CustomEvent: class { constructor(type) { this.type = type; } }, dispatchEvent: e => events.push(e.type),
    fetch: async (url, options) => {
      assert.notEqual(options?.method, 'POST'); requests.push(url);
      const body = url.includes('/scoreboard') ? { rows: [] } : url.includes('/entities') ? { entities: [{ id: url.includes('provider=kalshi') ? 'k1' : 'p1', provider: url.includes('provider=kalshi') ? 'kalshi' : 'polymarket' }] } : url.endsWith('/status') ? { at: ++snapshots } : {};
      return { ok: true, json: async () => body };
    },
  });
  vm.runInContext(platformSource, context);
  window.MPOSPlatform.install({ open() {} });
  await new Promise(setImmediate);
  const initial = window.MPOSPlatform.overview.snapshot.at, initialRequests = requests.length, initialEvents = events.length;
  assert.ok(initial > 0, 'the platform is available before any detail page opens');
  assert.ok(initialRequests >= 6);
  assert.deepEqual(Array.from(window.MPOSPlatform.overview.contracts, c => c.provider).sort(), ['kalshi', 'polymarket']);
  assert.equal(Object.getOwnPropertyDescriptor(window.MPOSPlatform, 'overview').set, undefined);
  timers[0](); timers[0]();
  await new Promise(setImmediate);
  assert.equal(window.MPOSPlatform.overview.snapshot.at, initial + 1);
  assert.equal(requests.length, initialRequests + 6, 'concurrent paints share a single platform refresh');
  assert.equal(requests.slice(initialRequests).filter(url => url === '/api/scoreboard').length, 1);
  assert.ok(requests.slice(initialRequests).includes('/api/platform/entities?kind=Contract&provider=kalshi'));
  assert.ok(requests.slice(initialRequests).includes('/api/platform/entities?kind=Contract&provider=polymarket'));
  assert.equal(events.length, initialEvents + 1);
  assert.ok(events.every(type => type === 'mpo:overview-data'));
  document.hidden = true; timers[0]();
  assert.equal(requests.length, initialRequests + 6);
});

test('Command Center reads paper book counts from the real scoreboard contract and excludes research lanes', () => {
  const board = buildScoreboard({ pumpfunCopy: { history: [], status: 'WAITING_FOR_WALLET_EVIDENCE', lastRunAt: Date.now() }, lab: {} });
  assert.equal(board.paperSummary.books, 1);
  assert.equal(board.rows.length, 3, 'one paper source and two Lab research rows (the furnace champion is retired)');
  const card = platformHarness({ scoreboard: board }).commandGlance(0);
  assert.match(card.visual, /Paper books<\/label><b>1<\/b>/);
  assert.match(card.visual, /Awaiting evidence<\/label><b>1<\/b>/);
  const missing = platformHarness({ scoreboard: { paperSummary: { books: null, notEnoughData: null }, rows: [] } }).commandGlance(0);
  assert.match(missing.visual, /Paper books<\/label><b>Unknown<\/b>/);
  assert.match(missing.visual, /Awaiting evidence<\/label><b>Unknown<\/b>/);
  const empty = platformHarness({ scoreboard: buildScoreboard({}) }).commandGlance(0);
  assert.match(empty.visual, /Paper books<\/label><b>0<\/b>/, 'a reported empty scoreboard is a known zero');
  assert.match(empty.visual, /Awaiting evidence<\/label><b>0<\/b>/);
});

test('Command Center reports existing Kalshi models and copy state before baseline results exist', () => {
  const data = { kalshi: { weather: { settings: { enabled: true } }, btc: { settings: { enabled: false } }, 'weather-nws': { settings: {} } }, mirror: { settings: { enabled: false } } };
  const html = platformHarness({}, data).overviewModules();
  assert.match(html, /Baseline results not reported/);
  assert.match(html, /3 reported · 1 enabled · some states unknown/);
  assert.match(html, /Copy mirror/);
  assert.match(html, /PAPER · paused/);
  assert.match(html, /data-overview-open="sportsbook">Open Polymarket/);
  assert.doesNotMatch(html, /data-overview-open="predictionmarkets"/);
  const missing = platformHarness().overviewModules();
  assert.match(missing, /Paper models<\/b><small>Status not reported/);
  assert.match(missing, /Copy mirror<\/b><small>Status not reported/);
});

test('Kalshi upcoming activity uses trading close time, labels expiration fallback and excludes closed markets', () => {
  const now = Date.now(), hour = 3600000, closeAt = now + hour, expiresAt = now + 24 * hour;
  const p = platformHarness({ snapshot: { at: now }, contracts: [
    { id: 'closes', provider: 'kalshi', data: { title: 'CLOSE FIRST', category: 'Weather', status: 'ACTIVE', closeAt, expiresAt } },
    { id: 'expired', provider: 'kalshi', data: { title: 'TRADING ENDED', status: 'ACTIVE', closeAt: now - hour, expiresAt } },
    { id: 'closed', provider: 'kalshi', data: { title: 'ALREADY CLOSED', status: 'CLOSED', closeAt } },
    { id: 'expiration', provider: 'kalshi', data: { title: 'EXPIRATION ONLY', category: 'Crypto', expiresAt: now + 2 * hour } },
    { id: 'next', provider: 'kalshi', data: { title: 'NEXT CLOSE', status: 'OPEN', closeAt: now + 3 * hour } },
  ], diag: { sources: [{ id: 'nws', status: 'ERROR', lastError: 'Forecast unavailable' }] } });
  const html = p.kalshiOverview();
  assert.ok(html.includes('Weather · closes ' + new Date(closeAt).toLocaleString()));
  assert.ok(html.includes('Crypto · expires ' + new Date(now + 2 * hour).toLocaleString()));
  for (const title of ['CLOSE FIRST', 'EXPIRATION ONLY', 'NEXT CLOSE']) assert.ok(html.includes(title));
  assert.doesNotMatch(html, /TRADING ENDED|ALREADY CLOSED/);
  assert.match(html, /nws/); assert.match(html, /Forecast unavailable/);
});
