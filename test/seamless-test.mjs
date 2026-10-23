// 验证无缝化：两条独立证据链
//   1) 与 test/gen-seamless.py 的 numpy 独立实现逐字节比对（88 组参数）+ 指标数值比对
//   2) 解析式不变量：带外像素不动、强接缝的色差/梯度比值大幅下降、改动面积随宽度单调、
//      透明像素保持透明、越界宽度按 manifest 的 rejects 对齐拒绝
// 两份实现各写各的（这边逐像素两层循环，那边 np.roll + 广播），约定以 src/js/seamless.js 顶部为准。
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSeamless, seamMetrics } from '../src/js/seamless.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fmt', 'seamless');
const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf-8'));
const load = async (f) => new Uint8Array(await readFile(join(dir, f)));

let fail = 0;
const bad = (m) => {
  console.log('FAIL', m);
  fail++;
};
const good = (m) => console.log(' ok  ', m);
const toOpts = (a) => ({ blend: a.pct, keepAlpha: a.keep_alpha, levels: a.levels ?? 0 });

// ---------- 1. 与 numpy 交叉比对 ----------
let runs = 0;
let slow = [0, ''];
for (const c of manifest.cases) {
  const data = await load(c.input);
  const img = { width: c.w, height: c.h, data };
  // 指标也要对得上（seamMetrics 是另一套代码）
  for (const [label, mine] of Object.entries({ lr: 0, tb: 0, edge: 0, grad: 0, ratio: 0 })) {
    const got = seamMetrics(img)[label];
    const exp = c.metrics[label];
    if (!Number.isFinite(got) || Math.abs(got - exp) > 1e-6) bad(`${c.file} 指标 ${label} ${got} != ${exp}`);
  }
  for (const r of c.runs) {
    const t0 = performance.now();
    const got = makeSeamless(img, toOpts(r.args));
    const ms = performance.now() - t0;
    if (ms > slow[0]) slow = [ms, `${c.file} ${JSON.stringify(r.args)}`];
    const exp = await load(r.expect);
    let eq = 0;
    let dmax = 0;
    let at = -1;
    for (let i = 0; i < exp.length; i++) {
      const d = Math.abs(got[i] - exp[i]);
      if (d === 0) eq++;
      if (d > dmax) {
        dmax = d;
        at = i;
      }
    }
    runs++;
    const tag = JSON.stringify(r.args);
    if (dmax > 1) {
      const p = Math.floor(at / 4);
      bad(`${c.file} ${tag} 与 numpy 差 ${dmax} @${p % c.w},${Math.floor(p / c.w)} ` +
        `JS ${Array.from(got.slice(at & ~3, (at & ~3) + 4))} numpy ${Array.from(exp.slice(at & ~3, (at & ~3) + 4))}`);
    } else {
      // 输出指标也要等于 numpy 的期望指标
      const m = seamMetrics({ width: c.w, height: c.h, data: got });
      const dm = Math.max(Math.abs(m.lr - r.metrics.lr), Math.abs(m.tb - r.metrics.tb));
      good(`${c.file} ${tag.padEnd(34)} 逐字节一致 ${eq}/${exp.length} 最大差 ${dmax} 指标差 ${dm.toFixed(5)}` +
        ` 比值 ${c.metrics.ratio.toFixed(1)}→${m.ratio.toFixed(2)}`);
      if (dm > 1e-6) bad(`${c.file} ${tag} 输出指标对不上 ${dm}`);
    }
  }
}

// ---------- 2. 不变量 ----------
{
  // 带外逐字节等于输入（不透明素材 + 保留 alpha 的预乘往返在 a=255 时是恒等）
  for (const name of ['s_ramp', 's_crop', 's_brick']) {
    const c = manifest.cases.find((x) => x.file === name);
    const data = await load(c.input);
    for (const pct of [0.02, 0.1, 0.25, 0.49]) {
      const out = makeSeamless({ width: c.w, height: c.h, data }, { blend: pct, keepAlpha: true });
      const bw = Math.round(c.w * pct);
      const bh = Math.round(c.h * pct);
      let diff = 0;
      for (let y = bh; y < c.h - bh; y++) {
        for (let x = bw; x < c.w - bw; x++) {
          const p = (y * c.w + x) * 4;
          for (let ch = 0; ch < 4; ch++) if (out[p + ch] !== data[p + ch]) diff++;
        }
      }
      diff ? bad(`${name} 宽度 ${pct} 带外被改了 ${diff} 个字节`) : good(`${name} 宽度 ${pct}：带外 ${(c.w - 2 * bw) * (c.h - 2 * bh)} 像素逐字节不动`);
    }
  }
}

