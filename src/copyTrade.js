import { cfg } from './config.js';
import { copyWalletSignals, smartWallets } from './walletTracker.js';

// This module only creates research signals. Order creation remains behind the existing proposal layer.
export function copyTradeSignals(events, { mode = cfg.mode, wallets = smartWallets(), log = () => {} } = {}) {
  if (mode !== 'paper') return [];
  const signals = copyWalletSignals(events, { wallets });
  for (const signal of signals) log({ type: 'copy-trade-signal', mode: 'PAPER', ...signal });
  return signals;
}
