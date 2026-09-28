import WebSocket from 'ws';
import {cfg} from './config.js';
import {appendJournal} from './store.js';
let ws=null,retry=null,lastJournalAt=0,suppressed=0;
const hints=new Map();
const BASE58=/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
function addHints(logs=[]){
  const now=Date.now();
  for(const lineRaw of logs){
    const line=String(lineRaw),context=/mint|token|initialize|pool|curve/i.test(line);
    for(const address of line.match(BASE58)||[]){
      if(cfg.programLogIds.includes(address))continue;
      const h=hints.get(address)||{ts:0,count:0,contextHits:0};
      h.ts=now;h.count++;if(context)h.contextHits++;hints.set(address,h);
    }
  }
  for(const [k,h] of hints)if(now-h.ts>10*60_000)hints.delete(k);
  if(hints.size>1200){const xs=[...hints.entries()].sort((a,b)=>b[1].ts-a[1].ts).slice(0,800);hints.clear();for(const [k,v] of xs)hints.set(k,v);}
}
export function programStreamHints(limit=300){const now=Date.now();return [...hints.entries()].filter(([,h])=>now-h.ts<10*60_000&&(h.contextHits>0||h.count>=2)).sort((a,b)=>(b[1].contextHits-a[1].contextHits)||(b[1].count-a[1].count)||(b[1].ts-a[1].ts)).slice(0,limit).map(([tokenAddress,h])=>({tokenAddress,source:'solana:program-log',streamTs:h.ts,streamHits:h.count}));}
export function startProgramStream(onEvent = () => {}, { enabled = cfg.directStreamEnabled, programIds = cfg.programLogIds } = {}) {
  const ids = [...new Set(programIds)], active = () => typeof enabled === 'function' ? Boolean(enabled()) : Boolean(enabled);
  if ((!active() && typeof enabled !== 'function') || !ids.length) return { enabled: false };
  const url = cfg.rpcUrl.replace(/^http/, 'ws'), subscriptions = new Map(); let stopped = false;
  const reconnect = () => { if (!stopped) { clearTimeout(retry); retry = setTimeout(connect, 2500); retry.unref?.(); } };
  const connect = () => {
    if (stopped) return;
    if (!active()) { reconnect(); return; }
    subscriptions.clear(); ws = new WebSocket(url);
    ws.on('open', () => ids.forEach((id, i) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe', params: [{ mentions: [id] }, { commitment: 'processed' }] }))));
    ws.on('message', buf => {
      try {
        const j = JSON.parse(buf);
        if (j.id && j.result != null && ids[j.id - 1]) { subscriptions.set(j.result, ids[j.id - 1]); return; }
        if (j.method !== 'logsNotification' || !active()) return;
        const result = j.params?.result || {}; if (result.value?.err) return;
        const logs = result.value?.logs || [], program = subscriptions.get(j.params?.subscription), now = Date.now();
        addHints(logs);
        const e = { type: 'program-log', programHints: program ? [program] : [], signature: result.value?.signature, slot: result.context?.slot, logs, ts: now };
        if (now - lastJournalAt >= 250) { e.suppressedSinceLast = suppressed; suppressed = 0; lastJournalAt = now; appendJournal(e); } else suppressed++;
        onEvent(e);
      } catch { /* Malformed notifications never become launch events. */ }
    });
    ws.on('close', reconnect); ws.on('error', () => {});
  };
  connect();
  return { enabled: true, close: () => { stopped = true; clearTimeout(retry); ws?.close(); } };
}
