#!/usr/bin/env node
// scripts/build-unified.mjs — reproducible Money Printer OS unified (macOS arm64 + Windows x64) build.
//
// Usage:  npm run release:unified -- [--skip-tests] [--skip-smoke] [--force] [--out-root DIR] [--cache DIR]
//
// From a clean `git archive` of HEAD it:
//   1. runs `npm run test:all` + `node src/selftest.js` + the release-gate test in THIS source tree
//      (tracked tree must be clean, so the results belong to HEAD) — skip with --skip-tests;
//   2. stages the runtime allowlist, `npm ci --ignore-scripts --omit=dev --omit=optional`,
//      writes BUILD.json/.build-commit/.build-version, packs app.asar with @electron/asar 4.3.0;
//   3. downloads (cached) + SHA-256-verifies the Electron runtimes against pinned official checksums;
//   4. builds macOS `Money Printer OS.app` (renamed bundle + helpers, Info.plist, icon, ad-hoc codesign)
//      and the Windows x64 folder (renamed exe, MPO-RELEASE.json, PAYLOAD-SHA256.json, installer);
//   5. zips both, re-extracts to confirm identical app.asar, smoke-boots the packaged mac engine
//      in isolated paper/dashboard-only mode, writes RELEASE.json, SHA256SUMS.txt, START-HERE.txt.
//
// Never: installs into ~/Applications, touches ~/Library/Application Support/Money Printer OS,
// reads .env or any signing key, signs the updater manifest, or changes execution flags.
// The Windows exe icon is NOT replaced (rcedit needs Windows/wine) — it keeps the Electron icon.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON_VERSION = '38.8.6';
const ASAR_PKG = '@electron/asar@4.3.0';
// Official https://github.com/electron/electron/releases/download/v38.8.6/SHASUMS256.txt
const RUNTIMES = {
  'darwin-arm64': '8a9238f83e440394f4165a3a48e67625d4d00b9d45b5264e9552c144960b7523',
  'win32-x64': '366ae2b4aa9e6bc89b98c8b5831d46303e45cd49b2970c2b3921de5f2fcfc2e1',
};
const APP_NAME = 'Money Printer OS';
const BUNDLE_ID = 'net.bangbowbing.moneyprinteros';
// Runtime allowlist copied into the asar (tests/docs/scripts/state are excluded).
const ALLOW = ['src', 'desktop', 'public', 'package.json', 'package-lock.json', '.env.example'];
const SMOKE_PORT = 8792;

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const CURRENT = path.resolve(ROOT, '..');
const OUT_ROOT = path.resolve(opt('--out-root', CURRENT));
const CACHE = path.resolve(opt('--cache', path.join(CURRENT, 'runtime-downloads')));

