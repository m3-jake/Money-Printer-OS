// Original, bounded XML extraction for SEC 13F research. No executable backtest prices are inferred.
import { createHash } from 'node:crypto';
const sha = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const decode = s => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const tag = (xml, name) => decode((String(xml).match(new RegExp(`<(?:(?:[\\w.-]+):)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:(?:[\\w.-]+):)?${name}\\s*>`, 'i')) || [])[1] || '').trim();
const number = text => text !== '' && Number.isFinite(Number(text.replace(/,/g, ''))) ? Number(text.replace(/,/g, '')) : null;
function checked(xml) { const s = String(xml || ''); if (Buffer.byteLength(s) > 16 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(s)) throw new Error('Unsupported or oversized 13F XML'); return s; }
const date = s => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/); return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
};
export function parse13FCover(xml) {
  const s = checked(xml), isAmendment = /^(true|1)$/i.test(tag(s, 'isAmendment'));
  const amendmentType = tag(s, 'amendmentType').toUpperCase();
  return { reportPeriod: date(tag(s, 'reportCalendarOrQuarter')), isAmendment, amendmentNumber: number(tag(s, 'amendmentNo')),
    amendmentType: isAmendment ? amendmentType === 'RESTATEMENT' ? 'RESTATEMENT' : /NEW HOLDINGS|ADDS NEW/.test(amendmentType) ? 'NEW_HOLDINGS' : 'UNKNOWN' : null,
    reportType: tag(s, 'reportType') || null, managerName: tag(s, 'name') || null, reportedEntryCount: number(tag(s, 'tableEntryTotal')),
    reportedTableValue: number(tag(s, 'tableValueTotal')) };
}
export function parse13FInformationTable(xml, { acceptedAt = null, valueUnit = null } = {}) {
  const s = checked(xml), rows = [], skipped = [];
  // SEC switched the XML/UI convention on 2023-01-03. Unknown dates keep dollar amounts unknown.
  const unit = valueUnit || (Number.isFinite(acceptedAt) && acceptedAt > 0 ? acceptedAt >= Date.parse('2023-01-03T00:00:00Z') ? 'USD' : 'USD_THOUSANDS' : null);
  for (const m of s.matchAll(/<(?:(?:[\w.-]+):)?infoTable(?:\s[^>]*)?>([\s\S]*?)<\/(?:(?:[\w.-]+):)?infoTable\s*>/gi)) {
    if (rows.length + skipped.length >= 20000) throw Object.assign(new Error('13F table exceeds bounded research row limit'), { code: 'TABLE_TRUNCATED' });
    const x = m[1], cusip = tag(x, 'cusip').toUpperCase(), shares = number(tag(x, 'sshPrnamt')), value = number(tag(x, 'value'));
    if (!/^[A-Z0-9*@#]{9}$/.test(cusip) || shares === null || shares < 0 || value === null || value < 0) { skipped.push({ index: rows.length + skipped.length, reason: 'INVALID_CUSIP_OR_AMOUNTS' }); continue; }
    rows.push({ issuer: tag(x, 'nameOfIssuer'), titleOfClass: tag(x, 'titleOfClass'), cusip, shares, shareType: tag(x, 'sshPrnamtType').toUpperCase(),
      putCall: tag(x, 'putCall').toUpperCase() || null, investmentDiscretion: tag(x, 'investmentDiscretion'), otherManager: tag(x, 'otherManager') || null,
      reportedValue: value, valueUnit: unit, valueUsd: unit === 'USD' ? value : unit === 'USD_THOUSANDS' ? value * 1000 : null,
      votingAuthority: { sole: number(tag(x, 'Sole')), shared: number(tag(x, 'Shared')), none: number(tag(x, 'None')) } });
  }
  return { rows, skipped, complete: skipped.length === 0 && /<(?:[\w.-]+:)?informationTable[\s>]/i.test(s), valueUnit: unit, contentHash: sha(s) };
}
export function form13FSnapshot({ facts = {}, coverXml, tableXml = [], firstObservedAt = null, valueUnit = null } = {}) {
  const cover = parse13FCover(coverXml), acceptedAt = Number(facts.acceptedAt), observedAt = Number(firstObservedAt), tables = tableXml.map(xml => parse13FInformationTable(xml, { acceptedAt, valueUnit }));
  const rows = tables.flatMap(t => t.rows);
  const complete = /^13F-HR(?:\/A)?$/.test(facts.form||'') && !!facts.accession && /^\d+$/.test(String(facts.cik)) && !!cover.reportPeriod && tables.length > 0 && tables.every(t => t.complete) && (cover.reportedEntryCount === null || cover.reportedEntryCount === rows.length);
  return { schema: 'mpo.sec-13f-research.v1', kind: 'DISCLOSED_HOLDINGS_RESEARCH', mode: 'RESEARCH_ONLY', executionEvidence: false,
    managerCik: String(facts.cik || '').replace(/^0+/, ''), accession: facts.accession || null, form: facts.form || null, ...cover,
    availableAt: Number.isFinite(acceptedAt) && acceptedAt > 0 ? acceptedAt : null, firstObservedAt: Number.isFinite(observedAt) && observedAt >= acceptedAt ? observedAt : null,
    snapshotId: `${facts.cik || 'unknown'}:${cover.reportPeriod || 'unknown'}:${facts.accession || 'unknown'}`, complete, rows,
    tables: tables.map(({ rows, ...t }) => ({ ...t, rowCount: rows.length })), contentHash: sha({ coverXml, tableXml }),
    limitations: ['Delayed public holdings, not observed manager trades', 'CUSIP is not an executable ticker mapping', 'Raw share changes may reflect splits or other corporate actions', 'Confidential/omitted holdings are not inferred'] };
}
const holdingKey = r => [r.cusip, r.titleOfClass, r.shareType, r.putCall || ''].join('|');
function aggregate(rows) {
  const map = new Map();
  for (const r of rows) { const key = holdingKey(r), prev = map.get(key); map.set(key, prev ? { ...prev, shares: prev.shares + r.shares, valueUsd: prev.valueUsd === null || r.valueUsd === null ? null : prev.valueUsd + r.valueUsd } : { ...r, key }); }
  return map;
}
export function holdings13FAsOf(snapshots, { managerCik, reportPeriod, asOf } = {}) {
  const visible = snapshots.filter(s => s.managerCik === String(managerCik).replace(/^0+/, '') && s.reportPeriod === reportPeriod && s.complete && s.availableAt > 0 && s.availableAt <= asOf && s.accession)
    .sort((a, b) => a.availableAt - b.availableAt || a.accession.localeCompare(b.accession));
  let rows = null, availableAt = null; const accessions = [], seen = new Set();
  for (const s of visible) {
    if (seen.has(s.accession)) continue; seen.add(s.accession);
    if (!s.isAmendment || s.amendmentType === 'RESTATEMENT') rows = s.rows;
    else if (s.amendmentType === 'NEW_HOLDINGS' && rows) rows = [...rows, ...s.rows];
    else return { available: false, reason: 'AMENDMENT_IDENTITY_OR_BASE_MISSING', accessions };
    availableAt = s.availableAt; accessions.push(s.accession);
  }
  return rows ? { available: true, managerCik, reportPeriod, asOf, availableAt, accessions, rows: [...aggregate(rows).values()], mode: 'RESEARCH_ONLY', executionEvidence: false } : { available: false, reason: 'NO_PUBLIC_COMPLETE_HOLDINGS_AS_OF', accessions };
}
export function holdings13FChanges(previous, current) {
  if (!previous?.available || !current?.available || previous.managerCik !== current.managerCik || !(previous.reportPeriod < current.reportPeriod)) return { available: false, reason: 'COMPARABLE_PUBLIC_QUARTERS_REQUIRED', changes: [] };
  const a = aggregate(previous.rows), b = aggregate(current.rows), changes = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const p = a.get(key), c = b.get(key), before = p?.shares || 0, after = c?.shares || 0;
    changes.push({ key, cusip: (c || p).cusip, issuer: (c || p).issuer, shareType: (c || p).shareType, putCall: (c || p).putCall,
      previousShares: before, disclosedShares: after, rawShareChange: after - before, changeKind: !p ? 'NEW_DISCLOSED_HOLDING' : !c ? 'NO_LONGER_DISCLOSED' : after > before ? 'INCREASE' : after < before ? 'DECREASE' : 'UNCHANGED',
      availableAt: Math.max(previous.availableAt, current.availableAt), executable: false, corporateActionAdjusted: false });
  }
  return { available: true, mode: 'RESEARCH_ONLY', previousPeriod: previous.reportPeriod, currentPeriod: current.reportPeriod, availableAt: Math.max(previous.availableAt,current.availableAt), changes, contentHash: sha({ previous, current }) };
}
