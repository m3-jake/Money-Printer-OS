// Read-only Alpaca IEX observations for the independent Form 4 paper lane.
import { marketState, etDate } from './robinhoodEquitiesCalendar.js';
import { sellFees, FEES } from './robinhoodEquitiesBook.js';
import { validSymbol } from './robinhoodEquitiesData.js';
const keys = env => ({ id: env.ALPACA_KEY_ID || env.APCA_API_KEY_ID, secret: env.ALPACA_SECRET_KEY || env.APCA_API_SECRET_KEY });
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
export function normalizeDisclosureCorporateActions(payload, { symbol, heldSince, through } = {}) {
  const groups = payload?.corporate_actions;
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return { complete: false, reason: 'CORPORATE_ACTION_RESPONSE_UNAVAILABLE', actions: [] };
  const actions = [], unsupported = [];
  for (const [type, rows] of Object.entries(groups)) {
    if (!Array.isArray(rows)) return { complete: false, reason: 'CORPORATE_ACTION_RESPONSE_SCHEMA', actions: [] };
    for (const r of rows) {
      if (String(r.symbol || r.initiating_symbol || '').toUpperCase() !== symbol) { unsupported.push('MISMATCHED_SYMBOL'); continue; }
      const exDate = r.ex_date;
      if (!dateRe.test(String(exDate))) { unsupported.push('UNKNOWN_EFFECTIVE_DATE'); continue; }
      if (exDate <= heldSince || exDate > through) continue;
      if (!r.id) { unsupported.push('MISSING_ACTION_ID'); continue; }
      if (['forward_splits','reverse_splits'].includes(type)) {
        const ratio = Number(r.new_rate) / Number(r.old_rate);
        if (!(Number(r.old_rate) > 0) || !(Number(r.new_rate) > 0) || !Number.isFinite(ratio)) { unsupported.push('INCOMPLETE_SPLIT'); continue; }
        if(r.due_bill_redemption_date){unsupported.push('DUE_BILL_SPLIT');continue}
        actions.push({ id: r.id, type: 'SPLIT', symbol, exDate, ratio, source: 'alpaca-corporate-actions' });
      } else if (type === 'cash_dividends') {
        const amountPerShare = Number(r.rate ?? r.cash), payableDate = r.payable_date;
        if (!['USD','US'].includes(r.currency || 'USD') || !(amountPerShare >= 0) || !Number.isFinite(amountPerShare) || !dateRe.test(String(payableDate)) || payableDate < exDate) { unsupported.push('INCOMPLETE_OR_NON_USD_DIVIDEND'); continue; }
        // Due-bill distributions require more ownership rules than the ordinary ex-date model.
        if (r.foreign===true||r.special===true||r.due_bill_redemption_date||r.due_bill_on_date||r.due_bill_off_date) { unsupported.push('FOREIGN_SPECIAL_OR_DUE_BILL_DIVIDEND'); continue; }
        actions.push({ id: r.id, type: 'CASH_DIVIDEND', symbol, exDate, payableDate, amountPerShare, source: 'alpaca-corporate-actions' });
      } else unsupported.push(type);
    }
  }
  actions.sort((a,b)=>a.exDate.localeCompare(b.exDate)||a.id.localeCompare(b.id));
  return { complete: unsupported.length === 0, reason: unsupported.length ? `UNSUPPORTED_CORPORATE_ACTION:${[...new Set(unsupported)].join(',')}` : null, actions };
}
export function createDisclosureEquityQuoteAdapter({ env = process.env, fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  const actionCache = new Map(); let health = { status: 'IDLE', reason: null };
  async function get(url) {
    const k=keys(env); if (!k.id || !k.secret) throw Object.assign(new Error('Set ALPACA_KEY_ID and ALPACA_SECRET_KEY for provider-labeled equity quotes'), { code:'ALPACA_KEYS_REQUIRED' });
    const r=await fetchImpl(url.toString(),{method:'GET',headers:{'APCA-API-KEY-ID':k.id,'APCA-API-SECRET-KEY':k.secret,accept:'application/json'},signal:AbortSignal.timeout?.(10000)});
    if(!r.ok)throw Object.assign(new Error(`Alpaca market data HTTP ${r.status}`),{code:r.status===401||r.status===403?'ALPACA_AUTH_OR_ENTITLEMENT_REQUIRED':r.status===429?'ALPACA_RATE_LIMITED':'ALPACA_DATA_UNAVAILABLE'});
    return r.json();
  }
  async function actions(symbol, from, through, now) {
    const key=`${symbol}|${from}|${through}`,hit=actionCache.get(key);
    if(hit&&now>=hit.at&&now-hit.at<5*60000)return hit.value;
    const merged={corporate_actions:{}},seen=new Set();let token=null;
    for(let page=0;page<10;page++){
      const u=new URL('https://data.alpaca.markets/v1/corporate-actions');u.searchParams.set('symbols',symbol);u.searchParams.set('start',from);u.searchParams.set('end',through);u.searchParams.set('limit','1000');u.searchParams.set('data_quality','all');if(token)u.searchParams.set('page_token',token);
      const j=await get(u);if(!j?.corporate_actions||typeof j.corporate_actions!=='object')throw Object.assign(new Error('Corporate action coverage schema unavailable'),{code:'CORPORATE_ACTION_COVERAGE_REQUIRED'});
      for(const [type,rows]of Object.entries(j.corporate_actions)){if(!Array.isArray(rows))throw new Error('Invalid corporate action rows');(merged.corporate_actions[type]||=[]).push(...rows)}
      token=j.next_page_token||null;if(!token){if(actionCache.size>100)actionCache.clear();actionCache.set(key,{at:now,value:merged});return merged}
      if(seen.has(token))break;seen.add(token);
    }
    throw Object.assign(new Error('Incomplete corporate action pagination'),{code:'CORPORATE_ACTION_PAGINATION_REQUIRED'});
  }
  async function quote(symbol,{side='BUY',quantity=0,position=null,now=clock()}={}) {
    const sym=String(symbol).toUpperCase();if(!validSymbol(sym))throw new Error('Valid equity symbol required');
    const session=marketState(now),base={symbol:sym,provider:'alpaca-iex',assetClass:'equity',session:session.state==='OPEN'?'REGULAR_OPEN':session.state,feeModelVersion:'equity-pass-through-2026-09-26',feeEvidence:FEES.source};
    if(session.state!=='OPEN')return {...base,waitReason:'WAITING_FOR_REGULAR_SESSION'};
    try{
      const u=new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(sym)}/quotes/latest`);u.searchParams.set('feed','iex');
      const j=await get(u),r=j.quote,at=Date.parse(r?.t||'');
      if(j.symbol&&j.symbol!==sym)throw Object.assign(new Error('Alpaca returned a different equity instrument'),{code:'MATCHING_EQUITY_INSTRUMENT_REQUIRED'});
      const out={...base,bid:Number(r?.bp),ask:Number(r?.ap),bidSize:Number(r?.bs),askSize:Number(r?.as),observedAt:Number.isFinite(at)?at:null,receivedAt:clock(),fractional:true,quantityStep:.000001,
        depthPolicy:'Conservative shares capped at reported round-lot count; IEX only, not consolidated NBBO',corporateActionsVerified:true,corporateActions:[],corporateActionCoverage:'CURRENT_DAY_RAW_QUOTE_NO_PRIOR_EXPOSURE'};
      // An entry/current-session position has no earlier share basis to adjust. Carrying shares
      // across sessions needs provider corporate-action coverage and explicit action accounting.
      if(position&&etDate(position.openedAt)<etDate(now)){
        const from=new Date(position.openedAt-14*86400000).toISOString().slice(0,10),through=new Date(now+14*86400000).toISOString().slice(0,10);
        let checked;try{checked=normalizeDisclosureCorporateActions(await actions(sym,from,through,now),{symbol:sym,heldSince:etDate(position.openedAt),through:etDate(now)})}catch(e){out.corporateActionsVerified=false;out.waitReason=e.code||'CORPORATE_ACTION_COVERAGE_REQUIRED';checked={complete:false,actions:[]}}
        out.corporateActionsVerified=checked.complete;out.corporateActions=checked.actions;out.corporateActionCoverage=checked.complete?'PROVIDER_OBSERVED_HELD_INTERVAL':'UNAVAILABLE';out.waitReason||=checked.reason;
      }
      const already=new Set((position?.corporateActions||[]).map(a=>a.id));
      const adjustedQuantity=(out.corporateActions||[]).filter(a=>a.type==='SPLIT'&&!already.has(a.id)).reduce((qty,a)=>qty*a.ratio,Number(quantity)||0);
      out.quantityAfterActions=adjustedQuantity;const fees=side==='SELL'?sellFees(adjustedQuantity*out.bid,adjustedQuantity):{sec:0,taf:0};out.feeUsd=fees.sec+fees.taf;
      health={status:'CONNECTED',reason:out.waitReason||null,lastSuccess:clock()};return out;
    }catch(e){health={status:'WAITING',reason:e.code||'EQUITY_QUOTE_UNAVAILABLE'};throw e}
  }
  return {quote,status(){const k=keys(env);return {provider:'alpaca-iex',...health,configured:!!(k.id&&k.secret),paperOnly:true,ordersSubmitted:0}}};
}
