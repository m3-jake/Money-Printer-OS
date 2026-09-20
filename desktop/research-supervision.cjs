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
// alpha.53: BEAST/furnace/GPU research and the robustness audit live in the Money Printer
// Evolution Lab. A research-beast.json left behind by an older build is reported but ignored;
// the trader only decides whether to run the lightweight evidence collector.
function beastEnabled(dataDir){
  try{return JSON.parse(fs.readFileSync(path.join(dataDir,'research-beast.json'),'utf8'))?.enabled===true}
  catch{return false}
}
function researchServicePolicy({env=process.env,dataDir}={}){
  const legacyBeast=flag(env,'MPO_RESEARCH_BEAST',beastEnabled(dataDir||'.'));
  return {collector:flag(env,'MPO_RESEARCH_COLLECTOR',true),audit:false,beast:false,legacyBeastRequested:legacyBeast,
    movedTo:'money-printer-evolution-lab',auditEnv:{}};
}
module.exports={flag,beastEnabled,researchServicePolicy};
