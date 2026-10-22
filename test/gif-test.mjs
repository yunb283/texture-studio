// GIF 编码器验证。方向与其它格式相反：这里是我们【写】、PIL【读】，
// 所以本脚本把每个用例的源帧导出成 .bin + cases.json，再由 test/gif-verify.py 用 PIL
// 独立解码 .gif 做闭环核对（帧数/尺寸/帧时长/循环/透明像素数/色彩误差）。
// 这里只查 JS 侧能自证的：确定性、头部与尾部、GCE 里的延时与标志位、体积关系。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeGif, gifDelayForFps, gifFpsForDelay } from '../src/js/gif.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fmt', 'gif');
mkdirSync(dir, { recursive: true });

let fail = 0;
const bad = (m) => {
  console.log('FAIL', m);
  fail++;
};
const good = (m) => console.log(' ok  ', m);

const mk = (w, h, seed, alphaHoles = 0) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      data[p] = (x * 7 + seed * 31) % 256;
      data[p + 1] = (y * 11 + seed * 17) % 256;
      data[p + 2] = (x * 3 + y * 5 + seed * 61) % 256;
      data[p + 3] = 255;
    }
  }
  for (let i = 0; i < alphaHoles; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 0;
  }
  return { width: w, height: h, data };
};
const ramp = (w, h, n) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    data[p] = Math.floor((i * 255) / (w * h - 1));
    data[p + 1] = 128;
    data[p + 2] = 255 - data[p];
    data[p + 3] = n ? i % 7 : 255;
  }
  return { width: w, height: h, data };
};
// 恰好 256 种颜色 / 远超 256 种颜色
const exact = (count, w, h) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = i % count;
    const p = i * 4;
    data[p] = (c * 5) % 256;
    data[p + 1] = (c * 13) % 256;
    data[p + 2] = (c * 29) % 256;
    data[p + 3] = 255;
  }
  return { width: w, height: h, data };
};

const cases = [
  { name: 'g_flat', note: '4 帧渐变，不透明，全局调色板', frames: [mk(16, 16, 0), mk(16, 16, 1), mk(16, 16, 2), mk(16, 16, 3)], opts: { delay: 10, loop: 0, quality: 'normal' } },
  { name: 'g_high', note: '同素材，高质量（每帧局部调色板）', frames: [mk(16, 16, 0), mk(16, 16, 1), mk(16, 16, 2), mk(16, 16, 3)], opts: { delay: 10, loop: 0, quality: 'high' } },
  { name: 'g_alpha', note: '3 帧带透明空洞', frames: [mk(24, 13, 0, 30), mk(24, 13, 1, 12), mk(24, 13, 2, 0)], opts: { delay: 8, loop: 0, quality: 'normal' } },
  { name: 'g_single', note: '单帧 8x8', frames: [mk(8, 8, 4)], opts: { delay: 20, loop: 1, quality: 'normal' } },
  { name: 'g_odd', note: '奇数尺寸 17x9，5 帧', frames: [0, 1, 2, 3, 4].map((i) => mk(17, 9, i)), opts: { delay: 5, loop: 5, quality: 'high' } },
  { name: 'g_256', note: '恰好 256 种颜色', frames: [exact(256, 32, 32)], opts: { delay: 10, loop: 0, quality: 'normal' } },
  { name: 'g_over', note: '远超 256 色（必须被量化压进 256）', frames: [exact(1000, 40, 40), exact(1300, 40, 40)], opts: { delay: 10, loop: 0, quality: 'normal' } },
  { name: 'g_tiny', note: '1x1 两帧', frames: [mk(1, 1, 0), mk(1, 1, 1)], opts: { delay: 3, loop: 0, quality: 'normal' } },
  { name: 'g_delay1', note: 'delay=1 必须被钳到 2', frames: [mk(12, 12, 0), mk(12, 12, 1)], opts: { delay: 1, loop: null, quality: 'normal' } },
  { name: 'g_ramp', note: '平滑渐变 + 半透明边缘（alpha<128 记透明）', frames: [ramp(20, 20, 0), ramp(20, 20, 1)], opts: { delay: 12, loop: 0, quality: 'high' } },
  { name: 'g_fps', note: '按 24fps 换算的延时', frames: [0, 1, 2].map((i) => mk(20, 20, i)), opts: { delay: gifDelayForFps(24), loop: 0, quality: 'normal' } },
];

const gce = (bytes) => {
  for (let i = 0; i + 7 < bytes.length; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) {
      return { flags: bytes[i + 3], delay: bytes[i + 4] | (bytes[i + 5] << 8), tindex: bytes[i + 6] };
    }
  }
  return null;
};

