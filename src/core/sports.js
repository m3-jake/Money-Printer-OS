import { extractTerms, sameName, normName } from './contractTerms.js';

// Canonical sports events. Contracts from every venue about the same game (same sport family, game
// day and participants) are clustered into one SportsEvent, so Kalshi and Polymarket prices and the
// live state live in one place instead of one copy per module.
// Live state comes only from official public feeds (MLB Stats API, NHL web API). Other sports show
// market prices only; nothing is inferred from prices about the score.

const KALSHI_SPORT = [[/^KXMLB/, 'MLB'], [/^KXNFL/, 'NFL'], [/^KXNCAAF/, 'NCAAF'], [/^KXNCAA(M|B)/, 'NCAAB'], [/^KXWNBA/, 'WNBA'], [/^KXNBA/, 'NBA'], [/^KXNHL/, 'NHL'],
  [/^KXATP/, 'ATP'], [/^KXWTA/, 'WTA'], [/^KXTT/, 'TABLE_TENNIS'], [/^KX(MLS|EPL|UEFA|LALIGA|SERIEA|BUNDES|LIGUE|CONCACAF|COPA|FIFA|UCL|EFL)/, 'SOCCER'], [/^KXUFC/, 'UFC'],
  [/^KX(LOL|CS|DOTA|VALORANT)/, 'ESPORTS']];
const POLY_DOMAIN = [[/mlb\.com/, 'MLB'], [/nfl\.com/, 'NFL'], [/ncaa\.com/, 'NCAA'], [/wnba\.com/, 'WNBA'], [/nba\.com/, 'NBA'], [/nhl\.com/, 'NHL'], [/atptour\.com/, 'ATP'], [/wtatennis\.com/, 'WTA'],
  [/uefa\.com|fifa\.com|premierleague|laliga|mlssoccer|concacaf|bundesliga|legaseriea|ligue1/, 'SOCCER'], [/ufc\.com/, 'UFC'], [/hltv\.org|gol\.gg|liquipedia|lolesports|vlr\.gg/, 'ESPORTS'], [/ittf|tabletennis/, 'TABLE_TENNIS']];
// Grouping family: college leagues are one family because Polymarket's ncaa.com covers several.
export const familyOf = sport => (/^NCAA/.test(sport || '') ? 'NCAA' : sport || null);
export const FAST_SETTLING = new Set(['ATP', 'WTA', 'TABLE_TENNIS']);

export function sportOf(contract) {
  const d = contract?.data || {};
  if (d.venue === 'kalshi') { const s = String(d.seriesTicker || ''); for (const [re, sp] of KALSHI_SPORT) if (re.test(s)) return sp; return null; }
  const src = `${d.resolutionSource || ''} ${d.settlementRules || ''}`.toLowerCase();
  for (const [re, sp] of POLY_DOMAIN) if (re.test(src)) return sp;
  return null;
}

const sameTeams = (a, b) => a && b && ((sameName(a[0], b[0]) && sameName(a[1], b[1])) || (sameName(a[0], b[1]) && sameName(a[1], b[0])));
const longer = (a, b) => (normName(b).length > normName(a).length ? b : a);
const mid = d => (d.yesBid !== null && d.yesAsk !== null && d.yesAsk >= d.yesBid ? (d.yesBid + d.yesAsk) / 2 : null);

export function buildSportsEvents(contracts) {
  const events = [];
  for (const c of contracts) {
    const sport = sportOf(c); if (!sport) continue;
    const t = extractTerms(c.data); if (!t.teams || !t.day) continue;
    const fam = familyOf(sport);
    let ev = events.find(e => e.family === fam && e.day === t.day && sameTeams(e.participants, t.teams));
    if (!ev) { ev = { family: fam, sport, day: t.day, participants: [...t.teams], contracts: [], fastSettling: FAST_SETTLING.has(sport) }; events.push(ev); }
    else { if (sameName(ev.participants[0], t.teams[0])) ev.participants = [longer(ev.participants[0], t.teams[0]), longer(ev.participants[1], t.teams[1])]; else ev.participants = [longer(ev.participants[0], t.teams[1]), longer(ev.participants[1], t.teams[0])]; if (ev.sport !== sport && sport !== 'NCAA') ev.sport = sport; }
    ev.contracts.push({ id: c.id, venue: c.provider, sourceId: c.sourceId, title: c.data.title, type: t.type, side: t.side, line: t.line, yesMeans: t.yesMeans, yesMid: mid(c.data), closeAt: c.data.closeAt ?? null,
      conditionId: c.data.conditionId ?? null, slug: c.data.slug ?? null,
      tokenIds: c.data.tokenIds ?? [], yesToken: c.data.yesToken ?? null, noToken: c.data.noToken ?? null });
  }
  for (const ev of events) {
    ev.id = `${ev.family}:${ev.day}:${ev.participants.map(normName).sort().join('|')}`;
    // Winner prices per venue and participant. A named-outcome market's NO side is the other team.
    ev.winner = ev.participants.map(p => ({ participant: p, venues: {} }));
    for (const k of ev.contracts.filter(x => x.type === 'GAME_WINNER' && x.yesMid !== null)) {
      const i = ev.participants.findIndex(p => sameName(p, k.side)); if (i < 0) continue;
      ev.winner[i].venues[k.venue] = k.yesMid;
      if (k.venue === 'polymarket' && ev.participants.length === 2 && ev.winner[1 - i].venues.polymarket === undefined) ev.winner[1 - i].venues.polymarketComplement = Math.round((1 - k.yesMid) * 1000) / 1000;
    }
    ev.venues = [...new Set(ev.contracts.map(x => x.venue))];
  }
  return events.sort((a, b) => a.day.localeCompare(b.day) || a.family.localeCompare(b.family));
}

export function mlbLive(json) {
  return (json?.dates || []).flatMap(d => d.games || []).map(g => ({ feed: 'MLB Stats API', sport: 'MLB', gameId: String(g.gamePk), participants: [g.teams?.away?.team?.name, g.teams?.home?.team?.name], start: Date.parse(g.gameDate) || null,
    state: g.status?.detailedState || null, final: g.status?.abstractGameState === 'Final', score: [g.teams?.away?.score ?? null, g.teams?.home?.score ?? null],
    period: g.linescore?.currentInning ? `${g.linescore.inningHalf || ''} ${g.linescore.currentInning}`.trim() : null }));
}
export function nhlLive(json) {
  return (json?.games || []).map(g => ({ feed: 'NHL web API', sport: 'NHL', gameId: String(g.id), participants: [`${g.awayTeam?.placeName?.default || ''} ${g.awayTeam?.name?.default || ''}`.trim(), `${g.homeTeam?.placeName?.default || ''} ${g.homeTeam?.name?.default || ''}`.trim()],
    start: Date.parse(g.startTimeUTC) || null, state: g.gameState || null, final: /FINAL|OFF/.test(g.gameState || ''), score: [g.awayTeam?.score ?? null, g.homeTeam?.score ?? null],
    period: g.periodDescriptor?.number ? `P${g.periodDescriptor.number}${g.clock?.timeRemaining ? ' ' + g.clock.timeRemaining : ''}` : null }));
}
// Attach live games to events of the same family and day by participant names.
export function attachLive(events, live, day) {
  for (const g of live) {
    const ev = events.find(e => e.family === g.sport && e.day === day && sameTeams(e.participants, g.participants.map(String)));
    if (ev) ev.live = { ...g, orientation: sameName(ev.participants[0], g.participants[0]) ? 'SAME' : 'SWAPPED' };
  }
  return events;
}
