// Portable, deterministic contract shared byte-for-byte with Evolution Lab. No network, file,
// signing or order transport. Offers must be normalized from depth for the declared quantity.
export const PREDICTION_EXPERIMENT_SCHEMA='mpo.prediction-episodes.v1';
export const PREDICTION_EVALUATOR_VERSION='prediction-episodes.v1';
export function evaluatePredictionEpisodes(input={}){
 const {episodes=[],capital=100,quantity=1,maxEntryPrice=.45,latencyMs=1000,now=Date.now()}=input;
 if(!Number.isFinite(capital)||capital<=0||!Number.isInteger(quantity)||quantity<1||quantity>100||!(maxEntryPrice>0&&maxEntryPrice<1)||!Number.isFinite(latencyMs)||latencyMs<1||episodes.length>10000)throw new Error('Invalid bounded prediction experiment');
 let cash=capital,peak=capital,maxDrawdown=0;const open=new Map(),trades=[],refusals=[],events=[],seen=new Set();
 for(const e of episodes){
   const fail=reason=>refusals.push({id:e?.id??null,reason});
   if(!e||e.venue!=='kalshi'||!e.id||!e.eventId||!e.rulesFingerprint||!Array.isArray(e.quotes)){fail('UNSUPPORTED_OR_MISSING_CONTRACT');continue;}
   if(seen.has(e.id)){fail('DUPLICATE_CONTRACT');continue;}seen.add(e.id);
   const quotes=e.quotes.filter(q=>Number.isSafeInteger(q.at)&&q.at>0&&q.at<=now&&q.quantity===quantity&&q.rulesFingerprint===e.rulesFingerprint&&q.executable===true&&q.feesKnown===true&&Number.isFinite(q.feeUsd)&&q.feeUsd>=0&&Number.isFinite(q.ask)&&q.ask>0&&q.ask<1).sort((a,b)=>a.at-b.at);
   const signal=quotes.find(q=>q.ask<=maxEntryPrice&&q.at<e.closeAt);
   const fill=signal&&quotes.find(q=>q.at>=signal.at+latencyMs&&q.at<e.closeAt);
   if(!fill){fail('NO_POST_DECISION_EXECUTABLE_OFFER');continue;}
   if(fill.ask>maxEntryPrice){fail('LIMIT_NO_LONGER_MARKETABLE');continue;}
   const settlement=e.settlement;
   if(!settlement||!['YES','NO'].includes(settlement.outcome)||!Number.isSafeInteger(settlement.observedAt)||settlement.observedAt<=fill.at||settlement.observedAt>now||settlement.rulesFingerprint!==e.rulesFingerprint){fail('MISSING_OR_INCOMPATIBLE_SETTLEMENT');continue;}
   events.push({at:fill.at,type:'ENTRY',e,fill,signal});
   events.push({at:settlement.observedAt,type:'SETTLEMENT',e,fill,settlement});
 }
 // Funds are unavailable until an outcome was observed. Ties process settlement first.
 events.sort((a,b)=>a.at-b.at||(a.type==='SETTLEMENT'?-1:1));const usedEvents=new Set();
 for(const event of events){
   const {e}=event;
   if(event.type==='ENTRY'){
     const cost=quantity*event.fill.ask+event.fill.feeUsd;
     if(usedEvents.has(e.eventId)){refusals.push({id:e.id,reason:'CORRELATED_EVENT_ALREADY_SAMPLED'});continue;}
     if(cost>cash+1e-10){refusals.push({id:e.id,reason:'CAPITAL_TIED_UP'});continue;}
     cash-=cost;usedEvents.add(e.eventId);open.set(e.id,{cost,at:event.at,entryAsk:event.fill.ask,feeUsd:event.fill.feeUsd,signalAt:event.signal.at});
   }else{
     const position=open.get(e.id);if(!position)continue;
     const payout=event.settlement.outcome==='YES'?quantity:0,pnl=payout-position.cost;cash+=payout;open.delete(e.id);
     trades.push({id:e.id,eventId:e.eventId,venue:e.venue,strategyHash:input.strategyHash??null,...position,closedAt:event.at,payout,pnl,ret:pnl/position.cost,observedSettlement:true,fillKind:'COUNTERFACTUAL_DEPTH_SIMULATION'});
   }
   // Unsettled binary positions have a zero lower-bound payout; report this tail scenario
   // separately from terminal settled performance rather than inventing intermediate marks.
   peak=Math.max(peak,cash);maxDrawdown=Math.max(maxDrawdown,peak-cash);
 }
 const net=cash-capital,wins=trades.filter(t=>t.pnl>0),losses=trades.filter(t=>t.pnl<0),grossWin=wins.reduce((s,t)=>s+t.pnl,0),grossLoss=-losses.reduce((s,t)=>s+t.pnl,0);
 return {schema:PREDICTION_EXPERIMENT_SCHEMA,evaluatorVersion:PREDICTION_EVALUATOR_VERSION,status:!trades.length?'WAITING_FOR_DATA':net<=0?'NO_EDGE':'RESEARCH_ONLY',
   policy:{quantity,maxEntryPrice,latencyMs},capital,terminalCash:cash,netPnl:net,totalReturn:net/capital,closedOutcomes:trades.length,effectiveIndependentObservations:trades.length,
   profitFactor:grossLoss>0?grossWin/grossLoss:null,profitFactorUnbounded:grossLoss===0&&grossWin>0,tailCashDrawdown:maxDrawdown,
   baseline:{name:'cash',terminalCash:capital,netPnl:0},trades,refusals,paperPromotionAllowed:false,liveActivationAllowed:false,automaticLivePromotionAllowed:false,
   blockers:['Historical fixed-policy replay is exploratory; untouched and prospective evidence required','Observed offers do not prove fills or future depth','Settlement costs and capital duration beyond observed outcomes need venue verification'],
   provenance:{datasetHash:input.datasetHash??null,strategyHash:input.strategyHash??null,asOf:now,availabilityRule:'FIRST_RECEIPT_OF_BOOK_AND_SETTLEMENT',costRule:'PER_OFFER_VENUE_FEE_FOR_EXACT_QUANTITY'}};
}
