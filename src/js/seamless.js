// 无缝贴图（tileable / wrap blend）：把一张有接缝的贴图处理成四边周期连续。
// 约定与 test/gen-seamless.py 的 numpy 独立实现逐字节交叉核对（见 test/seamless-test.mjs）：
//   1. 核心是「周期偏移 + 渐变交叉溶解」。设 half = 边长 // 2，对该轴上位置 d：
//        out(d) = (1-u(d))·src(d) + u(d)·src((d - half + 边长) % 边长)
//      也就是把靠边的两条带和图像正中的内容按权重溶解。d=0 取到 src(half)、d=边长-1 取到
//      src(half-1)，而 (half-1, half) 是原图里相邻的一对像素，所以新接缝本身连续；
//      带内取的都是同一张图的连续内容，不引入色偏。
//      这与文档里的「先 roll 半图把缝挪到中心 → 修中心十字缝 → 再 roll 回去」完全等价，少两次搬运。
//   2. u 用 smoothstep：p = 1 - 到最近边缘的距离 / 带宽，u = p·p·(3-2p)。d=0 处 u=1、
//      距离 >= 带宽处 u=0 且两端导数为 0，带外侧不会被拖出第二道缝。
//      带宽 B = round(边长 × 比例)，比例 0..0.5（界面与函数的默认都是 0 = 不处理），要求 2B <= 边长。
//      比例 0（或小到 round 出 0）就是完全不处理，直接原样返回，等于 2x2 预览里看原图的接缝。
//   3. 先横向一趟、再纵向一趟，两趟都只用上一趟的结果；四个角被两趟各覆盖一次。
//      dir 可以只做其中一趟：'h' 只横、'v' 只纵、默认 'both'。不做的那一趟带宽记 0，
//      而 blendAxis 在 band=0 时是恒等拷贝（levels>0 时 wide=u=0 也恒等），所以不用另写分支。
//      levels=0 时，横竖两条带之外的区域逐字节等于输入；levels>=1 时低频修正会摊到全图，
//      带外像素也会跟着微变（这是多尺度的本意，不是 bug）。
//   4. 取整：每趟写出前按 floor(v + 0.5) 量化回 8 位（Uint8Clamped 再把越界的钳到 0..255）。
//      两趟都用 8 位中间缓冲，多尺度那一趟的浮点缓冲只有「一行/一列」的长度，
//      所以 4096x4096 也只占两块 64MB 缓冲。
//   5. 带 alpha 时默认在【预乘空间】混合（alpha 自身也按同权重插值），最后再除回直通值，
//      避免透明边缘被拖出黑边/白边；关掉则直接对直通 RGBA 插值。a=0 的像素除回后记为全 0。
//   6. levels（融合尺度，0..4，默认 0）：低通用沿轴的周期框式滤波，半径 r = min(边长>>2, 带宽 × 2^(levels-1))，
//      半径超过 1/4 图幅时低通退化成接近全图均值，缝治不好还更糊，所以设上限。
//      单尺度发虚的原因是低频分量也在窄带内被换掉（等于把整块中部内容搬到边缘）；
//      把低频改用展宽后的权重混合、高频仍用窄权重，就既不留缝又不糊。
//      wide = box(u, r)，out = [(1-wide)·lo(a) + wide·lo(b)] + [(1-u)·hi(a) + u·hi(b)]；
//      u 与 wide 相同时恒等于单尺度，所以 levels=0 与旧结果逐字节一致。
export function makeSeamless(img, opts = {}) {
  const w = img.width;
  const h = img.height;
  if (!w || !h) throw new Error('图像为空');
  if (w < 2 || h < 2) throw new Error(`贴图太小（${w}x${h}），至少 2x2 才谈得上接缝`);
  const pct = Math.min(0.5, Math.max(0, opts.blend ?? 0));
  const keepAlpha = opts.keepAlpha !== false;
  const levels = Math.min(4, Math.max(0, Math.floor(opts.levels ?? 0)));
  // 融合方向：'both'（默认，横一趟再纵一趟）/ 'h' 只做横向 / 'v' 只做纵向
  const dir = opts.dir === 'h' || opts.dir === 'v' ? opts.dir : 'both';
  const bw = dir === 'v' ? 0 : Math.round(w * pct);
  const bh = dir === 'h' ? 0 : Math.round(h * pct);
  if (bw * 2 > w) throw new Error(`融合宽度太大：横向带 ${bw}x2 超过图宽 ${w}`);
  if (bh * 2 > h) throw new Error(`融合宽度太大：纵向带 ${bh}x2 超过图高 ${h}`);

  const src = img.data;
  // 宽度 0 = 完全不处理。这里必须直接原样返回：预乘→直通的往返在低 alpha 处会差好几个值，
  // 那样「0 档等于原图」就不成立了
  if (bw === 0 && bh === 0) return Uint8ClampedArray.from(src);
  let a = keepAlpha ? toPremul8(src) : Uint8ClampedArray.from(src);
  let b = new Uint8ClampedArray(a.length);
  blendAxis(a, b, w, h, bw, true, levels);
  blendAxis(b, a, w, h, bh, false, levels);
  return keepAlpha ? unPremul8(a) : a;
}

