import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, pickDraft, run } from '../scripts/release-publish.mjs';
import { nextVersion, validVersion, applyVersion } from '../scripts/release-cut.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-reltools-'));

test('release-cut: version bump and file rewrite', () => {
  assert.equal(nextVersion('0.5.0-alpha.60'), '0.5.0-alpha.61');
  assert.equal(nextVersion('1.2.9'), '1.2.10');
  assert.ok(validVersion('0.5.0-alpha.61'));
  assert.ok(!validVersion('v0.5.0'));
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '0.5.0-alpha.60' }));
  fs.writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify({ version: '0.5.0-alpha.60', packages: { '': { version: '0.5.0-alpha.60' } } }));
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src/robinhoodTransport.js'), "const A=1;\nconst APP_VERSION='0.5.0-alpha.59';\n");
  const touched = applyVersion(d, '0.5.0-alpha.61');
  assert.deepEqual(touched, ['package.json', 'package-lock.json', 'src/robinhoodTransport.js']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'package.json'))).version, '0.5.0-alpha.61');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'package-lock.json'))).packages[''].version, '0.5.0-alpha.61');
  assert.match(fs.readFileSync(path.join(d, 'src/robinhoodTransport.js'), 'utf8'), /APP_VERSION='0\.5\.0-alpha\.61'/);
});

test('release-cut: the real repo carries a bumpable APP_VERSION', () => {
  assert.match(fs.readFileSync(new URL('../src/robinhoodTransport.js', import.meta.url), 'utf8'), /const APP_VERSION='[^']*';/);
});

test('release-publish: args and draft selection', () => {
  assert.throws(() => parseArgs([]), /--key/);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
  assert.throws(() => parseArgs(['--key', 'k', '--tag', 'latest']), /bad --tag/);
  const rel = (tag, draft, at, assets) => ({ id: tag, tag_name: tag, draft, created_at: at, assets });
  const asar = { id: 7, name: 'app.asar', size: 3 };
  const list = [rel('v1', false, '2026-09-01', [asar]), rel('v2', true, '2026-09-02', [asar]), rel('v3', true, '2026-09-03', [asar, { id: 9, name: 'manifest.json' }])];
  const p = pickDraft(list);
  assert.equal(p.release.tag_name, 'v3');
  assert.equal(p.oldManifest.id, 9);
  assert.equal(pickDraft(list, 'v2').release.tag_name, 'v2');
  assert.throws(() => pickDraft(list, 'v1'), /no draft release for v1/);
  assert.throws(() => pickDraft([rel('v4', true, 'x', [])]), /no app.asar/);
});

function mockGithub({ assetBytes = Buffer.from('abc') } = {}) {
  const calls = [];
  const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body, arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET', auth = (init.headers || {}).authorization || null;
    calls.push({ host: u.host, path: u.pathname, method, auth });
    if (u.host === 'api.github.com' && u.pathname === '/repos/o/r/releases') return res(200, [{ id: 42, tag_name: 'v0.5.0-alpha.61', draft: true, created_at: '2026-09-26', assets: [{ id: 7, name: 'app.asar', size: assetBytes.length }, { id: 8, name: 'manifest.json' }] }]);
    if (u.pathname === '/repos/o/r/releases/assets/7') return res(302, null, { location: 'https://objects.example.net/app.asar?sig=1' });
    if (u.host === 'objects.example.net') return res(200, assetBytes);
    if (u.pathname === '/repos/o/r/releases/assets/8' && method === 'DELETE') return res(204, null);
    if (u.host === 'uploads.github.com' && method === 'POST') return res(201, { id: 99 });
    if (u.pathname === '/repos/o/r/releases/42' && method === 'PATCH') return res(200, { tag_name: 'v0.5.0-alpha.61', html_url: 'https://github.com/o/r/releases/tag/v0.5.0-alpha.61', draft: false, body: JSON.parse(init.body) });
    return res(404, {});
  };
  return { fetchImpl, calls };
}

test('release-publish: full flow signs, replaces manifest, publishes; token never leaves GitHub', async () => {
  const { fetchImpl, calls } = mockGithub();
  const d = tmp(), key = path.join(d, 'k.pem');
  fs.writeFileSync(key, 'not a real key');
  let signed = null;
  const out = await run({ key, repo: 'o/r', tag: null, dryRun: false }, {
    fetchImpl, token: 'TKN', tmpRoot: d, log: () => {},
    runSign: (asar, k, manifest) => { signed = { asar: fs.readFileSync(asar, 'utf8'), k }; fs.writeFileSync(manifest, '{"signature":"x"}'); },
  });
  assert.equal(out.tag, 'v0.5.0-alpha.61');
  assert.deepEqual(signed, { asar: 'abc', k: key });
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/assets/8')), 'old manifest removed');
  assert.ok(calls.some((c) => c.host === 'uploads.github.com' && c.method === 'POST'));
  assert.ok(calls.some((c) => c.method === 'PATCH'));
  for (const c of calls) if (!c.host.endsWith('github.com')) assert.equal(c.auth, null, `token sent to ${c.host}`);
});

test('release-publish: dry run and failures publish nothing', async () => {
  const a = mockGithub();
  const out = await run({ key: null, repo: 'o/r', dryRun: true }, { fetchImpl: a.fetchImpl, token: 'T', tmpRoot: tmp(), log: () => {} });
  assert.equal(out.dryRun, true);
  assert.ok(!a.calls.some((c) => c.method !== 'GET'));
  const b = mockGithub();
  const d = tmp(), key = path.join(d, 'k.pem'); fs.writeFileSync(key, 'x');
  await assert.rejects(run({ key, repo: 'o/r', dryRun: false }, { fetchImpl: b.fetchImpl, token: 'T', tmpRoot: d, log: () => {}, runSign: () => { throw new Error('signing failed'); } }), /signing failed/);
  assert.ok(!b.calls.some((c) => c.method !== 'GET'));
  await assert.rejects(run({ key, repo: 'o/r' }, { fetchImpl: b.fetchImpl, token: '', log: () => {} }), /MPO_RELEASE_TOKEN/);
  const c = mockGithub({ assetBytes: Buffer.from('abc') });
  const bad = async (url, init) => { const r = await c.fetchImpl(url, init); if (new URL(url).host === 'objects.example.net') return { ...r, arrayBuffer: async () => Buffer.from('ab') }; return r; };
  await assert.rejects(run({ key, repo: 'o/r' }, { fetchImpl: bad, token: 'T', tmpRoot: d, log: () => {}, runSign: () => {} }), /downloaded 2 bytes/);
});
