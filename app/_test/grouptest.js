// Layer groups end to end: group / ungroup / undo, collapse, rename, visibility, opacity, blend
// stepping (Shift +/−, Ctrl+wheel: one undo step each), hover preview, move as a unit,
// auto-select Group, clipping inside a group and onto a group, drag into / out of a group,
// duplicate / merge / delete group, nesting. Run on a fresh page:
// (await import("/_test/grouptest.js")).run()
import { composite, tree, buffers, I } from "../photo/engine.js";

export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc, cv = v.querySelector(".ph-canvas");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const mk = (color, w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = color; g.fillRect(0, 0, w, h); return new Promise((r) => c.toBlob((b) => r(new File([b], color.slice(1) + ".png", { type: "image/png" })), "image/png")); };
  const key = (o) => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...o }));
  const at = (x, y) => { const r = cv.getBoundingClientRect(); return { clientX: r.left + q.view.ox + x * q.view.z, clientY: r.top + q.view.oy + y * q.view.z }; };
  const pe = (type, x, y, extra = {}) => cv.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, ...at(x, y), ...extra }));
  const drag = (x, y, dx, extra = {}) => { pe("pointerdown", x, y, extra); for (let i = 1; i <= 5; i++) pe("pointermove", x + (dx * i) / 5, y, extra); pe("pointerup", x + dx, y, extra); };
  const row = (id) => v.querySelector(`.ly-row[data-id="${id}"]`);
  const pick = (id) => { row(id).dispatchEvent(new PointerEvent("pointerdown", { pointerId: 2, button: 0, bubbles: true, clientX: 1, clientY: 1 })); dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, bubbles: true })); };
  const shiftPick = (id) => row(id).dispatchEvent(new PointerEvent("pointerdown", { pointerId: 2, button: 0, shiftKey: true, bubbles: true, clientX: 1, clientY: 1 }));
  const undoN = () => { const t = v.querySelector('[data-a="undo"]').title; return t; };
  const D = () => q.doc;
  const byName = (n) => D().layers.find((l) => l.name === n) || D().groups.find((g) => g.name === n);
  // the composite exactly as the app draws it, read back at one document pixel
  const pixel = (x, y) => {
    const d = D(), c = new OffscreenCanvas(d.w, d.h), b = buffers();
    b.size(d.w, d.h);
    composite(c.getContext("2d"), tree(d.layers.map((l) => ({ id: l.id, parent: l.parent ?? null, src: l.canvas, x: l.x, y: l.y, opacity: l.opacity, blend: l.blend, visible: l.visible, clip: l.clip })), d.groups), I, b);
    b.drop();
    return [...c.getContext("2d").getImageData(x, y, 1, 1).data];
  };
  const out = {}, fail = [];
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fail.push(name); };

  await q.open([await mk("#ff0000", 400, 300)]); await wait(300);
  await q.open([await mk("#0000ff", 200, 150)]); await wait(300); // A: centred at 100,75
  await q.open([await mk("#00ff00", 100, 100)]); await wait(300); // B: 150,100
  await q.open([await mk("#ffff00", 60, 60)]); await wait(300);   // C: 170,120
  const [bg, A, B, C] = D().layers;
  key({ key: "v", code: "KeyV" });
  // 1. Ctrl+G groups the picked layers where the topmost was
  pick(A.id); shiftPick(B.id);
  key({ key: "g", code: "KeyG", ctrlKey: true });
  const G = D().groups[0];
  ok("group", G && D().sel === G.id && byName("0000ff").parent === G.id && byName("00ff00").parent === G.id && D().layers.map((l) => l.name).join() === "Background,0000ff,00ff00,ffff00", D().layers.map((l) => [l.name, l.parent]));
  ok("rows", [...v.querySelectorAll(".ly-row")].map((r) => r.querySelector(".nm").textContent).join() === "ffff00,Group 1,00ff00,0000ff,Background");
  // 2. undo / redo
  key({ key: "z", code: "KeyZ", ctrlKey: true });
  ok("undo group", D().groups.length === 0 && D().layers.every((l) => l.parent == null));
  key({ key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true });
  ok("redo group", D().groups.length === 1 && byName("0000ff").parent === D().groups[0].id);
  const g = () => D().groups[0];
  // 3. collapse hides its rows, expand shows them
  row(g().id).querySelector(".tw").click();
  ok("collapse", !row(byName("0000ff").id) && row(g().id).getAttribute("aria-expanded") === "false");
  row(g().id).querySelector(".tw").click();
  ok("expand", !!row(byName("0000ff").id));
  // 4. rename
  row(g().id).querySelector(".nm").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const inp = row(g().id).querySelector("input");
  inp.value = "Shapes"; inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  ok("rename", g().name === "Shapes");
  // 5. hiding the group hides its layers (pixel at B: red Background shows)
  ok("pixel B", pixel(155, 105).join() === "0,255,0,255", pixel(155, 105));
  row(g().id).querySelector(".eye").click();
  ok("hide group", pixel(155, 105).join() === "255,0,0,255", pixel(155, 105));
  key({ key: "z", code: "KeyZ", ctrlKey: true });
  // 6. opacity key on the group (Move tool): 50% → B over red at 50%
  pick(g().id);
  key({ key: "5", code: "Digit5" });
  const p6 = pixel(155, 105);
  ok("group opacity", g().opacity === 0.5 && Math.abs(p6[0] - 128) <= 1 && Math.abs(p6[1] - 127) <= 1, p6);
  key({ key: "0", code: "Digit0" });
  // 7. Shift + / − steps the blend mode live; one undo step once it settles
  const u0 = undoN();
  key({ key: "+", code: "Equal", shiftKey: true }); key({ key: "+", code: "Equal", shiftKey: true }); key({ key: "_", code: "Minus", shiftKey: true });
  ok("shift+ steps", g().blend === "normal", g().blend); // pass → normal → dissolve → normal
  await wait(650);
  key({ key: "+", code: "Equal", shiftKey: true }); key({ key: "+", code: "Equal", shiftKey: true });
  await wait(650);
  const u1 = undoN();
  key({ key: "z", code: "KeyZ", ctrlKey: true });
  ok("one undo per settle", g().blend === "normal" && u1 === "Undo Blend mode (Ctrl Z)" && u0 !== u1, [g().blend, u0, u1]);
  // 8. Ctrl+wheel over the blend button
  const bb = v.querySelector('.ly-row.sel [data-p="blend"]');
  for (let i = 0; i < 3; i++) bb.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true }));
  ok("ctrl+wheel", g().blend === "multiply" && bb.textContent.includes("Multiply"), g().blend); // normal → dissolve → darken → multiply
  await wait(650);
  // 9. hover preview in the menu: shows, then restored when leaving / closing without a pick
  const before = g().blend;
  bb.click();
  await wait(30); // the menu focuses its first item a tick after opening (a person can't press Esc before that)
  const menu = document.querySelector(".ph-blend");
  const item = menu.querySelector('[data-mode="screen"]');
  item.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
  const shown = g().blend;
  menu.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
  const back = g().blend;
  item.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  await wait(200);
  ok("hover preview", shown === "screen" && back === before && g().blend === before && !document.querySelector(".ph-blend"), [shown, back, g().blend]);
  // pick one: one undo step
  v.querySelector('.ly-row.sel [data-p="blend"]').click();
  document.querySelector('.ph-blend:not(.closing) [data-mode="pass"]').click();
  await wait(200);
  ok("pick mode", g().blend === "pass" && undoN() === "Undo Blend mode (Ctrl Z)");
  // 10. a selected group moves as one
  const a0 = [byName("0000ff").x, byName("00ff00").x];
  drag(110, 85, 20);
  ok("move group", byName("0000ff").x === a0[0] + 20 && byName("00ff00").x === a0[1] + 20 && D().sel === g().id, [byName("0000ff").x, byName("00ff00").x, D().sel]);
  // 11. Click to pick layer (the Move tool's flyout: click the active Move tool again), Pick: Group
  // picks the group from a click on its layer; Pick: Layer picks the layer
  pick(byName("Background").id);
  const moveOpt = (id) => { v.querySelector('[data-tool="move"]').click(); document.querySelector(`.ph-moveopts [data-mo="${id}"]`).click(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); };
  moveOpt("group");
  drag(130, 95, 0);
  ok("auto group", D().sel === g().id);
  moveOpt("layer");
  await wait(400); // not a double-click (that toggles the zoom)
  drag(130, 95, 0);
  ok("auto layer", D().sel === byName("0000ff").id, [D().sel, q.prefs]);
  // 12. clipping inside a group: B clipped to A (Ctrl+Alt+G)
  pick(byName("00ff00").id);
  key({ key: "g", code: "KeyG", ctrlKey: true, altKey: true });
  byName("00ff00").x = 280; // half over A (A: 120..320), half over the red Background
  ok("clip in group", byName("00ff00").clip === true && pixel(300, 150).join() === "0,255,0,255" && pixel(350, 150).join() === "255,0,0,255", [pixel(300, 150), pixel(350, 150)]);
  byName("00ff00").x = 170;
  // 13. a group as the clipping base: C (above the group) clipped to it
  pick(byName("ffff00").id);
  key({ key: "g", code: "KeyG", ctrlKey: true, altKey: true });
  const cx = byName("ffff00");
  ok("clip to group", cx.clip && pixel(cx.x + 5, cx.y + 5).join() === "255,255,0,255", pixel(cx.x + 5, cx.y + 5));
  // move C off the group's pixels: it disappears there (clipped to the group's shape)
  cx.x = 330; cx.y = 230; // outside A (120..320 × 75..225)
  ok("clip to group hides outside", pixel(335, 235).join() === "255,0,0,255", pixel(335, 235));
  cx.x = 170; cx.y = 120;
  // 14. drag C's row onto the group's row: into the group; Ctrl+Shift+G takes it out again
  key({ key: "g", code: "KeyG", ctrlKey: true, altKey: true }); // unclip first
  const rr = row(cx.id), gr = row(g().id).getBoundingClientRect(), r0 = rr.getBoundingClientRect();
  rr.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 3, button: 0, bubbles: true, clientX: r0.left + 60, clientY: r0.top + r0.height / 2 }));
  dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, bubbles: true, clientX: gr.left + 60, clientY: gr.top + 4 }));
  dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, bubbles: true, clientX: gr.left + 60, clientY: gr.top + gr.height / 2 }));
  dispatchEvent(new PointerEvent("pointerup", { pointerId: 3, bubbles: true }));
  ok("drag into group", byName("ffff00").parent === g().id && D().layers[D().layers.length - 1].name === "ffff00", [byName("ffff00").parent]);
  pick(byName("ffff00").id);
  key({ key: "g", code: "KeyG", ctrlKey: true, shiftKey: true });
  ok("take out of group", byName("ffff00").parent == null && D().groups.length === 1);
  // 15. nesting: group the group
  pick(g().id);
  key({ key: "g", code: "KeyG", ctrlKey: true });
  const outerG = D().groups.find((x) => x.id === D().sel);
  ok("nest", outerG && byName("Shapes").parent === outerG.id && row(byName("0000ff").id).style.getPropertyValue("--ind") === "24px");
  key({ key: "z", code: "KeyZ", ctrlKey: true });
  // 16. isolated vs pass-through: a Difference layer in a Normal group sees only the group's layers
  pick(byName("00ff00").id);
  key({ key: "g", code: "KeyG", ctrlKey: true, altKey: true }); // unclip B
  byName("00ff00").blend = "difference";
  const spot = () => { byName("00ff00").x = 280; const p = pixel(350, 150); byName("00ff00").x = 170; return p; };
  const pass = pixel(175, 105); // pass through: green − (blue over red) = |0−0|,|255−0|,|0−255| → 0,255,255
  byName("Shapes").blend = "normal";
  const iso = pixel(175, 105);  // isolated: green − blue = 0,255,255 too here (A is opaque); B alone over red tells them apart
  const passOut = (() => { byName("Shapes").blend = "pass"; return spot(); })(); // B over red: |255−0|,|0−255|,0 → 255,255,0
  byName("Shapes").blend = "normal";
  const isoOut = spot(); // isolated: B on nothing = green, then Normal over red → 0,255,0
  byName("00ff00").blend = "normal"; byName("Shapes").blend = "pass";
  ok("pass vs isolated", pass.join() === "0,255,255,255" && iso.join() === "0,255,255,255" && passOut.join() === "255,255,0,255" && isoOut.join() === "0,255,0,255", [pass, iso, passOut, isoOut]);
  // 17. duplicate (Ctrl+J), merge (Ctrl+Shift+M) and delete a group
  pick(g().id);
  const nL = D().layers.length;
  key({ key: "j", code: "KeyJ", ctrlKey: true });
  const copy = D().groups.find((x) => x.id === D().sel);
  ok("duplicate group", copy && copy.name === "Shapes copy" && D().layers.length === nL + 2 && D().layers.filter((l) => l.parent === copy.id).length === 2);
  const px0 = pixel(200, 150);
  key({ key: "m", code: "KeyM", ctrlKey: true, shiftKey: true });
  const merged = D().layers.find((l) => l.id === D().sel);
  ok("merge group", merged && merged.name === "Shapes copy" && D().groups.length === 1 && D().layers.length === nL + 1 && pixel(200, 150).join() === px0.join(), [merged?.name, D().groups.length, pixel(200, 150), px0]);
  key({ key: "z", code: "KeyZ", ctrlKey: true });
  pick(D().groups.find((x) => x.name === "Shapes copy").id);
  key({ key: "Delete", code: "Delete" });
  ok("delete group", D().groups.length === 1 && D().layers.length === nL);
  // 18. flatten keeps the picture
  const pf = pixel(200, 150);
  key({ key: "e", code: "KeyE", ctrlKey: true, shiftKey: true });
  ok("flatten", D().layers.length === 1 && D().groups.length === 0 && pixel(200, 150).join() === pf.join());
  key({ key: "z", code: "KeyZ", ctrlKey: true });
  ok("undo flatten", D().groups.length === 1 && D().layers.length === nL);
  return { pass: fail.length === 0, fail, out };
}
