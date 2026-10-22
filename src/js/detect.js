const NAME_GRID_RE = /(?:^|[_\s\-])(\d{1,3})\s*[xX×]\s*(\d{1,3})(?=$|[_\s\-])/g;

export function gridFromName(name, width, height) {
  NAME_GRID_RE.lastIndex = 0;
  const matches = [...name.matchAll(NAME_GRID_RE)];
  if (matches.length !== 1) return null;
  const cols = parseInt(matches[0][1], 10);
  const rows = parseInt(matches[0][2], 10);
  if (cols >= 1 && cols <= 128 && rows >= 1 && rows <= 128 && cols <= width && rows <= height) {
    return [cols, rows];
  }
  return null;
}

function detectGaps(energy) {
  const n = energy.length;
  let peak = 0;
  for (let i = 0; i < n; i++) if (energy[i] > peak) peak = energy[i];
  if (peak < 0.0001) return 1;
  let best = 1;
  const maxCount = Math.min(32, Math.floor(n / 8));
  for (let count = 2; count <= maxCount; count++) {
    const maxima = new Float64Array(count);
    let active = 0;
    for (let cell = 0; cell < count; cell++) {
      const start = Math.floor((cell * n) / count);
      const end = Math.floor(((cell + 1) * n) / count);
      let m = 0;
      for (let i = start; i < end; i++) if (energy[i] > m) m = energy[i];
      maxima[cell] = m;
      if (m > peak * 0.01) active++;
    }
    if (active < Math.max(2, Math.floor((count + 1) / 2))) continue;
    let valid = true;
    let tested = 0;
    for (let boundary = 1; boundary < count; boundary++) {
      const localPeak = Math.max(maxima[boundary - 1], maxima[boundary]);
      if (localPeak < peak * 0.01) continue;
      tested++;
      const position = (boundary * n) / count;
      const left = Math.max(0, Math.floor(position - 0.5));
      const right = Math.min(n - 1, Math.ceil(position - 0.5));
      const atBoundary = Math.max(energy[left], energy[right]);
      if (atBoundary > localPeak * 0.12) {
        valid = false;
        break;
      }
    }
    if (valid && tested > 0) best = count;
  }
  return best;
}

function boundaryAlign(sig) {
  const n = sig.length / 4;
  const boundary = new Float64Array(n);
  let total = 0;
  for (let i = 1; i < n; i++) {
    const d0 = Math.abs(sig[(i - 1) * 4] - sig[i * 4]);
    const d1 = Math.abs(sig[(i - 1) * 4 + 1] - sig[i * 4 + 1]);
    const d2 = Math.abs(sig[(i - 1) * 4 + 2] - sig[i * 4 + 2]);
    const d3 = Math.abs(sig[(i - 1) * 4 + 3] - sig[i * 4 + 3]);
    boundary[i] = d0 + d1 + d2 + 1.5 * d3;
    total += boundary[i];
  }
  let bestP = 0;
  let bestScore = 2.0;
  for (let p = 3; p <= Math.floor(n / 2); p++) {
    const ks = [];
    for (let k = p; k < n; k += p) ks.push(k);
    const count = ks.length;
    if (count < 2) continue;
    let atGrid = 0;
    for (const k of ks) atGrid += boundary[k];
    atGrid /= count;
    const offGrid = (total - atGrid * count) / Math.max(1, n - 1 - count);
    const sc = atGrid / Math.max(offGrid, 1e-6) - (2.0 * (n % p)) / n;
    if (sc > bestScore * 1.03) {
      bestScore = sc;
      bestP = p;
    }
  }
  if (bestP <= 0) return [0, 0.0];
  return [Math.max(2, Math.round(n / bestP)), bestScore];
}

function autocorrPeriod(e, n, meanE, varE) {
  const half = Math.floor(n / 2);
  const corr = new Float64Array(half + 2);
  for (let L = 2; L <= half; L++) {
    let dot = 0;
    for (let i = 0; i < n - L; i++) dot += (e[i] - meanE) * (e[i + L] - meanE);
    corr[L] = dot / (n - L) / varE;
  }
  for (let L = 3; L < half; L++) {
    if (corr[L] > 0.3 && corr[L] >= corr[L - 1] && corr[L] >= corr[L + 1]) {
      return [Math.max(2, Math.round(n / L)), corr[L]];
    }
  }
  return [0, 0.0];
}

