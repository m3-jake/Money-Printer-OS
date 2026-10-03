#!/usr/bin/env node
// Source preview for the HUD: serves public/ from this checkout, runs read-only HUD routes from source
// against the real data directory, and forwards every other GET /api request to the running trader.
// Mutations are refused, so a preview can never change books, profiles or settings.
//   node scripts/hud-preview-server.mjs [port] [traderOrigin]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dispatchHudRoute } from '../src/hudRoutes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8860);
const TRADER = process.argv[3] || 'http://127.0.0.1:8792';
const DATA_DIR = process.env.MONEY_PRINTER_DATA_DIR || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Money Printer OS', 'data');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.json': 'application/json' };
const json = (res, body, status = 200, headers = {}) => { const s = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(s); };

function serveFile(res, file) {
  const base = path.join(ROOT, 'public');
  const full = path.resolve(base, file);
  if (!full.startsWith(path.resolve(base) + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(full).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, { ok: false, error: 'Preview is read-only' }, 403);
      if (await dispatchHudRoute(req, res, u, { dataDir: DATA_DIR, json, readOnly: true })) return;
      const upstream = await fetch(TRADER + u.pathname + u.search, { headers: { 'if-none-match': req.headers['if-none-match'] || '' }, signal: AbortSignal.timeout(30000) });
      const headers = {}; for (const k of ['content-type', 'etag', 'cache-control']) { const v = upstream.headers.get(k); if (v) headers[k] = v; }
      res.writeHead(upstream.status, headers);
      return res.end(Buffer.from(await upstream.arrayBuffer()));
    }
    if (u.pathname === '/') return serveFile(res, 'dashboard.html');
    return serveFile(res, decodeURIComponent(u.pathname.slice(1)));
  } catch (e) { json(res, { ok: false, error: String(e?.message || e) }, 502); }
}).listen(PORT, '127.0.0.1', () => console.log(`HUD preview http://127.0.0.1:${PORT} (data ${DATA_DIR}, trader ${TRADER})`));
