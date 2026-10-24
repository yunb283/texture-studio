// GIF 解码器验证。方向与 gif-test.mjs 相反：这里是我们【读】、PIL【写】。
// 分四层，前三层纯 JS 自证（node 直接跑），第四层要先用 test/gif-decode-verify.py 生成素材：
//   1. LZW 层：gif.js 的 lzwEncode 写、这里的 lzwDecode 读，逐索引比对，钉死码宽/clear/KwKwK。
//   2. 容器层：测试自己按规格拼字节（全局表/局部表/GCE/NETSCAPE/隔行），parseGif 读回字段。
//   3. 合成层：手搭 info 结构喂 createGifCompositor，逐像素核对 disposal 0/1/2/3、透明索引、
//      越界补丁和隔行行序 —— 这几条最容易错，而且期望值是照规范手写的，不依赖被测代码。
//   4. PIL 闭环：PIL 编的多帧/透明/disposal/不等延时素材，逐帧整幅 RGBA 比对。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lzwEncode } from '../src/js/gif.js';
import {
  parseGif,
  lzwDecode,
  createGifCompositor,
  gifDelaysMs,
  gifTimeline,
  frameAtTime,
} from '../src/js/gif-decode.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fmt', 'gifdec');
mkdirSync(dir, { recursive: true });

let fail = 0;
const bad = (m) => {
  console.log('FAIL', m);
  fail++;
};
const good = (m) => console.log(' ok  ', m);
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function firstDiff(got, exp) {
  for (let i = 0; i < Math.max(got.length, exp.length); i++) {
    if (got[i] !== exp[i]) return i;
  }
  return -1;
}

