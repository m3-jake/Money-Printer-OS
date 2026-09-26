import { marketPlatform } from './platform.js';

export function localMutationAllowed(req) {
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress))return false;
  if(req.headers['sec-fetch-site']==='cross-site')return false;
  if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return false;
  if(req.headers.origin){try{const origin=new URL(req.headers.origin);if(!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||origin.host!==req.headers.host)return false;}catch{return false;}}
  return true;
}
export async function handlePlatformRequest(req,res,url,{json,body,platform=marketPlatform()}={}) {
  const route=url.pathname.slice('/api/platform'.length);
  try{
    if(req.method==='GET'){
      if(route==='/status')return json(res,{ok:true,...platform.snapshot()});
      if(route==='/markets')return json(res,{ok:true,...await platform.markets(url.searchParams.get('venue')||'kalshi',{cursor:url.searchParams.get('cursor')||'',offset:Number(url.searchParams.get('cursor')||0)||0,series:url.searchParams.get('series')||'',eventTicker:url.searchParams.get('event')||''})});
      if(route==='/book')return json(res,{ok:true,...await platform.book(url.searchParams.get('venue'),url.searchParams.get('id'))});
      if(route==='/entities')return json(res,{ok:true,entities:platform.store.list({kind:url.searchParams.get('kind')||null,provider:url.searchParams.get('provider')||null})});
      if(route==='/strategies')return json(res,{ok:true,strategies:platform.strategies.list()});
      if(route==='/strategies/history')return json(res,{ok:true,history:platform.strategies.history(url.searchParams.get('id'))});
      if(route==='/arbitrage/candidates')return json(res,{ok:true,...platform.arbitrageCandidates({limit:Number(url.searchParams.get('limit'))||50})});
      if(route==='/stocks/status')return json(res,{ok:true,...await platform.stocksStatus(url.searchParams.get('symbols')||'')});
      if(route==='/stocks/bars')return json(res,{ok:true,...platform.stocksBars(url.searchParams.get('symbol'))});
      if(route==='/lab/sources')return json(res,{ok:true,...platform.labSources()});
      if(route==='/lab/runs')return json(res,{ok:true,runs:platform.labRuns(50)});
      if(route==='/macro')return json(res,{ok:true,...await platform.macroSnapshot({force:url.searchParams.get('force')==='1'})});
      if(route==='/macro/asof')return json(res,{ok:true,...await platform.macroAsOf({id:url.searchParams.get('id'),asOf:url.searchParams.get('asOf')})});
      if(route==='/diagnostics')return json(res,{ok:true,...platform.diagnostics()});
      if(route==='/events')return json(res,{ok:true,...await platform.eventPages({force:url.searchParams.get('force')==='1'})});
      if(route==='/whales')return json(res,{ok:true,...platform.whaleSnapshot({minSol:url.searchParams.get('minSol')})});
      if(route==='/whales/token')return json(res,{ok:true,...platform.whaleToken(url.searchParams.get('mint'))});
      if(route==='/whales/wallet')return json(res,{ok:true,...platform.whaleWallet(url.searchParams.get('address'))});
      if(route==='/wire')return json(res,{ok:true,...await platform.wireSnapshot({force:url.searchParams.get('force')==='1'})});
      if(route==='/sports')return json(res,{ok:true,...await platform.sportsSnapshot({force:url.searchParams.get('force')==='1'})});
      if(route==='/weather')return json(res,{ok:true,...await platform.weatherSnapshot({force:url.searchParams.get('force')==='1'})});
      if(route==='/edgar/status')return json(res,{ok:true,status:platform.edgar.status()});
      if(route==='/edgar/latest')return json(res,{ok:true,...await platform.edgarLatest(url.searchParams.get('form')||'8-K')});
      if(route==='/edgar/company')return json(res,{ok:true,...await platform.edgarCompany(url.searchParams.get('ticker')||'')});
      if(route==='/edgar/form4')return json(res,{ok:true,...await platform.edgarForm4(url.searchParams.get('url')||'')});
      if(route==='/relationships')return json(res,{ok:true,relationships:platform.store.relationships(url.searchParams.get('id'))});
    }
    if(req.method==='POST'){
      if(!localMutationAllowed(req))return json(res,{ok:false,error:'Local same-origin JSON request required'},403);
      const input=await body(req);if(input.__error)return json(res,{ok:false,error:input.__error},400);
      let result;
      if(route==='/risk/halt')result=platform.risk.halt();
      else if(route==='/risk/resume-paper')result=platform.risk.resumePaper(input.confirmation);
      else if(route==='/risk/limits')result=platform.risk.setLimits(input);
      else if(route==='/paper/fund')result=platform.deposit(input);
      else if(route==='/orders/propose')result=await platform.propose(input);
      else if(route==='/orders/execute')result=platform.executePaper(input.id,input.confirmation);
      else if(route==='/strategies/register')result=platform.strategies.register(input);
      else if(route==='/strategies/sync-lab')result=platform.syncLab();
      else if(route==='/strategies/transition')result=platform.transitionStrategy(input);
      else if(route==='/stocks/fund')result=platform.deposit({venue:'stocks-paper',amount:input.amount,id:input.id});
      else if(route==='/stocks/preview')result=await platform.stocksPreview(input);
      else if(route==='/stocks/submit')result=platform.stocks.submit(input.id);
      else if(route==='/stocks/cancel')result=platform.stocks.cancel(input.id);
      else if(route==='/lab/walkforward')result=await platform.labWalkForward(input);
      else if(route==='/lab/run')result=await platform.labRun(input);
      else if(route==='/lab/replay/start')result=await platform.labReplayStart(input);
      else if(route==='/lab/replay/step')result=platform.labReplayStep(input);
      else if(route==='/whales/label')result=platform.labelWallet(input);
      else if(route==='/legacy/sync')result=platform.syncLegacyLedger();
      else if(route==='/edgar/summary')result=await platform.edgarSummary(input);
      else if(route==='/watchlist')result=platform.watch(input.id,input.on===true);
      else if(route==='/compare/verify')result=platform.verifyPair(input);
      else if(route==='/compare')result=await platform.compare(input);
      else return json(res,{ok:false,error:'Unknown platform action'},404);
      return json(res,{ok:true,result});
    }
    return json(res,{ok:false,error:'Unknown platform endpoint'},404);
  }catch(e){return json(res,{ok:false,error:String(e.message||e).slice(0,400),code:e.code||'PLATFORM_ERROR'},e.code==='RATE_LIMITED'?429:400);}
}
