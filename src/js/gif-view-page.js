// GIF 动画预览页：用自带的 GIF89a 逐帧解码器（gif-decode.js）把每一帧真的合成出来，
// 所以能停在任意一帧上看 disposal 留下的残影。
// 为什么不走 WebView2 的 <img>：它只能整块播，定位不到某一帧，循环回第 1 帧时还会先按
// disposal 清一次底 —— 看着就是闪一下，而逐帧检查正是这个页面要干的事。
// 左栏是预览 + 逐帧 + 帧区间，右栏是导入 / 帧率 / 缩放 / 导出。
import {
  pickImages,
  readEntryBytes,
  isSupportedName,
  GIF_ONLY_EXTS,
  dirname,
  stemOf,
  isTauri,
  resolveSaveDir,
  uniqueFilename,
  seqFilename,
  saveBlob,
} from './platform.js';
import { humanSize } from './decode.js';
import { parseGif, createGifCompositor, gifTimeline, frameAtTime } from './gif-decode.js';
import { gifParams, gifHeader, gifFrameBytes, gifTableFor, gifTrailer, gifConcat } from './gif.js';
import { createIoButtons } from './io-buttons.js';

const $ = (id) => document.getElementById(id);

const FPS_MIN = 1;
const FPS_MAX = 60;
const clampFps = (v) => Math.min(FPS_MAX, Math.max(FPS_MIN, Math.round(v) || FPS_MIN));
// 导出的延时以 1/100 秒写进文件，2 是最小可用值（1 会被多数播放器当 0）
const MIN_MS = 20;
// 合成好的一帧缓存预算：槽位数按它算。和合成器那边的检查点预算（gif-decode.js，64MB）
// 合起来约 128MB —— 大头给检查点，因为「倒退重跑最多几帧」比「多缓存几帧」更影响拖动顺不顺
const CACHE_BUDGET = 64 * 1024 * 1024;
// 调色板样本帧数：整段扫一遍才知道有没有透明，但没必要为每个像素都留一份
const SAMPLES = 12;

// mm:ss.cs —— GIF 的延时精度就是 1/100 秒，读到厘秒才对得上文件里的数
function fmtTime(ms) {
  const t = Math.max(0, Math.round(ms));
  const cs = Math.floor(t / 10) % 100;
  const s = Math.floor(t / 1000) % 60;
  const m = Math.floor(t / 60000) % 100;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function hasAlpha(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) return true;
  return false;
}

