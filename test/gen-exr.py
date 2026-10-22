#!/usr/bin/env python3
"""生成 OpenEXR 测试素材；期望像素取自官方 OpenEXR（ILM）3.5.2 Python 绑定。

素材来源两条：
  1. ffmpeg 的 exr 编码器（-compression none|rle|zip1|zip16，-format half|float，
     像素格式 grayf32le / gbrpf32le / gbrapf32le）——真实编码器的字节流
  2. 在 1 的未压缩文件上改写头部属性（dataWindow 偏移、DECREASING_Y 行序），
     再用 ILM 读回，确保改动的头仍然合法

期望值 = ILM 读出的 RGBA/RGB 浮点（float32，逐像素交织，A 缺省时补 1.0）。
交叉核对：ffmpeg 自身解码结果也应与 ILM 一致（浮点通道按 ±1e-6 比对）。
另有 expect8 = ffmpeg 的 8 位 rgba PNG 输出，用来核对「线性浮点 -> 8 位」的量化规则
（见 src/js/float-quant.js；单通道 Y 因为 ffmpeg 走 limited-range 而跳过）。

已确认的格式约定（写在 exr.js 顶部，逐字节验证见 exr-test.mjs）：
  - 魔数 0x77615278（按小端读），随后 1 字节版本 2 + 1 字节 flags
  - 属性表：名称\\0 + 类型\\0 + int32 长度 + 值；以单个 \\0 结束
  - chlist 每通道：名称\\0 + int32 pixelType + uint8 pLinear + 3 字节保留
    + int32 xSampling + int32 ySampling，列表以空名结束
  - 通道按名字典序存储；数据块内也按该顺序排列（RGBA 图为 A,B,G,R）
"""
import json
import os
import struct
import subprocess

import numpy as np
import OpenEXR
import imageio_ffmpeg
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fmt", "exr")
os.makedirs(OUT, exist_ok=True)
FF = imageio_ffmpeg.get_ffmpeg_exe()
REF_PNG = os.path.join(HERE, "fmt", "ref.png")

cases = []


def add(name, note, w, h, channels, expect_from=None):
    c = {"file": name, "w": w, "h": h, "channels": channels, "note": note}
    if expect_from:
        c["expect_from"] = expect_from
    cases.append(c)


def ffmpeg_exr(name, pix_fmt, compression, fmt, src=REF_PNG, scale=None):
    p = os.path.join(OUT, name)
    cmd = [FF, "-hide_banner", "-loglevel", "error", "-y", "-i", src]
    if scale:
        cmd += ["-vf", f"scale={scale[0]}:{scale[1]}"]
    cmd += ["-pix_fmt", pix_fmt, "-compression", compression, "-format", fmt, p]
    subprocess.run(cmd, check=True)
    return p


# ---------- 1. ffmpeg 编码 ----------
enc_cases = [
    ("e_none_f_rgb.exr", "gbrpf32le", "none", "float", 3, "未压缩 float RGB"),
    ("e_none_f_rgba.exr", "gbrapf32le", "none", "float", 4, "未压缩 float RGBA"),
    ("e_none_h_rgb.exr", "gbrpf32le", "none", "half", 3, "未压缩 half RGB"),
    ("e_rle_f_rgb.exr", "gbrpf32le", "rle", "float", 3, "RLE float"),
    ("e_rle_f_rgba.exr", "gbrapf32le", "rle", "float", 4, "RLE float RGBA"),
    ("e_rle_h_rgb.exr", "gbrpf32le", "rle", "half", 3, "RLE half"),
    ("e_zip1_f_rgb.exr", "gbrpf32le", "zip1", "float", 3, "ZIPS（单行块）float"),
    ("e_zip1_f_rgba.exr", "gbrapf32le", "zip1", "float", 4, "ZIPS float RGBA"),
    ("e_zip1_h_rgb.exr", "gbrpf32le", "zip1", "half", 3, "ZIPS half"),
    ("e_zip16_f_rgb.exr", "gbrpf32le", "zip16", "float", 3, "ZIP（16 行块）float"),
    ("e_zip16_f_rgba.exr", "gbrapf32le", "zip16", "float", 4, "ZIP float RGBA"),
    ("e_zip16_f_odd.exr", "gbrpf32le", "zip16", "float", 3, "高 17 行：末块不足 16 行"),
    ("e_none_f_gray.exr", "grayf32le", "none", "float", 1, "单通道 Y float"),
    ("e_zip16_f_gray.exr", "grayf32le", "zip16", "float", 1, "单通道 Y ZIP"),
]
for name, pix, comp, fmt, nch, note in enc_cases:
    ffmpeg_exr(name, pix, comp, fmt)
    add(name, note + "（ffmpeg 编码）", 33, 17, nch)

