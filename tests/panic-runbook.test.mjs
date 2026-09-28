// P0.5: the panic path is documented *and* checked. A runbook that names endpoints, flags or codes
// that no longer exist is worse than no runbook, so every identifier docs/RUNBOOK-PANIC.md relies on
// is asserted here against the source, and the numbers it documents are compared with the defaults
// in config.js. If a fix moves something the runbook names, this test fails with the reader's name.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = relative => fs.readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const runbook = read('docs/RUNBOOK-PANIC.md');
const source = { dashboard: read('src/dashboard.js'), engine: read('src/index.js'), store: read('src/store.js'), config: read('src/config.js'), recovery: read('src/cycleRecovery.js'), budget: read('src/cycleBudget.js'), supervisor: read('src/supervisor.js'), http: read('src/core/http.js'), accounting: read('src/accounting.js') };

const mentions = (doc, term) => assert.ok(doc.includes(term), `the runbook no longer mentions ${term}`);

test('the runbook covers stop, verify, recover, reset and exit codes', () => {
  for (const heading of ['## 1. Stop now', '## 2. Verify it stopped', '## 3. When the state file is the problem', '## 4. Reset (paper only)', '## 6. Exit codes']) mentions(runbook, heading);
  assert.ok(fileURLToPath(new URL('../docs/RUNBOOK-PANIC.md', import.meta.url)).length > 0);
});

test('every endpoint and control the runbook names still exists', () => {
  for (const path of ['/api/kill', '/api/pause', '/api/reset', '/api/clear-error', '/api/health', '/api/journal', '/api/state']) {
    mentions(runbook, path);
    assert.ok(source.dashboard.includes(`'${path}'`), `${path} is not routed in dashboard.js`);
  }
  for (const action of ['toggle-kill', 'toggle-pause', 'reset-paper', 'clear-error']) {
    mentions(runbook, action);
    assert.ok(source.dashboard.includes(action), `${action} is not queued by the dashboard`);
  }
  assert.ok(source.engine.includes('kill-switch'), 'the kill switch reason moved out of the entry gate');
  assert.ok(source.dashboard.includes('localMutationAllowed') && source.http.includes('Local same-origin JSON request required'));
  assert.ok(runbook.includes('403 Local same-origin JSON request required'));
});

test('every diagnostic code and health field the runbook names still exists', () => {
  for (const code of ['CYCLE_ERROR_STREAK', 'CYCLE_BUDGET_EXCEEDED', 'MARKET_BUDGET_REJECTED', 'MARKET_RATE_LIMIT', 'HELD_PRICE_UNVERIFIED', 'STALE_CYCLE', 'FEED_STALE', 'RPC_DOWN']) {
    mentions(runbook, code);
    assert.ok(source.engine.includes(code) || source.supervisor.includes(code) || source.recovery.includes(code) || source.budget.includes(code), `${code} is no longer produced anywhere`);
  }
  for (const field of ['saveFailed', 'pendingErrorRows', 'abortStreak', 'degradeAfter']) {
    mentions(runbook, field);
    assert.ok(source.recovery.includes(field), `cycleRecovery no longer reports ${field}`);
  }
  for (const field of ['ok:', 'lastCycle', 'diagnostics', 'marketRequests', 'marketBudget']) {
    assert.ok(source.dashboard.includes(field), `/api/health no longer reports ${field}`);
  }
  assert.ok(source.supervisor.includes("'DEGRADED'") && source.dashboard.includes("!== 'DEGRADED'"), 'the ok/health derivation moved');
});


test('the documented state-file recovery story matches store.js', () => {
  mentions(runbook, 'EQUITY_JUMP');
  assert.ok(source.store.includes("code = 'EQUITY_JUMP'"), 'store.js no longer refuses an equity jump');
  assert.ok(source.accounting.includes('guardEquityJump'), 'the guard behind that refusal moved');
  mentions(runbook, 'BACKUP_RECOVERED');
  assert.ok(source.store.includes('BACKUP_RECOVERED') && source.store.includes('reviewRequired'));
  mentions(runbook, 'STATE_RECOVERY_REQUIRED');
  assert.ok(source.store.includes('STATE_RECOVERY_REQUIRED'));
  assert.ok(source.store.includes('recovered.system.paused = true') && source.store.includes('recovered.system.killSwitch = true'), 'backup recovery no longer pauses entries');
  for (const row of ['error', 'error-persist-failed', 'cycle-budget']) {
    mentions(runbook, row);
    assert.ok(source.recovery.includes(`'${row}'`), `journal row type ${row} is no longer written`);
  }
  assert.ok(source.engine.includes('process.exitCode = 1'), 'the fatal exit code the runbook documents is gone');
  assert.ok(source.engine.includes('SIGINT') && source.engine.includes('SIGTERM'));
  assert.ok(source.engine.includes('MONEY_PRINTER_SUPERVISED'));
  assert.ok(source.engine.includes("'--once'") && runbook.includes('--once'));
});

test('the documented defaults are the defaults in config.js', () => {
  const documented = [['MODE', 'paper'], ['ENABLE_LIVE_TRADING', 'false'], ['SCAN_INTERVAL_SEC', '8'], ['MARKET_REQUESTS_PER_MINUTE', '120'], ['CYCLE_BUDGET_MS', '45000'], ['CYCLE_ERROR_DEGRADE_AFTER', '3']];
  for (const [key, value] of documented) {
    mentions(runbook, key);
    mentions(runbook, value);
    const pattern = new RegExp("num\\('" + key + "'," + value + "\\)|bool\\('" + key + "'," + value + "\\)|str\\('" + key + "','" + value + "'\\)");
    assert.ok(pattern.test(source.config), `config.js no longer defaults ${key} to ${value}`);
  }
  // The data directory is resolved in store.js rather than config.js.
  mentions(runbook, 'MONEY_PRINTER_DATA_DIR');
  assert.ok(source.store.includes("process.env.MONEY_PRINTER_DATA_DIR || 'data'"));
  // And the port the runbook's curl lines use.
  assert.ok(runbook.includes('8792') && source.config.includes("num('DASHBOARD_PORT',8792)"));
});
