// NetPBM 系列：P1/P2/P3（ASCII）、P4/P5/P6（原始）、P7（PAM）
// 与 Pillow 对齐的约定：位图 1 = 黑；灰度复制到 RGB；16 位大端，量化 round(v*255/maxval)
const isDigit = (c) => c >= 48 && c <= 57;
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13;

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.i = 0;
  }
  peek() {
    return this.b[this.i];
  }
  eof() {
    return this.i >= this.b.length;
  }
  skipSpace() {
    for (;;) {
      while (!this.eof() && isSpace(this.peek())) this.i++;
      if (!this.eof() && this.peek() === 35) {
        while (!this.eof() && this.peek() !== 10) this.i++;
        continue;
      }
      return;
    }
  }
  token() {
    this.skipSpace();
    const start = this.i;
    while (!this.eof() && !isSpace(this.peek()) && this.peek() !== 35) this.i++;
    if (this.i === start) throw new Error('PNM 头部不完整');
    let s = '';
    for (let i = start; i < this.i; i++) s += String.fromCharCode(this.b[i]);
    return s;
  }
  int() {
    const n = parseInt(this.token(), 10);
    if (!Number.isFinite(n)) throw new Error('PNM 头部数值非法');
    return n;
  }
  // ASCII 像素值：只吃数字，注释和空白照跳
  number() {
    this.skipSpace();
    let n = 0;
    let seen = false;
    while (!this.eof()) {
      const c = this.peek();
      if (isDigit(c)) {
        n = n * 10 + (c - 48);
        seen = true;
        this.i++;
      } else if (isSpace(c) || c === 35) {
        break;
      } else {
        throw new Error('PNM 数据里有非法字符');
      }
    }
    if (!seen) throw new Error('PNM 缺少像素值');
    return n;
  }
  take(n) {
    if (this.i + n > this.b.length) throw new Error('PNM 数据不完整');
    const s = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return s;
  }
  sample(bytes) {
    const raw = this.take(bytes);
    return bytes === 2 ? (raw[0] << 8) | raw[1] : raw[0];
  }
}

function quant(v, maxval) {
  if (maxval === 255) return v;
  if (maxval <= 1) return v ? 255 : 0;
  return Math.min(255, Math.floor((v * 255) / maxval + 0.5));
}

// tupleType 为空时按 DEPTH 推断；DEPTH 2 必须显式声明，否则灰度和 Alpha 分不清
function channelMode(tupleType, depth) {
  switch (tupleType) {
    case 'BITMAP':
      return 'bitmap';
    case 'GRAYSCALE':
      return 'gray';
    case 'GRAYSCALE_ALPHA':
      return 'grayalpha';
    case 'RGB':
      return 'rgb';
    case 'RGB_ALPHA':
      return 'rgba';
    default:
      if (depth === 1) return 'gray';
      if (depth === 3) return 'rgb';
      if (depth === 4) return 'rgba';
      throw new Error(`PAM DEPTH ${depth} 需要明确的 TUPLTYPE`);
  }
}

function emit(out, p, tup, mode, maxval) {
  const q = (v) => quant(v, maxval);
  switch (mode) {
    case 'bitmap': {
      const g = tup[0] ? 0 : 255;
      out[p] = out[p + 1] = out[p + 2] = g;
      out[p + 3] = 255;
      break;
    }
    case 'gray':
      out[p] = out[p + 1] = out[p + 2] = q(tup[0]);
      out[p + 3] = 255;
      break;
    case 'grayalpha':
      out[p] = out[p + 1] = out[p + 2] = q(tup[0]);
      out[p + 3] = q(tup[1]);
      break;
    case 'rgb':
      out[p] = q(tup[0]);
      out[p + 1] = q(tup[1]);
      out[p + 2] = q(tup[2]);
      out[p + 3] = 255;
      break;
    default:
      out[p] = q(tup[0]);
      out[p + 1] = q(tup[1]);
      out[p + 2] = q(tup[2]);
      out[p + 3] = q(tup[3]);
  }
}

