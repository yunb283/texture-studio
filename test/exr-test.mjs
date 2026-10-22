// Node 侧验证 OpenEXR 解码器：逐个素材与官方 ILM 期望值比对，外加拒绝用例；
// 素材带 expect8 时再把 ILM 浮点走一遍量化函数，对齐 ffmpeg 的 8 位 rgba PNG 输出
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeExr } from '../src/js/exr.js';
import { quantizeFloat } from '../src/js/float-quant.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fmt', 'exr');
const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf-8'));

const load = (f) => readFile(join(dir, f));

function compare(got, exp, w, h) {
  const errs = [];
  if (got.width !== w || got.height !== h) errs.push(`尺寸 ${got.width}x${got.height} != ${w}x${h}`);
  if (got.channels !== 4) errs.push(`通道数 ${got.channels} != 4`);
  if (got.data.length !== exp.length) errs.push(`浮点数 ${got.data.length} != ${exp.length}`);
  else {
    let worst = 0;
    let at = -1;
    for (let i = 0; i < exp.length; i++) {
      const a = got.data[i];
      const b = exp[i];
      const d = Number.isNaN(a) || Number.isNaN(b) ? Infinity : Math.abs(a - b);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > 1e-6) {
      const p = Math.floor(at / 4);
      errs.push(
        `最大差 ${worst.toExponential(2)} @像素 ${p % w},${Math.floor(p / w)} 期望 ` +
          `${Array.from(exp.slice(at, at + 4)).map((v) => +v.toFixed(5))} 实得 ` +
          `${Array.from(got.data.slice(at, at + 4)).map((v) => +v.toFixed(5))}`,
      );
    }
  }
  return errs;
}

// 8 位口径：把 ILM 的参考浮点喂给我们的量化函数，再对齐 ffmpeg 的 rgba PNG 输出。
// ffmpeg 的 swscale 带误差扩散抖动：小图上是 ±1，1024x768 上能累积到 ±2（量化规则本身
// 错了会差出几十到 255，比如漏乘 255 时 0.469 -> 0）
const TOL8 = 2;

function compare8(exp, ref8, w, h) {
  const errs = [];
  const q = quantizeFloat({ width: w, height: h, data: exp, channels: 4 }, false);
  if (q.length !== ref8.length) {
    errs.push(`8 位字节数 ${q.length} != ${ref8.length}`);
    return { errs, eq: 0, dmax: 0, over: 0 };
  }
  let eq = 0;
  let over = 0;
  let dmax = 0;
  let at = -1;
  for (let i = 0; i < q.length; i++) {
    const d = Math.abs(q[i] - ref8[i]);
    if (d === 0) eq++;
    if (d > dmax) {
      dmax = d;
      at = i;
    }
    if (d > TOL8) over++;
  }
  if (over) {
    const p = Math.floor(at / 4);
    errs.push(
      `8 位有 ${over} 处超出 ±${TOL8}，最大差 ${dmax} @${p % w},${Math.floor(p / w)} ` +
        `浮点 ${Array.from(exp.slice(p * 4, p * 4 + 4)).map((v) => +v.toFixed(5))} ` +
        `实得 ${Array.from(q.slice(at & ~3, (at & ~3) + 4))} 参考 ${Array.from(ref8.slice(at & ~3, (at & ~3) + 4))}`,
    );
  }
  return { errs, eq, total: q.length, dmax, over };
}

let fail = 0;
let slow = [0, ''];
for (const c of manifest.cases) {
  const bytes = await load(c.file);
  const exp = new Float32Array((await load(c.expect)).buffer);
  const t0 = performance.now();
  let got;
  try {
    got = await decodeExr(bytes);
  } catch (e) {
    console.log('FAIL', c.file, '->', e.message);
    fail++;
    continue;
  }
  const ms = performance.now() - t0;
  if (ms > slow[0]) slow = [ms, c.file];
  const errs = compare(got, exp, c.w, c.h);
  let q8 = null;
  if (c.expect8) {
    const ref8 = new Uint8Array(await load(c.expect8));
    q8 = compare8(exp, ref8, c.w, c.h);
    errs.push(...q8.errs);
  }
  if (errs.length) {
    console.log('FAIL', c.file, errs.join('；'));
    fail++;
  } else {
    const ref = c.reference ? ` [${c.reference}]` : '';
    console.log(
      ' ok ',
      c.file.padEnd(24),
      `${c.w}x${c.h}`.padEnd(9),
      c.note.padEnd(26),
      `${ms.toFixed(1)}ms${ref}`,
      q8 ? `| 8位逐字节精确 ${q8.eq}/${q8.total} 最大差 ${q8.dmax}` : '',
    );
  }
}

