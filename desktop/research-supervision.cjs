const fs = require('node:fs');
const path = require('node:path');

const TRUE = new Set(['1','true','yes','on']);
const FALSE = new Set(['0','false','no','off']);
function flag(env,name,fallback=false){
  const raw=env?.[name];
  if(raw==null||String(raw).trim()==='')return fallback;
  const v=String(raw).trim().toLowerCase();
  if(TRUE.has(v))return true;
  if(FALSE.has(v))return false;
  return fallback;
}
function beastEnabled(dataDir){
  try{return JSON.parse(fs.readFileSync(path.join(dataDir,'research-beast.json'),'utf8'))?.enabled===true}
  catch{return false}
}
function researchServicePolicy({env=process.env,dataDir}={}){
  const beast=flag(env,'MPO_RESEARCH_BEAST',beastEnabled(dataDir||'.'));
  return {collector:flag(env,'MPO_RESEARCH_COLLECTOR',true),audit:flag(env,'MPO_RESEARCH_AUDIT',beast),beast,
    auditEnv:{MPO_AUDIT_WORKERS:String(env.MPO_AUDIT_WORKERS||4),MPO_AUDIT_EVERY_GENERATIONS:String(env.MPO_AUDIT_EVERY_GENERATIONS||25),MPO_AUDIT_SEEDS:String(env.MPO_AUDIT_SEEDS||6),MPO_AUDIT_ROUNDS:String(env.MPO_AUDIT_ROUNDS||500)}};
}
module.exports={flag,beastEnabled,researchServicePolicy};
