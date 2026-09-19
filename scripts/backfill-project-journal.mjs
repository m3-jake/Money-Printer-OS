#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backfillProjectJournalFromGit, projectJournalSnapshot } from "../src/projectJournal.js";
import { controlPlaneFiles } from "../src/researchControlPlane.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(here, "..");
const dataDir = path.resolve(process.env.MONEY_PRINTER_DATA_DIR || path.join(repoDir, "data"));
const { journal } = controlPlaneFiles(dataDir);
const result = backfillProjectJournalFromGit({ repoDir, journalFile: journal });
const snap = projectJournalSnapshot(journal, { limit: 20 });
console.log(JSON.stringify({ ok: true, journal, ...result, latest: snap.rows.slice(0, 5) }, null, 2));
