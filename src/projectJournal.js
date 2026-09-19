import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const PROJECT_JOURNAL_SCHEMA = "mpo.project-journal.v1";
const ensureParent = file => fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
const idFor = e => crypto.createHash("sha256").update(JSON.stringify([e.kind, e.module || null, e.candidateId || null, e.at || null, e.title || null, e.detail || null])).digest("hex").slice(0, 20);

export function readProjectJournal(file, { limit = 5000 } = {}) {
  if (!fs.existsSync(file)) return [];
  const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  return rows.slice(-Math.max(1, Math.floor(Number(limit) || 5000)));
}

export function appendProjectJournal(file, entry = {}, { dedupe = true } = {}) {
  ensureParent(file);
  const at = Number.isFinite(Number(entry.at)) ? Number(entry.at) : Date.now();
  const row = { schema: PROJECT_JOURNAL_SCHEMA, ...entry, at };
  row.id ||= idFor(row);
  if (dedupe) {
    const prior = readProjectJournal(file, { limit: 10000 });
    if (prior.some(x => x.id === row.id)) return { appended: false, row };
  }
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
  return { appended: true, row };
}

export function appendLifecycleMilestone(file, { module, candidateId, from, to, reason, at = Date.now() } = {}) {
  return appendProjectJournal(file, {
    kind: "research-lifecycle",
    module,
    candidateId,
    from: from || null,
    to,
    title: `${String(module || "research").toUpperCase()} candidate → ${to}`,
    detail: reason || "lifecycle transition",
    at,
  });
}

export function classifyCommit(message = "") {
  const m = String(message).toLowerCase();
  if (/release|deploy|package|canary/.test(m)) return "release";
  if (/research|evidence|backtest|furnace|beast|replay|experiment/.test(m)) return "research";
  if (/fix|bug|repair|harden|recovery|safety/.test(m)) return "reliability";
  if (/ui|visual|design|dashboard|journal|monitor/.test(m)) return "product";
  if (/network|mesh|cluster|agent|worker|infra/.test(m)) return "infrastructure";
  return "development";
}

export function backfillProjectJournalFromGit({ repoDir = process.cwd(), journalFile, maxCommits = 5000 } = {}) {
  if (!journalFile) throw new Error("journalFile required");
  const fmt = "%H%x1f%ct%x1f%s";
  const r = spawnSync("git", ["-C", path.resolve(repoDir), "log", `--max-count=${Math.max(1, Math.floor(Number(maxCommits) || 5000))}`, `--pretty=format:${fmt}`, "--reverse"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || "git log failed").trim());
  let appended = 0, skipped = 0;
  for (const line of String(r.stdout || "").split("\n").filter(Boolean)) {
    const [sha, sec, ...rest] = line.split("\x1f"), message = rest.join("\x1f");
    const out = appendProjectJournal(journalFile, {
      id: `git:${sha}`,
      kind: "git-milestone",
      category: classifyCommit(message),
      title: message,
      detail: `Commit ${sha.slice(0, 12)}`,
      commit: sha,
      at: Number(sec) * 1000,
      source: "git-history",
    });
    if (out.appended) appended++; else skipped++;
  }
  return { appended, skipped, total: appended + skipped };
}

export function projectJournalSnapshot(file, { limit = 250 } = {}) {
  const rows = readProjectJournal(file, { limit });
  const categories = {};
  for (const row of rows) categories[row.category || row.kind || "other"] = (categories[row.category || row.kind || "other"] || 0) + 1;
  return { schema: PROJECT_JOURNAL_SCHEMA, total: rows.length, categories, rows: [...rows].reverse() };
}
