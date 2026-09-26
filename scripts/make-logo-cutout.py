"""Cut the 3D "MONEY PRINTER OS" logo out of its black background.

Model: the source is a render on pure black, i.e. a premultiplied-over-black
image. The solid object (glossy green faces + dark metallic extrusion/bevels)
must end up fully opaque; everything outside the object's silhouette is green
glow / sparkle light added over black, which becomes a semi-transparent layer
with colour = rgb / alpha (un-premultiplied), so it reads correctly over a
bright sky instead of as a dark smudge.

Steps
  1. classify pixels: "barrier" = anything that cannot be glow over black
     (neutral metal, whitish rims, blown highlights); green pixels (glow and
     faces) and black are passable, subject to smooth-step rules.
  2. seal pin-holes in the barrier (dilate), flood-fill the passable pixels
     from the image border -> outside region; reconstruct it back up to the
     barrier. body = not outside (enclosed dark holes are body = holes filled).
  3. clean the body mask (drop specks / 1-2px sparkle rays, close hairline
     leaks) and feather it ~1px.
  4. downscale source + mask to the output size, then per pixel
        A = max(body, glow_curve(max channel))   C = rgb / A
     (inside the body C = rgb, so the dark metal stays dark and opaque).
  5. crop to the alpha bbox (+ margin) first, so the saved file is OUT_W wide;
     save WebP (lossless) + PNG.

Run:  python make-logo-cutout.py [--debug] [--lossy]
(pure Pillow, no numpy; ~30 s)
"""
import os
import sys
from collections import deque

from PIL import Image, ImageDraw, ImageFilter, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# original render (1448x1086, black bg)
SRC = os.path.join(HERE, "assets", "mpo-logo-3d-source.webp")
OUT = os.path.join(ROOT, "public", "assets", "mpo-logo-3d.webp")
SKY = os.path.join(ROOT, "artifacts", "sky-refs", "sky-approved.png")   # previews only, optional

OUT_W = 960            # output width in px (displays ~320 CSS px at DPR 1.5-3)
DEBUG = "--debug" in sys.argv     # also write debug-body.png / debug-barrier.png
LOSSY = "--lossy" in sys.argv     # WebP q92 (alpha lossless) instead of lossless

# ---- tunables -------------------------------------------------------------
CORE = 250             # max channel >= this is always solid (blown highlights)
METAL_MIN = 8          # below this max channel colour is noise -> passable
GLOW_RG = 0.62         # glow colour: R <= GLOW_RG*G (+4) ...
GLOW_BG = 0.24         #              B <= GLOW_BG*G (+3); anything else is metal
GLOW_RG_DIM = 0.45     # stricter R/G (+2) below DIM_M: dim glow is pure green, while
DIM_M = 90             # the olive underside of the extrusion is not
SEAL = 5               # MaxFilter size used to seal gaps in the barrier
DROP = 8               # max darkening per 1px step the outside flood may take
UP = 12                # max brightening per 1px step (glow ramps up smoothly)
CLOSE = 5              # closing size on the body mask (hairline leaks)
OPEN = 3               # opening size on the body mask (sparkle rays, specks)
MIN_PART = 1500        # body components smaller than this (px) are noise
FEATHER = 0.5          # gaussian radius for the 1px edge feather
GLOW_LO = 3.0          # max-channel level that maps to alpha 0 (noise floor)
GLOW_GAIN = 1.4        # alpha = gain * ((m - lo) / (255 - lo)) ** gamma
GLOW_GAMMA = 0.75
GLOW_MAX_RG = 0.6      # un-premultiplied glow colour clamp: R <= 0.6*G ...
GLOW_MAX_BG = 0.2      # ... B <= 0.2*G (keeps the glow green, never olive/grey)
TRIM_ALPHA = 3         # bbox threshold (0-255) for trimming
TRIM_PAD = 4           # extra px around the bbox


def classify(im):
    """Return an 'L' image: 255 = barrier (solid), 0 = passable.

    Glow over black is always green-yellow with almost no blue, so any pixel
    that is not that colour (neutral/grey metal, whitish rim highlights,
    blown-out sparkle cores) is solid. Green pixels (glow AND the green
    faces) stay passable here; the faces are protected by the brightness
    step rules in flood_outside (no big jumps up or down)."""
    w, h = im.size
    src = im.tobytes()
    out = bytearray(w * h)
    for i in range(w * h):
        r = src[3 * i]
        g = src[3 * i + 1]
        b = src[3 * i + 2]
        m = r if r > g else g
        if b > m:
            m = b
        if m >= CORE:
            out[i] = 255
        elif m >= METAL_MIN:
            if m >= DIM_M:
                rmax = GLOW_RG * g + 4
            else:
                rmax = GLOW_RG_DIM * g + 2
            if g < r or g < b or b > GLOW_BG * g + 3 or r > rmax:
                out[i] = 255
    return Image.frombytes("L", (w, h), bytes(out))


def max_channel(im):
    r, g, b = im.split()
    return ImageChops.lighter(ImageChops.lighter(r, g), b)


