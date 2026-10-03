// Run D3: local desktop alerts. Changes of state only, never the state at startup; rate-limited per subject and per hour.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { conditions, createAlerter, MAX_PER_HOUR } = require('../desktop/alerts.cjs');

const quiet = { health: { health: 'HEALTHY', stalledVenues: [] }, scoreboard: { rows: [] }, bots: { kalshi: {}, farm: { variants: [] }, polycopy: {} }, labOnline: true, labMisses: 0 };
const row = (id, extra = {}) => ({ id, module: 'Kalshi bots', book: 'BTC range bot', unit: 'USD', closes: 25, netPnl: 2.5, beatsBaseline: 'NO', freshness: { status: 'FRESH' }, ...extra });

test('conditions: every alert the brief asks for, from data the apps already serve', () => {
  const c = conditions({
    health: { health: 'STALLED', stall: { lastCycleAgeMs: 300_000 }, stalledVenues: ['kalshi-btc'] },
    scoreboard: { rows: [row('kalshi-bot-btc', { beatsBaseline: 'YES' }), row('kalshi-bot-weather', { freshness: { status: 'STALE', ageMs: 45 * 60_000, source: 'bot run' } }), row('kalshi-farm-lab-wx1', { module: 'Kalshi farm' }), row('lab-robinhood', { kind: 'lab', beatsBaseline: 'YES' })] },
    bots: { kalshi: { btc: { label: 'Kalshi BTC range bot', standDown: { active: true } } }, farm: { variants: [{ id: 'btc-v200', standDown: { active: true } }] }, polycopy: { drawdownPause: { active: true, reason: 'down 20% from peak' } } },
    labOnline: false, labMisses: 3,
  });
  assert.deepEqual(Object.keys(c).sort(), ['beats:kalshi-bot-btc', 'drawdown:polycopy', 'engine-stalled', 'lab-offline', 'proposal:kalshi-farm-lab-wx1', 'stale:kalshi-bot-weather', 'standdown:farm-btc-v200', 'standdown:kalshi-btc', 'venue-stalled:kalshi-btc']);
  assert.match(c['engine-stalled'].body, /5 min/); assert.match(c['drawdown:polycopy'].body, /20%/);
  assert.equal(conditions({ ...quiet, labOnline: false, labMisses: 2 })['lab-offline'], undefined, 'two missed checks are not an outage');
});

test('startup is silent; a new condition alerts once; repeats wait 30 min; at most six an hour', () => {
  let t = 0; const a = createAlerter({ now: () => t });
  const stalled = { ...quiet, health: { health: 'HEALTHY', stalledVenues: ['kalshi-btc'] } };
  assert.deepEqual(a.observe(stalled), [], 'already stalled at startup: no toast storm');
  assert.deepEqual(a.observe(quiet), []);
  t += 60_000; assert.deepEqual(a.observe(stalled).map(x => x.key), ['venue-stalled:kalshi-btc']);
  t += 60_000; assert.deepEqual(a.observe(stalled), [], 'still stalled: no repeat');
  t += 60_000; a.observe(quiet); t += 60_000; assert.deepEqual(a.observe(stalled), [], 'flapping within 30 min stays quiet');
  t += 31 * 60_000; a.observe(quiet); t += 60_000; assert.equal(a.observe(stalled).length, 1);
  const many = { ...quiet, health: { health: 'HEALTHY', stalledVenues: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] } };
  t += 2 * 3600_000; a.observe(quiet); t += 60_000;
  assert.equal(a.observe(many).length, MAX_PER_HOUR);
});

test('the supervisor polls only local services, honours the Settings toggle, and Settings saves it', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.cjs'), 'utf8');
  assert.match(main, /readDesktopPrefs\(\)\.desktopAlerts === false/);
  const urls = [...main.slice(main.indexOf('async function alertTick'), main.indexOf('function portOccupied')).matchAll(/getJson\(`([^`]+)`/g)].map(m => m[1]);
  assert.deepEqual(urls, ['${BASE}/api/health', '${BASE}/api/scoreboard', '${BASE}/api/bots', 'http://127.0.0.1:${LAB_PORT}/api/health']);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  assert.match(html, /id="setAlerts" \$\{p\.desktopAlerts!==false\?'checked':''\}/);
  assert.match(html, /desktopAlerts:\$\('#setAlerts'\)\.checked/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8'), /DESKTOP_PREF_DEFAULTS = \{ runInBackground: true, startWithWindows: true, autoStartLab: true, desktopAlerts: true \}/);
});
