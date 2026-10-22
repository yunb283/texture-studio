#!/usr/bin/env python3
"""用 numpy 独立实现「周期偏移 + 渐变交叉溶解」，产出逐字节期望值给 test/seamless-test.mjs。

与 src/js/seamless.js 是两份各写各的代码（那边逐像素两层循环，这边 np.roll + 广播），
约定以 seamless.js 顶部注释为准：band=floor(len·pct+0.5)、smoothstep 权重、
横向一趟纵向一趟、每趟量化回 8 位、默认在预乘空间混合。
同时把一份输入存成 png/bmp/jpg/webp/tga/dds，供浏览器端走完整管线再比对。
"""
import json
import os

import numpy as np

import imgfmt

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fmt", "seamless")
os.makedirs(OUT, exist_ok=True)


def q8(v):
    """JS 的 Uint8ClampedArray 赋值口径：floor(v+0.5) 再钳到 0..255"""
    return np.clip(np.floor(np.asarray(v, dtype=np.float64) + 0.5), 0, 255).astype(np.uint8)


def weights(n, band):
    u = np.zeros(n, dtype=np.float64)
    d = np.arange(n)
    edge = np.minimum(d, n - 1 - d)
    inside = edge < band
    p = 1.0 - edge[inside] / band
    u[inside] = p * p * (3.0 - 2.0 * p)
    return u


class SeamTooWide(ValueError):
    """融合带宽超过图幅一半——与 JS 侧的同名校验一一对应，只有它算「预期拒绝」"""


def box1d(a, r, axis):
    """周期（wrap）框式一维低通，窗口 2r+1，对任意 r 都成立（np.pad 的 wrap 不允许超过轴长，
    这里把窗口拆成「整圈 q 次 + 余下 rem 个」用前缀和算，与 JS 的滑动窗口是两种写法）"""
    a = np.asarray(a, dtype=np.float64)
    n = a.shape[axis]
    if r <= 0:
        return a.copy()
    size = 2 * r + 1
    q, rem = divmod(size, n)
    base = np.take(a, (np.arange(0, n + rem) - r) % n, axis=axis)
    c = np.cumsum(base, axis=axis, dtype=np.float64)
    zshape = list(base.shape)
    zshape[axis] = 1
    zc = np.concatenate([np.zeros(zshape), c], axis=axis)
    out = np.take(zc, np.arange(rem, rem + n), axis=axis) - np.take(zc, np.arange(0, n), axis=axis)
    if q:
        out = out + q * np.sum(a, axis=axis, dtype=np.float64, keepdims=True)
    return out / float(size)


def blend_axis(arr, band, horizontal, levels=0):
    """沿一个轴做 (1-u)·自身 + u·半图平移；levels>=1 时低频用展宽权重、高频仍用窄权重"""
    n = arr.shape[1] if horizontal else arr.shape[0]
    half = n >> 1
    u = weights(n, band)
    axis = 1 if horizontal else 0
    rolled = np.roll(arr, half, axis=axis)
    shape = (1, n, 1) if horizontal else (n, 1, 1)
    uw = u.reshape(shape)
    if levels <= 0:
        return q8((1.0 - uw) * arr + uw * rolled)
    r = min(n >> 2, band * (1 << (levels - 1)))
    wide = box1d(u, r, 0).reshape(shape)
    lo_a = box1d(arr.astype(np.float64), r, axis)
    lo_b = box1d(rolled.astype(np.float64), r, axis)
    out = ((1.0 - wide) * lo_a + wide * lo_b) + ((1.0 - uw) * (arr - lo_a) + uw * (rolled - lo_b))
    return q8(out)


