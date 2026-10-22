// 在真正跑起来的 exe 里验证视频转 GIF 的完整链路。
// 浏览器（localhost:8899）跑的是 blob URL，测不到 asset:// 这条路：跨源会把 canvas 污染，
// getImageData 直接抛 SecurityError，所以 <video> 必须带 crossorigin="anonymous"。这一步不能省。
//
// 用法：
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" src-tauri/target/debug/tauri-app.exe &
//   node test/exe-cdp-check.mjs [视频绝对路径]
// 期望素材由 test/gen-video.py 生成：64x48、8fps、2s，左半灰度 16+8i，右半 (200,60,60)。
const PORT = process.env.CDP_PORT || 9222;
const VIDEO = process.argv[2] || 'F:\\Tauri\\texture-studio\\test\\vid_test.mp4';

// 页面里跑的两段：A 验 asset 协议解码层，B 在 exe 里验「抽帧 → 自带编码器 → 真解码器闭环」
// （页面 UI 那条路在 Chrome 里用 localhost:8899 验；Tauri 的 JS emit 不会回环给同 webview 的
//  listener，所以没法从脚本里伪造原生拖放事件）
const PHASE_A = `
(async () => {
  const src = ${JSON.stringify(VIDEO)};
  const out = {};
  if (!window.__TAURI__?.core) return { fail: '没有 __TAURI__ 全局 API' };
  const url = window.__TAURI__.core.convertFileSrc(src);
  out.urlHead = url.split('/')[0] + '//' + url.split('/')[2];
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.muted = true;
  v.preload = 'auto';
  v.style.cssText = 'position:absolute;left:-9999px;width:320px;height:180px';
  document.body.appendChild(v);
  const wait = (name, ms) => new Promise((res, rej) => {
    v.addEventListener(name, res, { once: true });
    setTimeout(() => rej(new Error(name + ' 超时')), ms);
  });
  v.src = url;
  try {
    await wait('loadedmetadata', 8000);
  } catch (e) {
    out.fail = e.message + ' / video.error.code=' + (v.error?.code ?? '无');
    v.remove();
    return out;
  }
  out.w = v.videoWidth;
  out.h = v.videoHeight;
  out.duration = +v.duration.toFixed(3);
  const seek = (t) => new Promise((res) => {
    v.addEventListener('seeked', res, { once: true });
    setTimeout(res, 8000);
    v.currentTime = t;
  });
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  const g = c.getContext('2d');
  // seek 之后必须重画再读，否则拿到的是上一帧
  const grab = () => {
    g.drawImage(v, 0, 0);
    const px = (x0, y0, x1, y1) => {
      const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      const s = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
      const n = d.length / 4;
      return s.map((x) => Math.round(x / n));
    };
    return { left: px(4, 4, 28, 44), right: px(36, 4, 60, 44) };
  };
  const at = async (t) => {
    await seek(t);
    return grab();
  };
  out.t1500 = await at(1.5);
  out.t0125 = await at(0.125);
  out.t0625 = await at(0.625);
  v.remove();
  return out;
})()
`;

const PHASE_B = `
(async () => {
  const src = ${JSON.stringify(VIDEO)};
  const url = window.__TAURI__.core.convertFileSrc(src);
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.muted = true;
  v.preload = 'auto';
  v.style.cssText = 'position:absolute;left:-9999px;width:320px;height:180px';
  document.body.appendChild(v);
  await new Promise((res, rej) => {
    v.addEventListener('loadedmetadata', res, { once: true });
    setTimeout(() => rej(new Error('metadata 超时')), 8000);
    v.src = url;
  });
  const seek = (t) => new Promise((res) => {
    v.addEventListener('seeked', res, { once: true });
    setTimeout(res, 8000);
    v.currentTime = t;
  });
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  const gif = await import('/js/gif.js');
  const out = { runs: [] };
  for (const t of [0.125, 0.625, 1.5]) {
    await seek(t);
    g.drawImage(v, 0, 0);
    const img = g.getImageData(0, 0, c.width, c.height);
    const bytes = gif.encodeGif(
      [{ width: c.width, height: c.height, data: img.data }],
      { delay: 10, loop: 0, colors: 256, quality: 'normal' }
    );
    // 闭环用 WebView2 自己的 GIF 解码器，不用项目里自己写的解码器
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/gif' }));
    const c2 = document.createElement('canvas');
    c2.width = bmp.width;
    c2.height = bmp.height;
    const g2 = c2.getContext('2d', { willReadFrequently: true });
    g2.drawImage(bmp, 0, 0);
    const d = g2.getImageData(0, 0, bmp.width, bmp.height).data;
    const at = (x, y) => {
      const i = (y * bmp.width + x) * 4;
      return [d[i], d[i + 1], d[i + 2], d[i + 3]];
    };
    out.runs.push({ t, bytes: bytes.length, size: [bmp.width, bmp.height], left: at(10, 20), right: at(50, 20) });
    if (bmp.close) bmp.close();
  }
  v.remove();
  return out;
})()
`;

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没找到页面 target，exe 起来了吗？');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP 连不上'));
  });
  let id = 0;
  const pend = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pend.has(msg.id)) {
      pend.get(msg.id)(msg);
      pend.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const n = ++id;
      pend.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Runtime.enable');
  const evaluate = async (expression) => {
    const msg = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const inner = msg.result ?? msg;
    if (inner.exceptionDetails) {
      throw new Error(inner.exceptionDetails.exception?.description || '页面里抛异常');
    }
    return inner.result?.value;
  };
  return { ws, evaluate };
}

// 左半灰度 = 16 + 8 * floor(t*8)
const grayAt = (t) => 16 + 8 * Math.min(15, Math.floor(t * 8));

async function main() {
  const { ws, evaluate } = await connect();
  const a = await evaluate(PHASE_A);
  console.log('— A 协议层 —');
  console.log(JSON.stringify(a, null, 1));
  const near = (x, y) => Math.abs(x - y) <= 8;
  const okA =
    a.w === 64 &&
    a.h === 48 &&
    Math.abs(a.duration - 2) < 0.05 &&
    near(a.t1500?.left?.[0], grayAt(1.5)) &&
    near(a.t1500?.right?.[0], 199) &&
    near(a.t0125?.left?.[0], grayAt(0.125)) &&
    near(a.t0625?.left?.[0], grayAt(0.625));

  const b = await evaluate(PHASE_B);
  console.log('— B 抽帧 + 自带编码器 + 真解码器闭环 —');
  console.log(JSON.stringify(b, null, 1));
  ws.close();
  // 三个采样时间对应的左半灰度
  const expectGray = [24, 56, 112];
  const okB =
    b.runs?.length === 3 &&
    b.runs.every(
      (r, i) =>
        r.size[0] === 64 &&
        r.size[1] === 48 &&
        near(r.left[0], expectGray[i]) &&
        Math.abs(r.left[1] - r.left[0]) <= 4 &&
        near(r.right[0], 199) &&
        Math.abs(r.right[1] - 60) <= 8 &&
        r.left[3] === 255
    );
  console.log('A 协议层：' + (okA ? '通过' : '不通过'));
  console.log('B 编码器闭环：' + (okB ? '通过' : '不通过'));
  process.exit(okA && okB ? 0 : 1);
}

main().catch((e) => {
  console.log('失败：' + e.message);
  process.exit(1);
});
