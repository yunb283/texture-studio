#!/usr/bin/env python3
"""用 PIL 独立解码 node/gif-test.mjs 写出的 GIF，做闭环核对。

方向与其它格式相反：这次是我们自己【写】、Pillow【读】，所以能验到编码器输出的
每一个结构字段。核对项：帧数、尺寸、每帧时长、循环次数、每帧透明像素数、
以及不透明像素的 RGB 误差（量化质量）。

跑法：cd test && node gif-test.mjs && python gif-verify.py
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageSequence

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fmt", "gif")
# 量化误差阈值（256 色中位切分 + 5bit 最近色桶）：均值上限、极差上限
MEAN_LIMIT = 12.0
MAX_LIMIT = 96.0

fail = 0


def check(cond, msg):
    global fail
    if not cond:
        print("FAIL", msg)
        fail += 1


manifest = json.load(open(os.path.join(OUT, "cases.json"), encoding="utf-8"))
for c in manifest["cases"]:
    path = os.path.join(OUT, c["name"] + ".gif")
    src = [
        np.fromfile(os.path.join(OUT, f"{c['name']}.f{i}.bin"), dtype=np.uint8).reshape(c["h"], c["w"], 4)
        for i in range(c["frames"])
    ]
    im = Image.open(path)
    check(im.size == (c["w"], c["h"]), f"{c['name']} 尺寸 {im.size} != {(c['w'], c['h'])}")
    check(im.n_frames == c["frames"], f"{c['name']} 帧数 {im.n_frames} != {c['frames']}")
    loop = im.info.get("loop")
    check(loop == c["loop"], f"{c['name']} 循环 {loop} != {c['loop']}")

    errs = []
    idx = 0
    for f in ImageSequence.Iterator(im):
        a = np.asarray(f.convert("RGBA"), dtype=np.int16)
        s = src[idx].astype(np.int16)
        check(int(f.info.get("duration", -1)) == c["delay"] * 10,
              f"{c['name']} 帧{idx} 时长 {f.info.get('duration')} != {c['delay'] * 10}ms")
        trans = int((a[..., 3] == 0).sum())
        check(trans == c["transparent"][idx], f"{c['name']} 帧{idx} 透明像素 {trans} != {c['transparent'][idx]}")
        keep = (s[..., 3] >= 128) & (a[..., 3] == 255)
        d = np.abs(a[..., :3] - s[..., :3])[keep]
        errs.append(d)
        idx += 1
    allerr = np.concatenate([e.reshape(-1) for e in errs]) if errs else np.array([0])
    mean = float(allerr.mean())
    mx = int(allerr.max())
    p99 = float(np.percentile(allerr, 99))
    check(mean <= MEAN_LIMIT, f"{c['name']} 平均量化误差 {mean:.2f} > {MEAN_LIMIT}")
    check(mx <= MAX_LIMIT, f"{c['name']} 最大量化误差 {mx} > {MAX_LIMIT}")
    print(f" ok   {c['name']:10s} {c['w']}x{c['h']} {c['frames']}帧 {c['delay'] * 10}ms "
          f"loop={c['loop']} {c['quality']:6s} 误差 均值 {mean:5.2f} p99 {p99:5.1f} 最大 {mx:3d}  "
          f"{os.path.getsize(path) / 1024:.2f}KB")

if fail:
    print(f"\n{fail} 个检查失败")
    sys.exit(1)
print(f"\nPIL 解码闭环全部通过（{len(manifest['cases'])} 个 GIF）")
