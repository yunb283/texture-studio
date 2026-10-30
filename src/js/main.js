import { CanvasView } from './view.js';
import { makeZoomPan } from './zoom-pan.js';
import { initSplit } from './split.js';
import { initMerge } from './merge.js';
import { initConvert } from './convert.js';
import { initNormal } from './normal-page.js';
import { initSeamless } from './seamless-page.js';
import { initGif } from './gif-page.js';
import { initGifView } from './gif-view-page.js';
import { initVideoConvert } from './video-convert-page.js';
import { initAudioConvert } from './audio-convert-page.js';
import { initVideoDownload } from './video-download-page.js';
import { initSysInfo } from './sysinfo-page.js';
import { initShutdown } from './shutdown-page.js';
import { initFlipClock } from './clock-page.js';
import {
  onGlobalDrop,
  isSupportedName,
  isTauri,
  CONVERT_EXTS,
  TEXTURE_EXTS,
  GIF_SOURCE_EXTS,
  GIF_ONLY_EXTS,
  VIDEO_EXTS,
} from './platform.js';
import { ripple, placePill, popOnce, prefersReduced } from './ui-motion.js';

function makeBgButtons(container, view, modes, current) {
  const names = ['黑', '亮', '棋盘格', '暗'];
  container.innerHTML = '';
  const btns = {};
  for (const m of modes) {
    const b = document.createElement('button');
    b.className = 'bg-btn' + (m === current ? ' checked' : '');
    b.title = names[m];
    const s = document.createElement('span');
    s.className = 'bg-swatch ' + ['black', 'light', 'checker', 'dark'][m];
    b.appendChild(s);
    b.addEventListener('click', () => {
      view.bgMode = m;
      for (const x of Object.values(btns)) x.classList.remove('checked');
      b.classList.add('checked');
      view.redraw();
    });
    btns[m] = b;
    container.appendChild(b);
  }
}

// 预览窗是 <img>/CSS 底色，不是 CanvasView，这里只切 class
function makeCssBgButtons(container, el, modes, current) {
  const names = ['黑', '亮', '棋盘格', '暗'];
  const cls = ['bg-black', 'bg-light', 'bg-checker', 'bg-dark'];
  const apply = (m) => {
    el.classList.remove(...cls);
    el.classList.add(cls[m]);
  };
  container.innerHTML = '';
  apply(current);
  const btns = {};
  for (const m of modes) {
    const b = document.createElement('button');
    b.className = 'bg-btn' + (m === current ? ' checked' : '');
    b.title = names[m];
    const s = document.createElement('span');
    s.className = 'bg-swatch ' + ['black', 'light', 'checker', 'dark'][m];
    b.appendChild(s);
    b.addEventListener('click', () => {
      apply(m);
      for (const x of Object.values(btns)) x.classList.remove('checked');
      b.classList.add('checked');
    });
    btns[m] = b;
    container.appendChild(b);
  }
}

// 右侧预览的视图工具，插在它那排背景色块的左边
function makeViewTools(bgContainer, api) {
  const box = document.createElement('div');
  box.className = 'view-tools';
  const mk = (label, title, fn) => {
    const b = document.createElement('button');
    b.className = 'view-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', fn);
    box.appendChild(b);
  };
  mk('重置位置', '平移归零，保留当前缩放', () => api.resetPan());
  mk('100%', '一个图像像素对一个屏幕像素', () => api.zoomActual());
  mk('适配窗口', '整张图铺满窗口并归位', () => api.fitWindow());
  bgContainer.parentNode.insertBefore(box, bgContainer);
}

const tabSplit = document.getElementById('tab-split');
const tabMerge = document.getElementById('tab-merge');
const tabConvert = document.getElementById('tab-convert');
const tabNormal = document.getElementById('tab-normal');
const tabSeamless = document.getElementById('tab-seamless');
const tabGif = document.getElementById('tab-gif');
const tabGifView = document.getElementById('tab-gifview');
const tabVideo = document.getElementById('tab-video');
const tabAudio = document.getElementById('tab-audio');
const tabDl = document.getElementById('tab-dl');
const tabClock = document.getElementById('tab-clock');
const tabRename = document.getElementById('tab-rename');
const tabSysInfo = document.getElementById('tab-sysinfo');
const tabShutdown = document.getElementById('tab-shutdown');
const pageSplit = document.getElementById('page-split');
const pageMerge = document.getElementById('page-merge');
const pageConvert = document.getElementById('page-convert');
const pageNormal = document.getElementById('page-normal');
const pageSeamless = document.getElementById('page-seamless');
const pageGif = document.getElementById('page-gif');
const pageGifView = document.getElementById('page-gifview');
const pageVideo = document.getElementById('page-video');
const pageAudio = document.getElementById('page-audio');
const pageDl = document.getElementById('page-dl');
const pageClock = document.getElementById('page-clock');
const pageRename = document.getElementById('page-rename');
const pageSysInfo = document.getElementById('page-sysinfo');
const pageShutdown = document.getElementById('page-shutdown');