// ---------- 兼容旧写入器：zlib 流前多 2 字节 ----------
for (const name of ['e_zip1_f_rgb.exr', 'e_zip16_f_rgb.exr', 'e_zip16_decr_f_1k.exr']) {
  const src = manifest.cases.find((c) => c.file === name);
  const bytes = await load(name);
  const patched = addLegacyShift(bytes, 0);
  let got;
  try {
    got = await decodeExr(patched);
  } catch (e) {
    console.log('FAIL 旧式 2 字节前缀', name, '->', e.message);
    fail++;
    continue;
  }
  const exp = new Float32Array((await load(src.expect)).buffer);
  const errs = compare(got, exp, src.w, src.h);
  if (errs.length) {
    console.log('FAIL 旧式 2 字节前缀', name, errs.join('；'));
    fail++;
  } else {
    console.log(' ok  旧式 2 字节前缀', name);
  }
}

// ---------- 头部构造（拒绝用例用） ----------
const enc = (s) => new TextEncoder().encode(s);

function chlist(chans) {
  const parts = [];
  for (const [name, type, xs = 1, ys = 1] of chans) {
    const head = new Uint8Array(16);
    const dv = new DataView(head.buffer);
    dv.setInt32(0, type, true);
    dv.setInt32(8, xs, true);
    dv.setInt32(12, ys, true);
    parts.push(enc(name), new Uint8Array([0]), head);
  }
  parts.push(new Uint8Array([0]));
  return concat(parts);
}

function attr(name, type, value) {
  return concat([enc(name), new Uint8Array([0]), enc(type), new Uint8Array([0]), i32(value.length), value]);
}

function box(x0, y0, x1, y1) {
  const a = new Uint8Array(16);
  const dv = new DataView(a.buffer);
  dv.setInt32(0, x0, true);
  dv.setInt32(4, y0, true);
  dv.setInt32(8, x1, true);
  dv.setInt32(12, y1, true);
  return a;
}

function i32(v) {
  const a = new Uint8Array(4);
  new DataView(a.buffer).setInt32(0, v, true);
  return a;
}

function u64(v) {
  const a = new Uint8Array(8);
  const dv = new DataView(a.buffer);
  dv.setUint32(0, v % 2 ** 32, true);
  dv.setUint32(4, Math.floor(v / 2 ** 32), true);
  return a;
}

function one(v) {
  return new Uint8Array([v]);
}

function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// 造一个只到块偏移表的合法头；chunks 是 [{y, body}]
function exr(over = {}) {
  const w = over.w ?? 4;
  const h = over.h ?? 2;
  const chans = over.chans || [['B', 2], ['G', 2], ['R', 2]];
  const parts = [new Uint8Array([0x76, 0x2f, 0x31, 0x01]), one(over.version ?? 2), one(over.flags ?? 0), new Uint8Array(2)];
  if (over.windows !== false) parts.push(attr('dataWindow', 'box2i', box(0, 0, w - 1, h - 1)));
  if (over.chans !== false && over.windows !== 'nochan') parts.push(attr('channels', over.chanType || 'chlist', chlist(chans)));
  if (over.comp !== 'none') parts.push(attr('compression', 'compression', one(over.comp ?? 0)));
  if (over.lo !== 'none') parts.push(attr('lineOrder', 'lineOrder', one(over.lo ?? 0)));
  for (const a of over.extra || []) parts.push(a);
  parts.push(new Uint8Array([0]));
  const head = concat(parts);
  const chunks = over.chunks || [];
  if (!chunks.length) return head;
  const n = chunks.length;
  const table = new Uint8Array(n * 8);
  let pos = head.length + n * 8;
  const bodies = [];
  for (const [y, body] of chunks) {
    table.set(u64(pos), bodies.length * 8);
    const piece = concat([i32(y), i32(body.length), body]);
    bodies.push(piece);
    pos += piece.length;
  }
  return concat([head, table, concat(bodies)]);
}

