export const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const MINT = /(?:mint|token|initialize|create)[^1-9A-HJ-NP-Za-km-z]*([1-9A-HJ-NP-Za-km-z]{32,44})/i;

export function parsePumpfunLaunch(logs = [], { signature = null, ts = Date.now() } = {}) {
  for (const line of logs) { const match = String(line).match(MINT); if (match) return { type: 'pumpfun-launch', mint: match[1], signature, ts, source: 'solana:program-log' }; }
  return null;
}

export function pumpfunNativeCapability({ programId = PUMPFUN_PROGRAM_ID, sdkAvailable = false } = {}) {
  return { programId, sdkAvailable: Boolean(sdkAvailable), create: false, buy: false, sell: false, reason: 'native transaction builder unavailable; paper launch events only' };
}
