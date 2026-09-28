import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evolutionChampionPolicy, evolutionChampionScore } from '../src/learner.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const good={id:'CHAMP',stage:'SHADOW',promotedAt:123,variant:{id:'CHAMP',threshold:62,stopPct:1.5,takePct:100,maxHoldMin:2,weights:{edge:.05,explosion:.16,execution:.08,momentum:.34,liquidity:.08,freshness:.07,flow:.11,volumeAccel:.04,priceAccel:.07}},metrics:{heldOutN:22,samples:60,activityPct:8.1,monteCarloPassPct:100,stressAvgPct:18,consistencyPct:100}};

test('qualified shadow champion becomes a bounded paper policy',()=>{
 const p=evolutionChampionPolicy({evolutionLoop:{champion:good}});assert.equal(p.id,'CHAMP');assert.equal(p.threshold,62);assert.equal(p.stopPct,1.5);assert.equal(p.takePct,100);assert.equal(p.maxHoldMin,2);
 const x=evolutionChampionScore({evolutionLoop:{champion:good}},{edgeScore:80,explosionScore:70,executionScore:60,momentumScore:90,liquidityScore:75,freshnessScore:80,flow5:2,volumeDelta:50,priceAccel:10});assert.equal(x.id,'CHAMP');assert.ok(x.score>=0&&x.score<=100);
});

test('weak or untrusted champion cannot become a paper policy',()=>{
 assert.equal(evolutionChampionPolicy({evolutionLoop:{champion:{...good,stage:'LIVE'}}}),null);
 assert.equal(evolutionChampionPolicy({evolutionLoop:{champion:{...good,metrics:{...good.metrics,heldOutN:11}}}}),null);
 assert.equal(evolutionChampionPolicy({evolutionLoop:{champion:{...good,metrics:{...good.metrics,monteCarloPassPct:69}}}}),null);
 for(const key of ['heldOutN','samples','activityPct','monteCarloPassPct','stressAvgPct','consistencyPct']){
  for(const value of ['invalid',Infinity,null]) assert.equal(evolutionChampionPolicy({evolutionLoop:{champion:{...good,metrics:{...good.metrics,[key]:value}}}}),null,`${key} must be measured and finite`);
 }
 assert.equal(evolutionChampionPolicy({evolutionLoop:{champion:{...good,variant:{...good.variant,maxHoldMin:Infinity}}}}),null);
 assert.equal(evolutionChampionPolicy({evolutionLoop:{champion:{...good,variant:{...good.variant,weights:{edge:'invalid'}}}}}),null);
});

test('manual Control Bay mode pauses Lab champion until auto-follow is re-enabled',()=>{
 const s={runtime:{followLabBest:false},evolutionLoop:{champion:good}};
 assert.equal(evolutionChampionPolicy(s),null);
 assert.equal(evolutionChampionPolicy(s,{ignoreFollowSetting:true}).id,'CHAMP');
 s.runtime.followLabBest=true;
 assert.equal(evolutionChampionPolicy(s).id,'CHAMP');
});

test('engine applies evolution champion only behind paper-mode guards',()=>{
 const src=fs.readFileSync(path.join(ROOT,'src','index.js'),'utf8');
 assert.match(src,/cfg\.mode==='paper'\?evolutionChampionPolicy\(s\):null/);
 assert.match(src,/cfg\.mode==='paper'\?evolutionChampionScore\(s,a\):null/);
 assert.doesNotMatch(src,/cfg\.mode==='live'\?evolutionChampion/);
 assert.match(src,/stage:'PAPER_CANARY'/);
});

test('paper bankroll reset preserves the evolution loop and research corpus',()=>{
 const src=fs.readFileSync(path.join(ROOT,'src','index.js'),'utf8');
 const start=src.indexOf("if (a.type === 'reset-paper')");
 const end=src.indexOf("else if (a.type === 'toggle-pause')",start);
 const block=src.slice(start,end);
 assert.match(block,/research:\s*s\.research/);
 assert.match(block,/evolutionLoop:\s*s\.evolutionLoop/);
 assert.match(block,/next\.positions\s*=\s*\[\]/);
 assert.match(block,/next\.history\s*=\s*\[\]/);
 assert.match(block,/next\.cashSol\s*=\s*next\.paperStartSol/);
});