// 给某个块的 zlib 流前面加上遗留写入器的 2 字节长度前缀，并重建块偏移表
function addLegacyShift(bytes, chunkIndex) {
  const dv0 = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dv = dv0;
  const { end, n } = tableInfo(bytes, dv);
  const offs = offsets(dv, end, n);
  const o = offs[chunkIndex];
  const y = dv.getInt32(o, true);
  const size = dv.getUint32(o + 4, true);
  const body = bytes.subarray(o + 8, o + 8 + size);
  const pieces = [];
  for (let i = 0; i < n; i++) {
    const co = offs[i];
    const cy = dv.getInt32(co, true);
    const cs = dv.getUint32(co + 4, true);
    let cb = bytes.subarray(co + 8, co + 8 + cs);
    if (i === chunkIndex) cb = concat([i32(cy).subarray(0, 2), cb]);
    pieces.push(concat([i32(cy), i32(cb.length), cb]));
  }
  const head = bytes.subarray(0, end);
  const data = concat(pieces);
  const table = new Uint8Array(n * 8);
  let pos = head.length + n * 8;
  for (let i = 0; i < n; i++) {
    table.set(u64(pos), i * 8);
    const co = offs[i];
    const cs = dv.getUint32(co + 4, true) + (i === chunkIndex ? 2 : 0);
    pos += 8 + cs;
  }
  return concat([head, table, data]);
}

function tableInfo(bytes, dv) {
  let i = 8;
  while (bytes[i] !== 0) {
    const j = bytes.indexOf(0, i);
    const k = bytes.indexOf(0, j + 1);
    const size = dv.getInt32(k + 1, true);
    i = k + 5 + size;
  }
  const end = i + 1;
  const win = attrValue(bytes, dv, 'dataWindow');
  const h = dv.getInt32(win + 12, true) - dv.getInt32(win + 4, true) + 1;
  const comp = bytes[attrValue(bytes, dv, 'compression')];
  return { end, n: Math.ceil(h / (comp === 3 ? 16 : 1)) };
}

function attrValue(bytes, dv, name) {
  let i = 8;
  while (bytes[i] !== 0) {
    const j = bytes.indexOf(0, i);
    const nm = new TextDecoder().decode(bytes.subarray(i, j));
    const k = bytes.indexOf(0, j + 1);
    const size = dv.getInt32(k + 1, true);
    if (nm === name) return k + 5;
    i = k + 5 + size;
  }
  throw new Error('缺属性 ' + name);
}

function offsets(dv, end, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(dv.getUint32(end + i * 8, true) + dv.getUint32(end + i * 8 + 4, true) * 2 ** 32);
  return out;
}

const cases = [
  ['非 EXR 文件', new Uint8Array(enc('BM........'))],
  ['版本号 3', exr({ version: 3 })],
  ['tiled 标志', exr({ flags: 1 })],
  ['type=multipart', exr({ extra: [attr('type', 'string', concat([enc('multipart'), new Uint8Array([0])]))] })],
  ['type=deepscanline', exr({ extra: [attr('type', 'string', concat([enc('deepscanline'), new Uint8Array([0])]))] })],
  ['deep 属性', exr({ extra: [attr('deepFrameOffset', 'deepframeoffset', i32(1))] })],
  ['PIZ 压缩', exr({ comp: 4 })],
  ['DWAA 压缩', exr({ comp: 8 })],
  ['未知压缩编号', exr({ comp: 10 })],
  ['UINT 通道', exr({ chans: [['B', 0], ['G', 0], ['R', 0]] })],
  ['未知像素类型', exr({ chans: [['B', 7], ['G', 7], ['R', 7]] })],
  ['通道抽样 2x1', exr({ chans: [['B', 2, 2, 1], ['G', 2, 2, 1], ['R', 2, 2, 1]] })],
  ['通道无法映射', exr({ chans: [['X', 2], ['Y', 2], ['Z', 2]] })],
  ['缺 dataWindow', exr({ windows: false })],
  ['缺 channels', exr({ chans: false })],
  ['空 chlist', exr({ chans: [] })],
  ['lineOrder=2', exr({ lo: 2 })],
  ['属性表没有结束符', concat([new Uint8Array([0x76, 0x2f, 0x31, 0x01]), one(2), one(0), new Uint8Array(2), enc('dataWindow')])],
  ['尺寸非法', exr({ w: 0, h: 2 })],
];

for (const [label, bytes] of cases) {
  try {
    await decodeExr(bytes);
    console.log('FAIL 本应拒绝：', label);
    fail++;
  } catch (e) {
    console.log(' ok  已拒绝：', label.padEnd(20), e.message);
  }
}

