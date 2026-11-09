// Opened the wrong picture: the first Ctrl+Z right after opening (nothing done yet) goes back to the
// start screen; after anything else (a zoom, an edit) Ctrl+Z never leaves the document. Photo and Color.
// Run on #photo: (await import("/_test/openundotest.js")).run()
export async function run() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 8000) => { const t = performance.now(); while (!f() && performance.now() - t < ms) await wait(50); return f(); };
  const undoKey = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true }));
  const img = (w, h, color) => new Promise((r) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = color; g.fillRect(0, 0, w, h); c.toBlob((b) => r(new File([b], `${color.slice(1)}.png`, { type: "image/png" })), "image/png"); });
  const out = { photo: {}, color: {} };

  // ── Photo ──
  const v = document.getElementById("view-photo"), q = v._qc;
  const empty = () => !v.querySelector(".empty").hidden && v.querySelector(".ph-doc").hidden;
  // 1. open, Ctrl+Z: start screen
  await q.openNew([await img(400, 300, "#ff0000")]);
  await wait(200);
  out.photo.opened = q.isOpen;
  undoKey();
  await wait(100);
  out.photo.closed = !q.isOpen && empty();
  // 2. open, zoom, Ctrl+Z: still open
  await q.openNew([await img(400, 300, "#00ff00")]);
  await wait(200);
  v.querySelector(".ph-canvas").dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
  await wait(150);
  undoKey();
  await wait(100);
  out.photo.zoomKeeps = q.isOpen && !empty();
  // 3. an edit, Ctrl+Z x5: still open, the edit undone
  q.resizeImage(200, 150);
  await wait(100);
  const resized = q.doc.w === 200;
  for (let i = 0; i < 5; i++) { undoKey(); await wait(60); }
  out.photo.editKeeps = resized && q.isOpen && !empty() && q.doc.w === 400;
  out.photo.pass = out.photo.opened && out.photo.closed && out.photo.zoomKeeps && out.photo.editKeeps;

  // ── Color ──
  location.hash = "color";
  const cv = await until(() => document.querySelector("#view-color .cl-drop")) && document.getElementById("view-color");
  await wait(300);
  const cEmpty = () => !cv.querySelector(".cl-empty").hidden && cv.querySelector(".cl-edit").hidden;
  const drop = async (color) => { const dt = new DataTransfer(); dt.items.add(await img(300, 200, color)); cv.querySelector(".cl-drop").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); await until(() => !cv.querySelector(".cl-edit").hidden); await wait(300); };
  // 1. open, Ctrl+Z: start screen
  await drop("#3366ff");
  out.color.opened = !cEmpty();
  undoKey();
  await wait(150);
  out.color.closed = cEmpty();
  // 2. open, zoom, Ctrl+Z: still open
  await drop("#33aa66");
  const st = cv.querySelector(".cl-stage"), r = st.getBoundingClientRect();
  st.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  await wait(150);
  undoKey();
  await wait(150);
  out.color.zoomKeeps = !cEmpty();
  // 3. pick a colour (an edit), Ctrl+Z x5: still open, the pick undone
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 7, pointerType: "mouse", button: 0, buttons: 1, bubbles: true };
  st.dispatchEvent(new PointerEvent("pointermove", at));
  st.dispatchEvent(new PointerEvent("pointerdown", at));
  st.dispatchEvent(new PointerEvent("pointerup", { ...at, buttons: 0 }));
  await wait(150);
  const picked = cv.querySelectorAll(".cl-hist button.cl-sw").length;
  for (let i = 0; i < 5; i++) { undoKey(); await wait(60); }
  out.color.editKeeps = picked > 0 && !cEmpty() && cv.querySelectorAll(".cl-hist button.cl-sw").length === 0;
  out.color.picked = picked;
  out.color.pass = out.color.opened && out.color.closed && out.color.zoomKeeps && out.color.editKeeps;
  location.hash = "photo";
  out.pass = out.photo.pass && out.color.pass;
  return out;
}