{
  // 融合方向：'h' 只走横向一趟、'v' 只走纵向一趟、默认 'both' 与不传 dir 完全一致。
  // 判据是「改动只能落在融合轴的两条带里」：levels=0 带外整列/整行必须逐字节不动；
  // levels>=1 时低频修正本来就会沿融合轴摊开（设计如此），所以上限放宽到 带宽 + 低通半径 r。
  // 只要多跑了另一轴那一趟，带外的列/行必然被改动，这条就能抓到
  //（素材本身沿另一轴恒定时例外，所以每个素材都单独报出 lr/tb）。
  for (const name of ['s_ramp', 's_crop', 's_brick']) {
    const c = manifest.cases.find((x) => x.file === name);
    const data = await load(c.input);
    const img = { width: c.w, height: c.h, data };
    const bm = seamMetrics(img);
    for (const [dir, pct, levels] of [['h', 0.15, 0], ['v', 0.15, 0], ['h', 0.15, 2], ['v', 0.15, 2]]) {
      const out = makeSeamless(img, { blend: pct, dir, levels });
      const len = dir === 'h' ? c.w : c.h;
      const b = Math.round(len * pct);
      const r = levels > 0 ? Math.min(len >> 2, b * (1 << (levels - 1))) : 0;
      const changed = (x, y) => {
        const p = (y * c.w + x) * 4;
        return data[p] !== out[p] || data[p + 1] !== out[p + 1] || data[p + 2] !== out[p + 2] || data[p + 3] !== out[p + 3];
      };
      const problems = [];
      let keep = 0;
      for (let y = 0; y < c.h && !problems.length; y++) {
        for (let x = 0; x < c.w; x++) {
          const along = dir === 'h' ? x : y;
          const edge = Math.min(along, len - 1 - along);
          if (levels === 0 && edge >= b) {
            keep++;
            if (changed(x, y)) problems.push(`带外 (${x},${y}) 被改了`);
          } else if (levels > 0 && edge >= b + r + 1 && changed(x, y)) problems.push(`摊开超出半径 (${x},${y})`);
        }
      }
      if (levels > 0) {
        // 反向确认用例不是空的：这条缝本来存在的话，带内必须有改动
        //（s_ramp 沿 y 恒定，仅纵向本来就无事可做，不能算失效）
        let any = false;
        for (let y = 0; y < c.h && !any; y++) for (let x = 0; x < c.w; x++) if (changed(x, y)) { any = true; break; }
        const seam = dir === 'h' ? bm.lr : bm.tb;
        if (!any && seam > 0.5) problems.push(`该轴本来有色差 ${seam.toFixed(1)} 却毫无改动，用例失效`);
      }
      problems.length
        ? bad(`${name} ${dir} L${levels}：${problems.slice(0, 2).join('；')}`)
        : good(
            `${name} ${dir} L${levels}：改动只落在融合轴那两条带里（${levels ? `带宽 ${b} + 低频摊开 r=${r}，带外整${dir === 'h' ? '列' : '行'}不动` : `带外 ${keep} 像素逐字节不动`}）`,
          );
    }
    // 单轴必须真的把自己那条缝修平：横向管左右边、纵向管上下边
    const before = seamMetrics(img);
    const outH = makeSeamless(img, { blend: 0.15, dir: 'h' });
    const outV = makeSeamless(img, { blend: 0.15, dir: 'v' });
    const def = makeSeamless(img, { blend: 0.15 });
    const mh = seamMetrics({ ...img, data: outH });
    const mv = seamMetrics({ ...img, data: outV });
    const both = seamMetrics({ ...img, data: def });
    const same = (a, b2) => a.length === b2.length && a.every((v, i) => v === b2[i]);
    const problems = [];
    if (mh.lr / mh.grad >= 2) problems.push(`仅横向没修好左右缝 lr/grad=${(mh.lr / mh.grad).toFixed(2)}`);
    if (mv.tb / mv.grad >= 2) problems.push(`仅纵向没修好上下缝 tb/grad=${(mv.tb / mv.grad).toFixed(2)}`);
    // 只修一条缝的那趟不该把另一条缝修得更平（s_ramp 沿 y 恒定，两边都是 0，所以用 >=）
    if (mh.tb < mv.tb - 1e-9) problems.push(`仅横向把上下缝修得比仅纵向还好：${mh.tb.toFixed(1)} < ${mv.tb.toFixed(1)}`);
    if (mv.lr < mh.lr - 1e-9) problems.push(`仅纵向把左右缝修得比仅横向还好：${mv.lr.toFixed(1)} < ${mv.lr.toFixed(1)}`);
    if (!same(makeSeamless(img, { blend: 0.15, dir: 'both' }), def)) problems.push('dir=both 与不传 dir 不一致（默认值变了）');
    // 另一轴本来就没缝（色差 0）时跳过那一趟看不出差别，不能算 dir 没生效
    if (before.tb > 0.5 && same(outH, def)) problems.push('有上下缝但仅横向==双向，dir 没生效');
    if (before.lr > 0.5 && same(outV, def)) problems.push('有左右缝但仅纵向==双向，dir 没生效');
    problems.length
      ? bad(`${name} 方向：${problems.join('；')}`)
      : good(
          `${name} 方向：左右色差 ${before.lr.toFixed(1)} → 仅横 ${mh.lr.toFixed(1)} / 仅纵 ${mv.lr.toFixed(1)} / 双向 ${both.lr.toFixed(1)}；` +
            `上下色差 ${before.tb.toFixed(1)} → 仅纵 ${mv.tb.toFixed(1)} / 仅横 ${mh.tb.toFixed(1)} / 双向 ${both.tb.toFixed(1)}`,
        );
  }
}

