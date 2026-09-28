import fs from 'node:fs';
import path from 'node:path';
import { shadowFill, appendShadowRowOnce } from './shadowLive.js';
import { takerFee } from './core/fees.js';
import { walkBook } from './core/contracts.js';
import { polymarketUSSnapshot } from './polymarketUS.js';
import { fetchPublicPaperQuote } from './robinhoodPaperFeed.js';
import { createNativePaperAdapter } from './pumpfunNativePaper.js';
import { quoteExactInput, SOL_MINT } from './jupiterQuoteSampler.js';
import { sellFees } from './robinhoodEquitiesBook.js';

const positive=x=>x!=null&&Number.isFinite(Number(x))&&Number(x)>0;
const fresh=(at,now)=>Number.isFinite(Number(at))&&Number(at)<=now+1000&&now-Number(at)<=30000;
function read(dir,name){const file=path.join(dir,name);if(!fs.existsSync(file))return {};return JSON.parse(fs.readFileSync(file,'utf8'));}

// BBO observations are quote-only: unknown depth and actual account fees remain unknown.
export function recordUSSingleShadow(positions, snapshot, { file, now=Date.now(), latencyMs=0 }={}) {
  const markets=new Map((snapshot.opportunities||[]).map(m=>[String(m.slug||m.marketSlug||m.id),m]));
  return positions.map(p=>{
    const m=markets.get(p.marketId),no=String(p.outcome).toLowerCase()==='no';
    const rawAsk=m?.ask??m?.bestAsk?.value,rawBid=m?.bid??m?.bestBid?.value;
    const ask=rawAsk==null||rawBid==null?null:no?1-Number(rawBid):Number(rawAsk);
    const reason=!fresh(snapshot.at,now)?'quote-stale-or-time-unknown':!positive(ask)?'quote-unavailable':null;
    const fee=positive(ask) ? .05*ask*(1-ask) : null;
    const row={...shadowFill({trade:{id:p.id,mint:p.marketId,side:'BUY',price:p.ask},data:{ask:reason?null:ask,observedAt:now},feesBps:fee==null?null:fee/ask*10000,latency:{p50Ms:latencyMs}}),
      source:'polymarket-us-public-bbo',reason,quoteAt:snapshot.at??null,depthVerified:false,feeTreatment:'MODELED_US_SCHEDULE_NOT_ACCOUNT_FEE',outcome:p.outcome};
    appendShadowRowOnce(row,{file});return row;
  });
}

