// GIF87a/89a 逐帧解码：零依赖、不碰 DOM，node 里能直接 import 跑闭环测试。
// 这里只管「读出结构」和「按 disposal 合成整帧」，canvas、播放时钟、UI 都在 gif-view-page.js。
// 与 test/gif-decode-test.mjs 的 PIL 闭环核对的几条约定：
//   1. LZW 按 LSB 优先读码。解码器入表比编码器晚一个代码，所以增宽条件是
//      「入表后 next === 2^codeSize」；编码器那边是「加完一项后 next > 2^codeSize」（见 gif.js）。
//      抄成编码器那个条件，就会按窄一位的宽度读后面的码 → 整幅花屏。
//   2. 隔行帧是四趟：起点 0/4/2/1、行距 8/4/2/1，索引流里的行序不是 y 直序。
//   3. disposal：0 按 1 处理（画完留着不擦）；1 保留；2 恢复背景；3 恢复画补丁之前的那块矩形。
//      ③ 最容易错 —— 快照范围是这一帧的补丁矩形，不是整幅画布。
//   4. 透明只有一处：GCE 给的透明索引画成 alpha=0，其余索引一律不透明。
//      「恢复背景」（disposal=2）分两种：文件里出现透明索引时擦成 alpha=0，浏览器和 PIL 都是这个
//      约定（PIL 源码注释 "by convention, attempt to use transparency first"）；整段没有任何透明
//      索引时才恢复成逻辑屏幕描述符里的背景色 —— 预览底板是棋盘格，擦成透明正好透出它。
//   5. 延迟单位 1/100 秒。0 和 1 抬到 2（20ms），跟编码端同一条下限：
//      一帧 0ms 会让播放定时器在同一帧上原地打转。
//   6. 补丁帧可以顶到逻辑屏幕外：按逻辑屏幕裁掉越界像素，不报错（现实素材里很常见）。
//   7. GIF87a 没有 GCE：那种帧延迟按 0、disposal 按 0、没有透明索引。

// 一帧的索引流是 1 字节/像素；全部帧加起来超过这个预算就拒绝解码 ——
// 预览要能任意步进，所以整段的索引都得留在内存里
const MAX_INDEX_BYTES = 256 * 1024 * 1024;

class ByteReader {
  constructor(bytes) {
    this.b = bytes;
    this.i = 0;
  }
  u8() {
    if (this.i >= this.b.length) throw new Error('GIF 数据不完整：读到文件尾还差一个字节');
    return this.b[this.i++];
  }
  u16() {
    const lo = this.u8();
    const hi = this.u8();
    return lo | (hi << 8);
  }
  take(n) {
    if (this.i + n > this.b.length) {
      throw new Error(`GIF 数据不完整：需要 ${n} 字节，只剩 ${this.b.length - this.i}`);
    }
    const out = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return out;
  }
  // 子块串：一个长度字节跟那么多字节，长度 0 收尾；返回拼好的一段（不含收尾 0）
  subBlocks() {
    const parts = [];
    let total = 0;
    for (;;) {
      const n = this.u8();
      if (!n) break;
      const part = this.take(n);
      parts.push(part);
      total += n;
    }
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

// 调色板长度是 2^(bits+1) 项；返回拷贝，别把 subarray 视图留到源缓冲之外
function readPalette(r, bits) {
  const n = 1 << (bits + 1);
  return Uint8Array.from(r.take(n * 3));
}

// 隔行帧的行序表：索引流里的第 py 行落在画面的哪一行
const interlaceCache = new Map();
function interlaceMap(h) {
  const hit = interlaceCache.get(h);
  if (hit) return hit;
  const map = new Int32Array(h);
  let o = 0;
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < h; y += step) map[o++] = y;
  }
  interlaceCache.set(h, map);
  return map;
}

