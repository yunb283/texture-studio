// 临时验证服务：复制 src -> tmp/gvh，打三处补丁（显示 io 链接 / 默认停在 GIF 预览页 /
// 把页面内部函数挂到 window 上好在浏览器里驱动），并把 tmp/fx 下的 GIF 一起发出去。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, rmSync, cpSync, mkdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = join(import.meta.dirname, 'gvh');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
cpSync(join(import.meta.dirname, '..', 'src'), root, { recursive: true });

const edit = (rel, from, to) => {
  const p = join(root, rel);
  let s = readFileSync(p, 'utf8');
  if (!s.includes(from)) throw new Error(`${rel}: 找不到「${from}」`);
  writeFileSync(p, s.replace(from, to));
};

edit('js/io-buttons.js', 'container.hidden = !isTauri', 'container.hidden = false');
edit('js/main.js', "showTab('split');", "showTab('gifview');\nwindow.__view = gvView;");
edit(
  'js/gif-view-page.js',
  '  return { loadEntry };',
  `  window.__gv = {
    loadEntry,
    showFrame,
    frameOf,
    paint,
    pctx,
    get parsed() { return parsed; },
    get frameIndex() { return frameIndex; },
    get cacheSize() { return cache.size; },
  };
  return { loadEntry };`
);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.gif': 'image/gif' };
createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const p = url.startsWith('/fx/') ? join(import.meta.dirname, url) : join(root, url === '/' ? 'index.html' : url);
  if (!existsSync(p) || !statSync(p).isFile()) {
    res.writeHead(404).end('no');
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p));
}).listen(8733, '127.0.0.1', () => console.log('serving on 8733'));
