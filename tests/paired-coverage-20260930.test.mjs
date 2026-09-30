import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileBook, coverageClaim, STATES } from '../src/core/bookReconcile.js';
const fixture = () => ({
  book: { source:'solana', mode:'PAPER', currency:'SOL', status:'LEGACY_READ_ONLY', cash:.944, openPositions:1, openCost:.05, realized:-.01, openRealized:.004, fees:.003 },
  venue:'solana-paper',
  mirrorRow:{ source:'solana', epoch:1, status:'RECONCILED', detail:{bookCash:.944,ledgerCash:.944,diff:0} },
  account:{venue:'solana-paper',account:'legacy-1',currency:'SOL',cash:'.944',realized:'-.006',fees:'.003',positions:[{costBasis:'.05'}]}
});
const checked = () => reconcileBook(fixture());
test('zero books and zero verified books never grant promotion', () => {
  for (const rows of [[], [reconcileBook({})], [{state:STATES.NOT_MIRRORED,source:'missing'}]]) {
    const c=coverageClaim(rows); assert.equal(c.state,'UNAVAILABLE'); assert.equal(c.checked,0); assert.equal(c.promotionAllowed,false);
  }
});
test('complete scoped evidence is required, and mixed missing coverage is partial', () => {
  const r=checked(), complete=coverageClaim([r]); assert.equal(complete.state,'COMPLETE'); assert.equal(complete.promotionAllowed,true);
  assert.deepEqual(complete.scope,[{source:'solana',account:'legacy-1',epoch:1,currency:'SOL',mode:'PAPER'}]);
  const partial=coverageClaim([r,reconcileBook({book:{source:'stocks',currency:'USD',status:'UNAVAILABLE'}})]);
  assert.equal(partial.state,'PARTIAL'); assert.equal(partial.promotionAllowed,false); assert.equal(partial.checked,1);
});
test('unknown fee, realized or position basis is not a reconciliation', () => {
  for (const mutate of [x=>x.book.fees=null,x=>x.book.realized=null,x=>x.account.positions[0].costBasis=null,x=>x.account.positions=null]) {
    const x=fixture(); mutate(x); const r=reconcileBook(x);
    assert.equal(r.state,STATES.PARTIAL); assert.equal(r.promotionRefused,true); assert.ok(r.unknown.length);
    assert.equal(coverageClaim([r]).state,'PARTIAL'); assert.equal(coverageClaim([r]).promotionAllowed,false);
  }
});
test('cash verdict from an older snapshot cannot certify newer balances', () => {
  const x=fixture(); x.book.cash=.943; const r=reconcileBook(x);
  assert.equal(r.fields[0].state,'UNKNOWN'); assert.equal(r.state,STATES.PARTIAL);
  assert.equal(coverageClaim([r]).promotionAllowed,false);
});
test('duplicate scopes cannot manufacture independent coverage', () => {
  const r=checked(), c=coverageClaim([r,r]);
  assert.equal(c.state,'UNRECONCILED'); assert.equal(c.promotionAllowed,false); assert.match(c.reason,/Duplicate/);
});
test('recovery state and incorrect account identity refuse promotion', () => {
  const recovery=fixture(); recovery.book.status='RECOVERY_REQUIRED';
  assert.equal(reconcileBook(recovery).state,STATES.RECOVERY_REQUIRED);
  assert.equal(coverageClaim([reconcileBook(recovery)]).state,'UNRECONCILED');
  const wrong=fixture(); wrong.account.account='legacy-2';
  assert.equal(reconcileBook(wrong).state,STATES.DIFFERENCE);
  assert.equal(coverageClaim([reconcileBook(wrong)]).promotionAllowed,false);
});
test('unrecognized mirror status and fabricated RECONCILED flags are not proof', () => {
  const x=fixture(); x.mirrorRow.status='RUNNING';
  assert.equal(reconcileBook(x).state,STATES.UNAVAILABLE);
  assert.equal(coverageClaim([{source:'solana',state:STATES.RECONCILED}]).promotionAllowed,false);
});
