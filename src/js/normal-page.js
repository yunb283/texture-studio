// 贴图转法线页：左侧原图、右侧法线图，参数改动实时重算，导出 PNG / TGA。
// 算法在 normal.js（已用 numpy 独立实现逐字节交叉核对），这里只管解码、控件和导出。
import {
  pickImages,
  readEntryBytes,
  saveBlob,
  resolveSaveDir,
  isSupportedName,
  dirname,
  stemOf,
  isTauri,
  TEXTURE_EXTS,
} from './platform.js';
import { canvasToImageData, encodeCanvas } from './image-util.js';
import { decodeToCanvas, rgbaCanvas, FORMAT_NAME, extOf, humanSize } from './decode.js';
import { heightToNormal } from './normal.js';
import { equalizeCanvases } from './layout.js';

const $ = (id) => document.getElementById(id);

export function initNormal({ srcView, outView }) {
  const info = $('nrm-info');
  const outInfo = $('nrm-out-info');
  const openBtn = $('nrm-open');
  const clearBtn = $('nrm-clear');
  const srcSel = $('nrm-source');
  const invertChk = $('nrm-invert');
  const blurRange = $('nrm-blur');
  const blurNum = $('nrm-blur-num');
  const strengthRange = $('nrm-strength');
  const strengthNum = $('nrm-strength-num');
  const convSel = $('nrm-convention');
  const fmtSel = $('nrm-fmt');
  const nameIn = $('nrm-name');
  const saveOrigChk = $('nrm-save-orig');
  const exportBtn = $('nrm-export');
  const status = $('nrm-status');

  // 两个预览窗口保持等大（实现见 layout.js）
  equalizeCanvases($('page-normal'));

  let srcCanvas = null;
  let imgData = null;
  let sourcePath = null;
  let sourceName = '';
  let sourceBytes = 0;

  function setStatus(msg) {
    status.textContent = msg;
  }

  function updateInfo() {
    if (!srcCanvas) {
      info.textContent = '图像尺寸：-  |  大小：-  |  格式：-';
      outInfo.textContent = '法线尺寸：-  |  生成耗时：-';
      return;
    }
    info.textContent =
      `图像尺寸：${srcCanvas.width}x${srcCanvas.height}  |  ` +
      `大小：${humanSize(sourceBytes)}  |  ` +
      `格式：${FORMAT_NAME[extOf(sourceName)] || '未知'}`;
  }

  function setEnabled(on) {
    clearBtn.disabled = !on;
    exportBtn.disabled = !on;
  }

  function opts() {
    return {
      source: srcSel.value,
      invert: invertChk.checked,
      blur: Number(blurNum.value) || 0,
      strength: Number(strengthNum.value) || 1,
      yUp: convSel.value === 'og',
    };
  }

  // 参数改动即时重算；同一帧内的多次拖动只算一次
  let pending = false;
  // 尾随定时器而不是 requestAnimationFrame：rAF 在页面不可见时不触发，滑块改动会被静默吞掉
  function schedule() {
    if (pending || !imgData) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      render();
    }, 0);
  }

  function render() {
    if (!imgData) return;
    const t0 = performance.now();
    let data;
    try {
      data = heightToNormal(imgData, opts());
    } catch (ex) {
      setStatus('生成失败：' + (ex?.message ?? ex));
      return;
    }
    const ms = performance.now() - t0;
    const c = rgbaCanvas(imgData.width, imgData.height, data);
    outView.setImage(c, c.width, c.height);
    outInfo.textContent =
      `法线尺寸：${c.width}x${c.height}  |  生成耗时：${ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms`;
  }

  async function loadEntry(entry) {
    if (!isSupportedName(entry.name, TEXTURE_EXTS)) {
      setStatus('不支持的格式：' + entry.name);
      return;
    }
    setStatus('正在载入…');
    await new Promise((r) => setTimeout(r, 0));
    try {
      const bytes = await readEntryBytes(entry);
      if (!bytes.length) throw new Error('文件内容为空');
      sourcePath = entry.path;
      sourceName = entry.name;
      sourceBytes = bytes.length;
      nameIn.value = '';
      srcCanvas = await decodeToCanvas(entry.name, bytes);
      srcView.setImage(srcCanvas, srcCanvas.width, srcCanvas.height);
      imgData = canvasToImageData(srcCanvas);
      setEnabled(true);
      updateInfo();
      render();
      setStatus('已载入：' + entry.name);
    } catch (ex) {
      imgData = null;
      srcCanvas = null;
      srcView.setImage(null);
      outView.setImage(null);
      setEnabled(false);
      updateInfo();
      setStatus('载入失败：' + (ex?.message ?? ex));
    }
  }

  function clearImage() {
    if (!srcCanvas) return;
    srcCanvas = null;
    imgData = null;
    sourcePath = null;
    sourceName = '';
    sourceBytes = 0;
    nameIn.value = '';
    srcView.setImage(null);
    outView.setImage(null);
    setEnabled(false);
    updateInfo();
    setStatus('');
  }

  // 默认文件名 = 原名 + _Normal（手工填的名字已经带后缀就不再叠一次）
  function outName(ext) {
    let stem = nameIn.value.trim() || (sourceName ? stemOf(sourceName) : 'texture');
    if (!/_normal$/i.test(stem)) stem += '_Normal';
    return `${stem}.${ext}`;
  }

  async function exportTo() {
    if (!imgData) return;
    render();
    const ext = fmtSel.value.toLowerCase();
    const canvas = outView.image?.source || null;
    if (!canvas) {
      setStatus('还没有法线图可导出');
      return;
    }
    // 默认导出到原图所在目录；取消勾选则弹目录选择框
    let dir = saveOrigChk.checked && sourcePath ? dirname(sourcePath) : null;
    dir = await resolveSaveDir(dir);
    if (isTauri && !dir) return;
    setStatus('正在导出…');
    await new Promise((r) => setTimeout(r, 0));
    try {
      const bytes = await encodeCanvas(canvas, ext);
      const saved = await saveBlob(outName(ext), bytes, dir);
      if (saved === null) {
        setStatus('已取消');
        return;
      }
      setStatus(`已导出：${saved}（${humanSize(bytes.length)}）`);
    } catch (ex) {
      setStatus('导出失败：' + (ex?.message ?? ex));
    }
  }

  openBtn.addEventListener('click', async () => {
    const entries = await pickImages(false, TEXTURE_EXTS);
    if (entries.length) await loadEntry(entries[0]);
  });
  clearBtn.addEventListener('click', clearImage);
  exportBtn.addEventListener('click', exportTo);

  // 滑块与数字框双向同步，任一改动都即时重算
  const link = (range, num) => {
    range.addEventListener('input', () => {
      num.value = range.value;
      schedule();
    });
    num.addEventListener('input', () => {
      const v = Math.min(Number(range.max), Math.max(Number(range.min), Number(num.value)));
      if (Number.isFinite(v)) range.value = String(v);
      schedule();
    });
    num.addEventListener('change', () => schedule());
  };
  link(blurRange, blurNum);
  link(strengthRange, strengthNum);
  for (const el of [srcSel, invertChk, convSel]) el.addEventListener('change', schedule);

  return { loadEntry };
}
