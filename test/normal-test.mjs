// 验证「贴图转法线」：两条独立证据链
//   1) 与 test/gen-normal.py 的 numpy 独立实现逐字节比对（42 组参数）
//   2) 解析式不变量：平图、线性斜坡、DX/OG 镜像、反转镜像、模糊压梯度、单位向量、按通道取值
// 两份实现各写各的（滑动窗口 vs pad+切片），抓到的是编码错误；取整口径两边都是 floor(x+0.5)，
// 但浮点求和顺序不同，恰好压在 .5 边界上会差 1，所以按 ±1 容差并要求超出即失败。
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heightToNormal, NORMAL_SOURCES } from '../src/js/normal.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fmt', 'normal');
const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf-8'));
const load = async (f) => new Uint8Array(await readFile(join(dir, f)));

let fail = 0;
const bad = (msg) => {
  console.log('FAIL', msg);
  fail++;
};
const good = (msg) => console.log(' ok  ', msg);

// ---------- 1. 与 numpy 交叉比对 ----------
let runs = 0;
let slow = [0, ''];
for (const c of manifest.cases) {
  const data = await load(c.input);
  const img = { width: c.w, height: c.h, data };
  for (const r of c.runs) {
    // manifest 里的参数名是 Python 风格（y_up），映射到 JS 侧的 camelCase
    const { y_up, ...rest } = r.args;
    const opts = { ...rest, yUp: y_up !== false };
    const t0 = performance.now();
    const got = heightToNormal(img, opts);
    const ms = performance.now() - t0;
    if (ms > slow[0]) slow = [ms, `${c.file} ${JSON.stringify(r.args)}`];
    const exp = await load(r.expect);
    let dmax = 0;
    let eq = 0;
    let over = 0;
    let at = -1;
    for (let i = 0; i < exp.length; i++) {
      const d = Math.abs(got[i] - exp[i]);
      if (d === 0) eq++;
      if (d > dmax) {
        dmax = d;
        at = i;
      }
      if (d > 1) over++;
    }
    runs++;
    const argTxt = JSON.stringify(r.args);
    if (over) {
      const p = Math.floor(at / 4);
      bad(
        `${c.file} ${argTxt} 有 ${over} 个字节差超 ±1，最大 ${dmax} @${p % c.w},${Math.floor(p / c.w)} ` +
          `JS ${Array.from(got.slice(at & ~3, (at & ~3) + 4))} numpy ${Array.from(exp.slice(at & ~3, (at & ~3) + 4))}`,
      );
    } else {
      good(
        `${c.file} ${argTxt.padEnd(34)} 逐字节一致 ${eq}/${exp.length} 最大差 ${dmax}` +
          (dmax ? '（.5 边界舍入顺序）' : ''),
      );
    }
  }
}

