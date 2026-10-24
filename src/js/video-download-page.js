import { isTauri, pickImages } from './platform.js';
import { createIoButtons } from './io-buttons.js';

const $ = (id) => document.getElementById(id);

export function initVideoDownload() {
  const urlInput = $('dl-url');
  const fetchBtn = $('dl-fetch');
  const thumb = $('dl-thumb');
  const thumbPh = $('dl-thumb-placeholder');
  const infoEl = $('dl-info');
  const fmtList = $('dl-fmt-list');
  const fmtLabel = $('dl-fmt-label');
  const nameInput = $('dl-name');
  const saveDefaultChk = $('dl-save-default');
  const dirInput = $('dl-dir');
  const browseBtn = $('dl-browse');
  const cookiesInput = $('dl-cookies');
  const cookiesBrowseBtn = $('dl-cookies-browse');
  const cookiesClearBtn = $('dl-cookies-clear');
  const downloadBtn = $('dl-download');
  const progressFill = $('dl-progress-fill');
  const progressText = $('dl-progress-text');
  const statusEl = $('dl-status');

  const io = createIoButtons($('dl-io'));

  /** @type {import('./platform').any} */
  let currentInfo = null;
  let selectedFormat = ''; // 空字符串 = 最佳质量
  let downloading = false;
  let lastOutputPath = null;

  function setStatus(msg) {
    statusEl.textContent = msg || '';
  }

  function setProgress(p) {
    const pct = Math.round(p * 100);
    progressFill.style.width = `${pct}%`;
    progressText.textContent = `${pct}%`;
  }

  function formatDuration(sec) {
    if (!sec || sec <= 0) return '未知';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    const mb = bytes / 1024 / 1024;
    if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
    return `${mb.toFixed(1)} MB`;
  }

  function renderInfo(info) {
    currentInfo = info;
    thumb.src = info.thumbnail || '';
    thumb.style.display = info.thumbnail ? 'block' : 'none';
    thumbPh.style.display = info.thumbnail ? 'none' : '';
    const parts = [info.title];
    if (info.uploader) parts.push(`上传者：${info.uploader}`);
    if (info.duration) parts.push(`时长：${formatDuration(info.duration)}`);
    infoEl.textContent = parts.join(' · ');
  }

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
      const res = f.height ? `${f.height}p` : (f.resolution || '音频');
      const fps = f.fps ? ` ${f.fps}fps` : '';
      const note = f.format_note || '';
      const size = f.filesize || f.filesize_approx;
      div.innerHTML = `
        <span class="fmt-id">${f.format_id}</span>
        <span class="fmt-res">${res}${fps}</span>
        <span class="fmt-ext">${f.ext}</span>
        <span class="fmt-note">${note}</span>
        <span class="fmt-size">${formatSize(size)}</span>
      `;
      div.addEventListener('click', () => {
        if (selectedFormat === f.format_id) {
          // 再次点击取消选择，回到最佳质量
          selectedFormat = '';
          fmtLabel.textContent = '最佳质量（自动）';
        } else {
          selectedFormat = f.format_id;
          fmtLabel.textContent = `${f.format_id} · ${res} · ${f.ext.toUpperCase()}`;
        }
        for (const el of fmtList.querySelectorAll('.dl-fmt-item')) {
          el.classList.toggle('selected', el.querySelector('.fmt-id').textContent === selectedFormat);
        }
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
      const cookies = cookiesInput.value.trim() || null;
      const info = await window.__TAURI__.core.invoke('ytdlp_info', { url, cookies });
      renderInfo(info);
      renderFormats(info.formats);
      selectedFormat = '';
      fmtLabel.textContent = '最佳质量（自动）';
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

  async function getSaveDir() {
    if (!saveDefaultChk.checked && dirInput.value.trim()) {
      return dirInput.value.trim();
    }
    // 默认下载目录
    try {
      const d = await window.__TAURI__.path.downloadDir();
      if (d) return d;
    } catch (_) {}
    // 回退：让用户选
    return await window.__TAURI__.core.invoke('pick_dir');
  }

  async function startDownload() {
    if (!currentInfo || downloading) return;
    const url = urlInput.value.trim();
    if (!url) return;

    downloading = true;
    downloadBtn.disabled = true;
    fetchBtn.disabled = true;
    setProgress(0);
    setStatus('准备下载…');

    try {
      const dir = await getSaveDir();
      if (!dir) {
        setStatus('未选择保存目录');
        return;
      }
      const sep = dir.includes('\\') ? '\\' : '/';
      const nameStem = nameInput.value.trim() || '%(title)s';
      // 用 %(ext)s 让 yt-dlp 自动填充正确扩展名
      const output = `${dir}${sep}${nameStem}.%(ext)s`;

      setStatus('下载中…');
      const cookies = cookiesInput.value.trim() || null;
      await window.__TAURI__.core.invoke('ytdlp_download', {
        url,
        output,
        options: { format: selectedFormat || null, cookies },
      });
      setProgress(1);
      lastOutputPath = output.replace('%(title)s', currentInfo.title).replace('%(ext)s', currentInfo.ext || 'mp4');
      // 实际文件名可能与标题略有差异（特殊字符），但 io 打开目录一定可用
      io.setExport(lastOutputPath);
      setStatus('下载完成');
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

  async function pickCookies() {
    const entries = await pickImages(false, ['txt'], { title: '选择 Cookies 文件', label: 'Cookies' });
    if (entries && entries[0] && entries[0].path) {
      cookiesInput.value = entries[0].path;
    }
  }
  cookiesBrowseBtn.addEventListener('click', pickCookies);
  cookiesClearBtn.addEventListener('click', () => {
    cookiesInput.value = '';
  });

  saveDefaultChk.addEventListener('change', () => {
    dirInput.disabled = saveDefaultChk.checked;
    browseBtn.disabled = saveDefaultChk.checked;
  });
  dirInput.disabled = true;
  browseBtn.disabled = true;

  if (isTauri) {
    window.__TAURI__.event.listen('ytdlp-progress', (e) => {
      setProgress(e.payload);
    });
  }

  return {};
}
