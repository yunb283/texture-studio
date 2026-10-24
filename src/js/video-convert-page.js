import {
  pickImages,
  videoSrc,
  releaseSrc,
  resolveSaveDir,
  uniqueFilename,
  dirname,
  stemOf,
  baseName,
  isTauri,
  isVideoName,
  VIDEO_EXTS,
  openPath,
  formatBytes,
  fileSizeOf,
} from './platform.js';
import { createIoButtons } from './io-buttons.js';

const $ = (id) => document.getElementById(id);

function fmtTime(sec) {
  if (!sec || !isFinite(sec)) return '-';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function initVideoConvert() {
  const video = $('vid-src');
  const info = $('vid-info');
  const openBtn = $('vid-open');
  const clearBtn = $('vid-clear');
  const fmtSel = $('vid-fmt');
  const vcodecSel = $('vid-vcodec');
  const acodecSel = $('vid-acodec');
  const crfRange = $('vid-crf');
  const crfLabel = $('vid-crf-label');
  const presetSel = $('vid-preset');
  const scaleSel = $('vid-scale');
  const wIn = $('vid-w');
  const hIn = $('vid-h');
  const fpsSel = $('vid-fps');
  const vbrIn = $('vid-vbr');
  const vbrModeSel = $('vid-vbr-mode');
  const vbrHint = $('vid-vbr-hint');
  const abrIn = $('vid-abr');
  const copyChk = $('vid-copy');
  const nameIn = $('vid-name');
  const saveOrigChk = $('vid-save-orig');
  const convertBtn = $('vid-convert');
  const progressFill = $('vid-progress-fill');
  const progressText = $('vid-progress-text');
  const status = $('vid-status');
  const playBtn = $('vid-play');
  const prevBtn = $('vid-prev');
  const nextBtn = $('vid-next');
  const resetBtn = $('vid-reset');
  const seek = $('vid-seek');
  const timeLabel = $('vid-time');
  const playOverlay = $('vid-play-overlay');
  const muteBtn = $('vid-mute');
  const volSlider = $('vid-vol');
  const volLabel = $('vid-vol-label');
  const hideBtn = $('vid-hide');
  const cropBtn = $('vid-crop');
  const cropOverlay = $('vid-crop-overlay');
  const cropBox = $('vid-crop-box');
  const canvasWrap = $('vid-canvas-wrap');
  const gripA = $('vid-grip-a');
  const gripB = $('vid-grip-b');
  const maskT = cropOverlay.querySelector('.crop-mask-t');
  const maskB = cropOverlay.querySelector('.crop-mask-b');
  const maskL = cropOverlay.querySelector('.crop-mask-l');
  const maskR = cropOverlay.querySelector('.crop-mask-r');
  const resetDefaultsBtn = $('vid-reset-defaults');

  const io = createIoButtons($('vid-io'), setStatus);
  const srcSizeEl = $('vid-src-size');
  const outSizeEl = $('vid-out-size');

  let entry = null;
  let srcUrl = null;
  let videoInfo = null; // ffprobe 的准确结果
  let elInfo = null; // <video> 自带元数据，导入瞬间就有
  let probeSeq = 0; // 丢弃上一个文件迟到的探测结果
  let converting = false;
  let unlisten = null;
  let isSeeking = false;
  let resumeAfterSeek = false;
  // 是否显示暂停时的中央播放按钮（由"隐藏暂停按钮"开关控制）
  let showPauseOverlay = true;
  // 裁剪状态
  let cropOn = false;
  let cropSel = null; // 归一化选区 {x0,y0,x1,y1}，相对视频画面
  let cropDrag = null;
  // 黄色时间滑块（归一化 0-1）
  let gripAFrac = 0;
  let gripBFrac = 1;
  let gripDrag = null;
  // 播放区间循环的 rAF 轮询（比 timeupdate 更精准，避免蓝球越过右滑块）
  let loopRafId = null;

  function setStatus(msg) {
    status.textContent = msg;
  }

  function setProgress(p) {
    const pct = Math.round(p * 100);
    progressFill.style.width = pct + '%';
    progressText.textContent = pct + '%';
  }

  function setEnabled(on) {
    clearBtn.disabled = !on;
    convertBtn.disabled = !on || converting;
  }

  // 恢复转换设置为 HTML 里写死的默认值
  function resetDefaults() {
    fmtSel.value = 'mp4';
    vcodecSel.value = 'libx264';
    acodecSel.value = 'aac';
    crfRange.value = 23;
    crfLabel.textContent = '23';
    presetSel.value = 'medium';
    scaleSel.value = '0';
    wIn.value = 1920;
    hIn.value = 1080;
    fpsSel.value = '0';
    vbrModeSel.value = 'auto';
    vbrIn.value = '';
    abrIn.value = '';
    copyChk.checked = false;
    nameIn.value = '';
    saveOrigChk.checked = true;
    // 触发相关 change 处理，刷新 disabled 状态和码率推荐
    syncCodecByFormat();
    copyChk.dispatchEvent(new Event('change'));
    scaleSel.dispatchEvent(new Event('change'));
  }

  function setTimelineEnabled(on) {
    playBtn.disabled = !on;
    prevBtn.disabled = !on;
    nextBtn.disabled = !on;
    resetBtn.disabled = !on;
    seek.disabled = !on;
    muteBtn.disabled = !on;
    volSlider.disabled = !on;
    hideBtn.disabled = !on;
    cropBtn.disabled = !on;
  }

  // 同步进度条的蓝色填充比例（只在两个黄色滑块之间填充）
  function updateSeekFill() {
    const pct = seek.max > 0 ? (seek.value / seek.max) * 100 : 0;
    const aPct = gripAFrac * 100;
    const bPct = gripBFrac * 100;
    // 蓝色填充结束位置 = clamp(pct, aPct, bPct)
    const fillEnd = Math.max(aPct, Math.min(pct, bPct));
    seek.style.setProperty('--seek-pct', fillEnd + '%');
    seek.style.setProperty('--grip-a', aPct + '%');
    seek.style.setProperty('--grip-b', bPct + '%');
  }

  // 更新黄色滑块位置
  function updateGripUI() {
    gripA.style.left = (gripAFrac * 100) + '%';
    gripB.style.left = (gripBFrac * 100) + '%';
    updateSeekFill();
  }

  function updateTimeDisplay() {
    const dur = isFinite(video.duration) ? video.duration : 0;
    timeLabel.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(dur)}`;
    if (!isSeeking && dur > 0) {
      seek.value = Math.min(1000, Math.round((video.currentTime / dur) * 1000));
      updateSeekFill();
    }
  }

  // 优先用 ffprobe 的准确结果，其次用 <video> 元数据：导入后立刻有信息可显示
  function currentInfo() {
    return videoInfo || elInfo;
  }

  // —— 码率推荐 ——
  // H.264 常见上传码率区间（短边像素 → 低/高，Mbps），再按帧率和编码折算
  const BITRATE_TABLE = [
    [240, 0.3, 0.6],
    [360, 0.6, 1.0],
    [480, 1.5, 2.5],
    [720, 2.5, 4],
    [1080, 5, 8],
    [1440, 9, 14],
    [2160, 20, 35],
    [4320, 40, 70],
  ];
  const CODEC_LABELS = {
    libx264: 'H.264',
    libx265: 'H.265',
    'libvpx-vp9': 'VP9',
    'libaom-av1': 'AV1',
  };

  // 实际输出尺寸：优先看「分辨率」选择，其次用源文件
  function outputSize() {
    const scaleVal = scaleSel.value;
    if (scaleVal === 'custom') {
      const w = parseInt(wIn.value, 10);
      const h = parseInt(hIn.value, 10);
      if (w > 0 && h > 0) return { w, h };
    } else if (scaleVal !== '0') {
      const [w, h] = scaleVal.split(':').map(Number);
      if (w > 0 && h > 0) return { w, h };
    }
    const ci = currentInfo();
    return { w: ci?.width || 1920, h: ci?.height || 1080 };
  }

  function outputFps() {
    const fps = parseFloat(fpsSel.value);
    if (fps > 0) return fps;
    const ci = currentInfo();
    return ci?.fps > 0 ? ci.fps : 30;
  }

  // 自动推荐码率：取区间中值，高帧率上调，H.265/VP9/AV1 按比例下调
  function recommendBitrate() {
    const { w, h } = outputSize();
    const fps = outputFps();
    const codec = vcodecSel.value;
    const edge = Math.min(w, h);
    const row =
      BITRATE_TABLE.find(([max]) => edge <= max) || BITRATE_TABLE[BITRATE_TABLE.length - 1];
    let mbps = (row[1] + row[2]) / 2;
    if (fps > 45) mbps *= 1.5;
    else if (fps > 35) mbps *= 1.2;
    if (codec === 'libx265') mbps *= 0.6;
    else if (codec === 'libvpx-vp9') mbps *= 0.7;
    else if (codec === 'libaom-av1') mbps *= 0.5;
    return {
      w,
      h,
      fps,
      mbps: Math.max(0.3, Math.round(mbps * 10) / 10),
      codec: CODEC_LABELS[codec] || codec,
    };
  }

  // 码率模式：用 CRF / 自动推荐 / 手动（码率和 CRF 二选一，别让人以为两个都生效）
  function applyVbrMode() {
    const mode = vbrModeSel.value;
    const copy = copyChk.checked;
    if (copy) {
      vbrIn.disabled = true;
      vbrHint.textContent = '';
      return;
    }
    if (mode === 'auto') {
      const r = recommendBitrate();
      vbrIn.value = r.mbps >= 1 ? `${r.mbps}M` : `${Math.round(r.mbps * 1000)}k`;
      vbrIn.disabled = true;
      vbrHint.textContent = `自动推荐：${r.w}×${r.h} · ${Math.round(r.fps)}fps · ${r.codec} → ${r.mbps} Mbps`;
    } else if (mode === 'manual') {
      vbrIn.disabled = false;
      vbrHint.textContent = '手填 ffmpeg 码率写法，例：5M、2000k；填了码率后上面的 CRF 不生效';
    } else {
      vbrIn.value = '';
      vbrIn.disabled = true;
      vbrHint.textContent = '用 CRF 控制质量（推荐）：数值越小越清晰、体积越大';
    }
    crfRange.disabled = copy || mode !== 'crf';
  }

  function stepFrame(delta) {
    video.pause();
    const ci = currentInfo();
    const fps = (ci && ci.fps > 0) ? ci.fps : 30;
    const dur = isFinite(video.duration) ? video.duration : 0;
    let t = video.currentTime + (delta / fps);
    t = Math.max(0, Math.min(dur, t));
    video.currentTime = t;
    updateTimeDisplay();
  }

  function updateInfo() {
    const v = currentInfo();
    if (!v) {
      info.textContent = '未载入视频';
      return;
    }
    const parts = [
      `时长：${fmtTime(v.duration)}`,
      `分辨率：${v.width || '-'}×${v.height || '-'}`,
    ];
    if (v.fps) parts.push(`帧率：${v.fps} fps`);
    if (v.video_codec) parts.push(`视频编码：${v.video_codec}`);
    if (v.audio_codec) parts.push(`音频编码：${v.audio_codec}`);
    if (v.bitrate) parts.push(v.bitrate);
    info.textContent = parts.join('  |  ');
  }

  // 输出格式变化时，自动推荐匹配的音视频编码
  function syncCodecByFormat() {
    const fmt = fmtSel.value;
    if (copyChk.checked) return;
    if (fmt === 'webm') {
      if (vcodecSel.value === 'libx264' || vcodecSel.value === 'libx265') vcodecSel.value = 'libvpx-vp9';
      if (acodecSel.value === 'aac' || acodecSel.value === 'libmp3lame') acodecSel.value = 'libopus';
    } else if (fmt === 'mp4' || fmt === 'mov' || fmt === 'm4v') {
      if (vcodecSel.value === 'libvpx-vp9') vcodecSel.value = 'libx264';
      if (acodecSel.value === 'libopus') acodecSel.value = 'aac';
    }
  }

  async function loadEntry(e) {
    if (converting) return;
    if (!isVideoName(e.name)) {
      setStatus('不支持的视频格式：' + e.name);
      return;
    }
    const seq = ++probeSeq;
    entry = e;
    io.setSource(e.path);
    io.setExport(null);
    videoInfo = null;
    elInfo = null;
    outSizeEl.textContent = '';
    srcSizeEl.textContent = '';
    // 源文件大小：只读 metadata，立刻显示，不用等 ffprobe
    fileSizeOf(e).then((n) => {
      if (entry === e) srcSizeEl.textContent = formatBytes(n);
    });

    // 预览
    if (srcUrl) releaseSrc(srcUrl);
    srcUrl = videoSrc(e);
    if (srcUrl) {
      video.src = srcUrl;
    }

    // <video> 自己解析元数据，通常几十毫秒就有结果：先把界面点亮，不等 ffmpeg
    const onMeta = () => {
      elInfo = {
        duration: isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth,
        height: video.videoHeight,
        fps: 0,
        video_codec: '',
        audio_codec: '',
        bitrate: '',
      };
      updateInfo();
      updateTimeDisplay();
      setTimelineEnabled(true);
      seek.value = 0;
      // 重置黄色滑块到全区间
      gripAFrac = 0;
      gripBFrac = 1;
      updateGripUI();
      playOverlay.hidden = !showPauseOverlay;
      if (vbrModeSel.value === 'auto') applyVbrMode();
      video.removeEventListener('loadedmetadata', onMeta);
    };
    video.addEventListener('loadedmetadata', onMeta);

    // 导入本身不等探测：状态立刻变「已载入」，编码/帧率/比特率由后台 ffprobe 补上
    updateInfo();
    setEnabled(true);
    setProgress(0);
    setStatus('已载入：' + e.name);

    if (isTauri) {
      window.__TAURI__.core
        .invoke('ffprobe_video', { path: e.path })
        .then((info) => {
          if (seq !== probeSeq || !info) return;
          videoInfo = info;
          updateInfo();
          if (vbrModeSel.value === 'auto') applyVbrMode();
        })
        .catch((ex) => {
          if (seq !== probeSeq) return;
          setStatus('已载入：' + e.name + '（读取编码信息失败：' + (ex?.message ?? ex) + '）');
        });
    }
  }

  async function doConvert() {
    if (!entry || converting) return;
    if (!isTauri) {
      setStatus('视频格式转换需要桌面版环境（内置 FFmpeg），浏览器中无法使用');
      return;
    }

    const fmt = fmtSel.value;
    const useCopy = copyChk.checked;

    // 组装输出文件名
    let outName = nameIn.value.trim();
    if (!outName) outName = stemOf(entry.name) + '_转换';
    outName = outName.replace(/\.[^.]+$/, '') + '.' + fmt;

    // 确定输出目录
    const dir = saveOrigChk.checked ? dirname(entry.path) : await resolveSaveDir(null);
    if (!dir) {
      setStatus('未选择输出目录');
      return;
    }
    const finalName = await uniqueFilename(dir, outName);
    const sep = dir.includes('\\') ? '\\' : '/';
    const outPath = dir.endsWith('\\') || dir.endsWith('/') ? dir + finalName : dir + sep + finalName;

    // 组装转换参数
    const options = { copy: useCopy };
    if (!useCopy) {
      const vc = vcodecSel.value;
      const ac = acodecSel.value;
      options.video_codec = vc === 'copy' ? null : vc;
      options.audio_codec = ac === 'copy' ? null : ac;

      // 分辨率
      const scaleVal = scaleSel.value;
      if (scaleVal === 'custom') {
        const w = parseInt(wIn.value, 10);
        const h = parseInt(hIn.value, 10);
        if (w > 0 && h > 0) {
          options.width = w;
          options.height = h;
        }
      } else if (scaleVal !== '0') {
        const [w, h] = scaleVal.split(':').map(Number);
        options.width = w;
        options.height = h;
      }

      // 帧率
      const fps = parseFloat(fpsSel.value);
      if (fps > 0) options.fps = fps;

      // 比特率 / CRF / 预设
      const vbr = vbrIn.value.trim();
      if (vbr) options.video_bitrate = vbr;
      const abr = abrIn.value.trim();
      if (abr) options.audio_bitrate = abr;
      if (!vbr) options.crf = parseInt(crfRange.value, 10);
      options.preset = presetSel.value;
    }

    // 裁剪区域（归一化坐标 → 源像素坐标）
    const ci = currentInfo();
    if (cropSel && ci) {
      const sx = cropSel.x1 - cropSel.x0;
      const sy = cropSel.y1 - cropSel.y0;
      if (sx > 0 && sy > 0) {
        options.crop_x = Math.round(cropSel.x0 * ci.width);
        options.crop_y = Math.round(cropSel.y0 * ci.height);
        options.crop_w = Math.max(1, Math.round(cropSel.x1 * ci.width) - options.crop_x);
        options.crop_h = Math.max(1, Math.round(cropSel.y1 * ci.height) - options.crop_y);
      }
    }

    // 时间区间（黄色滑块之间）
    const dur = isFinite(video.duration) ? video.duration : 0;
    if (dur > 0 && (gripAFrac > 0 || gripBFrac < 1)) {
      options.start_time = gripAFrac * dur;
      options.end_time = gripBFrac * dur;
    }

    converting = true;
    setEnabled(false);
    convertBtn.textContent = '转换中…';
    setProgress(0);
    outSizeEl.textContent = '';
    setStatus(`正在转换为 ${fmt.toUpperCase()}…`);

    // 监听进度事件
    unlisten = await window.__TAURI__.event.listen('video-progress', (ev) => {
      setProgress(ev.payload);
    });

    try {
      await window.__TAURI__.core.invoke('convert_video', {
        input: entry.path,
        output: outPath,
        options,
      });
      setProgress(1);
      setStatus('转换完成：' + outPath);
      io.setExport(outPath);
      // 右侧栏提示转换后的大小
      const outBytes = await fileSizeOf({ path: outPath });
      outSizeEl.textContent = outBytes ? `输出大小：${formatBytes(outBytes)}` : '';
    } catch (ex) {
      setStatus('转换失败：' + (ex?.message ?? ex));
    } finally {
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      converting = false;
      convertBtn.textContent = '开始转换';
      setEnabled(true);
    }
  }

  // 事件绑定
  openBtn.addEventListener('click', async () => {
    const entries = await pickImages(false, VIDEO_EXTS, {
      title: '选择视频文件',
      label: '视频文件',
    });
    if (entries?.[0]) loadEntry(entries[0]);
  });

  clearBtn.addEventListener('click', () => {
    if (converting) return;
    entry = null;
    videoInfo = null;
    elInfo = null;
    probeSeq++;
    srcSizeEl.textContent = '';
    outSizeEl.textContent = '';
    if (srcUrl) {
      releaseSrc(srcUrl);
      srcUrl = null;
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
    setProgress(0);
    setEnabled(false);
    setTimelineEnabled(false);
    playBtn.textContent = '播放';
    timeLabel.textContent = '00:00 / 00:00';
    seek.value = 0;
    updateSeekFill();
    playOverlay.hidden = true;
    // 重置暂停浮层开关为默认显示
    showPauseOverlay = true;
    hideBtn.textContent = '隐藏暂停按钮';
    // 重置裁剪与时间滑块
    cropOn = false;
    cropSel = null;
    cropOverlay.hidden = true;
    cropBtn.classList.remove('on');
    gripAFrac = 0;
    gripBFrac = 1;
    updateGripUI();
    updateInfo();
    io.clear();
    setStatus('');
  });

  crfRange.addEventListener('input', () => {
    crfLabel.textContent = crfRange.value;
  });

  scaleSel.addEventListener('change', () => {
    const custom = scaleSel.value === 'custom';
    wIn.disabled = !custom;
    hIn.disabled = !custom;
  });

  copyChk.addEventListener('change', () => {
    const copy = copyChk.checked;
    vcodecSel.disabled = copy;
    acodecSel.disabled = copy;
    crfRange.disabled = copy;
    presetSel.disabled = copy;
    scaleSel.disabled = copy;
    wIn.disabled = copy || scaleSel.value !== 'custom';
    hIn.disabled = copy || scaleSel.value !== 'custom';
    fpsSel.disabled = copy;
    abrIn.disabled = copy;
    applyVbrMode();
  });

  resetDefaultsBtn.addEventListener('click', () => {
    resetDefaults();
  });

  fmtSel.addEventListener('change', syncCodecByFormat);
  vcodecSel.addEventListener('change', syncCodecByFormat);

  // 输出尺寸/帧率/编码一变，自动推荐的码率跟着重算
  vbrModeSel.addEventListener('change', applyVbrMode);
  for (const el of [scaleSel, fpsSel, vcodecSel, wIn, hIn]) {
    el.addEventListener('change', () => {
      if (vbrModeSel.value === 'auto') applyVbrMode();
    });
  }
  applyVbrMode();

  convertBtn.addEventListener('click', doConvert);

  // —— 时间轴控件 ——
  // 当前导出时间区间（秒）
  function rangeTimes() {
    const dur = isFinite(video.duration) ? video.duration : 0;
    return { start: gripAFrac * dur, end: gripBFrac * dur };
  }

  // 用 rAF 每帧检测是否越过右滑块，比 timeupdate（~250ms）更精准，避免蓝球视觉上越过右滑块
  function startLoopCheck() {
    stopLoopCheck();
    const tick = () => {
      if (!isSeeking && !video.paused) {
        const { start, end } = rangeTimes();
        if (video.currentTime >= end) {
          video.currentTime = start;
        }
      }
      loopRafId = requestAnimationFrame(tick);
    };
    loopRafId = requestAnimationFrame(tick);
  }
  function stopLoopCheck() {
    if (loopRafId !== null) {
      cancelAnimationFrame(loopRafId);
      loopRafId = null;
    }
  }

  video.addEventListener('timeupdate', updateTimeDisplay);
  video.addEventListener('play', () => {
    playBtn.textContent = '暂停';
    playOverlay.hidden = true;
    startLoopCheck();
  });
  video.addEventListener('pause', () => {
    stopLoopCheck();
    playBtn.textContent = '播放';
    playOverlay.hidden = !showPauseOverlay;
  });
  video.addEventListener('ended', () => {
    stopLoopCheck();
    const { start } = rangeTimes();
    // 若滑块区间不是全范围，则循环播放；否则正常结束
    if (gripAFrac > 0 || gripBFrac < 1) {
      video.currentTime = start;
      video.play();
    } else {
      playBtn.textContent = '播放';
      playOverlay.hidden = !showPauseOverlay;
    }
  });

  playBtn.addEventListener('click', () => {
    if (video.paused) {
      const { start, end } = rangeTimes();
      // 若当前位置在区间外，先跳到左滑块再播放
      if (video.currentTime < start || video.currentTime >= end) {
        video.currentTime = start;
      }
      video.play();
    } else video.pause();
  });

  // 点击视频画面切换播放/暂停（只响应 video 本身，不响应黑边/留白）
  video.addEventListener('click', () => {
    if (video.paused) {
      const { start, end } = rangeTimes();
      if (video.currentTime < start || video.currentTime >= end) {
        video.currentTime = start;
      }
      video.play();
    } else video.pause();
  });

  prevBtn.addEventListener('click', () => stepFrame(-1));
  nextBtn.addEventListener('click', () => stepFrame(1));
  resetBtn.addEventListener('click', () => {
    // 重置到左滑块位置
    const { start } = rangeTimes();
    video.currentTime = start;
    updateTimeDisplay();
  });

  // —— 音量控制 ——
  const VOL_ON = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z';
  const VOL_OFF = 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z';

  function updateMuteIcon() {
    const path = muteBtn.querySelector('path');
    if (path) path.setAttribute('d', video.muted ? VOL_OFF : VOL_ON);
    muteBtn.title = video.muted ? '取消静音' : '静音';
  }

  muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) {
      video.volume = 0.5;
      volSlider.value = 50;
    }
    volLabel.textContent = video.muted ? '0' : Math.round(video.volume * 100);
    updateMuteIcon();
  });

  volSlider.addEventListener('input', () => {
    const v = parseInt(volSlider.value, 10) / 100;
    video.volume = v;
    video.muted = v === 0;
    volLabel.textContent = volSlider.value;
    updateMuteIcon();
  });

  // 默认静音
  video.muted = true;
  video.volume = 0;
  volSlider.value = 0;
  volLabel.textContent = '0';
  updateMuteIcon();

  // —— "隐藏/显示暂停按钮"开关：控制暂停时中央播放三角是否显示 ——
  hideBtn.addEventListener('click', () => {
    showPauseOverlay = !showPauseOverlay;
    hideBtn.textContent = showPauseOverlay ? '隐藏暂停按钮' : '显示暂停按钮';
    // 立即反映到当前状态：若正在暂停，按新开关显示/隐藏浮层
    if (video.paused) {
      playOverlay.hidden = !showPauseOverlay;
    }
  });

  // —— 进度条拖动：同一时刻只允许一个 seek 在飞 ——
  // 以前每次 input 都直接写 video.currentTime，Chromium 会取消上一个还没完成的 seek：
  // 实测拖动 0.7 秒发 26 次 seek 只有 3 次真正完成，画面基本不跟手。改成「单飞 + 只保留最新目标」
  // 后，一个 seek 完成就立刻追最新位置，拖动时画面能稳定地按 10~20 fps 更新。
  const SEEK_WATCHDOG_MS = 700;
  let seekInflight = false;
  let seekTarget = null;
  let seekWatchdog = null;

  function clearSeekWatchdog() {
    if (seekWatchdog !== null) {
      clearTimeout(seekWatchdog);
      seekWatchdog = null;
    }
  }

  function issueSeek(t) {
    // 目标与当前位置几乎重合时不会再触发 seeked，直接当作已完成
    if (!video.seeking && Math.abs(t - video.currentTime) < 0.03) {
      onSeekSettled();
      return;
    }
    seekInflight = true;
    clearSeekWatchdog();
    // 个别文件/解码管线会丢 seeked：超时复位并补发最新目标，别让后面的拖动一直卡着
    seekWatchdog = setTimeout(() => {
      seekWatchdog = null;
      seekInflight = false;
      onSeekSettled();
    }, SEEK_WATCHDOG_MS);
    video.currentTime = t;
  }

  // 只记录最新目标；有 seek 在飞时等它完成再追，避免排队抖动
  function requestSeek(t) {
    seekTarget = t;
    if (!seekInflight) {
      const next = seekTarget;
      seekTarget = null;
      issueSeek(next);
    }
  }

  function onSeekSettled() {
    if (seekTarget !== null) {
      const next = seekTarget;
      seekTarget = null;
      issueSeek(next);
    }
  }

  video.addEventListener('seeked', () => {
    clearSeekWatchdog();
    seekInflight = false;
    onSeekSettled();
  });

  seek.addEventListener('input', () => {
    const dur = isFinite(video.duration) ? video.duration : 0;
    if (dur <= 0) return;
    isSeeking = true;
    if (!video.paused) {
      resumeAfterSeek = true;
      video.pause();
    }
    const t = (seek.value / 1000) * dur;
    // 立即更新时间显示（不依赖 seek 完成），让时间数字跟手
    timeLabel.textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
    updateSeekFill();
    requestSeek(t);
  });

  seek.addEventListener('change', () => {
    const dur = isFinite(video.duration) ? video.duration : 0;
    // 松开时补一次最终位置，保证落点精确
    if (dur > 0) requestSeek((seek.value / 1000) * dur);
    isSeeking = false;
    if (resumeAfterSeek) {
      resumeAfterSeek = false;
      // 立刻 play：Chromium 会在最后一次 seek 完成后从目标位置开始，省掉「等 seeked 再 play」的往返
      video.play();
    }
  });

  // —— 黄色时间滑块拖拽 ——
  function gripPointerDown(e, which) {
    e.preventDefault();
    e.stopPropagation();
    gripDrag = which;
    document.addEventListener('mousemove', gripPointerMove);
    document.addEventListener('mouseup', gripPointerUp);
  }
  function gripPointerMove(e) {
    const tl = seek.parentElement; // .vid-seek-tl
    const rect = tl.getBoundingClientRect();
    let frac = (e.clientX - rect.left) / rect.width;
    frac = Math.max(0, Math.min(1, frac));
    if (gripDrag === 'a') {
      gripAFrac = Math.min(frac, gripBFrac);
    } else {
      gripBFrac = Math.max(frac, gripAFrac);
    }
    updateGripUI();
  }
  function gripPointerUp() {
    gripDrag = null;
    document.removeEventListener('mousemove', gripPointerMove);
    document.removeEventListener('mouseup', gripPointerUp);
  }
  gripA.addEventListener('mousedown', (e) => gripPointerDown(e, 'a'));
  gripB.addEventListener('mousedown', (e) => gripPointerDown(e, 'b'));

  // —— 裁剪区域 ——
  // 计算视频在 canvas-wrap 内的实际渲染矩形（object-fit: contain）
  function getVideoRect() {
    const wrapW = canvasWrap.clientWidth;
    const wrapH = canvasWrap.clientHeight;
    const vw = video.videoWidth || wrapW;
    const vh = video.videoHeight || wrapH;
    const scale = Math.min(wrapW / vw, wrapH / vh);
    const w = vw * scale;
    const h = vh * scale;
    return {
      left: (wrapW - w) / 2,
      top: (wrapH - h) / 2,
      width: w,
      height: h,
    };
  }

  // 把鼠标事件坐标换算成视频归一化坐标 [0,1]
  function normFromEvent(e) {
    const r = getVideoRect();
    const wrapRect = canvasWrap.getBoundingClientRect();
    const x = (e.clientX - wrapRect.left - r.left) / r.width;
    const y = (e.clientY - wrapRect.top - r.top) / r.height;
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
  }

  // 把归一化选区渲染到 cropBox，并更新选区外的暗化遮罩（仅覆盖视频渲染区域）
  function renderCropBox() {
    if (!cropSel) {
      cropBox.style.display = 'none';
      maskT.style.display = 'none';
      maskB.style.display = 'none';
      maskL.style.display = 'none';
      maskR.style.display = 'none';
      return;
    }
    cropBox.style.display = '';
    maskT.style.display = '';
    maskB.style.display = '';
    maskL.style.display = '';
    maskR.style.display = '';
    // 归一化坐标：支持任意拖拽方向（左→右、右→左、上→下、下→上）
    const x0n = Math.min(cropSel.x0, cropSel.x1);
    const x1n = Math.max(cropSel.x0, cropSel.x1);
    const y0n = Math.min(cropSel.y0, cropSel.y1);
    const y1n = Math.max(cropSel.y0, cropSel.y1);
    const r = getVideoRect();
    const bx = r.left + x0n * r.width;
    const by = r.top + y0n * r.height;
    const bw = (x1n - x0n) * r.width;
    const bh = (y1n - y0n) * r.height;
    cropBox.style.left = bx + 'px';
    cropBox.style.top = by + 'px';
    cropBox.style.width = bw + 'px';
    cropBox.style.height = bh + 'px';
    // 上遮罩
    maskT.style.left = r.left + 'px';
    maskT.style.top = r.top + 'px';
    maskT.style.width = r.width + 'px';
    maskT.style.height = (by - r.top) + 'px';
    // 下遮罩
    maskB.style.left = r.left + 'px';
    maskB.style.top = (by + bh) + 'px';
    maskB.style.width = r.width + 'px';
    maskB.style.height = (r.top + r.height - by - bh) + 'px';
    // 左遮罩
    maskL.style.left = r.left + 'px';
    maskL.style.top = by + 'px';
    maskL.style.width = (bx - r.left) + 'px';
    maskL.style.height = bh + 'px';
    // 右遮罩
    maskR.style.left = (bx + bw) + 'px';
    maskR.style.top = by + 'px';
    maskR.style.width = (r.left + r.width - bx - bw) + 'px';
    maskR.style.height = bh + 'px';
  }

  // 视频是 object-fit: contain，画面渲染区域会随面板尺寸变化：
  // 窗口拖动/最大化后必须重算裁剪框和遮罩，否则选区和画面错位
  const cropResizeObserver = new ResizeObserver(() => {
    if (cropOn && cropSel) renderCropBox();
  });
  cropResizeObserver.observe(canvasWrap);

  cropBtn.addEventListener('click', () => {
    cropOn = !cropOn;
    cropOverlay.hidden = !cropOn;
    cropBtn.classList.toggle('on', cropOn);
    if (cropOn) renderCropBox();
  });

  cropOverlay.addEventListener('mousedown', (e) => {
    if (!cropOn) return;
    const target = e.target;
    if (target.classList.contains('crop-handle')) {
      const handle = [].find.call(target.classList, (c) => c !== 'crop-handle');
      cropDrag = { type: 'resize', handle, startSel: { ...cropSel } };
    } else if (target === cropBox) {
      cropDrag = { type: 'move', startSel: { ...cropSel }, startPt: normFromEvent(e) };
    } else {
      const pt = normFromEvent(e);
      cropSel = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
      cropDrag = { type: 'create' };
      renderCropBox();
    }
    e.preventDefault();
    document.addEventListener('mousemove', cropPointerMove);
    document.addEventListener('mouseup', cropPointerUp);
  });

  function cropPointerMove(e) {
    if (!cropDrag) return;
    const pt = normFromEvent(e);
    if (cropDrag.type === 'create') {
      cropSel.x1 = pt.x;
      cropSel.y1 = pt.y;
    } else if (cropDrag.type === 'move') {
      const dx = pt.x - cropDrag.startPt.x;
      const dy = pt.y - cropDrag.startPt.y;
      const w = cropDrag.startSel.x1 - cropDrag.startSel.x0;
      const h = cropDrag.startSel.y1 - cropDrag.startSel.y0;
      let nx0 = cropDrag.startSel.x0 + dx;
      let ny0 = cropDrag.startSel.y0 + dy;
      nx0 = Math.max(0, Math.min(1 - w, nx0));
      ny0 = Math.max(0, Math.min(1 - h, ny0));
      cropSel = { x0: nx0, y0: ny0, x1: nx0 + w, y1: ny0 + h };
    } else if (cropDrag.type === 'resize') {
      const s = cropDrag.startSel;
      let x0 = s.x0, y0 = s.y0, x1 = s.x1, y1 = s.y1;
      const h = cropDrag.handle;
      if (h.includes('w')) x0 = pt.x;
      if (h.includes('e')) x1 = pt.x;
      if (h.includes('n')) y0 = pt.y;
      if (h.includes('s')) y1 = pt.y;
      if (x0 > x1) [x0, x1] = [x1, x0];
      if (y0 > y1) [y0, y1] = [y1, y0];
      cropSel = { x0, y0, x1, y1 };
    }
    renderCropBox();
  }

  function cropPointerUp() {
    cropDrag = null;
    document.removeEventListener('mousemove', cropPointerMove);
    document.removeEventListener('mouseup', cropPointerUp);
    if (cropSel) {
      if (cropSel.x0 > cropSel.x1) [cropSel.x0, cropSel.x1] = [cropSel.x1, cropSel.x0];
      if (cropSel.y0 > cropSel.y1) [cropSel.y0, cropSel.y1] = [cropSel.y1, cropSel.y0];
      renderCropBox();
    }
  }

  return {
    loadEntry,
  };
}
