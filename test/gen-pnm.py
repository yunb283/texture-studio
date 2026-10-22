#!/usr/bin/env python3
"""生成 PNM/PPM/PGM/PBM/PAM 测试素材与逐字节期望值。

期望值的口径（与 JS 解码器约定一致）：
  - 位图（P1/P4/PAM BITMAP）：1 = 黑，0 = 白
  - 灰度 -> R=G=B，不透明
  - 16 位（maxval > 255）大端两字节，量化为 round(v * 255 / maxval)
素材用 Pillow 反向读回做独立交叉校验（P1-P6）。
"""
import json
import os

import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), "fmt", "pnm")
os.makedirs(OUT, exist_ok=True)

W, H = 5, 3
rng = np.random.default_rng(20261021)


def header(lines):
    return "".join(lines).encode("ascii")


def put(name, data, rgba, note=""):
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(data)
    exp = os.path.join(OUT, name + ".bin")
    np.frombuffer(rgba, dtype=np.uint8).tofile(exp)
    return {"file": name, "expect": name + ".bin", "w": W, "h": H, "note": note}


def to_rgba(px):
    """px: (H, W, 3) or (H, W, 4) uint8"""
    h, w = px.shape[:2]
    if px.shape[2] == 3:
        a = np.full((h, w, 4), 255, np.uint8)
        a[:, :, :3] = px
        return a
    return px


def gray_to_rgba(g):
    return to_rgba(np.repeat(g[:, :, None], 3, axis=2))


cases = []
rgb = rng.integers(0, 256, (H, W, 3), dtype=np.uint8)
gray = rng.integers(0, 256, (H, W), dtype=np.uint8)
bits = (rng.integers(0, 2, (H, W)) > 0)

# --- P4 原始位图（每行 (W+7)//8 字节）---
packed = np.packbits(bits, axis=1)
data = header(["P4\n", "# comment line\n", f"{W} {H}\n"]) + packed.tobytes()
exp = gray_to_rgba(np.where(bits, 0, 255).astype(np.uint8))
cases.append(put("p4_bitmap.pbm", data, exp, "P4 1=黑"))

# --- P1 ASCII 位图：值之间可以任意空白，一行一个也行 ---
vals = "\n".join(" ".join("1" if b else "0" for b in row) for row in bits)
data = header(["P1\n", f"{W}\n{H}\n", vals + "\n"])
cases.append(put("p1_bitmap.pbm", data, exp, "P1 ASCII 位图"))

# --- P5 原始灰度 + 注释 + 尾随空白 ---
data = header(["P5\n", "# c1\n# c2\n", f"{W} {H}\n", "255\n"]) + gray.tobytes() + b"\n"
cases.append(put("p5_gray.pgm", data, gray_to_rgba(gray), "P5 灰度 maxval=255"))

# --- P2 ASCII 灰度，跨行换行的样例值 ---
lines = []
for row in gray:
    lines.append(" ".join(str(int(v)) for v in row) + " \\\n")
body = "".join(lines).replace(" \\\n", "\n")
data = header(["P2\n", f"{W} {H}\n", "255\n", body])
cases.append(put("p2_gray.pgm", data, gray_to_rgba(gray), "P2 ASCII 灰度"))

# --- P6 原始 RGB ---
data = header(["P6\n", f"{W} {H}\n", "255\n"]) + rgb.tobytes()
cases.append(put("p6_rgb.ppm", data, to_rgba(rgb), "P6 RGB maxval=255"))

# --- P3 ASCII RGB，注释夹在像素数据中 ---
px = []
for y in range(H):
    for x in range(W):
        px.append(f"{rgb[y, x, 0]} {rgb[y, x, 1]} {rgb[y, x, 2]}")
data = header(["P3\n", f"{W} {H}\n", "255\n", "# mid comment\n", "\n".join(px) + "\n"])
cases.append(put("p3_rgb.ppm", data, to_rgba(rgb), "P3 ASCII RGB"))

# --- P6 16 位（大端，maxval=65535，取 257 的整数倍保证量化精确）---
v16 = (np.arange(W * H * 3).reshape(H, W, 3) * 257 % 65536).astype(np.uint16)
data = header(["P6\n", f"{W} {H}\n", "65535\n"]) + v16.astype(">u2").tobytes()
exp8 = np.round(v16.astype(np.float64) * 255 / 65535 + 1e-9).astype(np.uint8)
cases.append(put("p6_rgb_16.ppm", data, to_rgba(exp8), "P6 16 位 maxval=65535"))