// 沿一个轴的那一趟：levels=0 就是单尺度 (1-u)·自身 + u·半图平移；
// levels>=1 走双频段——沿该轴做一维低通/高通分离，低频用被展宽过的权重，高频仍用窄带权重：
//   r    = min(边长>>2, 带宽 × 2^(levels-1))（沿轴的周期框式低通半径）
//   wide = box(u, r)          （把 smoothstep 权重再展宽，等价于金字塔里逐层模糊的掩膜）
//   out  = [(1-wide)·lo(a) + wide·lo(b)] + [(1-u)·(a-lo(a)) + u·(b-lo(b))]
// u=wide 时上式恒等于 (1-u)·a + u·b，所以 levels=0 与单尺度逐字节一致。
function blendAxis(src, dst, w, h, band, axis, levels) {
  const len = axis ? w : h;
  const other = axis ? h : w;
  const half = len >> 1;
  const u = new Float64Array(len);
  for (let d = 0; d < len; d++) {
    const edge = Math.min(d, len - 1 - d);
    if (edge >= band) continue;
    const p = 1 - edge / band;
    u[d] = p * p * (3 - 2 * p);
  }
  // 内存布局是 index = y*w + x：横向沿 x 走一步跨 1 个像素，纵向沿 y 走一步跨一整行
  const stride = axis ? 1 : w;
  if (levels <= 0) {
    for (let m = 0; m < other; m++) {
      const base = axis ? m * w : m;
      for (let d = 0; d < len; d++) {
        const t = u[d];
        const cur = (base + d * stride) * 4;
        if (t === 0) {
          dst[cur] = src[cur];
          dst[cur + 1] = src[cur + 1];
          dst[cur + 2] = src[cur + 2];
          dst[cur + 3] = src[cur + 3];
          continue;
        }
        const roll = (base + ((d - half + len) % len) * stride) * 4;
        for (let c = 0; c < 4; c++) {
          dst[cur + c] = Math.floor((1 - t) * src[cur + c] + t * src[roll + c] + 0.5);
        }
      }
    }
    return;
  }

  const r = Math.min(len >> 2, band * (1 << (levels - 1)));
  const wide = boxPeriodic(u, r);
  const a1 = new Float64Array(len);
  const b1 = new Float64Array(len);
  const loA = new Float64Array(len);
  const loB = new Float64Array(len);
  for (let m = 0; m < other; m++) {
    const base = axis ? m * w : m;
    for (let c = 0; c < 4; c++) {
      for (let d = 0; d < len; d++) {
        a1[d] = src[(base + d * stride) * 4 + c];
        b1[d] = src[(base + ((d - half + len) % len) * stride) * 4 + c];
      }
      boxPeriodicInto(a1, r, loA);
      boxPeriodicInto(b1, r, loB);
      for (let d = 0; d < len; d++) {
        const hiA = a1[d] - loA[d];
        const hiB = b1[d] - loB[d];
        const v = (1 - wide[d]) * loA[d] + wide[d] * loB[d] + (1 - u[d]) * hiA + u[d] * hiB;
        dst[(base + d * stride) * 4 + c] = Math.floor(v + 0.5);
      }
    }
  }
}

