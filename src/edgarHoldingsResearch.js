import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomicSync } from './atomicRename.js';
import { holdings13FAsOf, holdings13FChanges } from './core/form13F.js';
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function build13FResearchCorpus(snapshots = [], { asOf = Date.now() } = {}) {
  const visible = snapshots.filter(s => s.schema === 'mpo.sec-13f-research.v1' && s.availableAt > 0 && s.availableAt <= asOf);
  const managers = [...new Set(visible.map(s => s.managerCik))].filter(Boolean), cohorts = [], waits = [];
  for (const managerCik of managers) {
    const periods = [...new Set(visible.filter(s => s.managerCik === managerCik).map(s => s.reportPeriod))].filter(Boolean).sort();
    const latest = holdings13FAsOf(visible, { managerCik, reportPeriod: periods.at(-1), asOf });
    if (!latest.available) { waits.push({ managerCik, reason: latest.reason }); continue; }
    const previous = periods.length > 1 ? holdings13FAsOf(visible, { managerCik, reportPeriod: periods.at(-2), asOf }) : null;
    const changes = holdings13FChanges(previous, latest);
    const ordinary = latest.rows.filter(r => r.shareType === 'SH' && !r.putCall);
    const valueComplete = ordinary.every(r => r.valueUsd !== null), total = valueComplete ? ordinary.reduce((sum, r) => sum + r.valueUsd, 0) : null;
    const holdings = ordinary.map(r => ({ key: r.key, cusip: r.cusip, issuer: r.issuer, disclosedShares: r.shares, valueUsd: r.valueUsd,
      disclosedWeight: total > 0 ? r.valueUsd / total : null, availableAt: latest.availableAt, ticker: null, executable: false }));
    cohorts.push({ managerCik, reportPeriod: latest.reportPeriod, availableAt: latest.availableAt, accessions: latest.accessions, holdings,
      disclosedValueUsd: total, maxHoldingWeight: total > 0 ? Math.max(0, ...holdings.map(h => h.disclosedWeight)) : null,
      changes: changes.changes, changeReason: changes.available ? null : changes.reason, mode: 'RESEARCH_ONLY', qualificationEffect: 'NONE' });
  }
  const identities = visible.map(s => ({ snapshotId: s.snapshotId, accession: s.accession, contentHash: s.contentHash, availableAt: s.availableAt, firstObservedAt: s.firstObservedAt, complete: s.complete }));
  return { schema: 'mpo.edgar-holdings-corpus.v1', asOf, source: 'sec-edgar', mode: 'RESEARCH_ONLY', executionEvidence: false,
    availableSnapshots: identities.length, distinctManagerQuarters: new Set(visible.map(s => `${s.managerCik}:${s.reportPeriod}`)).size,
    cohorts, waits, identities, corpusHash: digest(identities), limitations: ['CUSIP/ticker mapping and quote credentials required before any forward experiment', 'Reported share changes are not corporate-action-adjusted', 'Public filing dates replace quarter-end availability'] };
}
export function record13FResearch(snapshot, { dataDir = process.env.MONEY_PRINTER_DATA_DIR || 'data', now = Date.now() } = {}) {
  if (snapshot?.schema !== 'mpo.sec-13f-research.v1' || !snapshot.accession || !(snapshot.availableAt > 0) || snapshot.availableAt > now) throw new Error('Public 13F snapshot identity required');
  const file = path.resolve(dataDir, 'sec-edgar', '13f-research.json');
  let stored = { schema: 'mpo.edgar-13f-store.v1', snapshots: [] };
  if (fs.existsSync(file)) {
    if (fs.statSync(file).size > 32 * 1024 * 1024) throw Object.assign(new Error('13F research store exceeds bounded read budget'), { code: 'RESEARCH_CAPACITY' });
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (stored.schema !== 'mpo.edgar-13f-store.v1' || !Array.isArray(stored.snapshots)) throw new Error('13F research evidence requires recovery');
  }
  const previous = stored.snapshots.find(s => s.accession === snapshot.accession);
  if (previous && previous.contentHash !== snapshot.contentHash) throw Object.assign(new Error('Same-accession 13F revision requires reconciliation; prior evidence preserved'), { code: 'RESEARCH_REVISION' });
  if (!previous) {
    if (stored.snapshots.length >= 500) throw Object.assign(new Error('13F research snapshot capacity reached; archive evidence before adding'), { code: 'RESEARCH_CAPACITY' });
    stored.snapshots.push(snapshot);
    const bytes = JSON.stringify(stored);
    if (Buffer.byteLength(bytes) > 32 * 1024 * 1024) throw Object.assign(new Error('13F research byte capacity reached'), { code: 'RESEARCH_CAPACITY' });
    writeFileAtomicSync(file, bytes);
  }
  const corpus = build13FResearchCorpus(stored.snapshots, { asOf: now });
  writeFileAtomicSync(path.resolve(dataDir, 'lab-link', 'edgar-13f-research.json'), JSON.stringify(corpus));
  return { snapshot: previous || snapshot, corpus, duplicate: !!previous, file };
}