def to_seamless(rgba, pct=0.15, keep_alpha=True, levels=0):
    a = np.asarray(rgba, dtype=np.uint8)
    h, w = a.shape[:2]
    pct = min(0.5, max(0.0, float(pct)))
    levels = int(levels)
    band_w = int(np.floor(w * pct + 0.5))
    band_h = int(np.floor(h * pct + 0.5))
    if band_w * 2 > w or band_h * 2 > h:
        raise SeamTooWide(f"融合宽度太大：横向 {band_w}x2>{w} 或纵向 {band_h}x2>{h}")
    if band_w == 0 and band_h == 0:
        return a.copy()  # 0 档 = 完全不处理，必须逐字节等于输入
    if keep_alpha:
        al = a[..., 3].astype(np.float64)
        pre = np.empty_like(a, dtype=np.float64)
        pre[..., 3] = al
        for k in range(3):
            pre[..., k] = a[..., k] * (al / 255.0)
        buf = q8(pre)
    else:
        buf = a
    buf = blend_axis(buf, band_w, True, levels)
    buf = blend_axis(buf, band_h, False, levels)
    if keep_alpha:
        al = buf[..., 3].astype(np.float64)
        out = np.zeros_like(buf, dtype=np.float64)
        ok = al > 0
        for k in range(3):
            out[..., k] = np.where(ok, buf[..., k] * 255.0 / np.where(ok, al, 1), 0.0)
        out[..., 3] = al
        return q8(out)
    return buf


def metrics(rgba):
    a = np.asarray(rgba, dtype=np.float64)
    rgb = a[..., :3]
    lr = np.sqrt(((rgb[:, 0] - rgb[:, -1]) ** 2).sum(axis=1)).mean()
    tb = np.sqrt(((rgb[0] - rgb[-1]) ** 2).sum(axis=1)).mean()
    gx = np.sqrt(((rgb[:, 1:] - rgb[:, :-1]) ** 2).sum(axis=2))
    gy = np.sqrt(((rgb[1:] - rgb[:-1]) ** 2).sum(axis=2))
    grad = float(np.concatenate([gx.ravel(), gy.ravel()]).mean())
    edge = (float(lr) + float(tb)) / 2.0
    return {"lr": float(lr), "tb": float(tb), "edge": edge, "grad": grad,
            "ratio": edge / grad if grad > 0 else float("inf")}


cases = []


def add(name, note, rgba, blends=None, levels=None):
    p = os.path.join(OUT, name + ".in.bin")
    np.ascontiguousarray(rgba, dtype=np.uint8).tofile(p)
    cases.append({"file": name, "w": int(rgba.shape[1]), "h": int(rgba.shape[0]),
                  "note": note, "input": name + ".in.bin", "runs": [],
                  "blends": list(blends) if blends else None,
                  "levels": list(levels) if levels else None,
                  "metrics": metrics(rgba)})


def run(name, **kw):
    c = [x for x in cases if x["file"] == name][0]
    rgba = np.fromfile(os.path.join(OUT, c["input"]), dtype=np.uint8).reshape(c["h"], c["w"], 4)
    try:
        exp = to_seamless(rgba, **kw)
    except SeamTooWide as e:
        c.setdefault("rejects", []).append({"args": kw, "why": str(e)})
        return
    f = f"{name}.run{len(c['runs']):02d}.bin"
    exp.tofile(os.path.join(OUT, f))
    c["runs"].append({"args": kw, "expect": f, "metrics": metrics(exp)})


# ---- 输入素材 ----
def ramp(w, h):
    x = np.arange(w)
    v = np.floor(255 * x / (w - 1) + 0.5).astype(np.uint8)
    a = np.zeros((h, w, 4), np.uint8)
    a[..., 0] = v[None, :]
    a[..., 1] = v[None, :]
    a[..., 2] = v[None, :]
    a[..., 3] = 255
    return a


def periodic_crop(w, h, seed):
    """从一个大周期的连续场里裁一块：中心连续、四边有真接缝（最贴近真实贴图）"""
    rs = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:2 * h, 0:2 * w]
    field = []
    for ch in range(3):
        img = np.zeros((2 * h, 2 * w))
        for _ in range(7):
            fx = rs.integers(1, 5) / (2 * w) * 2 * np.pi
            fy = rs.integers(1, 5) / (2 * h) * 2 * np.pi
            img += rs.uniform(0.5, 1.5) * np.cos(fx * xx + fy * yy + rs.uniform(0, 6.28))
        field.append(img)
    f = np.stack(field, axis=-1)
    f = (f - f.min()) / (f.max() - f.min()) * 200 + 28
    y0, x0 = h // 3, w // 3
    crop = f[y0:y0 + h, x0:x0 + w]
    a = np.zeros((h, w, 4), np.uint8)
    a[..., :3] = np.clip(crop, 0, 255).astype(np.uint8)
    a[..., 3] = 255
    return a


