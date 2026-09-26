"""1:1 before/after tiles at chosen spots -> _z/tiles-<suffix>-<name>.png"""
import os
import sys

from PIL import Image, ImageEnhance

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
hill = Image.open(sys.argv[1]).convert('RGBA')
SUF = sys.argv[2]
W, H = hill.size
src = Image.open(os.path.join(REPO, 'public', 'assets', 'bliss-4k.jpg')).convert('RGB')
before = ImageEnhance.Brightness(ImageEnhance.Color(src).enhance(1.08)).enhance(1.10)
before.putalpha(hill.getchannel('A'))
sky = Image.open(os.path.join(HERE, '..', 'sky-approved.png')).convert('RGBA').resize((W, H), Image.BICUBIC)
SPOTS = {
    'ridgeR': (3350, 1250),
    'ridgeL': (300, 1080),
    'midhill': (2200, 1500),
    'lowhill': (1500, 1560),
    'shadow': (300, 1450),
    'bandR': (3300, 1620),
    'bottom': (2000, 1920),
}
TW, TH = 400, 240
os.makedirs(os.path.join(HERE, '_z'), exist_ok=True)
for name, (x, y) in SPOTS.items():
    box = (x, y, x + TW, y + TH)
    s = sky.crop(box)
    b = Image.alpha_composite(s, before.crop(box)).convert('RGB')
    a = Image.alpha_composite(s, hill.crop(box)).convert('RGB')
    o = Image.new('RGB', (TW * 2 + 6, TH), 'white')
    o.paste(b, (0, 0))
    o.paste(a, (TW + 6, 0))
    o.save(os.path.join(HERE, '_z', f'tiles-{SUF}-{name}.png'))
print('ok')
