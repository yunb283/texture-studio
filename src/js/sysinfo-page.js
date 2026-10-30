// 电脑配置页。
// 默认只列基础项：Rust 侧走注册表 + Win32 API，毫秒级返回，点页签就能看到内容。
// 「详细配置」才发起一次 WMI 查询（内存条、磁盘介质、驱动版本、序列号这些只有 WMI 有），
// 代价 1~3 秒，所以拿到原始 JSON 后缓存起来，来回切档不重复查。
// 字段取舍和措辞属于显示层，全部留在这里，不往 Rust 里塞。
import { isTauri } from './platform.js';

const $ = (id) => document.getElementById(id);

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;
const TIB = GIB * 1024;

function trimOne(v) {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// 和 Rust 侧同一套显示口径：按二进制算，但按资源管理器的写法标 GB
function humanBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= TIB) return trimOne(v / TIB) + ' TB';
  if (v >= GIB) return trimOne(v / GIB) + ' GB';
  if (v >= MIB) return trimOne(v / MIB) + ' MB';
  return trimOne(v / KIB) + ' KB';
}

function humanMhz(n) {
  const v = Number(n);
  if (!v) return '';
  return v >= 1000 ? trimOne(v / 1000) + ' GHz' : v + ' MHz';
}

// WMI 的日期形如 2024-05-01T09:12:33.123456+08:00
function dayOnly(s) {
  return s ? String(s).slice(0, 10) : '';
}

function dateTimeOnly(s) {
  return s ? String(s).slice(0, 19).replace('T', ' ') : '';
}

// ConvertTo-Json 对单元素数组偶尔会退化成对象，这里统一成数组
function rows(json, key) {
  const v = json && json[key];
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v];
}

function one(json, key) {
  return rows(json, key)[0] || {};
}

// WMI 里没取到值时是 null，直接拼进文案会留下 "null"
function text(row, key) {
  const v = row && row[key];
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.filter(Boolean).join(', ');
  return String(v);
}

function add(fields, name, value) {
  const v = typeof value === 'number' ? String(value) : (value || '').trim();
  if (v) fields.push({ name, value: v });
}

function mkGroup(title, fields) {
  return fields.length ? { title, fields } : null;
}

// SMBIOSMemoryType 是 SMBIOS 原始码：18 DDR / 19 DDR2 / 24 DDR3 / 26 DDR4 是确定的，
// 34 这一档 DDR5 和板载 LPDDR5 都会报（本机实测 i7-12650H 的板载 LPDDR5 就是 34），
// 所以写成两者并列，别硬猜单一型号；其余码不确定的一律留空，不编名字
const MEM_TYPE = { 18: 'DDR', 19: 'DDR2', 24: 'DDR3', 26: 'DDR4', 34: 'DDR5 / LPDDR5' };
const SYSTEM_TYPE = { 1: '台式机', 2: '笔记本', 3: '工作站', 4: '服务器' };
const BATTERY_STATUS = { 1: '电池供电', 2: '外接电源', 3: '充满', 4: '电量低' };

// 投屏/远程工具注册的假显卡没有显存也没有分辨率，和 Rust 侧基础档同一套过滤
function isVirtualGpu(name) {
  const lower = String(name || '').toLowerCase();
  return lower.includes('virtual') || lower.includes('remote display');
}

