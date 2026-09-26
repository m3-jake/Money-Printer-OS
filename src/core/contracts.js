import { finite, probability, timestamp } from './model.js';
import { takerFee } from './fees.js';

const RULE_FIELDS=['eventKey','outcomeDefinition','expiresAt','resolutionSource','settlementRules','edgeCases','cancellationRules','currency','payout'];
const known=v=>v!==null&&v!==undefined&&v!=='';
export function compareContracts(a,b) {
  const missing=RULE_FIELDS.filter(k=>!known(a[k])||!known(b[k]));
  const differences=RULE_FIELDS.filter(k=>known(a[k])&&known(b[k])&&a[k]!==b[k]);
  let classification='RELATED';
  if(differences.some(k=>['eventKey','outcomeDefinition','expiresAt','currency','payout','cancellationRules'].includes(k)))classification='NOT EQUIVALENT';
  else if(!missing.length&&!differences.length&&a.termsVerified===true&&b.termsVerified===true)classification='EXACT MATCH';
  else if(!missing.length&&!differences.length)classification='STRONG MATCH';
  return {classification,missing,differences,settlementMismatchRisk:classification==='EXACT MATCH'?'VERIFIED_TERMS_STILL_SUBJECT_TO_VENUE_RISK':'UNVERIFIED_OR_DIFFERENT_TERMS',fields:RULE_FIELDS.map(k=>({field:k,a:a[k]??null,b:b[k]??null}))};
}
export function walkBook(levels,requested) {
  if(!Array.isArray(levels)||!Number.isFinite(requested)||requested<=0)throw new Error('Positive size and book levels required');
  const sorted=levels.map(l=>({price:probability(l.price),quantity:finite(l.quantity)}));
  if(sorted.some(l=>l.price===null||l.quantity===null||l.quantity<0))throw new Error('Malformed book level');
  sorted.sort((a,b)=>a.price-b.price);let remaining=requested,cost=0;const fills=[];
  for(const l of sorted){const take=Math.min(remaining,l.quantity);if(take>0)fills.push({price:l.price,quantity:take});cost+=take*l.price;remaining-=take;if(remaining<=1e-9)break;}
  const filled=requested-remaining,average=filled?cost/filled:null,top=sorted.find(l=>l.quantity>0)?.price;
  return {quantity:filled,cost,fills,averagePrice:average,slippageBps:average!==null&&top>0?(average/top-1)*10000:null,complete:remaining<=1e-9};
}
// match: optional structured result (contractTerms.matchTerms + attestation). Without it the plain
// field comparison applies. Only EXACT MATCH lets a locked return be shown.
// feeModels {a,b}: venue taker-fee models (fees.js), priced on each direction's actual fills.
// Without them, feeA/feeB are flat totals (null = unavailable).
export function arbitrageQuote(a,b,bookA,bookB,{quantity=1,feeA=null,feeB=null,feeModels=null,now=Date.now(),maxAgeMs=15000,maxBookSkewMs=1000,match:given=null}={}) {
  const match=given||compareContracts(a,b),reasons=[];
  if(a.venue===b.venue)reasons.push('SAME_VENUE');
  if(match.classification!=='EXACT MATCH')reasons.push('SETTLEMENT_NOT_VERIFIED_EQUIVALENT');
  if(!timestamp(bookA?.observedAt)||!timestamp(bookB?.observedAt)||[bookA,bookB].some(x=>x.observedAt>now||now-x.observedAt>maxAgeMs))reasons.push('STALE_BOOK');
  if(Math.abs(bookA?.observedAt-bookB?.observedAt)>maxBookSkewMs)reasons.push('UNSYNCHRONIZED_BOOKS');
  if([bookA,bookB].some(x=>x?.sequenceGap===true||x?.resyncRequired===true))reasons.push('BOOK_REQUIRES_RESYNC');
  if([bookA,bookB].some(x=>x?.providerTimestamp!=null&&(!timestamp(x.providerTimestamp)||x.providerTimestamp>now||now-x.providerTimestamp>maxAgeMs)))reasons.push('STALE_PROVIDER_TIMESTAMP');
  if(!feeModels)for(const fee of [feeA,feeB])if(finite(fee)===null||fee<0)reasons.push('FEES_UNAVAILABLE');
  const directions=[['YES','NO'],['NO','YES']].map(([sideA,sideB])=>{
    const levelsA=bookA?.[sideA.toLowerCase()]?.asks||[],levelsB=bookB?.[sideB.toLowerCase()]?.asks||[];
    const available=Math.min(levelsA.reduce((s,l)=>s+(finite(l.quantity)||0),0),levelsB.reduce((s,l)=>s+(finite(l.quantity)||0),0));
    const x=walkBook(levelsA,quantity),y=walkBook(levelsB,quantity);
    const fA=feeModels?takerFee(feeModels.a,x.fills):feeA,fB=feeModels?takerFee(feeModels.b,y.fills):feeB,feesKnown=finite(fA)!==null&&finite(fB)!==null&&fA>=0&&fB>=0;
    const capital=x.complete&&y.complete?x.cost+y.cost+(feesKnown?fA+fB:0):null;
    const blocked=[...new Set([...reasons,...(!x.complete||!y.complete?['INSUFFICIENT_DEPTH']:[]),...(feeModels&&!feesKnown?['FEES_UNAVAILABLE']:[])])];
    const legRisk=(label,entry,fee,book,side,model)=>{
      const exit=walkBook((book?.[side.toLowerCase()]?.bids||[]).map(l=>({...l,price:1-l.price})),entry.quantity||quantity);
      const fills=exit.fills.map(f=>({...f,price:1-f.price})),exitFee=model?takerFee(model,fills):null;
      const proceeds=fills.reduce((s,f)=>s+f.quantity*f.price,0);
      return {scenario:`${label}_FILLS_OTHER_REJECTS`,capitalAtRisk:finite(fee)===null?null:entry.cost+fee,
        observedImmediateUnwindPnl:exit.complete&&finite(fee)!==null&&exitFee!==null?proceeds-exitFee-entry.cost-fee:null,
        unwindGuaranteed:false,reason:'Available unwind depth may disappear before the hedge failure is known'};
    };
    return {sideA,sideB,quantity,availableExecutableSize:available,venueA:x,venueB:y,feeA:feesKnown?fA:null,feeB:feesKnown?fB:null,grossSpread:x.averagePrice!==null&&y.averagePrice!==null?1-x.averagePrice-y.averagePrice:null,
      effectiveSpread:capital!==null&&feesKnown?(quantity-capital)/quantity:null,capitalRequired:capital!==null&&feesKnown?capital:null,
      conditionalMatchedPayoff:!blocked.length?quantity-capital:null,theoreticalLockedReturn:null,
      outcomePayouts:!blocked.length?[{outcome:'A_YES',grossPayout:quantity,netPnl:quantity-capital},{outcome:'A_NO',grossPayout:quantity,netPnl:quantity-capital}]:null,
      capitalDurationMs:null,executionRisks:['NON_ATOMIC_FILLS','PARTIAL_FILL_OR_REJECTION','QUOTE_EXPIRY','VENUE_OUTAGE','VOID_OR_SETTLEMENT_DISAGREEMENT','FUNDING_AND_SETTLEMENT_DURATION_UNKNOWN'],
      failureScenarios:[legRisk('A',x,fA,bookA,sideA,feeModels?.a),legRisk('B',y,fB,bookB,sideB,feeModels?.b)],blocked,riskFree:false};
  });
  return {...match,directions,note:'Complementary positions require verified identical settlement terms. Cross-venue fills are not atomic; venue, execution and settlement risks remain.'};
}
