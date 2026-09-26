import { finite, timestamp } from './model.js';

// USD is an explicit reporting scope. Other currencies remain separate until a timestamped
// conversion source is supplied. Cost basis is never substituted for an unavailable mark.
export function valuePortfolio(portfolio, marks, { now = Date.now(), maxAgeMs = 15000 } = {}) {
  const excludedAccounts = portfolio.accounts.filter(a => a.currency !== 'USD').map(a => ({ venue:a.venue, account:a.account, currency:a.currency, reason:'NO_VERIFIED_FX_CONVERSION' }));
  const accounts = portfolio.accounts.filter(a => a.currency === 'USD');
  const limitations = [], positions = [];
  let cash = 0, marketValue = 0, basis = 0, netDeposits = 0;
  for (const a of accounts) {
    cash += Number(a.cash); netDeposits += Number(a.netDeposits);
    for (const p of a.positions) {
      const qty = Number(p.quantity), cost = Number(p.costBasis);
      const m = marks.get(JSON.stringify([a.venue,a.account,p.instrumentId]));
      const totalQty = a.positions.filter(x => x.instrumentId === p.instrumentId).reduce((s,x) => s+Number(x.quantity),0);
      let reason = !m ? 'MISSING_LIQUIDATION_MARK' : !timestamp(m.at)||m.at>now||now-m.at>maxAgeMs ? 'STALE_LIQUIDATION_MARK' : m.quantity+1e-8<totalQty ? 'INSUFFICIENT_LIQUIDATION_DEPTH' : null;
      if (!reason && (finite(m.bid)===null||m.bid<0||finite(m.liquidationFee)===null||m.liquidationFee<0)) reason='UNKNOWN_LIQUIDATION_COST';
      const value = reason ? null : Math.max(0,qty*m.bid-m.liquidationFee*qty/m.quantity);
      if (reason) limitations.push({venue:a.venue,account:a.account,instrumentId:p.instrumentId,reason});
      else marketValue += value;
      basis += cost;
      positions.push({...p,venue:a.venue,account:a.account,marketValue:value,exposureUsd:value===null?null:Math.max(cost,value),markAt:m?.at??null,limitation:reason});
    }
  }
  const complete = limitations.length===0;
  return {scope:'CORE_LEDGER_USD',complete,consolidatedComplete:complete&&!excludedAccounts.length,excludedAccounts,limitations,positions,cashUsd:cash,netDepositsUsd:netDeposits,
    marketValueUsd:complete?marketValue:null,equityUsd:complete?cash+marketValue:null,unrealizedPnlUsd:complete?marketValue-basis:null};
}

// Unitized high water: external flows purchase/redeem units at the observed pre-flow NAV.
// Deposits cannot erase an existing percentage drawdown. No historical mark path is invented.
export function advanceValuation(previous, valuation, { now=Date.now(), realizedToday=0, ledgerSeq=0 }={}) {
  if (!valuation.complete) return { state:previous, metrics:{...valuation,dailyPnlUsd:null,drawdownPct:null,method:'UNITIZED_MARKED_EQUITY_V1'} };
  const equity=valuation.equityUsd, deposits=valuation.netDepositsUsd, day=new Date(now).toISOString().slice(0,10);
  let units=previous?.units??Math.max(0,deposits), nav=1, high=previous?.highNav??1;
  const flow=previous?deposits-previous.netDeposits:0;
  if (previous && units>0) {
    nav=(equity-flow)/units;
    if (flow && nav>0) units+=flow/nav;
    else if (flow) return {state:previous,metrics:{...valuation,dailyPnlUsd:null,drawdownPct:null,method:'UNITIZED_MARKED_EQUITY_V1',limitations:[...valuation.limitations,{reason:'CASH_FLOW_WITHOUT_POSITIVE_NAV'}]}};
  } else if (previous) {
    // Redeeming the last unit does not start a new performance epoch. Keep its NAV while
    // empty, and price a later deposit at that NAV instead of erasing the prior drawdown.
    nav=previous.nav;
    if (flow && nav>0 && flow>=0 && Math.abs(equity-flow)<1e-7) units=flow/nav;
    else if (flow || Math.abs(equity)>1e-7) return {state:previous,metrics:{...valuation,dailyPnlUsd:null,drawdownPct:null,method:'UNITIZED_MARKED_EQUITY_V1',limitations:[...valuation.limitations,{reason:'CASH_FLOW_WITHOUT_POSITIVE_NAV'}]}};
  } else if (units>0) nav=equity/units;
  else if (equity>0) { units=equity; nav=1; }
  if (!Number.isFinite(nav)||nav<0||units<0) throw new Error('Invalid marked equity state');
  high=Math.max(high,nav);
  // At migration there is no midnight marked snapshot. Charge observed open losses conservatively;
  // after the first UTC rollover use the previous complete mark as the daily boundary.
  const sameDay=previous?.day===day;
  const dayEquity=sameDay?previous.dayEquity:previous?previous.equity:equity-realizedToday-Math.min(0,valuation.unrealizedPnlUsd);
  const dayDeposits=sameDay?previous.dayDeposits:previous?previous.netDeposits:deposits;
  const state={units,nav,highNav:high,equity,netDeposits:deposits,day,dayEquity,dayDeposits,at:now,ledgerSeq,startedAt:previous?.startedAt??now};
  return {state,metrics:{...valuation,dailyPnlUsd:equity-dayEquity-(deposits-dayDeposits),drawdownPct:high>0?Math.max(0,(high-nav)/high*100):null,
    nav,highWaterNav:high,method:'UNITIZED_MARKED_EQUITY_V1',cashFlowRule:'FLOWS_AT_OBSERVED_PRE_FLOW_NAV',historySince:state.startedAt,
    dailyBoundary:previous?'LAST_COMPLETE_OBSERVATION_AT_UTC_ROLLOVER':'CONSERVATIVE_MIGRATION_BASELINE'}};
}
