// Robinhood Auto Trader — package A tests (signer + transport). No network: fetch is stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR=fs.mkdtempSync(path.join(os.tmpdir(),'rh-signer-'));
process.env.MONEY_PRINTER_DATA_DIR=DIR;
process.env.POLYMARKET_AUTOSTART='false';
process.env.ROBINHOOD_AUTOSTART='false';
process.env.ROBINHOOD_API='https://rh.test';
delete process.env.ROBINHOOD_ORDER_API;

// Docs vector (only place the docs seed appears).
const DOC_SEED='xQnTJVeQLmw1/Mg2YimEViSpw/SdJcgNXZ5kQkAXNPU=';
const DOC_PUB='jPItx4TLjcnSUnmnXQQyAKL4eJj3+oWNNMmmm2vATqk=';
const DOC_API_KEY='rh-api-6148effc-c0b1-486c-8940-a1d099456be6';
const DOC_TS=1698708981;
const DOC_PATH='/api/v1/crypto/trading/orders/';
const DOC_BODY="{'client_order_id': '131de903-5a9c-4260-abc1-28d562a5dcf0', 'side': 'buy', 'symbol': 'BTC-USD', 'type': 'market', 'market_order_config': {'asset_quantity': '0.1'}}";
const DOC_SIG='q/nEtxp/P2Or3hph3KejBqnw5o9qeuQ+hYRnB56FaHbjDsNUY9KhB1asMxohDnzdVFSD7StaTqjSd9U9HvaRAw==';

const savedFetch=globalThis.fetch;
let fetchCalls=0;
globalThis.fetch=async()=>{fetchCalls++;throw new Error('fetch during import')};
const signer=await import('../src/robinhoodSigner.js');
const tx=await import('../src/robinhoodTransport.js');
const importFetchCalls=fetchCalls;

process.env.ROBINHOOD_API_KEY=DOC_API_KEY;
process.env.ROBINHOOD_PRIVATE_KEY=DOC_SEED;
const DOC_KEY=signer.loadRobinhoodPrivateKey(DOC_SEED);
const DOC_PUBKEY=crypto.createPublicKey(DOC_KEY);

const hdrs=(h={})=>({get:k=>h[String(k).toLowerCase()]??null});
function jsonRes(obj,status=200,headers={}){return {ok:status>=200&&status<300,status,headers:hdrs(headers),text:async()=>JSON.stringify(obj)}}
function textRes(body,status,headers={}){return {ok:status>=200&&status<300,status,headers:hdrs(headers),text:async()=>body}}
function installFetch(handler,log){
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(url);
  log?.push({method:init.method||'GET',url:String(url),path:u.pathname,search:u.search,headers:init.headers||{},body:init.body===undefined?'':init.body,signal:init.signal});
  const r=await handler(u,init);
  if(r)return r;
  throw new Error('Unexpected request '+init.method+' '+u.pathname);
 };
}
let fakeNow=1_700_000_000_000;
function reset(){tx.__testing.resetTransport();tx.__testing.setClock(()=>fakeNow);tx.__testing.setRateLimit(60,1);delete process.env.ROBINHOOD_ORDER_API;process.env.ROBINHOOD_API_KEY=DOC_API_KEY;process.env.ROBINHOOD_PRIVATE_KEY=DOC_SEED}
const verify=(msg,sigB64)=>crypto.verify(null,Buffer.from(msg,'utf8'),DOC_PUBKEY,Buffer.from(sigB64,'base64'));
const dateHdr=sec=>({date:new Date(sec*1000).toUTCString()});

test.after(()=>{globalThis.fetch=savedFetch;tx.__testing.setClock(null);fs.rmSync(DIR,{recursive:true,force:true})});

// ------------------------------------------------------------------ signer
test('import performs no fetch',()=>{assert.equal(importFetchCalls,0)});

test('docs seed derives the docs public key',()=>{
 assert.equal(signer.publicKeyBase64(DOC_KEY),DOC_PUB);
 assert.equal(signer.PKCS8_ED25519_PREFIX.toString('hex'),'302e020100300506032b657004220420');
 assert.equal(signer.RH_BASE_URL,'https://trading.robinhood.com');
});

test('docs signature vector reproduces byte-for-byte',()=>{
 const h=signer.signRequest({apiKey:DOC_API_KEY,privateKey:DOC_KEY,method:'post',path:DOC_PATH,body:DOC_BODY,timestamp:DOC_TS});
 assert.equal(h['x-signature'],DOC_SIG);
 assert.equal(h['x-api-key'],DOC_API_KEY);
 assert.equal(h['x-timestamp'],'1698708981');
 assert.equal(signer.buildSignedMessage({apiKey:DOC_API_KEY,timestamp:DOC_TS,path:DOC_PATH,method:'post',body:DOC_BODY}),`${DOC_API_KEY}${DOC_TS}${DOC_PATH}POST${DOC_BODY}`);
});

test('JSON body signs deterministically and verifies with crypto.verify',()=>{
 const body=JSON.stringify({client_order_id:'abc',side:'buy',symbol:'BTC-USD',type:'market',market_order_config:{asset_quantity:'0.1'}});
 const a=signer.signRequest({apiKey:'k',privateKey:DOC_KEY,method:'POST',path:DOC_PATH,body,timestamp:1});
 const b=signer.signRequest({apiKey:'k',privateKey:DOC_KEY,method:'POST',path:DOC_PATH,body,timestamp:1});
 assert.equal(a['x-signature'],b['x-signature']);
 assert.ok(verify(`k1${DOC_PATH}POST${body}`,a['x-signature']));
 assert.ok(!verify(`k1${DOC_PATH}POST${body} `,a['x-signature']));
 const g=signer.signRequest({apiKey:'k',privateKey:DOC_KEY,method:'GET',path:'/x/',timestamp:1});
 assert.ok(verify('k1/x/GET',g['x-signature']));
});

