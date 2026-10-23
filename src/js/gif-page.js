// GIF 制作页：图片按网格拆帧，视频按区间抽帧，都编成 GIF。
// 预览两种模式：播放 = 真 <img> 跑编码后的 GIF 字节；逐帧 = canvas 画本地帧（暂停时拖动）。
// 编码在 gif.js（已通过 PIL / Chrome 双向闭环），这里按帧让出主线程，避免长动画把 UI 冻住。
import {
  pickImages,
  readEntryBytes,
  saveBlob,
  resolveSaveDir,
  uniqueFilename,
  isSupportedName,
  isVideoName,
  videoSrc,
  releaseSrc,
  dirname,
  stemOf,
  isTauri,
  GIF_SOURCE_EXTS,
} from './platform.js';
import { decodeToCanvas, FORMAT_NAME, extOf, humanSize } from './decode.js';
import { cellRect, cropCanvas, canvasToImageData } from './image-util.js';
import { autoDetectGrid } from './detect.js';
import {
  gifStart,
  gifEncodeNext,
  gifFinish,
  gifParams,
  gifHeader,
  gifTrailer,
  gifConcat,
  gifDelayForFps,
  gifFpsForDelay,
} from './gif.js';
import { equalizeCanvases } from './layout.js';
import { createIoButtons } from './io-buttons.js';

const $ = (id) => document.getElementById(id);
const SCALE = [100, 75, 50, 25];
// 超过这两个值就提醒：帧数直接决定内存（帧数×宽×高×4 字节）和编码耗时
const FRAME_WARN = 600;
const MEM_WARN_MB = 400;
// 预计抽帧数超过这个上限就不再自动抽帧，让用户先缩短时间段
const MAX_AUTO_FRAMES = 1000;
// 视频改动一次就要重新抽帧，拖框选时不能每帧都抽，用尾随去抖
const DEBOUNCE_MS = 400;

