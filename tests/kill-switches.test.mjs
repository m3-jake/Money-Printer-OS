import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { traderSwitches } from '../src/killSwitches.js';

test('kill switches: defaults, readiness wins over env, live authority is always off', () => {
  const d = traderSwitches({ env: {} });
  assert.deepEqual(d.labLink, { enabled: true, connected: false, paperPromotionAllowed: false });
  assert.equal(d.robinhoodAutostart, true); assert.equal(d.realEnabled, false); assert.equal(d.sessionArmed, false); assert.equal(d.paperOnlyBuild, null);
  const s = traderSwitches({ env: { MPO_LAB_LINK: 'false', ROBINHOOD_AUTOSTART: 'FALSE', ROBINHOOD_REAL_ENABLED: 'true' }, readiness: { paperOnlyBuild: true, realEnabled: false, sessionArmed: false }, state: { labLink: { connected: true, paperPromotionAllowed: true } } });
  assert.equal(s.labLink.enabled, false); assert.equal(s.labLink.connected, true); assert.equal(s.robinhoodAutostart, false);
  assert.equal(s.paperOnlyBuild, true); assert.equal(s.realEnabled, false, 'a paper-only build reports real off even if the env says true');
  for (const x of [d, s]) { assert.equal(x.liveExecution, 'manual'); assert.equal(x.liveActivationAllowed, false); assert.equal(x.automaticLivePromotionAllowed, false); }
});

test('/api/health serves the switches read-only', () => {
  const src = fs.readFileSync(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  const health = src.slice(src.indexOf("u.pathname === '/api/health'"), src.indexOf("u.pathname === '/api/journal'"));
  assert.match(health, /switches: traderSwitches\(/);
  assert.doesNotMatch(health, /enqueueAction|writeFile|armRobinhood/);
});
