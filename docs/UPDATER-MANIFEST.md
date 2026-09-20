# Updater manifest signing (public download channel)

This document is the exact, verbatim recipe from `.workflow/scratch/PACKAGING.md` §4 for
producing the signed `manifest.json` that `desktop/main.cjs` fetches from
`https://bangbowbing.net/downloads/money-printer-os/stable/manifest.json` and that
`desktop/update-auth.cjs::verifyManifest()` checks before an installed copy will apply an
update.

**No agent runs this command, ever.** It requires the release signing private key, which
does not exist anywhere in this repository and which no agent session may search for, read,
name, or infer. `desktop/update-public-key.pem` (the public half) is the only key material
that may be read by an agent, and confirms the key type is Ed25519
(`openssl pkey -pubin -in desktop/update-public-key.pem -text`).

## What the updater verifies

`desktop/update-auth.cjs::verifyManifest(m, { remote, token, peer, publicKey })` expects a
manifest shaped `{ version, sha256, size, signature }`. For the public/remote channel
(`remote: true`), it verifies with:

```js
crypto.verify(null, Buffer.from(payload), publicKey, Buffer.from(m.signature, 'base64'))
```

where `payload` is the literal string:

```
`${version}:${sha256}:${size}`
```

`crypto.verify`/`crypto.sign` called with a `null` algorithm only work with a key whose type
carries its own algorithm — confirmed Ed25519 here — so the signing counterpart is an
Ed25519 **private** key, never RSA/ECDSA.

## Signing recipe (bing runs this, on the machine holding the private key — NOT an agent)

```js
const crypto = require('node:crypto');
const fs = require('node:fs');

const privateKey = crypto.createPrivateKey(
  fs.readFileSync('<PRIVATE KEY PATH — bing fills this in>')
);

const version = '0.5.0-alpha.53';
const sha256 = '<sha256 of the packaged .asar — from release-record.json / sha256.txt>';
const size = <byte size of the packaged .asar>;

const payload = `${version}:${sha256}:${size}`;
const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');

const manifest = { version, sha256, size, signature };
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 2));
// upload manifest.json alongside the .asar to
// bangbowbing.net/downloads/money-printer-os/stable/
```

The `<PRIVATE KEY PATH — bing fills this in>` placeholder above is intentional and must stay
a placeholder in this repository. This packaging pass did not search for, read, name, or
otherwise infer any actual private key path, per the workflow's hard constraints.

## LAN/cluster channel (separate, not this key)

The LAN/cluster path (`remote: false`, a `token` present) uses a different, **symmetric**
HMAC-SHA256 scheme keyed by `CLUSTER_TOKEN` and does not touch the Ed25519 release signing
key at all. It is out of scope for this document, which covers only the public download
channel's asymmetric signature.

## Where this fits in the release flow

1. `scripts/release-alpha53.mjs pack` produces the `.asar`, its SHA-256, and its byte size
   (see `release-record.json`).
2. Bing runs the signing recipe above, by hand, on the machine holding the private key, to
   produce `manifest.json`.
3. Bing uploads both the `.asar` and `manifest.json` to
   `bangbowbing.net/downloads/money-printer-os/stable/`.

No agent performs step 2 or step 3.
