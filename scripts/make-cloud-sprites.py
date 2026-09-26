"""Key the ChatGPT cloud photos (flat blue sky) into transparent WebP sprites.

    python make-cloud-sprites.py [SRC_DIR] [OUT_DIR] [--debug] [--only=01,02]

SRC_DIR  folder with cloud-01.png .. cloud-10.png   (default: this folder)
OUT_DIR  where NN.webp + sprites.json are written  (default: SRC_DIR/sprites)

Pipeline (pure Pillow, no numpy):
  1. sky field   the background is a nearly flat blue (~90,171,252) with a few
                 units of drift. Pixels within BG_TOL of the border-strip median
                 are background; everything else is dilated ~10 px (soft halos)
                 and excluded. A 48x32 grid of masked means is hole-filled by
                 Laplace relaxation (a membrane under each cloud), smoothed and
                 bicubic-upsampled into a smooth per-pixel sky estimate S.
  2. unmix       p = a*C + (1-a)*S with C assumed near-neutral (R=G=B). Both
                 blue-minus-red and green-minus-red excess give a transparency
                   t = ((B-R)+(G-R)) / ((S_B-S_R)+(S_G-S_R))
                 (the two estimates weighted by their dynamic range; noise
                 ~0.005), a = 1 - t.
  3. core fill   the photos' cloud bases are sky-lit blue-grey (98,132,175 is
                 only a=0.5 under the neutral model), which would make the
                 shaded underside half transparent and ghostly on another sky
                 or over another cloud. Where a > CORE_T the mask is eroded by
                 CORE_R px, blurred by CORE_R and max()'d into alpha, so the
                 interior becomes opaque (keeping the photo's own blue-grey
                 shading) while the outer CORE_R px keep the measured soft edge.
                 Off for the cirrus wisps.
  4. colour      un-premultiplied C = (p - (1-a)*S) / a, clamped. On the source
                 sky this reproduces the photo exactly; on any other sky the
                 soft edges pick up that sky instead of the source blue.
  5. cleanup     alpha below ALPHA_LO is zeroed with a soft knee up to ALPHA_HI;
                 crop to the content bbox + MARGIN, alpha faded to 0 over the
                 margin at the crop edges, downscaled only if wider than MAX_W.
  6. export      lossy WebP with alpha (q QUALITY, lossless alpha), NN.webp,
                 plus sprites.json (size, bytes, dense-cloud box per sprite).
"""
import json
import os
import sys

from PIL import Image, ImageChops, ImageFilter, ImageMath

HERE = os.path.dirname(os.path.abspath(__file__))
args = [a for a in sys.argv[1:] if not a.startswith('--')]
FLAGS = [a for a in sys.argv[1:] if a.startswith('--')]
SRC_DIR = args[0] if len(args) > 0 else HERE
OUT_DIR = args[1] if len(args) > 1 else os.path.join(SRC_DIR, 'sprites')
DEBUG = '--debug' in FLAGS
ONLY = None
for f in FLAGS:
    if f.startswith('--only='):
        ONLY = {s.strip().zfill(2) for s in f[7:].split(',') if s.strip()}
DBG = os.path.join(SRC_DIR, '_debug')

# ---------------------------------------------------------------- tunables
BORDER = 10          # border strip width (px) for the initial sky colour
BG_TOL = 9           # |p - border median| <= this in every channel = sky
HALO_Q = 4           # halo exclusion works at 1/4 resolution ...
HALO_R = 5           # ... MaxFilter size there (~10 px dilation at full res)
CELL = 32            # sky grid cell (px)
CELL_MIN = 0.6       # a cell needs this fraction of clean sky to be measured
RELAX_IT = 600       # Laplace hole-fill iterations on the grid
SMOOTH_IT = 2        # 3x3 smoothing passes on the filled grid
ALPHA_LO = 0.03      # alpha below this -> 0 ...
ALPHA_HI = 0.07      # ... with a smoothstep knee up to this
MARGIN = 18          # crop margin around the content bbox (px) ...
FADE = 16            # ... alpha fades to 0 over this many px at the crop edge
MAX_W = 1400         # downscale only if wider than this
QUALITY = 88         # WebP colour quality (alpha is lossless)
EDGE_A = 0.4         # below this alpha the colour is desaturated toward neutral

