// 把 tex-worker.js 包成一个「永远跟着最新参数走」的调用器。
// 关键点：同时只挂一个在算的请求。算的过程中滑块又动了，就把新参数记在一份槽里覆盖旧的，
// 这一轮一落地立刻补算——所以拖动时看到的是连续更新，而不是排队的旧参数，
// 也不会因为堆了几十个 2048 的任务而越拖越慢。
// worker 建不起来（协议限制、老内核）时 compute() 回退到主线程同步跑，行为同旧版。
const WORKER_URL = new URL('tex-worker.js', import.meta.url);

export function makeTexClient({ kind, compute, metricsOf, apply }) {
  let worker = null;
  let broken = false;
  let nextId = 1;
  let running = 0; // 正在算的请求号；0 表示空闲
  let runningOpts = null; // 那一份请求的参数，结果落地时一并交给 apply（界面上的文字要按它来写）
  let queued = null; // {id, opts}：在算期间收到的最新参数
  let loadHook = null; // load() 的 resolve
  const waiters = []; // {id, done}：每个 request() 的调用方，等「至少这一份」结果落地

  // 结果落地后，把这一号及更早的等待者一律放行（被覆盖掉的旧请求也一起结，await 不会吊死）
  function flush(upTo) {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].id <= upTo) {
        const w = waiters[i];
        waiters.splice(i, 1);
        w.done();
      }
    }
  }

  function fallback(opts) {
    const t0 = performance.now();
    let out;
    try {
      out = compute(opts);
    } catch (ex) {
      apply({ ok: false, opts, message: String(ex?.message ?? ex) });
      return Promise.resolve();
    }
    apply({ ok: true, opts, ms: performance.now() - t0, data: out.data, metrics: out.metrics });
    return Promise.resolve();
  }

  function pump() {
    if (running || !queued) return;
    const q = queued;
    queued = null;
    running = q.id;
    runningOpts = q.opts;
    worker.postMessage({ type: 'run', id: q.id, kind, opts: q.opts });
  }

  function ensure() {
    if (worker || broken) return worker;
    try {
      const w = new Worker(WORKER_URL, { type: 'module' });
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'loaded') {
          const done = loadHook;
          loadHook = null;
          done?.(m.metrics);
          return;
        }
        // 换图后旧请求的结果：不画，但要让对应的 await 结掉
        if (m.id !== running) {
          flush(m.id);
          return;
        }
        running = 0;
        const opts = runningOpts;
        runningOpts = null;
        if (m.type === 'error') apply({ ok: false, opts, message: m.message });
        else apply({ ok: true, opts, ms: m.ms, data: m.data, metrics: m.metrics });
        flush(m.id);
        pump();
      };
      // 任何 worker 级故障（脚本载入失败、post 报错）都永久退回主线程
      const giveUp = () => {
        broken = true;
        worker = null;
        running = 0;
        queued = null;
        loadHook?.(null);
        loadHook = null;
      };
      w.onerror = (ev) => {
        ev.preventDefault?.();
        giveUp();
      };
      w.onmessageerror = giveUp;
      worker = w;
    } catch {
      broken = true;
      worker = null;
    }
    return worker;
  }

  return {
    // 图像搬进 worker：传一份拷贝，主线程的 imgData 还要用于回退路径和导出
    load(img) {
      const w = ensure();
      if (!w) return Promise.resolve(metricsOf ? metricsOf(img) : null);
      const copy = new Uint8ClampedArray(img.data);
      const p = new Promise((done) => {
        loadHook = done;
      });
      w.postMessage({ type: 'load', width: img.width, height: img.height, data: copy }, [copy.buffer]);
      return p;
    },

    // 清空时把 worker 里的图像也丢掉，别一直占着 16MB
    unload() {
      if (!worker) return;
      const empty = new Uint8ClampedArray(0);
      worker.postMessage({ type: 'load', width: 0, height: 0, data: empty }, [empty.buffer]);
      running = 0;
      queued = null;
    },

    request(opts) {
      const w = ensure();
      if (!w) return fallback(opts);
      const id = nextId++;
      const p = new Promise((done) => waiters.push({ id, done }));
      queued = { id, opts };
      pump();
      return p;
    },
  };
}
