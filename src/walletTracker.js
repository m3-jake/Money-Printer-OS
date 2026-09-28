import { isWalletAddress } from './walletScorecard.js';
import WebSocket from 'ws';
import { cfg } from './config.js';

export const smartWallets = (raw = process.env.SMART_WALLETS || '') => [...new Set(String(raw).split(',').map(x => x.trim()).filter(isWalletAddress))];

const recentCopySignals=new Map();
export function copySignalForMint(mint,now=Date.now()){const x=recentCopySignals.get(String(mint));if(!x||now-x.ts>120_000){recentCopySignals.delete(String(mint));return null}return {...x}}
export function rememberCopySignal(signal){if(signal?.mint&&signal?.source?.startsWith('copy:'))recentCopySignals.set(String(signal.mint),signal);return signal}

export function parseTrackedPumpBuy(tx,wallet,{signature='',ts=Date.now()}={}){
  if(!tx||tx.meta?.err)return[];
  const keys=tx.transaction?.message?.accountKeys||[],signed=keys.some(k=>(typeof k==='string'?k:k.pubkey?.toString?.())===wallet&&(typeof k==='string'||k.signer));
  if(!signed)return[];
  const ids=[];for(const ix of tx.transaction?.message?.instructions||[])ids.push(String(ix.programId?.toString?.()||ix.programId||''));
  for(const group of tx.meta?.innerInstructions||[])for(const ix of group.instructions||[])ids.push(String(ix.programId?.toString?.()||ix.programId||''));
  if(!ids.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))return[];
  const before=new Map(),after=new Map();
  for(const row of tx.meta?.preTokenBalances||[])if(row.owner===wallet)before.set(row.mint,Number(row.uiTokenAmount?.uiAmountString??row.uiTokenAmount?.uiAmount??0));
  for(const row of tx.meta?.postTokenBalances||[])if(row.owner===wallet)after.set(row.mint,Number(row.uiTokenAmount?.uiAmountString??row.uiTokenAmount?.uiAmount??0));
  const sig=signature||tx.transaction?.signatures?.[0]||'';
  return [...new Set([...before.keys(),...after.keys()])].map(mint=>({mint,delta:(after.get(mint)||0)-(before.get(mint)||0)})).filter(x=>x.delta>0&&x.mint!=='So11111111111111111111111111111111111111112')
   .map(x=>({ts:Number(tx.blockTime||0)*1000||ts,mint:x.mint,wallet,side:'BUY',signer:true,signature:sig,raw:{program:'pump'}}));
}

// Stream tracked wallet logs and fetch only their confirmed transactions. Connections and
// subscriptions are bounded; callbacks receive decoded buy events and no transaction is sent.
export function startTrackedWalletStream(onBuy=()=>{},{wallets=smartWallets(),url=cfg.rpcUrl,WebSocketImpl=WebSocket,fetcher=globalThis.fetch,now=Date.now,maxPerMinute=30,reconnectMs=2500}={}){
 const tracked=[...new Set(wallets)].filter(isWalletAddress);if(!tracked.length)return{enabled:false,close(){}};
 let socket=null,retry=null,closed=false,id=0,used=0,windowAt=now();const subscriptions=new Map(),requests=new Map(),seen=new Set(),wsUrl=String(url).replace(/^http/,'ws');
 const connect=()=>{if(closed)return;socket=new WebSocketImpl(wsUrl);socket.on('open',()=>tracked.forEach(wallet=>{const requestId=++id;requests.set(requestId,wallet);socket.send(JSON.stringify({jsonrpc:'2.0',id:requestId,method:'logsSubscribe',params:[{mentions:[wallet]},{commitment:'confirmed'}]}));}));
  socket.on('message',async buf=>{try{const msg=JSON.parse(String(buf));if(msg.id&&msg.result!=null){const wallet=requests.get(Number(msg.id));if(wallet)subscriptions.set(Number(msg.result),wallet);requests.delete(Number(msg.id));return}if(msg.method!=='logsNotification')return;const value=msg.params?.result?.value||{},wallet=subscriptions.get(Number(msg.params?.subscription)),signature=value.signature;if(!wallet||!signature||value.err)return;
   const t=now();if(t-windowAt>=60_000){windowAt=t;used=0}if(used>=maxPerMinute)return;used++;
   const key=`${wallet}:${signature}`;if(seen.has(key))return;seen.add(key);if(seen.size>5000)seen.clear();
   const response=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10000),body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'getTransaction',params:[signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed'}]})});
   if(!response.ok)return;const tx=(await response.json()).result;for(const event of parseTrackedPumpBuy(tx,wallet,{signature,ts:t}))onBuy(event);
  }catch{}});socket.on('close',()=>{subscriptions.clear();requests.clear();if(!closed)retry=setTimeout(connect,reconnectMs)});socket.on('error',()=>{});
 };
 connect();return{enabled:true,wallets:tracked.length,close(){closed=true;clearTimeout(retry);try{socket?.close()}catch{}}};
}

export function copyWalletSignals(events = [], { wallets = smartWallets(), minScore = 0 } = {}) {
  const tracked = new Set(wallets), out = [];
  for (const event of events) {
    if (!tracked.has(String(event?.wallet || '')) || event?.side !== 'BUY' || event?.signer !== true) continue;
    if (String(event?.raw?.program || '').toLowerCase() !== 'pump') continue;
    const score = Number(event.walletScore ?? event.score ?? 0);
    if (score < minScore) continue;
    out.push({ ts: Number(event.ts || Date.now()), mint: String(event.mint || ''), wallet: String(event.wallet), source: `copy:${event.wallet}`,
      side: 'BUY', score, signature: event.signature || null, solDelta: Number(event.solDelta || 0) });
  }
  return out.filter(x => x.mint);
}

export function rankCopyWallets(scorecard = [], { asOf = Date.now(), trailingDays = 30, minTrips = 3, demoteBelowSol = 0 } = {}) {
  const cutoff = asOf - trailingDays * 86_400_000;
  return scorecard.map(wallet => {
    const fresh = Number(wallet.lastTs || 0) >= cutoff;
    const qualified = fresh && Number(wallet.roundTrips || 0) >= minTrips;
    const pnl = Number(wallet.realizedPnlSol || 0);
    return { ...wallet, trailing30dPnlSol: pnl, qualified, autoDemoted: qualified && pnl < demoteBelowSol, eligible: qualified && pnl >= demoteBelowSol };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.trailing30dPnlSol - a.trailing30dPnlSol);
}
