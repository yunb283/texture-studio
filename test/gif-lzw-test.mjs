// 隔离验证 LZW 层：直接调 gif.js 的 lzwEncode，套一个最小 GIF 容器，
// 再用 PIL 解码回索引，逐像素比对。这样把码表加宽时机、4096 满表 clear、
// code === next（KwKwK）这些容易错的分支单独钉死，不受量化误差干扰。
// 配套：python gif-lzw-verify.py
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lzwEncode } from '../src/js/gif.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fmt', 'giflzw');
let fails = 0;
const bad = (m) => { fails++; console.log('  FAIL ' + m); };
const good = (m) => console.log('  ok   ' + m);

function mulberry(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 造一批索引流：覆盖每种位深的宽度边界（首次 clear 后重新填满）与连续同值 run
const streams = [];
for (let m = 2; m <= 8; m++) {
  const k = 1 << m;
  streams.push({ name: `seq_m${m}`, m, data: seq(k, m * 800) });
  streams.push({ name: `rand_m${m}`, m, data: rand(k, 1200 + 4200 * (m - 2)) });
  streams.push({ name: `runs_m${m}`, m, data: runs(k, 3000) });
}
// 位深固定但像素量递增，逐个跨过 9/10/11/12 位边界
for (const n of [400, 520, 1030, 2060, 4100, 4200]) {
  streams.push({ name: `edge_n${n}`, m: 8, data: rand(256, n) });
}

function seq(k, n) {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = i % k;
  return a;
}
function rand(k, n) {
  const r = mulberry(k * 7919 + n);
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.floor(r() * k);
  return a;
}
function runs(k, n) {
  const r = mulberry(k * 104729 + n);
  const a = new Uint8Array(n);
  let i = 0;
  let v = 0;
  while (i < n) {
    const len = 1 + Math.floor(r() * 40);
    v = (v + 1 + Math.floor(r() * (k - 1))) % k;
    a.fill(v, i, Math.min(n, i + len));
    i += len;
  }
  return a;
}

export function frameOf(m, src) {
  const k = 1 << m;
  const w = Math.min(k, Math.ceil(Math.sqrt(src.length)));
  // 行数向上取整 → 索引流补到整行，保证解出的像素数和期望严格相等
  const h = Math.ceil(src.length / w);
  const indices = new Uint8Array(w * h);
  indices.set(src);
  return { w, h, indices };
}

// 最小 GIF89a：单帧、恒等灰阶调色板（索引 i 的 RGB 为 i,i,i）、无透明、无循环。
// table='gct' 把调色板放在逻辑屏幕描述符里，table='lct' 放在图像描述符里，
// 两份文件的 LZW 负载完全相同，用来隔离「局部调色板框架」这一种差异。
function minimalGif(m, fr, table) {
  const { w, h, indices } = fr;
  const k = 1 << m;
  const a = [];
  const byte = (...v) => {
    for (const x of v) a.push(x & 0xff);
  };
  const u16 = (v) => a.push(v & 0xff, (v >> 8) & 0xff);
  // 屏幕描述符：bit6-4 是色深、bit3 排序；图像描述符：bit6 隔行、bit5 排序。两处字段含义不同。
  const packedScreen = 0x80 | (m - 1) << 4 | (m - 1);
  const packedImage = 0x80 | (m - 1);
  byte(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
  u16(w);
  u16(h);
  byte(table === 'gct' ? packedScreen : 0, 0, 0);
  if (table === 'gct') for (let i = 0; i < k; i++) byte(i, i, i);
  byte(0x21, 0xf9, 0x04, 0x04, 10, 0, 0, 0);
  byte(0x2c);
  u16(0);
  u16(0);
  u16(w);
  u16(h);
  byte(table === 'lct' ? packedImage : 0);
  if (table === 'lct') for (let i = 0; i < k; i++) byte(i, i, i);
  const lzw = lzwEncode(m, indices);
  byte(m);
  for (let p = 0; p < lzw.length; p += 255) {
    const n = Math.min(255, lzw.length - p);
    byte(n);
    for (let i = 0; i < n; i++) a.push(lzw[p + i]);
  }
  byte(0);
  byte(0x3b);
  return Uint8Array.from(a);
}

try {
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });
} catch {}

const cases = [];
for (const s of streams) {
  const fr = frameOf(s.m, s.data);
  for (const table of ['gct', 'lct']) {
    await writeFile(join(dir, `${s.name}_${table}.gif`), minimalGif(s.m, fr, table));
    cases.push({ name: `${s.name}_${table}`, m: s.m, n: fr.indices.length, w: fr.w, h: fr.h });
  }
  await writeFile(join(dir, `${s.name}.exp.bin`), fr.indices);
}
await writeFile(join(dir, 'manifest.json'), JSON.stringify({ cases }, null, 2));
console.log(`生成 ${cases.length} 个 LZW 闭环用例 → ${dir}`);
