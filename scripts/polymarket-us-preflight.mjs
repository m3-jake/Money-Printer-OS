#!/usr/bin/env node
// Polymarket US preflight: proves the API key and (optionally) the combos beta.
//
//   node scripts/polymarket-us-preflight.mjs [--env <path>] [--probe-combo] [--out <file>]
//
// Step 1 is a signed GET /v1/orders/open (read-only; proves the key).
// Step 2 runs only with --probe-combo AND a 2xx from step 1: a signed POST /v1/combos
// with two live comboEnabled legs from distinct events. That creates a combo
// instrument, not an order; no money moves. Nothing here places or accepts anything.
//
// Credentials are read from the environment, then from the app's .env
// (default %APPDATA%\Money Printer OS\.env). Values are never printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args=process.argv.slice(2);
const flag=name=>args.includes(name);
const opt=(name,d)=>{const i=args.indexOf(name);return i>=0&&args[i+1]?args[i+1]:d};
const today=(d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`)(new Date());
const appRoot=path.join(process.env.APPDATA||path.join(os.homedir(),'.config'),'Money Printer OS');
const envPath=opt('--env',path.join(appRoot,'.env'));
const outPath=path.resolve(opt('--out',path.join('reports',`polymarket-preflight-${today}.md`)));

function loadEnvFile(file){
 let text='';
 try{text=fs.readFileSync(file,'utf8')}catch{return false}
 for(const line of text.split(/\r?\n/)){
  const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if(!m||process.env[m[1]])continue;
  process.env[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');
 }
 return true;
}
const envLoaded=loadEnvFile(envPath);
// Isolate the combo module's journal so the probe never touches the live one.
process.env.MONEY_PRINTER_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-poly-preflight-'));
const {signedFetch,usLiveEvents,normalizeUSLiveState}=await import('../src/polymarketUSCombos.js');

const SECRET_KEYS=/^(id|orderId|comboId|symbol|accountId|userId|clientOrderId|rfqId|quoteId|key|keyId|email)$/i;
function redact(x,depth=0){
 if(depth>6)return '…';
 if(Array.isArray(x))return x.slice(0,5).map(v=>redact(v,depth+1)).concat(x.length>5?[`…(${x.length-5} more)`]:[]);
 if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,SECRET_KEYS.test(k)&&typeof v!=='object'?'[redacted]':redact(v,depth+1)]));
 return x;
}
const clip=s=>{const t=JSON.stringify(s,null,2);return t.length>2500?t.slice(0,2500)+'\n…(truncated)':t};

async function probe(method,pathname,opts){
 const started=Date.now();
 try{
  const body=await signedFetch(method,pathname,opts);
  return {method,pathname,status:'2xx',ok:true,code:'ok',ms:Date.now()-started,body:redact(body)};
 }catch(e){
  return {method,pathname,status:e?.status||0,ok:false,code:e?.code||'error',ms:Date.now()-started,body:{message:String(e?.message||e).slice(0,400)}};
 }
}

function pickComboLegs(events){
 const legs=[],seen=new Set();
 for(const ev of events){
  if(seen.has(ev.slug))continue;
  const m=(ev.markets||[]).find(x=>x&&x.comboEnabled===true&&!x.closed&&(!x.status||x.status==='MARKET_STATUS_OPEN'));
  if(!m)continue;
  seen.add(ev.slug);
  legs.push({symbol:String(m.slug),side:'SIDE_BUY',event:String(ev.title||ev.slug),period:normalizeUSLiveState(ev).rawPeriod});
  if(legs.length===2)break;
 }
 return legs;
}

const results=[];
const hasCreds=!!(process.env.POLYMARKET_KEY_ID&&process.env.POLYMARKET_SECRET_KEY);
let keyProbe=null,comboProbe=null,comboNote='';
if(!hasCreds){
 comboNote='No credentials in the environment or the .env file; nothing was sent.';
}else{
 keyProbe=await probe('GET','/v1/orders/open');
 results.push(keyProbe);
 if(!keyProbe.ok)comboNote=`Skipped: the key probe failed (${keyProbe.code}); a combo probe would fail the same way.`;
 else if(!flag('--probe-combo'))comboNote='Skipped: pass --probe-combo to run the signed POST /v1/combos probe.';
 else{
  const feed=await usLiveEvents({force:true});
  const legs=pickComboLegs(feed.events||[]);
  if(legs.length<2)comboNote=`Skipped: only ${legs.length} live comboEnabled event(s) right now (feed ok=${feed.ok}, live=${feed.live}). Retry during live games.`;
  else{
   comboProbe=await probe('POST','/v1/combos',{body:{legs:legs.map(({symbol,side})=>({symbol,side}))}});
   comboProbe.legs=legs;
   results.push(comboProbe);
  }
 }
}

function verdict(){
 if(!hasCreds)return 'NO CREDENTIALS: configure the key in the app (Polymarket window), then rerun.';
 if(keyProbe.status===401||keyProbe.code==='keyNotFound')return '401 keyNotFound: regenerate the key at polymarket.us/developer. Keep building; tests mock fetch.';
 if(!keyProbe.ok)return `Key probe failed (${keyProbe.code}, status ${keyProbe.status}). Investigate before trusting any branch.`;
 if(!comboProbe)return 'Key OK. Combo beta NOT probed yet.';
 if(comboProbe.status===403||comboProbe.code==='betaNotEnabled')return '403 on /v1/combos: build the singles fallback and label Place "combos beta pending".';
 if(comboProbe.ok)return '2xx on /v1/combos: combos are primary.';
 return `Combo probe failed (${comboProbe.code}, status ${comboProbe.status}). Not a clean 403; investigate.`;
}

const lines=[
 `# Polymarket US preflight, ${today}`,'',
 `Generated by \`scripts/polymarket-us-preflight.mjs\` at ${new Date().toISOString()}.`,
 `Credentials: ${hasCreds?'present':'missing'} (env file ${envLoaded?'read':'not found'}). Values are never written here; ids in bodies are redacted.`,'',
 `**Verdict:** ${verdict()}`,'',
 '| Call | Status | Code | ms |','| --- | --- | --- | --- |',
 ...results.map(r=>`| \`${r.method} ${r.pathname}\` | ${r.status} | ${r.code} | ${r.ms} |`),
 ...(comboNote?['',`Combo probe: ${comboNote}`]:[]),
 ...results.flatMap(r=>['',`## ${r.method} ${r.pathname}`,...(r.legs?['','Legs: '+r.legs.map(l=>`${l.event} (${l.period||'?'})`).join(' + ')]:[]),'','```json',clip(r.body),'```']),
 '',
];
fs.mkdirSync(path.dirname(outPath),{recursive:true});
fs.writeFileSync(outPath,lines.join('\n'));
console.log(verdict());
console.log(`report: ${path.relative(process.cwd(),outPath)}`);
