// OpenEXR 解码：扫描线（scanline）单部分文件，压缩方式 NONE / RLE / ZIPS / ZIP
// 与官方 OpenEXR 3.5.2（ILM）逐像素核对过的约定（素材与用例见 test/gen-exr.py、test/exr-test.mjs）：
//   - 魔数 0x76 0x2f 0x31 0x01，随后 1 字节版本（2）+ 1 字节 flags（bit0 tiled，bit1 longName）
//   - 属性表：名称\0 + 类型\0 + int32 长度 + 值，末尾单个 \0 结束；每个扫描线部分一张表
//   - chlist 每通道：名称\0 + int32 pixelType(0 UINT/1 HALF/2 FLOAT) + uint8 pLinear + 3 字节保留
//     + int32 xSampling + int32 ySampling，列表以空名结束；通道按名字典序存储（RGBA 图是 A,B,G,R），
//     块内数据也按该顺序排列
//   - 单部分扫描线文件确实有块偏移表：每块 1 个 uint64；块 = int32 y + uint32 数据长度 + 数据
//   - 每块行数：NONE/RLE/ZIPS 1 行，ZIP 16 行；行号取块头里的 y（DECREASING_Y 只影响块的物理顺序）
//   - 块内排列：每行 = 通道0 的整行 + 通道1 的整行 …（行外层、通道次外层、x 连续）
//   - 若块的数据长度 >= 该行原始长度，说明压缩没变小，块里存的是未过滤的原始字节
//   - RLE：计数按有符号字节读，<0 表示后面 -count 个字节照抄，>=0 表示「后一字节重复 count+1 次」
//   - ZIP/ZIPS：zlib 流（遗留写入器会在流前多 2 字节，解压失败时按偏移 2 重试），
//     解压后先做前缀和还原 b[i] = b[i-1] + b[i] - 128（首字节保留），再把奇偶两半交织回去
export async function decodeExr(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 8 || b[0] !== 0x76 || b[1] !== 0x2f || b[2] !== 0x31 || b[3] !== 0x01) {
    throw new Error('不是 OpenEXR 文件（魔数不符）');
  }
  if (b[4] !== 2) throw new Error(`EXR 版本号 ${b[4]} 暂不支持（应为 2）`);
  const flags = b[5];
  if (flags & 1) throw new Error('EXR 的分块（tiled）存储暂不支持');

  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const head = readAttrs(b, 8, !!(flags & 2));
  const attrs = new Map();
  for (const a of head.list) if (!attrs.has(a.name)) attrs.set(a.name, a);

  for (const name of ['deepFrameOffset', 'deepPixelSampleLimit']) {
    if (attrs.has(name)) throw new Error('EXR 的深度（deep）图像暂不支持');
  }
  const type = str(attrs.has('type') ? attrs.get('type').value : null);
  if (type === 'deepscanline' || type === 'deepimage') throw new Error('EXR 的深度（deep）图像暂不支持');
  if (type === 'multipart') throw new Error('EXR 的多部分（multi-part）文件暂不支持');
  if (type === 'tiledimage') throw new Error('EXR 的分块（tiled）存储暂不支持');

  const win = attrs.get('dataWindow');
  if (!win || win.value.length < 16) throw new Error('EXR 头部缺少 dataWindow 属性');
  const x0 = i32(win.value, 0);
  const y0 = i32(win.value, 4);
  const w = i32(win.value, 8) - x0 + 1;
  const h = i32(win.value, 12) - y0 + 1;
  if (w < 1 || h < 1) throw new Error(`EXR 尺寸非法：${w}x${h}`);
  if (w * h > 2 ** 27) throw new Error(`EXR 尺寸过大：${w}x${h}`);

  const ca = attrs.get('channels');
  if (!ca) throw new Error('EXR 头部缺少 channels 属性');
  if (ca.type.indexOf('deep') >= 0) throw new Error('EXR 的深度（deep）图像暂不支持');
  const chans = readChannels(ca.value);
  if (!chans.length) throw new Error('EXR 的 channels 属性为空');

  const compA = attrs.get('compression');
  const comp = compA && compA.value.length ? compA.value[0] : 0;
  if (!(comp in COMP)) throw new Error(`EXR 的压缩编号 ${comp} 未知`);
  if (comp > 3) throw new Error(`EXR 的压缩方式 ${COMP[comp]}(${comp}) 暂不支持（仅 NONE/RLE/ZIPS/ZIP）`);
  const loA = attrs.get('lineOrder');
  const lineOrder = loA && loA.value.length ? loA.value[0] : 0;
  if (lineOrder > 1) throw new Error(`EXR 的 lineOrder 值 ${lineOrder} 非法`);

  for (const c of chans) {
    if (c.type === 0) throw new Error(`EXR 的 UINT 通道（${c.name}）暂不支持`);
    if (c.type !== 1 && c.type !== 2) throw new Error(`EXR 通道 ${c.name} 的像素类型 ${c.type} 未知`);
    if (c.xs !== 1 || c.ys !== 1) {
      throw new Error(`EXR 通道 ${c.name} 的抽样比 ${c.xs}x${c.ys} 暂不支持`);
    }
  }

  const sel = pickChannels(chans.map((c) => c.name));
  const map = sel.map; // 输出 RGBA 各取哪个通道，-1 表示常量
  const linesPerChunk = comp === 3 ? 16 : 1;
  const nChunks = Math.ceil(h / linesPerChunk);

  const tableEnd = head.end;
  if (b.length < tableEnd + nChunks * 8) throw new Error('EXR 块偏移表不完整');
  const rowStride = chans.reduce((s, c) => s + w * (c.type === 2 ? 4 : 2), 0);

  const data = new Float32Array(w * h * 4);
  for (let i = 0; i < 4; i++) for (let p = i; p < data.length; p += 4) data[p] = i === 3 ? 1 : 0;

  const offs = [];
  for (let i = 0; i < nChunks; i++) {
    const o = tableEnd + i * 8;
    offs.push(dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32);
  }

  const base = channelOffsets(chans, w);
  for (let i = 0; i < nChunks; i++) {
    const o = offs[i];
    if (o + 8 > b.length) throw new Error(`EXR 第 ${i} 块 leader 越界（文件只有 ${b.length} 字节）`);
    const y = new DataView(b.buffer, b.byteOffset + o, 8).getInt32(0, true);
    const size = new DataView(b.buffer, b.byteOffset + o, 8).getUint32(4, true);
    if (o + 8 + size > b.length) throw new Error(`EXR 第 ${i} 块数据不完整：需要 ${o + 8 + size} 字节`);
    const rel = y - y0;
    if (rel < 0 || rel >= h) throw new Error(`EXR 第 ${i} 块的行号 ${y} 超出 dataWindow（${y0}..${y0 + h - 1}）`);
    const lines = Math.min(linesPerChunk, h - rel);
    const rawSize = lines * rowStride;
    const payload = b.subarray(o + 8, o + 8 + size);
    const packed = await unpackChunk(comp, payload, rawSize, i);
    writeRows(packed, chans, base, w, lines, rel, map, data);
  }

  return { width: w, height: h, channels: 4, data };
}

