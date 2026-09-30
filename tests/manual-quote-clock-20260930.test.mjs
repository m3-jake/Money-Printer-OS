import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/robinhoodHttp.js',import.meta.url),'utf8');
const handlerSource=source.slice(source.indexOf('export async function handleRobinhoodRequest')).replace('export async function','async function');
for(const [action,fn,payload] of [['run','runPracticeCycle',{}],['order','placePracticeOrder',{symbol:'BTC-USD'}],['close','closePracticeOrder',{id:'position-fixture'}]]){
 test(`manual practice/${action} leaves clock sampling to the post-fetch implementation`,async()=>{
  let supplied=null,reply=null;
  const context=vm.createContext({URL,Date,path,RH:{__testing:{journalFile:path.join('isolated-fixture','book.json')}},RD:{},str:v=>v,redact:v=>String(v),RP:{[fn]:async options=>{supplied=options;return {fixture:true}}}});
  vm.runInContext(handlerSource+'\nthis.handle=handleRobinhoodRequest;',context);
  const request={method:'POST',headers:{host:'127.0.0.1:9876','content-type':'application/json',origin:'http://127.0.0.1:9876'},socket:{remoteAddress:'127.0.0.1'}};
  await context.handle(request,{},new URL('http://127.0.0.1:9876/api/robinhood/practice/'+action),{body:async()=>payload,json:(_res,value,status=200)=>{reply={value,status}}});
  assert.equal(reply.status,200);assert.equal(reply.value.ok,true);assert.ok(supplied);
  assert.equal(Object.hasOwn(supplied,'now'),false,'a pre-fetch wall clock must not be injected by HTTP');
  assert.equal(supplied.dataDir,'isolated-fixture');if(payload.symbol)assert.equal(supplied.symbol,payload.symbol);if(payload.id)assert.equal(supplied.id,payload.id);
 });
}
test('practice implementation retains the dynamic clock after awaited quote acquisition',()=>{
 const source=fs.readFileSync(new URL('../src/robinhoodPractice.js',import.meta.url),'utf8');
 assert.match(source,/const realClock=now===null/);
 assert.match(source,/await fetchMarket\(s\.symbols[^;]+; if\(realClock\)\{now=Date\.now\(\)/);
 assert.match(source,/await fetchMarket\(\[symbol\][^;]+;\s*now=now\?\?Date\.now\(\)/);
});