export function initGif({ srcView }) {
  const info = $('gif-info');
  const outInfo = $('gif-out-info');
  const openBtn = $('gif-open');
  const clearBtn = $('gif-clear');
  const colsIn = $('gif-cols');
  const rowsIn = $('gif-rows');
  const scaleSel = $('gif-scale');
  const fpsIn = $('gif-fps');
  const loopSel = $('gif-loop');
  const colorSel = $('gif-colors');
  const qualitySel = $('gif-quality');
  const nameIn = $('gif-name');
  const saveOrigChk = $('gif-save-orig');
  const exportBtn = $('gif-export');
  const status = $('gif-status');
  const preview = $('gif-preview');
  const frameCanvas = $('gif-frame');
  const playBtn = $('gif-play');
  const frameRange = $('gif-frame-range');
  const frameLabel = $('gif-frame-label');
  const video = $('gif-video');
  const vidPlayBtn = $('gif-vid-play');
  const vidResetBtn = $('gif-vid-reset');
  const vidTime = $('gif-vid-time');
  const tl = $('gif-tl');
  const tlBand = $('gif-tl-band');
  const tlA = $('gif-tl-a');
  const tlB = $('gif-tl-b');
  const tlHead = $('gif-tl-head');
  const selModeBtn = $('gif-sel-mode');
  const selInfo = $('gif-sel-info');
  const tIn = $('gif-t-in');
  const tOut = $('gif-t-out');
  const autoBtn = $('gif-auto');

  const relayout = equalizeCanvases($('page-gif'));

  let mode = null; // 'image' | 'video'
  let srcCanvas = null;
  let videoMeta = null; // {src, w, h, duration}
  let videoUrl = null; // 当前挂在 <video> 上的地址，换源或失败时都要释放
  let range = { t0: 0, t1: 0 };
  let sourcePath = null;
  let sourceName = '';
  let sourceBytes = 0;
  // 拆帧/抽帧结果按「源 + 影响像素的参数」缓存；视频抽帧另存「源帧网格」层，
  // 帧率只影响从网格里怎么重采样，不再触发重新抽帧（见 extractFrames / materialize）
  let cache = null;
  let srcCache = null; // 视频抽帧：{key, gridFps, items:[{t, frame}], ms}
  let matMemo = null; // materialize 结果按（网格、帧率）记一份，同一批帧只重采样一次
  let chunkCache = null; // 帧字节缓存：编码参数没变时改循环次数只需重拼文件头
  let pullMs = null; // 最近一次抽帧耗时；缓存命中时为 null
  let curFrames = [];
  let result = null; // {bytes, blobUrl, count, w, h, delay, loops}
  let playing = true;
  let frameIndex = 0;
  let runId = 0;
  let rafId = 0;
  let tlDrag = null; // 时间轴正在拖：{which:'seek'|'a'|'b'|'band', grab, w}
  let debounceId = 0;
  let autoExtract = true; // 关掉后改参数只更新预估，不再自动抽帧编码

  const setStatus = (msg, warn = false) => {
    status.textContent = msg;
    status.classList.toggle('warn', warn);
  };

  const io = createIoButtons($('gif-io'), setStatus);

  // 导出按钮兼作进度条：抽帧、编码各从左边填到满，满了再换下一阶段
  let busy = false;

  function setProgress(phase, ratio = 0) {
    busy = phase === 'pull' || phase === 'encode';
    exportBtn.classList.toggle('busy', busy);
    exportBtn.disabled = !result || busy;
    exportBtn.textContent =
      phase === 'pull' ? '正在抽帧' : phase === 'encode' ? '正在编码' : '导出 GIF';
    if (busy) {
      const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
      exportBtn.style.setProperty('--p', `${pct}%`);
    } else {
      exportBtn.style.removeProperty('--p');
    }
    // 进入和退出都要立刻刷一次：否则暂停时没有 timeupdate，播放头会留在原地
    updateTimeUI();
  }

  const curFps = () => Math.min(50, Math.max(1, Math.round(Number(fpsIn.value)) || 10));
  const clamped = (el, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(el.value)) || lo));
  const gridCount = () => (mode === 'image' ? clamped(colsIn, 1, 128) * clamped(rowsIn, 1, 128) : 0);

  function scalePct() {
    const v = Number(scaleSel.value);
    return SCALE.includes(v) ? v : 100;
  }

  // GIF 单帧长边超过这个值就自动降一档：像素数直接决定抽帧、编码耗时和体积
  const TARGET_EDGE = 640;

  function suggestScale(w, h) {
    const long = Math.max(w, h);
    for (const s of SCALE) if ((long * s) / 100 <= TARGET_EDGE) return s;
    return SCALE[SCALE.length - 1];
  }

  // 源画面尺寸：图片是画布尺寸，视频是轨道尺寸
  function srcSize() {
    if (mode === 'video') return { w: videoMeta.w, h: videoMeta.h };
    if (mode === 'image') return { w: srcCanvas.width, h: srcCanvas.height };
    return { w: 0, h: 0 };
  }

  // 框选区域换算成源像素整数矩形，没框选就是全画面
  function srcPixelRect() {
    const { w, h } = srcSize();
    const s = srcView.select;
    if (!s) return { x: 0, y: 0, w, h };
    const x = Math.round(s.x0 * w);
    const y = Math.round(s.y0 * h);
    return {
      x,
      y,
      w: Math.max(1, Math.round(s.x1 * w) - x),
      h: Math.max(1, Math.round(s.y1 * h) - y),
    };
  }

  // 单帧来自哪里：图片是一格，视频是框选区域
  function frameSourceSize() {
    if (mode === 'image') {
      const cols = clamped(colsIn, 1, 128);
      const rows = clamped(rowsIn, 1, 128);
      const [l, t, r, b] = cellRect(srcCanvas.width, srcCanvas.height, cols, rows, 0);
      return { w: r - l, h: b - t };
    }
    const s = srcPixelRect();
    return { w: s.w, h: s.h };
  }

  function estimate() {
    const src = frameSourceSize();
    const pct = scalePct();
    const w = Math.max(1, Math.round((src.w * pct) / 100));
    const h = Math.max(1, Math.round((src.h * pct) / 100));
    const count =
      mode === 'video' ? Math.max(1, Math.floor((range.t1 - range.t0) * curFps()) + 1) : gridCount();
    return { count, w, h, memMB: (count * w * h * 4) / 1048576 };
  }

  function overLimit(est) {
    return est.count > FRAME_WARN || est.memMB > MEM_WARN_MB;
  }

  // 时长一律显示成 时:分:秒
  function fmtTime(sec) {
    const s = Math.max(0, sec || 0);
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${pad(Math.floor(s / 3600), 2)}:${pad(Math.floor((s % 3600) / 60), 2)}:${pad(
      (s % 60).toFixed(2),
      5
    )}`;
  }

  // GIF 总时长：只说「几分几秒」，四舍五入到整秒就够看（帧延时是整数 1/100 秒，乘完再取整）
  function fmtDur(sec) {
    const t = Math.round(sec);
    if (t < 1) return '不到 1 秒';
    return t >= 60 ? `${Math.floor(t / 60)}分${t % 60}秒` : `${t}秒`;
  }

  // 手动输入的时间：接受纯秒数，也接受 分:秒 和 时:分:秒.厘秒；解不出来给 null
  function parseTime(str) {
    const s = String(str).trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
    if (!/^(\d{1,2}:)?\d{1,2}:\d{1,2}(\.\d+)?$/.test(s)) return null;
    const p = s.split(':').map(Number);
    return p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2];
  }

  // 正在输入的那一格不回写，否则拖手柄/换源会把光标里的字盖掉
  function syncTimeInputs() {
    if (!videoMeta) return;
    if (document.activeElement !== tIn) tIn.value = fmtTime(range.t0);
    if (document.activeElement !== tOut) tOut.value = fmtTime(range.t1);
  }

  function updateInfo() {
    const est = estimate();
    const pulled = `抽帧 ${est.count} 帧 · ${est.w}x${est.h} · 内存约 ${est.memMB.toFixed(0)}MB`;
    if (mode === 'video') {
      // 源帧率是播放采样估出来的（见 playThrough），和总帧数一起出现、一起缺席
      const total = videoMeta.srcFrames
        ? ` · ${videoMeta.srcFps || Math.max(1, Math.round(videoMeta.srcFrames / videoMeta.duration))}fps · 总 ${videoMeta.srcFrames} 帧`
        : '';
      info.textContent =
        `视频 ${videoMeta.w}x${videoMeta.h} · ${fmtTime(videoMeta.duration)}${total} · ` +
        `选段 ${fmtTime(range.t0)}–${fmtTime(range.t1)}\n` +
        pulled;
    } else if (mode === 'image') {
      info.textContent =
        `图像 ${srcCanvas.width}x${srcCanvas.height} · ${humanSize(sourceBytes)} · ` +
        `${FORMAT_NAME[extOf(sourceName)] || '未知'} · 总 ${gridCount()} 帧\n` +
        pulled;
    } else {
      info.textContent = '未载入文件';
      return;
    }
    const stopped = est.count > MAX_AUTO_FRAMES;
    const over = !stopped && overLimit(est);
    info.classList.toggle('warn', stopped || over);
    if (stopped) info.textContent += '（超过 1000 帧，已停止自动生成）';
    else if (over) info.textContent += '（偏大，抽帧和编码会很慢）';
    if (!autoExtract) info.textContent += '（自动生成GIF已关闭）';
  }

  function updateOut(text) {
    outInfo.textContent = text;
  }

  function setEnabled(on) {
    clearBtn.disabled = !on;
    exportBtn.disabled = !on || busy;
    for (const el of [scaleSel, fpsIn, loopSel, colorSel, qualitySel]) el.disabled = !on;
    // 列/行只对图片有意义
    colsIn.disabled = !on || mode !== 'image';
    rowsIn.disabled = !on || mode !== 'image';
  }

  function setVideoUI(on) {
    // 工具行（播放、时间轴、区域/范围）常驻显示，没载入视频时只是禁掉；
    // 三种滑块（白色播放头 + 黄色手柄和黄色选区底）只在有视频时出现
    tlBand.hidden = !on;
    tlHead.hidden = !on;
    // 载入视频后整条时间轴变蓝（表示整段时长），清空/换图片时回到深色底
    tl.classList.toggle('loaded', !!on);
    vidPlayBtn.disabled = !on;
    vidResetBtn.disabled = !on;
    selModeBtn.disabled = !on;
    tIn.disabled = !on;
    tOut.disabled = !on;
    if (on) syncTimeInputs();
    selOn = false;
    syncSelMode();
    relayout();
  }

  // 拆帧：每格裁出来再等比缩到目标尺寸，保持整数像素
  function buildFrames() {
    const cols = clamped(colsIn, 1, 128);
    const rows = clamped(rowsIn, 1, 128);
    const pct = scalePct();
    const key = `i:${sourceName}:${srcCanvas.width}x${srcCanvas.height}:${cols}x${rows}:${pct}`;
    if (cache && cache.key === key) return cache.frames;
    const out = [];
    for (let i = 0; i < cols * rows; i++) {
      const [l, t, r, b] = cellRect(srcCanvas.width, srcCanvas.height, cols, rows, i);
      const frame = scaleCanvas(cropCanvas(srcCanvas, l, t, r, b), pct);
      // gif.js 要的是像素字节数组；直接传 ImageData 会逐像素读成 undefined，整帧量化成黑色
      out.push({ width: frame.width, height: frame.height, data: canvasToImageData(frame).data });
    }
    cache = { key, frames: out };
    return out;
  }

  // 抽帧分两层：
  //   captureGrid 按「网格帧率」把 [t0, t1] 抽成一串源帧，缓存 key 不含帧率；
  //   materialize 按目标帧率从源帧里取「覆盖该时刻的那一帧」。
  // 改帧率不再重新抽帧：降到网格以下零成本（重复帧共享同一份像素），
  // 升到网格以上才按新网格重抽一次。
  async function extractFrames(id) {
    const fps = curFps();
    const pct = scalePct();
    const r = srcPixelRect();
    const key =
      `v:${videoMeta.src}:${range.t0.toFixed(3)}-${range.t1.toFixed(3)}:` +
      `${r.x},${r.y},${r.w},${r.h}:${pct}`;
    if (srcCache && srcCache.key === key && fps <= srcCache.gridFps) {
      pullMs = null;
      return materialize(srcCache.items, srcCache.gridFps, fps);
    }
    const grid = await captureGrid(id, fps, key);
    if (id !== runId) return null;
    pullMs = grid.ms;
    srcCache = grid;
    return materialize(grid.items, grid.gridFps, fps);
  }

  // 一遍 4× 加速播放取帧：seek 每次都要回退到关键帧重解（实测 72ms/帧），
  // 顺序解码整段只解一遍（实测整段 5s 素材 1.26s）。缺的槽交给下面的分段补播和 seek 补。
  const PLAY_RATE = 4;
  const STALL_MS = 2000;
  // 实测单次 seek 平均 53ms、最慢 111ms，用来估算「逐帧补」的成本
  const SEEK_MS = 0.07;

  async function captureGrid(id, fps, key) {
    const pct = scalePct();
    const r = srcPixelRect();
    const outW = Math.max(1, Math.round((r.w * pct) / 100));
    const outH = Math.max(1, Math.round((r.h * pct) / 100));
    const cv = document.createElement('canvas');
    cv.width = outW;
    cv.height = outH;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    const total = Math.max(1, Math.floor((range.t1 - range.t0) * fps) + 1);
    const targets = new Array(total);
    for (let i = 0; i < total; i++) targets[i] = Math.min(range.t1, range.t0 + i / fps);
    const items = new Array(total).fill(null);
    let done = 0;
    const grab = (i) => {
      ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, outW, outH);
      // getImageData 返回的就是新分配的数组，再包一层等于每帧白拷一遍全尺寸
      items[i] = {
        t: targets[i],
        frame: { width: outW, height: outH, data: ctx.getImageData(0, 0, outW, outH).data },
      };
      done++;
      setStatus(`正在抽帧 ${done}/${total}…`);
      setProgress('pull', done / total);
    };
    const wasAt = video.currentTime;
    pauseVideo();
    const t0 = performance.now();
    await playThrough(id, targets, grab, PLAY_RATE);
    // 只补「单格空洞」——就是掉了一帧的常见情况，沿用左边那帧误差不到一个源帧间隔；
    // 连续多格空洞说明播放跟不上，交给下面的分段补播
    let lo = 0;
    while (lo < total && !items[lo]) lo++;
    let hi = total - 1;
    while (hi >= 0 && !items[hi]) hi--;
    for (let i = lo + 1; i < hi; i++) {
      if (items[i] || !items[i - 1]) continue;
      if (!items[i + 1]) continue; // 后面还空着就不算单格空洞
      items[i] = { t: targets[i], frame: items[i - 1].frame };
      done++;
    }
    // 连续空洞按段补：对每段做一遍 1× 短播，一段只付一次 seek 的钱；
    // 只有比逐帧 seek 便宜（段时长 < (段内格数-1)×单次 seek）才值得，否则留给兜底
    const holes = [];
    for (let i = 0; i < total; i++) if (!items[i]) holes.push(i);
    let h = 0;
    while (h < holes.length) {
      let e = h;
      while (e + 1 < holes.length && holes[e + 1] === holes[e] + 1) e++;
      const n = e - h + 1;
      if (n >= 2 && n / fps < (n - 1) * SEEK_MS) {
        await playThrough(id, targets.slice(holes[h], holes[e] + 1), (j) => grab(holes[h] + j), 1);
        if (id !== runId) return null;
      }
      h = e + 1;
    }
    // 还缺的（段首尾、补播又掉帧的）逐帧 seek 兜底
    for (let i = 0; i < total; i++) {
      if (id !== runId) return null;
      if (items[i]) continue;
      await seekVideo(targets[i]);
      if (id !== runId) return null;
      grab(i);
      await idle();
    }
    const ms = performance.now() - t0;
    // 抽完把播放头放回原位，否则源画面一直停在区间最后一帧
    await seekVideo(wasAt);
    srcView.redraw();
    updateTimeUI();
    return { key, gridFps: fps, items, ms };
  }

  // 目标帧率 ≤ 网格帧率时，给每个目标时刻取「起始时刻 ≤ 该时刻」的最近源帧；
  // 重复帧按引用共享，不复制像素。fps === gridFps 时就是原样那批帧。
  function materialize(items, gridFps, fps) {
    if (matMemo && matMemo.src === items && matMemo.fps === fps) return matMemo.frames;
    let out;
    if (fps >= gridFps) {
      out = items.map((it) => it.frame);
    } else {
      const total = Math.max(1, Math.floor((range.t1 - range.t0) * fps) + 1);
      out = new Array(total);
      let j = 0;
      for (let i = 0; i < total; i++) {
        const t = Math.min(range.t1, range.t0 + i / fps);
        while (j + 1 < items.length && items[j + 1].t <= t + 1e-6) j++;
        out[i] = items[j].frame;
      }
    }
    matMemo = { src: items, fps, frames: out };
    return out;
  }

  function playThrough(id, targets, grab, rate = PLAY_RATE) {
    return new Promise((resolve) => {
      // 后台标签/被遮挡窗口里 play() 要拖一秒多才 reject，直接不走这条路
      if (!video.requestVideoFrameCallback || targets.length < 2 || document.hidden) return resolve();
      let settled = false;
      let next = 0;
      let handle = 0;
      let prevStart = null;
      let frameDur = 0;
      let last = performance.now();
      const finish = () => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        video.cancelVideoFrameCallback(handle);
        video.removeEventListener('ended', finish);
        video.pause();
        video.playbackRate = 1;
        resolve();
      };
      const onFrame = (now, meta) => {
        if (settled) return;
        if (id !== runId) return finish();
        last = performance.now();
        const s = meta.mediaTime;
        // mediaTime 是这一帧的起始时刻，帧长只能靠相邻两帧的差估；取最小差，掉帧造成的大间隔不会污染它
        if (prevStart !== null) {
          const delta = s - prevStart;
          if (delta > 1e-6 && (!frameDur || delta < frameDur)) frameDur = delta;
          // 顺手把源帧率记下来，信息行要显示帧率和总帧数
          if (frameDur && !videoMeta.srcFrames) {
            videoMeta.srcFrames = Math.round(videoMeta.duration / frameDur);
            videoMeta.srcFps = Math.round(1 / frameDur);
            updateInfo();
          }
        }
        prevStart = s;
        if (frameDur) {
          // 只认「目标时刻落在 [本帧起始, 起始+帧长)」的帧，和 seek 拿到的帧保持一致；
          // 落不到的（开头几帧、被丢掉帧的窗口）留给后面的分段补播和 seek 补
          while (next < targets.length && targets[next] < s + frameDur - 1e-6) {
            if (targets[next] >= s - 1e-6) grab(next);
            next++;
            if (next >= targets.length) break;
          }
        }
        if (next >= targets.length) return finish();
        handle = video.requestVideoFrameCallback(onFrame);
      };
      // 窗口被最小化时 Chromium 会暂停后台播放，卡住 2 秒就别干等
      const watchdog = setInterval(() => {
        if (performance.now() - last > STALL_MS) finish();
      }, 500);
      video.addEventListener('ended', finish);
      handle = video.requestVideoFrameCallback(onFrame);
      video.currentTime = targets[0];
      video.playbackRate = rate;
      video.play().catch(finish);
    });
  }

  function scaleCanvas(src, pct) {
    if (pct === 100) return src;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round((src.width * pct) / 100));
    c.height = Math.max(1, Math.round((src.height * pct) / 100));
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'medium';
    x.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  // 预览模式切换：播放用 <img>（跑真实字节），暂停用 canvas（可逐帧拖）
  function showFrame(i) {
    if (!curFrames.length) return;
    frameIndex = Math.min(curFrames.length - 1, Math.max(0, i));
    const f = curFrames[frameIndex];
    frameCanvas.width = f.width;
    frameCanvas.height = f.height;
    frameCanvas
      .getContext('2d', { willReadFrequently: true })
      .putImageData(new ImageData(f.data, f.width, f.height), 0, 0);
    frameRange.value = String(frameIndex + 1);
    frameLabel.textContent = `第 ${frameIndex + 1}/${curFrames.length} 帧`;
  }

  // 播放时让「逐帧」滑块跟着动画走：<img> 不暴露当前帧号，但我们的 GIF 每帧延迟固定，
  // 所以按「距离开始播放的时间 / 帧延迟」推算。用绝对时刻算，中途被冻结（后台、卡顿）也会自动追平。
  // 用 setInterval 而不是 rAF：rAF 在窗口不可见时完全不触发，50ms 刷新对 70ms 一帧足够。
  let playStart = 0;
  let playTimer = 0;

  function tickFrameSync() {
    if (!playing || !result) {
      stopFrameSync();
      return;
    }
    const i = Math.floor((performance.now() - playStart) / (result.delay * 10));
    const n = result.loops ? Math.min(i + 1, result.count * result.loops) : i + 1;
    showFrameIndex((n - 1) % result.count);
  }

  function startFrameSync() {
    clearInterval(playTimer);
    playTimer = setInterval(tickFrameSync, 50);
    tickFrameSync();
  }

  function stopFrameSync() {
    clearInterval(playTimer);
    playTimer = 0;
  }

  // 只同步滑块和文字，不画 canvas（画了会和 <img> 打架）
  function showFrameIndex(i) {
    if (i === frameIndex && frameRange.value === String(i + 1)) return;
    frameIndex = i;
    frameRange.value = String(i + 1);
    frameLabel.textContent = `第 ${i + 1}/${result.count} 帧`;
  }

  function setPlaying(on) {
    playing = !!on && !!result;
    playBtn.disabled = !result;
    frameRange.disabled = !result;
    playBtn.textContent = playing ? '暂停动画' : '播放动画';
    refreshPreview();
  }

  function refreshPreview() {
    if (!result) return;
    playBtn.disabled = false;
    frameRange.disabled = false;
    frameRange.max = String(result.count);
    playBtn.textContent = playing ? '暂停动画' : '播放动画';
    if (playing) {
      // 换 #片段 让 <img> 重新解码，动画才会从头播（同一个 blob URL 直接重设不会重启）
      preview.src = `${result.blobUrl}#${Date.now()}`;
      preview.hidden = false;
      frameCanvas.hidden = true;
      playStart = performance.now();
      startFrameSync();
    } else {
      stopFrameSync();
      preview.hidden = true;
      frameCanvas.hidden = false;
      showFrame(Math.min(frameIndex, result.count - 1));
    }
  }

  // 让出主线程用 MessageChannel 而不是 setTimeout：窗口被遮挡/切到后台时
  // setTimeout 会被钳到 1 秒，逐帧让出会把 30ms 的编码拖成 10 秒。
  const idle = () =>
    new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(0);
    });

  // 图片改参数用尾随定时器（rAF 在后台标签里不触发）；视频另加去抖，抽帧太贵
  let pending = false;
  function schedule() {
    if (pending || !mode) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      render();
    }, 0);
  }

  function scheduleVideo() {
    if (!mode) return;
    clearTimeout(debounceId);
    debounceId = setTimeout(render, DEBOUNCE_MS);
  }

  // 参数变了要重算，缓存里只有像素无关的项能留
  function invalidate() {
    cache = null;
    dropSrcCache();
    updateInfo();
  }

  // 源帧网格和它的重采样结果一起丢（网格换了的旧采样没有保留价值）
  function dropSrcCache() {
    srcCache = null;
    matMemo = null;
  }

  async function render() {
    if (!mode) return;
    // 手动模式：参数改动只反映到预估，不碰抽帧和编码
    if (!autoExtract) {
      updateInfo();
      setProgress(null);
      return;
    }
    const est = estimate();
    if (est.count > MAX_AUTO_FRAMES) {
      runId++; // 取消正在跑的抽帧/编码
      updateInfo();
      const hint =
        mode === 'video'
          ? `请把时间段缩短到 ${fmtTime((MAX_AUTO_FRAMES - 1) / curFps())} 以内，或降低帧率。`
          : `请减少列 / 行，把总帧数降到 ${MAX_AUTO_FRAMES} 帧以内。`;
      setStatus(
        `按现在的设置要抽 ${est.count} 帧，超过 ${MAX_AUTO_FRAMES} 帧上限，已停止自动生成。${hint}`,
        true
      );
      setProgress(null);
      return;
    }
    const id = ++runId;
    updateInfo();
    setProgress('pull', 0);
    let frames;
    try {
      frames = mode === 'video' ? await extractFrames(id) : buildFrames();
    } catch (ex) {
      if (id === runId) {
        setStatus('抽帧失败：' + (ex?.message ?? ex), true);
        setProgress(null);
      }
      return;
    }
    if (id !== runId) return;
    if (!frames || !frames.length) {
      setStatus('这一段抽不到帧，检查区间和帧率', true);
      setProgress(null);
      return;
    }
    await encode(id, frames);
  }

  // ---------- 编码 worker 池 ----------
  // 每帧的字节只依赖「编码参数 + 那一帧」，所以可以几个线程分头算、主线程按帧号拼回来，
  // 拼出的字节和主线程逐帧编码完全一致（test/gif-test.mjs 的逐字节比对守着）。
  // 全局调色板和「整段是否用到透明」都必须看全部帧，所以编码仍然只能在抽完之后开始。
  const POOL_MIN_FRAMES = 24; // 帧太少不值得建线程
  const POOL_MAX = 6;
  // 每个 worker 至少摊到这么多帧才划算：21 帧的活儿开池实测 98ms，串行只要 52ms
  // （建线程 + 传参的固定开销约 40ms，得让它在总时间里占比很小才值得）
  const POOL_FRAMES_PER_WORKER = 24;
  const WORKER_URL = new URL('gif-worker.js', import.meta.url);
  let poolBroken = false; // 建不起来或跑挂过一次就不再试，直接用主线程路径

  // 同一批帧的透明标记只扫一次（改颜色 / 循环 / 帧率时会重复编码同一批帧）
  let transMemo = { frames: null, value: false };
  function transparentOf(frames) {
    if (transMemo.frames === frames) return transMemo.value;
    let v = false;
    outer: for (const f of frames) {
      const d = f.data;
      for (let i = 3; i < d.length; i += 4) if (d[i] < 128) { v = true; break outer; }
    }
    transMemo = { frames, value: v };
    return v;
  }

  // 返回 Uint8Array（成功）/ 'cancelled'（参数又变了，这一轮作废）/ 'broken'（worker 用不了）
  function encodePool(id, frames, p) {
    const total = frames.length;
    const cores = navigator.hardwareConcurrency || 2;
    const size = Math.max(1, Math.min(POOL_MAX, cores - 1, Math.ceil(total / POOL_FRAMES_PER_WORKER)));
    if (total < POOL_MIN_FRAMES || size < 2) return Promise.resolve('too-small');
    const slots = [];
    for (let i = 0; i < size; i++) {
      try {
        slots.push({ w: new Worker(WORKER_URL, { type: 'module' }), busy: false });
      } catch {
        for (const s of slots) s.w.terminate();
        return Promise.resolve('broken');
      }
    }
    return new Promise((resolve) => {
      const header = gifHeader(p);
      const chunks = new Array(total);
      const queue = [];
      for (let i = 0; i < total; i++) queue.push(i);
      let done = 0;
      let settled = false;
      const stop = (v) => {
        if (settled) return;
        settled = true;
        for (const s of slots) s.w.terminate();
        resolve(v);
      };
      const pump = () => {
        if (settled) return;
        if (id !== runId) return stop('cancelled');
        while (queue.length) {
          const s = slots.find((x) => !x.busy);
          if (!s) return;
          const i = queue.shift();
          const f = frames[i];
          s.busy = true;
          // 必须复制一份再 transfer，否则主线程缓存里的那帧像素就被搬空了
          const copy = new Uint8ClampedArray(f.data);
          s.w.postMessage({ type: 'frame', index: i, width: f.width, height: f.height, data: copy }, [copy.buffer]);
        }
        if (!slots.some((x) => x.busy)) {
          // chunks 一并交回去：编码参数没变时（改循环次数）可以整批复用，只重拼文件头
          stop({ bytes: gifConcat([header, ...chunks, gifTrailer()]), chunks });
        }
      };
      for (const s of slots) {
        s.w.onmessage = (e) => {
          const m = e.data;
          s.busy = false;
          if (m.type === 'ready') return pump();
          if (m.type === 'error') {
            // 帧本身编不动（数据问题），交回主线程走一遍，让原来的报错文案照常显示；
            // 这不代表 worker 坏了，下次照旧用它
            return stop('error');
          }
          chunks[m.index] = m.bytes;
          done++;
          setStatus(`正在编码 ${done}/${total} 帧…`);
          setProgress('encode', done / total);
          pump();
        };
        s.w.onerror = () => stop('broken');
        s.w.postMessage({ type: 'init', params: p });
      }
      pump();
    });
  }

  async function encode(id, frames) {
    curFrames = frames;
    // GIF 的尺寸就是单帧尺寸（已按等比缩放），不是整张序列图
    const tw = frames[0].width;
    const th = frames[0].height;
    const fps = curFps();
    const opts = {
      delay: gifDelayForFps(fps),
      loop: Number(loopSel.value),
      colors: Number(colorSel.value),
      quality: qualitySel.value,
      transparent: transparentOf(frames), // 同一批帧只扫一次 alpha，改颜色/循环时不必重扫
    };
    const est = estimate();
    // 循环次数只写在文件头里：除 loop 外的编码参数都没变时（改循环 / 帧率不变的重渲染），
    // 直接重拼头，一帧都不用重算
    const chunkHit =
      chunkCache &&
      chunkCache.frames === frames &&
      chunkCache.colors === opts.colors &&
      chunkCache.quality === opts.quality &&
      chunkCache.delay === opts.delay &&
      chunkCache.transparent === opts.transparent;
    let bytes = null;
    let chunks = null;
    let p = null;
    if (chunkHit) {
      chunkCache.p.opts = { ...chunkCache.p.opts, loop: opts.loop };
      bytes = gifConcat([gifHeader(chunkCache.p), ...chunkCache.chunks, gifTrailer()]);
    } else {
      if (overLimit(est)) {
        setStatus(`帧数 ${est.count}、内存约 ${est.memMB.toFixed(0)}MB，偏大，会慢…`, true);
      } else {
        setStatus(`正在编码 0/${frames.length} 帧…`);
      }
      setProgress('encode', 0);
      await idle();
      let err = null;
      // 优先走 worker 池：每帧字节互相独立，几个线程分头算完再按帧号拼起来，字节和单线程一致。
      // 帧太少不值得建线程，或者 worker 建不起来 / 报错，就退回下面的主线程路径。
      if (!poolBroken && frames.length >= POOL_MIN_FRAMES) {
        try {
          p = gifParams(frames, opts);
        } catch (ex) {
          err = ex;
        }
        if (p) {
          const r = await encodePool(id, frames, p);
          if (r === 'cancelled') return;
          if (r === 'broken') poolBroken = true;
          else if (typeof r === 'object') {
            bytes = r.bytes;
            chunks = r.chunks;
          }
          if (poolBroken) setStatus('编码 worker 不可用，已改用主线程…');
        }
      }
      if (bytes === null && !err) {
        try {
          const st = gifStart(frames, opts);
          let done = 0;
          while (gifEncodeNext(st)) {
            done++;
            if (id !== runId) return; // 参数又变了，丢掉这一轮
            setStatus(`正在编码 ${done}/${frames.length} 帧…`);
            setProgress('encode', done / frames.length);
            await idle();
          }
          p = st.p;
          chunks = st.parts.slice(1); // parts[0] 是文件头，其余按帧序排好
          bytes = gifFinish(st);
        } catch (ex) {
          err = ex;
        }
      }
      if (err) {
        if (id === runId) {
          setStatus('编码失败：' + (err?.message ?? err), true);
          setProgress(null);
        }
        return;
      }
      if (id !== runId) return;
      chunkCache = {
        frames,
        p,
        chunks,
        colors: opts.colors,
        quality: opts.quality,
        delay: opts.delay,
        transparent: opts.transparent,
      };
    }
    if (result) URL.revokeObjectURL(result.blobUrl);
    const blob = new Blob([bytes], { type: 'image/gif' });
    result = {
      bytes,
      blobUrl: URL.createObjectURL(blob),
      count: frames.length,
      w: tw,
      h: th,
      delay: opts.delay,
      loops: Number(loopSel.value) || 0,
    };
    refreshPreview();
    setProgress(null);
    updateOut(
      `GIF：${frames.length} 帧  |  ${tw}x${th}  |  每帧 ${opts.delay * 10}ms（约 ${gifFpsForDelay(opts.delay).toFixed(1)}fps）  |  ` +
        `${humanSize(bytes.length)}  |  时长 ${fmtDur((frames.length * opts.delay) / 100)}`
    );
    // 抽帧耗时只在真的抽过这一轮时显示；缓存命中（改帧率降档、改循环/颜色等）标明走了缓存
    const pulled =
      mode === 'video'
        ? pullMs != null
          ? `  |  抽帧 ${Math.round(pullMs)}ms`
          : '  |  抽帧（缓存）'
        : '';
    setStatus(`已生成：${outName()}${pulled}`, overLimit(est));
  }

  // ---------- 视频播放 / 时间轴 ----------

  function seekVideo(t) {
    const dur = videoMeta?.duration ?? 0;
    const tt = Math.min(dur, Math.max(0, t));
    return new Promise((resolve) => {
      // 已经停在这一帧上就不会再发 seeked，直接返回，否则每帧都要白等兜底超时
      if (video.readyState >= 2 && Math.abs(video.currentTime - tt) < 0.001) {
        resolve();
        return;
      }
      const done = () => {
        video.removeEventListener('seeked', done);
        clearTimeout(timer);
        resolve();
      };
      video.addEventListener('seeked', done);
      const timer = setTimeout(done, 4000);
      video.currentTime = tt;
    });
  }

  function updateTimeUI() {
    if (!videoMeta) return;
    const dur = videoMeta.duration;
    tlBand.style.left = `${dur ? (range.t0 / dur) * 100 : 0}%`;
    tlBand.style.width = `${dur ? Math.max(0, ((range.t1 - range.t0) / dur) * 100) : 0}%`;
    // 区间超出 1000 帧上限就把中间的黄底藏掉（和「停止自动生成」用同一个判据）
    tlBand.classList.toggle('over', estimate().count > MAX_AUTO_FRAMES);
    // 抽帧 / 编码时时间轴上不做任何指示：那时播放头被反复 seek 拖着走，看着像乱跳
    if (busy) {
      tlHead.hidden = true;
      return;
    }
    tlHead.hidden = false;
    const cur = video.currentTime;
    vidTime.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    // 拖动中滑块跟着手走，数字跟着真正解出来的那一帧走
    const shown = scrubBusy ? scrubWant : cur;
    tlHead.style.left = `${dur ? (shown / dur) * 100 : 0}%`;
  }

  // 只在选定区间里循环预览。rAF 在窗口被遮挡时不触发，所以 timeupdate（约 4 次/秒）
  // 也要兜底，否则视频会一路播到结尾还不停下来
  function loopRange() {
    if (videoMeta && !video.paused && video.currentTime >= range.t1 - 1e-3) seekVideo(range.t0);
  }

  function tickVideo() {
    if (!videoMeta) return;
    srcView.redraw();
    updateTimeUI();
    loopRange();
    if (video.paused || video.ended) {
      rafId = 0;
      vidPlayBtn.textContent = '播放';
      return;
    }
    rafId = requestAnimationFrame(tickVideo);
  }

  // at 给了就直接从那个时刻播（重置按钮用）；不给就接着当前位置播，跑出区间才回起点
  function playVideo(at) {
    if (!videoMeta) return;
    if (at !== undefined) video.currentTime = at;
    else if (video.currentTime < range.t0 || video.currentTime >= range.t1 - 1e-3) {
      seekVideo(range.t0);
    }
    video.play().catch(() => setStatus('播放失败：' + (video.error?.message || '未知原因'), true));
    vidPlayBtn.textContent = '暂停';
    if (!rafId) rafId = requestAnimationFrame(tickVideo);
  }

  function pauseVideo() {
    if (!videoMeta) return;
    video.pause();
    vidPlayBtn.textContent = '播放';
  }

  function setRange(t0, t1) {
    const dur = videoMeta?.duration ?? 0;
    // 区间至少要有一帧的长度，否则抽不到帧
    const min = 1 / curFps();
    range.t0 = Math.min(Math.max(0, t0), Math.max(0, dur - min));
    range.t1 = Math.max(Math.min(dur, t1), range.t0 + min);
    syncTimeInputs();
    updateTimeUI();
  }

  function tlFrac(e) {
    const r = tl.getBoundingClientRect();
    return r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
  }

  // 时间轴：点空白或拖空白 = 定位播放头；拖两端手柄 = 调起点/终点；拖中间带 = 整段平移
  function tlDown(e) {
    if (!videoMeta) return;
    const dur = videoMeta.duration;
    const t = tlFrac(e) * dur;
    const which =
      e.target === tlA ? 'a' : e.target === tlB ? 'b' : e.target === tlBand ? 'band' : 'seek';
    tlDrag = { which, grab: t - range.t0, w: range.t1 - range.t0, was: { ...range } };
    pauseVideo();
    if (which === 'seek') tlSeekTo(t);
    e.preventDefault();
  }

  // 拖手柄期间只更新区间和预估，松手才真的重新抽帧（不然一边拖一边抽，全是被中途作废的活）
  function tlUp() {
    if (!tlDrag) return;
    const d = tlDrag;
    tlDrag = null;
    if (d.which === 'seek') return;
    if (range.t0 === d.was.t0 && range.t1 === d.was.t1) return; // 只点了一下没挪动
    rangeChanged();
  }

  function tlMove(e) {
    if (!tlDrag || !videoMeta) return;
    const dur = videoMeta.duration;
    const t = tlFrac(e) * dur;
    const min = 1 / curFps();
    if (tlDrag.which === 'a') {
      setRange(Math.min(t, range.t1 - min), range.t1);
      updateInfo();
    } else if (tlDrag.which === 'b') {
      setRange(range.t0, Math.max(t, range.t0 + min));
      updateInfo();
    } else if (tlDrag.which === 'band') {
      const w = tlDrag.w;
      const start = Math.min(Math.max(0, t - tlDrag.grab), Math.max(0, dur - w));
      setRange(start, start + w);
      updateInfo();
    } else {
      tlSeekTo(t);
    }
  }

  // 拖动浏览：一次只让一个 seek 在飞，期间只记最新目标，落地后再追一次。
  // 不这么做的话 mousemove 一秒上百次会把 seek 排成长队（实测单次 seek 平均 53ms、最慢 111ms），
  // 松手后画面还在自己乱跳。Chromium 没有 fastSeek，只能靠合并。
  let scrubWant = 0;
  let scrubBusy = false;

  function tlSeekTo(t) {
    if (!videoMeta) return;
    scrubWant = t;
    const dur = videoMeta.duration || 1;
    tlHead.style.left = `${Math.min(100, Math.max(0, (t / dur) * 100))}%`; // 滑块先跟手，画面随后补上
    pumpScrub();
  }

  function pumpScrub() {
    if (scrubBusy || !videoMeta) return;
    const t = scrubWant;
    scrubBusy = true;
    seekVideo(t).then(() => {
      scrubBusy = false;
      srcView.redraw();
      updateTimeUI();
      // 拖动过程中目标又变了就立刻追上去
      if (Math.abs(scrubWant - t) > 1e-3) pumpScrub();
    });
  }

  function rangeChanged() {
    invalidate();
    scheduleVideo();
  }

  // 框选开关：默认关（全画面）。点开才能框选，选完仍可拖手柄/框内移动；
  // 再点一次就是取消 —— 清掉选区回到全画面。没有单独的「全画面」按钮了。
  let selOn = false;

  function syncSelMode() {
    const active = mode === 'video' && selOn;
    srcView.setSelectEnabled(active);
    selModeBtn.classList.toggle('on', active);
  }

  function updateSelInfo() {
    if (mode !== 'video') {
      selInfo.textContent = '-';
      return;
    }
    const r = srcPixelRect();
    const full = r.w === videoMeta.w && r.h === videoMeta.h;
    selInfo.textContent = full ? '全画面' : `${r.w}x${r.h}`;
  }

  // ---------- 载入 ----------

  function videoErrMsg() {
    const code = video.error?.code;
    if (code === 4 || code === 3) {
      return '解码失败：这个容器或编码放不了（AVI / WMV / MPG 常见；HEVC/H.265 要看本机解码器），请转成 MP4（H.264）或 WEBM（VP8/VP9）再试';
    }
    if (code === 2) return '读取失败：文件被占用或路径不可访问';
    if (code === 1) return '加载被中止';
    return `加载失败（code=${code ?? '未知'}）`;
  }

  // 摘下当前视频：停播、清 src、释放 blob URL。asset URL 不用释放
  function detachVideo() {
    pauseVideo();
    if (videoUrl) releaseSrc(videoUrl);
    videoUrl = null;
    videoMeta = null;
    if (video.getAttribute('src')) {
      video.removeAttribute('src');
      video.load();
    }
  }

  async function loadVideo(entry) {
    const url = videoSrc(entry);
    if (!url) throw new Error('拿不到视频地址');
    detachVideo();
    videoUrl = url;
    try {
      await new Promise((resolve, reject) => {
        const ok = () => {
          cleanup();
          resolve();
        };
        const bad = () => {
          cleanup();
          reject(new Error(videoErrMsg()));
        };
        const cleanup = () => {
          video.removeEventListener('loadedmetadata', ok);
          video.removeEventListener('error', bad);
        };
        video.addEventListener('loadedmetadata', ok);
        video.addEventListener('error', bad);
        video.src = url;
        video.load();
      });
      if (!video.videoWidth || !video.videoHeight) throw new Error('这个视频没有可解码的画面轨道');
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (!(duration > 0)) throw new Error('读不到视频时长，可能是流式或损坏的文件');
      videoMeta = { src: url, w: video.videoWidth, h: video.videoHeight, duration };
    } catch (ex) {
      detachVideo();
      throw ex;
    }
    mode = 'video';
    srcCanvas = null;
    srcView.setSelect(null);
    srcView.setImage(video, videoMeta.w, videoMeta.h);
    // 等第一帧真解出来，否则 drawImage 画到的是空白
    await new Promise((resolve) => {
      if (video.readyState >= 2) return resolve();
      video.addEventListener('loadeddata', resolve, { once: true });
    });
    await seekVideo(0);
    srcView.redraw();
    setRange(0, videoMeta.duration);
    const s = suggestScale(videoMeta.w, videoMeta.h);
    scaleSel.value = String(s);
    setVideoUI(true);
    setEnabled(true);
    updateSelInfo();
    updateInfo();
    setStatus(`已载入视频：${entry.name}（${videoMeta.w}x${videoMeta.h}，${videoMeta.duration.toFixed(2)}s）`);
    render();
  }

  async function loadImage(entry) {
    const bytes = await readEntryBytes(entry);
    if (!bytes.length) throw new Error('文件内容为空');
    sourceBytes = bytes.length;
    srcCanvas = await decodeToCanvas(entry.name, bytes);
    detachVideo();
    mode = 'image';
    srcView.setSelect(null);
    srcView.setImage(srcCanvas, srcCanvas.width, srcCanvas.height);
    const g = autoDetectGrid(srcCanvas, entry.name);
    colsIn.value = String(g.cols);
    rowsIn.value = String(g.rows);
    // 按「一格」的尺寸而不是整张序列图来判缩放
    scaleSel.value = String(suggestScale(srcCanvas.width / g.cols, srcCanvas.height / g.rows));
    setVideoUI(false);
    setEnabled(true);
    updateSelInfo();
    updateInfo();
    render();
  }

  async function loadEntry(entry) {
    if (!isSupportedName(entry.name, GIF_SOURCE_EXTS)) {
      setStatus('不支持的格式：' + entry.name, true);
      return;
    }
    runId++;
    clearTimeout(debounceId);
    pauseVideo();
    setStatus('正在载入…');
    await idle();
    sourcePath = entry.path;
    sourceName = entry.name;
    nameIn.value = '';
    cache = null;
    dropSrcCache();
    chunkCache = null;
    io.setSource(entry.path);
    io.setExport(null);
    frameIndex = 0;
    playing = true;
    try {
      if (isVideoName(entry.name)) await loadVideo(entry);
      else await loadImage(entry);
    } catch (ex) {
      mode = null;
      srcCanvas = null;
      detachVideo();
      srcView.setImage(null);
      setVideoUI(false);
      setEnabled(false);
      setPlaying(false);
      updateInfo();
      setStatus('载入失败：' + (ex?.message ?? ex), true);
      setProgress(null);
    }
  }

  function clearImage() {
    if (!mode) return;
    runId++;
    clearTimeout(debounceId);
    setProgress(null);
    detachVideo();
    // 时间轴回到没载入过东西的样子，别留着上一个视频的选区和播放头
    range = { t0: 0, t1: 0 };
    tlBand.style.left = '0%';
    tlBand.style.width = '100%';
    tlHead.style.left = '0%';
    tlHead.hidden = true;
    vidTime.textContent = '00:00:00 / 00:00:00';
    tIn.value = '';
    tOut.value = '';
    mode = null;
    srcCanvas = null;
    cache = null;
    dropSrcCache();
    chunkCache = null;
    curFrames = [];
    sourcePath = null;
    sourceName = '';
    sourceBytes = 0;
    io.clear();
    if (result) {
      URL.revokeObjectURL(result.blobUrl);
      result = null;
    }
    preview.removeAttribute('src');
    preview.hidden = true;
    frameCanvas.hidden = true;
    frameRange.max = '1';
    frameRange.value = '1';
    frameLabel.textContent = '-';
    nameIn.value = '';
    srcView.setSelect(null);
    srcView.setImage(null);
    setVideoUI(false);
    setEnabled(false);
    setPlaying(false);
    updateInfo();
    updateSelInfo();
    updateOut('GIF：-  |  尺寸：-  |  体积：-');
    setStatus('');
  }

  function outName() {
    const stem = nameIn.value.trim() || (sourceName ? stemOf(sourceName) : 'animation');
    return /\.gif$/i.test(stem) ? stem : `${stem}.gif`;
  }

  async function exportTo() {
    if (!result) {
      setStatus('还没有生成 GIF', true);
      return;
    }
    let dir = saveOrigChk.checked && sourcePath ? dirname(sourcePath) : null;
    dir = await resolveSaveDir(dir);
    if (isTauri && !dir) return;
    // 目录里已有同名 GIF 就自动加 _1、_2，别把原来的覆盖掉
    const name = await uniqueFilename(dir, outName());
    const saved = await saveBlob(name, result.bytes, dir);
    setStatus(
      saved === null
        ? '已取消'
        : `已导出：${saved}（${humanSize(result.bytes.length)}）` + (name !== outName() ? `·原名已占用` : '')
    );
    io.setExport(dir && saved ? saved : null);
  }

  // ---------- 事件 ----------

  openBtn.addEventListener('click', async () => {
    const entries = await pickImages(false, GIF_SOURCE_EXTS, {
      title: '选择图片或视频',
      label: '图片和视频',
    });
    if (entries.length) await loadEntry(entries[0]);
  });
  clearBtn.addEventListener('click', clearImage);
  exportBtn.addEventListener('click', exportTo);
  playBtn.addEventListener('click', () => setPlaying(!playing));
  // <img> 解码完成才是动画真正的起点，用它校正一次推算的基准
  preview.addEventListener('load', () => {
    if (playing) playStart = performance.now();
  });
  frameRange.addEventListener('input', () => {
    // 先取值：setPlaying(false) 会走 showFrame，把滑块写回当前帧号
    const i = Number(frameRange.value) - 1;
    setPlaying(false);
    showFrame(i);
  });

  vidPlayBtn.addEventListener('click', () => (video.paused ? playVideo() : pauseVideo()));
  vidResetBtn.addEventListener('click', () => playVideo(range.t0));
  video.addEventListener('timeupdate', () => {
    if (!videoMeta) return;
    updateTimeUI();
    loopRange();
  });
  video.addEventListener('ended', () => {
    vidPlayBtn.textContent = '播放';
  });
  tl.addEventListener('mousedown', tlDown);
  window.addEventListener('mousemove', tlMove);
  window.addEventListener('mouseup', () => {
    tlUp();
  });

  selModeBtn.addEventListener('click', () => {
    selOn = !selOn;
    syncSelMode();
    if (selOn) {
      setStatus(srcView.select ? '拖手柄改大小、框内拖动改位置，再点一次取消' : '在画面上拖拽框选区域');
      return;
    }
    if (!srcView.select) {
      setStatus('已退出框选：全画面');
      return;
    }
    srcView.setSelect(null);
    updateSelInfo();
    setStatus('已取消选区：全画面');
    rangeChanged();
  });

  // GIF 范围：手动输入起止时间，回车或失焦生效；解不出来 / 结束不晚于开始就退回当前区间
  function commitTime() {
    if (mode !== 'video' || !videoMeta) return;
    const a = parseTime(tIn.value);
    const b = parseTime(tOut.value);
    if (a === null || b === null || b <= a) {
      syncTimeInputs();
      setStatus(
        b !== null && a !== null && b <= a
          ? '结束时间要晚于开始时间，已退回当前区间'
          : '时间格式不对（可用秒，或 分:秒 / 时:分:秒.厘秒），已退回当前区间',
        true
      );
      return;
    }
    const was = { ...range };
    setRange(a, b);
    if (range.t0 === was.t0 && range.t1 === was.t1) return;
    rangeChanged();
  }
  for (const el of [tIn, tOut]) {
    el.addEventListener('change', commitTime);
    // 回车等于失焦：change 会由 blur 触发，这里只管别让它提交表单默认行为
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.blur();
      }
    });
  }

  function syncAutoBtn() {
    autoBtn.classList.toggle('on', autoExtract);
    autoBtn.setAttribute('aria-pressed', String(autoExtract));
  }

  autoBtn.addEventListener('click', () => {
    autoExtract = !autoExtract;
    syncAutoBtn();
    clearTimeout(debounceId);
    runId++; // 顺带打断正在跑的抽帧/编码
    setProgress(null);
    updateInfo(); // 信息行末尾那个「自动生成GIF已关闭」要立刻跟着变
    if (autoExtract) {
      setStatus('已开启自动生成GIF');
      if (mode === 'video') scheduleVideo();
      else if (mode) schedule();
    } else {
      setStatus('已关闭自动生成GIF：改参数不会重新生成，需要时再点开', true);
    }
  });
  srcView.onSelect = () => {
    updateSelInfo();
    if (mode === 'video') rangeChanged();
  };

  const gridChanged = () => {
    invalidate();
    schedule();
  };
  colsIn.addEventListener('change', gridChanged);
  rowsIn.addEventListener('change', gridChanged);
  scaleSel.addEventListener('change', () => {
    invalidate();
    if (mode === 'video') scheduleVideo();
    else schedule();
  });
  fpsIn.addEventListener('change', () => {
    fpsIn.value = String(curFps());
    if (mode === 'video') {
      // 帧率决定区间最小长度，跟着收一下；抽帧缓存不按帧率失效（见 extractFrames），
      // 降帧率只做重采样，升帧率才重新抽
      setRange(range.t0, range.t1);
      scheduleVideo();
    } else {
      schedule();
    }
  });
  loopSel.addEventListener('change', schedule);
  colorSel.addEventListener('change', schedule);
  qualitySel.addEventListener('change', schedule);

  setEnabled(false);
  setPlaying(false);
  setVideoUI(false);
  syncAutoBtn();
  preview.hidden = true;
  frameCanvas.hidden = true;
  updateOut('GIF：-  |  尺寸：-  |  体积：-');
  updateSelInfo();
  return { loadEntry };
}
