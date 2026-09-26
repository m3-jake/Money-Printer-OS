// Robinhood paper warm start (docs/ROBINHOOD-AUTO-TRADER.md §23). Pure: no fs, network or clock.
// On boot the in-memory tape is refilled from the durable tape, and any hole left (a restart gap, or a
// short tape) is filled from public 1-minute candles expanded onto the 15 s sample grid. Candle rows
// are tagged src 'coinbase-candles' so every later reader can tell them from live quotes.
export const CANDLE_SRC='coinbase-candles';

// One 1-minute candle becomes four samples on the sample grid: open, then the extreme the bar
// visited first (low for an up bar, high for a down bar), then the other extreme, then close.
// A candle has no book, so bid = ask = price; the live quote supplies the spread.
export function candlesToSamples(candles,sampleMs=15000){
 const out=[],per=Math.max(1,Math.round(60000/sampleMs));
 for(const c of Array.isArray(candles)?candles:[]){
  const path=c.close>=c.open?[c.open,c.low,c.high,c.close]:[c.open,c.high,c.low,c.close];
  for(let i=0;i<per;i++){const px=path[Math.min(path.length-1,Math.round(i*(path.length-1)/Math.max(1,per-1)))];out.push({t:c.t+i*sampleMs,bid:px,ask:px,src:CANDLE_SRC})}
 }
 return out.sort((a,b)=>a.t-b.t);
}

// Holes longer than 2 x sampleMs inside [from, to], as [start, end] pairs.
export function findGaps(rows,{from,to,sampleMs=15000}={}){
 const ts=(rows||[]).map(r=>r.t).filter(t=>t>=from&&t<=to).sort((a,b)=>a-b),gaps=[];let prev=from;
 for(const t of ts){if(t-prev>2*sampleMs)gaps.push([prev,t]);prev=t}
 if(to-prev>2*sampleMs)gaps.push([prev,to]);
 return gaps;
}

// Real rows win. A candle row is kept only when no real row lies within 0.75 x sampleMs of it, so
// the seam between real and candle rows stays under the 2 x sampleMs gap threshold.
export function mergeWarm(real,candleRows,{from=-Infinity,to=Infinity,sampleMs=15000}={}){
 const r=(real||[]).filter(x=>x.t>=from&&x.t<=to).sort((a,b)=>a.t-b.t),ts=r.map(x=>x.t),near=0.75*sampleMs;
 const hasNear=t=>{let lo=0,hi=ts.length;while(lo<hi){const m=(lo+hi)>>1;if(ts[m]<t)lo=m+1;else hi=m}return (lo<ts.length&&ts[lo]-t<near)||(lo>0&&t-ts[lo-1]<near)};
 const added=(candleRows||[]).filter(x=>x.t>=from&&x.t<=to&&!hasNear(x.t));
 const rows=r.concat(added).sort((a,b)=>a.t-b.t),dedup=[];
 for(const x of rows){if(dedup.length&&dedup[dedup.length-1].t===x.t)continue;dedup.push(x)}
 return {rows:dedup,added};
}
