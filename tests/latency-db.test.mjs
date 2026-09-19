import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-latency-db-'));
process.env.MONEY_PRINTER_DATA_DIR=dir;
const {alphaDb,closeAlphaDb,insertLatency,updateLatencyStage}=await import('../src/alphaDb.js');
test.after(()=>{closeAlphaDb();fs.rmSync(dir,{recursive:true,force:true})});
test('database records stage wait separately and duplicate events retain first measurement',()=>{
 insertLatency({mint:'sample',sourceEventTs:1000,discoveredTs:90000});
 updateLatencyStage('sample','READY',90100);updateLatencyStage('sample','PROPOSAL',90200);
 updateLatencyStage('sample','PROPOSAL',95000);
 const row=alphaDb().prepare('SELECT * FROM latency_events WHERE mint=?').get('sample');
 assert.equal(row.wait_ms,100);assert.equal(row.proposal_ms,89200);assert.equal(row.proposal_ts,90200);
});
test('ready after proposal remains unmeasured rather than fabricating a wait',()=>{
 insertLatency({mint:'out-of-order',sourceEventTs:1000,discoveredTs:90000});
 updateLatencyStage('out-of-order','PROPOSAL',90200);updateLatencyStage('out-of-order','READY',90500);
 updateLatencyStage('out-of-order','PROPOSAL',91000);
 const row=alphaDb().prepare('SELECT * FROM latency_events WHERE mint=?').get('out-of-order');
 assert.equal(row.wait_ms,null);assert.equal(row.proposal_ts,90200);
});