const srcView = new CanvasView(document.getElementById('src-canvas'), {
  clickable: true,
  bgMode: 3,
});
const frameView = new CanvasView(document.getElementById('frame-canvas'), {
  bgMode: 2,
  zoomable: true,
});
const mergeView = new CanvasView(document.getElementById('merge-canvas'), {
  bgMode: 2,
  gridColor: 'rgba(77,217,255,0.9)',
  hlColor: '#FFD926',
  zoomable: true,
});
const convView = new CanvasView(document.getElementById('conv-canvas'), {
  bgMode: 2,
  zoomable: true,
});
const nrmSrcView = new CanvasView(document.getElementById('nrm-src-canvas'), { bgMode: 2 });
const nrmOutView = new CanvasView(document.getElementById('nrm-out-canvas'), {
  bgMode: 2,
  zoomable: true,
});
const smlSrcView = new CanvasView(document.getElementById('sml-src-canvas'), { bgMode: 2 });
const smlOutView = new CanvasView(document.getElementById('sml-out-canvas'), {
  bgMode: 2,
  zoomable: true,
});
const gifSrcView = new CanvasView(document.getElementById('gif-src-canvas'), {
  bgMode: 2,
  selectable: true,
});
// GIF 动画预览：整幅画面就这一张 canvas，播放/暂停/拖动都在这里。
// selectable 只是注册框选，默认关着（页面里 setSelectEnabled），进裁剪模式才接管左键
const gvView = new CanvasView(document.getElementById('gv-canvas'), {
  bgMode: 2,
  zoomable: true,
  selectable: true,
});

makeBgButtons(document.getElementById('src-bg'), srcView, [0, 1, 2, 3], 3);
makeBgButtons(document.getElementById('split-prev-bg'), frameView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('merge-prev-bg'), mergeView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('conv-prev-bg'), convView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('nrm-src-bg'), nrmSrcView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('nrm-out-bg'), nrmOutView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('sml-src-bg'), smlSrcView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('sml-out-bg'), smlOutView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('gif-src-bg'), gifSrcView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('gv-prev-bg'), gvView, [0, 1, 2], 2);
makeCssBgButtons(
  document.getElementById('gif-prev-bg'),
  document.getElementById('gif-prev-wrap'),
  [0, 1, 2],
  2
);

// GIF 结果预览只有一张 canvas（播放和逐帧都画它），缩放平移只能走 CSS 变量
const gifWrap = document.getElementById('gif-prev-wrap');
const gifFrame = document.getElementById('gif-frame');
const gifZp = makeZoomPan(
  gifWrap,
  () => {
    // 隐藏时 canvas 还是默认的 300x150 空位，不能拿它当图像尺寸
    const nw = gifFrame.hidden ? 0 : gifFrame.width;
    const nh = gifFrame.hidden ? 0 : gifFrame.height;
    const boxW = gifWrap.clientWidth;
    const boxH = gifWrap.clientHeight;
    // object-fit: scale-down 的「适配」只缩不放，基准倍率封顶 1
    return { boxW, boxH, s0: nw && nh && boxW && boxH ? Math.min(1, boxW / nw, boxH / nh) : 0 };
  },
  (st) => {
    gifWrap.style.setProperty('--zz', String(st.zoom));
    gifWrap.style.setProperty('--zpx', `${st.panX}px`);
    gifWrap.style.setProperty('--zpy', `${st.panY}px`);
  }
);

makeViewTools(document.getElementById('split-prev-bg'), frameView);
makeViewTools(document.getElementById('merge-prev-bg'), mergeView);
makeViewTools(document.getElementById('conv-prev-bg'), convView);
makeViewTools(document.getElementById('nrm-out-bg'), nrmOutView);
makeViewTools(document.getElementById('sml-out-bg'), smlOutView);
makeViewTools(document.getElementById('gif-prev-bg'), gifZp);
makeViewTools(document.getElementById('gv-prev-bg'), gvView);

