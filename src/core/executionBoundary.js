import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let active=false;
export function activateExecutionBoundary(){active=true;}

// Consult durable state on every dispatch, including from a different process.
// No cached halt flag; cancellation and read-only reconciliation remain possible.
export function assertGlobalTradingNotHalted({dataDir=process.env.MONEY_PRINTER_DATA_DIR||'data'}={}) {
  const file=path.resolve(dataDir,'mpos-core.sqlite');
  if(!fs.existsSync(file))return;
  let db;
  try{
    db=new DatabaseSync(file,{readOnly:true});
    const state=db.prepare('SELECT halted FROM risk_control WHERE id=1').get();
    if(!state||state.halted)throw Object.assign(new Error('Risk Governor HALTED: order submission is disabled'),{code:'GLOBAL_HALT'});
  }catch(error){if(error.code==='GLOBAL_HALT')throw error;throw Object.assign(new Error('Risk Governor unavailable: order submission refused'),{code:'RISK_UNAVAILABLE'});}
  finally{db?.close();}
}

export function assertLiveDispatchAllowed(options={}) {
  assertGlobalTradingNotHalted(options);
  const file=path.resolve(options.dataDir||process.env.MONEY_PRINTER_DATA_DIR||'data','mpos-core.sqlite');
  // Standalone legacy adapter tests/tools retain their existing local gates. Every MPOS
  // runtime activates this boundary before services start. Its account migration is
  // deliberately fail-closed: there is no UI switch or environment flag to bypass it.
  if(active||fs.existsSync(file))throw Object.assign(new Error('Risk Governor: live accounts are not reconciled into the common ledger; live submission is locked'),{code:'LIVE_ACCOUNT_NOT_RECONCILED'});
}
