// Shift + click paints a straight line from the last painted point. While Shift is held, a guide line
// from that point to the pointer shows where the line will go; it goes away when Shift is released.
// Run on a fresh page: (await import("/_test/shiftlinetest.js")).run()
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc, cv = v.querySelector(".ph-canvas");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  const W = 300, H = 200;
  const c = new OffscreenCanvas(W, H), g = c.getContext("2d");
  g.fillStyle = "#1c2b3a"; g.fillRect(0, 0, W, H);
  await q.openNew([new File([await c.convertToBlob({ type: "image/png" })], "shift.png", { type: "image/png" })]);
  await wait(300);
  v.querySelector('[data-tool="brush"]').click(); await wait(200);
  const r = cv.getBoundingClientRect(), at = (x, y) => ({ clientX: r.left + q.view.ox + x * q.view.z, clientY: r.top + q.view.oy + y * q.view.z });
  const pe = (type, x, y, shiftKey = false) => cv.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerdown" ? 1 : 0, bubbles: true, shiftKey, ...at(x, y) }));
  const screenAt = (x, y) => {
    q.renderNow();
    const s = cv.width / r.width;
    return [...cv.getContext("2d").getImageData(Math.round((q.view.ox + x * q.view.z) * s), Math.round((q.view.oy + y * q.view.z) * s), 1, 1).data.slice(0, 3)];
  };
  const bright = (p) => Math.min(...p) >= 150;
  // one dab at the left; the pointer then rests far to the right (the brush circle is nowhere near the middle)
  pe("pointerdown", 40, 100); pe("pointerup", 40, 100); await wait(250);
  pe("pointermove", 260, 100); await wait(150);
  ok("no guide line without Shift", !bright(screenAt(150, 100)), screenAt(150, 100).join());
  pe("pointermove", 260, 100, true); await wait(150);
  ok("Shift held: a guide line from the last point to the pointer", bright(screenAt(150, 100)), screenAt(150, 100).join());
  ok("the line is thin (nothing beside it)", !bright(screenAt(150, 80)), screenAt(150, 80).join());
  pe("pointermove", 260, 160, true); await wait(150);
  ok("the line follows the pointer", !bright(screenAt(150, 100)) && bright(screenAt(150, 130)), `${screenAt(150, 100)} / ${screenAt(150, 130)}`);
  dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", shiftKey: false, bubbles: true })); await wait(150);
  ok("Shift released: the line is gone", !bright(screenAt(150, 130)), screenAt(150, 130).join());
  // Shift + click still paints the straight line itself
  pe("pointerdown", 260, 100, true); pe("pointerup", 260, 100, true); await wait(300);
  pe("pointermove", 40, 190); await wait(150);
  ok("Shift + click paints the line", bright(screenAt(150, 100)), screenAt(150, 100).join());
  return { pass: !fails.length, fails, out };
}
