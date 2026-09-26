# Prompt 2 of 2: smaller Simple-mode windows + remember everything across restarts

Run this after Prompt 1, in the same worktree. One bounded batch. Every decision below is already made. Don't re-inventory the repo, don't ask questions, and don't launch subagents or workflows. Don't open MONEY_PRINTER_STATUS.md.

## Setup
Call EnterWorktree with path `W:\mpo-sunny` (branch `feature/sunny-desktop`, created by Prompt 1). If it doesn't exist, run in the PowerShell tool:
`git -C W:\money-printer-os worktree add W:\mpo-sunny -b feature/sunny-desktop feature/hud-declutter`
then
`New-Item -ItemType Junction -Path W:\mpo-sunny\node_modules -Target W:\money-printer-os\node_modules`
Never write under `W:\money-printer-os`. Never run npm install.

Line numbers are for feature/hud-declutter. Prompt 1 shifted `public/dashboard.html` by a few lines, so Grep the quoted code if a line is off.

## A. Smaller Simple-mode windows (about 12%)
- `public/dashboard.html` ~353: `const TEXT_SCALES={S:.9,M:1.1,L:1.3}`, replacing `{S:1,M:1.25,L:1.5}`.
- ~360-361: `HERO_MAX_H={money:500,journal:600}`. In `heroLayout()`, change the caps `Math.min(1000,…)` → 880 and `Math.min(HERO_MAX_H[id]||800,…)` → 700.
- Do NOT bump `LAYOUT_VERSION`: a bump wipes saved layouts. Instead, run a one-time shrink of saved sizes. If `!readPref('mpo-size-migrated-0927',false)`, multiply every saved `w` and `h` in `saved` by 0.88 (keep x/y; respect the 260×150 minimums), write `mpo-layout`, then set the flag.
- Test pin: `tests/visual-contract.test.mjs:340` → `/const TEXT_SCALES=\{S:\.9,M:1\.1,L:1\.3\}/`. Line 341 (FIT_MAX) stays unchanged.

## B. Remember window positions, sizes and choices across restarts
**What's broken today:**
- The OS window always opens at 1536×1024 on the primary screen (`desktop/main.cjs:279-284`).
- Only the last-focused window reopens, because `restoreAll` is false and that `false` is already saved inside `mpo-display`.
- Any `LAYOUT_VERSION` change wipes the layout (dashboard ~342).
- The boot clamp at the small window size overwrites saved positions through `persist()`.
- Some choices live only in memory (Robinhood view and chart range, the Pump.fun chart range and zoom).
- Nothing flushes localStorage on quit.

### B1. New `desktop/window-state.cjs` (pure; no electron import)
- File: `path.join(app.getPath('userData'),'window-state.json')`, holding `{v:1,x,y,width,height,maximized,fullScreen,displayId}`.
- `loadState(file, fs)` returns null on any error.
- `validateState(state, displays, primary, defaults={width:1536,height:1024,minWidth:900,minHeight:620})`:
  - displays are `{id, workArea:{x,y,width,height}, scaleFactor}` in DIP.
  - Reject non-finite values and Windows' minimized `-32000` rects.
  - Clamp the size to the min sizes and to the chosen display's workArea.
  - Pick the display with the largest intersection. If there is none, fail. displayId only breaks ties.
  - Require at least 64×32 of the top 32 px title strip to be inside a workArea. Negative x is valid: the user's second monitor is at x=−1920.
  - On failure, centre the default size on `primary.workArea`, keeping `maximized`.
- `captureState(win, screen)` uses `win.getNormalBounds()`, plus `isMaximized()`, `isFullScreen()` and `screen.getDisplayMatching(b).id`.
- `saveState(file, st, fs)` writes a tmp file, then renames it.
- `makeDebouncedSaver(fn, ms=400, timers)` returns `{schedule, flush}`.

### B2. `desktop/main.cjs`
- In createWindow (~279):
  - Build the window from `validateState(loadState(F), screen.getAllDisplays(), screen.getPrimaryDisplay())` with `show:false`.
  - If the chosen display isn't primary, call `win.setBounds(...)` again (mixed-DPI quirk).
  - Call `maximize()` / `setFullScreen(true)` BEFORE the first `loadURL`, so the page boots at its real size.
  - Show the window: `win.once('ready-to-show', show)` plus a 3 s fallback `setTimeout` that shows it if it isn't visible yet.
  - The `second-instance` path (~386) recreates the window through the same function.
- Saver: `schedule()` on move, resize, maximize, unmaximize, enter-full-screen and leave-full-screen. Skip it while `isMinimized()`, and in `flush()` as well.
- `flush()` at the top of the `close` handler (~285, before hide/return).
- `before-quit` (~407), right after `quitting = true` and BEFORE the `if (!anyAlive()) return;` early exit:
  - `saver.flush()`
  - `win?.webContents.executeJavaScript('window.__mpoPersist&&window.__mpoPersist()', true).catch(()=>{})`
  - `session.defaultSession.flushStorageData()`
  - When nothing is alive, `e.preventDefault()`, wait for those with a 300 ms `Promise.race` timeout, then `app.quit()`.
  - Call `flushStorageData()` again just before the final `app.quit()` (~419).
