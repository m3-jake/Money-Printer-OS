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
import { PaperBroker,STOCK_VENUE,cleanSymbols,EQUITY_FEE_MODEL } from './brokers.js';
import { readBarStore } from '../robinhoodEquitiesData.js';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { MACRO_INDICATORS,FredSource,transform as macroTransform,impliedLadder,asOf as macroAsOf,indicator as macroIndicator } from './macro.js';
import { ReplaySession,runReplay,readTape,tapeSymbols,bookRecords,fetchAlpacaMinutes,REPLAY_STRATEGIES,strategyParams } from './replay.js';
const CODE_VERSION=(()=>{try{const pkg=JSON.parse(fs.readFileSync(new URL('../../package.json',import.meta.url),'utf8'));const h=createHash('sha256').update(fs.readFileSync(new URL('./replay.js',import.meta.url))).digest('hex').slice(0,12);return `${pkg.version}+replay.${h}`;}catch{return 'unknown';}})();

export const VERIFY_PHRASE='I READ BOTH RULE TEXTS AND THEY SETTLE IDENTICALLY';
const swapSides=book=>({...book,yes:book.no,no:book.yes});

export class MarketPlatform {
  constructor({file=':memory:',dataDir=null,providers=null,stockQuotes=undefined,stockClock=undefined,stockSession=undefined}={}){
    this.store=new CoreDatabase(file);this.ledger=new UnifiedLedger(this.store);this.bus=new MarketEventBus();this.risk=new RiskGovernor(this.store,this.ledger,this.bus);this.strategies=new StrategyRegistry(this.store);this.legacyReaders={};this.replays=new Map();this.fred=new FredSource();this.macroCache=null;
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
    const result=runReplay(new ReplaySession(records,{start:Number(start),end:Number(end)}),{key:k,strategy,params:strategyParams(strategy,params),stepMs:step,feeBps:fee,cash:startCash});
    const datasetFp=createHash('sha256').update(JSON.stringify(records.map(r=>[r.availableAt,r.observedAt,r.bid,r.ask,r.synthetic?1:0]))).digest('hex'),id=randomUUID();
    const summary={...result,curve:undefined,trades:result.trades.slice(-200)};
    this.store.db.prepare('INSERT INTO lab_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,Date.now(),source,k,Number(start),Number(end),strategy,JSON.stringify(result.params),datasetFp,records.length,CODE_VERSION,os.hostname(),null,JSON.stringify(summary));
    return {id,datasetFp,codeVersion:CODE_VERSION,machine:os.hostname(),...result};
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
  close(){this.store.close();}
}
let platform;
export function marketPlatform(){activateExecutionBoundary();if(!platform){const dataDir=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');platform=new MarketPlatform({file:path.join(dataDir,'mpos-core.sqlite'),dataDir});}return platform;}
// Release the SQLite handle (Windows keeps open files locked). The execution boundary stays active.
export function closeMarketPlatform(){if(!platform)return;try{platform.close();}finally{platform=undefined;}}
