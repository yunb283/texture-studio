#!/usr/bin/env python3
"""生成 Radiance RGBE (.hdr) 测试素材，期望值取自 ffmpeg 的解码结果。

采用 Ward 的 RGBE_ReadPixels_RLE 语义（与 ffmpeg 一致）：
  - 行首 4 字节为 2,2,xsize_hi,xsize_lo（且 xsize>=8）时，本行走每通道独立 RLE：
    计数 >128 表示「后面 1 个字节重复 count-128 次」，否则表示 count 个字面量
  - 否则整行是 xsize 个非压缩 4 字节像素
旧式（无 FORMAT 行）与 alpha 元组连参考实现都不支持，本工具也直接拒绝，故不出素材。
"""
import json
import math
import os
import subprocess

import numpy as np
from PIL import Image
import imageio_ffmpeg

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fmt", "hdr")
os.makedirs(OUT, exist_ok=True)
FF = imageio_ffmpeg.get_ffmpeg_exe()
HEAD = b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n"


def encode_rgbe(v):
    """线性 float -> (r,g,b,e)，约定 value = mant/256 * 2^(e-128)"""
    m = max(v[0], v[1], v[2])
    if m < 1e-32:
        return (0, 0, 0, 0)
    e = int(math.floor(math.log2(m))) + 129
    scale = 256.0 / 2.0 ** (e - 128)
    return tuple(min(255, int(round(c * scale))) for c in v[:3]) + (e,)


def grid(w, h, fn):
    return [[encode_rgbe(fn(x, y)) for x in range(w)] for y in range(h)]


def channel_rle(vals):
    """单通道：游程（<=127）与字面量段交替"""
    out = bytearray()
    i = 0
    n = len(vals)
    while i < n:
        run = 1
        while i + run < n and vals[i + run] == vals[i] and run < 127:
            run += 1
        if run >= 3:
            out.append(128 + run)
            out.append(vals[i])
            i += run
        else:
            lit = bytearray()
            while i < n and len(lit) < 128:
                r2 = 1
                while i + r2 < n and vals[i + r2] == vals[i] and r2 < 128:
                    r2 += 1
                if r2 >= 3:
                    break
                lit.append(vals[i])
                i += 1
            out.append(len(lit))
            out.extend(lit)
    return bytes(out)


def plain(row):
    return bytes(v for px in row for v in px)


def encode_line(row, w, force_plain=False):
    if w >= 8 and not force_plain:
        head = bytes([2, 2, w >> 8 & 255, w & 255])
        body = b"".join(channel_rle([px[ch] for px in row]) for ch in range(4))
        return head + body
    return plain(row)


def new_style(rows, w, force_plain=False):
    h = len(rows)
    body = b"".join(encode_line(r, w, force_plain) for r in rows)
    return HEAD + b"-Y %d +X %d\n" % (h, w) + body


cases = []


def add(name, data, w, h, note):
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(data)
    cases.append({"file": name, "w": w, "h": h, "note": note})


# 1) 宽行 + 混合游程，含全黑与 >1 高光
w, h = 16, 3
rows = grid(w, h, lambda x, y: ((x + 1) / w, (y + 1) / h * 0.5, 0.25))
rows[0][0] = (0, 0, 0, 0)
rows[1][0] = encode_rgbe((1.0, 1.0, 1.0))
rows[2][0] = encode_rgbe((8.0, 4.0, 16.0))
add("rle_mixed.hdr", new_style(rows, w), w, h, "自适应 RLE，含黑与高光")

# 2) 相邻完全相同的行（每行仍各自带 2,2 头）
w, h = 12, 4
g = grid(w, h, lambda x, y: (0.5, 0.25, 1.0))
add("rle_repeat.hdr", new_style([g[0], g[0], g[1], g[1]], w), w, h, "重复行")

# 3) 整行同值 -> 127 游程上限，需拆成两段
w, h = 300, 2
same = [encode_rgbe((0.75, 0.5, 0.25)) for _ in range(w)]
add("rle_longrun.hdr", new_style([same, same], w), w, h, "长游程拆分 127")

# 4) 宽行但强制整行非压缩（解码端靠行首字节识别）
w, h = 16, 2
g = grid(w, h, lambda x, y: (x / 16 + 0.1, 1.0 - x / 16, 0.5 + y * 0.25))
add("wide_plain.hdr", new_style(g, w, force_plain=True), w, h, "宽行走非压缩")

