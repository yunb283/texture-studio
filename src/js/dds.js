// DDS 解码：未压缩（掩码 / 亮度）+ BC1/BC2/BC3/BC4/BC5，支持遗留 fourCC 与 DX10 头
// 与 Pillow 逐字节核对过的约定（素材与用例见 test/gen-dds.py、test/dds-test.mjs）：
//   - 文件偏移 = DDS_HEADER 结构偏移 + 4：ddpf 76，R/G/B/A 掩码 92/96/100/104，
//     dwCaps 108、dwCaps2 112，DX10 结构 128，数据 148（无 DX10 时 128）
//   - DDPF：ALPHAPIXELS=0x1、ALPHA=0x2、FOURCC=0x4、PAL8=0x20、RGB=0x40、LUMINANCE=0x20000
//   - 未压缩量化：int(((value & mask) >> offset) / total * 255)，掩码位数不足即截断
//   - BC1 颜色表 4 色；c0<=c1 时退化为 [c0,c1,floor((c0+c1)/2), 透明黑]，BC2/BC3 恒 4 色
//   - 565 扩展：R/B = (v<<3)|(v>>2)，G = (v<<2)|(v>>4)
//   - BC3/4/5 alpha 表：a0>a1 用 //7 权重，否则用 //5 权重并在末尾补 0、255
//   - BC5 第三通道补 0、alpha 补 255；BC4 复制到 RGB
const DDSD_PITCH = 0x8;
const DDSD_VOLUME = 0x80000;
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_ALPHA = 0x2;
const DDPF_FOURCC = 0x4;
const DDPF_PALETTE = 0x20;
const DDPF_RGB = 0x40;
const DDPF_LUMINANCE = 0x20000;

// 遗留 fourCC -> [类型, 块字节数]
const FOURCC_BCN = {
  DXT1: ['bc1', 8],
  DXT3: ['bc2', 16],
  DXT5: ['bc3', 16],
  ATI1: ['bc4', 8],
  BC4U: ['bc4', 8],
  ATI2: ['bc5', 16],
  BC5U: ['bc5', 16],
};
// DXGI_FORMAT -> 同上；未列出的（BC6H/BC7/SNORM/浮点）按规范拒绝
const DXGI_BCN = {
  70: ['bc1', 8], 71: ['bc1', 8],
  73: ['bc2', 16], 74: ['bc2', 16],
  76: ['bc3', 16], 77: ['bc3', 16],
  79: ['bc4', 8], 80: ['bc4', 8],
  82: ['bc5', 16], 83: ['bc5', 16],
};
// DXGI 32 位未压缩：字节顺序 [R, G, B] 在内存中的位置
const DXGI_RGBA = { 27: 'rgba', 28: 'rgba', 29: 'rgba', 87: 'bgra', 90: 'bgra' };

function ascii(b, o, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

function unpack565(v) {
  const r = (v >> 11) & 31;
  const g = (v >> 5) & 63;
  const bl = v & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (bl << 3) | (bl >> 2)];
}

// 12 字节：4 色 x RGB（BC1 的 3 色模式下第 4 色由调用方当作透明黑）
function colorTable(b, o, forceFour) {
  const c0 = b[o] | (b[o + 1] << 8);
  const c1 = b[o + 2] | (b[o + 3] << 8);
  const a = unpack565(c0);
  const c = unpack565(c1);
  const t = new Uint8Array(12);
  const four = forceFour || c0 > c1;
  for (let i = 0; i < 3; i++) {
    t[i] = a[i];
    t[3 + i] = c[i];
    t[6 + i] = four ? Math.floor((2 * a[i] + c[i]) / 3) : (a[i] + c[i]) >> 1;
    t[9 + i] = four ? Math.floor((a[i] + 2 * c[i]) / 3) : 0; // 3 色模式：索引 3 是透明黑
  }
  return [t, four];
}

// 8 项 alpha 插值表
function alphaTable(a0, a1) {
  const t = new Uint8Array(8);
  t[0] = a0;
  t[1] = a1;
  if (a0 > a1) {
    for (let i = 2; i < 8; i++) t[i] = Math.floor(((8 - i) * a0 + (i - 1) * a1) / 7);
  } else {
    for (let i = 2; i < 6; i++) t[i] = Math.floor(((6 - i) * a0 + (i - 1) * a1) / 5);
    t[6] = 0;
    t[7] = 255;
  }
  return t;
}

// 48 位小端：只用乘法，避免 << 在 >0x7F 字节上变成负数
function le48(b, o) {
  let v = 0;
  for (let i = 5; i >= 0; i--) v = v * 256 + b[o + i];
  return v;
}

