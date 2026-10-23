import {
  pickImages,
  readImageBitmap,
  saveBlob,
  resolveSaveDir,
  collectFramePaths,
  naturalCompare,
  isSupportedName,
  dirname,
  isTauri,
} from './platform.js';
import {
  imageDataToCanvas,
  bitmapToCanvas,
  canvasToImageData,
  rotate90CW,
  encodeCanvas,
} from './image-util.js';
import { createIoButtons } from './io-buttons.js';

const $ = (id) => document.getElementById(id);

function computeLayout(sizes, columns) {
  columns = Math.max(1, columns);
  const rows = sizes.length ? Math.max(1, Math.ceil(sizes.length / columns)) : 1;
  const widths = new Array(columns).fill(0);
  const heights = new Array(rows).fill(0);
  sizes.forEach(([w, h], pos) => {
    const col = pos % columns;
    const row = Math.floor(pos / columns);
    widths[col] = Math.max(widths[col], w);
    heights[row] = Math.max(heights[row], h);
  });
  const fallback = widths.reduce((a, b) => Math.max(a, b), 0);
  return [widths.map((w) => (w > 0 ? w : fallback)), heights];
}

export function initMerge({ mergeView }) {
  const countLabel = $('merge-count');
  const listEl = $('merge-list');
  const addBtn = $('merge-add');
  const clearBtn = $('merge-clear');
  const playBtn = $('merge-play');
  const resetBtn = $('merge-reset');
  const prevBtn = $('merge-prev');
  const nextBtn = $('merge-next');
  const pos = $('merge-pos');
  const gridChk = $('merge-grid');
  const fpsIn = $('merge-fps');
  const slider = $('merge-slider');
  const colsIn = $('merge-cols');
  const rotateChk = $('merge-rotate');
  const sizeLabel = $('merge-size');
  const outWIn = $('merge-out-w');
  const outHIn = $('merge-out-h');
  const fmtIn = $('merge-fmt');
  const saveOrigChk = $('merge-save-orig');
  const previewBtn = $('merge-preview-btn');
  const saveBtn = $('merge-save');
  const status = $('merge-status');
  const io = createIoButtons($('merge-io'), setStatus);

  const frames = [];
  let current = 0;
  let playing = false;
  let timer = null;
  let showMerged = false;
  let merged = null; // 合并结果 canvas
  let mergedKey = ''; // 合成 merged 时的布局指纹
  let framesRev = 0; // 帧集合版本号
  let mergedWidths = [];
  let mergedHeights = [];
  let syncing = false;

  const cols = () => Math.max(1, parseInt(colsIn.value, 10) || 1);
  const outW = () => Math.max(1, parseInt(outWIn.value, 10) || 1);
  const outH = () => Math.max(1, parseInt(outHIn.value, 10) || 1);

  function setStatus(m) {
    status.textContent = m;
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

  const visibleIndices = () =>
    frames.map((f, i) => (f.hidden ? -1 : i)).filter((i) => i >= 0);

  function visiblePosition(idx) {
    let c = 0;
    for (let i = 0; i <= Math.min(idx, frames.length - 1); i++) {
      if (!frames[i].hidden) c++;
    }
    return c;
  }

  function frameAtVisiblePos(p) {
    let c = 0;
    for (let i = 0; i < frames.length; i++) {
      if (!frames[i].hidden) c++;
      if (c === p) return i;
    }
    return Math.max(0, Math.min(p - 1, frames.length - 1));
  }

  function makeThumb(cv) {
    const c = document.createElement('canvas');
    c.width = 18;
    c.height = 18;
    const x = c.getContext('2d');
    const s = Math.min(18 / cv.width, 18 / cv.height);
    const w = cv.width * s;
    const h = cv.height * s;
    x.imageSmoothingEnabled = true;
    x.drawImage(cv, (18 - w) / 2, (18 - h) / 2, w, h);
    return c.toDataURL();
  }

  async function addEntries(entries) {
    const files = await collectFramePaths(entries);
    let added = 0;
    for (const e of files) {
      if (!isSupportedName(e.name)) continue;
      const dup = e.path
        ? frames.some((f) => f.path === e.path)
        : frames.some((f) => !f.path && f.name === e.name.replace(/\.[^.]*$/, ''));
      if (dup) continue;
      try {
        const cv = bitmapToCanvas(await readImageBitmap(e));
        frames.push({
          name: e.name.replace(/\.[^.]*$/, ''),
          path: e.path,
          cv,
          cvRot: null,
          hidden: false,
          thumb: makeThumb(cv),
        });
        added++;
      } catch (ex) {
        setStatus(`无法读取 ${e.name}：${ex?.message ?? ex}`);
      }
    }
    if (!added && !files.length) return;
    frames.sort((a, b) => naturalCompare(a.name, b.name));
    stop();
    showMerged = false;
    merged = null;
    framesRev++;
    current = 0;
    rebuildList();
    syncOutputSize();
    refreshView();
    setStatus(`已载入 ${frames.length} 张图`);
    io.setSource(frames[0]?.path || null);
    io.setExport(null);
  }

  function clear() {
    stop();
    frames.length = 0;
    io.clear();
    current = 0;
    showMerged = false;
    merged = null;
    framesRev++;
    rebuildList();
    refreshView();
    sizeLabel.textContent = '合并后尺寸：0 x 0 px';
  }

  function remove(idx) {
    if (idx < 0 || idx >= frames.length) return;
    frames.splice(idx, 1);
    framesRev++;
    if (current >= frames.length) current = Math.max(0, frames.length - 1);
    if (!frames.length) {
      showMerged = false;
      merged = null;
    } else if (showMerged) {
      buildMerged();
    }
    rebuildList();
    syncOutputSize();
    refreshView();
    setStatus(`已删除第 ${idx + 1} 帧，剩余 ${frames.length} 张`);
  }

  function toggleHidden(idx) {
    if (idx < 0 || idx >= frames.length) return;
    frames[idx].hidden = !frames[idx].hidden;
    if (showMerged) buildMerged();
    rebuildList(true);
    refreshView();
  }

  function rebuildList(keepScroll = false) {
    const scroll = keepScroll ? listEl.scrollTop : 0;
    listEl.innerHTML = '';
    frames.forEach((f, i) => {
      const row = document.createElement('div');
      row.className =
        'frame-row' + (i === current ? ' selected' : '') + (f.hidden ? ' hidden-frame' : '');
      const img = document.createElement('img');
      img.src = f.thumb;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = f.name;
      const btn = document.createElement('button');
      btn.className = 'btn mini-btn';
      btn.textContent = f.hidden ? '显示' : '隐藏';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleHidden(i);
      });
      row.append(img, name, btn);
      row.addEventListener('click', () => {
        current = i;
        stop();
        markSelection();
        refreshView();
      });
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        remove(i);
      });
      listEl.appendChild(row);
    });
    listEl.scrollTop = scroll;
    const hidden = frames.filter((f) => f.hidden).length;
    countLabel.textContent =
      '图片数：' + frames.length + (hidden ? `  (隐藏 ${hidden})` : '');
    const has = frames.length > 0;
    previewBtn.disabled = !has;
    saveBtn.disabled = !has;
  }

  function markSelection() {
    [...listEl.children].forEach((row, i) =>
      row.classList.toggle('selected', i === current)
    );
  }

  function loadFrame(idx) {
    const f = frames[idx];
    if (!rotateChk.checked) return f.cv;
    if (!f.cvRot) f.cvRot = imageDataToCanvas(rotate90CW(canvasToImageData(f.cv)));
    return f.cvRot;
  }

  function visibleSizes() {
    const out = [];
    for (const f of frames) {
      if (f.hidden) continue;
      out.push(
        rotateChk.checked
          ? [f.cv.height, f.cv.width]
          : [f.cv.width, f.cv.height]
      );
    }
    return out;
  }

  function naturalSize() {
    const sizes = visibleSizes();
    if (!sizes.length) return [0, 0];
    const [widths, heights] = computeLayout(sizes, cols());
    return [
      widths.reduce((a, b) => a + b, 0),
      heights.reduce((a, b) => a + b, 0),
    ];
  }

  function syncOutputSize() {
    if (!frames.length) return;
    const [nw, nh] = naturalSize();
    syncing = true;
    outWIn.value = String(Math.max(1, nw));
    outHIn.value = String(Math.max(1, nh));
    syncing = false;
    sizeLabel.textContent = `合并后尺寸：${nw} x ${nh} px`;
  }

  // 布局指纹：帧集合、隐藏状态、列数与输出尺寸都没变就不必重新合成整张图
  function layoutKey() {
    const sizes = visibleSizes();
    let k = `${framesRev}|${cols()}|${outW()}x${outH()}|${sizes.length}`;
    for (const [w, h] of sizes) k += `:${w}x${h}`;
    return k;
  }

  function buildMerged() {
    const vis = visibleIndices();
    if (!vis.length) {
      merged = null;
      setStatus('没有可合并的帧');
      return false;
    }
    const key = layoutKey();
    if (merged && mergedKey === key) return true;
    try {
      const images = vis.map((i) => loadFrame(i));
      const [widths, heights] = computeLayout(
        images.map((im) => [im.width, im.height]),
        cols()
      );
      const nw = widths.reduce((a, b) => a + b, 0);
      const nh = heights.reduce((a, b) => a + b, 0);
      const xs = [0];
      for (const w of widths) xs.push(xs[xs.length - 1] + w);
      const ys = [0];
      for (const h of heights) ys.push(ys[ys.length - 1] + h);
      const sheet = document.createElement('canvas');
      sheet.width = nw;
      sheet.height = nh;
      const x = sheet.getContext('2d');
      images.forEach((im, p) => {
        x.drawImage(im, xs[p % cols()], ys[Math.floor(p / cols())]);
      });
      const ow = outW();
      const oh = outH();
      let result = sheet;
      if (ow !== nw || oh !== nh) {
        const rc = document.createElement('canvas');
        rc.width = ow;
        rc.height = oh;
        const rx = rc.getContext('2d');
        rx.imageSmoothingEnabled = true;
        rx.drawImage(sheet, 0, 0, ow, oh);
        result = rc;
      }
      merged = result;
      mergedKey = key;
      mergedWidths = widths;
      mergedHeights = heights;
      const same = merged.width === nw && merged.height === nh;
      setStatus(
        `合并预览：${merged.width}x${merged.height}` +
          (same ? '（原始像素，无缩放）' : '（已按输出尺寸缩放）')
      );
      return true;
    } catch (ex) {
      merged = null;
      setStatus('合并失败：' + (ex?.message ?? ex));
      return false;
    }
  }

  function refreshView() {
    if (!frames.length) {
      mergeView.setImage(null);
      mergeView.clearOverlay();
      pos.textContent = '0/0';
      slider.max = '1';
      slider.value = '1';
      return;
    }
    if (showMerged && merged) showMergedView();
    else showFrameView();
    updateSlider();
  }

  function showFrameView() {
    current = Math.max(0, Math.min(current, frames.length - 1));
    const cv = loadFrame(current);
    mergeView.setGrid(null, null);
    mergeView.setBorder(gridChk.checked);
    mergeView.setImage(cv, cv.width, cv.height);
  }

  function showMergedView() {
    mergeView.setImage(merged, merged.width, merged.height);
    if (gridChk.checked && mergedWidths.length) {
      const tw = mergedWidths.reduce((a, b) => a + b, 0);
      const th = mergedHeights.reduce((a, b) => a + b, 0);
      const xs = [0];
      let acc = 0;
      for (const w of mergedWidths) {
        acc += w;
        xs.push(acc / tw);
      }
      const ys = [0];
      acc = 0;
      for (const h of mergedHeights) {
        acc += h;
        ys.push(acc / th);
      }
      let hl = null;
      if (current >= 0 && current < frames.length && !frames[current].hidden) {
        const p = visiblePosition(current) - 1;
        if (p >= 0) hl = [p % cols(), Math.floor(p / cols())];
      }
      mergeView.setGrid(xs, ys, hl);
    } else {
      mergeView.setGrid(null, null);
    }
    mergeView.setBorder(false);
  }

  function updateSlider() {
    const vis = visibleIndices().length;
    const p = frames.length ? visiblePosition(current) : 0;
    slider.max = String(Math.max(1, vis));
    slider.value = String(Math.max(1, Math.min(p, Math.max(1, vis))));
    pos.textContent = `${Math.max(1, Math.min(p, vis))}/${vis}`;
  }

  // 手动定位到某一帧：停播放、退出合并图视图，和拖滑块走同一条路
  function showOneFrame(idx) {
    current = idx;
    stop();
    showMerged = false;
    markSelection();
    refreshView();
  }

  // 逐帧步进只在「可见帧」之间走（隐藏的帧不参与播放，读数也不能跳过去）；到头停住不回绕
  function stepFrame(delta) {
    const vis = visibleIndices();
    if (!vis.length) return;
    const nxt = delta > 0 ? vis.find((i) => i > current) : vis.filter((i) => i < current).pop();
    if (nxt === undefined) return;
    showOneFrame(nxt);
  }

  function tick() {
    const vis = visibleIndices();
    if (!vis.length) {
      stop();
      return;
    }
    const nxt = vis.find((i) => i > current) ?? vis[0];
    current = nxt;
    markSelection();
    refreshView();
  }

  async function mergeAndSave() {
    if (!frames.length) return;
    let sourceDir = null;
    if (saveOrigChk.checked && frames[0].path) sourceDir = dirname(frames[0].path);
    const dir = await resolveSaveDir(sourceDir);
    if (isTauri && !dir) return;
    if (!buildMerged() || !merged) return;
    const ext = (fmtIn.value || 'PNG').toLowerCase();
    const fname = `Sequence_${merged.width}x${merged.height}.${ext}`;
    try {
      // 大图编码要占住 JS 线程，先让状态上屏再开始
      setStatus(`正在导出 ${merged.width}x${merged.height} ${ext.toUpperCase()}…`);
      await new Promise((r) => setTimeout(r, 0));
      const bytes = await encodeCanvas(merged, ext);
      const saved = await saveBlob(fname, bytes, dir);
      if (saved) setStatus('已保存：' + saved);
      io.setExport(dir ? saved : null);
    } catch (ex) {
      setStatus('合并失败：' + (ex?.message ?? ex));
    }
  }

  addBtn.addEventListener('click', async () => {
    const entries = await pickImages(true);
    if (entries.length) await addEntries(entries);
  });
  clearBtn.addEventListener('click', clear);
  playBtn.addEventListener('click', () => {
    if (playing) {
      stop();
      return;
    }
    if (!visibleIndices().length) return;
    showMerged = false;
    gridChk.checked = false;
    playing = true;
    playBtn.textContent = '暂停';
    startTimer();
    refreshView();
  });
  slider.addEventListener('input', () => {
    if (!frames.length) return;
    const idx = frameAtVisiblePos(parseInt(slider.value, 10));
    if (idx !== current) showOneFrame(idx);
  });
  resetBtn.addEventListener('click', () => {
    const vis = visibleIndices();
    if (vis.length) showOneFrame(vis[0]);
  });
  prevBtn.addEventListener('click', () => stepFrame(-1));
  nextBtn.addEventListener('click', () => stepFrame(1));
  gridChk.addEventListener('change', refreshView);
  fpsIn.addEventListener('input', () => {
    if (playing) startTimer();
  });
  colsIn.addEventListener('input', () => {
    if (!frames.length) return;
    syncOutputSize();
    if (showMerged) buildMerged();
    refreshView();
  });
  rotateChk.addEventListener('change', () => {
    if (!frames.length) return;
    syncOutputSize();
    if (showMerged) buildMerged();
    refreshView();
  });
  outWIn.addEventListener('input', () => {
    if (!syncing && showMerged && frames.length) {
      buildMerged();
      refreshView();
    }
  });
  outHIn.addEventListener('input', () => {
    if (!syncing && showMerged && frames.length) {
      buildMerged();
      refreshView();
    }
  });
  previewBtn.addEventListener('click', () => {
    if (showMerged) {
      showMerged = false;
      gridChk.checked = false;
      previewBtn.textContent = '预览';
    } else {
      stop();
      if (!buildMerged()) return;
      showMerged = true;
      gridChk.checked = true;
      previewBtn.textContent = '关闭预览';
    }
    refreshView();
  });
  saveBtn.addEventListener('click', mergeAndSave);
  listEl.addEventListener('keydown', (e) => {
    if (!frames.length) return;
    if (e.key === 'Delete') {
      remove(current);
      e.preventDefault();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      current = Math.max(
        0,
        Math.min(frames.length - 1, current + (e.key === 'ArrowUp' ? -1 : 1))
      );
      stop();
      showMerged = false;
      markSelection();
      refreshView();
      e.preventDefault();
    }
  });

  return { addEntries };
}
