import path from 'node:path';
import { cfg } from './config.js';
import { PAPER_BOUNDS } from './polymarketUSPaper.js';
import { routePaperProposal, bookRouteLogger } from './paperRouting.js';
import { initializePaperBook, readPaperBook, paperBookStatus, mutatePaperBook } from './paperBookStore.js';
import { fetchMarketsBySlug, longSettlement } from './polymarketUSEvidence.js';

export const SINGLE_PAPER_FILE=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data','polymarket-us-singles-paper.json');
const round=x=>Math.round(Number(x||0)*100)/100;
const bounded=(v,b)=>Math.max(b.min,Math.min(b.max,Number(v)||b.min));
const defaults=()=>({schema:'mpo.polymarket-us-singles-paper.v1',mode:'PAPER',startUsd:100,cashUsd:100,open:[],history:[],createdAt:Date.now()});
function read(file=SINGLE_PAPER_FILE){return readPaperBook(file)}
export function paperSinglesBookView({file=SINGLE_PAPER_FILE}={}){const b=paperBookStatus(file);return {...b,openCount:b.open?.length??null,history:b.history?.slice(0,100)??null}}
// Kept as the public initialization entry point. Existing books can never be reset/refunded.
export function resetPaperSingles({startUsd=100,file=SINGLE_PAPER_FILE}={}){const b=defaults(),start=bounded(startUsd,PAPER_BOUNDS.startUsd);b.startUsd=start;b.cashUsd=start;b.funding=[{at:b.createdAt,amountUsd:start,kind:'INITIAL_CAPITAL'}];return initializePaperBook(file,b)}
export function placePaperSingle({market={},stakeUsd,outcome='Yes',mode=cfg.mode,now=Date.now(),file=SINGLE_PAPER_FILE,maxOpen=25}={}){
 if(String(mode).toLowerCase()!=='paper')throw Object.assign(new Error('single orders require paper mode'),{code:'paper-mode-required'});
 const stake=Number(stakeUsd),yesAsk=Number(market.ask??market.bestAsk?.value??market.bestAsk),yesBid=Number(market.bid??market.bestBid?.value??market.bestBid);
 const id=String(market.slug||market.marketSlug||market.id||''),label=String(outcome||'Yes'),isNo=label.toLowerCase()==='no',ask=isNo?1-yesBid:yesAsk,bid=isNo?1-yesAsk:yesBid;
 if(!['yes','no'].includes(label.toLowerCase())||!id||!(ask>0&&ask<1)||!(bid>=0&&bid<1)||!Number.isFinite(stake)||stake<PAPER_BOUNDS.stakeUsd.min||stake>PAPER_BOUNDS.stakeUsd.max)throw Object.assign(new Error('market, valid bid/ask and $1-$500 stake are required'),{code:'invalid-paper-order'});
 return mutatePaperBook(file,book=>{
 if(book.open.length>=bounded(maxOpen,PAPER_BOUNDS.maxOpen))throw Object.assign(new Error('paper single open-position cap reached'),{code:'open-cap'});
 const feePerContract=.05*ask*(1-ask),quantity=Math.floor(stake/(ask+feePerContract));if(quantity<1)throw Object.assign(new Error('stake is too small for one contract'),{code:'stake-too-small'});
 const quoteAt=Number(market.quoteAt??market.observedAt),depth=Number(isNo?market.bidSize:market.askSize);
 if(!Number.isFinite(quoteAt)||quoteAt>now||now-quoteAt>30000||!(depth>=quantity))throw Object.assign(new Error('fresh observed entry quote and sufficient depth required'),{code:'unavailable-entry-quote'});
 const fee=round(quantity*feePerContract),cost=round(quantity*ask+fee);if(cost>book.cashUsd)throw Object.assign(new Error('insufficient paper cash'),{code:'insufficient-paper-cash'});
 const entry={id:`ps-${now.toString(36)}-${Math.random().toString(36).slice(2,7)}`,marketId:id,title:String(market.eventTitle||market.question||market.title||id),category:market.category||null,outcome:label,ask,bid,quantity,stakeUsd:stake,costUsd:cost,feeUsd:fee,status:'OPEN',openedAt:now,entryQuoteAt:quoteAt,entryDepth:depth,feeModelVersion:'us-single-assumed-curve.v1',source:'public-market-snapshot'};
 const routed=routePaperProposal({state:book,pick:{marketId:id,instrumentKey:`polymarket-us:${id}:${label}`,name:entry.title},assetClass:String(entry.category||'prediction').toLowerCase(),platform:'polymarket',stakeUsd:cost,mode,proposalId:entry.id,logger:bookRouteLogger(book)});
 if(!routed.proposal)throw new Error('Central paper route refused the Polymarket proposal');
 entry.proposalId=routed.proposal.id;
 book.cashUsd=round(book.cashUsd-cost);book.open.unshift(entry);return entry;
 }).result;
}
export function markPaperSingles(markets=[],{file=SINGLE_PAPER_FILE,now=Date.now(),persist=false}={}){
 const book=read(file),byId=new Map(markets.map(m=>[String(m.slug||m.marketSlug||m.id||''),m]));
 const marks=book.open.map(p=>{const m=byId.get(p.marketId),isNo=String(p.outcome).toLowerCase()==='no',raw=isNo?(m?.ask??m?.bestAsk?.value??m?.bestAsk):(m?.bid??m?.bestBid?.value??m?.bestBid),bid=raw==null?NaN:isNo?1-Number(raw):Number(raw),at=Number(m?.quoteAt??m?.observedAt),depth=Number(isNo?m?.askSize:m?.bidSize),executable=bid>=0&&bid<1&&Number.isFinite(at)&&at>=p.openedAt&&at<=now&&now-at<=30000&&depth>=p.quantity;
 return {...p,markBid:Number.isFinite(bid)?bid:null,unrealizedUsd:Number.isFinite(bid)?round(p.quantity*bid-p.costUsd):null,markEvidence:executable?'OBSERVED_EXECUTABLE_DEPTH':'BBO_COMPARISON_ONLY',markAt:executable?at:null,markValueUsd:executable?round(p.quantity*bid-round(p.quantity*.05*bid*(1-bid))):null}});
 if(persist)mutatePaperBook(file,b=>{const byPosition=new Map(marks.map(p=>[p.id,p]));b.open=b.open.map(p=>{const m=byPosition.get(p.id);return m&&p.quantity===m.quantity?m:p});b.lastMarkAt=now});
 return marks;
}