test('default timestamp is unix seconds',()=>{
 const before=Math.floor(Date.now()/1000);
 const h=signer.signRequest({apiKey:'k',privateKey:DOC_KEY,method:'GET',path:'/x/'});
 const ts=Number(h['x-timestamp']);
 assert.ok(Number.isInteger(ts)&&ts>=before&&ts<=before+2,`ts ${ts} not unix seconds`);
 assert.ok(ts<1e11,'timestamp must not be milliseconds');
});

test('badKey: 64-byte seed||publicKey rejected with hint, 16-byte rejected, garbage rejected',()=>{
 const seed64=Buffer.concat([Buffer.from(DOC_SEED,'base64'),Buffer.from(DOC_PUB,'base64')]).toString('base64');
 assert.throws(()=>signer.loadRobinhoodPrivateKey(seed64),e=>e.code==='badKey'&&/seed\|\|publicKey/.test(e.message)&&/first 32 bytes/.test(e.message));
 assert.throws(()=>signer.loadRobinhoodPrivateKey(crypto.randomBytes(16).toString('base64')),e=>e.code==='badKey'&&!/seed\|\|publicKey/.test(e.message));
 assert.throws(()=>signer.loadRobinhoodPrivateKey(''),e=>e.code==='badKey');
 assert.throws(()=>signer.loadRobinhoodPrivateKey('not base64 !!'),e=>e.code==='badKey');
 assert.throws(()=>signer.loadRobinhoodPrivateKey(crypto.randomBytes(33).toString('base64')),e=>e.code==='badKey');
});

test('generateRobinhoodKeyPair round-trips through loadRobinhoodPrivateKey',()=>{
 const {privateKeyBase64,publicKeyBase64}=signer.generateRobinhoodKeyPair();
 assert.equal(Buffer.from(privateKeyBase64,'base64').length,32);
 assert.equal(Buffer.from(publicKeyBase64,'base64').length,32);
 const key=signer.loadRobinhoodPrivateKey(privateKeyBase64);
 assert.equal(signer.publicKeyBase64(key),publicKeyBase64);
 const h=signer.signRequest({apiKey:'k',privateKey:key,method:'GET',path:'/p/',timestamp:5});
 assert.ok(crypto.verify(null,Buffer.from('k5/p/GET'),crypto.createPublicKey(key),Buffer.from(h['x-signature'],'base64')));
});

test('buildPath repeats arrays, keeps commas unencoded and the trailing slash, skips null',()=>{
 assert.equal(signer.buildPath('/api/v2/crypto/trading/trading_pairs/',{symbol:['BTC-USD','ETH-USD']}),'/api/v2/crypto/trading/trading_pairs/?symbol=BTC-USD&symbol=ETH-USD');
 assert.equal(signer.buildPath('/api/v2/crypto/marketdata/estimated_price/',{symbol:'BTC-USD',side:'ask',quantity:'0.1,1'}),'/api/v2/crypto/marketdata/estimated_price/?symbol=BTC-USD&side=ask&quantity=0.1,1');
 assert.equal(signer.buildPath('/a/',{x:null,y:undefined,z:0}),'/a/?z=0');
 assert.equal(signer.buildPath('/a/'),'/a/');
 assert.equal(signer.buildPath('/a/',{}),'/a/');
 assert.equal(signer.buildPath('/a/',{q:'a b&c'}),'/a/?q=a%20b%26c');
 assert.equal(signer.buildPath('/a/',{created_at_start:'2026-09-25T00:00:00Z'}),'/a/?created_at_start=2026-09-25T00%3A00%3A00Z');
});

test('formatIncrement floors and never emits an exponent',()=>{
 assert.equal(signer.formatIncrement(0.000123456789,'0.00000001'),'0.00012345');
 assert.equal(signer.formatIncrement(1e-7,'0.00000001'),'0.00000010');
 assert.equal(signer.formatIncrement(0.1+0.2,'0.0001'),'0.3000');
 assert.equal(signer.formatIncrement(123456789.123,'0.01'),'123456789.12');
 assert.equal(signer.formatIncrement(2.5,'1'),'2');
 assert.equal(signer.formatIncrement(0.00000001,'0.00000001'),'0.00000001');
 assert.equal(signer.formatIncrement(0.00000000999,'0.00000001'),'0.00000000');
 assert.equal(signer.formatIncrement(5,0.001),'5.000');
 assert.equal(signer.formatIncrement(0.000000015,1e-8),'0.00000001');
 for(const v of [1e-9,1e-8,5e-7,1e21/1e15]){assert.doesNotMatch(signer.formatIncrement(v,'0.00000001'),/e/i)}
 assert.throws(()=>signer.formatIncrement(NaN,'0.01'),e=>e.code==='increment');
 assert.throws(()=>signer.formatIncrement(Infinity,'0.01'),e=>e.code==='increment');
 assert.throws(()=>signer.formatIncrement(1,'0'),e=>e.code==='increment');
 assert.throws(()=>signer.formatIncrement(1,'abc'),e=>e.code==='increment');
});

test('ceilIncrement rounds up and incrementDecimals counts places',()=>{
 assert.equal(signer.ceilIncrement(0.000123456789,'0.00000001'),'0.00012346');
 assert.equal(signer.ceilIncrement(100.001,'0.01'),'100.01');
 assert.equal(signer.ceilIncrement(100.00,'0.01'),'100.00');
 assert.equal(signer.ceilIncrement(0.1+0.2,'0.1'),'0.3');
 assert.equal(signer.incrementDecimals('0.00000001'),8);
 assert.equal(signer.incrementDecimals('0.01'),2);
 assert.equal(signer.incrementDecimals('1'),0);
 assert.equal(signer.incrementDecimals(1e-8),8);
 assert.equal(signer.incrementDecimals(0.001),3);
});

// --------------------------------------------------------------- transport
test('transport re-exports the error surface',()=>{
 assert.equal(tx.RH_CODES.includes('uncertain'),true);
 assert.equal(typeof tx.RobinhoodError,'function');
 assert.throws(()=>tx.fail('busy','x'),e=>e.code==='busy'&&e.sent===false);
});

