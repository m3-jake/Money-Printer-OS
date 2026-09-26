// Robinhood stocks & ETFs paper lane: read-only HTTP (docs/ROBINHOOD-AUTO-TRADER.md §25).
// Same localhost + same-origin guard as src/robinhoodHttp.js. GET only; no action here can place any order.
import { robinhoodEquitiesSnapshot } from './robinhoodEquities.js';
export { startRobinhoodEquitiesLoop, stopRobinhoodEquitiesLoop } from './robinhoodEquities.js';
export async function handleRobinhoodEquitiesRequest(req,res,u,{json}){
 const deny=()=>json(res,{ok:false,error:'A local same-origin request is required',code:'notPermitted'},403);
 let host;try{host=new URL('http://'+req.headers.host)}catch{return deny()}
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return deny();
 if(!['127.0.0.1','localhost','[::1]'].includes(host.hostname))return deny();
 if(req.headers.origin&&req.headers.origin!==host.origin)return deny();
 if(req.method!=='GET')return json(res,{ok:false,error:'Method not allowed (read-only lane)'},405);
 if(u.pathname==='/api/robinhood-equities')return json(res,robinhoodEquitiesSnapshot());
 return json(res,{ok:false,error:'Not found'},404);
}
