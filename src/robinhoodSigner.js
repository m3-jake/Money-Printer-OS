// Robinhood Auto Trader — pure signing helpers (docs/ROBINHOOD-AUTO-TRADER.md §4, §20).
// No env, fs or fetch here. Ed25519 seed -> PKCS#8 KeyObject; message = apiKey+timestamp+path+METHOD+body.
import crypto from 'node:crypto';
import { RobinhoodError, fail } from './robinhoodErrors.js';

export const RH_BASE_URL='https://trading.robinhood.com';
export const PKCS8_ED25519_PREFIX=Buffer.from('302e020100300506032b657004220420','hex');

function decodeBase64(s){
 const t=String(s??'').trim();
 if(!t)fail('badKey','Robinhood private key is empty');
 if(!/^[A-Za-z0-9+/=_-]+$/.test(t))fail('badKey','Robinhood private key is not valid base64');
 return Buffer.from(t.replace(/-/g,'+').replace(/_/g,'/'),'base64');
}

export function loadRobinhoodPrivateKey(seedBase64){
 const raw=decodeBase64(seedBase64);
 if(raw.length===64)fail('badKey','Robinhood private key is 64 bytes: you pasted seed||publicKey; keep the first 32 bytes');
 if(raw.length!==32)fail('badKey',`Robinhood private key must be a base64 32-byte Ed25519 seed (got ${raw.length} bytes)`);
 try{return crypto.createPrivateKey({key:Buffer.concat([PKCS8_ED25519_PREFIX,raw]),format:'der',type:'pkcs8'})}
 catch(e){throw new RobinhoodError('badKey',`Robinhood private key rejected: ${String(e?.message||e)}`)}
}

export function publicKeyBase64(privateKey){
 const spki=crypto.createPublicKey(privateKey).export({type:'spki',format:'der'});
 return Buffer.from(spki.subarray(spki.length-32)).toString('base64');
}

export function generateRobinhoodKeyPair(){
 const {privateKey}=crypto.generateKeyPairSync('ed25519');
 const pkcs8=privateKey.export({type:'pkcs8',format:'der'});
 return {privateKeyBase64:Buffer.from(pkcs8.subarray(pkcs8.length-32)).toString('base64'),publicKeyBase64:publicKeyBase64(privateKey)};
}

export function buildSignedMessage({apiKey,timestamp,path,method,body=''}){
 return `${apiKey}${timestamp}${path}${String(method).toUpperCase()}${body??''}`;
}

export function signRequest({apiKey,privateKey,method,path,body='',timestamp=Math.floor(Date.now()/1000)}){
 const ts=String(Math.floor(Number(timestamp)));
 const msg=buildSignedMessage({apiKey,timestamp:ts,path,method,body});
 const sig=crypto.sign(null,Buffer.from(msg,'utf8'),privateKey);
 return {'x-api-key':String(apiKey),'x-timestamp':ts,'x-signature':Buffer.from(sig).toString('base64')};
}

// Query values are percent-encoded except commas (estimated_price wants quantity=0.1,1 verbatim).
const enc=v=>encodeURIComponent(String(v)).replace(/%2C/gi,',');
export function buildPath(pathname,query){
 const parts=[];
 if(query&&typeof query==='object')for(const [k,v] of Object.entries(query)){
  if(v===undefined||v===null)continue;
  if(Array.isArray(v)){for(const item of v){if(item===undefined||item===null)continue;parts.push(`${enc(k)}=${enc(item)}`)}}
  else parts.push(`${enc(k)}=${enc(v)}`);
 }
 return parts.length?`${pathname}?${parts.join('&')}`:pathname;
}

// ------------------------------------------------------------- decimals
function incrementInfo(increment){
 const n=Number(increment);
 if(!Number.isFinite(n)||n<=0)fail('increment',`Invalid increment ${String(increment)}`);
 let s=typeof increment==='string'?increment.trim():String(increment);
 if(/e/i.test(s))s=n.toFixed(20).replace(/0+$/,'');
 const frac=s.split('.')[1]||'';
 return {n,decimals:frac.length};
}
export function incrementDecimals(increment){return incrementInfo(increment).decimals}

function toIncrement(value,increment,roundFn){
 const v=Number(value);
 if(!Number.isFinite(v))fail('increment',`Cannot format non-finite value ${String(value)}`);
 const {n,decimals}=incrementInfo(increment);
 const scale=10**decimals;
 // Work in integer units of the increment to dodge binary rounding (0.1+0.2 style).
 const stepUnits=Math.round(n*scale);
 const valueUnits=v*scale;
 const steps=roundFn(valueUnits/stepUnits+(roundFn===Math.floor?1e-9:-1e-9));
 const units=steps*stepUnits;
 const out=(units/scale).toFixed(decimals);
 return out==='-0'||/^-0\.0*$/.test(out)?(0).toFixed(decimals):out;
}
export function formatIncrement(value,increment){return toIncrement(value,increment,Math.floor)}
export function ceilIncrement(value,increment){return toIncrement(value,increment,Math.ceil)}
