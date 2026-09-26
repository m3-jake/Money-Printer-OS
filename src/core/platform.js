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
import { solanaPlan,practicePlan } from './legacyImport.js';
import { syncLabChampions } from './labSync.js';
import { extractTerms,matchTerms,termsFingerprint,candidatePairs } from './contractTerms.js';
import { describeFeeModel,takerFee } from './fees.js';
import { PaperBroker,STOCK_VENUE,cleanSymbols,EQUITY_FEE_MODEL } from './brokers.js';
import { readBarStore } from '../robinhoodEquitiesData.js';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { MACRO_INDICATORS,FredSource,transform as macroTransform,impliedLadder,asOf as macroAsOf,indicator as macroIndicator } from './macro.js';
import { EdgarSource,analyseFiling } from './edgar.js';
import { WEATHER_CITIES,WeatherSource,bucketLadder,weatherLinks } from './weather.js';
import { buildSportsEvents,mlbLive,nhlLive,attachLive } from './sports.js';
import { buildEventPages,EVENT_TEMPLATES,sportsPages,weatherPages,corporatePages } from './correlation.js';
import { tokenGraph,whaleFlow,walletView,authorityOf } from './whales.js';
import { WIRE_FEEDS,WIRE_FILTERS,parseRss,extractEntities,relatedMarkets,importance,categoriesOf } from './wire.js';
export const SPORTS_SERIES=['KXMLBGAME','KXNFLGAME','KXNCAAFGAME','KXNHLGAME','KXNBAGAME','KXWNBAGAME','KXATPMATCH','KXWTAMATCH','KXTTSTARMATCH','KXTTELITEMATCH','KXUEFANLGAME','KXMLSGAME','KXEPLGAME'];
import { walkForward,monteCarlo } from './replay.js';
import { LabPool,computeTask } from './labWorker.js';
import { promotionCheck } from './strategies.js';
import { ReplaySession,runReplay,readTape,tapeSymbols,bookRecords,fetchAlpacaMinutes,REPLAY_STRATEGIES,strategyParams } from './replay.js';
const CODE_VERSION=(()=>{try{const pkg=JSON.parse(fs.readFileSync(new URL('../../package.json',import.meta.url),'utf8'));const h=createHash('sha256').update(fs.readFileSync(new URL('./replay.js',import.meta.url))).digest('hex').slice(0,12);return `${pkg.version}+replay.${h}`;}catch{return 'unknown';}})();

export const VERIFY_PHRASE='I READ BOTH RULE TEXTS AND THEY SETTLE IDENTICALLY';
const swapSides=book=>({...book,yes:book.no,no:book.yes});

