import { isWalletAddress } from './walletScorecard.js';

export const smartWallets = (raw = process.env.SMART_WALLETS || '') => [...new Set(String(raw).split(',').map(x => x.trim()).filter(isWalletAddress))];

export function copyWalletSignals(events = [], { wallets = smartWallets(), minScore = 0 } = {}) {
  const tracked = new Set(wallets), out = [];
  for (const event of events) {
    if (!tracked.has(String(event?.wallet || '')) || event?.side !== 'BUY' || event?.signer !== true) continue;
    if (String(event?.raw?.program || '').toLowerCase() !== 'pump') continue;
    const score = Number(event.walletScore ?? event.score ?? 0);
    if (score < minScore) continue;
    out.push({ ts: Number(event.ts || Date.now()), mint: String(event.mint || ''), wallet: String(event.wallet), source: `copy:${event.wallet}`,
      side: 'BUY', score, signature: event.signature || null, solDelta: Number(event.solDelta || 0) });
  }
  return out.filter(x => x.mint);
}

export function rankCopyWallets(scorecard = [], { asOf = Date.now(), trailingDays = 30, minTrips = 3, demoteBelowSol = 0 } = {}) {
  const cutoff = asOf - trailingDays * 86_400_000;
  return scorecard.map(wallet => {
    const fresh = Number(wallet.lastTs || 0) >= cutoff;
    const qualified = fresh && Number(wallet.roundTrips || 0) >= minTrips;
    const pnl = Number(wallet.realizedPnlSol || 0);
    return { ...wallet, trailing30dPnlSol: pnl, qualified, autoDemoted: qualified && pnl < demoteBelowSol, eligible: qualified && pnl >= demoteBelowSol };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.trailing30dPnlSol - a.trailing30dPnlSol);
}