// ---------- 2. 解析式不变量 ----------
const px = (d, w, x, y) => Array.from(d.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
const enc = (v) => Math.floor((v * 0.5 + 0.5) * 255 + 0.5);
const decode = (c) => (c - 128) / 127.5;

{
  // 纯平：处处 (128,128,255,255)
  const flat = await load('n_flat.in.bin');
  for (const yUp of [true, false]) {
    const o = heightToNormal({ width: 16, height: 16, data: flat }, { yUp });
    let wrong = -1;
    for (let i = 0; i < 16 * 16; i++) {
      if (o[i * 4] !== 128 || o[i * 4 + 1] !== 128 || o[i * 4 + 2] !== 255 || o[i * 4 + 3] !== 255) {
        wrong = i;
        break;
      }
    }
    wrong >= 0
      ? bad(`平图${yUp ? 'OG' : 'DX'} 第 ${wrong} 像素 ${px(o, 16, wrong % 16, Math.floor(wrong / 16))}`)
      : good(`平图${yUp ? 'OG' : 'DX'} 16x16 全部 (128,128,255)`);
  }
}

{
  // 精确线性斜坡：步长 3/255，宽 86 -> 高度 0..255 均匀递增
  const w = 86;
  const h = 5;
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      d[p] = d[p + 1] = d[p + 2] = 3 * x;
      d[p + 3] = 255;
    }
  }
  const S = 2;
  const gx = (8 * (3 / 255)) * S; // Sobel 对线性函数的响应：8 × 每像素斜率
  const len = Math.sqrt(gx * gx + 1);
  const want = [enc(-gx / len), 128, enc(1 / len), 255];
  const o = heightToNormal({ width: w, height: h, data: d }, { strength: S });
  let mismatch = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const got = px(o, w, x, y);
      // 左右边缘用 clamp，内部（含 x=1）应严格等于闭式解
      if (got.some((v, k) => Math.abs(v - want[k]) > 0)) mismatch++;
    }
  }
  mismatch
    ? bad(`线性斜坡内部有 ${mismatch} 个像素不等于闭式解 ${want}`)
    : good(`线性斜坡内部像素 === 闭式解 ${want}（高度右升 -> 法向朝 -X，R<128）`);
  // 边缘 clamp：x=0 处梯度是内部的 3/8，方向一致
  const edge = px(o, w, 0, 2);
  edge[0] < 128 && edge[1] === 128
    ? good(`斜坡左边缘 clamp 后仍朝 -X：${edge}`)
    : bad(`斜坡左边缘异常：${edge}`);
}

{
  // DX / OG 只差绿通道镜像，R 与 B 完全相同
  for (const name of ['n_bump', 'n_noise', 'n_color']) {
    const c = manifest.cases.find((x) => x.file === name);
    const data = await load(c.input);
    const og = heightToNormal({ width: c.w, height: c.h, data }, { source: 'lum' });
    const dx = heightToNormal({ width: c.w, height: c.h, data }, { source: 'lum', yUp: false });
    let rb = 0;
    let g = 0;
    for (let i = 0; i < c.w * c.h; i++) {
      if (og[i * 4] !== dx[i * 4] || og[i * 4 + 2] !== dx[i * 4 + 2]) rb++;
      if (Math.abs(og[i * 4 + 1] + dx[i * 4 + 1] - 255) > 1) g++;
    }
    rb || g
      ? bad(`${name} DX/OG 不满足「仅 G 镜像」：R/B 不同 ${rb}，G 不镜像 ${g}`)
      : good(`${name} DX/OG 只差绿通道镜像（R、B 逐字节相同）`);
  }
}

{
  // 高度反转 => 法向 X/Y 同时镜像，Z 不变
  for (const name of ['n_bump', 'n_vramp']) {
    const c = manifest.cases.find((x) => x.file === name);
    const data = await load(c.input);
    const a = heightToNormal({ width: c.w, height: c.h, data }, { source: 'lum' });
    const b = heightToNormal({ width: c.w, height: c.h, data }, { source: 'lum', invert: true });
    let z = 0;
    let m = 0;
    for (let i = 0; i < c.w * c.h; i++) {
      if (a[i * 4 + 2] !== b[i * 4 + 2]) z++;
      if (Math.abs(a[i * 4] + b[i * 4] - 255) > 1 || Math.abs(a[i * 4 + 1] + b[i * 4 + 1] - 255) > 1) m++;
    }
    z || m
      ? bad(`${name} 反转不满足「X/Y 镜像、Z 不变」：Z 不同 ${z}，镜像失败 ${m}`)
      : good(`${name} 反转后 R/G 同时镜像、B 逐字节不变`);
  }
}

{
  // 模糊只会压掉梯度：噪声图的 |n_xy| 能量随半径单调下降
  const c = manifest.cases.find((x) => x.file === 'n_noise');
  const data = await load(c.input);
  const energy = (blur) => {
    const o = heightToNormal({ width: c.w, height: c.h, data }, { blur });
    let e = 0;
    for (let i = 0; i < c.w * c.h; i++) {
      e += decode(o[i * 4]) ** 2 + decode(o[i * 4 + 1]) ** 2;
    }
    return e;
  };
  const [e0, e1, e3] = [energy(0), energy(1), energy(3)];
  e0 > e1 && e1 > e3
    ? good(`噪声图梯度能量随模糊半径单调下降：${e0.toFixed(1)} > ${e1.toFixed(1)} > ${e3.toFixed(1)}`)
    : bad(`模糊没有压梯度：${e0} / ${e1} / ${e3}`);
}

