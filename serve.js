// 极简静态文件服务器:用 Node 内置模块,无需任何依赖.
// 用法:node serve.js [端口]   默认端口 8080
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, 'src');
const port = Number(process.argv[2]) || 8080;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

http
  .createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(root, p);
    // 防止目录穿越
    if (!f.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(f, (e, d) => {
      if (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not found: ' + p);
        return;
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' });
      res.end(d);
    });
  })
  .listen(port, () => {
    console.log(`静态服务器已启动: http://localhost:${port}`);
    console.log(`服务目录:${root}`);
  });
