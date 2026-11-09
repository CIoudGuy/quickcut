// Painting zoomed in on a small image: the live stroke already shows the layer's own pixels (one
// solid block per pixel), and what the user sees while painting is what the layer gets on release.
// Run on a fresh page: (await import("/_test/livestroketest.js")).run()
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc, cv = v.querySelector(".ph-canvas");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  const c = new OffscreenCanvas(40, 30); c.getContext("2d").fillStyle = "#3a6"; c.getContext("2d").fillRect(0, 0, 40, 30);
  await q.openNew([new File([await c.convertToBlob({ type: "image/png" })], "tiny.png", { type: "image/png" })]);
  await wait(300);
  // a new empty layer to paint on, the brush, zoom so that one pixel is about 14 screen pixels
  q.ops.new(); await wait(100);
  v.querySelector('[data-tool="brush"]').click(); await wait(100);
  // a small, soft brush (a few image pixels wide), so the stroke has partly covered pixels at its edges
  for (let i = 0; i < 30; i++) document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "[", code: "BracketLeft", bubbles: true, cancelable: true }));
  for (let i = 0; i < 4; i++) document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "{", code: "BracketLeft", shiftKey: true, bubbles: true, cancelable: true }));
  await wait(100);
  // about 9× (each key press ×1.25): the whole 40 × 30 image stays on screen, each pixel ~9 screen pixels
  for (let i = 0; i < 10; i++) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "=", code: "Equal", bubbles: true, cancelable: true })); await wait(60); }
  await wait(400);
  const r = cv.getBoundingClientRect(), at = (x, y) => ({ clientX: r.left + q.view.ox + x * q.view.z, clientY: r.top + q.view.oy + y * q.view.z });
  const pe = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, ...at(x, y) }));
  // a diagonal stroke across the middle, held (not released yet)
  pe("pointerdown", 14, 11);
  for (let i = 1; i <= 12; i++) pe("pointermove", 14 + i, 11 + i * 0.6);
  await wait(250);
  q.renderNow();
  const pv = q.strokePreview();
  ok("zoomed in", q.view.z * (q.lm(q.doc.layers.at(-1))[0] || 1) >= 4, q.view.z);
  ok("live stroke exists", !!pv?.scr);
  // every layer pixel shows as one solid block in the live preview: sample inside a few blocks
  const g = pv.scr.getContext("2d"), L = pv.L, mixed = [], seen = [];
  for (const [px, py] of [[16, 12], [18, 13], [20, 14], [22, 16], [15, 12], [21, 15]]) {
    const xs = [0.2, 0.5, 0.8].map((f) => L[0] * (px + f) + L[2] * (py + 0.5) + L[4]), ys = [0.2, 0.5, 0.8].map((f) => L[1] * (px + 0.5) + L[3] * (py + f) + L[5]);
    const vals = [];
    for (const x of xs) for (const y of ys) vals.push(g.getImageData(Math.round(x), Math.round(y), 1, 1).data[3]);
    seen.push([px, py, vals[4]]);
    if (Math.max(...vals) - Math.min(...vals) > 3) mixed.push(`${px},${py}: ${Math.min(...vals)}–${Math.max(...vals)}`);
  }
  ok("live preview: one solid block per pixel", !mixed.length, mixed.join(" | "));
  pe("pointerup", 26, 18);
  await wait(250);
  const lay = q.doc.layers.at(-1).canvas.getContext("2d"), diff = [];
  for (const [px, py, a] of seen) { const b = lay.getImageData(px, py, 1, 1).data[3]; if (Math.abs(a - b) > 3) diff.push(`${px},${py}: ${a} → ${b}`); }
  ok("released result matches the live preview", !diff.length, diff.join(" | "));
  return { pass: !fails.length, fails, out };
}
