// Whale Watch: Solana wallet intelligence on top of data the engine already records.
//   universe          research.universe[mint]      tokens seen by the scanner (symbol, prices, first seen)
//   holders           research.walletProfiles      on-curve wallets seen among top holders, per mint
//   mint authorities  research.deployerProfiles    MINT AUTHORITY -> mints. The mint authority is often, but
//                                                  not always, the deployer; it is labelled as what it is.
//   swaps             alphaDb tx_events            signer swap events from the capped indexer (SOL legs)
//   scorecard         walletScorecard              point-in-time realized PnL per wallet
// Everything computed here is OBSERVATION or RULE-BASED ANALYSIS. Wallet behaviour is never treated as
// proof of identity or intent; labels are user notes. Exchange inflows/outflows need exchange wallet
// attribution MPOS does not have, so they are reported as unavailable.

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const short = a => (a ? `${String(a).slice(0, 4)}…${String(a).slice(-4)}` : '');

export function authorityOf(mint, deployers = {}) {
  for (const d of Object.values(deployers || {})) if (d?.mints && d.mints[mint]) return d;
  return null;
}
export function holdersOf(mint, wallets = {}) { return Object.values(wallets || {}).filter(w => w?.tokens && w.tokens[mint]); }

// Relationship graph for one token: token -> mint authority -> sibling mints; token -> holders ->
// holders that also hold siblings (overlap); token -> early buyers and large swaps.
export function tokenGraph(mint, { universe = {}, wallets = {}, deployers = {}, events = [], labels = {}, earlyN = 10, bigSol = 5 } = {}) {
  const tok = universe[mint] || { mint, symbol: null };
  const auth = authorityOf(mint, deployers), siblings = auth ? Object.keys(auth.mints).filter(m => m !== mint) : [];
  const holders = holdersOf(mint, wallets);
  const overlap = holders.map(w => ({ address: w.address, siblingsHeld: siblings.filter(m => w.tokens[m]).length })).filter(x => x.siblingsHeld > 0);
  const mine = events.filter(e => e.mint === mint).sort((a, b) => a.ts - b.ts || (a.slot || 0) - (b.slot || 0));
  const early = [], seen = new Set();
  for (const e of mine) { if (e.side !== 'BUY' || seen.has(e.wallet)) continue; seen.add(e.wallet); early.push({ wallet: e.wallet, ts: e.ts, sol: num(e.solDelta) === null ? null : Math.abs(e.solDelta) }); if (early.length >= earlyN) break; }
  const big = mine.filter(e => Math.abs(num(e.solDelta) || 0) >= bigSol).sort((a, b) => Math.abs(b.solDelta) - Math.abs(a.solDelta)).slice(0, 20).map(e => ({ wallet: e.wallet, side: e.side, sol: Math.abs(e.solDelta), ts: e.ts, signature: e.signature }));
  // Early buyers of this token who were also early in a sibling token of the same authority.
  const siblingEarly = new Map();
  for (const m of siblings) { const ev = events.filter(e => e.mint === m && e.side === 'BUY').sort((a, b) => a.ts - b.ts); const ws = new Set(); for (const e of ev) { ws.add(e.wallet); if (ws.size >= earlyN) break; } for (const w of ws) siblingEarly.set(w, (siblingEarly.get(w) || 0) + 1); }
  const repeatEarly = early.filter(b => siblingEarly.get(b.wallet)).map(b => ({ wallet: b.wallet, siblingTokensEarly: siblingEarly.get(b.wallet) }));
  const nodes = [{ id: mint, type: 'token', label: tok.symbol || short(mint) }];
  const edges = [];
  if (auth) { nodes.push({ id: auth.address, type: 'mint-authority', label: labels[auth.address]?.label || short(auth.address) }); edges.push({ from: auth.address, to: mint, relation: 'MINT_AUTHORITY_OF' });
    for (const m of siblings.slice(0, 25)) { nodes.push({ id: m, type: 'sibling-token', label: universe[m]?.symbol || short(m) }); edges.push({ from: auth.address, to: m, relation: 'MINT_AUTHORITY_OF' }); } }
  for (const h of holders.slice(0, 25)) { nodes.push({ id: h.address, type: 'holder', label: labels[h.address]?.label || short(h.address) }); edges.push({ from: h.address, to: mint, relation: 'TOP_HOLDER_OBSERVED' }); }
  for (const b of early) { if (!nodes.some(n => n.id === b.wallet)) nodes.push({ id: b.wallet, type: 'early-buyer', label: labels[b.wallet]?.label || short(b.wallet) }); edges.push({ from: b.wallet, to: mint, relation: 'EARLY_BUY' }); }
  const flags = [];
  if (auth && Object.keys(auth.mints).length >= 5) flags.push({ code: 'SERIAL_MINT_AUTHORITY', detail: `This mint authority is recorded on ${Object.keys(auth.mints).length} tokens.` });
  if (auth) flags.push({ code: 'MINT_AUTHORITY_PRESENT', detail: 'A mint authority was observed, so supply may not be fixed. Check whether it has since been revoked.' });
  if (overlap.length >= 3) flags.push({ code: 'HOLDER_OVERLAP', detail: `${overlap.length} top holders also hold other tokens from this authority.` });
  if (repeatEarly.length >= 2) flags.push({ code: 'REPEAT_EARLY_BUYERS', detail: `${repeatEarly.length} early buyers were also early in sibling tokens. This can be coordination, bots or the same trader; it is not proof of either.` });
  return { mint, symbol: tok.symbol || null, firstSeen: tok.firstSeen || null, authority: auth ? { address: auth.address, tokens: Object.keys(auth.mints).length, label: labels[auth.address] || null } : null,
    siblings: siblings.map(m => ({ mint: m, symbol: universe[m]?.symbol || null, firstSeen: universe[m]?.firstSeen || null })), holders: holders.map(h => ({ address: h.address, tokensSeen: h.seen, label: labels[h.address] || null })),
    overlap, early, repeatEarly, bigSwaps: big, nodes, edges, flags, kind: 'OBSERVATION_AND_RULE_BASED_ANALYSIS',
    exchangeFlows: 'UNAVAILABLE (needs exchange wallet attribution)' };
}

