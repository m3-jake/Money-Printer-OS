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
export function startProgramStream(onEvent=()=>{}){if(!cfg.directStreamEnabled||!cfg.programLogIds.length)return{enabled:false};const url=cfg.rpcUrl.replace(/^http/,'ws');const connect=()=>{ws=new WebSocket(url);ws.on('open',()=>cfg.programLogIds.forEach((id,i)=>ws.send(JSON.stringify({jsonrpc:'2.0',id:i+1,method:'logsSubscribe',params:[{mentions:[id]},{commitment:'processed'}]}))));ws.on('message',buf=>{try{const j=JSON.parse(buf);if(j.method==='logsNotification'){const logs=j.params?.result?.value?.logs||[];addHints(logs);const now=Date.now();const e={type:'program-log',programHints:cfg.programLogIds,signature:j.params?.result?.value?.signature,logs,ts:now};if(now-lastJournalAt>=250){e.suppressedSinceLast=suppressed;suppressed=0;lastJournalAt=now;appendJournal(e)}else suppressed++;onEvent(e)}}catch{}});ws.on('close',()=>{clearTimeout(retry);retry=setTimeout(connect,2500)});ws.on('error',()=>{})};connect();return{enabled:true,close:()=>{clearTimeout(retry);ws?.close()}};}
