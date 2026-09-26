import { decimal, fingerprint, requiredText, timestamp, units } from './model.js';

const KINDS = ['DEPOSIT','WITHDRAWAL','BUY','SELL','FEE','SETTLEMENT','TRANSFER_IN','TRANSFER_OUT'];
export class UnifiedLedger {
  constructor(store) { this.store=store; }
  append(input) {
    return this.store.transaction(()=>this.appendWithinTransaction(input));
  }
  appendWithinTransaction(input) {
    const e={sourceKey:requiredText(input.sourceKey,'sourceKey'),at:input.at,mode:input.mode,venue:requiredText(input.venue,'venue'),account:requiredText(input.account,'account'),
      currency:requiredText(input.currency,'currency',16),kind:input.kind,instrumentId:input.instrumentId||null,strategyId:input.strategyId||null,eventId:input.eventId||null,
      quantity:decimal(units(input.quantity??'0',8),8),gross:decimal(units(input.gross??'0')),fee:decimal(units(input.fee??'0')),reference:requiredText(input.reference,'Source reference',2000)};
    if (!timestamp(e.at)||!['PAPER','LIVE'].includes(e.mode)||!KINDS.includes(e.kind)) throw new Error('Invalid ledger event');
    if (units(e.quantity,8)<0n||units(e.gross)<0n||units(e.fee)<0n) throw new Error('Ledger amounts must be nonnegative');
    if (['BUY','SELL','SETTLEMENT'].includes(e.kind)&&(!e.instrumentId||units(e.quantity,8)<=0n)) throw new Error('Fill requires instrument and positive quantity');
    const hash=fingerprint(e), prior=this.store.db.prepare('SELECT hash FROM ledger WHERE source_key=?').get(e.sourceKey);
    if(prior){if(prior.hash!==hash)throw new Error('Conflicting ledger event for source key');return {appended:false};}
    this.store.db.prepare('INSERT INTO ledger(source_key,hash,at,mode,venue,account,currency,kind,instrument_id,strategy_id,event_id,quantity_units,gross_units,fee_units,reference) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(e.sourceKey,hash,e.at,e.mode,e.venue,e.account,e.currency,e.kind,e.instrumentId,e.strategyId,e.eventId,String(units(e.quantity,8)),String(units(e.gross)),String(units(e.fee)),e.reference);
    if(this.portfolio(e.mode).accounts.some(a=>units(a.cash)<0n))throw new Error('Ledger would overdraw cash');
    return {appended:true};
  }
  entries({mode=null,limit=100}={}) { return this.store.db.prepare('SELECT * FROM ledger WHERE (? IS NULL OR mode=?) ORDER BY seq DESC LIMIT ?').all(mode,mode,Math.max(1,Math.min(1000,limit))).map(r=>({...r,quantity:decimal(r.quantity_units,8),gross:decimal(r.gross_units),fee:decimal(r.fee_units)})); }
  portfolio(mode='PAPER') {
    if(!['PAPER','LIVE'].includes(mode))throw new Error('Invalid portfolio mode');
    const accounts=new Map();
    for(const r of this.store.db.prepare('SELECT * FROM ledger WHERE mode=? ORDER BY seq').iterate(mode)) {
      const key=JSON.stringify([r.venue,r.account,r.currency]);
      const a=accounts.get(key)||{venue:r.venue,account:r.account,currency:r.currency,cash:0n,realized:0n,fees:0n,netDeposits:0n,positions:new Map(),daily:new Map(),closes:{n:0,wins:0,grossWin:0n,grossLoss:0n,best:null,bestAt:null,lastAt:null}};
      const gross=BigInt(r.gross_units),fee=BigInt(r.fee_units),qty=BigInt(r.quantity_units); let pnl=0n;
      if(['DEPOSIT','TRANSFER_IN'].includes(r.kind)){a.cash+=gross;a.netDeposits+=gross;}
      else if(['WITHDRAWAL','TRANSFER_OUT'].includes(r.kind)){a.cash-=gross;a.netDeposits-=gross;}
      else if(r.kind==='FEE'){a.cash-=gross;pnl-=gross;}
      else {
        const pk=JSON.stringify([r.instrument_id,r.strategy_id,r.event_id]);
        const p=a.positions.get(pk)||{instrumentId:r.instrument_id,strategyId:r.strategy_id,eventId:r.event_id,qty:0n,basis:0n};
        if(r.kind==='BUY'){p.qty+=qty;p.basis+=gross+fee;a.cash-=gross;}
        else {
          if(qty>p.qty)throw new Error(`Ledger oversell at ${r.source_key}`);
          const basis=qty===p.qty?p.basis:p.basis*qty/p.qty;
          p.qty-=qty;p.basis-=basis;a.cash+=gross;pnl+=gross-basis-fee;
          // Per-close tally for the scoreboard (same pnl as realized, nothing recomputed elsewhere).
          const c=gross-basis-fee,k=a.closes;k.n++;if(c>0n){k.wins++;k.grossWin+=c;}else k.grossLoss-=c;if(k.best===null||c>k.best){k.best=c;k.bestAt=r.at;}k.lastAt=r.at;
        }
        a.positions.set(pk,p);
      }
      a.cash-=fee;a.fees+=fee+(r.kind==='FEE'?gross:0n);
      if(!['BUY','SELL','SETTLEMENT'].includes(r.kind))pnl-=fee;
      a.realized+=pnl;
      const day=new Date(r.at).toISOString().slice(0,10);a.daily.set(day,(a.daily.get(day)||0n)+pnl);
      accounts.set(key,a);
    }
    return {mode,coverage:'CORE_LEDGER_ONLY',accounts:[...accounts.values()].map(a=>({venue:a.venue,account:a.account,currency:a.currency,cash:decimal(a.cash),realized:decimal(a.realized),fees:decimal(a.fees),netDeposits:decimal(a.netDeposits),daily:Object.fromEntries([...a.daily].map(([k,v])=>[k,decimal(v)])),
      closeStats:{closes:a.closes.n,wins:a.closes.wins,grossWin:decimal(a.closes.grossWin),grossLoss:decimal(a.closes.grossLoss),best:a.closes.best===null?null:decimal(a.closes.best),bestAt:a.closes.bestAt,lastCloseAt:a.closes.lastAt},
      positions:[...a.positions.values()].filter(p=>p.qty>0n).map(p=>({instrumentId:p.instrumentId,strategyId:p.strategyId,eventId:p.eventId,quantity:decimal(p.qty,8),costBasis:decimal(p.basis)}))}))};
  }
}
