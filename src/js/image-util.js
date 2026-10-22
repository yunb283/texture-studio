import { encodeTga } from './tga.js';

export function cellRect(w, h, cols, rows, index) {
  const col = index % cols;
  const row = Math.floor(index / cols);
  return [
    Math.floor((col * w) / cols),
    Math.floor((row * h) / rows),
    Math.floor(((col + 1) * w) / cols),
    Math.floor(((row + 1) * h) / rows),
  ];
}

export function imageDataToCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

// 大图只保留 canvas：省掉一次全尺寸 getImageData + 一次全尺寸 putImageData
export function bitmapToCanvas(bmp) {
  const w = bmp.width;
  const h = bmp.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  return c;
}

export function canvasToImageData(c) {
  return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
}

// 1:1 平移拷贝，不触发插值
export function cropCanvas(src, l, t, r, b) {
  const w = r - l;
  const h = b - t;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(src, l, t, w, h, 0, 0, w, h);
  return c;
}

export function rotate90CW(img) {
  const { width, height, data } = img;
  const out = new ImageData(height, width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = (x * height + (height - 1 - y)) * 4;
      out.data[di] = data[si];
      out.data[di + 1] = data[si + 1];
      out.data[di + 2] = data[si + 2];
      out.data[di + 3] = data[si + 3];
    }
  }
  return out;
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片编码失败'))), type, quality);
  });
}

export async function encodeCanvas(canvas, ext) {
  if (ext === 'tga') {
    return encodeTga(canvasToImageData(canvas));
  }
  if (ext === 'jpg' || ext === 'jpeg') {
    // JPEG 无透明通道，canvas 里的透明像素会被合成成黑色
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    return new Uint8Array(await blob.arrayBuffer());
  }
  const blob = await canvasToBlob(canvas, 'image/png');
  return new Uint8Array(await blob.arrayBuffer());
}
