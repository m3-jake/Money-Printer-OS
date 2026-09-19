import crypto from 'node:crypto';
const hub=(process.env.CLUSTER_HUB_URL||'').replace(/\/$/,'');
const token=process.env.CLUSTER_TOKEN||'';
const headers={'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})};
const post=async(path,obj)=>{const r=await fetch(hub+path,{method:'POST',headers,body:JSON.stringify(obj)});if(!r.ok)throw new Error(`${path} ${r.status}`);return r.json()};
const get=async path=>{const r=await fetch(hub+path,{headers});if(!r.ok)throw new Error(`${path} ${r.status}`);return r.json()};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const clusterEnabled=()=>!!hub;
export async function getClusterStatus(){if(!hub)return{enabled:false};try{return{enabled:true,...await get('/status')}}catch(e){return{enabled:true,error:String(e.message||e)}}}
export async function distributedScore(variants,rows,{batchSize=64,timeoutMs=120000}={}){
 const ds=await post('/dataset',{rows});
 const jobs=[];
 for(let i=0;i<variants.length;i+=batchSize)jobs.push({id:`job-${Date.now()}-${i}-${crypto.randomBytes(2).toString('hex')}`,datasetHash:ds.hash,variants:variants.slice(i,i+batchSize)});
 await post('/jobs',{jobs});
 const wanted=new Set(jobs.map(j=>j.id)),found=new Map(),started=Date.now();
 while(found.size<wanted.size){
  if(Date.now()-started>timeoutMs)throw new Error(`cluster timeout ${found.size}/${wanted.size}`);
  const rs=(await get('/results?ids='+encodeURIComponent([...wanted].join(',')))).results||[];
  for(const r of rs)if(wanted.has(r.jobId)&&r.ok)found.set(r.jobId,r.scored||[]);
  const failed=rs.find(r=>wanted.has(r.jobId)&&r.ok===false);if(failed)throw new Error(failed.error||'cluster worker failed');
  if(found.size<wanted.size)await sleep(400);
 }
 return jobs.flatMap(j=>found.get(j.id)||[]);
}
