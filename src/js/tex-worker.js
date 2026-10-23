// 重算法的 worker：高度图转法线、无缝化。2048 的图算一次要 200ms~1s，放在主线程里
// 滑块就成了逐帧卡死；搬到这里，主线程只负责收最新一份结果重画。
// 图像在载入时搬进来一次（之后每次请求只传参数，省掉每帧 16MB 的拷贝）。
// normal.js / seamless.js 都是无 DOM 依赖的纯函数，浏览器和 node 测试共用同一份实现，
// 所以 worker 里的字节结果和主线程回退路径完全一致。
import { heightToNormal } from './normal.js';
import { makeSeamless, seamMetrics } from './seamless.js';

let img = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    img = m.width && m.height ? { width: m.width, height: m.height, data: new Uint8ClampedArray(m.data) } : null;
    // 载入时顺手算一次原始图的接缝指标，省得主线程再整图走一遍
    self.postMessage({ type: 'loaded', metrics: img ? seamMetrics(img) : null });
    return;
  }
  if (m.type !== 'run') return;
  if (!img) {
    self.postMessage({ type: 'error', id: m.id, message: '还没有载入图像' });
    return;
  }
  const t0 = performance.now();
  try {
    if (m.kind === 'normal') {
      const data = heightToNormal(img, m.opts);
      self.postMessage({ type: 'result', id: m.id, ms: performance.now() - t0, data }, [data.buffer]);
    } else {
      const data = makeSeamless(img, m.opts);
      const metrics = seamMetrics({ width: img.width, height: img.height, data });
      self.postMessage({ type: 'result', id: m.id, ms: performance.now() - t0, data, metrics }, [data.buffer]);
    }
  } catch (ex) {
    self.postMessage({ type: 'error', id: m.id, message: String(ex?.message ?? ex) });
  }
};
