import { JsonProvider, ProviderError } from './provider.js';
import { entity, finite, probability, stableId, timestamp } from './model.js';
import { kalshiFeeModel, polymarketFeeModel } from './fees.js';

const list=v=>{if(Array.isArray(v))return v;if(typeof v==='string'){try{const a=JSON.parse(v);return Array.isArray(a)?a:[];}catch{}}return [];};
const dollars=(v,cents)=>probability(v??(finite(cents)===null?null:Number(cents)/100));
const ruleDefaults={eventKey:null,outcomeDefinition:null,resolutionSource:null,settlementRules:null,edgeCases:null,cancellationRules:null,currency:'USD',payout:1,termsVerified:false};
// Series ticker: the event ticker's first segment (market objects don't carry series_ticker).
export const kalshiSeriesOf=raw=>raw?.series_ticker||(typeof raw?.event_ticker==='string'?raw.event_ticker.split('-')[0]:null);
export function normalizeKalshi(raw,observedAt=Date.now(),series=null) {
  if(!raw||typeof raw.ticker!=='string'||typeof raw.title!=='string')throw new ProviderError('MALFORMED_DATA','Kalshi market lacks ticker/title');
  return entity('Contract','kalshi',raw.ticker,{...ruleDefaults,venue:'kalshi',title:raw.title,sourceEventId:raw.event_ticker||null,eventId:raw.event_ticker?stableId('Event','kalshi',raw.event_ticker):null,
    outcomeDefinition:raw.yes_sub_title||raw.subtitle||null,expiresAt:timestamp(raw.expiration_time),closeAt:timestamp(raw.close_time),settlementRules:raw.rules_primary||null,secondaryRules:raw.rules_secondary||null,
    status:String(raw.status||'UNKNOWN').toUpperCase(),category:raw.category||null,yesBid:dollars(raw.yes_bid_dollars,raw.yes_bid),yesAsk:dollars(raw.yes_ask_dollars,raw.yes_ask),noBid:dollars(raw.no_bid_dollars,raw.no_bid),noAsk:dollars(raw.no_ask_dollars,raw.no_ask),
    volume:finite(raw.volume_fp??raw.volume),liquidityUsd:finite(raw.liquidity_dollars),feeSchedule:null,quoteSource:'market-metadata',quoteExecutable:false,
    seriesTicker:kalshiSeriesOf(raw),resolutionSource:series?.settlement_sources?.[0]?.url||null,feeModel:kalshiFeeModel(series).model,feeModelReason:kalshiFeeModel(series).reason},
    {observedAt,sourceUrl:`https://kalshi.com/markets/${encodeURIComponent((raw.event_ticker||raw.ticker).toLowerCase())}`});
}
function levels(rows,scale=1){if(!Array.isArray(rows))throw new ProviderError('MALFORMED_DATA','Order book levels missing');return rows.map(row=>{const price=probability(Number(row[0])*scale),quantity=finite(row[1]);if(price===null||quantity===null||quantity<0)throw new ProviderError('MALFORMED_DATA','Invalid book level');return {price,quantity};}).filter(l=>l.quantity>0);}
export function normalizeKalshiBook(raw,observedAt=Date.now()) {
  const book=raw.orderbook_fp||raw.orderbook;if(!book)throw new ProviderError('MALFORMED_DATA','Kalshi orderbook missing');
  const fixed=!!raw.orderbook_fp,yes=levels(book.yes_dollars??book.yes??[],fixed||book.yes_dollars?1:.01),no=levels(book.no_dollars??book.no??[],fixed||book.no_dollars?1:.01);
  const bids=arr=>arr.sort((a,b)=>b.price-a.price),asks=arr=>arr.map(l=>({price:Number((1-l.price).toFixed(6)),quantity:l.quantity})).sort((a,b)=>a.price-b.price);
  return {observedAt,providerTimestamp:null,timeQuality:'RECEIVED_AT',yes:{bids:bids(yes),asks:asks(no)},no:{bids:bids(no),asks:asks(yes)}};
}
export class KalshiProvider extends JsonProvider {
  constructor(options={}){super('kalshi',options);this.base='https://external-api.kalshi.com/trade-api/v2';this.seriesCache=new Map();}
  // Series carry the fee schedule and settlement sources. Cached for an hour; a failed lookup leaves
  // fees unavailable on those contracts instead of failing the market list.
  async series(ticker){
    if(!ticker)return null;const hit=this.seriesCache.get(ticker);if(hit&&Date.now()-hit.at<3600000)return hit.series;
    try{const raw=await this.get(`${this.base}/series/${encodeURIComponent(ticker)}`,{ttlMs:3600000});const series=raw?.series||null;this.seriesCache.set(ticker,{at:Date.now(),series});return series;}catch{return null;}
  }
  async seriesFor(raws){const out=new Map();for(const t of new Set(raws.map(kalshiSeriesOf).filter(Boolean)))out.set(t,await this.series(t));return out;}
  async markets({cursor='',series='',eventTicker='',limit=100}={}){
    const u=new URL(`${this.base}/markets`);u.searchParams.set('status','open');u.searchParams.set('limit',String(Math.min(200,Math.max(1,limit))));u.searchParams.set('mve_filter','exclude');
    if(cursor)u.searchParams.set('cursor',cursor);if(series)u.searchParams.set('series_ticker',series);if(eventTicker)u.searchParams.set('event_ticker',eventTicker);
    const raw=await this.get(u,{ttlMs:10000});if(!Array.isArray(raw.markets))throw new ProviderError('MALFORMED_DATA','Kalshi markets array missing');
    const at=this.observedAt(raw),seriesMap=await this.seriesFor(raw.markets);
    return {markets:raw.markets.map(m=>normalizeKalshi(m,at,seriesMap.get(kalshiSeriesOf(m))||null)),cursor:raw.cursor||null};
  }
  async market(id){const raw=await this.get(`${this.base}/markets/${encodeURIComponent(id)}`);const at=this.observedAt(raw);return normalizeKalshi(raw.market,at,await this.series(kalshiSeriesOf(raw.market)));}
  async book(id){const raw=await this.get(`${this.base}/markets/${encodeURIComponent(id)}/orderbook`,{ttlMs:1000});return normalizeKalshiBook(raw,this.observedAt(raw));}
  async event(id){const raw=await this.get(`${this.base}/events/${encodeURIComponent(id)}`);const e=raw.event;if(!e?.event_ticker)throw new ProviderError('MALFORMED_DATA','Kalshi event missing');return entity('Event',this.id,e.event_ticker,{title:e.title,category:e.category||null,seriesTicker:e.series_ticker||null});}
}
export function normalizePolymarket(raw,observedAt=Date.now()) {
  if(!raw?.id||typeof raw.question!=='string')throw new ProviderError('MALFORMED_DATA','Polymarket market lacks id/question');
  const outcomes=list(raw.outcomes),tokens=list(raw.clobTokenIds),prices=list(raw.outcomePrices),event=raw.events?.[0];
  // Two named outcomes ("Ole Miss" / "Florida", "Over" / "Under") are a binary market too: the first
  // outcome is carried as YES and the second as NO, and the labels travel with the contract.
  const named=outcomes.length===2&&!outcomes.some(v=>/^(yes|no)$/i.test(String(v)));
  let yes=outcomes.findIndex(v=>String(v).toLowerCase()==='yes'),no=outcomes.findIndex(v=>String(v).toLowerCase()==='no');if(named){yes=0;no=1;}
  return entity('Contract','polymarket',String(raw.id),{...ruleDefaults,venue:'polymarket',title:raw.question,sourceEventId:event?.id?String(event.id):null,eventId:event?.id?stableId('Event','polymarket',String(event.id)):null,
    outcomeDefinition:raw.question,expiresAt:timestamp(raw.endDate),closeAt:timestamp(raw.endDate),resolutionSource:raw.resolutionSource||null,settlementRules:raw.description||null,
    status:raw.closed?'CLOSED':raw.active?'OPEN':'INACTIVE',category:raw.category||null,yesBid:probability(raw.bestBid),yesAsk:probability(raw.bestAsk),noBid:null,noAsk:null,
    impliedProbability:yes>=0?probability(prices[yes]):null,volume:finite(raw.volumeNum??raw.volume),liquidityUsd:finite(raw.liquidityNum??raw.liquidity),
    outcomes,yesLabel:yes>=0?String(outcomes[yes]):null,noLabel:no>=0?String(outcomes[no]):null,eventTitle:event?.title||null,tokenIds:tokens,yesToken:yes>=0?tokens[yes]||null:null,noToken:no>=0?tokens[no]||null:null,binary:outcomes.length===2&&yes>=0&&no>=0,feeSchedule:raw.feeSchedule||null,feeModel:polymarketFeeModel(raw).model,feeModelReason:polymarketFeeModel(raw).reason,quoteSource:'market-metadata',quoteExecutable:false},
    {observedAt,sourceUrl:raw.slug?`https://polymarket.com/event/${encodeURIComponent(event?.slug||raw.slug)}`:null});
}
export class PolymarketProvider extends JsonProvider {
  constructor(options={}){super('polymarket',{minIntervalMs:0,...options});}
  async markets({offset=0,limit=100}={}){const u=new URL('https://gamma-api.polymarket.com/markets');// Most-traded first, so live and near-term markets (where cross-venue pairs exist) load first.
    for(const [k,v] of Object.entries({active:true,closed:false,limit:Math.min(200,limit),offset,order:'volume24hr',ascending:false}))u.searchParams.set(k,String(v));const raw=await this.get(u,{ttlMs:10000});if(!Array.isArray(raw))throw new ProviderError('MALFORMED_DATA','Polymarket markets array missing');return {markets:raw.map(m=>normalizePolymarket(m,this.observedAt(raw))),cursor:raw.length===limit?String(Number(offset)+limit):null};}
  // The list endpoint filtered by id includes the parent event (title, id); /markets/{id} omits it,
  // which would drop the participants that contract matching reads from the event title.
  async market(id){const raw=await this.get(`https://gamma-api.polymarket.com/markets?id=${encodeURIComponent(id)}`);if(!Array.isArray(raw)||!raw[0])throw new ProviderError('MALFORMED_DATA','Polymarket market not found');return normalizePolymarket(raw[0],this.observedAt(raw));}
  async book(id,contract){
    if(!contract?.data?.binary||!contract.data.yesToken||!contract.data.noToken)throw new ProviderError('UNSUPPORTED_MARKET','Only complete binary token books are supported');
    const result=await Promise.all([contract.data.yesToken,contract.data.noToken].map(token=>this.get(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(token)}`,{ttlMs:1000})));
    const parsed=result.map(raw=>{if(!Array.isArray(raw.bids)||!Array.isArray(raw.asks))throw new ProviderError('MALFORMED_DATA','Polymarket book missing');return {bids:levels(raw.bids.map(l=>[l.price,l.size])).sort((a,b)=>b.price-a.price),asks:levels(raw.asks.map(l=>[l.price,l.size])).sort((a,b)=>a.price-b.price)};});
    const times=result.map(r=>finite(r.timestamp)).filter(v=>v!==null);
    return {observedAt:Math.min(...result.map(r=>this.observedAt(r))),providerTimestamp:times.length===2?Math.min(...times):null,timeQuality:times.length===2?'PROVIDER_TIME':'RECEIVED_AT',yes:parsed[0],no:parsed[1]};
  }
}
