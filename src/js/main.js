import { CanvasView } from './view.js';
import { initSplit } from './split.js';
import { initMerge } from './merge.js';
import { initConvert } from './convert.js';
import { initNormal } from './normal-page.js';
import { initSeamless } from './seamless-page.js';
import { onGlobalDrop, isSupportedName, isTauri, CONVERT_EXTS, TEXTURE_EXTS } from './platform.js';

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

const tabSplit = document.getElementById('tab-split');
const tabMerge = document.getElementById('tab-merge');
const tabConvert = document.getElementById('tab-convert');
const tabNormal = document.getElementById('tab-normal');
const tabSeamless = document.getElementById('tab-seamless');
const pageSplit = document.getElementById('page-split');
const pageMerge = document.getElementById('page-merge');
const pageConvert = document.getElementById('page-convert');
const pageNormal = document.getElementById('page-normal');
const pageSeamless = document.getElementById('page-seamless');

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

makeBgButtons(document.getElementById('src-bg'), srcView, [0, 1, 2, 3], 3);
makeBgButtons(document.getElementById('split-prev-bg'), frameView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('merge-prev-bg'), mergeView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('conv-prev-bg'), convView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('nrm-src-bg'), nrmSrcView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('nrm-out-bg'), nrmOutView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('sml-src-bg'), smlSrcView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('sml-out-bg'), smlOutView, [0, 1, 2], 2);

const splitApi = initSplit({ srcView, frameView });
const mergeApi = initMerge({ mergeView });
const convApi = initConvert({ view: convView });
const nrmApi = initNormal({ srcView: nrmSrcView, outView: nrmOutView });
const smlApi = initSeamless({ srcView: smlSrcView, outView: smlOutView });

const tabs = [
  ['split', tabSplit, pageSplit, [srcView, frameView]],
  ['merge', tabMerge, pageMerge, [mergeView]],
  ['convert', tabConvert, pageConvert, [convView]],
  ['normal', tabNormal, pageNormal, [nrmSrcView, nrmOutView]],
  ['seamless', tabSeamless, pageSeamless, [smlSrcView, smlOutView]],
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
  // 两个贴图处理页共用一份白名单，谁在前台就交给谁（白名单外也递过去，由页面给提示）
  for (const [pageEl, api] of [[pageSeamless, smlApi], [pageNormal, nrmApi]]) {
    if (!pageEl.classList.contains('hidden')) {
      const ok = entries.filter((e) => isSupportedName(e.name, TEXTURE_EXTS));
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
