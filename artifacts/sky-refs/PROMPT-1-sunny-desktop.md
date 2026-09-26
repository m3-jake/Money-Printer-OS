# Prompt 1 of 2: sunny sky, moving clouds, sharper grass, 3D logo

One bounded batch. Every decision below is already made. Don't re-inventory the repo, don't ask questions, and don't launch subagents or workflows. Don't open MONEY_PRINTER_STATUS.md: this prompt replaces the ledger read. Read only the files and line ranges named here.

## Setup (PowerShell tool, not Bash; Git Bash mangles `W:\` paths and `cmd /c`)
```
git -C W:\money-printer-os worktree add W:\mpo-sunny -b feature/sunny-desktop feature/hud-declutter
New-Item -ItemType Junction -Path W:\mpo-sunny\node_modules -Target W:\money-printer-os\node_modules
```
Then call EnterWorktree with path `W:\mpo-sunny`. All paths below are relative to it. Never write under `W:\money-printer-os`, because another session edits it. Read the prepared assets from `W:\money-printer-os\artifacts\sky-refs\` by absolute path (call it REFS). Never run `npm install` or `npm ci`: node_modules is shared.

## Line map (feature/hud-declutter)
- `public/css/mpo-shell.css`:
  - 103-109 `.desktop` (#008080)
  - 110-118 `.wallpaper` (z 0, bliss-4k.jpg at 114)
  - 129-136 `.hill-foreground` (z 2, jpg at 134, clip-path at 135)
  - 137 money-layer z 3; 139 money-pile z 4
  - 205-222 `.brand`; 224-237 runningVersion; 241-248 brand-corner/brand-text
  - 791-796 the 1000px media query; 798+ reduced-motion
- `public/dashboard.html`:
  - 11 the mpo-viz script tag
  - 13-27 `#desktop` children; 19 is `<div class="brand"><div class="brand-text">MONEY<br>PRINTER OS<small id="runningVersion"></small></div></div>`
  - 28 the inline script; 1285 fills runningVersion
- Test pins:
  - `tests/visual-assets.test.mjs`: 124 expects 2× bliss-4k.jpg in shell CSS; 70 and 91 read the jpg (keep the file).
  - `tests/visual-contract.test.mjs`: 161 `.brand` z-index 6; 162 `.boot` #008080; 325 mpo-viz tag.
- Don't add any `<script>` tag. Five tests slice the page from the first `<script>` to the last `</script>`. This batch needs no JS.

## Build
1. **Hill (grass).** Copy `REFS\grass\make-hill.py` to `scripts/make-hill.py`, fix its paths to repo-relative (`ROOT = Path(__file__).resolve().parents[1]`), and apply these tuning changes before running it:
   - Texture soft-light gain 0.4 → 0.15 (front) and 0.2 (ridge).
   - Streaks: GaussianBlur 0.9; stretch ratios 5/7/13/23 instead of 4/8/10/18; `rotate(3, BICUBIC)` on the noise. Blur the coarse layer by 1.5 px after resizing, and fade the texture out below depth 0.85.
   - High-pass blur radius 6 → 3.
   - Unsharp masks: (1.2, 45, 3) for the ridge and (1.8, 60, 3) for the front.
   - Colour ×1.02 and brightness ×1.04, replacing ×1.08 and ×1.10.

   Output: `public/assets/bliss-hill.webp` (3840×2160 RGBA, transparent sky, about 0.5 MB). Check one 1:1 crop of the foreground (x300-1100, y1750-2160) with the Read tool. It must show no repeating vertical comb lines and no yellow shift. Allow at most 2 rounds.
