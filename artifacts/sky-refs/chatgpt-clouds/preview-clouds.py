"""Compose preview renders of the drifting cloud layer + emit the CSS/markup.

    python preview-clouds.py [SPRITE_DIR] [BLISS_JPG] [OUT_DIR]
"""
import sys, os, json
from PIL import Image, ImageDraw, ImageFilter, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
SPR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'sprites')
BLISS = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, '..', '..', '..', 'public', 'assets', 'bliss-4k.jpg')
OUT = sys.argv[3] if len(sys.argv) > 3 else HERE

# (sprite, width vw, 'top'|'base', y %, duration s, phase 0..1 at t=0, mirror)
# phase p -> translateX = -W + p*(100vw + W); delay = -p*duration
LAYOUT = [
    ('09', 30, 'top', 3.0, 420, 0.85, False),   # cirrus high right
    ('10', 24, 'top', 8.0, 380, 0.02, False),   # cirrus high left
    ('07', 22, 'base', 55.2, 720, 0.60, False), # distant row, behind ridge
    ('06', 16, 'base', 55.8, 650, 0.30, False), # distant flat
    ('06', 12, 'base', 57.0, 780, 0.78, True),
    ('08', 12, 'base', 50.0, 560, 0.84, False), # scraps low
    ('05', 9, 'top', 34.0, 210, 0.60, False),
    ('04', 12, 'top', 31.0, 240, 0.06, True),
    ('04', 15, 'top', 13.0, 215, 0.90, False),
    ('03', 17, 'top', 25.0, 235, 0.46, False),
    ('02', 30, 'top', 20.0, 290, 0.14, False),  # large left
    ('01', 27, 'top', 5.0, 265, 0.71, False),   # large tall right
]

TOP, MID, HOR = (0x3A, 0x91, 0xE8), (0x6E, 0xB7, 0xF5), (0xC4, 0xE5, 0xFC)
sprites = {}
def spr(nn):
    if nn not in sprites:
        sprites[nn] = Image.open(os.path.join(SPR, nn + '.webp')).convert('RGBA')
    return sprites[nn]

def sky(W, H):
    col = Image.new('RGB', (1, H))
    for y in range(H):
        f = y / (H - 1)
        if f < .34: a, b, t = TOP, MID, f / .34
        elif f < .62: a, b, t = MID, HOR, (f - .34) / .28
        else: a, b, t = HOR, HOR, 0
        col.putpixel((0, y), tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3)))
    im = col.resize((W, H)).convert('RGBA')
    glow = Image.new('L', (W, H), 0)
    r = int(W * .22)
    cx, cy = int(W * .30), int(-H * .06)
    ImageDraw.Draw(glow).ellipse((cx - r, cy - r, cx + r, cy + r), fill=150)
    glow = glow.filter(ImageFilter.GaussianBlur(r * .45))
    im.paste(Image.new('RGBA', (W, H), (255, 250, 225, 255)), (0, 0), glow)
    return im

def hill(W, H):
    b = Image.open(BLISS).convert('RGB')
    s = max(W / b.width, H / b.height)
    b = b.resize((round(b.width * s), round(b.height * s)), Image.LANCZOS)
    b = b.crop(((b.width - W) // 2, (b.height - H) // 2, (b.width - W) // 2 + W, (b.height - H) // 2 + H))
    r, g, bl = b.split()
    grass = ImageChops.subtract(g, bl).point(lambda v: 255 if v > 8 else 0)
    gp = grass.load()
    mask = Image.new('L', (W, H), 0); mp = mask.load()
    y0, need = int(H * .45), max(3, round(12 * H / 2160))
    for x in range(W):
        run = 0; top = H
        for y in range(y0, H):
            run = run + 1 if gp[x, y] else 0
            if run >= need: top = y - need + 1; break
        for y in range(top, H): mp[x, y] = 255
    mask = mask.filter(ImageFilter.GaussianBlur(0.7))
    out = b.convert('RGBA'); out.putalpha(mask)
    return out

def render(W, H, t, hl=None):
    im = sky(W, H)
    for nn, wv, mode, y, dur, p, mir in LAYOUT:
        s = spr(nn)
        w = round(W * wv / 100); h = round(w * s.height / s.width)
        c = s.resize((w, h), Image.LANCZOS)
        if mir: c = c.transpose(Image.FLIP_LEFT_RIGHT)
        top = round(H * y / 100) if mode == 'top' else round(H * y / 100) - h
        ph = (p + t / dur) % 1
        x = round(-w + ph * (W + w))
        _comp(im, c, x, top)
    im.alpha_composite(hl if hl is not None else hill(W, H))
    return im.convert('RGB')

def _comp(im, c, x, y):
    layer = Image.new('RGBA', im.size, (0, 0, 0, 0)); layer.paste(c, (x, y)); im.alpha_composite(layer)

def css():
    lines = ['.sky-clouds{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:1}',
             '.sky-cloud{position:absolute;left:0;height:auto;will-change:transform;animation:skyDrift linear infinite}',
             '.sky-cloud>img{display:block;width:100%;height:auto;transform:scaleX(-1)}',
             '@keyframes skyDrift{from{transform:translateX(-100%)}to{transform:translateX(100vw)}}',
             '@media (prefers-reduced-motion:reduce){.sky-cloud{animation-play-state:paused}}', '']
    for nn, wv, mode, y, dur, p, mir in LAYOUT:
        s = spr(nn)
        pos = f'top:{y}%' if mode == 'top' else f'bottom:{round(100 - y, 1)}%'
        st = f'width:{wv}vw;{pos};animation-duration:{dur}s;animation-delay:-{round(p * dur)}s'
        src = f'/assets/clouds/{nn}.webp'
        if mir: lines.append(f'<div class="sky-cloud" style="{st}"><img src="{src}" alt=""></div>')
        else: lines.append(f'<img class="sky-cloud" src="{src}" alt="" style="{st}">')
    return '\n'.join(lines)

if __name__ == '__main__':
    W, H = 1280, 720
    hl = hill(W, H)
    render(W, H, 0, hl).save(os.path.join(OUT, 'preview-t0.png'))
    render(W, H, 150, hl).save(os.path.join(OUT, 'preview-t150.png'))
    big = render(2560, 1440, 0)
    # crop around 01 (large tall, right)
    nn, wv, mode, y, dur, p, mir = LAYOUT[-1]
    w = round(2560 * wv / 100); x = round(-w + p * (2560 + w))
    cx = max(0, min(2560 - 1000, x + w // 2 - 500))
    big.crop((cx, 40, cx + 1000, 640)).save(os.path.join(OUT, 'preview-zoom.png'))
    s = spr('02'); tw = 600; th = round(tw * s.height / s.width); c = s.resize((tw, th), Image.LANCZOS)
    tint = Image.new('RGB', (tw * 3, th))
    for i, col in enumerate((TOP, MID, HOR)):
        tile = Image.new('RGBA', (tw, th), col + (255,)); tile.alpha_composite(c)
        tint.paste(tile.convert('RGB'), (i * tw, 0))
    tint.save(os.path.join(OUT, 'preview-tint.png'))
    open(os.path.join(OUT, 'cloud-layer.css.txt'), 'w', newline='\n').write(css() + '\n')
    print(css())
