import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketPlatform } from '../src/core/platform.js';
import { ProviderRegistry } from '../src/core/provider.js';
import { reconcileBook,reconcileLegacyBooks,coverageClaim,toleranceFor,STATES,CLAIM,MIRROR_VENUES,mirrorAccount } from '../src/core/bookReconcile.js';

// The shape of a book that genuinely mirrors, taken from the values the Solana mirror produces for
// tests/market-core.test.mjs:708 (closed loser + one open position with a half exit): cash .944,
// open cost .05, ledger realized = book realized (-.01) + open-position realized (.004), fees .003.
const bookOf=o=>({source:'solana',label:'Solana paper engine',currency:'SOL',mode:'PAPER',status:'LEGACY_READ_ONLY',reason:null,
  cash:.944,start:1,openPositions:1,openCost:.05,realized:-.01,openRealized:.004,fees:.003,realizedScope:'last 1 closes',asOf:1,...o});
const acctOf=o=>({venue:'solana-paper',account:'legacy-1',currency:'SOL',cash:'0.944',realized:'-0.006',fees:'0.003',
  positions:[{instrumentId:'i1',strategyId:'solana',eventId:'e1',quantity:'0.05',costBasis:'0.05'}],...o});
const rowOf=o=>({source:'solana',epoch:1,synced_at:1,status:'RECONCILED',detail:{ledgerCash:.944,bookCash:.944,diff:0,appended:7,failed:null,notes:[]},...o});
const verdict=o=>reconcileBook({book:bookOf(),venue:'solana-paper',mirrorRow:rowOf(),account:acctOf(),...o});

test('a mirrored book that agrees reconciles on all five comparisons, cash included',()=>{
  const r=verdict();
  assert.equal(r.state,STATES.RECONCILED);assert.equal(r.promotionRefused,false);
  assert.equal(r.account,'legacy-1');assert.equal(r.currency,'SOL');assert.equal(r.epoch,1);
  assert.deepEqual(r.fields.map(f=>f.field),['cash','openPositions','openCost','realized','fees']);
  assert.equal(r.fields.every(f=>f.state==='MATCH'),true);
  assert.equal(r.compared,5);assert.deepEqual(r.differences,[]);assert.deepEqual(r.unknown,[]);
  // Cash is judged by the mirror's own verdict, which compared the same two numbers.
  assert.equal(r.fields[0].judgedBy,'mirror-verdict');assert.equal(r.fields[0].diff,0);
  assert.match(r.reason,/agree on cash, open cost, open positions, realized and fees/);
  assert.equal(coverageClaim([r]).legacyBooks,CLAIM.ok);assert.equal(coverageClaim([r]).promotionAllowed,true);
});

test('drift is caught in the fields cash alone cannot see: basis, count, realized and fees',()=>{
  // Cash matches in every case below; only the extra comparisons move. Before P1.1 these all passed
  // as "reconciled" because the mirror only ever compared cash.
  const basis=verdict({account:acctOf({positions:[{instrumentId:'i1',quantity:'0.05',costBasis:'0.06'}]})});
  assert.equal(basis.state,STATES.DIFFERENCE);assert.deepEqual(basis.differences.map(d=>d.field),['openCost']);
  assert.equal(basis.fields.find(f=>f.field==='cash').state,'MATCH');assert.equal(basis.fields.find(f=>f.field==='openCost').diff,.01);
  // Same total basis, split across two positions: the count catches what the sum hides.
  const count=verdict({account:acctOf({positions:[{instrumentId:'i1',quantity:'0.025',costBasis:'0.025'},{instrumentId:'i2',quantity:'0.025',costBasis:'0.025'}]})});
  assert.equal(count.state,STATES.DIFFERENCE);assert.deepEqual(count.differences.map(d=>d.field),['openPositions']);
  assert.equal(count.fields.find(f=>f.field==='openCost').state,'MATCH');
  const realized=verdict({account:acctOf({realized:'-0.02'})});
  assert.deepEqual(realized.differences.map(d=>d.field),['realized']);
  assert.equal(realized.fields.find(f=>f.field==='realized').book,-.006);
  assert.match(realized.fields.find(f=>f.field==='realized').scope,/plus open-position realized/);
  const fees=verdict({account:acctOf({fees:'0.009'})});
  assert.deepEqual(fees.differences.map(d=>d.field),['fees']);
  for(const r of [basis,count,realized,fees]){assert.equal(r.promotionRefused,true);assert.equal(coverageClaim([r]).promotionAllowed,false);
    assert.match(coverageClaim([r]).refused[0].reason,/Nothing was booked to hide it/);}
});

