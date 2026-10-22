# 独立实现 Ward 的 RGBE 解码（不走 JS），与 ffmpeg 的 8 位期望比对
import json
import os

import numpy as np

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fmt", "hdr")


def header_end(data):
    i = data.tobytes().index(b'\n\n') + 2
    j = data[i:].tobytes().index(b'\n')
    return i + j + 1


def decode(data, w, h, start):
    pix = np.zeros((h, w, 4), np.uint8)
    i = start
    for y in range(h):
        adaptive = (w >= 8 and data[i] == 2 and data[i + 1] == 2
                    and (int(data[i + 2]) & 0x80) == 0
                    and ((int(data[i + 2]) << 8) | int(data[i + 3])) == w)
        if adaptive:
            i += 4
            line = np.zeros((w, 4), np.uint8)
            for ch in range(4):
                n = 0
                while n < w:
                    c = int(data[i]); i += 1
                    if c > 128:
                        v = int(data[i]); i += 1
                        k = c - 128
                        line[n:n + k, ch] = v
                        n += k
                    else:
                        line[n:n + c, ch] = data[i:i + c]
                        i += c
                        n += c
            pix[y] = line
        else:
            pix[y] = data[i:i + w * 4].reshape(w, 4)
            i += w * 4
    return pix


man = json.load(open(os.path.join(OUT, 'manifest.json'), encoding='utf-8'))['cases']
for c in man:
    data = np.frombuffer(open(os.path.join(OUT, c['file']), 'rb').read(), np.uint8)
    w, h = c['w'], c['h']
    p = decode(data, w, h, header_end(data))
    v = p[:, :, :3].astype(np.float64)
    e = p[:, :, 3]
    ef = e.astype(np.float64)
    f = v * np.expand_dims(2.0 ** (ef - 136), axis=-1)
    f[ef == 0] = 0
    mine8 = np.clip(np.floor(f * 255 + 0.5), 0, 255).astype(np.uint8)
    ref8 = np.fromfile(os.path.join(OUT, c['expect8']), np.uint8).reshape(h, w, 3)
    d = np.abs(mine8.astype(int) - ref8.astype(int))
    bad = np.argwhere(d > 1)
    first = (int(bad[0, 0]), int(bad[0, 1]), int(bad[0, 2])) if len(bad) else None
    print(f"{c['file']:20s} maxdiff={d.max():4d} >1={len(bad):6d} 我的浮点max={f.max():10.3f} "
          f"ffmpeg8max={ref8.max():3d} 首个超限={first}")
    if first:
        y, x, ch = first
        print(f"   像素({x},{y})通道{ch}: 我={mine8[y,x,ch]} ffmpeg={ref8[y,x,ch]} 浮点={f[y,x,ch]:.8g} "
              f"元组={tuple(int(q) for q in p[y,x])}")
