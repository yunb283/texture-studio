from PIL import Image
import math, random

def ball(path, w, h, n, bg=(16,18,26)):
    frames=[]
    for i in range(n):
        im=Image.new('RGB',(w,h),bg)
        px=im.load()
        # 背景条纹：让每帧的 LZW 不至于太规整
        for y in range(0,h,7):
            for x in range(0,w,7):
                v=((x//37+y//53+i//9)%5)*9
                for dy in range(min(7,h-y)):
                    for dx in range(min(7,w-x)):
                        px[x+dx,y+dy]=(20+v,22+v,28+v)
        cx=int(w/2+math.sin(i/n*math.pi*4)*w*0.38)
        cy=int(h/2+math.cos(i/n*math.pi*3)*h*0.34)
        r=int(min(w,h)*0.18)
        for y in range(max(0,cy-r),min(h,cy+r)):
            for x in range(max(0,cx-r),min(w,cx+r)):
                d=(x-cx)**2+(y-cy)**2
                if d<r*r:
                    t=1-d/(r*r)
                    px[x,y]=(int(60+180*t),int(90+120*t),int(200*t))
        frames.append(im)
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=60, loop=0, optimize=False, disposal=2)

ball('tmp/fx/mid.gif',800,600,100)
ball('tmp/fx/big.gif',1280,720,180)
print('ok')