test('the tolerance is one rounding step per compared row, so length alone is never a difference',()=>{
  assert.equal(toleranceFor(0),1e-6);assert.equal(toleranceFor(3),4e-6);
  const long=verdict({account:acctOf({realized:'-0.006999'})});
  assert.equal(long.fields.find(f=>f.field==='realized').state,'DIFFERENCE');
  // The same delta is inside the tolerance of a book with 1500 mirrored rows.
  const scaled=verdict({book:bookOf({openPositions:1500,openCost:.05}),account:acctOf({realized:'-0.006999'})});
  assert.equal(scaled.fields.find(f=>f.field==='realized').state,'MATCH');
  assert.equal(scaled.tolerance,1502e-6);
});

test('unknown and missing evidence cannot certify coverage',()=>{
  const unknown=verdict({book:bookOf({realized:null,fees:null,openRealized:null})});
  assert.equal(unknown.state,STATES.PARTIAL);assert.deepEqual(unknown.unknown,['realized','fees']);
  assert.equal(unknown.fields.find(f=>f.field==='realized').state,'UNKNOWN');
  assert.match(unknown.fields.find(f=>f.field==='fees').reason,/does not report a fee total/);
  // Books with no mirror at all: combos have no readable venue balance, and a book nobody has
  // mirrored yet has nothing to compare against. Neither is a disagreement, so neither refuses.
  const combos=reconcileLegacyBooks({coverage:{books:[{source:'polymarket-us-combos',currency:'USD',mode:'LIVE_UNRECONCILED',status:'LEGACY_READ_ONLY',cash:null}]}});
  assert.equal(combos.books[0].state,STATES.NOT_MIRRORED);assert.match(combos.books[0].reason,/no mirror account/);
  const notYet=reconcileLegacyBooks({coverage:{books:[bookOf()]}});
  assert.equal(notYet.books[0].state,STATES.NOT_MIRRORED);assert.match(notYet.books[0].reason,/No mirror has run/);
  assert.equal(notYet.claim.promotionAllowed,false);assert.equal(notYet.claim.legacyBooks,'COVERAGE_UNAVAILABLE');
  assert.deepEqual(notYet.claim.unverified.map(u=>u.source),['solana']);assert.equal(notYet.claim.checked,0);
  // An unreadable book is "where possible" too, but a book whose mirror refused an entry is not.
  const unreadable=reconcileLegacyBooks({coverage:{books:[bookOf({status:'UNAVAILABLE',reason:'Engine state not loaded'})]}});
  assert.equal(unreadable.books[0].state,STATES.UNAVAILABLE);assert.equal(unreadable.claim.promotionAllowed,false);
  const failed=reconcileLegacyBooks({coverage:{books:[bookOf()]},mirrors:[rowOf({status:'FAILED',detail:{failed:'legacy:solana:1:sell:o1: Ledger would overdraw cash'}})]});
  assert.equal(failed.books[0].state,STATES.FAILED);assert.equal(failed.claim.promotionAllowed,false);
  assert.match(failed.books[0].reason,/overdraw/);assert.deepEqual(failed.claim.refused[0].fields,[]);
});