// 基于真实素材的损坏用例
const realZip = await load('e_zip1_f_rgb.exr');
const realNone = await load('e_none_f_rgb.exr');
const dvNone = new DataView(realNone.buffer, realNone.byteOffset, realNone.byteLength);
const infoNone = tableInfo(realNone, dvNone);
const offNone = offsets(dvNone, infoNone.end, infoNone.n);

const corrupt = [
  ['块偏移表截断', realNone.subarray(0, infoNone.end + 8)],
  ['块 leader 越界', (() => {
    const b = Uint8Array.from(realNone);
    new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(infoNone.end, 99999, true); // 偏移表首项指向文件外
    return b;
  })()],
  ['块数据长度夸大', (() => {
    const b = Uint8Array.from(realNone);
    new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(offNone[0] + 4, 100000, true);
    return b;
  })()],
  ['块行号越界', (() => {
    const b = Uint8Array.from(realNone);
    new DataView(b.buffer, b.byteOffset, b.byteLength).setInt32(offNone[0], 99, true);
    return b;
  })()],
  ['ZIP 块解压长度不符', async () => {
    const b = await load('e_zip16_f_rgb.exr');   // dataWindow 说 21 行，块里只有 17 行
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const win = attrValue(b, dv, 'dataWindow');
    dv.setInt32(win + 12, 20, true);
    return b;
  }],
  ['ZIP 流无法解压', (() => {
    const dv = new DataView(realZip.buffer, realZip.byteOffset, realZip.byteLength);
    const info = tableInfo(realZip, dv);
    const o = offsets(dv, info.end, info.n)[0];
    const size = dv.getUint32(o + 4, true);
    return concat([realZip.subarray(0, o + 8), new Uint8Array(size)]);
  })()],
  ['RLE 解出长度不符', exr({
    w: 1,
    h: 1,
    chans: [['Y', 2]],
    comp: 1,
    chunks: [[0, new Uint8Array([1, 0])]],
  })],
  ['RLE 游程越界', exr({
    w: 1,
    h: 1,
    chans: [['Y', 2]],
    comp: 1,
    chunks: [[0, new Uint8Array([0x80])]],
  })],
];

for (const [label, spec] of corrupt) {
  // 构造失败要直接抛出，否则会被当成「已拒绝」而假通过
  const bytes = typeof spec === 'function' ? await spec() : spec;
  try {
    await decodeExr(bytes);
    console.log('FAIL 本应拒绝：', label);
    fail++;
  } catch (e) {
    console.log(' ok  已拒绝：', label.padEnd(20), e.message);
  }
}

// ---------- 拉伸与非法值的自有口径（无外部参考，只锁行为） ----------
let quantCases = 0;
{
  const mk = (data) => ({ width: 2, height: 1, channels: 4, data: new Float32Array(data) });
  const cases8 = [
    ['默认线性裁剪', quantizeFloat(mk([0, 0.502, 1.5, -0.25, 1, 4, 0.002, 2]), false),
      [0, 128, 255, 0, 255, 255, 1, 255]],
    ['按最大值拉伸，alpha 不跟着拉', quantizeFloat(mk([0, 0.502, 1.5, -0.25, 1, 4, 0.002, 2]), true),
      [0, 32, 96, 0, 64, 255, 0, 255]],
    ['NaN/Inf 不污染拉伸上限', quantizeFloat(mk([NaN, Infinity, -Infinity, NaN, 0.5, 0, 0, 1]), true),
      [0, 255, 0, 0, 255, 0, 0, 255]],
    ['全黑不拉伸也不炸', quantizeFloat(mk([0, 0, 0, 1, 0, 0, 0, 1]), true),
      [0, 0, 0, 255, 0, 0, 0, 255]],
  ];
  quantCases = cases8.length;
  for (const [label, got, want] of cases8) {
    const bad = want.findIndex((v, i) => v !== got[i]);
    if (bad >= 0) {
      console.log('FAIL 量化：', label, `第 ${bad} 个字节 ${got[bad]} != ${want[bad]}`);
      fail++;
    } else {
      console.log(' ok  量化：', label);
    }
  }
}

console.log(
  fail
    ? `\n${fail} 个用例失败`
    : `\n全部通过（${manifest.cases.length} 素材 + 旧式前缀 3 + 拒绝 ${cases.length + corrupt.length} + 量化 ${quantCases}） 最慢： ${slow[1]} ${slow[0].toFixed(1)}ms`,
);
