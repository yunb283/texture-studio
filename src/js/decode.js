// 各格式的「解码到 canvas」统一入口：转换页与贴图转法线页共用，避免两套解码路径。
// PNG/JPEG/BMP/GIF/WEBP 交给 WebView2 的 createImageBitmap，其余走项目自带的解码器。
import { bitmapToCanvas } from './image-util.js';
import { quantizeFloat } from './float-quant.js';

export const FORMAT_NAME = {
  png: 'PNG',
  jpg: 'JPG',
  jpeg: 'JPEG',
  bmp: 'BMP',
  gif: 'GIF',
  webp: 'WEBP',
  tga: 'TGA',
  targa: 'TGA',
  tif: 'TIF',
  tiff: 'TIFF',
  hdr: 'HDR / RGBE',
  rgbe: 'HDR / RGBE',
  dds: 'DDS',
  exr: 'OpenEXR',
  pnm: 'PNM',
  ppm: 'PPM',
  pgm: 'PGM',
  pbm: 'PBM',
  pam: 'PAM',
  heic: 'HEIC',
  heif: 'HEIF',
};

export const extOf = (name) => (name.split('.').pop() || '').toLowerCase();

export function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function rgbaCanvas(w, h, data) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
  return c;
}

// 高位深（HDR / EXR 线性浮点）量化到 8 位：默认线性裁剪，勾选后按最大值拉伸
function floatCanvas(img, stretch) {
  return rgbaCanvas(img.width, img.height, quantizeFloat(img, stretch));
}

export async function decodeToCanvas(name, bytes, stretch = false) {
  const ext = extOf(name);
  if (ext === 'hdr' || ext === 'rgbe') {
    const { decodeRgbE } = await import('./rgbe.js');
    return floatCanvas(decodeRgbE(bytes), stretch);
  }
  if (ext === 'exr') {
    const { decodeExr } = await import('./exr.js');
    return floatCanvas(await decodeExr(bytes), stretch);
  }
  if (ext === 'dds') {
    const { decodeDds } = await import('./dds.js');
    const img = decodeDds(bytes);
    return rgbaCanvas(img.width, img.height, img.data);
  }
  if (['pnm', 'ppm', 'pgm', 'pbm', 'pam'].includes(ext)) {
    const { decodePnm } = await import('./pnm.js');
    const img = decodePnm(bytes);
    return rgbaCanvas(img.width, img.height, img.data);
  }
  if (ext === 'tga' || ext === 'targa') {
    const { decodeTga } = await import('./tga.js');
    const img = decodeTga(bytes);
    return rgbaCanvas(img.width, img.height, img.data);
  }
  if (ext === 'tif' || ext === 'tiff') {
    const { decodeTiff } = await import('./tiff.js');
    const img = await decodeTiff(bytes);
    return rgbaCanvas(img.width, img.height, img.data);
  }
  if (ext === 'heic' || ext === 'heif') {
    // HEIC / HEIF 走 Rust 端 zune-heic 解码（WebView2 对 HEIC 的支持依赖系统 HEVC 扩展，不可靠）
    const { isTauri, decodeHeif } = await import('./platform.js');
    if (!isTauri) throw new Error('HEIC / HEIF 解码需要桌面版环境');
    const { width, height, rgba } = await decodeHeif(bytes);
    // ImageData 直接引用响应缓冲区（零拷贝），只有 putImageData 进 canvas 那一次复制
    const data = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    c.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
    return c;
  }
  try {
    return bitmapToCanvas(await createImageBitmap(new Blob([bytes])));
  } catch (ex) {
    // WebView2 的原文是英文，换成和项目里其它解码器一致的中文提示
    throw new Error(`图片数据无法解码（不是完整的 PNG / JPEG / BMP / GIF / WEBP 文件）：${ex?.message ?? ex}`);
  }
}
