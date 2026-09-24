#!/usr/bin/env node
// scripts/sign-manifest.mjs — updater manifest for the public release channel.
//
//   node scripts/sign-manifest.mjs stage  --asar <app.asar> [--version <v>] [--out <manifest.unsigned.json>]
//   node scripts/sign-manifest.mjs sign   --asar <app.asar> --key <ed25519-private.pem> [--version <v>] [--out <manifest.json>]
//   node scripts/sign-manifest.mjs verify --manifest <manifest.json> [--asar <app.asar>] [--public-key <pem>]
//
// The manifest is `{ version, sha256, size, signature }` and the signed payload is the literal
// string `${version}:${sha256}:${size}` — exactly what desktop/update-auth.cjs::verifyManifest
// checks (remote:true) against desktop/update-public-key.pem before an installed copy applies an
// update. `version` defaults to the package.json packed inside the asar, so the manifest can only
// describe the archive it was made from.
//
// `stage`  needs no secret: it writes the unsigned shape (signature:null) that the release workflow
//          attaches to a draft GitHub Release as manifest.unsigned.json. The updater rejects it.
// `sign`   is bing's step, by hand, on the machine that holds the Ed25519 release private key.
//          --key is mandatory and has no default; this script never searches for, guesses or logs
//          key material, refuses a key that does not match the public key the app ships with, and
//          refuses to run inside an agent session (CLAUDECODE set).
// `verify` needs no secret: it re-checks a signed manifest the way the app will, and with --asar
//          also confirms the archive's SHA-256, size and packed version. Run it before publishing.
//
// See docs/RELEASE-CHANNEL.md for where these three fit in the release flow.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { verifyManifest } = require('../desktop/update-auth.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PUBLIC_KEY = path.join(ROOT, 'desktop', 'update-public-key.pem');
// Repo-relative, always with forward slashes: the docs and the tests spell this path
// desktop/update-public-key.pem on every platform, and Windows path.relative would print a backslash.
const relPosix = (p) => (path.relative(ROOT, path.resolve(p)) || p).split(path.sep).join('/');
const USAGE = `usage:
  node scripts/sign-manifest.mjs stage  --asar <app.asar> [--version <v>] [--out <manifest.unsigned.json>]
  node scripts/sign-manifest.mjs sign   --asar <app.asar> --key <ed25519-private.pem> [--version <v>] [--out <manifest.json>] [--public-key <pem>]
  node scripts/sign-manifest.mjs verify --manifest <manifest.json> [--asar <app.asar>] [--public-key <pem>]`;

class UsageError extends Error {}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = true; else { out[k] = v; i++; }
  }
  return out;
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// Minimal asar reader: header pickle at byte 8 (length at byte 4), JSON string length at byte 12,
// JSON at byte 16, file data after the header pickle. Same layout scripts/build-unified.mjs hashes.
export function readAsarFile(asarPath, relPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) !== 16) throw new Error('not an asar archive (too short)');
    const pickleLen = head.readUInt32LE(4);
    const strLen = head.readUInt32LE(12);
    if (head.readUInt32LE(0) !== 4 || strLen + 8 > pickleLen) throw new Error('not an asar archive (bad header)');
    const json = Buffer.alloc(strLen);
    if (fs.readSync(fd, json, 0, strLen, 16) !== strLen) throw new Error('not an asar archive (truncated header)');
    let node = JSON.parse(json.toString('utf8'));
    for (const part of relPath.split('/').filter(Boolean)) {
      node = node && node.files ? node.files[part] : undefined;
      if (!node) throw new Error(`${relPath} is not in the archive`);
    }
    if (node.unpacked) throw new Error(`${relPath} is stored unpacked next to the archive`);
    if (typeof node.size !== 'number' || node.offset === undefined) throw new Error(`${relPath} is a directory`);
    const data = Buffer.alloc(node.size);
    const start = 8 + pickleLen + Number(node.offset);
    if (fs.readSync(fd, data, 0, node.size, start) !== node.size) throw new Error(`${relPath} is truncated`);
    return data;
  } finally { fs.closeSync(fd); }
}

function packedVersion(asarPath) {
  const pkg = JSON.parse(readAsarFile(asarPath, 'package.json').toString('utf8'));
  if (!pkg.version || typeof pkg.version !== 'string') throw new Error('package.json inside the archive has no version');
  return pkg.version;
}

function describeAsar(asarPath, versionArg) {
  const file = path.resolve(asarPath);
  if (!fs.existsSync(file)) throw new UsageError(`asar not found: ${file}`);
  const packed = packedVersion(file);
  const version = versionArg ? String(versionArg) : packed;
  if (versionArg && String(versionArg) !== packed) throw new Error(`--version ${versionArg} does not match the package.json packed in ${path.basename(file)} (${packed})`);
  return { file, version, packedVersion: packed, sha256: sha256File(file), size: fs.statSync(file).size };
}

const payloadOf = (m) => `${m.version}:${m.sha256}:${m.size}`;

