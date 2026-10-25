import { isTauri } from './platform.js';
import { createIoButtons } from './io-buttons.js';

const $ = (id) => document.getElementById(id);

// yt-dlp 的 codec 字符串 → 一眼能看懂的名字
function codecLabel(f) {
  const v = (f.vcodec || '').toLowerCase();
  const a = (f.acodec || '').toLowerCase();
  if (v && v !== 'none') {
    if (v.startsWith('avc') || v.startsWith('h264')) return 'H.264';
    if (v.startsWith('hev') || v.startsWith('hvc') || v.startsWith('h265')) return 'H.265';
    if (v.startsWith('av01')) return 'AV1';
    if (v.startsWith('vp09') || v.startsWith('vp9')) return 'VP9';
    if (v.startsWith('vp08') || v.startsWith('vp8')) return 'VP8';
    if (v.startsWith('mp4v')) return 'MPEG-4';
    return v.split('.')[0].toUpperCase();
  }
  if (a.startsWith('mp4a')) return 'AAC';
  if (a.startsWith('opus')) return 'Opus';
  if (a.startsWith('flac')) return 'FLAC';
  if (a.startsWith('mp3')) return 'MP3';
  if (a.startsWith('vorbis')) return 'Vorbis';
  return '';
}

function formatSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  return `${mb.toFixed(1)} MB`;
}

