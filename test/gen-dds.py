#!/usr/bin/env python3
"""生成 DDS 测试素材，期望值取自 Pillow 的解码结果（BCn 另与 texture2ddecoder 交叉验证）。

已验证的约定（与 Pillow / texture2ddecoder 逐字节一致）：
  - 565 端点扩展：R/B = (v<<3)|(v>>2)，G = (g<<2)|(g>>4)
  - BC1 颜色表 [c0, c1, floor((2c0+c1)/3), floor((c0+2c1)/3)]；c0<=c1 时退化为
    [c0, c1, floor((c0+c1)/2), 透明黑]；BC2/BC3 的颜色块恒为 4 色
  - BC3/BC4/BC5 alpha 表：a0>a1 -> [a0,a1,((8-i)a0+(i-1)a1)//7 (i=2..7)]
    否则 -> [a0,a1,((6-i)a0+(i-1)a1)//5 (i=2..5),0,255]
  - 选择子：BC1 每像素 2 位、行主序低位在前；BC4/BC5 每像素 3 位、跨 6 字节小端
  - BC5 的第三通道补 0、alpha 补 255（与 Pillow、D3D 文档一致；ffmpeg 补法不同）
  - 未压缩：按掩码取值后 int(v*255/total)（Pillow DdsRgbDecoder 的量化方式）

关键偏移与常量（本文件按此写出，Pillow 全部接受）：
  - 文件偏移 = DDS_HEADER 结构偏移 + 4（前 4 字节是 "DDS " 魔数）
    ddpf 76（size/flags/fourCC/bitCount = 76/80/84/88），R/G/B/A 掩码 92/96/100/104，
    dwCaps 108、dwCaps2 112，DX10 结构 128，数据 148（无 DX10 时 128）
  - DDPF：ALPHAPIXELS=0x1（不是 0x2！0x2 是 ALPHA，Pillow 用它当「纯 alpha 纹理」）、
    FOURCC=0x4、PALETTEINDEXED8=0x20、RGB=0x40、LUMINANCE=0x20000
  - DXGI：R8G8B8A8_UNORM=28（27 是 TYPELESS、29 是 sRGB）、B8G8R8A8_UNORM=87、
    BC1..BC5 UNORM=71/74/77/80/83（TYPELESS=70/73/76/79/82）、BC6H_UF16=95、BC7=98
  - Pillow 支持 LUMINANCE 8 位（L）与 LUMINANCE|ALPHAPIXELS 16 位（LA，字节序 L 在前），
    但 DX10 分支不认 B8G8R8A8；ffmpeg 认，却把 87 当 RGBA 直接搬字节（不交换），故 87
    只能与遗留 BGRA 掩码素材交叉比对。
"""
import json
import os
import struct
import subprocess

import numpy as np
from PIL import Image

import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fmt", "dds")
os.makedirs(OUT, exist_ok=True)
_spec = importlib.util.spec_from_file_location("ref_dds", os.path.join(HERE, "ref-dds.py"))
REF = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(REF)

cases = []


def add(name, data, w, h, note):
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(data)
    cases.append({"file": name, "w": w, "h": h, "note": note})


def header(w, h, pf_flags, fourcc=b"\x00\x00\x00\x00", bpp=0, masks=(0, 0, 0, 0),
           pitch=None, mips=1, caps=0x1000, caps2=0, dx10=None, linear=None):
    """dds 头：dwSize=124，DX10 时再跟 20 字节"""
    hdr = bytearray(148 if dx10 else 128)
    hdr[0:4] = b"DDS "

    def put(off, v):
        hdr[off:off + 4] = struct.pack("<I", v & 0xFFFFFFFF)

    flags = 0x1 | 0x2 | 0x4 | 0x1000  # CAPS|HEIGHT|WIDTH|PIXELFORMAT
    if linear is not None:
        flags |= 0x8000  # LINEARSIZE
    elif pitch is not None:
        flags |= 0x8  # PITCH
    if mips > 1:
        flags |= 0x2000
    put(4, 124)
    put(8, flags)
    put(12, h)
    put(16, w)
    put(20, linear if linear is not None else (pitch or 0))
    put(28, mips)
    put(76, 32)
    put(80, pf_flags)
    hdr[84:88] = fourcc if isinstance(fourcc, bytes) else struct.pack("<I", fourcc)
    put(88, bpp)
    for i, m in enumerate(masks):
        put(92 + 4 * i, m)
    put(108, caps)
    put(112, caps2)
    if dx10:
        put(128, dx10)      # dxgiFormat
        put(132, 3)         # resourceDimension = TEXTURE2D
        put(136, 0)         # miscFlag
        put(140, 1)         # arraySize
        put(144, 0)         # miscFlags2
    return bytes(hdr)


