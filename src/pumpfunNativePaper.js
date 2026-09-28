import BN from 'bn.js';
import { Connection, PublicKey, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { PUMP_SDK, PUMP_PROGRAM_ID, OnlinePumpSdk, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } from '@pump-fun/pump-sdk';
import { cfg } from './config.js';
import { isAggressivePaper } from './runtime.js';
import { quoteRoundTrip, quoteExactInput, SOL_MINT } from './jupiterQuoteSampler.js';

const nativeMint = new PublicKey(SOL_MINT);
const serialize = ix => ({ programId: ix.programId.toBase58(), keys: ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: ix.data.toString('base64') });
export function requireNativePaper(runtime, mode) { if (!isAggressivePaper(runtime, mode)) throw new Error('Pump.fun native plans require AGGRESSIVE_PAPER in paper mode'); }

export async function buildNativePaperPlan({ action, mint, user, snapshot, sizeSol, rawAmount, metadata = {}, runtime, mode = 'paper', sdk = PUMP_SDK,
  priorityMicroLamports = 1000, tipAccount = null, tipLamports = 1000 } = {}) {
  requireNativePaper(runtime, mode);
  const asset = new PublicKey(mint), authority = new PublicKey(user || PublicKey.default), side = String(action).toUpperCase();
  if (!['CREATE', 'BUY', 'SELL'].includes(side)) throw new Error('CREATE, BUY or SELL required');
  const micro = Math.min(100000, Math.max(0, Math.floor(Number(priorityMicroLamports) || 0))), tip = tipAccount ? Math.min(1000000, Math.max(1000, Math.floor(Number(tipLamports) || 1000))) : 0;
  let instructions, quote = null;
  if (side === 'CREATE') {
    if (!metadata.name || !metadata.symbol || !metadata.uri) throw new Error('Paper create requires name, symbol and URI');
    instructions = [await sdk.createV2Instruction({ mint: asset, user: authority, creator: new PublicKey(metadata.creator || authority), name: metadata.name, symbol: metadata.symbol, uri: metadata.uri, mayhemMode: false, cashback: false })];
  } else {
    if (!snapshot || snapshot.bondingCurve.complete) throw new Error('Native bonding curve is unavailable or graduated');
    if (snapshot.quoteMint && !snapshot.quoteMint.equals(nativeMint) && !snapshot.quoteMint.equals(PublicKey.default)) throw new Error('This paper lane supports SOL-quoted curves only');
    const params = { global: snapshot.global, feeConfig: snapshot.feeConfig, mintSupply: snapshot.bondingCurve.tokenTotalSupply, bondingCurve: snapshot.bondingCurve };
    let amount, quoteAmount;
    if (side === 'BUY') {
      if (!(Number(sizeSol) > 0) || Number(sizeSol) > Math.min(3, Number(runtime.paperOverrides?.maxPositionSol || 3))) throw new Error('Native paper size exceeds its profile');
      quoteAmount = new BN(String(Math.floor(Number(sizeSol) * 1e9)));
      amount = getBuyTokenAmountFromSolAmount({ ...params, amount: quoteAmount, quoteMint: nativeMint });
    } else {
      if (!/^\d+$/.test(String(rawAmount)) || BigInt(rawAmount) <= 0n) throw new Error('Positive raw token amount required');
      amount = new BN(String(rawAmount)); quoteAmount = getSellSolAmountFromTokenAmount({ ...params, amount });
    }
    if (amount.isZero() || quoteAmount.isZero()) throw new Error('Native paper quote has no executable output');
    const input = { ...snapshot, global: snapshot.global, mint: asset, user: authority, amount, quoteAmount, slippage: .2 };
    instructions = side === 'BUY' ? await sdk.buyV2Instructions(input) : await sdk.sellV2Instructions(input);
    quote = { rawAmount: amount.toString(), solAmount: Number(quoteAmount.toString()) / 1e9, priceSolPerRaw: Number(quoteAmount.toString()) / 1e9 / Number(amount.toString()), source: 'pumpfun-native-curve', observedAt: snapshot.observedAt };
  }
  instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }), ...instructions];
  if (tipAccount) instructions.push(SystemProgram.transfer({ fromPubkey: authority, toPubkey: new PublicKey(tipAccount), lamports: tip }));
  return { mode: 'PAPER', action: side, mint: asset.toBase58(), quote, instructions: instructions.map(serialize), unsigned: true, orderSubmitted: false,
    priorityFeeLamports: Math.ceil(micro * 300000 / 1e6), signatureFeeLamports: side === 'CREATE' ? 10000 : 5000,
    jito: { bundleOnly: true, transactions: 1, tipLamports: tip, tipAccount, planned: Boolean(tipAccount), submitted: false, protectionVerified: false } };
}

