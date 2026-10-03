// Dry run of a smaller research-evidence retention policy (run item C3). Deletes nothing.
// Usage: node scripts/retention-dry-run.mjs [dataDir] [--out reports/RETENTION-DRY-RUN-<date>.json]
// The proposal is only applied after bing approves it ("Needs bing" in MONEY_PRINTER_STATUS.md).
import fs from 'node:fs';
import path from 'node:path';
import { pruneRawTapes } from '../src/researchCollector.js';

const args = process.argv.slice(2), outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : null;
const dataDir = path.resolve(args.find((a, i) => !a.startsWith('--') && i !== outAt + 1) || process.env.MONEY_PRINTER_DATA_DIR || path.join(process.env.APPDATA || '', 'Money Printer OS', 'data'));
const dir = path.join(dataDir, 'research-evidence', 'raw');
// Proposal: Solana path ticks (no reader since the furnace retired) keep 7 days; everything else keeps the current
// 30 days; total budget 4 GB instead of 8 GB. Polymarket US files stay exempt while combo research is incomplete,
// and today and yesterday are never touched (same rules as the live pruner).
const PROPOSAL = { keepDays: 30, budgetBytes: 4 * 1024 ** 3, prefixKeepDays: { 'solana-path': 7 }, exemptPrefixes: ['polymarket-us-'] };
const current = pruneRawTapes({ dir, dryRun: true, keepDays: 30, budgetBytes: 8192 * 1024 ** 2, exemptPrefixes: ['polymarket-us-'] });
const proposed = pruneRawTapes({ dir, dryRun: true, ...PROPOSAL });
const byStream = rows => rows.reduce((a, x) => { const k = x.name.replace(/-?\d{4}-\d{2}-\d{2}.*$/, ''); a[k] ||= { files: 0, bytes: 0 }; a[k].files++; a[k].bytes += x.bytes; return a; }, {});
const gb = b => Math.round(b / 1024 ** 3 * 100) / 100;
const report = {
  schema: 'mpo.retention-dry-run.v1', at: new Date().toISOString(), dir, dryRun: true, deleted: 0,
  totalNowGB: gb(current.totalBytes + current.removedBytes),
  currentPolicy: { keepDays: 30, budgetGB: 8, wouldRemoveGB: gb(current.removedBytes), files: current.removed.length },
  proposedPolicy: { keepDays: PROPOSAL.keepDays, budgetGB: 4, prefixKeepDays: PROPOSAL.prefixKeepDays, wouldRemoveGB: gb(proposed.removedBytes), afterGB: gb(proposed.totalBytes), files: proposed.removed.length,
    byStream: Object.fromEntries(Object.entries(byStream(proposed.removed)).map(([k, v]) => [k, { files: v.files, gb: gb(v.bytes) }])), removed: proposed.removed },
  note: 'Dry run only. Nothing was deleted. Applying the proposal needs bing\'s approval.',
};
if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); }
const { removed, ...brief } = report.proposedPolicy;
console.log(JSON.stringify({ ...report, proposedPolicy: brief }, null, 2));