// 详细配置：把 WMI 的几张表拼成人能读的分组
function detailGroups(d) {
  const os = one(d, 'os');
  const cs = one(d, 'cs');
  const enc = one(d, 'enc');
  const board = one(d, 'board');
  const bios = one(d, 'bios');
  const groups = [];

  const sys = [];
  add(sys, '完整系统名', text(os, 'Caption'));
  add(sys, '版本', [text(os, 'Version'), text(os, 'BuildType')].filter(Boolean).join(' · '));
  add(sys, '系统序列号', text(os, 'SerialNumber'));
  add(sys, '系统盘', text(os, 'SystemDrive'));
  add(sys, 'Windows 目录', text(os, 'WindowsDirectory'));
  add(sys, '安装于', dateTimeOnly(os.InstallDate));
  add(sys, '上次启动', dateTimeOnly(os.LastBootUpTime));
  groups.push(mkGroup('系统（WMI）', sys));

  const machine = [];
  add(machine, '制造商', text(cs, 'Manufacturer'));
  add(machine, '型号', text(cs, 'Model'));
  add(machine, '系列', text(cs, 'SystemFamily'));
  add(machine, '机型', SYSTEM_TYPE[Number(cs.PCSystemType)] || text(cs, 'PCSystemType'));
  add(machine, '域 / 工作组', text(cs, 'Domain'));
  add(machine, '机箱制造商', text(enc, 'Manufacturer'));
  add(machine, '机箱序列号', text(enc, 'SerialNumber'));
  groups.push(mkGroup('机器', machine));

  const mainboard = [];
  add(mainboard, '主板制造商', text(board, 'Manufacturer'));
  add(mainboard, '主板型号', text(board, 'Product'));
  add(mainboard, '主板版本', text(board, 'Version'));
  add(mainboard, 'BIOS 厂商', text(bios, 'Manufacturer'));
  add(mainboard, 'BIOS 版本', text(bios, 'SMBIOSBIOSVersion'));
  add(mainboard, 'BIOS 日期', dayOnly(bios.ReleaseDate));
  add(mainboard, 'BIOS 序列号', text(bios, 'SerialNumber'));
  groups.push(mkGroup('主板与 BIOS', mainboard));

  const cpus = rows(d, 'cpu');
  cpus.forEach((cpu, i) => {
    const fields = [];
    const more = cpus.length > 1 ? ` ${i + 1}` : '';
    add(fields, '名称', text(cpu, 'Name'));
    add(fields, '制造商', text(cpu, 'Manufacturer'));
    add(fields, '描述', text(cpu, 'Description'));
    add(fields, '物理核心', text(cpu, 'NumberOfCores'));
    add(fields, '逻辑处理器', text(cpu, 'NumberOfLogicalProcessors'));
    add(fields, '基准主频', humanMhz(cpu.MaxClockSpeed));
    add(fields, '当前主频', humanMhz(cpu.CurrentClockSpeed));
    add(fields, '二级缓存', cpu.L2CacheSize ? cpu.L2CacheSize + ' KB' : '');
    add(fields, '三级缓存', cpu.L3CacheSize ? cpu.L3CacheSize + ' KB' : '');
    add(fields, '插槽', text(cpu, 'SocketDesignation'));
    add(fields, '虚拟化', cpu.VirtualizationFirmwareEnabled === true ? '已开启' : cpu.VirtualizationFirmwareEnabled === false ? '未开启' : '');
    groups.push(mkGroup('处理器' + more, fields));
  });

  const mods = rows(d, 'mem');
  const memFields = [];
  const totalCap = mods.reduce((sum, m) => sum + (Number(m.Capacity) || 0), 0);
  add(memFields, '插槽条数', mods.length ? `${mods.length} 条` : '');
  add(memFields, '合计容量', humanBytes(totalCap));
  add(memFields, '装机总内存', humanBytes(cs.TotalPhysicalMemory));
  mods.forEach((m, i) => {
    const line = [
      humanBytes(m.Capacity),
      MEM_TYPE[Number(m.SMBIOSMemoryType)] || '',
      m.ConfiguredClockSpeed ? m.ConfiguredClockSpeed + ' MHz' : '',
      text(m, 'Manufacturer'),
      text(m, 'PartNumber'),
    ]
      .filter(Boolean)
      .join(' · ');
    add(memFields, text(m, 'DeviceLocator') || `条 ${i + 1}`, line);
  });
  groups.push(mkGroup('内存条', memFields));

  const gpus = rows(d, 'gpu').filter((g) => !isVirtualGpu(g.Name));
  gpus.forEach((g, i) => {
    const fields = [];
    const more = gpus.length > 1 ? ` ${i + 1}` : '';
    add(fields, '名称', text(g, 'Name'));
    add(fields, '芯片厂商', text(g, 'AdapterCompatibility'));
    add(fields, '显存', humanBytes(g.AdapterRAM));
    add(fields, '驱动版本', text(g, 'DriverVersion'));
    add(fields, '驱动日期', dayOnly(g.DriverDate));
    add(
      fields,
      '当前模式',
      g.CurrentHorizontalResolution
        ? `${g.CurrentHorizontalResolution} × ${g.CurrentVerticalResolution} @ ${g.CurrentRefreshRate} Hz`
        : ''
    );
    add(fields, 'GPU 型号串', text(g, 'VideoProcessor'));
    groups.push(mkGroup('显卡' + more, fields));
  });

  // Get-PhysicalDisk 的 MediaType 才是 SSD / HDD 的正解；
  // Win32_DiskDrive.MediaType 只会笼统写 "Fixed hard disk media"，用它当型号补充
  const pdisk = rows(d, 'pdisk');
  const diskFields = [];
  pdisk.forEach((p, i) => {
    add(
      diskFields,
      text(p, 'FriendlyName') || `磁盘 ${i}`,
      [
        p.MediaType === 'SSD' ? '固态硬盘' : p.MediaType === 'HDD' ? '机械硬盘' : text(p, 'MediaType'),
        text(p, 'BusType'),
        humanBytes(p.Size),
        text(p, 'HealthStatus'),
      ]
        .filter(Boolean)
        .join(' · ')
    );
  });
  rows(d, 'disk').forEach((disk, i) => {
    add(
      diskFields,
      '磁盘 ' + (text(disk, 'Index') || i),
      [
        text(disk, 'Model'),
        text(disk, 'InterfaceType'),
        humanBytes(disk.Size),
        disk.Partitions ? disk.Partitions + ' 分区' : '',
      ]
        .filter(Boolean)
        .join(' · ')
    );
  });
  groups.push(mkGroup('物理磁盘', diskFields));

  const volFields = [];
  const DRIVE_TYPE = { 0: '未知', 1: '无根目录', 2: '可移动', 3: '本地固定', 4: '网络', 5: '光驱', 6: '内存盘' };
  rows(d, 'vol').forEach((v) => {
    const free = humanBytes(v.FreeSpace);
    const total = humanBytes(v.Size);
    add(
      volFields,
      [text(v, 'DeviceID'), text(v, 'VolumeName')].filter(Boolean).join(' '),
      [
        text(v, 'FileSystem'),
        DRIVE_TYPE[Number(v.DriveType)] || '',
        free && '可用 ' + free,
        total && '/ 共 ' + total,
      ]
        .filter(Boolean)
        .join(' · ')
    );
  });
  groups.push(mkGroup('分区', volFields));

  const netFields = [];
  rows(d, 'net').forEach((n, i) => {
    add(
      netFields,
      text(n, 'Description') || `网卡 ${i + 1}`,
      [
        text(n, 'IPAddress'),
        text(n, 'MACAddress'),
        text(n, 'DefaultIPGateway') ? '网关 ' + text(n, 'DefaultIPGateway') : '',
        n.DHCPEnabled === true ? 'DHCP' : n.DHCPEnabled === false ? '静态地址' : '',
      ]
        .filter(Boolean)
        .join(' · ')
    );
  });
  groups.push(mkGroup('网络', netFields));

  const batFields = [];
  rows(d, 'bat').forEach((b) => {
    add(
      batFields,
      text(b, 'Name'),
      [b.EstimatedChargeRemaining ? b.EstimatedChargeRemaining + '%' : '', BATTERY_STATUS[Number(b.BatteryStatus)] || '']
        .filter(Boolean)
        .join(' · ')
    );
  });
  groups.push(mkGroup('电池', batFields));

  return groups.filter(Boolean);
}

