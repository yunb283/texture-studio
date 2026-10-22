# BCn 解码公式模型：与 Pillow / texture2ddecoder 逐字节对齐后才写进 JS
# 表结构与取整方式均由 Pillow 反推验证（见 dds-test.mjs 的期望值即来自 Pillow）
import numpy as np


def unpack565(v):
    r = (v >> 11) & 31
    g = (v >> 5) & 63
    b = v & 31
    return np.array([(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)], dtype=int)


def color_table(c0, c1, four_colour=True):
    """BC1/BC2/BC3 颜色表：索引 0/1 是端点，2/3 为 1/3、2/3 内插（向下取整）。
    BC1 且 c0<=c1 时退化为 3 色 + 索引 3 透明黑；BC2/BC3 恒为 4 色。"""
    q0, q1 = unpack565(c0), unpack565(c1)
    if four_colour or c0 > c1:
        return [q0, q1, np.floor((2 * q0 + q1) / 3), np.floor((q0 + 2 * q1) / 3)], True
    return [q0, q1, np.floor((q0 + q1) / 2), np.zeros(3, dtype=int)], False


def alpha_table(a0, a1):
    """BC3/BC4/BC5 的 8 项 alpha 表（全部向下取整）"""
    if a0 > a1:
        return [a0, a1] + [((8 - i) * a0 + (i - 1) * a1) // 7 for i in range(2, 8)]
    return [a0, a1] + [((6 - i) * a0 + (i - 1) * a1) // 5 for i in range(2, 6)] + [0, 255]


def decode_block(blk, kind):
    """返回 4x4x4 RGBA（int）"""
    out = np.zeros((4, 4, 4), dtype=int)
    if kind in ('bc4', 'bc5'):
        for ch in ((0, 1) if kind == 'bc5' else (0,)):
            base = ch * 8
            tab = alpha_table(int(blk[base]), int(blk[base + 1]))
            bits = int.from_bytes(blk[base + 2:base + 8], 'little')
            for y in range(4):
                for x in range(4):
                    out[y, x, ch] = tab[(bits >> (3 * (4 * y + x))) & 7]
        if kind == 'bc4':
            out[:, :, 1] = out[:, :, 0]
            out[:, :, 2] = out[:, :, 0]
        else:
            out[:, :, 2] = 0
        out[:, :, 3] = 255
        return out
    cbase = 8 if kind in ('bc2', 'bc3') else 0
    tab, four = color_table(int.from_bytes(blk[cbase:cbase + 2], 'little'),
                            int.from_bytes(blk[cbase + 2:cbase + 4], 'little'),
                            kind != 'bc1')
    cbits = int.from_bytes(blk[cbase + 4:cbase + 8], 'little')
    if kind == 'bc3':
        atab = alpha_table(int(blk[0]), int(blk[1]))
        abits = int.from_bytes(blk[2:8], 'little')
    for y in range(4):
        for x in range(4):
            sel = (cbits >> (2 * (4 * y + x))) & 3
            rgb = tab[sel]
            if kind == 'bc1':
                a = 255 if (four or sel != 3) else 0
            elif kind == 'bc2':
                byte = blk[y * 2 + x // 2]
                a = ((byte >> (4 * (x & 1))) & 15) * 17
            else:
                a = atab[(abits >> (3 * (4 * y + x))) & 7]
            out[y, x] = (rgb[0], rgb[1], rgb[2], a)
    return out


BLOCK = {'bc1': 8, 'bc4': 8, 'bc2': 16, 'bc3': 16, 'bc5': 16}


def decode_image(body, w, h, kind):
    bx, by = (w + 3) // 4, (h + 3) // 4
    size = BLOCK[kind]
    img = np.zeros((h, w, 4), dtype=int)
    for j in range(by):
        for i in range(bx):
            blk = np.frombuffer(bytes(body[(j * bx + i) * size:(j * bx + i) * size + size]), np.uint8)
            b = decode_block(blk, kind)
            img[j * 4:min(j * 4 + 4, h), i * 4:min(i * 4 + 4, w)] = \
                b[:min(4, h - j * 4), :min(4, w - i * 4)]
    return img
