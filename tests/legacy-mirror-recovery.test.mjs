import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketPlatform } from '../src/core/platform.js';
const trade=(id,at,pnl=0)=>({id,mint:id,symbol:id,sizeSol:.05,pnlSol:pnl,feesSol:0,openedAt:at,closedAt:at+100});
const book=(start,history=[],positions=[])=>({mode:'PAPER',paperStartSol:start,history,positions,cashSol:start+history.reduce((n,t)=>n+t.pnlSol,0)+positions.reduce((n,t)=>n-t.remainingSol+(t.realizedSol||0),0)});
const setup=initial=>{const p=new MarketPlatform();let value=initial;p.setLegacyReaders({solana:()=>value});return {p,set:v=>value=v,sync:()=>p.syncLegacyLedger().find(r=>r.source==='solana')};};

test('a reset already trading before the next sync gets a separate append-only mirror account',()=>{
  const f=setup(book(1,[trade('old',1000)]));
  try {
    assert.equal(f.sync().status,'RECONCILED');const old=f.p.ledger.entries().map(e=>({...e}));
    f.set(book(.15,[trade('new',3000,.01)]));const r=f.sync();
    assert.equal(r.account,'legacy-2');assert.equal(r.status,'RECONCILED');assert.ok(Math.abs(r.ledgerCash-.16)<1e-8);
    assert.match(r.notes.join(' '),/reset/);assert.equal(f.sync().appended,0);
    const rows=f.p.ledger.entries();for(const e of old)assert.deepEqual(rows.find(x=>x.source_key===e.source_key),e);
    assert.equal(f.p.ledger.portfolio().accounts.length,2);
  }finally{f.p.close();}
});

test('history compaction never changes the original deposit timestamp or creates funds',()=>{
  const first=trade('first',1000),second=trade('second',3000),f=setup(book(1,[first,second]));
  try {assert.equal(f.sync().status,'RECONCILED');const before=f.p.ledger.entries();f.set(book(1,[second]));const r=f.sync();assert.equal(r.status,'RECONCILED');assert.equal(r.account,'legacy-1');assert.equal(r.appended,0);assert.deepEqual(f.p.ledger.entries(),before);}finally{f.p.close();}
});

test('an explicit new generation permits a same-bankroll reset without deleting the old book',()=>{
  const f=setup({...book(1,[trade('first',1000)]),paperBookId:'first-book'});
  try {f.sync();f.set({...book(1,[trade('second',3000)]),paperBookId:'second-book'});const r=f.sync();assert.equal(r.account,'legacy-2');assert.equal(r.status,'RECONCILED');assert.equal(f.sync().appended,0);}finally{f.p.close();}
});

test('changed bankroll with overlapping history is a conflict, never an automatic reset',()=>{
  const t=trade('same',1000),f=setup(book(1,[t]));
  try {f.sync();const before=f.p.ledger.entries();f.set(book(.15,[t]));const r=f.sync();assert.equal(r.account,'legacy-1');assert.equal(r.status,'FAILED');assert.equal(r.appended,0);assert.deepEqual(f.p.ledger.entries(),before);}finally{f.p.close();}
});

test('an inconsistent replacement book cannot mint a fresh opening balance',()=>{
  const f=setup(book(1,[trade('old',1000)]));
  try {f.sync();const before=f.p.ledger.entries();f.set({...book(.15,[trade('new',3000)]),cashSol:10});const r=f.sync();assert.equal(r.account,'legacy-1');assert.equal(r.status,'FAILED');assert.deepEqual(f.p.ledger.entries(),before);}finally{f.p.close();}
});

test('a later append error rolls back the entire mirror batch, including its opening deposit',()=>{
  const f=setup(book(1,[],[{id:'valid',sizeSol:.2,remainingSol:.2,openedAt:1000},{id:'overdraw',sizeSol:2,remainingSol:2,openedAt:2000}]));
  try {const r=f.sync();assert.equal(r.status,'FAILED');assert.equal(r.appended,0);assert.equal(f.p.ledger.entries().length,0);assert.equal(f.p.ledger.portfolio().accounts.length,0);}finally{f.p.close();}
});
