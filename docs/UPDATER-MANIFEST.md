# Updater manifest signing (public release channel)

The signed `manifest.json` is what lets an installed copy trust a release. `desktop/main.cjs`
fetches it from the release channel (this repository's GitHub Releases — see
`docs/RELEASE-CHANNEL.md`) and `desktop/update-auth.cjs::verifyManifest()` checks it before a byte
of `app.asar` is applied.

**No agent signs, ever.** Signing needs the Ed25519 release private key, which does not exist
anywhere in this repository and which no agent session may search for, read, name, or infer.
`desktop/update-public-key.pem` (the public half) is the only key material an agent may read;
`openssl pkey -pubin -in desktop/update-public-key.pem -text` confirms it is Ed25519.

## What the updater verifies

`verifyManifest(m, { remote: true, publicKey })` expects `{ version, sha256, size, signature }`
and checks

```js
crypto.verify(null, Buffer.from(`${version}:${sha256}:${size}`), publicKey, Buffer.from(signature, 'base64'))
```

`crypto.sign`/`crypto.verify` with a `null` algorithm only work with a key type that carries its own
algorithm — Ed25519 here — so the signing counterpart is an Ed25519 **private** key, never RSA/ECDSA.

## The script

`scripts/sign-manifest.mjs` implements the recipe so nobody has to paste JavaScript:

```
node scripts/sign-manifest.mjs stage  --asar app.asar                                   # unsigned shape; CI attaches it as manifest.unsigned.json
node scripts/sign-manifest.mjs sign   --asar app.asar --key <release-private-key.pem>   # bing, by hand, on the key-holding machine
node scripts/sign-manifest.mjs verify --manifest manifest.json --asar app.asar          # anyone; re-checks exactly as the app does
```

- `version` comes from the `package.json` packed inside the archive (`--version` may restate it but
  must match), so a manifest can only describe the archive it was made from.
- `sign` has no default key path and never looks for one. It refuses a non-Ed25519 key, refuses a
  key that does not verify against `desktop/update-public-key.pem`, writes nothing in either case,
  never echoes the key path, and refuses to run inside an agent session (`CLAUDECODE` set). An
  encrypted PEM takes its passphrase from `MPO_SIGNING_KEY_PASSPHRASE`.
- `verify` exits 0 only when the signature verifies and, with `--asar`, the archive's SHA-256, size
  and packed version all match.

`npm run test:updater` covers all three verbs with a throwaway key.

## Where this fits

1. `.github/workflows/release.yml` (or `npm run release:unified` on the Mac) produces `app.asar`
   and stages `manifest.unsigned.json` next to it.
2. Bing runs `sign` on the machine holding the private key, then `verify`.
3. Bing uploads `manifest.json` to the draft GitHub Release and publishes it.

No agent performs step 2 or step 3.

## LAN/cluster channel (separate, not this key)

The LAN/cluster path (`remote: false`, a `CLUSTER_TOKEN` present) uses a symmetric HMAC-SHA256
over the same payload and does not touch the Ed25519 release key. It is out of scope here.