function formatDuration(sec) {
  if (!sec || sec <= 0) return '未知';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function resLabel(f) {
  if (f.vcodec === 'none') return '音频';
  if (f.height) return `${f.height}p${f.fps ? ` ${Math.round(f.fps)}fps` : ''}`;
  return f.resolution || '-';
}

const CODEC_ORDER = ['H.264', 'H.265', 'AV1', 'VP9', 'VP8', 'MPEG-4'];

export function initVideoDownload() {
  const urlInput = $('dl-url');
  const fetchBtn = $('dl-fetch');
  const clearBtn = $('dl-clear');
  const thumb = $('dl-thumb');
  const thumbPh = $('dl-thumb-placeholder');
  const infoEl = $('dl-info');
  const fmtList = $('dl-fmt-list');
  const fmtLabel = $('dl-fmt-label');
  const resSel = $('dl-res');
  const codecSel = $('dl-codec');
  const sizeLine = $('dl-size-line');
  const nameInput = $('dl-name');
  const saveDefaultChk = $('dl-save-default');
  const saveCustomChk = $('dl-save-custom');
  const dirInput = $('dl-dir');
  const browseBtn = $('dl-browse');
  const downloadBtn = $('dl-download');
  const progressFill = $('dl-progress-fill');
  const progressText = $('dl-progress-text');
  const progressMeta = $('dl-progress-meta');
  const statusEl = $('dl-status');
  const clearAllBtn = $('dl-clear-all');

  const io = createIoButtons($('dl-io'));

  let currentInfo = null;
  let resChoices = []; // [{ key, height, fps }]
  let audioBest = null; // 最佳音频（合并用）
  let ctxFormat = null; // 右键要下载的格式（一次性）
  let downloading = false;
  let lastOutputPath = null;
  let parseToken = 0; // 解析令牌：清除链接时 +1，让进行中的解析结果失效
  let parsing = false; // 是否有解析正在执行

  // ===== 播放列表状态 =====
  let playlistMode = false; // true = 当前是合集/播放列表
  let playlistEntries = []; // [{ id, title, duration, webpage_url, checked }]
  let playlistDownloading = false; // 批量下载中（用于进度路由和停止）
  let playlistStopRequested = false;

  // DOM 引用
  const playlistWrap = $('dl-playlist-wrap');
  const playlistListEl = $('dl-playlist-list');
  const playlistCountEl = $('dl-pl-count');
  const plSelectAllBtn = $('dl-pl-select-all');
  const plSelectNoneBtn = $('dl-pl-select-none');

  function setStatus(msg) {
    statusEl.textContent = msg || '';
  }

  // 解析 "10.00MiB" / "1.23GiB" / "512.0KiB" → { num, unit }
  function parseSize(str) {
    if (!str) return null;
    const m = str.trim().match(/^([\d.]+)\s*(\w+)$/);
    if (!m) return null;
    return { num: parseFloat(m[1]), unit: m[2] };
  }

  function formatDownloaded(totalSize, percent) {
    const p = parseSize(totalSize);
    if (!p) return '';
    const downloaded = p.num * (percent || 0);
    return `${downloaded.toFixed(2)} ${p.unit} / ${p.num.toFixed(2)} ${p.unit}`;
  }

  function setProgress(p, speed, eta, phase, totalSize) {
    phase = phase || 'download';
    const pct = Math.round((p || 0) * 100);
    const progressBar = progressFill.parentElement;

    if (phase === 'merge') {
      // 合并阶段：进度条变成 indeterminate 条纹动画
      progressFill.classList.add('merge-phase');
      progressBar.classList.add('merge-phase');
      progressFill.style.width = '0%';
      progressText.textContent = '合并中…';
      progressMeta.textContent = '';
      setStatus('视频下载完成，正在合并视频与音频…');
    } else if (phase === 'done') {
      progressFill.classList.remove('merge-phase');
      progressBar.classList.remove('merge-phase');
      progressFill.style.width = '100%';
      progressText.textContent = '100%';
      progressMeta.textContent = '';
      setStatus('下载完成');
    } else {
      // download 阶段
      progressFill.classList.remove('merge-phase');
      progressBar.classList.remove('merge-phase');
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `${pct}%`;
      const meta = [];
      if (totalSize) {
        const dl = formatDownloaded(totalSize, p);
        if (dl) meta.push(dl);
      }
      if (speed) meta.push(speed);
      if (eta) meta.push(`剩余 ${eta}`);
      progressMeta.textContent = meta.join(' · ');
    }
  }

  // 清空视频信息和下载设置（保存目录设置保持不变）
  function clearAll() {
    if (downloading || playlistDownloading) return;
    ctxFormat = null;
    currentInfo = null;
    resChoices = [];
    audioBest = null;
    playlistMode = false;
    playlistEntries = [];
    playlistDownloading = false;
    playlistStopRequested = false;

    // 清空 URL
    urlInput.value = '';

    // 封面 + 信息
    thumb.removeAttribute('src');
    thumb.style.display = 'none';
    thumbPh.style.display = '';
    thumbPh.textContent = '尚未解析视频';
    infoEl.textContent = '未解析视频';

    // 格式列表 + playlist 列表
    fmtList.innerHTML = '';
    playlistListEl.innerHTML = '';
    playlistWrap.hidden = true;
    fmtList.style.display = ''; // 恢复显示

    // 分辨率 / 编码下拉：回到初始空状态
    resSel.innerHTML = '<option value="">最佳可用</option>';
    codecSel.innerHTML = '<option value="">-</option>';
    codecSel.value = '';
    resSel.disabled = false;
    codecSel.disabled = false;

    // 辅助文字
    fmtLabel.textContent = '将下载：最佳可用（视频+音频自动合并）';
    sizeLine.textContent = '文件大小：-';

    // 文件名
    nameInput.value = '';
    nameInput.disabled = false;

    // 进度和状态
    setProgress(0);
    progressMeta.textContent = '';
    setStatus('');

    // 按钮
    downloadBtn.disabled = true;
    downloadBtn.textContent = '开始下载';
    fetchBtn.disabled = false;

    // IO 清理
    io.clear();
    lastOutputPath = null;
  }

  // —— 分辨率 / 编码选择 ——
  function collectResChoices(formats) {
    const map = new Map();
    for (const f of formats) {
      if (f.vcodec === 'none' || !f.height) continue;
      const fps = Math.round(f.fps || 0);
      const key = `${f.height}|${fps}`;
      if (!map.has(key)) map.set(key, { key, height: f.height, fps });
    }
    return [...map.values()].sort((a, b) => b.height - a.height || b.fps - a.fps);
  }

  function currentChoice() {
    return resChoices.find((c) => c.key === resSel.value) || null;
  }

  function formatsAt(choice) {
    const formats = currentInfo?.formats || [];
    return formats.filter(
      (f) =>
        f.vcodec !== 'none' &&
        f.height === choice.height &&
        Math.round(f.fps || 0) === choice.fps
    );
  }

  function codecChoices(choice) {
    const map = new Map();
    for (const f of formatsAt(choice)) {
      const codec = codecLabel(f);
      if (!codec) continue;
      const prev = map.get(codec);
      if (!prev || (f.tbr || 0) > (prev.tbr || 0)) map.set(codec, f);
    }
    return [...map.entries()].sort(
      (a, b) => CODEC_ORDER.indexOf(a[0]) - CODEC_ORDER.indexOf(b[0])
    );
  }

  // 当前下拉选中的具体格式（同分辨率同编码取码率最高的一条）
  function selectedFormat() {
    const choice = currentChoice();
    if (!choice) return null;
    const list = codecChoices(choice);
    if (!list.length) return null;
    const hit = list.find(([codec]) => codec === codecSel.value) || list[0];
    return hit[1];
  }

  // 没给 filesize 的站点（如 YouTube）用 码率 × 时长 估算
  function estimateBytes(f) {
    if (!f) return 0;
    const size = f.filesize || f.filesize_approx;
    if (size) return size;
    const tbr = f.tbr || 0;
    const dur = currentInfo?.duration || 0;
    if (tbr > 0 && dur > 0) return (tbr * 1000 * dur) / 8;
    return 0;
  }

  function updateSizeLine() {
    const f = selectedFormat();
    if (!f) {
      sizeLine.textContent = '文件大小：-';
      return;
    }
    const size = estimateBytes(f);
    const hasAudio = f.acodec && f.acodec !== 'none';
    if (hasAudio) {
      sizeLine.textContent = `文件大小：${size ? `约 ${formatSize(size)}` : '未知'}`;
      return;
    }
    const aSize = estimateBytes(audioBest);
    if (size && aSize) {
      sizeLine.textContent = `文件大小：视频约 ${formatSize(size)} + 音频约 ${formatSize(aSize)} ≈ ${formatSize(size + aSize)}`;
    } else if (size) {
      sizeLine.textContent = `文件大小：视频约 ${formatSize(size)} + 最佳音频（下载时合并）`;
    } else {
      sizeLine.textContent = '文件大小：未知（下载时确定）';
    }
  }

  function refreshChoiceLabel() {
    const f = selectedFormat();
    if (!f) {
      fmtLabel.textContent = '将下载：最佳可用（视频+音频自动合并）';
      return;
    }
    const hasAudio = f.acodec && f.acodec !== 'none';
    fmtLabel.textContent = `将下载：${resLabel(f)} · ${codecLabel(f)}${hasAudio ? '' : '（视频+音频自动合并）'}`;
  }

  function renderCodecOptions(prefer) {
    const choice = currentChoice();
    const list = choice ? codecChoices(choice) : [];
    const prev = prefer || codecSel.value;
    codecSel.innerHTML = '';
    if (!list.length) {
      codecSel.innerHTML = '<option value="">-</option>';
    } else {
      for (const [codec, f] of list) {
        const opt = document.createElement('option');
        opt.value = codec;
        opt.textContent = codec;
        opt.title = f.vcodec || '';
        codecSel.appendChild(opt);
      }
      const pick =
        list.find(([codec]) => codec === prev) ||
        list.find(([codec]) => codec === 'H.264') ||
        list[0];
      codecSel.value = pick[0];
    }
    updateSizeLine();
    refreshChoiceLabel();
  }

  // 分辨率下拉：所有分辨率都列出来，但同分辨率+帧率只留一条
  function renderResolutionOptions(formats) {
    resChoices = collectResChoices(formats);
    resSel.innerHTML = '';
    if (!resChoices.length) {
      resSel.innerHTML = '<option value="">最佳可用</option>';
      codecSel.innerHTML = '<option value="">-</option>';
      updateSizeLine();
      refreshChoiceLabel();
      return;
    }
    for (const c of resChoices) {
      const opt = document.createElement('option');
      opt.value = c.key;
      opt.textContent = `${c.height}p${c.fps ? ` ${c.fps}fps` : ''}`;
      resSel.appendChild(opt);
    }
    // 默认 1080p30，其次任意 1080p，再其次不高于 1080 的最高档
    const pick =
      resChoices.find((c) => c.height === 1080 && c.fps === 30) ||
      resChoices.find((c) => c.height === 1080) ||
      resChoices.find((c) => c.height < 1080) ||
      resChoices[0];
    resSel.value = pick.key;
    renderCodecOptions();
  }

  // 视频流单独下载没有音轨，统一拼上 bestaudio，由 yt-dlp 调内置 ffmpeg 合并。
  // 优先 m4a 音轨：H.264 + AAC 才能合回 mp4，否则 YouTube 这类站点会出 mkv
  function formatSelectorFor(f) {
    if (!f) return 'bv*+ba/b';
    if (f.vcodec === 'none') return f.format_id; // 纯音频
    if (f.acodec && f.acodec !== 'none') return f.format_id; // 自带音轨的整段
    return `${f.format_id}+bestaudio[ext=m4a]/${f.format_id}+bestaudio/best`;
  }

  // 开始下载只认右侧「分辨率 + 编码」；右键的格式是一次性的
  function currentFormatSelector() {
    if (ctxFormat) return formatSelectorFor(ctxFormat);
    const f = selectedFormat();
    return f ? formatSelectorFor(f) : 'bv*+ba/b';
  }

  // —— 右键菜单 ——
  let ctxMenu = null;
  function hideCtxMenu() {
    if (ctxMenu) {
      ctxMenu.remove();
      ctxMenu = null;
    }
  }
  function showCtxMenu(x, y, f) {
    hideCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'dl-ctx-menu';
    const btn = document.createElement('button');
    btn.textContent = f.vcodec === 'none' ? '下载此音频' : '下载此视频（含音频）';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideCtxMenu();
      ctxFormat = f;
      refreshChoiceLabel();
      startDownload();
    });
    menu.appendChild(btn);
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
    ctxMenu = menu;
  }
  document.addEventListener('click', hideCtxMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideCtxMenu();
  });
  window.addEventListener('blur', hideCtxMenu);

  function renderInfo(info) {
    currentInfo = info;
    // 封面：B 站图床对 Referer 敏感（<img> 上已设 referrerpolicy=no-referrer），
    // 加载失败就退回占位文案，别留一个裂图标
    if (info.thumbnail) {
      thumbPh.textContent = '封面加载中…';
      thumb.style.display = 'none';
      thumbPh.style.display = '';
      thumb.src = info.thumbnail.replace(/^http:/, 'https:');
    } else {
      thumb.removeAttribute('src');
      thumb.style.display = 'none';
      thumbPh.textContent = '无封面';
      thumbPh.style.display = '';
    }
    const parts = [info.title];
    if (info.uploader) parts.push(`上传者：${info.uploader}`);
    if (info.duration) parts.push(`时长：${formatDuration(info.duration)}`);
    infoEl.textContent = parts.join(' · ');
  }

  thumb.addEventListener('load', () => {
    if (!thumb.getAttribute('src')) return;
    thumb.style.display = 'block';
    thumbPh.style.display = 'none';
  });
  thumb.addEventListener('error', () => {
    thumb.style.display = 'none';
    thumbPh.textContent = '封面加载失败';
    thumbPh.style.display = '';
  });

  function renderFormats(formats) {
    fmtList.innerHTML = '';
    if (!formats || !formats.length) {
      fmtList.innerHTML = '<div class="dim-label" style="padding:10px;">无可用格式</div>';
      return;
    }
    // 视频格式（有视频流）和音频格式分开显示
    const videoFmts = formats.filter((f) => f.vcodec !== 'none');
    const audioFmts = formats.filter((f) => f.vcodec === 'none');

    const mkItem = (f) => {
      const div = document.createElement('div');
      div.className = 'dl-fmt-item';
      if (f.vcodec === 'none') div.classList.add('audio-only');
      const codec = codecLabel(f);
      const kbps = f.tbr ? `${Math.round(f.tbr)} kbps` : '';
      const note = [f.format_note, kbps].filter(Boolean).join(' · ');
      const size = f.filesize || f.filesize_approx;
      div.innerHTML = `
        <span class="fmt-id">${f.format_id}</span>
        <span class="fmt-res">${resLabel(f)}</span>
        <span class="fmt-ext">${f.ext}</span>
        <span class="fmt-codec" title="${f.vcodec || f.acodec || ''}">${codec || '-'}</span>
        <span class="fmt-note">${note}</span>
        <span class="fmt-size">${formatSize(size)}</span>
      `;
      // 列表只用来右键下载，点选不改变右侧设置
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showCtxMenu(e.clientX, e.clientY, f);
      });
      return div;
    };

    videoFmts.forEach((f) => fmtList.appendChild(mkItem(f)));
    if (audioFmts.length) {
      const sep = document.createElement('div');
      sep.className = 'panel-subhead';
      sep.textContent = '仅音频';
      fmtList.appendChild(sep);
      audioFmts.forEach((f) => fmtList.appendChild(mkItem(f)));
    }
  }

  function bestAudioOf(formats) {
    const audios = formats.filter((f) => f.vcodec === 'none');
    audios.sort((a, b) => (b.tbr || 0) - (a.tbr || 0));
    return audios[0] || null;
  }

  // ===== playlist 模式：分辨率/编码下拉用手动选项 =====
  // yt-dlp 的 filter 语法：bv*[height<=1080][vcodec~=h264]+ba/b 这样的模式
  // 这里不给每个 entry 单独解析 formats（太耗时），而是用 yt-dlp 的通用 filter
  const PLAYLIST_RES_OPTIONS = [
    { label: '最佳可用', height: 0 },
    { label: '1080p', height: 1080 },
    { label: '720p', height: 720 },
    { label: '480p', height: 480 },
    { label: '360p', height: 360 },
  ];
  const PLAYLIST_CODEC_OPTIONS = [
    { label: '自动', vcodec: null },
    { label: 'H.264', vcodec: 'h264' },
    { label: 'H.265', vcodec: 'hevc' },
    { label: 'AV1', vcodec: 'av01' },
    { label: 'VP9', vcodec: 'vp9' },
  ];

  function fillPlaylistFormatOptions() {
    resSel.innerHTML = '';
    for (const o of PLAYLIST_RES_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = String(o.height);
      opt.textContent = o.label;
      resSel.appendChild(opt);
    }
    resSel.value = '1080'; // 默认 1080p 上限
    codecSel.innerHTML = '';
    for (const o of PLAYLIST_CODEC_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = o.vcodec || '';
      opt.textContent = o.label;
      codecSel.appendChild(opt);
    }
    codecSel.value = ''; // 默认自动
  }

  function updateSizeLineForPlaylist() {
    const res = PLAYLIST_RES_OPTIONS.find((o) => String(o.height) === resSel.value);
    const codec = PLAYLIST_CODEC_OPTIONS.find((o) => (o.vcodec || '') === codecSel.value);
    const parts = [];
    if (res && res.height > 0) parts.push(`≤${res.height}p`);
    else parts.push('最佳分辨率');
    if (codec && codec.vcodec) parts.push(codec.label);
    else parts.push('自动编码');
    sizeLine.textContent = `每个视频：${parts.join(' · ')}`;
    fmtLabel.textContent = `将下载：${parts.join(' · ')}`;
  }

  // 按用户选择拼 yt-dlp format selector
  function playlistFormatSelector() {
    const height = parseInt(resSel.value, 10) || 0;
    const vcodec = codecSel.value; // '' 或 'h264'/'hevc'/'av01'/'vp9'
    // 视频流 filter
    const videoFilter = [];
    if (height > 0) videoFilter.push(`height<=${height}`);
    if (vcodec) videoFilter.push(`vcodec~=${vcodec}`);
    const vfStr = videoFilter.length ? `[${videoFilter.join('][')}]` : '';
    const videoPart = `bv*${vfStr}`;
    // 音频：总挑最佳，合并用
    return `${videoPart}+bestaudio[ext=m4a]/${videoPart}+bestaudio/best`;
  }

  async function fetchInfo() {
    const url = urlInput.value.trim();
    if (!url) {
      setStatus('请输入视频链接');
      return;
    }
    if (!isTauri) {
      setStatus('视频下载仅在桌面版可用');
      return;
    }
    fetchBtn.disabled = true;
    parsing = true;
    setStatus('正在解析视频信息…');
    setProgress(0);
    const token = ++parseToken;
    try {
      const info = await window.__TAURI__.core.invoke('ytdlp_info', {
        url,
        cookies: null,
        cookies_from_browser: null,
      });
      if (token !== parseToken) return; // 清除/取消触发的旧结果，丢弃
      ctxFormat = null;
      playlistMode = !!(info.entries && info.entries.length);
      playlistEntries = playlistMode
        ? info.entries.map((e) => ({ ...e, checked: true })) // 默认全选
        : [];

      if (playlistMode) {
        // —— 播放列表模式 ——
        fmtList.style.display = 'none'; // 单视频格式列表隐藏
        playlistWrap.hidden = false;
        renderPlaylistList();
        // 右侧 UI：恢复分辨率/编码/文件名输入框可选
        resSel.disabled = false;
        codecSel.disabled = false;
        nameInput.disabled = false;
        // playlist 模式下单个 entry 的 formats 不展开（避免 N*M 次调用），
        // 给下拉框手动填通用选项，下载时用 yt-dlp 的 filter 语法按条件选
        fillPlaylistFormatOptions();
        fmtLabel.textContent = '将按右侧选择下载每个视频';
        updateSizeLineForPlaylist();
        renderInfo(info);
        downloadBtn.disabled = !playlistEntries.some((e) => e.checked);
        downloadBtn.textContent = `下载选中 ${playlistEntries.filter((e) => e.checked).length} 个`;
        setStatus(`解析成功：${playlistEntries.length} 个视频，已全选`);
      } else {
        // —— 单视频模式 ——
        fmtList.style.display = '';
        playlistWrap.hidden = true;
        renderInfo(info);
        renderFormats(info.formats);
        audioBest = bestAudioOf(info.formats);
        renderResolutionOptions(info.formats);
        resSel.disabled = false;
        codecSel.disabled = false;
        nameInput.disabled = false;
        downloadBtn.disabled = false;
        downloadBtn.textContent = '开始下载';
        setStatus(`解析成功，共 ${info.formats.length} 个可用格式`);
      }
    } catch (e) {
      if (token !== parseToken) return; // 清除触发取消，静默返回
      playlistMode = false;
      playlistEntries = [];
      playlistWrap.hidden = true;
      fmtList.style.display = '';
      const msg = String(e);
      setStatus(msg.includes('取消') ? '已取消解析' : `解析失败：${msg}`);
    } finally {
      parsing = false;
      fetchBtn.disabled = false;
    }
  }

  function renderPlaylistList() {
    playlistListEl.innerHTML = '';
    playlistCountEl.textContent = playlistEntries.length;
    playlistEntries.forEach((e, i) => {
      const row = document.createElement('label');
      row.className = 'dl-playlist-item';
      row.innerHTML = `
        <input type="checkbox" ${e.checked ? 'checked' : ''} />
        <span class="dl-pl-idx">${String(i + 1).padStart(2, '0')}</span>
        <span class="dl-pl-title" title="${e.title || ''}">${e.title || '(无标题)'}</span>
        <span class="dl-pl-dur">${formatDuration(e.duration)}</span>
      `;
      const cb = row.querySelector('input[type="checkbox"]');
      cb.addEventListener('change', () => {
        playlistEntries[i].checked = cb.checked;
        const selected = playlistEntries.filter((x) => x.checked).length;
        downloadBtn.disabled = selected === 0;
        downloadBtn.textContent = selected === playlistEntries.length
          ? `下载全部 ${selected} 个`
          : `下载选中 ${selected} / ${playlistEntries.length} 个`;
      });
      playlistListEl.appendChild(row);
    });
  }

  async function pickDir() {
    if (!isTauri) return;
    const d = await window.__TAURI__.core.invoke('pick_dir');
    if (d) dirInput.value = d;
  }

  // 默认下载目录：系统下载目录下的「图像工具箱」文件夹
  async function defaultDownloadDir() {
    try {
      const d = await window.__TAURI__.path.downloadDir();
      if (d) {
        const sep = d.includes('\\') ? '\\' : '/';
        return d.endsWith(sep) ? `${d}图像工具箱` : `${d}${sep}图像工具箱`;
      }
    } catch (_) {}
    return null;
  }

  async function getSaveDir() {
    if (saveCustomChk.checked) return dirInput.value.trim() || null;
    return await defaultDownloadDir();
  }

  function syncDirState() {
    const custom = saveCustomChk.checked;
    dirInput.disabled = !custom;
    browseBtn.disabled = !custom;
  }

  async function cancelCurrentDownload() {
    if (playlistDownloading) playlistStopRequested = true;
    setStatus('正在取消下载…');
    try {
      await window.__TAURI__.core.invoke('cancel_download');
    } catch (_) {}
  }

  async function startDownload() {
    // 下载中再点「取消下载」：取消当前所有下载
    if (downloading || playlistDownloading) {
      await cancelCurrentDownload();
      return;
    }
    if (playlistMode) {
      await startPlaylistDownload();
      return;
    }
    if (!currentInfo) return;
    const url = urlInput.value.trim();
    if (!url) return;

    // 先把格式定下来（右键的格式是一次性的）
    const selector = currentFormatSelector();
    const rightClicked = !!ctxFormat;
    ctxFormat = null;
    refreshChoiceLabel();

    downloading = true;
    downloadBtn.disabled = false;
    downloadBtn.textContent = '取消下载';
    fetchBtn.disabled = true;
    setProgress(0);
    setStatus('准备下载…');

    try {
      const dir = await getSaveDir();
      if (!dir) {
        setStatus(saveCustomChk.checked ? '未选择保存文件夹' : '获取下载目录失败');
        downloading = false;
        downloadBtn.disabled = false;
        downloadBtn.textContent = '开始下载';
        fetchBtn.disabled = false;
        return;
      }
      const sep = dir.includes('\\') ? '\\' : '/';
      const nameStem = nameInput.value.trim() || '%(title)s';
      // 用 %(ext)s 让 yt-dlp 自动填充正确扩展名
      const output = `${dir}${sep}${nameStem}.%(ext)s`;

      const merging = selector.includes('+');
      setStatus(merging ? '下载中（视频+音频，完成后自动合并）…' : '下载中…');
      const finalPath = await window.__TAURI__.core.invoke('ytdlp_download', {
        url,
        output,
        options: {
          format: selector,
          cookies: null,
          cookies_from_browser: null,
        },
      });
      // 后端会 emit phase="done" 事件，这里双重保险，确保进度条最终状态正确
      setProgress(1, '', '', 'done');
      lastOutputPath =
        finalPath ||
        output.replace('%(title)s', currentInfo.title).replace('%(ext)s', currentInfo.ext || 'mp4');
      // 实际文件名可能与标题略有差异（特殊字符），但 io 打开目录一定可用
      io.setExport(lastOutputPath);
      setStatus(`下载完成${rightClicked ? '（右键指定格式）' : ''}：${lastOutputPath}`);
    } catch (e) {
      const msg = String(e);
      setStatus(msg.includes('取消') ? '已取消下载' : `下载失败：${msg}`);
    } finally {
      downloading = false;
      downloadBtn.disabled = false;
      downloadBtn.textContent = '开始下载';
      fetchBtn.disabled = false;
    }
  }

  // ===== 播放列表批量下载 =====
  async function startPlaylistDownload() {
    if (playlistDownloading) return;
    const selected = playlistEntries.filter((e) => e.checked);
    if (!selected.length) return;

    playlistDownloading = true;
    playlistStopRequested = false;
    downloadBtn.disabled = false;
    downloadBtn.textContent = '取消下载';
    fetchBtn.disabled = true;
    setProgress(0);
    setStatus(`准备批量下载（${selected.length} 个视频）…`);

    try {
      const dir = await getSaveDir();
      if (!dir) {
        setStatus(saveCustomChk.checked ? '未选择保存文件夹' : '获取下载目录失败');
        playlistDownloading = false;
        downloadBtn.disabled = false;
        downloadBtn.textContent = '重新下载';
        fetchBtn.disabled = false;
        return;
      }
      const sep = dir.includes('\\') ? '\\' : '/';
      // 合集下载：在保存目录下自动建一个以合集名字命名的子文件夹
      let outDir = dir;
      const seasonName = (currentInfo && currentInfo.title) ? String(currentInfo.title).trim() : '';
      if (seasonName) {
        const safe = seasonName
          .replace(/[\\/:*?"<>|]/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/[. ]+$/, '')
          .trim();
        if (safe) {
          outDir = `${dir}${sep}${safe}`;
        }
      }
      // 用右侧分辨率/编码选择拼 format selector，不是硬编码 bv*+ba/b
      const selector = playlistFormatSelector();
      let successCount = 0;
      let failCount = 0;
      const total = selected.length;

      for (let i = 0; i < selected.length; i++) {
        if (playlistStopRequested) break;
        const entry = selected[i];
        const curIdx = i + 1;
        const stem = `${String(curIdx).padStart(2, '0')}-%(title)s`;
        const output = `${outDir}${sep}${stem}.%(ext)s`;

        setProgress(0);
        setStatus(`[${curIdx}/${total}] 下载中：${entry.title || entry.id}…`);

        try {
          const finalPath = await window.__TAURI__.core.invoke('ytdlp_download', {
            url: entry.webpage_url || entry.id,
            output,
            options: {
              format: selector,
              cookies: null,
              cookies_from_browser: null,
            },
          });
          setProgress(1, '', '', 'done');
          lastOutputPath = finalPath || `${outDir}${sep}${stem}.mp4`;
          io.setExport(lastOutputPath);
          successCount++;
        } catch (e) {
          if (playlistStopRequested) break;
          failCount++;
          setStatus(`[${curIdx}/${total}] 失败：${entry.title || entry.id}（${e}）`);
          // 等 1 秒让用户看到失败信息
          await new Promise((r) => setTimeout(r, 800));
        }
      }

      if (playlistStopRequested) {
        setStatus(`已取消下载，已下载 ${successCount} 个`);
      } else {
        setStatus(`批量下载完成：成功 ${successCount}，失败 ${failCount}`);
      }
    } catch (e) {
      setStatus(`批量下载出错：${e}`);
    } finally {
      playlistDownloading = false;
      downloadBtn.disabled = !playlistEntries.some((e) => e.checked);
      downloadBtn.textContent = '重新下载';
      fetchBtn.disabled = false;
    }
  }

  fetchBtn.addEventListener('click', fetchInfo);

  // 清除链接按钮：清空链接输入框；正在解析时同时取消解析。
  // 正在下载时不动状态提示，避免把「下载中」的信息清掉。
  clearBtn.addEventListener('click', () => {
    if (parsing) {
      parseToken++; // 使进行中的解析结果失效
      parsing = false;
      fetchBtn.disabled = false; // 立即恢复，不必等后端 kill 完成
      setStatus('已取消解析');
      if (isTauri) {
        window.__TAURI__.core.invoke('cancel_ytdlp_info').catch((e) =>
          console.warn('cancel_ytdlp_info 失败：', e)
        );
      }
    }
    urlInput.value = '';
    urlInput.focus();
  });

  clearAllBtn.addEventListener('click', () => {
    clearAll();
  });

  // ===== yt-dlp 检查更新（仅安装版显示） =====
  const updateBtn = $('dl-ytdlp-update');
  const updateText = updateBtn.querySelector('.update-text');
  const updateFill = updateBtn.querySelector('.update-fill');
  const updateToast = $('dl-update-toast');
  const updateHint = $('dl-update-hint');
  const UPDATE_HINT_DEFAULT = updateHint.textContent;
  let updateState = 'idle'; // idle | checking | updating
  let updateToastTimer = null;

  function showUpdateToast(msg, ms = 2500) { // 存在时间 5s → 2.5s
    // 左下角常显描述跟随消息变化，直到下一条描述出现
    updateHint.textContent = msg || UPDATE_HINT_DEFAULT;
    updateToast.textContent = msg;
    updateToast.classList.add('show');
    clearTimeout(updateToastTimer);
    if (ms > 0) updateToastTimer = setTimeout(() => updateToast.classList.remove('show'), ms);
  }

  function resetUpdateBtn() {
    updateState = 'idle';
    updateBtn.classList.remove('checking', 'updating');
    updateBtn.disabled = false;
    updateText.textContent = '检查更新yt-dlp';
    updateFill.style.width = '0%';
  }

  if (isTauri) {
    // 安装版才显示按钮；免安装版保持 hidden
    window.__TAURI__.core
      .invoke('ytdlp_update_ui_visible')
      .then((v) => {
        if (v) updateBtn.hidden = false;
      })
      .catch(() => {});
    window.__TAURI__.event.listen('ytdlp-update-progress', (e) => {
      const p = e.payload && e.payload.percent;
      if (updateState === 'updating' && typeof p === 'number' && p >= 0) {
        updateFill.style.width = `${Math.min(100, Math.round(p))}%`;
      }
    });
  }

  updateBtn.addEventListener('click', async () => {
    if (updateState !== 'idle') return;
    if (downloading || playlistDownloading || parsing) {
      showUpdateToast('请先等待或取消当前的下载/解析任务，再检查更新');
      return;
    }
    updateState = 'checking';
    updateBtn.disabled = true;
    updateBtn.classList.add('checking');
    updateText.textContent = '检查更新中';
    try {
      const res = await window.__TAURI__.core.invoke('ytdlp_check_update');
      if (res.latest) {
        showUpdateToast('当前已经是最新版');
        resetUpdateBtn();
        return;
      }
      showUpdateToast(
        `检查到新版 v${res.remote_version}（当前 v${res.local_version}），开始更新…`,
        0
      );
      updateState = 'updating';
      updateBtn.classList.remove('checking');
      updateBtn.classList.add('updating');
      updateText.textContent = '更新中';
      const newVer = await window.__TAURI__.core.invoke('ytdlp_apply_update');
      showUpdateToast(`yt-dlp 已更新到 v${newVer}`);
    } catch (e) {
      // 失败原因与解决方案由后端给出，提示条停留久一点方便阅读
      showUpdateToast(String(e), 12000);
    } finally {
      resetUpdateBtn();
    }
  });

  // 手动更新：打开 yt-dlp 的 GitHub 发布页，自己下 exe 覆盖。
  // 安装目录：打开本软件里 yt-dlp.exe 所在的文件夹。两个都交给系统默认程序，
  // 所以浏览器里没有这两个能力，直接把按钮收起来。
  const manualUpdateBtn = $('dl-ytdlp-manual');
  const ytdlpDirBtn = $('dl-ytdlp-dir');
  if (isTauri) {
    manualUpdateBtn.addEventListener('click', () => {
      window.__TAURI__.core
        .invoke('open_path', { path: 'https://github.com/yt-dlp/yt-dlp/releases/latest' })
        .catch((e) => showUpdateToast(`打开发布页失败：${e}`, 6000));
    });
    ytdlpDirBtn.addEventListener('click', async () => {
      try {
        const dir = await window.__TAURI__.core.invoke('ytdlp_dir');
        await window.__TAURI__.core.invoke('open_path', { path: dir });
      } catch (e) {
        showUpdateToast(`打开安装目录失败：${e}`, 6000);
      }
    });
  } else {
    manualUpdateBtn.hidden = true;
    ytdlpDirBtn.hidden = true;
  }

  // 播放列表：全选/全不选
  plSelectAllBtn.addEventListener('click', () => {
    if (!playlistMode) return;
    playlistEntries.forEach((e) => (e.checked = true));
    renderPlaylistList();
    downloadBtn.disabled = false;
    downloadBtn.textContent = `下载全部 ${playlistEntries.length} 个`;
  });
  plSelectNoneBtn.addEventListener('click', () => {
    if (!playlistMode) return;
    playlistEntries.forEach((e) => (e.checked = false));
    renderPlaylistList();
    downloadBtn.disabled = true;
    downloadBtn.textContent = '下载选中 0 个';
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fetchInfo();
  });
  browseBtn.addEventListener('click', pickDir);
  downloadBtn.addEventListener('click', startDownload);
  resSel.addEventListener('change', () => {
    if (playlistMode) {
      updateSizeLineForPlaylist();
    } else {
      renderCodecOptions();
    }
  });
  codecSel.addEventListener('change', () => {
    if (playlistMode) {
      updateSizeLineForPlaylist();
    } else {
      updateSizeLine();
      refreshChoiceLabel();
    }
  });

  // 保存位置二选一
  saveDefaultChk.addEventListener('change', () => {
    if (saveDefaultChk.checked) saveCustomChk.checked = false;
    else saveCustomChk.checked = true;
    syncDirState();
  });
  saveCustomChk.addEventListener('change', () => {
    if (saveCustomChk.checked) saveDefaultChk.checked = false;
    else saveDefaultChk.checked = true;
    syncDirState();
  });
  syncDirState();

  if (isTauri) {
    window.__TAURI__.event.listen('ytdlp-progress', (e) => {
      const d = e.payload || {};
      if (typeof d === 'number') {
        setProgress(d);
      } else {
        setProgress(d.percent, d.speed, d.eta, d.phase, d.total_size);
      }
    });
  }

  return {};
}