// GIF 的 LZW：LSB 优先，码宽随表增长。除了常规码，还要认「code === next」这一种
// 编码器刚发出来、对应表项还没建起来的写法（KwKwK），它等于前一项接上自己的首字节
export function lzwDecode(minCodeSize, data, expect) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let next = endCode + 1;
  // 字典两条并行数组：prefix 指前缀项，suffix 是这一项末尾那个索引字节。
  // 4096 封顶，比 Map 省掉一层哈希，大帧能差出一个量级
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  const out = new Uint8Array(expect);
  let o = 0;
  let bitAcc = 0;
  let bitCount = 0;
  let di = 0;
  let prev = -1;

  const readCode = () => {
    while (bitCount < codeSize) {
      if (di >= data.length) return -1;
      bitAcc |= data[di++] << bitCount;
      bitCount += 8;
    }
    const code = bitAcc & ((1 << codeSize) - 1);
    bitAcc >>>= codeSize;
    bitCount -= codeSize;
    return code;
  };

  for (;;) {
    const code = readCode();
    if (code < 0 || code === endCode) break;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      next = endCode + 1;
      prev = -1;
      continue;
    }
    // 倒着把这一项的索引压进 stack，写完再正序搬出去
    let sp = 0;
    let c = code;
    if (c === next) {
      // KwKwK：这一项的串 = 前一项的串 + 前一项的首字节，所以末尾先压那个首字节
      if (prev < 0) throw new Error(`GIF 数据损坏：KwKwK 码 ${code} 前面没有可用项`);
      let q = prev;
      while (q >= clearCode) q = prefix[q];
      stack[sp++] = q;
      c = prev;
    } else if (c > next) {
      throw new Error(`GIF 数据损坏：LZW 码 ${code} 不在字典里（表只到 ${next}）`);
    }
    while (c >= clearCode) {
      if (sp >= stack.length) throw new Error('GIF 数据损坏：LZW 项的链长得超过一帧');
      stack[sp++] = suffix[c];
      c = prefix[c];
    }
    // c 现在停在一个基础索引上，它既是这一项的首字节，也是最后一个要压进栈的字节
    stack[sp++] = c;
    const firstByte = c;
    if (o + sp > expect) break; // 尾巴上的填充/脏数据：这一帧已经满了，停
    for (let k = sp - 1; k >= 0; k--) out[o++] = stack[k];
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = firstByte;
      next++;
      if (next === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  if (o < expect) {
    throw new Error(`GIF 数据不完整：解出 ${o} 个索引，这一帧要 ${expect} 个`);
  }
  return out;
}

// 解出整个文件：不合成，只给「每帧的补丁 + 它自己的调色板和控制扩展」。
// frames[i] = { x, y, w, h, interlaced, indices, palette, delay, disposal, transparent }
export function parseGif(bytes) {
  const r = new ByteReader(bytes);
  const head = String.fromCharCode(...r.take(6));
  if (head !== 'GIF87a' && head !== 'GIF89a') {
    throw new Error(`不是 GIF 文件：文件头是「${head}」，只认 GIF87a / GIF89a`);
  }
  const width = r.u16();
  const height = r.u16();
  const screenPacked = r.u8();
  const bgIndex = r.u8();
  r.u8(); // 像素宽高比：0 表示没写，用不上
  if (width < 1 || height < 1) throw new Error(`GIF 画面尺寸非法：${width}x${height}`);
  const gct = (screenPacked & 0x80) !== 0 ? readPalette(r, screenPacked & 7) : null;

  const frames = [];
  let loop = null;
  let gce = null;
  let indexBytes = 0;

  for (;;) {
    const block = r.u8();
    if (block === 0x3b) break; // trailer
    if (block === 0x00) continue; // 多余的空块，容忍
    if (block === 0x21) {
      readExtension(r, { setGce: (v) => (gce = v), setLoop: (v) => (loop = v) }, loop);
      continue;
    }
    if (block !== 0x2c) {
      throw new Error(`GIF 结构不认识：块标记 0x${block.toString(16).padStart(2, '0')}`);
    }
    const x = r.u16();
    const y = r.u16();
    const w = r.u16();
    const h = r.u16();
    const packed = r.u8();
    const hasLct = (packed & 0x80) !== 0;
    const interlaced = (packed & 0x40) !== 0;
    const palette = hasLct ? readPalette(r, packed & 7) : gct;
    if (!palette) throw new Error('GIF 没有调色板：既没有全局表，这一帧也没带局部表');
    if (w < 1 || h < 1) throw new Error(`GIF 帧尺寸非法：${w}x${h}`);
    const minCodeSize = r.u8();
    if (minCodeSize < 2 || minCodeSize > 8) {
      throw new Error(`GIF 的 LZW 初始位宽非法：${minCodeSize}（应在 2~8）`);
    }
    const data = r.subBlocks();
    indexBytes += w * h;
    if (indexBytes > MAX_INDEX_BYTES) {
      const mb = (MAX_INDEX_BYTES / 1024 / 1024).toFixed(0);
      throw new Error(`GIF 太大：${frames.length + 1} 帧已经超过 ${mb}MB 索引预算，请换小一点的文件`);
    }
    frames.push({
      x,
      y,
      w,
      h,
      interlaced,
      indices: lzwDecode(minCodeSize, data, w * h),
      palette,
      delay: gce ? gce.delay : 0,
      disposal: gce ? gce.disposal : 0,
      transparent: gce ? gce.transparent : -1,
    });
    gce = null;
  }
  return { width, height, bgIndex, gct, loop, frames };
}