{
  // 宽度上限只管被启用的那一轴：16x9 用 0.5 时横带 8+8=16 合法、纵带 5×2>9 非法
  const mk = (v) => {
    const d = new Uint8ClampedArray(16 * 9 * 4);
    for (let i = 0; i < 16 * 9; i++) {
      d[i * 4] = (i * 11) % 256;
      d[i * 4 + 3] = v;
    }
    return { width: 16, height: 9, data: d };
  };
  const img = mk(255);
  const runs = [];
  try {
    makeSeamless(img, { blend: 0.5, dir: 'h' });
    runs.push('仅横向通过');
  } catch (e) {
    bad(`仅横向不该被纵向的宽度上限拦住：${e.message}`);
  }
  for (const dir of ['v', 'both']) {
    try {
      makeSeamless(img, { blend: 0.5, dir });
      bad(`本应拒绝：${dir} 的纵带 5x2 超过图高 9`);
    } catch (e) {
      runs.push(`${dir} 已拒绝`);
    }
  }
  // 宽度 0 时任何方向都等于原图
  let zeroOk = true;
  for (const dir of ['h', 'v', 'both']) {
    const out = makeSeamless(img, { blend: 0, dir });
    for (let i = 0; i < out.length; i++) if (out[i] !== img.data[i]) zeroOk = false;
  }
  zeroOk ? good(`宽度上限只算启用的那一轴：${runs.join('，')}；宽度 0 三种方向都等于原图`) : bad('宽度 0 + dir 不等于原图');
}

{
  // 强接缝输入的「边缘差 / 内部梯度」比值必须明显下降
  for (const name of ['s_ramp', 's_crop', 's_brick']) {
    const c = manifest.cases.find((x) => x.file === name);
    const data = await load(c.input);
    const before = seamMetrics({ width: c.w, height: c.h, data });
    const after = seamMetrics({ width: c.w, height: c.h, data: makeSeamless({ width: c.w, height: c.h, data }, { blend: 0.15 }) });
    after.ratio < before.ratio && after.ratio < 2
      ? good(`${name} 比值 ${before.ratio.toFixed(1)} → ${after.ratio.toFixed(2)}（<2 表示边缘和内部一样平）`)
      : bad(`${name} 比值没降下来：${before.ratio.toFixed(2)} → ${after.ratio.toFixed(2)}`);
  }
}