# per-sprite settings: core fill threshold / radius (None = no core fill)
DEFAULT = {'core_t': 0.30, 'core_r': 7, 'gamma': 1.0}
PER = {
    '06': {'core_r': 5},
    '07': {'core_r': 4},
    '08': {'core_r': 6},
    '09': {'core_t': None},
    '10': {'core_t': None},
}


def flat(im):
    """Pixel values as a list (get_flattened_data on Pillow >= 12.1)."""
    fn = getattr(im, 'get_flattened_data', None)
    return list(fn() if fn else im.getdata())


def lam(fn, **imgs):
    return ImageMath.lambda_eval(lambda a: fn(a), **imgs)


def clamp01(a, x):
    return a['min'](a['max'](x, 0.0), 1.0)


def hist_median(hist):
    n = sum(hist)
    acc = 0
    for v, c in enumerate(hist):
        acc += c
        if acc * 2 >= n:
            return v
    return 0


def border_median(ch):
    W, H = ch.size
    h = [0] * 256
    for box in ((0, 0, W, BORDER), (0, H - BORDER, W, H),
                (0, BORDER, BORDER, H - BORDER), (W - BORDER, BORDER, W, H - BORDER)):
        for i, c in enumerate(ch.crop(box).histogram()):
            h[i] += c
    return hist_median(h)


def sky_field(rgb):
    """Smooth per-pixel sky estimate (three 'F' images) + the clean-sky mask."""
    W, H = rgb.size
    chans = rgb.split()
    med = [border_median(c) for c in chans]
    # non-sky = any channel further than BG_TOL from the border median
    diff = None
    for c, m in zip(chans, med):
        d = ImageChops.difference(c, Image.new('L', c.size, m))
        diff = d if diff is None else ImageChops.lighter(diff, d)
    nonsky = diff.point(lambda v: 255 if v > BG_TOL else 0)
    q = nonsky.reduce(HALO_Q).point(lambda v: 255 if v > 0 else 0)
    q = q.filter(ImageFilter.MaxFilter(HALO_R))
    halo = q.resize((W, H), Image.NEAREST)
    sky = ImageChops.invert(ImageChops.lighter(halo, nonsky))  # 255 = clean sky

    gw, gh = max(4, round(W / CELL)), max(4, round(H / CELL))
    m = sky.convert('F')
    m = lam(lambda a: a['m'] / 255.0, m=m)
    mg = flat(m.resize((gw, gh), Image.BOX))
    fields = []
    for c in chans:
        cf = c.convert('F')
        vm = lam(lambda a: a['c'] * a['m'], c=cf, m=m).resize((gw, gh), Image.BOX)
        vmg = flat(vm)
        valid = [mg[i] >= CELL_MIN for i in range(gw * gh)]
        vals = [vmg[i] / mg[i] if valid[i] else 0.0 for i in range(gw * gh)]
        good = [vals[i] for i in range(gw * gh) if valid[i]]
        base = sum(good) / len(good) if good else float(med[len(fields)])
        vals = [v if ok else base for v, ok in zip(vals, valid)]
        holes = [i for i in range(gw * gh) if not valid[i]]
        for _ in range(RELAX_IT if holes else 0):
            nv = vals[:]
            for i in holes:
                x, y = i % gw, i // gw
                s = (vals[y * gw + max(0, x - 1)] + vals[y * gw + min(gw - 1, x + 1)] +
                     vals[max(0, y - 1) * gw + x] + vals[min(gh - 1, y + 1) * gw + x])
                nv[i] = s / 4.0
            vals = nv
        for _ in range(SMOOTH_IT):
            nv = vals[:]
            for y in range(gh):
                for x in range(gw):
                    s = 0.0
                    for dy in (-1, 0, 1):
                        for dx in (-1, 0, 1):
                            s += vals[min(gh - 1, max(0, y + dy)) * gw + min(gw - 1, max(0, x + dx))]
                    nv[y * gw + x] = s / 9.0
            vals = nv
        g = Image.new('F', (gw, gh))
        g.putdata(vals)
        fields.append(g.resize((W, H), Image.BICUBIC))
    return fields, sky, med, sum(1 for v in mg if v < CELL_MIN)