# 5) 同一文件里 RLE 行与非压缩行混排
w, h = 16, 2
mixed = HEAD + b"-Y %d +X %d\n" % (h, w) + encode_line(g[0], w) + plain(g[1])
add("rle_then_plain.hdr", mixed, w, h, "RLE 行 + 非压缩行混排")

# 6) 小尺寸（<8 必须非压缩）
add("tiny.hdr", new_style(grid(3, 2, lambda x, y: (0.1 * (x + 1), 0.2 * (y + 1), 0.3)), 3), 3, 2, "3x2 非压缩")
add("odd.hdr", new_style(grid(7, 3, lambda x, y: (x / 6, y / 2, 0.5)), 7), 7, 3, "宽 7 非压缩")

# 7) 已知向量：(128,128,128,129)=1.0，(255,255,255,128)=255/256
row = [(128, 128, 128, 129), (255, 255, 255, 128)] + [(0, 0, 0, 0)] * 6
add("known.hdr", new_style([row], 8), 8, 1, "1.0 与 255/256 已知向量")

# 8) 由 ffmpeg 从真实图编码
for src, name in [("ref.png", "from_ref.hdr"), ("ref_rgba.png", "from_rgba.hdr")]:
    p = os.path.join(OUT, name)
    subprocess.run(
        [FF, "-hide_banner", "-loglevel", "error", "-y", "-i", os.path.join(HERE, "fmt", src),
         "-pix_fmt", "rgb24", p],
        check=True,
    )
    size = Image.open(os.path.join(HERE, "fmt", src)).size
    cases.append({"file": name, "w": size[0], "h": size[1], "note": "ffmpeg 编码自 " + src})

# 9) 1024x768 大图，用于计时
p = os.path.join(OUT, "from_1k.hdr")
subprocess.run(
    [FF, "-hide_banner", "-loglevel", "error", "-y", "-i", os.path.join(HERE, "fmt", "ref_big.png"),
     "-vf", "scale=1024:768", "-pix_fmt", "rgb24", p],
    check=True,
)
cases.append({"file": "from_1k.hdr", "w": 1024, "h": 768, "note": "1024x768 计时用"})

# --- ffmpeg 参考解码 ---
print("== ffmpeg 参考解码 ==")
usable = []
for c in cases:
    p = os.path.join(OUT, c["file"])
    raw, png = p + ".f32.raw", p + ".rgb.png"
    r1 = subprocess.run(
        [FF, "-hide_banner", "-loglevel", "error", "-y", "-i", p, "-f", "rawvideo",
         "-pix_fmt", "gbrapf32le", raw], capture_output=True, text=True)
    if r1.returncode != 0:
        why = (r1.stderr or "").strip().splitlines()
        print(f"  SKIP {c['file']:22s} ffmpeg 解不了: {why[-1] if why else ''}")
        continue
    subprocess.run(
        [FF, "-hide_banner", "-loglevel", "error", "-y", "-i", p, "-pix_fmt", "rgb24", png],
        check=True)
    a = np.fromfile(raw, dtype="<f4")
    os.remove(raw)
    if a.size != c["w"] * c["h"] * 4:
        print(f"  SKIP {c['file']:22s} 期望尺寸不符（{a.size} floats）")
        continue
    pl = a.reshape(4, c["h"], c["w"])  # gbrapf32le 是平面格式：G, B, R, A
    np.stack([pl[2], pl[0], pl[1], pl[3]], axis=-1).astype("<f4").tofile(p + ".expect.bin")
    ref8 = np.ascontiguousarray(np.asarray(Image.open(png).convert("RGB")))
    os.remove(png)
    ref8.tofile(p + ".expect8.bin")
    c["expect"] = c["file"] + ".expect.bin"
    c["expect8"] = c["file"] + ".expect8.bin"
    usable.append(c)
    print(f"  ok   {c['file']:22s} {c['w']}x{c['h']}  max={ref8.max()}  {c['note']}")

with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump({"cases": usable}, f, ensure_ascii=False, indent=1)
print(f"\n可用素材 {len(usable)}/{len(cases)} -> {OUT}")
