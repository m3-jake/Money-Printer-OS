import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Keypair } from '@solana/web3.js';
import { cfg } from '../src/config.js';

// A fake JSON-RPC node: records every method it is asked for and answers from `handlers`.
function rpcServer(handlers) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const { id, method } = JSON.parse(body); seen.push(method);
      const out = handlers[method] ? handlers[method]() : { status: 500, error: { code: -32601, message: `no mock for ${method}` } };
      res.writeHead(out.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.error ? { jsonrpc: '2.0', id, error: out.error } : { jsonrpc: '2.0', id, result: out.result }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}
const key = () => Keypair.generate().publicKey.toBase58();
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ctx = value => ({ result: { context: { slot: 1 }, value } });
const mainHandlers = {
  getAccountInfo: () => ctx({ data: { program: 'spl-token', parsed: { type: 'mint', info: { mintAuthority: null, freezeAuthority: null, decimals: 6, supply: '1000' } }, space: 82 }, executable: false, lamports: 1, owner: TOKEN, rentEpoch: 0, space: 82 }),
  getTokenSupply: () => ctx({ amount: '1000', decimals: 6, uiAmount: 0.001, uiAmountString: '0.001' }),
};
const holderAccount = key(), holderOwner = key();
const holderOk = {
  getTokenLargestAccounts: () => ctx([{ address: holderAccount, amount: '600', decimals: 6, uiAmount: 0.0006, uiAmountString: '0.0006' }]),
  getMultipleAccounts: () => ctx([{ data: { program: 'spl-token', parsed: { type: 'account', info: { owner: holderOwner } }, space: 165 }, executable: false, lamports: 1, owner: TOKEN, rentEpoch: 0, space: 165 }]),
};
const HOLDER_METHODS = ['getTokenLargestAccounts', 'getMultipleAccounts'];
let n = 0;
// Each case gets a fresh rpc.js instance (its circuit breaker and counters are module state) built from `over`.
async function freshRpc(over) { Object.assign(cfg, { backupRpcUrls: [] }, over); return import(`../src/rpc.js?case=${++n}`); }

test('a 429 from the holder RPC is counted and reported, not swallowed', async () => {
  const main = await rpcServer(mainHandlers);
  const holder = await rpcServer({ getTokenLargestAccounts: () => ({ status: 429, error: { code: 429, message: 'Too many requests for a specific RPC call' } }) });
  try {
    const rpc = await freshRpc({ rpcUrl: main.url, holderRpcUrl: `${holder.url}/?api-key=SECRET123`, holderRpcDailyCalls: 100 });
    const risk = await rpc.mintRisk(key());
    assert.equal(risk.holderDataUnavailable, true);
    assert.ok(risk.flags.includes('holder-data-unavailable'));
    const h = rpc.holderRpcHealth();
    assert.equal(h.status, 'RATE_LIMITED');
    assert.equal(h.rateLimited, 1);
    assert.equal(h.dedicated, true);
    assert.ok(h.circuitOpenUntil > Date.now(), 'circuit opens after a failure');
    assert.match(h.lastError, /429/);
    assert.ok(!JSON.stringify(h).includes('SECRET123'), 'the API key never reaches the health report');
    assert.deepEqual(main.seen.filter(m => HOLDER_METHODS.includes(m)), [], 'holder calls never go to the main RPC');
  } finally { main.server.close(); holder.server.close(); }
});

test('with a working holder RPC, holders and their owners come back and are counted', async () => {
  const main = await rpcServer(mainHandlers);
  const holder = await rpcServer(holderOk);
  try {
    const rpc = await freshRpc({ rpcUrl: main.url, holderRpcUrl: holder.url, holderRpcDailyCalls: 100 });
    const risk = await rpc.mintRisk(key());
    assert.equal(risk.holderDataUnavailable, false);
    assert.equal(risk.largest.length, 1);
    assert.equal(risk.largest[0].owner, holderOwner);
    assert.equal(risk.top1Pct, 60);
    const h = rpc.holderRpcHealth();
    assert.equal(h.status, 'OK');
    assert.equal(h.ok, 1);
    assert.equal(h.calls, 2);
    assert.deepEqual(holder.seen, HOLDER_METHODS);
    assert.deepEqual(main.seen.filter(m => HOLDER_METHODS.includes(m)), []);
  } finally { main.server.close(); holder.server.close(); }
});

test('the daily cap stops holder calls before they are sent', async () => {
  const main = await rpcServer(mainHandlers);
  const holder = await rpcServer(holderOk);
  try {
    const rpc = await freshRpc({ rpcUrl: main.url, holderRpcUrl: holder.url, holderRpcDailyCalls: 2 });
    assert.equal((await rpc.mintRisk(key())).holderDataUnavailable, false);
    assert.equal((await rpc.mintRisk(key())).holderDataUnavailable, true);
    const h = rpc.holderRpcHealth();
    assert.equal(h.status, 'BUDGET');
    assert.equal(h.budgetSkips, 1);
    assert.equal(h.calls, 2);
    assert.equal(holder.seen.length, 2, 'no holder request is sent once the cap is reached');
  } finally { main.server.close(); holder.server.close(); }
});

test('without HOLDER_RPC_URL, holder lookups stay on the main RPC (old behaviour)', async () => {
  const main = await rpcServer({ ...mainHandlers, ...holderOk });
  try {
    const rpc = await freshRpc({ rpcUrl: main.url, holderRpcUrl: '', holderRpcDailyCalls: 100 });
    assert.equal((await rpc.mintRisk(key())).holderDataUnavailable, false);
    const h = rpc.holderRpcHealth();
    assert.equal(h.dedicated, false);
    assert.equal(h.status, 'OK');
    assert.ok(main.seen.includes('getTokenLargestAccounts'));
  } finally { main.server.close(); }
});
