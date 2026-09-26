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
import { extractTerms,matchTerms,termsFingerprint,candidatePairs } from './contractTerms.js';
import { describeFeeModel,takerFee } from './fees.js';

export const VERIFY_PHRASE='I READ BOTH RULE TEXTS AND THEY SETTLE IDENTICALLY';
const swapSides=book=>({...book,yes:book.no,no:book.yes});

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
    // feeBps is optional: blank means the venue's published taker-fee schedule (fees.js).
    const quantity=finite(input.quantity),feeBps=input.feeBps===undefined||input.feeBps===null||input.feeBps===''?null:finite(input.feeBps);
    if(quantity===null||quantity<=0||!Number.isSafeInteger(quantity)||quantity>100000)throw new Error('Quantity must be a positive whole contract count');
    if(feeBps!==null&&(feeBps<0||feeBps>10000))throw new Error('Modeled fee must be 0–10000 bps');
    const {contract,book}=await this.book(input.venue,input.sourceId);
    if(!['OPEN','ACTIVE'].includes(contract.data.status)||contract.data.closeAt!==null&&contract.data.closeAt<=Date.now())throw new Error('Market is not open for paper execution');
    const side=book[input.outcome.toLowerCase()],levels=input.side==='BUY'?side.asks:side.bids;
    // walkBook buys lowest asks. Selling uses the reciprocal so highest bids fill first.
    const quote=walkBook(input.side==='BUY'?levels:levels.map(l=>({...l,price:1-l.price})),quantity);
    if(!quote.complete||quote.averagePrice===null)throw new Error('Insufficient observed order-book depth');
    const price=input.side==='BUY'?quote.averagePrice:1-quote.averagePrice;
    const top=levels[0]?.price;const slippageBps=top>0?Math.abs(price/top-1)*10000:null;
    const venueModel=contract.data.feeModel||null;
    if(feeBps===null&&!venueModel)throw new Error(`Venue fee schedule unavailable (${contract.data.feeModelReason||'no fee model'}); enter a modeled fee in bps`);
    const fills=input.side==='BUY'?quote.fills:quote.fills.map(f=>({...f,price:1-f.price}));
    const venueFee=feeBps===null?takerFee(venueModel,fills):null;if(feeBps===null&&venueFee===null)throw new Error('Venue fee could not be computed for these fills; enter a modeled fee in bps');
    const gross=decimal(BigInt(Math.ceil(quantity*price*1e6))),fee=decimal(BigInt(Math.ceil((feeBps===null?venueFee:Number(gross)*feeBps/10000)*1e6)));
    const feeModel=feeBps===null?{kind:'VENUE_SCHEDULE',model:venueModel.kind,rate:venueModel.rate,source:venueModel.source,describe:describeFeeModel(venueModel)}:{kind:'USER_MODELED_BPS',bps:feeBps};
    const payload={id:input.id||randomUUID(),mode:input.mode,venue:input.venue,account:'manual',currency:'USD',instrumentId:stableId('Instrument',input.venue,`${input.sourceId}:${input.outcome}`),
      contractId:contract.id,sourceId:input.sourceId,outcome:input.outcome,eventId:contract.data.eventId||contract.id,strategyId:'manual',side:input.side,quantity,price,feeUsd:Number(fee),gross,fee,
      slippageBps,liquidityUsd:levels.reduce((s,l)=>s+l.price*l.quantity,0),quoteAt:Math.min(book.observedAt,book.providerTimestamp??book.observedAt),bookFingerprint:fingerprint(book),feeModel,simulated:true};
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
      this.ledger.append({sourceKey:`paper-fill:${id}`,at:Date.now(),mode:'PAPER',venue:order.venue,account:order.account,currency:order.currency,kind:order.side,instrumentId:order.instrumentId,strategyId:order.strategyId,eventId:order.eventId,quantity:String(order.quantity),gross:order.gross,fee:order.fee,reference:`Simulated depth fill; proposal ${id}; ${order.feeModel.kind==='USER_MODELED_BPS'?`modeled fee ${order.feeModel.bps} bps`:`venue fee schedule (${order.feeModel.model}, rate ${order.feeModel.rate})`}`});
      this.store.db.prepare("UPDATE proposals SET status='FILLED',decision=?,updated_at=? WHERE id=?").run(JSON.stringify(decision),Date.now(),id);this.store.record('ORDER_FILLED',{id,mode:'PAPER',simulated:true});
      return {id,status:'FILLED',simulated:true,order};
    });
    this.bus.publish(result.status==='FILLED'?'ORDER_FILLED':'ORDER_REJECTED',result);return result;
  }
  // Structured term match, upgraded to EXACT MATCH only by a still-valid human attestation.
  pairMatch(ca,cb){
    const m=matchTerms(extractTerms(ca.data),extractTerms(cb.data)),row=this.store.db.prepare("SELECT * FROM relationships WHERE source_id=? AND target_id=? AND relation='SETTLEMENT_VERIFIED'").get(ca.id,cb.id);
    let attestation=null;
    if(row){const ev=JSON.parse(row.evidence);attestation={at:row.at,note:ev.note||null,valid:ev.fpA===termsFingerprint(ca.data)&&ev.fpB===termsFingerprint(cb.data)&&ev.orientation===m.orientation};}
    const exact=m.classification==='STRONG MATCH'&&attestation?.valid===true;
    const fields=['type','teams','side','line','stat','day','scope','yesMeans','cancellation','resolutionSource'].map(k=>({field:k,a:m.termsA[k]==null?null:Array.isArray(m.termsA[k])?m.termsA[k].join(' vs '):String(m.termsA[k]),b:m.termsB[k]==null?null:Array.isArray(m.termsB[k])?m.termsB[k].join(' vs '):String(m.termsB[k])}));
    return {...m,classification:exact?'EXACT MATCH':m.classification,attestation,fields,missing:[...new Set([...m.termsA.missing,...m.termsB.missing])],differences:m.reasons,
      settlementMismatchRisk:exact?'HUMAN_VERIFIED_TERMS_STILL_SUBJECT_TO_VENUE_RISK':'UNVERIFIED_OR_DIFFERENT_TERMS',extraction:'HEURISTIC'};
  }
  async compare({a,b,quantity=1}){
    const [left,right]=await Promise.all([this.book(a.venue,a.sourceId),this.book(b.venue,b.sourceId)]),match=this.pairMatch(left.contract,right.contract);
    // INVERTED: YES on A pays when NO on B pays, so B's sides are swapped before pricing complements.
    const bookB=match.orientation==='INVERTED'?swapSides(right.book):right.book;
    const fees={a:left.contract.data.feeModel||null,b:right.contract.data.feeModel||null};
    return {a:left.contract,b:right.contract,fees:{a:describeFeeModel(fees.a,left.contract.data.feeModelReason),b:describeFeeModel(fees.b,right.contract.data.feeModelReason)},...arbitrageQuote(left.contract.data,right.contract.data,left.book,bookB,{quantity:Number(quantity),match,feeModels:fees})};
  }
  verifyPair({a,b,confirmation,note=''}){
    if(confirmation!==VERIFY_PHRASE)throw new Error(`Type "${VERIFY_PHRASE}" to attest`);
    const ca=this.store.get(stableId('Contract',a?.venue,a?.sourceId)),cb=this.store.get(stableId('Contract',b?.venue,b?.sourceId));
    if(!ca||!cb)throw new Error('Load both contracts (compare them) before verifying');
    const m=this.pairMatch(ca,cb);if(!['STRONG MATCH','EXACT MATCH'].includes(m.classification))throw new Error(`Only a STRONG MATCH can be verified (this pair is ${m.classification})`);
    const evidence=JSON.stringify({fpA:termsFingerprint(ca.data),fpB:termsFingerprint(cb.data),orientation:m.orientation,note:String(note).slice(0,500)});
    this.store.transaction(()=>{this.store.relate({sourceId:ca.id,targetId:cb.id,relation:'SETTLEMENT_VERIFIED',evidence,fact:true});this.store.record('PAIR_VERIFIED',{a:ca.id,b:cb.id,orientation:m.orientation});});
    return this.pairMatch(ca,cb);
  }
  arbitrageCandidates({limit=50}={}){
    const k=this.store.list({kind:'Contract',provider:'kalshi',limit:1000}),p=this.store.list({kind:'Contract',provider:'polymarket',limit:1000});
    return {scanned:{kalshi:k.length,polymarket:p.length},pairs:candidatePairs(k,p,{limit}).map(x=>{const ca=this.store.get(x.a),cb=this.store.get(x.b);return {...x,a:{venue:'kalshi',sourceId:ca.sourceId},b:{venue:'polymarket',sourceId:cb.sourceId},classification:this.pairMatch(ca,cb).classification};}),
      note:'Heuristic matches among contracts already loaded in Kalshi and Polymarket Markets. STRONG MATCH is not EXACT: read both rule texts before trusting a pair.'};
  }
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
