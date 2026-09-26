import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreDatabase } from '../src/core/database.js';
import { UnifiedLedger } from '../src/core/ledger.js';
import { RiskGovernor } from '../src/core/risk.js';
import { MarketEventBus } from '../src/core/eventBus.js';
import { advanceValuation } from '../src/core/valuation.js';

const now=Date.parse('2026-09-26T12:00:00Z');
test('withdrawing every unit and later redepositing cannot erase historical drawdown',()=>{
 let state=null;
 for(const [equityUsd,netDepositsUsd,dd] of [[100,100,0],[80,100,20],[0,20,20],[0,20,20],[100,120,20]]){
  const result=advanceValuation(state,{complete:true,equityUsd,netDepositsUsd,unrealizedPnlUsd:0,limitations:[]},{now});state=result.state;
  assert.ok(Math.abs(result.metrics.drawdownPct-dd)<1e-8);
 }
 assert.equal(state.nav,.8);assert.equal(state.units,125);
});
function fixture(){
 const store=new CoreDatabase(':memory:'),ledger=new UnifiedLedger(store),risk=new RiskGovernor(store,ledger,new MarketEventBus());let n=0;
 const append=(kind,gross,rest={})=>ledger.append({sourceKey:String(++n),at:now,mode:'PAPER',venue:'test',account:'paper',currency:'USD',kind,gross:String(gross),reference:'isolated fixture',...rest});
 const mark=(bid,at=now)=>risk.recordMark({venue:'test',account:'paper',instrumentId:'asset',bid,quantity:10,liquidationFee:0,at,source:'fixture executable bid'});
 return {store,ledger,risk,append,mark};
}
test('open losses and terminal marks change drawdown despite zero realized loss',()=>{
 const f=fixture();try{
 f.append('DEPOSIT',100);assert.equal(f.risk.lossMetrics('PAPER',now).drawdownPct,0);
 f.append('BUY',100,{instrumentId:'asset',quantity:'10'});f.mark(10);
 assert.equal(f.risk.lossMetrics('PAPER',now).equityUsd,100);
 f.mark(.1);const m=f.risk.lossMetrics('PAPER',now);
 assert.equal(m.drawdownPct,99);assert.equal(m.dailyPnlUsd,-99);assert.equal(m.equityUsd,1);
 assert.equal(Number(f.ledger.portfolio().accounts[0].realized),0);
 }finally{f.store.close()}
});
test('deposits and withdrawals preserve NAV drawdown and high water survives a governor restart',()=>{
 const f=fixture();try{
 f.append('DEPOSIT',100);f.risk.lossMetrics('PAPER',now);f.append('BUY',100,{instrumentId:'asset',quantity:'10'});
 f.mark(20);assert.equal(f.risk.lossMetrics('PAPER',now).highWaterNav,2);
 f.mark(10);assert.equal(f.risk.lossMetrics('PAPER',now).drawdownPct,50);
 f.append('DEPOSIT',100);assert.equal(f.risk.lossMetrics('PAPER',now).drawdownPct,50);
 f.append('WITHDRAWAL',50);assert.equal(f.risk.lossMetrics('PAPER',now).drawdownPct,50);
 const restarted=new RiskGovernor(f.store,f.ledger,new MarketEventBus());assert.equal(restarted.lossMetrics('PAPER',now).drawdownPct,50);
 assert.equal(restarted.lossMetrics('PAPER',now).dailyPnlUsd,0);
 }finally{f.store.close()}
});
test('missing/stale/depth-limited marks fail closed, foreign currencies remain explicitly excluded',()=>{
 const f=fixture();try{
 f.append('DEPOSIT',100);f.append('BUY',10,{instrumentId:'asset',quantity:'10'});
 assert.equal(f.risk.lossMetrics('PAPER',now).drawdownPct,null);
 f.mark(1,now-20000);assert.equal(f.risk.lossMetrics('PAPER',now).limitations[0].reason,'STALE_LIQUIDATION_MARK');
 f.mark(1);f.append('DEPOSIT',2,{currency:'SOL'});
 const m=f.risk.lossMetrics('PAPER',now);assert.equal(m.equityUsd,100);assert.equal(m.consolidatedComplete,false);assert.equal(m.excludedAccounts[0].currency,'SOL');
 assert.throws(()=>f.mark(NaN),/Verified/);
 }finally{f.store.close()}
});
test('liquidation fees count in marked equity and loss limits do not trap reducing sells',()=>{
 const f=fixture();try{
 f.append('DEPOSIT',100);f.risk.lossMetrics('PAPER',now);f.append('BUY',10,{instrumentId:'asset',quantity:'10',strategyId:'manual',eventId:'event'});
 f.risk.recordMark({venue:'test',account:'paper',instrumentId:'asset',bid:.5,quantity:10,liquidationFee:1,at:now,source:'fixture'});
 assert.equal(f.risk.lossMetrics('PAPER',now).equityUsd,94);
 const base={mode:'PAPER',venue:'test',account:'paper',instrumentId:'asset',strategyId:'manual',eventId:'event',currency:'USD',quantity:1,price:.5,feeUsd:0,slippageBps:0,liquidityUsd:10,quoteAt:now};
 f.risk.clearMark('test','paper','asset');
 assert.ok(f.risk.evaluate({...base,side:'BUY'},now).reasons.includes('UNKNOWN_LOSS_STATE'));
 assert.equal(f.risk.evaluate({...base,side:'SELL'},now).allowed,true);
 }finally{f.store.close()}
});
