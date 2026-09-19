import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { summarizeLatencyRows } from './latencyStats.js';

const dataDir=path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data');
fs.mkdirSync(dataDir,{recursive:true});
const dbPath=path.join(dataDir,'alpha-lab.sqlite');
let db;
const stmtCache=new Map();
function stmt(sql){let x=stmtCache.get(sql);if(!x){x=alphaDb().prepare(sql);stmtCache.set(sql,x)}return x}
export function alphaTransaction(fn){const d=alphaDb();d.exec('BEGIN IMMEDIATE');try{const out=fn();d.exec('COMMIT');return out}catch(e){try{d.exec('ROLLBACK')}catch{}throw e}}

export function alphaDb(){
  if(db)return db;
  db=new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;
  CREATE TABLE IF NOT EXISTS token_observations(
    id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, mint TEXT NOT NULL, symbol TEXT, regime TEXT,
    price REAL, liquidity REAL, edge REAL, explosion REAL, moon REAL, execution REAL,
    momentum5 REAL, velocity REAL, flow_accel REAL, crowding REAL, holder_quality REAL,
    retention60 REAL, authority TEXT, cluster_id TEXT, source TEXT, raw_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_obs_mint_ts ON token_observations(mint,ts);
  CREATE INDEX IF NOT EXISTS idx_obs_ts ON token_observations(ts);
  CREATE TABLE IF NOT EXISTS tx_events(
    signature TEXT NOT NULL, event_index INTEGER NOT NULL, ts INTEGER, slot INTEGER, mint TEXT,
    wallet TEXT, side TEXT, token_delta REAL, sol_delta REAL, source TEXT, raw_json TEXT,
    PRIMARY KEY(signature,event_index)
  );
  CREATE INDEX IF NOT EXISTS idx_tx_wallet_ts ON tx_events(wallet,ts);
  CREATE INDEX IF NOT EXISTS idx_tx_mint_ts ON tx_events(mint,ts);
  CREATE TABLE IF NOT EXISTS wallet_funding(
    funder TEXT NOT NULL, wallet TEXT NOT NULL, first_ts INTEGER, last_ts INTEGER, transfers INTEGER DEFAULT 0, sol REAL DEFAULT 0,
    PRIMARY KEY(funder,wallet)
  );
  CREATE TABLE IF NOT EXISTS wallet_token_positions(
    wallet TEXT NOT NULL, mint TEXT NOT NULL, first_buy_ts INTEGER, first_buy_amount REAL DEFAULT 0, initial_bought REAL DEFAULT 0, net_tokens REAL DEFAULT 0,
    last_ts INTEGER, retained30 REAL, retained60 REAL, retained300 REAL, PRIMARY KEY(wallet,mint)
  );
  CREATE TABLE IF NOT EXISTS authority_tokens(authority TEXT NOT NULL,mint TEXT NOT NULL,first_ts INTEGER,last_ts INTEGER,PRIMARY KEY(authority,mint));
  CREATE TABLE IF NOT EXISTS capital_migrations(
    id INTEGER PRIMARY KEY, wallet TEXT, from_mint TEXT, to_mint TEXT, sell_ts INTEGER, buy_ts INTEGER, gap_ms INTEGER,
    sold_tokens REAL, bought_tokens REAL, UNIQUE(wallet,from_mint,to_mint,sell_ts,buy_ts)
  );
  CREATE TABLE IF NOT EXISTS outcomes(
    mint TEXT NOT NULL, horizon_min INTEGER NOT NULL, entry_ts INTEGER NOT NULL, raw_return REAL, adjusted_return REAL,
    regime TEXT, edge REAL, execution REAL, liquidity REAL, cluster_id TEXT, PRIMARY KEY(mint,horizon_min,entry_ts)
  );
  CREATE TABLE IF NOT EXISTS hypothesis_results(
    id TEXT PRIMARY KEY, updated_ts INTEGER, title TEXT, feature TEXT, regime TEXT, samples INTEGER, clusters INTEGER,
    delta REAL, ci_low REAL, ci_high REAL, p_positive REAL, status TEXT, payload_json TEXT
  );
  CREATE TABLE IF NOT EXISTS latency_events(
    id INTEGER PRIMARY KEY, ts INTEGER, mint TEXT, source_event_ts INTEGER, discovered_ts INTEGER, analyzed_ts INTEGER,
    ready_ts INTEGER, proposal_ts INTEGER, discovery_ms INTEGER, analysis_ms INTEGER, ready_ms INTEGER, proposal_ms INTEGER
  );
  CREATE TABLE IF NOT EXISTS execution_calibration(
    id INTEGER PRIMARY KEY, ts INTEGER, mint TEXT, kind TEXT, provider TEXT, predicted_slippage_bps REAL, observed_slippage_bps REAL,
    predicted_failure_pct REAL, observed_failed INTEGER DEFAULT 0, payload_json TEXT
  );
  CREATE TABLE IF NOT EXISTS alpha_meta(k TEXT PRIMARY KEY,v TEXT);
  CREATE INDEX IF NOT EXISTS idx_outcomes_horizon_mint_entry ON outcomes(horizon_min,mint,entry_ts);
  CREATE INDEX IF NOT EXISTS idx_outcomes_cluster_horizon ON outcomes(cluster_id,horizon_min);
  CREATE INDEX IF NOT EXISTS idx_tx_side_ts ON tx_events(side,ts);
  CREATE INDEX IF NOT EXISTS idx_latency_ts ON latency_events(ts);
  CREATE INDEX IF NOT EXISTS idx_exec_cal_ts ON execution_calibration(ts);
  CREATE INDEX IF NOT EXISTS idx_hypothesis_status ON hypothesis_results(status,ci_low);
  CREATE INDEX IF NOT EXISTS idx_obs_cluster_mint_ts ON token_observations(cluster_id,mint,ts);
  `);
  try{db.exec(`ALTER TABLE wallet_token_positions ADD COLUMN first_buy_amount REAL DEFAULT 0`)}catch{}
  try{db.exec(`ALTER TABLE latency_events ADD COLUMN wait_ms INTEGER`)}catch{}
  return db;
}

export function closeAlphaDb(){try{db?.close()}catch{}db=null;stmtCache.clear()}

export function insertObservation(o){
 const d=alphaDb();
 stmt(`INSERT INTO token_observations(ts,mint,symbol,regime,price,liquidity,edge,explosion,moon,execution,momentum5,velocity,flow_accel,crowding,holder_quality,retention60,authority,cluster_id,source,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  o.ts,o.mint,o.symbol||'',o.regime||'UNKNOWN',o.price||0,o.liquidity||0,o.edge||0,o.explosion||0,o.moon||0,o.execution||0,o.momentum5||0,o.velocity||0,o.flowAccel||0,o.crowding||0,o.holderQuality??null,o.retention60??null,o.authority||null,o.clusterId||null,o.source||null,JSON.stringify(o.raw||{})
 );
}

export function upsertTxEvent(e){
 const d=alphaDb();
 stmt(`INSERT OR IGNORE INTO tx_events(signature,event_index,ts,slot,mint,wallet,side,token_delta,sol_delta,source,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(e.signature,e.eventIndex,e.ts||0,e.slot||0,e.mint||'',e.wallet||'',e.side||'UNKNOWN',e.tokenDelta||0,e.solDelta||0,e.source||'',JSON.stringify(e.raw||{}));
 if(e.wallet&&e.mint&&e.tokenDelta){
   const prev=stmt(`SELECT * FROM wallet_token_positions WHERE wallet=? AND mint=?`).get(e.wallet,e.mint)||{};
   const firstBuy=!prev.first_buy_ts&&e.tokenDelta>0, initial=Number(prev.initial_bought||0)+(e.tokenDelta>0?e.tokenDelta:0), net=Number(prev.net_tokens||0)+e.tokenDelta,firstAmount=Number(prev.first_buy_amount||0)||(firstBuy?Number(e.tokenDelta):0);
   stmt(`INSERT INTO wallet_token_positions(wallet,mint,first_buy_ts,first_buy_amount,initial_bought,net_tokens,last_ts) VALUES(?,?,?,?,?,?,?) ON CONFLICT(wallet,mint) DO UPDATE SET first_buy_ts=COALESCE(wallet_token_positions.first_buy_ts,excluded.first_buy_ts),first_buy_amount=CASE WHEN wallet_token_positions.first_buy_amount>0 THEN wallet_token_positions.first_buy_amount ELSE excluded.first_buy_amount END,initial_bought=excluded.initial_bought,net_tokens=excluded.net_tokens,last_ts=excluded.last_ts`).run(e.wallet,e.mint,prev.first_buy_ts||(firstBuy?e.ts:null),firstAmount,initial,net,e.ts||Date.now());
 }
}

export function upsertFunding(funder,wallet,ts,sol){if(!funder||!wallet||funder===wallet)return;alphaDb().prepare(`INSERT INTO wallet_funding(funder,wallet,first_ts,last_ts,transfers,sol) VALUES(?,?,?,?,1,?) ON CONFLICT(funder,wallet) DO UPDATE SET last_ts=excluded.last_ts,transfers=wallet_funding.transfers+1,sol=wallet_funding.sol+excluded.sol`).run(funder,wallet,ts,ts,Math.max(0,Number(sol||0)))}
export function upsertAuthority(authority,mint,ts){if(!authority||!mint)return;alphaDb().prepare(`INSERT INTO authority_tokens(authority,mint,first_ts,last_ts) VALUES(?,?,?,?) ON CONFLICT(authority,mint) DO UPDATE SET last_ts=excluded.last_ts`).run(authority,mint,ts,ts)}

export function settleRetention(now=Date.now()){
 const d=alphaDb();
 const rows=d.prepare(`SELECT * FROM wallet_token_positions WHERE first_buy_amount>0 AND first_buy_ts IS NOT NULL AND (? - first_buy_ts)>=30000 AND (retained30 IS NULL OR ((? - first_buy_ts)>=60000 AND retained60 IS NULL) OR ((? - first_buy_ts)>=300000 AND retained300 IS NULL))`).all(now,now,now);
 const sum=d.prepare(`SELECT COALESCE(SUM(token_delta),0) net FROM tx_events WHERE wallet=? AND mint=? AND ts BETWEEN ? AND ?`);
 const upd=d.prepare(`UPDATE wallet_token_positions SET retained30=COALESCE(retained30,?),retained60=COALESCE(retained60,?),retained300=COALESCE(retained300,?) WHERE wallet=? AND mint=?`);
 for(const r of rows){const ratio=h=>{if(now-r.first_buy_ts<h)return null;const net=Number(sum.get(r.wallet,r.mint,r.first_buy_ts,r.first_buy_ts+h)?.net||0);return Math.max(0,Math.min(300,net/Math.max(1e-12,Number(r.first_buy_amount))*100))};upd.run(ratio(30_000),ratio(60_000),ratio(300_000),r.wallet,r.mint)}
}

export function detectCapitalMigrations(now=Date.now()){
 const d=alphaDb();
 const meta=d.prepare(`SELECT v FROM alpha_meta WHERE k='migration_scan_ts'`).get();
 const previous=Number(meta?.v||0);
 const from=Math.max(now-6*3600_000, previous ? previous-10*60_000 : 0);
 const sells=d.prepare(`SELECT wallet,mint,ts,ABS(token_delta) qty FROM tx_events WHERE side='SELL' AND ts>? AND ts<=? ORDER BY ts DESC LIMIT 2000`).all(from,now);
 const buysStmt=d.prepare(`SELECT wallet,mint,ts,token_delta qty FROM tx_events WHERE wallet=? AND side='BUY' AND ts BETWEEN ? AND ? AND mint<>? ORDER BY ts ASC LIMIT 20`);
 const ins=d.prepare(`INSERT OR IGNORE INTO capital_migrations(wallet,from_mint,to_mint,sell_ts,buy_ts,gap_ms,sold_tokens,bought_tokens) VALUES(?,?,?,?,?,?,?,?)`);
 for(const s of sells){for(const b of buysStmt.all(s.wallet,s.ts,s.ts+10*60_000,s.mint)){ins.run(s.wallet,s.mint,b.mint,s.ts,b.ts,b.ts-s.ts,s.qty,b.qty)}}
 d.prepare(`INSERT INTO alpha_meta(k,v) VALUES('migration_scan_ts',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(String(now));
}

export function insertLatency(o){alphaDb().prepare(`INSERT INTO latency_events(ts,mint,source_event_ts,discovered_ts,analyzed_ts,ready_ts,proposal_ts,discovery_ms,analysis_ms,ready_ms,proposal_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(o.ts||Date.now(),o.mint||'',o.sourceEventTs||null,o.discoveredTs||null,o.analyzedTs||null,o.readyTs||null,o.proposalTs||null,o.discoveryMs??null,o.analysisMs??null,o.readyMs??null,o.proposalMs??null)}

export function updateLatencyStage(mint,kind,ts=Date.now()){
  const d=alphaDb(),r=d.prepare(`SELECT id,source_event_ts,discovered_ts,ready_ts,proposal_ts FROM latency_events WHERE mint=? ORDER BY id DESC LIMIT 1`).get(mint);
  if(!r)return;
  const base=Number(r.source_event_ts||r.discovered_ts||ts);
  if(kind==='READY')d.prepare(`UPDATE latency_events SET ready_ts=COALESCE(ready_ts,?),ready_ms=COALESCE(ready_ms,?) WHERE id=?`).run(ts,Math.max(0,ts-base),r.id);
  if(kind==='PROPOSAL'){
    const ready=Number(r.ready_ts||0);
    const proposal=Number(r.proposal_ts||ts);
    const wait=ready>0&&proposal>=ready?proposal-ready:null;
    d.prepare(`UPDATE latency_events SET proposal_ts=COALESCE(proposal_ts,?),proposal_ms=COALESCE(proposal_ms,?),wait_ms=COALESCE(wait_ms,?) WHERE id=?`).run(ts,Math.max(0,ts-base),wait,r.id);
  }
}

export function insertOutcome(o){alphaDb().prepare(`INSERT OR REPLACE INTO outcomes(mint,horizon_min,entry_ts,raw_return,adjusted_return,regime,edge,execution,liquidity,cluster_id) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(o.mint,o.horizonMin,o.entryTs,o.rawReturn,o.adjustedReturn,o.regime||'UNKNOWN',o.edge||0,o.execution||0,o.liquidity||0,o.clusterId||null)}


export function insertExecutionCalibration(o){alphaDb().prepare(`INSERT INTO execution_calibration(ts,mint,kind,provider,predicted_slippage_bps,observed_slippage_bps,predicted_failure_pct,observed_failed,payload_json) VALUES(?,?,?,?,?,?,?,?,?)`).run(o.ts||Date.now(),o.mint||'',o.kind||'QUOTE',o.provider||'external',Number(o.predictedSlippageBps||0),Number(o.observedSlippageBps||0),Number(o.predictedFailurePct||0),o.observedFailed?1:0,JSON.stringify(o.payload||{}))}

export function dbStats(){const d=alphaDb();const one=q=>Number(d.prepare(q).get()?.n||0);return{observations:one(`SELECT COUNT(*) n FROM token_observations`),txEvents:one(`SELECT COUNT(*) n FROM tx_events`),walletPositions:one(`SELECT COUNT(*) n FROM wallet_token_positions`),fundingEdges:one(`SELECT COUNT(*) n FROM wallet_funding`),migrations:one(`SELECT COUNT(*) n FROM capital_migrations`),outcomes:one(`SELECT COUNT(*) n FROM outcomes`),hypotheses:one(`SELECT COUNT(*) n FROM hypothesis_results`),calibration:one(`SELECT COUNT(*) n FROM execution_calibration`)}}

export function alphaDbSnapshot(){
 const d=alphaDb(),stats=dbStats();
 const hypotheses=d.prepare(`SELECT * FROM hypothesis_results ORDER BY CASE status WHEN 'POSITIVE EVIDENCE' THEN 0 WHEN 'NEGATIVE EVIDENCE' THEN 1 ELSE 2 END, ABS(delta) DESC LIMIT 20`).all();
 const retention=d.prepare(`SELECT COUNT(*) n,AVG(retained60) avg60 FROM wallet_token_positions WHERE retained60 IS NOT NULL`).get();
 const migrations=d.prepare(`SELECT wallet,from_mint,to_mint,gap_ms FROM capital_migrations ORDER BY buy_ts DESC LIMIT 10`).all();
 const authorities=d.prepare(`SELECT authority,COUNT(*) launches FROM authority_tokens GROUP BY authority HAVING launches>1 ORDER BY launches DESC LIMIT 10`).all();
 const funders=d.prepare(`SELECT funder,COUNT(DISTINCT wallet) wallets,SUM(sol) sol FROM wallet_funding GROUP BY funder HAVING wallets>1 ORDER BY wallets DESC,sol DESC LIMIT 10`).all();
 const latencyAvg=d.prepare(`SELECT COUNT(*) samples,AVG(discovery_ms) discovery,AVG(analysis_ms) analysis,AVG(ready_ms) ready,AVG(proposal_ms) proposal FROM latency_events`).get();
 const recentLatency=d.prepare(`SELECT discovery_ms,analysis_ms,ready_ms,proposal_ms,wait_ms,source_event_ts,discovered_ts,ready_ts,proposal_ts FROM latency_events WHERE ts>?`).all(Date.now()-24*3600_000);
 const latencySummary=summarizeLatencyRows(recentLatency);
 const earlyWallets=d.prepare(`SELECT wallet,COUNT(DISTINCT mint) launches,AVG(retained60) retained60 FROM wallet_token_positions GROUP BY wallet HAVING launches>1 ORDER BY launches DESC LIMIT 10`).all();
 return {stats,hypotheses,retention:{samples:Number(retention?.n||0),avg60:Number(retention?.avg60||0)},migrations,authorities,funders,earlyWallets,latency:{samples:Number(latencyAvg?.samples||0),discoveryMs:Number(latencyAvg?.discovery||0),analysisMs:Number(latencyAvg?.analysis||0),readyMs:Number(latencyAvg?.ready||0),proposalMs:Number(latencyAvg?.proposal||0),...latencySummary,allSamples:Number(latencyAvg?.samples||0)},dbPath:path.basename(dbPath)};
}
