# 生成各种格式的测试图：一个 PNG 基准 + 同内容的 TIFF 多个变体 + BMP/GIF/WEBP
import os
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), 'fmt')
os.makedirs(OUT, exist_ok=True)

W, H = 33, 17  # 故意用非整除尺寸，暴露行对齐问题


def base(mode):
    img = Image.new(mode, (W, H))
    px = img.load()
    for y in range(H):
        for x in range(W):
            r = (x * 8 + y * 3) % 256
            g = (x * 3 + y * 11) % 256
            b = (x * 17 + y * 5) % 256
            if mode == 'L':
                px[x, y] = (r + g + b) // 3
            elif mode == 'P':
                img_px = (x * 7 + y * 13) % 256
                px[x, y] = img_px
            elif mode == 'RGBA':
                px[x, y] = (r, g, b, 0 if (x + y) % 3 else 255)
            else:
                px[x, y] = (r, g, b)
    return img


def save(name, img, **kw):
    img.save(os.path.join(OUT, name), **kw)
    print(name, os.path.getsize(os.path.join(OUT, name)))


# 基准（浏览器 createImageBitmap 能直接读的格式）
save('ref.png', base('RGB'))
save('ref_rgba.png', base('RGBA'))
save('ref_gray.png', base('L'))

# 浏览器原生解码的位图/网络格式
save('ref.bmp', base('RGB'))
save('ref.gif', base('RGB').convert('P', palette=Image.ADAPTIVE, colors=64))
save('ref.webp', base('RGB'))

# TIFF：压缩 x 通道数 组合
for comp in ['none', 'raw', 'tiff_lzw', 'tiff_deflate', 'adobe_deflate', 'tiff_packbits', 'deflate']:
    try:
        save(f't_rgb_{comp}.tif', base('RGB'), compression=comp)
    except Exception as e:
        print('skip', comp, e)

for comp in ['none', 'tiff_lzw', 'adobe_deflate']:
    try:
        save(f't_rgba_{comp}.tif', base('RGBA'), compression=comp)
    except Exception as e:
        print('skip rgba', comp, e)

save('t_gray_none.tif', base('L'))
save('t_gray_lzw.tif', base('L'), compression='tiff_lzw')
save('t_pal_none.tif', base('P'), compression='none')

# 预测器（水平差分）
try:
    save('t_rgb_lzw_pred.tif', base('RGB'), compression='tiff_lzw', predictor=2)
except Exception as e:
    print('skip predictor', e)

# 瓦片布局
try:
    save('t_rgb_tile.tif', base('RGB'), tiling=True)
except Exception as e:
    print('skip tiling', e)

# 16 位/通道（Pillow 不直接写 RGB;16B，手写一个最小的无压缩 16 位 TIFF）
import struct


def write_rgb16_tiff(name, img):
    w, h = img.size
    px = img.load()
    data = bytearray()
    for y in range(h):
        for x in range(w):
            for c in range(3):
                data += struct.pack('<H', px[x, y][c] * 257)
    bps_at = 8 + 2 + 12 * 9 + 4
    strip_at = bps_at + 6
    entries = [
        (256, 4, 1, w), (257, 4, 1, h), (258, 3, 3, bps_at), (259, 3, 1, 1),
        (262, 3, 1, 2), (273, 4, 1, strip_at), (277, 3, 1, 3), (278, 4, 1, h),
        (279, 4, 1, len(data)),
    ]
    out = bytearray(b'II' + struct.pack('<HI', 42, 8))
    out += struct.pack('<H', len(entries))
    for tag, typ, cnt, val in entries:
        raw = val
        if typ == 3 and cnt == 1:
            raw = struct.pack('<HH', val, 0)
        elif typ == 4 and cnt == 1:
            raw = struct.pack('<I', val)
        else:
            raw = struct.pack('<I', val)
        out += struct.pack('<HHI', tag, typ, cnt) + raw
    out += struct.pack('<I', 0)
    assert len(out) == bps_at
    out += struct.pack('<HHH', 16, 16, 16)
    assert len(out) == strip_at
    out += data
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(out)
    print(name, len(out))


write_rgb16_tiff('t_rgb16_none.tif', base('RGB'))

# 大图（性能与行对齐）
big = Image.new('RGB', (512, 384))
bp = big.load()
for y in range(384):
    for x in range(512):
        bp[x, y] = ((x * y) % 256, (x + y) % 256, (x - y) % 256)
save('t_big_lzw.tif', big, compression='tiff_lzw')
save('ref_big.png', big)

# 分页多帧：解码器应取第一页
p1 = base('RGB')
p2 = base('RGB').rotate(90).resize((H, W))
p1.save(os.path.join(OUT, 't_multipage.tif'), save_all=True, append_images=[p2])
print('t_multipage.tif', os.path.getsize(os.path.join(OUT, 't_multipage.tif')))
print('OK ->', OUT)