const COMP = { 0: 'NONE', 1: 'RLE', 2: 'ZIPS', 3: 'ZIP', 4: 'PIZ', 5: 'PXR24', 6: 'B44', 7: 'B44A', 8: 'DWAA', 9: 'DWAB' };

// ---- 头部 ----
function readAttrs(b, pos, longName) {
  const out = [];
  let i = pos;
  while (true) {
    if (i >= b.length) throw new Error('EXR 头部属性不完整');
    if (b[i] === 0) return { list: out, end: i + 1 };
    const name = cstr(b, i);
    i = name.next;
    const tp = cstr(b, i);
    i = tp.next;
    if (i + 4 > b.length) throw new Error('EXR 属性长度越界');
    const size = i32(b, i);
    i += 4;
    if (size < 0 || i + size > b.length) throw new Error(`EXR 属性 ${name.str} 的值越界`);
    if (!longName && name.str.length > 255) throw new Error(`EXR 属性名过长：${name.str}`);
    out.push({ name: name.str, type: tp.str, value: b.subarray(i, i + size) });
    i += size;
  }
}

function cstr(b, i) {
  const s = i;
  while (i < b.length && b[i] !== 0) i++;
  if (i >= b.length) throw new Error('EXR 头部字符串没有结束符');
  return { str: latin1(b, s, i), next: i + 1 };
}

function latin1(b, s, e) {
  let s2 = '';
  for (let i = s; i < e; i++) s2 += String.fromCharCode(b[i]);
  return s2;
}

function str(v) {
  return v ? latin1(v, 0, v.length).replace(/\u0000+$/, '') : null;
}

function i32(b, o) {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
}

function readChannels(val) {
  const out = [];
  let i = 0;
  while (i < val.length) {
    if (val[i] === 0) break;
    const nm = cstr(val, i);
    i = nm.next;
    if (i + 16 > val.length) throw new Error('EXR chlist 不完整');
    const type = i32(val, i);
    const xs = i32(val, i + 8);
    const ys = i32(val, i + 12);
    i += 16;
    out.push({ name: nm.str, type, xs, ys });
  }
  return out;
}

// 通道基址：块内第 r 行的偏移 = r*rowStride + base[channel]
function channelOffsets(chans, w) {
  const base = [];
  let acc = 0;
  for (let c = 0; c < chans.length; c++) {
    base[c] = acc;
    acc += w * sampleBytes(chans[c]);
  }
  return base;
}

function sampleBytes(c) {
  return c.type === 2 ? 4 : 2;
}

// R/G/B/A 归位；只有 Y/L 单通道时按灰度复制
function pickChannels(names) {
  const up = names.map((n) => n.toUpperCase());
  const idx = (k) => up.indexOf(k);
  const r = idx('R');
  const g = idx('G');
  const bl = idx('B');
  if (r >= 0 && g >= 0 && bl >= 0) {
    const a = idx('A');
    return { map: [r, g, bl, a] };
  }
  if (names.length === 1 && ['Y', 'L', 'LUMINANCE'].includes(up[0])) {
    return { map: [0, 0, 0, -1] };
  }
  throw new Error(`EXR 通道 ${names.join('、')} 无法映射为 RGB`);
}

