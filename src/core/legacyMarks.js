import { finite, stableId, timestamp } from './model.js';

// Use the SAME public L1 observations as the isolated practice simulator, not entry prices,
// synthetic depth, authenticated accounts, or a new provider request. Quotes remain Coinbase
// observations; liquidation costs are the explicit practice assumptions, not Robinhood fees.
export function practiceMirrorMarks(book, portfolio, mirror, { now=Date.now(), maxAgeMs=15000 }={}) {
  const marks=[],issues=[],venue='robinhood-practice';
  const account=mirror?`legacy-${mirror.epoch}`:null;
  const acct=portfolio.accounts.find(a=>a.venue===venue&&a.account===account&&a.currency==='USD');
  if(!acct)return {marks,issues,scope:'PAPER_PRACTICE_MIRROR'};
  const fail=(reason,instrumentId=null)=>issues.push({venue,account,instrumentId,reason});
  if(!book||book.recoveryRequired||mirror.status!=='RECONCILED'||!Array.isArray(book.positions)){
    fail('PRACTICE_BOOK_UNRECONCILED');return {marks,issues,scope:'PAPER_PRACTICE_MIRROR'};
  }
  const sourcePositions=book.positions;
  if(sourcePositions.length!==acct.positions.length||sourcePositions.some(p=>typeof p.id!=='string'||!p.id||finite(p.qty)===null||p.qty<=0||finite(p.costUsd)===null||p.costUsd<0||!/^\w+-USD$/.test(p.symbol))||new Set(sourcePositions.map(p=>p.id)).size!==sourcePositions.length){fail('INVALID_OR_UNRECONCILED_PRACTICE_POSITIONS');return {marks,issues,scope:'PAPER_PRACTICE_MIRROR'};}
  if(finite(book.cashUsd)===null||Math.abs(Number(acct.cash)-book.cashUsd)>1e-6){fail('PRACTICE_BOOK_CHANGED_SINCE_SYNC');return {marks,issues,scope:'PAPER_PRACTICE_MIRROR'};}
  const slip=finite(book.settings?.slippageBps),fee=finite(book.settings?.feeBps);
  if(slip===null||slip<0||slip>10000||fee===null||fee<0||fee>10000){fail('UNKNOWN_PRACTICE_LIQUIDATION_COSTS');return {marks,issues,scope:'PAPER_PRACTICE_MIRROR'};}
  const quantities=new Map();
  for(const p of sourcePositions)quantities.set(p.symbol,(quantities.get(p.symbol)||0)+Number(p.qty));
  for(const p of acct.positions){
    const source=sourcePositions.find(x=>stableId('Instrument',venue,x.id)===p.instrumentId);
    if(!source||finite(source.qty)===null||Math.abs(source.qty-Number(p.quantity))>1e-8||Math.abs(Number(source.costUsd)-Number(p.costBasis))>1e-6){fail('PRACTICE_POSITION_CHANGED_SINCE_SYNC',p.instrumentId);continue;}
    const q=book.telemetry?.lastQuotes?.[source.symbol],size=finite(q?.bidSize),bid=finite(q?.bid);
    const reason=!q?'MISSING_PRACTICE_QUOTE':q.source!=='coinbase-public-paper'?'UNVERIFIED_PRACTICE_MARK_SOURCE':q.auctionMode===true?'INDICATIVE_AUCTION_QUOTE':q.timeQuality!=='VENUE_TIME'||!timestamp(q.at)||q.at>now||now-q.at>maxAgeMs?'STALE_OR_UNVERIFIED_PRACTICE_QUOTE':q.depthQuality!=='OBSERVED_L1'||size===null||size<=0?'UNKNOWN_PRACTICE_LIQUIDATION_DEPTH':bid===null||bid<=0||finite(q.ask)===null||q.ask<bid?'INVALID_PRACTICE_BBO':null;
    if(reason){fail(reason,p.instrumentId);continue;}
    const totalQty=quantities.get(source.symbol),qty=Number(p.quantity);
    if(!Number.isFinite(totalQty)||totalQty<=0){fail('INVALID_PRACTICE_POSITION_QUANTITY',p.instrumentId);continue;}
    // One observed bid level is shared across every practice position in the same symbol.
    const supportedQuantity=Math.min(qty,size*qty/totalQty);
    const adjustedBid=bid*(1-slip/10000),gross=qty*adjustedBid;
    const grossCents=Math.floor((gross+1e-10)*100)/100;
    const feeCents=Math.ceil((grossCents*fee/10000-1e-10)*100)/100;
    const net=Math.max(0,Math.min(gross,grossCents-feeCents));
    // Proportional fees match the valuation contract; cents rounding is conservative.
    const liquidationFee=(gross-net)*supportedQuantity/qty;
    marks.push({venue,account,instrumentId:p.instrumentId,bid:adjustedBid,quantity:supportedQuantity,
      liquidationFee,at:q.at,source:'coinbase-public-paper:observed-l1/practice-slippage-and-fee-assumptions'});
    if(supportedQuantity+1e-8<qty)fail('INSUFFICIENT_PRACTICE_LIQUIDATION_DEPTH',p.instrumentId);
  }
  return {marks,issues,scope:'PAPER_PRACTICE_MIRROR',exchangeExecution:false,additionalProviderCalls:0};
}
