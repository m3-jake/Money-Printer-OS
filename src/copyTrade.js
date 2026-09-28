import { cfg } from './config.js';
import { copyWalletSignals, smartWallets, rememberCopySignal } from './walletTracker.js';
import { walletScorecardView } from './walletScorecard.js';

export function eligibleCopyWallets(scorecard=walletScorecardView(),{minTrips=3,minPnlSol=0}={}){
  const rows=scorecard?.wallets||[];const cutoff=Date.now()-30*86_400_000;
  return new Set(rows.filter(w=>Number(w.lastTs||0)>=cutoff&&Number(w.roundTrips||0)>=minTrips&&Number(w.realizedPnlSol||0)>=minPnlSol).map(w=>String(w.wallet)));
}

// This module only creates research signals. Order creation remains behind the existing proposal layer.
export function copyTradeSignals(events, { mode = cfg.mode, wallets = smartWallets(), scorecard, minTrips = 3, minPnlSol = 0, log = () => {} } = {}) {
  if (mode !== 'paper') return [];
  const card=scorecard||walletScorecardView(),rows=card?.wallets||[],byWallet=new Map(rows.map(w=>[String(w.wallet),w]));
  const signals = copyWalletSignals(events, { wallets: wallets.filter(w=>{const row=byWallet.get(String(w));return !row||Number(row.roundTrips||0)<minTrips||Number(row.realizedPnlSol||0)>=minPnlSol}) });
  for (const signal of signals) {rememberCopySignal(signal);log({ type: 'copy-trade-signal', mode: 'PAPER', ...signal });}
  return signals;
}
