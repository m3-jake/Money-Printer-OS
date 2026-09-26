import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

// Two live soccer games in stoppage time, served to the combo feed in place of gateway.polymarket.us.
function liveGame(slug){
  return {slug,title:`${slug} game`,live:true,closed:false,ended:false,period:"89'",score:'2-0',tags:[{slug:'sports'},{slug:'soccer'}],
    markets:[{slug:`atc-${slug}-home`,question:'Will home win?',sportsMarketType:'soccer_team_full_time_winner',comboEnabled:true,status:'MARKET_STATUS_OPEN',
      minimumTradeQty:0.01,orderPriceMinTickSize:0.01,feeCoefficient:0.06,bestAskQuote:{value:'0.9000'},bestBidQuote:{value:'0.8900'},outcomes:'["Yes","No"]',
      marketSides:[{description:'Yes',long:true,tradable:true},{description:'No',long:false,tradable:true}]}]};
}

test('dashboard captures real visits/order outcomes and rejects unauthenticated money writes', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-product-http-'));
  process.env.MONEY_PRINTER_DATA_DIR=dir;
  process.env.DASHBOARD_PORT='0';
  process.env.DASHBOARD_HOST='127.0.0.1';
  process.env.MODE='paper';
  process.env.POLYMARKET_AUTOSTART='false';process.env.ROBINHOOD_AUTOSTART='false';
  process.env.POLYMARKET_AUTOPILOT='false';
  process.env.POLYMARKET_US_COMBO_BBO='false';
  const realFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    const u=new URL(String(url));
    if(u.hostname==='gateway.polymarket.us'&&u.pathname==='/v1/events'){
      const body=JSON.stringify({events:[liveGame('sa-aaa-bbb-2026-09-25'),liveGame('sb-ccc-ddd-2026-09-25')]});
      return {ok:true,status:200,text:async()=>body};
    }
    if(u.hostname!=='127.0.0.1')throw new Error('Unexpected network call '+u.href);
    return realFetch(url,init);
  };
  process.env.PRODUCT_ECONOMICS_INGEST_TOKEN='test-only-server-secret-'.repeat(3);
  const { startDashboard }=await import('../src/dashboard.js');
  const { productEconomics }=await import('../src/productEconomics.js');
  const server=startDashboard();
  t.after(async()=>{globalThis.fetch=realFetch;await new Promise(resolve=>server.close(resolve));productEconomics().close();fs.rmSync(dir,{recursive:true,force:true})});
  if(!server.listening)await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(endpoint,event,headers={})=>fetch(base+endpoint,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(event)});
  const paid={eventId:'test-provider:1',type:'payment',userId:'test-user',currency:'USD',amountUsd:10,provider:'test-provider',reference:'test-transaction'};
  let r=await post('/api/product-economics/event',paid);
  assert.equal(r.status,401);
  r=await post('/api/product-economics/event',paid,{authorization:`Bearer ${process.env.PRODUCT_ECONOMICS_INGEST_TOKEN}`,origin:base});
  assert.equal(r.status,401);
  r=await fetch(base+'/?utm_source=pilot&utm_medium=referral');
  assert.equal(r.status,200);
  const cookie=r.headers.get('set-cookie').split(';')[0];
  await r.text();
  // The paper lab is detached: its routes are gone.
  r=await post('/api/polymarket/paper-single',{leg:{marketId:'test-market',price:0.5},stakeUsd:1},{cookie});
  assert.equal(r.status,404);await r.text();
  const snap=await (await fetch(base+'/api/polymarket-us/combos',{headers:{cookie}})).json();
  const legKeys=snap.candidates.map(c=>c.key);
  assert.equal(legKeys.length,2);
  // A rejected build (one leg, then a bad stake) does not activate; the first priced build does.
  r=await post('/api/polymarket-us/combos/build',{legKeys:legKeys.slice(0,1),stakeUsd:5},{cookie});
  assert.equal(r.status,400);await r.text();
  r=await post('/api/polymarket-us/combos/build',{legKeys,stakeUsd:-1},{cookie});
  assert.equal(r.status,400);await r.text();
  assert.equal((await (await fetch(base+'/api/product-economics')).json()).totals.activatedUsers,0);
  r=await post('/api/polymarket-us/combos/build',{legKeys,stakeUsd:5},{cookie});
  assert.equal(r.status,200);assert.equal((await r.json()).combo.legs.length,2);
  r=await post('/api/polymarket-us/combos/build',{legKeys,stakeUsd:6},{cookie});
  assert.equal(r.status,200);await r.text();
  const s=await (await fetch(base+'/api/product-economics')).json();
  assert.equal(s.totals.visitors,1);assert.equal(s.totals.activatedUsers,1);assert.equal(s.totals.payingUsers,0);assert.equal(s.totals.netRevenueUsd,0);
  assert.equal(s.bySource[0].attribution.source,'pilot');
  const auth={authorization:`Bearer ${process.env.PRODUCT_ECONOMICS_INGEST_TOKEN}`};
  r=await post('/api/product-economics/event',paid,auth);assert.equal(r.status,200);assert.equal((await r.json()).duplicate,false);
  r=await post('/api/product-economics/event',paid,auth);assert.equal((await r.json()).duplicate,true);
  assert.equal((await (await fetch(base+'/api/product-economics')).json()).totals.netRevenueUsd,10);
});