// ---------- helpers ----------
const log = (...a) => console.log('[build-unified]', ...a);
function die(msg) { console.error(`[build-unified] FAIL: ${msg}`); process.exit(1); }
function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...o });
  if (r.status !== 0) die(`${cmd} ${args.join(' ')} exited ${r.status}`);
  return r;
}
const out = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...o }).trim();
const sha256File = (f) => {
  const h = crypto.createHash('sha256'); const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(1 << 20);
  let n; while ((n = fs.readSync(fd, b, 0, b.length)) > 0) h.update(b.subarray(0, n));
  fs.closeSync(fd); return h.digest('hex');
};
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n');
function walk(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc); else if (e.isFile()) acc.push(path.relative(base, p));
  }
  return acc;
}
// Electron's ElectronAsarIntegrity hash = SHA-256 of the asar JSON header string.
function asarHeaderSha(file) {
  const fd = fs.openSync(file, 'r'); const size = Buffer.alloc(8); fs.readSync(fd, size, 0, 8, 0);
  const pickleLen = size.readUInt32LE(4); const hdr = Buffer.alloc(pickleLen); fs.readSync(fd, hdr, 0, pickleLen, 8);
  fs.closeSync(fd); const strLen = hdr.readUInt32LE(4);
  return crypto.createHash('sha256').update(hdr.subarray(8, 8 + strLen)).digest('hex');
}
function plist(file, key, type, value) {
  spawnSync('plutil', ['-remove', key, file], { stdio: 'ignore' });
  run('plutil', type === 'json' ? ['-insert', key, '-json', value, file] : ['-insert', key, `-${type}`, value, file]);
}
async function ensureRuntime(plat) {
  const name = `electron-v${ELECTRON_VERSION}-${plat}.zip`;
  const file = path.join(CACHE, name);
  fs.mkdirSync(CACHE, { recursive: true });
  if (fs.existsSync(file) && sha256File(file) === RUNTIMES[plat]) { log(`runtime cache hit ${name}`); return file; }
  const url = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${name}`;
  log(`downloading ${url}`);
  run('curl', ['-fL', '--retry', '3', '-o', `${file}.part`, url]);
  const got = sha256File(`${file}.part`);
  if (got !== RUNTIMES[plat]) { fs.rmSync(`${file}.part`); die(`${name} sha256 ${got} != official ${RUNTIMES[plat]}`); }
  fs.renameSync(`${file}.part`, file);
  return file;
}
function countTests(logText) {
  const t = { tests: 0, pass: 0, fail: 0, suites: 0 };
  for (const m of logText.matchAll(/^ℹ (tests|pass|fail) (\d+)$/gm)) { t[m[1]] += Number(m[2]); if (m[1] === 'tests') t.suites++; }
  return t;
}
function shellTest(label, cmd, args, logFile) {
  log(`running ${label}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, FORCE_COLOR: '0' } });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  fs.writeFileSync(logFile, text);
  return { ok: r.status === 0, exit: r.status, text };
}
function httpStatus(url) {
  return new Promise((res) => {
    const req = http.get(url, (r) => { r.resume(); res(r.statusCode); });
    req.on('error', () => res(0)); req.setTimeout(3000, () => { req.destroy(); res(0); });
  });
}

