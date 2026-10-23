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
import { makeTexClient } from './tex-client.js';
import { equalizeCanvases } from './layout.js';
import { createIoButtons } from './io-buttons.js';

const $ = (id) => document.getElementById(id);

const num = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));

export function initSeamless({ srcView, outView }) {
  const info = $('sml-info');
  const outInfo = $('sml-out-info');
  const metricLabel = $('sml-metric');
  const openBtn = $('sml-open');
  const clearBtn = $('sml-clear');
  const widthRange = $('sml-width');
  const widthNum = $('sml-width-num');
  const dirSel = $('sml-dir');
  const levelSel = $('sml-levels');
  const alphaChk = $('sml-keep-alpha');
  const tileSel = $('sml-tile');
  const fmtSel = $('sml-fmt');
  const nameIn = $('sml-name');
  const saveOrigChk = $('sml-save-orig');
  const exportBtn = $('sml-export');
  const status = $('sml-status');
  const io = createIoButtons($('sml-io'), setStatus);

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
    const dir = dirSel.value === 'h' || dirSel.value === 'v' ? dirSel.value : 'both';
    return {
      blend: pct,
      dir,
      keepAlpha: alphaChk.checked,
      levels: Math.min(4, Math.max(0, Number(levelSel.value) || 0)),
      pct,
    };
  }

  // 平铺预览的列数/行数；只影响绘制，不动结果
  function tileN() {
    return Math.max(1, Math.min(4, Number(tileSel.value) || 1));
  }

  // 结果那一行的文字。平铺数单独走：换平铺不该重算算法
  let lastOut = null;
  function showOut() {
    if (!lastOut) return;
    const n = tileN();
    outInfo.textContent =
      `结果尺寸：${lastOut.w}x${lastOut.h}  |  平铺 ${n}x${n}  |  融合 ${lastOut.band}  |  ` +
      `耗时 ${lastOut.ms < 10 ? lastOut.ms.toFixed(1) : Math.round(lastOut.ms)}ms`;
  }

  function bandText(o, w, h) {
    const dirTxt = { both: '双向', h: '仅横向', v: '仅纵向' }[o.dir];
    const axes = [];
    if (o.dir !== 'v') axes.push({ n: '横', b: Math.round(w * o.pct), len: w });
    if (o.dir !== 'h') axes.push({ n: '纵', b: Math.round(h * o.pct), len: h });
    const listB = (f) => axes.map((a) => `${a.n}${f(a)}px`).join(' ');
    if (o.pct === 0) return '不处理（等于原图）';
    if (o.levels <= 0) return `${dirTxt} 单尺度 ${listB((a) => a.b)}`;
    const spread = 1 << (o.levels - 1);
    const cap = (a) => {
      const want = a.b * spread;
      const max = a.len >> 2;
      return want > max ? `${max}(已封顶)` : `${want}`;
    };
    return `${dirTxt} 带 ${listB((a) => a.b)} · 低频半径 ${listB(cap)} ×${o.levels + 1} 频段`;
  }

  // 无缝化 + 接缝指标都在 worker 里算（见 tex-client.js）：2048 单尺度一次约 230ms，
  // levels>=1 上秒级，放主线程就是拖动滑块时整窗定住。levels 那一档实测最贵，
  // 也只能靠「不阻塞主线程」换来拖动时的实时感。
  const client = makeTexClient({
    kind: 'seamless',
    compute: (o) => {
      const data = makeSeamless(imgData, o);
      return { data, metrics: seamMetrics({ width: imgData.width, height: imgData.height, data }) };
    },
    metricsOf: (img) => seamMetrics(img),
    apply: (r) => {
      if (!imgData) return;
      if (!r.ok) {
        setStatus('无缝化失败：' + r.message);
        return;
      }
      resultCanvas = rgbaCanvas(imgData.width, imgData.height, r.data);
      outView.setImage(resultCanvas, resultCanvas.width, resultCanvas.height);
      outView.setTile(tileN());
      lastOut = {
        w: imgData.width,
        h: imgData.height,
        band: bandText(r.opts, imgData.width, imgData.height),
        ms: r.ms,
      };
      showOut();
      const after = r.metrics;
      metricLabel.textContent =
        `接缝指标（越小越平）  左右色差 ${before.lr.toFixed(1)} → ${after.lr.toFixed(1)}  ` +
        `上下色差 ${before.tb.toFixed(1)} → ${after.tb.toFixed(1)}  ` +
        `边缘/梯度比值 ${num(before.ratio)} → ${num(after.ratio)}`;
    },
  });

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
    if (!imgData) return Promise.resolve();
    return client.request(opts());
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
      // 原始图的接缝指标也丢给 worker 算：整图遍历一次在 2048 上是 80ms。
      // worker 中途坏了 load() 给 null，这里补一次主线程的，否则指标行没基准
      before = (await client.load(imgData)) || seamMetrics(imgData);
      setEnabled(true);
      updateInfo();
      render();
      io.setSource(entry.path);
      io.setExport(null);
      setStatus('已载入：' + entry.name);
    } catch (ex) {
      client.unload();
      imgData = null;
      before = null;
      lastOut = null;
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
    client.unload();
    srcCanvas = null;
    imgData = null;
    before = null;
    lastOut = null;
    resultCanvas = null;
    sourcePath = null;
    sourceName = '';
    sourceBytes = 0;
    io.clear();
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
    // 先等当前参数这一轮算完：worker 里可能还挂着一次没落地，导出的必须是屏幕上那张
    if (imgData) await render();
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
      io.setExport(dir ? saved : null);
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
  dirSel.addEventListener('change', schedule);
  levelSel.addEventListener('change', schedule);
  // 换平铺不重新计算：结果还是同一张，只让视图按 n×n 重画
  tileSel.addEventListener('change', () => {
    outView.setTile(tileN());
    showOut();
  });

  return { loadEntry };
}
