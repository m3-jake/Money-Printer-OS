// Money Printer OS — remote update channel (shared by desktop/main.cjs and src/dashboard.js).
//
// The channel is where an installed copy looks for a newer, Ed25519-signed release. It is one
// URL: MONEY_PRINTER_UPDATE_URL from the user's .env when set, otherwise DEFAULT_UPDATE_CHANNEL.
// Two shapes are understood:
//
//   github  https://github.com/<owner>/<repo>[/releases/latest | /releases/tag/<tag>]
//           The GitHub Releases API: the release's `manifest.json` and `app.asar` assets.
//           A private repo needs MONEY_PRINTER_UPDATE_TOKEN (fine-grained PAT, Contents: read).
//   static  any other http(s) directory URL -> <url>/manifest.json and <url>/app.asar
//           (the original bangbowbing.net layout; still valid for any plain file host).
//
// The channel only moves bytes. Whatever it returns, desktop/update-auth.cjs verifies the
// manifest's Ed25519 signature against desktop/update-public-key.pem and desktop/main.cjs checks
// the archive's SHA-256 and size before anything is installed. A bad or unreachable channel is a
// reported updater ERROR, never a crash: resolveUpdateChannel() falls back to the default and
// carries the problem in `configError`.
const DEFAULT_UPDATE_CHANNEL = 'https://github.com/m3-jake/Money-Printer-OS';
const GITHUB_API = 'https://api.github.com';
const MANIFEST_ASSET = 'manifest.json';
const PACKAGE_ASSET = 'app.asar';

function parseUpdateChannel(raw) {
  const url = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('update channel is empty');
  let u;
  try { u = new URL(url); } catch { throw new Error(`update channel is not a URL: ${url}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`update channel must be http(s): ${url}`);
  if (u.search || u.hash) throw new Error(`update channel must not carry a query or fragment: ${url}`);
  const host = u.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') {
    const m = u.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/releases(?:\/latest|\/tag\/([^/]+))?)?\/?$/);
    if (!m) throw new Error(`GitHub update channel must look like https://github.com/<owner>/<repo>[/releases/latest|/releases/tag/<tag>]: ${url}`);
    const [, owner, repo, rawTag] = m;
    const tag = rawTag ? decodeURIComponent(rawTag) : 'latest';
    return Object.freeze({
      kind: 'github', url, owner, repo, tag,
      releaseApiUrl: `${GITHUB_API}/repos/${owner}/${repo}/releases/${tag === 'latest' ? 'latest' : `tags/${encodeURIComponent(tag)}`}`,
      manifestAsset: MANIFEST_ASSET, packageAsset: PACKAGE_ASSET,
      label: `github.com/${owner}/${repo} · ${tag === 'latest' ? 'latest release' : `release ${tag}`}`,
      configError: null,
    });
  }
  return Object.freeze({
    kind: 'static', url,
    manifestUrl: `${url}/${MANIFEST_ASSET}`, packageUrl: `${url}/${PACKAGE_ASSET}`,
    label: `${u.host}${u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')}`,
    configError: null,
  });
}

// Never throws: a broken MONEY_PRINTER_UPDATE_URL must not take the supervisor down with it.
function resolveUpdateChannel(env = process.env) {
  const raw = env && env.MONEY_PRINTER_UPDATE_URL;
  if (raw == null || String(raw).trim() === '') return parseUpdateChannel(DEFAULT_UPDATE_CHANNEL);
  try { return parseUpdateChannel(raw); }
  catch (e) {
    return Object.freeze({ ...parseUpdateChannel(DEFAULT_UPDATE_CHANNEL), configError: `MONEY_PRINTER_UPDATE_URL ignored (${e.message}); using ${DEFAULT_UPDATE_CHANNEL}` });
  }
}

function resolveUpdateToken(env = process.env) {
  const t = env && env.MONEY_PRINTER_UPDATE_TOKEN;
  return t == null ? '' : String(t).trim();
}

module.exports = { DEFAULT_UPDATE_CHANNEL, GITHUB_API, MANIFEST_ASSET, PACKAGE_ASSET, parseUpdateChannel, resolveUpdateChannel, resolveUpdateToken };
