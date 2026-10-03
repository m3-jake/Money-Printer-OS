// EDGAR radar. SEC requires every automated request to declare who is asking (a User-Agent with a
// contact email: https://www.sec.gov/os/accessing-edgar-data). MPOS never invents or borrows one:
// set SEC_USER_AGENT="Your Name you@example.com". Without it EDGAR is NOT CONFIGURED.
//
// Facts vs analysis are kept apart in every record:
//   facts     what the filer declared to the SEC: form, company, CIK, accession, acceptance time (the
//             moment the filing became public, used as availableAt), 8-K item numbers, Form 4 rows.
//   analysis  MPOS's rule-based reading (catalyst labels, related contracts). Always labelled, never
//             merged into facts; no language model is involved.

import { form13FSnapshot } from './form13F.js';
export { parse13FCover, parse13FInformationTable, form13FSnapshot, holdings13FAsOf, holdings13FChanges } from './form13F.js';
export const FORMS = Object.freeze(['8-K', '10-Q', '10-K', '4', '4/A', '13F-HR', '13F-HR/A', '13F-NT', 'SC 13D', 'SC 13G', 'SCHEDULE 13D', 'SCHEDULE 13G']);
// Official Form 8-K item list (sec.gov/fast-answers/answersform8khtm).
export const ITEMS_8K = Object.freeze({
  '1.01': 'Entry into a material definitive agreement', '1.02': 'Termination of a material definitive agreement', '1.03': 'Bankruptcy or receivership', '1.04': 'Mine safety',
  '1.05': 'Material cybersecurity incident', '2.01': 'Completion of acquisition or disposition of assets', '2.02': 'Results of operations and financial condition', '2.03': 'Creation of a direct financial obligation',
  '2.04': 'Triggering events that accelerate a financial obligation', '2.05': 'Costs associated with exit or disposal activities', '2.06': 'Material impairments', '3.01': 'Notice of delisting or transfer',
  '3.02': 'Unregistered sales of equity securities', '3.03': 'Material modification to rights of security holders', '4.01': "Change in registrant's certifying accountant", '4.02': 'Non-reliance on previously issued financial statements',
  '5.01': 'Change in control of registrant', '5.02': 'Departure/election of directors or officers; compensation', '5.03': 'Amendments to articles or bylaws; fiscal year change', '5.07': 'Submission of matters to a vote of security holders',
  '7.01': 'Regulation FD disclosure', '8.01': 'Other events', '9.01': 'Financial statements and exhibits',
});
// Rule-based catalyst labels (ANALYSIS). Kept deliberately coarse.
const CATALYST = { '2.02': 'EARNINGS', '1.01': 'MATERIAL_AGREEMENT', '2.01': 'M&A', '5.01': 'CHANGE_OF_CONTROL', '5.02': 'EXECUTIVE_CHANGE', '3.02': 'DILUTION', '2.03': 'FINANCING', '1.03': 'BANKRUPTCY',
  '4.02': 'RESTATEMENT', '3.01': 'DELISTING', '2.06': 'IMPAIRMENT', '1.05': 'CYBER_INCIDENT', '2.05': 'RESTRUCTURING' };
export const FORM4_CODES = Object.freeze({ P: 'Open-market purchase', S: 'Open-market sale', A: 'Grant/award', M: 'Option exercise', F: 'Tax withholding', G: 'Gift', D: 'Disposition to issuer', C: 'Conversion' });

export function userAgent(env = process.env) { const ua = String(env.SEC_USER_AGENT || '').trim(); return /\S+@\S+\.\S+/.test(ua) ? ua : null; }
export const pad10 = cik => String(cik).replace(/\D/g, '').padStart(10, '0');

// data.sec.gov submissions JSON -> filing facts (most recent first).
export function filingsFromSubmissions(sub, { forms = FORMS, limit = 50 } = {}) {
  const r = sub?.filings?.recent; if (!r || !Array.isArray(r.accessionNumber)) return [];
  const out = [], cik = String(sub.cik ?? '').replace(/^0+/, ''), ticker = Array.isArray(sub.tickers) ? sub.tickers[0] || null : null;
  for (let i = 0; i < r.accessionNumber.length && out.length < limit; i++) {
    const form = r.form[i]; if (!forms.includes(form)) continue;
    const acc = r.accessionNumber[i], accepted = Date.parse(r.acceptanceDateTime?.[i] || '');
    const items = String(r.items?.[i] || '').split(',').map(s => s.trim()).filter(Boolean);
    out.push({ facts: { form, company: sub.name || null, cik, ticker, accession: acc, filedOn: r.filingDate?.[i] || null, acceptedAt: Number.isFinite(accepted) ? accepted : null,
      items: items.map(code => ({ code, name: ITEMS_8K[code] || 'Unlisted item' })), primaryDocument: r.primaryDocument?.[i] || null,
      // Form 4 primary documents point at an XSL rendering; the raw XML sits one folder up.
      rawXmlUrl: /^(4|13F-HR)(\/A)?$/.test(form) && /\.xml$/i.test(r.primaryDocument?.[i] || '') ? `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/${String(r.primaryDocument[i]).replace(/^xsl[^/]+\//, '')}` : null,
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/${r.primaryDocument?.[i] || ''}`, indexUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/${acc}-index.htm` } });
  }
  return out;
}

