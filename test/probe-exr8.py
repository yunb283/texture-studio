# 用 ffmpeg 的 8 位输出核对「线性浮点 -> 8 位」的映射：
#   >1 是否钳到 255、负值是否钳到 0、alpha 是否和 RGB 同一套裁剪、
#   单通道 Y 是否直接复制成灰度。
# 素材用自带的写入器现造（约定与 test/exr-test.mjs 的头部构造器一致），
# 造完先让官方 ILM 读回，确认浮点值真的是我要的那些。
import os
import struct
import subprocess

import numpy as np
import OpenEXR
import imageio_ffmpeg
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fmt", "exr8probe")
os.makedirs(OUT, exist_ok=True)
FF = imageio_ffmpeg.get_ffmpeg_exe()

TYPE_UINT, TYPE_HALF, TYPE_FLOAT = 0, 1, 2


def s(v):
    return v.encode() + b"\0"


def build(path, w, h, chans, px, compression=0, lines=1):
    """chans: [(名, pixelType)]，px: {名: (h,w) ndarray}，行外层、通道次外层"""
    chans = sorted(chans, key=lambda c: c[0])
    body = bytearray()
    for y in range(h // lines):
        chunk = bytearray()
        for r in range(y * lines, min((y + 1) * lines, h)):
            for name, pt in chans:
                assert pt == TYPE_FLOAT, "本探针只写 float"
                chunk += np.ascontiguousarray(px[name][r], dtype="<f4").tobytes()
        body += struct.pack("<i", y * lines) + struct.pack("<I", len(chunk)) + chunk

    head = bytearray()
    head += b"\x76\x2f\x31\x01" + bytes([2, 0, 0, 0])  # 魔数 + 版本(1字节) + 标志(3字节)

    def attr(name, typ, val):
        head.extend(s(name) + s(typ) + struct.pack("<i", len(val)) + val)

    chl = bytearray()
    for name, pt in chans:
        chl += s(name) + struct.pack("<i", pt) + bytes([0, 0, 0, 0]) + struct.pack("<ii", 1, 1)
    chl += b"\0"
    attr("channels", "chlist", bytes(chl))
    attr("compression", "compression", bytes([compression]))
    box = struct.pack("<iiii", 0, 0, w - 1, h - 1)
    attr("dataWindow", "box2i", box)
    attr("displayWindow", "box2i", box)
    attr("lineOrder", "lineOrder", bytes([0]))
    attr("pixelAspectRatio", "float", struct.pack("<f", 1.0))
    attr("screenWindowCenter", "v2f", struct.pack("<ff", 0.0, 0.0))
    attr("screenWindowWidth", "float", struct.pack("<f", 1.0))
    head += b"\0"

    n = h // lines + (1 if h % lines else 0)
    table = bytearray()
    off = 0
    for i in range(n):
        table += struct.pack("<Q", len(head) + n * 8 + off)
        off += 8 + struct.unpack("<I", body[off + 4:off + 8])[0]
    open(path, "wb").write(bytes(head) + bytes(table) + bytes(body))
    return path


def ilm_values(path, names, w, h):
    """ILM 读回：新版绑定会把 RGB(A) 聚合成一个通道，这里拆开还原"""
    f = OpenEXR.File(path)
    chs = f.parts[0].channels
    info = {}
    for key, c in chs.items():
        dt = np.float16 if "HALF" in str(c.type) else np.float32
        letters = list(key) if len(key) > 1 else [key]
        a = np.frombuffer(bytes(c.pixels), dtype=dt)
        a = a.reshape(h, w, len(letters)).astype(np.float32)
        for i, L in enumerate(letters):
            info[L] = a[:, :, i]
    return {n: info[n] for n in names}


def report(name, w, h, chans, px, note, pix_fmt="rgb24"):
    p = os.path.join(OUT, name)
    build(p, w, h, [(c, TYPE_FLOAT) for c in chans], px)
    got = ilm_values(p, chans, w, h)
    maxdev = max(float(np.abs(got[c] - px[c]).max()) for c in chans)
    print(f"\n== {name} {w}x{h} 通道 {chans} ILM 回读最大偏差 {maxdev:g}  {note}")
    if maxdev > 1e-6:
        print("   ILM 回读与写入不符，跳过")
        return
    png = p + ".png"
    r = subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", "-i", p,
                        "-pix_fmt", pix_fmt, png],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print("   ffmpeg 转出 PNG 失败:", r.stderr.strip()[:200])
        return
    im = Image.open(png)
    arr = np.asarray(im)
    print(f"   PNG mode={im.mode} shape={arr.shape} 请求 pix_fmt={pix_fmt}")
    # 逐通道数组按像素交织，才能和 PNG 的 RGBA 交错顺序对齐
    flat = np.stack([px[c].reshape(-1) for c in chans], axis=-1)
    m = arr.shape[-1]
    if m == 3 and flat.shape[-1] == 1:
        flat = np.repeat(flat, 3, axis=-1)  # 单通道 Y 在 ffmpeg 侧被复制成灰度 RGB
    flat = flat.reshape(-1)
    ref = arr.reshape(-1).astype(np.int32)
    if ref.size != flat.size:
        print(f"   元素数不符：浮点 {flat.size} vs PNG {ref.size}")
        return
    for label, f in [
        ("先钳到[0,1]再×255 四舍五入", lambda v: np.round(np.clip(v, 0, 1) * 255)),
        ("×255 后四舍五入再钳 0..255", lambda v: np.clip(np.round(v * 255), 0, 255)),
        ("×255 加 0.5 取整再钳（浏览器 Uint8Clamped 口径）", lambda v: np.clip(np.floor(v * 255 + 0.5), 0, 255)),
    ]:
        exp = f(flat).astype(np.int32)
        d = np.abs(exp - ref)
        bad = int((d > 0).sum())
        extra = ""
        if bad:
            i = int(d.argmax())
            extra = f"，最大差 {int(d.max())} 首个 #{i} 浮点 {flat[i]:.4f} 期望 {int(exp[i])} 实得 {int(ref[i])}"
        print(f"   {label}: 不符 {bad}/{d.size}{extra}")
    print("   逐点：", [(round(float(flat[i]), 3), int(ref[i])) for i in range(flat.size)])


v = np.array([0.0, 0.2, 0.5, 0.5019607843, 1.0, 1.5, 2.0, 4.0, -0.25, 1.0 / 255,
              0.999, 100.0, 1.0 / 510, 0.75], dtype=np.float32)
n = v.size
report("p_rgb.exr", n, 1, ["R", "G", "B"],
       {c: v.reshape(1, n) for c in "RGB"}, "含 >1 / 负值 / 0.5 边界")

rgba = np.array([[1.0, 0.5, 2.0, 0.0],
                 [1.0, 0.5, 2.0, 0.0],
                 [1.0, 0.5, 2.0, 0.0],
                 [0.0, 0.5, 1.0, 2.0]], dtype=np.float32)  # 末行是 A
report("p_rgba.exr", 4, 1, ["R", "G", "B", "A"],
       {"R": rgba[0:1], "G": rgba[1:2], "B": rgba[2:3], "A": rgba[3:4]},
       "alpha 0/0.5/1/2，RGB 1/0.5/2/0", "rgba")

g = np.array([0.0, 0.2, 0.5, 1.0, 1.5, 4.0, -0.3], dtype=np.float32)
report("p_gray.exr", g.size, 1, ["Y"], {"Y": g.reshape(1, -1)}, "单通道 Y")
