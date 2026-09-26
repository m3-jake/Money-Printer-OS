#!/usr/bin/env node
// Money Printer OS — build app.asar on Windows.
//
//   npm run release:windows-asar                      -> %USERPROFILE%\Desktop\Money Printer OS\Windows-<short>-<ymd>\app.asar
//   npm run release:windows-asar -- --out <dir>        -> <dir>\app.asar
//
// scripts/build-unified.mjs refuses to run anywhere but macOS arm64 (codesign, ditto, plutil), so
// a Windows host had no way to produce the archive its own installer swaps in. This is step 2 of
// that script — the part that is platform-neutral — done the same way: a clean `git archive` of
// the allowlist at HEAD (the tracked tree must be clean), `npm ci --omit=dev --omit=optional`,
// BUILD.json / .build-commit / .build-version, the forbidden-file check, and `@electron/asar pack`.
// It does not download an Electron runtime, sign anything, or install anything; pair it with
// `npm run smoke:windows -- --asar <file>` for the boot test and with the installed runtime's
// resources/app.asar for the swap.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOW = ['src', 'desktop', 'public', 'package.json', 'package-lock.json', '.env.example'];
const ASAR_PKG = '@electron/asar@4.3.0';
const ELECTRON_VERSION = '38.8.6';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const out = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...o }).trim();
const die = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name]);

if (process.platform !== 'win32') die('this is the Windows packer; use npm run release:unified on the Mac');
const dirty = out('git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no']);
if (dirty) die(`tracked working tree not clean:\n${dirty}`);
const commit = out('git', ['-C', ROOT, 'rev-parse', 'HEAD']);
const short = commit.slice(0, 7);
const commitEpoch = Number(out('git', ['-C', ROOT, 'show', '-s', '--format=%ct', 'HEAD']));
const pkg = JSON.parse(out('git', ['-C', ROOT, 'show', `${commit}:package.json`]));
const createdAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const ymd = createdAt.slice(0, 10).replace(/-/g, '');
const releaseId = `${pkg.version}+windows.${short}`;
const OUT = path.resolve(opt('--out', path.join(os.homedir(), 'Desktop', 'Money Printer OS', `Windows-${short}-${ymd}`)));
if (OUT.startsWith(ROOT + path.sep)) die('output dir must be outside the repo');
fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), `mpo-win-${short}-`));
const APP = path.join(WORK, 'app'); fs.mkdirSync(APP);
console.log(`commit ${commit}\nrelease ${releaseId}\nwork ${WORK}\nout ${OUT}`);

// 1. clean source: git archive of the allowlist only. tar gets relative paths on purpose — the
//    GNU tar on a Git-for-Windows PATH reads "C:\..." as a remote host.
fs.writeFileSync(path.join(WORK, 'src.tar'), execFileSync('git', ['-C', ROOT, 'archive', '--format=tar', commit, ...ALLOW], { maxBuffer: 1 << 30 }));
if (spawnSync('tar', ['-xf', 'src.tar', '-C', 'app'], { cwd: WORK, stdio: 'inherit' }).status !== 0) die('tar extract failed');
fs.rmSync(path.join(WORK, 'src.tar'));

// 2. locked runtime dependencies + build markers, as build-unified stages them
const ci = spawnSync('npm.cmd', ['ci', '--ignore-scripts', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'], { cwd: APP, encoding: 'utf8', shell: true });
fs.writeFileSync(path.join(OUT, 'npm-ci.log'), `${ci.stdout}\n${ci.stderr}`);
if (ci.status !== 0) die(`npm ci failed (see ${OUT}\\npm-ci.log)`);
fs.mkdirSync(path.join(APP, 'data')); fs.writeFileSync(path.join(APP, 'data', '.keep'), '');
fs.writeFileSync(path.join(APP, 'BUILD.json'), JSON.stringify({ releaseId, sourceCommit: commit, packageVersion: pkg.version, electronVersion: ELECTRON_VERSION, createdAt, builtOn: 'windows' }, null, 2) + '\n');
fs.writeFileSync(path.join(APP, '.build-commit'), commit + '\n');
fs.writeFileSync(path.join(APP, '.build-version'), pkg.version + '\n');
const files = walk(APP);
const forbidden = files.filter((f) => /(^|\/)\.env$/.test(f) || (/\.(pem|key|p12|pfx)$/.test(f) && !f.endsWith('update-public-key.pem')));
if (forbidden.length) die(`forbidden files staged: ${forbidden.join(', ')}`);
const nativeMods = files.filter((f) => f.endsWith('.node'));
for (const f of files) fs.utimesSync(path.join(APP, f), commitEpoch, commitEpoch);

// 3. pack + check
const ASAR = path.join(OUT, 'app.asar');
fs.rmSync(ASAR, { force: true }); fs.rmSync(`${ASAR}.unpacked`, { recursive: true, force: true });
// shell:true joins argv unquoted, so a path with spaces (the default Desktop\Money Printer OS) must be quoted here.
const q = (p) => `"${p}"`;
if (spawnSync('npx.cmd', ['-y', ASAR_PKG, 'pack', q(APP), q(ASAR), '--unpack', '*.node'], { cwd: WORK, stdio: 'inherit', shell: true }).status !== 0) die('asar pack failed');
const listing = out('npx.cmd', ['-y', ASAR_PKG, 'list', q(ASAR)], { cwd: WORK, maxBuffer: 1 << 28, shell: true }).split('\n').map((l) => l.replace(/\\/g, '/'));
if (listing.some((l) => /^\/(\.env|tests|\.agent-state|\.workflow|\.git|artifacts|docs|scripts)(\/|$)/.test(l))) die('asar contains excluded paths');
for (const must of ['/package.json', '/BUILD.json', '/src/index.js', '/desktop/main.cjs', '/desktop/update-public-key.pem', '/public/dashboard.html']) {
  if (!listing.includes(must)) die(`asar is missing ${must}`);
}
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(ASAR)).digest('hex');
const info = { releaseId, sourceCommit: commit, packageVersion: pkg.version, electronVersion: ELECTRON_VERSION, createdAt, builtOn: os.hostname(), sha256, bytes: fs.statSync(ASAR).size, entries: listing.length, nativeModules: nativeMods, stagedFiles: files.length };
fs.writeFileSync(path.join(OUT, 'BUILD-INFO.json'), JSON.stringify(info, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), `${sha256}  app.asar\n`);
fs.rmSync(WORK, { recursive: true, force: true });
console.log(JSON.stringify(info, null, 2));