- Check the Windows updater helper (~259). If it force-kills the app instead of waiting for the PID, flush before `shell.openPath`.

### B3. `public/dashboard.html`
1. **No layout wipes:** replace the ~342 wipe with a migration that only updates `mpo-layout-version` and keeps `saved` and `openSet`. Add a comment: layout changes must migrate, never wipe. `#setResetLayout` (~1095) stays the only wipe.
2. **Reopen every window:**
   - Change the default to `restoreAll:true` (~354).
   - Add a one-time migration: `if(!readPref('mpo-restore-migrated',false)){displayPrefs.restoreAll=true;writePref('mpo-display',displayPrefs);writePref('mpo-restore-migrated',true)}`.
   - Keep the Settings checkbox as the opt-out. The shown-expression (~392) stays unchanged.
3. **Saved coordinates are authoritative:**
   - Add `let intended={...saved}`.
   - Set `w.dataset.userMoved='1'` on drag/resize end (~516), in the max toggles (~518, ~526) and in tile.
   - In `persist()`, take x/y/w/h from the DOM only for userMoved windows, otherwise from `intended[id]`. min/max/hidden always come from the DOM. Write `intended`, then clear the flag.
   - Grep every `clampAll()` / `clampWin(` call and make each one visual-only.
   - Add `reflowAll()`: reset each non-max window's style to `intended[id]`, then clampWin. Use it at boot (~403) and in the window `resize` handler (~1425), so windows return to their spot when the viewport grows.
4. **Flush from main:** `window.__mpoPersist=()=>{persist()}`, plus a `pagehide` listener next to `beforeunload` (~1432).
5. **Persist the in-memory choices:**
   - `mpo-chart-view` = `{range,zoom}` of `chartView` (~301). Write it when the range buttons change and in the +/- key handler (~1430).
   - **Robinhood:** edit ONLY `public/assets/robinhood-panel.js`; dashboard.html's copy is generated. Persist `rhView` (line 4), validated right after `RH_VIEWS` (line 5): `if(!RH_VIEWS[rhView])rhView='paper'`. Persist `rhChart` `{range,symbol}` (line 8; range ∈ 1h/6h/24h) at their write sites. Then run `npm run sync:robinhood-panel` and confirm `npm run sync:robinhood-panel -- --check` passes.

## Tests
- New `tests/window-state.test.mjs` (node --test, createRequire), with fake displays `{id:1,workArea:{0,0,2560,1400},scaleFactor:1.5}` and `{id:2,workArea:{-1920,0,1920,1040},scaleFactor:1}`. Cases:
  - A rect on the 2nd monitor at x=−1800 is kept.
  - x=5000 centres on primary.
  - The 2nd monitor unplugged centres, keeping `maximized`.
  - An oversize rect is clamped; the min size is enforced.
  - x=−32000 is rejected.
  - Corrupt JSON gives null, then the default.
  - `captureState` uses `getNormalBounds` (fake win).
  - The debouncer coalesces, and flush runs immediately (fake timers).
  - Save writes tmp, then renames (fake fs).
- `tests/visual-contract.test.mjs`:
  - No `removeItem('mpo-layout')` outside the reset handler.
  - Pins for `restoreAll:true`, `mpo-restore-migrated`, `mpo-size-migrated-0927`, `window.__mpoPersist`, `mpo-chart-view`, and `reflowAll` in the resize handler.
  - The 163 LAYOUT_VERSION pin stays. At 334 DEFAULT_OPEN stays; change its message to "fresh install opens one window".
- Desktop contract (text match on main.cjs): `show:false`, `require('./window-state.cjs')`, `flushStorageData`, and `maximize` before the first `loadURL`.
- Run `npm run test:all > "$SCRATCH/t.log" 2>&1; echo exit=$?; grep -E '✖|^ℹ (pass|fail)' "$SCRATCH/t.log" | tail -20`. If a suite you didn't touch fails, report it and don't fix it.

## Verify
- Start your own server (same command as Prompt 1, port 8823, started with Bash `run_in_background`).
- Open it with `preview_start` using `url: http://127.0.0.1:8823/`.
- Open 2 windows and move/resize one, then reload. Both reopen at the same spot and size.
- Resize the viewport to 1536×1024 and back to 2560×1440: the window returns to its saved spot.
- One screenshot at scale 0.5. Stop the server.
- The Electron window-state is covered by the unit tests. Don't launch Electron.

## Finish
- Stage explicit paths only: `desktop/window-state.cjs desktop/main.cjs public/dashboard.html public/assets/robinhood-panel.js tests/window-state.test.mjs tests/visual-contract.test.mjs`, plus any other test you changed on purpose. Commit on `feature/sunny-desktop` and don't push.
- Keep LF endings.
- End with a 3-line ledger entry (changes / tests / open items), then stop.
