#!/usr/bin/env python3
"""make-hill.py - Bliss hill asset: crisper grass + transparent sky cut-out.

Source : public/assets/bliss-4k.jpg (3840x2160, a soft upscale)
Output : bliss-hill.webp (3840x2160 RGBA, transparent above the ridge)

Pipeline (Pillow only, no numpy):
  1. Horizon per column: grass = G-B>8, scan down from 45% height, first run of
     >= 12 grass px. Alpha 255 below, 0 above, optional 1px erode, blur 1.5.
  2. Fill everything above the horizon with the grass colour of that column so
     sharpening and the soft alpha edge never pick up sky colour (no fringe).
  3. Mild edge-preserving denoise (sigma filter) to lift JPEG/upscale smudge.
  4. Unsharp mask tuned per depth (fine near the ridge, wider in the foreground).
  5. Procedural grass detail, luminance only (multiplicative gain):
       - far  : vertical-streak noise (sub-pixel blades read as fine grain)
       - near : ~1M anti-aliased grass blades drawn back-to-front at 3x, with
                perspective scale (1-2 px near the ridge, ~30 px at the bottom),
                slight random lean + bend, tapered, lit tips / shaded bases.
     Texture is high-passed (zero mean) so the macro Bliss look is unchanged and
     masked off the dark band, the yellow flowers and non-grass pixels.
  6. Sunny grade: Color x1.08, Brightness x1.10.

usage: python make-hill.py [src.jpg] [out.webp]
"""
import math
import os
import random
import sys
import time

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageMath

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, 'public', 'assets', 'bliss-4k.jpg')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'bliss-hill.webp')

# ---- tunables -------------------------------------------------------------
SEED = 20010825
ERODE = True            # 1px alpha erode before the blur (kills right-horizon specks)
ALPHA_BLUR = 1.5
DENOISE = 0.6           # 0..1 strength of the sigma filter
DENOISE_T = 7.0         # levels: differences above this are treated as real detail
USM_FAR = (1.0, 70, 2)  # radius, percent, threshold near the ridge
USM_NEAR = (2.2, 45, 3) # in the foreground
AMP_FAR = 0.10          # luminance gain amplitude of the far streak noise
AMP_NEAR = 0.30         # ... of the blade texture (foreground)
COVER = 2.2             # blade overlap (avg blades covering a pixel)
SS = 3                  # blade supersampling
BLADE_Y0 = 1380         # blades start here (above: noise only)
WEBP_Q = 88
# blade length (px) by image row, log-interpolated
LEN_KP = [(1100, 1.4), (1300, 2.0), (1500, 3.4), (1650, 5.5), (1760, 8.0),
          (1900, 13.0), (2050, 21.0), (2160, 30.0)]
# --------------------------------------------------------------------------

T0 = time.time()


def log(msg):
    print(f'[{time.time() - T0:6.1f}s] {msg}', flush=True)


def interp_len(y):
    kp = LEN_KP
    if y <= kp[0][0]:
        return kp[0][1]
    for (y0, l0), (y1, l1) in zip(kp, kp[1:]):
        if y <= y1:
            t = (y - y0) / (y1 - y0)
            return math.exp(math.log(l0) + t * (math.log(l1) - math.log(l0)))
    return kp[-1][1]


