import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>{try{return fs.readFileSync(path.join(root,f),'utf8').trim()}catch{return null}};
const parse=f=>{try{return JSON.parse(read(f))}catch{return null}};
export function buildProvenance(){
 const pkg=parse('package.json')||{},build=parse('BUILD.json');let sourceCommit=null,dirty=null;
 if(!build)try{sourceCommit=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true,timeout:1000}).trim();dirty=!!execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=no'],{encoding:'utf8',windowsHide:true,timeout:1000}).trim()}catch{}
 const markerVersion=read('.build-version'),markerCommit=read('.build-commit');
 return {schema:'mpo.build-provenance.v1',packageVersion:pkg.version||null,sourceCommit:build?.sourceCommit||sourceCommit,sourceDirty:build?.sourceDirty??dirty,sourceFingerprint:build?.sourceFingerprint||null,
   packaged:!!build,releaseId:build?.releaseId||null,markerVersion,markerCommit,markerMatchesPackage:markerVersion===pkg.version,
   runtime:{node:process.versions.node,electron:process.versions.electron||null,platform:process.platform,arch:process.arch,pid:process.pid},
   evaluator:{version:'market-replay.v2',sha256:createHash('sha256').update(read('src/core/replay.js')||'').digest('hex')},
   compatibility:{labStatus:'mpo.lab-status.v1',moduleChampion:'mpo.lab-module-champion.v1',fitness:'mpo.fitness-ledger.v1',compute:'mpo.compute-budget.v1',prediction:'mpo.prediction-episodes.v1',robinhood:'robinhood-backtest.v2',equities:'equities-close-next-open-v2'},
   limitations:build?[]:['Source execution is not an installed artifact',...(markerVersion&&markerVersion!==pkg.version?['Checkout build marker is historical and not authoritative']:[])]};
}
export const BUILD_PROVENANCE=buildProvenance();
