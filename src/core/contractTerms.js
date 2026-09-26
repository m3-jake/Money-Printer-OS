import { fingerprint } from './model.js';

// Structured settlement terms for prediction-market contracts, extracted from venue text.
// Extraction is heuristic, so an automatic match can reach STRONG MATCH at most. EXACT MATCH needs a
// human attestation bound to a fingerprint of both contracts' rule text (see termsFingerprint), and
// that attestation stops applying as soon as either venue changes its rules.
//
// Propositions supported: GAME_WINNER, SPREAD (side wins by more than a line), TOTAL (combined
// score over a line). Anything else is OTHER and can only ever be RELATED.

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const text = v => (typeof v === 'string' ? v : '');
const day = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// Team/player names: lowercase words without punctuation. "St." -> "state"; "(OH)" -> "oh".
export function normName(v) {
  return text(v).toLowerCase().replace(/&/g, ' and ').replace(/\bst\.(?=\s|$)/g, 'state').replace(/[^a-z0-9]+/g, ' ').trim();
}
// Same side when one name's words are all in the other (e.g. "atlanta" / "atlanta braves").
// Requires at least one word; "miami" vs "miami oh" also passes here, which is why a match also
// needs the opponent and the date, and never reaches EXACT without a human.
export function sameName(a, b) {
  const x = normName(a).split(' ').filter(Boolean), y = normName(b).split(' ').filter(Boolean);
  if (!x.length || !y.length) return false;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  // A trailing one-letter word is a venue abbreviation ("Chicago C", "New York Y"): it matches the
  // word in the same position that starts with that letter, after identical leading words.
  const last = s.length - 1;
  if (s[last].length === 1 && last > 0) return s.slice(0, last).every((w, j) => l[j] === w) && !!l[last]?.startsWith(s[last]);
  return s.every(w => l.includes(w));
}

// Game date from rule text ("scheduled for Sep 26, 2026", "September 26 at 3:30PM", "on 2026-09-26").
export function gameDay(str, fallbackYear) {
  const s = text(str);
  const iso = s.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = s.match(/scheduled for ([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (20\d\d))?/i);
  if (m) { const mo = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith('sept') ? 4 : 3)]; const y = Number(m[3] || fallbackYear); if (mo !== undefined && y) return day(y, mo, Number(m[2])); }
  return null;
}

// Participants from rule or event text. A name is up to six capitalised words, plus a trailing
// "(OH)"-style qualifier; lowercase words end it, so "If X wins the A vs B" yields A and B only.
const WORD = "[\\p{Lu}\\p{N}][\\p{L}\\p{N}.'&-]*";
const NAME = `${WORD}(?: (?:\\([A-Z]{1,4}\\)|${WORD}|of|de|del|la)){0,5}?`; // lazy: "IND Colts", not "IND Colts Pro Football"
const PARTICIPANT_PATTERNS = [
  new RegExp(`between (?:the )?(${NAME}) and (?:the )?(${NAME})(?=,| in | scheduled|\\.|:)`, 'u'),
  new RegExp(`\\bthe (${NAME}) vs\\.? (${NAME})(?= [a-z]|,| Pro | MLB| NFL| NBA| WNBA| NHL| ATP| WTA| UEFA| TT)`, 'u'),
  new RegExp(`^(?:[\\p{L}\\p{N}' -]{1,30}: )?(${NAME}) vs\\.? (${NAME})(?= \\(| -|:|$)`, 'u'),
];
export function participants(str) {
  const s = text(str);
  for (const re of PARTICIPANT_PATTERNS) { const m = s.match(re); if (m) return [m[1].trim(), m[2].trim()]; }
  return null;
}

