import { makeZoomPan } from './zoom-pan.js';

// 框选手柄：8 个方位，顺序对应光标表
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSORS = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
};
const HS = 7; // 手柄边长（CSS px）
const HIT = 6; // 手柄命中半径

const NO_ZP = { zoom: 1, panX: 0, panY: 0 };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// 统一成 x0<x1、y0<y1 且落在 0..1 内
function normSel(s) {
  const x0 = clamp01(Math.min(s.x0, s.x1));
  const x1 = clamp01(Math.max(s.x0, s.x1));
  const y0 = clamp01(Math.min(s.y0, s.y1));
  const y1 = clamp01(Math.max(s.y0, s.y1));
  return { x0, y0, x1, y1 };
}

export class CanvasView {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = null;
    // 平铺预览：同一张源图按 n×n 画出来，用来肉眼确认接缝消失。
    // 走绘制而不是拼一张 n 倍大的 canvas：2048 的图拼 2×2 是 4096²（64MB），每次改参数重建一次太贵
    this.tile = 1;
    this.bgMode = opts.bgMode ?? 2;
    this.xEdges = null;
    this.yEdges = null;
    this.highlight = null;
    this.border = false;
    this.gridColor = opts.gridColor ?? 'rgba(255,255,255,0.35)';
    this.hlColor = opts.hlColor ?? '#4DCCFF';
    this.onCellClick = null;
    // 归一化选区 {x0,y0,x1,y1}，只在 selectable 时由鼠标维护
    this.select = null;
    this.onSelect = null;
    this.onSelectEnd = null;
    this.selectEnabled = !!opts.selectable;
    this._drag = null;
    this._checker = null;
    this._checkerSize = 0;
    this._checkerPattern = null;
    // 右侧预览才开缩放平移：左侧源画布上的滚轮/拖拽留给各自的交互（框选、点格子）
    if (opts.zoomable) {
      this._zp = makeZoomPan(
        canvas,
        () => {
          const cw = canvas.clientWidth;
          const ch = canvas.clientHeight;
          if (!cw || !ch || !this.image) return { boxW: cw, boxH: ch, s0: 0 };
          // 平铺时按整幅（n×n 张）算适配；「100%」仍然是一个源像素对一个屏幕像素
          return {
            boxW: cw,
            boxH: ch,
            s0: Math.min(cw / (this.image.w * this.tile), ch / (this.image.h * this.tile)),
          };
        },
        () => this.redraw()
      );
      canvas.classList.add('zoomable');
    }
    if (canvas.parentElement) {
      new ResizeObserver(() => this.redraw()).observe(canvas.parentElement);
    }
    if (opts.clickable) {
      canvas.addEventListener('mousedown', (e) => this._click(e));
    }
    if (opts.selectable) {
      canvas.addEventListener('mousedown', (e) => this._selDown(e));
      canvas.addEventListener('mousemove', (e) => this._selMove(e));
      window.addEventListener('mouseup', (e) => this._selUp(e));
    }
  }

  // 图样按设备像素生成：CSS 变换下 48 CSS px 的图样在 1.25/1.5 缩放屏上要被放大，
  // 再走双线性插值，格子边界就糊了。尺寸变了（换屏、改缩放）重建一份。
  _checkerAt(dpr) {
    const size = Math.max(2, Math.round(48 * dpr));
    if (size === this._checkerSize) return this._checkerPattern;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const x = c.getContext('2d');
    x.fillStyle = '#515159';
    x.fillRect(0, 0, size, size);
    x.fillStyle = '#909098';
    const half = Math.round(size / 2);
    // 整数边界：半格取整后剩下的那条缝别留给抗锯齿
    x.fillRect(half, 0, size - half, half);
    x.fillRect(0, half, half, size - half);
    this._checker = c;
    this._checkerSize = size;
    this._checkerPattern = this.ctx.createPattern(c, 'repeat');
    return this._checkerPattern;
  }

  setImage(source, w, h) {
    this.image = source ? { source, w, h } : null;
    this.redraw();
  }

  // 平铺预览的列数/行数；1 就是正常显示。改这里不会换图，只重画一次
  setTile(n) {
    const v = Math.max(1, Math.min(4, Math.floor(n) || 1));
    if (v === this.tile) return;
    this.tile = v;
    this.redraw();
  }

  setGrid(xEdges, yEdges, highlight = null) {
    this.xEdges = xEdges;
    this.yEdges = yEdges;
    this.highlight = highlight;
    this.redraw();
  }

  clearOverlay() {
    this.xEdges = null;
    this.yEdges = null;
    this.highlight = null;
    this.border = false;
    this.redraw();
  }

  setBorder(on) {
    this.border = on;
    this.redraw();
  }

  // 归一化选区；传 null 清除。程序设置不触发 onSelect
  setSelect(sel) {
    this.select = sel ? normSel(sel) : null;
    this.redraw();
  }

  // 框选模式开关：关掉时鼠标完全不响应选区，光标也还回去
  setSelectEnabled(on) {
    this.selectEnabled = on;
    if (!on) this._drag = null;
    this.canvas.style.cursor = on ? 'crosshair' : 'default';
  }

  // 同一颗左键不能既拖图又框选：进裁剪模式时把平移让出去
  setPanEnabled(on) {
    if (this._zp) this._zp.setPanEnabled(on);
  }

  targetRect() {
    if (!this.image) return null;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!cw || !ch || !this.image.w || !this.image.h) return null;
    // 缩放平移只在这一个出口生效：绘制、网格、框选命中全都走这里，坐标自然跟着走
    const v = this._zp ? this._zp.state : NO_ZP;
    const ew = this.image.w * this.tile;
    const eh = this.image.h * this.tile;
    const s = Math.min(cw / ew, ch / eh) * v.zoom;
    const tw = ew * s;
    const th = eh * s;
    return { x: (cw - tw) / 2 + v.panX, y: (ch - th) / 2 + v.panY, w: tw, h: th };
  }

  // 视图工具按钮用；没开 zoomable 的视图调了也不动
  fitWindow() {
    if (this._zp) this._zp.fitWindow();
  }

  resetPan() {
    if (this._zp) this._zp.resetPan();
  }

  zoomActual() {
    if (this._zp) this._zp.zoomActual();
  }

  redraw() {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!cw || !ch) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    if (this.bgMode === 0) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);
    } else if (this.bgMode === 1) {
      ctx.fillStyle = '#D9D9D9';
      ctx.fillRect(0, 0, cw, ch);
    } else if (this.bgMode === 3) {
      ctx.fillStyle = '#1A1A22';
      ctx.fillRect(0, 0, cw, ch);
    } else {
      // 回到设备像素空间铺图样，1 图样像素 = 1 屏幕像素；关掉平滑避免边界插值
      const pat = this._checkerAt(dpr);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.restore();
    }
    if (!this.image) return;
    const t = this.targetRect();
    if (!t) return;
    const src = this.image.source;
    if (this.tile === 1) {
      ctx.drawImage(src, t.x, t.y, t.w, t.h);
    } else {
      const sw = t.w / this.tile;
      const sh = t.h / this.tile;
      for (let j = 0; j < this.tile; j++) {
        for (let i = 0; i < this.tile; i++) ctx.drawImage(src, t.x + i * sw, t.y + j * sh, sw, sh);
      }
    }
    if (this.xEdges && this.yEdges && this.xEdges.length > 1) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = this.gridColor;
      ctx.beginPath();
      for (const xf of this.xEdges) {
        const x = t.x + xf * t.w;
        ctx.moveTo(x, t.y);
        ctx.lineTo(x, t.y + t.h);
      }
      for (const yf of this.yEdges) {
        const y = t.y + yf * t.h;
        ctx.moveTo(t.x, y);
        ctx.lineTo(t.x + t.w, y);
      }
      ctx.stroke();
      if (this.highlight) {
        const [col, row] = this.highlight;
        if (col >= 0 && col < this.xEdges.length - 1 && row >= 0 && row < this.yEdges.length - 1) {
          const x0 = t.x + this.xEdges[col] * t.w;
          const x1 = t.x + this.xEdges[col + 1] * t.w;
          const y0 = t.y + this.yEdges[row] * t.h;
          const y1 = t.y + this.yEdges[row + 1] * t.h;
          ctx.lineWidth = 2;
          ctx.strokeStyle = this.hlColor;
          ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        }
      }
    }
    if (this.border) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = this.hlColor;
      ctx.strokeRect(t.x, t.y, t.w, t.h);
    }
    if (this.select) this._drawSelect(t);
  }

  // 选区：外部压暗 + 虚线框 + 8 个手柄
  _drawSelect(t) {
    const ctx = this.ctx;
    const r = this._selectPx(t);
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    ctx.save();
    ctx.fillStyle = 'rgba(8,9,13,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill('evenodd');
    ctx.setLineDash([5, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.hlColor;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    ctx.setLineDash([]);
    for (const which of HANDLES) {
      const [hx, hy] = this._handlePx(r, which);
      ctx.fillStyle = '#0e1116';
      ctx.fillRect(hx - HS / 2 - 1, hy - HS / 2 - 1, HS + 2, HS + 2);
      ctx.fillStyle = this.hlColor;
      ctx.fillRect(hx - HS / 2, hy - HS / 2, HS, HS);
    }
    ctx.restore();
  }

  _selectPx(t) {
    const s = this.select;
    const x = t.x + s.x0 * t.w;
    const y = t.y + s.y0 * t.h;
    return {
      x,
      y,
      w: Math.max(1, (s.x1 - s.x0) * t.w),
      h: Math.max(1, (s.y1 - s.y0) * t.h),
    };
  }

  _handlePx(r, which) {
    const x = which.includes('w') ? r.x : which.includes('e') ? r.x + r.w : r.x + r.w / 2;
    const y = which.includes('n') ? r.y : which.includes('s') ? r.y + r.h : r.y + r.h / 2;
    return [x, y];
  }

  _localXY(e) {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  // 命中测试：先手柄，再内部（平移），都没中就是重新框选
  _hitSelect(px, py, t) {
    if (!this.select) return { mode: 'new' };
    const r = this._selectPx(t);
    for (const which of HANDLES) {
      const [hx, hy] = this._handlePx(r, which);
      if (Math.abs(px - hx) <= HIT && Math.abs(py - hy) <= HIT) return { mode: 'resize', which };
    }
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return { mode: 'move' };
    return { mode: 'new' };
  }

  _selDown(e) {
    if (!this.selectEnabled || e.button !== 0) return; // 右键归平移，不参与框选
    const t = this.targetRect();
    if (!t) return;
    const [px, py] = this._localXY(e);
    const hit = this._hitSelect(px, py, t);
    const fx = clamp01((px - t.x) / t.w);
    const fy = clamp01((py - t.y) / t.h);
    if (hit.mode === 'resize') {
      this._drag = { mode: 'resize', which: hit.which };
    } else if (hit.mode === 'move') {
      this._drag = { mode: 'move', ox: fx - this.select.x0, oy: fy - this.select.y0, sel: { ...this.select } };
    } else {
      this._drag = { mode: 'new', ax: fx, ay: fy, prev: this.select };
      this.select = { x0: fx, y0: fy, x1: fx, y1: fy };
    }
    e.preventDefault();
    this.canvas.style.cursor = hit.mode === 'new' ? 'crosshair' : CURSORS[hit.which] || 'move';
    this.redraw();
  }

  _selMove(e) {
    if (!this.selectEnabled) return;
    const t = this.targetRect();
    if (!t) return;
    const [px, py] = this._localXY(e);
    const fx = clamp01((px - t.x) / t.w);
    const fy = clamp01((py - t.y) / t.h);
    const d = this._drag;
    if (!d) {
      if (e.buttons & 2) return; // 右键平移进行中：别用悬停光标盖掉 grabbing
      const hit = this._hitSelect(px, py, t);
      this.canvas.style.cursor =
        hit.mode === 'resize' ? CURSORS[hit.which] : hit.mode === 'move' ? 'move' : 'crosshair';
      return;
    }
    if (d.mode === 'resize') {
      const out = { ...this.select };
      if (d.which.includes('w')) out.x0 = fx;
      if (d.which.includes('e')) out.x1 = fx;
      if (d.which.includes('n')) out.y0 = fy;
      if (d.which.includes('s')) out.y1 = fy;
      this.select = normSel(out);
    } else if (d.mode === 'move') {
      const w = d.sel.x1 - d.sel.x0;
      const h = d.sel.y1 - d.sel.y0;
      const x0 = Math.min(1 - w, Math.max(0, fx - d.ox));
      const y0 = Math.min(1 - h, Math.max(0, fy - d.oy));
      this.select = { x0, y0, x1: x0 + w, y1: y0 + h };
    } else {
      this.select = normSel({ x0: d.ax, y0: d.ay, x1: fx, y1: fy });
    }
    this.redraw();
    if (this.onSelect) this.onSelect(this.select);
  }

  _selUp(e) {
    if (e && e.button !== 0) return; // 松开右键只该结束平移
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    if (this.selectEnabled) this.canvas.style.cursor = 'crosshair';
    // 极小的拖动当作误点：退回原来的选区，清空交给「选择区域」再点一次（GIF 页的取消）
    if (d.mode === 'new') {
      const t = this.targetRect();
      const r = t ? this._selectPx(t) : null;
      if (!r || r.w < 4 || r.h < 4) this.select = d.prev || null;
    }
    this.redraw();
    if (this.onSelect) this.onSelect(this.select);
    if (this.onSelectEnd) this.onSelectEnd(this.select);
  }

  _click(e) {
    if (!this.onCellClick || !this.image || !this.xEdges || !this.yEdges) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const t = this.targetRect();
    if (!t || t.w <= 0 || t.h <= 0) return;
    if (px < t.x || px > t.x + t.w || py < t.y || py > t.y + t.h) return;
    const fx = (px - t.x) / t.w;
    const fy = (py - t.y) / t.h;
    let col = 0;
    let row = 0;
    for (let i = 0; i < this.xEdges.length - 1; i++) {
      col = i;
      if (this.xEdges[i] <= fx && fx < this.xEdges[i + 1]) break;
    }
    for (let i = 0; i < this.yEdges.length - 1; i++) {
      row = i;
      if (this.yEdges[i] <= fy && fy < this.yEdges[i + 1]) break;
    }
    this.onCellClick(col, row);
  }
}