// 周期（环绕）框式一维低通，窗口 2r+1；r=0 时是恒等
function boxPeriodic(src, r) {
  const out = new Float64Array(src.length);
  boxPeriodicInto(src, r, out);
  return out;
}

function boxPeriodicInto(src, r, out) {
  const n = src.length;
  if (r <= 0) {
    out.set(src);
    return;
  }
  // 窗口 2r+1 在周期信号上 = 整圈 q 次 + 余下 rem 个连续样本；后者用滑动和，整体 O(n)。
  // 与 numpy 的 pad+前缀和分解是同一数学、不同写法（求和顺序不同，末位可能差 1）
  const size = 2 * r + 1;
  const q = Math.floor(size / n);
  const rem = size % n;
  let total = 0;
  for (let i = 0; i < n; i++) total += src[i];
  const mod = (i) => ((i % n) + n) % n;
  let s = 0;
  for (let j = 0; j < rem; j++) s += src[mod(-r + j)];
  for (let i = 0; i < n; i++) {
    out[i] = (q * total + s) / size;
    if (rem) s += src[mod(i - r + rem)] - src[mod(i - r)];
  }
}

function toPremul8(data) {
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const k = data[i + 3] / 255;
    out[i] = Math.floor(data[i] * k + 0.5);
    out[i + 1] = Math.floor(data[i + 1] * k + 0.5);
    out[i + 2] = Math.floor(data[i + 2] * k + 0.5);
    out[i + 3] = data[i + 3];
  }
  return out;
}

function unPremul8(pre) {
  const out = new Uint8ClampedArray(pre.length);
  for (let i = 0; i < pre.length; i += 4) {
    const a = pre[i + 3];
    if (a <= 0) continue; // 全透明：保持 (0,0,0,0)
    const k = 255 / a;
    out[i] = Math.floor(pre[i] * k + 0.5);
    out[i + 1] = Math.floor(pre[i + 1] * k + 0.5);
    out[i + 2] = Math.floor(pre[i + 2] * k + 0.5);
    out[i + 3] = a;
  }
  return out;
}

// 接缝质量指标：左右/上下边缘的平均欧氏色差、内部相邻像素平均梯度、以及两者之比。
// 比值远大于 1 说明边缘有肉眼可见的硬缝；处理完应当接近 1（边缘和内部一样平）
export function seamMetrics(img) {
  const w = img.width;
  const h = img.height;
  const d = img.data;
  const dist = (i, j) => {
    const a = d[i] - d[j];
    const b = d[i + 1] - d[j + 1];
    const c = d[i + 2] - d[j + 2];
    return Math.sqrt(a * a + b * b + c * c);
  };
  let lr = 0;
  for (let y = 0; y < h; y++) lr += dist(y * w * 4, (y * w + w - 1) * 4);
  let tb = 0;
  for (let x = 0; x < w; x++) tb += dist(x * 4, ((h - 1) * w + x) * 4);
  let inner = 0;
  let cnt = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w - 1; x++) {
      inner += dist((row + x) * 4, (row + x + 1) * 4);
      cnt++;
    }
  }
  for (let y = 0; y < h - 1; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      inner += dist((row + x) * 4, (row + w + x) * 4);
      cnt++;
    }
  }
  const lrAvg = lr / h;
  const tbAvg = tb / w;
  const grad = inner / cnt;
  const edge = (lrAvg + tbAvg) / 2;
  return { lr: lrAvg, tb: tbAvg, edge, grad, ratio: grad > 0 ? edge / grad : Infinity };
}
