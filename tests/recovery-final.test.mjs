import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { paperCashReceipt } from '../src/paperCashReceipts.js';
import { solanaSourceIntegrity } from '../src/core/legacyReset.js';

test('paper cash receipts retain posting and simulated times separately and reject incorrect balances',()=>{
  const buy=paperCashReceipt({positionId:'p',sequence:0,side:'BUY',postedAt:1000,modeledFillAt:1300,basisSol:.1,grossSol:.1,feeSol:.001,cashBeforeSol:1,cashAfterSol:.899});
  assert.equal(buy.deltaSol,-.101);assert.equal(buy.postedAt,1000);assert.equal(buy.modeledFillAt,1300);assert.equal(buy.exchangeFill,false);
  const sell=paperCashReceipt({positionId:'p',sequence:1,side:'SELL',postedAt:2000,basisSol:.05,grossSol:.08,feeSol:.001,cashBeforeSol:.899,cashAfterSol:.978});
  assert.ok(Math.abs(sell.deltaSol-.079)<1e-12);assert.notEqual(buy.id,sell.id);
  assert.throws(()=>paperCashReceipt({...buy,cashAfterSol:5}),/posted balance/);
});

test('source cash identity never implies complete historical posting evidence',()=>{
  const book={paperStartSol:1,cashSol:.9,positions:[{remainingSol:.1,realizedSol:0}],history:[]};
  const result=solanaSourceIntegrity(book);assert.equal(result.identityVerified,true);assert.equal(result.postingHistoryComplete,false);
  assert.equal(solanaSourceIntegrity({...book,cashSol:4}).identityVerified,false);
});

test('Command Center lazy details do not build hidden tables and ledger currencies stay distinct',()=>{
  const source=fs.readFileSync(new URL('../public/js/mpo-platform.js',import.meta.url),'utf8');
  const names=['escape','dollars','expandedDetails','detailPanel','currencyAmount'];
  const lines=names.map(name=>{const line=source.split('\n').find(x=>x.trimStart().startsWith('const '+name+' ')||x.trimStart().startsWith('const '+name+'='));assert.ok(line,name);return line;});
  const context={};vm.createContext(context);vm.runInContext(lines.join('\n')+'\nglobalThis.testHelpers={expandedDetails,detailPanel,currencyAmount};',context);
  let calls=0;const h=context.testHelpers;assert.match(h.detailPanel('x','Evidence',()=>{calls++;return 'TABLE';}),/<summary>Evidence/);assert.equal(calls,0);
  h.expandedDetails.add('x');assert.match(h.detailPanel('x','Evidence',()=>{calls++;return 'TABLE';}),/TABLE/);assert.equal(calls,1);
  assert.match(h.currencyAmount(.1,'SOL'),/SOL/);assert.doesNotMatch(h.currencyAmount(.1,'SOL'),/\$/);assert.match(h.currencyAmount(.1,'USD'),/\$/);
});