const splitApi = initSplit({ srcView, frameView });
const mergeApi = initMerge({ mergeView });
const convApi = initConvert({ view: convView });
const nrmApi = initNormal({ srcView: nrmSrcView, outView: nrmOutView });
const smlApi = initSeamless({ srcView: smlSrcView, outView: smlOutView });
const gifApi = initGif({ srcView: gifSrcView });
const gvApi = initGifView({ view: gvView });
const videoApi = initVideoConvert();
const audioApi = initAudioConvert();
const dlApi = initVideoDownload();
initSysInfo();
const shutdownApi = initShutdown();
initFlipClock();

// 两行封顶的那几行（各页状态行、GIF 页信息行）只显示两行，超出省略号；
// 完整文字挂到 title 上，鼠标悬停看全文
for (const el of document.querySelectorAll('.status, #gif-info')) {
  const sync = () => {
    el.title = el.textContent || '';
  };
  new MutationObserver(sync).observe(el, { childList: true, characterData: true, subtree: true });
  sync();
}

const tabs = [
  ['split', tabSplit, pageSplit, [srcView, frameView]],
  ['merge', tabMerge, pageMerge, [mergeView]],
  ['convert', tabConvert, pageConvert, [convView]],
  ['normal', tabNormal, pageNormal, [nrmSrcView, nrmOutView]],
  ['seamless', tabSeamless, pageSeamless, [smlSrcView, smlOutView]],
  ['gif', tabGif, pageGif, [gifSrcView]],
  ['gifview', tabGifView, pageGifView, [gvView]],
  ['video', tabVideo, pageVideo, []],
  ['audio', tabAudio, pageAudio, []],
  ['dl', tabDl, pageDl, []],
  ['clock', tabClock, pageClock, []],
  ['rename', tabRename, pageRename, []],
  ['sysinfo', tabSysInfo, pageSysInfo, []],
  ['shutdown', tabShutdown, pageShutdown, []],
];

// 页签行的两块「药丸」:.tab-ind 标当前页签,.tab-hover 跟手做悬停底色
const tabsRow = document.querySelector('.tabs');
const tabInd = document.getElementById('tab-ind');
const tabHover = document.getElementById('tab-hover');

// 指示块跟着当前页签走。位置一次性读成整数 px,剩下的补间交给 CSS
function syncTabIndicator() {
  const el = tabsRow && tabsRow.querySelector('.tab.active');
  if (!el) return;
  placePill(tabInd, el);
  tabInd.classList.add('on');
  // 只有真的一排放不下，才把光标提示成「可以拖着走」；宽窗口下别乱指
  tabsRow.classList.toggle('scrollable', tabsRow.scrollWidth - tabsRow.clientWidth >= 1);
}

function showTab(which) {
  // 跳到被工具列表收起来的页签（比如关窗被拦下后跳自动关机），先把它放回来，
  // 否则切过去只有一页内容、行上却找不到对应的页签
  unhideTab(which);
  let active = tabs[0];
  for (const t of tabs) {
    const on = t[0] === which;
    t[1].classList.toggle('active', on);
    t[2].classList.toggle('hidden', !on);
    if (on) active = t;
  }
  // 窄窗口下页签一排放不下，被程序切过去的那一页（比如关窗拦截跳到自动关机）可能在可视范围外
  active[1].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  syncTabIndicator();
  requestAnimationFrame(() => active[3].forEach((v) => v.redraw()));
}

tabSplit.addEventListener('click', () => showTab('split'));
tabMerge.addEventListener('click', () => showTab('merge'));
tabConvert.addEventListener('click', () => showTab('convert'));
tabNormal.addEventListener('click', () => showTab('normal'));
tabSeamless.addEventListener('click', () => showTab('seamless'));
tabGif.addEventListener('click', () => showTab('gif'));
tabGifView.addEventListener('click', () => showTab('gifview'));
tabVideo.addEventListener('click', () => showTab('video'));
tabAudio.addEventListener('click', () => showTab('audio'));
tabDl.addEventListener('click', () => showTab('dl'));
tabClock.addEventListener('click', () => showTab('clock'));
tabRename.addEventListener('click', () => showTab('rename'));
tabSysInfo.addEventListener('click', () => showTab('sysinfo'));
tabShutdown.addEventListener('click', () => showTab('shutdown'));

