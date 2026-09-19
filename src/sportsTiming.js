// Estimated playing time only; settlement can lag the final whistle.
export const TURNOVER_TARGET_MINUTES = 15;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export function clockMinutes(value) {
 const s=String(value??'').trim();
 const m=s.match(/^(\d{1,3})(?::(\d{2}))?(?:\s*\+\s*(\d{1,2}))?['′]?$/);
 return m?Number(m[1])+Number(m[2]||0)/60+Number(m[3]||0):null;
}
export function lateGameEstimate(m={},live={}) {
 const period=String(live.period||'').trim().toUpperCase();
 const text=[m.event,m.slug,m.type,live.leagueAbbreviation].filter(Boolean).join(' ').toLowerCase();
 const elapsed=clockMinutes(live.elapsed);
 const wait=reason=>({nearEndScore:0,etaMinutes:null,reason,priorityBonus:0});
 const late=(eta,reason,priorityBonus=0)=>({nearEndScore:94,etaMinutes:eta,reason,priorityBonus});
 if(live.ended||/suspended|delayed|postponed|cancel|finished|final$/i.test(String(live.status||''))||/^(FT|END|SUS|HT|MID)\b/.test(period))return wait('not actively finishing');
 // Baseball is handled first: BOT must never match OT.
 if(/\b(mlb|baseball)\b/.test(text)||/^(TOP|BOT|BOTTOM)\b/.test(period)) {
  const inning=Number(period.match(/\d+/)?.[0]);
  return inning>=9?late(15,'ninth inning or later; estimate only'):wait('baseball before ninth inning');
 }
 const table=/table.?tennis|ping.?pong|\b(ittf|wtt|tt)\b/.test(text);
 const tennis=table||/tennis|\b(wta|atp|itf)\b/.test(text);
 if(tennis) {
  const bestOf=Number((text+' '+period+' '+String(live.score||'')).match(/\b(?:bo|best.of)\s*([357])\b/i)?.[1])||(/\bwta\b|women/.test(text)?3:0);
  const setNumber=Number(period.match(/SET\s*(\d+)|(\d+)(?:ST|ND|RD|TH)?\s*SET/)?.slice(1).find(Boolean));
  const pairs=[...String(live.score||'').matchAll(/(\d{1,2})\s*[-:]\s*(\d{1,2})/g)].map(x=>[Number(x[1]),Number(x[2])]);
  const current=pairs.at(-1);
  const explicitFinal=/FINAL SET|DECIDING SET/.test(period)||(bestOf&&setNumber===bestOf);
  let canFinish=!!explicitFinal;
  if(bestOf&&current&&pairs.length>1) {
   const prior=pairs.slice(0,-1),leader=current[0]>=current[1]?0:1;
   const wins=prior.filter(x=>x[leader]>x[1-leader]).length;
   canFinish ||= wins===Math.floor(bestOf/2);
  }
  if(!canFinish)return wait('tennis needs a confirmed potential closing set');
  if(/\bMATCH POINT\b/.test(period))return late(3,'match point',40);
  if(!current)return wait('tennis closing-set score unavailable');
  const high=Math.max(...current),low=Math.min(...current);
  if(table&&high>=9&&high<=30)return late(5,'table tennis closing set, nine-plus points',45);
  if(!table&&/\bTIE.?BREAK\b/.test(period))return late(8,'closing-set tiebreak',40);
  if(!table&&high>=5&&high<=7&&low<=7)return late(12,'tennis closing set, five-plus games',35);
  return wait('closing set still too early');
 }
 if(/\b(OT|OVERTIME|PENALTIES|PENALTY SHOOTOUT)\b/.test(period)) {
  if(/basket|nba|wnba|hockey|nhl/.test(text)&&(elapsed==null||elapsed<=5))return late(12,'confirmed overtime');
  if(/PENALT/.test(period))return late(8,'penalty shootout');
  return wait('overtime duration uncertain');
 }
 if(/^(Q4|4Q|4TH QUARTER)$/.test(period))return elapsed!=null&&elapsed<=3?late(Math.max(5,elapsed*3+3),'final quarter, three minutes or less'):wait('final quarter needs a late clock');
 if(/^(P3|3P|3RD PERIOD|PERIOD 3)$/.test(period)&&/nhl|hockey/.test(text))return elapsed!=null&&elapsed<=5?late(elapsed*2+3,'final period, five minutes or less'):wait('hockey needs a late clock');
 const halfSpecific=/first_half|halftime_result|soccer_halftime/.test(String(m.type||''));
 if(halfSpecific&&/^(1H|H1|FIRST HALF|1ST HALF)$/.test(period)&&elapsed!=null&&elapsed>=40)return late(clamp(50-elapsed,3,10),'first-half market near halftime');
 if(/^(2H|H2|SECOND HALF|2ND HALF)$/.test(period)&&elapsed!=null&&elapsed>=85)return late(clamp(100-elapsed,3,15),'second half, 85 minutes or later');
 return wait('no verified short remaining window');
}
const CENSORING_SOURCES=new Set(['early-exit','mark-to-bid','stale-timeout','missing-market']);
export function confirmedSettlements(paper={}) {
 const since=Number(paper.lastAutoResetAt||paper.createdAt)||0;
 return (paper.history||[]).filter(p=>{
  const at=Number(p.settledAt||p.closedAt);
  if(!(at>=since))return false;
  if(p.censored)return false;
  const src=String(p.settlementSource||'').toLowerCase();
  if(CENSORING_SOURCES.has(src))return false;
  return true;
 });
}
export function comboCapacity(paper={}) {
 const start=Number(paper.startUsd)||25;
 const exposure=(paper.positions||[]).reduce((sum,p)=>sum+(Number(p.stakeUsd)||0),0);
 const equity=(Number(paper.cashUsd)||0)+exposure;
 const history=confirmedSettlements(paper);
 const wins=history.filter(p=>String(p.status).toUpperCase()==='WON'&&Number(p.pnlUsd)>0).length;
 const profit=history.reduce((sum,p)=>sum+(Number(p.pnlUsd)||0),0);
 const tier=equity>=start+5&&profit>=5&&wins>=2?3:equity>=start+1&&profit>=1&&wins>=1?2:1;
 return {comboLimit:tier,openCombos:(paper.positions||[]).filter(p=>p.kind!=='single').length,
  settledProfitUsd:Math.round(profit*100)/100,settledWins:wins,nextComboEquityUsd:tier===1?start+1:tier===2?start+5:null};
}
