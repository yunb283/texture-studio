# 用 tifffile 补齐 Pillow 不写的 TIFF 变体：Deflate/PackBits/预测器/瓦片/大端
import os
import numpy as np
import tifffile
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), 'fmt')
W, H = 33, 17


def pattern():
    x = np.arange(W)[None, :].T if False else None
    gx, gy = np.meshgrid(np.arange(W), np.arange(H))
    r = (gx * 8 + gy * 3) % 256
    g = (gx * 3 + gy * 11) % 256
    b = (gx * 17 + gy * 5) % 256
    rgb = np.dstack([r, g, b]).astype(np.uint8)
    a = np.where((gx + gy) % 3, 0, 255).astype(np.uint8)
    rgba = np.dstack([rgb, a])
    gray = ((r.astype(np.uint16) + g + b) // 3).astype(np.uint8)
    return rgb, rgba, gray


rgb, rgba, gray = pattern()

# 与 Pillow 生成的 PNG 基准对齐，确保两套工具用同一张图
ref = np.asarray(Image.open(os.path.join(OUT, 'ref.png')).convert('RGB'))
assert (ref == rgb).all(), 'PNG 基准与 tifffile 图形不一致'

gx, gy = np.meshgrid(np.arange(512), np.arange(384))
big = np.dstack([(gx * gy) % 256, (gx + gy) % 256, (gx - gy) % 256]).astype(np.uint8)

cases = [
    ('t_rgb_zip.tif', rgb, {'compression': 'deflate'}),
    ('t_rgb_adobe.tif', rgb, {'compression': 'adobe_deflate'}),
    ('t_rgb_packbits.tif', rgb, {'compression': 'packbits'}),
    ('t_rgb_lzw_p2.tif', rgb, {'compression': 'lzw', 'predictor': 2}),
    ('t_rgb_zip_p2.tif', rgb, {'compression': 'deflate', 'predictor': 2}),
    ('t_rgb_tile.tif', rgb, {'tile': (16, 16)}),
    ('t_rgb_tile16_lzw.tif', rgb, {'tile': (16, 16), 'compression': 'lzw'}),
    ('t_rgb_be.tif', rgb, {'byteorder': '>'}),
    ('t_rgb_be_lzw_p2.tif', rgb, {'byteorder': '>', 'compression': 'lzw', 'predictor': 2}),
    ('t_rgba_zip.tif', rgba, {'compression': 'deflate', 'photometric': 'rgb'}),
    ('t_gray_packbits.tif', gray, {'compression': 'packbits'}),
    ('t_gray_tile.tif', gray, {'tile': (16, 16)}),
    ('t_big_tile_deflate.tif', big, {'tile': (128, 64), 'compression': 'adobe_deflate'}),
    ('t_big_lzw_p2.tif', big, {'compression': 'lzw', 'predictor': 2}),
    ('t_gray_white.tif', gray, {'photometric': 'miniswhite'}),
]

# 分面存储（planarconfig=separate）：本工具明确拒绝，用来验证错误提示而不是解码结果
tifffile.imwrite(
    os.path.join(OUT, 't_rgb_sep.tif'), rgb, planarconfig='separate'
)

for name, arr, kw in cases:
    p = os.path.join(OUT, name)
    tifffile.imwrite(p, arr, planarconfig='contig', **kw)
    im = Image.open(p)
    t = im.tag_v2
    mode = {3: 'RGB', 4: 'RGBA', 1: 'L'}[1 if arr.ndim == 2 else arr.shape[2]]
    back = np.asarray(im.convert(mode))
    expect = arr if arr.ndim == 3 else gray
    # 瓦片会把尺寸补齐到 tile 的整数倍，只比对左上角有效区域
    h, w = expect.shape[:2]
    same = back[:h, :w].tolist() == expect[:h, :w].tolist()
    print(
        name.ljust(26),
        'size=', im.size,
        'comp=', str(t.get(259)).ljust(6),
        'pred=', t.get(319),
        'tile=', bool(t.get(322)),
        'bo=', 'MM' if open(p, 'rb').read(2) == b'MM' else 'II',
        'libtiff 回读一致=', same,
    )
print('OK ->', OUT)
