"""Composite procedural cloud sprites onto sky-approved.png (1280x720 preview).

Mirrors the app pipeline: sprite generated at half its displayed size, then
upscaled 2x (bilinear, like a CSS-scaled canvas). The hill is re-pasted on top
using the same mask recipe as scripts/make-hill-cutout.py (G-B>8, column scan
from 45% height, first run of >=12 grass px), so low clouds sit behind the ridge.

usage: python composite.py <out.png>
"""
import json, os, subprocess, sys
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'clouds-preview.png')
SCRATCH = os.environ.get('CLOUD_SCRATCH', os.path.join(HERE, '_sprites'))

sky = Image.open(os.path.join(HERE, 'sky-approved.png')).convert('RGBA')
W, H = sky.size
VW = W / 100.0
SCALE = float(os.environ.get('SPRITE_SCALE', '0.5'))  # sprite px per displayed px

# name, type, seed, displayed width (vw), aspect w:h, centre x (px), base/centre y (px), opt
# y for cumulus = the cloud's base line; for cirrus = its centre.
LAYOUT = [
    ('ci1', 'cirrus', 7001, 40, 4.5, 1010, 78, {}),
    ('ci2', 'cirrus', 7013, 30, 4.5, 610, 205, {'maxAlpha': 0.4}),
    ('c6', 'cumulus', 1601, 10, 2.5, 250, 400, {'haze': 0.40, 'opacity': 0.75}),
    ('c5', 'cumulus', 1501, 12, 2.5, 1010, 441, {'haze': 0.35, 'opacity': 0.78}),
    ('c4', 'cumulus', 1401, 15, 2.4, 575, 393, {'haze': 0.30, 'opacity': 0.8}),
    ('c3', 'cumulus', 1301, 21, 2.4, 1135, 318, {'haze': 0.15, 'opacity': 0.9}),
    ('c2', 'cumulus', 1201, 27, 2.2, 150, 262, {}),
    ('c1', 'cumulus', 1101, 32, 2.3, 850, 210, {}),
]

specs = []
for name, typ, seed, vw, aspect, cx, cy, opt in LAYOUT:
    dw = vw * VW
    w = max(8, round(dw * SCALE))
    h = max(4, round(w / aspect))
    specs.append({'name': name, 'type': typ, 'seed': seed, 'w': w, 'h': h, 'opt': opt})
os.makedirs(SCRATCH, exist_ok=True)
lay = os.path.join(SCRATCH, 'layout.json')
with open(lay, 'w', newline='') as f:
    json.dump(specs, f)
subprocess.run(['node', os.path.join(HERE, 'cloud-harness.mjs'), 'layout', lay, SCRATCH], check=True)

# hill mask from the approved image itself
px = sky.load()
mask = Image.new('L', (W, H), 0)
mp = mask.load()
y_start = int(H * 0.45)
for x in range(W):
    run = 0
    hor = H
    for y in range(y_start, H):
        r, g, b, _ = px[x, y]
        if g - b > 8:
            run += 1
            if run >= 12:
                hor = y - 11
                break
        else:
            run = 0
    for y in range(hor, H):
        mp[x, y] = 255
mask = mask.filter(ImageFilter.GaussianBlur(0.7))
hill = sky.copy()
hill.putalpha(mask)

canvas = sky.copy()
for (name, typ, seed, vw, aspect, cx, cy, opt), spec in zip(LAYOUT, specs):
    spr = Image.open(os.path.join(SCRATCH, name + '.png')).convert('RGBA')
    dw = round(vw * VW)
    dh = round(dw * spec['h'] / spec['w'])
    spr = spr.resize((dw, dh), Image.BILINEAR)
    if typ == 'cumulus':
        # base line sits at 80% of sprite height
        top = round(cy - dh * 0.80)
    else:
        top = round(cy - dh / 2)
    left = round(cx - dw / 2)
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    layer.paste(spr, (left, top))
    canvas = Image.alpha_composite(canvas, layer)
canvas = Image.alpha_composite(canvas, hill)
canvas.convert('RGB').save(OUT)
print('wrote', OUT)
