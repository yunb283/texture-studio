// GIF 编码 worker：主线程先 init 一次「编码参数」（尺寸、每帧延时、是否透明、全局调色板），
// 之后每来一帧就算出那一帧的字节回传。帧与帧互不依赖，所以开几个 worker 分头算、
// 主线程按帧号拼回来，字节和单线程逐帧编码完全一致。
import { gifFrameBytes, gifTableFor } from './gif.js';

let params = null;
// 全局调色板固定时跨帧共享「5bit 桶」缓存：桶 → 最近色是纯函数，共享不改变结果，
// 只是把预热成本摊到整段动画。高质量（每帧局部调色板）是 null，按帧各建各的。
let table = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    params = m.params;
    table = gifTableFor(params);
    self.postMessage({ type: 'ready' });
    return;
  }
  if (m.type === 'frame') {
    if (!params) {
      self.postMessage({ type: 'error', index: m.index, message: 'worker 还没收到编码参数' });
      return;
    }
    try {
      const bytes = gifFrameBytes(
        params,
        { width: m.width, height: m.height, data: m.data },
        m.index,
        table
      );
      self.postMessage({ type: 'done', index: m.index, bytes }, [bytes.buffer]);
    } catch (ex) {
      self.postMessage({ type: 'error', index: m.index, message: String(ex?.message ?? ex) });
    }
  }
};
