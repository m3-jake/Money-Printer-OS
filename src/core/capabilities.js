import fs from 'node:fs';
import path from 'node:path';

// One contract per desk. Availability is derived from collected records; a declared evaluator
// never implies that its data or its strategy passed qualification.
export const MODULE_CONTRACTS = Object.freeze([
 {id:'solana',role:'TRADING',provider:'solana',kind:'Trade',evaluator:'executable-price replay / sampled-mark research',paper:'existing Solana paper engine',decision:'COLLECT_FIRST',blockers:['Executable entry/exit evidence and rug/priority-fee scenarios must qualify before exit search']},
 {id:'robinhood',role:'TRADING',fitness:'robinhood',evaluator:'robinhood-backtest.v2',paper:'bounded optional Lab paper trial',decision:'COLLECT_FIRST',blockers:['Seven days of authentic venue evidence and independent closed outcomes required']},
 {id:'robinhood-equities',role:'TRADING',evaluator:'equities-close-next-open-v2',paper:'daily ETF paper book',decision:'COLLECT_FIRST',blockers:['Adjusted IEX bars do not establish executable costs; prospective holdout pending']},
 {id:'stocks',role:'TRADING',provider:'alpaca-iex',kind:'Price',evaluator:'market-replay.v2 (bar replay provisional)',paper:'Stocks broker / unified USD ledger',decision:'CONSOLIDATE',blockers:['Daily equities research and Stocks share instruments; execution book and data venue remain distinct']},
 {id:'kalshi',role:'TRADING',provider:'kalshi',kind:'OrderBook',evaluator:'prediction-episodes.v1',paper:'depth-based proposal through shared governor',decision:'COLLECT_FIRST',blockers:['Timestamped depth, rule history and observed settlement outcomes required']},
 {id:'polymarket',role:'TRADING',provider:'polymarket',kind:'OrderBook',evaluator:'international CLOB executable replay',paper:'manual core paper proposals',decision:'COLLECT_FIRST',blockers:['International product access and independent after-cost edge remain unqualified']},
 {id:'polymarket-us',role:'TRADING',fitness:'polymarket',evaluator:'combo replay PROVISIONAL',paper:'shadow only; no research authority for real RFQs',decision:'PARK',blockers:['Requires actual joint RFQ evidence, beta access, expiry/failure/void outcomes; multiplied leg probabilities cannot qualify']},
 {id:'arbitrage',role:'RESEARCH',evaluator:'rule equivalence + synchronized size-aware books + failed-leg scenarios',paper:'manual independent legs only',decision:'IMPROVE_NOW',blockers:['Fills are non-atomic; funding duration and settlement disagreement remain unresolved']},
 {id:'market-lab',role:'RESEARCH',evaluator:'market-replay.v2',paper:'registry evidence only',decision:'IMPROVE_NOW',blockers:['Closed outcomes and verified evaluator identity required; synthetic rows cannot qualify']},
 {id:'macro',role:'INFORMATION',provider:'fred',kind:'EconomicRelease',evaluator:'availability/vintage validation; predictive ablation pending',paper:'context only',decision:'INFORMATION_ONLY',blockers:['Latest revised FRED values are not historical as-of evidence']},
 {id:'edgar',role:'INFORMATION',provider:'sec',kind:'Filing',evaluator:'acceptance-time facts, cited summaries; ablation pending',paper:'context only',decision:'INFORMATION_ONLY',blockers:['Declared SEC contact required; AI text is not a probability forecast']},
 {id:'weather',role:'INFORMATION',provider:'nws',kind:'WeatherAlert',evaluator:'station/date/rule mapping; ablation pending',paper:'context only',decision:'INFORMATION_ONLY',blockers:['Forecast revisions and station-specific settlement labels required']},
 {id:'sports',role:'INFORMATION',kind:'SportsEvent',evaluator:'event identity and schedule validation; ablation pending',paper:'context only',decision:'INFORMATION_ONLY',blockers:['Overtime, draw and postponement rules must match; unsupported families stay related']},
 {id:'wire',role:'INFORMATION',kind:'NewsEvent',evaluator:'first receipt and revision availability',paper:'context only',decision:'INFORMATION_ONLY',blockers:['Rules-based links have no measured predictive contribution yet']},
 {id:'whale-watch',role:'INFORMATION',provider:'solana',kind:'Wallet',evaluator:'public wallet flow heuristics',paper:'context only',decision:'INFORMATION_ONLY',blockers:['Attribution uncertain; transfers/wash flow and achievable copy delay need validation']},
 {id:'infrastructure',role:'OPERATIONS',evaluator:'ledger invariants, recovery, lease and bridge compatibility',paper:'risk, accounting and stop controls',decision:'IMPROVE_NOW',blockers:['USD marked valuation excludes unconverted currencies and unreconciled legacy books']},
]);

export function moduleCapabilities(store,{dataDir=null,now=Date.now()}={}){
 const counts=store.db.prepare('SELECT kind,provider,COUNT(*) n,MAX(available_at) last FROM entities GROUP BY kind,provider').all();
 return MODULE_CONTRACTS.map(c=>{
   let fitness=null;
   if(dataDir&&(c.fitness||c.id==='solana'))try{const f=path.join(dataDir,'lab-link','fitness',(c.fitness||c.id)+'.json');if(fs.statSync(f).size<=65536)fitness=JSON.parse(fs.readFileSync(f,'utf8'));}catch{}
   const rows=c.kind?counts.filter(r=>r.kind===c.kind&&(!c.provider||r.provider===c.provider)):[];
   const last=rows.length?Math.max(...rows.map(r=>r.last)):null,observations=rows.reduce((s,r)=>s+r.n,0);
   const at=fitness?.updatedAt??last,age=at==null?null:now-at,fresh=age!==null&&age>=0&&age<=300000;
   return {...c,implemented:true,collection:{state:at==null?'NO_OBSERVED_DATA':fresh?'RECENT_OBSERVATIONS':'STALE_OBSERVATIONS',observations:fitness?.evidence?.closes??observations,at,ageMs:age},
     validated:false,evidenceReady:fitness?.mayPropose?.ok===true&&fresh,appliedStrategy:fitness?.running??null,proposal:fitness?.proposal??null,trial:fitness?.trial??null,
     decision:fitness?.verdict==='PARK'?'PARK':c.decision,blockers:[...new Set([...c.blockers,...(fitness?.blockers||[])])],
     monitored:'capability matrix / provider health / fitness where implemented',installed:'VERIFY_RUNTIME_BUILD_PROVENANCE'};
 });
}
