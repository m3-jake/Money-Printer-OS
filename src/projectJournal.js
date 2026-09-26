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

// Milestones for every commit reachable from `ref`, oldest first. Ids match the backfill script.
export function gitMilestoneEntries({ repoDir = process.cwd(), ref = "HEAD", maxCommits = 5000 } = {}) {
  const fmt = "%H%x1f%ct%x1f%s";
  const r = spawnSync("git", ["-C", path.resolve(repoDir), "log", `--max-count=${Math.max(1, Math.floor(Number(maxCommits) || 5000))}`, `--pretty=format:${fmt}`, "--reverse", ref], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || "git log failed").trim());
  return String(r.stdout || "").split("\n").filter(Boolean).map(line => {
    const [sha, sec, ...rest] = line.split("\x1f"), message = rest.join("\x1f");
    return { id: `git:${sha}`, kind: "git-milestone", category: classifyCommit(message), title: message, detail: `Commit ${sha.slice(0, 12)}`, commit: sha, at: Number(sec) * 1000, source: "git-history" };
  });
}

// One read, one append: entries whose id is already present are skipped.
export function appendProjectJournalMany(file, entries = []) {
  ensureParent(file);
  const seen = new Set(readProjectJournal(file, { limit: 1e9 }).map(x => x.id));
  const rows = [];
  for (const entry of entries) {
    const at = Number.isFinite(Number(entry?.at)) ? Number(entry.at) : Date.now();
    const row = { schema: PROJECT_JOURNAL_SCHEMA, ...entry, at };
    row.id ||= idFor(row);
    if (seen.has(row.id)) continue;
    seen.add(row.id); rows.push(row);
  }
  if (rows.length) fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return { appended: rows.length, skipped: entries.length - rows.length };
}

export function backfillProjectJournalFromGit({ repoDir = process.cwd(), journalFile, maxCommits = 5000 } = {}) {
  if (!journalFile) throw new Error("journalFile required");
  const out = appendProjectJournalMany(journalFile, gitMilestoneEntries({ repoDir, maxCommits }));
  return { ...out, total: out.appended + out.skipped };
}

// Packaged builds have no .git, so each build ships its commit history as PROJECT-MILESTONES.json.
export const BUILD_MILESTONES_FILE = "PROJECT-MILESTONES.json";
export const BUILD_MILESTONES_SCHEMA = "mpo.project-milestones.v1";
export function writeBuildMilestones(appDir, { repoDir, ref = "HEAD", maxCommits = 5000 } = {}) {
  const entries = gitMilestoneEntries({ repoDir, ref, maxCommits });
  fs.writeFileSync(path.join(appDir, BUILD_MILESTONES_FILE), JSON.stringify({ schema: BUILD_MILESTONES_SCHEMA, ref, count: entries.length, entries }) + "\n");
  return entries.length;
}

const readJsonFile = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

// Catches the project journal up at startup: the build's shipped milestones (or git history when
// running from a checkout) plus one "running" entry per release. Never throws.
export function seedProjectJournal({ journalFile, appRoot, now = Date.now() } = {}) {
  const result = { source: null, appended: 0, skipped: 0, release: null, error: null };
  try {
    if (!journalFile || !appRoot) throw new Error("journalFile and appRoot required");
    let entries = [];
    const shipped = readJsonFile(path.join(appRoot, BUILD_MILESTONES_FILE));
    if (shipped?.schema === BUILD_MILESTONES_SCHEMA && Array.isArray(shipped.entries)) {
      result.source = "build";
      entries = shipped.entries.filter(e => e && typeof e.id === "string" && e.id.startsWith("git:") && Number.isFinite(Number(e.at)) && typeof e.title === "string");
    } else if (fs.existsSync(path.join(appRoot, ".git"))) {
      result.source = "git";
      entries = gitMilestoneEntries({ repoDir: appRoot });
    }
    const build = readJsonFile(path.join(appRoot, "BUILD.json")), pkg = readJsonFile(path.join(appRoot, "package.json"));
    const release = build?.releaseId || (pkg?.version ? `${pkg.version}${result.source === "git" ? "+source" : ""}` : null);
    if (release) {
      result.release = release;
      entries.push({ id: `release:${release}`, kind: "release-start", category: "release", title: `Money Printer OS ${release} started`, detail: build?.sourceCommit ? `Built from ${String(build.sourceCommit).slice(0, 12)} on ${build.builtOn || "unknown"}` : "Running from source", commit: build?.sourceCommit || undefined, at: now, source: "app-start" });
    }
    Object.assign(result, appendProjectJournalMany(journalFile, entries));
  } catch (e) { result.error = String(e?.message || e).slice(0, 200); }
  return result;
}

export function projectJournalSnapshot(file, { limit = 250 } = {}) {
  // Newest by time, not by file position: backfilled history is appended after newer events.
  const all = readProjectJournal(file, { limit: 1e9 }).map((row, i) => [row, i]).sort((a, b) => (Number(a[0].at) || 0) - (Number(b[0].at) || 0) || a[1] - b[1]).map(x => x[0]);
  const rows = all.slice(-Math.max(1, Math.floor(Number(limit) || 250)));
  const categories = {};
  for (const row of rows) categories[row.category || row.kind || "other"] = (categories[row.category || row.kind || "other"] || 0) + 1;
  return { schema: PROJECT_JOURNAL_SCHEMA, total: rows.length, categories, rows: [...rows].reverse() };
}
