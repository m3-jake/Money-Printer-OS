# Bliss hill enhancer + cutout -> public/assets/bliss-hill.webp. Pillow only.
import time, random
from pathlib import Path
from PIL import Image, ImageFilter, ImageChops, ImageEnhance
t0=time.time()
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'public'/'assets'/'bliss-hill.webp'
PREV=ROOT/'artifacts'/'sky-refs'/'grass'
src=Image.open(ROOT/'public'/'assets'/'bliss-4k.jpg').convert('RGB'); W,H=src.size
# 1 deblock: light median then blend back
img=Image.blend(src,src.filter(ImageFilter.MedianFilter(3)),0.6)
# 2 grass texture: slightly tilted streak noise, fine (ridge) and coarse (front)
def streaks(sx,sy,sig):
    w,h=W//sx,H//sy; pw,ph=int(w*1.1)+2,int(h*1.1)+2
    n=Image.effect_noise((pw,ph),sig).rotate(3,Image.BICUBIC)
    n=n.crop(((pw-w)//2,(ph-h)//2,(pw-w)//2+w,(ph-h)//2+h)).resize((W,H),Image.BICUBIC)
    return n.filter(ImageFilter.GaussianBlur(0.9))
random.seed(1)
fine=ImageChops.add(streaks(1,5,50),streaks(2,7,40),2,0)
coarse=ImageChops.add(streaks(2,13,60),streaks(3,23,50),2,0).filter(ImageFilter.GaussianBlur(1.5))
lin=Image.linear_gradient('L').resize((W,H))  # 0 top ->255 bottom
depth=lin.point(lambda v:max(0,min(255,int((v-110)*2.0))))
tex=Image.composite(coarse,fine,depth)
# high-pass the texture so it's zero-mean around 128
tex=ImageChops.subtract(tex,tex.filter(ImageFilter.GaussianBlur(3)),1,128)
# 3 luminance-only: sharpen Y, soft-light texture into Y
y,cb,cr=img.convert('YCbCr').split()
yf=y.filter(ImageFilter.UnsharpMask(1.2,45,3))
yf=Image.composite(y.filter(ImageFilter.UnsharpMask(1.8,60,3)),yf,depth)
tl=Image.composite(tex.point(lambda v:int(128+(v-128)*0.15)),tex.point(lambda v:int(128+(v-128)*0.2)),depth)
# fade the texture out below depth 0.85
cut=int(255*0.85)
fade=lin.point(lambda v:255 if v<=cut else max(0,int(255*(1-(v-cut)/(255-cut)))))
tl=Image.composite(tl,Image.new('L',(W,H),128),fade)
ys=ImageChops.soft_light(yf,tl)
# restrict texture to grass (G-B>8), not sky
r,g,b=src.split()
grass=ImageChops.subtract(g,b).point(lambda v:255 if v>8 else 0)
ys=Image.composite(ys,yf,grass.filter(ImageFilter.GaussianBlur(2)))
img=Image.merge('YCbCr',(ys,cb,cr)).convert('RGB')
img=ImageEnhance.Color(img).enhance(1.02); img=ImageEnhance.Brightness(img).enhance(1.04)
# 4 cutout: per-column scan from 45% height, first run >=12 grass px
gb=grass.tobytes(); a=bytearray(W*H); y0=int(H*.45)
for x in range(W):
    run=0; top=H
    for yy in range(y0,H):
        if gb[yy*W+x]:
            run+=1
            if run>=12: top=yy-11; break
        else: run=0
    for yy in range(top,H): a[yy*W+x]=255
al=Image.frombytes('L',(W,H),bytes(a)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.5))
out=img.convert('RGBA'); out.putalpha(al)
out.save(OUT,quality=86,method=4)
# previews (only when the refs folder exists)
def cmp(box,name):
    a_=src.crop(box); b_=out.crop(box).convert('RGB')
    c=Image.new('RGB',(a_.width*2+8,a_.height),'white'); c.paste(a_,(0,0)); c.paste(b_,(a_.width+8,0)); c.save(PREV/name)
if PREV.is_dir():
    cmp((1500,1150,2300,1600),'compare-ridge.png'); cmp((300,1750,1100,2160),'compare-front.png')
print('bytes',OUT.stat().st_size,'secs',round(time.time()-t0,1))
