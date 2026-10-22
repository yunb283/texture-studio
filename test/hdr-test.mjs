// Node 侧验证 RGBE 解码器，分两条独立证据链：
//   1) 传输函数：手算已知向量，要求逐位精确（value = v * 2^(e-136)，e==0 记为黑）
//   2) 行框架与量化：对齐 ffmpeg 的 8 位输出（±1）
// ffmpeg 的浮点输出不能当严格期望：>1 的值被钳到 1.0，且 swscale 叠加了
// 约 13*2^-16 的误差扩散抖动（见 probe-rgbe.py / probe-hdr.py）。
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeRgbE } from '../src/js/rgbe.js';
import { quantizeFloat } from '../src/js/float-quant.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fmt', 'hdr');
const { cases } = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf-8'));

// 8 位量化用 src/js/float-quant.js 的同一份实现，浏览器/命令行走同一条代码

let fail = 0;
const times = [];
for (const c of cases) {
  const bytes = new Uint8Array(await readFile(join(dir, c.file)));
  const ef = await readFile(join(dir, c.expect));
  const expF = new Float32Array(ef.buffer.slice(ef.byteOffset, ef.byteOffset + ef.byteLength));
  const exp8 = new Uint8Array(await readFile(join(dir, c.expect8)));
  const t0 = performance.now();
  let got;
  try {
    got = decodeRgbE(bytes);
  } catch (e) {
    console.log('FAIL', c.file, '->', e.message);
    fail++;
    continue;
  }
  const ms = performance.now() - t0;
  times.push([c.file, ms]);
  const errs = [];
  if (got.width !== c.w || got.height !== c.h) {
    errs.push(`尺寸 ${got.width}x${got.height} != ${c.w}x${c.h}`);
  }
  const npx = c.w * c.h;
  if (got.channels !== 3 || got.data.length !== npx * 3) {
    errs.push(`输出应为 3 通道 ${npx * 3} 个浮点，实得 ${got.channels} 通道 ${got.data.length}`);
  } else if (expF.length !== npx * 4) {
    errs.push(`期望浮点个数 ${expF.length} != ${npx * 4}`);
  } else {
    // ffmpeg 侧：钳位后比绝对偏差，容差覆盖钳位与抖动
    let maxAbs = 0;
    let worst = -1;
    let worstRef = 0;
    let worstGot = 0;
    let beyond = 0;
    for (let p = 0; p < npx; p++) {
      for (let ch = 0; ch < 3; ch++) {
        const a = expF[p * 4 + ch]; // ffmpeg 侧是 RGBA 交错
        const b = got.data[p * 3 + ch];
        if (b > 1) beyond++;
        const d = Math.abs(Math.min(1, b) - a);
        if (d > maxAbs) {
          maxAbs = d;
          worst = p;
          worstRef = a;
          worstGot = b;
        }
      }
    }
    if (maxAbs > 1e-3) {
      errs.push(
        `钳位后浮点最大绝对偏差 ${maxAbs.toExponential(2)}（像素 ${worst} 期望 ${worstRef} 实得 ${worstGot}）`,
      );
    }
    let big = 0;
    let firstBig = -1;
    const q = quantizeFloat({ width: c.w, height: c.h, data: got.data, channels: 3 }, false);
    for (let p = 0; p < npx; p++) {
      for (let ch = 0; ch < 3; ch++) {
        const mine = q[p * 4 + ch];
        const ref = exp8[p * 3 + ch];
        if (Math.abs(mine - ref) > 1) {
          if (firstBig < 0) firstBig = p;
          big++;
        }
      }
    }
    if (big) errs.push(`8 位超出容差(±1) 的通道 ${big} 个，首个像素 #${firstBig}`);
    console.log(
      (errs.length ? 'FAIL ' : ' ok  ') + c.file.padEnd(20),
      `${c.w}x${c.h}`.padEnd(10),
      `钳位偏差=${maxAbs.toExponential(1)}`.padEnd(14),
      `>1 的通道 ${beyond}`.padEnd(12),
      `${ms.toFixed(2)}ms`,
      c.note,
    );
  }
  if (errs.length) {
    errs.forEach((e) => console.log('      ', e));
    fail++;
  }
}

// 传输函数逐位精确：w=8 但行首非 2,2，走非压缩路径
const known = [
  // [v, e, 期望线性值 = v * 2^(e-136)]
  [128, 129, 1],
  [128, 136, 128],
  [255, 128, 255 / 256],
  [1, 128, 1 / 256],
  [1, 136, 1],
  [64, 136, 64],
  [3, 128, 3 / 256],
  [200, 120, 200 / 65536],
  [255, 143, 32640],
  [7, 0, 0], // e==0 视为黑，不管 v
];
const enc = (s) => new TextEncoder().encode(s);
{
  const body = new Uint8Array(known.length * 4);
  known.forEach(([v, e], i) => body.set([v, v, v, e], i * 4));
  const buf = new Uint8Array([
    ...enc(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X ${known.length}\n`),
    ...body,
  ]);
  const got = decodeRgbE(buf);
  known.forEach(([v, e, want], i) => {
    const is = got.data[i * 3] === want && got.data[i * 3 + 1] === want && got.data[i * 3 + 2] === want;
    if (!is) {
      console.log('FAIL 已知向量', `v=${v} e=${e}`, `期望 ${want} 实得 ${got.data[i * 3]}`);
      fail++;
    } else {
      console.log(' ok  已知向量', `(${v},${e})`.padEnd(12), `= ${want}`);
    }
  });
}

const rejects = [
  ['旧式头（无 FORMAT）', new Uint8Array([1, 1, 2, 2, 0, 1, 0, 8, 0, 0, 0, 0])],
  ['缺分辨率行', enc('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n')],
  ['数据截断', enc('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4 +X 16\n\x02\x02\x00\x10')],
];
for (const [label, data] of rejects) {
  try {
    decodeRgbE(data);
    console.log('FAIL 本应拒绝：', label);
    fail++;
  } catch (e) {
    console.log(' ok  已拒绝：', label.padEnd(20), e.message);
  }
}

const slowest = times.sort((a, b) => b[1] - a[1]).slice(0, 3);
console.log(
  fail ? `\n${fail} 个用例失败` : `\n全部通过（${cases.length} 素材 + ${rejects.length} 拒绝用例）`,
  '最慢：',
  slowest.map(([n, ms]) => `${n} ${ms.toFixed(0)}ms`).join(', '),
);