// 扩展块：只有 GCE（0xF9）和 NETSCAPE 循环（0xFF）会留住，注释/明文/其它应用扩展读掉丢弃
function readExtension(r, sink, loopSeen) {
  const label = r.u8();
  const data = r.subBlocks();
  if (label === 0xf9 && data.length >= 4) {
    const packed = data[0];
    sink.setGce({
      // 打包位（MSB→LSB）：保留 3 位 | disposal 3 位 | user input 1 位 | 透明 1 位
      disposal: (packed >> 2) & 0x07,
      transparent: (packed & 0x01) !== 0 ? data[3] : -1,
      delay: data[1] | (data[2] << 8),
    });
    return;
  }
  if (label === 0xff && loopSeen === null) {
    // 拼掉子块长度后是 [11 字节标识「NETSCAPE2.0」][应用码 1][循环次数 u16]；次数 0 是「无限」
    const id = data.length >= 11 ? String.fromCharCode(...data.subarray(0, 11)) : '';
    if (id.startsWith('NETSCAPE') && data.length >= 14 && data[11] === 1) {
      sink.setLoop(data[12] | (data[13] << 8));
    }
  }
}

// 每帧时长（毫秒）：延迟单位是 1/100 秒，0 和 1 抬到 20ms
export function gifDelaysMs(info) {
  return info.frames.map((f) => Math.max(2, f.delay) * 10);
}

// 播放时钟：cum[i] 是第 i 帧的起始偏移，total 是跑完一圈的时长。
// GIF 的每帧延迟本来就可以不等长，所以定位一律按累计时间轴算，不能用固定帧长
export function gifTimeline(info) {
  const ms = gifDelaysMs(info);
  const cum = new Array(ms.length);
  let t = 0;
  for (let i = 0; i < ms.length; i++) {
    cum[i] = t;
    t += ms[i];
  }
  let minMs = ms.length ? ms[0] : 0;
  let maxMs = minMs;
  for (const d of ms) {
    if (d < minMs) minMs = d;
    if (d > maxMs) maxMs = d;
  }
  return {
    ms,
    cum,
    total: t,
    minMs,
    maxMs,
    // 整段的平均帧率：预览页导入后拿它当帧率滑条的初值
    avgFps: t ? (ms.length / (t / 1000)) : 0,
  };
}

