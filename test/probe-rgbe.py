# 探针：ffmpeg 的 RGBE -> float 传输函数到底是什么
import struct, subprocess, os, numpy as np
FF = r"C:\Users\liyunbo\AppData\Local\Programs\Python\Python312\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'probe.hdr')

W, H = 7, 13
vs = [0, 1, 2, 3, 31, 32, 63, 64, 96, 128, 129, 160, 191, 200, 223, 254, 255]
es = [120, 126, 128, 129, 136, 143]
combos = [(v, e) for e in es for v in vs]  # 102 -> 15 rows of 7 = 105
rows = [combos[i * W:(i + 1) * W] for i in range((len(combos) + W - 1) // W)]
while len(rows) < H:
    rows.append([(0, 128)] * W)
H = len(rows)

hdr = ("#?RADIANCE\n"
       "EXPOSURE= 1.0000000000000\n"
       "FORMAT=32-bit_rle_rgbe\n\n"
       "-Y %d +X %d\n" % (H, W)).encode()
body = bytearray()
for r in rows:
    for v, e in r:
        body += bytes((v, v, v, e))
open(out, 'wb').write(hdr + bytes(body))

raw = subprocess.run([FF, '-v', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'gbrapf32le', '-'],
                     capture_output=True)
assert raw.returncode == 0, raw.stderr
g, b, r_, a = np.frombuffer(raw.stdout, dtype='<f4').reshape(4, H, W)
got = np.stack([r_, g, b], axis=-1)

d = np.array([0x63, 0x7C, 0x88, 0x97, 0xAA, 0xC5, 0xE7, 0xFF])
print(f"{'v':>4} {'e':>4} {'ffmpeg':>14} {'v*2^(e-136)':>14} {'(v+d[v>>5])*2^(e-136)':>22}")
seen = {}
for y in range(H):
    for x in range(W):
        v, e = rows[y][x]
        if (v, e) in seen:
            continue
        seen[(v, e)] = True
        plain = v * 2.0 ** (e - 136)
        canonic = (v + d[v >> 5]) * 2.0 ** (e - 136)
        print(f"{v:4d} {e:4d} {got[y,x,0]:14.8f} {plain:14.8f} {canonic:22.8f}")