function mulberry(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('== 1. LZW 闭环（lzwEncode 写 → lzwDecode 读）==');
{
  const streams = [];
  for (let m = 2; m <= 8; m++) {
    const k = 1 << m;
    const r = mulberry(k * 7919);
    const seq = new Uint8Array(m * 800);
    for (let i = 0; i < seq.length; i++) seq[i] = i % k;
    streams.push({ name: `seq_m${m}`, m, data: seq });
    // 连续同值 run：最容易撞上「前一项接自己首字节」的 KwKwK 分支
    const runs = new Uint8Array(3000);
    let i = 0;
    let v = 0;
    while (i < runs.length) {
      const len = 1 + Math.floor(r() * 40);
      v = (v + 1 + Math.floor(r() * (k - 1))) % k;
      runs.fill(v, i, Math.min(runs.length, i + len));
      i += len;
    }
    streams.push({ name: `runs_m${m}`, m, data: runs });
    const rand = new Uint8Array(1200 + 4200 * (m - 2));
    for (let j = 0; j < rand.length; j++) rand[j] = Math.floor(r() * k);
    streams.push({ name: `rand_m${m}`, m, data: rand });
  }
  // 逐个跨过 9/10/11/12 位的增宽边界，以及 4096 满表后的 clear
  for (const n of [400, 520, 1030, 2060, 4100, 4200, 20000]) {
    const r = mulberry(n);
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.floor(r() * 256);
    streams.push({ name: `edge_n${n}`, m: 8, data: a });
  }
  // 全同一值：字典一路长到满、反复 clear，是增宽条件最容易写错的一种
  for (const m of [2, 4, 8]) {
    streams.push({ name: `flat_m${m}`, m, data: new Uint8Array(9000) });
  }
  let ok = 0;
  for (const s of streams) {
    const enc = lzwEncode(s.m, s.data);
    let got;
    try {
      got = lzwDecode(s.m, enc, s.data.length);
    } catch (ex) {
      bad(`${s.name}：解码抛错 ${ex?.message ?? ex}`);
      continue;
    }
    const i = firstDiff(got, s.data);
    if (i >= 0) {
      bad(
        `${s.name}：第 ${i} 个索引不符，解出 ${got[i]} 期望 ${s.data[i]}` +
          `（前后：解出 ${[...got.slice(Math.max(0, i - 3), i + 4)]} 期望 ${[...s.data.slice(Math.max(0, i - 3), i + 4)]}）`
      );
    } else ok++;
  }
  if (ok === streams.length) good(`${ok} 条索引流（位深 2~8、增宽边界、满表 clear、KwKwK）逐字节还原`);
}

console.log('\n== 2. 容器层（按规格手写字节 → parseGif）==');
{
  // 测试侧独立的最小 GIF 写手：只写被解析需要的块，字段位置照规范写死
  class W {
    constructor() {
      this.a = [];
    }
    byte(...v) {
      for (const x of v) this.a.push(x & 0xff);
      return this;
    }
    u16(v) {
      return this.byte(v & 0xff, (v >> 8) & 0xff);
    }
    str(s) {
      for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
      return this;
    }
    sub(bytes) {
      for (let p = 0; p < bytes.length; p += 255) {
        const n = Math.min(255, bytes.length - p);
        this.byte(n);
        for (let i = 0; i < n; i++) this.a.push(bytes[p + i]);
      }
      return this.byte(0);
    }
    // 调色板：恒等灰阶（索引 i → i,i,i）。入参是头里的 size 字段，项数 = 2^(n+1)
    pal(sizeField) {
      const n = 1 << (sizeField + 1);
      for (let i = 0; i < n; i++) this.byte(i, i, i);
      return this;
    }
    frame(bits, indices, opts = {}) {
      if (opts.gce) {
        const packed = (opts.gce.disposal ?? 0) << 2 | (opts.gce.transparent !== undefined ? 1 : 0);
        // GCE 是扩展块：长度 4 的子块装 [打包位, 延迟 u16, 透明索引]，后面还要一个 0 收尾
        this.byte(0x21, 0xf9, 0x04, packed);
        this.u16(opts.gce.delay ?? 0);
        this.byte(opts.gce.transparent ?? 0, 0);
      }
      this.byte(0x2c);
      this.u16(opts.x ?? 0);
      this.u16(opts.y ?? 0);
      this.u16(opts.w);
      this.u16(opts.h);
      const interlace = opts.interlace ? 0x40 : 0;
      // 局部表的 size 字段写 bits-1（正好 2^bits 项，够用又不浪费）
      this.byte(opts.lct ? 0x80 | (bits - 1) : interlace);
      if (opts.lct) this.pal(bits - 1);
      this.byte(bits);
      return this.sub(lzwEncode(bits, indices));
    }
    end() {
      this.byte(0x3b);
      return Uint8Array.from(this.a);
    }
  }
  const head = (w, h, bits, withGct = true) => {
    const b = new W();
    b.str('GIF89a').u16(w).u16(h);
    b.byte(withGct ? 0x80 | ((bits - 1) << 4) | (bits - 1) : 0, 0, 0);
    if (withGct) b.pal(bits - 1); // size 字段写的是 bits-1，项数才对得上
    return b;
  };

  // 2.1 全局表 + GCE + NETSCAPE 循环
  {
    const bits = 3;
    const w = 4;
    const h = 2;
    const idx = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const b = head(w, h, bits);
    // NETSCAPE 应用扩展：11 字节标识 + 子块 [1, loop u16]
    b.byte(0x21, 0xff, 0x0b).str('NETSCAPE2.0').byte(0x03, 0x01).u16(3);
    b.byte(0);
    b.frame(bits, idx, { w, h, gce: { delay: 17, disposal: 2, transparent: 5 } });
    const info = parseGif(b.end());
    const f = info.frames[0];
    info.loop === 3 && f.delay === 17 && f.disposal === 2 && f.transparent === 5 && eq(f.indices, idx)
      ? good(`全局表 / GCE(17cs,disposal2,透明5) / 循环 3 次都读回，宽 ${info.width}x${info.height}`)
      : bad(`容器字段不符：loop=${info.loop} delay=${f.delay} disposal=${f.disposal} tr=${f.transparent} indices=${[...f.indices]}`);
  }
  // 2.2 局部表（文件不带全局表）+ 补丁偏移
  {
    const bits = 2;
    const idx = Uint8Array.from([1, 2, 3, 0]);
    const b = head(8, 8, 0, false);
    b.frame(bits, idx, { w: 2, h: 2, x: 5, y: 6, lct: true });
    const info = parseGif(b.end());
    const f = info.frames[0];
    f.x === 5 && f.y === 6 && f.w === 2 && f.h === 2 && eq(f.indices, idx) && f.palette[3] === 1
      ? good('只有局部表也能解：补丁 5,6 起、2x2，索引与调色板都读回')
      : bad(`局部表用例不符：x=${f.x} y=${f.y} size=${f.w}x${f.h} idx=${[...f.indices]} pal=${[...f.palette.slice(0, 6)]} 表长=${f.palette.length}`);
  }
  // 2.3 隔行：流里的行序是四趟（h=8 → 屏幕行 0,4,2,6,1,3,5,7）
  {
    const bits = 3;
    const S = 8;
    const SCREEN_ROW = [0, 4, 2, 6, 1, 3, 5, 7]; // 规范的四趟，照抄不靠被测代码算
    // 画面本身是斜的：任何一个像素放错行都会被看出来
    const stream = new Uint8Array(S * S);
    for (let k = 0; k < S; k++) {
      const y = SCREEN_ROW[k];
      for (let x = 0; x < S; x++) stream[k * S + x] = (y + x) % 8;
    }
    const b = head(S, S, bits);
    b.frame(bits, stream, { w: S, h: S, interlace: true });
    const bytes = b.end();
    // 留给 python 侧：PIL 认隔行 GIF，用它当第三方裁判（本文件是测试写手写出来的）
    writeFileSync(join(dir, 'interlaced.gif'), bytes);
    const info = parseGif(bytes);
    const comp = createGifCompositor(info);
    const rgba = comp.frame(0);
    let ok = true;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (rgba[(y * S + x) * 4] !== (y + x) % 8) ok = false;
      }
    }
    ok
      ? good('隔行帧行序正确：斜纹画面 8x8 逐像素归位，字节也写给 PIL 当裁判（fmt/gifdec/interlaced.gif）')
      : bad(`隔行行序错：第 0 行 R 通道是 ${[...Array(S)].map((_, x) => rgba[x * 4])}，期望 ${[...Array(S)].map((_, x) => x % 8)}`);
  }
  // 2.4 结构容错与报错文案
  {
    const cases = [
      ['不是 GIF', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), /不是 GIF 文件/],
      ['头部截断', Uint8Array.from([0x47, 0x49, 0x46]), /不完整/],
      [
        '坏块标记',
        (() => {
          const b = head(2, 2, 2);
          b.byte(0x99, 0x00);
          return b.end();
        })(),
        /结构不认识/,
      ],
      ['帧像素读不够', head(2, 2, 2).frame(2, Uint8Array.from([0, 1, 2]), { w: 2, h: 2 }).end(), /不完整|损坏/],
    ];
    for (const [label, bytes, re] of cases) {
      try {
        parseGif(bytes);
        bad(`${label}：本该报错，却解出了东西`);
      } catch (ex) {
        re.test(String(ex?.message ?? ex))
          ? good(`${label} → ${ex.message}`)
          : bad(`${label}：报错文案对不上：${ex.message}`);
      }
    }
  }
}

console.log('\n== 3. 合成层（disposal / 透明 / 越界，期望值照规范手写）==');
{
  const W = 4;
  const H = 4;
  // 索引 0 红、1 绿、2 蓝、3 黑；透明索引一律画 alpha=0
  const PAL = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]);
  const full = (v) => Uint8Array.from(new Array(W * H).fill(v));
  const info = (...frames) => ({
    width: W,
    height: H,
    gct: PAL,
    loop: null,
    frames: frames.map((f) => ({
      x: 0,
      y: 0,
      w: W,
      h: H,
      interlaced: false,
      palette: PAL,
      delay: 10,
      disposal: 0,
      transparent: -1,
      ...f,
    })),
  });
  const px = (rgba, x, y) => [...rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
  // 背景色分支要有 LSD 里的背景索引；单独造一份，别动 info() 的默认值
  const infoBg = (bgIndex, ...frames) => ({ ...info(...frames), bgIndex });

  // 3.1 disposal=1 之后接 disposal=2：小补丁画完要擦回透明，画面别留着
  {
    const it = createGifCompositor(
      info(
        { indices: full(0) }, // 整幅红，disposal 默认 0（按 1 处理：留着）
        { x: 1, y: 1, w: 2, h: 2, indices: Uint8Array.from([1, 1, 1, 1]), disposal: 2 } // 2x2 绿，画完擦掉
      )
    );
    const f0 = px(it.frame(0), 1, 1);
    const f1 = px(it.frame(1), 1, 1);
    const f1corner = px(it.frame(1), 0, 0);
    it.frame(0); // 往回跳也要能从透明底重跑，别把上一帧的残留留在 base 里
    const back = px(it.frame(0), 1, 1);
    const okBack = eq(back, [255, 0, 0, 255]);
    eq(f0, [255, 0, 0, 255]) && eq(f1, [0, 255, 0, 255]) && eq(f1corner, [255, 0, 0, 255]) && okBack
      ? good('disposal=2：补丁画完擦成透明，四角留下的红还在；倒退到第 0 帧重跑结果一致')
      : bad(`disposal=2 不符：补丁内 ${f1} 四角 ${f1corner} 回跳 ${back}（第 0 帧应为 255,0,0,255）`);
  }
  // 3.2 disposal=3：擦掉这一帧的矩形，但不碰别的帧画上去的像素
  {
    const it = createGifCompositor(
      info(
        { indices: full(0) }, // 整幅红
        { indices: full(1), disposal: 3 }, // 整幅绿，画完退回「画绿之前」= 红
        { x: 0, y: 0, w: 1, h: 1, indices: Uint8Array.from([2]), disposal: 1 } // 左上角蓝
      )
    );
    it.frame(0);
    const after2 = px(it.frame(1), 2, 2); // 这一帧显示时是绿
    it.frame(1);
    const after3 = px(it.frame(2), 2, 2); // disposal=3 之后应回到红
    const corner = px(it.frame(2), 0, 0);
    eq(after2, [0, 255, 0, 255]) && eq(after3, [255, 0, 0, 255]) && eq(corner, [0, 0, 255, 255])
      ? good('disposal=3：这一帧显示时是绿，画完之后那块退回上一份；不影响别处新画的蓝')
      : bad(`disposal=3 不符：帧1 ${after2} 帧2 中心 ${after3} 帧2 左上 ${corner}`);
  }
  // 3.3 透明索引：不写底，透出上一帧
  {
    const it = createGifCompositor(
      info(
        { indices: full(0) },
        { indices: full(3), transparent: 3 } // 全帧「透明」：一个像素都不该改
      )
    );
    it.frame(0);
    const v = px(it.frame(1), 3, 3);
    eq(v, [255, 0, 0, 255]) ? good('透明索引：这一帧什么都不写，透出上一帧的红') : bad(`透明索引不符：${v}`);
  }
  // 3.4 补丁顶到画面外：越界部分裁掉，别把索引写进下一行
  {
    const it = createGifCompositor(
      info({ x: 3, y: 3, w: 2, h: 2, indices: Uint8Array.from([1, 1, 1, 1]) })
    );
    const inb = px(it.frame(0), 3, 3);
    const oob = px(it.frame(0), 0, 0);
    eq(inb, [0, 255, 0, 255]) && eq(oob, [0, 0, 0, 0])
      ? good('补丁越界：画面内那一像素正常画绿，画面外的不写、也不会串到下一行')
      : bad(`越界补丁不符：画面内 ${inb} 画面外 ${oob}`);
  }
  // 3.5 空帧数 / 超范围索引不炸
  {
    const it = createGifCompositor(info({ indices: full(0) }));
    const a = it.frame(99);
    const b = px(a, 0, 0);
    eq(b, [255, 0, 0, 255]) ? good('frame(超出范围) 按最后一帧夹住，不越界读') : bad(`夹取不符：${b}`);
    const none = createGifCompositor(info());
    none.frame(0) === null ? good('零帧的 GIF：frame() 返回 null，不抛') : bad('零帧 GIF 应该返回 null');
  }
  // 3.6 全片一个透明索引都没有：disposal=2 恢复成 LSD 的背景色（索引 2 = 蓝），不是擦成 alpha=0
  {
    const it = createGifCompositor(
      infoBg(
        2,
        { indices: full(0) },
        { x: 1, y: 1, w: 2, h: 2, indices: Uint8Array.from([1, 1, 1, 1]), disposal: 2 },
        { x: 0, y: 0, w: 1, h: 1, indices: Uint8Array.from([3]) }
      )
    );
    const a = px(it.frame(0), 1, 1);
    const b = px(it.frame(1), 1, 1); // 这一帧显示时还是绿，擦背景是画完之后的事
    const c = px(it.frame(2), 1, 1);
    const d = px(it.frame(2), 0, 0);
    eq(a, [255, 0, 0, 255]) && eq(b, [0, 255, 0, 255]) && eq(c, [0, 0, 255, 255]) && eq(d, [0, 0, 0, 255])
      ? good('disposal=2（无透明）：下一帧里补丁位置恢复成背景色蓝、不透明；新画的黑色照常')
      : bad(`disposal=2 背景色不符：帧0 ${a} 帧1 ${b} 帧2 补丁 ${c} 帧2 左上 ${d}`);
  }
  // 3.7 同一份文件只要有透明索引，disposal=2 就改回擦成 alpha=0（背景索引得让位）
  {
    const it = createGifCompositor(
      infoBg(
        2,
        { indices: full(0) },
        { x: 1, y: 1, w: 2, h: 2, indices: Uint8Array.from([1, 1, 1, 1]), disposal: 2, transparent: 1 },
        { x: 0, y: 0, w: 1, h: 1, indices: Uint8Array.from([3]) }
      )
    );
    it.frame(0);
    it.frame(1);
    const c = px(it.frame(2), 1, 1);
    eq(c, [0, 0, 0, 0])
      ? good('disposal=2（有透明）：忽略背景索引，擦成 alpha=0，和浏览器/PIL 的约定一致')
      : bad(`disposal=2 有透明时应擦成 alpha=0，实际 ${c}`);
  }
  // 3.8 乱序取帧（倒退走检查点）：每个结果都要和「另开一个合成器从第 0 帧顺推到这一帧」逐像素相同。
  //     拖逐帧滑块就是这种取帧节奏，检查点贴回去错一次就是画面串帧
  {
    const rnd = mulberry(7);
    const N = 40;
    const fs = [];
    for (let i = 0; i < N; i++) {
      const x = Math.floor(rnd() * 3);
      const y = Math.floor(rnd() * 3);
      const pw = 1 + Math.floor(rnd() * 2);
      const ph = 1 + Math.floor(rnd() * 2);
      const v = Math.floor(rnd() * 4);
      fs.push({
        x,
        y,
        w: pw,
        h: ph,
        indices: Uint8Array.from(new Array(pw * ph).fill(v)),
        disposal: i % 4,
        transparent: rnd() < 0.25 ? v : -1,
      });
    }
    const src = info(...fs);
    const ref = (k) => {
      const fresh = createGifCompositor(src);
      let out = null;
      for (let i = 0; i <= k; i++) out = fresh.frame(i);
      return out;
    };
    const it = createGifCompositor(src);
    let firstBad = '';
    for (let n = 0; n < 160 && !firstBad; n++) {
      const k = Math.floor(rnd() * N);
      if (!eq(it.frame(k), ref(k))) firstBad = `乱序第 ${n} 次取帧 ${k}`;
    }
    for (let k = 0; !firstBad && k < N; k++) {
      if (!eq(it.frame(k), ref(k))) firstBad = `顺序补扫第 ${k} 帧`;
    }
    firstBad
      ? bad(`倒退取帧与从 0 重跑不一致：${firstBad}`)
      : good('乱序取帧 160 次 + 顺序补扫 40 帧，逐像素与「从第 0 帧重跑」一致（检查点贴回正确）');
  }
  // 3.9 传 out 的契约：结果必须落在调用方给的那块缓冲里，并且返回它本身
  //     （预览页的帧缓冲环靠这条，否则会读到上一帧）
  {
    const src = info(
      { indices: full(0) }, // 红
      { indices: full(1) }, // 绿
      { x: 1, y: 1, w: 2, h: 2, indices: Uint8Array.from([2, 2, 2, 2]), disposal: 2 } // 蓝补丁，画完擦掉
    );
    const it = createGifCompositor(src);
    const a = new Uint8ClampedArray(W * H * 4);
    const b = new Uint8ClampedArray(W * H * 4);
    const r1 = it.frame(0, a) === a && eq(px(a, 0, 0), [255, 0, 0, 255]);
    const r2 = it.frame(1, b) === b && eq(px(b, 0, 0), [0, 255, 0, 255]) && eq(px(a, 0, 0), [255, 0, 0, 255]);
    const r3 = it.frame(1, a) === a && eq(px(a, 0, 0), [0, 255, 0, 255]); // 同一帧换一块缓冲也要拿到画面
    const r4 = it.frame(2, b) === b && eq(px(b, 1, 1), [0, 0, 255, 255]) && eq(px(b, 0, 0), [0, 255, 0, 255]);
    const r5 = it.frame(0, a) === a && eq(px(a, 0, 0), [255, 0, 0, 255]); // 倒退 + 复用缓冲
    r1 && r2 && r3 && r4 && r5
      ? good('frame(i, out) 一律写进 out 并返回它：同帧换缓冲、倒退复用都不串帧')
      : bad(`frame(i, out) 契约不符：${[r1, r2, r3, r4, r5].map((v, i) => (v ? '' : i + 1)).join(',')}`);
  }
}

