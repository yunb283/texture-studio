// 顶部 chrome 的微交互工具:页签指示块滑动、点击涟漪、图标弹出 / 旋转。
//
// 统一约束:只碰 transform / opacity(外加 background-color 这类纯重绘),
// 绝不用 width / top / left / margin 做动画 —— 那些会触发 layout,
// 而这个 App 的主线程还要跑 Canvas 重绘和 Rust 侧的 ffmpeg 命令。

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

export function prefersReduced() {
  return reduced.matches;
}

// 把「药丸」挪到 target 上:位置写进 CSS 变量,由那里的 transition 补间。
// 读的是整数 px,一次读齐,不在 rAF 里反复量,避免布局抖动
export function placePill(pill, target) {
  if (!pill || !target) return;
  pill.style.setProperty('--x', `${target.offsetLeft}px`);
  pill.style.setProperty('--y', `${target.offsetTop}px`);
  pill.style.setProperty('--w', `${target.offsetWidth}px`);
  pill.style.height = `${target.offsetHeight}px`;
}

// 重新触发一次性动画:先摘类、强制回流、再加回去
export function popOnce(el, cls) {
  if (!el || reduced.matches) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// 点击涟漪:从落点扩散。键盘触发没有坐标时退化为中心扩散。
// 元素本身需要 position 不为 static 且能裁掉溢出(页签 / 换肤钮是 overflow:hidden,
// 置顶钮因为 tooltip 画在按钮外不能裁,内部放了一层圆形的 .ripple-clip)
export function ripple(el, ev) {
  if (!el || reduced.matches) return;
  const host = el.querySelector('.ripple-clip') || el;
  const box = host.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const size = Math.max(box.width, box.height) * 2.2;
  const px = ev && ev.clientX ? ev.clientX - box.left : box.width / 2;
  const py = ev && ev.clientY ? ev.clientY - box.top : box.height / 2;
  const dot = document.createElement('span');
  dot.className = 'ripple';
  dot.style.width = `${size}px`;
  dot.style.height = `${size}px`;
  dot.style.left = `${px - size / 2}px`;
  dot.style.top = `${py - size / 2}px`;
  host.appendChild(dot);
  dot.addEventListener('animationend', () => dot.remove(), { once: true });
}
