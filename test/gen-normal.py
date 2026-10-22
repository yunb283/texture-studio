#!/usr/bin/env python3
"""用 numpy 独立实现一遍法线生成约定，产出逐字节期望值给 test/normal-test.mjs 比对。

与 src/js/normal.js 是两份各写各的代码（那里用滑动窗口 + 逐像素索引，这里用 pad + 切片加权求和），
输入则是同一份 RGBA8 原始字节，所以比对能抓到实现错误；约定的符号/取整口径以 normal.js 顶部注释为准。

约定摘要：
  高度 = lum(0.299R+0.587G+0.114B) / avg(R+G+B)/3 / 单通道 r,g,b,a，除以 255；反转取 1-h
  模糊 = 可分离框形，窗口 2r+1，边缘 edge 延拓
  梯度 = 3x3 Sobel（edge 延拓），gx 向右为正，gy 沿行向下为正
  法向 = normalize(-S*gx, ±S*gy, 1)，OpenGL(Unity) 取 +gy，DirectX(UE) 取 -gy
  编码 = floor((v/2 + 1/2)*255 + 0.5)，alpha 恒 255
"""
import json
import os
import struct

import numpy as np
from PIL import Image

import imgfmt

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fmt", "normal")
os.makedirs(OUT, exist_ok=True)

HEIGHTS = {
    "lum": lambda a: 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2],
    "avg": lambda a: (a[..., 0] + a[..., 1] + a[..., 2]) / 3.0,
    "r": lambda a: a[..., 0],
    "g": lambda a: a[..., 1],
    "b": lambda a: a[..., 2],
    "a": lambda a: a[..., 3],
}


def box_blur(a, r):
    if r <= 0:
        return a
    h, w = a.shape
    p = np.pad(a, ((0, 0), (r, r)), mode="edge")
    acc = np.zeros_like(a)
    size = 2 * r + 1
    for d in range(size):  # 横向：窗口里每一列
        acc += p[:, d : d + w]
    acc /= size
    p2 = np.pad(acc, ((r, r), (0, 0)), mode="edge")
    out = np.zeros_like(a)
    for d in range(size):
        out += p2[d : d + h, :]
    return out / size


def sobel(h):
    p = np.pad(h, 1, mode="edge")
    gx = (
        p[:-2, 2:]
        + 2 * p[1:-1, 2:]
        + p[2:, 2:]
        - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2])
    )
    gy = (
        p[2:, :-2]
        + 2 * p[2:, 1:-1]
        + p[2:, 2:]
        - (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:])
    )
    return gx, gy


def to_normal(rgba, source="lum", invert=False, blur=0, strength=1.0, y_up=True):
    a = rgba.astype(np.float64) / 255.0
    hgt = HEIGHTS[source](a)
    if invert:
        hgt = 1.0 - hgt
    hgt = box_blur(hgt, blur)
    gx, gy = sobel(hgt)
    nx = -strength * gx
    ny = (strength * gy) if y_up else (-strength * gy)
    nz = np.ones_like(nx)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    v = np.stack([nx / ln, ny / ln, nz / ln], axis=-1)
    out = np.floor((v * 0.5 + 0.5) * 255.0 + 0.5).astype(np.uint8)
    rgba_out = np.concatenate([out, np.full(out.shape[:2] + (1,), 255, np.uint8)], axis=-1)
    return np.ascontiguousarray(rgba_out)


cases = []


def add_input(name, note, rgba):
    h, w = rgba.shape[:2]
    p = os.path.join(OUT, name + ".in.bin")
    np.ascontiguousarray(rgba).tofile(p)
    cases.append({"file": name, "w": w, "h": h, "note": note, "input": name + ".in.bin", "runs": []})
    return rgba


