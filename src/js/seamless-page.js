// 无缝贴图页：左侧原图，右侧无缝结果（可切 1×1 / 2×2 / 3×3 平铺预览），参数改动实时重算。
// 算法在 seamless.js（已用 numpy 独立实现逐字节交叉核对），这里只管解码、控件、指标和导出。
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
import { makeSeamless, seamMetrics } from './seamless.js';
import { equalizeCanvases } from './layout.js';

const $ = (id) => document.getElementById(id);

// 平铺预览：把结果重复 n×n 次拼一张大图，用来肉眼确认接缝真的消失
function tileCanvas(src, n) {
  if (n <= 1) return src;
  const c = document.createElement('canvas');
  c.width = src.width * n;
  c.height = src.height * n;
  const x = c.getContext('2d');
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) x.drawImage(src, i * src.width, j * src.height);
  return c;
}

const num = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));

export function initSeamless({ srcView, outView }) {
  const info = $('sml-info');
  const outInfo = $('sml-out-info');
  const metricLabel = $('sml-metric');
  const openBtn = $('sml-open');
  const clearBtn = $('sml-clear');
  const widthRange = $('sml-width');
  const widthNum = $('sml-width-num');
  const levelSel = $('sml-levels');
  const alphaChk = $('sml-keep-alpha');
  const tileSel = $('sml-tile');
  const fmtSel = $('sml-fmt');
  const nameIn = $('sml-name');
  const saveOrigChk = $('sml-save-orig');
  const exportBtn = $('sml-export');
  const status = $('sml-status');

  equalizeCanvases($('page-seamless'));

  let srcCanvas = null;
  let resultCanvas = null;
  let imgData = null;
  let before = null;
  let sourcePath = null;
  let sourceName = '';
  let sourceBytes = 0;

  function setStatus(msg) {
    status.textContent = msg;
  }

  function updateInfo() {
    if (!srcCanvas) {
      info.textContent = '图像尺寸：-  |  大小：-  |  格式：-';
      outInfo.textContent = '结果尺寸：-  |  融合带：-  |  耗时：-';
      metricLabel.textContent = '接缝指标：-';
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
    const pct = Math.min(0.5, Math.max(0, (Number(widthNum.value) || 0) / 100));
    return {
      blend: pct,
      keepAlpha: alphaChk.checked,
      levels: Math.min(4, Math.max(0, Number(levelSel.value) || 0)),
      pct,
    };
  }

  let pending = false;
  // 用尾随定时器而不是 requestAnimationFrame 合帧：rAF 在页面不可见时不触发，
  // 那样滑块改动会被静默吞掉（也让自动化测不到这条路径）
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
    const o = opts();
    const t0 = performance.now();
    let data;
    try {
      data = makeSeamless(imgData, o);
    } catch (ex) {
      setStatus('无缝化失败：' + (ex?.message ?? ex));
      return;
    }
    const ms = performance.now() - t0;
    resultCanvas = rgbaCanvas(imgData.width, imgData.height, data);
    const n = Number(tileSel.value) || 1;
    outView.setImage(tileCanvas(resultCanvas, n), resultCanvas.width * n, resultCanvas.height * n);
    const after = seamMetrics({ width: imgData.width, height: imgData.height, data });
    const bw = Math.round(imgData.width * o.pct);
    const bh = Math.round(imgData.height * o.pct);
    let bandTxt;
    if (o.pct === 0) bandTxt = '不处理（等于原图）';
    else if (o.levels <= 0) bandTxt = `单尺度 横${bw} 纵${bh}px`;
    else {
      const spread = 1 << (o.levels - 1);
      const cap = (len, b) => {
        const want = b * spread;
        const max = len >> 2;
        return want > max ? `${max}(已封顶)` : `${want}`;
      };
      bandTxt =
        `带 横${bw} 纵${bh}px · 低频半径 横${cap(imgData.width, bw)}/` +
        `纵${cap(imgData.height, bh)}px ×${o.levels + 1} 频段`;
    }
    outInfo.textContent =
      `结果尺寸：${imgData.width}x${imgData.height}  |  平铺 ${n}x${n}  |  融合 ${bandTxt}  |  ` +
      `耗时 ${ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms`;
    metricLabel.textContent =
      `接缝指标（越小越平）  左右色差 ${before.lr.toFixed(1)} → ${after.lr.toFixed(1)}  ` +
      `上下色差 ${before.tb.toFixed(1)} → ${after.tb.toFixed(1)}  ` +
      `边缘/梯度比值 ${num(before.ratio)} → ${num(after.ratio)}`;
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
      before = seamMetrics(imgData);
      setEnabled(true);
      updateInfo();
      render();
      setStatus('已载入：' + entry.name);
    } catch (ex) {
      imgData = null;
      before = null;
      resultCanvas = null;
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
    before = null;
    resultCanvas = null;
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

  // 默认文件名 = 原名 + _Seamless（手工填的名字已带后缀就不再叠一次）
  function outName(ext) {
    let stem = nameIn.value.trim() || (sourceName ? stemOf(sourceName) : 'texture');
    if (!/_seamless$/i.test(stem)) stem += '_Seamless';
    return `${stem}.${ext}`;
  }

  async function exportTo() {
    if (!resultCanvas) {
      setStatus('还没有可导出的结果');
      return;
    }
    const ext = fmtSel.value.toLowerCase();
    let dir = saveOrigChk.checked && sourcePath ? dirname(sourcePath) : null;
    dir = await resolveSaveDir(dir);
    if (isTauri && !dir) return;
    setStatus('正在导出…');
    await new Promise((r) => setTimeout(r, 0));
    try {
      const bytes = await encodeCanvas(resultCanvas, ext);
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

  widthRange.addEventListener('input', () => {
    widthNum.value = widthRange.value;
    schedule();
  });
  widthNum.addEventListener('input', () => {
    const v = Math.min(50, Math.max(0, Number(widthNum.value)));
    if (Number.isFinite(v)) widthRange.value = String(v);
    schedule();
  });
  widthNum.addEventListener('change', schedule);
  alphaChk.addEventListener('change', schedule);
  levelSel.addEventListener('change', schedule);
  tileSel.addEventListener('change', schedule);

  return { loadEntry };
}
