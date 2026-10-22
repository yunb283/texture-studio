# 反推 OpenEXR 扫描线数据：ZIP/ZIPS 的 delta + parity 交换，RLE 的两种计数约定
# 真值取自 ILM 期望文件（fmt/exr/*.expect.bin），素材由 ffmpeg 编码
# 解码语义按官方 OpenEXRCore：internal_zip.c / internal_rle.c
import os
import struct
import zlib

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "fmt", "exr")
LINES_PER_CHUNK = {0: 1, 1: 1, 2: 1, 3: 16, 4: 32, 5: 32, 6: 32, 7: 32, 8: 32, 9: 32}
COMP_NAME = {0: "NONE", 1: "RLE", 2: "ZIPS", 3: "ZIP", 4: "PIZ", 5: "PXR24", 6: "B44", 7: "B44A",
             8: "DWAA", 9: "DWAB"}


def attrs(data):
    i = 8
    out = []
    while data[i] != 0:
        j = data.index(b"\x00", i)
        name = data[i:j].decode()
        k = data.index(b"\x00", j + 1)
        typ = data[j + 1:k].decode()
        size = struct.unpack("<i", data[k + 1:k + 5])[0]
        out.append((name, typ, data[k + 5:k + 5 + size]))
        i = k + 5 + size
    return out, i + 1


def channels(val):
    out = []
    i = 0
    while val[i] != 0:
        j = val.index(b"\x00", i)
        name = val[i:j].decode()
        ptype, = struct.unpack("<i", val[j + 1:j + 5])
        xs, ys = struct.unpack("<2i", val[j + 9:j + 17])
        out.append((name, ptype, val[j + 5], xs, ys))
        i = j + 17
    return out


def chunks(data, end, n):
    offs = [int.from_bytes(data[end + i * 8:end + i * 8 + 8], "little") for i in range(n)]
    res = []
    for o in offs:
        y, = struct.unpack("<i", data[o:o + 4])
        size, = struct.unpack("<I", data[o + 4:o + 8])
        res.append((y, data[o + 8:o + 8 + size]))
    return res


def load(fname):
    data = open(os.path.join(D, fname), "rb").read()
    at, end = attrs(data)
    ad = dict((n, v) for n, t, v in at)
    chans = channels(ad["channels"])
    x0, y0, x1, y1 = struct.unpack("<4i", ad["dataWindow"])
    w, h = x1 - x0 + 1, y1 - y0 + 1
    comp = ad["compression"][0]
    lo = ad["lineOrder"][0]
    names = [c[0] for c in chans]
    ptype = chans[0][1]
    pl = LINES_PER_CHUNK[comp]
    n = (h + pl - 1) // pl
    return dict(file=fname, w=w, h=h, names=names, ptype=ptype, comp=comp, lo=lo, pl=pl,
                x0=x0, y0=y0, n=n, chunks=chunks(data, end, n))


def truth(info):
    """ILM 期望 (h,w,4) -> 按文件通道顺序取列，得到 (h, w, nch)"""
    col = {"R": 0, "G": 1, "B": 2, "A": 3}
    a = np.fromfile(os.path.join(D, info["file"] + ".expect.bin"), dtype="<f4")
    rgba = a.reshape(info["h"], info["w"], 4)
    names = info["names"]
    if all(n in col for n in names):
        return rgba[:, :, [col[n] for n in names]]
    if len(names) == 1:  # 单通道 Y：ILM 复制到 R/G/B
        return np.repeat(rgba[:, :, 0:1], len(names), axis=2)
    raise RuntimeError("未知通道 " + str(names))


def samples_bytes(info):
    dt = np.float32 if info["ptype"] == 2 else np.float16
    sb = 4 if dt == np.float32 else 2
    raw = truth(info).astype(dt).tobytes()
    return np.frombuffer(raw, dtype=np.uint8).reshape(info["h"], info["w"], len(info["names"]), sb), sb


def reconstruct(buf):
    """ZIP/ZIPS：前缀和 (b-128)，首字节原样保留"""
    b = np.frombuffer(buf, dtype=np.uint8).astype(np.int32)
    b[1:] -= 128
    return np.cumsum(b, dtype=np.uint8)


