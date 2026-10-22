// 让同一页里左右两个预览窗口保持等大：
// 两侧面板的固定内容（按钮、参数、状态行）高度不同，flex:1 分到的画布高度就不一样，
// 所以先清掉钉死的 flex 量一次各自的自然剩余空间，取较小值再把两个容器都钉成这个高度。
// 内容较少的一侧会把多出来的空间留给底部的说明（配合 CSS margin-top:auto）。
// 触发时机：面板或画布容器尺寸变化、动态文本（信息行/状态/说明）变高、切到本页（display 变化
// 不算 ResizeObserver，得看 class）、窗口缩放。
export function equalizeCanvases(pageEl) {
  const wraps = [...pageEl.querySelectorAll('.canvas-wrap')];
  if (wraps.length < 2) return () => {};
  let applying = false;
  const run = () => {
    if (applying) return;
    applying = true;
    try {
      for (const w of wraps) w.style.flex = '';
      const h = Math.round(Math.min(...wraps.map((w) => w.getBoundingClientRect().height)));
      if (h < 40) return; // 页面被隐藏时量到 0，别把画布钉死
      for (const w of wraps) w.style.flex = `0 0 ${h}px`;
    } finally {
      applying = false;
    }
  };
  const ro = new ResizeObserver(run);
  for (const w of wraps) ro.observe(w);
  for (const p of pageEl.querySelectorAll('.panel')) ro.observe(p);
  for (const el of pageEl.querySelectorAll('.dim-label, .status, .help-label')) ro.observe(el);
  new MutationObserver(run).observe(pageEl, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', run);
  setTimeout(run, 0);
  return run;
}
