// Thin daemon entry for the evolution service. All generation logic lives in
// src/evolutionEngine.js (importable without side effects); this file only owns the
// process loop, the --once mode and the desktop supervisor's stdin contract.
import { furnaceProfile, beastProfile, runGeneration, publishError, closePool } from './evolutionEngine.js';

const once = process.argv.includes('--once');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main(){
  console.log('MONEY PRINTER OS // EVOLUTION SERVICE');
  do {
    const started=Date.now();
    try { await runGeneration(); }
    catch(e){ publishError(e.message||e); console.error(e); }
    if(once) break;
    const profile=furnaceProfile(), beast=beastProfile(profile);
    if(beast.enabled){
      // BEAST already bounds batch size/resource use. Rest briefly for event-loop/IO
      // fairness, but do not force a 1s dead period after sub-second CUDA work.
      await sleep(beast.restMs);
    }else{
      const waitMs=profile.enabled?profile.intervalMs:Math.max(30_000,Number(process.env.EVOLUTION_INTERVAL_MS||120_000));
      await sleep(Math.max(1000,waitMs-(Date.now()-started)));
    }
  } while(true);
  // Release the persistent worker pool so a --once run exits on its own.
  await closePool();
}

if (process.env.MONEY_PRINTER_SUPERVISED === '1') {
  // Exit when the desktop supervisor's stdin pipe closes (supervisor died); never outlive it.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.resume();
}
main();