test('currency and account are never crossed: a matching number in another book is not a match',()=>{
  // A SOL book compared with a USD account of the same nominal size must be refused, not reconciled.
  const usd=verdict({account:acctOf({currency:'USD',cash:'0.944'})});
  assert.equal(usd.state,STATES.DIFFERENCE);assert.match(usd.reason,/across books/);
  assert.match(usd.differences[0].reason,/cannot be reconciled against a USD account/);
  assert.equal(usd.promotionRefused,true);
  // And an account belonging to another venue is not this book's mirror.
  const wrong=verdict({account:acctOf({venue:'robinhood-practice'})});
  assert.equal(wrong.state,STATES.DIFFERENCE);assert.match(wrong.reason,/Refusing to compare across books/);
  assert.match(wrong.differences[0].reason,/Wrong mirror venue/);
  // One whose mirror account is simply not in the portfolio: the mirror says mirrored, the ledger
  // has no such account, so the claim cannot be verified either.
  const missing=verdict({account:null});
  assert.equal(missing.state,STATES.DIFFERENCE);assert.match(missing.reason,/not in the portfolio/);
  assert.deepEqual(missing.differences.map(d=>d.field),['account']);
  // The account lookup is by the mirror's own epoch: a stale epoch is not the account being compared.
  const rows=[rowOf()],accounts=[acctOf()];
  assert.equal(reconcileLegacyBooks({coverage:{books:[bookOf()]},mirrors:rows,accounts}).books[0].state,STATES.RECONCILED);
  assert.equal(reconcileLegacyBooks({coverage:{books:[bookOf()]},mirrors:[rowOf({epoch:2})],accounts}).books[0].state,STATES.DIFFERENCE);
  assert.equal(mirrorAccount(2),'legacy-2');assert.equal(MIRROR_VENUES.solana,'solana-paper');
  assert.equal(MIRROR_VENUES['polymarket-us-combos'],undefined);
});

test('the platform derives coverage.legacyBooks and refuses it when a mirrored book disagrees',()=>{
  const book={paperStartSol:1,history:[{id:'c1',mint:'M1',symbol:'A',sizeSol:.05,pnlSol:-.01,feesSol:.001,openedAt:1000,closedAt:2000}],
    positions:[{id:'o1',mint:'M2',symbol:'B',sizeSol:.1,remainingSol:.05,realizedSol:.004,feesSol:.002,openedAt:3000,priceObservedAt:4000}]};
  book.cashSol=1-.01-.05+.004;
  const p=new MarketPlatform({providers:new ProviderRegistry()});let s=book;p.setLegacyReaders({solana:()=>s});
  p.syncLegacyLedger();
  // Before any sync: nothing to reconcile against, and the claim still says "where possible".
  const fresh=new MarketPlatform({providers:new ProviderRegistry()});
  assert.equal(fresh.snapshot().coverage.legacyBooks,'COVERAGE_UNAVAILABLE');assert.equal(fresh.snapshot().coverage.legacyReconcile.checked,0);fresh.close();
  const ok=p.snapshot();
  assert.equal(ok.coverage.legacyBooks,'PARTIAL_UNVERIFIED_COVERAGE');assert.deepEqual(ok.coverage.legacyReconcile.refused,[]);
  assert.equal(ok.coverage.legacyReconcile.promotionAllowed,false);assert.equal(ok.coverage.legacyReconcile.checked,1);
  assert.equal(ok.legacy.reconciliation.books.find(b=>b.source==='solana').state,STATES.RECONCILED);
  assert.equal(ok.legacy.reconciliation.states.RECONCILED,1);
  assert.equal(ok.legacy.reconciliation.at>0,true);
  assert.equal(ok.ledger.length,p.ledger.entries().length);
  // The book changes outside its normal flow: the platform stops claiming reconciliation by name,
  // and still books no adjustment to make the two agree.
  s={...book,positions:[{...book.positions[0],remainingSol:.06}],cashSol:book.cashSol+.01};
  const before=p.ledger.entries().length;p.syncLegacyLedger();
  const bad=p.snapshot();
  assert.equal(bad.coverage.legacyBooks,CLAIM.refused);assert.equal(bad.coverage.legacyReconcile.promotionAllowed,false);
  assert.deepEqual(bad.coverage.legacyReconcile.refused.map(r=>r.source),['solana']);
  assert.deepEqual(bad.coverage.legacyReconcile.refused[0].fields,['cash','openCost']);
  assert.equal(bad.legacy.reconciliation.books.find(b=>b.source==='solana').promotionRefused,true);
  assert.equal(p.ledger.entries().filter(e=>/adjust/i.test(e.reference)).length,0);
  // The re-sync of a book that went backwards mirrors no new entry: the refusal is a verdict, not a
  // write, so the earlier mirror survives untouched.
  assert.equal(p.ledger.entries().length,before);
  p.close();
});
