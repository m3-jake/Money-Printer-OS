import { randomUUID } from 'node:crypto';
const PROPOSAL_TTL_MS = 90_000;

export function expireProposals(s) {
  const now = Date.now();
  for (const p of s.proposals || []) {
    if (p.status === 'PENDING' && now - (p.updatedAt || p.createdAt || now) > PROPOSAL_TTL_MS) {
      p.status = 'EXPIRED'; p.resolvedAt = now;
    }
  }
}

export function proposeTrade(s, pick, sizeSol) {
  s.proposals ||= []; expireProposals(s);
  const existing = s.proposals.find(x => x.kind === 'ENTRY' && x.mint === pick.mint && x.status === 'PENDING');
  if (existing) { existing.updatedAt=Date.now();existing.score=pick.fastEdgeScore||pick.score;existing.sizeSol=sizeSol;return existing; }
  const p={id:`proposal-entry-${Date.now()}-${randomUUID()}`,kind:'ENTRY',status:'PENDING',createdAt:Date.now(),updatedAt:Date.now(),expiresAt:Date.now()+PROPOSAL_TTL_MS,mint:pick.mint,symbol:pick.symbol,name:pick.name,sizeSol,score:pick.fastEdgeScore||pick.score,explosionScore:pick.explosionScore,moonScore:pick.moonScore,rugScore:pick.rugScore,riskScore:pick.risk?.score,executionScore:pick.executionScore,engine:'UNIFIED_EDGE',dominantSignal:pick.dominantSignal,warnings:pick.warnings||[],reasons:pick.reasons||[]};
  s.proposals.unshift(p);s.proposals=s.proposals.slice(0,100);return p;
}

export function proposeExit(s, position, fraction, reason, price) {
  s.proposals ||= []; expireProposals(s);
  const existing=s.proposals.find(x=>x.kind==='EXIT'&&x.positionId===position.id&&x.status==='PENDING');
  if(existing){existing.updatedAt=Date.now();existing.fraction=fraction;existing.reason=reason;existing.price=price;return existing;}
  const p={id:`proposal-exit-${Date.now()}-${position.mint.slice(0,5)}`,kind:'EXIT',status:'PENDING',createdAt:Date.now(),updatedAt:Date.now(),expiresAt:Date.now()+PROPOSAL_TTL_MS,positionId:position.id,mint:position.mint,symbol:position.symbol,fraction:Number(fraction||1),reason,price:Number(price||0),engine:'UNIFIED_EDGE'};
  s.proposals.unshift(p);s.proposals=s.proposals.slice(0,100);return p;
}

export function resolveProposal(s, id, status) {
  expireProposals(s);const p=(s.proposals||[]).find(x=>x.id===id);if(p&&p.status==='PENDING'){p.status=status;p.resolvedAt=Date.now();}return p;
}
