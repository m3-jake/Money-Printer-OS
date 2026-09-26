# Money rain overhaul: make the falling-money FX great

Read `MONEY_PRINTER_STATUS.md` first and follow its batch workflow. Start from **`origin/main` (0.5.0-alpha.60)** and create a branch from it. Don't start from `sync/windows-alpha56-to-mac`: the latest FX work (`74c6689`, `4149f96`, `b03e8f3`) exists only on main.

## Goal

Own the profit-FX system end to end and make it look and feel great. Bills should flutter down believably, land right on the bottom edge of the screen, rest briefly, then fade out slowly. Small wins get a light drift of single bills. Big wins get a real "big drop" featuring the original cartoon cash stack. The profit-only and paper-only rules don't change.

## Where it lives (line numbers are for main)

- `public/dashboard.html`
  - Lines 16–17: the hosts `#moneyRain` and `#moneyPile`. Line 20: `#moneyEventFeed`.
  - Lines 511–552: `clamp01`, `sessionFxMetrics`, `makeBurstBills`, `makeRainBills`, `makePileBills`, `renderMoneyEvents`, `noteMoneyEvent`, `triggerMoneyBurst`, `trackRealizedProfitBurst`, `trackComboProfitBurst`, `trackRobinhoodProfitBurst` and `updateDesktopEffects`.
  - Callers: about line 1109 (the state refresh calls `trackRealizedProfitBurst(); updateDesktopEffects()`), about line 1208 (`trackComboProfitBurst`) and line 48 (`trackRobinhoodProfitBurst` inside `refreshRobinhood`).
- `public/assets/robinhood-panel.js` line 20 has a second copy of the `refreshRobinhood` hook. `b03e8f3` mirrored the dashboard change there, so keep the two in sync.
- `public/css/mpo-shell.css`
  - Line 87: `--task` (36px, from `--mpo-task` in `mpo-workstation.css`).
  - Lines 121–204: `.market-fx`, `.hill-foreground`, `.money-layer`, `.money-pile`, `.bill`, and the keyframes `billFall`, `billFlip` and `pileBob`.
  - Line 798: the reduced-motion block.
  - Lines 816–836: the sprite override that uses `money-bill.webp`.
- Tests that pin this system: `tests/visual-contract.test.mjs` lines 183–197 and `tests/visual-assets.test.mjs` lines 59–62, 115 and 121. Rewrite them on purpose so they describe the new system. Don't bend the code to keep the old string matches passing.

## What's wrong now (confirm each one before you fix it)

1. **The rain and the pile are two unrelated systems.**
   - Falling bills animate to `100vh + 150px`, and `.market-fx` clips them at the top of the taskbar, so they never land.
   - The pile is a separate batch that appears at full opacity the moment a burst starts (`pile.style.opacity='1'`). Money shows up on the ground before anything has fallen.
2. **The pile lingers, then pops.** It stays for the whole 7.2 s burst window, then disappears through a 0.45 s opacity transition plus `innerHTML=''`.
3. **There's a gap at the bottom.** Four things lift the pile bills above the taskbar:
   - a random `bottom` offset of 0–32 px;
   - `pileBob`, which lifts them another 4 px;
   - `scale` shrinking them toward a bottom origin;
   - the sprite, which is `contain`ed in a 70×43 box that doesn't match its 640×354 aspect ratio.

   Take a screenshot and measure the gap first.
4. **Bills restart and pop.** `updateDesktopEffects` rebuilds `rain.innerHTML` whenever its signature changes (P/L % in 0.5 steps, velocity, intensity in tenths), which sends every bill back to the top.
   - A burst wipes the ambient rain.
   - A second burst wipes the first.
   - The end-of-burst timer rebuilds everything again.
5. **Bills can start half off-screen.** `left:(i*37+rand*31)%100` can put a bill at about 100%, half past the right edge.
6. **One sprite does every job.** Every bill is the photoreal spiked-cash *bundle* (`money-bill.webp`). `billFlip` squashes it on scaleY, so it looks like a card flipping over, not a bill in the air.

## Target behavior

### Motion

Replace the CSS keyframe loops with one small particle system driven by a single `requestAnimationFrame` loop. Put it in its own module (e.g. `public/js/money-fx.js`, loaded the same way as `mpo-viz.js`).

- **Rendering:** use pooled elements moved with `transform` only, or a DPR-aware `<canvas>`. Pick one and say why.
- **Per bill:** gravity up to a terminal velocity, a sinusoidal side-to-side sway with its own phase, and a 3D tumble on rotateX, rotateY and rotateZ (not a scaleY squash).
- **Depth:** give each bill a depth value that sets its scale and speed and darkens far bills slightly.
- **Tab resume:** clamp `dt` when a hidden tab comes back, so nothing teleports.

### Landing

