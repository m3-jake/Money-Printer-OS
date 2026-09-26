#!/usr/bin/env node
// Money Printer OS — one-command sign + publish of a release draft (bing, on the key-holding machine).
//
//   node scripts/release-publish.mjs --key <release-private-key.pem> [--tag v0.5.0-alpha.61] [--dry-run]
//   npm run release:publish -- --key <release-private-key.pem>
//
// What it does, in order (docs/RELEASE-CHANNEL.md, "Cutting a release"):
//   1. finds the newest DRAFT release of the repo (or the draft for --tag) that .github/workflows/release.yml made;
//   2. downloads its app.asar into a temp folder;
//   3. runs `scripts/sign-manifest.mjs sign` then `verify` on it (the same checks the installed app makes);
//   4. uploads manifest.json to the draft (replacing an older manifest.json asset);
//   5. publishes the draft as the latest, non-pre-release release.
// Installed copies then pick it up on their next check (within about 10 minutes) and update themselves.
//
// Token: MPO_RELEASE_TOKEN (or GITHUB_TOKEN) in the environment — a fine-grained token for this one
// repository with Contents: Read and write. It is never printed. It is NOT the read-only
// MONEY_PRINTER_UPDATE_TOKEN the installed apps use.
// The private key never leaves sign-manifest.mjs, which refuses to run inside an agent session.
// --dry-run stops after the download and prints what would be signed, uploaded and published.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPO = 'm3-jake/Money-Printer-OS';
const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';
const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Money-Printer-OS-release' };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(argv) {
  const o = { key: null, tag: null, repo: process.env.MPO_RELEASE_REPO || DEFAULT_REPO, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key') o.key = argv[++i];
    else if (a === '--tag') o.tag = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error(`bad --repo: ${o.repo}`);
  if (o.tag && !/^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(o.tag)) throw new Error(`bad --tag: ${o.tag}`);
  if (!o.dryRun && !o.key) throw new Error('--key <release-private-key.pem> is required (or use --dry-run)');
  return o;
}

