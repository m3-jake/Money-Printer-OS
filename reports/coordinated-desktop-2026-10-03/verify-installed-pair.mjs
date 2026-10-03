// Read-only release measurements and retention checks, never reads credentials.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const dir=path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/,'$1'));
const phase=process.argv[2]||'before';
const data=path.join(process.env.APPDATA,'Money Printer OS','data');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const endpoints={};
for(const [name,url]of Object.entries({traderHealth:'http://127.0.0.1:8792/api/health',state:'http://127.0.0.1:8792/api/state',lab:'http://127.0.0.1:8793/api/state',scoreboard:'http://127.0.0.1:8792/api/scoreboard',command:'http://127.0.0.1:8792/api/command-center?view=summary',coordinator:'http://127.0.0.1:8792/api/coordinator',funnel:'http://127.0.0.1:8792/api/copy-funnel',processes:'http://127.0.0.1:8792/api/trader-processes'})){
  const r=await fetch(url,{signal:AbortSignal.timeout(30000)});try{endpoints[name]={status:r.status,value:await r.json()};}catch{endpoints[name]={status:r.status};}
}
const records={},names=['state.json','polymarket-copy-paper.json','pumpfun-copy-paper.json','pumpfun-copy-emerging-paper.json','pumpfun-copy-consensus-paper.json','kalshi-paper-bots.json','bot-farm.json','robinhood-daily-paper.json','robinhood-equities-paper.json','polymarket-us-combos.json','combo-engine.json'];
const ex=path.join(data,'experiments');if(fs.existsSync(ex))for(const d of fs.readdirSync(ex,{withFileTypes:true}))if(d.isDirectory())for(const f of fs.readdirSync(path.join(ex,d.name)))if(f.endsWith('.json')&&!f.endsWith('.initialized.json'))names.push(`experiments/${d.name}/${f}`);
function summarize(value,p='root',out={}){
 if(!value||typeof value!=='object')return out;
 for(const [k,v]of Object.entries(value)){
   const key=p+'.'+k;
   if(['history','closed','closedTrades','trades','journal'].includes(k)&&Array.isArray(v))out[key]={count:v.length,hashes:v.map(x=>sha(JSON.stringify(x)))};
   else if(['epoch','startUsd','startSol','startingCapital','startingCapitalUsd','accountEpoch'].includes(k)&&typeof v!=='object')out[key]=v;
   else if(['drawdownPause','experiment'].includes(k))out[key]=v;
   else if(v&&typeof v==='object'&&!['watchlist','tickHistory','seen','decisions','candidates'].includes(k))summarize(v,key,out);
 }
 return out;
}
for(const name of names){const file=path.join(data,name);if(!fs.existsSync(file))continue;try{const b=fs.readFileSync(file),v=JSON.parse(b);records[name]={sha256:sha(b),bytes:b.length,accounting:summarize(v)};}catch(e){records[name]={error:e.message};}}
const result={at:new Date().toISOString(),phase,endpoints,records};
if(phase==='after'){
 const before=JSON.parse(fs.readFileSync(path.join(dir,'installed-before.json'))),failures=[];
 for(const [name,old]of Object.entries(before.records)){
  const current=records[name];if(!current){failures.push(`${name} disappeared`);continue;}
  for(const [key,v]of Object.entries(old.accounting||{})){
   const next=current.accounting?.[key];
   if(v?.hashes){const retained=new Set(next?.hashes||[]);for(const h of v.hashes)if(!retained.has(h))failures.push(`${name} ${key} lost a prior history receipt ${h}`);}
   else if(key.endsWith('.drawdownPause')){if(v?.active&&next?.active!==true)failures.push(`${name} loss pause cleared`);}
   else if(JSON.stringify(v)!==JSON.stringify(next))failures.push(`${name} ${key} identity/capital changed`);
  }
 }
 const local=path.join(process.env.LOCALAPPDATA,'Programs'),mpo=path.join(local,'money-printer-os'),lab=path.join(local,'money-printer-evolution-lab');
 const receipt=JSON.parse(fs.readFileSync(path.join(mpo,'PAIRED-RELEASE.json'),'utf8').replace(/^\uFEFF/,''));
 const other=JSON.parse(fs.readFileSync(path.join(lab,'PAIRED-RELEASE.json'),'utf8').replace(/^\uFEFF/,''));
 if(JSON.stringify(receipt)!==JSON.stringify(other))failures.push('Paired receipts differ');
 for(const [root,k]of [[mpo,'moneyPrinterOS'],[lab,'evolutionLab']])if(sha(fs.readFileSync(path.join(root,'resources','app.asar')))!==receipt[k].sha256)failures.push(`${k} archive hash mismatch`);
 if(endpoints.state.value?.build?.provenance?.sourceCommit!==receipt.moneyPrinterOS.commit)failures.push('Trader running commit mismatch');
 if(endpoints.lab.value?.build?.commit!==receipt.evolutionLab.commit)failures.push('Lab running commit mismatch');
 result.receipt=receipt;result.retention={success:failures.length===0,failures,checkedBooks:Object.keys(before.records).length};
 process.exitCode=failures.length?1:0;
}
fs.writeFileSync(path.join(dir,`installed-${phase}.json`),JSON.stringify(result,null,2));
console.log(JSON.stringify({phase,at:result.at,retention:result.retention,statuses:Object.fromEntries(Object.entries(endpoints).map(([k,v])=>[k,v.status]))}));
