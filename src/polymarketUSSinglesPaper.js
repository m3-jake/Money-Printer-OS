import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { PAPER_BOUNDS } from './polymarketUSPaper.js';
import { routePaperProposal, bookRouteLogger } from './paperRouting.js';

export const SINGLE_PAPER_FILE=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data','polymarket-us-singles-paper.json');
const round=x=>Math.round(Number(x||0)*100)/100;
const bounded=(v,b)=>Math.max(b.min,Math.min(b.max,Number(v)||b.min));
const defaults=()=>({schema:'mpo.polymarket-us-singles-paper.v1',mode:'PAPER',startUsd:100,cashUsd:100,open:[],history:[],createdAt:Date.now()});
function read(file=SINGLE_PAPER_FILE){try{const x=JSON.parse(fs.readFileSync(file,'utf8'));return {...defaults(),...x,mode:'PAPER',open:Array.isArray(x.open)?x.open:[],history:Array.isArray(x.history)?x.history:[]}}catch{return defaults()}}
function write(book,file=SINGLE_PAPER_FILE){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(book,null,2));fs.renameSync(tmp,file);return book}
export function paperSinglesBookView({file=SINGLE_PAPER_FILE}={}){const b=read(file);return {...b,openCount:b.open.length,history:b.history.slice(0,100)}}
export function resetPaperSingles({startUsd=100,file=SINGLE_PAPER_FILE}={}){const b=defaults(),start=bounded(startUsd,PAPER_BOUNDS.startUsd);b.startUsd=start;b.cashUsd=start;return write(b,file)}
export function placePaperSingle({market={},stakeUsd,outcome='Yes',mode=cfg.mode,now=Date.now(),file=SINGLE_PAPER_FILE,maxOpen=25}={}){
 if(String(mode).toLowerCase()!=='paper')throw Object.assign(new Error('single orders require paper mode'),{code:'paper-mode-required'});
 const stake=Number(stakeUsd),yesAsk=Number(market.ask??market.bestAsk?.value??market.bestAsk),yesBid=Number(market.bid??market.bestBid?.value??market.bestBid);
 const id=String(market.slug||market.marketSlug||market.id||''),label=String(outcome||'Yes'),isNo=label.toLowerCase()==='no',ask=isNo?1-yesBid:yesAsk,bid=isNo?1-yesAsk:yesBid;
 if(!['yes','no'].includes(label.toLowerCase())||!id||!(ask>0&&ask<1)||!(bid>=0&&bid<1)||!Number.isFinite(stake)||stake<PAPER_BOUNDS.stakeUsd.min||stake>PAPER_BOUNDS.stakeUsd.max)throw Object.assign(new Error('market, valid bid/ask and $1-$500 stake are required'),{code:'invalid-paper-order'});
 const book=read(file);if(book.open.length>=bounded(maxOpen,PAPER_BOUNDS.maxOpen))throw Object.assign(new Error('paper single open-position cap reached'),{code:'open-cap'});
 const feePerContract=.05*ask*(1-ask),quantity=Math.floor(stake/(ask+feePerContract));if(quantity<1)throw Object.assign(new Error('stake is too small for one contract'),{code:'stake-too-small'});
 const fee=round(quantity*feePerContract),cost=round(quantity*ask+fee);if(cost>book.cashUsd)throw Object.assign(new Error('insufficient paper cash'),{code:'insufficient-paper-cash'});
 const entry={id:`ps-${now.toString(36)}-${Math.random().toString(36).slice(2,7)}`,marketId:id,title:String(market.eventTitle||market.question||market.title||id),category:market.category||null,outcome:label,ask,bid,quantity,stakeUsd:stake,costUsd:cost,feeUsd:fee,status:'OPEN',openedAt:now,source:'public-market-snapshot'};
 const routed=routePaperProposal({state:book,pick:{marketId:id,instrumentKey:`polymarket-us:${id}:${label}`,name:entry.title},assetClass:String(entry.category||'prediction').toLowerCase(),platform:'polymarket',stakeUsd:cost,mode,proposalId:entry.id,logger:bookRouteLogger(book)});
 if(!routed.proposal)throw new Error('Central paper route refused the Polymarket proposal');
 entry.proposalId=routed.proposal.id;
 book.cashUsd=round(book.cashUsd-cost);book.open.unshift(entry);write(book,file);return entry;
}
export function markPaperSingles(markets=[],{file=SINGLE_PAPER_FILE}={}){
 const book=read(file),byId=new Map(markets.map(m=>[String(m.slug||m.marketSlug||m.id||''),m]));
 return book.open.map(p=>{const m=byId.get(p.marketId),raw=String(p.outcome).toLowerCase()==='no'?(m?.ask??m?.bestAsk?.value??m?.bestAsk):(m?.bid??m?.bestBid?.value??m?.bestBid),bid=raw==null?NaN:String(p.outcome).toLowerCase()==='no'?1-Number(raw):Number(raw);return {...p,markBid:Number.isFinite(bid)?bid:null,unrealizedUsd:Number.isFinite(bid)?round(p.quantity*bid-p.costUsd):null}});
}
