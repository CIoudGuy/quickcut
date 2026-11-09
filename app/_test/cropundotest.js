// Undo with Crop open, paste during Crop, and the "too big" message of Resize.
// Run on a fresh page: (await import("/_test/cropundotest.js")).run()
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  const key = (o) => document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...o }));
  const mk = async (col, name, w, h) => { const c = new OffscreenCanvas(w, h), g = c.getContext("2d"); g.fillStyle = col; g.fillRect(0, 0, w, h); return new File([await c.convertToBlob({ type: "image/png" })], name, { type: "image/png" }); };
  await q.openNew([await mk("#2a6", "base.png", 800, 600)]);
  await wait(300);
  // crop once (applied), then open Crop again
  v.querySelector('[data-tool="crop"]').click(); await wait(150);
  q.setCrop({ rect: { x: 100, y: 100, w: 400, h: 300 } });
  key({ key: "Enter", code: "Enter" }); await wait(200);
  ok("cropped", q.doc.w === 400 && q.doc.h === 300, `${q.doc.w}×${q.doc.h}`);
  v.querySelector('[data-tool="crop"]').click(); await wait(150);
  ok("crop open", !!q.crop);
  // paste while Crop is open, then Ctrl+Z
  const dt = new DataTransfer(); dt.items.add(await mk("#e33", "red.png", 100, 80));
  document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  await wait(600);
  ok("paste added a layer", q.doc.layers.length === 2, q.doc.layers.length);
  key({ key: "z", code: "KeyZ", ctrlKey: true }); await wait(200);
  ok("Ctrl+Z undid the paste", q.doc.layers.length === 1, q.doc.layers.length);
  ok("crop kept", !!q.doc.crop && q.doc.w === 400 && q.doc.h === 300, `${q.doc.w}×${q.doc.h}`);
  // Crop open and changed, Ctrl+Z: the change is taken back, Crop stays open
  v.querySelector('[data-tool="crop"]').click(); await wait(150);
  const before = JSON.stringify(q.crop.rect);
  q.setCrop({ rect: { x: 10, y: 10, w: 200, h: 150 } });
  key({ key: "z", code: "KeyZ", ctrlKey: true }); await wait(200);
  ok("Ctrl+Z in Crop reverts the crop change", !!q.crop && JSON.stringify(q.crop.rect) === before, q.crop && JSON.stringify(q.crop.rect));
  key({ key: "Escape", code: "Escape" }); await wait(150);
  // drop an image while Crop is open, then Ctrl+Z
  v.querySelector('[data-tool="crop"]').click(); await wait(150);
  const dd = new DataTransfer(); dd.items.add(await mk("#33e", "blue.png", 120, 90));
  const zone = v.querySelector(".ph") || v;
  for (const t of ["dragenter", "dragover", "drop"]) zone.dispatchEvent(new DragEvent(t, { dataTransfer: dd, bubbles: true, cancelable: true }));
  await wait(700);
  ok("drop in Crop added a layer", q.doc.layers.length === 2 && !q.crop, `${q.doc.layers.length} layers, crop open: ${!!q.crop}`);
  key({ key: "z", code: "KeyZ", ctrlKey: true }); await wait(200);
  ok("Ctrl+Z undid the dropped image, crop kept", q.doc.layers.length === 1 && q.doc.w === 400 && q.doc.h === 300, `${q.doc.layers.length} layers, ${q.doc.w}×${q.doc.h}`);
  // Resize far too big: the message names a size that fits, and that size works
  const toasts = () => [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | ");
  q.resizeImage(10675, 16000); await wait(200);
  const m = toasts().match(/max (\d+) × (\d+) px/);
  ok("message gives a size that fits", !!m, toasts());
  if (m) {
    const w = +m[1], h = +m[2];
    ok("…same shape", Math.abs(w / h - 10675 / 16000) < 0.01, `${w}×${h}`);
    q.resizeImage(w, h); await wait(300);
    ok("…and it works", q.doc.w === w && q.doc.h === h, `${q.doc.w}×${q.doc.h}`);
  }
  return { pass: !fails.length, fails, out };
}
