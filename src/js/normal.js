// 高度图 / 漫反射贴图 -> 切线空间法线贴图。纯函数，浏览器和 node 测试共用同一份实现。
// 约定（与 test/gen-normal.py 的 numpy 独立实现逐字节交叉核对，见 test/normal-test.mjs）：
//   1. 高度取自 8 位 RGBA：lum=0.299R+0.587G+0.114B、avg=(R+G+B)/3、或单通道 r/g/b/a，再除以 255
//   2. 反转在取值之后做（h = 1 - h），模糊与梯度都是线性算子，所以先后顺序不影响结果
//   3. 模糊用可分离框形滤波（box blur），窗口 2r+1，横竖各一趟；r=0 表示跳过
//   4. 梯度用 3x3 Sobel，越界按 clamp（复制最近的边缘像素）：gx=∂h/∂x 向右为正，gy=∂h/∂row 向下为正
//   5. 法向 n = normalize(-S·gx, ±S·gy, 1)，S 为强度。OpenGL(Unity) 取 +gy —— 图像里凸起的顶边偏绿
//      （绿色通道朝上）；DirectX(UE) 取 -gy —— 等于把绿通道镜像
//   6. 编码 c = floor((v/2 + 1/2)·255 + 0.5)（round-half-up，与 numpy 侧同一口径）；alpha 恒 255（法线贴图不透明）
//   7. 边缘模式只有 clamp：非平铺贴图不会在接缝处出现环绕伪影；无缝平铺（wrap）暂不在本版
export const NORMAL_SOURCES = ['lum', 'avg', 'r', 'g', 'b', 'a'];

export function heightToNormal(img, opts = {}) {
  const w = img.width;
  const h = img.height;
  const data = img.data;
  const source = opts.source ?? 'lum';
  if (!NORMAL_SOURCES.includes(source)) throw new Error(`未知的高度来源：${source}`);
  const blur = Math.max(0, Math.floor(opts.blur ?? 0));
  if (blur > 4096) throw new Error(`模糊半径过大：${blur}`);
  const strength = opts.strength ?? 1;
  if (!(strength > 0) || !Number.isFinite(strength)) throw new Error(`强度必须是正有限数：${strength}`);
  const yUp = opts.yUp ?? true;
  const n = w * h;
  if (!n) throw new Error('图像为空');

  const hs = new Float64Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let v;
    switch (source) {
      case 'lum':
        v = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
        break;
      case 'avg':
        v = (data[p] + data[p + 1] + data[p + 2]) / 3;
        break;
      case 'r':
        v = data[p];
        break;
      case 'g':
        v = data[p + 1];
        break;
      case 'b':
        v = data[p + 2];
        break;
      default:
        v = data[p + 3];
        break;
    }
    v /= 255;
    hs[i] = opts.invert ? 1 - v : v;
  }
  const hh = blur > 0 ? boxBlur(hs, w, h, blur) : hs;

  const out = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : 0) * w;
    const yc = y * w;
    const yp = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < w - 1 ? x + 1 : w - 1;
      const gx = (hh[ym + xp] + 2 * hh[yc + xp] + hh[yp + xp] -
        (hh[ym + xm] + 2 * hh[yc + xm] + hh[yp + xm])) * strength;
      const gy = (hh[yp + xm] + 2 * hh[yp + x] + hh[yp + xp] -
        (hh[ym + xm] + 2 * hh[ym + x] + hh[ym + xp])) * strength;
      const nx = -gx;
      const ny = yUp ? gy : -gy;
      const len = Math.sqrt(nx * nx + ny * ny + 1);
      const p = (y * w + x) * 4;
      out[p] = encode8(nx / len);
      out[p + 1] = encode8(ny / len);
      out[p + 2] = encode8(1 / len);
      out[p + 3] = 255;
    }
  }
  return out;
}

// [-1,1] 的线性分量 -> 8 位：中灰 0 落在 128，+1 落在 255
function encode8(v) {
  return Math.floor((v * 0.5 + 0.5) * 255 + 0.5);
}

// 横竖两趟框形模糊，越界按 clamp；滑动窗口在窄/矮图上退化为反复取边缘像素，与 numpy 的 pad+mean 一致
function boxBlur(src, w, h, r) {
  const size = 2 * r + 1;
  const tmp = new Float64Array(w * h);
  const dst = new Float64Array(w * h);
  const cx = (x) => (x < 0 ? 0 : x >= w ? w - 1 : x);
  const cy = (y) => (y < 0 ? 0 : y >= h ? h - 1 : y);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + cx(k)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / size;
      sum += src[row + cx(x + r + 1)] - src[row + cx(x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[cy(k) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / size;
      sum += tmp[cy(y + r + 1) * w + x] - tmp[cy(y - r) * w + x];
    }
  }
  return dst;
}
