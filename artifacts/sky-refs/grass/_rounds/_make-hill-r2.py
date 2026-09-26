#!/usr/bin/env python3
"""make-hill.py - Bliss hill asset: crisper grass + transparent sky cut-out.

Source : public/assets/bliss-4k.jpg (3840x2160, a soft upscale)
Output : bliss-hill.webp (3840x2160 RGBA, transparent above the ridge)

Pipeline (Pillow only, no numpy, deterministic):
  1. Horizon per column: grass = G-B>8, scan down from 45% height, first run of
     >= 12 grass px. Alpha 255 below, 0 above, 1px erode, blur 1.5.
  2. Fill everything above the horizon with that column's grass colour, so the
     sharpening and the soft alpha edge never pick up photo-sky colour.
  3. Mild edge-preserving denoise (sigma filter) to lift JPEG/upscale smudge.
  4. Unsharp mask tuned per depth (fine near the ridge, wider in front).
  5. Procedural grass detail, luminance only (multiplicative gain, so hue and
     saturation stay): a few million tiny grass blades drawn back-to-front at
     3x supersampling with perspective scale (~1.5 px at the ridge, ~30 px at
     the bottom edge), wind-combed lean + bend, tapered, shaded bases and lit
     tips. The texture is high-passed (zero mean) so the macro Bliss look is
     unchanged, normalised per depth, varied in patches, and masked off the
     dark band, the yellow flowers and anything that is not green.
  6. Sunny grade: Color x1.08, Brightness x1.10.

usage: python make-hill.py [src.jpg] [out.webp]
"""
import math
import os
import random
import sys
import time

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageMath, ImageStat

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, 'public', 'assets', 'bliss-4k.jpg')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'bliss-hill.webp')

# ---- tunables -------------------------------------------------------------
SEED = 20010825
ERODE = True             # 1px alpha erode before the blur (no right-horizon specks)
ALPHA_BLUR = 1.5
DENOISE = 0.6            # 0..1 strength of the sigma filter
DENOISE_T = 7.0          # levels: differences above this count as real detail
USM_FAR = (1.0, 60, 2)   # unsharp radius, percent, threshold near the ridge
USM_NEAR = (2.2, 40, 3)  # ... in the foreground
SS = 3                   # blade supersampling
COVER_FAR = 1.5          # blade overlap (avg blades covering a pixel) far / near
COVER = 2.2
HP_FAR, HP_NEAR = 1.6, 5.0   # high-pass radius far / near
CLUMP = 0.45             # 0..1 patchiness of the detail contrast
# blade length (px) by image row, log-interpolated
LEN_KP = [(1100, 1.4), (1300, 2.0), (1500, 3.4), (1650, 5.5), (1760, 8.0),
          (1900, 13.0), (2050, 21.0), (2160, 30.0)]
# std of the luminance gain by image row (0.1 = +-10 %)
AMP_KP = [(1150, 0.07), (1400, 0.10), (1600, 0.13), (1760, 0.16), (2160, 0.20)]
WEBP_Q = 88
# --------------------------------------------------------------------------

T0 = time.time()


def log(msg):
    print(f'[{time.time() - T0:6.1f}s] {msg}', flush=True)


def interp(kp, y, logspace=False):
    if y <= kp[0][0]:
        return kp[0][1]
    for (y0, v0), (y1, v1) in zip(kp, kp[1:]):
        if y <= y1:
            t = (y - y0) / (y1 - y0)
            if logspace:
                return math.exp(math.log(v0) + t * (math.log(v1) - math.log(v0)))
            return v0 + t * (v1 - v0)
    return kp[-1][1]


