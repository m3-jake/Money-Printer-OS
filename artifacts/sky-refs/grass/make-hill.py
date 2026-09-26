# Bliss hill enhancer + cutout. Pillow only.
import time, random
from PIL import Image, ImageFilter, ImageChops, ImageEnhance
t0=time.time()
R='W:/money-printer-os/'; OUT=R+'artifacts/sky-refs/grass/'
src=Image.open(R+'public/assets/bliss-4k.jpg').convert('RGB'); W,H=src.size
# 1 deblock: light median then blend back
img=Image.blend(src,src.filter(ImageFilter.MedianFilter(3)),0.6)
# 2 grass texture: streak noise, fine (ridge) and coarse (front)
def streaks(sx,sy,sig):
    n=Image.effect_noise((W//sx,H//sy),sig).resize((W,H),Image.BICUBIC)
    return n.filter(ImageFilter.GaussianBlur(0.4))
random.seed(1)
fine=ImageChops.add(streaks(1,4,50),streaks(2,8,40),2,-128+128)
coarse=ImageChops.add(streaks(2,10,60),streaks(3,18,50),2,0)
depth=Image.linear_gradient('L').resize((W,H))  # 0 top ->255 bottom
depth=depth.point(lambda v:max(0,min(255,int((v-110)*2.0))))
tex=Image.composite(coarse,fine,depth)
# high-pass the texture so it's zero-mean around 128
tex=ImageChops.add(ImageChops.subtract(tex,tex.filter(ImageFilter.GaussianBlur(6)),1,128),Image.new('L',(W,H),0))
# 3 luminance-only: sharpen Y, soft-light texture into Y
y,cb,cr=img.convert('YCbCr').split()
yf=y.filter(ImageFilter.UnsharpMask(1.6,70,2))
yf=Image.composite(y.filter(ImageFilter.UnsharpMask(2.5,90,2)),yf,depth)
tl=tex.point(lambda v:int(128+(v-128)*0.4))
ys=ImageChops.soft_light(yf,tl)
# restrict texture to grass (G-B>8), not sky
r,g,b=src.split()
grass=ImageChops.subtract(g,b).point(lambda v:255 if v>8 else 0)
ys=Image.composite(ys,yf,grass.filter(ImageFilter.GaussianBlur(2)))
img=Image.merge('YCbCr',(ys,cb,cr)).convert('RGB')
img=ImageEnhance.Color(img).enhance(1.08); img=ImageEnhance.Brightness(img).enhance(1.10)
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
out.save(OUT+'bliss-hill.webp',quality=86,method=4)
# previews
def cmp(box,name):
    a_=src.crop(box); b_=out.crop(box).convert('RGB')
    c=Image.new('RGB',(a_.width*2+8,a_.height),'white'); c.paste(a_,(0,0)); c.paste(b_,(a_.width+8,0)); c.save(OUT+name)
cmp((1500,1150,2300,1600),'compare-ridge.png'); cmp((300,1750,1100,2160),'compare-front.png')
sky=Image.open(R+'artifacts/sky-refs/sky-approved.png').convert('RGBA').resize((W,H))
sky.alpha_composite(out); sky.convert('RGB').resize((1280,720),Image.LANCZOS).save(OUT+'preview-full.png')
print('secs',round(time.time()-t0,1))