def ramp_image(w, h, fade):
    """F image: 0 at the outer edge, 1 at >= fade px inside."""
    def ramp(n):
        return [max(0.0, min(1.0, (min(i + 0.5, n - i - 0.5)) / fade)) for i in range(n)]
    rx = Image.new('F', (w, 1))
    rx.putdata(ramp(w))
    ry = Image.new('F', (1, h))
    ry.putdata(ramp(h))
    return lam(lambda a: a['x'] * a['y'],
               x=rx.resize((w, h), Image.NEAREST), y=ry.resize((w, h), Image.NEAREST))


def dense_box(alpha_l, thr=128):
    """bbox of the dense cloud (alpha >= thr/255) inside a sprite, as fractions."""
    b = alpha_l.point(lambda v: 255 if v >= thr else 0).getbbox()
    w, h = alpha_l.size
    if not b:
        return [0, 0, 1, 1]
    return [round(b[0] / w, 4), round(b[1] / h, 4), round(b[2] / w, 4), round(b[3] / h, 4)]


def key_one(nn):
    cfg = dict(DEFAULT, **PER.get(nn, {}))
    src = os.path.join(SRC_DIR, 'cloud-%s.png' % nn)
    rgb = Image.open(src).convert('RGB')
    W, H = rgb.size
    (sR, sG, sB), skymask, med, holes = sky_field(rgb)
    R, G, B = [c.convert('F') for c in rgb.split()]

    t = lam(lambda a: ((a['B'] - a['R']) + (a['G'] - a['R'])) /
            ((a['sB'] - a['sR']) + (a['sG'] - a['sR'])),
            R=R, G=G, B=B, sR=sR, sG=sG, sB=sB)
    araw = lam(lambda a: clamp01(a, 1.0 - a['t']), t=t)
    if cfg['gamma'] != 1.0:
        gm = cfg['gamma']
        araw = lam(lambda a: a['x'] ** gm, x=araw)

    alpha = araw
    if cfg['core_t'] is not None:
        ct, cr = cfg['core_t'], cfg['core_r']
        core = lam(lambda a: (a['x'] > ct) * 255.0, x=araw).convert('L')
        for _ in range(cr):
            core = core.filter(ImageFilter.MinFilter(3))
        core = core.filter(ImageFilter.GaussianBlur(cr * 0.8))
        coref = lam(lambda a: a['c'] / 255.0, c=core.convert('F'))
        alpha = lam(lambda a: a['max'](a['x'], a['c']), x=araw, c=coref)

    # un-premultiply against the sky field
    def unmix(p, s):
        return lam(lambda a: a['min'](a['max'](
            (a['p'] - (1.0 - a['al']) * a['s']) / a['max'](a['al'], 0.004), 0.0), 255.0),
            p=p, s=s, al=alpha)
    cR, cG, cB = unmix(R, sR), unmix(G, sG), unmix(B, sB)
    # faint edges (alpha < EDGE_A) carry leftover source-sky tint that shows as
    # a grey-blue rim on pale sky: pull them toward neutral grey
    cM = lam(lambda a: (a['r'] + a['g'] + a['b']) / 3.0, r=cR, g=cG, b=cB)
    wd = lam(lambda a: clamp01(a, (EDGE_A - a['al']) / EDGE_A), al=alpha)
    cR, cG, cB = [lam(lambda a: a['c'] + (a['m'] - a['c']) * a['w'], c=c, m=cM, w=wd)
                  for c in (cR, cG, cB)]

    lo, hi = ALPHA_LO, ALPHA_HI
    aout = lam(lambda a: a['al'] * (lambda k: k * k * (3.0 - 2.0 * k))(
        clamp01(a, (a['al'] - lo) / (hi - lo))), al=alpha)

    # crop
    al8 = lam(lambda a: a['x'] * 255.0 + 0.5, x=aout).convert('L')
    probe = al8.point(lambda v: 255 if v >= 5 else 0)
    probe = probe.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    bb = probe.getbbox()
    x0, y0 = max(0, bb[0] - MARGIN), max(0, bb[1] - MARGIN)
    x1, y1 = min(W, bb[2] + MARGIN), min(H, bb[3] + MARGIN)
    touches = [n for n, v in (('left', x0 == 0), ('top', y0 == 0), ('right', x1 == W), ('bottom', y1 == H)) if v]
    cw, ch = x1 - x0, y1 - y0
    fade = ramp_image(cw, ch, FADE)
    ac = lam(lambda a: a['x'] * a['f'], x=aout.crop((x0, y0, x1, y1)), f=fade)
    a8 = lam(lambda a: a['x'] * 255.0 + 0.5, x=ac).convert('L')
    rgb8 = [lam(lambda a: a['c'] + 0.5, c=c.crop((x0, y0, x1, y1))).convert('L')
            for c in (cR, cG, cB)]
    spr = Image.merge('RGBA', rgb8 + [a8])
    scaled = False
    if spr.width > MAX_W:
        nh = round(spr.height * MAX_W / spr.width)
        spr = spr.resize((MAX_W, nh), Image.LANCZOS)
        scaled = True

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, '%s.webp' % nn)
    spr.save(out, 'WEBP', quality=QUALITY, alpha_quality=100, method=6)
    nbytes = os.path.getsize(out)

    if DEBUG:
        os.makedirs(DBG, exist_ok=True)
        lam(lambda a: a['x'] * 255.0, x=araw).convert('L').save(os.path.join(DBG, '%s-araw.png' % nn))
        al8.save(os.path.join(DBG, '%s-alpha.png' % nn))
        skymask.save(os.path.join(DBG, '%s-skymask.png' % nn))
        Image.merge('RGB', [lam(lambda a: (a['s'] - m0) * 20.0 + 128.0, s=s).convert('L')
                            for s, m0 in zip((sR, sG, sB), med)]).save(os.path.join(DBG, '%s-skyfield-x20.png' % nn))

    sa = spr.getchannel('A')
    info = {
        'file': '%s.webp' % nn,
        'w': spr.width, 'h': spr.height, 'bytes': nbytes,
        'crop': [x0, y0, x1, y1], 'scaled': scaled, 'touches': touches,
        'dense': dense_box(sa, 128),     # alpha >= 0.5
        'body': dense_box(sa, 26),       # alpha >= 0.1
        'skyMedian': med, 'skyHoles': holes,
        'core': cfg['core_t'] is not None,
    }
    print('%s  %4dx%-4d %7.1f kB  crop=%s dense=%s %s' % (
        nn, spr.width, spr.height, nbytes / 1024, info['crop'], info['dense'],
        ('TOUCHES ' + ','.join(touches)) if touches else ''))
    return info


def main():
    ids = ['%02d' % i for i in range(1, 11)
           if os.path.exists(os.path.join(SRC_DIR, 'cloud-%02d.png' % i))]
    if ONLY:
        ids = [i for i in ids if i in ONLY]
    man_path = os.path.join(OUT_DIR, 'sprites.json')
    old = {}
    if os.path.exists(man_path):
        with open(man_path) as f:
            old = {s['file']: s for s in json.load(f).get('sprites', [])}
    for nn in ids:
        info = key_one(nn)
        old[info['file']] = info
    sprites = [old[k] for k in sorted(old)]
    total = sum(s['bytes'] for s in sprites)
    with open(man_path, 'w', newline='\n') as f:
        json.dump({'source': 'chatgpt-clouds/cloud-NN.png', 'total_bytes': total,
                   'sprites': sprites}, f, indent=1)
    print('total %.1f kB (%d sprites)' % (total / 1024, len(sprites)))


if __name__ == '__main__':
    main()
