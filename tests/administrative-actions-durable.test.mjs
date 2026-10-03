import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-admin-durable-'));
Object.assign(process.env,{MONEY_PRINTER_DATA_DIR:dir,MODE:'paper',MPO_LAB_LINK:'false',POLYMARKET_AUTOSTART:'false',ROBINHOOD_AUTOSTART:'false'});
const nativeFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('network forbidden in administrative persistence tests')};
const Store=await import('../src/store.js');
const {actions,persistAdministrativeControls}=await import('../src/index.js');
test.after(()=>{globalThis.fetch=nativeFetch;fs.rmSync(dir,{recursive:true,force:true})});
test('accepted administrative controls survive a later aborted cycle and are not replayed from pending actions',async()=>{
 const initial=Store.loadState();initial.runtime.profile='FAIR';Store.saveState(initial);
 Store.enqueueAction({id:'steady',type:'profile',profile:'FAST_PAPER_STEADY'});
 Store.enqueueAction({id:'pause',type:'toggle-pause'});Store.enqueueAction({id:'kill',type:'toggle-kill'});
 const cycleState=Store.loadState();await actions(cycleState);
 // Deliberately abandon this cycle's in-memory state before the usual final save.
 const restarted=Store.loadState();assert.equal(restarted.runtime.profile,'FAST_PAPER_STEADY');assert.equal(restarted.runtime.followLabBest,false);assert.equal(restarted.system.paused,true);assert.equal(restarted.system.killSwitch,true);assert.equal(restarted.system.lastAction.durable,true);
 assert.deepEqual(Store.drainActions(),[]);await actions(restarted);assert.equal(restarted.system.killSwitch,true);
});
test('a profile queued after a held-position exit is durable while that earlier network action remains pending',async()=>{
 let release,arrived;const gate=new Promise(r=>release=r),networkStarted=new Promise(r=>arrived=r);
 globalThis.fetch=async()=>{arrived();await gate;return Response.json({pairs:[]})};
 Store.enqueueAction({id:'exit-before-profile',type:'exit',mint:'AdminHeldMint111111111111111111111111'});
 Store.enqueueAction({id:'fair-durable',type:'profile',profile:'FAIR'});
 const cycleState=Store.loadState();cycleState.positions=[{mint:'AdminHeldMint111111111111111111111111',pairAddress:'AdminHeldPool111111111111111111111111',lastPrice:1,entryPrice:1}];
 const work=actions(cycleState).catch(()=>{});
 try{await networkStarted;assert.equal(Store.loadState().runtime.profile,'FAIR');assert.deepEqual(Store.loadState().positions,[],'control publication does not overwrite persisted exposure with stale cycle positions');}
 finally{release();await work;globalThis.fetch=async()=>{throw new Error('network forbidden in administrative persistence tests')};}
});
test('control-only publication preserves newer persisted positions/cash and unrelated runtime values',()=>{
 const before={runtime:{profile:'FAIR',favorites:[]},system:{paused:false,killSwitch:false},autonomyLevel:0};
 const stale={runtime:{profile:'FAST_PAPER_STEADY',favorites:[]},system:{paused:false,killSwitch:false,lastAction:{type:'profile'}},research:{autonomyLevel:0},cashSol:999,positions:[{id:'stale'}]};
 const latest={runtime:{profile:'FAIR',favorites:['new-pin'],newSetting:123},system:{paused:false,killSwitch:false,health:'CAUTION'},research:{autonomyLevel:0},cashSol:4,positions:[{id:'newer-position',quantity:7}],history:[{id:'settled'}],pendingActions:[]};
 let saved;persistAdministrativeControls(stale,before,{id:'profile',type:'profile'},{load:()=>structuredClone(latest),save:s=>{saved=s}});
 assert.equal(saved.cashSol,4);assert.deepEqual(saved.positions,latest.positions);assert.deepEqual(saved.history,latest.history);assert.equal(saved.runtime.newSetting,123);assert.deepEqual(saved.runtime.favorites,['new-pin']);assert.equal(saved.runtime.profile,'FAST_PAPER_STEADY');assert.equal(saved.system.health,'CAUTION');
});
