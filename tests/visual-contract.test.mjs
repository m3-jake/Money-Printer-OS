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
  // Combo autopilot was deleted (renovation step 5); its phrase must not come back.
  assert.doesNotMatch(combos, /ENABLE REAL AUTOPILOT/);
  assert.doesNotMatch(html, /ENABLE REAL AUTOPILOT|combos\/autopilot/);
  assert.match(html, /confirmation!=='FORGET'|phrase:\s*'FORGET'/);
  assert.match(combos, /confirmation!=='FORGET'/);
});

test('Robinhood confirmation phrases remain exact in UI, HTTP surface and backend', () => {
  const rh = read('src/robinhoodAutoTrader.js');
  const rhHttp = read('src/robinhoodHttp.js');
  const panel = read('public/assets/robinhood-panel.js');
  const phrases = ['PLACE REAL CRYPTO ORDER', 'CANCEL REAL CRYPTO ORDER', 'CANCEL REAL CRYPTO ORDERS', 'ENABLE REAL CRYPTO AUTOPILOT'];
  for (const p of phrases) { assert.match(html, rx(p)); assert.match(panel, rx(p)); }
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
  for (const route of ['/api/robinhood', '/api/robinhood/readiness', '/api/robinhood/evolve']) assert.match(rhHttp, rx(`u.pathname==='${route}'`));
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
  assert.match(css, /\.boot\s*\{[^}]*background:\s*#008080/);
  assert.match(html, /LAYOUT_VERSION='2026-09-26-alpha56-clean-shell'/);
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
  assert.equal((html.match(/class="mpo-brand-title"/g) || []).length, 2, 'Money and Updater panels both adopt .mpo-brand-title');
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
  assert.match(dashJs, /setUSComboSettings\(p\.params\)/);
});
