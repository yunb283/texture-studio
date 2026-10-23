import { autoDetectGrid } from './detect.js';
import {
  pickImages,
  readImageBitmap,
  saveBlob,
  resolveSaveDir,
  isSupportedName,
  dirname,
  isTauri,
} from './platform.js';
import {
  cellRect,
  bitmapToCanvas,
  cropCanvas,
  encodeCanvas,
} from './image-util.js';
import { createIoButtons } from './io-buttons.js';

const $ = (id) => document.getElementById(id);

export function initSplit({ srcView, frameView }) {
  const info = $('split-info');
  const openBtn = $('split-open');
  const clearBtn = $('split-clear');
  const slider = $('split-slider');
  const pos = $('split-pos');
  const playBtn = $('split-play');
  const resetBtn = $('split-reset');
  const prevBtn = $('split-prev');
  const nextBtn = $('split-next');
  const colsIn = $('split-cols');
  const rowsIn = $('split-rows');
  const fpsIn = $('split-fps');
  const nameIn = $('split-name');
  const fmtSel = $('split-fmt');
  const saveOrigChk = $('split-save-orig');
  const saveBtn = $('split-save');
  const status = $('split-status');
  const io = createIoButtons($('split-io'), setStatus);

  let sourceCanvas = null;
  let sourcePath = null;
  let sourceName = '';
  let current = 0;
  let playing = false;
  let timer = null;

  const cols = () => Math.max(1, parseInt(colsIn.value, 10) || 1);
  const rows = () => Math.max(1, parseInt(rowsIn.value, 10) || 1);
  const total = () => rows() * cols();

  function setStatus(msg) {
    status.textContent = msg;
  }

  async function loadEntry(entry) {
    if (!isSupportedName(entry.name)) return;
    setStatus('正在载入…');
    // 让状态先上屏，再执行解码等耗时同步操作
    await new Promise((r) => setTimeout(r, 0));
    let bmp;
    try {
      bmp = await readImageBitmap(entry);
    } catch (ex) {
      setStatus('图片解码失败：' + (ex?.message ?? ex));
      return;
    }
    stop();
    sourceCanvas = bitmapToCanvas(bmp);
    sourcePath = entry.path;
    sourceName = entry.name;
    current = 0;
    io.setSource(entry.path);
    io.setExport(null);
    srcView.setImage(sourceCanvas, sourceCanvas.width, sourceCanvas.height);
    saveBtn.disabled = false;
    clearBtn.disabled = false;
    autoDetect(entry.name);
    refreshGrid();
    refreshFrame();
    updateInfo();
  }

  function autoDetect(name) {
    const stem = name.replace(/\.[^.]*$/, '');
    const r = autoDetectGrid(sourceCanvas, stem);
    colsIn.value = Math.min(r.cols, 256);
    rowsIn.value = Math.min(r.rows, 256);
    if (r.kind === 'name') {
      setStatus(`已载入：${name}（文件名指定 ${r.cols} 列 x ${r.rows} 行）`);
    } else if (r.kind === 'gaps' || r.kind === 'period') {
      setStatus(`已载入：${name}（图片推测 ${r.cols} 列 x ${r.rows} 行；请检查网格，可手动调整）`);
    } else {
      setStatus(`已载入：${name}（未能自动识别行列，请手动设置行数 / 列数）`);
    }
  }

  const FORMAT_BY_EXT = {
    png: 'PNG',
    tga: 'TGA',
    targa: 'TGA',
    jpg: 'JPG',
    jpeg: 'JPG',
    bmp: 'BMP',
    gif: 'GIF',
    webp: 'WEBP',
    tif: 'TIF',
    tiff: 'TIFF',
  };
  const formatOf = (name) =>
    FORMAT_BY_EXT[(name.split('.').pop() || '').toLowerCase()] || '未知';

  function updateInfo() {
    if (sourceCanvas) {
      info.textContent = `图像尺寸：${sourceCanvas.width}x${sourceCanvas.height}  |  总帧数：${total()}  |  格式：${formatOf(sourceName)}`;
    } else {
      info.textContent = '图像尺寸：-  |  总帧数：-';
    }
  }

  function clearImage() {
    if (!sourceCanvas) return;
    stop();
    sourceCanvas = null;
    sourcePath = null;
    sourceName = '';
    current = 0;
    io.clear();
    srcView.clearOverlay();
    srcView.setImage(null);
    frameView.clearOverlay();
    frameView.setImage(null);
    slider.max = '0';
    slider.value = '0';
    pos.textContent = '0/0';
    saveBtn.disabled = true;
    clearBtn.disabled = true;
    updateInfo();
    setStatus('已清空图片');
  }

  function refreshGrid() {
    if (!sourceCanvas) return;
    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    const c = cols();
    const r = rows();
    const xEdges = [];
    const yEdges = [];
    for (let i = 0; i <= c; i++) xEdges.push(Math.floor((i * w) / c) / w);
    for (let i = 0; i <= r; i++) yEdges.push(Math.floor((i * h) / r) / h);
    srcView.setGrid(xEdges, yEdges, [current % c, Math.floor(current / c)]);
  }

  function refreshFrame() {
    if (!sourceCanvas) return;
    const c = cols();
    const r = rows();
    current = Math.max(0, Math.min(current, total() - 1));
    const [l, t, rr, b] = cellRect(sourceCanvas.width, sourceCanvas.height, c, r, current);
    const frame = cropCanvas(sourceCanvas, l, t, rr, b);
    frameView.setImage(frame, frame.width, frame.height);
    slider.max = String(Math.max(0, total() - 1));
    slider.value = String(current);
    pos.textContent = `${current + 1}/${Math.max(1, total())}`;
    refreshGrid();
  }

  // 逐帧步进：到头就停，不回绕（回绕是播放时循环的事，手动找帧要的是边界）
  function stepFrame(delta) {
    if (!sourceCanvas || total() === 0) return;
    current = Math.max(0, Math.min(current + delta, total() - 1));
    stop();
    refreshFrame();
  }

  function stop() {
    playing = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    playBtn.textContent = '播放';
  }

  function startTimer() {
    if (timer) clearInterval(timer);
    const fps = Math.max(1, parseInt(fpsIn.value, 10) || 30);
    timer = setInterval(tick, 1000 / fps);
  }

  function tick() {
    if (!sourceCanvas || total() === 0) {
      stop();
      return;
    }
    current = (current + 1) % total();
    refreshFrame();
  }

  async function splitAndSave() {
    if (!sourceCanvas) return;
    const c = cols();
    const r = rows();
    const fw = Math.floor(sourceCanvas.width / c);
    const fh = Math.floor(sourceCanvas.height / r);
    if (fw <= 0 || fh <= 0) {
      setStatus('行列设置无效');
      return;
    }
    let outDir = saveOrigChk.checked && sourcePath ? dirname(sourcePath) : null;
    outDir = await resolveSaveDir(outDir);
    if (isTauri && !outDir) return;
    const base = nameIn.value.trim() || 'NewSprite';
    const ext = (fmtSel.value || 'PNG').toLowerCase();
    const n = total();
    setStatus('正在保存…');
    try {
      for (let f = 0; f < n; f++) {
        const [l, t, rr, b] = cellRect(sourceCanvas.width, sourceCanvas.height, c, r, f);
        const frame = cropCanvas(sourceCanvas, l, t, rr, b);
        const fname = `${base}_${String(f).padStart(2, '0')}.${ext}`;
        const bytes = await encodeCanvas(frame, ext);
        const saved = await saveBlob(fname, bytes, outDir);
        if (saved === null) {
          setStatus('已取消');
          return;
        }
        // 浏览器下载拿不到落盘路径，只有写进目录时才能「打开导出文件」
        io.setExport(outDir ? saved : null);
        if (f % 8 === 7) {
          setStatus(`正在保存… ${f + 1}/${n}`);
          await new Promise((y) => setTimeout(y, 0));
        }
      }
    } catch (ex) {
      setStatus('保存失败：' + (ex?.message ?? ex));
      return;
    }
    setStatus(`完成：已保存 ${n} 帧（按原图像素分割；不能整除时，相邻帧尺寸会相差 1 像素）`);
  }

  function onGridChanged() {
    if (!sourceCanvas) return;
    current = Math.min(current, total() - 1);
    refreshGrid();
    refreshFrame();
    updateInfo();
    setStatus(`手动设置：${cols()} 列 x ${rows()} 行`);
  }

  openBtn.addEventListener('click', async () => {
    const entries = await pickImages(false);
    if (entries.length) await loadEntry(entries[0]);
  });
  clearBtn.addEventListener('click', clearImage);
  slider.addEventListener('input', () => {
    const v = parseInt(slider.value, 10);
    if (v !== current) {
      current = v;
      stop();
      refreshFrame();
    }
  });
  playBtn.addEventListener('click', () => {
    if (playing) {
      stop();
      return;
    }
    if (!sourceCanvas || total() === 0) return;
    playing = true;
    playBtn.textContent = '暂停';
    startTimer();
  });
  resetBtn.addEventListener('click', () => {
    current = 0;
    stop();
    refreshFrame();
  });
  prevBtn.addEventListener('click', () => stepFrame(-1));
  nextBtn.addEventListener('click', () => stepFrame(1));
  colsIn.addEventListener('input', onGridChanged);
  rowsIn.addEventListener('input', onGridChanged);
  fpsIn.addEventListener('input', () => {
    if (playing) startTimer();
  });
  saveBtn.addEventListener('click', splitAndSave);
  srcView.onCellClick = (col, row) => {
    const idx = row * cols() + col;
    if (idx >= 0 && idx < total()) {
      current = idx;
      stop();
      refreshFrame();
    }
  };

  return { loadEntry };
}