function scopeOf(s) {
  const t = text(s).toLowerCase();
  const period = t.match(/\b([1-4])(?:st|nd|rd|th)? ?q(?:uarter)?\b|\b(1st|2nd|3rd|4th) quarter\b|\b(first|second) half\b/);
  if (period) return 'PERIOD:' + (period[1] || period[2] || period[3]).replace(/st|nd|rd|th/, '');
  if (/after 90 minutes|90 minutes plus stoppage|regulation time|reg time|not including overtime|excluding overtime/.test(t)) return 'REGULATION';
  if (/including (overtime|extra time)|extra time periods|overtime (is|are|will be) included|including any overtime/.test(t)) return 'INCLUDING_OT';
  return null;
}
function cancellationOf(s) {
  const t = text(s).toLowerCase();
  if (/50-50|fifty-fifty|resolve to 50/.test(t)) return 'SPLIT_50_50';
  if (/cancel\w* .{0,80}resolve (to )?"?no/.test(t)) return 'RESOLVES_NO';
  if (/cancel\w* .{0,120}(settle|resolve)\w* .{0,40}(last traded|fair) price/.test(t)) return 'FAIR_PRICE';
  return null;
}
const sourceOf = s => { const m = text(s).match(/https?:\/\/(?:www\.)?([^/\s"]+)/i); return m ? m[1].toLowerCase() : null; };

// Extract a proposition from a normalized Contract's data (normalizeKalshi / normalizePolymarket).
export function extractTerms(d = {}) {
  const venue = d.venue, rules = [d.settlementRules, d.secondaryRules].map(text).join(' '), title = text(d.title);
  const year = d.expiresAt ? new Date(d.expiresAt).getUTCFullYear() : null;
  const t = { venue, type: 'OTHER', teams: null, side: null, line: null, stat: null, scope: scopeOf(`${title} ${rules}`), day: gameDay(`${title} ${rules}`, year),
    yesMeans: null, cancellation: cancellationOf(rules), resolutionSource: sourceOf(d.resolutionSource) || sourceOf(rules), missing: [] };
  t.teams = participants(rules) || participants(d.eventTitle) || participants(title);
  const yes = venue === 'polymarket' && Array.isArray(d.outcomes) && d.outcomes.length === 2 && !d.outcomes.every(o => /^(yes|no)$/i.test(String(o))) ? String(d.outcomes[0]) : null;
  let m;
  if ((m = rules.match(/If ([^,]+?) wins by more than ([\d.]+) (points|runs|goals)/i)) || (m = title.match(/^(.+?) wins(?: \dQ)? by (?:over|more than) ([\d.]+) (points|runs|goals)/i))) {
    Object.assign(t, { type: 'SPREAD', side: m[1].replace(/^the /i, '').trim(), line: Number(m[2]), stat: m[3].toLowerCase() });
  } else if ((m = title.match(/^Spread: (.+?) \(-([\d.]+)\)/i))) {
    Object.assign(t, { type: 'SPREAD', side: m[1].trim(), line: Number(m[2]), stat: (rules.match(/by \d+ or more (points|runs|goals)/i) || [])[1]?.toLowerCase() || null });
    if (yes && !sameName(yes, t.side)) t.yesMeans = 'OTHER_SIDE';
  } else if ((m = title.match(/O\/U ([\d.]+)/i)) || (m = rules.match(/(?:collectively score|are scored|combine to score) (?:more than|over) ([\d.]+) (points|runs|goals)/i)) || (m = title.match(/^(?:Will )?over ([\d.]+) (?:\dQ )?(points|runs|goals)/i))) {
    Object.assign(t, { type: 'TOTAL', line: Number(m[1]), stat: (m[2] || (rules.match(/(points|runs|goals)/i) || [])[1] || '').toLowerCase() || null });
    if (yes && !/^over$/i.test(yes)) t.yesMeans = 'UNDER';
  } else if ((m = title.match(/^Will (.+?) win(?: on [\d-]+)?\?$/i)) || (m = rules.match(/If ([^,]+?) wins(?: the)? /i)) || (m = title.match(/^(.+?) wins$/i))) {
    Object.assign(t, { type: 'GAME_WINNER', side: m[1].trim() });
  } else if (yes && t.teams && t.teams.some(p => sameName(p, yes))) {
    Object.assign(t, { type: 'GAME_WINNER', side: yes });
  }
  if (/\btie\b|draw/i.test(t.side || '')) t.type = 'OTHER';
  for (const k of ['teams', 'day', 'scope', 'cancellation', 'resolutionSource']) if (!t[k]) t.missing.push(k);
  if (['SPREAD', 'GAME_WINNER'].includes(t.type) && !t.side) t.missing.push('side');
  if (['SPREAD', 'TOTAL'].includes(t.type) && !Number.isFinite(t.line)) t.missing.push('line');
  return t;
}

const sameTeams = (a, b) => a && b && ((sameName(a[0], b[0]) && sameName(a[1], b[1])) || (sameName(a[0], b[1]) && sameName(a[1], b[0])));

// Compare two contracts' propositions. orientation SAME: YES on A pays when YES on B pays.
// INVERTED: YES on A pays when NO on B pays (e.g. Polymarket's first outcome is the other team).
export function matchTerms(a, b) {
  const reasons = [], risks = [];
  const out = (classification, orientation = null) => ({ classification, orientation, reasons, residualRisks: risks, termsA: a, termsB: b });
  if (a.type === 'OTHER' || b.type === 'OTHER') { reasons.push('PROPOSITION_NOT_EXTRACTED'); return out('RELATED'); }
  if (a.type !== b.type) { reasons.push('DIFFERENT_PROPOSITION_TYPE'); return out('NOT EQUIVALENT'); }
  if (!sameTeams(a.teams, b.teams)) { // Names that don't match ("Kansas City" vs "Chiefs") may still be the same team; this fails safe.
    reasons.push(a.teams && b.teams ? 'PARTICIPANTS_DO_NOT_MATCH_BY_NAME' : 'PARTICIPANTS_UNKNOWN'); return out(a.teams && b.teams ? 'NOT EQUIVALENT' : 'RELATED'); }
  if (!a.day || !b.day) { reasons.push('GAME_DATE_UNKNOWN'); return out('RELATED'); }
  if (a.day !== b.day) { reasons.push('DIFFERENT_GAME_DATE'); return out('NOT EQUIVALENT'); }
  if (a.scope && b.scope && a.scope !== b.scope) { reasons.push('DIFFERENT_SCOPE'); return out('NOT EQUIVALENT'); }
  if (!a.scope || !b.scope) risks.push('SCOPE_UNVERIFIED (overtime / extra time / period handling)');
  if (a.type !== 'TOTAL' && a.side && b.side && !sameName(a.side, b.side)) {
    // Winner markets on the two teams are complements only when no draw is possible; don't assume it.
    reasons.push('DIFFERENT_SIDE'); return out('RELATED');
  }
  if (a.type !== 'GAME_WINNER' && a.line !== b.line) { reasons.push('DIFFERENT_LINE'); return out('RELATED'); }
  if (a.stat && b.stat && a.stat !== b.stat) { reasons.push('DIFFERENT_STAT'); return out('NOT EQUIVALENT'); }
  if (Number.isInteger(a.line) || Number.isInteger(b.line)) risks.push('INTEGER_LINE_PUSH_HANDLING_UNVERIFIED');
  if (!a.cancellation || !b.cancellation) risks.push('CANCELLATION_TERMS_UNVERIFIED');
  else if (a.cancellation !== b.cancellation) risks.push(`CANCELLATION_DIFFERS (${a.cancellation} vs ${b.cancellation})`);
  if (a.resolutionSource && b.resolutionSource && a.resolutionSource !== b.resolutionSource) risks.push(`RESOLUTION_SOURCE_DIFFERS (${a.resolutionSource} vs ${b.resolutionSource})`);
  const flipped = !!a.yesMeans !== !!b.yesMeans;
  return out('STRONG MATCH', flipped ? 'INVERTED' : 'SAME');
}

// Everything a human attests to when marking a pair EXACT. Any venue edit changes it.
export function termsFingerprint(d = {}) {
  return fingerprint({ venue: d.venue ?? null, title: d.title ?? null, outcomes: d.outcomes ?? null, rules: d.settlementRules ?? null, secondary: d.secondaryRules ?? null, source: d.resolutionSource ?? null, expiresAt: d.expiresAt ?? null });
}

// Candidate pairs across two venues among already-loaded contracts. Cheap prefilter on game date
// and participants, then the full match. Returns STRONG MATCH and RELATED-with-same-teams pairs.
export function candidatePairs(left = [], right = [], { limit = 50 } = {}) {
  const R = right.map(c => ({ c, t: extractTerms(c.data) })).filter(x => x.t.teams && x.t.day);
  const out = [];
  for (const l of left) {
    const lt = extractTerms(l.data);
    if (!lt.teams || !lt.day) continue;
    for (const r of R) {
      if (r.t.day !== lt.day || !sameTeams(lt.teams, r.t.teams)) continue;
      const m = matchTerms(lt, r.t);
      if (m.classification === 'STRONG MATCH' || (m.classification === 'RELATED' && m.reasons.includes('DIFFERENT_LINE'))) out.push({ a: l.id, b: r.c.id, aTitle: l.data.title, bTitle: r.c.data.title, classification: m.classification, orientation: m.orientation, reasons: m.reasons, residualRisks: m.residualRisks });
    }
  }
  return out.sort((x, y) => (x.classification === 'STRONG MATCH' ? 0 : 1) - (y.classification === 'STRONG MATCH' ? 0 : 1)).slice(0, limit);
}