// Large swaps across all tokens (whale flow), newest first.
export function whaleFlow(events, { minSol = 10, since = 0, universe = {}, labels = {} } = {}) {
  return (events || []).filter(e => e.ts >= since && Math.abs(num(e.solDelta) || 0) >= minSol)
    .sort((a, b) => b.ts - a.ts).slice(0, 200)
    .map(e => ({ ts: e.ts, wallet: e.wallet, label: labels[e.wallet]?.label || null, side: e.side, sol: Math.abs(e.solDelta), mint: e.mint, symbol: universe[e.mint]?.symbol || null, signature: e.signature }));
}

// Everything observed about one wallet. score: a walletScorecard row, when the wallet has one.
export function walletView(address, { universe = {}, wallets = {}, deployers = {}, events = [], labels = {}, score = null } = {}) {
  const w = wallets[address] || null, auth = Object.values(deployers).find(d => d.address === address) || null;
  const ev = events.filter(e => e.wallet === address).sort((a, b) => b.ts - a.ts);
  const sol = ev.reduce((s, e) => s + (num(e.solDelta) || 0), 0);
  return { address, label: labels[address] || null, holderOf: w ? Object.keys(w.tokens).map(m => ({ mint: m, symbol: universe[m]?.symbol || null })) : [], recurrenceScore: w?.recurrenceScore ?? null,
    mintAuthorityOf: auth ? Object.keys(auth.mints).map(m => ({ mint: m, symbol: universe[m]?.symbol || null })) : [], swaps: ev.slice(0, 50), netSolFromSwaps: ev.length ? Math.round(sol * 1e4) / 1e4 : null, score,
    note: 'Observed on-chain activity only. A wallet may be a person, a bot, a fund or a contract; behaviour is not identity.' };
}