test('creds are trimmed and never cached; keyObject memoises and notes badKey',()=>{
 reset();
 process.env.ROBINHOOD_API_KEY='  k1  ';
 assert.equal(tx.creds().apiKey,'k1');
 process.env.ROBINHOOD_API_KEY='k2';
 assert.equal(tx.creds().apiKey,'k2');
 const a=tx.keyObject(),b=tx.keyObject();
 assert.ok(a&&a===b);
 process.env.ROBINHOOD_PRIVATE_KEY=crypto.randomBytes(16).toString('base64');
 assert.equal(tx.keyObject(),null);
 assert.equal(tx.rhLastAuth().code,'badKey');
 process.env.ROBINHOOD_PRIVATE_KEY='';
 assert.equal(tx.keyObject(),null);
 reset();
});

test('noCredentials and badKey are raised locally before any fetch',async()=>{
 reset();const log=[];installFetch(()=>null,log);
 process.env.ROBINHOOD_API_KEY='';
 await assert.rejects(tx.rhGet('/api/v2/crypto/trading/accounts/'),e=>e.code==='noCredentials'&&e.sent===false);
 process.env.ROBINHOOD_API_KEY=DOC_API_KEY;process.env.ROBINHOOD_PRIVATE_KEY=crypto.randomBytes(64).toString('base64');
 await assert.rejects(tx.rhGet('/api/v2/crypto/trading/accounts/'),e=>e.code==='badKey'&&/seed\|\|publicKey/.test(e.message)&&e.sent===false);
 assert.equal(log.length,0);
 reset();
});