def brick(w, h, bw=13, bh=9):
    """砖墙：强结构 + 明显接缝，用来暴露融合的上限"""
    a = np.full((h, w, 4), 170, np.uint8)
    a[..., 3] = 255
    for y in range(0, h, bh):
        a[y:y + 2, :] = 60
        off = (bw // 2) if ((y // bh) % 2) else 0
        for x in range(-off, w, bw):
            a[:, max(0, x):min(w, x + 2)] = 60
    return a


with_alpha = np.zeros((32, 48, 4), np.uint8)
yy, xx = np.mgrid[0:32, 0:48]
blob = ((xx - 24) ** 2 + (yy - 16) ** 2) < 12 ** 2
with_alpha[..., 0] = 210
with_alpha[..., 1] = 90
with_alpha[..., 2] = 40
alpha = np.clip(255 - 20 * np.sqrt(((xx - 24) ** 2 + (yy - 16) ** 2)), 0, 255).astype(np.uint8)
with_alpha[..., 3] = alpha
with_alpha[..., :3] = np.where(alpha[..., None] > 0, with_alpha[..., :3], 0)

rng = np.random.default_rng(7)
noise_odd = np.concatenate([rng.integers(0, 256, (29, 41, 3), dtype=np.uint8),
                            np.full((29, 41, 1), 255, np.uint8)], axis=-1)

add("s_ramp", "横向斜坡：只有环绕边突变，解析可验证", ramp(64, 48))
add("s_crop", "周期场裁块：真实贴图形状（中心连续、四边有缝）", periodic_crop(64, 48, 20261022))
add("s_brick", "砖墙：强结构，融合宽度越大越糊", brick(64, 48))
add("s_alpha", "软边圆形：透明像素与预乘混合", with_alpha)
add("s_odd", "奇数尺寸 41x29 随机噪声：half=len>>1 的取整，0.5 档必须被拒绝", noise_odd,
    [0, 0.15, 0.49, 0.5])
# 大图只跑几档，给浏览器端做耗时与导出比对用
add("s_big", "1024x768 周期场裁块：性能与导出用例", periodic_crop(1024, 768, 4242),
    [0, 0.15], [0, 1, 2, 3])

# ---- 参数组合 ----
DEFAULT_BLENDS = [0, 0.05, 0.15, 0.3]
DEFAULT_LEVELS = [0, 1, 2, 3, 4]
for c in cases:
    blends = c.pop("blends") or DEFAULT_BLENDS
    levels = c.pop("levels") or DEFAULT_LEVELS
    for pct in blends:
        for lv in levels:
            run(c["file"], pct=pct, keep_alpha=True, levels=lv)
            run(c["file"], pct=pct, keep_alpha=False, levels=lv)

# ---- 给浏览器端用的真实图片文件 ----
os.makedirs(os.path.join(OUT, "img"), exist_ok=True)


def find_run(cc, **kw):
    return next(r["expect"] for r in cc["runs"] if all(r["args"].get(k) == v for k, v in kw.items()))


for name in ["s_crop", "s_big"]:
    cc = [c for c in cases if c["file"] == name][0]
    rgba = np.fromfile(os.path.join(OUT, cc["input"]), dtype=np.uint8).reshape(cc["h"], cc["w"], 4)
    made = imgfmt.write_variants(rgba, os.path.join(OUT, "img", name))
    cc["images"] = {k: "img/" + v for k, v in made.items()}
    # UI 默认是 15% + 2 个融合尺度，把这三条期望都记下来给浏览器端比对
    cc["default_run"] = find_run(cc, pct=0.15, keep_alpha=True, levels=2)
    cc["run_single_scale"] = find_run(cc, pct=0.15, keep_alpha=True, levels=0)
    cc["run_zero"] = find_run(cc, pct=0, keep_alpha=True, levels=3)
names = made

with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump({"cases": cases}, f, ensure_ascii=False, indent=1)
n = sum(len(c["runs"]) for c in cases)
rej = sum(len(c.get("rejects", [])) for c in cases)
print(f"素材 {len(cases)} 个，参数组合 {n} 组，越界拒绝 {rej} 条，图片格式 {len(names)} 种 -> {OUT}")
