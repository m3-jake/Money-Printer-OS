import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readAsarFile } from '../scripts/sign-manifest.mjs';

const require = createRequire(import.meta.url);
const { verifyManifest } = require('../desktop/update-auth.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'sign-manifest.mjs');

// The asar container: [u32 4][u32 header pickle len][u32 payload len][u32 json len][json][pad][file data...]
function makeAsar(file, entries) {
  const files = {}; const datas = []; let offset = 0;
  for (const [name, buf] of Object.entries(entries)) { files[name] = { size: buf.length, offset: String(offset) }; offset += buf.length; datas.push(buf); }
  const json = Buffer.from(JSON.stringify({ files }), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const strPickle = Buffer.alloc(4 + json.length + pad); strPickle.writeUInt32LE(json.length, 0); json.copy(strPickle, 4);
  const headerPickle = Buffer.alloc(4 + strPickle.length); headerPickle.writeUInt32LE(strPickle.length, 0); strPickle.copy(headerPickle, 4);
  const sizePickle = Buffer.alloc(8); sizePickle.writeUInt32LE(4, 0); sizePickle.writeUInt32LE(headerPickle.length, 4);
  fs.writeFileSync(file, Buffer.concat([sizePickle, headerPickle, ...datas]));
}
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-sign-'));
function fixture(version = '0.5.0-alpha.99') {
  const dir = tmp();
  const asar = path.join(dir, 'app.asar');
  const readme = `# hi ${crypto.randomBytes(8).toString('hex')}\n`.repeat(7); // unique bytes per fixture: two archives never collide
  makeAsar(asar, { 'package.json': Buffer.from(JSON.stringify({ name: 'money-printer-os', version })), 'README.md': Buffer.from(readme) });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const key = path.join(dir, 'signing-key.pem');
  const pub = path.join(dir, 'signing-key.pub.pem');
  fs.writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  return { dir, asar, key, pub, version, readme };
}
// `sign` refuses under an agent session; the positive cases run with that marker removed.
function run(args, { env = {}, agent = false } = {}) {
  const e = { ...process.env, ...env };
  if (agent) e.CLAUDECODE = '1'; else delete e.CLAUDECODE;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: e });
  return { status: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
}

test('readAsarFile reads a packed file by path and rejects non-asar input', () => {
  const f = fixture();
  assert.equal(JSON.parse(readAsarFile(f.asar, 'package.json').toString()).version, f.version);
  assert.equal(readAsarFile(f.asar, 'README.md').toString(), f.readme);
  assert.throws(() => readAsarFile(f.asar, 'src/index.js'), /not in the archive/);
  const junk = path.join(f.dir, 'junk.bin'); fs.writeFileSync(junk, crypto.randomBytes(64));
  assert.throws(() => readAsarFile(junk, 'package.json'), /not an asar archive/);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('stage writes an unsigned manifest the updater will reject, versioned from the packed package.json', () => {
  const f = fixture();
  const r = run(['stage', '--asar', f.asar]);
  assert.equal(r.status, 0, r.err);
  const out = path.join(f.dir, 'manifest.unsigned.json');
  assert.equal(r.json.out, out);
  const m = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(m.version, f.version);
  assert.equal(m.sha256, sha256(f.asar));
  assert.equal(m.size, fs.statSync(f.asar).size);
  assert.equal(m.signature, null);
  assert.equal(m.unsigned, true);
  assert.throws(() => verifyManifest(m, { remote: true, publicKey: fs.readFileSync(f.pub, 'utf8') }));
  const bad = run(['stage', '--asar', f.asar, '--version', '9.9.9']);
  assert.equal(bad.status, 1);
  assert.match(bad.err, /--version 9\.9\.9 does not match/);
  const usage = run(['stage']);
  assert.equal(usage.status, 2);
  assert.match(usage.err, /stage needs --asar/);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('sign needs an explicit key, refuses inside an agent session, and refuses a key the app would not trust', () => {
  const f = fixture();
  const noKey = run(['sign', '--asar', f.asar]);
  assert.equal(noKey.status, 2);
  assert.match(noKey.err, /sign needs --key/);
  const agent = run(['sign', '--asar', f.asar, '--key', f.key, '--public-key', f.pub], { agent: true });
  assert.equal(agent.status, 1);
  assert.match(agent.err, /refuses to run inside an agent session/);
  assert.equal(fs.existsSync(path.join(f.dir, 'manifest.json')), false);
  // default public key = desktop/update-public-key.pem, which this throwaway key does not match
  const mismatch = run(['sign', '--asar', f.asar, '--key', f.key]);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.err, /does not match desktop\/update-public-key\.pem/);
  assert.equal(fs.existsSync(path.join(f.dir, 'manifest.json')), false);
  const missing = run(['sign', '--asar', f.asar, '--key', path.join(f.dir, 'nope.pem')]);
  assert.equal(missing.status, 2);
  assert.match(missing.err, /private key not found/);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('sign then verify round-trips through desktop/update-auth.cjs exactly as the app checks it', () => {
  const f = fixture();
  const signed = run(['sign', '--asar', f.asar, '--key', f.key, '--public-key', f.pub]);
  assert.equal(signed.status, 0, signed.err);
  const out = path.join(f.dir, 'manifest.json');
  assert.equal(signed.json.out, out);
  assert.equal(signed.json.signed, true);
  assert.doesNotMatch(signed.out + signed.err, /signing-key\.pem/, 'the private key path is never echoed');
  const m = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(m), ['version', 'sha256', 'size', 'signature']);
  assert.equal(m.version, f.version);
  assert.equal(verifyManifest(m, { remote: true, publicKey: fs.readFileSync(f.pub, 'utf8') }), true);
  const ok = run(['verify', '--manifest', out, '--asar', f.asar, '--public-key', f.pub]);
  assert.equal(ok.status, 0, ok.err);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.signatureOk, true);
  assert.equal(ok.json.asar.packedVersion, f.version);
  assert.deepEqual(ok.json.problems, []);
  // against the app's real public key this throwaway signature must fail
  const wrongKey = run(['verify', '--manifest', out, '--asar', f.asar]);
  assert.equal(wrongKey.status, 1);
  assert.match(wrongKey.json.problems.join(' '), /signature does not verify/);
  // a tampered field breaks the signature
  const tampered = path.join(f.dir, 'tampered.json');
  fs.writeFileSync(tampered, JSON.stringify({ ...m, size: m.size + 1 }));
  const t = run(['verify', '--manifest', tampered, '--public-key', f.pub]);
  assert.equal(t.status, 1);
  assert.match(t.json.problems.join(' '), /signature does not verify/);
  // a different archive than the one signed is caught by --asar
  const other = fixture(f.version);
  const o = run(['verify', '--manifest', out, '--asar', other.asar, '--public-key', f.pub]);
  assert.equal(o.status, 1);
  assert.match(o.json.problems.join(' '), /asar sha256/);
  // a staged (unsigned) manifest never verifies
  run(['stage', '--asar', f.asar]);
  const u = run(['verify', '--manifest', path.join(f.dir, 'manifest.unsigned.json'), '--public-key', f.pub]);
  assert.equal(u.status, 1);
  assert.match(u.json.problems.join(' '), /unsigned/);
  fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(other.dir, { recursive: true, force: true });
});