function detectAxisPeriod(sig) {
  const n = sig.length / 4;
  if (n < 8) return 0;
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    e[i] = 0.299 * sig[i * 4] + 0.587 * sig[i * 4 + 1] + 0.114 * sig[i * 4 + 2];
  }
  let meanE = 0;
  for (let i = 0; i < n; i++) meanE += e[i];
  meanE /= n;
  let varE = 0;
  for (let i = 0; i < n; i++) varE += (e[i] - meanE) ** 2;
  varE /= n;
  if (varE < 1e-9) return 1;
  const [bFrames, bScore] = boundaryAlign(sig);
  const [aFrames, aPeak] = autocorrPeriod(e, n, meanE, varE);
  if (bScore >= 12.0) return bFrames;
  if (aPeak > 0.3) return aFrames;
  return bFrames > 0 ? bFrames : 0;
}

// source 是已解码的 canvas（或 ImageData），只按需缩样到 512px 内分析
export function autoDetectGrid(source, name) {
  const g = gridFromName(name, source.width, source.height);
  if (g) return { cols: g[0], rows: g[1], kind: 'name' };

  const scale = Math.min(1, 512 / Math.max(source.width, source.height));
  const dw = Math.max(2, Math.round(source.width * scale));
  const dh = Math.max(2, Math.round(source.height * scale));
  const cv = document.createElement('canvas');
  cv.width = dw;
  cv.height = dh;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingEnabled = true;
  cx.drawImage(source, 0, 0, dw, dh);
  const sd = cx.getImageData(0, 0, dw, dh).data;

  const np = dw * dh;
  const r = new Float32Array(np);
  const gg = new Float32Array(np);
  const b = new Float32Array(np);
  const a = new Float32Array(np);
  for (let i = 0; i < np; i++) {
    r[i] = sd[i * 4] / 255;
    gg[i] = sd[i * 4 + 1] / 255;
    b[i] = sd[i * 4 + 2] / 255;
    a[i] = sd[i * 4 + 3] / 255;
  }
  const colSig = new Float64Array(dw * 4);
  const rowSig = new Float64Array(dh * 4);
  const colEnergy = new Float64Array(dw);
  const rowEnergy = new Float64Array(dh);
  const bgR = r[0];
  const bgG = gg[0];
  const bgB = b[0];
  const bgA = a[0];
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const i = y * dw + x;
      const paR = r[i] * a[i];
      const paG = gg[i] * a[i];
      const paB = b[i] * a[i];
      colSig[x * 4] += paR / dh;
      colSig[x * 4 + 1] += paG / dh;
      colSig[x * 4 + 2] += paB / dh;
      colSig[x * 4 + 3] += a[i] / dh;
      rowSig[y * 4] += paR / dw;
      rowSig[y * 4 + 1] += paG / dw;
      rowSig[y * 4 + 2] += paB / dw;
      rowSig[y * 4 + 3] += a[i] / dw;
      const eR = Math.abs(paR - bgR * bgA);
      const eG = Math.abs(paG - bgG * bgA);
      const eB = Math.abs(paB - bgB * bgA);
      const eA = Math.abs(a[i] - bgA);
      const energy = Math.max(eR, eG, eB, eA);
      colEnergy[x] += energy / dh;
      rowEnergy[y] += energy / dw;
    }
  }

  let cols = detectGaps(colEnergy);
  let rows = detectGaps(rowEnergy);
  let kind;
  if (cols > 1 || rows > 1) {
    kind = 'gaps';
  } else {
    cols = detectAxisPeriod(colSig);
    rows = detectAxisPeriod(rowSig);
    kind = 'period';
  }
  if (cols > 0 && rows === 0) rows = 1;
  if (rows > 0 && cols === 0) cols = 1;
  if (cols === 0 && rows === 0) return { cols: 1, rows: 1, kind: 'fail' };
  return { cols, rows, kind };
}
