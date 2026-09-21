import { mapLimit } from './utils.js';
import { programStreamHints } from './stream.js';
import { createMarketRequester } from './marketRequests.js';
import { cfg } from './config.js';
import { configureApiSpendPolicy } from './apiUnitEconomics.js';

configureApiSpendPolicy({dailySpendCapUsd:cfg.apiDailySpendCapUsd,roiValueUsd:cfg.apiResearchValueUsd,roiMinRoi:cfg.apiRoiGuardMinRoi});

const BASE = 'https://api.dexscreener.com';
const GECKO = 'https://api.geckoterminal.com/api/v2';
const requests = createMarketRequester({requestsPerMinute:cfg.marketRequestsPerMinute});
const SEED_TTL_MS = 45_000;
const STALE_SEED_TTL_MS = 10 * 60_000;

let seedCache = { ts: 0, meta: new Map(), health: {} };

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
let solPriceCache = { priceUsd: 0, ts: 0 };
export async function solUsdPrice() {
  if (solPriceCache.priceUsd > 0 && Date.now() - solPriceCache.ts < 30_000) return solPriceCache.priceUsd;
  try {
    const { data } = await getJson(`${BASE}/latest/dex/tokens/${WSOL_MINT}`, 'sol-usd-price');
    const pairs = (data?.pairs || []).filter(p => p.chainId === 'solana' && p.baseToken?.address === WSOL_MINT && Number(p.priceUsd) > 0);
    pairs.sort((a,b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
    const priceUsd = Number(pairs[0]?.priceUsd || 0);
    if (priceUsd > 0) solPriceCache = { priceUsd, ts: Date.now() };
  } catch {}
  return solPriceCache.priceUsd || 0;
}

async function getJson(url, label = 'market feed', ttlMs = 20000, purpose = 'scan') {
  const costPerRequestUsd=url.startsWith(GECKO)?cfg.geckoTerminalCostPerRequestUsd:cfg.dexScreenerCostPerRequestUsd;
  return requests.get(url,label,{ttlMs,costPerRequestUsd,purpose,headers:{accept:url.startsWith(GECKO)?'application/json;version=20230203':'application/json','user-agent':'SolanaMemeScout/9.0'}});
}

async function feed(path, source, health) {
  try {
    const { data, latencyMs } = await getJson(`${BASE}${path}`, source);
    health[source] = { ok: true, latencyMs, count: Array.isArray(data) ? data.length : 0, ts: Date.now() };
    return Array.isArray(data) ? data : [];
  } catch (error) {
    health[source] = { ok: false, error: error.message, ts: Date.now() };
    return [];
  }
}

function mintFromGeckoId(id = '') {
  return id.startsWith('solana_') ? id.slice(7) : id;
}

async function geckoSeeds(path, source, health) {
  try {
    const { data, latencyMs } = await getJson(`${GECKO}${path}`, source);
    const out = [];
    for (const p of data?.data || []) {
      const mint = mintFromGeckoId(p?.relationships?.base_token?.data?.id || '');
      if (mint) out.push({ tokenAddress: mint, source });
    }
    health[source] = { ok: true, latencyMs, count: out.length, ts: Date.now() };
    return out;
  } catch (error) {
    health[source] = { ok: false, error: error.message, ts: Date.now() };
    return [];
  }
}

async function searchSeeds(q, health) {
  const source = `search:${q}`;
  try {
    const { data, latencyMs } = await getJson(`${BASE}/latest/dex/search?q=${encodeURIComponent(q)}`, source);
    const out = [];
    for (const p of data?.pairs || []) {
      if (p.chainId === 'solana' && p.baseToken?.address) out.push({ tokenAddress: p.baseToken.address, source });
    }
    health[source] = { ok: true, latencyMs, count: out.length, ts: Date.now() };
    return out;
  } catch (error) {
    health[source] = { ok: false, error: error.message, ts: Date.now() };
    return [];
  }
}

async function collectSeeds() {
  const age = Date.now() - seedCache.ts;
  if (age < SEED_TTL_MS && seedCache.meta.size) return seedCache;

  const health = {};
  const [profiles, boosts, top, takeovers, newPools, trendingPools, ...searches] = await Promise.all([
    feed('/token-profiles/latest/v1', 'dex:profiles', health),
    feed('/token-boosts/latest/v1', 'dex:boosts', health),
    feed('/token-boosts/top/v1', 'dex:topBoosts', health),
    feed('/community-takeovers/latest/v1', 'dex:takeovers', health),
    geckoSeeds('/networks/solana/new_pools?page=1', 'gecko:new', health),
    geckoSeeds('/networks/solana/trending_pools?page=1', 'gecko:trending', health),
    ...['solana meme', 'pump fun', 'solana ai', 'solana dog', 'solana cat', 'solana new'].map(q => searchSeeds(q, health)),
  ]);

  const meta = new Map();
  for (const [source, arr] of [
    ['dex:profile', profiles], ['dex:boost', boosts], ['dex:topBoost', top], ['dex:takeover', takeovers],
  ]) {
    for (const x of arr) {
      if (x.chainId !== 'solana' || !x.tokenAddress) continue;
      const m = meta.get(x.tokenAddress) || { sources: [] };
      if (!m.sources.includes(source)) m.sources.push(source);
      Object.assign(m, x);
      meta.set(x.tokenAddress, m);
    }
  }
  for (const x of [...newPools, ...trendingPools, ...searches]) {
    if (!x.tokenAddress) continue;
    const m = meta.get(x.tokenAddress) || { sources: [] };
    if (!m.sources.includes(x.source)) m.sources.push(x.source);
    meta.set(x.tokenAddress, m);
  }
  for (const x of programStreamHints(300)) {
    if (!x.tokenAddress) continue;
    const m = meta.get(x.tokenAddress) || { sources: [] };
    if (!m.sources.includes(x.source)) m.sources.push(x.source);
    m.streamTs = x.streamTs;
    meta.set(x.tokenAddress, m);
  }

  // If upstream feeds hiccup, keep the previous universe rather than suddenly showing an empty scanner.
  if (!meta.size && seedCache.meta.size && age < STALE_SEED_TTL_MS) {
    seedCache.health = { ...health, cache: { ok: true, stale: true, ageMs: age, count: seedCache.meta.size, ts: Date.now() } };
    return seedCache;
  }

  seedCache = { ts: Date.now(), meta, health };
  return seedCache;
}

export function discoveryHealth() {
  return {...seedCache.health,marketRequests:{...requests.health(),ts:Date.now()}};
}

export async function discoverCandidates(max = 120) {
  const { meta } = await collectSeeds();
  const seedPriority = m => {
    const src = m?.sources || [];
    let q = src.includes('solana:program-log') ? 130 : 0;
    if (src.includes('gecko:new')) q += 110;
    if (src.includes('gecko:trending')) q += 80;
    if (src.some(x => String(x).startsWith('search:'))) q += 35;
    if (src.includes('dex:profile')) q += 30;
    if (src.includes('dex:boost') || src.includes('dex:topBoost')) q += 25;
    if (m?.streamTs) q += Math.max(0, 40 - (Date.now()-m.streamTs)/15000);
    return q;
  };
  const addresses = [...meta.entries()].sort((a,b)=>seedPriority(b[1])-seedPriority(a[1])).map(([mint])=>mint).slice(0, Math.max(max * 4, 240));
  const batches = [];
  for (let i = 0; i < addresses.length; i += 30) batches.push(addresses.slice(i, i + 30));

  const responses = await mapLimit(batches, 3, async batch => {
    const url = `${BASE}/tokens/v1/solana/${batch.join(',')}`;
    try {
      const {data,fetchedAt}=await getJson(url, 'dex:token-batch');
      return (Array.isArray(data)?data:[]).map(p=>({...p,priceObservedAt:fetchedAt}));
    } catch {
      return [];
    }
  });

  const bestByMint = new Map();
  for (const pairs of responses) {
    if (!Array.isArray(pairs)) continue;
    for (const p of pairs) {
      if (p.chainId !== 'solana') continue;
      const mint = p.baseToken?.address;
      if (!mint) continue;
      const cur = bestByMint.get(mint);
      const liq = Number(p.liquidity?.usd || 0);
      if (!cur || liq > Number(cur.liquidity?.usd || 0)) bestByMint.set(mint, p);
    }
  }

  const out = [...bestByMint.entries()].map(([mint, p]) => ({ ...p, discovery: meta.get(mint) }));
  const discoveryRank = p => {
    const ageMin = p.pairCreatedAt ? Math.max(0,(Date.now()-p.pairCreatedAt)/60000) : 9999;
    const freshness = ageMin < 5 ? 50000 : ageMin < 20 ? 25000 : ageMin < 60 ? 8000 : 0;
    const m5v = Number(p.volume?.m5||0), h1v=Number(p.volume?.h1||0), liq=Number(p.liquidity?.usd||0);
    const tx = Number(p.txns?.m5?.buys||0)+Number(p.txns?.m5?.sells||0);
    const stream = p.discovery?.sources?.includes('solana:program-log') ? 35000 : 0;
    return stream + freshness + m5v*2.5 + h1v*.45 + liq*.08 + tx*150;
  };
  return out.sort((a,b)=>discoveryRank(b)-discoveryRank(a)).slice(0,max);
}

export async function tokenPairs(address) {
  const {data,fetchedAt}=await getJson(`${BASE}/token-pairs/v1/solana/${address}`, 'dex:token-pairs',5000);
  return (Array.isArray(data)?data:[]).map(p=>({...p,priceObservedAt:fetchedAt}));
}

export async function refreshPair(tokenAddress, preferredPairAddress = null) {
  const pairs = (await tokenPairs(tokenAddress)) || [];
  // token-pairs can include markets where the requested mint is not the base token.
  // priceUsd describes the base token, so accepting a quote-side market can create
  // catastrophic phantom repricings. Only accept markets priced for this mint.
  const basePairs = pairs.filter(p => p?.baseToken?.address === tokenAddress && Number(p?.priceUsd) > 0);
  if (preferredPairAddress) {
    const exact = basePairs.find(p => p?.pairAddress === preferredPairAddress);
    if (exact) return exact;
    // Never silently migrate a held position to another pool. If its entry market
    // disappears temporarily, skip the mark and try again on the next refresh.
    return null;
  }
  return basePairs.sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0] || null;
}

// One bounded request for up to 30 held pools replaces one request per position.
// Exact pool AND base mint must match; a missing pool never migrates silently.
export async function refreshPositionPairs(positions=[]) {
  const ids=[...new Set(positions.map(p=>p.pairAddress).filter(Boolean))].sort();
  const chunks=[];for(let i=0;i<ids.length;i+=30)chunks.push(ids.slice(i,i+30));
  const rows=await mapLimit(chunks,2,async chunk=>{
    const {data,fetchedAt}=await getJson(`${BASE}/latest/dex/pairs/solana/${chunk.join(',')}`,'dex:held-pools',5000);
    return (data?.pairs||[]).map(p=>({...p,priceObservedAt:fetchedAt}));
  });
  const byPool=new Map(rows.filter(Array.isArray).flat().filter(p=>p?.chainId==='solana').map(p=>[p.pairAddress,p]));
  return mapLimit(positions,2,async p=>{
    const pair=p.pairAddress?byPool.get(p.pairAddress):await refreshPair(p.mint);
    return {p,pair:pair?.baseToken?.address===p.mint&&Number(pair.priceUsd)>0?pair:null};
  });
}

export async function batchTokenPrices(addresses = []) {
  const out = new Map();
  const unique = [...new Set(addresses.filter(Boolean))];
  const batches=[]; for(let i=0;i<unique.length;i+=30)batches.push(unique.slice(i,i+30));
  const rows=await mapLimit(batches,3,async batch=>{try{return (await getJson(`${BASE}/tokens/v1/solana/${batch.join(',')}`,'dex:followup-batch',30000,'research')).data||[]}catch{return[]}});
  for(const pairs of rows){for(const p of Array.isArray(pairs)?pairs:[]){const mint=p.baseToken?.address,price=Number(p.priceUsd||0);if(!mint||!(price>0))continue;const prev=out.get(mint);if(!prev||Number(p.liquidity?.usd||0)>prev.liq)out.set(mint,{price,liq:Number(p.liquidity?.usd||0)});}}
  return new Map([...out].map(([mint,x])=>[mint,x.price]));
}
