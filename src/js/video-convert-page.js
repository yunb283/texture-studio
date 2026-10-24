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

  const io = createIoButtons($('vid-io'), setStatus);

  let entry = null;
  let srcUrl = null;
  let videoInfo = null;
  let converting = false;
  let unlisten = null;
  let isSeeking = false;
  let resumeAfterSeek = false;
  // 拖动节流：用 rAF 合并一帧内的多次 seek，只执行最后一次，避免浏览器排队 seek 导致延迟
  let seekRafId = null;
  let pendingSeekTime = null;
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

  function stepFrame(delta) {
    video.pause();
    const fps = (videoInfo && videoInfo.fps > 0) ? videoInfo.fps : 30;
    const dur = isFinite(video.duration) ? video.duration : 0;
    let t = video.currentTime + (delta / fps);
    t = Math.max(0, Math.min(dur, t));
    video.currentTime = t;
    updateTimeDisplay();
  }

  function updateInfo() {
    if (!videoInfo) {
      info.textContent = '未载入视频';
      return;
    }
    const v = videoInfo;
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
    entry = e;
    io.setSource(e.path);
    io.setExport(null);
    setStatus('正在读取视频信息…');

    // 预览
    if (srcUrl) releaseSrc(srcUrl);
    srcUrl = videoSrc(e);
    if (srcUrl) {
      video.src = srcUrl;
    }

    // 视频元数据就绪后启用时间轴
    const onMeta = () => {
      updateTimeDisplay();
      setTimelineEnabled(true);
      seek.value = 0;
      // 重置黄色滑块到全区间
      gripAFrac = 0;
      gripBFrac = 1;
      updateGripUI();
      playOverlay.hidden = !showPauseOverlay;
      video.removeEventListener('loadedmetadata', onMeta);
    };
    video.addEventListener('loadedmetadata', onMeta);

    // 用 ffmpeg 探测信息（Tauri 环境）
    if (isTauri) {
      try {
        videoInfo = await window.__TAURI__.core.invoke('ffprobe_video', { path: e.path });
      } catch (ex) {
        videoInfo = null;
        setStatus('读取视频信息失败：' + (ex?.message ?? ex));
      }
    } else {
      // 浏览器环境没有 ffmpeg，用 video 元素的元数据
      const onLoaded = () => {
        videoInfo = {
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          fps: 0,
          video_codec: '',
          audio_codec: '',
          bitrate: '',
        };
        updateInfo();
        video.removeEventListener('loadedmetadata', onLoaded);
      };
      video.addEventListener('loadedmetadata', onLoaded);
    }

    updateInfo();
    setEnabled(true);
    setStatus('已载入：' + e.name);
    setProgress(0);
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
    if (cropSel && videoInfo) {
      const sx = cropSel.x1 - cropSel.x0;
      const sy = cropSel.y1 - cropSel.y0;
      if (sx > 0 && sy > 0) {
        options.crop_x = Math.round(cropSel.x0 * videoInfo.width);
        options.crop_y = Math.round(cropSel.y0 * videoInfo.height);
        options.crop_w = Math.max(1, Math.round(cropSel.x1 * videoInfo.width) - options.crop_x);
        options.crop_h = Math.max(1, Math.round(cropSel.y1 * videoInfo.height) - options.crop_y);
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
    vbrIn.disabled = copy;
    abrIn.disabled = copy;
  });

  fmtSel.addEventListener('change', syncCodecByFormat);
  vcodecSel.addEventListener('change', syncCodecByFormat);

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

  // 拖动进度条：用 rAF 合并一帧内的多次拖动，只执行最后一次 seek，画面跟手不卡顿
  function flushSeek() {
    seekRafId = null;
    if (pendingSeekTime !== null) {
      video.currentTime = pendingSeekTime;
      pendingSeekTime = null;
    }
    updateTimeDisplay();
  }

  function scheduleSeek(t) {
    pendingSeekTime = t;
    if (seekRafId === null) {
      seekRafId = requestAnimationFrame(flushSeek);
    }
  }

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
    scheduleSeek(t);
  });

  seek.addEventListener('change', () => {
    // 松开时若还有 pending，立刻执行一次（保证最终位置精确）
    if (seekRafId !== null) {
      cancelAnimationFrame(seekRafId);
      seekRafId = null;
      if (pendingSeekTime !== null) {
        video.currentTime = pendingSeekTime;
        pendingSeekTime = null;
      }
    }
    isSeeking = false;
    if (resumeAfterSeek) {
      video.play();
      resumeAfterSeek = false;
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
