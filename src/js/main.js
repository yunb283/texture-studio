import { CanvasView } from './view.js';
import { initSplit } from './split.js';
import { initMerge } from './merge.js';
import { initConvert } from './convert.js';
import { initNormal } from './normal-page.js';
import { initSeamless } from './seamless-page.js';
import { initGif } from './gif-page.js';
import {
  onGlobalDrop,
  isSupportedName,
  isTauri,
  CONVERT_EXTS,
  TEXTURE_EXTS,
  GIF_SOURCE_EXTS,
} from './platform.js';

// 窗口在配置里是 visible:false，为的是别让用户看见启动时的白屏。
// 模块脚本要等 HTML 解析完、样式表到位才执行，这时显示就是「一打开就有界面」。
if (isTauri) {
  const win = window.__TAURI__.window.getCurrentWindow();
  win
    .show()
    .then(() => win.setFocus())
    .catch(() => {});
}

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

const tabSplit = document.getElementById('tab-split');
const tabMerge = document.getElementById('tab-merge');
const tabConvert = document.getElementById('tab-convert');
const tabNormal = document.getElementById('tab-normal');
const tabSeamless = document.getElementById('tab-seamless');
const tabGif = document.getElementById('tab-gif');
const pageSplit = document.getElementById('page-split');
const pageMerge = document.getElementById('page-merge');
const pageConvert = document.getElementById('page-convert');
const pageNormal = document.getElementById('page-normal');
const pageSeamless = document.getElementById('page-seamless');
const pageGif = document.getElementById('page-gif');

const srcView = new CanvasView(document.getElementById('src-canvas'), {
  clickable: true,
  bgMode: 3,
});
const frameView = new CanvasView(document.getElementById('frame-canvas'), { bgMode: 2 });
const mergeView = new CanvasView(document.getElementById('merge-canvas'), {
  bgMode: 2,
  gridColor: 'rgba(77,217,255,0.9)',
  hlColor: '#FFD926',
});
const convView = new CanvasView(document.getElementById('conv-canvas'), { bgMode: 2 });
const nrmSrcView = new CanvasView(document.getElementById('nrm-src-canvas'), { bgMode: 2 });
const nrmOutView = new CanvasView(document.getElementById('nrm-out-canvas'), { bgMode: 2 });
const smlSrcView = new CanvasView(document.getElementById('sml-src-canvas'), { bgMode: 2 });
const smlOutView = new CanvasView(document.getElementById('sml-out-canvas'), { bgMode: 2 });
const gifSrcView = new CanvasView(document.getElementById('gif-src-canvas'), {
  bgMode: 2,
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
makeCssBgButtons(
  document.getElementById('gif-prev-bg'),
  document.getElementById('gif-prev-wrap'),
  [0, 1, 2],
  2
);

const splitApi = initSplit({ srcView, frameView });
const mergeApi = initMerge({ mergeView });
const convApi = initConvert({ view: convView });
const nrmApi = initNormal({ srcView: nrmSrcView, outView: nrmOutView });
const smlApi = initSeamless({ srcView: smlSrcView, outView: smlOutView });
const gifApi = initGif({ srcView: gifSrcView });

// 状态行只显示两行（超出省略号），完整文字挂到 title 上，鼠标悬停看全文
for (const el of document.querySelectorAll('.status')) {
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
];

function showTab(which) {
  let active = tabs[0];
  for (const t of tabs) {
    const on = t[0] === which;
    t[1].classList.toggle('active', on);
    t[2].classList.toggle('hidden', !on);
    if (on) active = t;
  }
  requestAnimationFrame(() => active[3].forEach((v) => v.redraw()));
}

tabSplit.addEventListener('click', () => showTab('split'));
tabMerge.addEventListener('click', () => showTab('merge'));
tabConvert.addEventListener('click', () => showTab('convert'));
tabNormal.addEventListener('click', () => showTab('normal'));
tabSeamless.addEventListener('click', () => showTab('seamless'));
tabGif.addEventListener('click', () => showTab('gif'));

// 总在最前：默认关闭，按下启用（浏览器里没有窗口，直接隐藏）
const pinBtn = document.getElementById('pin-top');
if (!isTauri) {
  pinBtn.style.display = 'none';
} else {
  pinBtn.addEventListener('click', () => {
    const on = !pinBtn.classList.contains('on');
    pinBtn.classList.toggle('on', on);
    pinBtn.setAttribute('aria-pressed', String(on));
    window.__TAURI__.window.getCurrentWindow().setAlwaysOnTop(on);
  });
}

onGlobalDrop((entries) => {
  // 三个贴图/动画处理页各有一份白名单，谁在前台就交给谁（白名单外也递过去，由页面给提示）
  for (const [pageEl, api, exts] of [
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

showTab('split');