{
  // 多尺度：带外也会被低频修正轻微带动（这是设计如此），但幅度必须明显小于带内；
  // 同时每一档 levels 都要真的不同于单尺度
  const c = manifest.cases.find((x) => x.file === 's_crop');
  const data = await load(c.input);
  const bw = Math.round(c.w * 0.15);
  const bh = Math.round(c.h * 0.15);
  const base = makeSeamless({ width: c.w, height: c.h, data }, { blend: 0.15, levels: 0 });
  for (const lv of [1, 2, 3, 4]) {
    const out = makeSeamless({ width: c.w, height: c.h, data }, { blend: 0.15, levels: lv });
    let inSum = 0;
    let inCnt = 0;
    let outSum = 0;
    let outCnt = 0;
    let sameAsSingle = true;
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        const p = (y * c.w + x) * 4;
        if (out[p] !== base[p] || out[p + 1] !== base[p + 1] || out[p + 2] !== base[p + 2]) sameAsSingle = false;
        const d = Math.abs(out[p] - data[p]) + Math.abs(out[p + 1] - data[p + 1]) + Math.abs(out[p + 2] - data[p + 2]);
        const inside = x < bw || x >= c.w - bw || y < bh || y >= c.h - bh;
        if (inside) { inSum += d; inCnt++; } else { outSum += d; outCnt++; }
      }
    }
    const mi = inSum / inCnt;
    const mo = outSum / outCnt;
    const errs = [];
    if (sameAsSingle) errs.push('与单尺度完全相同，levels 没生效');
    if (!(mo > 0)) errs.push('带外没有任何低频修正（说明多尺度没摊开）');
    if (!(mi > mo)) errs.push(`带外改动 ${mo.toFixed(2)} 不小于带内 ${mi.toFixed(2)}，低频摊得太狠`);
    errs.length ? bad(`多尺度 levels=${lv}：${errs.join('；')}`)
      : good(`多尺度 levels=${lv}：带内平均改动 ${mi.toFixed(2)}、带外 ${mo.toFixed(2)}（低频摊到全图但幅度更小）`);
  }
}

{
  // 「发虚减轻」：砖墙这种强结构素材，带内的高频能量应比单尺度更接近原图
  const c = manifest.cases.find((x) => x.file === 's_brick');
  const data = await load(c.input);
  const bw = Math.round(c.w * 0.15);
  const bh = Math.round(c.h * 0.15);
  const detail = (d) => {
    let e = 0;
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        if (!(x < bw || x >= c.w - bw || y < bh || y >= c.h - bh)) continue;
        const p = (y * c.w + x) * 4;
        const r = (y * c.w + ((x + 1) % c.w)) * 4;
        const q = (((y + 1) % c.h) * c.w + x) * 4;
        e += Math.abs(d[p] - d[r]) + Math.abs(d[p] - d[q]);
      }
    }
    return e / (c.w * c.h);
  };
  const src = detail(data);
  const rows = [];
  let worse = 0;
  for (const lv of [0, 1, 2, 3, 4]) {
    const e = detail(makeSeamless({ width: c.w, height: c.h, data }, { blend: 0.15, levels: lv }));
    rows.push(`L${lv}=${e.toFixed(2)}`);
    if (lv > 0 && Math.abs(e - src) >= Math.abs(detail(makeSeamless({ width: c.w, height: c.h, data }, { blend: 0.15, levels: 0 })) - src)) worse++;
  }
  worse
    ? bad(`砖墙高频保真没有变好：原图 ${src.toFixed(2)}，${rows.join('  ')}`)
    : good(`砖墙带内高频能量 原图 ${src.toFixed(2)} → ${rows.join('  ')}（多尺度更接近原图 = 不那么糊）`);
}

{
  // 边缘色差不能因为多尺度而反弹：比值仍要 <2，且各档水平相当
  for (const name of ['s_crop', 's_ramp']) {
    const c = manifest.cases.find((x) => x.file === name);
    const data = await load(c.input);
    const rows = [];
    let bad_lv = 0;
    for (const lv of [0, 1, 2, 3, 4]) {
      const m = seamMetrics({ width: c.w, height: c.h, data: makeSeamless({ width: c.w, height: c.h, data }, { blend: 0.15, levels: lv }) });
      rows.push(`L${lv}:${m.lr.toFixed(1)}/${m.tb.toFixed(1)}/${m.ratio.toFixed(2)}`);
      if (m.ratio >= 2) bad_lv++;
    }
    bad_lv ? bad(`${name} 有 ${bad_lv} 档比值 ≥2：${rows.join('  ')}`)
      : good(`${name} 各尺度 lr/tb/比值 ${rows.join('  ')}`);
  }
}

