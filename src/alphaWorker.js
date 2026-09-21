import { drainAlphaEvents } from './alphaQueue.js';
import { insertObservation,upsertTxEvent,upsertFunding,upsertAuthority,settleRetention,detectCapitalMigrations,insertOutcome,insertLatency,updateLatencyStage,insertExecutionCalibration,alphaDb,dbStats,alphaTransaction } from './alphaDb.js';
import { indexMintTransactions,indexWalletFunding } from './transactionIndexer.js';
import { cfg } from './config.js';
import { writeEdgeProof } from './edgeProof.js';
import { writeAlphaInsights } from './alphaInsights.js';
import { writeDailyAlphaReport } from './dailyAlphaReport.js';
import { mineHypotheses } from './hypothesisMiner.js';
import { persistApiUnitEconomics } from './apiUnitEconomics.js';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function refreshFundingClusters(){const d=alphaDb();try{d.exec(`UPDATE token_observations SET cluster_id=COALESCE((SELECT wf.funder FROM wallet_token_positions wp JOIN wallet_funding wf ON wf.wallet=wp.wallet WHERE wp.mint=token_observations.mint ORDER BY wp.first_buy_ts ASC,wf.first_ts ASC LIMIT 1),authority,cluster_id) WHERE cluster_id IS NULL OR cluster_id=authority`)}catch{}}

const indexed=new Map(),fundingIndexed=new Map();
let txDirty=false,fundingDirty=false,proofDirty=true;
const enrichmentQueue=[];let enrichmentActive=0;const ENRICHMENT_CONCURRENCY=3,MAX_ENRICHMENT_BACKLOG=500;const queuedMints=new Set();
function scheduleEnrichment(mint,job){if(queuedMints.has(mint)||enrichmentQueue.length>=MAX_ENRICHMENT_BACKLOG)return false;queuedMints.add(mint);enrichmentQueue.push({mint,job});pumpEnrichment();return true}
function pumpEnrichment(){while(enrichmentActive<ENRICHMENT_CONCURRENCY&&enrichmentQueue.length){const {mint,job}=enrichmentQueue.shift();enrichmentActive++;Promise.resolve().then(job).catch(err=>console.error('alpha enrichment',err.message)).finally(()=>{queuedMints.delete(mint);enrichmentActive--;pumpEnrichment()})}}
async function enrichCandidate(observation){
 const result=await indexMintTransactions(observation.mint,80);const events=Array.isArray(result)?result:(result.events||[]);
 for(const x of events){if(x.funding){upsertFunding(x.funder,x.wallet,x.ts,x.sol);fundingDirty=true;continue}upsertTxEvent(x);txDirty=true;if(x.side==='BUY'&&x.wallet&&Date.now()-(fundingIndexed.get(x.wallet)||0)>24*3600_000){fundingIndexed.set(x.wallet,Date.now());for(const f of await indexWalletFunding(x.wallet,x.ts,25)){upsertFunding(f.funder,f.wallet,f.ts,f.sol);fundingDirty=true}}}
 try{persistApiUnitEconomics('alpha-worker')}catch{}
}
function processEvent(e){
 if(e.type==='candidate'){
  insertObservation(e.observation);if(e.latency)insertLatency(e.latency);if(e.observation.authority)upsertAuthority(e.observation.authority,e.observation.mint,e.ts);
  const last=indexed.get(e.observation.mint)||0;if(Date.now()-last>5*60_000&&Number(e.observation.edge||0)>=cfg.alphaTxMinEdge){if(scheduleEnrichment(e.observation.mint,()=>enrichCandidate(e.observation)))indexed.set(e.observation.mint,Date.now())}
 }else if(e.type==='outcome'){insertOutcome(e.outcome);proofDirty=true}
 else if(e.type==='latency-stage')updateLatencyStage(e.mint,e.kind,e.ts);
 else if(e.type==='tx'){if(e.event?.funding){upsertFunding(e.event.funder,e.event.wallet,e.event.ts,e.event.sol);fundingDirty=true}else{upsertTxEvent(e.event);txDirty=true}}
 else if(e.type==='execution-calibration'){insertExecutionCalibration(e.calibration||{});proofDirty=true}
}
async function run(){alphaDb();let lastMine=Date.now(),lastHouse=0,lastReport=0;for(;;){const xs=drainAlphaEvents(1000);if(xs.length){try{alphaTransaction(()=>{for(const e of xs){try{processEvent(e)}catch(err){console.error('alpha event',err.message)}}})}catch(err){console.error('alpha batch',err.message)}}if(Date.now()-lastHouse>30_000){settleRetention();if(txDirty){detectCapitalMigrations();txDirty=false}if(fundingDirty){refreshFundingClusters();fundingDirty=false;proofDirty=true}lastHouse=Date.now()}if(proofDirty&&Date.now()-lastMine>120_000){try{mineHypotheses(alphaDb());const proof=writeEdgeProof();writeAlphaInsights();console.log(`EDGE PROVER ${proof.status} // ${proof.proofScore}% // n=${proof.independentMints}`);proofDirty=false}catch(e){console.error('hypothesis/proof mining',e.message)}lastMine=Date.now()}if(Date.now()-lastReport>24*3600_000){try{writeDailyAlphaReport()}catch(e){console.error('daily alpha report',e.message)}lastReport=Date.now()}await sleep(xs.length?100:1500)}}
run().catch(e=>{console.error(e);process.exitCode=1});
