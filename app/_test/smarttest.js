// Smart layers, re-editable crop, smart resize, session round trip, bounded memory.
// Run on a fresh page: (await import("/_test/smarttest.js")).run()
import { composite, tree, buffers, I } from "../photo/engine.js";

export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc, cv = v.querySelector(".ph-canvas");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  // detailed pictures (noise + lines), so any resampling shows
  const mk = (w, h, seed, name) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d"), d = g.createImageData(w, h);
    let x = seed;
    for (let i = 0; i < d.data.length; i += 4) { x = (x * 1103515245 + 12345) >>> 0; d.data[i] = x & 255; d.data[i + 1] = (x >> 8) & 255; d.data[i + 2] = (x >> 16) & 255; d.data[i + 3] = 255; }
    g.putImageData(d, 0, 0);
    return new Promise((r) => c.toBlob((b) => r(new File([b], name, { type: "image/png" })), "image/png"));
  };
  const key = (o) => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...o }));
  const at = (x, y) => { const r = cv.getBoundingClientRect(); return { clientX: r.left + q.view.ox + x * q.view.z, clientY: r.top + q.view.oy + y * q.view.z }; };
  const pe = (type, x, y, extra = {}) => cv.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, ...at(x, y), ...extra }));
  const drag = (x0, y0, x1, y1, extra) => { pe("pointerdown", x0, y0, extra); for (let i = 1; i <= 8; i++) pe("pointermove", x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8, extra); pe("pointerup", x1, y1, extra); };
  /** The document as composited (every layer through its matrix), RGBA bytes. */
  const pixels = () => {
    const D = q.doc, c = new OffscreenCanvas(D.w, D.h), b = buffers();
    b.size(D.w, D.h);
    composite(c.getContext("2d"), tree(D.layers.map((l) => ({ id: l.id, parent: l.parent ?? null, src: l.canvas, m: q.lm(l), x: l.x, y: l.y, opacity: l.opacity, blend: l.blend, visible: l.visible, clip: l.clip })), D.groups), I, b);
    b.drop();
    return c.getContext("2d").getImageData(0, 0, D.w, D.h).data;
  };
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  await q.openNew([await mk(400, 300, 7, "base.png")]);
  await wait(400);
  await q.open([await mk(200, 150, 99, "top.png")]); // a layer, centred at 100,75
  await wait(400);
  key({ key: "v", code: "KeyV" });
  const top = q.doc.layers[1], src0 = top.canvas, px0 = pixels(), lm0 = q.lm(top).join(), hb0 = q.hist.bytes;

  // 1. scale the layer to 5% (handle drag), then back to 100%: same source, exactly the same pixels
  q.renderNow();
  drag(300, 225, 110, 82.5);
  const small = q.lm(top);
  ok("scaled down", Math.abs(small[0] - 0.05) < 0.01 && top.canvas === src0, small);
  q.renderNow();
  drag(110, 82.5, 300, 225);
  ok("back to 100% exact", q.lm(top).join() === lm0 && top.canvas === src0, q.lm(top));
  ok("pixels identical", same(pixels(), px0));
  ok("undo holds no pixels", q.hist.bytes - hb0 < 4096, q.hist.bytes - hb0);

  // 2. memory stays bounded: 40 more scale steps, no new pixel copies
  const m0 = await q.mem();
  for (let i = 0; i < 20; i++) { q.renderNow(); drag(300, 225, 200 + i, 150 + i); q.renderNow(); const L = q.lm(top); const [bx, by] = [L[4] + 200 * L[0], L[5] + 150 * L[3]]; drag(bx, by, 300, 225); }
  const m1 = await q.mem();
  ok("memory bounded", m1.layersMB === m0.layersMB && m1.undoMB - m0.undoMB < 0.5 && top.canvas === src0, [m0, m1]);
  q.resetTransform();

  // 3. crop, then re-edit: the whole picture comes back with the crop on it; cancel keeps it
  key({ key: "c", code: "KeyC" });
  q.setCrop({ rect: { x: 50, y: 40, w: 200, h: 120 } });
  key({ key: "Enter", code: "Enter" });
  ok("base not moved", q.lm(q.doc.layers[0]).join() === "1,0,0,1,-50,-40", q.lm(q.doc.layers[0]));
  ok("cropped", q.doc.w === 200 && q.doc.h === 120 && q.doc.crop?.rect.x === 50 && q.doc.layers[0].x === -50 && q.doc.layers[0].canvas.width === 400, [q.doc.w, q.doc.h, q.doc.crop]);
  const cropPx = pixels();
  key({ key: "c", code: "KeyC" });
  ok("re-open shows whole picture", q.doc.w === 400 && q.doc.h === 300 && q.crop?.rect.x === 50 && q.crop.rect.w === 200 && q.doc.layers[0].x === 0, [q.doc.w, q.crop?.rect]);
  key({ key: "Escape", code: "Escape" });
  ok("cancel keeps crop", q.doc.w === 200 && !q.crop && same(pixels(), cropPx));
  // re-edit with straighten + rotate, apply, then undo back to the first crop
  key({ key: "c", code: "KeyC" });
  q.setCrop({ r: 1, rect: { x: 20, y: 30, w: 100, h: 150 } });
  key({ key: "Enter", code: "Enter" });
  ok("re-crop rotated", q.doc.w === 100 && q.doc.h === 150 && q.doc.crop.r === 1 && q.doc.layers[0].canvas.width === 400, [q.doc.w, q.doc.h]);
  q.undo();
  ok("undo to first crop", q.doc.w === 200 && same(pixels(), cropPx));
  // reset: the whole picture again
  key({ key: "c", code: "KeyC" });
  v.querySelector('[data-p="creset"]').click();
  key({ key: "Enter", code: "Enter" });
  ok("reset crop", q.doc.w === 400 && q.doc.h === 300 && !q.doc.crop && same(pixels(), px0));

  // 4. crop from a selection
  key({ key: "m", code: "KeyM" });
  q.renderNow();
  drag(100, 100, 300, 200);
  key({ key: "c", code: "KeyC" });
  ok("crop from selection", q.crop && q.crop.rect.x === 100 && q.crop.rect.w === 200 && q.crop.rect.h === 100, q.crop?.rect);
  key({ key: "Enter", code: "Enter" });
  key({ key: "v", code: "KeyV" });

  // 5. resize image down to 5%, then back up: exact; canvas size keeps what's outside
  const pxC = pixels(), wC = q.doc.w, hC = q.doc.h;
  q.resizeImage(10, 5);
  ok("resized down", q.doc.w === 10 && q.doc.layers[0].canvas.width === 400);
  q.resizeImage(wC, hC);
  ok("resize back exact", q.doc.w === wC && same(pixels(), pxC));
  q.resizeCanvas(50, 50);
  q.resizeCanvas(wC, hC);
  ok("canvas size non-destructive", same(pixels(), pxC));

  // 6. session round trip keeps sources, matrices and the crop (+ re-editing it)
  q.select(top.id);
  q.renderNow();
  drag(top.x + 200, top.y + 150, top.x + 120, top.y + 90); // top at 60%
  const lms = q.doc.layers.map((l) => q.lm(l).join()), crop1 = JSON.stringify(q.doc.crop), pxS = pixels();
  const rec = await q.record();
  await q.resume(structuredClone(rec));
  await wait(300);
  ok("session keeps matrices", JSON.stringify(q.doc.layers.map((l) => q.lm(l).join())) === JSON.stringify(lms), q.doc.layers.map((l) => q.lm(l)));
  ok("session keeps sources", q.doc.layers[0].canvas.width === 400 && q.doc.layers[1].canvas.width === 200);
  ok("session keeps crop", JSON.stringify(q.doc.crop) === crop1 && same(pixels(), pxS), [crop1, JSON.stringify(q.doc.crop)]);
  key({ key: "c", code: "KeyC" });
  ok("re-edit crop after resume", q.doc.w === 400 && q.crop?.rect.x === 100, q.crop?.rect);
  key({ key: "Escape", code: "Escape" });

  // 7. painting on a scaled layer goes into its source (brush sized for the scale)
  const cur = () => q.doc.layers.find((l) => l.id === top.id);
  q.select(top.id);
  key({ key: "v", code: "KeyV" });
  q.renderNow();
  let L = q.lm(cur());
  drag(L[4] + 200 * L[0], L[5] + 150 * L[3], L[4] + 100 * L[0], L[5] + 75 * L[3]); // to half
  L = q.lm(cur());
  const s1 = cur().canvas, before = s1.getContext("2d").getImageData(60, 60, 1, 1).data.join();
  key({ key: "b", code: "KeyB" });
  q.renderNow();
  drag(L[4] + 30, L[5] + 30, L[4] + 40, L[5] + 30);
  const t2 = cur(), after = t2.canvas.getContext("2d").getImageData(60, 60, 1, 1).data.join();
  ok("paint into source", Math.abs(L[0] - 0.5) < 0.01 && t2.canvas === s1 && t2.canvas.width === 200 && q.lm(t2).join() === L.join() && before !== after, [L, before, after]);
  return { pass: !fails.length, fails, out };
}
