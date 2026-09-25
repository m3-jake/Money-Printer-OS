// Public market-data fallback used ONLY by the Robinhood simulated paper engine.
// Robinhood's own best-bid/ask API requires authenticated headers, so a rejected/missing
// Robinhood credential must not stall paper research. No account or order endpoints exist here.
const BASE='https://api.exchange.coinbase.com';
const SYMBOL_RE=/^[A-Z0-9]{2,10}-USD$/;

const finite=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const cleanSymbol=s=>{const v=String(s||'').trim().toUpperCase();if(!SYMBOL_RE.test(v))throw Error('invalid paper-feed symbol');return v};
async function json(path,{fetchFn=globalThis.fetch,timeoutMs=5000}={}){
 const signal=typeof AbortSignal?.timeout==='function'?AbortSignal.timeout(timeoutMs):undefined;
 const r=await fetchFn(BASE+path,{method:'GET',headers:{accept:'application/json','user-agent':'MoneyPrinterOS/0.5 paper-feed'},signal});
 if(!r?.ok)throw Error('public paper feed HTTP '+(r?.status??'unknown'));
 return typeof r.json==='function'?r.json():JSON.parse(await r.text());
}
export async function fetchPublicPaperQuote(symbol,{fetchFn=globalThis.fetch,now=Date.now}={}){
 const s=cleanSymbol(symbol),body=await json('/products/'+encodeURIComponent(s)+'/book?level=1',{fetchFn});
 const bid=finite(body?.bids?.[0]?.[0]),ask=finite(body?.asks?.[0]?.[0]);if(!(bid>0)||!(ask>=bid))throw Error('public paper feed returned an invalid book');
 const parsed=Date.parse(body?.time);const t=Number.isFinite(parsed)?Math.min(parsed,now()):now();
 return {symbol:s,bid,ask,at:t,source:'coinbase-public-paper'};
}
export async function fetchPublicPaperPair(symbol,{fetchFn=globalThis.fetch}={}){
 const s=cleanSymbol(symbol),body=await json('/products/'+encodeURIComponent(s),{fetchFn});
 const online=String(body?.status||'').toLowerCase()==='online'&&body?.trading_disabled!==true;
 return {symbol:s,assetCode:s.split('-')[0],assetIncrement:String(body?.base_increment||'0.00000001'),quoteIncrement:String(body?.quote_increment||'0.01'),maxOrderSize:null,minOrderAmountUsd:1,status:String(body?.status||''),isApiTradable:online};
}
export async function fetchPublicPaperMarket(symbols,{fetchFn=globalThis.fetch,now=Date.now,needPairs=true}={}){
 const list=[...new Set((symbols||[]).map(cleanSymbol))];
 const quotes=await Promise.all(list.map(s=>fetchPublicPaperQuote(s,{fetchFn,now})));
 const pairs=needPairs?await Promise.all(list.map(s=>fetchPublicPaperPair(s,{fetchFn}))):[];
 return {source:'coinbase-public-paper',quotes,pairs};
}
