// Offline Robinhood API mock for the auto-trader suites. Never talks to the network; every request is logged.
import fs from 'node:fs';
export function createRobinhoodMock({origin='https://rh.test',journalFile=null}={}){
 const state={time:1700000000000,bid:100,ask:100.1,quoteTime:null,buyingPower:500,feeRatio:0.0085,tradable:true,
  orders:new Map(),placeMode:'filled',cancelMode:'immediate',network:'up',onPlace:null,seq:0};
 const calls=[];
 const res=(status,payload)=>({ok:status>=200&&status<300,status,headers:{get:h=>h.toLowerCase()==='date'?new Date(state.time).toUTCString():null},text:async()=>JSON.stringify(payload)});
 const fetch=async(url,init={})=>{
  const u=new URL(url);const method=init.method||'GET';let body=null;try{body=init.body?JSON.parse(init.body):null}catch{}
  calls.push({path:u.pathname,method,query:Object.fromEntries(u.searchParams),body,headers:init.headers||{}});
  if(u.origin!==origin)throw new Error('Unexpected origin '+u.origin);
  if(state.network==='down'){const e=new Error('fetch failed');e.name='TypeError';throw e}
  if(state.network==='timeout'){const e=new Error('The operation was aborted due to timeout');e.name='TimeoutError';throw e}
  const p=u.pathname;
  if(method==='GET'){
   if(p.endsWith('/accounts/'))return res(200,{results:[{account_number:'ACC-TEST-9876',status:'active',buying_power:String(state.buyingPower),is_api_tradable:state.tradable,fee_tier_status:{fee_ratio:state.feeRatio}}]});
   if(p.endsWith('/trading_pairs/'))return res(200,{results:u.searchParams.getAll('symbol').map(symbol=>({symbol,asset_code:symbol.split('-')[0],asset_increment:'0.000001',quote_increment:'0.01',max_order_size:'100',min_order_amount:'1',status:'tradable',is_api_tradable:state.tradable}))});
   if(p.endsWith('/best_bid_ask/'))return res(200,{results:u.searchParams.getAll('symbol').map(symbol=>({symbol,bid:state.bid,ask:state.ask,...(state.quoteTime===null?{}:{timestamp:new Date(state.quoteTime).toISOString()})}))});
   if(p.endsWith('/estimated_price/'))return res(200,{results:String(u.searchParams.get('quantity')||'').split(',').map(q=>({symbol:u.searchParams.get('symbol'),side:u.searchParams.get('side'),quantity:q,price:u.searchParams.get('side')==='bid'?state.bid:state.ask,fee_ratio:state.feeRatio}))});
   const m=p.match(/\/orders\/([^/]+)\/$/);
   if(m){const o=state.orders.get(m[1]);return o?res(200,o):res(404,{detail:'not found'})}
   if(p.endsWith('/orders/')){let rows=[...state.orders.values()];const sym=u.searchParams.get('symbol'),side=u.searchParams.get('side');if(sym)rows=rows.filter(o=>o.symbol===sym);if(side)rows=rows.filter(o=>o.side===side);return res(200,{results:rows,next:null})}
   return res(404,{detail:'unexpected GET '+p});
  }
  if(method==='POST'){
   if(/\/orders\/[^/]+\/cancel\/$/.test(p)){const id=p.split('/').slice(-3,-2)[0];const o=state.orders.get(id);if(!o)return res(404,{detail:'not found'});if(state.cancelMode==='immediate'){o.state='canceled'}else o.cancel_requested=true;return res(200,o)}
   if(p.endsWith('/orders/')){
    if(journalFile){const j=JSON.parse(fs.readFileSync(journalFile,'utf8'));const row=j.open.find(e=>e.clientOrderId===body.client_order_id||e.exit?.clientOrderId===body.client_order_id);if(!row)throw new Error('ORDER POSTED WITHOUT A JOURNAL ROW');if(row.clientOrderId===body.client_order_id&&row.status!=='PENDING_SUBMIT')throw new Error('buy row not PENDING_SUBMIT before send: '+row.status);if(row.exit?.clientOrderId===body.client_order_id&&row.status!=='CLOSING')throw new Error('sell row not CLOSING before send')}
    if(state.onPlace)state.onPlace(body);
    const mode=state.placeMode;
    if(mode==='reject400')return res(400,{type:'validation_error',errors:[{detail:'Insufficient buying power',attr:'asset_quantity'}]});
    if(mode==='reject401')return res(401,{detail:'API key not found'});
    if(mode==='reject403')return res(403,{detail:'forbidden scope'});
    if(mode==='reject429')return res(429,{detail:'slow down'});
    if(mode==='network'){const e=new Error('socket hang up');throw e}
    if(mode==='timeout'){const e=new Error('The operation was aborted due to timeout');e.name='TimeoutError';throw e}
    const cfg=body.market_order_config||body.limit_order_config,qty=cfg.asset_quantity,price=body.side==='buy'?state.ask:state.bid;
    const id='ord-'+(++state.seq);
    const o={id,client_order_id:body.client_order_id,symbol:body.symbol,side:body.side,type:body.type,state:mode==='open'?'open':mode==='lost'?'open':'filled',filled_asset_quantity:mode==='filled'?qty:'0',average_price:mode==='filled'?String(price):null,executions:[],market_order_config:{asset_quantity:qty},created_at:new Date(state.time).toISOString(),updated_at:new Date(state.time).toISOString()};
    if(mode!=='lost')state.orders.set(id,o);
    return res(201,o);
   }
  }
  return res(404,{detail:'unexpected '+method+' '+p});
 };
 const fill=(id,{price,qty}={})=>{const o=state.orders.get(id);if(!o)throw new Error('no order '+id);o.state='filled';o.filled_asset_quantity=qty??(o.market_order_config?.asset_quantity)??o.filled_asset_quantity;o.average_price=String(price??(o.side==='buy'?state.ask:state.bid));return o};
 return {state,calls,fetch,fill,writes:()=>calls.filter(c=>c.method==='POST'),signed:()=>calls.filter(c=>c.headers['x-api-key'])};
}
