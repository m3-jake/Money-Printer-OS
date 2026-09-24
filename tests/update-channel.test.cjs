const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_UPDATE_CHANNEL, parseUpdateChannel, resolveUpdateChannel, resolveUpdateToken } = require('../desktop/update-channel.cjs');

test('default channel is the GitHub Releases feed of this repository', () => {
  const c = resolveUpdateChannel({});
  assert.equal(c.kind, 'github');
  assert.equal(c.url, DEFAULT_UPDATE_CHANNEL);
  assert.equal(c.owner, 'm3-jake');
  assert.equal(c.repo, 'Money-Printer-OS');
  assert.equal(c.tag, 'latest');
  assert.equal(c.releaseApiUrl, 'https://api.github.com/repos/m3-jake/Money-Printer-OS/releases/latest');
  assert.equal(c.manifestAsset, 'manifest.json');
  assert.equal(c.packageAsset, 'app.asar');
  assert.equal(c.configError, null);
  assert.match(c.label, /github\.com\/m3-jake\/Money-Printer-OS/);
  assert.equal(Object.isFrozen(c), true);
});

test('GitHub channel URL forms all resolve to the Releases API', () => {
  for (const raw of ['https://github.com/o/r', 'https://github.com/o/r/', 'https://github.com/o/r.git', 'https://www.github.com/o/r/releases', 'https://github.com/o/r/releases/latest/']) {
    const c = parseUpdateChannel(raw);
    assert.equal(c.kind, 'github', raw);
    assert.equal(c.owner, 'o');
    assert.equal(c.repo, 'r');
    assert.equal(c.tag, 'latest');
    assert.equal(c.releaseApiUrl, 'https://api.github.com/repos/o/r/releases/latest', raw);
  }
  const pinned = parseUpdateChannel('https://github.com/o/r/releases/tag/v0.5.0-alpha.54');
  assert.equal(pinned.tag, 'v0.5.0-alpha.54');
  assert.equal(pinned.releaseApiUrl, 'https://api.github.com/repos/o/r/releases/tags/v0.5.0-alpha.54');
  assert.match(pinned.label, /release v0\.5\.0-alpha\.54/);
});

test('a plain directory URL keeps the manifest.json + app.asar layout', () => {
  const c = parseUpdateChannel('https://bangbowbing.net/downloads/money-printer-os/stable/');
  assert.equal(c.kind, 'static');
  assert.equal(c.url, 'https://bangbowbing.net/downloads/money-printer-os/stable');
  assert.equal(c.manifestUrl, 'https://bangbowbing.net/downloads/money-printer-os/stable/manifest.json');
  assert.equal(c.packageUrl, 'https://bangbowbing.net/downloads/money-printer-os/stable/app.asar');
  assert.equal(c.label, 'bangbowbing.net/downloads/money-printer-os/stable');
  const lan = parseUpdateChannel('http://100.64.0.9:8080');
  assert.equal(lan.kind, 'static');
  assert.equal(lan.manifestUrl, 'http://100.64.0.9:8080/manifest.json');
});

test('MONEY_PRINTER_UPDATE_URL overrides the default; blank means default', () => {
  assert.equal(resolveUpdateChannel({ MONEY_PRINTER_UPDATE_URL: '  https://github.com/o/r  ' }).releaseApiUrl, 'https://api.github.com/repos/o/r/releases/latest');
  assert.equal(resolveUpdateChannel({ MONEY_PRINTER_UPDATE_URL: 'https://files.example.com/mpo' }).manifestUrl, 'https://files.example.com/mpo/manifest.json');
  assert.equal(resolveUpdateChannel({ MONEY_PRINTER_UPDATE_URL: '   ' }).url, DEFAULT_UPDATE_CHANNEL);
  assert.equal(resolveUpdateChannel(undefined).url, DEFAULT_UPDATE_CHANNEL);
});

test('a broken channel URL never throws: the default is used and the problem is reported', () => {
  for (const bad of ['ftp://x/y', 'not a url', 'https://github.com/only-owner', 'https://github.com/o/r/releases/tag/', 'https://example.com/dl?x=1', 'https://example.com/dl#frag']) {
    const c = resolveUpdateChannel({ MONEY_PRINTER_UPDATE_URL: bad });
    assert.equal(c.url, DEFAULT_UPDATE_CHANNEL, bad);
    assert.equal(c.kind, 'github');
    assert.match(String(c.configError), /MONEY_PRINTER_UPDATE_URL ignored/, bad);
    assert.throws(() => parseUpdateChannel(bad), Error, bad);
  }
});

test('the channel token is optional and trimmed', () => {
  assert.equal(resolveUpdateToken({}), '');
  assert.equal(resolveUpdateToken({ MONEY_PRINTER_UPDATE_TOKEN: '' }), '');
  assert.equal(resolveUpdateToken({ MONEY_PRINTER_UPDATE_TOKEN: '  github_pat_x  ' }), 'github_pat_x');
  assert.equal(resolveUpdateToken(undefined), '');
});