// ---------- main ----------
async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') die('must run on macOS arm64 (codesign/ditto/plutil)');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const dirty = out('git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no']);
  if (dirty) die(`tracked working tree not clean:\n${dirty}`);
  const commit = out('git', ['-C', ROOT, 'rev-parse', 'HEAD']);
  const short = commit.slice(0, 7);
  const commitEpoch = Number(out('git', ['-C', ROOT, 'show', '-s', '--format=%ct', 'HEAD']));
  const createdAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const ymd = createdAt.slice(0, 10).replace(/-/g, '');
  const releaseId = `${pkg.version}+unified.${short}`;
  const alphaN = (pkg.version.match(/alpha\.(\d+)/) || [])[1];
  const alphaTag = alphaN ? `Alpha${alphaN}` : pkg.version;
  const [maj, min] = pkg.version.split('.');
  const bundleVersion = `${maj}.${min}.${alphaN ?? '0'}`;

  const OUT = path.join(OUT_ROOT, `Unified-${short}-${ymd}`);
  if (OUT.startsWith(ROOT + path.sep)) die('output dir must be outside the repo');
  if (fs.existsSync(OUT)) { if (!flag('--force')) die(`${OUT} exists (use --force to rebuild)`); fs.rmSync(OUT, { recursive: true, force: true }); }
  fs.mkdirSync(OUT, { recursive: true });
  const LOGS = path.join(OUT, 'logs'); fs.mkdirSync(LOGS);
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), `mpo-unified-${short}-`));
  log(`commit ${commit}  release ${releaseId}\n  out  ${OUT}\n  work ${WORK}\n  cache ${CACHE}`);

  let smoke = { ran: false }; // filled after zipping; in-zip READMEs defer to RELEASE.json

  // 1. tests in the source tree (same commit; tracked tree verified clean above)
  const tests = { ran: false };
  if (!flag('--skip-tests')) {
    const all = shellTest('npm run test:all', 'npm', ['run', 'test:all'], path.join(LOGS, 'test-all.log'));
    const self = shellTest('node src/selftest.js', 'node', ['src/selftest.js'], path.join(LOGS, 'selftest.log'));
    const gate = shellTest('release-gate test', 'node', ['--test', 'tests/release-gate.test.cjs'], path.join(LOGS, 'release-gate.log'));
    const c = countTests(all.text); const g = countTests(gate.text);
    Object.assign(tests, {
      ran: true, testAll: all.ok, testCount: c.pass, testFailures: c.fail, suiteInvocations: c.suites,
      selftest: self.ok && /SELFTEST PASS/.test(self.text),
      releaseGate: gate.ok, releaseGateCount: g.pass,
      releaseGateScope: 'tests/ excluded from app.asar allowlist; run from source tree at the packaged commit',
    });
    if (!all.ok || !tests.selftest || !gate.ok) die(`tests failed: ${JSON.stringify(tests)} (see ${LOGS})`);
    log(`tests ok: ${c.pass}/${c.tests} in ${c.suites} suites, selftest PASS, gate ${g.pass}`);
  }

  // 2. clean source + staged app + asar
  const SRC = path.join(WORK, 'source'); fs.mkdirSync(SRC);
  run('/bin/sh', ['-c', `git -C "${ROOT}" archive --format=tar ${commit} | tar -x -C "${SRC}"`]);
  const APP = path.join(WORK, 'app'); fs.mkdirSync(APP);
  for (const a of ALLOW) fs.cpSync(path.join(SRC, a), path.join(APP, a), { recursive: true });
  const ci = spawnSync('npm', ['ci', '--ignore-scripts', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'], { cwd: APP, encoding: 'utf8' });
  fs.writeFileSync(path.join(LOGS, 'npm-ci.log'), `${ci.stdout}\n${ci.stderr}`);
  if (ci.status !== 0) die(`npm ci failed (see ${LOGS}/npm-ci.log)`);
  fs.mkdirSync(path.join(APP, 'data'));
  fs.writeFileSync(path.join(APP, 'data', '.keep'), '');
  const build = { releaseId, sourceCommit: commit, packageVersion: pkg.version, electronVersion: ELECTRON_VERSION, createdAt };
  writeJson(path.join(APP, 'BUILD.json'), build);
  fs.writeFileSync(path.join(APP, '.build-commit'), commit + '\n');
  fs.writeFileSync(path.join(APP, '.build-version'), pkg.version + '\n');
  const nativeMods = walk(APP).filter((f) => f.endsWith('.node'));
  const forbidden = walk(APP).filter((f) => /(^|\/)\.env$/.test(f) || /\.(pem|key|p12|pfx)$/.test(f) && !f.endsWith('update-public-key.pem'));
  if (forbidden.length) die(`forbidden files staged: ${forbidden.join(', ')}`);
  // deterministic mtimes (asar ignores them, but keeps unpacked dirs + zips stable)
  for (const f of walk(APP)) fs.utimesSync(path.join(APP, f), commitEpoch, commitEpoch);
  const ASAR = path.join(OUT, 'app.asar');
  run('npx', ['-y', ASAR_PKG, 'pack', APP, ASAR, '--unpack', '*.node'], { cwd: WORK });
  const asarInfo = { sha256: sha256File(ASAR), bytes: fs.statSync(ASAR).size, headerSha256: asarHeaderSha(ASAR) };
  const hasUnpacked = fs.existsSync(`${ASAR}.unpacked`);
  const listing = out('npx', ['-y', ASAR_PKG, 'list', ASAR], { cwd: WORK, maxBuffer: 1 << 28 }).split('\n');
  if (listing.some((l) => /^\/(\.env|tests|\.agent-state|\.workflow|\.git|artifacts|docs)(\/|$)/.test(l))) die('asar contains excluded paths');
  log(`app.asar ${asarInfo.sha256} (${asarInfo.bytes} bytes, ${listing.length} entries, ${nativeMods.length} .node)`);

  // 3. runtimes
  const macZip = await ensureRuntime('darwin-arm64');
  const winZip = await ensureRuntime('win32-x64');

  // 4a. macOS bundle
  const MACDIR = path.join(OUT, 'macOS'); fs.mkdirSync(MACDIR);
  const macX = path.join(WORK, 'mac'); fs.mkdirSync(macX);
  run('ditto', ['-x', '-k', macZip, macX]);
  const APPB = path.join(MACDIR, `${APP_NAME}.app`);
  fs.renameSync(path.join(macX, 'Electron.app'), APPB);
  const C = path.join(APPB, 'Contents');
  fs.renameSync(path.join(C, 'MacOS', 'Electron'), path.join(C, 'MacOS', APP_NAME));
  const FW = path.join(C, 'Frameworks');
  for (const h of fs.readdirSync(FW).filter((n) => /^Electron Helper.*\.app$/.test(n))) {
    const suffix = h.slice('Electron Helper'.length, -4); // '', ' (GPU)', ...
    const newName = `${APP_NAME} Helper${suffix}`;
    const hp = path.join(FW, `${newName}.app`);
    fs.renameSync(path.join(FW, h), hp);
    fs.renameSync(path.join(hp, 'Contents', 'MacOS', `Electron Helper${suffix}`), path.join(hp, 'Contents', 'MacOS', newName));
    const hpl = path.join(hp, 'Contents', 'Info.plist');
    plist(hpl, 'CFBundleExecutable', 'string', newName);
    plist(hpl, 'CFBundleName', 'string', newName);
    plist(hpl, 'CFBundleDisplayName', 'string', newName);
    const tag = suffix.replace(/[^A-Za-z]/g, '').toLowerCase();
    plist(hpl, 'CFBundleIdentifier', 'string', `${BUNDLE_ID}.helper${tag ? '.' + tag : ''}`);
  }
  const RES = path.join(C, 'Resources');
  fs.rmSync(path.join(RES, 'default_app.asar'), { force: true });
  fs.rmSync(path.join(RES, 'electron.icns'), { force: true });
  fs.copyFileSync(ASAR, path.join(RES, 'app.asar'));
  if (hasUnpacked) fs.cpSync(`${ASAR}.unpacked`, path.join(RES, 'app.asar.unpacked'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'build', 'icon.icns'), path.join(RES, 'icon.icns'));
  const ipl = path.join(C, 'Info.plist');
  const setS = { CFBundleExecutable: APP_NAME, CFBundleName: APP_NAME, CFBundleDisplayName: APP_NAME, CFBundleIdentifier: BUNDLE_ID,
    CFBundleIconFile: 'icon.icns', CFBundleShortVersionString: pkg.version, CFBundleVersion: bundleVersion,
    LSApplicationCategoryType: 'public.app-category.finance', LSMinimumSystemVersion: '12.0',
    NSHumanReadableCopyright: 'Copyright © 2026 Money Printer OS', MPOReleaseId: releaseId, MPOSourceCommit: commit };
  for (const [k, v] of Object.entries(setS)) plist(ipl, k, 'string', v);
  plist(ipl, 'ElectronAsarIntegrity', 'json', JSON.stringify({ 'Resources/app.asar': { algorithm: 'SHA256', hash: asarInfo.headerSha256 } }));
  spawnSync('xattr', ['-cr', APPB]);
  const ENT = path.join(OUT, 'mac-entitlements.plist');
  fs.copyFileSync(path.join(ROOT, 'scripts', 'unified', 'mac-entitlements.plist'), ENT);
  run('codesign', ['--force', '--deep', '--sign', '-', '--entitlements', ENT, '--identifier', BUNDLE_ID, APPB]);
  run('codesign', ['--verify', '--deep', '--strict', APPB]);
  fs.writeFileSync(path.join(MACDIR, 'README.txt'), macReadme());

  // 4b. Windows folder
  const WINDIR = path.join(OUT, 'Windows'); const PAY = path.join(WINDIR, APP_NAME);
  fs.mkdirSync(PAY, { recursive: true });
  run('ditto', ['-x', '-k', winZip, PAY]);
  fs.renameSync(path.join(PAY, 'electron.exe'), path.join(PAY, `${APP_NAME}.exe`));
  fs.rmSync(path.join(PAY, 'resources', 'default_app.asar'), { force: true });
  fs.copyFileSync(ASAR, path.join(PAY, 'resources', 'app.asar'));
  if (hasUnpacked) fs.cpSync(`${ASAR}.unpacked`, path.join(PAY, 'resources', 'app.asar.unpacked'), { recursive: true });
  const relTests = tests.ran ? { testAll: tests.testAll, selftest: tests.selftest, testCount: tests.testCount, suiteInvocations: tests.suiteInvocations } : { ran: false };
  writeJson(path.join(PAY, 'MPO-RELEASE.json'), { ...build, appAsar: asarInfo, tests: { ...relTests, windowsBoot: false },
    signing: { releaseManifestSigned: false, windowsAuthenticode: false, macLocalAdHoc: true }, stateIncluded: false, windowsBootTested: false,
    windowsExeIcon: 'stock Electron icon (rcedit not run; requires Windows/wine)' });
  const payload = {};
  for (const f of walk(PAY)) payload[f.split(path.sep).join('\\')] = sha256File(path.join(PAY, f));
  writeJson(path.join(WINDIR, 'PAYLOAD-SHA256.json'), payload);
  for (const f of ['Install-Windows.ps1', 'Install.cmd']) fs.copyFileSync(path.join(ROOT, 'scripts', 'unified', 'windows', f), path.join(WINDIR, f));
  fs.writeFileSync(path.join(WINDIR, 'README.txt'), winReadme().replace(/\n/g, '\r\n'));

  // 5. zips + verification
  const macZipOut = path.join(OUT, `Money-Printer-OS-${alphaTag}-${short}-macOS-arm64.zip`);
  const winZipOut = path.join(OUT, `Money-Printer-OS-${alphaTag}-${short}-Windows-x64.zip`);
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', MACDIR, macZipOut]);
  run('/bin/sh', ['-c', `cd "${OUT}" && zip -q -r -X "${winZipOut}" Windows`]);
  const VX = path.join(WORK, 'verify'); fs.mkdirSync(VX);
  run('ditto', ['-x', '-k', macZipOut, path.join(VX, 'm')]);
  run('unzip', ['-q', winZipOut, '-d', path.join(VX, 'w')]);
  const vMac = sha256File(path.join(VX, 'm', 'macOS', `${APP_NAME}.app`, 'Contents', 'Resources', 'app.asar'));
  const vWin = sha256File(path.join(VX, 'w', 'Windows', APP_NAME, 'resources', 'app.asar'));
  run('codesign', ['--verify', '--deep', '--strict', path.join(VX, 'm', 'macOS', `${APP_NAME}.app`)]);
  const identical = vMac === asarInfo.sha256 && vWin === asarInfo.sha256;
  if (!identical) die(`asar mismatch after zip: mac ${vMac} win ${vWin} expected ${asarInfo.sha256}`);

  // 6. packaged mac engine smoke boot (isolated paper / dashboard-only)
  if (!flag('--skip-smoke')) smoke = await macSmoke(path.join(VX, 'm', 'macOS', `${APP_NAME}.app`), LOGS);
  writeJson(path.join(OUT, 'MAC-ENGINE-SMOKE.json'), smoke);
  if (smoke.ran && !smoke.success) die(`mac engine smoke boot failed (see ${LOGS}/mac-engine.log)`);

  // 7. release metadata
  const zips = [macZipOut, winZipOut].map((f) => ({ file: path.basename(f), bytes: fs.statSync(f).size, sha256: sha256File(f) }));
  writeJson(path.join(OUT, 'windows-runtime.json'), { version: ELECTRON_VERSION, file: path.basename(winZip), sha256: RUNTIMES['win32-x64'], officialChecksumMatched: true });
  writeJson(path.join(OUT, 'RELEASE.json'), {
    releaseId, packageVersion: pkg.version, sourceCommit: commit, sourceRepo: ROOT, electronVersion: ELECTRON_VERSION,
    builder: 'scripts/build-unified.mjs', createdAt, status: 'Mac + Windows packages built; not installed by the build',
    macInstalled: false, windowsInstalled: false, windowsBootTested: false, secretsIncluded: false, stateIncluded: false,
    appAsar: asarInfo, asarEntries: listing.length, nativeModules: nativeMods,
    runtimes: Object.fromEntries(Object.entries(RUNTIMES).map(([k, v]) => [k, { sha256: v, officialChecksumMatched: true }])),
    tests: { ...tests, macBoot: smoke.success === true, windowsBoot: false,
      macBootScope: 'Packaged Electron binary (ELECTRON_RUN_AS_NODE) running app.asar/src/index.js --dashboard-only, isolated paper data; not a GUI workflow test' },
    signing: { releaseManifestSigned: false, windowsAuthenticode: false, macLocalAdHoc: true, macDeveloperId: false, macNotarized: false },
    windowsExeIcon: 'stock Electron icon (rcedit not run; requires Windows/wine)',
    artifacts: zips,
  });
  writeJson(path.join(OUT, 'PACKAGE-VERIFICATION.json'), { archivesPassed: true, identicalAppAsar: identical,
    files: [{ file: 'app.asar', bytes: asarInfo.bytes, sha256: asarInfo.sha256 }, ...zips], windowsBootTested: false });
  fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), [`${asarInfo.sha256}  app.asar`, ...zips.map((z) => `${z.sha256}  ${z.file}`)].join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'START-HERE.txt'), startHere(zips));
  fs.rmSync(WORK, { recursive: true, force: true });
  log(`DONE ${OUT}`);
  for (const z of zips) log(`${z.sha256}  ${z.file}`);

  // ---------- text templates ----------
  function header() {
    return `Release: ${releaseId}\nApplication version: ${pkg.version}\nSource revision: ${commit}\nElectron runtime: ${ELECTRON_VERSION}\nShared app.asar SHA-256: ${asarInfo.sha256}\nBuilt by: scripts/build-unified.mjs (npm run release:unified)\n`;
  }
  function validation() {
    const t = tests.ran ? `${tests.testCount} test cases passed in npm run test:all (${tests.suiteInvocations} suites). Self-test passed.\nRelease-gate test passed from the source tree at this commit (tests are not packaged).` : 'Tests were SKIPPED for this build (--skip-tests).';
    return `${t}\nLocked dependencies installed using npm ci --ignore-scripts --omit=dev --omit=optional.\n${!smoke.ran ? 'Mac engine smoke boot result: see RELEASE.json / START-HERE.txt next to the zips.' : smoke.success ? 'Packaged Mac engine and dashboard served HTTP 200 using isolated paper-mode data.' : 'Mac engine smoke boot FAILED or was not run.'}\nMac app has a verified local ad-hoc signature; it is not Developer-ID signed or notarized.\nBoth Electron runtimes matched the official Electron release checksums.\nWindows app is not Authenticode-signed and keeps the stock Electron exe icon.\nNo signed updater/stable promotion is claimed: the updater manifest is UNSIGNED (releaseManifestSigned:false).\nPolymarket US API key regeneration (polymarket.us/developer) is still pending; signed calls return keyNotFound until then.\n`;
  }
  function startHere(zips) {
    return `MONEY PRINTER OS - SHARED MAC / WINDOWS RELEASE\n\n${header()}\nSTATUS\nMac: macOS arm64 app bundle built. NOT installed by the build.\nWindows: full x64 package built. NOT installed or boot-tested on Windows.\n\nVALIDATION\n${validation()}\nARTIFACTS\n${zips.map((z) => `${z.file}\n  sha256 ${z.sha256}`).join('\n')}\n\nMAC INSTALL (bing, by hand, with Money Printer OS closed and in paper mode)\nKeep the existing app as a rollback copy, then replace it with macOS/${APP_NAME}.app,\ne.g.  mv "/Applications/${APP_NAME}.app" "/Applications/${APP_NAME}.app.backup-<date>"\n      ditto "macOS/${APP_NAME}.app" "/Applications/${APP_NAME}.app"\nDo not overwrite or copy your user-data directory when changing app versions.\n\nWINDOWS INSTALL\nExtract the entire Windows ZIP, then open Windows/Install.cmd.\nClose Money Printer OS first. The installer verifies all payload files, preserves\nAppData, saves a rollback copy, and updates Desktop/Start Menu shortcuts.\nIt refuses active application processes, configured live mode, and known open real\nexposures. It does not launch trading or change Windows execution/security policy.\nMultiple detected installations require an explicit -InstallDir path.\n\nPRESERVED\nNo .env / credentials / wallet settings / balances / trade state / history are in\neither package. data/ inside app.asar is empty.\n\nREPRODUCIBILITY\nRebuild: git checkout ${short} && npm run release:unified -- --force\nSource came from git archive of the pinned revision. Runtime allowlist:\n${ALLOW.join(', ')}, node_modules (npm ci) and an empty data/.\nBUILD.json and .build-commit in app.asar identify the exact packaged revision.\nBoth platform bundles contain the exact same app.asar.\n`;
  }
  function macReadme() {
    return `MONEY PRINTER OS - macOS arm64\n\n${header()}\n${validation()}\nThis bundle was not installed by the build. Replace your app by hand with Money\nPrinter OS closed, keeping the previous bundle as a rollback copy. Your user-data\ndirectory is separate and must not be copied or overwritten.\n`;
  }
  function winReadme() {
    return `Money Printer OS - unified local alpha release (${releaseId})\n\nExtract this entire folder before running Install.cmd.\nClose Money Printer OS first. The installer verifies every runtime file,\nkeeps a rollback copy, preserves AppData, and does not launch trading.\nIt also refreshes Desktop and Start Menu shortcuts.\n\nThis package is NOT Authenticode-signed and has NOT been boot-tested on Windows.\nThe exe keeps the stock Electron icon.\nNo Windows execution-policy or security settings are changed.\nIf PowerShell policy blocks the installer, leave security settings unchanged\nand use the included application folder as a portable build for manual review.\n\nBoth platforms use the exact same resources/app.asar checksum in MPO-RELEASE.json.\nThe Evolution Lab is separate and is not modified by this installer.\n`;
  }
}

