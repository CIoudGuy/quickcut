// Regression check: dragging on a clipped layer's pixels with the Move tool moves the clipping group.
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc, cv = v.querySelector(".ph-canvas");
  // doc: a red base square and a blue layer clipped to it
  const mk = (color, w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = color; g.fillRect(0, 0, w, h); return new Promise((r) => c.toBlob((b) => r(new File([b], color.slice(1) + ".png", { type: "image/png" })), "image/png")); };
  await q.open([await mk("#ff0000", 400, 300)]);
  await new Promise((r) => setTimeout(r, 400));
  await q.open([await mk("#0000ff", 200, 150)]); // added as a layer, centred
  await new Promise((r) => setTimeout(r, 400));
  const key = (o) => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...o }));
  key({ key: "g", code: "KeyG", ctrlKey: true, altKey: true }); // clip to layer below (Ctrl+Alt+G; Ctrl+G groups)
  key({ key: "v", code: "KeyV" });
  const [base, top] = q.doc.layers;
  const at = (x, y) => { const r = cv.getBoundingClientRect(); return { clientX: r.left + q.view.ox + x * q.view.z, clientY: r.top + q.view.oy + y * q.view.z }; };
  const pe = (type, x, y, extra = {}) => cv.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, ...at(x, y), ...extra }));
  const drag = (x, y, dx, extra = {}) => { pe("pointerdown", x, y, extra); for (let i = 1; i <= 5; i++) pe("pointermove", x + (dx * i) / 5, y, extra); pe("pointerup", x + dx, y, extra); };
  const pos = () => q.doc.layers.map((l) => [l.name, l.x, l.y]);
  const out = { clipped: top.clip };
  // 1. plain drag on the clipped layer's pixels: the base is picked, the group moves together
  key({ key: "Escape", code: "Escape" });
  drag(200, 150, 40);
  out.plain = { sel: q.doc.layers.find((l) => l.id === q.doc.sel).name, pos: pos() };
  // 2. Alt-drag (deep select): only the clipped layer
  drag(240, 150, 30, { altKey: true });
  out.alt = { sel: q.doc.layers.find((l) => l.id === q.doc.sel).name, pos: pos() };
  // 3. the clipped layer picked in the Layers card, then a drag on its pixels: it alone moves
  drag(270, 150, 10);
  out.explicit = { sel: q.doc.layers.find((l) => l.id === q.doc.sel).name, pos: pos() };
  // 4. picked in the Layers card: a drag on its pixels moves it alone (base stays at 40)
  key({ key: "Escape", code: "Escape" });
  drag(100, 50, 20); // plain drag on the base's own pixels first: picks the base (group moves +20)
  const row = v.querySelector(`.ly-row[data-id="${top.id}"]`);
  row.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 2, button: 0, bubbles: true, clientX: 1, clientY: 1 }));
  dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, bubbles: true }));
  drag(300, 150, 10);
  out.card = { sel: q.doc.layers.find((l) => l.id === q.doc.sel).name, pos: pos() };
  const b0 = { x: 0, y: 0 }, t0 = { x: 100, y: 75 };
  out.pass = out.plain.sel === base.name && out.plain.pos[0][1] === b0.x + 40 && out.plain.pos[1][1] === t0.x + 40
    && out.alt.sel === top.name && out.alt.pos[0][1] === 40 && out.alt.pos[1][1] === 170
    && out.explicit.sel === top.name && out.explicit.pos[0][1] === 40 && out.explicit.pos[1][1] === 180
    && out.card.sel === top.name && out.card.pos[0][1] === 60 && out.card.pos[1][1] === 210;
  return out;
}