def flood_outside(im, barrier):
    """4-connected flood from the image border over non-barrier pixels.

    Step rules: a step may not get darker by more than DROP levels (glow over
    black only ever gets brighter towards the object, so the flood stops at
    the sharp drop into the object's dark outline/bevels even where the rim
    line has a gap) nor brighter by more than UP levels (glow ramps up
    smoothly; stepping onto a lit face or rim is a jump).
    Phase 1 runs on the barrier dilated by SEAL (seals pin-holes in the rim);
    phase 2 re-grows up to SEAL//2+1 px into the dilation ring (still
    monotone, never through real barrier pixels).
    Returns bytearray, 1 = outside."""
    w, h = im.size
    n = w * h
    m = max_channel(im).tobytes()
    bar = barrier.tobytes()
    sealed = barrier.filter(ImageFilter.MaxFilter(SEAL)).tobytes()
    out = bytearray(n)
    q = deque()
    for x in range(w):
        for i in (x, (h - 1) * w + x):
            if not sealed[i] and not out[i]:
                out[i] = 1
                q.append(i)
    for y in range(h):
        for i in (y * w, y * w + w - 1):
            if not sealed[i] and not out[i]:
                out[i] = 1
                q.append(i)
    ring = []
    drop = DROP
    up = UP
    last = n - w
    while q:
        i = q.popleft()
        lim = m[i] - drop
        top = m[i] + up
        x = i % w
        for j in ((i - 1) if x else -1, (i + 1) if x < w - 1 else -1,
                  (i - w) if i >= w else -1, (i + w) if i < last else -1):
            if j < 0 or out[j] or m[j] < lim or m[j] > top:
                continue
            if sealed[j]:
                if not bar[j]:
                    ring.append((j, i))
                continue
            out[j] = 1
            q.append(j)
    # phase 2: depth-limited regrow into the seal ring
    depth = SEAL // 2 + 1
    frontier = ring
    for _ in range(depth):
        nxt = []
        for j, i in frontier:
            if out[j] or bar[j] or m[j] < m[i] - drop or m[j] > m[i] + up:
                continue
            out[j] = 1
            x = j % w
            for k in ((j - 1) if x else -1, (j + 1) if x < w - 1 else -1,
                      (j - w) if j >= w else -1, (j + w) if j < last else -1):
                if k >= 0 and not out[k] and not bar[k]:
                    nxt.append((k, j))
        frontier = nxt
    return out


def body_mask(im):
    barrier = classify(im)
    out = flood_outside(im, barrier)
    body = Image.frombytes("L", im.size, bytes(0 if v else 255 for v in out))
    if CLOSE:
        body = body.filter(ImageFilter.MaxFilter(CLOSE)).filter(ImageFilter.MinFilter(CLOSE))
    if OPEN:
        body = body.filter(ImageFilter.MinFilter(OPEN)).filter(ImageFilter.MaxFilter(OPEN))
    return barrier, drop_specks(body)


def drop_specks(mask):
    """Remove body components smaller than MIN_PART px (isolated noise pixels
    in the glow that the classifier called metal)."""
    w, h = mask.size
    px = bytearray(mask.tobytes())
    seen = bytearray(w * h)
    last = w * h - w
    kept = 0
    for s in range(w * h):
        if not px[s] or seen[s]:
            continue
        comp = [s]
        seen[s] = 1
        k = 0
        while k < len(comp):
            i = comp[k]
            k += 1
            x = i % w
            for j in ((i - 1) if x else -1, (i + 1) if x < w - 1 else -1,
                      (i - w) if i >= w else -1, (i + w) if i < last else -1):
                if j >= 0 and px[j] and not seen[j]:
                    seen[j] = 1
                    comp.append(j)
        if len(comp) < MIN_PART:
            for i in comp:
                px[i] = 0
        else:
            kept += 1
    if DEBUG:
        print("body parts kept:", kept)
    return Image.frombytes("L", (w, h), bytes(px))


def content_box(im, body):
    """Full-res bbox of everything that will get alpha >= TRIM_ALPHA."""
    m = max_channel(im)
    level = GLOW_LO + (TRIM_ALPHA / 255.0 / GLOW_GAIN) ** (1.0 / GLOW_GAMMA) * (255.0 - GLOW_LO)
    glow = m.point(lambda v: 255 if v >= level else 0)
    x0, y0, x1, y1 = ImageChops.lighter(glow, body).getbbox()
    pad = TRIM_PAD * 2
    return (max(0, x0 - pad), max(0, y0 - pad), min(im.width, x1 + pad), min(im.height, y1 + pad))


