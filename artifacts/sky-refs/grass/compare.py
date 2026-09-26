"""Before/after crops + 1280x720 preview for make-hill.py output.

before = the plain recipe (source jpg, Color x1.08, Brightness x1.10, same alpha)
after  = decoded bliss-hill.webp
Both are composited over sky-approved.png (upscaled to 4K) so only the grass differs.

usage: python compare.py [hill.webp] [suffix]
"""
import os
import sys

from PIL import Image, ImageDraw, ImageEnhance

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
HILL = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'bliss-hill.webp')
SUF = sys.argv[2] if len(sys.argv) > 2 else ''

hill = Image.open(HILL).convert('RGBA')
W, H = hill.size
src = Image.open(os.path.join(REPO, 'public', 'assets', 'bliss-4k.jpg')).convert('RGB')
before = ImageEnhance.Brightness(ImageEnhance.Color(src).enhance(1.08)).enhance(1.10)
before.putalpha(hill.getchannel('A'))
sky_small = Image.open(os.path.join(HERE, '..', 'sky-approved.png')).convert('RGBA')
sky = sky_small.resize((W, H), Image.BICUBIC)

CROPS = {
    'ridge': (1500, 1150, 2300, 1600),
    'front': (300, 1750, 1100, 2160),
}
BAR = 22
for name, box in CROPS.items():
    s = sky.crop(box)
    b = Image.alpha_composite(s, before.crop(box)).convert('RGB')
    a = Image.alpha_composite(s, hill.crop(box)).convert('RGB')
    cw, chh = b.size
    out = Image.new('RGB', (cw * 2 + 6, chh + BAR), (255, 255, 255))
    out.paste(b, (0, BAR))
    out.paste(a, (cw + 6, BAR))
    d = ImageDraw.Draw(out)
    d.text((6, 5), 'BEFORE  source + grade (100%)', fill=(0, 0, 0))
    d.text((cw + 12, 5), 'AFTER  make-hill.py (100%)', fill=(0, 0, 0))
    out.save(os.path.join(HERE, f'compare-{name}{SUF}.png'))

full = Image.alpha_composite(sky_small, hill.resize(sky_small.size, Image.LANCZOS))
full.convert('RGB').save(os.path.join(HERE, f'preview-full{SUF}.png'))
print('ok')
