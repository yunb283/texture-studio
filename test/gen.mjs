// 生成测试图片：4x4 序列贴图（带透明间隙）+ 5 张不同尺寸的序列帧
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function writePng(path, width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

// 4x4 贴图，64px 帧 + 8px 透明间隙 → 320x320
const cols = 4;
const rows = 4;
const cell = 64;
const gap = 8;
const W = cols * cell + (cols + 1) * gap;
const H = rows * cell + (rows + 1) * gap;
const px = Buffer.alloc(W * H * 4);
function fillRect(x0, y0, w, h, r, g, b, a) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = a;
    }
  }
}
let f = 0;
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++, f++) {
    fillRect(
      gap + c * (cell + gap),
      gap + r * (cell + gap),
      cell,
      cell,
      (f * 67) % 256,
      (f * 131) % 256,
      (f * 37) % 256,
      255
    );
  }
}
mkdirSync(OUT_DIR, { recursive: true });
writePng(join(OUT_DIR, 'hero_4x4.png'), W, H, px);

// 5 张不同尺寸的序列帧（左半不透明、右半半透明，检验 alpha）
const sizes = [
  [32, 48],
  [40, 40],
  [48, 32],
  [36, 44],
  [32, 32],
];
sizes.forEach(([w, h], i) => {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4;
      buf[j] = (i * 50) % 256;
      buf[j + 1] = 200;
      buf[j + 2] = (255 - i * 40 + 256) % 256;
      buf[j + 3] = x < w / 2 ? 255 : 128;
    }
  }
  writePng(join(OUT_DIR, `run_${String(i).padStart(3, '0')}.png`), w, h, buf);
});
console.log(`测试图片已生成到 ${OUT_DIR}`);
