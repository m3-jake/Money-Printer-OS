// Read-only accounting of retained point-in-time discovery and independent follower books.
import fs from 'node:fs';
import path from 'node:path';
import { discoveredCopyRows } from './leaderDiscovery.js';
import { pickLeaders, COPY_DEFAULTS } from './polymarketCopy.js';
import { selectedPumpCopyWallets, PUMP_COPY_DEFAULTS } from './pumpfunCopyPaper.js';
import { copyAttribution } from './copyAttribution.js';

const array = x => Array.isArray(x) ? x : [];
const positionId = p => p.parentPositionId || p.id || `${p.asset || p.mint}:${p.openedAt}`;
const reasons = decisions => {
  const out = {}; for (const d of array(decisions)) if (d.reason) out[d.reason] = (out[d.reason] || 0) + 1;
  return out;
};
export function copyBookFunnel(book, { platform, catalogue, scorecard, now = Date.now() } = {}) {
  const pump = platform === 'pumpfun', open = array(book.open), history = array(book.history);
  const openIds = new Set(open.map(positionId)), all = new Set([...open, ...history].map(positionId));
  const closed = new Set(history.filter(p => !openIds.has(positionId(p))).map(positionId));
  const pnlKey = pump ? 'pnlSol' : 'pnlUsd', knownByPosition=new Map();
  for(const p of history){const id=positionId(p);knownByPosition.set(id,(knownByPosition.get(id)??true)&&Number.isFinite(p[pnlKey]));}
  const evaluated = new Set([...closed].filter(id=>knownByPosition.get(id)));
  const settings = { ...(pump?PUMP_COPY_DEFAULTS:COPY_DEFAULTS), ...book.settings };
  const leaders = pump ? selectedPumpCopyWallets(scorecard,{asOf:now,settings,experiment:book.experiment}) : array(book.follows);
  const category = book.experiment?.policy === 'category-specialist' ? book.experiment.category : 'ALL';
  const eligible = pump ? selectedPumpCopyWallets(scorecard, { asOf: now, settings:{...settings,maxLeaders:Number.MAX_SAFE_INTEGER},experiment:book.experiment }).length
    : pickLeaders(discoveredCopyRows(catalogue, { category, now }), { ...settings, follows: Number.MAX_SAFE_INTEGER }, new Set(Object.keys(book.evicted || {})), now).length;
  const candidateCount = pump ? scorecard?.summary?.wallets ?? null : array(catalogue?.candidates).length;
  const policy = book.experiment?.policy || (pump ? 'strict-wallet-copy' : 'incumbent');
  const knownPnl=history.filter(p => Number.isFinite(p[pnlKey]));
  const pnl = history.length&&!knownPnl.length?null:knownPnl.reduce((n, p) => n + p[pnlKey], 0);
  return { id: book.experiment?.id || `${platform}-incumbent`, platform, policy, category, unit: pump ? 'SOL' : 'USD',
    qualification: 'UNQUALIFIED', exploratory: book.experiment?.exploratory === true || pump && policy !== 'strict-wallet-copy',
    funnel: { candidates: candidateCount, rejectedObservations: pump ? null : catalogue?.rejected ?? null, observed: pump ? scorecard?.summary?.swaps ?? null : catalogue?.observed ?? null,
      eligible, followed: leaders.length, copied: all.size, open: open.length, exited: closed.size, evaluated: evaluated.size },
    eligibilityScope: pump && policy !== 'strict-wallet-copy' ? 'Current separate exploratory policy selection under its frozen settings; eligibility is not strict qualification' : 'Current fresh point-in-time source under this book selection settings; eligibility is not profitability',
    followedScope:pump?'Current selected wallets; Pump selections are made on demand, not persistent follow subscriptions':'Persistent retained follow subscriptions',
    afterCost: { netPnl: pnl, baselineNoTrade: 0, qualified: false, independentPositions: evaluated.size, partialExitSlices: history.length - closed.size,
      knownPnlSlices:knownPnl.length,unknownPnlSlices:history.length-knownPnl.length,attribution: pump ? null : copyAttribution(history) },
    watched: leaders.map(f => ({ wallet: f.wallet, followedAt: f.followedAt ?? null, firstObservedAt: array(catalogue?.candidates).find(c => c.proxyWallet === f.wallet)?.firstObservedAt ?? null })),
    reasons: reasons(book.decisions), reasonsScope: { retained: array(book.decisions).length, allTime: false },
    paused: book.drawdownPause?.active === true, lastRunAt: book.lastRunAt ?? null, lastError: book.lastError ?? null,
    historyScope: 'Retained book records; completed positions counted once across partial exits. Cross-book controls are independent, not matched causal estimates.' };
}
export function readCopyFunnel({ dataDir, now = Date.now(), walletOffset=0,walletLimit=50,fullWalletDirectory=false }) {
  const errors = [], read = relative => {
    const file = path.join(dataDir, relative); if (!fs.existsSync(file)) return null;
    try { const stat = fs.statSync(file); if (stat.size > 32 * 1024 * 1024) throw Error('Book exceeds bounded read size'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { errors.push({ file: relative, error: e.message }); return null; }
  };
  const catalogue = read('copy-leader-candidates.json'), scorecard = read('wallet-scorecard.json'), indexer = read('wallet-indexer-state.json');
  const books = [], add = (relative, platform) => { const b = read(relative); if (b) books.push(copyBookFunnel(b, { platform, catalogue, scorecard, now })); };
  add('polymarket-copy-paper.json', 'polymarket-global');
  const experiments = path.join(dataDir, 'experiments');
  if (fs.existsSync(experiments)) for (const d of fs.readdirSync(experiments, { withFileTypes: true })) if (d.isDirectory() && d.name.startsWith('polycopy-')) add(`experiments/${d.name}/polymarket-copy-paper.json`, 'polymarket-global');
  for (const file of ['pumpfun-copy-paper.json', 'pumpfun-copy-emerging-paper.json', 'pumpfun-copy-consensus-paper.json']) add(file, 'pumpfun');
  const wallets=array(scorecard?.wallets),offset=fullWalletDirectory?0:Number.isSafeInteger(walletOffset)&&walletOffset>=0?walletOffset:0,limit=fullWalletDirectory?wallets.length:Number.isSafeInteger(walletLimit)&&walletLimit>0?Math.min(200,walletLimit):50;
  return { schema: 'mpo.copy-funnel.v1', at: now, paperOnly: true, books, errors,
    walletDirectory:{asOf:scorecard?.asOf??null,totalScored:scorecard?.summary?.wallets??wallets.length,persisted:wallets.length,offset,limit,returned:wallets.slice(offset,offset+limit).length,omittedFromPage:Math.max(0,wallets.length-wallets.slice(offset,offset+limit).length),persistenceOmissions:Math.max(0,(scorecard?.summary?.wallets??wallets.length)-wallets.length),wallets:wallets.slice(offset,offset+limit)},
    indexer: indexer?.health ?? null, discovery: { status: catalogue?.status ?? 'UNAVAILABLE', lastSuccessAt: catalogue?.lastSuccessAt ?? null,
      firstObservedAt:Object.values(catalogue?.membership||{}).reduce((first,m)=>Number.isSafeInteger(m?.firstObservedAt)&&m.firstObservedAt>0?first===null?m.firstObservedAt:Math.min(first,m.firstObservedAt):first,null),
      candidates: array(catalogue?.candidates).length, rejected: catalogue?.rejected ?? null },
    limitations: ['Leader profits are discovery leads. These are after-cost follower books.', 'Reasons cover retained decisions; absent records remain unknown.', 'Global CLOB copy, US contracts and Kalshi mirrors have separate policies; this funnel reports wallet-copy books only.'] };
}
let cached;
export async function handleCopyFunnelRequest(req, res, url, ctx) {
  const walletOffset=Math.max(0,Number.parseInt(url.searchParams.get('walletOffset')||'0',10)||0),walletLimit=Math.max(1,Math.min(200,Number.parseInt(url.searchParams.get('walletLimit')||'50',10)||50));
  const now = Date.now(); if (!cached || cached.dir !== ctx.dataDir || now - cached.at > 5000) cached = { dir: ctx.dataDir, at: now,value: readCopyFunnel({ dataDir: ctx.dataDir, now,fullWalletDirectory:true }) };
  const directory=cached.value.walletDirectory,wallets=directory.wallets.slice(walletOffset,walletOffset+walletLimit);
  ctx.json(res, {...cached.value,walletDirectory:{...directory,wallets,offset:walletOffset,limit:walletLimit,returned:wallets.length,omittedFromPage:Math.max(0,directory.persisted-wallets.length)}}); return true;
}
