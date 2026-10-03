// Records the HUD's GET /api/* responses from a sandboxed PAPER engine so the browser-only web demo can replay them.
//
//   node scripts/web-demo/record.mjs [--minutes 30] [--sandbox <dir>] [--lab <lab-link dir> | --no-lab]
//
// The engine runs from a fresh temp directory with a scrubbed environment: no .env, no API keys, no
// user AppData, MODE=paper, starting at the default 1 SOL, so the demo opens on a brand-new session.
// The Evolution Lab's published champion and module files are copied in from the trader's lab-link
// folder (default: %APPDATA%/Money Printer OS/data/lab-link) and refreshed every 30 s, so the session
// runs against the current champion exactly as the desktop trader would. Open http://127.0.0.1:18793/ and click through every window; each GET is
// written to web-demo/fixtures.json (latest response wins). The endpoints the HUD polls constantly also
// keep a timeline of frames, at least FRAME_GAP_MS apart, so the demo replays a moving session; the recorder
// polls those itself, so the timeline grows even when no browser is open. Every other endpoint a previous
// recording captured (the catalog) is fetched directly 2 and 6 minutes in, so all panels come from the start
// of the session without clicking through the HUD; browsing via the proxy adds anything new.
// A new sandbox starts fixtures.json over; --sandbox reuses an earlier run's directory and keeps adding to
// it, so the paper book carries on. Ctrl+C or the timer stops both servers.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'web-demo', 'fixtures.json');
// Every endpoint any recording has seen (browsed or fetched); it only grows, so a run with no browser still
// fetches every panel's data instead of only what the previous fixtures happened to hold.
const CATALOG = path.join(ROOT, 'web-demo', 'catalog.json');
// WEB_DEMO_ENGINE_PORT / WEB_DEMO_PROXY_PORT let a second recording run beside another one.
const ENGINE_PORT = Number(process.env.WEB_DEMO_ENGINE_PORT) || 18792, PROXY_PORT = Number(process.env.WEB_DEMO_PROXY_PORT) || 18793;
const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const minutes = Number(arg('--minutes')) || 30;
// Everything that shows the session's progress is on the timeline, so balance, trades and scores agree.
const FRAMED = new Set(['/api/state', '/api/telemetry', '/api/robinhood', '/api/scoreboard', '/api/platform/status',
  '/api/journal?limit=180', '/api/paper-qualification', '/api/robinhood-equities', '/api/polymarket-us/combos/journal', '/api/bots']);
const FRAME_GAP_MS = 20_000, MAX_FRAMES = 90; // 30 minutes; frames past that are not kept, so the start is never lost

const resume = !!arg('--sandbox');
const sandbox = resume ? path.resolve(arg('--sandbox')) : fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-web-demo-'));
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });

const LAB = process.argv.includes('--no-lab') ? null : path.resolve(arg('--lab') || path.join(process.env.APPDATA || os.homedir(), 'Money Printer OS', 'data', 'lab-link'));
const LAB_OUT = path.join(sandbox, 'data', 'lab-link');
const TRADER_WRITES = new Set(['dataset.json', 'trader-status.json', 'fitness']);
const LAB_REFRESH = name => name === 'status.json' || name.endsWith('champion.json') || name === 'modules';
function copyLab(filter) {
  if (!LAB || !fs.existsSync(LAB)) return false;
  fs.mkdirSync(LAB_OUT, { recursive: true });
  for (const name of fs.readdirSync(LAB)) if (!TRADER_WRITES.has(name) && filter(name)) fs.cpSync(path.join(LAB, name), path.join(LAB_OUT, name), { recursive: true });
  return true;
}
const labSeeded = copyLab(() => true);
if (labSeeded) setInterval(() => { try { copyLab(LAB_REFRESH); } catch {} }, 30_000).unref();
const champion = labSeeded ? (() => { try { return JSON.parse(fs.readFileSync(path.join(LAB_OUT, 'champion.json'), 'utf8')); } catch { return null; } })() : null;
console.log(labSeeded ? `Lab champion: ${champion?.champion?.id || 'none'} (generation ${champion?.generation ?? '?'}, ${champion?.champion?.stage || 'unknown stage'})` : 'No Lab link copied; the session runs without a champion.');
const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'WINDIR', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
const env = Object.fromEntries(keep.filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, {
  MODE: 'paper', ENABLE_LIVE_TRADING: 'false', OPEN_DASHBOARD: 'false', ALPHA_WORKER_ENABLED: 'false',
  DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: String(ENGINE_PORT),
  MONEY_PRINTER_DATA_DIR: path.join(sandbox, 'data'),
  HOME: sandbox, USERPROFILE: sandbox, APPDATA: sandbox, LOCALAPPDATA: sandbox, TEMP: sandbox, TMP: sandbox,
});