// 页签微交互:悬停时半透明块跟手、点击出涟漪、按下回弹(回弹在 CSS 的 :active 里)
for (const [, tabEl] of tabs) {
  tabEl.addEventListener('mouseenter', () => {
    // 当前页签已经有 .tab-ind 打底了,别再叠一层悬停块
    if (tabEl.classList.contains('active')) {
      tabHover.classList.remove('on');
      return;
    }
    placePill(tabHover, tabEl);
    tabHover.classList.add('on');
  });
  tabEl.addEventListener('click', (ev) => ripple(tabEl, ev));
}
tabsRow.addEventListener('mouseleave', () => tabHover.classList.remove('on'));

// 滚轮落到页签行时当横向滑动用（行的纵向溢出被 overflow-y:hidden 关掉了）
tabsRow.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey || !e.deltaY) return;
    tabsRow.scrollLeft += e.deltaY;
  },
  { passive: true }
);

// 左键按住页签行：横向拖 = 滚动看后面的页签，竖向拖 = 把这一页抓起来换位置。
// 一次按下只认一个手势：先动到哪个方向（超过 DRAG_BREAK）就定下来，中途不再改主意。
// 这里不用 setPointerCapture：capture 一旦设在这行上，浏览器会把 click 也派发到这行，
// 页签就再也收不到点击（窄窗口下等于点不动页签）；改成拖动期间临时挂到 window 上监听
const ORDER_KEY = 'tabOrder';
const DRAG_BREAK = 6;
let drag = null;

function readTabOrder() {
  try {
    const arr = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
    // 只认现在还在的页签名：以后加新工具，它排到最后，不会因为旧记录找不到而错位
    return Array.isArray(arr) ? arr.filter((n) => tabs.some((t) => t[0] === n)) : [];
  } catch (e) {
    return [];
  }
}

function saveTabOrder() {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(tabs.map((t) => t[0])));
  } catch (e) {
    // 写不进去就算了，顺序丢一次不影响功能
  }
}