2. **Sky (`.wallpaper`).** Use pure CSS, no image: `linear-gradient(to bottom,#3A91E8 0%,#6EB7F5 34%,#C4E5FC 62%,#C4E5FC 100%)`. Layer the sun on top, centred at 30% x / −6% y: a radial-gradient core in `#FFFDF5`, solid to about 4vmin and gone by about 9vmin, plus a soft glow from `rgba(255,252,240,.85)` fading to transparent by about 55vmin. Set `.desktop` background to `#3A91E8`; this is cosmetic. Leave body, the inline html/body style, `.boot` and desktop/main.cjs alone. The target look is `REFS\sky-approved.png`.
3. **`.hill-foreground`:** `background:url('/assets/bliss-hill.webp') center center / cover no-repeat;` and delete the clip-path.
4. **Clouds.** Copy `REFS\chatgpt-clouds\sprites\01.webp`…`10.webp` to `public/assets/clouds/` and `REFS\chatgpt-clouds\make-cloud-sprites.py` to `scripts/`. Before copying, fix the faint grey-blue edge on pale sky:
   - In the script, desaturate pixels with alpha < 0.4 toward neutral.
   - Re-run it once and check `REFS\chatgpt-clouds\preview-tint.png`-style output on #C4E5FC.

   Insert `<div class="sky-clouds" aria-hidden="true">…</div>` right after `.wallpaper` in the HTML. Add the CSS next to `.hill-foreground`:
   ```css
   .sky-clouds{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:1}
   .sky-cloud{position:absolute;left:0;height:auto;will-change:transform;animation:skyDrift linear infinite}
   .sky-cloud>img{display:block;width:100%;height:auto;transform:scaleX(-1)}
   @keyframes skyDrift{from{transform:translateX(-100%)}to{transform:translateX(100vw)}}
   ```
   Reduced-motion block: `.sky-cloud{animation-play-state:paused}`. Never use `animation:none`, which stacks every cloud at x=0.

   Cloud elements, in paint order. A `div` is a mirrored copy wrapping an `<img>`; the rest are `<img class="sky-cloud" alt="">`. This is the layout that was checked with 3 fixes applied: a less even horizon row, the left side filled in, and the cirrus kept in frame.
   ```
   img 09  width:30vw; top:3%;    duration 420s; delay -300s
   img 10  width:24vw; top:8%;    duration 380s; delay -60s
   img 07  width:18vw; bottom:44.6%; duration 720s; delay -432s
   img 06  width:16vw; bottom:43.8%; duration 650s; delay -95s
   div 06  width:10vw; bottom:42.6%; duration 780s; delay -660s
   img 08  width:12vw; bottom:49%;   duration 560s; delay -470s
   img 05  width:9vw;  top:34%;   duration 210s; delay -40s
   div 04  width:12vw; top:29%;   duration 240s; delay -200s
   img 03  width:17vw; top:24%;   duration 235s; delay -30s
   img 02  width:30vw; top:18%;   duration 290s; delay -205s
   img 01  width:27vw; top:5%;    duration 265s; delay -188s
   ```
   Each gets an inline style of `width`, `top` or `bottom`, `animation-duration` and `animation-delay`, and nothing else. Never put y in a transform.
5. **Logo.** Copy `REFS\logo\make-logo-cutout.py` and its source `REFS\logo\mpo-logo-3d-source.webp` to `scripts/` and `scripts/assets/`. Apply these fixes, run it, and write `public/assets/mpo-logo-3d.webp` (960 px wide, lossless alpha):
   - FEATHER 0.5.
   - Semi-body pixels take their colour from the eroded body, so there is no dark 1 px rim.
   - GLOW_GAIN 1.4 and GLOW_GAMMA 0.75.
   - Clamp the glow colour to R ≤ 0.6·G and B ≤ 0.2·G.

   Replace line 19 with:
   `<div class="brand"><div class="mpo-logo"><img class="brand-logo" src="/assets/mpo-logo-3d.webp" alt="Money Printer OS"><span class="shine"></span></div><small id="runningVersion"></small></div>`

   CSS:
   - `.brand` keeps z-index 6. Add `flex-direction:column; align-items:flex-end`.
   - `.brand-logo{display:block;width:320px;height:auto}` (220px inside the 1000px media query).
   - Motion, all animations transform/opacity only:
     - `.mpo-logo{position:relative;animation:mpoFloat 6s ease-in-out infinite}` (translateY 0 → −4px)
     - `.brand-logo{animation:mpoBreathe 4.5s ease-in-out infinite}` (opacity 1 → .93)
     - `.shine`: `position:absolute;inset:0;overflow:hidden;` with `mask`/`-webkit-mask` set to `url(/assets/mpo-logo-3d.webp) center/100% 100% no-repeat`.
     - `.shine::before`: a 28%-wide `linear-gradient(100deg,transparent,rgba(255,255,255,.55),transparent)` with `mix-blend-mode:screen`, sweeping from translateX(−150%) to (420%) with skewX(−18deg) over the 74-88% span of a 9s loop, invisible otherwise.
   - Reduced motion: no animations, and `.shine{display:none}`.
   - Delete the dead `.brand-corner` and `.brand-text` rules. Keep the runningVersion styling, adjusted so it reads on the sky.
   - Leave the boot logo, the start-menu rail, the glance brand and the `.mpo-brand-title` panels alone.
