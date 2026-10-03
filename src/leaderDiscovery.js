// Public candidate discovery is separate from follower execution and never proves profitability.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from './atomicRename.js';

export const LEADER_SOURCES = Object.freeze([
  ['DAY','ALL'], ['WEEK','ALL'], ['MONTH','ALL'], ['WEEK','SPORTS'], ['WEEK','CRYPTO'],
]);
// Refills keep each book's frozen weekly/category selection policy and record a new follow time.
export function discoveredCopyRows(catalogue, {category='ALL',now=Date.now()}={}) {
  return (catalogue?.candidates||[]).flatMap(c=>{
    const s=c.sources?.find(s=>s.period==='WEEK'&&s.category===category&&Number.isSafeInteger(s.observedAt)&&s.observedAt<=now&&now-s.observedAt<=20*60000);
    return s?[{proxyWallet:c.proxyWallet,userName:c.userName,rank:s.rank,pnl:s.pnl,vol:s.volume}]:[];
  }).sort((a,b)=>(a.rank??Infinity)-(b.rank??Infinity));
}
export function candidateLeaders(snapshots, at) {
  const pool = new Map(); let observed = 0, rejected = 0;
  for (const {period, category, rows} of snapshots) for (const row of rows) {
    observed++;
    const wallet = String(row.proxyWallet || '').toLowerCase(), pnl = Number(row.pnl), volume = Number(row.vol);
    if (!/^0x[a-f0-9]{40}$/.test(wallet) || !Number.isFinite(pnl) || !Number.isFinite(volume) || pnl <= 0 || volume <= 0) { rejected++; continue; }
    const source = {period, category, rank:Number.isFinite(Number(row.rank))?Number(row.rank):null, pnl, volume, observedAt:at};
    const prior = pool.get(wallet);
    if (prior) prior.sources.push(source);
    else pool.set(wallet,{proxyWallet:wallet,userName:String(row.userName||wallet).slice(0,100),pnl,vol:volume,sources:[source],firstObservedAt:at,qualification:'UNQUALIFIED',note:'Provider leaderboard P/L; follower after-cost results required'});
  }
  return {observed,rejected,candidates:[...pool.values()]};
}
export class LeaderDiscovery {
  constructor({dataDir,fetchImpl=globalThis.fetch,tape,now=Date.now,cache}={}) {
    this.file=path.join(dataDir,'copy-leader-candidates.json');this.fetch=fetchImpl;this.tape=tape;this.now=now;this.cache=cache;this.busy=false;
    try{this.state=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{this.state={schema:'mpo.copy-leader-candidates.v1',candidates:[],lastRunAt:null,lastSuccessAt:null};}
  }
  snapshot(){return {...this.state,running:this.busy};}
  async run(){
    if(this.busy)return this.snapshot();this.busy=true;
    try{
      const snapshots=[],errors=[];
      // Sequential bounded requests share discovery cache with the trader and avoid provider bursts.
      for(const [period,category]of LEADER_SOURCES){
        const url=`https://data-api.polymarket.com/v1/leaderboard?timePeriod=${period}&orderBy=PNL&limit=50${category==='ALL'?'':'&category='+category}`;
        try{const load=async()=>{const r=await this.fetch(url,{signal:AbortSignal.timeout(6500),redirect:'error'});if(!r.ok)throw Error(`HTTP ${r.status}`);const rows=await r.json();if(!Array.isArray(rows))throw Error('leaderboard response is not an array');return rows.slice(0,50);};const rows=this.cache?await this.cache.get(url,load):await load();snapshots.push({period,category,rows});}catch(e){errors.push({period,category,error:String(e.message).slice(0,180)});}
      }
      const at=this.now(),prior=new Map((this.state.candidates||[]).map(x=>[x.proxyWallet,x]));
      if(snapshots.length){const result=candidateLeaders(snapshots,at);this.state={...this.state,...result,candidates:result.candidates.map(x=>({...x,firstObservedAt:prior.get(x.proxyWallet)?.firstObservedAt||at})),lastSuccessAt:at,sources:snapshots.map(x=>({period:x.period,category:x.category,count:x.rows.length,at}))};this.tape?.append('polycopy-candidates',{at,...result,sources:this.state.sources});}
      this.state={...this.state,schema:'mpo.copy-leader-candidates.v1',lastRunAt:at,status:errors.length?(snapshots.length?'PARTIAL':'ERROR'):'OK',errors,everyMs:15*60000};
      writeFileAtomicSync(this.file,JSON.stringify(this.state));return this.snapshot();
    }finally{this.busy=false;}
  }
}
