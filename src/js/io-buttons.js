// 每个页面板的「打开…」入口：只负责把最近一次的源文件 / 导出文件路径记下来，
// 再按路径决定哪个能点，实际打开走 Rust 的 open_path（explorer）。
// 七个页共用这一份，页面里只需要 io.setSource(...) / io.setExport(...) 两处调用。
// 形态是文字链，挂在各页结果信息行（或状态行）的右端，不单独占一行。
import { isTauri, openPath, dirname } from './platform.js';

export function createIoButtons(container, setStatus) {
  const mk = (label, title) => {
    const b = document.createElement('button');
    b.className = 'io-link';
    b.textContent = label;
    b.title = title;
    b.disabled = true;
    container.appendChild(b);
    return b;
  };
  const fileBtn = mk('打开文件', '用系统默认程序打开最近导出的文件');
  const outDirBtn = mk('导出目录', '打开最近导出所在的文件夹');
  const srcDirBtn = mk('源目录', '打开源文件所在的文件夹');

  let src = null;
  let out = null;

  const sync = () => {
    fileBtn.disabled = !out;
    outDirBtn.disabled = !out;
    srcDirBtn.disabled = !src;
  };

  const go = async (path) => {
    const err = await openPath(path);
    if (err) setStatus(err, true);
  };
  fileBtn.addEventListener('click', () => out && go(out));
  outDirBtn.addEventListener('click', () => out && go(dirname(out)));
  srcDirBtn.addEventListener('click', () => src && go(dirname(src)));

  // 浏览器等价环境没有资源管理器可开，整行藏掉，免得点了只报错
  container.hidden = !isTauri;
  sync();

  return {
    setSource(path) {
      src = path || null;
      sync();
    },
    // 导出成功就把完整路径记下来；重新载入源文件时要清掉（setSource 不动它，由页面决定）
    setExport(path) {
      out = path || null;
      sync();
    },
    clear() {
      src = null;
      out = null;
      sync();
    },
  };
}