def run(name, **kw):
    c = [x for x in cases if x["file"] == name][0]
    rgba = np.fromfile(os.path.join(OUT, c["input"]), dtype=np.uint8).reshape(c["h"], c["w"], 4)
    exp = to_normal(rgba, **kw)
    f = f"{name}.run{len(c['runs']):02d}.bin"
    exp.tofile(os.path.join(OUT, f))
    c["runs"].append({"args": kw, "expect": f})


# ---- 输入素材 ----
flat = np.zeros((16, 16, 4), np.uint8)
flat[..., :3] = 128
flat[..., 3] = 255
add_input("n_flat", "纯平灰 128：期望处处 (128,128,255)", flat)

w0 = 41
hramp = np.zeros((9, w0, 4), np.uint8)
for x in range(w0):
    hramp[:, x, :3] = round(255 * x / (w0 - 1))
hramp[..., 3] = 255
add_input("n_hramp", "水平线性斜坡：R 通道可解析验证", hramp)

vramp = np.zeros((w0, 9, 4), np.uint8)
for y in range(w0):
    vramp[y, :, :3] = round(255 * y / (w0 - 1))
vramp[..., 3] = 255
add_input("n_vramp", "垂直线性斜坡：G 通道区分 DX / OG", vramp)

H, W = 33, 33
yy, xx = np.mgrid[0:H, 0:W]
r2 = (xx - 16) ** 2 + (yy - 16) ** 2
bump = np.zeros((H, W, 4), np.uint8)
inside = r2 < 12 * 12
v = np.sqrt(np.clip(1 - r2[inside] / (12 * 12), 0, None))
bump[..., :3][inside] = np.round(255 * v).astype(np.uint8)[:, None].repeat(3, 1)
bump[..., 3] = 255
add_input("n_bump", "半球凸起：检查绿通道朝上/朝下", bump)

rng = np.random.default_rng(20261021)
noise = rng.integers(0, 256, (23, 37, 3), dtype=np.uint8)
noise = np.concatenate([noise, np.full((23, 37, 1), 255, np.uint8)], axis=-1)
add_input("n_noise", "随机噪声：验证模糊单调压梯度", noise)

col = np.zeros((12, 12, 4), np.uint8)
col[..., 0] = np.arange(12)[None, :] * 20  # R 随 x 变
col[..., 1] = np.arange(12)[:, None] * 20  # G 随 y 变
col[..., 2] = 77  # B 恒定
col[..., 3] = np.clip(np.arange(12)[None, :] * 23, 0, 255).astype(np.uint8)  # A 随 x 变
add_input("n_color", "四通道各不相同：验证 6 种高度来源互不串色", col)

# ---- 参数组合 ----
for nm in ["n_flat", "n_hramp", "n_vramp", "n_bump", "n_noise", "n_color"]:
    run(nm)
    run(nm, y_up=False)
    run(nm, invert=True)
    run(nm, blur=2)
    run(nm, strength=4.0)
    run(nm, strength=0.25, blur=1)

for src in ["avg", "r", "g", "b", "a"]:
    run("n_color", source=src)
run("n_noise", source="a", blur=3, strength=2.0, y_up=False)

# ---- 把 n_bump 再存成 6 种真实图片文件，给浏览器端跑完整管线用 ----
IMG = os.path.join(OUT, "img")
os.makedirs(IMG, exist_ok=True)

bump = np.fromfile(os.path.join(OUT, "n_bump.in.bin"), dtype=np.uint8).reshape(33, 33, 4)
images = {k: "img/" + v for k, v in imgfmt.write_variants(bump, os.path.join(IMG, "n_bump")).items()}

for c in cases:
    if c["file"] == "n_bump":
        c["images"] = images
        c["default_run"] = c["runs"][0]["expect"]  # {} 参数：lum / 不反转 / 不模糊 / 强度 1 / OpenGL

with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump({"cases": cases}, f, ensure_ascii=False, indent=1)
n = sum(len(c["runs"]) for c in cases)
print(f"素材 {len(cases)} 个，参数组合 {n} 组，图片格式 {len(images)} 种 -> {OUT}")
