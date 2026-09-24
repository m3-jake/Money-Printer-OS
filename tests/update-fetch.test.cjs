const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { httpBuffer, fetchChannelManifest } = require('../desktop/update-fetch.cjs');
const { parseUpdateChannel } = require('../desktop/update-channel.cjs');
const { verifyManifest } = require('../desktop/update-auth.cjs');

function serve(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); handler(req, res); });
    server.listen(0, '127.0.0.1', () => resolve({ seen, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
  });
}
const text = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'text/plain', ...headers }); res.end(body); };
const redirect = (res, to, code = 302) => { res.writeHead(code, { location: to }); res.end(); };

test('httpBuffer follows a same-origin redirect and keeps the bearer token', async () => {
  const s = await serve((req, res) => (req.url === '/start' ? redirect(res, '/final') : text(res, 200, 'hello')));
  try {
    const buf = await httpBuffer(`${s.base}/start`, { token: 'tok', headers: { accept: 'application/json' } });
    assert.equal(buf.toString(), 'hello');
    assert.equal(s.seen.length, 2);
    assert.equal(s.seen[1].url, '/final');
    assert.equal(s.seen[1].headers.authorization, 'Bearer tok');
    assert.equal(s.seen[1].headers.accept, 'application/json');
    assert.match(s.seen[1].headers['user-agent'], /Money-Printer-OS-updater/);
  } finally { await s.close(); }
});

test('httpBuffer drops the bearer token on a cross-origin redirect but keeps the other headers', async () => {
  const blob = await serve((req, res) => text(res, 200, 'bytes'));
  const api = await serve((req, res) => redirect(res, `${blob.base}/blob`, 302));
  try {
    const buf = await httpBuffer(`${api.base}/asset`, { token: 'tok', headers: { accept: 'application/octet-stream' } });
    assert.equal(buf.toString(), 'bytes');
    assert.equal(api.seen[0].headers.authorization, 'Bearer tok');
    assert.equal(blob.seen[0].headers.authorization, undefined);
    assert.equal(blob.seen[0].headers.accept, 'application/octet-stream');
  } finally { await api.close(); await blob.close(); }
});

test('httpBuffer resolves relative Location headers and honours 301/307/308', async () => {
  const s = await serve((req, res) => {
    if (req.url === '/a') return redirect(res, 'b', 301);
    if (req.url === '/b') return redirect(res, '/c', 307);
    if (req.url === '/c') return redirect(res, '/d', 308);
    return text(res, 200, req.url);
  });
  try { assert.equal((await httpBuffer(`${s.base}/a`)).toString(), '/d'); }
  finally { await s.close(); }
});

test('httpBuffer stops a redirect loop and reports non-200 with the status', async () => {
  const s = await serve((req, res) => (req.url === '/loop' ? redirect(res, '/loop') : text(res, 404, 'nope')));
  try {
    await assert.rejects(httpBuffer(`${s.base}/loop`), /too many redirects/);
    await assert.rejects(httpBuffer(`${s.base}/missing`), (e) => e.status === 404 && /HTTP 404/.test(e.message));
    await assert.rejects(httpBuffer('ftp://example.invalid/x'), /unsupported update URL scheme/);
  } finally { await s.close(); }
});

test('httpBuffer refuses a body larger than maxBytes, declared or streamed, without leaking an error', async () => {
  const s = await serve((req, res) => {
    if (req.url === '/declared') return text(res, 200, 'x'.repeat(4096), { 'content-length': '4096' });
    if (req.url === '/chunked') { res.writeHead(200); res.write('x'.repeat(2048)); setTimeout(() => { res.write('x'.repeat(2048)); res.end(); }, 10); return; }
    return text(res, 200, 'x'.repeat(4096));
  });
  const stray = []; const onUncaught = (e) => stray.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    await assert.rejects(httpBuffer(`${s.base}/declared`, { maxBytes: 100 }), /4096 bytes exceeds the 100-byte limit/);
    await assert.rejects(httpBuffer(`${s.base}/chunked`, { maxBytes: 3000 }), /exceeded 3000 bytes/);
    await assert.rejects(httpBuffer(`${s.base}/small-complete`, { maxBytes: 100 }), /exceeds the 100-byte limit|exceeded 100 bytes/);
    assert.equal((await httpBuffer(`${s.base}/chunked`, { maxBytes: 5000 })).length, 4096);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(stray, []);
  } finally { process.off('uncaughtException', onUncaught); await s.close(); }
});

