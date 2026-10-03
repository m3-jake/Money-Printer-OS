import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public', 'dashboard.html'), 'utf8');
const dashJs = fs.readFileSync(path.join(root, 'src', 'dashboard.js'), 'utf8');
// Every inline script part, in document order (run D2 split the one inline script around loaded window files).
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

function extractFn(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} missing from dashboard script`);
  let i = script.indexOf('{', start), depth = 0;
  for (; i < script.length; i++) {
    const ch = script[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return script.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

test('dashboard inline script still parses after alpha52 UI reconciliation', () => {
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'dashboard-inline.js' }));
});

test('money rain requires known positive paper equity and never defaults start SOL', () => {
  const ctx = { state: null, Date, Math };
  vm.runInNewContext(`${extractFn('clamp01')}\n${extractFn('sessionFxMetrics')}\nthis.metrics = sessionFxMetrics`, ctx);
  ctx.state = { paperStartSol: 1, portfolio: { equitySol: 1 } };
  let m = ctx.metrics();
  assert.equal(m.ahead, false);
  assert.equal(m.intensity, 0);
  ctx.state = { paperStartSol: 1, portfolio: { equitySol: 1.25 } };
  m = ctx.metrics();
  assert.equal(m.ahead, true);
  assert.ok(m.pnlPct > 0);
  assert.ok(m.intensity > 0);
  ctx.state = { portfolio: { equitySol: 50 } };
  m = ctx.metrics();
  assert.equal(m.known, false);
  assert.equal(m.ahead, false);
  assert.doesNotMatch(script, /paperStartSol\s*\|\|\s*10/);
  assert.match(script, /if\(!m\.ahead\)/);
  assert.match(script, /makeRainBills/);
  assert.match(script, /makePileBills/);
});

test('realized and combo bursts still require actual positive P&L', () => {
  assert.match(script, /v>fxLastRealizedSol\+1e-9/);
  assert.match(script, /status\).toUpperCase\(\)==='WON'&&Number\(x\?\.pnlUsd\)>0/);
  assert.match(script, /if\(!\(amount>0\)\)return/);
});

test('fire/blaze is absent from normal terminal renderer', () => {
  assert.doesNotMatch(script, /makeFireSprites|makeSmokeSprites|horizonFire|bottomFire/);
  assert.doesNotMatch(html, /class="market-fx horizon-fire"|class="market-fx bottom-fire"/);
});

test('Experiment Monitor renderer binds policy, champion, promotion, and live leaderboard columns', () => {
  assert.match(script, /function renderResearchMonitor/);
  assert.match(script, /activeEvolutionPolicy/);
  assert.match(script, /paperCanary/);
  assert.match(script, /<th>Age<\/th><th>Status<\/th><th>Shadow P\/L<\/th><th>DD<\/th><th>Trades<\/th><th>Conf<\/th>/);
  assert.match(dashJs, /function decorateResearchMonitor/);
  assert.match(dashJs, /automaticLivePromotionAllowed: false/);
  assert.match(dashJs, /shadowPnl/);
  assert.match(dashJs, /activeEvolutionPolicy/);
});

test('Journal is a desktop host using project-journal data, not a Trade tab', () => {
  assert.match(html, /\['journal','Journal','JRN','dark'\]/);
  assert.match(html, /DESKTOP_ICONS=\[[^\]]*['"]journal['"]/);
  assert.match(html, /\['archive','Archive','DB','light','trade'\]/);
  assert.match(script, /function renderJournal/);
  assert.match(script, /\/api\/project-journal/);
  assert.doesNotMatch(script, /\/api\/os-journal/);
  assert.match(script, /No invented profit claims/);
});