# RLE 对噪声图才能压出字面量段，ref.png 太平滑
ffmpeg_exr("e_rle_h_big.exr", "gbrapf32le", "rle", "half", scale=(37, 23))
add("e_rle_h_big.exr", "RLE half，非 4 倍尺寸 37x23（ffmpeg 编码）", 37, 23, 4)

# 1024x768 计时
ffmpeg_exr("e_zip16_f_1k.exr", "gbrapf32le", "zip16", "float", scale=(1024, 768))
add("e_zip16_f_1k.exr", "1024x768 float RGBA ZIP，计时用", 1024, 768, 4)


# ---------- 头部解析 / 改写（只为造出 ffmpeg 造不出的头）----------
def parse_header(data):
    """返回 (attrs, headerEnd)；attrs = [(name, type, value_bytes, offset)]"""
    assert data[:4] == b"\x76\x2f\x31\x01", data[:4]
    i = 8  # 跳过版本与 flags
    attrs = []
    while data[i] != 0:
        j = data.index(b"\x00", i)
        name = data[i:j].decode()
        k = data.index(b"\x00", j + 1)
        typ = data[j + 1:k].decode()
        size = struct.unpack("<i", data[k + 1:k + 5])[0]
        val = data[k + 5:k + 5 + size]
        attrs.append((name, typ, val, k + 5))
        i = k + 5 + size
    return attrs, i


def patch(src, dst, edits):
    """edits: {属性名: 新值 bytes}，长度必须与原值一致"""
    data = bytearray(open(src, "rb").read())
    attrs, _ = parse_header(bytes(data))
    for name, newval in edits.items():
        for a_name, a_type, val, off in attrs:
            if a_name == name:
                assert len(newval) == len(val), (name, len(newval), len(val))
                data[off:off + len(val)] = newval
    open(dst, "wb").write(bytes(data))
    return dst


def box(x0, y0, x1, y1):
    return struct.pack("<4i", x0, y0, x1, y1)


def header_end(data):
    end = 8
    while data[end] != 0:
        j = data.index(b"\x00", end)
        k = data.index(b"\x00", j + 1)
        size = struct.unpack("<i", data[k + 1:k + 5])[0]
        end = k + 5 + size
    return end + 1


def read_chunks(data, lines_per_chunk):
    """EXR 单 part 扫描线也带块偏移表（每块 8 字节）；块 = [int32 y][uint32 size][数据]"""
    end = header_end(data)
    attrs = dict((n, v) for n, t, v, o in parse_header(data)[0])
    x0, y0, x1, y1 = struct.unpack("<4i", attrs["dataWindow"])
    h = y1 - y0 + 1
    n = (h + lines_per_chunk - 1) // lines_per_chunk
    offs = [int.from_bytes(data[end + i * 8:end + i * 8 + 8], "little") for i in range(n)]
    chunks = []
    for o in offs:
        y = struct.unpack("<i", data[o:o + 4])[0]
        size = struct.unpack("<I", data[o + 4:o + 8])[0]
        chunks.append((y, data[o + 8:o + 8 + size]))
    return data[:end], chunks  # 只到头部结束符，块偏移表由 rebuild 重新生成


def rebuild(src, dst, lines_per_chunk, dy=0, descending=False, new_window=None):
    """改写块的 y / 存储顺序（造出 ffmpeg 造不出的头），必要时同步窗口与行序标记"""
    data = open(src, "rb").read()
    head, chunks = read_chunks(data, lines_per_chunk)
    if descending:
        chunks = sorted(chunks, key=lambda c: -c[0])
    if dy:
        chunks = [(y + dy, body) for y, body in chunks]
    edits = {}
    if new_window:
        x0, y0, x1, y1 = new_window
        edits["dataWindow"] = box(x0, y0, x1, y1)
        edits["displayWindow"] = box(0, 0, x1, y1)
    if descending:
        edits["lineOrder"] = bytes([1])  # lineOrder 值只 1 字节：0=INCREASING 1=DECREASING
    buf = bytearray(head)
    for name, typ, val, off in parse_header(data)[0]:
        if name in edits:
            assert len(edits[name]) == len(val), (name, len(edits[name]), len(val))
            buf[off:off + len(val)] = edits[name]
    head = bytes(buf)
    n = len(chunks)
    body = b"".join(struct.pack("<i", y) + struct.pack("<I", len(b)) + b for y, b in chunks)
    table = bytearray(n * 8)
    pos = len(head) + n * 8
    for i in range(n):
        table[i * 8:i * 8 + 8] = struct.pack("<Q", pos)
        pos += 8 + len(chunks[i][1])
    open(dst, "wb").write(head + bytes(table) + body)
    return dst


