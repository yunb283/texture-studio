// 高位深线性浮点（HDR/RGBE、OpenEXR）量化到 8 位。
// 规则与 ffmpeg 的 float -> rgb24/rgba 输出逐点核对过（test/probe-exr8.py）：
//   - 每个通道独立地线性裁剪到 [0,1] 后 ×255，不做 gamma、色彩空间转换或拉伸；
//     >1 与负值直接钳掉（ffmpeg 侧 4.0 -> 255、-0.25 -> 0）
//   - alpha 与 RGB 用同一套裁剪，且「按最大值拉伸」不参与 alpha（ffmpeg 侧 A=2.0 -> 255、A=0.5 -> 128）
//   - 舍入口径是 Uint8ClampedArray 的 round-half-up；ffmpeg 的 swscale 带误差扩散抖动，
//     两者允许 ±1（见 hdr-test.mjs / exr-test.mjs 的容差）
//   - 单通道 Y（灰度）按 ILM 与 three.js 的口径直接复制到 R=G=B、A=1；ffmpeg 会把这条路
//     径做 limited-range 扩展（0.2 -> 41），因此灰度素材不与 ffmpeg 对齐
export function quantizeFloat(img, stretch) {
  const { width: w, height: h, data, channels } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  // 输入是 0..1 口径的线性浮点，默认就是 ×255；「按最大值拉伸」把它换成 255/最大值
  let scale = 255;
  if (stretch) {
    let max = 0;
    for (let i = 0; i < data.length; i += channels) {
      for (let k = 0; k < 3; k++) {
        const v = data[i + k];
        if (Number.isFinite(v) && v > max) max = v;
      }
    }
    // 全黑或全非有限的图不拉伸，否则 scale 会变成 Infinity 或 0
    if (max > 0) scale = 255 / max;
  }
  for (let p = 0, i = 0; i < data.length; i += channels, p += 4) {
    out[p] = data[i] * scale;
    out[p + 1] = data[i + 1] * scale;
    out[p + 2] = data[i + 2] * scale;
    out[p + 3] = channels === 4 ? data[i + 3] * 255 : 255;
  }
  return out;
}
