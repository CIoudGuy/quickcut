// After the background remover a layer keeps two copies of its pixels: the photo and the one with
// cleaned edge colours. Duplicating the layer, painting on it or rasterizing it must keep both, so
// hiding the mask still shows the photo (not the cleaned colours as a halo around the subject).
// No AI model needed: the remover's result is set up by hand.
// Run on a fresh page: (await import("/_test/bgpairtest.js")).run()
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc, cv = v.querySelector(".ph-canvas");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  const W = 200, H = 100, PHOTO = [200, 40, 40], CLEAN = [20, 20, 220];
  const fill = (rgb) => { const c = new OffscreenCanvas(W, H), g = c.getContext("2d"); g.fillStyle = `rgb(${rgb})`; g.fillRect(0, 0, W, H); return c; };
  await q.openNew([new File([await fill(PHOTO).convertToBlob({ type: "image/png" })], "pair.png", { type: "image/png" })]);
  await wait(300);
  q.addMask();
  const top = () => q.doc.layers.at(-1);
  {
    // as the remover leaves a layer: left part kept, a half-transparent band with cleaned colours
    // (columns 80–119), the rest removed
    const L = top(), base = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < 120; x++) base[y * W + x] = x < 80 ? 255 : 128;
    const mc = new OffscreenCanvas(W, H), d = new ImageData(W, H);
    for (let i = 0; i < base.length; i++) { d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = 255; d.data[i * 4 + 3] = base[i]; }
    mc.getContext("2d").putImageData(d, 0, 0);
    const fixed = fill(PHOTO), fg = fixed.getContext("2d");
    fg.fillStyle = `rgb(${CLEAN})`; fg.fillRect(80, 0, 40, H);
    Object.assign(L, { mask: mc, maskBase: base, maskShift: 0, maskSoft: 0, maskOn: true, preBg: L.canvas, bgFixed: fixed, canvas: fixed });
  }
  const px = (c, x, y) => [...c.getContext("2d").getImageData(x, y, 1, 1).data.slice(0, 3)];
  const near = (a, b, tol = 3) => a.every((n, i) => Math.abs(n - b[i]) <= tol);
  /** What the layer draws with its mask hidden, at a point of the cleaned band. */
  const maskOff = async (l, x, y) => { l.maskOn = false; const p = px(q.drawnPx(l), x, y); l.maskOn = true; return p; };
  const pair = (l) => !!l.preBg && !!l.bgFixed && l.canvas === l.bgFixed;

  // duplicate
  const L0 = top();
  q.ops.dup(); await wait(300);
  const D = top();
  ok("duplicate: a new layer", D !== L0 && q.doc.layers.length === 2, q.doc.layers.length);
  ok("duplicate: keeps both copies", pair(D), `preBg ${!!D.preBg}, bgFixed ${!!D.bgFixed}`);
  ok("duplicate: its own canvases", D.preBg !== L0.preBg && D.bgFixed !== L0.bgFixed);
  ok("duplicate: mask on shows the cleaned colour", near(px(q.drawnPx(D), 100, 50), CLEAN), px(q.drawnPx(D), 100, 50).join());
  ok("duplicate: mask off shows the photo", near(await maskOff(D, 100, 50), PHOTO), (await maskOff(D, 100, 50)).join());
  q.undo(); await wait(200);

  // paint on the layer
  const L = top();
  v.querySelector('[data-tool="brush"]').click(); await wait(200);
  const r = cv.getBoundingClientRect(), at = (x, y) => ({ clientX: r.left + q.view.ox + x * q.view.z, clientY: r.top + q.view.oy + y * q.view.z });
  const pe = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, ...at(x, y) }));
  pe("pointerdown", 60, 80); for (let x = 60; x <= 150; x += 2) pe("pointermove", x, 80); pe("pointerup", 150, 80);
  await wait(300);
  const painted = px(L.canvas, 100, 80);
  ok("paint: the stroke is on the layer", !near(painted, CLEAN, 12), painted.join());
  ok("paint: keeps both copies", pair(L), `preBg ${!!L.preBg}, bgFixed ${!!L.bgFixed}`);
  ok("paint: the stroke is on the photo copy too", L.preBg && near(px(L.preBg, 100, 80), painted), L.preBg ? px(L.preBg, 100, 80).join() : "no photo copy");
  ok("paint: mask off shows the photo away from the stroke", near(await maskOff(L, 100, 20), PHOTO), (await maskOff(L, 100, 20)).join());
  q.undo(); await wait(200);
  ok("paint undo: both copies back", pair(L) && near(px(L.bgFixed, 100, 80), CLEAN, 0) && near(px(L.preBg, 100, 80), PHOTO, 0), pair(L) ? `${px(L.bgFixed, 100, 80)} / ${px(L.preBg, 100, 80)}` : "copies gone");

  // rasterize a scaled layer (twice the size)
  v.querySelector('[data-tool="move"]').click(); await wait(150);
  Object.assign(top(), { ta: 2, tb: 0, tc: 0, td: 2 });
  await wait(150);
  q.rasterize(); await wait(300);
  const R = top();
  ok("rasterize: plain pixels at the new size", R.ta === undefined && R.canvas.width === W * 2, `${R.canvas.width}, ta ${R.ta}`);
  ok("rasterize: keeps both copies", pair(R) && R.preBg.width === W * 2 && R.bgFixed.width === W * 2, `preBg ${!!R.preBg}, bgFixed ${!!R.bgFixed}`);
  ok("rasterize: mask on shows the cleaned colour", near(px(q.drawnPx(R), 200, 100), CLEAN), px(q.drawnPx(R), 200, 100).join());
  ok("rasterize: mask off shows the photo", near(await maskOff(R, 200, 100), PHOTO), (await maskOff(R, 200, 100)).join());
  return { pass: !fails.length, fails, out };
}
