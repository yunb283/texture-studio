// Node 侧快速验证 TIFF 解码器：逐个素材比对期望字节
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeTiff } from '../src/js/tiff.js';

const here = dirname(fileURLToPath(import.meta.url));
const fmt = join(here, 'fmt');
const manifest = JSON.parse(await readFile(join(fmt, 'x', 'manifest.json'), 'utf-8'));

let fail = 0;
const times = [];
for (const c of manifest) {
  const bytes = new Uint8Array(await readFile(join(fmt, c.file)));
  const expect = new Uint8Array(await readFile(join(fmt, 'x', `${c.file}.bin`)));
  const t0 = performance.now();
  let got;
  try {
    got = await decodeTiff(bytes);
  } catch (e) {
    console.log('FAIL', c.file, '->', e.message);
    fail++;
    continue;
  }
  const ms = performance.now() - t0;
  times.push([c.file, ms]);
  const errs = [];
  if (got.width !== c.w || got.height !== c.h) errs.push(`尺寸 ${got.width}x${got.height} != ${c.w}x${c.h}`);
  if (got.data.length !== expect.length) errs.push(`字节数 ${got.data.length} != ${expect.length}`);
  else {
    let diff = 0;
    let first = -1;
    for (let i = 0; i < expect.length; i++) {
      if (expect[i] !== got.data[i]) {
        if (first < 0) first = i;
        diff++;
      }
    }
    if (diff) {
      const p = Math.floor(first / 4);
      errs.push(`像素差 ${diff} 处，首个 #${p}(${p % c.w},${Math.floor(p / c.w)}) 期望 ${Array.from(expect.slice(first, first + 4))} 实得 ${Array.from(got.data.slice(first, first + 4))}`);
    }
  }
  if (errs.length) {
    console.log('FAIL', c.file, errs.join('；'));
    fail++;
  } else {
    console.log(' ok ', c.file.padEnd(26), `${c.w}x${c.h}`.padEnd(10), `comp=${c.comp}`, `pred=${c.pred}`, `tile=${c.tile}`, `be=${c.be}`, `bps=${c.bps}`, `${ms.toFixed(1)}ms`);
  }
}

// 应被拒绝的变体
for (const [name, why] of [['t_rgb_sep.tif', '分面存储']]) {
  try {
    await decodeTiff(new Uint8Array(await readFile(join(fmt, name))));
    console.log('FAIL', name, '本应拒绝但解码成功');
    fail++;
  } catch (e) {
    console.log(' ok ', name.padEnd(26), `已拒绝（${why}）:`, e.message);
  }
}

const slowest = times.sort((a, b) => b[1] - a[1]).slice(0, 3);
console.log(fail ? `\n${fail} 个用例失败` : '\n全部通过', '最慢：', slowest.map(([n, ms]) => `${n} ${ms.toFixed(0)}ms`).join(', '));
const files = await readdir(fmt);
console.log('素材总数', files.filter((f) => f.endsWith('.tif')).length);