function githubFixture() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const asar = crypto.randomBytes(3000);
  const m = { version: '0.5.0-alpha.99', sha256: crypto.createHash('sha256').update(asar).digest('hex'), size: asar.length };
  m.signature = crypto.sign(null, Buffer.from(`${m.version}:${m.sha256}:${m.size}`), privateKey).toString('base64');
  return { publicKey, asar, manifest: m, manifestBytes: Buffer.from(JSON.stringify(m)) };
}

test('GitHub channel: release JSON -> assets -> cross-origin blob download, token only on the API origin', async () => {
  const fx = githubFixture();
  const blob = await serve((req, res) => {
    if (req.url === '/blob/manifest') return text(res, 200, fx.manifestBytes);
    if (req.url === '/blob/asar') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(fx.asar); }
    return text(res, 404, 'no');
  });
  const api = await serve((req, res) => {
    if (req.headers.authorization !== 'Bearer tok') return text(res, 404, '{"message":"Not Found"}');
    if (req.url === '/repos/o/r/releases/latest') {
      return text(res, 200, JSON.stringify({ tag_name: 'v0.5.0-alpha.99', name: 'Money Printer OS v0.5.0-alpha.99', published_at: '2026-09-25T00:00:00Z', draft: false, prerelease: false,
        assets: [{ name: 'SHA256SUMS.txt', url: `${api.base}/assets/9`, size: 10 }, { name: 'manifest.json', url: `${api.base}/assets/1`, size: fx.manifestBytes.length }, { name: 'app.asar', url: `${api.base}/assets/2`, size: fx.asar.length }] }), { 'content-type': 'application/json' });
    }
    if (req.url === '/assets/1' || req.url === '/assets/2') {
      if (req.headers.accept !== 'application/octet-stream') return text(res, 415, 'need octet-stream');
      return redirect(res, `${blob.base}/blob/${req.url === '/assets/1' ? 'manifest' : 'asar'}`);
    }
    return text(res, 404, 'no');
  });
  try {
    const channel = { ...parseUpdateChannel('https://github.com/o/r'), releaseApiUrl: `${api.base}/repos/o/r/releases/latest` };
    const r = await fetchChannelManifest(channel, { token: 'tok', userAgent: 'Money-Printer-OS-updater/test' });
    assert.deepEqual(r.manifest, fx.manifest);
    assert.equal(r.release.tag, 'v0.5.0-alpha.99');
    assert.equal(r.release.draft, false);
    assert.equal(r.package.url, `${api.base}/assets/2`);
    assert.equal(r.package.size, fx.asar.length);
    assert.equal(verifyManifest(r.manifest, { remote: true, publicKey: fx.publicKey }), true);
    const buf = await r.package.download();
    assert.equal(Buffer.compare(buf, fx.asar), 0);
    assert.equal(api.seen[0].url, '/repos/o/r/releases/latest');
    assert.equal(api.seen[0].headers.accept, 'application/vnd.github+json');
    assert.equal(api.seen[0].headers['x-github-api-version'], '2022-11-28');
    assert.equal(api.seen[0].headers['user-agent'], 'Money-Printer-OS-updater/test');
    for (const hit of api.seen) assert.equal(hit.headers.authorization, 'Bearer tok');
    for (const hit of blob.seen) assert.equal(hit.headers.authorization, undefined, `token leaked to ${hit.url}`);
  } finally { await api.close(); await blob.close(); }
});