test('signed GET signs the path including query and the headers verify',async()=>{
 reset();const log=[];
 installFetch(u=>u.pathname==='/api/v2/crypto/trading/holdings/'?jsonRes({results:[]},200,dateHdr(1_700_000_000)):null,log);
 await tx.rhGet('/api/v2/crypto/trading/holdings/',{account_number:'ACC1',asset_code:['BTC','ETH']});
 assert.equal(log.length,1);
 const r=log[0];
 assert.equal(r.method,'GET');
 assert.equal(r.url,'https://rh.test/api/v2/crypto/trading/holdings/?account_number=ACC1&asset_code=BTC&asset_code=ETH');
 assert.equal(r.body,'');
 assert.equal(r.headers['x-api-key'],DOC_API_KEY);
 assert.equal(r.headers['x-timestamp'],String(Math.floor(fakeNow/1000)));
 assert.equal(r.headers['content-type'],'application/json');
 assert.equal(r.headers['accept'],'application/json');
 assert.match(r.headers['user-agent'],/^MoneyPrinterOS\//);
 assert.ok(verify(`${DOC_API_KEY}${r.headers['x-timestamp']}/api/v2/crypto/trading/holdings/?account_number=ACC1&asset_code=BTC&asset_code=ETH` + 'GET',r.headers['x-signature']));
 assert.ok(r.signal instanceof AbortSignal);
 assert.equal(tx.rhLastAuth().code,'ok');
 assert.equal(tx.rhClock().lastDateHeaderSec,1_700_000_000);
 assert.equal(tx.__testing.requestLog.length,1);
});

test('POST serialises once and signs the exact bytes it sends',async()=>{
 reset();const log=[];
 installFetch((u,init)=>init.method==='POST'?jsonRes({id:'o1',client_order_id:'c1',symbol:'BTC-USD',side:'buy',type:'market',state:'open'}):null,log);
 const body={client_order_id:'c1',side:'buy',type:'market',symbol:'BTC-USD',market_order_config:{asset_quantity:'0.00010000'}};
 await tx.rhPost('/api/v2/crypto/trading/orders/',body,{account_number:'ACC1'});
 const r=log[0];
 assert.equal(r.body,JSON.stringify(body));
 assert.ok(verify(`${DOC_API_KEY}${r.headers['x-timestamp']}/api/v2/crypto/trading/orders/?account_number=ACC1POST${r.body}`,r.headers['x-signature']));
});

test('classifyRobinhoodError table',()=>{
 const c=tx.classifyRobinhoodError;
 assert.equal(c(400,{type:'validation_error',errors:[{detail:'bad',attr:'symbol'}]}),'validation');
 assert.equal(c(400,{type:'client_error',errors:[]}),'http');
 assert.equal(c(401,null),'keyNotFound');
 assert.equal(c(403,{type:'client_error'}),'notPermitted');
 assert.equal(c(404,null),'http');
 assert.equal(c(405,null),'http');
 assert.equal(c(429,null),'rateLimited');
 assert.equal(c(500,{type:'server_error'}),'http');
 assert.equal(c(503,null),'http');
 assert.equal(c(0,null,'fetch failed'),'network');
 assert.equal(c(0,null,'The operation was aborted due to timeout'),'uncertain');
});

test('HTTP error envelope becomes RobinhoodError with sent:true and no body leakage',async()=>{
 reset();
 installFetch(()=>jsonRes({type:'validation_error',errors:[{detail:'Quantity too small',attr:'asset_quantity'},{detail:'Nope',attr:null}]},400,dateHdr(1_700_000_001)));
 await assert.rejects(tx.rhGet('/x/'),e=>e.code==='validation'&&e.status===400&&e.sent===true&&e.message==='validation_error: Quantity too small (asset_quantity); Nope'&&e.details?.type==='validation_error');
 assert.equal(tx.rhLastAuth().code,'validation');
 installFetch(()=>textRes('<html>boom</html>',503));
 await assert.rejects(tx.rhGet('/x/'),e=>e.code==='http'&&e.status===503&&e.sent===true&&!/html/.test(e.message));
 installFetch(()=>jsonRes({type:'client_error',errors:[{detail:'forbidden',attr:null}]},403));
 await assert.rejects(tx.rhGet('/x/'),e=>e.code==='notPermitted'&&e.status===403);
 assert.equal(tx.rhLastAuth().code,'notPermitted');
 installFetch(()=>jsonRes({type:'server_error',errors:[{detail:'x'.repeat(500),attr:null}]},500));
 await assert.rejects(tx.rhGet('/x/'),e=>e.message.length<=240);
});

test('network failure -> network sent:true; post-send timeout -> uncertain',async()=>{
 reset();
 installFetch(()=>{throw new TypeError('fetch failed')});
 await assert.rejects(tx.rhGet('/x/'),e=>e.code==='network'&&e.sent===true&&e.status===0);
 assert.equal(tx.rhLastAuth().code,'network');
 installFetch(()=>{const e=new Error('The operation was aborted due to timeout');e.name='TimeoutError';throw e});
 await assert.rejects(tx.rhPost('/api/v2/crypto/trading/orders/',{client_order_id:'c'}),e=>e.code==='uncertain'&&e.sent===true);
 assert.equal(tx.rhLastAuth().code,'uncertain');
});

test('401 with skewed date header retries once with corrected timestamp and identical body; second 401 -> keyNotFound',async()=>{
 reset();const log=[];
 const serverSec=Math.floor(fakeNow/1000)+120;
 let n=0;
 installFetch(()=>{n++;return n===1?jsonRes({type:'client_error',errors:[{detail:'API key not found',attr:null}]},401,dateHdr(serverSec)):jsonRes({id:'o1',state:'open'},200,dateHdr(serverSec))},log);
 const body={client_order_id:'same',side:'buy',type:'market',symbol:'BTC-USD',market_order_config:{asset_quantity:'0.1'}};
 const res=await tx.rhPost('/api/v2/crypto/trading/orders/',body,{account_number:'A'});
 assert.equal(res.id,'o1');
 assert.equal(log.length,2);
 assert.equal(log[0].headers['x-timestamp'],String(Math.floor(fakeNow/1000)));
 assert.equal(log[1].headers['x-timestamp'],String(serverSec));
 assert.equal(log[0].body,log[1].body);
 assert.equal(JSON.parse(log[1].body).client_order_id,'same');
 assert.ok(verify(`${DOC_API_KEY}${serverSec}/api/v2/crypto/trading/orders/?account_number=APOST${log[1].body}`,log[1].headers['x-signature']));
 assert.equal(tx.rhClock().skewSec,120);
 assert.equal(tx.rhClock().timestamp(),serverSec);
 // Skew now applied: a subsequent 401 with the same skew is NOT retried again.
 const log2=[];
 installFetch(()=>jsonRes({type:'client_error',errors:[{detail:'API key not found',attr:null}]},401,dateHdr(Math.floor(fakeNow/1000)+120)),log2);
 await assert.rejects(tx.rhGet('/x/'),e=>e.code==='keyNotFound'&&e.status===401&&e.sent===true);
 assert.equal(log2.length,1);
 assert.equal(tx.rhLastAuth().code,'keyNotFound');
 // Two 401s in a row with fresh skew: exactly one retry.
 reset();const log3=[];
 installFetch(()=>jsonRes({type:'client_error',errors:[{detail:'API key not found',attr:null}]},401,dateHdr(Math.floor(fakeNow/1000)-90)),log3);
 await assert.rejects(tx.rhGet('/x/'),e=>e.code==='keyNotFound'&&/retried/.test(e.message));
 assert.equal(log3.length,2);
});

test('401 without skew, without date header, with retryOn401=false, or a first 403: no retry',async()=>{
 reset();
 let log=[];installFetch(()=>jsonRes({type:'client_error',errors:[{detail:'nope',attr:null}]},401,dateHdr(Math.floor(fakeNow/1000)+2)),log);
 await assert.rejects(tx.rhGet('/x/'),e=>e.code==='keyNotFound');
 assert.equal(log.length,1);
 log=[];installFetch(()=>jsonRes({type:'client_error',errors:[]},401),log);
 await assert.rejects(tx.rhGet('/x/'),e=>e.code==='keyNotFound'&&/check system time/.test(e.message));
 assert.equal(log.length,1);
 log=[];installFetch(()=>jsonRes({type:'client_error',errors:[]},401,dateHdr(Math.floor(fakeNow/1000)+500)),log);
 await assert.rejects(tx.rhRequest({method:'GET',path:'/x/',retryOn401:false}),e=>e.code==='keyNotFound');
 assert.equal(log.length,1);
 assert.equal(tx.rhClock().skewSec,0);
 log=[];installFetch(()=>jsonRes({type:'client_error',errors:[]},403,dateHdr(Math.floor(fakeNow/1000)+500)),log);
 await assert.rejects(tx.rhGet('/x/'),e=>e.code==='notPermitted');
 assert.equal(log.length,1);
 assert.equal(tx.rhClock().skewSec,0);
});

test('429 sets exponential backoff and the next request is refused locally',async()=>{
 reset();const log=[];
 installFetch(()=>jsonRes({type:'client_error',errors:[{detail:'slow down',attr:null}]},429),log);
 await assert.rejects(tx.rhGet('/x/'),e=>e.code==='rateLimited'&&e.status===429&&e.sent===true);
 let rl=tx.rhRateLimit();
 assert.equal(rl.consecutive429,1);
 assert.equal(rl.backoffUntil,fakeNow+4000);
 await assert.rejects(tx.rhGet('/x/'),e=>e.code==='rateLimited'&&e.sent===false&&e.details?.local===true);
 assert.equal(log.length,1);
 fakeNow+=4001;
 await assert.rejects(tx.rhGet('/x/'),e=>e.status===429);
 rl=tx.rhRateLimit();
 assert.equal(rl.consecutive429,2);
 assert.equal(rl.backoffUntil,fakeNow+8000);
 for(let i=0;i<10;i++){fakeNow=rl.backoffUntil+1;await assert.rejects(tx.rhGet('/x/'),e=>e.status===429);rl=tx.rhRateLimit()}
 assert.equal(rl.backoffUntil-fakeNow,60000);
 fakeNow=rl.backoffUntil+1;
 installFetch(()=>jsonRes({ok:1}),log);
 await tx.rhGet('/x/');
 assert.equal(tx.rhRateLimit().consecutive429,0);
 assert.equal(tx.rhRateLimit().backoffUntil<=fakeNow,true);
});

test('token bucket: 60 capacity, refills 1/s, refuses locally without network',async()=>{
 reset();const log=[];
 installFetch(()=>jsonRes({}),log);
 const rl=tx.rhRateLimit();
 assert.equal(rl.capacity,60);assert.equal(rl.refillPerSec,1);assert.equal(rl.tokens,60);
 tx.__testing.setRateLimit(2,0);
 await tx.rhGet('/a/');await tx.rhGet('/a/');
 await assert.rejects(tx.rhGet('/a/'),e=>e.code==='rateLimited'&&e.sent===false);
 assert.equal(log.length,2);
 tx.__testing.setRateLimit(2,1);
 await tx.rhGet('/a/');await tx.rhGet('/a/');
 await assert.rejects(tx.rhGet('/a/'),e=>e.code==='rateLimited');
 fakeNow+=1000;
 await tx.rhGet('/a/');
 await assert.rejects(tx.rhGet('/a/'),e=>e.code==='rateLimited');
 fakeNow+=3600_000;
 assert.equal(tx.rhRateLimit().tokens,2);
 tx.__testing.setRateLimit(60,1);
});

test('lastDateHeaderSec is recorded on 2xx and rhClock shape is stable',async()=>{
 reset();
 installFetch(()=>jsonRes({results:[]},200,dateHdr(1_800_000_000)));
 await tx.rhGet('/x/');
 const c=tx.rhClock();
 assert.deepEqual(Object.keys(c),['skewSec','syncedAt','lastDateHeaderSec','timestamp']);
 assert.equal(c.lastDateHeaderSec,1_800_000_000);
 assert.equal(c.syncedAt,fakeNow);
 assert.equal(c.skewSec,0);
 assert.equal(c.timestamp(),Math.floor(fakeNow/1000));
});

test('noteRobinhoodAuth strips html and truncates',()=>{
 reset();
 tx.noteRobinhoodAuth({message:'<b>bad</b>  thing '+'y'.repeat(400),status:403});
 const a=tx.rhLastAuth();
 assert.equal(a.code,'notPermitted');
 assert.ok(a.error.startsWith('bad thing'));
 assert.equal(a.error.length,240);
 tx.noteRobinhoodAuth({code:'ok'});
 assert.deepEqual(tx.rhLastAuth(),{error:null,code:'ok',at:fakeNow});
});

// ---------------------------------------------------------------- wrappers
test('rhPaginate follows absolute next URLs, strips the base, re-signs, caps pages',async()=>{
 reset();const log=[];
 installFetch(u=>{
  if(u.pathname!=='/api/v2/crypto/trading/orders/')return null;
  const cursor=u.searchParams.get('cursor');
  if(!cursor)return jsonRes({results:[{id:'1'}],next:'https://rh.test/api/v2/crypto/trading/orders/?account_number=A&cursor=c2'});
  if(cursor==='c2')return jsonRes({results:[{id:'2'}],next:'https://trading.robinhood.com/api/v2/crypto/trading/orders/?account_number=A&cursor=c3'});
  return jsonRes({results:[{id:cursor}],next:`https://rh.test/api/v2/crypto/trading/orders/?account_number=A&cursor=${cursor}x`});
 },log);
 const rows=await tx.rhPaginate('/api/v2/crypto/trading/orders/',{account_number:'A'});
 assert.equal(rows.length,5);
 assert.equal(log.length,5);
 assert.ok(log.every(r=>r.url.startsWith('https://rh.test/')));
 assert.equal(log[2].search,'?account_number=A&cursor=c3');
 for(const r of log)assert.ok(verify(`${DOC_API_KEY}${r.headers['x-timestamp']}${r.path}${r.search}GET`,r.headers['x-signature']));
 const two=await tx.rhPaginate('/api/v2/crypto/trading/orders/',{account_number:'A'},{maxPages:2});
 assert.deepEqual(two.map(r=>r.id),['1','2']);
});

test('fetchAccount prefers api-tradable v2 account and falls back to v1 on 404/403',async()=>{
 reset();
 installFetch(u=>u.pathname==='/api/v2/crypto/trading/accounts/'?jsonRes({results:[{account_number:'X1',status:'active',buying_power:'10.5',is_api_tradable:false,fee_ratio:'0.0075'},{account_number:'X2',status:'active',buying_power:'99.25',is_api_tradable:true,fee_ratio:'0.0085'}]}):null);
 let a=await tx.fetchAccount();
 assert.equal(a.accountNumber,'X2');assert.equal(a.buyingPowerUsd,99.25);assert.equal(a.feeRatio,0.0085);assert.equal(a.apiVersion,'v2');assert.equal(a.at,fakeNow);
 assert.deepEqual(Object.keys(a),['accountNumber','status','buyingPowerUsd','feeRatio','apiVersion','at']);
 const log=[];
 installFetch(u=>u.pathname==='/api/v2/crypto/trading/accounts/'?jsonRes({type:'client_error',errors:[{detail:'not found',attr:null}]},404):u.pathname==='/api/v1/crypto/trading/accounts/'?jsonRes({account_number:'V1',status:'active',buying_power:'5'}):null,log);
 a=await tx.fetchAccount();
 assert.equal(a.accountNumber,'V1');assert.equal(a.feeRatio,null);assert.equal(a.apiVersion,'v1');assert.equal(a.buyingPowerUsd,5);
 assert.deepEqual(log.map(r=>r.path),['/api/v2/crypto/trading/accounts/','/api/v1/crypto/trading/accounts/']);
 installFetch(u=>u.pathname==='/api/v2/crypto/trading/accounts/'?jsonRes({type:'client_error',errors:[{detail:'forbidden',attr:null}]},403):jsonRes({results:[{account_number:'V1b',status:'active',buying_power:'1'}]}));
 a=await tx.fetchAccount();
 assert.equal(a.accountNumber,'V1b');assert.equal(a.apiVersion,'v1');
 // 500 does not fall back.
 const log2=[];
 installFetch(()=>jsonRes({type:'server_error',errors:[]},500),log2);
 await assert.rejects(tx.fetchAccount(),e=>e.code==='http'&&e.status===500);
 assert.equal(log2.length,1);
 // 401 does not fall back.
 const log3=[];
 installFetch(()=>jsonRes({type:'client_error',errors:[]},401),log3);
 await assert.rejects(tx.fetchAccount(),e=>e.code==='keyNotFound');
 assert.equal(log3.length,1);
});

test('fetchTradingPairs maps symbols with repeated query keys and v1 fallback',async()=>{
 reset();const log=[];
 installFetch(u=>u.pathname==='/api/v2/crypto/trading/trading_pairs/'?jsonRes({results:[{symbol:'BTC-USD',asset_code:'BTC',quote_code:'USD',asset_increment:'0.000001',quote_increment:'0.01',min_order_size:'0.000001',max_order_size:'100',min_order_amount:'1.00',status:'tradable',is_api_tradable:true},{symbol:'ETH-USD',asset_code:'ETH',asset_increment:'0.0001',quote_increment:'0.01',status:'untradable',is_api_tradable:false}]}):null,log);
 const m=await tx.fetchTradingPairs(['btc-usd','ETH-USD']);
 assert.equal(log[0].search,'?symbol=BTC-USD&symbol=ETH-USD');
 assert.ok(m instanceof Map);
 assert.deepEqual(m.get('BTC-USD'),{symbol:'BTC-USD',assetCode:'BTC',assetIncrement:'0.000001',quoteIncrement:'0.01',maxOrderSize:100,minOrderAmountUsd:1,status:'tradable',isApiTradable:true});
 assert.equal(m.get('ETH-USD').isApiTradable,false);
 assert.equal(m.get('ETH-USD').minOrderAmountUsd,null);
 assert.equal(m.get('ETH-USD').maxOrderSize,null);
 installFetch(u=>u.pathname==='/api/v2/crypto/trading/trading_pairs/'?jsonRes({},404):u.pathname==='/api/v1/crypto/trading/trading_pairs/'?jsonRes({results:[{symbol:'BTC-USD',asset_code:'BTC',min_order_size:'0.00001',quote_increment:'0.01',status:'tradable'}]}):null);
 const v1=await tx.fetchTradingPairs(['BTC-USD']);
 assert.equal(v1.get('BTC-USD').assetIncrement,'0.00001');
 assert.equal(v1.get('BTC-USD').isApiTradable,true);
});

test('fetchHoldings passes account_number and asset codes',async()=>{
 reset();const log=[];
 installFetch(u=>u.pathname==='/api/v2/crypto/trading/holdings/'?jsonRes({results:[{asset_code:'BTC',total_quantity:'0.5',quantity_available_for_trading:'0.25'}]}):null,log);
 const h=await tx.fetchHoldings('ACC',['BTC','ETH']);
 assert.equal(log[0].search,'?account_number=ACC&asset_code=BTC&asset_code=ETH');
 assert.deepEqual(h,[{assetCode:'BTC',totalQty:0.5,availableQty:0.25}]);
 await tx.fetchHoldings('ACC');
 assert.equal(log[1].search,'?account_number=ACC');
});

test('fetchBestBidAsk batches symbols in one call; v1 fallback maps spread-inclusive fields',async()=>{
 reset();const log=[];
 installFetch(u=>u.pathname==='/api/v2/crypto/marketdata/best_bid_ask/'?jsonRes({results:[{symbol:'BTC-USD',bid_price:'100.5',ask_price:'101',timestamp:'2026-09-25T00:00:00Z'},{symbol:'ETH-USD',bid_price:'10',ask_price:'10.1'}]}):null,log);
 const q=await tx.fetchBestBidAsk(['BTC-USD','ETH-USD']);
 assert.equal(log.length,1);
 assert.equal(log[0].search,'?symbol=BTC-USD&symbol=ETH-USD');
 assert.deepEqual(q[0],{symbol:'BTC-USD',bid:100.5,ask:101,at:Date.parse('2026-09-25T00:00:00Z'),source:'v2'});
 assert.equal(q[1].at,fakeNow);
 installFetch(u=>u.pathname==='/api/v2/crypto/marketdata/best_bid_ask/'?jsonRes({type:'client_error',errors:[{detail:'forbidden',attr:null}]},403):u.pathname==='/api/v1/crypto/marketdata/best_bid_ask/'?jsonRes({results:[{symbol:'BTC-USD',price:'100.7',bid_inclusive_of_sell_spread:'100.2',ask_inclusive_of_buy_spread:'101.2'}]}):null);
 const v1=await tx.fetchBestBidAsk(['BTC-USD']);
 assert.deepEqual(v1,[{symbol:'BTC-USD',bid:100.2,ask:101.2,at:fakeNow,source:'v1'}]);
});

test('fetchBestBidAsk: a small v2 cross is uncrossed and a small clock lead takes the receipt time; wide ones pass through',async()=>{
 reset();const iso=ms=>new Date(ms).toISOString();
 installFetch(u=>u.pathname==='/api/v2/crypto/marketdata/best_bid_ask/'?jsonRes({results:[
  {symbol:'BTC-USD',bid:'84024.63',ask:'84012.24',timestamp:iso(fakeNow+1100)}, // live 2026-09-26: ~1.5 bps cross, 1.1 s ahead
  {symbol:'ETH-USD',bid:'100',ask:'99',timestamp:iso(fakeNow+60000)},             // 100 bps cross, a minute ahead
  {symbol:'SOL-USD',bid:'120',ask:'120.01',timestamp:iso(fakeNow-2000)},          // normal
 ]}):null);
 const [btc,eth,sol]=await tx.fetchBestBidAsk(['BTC-USD','ETH-USD','SOL-USD']);
 assert.deepEqual(btc,{symbol:'BTC-USD',bid:84012.24,ask:84024.63,at:fakeNow,source:'v2'});
 assert.deepEqual(eth,{symbol:'ETH-USD',bid:100,ask:99,at:fakeNow+60000,source:'v2'},'left crossed and future so fresh() rejects it');
 assert.deepEqual(sol,{symbol:'SOL-USD',bid:120,ask:120.01,at:fakeNow-2000,source:'v2'});
 assert.equal(tx.QUOTE_CROSS_TOLERANCE_BPS,5);assert.equal(tx.QUOTE_FUTURE_TOLERANCE_MS,5000);
});

test('fetchEstimatedPrice sends unencoded comma list capped at 10 and maps fee fields',async()=>{
 reset();const log=[];
 installFetch(u=>u.pathname==='/api/v2/crypto/trading/estimated_price/'?jsonRes({results:[{symbol:'BTC-USD',side:'ask',quantity:'0.1',price:'101.5',fee_ratio:'0.0085',estimated_fee:'0.08',estimated_total_cost:'10.23'},{symbol:'BTC-USD',side:'bid',quantity:'1',price:'99',estimated_total_credit:'98.1'}]}):null,log);
 const rows=await tx.fetchEstimatedPrice('btc-usd','ask',['0.1','1','2','3','4','5','6','7','8','9','10','11']);
 assert.equal(log[0].search,'?symbol=BTC-USD&side=ask&quantity=0.1,1,2,3,4,5,6,7,8,9');
 assert.ok(log[0].url.includes('quantity=0.1,1,'));
 assert.ok(verify(`${DOC_API_KEY}${log[0].headers['x-timestamp']}${log[0].path}${log[0].search}GET`,log[0].headers['x-signature']));
 assert.deepEqual(rows[0],{symbol:'BTC-USD',side:'ask',quantity:0.1,bid:null,ask:101.5,feeRatio:0.0085,estFee:0.08,estTotalCost:10.23,estTotalCredit:null,at:fakeNow});
 assert.deepEqual(rows[1],{symbol:'BTC-USD',side:'bid',quantity:1,bid:99,ask:null,feeRatio:null,estFee:null,estTotalCost:null,estTotalCredit:98.1,at:fakeNow});
});

const RAW_ORDER={id:'ord-1',client_order_id:'cid-1',symbol:'BTC-USD',side:'buy',type:'market',state:'partially_filled',average_price:'100.25',filled_asset_quantity:'0.05',fee_charged:'0.04',executions:[{effective_price:'100',quantity:'0.02',timestamp:'2026-09-25T01:00:00Z'},{effective_price:'100.4166667',quantity:'0.03',timestamp:'2026-09-25T01:00:01Z'}],created_at:'2026-09-25T00:59:00Z',updated_at:'2026-09-25T01:00:01Z',market_order_config:{asset_quantity:'0.1'}};

test('normalizeOrder parses decimals, maps states, drops raw',()=>{
 const o=tx.normalizeOrder(RAW_ORDER);
 assert.deepEqual(Object.keys(o),['id','clientOrderId','symbol','side','type','state','averagePrice','filledQty','feeCharged','executions','createdAt','updatedAt']);
 assert.equal(o.id,'ord-1');assert.equal(o.clientOrderId,'cid-1');assert.equal(o.state,'partially_filled');
 assert.equal(o.averagePrice,100.25);assert.equal(o.filledQty,0.05);assert.equal(o.feeCharged,0.04);
 assert.deepEqual(o.executions[0],{price:100,qty:0.02,at:Date.parse('2026-09-25T01:00:00Z')});
 assert.equal(o.createdAt,Date.parse('2026-09-25T00:59:00Z'));
 assert.equal('raw' in o,false);assert.equal('market_order_config' in o,false);
 for(const [raw,want] of [['open','open'],['pending','pending'],['filled','filled'],['canceled','canceled'],['cancelled','canceled'],['failed','failed'],['rejected','failed'],['weird','pending'],[undefined,'pending']]){assert.equal(tx.normalizeOrder({state:raw}).state,want,String(raw))}
 const bare=tx.normalizeOrder({id:'x',executions:[{effective_price:'10',quantity:'1'},{effective_price:'20',quantity:'1'}]});
 assert.equal(bare.filledQty,2);assert.equal(bare.averagePrice,15);assert.equal(bare.feeCharged,null);assert.equal(bare.createdAt,0);
 assert.equal(tx.normalizeOrder(null).id,'');
 assert.equal(tx.normalizeOrder({limit_order_config:{}}).type,'limit');
});

test('listOrders passes filters and paginates; getOrder falls back to list on 404/405',async()=>{
 reset();const log=[];
 installFetch(u=>{
  if(u.pathname==='/api/v2/crypto/trading/orders/')return u.searchParams.get('cursor')?jsonRes({results:[{...RAW_ORDER,id:'ord-2',state:'filled'}],next:null}):jsonRes({results:[RAW_ORDER],next:'https://rh.test/api/v2/crypto/trading/orders/?account_number=A&cursor=n'});
  if(u.pathname==='/api/v2/crypto/trading/orders/ord-2/')return jsonRes({type:'client_error',errors:[{detail:'Method not allowed',attr:null}]},405);
  if(u.pathname==='/api/v2/crypto/trading/orders/ord-1/')return jsonRes(RAW_ORDER);
  if(u.pathname==='/api/v2/crypto/trading/orders/ord-9/')return jsonRes({},404);
  if(u.pathname==='/api/v2/crypto/trading/orders/ord-5/')return jsonRes({type:'server_error',errors:[]},500);
  return null;
 },log);
 const rows=await tx.listOrders('A',{state:'open',symbol:'BTC-USD',created_at_start:'2026-09-25T00:00:00Z',side:undefined});
 assert.equal(log[0].search,'?account_number=A&state=open&symbol=BTC-USD&created_at_start=2026-09-25T00%3A00%3A00Z');
 assert.deepEqual(rows.map(r=>r.id),['ord-1','ord-2']);
 const direct=await tx.getOrder('A','ord-1');
 assert.equal(direct.id,'ord-1');
 assert.equal(log.at(-1).search,'?account_number=A');
 const viaList=await tx.getOrder('A','ord-2');
 assert.equal(viaList.id,'ord-2');assert.equal(viaList.state,'filled');
 const missing=await tx.getOrder('A','ord-9');
 assert.equal(missing,null);
 await assert.rejects(tx.getOrder('A','ord-5'),e=>e.status===500);
});

test('placeOrder v2 by default with account_number; v1 path when ROBINHOOD_ORDER_API=v1; body serialised once',async()=>{
 reset();const log=[];
 installFetch((u,init)=>init.method==='POST'&&/orders\/$/.test(u.pathname)?jsonRes({...RAW_ORDER,state:'open'}):null,log);
 const body=tx.orderBody({clientOrderId:'cid-1',symbol:'btc-usd',side:'buy',type:'market',qtyStr:'0.00010000'});
 assert.deepEqual(body,{client_order_id:'cid-1',side:'buy',type:'market',symbol:'BTC-USD',market_order_config:{asset_quantity:'0.00010000',time_in_force:'gtc'}});
 const o=await tx.placeOrder('A',body);
 assert.equal(o.state,'open');
 assert.equal(log[0].path,'/api/v2/crypto/trading/orders/');
 assert.equal(log[0].search,'?account_number=A');
 assert.equal(log[0].body,JSON.stringify(body));
 assert.ok(verify(`${DOC_API_KEY}${log[0].headers['x-timestamp']}/api/v2/crypto/trading/orders/?account_number=APOST${log[0].body}`,log[0].headers['x-signature']));
 process.env.ROBINHOOD_ORDER_API='v1';
 const v1Body=tx.orderBody({clientOrderId:'cid-2',symbol:'BTC-USD',side:'sell',type:'limit',qtyStr:'0.1',limitPriceStr:'100.00',timeInForce:'gfd'});
 assert.deepEqual(v1Body,{client_order_id:'cid-2',side:'sell',type:'limit',symbol:'BTC-USD',limit_order_config:{asset_quantity:'0.1',limit_price:'100.00'}});
 assert.equal(JSON.stringify(v1Body).includes('time_in_force'),false);
 await tx.placeOrder('A',v1Body);
 assert.equal(log[1].path,'/api/v1/crypto/trading/orders/');
 assert.equal(log[1].search,'');
 assert.equal(log[1].body,JSON.stringify(v1Body));
 delete process.env.ROBINHOOD_ORDER_API;
});

test('orderBody validates enum/decimal inputs on v2',()=>{
 reset();
 const limit=tx.orderBody({clientOrderId:'c',symbol:'ETH-USD',side:'buy',type:'limit',qtyStr:'0.5',limitPriceStr:'2000.00',timeInForce:'gfw'});
 assert.deepEqual(limit.limit_order_config,{asset_quantity:'0.5',limit_price:'2000.00',time_in_force:'gfw'});
 for(const tif of ['gtc','gfd','gfw','gfm'])assert.equal(tx.orderBody({clientOrderId:'c',symbol:'X-USD',side:'buy',type:'market',qtyStr:'1',timeInForce:tif}).market_order_config.time_in_force,tif);
 assert.throws(()=>tx.orderBody({clientOrderId:'c',symbol:'X-USD',side:'buy',type:'market',qtyStr:'1',timeInForce:'ioc'}),e=>e.code==='validation');
 assert.throws(()=>tx.orderBody({clientOrderId:'c',symbol:'X-USD',side:'buy',type:'market',qtyStr:0.1}),e=>e.code==='validation');
 assert.throws(()=>tx.orderBody({clientOrderId:'c',symbol:'X-USD',side:'buy',type:'market',qtyStr:'1e-7'}),e=>e.code==='validation');
 assert.throws(()=>tx.orderBody({clientOrderId:'c',symbol:'X-USD',side:'buy',type:'limit',qtyStr:'1'}),e=>e.code==='validation');
 assert.throws(()=>tx.orderBody({clientOrderId:'c',symbol:'X-USD',side:'short',type:'market',qtyStr:'1'}),e=>e.code==='validation');
 assert.throws(()=>tx.orderBody({clientOrderId:'c',symbol:'X-USD',side:'buy',type:'stop',qtyStr:'1'}),e=>e.code==='validation');
});

test('cancelOrder posts an empty body to the cancel path and signs it as such',async()=>{
 reset();const log=[];
 installFetch((u,init)=>init.method==='POST'&&u.pathname==='/api/v2/crypto/trading/orders/ord-1/cancel/'?textRes('',200):null,log);
 const r=await tx.cancelOrder('A','ord-1');
 assert.deepEqual(r,{submitted:true,order:null});
 assert.equal(log[0].body,'');
 assert.equal(log[0].search,'?account_number=A');
 assert.ok(verify(`${DOC_API_KEY}${log[0].headers['x-timestamp']}/api/v2/crypto/trading/orders/ord-1/cancel/?account_number=APOST`,log[0].headers['x-signature']));
 installFetch(()=>jsonRes({...RAW_ORDER,state:'canceled'}));
 const r2=await tx.cancelOrder('A','ord-1');
 assert.equal(r2.order.state,'canceled');
 installFetch(()=>jsonRes({type:'client_error',errors:[{detail:'Order is not cancellable',attr:null}]},400));
 await assert.rejects(tx.cancelOrder('A','ord-1'),e=>e.code==='http'&&e.status===400&&e.sent===true);
});

test('rhRequest normalises absolute URLs and bare paths against the base',async()=>{
 reset();const log=[];
 installFetch(()=>jsonRes({}),log);
 await tx.rhRequest({method:'GET',path:'https://trading.robinhood.com/api/v2/x/?a=1'});
 assert.equal(log[0].url,'https://rh.test/api/v2/x/?a=1');
 await tx.rhRequest({method:'GET',path:'api/v2/y/'});
 assert.equal(log[1].url,'https://rh.test/api/v2/y/');
 assert.equal(tx.__testing.requestLog.length,2);
 tx.__testing.resetTransport();
 assert.equal(tx.__testing.requestLog.length,0);
 assert.deepEqual(tx.rhLastAuth(),{error:null,code:null,at:0});
});
