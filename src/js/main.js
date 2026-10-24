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
const pageSplit = document.getElementById('page-split');
const pageMerge = document.getElementById('page-merge');
const pageConvert = document.getElementById('page-convert');
const pageNormal = document.getElementById('page-normal');
const pageSeamless = document.getElementById('page-seamless');
const pageGif = document.getElementById('page-gif');
const pageGifView = document.getElementById('page-gifview');
const pageVideo = document.getElementById('page-video');

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
tabGifView.addEventListener('click', () => showTab('gifview'));
tabVideo.addEventListener('click', () => showTab('video'));

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

showTab('split');
