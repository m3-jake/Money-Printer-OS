// Offline, read-only A2 diagnosis. No credentials, downloads or changes to books.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { KALSHI_DEFAULTS, modelGuard } from '../src/kalshiBots.js';
const data = process.argv[2] || path.join(process.env.APPDATA, 'Money Printer OS', 'data');
const lab = process.argv[3] || path.resolve('../money-printer-evolution-lab');
const { btcEpisodes, replayBtc } = await import(pathToFileURL(path.join(lab, 'src/btcReplay.js')));
function tape(stream) {
  const dir = path.join(data, 'bot-tape', stream);
  return fs.readdirSync(dir).filter(f => /\.jsonl(\.gz)?$/.test(f)).sort().flatMap(f => {
    const b = fs.readFileSync(path.join(dir, f));
    return (f.endsWith('.gz') ? zlib.gunzipSync(b) : b).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  });
}
const frames = tape('kalshi-btc').sort((a,b) => a.at-b.at), results = {};
for (const r of tape('kalshi-settle')) if (['YES','NO'].includes(r.outcome)) results[r.ticker] = r.outcome.toLowerCase();
const episodes = btcEpisodes(frames, results), old = { ...KALSHI_DEFAULTS.btc, volMultiple: 1.25, longshotPrice: 0, longshotMinEdge: 0 };
const summarize = v => {
  const r = replayBtc(episodes, results, v);
  return { settings: v, n: r.n, pnlUsd: r.pnl, meanUsd: r.mean, below15c: r.bets.filter(b=>b.price<0.15).length,
    below15cPnlUsd: r.bets.filter(b=>b.price<0.15).reduce((s,b)=>s+b.pnl,0), missingNextQuote:r.missingNextQuote };
};
const horizons = [0.5, 1, 2, 6].map(h => {
  const zs = [];
  for (const f of frames) {
    const next = frames.find(g=>g.at>=f.at+h*3600e3);
    if (!next || next.at-f.at-h*3600e3>120e3 || !(f.volNow>0)) continue;
    zs.push(Math.log(next.spot/f.spot)/(f.volNow*Math.sqrt(h*3600)));
  }
  const mean = zs.length ? zs.reduce((s,z)=>s+z,0)/zs.length : null;
  return { hours:h, overlappingSamples:zs.length, meanZ:mean, sdZ:zs.length>1 ? Math.sqrt(zs.reduce((s,z)=>s+(z-mean)**2,0)/(zs.length-1)):null };
});
const book = JSON.parse(fs.readFileSync(path.join(data,'kalshi-paper-bots.json'),'utf8')).bots.btc;
console.log(JSON.stringify({at:new Date().toISOString(), frames:frames.length, settledEvents:episodes.length, horizons,
  previous:summarize(old), proposed:summarize(KALSHI_DEFAULTS.btc), forwardGuard:modelGuard(book.history),
  limitations:['Overlapping horizon samples are diagnostic, not independent trials.','Replay uses modeled next-frame top-of-book fills; no execution qualification.','Small settled-event corpus cannot prove profitability.']},null,2));
