import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTransportAudit, TRANSPORT_LOG_CAPACITY, transportRouteClass } from '../src/transportAudit.js';
import { isRobinhoodReadOnlyRequest } from '../src/robinhoodReadOnly.js';
import { rhRequest, ROBINHOOD_LIVE_TRADING_ENABLED, __testing } from '../src/robinhoodTransport.js';

test('diagnostic retention is bounded and contains no raw secrets, queries or payloads', () => {
  const rows=[];
  for(let i=0;i<1000;i++) appendTransportAudit(rows,{method:'GET',path:'/api/v2/crypto/trading/orders/private-customer-id/?api_key=SECRET',at:i,headers:{authorization:'SECRET'},body:'PRIVATE_BODY',url:'PRIVATE_URL'});
  assert.equal(rows.length,TRANSPORT_LOG_CAPACITY); assert.equal(rows[0].at,744); assert.equal(rows.at(-1).at,999);
  assert.ok(rows.every(r=>Object.isFrozen(r) && Object.keys(r).sort().join(',')==='at,method,route'));
  assert.doesNotMatch(JSON.stringify(rows),/SECRET|private-customer-id|PRIVATE_BODY|PRIVATE_URL|authorization/);
  assert.equal(transportRouteClass('/private/SECRET'),'other');
  assert.equal(appendTransportAudit(rows,{method:'SECRET',path:'/private',at:NaN}).method,'OTHER');
});
test('existing read wrappers are allowlisted, including order supervision and pagination', () => {
  for(const v of ['v1','v2']) for(const resource of ['accounts','holdings','trading_pairs','orders','estimated_price'])
    assert.equal(isRobinhoodReadOnlyRequest({method:'GET',path:`/api/${v}/crypto/trading/${resource}/?account_number=fixture&cursor=next`}),true);
  assert.equal(isRobinhoodReadOnlyRequest({path:'/api/v2/crypto/marketdata/best_bid_ask/?symbol=BTC-USD'}),true);
  assert.equal(isRobinhoodReadOnlyRequest({path:'/api/v2/crypto/trading/orders/123456-abcd/'}),true);
});
test('non-read methods, action aliases, encoded actions, override queries and GET bodies are denied', () => {
  for(const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS','TRACE','CONNECT'])
    assert.equal(isRobinhoodReadOnlyRequest({method,path:'/api/v2/crypto/trading/orders/'}),false);
  for(const path of ['/api/v2/crypto/trading/orders/id/cancel/','/api/v2/crypto/trading/orders/%63ancel/','/api/v2/crypto/trading/orders/?_method=POST','/api/v2/crypto/trading/orders/?action=cancel','/api/v2/crypto/trading/unknown/'])
    assert.equal(isRobinhoodReadOnlyRequest({path}),false);
  assert.equal(isRobinhoodReadOnlyRequest({path:'/api/v2/crypto/trading/accounts/',json:{}}),false);
});
test('real dispatch barrier rejects mutations before signing on every configured destination', async () => {
  const previous=process.env.ROBINHOOD_API;
  try {
    __testing.resetTransport(); assert.equal(ROBINHOOD_LIVE_TRADING_ENABLED,false);
    for(const destination of ['https://trading.robinhood.com','http://localhost:12345','http://127.0.0.1:12345','https://fixture.test','https://unknown.invalid']) {
      process.env.ROBINHOOD_API=destination;
      for(const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS','TRACE','CONNECT'])
        await assert.rejects(rhRequest({method,path:'/api/v2/crypto/trading/orders/'}),{code:'ROBINHOOD_PAPER_ONLY_BUILD'});
      await assert.rejects(rhRequest({method:'GET',path:'/api/v2/crypto/trading/orders/id/cancel/'}),{code:'ROBINHOOD_PAPER_ONLY_BUILD'});
    }
    assert.equal(__testing.requestLog.length,0,'all 45 refusals occur before signing or network dispatch');
  } finally { if(previous===undefined)delete process.env.ROBINHOOD_API;else process.env.ROBINHOOD_API=previous; }
});
