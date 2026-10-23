export const isTauri = typeof window !== 'undefined' && !!window.__TAURI__?.core;

export function dirname(p) {
  if (!p) return '';
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(0, i) : '';
}

export function baseName(p) {
  if (!p) return '';
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return p.slice(i + 1);
}

export function stemOf(name) {
  return name.replace(/\.[^.]*$/, '');
}

const SUPPORTED_EXTS = ['png', 'tga', 'targa', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'tif', 'tiff'];
// 格式转换页的导入范围更宽（含 WebView2 解不了、需要自带解码器的格式）
export const CONVERT_EXTS = [
  ...SUPPORTED_EXTS,
  'hdr',
  'rgbe',
  'dds',
  'exr',
  'pnm',
  'ppm',
  'pgm',
  'pbm',
  'pam',
];
export function isSupportedName(name, exts = SUPPORTED_EXTS) {
  return exts.includes((name.split('.').pop() || '').toLowerCase());
}

// 贴图处理页（转法线 / 无缝化）的导入范围：只收 8 位可逆的常见贴图格式
export const TEXTURE_EXTS = [
  'png',
  'jpg',
  'jpeg',
  'bmp',
  'webp',
  'tga',
  'targa',
  'dds',
];

// 制作 GIF 页还能吃视频。能不能真解码取决于 WebView2 的 Media Foundation
// （H.264/MP4、VP9/WEBM 通常可以，MKV/AVI/WMV 多数不行），失败时页面给中文提示
export const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv'];
export const GIF_SOURCE_EXTS = [...TEXTURE_EXTS, ...VIDEO_EXTS];

export function isVideoName(name) {
  return VIDEO_EXTS.includes((name.split('.').pop() || '').toLowerCase());
}

function naturalKey(s) {
  return s
    .split(/(\d+)/)
    .map((t) => (/^\d+$/.test(t) ? parseInt(t, 10) : t.toLowerCase()));
}

export function naturalCompare(a, b) {
  const ka = naturalKey(a);
  const kb = naturalKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const x = ka[i] ?? '';
    const y = kb[i] ?? '';
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return x < y ? -1 : 1;
  }
  return 0;
}

let pickerInput = null;
function getPickerInput(multi, accept) {
  if (!pickerInput) {
    pickerInput = document.createElement('input');
    pickerInput.type = 'file';
    pickerInput.style.position = 'fixed';
    pickerInput.style.left = '-9999px';
    pickerInput.style.top = '0';
    document.body.appendChild(pickerInput);
  }
  pickerInput.multiple = multi;
  pickerInput.accept = accept;
  return pickerInput;
}

// 返回 [{name, path|null, file|null}]；opts 可传 {title, label} 改对话框标题和过滤器名
export async function pickImages(multi, exts = SUPPORTED_EXTS, opts = {}) {
  const accept = exts.map((e) => '.' + e).join(',');
  if (isTauri) {
    const paths = await window.__TAURI__.core.invoke('pick_images', {
      multi,
      exts,
      title: opts.title ?? null,
      label: opts.label ?? null,
    });
    if (!paths) return [];
    return paths.map((p) => ({ name: baseName(p), path: p, file: null }));
  }
  return new Promise((resolve) => {
    const input = getPickerInput(multi, accept);
    input.value = '';
    input.onchange = () => {
      resolve([...input.files].map((f) => ({ name: f.name, path: null, file: f })));
    };
    input.click();
  });
}

// 视频给 <video> 用的地址：Tauri 走 asset 协议直接从磁盘流式读（不把整段视频拉进内存），
// 浏览器没有 asset 协议，只能用 File 建 blob URL。返回值配 releaseSrc 释放。
export function videoSrc(entry) {
  if (entry.file) return URL.createObjectURL(entry.file);
  if (isTauri && entry.path) return window.__TAURI__.core.convertFileSrc(entry.path);
  return null;
}

export function releaseSrc(url) {
  if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
}

export async function readEntryBytes(entry) {
  if (entry.file) {
    // 自动化环境注入的 File 内容可能延迟就绪，内容为空时稍等重试
    for (let i = 0; ; i++) {
      const buf = new Uint8Array(await entry.file.arrayBuffer());
      if (buf.length || i >= 20) return buf;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const buf = await window.__TAURI__.core.invoke('read_file', { path: entry.path });
  // 走 ipc:// 自定义协议时是 ArrayBuffer；协议被拦截退化为 postMessage 时是数字数组
  return buf instanceof ArrayBuffer ? new Uint8Array(buf) : Uint8Array.from(buf);
}

export async function readImageBitmap(entry) {
  const bytes = await readEntryBytes(entry);
  if (!bytes.length) throw new Error('文件内容为空');
  const lower = entry.name.toLowerCase();
  if (lower.endsWith('.tga') || lower.endsWith('.targa')) {
    const { decodeTga } = await import('./tga.js');
    const img = decodeTga(bytes);
    return createImageBitmap(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height));
  }
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) {
    // WebView2 不认 TIFF，用自带的解码器转成 RGBA
    const { decodeTiff } = await import('./tiff.js');
    const img = await decodeTiff(bytes);
    return createImageBitmap(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height));
  }
  return createImageBitmap(new Blob([bytes]));
}