{
  // 每个像素都得是单位向量（8 位量化误差内）
  let worst = 0;
  for (const c of manifest.cases) {
    const data = await load(c.input);
    for (const r of c.runs) {
      const o = heightToNormal({ width: c.w, height: c.h, data }, r.args);
      for (let i = 0; i < c.w * c.h; i++) {
        const n = [0, 1, 2].map((k) => decode(o[i * 4 + k]));
        worst = Math.max(worst, Math.abs(Math.hypot(...n) - 1));
      }
    }
  }
  worst <= 0.02
    ? good(`全部 42 组输出的法向长度最大偏差 ${worst.toFixed(4)}（8 位量化内）`)
    : bad(`法向不是单位向量，最大偏差 ${worst}`);
}

{
  // 按通道取值互不串色：R 只随 x 变、G 只随 y 变、B 恒定
  const c = manifest.cases.find((x) => x.file === 'n_color');
  const data = await load(c.input);
  const o = (source) => heightToNormal({ width: c.w, height: c.h, data }, { source });
  const chk = [];
  const allG = o('r');
  const allR = o('g');
  let gFlat = 0;
  let rFlat = 0;
  for (let i = 0; i < c.w * c.h; i++) {
    if (allG[i * 4 + 1] !== 128) gFlat++;
    if (allR[i * 4] !== 128) rFlat++;
  }
  chk.push(['取 R 通道时 G 恒 128', gFlat]);
  chk.push(['取 G 通道时 R 恒 128', rFlat]);
  const flatB = o('b');
  let bWrong = 0;
  for (let i = 0; i < c.w * c.h; i++) {
    if (flatB[i * 4] !== 128 || flatB[i * 4 + 1] !== 128 || flatB[i * 4 + 2] !== 255) bWrong++;
  }
  chk.push(['取恒定的 B 通道时输出全平', bWrong]);
  for (const [label, n] of chk) n ? bad(`${label} 失败，${n} 个像素`) : good(label);
  const srcs = NORMAL_SOURCES.map((s) => {
    const o2 = o(s);
    let e = 0;
    for (let i = 0; i < c.w * c.h; i++) e += decode(o2[i * 4]) ** 2 + decode(o2[i * 4 + 1]) ** 2;
    return [s, +e.toFixed(1)];
  });
  good(`6 种高度来源各自的梯度能量：${srcs.map(([k, v]) => `${k}=${v}`).join('  ')}`);
}

{
  // 拒绝用例
  const cases = [
    ['未知高度来源', () => heightToNormal({ width: 2, height: 2, data: new Uint8Array(16) }, { source: 'lum2' })],
    ['强度为 0', () => heightToNormal({ width: 2, height: 2, data: new Uint8Array(16) }, { strength: 0 })],
    ['强度为 NaN', () => heightToNormal({ width: 2, height: 2, data: new Uint8Array(16) }, { strength: NaN })],
    ['空图', () => heightToNormal({ width: 0, height: 4, data: new Uint8Array(0) }, {})],
    ['模糊半径爆掉', () => heightToNormal({ width: 2, height: 2, data: new Uint8Array(16) }, { blur: 99999 })],
  ];
  for (const [label, f] of cases) {
    try {
      f();
      bad(`本应拒绝：${label}`);
    } catch (e) {
      good(`已拒绝：${label.padEnd(12)} ${e.message}`);
    }
  }
}

console.log(
  fail ? `\n${fail} 个用例失败` : `\n全部通过（交叉比对 ${runs} 组 + 不变量与拒绝用例） 最慢： ${slow[1]} ${slow[0].toFixed(1)}ms`,
);
