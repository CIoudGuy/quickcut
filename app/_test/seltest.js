// Selection add / subtract / intersect with each shape: pixel-checked through Delete (clear) on the base layer.
// Needs a photo open (e.g. _test/demo.png).
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc, cv = v.querySelector(".ph-canvas");
  const key = (o) => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...o }));
  const at = (x, y) => { const r = cv.getBoundingClientRect(); return { clientX: r.left + q.view.ox + x * q.view.z, clientY: r.top + q.view.oy + y * q.view.z }; };
  const pe = (type, x, y, extra = {}) => cv.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, ...at(x, y), ...extra }));
  const box = (b, extra, kind) => {
    if (kind === "lasso") {
      const pts = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
      pe("pointerdown", ...pts[0], extra);
      for (let i = 1; i <= 4; i++) { const [ax, ay] = pts[i - 1], [bx, by] = pts[i % 4]; for (let t = 1; t <= 8; t++) pe("pointermove", ax + ((bx - ax) * t) / 8, ay + ((by - ay) * t) / 8, extra); }
      pe("pointerup", ...pts[0], extra);
      return;
    }
    pe("pointerdown", b[0], b[1], extra);
    for (let t = 1; t <= 6; t++) pe("pointermove", b[0] + ((b[2] - b[0]) * t) / 6, b[1] + ((b[3] - b[1]) * t) / 6, extra);
    pe("pointerup", b[2], b[3], extra);
  };
  const A = [120, 40, 260, 200], B = [200, 120, 340, 260];
  const P = { aOnly: [150, 80], bOnly: [310, 230], both: [230, 155], out: [330, 60] };
  const base = () => q.doc.layers[0];
  const alpha = ([x, y]) => { const l = base(), c = new OffscreenCanvas(1, 1).getContext("2d"); c.drawImage(l.canvas, -(x - l.x), -(y - l.y)); return c.getImageData(0, 0, 1, 1).data[3]; };
  const expect = { add: { aOnly: 0, bOnly: 0, both: 0, out: 255 }, sub: { aOnly: 0, bOnly: 255, both: 255, out: 255 }, int: { aOnly: 255, bOnly: 255, both: 0, out: 255 } };
  const mods = { add: { shiftKey: true }, sub: { altKey: true }, int: { shiftKey: true, altKey: true } };
  key({ key: "m", code: "KeyM" });
  // select the bottom layer in the Layers card so Delete clears it
  const row = v.querySelector(`.ly-row[data-id="${base().id}"]`);
  row.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 2, button: 0, bubbles: true, clientX: 1, clientY: 1 }));
  dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, bubbles: true }));
  const out = {}; let pass = true;
  for (const kind of ["rect", "ellipse", "lasso"]) {
    // shape from the keys (the top-bar shape switch is gone): M rectangle, Shift M ellipse, L lasso
    if (kind === "lasso") key({ key: "l", code: "KeyL" });
    else { key({ key: "m", code: "KeyM" }); if (q.prefs.selShape !== kind) key({ key: "M", code: "KeyM", shiftKey: true }); }
    if (q.prefs.selShape !== kind) return { pass: false, why: `couldn't pick ${kind}` };
    for (const op of ["add", "sub", "int"]) {
      key({ key: "d", code: "KeyD", ctrlKey: true });
      box(A, {}, kind);
      const s1 = q.selection;
      box(B, mods[op], kind);
      const s2 = q.selection;
      key({ key: "Delete", code: "Delete" });
      const got = Object.fromEntries(Object.entries(P).map(([n, p]) => [n, alpha(p)]));
      key({ key: "z", code: "KeyZ", ctrlKey: true }); // undo the clear
      key({ key: "z", code: "KeyZ", ctrlKey: true }); // undo the added part
      const undoPart = q.selection === s1;
      const ok = Object.entries(expect[op]).every(([n, a]) => (kind === "ellipse" && n === "aOnly" && false) || got[n] === a) && s2?.kind === "set" && undoPart;
      out[`${kind}-${op}`] = { ok, got, kind: s2?.kind, undoPart };
      pass &&= ok;
    }
  }
  key({ key: "d", code: "KeyD", ctrlKey: true });
  return { pass, out };
}
