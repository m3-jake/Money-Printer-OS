// How complete is the research data? Every Lab result is only as good as the tape under it, and a
// quiet collector looks exactly like a quiet market. This scans the last N days of each tape source
// and reports rows per day, the last row's age and the largest hole, so gaps are visible in the HUD.
// Read-only; reads at most the tail of each file; the result is cached.
import fs from 'node:fs';
import path from 'node:path';

const DAY = 864e5, TAIL_BYTES = 64 * 1024 * 1024, CACHE_MS = 5 * 60_000;
const TS_RE = /"(?:ts|t)":(\d{12,13})/;
let cache = { at: 0, key: '', value: null };

function tailLines(file) {
  const st = fs.statSync(file), len = Math.min(st.size, TAIL_BYTES), fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len);
    const text = buf.toString('utf8');
    return (len < st.size ? text.slice(text.indexOf('\n') + 1) : text).split('\n');
  } finally { fs.closeSync(fd); }
}

function scan(files, since) {
  const ts = [];
  for (const f of files) {
    let lines; try { lines = tailLines(f); } catch { continue; }
    for (const l of lines) { const m = TS_RE.exec(l); if (m) { const t = Number(m[1]); if (t >= since) ts.push(t); } }
  }
  return ts.sort((a, b) => a - b);
}

export function sourceCoverage(name, files, { now = Date.now(), days = 7, liveMs = 5 * 60_000, staleMs = 60 * 60_000 } = {}) {
  const since = now - days * DAY, ts = scan(files, since), perDay = [];
  for (let d = days - 1; d >= 0; d--) {
    const start = new Date(now - d * DAY).toISOString().slice(0, 10), lo = Date.parse(start), hi = lo + DAY;
    perDay.push({ day: start, rows: ts.filter(t => t >= lo && t < hi).length });
  }
  let maxGapMs = 0, gapAt = null;
  for (let i = 1; i < ts.length; i++) { const g = ts[i] - ts[i - 1]; if (g > maxGapMs) { maxGapMs = g; gapAt = ts[i - 1]; } }
  const lastAt = ts.length ? ts[ts.length - 1] : null, ageMs = lastAt ? now - lastAt : null;
  if (ageMs != null && ageMs > maxGapMs) { maxGapMs = ageMs; gapAt = lastAt; }
  const status = ageMs == null ? 'NO_DATA' : ageMs <= liveMs ? 'LIVE' : ageMs <= staleMs ? 'STALE' : 'DOWN';
  return { source: name, files: files.length, rows: ts.length, perDay, lastAt, ageMs, maxGapMs, gapAt, status };
}

const list = (dir, re) => { try { return fs.readdirSync(dir).filter(f => re.test(f)).map(f => path.join(dir, f)); } catch { return []; } };

export function dataCoverage(dataDir, { now = Date.now(), days = 7, force = false } = {}) {
  const key = `${dataDir}:${days}`;
  if (!force && cache.value && cache.key === key && now - cache.at < CACHE_MS) return cache.value;
  const raw = path.join(dataDir, 'research-evidence', 'raw'), rh = path.join(dataDir, 'robinhood-tape');
  const recent = f => { const m = /(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(f); return !m || Date.parse(m[1]) >= now - (days + 1) * DAY; };
  const sources = [
    sourceCoverage('Solana path ticks', list(raw, /^solana-path-.*\.ndjson$/).filter(recent), { now, days }),
    sourceCoverage('Polymarket depth', list(raw, /^polymarket-depth-.*\.ndjson$/).filter(recent), { now, days }),
    ...list(rh, /\.ndjson$/).map(f => sourceCoverage(`Robinhood ${path.basename(f, '.ndjson')}`, [f], { now, days, liveMs: 2 * 60_000 })),
  ];
  const value = { schema: 'mpo.data-coverage.v1', at: now, days, sources };
  cache = { at: now, key, value };
  return value;
}
