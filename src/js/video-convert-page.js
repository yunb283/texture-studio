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
  }

  // 同步进度条的蓝色填充比例
  function updateSeekFill() {
    const pct = seek.max > 0 ? (seek.value / seek.max) * 100 : 0;
    seek.style.setProperty('--seek-pct', pct + '%');
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
      updateSeekFill();
      playOverlay.hidden = false;
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
    updateInfo();
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
  video.addEventListener('timeupdate', updateTimeDisplay);
  video.addEventListener('play', () => {
    playBtn.textContent = '暂停';
    playOverlay.hidden = true;
  });
  video.addEventListener('pause', () => {
    playBtn.textContent = '播放';
    playOverlay.hidden = false;
  });
  video.addEventListener('ended', () => {
    playBtn.textContent = '播放';
    playOverlay.hidden = false;
  });

  playBtn.addEventListener('click', () => {
    if (video.paused) video.play();
    else video.pause();
  });

  // 点击视频画面切换播放/暂停（只响应 video 本身，不响应黑边/留白）
  video.addEventListener('click', () => {
    if (video.paused) video.play();
    else video.pause();
  });

  prevBtn.addEventListener('click', () => stepFrame(-1));
  nextBtn.addEventListener('click', () => stepFrame(1));
  resetBtn.addEventListener('click', () => {
    video.currentTime = 0;
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

  return {
    loadEntry,
  };
}
