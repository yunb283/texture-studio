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
    this.selectEnabled = !!opts.selectable;
    this._drag = null;
    this._checker = this._makeChecker();
    if (canvas.parentElement) {
      new ResizeObserver(() => this.redraw()).observe(canvas.parentElement);
    }
    if (opts.clickable) {
      canvas.addEventListener('mousedown', (e) => this._click(e));
    }
    if (opts.selectable) {
      canvas.addEventListener('mousedown', (e) => this._selDown(e));
      canvas.addEventListener('mousemove', (e) => this._selMove(e));
      window.addEventListener('mouseup', () => this._selUp());
    }
  }

  _makeChecker() {
    const c = document.createElement('canvas');
    c.width = 48;
    c.height = 48;
    const x = c.getContext('2d');
    x.fillStyle = '#515159';
    x.fillRect(0, 0, 48, 48);
    x.fillStyle = '#909098';
    x.fillRect(24, 0, 24, 24);
    x.fillRect(0, 24, 24, 24);
    return c;
  }

  setImage(source, w, h) {
    this.image = source ? { source, w, h } : null;
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

  targetRect() {
    if (!this.image) return null;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!cw || !ch || !this.image.w || !this.image.h) return null;
    const s = Math.min(cw / this.image.w, ch / this.image.h);
    const tw = this.image.w * s;
    const th = this.image.h * s;
    return { x: (cw - tw) / 2, y: (ch - th) / 2, w: tw, h: th };
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
      ctx.fillStyle = ctx.createPattern(this._checker, 'repeat');
      ctx.fillRect(0, 0, cw, ch);
    }
    if (!this.image) return;
    const t = this.targetRect();
    if (!t) return;
    ctx.drawImage(this.image.source, t.x, t.y, t.w, t.h);
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
    if (!this.selectEnabled) return;
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
      this._drag = { mode: 'new', ax: fx, ay: fy };
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

  _selUp() {
    if (!this._drag) return;
    const wasNew = this._drag.mode === 'new';
    this._drag = null;
    this.canvas.style.cursor = 'crosshair';
    // 单击或极小的拖动当作清除选区
    if (this.select && wasNew) {
      const t = this.targetRect();
      const r = t ? this._selectPx(t) : null;
      if (!r || r.w < 4 || r.h < 4) this.select = null;
    }
    this.redraw();
    if (this.onSelect) this.onSelect(this.select);
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
