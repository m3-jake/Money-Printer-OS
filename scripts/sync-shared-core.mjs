// The trader owns every strategy, fill, fee and evidence file the Evolution Lab also runs. This script stamps
// shared-core.json (sha256 of each file, line endings normalised) and copies the files plus the manifest into the
// Lab, so the Lab always scores exactly the code the trader trades. `--check` only reports drift (exit 1).
//   node scripts/sync-shared-core.mjs [--check] [--lab <path>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), check = args.includes('--check');
const labRoot = path.resolve(args.includes('--lab') ? args[args.indexOf('--lab') + 1] : process.env.MPO_LAB_ROOT || path.join(root, '..', 'money-printer-evolution-lab'));
const manifestFile = path.join(root, 'shared-core.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
export const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r/g, '')).digest('hex');

let drift = 0;
for (const [traderPath, entry] of Object.entries(manifest.files)) {
  const hash = sha(path.join(root, traderPath)), labFile = path.join(labRoot, entry.lab);
  const labHash = fs.existsSync(labFile) ? sha(labFile) : null;
  if (entry.sha256 !== hash || labHash !== hash) { drift++; console.log(`${check ? 'drift' : 'sync '} ${traderPath} -> ${entry.lab}`); }
  entry.sha256 = hash;
  if (!check && labHash !== hash) { fs.mkdirSync(path.dirname(labFile), { recursive: true }); fs.copyFileSync(path.join(root, traderPath), labFile); }
}
if (check) { console.log(drift ? `${drift} shared file(s) drifted` : 'shared core in parity'); process.exit(drift ? 1 : 0); }
let commit = null; try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}
manifest.syncedFrom = { traderCommit: commit, at: new Date().toISOString() };
const text = JSON.stringify(manifest, null, 2) + '\n';
fs.writeFileSync(manifestFile, text);
if (fs.existsSync(labRoot)) fs.writeFileSync(path.join(labRoot, 'shared-core.json'), text);
console.log(`shared core: ${Object.keys(manifest.files).length} files, ${drift} updated`);
