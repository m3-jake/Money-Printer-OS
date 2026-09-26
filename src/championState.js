// One reading of an Evolution Lab champion's lifecycle state, shared by every module the Lab feeds
// (Solana lab-link/champion.json, <module>-champion.json for robinhood and polymarket-combo).
//
//   INCUBATOR -> SHADOW -> PAPER -> LIVE
//
// Fail closed: a record with no state, an unknown state, or a newer state schema reads as SHADOW
// (signals may be logged, nothing is paper traded). LIVE never grants real money here: real-money
// execution is forbidden by policy, so a LIVE record is treated exactly like PAPER.
export const ChampionState = Object.freeze({ INCUBATOR: 'INCUBATOR', SHADOW: 'SHADOW', PAPER: 'PAPER', LIVE: 'LIVE' });
export const CHAMPION_STATE_SCHEMA = 'mpo.champion-state.v1';
const RANK = { INCUBATOR: 0, SHADOW: 1, PAPER: 2, LIVE: 3 };

// Accepts the top-level doc; the state may sit on the doc or on its champion/candidate.
export function championState(doc) {
  if (!doc || typeof doc !== 'object') return { state: ChampionState.INCUBATOR, declared: null, reason: 'missing' };
  const raw = doc.state ?? doc.champion?.state ?? doc.candidate?.state;
  if (raw === undefined || raw === null) return { state: ChampionState.SHADOW, declared: null, reason: 'noState' };
  if (doc.stateSchema !== undefined && doc.stateSchema !== CHAMPION_STATE_SCHEMA) return { state: ChampionState.SHADOW, declared: String(raw), reason: 'unknownSchema' };
  const s = String(raw).toUpperCase();
  if (!(s in RANK)) return { state: ChampionState.SHADOW, declared: String(raw), reason: 'unknownState' };
  return { state: s, declared: s, reason: null };
}

// Paper trading needs both the lifecycle (PAPER or higher) and the Lab's existing paper-review gate.
export function championPaperAllowed(doc) {
  if (doc?.paperPromotionAllowed !== true) return false;
  return RANK[championState(doc).state] >= RANK.PAPER;
}