export class MarketPlatform {
  constructor({file=':memory:',dataDir=null,providers=null,stockQuotes=undefined,stockClock=undefined,stockSession=undefined,labWorkers=false}={}){
    this.labPool=labWorkers?new LabPool():null;
    this.store=new CoreDatabase(file);this.ledger=new UnifiedLedger(this.store);this.bus=new MarketEventBus();this.risk=new RiskGovernor(this.store,this.ledger,this.bus);this.strategies=new StrategyRegistry(this.store);this.legacyReaders={};this.replays=new Map();this.fred=new FredSource();this.macroCache=null;this.edgar=new EdgarSource();this.weather=new WeatherSource();this.weatherCache=null;this.sportsCache=null;this.sportsLive=new Map();this.sportsFetch=(url,opt)=>globalThis.fetch(url,opt);this.wireFetch=(url,opt)=>globalThis.fetch(url,opt);this.wireFeeds=new Map();this.whaleSeenTs=Date.now();this.eventsCache=null;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS wallet_labels(address TEXT PRIMARY KEY, label TEXT NOT NULL, note TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_sync(source TEXT PRIMARY KEY, epoch INTEGER NOT NULL, synced_at INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS integration_milestones(id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wallet_label_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, label TEXT, note TEXT NOT NULL, at INTEGER NOT NULL);`);
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS lab_runs(id TEXT PRIMARY KEY, at INTEGER NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
      strategy TEXT NOT NULL, params TEXT NOT NULL, dataset_fp TEXT NOT NULL, records INTEGER NOT NULL, code_version TEXT NOT NULL, machine TEXT NOT NULL, seed TEXT, result TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS lab_runs_no_update BEFORE UPDATE ON lab_runs BEGIN SELECT RAISE(ABORT,'Experiment records are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS lab_runs_no_delete BEFORE DELETE ON lab_runs BEGIN SELECT RAISE(ABORT,'Experiment records are append-only'); END;`);this.stocks=new PaperBroker({platform:this,...(stockQuotes?{quotes:stockQuotes}:{}),...(stockClock?{clock:stockClock}:{}),...(stockSession?{session:stockSession}:{})});this.dataDir=dataDir;
    this.providers=providers||new ProviderRegistry();if(!providers){this.providers.register(new KalshiProvider());this.providers.register(new PolymarketProvider());}
    this.journalError=null;
    if(dataDir)this.bus.on('RISK_STATE_CHANGED',event=>{
      try{appendProjectJournal(path.join(dataDir,'project-journal.ndjson'),{kind:'risk',title:`Risk Governor: ${event.data.state}`,detail:event.data.reason||'Paper execution resumed',at:event.at});}
      catch(e){this.journalError='Could not append risk milestone';throw e;}
    });
  }
  snapshot(){
    return {at:Date.now(),risk:this.risk.state(),providers:this.providers.status(),database:this.store.health(),eventBus:this.bus.snapshot(),journalError:this.journalError,
      strategies:this.strategies.list(),legacy:{...legacyCoverage(this.legacyReaders),mirror:this.store.db.prepare('SELECT * FROM legacy_sync').all().map(r=>({...r,detail:JSON.parse(r.detail)}))},labSync:this.labSync||null,portfolio:this.ledger.portfolio(),livePortfolio:this.ledger.portfolio('LIVE'),ledger:this.ledger.entries(),events:this.store.events(),
      watchlist:this.store.db.prepare('SELECT * FROM watchlist ORDER BY added_at DESC').all(),proposals:this.store.db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 100').all().map(r=>({...r,payload:JSON.parse(r.payload),decision:JSON.parse(r.decision)})),
      coverage:{legacyBooks:'MIRRORED_AND_RECONCILED_WHERE_POSSIBLE',liveAccounts:'NOT_RECONCILED',riskValuation:'PAPER_COST_BASIS_AND_REALIZED_LOSS',note:'Core accounts are reconstructed from this ledger only. The Solana paper book (SOL) and the Robinhood practice book are mirrored into this ledger and reconciled against their own cash; US combos stay read-only (no readable account balance).'}};
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
    if(venue!==STOCK_VENUE)this.providers.get(venue);const n=units(amount);if(n<=0n||n>1000000000000n)throw new Error('Paper funding must be between 0 and 1,000,000 USD');
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
      this.ledger.append({sourceKey:`paper-fill:${id}`,at:Date.now(),mode:'PAPER',venue:order.venue,account:order.account,currency:order.currency,kind:order.side,instrumentId:order.instrumentId,strategyId:order.strategyId,eventId:order.eventId,quantity:String(order.quantity),gross:order.gross,fee:order.fee,reference:`Simulated depth fill; proposal ${id}; ${order.feeModel.kind==='USER_MODELED_BPS'?`modeled fee ${order.feeModel.bps} bps`:order.feeModel.kind==='VENUE_SCHEDULE'?`venue fee schedule (${order.feeModel.model}, rate ${order.feeModel.rate})`:order.feeModel.describe||order.feeModel.kind}`});
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
  // Mirror legacy books into the ledger and reconcile (legacyImport.js). Safe to run repeatedly.
  mirroredFor(venue,account){
    const m=new Map();
    for(const r of this.store.db.prepare('SELECT kind,instrument_id,quantity_units,gross_units FROM ledger WHERE mode=? AND venue=? AND account=?').iterate('PAPER',venue,account)){
      if(!r.instrument_id)continue;const x=m.get(r.instrument_id)||{bought:0,sold:0,soldGross:0,fees:0};
      if(r.kind==='BUY')x.bought+=Number(r.quantity_units)/1e8;else if(r.kind==='SELL'){x.sold+=Number(r.quantity_units)/1e8;x.soldGross+=Number(r.gross_units)/1e6;}else if(r.kind==='FEE')x.fees+=Number(r.gross_units)/1e6;
      m.set(r.instrument_id,x);
    }
    for(const x of m.values()){x.bought=Math.round(x.bought*1e8)/1e8;x.sold=Math.round(x.sold*1e8)/1e8;x.soldGross=Math.round(x.soldGross*1e6)/1e6;x.fees=Math.round(x.fees*1e6)/1e6;}
    return m;
  }
  syncLegacyLedger(){
    const results=[],now=Date.now();
    const run=(source,venue,read,plan,isReset)=>{
      let book;try{book=read();}catch(e){results.push({source,status:'UNAVAILABLE',reason:`Read failed: ${e.message}`});return;}
      if(!book){results.push({source,status:'UNAVAILABLE',reason:'Book not loaded'});return;}
      let row=this.store.db.prepare('SELECT * FROM legacy_sync WHERE source=?').get(source)||{source,epoch:1};
      let account=`legacy-${row.epoch}`,mirrored=this.mirroredFor(venue,account);
      const notes=[];
      if(mirrored.size&&isReset(book)){row={...row,epoch:row.epoch+1};account=`legacy-${row.epoch}`;mirrored=new Map();notes.push(`Book reset detected; mirroring into a new account (${account}).`);}
      const p=plan(book,{epoch:row.epoch,mirrored,venue,account});notes.push(...p.notes);
      let appended=0,failed=null;
      for(const e of p.entries.sort((a,b)=>a.at-b.at||(['DEPOSIT','SELL','FEE','BUY'].indexOf(a.kind)-['DEPOSIT','SELL','FEE','BUY'].indexOf(b.kind)))){
        try{if(this.ledger.append(e).appended)appended++;}catch(err){failed=`${e.sourceKey}: ${err.message}`;break;}
      }
      const acct=this.ledger.portfolio('PAPER').accounts.find(a=>a.venue===venue&&a.account===account),ledgerCash=acct?Number(acct.cash):null;
      const diff=ledgerCash===null?null:Math.round((ledgerCash-p.expectedCash)*1e6)/1e6,tol=1e-6*(p.entries.length+1)+1e-6;
      const status=failed?'FAILED':diff!==null&&Math.abs(diff)<=tol?'RECONCILED':'DIFFERENCE';
      if(status==='DIFFERENCE')notes.push('Ledger cash differs from the book. Older history may have been compacted out of the book, or the book changed outside its normal flow. Nothing was booked to hide it.');
      this.store.db.prepare('INSERT INTO legacy_sync VALUES(?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET epoch=excluded.epoch,synced_at=excluded.synced_at,status=excluded.status,detail=excluded.detail').run(source,row.epoch,now,status,JSON.stringify({ledgerCash,bookCash:p.expectedCash,diff,appended,failed,notes}));
      results.push({source,venue,account,currency:p.currency,status,appended,ledgerCash,bookCash:p.expectedCash,diff,failed,notes});
    };
    run('solana','solana-paper',()=>this.legacyReaders.solana?.(),solanaPlan,s=>!(s.positions||[]).length&&!(s.history||[]).length);
    run('robinhood-practice','robinhood-practice',()=>{const x=this.legacyReaders.robinhoodPracticeBook?.();return x||null;},practicePlan,b=>!(b.positions||[]).length&&!(b.history||[]).length);
    results.push({source:'polymarket-us-combos',status:'NOT_MIRRORED',reason:'Real venue orders; no readable account balance (Polymarket US auth), so they cannot be reconciled. Shown read-only.'});
    this.legacySync={at:now,results};return results;
  }
  // Sync, read-only accessors supplied by the host (dashboard). Keys: solana, robinhoodPractice, usCombos.
  setLegacyReaders(readers={}){this.legacyReaders={...readers};}
  // Stocks (paper broker). Quotes are fetched per call; a missing key or failure is reported, never filled in.
  async stocksStatus(symbols=[]){
    const list=cleanSymbols(symbols);let quotes={},quoteError=null;
    const held=this.stocks.positions().map(p=>p.symbol),want=cleanSymbols([...list,...held]);
    if(want.length){try{quotes=await this.stocks.quotes(want);}catch(e){quoteError=e.message;}}
    return {at:Date.now(),session:this.stocks.session(Date.now()),dataSource:this.stocks.quoteSource.status(),quoteError,quotes,account:this.stocks.account(quotes),positions:this.stocks.positions(quotes),
      orders:this.stocks.history().slice(0,50),fees:EQUITY_FEE_MODEL.describe,brokers:[{id:STOCK_VENUE,label:'MPOS paper broker',live:false},{id:'robinhood',label:'Robinhood',live:false,note:'No official equities order API is connected; real-money execution is disabled by policy.'}]};
  }
  stocksBars(symbol){
    const sym=cleanSymbols([symbol])[0];if(!sym)throw new Error('Invalid symbol');
    const dir=this.dataDir||path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data'),store=readBarStore(dir),bars=store.bars?.[sym]||[];
    return {symbol:sym,source:store.provider||null,fetchedAt:store.fetchedAt||null,bars:bars.slice(-260),note:bars.length?'Daily bars from the Robinhood equities lane store (split/dividend adjusted).':'No stored daily bars for this symbol (the equities lane fetches bars only with an Alpaca key, for its own symbols).'};
  }
  async stocksPreview(input){return this.stocks.preview({...input,id:input.id||randomUUID()});}
  // Market Lab. Records are revealed by availableAt only (replay.js); every run is stored with the
  // dataset fingerprint, code version, parameters and machine so it can be reproduced.
  labSources(){
    const dir=this.dataDir||path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');
    const tape=tapeSymbols(dir).map(sym=>{const r=readTape(dir,sym);return {key:sym,records:r.length,first:r[0]?.availableAt??null,last:r.at(-1)?.availableAt??null,syntheticShare:r.length?r.filter(x=>x.synthetic).length/r.length:null};});
    const books=this.store.db.prepare("SELECT id,COUNT(*) n,MIN(available_at) first,MAX(available_at) last FROM entity_versions WHERE id LIKE 'orderbook:%' GROUP BY id HAVING n>1 ORDER BY n DESC LIMIT 100").all().map(r=>({key:r.id,records:r.n,first:r.first,last:r.last}));
    const alpaca=!!((process.env.ALPACA_KEY_ID||process.env.APCA_API_KEY_ID)&&(process.env.ALPACA_SECRET_KEY||process.env.APCA_API_SECRET_KEY));
    return {tape,books,alpaca:{configured:alpaca,note:alpaca?'Minute bars (IEX feed) for any symbol.':'Set ALPACA_KEY_ID / ALPACA_SECRET_KEY to replay stock sessions from minute bars.'},strategies:Object.fromEntries(Object.entries(REPLAY_STRATEGIES).map(([k,v])=>[k,{label:v.label,params:v.params}]))};
  }
  async labRecords({source,key,start,end}){
    const s=Number(start),e=Number(end);if(!Number.isFinite(s)||!Number.isFinite(e)||e<=s)throw new Error('Choose a start before the end');if(e-s>7*86400000)throw new Error('Replay window is limited to 7 days');
    const dir=this.dataDir||path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');
    if(source==='tape')return readTape(dir,String(key||'').toUpperCase(),{start:s,end:e});
    if(source==='book'){const rows=this.store.db.prepare('SELECT payload FROM entity_versions WHERE id=? AND available_at BETWEEN ? AND ? ORDER BY available_at').all(String(key),s,e).map(r=>JSON.parse(r.payload));return bookRecords(rows,String(key));}
    if(source==='alpaca')return fetchAlpacaMinutes({symbol:String(key||'').toUpperCase(),start:s,end:e});
    throw new Error('Unknown replay source');
  }
  async labRun({source,key,start,end,strategy='buy-hold',params={},stepMs=15000,feeBps=0,cash=1000}){
    const records=await this.labRecords({source,key,start,end});if(!records.length)throw new Error('No records in that window');
    const k=records[0].key,step=Math.max(1000,Math.min(3600000,Number(stepMs)||15000)),fee=Math.max(0,Math.min(1000,Number(feeBps)||0)),startCash=Math.max(1,Math.min(1e7,Number(cash)||1000));
    const result=await this.labCompute({kind:'run',records,opts:{start:Number(start),end:Number(end),key:k,strategy,params,stepMs:step,feeBps:fee,cash:startCash}});
    const datasetFp=createHash('sha256').update(JSON.stringify(records.map(r=>[r.availableAt,r.observedAt,r.bid,r.ask,r.synthetic?1:0]))).digest('hex'),id=randomUUID();
    const summary={...result,curve:undefined,trades:result.trades.slice(-200)};
    this.store.db.prepare('INSERT INTO lab_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,Date.now(),source,k,Number(start),Number(end),strategy,JSON.stringify(result.params),datasetFp,records.length,CODE_VERSION,os.hostname(),null,JSON.stringify(summary));
    return {id,datasetFp,codeVersion:CODE_VERSION,machine:os.hostname(),...result};
  }
  // Walk-forward validation + seeded Monte Carlo, stored as an experiment and optionally attached to a
  // registry strategy as its evidence (the promotion gate then decides; nothing is promoted here).
  async labWalkForward({source,key,start,end,strategy='momentum',grid={},folds=4,stepMs=15000,feeBps=10,cash=1000,seed=1,strategyId=null}){
    const records=await this.labRecords({source,key,start,end});if(!records.length)throw new Error('No records in that window');
    const k=records[0].key,step=Math.max(1000,Math.min(3600000,Number(stepMs)||15000)),fee=Math.max(0,Math.min(1000,Number(feeBps)||0)),sd=Math.max(1,Math.floor(Number(seed)||1));
    const wf=await this.labCompute({kind:'walkforward',records,opts:{key:k,strategy,grid,folds:Math.floor(Number(folds)||4),start:Number(start),end:Number(end),stepMs:step,feeBps:fee,cash:Math.max(1,Number(cash)||1000)}});
    const mc=monteCarlo(wf.folds.flatMap(f=>f.test.tradeReturns),{runs:2000,seed:sd});
    const datasetFp=createHash('sha256').update(JSON.stringify(records.map(r=>[r.availableAt,r.observedAt,r.bid,r.ask,r.synthetic?1:0]))).digest('hex'),id=randomUUID();
    const summary={evidence:wf.evidence,monteCarlo:mc,folds:wf.folds.map(f=>({...f,test:{...f.test,tradeReturns:undefined}}))};
    this.store.db.prepare('INSERT INTO lab_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,Date.now(),source,k,Number(start),Number(end),'walkforward:'+strategy,JSON.stringify({grid,folds:wf.folds.length+1,stepMs:step,feeBps:fee}),datasetFp,records.length,CODE_VERSION,os.hostname(),String(sd),JSON.stringify(summary));
    let attached=null;
    if(strategyId)attached=this.strategies.attachEvidence(String(strategyId),{...wf.evidence,monteCarloP5:mc.p5??null,labRunId:id,datasetFp},`Market Lab walk-forward ${id.slice(0,8)} on ${k}`);
    return {id,datasetFp,codeVersion:CODE_VERSION,machine:os.hostname(),seed:sd,...summary,attached,
      checks:{PAPER:promotionCheck('PAPER',wf.evidence),CANDIDATE:promotionCheck('CANDIDATE',wf.evidence)}};
  }
  labRuns(limit=50){return this.store.db.prepare('SELECT * FROM lab_runs ORDER BY at DESC LIMIT ?').all(Math.max(1,Math.min(500,limit))).map(r=>({...r,params:JSON.parse(r.params),result:JSON.parse(r.result)}));}
  async labReplayStart(input){
    for(const [id,s] of this.replays)if(Date.now()-s.touched>1800000)this.replays.delete(id);
    if(this.replays.size>=5)throw new Error('Too many open replays; close one first');
    const records=await this.labRecords(input);if(!records.length)throw new Error('No records in that window');
    const id=randomUUID(),session=new ReplaySession(records,{start:Number(input.start),end:Number(input.end)});this.replays.set(id,{session,touched:Date.now(),key:records[0].key});
    return {id,key:records[0].key,start:session.start,end:session.end,clock:session.clock,total:session.records.length,visible:session.seen.slice(-500),done:session.done};
  }
  labReplayStep({id,ms}){
    const r=this.replays.get(id);if(!r)throw new Error('Replay session expired; start it again');r.touched=Date.now();
    const fresh=r.session.advanceTo(r.session.clock+Math.max(1000,Math.min(86400000,Number(ms)||15000)));
    return {id,clock:r.session.clock,fresh:fresh.slice(-500),revealed:r.session.seen.length,total:r.session.records.length,done:r.session.done};
  }
  // Macro desk: FRED context values plus Kalshi release ladders. Cached 10 minutes; Kalshi calls run
  // one at a time (provider concurrency cap). Every section carries its own error instead of failing all.
  async macroSnapshot({force=false}={}){
    if(!force&&this.macroCache&&Date.now()-this.macroCache.at<600000)return this.macroCache.data;
    const kalshi=this.providers.providers.get('kalshi')||null,now=Date.now();
    const fred=await Promise.all(MACRO_INDICATORS.map(async ind=>{try{const rows=macroTransform(await this.fred.latest(ind.fred),ind.transform);return {id:ind.id,history:rows.slice(-36),last:rows.at(-1)||null,prev:rows.at(-2)||null,error:null};}catch(e){return {id:ind.id,history:[],last:null,prev:null,error:e.message};}}));
    const ladders={},sleep=ms=>new Promise(res=>setTimeout(res,ms));
    // Paced, with one wait-and-retry on a 429 (the provider records the venue's backoff).
    const call=async fn=>{for(let i=0;;i++){try{const out=await fn();await sleep(this.macroPaceMs??150);return out;}catch(e){if(e.code!=='RATE_LIMITED'||i>=2)throw e;await sleep(Math.min(15000,Math.max(1000,(kalshi.health?.backoffUntil||0)-Date.now())));}}};
    for(const ind of MACRO_INDICATORS.filter(i=>i.kalshi)){
      if(!kalshi){ladders[ind.id]={error:'Kalshi provider unavailable'};continue;}
      try{
        // Events come soonest first; stop at the first one with a future, two-sided ladder.
        const events=(await call(()=>kalshi.events({series:ind.kalshi}))).slice(0,3);let best=null;
        for(const e of events){if(best)break;const {markets}=await call(()=>kalshi.markets({eventTicker:e.event_ticker}));for(const m of markets)this.store.put(m);const l=impliedLadder(markets,ind.kalshiScale||1);if(l.closeAt&&l.closeAt>now&&(!best||l.closeAt<best.closeAt))best={...l,eventTicker:e.event_ticker,title:e.title,subTitle:e.sub_title||null,source:e.settlement_sources?.[0]||null};}
        ladders[ind.id]=best||{error:'No open Kalshi event with a two-sided ladder'};
      }catch(e){ladders[ind.id]={error:e.message};}
    }
    const byId=Object.fromEntries(fred.map(f=>[f.id,f]));
    const data={at:now,fred:this.fred.status(),vintageMode:this.fred.keyed(),indicators:MACRO_INDICATORS.map(ind=>({...ind,...byId[ind.id],ladder:ind.kalshi?ladders[ind.id]:null})),
      calendar:MACRO_INDICATORS.filter(i=>ladders[i.id]?.closeAt).map(i=>({id:i.id,label:i.label,closeAt:ladders[i.id].closeAt,eventTicker:ladders[i.id].eventTicker,title:ladders[i.id].title,impliedMedian:ladders[i.id].impliedMedian})).sort((a,b)=>a.closeAt-b.closeAt),
      note:this.fred.keyed()?'FRED values are ALFRED vintages; as-of queries return only what was published by then.':'FRED values are the latest revised figures (public CSV). They are context only; as-of history for backtests needs FRED_API_KEY.'};
    this.macroCache={at:now,data};return data;
  }
  async macroAsOf({id,asOf}){const ind=macroIndicator(id);if(!ind)throw new Error('Unknown indicator');const t=Number(asOf);if(!Number.isFinite(t))throw new Error('asOf required');
    return {id,asOf:t,rows:macroTransform(macroAsOf(await this.fred.vintages(ind.fred),t),ind.transform).slice(-60),rule:'Each value is visible only after the end (US/Eastern) of the day FRED first published it.'};}
  // EDGAR: facts are stored as Filing entities available at SEC acceptance time; analysis rides alongside.
  recordFilings(filings){
    const contracts=this.store.list({kind:'Contract',limit:1000});
    return filings.map(f=>{
      if(f.facts.accession&&f.facts.acceptedAt){const id=stableId('Filing','sec',f.facts.accession),isNew=!this.store.get(id);
        this.store.put({kind:'Filing',provider:'sec',sourceId:f.facts.accession,data:f.facts,observedAt:f.facts.acceptedAt,availableAt:f.facts.acceptedAt,sourceUrl:f.facts.indexUrl});
        if(isNew)this.bus.publish('SEC_FILING_RECEIVED',{id,form:f.facts.form,company:f.facts.company,ticker:f.facts.ticker,items:f.facts.items.map(i=>i.code)});}
      return {...f,analysis:analyseFiling(f,contracts)};
    });
  }
  // Weather desk: NWS forecast highs next to Kalshi's daily-high bucket markets, severe alerts and NHC
  // storms. Alerts are stored as WeatherAlert entities available at their NWS "sent" time.
  async weatherSnapshot({force=false}={}){
    if(!force&&this.weatherCache&&Date.now()-this.weatherCache.at<600000)return this.weatherCache.data;
    const kalshi=this.providers.providers.get('kalshi')||null,now=Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const call=async fn=>{for(let i=0;;i++){try{const out=await fn();await sleep(this.macroPaceMs??150);return out;}catch(e){if(e.code!=='RATE_LIMITED'||i>=2)throw e;await sleep(Math.min(15000,Math.max(1000,(kalshi.health?.backoffUntil||0)-Date.now())));}}};
    const contracts=this.store.list({kind:'Contract',limit:1000});
    let alerts=[],alertsError=null,storms=[],stormsError=null;
    try{alerts=(await this.weather.alerts()).sort((a,b)=>b.sent-a.sent).slice(0,80);for(const a of alerts){const id=stableId('WeatherAlert','nws',a.id),fresh=!this.store.get(id);/* one malformed alert must not drop the rest */try{this.store.put({kind:'WeatherAlert',provider:'nws',sourceId:a.id,data:a,observedAt:a.sent,availableAt:a.sent});}catch{continue;}if(fresh)this.bus.publish('NEWS_RECEIVED',{kind:'WEATHER_ALERT',id,event:a.event,area:a.area,severity:a.severity});}}catch(e){alertsError=e.message;}
    try{storms=await this.weather.storms();}catch(e){stormsError=e.message;}
    const cities=[];
    for(const city of WEATHER_CITIES){
      const row={...city,forecast:null,forecastError:null,markets:[],marketError:null};
      try{row.forecast=await this.weather.highs(city);}catch(e){row.forecastError=e.message;}
      if(kalshi)try{
        const events=(await call(()=>kalshi.events({series:city.kalshi}))).slice(0,2);
        for(const e of events){
          const m=String(e.event_ticker).match(/-(\d{2})([A-Z]{3})(\d{2})$/),months={JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};
          const date=m?`20${m[1]}-${String(months[m[2]]).padStart(2,'0')}-${m[3]}`:null;const {markets}=await call(()=>kalshi.markets({eventTicker:e.event_ticker}));for(const x of markets)this.store.put(x);
          const ladder=bucketLadder(markets),nws=date?row.forecast?.highs?.[date]?.high??null:null;
          row.markets.push({eventTicker:e.event_ticker,date,title:e.title,...ladder,nwsHigh:nws,gap:nws!==null&&ladder.expectedHigh!==null?Math.round((nws-ladder.expectedHigh)*10)/10:null,settlement:e.settlement_sources?.[0]?.name||null});
        }
      }catch(e){row.marketError=e.message;}
      else row.marketError='Kalshi provider unavailable';
      cities.push(row);
    }
    const data={at:now,nws:this.weather.status(),cities,alerts:alerts.map(a=>({...a,analysis:weatherLinks(`${a.event} ${a.area}`,contracts)})),alertsError,storms:storms.map(s=>({...s,analysis:weatherLinks(`hurricane tropical storm ${s.name}`,contracts)})),stormsError,
      note:'Kalshi settles daily highs on The Weather Company reading; the NWS forecast here is an input, not the settlement value. Sector and market links are speculative.'};
    this.weatherCache={at:now,data};return data;
  }
  // Sports: one canonical SportsEvent per game across venues, with live state from official feeds.
  async sportsSnapshot({force=false}={}){
    if(!force&&this.sportsCache&&Date.now()-this.sportsCache.at<60000)return this.sportsCache.data;
    const kalshi=this.providers.providers.get('kalshi')||null,poly=this.providers.providers.get('polymarket')||null,now=Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),errors=[];
    const call=async(label,fn)=>{for(let i=0;;i++){try{const out=await fn();await sleep(this.macroPaceMs??150);return out;}catch(e){if(e.code==='RATE_LIMITED'&&i<2){await sleep(Math.min(15000,Math.max(1000,((label.startsWith('kalshi')?kalshi:poly)?.health?.backoffUntil||0)-Date.now())));continue;}errors.push(`${label}: ${e.message}`);return null;}}};
    const loaded=[];
    if(kalshi)for(const series of SPORTS_SERIES){const r=await call(`kalshi ${series}`,()=>kalshi.markets({series,limit:200}));if(r)loaded.push(...r.markets);}
    if(poly)for(let offset=0;offset<500;offset+=100){const r=await call(`polymarket ${offset}`,()=>poly.markets({offset,limit:100}));if(r)loaded.push(...r.markets);else break;}
    for(const c of loaded)this.store.put(c);
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(now));
    let events=buildSportsEvents(loaded).filter(e=>e.day>=today);
    const feeds=[];
    for(const [sport,url,parse] of [['MLB',`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=linescore`,mlbLive],['NHL',`https://api-web.nhle.com/v1/score/${today}`,nhlLive]]){
      try{const r=await this.sportsFetch(url,{signal:AbortSignal.timeout?.(10000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);const games=parse(await r.json());attachLive(events,games,today);feeds.push({sport,status:'CONNECTED',games:games.length});}
      catch(e){feeds.push({sport,status:'DISCONNECTED',error:e.message});}
    }
    for(const ev of events){
      try{const ent=this.store.put({kind:'SportsEvent',provider:'mpos',sourceId:ev.id,data:{sport:ev.sport,family:ev.family,day:ev.day,participants:ev.participants,live:ev.live||null},observedAt:now,availableAt:now,fact:false});
        for(const k of ev.contracts)this.store.relate({sourceId:k.id,targetId:ent.id,relation:'PRICES',evidence:'Matched by sport, game day and participant names (heuristic)',fact:false,at:now});
        const sig=JSON.stringify(ev.live?[ev.live.state,ev.live.score,ev.live.period]:null),prev=this.sportsLive.get(ev.id);
        if(ev.live&&prev!==sig){this.sportsLive.set(ev.id,sig);this.bus.publish('SPORT_EVENT_UPDATED',{id:ent.id,sport:ev.sport,participants:ev.participants,state:ev.live.state,score:ev.live.score,period:ev.live.period});}
      }catch(e){errors.push(`store ${ev.id}: ${e.message}`);}
    }
    const data={at:now,today,events,feeds,errors:errors.slice(0,20),loaded:loaded.length,
      note:'Events are clustered from venue contracts by sport, game day and names (heuristic). Live state only from official MLB/NHL feeds; other sports show prices only. Prices are listing mids, not executable quotes.'};
    this.sportsCache={at:now,data};return data;
  }
  // Wire: one feed over everything MPOS ingests. RSS items are stored as NewsEvent entities available
  // at min(published, received). Entities, related markets and importance are rule-based analysis.
  async wireSnapshot({force=false}={}){
    const now=Date.now(),feeds=[];
    for(const f of WIRE_FEEDS){
      const c=this.wireFeeds.get(f.id);if(!force&&c&&now-c.at<300000){feeds.push(c.status);continue;}
      try{const r=await this.wireFetch(f.url,{headers:{'User-Agent':'MoneyPrinterOS/0.5 (wire)'},signal:AbortSignal.timeout?.(12000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);
        const items=parseRss(await r.text());
        for(const it of items){const id=stableId('NewsEvent',f.id,it.guid),fresh=!this.store.get(id);try{this.store.put({kind:'NewsEvent',provider:f.id,sourceId:it.guid,data:{...it,feed:f.id,kindHint:f.kind},observedAt:now,availableAt:Math.min(it.publishedAt,now),sourceUrl:it.link});}catch{continue;}if(fresh)this.bus.publish('NEWS_RECEIVED',{kind:'RSS',id,feed:f.id,title:it.title});}
        const status={id:f.id,label:f.label,status:'CONNECTED',items:items.length,at:now};this.wireFeeds.set(f.id,{at:now,status});feeds.push(status);}
      catch(e){const status={id:f.id,label:f.label,status:'DISCONNECTED',error:e.message,at:now};this.wireFeeds.set(f.id,{at:now,status});feeds.push(status);}
    }
    const contracts=this.store.list({kind:'Contract',limit:1000});
    // Held exposure: core paper positions (contract ids), stocks, and legacy crypto books.
    const held={contracts:new Set(),symbols:new Set()};
    for(const a of this.ledger.portfolio('PAPER').accounts)for(const p of a.positions){
      // instrument:<venue>:<encoded "sourceId:OUTCOME"> for prediction contracts; instrument:stocks-paper:<SYMBOL> for stocks.
      const [,venue,enc]=String(p.instrumentId).split(':'),raw=decodeURIComponent(enc||''),m=raw.match(/^(.+):(YES|NO)$/);
      if(m)held.contracts.add(stableId('Contract',decodeURIComponent(venue),m[1]));else if(raw)held.symbols.add(raw.toUpperCase());}
    try{for(const b of legacyCoverage(this.legacyReaders).books)if(b.source==='robinhood-practice')for(const p of (this.legacyReaders.robinhoodPractice?.()?.positions||[]))held.symbols.add(String(p.symbol||'').split('-')[0].toUpperCase());}catch{}
    const teams=(this.sportsCache?.data?.events||[]).flatMap(e=>e.participants),tickers=new Set(this.store.list({kind:'Filing',limit:500}).map(f=>f.data.ticker).filter(Boolean));
    const ctx={teams,tickers};
    const finish=it=>{it.entities=it.entities||extractEntities(`${it.title} ${it.summary||''} ${it.category||''}`,ctx);it.relatedMarkets=[...(it.relatedMarkets||[]),...relatedMarkets(it.entities,contracts)].filter((m,i,a)=>a.findIndex(x=>x.id===m.id)===i).slice(0,8);
      it.myPositions=it.relatedMarkets.some(m=>held.contracts.has(m.id))||it.entities.some(e=>(e.type==='crypto'||e.type==='ticker')&&held.symbols.has(e.key));it.importance=importance(it);it.categories=categoriesOf(it);it.analysis='RULE_BASED';return it;};
    const items=[];
    for(const n of this.store.list({kind:'NewsEvent',limit:300}))items.push(finish({id:n.id,at:n.availableAt,kind:n.data.kindHint||'MACRO',source:n.provider,title:n.data.title,summary:n.data.summary,category:n.data.category,url:n.sourceUrl}));
    for(const f of this.store.list({kind:'Filing',limit:200})){const an=analyseFiling({facts:f.data},contracts);items.push(finish({id:f.id,at:f.availableAt,kind:'CORPORATE',source:'SEC',title:`${f.data.form} · ${f.data.company}${f.data.ticker?' ('+f.data.ticker+')':''}${f.data.items?.length?' — '+f.data.items.map(i=>i.name).join('; '):''}`,url:f.data.url,catalysts:an.catalysts,relatedMarkets:an.relatedMarkets,entities:f.data.ticker?[{type:'ticker',key:f.data.ticker,label:f.data.ticker}]:undefined}));}
    for(const w of this.store.list({kind:'WeatherAlert',limit:200}))items.push(finish({id:w.id,at:w.availableAt,kind:'WEATHER',source:'NWS',title:`${w.data.event} — ${String(w.data.area||'').slice(0,120)}`,severity:w.data.severity,url:null}));
    for(const s of this.store.list({kind:'SportsEvent',limit:500}).filter(s=>s.data.live))items.push(finish({id:s.id,at:s.observedAt,kind:'SPORTS',source:s.data.live.feed,title:`${s.data.participants.join(' vs ')}: ${s.data.live.state}${s.data.live.score?.[0]!=null?' '+s.data.live.score.join('–'):''}${s.data.live.period?' · '+s.data.live.period:''}`,fastSettling:['ATP','WTA','TABLE_TENNIS'].includes(s.data.sport),entities:s.data.participants.map(p=>({type:'team',key:p,label:p}))}));
    for(const c of (this.macroCache?.data?.calendar||[]).filter(c=>c.closeAt>now&&c.closeAt-now<7*86400000))items.push(finish({id:'macro:'+c.eventTicker,at:c.closeAt,kind:'MACRO',scheduled:true,source:'Kalshi calendar',title:`Upcoming: ${c.label} (${c.title})${c.impliedMedian!==null?' — market-implied '+c.impliedMedian:''}`,entities:[{type:'macro',key:c.id,label:c.label}]}));
    for(const e of this.store.events(200).filter(e=>['RISK_STATE_CHANGED','ORDER_FILLED','PAIR_VERIFIED','STRATEGY_PROMOTED','STRATEGY_DEMOTED','ORDER_CANCELLED'].includes(e.type)))items.push(finish({id:'core:'+e.seq,at:e.at,kind:e.type==='RISK_STATE_CHANGED'?'RISK':e.type==='ORDER_FILLED'?'FILL':'MARKETS',source:'MPOS core',title:`${e.type.replace(/_/g,' ').toLowerCase()}${e.payload.state?': '+e.payload.state:''}${e.payload.reason?' — '+e.payload.reason:''}${e.payload.id?' ('+String(e.payload.id).slice(0,40)+')':''}`,entities:[]}));
    items.sort((a,b)=>b.at-a.at);
    return {at:now,feeds,items:items.slice(0,400),filters:WIRE_FILTERS,counts:Object.fromEntries(WIRE_FILTERS.map(f=>[f,f==='ALL'?items.length:items.filter(i=>i.categories.includes(f)).length])),
      note:'Items are source facts (title, time, link). Entities, related markets, "my positions" and importance are rule-based analysis. Scheduled macro items are dated by the Kalshi close.'};
  }
  // Whale Watch over the engine's research state and indexed swaps (readers set by the host).
  whaleInputs({since=Date.now()-7*86400000,limit=20000}={}){
    // Reader failures are reported, never turned into silent empty data.
    let researchError=null,eventsError=null;
    const r=(()=>{try{return this.legacyReaders.solanaResearch?.()||null;}catch(e){researchError=String(e.message||e).slice(0,200);return null;}})();
    const events=(()=>{try{return this.legacyReaders.txEvents?.({since,limit})||[];}catch(e){eventsError=String(e.message||e).slice(0,200);return [];}})();
    const labels=Object.fromEntries(this.store.db.prepare('SELECT * FROM wallet_labels').all().map(l=>[l.address,{label:l.label,note:l.note,at:l.at}]));
    return {available:{research:!!r,events:events.length,researchError,eventsError},universe:r?.universe||{},wallets:r?.walletProfiles||{},deployers:r?.deployerProfiles||{},events,labels};
  }
  whaleSnapshot({minSol=10}={}){
    const inp=this.whaleInputs(),flow=whaleFlow(inp.events,{minSol:Math.max(0.1,Number(minSol)||10),universe:inp.universe,labels:inp.labels});
    for(const f of flow.filter(f=>f.ts>this.whaleSeenTs))this.bus.publish('WALLET_ACTIVITY',{wallet:f.wallet,side:f.side,sol:f.sol,mint:f.mint,ts:f.ts});
    if(flow.length)this.whaleSeenTs=Math.max(this.whaleSeenTs,...flow.map(f=>f.ts));
    const authorities=Object.values(inp.deployers).map(d=>({address:d.address,tokens:Object.keys(d.mints||{}).length,lastSeen:d.lastSeen||null,label:inp.labels[d.address]||null})).sort((a,b)=>b.tokens-a.tokens).slice(0,30);
    const recurring=Object.values(inp.wallets).sort((a,b)=>(b.seen||0)-(a.seen||0)).slice(0,30).map(w=>({address:w.address,tokensSeen:w.seen,recurrenceScore:w.recurrenceScore??null,label:inp.labels[w.address]||null}));
    const tokens=Object.values(inp.universe).sort((a,b)=>(b.lastSeen||0)-(a.lastSeen||0)).slice(0,60).map(t=>({mint:t.mint,symbol:t.symbol||null,lastSeen:t.lastSeen||null,authority:authorityOf(t.mint,inp.deployers)?.address||null}));
    let scorecard=null;try{scorecard=this.legacyReaders.walletScorecard?.()||null;}catch{}
    return {at:Date.now(),available:inp.available,flow,authorities,recurring,tokens,scorecard,labels:inp.labels,exchangeFlows:'UNAVAILABLE (needs exchange wallet attribution)',
      note:'Observed on-chain activity and rule-based flags. Wallet behaviour is not identity or intent. Labels are your own notes.'};
  }
  whaleToken(mint){const s=String(mint||'').trim();if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s))throw new Error('Invalid Solana mint address');return tokenGraph(s,this.whaleInputs());}
  whaleWallet(address){const s=String(address||'').trim();if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s))throw new Error('Invalid Solana address');const inp=this.whaleInputs();let score=null;try{score=(this.legacyReaders.walletScorecard?.()?.wallets||[]).find(w=>w.wallet===s||w.address===s)||null;}catch{}return walletView(s,{...inp,score});}
  labelWallet({address,label,note=''}){
    const a=String(address||'').trim();if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a))throw new Error('Invalid Solana address');
    const l=String(label||'').trim().slice(0,60),n=String(note||'').slice(0,500),now=Date.now();
    this.store.transaction(()=>{if(l)this.store.db.prepare('INSERT INTO wallet_labels VALUES(?,?,?,?) ON CONFLICT(address) DO UPDATE SET label=excluded.label,note=excluded.note,at=excluded.at').run(a,l,n,now);else this.store.db.prepare('DELETE FROM wallet_labels WHERE address=?').run(a);
      this.store.db.prepare('INSERT INTO wallet_label_events(address,label,note,at) VALUES(?,?,?,?)').run(a,l||null,n,now);});
    return {address:a,label:l||null,note:n};
  }
  // Command Center event pages (correlation.js). Cached 5 minutes.
  async eventPages({force=false}={}){
    if(!force&&this.eventsCache&&Date.now()-this.eventsCache.at<300000)return this.eventsCache.data;
    const now=Date.now(),errors=[],poly=this.providers.providers.get('polymarket')||null;
    const macro=await this.macroSnapshot().catch(e=>{errors.push('macro: '+e.message);return null;});
    // Topic searches on Polymarket for each upcoming release (paced; the provider caches 5 minutes).
    if(poly&&poly.search)for(const id of [...new Set((macro?.calendar||[]).map(c=>c.id))]){const q=EVENT_TEMPLATES[id]?.search;if(!q)continue;
      try{for(const c of await poly.search(q))this.store.put(c);await new Promise(r=>setTimeout(r,this.macroPaceMs??150));}catch(e){errors.push(`polymarket search "${q}": ${e.message}`);}}
    const wire=await this.wireSnapshot().then(w=>w.items).catch(e=>{errors.push('wire: '+e.message);return [];});
    const held=new Set(),heldCost=new Map();
    for(const a of this.ledger.portfolio('PAPER').accounts)for(const p of a.positions){const [,venue,enc]=String(p.instrumentId).split(':'),m=decodeURIComponent(enc||'').match(/^(.+):(YES|NO)$/);if(m){const id=stableId('Contract',decodeURIComponent(venue),m[1]);held.add(id);heldCost.set(id,(heldCost.get(id)||0)+Number(p.costBasis));}}
    const assets={},dir=this.dataDir||path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');
    for(const [sym,tape] of [['BTC','BTC-USD'],['ETH','ETH-USD'],['SOL','SOL-USD']]){const r=readTape(dir,tape,{start:now-6*3600000,end:now});const last=r.at(-1);if(last)assets[sym]={price:(last.bid+last.ask)/2,at:last.availableAt,source:last.synthetic?'tape (candle-derived)':'tape'};}
    try{const q=await this.stocks.quotes(['SPY','QQQ','TLT','XRT']);for(const [s,x] of Object.entries(q))if(x.last||x.bid)assets[s]={price:x.last??(x.bid+x.ask)/2,at:x.quoteAt,source:x.source};}catch(e){errors.push('stock quotes: '+e.message);}
    const pages=buildEventPages({macro,contracts:this.store.list({kind:'Contract',limit:1000}),wire,held,heldCost,assets,now});
    // Other event kinds come from the Sports, Weather and EDGAR desks (their own caches).
    const sports=await this.sportsSnapshot().catch(e=>{errors.push('sports: '+e.message);return null;});
    const weather=await this.weatherSnapshot().catch(e=>{errors.push('weather: '+e.message);return null;});
    const contracts=this.store.list({kind:'Contract',limit:1000}),filings=this.store.list({kind:'Filing',limit:200}).map(f=>({facts:f.data,analysis:analyseFiling({facts:f.data},contracts)}));
    const others=[...sportsPages(sports?.events||[],{wire,held,heldCost}),...weatherPages(weather,{wire}),...corporatePages(filings,{wire,assets,held,heldCost})];
    for(const pg of pages){try{const ev=this.store.put({kind:'Event',provider:'mpos',sourceId:pg.eventTicker,data:{title:pg.title,indicator:pg.indicator,when:pg.when},observedAt:now,availableAt:now,fact:false});
      for(const id of pg.relatedContractIds){if(!this.store.get(id))continue;this.store.relate({sourceId:id,targetId:ev.id,relation:'MARKET_FOR_EVENT',evidence:id.startsWith('contract:kalshi:')?'Same Kalshi event':'Keyword template match',fact:id.startsWith('contract:kalshi:'),at:now});}}catch(e){errors.push('store: '+e.message);}}
    const data={at:now,pages:[...pages,...others],counts:{MACRO:pages.length,SPORTS:others.filter(p=>p.kind==='SPORTS').length,WEATHER:others.filter(p=>p.kind==='WEATHER').length,CORPORATE:others.filter(p=>p.kind==='CORPORATE').length},errors,note:'Kalshi links are the venue\'s own event grouping; Polymarket, asset and signal links are rule-based. Exposure covers the core ledger only.'};
    this.eventsCache={at:now,data};return data;
  }
  // Diagnostics across every source and subsystem. Values that cannot be measured are "unavailable".
  diagnostics(){
    const now=Date.now(),age=c=>c?.at?now-c.at:null,mem=process.memoryUsage(),load=os.loadavg();
    let dbBytes=null;try{const f=this.store.db.prepare('PRAGMA page_count').get().page_count*this.store.db.prepare('PRAGMA page_size').get().page_size;dbBytes=f;}catch{}
    const counts=Object.fromEntries(['entities','entity_versions','relationships','ledger','proposals','core_events','lab_runs','strategies'].map(t=>{try{return [t,this.store.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n];}catch{return [t,null];}}));
    const sources=[...this.providers.status().map(p=>({id:p.id,kind:'prediction venue',status:p.status,lastSuccess:p.lastSuccess,lastError:p.lastError,latencyMs:p.latencyMs,queueDepth:p.queueDepth,websocket:p.websocket})),
      {id:'alpaca-iex',kind:'stock quotes',...this.stocks.quoteSource.status()},{id:'fred',kind:'macro',...this.fred.status()},{id:'nws',kind:'weather',...this.weather.status()},{id:'sec-edgar',kind:'filings',...this.edgar.status()},
      ...(this.sportsCache?.data?.feeds||[]).map(f=>({id:f.sport.toLowerCase()+'-live',kind:'sports live',status:f.status,lastSuccess:this.sportsCache.at,lastError:f.error||null})),
      ...[...this.wireFeeds.values()].map(v=>({id:'rss-'+v.status.id,kind:'wire feed',status:v.status.status,lastSuccess:v.status.status==='CONNECTED'?v.at:null,lastError:v.status.error||null}))];
    // Journal: the first time each source connects in this data dir is a project milestone.
    if(this.dataDir)for(const s of sources.filter(s=>s.status==='CONNECTED')){
      if(this.store.db.prepare('SELECT 1 FROM integration_milestones WHERE id=?').get(s.id))continue;
      try{appendProjectJournal(path.join(this.dataDir,'project-journal.ndjson'),{kind:'integration',title:`Integration connected: ${s.id}`,detail:`${s.kind} source first connected in this data folder.`,at:now});this.store.db.prepare('INSERT INTO integration_milestones VALUES(?,?)').run(s.id,now);}catch{this.journalError='Could not append integration milestone';}
    }
    return {at:now,sources,eventBus:this.bus.snapshot(),database:{...this.store.health(),bytes:dbBytes,tables:counts},
      labWorkers:this.labPool?this.labPool.status():'inline',caches:{macroAgeMs:age(this.macroCache),weatherAgeMs:age(this.weatherCache),sportsAgeMs:age(this.sportsCache),eventsAgeMs:age(this.eventsCache),openReplays:this.replays.size},
      process:{rssMb:Math.round(mem.rss/1048576),heapUsedMb:Math.round(mem.heapUsed/1048576),uptimeSec:Math.round(process.uptime()),cpuCount:os.cpus().length,loadAvg1:process.platform==='win32'?'unavailable (not provided on Windows)':Math.round(load[0]*100)/100,gpu:'unavailable (not measured by MPOS core)'},
      journalError:this.journalError};
  }
  async edgarLatest(form='8-K'){return {status:this.edgar.status(),form,filings:this.recordFilings(await this.edgar.latest(form))};}
  async edgarCompany(ticker){const {filingsFromSubmissions}=await import('./edgar.js');const sub=await this.edgar.company(ticker);return {status:this.edgar.status(),company:sub.name,cik:sub.cik,tickers:sub.tickers,sic:sub.sicDescription||null,filings:this.recordFilings(filingsFromSubmissions(sub,{limit:60}))};}
  async edgarForm4(url){return {status:this.edgar.status(),facts:await this.edgar.form4(url),kind:'FORM_4_FACTS'};}
  // Market Lab compute: worker threads when enabled (the app), inline otherwise (tests, scripts).
  labCompute(task){return this.labPool?this.labPool.run(task):Promise.resolve().then(()=>computeTask(task));}
  close(){this.labPool?.close().catch(()=>{});this.store.close();}
}
let platform;
export function marketPlatform(){activateExecutionBoundary();if(!platform){const dataDir=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');platform=new MarketPlatform({file:path.join(dataDir,'mpos-core.sqlite'),dataDir,labWorkers:true});}return platform;}
// Release the SQLite handle (Windows keeps open files locked). The execution boundary stays active.
export function closeMarketPlatform(){if(!platform)return;try{platform.close();}finally{platform=undefined;}}