// 用系统默认程序打开文件或文件夹（浏览器环境做不到）。成功返回 null，失败返回一句中文原因。
export async function openPath(path) {
  if (!isTauri) return '浏览器环境里打不开资源管理器';
  if (!path) return '还没有可打开的路径';
  try {
    await window.__TAURI__.core.invoke('open_path', { path });
    return null;
  } catch (ex) {
    return String(ex?.message ?? ex);
  }
}

async function listDir(dir) {
  if (!isTauri || !dir) return null;
  try {
    return await window.__TAURI__.core.invoke('list_files', { dir });
  } catch {
    return null;
  }
}

// 选中同族 前缀_数字 帧时自动补全同目录序列（与源码一致）
export async function collectFramePaths(entries) {
  let files = [];
  for (const e of entries) {
    if (!isSupportedName(e.name)) continue;
    if (e.path) {
      if (!files.some((f) => f.path === e.path)) files.push(e);
    } else if (!files.some((f) => !f.path && f.name === e.name)) {
      files.push(e);
    }
  }
  if (!files.length || files.some((f) => !f.path)) {
    return files.sort((a, b) => naturalCompare(stemOf(a.name), stemOf(b.name)));
  }
  const re = /^(.*_)([0-9]+)$/;
  let folder = null;
  let prefix = null;
  let digits = 0;
  let expand = true;
  for (const f of files) {
    const m = re.exec(stemOf(f.name));
    const d = dirname(f.path);
    if (!m || !d) {
      expand = false;
      break;
    }
    if (folder === null) {
      folder = d;
      prefix = m[1];
      digits = m[2].length;
    } else if (d !== folder || m[1] !== prefix || m[2].length !== digits) {
      expand = false;
      break;
    }
  }
  if (expand && folder) {
    const all = (await listDir(folder)) || [];
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pat = new RegExp(`^${escaped}[0-9]{${digits}}$`);
    for (const p of all) {
      if (!pat.test(stemOf(baseName(p)))) continue;
      if (!files.some((f) => f.path === p)) {
        files.push({ name: baseName(p), path: p, file: null });
      }
    }
  }
  return files.sort((a, b) => naturalCompare(stemOf(a.name), stemOf(b.name)));
}

// 目标目录里已有同名文件时，在后缀前依次加 _1、_2…，避免覆盖原来的。
// 拿不到目录清单（浏览器环境或列目录失败）就按原名返回。
export async function uniqueFilename(dir, name) {
  if (!dir) return name;
  const files = await listDir(dir);
  if (!files) return name;
  const taken = new Set(files.map((p) => baseName(p).toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i++) {
    const cand = `${stem}_${i}${ext}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
}

// Tauri：sourceDir 为空时弹目录选择；浏览器：返回 null（走下载）
export async function resolveSaveDir(sourceDir) {
  if (sourceDir) return sourceDir;
  if (isTauri) return await window.__TAURI__.core.invoke('pick_dir');
  return null;
}

// dir 为 null 且不在 Tauri 时退化为浏览器下载；Tauri 下返回 null 表示取消
export async function saveBlob(filename, bytes, dir) {
  if (isTauri) {
    if (!dir) return null;
    const sep = dir.includes('\\') ? '\\' : '/';
    const path = dir.endsWith('\\') || dir.endsWith('/') ? dir + filename : dir + sep + filename;
    // 路径写在载荷头部（原始字节请求体无法带 JSON 参数）：[u32 路径长度][路径][文件字节]
    const pathBytes = new TextEncoder().encode(path);
    const buf = new Uint8Array(4 + pathBytes.length + bytes.length);
    new DataView(buf.buffer).setUint32(0, pathBytes.length, true);
    buf.set(pathBytes, 4);
    buf.set(bytes, 4 + pathBytes.length);
    await window.__TAURI__.core.invoke('write_file', buf);
    return path;
  }
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return filename;
}

export function onGlobalDrop(callback) {
  if (isTauri) {
    const win = window.__TAURI__.window.getCurrentWindow();
    win.onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === 'drop' && p.paths?.length) {
        callback(p.paths.map((path) => ({ name: baseName(path), path, file: null })));
      }
    });
  } else {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files || [])].map((f) => ({
        name: f.name,
        path: null,
        file: f,
      }));
      if (files.length) callback(files);
    });
  }
}
