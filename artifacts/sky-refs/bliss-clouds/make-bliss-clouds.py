"""Extract photo-real cloud sprites from the Bliss wallpaper sky.

    python make-bliss-clouds.py [SRC_JPG] [OUT_DIR] [--debug] [--preview]

SRC_JPG  defaults to <repo>/public/assets/bliss-4k.jpg (3840x2160)
OUT_DIR  defaults to the folder this script lives in

Pipeline (pure Pillow, no numpy):
  1. horizon   per column: first run of >=12 grass px (G-B>8) scanning down from
               45% height, then extended upward over the dark distant ridge /
               bushes (B well below sky), exactly like the hill cutout.
  2. sky       clean-sky estimate behind the clouds: cloud pixels are masked
               (chroma B-R well below the local sky's, or R above it), holes are
               filled by push-pull (masked mip pyramid) and smoothed. 3 passes.
  3. unmix     each pixel is modelled as  p = a*C + (1-a)*S  with S the sky
               estimate and C a neutral (grey/white) cloud colour. Least squares
               over R,G,B gives a (alpha) and C per pixel; unlike an R-only
               alpha this keeps shaded cloud bases opaque instead of turning
               them into yellow-ish translucent smears. The colour is then
               un-premultiplied and pulled to neutral where alpha is low, which
               strips the old blue sky tint from thin wisps.
  4. split     connected components on a blurred, downsampled alpha; nearby
               pieces are merged into cloud groups; each group is cropped with a
               margin, masked to its own group and faded to 0 at the crop border
               (except the photo's top edge for 'top-edge' sprites).
  5. export    lossy WebP with alpha (q90), cloud-NN.webp + clouds.json.
With --preview it also composites the sky + sprites + hill previews (see LAYOUT).
"""
import json
import math
import os
import sys
from collections import deque

from PIL import Image, ImageChops, ImageFilter, ImageMath

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
args = [a for a in sys.argv[1:] if not a.startswith('--')]
FLAGS = {a for a in sys.argv[1:] if a.startswith('--')}
SRC = args[0] if len(args) > 0 else os.path.join(REPO, 'public', 'assets', 'bliss-4k.jpg')
OUT = args[1] if len(args) > 1 else HERE
DEBUG = '--debug' in FLAGS
DBG = os.path.join(OUT, '_debug')

# ---------------------------------------------------------------- tunables
GRASS_GB = 8            # grass: G - B > 8
GRASS_RUN = 12          # consecutive grass px that mark the horizon
SCAN_FROM = 0.45        # start the column scan at 45% height
DARK_B = 205            # above the grass: B below this = distant ridge / bushes
HOR_GAP = 4             # alpha is 0 this many px above the horizon ...
HOR_FADE = 36           # ... and fades in over this many px above that
SKY_SCALE = 4           # sky estimate is built at 1/4 resolution
ALPHA_FLOOR = 0.04      # alpha below this is noise -> 0 (soft knee)
WHITE = 244.0           # default cloud white for very thin wisps
SPLIT_SCALE = 8         # grouping works on a 1/8 alpha map
SPLIT_BLUR = 2.0        # blur radius (at 1/8) before thresholding
SEED_T = 0.22           # blurred alpha above this = cloud body (seeds)
LOW_T = 0.03            # blurred alpha above this = cloud incl. veil / soft edge
MERGE_DIST = 5          # seeds within this many 1/8 px (~40 px) form one cloud group
TERRITORY = 14          # veil px are given to the nearest group within this many 1/8 px
MIN_SEED_AREA = 30      # drop groups whose body is smaller than this (1/8 px)
MARGIN = 40             # crop margin (full-res px)
BORDER_FADE = 28        # alpha fade at crop borders (full-res px)
SIDE_FADE = 160         # longer fade where a cloud is cut by the photo's left/right edge
WEBP_Q = 90


def _sym(f):
    def g(a, b):
        if isinstance(a, (int, float)):  # ImageMath min/max want the image operand first
            a, b = b, a
        return f(a, b)
    return g


def ev(fn, **kw):
    return ImageMath.lambda_eval(
        lambda d: fn({**d, 'min': _sym(d['min']), 'max': _sym(d['max'])}), **kw)


