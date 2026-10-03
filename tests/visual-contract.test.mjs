import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('public/dashboard.html');
const dashJs = read('src/dashboard.js');
const us = read('src/polymarketUS.js');
const combos = read('src/polymarketUSCombos.js');
const css = read('public/css/mpo-shell.css') + '\n' + read('public/css/mpo-workstation.css');
const all = html + '\n' + css;
const rx = s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));


test('embedded dashboard script parses as JavaScript', () => {
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.lastIndexOf('</script>');
  assert.ok(start >= '<script>'.length && end > start);
  assert.doesNotThrow(() => new vm.Script(html.slice(start, end), { filename: 'dashboard-inline.js' }));
});

test('confirmation phrases remain exact in UI and backends', () => {
  // One Polymarket panel (renovation step 7): only the combo phrase and FORGET remain in the UI.
  assert.match(html, rx('PLACE REAL COMBO'));
  for (const gone of ['PLACE REAL ORDER', 'CLOSE REAL POSITION', 'CANCEL REAL ORDER']) assert.doesNotMatch(html, rx(gone));
  // The phrase field is typed by the operator, never pre-filled from code.
  assert.match(html, rx("input.value='';input.placeholder='Type '+phrase"));
  assert.match(us, /PLACE REAL ORDER/);
  assert.match(us, /CLOSE REAL POSITION/);
  assert.match(us, /CANCEL REAL ORDER/);
  assert.match(us, /CANCEL REAL ORDERS/);
  assert.match(combos, /CONFIRM_PLACE='PLACE REAL COMBO'|PLACE REAL COMBO/);
  // AUTO COMBO is back (opt-in): the phrase lives only in the backend; the UI asks the operator to
  // type the phrase the server supplies, and the HTTP place route can never place as autopilot.
  assert.match(combos, /CONFIRM_AUTOPILOT='ENABLE REAL AUTOPILOT'/);
  assert.doesNotMatch(html, /ENABLE REAL AUTOPILOT/);
  assert.ok(html.includes("const phrase=ap.confirmPhrase;if(!phrase)return;"));
  assert.ok(html.includes("id=\"usAutoOn\" ${canEnable?'':'disabled'}"));
  assert.ok(dashJs.includes("u.pathname === '/api/polymarket-us/combos/autopilot') { try{return json(res,{ok:true,autopilot:await setUSComboAutopilot(b)})}"));
  assert.match(dashJs, /combos\/place'\)[^\n]*placedBy:'manual'/);
  assert.match(html, /confirmation!=='FORGET'|phrase:\s*'FORGET'/);
  assert.match(combos, /confirmation!=='FORGET'/);
});

test('Robinhood confirmation phrases stay exact in the backend; the paper-only HUD shows none of them (2026-10-02)', () => {
  const rh = read('src/robinhoodAutoTrader.js');
  const rhHttp = read('src/robinhoodHttp.js');
  const panel = read('public/assets/robinhood-panel.js');
  const phrases = ['PLACE REAL CRYPTO ORDER', 'CANCEL REAL CRYPTO ORDER', 'CANCEL REAL CRYPTO ORDERS', 'ENABLE REAL CRYPTO AUTOPILOT'];
  for (const p of phrases) { assert.doesNotMatch(html, rx(p)); assert.doesNotMatch(panel, rx(p)); }
  assert.match(rh, /CONFIRM_PLACE='PLACE REAL CRYPTO ORDER'/);
  assert.match(rh, /CONFIRM_CANCEL='CANCEL REAL CRYPTO ORDER'/);
  assert.match(rh, /CONFIRM_CANCEL_ALL='CANCEL REAL CRYPTO ORDERS'/);
  assert.match(rh, /CONFIRM_AUTOPILOT='ENABLE REAL CRYPTO AUTOPILOT'/);
  assert.match(rh, /CONFIRM_FORGET='FORGET'/);
  assert.match(rh, /confirmation!=='FORGET'/);
  assert.match(rh, /const PAPER_ONLY_BUILD=true/, 'production Robinhood build is paper-only');
  assert.match(rh, /realEnabled=\(\)=>!paperOnlyBuild\(\)&&String\(process\.env\.ROBINHOOD_REAL_ENABLED\|\|'false'\)\.toLowerCase\(\)==='true'/, 'paper-only build lock wins even if the env requests live mode');
  assert.match(rhHttp, /confirmation!=='RESET PAPER'/);
  assert.match(rhHttp, /placedBy:'manual'/, 'HTTP never places as autopilot');
  assert.match(rhHttp, /'evolve\/apply'/);
  assert.match(dashJs, /handleRobinhoodRequest\(req,res,u,\{json,body\}\)/);
  for (const route of ['/api/robinhood', '/api/robinhood/readiness', '/api/robinhood/evolve', '/api/robinhood/practice']) assert.match(rhHttp, rx(`u.pathname==='${route}'`));
  // Multi-asset suite: practice mutations go through the same guarded POST surface; stocks & ETFs are GET-only.
  for (const a of ['practice/config', 'practice/run', 'practice/order', 'practice/close', 'practice/reset']) { assert.ok(rhHttp.includes(`'${a}':()=>RP.`), a); assert.ok(panel.includes(`rhAction('${a}'`), a); }
  assert.match(dashJs, /handleRobinhoodEquitiesRequest\(req,res,u,\{json\}\)/);
  assert.match(panel, /fetch\('\/api\/robinhood-equities'\)/);
  assert.match(panel, /Nothing here places real orders/);
  assert.doesNotMatch(rh, /automaticLivePromotionAllowed\s*[:=]\s*true|liveActivationAllowed\s*[:=]\s*true/);
});

test('GET /css/ handler exists next to /assets/', () => {
  assert.match(dashJs, /pathname\.startsWith\('\/css\/'\)/);
  assert.match(dashJs, /'text\/css'/);
  const assetsAt = dashJs.indexOf("pathname.startsWith('/assets/')");
  const cssAt = dashJs.indexOf("pathname.startsWith('/css/')");
  assert.ok(assetsAt >= 0 && cssAt > assetsAt, '/css/ must be registered immediately after /assets/');
});

test('benchmark poly classes and frozen 4-col grid remain', () => {
  for (const c of ['poly-strip', 'poly-bar', 'poly-mod', 'metric-grid', 'heroPrice']) {
    assert.match(all, rx(c));
  }
  assert.match(css, /metric-grid\{[^}]*repeat\(4,\s*1fr\)/);
});

test('PR0 tokens are current computed values', () => {
  assert.match(css, /--mpo-term-label:\s*#7da987/);
  assert.match(css, /--mpo-fs-micro:\s*10px/);
  assert.match(css, /--mpo-fs-metric:\s*18px/);
  assert.match(css, /--mpo-fs-cell:\s*12px/);
});

test('identity: no Inter / Google Fonts', () => {
  assert.doesNotMatch(all, /fonts\.googleapis|font-family:\s*Inter/i);
});

test('dashboard.html still hosts behavior (no login screen)', () => {
  assert.match(html, /id="boot"/);
  assert.doesNotMatch(html, /id="login"|password.*unlock/i);
  assert.match(html, /href="\/css\/mpo-shell\.css"/);
  assert.match(html, /href="\/css\/mpo-workstation\.css"/);
});

test('GET /css/ serves stylesheets and rejects traversal', async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && u.pathname.startsWith('/css/')) {
      const rel = decodeURIComponent(u.pathname.slice('/css/'.length));
      const base = path.join(root, 'public', 'css');
      const file = path.resolve(base, rel);
      if (!file.startsWith(path.resolve(base) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); return res.end('not found');
      }
      if (path.extname(file).toLowerCase() !== '.css') { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/css/mpo-shell.css`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type') || '', /text\/css/);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await ok.text(), /--mpo-chrome:\s*#c0c0c0/);
    const trav = await fetch(`http://127.0.0.1:${port}/css/../dashboard.html`);
    assert.equal(trav.status, 404);
    const html404 = await fetch(`http://127.0.0.1:${port}/css/mpo-shell.css/../../dashboard.html`);
    assert.equal(html404.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('shared workstation recipes ship on laggard panes', () => {
  for (const c of ['mpo-metric', 'mpo-badge', 'mpo-empty', 'mpo-error', 'mpo-surface-dark', 'mpo-surface-light']) {
    assert.match(html, rx(c));
    assert.match(css, rx(c));
  }
  assert.match(html, /mpo-fieldset/);
  assert.match(html, /mpo-table/);
  assert.doesNotMatch(html, /Enable Unified Edge/);
  assert.match(html, /dailyLossLimitSol/);
  assert.match(html, /RISK RADAR/);
  assert.match(html, /CONTROL BAY/);
  assert.match(html, /WALLET INTEL/);
  assert.match(html, /SYSTEM MONITOR/);
  assert.match(html, /HIVE EQUITY/);
});

test('chrome stays opaque and the simplified alpha56 shell contract is pinned', () => {
  assert.match(css, /\.titlebar\s*\{[^}]*background:\s*var\(--mpo-navy\)/);
  assert.match(css, /\.taskbar\s*\{[^}]*z-index:\s*100/);
  assert.match(css, /\.brand\s*\{[^}]*z-index:\s*6/);
  // The boot overlay is a log-on box over open sky (the desktop starts zoomed into it), not a teal screen.
  assert.match(css, /\.boot\s*\{[^}]*background:\s*transparent/);
  assert.match(html, /<div class="desktop camera-sky" id="desktop">/);
  assert.match(html, /LAYOUT_VERSION='2026-09-26-glance'/);
  assert.match(html, /\['trade','Pump\.fun'/);assert.match(html, /\['robinhood','Robinhood'/);assert.match(html, /\['researchmon','Lab Monitor','LAB','dark','trade'/);
  assert.doesNotMatch(html, /<div class="menu" title="Menus are not wired">/);
  assert.doesNotMatch(html, /mpo-surface-(dark|light)[\s\S]{0,80}poly-strip|poly-strip[\s\S]{0,80}mpo-surface/);
});

test('laggard panes opt into surfaces; sportsbook host does not', () => {
  assert.match(html, /function renderTrade\(\)[\s\S]*mpo-surface-dark/);
  assert.match(html, /function renderEvolution\(\)[\s\S]*mpo-surface-dark/);
  assert.match(html, /function renderRisk\(\)[\s\S]*mpo-surface-dark/);
  assert.match(html, /function renderNetwork\(\)[\s\S]*mpo-surface-dark/);
  assert.match(html, /function renderJournal\(\)[\s\S]*mpo-surface-dark/);
  assert.match(html, /function renderWallet\(\)[\s\S]*mpo-surface-light/);
  assert.match(html, /function renderControl\(\)[\s\S]*mpo-surface-light/);
  assert.match(html, /function renderUpdater\(\)[\s\S]*mpo-surface-light/);
  assert.match(html, /setBody\('money',`[\s\S]*mpo-surface-light/);
  assert.match(html, /setBody\('settings',`[\s\S]*mpo-surface-light/);
  assert.doesNotMatch(html, /function renderSportsbook\(\)[\s\S]{0,400}mpo-surface/);
});

test('integrated FX is profit-only money rain/pile with no fire', () => {
  assert.match(html, /function updateDesktopEffects/);
  assert.match(html, /ahead=known&&pnlSol>1e-6&&pnlPct>0/);
  assert.match(html, /if\(!m\.ahead\)/);
  assert.match(html, /makeRainBills/);
  assert.match(html, /makePileBills/);
  assert.match(html, /id="moneyPile"/);
  assert.match(html, /trackRealizedProfitBurst/);
  assert.match(html, /trackComboProfitBurst/);
  assert.doesNotMatch(html, /makeFireSprites|horizonFire|bottomFire|fire-low\.webp|fire-high\.webp/);
  assert.doesNotMatch(css, /\.fire-sprite|\.horizon-fire|\.bottom-fire/);
  assert.match(css, /url\('\/assets\/money-bill\.webp'\)/);
  assert.match(css, /\.money-pile/);
  assert.match(css, /\.money-event-feed\s*\{[\s\S]*?right:\s*18px/);
  assert.match(html, /id="moneyEventFeed"/);
  assert.match(css, /prefers-reduced-motion/);
});

test('desktop keeps only platform-scale launchers; Command Center owns the supporting desks', () => {
  for (const [id, label] of [['arbitrage','Arbitrage'],['stocks','Stocks'],['marketlab','Market Lab'],['macro','Macro'],['edgar','EDGAR'],['weather','Weather'],['sports','Sports'],['wire','Wire']]) {
    assert.match(html, new RegExp("\\['" + id + "','" + label + "'[^\\]]*,'command'\\]"));
  }
  const desktop = html.match(/const DESKTOP_ICONS=\[([^\]]+)\]/)?.[1] || '';
  for (const id of ['arbitrage','stocks','marketlab','macro','edgar','weather','sports','wire']) assert.doesNotMatch(desktop, new RegExp("['\"]" + id + "['\"]"));
  assert.match(desktop, /['"]command['"]/);
});

test('desktop event feed is compact, importance-aware, and money shares the environment breeze', () => {
  assert.match(html, /const MONEY_EVENT_META=/);
  assert.match(html, /'major-win':\{ttl:120000/);
  assert.match(html, /ambient:\{ttl:50000/);
  assert.match(html, /moneyEvents\.slice\(-14\)/);
  assert.match(html, /x\.count=\(x\.count\|\|1\)\+1/);
  assert.match(css, /max-height:\s*220px/);
  assert.match(css, /@keyframes moneyEventLife/);
  assert.match(css, /animation-duration:\s*var\(--event-life,75s\)/);
  assert.match(html, /function fxWind\(t\)\{return environmentWindAt\(t\)\.pxs\}/);
  assert.match(html, /const ENV_WIND=Object\.freeze/);
  assert.match(html, /class="cloud-shadows"/);
  assert.match(html, /class="grass-layer"/);
  assert.match(css, /@keyframes cloudShadowDrift/);
  assert.match(css, /@keyframes grassSwayNear/);
  assert.match(html, /b\.vx=fxRand\(14,30\)/);
});

test('Journal is a first-class desktop surface', () => {
  assert.match(html, /\['journal','Journal','JRN','dark'\]/);
  assert.match(html, /DESKTOP_ICONS=\[[^\]]*['"]journal['"]/);
  assert.match(html, /journal:\{x:\d+,y:\d+,w:\d+,h:\d+\}/);
  assert.match(html, /function renderJournal\(\)/);
  assert.match(html, /<legend>Today<\/legend>/);
  assert.match(html, /<legend>Recent<\/legend>/);
  assert.match(html, /id="journalQ"/);
  assert.match(css, /\.mpo-journal-entry\.is-milestone/);
  assert.match(css, /\.mpo-journal-glance/);
});

test('Experiment Monitor leaderboard exposes live research fields', () => {
  assert.match(html, /function renderResearchMonitor\(\)/);
  assert.match(html, /<th>Age<\/th>/);
  assert.match(html, /<th>Status<\/th>/);
  assert.match(html, /<th>Shadow P\/L<\/th>/);
  assert.match(html, /<th>DD<\/th>/);
  assert.match(html, /<th>Trades<\/th>/);
  assert.match(html, /<th>Conf<\/th>/);
  assert.match(html, /POLICY/);
  assert.match(html, /CHAMPION/);
  assert.match(html, /PROMOTION/);
  assert.match(html, /PAPER CANARY/);
  assert.match(dashJs, /activeEvolutionPolicy/);
  assert.match(dashJs, /paperCanary/);
  assert.match(dashJs, /shadowPnl/);
  assert.match(dashJs, /automaticLivePromotionAllowed:\s*false/);
});

test('shared visual token/component consolidation (VISUAL-AUDIT §5/§6) is adopted, not regressed', () => {
  // §5 additive tokens — no renames/removals of existing ones, these are new.
  assert.match(css, /--mpo-warn:\s*#ff7a3d/);
  assert.match(css, /--mpo-warn-bg:\s*#1a0e06/);
  // §5 new components, defined next to .poly-mod in mpo-workstation.css.
  assert.match(css, /\.mpo-module\s*\{/);
  assert.match(css, /\.mpo-module\s*>\s*header\s*\{/);
  assert.match(css, /\.mpo-module-body\s*\{/);
  assert.match(css, /\.mpo-meter\s*\{/);
  assert.match(css, /\.mpo-brand-title\s*\{/);
  assert.match(css, /\.mpo-danger-fieldset\s*\{/);
  // .poly-mod itself must stay untouched — the new classes generalize it, not replace it.
  assert.match(css, /\.poly-mod\s*\{/);
  assert.match(css, /\.poly-mod\s*>\s*header\s*\{/);
  // §2/§6 — the benchmark's own real-money fieldset must no longer hardcode the
  // warn colors inline; it must use the token-driven class instead.
  assert.doesNotMatch(html, /#ff7a3d/);
  assert.doesNotMatch(html, /#1a0e06/);
  assert.match(html, /class="mpo-danger-fieldset"/);
  // §6 per-screen migration — class swaps, ids/behavior unchanged.
  assert.match(html, /function renderSystem\(\)[\s\S]*mpo-module/);
  assert.match(html, /id="sysTelemetry"/);
  assert.match(html, /id="sysControls"/);
  assert.match(html, /function renderResearchMonitor\(\)[\s\S]*mpo-module/);
  assert.match(html, /function renderResearchMonitor\(\)[\s\S]*mpo-meter-bar/);
  assert.match(html, /function renderControl\(\)[\s\S]*mpo-module/);
  assert.match(html, /id="testKill"/);
  assert.match(html, /function renderWallet\(\)[\s\S]*mpo-meter-bar--sm/);
  assert.match(html, /function renderRisk\(\)[\s\S]*class="mpo-meter"/);
  assert.match(html, /class="mpo-brand-title"/g);
  assert.equal((html.match(/class="mpo-brand-title"/g) || []).length, 1, 'Updater retains its brand title');
  assert.match(html, /class="g-brand-name">MONEY PRINTER OS/, 'Money shares its overview brand between both window modes');
});

test('glance telemetry recipes land on laggard panes without restyling Suite', () => {
  assert.match(css, /\.mpo-sysrow/);
  assert.match(css, /\.sysbar\.warn/);
  assert.match(css, /\.mpo-peer/);
  assert.match(css, /\.mpo-log-pane/);
  assert.match(css, /\.mpo-spark/);
  assert.match(css, /\.mpo-gauge/);
  assert.match(html, /function renderLog\(\)[\s\S]*LIVE LOG/);
  assert.match(html, /function renderRisk\(\)[\s\S]*Daily loss budget/);
  assert.match(html, /function renderNetwork\(\)[\s\S]*mpo-peer/);
  assert.match(html, /function renderSystem\(\)[\s\S]*mpo-sysrow/);
  assert.match(html, /function renderUpdater\(\)[\s\S]*mpo-loading/);
  assert.match(html, /function renderTrade\(\)[\s\S]*Symbol[\s\S]*Edge[\s\S]*5m[\s\S]*Liq[\s\S]*Stage/);
  assert.match(html, /strokeStyle='#39ff68'/);
  assert.match(html, /rgba\(57,255,104,\.14\)/);
  assert.doesNotMatch(html, /function renderSportsbook\(\)[\s\S]{0,400}mpo-surface/);
  assert.match(html, /window\.prompt/);
});

test('Polymarket key shows CONNECTED only after a verified signed call, and the balance is served read-only', () => {
  assert.match(html, /'KEY NOT VERIFIED'/);
  assert.match(html, /keyOk\?'CONNECTED'/);
  assert.doesNotMatch(html, /rd\.credentialsReady\?'CONNECTED'/);
  assert.match(html, /id="usBalance"/);
  assert.match(dashJs, /req\.method === 'GET' && u\.pathname === '\/api\/polymarket-us\/account'/);
});

test('Polymarket panel lists the whole live board grouped by sport, renders the suggested combo, and always offers key replacement', () => {
  assert.match(html, /Array\.isArray\(ucs\.board\)/);
  assert.match(html, /outside strategy window/);
  assert.match(html, /id="usUseSuggested"/);
  assert.match(html, /Replace key \(not verified yet\)/);
  assert.match(html, /combo-enabled live/);
});

test('Polymarket panel exposes the strategy window, 2-4 legs, and per-window record', () => {
  assert.match(html, /id="usSetWindow"/);
  assert.match(html, /\[2,3,4\]\.map\(/);
  assert.match(html, /Record by window/);
});

test('Polymarket panel shows shadow record, calibration and a one-click Lab apply that the server validates', () => {
  assert.match(html, /function usResearchHtml\(/);
  assert.match(html, /id="usApplyLab"/);
  assert.match(html, /\/api\/polymarket-us\/evidence/);
  assert.match(dashJs, /\/api\/polymarket-us\/combos\/apply-lab/);
  assert.match(dashJs, /setPaperLabPolicy\(p\)/);
});

test('live visuals: one animation engine, served read-only from /js, used by Polymarket, Robinhood and Pump.fun', () => {
  const viz = read('public/js/mpo-viz.js');
  const frames = [];
  const win = { matchMedia: () => ({ matches: false }), devicePixelRatio: 1, addEventListener(){} };
  const sandbox = { window: win, document: { hidden: false, querySelectorAll: () => [], addEventListener(){} }, performance: { now: () => 0 }, requestAnimationFrame: f => frames.push(f), console };
  vm.runInNewContext(viz, sandbox, { filename: 'mpo-viz.js' });
  assert.deepEqual([...win.MPOViz.types].sort(), ['bubbles', 'edge', 'funnel', 'gauge', 'hist', 'lanes', 'lines', 'pulse', 'scatter', 'ticker']);
  assert.match(win.MPOViz.canvas('k', 50, '<t>'), /data-viz="k"[^>]*height:50px/);
  assert.doesNotMatch(win.MPOViz.canvas('k', 50, '<t>'), /<t>/, 'titles are escaped');
  assert.equal(JSON.stringify(win.MPOViz.beat('b', 5)), '[5]'); assert.equal(JSON.stringify(win.MPOViz.beat('b', 5)), '[5]', 'same beat not repeated');
  assert.equal(frames.length, 1, 'a single rAF loop');
  assert.match(viz, /document\.hidden/); assert.match(viz, /prefers-reduced-motion/);
  assert.match(html, /<script src="\/js\/mpo-viz\.js"><\/script>/);
  assert.match(dashJs, /u\.pathname\.startsWith\('\/js\/'\)/);
  assert.match(dashJs, /path\.extname\(file\)\.toLowerCase\(\) !== '\.js'/);
  for (const key of ['pm-lanes', 'pm-hist', 'pm-pulse', 'pm-shadow', 'pm-cal', 'rh-edge', 'rh-ticker', 'rh-pulse', 'pf-map', 'pf-meme', 'pf-funnel', 'pf-ticker', 'pf-pulse']) assert.ok(html.includes(`MPOViz.set('${key}'`), key);
});

test('layout persistence: saved spots are authoritative and launch restoration is opt-in', () => {
  const resetAt = html.indexOf("$('#setResetLayout')?.addEventListener");
  assert.ok(resetAt > 0, 'reset handler exists');
  const outside = html.slice(0, resetAt) + html.slice(html.indexOf('\n', resetAt));
  assert.doesNotMatch(outside, /removeItem\('mpo-layout'\)/, 'only the reset handler may wipe mpo-layout');
  assert.match(html, /restoreOnLaunch:false/);
  assert.doesNotMatch(html, /mpo-restore-migrated/);
  assert.match(html, /mpo-size-migrated-0927/);
  assert.match(html, /window\.__mpoPersist=/);
  assert.match(html, /addEventListener\('pagehide',persist\)/);
  assert.match(html, /mpo-chart-view/);
  assert.match(html, /window\.addEventListener\('resize',\(\)=>\{reflowAll\(\)\}\)/, 'resize reflows windows back to their saved spot');
});

test('startup stays empty for fresh and existing preferences; explicit restoration preserves saved apps', () => {
  const startup = html.slice(html.indexOf('const DEFAULT_OPEN='), html.indexOf('// One-time 12% shrink'));
  const focus = html.match(/^const bootFocus=.*$/m)[0];
  const launch = (prefs = {}, phone = false) => {
    const context = {
      window: { __MPO_DEMO__: phone, MPOHud: {
        preferences: { read: (key, fallback) => prefs[key] ?? fallback, write() {}, remove() {} },
        sanitizeLayout: layout => layout,
      } },
      HOSTS: ['trade', 'journal'], defaultLayout: {}, tabsOf: id => [id],
      matchMedia: () => ({ matches: phone }),
    };
    vm.runInNewContext(`${startup}\n${focus}\nresult={open:[...openSet],focus:bootFocus,saved};`, context);
    return JSON.parse(JSON.stringify(context.result));
  };
  assert.deepEqual(launch().open, []);
  const legacy = { 'mpo-open': ['trade'], 'mpo-last-focus': 'trade', 'mpo-display': { restoreAll: true }, 'mpo-layout': { trade: { x: 80, y: 60, w: 620, h: 480 } } };
  const empty = launch(legacy);
  assert.deepEqual(empty.open, [], 'old saved open apps do not reopen automatically');
  assert.equal(empty.focus, null, 'last focus cannot force Pump.fun back open');
  assert.deepEqual(empty.saved, legacy['mpo-layout'], 'window positions remain available when an app is opened');
  const optedIn = { ...legacy, 'mpo-open': ['trade', 'journal', 'obsolete'], 'mpo-display': { restoreOnLaunch: true } };
  assert.deepEqual(launch(optedIn).open, ['trade', 'journal']);
  assert.deepEqual(launch(optedIn, true).open, [], 'phone home remains empty');
  assert.deepEqual(launch({ ...optedIn, 'mpo-open': [] }).open, [], 'an empty restored session stays empty');
});

test('desktop window state: bounds restored, shown late, storage flushed on quit', () => {
  const main = read('desktop/main.cjs');
  assert.match(main, /show:false/);
  assert.match(main, /require\('\.\/window-state\.cjs'\)/);
  assert.match(main, /flushStorageData/);
  const create = main.slice(main.indexOf('function createWindow()'));
  const maxAt = create.indexOf('win.maximize()'), loadAt = create.indexOf('win.loadURL(');
  assert.ok(maxAt > 0 && loadAt > maxAt, 'maximize happens before the first loadURL');
});

test('glance design: every window opens as one calm card, full detail is an option, text size sets the fit ceiling', () => {
  const glanceCss = read('public/css/mpo-glance.css');
  assert.match(html, /<link rel="stylesheet" href="\/css\/mpo-glance\.css">/);
  assert.match(html, /DEFAULT_OPEN=\[\]/, 'fresh install starts with an empty desktop');
  assert.match(html, /const shown=openSet\.has\(id\)&&!L\.min/, 'only explicitly restored apps are shown at launch');
  for (const host of ['trade', 'sportsbook', 'robinhood', 'system', 'journal', 'money']) assert.match(html, new RegExp(`\\n ${host}:\\{render:glance`), `${host} has a glance`);
  assert.match(html, /data-act="detail" class="detail-btn"/, 'every title bar has its own Simple / Advanced button');
  assert.match(html, /<div class="mode-switch" role="group" aria-label="Window mode"><button class="task-tool" id="modeSimple"[^>]*>Simple<\/button><button class="task-tool" id="modeAdvanced"[^>]*>Advanced<\/button><\/div>/, 'taskbar switch flips every window');
  assert.match(html, /\$\('#modeSimple'\)\.onclick=\(\)=>setGlobalMode\(false\);\$\('#modeAdvanced'\)\.onclick=\(\)=>setGlobalMode\(true\);/);
  assert.match(html, /const TEXT_SCALES=\{S:\.9,M:1\.1,L:1\.3\}/);
  assert.match(html, /const FIT_MIN=\.5;let FIT_MAX=textScale\(\);/, 'text size is the fit-zoom ceiling');
  assert.match(html, /id="setFullDetail"/);assert.match(html, /id="setRestoreOnLaunch"/);assert.match(html, /data-textsize=/);
  assert.match(html, /if\(!w\|\|w\.classList\.contains\('hidden'\)\|\|w\.classList\.contains\('glance'\)\)return false;/, 'detail renderers skip glance windows');
  for (const id of ['sportsbook', 'journal']) assert.match(html, new RegExp(`windowShown\\('${id}'\\)\\)refresh`), `${id} data keeps flowing for its glance`);
  assert.match(html, /windowShown\('robinhood'\)\|\|windowShown\('money'\)\)\)refreshRobinhood\(\)/, 'Robinhood data refreshes for its suite and Money overview');
  assert.match(html, /gRow\('Stocks & ETFs',[^\n]*gRow\('Practice',/, 'Robinhood glance carries the stocks & ETFs and practice lines');
  assert.match(html, /setGlance\('robinhood',glance\(\{title:'Robinhood · paper only'/);
  assert.match(glanceCss, /\.window\.glance > \.body,\s*\.window\.glance > \.win-tabs \{ display: none; \}/);
  assert.match(glanceCss, /\.glancepane \{[^}]*container-type: inline-size/);
  assert.doesNotMatch(html.slice(html.indexOf('function glance('), html.indexOf('function renderGlances')), /mpo-brand-title/);
});

test('paper-focus batch (2026-10-02): rolling numbers, Kalshi weather glance and a lighter state payload', () => {
  const roll = read('public/js/mpo-roll.js'), platform = read('public/js/mpo-platform.js'), glanceCss = read('public/css/mpo-glance.css');
  assert.doesNotThrow(() => new vm.Script(roll, { filename: 'mpo-roll.js' }));
  assert.match(html, /<script src="\/js\/mpo-roll\.js"><\/script>/);
  assert.match(html, /buildWindows\(\);window\.MPORoll\?\.watch\(\);/, 'glance panes exist before the roll observer attaches');
  assert.match(roll, /observer\.observe\(p, \{ childList: true \}\)/, 'childList only, so inserted wheels never re-trigger the observer');
  assert.match(roll, /mpo-low-motion/, 'Reduce animation turns the roll off');
  assert.match(glanceCss, /\.glancepane span\.roll-d \{/, 'wheel styles are scoped above tile/row span rules');
  assert.match(platform, /if\(id==='kalshi'&&typeof glance==='function'\)return kalshiGlance\(\);/);
  assert.match(platform, /request\('\/weather'\)/, 'the Kalshi glance reads the server-cached weather desk');
  assert.match(platform, /title:'Kalshi overview'/, 'the Kalshi home covers the whole suite');
  for (const title of ['Market universe', 'Separate paper books', 'Upcoming markets & activity', 'Data health', 'Weather preview']) assert.ok(platform.includes(title), title);
  assert.ok(platform.includes('Each model keeps its own simulated funds and results.'), 'paper books remain independently labeled');
  for (const s of ["['kalshibots','Paper bots','BOT','dark','kalshi']", "['pmcopy','Copy trading','CPY','dark','sportsbook']", '<script src="/js/mpo-bots.js"></script>']) assert.ok(html.includes(s), s);
  assert.doesNotThrow(() => new vm.Script(read('public/js/mpo-bots.js'), { filename: 'mpo-bots.js' }));
  assert.match(dashJs, /portfolioSeries: compactSeries\(s\.portfolioSeries,1000,600\)\.map\(roundSeriesPoint\)/);
  const ctx = vm.createContext({}); vm.runInContext(dashJs.slice(dashJs.indexOf('const roundSol='), dashJs.indexOf('// alpha.53:')), ctx);
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(roundSeriesPoint({ts:1,mode:'PAPER',equitySol:0.95982771586,cashSol:1,unrealizedSol:null}))", ctx)), { ts: 1, mode: 'PAPER', equitySol: 0.959828, cashSol: 1, unrealizedSol: null });
});
