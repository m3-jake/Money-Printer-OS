import fs from 'node:fs';
import { cfg } from './config.js';
import { benchmarkRpcs } from './rpc.js';
import { loadState } from './store.js';
import { edgeProofSnapshot } from './edgeProof.js';

const s = loadState();
const nodeMajor = Number(process.versions.node.split('.')[0]);
console.log('MONEY PRINTER OS · EDGE PROVER DOCTOR');
console.log('Node', process.versions.node, nodeMajor >= 22 ? 'OK' : 'UPDATE REQUIRED (22+)');
console.log('mode', cfg.mode, 'live gate', cfg.enableLiveTrading, 'jito', cfg.jitoEnabled, 'direct stream', cfg.directStreamEnabled);
console.log('autonomy level', s.research?.autonomyLevel, 'system health', s.system?.health || 'UNKNOWN');
console.log('state', fs.existsSync('data/state.json') ? 'present' : 'fresh', 'backup', fs.existsSync('data/state.backup.json') ? 'present' : 'none');
console.log('journal', fs.existsSync('data/market.ndjson') ? `${(fs.statSync('data/market.ndjson').size / 1024 / 1024).toFixed(1)} MB` : 'fresh');
console.log('Jupiter key', cfg.jupiterApiKey ? 'configured' : 'missing');
console.log('Alpha worker', cfg.alphaWorkerEnabled ? 'enabled' : 'disabled', 'tx min EDGE', cfg.alphaTxMinEdge);
console.log('Transaction feed', cfg.txFeedUrl ? 'custom configured' : cfg.heliusApiKey ? 'Helius configured' : 'public RPC fallback');
const proof=edgeProofSnapshot();console.log('EDGE proof', proof.status, `${proof.proofScore}%`, 'independent launches', proof.independentMints, 'production learning', proof.productionLearningUnlocked?'UNLOCKED':'LOCKED');console.log('EDGE next', proof.nextAction||'collect data');
console.log('Social feed', cfg.socialFeedUrl || 'not configured');
console.log('Program IDs', cfg.programLogIds.length ? cfg.programLogIds : 'not configured');
if (cfg.mode === 'live' && !cfg.jupiterApiKey) console.log('WARN: live mode selected without JUPITER_API_KEY');
if (cfg.mode === 'live' && !cfg.privateKey) console.log('WARN: live mode selected without BS58_PRIVATE_KEY');
if (cfg.scanIntervalSec < 1) console.log('WARN: SCAN_INTERVAL_SEC below 1 is clamped by the runtime loop');
try {
  console.table(await benchmarkRpcs());
} catch (error) {
  console.log('RPC benchmark failed:', error.message);
}
for (const d of s.system?.diagnostics || []) console.log(d.level, d.code, d.message);