# --- P5 16 位灰度，maxval=1000（量化用 round-half-up）---
g16 = (gray.astype(np.uint16) * 4).astype(np.uint16)
data = header(["P5\n", f"{W} {H}\n", "1000\n"]) + g16.astype(">u2").tobytes()
exp8 = np.floor(g16.astype(np.float64) * 255 / 1000 + 0.5).astype(np.uint8)
cases.append(put("p5_gray_16.pgm", data, gray_to_rgba(exp8), "P5 16 位 maxval=1000"))

# --- P7 PAM RGB ---
data = header(
    [
        "P7\n",
        "# pam\n",
        f"WIDTH {W}\n",
        f"HEIGHT {H}\n",
        "DEPTH 3\n",
        "MAXVAL 255\n",
        "TUPLTYPE RGB\n",
        "ENDHDR\n",
    ]
) + rgb.tobytes()
cases.append(put("p7_rgb.pam", data, to_rgba(rgb), "P7 RGB"))

# --- P7 PAM RGB_ALPHA（非预乘）---
alpha = rng.integers(0, 256, (H, W), dtype=np.uint8)
rgba = np.dstack([rgb, alpha])
data = header(
    [
        "P7\n",
        f"WIDTH {W}\nHEIGHT {H}\nDEPTH 4\nMAXVAL 255\n",
        "TUPLTYPE RGB_ALPHA\nENDHDR\n",
    ]
) + rgba.tobytes()
cases.append(put("p7_rgba.pam", data, rgba, "P7 RGB_ALPHA"))

# --- P7 GRAYSCALE_ALPHA ---
ga = rng.integers(0, 256, (H, W), dtype=np.uint8)
tup = np.dstack([gray, gray, gray, ga])
data = header(
    [
        "P7\n",
        f"WIDTH {W}\nHEIGHT {H}\nDEPTH 2\nMAXVAL 255\n",
        "TUPLTYPE GRAYSCALE_ALPHA\nENDHDR\n",
    ]
) + np.dstack([gray, ga]).tobytes()
cases.append(put("p7_gray_a.pam", data, tup, "P7 GRAYSCALE_ALPHA"))

# --- P7 BITMAP（无 MAXVAL，DEPTH 1）---
data = header(
    ["P7\n", f"WIDTH {W}\nHEIGHT {H}\nDEPTH 1\nTUPLTYPE BITMAP\nENDHDR\n"]
) + bits.astype(np.uint8).tobytes()
exp_bits = np.where(bits, 0, 255).astype(np.uint8)
cases.append(put("p7_bitmap.pam", data, gray_to_rgba(exp_bits), "P7 BITMAP 1=黑"))

# --- P7 16 位 RGB_ALPHA ---
a16 = (alpha.astype(np.uint16) * 257).astype(np.uint16)
c16 = (rgb.astype(np.uint16) * 257).astype(np.uint16)
tup16 = np.dstack([c16, a16])
data = header(
    [
        "P7\n",
        f"WIDTH {W}\nHEIGHT {H}\nDEPTH 4\nMAXVAL 65535\n",
        "TUPLTYPE RGB_ALPHA\nENDHDR\n",
    ]
) + tup16.astype(">u2").tobytes()
exp16 = np.floor(tup16.astype(np.float64) * 255 / 65535 + 1e-9).astype(np.uint8)
cases.append(put("p7_rgba_16.pam", data, exp16, "P7 16 位 RGB_ALPHA"))

# --- P7 带 IMAGETYPE（应忽略该行）---
data = header(
    [
        "P7\n",
        f"WIDTH {W}\nHEIGHT {H}\nDEPTH 3\nMAXVAL 255\n",
        "IMAGETYPE BLACKANDWHITE\nTUPLTYPE RGB\nENDHDR\n",
    ]
) + rgb.tobytes()
cases.append(put("p7_imagetype.pam", data, to_rgba(rgb), "P7 含 IMAGETYPE"))

manifest = {"cases": cases}
with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=1)

# --- Pillow 独立交叉校验：P1-P6 能被 Pillow 读回且像素一致 ---
print("== Pillow cross-check ==")
for name, ref in [
    ("p4_bitmap.pbm", np.where(bits, 0, 255)),
    ("p1_bitmap.pbm", np.where(bits, 0, 255)),
    ("p5_gray.pgm", gray),
    ("p2_gray.pgm", gray),
    ("p6_rgb.ppm", rgb),
    ("p3_rgb.ppm", rgb),
]:
    im = Image.open(os.path.join(OUT, name))
    a = np.array(im.convert("RGB"))
    if a.ndim == 2:
        a = a[:, :, 0]
    src = ref if ref.ndim == 2 else ref
    ok = np.array_equal(a[:, :, 0] if a.ndim == 3 else a, src if src.ndim == 2 else src[:, :, 0])
    print(f"{name:16s} Pillow={im.mode} {im.size} match={ok}")

print("cases:", len(cases), "->", OUT)