SRC = os.path.join(OUT, "e_none_f_rgb.exr")
w0, h0 = 33, 17
# dataWindow 起点 (5,3)：块里的 y 同步平移，否则参考实现会拒绝
rebuild(SRC, os.path.join(OUT, "e_offset_f_rgb.exr"), 1, dy=3,
        new_window=(5, 3, 5 + w0 - 1, 3 + h0 - 1))
add("e_offset_f_rgb.exr", "dataWindow 起点 (5,3)，未压缩 float", w0, h0, 3)

# DECREASING_Y：块按 y 递减排列。块内 y 值不变，所以图像内容与非递减版本逐字节一致，
# 期望值直接取自源文件的 ILM 结果（ffmpeg 自己解码这种文件会有 ~4e-4 的偏差）
rebuild(SRC, os.path.join(OUT, "e_decr_f_rgb.exr"), 1, descending=True)
add("e_decr_f_rgb.exr", "lineOrder=DECREASING_Y，未压缩 float", w0, h0, 3,
    expect_from="e_none_f_rgb.exr")

# ZIP 16 行块 + DECREASING_Y：块级行序与块大小同时生效
rebuild(os.path.join(OUT, "e_zip16_f_1k.exr"), os.path.join(OUT, "e_zip16_decr_f_1k.exr"), 16,
        descending=True)
add("e_zip16_decr_f_1k.exr", "1024x768 DECREASING_Y + ZIP 多块", 1024, 768, 4,
    expect_from="e_zip16_f_1k.exr")


# ---------- ILM 参考解码 ----------
def ilm_read(path):
    f = OpenEXR.File(path)
    part = f.parts[0]
    dw = f.header()["dataWindow"]
    x0, y0 = int(dw[0][0]), int(dw[0][1])
    x1, y1 = int(dw[1][0]), int(dw[1][1])
    w, h = x1 - x0 + 1, y1 - y0 + 1
    ch = part.channels
    names = list(ch.keys())
    first = ch[names[0]]
    ptype = first.type() if callable(first.type) else first.type
    dt = np.float16 if ptype == OpenEXR.PixelType.HALF else np.float32
    if len(names) == 1 and names[0] in ("RGBA", "RGB", "Y", "Luminance", " luminance"):
        # ILM 已把常见通道组聚合成交织缓冲
        n = {"RGBA": 4, "RGB": 3}.get(names[0], 1)
        arr = np.frombuffer(bytes(first.pixels), dtype=dt).reshape(h, w, n).astype(np.float32)
        if n == 4:
            out = arr
        elif n == 3:
            out = np.concatenate([arr, np.ones((h, w, 1), np.float32)], axis=-1)
        else:
            out = np.concatenate([arr[:, :, :1]] * 3 + [np.ones((h, w, 1), np.float32)], axis=-1)
        got_names = names
    else:
        # 非常规通道名：逐通道取出，按 R/G/B/A 归位
        cols = {}
        for n in names:
            cols[n] = np.frombuffer(bytes(ch[n].pixels), dtype=dt).reshape(h, w).astype(np.float32)
        rgb = np.stack([cols.get(k, np.zeros((h, w), np.float32)) for k in ("R", "G", "B")], axis=-1)
        alpha = cols.get("A", np.ones((h, w), np.float32))[:, :, None]
        out = np.concatenate([rgb, alpha], axis=-1)
        got_names = names
    return out, w, h, got_names, f.header()["compression"]


def ffmpeg_expect(path, w, h):
    """ffmpeg 解码为 gbrapf32le（平面：G,B,R,A）-> (h,w,4) float32"""
    raw = path + ".f32.raw"
    r = subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", "-i", path,
                        "-f", "rawvideo", "-pix_fmt", "gbrapf32le", raw],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "").strip().splitlines()[-1] if r.stderr else "ffmpeg 解码失败")
    a = np.fromfile(raw, dtype="<f4")
    os.remove(raw)
    if a.size != w * h * 4:
        raise RuntimeError(f"ffmpeg 输出 {a.size} 个浮点，期望 {w * h * 4}")
    pl = a.reshape(4, h, w)
    return np.stack([pl[2], pl[0], pl[1], pl[3]], axis=-1)


print("== ILM 参考解码 ==")
usable = []
for c in cases:
    p = os.path.join(OUT, c["file"])
    try:
        arr, w, h, names, comp = ilm_read(p)
    except Exception as e:
        print(f"  SKIP {c['file']:26s} ILM 读不了: {type(e).__name__} {str(e)[:70]}")
        continue
    if (w, h) != (c["w"], c["h"]):
        print(f"  SKIP {c['file']:26s} 尺寸 {w}x{h} != {c['w']}x{c['h']}")
        continue
    arr = np.ascontiguousarray(arr, dtype="<f4")
    arr.tofile(p + ".expect.bin")
    c["expect"] = c["file"] + ".expect.bin"
    c["ilm_channels"] = names
    c["ilm_compression"] = str(comp)
    usable.append(c)
    # 交叉核对：ffmpeg 的解码应与 ILM 一致（浮点比较，容差 1e-6）
    try:
        fa = ffmpeg_expect(p, w, h)
        c["vs_ffmpeg"] = float(np.abs(fa - arr).max())
    except Exception as e:
        c["vs_ffmpeg"] = None
        print(f"       ffmpeg 交叉核对失败: {str(e)[:60]}")
    print(f"  ok   {c['file']:26s} {w}x{h} {str(comp).split('.')[-1]:16s} {names} "
          f"vs_ffmpeg={c['vs_ffmpeg']}  {c['note']}")

