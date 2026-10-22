// Node 侧验证 PNM 解码器：逐个素材比对期望字节
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePnm } from '../src/js/pnm.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fmt', 'pnm');
const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf-8'));

function compare(got, c, expect) {
  const errs = [];
  if (got.width !== c.w || got.height !== c.h) {
    errs.push(`尺寸 ${got.width}x${got.height} != ${c.w}x${c.h}`);
  }
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
      errs.push(
        `像素差 ${diff} 处，首个 #${p}(${p % c.w},${Math.floor(p / c.w)}) 期望 ` +
          `${Array.from(expect.slice(first, first + 4))} 实得 ${Array.from(got.data.slice(first, first + 4))}`,
      );
    }
  }
  return errs;
}

let fail = 0;
for (const c of manifest.cases) {
  const bytes = new Uint8Array(await readFile(join(dir, c.file)));
  const expect = new Uint8Array(await readFile(join(dir, `${c.file}.bin`)));
  const t0 = performance.now();
  let got;
  try {
    got = decodePnm(bytes);
  } catch (e) {
    console.log('FAIL', c.file, '->', e.message);
    fail++;
    continue;
  }
  const ms = performance.now() - t0;
  const errs = compare(got, c, expect);
  if (errs.length) {
    console.log('FAIL', c.file, errs.join('；'));
    fail++;
  } else {
    console.log(' ok ', c.file.padEnd(20), `${c.w}x${c.h}`.padEnd(8), c.note, `${ms.toFixed(2)}ms`);
  }
}

const enc = (s) => new TextEncoder().encode(s);
const rejects = [
  ['P6 缺 MAXVAL', 'P6\n5 3\n'],
  ['P6 数据截断', 'P6\n5 3\n255\n\x01\x02'],
  ['非 PNM', 'BM....'],
  ['P7 Depth 2 无 TUPLTYPE', 'P7\nWIDTH 5\nHEIGHT 3\nDEPTH 2\nMAXVAL 255\nENDHDR\n'],
  ['P7 缺 MAXVAL', 'P7\nWIDTH 5\nHEIGHT 3\nDEPTH 3\nTUPLTYPE RGB\nENDHDR\n'],
  ['P7 未知字段', 'P7\nWIDTH 5\nHEIGHT 3\nDEPTH 3\nMAXVAL 255\nFOO bar\nENDHDR\n'],
  ['P4 头部缺换行', 'P4\n5 3\x01'],
  ['P5 16 位数据截断', 'P5\n5 3\n1000\n' + '\x01'.repeat(10)],
];
for (const [label, text] of rejects) {
  try {
    decodePnm(enc(text));
    console.log('FAIL 本应拒绝：', label);
    fail++;
  } catch (e) {
    console.log(' ok  已拒绝：', label.padEnd(24), e.message);
  }
}

console.log(fail ? `\n${fail} 个用例失败` : `\n全部通过（${manifest.cases.length} 素材 + ${rejects.length} 拒绝用例）`);
