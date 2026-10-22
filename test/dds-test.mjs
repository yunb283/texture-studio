// Node 侧验证 DDS 解码器：期望字节取自 Pillow（见 gen-dds.py）
// Pillow 不认的 DX10 B8G8R8A8 用 same_as 与已验证的遗留 BGRA 掩码素材交叉比对
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeDds } from '../src/js/dds.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fmt', 'dds');
const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf-8'));
const cache = new Map();

async function load(f) {
  if (!cache.has(f)) cache.set(f, new Uint8Array(await readFile(join(dir, f))));
  return cache.get(f);
}

function firstDiff(got, expect, w) {
  if (got.length !== expect.length) return `字节数 ${got.length} != ${expect.length}`;
  for (let i = 0; i < expect.length; i++) {
    if (expect[i] !== got[i]) {
      const p = Math.floor(i / 4);
      return (
        `#${i} 像素 ${p}(${p % w},${Math.floor(p / w)}) 期望 ` +
        `${Array.from(expect.slice(i, i + 4))} 实得 ${Array.from(got.slice(i, i + 4))}`
      );
    }
  }
  return null;
}

let fail = 0;
const times = [];
for (const c of manifest.cases) {
  const bytes = await load(c.file);
  const t0 = performance.now();
  let got;
  try {
    got = decodeDds(bytes);
  } catch (e) {
    console.log('FAIL', c.file, '->', e.message);
    fail++;
    continue;
  }
  times.push([c.file, performance.now() - t0]);
  let errs = [];
  if (got.width !== c.w || got.height !== c.h) {
    errs = [`尺寸 ${got.width}x${got.height} != ${c.w}x${c.h}`];
  } else {
    const expect = c.expect
      ? new Uint8Array(await readFile(join(dir, c.expect)))
      : decodeDds(await load(c.same_as)).data;
    const d = firstDiff(got.data, expect, c.w);
    if (d) errs = [d];
  }
  if (errs.length) {
    console.log('FAIL', c.file, errs.join('；'));
    fail++;
  } else {
    console.log(
      ' ok ',
      c.file.padEnd(24),
      `${c.w}x${c.h}`.padEnd(8),
      c.expect ? 'Pillow' : `同 ${c.same_as}`,
      c.note,
    );
  }
}

// 构造头部用的最小 DDS：只要 magic + dwSize=124 + 宽高 + 像素格式
function ddsHead(over = {}) {
  const b = new Uint8Array(over.dx10 ? 148 : 128);
  const dv = new DataView(b.buffer);
  b.set([0x44, 0x44, 0x53, 0x20], 0);
  const put = (o, v) => dv.setUint32(o, v >>> 0, true);
  put(4, 124);
  put(8, over.flags ?? 0x102f);
  put(12, over.h ?? 4);
  put(16, over.w ?? 4);
  put(20, over.pitch ?? 0);
  put(24, over.depth ?? 1);
  put(76, 32);
  put(80, over.pfFlags ?? 0x40);
  b.set(over.fourCC ? [...over.fourCC].map((ch) => ch.charCodeAt(0)) : [0, 0, 0, 0], 84);
  put(88, over.bitCount ?? 32);
  [over.r ?? 0xff0000, over.g ?? 0xff00, over.b ?? 0xff, over.a ?? 0xff000000].forEach(
    (m, i) => put(92 + 4 * i, m),
  );
  put(108, over.caps ?? 0x1000);
  put(112, over.caps2 ?? 0);
  if (over.dx10) {
    put(128, over.dx10);
    put(132, over.dim ?? 3);
    put(140, 1);
  }
  return b;
}

const rejects = [
  ['非 DDS 文件', new Uint8Array(140)],
  ['头长度不是 124', (() => { const b = ddsHead(); b[4] = 120; return b; })()],
  ['BC7（DX10 98）', ddsHead({ fourCC: 'DX10', dx10: 98 })],
  ['BC6H（DX10 95）', ddsHead({ fourCC: 'DX10', dx10: 95 })],
  ['DX10 16 位半浮点（34）', ddsHead({ fourCC: 'DX10', dx10: 34 })],
  ['DX10 体积纹理', ddsHead({ fourCC: 'DX10', dx10: 71, dim: 4 })],
  ['遗留 DXT2', ddsHead({ pfFlags: 0x4, fourCC: 'DXT2' })],
  ['遗留 BC4S 有符号', ddsHead({ pfFlags: 0x4, fourCC: 'BC4S' })],
  ['PAL8 调色板', ddsHead({ pfFlags: 0x20 })],
  ['仅 alpha 通道', ddsHead({ pfFlags: 0x2, bitCount: 8 })],
  ['体积纹理（dwDepth 2）', ddsHead({ depth: 2 })],
  ['亮度格式位深 5', ddsHead({ pfFlags: 0x20000, bitCount: 5 })],
  ['未压缩 64 位样本', ddsHead({ bitCount: 64 })],
  ['像素格式标记全 0', ddsHead({ pfFlags: 0 })],
  ['BC1 块数据截断', (() => { const b = ddsHead({ pfFlags: 0x4, fourCC: 'DXT1' }); return b; })()],
];
for (const [label, data] of rejects) {
  try {
    decodeDds(data);
    console.log('FAIL 本应拒绝：', label);
    fail++;
  } catch (e) {
    console.log(' ok  已拒绝：', label.padEnd(24), e.message);
  }
}

const slowest = times.sort((a, b) => b[1] - a[1]).slice(0, 3);
console.log(
  fail ? `\n${fail} 个用例失败` : `\n全部通过（${manifest.cases.length} 素材 + ${rejects.length} 拒绝用例）`,
  '最慢：',
  slowest.map(([n, ms]) => `${n} ${ms.toFixed(1)}ms`).join(', '),
);