# ILM 的新版 File API 读不了 DECREASING_Y（旧 InputFile 可以）。这类素材是「同内容、改块顺序」
# 重建出来的，期望值直接沿用源文件（INCREASING）的 ILM 结果；没有源文件时才退回 ffmpeg。
by_name = {c["file"]: c for c in cases}
for c in cases:
    if "expect" in c:
        continue
    p = os.path.join(OUT, c["file"])
    src_c = by_name.get(c.get("expect_from") or "")
    src_e = os.path.join(OUT, src_c["expect"]) if src_c and src_c.get("expect") else None
    if src_e and os.path.exists(src_e):
        arr = np.fromfile(src_e, dtype="<f4")
        if arr.size != c["w"] * c["h"] * 4:
            src_e = None
        else:
            arr.tofile(p + ".expect.bin")
            c["expect"] = c["file"] + ".expect.bin"
            c["reference"] = "derived:" + src_c["file"]
            try:
                c["vs_ffmpeg"] = float(np.abs(ffmpeg_expect(p, c["w"], c["h"]) - arr).max())
            except Exception:
                c["vs_ffmpeg"] = None
            usable.append(c)
            print(f"  dok  {c['file']:26s} {c['w']}x{c['h']} 期望取自 {src_c['file']} "
                  f"vs_ffmpeg={c['vs_ffmpeg']}  {c['note']}")
            continue
    try:
        fa = np.ascontiguousarray(ffmpeg_expect(p, c["w"], c["h"]), dtype="<f4")
    except Exception as e:
        print(f"  SKIP {c['file']:26s} ffmpeg 也读不了: {str(e)[:60]}")
        continue
    fa.tofile(p + ".expect.bin")
    c["expect"] = c["file"] + ".expect.bin"
    c["ilm_channels"] = None
    c["reference"] = "ffmpeg"
    usable.append(c)
    print(f"  fok  {c['file']:26s} {c['w']}x{c['h']} 期望取自 ffmpeg  {c['note']}")

def ffmpeg_expect8(path, w, h):
    """ffmpeg 的 8 位输出（-pix_fmt rgba 的 PNG）-> (h,w,4) uint8，作为量化规则的参考"""
    png = path + ".e8.png"
    r = subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", "-i", path,
                        "-pix_fmt", "rgba", png], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "").strip().splitlines()[-1] if r.stderr else "ffmpeg 转出失败")
    a = np.asarray(Image.open(png).convert("RGBA"), dtype=np.uint8)
    os.remove(png)
    if a.shape != (h, w, 4):
        raise RuntimeError(f"ffmpeg 8 位输出形状 {a.shape} != {(h, w, 4)}")
    return a


print("\n== 8 位量化期望（取自 ffmpeg 的 rgba PNG 输出）==")
for c in usable:
    if c["channels"] == 1:
        print(f"  SKIP {c['file']:26s} 单通道 Y：ffmpeg 对它做 limited-range 扩展，不作参考")
        continue
    p = os.path.join(OUT, c["file"])
    src_c = by_name.get(c.get("expect_from") or "") if c.get("reference", "").startswith("derived:") else None
    try:
        if src_c and src_c.get("expect8"):
            # 内容与源文件逐块一致，只是块顺序/头部不同，8 位期望直接沿用
            a = np.fromfile(os.path.join(OUT, src_c["expect8"]), dtype=np.uint8).reshape(c["h"], c["w"], 4)
            ref = "derived:" + src_c["file"]
        else:
            a = ffmpeg_expect8(p, c["w"], c["h"])
            ref = "ffmpeg-rgba-png"
    except Exception as e:
        print(f"  SKIP {c['file']:26s} {str(e)[:70]}")
        continue
    np.ascontiguousarray(a).tofile(p + ".expect8.bin")
    c["expect8"] = c["file"] + ".expect8.bin"
    c["expect8_from"] = ref
    print(f"  ok   {c['file']:26s} {c['w']}x{c['h']} max={a.max()} {ref}")

with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump({"cases": usable}, f, ensure_ascii=False, indent=1)
print(f"\n可用素材 {len(usable)}/{len(cases)} -> {OUT}")