function loadPublicKey(file) {
  const pem = fs.readFileSync(path.resolve(file), 'utf8');
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} is not an Ed25519 public key`);
  return pem;
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function cmdStage(args) {
  if (!args.asar || args.asar === true) throw new UsageError('stage needs --asar <app.asar>');
  const a = describeAsar(args.asar, args.version);
  const out = path.resolve(args.out && args.out !== true ? args.out : path.join(path.dirname(a.file), 'manifest.unsigned.json'));
  writeJson(out, { version: a.version, sha256: a.sha256, size: a.size, signature: null, unsigned: true,
    note: 'Not signed. The updater rejects this file. Produce manifest.json with `node scripts/sign-manifest.mjs sign` on the machine holding the release private key.' });
  console.log(JSON.stringify({ staged: true, out, version: a.version, sha256: a.sha256, size: a.size, signed: false }, null, 2));
  return 0;
}

function cmdSign(args) {
  if (process.env.CLAUDECODE) {
    console.error('sign-manifest: `sign` refuses to run inside an agent session. Bing runs this by hand on the machine that holds the release private key:');
    console.error('    node scripts/sign-manifest.mjs sign --asar <app.asar> --key <ed25519-private.pem>');
    return 1;
  }
  if (!args.asar || args.asar === true) throw new UsageError('sign needs --asar <app.asar>');
  if (!args.key || args.key === true) throw new UsageError('sign needs --key <ed25519-private.pem>; there is no default and this script never looks for one');
  const keyFile = path.resolve(args.key);
  if (!fs.existsSync(keyFile)) throw new UsageError(`private key not found: ${keyFile}`);
  const passphrase = process.env.MPO_SIGNING_KEY_PASSPHRASE;
  let privateKey;
  try { privateKey = crypto.createPrivateKey(passphrase ? { key: fs.readFileSync(keyFile), passphrase } : fs.readFileSync(keyFile)); }
  catch (e) { throw new Error(`cannot load the private key (${e.message}); an encrypted PEM takes its passphrase from MPO_SIGNING_KEY_PASSPHRASE`); }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`the private key is ${privateKey.asymmetricKeyType}, not Ed25519; the app only verifies Ed25519 signatures`);
  const publicKeyFile = args['public-key'] && args['public-key'] !== true ? args['public-key'] : DEFAULT_PUBLIC_KEY;
  const publicKey = loadPublicKey(publicKeyFile);
  const a = describeAsar(args.asar, args.version);
  const m = { version: a.version, sha256: a.sha256, size: a.size };
  m.signature = crypto.sign(null, Buffer.from(payloadOf(m)), privateKey).toString('base64');
  try { verifyManifest(m, { remote: true, publicKey }); }
  catch { throw new Error(`the private key does not match ${relPosix(publicKeyFile)}; the app would reject this manifest, so nothing was written`); }
  const out = path.resolve(args.out && args.out !== true ? args.out : path.join(path.dirname(a.file), 'manifest.json'));
  writeJson(out, m);
  console.log(JSON.stringify({ signed: true, out, version: m.version, sha256: m.sha256, size: m.size, publicKey: relPosix(publicKeyFile) }, null, 2));
  return 0;
}

function cmdVerify(args) {
  if (!args.manifest || args.manifest === true) throw new UsageError('verify needs --manifest <manifest.json>');
  const file = path.resolve(args.manifest);
  if (!fs.existsSync(file)) throw new UsageError(`manifest not found: ${file}`);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = [];
  if (typeof m.version !== 'string' || !m.version) problems.push('version missing');
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) problems.push('sha256 is not a 64-hex digest');
  if (!Number.isInteger(m.size) || m.size <= 0) problems.push('size is not a positive integer');
  if (typeof m.signature !== 'string' || !m.signature) problems.push(m.unsigned || m.signature === null ? 'manifest is unsigned (staged, not signed)' : 'signature missing');
  const publicKeyFile = args['public-key'] && args['public-key'] !== true ? args['public-key'] : DEFAULT_PUBLIC_KEY;
  let signatureOk = false;
  if (!problems.length) {
    try { signatureOk = verifyManifest(m, { remote: true, publicKey: loadPublicKey(publicKeyFile) }) === true; }
    catch (e) { problems.push(`signature does not verify against ${path.relative(ROOT, path.resolve(publicKeyFile)) || publicKeyFile} (${e.message})`); }
  }
  let asar = null;
  if (args.asar && args.asar !== true) {
    const a = describeAsar(args.asar);
    asar = { file: a.file, sha256: a.sha256, size: a.size, packedVersion: a.packedVersion };
    if (a.sha256 !== m.sha256) problems.push(`asar sha256 ${a.sha256} != manifest ${m.sha256}`);
    if (a.size !== m.size) problems.push(`asar size ${a.size} != manifest ${m.size}`);
    if (a.packedVersion !== m.version) problems.push(`asar packs version ${a.packedVersion} but the manifest says ${m.version}`);
  }
  const ok = problems.length === 0 && signatureOk;
  console.log(JSON.stringify({ ok, manifest: file, version: m.version, sha256: m.sha256, size: m.size, signatureOk, asar, problems }, null, 2));
  return ok ? 0 : 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const verb = args._[0];
  try {
    if (verb === 'stage') return cmdStage(args);
    if (verb === 'sign') return cmdSign(args);
    if (verb === 'verify') return cmdVerify(args);
    console.error(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof UsageError) { console.error(`sign-manifest: ${e.message}\n${USAGE}`); return 2; }
    console.error(`sign-manifest: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