function decodeBcn(b, w, h, out, kind, start, blockSize) {
  const bw = (w + 3) >> 2;
  const bh = (h + 3) >> 2;
  const need = start + bw * bh * blockSize;
  if (b.length < need) {
    throw new Error(`DDS 压缩数据不完整：需要 ${need} 字节，实际 ${b.length}`);
  }
  const color = kind === 'bc1' ? 0 : 8; // 颜色块在块内偏移（BC2/BC3 前 8 字节是 alpha）
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = start + (by * bw + bx) * blockSize;
      const cols = Math.min(4, w - bx * 4);
      const rows = Math.min(4, h - by * 4);
      let tbl = null;
      let four = true;
      if (kind !== 'bc4' && kind !== 'bc5') {
        const r = colorTable(b, o + color, kind !== 'bc1');
        tbl = r[0];
        four = r[1];
      }
      const at = kind === 'bc3' || kind === 'bc4' || kind === 'bc5' ? alphaTable(b[o], b[o + 1]) : null;
      const at2 = kind === 'bc5' ? alphaTable(b[o + 8], b[o + 9]) : null;
      const bitsA = at ? le48(b, o + 2) : 0;
      const bitsG = kind === 'bc5' ? le48(b, o + 10) : 0;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const n = 4 * y + x;
          let r = 0;
          let g = 0;
          let bl = 0;
          let al = 255;
          if (kind === 'bc4' || kind === 'bc5') {
            const av = at[Math.floor(bitsA / 2 ** (3 * n)) % 8];
            if (kind === 'bc4') {
              r = g = bl = av;
            } else {
              r = av;
              g = at2[Math.floor(bitsG / 2 ** (3 * n)) % 8];
              bl = 0;
            }
          } else {
            const i = (b[o + color + 4 + y] >> (2 * x)) & 3;
            r = tbl[i * 3];
            g = tbl[i * 3 + 1];
            bl = tbl[i * 3 + 2];
            if (kind === 'bc1') {
              if (!four && i === 3) al = 0;
            } else if (kind === 'bc2') {
              al = ((b[o + (n >> 1)] >> (4 * (n & 1))) & 15) * 17;
            } else {
              al = at[Math.floor(bitsA / 2 ** (3 * n)) % 8];
            }
          }
          const p = ((by * 4 + y) * w + bx * 4 + x) * 4;
          out[p] = r;
          out[p + 1] = g;
          out[p + 2] = bl;
          out[p + 3] = al;
        }
      }
    }
  }
}

function decodeUncompressed(b, w, h, out, start, hdrFlags, pitchOrLinear, bitCount, masks, hasAlpha) {
  const bytecount = bitCount >> 3;
  if (bitCount % 8 || bytecount < 1 || bytecount > 4) {
    throw new Error(`DDS 未压缩位深暂不支持：${bitCount} 位`);
  }
  const pitch = (hdrFlags & DDSD_PITCH) && pitchOrLinear >= w * bytecount
    ? pitchOrLinear
    : w * bytecount;
  if (b.length < start + pitch * (h - 1) + w * bytecount) {
    throw new Error(`DDS 像素数据不完整：需要 ${start + pitch * h} 字节，实际 ${b.length}`);
  }
  const count = masks.length;
  const offs = [];
  const tots = [];
  for (const m of masks) {
    let off = 0;
    while (m && m % 2 ** (off + 1) === 0) off++;
    offs.push(off);
    tots.push(m ? m / 2 ** off : 0);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = start + y * pitch + x * bytecount;
      let value = 0;
      for (let i = bytecount - 1; i >= 0; i--) value = value * 256 + b[o + i];
      const ch = new Uint8Array(4);
      for (let i = 0; i < count; i++) {
        const t = tots[i];
        ch[i] = t ? Math.floor((Math.floor(value / 2 ** offs[i]) % (t + 1)) / t * 255) : 0;
      }
      if (!hasAlpha) ch[3] = 255;
      const p = (y * w + x) * 4;
      out[p] = ch[0];
      out[p + 1] = ch[1];
      out[p + 2] = ch[2];
      out[p + 3] = ch[3];
    }
  }
}

