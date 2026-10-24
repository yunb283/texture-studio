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
  const proxyModeSel = $('dl-proxy-mode');
  const proxyUrlIn = $('dl-proxy-url');
  const downloadBtn = $('dl-download');
  const progressFill = $('dl-progress-fill');
  const progressText = $('dl-progress-text');
  const progressMeta = $('dl-progress-meta');
  const statusEl = $('dl-status');

  const io = createIoButtons($('dl-io'));

  let currentInfo = null;
  let resChoices = []; // [{ key, height, fps }]
  let audioBest = null; // 最佳音频（合并用）
  let ctxFormat = null; // 右键要下载的格式（一次性）
  let downloading = false;
  let lastOutputPath = null;

  function setStatus(msg) {
    statusEl.textContent = msg || '';
  }

  function setProgress(p, speed, eta) {
    const pct = Math.round((p || 0) * 100);
    progressFill.style.width = `${pct}%`;
    progressText.textContent = `${pct}%`;
    const meta = [];
    if (speed) meta.push(speed);
    if (eta) meta.push(`剩余 ${eta}`);
    progressMeta.textContent = meta.join(' · ');
  }

  // 网络代理选择：'' 默认、direct 直连、system 系统代理、custom 自定义地址
  function getProxyArg() {
    const mode = proxyModeSel.value;
    if (mode === 'custom') return proxyUrlIn.value.trim() || null;
    return mode || null;
  }

  const PROXY_KEY = 'texture-studio.dl.proxy';
  function saveProxyChoice() {
    try {
      localStorage.setItem(
        PROXY_KEY,
        JSON.stringify({ mode: proxyModeSel.value, url: proxyUrlIn.value.trim() })
      );
    } catch (_) {}
  }
  try {
    const saved = JSON.parse(localStorage.getItem(PROXY_KEY) || 'null');
    if (saved) {
      proxyModeSel.value = saved.mode || '';
      proxyUrlIn.value = saved.url || '';
    }
  } catch (_) {}
  function syncProxyInput() {
    proxyUrlIn.style.display = proxyModeSel.value === 'custom' ? '' : 'none';
  }
  syncProxyInput();
  proxyModeSel.addEventListener('change', () => {
    syncProxyInput();
    saveProxyChoice();
  });
  proxyUrlIn.addEventListener('change', saveProxyChoice);

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
    setStatus('正在解析视频信息…');
    setProgress(0);
    try {
      const info = await window.__TAURI__.core.invoke('ytdlp_info', {
        url,
        cookies: null,
        cookies_from_browser: null,
        proxy: getProxyArg(),
      });
      ctxFormat = null;
      renderInfo(info);
      renderFormats(info.formats);
      audioBest = bestAudioOf(info.formats);
      renderResolutionOptions(info.formats);
      downloadBtn.disabled = false;
      setStatus(`解析成功，共 ${info.formats.length} 个可用格式`);
    } catch (e) {
      setStatus(`解析失败：${e}`);
    } finally {
      fetchBtn.disabled = false;
    }
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

  async function startDownload() {
    if (!currentInfo || downloading) return;
    const url = urlInput.value.trim();
    if (!url) return;

    // 先把格式定下来（右键的格式是一次性的）
    const selector = currentFormatSelector();
    const rightClicked = !!ctxFormat;
    ctxFormat = null;
    refreshChoiceLabel();

    downloading = true;
    downloadBtn.disabled = true;
    fetchBtn.disabled = true;
    setProgress(0);
    setStatus('准备下载…');

    try {
      const dir = await getSaveDir();
      if (!dir) {
        setStatus(saveCustomChk.checked ? '未选择保存文件夹' : '获取下载目录失败');
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
          proxy: getProxyArg(),
        },
      });
      setProgress(1);
      lastOutputPath =
        finalPath ||
        output.replace('%(title)s', currentInfo.title).replace('%(ext)s', currentInfo.ext || 'mp4');
      // 实际文件名可能与标题略有差异（特殊字符），但 io 打开目录一定可用
      io.setExport(lastOutputPath);
      setStatus(`下载完成${rightClicked ? '（右键指定格式）' : ''}：${lastOutputPath}`);
    } catch (e) {
      setStatus(`下载失败：${e}`);
    } finally {
      downloading = false;
      downloadBtn.disabled = false;
      fetchBtn.disabled = false;
    }
  }

  fetchBtn.addEventListener('click', fetchInfo);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fetchInfo();
  });
  browseBtn.addEventListener('click', pickDir);
  downloadBtn.addEventListener('click', startDownload);
  resSel.addEventListener('change', () => renderCodecOptions());
  codecSel.addEventListener('change', () => {
    updateSizeLine();
    refreshChoiceLabel();
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
      if (typeof d === 'number') setProgress(d);
      else setProgress(d.percent, d.speed, d.eta);
    });
  }

  return {};
}
