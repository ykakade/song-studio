"""Run: ~/.local/bin/uv run --with pillow --with numpy python dither.py"""
from pathlib import Path
import math
import numpy as np
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent

def prepare(name, size):
    path = ROOT / f'{name}-source.png'
    src = Image.open(path).convert('L')
    src.save(path, optimize=True)
    a = np.asarray(ImageOps.fit(src, size, method=Image.Resampling.LANCZOS), dtype=float)
    a = np.clip((a - 12) * 1.12, 0, 255)
    h, w = a.shape
    y, x = np.mgrid[:h, :w]
    distance = np.minimum.reduce([x / w, (w-1-x) / w, y / h, (h-1-y) / h])
    fade = np.clip((distance - .06) / .055, 0, 1)
    fade = fade * fade * (3 - 2 * fade)
    a *= fade
    if name == 'welcome':
        left_fade = np.clip((x / w - .50) / .035, 0, 1)
        a *= left_fade
    a[a < 24] = 0
    return a

def atkinson(a):
    buf = a.copy()
    allowed = a > 0
    h, w = a.shape
    out = np.zeros((h,w), dtype=np.uint8)
    for y in range(h):
        for x in range(w):
            if not allowed[y,x]:
                continue
            value = 255 if buf[y,x] >= 128 else 0
            out[y,x] = value
            err = (buf[y,x] - value) / 8
            for dx,dy in ((1,0),(2,0),(-1,1),(0,1),(1,1),(0,2)):
                xx, yy = x+dx, y+dy
                if 0 <= xx < w and yy < h and allowed[yy,xx]:
                    buf[yy,xx] += err
    return out

def bayer(a):
    matrix = np.array([[0]])
    for _ in range(3):
        matrix = np.block([[4*matrix,4*matrix+2],[4*matrix+3,4*matrix+1]])
    h,w = a.shape
    thresholds = (np.tile(matrix, (math.ceil(h/8),math.ceil(w/8)))[:h,:w]+.5)/64*255
    return ((a > thresholds) & (a > 0)).astype(np.uint8)*255

def save(name, method, alpha):
    h,w = alpha.shape
    rgba = np.zeros((h,w,4),dtype=np.uint8)
    rgba[alpha > 0] = 255
    im = Image.fromarray(rgba).resize((w*2,h*2),Image.Resampling.NEAREST)
    im.save(ROOT / f'{name}-{method}.png',optimize=True,compress_level=9)
    bg = Image.new('RGB',im.size,'#121212')
    bg.paste(Image.new('RGB',im.size,'#d6d3cd'),mask=im.getchannel('A'))
    bg.save(ROOT / f'{name}-{method}-composite.png',optimize=True)
    return bg

if __name__ == '__main__':
    for name,size in [('welcome',(800,450)),('empty',(480,360))]:
        a = prepare(name,size)
        previews = [save(name,method,fn(a)) for method,fn in [('atkinson',atkinson),('bayer',bayer)]]
        comparison = Image.new('RGB',(size[0]*2,size[1]*4),'#121212')
        for i,im in enumerate(previews):
            comparison.paste(im,(0,i*size[1]*2))
        comparison.save(ROOT / f'{name}-comparison.png')
        # Selected after inspecting both composites: Atkinson preserves metal detail
        # without Bayer's repeating crosshatch, particularly on the mic grille.
        im = Image.open(ROOT / f'{name}-atkinson.png')
        dest = ROOT.parent / f'{name}.png'
        im.save(dest,optimize=True,compress_level=9)
        arr = np.asarray(im)
        alpha = arr[:,:,3]
        h,w = alpha.shape
        assert set(np.unique(alpha)) <= {0,255}
        assert np.all(arr[alpha==255] == 255)
        assert not alpha[:math.ceil(h*.06)].any()
        assert not alpha[-math.ceil(h*.06):].any()
        assert not alpha[:,:math.ceil(w*.06)].any()
        assert not alpha[:,-math.ceil(w*.06):].any()
        if name=='welcome': assert not alpha[:,:w//2].any()
        assert dest.stat().st_size < 400_000
        print(f'{dest}: {im.size}, {dest.stat().st_size} bytes; binary RGBA, margins verified')