const manifest = [];
for (const c of cases) {
  const bytes = encodeGif(c.frames, c.opts);
  const again = encodeGif(c.frames, c.opts);
  let same = bytes.length === again.length;
  for (let i = 0; same && i < bytes.length; i++) if (bytes[i] !== again[i]) same = false;
  const head = String.fromCharCode(...bytes.subarray(0, 6));
  const g = gce(bytes);
  const errs = [];
  if (!same) errs.push('两次编码结果不同（不确定）');
  if (head !== 'GIF89a') errs.push(`头部是 ${head}`);
  if (bytes[bytes.length - 1] !== 0x3b) errs.push('缺少 trailer 0x3B');
  if (!g) errs.push('找不到 GCE');
  else {
    if (g.delay < 2) errs.push(`GCE 延时 ${g.delay} 未钳到 >=2`);
    if (Array.isArray(c.opts.delay) ? false : g.delay !== Math.max(2, c.opts.delay)) {
      errs.push(`GCE 延时 ${g.delay} != 期望 ${Math.max(2, c.opts.delay)}`);
    }
    const wantT = c.frames.some((f) => f.data.some((v, i) => i % 4 === 3 && v < 128));
    if (Boolean(g.flags & 1) !== wantT) errs.push(`透明标志 ${g.flags & 1} 与实际 ${wantT ? '有' : '无'}透明像素不符`);
    const disposal = (g.flags >> 2) & 7;
    if (wantT ? disposal !== 2 : disposal !== 1) errs.push(`disposal=${disposal}（透明 ${wantT}）`);
  }
  errs.length ? bad(`${c.name}：${errs.join('；')}`) : good(`${c.name} ${(bytes.length / 1024).toFixed(2)}KB ${c.note}`);
  writeFileSync(join(dir, `${c.name}.gif`), bytes);
  c.frames.forEach((f, i) => writeFileSync(join(dir, `${c.name}.f${i}.bin`), Buffer.from(f.data.buffer)));
  manifest.push({
    name: c.name,
    frames: c.frames.length,
    w: c.frames[0].width,
    h: c.frames[0].height,
    delay: Math.max(2, Array.isArray(c.opts.delay) ? c.opts.delay[0] : c.opts.delay),
    loop: c.opts.loop === null ? null : c.opts.loop,
    quality: c.opts.quality,
    transparent: c.frames.map((f) => {
      let n = 0;
      for (let i = 3; i < f.data.length; i += 4) if (f.data[i] < 128) n++;
      return n;
    }),
  });
}
writeFileSync(join(dir, 'cases.json'), JSON.stringify({ cases: manifest }, null, 1));

// 延时/帧率换算
for (const [fps, d] of [[10, 10], [24, 4], [15, 7], [60, 2], [2, 50]]) {
  const got = gifDelayForFps(fps);
  got === d ? good(`fps ${fps} → 延时 ${got}cs（等效 ${gifFpsForDelay(got)}fps）`) : bad(`fps ${fps} → 延时 ${got}，期望 ${d}`);
}
// 拒绝用例
for (const [label, frames, opts] of [
  ['空帧列表', [], {}],
  ['尺寸不一致', [mk(4, 4, 0), mk(5, 4, 1)], {}],
  ['1x0', [{ width: 1, height: 0, data: new Uint8ClampedArray(0) }], {}],
]) {
  try {
    encodeGif(frames, opts);
    bad(`本应拒绝：${label}`);
  } catch (e) {
    good(`已拒绝：${label.padEnd(10)} ${e.message}`);
  }
}
// colors 越界是钳位而不是报错（1 色 GIF 没有意义，钳到 2 色）
{
  const one = encodeGif([mk(4, 4, 0)], { delay: 10, colors: 1 });
  const two = encodeGif([mk(4, 4, 0)], { delay: 10, colors: 2 });
  const big = encodeGif([mk(4, 4, 0)], { delay: 10, colors: 9999 });
  const norm = encodeGif([mk(4, 4, 0)], { delay: 10 });
  const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  eq(one, two) && eq(big, norm)
    ? good('colors 钳位：1→2 与 colors:2 相同，9999→256 与默认相同')
    : bad(`colors 钳位不成立：1≠2 ${!eq(one, two)}，9999≠默认 ${!eq(big, norm)}`);
}

console.log(fail ? `\n${fail} 个用例失败` : `\n全部通过（${cases.length} 个 GIF 已写入 fmt/gif，请再跑 python gif-verify.py 做 PIL 解码闭环）`);