6. **Icon labels over white clouds:** in `.icon`, set `text-shadow:1px 1px #000,0 0 3px #000,0 0 1px #000`.
7. Don't touch money rain/pile code.

## Tests (rewrite on purpose)
- `visual-assets.test.mjs:124`:
  - The shell CSS has 0 `bliss-4k.jpg` refs and exactly 1 `bliss-hill.webp`.
  - `.hill-foreground` has no clip-path.
  - `bliss-hill.webp` passes the WebP check: `toString('ascii',0,4)==='RIFF'`, `(8,12)==='WEBP'`, `(12,16)==='VP8X'`, `buf[20]&0x10` (alpha), `readUIntLE(24,3)+1===3840`, `readUIntLE(27,3)+1===2160`.
  - 10 cloud webps and `mpo-logo-3d.webp` exist.
- `visual-contract.test.mjs`:
  - `.sky-clouds` sits between `.wallpaper` and `.hill-foreground`, with z-index 1.
  - 11 `sky-cloud` elements.
  - The reduced-motion block has `animation-play-state:paused` for `.sky-cloud`.
  - The gradient matches `/#3a91e8/i`.
  - `.brand` z-index 6 stays; `brand-logo` and `id="runningVersion"` are present.
- Run `npm run test:visual 2>&1 | tail -15`, then `npm run test:all > "$SCRATCH/t.log" 2>&1; echo exit=$?; grep -E '✖|^ℹ (pass|fail)' "$SCRATCH/t.log" | tail -20`. If a suite you didn't touch fails, report it and don't fix it.

## Verify (one app check)
- Start your own server with Bash `run_in_background`. Don't use `engine-isolated`: port 8799 belongs to another session. Command, from `/w/mpo-sunny`:

  `DASHBOARD_PORT=8823 DASHBOARD_HOST=127.0.0.1 MODE=paper MONEY_PRINTER_DATA_DIR="$SCRATCH/mpo-data" DOTENV_CONFIG_PATH="$SCRATCH/none.env" POLYMARKET_AUTOSTART=false ROBINHOOD_API_KEY= ROBINHOOD_PRIVATE_KEY= ROBINHOOD_REAL_ENABLED=false MPO_RESEARCH_COLLECTOR=false node src/index.js`

  Start it only after all edits are done: dashboard.html is read once at startup, and /assets is cached for 1 hour.
- Open it with `preview_start` using `url: http://127.0.0.1:8823/`. Take one screenshot at 2560×1440, scale 0.5.
- Check `document.getAnimations().filter(a=>a.animationName==='skyDrift').length === 11`, and run `read_console_messages` with onlyErrors.
- Stop the server before committing.

## Finish
- Stage explicit paths only: `public/css/mpo-shell.css public/dashboard.html public/assets/bliss-hill.webp public/assets/clouds public/assets/mpo-logo-3d.webp scripts/make-hill.py scripts/make-cloud-sprites.py scripts/make-logo-cutout.py scripts/assets tests/visual-assets.test.mjs tests/visual-contract.test.mjs`. Commit on `feature/sunny-desktop` and don't push.
- Edit text files with the Edit tool. If you script an edit, keep LF endings.
- End with a 3-line ledger entry (changes / tests / open items) for the main session to paste, then stop.
