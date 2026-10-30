// 自动关机页。
// 计时走前端 setInterval：软件退出计划就没了，这是选定的行为（不往系统里排 shutdown /t，
// 免得关掉软件之后还有台电脑在背后倒计时、又只能靠命令行撤回）。
// 到点执行时给 15 秒缓冲再交给 shutdown，界面上这段时间留着「中止」按钮反悔。
import { isTauri } from './platform.js';

const $ = (id) => document.getElementById(id);

/// 环的周长：r=88 → 2πr，dashoffset 按剩余比例推
const RING_C = 2 * Math.PI * 88;
/// 交给系统后的可撤回秒数
const GRACE_SEC = 15;
const MAX_MINUTES = 1440;

function fmtRemain(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const week = '日一二三四五六'[d.getDay()];
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 周${week} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function initShutdown() {
  const actOff = $('sd-act-off');
  const actReboot = $('sd-act-reboot');
  const trigCount = $('sd-trig-count');
  const trigClock = $('sd-trig-clock');
  const countBox = $('sd-count-box');
  const clockBox = $('sd-clock-box');
  const minsIn = $('sd-mins');
  const timeIn = $('sd-time');
  const clockHint = $('sd-clock-hint');
  const warnClose = $('sd-warn-close');
  const blockClose = $('sd-block-close');
  const startBtn = $('sd-start');
  const cancelBtn = $('sd-cancel');
  const resetBtn = $('sd-reset-defaults');
  const abortBtn = $('sd-abort');
  const remainEl = $('sd-remain');
  const targetEl = $('sd-target');
  const stateEl = $('sd-state-label');
  const powerEl = $('sd-power-line');
  const statusEl = $('sd-status');
  const ringFill = $('sd-ring-fill');
  const countdownEl = $('sd-countdown');
  const tabEl = $('tab-shutdown');

  let action = 'shutdown';
  let trigger = 'count';
  // idle = 没计划；armed = 倒计时中；firing = 已交给系统、正在 15 秒缓冲
  let state = 'idle';
  let targetTs = 0;
  let totalMs = 0;
  let tickTimer = 0;
  let warnedNearEnd = false;
  // 有风险（只用电池 / 策略不许关机）时，第一次点击只把风险讲清楚，第二次才真的排
  let riskAckAt = 0;

  function setStatus(msg, warn) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('warn', !!warn);
  }

  function setPower(msg, warn) {
    powerEl.textContent = msg || '';
    powerEl.classList.toggle('warn', !!warn);
  }

  function setSeg(btns, onEl) {
    for (const b of btns) b.classList.toggle('on', b === onEl);
  }

  function setRing(remaining) {
    const fraction = totalMs > 0 ? Math.min(1, Math.max(0, remaining / totalMs)) : 0;
    ringFill.style.strokeDashoffset = String(RING_C * (1 - fraction));
  }

  function setIdleRing() {
    totalMs = 0;
    setRing(0);
    remainEl.textContent = '--:--';
    countdownEl.classList.remove('running', 'urgent');
  }

  function pickAction(next) {
    if (state !== 'idle') return;
    action = next;
    setSeg([actOff, actReboot], next === 'shutdown' ? actOff : actReboot);
    refreshTarget();
  }

  function pickTrigger(next) {
    if (state !== 'idle') return;
    trigger = next;
    setSeg([trigCount, trigClock], next === 'count' ? trigCount : trigClock);
    countBox.hidden = next !== 'count';
    clockBox.hidden = next !== 'clock';
    refreshTarget();
  }

  // 只算目标时刻，不启动；用来给用户先看清「到底几点执行」
  function plan() {
    const now = Date.now();
    if (trigger === 'count') {
      const mins = Number(minsIn.value);
      if (!Number.isFinite(mins) || mins < 1) return { err: '请填写至少 1 分钟' };
      if (mins > MAX_MINUTES) return { err: `最多 ${MAX_MINUTES} 分钟（一天）` };
      return { ts: now + mins * 60_000, total: mins * 60_000 };
    }
    const value = timeIn.value;
    if (!value) return { err: '请先选一个执行时刻' };
    const [hh, mm] = value.split(':').map(Number);
    const d = new Date();
    d.setHours(hh, mm, 0, 0);
    // 时刻已过就顺延到明天：定点关机最常见的用法是「今天夜里」
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return { ts: d.getTime(), total: d.getTime() - now };
  }

  function refreshTarget() {
    if (state !== 'idle') return;
    const p = plan();
    if (p.err) {
      targetEl.textContent = '预计执行:-';
      clockHint.textContent = trigger === 'clock' ? '选好时刻后这里显示具体执行时间' : '';
      return;
    }
    targetEl.textContent = '预计执行:' + fmtClock(p.ts);
    if (trigger === 'clock') {
      const mins = Math.round(p.total / 60_000);
      clockHint.textContent = `距今约 ${mins} 分钟 · 过了今天该时刻则顺延到明天`;
    }
  }

  async function readPower() {
    if (!isTauri) {
      setPower('浏览器预览里不能执行关机，请用桌面版', true);
      return null;
    }
    try {
      const st = await window.__TAURI__.core.invoke('power_status');
      const supply = st.battery_present ? (st.ac_online ? '外接电源' : '电池') : '外接电源';
      const battery =
        st.battery_percent != null ? ` · 电池 ${st.battery_percent}%${st.charging ? ' 充电中' : ''}` : '';
      const risky = st.battery_present && !st.ac_online;
      setPower(`供电:${supply}${battery}${st.shutdown_allowed ? '' : ' · 电源策略不允许关机'}`, risky || !st.shutdown_allowed);
      return st;
    } catch (ex) {
      setPower('读不到电源状态：' + String(ex?.message ?? ex), true);
      return null;
    }
  }

  function tick() {
    const remain = targetTs - Date.now();
    if (remain <= 0) {
      setRing(0);
      remainEl.textContent = '00:00';
      fire();
      return;
    }
    remainEl.textContent = fmtRemain(remain);
    setRing(remain);
    countdownEl.classList.toggle('urgent', remain <= 60_000);
    if (warnClose.checked && !warnedNearEnd && remain <= 60_000) {
      warnedNearEnd = true;
      setStatus(`不到 1 分钟了（${fmtClock(targetTs)} 执行），还没存的文件请现在保存`, true);
    }
  }

  function stopTick() {
    clearInterval(tickTimer);
    tickTimer = 0;
  }

  async function fire() {
    // 倒计时归零和重复点击都走这里，进过一次就不再重入
    if (state === 'firing') return;
    stopTick();
    state = 'firing';
    const label = action === 'shutdown' ? '关机' : '重启';
    cancelBtn.disabled = true;
    startBtn.disabled = true;
    resetBtn.disabled = true;
    stateEl.textContent = label + '进行中';
    setStatus(`已请求${label}，${GRACE_SEC} 秒内还能点「中止」撤回`, true);
    try {
      await window.__TAURI__.core.invoke('power_action', { action, delay: GRACE_SEC });
    } catch (ex) {
      state = 'idle';
      abortBtn.hidden = true;
      startBtn.disabled = false;
      cancelBtn.disabled = true;
      resetBtn.disabled = false;
      stateEl.textContent = '未开始';
      setIdleRing();
      setStatus(`${label}没排上：` + String(ex?.message ?? ex), true);
      return;
    }
    abortBtn.hidden = false;
    let left = GRACE_SEC;
    abortBtn.textContent = `中止${label}(${left} 秒)`;
    const grace = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(grace);
        abortBtn.hidden = true;
        stateEl.textContent = '已交给系统';
        setStatus(`已交给系统执行${label}，本软件不再插手`);
        return;
      }
      abortBtn.textContent = `中止${label}(${left} 秒)`;
    }, 1000);
  }

  async function arm() {
    if (state !== 'idle') return;
    const p = plan();
    if (p.err) {
      setStatus(p.err, true);
      return;
    }
    const st = await readPower();
    if (!st) return;
    const risks = [];
    if (st.battery_present && !st.ac_online) risks.push('现在只靠电池供电，电池耗尽会提前断电');
    if (!st.shutdown_allowed) risks.push('电源策略里不允许关机，到点可能被系统拒绝');
    if (risks.length && Date.now() - riskAckAt > 30_000) {
      riskAckAt = Date.now();
      startBtn.textContent = '仍要开始计时';
      setStatus(risks.join('；') + '。确认无误请再点一次', true);
      return;
    }
    riskAckAt = 0;
    targetTs = p.ts;
    totalMs = p.total;
    warnedNearEnd = false;
    state = 'armed';
    setRing(totalMs);
    remainEl.textContent = fmtRemain(totalMs);
    countdownEl.classList.add('running');
    stateEl.textContent = (action === 'shutdown' ? '关机' : '重启') + '倒计时';
    targetEl.textContent = '预计执行:' + fmtClock(targetTs);
    startBtn.disabled = true;
    cancelBtn.disabled = false;
    resetBtn.disabled = true;
    for (const b of [actOff, actReboot, trigCount, trigClock]) b.disabled = true;
    minsIn.disabled = true;
    timeIn.disabled = true;
    setStatus(`已排定：${fmtClock(targetTs)} ${action === 'shutdown' ? '关机' : '重启'}。本软件退出后这个计划就作废`);
    tick();
    tickTimer = setInterval(tick, 250);
  }

  function disarm(msg) {
    stopTick();
    state = 'idle';
    abortBtn.hidden = true;
    startBtn.disabled = false;
    cancelBtn.disabled = true;
    resetBtn.disabled = false;
    startBtn.textContent = '开始计时';
    riskAckAt = 0;
    for (const b of [actOff, actReboot, trigCount, trigClock]) b.disabled = false;
    minsIn.disabled = false;
    timeIn.disabled = false;
    stateEl.textContent = '未开始';
    setIdleRing();
    refreshTarget();
    if (msg) setStatus(msg);
  }

  async function abort() {
    abortBtn.disabled = true;
    try {
      await window.__TAURI__.core.invoke('power_action', { action: 'abort', delay: null });
      abortBtn.disabled = false;
      disarm('已撤回，系统不会再关机或重启');
    } catch (ex) {
      abortBtn.disabled = false;
      setStatus('撤回失败：' + String(ex?.message ?? ex), true);
    }
  }

  function resetDefaults() {
    if (state !== 'idle') return;
    minsIn.value = '30';
    timeIn.value = '23:30';
    warnClose.checked = true;
    blockClose.checked = true;
    minsIn.disabled = false;
    timeIn.disabled = false;
    pickTrigger('count');
    pickAction('shutdown');
    setStatus('已恢复默认设置');
  }

  actOff.addEventListener('click', () => pickAction('shutdown'));
  actReboot.addEventListener('click', () => pickAction('reboot'));
  trigCount.addEventListener('click', () => pickTrigger('count'));
  trigClock.addEventListener('click', () => pickTrigger('clock'));
  startBtn.addEventListener('click', arm);
  cancelBtn.addEventListener('click', () => disarm('已取消计时'));
  abortBtn.addEventListener('click', abort);
  resetBtn.addEventListener('click', resetDefaults);
  minsIn.addEventListener('input', () => {
    riskAckAt = 0;
    if (startBtn.textContent !== '开始计时') startBtn.textContent = '开始计时';
    refreshTarget();
  });
  timeIn.addEventListener('input', () => {
    riskAckAt = 0;
    refreshTarget();
  });

  // 电源状态和计划时刻在点页签时刷一次：插没插电源这种事随时会变
  tabEl.addEventListener('click', () => {
    readPower();
    refreshTarget();
  });

  if (!isTauri) {
    startBtn.disabled = true;
    resetBtn.disabled = true;
    setPower('浏览器预览里不能执行关机，请用桌面版', true);
  } else {
    readPower();
  }
  refreshTarget();

  return {
    // 关窗口会连计划一起没了，所以 main.js 的关闭按钮要先问一句
    isArmed() {
      return state !== 'idle';
    },
    blocksClose() {
      return blockClose.checked && state !== 'idle';
    },
    // 被拦下时把原因写回本页状态行，用户看得见才谈得上「再点一次确认」
    reportCloseBlocked() {
      const label = action === 'shutdown' ? '关机' : '重启';
      if (state === 'firing') {
        setStatus(`${label}已经交给系统，关掉本软件并不会取消它。要撤回请点「中止」；确实要关，再点一次关闭`, true);
        return;
      }
      setStatus(`关闭软件会让${label}计划失效。要放弃计划请先点「取消计时」；确实要关，再点一次关闭`, true);
    },
  };
}
