import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {isRobinhoodReadOnlyRequest} from '../src/robinhoodReadOnly.js';
import {appendTransportAudit,transportRouteClass,TRANSPORT_LOG_CAPACITY} from '../src/transportAudit.js';
const raw=fs.readFileSync(new URL('../src/robinhoodTransport.js',import.meta.url),'utf8');
const source=raw.replace(/^import .*;\r?\n/gm,'').replace(/^export \{[^\n]+\r?\n/gm,'').replace(/^export /gm,'');
class FixtureError extends Error{constructor(code,message,status){super(message);this.code=code;this.status=status}}
for(const status of [301,302,303,307,308,200]){
 test(`transport refuses ${status===200?'already-followed':status} redirects without following or retaining signatures`,async()=>{
  const calls=[];let signed=0;
  const context=vm.createContext({crypto,isRobinhoodReadOnlyRequest,appendTransportAudit,transportRouteClass,TRANSPORT_LOG_CAPACITY,
   process:{env:{ROBINHOOD_API_KEY:'fixture-key',ROBINHOOD_PRIVATE_KEY:'fixture-seed'}},Date,URL,AbortSignal,
   RobinhoodError:FixtureError,RH_CODES:{},RH_BASE_URL:'https://fixture.invalid',
   fail:(code,message,status)=>{throw new FixtureError(code,message,status)},assertLiveDispatchAllowed:()=>{throw Error('Live dispatch forbidden in fixture')},
   loadRobinhoodPrivateKey:()=>({fixture:true}),signRequest:()=>{signed++;return {'x-signature':'FAKE_NOT_A_SIGNATURE','x-api-key':'fixture-key'}},buildPath:p=>p,
   fetch:async(url,init)=>{calls.push({url,init});return {status,redirected:status===200,headers:{get:()=> 'https://other.invalid'},text:async()=>{throw Error('Redirect body must not be consumed')}}}});
  vm.runInContext(source+'\nthis.request=rhRequest;this.log=requestLog;',context);
  await assert.rejects(context.request({method:'GET',path:'/api/v2/crypto/trading/accounts/'}),{code:'RH_REDIRECT_REFUSED'});
  assert.equal(calls.length,1);assert.equal(signed,1);assert.equal(calls[0].init.redirect,'manual');
  assert.equal(calls[0].url,'https://fixture.invalid/api/v2/crypto/trading/accounts/');
  assert.doesNotMatch(JSON.stringify(context.log),/FAKE_NOT_A_SIGNATURE|fixture-key|headers|body/);
 });
}
