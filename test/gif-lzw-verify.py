# 用 PIL 解码 gif-lzw-test.mjs 生成的最小 GIF，把索引逐像素比对回原始数据。
# 期望：全部用例 0 差异。任何差异都说明 lzwEncode 的码表/位宽约定与真实解码器不符。
import json
import os
import sys

import numpy as np
from PIL import Image, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = True

here = os.path.dirname(os.path.abspath(__file__))
d = os.path.join(here, "fmt", "giflzw")
manifest = json.load(open(os.path.join(d, "manifest.json"), encoding="utf-8"))

fails = 0
for c in manifest["cases"]:
    path = os.path.join(d, c["name"] + ".gif")
    base = c["name"].rsplit("_", 1)[0]  # seq_m6_gct -> seq_m6
    exp = np.frombuffer(open(os.path.join(d, f"{base}.exp.bin"), "rb").read(), np.uint8)
    try:
        im = Image.open(path)
        im.load()
    except Exception as e:
        print(f"  FAIL {c['name']:<12} PIL 解码报错: {type(e).__name__}: {e}")
        fails += 1
        continue
    if im.mode not in ("P", "L"):
        print(f"  FAIL {c['name']:<12} 模式不是 P/L: {im.mode}")
        fails += 1
        continue
    # 调色板是恒等灰阶（索引 i → RGB i,i,i），所以取 R 通道就是索引本身
    got = np.asarray(im.convert("RGB"))[..., 0].reshape(-1)
    n = len(exp)
    if (im.width, im.height) != (c["w"], c["h"]) or got.size != n:
        print(f"  FAIL {c['name']:<12} 尺寸/像素数不符: {im.width}x{im.height} got={got.size} exp={n}")
        fails += 1
        continue
    diff = np.nonzero(got != exp)[0]
    if diff.size:
        i = int(diff[0])
        print(f"  FAIL {c['name']:<12} 位深 {c['m']} 共 {diff.size}/{n} 个索引不符，"
              f"首个在第 {i} 像素: 解出 {int(got[i])} 期望 {int(exp[i])}"
              f"（前后：解出 {list(got[max(0,i-3):i+6].astype(int))} 期望 {list(exp[max(0,i-3):i+6].astype(int))}）")
        fails += 1
    else:
        print(f"  ok   {c['name']:<12} 位深 {c['m']} 共 {n} 像素逐索引一致")

print(("全部 %d 个用例通过" % len(manifest["cases"])) if not fails else ("%d/%d 失败" % (fails, len(manifest["cases"]))))
sys.exit(1 if fails else 0)
