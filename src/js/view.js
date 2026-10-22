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
    this._checker = this._makeChecker();
    if (canvas.parentElement) {
      new ResizeObserver(() => this.redraw()).observe(canvas.parentElement);
    }
    if (opts.clickable) {
      canvas.addEventListener('mousedown', (e) => this._click(e));
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