- **Floor:** the floor is the top edge of `.taskbar` (measure it with `getBoundingClientRect`).
- **No gap:** the lowest visible pixel of a landed bill's art sits within 2 px of the taskbar top. No random bottom offsets, and no letterboxing: size each sprite to its own aspect ratio.
- **Settling:** on contact a bill bounces a little, slides, and eases its rotation toward flat. A soft contact shadow helps it sit on the floor.
- **Layer:** landed bills form one low layer along the bottom of the screen. They don't build a tall heap.

### Lifecycle

1. The bill lands.
2. It rests briefly: about 1.5–3 s, a little longer for big drops.
3. It fades out slowly: about 2–4 s, ease-out, sinking slightly.
4. It's removed from the DOM or returned to the pool.

Set hard caps on the number of falling bills and landed bills. When a cap is reached, the oldest landed bills start fading early. Once activity stops, the screen goes back to empty with no leftover nodes.

### Continuity

- Ambient rain changes its spawn rate when intensity changes. It never rebuilds.
- Bursts add bills on top of whatever is already falling.
- Overlapping bursts stack up to the cap instead of overwriting each other.

### Tiers

Keep the log intensity mapping in `triggerMoneyBurst`, and tune the thresholds.

- **Ambient** (paper equity above its starting value, from `sessionFxMetrics`): a sparse drift of single bills whose density follows `intensity`.
- **Small win:** a short flurry of single bills. Tiny wins can be mostly $1 bills.
- **Big drop** (the top tier, e.g. `intensity ≥ ~0.7` or a dollar threshold you pick and document): a few **cartoon cash stacks** fall heavier and faster than the bills. They land with a thud, bounce a little and kick up a few loose bills, all inside a dense flurry of $100s. It should feel like an event. Cap it so it never tanks the frame rate.

### Keep unchanged

- Profit-only (no loss FX) and paper-only.
- Every existing trigger: `trackRealizedProfitBurst`, `trackComboProfitBurst` and `trackRobinhoodProfitBurst`.
- The text of the `noteMoneyEvent` feed.
- Reduced motion turns the FX fully off.
- `pointer-events:none`, with the hosts layered below windows and icons.
- No trading, wallet or API changes.

## Art

The reference images are in `W:\money-printer-os\artifacts\money-fx-refs\`. The path is absolute, so it works from a worktree too.

| File | Notes |
| --- | --- |
| `bill-100-curl-lowangle.webp`, `bill-100-front-bow.webp`, `bill-100-newdesign-scurve.webp`, `bill-100-wide-wave.webp` | Already transparent cutouts. |
| `bill-100-ucurl-WHITE-BG.jpg` | White background. Cut it out cleanly (no white halo) or drop it. |
| `bill-1-wave.webp` | $1 bill, for tiny wins and occasional variety. |
| `cartoon-cash-stack-ORIGINAL.png` | The original illustrated spiked-cash stack (`git show 7eb7e17:public/assets/money-printer-logo.png`). This is the **big-drop** hero. The current `money-bill.webp` is the later photoreal version; big drops use this cartoon original. |

- **Output:** process the references into shipped sprites under `public/assets/money-fx/`.
  - Trim each one to its art's bounding box and save it as transparent WebP.
  - Size: about 256 px on the long edge (about 128 px is fine for the small ones).
  - Budget: about 400 KB in total.
- **Watermarks:** check each image for stock watermarks and don't ship any that have one.
- **Old sprite:** decide deliberately whether to keep or retire `money-bill.webp`, and update the tests to match.
- **Tests:** add the new sprites to `tests/visual-assets.test.mjs`, covering the alpha channel, dimensions and the size budget.
- **Preloading:** preload and decode the sprites before first use so the first burst doesn't flash.
- **Line endings:** if you script any edits, use node, or Python with `newline=''`. Plain Python rewrites LF files as CRLF on this machine.

## Verify it and share the proof (don't ask me to check)

- **Run it:** start the dashboard with the `engine-isolated` config in `.claude/launch.json` (paper mode, isolated data dir, port 8799).
- **Trigger it:**
  - Call `triggerMoneyBurst(amount, source, reason)` from the page at $0.50, $5, $50 and $500.
  - Fire two bursts back to back.
  - Force ambient mode (stub `sessionFxMetrics` if you need to).
- **Capture it:** screenshots or a short GIF at 1920×1080, at 4K and at a narrow width.
  - Show three moments: bills mid-fall, bills landed and bills mid-fade.
  - Add a zoomed crop of the taskbar edge that proves there's no gap.
- **Measure it:**
  - Frame rate during the $500 burst.
  - DOM or pool node count at baseline, at peak, and 15 s after the last burst. The last one must be back at baseline.
- **Test it:** `npm run test:visual` and `npm run test:all` both pass. Report the counts.
- **Ship it:** build, install and check it in the real desktop app the way the ledger describes. Update `MONEY_PRINTER_STATUS.md`. Commit to your branch, and don't push or publish without asking.