// ---- 块数据 ----
async function unpackChunk(comp, payload, rawSize, index) {
  if (comp === 0 || payload.length >= rawSize) return payload; // 未压缩 / 压缩没变小
  if (comp === 1) {
    const t = rleDecode(payload, rawSize, index);
    return defilter(t);
  }
  let raw = null;
  try {
    raw = await inflate(payload, 0);
  } catch (e1) {
    try {
      raw = await inflate(payload, 2); // 遗留写入器在 zlib 流前多写 2 字节
    } catch (e2) {
      throw new Error(`EXR 第 ${index} 块 zlib 解压失败（数据不完整或不是 deflate 流）`);
    }
  }
  if (raw.length !== rawSize) {
    throw new Error(`EXR 第 ${index} 块解压出 ${raw.length} 字节，应为 ${rawSize}`);
  }
  return defilter(raw);
}

function rleDecode(src, want, index) {
  const out = new Uint8Array(want);
  let i = 0;
  let n = 0;
  while (i < src.length) {
    const c = src[i++] << 0;
    if (c >= 128) {
      const run = 256 - c; // 有符号负数：照抄 run 个字节
      if (i + run > src.length) throw new Error(`EXR 第 ${index} 块 RLE 数据不完整`);
      if (n + run > want) throw new Error(`EXR 第 ${index} 块 RLE 解出的长度超出预期`);
      out.set(src.subarray(i, i + run), n);
      i += run;
      n += run;
    } else {
      if (i >= src.length) throw new Error(`EXR 第 ${index} 块 RLE 数据不完整`);
      const run = c + 1;
      if (n + run > want) throw new Error(`EXR 第 ${index} 块 RLE 解出的长度超出预期`);
      out.fill(src[i], n, n + run);
      i += 1;
      n += run;
    }
  }
  if (n !== want) throw new Error(`EXR 第 ${index} 块 RLE 解出 ${n} 字节，应为 ${want}`);
  return out;
}

// 撤销 ZIP/RLE 的字节过滤：前缀和（偏移 128）+ 奇偶两半重新交织
function defilter(t) {
  const n = t.length;
  const acc = new Uint8Array(n);
  let p = t[0];
  acc[0] = p;
  for (let i = 1; i < n; i++) {
    p = (p + t[i] - 128) & 0xff;
    acc[i] = p;
  }
  const half = (n + 1) >> 1;
  const out = new Uint8Array(n);
  for (let k = 0; k < half; k++) {
    out[2 * k] = acc[k];
    if (2 * k + 1 < n) out[2 * k + 1] = acc[half + k];
  }
  return out;
}

let HALF = null;
function halfTable() {
  if (HALF) return HALF;
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    let v;
    if (e === 0) v = m * 2 ** -24;
    else if (e === 31) v = m === 0 ? Infinity : NaN;
    else v = (1 + m / 1024) * 2 ** (e - 15);
    t[h] = h & 0x8000 ? -v : v;
  }
  HALF = t;
  return t;
}

function writeRows(packed, chans, base, w, lines, row0, map, data) {
  let view = packed;
  if (view.byteOffset % 4 !== 0) {
    const copy = new Uint8Array(view.length);
    copy.set(view);
    view = copy;
  }
  const dv2 = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const ht = halfTable();
  const rowStride = chans.reduce((s, c) => s + w * sampleBytes(c), 0);
  for (let r = 0; r < lines; r++) {
    const y = row0 + r;
    const lineBase = r * rowStride;
    for (let k = 0; k < 3; k++) {
      const ci = map[k];
      fillChannel(view, dv2, ht, lineBase + base[ci], sampleBytes(chans[ci]), w, y * w * 4 + k, data);
    }
    if (map[3] >= 0) {
      const ci = map[3];
      fillChannel(view, dv2, ht, lineBase + base[ci], sampleBytes(chans[ci]), w, y * w * 4 + 3, data);
    } else {
      for (let x = 0; x < w; x++) data[(y * w + x) * 4 + 3] = 1;
    }
  }
}

// 把一行的某个通道写进交织输出的第 ch 位
function fillChannel(view, dv, ht, off, sb, w, outIdx, data) {
  const bytes = view.byteOffset + off;
  if (sb === 4) {
    if (bytes % 4 === 0) {
      const src = new Float32Array(view.buffer, bytes, w);
      for (let x = 0; x < w; x++) data[outIdx + x * 4] = src[x];
    } else {
      for (let x = 0; x < w; x++) data[outIdx + x * 4] = dv.getFloat32(off + 4 * x, true);
    }
  } else {
    const src = new Uint16Array(view.buffer, bytes, w);
    for (let x = 0; x < w; x++) data[outIdx + x * 4] = ht[src[x]];
  }
}

async function inflate(payload, skip) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([payload.subarray(skip)]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
