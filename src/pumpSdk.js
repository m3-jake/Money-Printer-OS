import { createRequire } from 'node:module';

// Select the SDK's supported CommonJS export. Its ESM dependency chain imports
// Anchor's dynamically re-exported BN by name, which fails in Electron's Node 22.
// Keep application modules ESM and expose only the paper adapter's needed symbols.
const sdk = createRequire(import.meta.url)('@pump-fun/pump-sdk');
export const { PUMP_SDK, PUMP_PROGRAM_ID, pumpIdl, OnlinePumpSdk,
  getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } = sdk;
