# -*- coding: utf-8 -*-
"""
用 PIL 当第三方裁判：本脚本写出各种结构的 GIF，再用 PIL 自己解一遍，
把每帧合成后的 RGBA 和延时落盘，交给 test/gif-decode-test.mjs 第 5 节逐像素比对。

分工：PIL 只管「写规范的文件」和「按它自己的理解解一遍」，本脚本不预测任何像素。
跑法：
    python test/gif-decode-verify.py     # 生成 fmt/gifdec/*.gif + <case>_<i>.rgba + manifest.json
    node test/gif-decode-test.mjs        # 我的解码器和 manifest 对账
node 那边还会先写 fmt/gifdec/interlaced.gif（隔行帧），本脚本把它也解一遍当额外用例。

有意避开的写法（PIL 读侧的怪癖，不是我的解码器的锅，写进用例只会互相绊倒）：
  1. 帧与帧之间混用「显式 disposal」和「不写 disposal」：PIL 的 disposal_method 是粘的，
     只在解到非 0 值时覆盖，于是后面 disposal=0 的帧会被按上一帧的方式处理；
     浏览器和规范把 0 当「本帧未指明=留着」。所以每个用例要么全不写，要么每帧都写明确的 1/2/3。
  2. 同一文件里前面帧有透明索引、后面帧没有，又用 disposal=2：PIL 用「本帧自己的
     transparency」决定擦成透明还是背景色，我用的是「全片有没有用过透明索引」。
     两边各有道理，用例里让整片的透明度保持一致。
"""
import json
import os
import struct

import numpy as np
from PIL import Image, ImageSequence

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fmt", "gifdec")
os.makedirs(OUT, exist_ok=True)

W, H = 12, 9

# 256 条互不重复的颜色：PIL 的 optimize 会按「用到的索引」压缩调色板，
# 编号漂移不影响比对（期望值是从写好的文件里读回来的），但重名颜色会让它多绕一步
PAL = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0),
       (255, 0, 255), (0, 255, 255), (255, 255, 255), (30, 30, 30)]
PAL = PAL + [(i, (i * 3 + 1) & 0xFF, (i * 5 + 2) & 0xFF) for i in range(8, 256)]
FLAT = [c for rgb in PAL for c in rgb]


def base(value):
    """整幅一个索引"""
    return np.full((H, W), value, np.uint8)


def patch(rows, ops):
    """在整幅 rows 上按 (y, x, h, w, 索引) 打几个补丁"""
    a = base(rows)
    for y, x, h, w, v in ops:
        a[y:y + h, x:x + w] = v
    return a


def pimg(idx):
    im = Image.frombytes("P", (W, H), np.ascontiguousarray(idx).tobytes())
    im.putpalette(FLAT)
    return im


def diagonal():
    a = np.zeros((H, W), np.uint8)
    for y in range(H):
        for x in range(W):
            a[y, x] = (x + y) % 8
    return a


CASES = [
    # 名字, 帧索引数组(列表), save 参数, 这个用例在测什么
    ("plain",
     [base(0), base(1), base(2), base(3)],
     dict(duration=[100, 100, 100, 100]),
     "整幅帧轮流覆盖，最普通的一路"),
    ("uneven",
     [base(5), patch(5, [(2, 2, 4, 5, 1)]), patch(5, [(0, 0, 9, 12, 6)])],
     dict(duration=[40, 200, 90], disposal=[1, 1, 1]),
     "不等长延时 + disposal=1 留着画面"),
    ("transp",
     [base(0), patch(0, [(1, 1, 5, 6, 1)]), patch(1, [(3, 3, 3, 3, 7)])],
     dict(duration=[80] * 3, disposal=[1, 1, 1], transparency=7, optimize=False),
     "透明索引：索引 7 的像素透出上一帧"),
    ("d2_transp",
     [base(0), patch(0, [(2, 2, 3, 4, 1)]), patch(0, [(6, 6, 2, 2, 3)])],
     dict(duration=[60] * 3, disposal=[1, 2, 1], transparency=7, optimize=False),
     "disposal=2 且全片用了透明索引：补丁画完擦成 alpha=0"),
    ("d2_bg",
     [base(0), patch(0, [(2, 2, 3, 4, 1)]), patch(0, [(6, 6, 2, 2, 3)])],
     dict(duration=[60] * 3, disposal=[1, 2, 1], background=2, optimize=False),
     "disposal=2 且全片没有透明：补丁位置恢复成 LSD 背景色索引 2"),
    ("d3_patch",
     [base(4), patch(4, [(1, 1, 3, 3, 1)]), patch(4, [(5, 4, 2, 5, 2)]),
      patch(2, [(0, 0, H, W, 6)])],
     dict(duration=[50] * 4, disposal=[1, 3, 3, 1], optimize=False),
     "disposal=3 只退回自己那块，补丁偏移走 x/y 定位"),
    ("opt_delta",
     [diagonal(), patch(diagonal(), [(3, 3, 2, 2, 0)]),
      patch(diagonal(), [(7, 9, 1, 2, 5)])],
     dict(duration=[70] * 3, disposal=[1, 1, 1], optimize=True),
     "optimize=True：PIL 自己算差集 bbox，帧尺寸小于画面且带局部调色板"),
    ("loop3",
     [base(1), base(6)],
     dict(duration=[120, 120], loop=3),
     "NETSCAPE 循环次数=3"),
]