def smoothstep(e0, e1, v):
    t = min(1.0, max(0.0, (v - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def row_ramp(W, H, fn):
    """L image whose every row is 255*fn(y)."""
    col = Image.new('L', (1, H))
    col.putdata([max(0, min(255, round(255 * fn(y)))) for y in range(H)])
    return col.resize((W, H), Image.NEAREST)


def fmath(expr, **imgs):
    return ImageMath.lambda_eval(expr, **imgs)


src = Image.open(SRC).convert('RGB')
W, H = src.size
R, G, B = src.split()
log(f'loaded {W}x{H}')

# ---- 1. horizon + alpha ---------------------------------------------------
grass = fmath(lambda a: ((a['g'] - a['b']) > 8) * 255, g=G, b=B).convert('L')
cols = grass.transpose(Image.Transpose.TRANSPOSE).tobytes()   # column x = row x
y_start = int(H * 0.45)
run = b'\xff' * 12
hor = []
for x in range(W):
    i = cols.find(run, x * H + y_start, (x + 1) * H)
    hor.append(i - x * H if i >= 0 else H)
alpha_t = b''.join(b'\x00' * h + b'\xff' * (H - h) for h in hor)
alpha = Image.frombytes('L', (H, W), alpha_t).transpose(Image.Transpose.TRANSPOSE)
if ERODE:
    alpha = alpha.filter(ImageFilter.MinFilter(3))
alpha = alpha.filter(ImageFilter.GaussianBlur(ALPHA_BLUR))
log(f'horizon: min y {min(hor)}, max y {max(hor)}')

# ---- 2. fill above the horizon with grass colour ---------------------------
PICK = 4  # take the colour a few px below the ridge (pure grass, no sky mix)
row = Image.new('RGB', (W, 1))
sp = src.load()
row.putdata([sp[x, min(H - 1, hor[x] + PICK)] for x in range(W)])
fill = row.resize((W, H), Image.NEAREST)
hard = Image.frombytes('L', (H, W), alpha_t).transpose(Image.Transpose.TRANSPOSE)
hard = hard.transform((W, H), Image.AFFINE, (1, 0, 0, 0, 1, -PICK))  # shift mask down by PICK
base = Image.composite(src, fill, hard)
ymin = max(0, min(hor) - 8)
log('filled sky region')

# ---- depth ramps ---------------------------------------------------------
# near = 0 at the ridge .. 1 at the bottom of the frame
near_fn = lambda y: smoothstep(1250, 2100, y)
near = row_ramp(W, H, near_fn)

# ---- 3. denoise (sigma filter) ----------------------------------------------
def sigma_filter(ch, radius, t, k):
    bl = ch.filter(ImageFilter.GaussianBlur(radius))
    return fmath(lambda a: a['c'] + (a['b'] - a['c']) * a['k'] *
                 a['max'](1.0 - abs(a['c'] - a['b']) / a['t'], 0.0),
                 c=ch.convert('F'), b=bl.convert('F'), k=k, t=t).convert('L')


def denoise(img):
    return Image.merge('RGB', [sigma_filter(c, 1.2, DENOISE_T, DENOISE) for c in img.split()])


if DENOISE > 0:
    base = denoise(base)
    log('denoised')

# ---- 4. depth-tuned unsharp mask --------------------------------------------
far_sh = base.filter(ImageFilter.UnsharpMask(*USM_FAR))
near_sh = base.filter(ImageFilter.UnsharpMask(*USM_NEAR))
base = Image.composite(near_sh, far_sh, near)
log('sharpened')

# ---- 5a. grass mask (where texture is allowed) ------------------------------
bR, bG, bB = base.split()
gmask = fmath(lambda a: (a['g'] - a['r'] - 6.0) * (255.0 / 14.0),
              g=bG.convert('F'), r=bR.convert('F')).convert('L')
gmask = gmask.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.GaussianBlur(2))
log('grass mask')

# ---- 5b. far texture: vertical streak noise ---------------------------------
rnd = random.Random(SEED)
random.seed(SEED)
noise = Image.effect_noise((W, H - ymin), 48)
vk = [0, 0, 1, 0, 0,
      0, 0, 2, 0, 0,
      0, 0, 3, 0, 0,
      0, 0, 2, 0, 0,
      0, 0, 1, 0, 0]
streak = noise.filter(ImageFilter.Kernel((5, 5), vk, scale=9))
far_tex = Image.new('L', (W, H), 128)
far_tex.paste(streak, (0, ymin))
log('far texture')

# ---- 5c. near texture: blades -----------------------------------------------
BG_V = 70
cy0 = BLADE_Y0 - 30  # draw a margin above so blades reaching up are complete
ch_ = H - cy0
canvas = Image.new('L', (W * SS, ch_ * SS), BG_V)
dr = ImageDraw.Draw(canvas)
line = dr.line
n_blades = 0
rr = rnd.random
gauss = rnd.gauss
for y in range(BLADE_Y0 - 5, H + 20):
    L = interp_len(y)
    w = min(2.2, max(1.0 / SS, L / 14.0))
    per_row = COVER * W / (w * L)
    n = int(per_row) + (1 if rr() < per_row - int(per_row) else 0)
    wss = max(1, round(w * SS))
    wtip = max(1, round(w * SS * 0.55))
    for _ in range(n):
        x = rr() * W
        by = y + rr()
        ln = L * (0.6 + 0.8 * rr())
        a = gauss(0.03, 0.2)
        bend = a * (0.4 + 0.8 * rr())
        tone = rr()
        tone = tone * tone ** 0.5  # skew toward darker, a few bright lit blades
        vb = int(BG_V + 30 + 90 * tone * 0.6)
        vt = int(BG_V + 30 + 150 * tone)
        # segment 1 (base half)
        h1 = ln * 0.5
        x0, y0 = x * SS, (by - cy0) * SS
        x1 = x0 + math.sin(a) * h1 * SS
        y1 = y0 - math.cos(a) * h1 * SS
        a2 = a + bend
        x2 = x1 + math.sin(a2) * h1 * SS
        y2 = y1 - math.cos(a2) * h1 * SS
        line((x0, y0, x1, y1), fill=vb, width=wss)
        line((x1, y1, x2, y2), fill=vt, width=wtip)
        n_blades += 1
log(f'drew {n_blades} blades')
blades = canvas.reduce(SS)
near_tex = Image.new('L', (W, H), BG_V + 60)
near_tex.paste(blades, (0, cy0))
log('near texture')


def highpass(img, r):
    lo = img.filter(ImageFilter.GaussianBlur(r))
    return fmath(lambda a: a['i'] - a['l'], i=img.convert('F'), l=lo.convert('F'))


far_hp = highpass(far_tex, 3)
near_hp = highpass(near_tex, 5)


def std(imgF, box):
    st = imgF.crop(box)
    data = st.getdata()
    n = len(data)
    m = sum(data) / n
    return math.sqrt(sum((v - m) ** 2 for v in data) / n)


s_far = std(far_hp, (1000, 1300, 1400, 1400))
s_near = std(near_hp, (1000, 1950, 1400, 2050))
log(f'texture std far {s_far:.1f} near {s_near:.1f}')

# blend: near weight by row
wblade = row_ramp(W, H, lambda y: smoothstep(BLADE_Y0 + 20, BLADE_Y0 + 180, y))
amp_far = row_ramp(W, H, lambda y: AMP_FAR * (0.6 + 0.4 * smoothstep(1150, 1450, y)))
amp_near = row_ramp(W, H, lambda y: AMP_NEAR * (0.55 + 0.45 * smoothstep(1500, 2100, y)))

gain = fmath(
    lambda a: 1.0 + (a['gm'] / 255.0) * (
        (1.0 - a['wb'] / 255.0) * (a['af'] / 255.0) * a['fh'] / a['sf'] +
        (a['wb'] / 255.0) * (a['an'] / 255.0) * a['nh'] / a['sn']),
    gm=gmask.convert('F'), wb=wblade.convert('F'),
    af=amp_far.convert('F'), an=amp_near.convert('F'),
    fh=far_hp, nh=near_hp, sf=s_far, sn=s_near)
log('gain map')

out = Image.merge('RGB', [fmath(lambda a: a['c'] * a['g'], c=c.convert('F'), g=gain).convert('L')
                          for c in base.split()])
log('applied texture')

# ---- 6. sunny grade + alpha --------------------------------------------------
out = ImageEnhance.Color(out).enhance(1.08)
out = ImageEnhance.Brightness(out).enhance(1.10)
out.putalpha(alpha)
out.save(OUT, 'WEBP', quality=WEBP_Q, method=6, exact=False)
log(f'saved {OUT} ({os.path.getsize(OUT) / 1e6:.2f} MB)')
