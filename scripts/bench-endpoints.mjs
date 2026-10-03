#!/usr/bin/env node
// Read-only latency/payload benchmark for the running apps' GET endpoints.
//   node scripts/bench-endpoints.mjs [rounds=12] [out.json]
// Sequential requests (no load amplification); reports p50/p95 latency and payload bytes per endpoint.
import fs from 'node:fs';

const rounds = Number(process.argv[2] || 12), out = process.argv[3];
const TARGETS = [
  ['trader', 'http://127.0.0.1:8792', ['/api/health', '/api/state', '/api/telemetry', '/api/command-center', '/api/command-center?view=summary', '/api/scoreboard', '/api/bots', '/api/resources', '/api/market-history?ids=crypto:BTC-USD,crypto:ETH-USD,equity:SPY&points=300', '/api/market-groups', '/api/coordinator', '/api/copy-funnel']],
  ['lab', 'http://127.0.0.1:8793', ['/api/health', '/api/state']],
];
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

const results = [];
for (const [app, origin, paths] of TARGETS) for (const p of paths) {
  const times = [], sizes = []; let status = null, error = null;
  for (let i = 0; i < rounds; i++) {
    const t = performance.now();
    try { const r = await fetch(origin + p, { signal: AbortSignal.timeout(30000) }); const b = await r.arrayBuffer(); status = r.status; sizes.push(b.byteLength); }
    catch (e) { error = String(e.message || e); break; }
    times.push(performance.now() - t);
  }
  const row = { app, path: p, status, error, n: times.length, p50Ms: Math.round(pct(times, .5)), p95Ms: Math.round(pct(times, .95)), bytes: sizes.at(-1) ?? null };
  results.push(row);
  console.log(`${app.padEnd(6)} ${String(status ?? 'ERR').padEnd(4)} p50 ${String(row.p50Ms).padStart(5)} ms  p95 ${String(row.p95Ms).padStart(5)} ms  ${String(row.bytes ?? '-').padStart(9)} B  ${p}`);
}
if (out) fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), rounds, results }, null, 2));
