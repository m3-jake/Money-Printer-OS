import { isAggressivePaper } from './runtime.js';
import { estimateAggressivePaperExecution } from './executionSimAggressive.js';
import { loadBook, saveBook } from './robinhoodEquitiesBook.js';
import { routePaperProposal, bookRouteLogger } from './paperRouting.js';

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;
export function paperEquityOrder({ symbol, side, quantity, price, mode = process.env.MODE || 'paper', runtime = {} } = {}) {
  if (String(mode).toLowerCase() !== 'paper') throw new Error('Robinhood equities adapter refuses non-paper mode');
  const ticker = String(symbol || '').toUpperCase(), action = String(side || '').toUpperCase(), qty = Number(quantity), px = Number(price);
  if (!SYMBOL.test(ticker) || /-(USD|USDT|USDC)$/.test(ticker)) throw new Error('Equities and ETF ticker required');
  if (!['BUY', 'SELL'].includes(action) || !(qty > 0) || !(px > 0)) throw new Error('Valid paper equity order required');
  const aggressive = isAggressivePaper(runtime, mode);
  const execution = aggressive ? estimateAggressivePaperExecution({ liq: px * qty, executionScore: 90 }, qty * px / 200, 200) : { slippageBps: 2, feeBps: 0, executionModel: 'ROBINHOOD_PAPER' };
  return { mode: 'PAPER', symbol: ticker, side: action, quantity: qty, referencePrice: px, estimatedSlippageBps: execution.slippageBps, feeBps: execution.feeBps, executionModel: execution.executionModel };
}

export function recordEquityPaperOrder(order, { dataDir, mode = process.env.MODE || 'paper', runtime = {} } = {}) {
  const normalized = paperEquityOrder({ ...order, mode, runtime }), book = loadBook(dataDir);
  if (book.recoveryRequired) throw new Error('Robinhood equities paper book requires recovery');
  const routed=routePaperProposal({state:book,pick:{symbol:normalized.symbol,instrumentKey:`equity:${normalized.symbol}`},assetClass:'equity',platform:'robinhood',stakeUsd:normalized.quantity*normalized.referencePrice,mode,runtime,logger:bookRouteLogger(book)});
  if(!routed.proposal)throw new Error('Central paper route refused the equity proposal');
  normalized.proposalId=routed.proposal.id;
  book.paperOrders ||= []; book.paperOrders.push({ ...normalized, at: Date.now() });
  if (book.paperOrders.length > 2000) book.paperOrders.splice(0, book.paperOrders.length - 2000);
  saveBook(dataDir, book); return normalized;
}
