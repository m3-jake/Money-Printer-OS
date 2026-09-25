// Only read-only monitoring and simulated paper-book actions are exposed here.
import * as RH from './robinhoodAutoTrader.js';
export { startRobinhoodLoops, stopRobinhoodLoops } from './robinhoodAutoTrader.js';
export async function handleRobinhoodRequest(req,res,u,{json,body}){
 const deny=()=>json(res,{ok:false,error:'A local same-origin request is required',code:'notPermitted'},403);
 let host;try{host=new URL('http://'+req.headers.host)}catch{return deny()}
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return deny();
 if(!['127.0.0.1','localhost','[::1]'].includes(host.hostname))return deny();
 if(req.headers.origin&&req.headers.origin!==host.origin)return deny();
 if(req.method==='GET'){
  if(u.pathname==='/api/robinhood')return json(res,await RH.robinhoodSnapshot());
  if(u.pathname==='/api/robinhood/readiness')return json(res,RH.robinhoodReadiness());
  return json(res,{ok:false,error:'Not found'},404);
 }
 if(req.method!=='POST')return json(res,{ok:false,error:'Method not allowed'},405);
 if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')||req.headers['sec-fetch-site']==='cross-site')return deny();
 const b=await body(req);if(b.__error)return json(res,{ok:false,error:b.__error,code:'validation'},400);
 const action=u.pathname.slice('/api/robinhood/'.length);
 if(action==='paper-reset'&&b.confirmation!=='RESET PAPER')return json(res,{ok:false,error:'Type RESET PAPER to confirm',code:'confirmation'},400);
 const actions={
  'preview':()=>RH.previewRobinhoodOrder({symbol:b.symbol,usd:b.usd}),
  'paper-order':()=>RH.placeRobinhoodPaperOrder({symbol:b.symbol,usd:b.usd}),
  'paper-close':()=>RH.closeRobinhoodPaperPosition({id:b.id}),
  'paper-reset':()=>RH.resetRobinhoodPaper({amountUsd:b.amountUsd}),
  'paper-autopilot':()=>RH.setRobinhoodPaperAutopilot({enabled:b.enabled,orderUsd:b.orderUsd,maxOpen:b.maxOpen,symbols:b.symbols,params:b.params}),
  'paper-autopilot/run':()=>RH.runRobinhoodPaperOnce()
 };
 if(!Object.hasOwn(actions,action))return json(res,{ok:false,error:'This action is not available in the paper-only build'},404);
 try{return json(res,{ok:true,result:await actions[action]()})}
 catch(e){const messages={noCredentials:'Read-only API credentials are required for live quotes.',paperRecovery:'The paper book requires recovery. Review the warning before resetting.',orderCap:'Paper order size exceeds its allowed range.',openCap:'Paper position cap reached or invalid.',duplicate:'A paper position already exists for this symbol.',cooldown:'This symbol is cooling down.',paperCash:'Insufficient simulated buying power, including reserve and fees.',busy:'A paper operation is in progress. Retry.',notTradable:'The pair is not marked API-tradable.',notFound:'Paper position not found.',validation:'Invalid input or unavailable current quotes. Check size, symbols, and API readiness.',rateLimited:'Robinhood is rate-limiting reads. Let the backoff expire.'};const code=Object.hasOwn(messages,e?.code)?e.code:'unknown';return json(res,{ok:false,code,error:messages[code]||'The paper operation failed. Check the connection status.'},400)}
}