{
  // 融合宽度越大，被改动的像素数单调不减
  const c = manifest.cases.find((x) => x.file === 's_crop');
  const data = await load(c.input);
  let prev = -1;
  const counts = [];
  for (const pct of [0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.49]) {
    const out = makeSeamless({ width: c.w, height: c.h, data }, { blend: pct });
    let n = 0;
    for (let i = 0; i < out.length; i++) if (out[i] !== data[i]) n++;
    counts.push(`${pct}:${n}`);
    if (n < prev) bad(`改动像素数不单调：${pct} 比上一档少（${n} < ${prev}）`);
    prev = n;
  }
  good(`改动像素数随宽度单调不减 ${counts.join('  ')}`);
}

{
  // alpha：a=0 的像素被"唤醒"是 wrap blend 的正常结果（alpha 本身也插值），
  // 关键是唤醒后不能拖出黑边 —— 预乘混合应当给出不比参与混合的源更暗的颜色
  const c = manifest.cases.find((x) => x.file === 's_alpha');
  const data = await load(c.input);
  const pre = makeSeamless({ width: c.w, height: c.h, data }, { blend: 0.15, keepAlpha: true });
  const straight = makeSeamless({ width: c.w, height: c.h, data }, { blend: 0.15, keepAlpha: false });
  let woken = 0;
  let preSum = 0;
  let straightSum = 0;
  let opaqueBad = 0;
  let darkFringe = 0;
  for (let i = 0; i < c.w * c.h; i++) {
    const p = i * 4;
    if (data[p + 3] === 255 && pre[p + 3] !== 255) opaqueBad++;
    if (data[p + 3] === 0 && pre[p + 3] > 0) {
      woken++;
      const a = pre[p + 3] / 255;
      // 还原成"该 alpha 下应有的亮度"再比，避免只比谁更透明
      const kp = 255 / pre[p + 3];
      const ks = 255 / Math.max(1, straight[p + 3]);
      const bp = (pre[p] * kp + pre[p + 1] * kp + pre[p + 2] * kp) / 3;
      const bs = (straight[p] * ks + straight[p + 1] * ks + straight[p + 2] * ks) / 3;
      preSum += bp;
      straightSum += bs;
      if (bs < bp - 1) darkFringe++;
    }
  }
  let zeroKeep = 0;
  for (let i = 0; i < c.w * c.h; i++) {
    const p = i * 4;
    if (data[p + 3] === 0 && pre[p + 3] === 0 && (pre[p] || pre[p + 1] || pre[p + 2])) zeroKeep++;
  }
  const problems = [];
  if (opaqueBad) problems.push(`不透明变半透明 ${opaqueBad}`);
  if (zeroKeep) problems.push(`全透明像素留下了颜色 ${zeroKeep}`);
  if (!(preSum > 0)) problems.push('没有像素被唤醒，用例失效');
  if (straightSum >= preSum) problems.push(`直通混合反而更亮：${straightSum.toFixed(1)} >= ${preSum.toFixed(1)}，预乘没起作用`);
  problems.length
    ? bad(`s_alpha：${problems.join('，')}`)
    : good(
        `s_alpha：不透明保持 255、全透明处不留颜色；被唤醒的 ${woken} 个像素里，` +
          `直通混合更暗的有 ${darkFringe} 个（平均亮度 预乘 ${(preSum / woken).toFixed(1)} vs 直通 ${(straightSum / woken).toFixed(1)}）` +
          ` —— 预乘混合避免拖黑边`,
      );
}

// ---------- 3. 越界宽度按 manifest 的 rejects 对齐 ----------
for (const c of manifest.cases) {
  for (const r of c.rejects || []) {
    const data = await load(c.input);
    try {
      makeSeamless({ width: c.w, height: c.h, data }, toOpts(r.args));
      bad(`本应拒绝：${c.file} ${JSON.stringify(r.args)}`);
    } catch (e) {
      good(`已拒绝：${c.file} ${JSON.stringify(r.args)} -> ${e.message}`);
    }
  }
}

{
  // 宽度 0 = 完全不处理：输出必须逐字节等于输入（含 s_alpha 的低 alpha 像素，
  // 预乘→直通往返会差好几个值，所以这条能守住「0 档就是原图」）
  let checked = 0;
  let bytes = 0;
  for (const c of manifest.cases) {
    const data = await load(c.input);
    const out = makeSeamless({ width: c.w, height: c.h, data }, { blend: 0 });
    let dmax = 0;
    for (let i = 0; i < data.length; i++) dmax = Math.max(dmax, Math.abs(out[i] - data[i]));
    if (dmax) bad(`${c.file} 宽度 0 不等于原图，最大差 ${dmax}`);
    const m = seamMetrics({ width: c.w, height: c.h, data: out });
    if (Math.abs(m.edge - c.metrics.edge) > 1e-9) bad(`${c.file} 宽度 0 的指标不该变化`);
    checked++;
    bytes += data.length;
  }
  good(`宽度 0：${checked} 个素材共 ${bytes} 个字节全部逐字节等于输入，指标不变`);
}

