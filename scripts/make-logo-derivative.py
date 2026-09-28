"""Write the sized dashboard derivative of the "MONEY PRINTER OS" logo master.

Model: this is a *placement* fix, not a compression one (P3.1 / P3.5 in
PROGRESS.md). The master `public/assets/money-printer-logo.png` is a 1024 px
RGBA render at 1,290,441 bytes, and it has zero compression headroom left. But
every place the desktop actually draws it is a small box:

    64 px  boot mark          public/dashboard.html:52  (mpo-shell.css .bootmark)
    72 px  updater brand mark public/dashboard.html:1509
    80 px  glance brand mark  public/dashboard.html:1679 (mpo-glance.css .g-brand img)
   108 px  money brand mark   public/dashboard.html:1518
   120 px  stacked-bill FX    public/dashboard.html:816  (fxBill stack, w = 120)

So the browser pays the whole 1.29 MB to fill a 64 px slot during boot.

Steps
  1. resize the master with LANCZOS to SIZE (no retouching: the derivative is
     the same artwork, just the resolution the desktop can actually show).
  2. filter it *premultiplied*: the artwork has a soft glow edge whose
     transparent pixels are black, so straight-RGBA filtering would drag that
     black into the rim and darken the logo wherever it is composited (dark
     boot terminal, light window surfaces, sky). Premultiply -> resize ->
     divide the colour back out keeps the edges identical to the master's.
  3. save PNG, optimized, 8-bit RGBA, and print the weight it reclaimed.

SIZE = 512 is 3x the widest drawn box (120 px), which is the same rule the
master itself was sized by (see make-logo-cutout.py: "displays ~320 CSS px at
DPR 1.5-3"), so the logo stays sharp to DPR 4.3 in the widest slot instead of
going soft above DPR 2.1 as a 256 px derivative would.

Run:  python make-logo-derivative.py   (~1 s, pure Pillow)
The 1024 px master is left in place (it is the packaging/icns source and
tests/visual-assets.test.mjs pins it); the derivative is what the dashboard
draws, and that same test pins the five references.
"""
import hashlib
import os

from PIL import Image, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "public", "assets", "money-printer-logo.png")
OUT = os.path.join(ROOT, "public", "assets", "money-printer-logo-512.png")

SIZE = 512              # px; 3x the widest dashboard slot (120 px stacked bill)
MAX_BYTES = 420_000     # refuse to land a derivative that silently bloats


def premultiplied(im):
    """Scale colour by alpha so transparent black cannot bleed into the rim."""
    r, g, b, a = im.split()
    return Image.merge("RGBA", (ImageChops.multiply(r, a), ImageChops.multiply(g, a),
                                ImageChops.multiply(b, a), a))


def unpremultiplied(im):
    """Divide the colour back out (alpha 0 stays black + transparent)."""
    px = bytearray(im.tobytes())
    for i in range(0, len(px), 4):
        a = px[i + 3]
        if a and a < 255:
            inv = 255.0 / a
            px[i] = min(255, int(px[i] * inv + 0.5))
            px[i + 1] = min(255, int(px[i + 1] * inv + 0.5))
            px[i + 2] = min(255, int(px[i + 2] * inv + 0.5))
    return Image.frombytes("RGBA", im.size, bytes(px))


def derivative(src):
    return unpremultiplied(premultiplied(src).resize((SIZE, SIZE), Image.LANCZOS))


def main():
    src = Image.open(SRC)
    if src.mode != "RGBA":
        raise SystemExit(f"{SRC} is {src.mode}; the dashboard contract is 8-bit RGBA")
    if min(src.size) < SIZE or src.width != src.height:
        raise SystemExit(f"{SRC} is {src.size}; expected a square master >= {SIZE} px")
    small = derivative(src)
    small.save(OUT, "PNG", optimize=True, compress_level=9)
    raw = open(OUT, "rb").read()
    if raw[25] != 6:
        raise SystemExit(f"{OUT} wrote colorType {raw[25]}; the dashboard needs 6 (RGBA)")
    if (int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")) != (SIZE, SIZE):
        raise SystemExit(f"{OUT} is not {SIZE}x{SIZE}")
    if len(raw) > MAX_BYTES:
        raise SystemExit(f"{OUT} is {len(raw)} bytes, over the {MAX_BYTES} budget")
    a = small.getchannel("A")
    print(f"src   {os.path.basename(SRC)} {src.size} {os.path.getsize(SRC):,} bytes")
    print(f"out   {os.path.basename(OUT)} {small.size} {len(raw):,} bytes "
          f"({len(raw) / os.path.getsize(SRC):.3f} of the master, "
          f"{(os.path.getsize(SRC) - len(raw)) / 1024:.0f} KiB reclaimed)")
    print(f"alpha {a.getextrema()}  sha256 {hashlib.sha256(raw).hexdigest()[:16]}")


if __name__ == "__main__":
    main()
