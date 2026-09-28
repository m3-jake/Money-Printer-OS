import fs from 'node:fs';
import path from 'node:path';
import { proposeTrade } from './proposals.js';

const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const num = x => Number.isFinite(Number(x)) ? Number(x) : null;

export function matchMarkets(a, b) {
  if (!a || !b) return { ok: false, reason: 'missing-market' };
  const eventA = norm(a.event || a.eventTitle || a.eventId), eventB = norm(b.event || b.eventTitle || b.eventId);
  const outcomeA = norm(a.outcome), outcomeB = norm(b.outcome);
  if (!eventA || eventA !== eventB) return { ok: false, reason: 'event-mismatch' };
  if (!outcomeA || outcomeA !== outcomeB) return { ok: false, reason: 'outcome-mismatch' };
  if (a.venue === b.venue) return { ok: false, reason: 'same-venue' };
  return { ok: true, event: eventA, outcome: outcomeA };
}

export function detectDislocation(a, b, { feesBps = 0, slippageBps = 0, bufferBps = 0 } = {}) {
  const match = matchMarkets(a, b), askA = num(a?.ask ?? a?.price), askB = num(b?.ask ?? b?.price), bidA = num(a?.bid ?? a?.ask ?? a?.price), bidB = num(b?.bid ?? b?.ask ?? b?.price);
  if (!match.ok || !(askA > 0) || !(askB > 0) || !(bidA > 0) || !(bidB > 0)) return { ok: false, match, reason: match.reason || 'invalid-price' };
  const buyA = askA <= askB && askA < bidB, cheap = buyA ? a : b, rich = buyA ? b : a;
  const buyPrice=Number(cheap.ask??cheap.price),sellPrice=Number(rich.bid??rich.ask??rich.price);
  const grossEdgeBps = Math.max(0,(sellPrice-buyPrice) / buyPrice * 10_000);
  const requiredBps = Math.max(0, Number(feesBps) || 0) + Math.max(0, Number(slippageBps) || 0) + Math.max(0, Number(bufferBps) || 0);
  return { ok: grossEdgeBps > requiredBps, match, reason: grossEdgeBps > requiredBps ? null : 'edge-below-costs', grossEdgeBps, requiredBps,
    legs: [{ action: 'BUY', venue: cheap.venue, marketId: cheap.id, outcome: cheap.outcome, price: buyPrice },
      { action: 'SELL', venue: rich.venue, marketId: rich.id, outcome: rich.outcome, price: sellPrice }] };
}

export function normalizePolymarketBook(market={}){
 const outcomes=Array.isArray(market.outcomes)?market.outcomes:[];
 const outcome=String(market.outcome||'Yes'),quote=outcomes.find(x=>String(x.name||x.outcome).toLowerCase()===outcome.toLowerCase())||market;
 return {venue:'polymarket',id:String(market.id||market.slug||market.marketSlug||''),event:String(market.event||market.eventTitle||market.question||market.title||market.eventId||''),outcome,
  bid:num(quote.bestBid??quote.bid??market.bestBid??market.bid),ask:num(quote.bestAsk??quote.ask??market.bestAsk??market.ask),category:market.category||null,observedAt:Number(market.updatedAt||market.at||0)||null};
}
export function normalizeKalshiBook(market={}){
 const outcome=String(market.outcome||'Yes'),yes=outcome.toLowerCase()==='yes',cents=x=>num(x)==null?null:Number(x)/100;
 return {venue:'kalshi',id:String(market.ticker||market.id||''),event:String(market.event||market.title||market.event_title||market.event_ticker||''),outcome,
  bid:cents(yes?market.yes_bid:market.no_bid),ask:cents(yes?market.yes_ask:market.no_ask),category:market.category||null,observedAt:market.updated_time?Date.parse(market.updated_time):null};
}
export function scanArbitrageBooks({polymarket=[],kalshi=[],feesBps=0,slippageBps=0,bufferBps=0}={}){
 const left=polymarket.map(normalizePolymarketBook),right=kalshi.map(normalizeKalshiBook),rows=[];
 for(const a of left)for(const b of right){
  if(!a.id||!b.id||!a.event||!b.event||!a.bid||!a.ask||!b.bid||!b.ask)continue;
  const opportunity=detectDislocation(a,b,{feesBps,slippageBps,bufferBps});
  if(opportunity.match.ok)rows.push({...opportunity,markets:[a,b]});
 }
 return rows.sort((a,b)=>b.grossEdgeBps-a.grossEdgeBps);
}

export function recordArbitrageOpportunity(opportunity, file = path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data', 'arbitrage.ndjson')) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { type: 'arbitrage-opportunity', mode: 'PAPER', at: Date.now(), ...opportunity };
  fs.appendFileSync(file, JSON.stringify(row) + '\n'); return row;
}

export function proposePairedArbitrage(state, opportunity, { mode = 'paper', file } = {}) {
  const row = recordArbitrageOpportunity(opportunity, file);
  if (mode !== 'paper' || !opportunity?.ok || opportunity.legs?.length !== 2) return { recorded: row, proposal: null };
  const proposal = { id: `arb-${Date.now()}`, kind: 'ARBITRAGE_PAIR', status: 'PENDING', createdAt: Date.now(), atomic: true,
    signalSource: 'cross-venue-arbitrage', legs: opportunity.legs.map(leg => ({ ...leg, status:'PENDING' })), statusReason: 'paper-paired-proposal' };
  // Preserve the proposal contract by creating one parent entry through proposeTrade; legs remain atomically grouped.
  const parent = proposeTrade(state, { mint: `arbitrage:${proposal.id}`, symbol: 'ARB', name: opportunity.match.event, dominantSignal: 'cross-venue-arbitrage', signalSource: 'cross-venue-arbitrage' }, 0);
  Object.assign(parent, proposal);
  return { recorded: row, proposal: parent };
}