async function macSmoke(appBundle, LOGS) {
  const bin = path.join(appBundle, 'Contents', 'MacOS', APP_NAME);
  const entry = path.join(appBundle, 'Contents', 'Resources', 'app.asar', 'src', 'index.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-smoke-data-'));
  const busy = await httpStatus(`http://127.0.0.1:${SMOKE_PORT}/`);
  if (busy) return { ran: false, success: false, reason: `port ${SMOKE_PORT} already in use; refusing to smoke-test against another process` };
  const env = { PATH: process.env.PATH, HOME: dataDir, TMPDIR: os.tmpdir(), ELECTRON_RUN_AS_NODE: '1', MODE: 'paper',
    ALPHA_WORKER_ENABLED: 'false', DIRECT_STREAM_ENABLED: 'false', OPEN_DASHBOARD: 'false', DASHBOARD_HOST: '127.0.0.1',
    DASHBOARD_PORT: String(SMOKE_PORT), MONEY_PRINTER_DATA_DIR: dataDir };
  const logFd = fs.openSync(path.join(LOGS, 'mac-engine.log'), 'w');
  const child = spawn(bin, [entry, '--dashboard-only'], { cwd: dataDir, env, stdio: ['ignore', logFd, logFd] });
  let status = 0; let health = 0;
  for (let i = 0; i < 60 && !status; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (child.exitCode !== null) break;
    status = await httpStatus(`http://127.0.0.1:${SMOKE_PORT}/`);
  }
  if (status) health = await httpStatus(`http://127.0.0.1:${SMOKE_PORT}/api/health`);
  const pid = child.pid;
  child.kill('SIGTERM');
  await new Promise((r) => { const t = setTimeout(() => { child.kill('SIGKILL'); r(); }, 5000); child.once('exit', () => { clearTimeout(t); r(); }); });
  fs.closeSync(logFd);
  fs.rmSync(dataDir, { recursive: true, force: true });
  return { ran: true, pid, binary: 'packaged Electron (ELECTRON_RUN_AS_NODE=1)', mode: 'paper', dashboardOnly: true,
    port: SMOKE_PORT, dashboardStatus: status, healthStatus: health, isolatedDataDir: 'temp dir (deleted)', success: status === 200 };
}

main().catch((e) => die(e.stack || String(e)));
