// Run on: CPU. The big models (High detail, Hair & fur) don't fit the CPU engine's memory, so they're
// unavailable there and a removal with one of them remembered runs Fast instead of failing.
// Uses the real remover. Run on a fresh page: (await import("/_test/bgcputest.js")).run()
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  const c = new OffscreenCanvas(640, 480), g = c.getContext("2d");
  g.fillStyle = "#dfe6ee"; g.fillRect(0, 0, 640, 480); g.fillStyle = "#c0392b"; g.beginPath(); g.ellipse(320, 260, 130, 170, 0, 0, 7); g.fill();
  await q.openNew([new File([await c.convertToBlob({ type: "image/png" })], "cpu.png", { type: "image/png" })]);
  await wait(300);
  v.querySelector('[data-tool="move"]').click(); // the Remove background button lives on the Move bar
  await wait(150);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); // a tool flyout, if one opened
  await wait(150);
  localStorage.setItem("quickcut.photo.bgq", "hq"); // High detail remembered from before
  const menu = async () => { v.querySelector('[data-p="bgmenu"]').click(); await wait(2500); return document.querySelector(".ph-bgmenu"); };
  let m = await menu();
  m.querySelector('[data-ep="wasm"]').click();
  await wait(200);
  const state = (id) => document.querySelector(`.ph-bgmenu [data-q="${id}"]`)?.getAttribute("aria-disabled") === "true";
  ok("CPU: High detail unavailable", state("hq"));
  ok("CPU: Hair & fur unavailable", state("soft"));
  ok("CPU: Fast available", !state("fast"));
  m.querySelector('[data-ep="auto"]').click();
  await wait(200);
  ok("GPU again: High detail available", !state("hq"));
  m.querySelector('[data-ep="wasm"]').click();
  await wait(200);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  await wait(200);
  v.querySelector('[data-p="rmbg"]').click();
  await wait(1500);
  document.querySelector('.ph-bgask [data-b="go"]')?.click();
  const t0 = performance.now();
  while (!q.doc.layers.at(-1).mask && performance.now() - t0 < 180000) await wait(300);
  ok("removal worked on the CPU", !!q.doc.layers.at(-1).mask && q.stats.bg?.ep === "wasm", q.stats.bg && `${q.stats.bg.ep} ${q.stats.bg.quality}`);
  ok("…with Fast", q.stats.bg?.quality === "fast", q.stats.bg?.quality);
  localStorage.removeItem("quickcut.photo.bgq");
  localStorage.removeItem("quickcut.photo.bgep");
  return { pass: !fails.length, fails, out };
}
