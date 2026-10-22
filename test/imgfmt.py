#!/usr/bin/env python3
"""贴图小工具的公共写入器：把 RGBA8 数组存成浏览器/解码器能吃到的真实文件。

gen-normal.py / gen-seamless.py 都用到，放这里避免各写一份。约定与 src/js/tga.js、
src/js/dds.js 的读取口径一致（未压缩 32 位 TGA 左上原点；未压缩 A8R8G8B8 DDS）。
"""
import struct

import numpy as np
from PIL import Image


def bgra(a):
    """RGBA -> 磁盘上的 B,G,R,A（TGA 与未压缩 A8R8G8B8 DDS 的内存字节序都是这个）"""
    out = np.empty_like(a)
    out[..., 0] = a[..., 2]
    out[..., 1] = a[..., 1]
    out[..., 2] = a[..., 0]
    out[..., 3] = a[..., 3]
    return out


def tga_bytes(rgba):
    """未压缩 32 位 TGA：18 字节头 + BGRA，descriptor bit5=左上原点、bit0-3=alpha 深度 8"""
    h, w = rgba.shape[:2]
    hdr = bytearray(18)
    hdr[2] = 2
    hdr[12:14] = bytes([w & 0xFF, w >> 8])
    hdr[14:16] = bytes([h & 0xFF, h >> 8])
    hdr[16] = 32
    hdr[17] = 0x28
    return bytes(hdr) + bgra(rgba).tobytes()


def dds_bytes(rgba):
    """未压缩 A8R8G8B8（32 位）DDS：128 字节头 + BGRA"""
    h, w = rgba.shape[:2]
    hdr = bytearray(128)
    hdr[0:4] = b"DDS "

    def put(off, v):
        hdr[off:off + 4] = struct.pack("<I", v & 0xFFFFFFFF)

    put(4, 124)
    put(8, 0x1 | 0x2 | 0x4 | 0x8 | 0x1000)  # CAPS|HEIGHT|WIDTH|PITCH|PIXELFORMAT
    put(12, h)
    put(16, w)
    put(20, w * 4)
    put(28, 1)
    put(76, 32)          # pf.dwSize
    put(80, 0x41)        # ALPHAPIXELS | RGB
    put(88, 32)          # bpp
    for i, m in enumerate((0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000)):
        put(92 + 4 * i, m)
    put(108, 0x1000)     # caps1 = TEXTURE
    return bytes(hdr) + bgra(rgba).tobytes()


def write_variants(rgba, path_no_ext, exts=("png", "bmp", "jpg", "webp", "tga", "dds")):
    """返回 {ext: 文件名}；无损扩展名保证读回的 RGBA 与原数组一致"""
    out = {}
    im = Image.fromarray(np.asarray(rgba, dtype=np.uint8), "RGBA")
    for ext in exts:
        p = f"{path_no_ext}.{ext}"
        if ext in ("png", "bmp"):
            im.save(p)
        elif ext == "jpg":
            im.convert("RGB").save(p, quality=95)
        elif ext == "webp":
            im.save(p, lossless=True, quality=100, method=4)
        elif ext == "tga":
            open(p, "wb").write(tga_bytes(np.asarray(rgba, dtype=np.uint8)))
        elif ext == "dds":
            open(p, "wb").write(dds_bytes(np.asarray(rgba, dtype=np.uint8)))
        out[ext] = os_basename(p)
    return out


def os_basename(p):
    import os

    return os.path.basename(p)
