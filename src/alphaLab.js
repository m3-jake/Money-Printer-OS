const clamp=(x,a=0,b=100)=>Math.max(a,Math.min(b,Number(x)||0));
const mean=xs=>xs.length?xs.reduce((q,x)=>q+Number(x||0),0)/xs.length:0;
const quantile=(xs,p)=>{if(!xs.length)return 0;const a=[...xs].sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.floor((a.length-1)*p))]};

export function ensureAlpha(s){
  s.research ||= {};
  s.research.alpha ||= {version:2,tokens:{},wallets:{},deployers:{},clusters:{},evidence:[],counterfactuals:[],lastAnalyze:0,stats:{observations:0,retentionSamples:0,crowdingSamples:0,counterfactualSamples:0}};
  const A=s.research.alpha;
  A.version=2; A.tokens ||= {}; A.wallets ||= {}; A.deployers ||= {}; A.evidence ||= []; A.counterfactuals ||= [];
  A.stats ||= {observations:0,retentionSamples:0,crowdingSamples:0,counterfactualSamples:0};
  for(const t of Object.values(A.tokens)){if(t.alphaSchema!==2){t.alphaSchema=2;t.firstWalletQuality=null;t.retention60=null;t.crowdingPeak60=null;t.entryPrices={0:Number(t.firstPrice||0)};t.counterfactualSettled=false;t.counterfactual=null;t.legacyExcluded=true;}}
  return A;
}

function walletQuality(alpha,id){
  const w=alpha.wallets[id]; if(!w)return 50;
  const n=Number(w.outcomeN||0),ret=Number(w.runnerRate||0);
  // Reputation is deliberately conservative until settled outcomes exist.
  return clamp(48+Math.log10(n+1)*6+(ret-20)*.22,20,90);
}

function crowding(a){
  const vel=Number(a.micro?.velocity||0),accel=Number(a.micro?.flowAccel||0),liq=Math.max(1,Number(a.liq||0));
  return clamp(vel*7+Math.max(0,accel)*10+Math.max(0,5-Math.log10(liq))*9);
}

function maybeCounterfactual(t,now,price){
  const ageMs=now-Number(t.firstSeen||now);
  const lag=30_000;
  t.entryPrices ||= {0:Number(t.firstPrice||price)};
  for(const sec of [10,30,60]){
    if(t.entryPrices[sec]!=null)continue;
    const target=sec*1000;
    if(ageMs>=target && ageMs<=target+lag && price>0)t.entryPrices[sec]=price;
    else if(ageMs>target+lag)t.entryPrices[sec]=null;
  }
  if(t.counterfactualSettled)return;
  const target=30*60_000;
  if(ageMs>=target && ageMs<=target+60_000 && price>0){
    const row={mint:t.mint,symbol:t.symbol,settledAt:now,horizonMin:30};
    for(const sec of [0,10,30,60]){const p=Number(t.entryPrices?.[sec]);if(p>0)row[sec]=(price/p-1)*100;}
    t.counterfactual=row;t.counterfactualSettled=true;
  } else if(ageMs>target+60_000){
    t.counterfactualSettled=true;t.counterfactualMissed=true;
  }
}

export function recordAlphaObservation(s,a){
  const A=ensureAlpha(s),now=Date.now(); if(!a?.mint)return;
  const holders=(a.risk?.largest||[]).map(h=>h.owner||h.address).filter(Boolean).slice(0,12);
  let t=A.tokens[a.mint];
  if(!t){
    const qualities=holders.map(id=>walletQuality(A,id));
    t=A.tokens[a.mint]={alphaSchema:2,mint:a.mint,symbol:a.symbol,firstSeen:now,lastSeen:now,firstPrice:Number(a.priceUsd||0),firstWallets:holders,
      firstWalletQuality:mean(qualities)||50,retention60:null,crowdingPeak60:0,deployer:a.risk?.mintAuthority||null,maxPrice:Number(a.priceUsd||0),observations:0,entryPrices:{0:Number(a.priceUsd||0)},legacyExcluded:false};
  }
  t.lastSeen=now;t.maxPrice=Math.max(Number(t.maxPrice||0),Number(a.priceUsd||0));t.observations++;
  const original=new Set(t.firstWallets||[]),still=holders.filter(x=>original.has(x));
  const retention=original.size?still.length/original.size*100:0,ageMs=now-Number(t.firstSeen||now),crowd=crowding(a);
  if(ageMs<=60_000)t.crowdingPeak60=Math.max(Number(t.crowdingPeak60||0),crowd);
  if(original.size && t.retention60==null && ageMs>=60_000 && ageMs<=90_000){t.retention60=retention;A.stats.retentionSamples++;}
  A.stats.crowdingSamples++;
  maybeCounterfactual(t,now,Number(a.priceUsd||0));
  for(const id of holders){
    const w=A.wallets[id]||(A.wallets[id]={address:id,tokens:0,seen:{},runnerHits:0,runnerRate:0,outcomeN:0,lastSeen:0});
    w.seen[a.mint]=1;w.tokens=Object.keys(w.seen).length;w.lastSeen=now;
  }
  if(t.deployer){const d=A.deployers[t.deployer]||(A.deployers[t.deployer]={id:t.deployer,tokens:{},launches:0,lastSeen:0});d.tokens[a.mint]=1;d.launches=Object.keys(d.tokens).length;d.lastSeen=now;}
  A.stats.observations++;
}

