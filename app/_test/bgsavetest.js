// When the browser can't keep the downloaded model (private window, full disk), loading it a second
// time in the same worker (a retry, or a second run) must not download it again, and the worker
// must say the model wasn't saved.
// Run on any page of the site: (await import("/_test/bgsavetest.js")).run()
export async function run() {
  const w = new Worker(new URL("./bgsave-worker.js", import.meta.url), { type: "module" });
  let n = 0;
  const call = (msg) => new Promise((res, rej) => {
    const id = ++n;
    const on = (e) => { if (e.data?.id !== id || e.data.progress) return; w.removeEventListener("message", on); e.data.error ? rej(new Error(e.data.error)) : res(e.data); };
    w.addEventListener("message", on);
    w.postMessage({ ...msg, id });
  });
  const parts = () => new Promise((res) => { const on = (e) => { if ("parts" in e.data) { w.removeEventListener("message", on); res(e.data.parts); } }; w.addEventListener("message", on); w.postMessage({ op: "parts" }); });
  await new Promise((r) => { const on = (e) => { if (e.data?.ready) { w.removeEventListener("message", on); r(); } }; w.addEventListener("message", on); }); // the harness has loaded the worker
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  try {
    // two loads with different settings, as a GPU failure followed by the CPU retry does
    const a = await call({ op: "init", model: "birefnet-512", ep: "wasm" });
    const p1 = await parts();
    ok("first load downloads", p1 > 0, p1);
    ok("first load says not saved", a.unsaved === true, a.unsaved);
    await call({ op: "init", model: "birefnet-512", ep: "auto" });
    const p2 = await parts();
    ok("second load doesn't download again", p2 === p1, `${p1} -> ${p2}`);
  } finally { w.terminate(); }
  return { pass: !fails.length, fails, out };
}