const previous = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { responses: {} };
// Endpoints newer than the previous recording (alpha.79: Kalshi weather glance) are always fetched once.
const known = fs.existsSync(CATALOG) ? JSON.parse(fs.readFileSync(CATALOG, 'utf8')) : [];
const catalog = [...new Set([...known, ...Object.keys(previous.responses), '/api/platform/weather'])].filter(k => !FRAMED.has(k));
const fixtures = resume && fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { recordedAt: null, responses: {}, frames: {} };
fixtures.frames ||= {};
fixtures.champion = champion ? { id: champion.champion?.id, generation: champion.generation, stage: champion.champion?.stage } : null;
const save = () => { fixtures.recordedAt = new Date().toISOString(); fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(fixtures, null, 1)); };

const engine = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], { cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'] });
engine.stdout.on('data', d => process.stdout.write('[engine] ' + d));
engine.stderr.on('data', d => process.stderr.write('[engine] ' + d));

function record(url, status, body) {
  const u = new URL(url, 'http://x'), at = Date.now();
  const key = u.pathname + u.search;
  fixtures.responses[key] = { status, at, body };
  if (FRAMED.has(key) && status === 200) {
    const frames = (fixtures.frames[key] ||= []);
    if (frames.length < MAX_FRAMES && (opening || !frames.length || at - frames.at(-1).at >= FRAME_GAP_MS)) frames.push({ at, body });
  }
  save();
}
const pollFrames = () => { for (const p of FRAMED) fetch(`http://127.0.0.1:${ENGINE_PORT}${p}`).then(async r => /json/.test(r.headers.get('content-type') || '') && record(p, r.status, await r.json())).catch(() => {}); };
// Until the engine has priced its book (its first cycle, which also opens the first trades), every
// one-second poll is a frame, so the session opens on the untouched 1 SOL book and its first cycle.
let opening = true;
const priced = () => fixtures.frames['/api/state']?.some(f => Number.isFinite(f.body?.portfolio?.equitySol));
const openingTimer = setInterval(() => { if (priced()) { opening = false; clearInterval(openingTimer); setInterval(pollFrames, FRAME_GAP_MS).unref(); } else pollFrames(); }, 1000);
const fetchCatalog = () => { for (const k of catalog) fetch(`http://127.0.0.1:${ENGINE_PORT}${k}`, { signal: AbortSignal.timeout(30_000) }).then(async r => /json/.test(r.headers.get('content-type') || '') && record(k, r.status, await r.json())).catch(() => {}); };
for (const min of [2, 6]) setTimeout(fetchCatalog, min * 60_000).unref();

const proxy = http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: ENGINE_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${ENGINE_PORT}`, 'if-none-match': '' } }, upRes => {
    const chunks = [];
    upRes.on('data', c => chunks.push(c));
    upRes.on('end', () => {
      const buf = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://x');
      if (req.method === 'GET' && u.pathname.startsWith('/api/') && /json/.test(upRes.headers['content-type'] || '')) {
        try { record(req.url, upRes.statusCode, JSON.parse(buf.toString('utf8'))); } catch {}
      }
      res.writeHead(upRes.statusCode, upRes.headers);
      res.end(buf);
    });
  });
  up.on('error', e => { res.writeHead(502); res.end(String(e.message)); });
  req.pipe(up);
});
proxy.listen(PROXY_PORT, '127.0.0.1', () => console.log(`Recording proxy: http://127.0.0.1:${PROXY_PORT}/  (sandbox ${sandbox}, stops in ${minutes} min)`));

const saveCatalog = () => fs.writeFileSync(CATALOG, JSON.stringify([...new Set([...catalog, ...Object.keys(fixtures.responses)])].filter(k => !FRAMED.has(k) && !k.startsWith('/api/project-journal')).sort(), null, 1) + '\n');
const stop = () => { save(); saveCatalog(); proxy.close(); engine.kill(); console.log(`Saved ${Object.keys(fixtures.responses).length} responses to ${path.relative(ROOT, OUT)} (catalog ${catalog.length} before this run)`); setTimeout(() => process.exit(0), 500); };
process.on('SIGINT', stop);
setTimeout(stop, minutes * 60_000);