export function decodeDds(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 128) throw new Error('DDS 文件过小');
  if (ascii(b, 0, 4) !== 'DDS ') throw new Error('不是 DDS 文件（缺少 "DDS " 魔数）');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u32 = (o) => dv.getUint32(o, true);
  if (u32(4) !== 124) throw new Error(`DDS 头长度非法：${u32(4)}，应为 124`);
  const flags = u32(8);
  if ((flags & 0x6) !== 0x6) throw new Error('DDS 头部缺少宽高标记');
  const w = u32(16);
  const h = u32(12);
  if (!w || !h || w > 65535 || h > 65535) throw new Error(`DDS 尺寸非法：${w}x${h}`);
  if (flags & DDSD_VOLUME || u32(24) > 1) throw new Error('DDS 体积纹理（3D）暂不支持');
  const pitchOrLinear = u32(20);
  const pfFlags = u32(80);
  const fourCC = ascii(b, 84, 4);
  const bitCount = u32(88);
  let start = 128;
  let dxgi = -1;
  if (fourCC === 'DX10') {
    if (b.length < 148) throw new Error('DDS DX10 头不完整');
    dxgi = u32(128);
    if (u32(132) === 4) throw new Error('DDS 体积纹理（3D）暂不支持');
    start = 148;
  }
  const out = new Uint8Array(w * h * 4);

  if (dxgi >= 0) {
    const kind = DXGI_BCN[dxgi];
    if (kind) {
      decodeBcn(b, w, h, out, kind[0], start, kind[1]);
      return { width: w, height: h, data: out };
    }
    if (dxgi === 81) throw new Error('DDS 有符号 BC4S 暂不支持');
    if (dxgi === 84) throw new Error('DDS 有符号 BC5S 暂不支持');
    if (dxgi === 94 || dxgi === 95 || dxgi === 96) throw new Error('DDS 的 BC6H（浮点块压缩）暂不支持');
    if (dxgi === 97 || dxgi === 98 || dxgi === 99) throw new Error('DDS 的 BC7 暂不支持');
    const order = DXGI_RGBA[dxgi];
    if (order) {
      const m = order === 'rgba'
        ? [0x000000ff, 0x0000ff00, 0x00ff0000, 0xff000000]
        : [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000];
      decodeUncompressed(b, w, h, out, start, flags, pitchOrLinear, 32, m, true);
      return { width: w, height: h, data: out };
    }
    throw new Error(`DDS 的 DXGI 格式 ${dxgi}（如 16 位/浮点/RGB10A2）暂不支持`);
  }

  if (pfFlags & DDPF_FOURCC) {
    const kind = FOURCC_BCN[fourCC];
    if (!kind) {
      if (fourCC === 'BC4S' || fourCC === 'ATI2N' || fourCC === 'BC5S') {
        throw new Error(`DDS 的有符号压缩 ${fourCC} 暂不支持`);
      }
      throw new Error(`DDS 压缩格式 ${fourCC} 暂不支持（仅支持 DXT1/DXT3/DXT5/BC4/BC5）`);
    }
    decodeBcn(b, w, h, out, kind[0], start, kind[1]);
    return { width: w, height: h, data: out };
  }

  if (pfFlags & DDPF_PALETTE) throw new Error('DDS 调色板（PAL8）暂不支持');
  if (pfFlags & DDPF_ALPHA && !(pfFlags & (DDPF_RGB | DDPF_LUMINANCE))) {
    throw new Error('DDS 仅 alpha 通道的格式暂不支持');
  }

  if (pfFlags & DDPF_LUMINANCE) {
    if (bitCount === 8) {
      readPlain(b, out, w, h, start, flags, pitchOrLinear, 1, (src, p) => {
        out[p] = out[p + 1] = out[p + 2] = src[0];
        out[p + 3] = 255;
      });
      return { width: w, height: h, data: out };
    }
    if (bitCount === 16 && pfFlags & DDPF_ALPHAPIXELS) {
      readPlain(b, out, w, h, start, flags, pitchOrLinear, 2, (src, p) => {
        out[p] = out[p + 1] = out[p + 2] = src[0];
        out[p + 3] = src[1];
      });
      return { width: w, height: h, data: out };
    }
    throw new Error(`DDS 亮度格式位深 ${bitCount} 暂不支持`);
  }

  if (pfFlags & DDPF_RGB) {
    const hasAlpha = !!(pfFlags & DDPF_ALPHAPIXELS);
    const masks = hasAlpha ? [u32(92), u32(96), u32(100), u32(104)] : [u32(92), u32(96), u32(100)];
    decodeUncompressed(b, w, h, out, start, flags, pitchOrLinear, bitCount, masks, hasAlpha);
    return { width: w, height: h, data: out };
  }

  throw new Error(`DDS 像素格式标记非法：0x${pfFlags.toString(16)}`);
}

// 逐行按 stride 读取原始样本，交给 cb 写出 RGBA
function readPlain(b, out, w, h, start, hdrFlags, pitchOrLinear, bpp, cb) {
  const pitch = (hdrFlags & DDSD_PITCH) && pitchOrLinear >= w * bpp ? pitchOrLinear : w * bpp;
  if (b.length < start + pitch * (h - 1) + w * bpp) {
    throw new Error(`DDS 像素数据不完整：需要 ${start + pitch * h} 字节，实际 ${b.length}`);
  }
  const src = new Uint8Array(bpp);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = start + y * pitch + x * bpp;
      for (let i = 0; i < bpp; i++) src[i] = b[o + i];
      cb(src, (y * w + x) * 4);
    }
  }
}
