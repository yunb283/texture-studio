// 轻量 TIFF 解码器：WebView2 不认 TIFF，只能自己解
// 覆盖常见写入器的产物：II/MM 字节序、strip/tile、压缩 1/5/8/32946/32773、
// 预测器 1/2、photometric 0/1/2/3、通道数 1~4、8/16 位深度、多页只取第一页
const WIDTH = 256;
const LENGTH = 257;
const BPS = 258;
const COMPRESSION = 259;
const PHOTOMETRIC = 262;
const STRIP_OFFSETS = 273;
const SPP = 277;
const ROWS_PER_STRIP = 278;
const STRIP_COUNTS = 279;
const PLANAR = 284;
const PREDICTOR = 317;
const COLORMAP = 320;
const TILE_WIDTH = 322;
const TILE_LENGTH = 323;
const TILE_OFFSETS = 324;
const TILE_COUNTS = 325;

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

function num(dv, le, type, off, i) {
  switch (type) {
    case 1:
    case 2:
    case 6:
    case 7:
      return dv.getUint8(off + i);
    case 3:
    case 8:
      return dv.getUint16(off + i * 2, le);
    case 4:
    case 9:
    case 11:
      return dv.getUint32(off + i * 4, le);
    case 5:
    case 10:
      return dv.getUint32(off + i * 8, le);
    default:
      return 0;
  }
}

function readTags(dv, le, ifdOffset) {
  if (ifdOffset + 2 > dv.byteLength) throw new Error('TIFF 目录偏移越界');
  const count = dv.getUint16(ifdOffset, le);
  const tags = new Map();
  for (let i = 0; i < count; i++) {
    const e = ifdOffset + 2 + i * 12;
    if (e + 12 > dv.byteLength) break;
    const id = dv.getUint16(e, le);
    const type = dv.getUint16(e + 2, le);
    const entries = dv.getUint32(e + 4, le);
    const size = (TYPE_SIZE[type] || 0) * entries;
    if (!TYPE_SIZE[type] || size > 1 << 22) continue;
    const off = size <= 4 ? e + 8 : dv.getUint32(e + 8, le);
    if (off + size > dv.byteLength) throw new Error('TIFF 数据偏移越界');
    tags.set(id, { type, entries, off });
  }
  return tags;
}

function one(dv, le, tags, id, def) {
  const t = tags.get(id);
  return !t || !t.entries ? def : num(dv, le, t.type, t.off, 0);
}

function many(dv, le, tags, id) {
  const t = tags.get(id);
  if (!t || !t.entries) return null;
  const out = new Array(t.entries);
  for (let i = 0; i < t.entries; i++) out[i] = num(dv, le, t.type, t.off, i);
  return out;
}

