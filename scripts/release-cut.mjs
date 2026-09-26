#!/usr/bin/env node
// Money Printer OS — cut a release: bump the version, commit, tag and push, which starts the
// "Release build" workflow (.github/workflows/release.yml). That workflow runs the tests, builds the
// macOS + Windows packages and leaves a DRAFT release. Then `npm run release:publish -- --key …`
// signs and publishes it, and installed copies update themselves.
//
//   node scripts/release-cut.mjs [0.5.0-alpha.61]   (default: bump the trailing number)
//   npm run release:cut
//   add --no-push to stop after the local commit + tag.
//
// Refuses unless: on branch main, working tree clean, and main equal to origin/main.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Other places that carry the version string and must move with package.json.
export const VERSION_FILES = [{ file: 'src/robinhoodTransport.js', pattern: /const APP_VERSION='[^']*';/, render: (v) => `const APP_VERSION='${v}';` }];

export function nextVersion(current) {
  const m = /^(.*?)(\d+)$/.exec(String(current));
  if (!m) throw new Error(`cannot bump ${current}; pass the new version explicitly`);
  return `${m[1]}${Number(m[2]) + 1}`;
}

export function validVersion(v) { return /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(String(v)); }

// Rewrites package.json, package-lock.json (root entries only) and VERSION_FILES in `root`. Pure file edits.
export function applyVersion(root, v) {
  const pj = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
  pkg.version = v;
  fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + '\n');
  const lj = path.join(root, 'package-lock.json');
  if (fs.existsSync(lj)) {
    const lock = JSON.parse(fs.readFileSync(lj, 'utf8'));
    lock.version = v;
    if (lock.packages && lock.packages['']) lock.packages[''].version = v;
    fs.writeFileSync(lj, JSON.stringify(lock, null, 2) + '\n');
  }
  const touched = ['package.json', 'package-lock.json'];
  for (const f of VERSION_FILES) {
    const p = path.join(root, f.file);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, 'utf8');
    if (!f.pattern.test(s)) throw new Error(`${f.file}: version pattern not found`);
    fs.writeFileSync(p, s.split(s.match(f.pattern)[0]).join(f.render(v)));
    touched.push(f.file);
  }
  return touched;
}

function git(...args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); }

function main(argv) {
  const push = !argv.includes('--no-push');
  const explicit = argv.find((a) => !a.startsWith('--'));
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') throw new Error('switch to main first (git checkout main && git pull --ff-only)');
  if (git('status', '--porcelain')) throw new Error('working tree is not clean; commit or stash first');
  git('fetch', '-q', 'origin', 'main');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) throw new Error('main is not equal to origin/main; pull or push first');
  const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const v = explicit || nextVersion(current);
  if (!validVersion(v)) throw new Error(`not a version: ${v}`);
  const tag = `v${v}`;
  if (git('tag', '--list', tag)) throw new Error(`tag ${tag} already exists`);
  const touched = applyVersion(ROOT, v);
  git('add', ...touched);
  git('commit', '-q', '-m', `Release ${tag}`);
  git('tag', '-a', tag, '-m', `Money Printer OS ${tag}`);
  console.log(`Committed and tagged ${tag} (was ${current}).`);
  if (!push) { console.log('Not pushed (--no-push). Push with: git push origin main ' + tag); return; }
  git('push', '-q', 'origin', 'main');
  git('push', '-q', 'origin', tag);
  console.log(`Pushed. The "Release build" workflow now builds ${tag} into a draft release (about 20-40 min).`);
  console.log('When it finishes: npm run release:publish -- --key <release-private-key.pem>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(`release:cut: ${e.message}`); process.exit(1); }
}
