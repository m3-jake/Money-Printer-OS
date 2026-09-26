import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendProjectJournal, readProjectJournal, classifyCommit, appendProjectJournalMany, seedProjectJournal, writeBuildMilestones, projectJournalSnapshot, BUILD_MILESTONES_FILE } from "../src/projectJournal.js";
import { fileURLToPath } from "node:url";
const REPO=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");

test("project journal is append-only and deduplicated",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"mpo-journal-")),file=path.join(dir,"journal.ndjson");
 const e={id:"same",kind:"git-milestone",title:"release: alpha",at:1};
 assert.equal(appendProjectJournal(file,e).appended,true);
 assert.equal(appendProjectJournal(file,e).appended,false);
 assert.equal(readProjectJournal(file).length,1);
 assert.equal(classifyCommit("research: improve evidence gate"),"research");
 assert.equal(classifyCommit("fix: recover state"),"reliability");
 fs.rmSync(dir,{recursive:true,force:true});
});

test("bulk append skips ids already present and writes the rest in one go",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"mpo-journal-")),file=path.join(dir,"journal.ndjson");
 try{
  appendProjectJournal(file,{id:"git:a",title:"a",at:1});
  const out=appendProjectJournalMany(file,[{id:"git:a",title:"a",at:1},{id:"git:b",title:"b",at:2},{id:"git:b",title:"b",at:2}]);
  assert.deepEqual(out,{appended:1,skipped:2});
  assert.deepEqual(readProjectJournal(file).map(x=>x.id),["git:a","git:b"]);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test("a packaged build catches the journal up from its shipped history, once per release",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"mpo-journal-")),app=path.join(dir,"app"),file=path.join(dir,"data","project-journal.ndjson");
 try{
  fs.mkdirSync(app);
  const n=writeBuildMilestones(app,{repoDir:REPO,ref:"HEAD"});
  assert.ok(n>=1,"ships the repo history (CI checkouts may be shallow)");
  fs.writeFileSync(path.join(app,"BUILD.json"),JSON.stringify({releaseId:"0.5.0-alpha.60+windows.test",sourceCommit:"f".repeat(40),builtOn:"windows"}));
  // An older research event that stopped on the 22nd.
  appendProjectJournal(file,{kind:"champion-publication",category:"research",title:"Champion X published",at:Date.UTC(2026,8,22,19)});
  const first=seedProjectJournal({journalFile:file,appRoot:app,now:Date.UTC(2026,8,26,19)});
  assert.equal(first.source,"build");assert.equal(first.error,null);assert.equal(first.appended,n+1);assert.equal(first.release,"0.5.0-alpha.60+windows.test");
  const again=seedProjectJournal({journalFile:file,appRoot:app,now:Date.UTC(2026,8,27)});
  assert.equal(again.appended,0,"nothing is duplicated on the next start");
  const snap=projectJournalSnapshot(file,{limit:500});
  assert.equal(snap.rows[0].kind,"release-start","newest by time comes first");
  assert.ok(snap.rows.some(r=>r.kind==="git-milestone"&&r.at>Date.UTC(2026,8,23)),"history after the 22nd is present");
  for(let i=1;i<snap.rows.length;i++)assert.ok(snap.rows[i-1].at>=snap.rows[i].at,"ordered by time, not file position");
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test("seeding ignores malformed shipped rows, uses git from a checkout, and never throws",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"mpo-journal-")),app=path.join(dir,"app"),file=path.join(dir,"j.ndjson");
 try{
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app,BUILD_MILESTONES_FILE),JSON.stringify({schema:"mpo.project-milestones.v1",entries:[{id:"evil",title:"x",at:1},{id:"git:ok",title:"ok",at:5},{id:"git:bad",title:"no time"}]}));
  const r=seedProjectJournal({journalFile:file,appRoot:app});
  assert.equal(r.appended,1);assert.deepEqual(readProjectJournal(file).map(x=>x.id),["git:ok"]);
  const fromGit=seedProjectJournal({journalFile:path.join(dir,"g.ndjson"),appRoot:REPO});
  assert.equal(fromGit.source,"git");assert.ok(fromGit.appended>=1);
  assert.equal(seedProjectJournal({journalFile:null,appRoot:app}).error,"journalFile and appRoot required");
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