// 数组跟着 DOM 重排：工具列表、启动落点、showTab 都按这个顺序说话
function sortTabsByDom() {
  tabs.sort((a, b) => (a[1].compareDocumentPosition(b[1]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

function applyTabOrder() {
  const saved = readTabOrder();
  const seq = saved.map((n) => tabs.find((t) => t[0] === n));
  for (const t of tabs) if (!saved.includes(t[0])) seq.push(t);
  for (const t of seq) tabsRow.appendChild(t[1]);
  sortTabsByDom();
}

function reorderUnder(x) {
  const grabbed = drag.tab;
  let ref = null;
  for (const s of tabsRow.querySelectorAll('.tab')) {
    if (s === grabbed || s.hidden) continue;
    const b = s.getBoundingClientRect();
    if (x < b.left + b.width / 2) {
      ref = s;
      break;
    }
  }
  if (ref) {
    if (grabbed.nextElementSibling !== ref) tabsRow.insertBefore(grabbed, ref);
  } else if (grabbed !== tabsRow.lastElementChild) tabsRow.appendChild(grabbed);
  syncTabIndicator();
}

// 抓着一页拖到行的两端时，行自己往那边挪一点：不然窄窗口下永远拖不到最前面
function autoScrollAt(x) {
  const b = tabsRow.getBoundingClientRect();
  const edge = 34;
  if (x < b.left + edge) tabsRow.scrollLeft -= 12;
  else if (x > b.right - edge) tabsRow.scrollLeft += 12;
}

function onTabDragMove(e) {
  if (!drag) return;
  // 手已经离开窗口、按键在别处松掉这一轮时，e.buttons 会是 0：当作松手收尾，别把 grabbing 卡住
  if (e.buttons === 0) return endTabDrag();
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.kind) {
    if (drag.tab && Math.abs(dy) >= DRAG_BREAK && Math.abs(dy) > Math.abs(dx)) drag.kind = 'reorder';
    else if (drag.canScroll && Math.abs(dx) >= DRAG_BREAK) drag.kind = 'scroll';
    else return;
    drag.moved = true;
    tabsRow.classList.add(drag.kind === 'reorder' ? 'reordering' : 'dragging');
    if (drag.kind === 'reorder') drag.tab.classList.add('grabbed');
  }
  if (drag.kind === 'scroll') {
    tabsRow.scrollLeft = drag.left - dx;
    return;
  }
  reorderUnder(e.clientX);
  autoScrollAt(e.clientX);
}

function endTabDrag() {
  drag && window.removeEventListener('pointermove', onTabDragMove);
  window.removeEventListener('pointerup', endTabDrag);
  window.removeEventListener('pointercancel', endTabDrag);
  tabsRow.classList.remove('dragging');
  if (drag && drag.kind === 'reorder') {
    tabsRow.classList.remove('reordering');
    drag.tab.classList.remove('grabbed');
    sortTabsByDom();
    saveTabOrder();
    syncTabIndicator();
  }
}

tabsRow.addEventListener('pointerdown', (e) => {
  // 每按下一次都重新记一轮：上一轮的 moved 标记不能一直管着后面的点击
  drag = null;
  if (e.button !== 0) return;
  drag = {
    x: e.clientX,
    y: e.clientY,
    left: tabsRow.scrollLeft,
    tab: e.target instanceof Element ? e.target.closest('.tab') : null,
    canScroll: tabsRow.scrollWidth - tabsRow.clientWidth >= 1,
    kind: null,
    moved: false,
  };
  window.addEventListener('pointermove', onTabDragMove);
  window.addEventListener('pointerup', endTabDrag);
  window.addEventListener('pointercancel', endTabDrag);
});
// 松手补发的那次 click 会被浏览器当成「点了某个页签」，拖过就别让它冒到页签上
tabsRow.addEventListener(
  'click',
  (e) => {
    if (!drag || !drag.moved) return;
    e.stopPropagation();
    e.preventDefault();
  },
  true
);

applyTabOrder();

// ===== 工具列表：手动隐藏 / 显示页签 =====
// 只在页签行上做显示与否，持久化到本地；各页自己的功能、状态都不碰
const tlBtn = document.getElementById('tool-list');
const tlPop = document.getElementById('tool-list-pop');
const tlList = document.getElementById('tlist-list');
const tlNote = document.getElementById('tlist-note');
const tlShowAll = document.getElementById('tlist-show-all');
const TL_KEY = 'hiddenTabs';
const hiddenTabs = new Set(readHiddenTabs());

function readHiddenTabs() {
  try {
    const arr = JSON.parse(localStorage.getItem(TL_KEY) || '[]');
    // 只认现在还在的页签名：以后改名或删工具，旧记录自然失效
    return Array.isArray(arr) ? arr.filter((n) => tabs.some((t) => t[0] === n)) : [];
  } catch (e) {
    return [];
  }
}

function saveHiddenTabs() {
  try {
    localStorage.setItem(TL_KEY, JSON.stringify([...hiddenTabs]));
  } catch (e) {
    // 隐私模式之类写不进去就算了，别拦住页签切换
  }
}

function setTlNote(msg) {
  tlNote.textContent = msg || '';
}

function applyHiddenTabs() {
  for (const [name, tabEl] of tabs) tabEl.hidden = hiddenTabs.has(name);
  const active = tabsRow.querySelector('.tab.active');
  if (active && active.hidden) {
    const next = tabs.find((t) => !t[1].hidden);
    showTab(next[0]);
    setTlNote(`当前页已隐藏，切到「${next[1].textContent}」`);
  } else {
    syncTabIndicator();
  }
}

function unhideTab(name) {
  if (!hiddenTabs.has(name)) return;
  hiddenTabs.delete(name);
  saveHiddenTabs();
  applyHiddenTabs();
}

// 面板每次展开都照当前状态重建，省掉「勾了一个要回头同步另一处」的簿记
function buildTlList() {
  tlList.innerHTML = '';
  for (const [name, tabEl] of tabs) {
    const row = document.createElement('label');
    row.className = 'tlist-item';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !hiddenTabs.has(name);
    box.addEventListener('change', () => {
      if (!box.checked && tabs.length - hiddenTabs.size <= 1) {
        // 全关掉等于把应用关成空白页：拦下来说明原因，不替他改别的页签
        box.checked = true;
        setTlNote('至少要留一个显示的页签');
        return;
      }
      setTlNote('');
      if (box.checked) hiddenTabs.delete(name);
      else hiddenTabs.add(name);
      saveHiddenTabs();
      applyHiddenTabs();
    });
    const label = document.createElement('span');
    label.textContent = tabEl.textContent;
    row.append(box, label);
    tlList.appendChild(row);
  }
}

function openTl(open) {
  tlPop.hidden = !open;
  tlBtn.classList.toggle('on', open);
  tlBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    buildTlList();
    setTlNote('');
  }
}

tlBtn.addEventListener('click', () => openTl(tlPop.hidden));
tlShowAll.addEventListener('click', () => {
  hiddenTabs.clear();
  saveHiddenTabs();
  setTlNote('');
  buildTlList();
  applyHiddenTabs();
});
// 点面板外的任何地方都收起它；Esc 同理
document.addEventListener('pointerdown', (e) => {
  if (tlPop.hidden) return;
  const t = e.target;
  if (t instanceof Element && t.closest('.tlist-wrap')) return;
  openTl(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !tlPop.hidden) openTl(false);
});

applyHiddenTabs();

// 窗口尺寸变了、字体加载完了都重新量一次位置
addEventListener('resize', syncTabIndicator);
new ResizeObserver(syncTabIndicator).observe(tabsRow);
if (document.fonts) document.fonts.ready.then(syncTabIndicator).catch(() => {});

// 首帧先无动画地就位,再加上 .ready 打开过渡:否则启动瞬间指示块会从左上角滑过来
requestAnimationFrame(() => {
  syncTabIndicator();
  tabsRow.classList.add('ready');
});

// 标题栏：置顶 / 最小化 / 最大化 / 关闭（浏览器预览里没有窗口，整组禁用）
const pinBtn = document.getElementById('pin-top');
const pinLine = pinBtn.querySelector('.ic-pin-line');
const pinSolid = pinBtn.querySelector('.ic-pin-solid');
const pinIcon = pinBtn.querySelector('.pin-ic');
const winMin = document.getElementById('win-min');
const winMax = document.getElementById('win-max');
const winClose = document.getElementById('win-close');
const maxIcon = winMax.querySelector('.ic-max');
const restoreIcon = winMax.querySelector('.ic-restore');
const currentWindow = isTauri ? window.__TAURI__.window.getCurrentWindow() : null;

if (!currentWindow) {
  for (const b of [pinBtn, winMin, winMax, winClose]) b.disabled = true;
} else {
  pinBtn.addEventListener('click', (ev) => {
    const on = !pinBtn.classList.contains('on');
    pinBtn.classList.toggle('on', on);
    pinBtn.setAttribute('aria-pressed', String(on));
    pinBtn.setAttribute('aria-label', on ? '取消置顶' : '窗口置顶');
    pinBtn.dataset.tip = on ? '取消置顶' : '窗口置顶';
    pinLine.toggleAttribute('hidden', on);
    pinSolid.toggleAttribute('hidden', !on);
    popOnce(pinIcon, 'pop');
    ripple(pinBtn, ev);
    currentWindow.setAlwaysOnTop(on);
  });

  winMin.addEventListener('click', () => currentWindow.minimize());
  winMax.addEventListener('click', () => currentWindow.toggleMaximize());
  // 自动关机计时中关掉窗口就等于计划作废（计时只在软件内守）。第一次点先拦下来，
  // 切到那一页把原因写在状态行，再点一次才真关 —— 免得手滑把排好的关机弄没了
  let closeBlockedAt = 0;
  winClose.addEventListener('click', () => {
    if (shutdownApi.blocksClose() && Date.now() - closeBlockedAt > 5000) {
      closeBlockedAt = Date.now();
      showTab('shutdown');
      shutdownApi.reportCloseBlocked();
      return;
    }
    currentWindow.close();
  });

  // 最大化 / 还原后换图标，拖动窗口改变尺寸时也会触发
  const syncMaxIcon = async () => {
    const maximized = await currentWindow.isMaximized();
    maxIcon.toggleAttribute('hidden', maximized);
    restoreIcon.toggleAttribute('hidden', !maximized);
    winMax.setAttribute('aria-label', maximized ? '还原' : '最大化');
    winMax.title = maximized ? '还原' : '最大化';
  };
  syncMaxIcon();
  currentWindow.onResized(() => syncMaxIcon());
}

// 浅色 / 深色主题：默认深色，选择记入 localStorage；head 内联脚本会在启动时提前恢复
const themeBtn = document.getElementById('theme-toggle');
const icMoon = themeBtn.querySelector('.ic-moon');
const icSun = themeBtn.querySelector('.ic-sun');
function swapThemeIcon(light) {
  // 注意:SVG 元素上的 .hidden IDL 属性在 WebView2 里不会可靠反映到 content attribute,
  // 必须直接切属性,[hidden]{display:none} 才能命中
  icMoon.toggleAttribute('hidden', light); // 浅色下显示太阳(点一下回深色)
  icSun.toggleAttribute('hidden', !light);
}

// syncIcon=false 时只换底色不换图标,用于「旋钮转到一半再翻面」的节奏
function applyTheme(theme, syncIcon = true) {
  const light = theme === 'light';
  document.documentElement.classList.toggle('light', light);
  themeBtn.dataset.tip = light ? '当前浅色，点击切换深色' : '当前深色，点击切换浅色';
  themeBtn.setAttribute('aria-pressed', String(light));
  // 让系统的非客户区(边框、原生对话框)也跟着换,避免浅色窗口配深色系统框
  if (currentWindow) currentWindow.setTheme(light ? 'light' : 'dark').catch(() => {});
  if (syncIcon) swapThemeIcon(light);
}
applyTheme(localStorage.getItem('theme') === 'light' ? 'light' : 'dark');

let themeIconTimer = 0;
themeBtn.addEventListener('click', (ev) => {
  const next = document.documentElement.classList.contains('light') ? 'dark' : 'light';
  localStorage.setItem('theme', next);
  popOnce(themeBtn, 'spin');
  ripple(themeBtn, ev);
  if (prefersReduced()) {
    applyTheme(next);
  } else {
    // 底色立刻跟着换,图标推迟到旋钮转到一半时再翻面,看着像同一只在转
    applyTheme(next, false);
    clearTimeout(themeIconTimer);
    themeIconTimer = setTimeout(() => swapThemeIcon(next === 'light'), 300);
  }
  // 画布上的棋盘格/底色是 JS 绘制的,通知各 CanvasView 重画
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
});

onGlobalDrop((entries) => {
  // 音频转换页优先吃音频/视频
  if (!pageAudio.classList.contains('hidden')) {
    audioApi.loadEntry(entries[0]);
    return;
  }
  // 视频转换页优先吃视频
  if (!pageVideo.classList.contains('hidden')) {
    videoApi.loadEntry(entries[0]);
    return;
  }
  // 几个动画/贴图处理页各有一份白名单，谁在前台就交给谁（白名单外也递过去，由页面给提示）
  for (const [pageEl, api, exts] of [
    [pageGifView, gvApi, GIF_ONLY_EXTS],
    [pageGif, gifApi, GIF_SOURCE_EXTS],
    [pageSeamless, smlApi, TEXTURE_EXTS],
    [pageNormal, nrmApi, TEXTURE_EXTS],
  ]) {
    if (!pageEl.classList.contains('hidden')) {
      const ok = entries.filter((e) => isSupportedName(e.name, exts));
      api.loadEntry(ok[0] || entries[0]);
      return;
    }
  }
  if (!pageConvert.classList.contains('hidden')) {
    // 白名单外的文件也交给转换页，由它给出「不支持的格式」提示
    const ok = entries.filter((e) => isSupportedName(e.name, CONVERT_EXTS));
    convApi.loadEntry(ok[0] || entries[0]);
    return;
  }
  const supported = entries.filter((e) => isSupportedName(e.name));
  if (!supported.length) return;
  if (!pageSplit.classList.contains('hidden')) {
    splitApi.loadEntry(supported[0]);
  } else {
    mergeApi.addEntries(supported);
  }
});

// WebView2 自带的那套「后退/重新加载/另存为/检查」菜单对独立工具没意义，整窗屏蔽
// 文本框里的右键粘贴一起没了，粘贴走 Ctrl+V
document.addEventListener('contextmenu', (e) => e.preventDefault());

// 回车不再二次触发当前聚焦的按钮/页签：用鼠标点过「打开图片…」之后再敲回车，
// 原来会把那个按钮再按一次。输入框里的回车是各页自己的功能（解析链接、收时间框），照旧放行。
// 浏览器快捷键（F1/F3/F5/F7、Ctrl+F/P/S/O…）在 Rust 侧整组关掉，这里只补页面这层：
// Ctrl+滚轮缩放（zoomHotkeysEnabled 之外的兜底）
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    const tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    e.preventDefault();
  },
  true
);
addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey) e.preventDefault();
  },
  { passive: false }
);

// 启动落在第一个没被工具列表收起来的页签上：被收掉的页签不该在重启时又被拉回这一行
showTab(tabs.find((t) => !hiddenTabs.has(t[0]))[0]);
