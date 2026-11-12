// After the background remover, the Keep brush brings back the photo's own colours. The layer then
// shows a copy whose edge colours were cleaned for the cut-out; a kept area must not show those
// cleaned colours. Remove leaves colours alone; undo/redo put both the mask and the colours back.
// No AI model needed: the remover's result is set up by hand.
// Run on a fresh page: (await import("/_test/keeprestoretest.js")).run()
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc, cv = v.querySelector(".ph-canvas");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  const W = 200, H = 100, PHOTO = [200, 40, 40], CLEAN = [20, 20, 220];
  const fill = (rgb) => { const c = new OffscreenCanvas(W, H), g = c.getContext("2d"); g.fillStyle = `rgb(${rgb})`; g.fillRect(0, 0, W, H); return c; };
  await q.openNew([new File([await fill(PHOTO).convertToBlob({ type: "image/png" })], "keep.png", { type: "image/png" })]);
  await wait(300);
  q.addMask();
  const L = q.doc.layers.at(-1);
  {
    // as the remover leaves a layer: left part kept, a half-transparent band with cleaned colours
    // (columns 80–119), the rest removed
    const base = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < 120; x++) base[y * W + x] = x < 80 ? 255 : 128;
    const mc = new OffscreenCanvas(W, H), d = new ImageData(W, H);
    for (let i = 0; i < base.length; i++) { d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = 255; d.data[i * 4 + 3] = base[i]; }
    mc.getContext("2d").putImageData(d, 0, 0);
    const fixed = fill(PHOTO), fg = fixed.getContext("2d");
    fg.fillStyle = `rgb(${CLEAN})`; fg.fillRect(80, 0, 40, H);
    const photo = L.canvas;
    Object.assign(L, { mask: mc, maskBase: base, maskShift: 0, maskSoft: 0, maskOn: true, preBg: photo, bgFixed: fixed, canvas: fixed });
  }
  v.querySelector('[data-tool="mask"]').click(); await wait(200);
  const mode = async (m) => { v.querySelector(`[data-mb="${m}"]`).click(); await wait(100); };
  const r = cv.getBoundingClientRect(), at = (x, y) => ({ clientX: r.left + q.view.ox + x * q.view.z, clientY: r.top + q.view.oy + y * q.view.z });
  const pe = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, ...at(x, y) }));
  const strokeRow = async (y, xa, xb) => { pe("pointerdown", xa, y); for (let x = xa; x <= xb; x += 2) pe("pointermove", x, y); pe("pointerup", xb, y); await wait(250); };
  const px = (c, x, y) => [...c.getContext("2d").getImageData(x, y, 1, 1).data.slice(0, 3)];
  const near = (a, b, tol = 3) => a.every((n, i) => Math.abs(n - b[i]) <= tol);
  const baseAt = (x, y) => L.maskBase[y * W + x];

  ok("before: band shows the cleaned colour", near(px(L.bgFixed, 100, 50), CLEAN), px(L.bgFixed, 100, 50).join());
  await mode("keep");
  {
    // while the stroke is still held, the live preview already shows the photo's colour (read from the screen)
    const screenAt = (x, y) => {
      q.renderNow();
      const rr = cv.getBoundingClientRect(), sc = cv.width / rr.width;
      return [...cv.getContext("2d").getImageData(Math.round((q.view.ox + (x + 0.5) * q.view.z) * sc), Math.round((q.view.oy + (y + 0.5) * q.view.z) * sc), 1, 1).data.slice(0, 3)];
    };
    pe("pointerdown", 60, 20); for (let x = 60; x <= 150; x += 2) pe("pointermove", x, 20);
    await wait(250);
    ok("keep, still held: the preview shows the photo's colour", near(screenAt(100, 20), PHOTO, 8), screenAt(100, 20).join());
    pe("pointerup", 150, 20); await wait(250);
    ok("keep, released: the same colour stays", near(screenAt(100, 20), PHOTO, 8), screenAt(100, 20).join());
    q.undo(); await wait(200);
  }
  await strokeRow(50, 60, 150);
  ok("keep: mask restored under the stroke", baseAt(100, 50) >= 250, baseAt(100, 50));
  ok("keep: restored band shows the photo's colour", near(px(L.bgFixed, 100, 50), PHOTO), px(L.bgFixed, 100, 50).join());
  ok("keep: outside the stroke the cleaned colour stays", near(px(L.bgFixed, 100, 3), CLEAN), px(L.bgFixed, 100, 3).join());
  ok("keep: the photo itself is untouched", near(px(L.preBg, 100, 50), PHOTO, 0), px(L.preBg, 100, 50).join());
  ok("keep: the layer still shows the cut-out copy", L.canvas === L.bgFixed);
  q.undo(); await wait(200);
  ok("undo: mask back", baseAt(100, 50) === 128, baseAt(100, 50));
  ok("undo: cleaned colour back", near(px(L.bgFixed, 100, 50), CLEAN, 0), px(L.bgFixed, 100, 50).join());
  q.redo(); await wait(200);
  ok("redo: photo's colour again", baseAt(100, 50) >= 250 && near(px(L.bgFixed, 100, 50), PHOTO), px(L.bgFixed, 100, 50).join());
  q.undo(); await wait(200);
  await mode("remove");
  await strokeRow(50, 60, 150);
  ok("remove: mask cleared under the stroke", baseAt(100, 50) <= 5, baseAt(100, 50));
  ok("remove: colours unchanged", near(px(L.bgFixed, 100, 50), CLEAN, 0), px(L.bgFixed, 100, 50).join());
  await mode("keep");
  return { pass: !fails.length, fails, out };
}