def interleave(arr):
    """(outSize,) -> 奇偶两半再交织回原序"""
    n = len(arr)
    h = (n + 1) // 2
    out = np.empty(n, dtype=np.uint8)
    out[0::2] = arr[:h]
    out[1::2] = arr[h:]
    return out


def rle_decompress(buf, plus_one):
    """plus_one=True 按 OpenEXRCore 3.x（游程 = 计数 + 1），False 按遗留 ImfRle（游程 = 计数）"""
    out = bytearray()
    i = 0
    n = len(buf)
    while i < n:
        c = buf[i]
        i += 1
        if c >= 128:
            cnt = (256 - c) if plus_one else (c - 128)
            if plus_one and c == 128:
                cnt = 128
            out += buf[i:i + cnt]
            i += cnt
        elif c == 0:
            if plus_one:
                out += bytes([buf[i]])
                i += 1
            else:
                out += b"\x00"
        else:
            cnt = c + 1 if plus_one else c
            out += bytes([buf[i]]) * cnt
            i += 1
    return bytes(out)


def unpredict_and_reorder(buf):
    """RLE：先撤销字节 delta（游程 +128 偏移），再把奇偶两半交织回去"""
    a = reconstruct(buf)
    return interleave(a)


CASES = ["e_none_f_rgb.exr", "e_none_f_rgba.exr", "e_none_h_rgb.exr", "e_none_f_gray.exr",
         "e_rle_f_rgb.exr", "e_rle_f_rgba.exr", "e_rle_h_rgb.exr", "e_rle_h_big.exr",
         "e_zip1_f_rgb.exr", "e_zip1_f_rgba.exr", "e_zip1_h_rgb.exr",
         "e_zip16_f_rgb.exr", "e_zip16_f_rgba.exr", "e_zip16_f_odd.exr", "e_zip16_f_gray.exr",
         "e_decr_f_rgb.exr", "e_offset_f_rgb.exr", "e_zip16_decr_f_1k.exr"]

for f in CASES:
    info = load(f)
    names, nch = info["names"], len(info["names"])
    t, sb = samples_bytes(info)
    print(f"{f}: {info['w']}x{info['h']} {COMP_NAME[info['comp']]} lo={info['lo']} "
          f"{names} sb={sb} 块数={info['n']}")
    bad = 0
    for ci, (y, body) in enumerate(info["chunks"]):
        lines = min(info["pl"], info["h"] - ci * info["pl"])
        y0 = y - info["y0"]
        plain = t[y0:y0 + lines].transpose(0, 2, 1, 3).reshape(-1).tobytes()
        comp = info["comp"]
        if comp == 0 or len(body) == len(plain):
            dec = body if len(body) == len(plain) else None
            kind = "原样存储（压缩未变小）" if comp != 0 else "未压缩"
            if dec is None:
                kind = "不匹配"
        elif comp in (2, 3):
            try:
                raw = zlib.decompress(body)
            except Exception:
                raw = zlib.decompress(body[2:])
            dec = interleave(reconstruct(raw)).tobytes()
            kind = "zip"
        else:
            res = []
            for plus in (True, False):
                try:
                    r = rle_decompress(body, plus)
                except Exception:
                    r = None
                if r and len(r) == len(plain):
                    res.append((plus, unpredict_and_reorder(r).tobytes()))
            if len(res) == 1:
                plus, dec = res[0]
                kind = "rle(计数加一)" if plus else "rle(计数原样)"
            elif len(res) == 2:
                ok = [p for p, d in res if d == plain]
                dec = res[0][1]
                kind = "两种计数约定都能解出等长数据，匹配: " + str(ok)
            else:
                dec, kind = b"", "rle 无法解出等长"
        if dec == plain:
            if ci == 0:
                print(f"   块0 y={y} -> {kind} ✔")
        else:
            bad += 1
            if bad == 1:
                g = np.frombuffer(dec, np.uint8).reshape(-1, sb)
                p = np.frombuffer(plain, np.uint8).reshape(-1, sb)
                print(f"   块{ci} y={y} -> {kind} 不匹配 长度 {len(dec)}/{len(plain)}")
                print("      dec:", [bytes(s) for s in g[:3]], " 期望:", [bytes(s) for s in p[:3]])
    print("   => 全部块匹配" if not bad else f"   => {bad} 个块不匹配")
