import { finite, fingerprint, requiredText, timestamp } from './model.js';

export const DEFAULT_LIMITS = Object.freeze({ maxOrderUsd:25,maxPositionUsd:100,maxVenueUsd:250,maxStrategyUsd:150,maxEventUsd:100,maxTotalUsd:500,dailyLossUsd:25,maxDrawdownPct:20,maxConcurrentOrders:5,maxSlippageBps:100,maxQuoteAgeMs:15000,minLiquidityUsd:1 });
export function validateLimits(patch={}) {
  const out={...DEFAULT_LIMITS};
  for(const [k,v] of Object.entries(patch)){
    if(!(k in out)||finite(v)===null||Number(v)<=0)throw new Error(`Invalid risk limit: ${k}`);
    out[k]=Number(v);
  }
  if(out.maxDrawdownPct>100||!Number.isInteger(out.maxConcurrentOrders))throw new Error('Invalid risk limit range');
  return out;
}
export function evaluateRisk(order, context, {limits=DEFAULT_LIMITS,now=Date.now()}={}) {
  const reasons=[],warnings=[]; const reject=r=>reasons.push(r);
  if(context.halted)reject('GLOBAL_HALT');
  if(!['PAPER','MANUAL_APPROVAL','LIVE'].includes(order.mode))reject('INVALID_MODE');
  if(order.mode==='LIVE' && !context.liveAuthorized)reject('LIVE_NOT_AUTHORIZED');
  if(order.mode==='LIVE' && !context.reconciled)reject('PORTFOLIO_NOT_RECONCILED');
  if(!['BUY','SELL'].includes(order.side))reject('INVALID_SIDE');
  for(const k of ['venue','account','instrumentId','strategyId','eventId'])if(typeof order[k]!=='string'||!order[k].trim())reject(`MISSING_${k.toUpperCase()}`);
  for(const k of ['quantity','price','feeUsd','slippageBps','liquidityUsd'])if(finite(order[k])===null||Number(order[k])<0)reject(`INVALID_${k.toUpperCase()}`);
  if(!(order.quantity>0)||!(order.price>0))reject('INVALID_SIZE');
  if(!timestamp(order.quoteAt)||order.quoteAt>now||now-order.quoteAt>limits.maxQuoteAgeMs)reject('STALE_QUOTE');
  if(order.currency!=='USD')reject('UNSUPPORTED_RISK_CURRENCY');
  const notional=Number(order.quantity)*Number(order.price),cost=notional+Number(order.feeUsd);
  if(!Number.isFinite(cost))reject('INVALID_COST');
  if(cost>limits.maxOrderUsd)reject('ORDER_LIMIT');
  if(order.slippageBps>limits.maxSlippageBps)reject('SLIPPAGE_LIMIT');
  if(order.liquidityUsd<Math.max(notional,limits.minLiquidityUsd))reject('INSUFFICIENT_LIQUIDITY');
  if(context.pendingCount>=limits.maxConcurrentOrders)reject('CONCURRENT_ORDER_LIMIT');
  if(finite(context.dailyPnlUsd)===null||finite(context.drawdownPct)===null)reject('UNKNOWN_LOSS_STATE');
  if(context.dailyPnlUsd<=-limits.dailyLossUsd)reject('DAILY_LOSS_LIMIT');
  if(context.drawdownPct>=limits.maxDrawdownPct)reject('DRAWDOWN_LIMIT');
  if(order.side==='BUY'){
    if(finite(context.cashUsd)===null||context.cashUsd<cost)reject('INSUFFICIENT_CASH');
    for(const [key,limit] of [['positionUsd','maxPositionUsd'],['venueUsd','maxVenueUsd'],['strategyUsd','maxStrategyUsd'],['eventUsd','maxEventUsd'],['totalUsd','maxTotalUsd']]){
      const exposure=finite(context[key]);
      if(exposure===null)reject(`UNKNOWN_${key.toUpperCase()}`);
      else if(exposure+cost>limits[limit])reject(limit.toUpperCase());
      else if(exposure+cost>=limits[limit]*.8)warnings.push(`${key}: approaching limit`);
    }
  } else if(finite(context.heldQuantity)===null||order.quantity>context.heldQuantity)reject('OVERSELL');
  return {allowed:reasons.length===0,state:context.halted?'HALTED':reasons.length?'RED':warnings.length?'YELLOW':'GREEN',reasons,warnings,notionalUsd:Number.isFinite(notional)?notional:null,costUsd:Number.isFinite(cost)?cost:null,evaluatedAt:now};
}

