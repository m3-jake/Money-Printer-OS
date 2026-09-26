# Release channel (GitHub Releases)

An installed copy of Money Printer OS updates itself from **one channel**: the GitHub Releases of
this repository, `https://github.com/m3-jake/Money-Printer-OS`, newest published release. This
replaces `https://bangbowbing.net/downloads/money-printer-os/stable`, a directory that never had a
host behind it (bangbowbing.net is Squarespace plus the `live.` hub; neither serves downloads).

## What the app does (`desktop/main.cjs`)

Shortly after start, every 10 minutes, and on *Check for updates*, a packaged copy:

1. resolves the channel (`desktop/update-channel.cjs`): `MONEY_PRINTER_UPDATE_URL` from the app's
   `.env` when set, otherwise the default above;
2. asks the GitHub API for the release (`/repos/<owner>/<repo>/releases/latest`, or
   `/releases/tags/<tag>` when the channel URL pins one) and locates its `manifest.json` and
   `app.asar` assets (`desktop/update-fetch.cjs`). Redirects are followed; the token is never
   forwarded off `api.github.com`;
3. verifies `manifest.json` with the Ed25519 release public key (`desktop/update-auth.cjs`,
   `desktop/update-public-key.pem`). An unsigned, foreign or tampered manifest is an updater
   `ERROR` and nothing is downloaded;
4. only for a newer version: downloads `app.asar`, checks its SHA-256 and size against the signed
   manifest, and applies it under the existing rules (held while any real exposure is open,
   `desktop/release-gate.cjs`; live mode never restarts on its own).

LAN/cluster peers (`CLUSTER_TOKEN`, a peer's `/update/manifest`) are unchanged and still take
precedence when present. The HUD's Updater panel shows the channel actually in use
(`GET /api/update` → `channel`, `channelUrl`, `channelKind`, `channelError`).

Version order is numeric on every digit group (`desktop/main.cjs::versionGreater`), so
`0.5.0-alpha.54` is newer than `0.5.0-alpha.53`. **Do not tick "pre-release"** when publishing:
GitHub's `latest` skips pre-releases, so the updater would never see it.

## Quick path (two commands)

One-time setup:
- **Each installed copy (Windows and Mac):** add `MONEY_PRINTER_UPDATE_TOKEN=<read-only token>` to its `.env` (see the next section), then restart the app. The Updater panel then shows the GitHub channel with no error.
- **The key-holding machine:** keep a second fine-grained token for this repo with **Contents: Read and write**. It is used only by `release:publish`, set per terminal as `MPO_RELEASE_TOKEN`, and never stored in the app's `.env`.

Every release:
1. `npm run release:cut` on a clean, up-to-date `main`.
   - It bumps the version (package.json, lock, `src/robinhoodTransport.js` APP_VERSION), commits, tags `v<version>` and pushes.
   - The push starts the "Release build" workflow, which runs the tests and leaves a draft release.
   - `--no-push` stops before pushing. An explicit version can be passed: `npm run release:cut -- 0.6.0`.
2. When the workflow is green, run `npm run release:publish -- --key <release-private-key.pem>`.
   - It downloads the draft's app.asar, signs and verifies it with `scripts/sign-manifest.mjs`, uploads `manifest.json` (replacing an old one) and publishes the draft as latest.
   - `--dry-run` checks the token and the download without signing or publishing.

Installed copies then update themselves on their next check, within about 10 minutes. The manual steps below describe the same flow.

## Private repository → token

While the repository is private the GitHub API answers `404` without credentials. Put a token in
the installed app's `.env` (macOS `~/Library/Application Support/Money Printer OS/.env`, Windows
`%APPDATA%\Money Printer OS\.env`):

```
MONEY_PRINTER_UPDATE_TOKEN=github_pat_…
```

Make it a **fine-grained personal access token** limited to this one repository with
*Contents: Read-only* and nothing else — that is all the Releases API needs. The token only moves
bytes; the signature check decides whether a release is trusted. If the repository goes public the
token can be removed. The updater's error text says which of the two situations it is in.

## Cutting a release

1. Bump `version` in `package.json`, refresh the lock (`npm install --package-lock-only`), commit,
   and get CI (`.github/workflows/ci.yml`) green.
2. Tag and push: `git tag v0.5.0-alpha.54 && git push origin v0.5.0-alpha.54`. The tag must equal
   `v` + the `package.json` version; the workflow refuses otherwise.
3. `.github/workflows/release.yml` builds on a macOS arm64 runner exactly as
   `npm run release:unified` does on the Mac (`scripts/build-unified.mjs`: tests, staged `app.asar`,
   pinned Electron runtimes, ad-hoc signed `.app`, Windows folder + installer, smoke boot) and
   creates a **draft** GitHub Release carrying `Money-Printer-OS-…-macOS-arm64.zip`,
   `…-Windows-x64.zip`, `app.asar`, `SHA256SUMS.txt`, `RELEASE.json`, `PACKAGE-VERIFICATION.json`,
   `START-HERE.txt` and `manifest.unsigned.json`. The same job can be run by hand from the Actions
   tab (it then only uploads a workflow artifact, no release).
4. **Bing, on the machine that holds the release private key:** download `app.asar` from the
   draft, then

   ```
   node scripts/sign-manifest.mjs sign   --asar app.asar --key <release-private-key.pem>
   node scripts/sign-manifest.mjs verify --manifest manifest.json --asar app.asar
   ```

   `sign` takes the version from the `package.json` packed inside the archive, refuses a key that
   does not match `desktop/update-public-key.pem`, never echoes the key path, and refuses to run
   inside an agent session. `verify` re-checks the manifest exactly as the app will.
5. Upload `manifest.json` to the draft release and **publish** it. `releases/latest` now points at
   it and installed copies pick it up on their next check.

The workflow never signs and never publishes. A draft is invisible to the updater; a published
release without `manifest.json` is reported as "has not been signed and published for the updater
yet" and skipped. `manifest.unsigned.json` carries `signature: null` and is rejected on sight.

`.asar`-only updates keep the existing behaviour: the updater swaps `resources/app.asar` and leaves
`app.asar.unpacked` (the optional `ws` native accelerators) as installed. A full reinstall from the
zip refreshes both.

## Other channel values

`MONEY_PRINTER_UPDATE_URL` also accepts:

- `https://github.com/<owner>/<repo>/releases/tag/<tag>` — pin every machine to one release;
- any plain `https://host/dir` — the original static layout, `<dir>/manifest.json` next to
  `<dir>/app.asar`, if the downloads ever move to a file host again.

A malformed value is ignored (the default channel is used) and reported in the HUD and
`desktop.log`.

## Cost

macOS runners bill at 10× on private repositories (2,000 free minutes ≈ 200 macOS minutes a
month). The release job runs only on a `v*` tag or by hand; CI runs on Linux per push/PR.

## Still bing-only

Signing (the private key never enters CI or this repository), publishing, Developer ID /
notarization, Authenticode, the Windows boot test and `release-gate.cjs` stage promotion are
unchanged and stay outside automation — see `docs/WINDOWS-RELEASE.md` and
`.agent-state/RELEASE_STATUS.md`.