def smoothstep(e0, e1, v):
    t = min(1.0, max(0.0, (v - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def fmath(expr, **imgs):
    return ImageMath.lambda_eval(expr, **imgs)


src = Image.open(SRC).convert('RGB')
W, H = src.size
R, G, B = src.split()
log(f'loaded {W}x{H}')


def row_ramp(fn):
    """L image whose every row is 255*fn(y)."""
    col = Image.new('L', (1, H))
    col.putdata([max(0, min(255, round(255 * fn(y)))) for y in range(H)])
    return col.resize((W, H), Image.NEAREST)


# ---- 1. horizon + alpha ---------------------------------------------------
grass = fmath(lambda a: ((a['g'] - a['b']) > 8) * 255, g=G, b=B).convert('L')
cols = grass.transpose(Image.Transpose.TRANSPOSE).tobytes()   # column x -> row x
y_start = int(H * 0.45)
run = b'\xff' * 12
hor = []
for x in range(W):
    i = cols.find(run, x * H + y_start, (x + 1) * H)
    hor.append(i - x * H if i >= 0 else H)
alpha_t = b''.join(b'\x00' * h + b'\xff' * (H - h) for h in hor)
hard = Image.frombytes('L', (H, W), alpha_t).transpose(Image.Transpose.TRANSPOSE)
alpha = hard.filter(ImageFilter.MinFilter(3)) if ERODE else hard
alpha = alpha.filter(ImageFilter.GaussianBlur(ALPHA_BLUR))
ymin = max(0, min(hor) - 8)
log(f'horizon y {min(hor)}..{max(hor)}')

# ---- 2. fill above the horizon with grass colour ---------------------------
PICK = 4  # colour a few px below the ridge (pure grass, no sky mix)
sp = src.load()
row = Image.new('RGB', (W, 1))
row.putdata([sp[x, min(H - 1, hor[x] + PICK)] for x in range(W)])
below = hard.transform((W, H), Image.AFFINE, (1, 0, 0, 0, 1, -PICK))  # mask moved down PICK px
base = Image.composite(src, row.resize((W, H), Image.NEAREST), below)

# near = 0 at the ridge .. 1 at the bottom of the frame
near = row_ramp(lambda y: smoothstep(1250, 2100, y))

# ---- 3. denoise (sigma filter) ----------------------------------------------
def sigma_filter(ch, radius, t, k):
    bl = ch.filter(ImageFilter.GaussianBlur(radius))
    return fmath(lambda a: a['c'] + (a['b'] - a['c']) * a['k'] *
                 a['max'](1.0 - abs(a['c'] - a['b']) / a['t'], 0.0),
                 c=ch.convert('F'), b=bl.convert('F'), k=k, t=t).convert('L')


if DENOISE > 0:
    base = Image.merge('RGB', [sigma_filter(c, 1.2, DENOISE_T, DENOISE) for c in base.split()])

# ---- 4. depth-tuned unsharp mask --------------------------------------------
base = Image.composite(base.filter(ImageFilter.UnsharpMask(*USM_NEAR)),
                       base.filter(ImageFilter.UnsharpMask(*USM_FAR)), near)
log('denoised + sharpened')

# ---- 5a. grass mask (where texture is allowed) ------------------------------
bR, bG, _ = base.split()
gmask = fmath(lambda a: (a['g'] - a['r'] - 6.0) * (255.0 / 14.0),
              g=bG.convert('F'), r=bR.convert('F')).convert('L')
gmask = gmask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.5))

# ---- 5b. blade texture: whole hill, drawn back (ridge) to front -------------
rnd = random.Random(SEED)
rr = rnd.random
gauss = rnd.gauss


def smooth_field(cell, lo, hi, size):
    """Deterministic smooth noise: random grid every `cell` px, bicubic up."""
    gw, gh = W // cell + 3, H // cell + 3
    g = Image.new('L', (gw, gh))
    g.putdata([int(lo + (hi - lo) * rr()) for _ in range(gw * gh)])
    return g.resize(size, Image.BICUBIC)


# wind-combed clumps: per-area lean bias, sampled per blade on a /8 grid
LC = 8
lean_px = smooth_field(90, 0, 255, (W // LC + 1, H // LC + 1)).load()
BG_V = 70
cy0 = ymin - 4
canvas = Image.new('L', (W * SS, (H - cy0) * SS), BG_V)
line = ImageDraw.Draw(canvas).line
sin, cos = math.sin, math.cos
n_blades = 0
for y in range(cy0, H + 24):
    Lrow = interp(LEN_KP, y, True)
    wrow = min(2.2, max(1.0 / SS, Lrow / 14.0))
    cover = COVER_FAR + (COVER - COVER_FAR) * smoothstep(1300, 1700, y)
    per_row = cover * W / (wrow * Lrow)
    n = int(per_row) + (1 if rr() < per_row - int(per_row) else 0)
    yl = min(H - 1, y) // LC
    for _ in range(n):
        x = rr() * W
        xi = int(x)
        dy = y - hor[xi]
        if dy < -1:
            continue
        L = Lrow * (0.6 + 0.4 * smoothstep(0, 140, dy))
        ln = L * (0.55 + 0.9 * rr()) * SS
        w = min(2.4, max(1.0 / SS, L / 14.0 * (0.7 + 0.6 * rr())))
        a = (lean_px[xi // LC, yl] - 128) * (0.22 / 128.0) + gauss(0.0, 0.16)
        tone = 0.9 + 0.1 * rr() if rr() < 0.06 else 0.12 + 0.7 * rr() ** 1.3
        vb = int(BG_V + 18 + 55 * tone)
        vt = int(BG_V + 18 + 150 * tone)
        x0, y0 = x * SS, (y + rr() - cy0) * SS
        if L < 4.0:  # tiny far blade: a single tick
            line((x0, y0, x0 + sin(a) * ln, y0 - cos(a) * ln),
                 fill=(vb + vt) >> 1, width=max(1, round(w * SS)))
        else:        # base half (shaded) + bent tip half (lit, thinner)
            h1 = ln * 0.5
            x1 = x0 + sin(a) * h1
            y1 = y0 - cos(a) * h1
            a2 = a + a * (0.3 + 0.9 * rr()) + gauss(0.0, 0.05)
            line((x0, y0, x1, y1), fill=vb, width=max(1, round(w * SS)))
            line((x1, y1, x1 + sin(a2) * h1, y1 - cos(a2) * h1),
                 fill=vt, width=max(1, round(w * SS * 0.55)))
        n_blades += 1
log(f'drew {n_blades} blades')
tex = Image.new('L', (W, H), BG_V + 60)
tex.paste(canvas.reduce(SS), (0, cy0))
del canvas

# zero-mean detail: high-pass with a radius that grows with blade size
lo = Image.composite(tex.filter(ImageFilter.GaussianBlur(HP_NEAR)),
                     tex.filter(ImageFilter.GaussianBlur(HP_FAR)), near)
hp = fmath(lambda a: a['t'] - a['l'], t=tex.convert('F'), l=lo.convert('F'))
hp8 = fmath(lambda a: a['h'] + 128.0, h=hp).convert('L')
del lo

# normalise per depth band so AMP_KP is the std of the gain at that row
bands = []
for yc in range(1180, H, 60):
    y0, y1 = max(0, yc - 30), min(H, yc + 30)
    xs = [x for x in range(200, W - 200) if hor[x] < y0 - 30]
    if len(xs) >= 200:
        box = (xs[0], y0, min(W, xs[0] + 1600), y1)
        bands.append((yc, ImageStat.Stat(hp8.crop(box)).stddev[0]))
log('texture std by row: ' + ', '.join(f'{y}:{s:.0f}' for y, s in bands))
AMP_SCALE = 4000.0  # amp ramp stored as L, scaled to fit 0..255
amp_row = row_ramp(lambda y: interp(AMP_KP, y) / interp(bands, y) * AMP_SCALE / 255.0)
clump = smooth_field(140, int(255 * (1 - CLUMP)), 255, (W, H))  # contrast patches

gain = fmath(
    lambda a: 1.0 + a['hp'] * (a['gm'] / 255.0) * (a['cl'] / 255.0) * (a['am'] / a['S']),
    hp=hp, gm=gmask.convert('F'), cl=clump.convert('F'), am=amp_row.convert('F'),
    S=AMP_SCALE)
out = Image.merge('RGB', [fmath(lambda a: a['c'] * a['g'], c=c.convert('F'), g=gain).convert('L')
                          for c in base.split()])
log('applied texture')

# ---- 6. sunny grade + alpha --------------------------------------------------
out = ImageEnhance.Color(out).enhance(1.08)
out = ImageEnhance.Brightness(out).enhance(1.10)
out.putalpha(alpha)
out.save(OUT, 'WEBP', quality=WEBP_Q, method=6, exact=False)
log(f'saved {OUT} ({os.path.getsize(OUT) / 1e6:.2f} MB)')