// Latest-filings Atom feed (browse-edgar getcurrent) -> filing facts.
export function filingsFromAtom(xml) {
  const out = [], text = String(xml || '');
  const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  for (const m of text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1], tag = n => (e.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)) || [])[1] || '';
    const title = decode(tag('title')).trim(), t = title.match(/^(.+?) - (.+?) \((\d{10})\)/);
    if (!t) continue;
    const summary = decode(tag('summary')), acc = (summary.match(/AccNo:<\/b>\s*([\d-]+)/) || e.match(/accession-number=([\d-]+)/) || [])[1] || null;
    const items = [...summary.matchAll(/Item (\d\.\d\d)/g)].map(x => x[1]);
    const href = (e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || null, updated = Date.parse(tag('updated'));
    out.push({ facts: { form: t[1].trim(), company: t[2].trim(), cik: t[3].replace(/^0+/, ''), ticker: null, accession: acc, filedOn: (summary.match(/Filed:<\/b>\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || null,
      acceptedAt: Number.isFinite(updated) ? updated : null, items: [...new Set(items)].map(code => ({ code, name: ITEMS_8K[code] || 'Unlisted item' })), primaryDocument: null, url: href ? decode(href) : null, indexUrl: href ? decode(href) : null } });
  }
  return out;
}

// Form 4 ownership XML -> transaction rows (facts). Regex parsing of the documented schema; no deps.
export function parseForm4(xml) {
  const text = String(xml || ''), val = (s, n) => (s.match(new RegExp(`<${n}>\\s*(?:<value>)?\\s*([^<]*?)\\s*(?:</value>)?\\s*</${n}>`)) || [])[1] ?? null;
  const owner = val(text, 'rptOwnerName'), role = [['isDirector', 'Director'], ['isOfficer', 'Officer'], ['isTenPercentOwner', '10% owner']].filter(([k]) => /^(1|true)$/i.test(val(text, k) || '')).map(([, r]) => r);
  const title = val(text, 'officerTitle'), issuer = val(text, 'issuerName'), ticker = val(text, 'issuerTradingSymbol');
  const rows = [];
  for (const m of text.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)) {
    const t = m[1], code = val(t, 'transactionCode'), shares = Number(val(t, 'transactionShares')), price = Number(val(t, 'transactionPricePerShare'));
    rows.push({ date: val(t, 'transactionDate'), code, meaning: FORM4_CODES[code] || 'Other', shares: Number.isFinite(shares) ? shares : null, price: Number.isFinite(price) && price > 0 ? price : null,
      acquired: val(t, 'transactionAcquiredDisposedCode') === 'A', sharesAfter: Number(val(t, 'sharesOwnedFollowingTransaction')) || null });
  }
  return { issuer, ticker, owner, roles: title ? [...role, title] : role, transactions: rows };
}

