import { PUMP_SDK, PUMP_PROGRAM_ID, pumpIdl } from './pumpSdk.js';
import { isAggressivePaper } from './runtime.js';
export const PUMPFUN_PROGRAM_ID = PUMP_PROGRAM_ID.toBase58();
const CREATE_DISCRIMINATOR = Buffer.from(pumpIdl.events.find(x => x.name === 'CreateEvent').discriminator);
const MINT = /(?:mint|token|initialize|create)[^1-9A-HJ-NP-Za-km-z]*([1-9A-HJ-NP-Za-km-z]{32,44})/i;

export function parsePumpfunLaunch(logs = [], { signature = null, ts = Date.now() } = {}) {
  for (const line of logs) {
    if (!String(line).startsWith('Program data: ')) continue;
    try {
      const bytes = Buffer.from(String(line).slice(14), 'base64');
      if (!bytes.subarray(0, 8).equals(CREATE_DISCRIMINATOR)) continue;
      const event = PUMP_SDK.decodeCreateEventBc(bytes.subarray(8));
      return { type: 'pumpfun-launch', mint: event.mint.toBase58(), user: event.user.toBase58(), creator: event.creator.toBase58(),
        symbol: event.symbol, name: event.name, bondingCurve: event.bondingCurve.toBase58(), createdAt: Number(event.timestamp.toString()) * 1000, signature, ts, source: 'solana:program-log', binaryEvent: true };
    } catch { /* Truncated or unrelated Anchor events cannot become a launch. */ }
  }
  for (const line of logs) { const match = String(line).match(MINT); if (match) return { type: 'pumpfun-launch', mint: match[1], signature, ts, source: 'solana:program-log' }; }
  return null;
}

export function pumpfunNativeCapability({ programId = PUMPFUN_PROGRAM_ID, sdkAvailable = false, runtime = {}, mode = 'paper' } = {}) {
  const enabled = Boolean(sdkAvailable) && isAggressivePaper(runtime, mode);
  return { programId, sdkAvailable: Boolean(sdkAvailable), create: enabled, buy: enabled, sell: enabled, unsignedOnly: true, submissionAllowed: false,
    reason: enabled ? 'official native builders available for paper instruction plans' : 'aggressive paper and the native SDK are required' };
}