def fblur(im, s):
    """Cheap smooth blur for F images (GaussianBlur needs 8-bit modes): box-reduce by s,
    bilinear back up, then once more at half the step to round off the creases."""
    w, h = im.size
    for k in (s, max(1, s // 2)):
        if k > 1:
            im = im.resize((max(1, w // k), max(1, h // k)), Image.BOX).resize((w, h), Image.BILINEAR)
    return im


def fimg(im):
    return im.convert('F')


def save_dbg(name, im):
    if not DEBUG:
        return
    os.makedirs(DBG, exist_ok=True)
    if im.mode == 'F':
        im = im.point(lambda v: v).convert('L')
    im.save(os.path.join(DBG, name))


# ---------------------------------------------------------------- 1. horizon
def find_horizon(src):
    W, H = src.size
    px = src.load()
    y0 = int(H * SCAN_FROM)
    hor = []
    for x in range(W):
        run = 0
        h = H
        for y in range(y0, H):
            r, g, b = px[x, y]
            if g - b > GRASS_GB:
                run += 1
                if run >= GRASS_RUN:
                    h = y - (GRASS_RUN - 1)
                    break
            else:
                run = 0
        # climb over dark non-sky stuff sitting on the grass (distant ridge, bushes)
        y = h - 1
        miss = 0
        top = h
        while y > y0:
            b = px[x, y][2]
            if b < DARK_B:
                top = y
                miss = 0
            else:
                miss += 1
                if miss > 3:
                    break
            y -= 1
        hor.append(top)
    # small min-filter so single-column misses don't poke through
    hs = hor[:]
    for x in range(W):
        hs[x] = min(hor[max(0, x - 2):x + 3])
    return hs


def horizon_mask(W, H, hor, gap, fade):
    """F image: 1 in open sky, fading to 0 at `gap` px above the horizon."""
    ys = Image.new('F', (1, H))
    ys.putdata([float(y) for y in range(H)])
    ys = ys.resize((W, H), Image.NEAREST)
    hs = Image.new('F', (W, 1))
    hs.putdata([float(h - gap) for h in hor[:W]])
    hs = hs.resize((W, H), Image.NEAREST)
    return ev(lambda d: d['min'](1.0, d['max'](0.0, (d['h'] - d['y']) / float(fade))), h=hs, y=ys)


# ---------------------------------------------------------------- 2. sky estimate
def push_pull(chans, mask):
    """Fill mask==0 holes of each F channel from the surrounding mask==1 pixels."""
    levels = []
    cs = [ev(lambda d: d['c'] * d['m'], c=c, m=mask) for c in chans]
    w = mask
    while min(w.size) > 2:
        levels.append((cs, w))
        nsz = (max(1, (w.size[0] + 1) // 2), max(1, (w.size[1] + 1) // 2))
        cs = [c.resize(nsz, Image.BOX) for c in cs]
        w = w.resize(nsz, Image.BOX)
    est = [ev(lambda d: d['c'] / d['max'](d['w'], 1e-6), c=c, w=w) for c in cs]
    for cs, w in reversed(levels):
        up = [e.resize(w.size, Image.BILINEAR) for e in est]
        # confident where w is high; a partially covered cell leans on the coarser level
        est = [ev(lambda d: d['c'] / d['max'](d['w'], 1e-6) * d['min'](1.0, d['w'] * 4.0)
                  + d['u'] * (1.0 - d['min'](1.0, d['w'] * 4.0)), c=c, u=u, w=w)
               for c, u in zip(cs, up)]
    return est


POLY_DEG = 5              # smooth 2D polynomial for the sky gradient
FIT_SCALE = 16            # the polynomial is fitted on a 1/16 grid


def _solve(A, b):
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        piv = M[c][c] or 1e-12
        for r in range(c + 1, n):
            f = M[r][c] / piv
            if f:
                for k in range(c, n + 1):
                    M[r][k] -= f * M[c][k]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        x[r] = (M[r][n] - sum(M[r][k] * x[k] for k in range(r + 1, n))) / (M[r][r] or 1e-12)
    return x


def _terms(u, v):
    t = []
    for i in range(POLY_DEG + 1):
        for j in range(POLY_DEG + 1 - i):
            t.append((u ** i) * (v ** j))
    return t


def _fit(samples, vals, keep):
    n = len(samples[0])
    A = [[0.0] * n for _ in range(n)]
    b = [0.0] * n
    for t, y, k in zip(samples, vals, keep):
        if not k:
            continue
        for i in range(n):
            ti = t[i]
            b[i] += ti * y
            Ai = A[i]
            for j in range(i, n):
                Ai[j] += ti * t[j]
    for i in range(n):
        for j in range(i):
            A[i][j] = A[j][i]
    return _solve(A, b)


def _poly_image(coef, w, h):
    im = Image.new('F', (w, h))
    data = []
    for y in range(h):
        v = 2.0 * (y + 0.5) / h - 1.0
        for x in range(w):
            u = 2.0 * (x + 0.5) / w - 1.0
            data.append(sum(c * t for c, t in zip(coef, _terms(u, v))))
    im.putdata(data)
    return im


def estimate_sky(rgb_small, open_small):
    """Clean sky behind the clouds, at 1/SKY_SCALE resolution.

    1. a smooth degree-5 polynomial per channel is fitted to sky samples on a coarse
       grid, robustly: clouds only ever add red, so samples whose R sits more than t
       above the current fit are dropped and the fit repeated with a shrinking t. The
       polynomial carries the gradient (and the bright horizon haze) into every hole.
    2. the residual (image - polynomial) on the surviving sky samples is push-pull
       filled and smoothed, which fixes the polynomial's local misfit without letting
       veils back in."""
    sw, sh = rgb_small.size
    fw, fh = max(8, sw * SKY_SCALE // FIT_SCALE), max(4, sh * SKY_SCALE // FIT_SCALE)
    tiny = rgb_small.resize((fw, fh), Image.BOX)
    otiny = open_small.resize((fw, fh), Image.BOX)
    tp = tiny.load()
    op = otiny.load()
    samples, R, G, B, ok = [], [], [], [], []
    for y in range(fh):
        v = 2.0 * (y + 0.5) / fh - 1.0
        for x in range(fw):
            if op[x, y] < 0.999:
                continue
            u = 2.0 * (x + 0.5) / fw - 1.0
            r, g, b = tp[x, y]
            samples.append(_terms(u, v))
            R.append(r); G.append(g); B.append(b)
            ok.append(b - r > 60)
    coefR = _fit(samples, R, ok)
    for t in (24.0, 14.0, 10.0, 8.0, 7.0):
        pr = [sum(c * q for c, q in zip(coefR, s_)) for s_ in samples]
        ok = [(-60.0 < r - p < t) for r, p in zip(R, pr)]
        coefR = _fit(samples, R, ok)
    print('sky fit: %d/%d coarse samples kept' % (sum(ok), len(ok)))
    coefs = [coefR, _fit(samples, G, ok), _fit(samples, B, ok)]
    polys = [_poly_image(c, fw, fh).resize((sw, sh), Image.BICUBIC) for c in coefs]
    # residual correction on the 1/SKY_SCALE grid; a few passes so it can climb into
    # places where the polynomial runs a little low (bright haze at the left edge)
    Rs, Gs, Bs = [fimg(c) for c in rgb_small.split()]
    est = polys
    for it, t in enumerate((7.0, 6.0, 5.0)):
        m = ev(lambda d: (d['R'] - d['p'] < t) * (d['R'] - d['p'] > -60.0) * (d['o'] > 0.99) * 255.0,
               R=Rs, p=est[0], o=open_small)
        m = m.convert('L').filter(ImageFilter.MinFilter(5))
        sky_m = fimg(m.point(lambda v: 1 if v > 127 else 0))
        res = [ev(lambda d: d['c'] - d['p'], c=c, p=p) for c, p in zip((Rs, Gs, Bs), polys)]
        res = push_pull(res, sky_m)
        res = [fblur(r_, 8) for r_ in res]
        est = [ev(lambda d: d['p'] + d['r'], p=p, r=r_) for p, r_ in zip(polys, res)]
    save_dbg('sky_mask.png', ev(lambda d: d['m'] * 255.0, m=sky_m))
    if DEBUG:
        save_dbg('sky_residual_R.png', ev(lambda d: (d['R'] - d['e']) * 6.0 + 128.0, R=Rs, e=est[0]))
        save_dbg('sky_poly_residual_R.png', ev(lambda d: (d['R'] - d['e']) * 6.0 + 128.0, R=Rs, e=polys[0]))
    return est


# ---------------------------------------------------------------- 3. unmix
def unmix(src_rgb, sky_rgb, open_m):
    R, G, B = [fimg(c) for c in src_rgb.split()]
    SR, SG, SB = sky_rgb
    kw = dict(R=R, G=G, B=B, SR=SR, SG=SG, SB=SB)
    Sm = ev(lambda d: (d['SR'] + d['SG'] + d['SB']) / 3.0, **kw)
    Pm = ev(lambda d: (d['R'] + d['G'] + d['B']) / 3.0, **kw)
    kw.update(Sm=Sm, Pm=Pm)
    num = ev(lambda d: (d['SR'] - d['Sm']) * (d['R'] - d['Pm']) + (d['SG'] - d['Sm']) * (d['G'] - d['Pm'])
             + (d['SB'] - d['Sm']) * (d['B'] - d['Pm']), **kw)
    den = ev(lambda d: (d['SR'] - d['Sm']) * (d['SR'] - d['Sm']) + (d['SG'] - d['Sm']) * (d['SG'] - d['Sm'])
             + (d['SB'] - d['Sm']) * (d['SB'] - d['Sm']), **kw)
    # slope of p against S = 1 - alpha
    a = ev(lambda d: 1.0 - d['n'] / d['max'](d['dn'], 1.0), n=num, dn=den)
    # the model says a neutral cloud; a pixel darker than its sky in every channel is a
    # shaded part -> opaque. a pixel that is not brighter than the sky in R is sky.
    a = ev(lambda d: d['min'](1.0, d['max'](0.0, d['a'])), a=a)
    fl = ALPHA_FLOOR
    a = ev(lambda d: d['max'](0.0, d['a'] - fl) / (1.0 - fl), a=a)
    a = ev(lambda d: d['a'] * d['o'], a=a, o=open_m)
    # un-premultiply against the estimated sky
    ai = ev(lambda d: d['max'](d['a'], 0.02), a=a)
    kw.update(ai=ai, a=a)
    C = [ev(lambda d, c=c, s=s: d['s'] + (d['c'] - d['s']) / d['ai'], c=cc, s=ss, ai=ai)
         for c, s, cc, ss in (('R', 'SR', R, SR), ('G', 'SG', G, SG), ('B', 'SB', B, SB))]
    g = ev(lambda d: d['min'](252.0, d['max'](120.0, (d['r'] + d['g'] + d['b']) / 3.0)), r=C[0], g=C[1], b=C[2])
    # trust the measured grey level only where the cloud is dense enough
    wg = ev(lambda d: d['min'](1.0, d['max'](0.0, (d['a'] - 0.08) / 0.32)), a=a)
    gf = ev(lambda d: WHITE + (d['g'] - WHITE) * d['w'], g=g, w=wg)
    # keep part of the cloud's own tint (warm tops, cool shade) only where it is dense
    wt = ev(lambda d: d['min'](1.0, d['max'](0.0, (d['a'] - 0.55) / 0.4)) * 0.6, a=a)
    out = []
    for c in C:
        o = ev(lambda d: d['gf'] + (d['min'](255.0, d['max'](0.0, d['c'])) - d['g']) * d['wt'],
               gf=gf, c=c, g=g, wt=wt)
        out.append(ev(lambda d: d['min'](255.0, d['max'](0.0, d['o'])), o=o))
    return a, out


# ---------------------------------------------------------------- 4. split
def label_components(mask_img):
    """4-connected components of an 'L' image (non-zero = on) -> (labels, comps)."""
    w, h = mask_img.size
    data = list(mask_img.get_flattened_data())
    lab = [0] * (w * h)
    comps = []
    n = 0
    for i in range(w * h):
        if data[i] and not lab[i]:
            n += 1
            q = deque([i])
            lab[i] = n
            x0 = y0 = 10 ** 9
            x1 = y1 = -1
            area = 0
            while q:
                j = q.popleft()
                x, y = j % w, j // w
                area += 1
                x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
                for k, ok in ((j - 1, x > 0), (j + 1, x < w - 1), (j - w, y > 0), (j + w, y < h - 1)):
                    if ok and data[k] and not lab[k]:
                        lab[k] = n
                        q.append(k)
            comps.append({'id': n, 'box': [x0, y0, x1 + 1, y1 + 1], 'area': area})
    return lab, comps


def territories(seed_lab, low, w, h, maxd):
    """Multi-source BFS: every 'low' pixel gets the label of the nearest seed within maxd."""
    out = seed_lab[:]
    dist = [0 if v else -1 for v in seed_lab]
    q = deque(i for i, v in enumerate(seed_lab) if v)
    while q:
        j = q.popleft()
        d = dist[j]
        if d >= maxd:
            continue
        x, y = j % w, j // w
        for k, ok in ((j - 1, x > 0), (j + 1, x < w - 1), (j - w, y > 0), (j + w, y < h - 1)):
            if ok and dist[k] < 0 and low[k]:
                dist[k] = d + 1
                out[k] = out[j]
                q.append(k)
    return out


def ramp_mask(w, h, fl, fr, ft, fb):
    """L image: 255 inside, linear ramps of the given widths at each border (0 = no ramp)."""
    def ramp(n, a, b):
        return [int(255 * max(0.0, min(1.0, (i / float(a)) if a else 1.0,
                                       ((n - 1 - i) / float(b)) if b else 1.0)) + 0.5) for i in range(n)]
    cx = Image.new('L', (w, 1)); cx.putdata(ramp(w, fl, fr))
    cy = Image.new('L', (1, h)); cy.putdata(ramp(h, ft, fb))
    return ImageChops.multiply(cx.resize((w, h), Image.NEAREST), cy.resize((w, h), Image.NEAREST))


def group_clouds(A, W, SKYH):
    S = SPLIT_SCALE
    sw, sh = W // S, SKYH // S
    a_small = A.resize((sw, sh), Image.BOX).filter(ImageFilter.GaussianBlur(SPLIT_BLUR))
    seed = a_small.point(lambda v: 255 if v > SEED_T * 255 else 0)
    low = list(a_small.point(lambda v: 255 if v > LOW_T * 255 else 0).get_flattened_data())
    # seeds closer than MERGE_DIST belong together: label the dilated seed map
    grown = seed.filter(ImageFilter.MaxFilter(2 * MERGE_DIST + 1))
    glab, gcomps = label_components(grown)
    sd = list(seed.get_flattened_data())
    seed_lab = [glab[i] if sd[i] else 0 for i in range(sw * sh)]
    body = {}
    for v in seed_lab:
        if v:
            body[v] = body.get(v, 0) + 1
    keep = {k for k, n in body.items() if n >= MIN_SEED_AREA}
    seed_lab = [v if v in keep else 0 for v in seed_lab]
    terr = territories(seed_lab, low, sw, sh, TERRITORY)
    boxes = {}
    for i, v in enumerate(terr):
        if v:
            x, y = i % sw, i // sw
            b = boxes.setdefault(v, [x, y, x + 1, y + 1])
            if x < b[0]: b[0] = x
            if y < b[1]: b[1] = y
            if x + 1 > b[2]: b[2] = x + 1
            if y + 1 > b[3]: b[3] = y + 1
    order = sorted(boxes, key=lambda k: (boxes[k][1] // 16, boxes[k][0]))
    return terr, [(k, boxes[k]) for k in order], (sw, sh)


def main():
    src = Image.open(SRC).convert('RGB')
    W, H = src.size
    print('source', SRC, W, H)
    hor = find_horizon(src)
    maxh = max(hor)
    SKYH = min(H, maxh + 8)
    print('horizon y range', min(hor), maxh)
    top = src.crop((0, 0, W, SKYH))
    open_full = horizon_mask(W, SKYH, hor, HOR_GAP, HOR_FADE)
    save_dbg('open.png', ev(lambda d: d['m'] * 255.0, m=open_full))
    sw, sh = W // SKY_SCALE, SKYH // SKY_SCALE
    small = top.resize((sw, sh), Image.BOX)
    open_small = horizon_mask(sw, sh, [h / SKY_SCALE for h in hor[::SKY_SCALE]][:sw], 2, 1)
    sky_small = estimate_sky(small, open_small)
    sky = [s.resize((W, SKYH), Image.BILINEAR) for s in sky_small]
    if DEBUG:
        Image.merge('RGB', [s.convert('L') for s in sky]).save(os.path.join(DBG, 'sky_est.png'))
    alpha, col = unmix(top, sky, open_full)
    save_dbg('alpha.png', ev(lambda d: d['a'] * 255.0, a=alpha))
    rgb = Image.merge('RGB', [c.convert('L') for c in col])
    A = ev(lambda d: d['a'] * 255.0, a=alpha).convert('L')
    if DEBUG:
        # the cutout over black and over the new sky colour, for a quick look
        bg = Image.new('RGB', (W, SKYH), (58, 145, 232))
        comp = Image.composite(rgb, bg, A)
        comp.resize((W // 2, SKYH // 2), Image.BOX).save(os.path.join(DBG, 'cutout_on_newsky.png'))
    full = rgb.copy()
    full.putalpha(A)
    if DEBUG:
        full.save(os.path.join(DBG, '_layer.png'))
        with open(os.path.join(DBG, '_horizon.json'), 'w', newline='') as f:
            json.dump(hor, f)
    sprites = split_and_export(full, A, hor, W, SKYH)
    with open(os.path.join(OUT, 'clouds.json'), 'w', newline='') as f:
        json.dump({'source': os.path.basename(SRC), 'size': [W, H], 'sprites': sprites}, f, indent=1)
    tot = sum(sp['bytes'] for sp in sprites)
    print('%d sprites, %.1f kB total' % (len(sprites), tot / 1024.0))


def split_and_export(full, A, hor, W, SKYH):
    S = SPLIT_SCALE
    terr, groups, (sw, sh) = group_clouds(A, W, SKYH)
    if DEBUG:
        from PIL import ImageDraw
        dbg = full.resize((W // 4, SKYH // 4), Image.BOX)
        dbg = Image.alpha_composite(Image.new('RGBA', dbg.size, (58, 145, 232, 255)), dbg)
        dr = ImageDraw.Draw(dbg)
        for i, (k, (gx0, gy0, gx1, gy1)) in enumerate(groups):
            dr.rectangle([gx0 * S / 4, gy0 * S / 4, gx1 * S / 4, gy1 * S / 4], outline=(255, 60, 60, 255), width=2)
            dr.text((gx0 * S / 4 + 4, gy0 * S / 4 + 2), '%02d' % (i + 1), fill=(255, 255, 0, 255))
        dbg.convert('RGB').save(os.path.join(DBG, 'groups.png'))
    out = []
    for i, (k, (gx0, gy0, gx1, gy1)) in enumerate(groups):
        m = Image.new('L', (sw, sh), 0)
        m.putdata([255 if v == k else 0 for v in terr])
        m = m.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1.0))
        x0 = max(0, gx0 * S - MARGIN)
        y0 = max(0, gy0 * S - MARGIN)
        x1 = min(W, gx1 * S + MARGIN)
        y1 = min(SKYH, gy1 * S + MARGIN)
        mfull = m.resize((sw * S, sh * S), Image.BILINEAR)
        if mfull.size != (W, SKYH):
            pad = Image.new('L', (W, SKYH), 0)
            pad.paste(mfull, (0, 0))
            mfull = pad
        mfull = mfull.crop((x0, y0, x1, y1))
        spr = full.crop((x0, y0, x1, y1))
        a = spr.getchannel('A')
        a = ImageChops.multiply(a, mfull)
        w, h = spr.size
        top_edge = y0 == 0 and max(a.crop((0, 0, w, 3)).get_flattened_data()) > 40
        cut_left = x0 == 0 and max(a.crop((0, 0, 3, h)).get_flattened_data()) > 40
        cut_right = x1 == W and max(a.crop((w - 3, 0, w, h)).get_flattened_data()) > 40
        # border fade; the photo top stays hard for top-edge sprites
        ramp = ramp_mask(w, h, SIDE_FADE if cut_left else BORDER_FADE,
                         SIDE_FADE if cut_right else BORDER_FADE,
                         0 if top_edge else BORDER_FADE, BORDER_FADE)
        a = ImageChops.multiply(a, ramp)
        # stats for classification
        hist = a.histogram()
        n_on = sum(hist[10:])
        mean_on = sum(v * hist[v] for v in range(10, 256)) / max(1, n_on) / 255.0
        dense = sum(hist[200:]) / max(1, n_on)
        hmin = min(hor[x0:x1])
        horizon = (y1 >= hmin - 10) and x0 > W * 0.45
        if top_edge:
            kind = 'top-edge'
        elif horizon:
            kind = 'horizon'
        elif dense < 0.12:
            kind = 'wisp'
        else:
            kind = 'cumulus'
        # colour under fully transparent px = cloud white (keeps any resampling clean)
        rgb = spr.convert('RGB')
        white = Image.new('RGB', (w, h), (244, 244, 246))
        rgb = Image.composite(rgb, white, a.point(lambda v: 255 if v else 0))
        spr = rgb.copy()
        spr.putalpha(a)
        name = 'cloud-%02d.webp' % (i + 1)
        path = os.path.join(OUT, name)
        spr.save(path, 'WEBP', quality=WEBP_Q, alpha_quality=100, method=6)
        info = {'file': name, 'box': [x0, y0, x1, y1], 'w': w, 'h': h, 'kind': kind,
                'meanAlpha': round(mean_on, 3), 'dense': round(dense, 3),
                'cut': [k for k, v in (('left', cut_left), ('right', cut_right), ('top', top_edge)) if v],
                'bytes': os.path.getsize(path)}
        out.append(info)
        print(info)
    return out


if __name__ == '__main__':
    main()
