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
  const resetDefaultsBtn = $('aud-reset-defaults');

  // 批量转换相关 DOM
  const singleWrap = $('aud-single-wrap');
  const batchWrap = $('aud-batch-wrap');
  const batchListEl = $('aud-batch-list');
  const batchCountEl = $('aud-batch-count');
  const batchSummaryEl = $('aud-batch-summary');
  const batchAddBtn = $('aud-batch-add');
  const batchAddFolderBtn = $('aud-batch-add-folder');
  const batchClearBtn = $('aud-batch-clear');
  const modeSingleBtn = $('aud-mode-single');
  const modeBatchBtn = $('aud-mode-batch');

  const io = createIoButtons($('aud-io'), setStatus);
  const srcSizeEl = $('aud-src-size');
  const srcNameEl = $('aud-src-name');
  const outSizeEl = $('aud-out-size');

  let entry = null;
  let srcUrl = null;
  let audioInfo = null;
  let probeSeq = 0; // 丢弃上一个文件迟到的探测结果
  let converting = false;
  let unlisten = null;

  // ===== 批量转换状态 =====
  let batchMode = false;
  let batchFiles = [];       // [{ path, name, status, percent, outPath }]
  let batchIndex = -1;
  let batchCancelled = false;
  let batchLastOutDir = null;

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

  // 恢复音频转换设置为默认值
  function resetDefaults() {
    fmtSel.value = 'mp3';
    acodecSel.value = 'libmp3lame';
    bitrateSel.value = '';
    srSel.value = '0';
    chSel.value = '0';
    startIn.value = '';
    endIn.value = '';
    nameIn.value = '';
    saveOrigChk.checked = true;
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
    const seq = ++probeSeq;
    entry = e;
    srcNameEl.textContent = e.name;
    io.setSource(e.path);
    io.setExport(null);
    // 先放个空壳，时长等 <audio> 元数据一到就填上
    audioInfo = { duration: 0, audio_codec: '', sample_rate: null, channels: null, bitrate: '' };
    outSizeEl.textContent = '';
    srcSizeEl.textContent = '';
    fileSizeOf(e).then((n) => {
      if (entry === e) srcSizeEl.textContent = formatBytes(n);
    });

    if (srcUrl) releaseSrc(srcUrl);
    srcUrl = videoSrc(e);
    if (srcUrl) {
      audio.src = srcUrl;
    }

    const onLoaded = () => {
      if (audioInfo && isFinite(audio.duration)) audioInfo.duration = audio.duration;
      updateInfo();
      audio.removeEventListener('loadedmetadata', onLoaded);
    };
    audio.addEventListener('loadedmetadata', onLoaded);

    // 导入不等探测：编码/采样率/声道数由后台 ffprobe 补
    updateInfo();
    setEnabled(true);
    setProgress(0);
    setStatus('已载入：' + e.name);

    if (isTauri) {
      window.__TAURI__.core
        .invoke('ffprobe_video', { path: e.path })
        .then((info) => {
          if (seq !== probeSeq || !info) return;
          audioInfo = info;
          updateInfo();
        })
        .catch((ex) => {
          if (seq !== probeSeq) return;
          setStatus('已载入：' + e.name + '（读取音频信息失败：' + (ex?.message ?? ex) + '）');
        });
    }
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
    probeSeq++;
    srcNameEl.textContent = '';
    srcSizeEl.textContent = '';
    outSizeEl.textContent = '';
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

  // 格式 → 编码自动同步（和 video 页的 syncCodecByFormat 一样）
  const FMT_TO_CODEC = {
    mp3: 'libmp3lame',
    wav: 'pcm_s16le',
    flac: 'flac',
    aac: 'aac',
    m4a: 'aac',
    ogg: 'libvorbis',
    opus: 'libopus',
    alac: 'alac',
  };
  function syncCodecByFormat() {
    const fmt = fmtSel.value;
    const target = FMT_TO_CODEC[fmt];
    if (!target) return;
    // 选得到就选，选不到（比如 copy 不在表里）就不动
    for (const opt of acodecSel.options) {
      if (opt.value === target) {
        acodecSel.value = target;
        break;
      }
    }
    acodecSel.disabled = true;
  }
  fmtSel.addEventListener('change', syncCodecByFormat);

  convertBtn.addEventListener('click', () => {
    if (batchMode) {
      if (converting) { batchCancelled = true; convertBtn.textContent = '停止中…'; }
      else { doBatchConvert(); }
    } else {
      doConvert();
    }
  });

  resetDefaultsBtn.addEventListener('click', () => {
    resetDefaults();
  });

  // ===== 音频批量转换辅助函数 =====

  function toggleBatchMode(mode) {
    if (converting) return;
    batchMode = !!mode;
    if (batchMode) {
      singleWrap.hidden = true;
      batchWrap.hidden = false;
      modeSingleBtn.classList.remove('on');
      modeBatchBtn.classList.add('on');
      convertBtn.textContent = '全部转换';
      convertBtn.disabled = !batchFiles.length || converting;
    } else {
      singleWrap.hidden = false;
      batchWrap.hidden = true;
      modeBatchBtn.classList.remove('on');
      modeSingleBtn.classList.add('on');
      convertBtn.textContent = '开始转换';
      convertBtn.disabled = !entry;
    }
  }

  function renderBatchList() {
    batchListEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    batchFiles.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'batch-file-row';
      const tagClass = f.status === 'done' ? 'tag-done' : f.status === 'fail' ? 'tag-fail' : f.status === 'run' ? 'tag-run' : 'tag-queue';
      const tagText = f.status === 'done' ? '✓ 完成' : f.status === 'fail' ? '✗ 失败' : f.status === 'run' ? '转换中' : '等待';
      row.innerHTML = `
        <div class="batch-file-name"><span class="status-tag ${tagClass}">${tagText}</span>${f.name}</div>
        <div class="batch-mini-bar"><div class="batch-mini-bar-fill ${tagClass.replace('tag-', '')}" style="width:${Math.round((f.percent || 0) * 100)}%;"></div></div>
        <div class="batch-mini-pct ${tagClass === 'tag-done' ? 'done' : tagClass === 'tag-fail' ? 'fail' : ''}">${Math.round((f.percent || 0) * 100)}%</div>
        <button class="batch-remove" title="移除">✕</button>
      `;
      row.querySelector('.batch-remove').addEventListener('click', () => {
        if (converting) return;
        batchFiles.splice(i, 1); renderBatchList(); updateSummary();
      });
      frag.appendChild(row);
    });
    batchListEl.appendChild(frag);
    batchCountEl.textContent = batchFiles.length ? `· ${batchFiles.length} 个` : '';
  }

  function updateSummary() {
    const q = batchFiles.filter(f => f.status === 'queue').length;
    const r = batchFiles.filter(f => f.status === 'run').length;
    const d = batchFiles.filter(f => f.status === 'done').length;
    const f = batchFiles.filter(f => f.status === 'fail').length;
    batchSummaryEl.innerHTML = batchFiles.length
      ? `<span><span class="dot" style="background:#39c7ed;"></span>转换中 ${r}</span>
         <span><span class="dot" style="background:#9a9ca5;"></span>等待 ${q}</span>
         <span><span class="dot" style="background:#2ecc71;"></span>完成 ${d}</span>
         <span><span class="dot" style="background:#e74c3c;"></span>失败 ${f}</span>`
      : '尚未添加文件';
  }

  function setBatchFileStatus(i, status, percent = null) {
    if (i < 0 || i >= batchFiles.length) return;
    batchFiles[i].status = status;
    if (percent !== null) batchFiles[i].percent = percent;
    const rows = batchListEl.querySelectorAll('.batch-file-row');
    const row = rows[i]; if (!row) return;
    const tagClass = status === 'done' ? 'tag-done' : status === 'fail' ? 'tag-fail' : status === 'run' ? 'tag-run' : 'tag-queue';
    const tagText = status === 'done' ? '✓ 完成' : status === 'fail' ? '✗ 失败' : status === 'run' ? '转换中' : '等待';
    row.querySelector('.status-tag').className = `status-tag ${tagClass}`;
    row.querySelector('.status-tag').textContent = tagText;
    const fill = row.querySelector('.batch-mini-bar-fill');
    fill.className = `batch-mini-bar-fill ${tagClass.replace('tag-', '')}`;
    if (percent !== null) fill.style.width = `${Math.round(percent * 100)}%`;
    const pct = row.querySelector('.batch-mini-pct');
    pct.textContent = `${Math.round((percent !== null ? percent : (batchFiles[i].percent || 0)) * 100)}%`;
    pct.className = `batch-mini-pct ${tagClass === 'tag-done' ? 'done' : tagClass === 'tag-fail' ? 'fail' : ''}`;
  }

  function setBatchFileProgress(i, percent) {
    if (i < 0 || i >= batchFiles.length) return;
    batchFiles[i].percent = percent;
    const row = batchListEl.querySelectorAll('.batch-file-row')[i]; if (!row) return;
    row.querySelector('.batch-mini-bar-fill').style.width = `${Math.round(percent * 100)}%`;
    row.querySelector('.batch-mini-pct').textContent = `${Math.round(percent * 100)}%`;
  }

  function buildAudioOptions() {
    const options = {};
    options.audio_codec = acodecSel.value;
    const br = bitrateSel.value;
    if (br) options.audio_bitrate = br;
    const sr = parseInt(srSel.value, 10);
    if (sr > 0) options.sample_rate = sr;
    const ch = parseInt(chSel.value, 10);
    if (ch > 0) options.channels = ch;
    return options;
  }

  async function buildAudioOutputPath(filePath, prefix, batchIdx) {
    const fmt = fmtSel.value;
    const sep = filePath.includes('\\') ? '\\' : '/';
    const dir = filePath.substring(0, filePath.lastIndexOf(sep));
    let outName;
    const prefixTrim = (prefix || '').trim();
    if (prefixTrim) {
      outName = `${prefixTrim}_${String(batchIdx + 1).padStart(2, '0')}.${fmt}`;
    } else {
      const base = filePath.substring(filePath.lastIndexOf(sep) + 1);
      const stem = base.substring(0, base.lastIndexOf('.')) || base;
      outName = `${stem}.${fmt}`;
    }
    const finalName = await uniqueFilename(dir, outName);
    return dir + sep + finalName;
  }

  async function doBatchConvert() {
    if (!batchFiles.length || converting) return;
    if (!isTauri) { setStatus('批量转换需要桌面版环境'); return; }

    converting = true;
    batchCancelled = false;
    batchIndex = -1;
    const suffix = nameIn.value.trim();

    batchFiles.forEach(f => { if (f.status !== 'done') { f.status = 'queue'; f.percent = 0; } });
    renderBatchList(); updateSummary();

    convertBtn.textContent = '停止转换';
    setEnabled(false);
    setStatus(`批量转换开始：共 ${batchFiles.length} 个文件`);

    const progressListener = await window.__TAURI__.event.listen('audio-progress', (ev) => {
      if (batchIndex >= 0 && batchIndex < batchFiles.length) {
        setBatchFileProgress(batchIndex, ev.payload);
      }
    });

    try {
      for (let i = 0; i < batchFiles.length; i++) {
        if (batchCancelled) break;
        const f = batchFiles[i];
        if (f.status === 'done') continue;

        batchIndex = i;
        setBatchFileStatus(i, 'run', 0);
        setStatus(`正在转换 (${i + 1}/${batchFiles.length})：${f.name}`);

        try {
          const outPath = await buildAudioOutputPath(f.path, suffix, i);
          const options = buildAudioOptions();
          await window.__TAURI__.core.invoke('convert_audio', { input: f.path, output: outPath, options });
          batchFiles[i].outPath = outPath;
          setBatchFileStatus(i, 'done', 1);
          batchLastOutDir = dirname(outPath);
          io.setSource(f.path);
          io.setExport(outPath);
        } catch (ex) {
          setBatchFileStatus(i, 'fail');
        }
        updateSummary();
      }
    } finally {
      progressListener();
      converting = false;
      batchIndex = -1;
      convertBtn.textContent = '全部转换';
      setEnabled(true);

      if (batchCancelled) {
        setStatus('已停止批量转换');
      } else {
        const d = batchFiles.filter(f => f.status === 'done').length;
        const fl = batchFiles.filter(f => f.status === 'fail').length;
        setStatus(`批量转换完成：成功 ${d}，失败 ${fl}`);
      }
    }
  }

  // ===== 批量：添加/清空按钮绑定 =====
  modeSingleBtn.addEventListener('click', () => toggleBatchMode(false));
  modeBatchBtn.addEventListener('click', () => toggleBatchMode(true));

  batchAddBtn.addEventListener('click', async () => {
    if (converting) return;
    const entries = await pickImages(true, AUDIO_SOURCE_EXTS, { title: '选择音频/视频文件' });
    if (entries?.length) {
      const existing = new Set(batchFiles.map(f => f.path));
      for (const e of entries) {
        if (!existing.has(e.path)) batchFiles.push({ path: e.path, name: e.name, status: 'queue', percent: 0 });
      }
      renderBatchList(); updateSummary();
      convertBtn.disabled = !batchFiles.length || converting;
    }
  });

  batchAddFolderBtn.addEventListener('click', async () => {
    if (converting) return;
    const dir = await window.__TAURI__.core.invoke('pick_dir');
    if (!dir) return;
    try {
      const files = await window.__TAURI__.core.invoke('list_files', { dir });
      const existing = new Set(batchFiles.map(f => f.path));
      for (const p of files) {
        const sepIdx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
        const name = sepIdx >= 0 ? p.substring(sepIdx + 1) : p;
        if (!existing.has(p) && AUDIO_SOURCE_EXTS.includes((p.split('.').pop() || '').toLowerCase())) {
          batchFiles.push({ path: p, name, status: 'queue', percent: 0 });
        }
      }
      renderBatchList(); updateSummary();
      convertBtn.disabled = !batchFiles.length || converting;
    } catch (ex) {
      setStatus('读取文件夹失败：' + (ex?.message ?? ex));
    }
  });

  batchClearBtn.addEventListener('click', () => {
    if (converting) return;
    batchFiles = []; renderBatchList(); updateSummary();
    convertBtn.disabled = !batchFiles.length || converting;
  });

  return {
    loadEntry,
  };
}