function decodePam(r) {
  let w = 0;
  let h = 0;
  let depth = 0;
  let maxval = 1;
  let hasMax = false;
  const types = [];
  for (;;) {
    const key = r.token().toUpperCase();
    if (key === 'ENDHDR') {
      if (!r.eof() && isSpace(r.peek())) r.i++;
      break;
    }
    if (key === 'WIDTH') w = r.int();
    else if (key === 'HEIGHT') h = r.int();
    else if (key === 'DEPTH') depth = r.int();
    else if (key === 'MAXVAL') {
      maxval = r.int();
      hasMax = true;
    } else if (key === 'TUPLTYPE') types.push(r.token().toUpperCase());
    else if (key === 'IMAGETYPE') r.token();
    else throw new Error('PAM 头部有未知字段 ' + key);
  }
  if (w < 1 || h < 1 || depth < 1) throw new Error('PAM 缺少 WIDTH/HEIGHT/DEPTH');
  if (types.length > 1) throw new Error('不支持的组合 TUPLTYPE：' + types.join('+'));
  const mode = channelMode(types[0] || '', depth);
  if (!hasMax && mode !== 'bitmap') throw new Error('PAM 缺少 MAXVAL');
  const bytes = mode === 'bitmap' || maxval <= 255 ? 1 : 2;
  const out = new Uint8Array(w * h * 4);
  const tup = new Array(depth);
  for (let p = 0; p < w * h; p++) {
    for (let d = 0; d < depth; d++) tup[d] = r.sample(bytes);
    emit(out, p * 4, tup, mode, maxval);
  }
  return { width: w, height: h, data: out };
}

export function decodePnm(bytes) {
  const r = new Reader(bytes);
  const magic = r.token();
  if (!/^P[1-7]$/.test(magic)) throw new Error('不是 PNM 文件');
  const kind = magic[1];
  if (kind === '7') return decodePam(r);

  const w = r.int();
  const h = r.int();
  if (w < 1 || h < 1) throw new Error('PNM 尺寸非法');
  const ascii = kind === '1' || kind === '2' || kind === '3';
  const bitmap = kind === '1' || kind === '4';
  const channels = kind === '3' || kind === '6' ? 3 : 1;
  const maxval = bitmap ? 1 : r.int();
  if (!bitmap && maxval < 1) throw new Error('PNM 缺少 MAXVAL');

  if (ascii) {
    const out = new Uint8Array(w * h * 4);
    const tup = new Array(channels);
    for (let p = 0; p < w * h; p++) {
      for (let ch = 0; ch < channels; ch++) tup[ch] = r.number();
      emit(out, p * 4, tup, bitmap ? 'bitmap' : channels === 3 ? 'rgb' : 'gray', maxval);
    }
    return { width: w, height: h, data: out };
  }

  // 原始格式：MAXVAL/尺寸行后恰好跟一个空白，再多跳就吃掉数据了
  const skipOneWs = () => {
    const ch = r.peek();
    if (!isSpace(ch)) throw new Error(`${magic} 头部缺少换行`);
    r.i++;
    if (ch === 13 && r.peek() === 10) r.i++;
  };
  if (kind === '4') {
    skipOneWs();
    const out = new Uint8Array(w * h * 4);
    const rowBytes = Math.ceil(w / 8);
    for (let y = 0; y < h; y++) {
      const row = r.take(rowBytes);
      for (let x = 0; x < w; x++) {
        const g = (row[x >> 3] >> (7 - (x & 7))) & 1 ? 0 : 255;
        const p = (y * w + x) * 4;
        out[p] = out[p + 1] = out[p + 2] = g;
        out[p + 3] = 255;
      }
    }
    return { width: w, height: h, data: out };
  }

  skipOneWs();
  const sampleBytes = maxval > 255 ? 2 : 1;
  const out = new Uint8Array(w * h * 4);
  const tup = new Array(channels);
  for (let p = 0; p < w * h; p++) {
    for (let ch = 0; ch < channels; ch++) tup[ch] = r.sample(sampleBytes);
    emit(out, p * 4, tup, channels === 3 ? 'rgb' : 'gray', maxval);
  }
  return { width: w, height: h, data: out };
}
