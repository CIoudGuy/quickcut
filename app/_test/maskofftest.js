// Hiding the mask of a background-removed layer shows the original photo (not the copy with cleaned
// edge colours, which only belongs with the cut-out); showing it again gives the cut-out back.
// Uses the real remover. Run on a fresh page: (await import("/_test/maskofftest.js")).run()
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  const c = new OffscreenCanvas(640, 480), g = c.getContext("2d");
  g.fillStyle = "#b8d0e8"; g.fillRect(0, 0, 640, 480);
  g.fillStyle = "#7a2f1d"; g.beginPath(); g.ellipse(320, 260, 130, 170, 0, 0, 7); g.fill();
  await q.openNew([new File([await c.convertToBlob({ type: "image/png" })], "maskoff.png", { type: "image/png" })]);
  await wait(300);
  v.querySelector('[data-tool="move"]').click(); await wait(150);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  await wait(150);
  v.querySelector('[data-p="rmbg"]').click();
  await wait(1500);
  document.querySelector('.ph-bgask [data-b="go"]')?.click();
  const t0 = performance.now();
  while (!q.doc.layers.at(-1).mask && performance.now() - t0 < 180000) await wait(300);
  const L = q.doc.layers.at(-1);
  ok("background removed", !!L.mask);
  ok("clean edge colours in use", !!L.preBg && L.canvas === L.bgFixed, `preBg ${!!L.preBg}, canvas is bgFixed ${L.canvas === L.bgFixed}`);
  ok("mask on: the cleaned copy is drawn", q.drawnPx(L) === L.bgFixed);
  const sw = () => v.querySelector('[data-p="maskon"]');
  sw().click(); await wait(200);
  ok("mask off", !L.maskOn);
  ok("mask off: the original photo is drawn", q.drawnPx(L) === L.preBg);
  sw().click(); await wait(200);
  ok("mask on again: the cut-out is back", L.maskOn && q.drawnPx(L) === L.bgFixed);
  return { pass: !fails.length, fails, out };
}
