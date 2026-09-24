// Money Printer OS — HTTP plumbing for the updater (desktop/main.cjs).
//
// httpBuffer(url, opts) GETs a URL into a Buffer, following a bounded number of redirects. The
// Authorization header is only re-sent while the redirect stays on the same origin: GitHub answers
// an authenticated release-asset request with a 302 to a pre-signed objects.githubusercontent.com
// URL that rejects a bearer token, and a static host may bounce to a CDN the same way.
//
// fetchChannelManifest(channel, opts) resolves a channel from desktop/update-channel.cjs into the
// release manifest plus a `package.download()` closure for the matching app.asar. It moves bytes
// only: signature, SHA-256 and size checks stay in desktop/main.cjs and desktop/update-auth.cjs.
const http = require('node:http');
const https = require('node:https');

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_REDIRECTS = 5;
// An app.asar is ~30 MB. The cap only stops a misconfigured channel from streaming forever.
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_USER_AGENT = 'Money-Printer-OS-updater';
const GITHUB_JSON_HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };

function httpBuffer(url, opts = {}) {
  const o = typeof opts === 'string' ? { token: opts } : (opts || {});
  const token = o.token ? String(o.token) : '';
  const headers = o.headers || {};
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxRedirects = Number.isInteger(o.maxRedirects) ? o.maxRedirects : DEFAULT_MAX_REDIRECTS;
  const maxBytes = Number(o.maxBytes) > 0 ? Number(o.maxBytes) : DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const visit = (target, hops, sendAuth) => {
      let u;
      try { u = new URL(target); } catch { return reject(new Error(`invalid update URL: ${target}`)); }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error(`unsupported update URL scheme: ${u.protocol}`));
      const lib = u.protocol === 'https:' ? https : http;
      const h = { 'user-agent': DEFAULT_USER_AGENT };
      for (const [k, v] of Object.entries(headers)) if (v != null && v !== '') h[String(k).toLowerCase()] = String(v);
      if (token && sendAuth) h.authorization = `Bearer ${token}`;
      const req = lib.get(u, { headers: h, timeout: timeoutMs }, (res) => {
        const code = res.statusCode || 0;
        if (REDIRECTS.has(code) && res.headers.location) {
          res.resume();
          if (hops >= maxRedirects) return reject(new Error(`too many redirects fetching ${url}`));
          let next;
          try { next = new URL(res.headers.location, u); } catch { return reject(new Error(`invalid redirect from ${target}`)); }
          return visit(next.toString(), hops + 1, sendAuth && next.origin === u.origin);
        }
        if (code !== 200) { res.resume(); return reject(Object.assign(new Error(`HTTP ${code}`), { status: code, url: target })); }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) { res.resume(); req.destroy(); return reject(new Error(`download of ${declared} bytes exceeds the ${maxBytes}-byte limit: ${url}`)); }
        // Settle first, then tear down WITHOUT an error: a small response can already be complete and its
        // socket back in the agent pool by the time 'data' runs, and destroying with an error would then
        // emit on a socket nobody listens to.
        const chunks = []; let received = 0, tooBig = false;
        res.on('data', (c) => {
          if (tooBig) return;
          received += c.length;
          if (received > maxBytes) { tooBig = true; reject(new Error(`download exceeded ${maxBytes} bytes: ${url}`)); res.destroy(); req.destroy(); return; }
          chunks.push(c);
        });
        res.on('end', () => { if (!tooBig) resolve(Buffer.concat(chunks)); });
        res.on('error', (e) => { if (!tooBig) reject(e); });
      });
      req.on('timeout', () => req.destroy(new Error('update timeout')));
      req.on('error', reject);
    };
    visit(String(url), 0, true);
  });
}

function parseJson(buf, what) {
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new Error(`${what} is not valid JSON`); }
}

function githubAuthHint(channel, token, e) {
  const who = `${channel.owner}/${channel.repo} (${channel.tag})`;
  if (e && e.status === 404) return new Error(`HTTP 404 from GitHub for ${who}: ${token ? 'the token cannot see this repository, or it has no published release yet' : 'the repository is private or has no published release yet; a private repository needs MONEY_PRINTER_UPDATE_TOKEN in .env'}`);
  if (e && (e.status === 401 || e.status === 403)) return new Error(`HTTP ${e.status} from GitHub for ${who}: ${token ? 'MONEY_PRINTER_UPDATE_TOKEN was rejected or lacks Contents: read' : 'rate-limited or forbidden; set MONEY_PRINTER_UPDATE_TOKEN in .env'}`);
  return e;
}

async function fetchChannelManifest(channel, opts = {}) {
  const token = opts.token ? String(opts.token) : '';
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT;
  const timeoutMs = opts.timeoutMs;
  const maxBytes = opts.maxBytes;
  if (!channel || !channel.kind) throw new Error('no update channel');
  if (channel.kind === 'github') {
    let release;
    try {
      release = parseJson(await httpBuffer(channel.releaseApiUrl, { token, timeoutMs, headers: { ...GITHUB_JSON_HEADERS, 'user-agent': userAgent } }), 'GitHub release');
    } catch (e) { throw githubAuthHint(channel, token, e); }
    const tag = release && release.tag_name ? String(release.tag_name) : channel.tag;
    const assets = Array.isArray(release && release.assets) ? release.assets : [];
    const asset = (name) => assets.find((a) => a && a.name === name && typeof a.url === 'string');
    const manifestAsset = asset(channel.manifestAsset);
    const packageAsset = asset(channel.packageAsset);
    if (!manifestAsset) throw new Error(`release ${tag} has no ${channel.manifestAsset} asset — it has not been signed and published for the updater yet`);
    if (!packageAsset) throw new Error(`release ${tag} has no ${channel.packageAsset} asset`);
    const octet = { accept: 'application/octet-stream', 'user-agent': userAgent };
    const manifest = parseJson(await httpBuffer(manifestAsset.url, { token, timeoutMs, headers: octet }), `${channel.manifestAsset} from release ${tag}`);
    return {
      manifest,
      release: { tag, name: release.name || null, publishedAt: release.published_at || null, draft: release.draft === true, prerelease: release.prerelease === true },
      package: {
        url: packageAsset.url,
        size: Number.isFinite(Number(packageAsset.size)) ? Number(packageAsset.size) : null,
        download: () => httpBuffer(packageAsset.url, { token, timeoutMs, maxBytes, headers: octet }),
      },
    };
  }
  if (channel.kind === 'static') {
    const ua = { 'user-agent': userAgent };
    const manifest = parseJson(await httpBuffer(channel.manifestUrl, { timeoutMs, headers: ua }), `${channel.manifestUrl}`);
    return { manifest, release: null, package: { url: channel.packageUrl, size: null, download: () => httpBuffer(channel.packageUrl, { timeoutMs, maxBytes, headers: ua }) } };
  }
  throw new Error(`unknown update channel kind: ${channel.kind}`);
}

module.exports = { httpBuffer, fetchChannelManifest, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT };
