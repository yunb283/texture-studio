// GIF89a 编码器（零依赖）：中位切分量化 + 最近色缓存 + LZW 压缩。
// 约定与 test/gen-gif.py 的 PIL 解码闭环核对（test/gif-test.mjs）：
//   1. 所有帧同尺寸；delay 单位是 1/100 秒（GIF 原生），最小 2 —— 多数浏览器把 1 当 0 处理。
//   2. 质量档 quality：
//        'normal'（默认）= 全局调色板，从所有帧抽样后一次中位切分，体积小、编码快；
//        'high'          = 每帧局部调色板，视频/渐变素材不容易串色，体积略大。
//   3. 透明：任一帧存在 alpha < 128 就启用透明，索引 0 固定留给透明；
//      透明帧的 disposal=2（恢复背景），不透明帧 disposal=1（保留），避免残影。
//      GIF 只有二值透明，半透明像素按 alpha<128 判透明（与原图会有边缘差，属格式限制）。
//   4. 调色板长度补到 2 的幂（GIF 头里的 size 字段是 2^(n+1)），不足部分填 0。
//   5. LZW：minCodeSize = max(2, 位深)；码表比解码器早一个代码入表，所以增宽条件是
//      「加完一项后 next > 2^codeSize」（写成 == 会窄一位 → broken data stream）；
//      next 到 4096 时发 clear code 并重置字典；输出按 ≤255 字节子块分块，末尾 0 字节。
//      这一层由 test/gif-lzw-test.mjs + gif-lzw-verify.py 用最小 GIF 逐索引闭环（27 例，含填满表多次 clear）。
//   6. 循环：loop=0 无限循环（写 Netscape 2.0 应用扩展），loop=null 不写该扩展块，
//      loop=n>0 循环 n 次。
// 量化：调色板由中位切分得到，像素到索引是精确最近色（不同颜色超过 65536 种后才退化为 5bit 桶），
// 所以局部调色板帧的误差不受桶宽影响；每帧只算实际出现过的颜色。

export const GIF_QUALITY = ['normal', 'high'];

// 编码流程拆成「算参数 → 文件头 → 每帧字节 → 收尾」。「每帧字节」只依赖参数 + 那一帧，
// 帧与帧之间互不依赖，所以可以丢给 worker 池并行算、再按序号拼回来 —— 拼出的字节和
// 单线程逐帧编码完全一致（全局调色板在 gifParams 里就算好了）。
// gifStart / gifEncodeNext / gifFinish 是同一套东西的有状态薄封装，页面逐帧让出主线程时用。

// 一次算好整段动画的编码参数：尺寸、每帧延时、是否用到透明、全局调色板（普通质量时）。
export function gifParams(frames, opts = {}) {
  if (!frames.length) throw new Error('没有可编码的帧');
  const w = frames[0].width;
  const h = frames[0].height;
  if (w < 1 || h < 1) throw new Error(`帧尺寸非法：${w}x${h}`);
  for (const f of frames) {
    if (f.width !== w || f.height !== h) throw new Error(`所有帧必须同尺寸，出现 ${f.width}x${f.height}（应为 ${w}x${h}）`);
    // 必须是像素字节数组（Uint8ClampedArray 等），传 ImageData 进来要当场拒绝：
    // ImageData 不能按下标取字节，静默读成 undefined 会把整帧量化成黑色
    if (!(f.data?.length >= w * h * 4)) {
      throw new Error(`帧数据必须长度至少 w*h*4 的字节数组（收到 ${f.data?.length ?? '没有 data'}，需要 ${w * h * 4}）`);
    }
  }
  const quality = opts.quality === 'high' ? 'high' : 'normal';
  const maxColors = Math.min(256, Math.max(2, opts.colors ?? 256));
  const delays = normalizeDelays(opts.delay, frames.length);
  // transparent 允许页面提前算好传进来（抽帧时顺手扫一遍就行）：整段动画的透明判定是全局的，
  // 默认这里要为它把每帧的 alpha 全扫一遍，1082 帧 × 13 万像素是白捡的一遍开销。
  const transparent = opts.transparent === undefined ? frames.some((f) => hasTransparency(f.data, w * h)) : !!opts.transparent;
  // 索引 0 留给透明，可用颜色少一个
  const colorCount = transparent ? maxColors - 1 : maxColors;
  const global = quality === 'normal';
  const gPalette = global ? buildGlobalPalette(frames, colorCount, transparent) : null;
  // 注意不返回 frames：这份参数要能直接 postMessage 给 worker（带帧就等于把像素拷进每个线程）
  return { w, h, delays, transparent, colorCount, global, gPalette, opts };
}

// 文件头：GIF89a + 逻辑屏幕描述符（+ 全局调色板）+ NETSCAPE 循环块
export function gifHeader(p) {
  const { w, h, transparent, colorCount, global, gPalette, opts } = p;
  const out = new ByteSink();
  out.bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // GIF89a
  out.u16(w);
  out.u16(h);
  const gBits = bitsFor(gPalette ? gPalette.length / 3 : 2);
  out.byte(global ? 0x80 | (gBits - 1) << 4 | (gBits - 1) : 0);
  out.byte(0); // 背景色索引（透明启用时 0 就是透明色）
  out.byte(0); // 像素宽高比
  if (global) writePalette(out, gPalette, gBits);
  if (opts.loop !== null) {
    out.bytes(0x21, 0xff, 0x0b);
    out.ascii('NETSCAPE2.0');
    out.bytes(0x03, 0x01);
    out.u16(opts.loop ?? 0);
    out.byte(0);
  }
  return out.toUint8Array();
}

// 第 i 帧的完整子块（图形控制扩展 + 图像描述符 + 可选局部表 + LZW 数据）。
// 只读 p 和传进来的那一帧，所以多帧可以任意顺序、任意线程分别算。
// table 可传跨帧共享的桶缓存（全局调色板固定时由 gifTableFor 建），不传就按帧新建。
export function gifFrameBytes(p, frame, i, table) {
  const { w, h, delays, transparent, colorCount, global, gPalette } = p;
  const f = frame;
  const out = new ByteSink();
  const palette = global ? gPalette : buildFramePalette(f, colorCount, transparent);
  const bits = bitsFor(palette.length / 3);
  const indices = quantize(
    f,
    palette,
    nearestCache(palette, transparent, table ? table.bucket : null),
    transparent
  );
  out.bytes(0x21, 0xf9, 0x04);
  // GCE 打包位（GIF89a 规范，MSB→LSB：保留 3 位 | disposal 3 位 | user input 1 位 | 透明 1 位）：
  //   透明标志 = 0x01，disposal 放在 bit2-4（即 disposal << 2）。
  //   注意不是「bit0-2 disposal、bit4 透明」——那样写 Pillow 和浏览器都不认透明。
  const disposal = transparent ? 2 : 1;
  out.byte((disposal << 2) | (transparent ? 1 : 0));
  out.u16(delays[i]);
  out.byte(transparent ? 0 : 255); // 透明色索引 = 0
  out.byte(0);
  out.bytes(0x2c);
  out.u16(0);
  out.u16(0);
  out.u16(w);
  out.u16(h);
  // 图像描述符的打包位和屏幕描述符不同：bit7 局部表、bit6 隔行、bit5 排序、bit2-0 表大小。
  // 只能写 0x80 | (bits-1)，把 (bits-1)<<4 那种屏幕描述符写法搬过来会把隔行位置 1，
  // 解码器就会按隔行顺序还原行（表现为第 2 行起整体错位）。
  out.byte(!global ? 0x80 | (bits - 1) : 0);
  if (!global) writePalette(out, palette, bits);
  const minCode = Math.max(2, bits);
  const data = lzwEncode(minCode, indices);
  out.byte(minCode);
  for (let q = 0; q < data.length; q += 255) {
    const n = Math.min(255, data.length - q);
    out.byte(n);
    out.raw(data, q, n);
  }
  out.byte(0);
  return out.toUint8Array();
}

export function gifTrailer() {
  return new Uint8Array([0x3b]);
}

// 全局调色板模式下可以跨帧复用的只有「5bit 桶」这一层：桶中心色 → 最近调色板色
// 是纯函数，结果与命中顺序无关，所以跨帧共享、多 worker 各自一份、逐帧新建，
// 三者逐字节一致（test/gif-test.mjs 的拼装一致性守着这条）。
// exact 层必须每帧独立：它有「满 8192 项就永久转桶」的状态，跨帧共享会让映射
// 依赖处理顺序和之前帧的内容，并行拼装就不再和单线程一致。
// 高质量（每帧局部调色板）返回 null，按帧各建各的。
export function gifTableFor(p) {
  return p.global ? { bucket: new Map() } : null;
}

export function gifStart(frames, opts = {}) {
  const p = gifParams(frames, opts);
  return { p, frames, parts: [gifHeader(p)], i: 0, table: gifTableFor(p) };
}

export function gifEncodeNext(st) {
  if (st.i >= st.frames.length) return false;
  st.parts.push(gifFrameBytes(st.p, st.frames[st.i], st.i, st.table));
  st.i++;
  return true;
}

export function gifFinish(st) {
  st.parts.push(gifTrailer());
  return gifConcat(st.parts);
}

export function encodeGif(frames, opts = {}) {
  const st = gifStart(frames, opts);
  while (gifEncodeNext(st));
  return gifFinish(st);
}

// 把「文件头 + 各帧字节 + 收尾」拼成一个完整文件（顺序即帧序）
export function gifConcat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// 帧延时（1/100 秒）：可以是单值或数组；GIF 里 1 会被多数浏览器当 0，钳到 2
export function gifDelayForFps(fps) {
  const v = Math.round(100 / Math.max(1, Number(fps) || 10));
  return Math.max(2, Math.min(65535, v));
}

export function gifFpsForDelay(delay) {
  return 100 / Math.max(1, delay);
}

function normalizeDelays(delay, n) {
  const one = (v) => Math.max(2, Math.min(65535, Math.round(v) || 10));
  const out = new Array(n);
  if (Array.isArray(delay)) {
    for (let i = 0; i < n; i++) out[i] = one(delay[Math.min(i, delay.length - 1)]);
  } else {
    const d = one(delay ?? 10);
    out.fill(d);
  }
  return out;
}

function hasTransparency(data, px) {
  for (let i = 0; i < px; i++) if (data[i * 4 + 3] < 128) return true;
  return false;
}

function buildGlobalPalette(frames, count, transparent) {
  const cap = 65536;
  const total = frames.reduce((s, f) => s + f.width * f.height, 0);
  const stride = Math.max(1, Math.ceil(total / cap));
  const samples = new Uint8Array(Math.min(total, cap) * 3);
  let n = 0;
  outer: for (const f of frames) {
    const px = f.width * f.height;
    for (let i = 0; i < px; i += stride) {
      const p = i * 4;
      if (transparent && f.data[p + 3] < 128) continue;
      samples[n * 3] = f.data[p];
      samples[n * 3 + 1] = f.data[p + 1];
      samples[n * 3 + 2] = f.data[p + 2];
      n++;
      if (n >= samples.length / 3) break outer;
    }
  }
  return paletteOf(samples.subarray(0, n * 3), count, transparent);
}

function buildFramePalette(frame, count, transparent) {
  const f = frame;
  const px = f.width * f.height;
  const stride = Math.max(1, Math.ceil(px / 65536));
  const samples = new Uint8Array(Math.min(px, 65536) * 3);
  let n = 0;
  for (let i = 0; i < px; i += stride) {
    const p = i * 4;
    if (transparent && f.data[p + 3] < 128) continue;
    samples[n * 3] = f.data[p];
    samples[n * 3 + 1] = f.data[p + 1];
    samples[n * 3 + 2] = f.data[p + 2];
    n++;
    if (n >= samples.length / 3) break;
  }
  return paletteOf(samples.subarray(0, n * 3), count, transparent);
}

function paletteOf(rgb, count, transparent) {
  const colors = medianCut(rgb, Math.max(1, count));
  const pal = new Uint8Array(3 + colors.length);
  if (transparent) {
    // 索引 0 = 透明色，RGB 写黑
    pal.set(colors, 3);
    return pal;
  }
  return colors;
}

// 中位切分：每次挑「跨度最大」的盒子，按该跨度通道从中点切开，最后取盒内平均色
function medianCut(rgb, count) {
  const n = rgb.length / 3;
  if (!n) return new Uint8Array([0, 0, 0]);
  const want = Math.min(count, n);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  // 每个盒子自带三通道 min/max：否则每次挑「跨度最大」都要重扫所有盒子的像素，
  // 复杂度是 O(盒子数 × 像素数)，65536 个采样点 × 255 盒 ≈ 5000 万次读，会卡住 UI。
  const mkBox = (lo, hi) => {
    const mn = [255, 255, 255];
    const mx = [0, 0, 0];
    for (let i = lo; i < hi; i++) {
      const p = order[i] * 3;
      for (let ch = 0; ch < 3; ch++) {
        const v = rgb[p + ch];
        if (v < mn[ch]) mn[ch] = v;
        if (v > mx[ch]) mx[ch] = v;
      }
    }
    return { lo, hi, mn, mx };
  };
  const boxes = [mkBox(0, n)];
  while (boxes.length < want) {
    let best = -1;
    let bestR = -1;
    let bestCh = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.hi - b.lo < 2) continue;
      for (let ch = 0; ch < 3; ch++) {
        const r = b.mx[ch] - b.mn[ch];
        if (r > bestR) {
          bestR = r;
          best = i;
          bestCh = ch;
        }
      }
    }
    if (best < 0 || bestR <= 0) break;
    const b = boxes[best];
    const ch = bestCh;
    const sub = Array.prototype.slice.call(order.subarray(b.lo, b.hi));
    sub.sort((x, y) => rgb[x * 3 + ch] - rgb[y * 3 + ch] || x - y);
    order.set(sub, b.lo);
    const mid = b.lo + Math.floor((b.hi - b.lo) / 2);
    boxes.splice(best, 1, mkBox(b.lo, mid), mkBox(mid, b.hi));
  }
  const pal = new Uint8Array(boxes.length * 3);
  boxes.forEach((b, i) => {
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    for (let j = b.lo; j < b.hi; j++) {
      const p = order[j] * 3;
      s0 += rgb[p];
      s1 += rgb[p + 1];
      s2 += rgb[p + 2];
    }
    const c = Math.max(1, b.hi - b.lo);
    pal[i * 3] = Math.floor(s0 / c + 0.5);
    pal[i * 3 + 1] = Math.floor(s1 / c + 0.5);
    pal[i * 3 + 2] = Math.floor(s2 / c + 0.5);
  });
  return pal;
}

// 精确色 → 最近「可用色」下标（调色板里跳过透明占位后的第几个颜色）。
// 逐像素精确匹配；不同颜色数超过 cap 后退化成 5bit 桶（同桶共用一个索引），
// 免得超大图的最近色搜索失控（8192 色 × 256 调色板 ≈ 200 万次比较）。
// sharedBucket 传入跨帧共享的桶表（见 gifTableFor）：桶值是纯函数，共享不影响结果，
// 只是把「每个桶第一次都要线性搜一遍」的预热成本摊到整段动画上。
function nearestCache(palette, transparent, sharedBucket = null, cap = 8192) {
  const base = transparent ? 1 : 0; // 透明时调色板第 0 项是透明占位，不参与最近色
  const colorCount = palette.length / 3;
  const exact = new Map();
  const bucket = sharedBucket ?? new Map();
  let coarse = false;
  const find = (r, g, b) => {
    let best = base;
    let bestD = Infinity;
    for (let i = base; i < colorCount; i++) {
      const dr = palette[i * 3] - r;
      const dg = palette[i * 3 + 1] - g;
      const db = palette[i * 3 + 2] - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best - base;
  };
  const coarseLookup = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let hit = bucket.get(key);
    if (hit === undefined) {
      hit = find(((key >> 10) & 31) * 8 + 4, ((key >> 5) & 31) * 8 + 4, (key & 31) * 8 + 4);
      bucket.set(key, hit);
    }
    return hit;
  };
  return (r, g, b) => {
    if (coarse) return coarseLookup(r, g, b);
    const key = (r << 16) | (g << 8) | b;
    let hit = exact.get(key);
    if (hit !== undefined) return hit;
    if (exact.size >= cap) {
      coarse = true;
      return coarseLookup(r, g, b);
    }
    hit = find(r, g, b);
    exact.set(key, hit);
    return hit;
  };
}