export function createNativePaperAdapter({ connection = null, online = null, sdk = PUMP_SDK, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  // Transport allowlist also prevents an SDK update from ever submitting a transaction.
  const rpcFetch = (url, init = {}) => {
    const body = JSON.parse(String(init.body || '{}'));
    if (![body].flat().every(x => ['getAccountInfo', 'getMultipleAccounts'].includes(x.method))) throw new Error('Native paper transport refuses non-account RPC methods');
    return fetchImpl(url, { ...init, signal: AbortSignal.timeout(6000) });
  };
  const rpc = connection || new Connection(cfg.rpcUrl, { commitment: 'processed', disableRetryOnRateLimit: true, fetch: rpcFetch });
  const reader = online || new OnlinePumpSdk(rpc);
  let globalCache = null, tips = null;
  const curves = new Map();
  async function read(mint, user = PublicKey.default.toBase58()) {
    const key = `${mint}:${user}`, hit = curves.get(key); if (hit && now() - hit.observedAt < 3000) return hit;
    if (!globalCache || now() - globalCache.at > 60000) {
      const [global, feeConfig] = await Promise.all([reader.fetchGlobal(), reader.fetchFeeConfig()]); globalCache = { at: now(), global, feeConfig };
    }
    const mintKey = new PublicKey(mint), mintAccount = await rpc.getAccountInfo(mintKey);
    const owners = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
    if (!mintAccount || !owners.has(mintAccount.owner.toBase58())) throw new Error('Mint token program unavailable');
    const state = await reader.fetchBuyState(mintKey, new PublicKey(user), mintAccount.owner);
    if (!state.bondingCurveAccountInfo.owner.equals(PUMP_PROGRAM_ID)) throw new Error('Curve account has a foreign owner');
    const snapshot = { ...state, ...globalCache, tokenProgram: mintAccount.owner, observedAt: now() };
    curves.set(key, snapshot); if (curves.size > 64) curves.delete(curves.keys().next().value); return snapshot;
  }
  async function tipAccount() {
    if (tips && now() - tips.at < 3600000) return tips.account;
    const r = await fetchImpl('https://mainnet.block-engine.jito.wtf/api/v1/bundles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }), signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('Jito tip-account read failed');
    const j = await r.json(); if (!Array.isArray(j.result) || !j.result.length) throw new Error('Jito tip-account list unavailable');
    tips = { at: now(), account: new PublicKey(j.result[0]).toBase58() }; return tips.account;
  }
  async function quote({ mint, user, action = 'BUY', sizeSol, rawAmount, runtime, mode = 'paper' }) {
    requireNativePaper(runtime, mode);
    action = String(action).toUpperCase();
    if (!['BUY', 'SELL'].includes(action)) throw new Error('BUY or SELL quote required');
    if (action === 'BUY' && (!(Number(sizeSol) > 0) || Number(sizeSol) > Math.min(3, Number(runtime.paperOverrides?.maxPositionSol || 3)))) throw new Error('Native paper size exceeds its profile');
    if (action === 'SELL' && (!/^\d+$/.test(String(rawAmount)) || BigInt(rawAmount) <= 0n)) throw new Error('Positive raw token amount required');
    let account = null; try { account = await tipAccount(); } catch { /* The plan explicitly reports missing bundle protection. */ }
    try {
      const snapshot = await read(mint, user), plan = await buildNativePaperPlan({ mint, user, action, sizeSol, rawAmount, snapshot, runtime, mode, sdk, tipAccount: account });
      return { ...plan.quote, plan, liquiditySol: Number(snapshot.bondingCurve.virtualQuoteReserves.toString()) / 1e9, latencyMs: Math.max(0, now() - snapshot.observedAt) };
    } catch (e) {
      // Quotes only; the Jupiter signing/order module is deliberately never used.
      if (action === 'BUY') {
        const q = await quoteRoundTrip({ mint }, { notionalSol: sizeSol, fetchImpl, now: now() });
        return { rawAmount: q.buy.outRaw, solAmount: sizeSol, priceSolPerRaw: sizeSol / Number(q.buy.outRaw), source: 'jupiter-quote-fallback', observedAt: q.t, latencyMs: q.buy.ms, liquiditySol: sizeSol, depthSource: 'quoted-notional-only', nativeError: String(e.message), plan: null, liquidityKnown: false };
      }
      const q = await quoteExactInput({ inputMint: mint, outputMint: SOL_MINT, amount: rawAmount, fetchImpl });
      return { rawAmount: String(rawAmount), solAmount: Number(q.outAmount) / 1e9, priceSolPerRaw: Number(q.outAmount) / 1e9 / Number(rawAmount), source: 'jupiter-quote-fallback', observedAt: now(), latencyMs: q.ms, plan: null, liquidityKnown: false };
    }
  }
  return { read, quote, tipAccount };
}
