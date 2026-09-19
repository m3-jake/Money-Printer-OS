import { parentPort, threadId } from 'node:worker_threads';
import { packDataset, datasetFromMessage, scoreVariantPacked, mulberry32, MC_ROUNDS_WORKER } from './evolutionScoring.js';

// One resident dataset per worker. The pool posts it once per generation as
// SharedArrayBuffer-backed Float64Arrays; chunk messages then carry only variants.
let current=null;

parentPort.on('message', msg => {
  if (msg && msg.type === 'dataset') { current = datasetFromMessage(msg.dataset); return; }

  if (msg && msg.type === 'score') {
    const { jobId, datasetId, startIndex = 0, variants = [], rounds = MC_ROUNDS_WORKER, seed = null } = msg;
    if (!current || current.id !== datasetId) { parentPort.postMessage({ type: 'error', jobId, error: 'unknown dataset' }); return; }
    try {
      const metrics = variants.map((v, i) => scoreVariantPacked(v, current, {
        rounds,
        rng: seed == null ? Math.random : mulberry32((seed + startIndex + i) >>> 0),
      }));
      parentPort.postMessage({ type: 'scored', jobId, startIndex, metrics, threadId });
    } catch (e) {
      parentPort.postMessage({ type: 'error', jobId, error: String(e && e.message || e) });
    }
    return;
  }

  // Legacy protocol kept byte-compatible for src/clusterWorker.js: {variants, rows} -> [{variant, metrics}].
  const { variants = [], rows = [] } = msg || {};
  const ds = packDataset(rows, { shared: false });
  parentPort.postMessage(variants.map(variant => ({ variant, metrics: scoreVariantPacked(variant, ds, { rounds: MC_ROUNDS_WORKER }) })));
});
