// Radiance RGBE (.hdr) 解码：输出线性 float RGB
// 依据 Ward 的 RGBE_ReadPixels_RLE 语义（ffmpeg 的 hdr 解码器与此一致）：
//   行首 4 字节是 2,2,xsize_hi,xsize_lo 且 xsize>=8 时，本行走每通道独立游程，
//   每通道解出来的 w 个值是**按通道平面**存放的（读回时要按 4 字节步长散落），
//   每通道里计数 >128 表示「后一字节重复 count-128 次」，否则是 count 个字面量；
//   其余情况整行是 xsize 个非压缩 4 字节像素（交错 RGBA）
// 旧式文件（没有 #? 与 FORMAT 行）参考实现也不支持，直接拒绝
export function decodeRgbE(bytes) {
  const { w, h, format, start } = parseHeader(bytes);
  if (format && format !== '32-bit_rle_rgbe') throw new Error('不支持的 RGBE FORMAT：' + format);
  if (w < 1 || h < 1) throw new Error('RGBE 尺寸非法');

  const data = new Float32Array(w * h * 3);
  const line = new Uint8Array(w * 4);
  let i = start;
  for (let y = 0; y < h; y++) {
    if (i + 4 > bytes.length) throw new Error('RGBE 数据不完整');
    const adaptive =
      w >= 8 && bytes[i] === 2 && bytes[i + 1] === 2 && (bytes[i + 2] & 0x80) === 0 &&
      ((bytes[i + 2] << 8) | bytes[i + 3]) === w;
    if (adaptive) {
      i += 4;
      for (let ch = 0; ch < 4; ch++) i = channelRle(bytes, i, line, ch, w);
    } else {
      if (i + w * 4 > bytes.length) throw new Error('RGBE 数据不完整');
      line.set(bytes.subarray(i, i + w * 4));
      i += w * 4;
    }
    for (let x = 0; x < w; x++) {
      const s = x * 4;
      const p = (y * w + x) * 3;
      const e = line[s + 3];
      if (e === 0) continue; // 全黑
      const scale = 2 ** (e - 136);
      data[p] = line[s] * scale;
      data[p + 1] = line[s + 1] * scale;
      data[p + 2] = line[s + 2] * scale;
    }
  }
  return { width: w, height: h, channels: 3, data };
}

// 解出 count 个值写进 out[off + n*stride]，返回读完后的偏移
function channelRle(src, pos, out, ch, count) {
  let n = 0;
  while (n < count) {
    if (pos >= src.length) throw new Error('RGBE 数据不完整');
    const marker = src[pos++];
    if (marker > 128) {
      const run = Math.min(marker - 128, count - n);
      const v = src[pos++];
      for (let k = 0; k < run; k++) out[(n + k) * 4 + ch] = v;
      n += run;
    } else {
      if (marker === 0) throw new Error('RGBE 游程计数为 0');
      const run = Math.min(marker, count - n);
      if (pos + run > src.length) throw new Error('RGBE 数据不完整');
      for (let k = 0; k < run; k++) out[(n + k) * 4 + ch] = src[pos + k];
      pos += run;
      n += run;
    }
  }
  return pos;
}

function parseHeader(bytes) {
  if (bytes.length < 3 || bytes[0] !== 0x23 || bytes[1] !== 0x3f) {
    throw new Error('旧式 RGBE（缺少 FORMAT 行）不支持');
  }
  const dec = new TextDecoder('latin1');
  let i = 0;
  let format = null;
  let blank = false;
  for (let guard = 0; guard < 256; guard++) {
    const start = i;
    while (i < bytes.length && bytes[i] !== 10) i++;
    const line = dec.decode(bytes.subarray(start, i));
    i++;
    if (!blank) {
      if (line === '') blank = true;
      else if (line.startsWith('FORMAT=')) format = line.slice(7);
      continue;
    }
    // 空行之后的第一行是分辨率行，例如 "-Y 17 +X 33"
    const m = /[+-]Y\s+(\d+)\s+[+-]X\s+(\d+)/.exec(line);
    if (!m) throw new Error('RGBE 缺少分辨率行');
    return { h: parseInt(m[1], 10), w: parseInt(m[2], 10), format, start: i };
  }
  throw new Error('RGBE 头部过长');
}