console.log('\n== 4. 播放时钟（不等长延迟）==');
{
  const it = { frames: [{ delay: 0 }, { delay: 10 }, { delay: 1 }, { delay: 25 }] };
  const ms = gifDelaysMs(it);
  const tl = gifTimeline(it);
  const okClamp = eq(ms, [20, 100, 20, 250]);
  const okTotal = tl.total === 390 && tl.minMs === 20 && tl.maxMs === 250;
  const okFps = Math.abs(tl.avgFps - 4 / 0.39) < 1e-9;
  const okAt =
    frameAtTime(tl.cum, 0) === 0 &&
    frameAtTime(tl.cum, 119) === 1 &&
    frameAtTime(tl.cum, 120) === 2 &&
    frameAtTime(tl.cum, 389) === 3;
  okClamp && okTotal && okFps && okAt
    ? good(`0/1 抬到 20ms，累计 ${tl.total}ms、平均 ${tl.avgFps.toFixed(2)}fps，时刻→帧号按累计轴命中`)
    : bad(`时钟不符：ms=${ms} total=${tl.total} avgFps=${tl.avgFps} 定位=${[0, 119, 120, 389].map((t) => frameAtTime(tl.cum, t))}`);
}

console.log('\n== 5. PIL 闭环（需要先用 python 生成素材）==');
{
  const manPath = join(dir, 'manifest.json');
  let man = null;
  try {
    man = JSON.parse(readFileSync(manPath, 'utf8'));
  } catch {
    good('跳过：还没有 fmt/gifdec/manifest.json，跑 python test/gif-decode-verify.py 生成素材后再跑本脚本');
  }
  for (const c of man?.cases ?? []) {
    const bytes = Uint8Array.from(readFileSync(join(dir, c.gif || c.name + '.gif')));
    let info;
    try {
      info = parseGif(bytes);
    } catch (ex) {
      bad(`${c.name}：parseGif 抛错 ${ex?.message ?? ex}`);
      continue;
    }
    if (info.frames.length !== c.frames) {
      bad(`${c.name}：帧数 ${info.frames.length}，PIL 那边是 ${c.frames}`);
      continue;
    }
    if (c.loop !== undefined && info.loop !== c.loop) {
      bad(`${c.name}：循环次数 ${info.loop}，期望 ${c.loop}`);
      continue;
    }
    // 用例声明的结构要真在文件里，否则这个用例其实是空跑
    const st = c.structure;
    if (st) {
      const patches = info.frames.filter(
        (f) => f.x !== 0 || f.y !== 0 || f.w !== info.width || f.h !== info.height
      ).length;
      const inter = info.frames.filter((f) => f.interlaced).length;
      if (patches !== st.patches || inter !== st.interlaced || info.bgIndex !== st.bg_index) {
        bad(
          `${c.name}：结构对不上：我数到补丁帧 ${patches}、隔行 ${inter}、背景索引 ${info.bgIndex}，` +
            `文件里是 ${st.patches}/${st.interlaced}/${st.bg_index}`
        );
        continue;
      }
    }
    const comp = createGifCompositor(info);
    let firstBad = null;
    for (let i = 0; i < info.frames.length; i++) {
      const got = comp.frame(i);
      const exp = Uint8Array.from(readFileSync(join(dir, `${c.name}_${i}.rgba`)));
      const diffAt = firstPixelDiff(got, exp);
      if (diffAt >= 0) {
        const x = diffAt % info.width;
        const y = Math.floor(diffAt / info.width);
        const d = diffAt * 4;
        firstBad = `第 ${i} 帧第 ${x},${y} 像素：解出 ${[...got.subarray(d, d + 4)]}，PIL 是 ${[...exp.subarray(d, d + 4)]}（该帧差 ${countPixelDiff(got, exp)} 个像素）`;
        break;
      }
    }
    // 未写延时：PIL 原样报 0，播放这边下限 20ms（1cs 以下浏览器也是这个套路），
    // 比较时把期望值一起抬到下限
    if (!firstBad && c.durations) {
      const gotMs = gifDelaysMs(info);
      const expMs = c.durations.map((d) => Math.max(20, d));
      const off = gotMs.findIndex((v, i) => v !== expMs[i]);
      if (off >= 0) firstBad = `延时不符：第 ${off} 帧解出 ${gotMs[off]}ms，PIL 是 ${c.durations[off]}ms（全部 ${gotMs}）`;
    }
    if (firstBad) bad(`${c.name}：${firstBad}`);
    else good(`${c.name}：${info.frames.length} 帧逐像素与 PIL 一致（尺寸 ${info.width}x${info.height}${c.durations ? '，延时 ' + gifDelaysMs(info).join('/') + 'ms' : ''}）`);
  }
}

// 两边都透明时 RGB 是无定义的（PIL 会留着调色板里那条颜色，我这边写 0），只认 alpha；
// 只要有一边不透明就整像素四个通道都比
function firstPixelDiff(got, exp) {
  const n = Math.min(got.length, exp.length) >> 2;
  if (got.length !== exp.length) return 0;
  for (let p = 0; p < n; p++) {
    const o = p * 4;
    if (got[o + 3] === 0 && exp[o + 3] === 0) continue;
    for (let k = 0; k < 4; k++) if (got[o + k] !== exp[o + k]) return p;
  }
  return -1;
}

function countPixelDiff(got, exp) {
  let n = 0;
  for (let p = 0; p < (Math.min(got.length, exp.length) >> 2); p++) {
    const o = p * 4;
    if (got[o + 3] === 0 && exp[o + 3] === 0) continue;
    for (let k = 0; k < 4; k++) {
      if (got[o + k] !== exp[o + k]) {
        n++;
        break;
      }
    }
  }
  return n;
}

console.log(fail ? `\n${fail} 个用例失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