def rgba_bytes(w, h, seed):
    rs = np.random.RandomState(seed)
    return rs.randint(0, 256, (h, w, 4), dtype=np.uint8)


# ---------- 未压缩 ----------
def pack_pixels(px, bpp, masks, pitch=None):
    """按掩码把 8 位通道打包进小端样本（与 Pillow DdsRgbDecoder 逆运算）"""
    h, w, _ = px.shape
    bytecount = bpp // 8
    pitch = pitch or (w * bytecount)
    out = bytearray(pitch * h)
    masks = tuple(masks) + (0,) * (4 - len(masks))
    shifts, totals = [], []
    for m in masks:
        off = 0
        if m:
            while (m >> (off + 1)) << (off + 1) == m:
                off += 1
        shifts.append(off)
        totals.append(m >> off if m else 0)
    for y in range(h):
        for x in range(w):
            value = 0
            for i in range(4):
                if not totals[i]:
                    continue
                value |= int(round(int(px[y, x, i]) * totals[i] / 255.0)) << shifts[i]
            o = y * pitch + x * bytecount
            out[o:o + bytecount] = int.to_bytes(value, bytecount, "little")
    return bytes(out)


PX = rgba_bytes(8, 6, 1)

uncomp = [
    ("u_a8r8g8b8.dds", 32, (0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000), 0x41, "32 位 A8R8G8B8"),
    ("u_x8r8g8b8.dds", 32, (0x00FF0000, 0x0000FF00, 0x000000FF, 0), 0x40, "32 位无 alpha"),
    ("u_a8b8g8r8.dds", 32, (0x000000FF, 0x0000FF00, 0x00FF0000, 0xFF000000), 0x41, "掩码反序（BGRA）"),
    ("u_r8g8b8.dds", 24, (0x00FF0000, 0x0000FF00, 0x000000FF), 0x40, "24 位 RGB"),
    ("u_r5g6b5.dds", 16, (0x0000F800, 0x000007E0, 0x0000001F), 0x40, "16 位 565"),
    ("u_a4r4g4b4.dds", 16, (0x00000F00, 0x000000F0, 0x0000000F, 0x0000F000), 0x41, "16 位 4444"),
    ("u_a1r5g5b5.dds", 16, (0x00007C00, 0x000003E0, 0x0000001F, 0x00008000), 0x41, "16 位 1555"),
    ("u_r5g5b5x1.dds", 16, (0x00007C00, 0x000003E0, 0x0000001F, 0x00008000), 0x40, "16 位 5551 无 alpha"),
    ("u_odd_masks.dds", 16, (0x00000C00, 0x00000300, 0x000000C0), 0x40, "非对齐小掩码（2 位通道）"),
]
for name, bpp, masks, flags, note in uncomp:
    data = pack_pixels(PX, bpp, masks)
    add(name, header(8, 6, flags, bpp=bpp, masks=masks, pitch=8 * bpp // 8) + data, 8, 6, note)

# 亮度族：Pillow 用 raw 解码器，掩码不参与，需单独构造
L = np.arange(48, dtype=np.uint8).reshape(6, 8)
A = (255 - L).astype(np.uint8)
add("u_l8.dds", header(8, 6, 0x20000, bpp=8, pitch=8) + L.tobytes(), 8, 6, "8 位 LUMINANCE")
la = np.stack([L, A], axis=-1).astype(np.uint8)  # A8L8：低字节 L，高字节 A
add("u_a8l8.dds", header(8, 6, 0x20000 | 0x1, bpp=16, pitch=16,
                         masks=(0x00FF, 0, 0, 0xFF00)) + la.tobytes(), 8, 6, "16 位 LUMINANCE|ALPHA")

# 带 mip 链：只应读 0 级
mip = header(8, 6, 0x41, bpp=32, masks=(0xFF0000, 0xFF00, 0xFF, 0xFF000000), pitch=32, mips=3)
chain = pack_pixels(PX, 32, (0xFF0000, 0xFF00, 0xFF, 0xFF000000)) + bytes(np.random.RandomState(2).randint(0, 256, 4 * 3 * 4, dtype=np.uint8))
add("u_mips.dds", mip + chain, 8, 6, "带 3 级 mip，取 0 级")

# 立方图：只应读首个面
face = pack_pixels(PX, 32, (0xFF0000, 0xFF00, 0xFF, 0xFF000000))
cube_hdr = header(8, 6, 0x41, bpp=32, masks=(0xFF0000, 0xFF00, 0xFF, 0xFF000000), pitch=32,
                  caps=0x1000 | 0x8, caps2=0x000200 | 0x00FE)
add("u_cube.dds", cube_hdr + face + bytes(64 * 5), 8, 6, "立方图 6 面，取 +X 面")

# ---------- BCn ----------
BC = {"bc1": (b"DXT1", 8), "bc2": (b"DXT3", 16), "bc3": (b"DXT5", 16), "bc4": (b"BC4U", 8),
      "bc5": (b"ATI2", 16)}
DX10_FMT = {"bc1": 71, "bc2": 74, "bc3": 77, "bc4": 80, "bc5": 83}

for kind in BC:
    fcc, bsize = BC[kind]
    for (w, h, seed) in [(16, 16, 11), (6, 5, 12), (4, 4, 13), (5, 1, 14), (8, 9, 15)]:
        nb = ((w + 3) // 4) * ((h + 3) // 4)
        body = bytes(np.random.RandomState(seed).randint(0, 256, nb * bsize, dtype=np.uint8))
        add(f"b_{kind}_{w}x{h}.dds", header(w, h, 0x4, fourcc=fcc, linear=len(body)) + body,
            w, h, f"随机块 {kind} {w}x{h}")

# 结构化 BC1：4 色/3 色、选择子全 0..3
def block_bc1(c0, c1, sel_rows):
    return struct.pack("<HH", c0, c1) + bytes(sel_rows)


structured = bytearray()
for c0, c1 in [(0xF800, 0x001F), (0x001F, 0xF800), (0x0000, 0xFFFF), (0xFFFF, 0x0000),
               (0x0020, 0x0021), (0x7BEF, 0x8421)]:
    structured += block_bc1(c0, c1, [0, 0x55, 0xAA, 0xFF])
    structured += block_bc1(c0, c1, [0xFF, 0xAA, 0x55, 0])
w, h = 16, 12  # 12 个块，正好用完上面构造的全部端点组合
add("b_bc1_structured.dds", header(w, h, 0x4, fourcc=b"DXT1", linear=len(structured)) + bytes(structured),
    w, h, "BC1 端点顺序/3 色模式结构化")

# 结构化 BC3：alpha 表 8 个索引 + 颜色 4 色/3 色
def block_bc3(a0, a1, abits, c0, c1, sel):
    return struct.pack("<BB", a0, a1) + int.to_bytes(abits, 6, "little") + struct.pack("<HH", c0, c1) + sel


st3 = bytearray()
for a0, a1 in [(200, 40), (40, 200), (128, 128), (0, 255), (255, 0)]:
    bits = 0
    for i in range(16):
        bits |= (i % 8) << (3 * i)
    st3 += block_bc3(a0, a1, bits, 0xF800, 0x001F, bytes([0xE4, 0x1B, 0x7D, 0xF2]))
w, h = 20, 4
add("b_bc3_structured.dds", header(w, h, 0x4, fourcc=b"DXT5", linear=len(st3)) + bytes(st3),
    w, h, "BC3 alpha 表全索引 + 颜色混合")

# 结构化 BC2：4 位 alpha 全组合（每块 8 字节 alpha：字节 n//2、半字节 4*(n&1)）
st2 = bytearray()
for k in range(16):
    ab = bytearray(8)
    for n in range(16):
        ab[n // 2] |= ((n + k) % 16) << (4 * (n & 1))
    st2 += ab
    st2 += struct.pack("<HH", 0xF800 if k % 2 else 0x001F, 0x001F if k % 2 else 0xF800)
    st2 += bytes([0xE4, 0x1B, 0x7D, 0xF2])
w = h = 16
add("b_bc2_structured.dds", header(w, h, 0x4, fourcc=b"DXT3", linear=len(st2)) + bytes(st2),
    w, h, "BC2 4 位 alpha 全组合")

# 结构化 BC4/BC5
def block_bc4(a0, a1, bits):
    return struct.pack("<BB", a0, a1) + int.to_bytes(bits, 6, "little")


st4, st5 = bytearray(), bytearray()
for a0, a1 in [(200, 40), (40, 200), (0, 0), (255, 255), (17, 200)]:
    bits = 0
    for i in range(16):
        bits |= ((i * 5) % 8) << (3 * i)
    st4 += block_bc4(a0, a1, bits)
    st5 += block_bc4(a1, a0, bits ^ 0x123456789ABC) + block_bc4(a0, a1, bits)
add("b_bc4_structured.dds", header(4, 20, 0x4, fourcc=b"BC4U", linear=len(st4)) + bytes(st4),
    4, 20, "BC4 alpha 表全索引")
add("b_bc5_structured.dds", header(4, 20, 0x4, fourcc=b"ATI2", linear=len(st5)) + bytes(st5),
    4, 20, "BC5 双通道（第三通道补 0）")

# DX10 头（同样的块数据，验证头部解析）
nb = 16
body = bytes(np.random.RandomState(31).randint(0, 256, nb * 8, dtype=np.uint8))
add("dx_bc1.dds", header(8, 8, 0x4, fourcc=b"DX10", dx10=71, linear=len(body)) + body,
    8, 8, "DX10 头 BC1")
body16 = bytes(np.random.RandomState(32).randint(0, 256, nb * 16, dtype=np.uint8))
add("dx_bc3.dds", header(8, 8, 0x4, fourcc=b"DX10", dx10=77, linear=len(body16)) + body16,
    8, 8, "DX10 头 BC3")
add("dx_bc5.dds", header(8, 8, 0x4, fourcc=b"DX10", dx10=83, linear=len(body16)) + body16,
    8, 8, "DX10 头 BC5")
add("dx_rgba8.dds", header(8, 6, 0x4, fourcc=b"DX10", dx10=28,
                           pitch=32) + PX.tobytes(),
    8, 6, "DX10 R8G8B8A8_UNORM")
add("dx_bgra8.dds", header(8, 6, 0x4, fourcc=b"DX10", dx10=87,
                           pitch=32) + PX[:, :, [2, 1, 0, 3]].tobytes(),
    8, 6, "DX10 B8G8R8A8_UNORM")

# ---------- 大图：既测大数据量，也计时（期望仍来自 Pillow）----------
w, h = 1024, 768
big = np.random.RandomState(41).randint(0, 256, ((w + 3) // 4) * ((h + 3) // 4) * 16, dtype=np.uint8)
add("big_bc3.dds", header(w, h, 0x4, fourcc=b"DXT5", linear=big.size) + big.tobytes(), w, h,
    "1024x768 随机 BC3，计时用")

# ---------- 真实编码器产头的素材（Pillow save），避免只验证自己拼的头 ----------
for mode, nm in [("RGBA", "enc_rgba.dds"), ("L", "enc_l.dds")]:
    src = os.path.join(HERE, "fmt", "ref.png")
    Image.open(src).convert(mode).save(os.path.join(OUT, nm))
    sw, sh = Image.open(src).size
    cases.append({"file": nm, "w": sw, "h": sh, "note": f"Pillow 编码器写出的 {mode} DDS"})

# ---------- Pillow 参考解码 ----------
# Pillow 不认的格式仍可验证：与某个 Pillow 已验证素材逐字节同结果（same_as 交叉比对）
CROSS = {
    "dx_bgra8.dds": (
        "u_a8b8g8r8.dds",
        "Pillow 不支持 DX10 B8G8R8A8；与已验证的遗留 BGRA 掩码素材同图，结果应逐字节相同",
    ),
}
print("== Pillow 参考解码 ==")
usable = []
for c in cases:
    p = os.path.join(OUT, c["file"])
    try:
        im = Image.open(p)
        im.load()
    except Exception as e:
        print(f"  SKIP {c['file']:26s} Pillow 读不了: {type(e).__name__} {str(e)[:60]}")
        continue
    arr = np.asarray(im.convert("RGBA"))
    if arr.shape != (c["h"], c["w"], 4):
        print(f"  SKIP {c['file']:26s} 尺寸不符 {arr.shape}")
        continue
    exp = p + ".expect.bin"
    np.ascontiguousarray(arr).astype(np.uint8).tofile(exp)
    c["expect"] = c["file"] + ".expect.bin"
    c["mode"] = im.mode
    usable.append(c)
    print(f"  ok   {c['file']:26s} {c['w']}x{c['h']} mode={im.mode:5s} {c['note']}")

by_name = {c["file"]: c for c in usable}
for c in cases:
    x = CROSS.get(c["file"])
    if x and x[0] in by_name and c["w"] == by_name[x[0]]["w"] and c["h"] == by_name[x[0]]["h"]:
        c["same_as"] = x[0]
        c["note"] += "（" + x[1] + "）"
        usable.append(c)
        print(f"  xok  {c['file']:26s} 交叉比对 {x[0]}")

with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump({"cases": usable}, f, ensure_ascii=False, indent=1)
print(f"\n可用素材 {len(usable)}/{len(cases)} -> {OUT}")
