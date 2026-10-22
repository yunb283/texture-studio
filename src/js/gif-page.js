// GIF 制作页：图片按网格拆帧，视频按区间抽帧，都编成 GIF。
// 预览两种模式：播放 = 真 <img> 跑编码后的 GIF 字节；逐帧 = canvas 画本地帧（暂停时拖动）。
// 编码在 gif.js（已通过 PIL / Chrome 双向闭环），这里按帧让出主线程，避免长动画把 UI 冻住。
import {
  pickImages,
  readEntryBytes,
  saveBlob,
  resolveSaveDir,
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
import { gifStart, gifEncodeNext, gifFinish, gifDelayForFps, gifFpsForDelay } from './gif.js';
import { equalizeCanvases } from './layout.js';

const $ = (id) => document.getElementById(id);
const SCALE = [100, 75, 50, 25];
// 超过这两个值就提醒：帧数直接决定内存（帧数×宽×高×4 字节）和编码耗时
const FRAME_WARN = 600;
const MEM_WARN_MB = 400;
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
  const vidRow = $('gif-vid-row');
  const vidGrid = $('gif-vid-grid');
  const vidPlayBtn = $('gif-vid-play');
  const vidTime = $('gif-vid-time');
  const tl = $('gif-tl');
  const tlBand = $('gif-tl-band');
  const tlA = $('gif-tl-a');
  const tlB = $('gif-tl-b');
  const tlHead = $('gif-tl-head');
  const rangeInfo = $('gif-range-info');
  const selModeBtn = $('gif-sel-mode');
  const selFullBtn = $('gif-sel-full');
  const selInfo = $('gif-sel-info');

  const relayout = equalizeCanvases($('page-gif'));

  let mode = null; // 'image' | 'video'
  let srcCanvas = null;
  let videoMeta = null; // {src, w, h, duration}
  let videoUrl = null; // 当前挂在 <video> 上的地址，换源或失败时都要释放
  let range = { t0: 0, t1: 0 };
  let sourcePath = null;
  let sourceName = '';
  let sourceBytes = 0;
  // 拆帧/抽帧结果按「源 + 影响像素的参数」缓存，只改帧率以外的项时不必重做
  let cache = null;
  let curFrames = [];
  let result = null; // {bytes, blobUrl, count, w, h, ms}
  let playing = true;
  let frameIndex = 0;
  let runId = 0;
  let rafId = 0;
  let tlDrag = null; // 时间轴正在拖：{which:'seek'|'a'|'b'|'band', grab, w}
  let debounceId = 0;

  const setStatus = (msg, warn = false) => {
    status.textContent = msg;
    status.classList.toggle('warn', warn);
  };

  const curFps = () => Math.min(50, Math.max(1, Math.round(Number(fpsIn.value)) || 10));
  const clamped = (el, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(el.value)) || lo));
  const gridCount = () => (mode === 'image' ? clamped(colsIn, 1, 128) * clamped(rowsIn, 1, 128) : 0);

  function scalePct() {
    const v = Number(scaleSel.value);
    return SCALE.includes(v) ? v : 100;
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

  function estimate() {
    const r = srcPixelRect();
    const pct = scalePct();
    const w = Math.max(1, Math.round((r.w * pct) / 100));
    const h = Math.max(1, Math.round((r.h * pct) / 100));
    const count =
      mode === 'video' ? Math.max(1, Math.floor((range.t1 - range.t0) * curFps()) + 1) : gridCount();
    return { count, w, h, memMB: (count * w * h * 4) / 1048576 };
  }

  function overLimit(est) {
    return est.count > FRAME_WARN || est.memMB > MEM_WARN_MB;
  }

  function updateInfo() {
    const est = estimate();
    if (mode === 'video') {
      info.textContent =
        `视频 ${videoMeta.w}x${videoMeta.h}·${videoMeta.duration.toFixed(2)}s  |  ` +
        `帧数 ${est.count} · ${est.w}x${est.h} · 内存约 ${est.memMB.toFixed(0)}MB`;
    } else if (mode === 'image') {
      info.textContent =
        `图像尺寸：${srcCanvas.width}x${srcCanvas.height}  |  ` +
        `大小：${humanSize(sourceBytes)}  |  ` +
        `格式：${FORMAT_NAME[extOf(sourceName)] || '未知'}  |  ` +
        `帧数：${est.count}`;
    } else {
      info.textContent = '图像尺寸：-  |  大小：-  |  格式：-  |  帧数：-';
    }
    const over = mode && overLimit(est);
    info.classList.toggle('warn', !!over);
    if (over) info.textContent += '（偏大，抽帧和编码会很慢）';
  }

  function updateOut(text) {
    outInfo.textContent = text;
  }

  function setEnabled(on) {
    clearBtn.disabled = !on;
    exportBtn.disabled = !on;
    for (const el of [scaleSel, fpsIn, loopSel, colorSel, qualitySel]) el.disabled = !on;
    // 列/行只对图片有意义
    colsIn.disabled = !on || mode !== 'image';
    rowsIn.disabled = !on || mode !== 'image';
  }

  function setVideoUI(on) {
    vidRow.hidden = !on;
    vidGrid.hidden = !on;
    vidPlayBtn.disabled = !on;
    selModeBtn.disabled = !on;
    selFullBtn.disabled = !on;
    setSelMode(false);
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

  // 抽帧：按帧率把 [t0, t1] 均分，逐次 seek 后把选区画进离屏画布。
  // 采样率高于视频帧率时会抽到重复帧，这里不去重——去重会让 GIF 比原视频快。
  async function extractFrames(id) {
    const fps = curFps();
    const pct = scalePct();
    const r = srcPixelRect();
    const key =
      `v:${videoMeta.src}:${range.t0.toFixed(3)}-${range.t1.toFixed(3)}:${fps}:` +
      `${r.x},${r.y},${r.w},${r.h}:${pct}`;
    if (cache && cache.key === key) return cache.frames;
    const outW = Math.max(1, Math.round((r.w * pct) / 100));
    const outH = Math.max(1, Math.round((r.h * pct) / 100));
    const cv = document.createElement('canvas');
    cv.width = outW;
    cv.height = outH;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    const total = Math.max(1, Math.floor((range.t1 - range.t0) * fps) + 1);
    const frames = [];
    const wasAt = video.currentTime;
    pauseVideo();
    const t0 = performance.now();
    for (let i = 0; i < total; i++) {
      if (id !== runId) return null;
      await seekVideo(Math.min(range.t1, range.t0 + i / fps));
      if (id !== runId) return null;
      setStatus(`正在抽帧 ${i + 1}/${total}（${video.currentTime.toFixed(2)}s）…`);
      ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, outW, outH);
      frames.push({ width: outW, height: outH, data: new Uint8ClampedArray(ctx.getImageData(0, 0, outW, outH).data) });
      await idle();
    }
    // 抽完把播放头放回原位，否则源画面一直停在区间最后一帧
    await seekVideo(wasAt);
    srcView.redraw();
    updateTimeUI();
    cache = { key, frames, ms: performance.now() - t0 };
    return frames;
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

  function setPlaying(on) {
    playing = !!on && !!result;
    preview.hidden = !playing;
    frameCanvas.hidden = playing || !result;
    playBtn.disabled = !result;
    frameRange.disabled = !result;
    playBtn.textContent = playing ? '暂停动画' : '播放动画';
    if (!playing && result) showFrame(frameIndex);
  }

  function refreshPreview() {
    if (!result) return;
    playBtn.disabled = false;
    frameRange.disabled = false;
    frameRange.max = String(result.count);
    if (playing) {
      // 换 #片段 让 <img> 重新解码，动画才会从头播（同一个 blob URL 直接重设不会重启）
      preview.src = `${result.blobUrl}#${Date.now()}`;
      preview.hidden = false;
      frameCanvas.hidden = true;
    } else {
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
    updateInfo();
  }

  async function render() {
    if (!mode) return;
    const id = ++runId;
    updateInfo();
    let frames;
    try {
      frames = mode === 'video' ? await extractFrames(id) : buildFrames();
    } catch (ex) {
      if (id === runId) setStatus('抽帧失败：' + (ex?.message ?? ex), true);
      return;
    }
    if (id !== runId) return;
    if (!frames || !frames.length) {
      setStatus('这一段抽不到帧，检查区间和帧率', true);
      return;
    }
    await encode(id, frames);
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
    };
    const est = estimate();
    if (overLimit(est)) {
      setStatus(`帧数 ${est.count}、内存约 ${est.memMB.toFixed(0)}MB，偏大，会慢…`, true);
    } else {
      setStatus(`正在编码 0/${frames.length} 帧…`);
    }
    await idle();
    const t0 = performance.now();
    let bytes;
    try {
      const st = gifStart(frames, opts);
      let done = 0;
      while (gifEncodeNext(st)) {
        done++;
        if (id !== runId) return; // 参数又变了，丢掉这一轮
        setStatus(`正在编码 ${done}/${frames.length} 帧…`);
        await idle();
      }
      bytes = gifFinish(st);
    } catch (ex) {
      if (id === runId) setStatus('编码失败：' + (ex?.message ?? ex), true);
      return;
    }
    if (id !== runId) return;
    const ms = performance.now() - t0;
    if (result) URL.revokeObjectURL(result.blobUrl);
    const blob = new Blob([bytes], { type: 'image/gif' });
    result = { bytes, blobUrl: URL.createObjectURL(blob), count: frames.length, w: tw, h: th, ms };
    refreshPreview();
    updateOut(
      `GIF：${frames.length} 帧  |  ${tw}x${th}  |  每帧 ${opts.delay * 10}ms（约 ${gifFpsForDelay(opts.delay).toFixed(1)}fps）  |  ` +
        `${humanSize(bytes.length)}  |  编码 ${ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms`
    );
    const pulled = cache?.ms ? `  |  抽帧 ${Math.round(cache.ms)}ms` : '';
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
    const cur = video.currentTime;
    vidTime.textContent = `${cur.toFixed(2)} / ${dur.toFixed(2)}s`;
    tlHead.style.left = `${dur ? (cur / dur) * 100 : 0}%`;
    tlBand.style.left = `${dur ? (range.t0 / dur) * 100 : 0}%`;
    tlBand.style.width = `${dur ? Math.max(0, ((range.t1 - range.t0) / dur) * 100) : 0}%`;
    rangeInfo.textContent = `${range.t0.toFixed(2)}–${range.t1.toFixed(2)}s`;
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

  function playVideo() {
    if (!videoMeta) return;
    if (video.currentTime < range.t0 || video.currentTime >= range.t1 - 1e-3) {
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
    tlDrag = { which, grab: t - range.t0, w: range.t1 - range.t0 };
    pauseVideo();
    if (which === 'seek') tlSeekTo(t);
    e.preventDefault();
  }

  function tlMove(e) {
    if (!tlDrag || !videoMeta) return;
    const dur = videoMeta.duration;
    const t = tlFrac(e) * dur;
    const min = 1 / curFps();
    if (tlDrag.which === 'a') {
      setRange(Math.min(t, range.t1 - min), range.t1);
      rangeChanged();
    } else if (tlDrag.which === 'b') {
      setRange(range.t0, Math.max(t, range.t0 + min));
      rangeChanged();
    } else if (tlDrag.which === 'band') {
      const w = tlDrag.w;
      const start = Math.min(Math.max(0, t - tlDrag.grab), Math.max(0, dur - w));
      setRange(start, start + w);
      rangeChanged();
    } else {
      tlSeekTo(t);
    }
  }

  function tlSeekTo(t) {
    seekVideo(t).then(() => {
      srcView.redraw();
      updateTimeUI();
    });
  }

  function rangeChanged() {
    invalidate();
    scheduleVideo();
  }

  // 框选模式：只有按下「选择区域」后画布才响应拖拽，避免误触
  function setSelMode(on) {
    const active = !!on && mode === 'video';
    srcView.setSelectEnabled(active);
    selModeBtn.classList.toggle('on', active);
    selModeBtn.textContent = active ? '拖拽框选…' : '选择区域';
  }

  function updateSelInfo() {
    if (mode !== 'video') {
      selInfo.textContent = '区域 -';
      return;
    }
    const r = srcPixelRect();
    const full = r.w === videoMeta.w && r.h === videoMeta.h;
    selInfo.textContent = full ? '区域 全画面' : `区域 ${r.w}x${r.h}（+${r.x},+${r.y}）`;
  }

  // ---------- 载入 ----------

  function videoErrMsg() {
    const code = video.error?.code;
    if (code === 4 || code === 3) {
      return '解码失败：这个容器或编码 WebView2 不支持（MKV / AVI / WMV 常见），请先转成 MP4（H.264）或 WEBM';
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
    setVideoUI(true);
    setEnabled(true);
    updateSelInfo();
    updateInfo();
    setStatus(
      `已载入视频：${entry.name}（${videoMeta.w}x${videoMeta.h}，${videoMeta.duration.toFixed(2)}s）。` +
        '拖时间轴两端的黄色手柄选区间，点「选择区域」再在画面上框选'
    );
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
    setVideoUI(false);
    setEnabled(true);
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
    frameIndex = 0;
    playing = true;
    try {
      if (isVideoName(entry.name)) await loadVideo(entry);
      else await loadImage(entry);
      playBtn.textContent = '播放动画';
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
    }
  }

  function clearImage() {
    if (!mode) return;
    runId++;
    clearTimeout(debounceId);
    detachVideo();
    mode = null;
    srcCanvas = null;
    cache = null;
    curFrames = [];
    sourcePath = null;
    sourceName = '';
    sourceBytes = 0;
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
    const saved = await saveBlob(outName(), result.bytes, dir);
    setStatus(saved === null ? '已取消' : `已导出：${saved}（${humanSize(result.bytes.length)}）`);
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
  frameRange.addEventListener('input', () => {
    // 先取值：setPlaying(false) 会走 showFrame，把滑块写回当前帧号
    const i = Number(frameRange.value) - 1;
    setPlaying(false);
    showFrame(i);
  });

  vidPlayBtn.addEventListener('click', () => (video.paused ? playVideo() : pauseVideo()));
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
    tlDrag = null;
  });

  selModeBtn.addEventListener('click', () => {
    const on = !srcView.selectEnabled;
    setSelMode(on);
    if (on) setStatus('在画面上拖拽框选区域，松手完成；单击取消');
  });
  selFullBtn.addEventListener('click', () => {
    srcView.setSelect(null);
    updateSelInfo();
    rangeChanged();
  });
  srcView.onSelect = () => {
    updateSelInfo();
    if (mode === 'video') rangeChanged();
  };
  srcView.onSelectEnd = () => setSelMode(false);

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
      // 帧率决定区间最小长度，跟着收一下
      setRange(range.t0, range.t1);
      invalidate();
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
  preview.hidden = true;
  frameCanvas.hidden = true;
  updateOut('GIF：-  |  尺寸：-  |  体积：-');
  updateSelInfo();
  return { loadEntry };
}