// Rule-based analysis attached next to (never inside) the facts.
export function analyseFiling(f, contracts = []) {
  const catalysts = [...new Set((f.facts.items || []).map(i => CATALYST[i.code]).filter(Boolean))];
  if (f.facts.form === '4') catalysts.push('INSIDER_TRANSACTION');
  if (/13[DG]$/.test(f.facts.form)) catalysts.push('OWNERSHIP_STAKE');
  if (f.facts.form === '10-K' || f.facts.form === '10-Q') catalysts.push('PERIODIC_REPORT');
  const name = String(f.facts.company || '').replace(/[,.]|\b(inc|corp|corporation|co|ltd|plc|holdings|group|company)\b/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const tick = String(f.facts.ticker || '').toLowerCase();
  const related = name.length >= 4 || tick.length >= 2 ? contracts.filter(c => { const t = String(c.data?.title || '').toLowerCase(); return (name.length >= 4 && t.includes(name)) || (tick.length >= 2 && new RegExp(`\\b${tick.replace(/[.-]/g, '\\$&')}\\b`).test(t)); }).slice(0, 10).map(c => ({ id: c.id, venue: c.provider, title: c.data.title })) : [];
  return { kind: 'RULE_BASED_ANALYSIS', catalysts, relatedAssets: f.facts.ticker ? [f.facts.ticker] : [], relatedMarkets: related,
    note: 'Catalyst labels map filer-declared item numbers; related markets are title matches among loaded contracts. Not investment advice.' };
}

export class EdgarSource {
  constructor({ fetchImpl = globalThis.fetch, env = process.env } = {}) { this.fetch = fetchImpl; this.env = env; this.cache = new Map(); this.lastRequest = 0; this.health = { status: 'IDLE', lastSuccess: null, lastError: null }; }
  status() { return { id: 'sec-edgar', ...this.health, status: userAgent(this.env) ? this.health.status : 'NOT CONFIGURED', note: userAgent(this.env) ? null : 'Set SEC_USER_AGENT="Your Name you@example.com" (SEC fair-access policy).' }; }
  async #get(url, { ttlMs = 300000, as = 'json' } = {}) {
    const ua = userAgent(this.env); if (!ua) throw Object.assign(new Error('EDGAR needs SEC_USER_AGENT="Your Name you@example.com" (SEC requires a declared contact)'), { code: 'NO_KEY' });
    const hit = this.cache.get(url); if (hit && Date.now() - hit.at < ttlMs) return hit.data;
    // SEC allows at most 10 requests per second; stay well below.
    const wait = this.lastRequest + 150 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait)); this.lastRequest = Date.now();
    try {
      const r = await this.fetch(url, { headers: { 'User-Agent': ua, accept: as === 'json' ? 'application/json' : '*/*' }, signal: AbortSignal.timeout?.(15000) });
      if (!r.ok) throw Object.assign(new Error(`SEC HTTP ${r.status}`), { code: r.status === 403 ? 'AUTH_ERROR' : r.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR' });
      const data = as === 'json' ? await r.json() : await r.text();
      this.cache.set(url, { at: Date.now(), data }); if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
      this.health = { status: 'CONNECTED', lastSuccess: Date.now(), lastError: null }; return data;
    } catch (e) { this.health = { ...this.health, status: e.code === 'AUTH_ERROR' ? 'AUTH ERROR' : e.code === 'RATE_LIMITED' ? 'DEGRADED' : 'DISCONNECTED', lastError: e.code || 'NETWORK_ERROR' }; throw e; }
  }
  async tickers() { const j = await this.#get('https://www.sec.gov/files/company_tickers.json', { ttlMs: 86400000 }); const map = new Map(); for (const v of Object.values(j || {})) map.set(String(v.ticker).toUpperCase(), { cik: String(v.cik_str), name: v.title }); return map; }
  async company(ticker) { const t = (await this.tickers()).get(String(ticker).toUpperCase()); if (!t) throw new Error(`Unknown ticker ${ticker}`); return this.#get(`https://data.sec.gov/submissions/CIK${pad10(t.cik)}.json`); }
  async latest(form = '8-K') { if (!FORMS.includes(form)) throw new Error('Unsupported form'); return filingsFromAtom(await this.#get(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(form)}&count=40&output=atom`, { ttlMs: 120000, as: 'text' })); }
  async document(url) { if (!/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//.test(String(url))) throw new Error('SEC Archives URL required'); return this.#get(url, { ttlMs: 86400000, as: 'text' }); }
  async form4(url) { if (!/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//.test(url) || !/\.xml$/i.test(url)) throw new Error('Form 4 XML URL required'); return parseForm4(await this.#get(url, { ttlMs: 86400000, as: 'text' })); }
  async form13F(filing, { firstObservedAt = Date.now() } = {}) {
    const facts = filing?.facts || filing;
    if (!/^13F-HR(?:\/A)?$/.test(facts?.form || '') || !/^\d+$/.test(String(facts.cik)) || !/^\d{10}-\d{2}-\d{6}$/.test(String(facts.accession))) throw new Error('13F-HR filing identity required');
    const base = `https://www.sec.gov/Archives/edgar/data/${String(facts.cik).replace(/^0+/, '')}/${facts.accession.replace(/-/g, '')}/`;
    const listing = await this.#get(base + 'index.json', { ttlMs: 86400000 });
    const names = (listing?.directory?.item || []).map(x => x.name).filter(n => /^[\w.-]+\.xml$/i.test(String(n)));
    if (names.length > 20) throw Object.assign(new Error('13F XML discovery exceeds bounded document budget'), { code: 'DOCUMENT_BUDGET' });
    const primary = String(facts.primaryDocument || '').replace(/^xsl[^/]+\//, '');
    const ordered = [...new Set([...(names.includes(primary) ? [primary] : []), ...names])];
    let coverXml = null; const tableXml = [];
    for (const name of ordered) {
      const xml = await this.document(base + name);
      if (/<(?:[\w.-]+:)?informationTable[\s>]/i.test(xml)) tableXml.push(xml);
      else if (/<(?:[\w.-]+:)?reportCalendarOrQuarter[\s>]/i.test(xml)) coverXml = xml;
    }
    if (!coverXml || !tableXml.length) throw Object.assign(new Error('13F cover or information table unavailable; notice-only filings are not holdings'), { code: 'NO_COMPLETE_13F_TABLE' });
    return form13FSnapshot({ facts, coverXml, tableXml, firstObservedAt });
  }
}