export function createShadowCollector({platform,dataDir=process.env.MONEY_PRINTER_DATA_DIR||'data',now=Date.now,intervalMs=60000,maxPositions=8,
  usSnapshot=polymarketUSSnapshot,cryptoQuote=fetchPublicPaperQuote,nativeAdapter=null,jupiterQuote=quoteExactInput}={}) {
  const file=path.resolve(dataDir,'shadow-live.ndjson');let lastAt=null,busy=false,cursor=0;
  const native=()=>nativeAdapter||=(createNativePaperAdapter());
  async function tick({state={},mode='paper'}={}) {
    if(mode!=='paper')return {enabled:false,ordersSubmitted:0};
    const at=now();if(busy||lastAt!==null&&at-lastAt<intervalMs)return {cached:true,ordersSubmitted:0};
    busy=true;lastAt=at;const rows=[],errors=[],jobs=[],cache=new Map();
    const write=(p,source,q={},reason=null)=>{
      const row={...shadowFill({trade:{id:p.id,mint:p.mint||p.marketId||p.symbol,side:p.side||'SELL',price:p.price,slippageBps:p.slippageBps||0},
        data:{price:reason?null:q.price,observedAt:at},feesBps:q.feesBps??null,latency:{p50Ms:q.latencyMs||0}}),
        source,reason,quoteAt:q.at??null,depthVerified:q.depthVerified===true,feeTreatment:q.feeTreatment||'UNKNOWN'};
      appendShadowRowOnce(row,{file});rows.push(row);
    };
    async function prediction(p,source) {
      const start=now(),key=p.venue+':'+p.marketId;
      if(!cache.has(key))cache.set(key,platform.book(p.venue,p.marketId));
      const {book,contract}=await cache.get(key),quoteAt=Math.min(book.observedAt,book.providerTimestamp??book.observedAt);
      if(!positive(p.price))return write(p,source,{},'paper-reference-unavailable');
      if(!fresh(quoteAt,now()))return write(p,source,{},'quote-stale-or-time-unknown');
      const levels=book[String(p.outcome).toLowerCase()]?.[p.side==='BUY'?'asks':'bids']||[];
      const q=walkBook(p.side==='BUY'?levels:levels.map(l=>({...l,price:1-l.price})),Number(p.quantity));
      const fills=q.fills.map(f=>({...f,price:p.side==='BUY'?f.price:1-f.price}));
      const price=fills.reduce((s,f)=>s+f.price*f.quantity,0)/Number(p.quantity),fee=takerFee(contract.data.feeModel,fills);
      write(p,source,{price,at:quoteAt,feesBps:fee==null?null:fee/(price*Number(p.quantity))*10000,latencyMs:now()-start,depthVerified:q.complete,feeTreatment:'VENUE_SCHEDULE'},
        !q.complete?'insufficient-observed-depth':fee==null?'venue-fee-unavailable':null);
    }
    const add=(p,source,fn)=>jobs.push(async()=>{try{await fn();}catch(e){write(p,source,{},String(e.message));}});
    try {
      if(platform?.store?.db) {
        const held=new Set(platform.ledger.portfolio('PAPER').accounts.flatMap(a=>a.positions.map(p=>p.instrumentId)));
        const proposals=platform.store.db.prepare("SELECT payload FROM proposals WHERE status='FILLED' ORDER BY created_at DESC LIMIT 100").all();
        for(const r of proposals){const p=JSON.parse(r.payload);if(!held.has(p.instrumentId)||p.side!=='BUY'||!['kalshi','polymarket'].includes(p.venue))continue;
          const t={...p,marketId:p.sourceId};add(t,'core-prediction',()=>prediction(t,'core-prediction'));}
      }
      for(const p of read(dataDir,'arbitrage-paper.json').open||[])for(const [i,leg] of p.legs.entries()){
        const t={...leg,id:p.id+':'+i,side:'BUY',quantity:p.quantity};add(t,'arbitrage',()=>prediction(t,'arbitrage'));
      }
      for(const p of read(dataDir,'kalshi-paper.json').open||[]){
        const t={...p,marketId:p.ticker,venue:'kalshi',outcome:p.side.toUpperCase(),side:'BUY',quantity:positive(p.price)?Math.floor(p.stakeUsd/p.price):0};
        add(t,'kalshi-paper',()=>positive(p.price)?prediction(t,'kalshi-paper'):write(t,'kalshi-paper',{},'paper-reference-unavailable'));
      }
      const singles=read(dataDir,'polymarket-us-singles-paper.json').open||[];
      if(singles.length)jobs.push(async()=>{try{const start=now(),snapshot=await usSnapshot();rows.push(...recordUSSingleShadow(singles.slice(0,maxPositions),snapshot,{file,now:now(),latencyMs:now()-start}));}catch(e){for(const p of singles.slice(0,maxPositions))write({...p,price:p.ask,side:'BUY'},'polymarket-us-public-bbo',{},String(e.message));}});
      for(const p of read(dataDir,'pumpfun-sniper-paper.json').open||[]) {
        const t={...p,price:p.entryPriceSolPerRaw};
        add(t,'pumpfun-native',async()=>{const start=now(),q=await native().quote({mint:p.mint,user:p.user,action:'SELL',rawAmount:p.rawAmount,runtime:state.runtime,mode});
          write(t,'pumpfun-native',{price:q.solAmount/Number(p.rawAmount),at:q.observedAt,feesBps:0,latencyMs:now()-start,depthVerified:true,feeTreatment:'VENUE_COST_IN_QUOTE_NETWORK_COST_EXCLUDED'},fresh(q.observedAt,now())?null:'quote-stale-or-time-unknown');});
      }
      for(const p of state.positions||[])add({...p,price:p.entryPrice},'solana-jupiter',async()=>{
        const t={...p,price:p.entryPrice},qty=Number(p.paperTokenQuantity),dec=Number(p.decimals);
        if(!positive(qty)||p.decimals==null||!Number.isInteger(dec)||dec<0||dec>18||!positive(state.market?.solUsd))return write(t,'solana-jupiter',{},'token-quantity-decimals-or-fx-unavailable');
        const text=qty.toFixed(dec);if(text.includes('e'))return write(t,'solana-jupiter',{},'unsafe-token-quantity');
        const amount=BigInt(text.replace('.','')).toString(),start=now();
        const q=await jupiterQuote({inputMint:p.mint,outputMint:SOL_MINT,amount});
        write(t,'solana-jupiter',{price:Number(q.outAmount)/1e9*state.market.solUsd/qty,at:now(),feesBps:0,latencyMs:now()-start,depthVerified:true,feeTreatment:'ROUTE_FEE_IN_QUOTE_NETWORK_COST_EXCLUDED'});
      });
      for(const name of ['robinhood-paper.json','robinhood-paper-explore.json']){
        const book=read(dataDir,name);for(const p of book.positions||[]){
          const t={...p,price:p.entryPrice};add(t,'coinbase-public:'+name,async()=>{
            const start=now(),q=await cryptoQuote(p.symbol),reason=!fresh(q.at,now())?'quote-stale-or-time-unknown':Number(q.bidSize)<Number(p.qty)?'insufficient-observed-depth':null;
            write(t,'coinbase-public:'+name,{price:q.bid,at:q.at,feesBps:null,latencyMs:now()-start,depthVerified:!reason,feeTreatment:'ROBINHOOD_ACCOUNT_FEE_UNKNOWN'},reason||'venue-fee-unavailable');
          });
        }
      }
      for(const [symbol,p] of Object.entries(read(dataDir,'robinhood-equities-paper.json').positions||{})){
        const t={...p,id:'equity:'+symbol,symbol,price:p.avgPx};add(t,'equity-public-quote',async()=>{
          const start=now(),q=(await platform.stocks.quoteSource.quotes([symbol]))[0],reason=!q||!fresh(q.quoteAt,now())?'quote-stale-or-time-unknown':Number(q.bidSize)<Number(p.qty)?'insufficient-observed-depth':null;
          const fee=q?sellFees(Number(q.bid)*p.qty,p.qty):null;
          write(t,'equity-public-quote',{price:q?.bid,at:q?.quoteAt,feesBps:fee==null?null:(fee.sec+fee.taf)/(Number(q.bid)*p.qty)*10000,latencyMs:now()-start,depthVerified:!reason,feeTreatment:'PUBLISHED_EQUITY_FEE_SCHEDULE'},reason);
        });
      }
      const limit=Math.min(maxPositions,jobs.length),start=jobs.length?cursor%jobs.length:0;
      for(let i=0;i<limit;i++)await jobs[(start+i)%jobs.length]();cursor=start+limit;
    }catch(e){errors.push(String(e.message));}finally{busy=false;}
    return {enabled:true,at,observations:rows.length,compared:rows.filter(r=>r.divergenceBps!=null).length,errors,ordersSubmitted:0};
  }
  return {tick,file};
}
const collectors=new WeakMap();
export function runShadowTick(platform,state,mode){if(!collectors.has(platform))collectors.set(platform,createShadowCollector({platform}));return collectors.get(platform).tick({state,mode});}