function quantize(frame, palette, table, transparent) {
  const px = frame.width * frame.height;
  const out = new Uint8Array(px);
  const d = frame.data;
  const shift = transparent ? 1 : 0;
  for (let i = 0; i < px; i++) {
    const p = i * 4;
    out[i] = transparent && d[p + 3] < 128 ? 0 : table(d[p], d[p + 1], d[p + 2]) + shift;
  }
  return out;
}

function bitsFor(colors) {
  let b = 1;
  while ((1 << b) < colors) b++;
  return Math.max(2, b);
}

function writePalette(out, palette, bits) {
  out.raw(palette, 0, palette.length);
  const need = (1 << bits) * 3 - palette.length;
  for (let i = 0; i < need; i++) out.byte(0);
}

// 导出仅供 test/gif-lzw-test.mjs 做逐索引闭环（容器以外的 LZW 层单独钉死）
export function lzwEncode(minCodeSize, indices) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let next = eoiCode + 1;
  let dict = new Map();
  const bytes = [];
  let acc = 0;
  let accBits = 0;
  const put = (code) => {
    if (code >= (1 << codeSize)) throw new Error(`LZW 内部错误：码 ${code} 放不进 ${codeSize} 位`);
    acc |= code << accBits;
    accBits += codeSize;
    while (accBits >= 8) {
      bytes.push(acc & 0xff);
      acc >>= 8;
      accBits -= 8;
    }
  };
  put(clearCode);
  if (!indices.length) {
    put(eoiCode);
    if (accBits) bytes.push(acc & 0xff);
    return Uint8Array.from(bytes);
  }
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = (prefix << 8) | indices[i];
    const found = dict.get(k);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    put(prefix);
    // 表满（12 位只有 0..4095 号）就先发 clear 重建，不要把编号 4096 的项写进字典：
    // 它是 12 位之外的编号，解码器把它当有效表项写会越界。
    if (next >= (1 << 12)) {
      put(clearCode);
      dict = new Map();
      next = eoiCode + 1;
      codeSize = minCodeSize + 1;
    } else {
      dict.set(k, next);
      next++;
      // 编码器比解码器早一个代码入表，所以增宽条件必须是 next > 2^codeSize；
      // 写成 == 会让解码器按窄一位的宽度读后面的代码 → broken data stream
      if (next > (1 << codeSize)) codeSize++;
    }
    prefix = indices[i];
  }
  put(prefix);
  put(eoiCode);
  if (accBits) bytes.push(acc & 0xff);
  return Uint8Array.from(bytes);
}

// 可增长的字节缓冲。原来用普通数组逐字节 push 再 Uint8Array.from，
// 一段上千帧的 GIF 就是几千万次 push；现在直接写进 Uint8Array，
// LZW 数据和调色板这种成段的内容用 set 一次搬完。
class ByteSink {
  constructor() {
    this.a = new Uint8Array(1024);
    this.n = 0;
  }
  ensure(k) {
    if (this.n + k <= this.a.length) return;
    let cap = this.a.length * 2;
    while (cap < this.n + k) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.a.subarray(0, this.n));
    this.a = next;
  }
  byte(v) {
    this.ensure(1);
    this.a[this.n++] = v & 0xff;
  }
  bytes(...v) {
    this.ensure(v.length);
    for (const x of v) this.a[this.n++] = x & 0xff;
  }
  u16(v) {
    this.ensure(2);
    this.a[this.n++] = v & 0xff;
    this.a[this.n++] = (v >> 8) & 0xff;
  }
  ascii(s) {
    this.ensure(s.length);
    for (let i = 0; i < s.length; i++) this.a[this.n++] = s.charCodeAt(i) & 0xff;
  }
  raw(buf, off, len) {
    this.ensure(len);
    this.a.set(buf.subarray(off, off + len), this.n);
    this.n += len;
  }
  toUint8Array() {
    return this.a.slice(0, this.n);
  }
}