export class RiskGovernor {
  constructor(store,ledger,bus){this.store=store;this.ledger=ledger;this.bus=bus;}
  state(){const r=this.store.db.prepare('SELECT * FROM risk_control WHERE id=1').get();return {state:r.halted?'HALTED':'GREEN',halted:!!r.halted,reason:r.reason,changedAt:r.changed_at,mode:'PAPER',liveAvailable:false,limits:validateLimits(JSON.parse(r.limits_json))};}
  halt(reason='Emergency stop requested'){
    requiredText(reason,'Halt reason',300);
    this.store.transaction(()=>{this.store.db.prepare('UPDATE risk_control SET halted=1,reason=?,changed_at=? WHERE id=1').run(reason,Date.now());this.store.record('RISK_STATE_CHANGED',{state:'HALTED',reason});});
    this.bus.publish('RISK_STATE_CHANGED',{state:'HALTED',reason});return this.state();
  }
  resumePaper(confirmation){
    if(confirmation!=='RESUME PAPER TRADING')throw new Error('Explicit RESUME PAPER TRADING confirmation required');
    this.store.transaction(()=>{this.store.db.prepare('UPDATE risk_control SET halted=0,reason=NULL,changed_at=? WHERE id=1').run(Date.now());this.store.record('RISK_STATE_CHANGED',{state:'GREEN',mode:'PAPER'});});
    this.bus.publish('RISK_STATE_CHANGED',{state:'GREEN',mode:'PAPER'});return this.state();
  }
  setLimits(patch){const limits=validateLimits({...this.state().limits,...patch});this.store.db.prepare('UPDATE risk_control SET limits_json=?,changed_at=? WHERE id=1').run(JSON.stringify(limits),Date.now());this.store.record('RISK_LIMITS_CHANGED',limits);return this.state();}
  context(order,now=Date.now()){
    const portfolio=this.ledger.portfolio(order.mode==='LIVE'?'LIVE':'PAPER');
    const rows=portfolio.accounts.filter(a=>a.currency==='USD'),account=rows.find(a=>a.venue===order.venue&&a.account===order.account);
    const positions=rows.flatMap(a=>a.positions.map(p=>({...p,venue:a.venue,account:a.account})));
    const pending=this.store.db.prepare("SELECT payload FROM proposals WHERE status IN ('APPROVED','SUBMITTING','UNCERTAIN')").all().map(r=>JSON.parse(r.payload)).filter(p=>(p.mode==='LIVE')===(order.mode==='LIVE'));
    const sum=(filter)=>positions.filter(filter).reduce((s,p)=>s+Number(p.costBasis),0)+pending.filter(p=>p.side==='BUY'&&filter(p)).reduce((s,p)=>s+p.quantity*p.price+p.feeUsd,0);
    const day=new Date(now).toISOString().slice(0,10),dailyPnlUsd=rows.reduce((s,a)=>s+Number(a.daily[day]||0),0);
    const deposits=rows.reduce((s,a)=>s+Number(a.netDeposits),0),realized=rows.reduce((s,a)=>s+Number(a.realized),0);
    // Until mark-to-market / account reconciliation is available, this is a conservative
    // realized-loss drawdown proxy for PAPER only. LIVE always fails reconciliation.
    return {halted:this.state().halted,liveAuthorized:false,reconciled:false,cashUsd:account?Number(account.cash)-pending.filter(p=>p.venue===order.venue&&p.account===order.account&&p.side==='BUY').reduce((s,p)=>s+p.quantity*p.price+p.feeUsd,0):null,
      heldQuantity:account?account.positions.filter(p=>p.instrumentId===order.instrumentId&&p.strategyId===order.strategyId&&p.eventId===order.eventId).reduce((s,p)=>s+Number(p.quantity),0)-pending.filter(p=>p.side==='SELL'&&p.venue===order.venue&&p.account===order.account&&p.instrumentId===order.instrumentId&&p.strategyId===order.strategyId&&p.eventId===order.eventId).reduce((s,p)=>s+p.quantity,0):0,
      positionUsd:sum(p=>p.instrumentId===order.instrumentId),venueUsd:sum(p=>p.venue===order.venue),strategyUsd:sum(p=>p.strategyId===order.strategyId),eventUsd:sum(p=>p.eventId===order.eventId),totalUsd:sum(()=>true),pendingCount:pending.length,dailyPnlUsd,drawdownPct:deposits>0?Math.max(0,-realized/deposits*100):0};
  }
  evaluate(order,now=Date.now()){return evaluateRisk(order,this.context(order,now),{limits:this.state().limits,now});}
  propose(order){
    const id=requiredText(order.id,'Order ID',100),payload={...order};const hash=fingerprint(payload);
    return this.store.transaction(()=>{
      const prior=this.store.db.prepare('SELECT * FROM proposals WHERE id=?').get(id);
      if(prior){if(prior.hash!==hash)throw new Error('Order ID reused with different terms');return {id,status:prior.status,decision:JSON.parse(prior.decision),order:JSON.parse(prior.payload)};}
      const decision=this.evaluate(payload),status=decision.allowed?(order.mode==='MANUAL_APPROVAL'?'AWAITING_APPROVAL':'PROPOSED'):'REJECTED',now=Date.now();
      this.store.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(id,hash,status,now,now,JSON.stringify(payload),JSON.stringify(decision));
      this.store.record(status==='REJECTED'?'ORDER_REJECTED':'ORDER_PROPOSED',{id,decision});
      return {id,status,decision,order:payload};
    });
  }
}
