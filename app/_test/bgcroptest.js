// Remove background after a crop: the AI looks only at what the crop shows (plus a small margin),
// not at the whole picture. Uses the real remover (downloads the Fast model once if needed).
// Run on a fresh page: (await import("/_test/bgcroptest.js")).run()
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  // two subjects: red on the left, blue on the right
  const c = new OffscreenCanvas(1200, 600), g = c.getContext("2d");
  g.fillStyle = "#cfd8e0"; g.fillRect(0, 0, 1200, 600);
  g.fillStyle = "#c0392b"; g.beginPath(); g.ellipse(300, 320, 150, 200, 0, 0, 7); g.fill();
  g.fillStyle = "#2e86de"; g.beginPath(); g.ellipse(900, 320, 150, 200, 0, 0, 7); g.fill();
  await q.openNew([new File([await c.convertToBlob({ type: "image/png" })], "two.png", { type: "image/png" })]);
  await wait(400);
  // crop to the blue one
  v.querySelector('[data-tool="crop"]').click();
  await wait(200);
  q.setCrop({ rect: { x: 620, y: 40, w: 560, h: 540 } });
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  await wait(300);
  ok("cropped", q.doc.w === 560 && q.doc.h === 540, `${q.doc.w}×${q.doc.h}`);
  v.querySelector('[data-p="rmbg"]').click();
  await wait(1500);
  document.querySelector('.ph-bgask [data-b="go"]')?.click();
  const t0 = performance.now();
  while (!q.doc.layers.at(-1).mask && performance.now() - t0 < 180000) await wait(250);
  const L = q.doc.layers.at(-1);
  ok("background removed", !!L.mask);
  if (!L.mask) return { pass: false, fails, out };
  const a = (x, y) => L.mask.getContext("2d").getImageData(x, y, 1, 1).data[3];
  ok("the AI saw only the cropped part", q.stats.bg.w < 700 && q.stats.bg.h <= 600, `${q.stats.bg.w}×${q.stats.bg.h}`);
  ok("mask covers the whole layer", L.mask.width === 1200 && L.mask.height === 600, `${L.mask.width}×${L.mask.height}`);
  ok("subject in the crop kept", a(900, 320) > 200, a(900, 320));
  ok("background in the crop removed", a(1150, 60) < 40, a(1150, 60));
  ok("cropped-away subject not kept", a(300, 320) < 40, a(300, 320));
  ok("crop unchanged", q.doc.w === 560 && q.doc.h === 540, `${q.doc.w}×${q.doc.h}`);
  return { pass: !fails.length, fails, out };
}
