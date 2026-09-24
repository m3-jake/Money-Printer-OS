# Windows release status

**Update 2026-09-24:** an **unsigned Windows x64 package now exists**. It is produced reproducibly on
macOS by `npm run release:unified` (`scripts/build-unified.mjs`). The script takes the official
Electron 38.8.6 win32-x64 runtime (SHA-256 pinned and verified), renames it to `Money Printer OS.exe`,
and adds the same `resources/app.asar` as the mac build, plus `MPO-RELEASE.json`, `PAYLOAD-SHA256.json`
and the installer (`scripts/unified/windows/Install-Windows.ps1` / `Install.cmd`). See
`.agent-state/RELEASE_STATUS.md` for the latest artifact path and SHA-256.

Still pending (bing):
- **Authenticode signing** of the exe. No certificate or signtool setup exists in this repo.
- **Windows boot test** on a real Windows host (`windowsBootTested:false` in RELEASE.json).
- The exe icon is the stock Electron icon. Swapping it needs rcedit on Windows or wine.

Until those are done, `release-gate.cjs` still correctly refuses promotion past `candidate`. The
historical analysis below still describes those gate requirements.

---

## (Historical) Windows release: what did not exist yet

This document states plainly, per `.workflow/scratch/PACKAGING.md` §5 and
`.workflow/scratch/OPEN-ITEMS.md` (item S1), that **no Windows build, signing, or CI
infrastructure exists anywhere in this repository or its tooling**. Nothing below is
fabricated to make the release gate pass; the gate's own design (`desktop/release-gate.cjs`)
already fails closed on a missing Windows artifact, and that is the correct, intended
behavior for this repo's current state.

## What `desktop/release-gate.cjs` requires for a Windows leg

- `main → candidate` requires `artifacts.windows.sha256` (and signed evidence covering it).
- `candidate → tested` additionally requires `tests.windowsBoot === true`.

Neither exists in `release-record.json` produced by this packaging pass, and neither is
fabricated. `scripts/release-alpha53.mjs promote` therefore correctly refuses to advance past
`candidate` until both are real.

## What a real Windows artifact + Authenticode job would require

1. **A Windows host or CI runner** with Node 24 installed, running `npm ci` against the same
   `package-lock.json` this repo already carries — no new dependency is implied, just a
   second OS to build and package on.
2. **A code-signing certificate** for Authenticode signing of the resulting Windows
   executable/installer. No certificate, `signtool` reference, `.pfx` file, or Authenticode
   tooling exists anywhere in this tree today (`grep -ri "signtool\|authenticode\|\.pfx"`
   across the repo returns nothing outside this document).
3. **A Windows boot smoke test** — the Windows-side equivalent of the mac boot check this
   packaging script runs (`node scripts/release-alpha53.mjs test-record --macBoot`): launch
   the packaged app on Windows in offline paper mode, confirm the dashboard answers on
   `127.0.0.1`, and shut it down cleanly. This must run on real Windows, not be inferred or
   simulated on macOS.

None of the above exists in this repository. This is a Windows CI/host + code-signing setup
task for bing, not something this packaging pass can produce from a macOS-only Mac.

## Consequence for the release gate

Until a real Windows artifact and boot test exist:

- `release-record.json.artifacts.windows` stays absent.
- `release-record.json.tests.windowsBoot` stays absent.
- `scripts/release-alpha53.mjs promote candidate|tested|stable` will keep printing `missing`
  including `artifacts.windows.sha256` / `windowsBoot` for any target past `candidate`.
- This caps every alpha53 release produced by this repo, today, at stage `candidate`.

This is the gate working as designed — see `.agent-state/RELEASE_STATUS.md` for this pass's
recorded stage and the exact `missing` output.
