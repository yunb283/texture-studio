import { readFileSync } from 'node:fs';
import { parseGif, createGifCompositor } from '../src/js/gif-decode.js';

const file = process.argv[2];
const bytes = new Uint8Array(readFileSync(file));
const t0 = performance.now();
const info = parseGif(bytes);
console.log(`parse ${info.frames.length}f ${info.width}x${info.height} ${(performance.now() - t0).toFixed(1)}ms`);

const comp = createGifCompositor(info);
const N = info.frames.length;

const time = (label, fn) => {
  const a = performance.now();
  fn();
  const b = performance.now();
  console.log(`${label.padEnd(34)} ${(b - a).toFixed(2)}ms`);
};

// 1) 顺序前进（播放/正向拖）
comp.reset();
time('seq 0..N-1 (each frame once)', () => {
  for (let i = 0; i < N; i++) comp.frame(i);
});

// 2) 往回跳：每次从 0 重跑到目标（当前实现）
let acc = 0;
for (let k = 0; k < 20; k++) {
  const target = N - 1 - k;
  const a = performance.now();
  comp.frame(target);
  acc += performance.now() - a;
}
console.log(`backward seek avg (from ${N - 1})        ${(acc / 20).toFixed(2)}ms`);

// 3) 前后小幅来回拖（模拟手指抖动）
acc = 0;
for (let k = 0; k < 20; k++) {
  const a = performance.now();
  comp.frame(N - 10 + (k % 2));
  acc += performance.now() - a;
}
console.log(`oscillate +-1 near middle avg          ${(acc / 20).toFixed(2)}ms`);

// 4) 单帧整幅合成的裸成本
comp.reset();
for (let i = 0; i < N - 1; i++) comp.frame(i);
const a = performance.now();
comp.frame(N - 1);
console.log(`one forward step at last frame          ${(performance.now() - a).toFixed(2)}ms`);
