import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendProjectJournal, readProjectJournal, classifyCommit } from "../src/projectJournal.js";

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