{
  // 参数钳位与非法输入：blend 为负或 0 都当 0，超过 0.5 压到 0.5
  const img = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
  for (let i = 0; i < 64; i++) {
    img.data[i * 4] = (i * 7) % 256;
    img.data[i * 4 + 3] = 255;
  }
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const zero = makeSeamless(img, { blend: 0 });
  const neg = makeSeamless(img, { blend: -5 });
  const tiny = makeSeamless(img, { blend: 0.001 }); // round(8*0.001)=0 → 也等于原图
  const hi = makeSeamless(img, { blend: 99 });
  const hi2 = makeSeamless(img, { blend: 0.5 });
  const orig = Uint8ClampedArray.from(img.data);
  same(zero, orig) && same(neg, orig) && same(tiny, orig) && same(hi, hi2)
    ? good('钳位：0 / 负数 / 0.001 都等于原图，99 等同 0.5')
    : bad(`钳位不成立：0≠原图 ${!same(zero, orig)}，负数 ${!same(neg, orig)}，0.001 ${!same(tiny, orig)}，99≠0.5 ${!same(hi, hi2)}`);
  try {
    makeSeamless({ width: 1, height: 4, data: new Uint8ClampedArray(16) }, {});
    bad('本应拒绝：1x4 太小');
  } catch (e) {
    good(`已拒绝：过小图像 -> ${e.message}`);
  }
  try {
    makeSeamless({ width: 0, height: 0, data: new Uint8ClampedArray(0) }, {});
    bad('本应拒绝：空图');
  } catch (e) {
    good(`已拒绝：空图 -> ${e.message}`);
  }
  try {
    makeSeamless({ width: 9, height: 9, data: new Uint8ClampedArray(9 * 9 * 4) }, { blend: 0.5 });
    bad('本应拒绝：9x9 用 0.5（带宽 5×2>9）');
  } catch (e) {
    good(`已拒绝：奇数尺寸半幅 -> ${e.message}`);
  }
}

// ---------- 4. 素材完整性：自带写入器产出的 TGA/DDS 必须被我们的解码器原样读回 ----------
// 踩过坑：写入器把 RGBA 错换成 G,B,R,A（灰度素材看不出来，彩色素材才暴露），
// 所以彩色素材必须在这里闭环，否则浏览器端拿这些文件做的 TGA/DDS 比对毫无意义。
{
  const { decodeTga } = await import('../src/js/tga.js');
  const { decodeDds } = await import('../src/js/dds.js');
  for (const c of manifest.cases) {
    if (!c.images) continue;
    const raw = await load(c.input);
    for (const ext of ['tga', 'dds']) {
      const bytes = await load(c.images[ext]);
      const got = ext === 'tga' ? decodeTga(bytes) : decodeDds(bytes);
      if (got.width !== c.w || got.height !== c.h) {
        bad(`${c.file}.${ext} 尺寸 ${got.width}x${got.height} != ${c.w}x${c.h}`);
        continue;
      }
      let dmax = 0;
      let at = -1;
      for (let i = 0; i < raw.length; i++) {
        const d = Math.abs(got.data[i] - raw[i]);
        if (d > dmax) {
          dmax = d;
          at = i;
        }
      }
      dmax
        ? bad(`${c.file}.${ext} 写入→解码不闭环，最大差 ${dmax} @${at} 解出 ${Array.from(got.data.slice(at & ~3, (at & ~3) + 4))} 期望 ${Array.from(raw.slice(at & ~3, (at & ~3) + 4))}`)
        : good(`${c.file}.${ext} 写入→解码逐字节闭环（${c.w}x${c.h}）`);
    }
  }
}

console.log(
  fail ? `\n${fail} 个用例失败` : `\n全部通过（交叉比对 ${runs} 组 + 不变量与拒绝用例） 最慢： ${slow[1]} ${slow[0].toFixed(1)}ms`,
);
