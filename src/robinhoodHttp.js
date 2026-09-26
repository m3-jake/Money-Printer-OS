// Robinhood Auto Trader HTTP surface (docs/ROBINHOOD-AUTO-TRADER.md §11).
// Localhost + same-origin + JSON guards, then every real-money, paper and evolution (§22, paper-only) action of §20. Typed phrases are
// forwarded verbatim and compared with === inside src/robinhoodAutoTrader.js; placedBy is always 'manual' here.
import * as RH from './robinhoodAutoTrader.js';
import { creds } from './robinhoodTransport.js';
import * as RP from './robinhoodPractice.js';
import path from 'node:path';
export { startRobinhoodLoops, stopRobinhoodLoops } from './robinhoodAutoTrader.js';
export { startPracticeLoop, stopPracticeLoop } from './robinhoodPractice.js';
const redact=m=>{let t=String(m||'').slice(0,240);for(const v of Object.values(creds()))if(v)t=t.split(v).join('[redacted]');return t};
const str=v=>v===undefined||v===null?undefined:String(v);
export async function handleRobinhoodRequest(req,res,u,{json,body}){
 const deny=()=>json(res,{ok:false,error:'A local same-origin request is required',code:'notPermitted'},403);
 let host;try{host=new URL('http://'+req.headers.host)}catch{return deny()}
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return deny();
 if(!['127.0.0.1','localhost','[::1]'].includes(host.hostname))return deny();
 if(req.headers.origin&&req.headers.origin!==host.origin)return deny();
 if(req.method==='GET'){
  if(u.pathname==='/api/robinhood')return json(res,await RH.robinhoodSnapshot());
  if(u.pathname==='/api/robinhood/practice')return json(res,RP.practiceSnapshot({dataDir:path.dirname(RH.__testing.journalFile)}));
  if(u.pathname==='/api/robinhood/readiness')return json(res,RH.robinhoodReadiness());
  if(u.pathname==='/api/robinhood/evolve')return json(res,RH.robinhoodEvolveView());
  if(u.pathname==='/api/robinhood/chart'){try{return json(res,RH.robinhoodChart({symbol:u.searchParams.get('symbol')||undefined,range:u.searchParams.get('range')||'6h'}))}catch(e){return json(res,{ok:false,error:redact(e?.message||'chart failed'),code:e?.code||'unknown'},400)}}
  return json(res,{ok:false,error:'Not found'},404);
 }
 if(req.method!=='POST')return json(res,{ok:false,error:'Method not allowed'},405);
 if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')||req.headers['sec-fetch-site']==='cross-site')return deny();
 const b=await body(req);if(b.__error)return json(res,{ok:false,error:b.__error,code:'validation'},400);
 const action=u.pathname.slice('/api/robinhood/'.length);
 if(action==='practice')return json(res,RP.practiceSnapshot({dataDir:path.dirname(RH.__testing.journalFile)}));
 if(action==='paper-reset'&&b.confirmation!=='RESET PAPER')return json(res,{ok:false,error:'Type RESET PAPER to confirm',code:'confirmation'},400);
 const actions={
  'config':()=>RH.configureRobinhood({apiKey:b.apiKey,privateKey:b.privateKey,realEnabled:b.realEnabled===true}),
  'arm':()=>RH.armRobinhood(b.armed===true),
  'preview':()=>RH.previewRobinhoodOrder({symbol:b.symbol,side:b.side==='sell'?'sell':'buy',usd:b.usd,qty:b.qty,orderType:b.orderType||'market',entryId:str(b.entryId)}),
  'order':()=>RH.placeRobinhoodOrder({symbol:b.symbol,side:b.side==='sell'?'sell':'buy',usd:b.usd,qty:b.qty,orderType:b.orderType||'market',entryId:str(b.entryId),confirmation:b.confirmation,placedBy:'manual',overrideCooldown:b.overrideCooldown===true,reason:'manual'}),
  'cancel':()=>RH.cancelRobinhoodOrder({entryId:str(b.entryId),confirmation:b.confirmation}),
  'cancel-all':()=>RH.cancelAllRobinhood({confirmation:b.confirmation}),
  'forget':()=>RH.forgetRobinhoodEntry({entryId:str(b.entryId),confirmation:b.confirmation,acknowledgeHolding:b.acknowledgeHolding===true}),
  'reconcile':()=>RH.reconcileRobinhood({force:true}),
  'autopilot':()=>RH.setRobinhoodAutopilot({enabled:b.enabled,confirmation:b.confirmation,orderUsd:b.orderUsd,maxOpen:b.maxOpen,dailyLossCapUsd:b.dailyLossCapUsd,symbols:b.symbols,orderType:b.orderType}),
  'autopilot/run':()=>RH.runRobinhoodAutopilotOnce(),
  'paper-order':()=>RH.placeRobinhoodPaperOrder({symbol:b.symbol,usd:b.usd}),
  'paper-close':()=>RH.closeRobinhoodPaperPosition({id:b.id}),
  'paper-reset':()=>RH.resetRobinhoodPaper({amountUsd:b.amountUsd}),
  'paper-autopilot':()=>RH.setRobinhoodPaperAutopilot({enabled:b.enabled,orderUsd:b.orderUsd,maxOpen:b.maxOpen,symbols:b.symbols,params:b.params}),
  'paper-autopilot/run':()=>RH.runRobinhoodPaperOnce(),
  'practice/config':()=>RP.configurePractice({dataDir:path.dirname(RH.__testing.journalFile),patch:b,now:Date.now()}),
  'practice/run':()=>RP.runPracticeCycle({dataDir:path.dirname(RH.__testing.journalFile),now:Date.now()}),
  'practice/order':()=>RP.placePracticeOrder({dataDir:path.dirname(RH.__testing.journalFile),symbol:b.symbol,now:Date.now()}),
  'practice/close':()=>RP.closePracticeOrder({dataDir:path.dirname(RH.__testing.journalFile),id:String(b.id||''),now:Date.now()}),
  'practice/reset':()=>RP.resetPractice({dataDir:path.dirname(RH.__testing.journalFile),budgetUsd:b.budgetUsd,now:Date.now()}),
  'evolve/run':()=>RH.runRobinhoodEvolveOnce({manual:true}),
  'evolve/apply':()=>RH.applyRobinhoodEvolution({paramsHash:str(b.paramsHash),by:'operator'})
 };
 if(!Object.hasOwn(actions,action))return json(res,{ok:false,error:'Not found'},404);
 try{return json(res,{ok:true,result:await actions[action]()})}
 catch(e){return json(res,{ok:false,error:redact(e?.message||'The Robinhood action failed'),code:e?.code||'unknown'},400)}
}