export function initSysInfo() {
  const listEl = $('si-list');
  const infoEl = $('si-info');
  const statusEl = $('si-status');
  const uptimeEl = $('si-uptime');
  const copyBtn = $('si-copy');
  const refreshBtn = $('si-refresh');
  const basicBtn = $('si-mode-basic');
  const detailBtn = $('si-mode-detail');
  const tabEl = $('tab-sysinfo');

  let mode = 'basic';
  let basic = null;
  let detail = null;
  let loaded = false;
  let busy = false;
  // 当前显示的那几组，「复制全部」直接用它，免得再从 DOM 反查
  let shown = [];

  function setStatus(msg, warn) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('warn', !!warn);
  }

  function setInfo(msg) {
    infoEl.textContent = msg || '';
    infoEl.classList.toggle('warn', false);
  }

  function render(groups) {
    shown = groups || [];
    listEl.innerHTML = '';
    if (!shown.length) {
      const empty = document.createElement('div');
      empty.className = 'si-empty';
      empty.textContent = '没有读到任何项';
      listEl.appendChild(empty);
      copyBtn.disabled = true;
      return;
    }
    for (const g of shown) {
      const box = document.createElement('div');
      box.className = 'si-group';
      const title = document.createElement('div');
      title.className = 'si-group-title';
      title.textContent = g.title;
      box.appendChild(title);
      for (const f of g.fields) {
        const row = document.createElement('div');
        row.className = 'si-row';
        const k = document.createElement('span');
        k.className = 'si-k';
        k.textContent = f.name;
        k.title = f.name;
        const v = document.createElement('span');
        v.className = 'si-v';
        v.textContent = f.value;
        row.append(k, v);
        box.appendChild(row);
      }
      listEl.appendChild(box);
    }
    copyBtn.disabled = false;
  }

  function markLoaded(prefix) {
    const now = new Date();
    const hhmm = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((n) => String(n).padStart(2, '0'))
      .join(':');
    const count = shown.reduce((sum, g) => sum + g.fields.length, 0);
    setInfo(`${prefix} · ${shown.length} 组 ${count} 项 · 读取于 ${hhmm}`);
  }

  async function loadBasic(force) {
    if (basic && !force) return true;
    try {
      basic = await window.__TAURI__.core.invoke('sysinfo_basic');
      return true;
    } catch (ex) {
      setStatus(String(ex?.message ?? ex), true);
      return false;
    }
  }

  async function loadDetail(force) {
    if (detail && !force) return true;
    setStatus('正在读取详细配置，约 1~3 秒…');
    try {
      detail = await window.__TAURI__.core.invoke('sysinfo_detail');
      return true;
    } catch (ex) {
      detail = null;
      setStatus('详细配置没读到：' + String(ex?.message ?? ex), true);
      return false;
    }
  }

  // 顶部这一栏跟着两档配置一起刷：读的是系统运行时长，一个 API 调用，不占详细档的 WMI 时间
  async function loadUptime() {
    try {
      const val = await window.__TAURI__.core.invoke('sysinfo_uptime');
      uptimeEl.textContent = '本次开机 ' + (val || '-');
    } catch (ex) {
      uptimeEl.textContent = '本次开机 -';
    }
  }

  async function show(next, force) {
    if (busy) return;
    mode = next;
    basicBtn.classList.toggle('on', next === 'basic');
    detailBtn.classList.toggle('on', next === 'detail');
    busy = true;
    refreshBtn.disabled = true;
    try {
      await loadUptime();
      if (next === 'basic') {
        if (await loadBasic(force)) {
          render(basic);
          markLoaded('基础配置');
          setStatus('');
        }
      } else {
        // 刷新要作废缓存：详细档的意义就是「重新问一遍系统」
        if (force) detail = null;
        if (await loadDetail(false)) {
          render(detailGroups(detail));
          markLoaded('详细配置');
          setStatus('');
        }
      }
    } finally {
      busy = false;
      loaded = true;
      refreshBtn.disabled = false;
    }
  }

  async function copyAll() {
    if (!shown.length) return;
    const lines = [];
    for (const g of shown) {
      lines.push('[' + g.title + ']');
      for (const f of g.fields) lines.push(`${f.name}: ${f.value}`);
      lines.push('');
    }
    const text2 = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text2);
      setStatus('已复制 ' + shown.length + ' 组配置到剪贴板');
    } catch (ex) {
      // WebView2 里剪贴板要窗口有焦点，抢不到焦点时退回旧写法
      const ta = document.createElement('textarea');
      ta.value = text2;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      setStatus(ok ? '已复制 ' + shown.length + ' 组配置到剪贴板' : '复制失败：' + String(ex?.message ?? ex), !ok);
    }
  }

  basicBtn.addEventListener('click', () => show('basic'));
  detailBtn.addEventListener('click', () => show('detail'));
  copyBtn.addEventListener('click', copyAll);
  refreshBtn.addEventListener('click', () => show(mode, true));

  // 点页签才读取：启动时不去抢序列化和 WMI 的时间
  tabEl.addEventListener('click', () => {
    if (!loaded) show(mode);
  });

  if (!isTauri) {
    loaded = true;
    render(null);
    setInfo('未读取');
    setStatus('浏览器预览读不到本机配置，请用桌面版');
    refreshBtn.disabled = true;
    detailBtn.disabled = true;
  }
}
