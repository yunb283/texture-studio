// 预览视图的滚轮缩放 + 左键拖拽平移。
// 只管「相对适配窗口的倍率」和「图像中心相对画布中心的偏移（CSS px）」这两个数，
// 怎么落到屏幕上由调用方决定：CanvasView 改 targetRect，GIF 结果预览改 CSS transform。
// 缩放上下限按「1 个图像像素占多少物理屏幕像素」算，跟显示器缩放比例无关。

const MIN_DEV = 0.05; // 再小就糊成一团了
const MAX_DEV = 64; // 再大 canvas 要画几十万像素宽，没意义

// el: 绑事件的元素；getLayout(): {boxW, boxH, s0}，s0 = zoom=1 时 1 图像像素等于多少 CSS px（没图给 0）
export function makeZoomPan(el, getLayout, onChange) {
  const st = { zoom: 1, panX: 0, panY: 0 };
  const dpr = () => window.devicePixelRatio || 1;

  const limits = (s0) => {
    const k = s0 * dpr();
    return [MIN_DEV / k, MAX_DEV / k];
  };

  function clampZoom(z) {
    const L = getLayout();
    if (!L || !L.s0) return 1;
    const [lo, hi] = limits(L.s0);
    return Math.min(hi, Math.max(lo, z));
  }

  const apply = () => onChange(st);

  // 绕着光标缩放：光标那个点相对中心的偏移按新/旧倍率同比放大
  function zoomAt(px, py, factor) {
    const L = getLayout();
    if (!L || !L.s0) return;
    const [lo, hi] = limits(L.s0);
    const z0 = Math.min(hi, Math.max(lo, st.zoom));
    const z1 = Math.min(hi, Math.max(lo, z0 * factor));
    if (z1 === z0) return;
    const r = z1 / z0;
    const cx = L.boxW / 2 + st.panX;
    const cy = L.boxH / 2 + st.panY;
    st.panX = px - r * (px - cx) - L.boxW / 2;
    st.panY = py - r * (py - cy) - L.boxH / 2;
    st.zoom = z1;
    apply();
  }

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 33;
      else if (e.deltaMode === 2) dy *= 400;
      const rect = el.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.pow(1.0018, -dy));
    },
    { passive: false }
  );

  let drag = null;
  // 左键要留给别的交互时（比如框选裁剪）把左键平移关掉，那种场合改用右键平移
  let panEnabled = true;
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    if (e.button === 0 && !panEnabled) return; // 开关只管左键，右键始终能平移
    if (!getLayout().s0) return;
    drag = { btn: e.button, x: e.clientX, y: e.clientY, px: st.panX, py: st.panY };
    el.classList.add('panning');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    st.panX = drag.px + (e.clientX - drag.x);
    st.panY = drag.py + (e.clientY - drag.y);
    apply();
  });
  window.addEventListener('mouseup', (e) => {
    if (!drag || e.button !== drag.btn) return; // 左右键混着按时，别把另一种拖拽掐掉
    drag = null;
    el.classList.remove('panning');
  });

  return {
    state: st,
    setPanEnabled(on) {
      if (panEnabled === on) return;
      panEnabled = on;
      if (!on && drag) {
        drag = null;
        el.classList.remove('panning');
      }
    },
    fitWindow() {
      st.zoom = 1;
      st.panX = st.panY = 0;
      apply();
    },
    resetPan() {
      st.panX = st.panY = 0;
      apply();
    },
    // 1 图像像素 = 1 物理屏幕像素；只改倍率，不动中心
    zoomActual() {
      const L = getLayout();
      if (!L || !L.s0) return;
      st.zoom = clampZoom(1 / (L.s0 * dpr()));
      apply();
    },
    scalePct() {
      const L = getLayout();
      if (!L || !L.s0) return 100;
      return Math.round(L.s0 * st.zoom * dpr() * 100);
    },
  };
}