function splitKey(mint=''){let h=2166136261;for(let i=0;i<mint.length;i++){h^=mint.charCodeAt(i);h=Math.imul(h,16777619);}return(h>>>0)%5===0;}
function evidenceCard(id,title,rows,key){
  const usable=rows.filter(r=>Number.isFinite(Number(r[key]))),train=usable.filter(r=>!splitKey(r.mint)),valid=usable.filter(r=>splitKey(r.mint));
  if(train.length<32||valid.length<12)return {id,title,status:'COLLECTING',samples:usable.length,trainingSamples:train.length,validationSamples:valid.length,deltaPct:0,confidence:0};
  const cut=quantile(train.map(r=>Number(r[key])),.75),hi=valid.filter(r=>Number(r[key])>=cut),lo=valid.filter(r=>Number(r[key])<cut);
  if(hi.length<3||lo.length<6)return {id,title,status:'COLLECTING',samples:usable.length,trainingSamples:train.length,validationSamples:valid.length,deltaPct:0,confidence:0};
  const delta=mean(hi.map(r=>r.returnPct))-mean(lo.map(r=>r.returnPct));
  const status=delta>=2?'POSITIVE EVIDENCE':delta<=-2?'NEGATIVE EVIDENCE':'WEAK';
  return {id,title,status,samples:usable.length,trainingSamples:train.length,validationSamples:valid.length,highN:hi.length,deltaPct:delta,confidence:clamp(Math.sqrt(valid.length)*7+Math.abs(delta)*2),cutoff:cut,updatedAt:Date.now()};
}

function earliest30mOutcomes(s,A){
  const outcomes=(s.research?.learner?.outcomes||[]).filter(o=>o.horizonMin===30 && Number(o.entryTs)>0).sort((a,b)=>a.entryTs-b.entryTs);
  const first=new Map();
  for(const o of outcomes){
    const t=A.tokens[o.mint]; if(!t||first.has(o.mint))continue;
    // Alpha launch features are only valid for samples opened near first discovery.
    if(Math.abs(Number(o.entryTs)-Number(t.firstSeen||0))>120_000)continue;
    first.set(o.mint,o);
  }
  return [...first.values()];
}

export function analyzeAlpha(s){
  const A=ensureAlpha(s),now=Date.now(); if(now-A.lastAnalyze<60_000)return A;A.lastAnalyze=now;
  const outcomes=earliest30mOutcomes(s,A).slice(-2500);
  const joined=outcomes.map(o=>{const t=A.tokens[o.mint];return t&&!t.legacyExcluded?{...o,quality:t.firstWalletQuality==null?NaN:Number(t.firstWalletQuality),retention:t.retention60==null?NaN:Number(t.retention60),crowding:t.crowdingPeak60==null?NaN:Number(t.crowdingPeak60)}:null}).filter(Boolean);
  A.evidence=[
    evidenceCard('wallet-quality','Early-wallet quality',joined,'quality'),
    evidenceCard('wallet-retention','Who stayed? retention at 60s',joined,'retention'),
    evidenceCard('sniper-crowding','First-minute sniper crowding',joined,'crowding'),
  ];
  // One settled 30m launch outcome updates each early wallet once, preventing repeated minute samples from overweighting a token.
  for(const o of outcomes){
    const t=A.tokens[o.mint];if(!t)continue;
    for(const id of t.firstWallets||[]){
      const w=A.wallets[id];if(!w)continue;w.outcomes ||= {};
      const key=o.mint;if(key in w.outcomes)continue;
      w.outcomes[key]=Number(o.returnPct||0);const rs=Object.values(w.outcomes);w.outcomeN=rs.length;w.runnerHits=rs.filter(x=>x>=25).length;w.runnerRate=rs.length?w.runnerHits/rs.length*100:0;
    }
  }
  A.counterfactuals=Object.values(A.tokens).map(t=>t.counterfactual).filter(Boolean).slice(-500);
  A.stats.counterfactualSamples=A.counterfactuals.length;
  A.topDeployers=Object.values(A.deployers).sort((a,b)=>b.launches-a.launches).slice(0,20);
  return A;
}

export function alphaSnapshot(s){
  const A=analyzeAlpha(s),cf=A.counterfactuals||[];
  const timing=[0,10,30,60].map(sec=>({delaySec:sec,samples:cf.filter(x=>Number.isFinite(x[sec])).length,avgReturnPct:mean(cf.map(x=>x[sec]).filter(Number.isFinite))}));
  return {stats:A.stats,evidence:A.evidence,timing,topDeployers:(A.topDeployers||[]).slice(0,8),
    topWallets:Object.values(A.wallets).filter(w=>w.outcomeN>=2).sort((a,b)=>(b.runnerRate||0)-(a.runnerRate||0)||(b.outcomeN||0)-(a.outcomeN||0)).slice(0,10),
    tokenCount:Object.keys(A.tokens).length,walletCount:Object.keys(A.wallets).length,deployerCount:Object.keys(A.deployers).length,lastAnalyze:A.lastAnalyze,
    notes:['Wallet/deployer identity is still a public-RPC proxy until transaction-level first-buyer/funder indexing is connected.','Evidence uses frozen first-minute features and fixed 30-minute outcomes to avoid hindsight leakage.']};
}
