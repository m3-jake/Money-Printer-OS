// Daily self-report (self-improving loop plan, batch F item 4): the one file the owner reads instead of
// opening either app. <data>/reports/self/<local date>.json and .md are rewritten hourly during the day;
// the first run on the next day finalizes yesterday's and adds one "Daily report" project-journal entry.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from './atomicRename.js';
import { appendProjectJournal, readProjectJournal } from './projectJournal.js';

export const SELF_REPORT_SCHEMA = 'mpo.self-report.v1';
const DAY_MS = 864e5;
// Local calendar date (the owner's day), YYYY-MM-DD.
export const localDate = (at = Date.now()) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fin = v => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const reportsDir = dataDir => path.join(dataDir, 'reports', 'self');
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
export function readSelfReport(dataDir, date) { const r = readJson(path.join(reportsDir(dataDir), `${date}.json`)); return r?.schema === SELF_REPORT_SCHEMA ? r : null; }

// Journal kinds that record a decision or an event worth a line in the daily report (not raw git history).
const DECISION_KINDS = new Set(['paper-trial', 'risk', 'release-start', 'champion-publication', 'research-lifecycle', 'profile-auto-demote']);

export function buildSelfReport({ date, fitness = null, previous = null, state = {}, journal = [], now = Date.now(), process: proc = null } = {}) {
  const modules = {};
  for (const [id, m] of Object.entries(fitness?.modules || {})) {
    const pr = m.paperRecord || {}, prev = previous?.modules?.[id] || null;
    modules[id] = { verdict: m.verdict, closes: fin(pr.closes), netPnl: fin(pr.netPnl), unit: pr.unit || null, hitRate: fin(pr.hitRate), profitFactor: fin(pr.profitFactor),
      trial: m.trial?.status || null, blockers: (m.blockers || []).slice(0, 6),
      delta: prev ? { closes: fin(pr.closes) !== null && fin(prev.closes) !== null ? pr.closes - prev.closes : null, netPnl: fin(pr.netPnl) !== null && fin(prev.netPnl) !== null ? Math.round((pr.netPnl - prev.netPnl) * 1e6) / 1e6 : null, verdictChanged: prev.verdict !== m.verdict ? `${prev.verdict} -> ${m.verdict}` : null } : null };
  }
  const decisions = journal.filter(r => localDate(r.at) === date && DECISION_KINDS.has(r.kind)).sort((a, b) => a.at - b.at).slice(-40).map(r => ({ at: r.at, kind: r.kind, title: r.title, module: r.module || null }));
  const commits = journal.filter(r => localDate(r.at) === date && r.kind === 'git-milestone').length;
  const sys = state.system || {}, mem = proc?.memoryUsage?.() || null;
  return { schema: SELF_REPORT_SCHEMA, date, generatedAt: now, final: false, liveExecution: 'manual', liveActivationAllowed: false,
    health: { trader: sys.health || null, paused: !!sys.paused, killSwitch: !!sys.killSwitch, mode: state.mode || null, labLink: state.labLink ? { connected: !!state.labLink.connected, source: state.labLink.source || null } : null },
    modules, decisions, commits,
    resources: { cpuPct: fin(sys.metrics?.cpuPct), memoryPct: fin(sys.metrics?.memoryPct), rssMb: mem ? Math.round(mem.rss / 1048576) : null, uptimeMin: proc?.uptime ? Math.round(proc.uptime() / 60) : null } };
}

const sign = v => (v > 0 ? '+' : '') + v;
export function renderSelfReportMd(r) {
  const lines = [`# Money Printer OS daily report, ${r.date}${r.final ? '' : ' (in progress)'}`, '', `Generated ${new Date(r.generatedAt).toISOString()}. Paper only; live execution stays manual.`, '',
    `Trader ${r.health.trader || 'unknown'} in ${r.health.mode || 'unknown'} mode${r.health.paused ? ', PAUSED' : ''}${r.health.killSwitch ? ', KILL SWITCH' : ''}. Lab link ${r.health.labLink?.connected ? 'connected' : 'not connected'}.`, '', '## Modules', ''];
  for (const [id, m] of Object.entries(r.modules)) {
    const d = m.delta ? ` (today ${m.delta.closes === null ? 'n/a' : sign(m.delta.closes)} closes, ${m.delta.netPnl === null ? 'n/a' : sign(m.delta.netPnl)} ${m.unit || ''})` : '';
    lines.push(`- **${id}**: ${m.verdict}${m.trial ? `, trial ${m.trial}` : ''}. ${m.closes ?? 0} closes, net ${m.netPnl ?? 0} ${m.unit || ''}${m.hitRate === null ? '' : `, hit ${(m.hitRate * 100).toFixed(0)}%`}${d}.${m.delta?.verdictChanged ? ` Verdict ${m.delta.verdictChanged}.` : ''}`);
    for (const b of m.blockers.slice(0, 3)) lines.push(`  - ${b}`);
  }
  lines.push('', '## Decisions and events', '', ...(r.decisions.length ? r.decisions.map(x => `- ${new Date(x.at).toISOString().slice(11, 16)} UTC ${x.title}`) : ['- none']), '',
    `${r.commits} code change(s) recorded. Resources: CPU ${r.resources.cpuPct ?? 'n/a'}%, memory ${r.resources.memoryPct ?? 'n/a'}%, engine ${r.resources.rssMb ?? 'n/a'} MB, up ${r.resources.uptimeMin ?? 'n/a'} min.`, '');
  return lines.join('\n');
}

function write(dataDir, report) {
  const dir = reportsDir(dataDir);
  writeFileAtomicSync(path.join(dir, `${report.date}.json`), JSON.stringify(report, null, 1));
  writeFileAtomicSync(path.join(dir, `${report.date}.md`), renderSelfReportMd(report));
}

export function journalLine(r) {
  const parts = Object.entries(r.modules).map(([id, m]) => `${id} ${m.verdict}, ${m.closes ?? 0} closes${m.delta?.closes ? ` (${sign(m.delta.closes)} that day)` : ''}, net ${m.netPnl ?? 0} ${m.unit || ''}`.trim());
  return parts.join('; ') || 'no module data';
}

// Hourly entry point. Returns what it wrote; never throws.
export function runSelfReport({ dataDir, fitness, state = {}, now = Date.now(), proc = process } = {}) {
  const out = { date: localDate(now), wrote: false, finalized: null, error: null };
  try {
    const journalFile = path.join(dataDir, 'project-journal.ndjson'), journal = readProjectJournal(journalFile, { limit: 5000 });
    const yesterday = localDate(now - DAY_MS), prior = readSelfReport(dataDir, yesterday);
    if (prior && !prior.final) {
      prior.final = true; write(dataDir, prior); out.finalized = yesterday;
      appendProjectJournal(journalFile, { id: `self-report:${yesterday}`, kind: 'daily-report', category: 'report', title: `Daily report ${yesterday}`, detail: journalLine(prior), at: prior.generatedAt });
    }
    const previous = prior || readSelfReport(dataDir, localDate(now - 2 * DAY_MS));
    write(dataDir, buildSelfReport({ date: out.date, fitness, previous, state, journal, now, process: proc }));
    out.wrote = true;
  } catch (e) { out.error = String(e?.message || e).slice(0, 200); }
  return out;
}

export function latestSelfReport(dataDir) {
  try {
    const names = fs.readdirSync(reportsDir(dataDir)).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
    return names.length ? readSelfReport(dataDir, names.at(-1).slice(0, 10)) : null;
  } catch { return null; }
}
