import {cfg} from './config.js';
import {ensureResearch,nightlyResearch,updateExperiments,evolutionSnapshot} from './research.js';
import { assessPortfolioRisk } from './portfolioRisk.js';
import { regimesForTick, routeDecision } from './regime.js';
import { isAggressivePaper } from './runtime.js';
import { appendJournal } from './store.js';
function normalizedStrategy(a){const raw=String(a.strategy||a.dominantSignal||'').toLowerCase();return /mean|revert/.test(raw)?'mean-reversion':/momentum|breakout|trend/.test(raw)?'momentum':/defen|hedge/.test(raw)?'defensive':null}
export function supervisorTick(s,ranked=[]){
 ensureResearch(s);updateExperiments(s,ranked);nightlyResearch(s);const now=Date.now();s.system.workerHealth=s.system.workerHealth||{};
 for(const n of ['DISCOVERY','MARKET_DATA','WALLET_INTEL','SCORING','STRATEGIES','SIMULATOR','RESEARCH','EXECUTION','DASHBOARD','WATCHDOG'])s.system.workerHealth[n]={status:'ONLINE',heartbeat:now};
 const lag=s.system.lastCycle?now-s.system.lastCycle:0;s.system.diagnostics=[];if(lag>60000)s.system.diagnostics.push({level:'WARN',code:'STALE_CYCLE',message:`scanner cycle stale ${Math.round(lag/1000)}s`});
 for(const [name,f] of Object.entries(s.research.feedStats||{}))if(!['unknown','cache'].includes(name)&&Number(f.lastSeen||0)>0&&now-Number(f.lastSeen)>120000)s.system.diagnostics.push({level:'WARN',code:'FEED_STALE',message:`${name} has been silent`});
 if((s.rpcHealth||[]).length&&!s.rpcHealth.some(x=>x.ok))s.system.diagnostics.push({level:cfg.mode==='live'?'ERROR':'INFO',code:'RPC_DOWN',message:cfg.mode==='live'?'all RPC endpoints unhealthy':'RPC risk enrichment unavailable; paper scanner continues normally with partial safeguards'});
 s.system.health=s.system.diagnostics.some(x=>x.level==='ERROR')?'DEGRADED':s.system.diagnostics.some(x=>x.level==='WARN')?'CAUTION':'HEALTHY';
 s.system.portfolioRisk=ranked.slice(0,30).map(a=>({mint:a.mint,...assessPortfolioRisk(s,a)}));
 const returns=ranked.map(x=>Number(x.pc5||0)),breadth=returns.length?returns.filter(x=>x>0).length/returns.length*100:0,volatility=returns.length?returns.reduce((q,x)=>q+Math.abs(x),0)/returns.length:0;
 s.system.regimes=regimesForTick(ranked,{...s.system.assetRegimeInputs,memecoin:{returnPct:s.market?.changePct??(returns.reduce((q,x)=>q+x,0)/Math.max(1,returns.length)),volatilityPct:s.market?.volatilityPct??volatility,breadthPct:s.market?.breadthPct??breadth}});
 const enforceRegime=isAggressivePaper(s.runtime,cfg.mode);
 const decisions=ranked.map(a=>{const assetClass=a.assetClass||'memecoin',decision=routeDecision({assetClass,strategy:enforceRegime?normalizedStrategy(a):null,regimes:s.system.regimes,now});a.routeDecision={...decision,regimeEnforced:enforceRegime};return {...a.routeDecision,mint:a.mint,symbol:a.symbol,eligible:!!a.eligible}});
 s.system.routeDecisions=decisions.slice(0,300);
 for(const d of decisions.filter(x=>x.eligible))appendJournal({type:'central-route-decision',...d});
 s.evolution=evolutionSnapshot(s);return s;
}
