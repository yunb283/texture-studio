export function decodeTga(bytes) {
  if (bytes.length < 18) throw new Error('TGA 文件太小');
  const idLen = bytes[0];
  const cmapType = bytes[1];
  const imgType = bytes[2];
  const width = bytes[12] | (bytes[13] << 8);
  const height = bytes[14] | (bytes[15] << 8);
  const depth = bytes[16];
  const descriptor = bytes[17];
  if (cmapType !== 0) throw new Error('不支持带颜色表的 TGA');
  if (imgType !== 2 && imgType !== 10) throw new Error(`不支持的 TGA 类型 ${imgType}`);
  if (depth !== 24 && depth !== 32) throw new Error(`不支持的 TGA 位深 ${depth}`);
  if (!width || !height) throw new Error('TGA 尺寸无效');
  const bpp = depth / 8;
  let off = 18 + idLen;
  const total = width * height;
  const out = new Uint8Array(total * 4);

  const readPixel = () => {
    const b = bytes[off], g = bytes[off + 1], r = bytes[off + 2];
    const a = bpp === 4 ? bytes[off + 3] : 255;
    off += bpp;
    return [r, g, b, a];
  };
  const writePixel = (p, at) => {
    out[at * 4] = p[0];
    out[at * 4 + 1] = p[1];
    out[at * 4 + 2] = p[2];
    out[at * 4 + 3] = p[3];
  };

  if (imgType === 2) {
    for (let i = 0; i < total; i++) writePixel(readPixel(), i);
  } else {
    let i = 0;
    while (i < total && off < bytes.length) {
      const header = bytes[off++];
      const count = (header & 0x7f) + 1;
      if (header & 0x80) {
        const p = readPixel();
        for (let k = 0; k < count && i < total; k++, i++) writePixel(p, i);
      } else {
        for (let k = 0; k < count && i < total; k++, i++) writePixel(readPixel(), i);
      }
    }
    if (i < total) throw new Error('TGA 数据不完整');
  }

  if (!(descriptor & 0x20)) {
    const rowBytes = width * 4;
    const row = new Uint8Array(rowBytes);
    for (let y = 0; y < height >> 1; y++) {
      const top = y * rowBytes;
      const bot = (height - 1 - y) * rowBytes;
      row.set(out.subarray(top, top + rowBytes));
      out.copyWithin(top, bot, bot + rowBytes);
      out.set(row, bot);
    }
  }
  if (descriptor & 0x10) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width >> 1; x++) {
        const a = (y * width + x) * 4;
        const b = (y * width + (width - 1 - x)) * 4;
        for (let c = 0; c < 4; c++) {
          const t = out[a + c];
          out[a + c] = out[b + c];
          out[b + c] = t;
        }
      }
    }
  }
  return { width, height, data: out };
}

export function encodeTga(imageData) {
  const { width, height, data } = imageData;
  // RGBA -> BGRA 原地交换：省掉逐像素四写入和一次全尺寸分配
  const px = new Uint32Array(data.buffer);
  for (let i = 0; i < px.length; i++) {
    const v = px[i];
    px[i] = (v & 0xff00ff00) | ((v & 0xff) << 16) | ((v >>> 16) & 0xff);
  }
  const out = new Uint8Array(18 + data.length);
  const head = new DataView(out.buffer);
  head.setUint8(2, 2);
  head.setUint16(12, width, true);
  head.setUint16(14, height, true);
  head.setUint8(16, 32);
  head.setUint8(17, 0x28);
  out.set(data, 18);
  return out;
}
