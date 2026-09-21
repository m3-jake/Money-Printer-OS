import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-api-econ-'));
process.env.MONEY_PRINTER_DATA_DIR=dataDir;
process.env.HELIUS_API_KEY='test-key';
process.env.HELIUS_REQUESTS_PER_MINUTE='2';
process.env.HELIUS_COST_PER_REQUEST_USD='0.0015';

const savedFetch=globalThis.fetch;
let calls=[];
globalThis.fetch=async url=>{
  calls.push(String(url));
  if(String(url).startsWith('https://api.helius.xyz/'))return Response.json([]);
  throw Error(`unexpected network call ${url}`);
};

const {indexMintTransactions,transactionIndexerHealth}=await import('../src/transactionIndexer.js');
const {apiUnitEconomicsSnapshot,resetApiUnitEconomicsForTests}=await import('../src/apiUnitEconomics.js');

test.after(()=>{globalThis.fetch=savedFetch;fs.rmSync(dataDir,{recursive:true,force:true})});

test('Helius indexing uses the configured cap and explicit request cost accounting',async()=>{
  resetApiUnitEconomicsForTests();calls=[];
  assert.deepEqual(await indexMintTransactions('mint-a',10),[]);
  assert.deepEqual(await indexMintTransactions('mint-b',10),[]);
  const blocked=await indexMintTransactions('mint-c',10);
  assert.match(blocked.error,/request budget exhausted \(2\/min\)/);
  assert.equal(calls.length,2,'cap rejects before a third external transport');
  const health=transactionIndexerHealth().helius;
  assert.equal(health.requests,2);assert.equal(health.budgetRejects,1);assert.equal(health.requestsPerMinute,2);
  const econ=apiUnitEconomicsSnapshot().providers.helius;
  assert.equal(econ.requests,2);assert.equal(econ.capRejects,1);assert.equal(econ.pricedRequests,2);assert.equal(econ.unpricedRequests,0);
  assert.equal(econ.configuredCostUsd,.003);
  assert.equal(econ.purposes.index.pricedRequests,2);
  assert.equal(econ.purposes.index.configuredCostUsd,.003);
});
