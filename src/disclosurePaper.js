import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { initializePaperBook, mutatePaperBook, paperBookStatus, readPaperBook } from './paperBookStore.js';
import { etDate, nextSession } from './robinhoodEquitiesCalendar.js';

export const DISCLOSURE_FILE = path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data', 'disclosure-paper.json');
export const DISCLOSURE_POLICY = Object.freeze({ version: 'form4-open-market-follow.v1', startUsd: 25, stakeUsd: 5, maxOpen: 5, holdMs: 5 * 86400000, processingMs: 1000, maxQuoteAgeMs: 30000, maxSignalAgeMs: 86400000 });
const round = x => Math.round(x * 1e6) / 1e6;
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function disclosureSignals(filings = []) {
  const out = [];
  for (const filing of filings) {
    const facts = filing.facts || {}, form4 = filing.form4 || facts.form4;
    if (facts.form !== '4' || !facts.accession || !(facts.acceptedAt > 0) || !form4) continue;
    const symbol = String(form4.ticker || facts.ticker || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) continue;
    (form4.transactions || []).forEach((t, i) => {
      if (t.code !== 'P' || t.acquired !== true || !(t.shares > 0)) return;
      out.push({ id: `${facts.accession}:${i}`, accession: facts.accession, symbol, availableAt: facts.acceptedAt,
        firstObservedAt: Number(filing.firstObservedAt || filing.observedAt) || null, source: 'sec-edgar-form4', owner: form4.owner || null,
        transactionDate: t.date, insiderComparisonPrice: t.price, transactionCode: t.code });
    });
  }
  return out.sort((a, b) => a.availableAt - b.availableAt || a.id.localeCompare(b.id));
}
export function initializeDisclosurePaper({ file = DISCLOSURE_FILE, now = Date.now() } = {}) {
  return initializePaperBook(file, { schema: 'mpo.disclosure-paper.v1', mode: 'PAPER', startUsd: 25, cashUsd: 25, open: [], history: [],
    createdAt: now, experimentId: `form4-${now}`, policy: { ...DISCLOSURE_POLICY }, policyHash: digest(DISCLOSURE_POLICY),
    qualification: 'UNQUALIFIED_EXPLORATION', funding: [{ at: now, amountUsd: 25, kind: 'INITIAL_CAPITAL' }], decisions: [], status: 'COLLECTING' });
}
export function disclosurePaperView({ file = DISCLOSURE_FILE } = {}) { return paperBookStatus(file); }
function executable(q, side, now, eligibleAt, policy, symbol) {
  const price = Number(q?.[side]), size = Number(q?.[`${side}Size`]), at = Number(q?.observedAt ?? q?.quoteAt);
  if (!q?.provider || q.assetClass !== 'equity') return q?.waitReason || 'PROVIDER_LABELED_EQUITY_QUOTE_REQUIRED';
  if (String(q.symbol || '').toUpperCase() !== symbol) return 'MATCHING_EQUITY_INSTRUMENT_REQUIRED';
  if (q.session !== 'REGULAR_OPEN') return 'WAITING_FOR_REGULAR_SESSION';
  if (!Number.isFinite(at) || at < eligibleAt || at > now || now - at > policy.maxQuoteAgeMs) return 'WAITING_FOR_POST_AVAILABILITY_QUOTE';
  if (!(price > 0) || !(size > 0) || !(Number(q.bid) > 0) || !(Number(q.ask) >= Number(q.bid))) return 'EXECUTABLE_DEPTH_REQUIRED';
  if (q.corporateActionsVerified !== true) return q.waitReason || 'CORPORATE_ACTION_COVERAGE_REQUIRED';
  if (!Number.isFinite(q.feeUsd) || q.feeUsd < 0) return 'EXPLICIT_EQUITY_FEE_MODEL_REQUIRED';
  return null;
}
// quote is a read-only provider adapter. This lane never calls an order API. Unavailable marks stay null.
export async function tickDisclosurePaper({ filings = [], quote = null, secConfigured = false, file = DISCLOSURE_FILE, now = Date.now(), enabled = true } = {}) {
  if (!enabled) return { ran: false, status: 'PAUSED' };
  if (!fs.existsSync(file) && !fs.existsSync(file + '.verified.json')) initializeDisclosurePaper({ file, now });
  const book = readPaperBook(file), policy = book.policy;
  const wait = status => mutatePaperBook(file, b => { b.status = status; b.lastRunAt = now; return { ran: true, status }; }).result;
  if (!quote) return wait('EQUITY_EXECUTION_PROVIDER_REQUIRED');
  mutatePaperBook(file,b=>{
    const date=etDate(now);b.unsettledProceeds=(b.unsettledProceeds||[]).filter(x=>x.settlesOn>date);
    for(const claim of b.dividendReceivables||[])if(!claim.paidAt&&claim.payableDate<=date){b.cashUsd=round(b.cashUsd+claim.amountUsd);claim.paidAt=now}
  });
  // Exits are supervised even when EDGAR contact/data access is temporarily unavailable.
  let exits = 0, entries = 0;
  const decisions = [];
  for (const p of book.open) {
    let q; try { q = await quote(p.symbol, { side: 'SELL', quantity: p.quantity, position:p,eligibleAt: p.openedAt, now }); } catch(error) { q = {waitReason:error.code||'EQUITY_QUOTE_UNAVAILABLE'}; }
    const reason = executable(q, 'bid', now, p.openedAt, policy, p.symbol);
    if (reason) { decisions.push({ at: now, id: p.id, action: 'WAIT_EXIT', reason }); continue; }
    mutatePaperBook(file, b => {
      const live = b.open.find(x => x.id === p.id); if (!live) return;
      live.corporateActions||=[];
      for(const action of q.corporateActions||[]){
        const prior=live.corporateActions.find(a=>a.id===action.id);
        if(prior){if(digest(prior)!==digest(action))throw Object.assign(new Error('Corporate action revision requires reconciliation'),{code:'CORPORATE_ACTION_REVISION'});continue}
        if(action.type==='SPLIT'){if(!(action.ratio>0)||!Number.isFinite(action.ratio))throw new Error('Invalid split ratio');live.quantity*=action.ratio}
        else if(action.type==='CASH_DIVIDEND'){
          const amountUsd=round(live.quantity*action.amountPerShare);live.dividendAccruedUsd=round((live.dividendAccruedUsd||0)+amountUsd);
          const claim={id:`${live.id}:${action.id}`,positionId:live.id,actionId:action.id,amountUsd,payableDate:action.payableDate,paidAt:null};
          if(action.payableDate<=etDate(now)){b.cashUsd=round(b.cashUsd+amountUsd);claim.paidAt=now}(b.dividendReceivables||=[]).push(claim);
        }else throw new Error('Unsupported corporate action');
        live.corporateActions.push(action);
      }
      live.markBid = q.bid; live.markAt = q.observedAt ?? q.quoteAt; live.markValueUsd = round(live.quantity * q.bid - q.feeUsd);
      if (now - live.openedAt < policy.holdMs || q.bidSize < live.quantity) return;
      const proceeds = round(live.quantity * q.bid - q.feeUsd); if (proceeds < 0) return;
      b.cashUsd = round(b.cashUsd + proceeds);const settlesOn=nextSession(etDate(now));if(settlesOn)(b.unsettledProceeds||=[]).push({positionId:live.id,amountUsd:proceeds,settlesOn});b.history.unshift({ ...live, status: 'SOLD', payoutUsd: proceeds, exitFeeUsd: q.feeUsd, exitProvider: q.provider, pnlUsd: round(proceeds+(live.dividendAccruedUsd||0)-live.costUsd), closedAt: now, exitQuoteAt: q.observedAt ?? q.quoteAt });
      b.open = b.open.filter(x => x.id !== live.id); exits++;
    });
  }
  if (secConfigured) for (const signal of disclosureSignals(filings).slice(-100)) {
    const current = readPaperBook(file);
    if ((current.receipts || []).some(r => r.id === signal.id)) continue;
    const seenAt = signal.firstObservedAt;
    if (!seenAt || seenAt < signal.availableAt || now - seenAt > policy.maxSignalAgeMs || seenAt > now) { decisions.push({ at: now, id: signal.id, action: 'SKIP', reason: 'FRESH_FIRST_OBSERVATION_REQUIRED' }); continue; }
    const eligibleAt = Math.max(signal.availableAt, seenAt) + policy.processingMs;
    const buyingPower=current.cashUsd-(current.unsettledProceeds||[]).reduce((sum,x)=>sum+x.amountUsd,0);
    if (now < eligibleAt || current.open.length >= policy.maxOpen || buyingPower < 1) continue;
    let q; try { q = await quote(signal.symbol, { side: 'BUY', notionalUsd: policy.stakeUsd, eligibleAt, now }); } catch(error) { q = {waitReason:error.code||'EQUITY_QUOTE_UNAVAILABLE'}; }
    const reason = executable(q, 'ask', now, eligibleAt, policy, signal.symbol);
    if (reason) { decisions.push({ at: now, id: signal.id, action: 'WAIT_ENTRY', reason }); continue; }
    const budget = Math.min(buyingPower, policy.stakeUsd), step = q.fractional === true ? Number(q.quantityStep || .000001) : 1;
    const quantity = Math.floor((budget - q.feeUsd) / q.ask / step) * step;
    if (!(quantity > 0) || !(step > 0) || quantity > q.askSize) { decisions.push({ at: now, id: signal.id, action: 'WAIT_ENTRY', reason: 'SMALL_BANK_OR_DEPTH_UNAVAILABLE' }); continue; }
    mutatePaperBook(file, b => {
      const costUsd = round(quantity * q.ask + q.feeUsd);
      if (costUsd > b.cashUsd-(b.unsettledProceeds||[]).reduce((sum,x)=>sum+x.amountUsd,0) || b.open.length >= policy.maxOpen) throw Object.assign(new Error('disclosure entry budget changed; retry intent'), { code: 'RETRY_ENTRY' });
      b.cashUsd = round(b.cashUsd - costUsd); b.open.push({ id: signal.id, ...signal, quantity, costUsd, feeUsd: q.feeUsd, entryAsk: q.ask,
        entryQuoteAt: q.observedAt ?? q.quoteAt, decisionAt: now, openedAt: now, provider: q.provider, status: 'OPEN', experimentId: b.experimentId, policyHash: b.policyHash }); entries++;
    }, { receiptId: signal.id });
  }
  return mutatePaperBook(file, b => { b.lastRunAt = now; b.status = !secConfigured ? 'SEC_USER_AGENT_REQUIRED' : b.cashUsd < 1 && !b.open.length ? 'EXHAUSTED' : b.open.length ? 'EXPLORING' : 'COLLECTING'; b.decisions = [...decisions, ...(b.decisions || [])].slice(0, 200); return { ran: true, status: b.status, entries, exits }; }).result;
}
