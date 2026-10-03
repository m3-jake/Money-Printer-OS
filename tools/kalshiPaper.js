import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../src/config.js';
import { routePaperProposal, bookRouteLogger } from '../src/paperRouting.js';

export const KALSHI_PAPER_BOUNDS = Object.freeze({ stakeUsd: { min: 1, max: 500 }, maxOpen: { min: 1, max: 25 } });
const dataDir = () => path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data');
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { mode: 'PAPER', cashUsd: 1000, open: [], history: [] }; } };
export function placeKalshiPaperOrder(order, { file = path.join(dataDir(), 'kalshi-paper.json'), now = Date.now(), mode = cfg.mode } = {}) {
  if(String(mode).toLowerCase()!=='paper')throw new Error('Kalshi paper book refuses non-paper mode');
  const book = read(file), stake = Number(order?.stakeUsd);
  if (!(stake >= 1 && stake <= 500)) throw new Error('Kalshi paper stake must be $1-$500');
  if (book.open.length >= 25) throw new Error('Kalshi paper open position cap reached');
  const row = { id: `kp-${now}-${book.open.length}`, mode: 'PAPER', at: now, ticker: String(order.ticker || ''), side: String(order.side || 'yes').toLowerCase(), stakeUsd: stake, status: 'OPEN' };
  if (!row.ticker || !['yes', 'no'].includes(row.side)) throw new Error('Kalshi paper order needs ticker and yes/no side');
  if(stake>book.cashUsd)throw new Error('Insufficient Kalshi paper cash');
  const assetClass=/^KX(HIGH|LOW)/.test(row.ticker)?'weather':/^KX(NFL|NBA|MLB)/.test(row.ticker)?'sports':'prediction';
  const routed=routePaperProposal({state:book,pick:{ticker:row.ticker,instrumentKey:`kalshi:${row.ticker}:${row.side}`},assetClass,platform:'kalshi',stakeUsd:stake,mode,proposalId:row.id,logger:bookRouteLogger(book)});
  if(!routed.proposal)throw new Error('Central paper route refused the Kalshi proposal');
  row.proposalId=routed.proposal.id;
  row.price=Number(order.price)>0&&Number(order.price)<1?Number(order.price):null;
  book.cashUsd = Number(book.cashUsd || 0) - stake; book.open.push(row); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(book, null, 2)); return row;
}