def cutout(im, body, out_w):
    box = content_box(im, body)
    w = box[2] - box[0]
    h = box[3] - box[1]
    out_h = round(h * out_w / w)
    small = im.crop(box).resize((out_w, out_h), Image.LANCZOS)
    mask = body.filter(ImageFilter.GaussianBlur(FEATHER * w / out_w)).crop(box)
    mask = mask.resize((out_w, out_h), Image.LANCZOS)
    # colour for the feathered body edge: the eroded body's colour smeared
    # outward (normalised blur), so edge pixels never pick up the black bg
    er = body.filter(ImageFilter.MinFilter(3))
    rad = 3 * w / out_w
    num = Image.composite(im, Image.new("RGB", im.size), er).filter(ImageFilter.GaussianBlur(rad))
    den = er.filter(ImageFilter.GaussianBlur(rad))
    num = num.crop(box).resize((out_w, out_h), Image.BOX).tobytes()
    den = den.crop(box).resize((out_w, out_h), Image.BOX).tobytes()
    s = small.tobytes()
    mk = mask.tobytes()
    n = out_w * out_h
    rgba = bytearray(4 * n)
    lo = GLOW_LO
    span = 255.0 - lo
    for i in range(n):
        r = s[3 * i]
        g = s[3 * i + 1]
        b = s[3 * i + 2]
        m = r if r > g else g
        if b > m:
            m = b
        ga = (m - lo) / span
        if ga <= 0:
            ga = 0.0
        else:
            ga = GLOW_GAIN * ga ** GLOW_GAMMA
            if ga > 1:
                ga = 1.0
        a = mk[i] / 255.0
        j = 4 * i
        if 0 < mk[i] < 255 and a >= ga and den[i]:
            # semi-body edge: eroded-body colour, body alpha (no dark rim)
            d = den[i]
            rgba[j] = min(255, num[3 * i] * 255 // d)
            rgba[j + 1] = min(255, num[3 * i + 1] * 255 // d)
            rgba[j + 2] = min(255, num[3 * i + 2] * 255 // d)
            rgba[j + 3] = mk[i]
            continue
        glow = ga > a
        if glow:
            a = ga
        if a <= 0:
            continue
        if a >= 1:
            rgba[j], rgba[j + 1], rgba[j + 2], rgba[j + 3] = r, g, b, 255
            continue
        inv = 1.0 / a
        cr = min(255, int(r * inv + 0.5))
        cg = min(255, int(g * inv + 0.5))
        cb = min(255, int(b * inv + 0.5))
        if glow:
            cr = min(cr, int(GLOW_MAX_RG * cg))
            cb = min(cb, int(GLOW_MAX_BG * cg))
        rgba[j], rgba[j + 1], rgba[j + 2] = cr, cg, cb
        rgba[j + 3] = int(a * 255 + 0.5)
    return Image.frombytes("RGBA", (out_w, out_h), bytes(rgba))


def previews(logo):
    sky = Image.open(SKY).convert("RGB").resize((2560, 1440), Image.LANCZOS)
    css_w = 320
    css_h = round(logo.height * css_w / logo.width)
    lg = logo.resize((css_w, css_h), Image.LANCZOS)
    x = 2560 - 24 - css_w
    y = 18
    comp = sky.copy()
    comp.paste(lg, (x, y), lg)
    comp.save(os.path.join(ROOT, "artifacts", "sky-refs", "logo", "preview-topright.png"))
    # DPR-2 rendering of the same spot, shown 1:1 (i.e. a 2x zoom of the CSS view)
    pad = 40
    region = (x - pad, 0, 2560, y + css_h + pad)
    sky2 = sky.crop(region).resize(((region[2] - region[0]) * 2, (region[3] - region[1]) * 2), Image.LANCZOS)
    lg2 = logo.resize((css_w * 2, css_h * 2), Image.LANCZOS)
    lx, ly = pad * 2, y * 2
    sky2.paste(lg2, (lx, ly), lg2)
    # detail strip: two edge crops of that DPR-2 render, enlarged 2x (nearest)
    cw, ch, gap = 190, 130, 8
    spots = [(lx + 110, ly + 40), (lx + 640 - 20 - cw, ly + css_h * 2 - ch + 10)]
    sheet = Image.new("RGB", (sky2.width, sky2.height + gap + ch * 2), (255, 255, 255))
    sheet.paste(sky2, (0, 0))
    for k, (cx, cy) in enumerate(spots):
        crop = sky2.crop((cx, cy, cx + cw, cy + ch)).resize((cw * 2, ch * 2), Image.NEAREST)
        sheet.paste(crop, (k * (cw * 2 + gap), sky2.height + gap))
    sheet.save(os.path.join(ROOT, "artifacts", "sky-refs", "logo", "preview-zoom.png"))


def main():
    im = Image.open(SRC).convert("RGB")
    barrier, body = body_mask(im)
    if DEBUG:
        dbg = Image.composite(im, Image.new("RGB", im.size, (255, 0, 255)), body)
        dbg = Image.blend(im, dbg, 0.55)
        dbg.save(os.path.join(HERE, "debug-body.png"))
        barrier.save(os.path.join(HERE, "debug-barrier.png"))
    logo = cutout(im, body, OUT_W)
    if LOSSY:   # ~130 KB instead of ~430 KB; alpha stays lossless
        logo.save(OUT, "WEBP", quality=92, alpha_quality=100, method=6)
    else:
        logo.save(OUT, "WEBP", lossless=True, quality=100, method=6, exact=True)
    if os.path.exists(SKY):
        previews(logo)
    print("logo", logo.size)


if __name__ == "__main__":
    main()
