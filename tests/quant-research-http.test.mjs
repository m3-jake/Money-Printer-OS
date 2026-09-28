import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

test('dashboard serves the research library and bounded read-only catalog', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-quant-http-'));
  process.env.DATA_DIR = dir; process.env.DASHBOARD_PORT = '0'; process.env.MODE = 'paper';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => String(url).startsWith('http://127.0.0.1:')
    ? originalFetch(url, init) : Promise.resolve(new Response('{}', { status: 503 }));
  const { startDashboard } = await import('../src/dashboard.js');
  const server = startDashboard();
  t.after(async () => { globalThis.fetch = originalFetch; await new Promise(resolve => server.close(resolve)); });
  // Leave the isolated fixture for this process's open SQLite handles; no installed data is used.
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base + '/quant-research');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Quant research library/);
  const response = await fetch(base + '/api/quant-research?q=momentum&source=specs&limit=2');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.entries.length, 2);
  assert.ok(data.entries.every(x => x.source === 'specs'));
  assert.equal(data.protocol.liveActivationAllowed, false);
  const rejected = await fetch(base + '/api/quant-research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.ok(rejected.status >= 400);
});
