import {
  pickImages,
  readEntryBytes,
  saveBlob,
  resolveSaveDir,
  isSupportedName,
  dirname,
  stemOf,
  isTauri,
  CONVERT_EXTS,
} from './platform.js';
import { encodeCanvas } from './image-util.js';
import { FORMAT_NAME, extOf, humanSize, decodeToCanvas } from './decode.js';

const $ = (id) => document.getElementById(id);

const FLOAT_EXTS = ['hdr', 'rgbe', 'exr'];

export function initConvert({ view }) {
  const info = $('conv-info');
  const openBtn = $('conv-open');
  const clearBtn = $('conv-clear');
  const fmtSel = $('conv-fmt');
  const nameIn = $('conv-name');
  const saveOrigChk = $('conv-save-orig');
  const stretchChk = $('conv-stretch');
  const exportBtn = $('conv-export');
  const dirIn = $('conv-dir');
  const browseBtn = $('conv-browse');
  const exportDirBtn = $('conv-export-dir');
  const status = $('conv-status');

  let canvas = null;
  let sourcePath = null;
  let sourceName = '';
  let sourceBytes = 0;
  let lastBytes = null;

  function setStatus(msg) {
    status.textContent = msg;
  }

  function updateInfo() {
    if (!canvas) {
      info.textContent = '图像尺寸：-  |  大小：-  |  格式：-';
      return;
    }
    info.textContent =
      `图像尺寸：${canvas.width}x${canvas.height}  |  ` +
      `大小：${humanSize(sourceBytes)}  |  ` +
      `格式：${FORMAT_NAME[extOf(sourceName)] || '未知'}`;
  }

  function setEnabled(on) {
    clearBtn.disabled = !on;
    exportBtn.disabled = !on;
    browseBtn.disabled = !on;
    exportDirBtn.disabled = !on;
  }

  function show(c) {
    canvas = c;
    view.setImage(canvas, canvas.width, canvas.height);
    setEnabled(true);
    updateInfo();
  }

  async function loadEntry(entry) {
    if (!isSupportedName(entry.name, CONVERT_EXTS)) {
      setStatus('不支持的格式：' + entry.name);
      return;
    }
    setStatus('正在载入…');
    // 让状态先上屏，再执行解码等耗时同步操作
    await new Promise((r) => setTimeout(r, 0));
    try {
      const bytes = await readEntryBytes(entry);
      if (!bytes.length) throw new Error('文件内容为空');
      lastBytes = bytes;
      sourcePath = entry.path;
      sourceName = entry.name;
      sourceBytes = bytes.length;
      nameIn.value = '';
      show(await decodeToCanvas(entry.name, bytes, stretchChk.checked));
      setStatus('已载入：' + entry.name);
    } catch (ex) {
      lastBytes = null;
      setStatus('载入失败：' + (ex?.message ?? ex));
    }
  }

  async function reloadDecoded() {
    if (!lastBytes || !FLOAT_EXTS.includes(extOf(sourceName))) return;
    try {
      show(await decodeToCanvas(sourceName, lastBytes, stretchChk.checked));
      setStatus(stretchChk.checked ? '已按最大值重新量化' : '已按线性裁剪重新量化');
    } catch (ex) {
      setStatus('重新载入失败：' + (ex?.message ?? ex));
    }
  }

  function clearImage() {
    if (!canvas) return;
    canvas = null;
    lastBytes = null;
    sourcePath = null;
    sourceName = '';
    sourceBytes = 0;
    view.setImage(null);
    setEnabled(false);
    updateInfo();
    setStatus('');
  }

  // 同目录同后缀会覆盖原图，这时自动换个名
  function outName(ext, dir) {
    const stem = nameIn.value.trim() || (sourceName ? stemOf(sourceName) : 'converted');
    const norm = (p) => p.replace(/\//g, '\\').toLowerCase();
    const sameDir = !!dir && !!sourcePath && norm(dirname(sourcePath)) === norm(dir);
    const name = `${stem}.${ext}`;
    if (sameDir && name.toLowerCase() === sourceName.toLowerCase()) return `${stem}_转换.${ext}`;
    return name;
  }

  async function exportTo(dir) {
    if (!canvas) return;
    const ext = fmtSel.value === 'JPEG' ? 'jpg' : fmtSel.value.toLowerCase();
    let target = dir;
    if (target === undefined) {
      target = saveOrigChk.checked && sourcePath ? dirname(sourcePath) : null;
      target = await resolveSaveDir(target);
      if (isTauri && !target) return;
    }
    setStatus('正在导出…');
    await new Promise((r) => setTimeout(r, 0));
    try {
      const bytes = await encodeCanvas(canvas, ext);
      const saved = await saveBlob(outName(ext, target), bytes, target);
      if (saved === null) {
        setStatus('已取消');
        return;
      }
      setStatus('已导出：' + saved);
    } catch (ex) {
      setStatus('导出失败：' + (ex?.message ?? ex));
    }
  }

  openBtn.addEventListener('click', async () => {
    const entries = await pickImages(false, CONVERT_EXTS);
    if (entries.length) await loadEntry(entries[0]);
  });
  clearBtn.addEventListener('click', clearImage);
  exportBtn.addEventListener('click', () => exportTo(undefined));
  exportDirBtn.addEventListener('click', () => {
    const dir = dirIn.value.trim();
    if (!dir) {
      setStatus('请先填写或粘贴导出路径');
      return;
    }
    exportTo(dir);
  });
  browseBtn.addEventListener('click', async () => {
    const dir = await resolveSaveDir(null);
    if (dir) dirIn.value = dir;
  });
  stretchChk.addEventListener('change', reloadDecoded);

  return { loadEntry };
}
