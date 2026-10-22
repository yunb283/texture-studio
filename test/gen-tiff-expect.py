# 为 fmt/ 下每个 TIFF 生成期望 RGBA 原始字节（x/<name>.bin）与 manifest.json
# 像素数据取自 libtiff（经 tifffile/imagecodecs）解码结果，色彩解释规则与常见看图软件一致：
#   photo 0 反相、1 灰度复制到 RGB、2 直接 RGB、3 查 ColorMap（16 位色板 >>8）
#   16 位样本取高 8 位；4 样本第 4 个作为 alpha
import glob
import json
import os

import numpy as np
import tifffile

OUT = os.path.join(os.path.dirname(__file__), 'fmt')
EXP = os.path.join(OUT, 'x')
os.makedirs(EXP, exist_ok=True)

# 解码器约定拒绝的变体，不生成期望值
REJECT = {'t_rgb_sep.tif'}


def to_rgba(a, photo, colormap):
    # tifffile.asarray 给的是文件里的原始样本，miniswhite 需按 libtiff/PIL 的显示语义反相
    if photo == 3 and a.ndim == 3:
        # tifffile 已经把色板展开成 uint8 RGB
        a = a[..., :3]
    elif a.dtype == np.uint16:
        a = a >> 8
        a = a.astype(np.uint8)
    if photo == 3 and a.ndim == 2:
        idx = a.reshape(-1).astype(np.int32)
        rgb = colormap[idx].reshape(a.shape + (3,))
    elif a.ndim == 3:
        rgb = a[..., :3]
    else:
        rgb = np.repeat(a[..., None], 3, axis=2)
    if photo == 0:
        rgb = (255 - rgb.astype(np.int16)).astype(np.uint8)
    return rgb.astype(np.uint8)


manifest = []
for path in sorted(glob.glob(os.path.join(OUT, 't_*.tif'))):
    name = os.path.basename(path)
    if name in REJECT:
        continue
    with tifffile.TiffFile(path) as tf:
        page = tf.pages[0]
        tags = {k: v.value for k, v in page.tags.items()}
        a = page.asarray()
        photo = tags[262]
        spp = tags.get(277, 3 if a.ndim == 3 else 1)
        alpha = a[..., 3] if spp == 4 else None
        colormap = None
        if photo == 3:
            cm = (np.asarray(tags[320], dtype=np.uint16) >> 8).astype(np.uint8)
            if cm.ndim == 2:
                colormap = cm.T.copy()
            else:
                n = len(cm) // 3
                colormap = np.stack([cm[:n], cm[n : 2 * n], cm[2 * n :]], axis=1)
        rgb = to_rgba(a, photo, colormap)
        w, h = tags[256], tags[257]
        rgb = rgb[:h, :w]
        rgba = np.dstack(
            [rgb, alpha[:h, :w] if alpha is not None else np.full((h, w), 255, np.uint8)]
        )
    bin_path = os.path.join('x', f'{name}.bin')
    rgba.tofile(os.path.join(EXP, f'{name}.bin'))
    manifest.append(
        {
            'file': name,
            'expect': bin_path,
            'w': w,
            'h': h,
            'photo': photo,
            'spp': spp,
            'bps': tags.get(258),
            'comp': tags.get(259),
            'pred': tags.get(317, 1),
            'tile': 322 in tags,
            'be': open(path, 'rb').read(2) == b'MM',
        }
    )
    print(
        name.ljust(24),
        f'{w}x{h}',
        'photo=', photo,
        'spp=', spp,
        'comp=', tags.get(259),
        'pred=', tags.get(317, 1),
        'tile=', 322 in tags,
    )

with open(os.path.join(EXP, 'manifest.json'), 'w', encoding='utf-8') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=1)
print('cases=', len(manifest), '->', EXP)
