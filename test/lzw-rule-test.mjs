// 试验：比较 LZW 码表加宽时机，找出 PIL 写入的 TIFF 用的规则
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fmt = join(here, 'fmt');

function readTiffMeta(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = bytes[0] === 0x49;
  const n = dv.getUint16(dv.getUint32(4, le), le);
  const base = dv.getUint32(4, le);
  const tags = new Map();
  const SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  for (let i = 0; i < n; i++) {
    const e = base + 2 + i * 12;
    const id = dv.getUint16(e, le);
    const type = dv.getUint16(e + 2, le);
    const cnt = dv.getUint32(e + 4, le);
    const size = SIZE[type] * cnt;
    if (!SIZE[type]) continue;
    const off = size <= 4 ? e + 8 : dv.getUint32(e + 8, le);
    const vals = [];
    for (let k = 0; k < cnt; k++) {
      if (type === 3) vals.push(dv.getUint16(off + k * 2, le));
      else if (type === 2 || type === 1 || type === 7) vals.push(dv.getUint8(off + k));
      else vals.push(dv.getUint32(off + k * (type === 5 || type === 10 ? 8 : 4), le));
    }
    tags.set(id, vals);
  }
  return { le, tags, bytes };
}

function lzw(src, expected, earlyChange) {
  const prefix = new Int32Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  const depth = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    suffix[i] = i;
    depth[i] = 1;
  }
  const stack = new Uint8Array(4096);
  const out = new Uint8Array(expected);
  let bits = 9;
  let acc = 0;
  let accBits = 0;
  let next = 258;
  let prev = -1;
  let o = 0;
  let codes = 0;
  let clears = 0;
  const addEntry = (firstByte, parent) => {
    if (next >= 4094) return;
    prefix[next] = parent;
    suffix[next] = firstByte;
    depth[next] = depth[parent] + 1;
    next++;
    const trigger = earlyChange ? (1 << bits) - 1 : 1 << bits;
    if (next === trigger && bits < 12) bits++;
  };
  for (let i = 0; i < src.length && o < expected; i++) {
    acc = (acc << 8) | src[i];
    accBits += 8;
    while (accBits >= bits) {
      accBits -= bits;
      const code = (acc >> accBits) & ((1 << bits) - 1);
      acc &= (1 << accBits) - 1;
      codes++;
      if (code === 256) {
        clears++;
        next = 258;
        bits = 9;
        prev = -1;
        continue;
      }
      if (code === 257) return { ok: true, o, codes, clears, bits };
      if (code > next || code >= 4096) return { ok: false, why: `code ${code} > next ${next}`, o, codes, clears, bits };
      let len;
      if (code === next) {
        len = depth[prev] + 1;
        let c = prev;
        for (let k = len - 2; k >= 0; k--) {
          stack[k] = suffix[c];
          c = prefix[c];
        }
        stack[len - 1] = stack[0];
        addEntry(stack[0], prev);
      } else {
        if (depth[code] === 0) return { ok: false, why: `未定义的码 ${code}`, o, codes, clears, bits };
        len = depth[code];
        let c = code;
        for (let k = len - 1; k >= 0; k--) {
          stack[k] = suffix[c];
          c = prefix[c];
        }
        if (prev >= 0) addEntry(stack[0], prev);
      }
      prev = code;
      if (o + len > expected) len = expected - o;
      out.set(stack.subarray(0, len), o);
      o += len;
      if (o >= expected) return { ok: true, o, codes, clears, bits };
    }
  }
  return { ok: o >= expected, why: `流提前结束 o=${o}/${expected}`, o, codes, clears, bits };
}

for (const name of process.argv.slice(2)) {
  const bytes = new Uint8Array(await readFile(join(fmt, name)));
  const { tags } = readTiffMeta(bytes);
  const w = tags.get(256)[0];
  const h = tags.get(257)[0];
  const photo = tags.get(262)?.[0] ?? 2;
  const spp = tags.get(277)?.[0] ?? (photo === 2 ? 3 : 1);
  const bps = tags.get(258)?.[0] ?? 8;
  const offs = tags.get(273) || tags.get(324);
  const cnts = tags.get(279) || tags.get(325) || [];
  const rows = tags.get(278)?.[0] ?? h;
  const rowBytes = w * spp * (bps >> 3);
  for (const early of [false, true]) {
    let allOk = true;
    let detail = '';
    for (let s = 0; s < offs.length; s++) {
      const y0 = s * rows;
      const exp = rowBytes * Math.min(rows, h - y0);
      const src = bytes.subarray(offs[s], offs[s] + (cnts[s] || 0));
      const r = lzw(src, exp, early);
      if (!r.ok) {
        allOk = false;
        detail = `strip ${s}: ${r.why} (码数 ${r.codes}, clear ${r.clears}, bits ${r.bits})`;
        break;
      }
    }
    console.log(name.padEnd(24), early ? 'early-change' : 'normal     ', allOk ? '全部条带 OK' : detail);
  }
}