async function gh(fetchImpl, token, url, init = {}) {
  const res = await fetchImpl(url, { ...init, headers: { ...HEADERS, authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  if (!res.ok) {
    const hint = res.status === 404 ? ' (private repo: check the token can see this repository)' : res.status === 403 || res.status === 401 ? ' (token lacks Contents: Read and write, or has expired)' : '';
    throw Object.assign(new Error(`GitHub ${init.method || 'GET'} ${new URL(url).pathname} -> HTTP ${res.status}${hint}`), { status: res.status });
  }
  return res;
}

// Newest draft (by created_at), or the draft whose tag is `tag`. Published releases are never re-signed here.
export function pickDraft(releases, tag = null) {
  const drafts = (releases || []).filter((r) => r && r.draft);
  const hit = tag ? drafts.find((r) => r.tag_name === tag) : drafts.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (!hit) throw new Error(tag ? `no draft release for ${tag} (already published, or the release build has not finished)` : 'no draft release found: push a v* tag (npm run release:cut) and wait for the "Release build" workflow to finish');
  const asar = (hit.assets || []).find((a) => a.name === 'app.asar');
  if (!asar) throw new Error(`draft ${hit.tag_name || hit.name} has no app.asar asset yet (is the release build still running?)`);
  return { release: hit, asar, oldManifest: (hit.assets || []).find((a) => a.name === 'manifest.json') || null };
}

// GitHub answers an asset download with a 302 to a pre-signed storage URL that must NOT get the token.
export async function downloadAsset(fetchImpl, token, repo, asset, dest) {
  const first = await fetchImpl(`${API}/repos/${repo}/releases/assets/${asset.id}`, { redirect: 'manual', headers: { ...HEADERS, accept: 'application/octet-stream', authorization: `Bearer ${token}` } });
  let res = first;
  if (first.status >= 300 && first.status < 400) {
    const loc = first.headers.get('location');
    if (!loc) throw new Error('asset redirect without a location');
    res = await fetchImpl(loc, { headers: { 'user-agent': HEADERS['user-agent'] } });
  }
  if (!res.ok) throw new Error(`downloading ${asset.name} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (Number.isFinite(asset.size) && asset.size > 0 && buf.length !== asset.size) throw new Error(`downloaded ${buf.length} bytes, release says ${asset.size}`);
  fs.writeFileSync(dest, buf);
  return buf.length;
}

export function signAndVerify(asarPath, keyPath, manifestPath, run = spawnSync) {
  const script = path.join(ROOT, 'scripts', 'sign-manifest.mjs');
  const sign = run(process.execPath, [script, 'sign', '--asar', asarPath, '--key', keyPath, '--out', manifestPath], { stdio: 'inherit' });
  if (sign.status !== 0) throw new Error('signing failed (see the message above); nothing was uploaded or published');
  const verify = run(process.execPath, [script, 'verify', '--manifest', manifestPath, '--asar', asarPath], { stdio: 'inherit' });
  if (verify.status !== 0) throw new Error('the signed manifest did not verify; nothing was uploaded or published');
}

export async function uploadManifest(fetchImpl, token, repo, release, oldManifest, manifestPath) {
  if (oldManifest) await gh(fetchImpl, token, `${API}/repos/${repo}/releases/assets/${oldManifest.id}`, { method: 'DELETE' });
  const body = fs.readFileSync(manifestPath);
  await gh(fetchImpl, token, `${UPLOADS}/repos/${repo}/releases/${release.id}/assets?name=manifest.json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
}

export async function publish(fetchImpl, token, repo, release) {
  const res = await gh(fetchImpl, token, `${API}/repos/${repo}/releases/${release.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft: false, prerelease: false, make_latest: 'true' }) });
  return res.json();
}

export async function run(opts, { fetchImpl = globalThis.fetch, token = process.env.MPO_RELEASE_TOKEN || process.env.GITHUB_TOKEN, runSign = signAndVerify, log = console.log, tmpRoot = os.tmpdir() } = {}) {
  if (!token) throw new Error('set MPO_RELEASE_TOKEN (fine-grained token for this repo, Contents: Read and write) in this terminal first');
  if (!opts.dryRun && !fs.existsSync(opts.key)) throw new Error('the --key file does not exist');
  const list = await (await gh(fetchImpl, token, `${API}/repos/${opts.repo}/releases?per_page=30`)).json();
  const { release, asar, oldManifest } = pickDraft(list, opts.tag);
  log(`Draft ${release.tag_name} (${asar.size} byte app.asar)`);
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'mpo-release-'));
  const asarPath = path.join(dir, 'app.asar'), manifestPath = path.join(dir, 'manifest.json');
  const bytes = await downloadAsset(fetchImpl, token, opts.repo, asar, asarPath);
  log(`Downloaded app.asar (${bytes} bytes) to ${dir}`);
  if (opts.dryRun) { log(`Dry run: would sign, upload manifest.json${oldManifest ? ' (replacing the old one)' : ''} and publish ${release.tag_name}.`); return { dryRun: true, tag: release.tag_name, dir }; }
  runSign(asarPath, opts.key, manifestPath);
  await uploadManifest(fetchImpl, token, opts.repo, release, oldManifest, manifestPath);
  log('Uploaded manifest.json');
  const pub = await publish(fetchImpl, token, opts.repo, release);
  log(`Published ${pub.tag_name || release.tag_name}: ${pub.html_url || ''}`);
  log('Installed copies with MONEY_PRINTER_UPDATE_TOKEN set will update within about 10 minutes (held while any real exposure is open).');
  return { dryRun: false, tag: pub.tag_name || release.tag_name, url: pub.html_url || null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await run(parseArgs(process.argv.slice(2))); }
  catch (e) { console.error(`release:publish: ${e.message}`); process.exit(1); }
}
