import { stableId } from './model.js';

// A new paper generation gets a new mirror account; old entries remain append-only.
// Never turn missing history, a changed clock, or a cash discrepancy into a deposit.
export function solanaResetEvidence(book,{priorDeposit,priorBookId=null,mirrored=new Map(),lastLedgerAt=0,venue='solana-paper'}={}) {
  if(!priorDeposit||String(book.mode||'PAPER').toUpperCase()!=='PAPER')return null;
  const history=book.history||[],positions=book.positions||[],trades=[...history,...positions];
  const start=Number(book.paperStartSol),cash=Number(book.cashSol);
  const expected=start+history.reduce((n,t)=>n+Number(t.pnlSol),0)
    +positions.reduce((n,t)=>n-Number(t.remainingSol)+Number(t.realizedSol||0),0);
  if(!(start>0)||!Number.isFinite(cash)||!Number.isFinite(expected)||Math.abs(expected-cash)>1e-8)return null;
  const ids=trades.map(t=>String(t.id||''));
  if(ids.some(id=>!id)||new Set(ids).size!==ids.length)return null;
  if(ids.some(id=>mirrored.has(stableId('Instrument',venue,id))))return null;
  const currentId=typeof book.paperBookId==='string'?book.paperBookId:null;
  if(currentId&&priorBookId&&currentId!==priorBookId)return 'explicit paper book generation changed';
  if(!trades.length&&mirrored.size)return 'empty paper reset observed at the verified starting balance';
  const amountsChanged=Math.round(start*1e6)!==Number(priorDeposit.gross_units);
  const laterTrades=trades.length>0&&trades.every(t=>Number.isSafeInteger(t.openedAt)&&t.openedAt>lastLedgerAt);
  const explicitLaterReset=currentId&&Number.isSafeInteger(book.paperBookStartedAt)&&book.paperBookStartedAt>lastLedgerAt;
  if(!priorBookId&&(amountsChanged&&(laterTrades||!trades.length)||explicitLaterReset))
    return 'new paper generation verified by disjoint later trades, starting balance and cash identity';
  return null;
}

export function solanaSourceIntegrity(book) {
  const history=book.history||[],positions=book.positions||[],trades=[...history,...positions];
  const cash=Number(book.cashSol),start=Number(book.paperStartSol);
  const expected=start+history.reduce((n,t)=>n+Number(t.pnlSol),0)+positions.reduce((n,t)=>n-Number(t.remainingSol)+Number(t.realizedSol||0),0);
  const identityVerified=start>0&&Number.isFinite(cash)&&Number.isFinite(expected)&&Math.abs(cash-expected)<=1e-8;
  return {source:'AUTHORITATIVE_PAPER_BOOK',cashSol:Number.isFinite(cash)?cash:null,
    identityVerified,identityDifference:identityVerified?cash-expected:null,
    postingHistoryComplete:trades.every(t=>t.paperCashCoverage==='COMPLETE_FROM_ENTRY'&&Array.isArray(t.paperCashEvents)&&t.paperCashEvents.length>0),
    note:'Current paper balance arithmetic is separate from proof of historical execution timing; this snapshot creates no ledger funding or trades.'};
}