def scan(path):
    """粗扫一遍容器，确认用例真的写出了它声称的结构"""
    b = open(path, "rb").read()
    assert b[:6] in (b"GIF87a", b"GIF89a"), path
    packed = b[10]
    bg_index = b[11]
    gct_len = (3 << ((packed & 7) + 1)) if packed & 0x80 else 0
    p = 13 + gct_len
    frames, patches, interlaced, loop = 0, 0, 0, None
    while p < len(b):
        m = b[p]
        if m == 0x3B:  # trailer
            break
        if m == 0x21:  # 扩展块
            label = b[p + 1]
            size = b[p + 2]
            data = b[p + 3:p + 3 + size]
            if label == 0xFF and data[:11] == b"NETSCAPE2.0":
                q = p + 3 + size
                n = b[q]
                if n >= 3 and b[q + 1] == 1:
                    loop = struct.unpack_from("<H", b, q + 2)[0]
            p += 3 + size
            while b[p]:  # 后续子块
                p += 1 + b[p]
            p += 1
            continue
        if m == 0x2C:  # 图像描述符
            x, y, w, h = struct.unpack_from("<HHHH", b, p + 1)
            fl = b[p + 9]
            frames += 1
            if (x, y) != (0, 0) or (w, h) != (W, H):
                patches += 1
            if fl & 0x40:
                interlaced += 1
            lct = (3 << ((fl & 7) + 1)) if fl & 0x80 else 0
            p += 10 + lct + 1  # 跳过局部表 + LZW 最小码长
            while b[p]:
                p += 1 + b[p]
            p += 1
            continue
        raise AssertionError(f"{path}：块标记 0x{m:02x} 不认识，位置 {p}")
    return dict(frames=frames, patches=patches, interlaced=interlaced,
                loop=loop, bg_index=bg_index)


def dump(name, path):
    """让 PIL 逐帧解一遍，把 RGBA 和延时写盘"""
    durations = []
    n = 0
    im = Image.open(path)
    for f in ImageSequence.Iterator(im):
        rgba = np.asarray(f.convert("RGBA"), np.uint8).reshape(-1, 4)
        assert rgba.shape == (W * H, 4), f"{name}: {rgba.shape}"
        rgba.tofile(os.path.join(OUT, f"{name}_{n}.rgba"))
        durations.append(int(f.info.get("duration") or 0))
        n += 1
    loop = im.info.get("loop")
    return dict(frames=n, durations=durations, loop=None if loop is None else int(loop))


def main():
    manifest = {"size": [W, H], "cases": []}
    for name, frames, kw, note in CASES:
        path = os.path.join(OUT, name + ".gif")
        pimg(frames[0]).save(path, save_all=True, append_images=[pimg(f) for f in frames[1:]], **kw)
        got = dump(name, path)
        st = scan(path)
        assert got["frames"] == st["frames"], f"{name}: PIL 解出 {got['frames']} 帧，文件里有 {st['frames']} 帧"
        if got["loop"] != st["loop"]:
            print(f"  提示 {name}: 循环次数 PIL 读到 {got['loop']}，文件里写的是 {st['loop']}")
        manifest["cases"].append(dict(name=name, note=note, **got, structure=st))
        print(f"  写出 {name}.gif：{got['frames']} 帧，补丁帧 {st['patches']}，"
              f"隔行 {st['interlaced']}，延时 {got['durations']}，背景索引 {st['bg_index']}")

    # node 那边生成的隔行文件：让 PIL 也解一遍，隔行行序就多了个第三方证人；
    # z_pil.gif / ref.gif 是工程里原有的真实素材，一并当额外用例
    for p in (os.path.join(OUT, "interlaced.gif"),
              os.path.join(HERE, "z_pil.gif"),
              os.path.join(HERE, "ref.gif")):
        if not os.path.exists(p):
            continue
        im = Image.open(p)
        name = "ref_" + os.path.splitext(os.path.basename(p))[0]
        sizes = im.size
        durations, n = [], 0
        for f in ImageSequence.Iterator(im):
            a = np.asarray(f.convert("RGBA"), np.uint8).reshape(-1, 4)
            a.tofile(os.path.join(OUT, f"{name}_{n}.rgba"))
            durations.append(int(f.info.get("duration") or 0))
            n += 1
        manifest["cases"].append(dict(name=name, note=f"外部素材 {os.path.basename(p)} {sizes[0]}x{sizes[1]}，只解不生成",
                                      gif=os.path.relpath(p, OUT).replace("\\", "/"),
                                      frames=n, durations=durations,
                                      loop=None if im.info.get("loop") is None else int(im.info["loop"]),
                                      size=list(sizes)))
        print(f"  解出 {name}：{n} 帧，尺寸 {sizes}")

    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as fp:
        json.dump(manifest, fp, ensure_ascii=False, indent=1)
    print(f"共 {len(manifest['cases'])} 个用例写进 {os.path.relpath(os.path.join(OUT, 'manifest.json'), HERE)}")


main()