export function closePaperSingle({id,market={},quantity=null,now=Date.now(),file=SINGLE_PAPER_FILE,receiptId=null,maxQuoteAgeMs=30000}={}){
 return mutatePaperBook(file,book=>{
  const p=book.open.find(x=>x.id===id);if(!p)throw Object.assign(new Error('unknown open single'),{code:'position-not-found'});
  const marketId=String(market.slug||market.marketSlug||market.id||'');
  const at=Number(market.quoteAt??market.observedAt),q=quantity==null?p.quantity:Number(quantity);
  const raw=String(p.outcome).toLowerCase()==='no'?(market.ask??market.bestAsk?.value??market.bestAsk):(market.bid??market.bestBid?.value??market.bestBid);
  const bid=raw==null?NaN:String(p.outcome).toLowerCase()==='no'?1-Number(raw):Number(raw);
  const depth=Number(String(p.outcome).toLowerCase()==='no'?market.askSize:market.bidSize);
  if(marketId!==p.marketId||!Number.isFinite(at)||at<p.openedAt||at>now||now-at>maxQuoteAgeMs||!(bid>=0&&bid<1)||!Number.isInteger(q)||q<1||q>p.quantity||!(depth>=q))throw Object.assign(new Error('fresh matching executable bid and sufficient observed depth required'),{code:'unavailable-exit-quote'});
  const cost=round(p.costUsd*q/p.quantity),fee=round(q*.05*bid*(1-bid)),proceeds=round(q*bid-fee);
  const closed={...p,id:q===p.quantity?p.id:`${p.id}-exit-${book._persistence?.revision||0}`,quantity:q,costUsd:cost,status:'SOLD',exitBid:bid,exitQuoteAt:at,exitFeeUsd:fee,payoutUsd:proceeds,pnlUsd:round(proceeds-cost),closedAt:now};
  book.cashUsd=round(book.cashUsd+proceeds);book.history.unshift(closed);
  if(q===p.quantity)book.open=book.open.filter(x=>x.id!==id);else{p.quantity-=q;p.costUsd=round(p.costUsd-cost)}
  return closed;
 },{receiptId}).result;
}
export async function settlePaperSingles({markets=null,fetchImpl=globalThis.fetch,now=Date.now(),file=SINGLE_PAPER_FILE}={}){
 const snapshot=read(file);
 const rows=markets??await fetchMarketsBySlug([...new Set(snapshot.open.map(p=>p.marketId))],fetchImpl);
 const byId=new Map(rows.map(m=>[String(m.slug||m.id||''),m]));
 return mutatePaperBook(file,book=>{
  let settled=0;const still=[];
  for(const p of book.open){
   const m=byId.get(p.marketId),resolution=m?.status==='MARKET_STATUS_RESOLVED'?longSettlement(m):null;
   if(resolution!==0&&resolution!==1){still.push({...p,lastSettlementAt:now,settlementReason:m?'UNRESOLVED_OR_NONBINARY':'MISSING_MARKET'});continue}
   const won=String(p.outcome).toLowerCase()==='no'?resolution===0:resolution===1,payout=won?p.quantity:0;
   book.cashUsd=round(book.cashUsd+payout);book.history.unshift({...p,status:won?'WON':'LOST',payoutUsd:payout,pnlUsd:round(payout-p.costUsd),settledAt:now,settlementSource:'polymarket-us-public-resolution',resolution});settled++;
  }
  book.open=still;book.lastSettlementAt=now;return {settled,unresolved:still.length};
 }).result;
}
