import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreDatabase } from './database.js';
import { UnifiedLedger } from './ledger.js';
import { MarketEventBus } from './eventBus.js';
import { RiskGovernor } from './risk.js';
import { ProviderRegistry } from './provider.js';
import { KalshiProvider,PolymarketProvider } from './predictionProviders.js';
import { arbitrageQuote,walkBook } from './contracts.js';
import { decimal,finite,fingerprint,stableId,units } from './model.js';
import { appendProjectJournal } from '../projectJournal.js';
import { activateExecutionBoundary } from './executionBoundary.js';
import { StrategyRegistry } from './strategies.js';
import { legacyCoverage } from './legacyBooks.js';
import { syncLabChampions } from './labSync.js';

export class MarketPlatform {
  constructor({file=':memory:',dataDir=null,providers=null}={}){
    this.store=new CoreDatabase(file);this.ledger=new UnifiedLedger(this.store);this.bus=new MarketEventBus();this.risk=new RiskGovernor(this.store,this.ledger,this.bus);this.strategies=new StrategyRegistry(this.store);this.legacyReaders={};this.dataDir=dataDir;
    this.providers=providers||new ProviderRegistry();if(!providers){this.providers.register(new KalshiProvider());this.providers.register(new PolymarketProvider());}
    this.journalError=null;
    if(dataDir)this.bus.on('RISK_STATE_CHANGED',event=>{
      try{appendProjectJournal(path.join(dataDir,'project-journal.ndjson'),{kind:'risk',title:`Risk Governor: ${event.data.state}`,detail:event.data.reason||'Paper execution resumed',at:event.at});}
      catch(e){this.journalError='Could not append risk milestone';throw e;}
    });
  }
  snapshot(){
    return {at:Date.now(),risk:this.risk.state(),providers:this.providers.status(),database:this.store.health(),eventBus:this.bus.snapshot(),journalError:this.journalError,
      strategies:this.strategies.list(),legacy:legacyCoverage(this.legacyReaders),labSync:this.labSync||null,portfolio:this.ledger.portfolio(),livePortfolio:this.ledger.portfolio('LIVE'),ledger:this.ledger.entries(),events:this.store.events(),
      watchlist:this.store.db.prepare('SELECT * FROM watchlist ORDER BY added_at DESC').all(),proposals:this.store.db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 100').all().map(r=>({...r,payload:JSON.parse(r.payload),decision:JSON.parse(r.decision)})),
      coverage:{legacyBooks:'READ_ONLY_VIEW_NOT_IN_LEDGER',liveAccounts:'NOT_RECONCILED',riskValuation:'PAPER_COST_BASIS_AND_REALIZED_LOSS',note:'Core accounts are reconstructed from this ledger only. Existing Solana, Robinhood, and US Combo books remain in their original programs; they are shown read-only under Legacy books and are not included in these totals.'}};
  }
  async markets(venue,query={}){
    const result=await this.providers.get(venue).markets(query);
    for(const market of result.markets)this.store.put(market);
    return result;
  }
  async contract(venue,id){const c=await this.providers.get(venue).market(id);this.store.put(c);return c;}
  async book(venue,id){const contract=await this.contract(venue,id),book=await this.providers.get(venue).book(id,contract);
    this.store.put({kind:'OrderBook',provider:venue,sourceId:id,data:book,observedAt:book.observedAt,availableAt:book.observedAt});
    this.bus.publish('ORDERBOOK_UPDATED',{contractId:contract.id,observedAt:book.observedAt});return {contract,book};}
  watch(id,on){if(!this.store.get(id))throw new Error('Unknown instrument');if(on)this.store.db.prepare('INSERT OR IGNORE INTO watchlist VALUES(?,?)').run(id,Date.now());else this.store.db.prepare('DELETE FROM watchlist WHERE entity_id=?').run(id);return {ok:true};}
  deposit({venue,amount,id}){
    this.providers.get(venue);const n=units(amount);if(n<=0n||n>1000000000000n)throw new Error('Paper funding must be between 0 and 1,000,000 USD');
    const sourceKey=`paper-deposit:${id||randomUUID()}`,prior=this.store.db.prepare('SELECT * FROM ledger WHERE source_key=?').get(sourceKey);
    if(prior){if(prior.venue!==venue||prior.gross_units!==String(n))throw new Error('Funding ID reused');return this.ledger.portfolio();}
    this.store.transaction(()=>{this.ledger.append({sourceKey,at:Date.now(),mode:'PAPER',venue,account:'manual',currency:'USD',kind:'DEPOSIT',gross:amount,reference:'User-authorized simulated funding'});this.store.record('PAPER_FUNDED',{venue,amount:String(amount)});});
    return this.ledger.portfolio();
  }
  async propose(input){
    if(!['PAPER','MANUAL_APPROVAL'].includes(input.mode))throw new Error('Live execution is unavailable until account reconciliation and live adapter certification');
    if(!['YES','NO'].includes(input.outcome)||!['BUY','SELL'].includes(input.side))throw new Error('Invalid order side/outcome');
    const quantity=finite(input.quantity),feeBps=finite(input.feeBps);
    if(quantity===null||quantity<=0||!Number.isSafeInteger(quantity)||quantity>100000)throw new Error('Quantity must be a positive whole contract count');
    if(feeBps===null||feeBps<0||feeBps>10000)throw new Error('Explicit modeled fee (0–10000 bps) required');
    const {contract,book}=await this.book(input.venue,input.sourceId);
    if(!['OPEN','ACTIVE'].includes(contract.data.status)||contract.data.closeAt!==null&&contract.data.closeAt<=Date.now())throw new Error('Market is not open for paper execution');
    const side=book[input.outcome.toLowerCase()],levels=input.side==='BUY'?side.asks:side.bids;
    // walkBook buys lowest asks. Selling uses the reciprocal so highest bids fill first.
    const quote=walkBook(input.side==='BUY'?levels:levels.map(l=>({...l,price:1-l.price})),quantity);
    if(!quote.complete||quote.averagePrice===null)throw new Error('Insufficient observed order-book depth');
    const price=input.side==='BUY'?quote.averagePrice:1-quote.averagePrice;
    const top=levels[0]?.price;const slippageBps=top>0?Math.abs(price/top-1)*10000:null;
    const gross=decimal(BigInt(Math.ceil(quantity*price*1e6))),fee=decimal(BigInt(Math.ceil(Number(gross)*feeBps/10000*1e6)));
    const payload={id:input.id||randomUUID(),mode:input.mode,venue:input.venue,account:'manual',currency:'USD',instrumentId:stableId('Instrument',input.venue,`${input.sourceId}:${input.outcome}`),
      contractId:contract.id,sourceId:input.sourceId,outcome:input.outcome,eventId:contract.data.eventId||contract.id,strategyId:'manual',side:input.side,quantity,price,feeUsd:Number(fee),gross,fee,
      slippageBps,liquidityUsd:levels.reduce((s,l)=>s+l.price*l.quantity,0),quoteAt:Math.min(book.observedAt,book.providerTimestamp??book.observedAt),bookFingerprint:fingerprint(book),feeModel:{kind:'USER_MODELED_BPS',bps:feeBps},simulated:true};
    const result=this.risk.propose(payload);this.bus.publish(result.status==='REJECTED'?'ORDER_REJECTED':'ORDER_PROPOSED',{id:result.id,status:result.status});return result;
  }
  executePaper(id,confirmation){
    const result=this.store.transaction(()=>{
      const row=this.store.db.prepare('SELECT * FROM proposals WHERE id=?').get(id);if(!row)throw new Error('Unknown proposal');
      const order=JSON.parse(row.payload);
      if(row.status==='FILLED')return {id,status:'FILLED',duplicate:true};
      if(!['PROPOSED','AWAITING_APPROVAL'].includes(row.status))throw new Error('Proposal is not executable');
      if(!['PAPER','MANUAL_APPROVAL'].includes(order.mode))throw new Error('Paper executor cannot dispatch live orders');
      if(confirmation!=='EXECUTE PAPER ORDER')throw new Error('Explicit EXECUTE PAPER ORDER confirmation required');
      const decision=this.risk.evaluate(order);
      if(!decision.allowed){this.store.db.prepare('UPDATE proposals SET status=?,decision=?,updated_at=? WHERE id=?').run('REJECTED',JSON.stringify(decision),Date.now(),id);this.store.record('ORDER_REJECTED',{id,decision});return {id,status:'REJECTED',decision};}
      // The same observed depth cannot be consumed by multiple simulated fills.
      const used=this.store.db.prepare("SELECT payload FROM proposals WHERE status='FILLED'").all().some(r=>{const p=JSON.parse(r.payload);return p.bookFingerprint===order.bookFingerprint&&p.instrumentId===order.instrumentId&&p.side===order.side;});
      if(used)throw new Error('Book snapshot already consumed; request a fresh preview');
      this.ledger.append({sourceKey:`paper-fill:${id}`,at:Date.now(),mode:'PAPER',venue:order.venue,account:order.account,currency:order.currency,kind:order.side,instrumentId:order.instrumentId,strategyId:order.strategyId,eventId:order.eventId,quantity:String(order.quantity),gross:order.gross,fee:order.fee,reference:`Simulated depth fill; proposal ${id}; modeled fee ${order.feeModel.bps} bps`});
      this.store.db.prepare("UPDATE proposals SET status='FILLED',decision=?,updated_at=? WHERE id=?").run(JSON.stringify(decision),Date.now(),id);this.store.record('ORDER_FILLED',{id,mode:'PAPER',simulated:true});
      return {id,status:'FILLED',simulated:true,order};
    });
    this.bus.publish(result.status==='FILLED'?'ORDER_FILLED':'ORDER_REJECTED',result);return result;
  }
  async compare({a,b,quantity=1}){const [left,right]=await Promise.all([this.book(a.venue,a.sourceId),this.book(b.venue,b.sourceId)]);return {a:left.contract,b:right.contract,...arbitrageQuote(left.contract.data,right.contract.data,left.book,right.book,{quantity:Number(quantity)})};}
  transitionStrategy({id,to,reason,evidence=null}){
    const r=this.strategies.transition(id,to,{reason,evidence});
    if(this.dataDir)try{appendProjectJournal(path.join(this.dataDir,'project-journal.ndjson'),{kind:'strategy',title:`Strategy ${r.promoted?'promoted':'moved'}: ${r.name} → ${to}`,detail:reason,at:Date.now()});}catch{this.journalError='Could not append strategy milestone';}
    return r;
  }
  // Mirrors Evolution Lab champions into the strategy registry through the common gate.
  syncLab(labLinkDir=this.dataDir&&path.join(this.dataDir,'lab-link')){
    if(!labLinkDir)return [];
    const out=syncLabChampions(this.strategies,labLinkDir,{transition:(id,to,{reason,evidence})=>this.transitionStrategy({id,to,reason,evidence})});
    this.labSync={at:Date.now(),results:out};return out;
  }
  // Sync, read-only accessors supplied by the host (dashboard). Keys: solana, robinhoodPractice, usCombos.
  setLegacyReaders(readers={}){this.legacyReaders={...readers};}
  close(){this.store.close();}
}
let platform;
export function marketPlatform(){activateExecutionBoundary();if(!platform){const dataDir=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');platform=new MarketPlatform({file:path.join(dataDir,'mpos-core.sqlite'),dataDir});}return platform;}
// Release the SQLite handle (Windows keeps open files locked). The execution boundary stays active.
export function closeMarketPlatform(){if(!platform)return;try{platform.close();}finally{platform=undefined;}}
