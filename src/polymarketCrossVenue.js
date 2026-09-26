// Public cross-venue gap log (read-only). For the PM US markets the evidence
// collector already tracks, record the international Polymarket mid beside the
// PM US mid. Public GETs only (gamma, clob midpoint); no auth, no orders.
//
// Matching is conservative: exact market slug AND matching question text, a
// binary market, open on both venues. Anything else is written as unmatched
// with a reason, never guessed.
//
// Kill flag: POLYMARKET_CROSS_VENUE_LOG=false (or 0/off) disables it entirely.
import { appendNdjson, RESEARCH_RAW_DIR } from './researchCollector.js';

const GAMMA=process.env.POLYMARKET_GAMMA_URL||'https://gamma-api.polymarket.com';
const CLOB=process.env.POLYMARKET_CLOB_URL||'https://clob.polymarket.com';
export const CROSS_VENUE_POLL_MS=60_000;
export const CROSS_VENUE_BATCH=20;             // slugs per gamma call, one call per tick
export const CROSS_VENUE_MISS_TTL_MS=30*60e3;  // re-check an unmatched slug after 30 min

const num=x=>{const n=Number(x);return Number.isFinite(n)?n:null};
const r4=x=>x==null?null:Math.round(x*1e4)/1e4;
const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

export function crossVenueEnabled(env=process.env){
 return !/^(false|0|off|no)$/i.test(String(env.POLYMARKET_CROSS_VENUE_LOG??'true'));
}
// Module-level memory (per collector process): last poll time and unmatched-slug cache.
const mem={lastAt:0,miss:new Map(),cursor:0};
export function resetCrossVenueMemory(){mem.lastAt=0;mem.miss.clear();mem.cursor=0}

function parseList(x){if(Array.isArray(x))return x;try{const v=JSON.parse(x||'[]');return Array.isArray(v)?v:[]}catch{return []}}
function usMid(r){const b=num(r.bid),a=num(r.ask);return b>0&&a>0&&a<1&&b<=a?r4((a+b)/2):null}

// Decide whether an international gamma market is the same market. Returns {ok,reason}.
export function matchIntl(usRow,intl){
 if(!intl)return {ok:false,reason:'no-intl-market-with-slug'};
 if(String(intl.slug||'')!==String(usRow.symbol||''))return {ok:false,reason:'slug-mismatch'};
 const outs=parseList(intl.outcomes);
 if(outs.length!==2)return {ok:false,reason:'intl-not-binary'};
 if(intl.closed===true||intl.active===false)return {ok:false,reason:'intl-closed'};
 const uq=norm(usRow.question),iq=norm(intl.question);
 if(!uq||!iq)return {ok:false,reason:'question-missing'};
 if(uq!==iq)return {ok:false,reason:'question-mismatch'};
 return {ok:true,reason:null};
}
export function intlMidOf(intl){
 const b=num(intl?.bestBid),a=num(intl?.bestAsk);
 return b>0&&a>0&&a<1&&b<=a?{mid:r4((a+b)/2),bid:b,ask:a,source:'gamma-bbo'}:null;
}

export async function fetchGammaBySlug(slugs,fetchImpl=globalThis.fetch){
 const url=new URL('/markets',GAMMA);
 for(const s of slugs)url.searchParams.append('slug',s);
 const res=await fetchImpl(url.toString(),{headers:{accept:'application/json'}});
 if(!res?.ok){const e=new Error(`gamma HTTP ${res?.status}`);e.status=Number(res?.status||0);throw e}
 const j=JSON.parse(await res.text());
 return Array.isArray(j)?j:[];
}
async function clobMid(tokenId,fetchImpl){
 const url=new URL('/midpoint',CLOB);url.searchParams.set('token_id',String(tokenId));
 const res=await fetchImpl(url.toString(),{headers:{accept:'application/json'}});
 if(!res?.ok)return null;
 const m=num(JSON.parse(await res.text())?.mid);
 return m>0&&m<1?{mid:r4(m),bid:null,ask:null,source:'clob-midpoint'}:null;
}

// Board rows (PM US legs the collector tracks), deduped by market slug.
export function usRowsFromBoard(byWindow){
 const seen=new Map();
 for(const built of Object.values(byWindow||{}))for(const c of [...(built.board||[]),...(built.singles||[])]){
  if(!c?.key||!c.symbol||seen.has(c.symbol))continue;
  seen.set(c.symbol,c);
 }
 return [...seen.values()];
}

export async function crossVenueTick({byWindow,now=Date.now(),rawDir=RESEARCH_RAW_DIR,fetchImpl=globalThis.fetch,env=process.env,force=false}={}){
 if(!crossVenueEnabled(env))return {enabled:false,rows:0};
 if(!force&&now-mem.lastAt<CROSS_VENUE_POLL_MS)return {enabled:true,skipped:'cadence',rows:0};
 mem.lastAt=now;
 for(const [k,t] of mem.miss)if(now-t>CROSS_VENUE_MISS_TTL_MS)mem.miss.delete(k);
 const all=usRowsFromBoard(byWindow).filter(r=>!mem.miss.has(r.symbol));
 if(!all.length)return {enabled:true,rows:0};
 // Rotate through the board so every market is eventually sampled.
 const start=mem.cursor%all.length;
 const batch=[...all.slice(start),...all.slice(0,start)].slice(0,CROSS_VENUE_BATCH);
 mem.cursor=start+batch.length;
 let intl=[];
 try{intl=await fetchGammaBySlug(batch.map(r=>r.symbol),fetchImpl)}
 catch(e){return {enabled:true,rows:0,error:String(e?.message||e)}}
 const bySlug=new Map(intl.map(m=>[String(m.slug||''),m]));
 const rows=[];let matched=0;
 for(const r of batch){
  const m=bySlug.get(r.symbol)||null;
  const verdict=matchIntl(r,m);
  const base={schema:'mpo.polymarket-cross-venue.v1',capturedAt:now,slug:r.symbol,eventSlug:r.eventSlug,sport:r.sport,question:r.question||null,
   us:{bid:num(r.bid),ask:num(r.ask),mid:usMid(r),side:r.side,freshnessSec:r.freshnessSec??null}};
  if(!verdict.ok){
   rows.push({...base,matched:false,reason:verdict.reason,intl:null,gap:null});
   if(verdict.reason==='no-intl-market-with-slug'||verdict.reason==='question-mismatch'||verdict.reason==='intl-not-binary')mem.miss.set(r.symbol,now);
   continue;
  }
  let q=intlMidOf(m);
  if(!q){const tok=parseList(m.clobTokenIds)[0];if(tok!=null){try{q=await clobMid(tok,fetchImpl)}catch{q=null}}}
  const usm=base.us.mid;
  rows.push({...base,matched:true,reason:q?null:'intl-no-quote',
   intl:{slug:m.slug,conditionId:m.conditionId||null,mid:q?.mid??null,bid:q?.bid??null,ask:q?.ask??null,source:q?.source||null},
   gap:q&&usm!=null?r4(usm-q.mid):null});
  matched++;
 }
 appendNdjson('polymarket-cross-venue',rows,{dir:rawDir,now});
 return {enabled:true,rows:rows.length,matched,unmatched:rows.length-matched};
}