// TIFF 的 deflate 载荷可能带 zlib 头也可能不带，按头两字节判断
async function inflate(bytes) {
  const cmf = bytes[0];
  const flg = bytes[1];
  const zwrapped = (cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0;
  const ds = new DecompressionStream(zwrapped ? 'deflate' : 'deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function packBits(src, expected) {
  const out = new Uint8Array(expected);
  let i = 0;
  let o = 0;
  while (i < src.length && o < expected) {
    const n = src[i++] << 24 >> 24;
    if (n >= 0) {
      const run = n + 1;
      if (i + run > src.length) break;
      out.set(src.subarray(i, i + run), o);
      i += run;
      o += run;
    } else if (n !== -128) {
      if (i >= src.length) break;
      const run = 1 - n;
      out.fill(src[i++], o, Math.min(o + run, expected));
      o += run;
    }
  }
  if (o < expected) throw new Error('TIFF PackBits 数据不完整');
  return out;
}

// TIFF LZW：MSB 取码、Clear=256、EOI=257
// 加宽时机有两种写法：TIFF6 规定 next 达到 2^bits 才加宽，而 libtiff/imagecodecs
// 实际提前一个码加宽；先按实测更常见的提前加宽解，失败再退回规范写法
function lzwDecode(src, expected) {
  try {
    return lzwRun(src, expected, true);
  } catch {
    return lzwRun(src, expected, false);
  }
}

function lzwRun(src, expected, earlyChange) {
  const prefix = new Int32Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  const depth = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    suffix[i] = i;
    depth[i] = 1;
  }
  const stack = new Uint8Array(4096);
  const out = new Uint8Array(expected);
  let bits = 9;
  let acc = 0;
  let accBits = 0;
  let next = 258;
  let prev = -1;
  let o = 0;
  const addEntry = (firstByte, parent) => {
    if (next >= 4094) return;
    prefix[next] = parent;
    suffix[next] = firstByte;
    depth[next] = depth[parent] + 1;
    next++;
    if (next === (earlyChange ? (1 << bits) - 1 : 1 << bits) && bits < 12) bits++;
  };
  for (let i = 0; i < src.length && o < expected; i++) {
    acc = (acc << 8) | src[i];
    accBits += 8;
    while (accBits >= bits) {
      accBits -= bits;
      const code = (acc >> accBits) & ((1 << bits) - 1);
      acc &= (1 << accBits) - 1;
      if (code === 256) {
        next = 258;
        bits = 9;
        prev = -1;
        continue;
      }
      if (code === 257) return out;
      if (code > next || code >= 4096) throw new Error('TIFF LZW 编码异常');
      let len;
      if (code === next) {
        // 编码器刚定义、还没写入字典的码：串 = prev 的串 + prev 串的首字节
        len = depth[prev] + 1;
        let c = prev;
        for (let k = len - 2; k >= 0; k--) {
          stack[k] = suffix[c];
          c = prefix[c];
        }
        stack[len - 1] = stack[0];
        addEntry(stack[0], prev);
      } else {
        if (depth[code] === 0) throw new Error('TIFF LZW 编码异常');
        len = depth[code];
        let c = code;
        for (let k = len - 1; k >= 0; k--) {
          stack[k] = suffix[c];
          c = prefix[c];
        }
        if (prev >= 0) addEntry(stack[0], prev);
      }
      prev = code;
      if (o + len > expected) len = expected - o;
      out.set(stack.subarray(0, len), o);
      o += len;
      if (o >= expected) return out;
    }
  }
  if (o < expected) throw new Error('TIFF LZW 数据不完整');
  return out;
}

// 水平差分还原：8 位逐字节，16 位按文件字节序逐样本
function undoPredictor(data, rowBytes, spp, sampleBytes, le) {
  if (sampleBytes === 1) {
    for (let start = 0; start + rowBytes <= data.byteLength; start += rowBytes) {
      for (let i = start + spp; i < start + rowBytes; i++) {
        data[i] = (data[i] + data[i - spp]) & 0xff;
      }
    }
    return;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let start = 0; start + rowBytes <= data.byteLength; start += rowBytes) {
    for (let i = start + spp * 2; i + 1 < start + rowBytes; i += 2) {
      view.setUint16(i, (view.getUint16(i, le) + view.getUint16(i - spp * 2, le)) & 0xffff, le);
    }
  }
}

function sliceAt(bytes, off, cnt) {
  if (!(off >= 0) || off >= bytes.length) return null;
  const end = cnt > 0 ? Math.min(off + cnt, bytes.length) : bytes.length;
  return bytes.subarray(off, end);
}

function sized(data, expected) {
  if (data.length < expected) throw new Error('TIFF 数据不完整');
  if (data.length === expected) return data;
  return data.subarray(0, expected);
}

export async function decodeTiff(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8) throw new Error('TIFF 文件太小');
  const bo = bytes[0] | (bytes[1] << 8);
  if (bo !== 0x4949 && bo !== 0x4d4d) throw new Error('不是 TIFF 文件');
  const le = bo === 0x4949;
  if (dv.getUint16(2, le) !== 42) throw new Error('不支持 BigTIFF 格式');
  const tags = readTags(dv, le, dv.getUint32(4, le));

  const width = one(dv, le, tags, WIDTH, 0);
  const height = one(dv, le, tags, LENGTH, 0);
  if (!width || !height) throw new Error('TIFF 尺寸无效');
  if (width * height > 64e6) throw new Error('TIFF 尺寸过大');
  const photo = one(dv, le, tags, PHOTOMETRIC, 2);
  if (![0, 1, 2, 3].includes(photo)) {
    throw new Error(photo === 5 ? '不支持 CMYK TIFF' : `不支持的 TIFF 色彩解释 ${photo}`);
  }
  if (one(dv, le, tags, PLANAR, 1) !== 1) throw new Error('不支持分面存储（PlanarConfiguration=2）的 TIFF');
  // 缺省按规范：灰度/调色板为 1 通道，RGB 为 3 通道
  const spp = one(dv, le, tags, SPP, photo === 2 ? 3 : 1);
  if (spp < 1 || spp > 4) throw new Error(`不支持的 TIFF 通道数 ${spp}`);
  const bpsList = many(dv, le, tags, BPS);
  const bps = bpsList && bpsList.length ? bpsList[0] : 8;
  if (bps !== 8 && bps !== 16) throw new Error(`不支持的 TIFF 位深 ${bps}`);
  const sampleBytes = bps >> 3;

  const comp = one(dv, le, tags, COMPRESSION, 1);
  if (![1, 5, 8, 32946, 32773].includes(comp)) {
    throw new Error(comp === 6 || comp === 7 ? '不支持内嵌 JPEG 的 TIFF' : `不支持的 TIFF 压缩方式 ${comp}`);
  }
  const predictor = one(dv, le, tags, PREDICTOR, 1);

  let palette = null;
  if (photo === 3) {
    const cm = many(dv, le, tags, COLORMAP);
    if (!cm || cm.length < 3) throw new Error('TIFF 调色板缺失');
    const n = Math.floor(cm.length / 3);
    palette = new Uint8Array(n * 3);
    for (let i = 0; i < n * 3; i++) palette[i] = cm[i] >> 8;
  }

  const rowBytes = width * spp * sampleBytes;
  const samples = new Uint8Array(rowBytes * height);
  const decompress = async (src, expected) => {
    if (comp === 1) return sized(predictor === 2 ? src.slice() : src, expected);
    if (comp === 32773) return packBits(src, expected);
    if (comp === 5) return lzwDecode(src, expected);
    return sized(await inflate(src), expected);
  };

  const tileW = one(dv, le, tags, TILE_WIDTH, 0);
  const tileH = one(dv, le, tags, TILE_LENGTH, 0);
  if (tileW && tileH) {
    const offs = many(dv, le, tags, TILE_OFFSETS);
    const cnts = many(dv, le, tags, TILE_COUNTS) || [];
    if (!offs) throw new Error('TIFF 瓦片偏移缺失');
    const across = Math.ceil(width / tileW);
    const tileRowBytes = tileW * spp * sampleBytes;
    const expected = tileRowBytes * tileH;
    for (let t = 0; t < offs.length && t < across * Math.ceil(height / tileH); t++) {
      const src = sliceAt(bytes, offs[t], cnts[t]);
      if (!src) continue;
      const data = await decompress(src, expected);
      if (predictor === 2) undoPredictor(data, tileRowBytes, spp, sampleBytes, le);
      const tx = (t % across) * tileW;
      const ty = Math.floor(t / across) * tileH;
      const copyBytes = Math.min(tileW, width - tx) * spp * sampleBytes;
      const rows = Math.min(tileH, height - ty);
      for (let y = 0; y < rows; y++) {
        const from = y * tileRowBytes;
        samples.set(data.subarray(from, from + copyBytes), (ty + y) * rowBytes + tx * spp * sampleBytes);
      }
    }
  } else {
    const offs = many(dv, le, tags, STRIP_OFFSETS);
    const cnts = many(dv, le, tags, STRIP_COUNTS) || [];
    if (!offs) throw new Error('TIFF 条带偏移缺失');
    const rowsPerStrip = one(dv, le, tags, ROWS_PER_STRIP, 65536) || 65536;
    for (let s = 0; s < offs.length; s++) {
      const y0 = s * rowsPerStrip;
      if (y0 >= height) break;
      const rows = Math.min(rowsPerStrip, height - y0);
      const expected = rowBytes * rows;
      const src = sliceAt(bytes, offs[s], cnts[s]);
      if (!src) continue;
      const data = await decompress(src, expected);
      if (predictor === 2) undoPredictor(data, rowBytes, spp, sampleBytes, le);
      samples.set(data.subarray(0, expected), y0 * rowBytes);
    }
  }

  const readSample = (at, c) => {
    const i = at + c * sampleBytes;
    if (sampleBytes === 1) return samples[i];
    const v = le ? samples[i] | (samples[i + 1] << 8) : (samples[i] << 8) | samples[i + 1];
    return v >> 8;
  };
  const out = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const at = p * spp * sampleBytes;
    let r;
    let g;
    let b;
    let a = 255;
    if (photo === 3) {
      const idx = readSample(at, 0) * 3;
      r = palette[idx];
      g = palette[idx + 1];
      b = palette[idx + 2];
    } else if (photo === 2) {
      r = readSample(at, 0);
      g = spp > 1 ? readSample(at, 1) : r;
      b = spp > 2 ? readSample(at, 2) : r;
      if (spp === 4) a = readSample(at, 3);
    } else {
      const v = photo === 0 ? 255 - readSample(at, 0) : readSample(at, 0);
      r = v;
      g = v;
      b = v;
      if (spp === 2) a = readSample(at, 1);
    }
    out[p * 4] = r;
    out[p * 4 + 1] = g;
    out[p * 4 + 2] = b;
    out[p * 4 + 3] = a;
  }
  return { width, height, data: out };
}