export function initGifView({ view }) {
  const info = $('gv-info');
  const frameRange = $('gv-frame-range');
  const frameLabel = $('gv-frame-label');
  const timeLabel = $('gv-time');
  const openBtn = $('gv-open');
  const clearBtn = $('gv-clear');
  const playBtn = $('gv-play');
  const resetBtn = $('gv-reset');
  const prevBtn = $('gv-prev');
  const nextBtn = $('gv-next');
  const status = $('gv-status');
  const fpsRange = $('gv-fps');
  const fpsLabel = $('gv-fps-label');
  const frTl = $('gv-fr-tl');
  const frBand = $('gv-fr-band');
  const frAGrip = $('gv-fr-a');
  const frBGrip = $('gv-fr-b');
  const frAIn = $('gv-fr-a-in');
  const frBIn = $('gv-fr-b-in');
  const frAllBtn = $('gv-fr-all');
  const dropSel = $('gv-drop');
  const scaleSel = $('gv-scale');
  const nameIn = $('gv-name');
  const saveOrigChk = $('gv-save-orig');
  const outInfo = $('gv-out-info');
  const exportBtn = $('gv-export');
  const exportFrameBtn = $('gv-export-frame');
  const io = createIoButtons($('gv-io'), setStatus);

  // 合成器给的是整幅 RGBA，先进这张 canvas 再交给视图缩放画出去。
  // willReadFrequently：既要写进去给视图看，导出时又要读回来缩放，走 CPU 后端
  const paint = document.createElement('canvas');
  const pctx = paint.getContext('2d', { willReadFrequently: true });
  const shrunk = document.createElement('canvas');
  const sctx = shrunk.getContext('2d', { willReadFrequently: true });

  let parsed = null; // parseGif 的结果：尺寸、循环次数、每帧的补丁和延时
  let comp = null; // 逐帧合成器，状态只能往前推
  let srcClock = null; // 原文件的时间轴（每帧自己的延时）
  let play = null; // 播放用的时间轴：已按帧率倍率缩放，且只覆盖选中的帧区间
  let drop = 0; // 抽帧档位：保留帧的间隔是 2^drop
  let keep = []; // 逻辑帧号 -> 源帧号（抽帧后两套编号的唯一桥梁）
  let spanMs = []; // 逻辑帧的时长 = 它和下一保留帧之间所有源帧延时之和
  let name = '';
  let sourcePath = null;
  let fileSize = 0;
  let frameIndex = 0; // 逻辑帧号（抽帧后的编号）
  let cutA = 0; // 帧区间：含头含尾的逻辑帧号
  let cutB = 0;
  let fps = 15;
  let playing = false;
  let playStart = 0; // 起播的绝对时刻，已把当前帧折进基准，所以暂停后是从那一帧接着播
  let playRaf = 0;
  let scrubRaf = 0; // 拖动逐帧滑块时攒帧的 rAF 句柄
  let frDrag = null;
  let runId = 0; // 读文件是异步的，后一次点掉前一次的结果
  let exportId = 0; // 同上：导出中途换文件或清空就作废
  let exporting = false; // GIF 正在编码时不接「导出当前帧」：两件事共用同一批画布和缓存

  // 合成好的一帧缓存：源帧号 -> 槽位下标，像素本身在 slots 里循环复用。
  // 关键是「不再每帧新分配」：800x600 一帧 1.9MB，拖一下滑块就是几百 MB 垃圾，
  // 实测大 GC 每几十帧掐一次主线程（70~90ms），比解码本身还卡
  const cache = new Map();
  const slots = []; // 帧缓冲环
  const owner = []; // 槽位下标 -> 它现在装的是哪一源帧（-1 空着）
  let slotN = 0;
  let slotAt = 0;
  let slotBytes = -1; // 槽位的字节数：换了一张更大的 GIF 就不能拿小槽接着用

  function clearCache() {
    cache.clear();
    const bytes = parsed ? parsed.width * parsed.height * 4 : 0;
    // 至少留 2 个槽，否则「当前帧」和「正在合成的下一帧」会互相踩
    slotN = parsed && bytes ? Math.max(2, Math.min(parsed.frames.length, Math.floor(CACHE_BUDGET / bytes))) : 0;
    if (bytes !== slotBytes) {
      slots.length = 0;
      slotBytes = bytes;
    } else {
      slots.length = Math.min(slots.length, slotN);
    }
    owner.length = slotN;
    owner.fill(-1);
    slotAt = 0;
  }

  function setStatus(msg, warn) {
    status.textContent = msg;
    status.classList.toggle('warn', !!warn);
  }

  function setEnabled(on) {
    for (const el of [
      clearBtn,
      resetBtn,
      prevBtn,
      nextBtn,
      frameRange,
      fpsRange,
      frAIn,
      frBIn,
      frAllBtn,
      dropSel,
      scaleSel,
      nameIn,
      exportBtn,
      exportFrameBtn,
    ]) {
      el.disabled = !on;
    }
    // 单帧 GIF 没什么可播的，按钮留着只会让人以为坏了
    syncPlayBtn();
    frBand.hidden = !on;
    frTl.classList.toggle('loaded', on);
  }

  function syncPlayBtn() {
    playBtn.disabled = !parsed || selFrames() < 2;
  }

  // 该播几圈：NETSCAPE 扩展缺省=1 次，循环数 0=无限，N=N 次
  function repeatCount() {
    if (!parsed) return 1;
    return parsed.loop === 0 ? Infinity : parsed.loop || 1;
  }

  const selFrames = () => (parsed ? cutB - cutA + 1 : 0);

  // 抽帧：从第 1 帧起每 2^drop 帧留 1 帧（1 档隔一删一，2 档再走一遍 = 每 4 帧留 1）。
  // 抽掉的帧把时长并进后面那个保留帧，所以一圈总时长不变，只是节奏变粗
  function rebuildKeep() {
    const n = parsed ? parsed.frames.length : 0;
    const stride = 1 << drop;
    keep = [];
    spanMs = [];
    for (let i = 0; i < n; i += stride) {
      let sum = 0;
      for (let j = i; j < Math.min(n, i + stride); j++) sum += srcClock.ms[j];
      keep.push(i);
      spanMs.push(sum);
    }
  }

  // 逻辑帧号 -> 源帧号；抽帧后合成器和缓存都只认源帧号
  const srcFrame = (k) => keep[k];

  // 选区实际盖住的源帧区间：末帧要算到「下一个保留帧之前」，
  // 否则抽帧后选到最后一格，退回不抽帧会把尾巴上并进来的那几帧丢掉
  function coveredSrcRange() {
    const a = srcFrame(cutA);
    const b = cutB + 1 < keep.length ? srcFrame(cutB + 1) - 1 : parsed.frames.length - 1;
    return [a, b];
  }

  // 帧率滑条相对原文件平均帧率的倍率：按同一个倍率缩放每帧延时，
  // 原文件里快慢不一的节奏（比如末帧停得久）不会被抹平成等长
  function rebuildPlay() {
    if (!parsed) {
      play = null;
      return;
    }
    // 滑条初值就是原文件平均帧率四舍五入，停在这一格时按原样播（倍率 1）：
    // 否则信息行写「一圈 2.10s」、导出写 2.13s，看着像 bug
    const k = !srcClock.avgFps || Math.round(srcClock.avgFps) === fps ? 1 : srcClock.avgFps / fps;
    const ms = new Array(selFrames());
    const cum = new Array(ms.length);
    let t = 0;
    for (let i = 0; i < ms.length; i++) {
      ms[i] = Math.max(MIN_MS, Math.round(spanMs[cutA + i] * k));
      cum[i] = t;
      t += ms[i];
    }
    play = { ms, cum, total: t || 1 };
  }

  function updateInfo() {
    if (!parsed) {
      info.textContent = '未载入 GIF';
      outInfo.textContent = '未载入 GIF';
      return;
    }
    const n = keep.length;
    let minMs = Infinity;
    let maxMs = 0;
    for (const ms of spanMs) {
      if (ms < minMs) minMs = ms;
      if (ms > maxMs) maxMs = ms;
    }
    // 抽帧不改一圈时长，只改帧数，所以平均帧率按抽帧后的帧数算
    const avgFps = srcClock.total ? (n / srcClock.total) * 1000 : 0;
    const delay = minMs === maxMs ? `每帧 ${minMs}ms` : `每帧 ${minMs}~${maxMs}ms`;
    const rep = repeatCount();
    const loopTxt = rep === Infinity ? '无限循环' : rep === 1 ? '不循环（播 1 次）' : `循环 ${rep} 次`;
    const cut = selFrames() === n ? '' : ` · 已选 ${cutA + 1}~${cutB + 1}`;
    const cnt = drop ? `${n} 帧（原 ${parsed.frames.length}，抽帧 1/${1 << drop}）` : `${n} 帧`;
    info.textContent =
      `${parsed.width}x${parsed.height} · ${cnt} · ${delay}` +
      `（平均 ${avgFps.toFixed(1)}fps）· 一圈 ${fmtTime(srcClock.total)} · ${loopTxt}` +
      ` · ${humanSize(fileSize)}${cut}`;
  }

  function updateOutInfo() {
    if (!parsed) return;
    const [w, h] = outSize();
    outInfo.textContent = `${w}x${h} · ${selFrames()} 帧 · ${fmtTime(play.total)}`;
  }

  function outSize() {
    const s = Number(scaleSel.value) / 100;
    return [Math.max(1, Math.round(parsed.width * s)), Math.max(1, Math.round(parsed.height * s))];
  }

  // 逐帧滑块：量程是「选中的这几帧」，所以读数跟着区间走。
  // 区间不是全片时把源帧号也带上 —— 抽过帧之后两套编号已经不是一回事
  function updatePos() {
    const n = keep.length;
    const sel = selFrames();
    frameRange.max = String(sel || 1);
    if (!n) {
      frameRange.value = '1';
      frameLabel.textContent = '-';
      return;
    }
    const k = frameIndex - cutA;
    frameRange.value = String(k + 1);
    frameLabel.textContent =
      sel === n
        ? `第 ${k + 1}/${n} 帧`
        : `第 ${k + 1}/${sel} 帧 · 源 ${srcFrame(frameIndex) + 1}/${parsed.frames.length}`;
  }

  function showFrame(i) {
    if (!comp || !parsed || !parsed.frames.length) return;
    frameIndex = Math.min(cutB, Math.max(cutA, i));
    const rgba = frameOf(frameIndex);
    if (!rgba) return;
    if (paint.width !== parsed.width || paint.height !== parsed.height) {
      paint.width = parsed.width;
      paint.height = parsed.height;
    }
    pctx.putImageData(new ImageData(rgba, parsed.width, parsed.height), 0, 0);
    view.setImage(paint, parsed.width, parsed.height);
    const at = frameIndex - cutA;
    timeLabel.textContent = `${fmtTime(play.cum[at])} / ${fmtTime(play.total)}`;
    updatePos();
  }

  // 合成器只能往前推，倒退要重跑；这一层缓存把「最近看过的帧」留着，
  // 连点上一帧/下一帧或来回拖时一次合成都省掉。键是源帧号：换抽帧档位时同一帧不用重合成
  function frameOf(k) {
    const src = srcFrame(k);
    const hit = cache.get(src);
    if (hit !== undefined) return slots[hit];
    if (!slotN) return null;
    const i = slotAt++ % slotN;
    if (owner[i] >= 0) cache.delete(owner[i]);
    owner[i] = src;
    cache.set(src, i);
    if (!slots[i]) slots[i] = new Uint8ClampedArray(parsed.width * parsed.height * 4);
    return comp.frame(src, slots[i]);
  }

  function stopRaf() {
    if (playRaf) cancelAnimationFrame(playRaf);
    playRaf = 0;
  }

  // 播放位置按「距起播的绝对时刻」推算，不在定时器里累加：主线程忙或窗口被挡住时
  // 回调会晚，用绝对时刻才能自己追平，不会越走越偏
  function tick() {
    playRaf = 0;
    if (!playing || !play) return;
    const total = play.total;
    const e = performance.now() - playStart;
    const rep = repeatCount();
    if (e >= total * rep) {
      // 文件规定只播 N 圈就停在这儿，别偷偷续播（信息行写了「不循环」）
      showFrame(cutB);
      timeLabel.textContent = `${fmtTime(total)} / ${fmtTime(total)}`;
      setPlaying(false);
      return;
    }
    const t = e % total;
    const i = cutA + frameAtTime(play.cum, t);
    if (i !== frameIndex) showFrame(i); // 帧号没变就别重画：60Hz 刷 putImageData 是白干
    timeLabel.textContent = `${fmtTime(t)} / ${fmtTime(total)}`;
    playRaf = requestAnimationFrame(tick);
  }

  function setPlaying(on) {
    playing = !!on && !!parsed && selFrames() >= 2;
    playBtn.textContent = playing ? '暂停' : '播放';
    playBtn.classList.toggle('on', playing);
    stopRaf();
    if (scrubRaf) {
      // 起播/换文件时把攒着的那次拖动丢掉：它画的是上一状态的位置
      cancelAnimationFrame(scrubRaf);
      scrubRaf = 0;
    }
    if (playing) {
      playStart = performance.now() - play.cum[frameIndex - cutA];
      playRaf = requestAnimationFrame(tick);
    }
  }

  function stepFrame(delta) {
    if (!parsed) return;
    if (playing) setPlaying(false); // 步进是「看清这一帧」，在播就先停住
    showFrame(frameIndex + delta);
  }

  // ---------- 帧区间（逻辑帧号，抽过帧之后和源帧号不是一回事） ----------

  function syncFrUI() {
    const n = keep.length;
    frBand.hidden = !n;
    frTl.classList.toggle('loaded', n > 0);
    frAIn.max = String(n || 1);
    frBIn.max = String(n || 1);
    if (!n) return;
    frBand.style.left = `${(cutA / n) * 100}%`;
    frBand.style.width = `${((cutB - cutA + 1) / n) * 100}%`;
    frAIn.value = String(cutA + 1);
    frBIn.value = String(cutB + 1);
  }

  // 拖动期间只挪黄带，松手才重建时间轴（和制作GIF页同一个策略：区间一改，
  // 播放范围和导出帧数都变了，中途那些位置没有意义）
  function setFrameSel(a, b) {
    const n = keep.length;
    cutA = Math.min(n - 1, Math.max(0, a));
    cutB = Math.min(n - 1, Math.max(cutA, b));
    syncFrUI();
  }

  function frameSelCommitted() {
    rebuildPlay();
    updateOutInfo();
    updateInfo();
    syncPlayBtn();
    showFrame(Math.min(cutB, Math.max(cutA, frameIndex)));
    if (playing) playStart = performance.now() - play.cum[frameIndex - cutA];
  }

  function frFrac(e) {
    const r = frTl.getBoundingClientRect();
    return r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
  }

  function frDown(e) {
    const n = keep.length;
    if (n < 2) return;
    const which =
      e.target === frAGrip ? 'a' : e.target === frBGrip ? 'b' : e.target === frBand ? 'band' : null;
    if (!which) return;
    frDrag = {
      which,
      grab: frFrac(e) * n - cutA,
      w: cutB - cutA + 1,
      n,
      was: { a: cutA, b: cutB },
    };
    e.preventDefault();
  }

  function frMove(e) {
    if (!frDrag) return;
    const n = frDrag.n;
    const f = frFrac(e) * n;
    if (frDrag.which === 'a') setFrameSel(Math.floor(f), cutB);
    else if (frDrag.which === 'b') setFrameSel(cutA, Math.ceil(f) - 1);
    else {
      const start = Math.min(Math.max(0, Math.round(f - frDrag.grab)), n - frDrag.w);
      setFrameSel(start, start + frDrag.w - 1);
    }
    e.preventDefault();
  }

  function frUp() {
    if (!frDrag) return;
    const was = frDrag.was;
    frDrag = null;
    if (was.a === cutA && was.b === cutB) return;
    frameSelCommitted();
  }

  // 换抽帧档位：先把选区换算成它实际盖住的源帧区间，再按新格子的编号落回去。
  // 落在被抽掉的位置就顺延到下一个保留帧，所以区间只会变窄不会变空
  function applyDrop(next) {
    if (!parsed || next === drop) return;
    const [a, b] = coveredSrcRange();
    const cur = srcFrame(frameIndex);
    drop = next;
    rebuildKeep();
    const loOf = (src) => {
      for (let k = 0; k < keep.length; k++) if (keep[k] >= src) return k;
      return keep.length - 1;
    };
    const hiOf = (src) => {
      for (let k = keep.length - 1; k >= 0; k--) if (keep[k] <= src) return k;
      return 0;
    };
    const lo = loOf(a);
    setFrameSel(lo, Math.max(lo, hiOf(b)));
    frameIndex = Math.min(cutB, Math.max(cutA, loOf(cur)));
    frameSelCommitted();
  }

  // ---------- 导出 ----------

  // 缩放后的那一帧像素；100% 时直接给原缓冲，省一次画布往返
  function scaledFrame(rgba, sw, sh) {
    if (sw === parsed.width && sh === parsed.height) return rgba;
    if (shrunk.width !== sw || shrunk.height !== sh) {
      shrunk.width = sw;
      shrunk.height = sh;
    }
    pctx.putImageData(new ImageData(rgba, parsed.width, parsed.height), 0, 0);
    sctx.clearRect(0, 0, sw, sh);
    sctx.drawImage(paint, 0, 0, parsed.width, parsed.height, 0, 0, sw, sh);
    return sctx.getImageData(0, 0, sw, sh).data;
  }

  const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

  async function exportTo() {
    if (!parsed) {
      setStatus('还没有载入 GIF', true);
      return;
    }
    const my = ++exportId;
    const keepRun = runId;
    const [sw, sh] = outSize();
    const count = selFrames();
    const delays = play.ms.map((ms) => Math.max(2, Math.round(ms / 10)));
    setPlaying(false);
    exportBtn.disabled = true;
    exporting = true;
    clearCache();
    try {
      // 第一遍：从头合成，扫一遍有没有透明像素，顺手取几帧当全局调色板的样本。
      // 编码参数（调色板、是否透明）必须在写第一帧前定下来，所以这一遍省不掉。
      setStatus('正在取色…');
      const step = Math.max(1, Math.floor(count / SAMPLES));
      const samples = [];
      let transparent = false;
      for (let k = 0; k < count; k++) {
        const rgba = frameOf(cutA + k);
        if (!transparent && hasAlpha(rgba)) transparent = true;
        if (k % step === 0) {
          // 样本要活到第二遍编码之后，而帧缓冲环会覆写槽位，所以等比缩放时
          // scaledFrame 直接回的那个缓冲必须拷一份留下
          const data = scaledFrame(rgba, sw, sh);
          samples.push({ width: sw, height: sh, data: data === rgba ? Uint8ClampedArray.from(data) : data });
        }
        if (k % 16 === 15) {
          setStatus(`正在取色 ${k + 1}/${count} 帧…`);
          await yieldFrame();
          if (my !== exportId || keepRun !== runId) return;
        }
      }
      const p = gifParams(samples, { delay: delays[0], loop: parsed.loop, colors: 256, quality: 'normal', transparent });
      p.delays = delays;
      const table = gifTableFor(p);
      const parts = [gifHeader(p)];
      // 第二遍：再合成一次逐帧编码。第一遍缓存没保住的帧只能重跑，
      // 但 GIF 的状态只能往前推，重跑也就是从头顺推一遍
      setStatus('正在编码…');
      for (let k = 0; k < count; k++) {
        const rgba = frameOf(cutA + k);
        parts.push(gifFrameBytes(p, { width: sw, height: sh, data: scaledFrame(rgba, sw, sh) }, k, table));
        if (k % 16 === 15) {
          setStatus(`正在编码 ${k + 1}/${count} 帧…`);
          await yieldFrame();
          if (my !== exportId || keepRun !== runId) return;
        }
      }
      const bytes = gifConcat([...parts, gifTrailer()]);
      setStatus('正在保存…');
      const dir = await resolveSaveDir(saveOrigChk.checked && sourcePath ? dirname(sourcePath) : null);
      if (isTauri && !dir) {
        setStatus('已取消');
        return;
      }
      // 文件名留空 = 原名_1.gif，按序号往后排；自己填的名字只在撞名时才加后缀。
      // 这页只出 GIF，所以没写 .gif 的一律补上（不能按「有点就当有扩展名」判）
      const typed = nameIn.value.trim();
      const wanted = typed ? (/\.gif$/i.test(typed) ? typed : `${typed}.gif`) : '';
      const fname = wanted
        ? await uniqueFilename(dir, wanted)
        : await seqFilename(dir, stemOf(name) || 'animation', '.gif');
      const saved = await saveBlob(fname, bytes, dir);
      if (saved === null) setStatus('已取消');
      else {
        setStatus(`已导出：${saved}（${humanSize(bytes.length)}）${wanted && fname !== wanted ? '·原名已占用' : ''}`);
        io.setExport(saved);
      }
    } catch (ex) {
      if (my === exportId) setStatus('导出失败：' + (ex?.message ?? ex), true);
    } finally {
      clearCache();
      exporting = false;
      exportBtn.disabled = !parsed;
      if (my === exportId && parsed) {
        comp.reset();
        showFrame(frameIndex);
      }
    }
  }

  // 导出停住的这一帧：无损 PNG，尺寸跟着「等比缩放」。
  // 文件名固定 原名_f帧号，帧号取源文件里的编号 —— 抽过帧之后逻辑帧号会重排，
  // 用它命名会对不上原文件
  async function exportFrame() {
    if (!parsed) {
      setStatus('还没有载入 GIF', true);
      return;
    }
    if (exporting) {
      setStatus('GIF 正在导出，先等它结束', true);
      return;
    }
    const keepRun = runId;
    exportFrameBtn.disabled = true;
    try {
      const rgba = frameOf(frameIndex);
      if (!rgba) return;
      const [sw, sh] = outSize();
      const data = scaledFrame(rgba, sw, sh);
      if (shrunk.width !== sw || shrunk.height !== sh) {
        shrunk.width = sw;
        shrunk.height = sh;
      }
      sctx.putImageData(new ImageData(data, sw, sh), 0, 0);
      const blob = await new Promise((r) => shrunk.toBlob(r, 'image/png'));
      if (!blob) throw new Error('PNG 编码失败');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (keepRun !== runId) return;
      setStatus('正在保存…');
      const dir = await resolveSaveDir(saveOrigChk.checked && sourcePath ? dirname(sourcePath) : null);
      if (isTauri && !dir) {
        setStatus('已取消');
        return;
      }
      const wanted = `${stemOf(name) || 'animation'}_f${srcFrame(frameIndex) + 1}.png`;
      const fname = await uniqueFilename(dir, wanted);
      const saved = await saveBlob(fname, bytes, dir);
      if (saved === null) setStatus('已取消');
      else {
        setStatus(`已导出：${saved}（${humanSize(bytes.length)}）${fname === wanted ? '' : '·原名已占用'}`);
        io.setExport(saved);
      }
    } catch (ex) {
      setStatus('导出当前帧失败：' + (ex?.message ?? ex), true);
    } finally {
      exportFrameBtn.disabled = !parsed;
    }
  }

  // ---------- 载入 ----------

  async function loadEntry(entry) {
    if (!isSupportedName(entry.name, GIF_ONLY_EXTS)) {
      setStatus(`这个页只收 GIF：${entry.name}`, true);
      return;
    }
    const my = ++runId;
    exportId++;
    setPlaying(false);
    setStatus('正在读取…');
    try {
      const bytes = await readEntryBytes(entry);
      if (my !== runId) return;
      if (!bytes.length) throw new Error('文件内容为空');
      setStatus('正在逐帧解码…');
      // 让上面那行字先落地：解码是同步的，大 GIF 会占住主线程几百毫秒
      await new Promise((r) => setTimeout(r, 0));
      if (my !== runId) return;
      const t0 = performance.now();
      const p = parseGif(bytes);
      if (!p.frames.length) throw new Error('这个 GIF 里没有图像帧');
      const ms = performance.now() - t0;
      parsed = p;
      comp = createGifCompositor(p);
      srcClock = gifTimeline(p);
      clearCache();
      name = entry.name;
      sourcePath = entry.path || null;
      fileSize = bytes.length;
      drop = 0;
      dropSel.value = '0';
      nameIn.value = '';
      rebuildKeep();
      frameIndex = 0;
      cutA = 0;
      cutB = keep.length - 1;
      fps = clampFps(srcClock.avgFps || 15);
      fpsRange.value = String(fps);
      fpsLabel.textContent = String(fps);
      rebuildPlay();
      setEnabled(true);
      syncFrUI();
      updateInfo();
      updateOutInfo();
      showFrame(0);
      io.setSource(entry.path);
      io.setExport(null);
      setStatus(`已解码 ${p.frames.length} 帧，用时 ${ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms`);
    } catch (ex) {
      if (my !== runId) return;
      clearImage();
      setStatus('解码失败：' + (ex?.message ?? ex), true);
    }
  }

  function clearImage() {
    runId++; // 正在读的那一次别再落地了
    exportId++;
    setPlaying(false);
    parsed = null;
    comp = null;
    srcClock = null;
    play = null;
    keep = [];
    spanMs = [];
    clearCache();
    name = '';
    sourcePath = null;
    fileSize = 0;
    frameIndex = 0;
    cutA = 0;
    cutB = 0;
    playStart = 0;
    io.clear();
    view.setImage(null);
    setEnabled(false);
    updateInfo();
    updatePos();
    timeLabel.textContent = '00:00.00 / 00:00.00';
    frAIn.value = '1';
    frBIn.value = '1';
    syncFrUI();
  }

  openBtn.addEventListener('click', async () => {
    const entries = await pickImages(false, GIF_ONLY_EXTS, {
      title: '选择要预览的 GIF',
      label: 'GIF 动画',
    });
    if (entries.length) await loadEntry(entries[0]);
  });
  clearBtn.addEventListener('click', () => {
    clearImage();
    setStatus('已清空');
  });
  playBtn.addEventListener('click', () => setPlaying(!playing));
  resetBtn.addEventListener('click', () => {
    if (!parsed) return;
    showFrame(cutA);
    // 在播就从区间起点重新起算，不是回到原来的进度
    if (playing) playStart = performance.now();
  });
  prevBtn.addEventListener('click', () => stepFrame(-1));
  nextBtn.addEventListener('click', () => stepFrame(1));
  // 滑块量程是区间内的相对帧号，所以换算要加回 cutA。
  // 拖动不逐事件合成：一次 mousemove 就解一帧的话，中间那几帧根本不会停留，
  // 却把主线程排满了 —— 攒到下一帧只做一次，而且读的是当时的滑块值，
  // 所以就算中途改了帧区间，补画的也是最新的那一格
  frameRange.addEventListener('input', () => {
    if (playing) setPlaying(false);
    if (scrubRaf) return;
    scrubRaf = requestAnimationFrame(() => {
      scrubRaf = 0;
      showFrame(cutA + Number(frameRange.value) - 1);
    });
  });
  frTl.addEventListener('mousedown', frDown);
  window.addEventListener('mousemove', frMove);
  window.addEventListener('mouseup', frUp);

  fpsRange.addEventListener('input', () => {
    fps = clampFps(Number(fpsRange.value));
    fpsLabel.textContent = String(fps);
    rebuildPlay();
    updateOutInfo();
    showFrame(frameIndex);
    if (playing) playStart = performance.now() - play.cum[frameIndex - cutA];
  });
  const clampedIn = (el) => {
    const n = keep.length;
    return Math.min(n, Math.max(1, Math.round(Number(el.value)) || 1));
  };
  frAIn.addEventListener('change', () => {
    if (!parsed) return;
    setFrameSel(clampedIn(frAIn) - 1, cutB);
    frameSelCommitted();
  });
  frBIn.addEventListener('change', () => {
    if (!parsed) return;
    setFrameSel(cutA, clampedIn(frBIn) - 1);
    frameSelCommitted();
  });
  frAllBtn.addEventListener('click', () => {
    if (!parsed) return;
    setFrameSel(0, keep.length - 1);
    frameSelCommitted();
  });
  dropSel.addEventListener('change', () => applyDrop(Number(dropSel.value) || 0));
  scaleSel.addEventListener('change', () => updateOutInfo());
  exportBtn.addEventListener('click', exportTo);
  exportFrameBtn.addEventListener('click', exportFrame);

  setEnabled(false);
  updateInfo();
  updatePos();
  return { loadEntry };
}
