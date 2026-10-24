import {
  pickImages,
  videoSrc,
  releaseSrc,
  resolveSaveDir,
  uniqueFilename,
  dirname,
  stemOf,
  isTauri,
  isAudioName,
  isVideoName,
  AUDIO_SOURCE_EXTS,
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

// 解析 "HH:MM:SS" 或 "MM:SS" 为秒数
function parseTimeStr(s) {
  s = (s || '').trim();
  if (!s) return null;
  const parts = s.split(':').map((p) => p.trim());
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const sec = parseFloat(parts[1]);
    if (!isNaN(m) && !isNaN(sec)) return m * 60 + sec;
  } else if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const sec = parseFloat(parts[2]);
    if (!isNaN(h) && !isNaN(m) && !isNaN(sec)) return h * 3600 + m * 60 + sec;
  }
  return null;
}

export function initAudioConvert() {
  const audio = $('aud-src');
  const info = $('aud-info');
  const openBtn = $('aud-open');
  const clearBtn = $('aud-clear');
  const fmtSel = $('aud-fmt');
  const acodecSel = $('aud-acodec');
  const bitrateSel = $('aud-bitrate');
  const srSel = $('aud-sr');
  const chSel = $('aud-ch');
  const startIn = $('aud-start');
  const endIn = $('aud-end');
  const nameIn = $('aud-name');
  const saveOrigChk = $('aud-save-orig');
  const convertBtn = $('aud-convert');
  const progressFill = $('aud-progress-fill');
  const progressText = $('aud-progress-text');
  const status = $('aud-status');

  const io = createIoButtons($('aud-io'), setStatus);

  let entry = null;
  let srcUrl = null;
  let audioInfo = null;
  let converting = false;
  let unlisten = null;

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

  function fmtCh(n) {
    if (!n) return '';
    return n === 1 ? '单声道' : n === 2 ? '立体声' : `${n} 声道`;
  }

  function updateInfo() {
    if (!audioInfo) {
      info.textContent = '未载入音频';
      return;
    }
    const v = audioInfo;
    const parts = [`时长：${fmtTime(v.duration)}`];
    if (v.audio_codec) parts.push(`编码：${v.audio_codec}`);
    if (v.sample_rate) parts.push(`采样率：${v.sample_rate} Hz`);
    if (v.channels) parts.push(`声道：${fmtCh(v.channels)}`);
    if (v.bitrate) parts.push(v.bitrate);
    info.textContent = parts.join('  |  ');
  }

  async function loadEntry(e) {
    if (converting) return;
    const name = (e.name || '').toLowerCase();
    const isAudio = isAudioName(name);
    const isVideo = isVideoName(name);
    if (!isAudio && !isVideo) {
      setStatus('不支持的格式：' + e.name);
      return;
    }
    entry = e;
    io.setSource(e.path);
    io.setExport(null);
    setStatus('正在读取音频信息…');

    if (srcUrl) releaseSrc(srcUrl);
    srcUrl = videoSrc(e);
    if (srcUrl) {
      audio.src = srcUrl;
    }

    if (isTauri) {
      try {
        audioInfo = await window.__TAURI__.core.invoke('ffprobe_video', { path: e.path });
      } catch (ex) {
        audioInfo = null;
        setStatus('读取音频信息失败：' + (ex?.message ?? ex));
      }
    } else {
      const onLoaded = () => {
        audioInfo = {
          duration: audio.duration,
          audio_codec: '',
          sample_rate: null,
          channels: null,
          bitrate: '',
        };
        updateInfo();
        audio.removeEventListener('loadedmetadata', onLoaded);
      };
      audio.addEventListener('loadedmetadata', onLoaded);
    }

    updateInfo();
    setEnabled(true);
    setStatus('已载入：' + e.name);
    setProgress(0);
  }

  async function doConvert() {
    if (!entry || converting) return;
    if (!isTauri) {
      setStatus('音频格式转换需要桌面版环境（内置 FFmpeg），浏览器中无法使用');
      return;
    }

    const fmt = fmtSel.value;
    let outName = nameIn.value.trim();
    if (!outName) outName = stemOf(entry.name) + '_转换';
    outName = outName.replace(/\.[^.]+$/, '') + '.' + fmt;

    const dir = saveOrigChk.checked ? dirname(entry.path) : await resolveSaveDir(null);
    if (!dir) {
      setStatus('未选择输出目录');
      return;
    }
    const finalName = await uniqueFilename(dir, outName);
    const sep = dir.includes('\\') ? '\\' : '/';
    const outPath = dir.endsWith('\\') || dir.endsWith('/') ? dir + finalName : dir + sep + finalName;

    const options = {};
    const ac = acodecSel.value;
    options.audio_codec = ac;

    const br = bitrateSel.value;
    if (br) options.audio_bitrate = br;

    const sr = parseInt(srSel.value, 10);
    if (sr > 0) options.sample_rate = sr;

    const ch = parseInt(chSel.value, 10);
    if (ch > 0) options.channels = ch;

    const start = parseTimeStr(startIn.value);
    const end = parseTimeStr(endIn.value);
    if (start !== null) options.start_time = start;
    if (end !== null) options.end_time = end;

    converting = true;
    setEnabled(false);
    convertBtn.textContent = '转换中…';
    setProgress(0);
    setStatus(`正在转换为 ${fmt.toUpperCase()}…`);

    unlisten = await window.__TAURI__.event.listen('audio-progress', (ev) => {
      setProgress(ev.payload);
    });

    try {
      await window.__TAURI__.core.invoke('convert_audio', {
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

  openBtn.addEventListener('click', async () => {
    const entries = await pickImages(false, AUDIO_SOURCE_EXTS, {
      title: '选择音频文件',
      label: '音频文件',
    });
    if (entries?.[0]) loadEntry(entries[0]);
  });

  clearBtn.addEventListener('click', () => {
    if (converting) return;
    entry = null;
    audioInfo = null;
    if (srcUrl) {
      releaseSrc(srcUrl);
      srcUrl = null;
    }
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    setProgress(0);
    setEnabled(false);
    updateInfo();
    io.clear();
    setStatus('');
  });

  convertBtn.addEventListener('click', doConvert);

  return {
    loadEntry,
  };
}
