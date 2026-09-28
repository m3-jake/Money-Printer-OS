import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PAPER_BOUNDS } from '../src/polymarketUSPaper.js';
import { placePaperSingle, markPaperSingles, resetPaperSingles, paperSinglesBookView } from '../src/polymarketUSSinglesPaper.js';

test('single paper bounds match the combo paper lane and no orders can be sent outside paper mode',()=>{
 assert.deepEqual(PAPER_BOUNDS,{startUsd:{min:1,max:1e6},stakeUsd:{min:1,max:500},maxOpen:{min:1,max:25},maxLegs:{min:1,max:6}});
 assert.throws(()=>placePaperSingle({market:{slug:'x',ask:.5,bid:.49},stakeUsd:10,mode:'live'}),/require paper mode/);
});

test('single paper book reserves virtual cash, prices Yes and No from public BBO, and marks open positions',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-poly-single-')),file=path.join(dir,'singles.json');
 try{
  resetPaperSingles({startUsd:100,file});
  const yes=placePaperSingle({market:{slug:'event',title:'Final',ask:.4,bid:.38,category:'sports'},stakeUsd:20,file,now:1});
  assert.equal(yes.outcome,'Yes');assert.ok(yes.quantity>0);assert.ok(yes.feeUsd>0);
  const no=placePaperSingle({market:{slug:'event-no',ask:.4,bid:.38},outcome:'No',stakeUsd:10,file,now:2});
  assert.equal(no.ask,.62);assert.equal(no.bid,.6);
  const marked=markPaperSingles([{slug:'event',bid:.5},{slug:'event-no',ask:.61,bid:.6}],{file});
  assert.equal(marked.length,2);assert.ok(marked.every(x=>Number.isFinite(x.unrealizedUsd)));
  assert.equal(paperSinglesBookView({file}).openCount,2);
  assert.throws(()=>placePaperSingle({market:{slug:'bad',ask:.9,bid:.8},stakeUsd:501,file}),/required/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
