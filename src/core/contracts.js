import { finite, probability, timestamp } from './model.js';

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
  sorted.sort((a,b)=>a.price-b.price);let remaining=requested,cost=0;
  for(const l of sorted){const take=Math.min(remaining,l.quantity);cost+=take*l.price;remaining-=take;if(remaining<=1e-9)break;}
  const filled=requested-remaining,average=filled?cost/filled:null,top=sorted.find(l=>l.quantity>0)?.price;
  return {quantity:filled,cost,averagePrice:average,slippageBps:average!==null&&top>0?(average/top-1)*10000:null,complete:remaining<=1e-9};
}
export function arbitrageQuote(a,b,bookA,bookB,{quantity=1,feeA=null,feeB=null,now=Date.now(),maxAgeMs=15000}={}) {
  const match=compareContracts(a,b),reasons=[];
  if(a.venue===b.venue)reasons.push('SAME_VENUE');
  if(match.classification!=='EXACT MATCH')reasons.push('SETTLEMENT_NOT_VERIFIED_EQUIVALENT');
  if(!timestamp(bookA?.observedAt)||!timestamp(bookB?.observedAt)||[bookA,bookB].some(x=>x.observedAt>now||now-x.observedAt>maxAgeMs))reasons.push('STALE_BOOK');
  for(const fee of [feeA,feeB])if(finite(fee)===null||fee<0)reasons.push('FEES_UNAVAILABLE');
  const directions=[['YES','NO'],['NO','YES']].map(([sideA,sideB])=>{
    const levelsA=bookA?.[sideA.toLowerCase()]?.asks||[],levelsB=bookB?.[sideB.toLowerCase()]?.asks||[];
    const available=Math.min(levelsA.reduce((s,l)=>s+(finite(l.quantity)||0),0),levelsB.reduce((s,l)=>s+(finite(l.quantity)||0),0));
    const x=walkBook(levelsA,quantity),y=walkBook(levelsB,quantity),feesKnown=finite(feeA)!==null&&finite(feeB)!==null&&feeA>=0&&feeB>=0;
    const capital=x.complete&&y.complete?x.cost+y.cost+(feesKnown?feeA+feeB:0):null;
    const blocked=[...new Set([...reasons,...(!x.complete||!y.complete?['INSUFFICIENT_DEPTH']:[])])];
    return {sideA,sideB,quantity,availableExecutableSize:available,venueA:x,venueB:y,grossSpread:x.averagePrice!==null&&y.averagePrice!==null?1-x.averagePrice-y.averagePrice:null,
      effectiveSpread:capital!==null&&feesKnown?(quantity-capital)/quantity:null,capitalRequired:capital!==null&&feesKnown?capital:null,
      theoreticalLockedReturn:!blocked.length?quantity-capital:null,blocked,riskFree:false};
  });
  return {...match,directions,note:'Complementary positions require verified identical settlement terms. Cross-venue fills are not atomic; venue, execution and settlement risks remain.'};
}
