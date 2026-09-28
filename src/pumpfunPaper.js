import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { isAggressivePaper } from './runtime.js';
import { createSniper } from './pumpfunSniper.js';
import { createNativePaperAdapter } from './pumpfunNativePaper.js';
import { simulateAggressivePaperExecution } from './executionSimAggressive.js';
import { proposeTrade } from './proposals.js';
import { appendJournal } from './store.js';

export function createPumpfunPaperLane({ adapter = createNativePaperAdapter(), dataDir = process.env.MONEY_PRINTER_DATA_DIR || 'data', now = Date.now, logger = appendJournal, simulator = simulateAggressivePaperExecution } = {}) {
  const file = path.resolve(dataDir, 'pumpfun-sniper-paper.json'), decide = createSniper();
  let queue = Promise.resolve(), pending = 0, lastMarkAt = 0;
  function read() {
    if (!fs.existsSync(file)) return { mode: 'PAPER', cashSol: cfg.paperStartSol, open: [], history: [], proposals: [] };
    const b = JSON.parse(fs.readFileSync(file));
    if (b.mode !== 'PAPER' || !Number.isFinite(b.cashSol) || b.cashSol < 0 || !Array.isArray(b.open) || !Array.isArray(b.history)) throw new Error('Invalid sniper paper account');
    return b;
  }
  function write(b) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(b, null, 2)); fs.renameSync(tmp, file); }
  function serialize(fn) {
    if (pending >= 32) return Promise.reject(new Error('Paper launch queue is full'));
    pending++; const result = queue.then(fn); queue = result.catch(() => {}).finally(() => pending--); return result;
  }
  const networkCost = q => q.plan ? (q.plan.priorityFeeLamports + q.plan.signatureFeeLamports + q.plan.jito.tipLamports) / 1e9 : .000005;
  async function onLaunch(event, { runtime, mode = 'paper', solUsd } = {}) {
    if (!isAggressivePaper(runtime, mode)) return { accepted: false, reason: 'aggressive-paper-required', orderSubmitted: false };
    return serialize(async () => {
      const decision = decide(event, { runtime, mode });
      if (!decision.accepted) return decision;
      if (!(Number(solUsd) > 0)) return { accepted: false, reason: 'sol-price-unavailable', orderSubmitted: false };
      const book = read(), exposure = book.open.reduce((sum, p) => sum + p.basisSol, 0);
      const size = Math.min(3, decision.requestedSizeSol, Math.min(10, Number(runtime.paperOverrides?.maxTotalExposureSol || 10)) - exposure, Math.max(0, book.cashSol - cfg.minSolReserve - .00002) / 1.001);
      if (book.open.length >= 25 || size < .005 || book.open.some(p => p.mint === event.mint)) return { accepted: false, reason: 'paper-budget-or-open-cap', orderSubmitted: false };
      const quote = await adapter.quote({ mint: event.mint, user: event.user, action: 'BUY', sizeSol: size, runtime, mode });
      const at = now(), candidate = { ...event, priceUsd: quote.priceSolPerRaw * solUsd, priceObservedAt: quote.observedAt, liq: quote.liquiditySol * solUsd, executionScore: 90 };
      const proposal = proposeTrade(book, { ...candidate, symbol: event.symbol || 'NEW', dominantSignal: 'pumpfun:sniper' }, size);
      const sim = simulator(candidate, size, solUsd, { now: at, seed: `native-paper:${event.mint}:${event.slot}` });
      const cost = Number(sim.gross || 0) + Number(sim.feeSol || 0) + networkCost(quote);
      const raw = Math.floor(Number(sim.filledQuantity || 0));
      if (sim.status === 'REJECTED' || !(raw > 0) || cost > book.cashSol - cfg.minSolReserve) {
        proposal.status = 'REJECTED'; write(book); logger({ type: 'pumpfun-paper-reject', mint: event.mint, reason: sim.reason || 'paper-cash-reserve', orderSubmitted: false });
        return { accepted: false, reason: sim.reason || 'paper-cash-reserve', orderSubmitted: false };
      }
      const p = { id: proposal.id, proposalId: proposal.id, mode: 'PAPER', mint: event.mint, user: event.user, symbol: event.symbol || 'NEW', strategy: 'PUMPFUN_SNIPER', source: 'pumpfun:sniper', openedAt: at,
        rawAmount: String(raw), basisSol: sim.gross, costSol: cost, entryPriceSolPerRaw: cost / raw, plan: quote.plan, quoteSource: quote.source, execution: sim, orderSubmitted: false };
      proposal.status = 'PAPER_SIMULATED'; book.cashSol -= cost; book.open.push(p); write(book);
      logger({ type: 'trade-open', mode: 'PAPER', ...p, sizeSol: p.basisSol, nativeQuote: quote, orderSubmitted: false });
      return { accepted: true, position: p, orderSubmitted: false };
    });
  }
  async function maintain({ runtime, mode = 'paper', solUsd } = {}) {
    if (!isAggressivePaper(runtime, mode) || !(solUsd > 0) || now() - lastMarkAt < 15000) return { ordersSubmitted: 0 };
    lastMarkAt = now();
    return serialize(async () => {
      const book = read(), errors = []; let closed = 0;
      for (const p of [...book.open].slice(0, 4)) {
        try {
          const q = await adapter.quote({ mint: p.mint, user: p.user, action: 'SELL', rawAmount: p.rawAmount, runtime, mode });
          const net = q.solAmount - networkCost(q), change = (net / p.costSol - 1) * 100;
          const reason = change >= cfg.takeProfit1Pct ? 'take-profit' : change <= -cfg.stopLossPct ? 'stop-loss' : now() - p.openedAt >= cfg.maxHoldMin * 60000 ? 'max-hold' : null;
          if (!reason) continue;
          const candidate = { mint: p.mint, priceUsd: q.priceSolPerRaw * solUsd, priceObservedAt: q.observedAt, liq: Number(q.liquiditySol || q.solAmount) * solUsd, executionScore: 90 };
          const sim = simulator(candidate, q.solAmount, solUsd, { side: 'SELL', now: now(), seed: `native-paper-exit:${p.id}:${Math.floor(now() / 15000)}` });
          const credit = Number(sim.gross || 0) - Number(sim.feeSol || 0) - networkCost(q);
          if (sim.status === 'REJECTED' || credit <= 0) continue;
          const trade = { ...p, closedAt: now(), pnlSol: credit - p.costSol, returnPct: (credit / p.costSol - 1) * 100, reason, exitPlan: q.plan, orderSubmitted: false };
          book.cashSol += credit; book.open = book.open.filter(x => x.id !== p.id); book.history.unshift(trade); book.history = book.history.slice(0, 1000); write(book);
          logger({ type: 'trade-close', mode: 'PAPER', trade }); closed++;
        } catch (e) { errors.push(String(e.message)); }
      }
      return { closed, errors, ordersSubmitted: 0 };
    });
  }
  return { onLaunch, maintain, view: read, file };
}
let singleton;
export function pumpfunPaperLane() { return singleton ||= createPumpfunPaperLane(); }
