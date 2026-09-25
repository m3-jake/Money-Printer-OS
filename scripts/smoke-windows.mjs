#!/usr/bin/env node
// Money Printer OS — Windows boot test of a built app.asar.
//
//   npm run smoke:windows -- --asar <path\to\app.asar> [--exe <Money Printer OS.exe>] [--port 8792]
//
// The Windows twin of macSmoke() in scripts/build-unified.mjs: the installed Electron runtime
// (default %LOCALAPPDATA%\Programs\money-printer-os\Money Printer OS.exe) runs as Node
// (ELECTRON_RUN_AS_NODE=1) with the archive's src/index.js in --dashboard-only paper mode, against
// a throwaway data dir, with every AppData variable pointed away from the real install. The test
// passes when the dashboard answers 200; /api/health is recorded too. The process is stopped and
// the data dir deleted whatever happens. Nothing is installed and the real install is not touched.
// Result: WINDOWS-ENGINE-SMOKE.json and windows-engine-smoke.log next to the archive.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const die = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (process.platform !== 'win32') die('this is the Windows smoke test');
const ASAR = path.resolve(opt('--asar', '') || die('--asar <file> is required'));
const EXE = path.resolve(opt('--exe', path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'money-printer-os', 'Money Printer OS.exe')));
const PORT = Number(opt('--port', '8792'));
if (!fs.existsSync(ASAR)) die(`no such archive: ${ASAR}`);
if (!fs.existsSync(EXE)) die(`no Electron runtime at ${EXE} (pass --exe)`);

const httpStatus = (url) => new Promise((r) => { const q = http.get(url, (res) => { res.resume(); r(res.statusCode); }); q.on('error', () => r(0)); q.setTimeout(3000, () => { q.destroy(); r(0); }); });
const httpBody = (url) => new Promise((r) => { const q = http.get(url, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => r({ status: res.statusCode, body: b })); }); q.on('error', () => r({ status: 0, body: '' })); q.setTimeout(3000, () => { q.destroy(); r({ status: 0, body: '' }); }); });

if (await httpStatus(`http://127.0.0.1:${PORT}/`)) die(`port ${PORT} already in use; refusing to smoke-test against another process`);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-smoke-data-'));
const OUT = path.dirname(ASAR);
const logFile = path.join(OUT, 'windows-engine-smoke.log');
const logFd = fs.openSync(logFile, 'w');
const env = {
  PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: os.tmpdir(), TMP: os.tmpdir(),
  USERPROFILE: dataDir, APPDATA: dataDir, LOCALAPPDATA: dataDir, HOME: dataDir,
  ELECTRON_RUN_AS_NODE: '1', MODE: 'paper', DOCTOR_OFFLINE: '1',
  ALPHA_WORKER_ENABLED: 'false', DIRECT_STREAM_ENABLED: 'false', OPEN_DASHBOARD: 'false',
  DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: String(PORT), MONEY_PRINTER_DATA_DIR: dataDir,
};
const child = spawn(EXE, [path.join(ASAR, 'src', 'index.js'), '--dashboard-only'], { cwd: dataDir, env, stdio: ['ignore', logFd, logFd] });
let status = 0, health = { status: 0, body: '' };
for (let i = 0; i < 60 && !status; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  if (child.exitCode !== null) break;
  status = await httpStatus(`http://127.0.0.1:${PORT}/`);
}
if (status) health = await httpBody(`http://127.0.0.1:${PORT}/api/health`);
const pid = child.pid;
child.kill();
await new Promise((r) => { const t = setTimeout(() => { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); r(); }, 5000); child.once('exit', () => { clearTimeout(t); r(); }); });
fs.closeSync(logFd);
await new Promise((r) => setTimeout(r, 1000));
fs.rmSync(dataDir, { recursive: true, force: true });
let healthJson = null; try { healthJson = JSON.parse(health.body); } catch { /* not JSON */ }
const result = {
  ran: true, asar: ASAR, binary: 'installed Electron runtime (ELECTRON_RUN_AS_NODE=1)', exe: EXE, mode: 'paper', dashboardOnly: true,
  port: PORT, pid, dashboardStatus: status, healthStatus: health.status, healthOk: healthJson ? healthJson.ok === true : null, health: healthJson ? healthJson.health : null,
  isolatedDataDir: 'temp dir (deleted)', success: status === 200 && health.status === 200 && healthJson?.ok === true, log: logFile, at: new Date().toISOString(),
};
fs.writeFileSync(path.join(OUT, 'WINDOWS-ENGINE-SMOKE.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
process.exit(result.success ? 0 : 1);