// 时刻 → 帧号：t 落在 cum[i] 与 cum[i]+ms[i] 之间的那一帧。cum 单调递增，二分即可
export function frameAtTime(cum, t) {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// 逐帧合成器：GIF 存的是补丁帧，靠 disposal 决定画完之后那块留着、擦成背景、还是退回上一份。
// 状态只能往前推，所以往回跳（拖播放头、上一帧倒退）不能接着 base 改。
// 为了不让「往回拖一帧」等于「从第 0 帧重跑到目标帧」，每 stride 帧存一份 base 快照当检查点：
// 倒退时先贴回最近的那个检查点，最多再顺推 stride 帧。
// stride 按「检查点总内存不超过预算」反推，所以检查点个数一定装得下，不会边存边丢。
const CHECK_BUDGET = 64 * 1024 * 1024;
// 一个像素当 32 位整数写：合成一帧的热度全在逐像素循环上，
// 拆成 4 次字节读写和一次整数写差出两三倍
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x04030201]).buffer)[0] === 1;
const packRGBA = (r, g, b, a) =>
  (LITTLE_ENDIAN ? (a << 24) | (b << 16) | (g << 8) | r : (r << 24) | (g << 16) | (b << 8) | a) >>> 0;

export function createGifCompositor(info) {
  const { width: w, height: h, frames } = info;
  const base = new Uint8ClampedArray(w * h * 4);
  const base32 = new Uint32Array(base.buffer); // 和 base 同一块内存，只是按像素看
  let painted = -1; // base 已经是「画完第 painted 帧并应用完它的 disposal」的状态
  let shown = null; // 第 painted 帧显示时的画面；同一帧重复取直接用缓存
  const frameBytes = w * h * 4;
  // stride 反推自预算：ceil(帧数/stride) 个检查点刚好不超，所以不会出现「存了又丢」
  // 被丢掉的那个位置会让倒退找不着检查点，只能从第 0 帧重跑
  const stride = Math.max(2, Math.ceil((frames.length * frameBytes) / CHECK_BUDGET) || 2);
  const checkMax = Math.ceil(frames.length / stride) + 1;
  const checks = new Map(); // 检查点帧号 -> 那一帧画完之后的 base
  // disposal=2「恢复背景」到底恢复成什么：文件里用了透明索引就擦成 alpha=0（浏览器和 PIL 都是
  // 这个约定 —— PIL 的注释写着 "by convention, attempt to use transparency first"）；
  // 完全没有透明的文件才恢复成逻辑屏幕描述符里的背景色索引
  const usesTransparency = frames.some((f) => f.transparent >= 0);
  const bg = !usesTransparency && info.gct && info.bgIndex * 3 + 2 < info.gct.length
    ? packRGBA(info.gct[info.bgIndex * 3], info.gct[info.bgIndex * 3 + 1], info.gct[info.bgIndex * 3 + 2], 255)
    : 0;

  const rectRange = (f) => {
    const x0 = Math.max(0, f.x);
    const y0 = Math.max(0, f.y);
    const x1 = Math.min(w, f.x + f.w);
    const y1 = Math.min(h, f.y + f.h);
    return { x0, y0, x1, y1 };
  };

  const snapshot = (f) => {
    const { x0, y0, x1, y1 } = rectRange(f);
    if (x1 <= x0 || y1 <= y0) return null;
    const rw = x1 - x0;
    const rh = y1 - y0;
    const buf = new Uint32Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      const src = (y0 + y) * w + x0;
      buf.set(base32.subarray(src, src + rw), y * rw);
    }
    return { buf, x0, y0, x1, y1 };
  };

  const restore = (f, snap) => {
    if (!snap) return;
    const { buf, x0, y0, x1, y1 } = snap;
    const rw = x1 - x0;
    for (let y = y0; y < y1; y++) {
      const src = (y - y0) * rw;
      const dst = y * w + x0;
      base32.set(buf.subarray(src, src + rw), dst);
    }
  };

  const toBackground = (f) => {
    const { x0, y0, x1, y1 } = rectRange(f);
    const rw = x1 - x0;
    for (let y = y0; y < y1; y++) {
      const row = y * w + x0;
      base32.fill(bg, row, row + rw);
    }
  };

  // 索引 -> 打包 RGBA 的查表：一张表跟着「调色板对象 + 透明索引」复用，
  // 整段只有一个全局表的 GIF 建一次就够
  let lutPal = null;
  let lutTr = -1;
  let lut = null;
  const paletteLut = (f) => {
    if (f.palette !== lutPal || f.transparent !== lutTr) {
      const pal = f.palette;
      const out = new Uint32Array(256);
      // 表里没有的索引按不透明黑处理，和逐字节版读到 undefined 写进 Uint8ClampedArray 的结果一致
      out.fill(packRGBA(0, 0, 0, 255));
      for (let i = 0; i * 3 + 2 < pal.length && i < 256; i++) {
        const p = i * 3;
        out[i] = packRGBA(pal[p], pal[p + 1], pal[p + 2], 255);
      }
      lut = out;
      lutPal = f.palette;
      lutTr = f.transparent;
    }
    return lut;
  };

  const drawPatch = (f) => {
    const lut32 = paletteLut(f);
    const tr = f.transparent;
    const idx = f.indices;
    if (!f.interlaced && f.x === 0 && f.y === 0 && f.w === w && f.h === h) {
      // 整幅补丁：边界判断一次都不需要
      for (let i = 0, n = w * h; i < n; i++) {
        const ci = idx[i];
        if (ci !== tr) base32[i] = lut32[ci];
      }
      return;
    }
    const rows = f.interlaced ? interlaceMap(f.h) : null;
    const sx = Math.max(0, -f.x);
    const ex = Math.min(f.w, w - f.x);
    if (ex <= sx) return;
    const dx = Math.max(0, f.x);
    for (let py = 0; py < f.h; py++) {
      const ty = f.y + (rows ? rows[py] : py);
      if (ty < 0 || ty >= h) continue;
      const rowBase = py * f.w;
      const dst = ty * w + dx;
      for (let px = sx; px < ex; px++) {
        const ci = idx[rowBase + px];
        if (ci !== tr) base32[dst + px - sx] = lut32[ci]; // 透明索引：底图留着，不写
      }
    }
  };

  const step = (i, wantOut, out) => {
    const f = frames[i];
    // 只有 disposal=3 需要留快照，而且是这一帧的补丁矩形范围
    const snap = f.disposal === 3 ? snapshot(f) : null;
    drawPatch(f);
    let o = null;
    if (wantOut) {
      if (out) {
        out.set(base);
        o = out;
      } else {
        o = Uint8ClampedArray.from(base);
      }
    }
    if (f.disposal === 2) toBackground(f);
    else if (f.disposal === 3) restore(f, snap);
    return o;
  };

  // 每 stride 帧留一份 base（「画完这一帧并应用完 disposal」之后的状态），倒退时从它续推
  const maybeCheck = (i) => {
    if (i % stride || checks.has(i)) return;
    while (checks.size >= checkMax) checks.delete(checks.keys().next().value);
    checks.set(i, Uint32Array.from(base32));
  };

  return {
    width: w,
    height: h,
    reset() {
      base32.fill(0);
      painted = -1;
      shown = null;
    },
    // 第 i 帧显示时的完整像素（直接喂 putImageData；零帧返回 null）。
    // 传 out 就写进调用方的缓冲（调用方要负责它和缓存的对应关系，这样成片取帧
    // 不必每帧新分配一块，GC 才不会隔几十帧掐一次主线程）；不传才自己分配。
    // 往回跳先贴回最近的下标检查点再顺推，最多补 stride 帧；
    // 检查点就是「从头跑到那一帧」的结果，所以贴回去和真的重跑一模一样
    frame(i, out) {
      if (!frames.length) return null;
      const target = Math.min(frames.length - 1, Math.max(0, i));
      if (target === painted) {
        if (out && shown && out !== shown) out.set(shown);
        return out || shown;
      }
      if (target < painted) {
        // 只认目标之前的检查点：检查点存的是「这一帧画完并处理完 disposal」的状态，
        // 而 frame(target) 要给的是 target 显示时的画面 —— 贴 target 那个点会把擦除后的底交出去
        let c = Math.floor((target - 1) / stride) * stride;
        while (c >= 0 && !checks.has(c)) c -= stride;
        if (c < 0) this.reset();
        else {
          base32.set(checks.get(c));
          painted = c;
        }
      }
      let o = null;
      while (painted < target) {
        painted++;
        o = step(painted, painted === target, out);
        maybeCheck(painted);
      }
      if (o) shown = o;
      return shown;
    },
  };
}
