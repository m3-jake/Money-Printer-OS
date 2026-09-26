// Robinhood stocks & ETFs paper lane: NYSE regular-session calendar (docs/ROBINHOOD-AUTO-TRADER.md §25).
// Pure, no network, no local-clock dependence: every time conversion goes through America/New_York via Intl.
// The holiday table is hand-copied and pinned by tests. It FAILS CLOSED: dates past CALENDAR_END are not
// sessions, so the lane stops deciding instead of trading on a guessed calendar. Extend the table yearly.
export const CALENDAR_SOURCE={url:'https://www.nyse.com/markets/hours-calendars',checkedAt:'2026-09-26'};
export const CALENDAR_START='2024-01-01';
export const CALENDAR_END='2027-12-31';
export const NYSE_HOLIDAYS=new Set([
 // 2024
 '2024-01-01','2024-01-15','2024-02-19','2024-03-29','2024-05-27','2024-06-19','2024-07-04','2024-09-02','2024-11-28','2024-12-25',
 // 2025 (2025-01-09: national day of mourning, unscheduled closure)
 '2025-01-01','2025-01-09','2025-01-20','2025-02-17','2025-04-18','2025-05-26','2025-06-19','2025-07-04','2025-09-01','2025-11-27','2025-12-25',
 // 2026 (Jul 3 = Independence Day observed; a web summary once dropped it, so it is pinned)
 '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
 // 2027
 '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24',
]);
// Early closes at 13:00 ET.
export const EARLY_CLOSES=new Set(['2024-07-03','2024-11-29','2024-12-24','2025-07-03','2025-11-28','2025-12-24','2026-11-27','2026-12-24','2027-11-26']);

const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
const fmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',weekday:'short'});
export function etParts(ms){
 const p={};for(const x of fmt.formatToParts(new Date(ms)))p[x.type]=x.value;
 return {date:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour),minute:Number(p.minute),second:Number(p.second),weekday:p.weekday};
}
export function etDate(ms){return etParts(ms).date}
// UTC ms of a wall-clock time in New York on `date`.
export function etToUtcMs(date,hour,minute=0){
 const [y,m,d]=date.split('-').map(Number);
 const target=Date.UTC(y,m-1,d,hour,minute);
 let guess=target+5*3600000;
 for(let i=0;i<3;i++){
  const p=etParts(guess);const [py,pm,pd]=p.date.split('-').map(Number);
  const diff=target-Date.UTC(py,pm-1,pd,p.hour,p.minute);
  if(!diff)break;guess+=diff;
 }
 return guess;
}
function addDays(date,n){const [y,m,d]=date.split('-').map(Number);return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10)}
export function inCalendar(date){return DATE_RE.test(String(date))&&date>=CALENDAR_START&&date<=CALENDAR_END}
export function isSession(date){
 if(!inCalendar(date))return false;
 const dow=new Date(date+'T12:00:00Z').getUTCDay();
 return dow!==0&&dow!==6&&!NYSE_HOLIDAYS.has(date);
}
export function sessionFor(date){
 if(!isSession(date))return null;
 const early=EARLY_CLOSES.has(date);
 return {date,openMs:etToUtcMs(date,9,30),closeMs:etToUtcMs(date,early?13:16),early};
}
export function nextSession(date){let d=date;for(let i=0;i<15;i++){d=addDays(d,1);if(!inCalendar(d))return null;if(isSession(d))return d}return null}
export function prevSession(date){let d=date;for(let i=0;i<15;i++){d=addDays(d,-1);if(!inCalendar(d))return null;if(isSession(d))return d}return null}
// Latest session whose close is at least settleMin minutes before `now` (so the daily bar is final). null past the table.
export function lastCompletedSession(now=Date.now(),{settleMin=30}={}){
 let d=etDate(now);if(!inCalendar(d))return null;
 for(let i=0;i<15;i++){const s=sessionFor(d);if(s&&s.closeMs+settleMin*60000<=now)return d;d=addDays(d,-1);if(!inCalendar(d))return null}
 return null;
}
// First session whose regular open is strictly after `ms`.
export function nextOpenAfter(ms){let d=etDate(ms);if(!inCalendar(d))return null;for(let i=0;i<15;i++){const s=sessionFor(d);if(s&&s.openMs>ms)return d;d=addDays(d,1);if(!inCalendar(d))return null}return null}
export function marketState(now=Date.now()){
 const d=etDate(now);const s=sessionFor(d);
 if(!inCalendar(d))return {state:'CALENDAR_EXPIRED',date:d};
 if(!s)return {state:NYSE_HOLIDAYS.has(d)?'HOLIDAY':'CLOSED',date:d};
 if(now<s.openMs)return {state:'PRE_OPEN',date:d,early:s.early};
 if(now<s.closeMs)return {state:'OPEN',date:d,early:s.early};
 return {state:'CLOSED',date:d,early:s.early};
}