test('GitHub channel: a 404 explains the private-repo token, and a rejected token says so', async () => {
  const api = await serve((req, res) => text(res, req.headers.authorization ? 404 : 404, '{"message":"Not Found"}'));
  try {
    const channel = { ...parseUpdateChannel('https://github.com/o/r'), releaseApiUrl: `${api.base}/repos/o/r/releases/latest` };
    await assert.rejects(fetchChannelManifest(channel, {}), /HTTP 404 from GitHub for o\/r \(latest\): .*MONEY_PRINTER_UPDATE_TOKEN/);
    await assert.rejects(fetchChannelManifest(channel, { token: 'bad' }), /HTTP 404 from GitHub for o\/r \(latest\): the token cannot see/);
  } finally { await api.close(); }
  const forbid = await serve((req, res) => text(res, 403, '{"message":"rate limit"}'));
  try {
    const channel = { ...parseUpdateChannel('https://github.com/o/r/releases/tag/v9'), releaseApiUrl: `${forbid.base}/repos/o/r/releases/tags/v9` };
    await assert.rejects(fetchChannelManifest(channel, {}), /HTTP 403 from GitHub for o\/r \(v9\): rate-limited/);
  } finally { await forbid.close(); }
});

test('GitHub channel: a release without the signed manifest asset is refused before any download', async () => {
  const api = await serve((req, res) => text(res, 200, JSON.stringify({ tag_name: 'v2', assets: [{ name: 'app.asar', url: `${api.base}/assets/2`, size: 1 }, { name: 'manifest.unsigned.json', url: `${api.base}/assets/3`, size: 1 }] })));
  try {
    const channel = { ...parseUpdateChannel('https://github.com/o/r'), releaseApiUrl: `${api.base}/repos/o/r/releases/latest` };
    await assert.rejects(fetchChannelManifest(channel, {}), /release v2 has no manifest\.json asset/);
    assert.equal(api.seen.length, 1);
  } finally { await api.close(); }
  const noAsar = await serve((req, res) => text(res, 200, JSON.stringify({ tag_name: 'v3', assets: [{ name: 'manifest.json', url: `${noAsar.base}/assets/1`, size: 1 }] })));
  try {
    const channel = { ...parseUpdateChannel('https://github.com/o/r'), releaseApiUrl: `${noAsar.base}/repos/o/r/releases/latest` };
    await assert.rejects(fetchChannelManifest(channel, {}), /release v3 has no app\.asar asset/);
  } finally { await noAsar.close(); }
});

test('static channel: manifest.json + app.asar next to each other, never with a token', async () => {
  const fx = githubFixture();
  const s = await serve((req, res) => {
    if (req.url === '/dl/manifest.json') return text(res, 200, fx.manifestBytes, { 'content-type': 'application/json' });
    if (req.url === '/dl/app.asar') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(fx.asar); }
    return text(res, 404, 'no');
  });
  try {
    const channel = parseUpdateChannel(`${s.base}/dl/`);
    const r = await fetchChannelManifest(channel, { token: 'should-not-be-sent' });
    assert.deepEqual(r.manifest, fx.manifest);
    assert.equal(r.release, null);
    assert.equal(r.package.size, null);
    assert.equal(Buffer.compare(await r.package.download(), fx.asar), 0);
    for (const hit of s.seen) assert.equal(hit.headers.authorization, undefined);
    assert.deepEqual(s.seen.map((h) => h.url), ['/dl/manifest.json', '/dl/app.asar']);
  } finally { await s.close(); }
  const junk = await serve((req, res) => text(res, 200, '<html>not json</html>'));
  try { await assert.rejects(fetchChannelManifest(parseUpdateChannel(junk.base), {}), /is not valid JSON/); }
  finally { await junk.close(); }
});
