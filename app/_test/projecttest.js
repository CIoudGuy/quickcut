// Projects (.qcut) in the app: Photo and Video round trips through Continue, Recents and Save/Open
// project; corrupt and foreign files; the wrong tool; speed and memory. Some steps need a reload in
// between (the state to compare is kept in localStorage):
//   photoA() → reload → photoB()        videoA() → reload → videoB()        speed() (fresh page)
//   migA() → reload → migB()            flush()
// The Video steps need an H.264 video with audio at /_test/zz_h264.mp4 (copy any; not kept in the repo).
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { const t0 = performance.now(); while (!(await f())) { if (performance.now() - t0 > ms) return false; await wait(30); } return true; };
const fnv = (u8) => { let x = 2166136261; for (let i = 0; i < u8.length; i++) { x ^= u8[i]; x = Math.imul(x, 16777619); } return (x >>> 0).toString(16); };
const pxSig = (c) => (c ? `${c.width}x${c.height}:${fnv(new Uint8Array(c.getContext("2d").getImageData(0, 0, c.width, c.height).data.buffer))}` : null);
const P = () => document.getElementById("view-photo")._qc;
const lastToast = () => [...document.querySelectorAll(".toasts .toast")].pop();
function photoSig() {
  const q = P(), D = q.doc;
  return JSON.stringify({
    name: D.name, w: D.w, h: D.h, crop: D.crop, sel: D.sel, groups: D.groups.map((g) => ({ ...g })), selection: q.selection,
    layers: D.layers.map((l) => ({ id: l.id, parent: l.parent ?? null, name: l.name, kind: l.kind, lm: q.lm(l), opacity: l.opacity, blend: l.blend, visible: l.visible, clip: !!l.clip, text: l.text || null, px: pxSig(l.canvas), mask: pxSig(l.mask), maskOn: !!l.maskOn, base: l.maskBase ? fnv(l.maskBase) : null })),
  });
}
/** A picture with detail and soft alpha (so any lossy step shows). */
function mk(w, h, seed, name, alpha = false) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"), d = g.createImageData(w, h);
  let x = seed;
  for (let i = 0, p = 0; i < d.data.length; i += 4, p++) { x = (x * 1103515245 + 12345) >>> 0; d.data[i] = x & 255; d.data[i + 1] = (x >> 8) & 255; d.data[i + 2] = ((p % w) * 255 / w) | 0; d.data[i + 3] = alpha ? (((p / w) | 0) * 255 / h) | 0 : 255; }
  g.putImageData(d, 0, 0);
  return new Promise((r) => c.toBlob((b) => r(new File([b], name, { type: "image/png", lastModified: seed })), "image/png"));
}
const key = (o) => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...o }));
function pointer() {
  const q = P(), cv = document.querySelector("#view-photo .ph-canvas");
  const at = (x, y) => { const r = cv.getBoundingClientRect(); return { clientX: r.left + q.view.ox + x * q.view.z, clientY: r.top + q.view.oy + y * q.view.z }; };
  const pe = (type, x, y, extra = {}) => cv.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, ...at(x, y), ...extra }));
  const drag = (x0, y0, x1, y1) => { q.renderNow(); pe("pointerdown", x0, y0); for (let i = 1; i <= 8; i++) pe("pointermove", x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8); pe("pointerup", x1, y1); };
  return { pe, drag };
}
/** A document with every kind of thing in it. */
async function richDoc(name, seed) {
  const q = P(), { pe, drag } = pointer();
  await q.openNew([await mk(400, 300, seed, name)]);
  await wait(300);
  await q.open([await mk(200, 150, seed + 1, `top${seed}.png`)]); // smart layer
  await wait(300);
  key({ key: "v", code: "KeyV" });
  const top = q.doc.layers[1];
  drag(top.x + 200, top.y + 150, top.x + 120, top.y + 90); // scaled to 60%
  await q.open([await mk(160, 120, seed + 2, `soft${seed}.png`, true)]); // soft alpha
  await wait(300);
  q.addMask();
  key({ key: "q", code: "KeyQ" });
  key({ key: "x", code: "KeyX" }); // mask brush: remove
  drag(150, 120, 230, 170);
  key({ key: "v", code: "KeyV" });
  q.select(top.id);
  q.ops.group();
  // a text layer
  key({ key: "t", code: "KeyT" });
  pe("pointerdown", 30, 40); pe("pointerup", 30, 40);
  await wait(50);
  const ta = document.querySelector("#view-photo textarea");
  if (ta) { ta.value = `Hello ${seed}`; ta.dispatchEvent(new Event("input")); }
  key({ key: "v", code: "KeyV" });
  key({ key: "Escape", code: "Escape" });
  // brush stroke on a new layer
  q.ops.new();
  key({ key: "b", code: "KeyB" });
  drag(20, 250, 380, 200);
  key({ key: "v", code: "KeyV" });
  // crop, then a selection
  key({ key: "c", code: "KeyC" });
  q.setCrop({ rect: { x: 10, y: 8, w: 360, h: 270 } });
  key({ key: "Enter", code: "Enter" });
  key({ key: "m", code: "KeyM" });
  drag(40, 40, 120, 90);
  key({ key: "v", code: "KeyV" });
  await wait(100);
}
const saved = async () => { if (!P().flush) { await wait(3000); return; } await P().flush(); await wait(200); await P().flush(); };

export async function photoA() {
  const q = P(), out = {}, fails = [];
  const ok = (n, c, info) => { out[n] = c ? true : info ?? false; if (!c) fails.push(n); };
  const sigs = {};
  await richDoc("p1.png", 11);
  await saved();
  sigs["p1.png"] = photoSig();
  ok("rich doc", q.doc.layers.length >= 5 && q.doc.groups.length === 1 && q.doc.layers.some((l) => l.kind === "text") && q.doc.layers.some((l) => l.mask) && !!q.doc.crop && !!q.selection, q.doc.layers.map((l) => l.kind));
  // Save project → open it: identical
  const t0 = performance.now();
  const blob = await q.writeProject("best");
  out.saveMs = Math.round(performance.now() - t0); out.bytes = blob.size;
  const t1 = performance.now();
  ok("open project", await q.openProject(blob));
  out.openMs = Math.round(performance.now() - t1);
  ok("project identical", photoSig() === sigs["p1.png"]);
  // corrupt / truncated / newer / foreign: a short error toast, nothing else changes
  const before = photoSig();
  const u8 = new Uint8Array(await blob.arrayBuffer());
  const flip = u8.slice(); flip[Math.floor(flip.length * 0.6)] ^= 0x55;
  const bad = async (b, want) => { document.querySelector(".toasts")?.replaceChildren(); const r = await q.openProject(b); await wait(50); const t = lastToast(); return r === false && t?.classList.contains("bad") && t.textContent.trim() === want && photoSig() === before ? true : [r, t?.textContent]; };
  ok("corrupt tile", await bad(new Blob([flip]), "Can't open project"));
  ok("truncated", await bad(new Blob([u8.slice(0, u8.length - 100)]), "Can't open project"));
  const newer = u8.slice(); newer[8] = 3;
  ok("newer", await bad(new Blob([newer]), "Needs a newer QuickCut"));
  ok("not a project", await bad(new Blob([crypto.getRandomValues(new Uint8Array(5000))]), "Can't open project"));
  document.querySelector(".toasts")?.replaceChildren();
  await q.open([new File([crypto.getRandomValues(new Uint8Array(5000))], "x.qcut")]);
  await wait(50);
  ok("foreign file dropped", lastToast()?.classList.contains("bad") && photoSig() === before, lastToast()?.textContent);
  // two more documents (Recents)
  await richDoc("p2.png", 22);
  await saved();
  sigs["p2.png"] = photoSig();
  await q.openNew([await mk(300, 200, 33, "p3.png")]);
  await wait(300);
  await q.open([await mk(120, 90, 34, "p3top.png", true)]);
  await saved();
  sigs["p3.png"] = photoSig();
  localStorage.setItem("qc.projecttest", JSON.stringify(sigs));
  return { pass: !fails.length, fails, out };
}

export async function photoB() {
  const q = P(), out = {}, fails = [];
  const ok = (n, c, info) => { out[n] = c ? true : info ?? false; if (!c) fails.push(n); };
  const sigs = JSON.parse(localStorage.getItem("qc.projecttest") || "{}");
  const v = document.getElementById("view-photo");
  await until(() => !v.querySelector(".resume-box")?.hidden && v.querySelector(".recents .recent"));
  // Continue: the last document
  let t0 = performance.now();
  v.querySelector(".resume-go").click();
  await until(() => q.doc?.name === "p3.png" && q.doc.layers.length === 2);
  out.continueMs = Math.round(performance.now() - t0);
  await wait(200);
  ok("continue identical", photoSig() === sigs["p3.png"]);
  // each Recent
  for (const name of ["p1.png", "p2.png", "p3.png"]) {
    const b = [...v.querySelectorAll(".recents .recent")].find((x) => x.querySelector(".name").textContent === name);
    if (!b) { ok(`recent ${name}`, false, "missing"); continue; }
    const n0 = q.stats.open.length;
    t0 = performance.now();
    b.click();
    await until(() => q.stats.open.length > n0 && q.doc?.name === name);
    out[`recentMs ${name}`] = Math.round(performance.now() - t0);
    await wait(200);
    ok(`recent ${name}`, photoSig() === sigs[name]);
  }
  // a Photo project opened in Video switches to Photo
  const blob = await q.writeProject("best");
  location.hash = "#video";
  await until(() => window.__qcVideo?.openProject);
  await window.__qcVideo.openProject(blob);
  await until(() => location.hash === "#photo" && !document.getElementById("view-photo").hidden);
  await wait(500);
  ok("video → photo", location.hash === "#photo" && photoSig() === sigs["p3.png"]);
  localStorage.removeItem("qc.projecttest");
  return { pass: !fails.length, fails, out };
}

/** Reopen time with 4 large painted layers (pixels, not files), and memory over several reopens. */
export async function speed({ W = 4000, H = 3000, reps = 5 } = {}) {
  const q = P(), out = {};
  const { make } = await import("./qcut/qcuttest.js");
  const types = ["photo", "ui", "sparse", "text"];
  const files = await Promise.all(types.map(async (t, i) => new File([await (await make(t, W, H)).convertToBlob({ type: "image/png" })], `${t}.png`, { type: "image/png", lastModified: i + 1 })));
  await q.openNew([files[0]]);
  for (const f of files.slice(1)) await q.open([f]);
  await wait(500);
  // a stroke on every layer: they become pixels (not their files)
  const { drag } = pointer();
  for (const l of q.doc.layers) { q.select(l.id); key({ key: "b", code: "KeyB" }); drag(100, 100, W - 100, H - 100); }
  key({ key: "v", code: "KeyV" });
  const t0 = performance.now();
  const rec = await q.record();
  out.saveMs = Math.round(performance.now() - t0);
  out.bytes = rec.project?.size ?? (rec.state?.layers || []).reduce((n, l) => n + (l.px?.b?.size || 0) + (l.mask?.px?.b?.size || 0), 0); // old sessions: PNG per layer
  const sig = photoSig(), times = [], mem = [];
  for (let i = 0; i < reps; i++) {
    const t1 = performance.now();
    await q.resume(rec);
    await until(() => q.doc.layers.length === 4);
    times.push(Math.round(performance.now() - t1));
    if (window.gc) window.gc();
    const m = await q.mem();
    mem.push({ layersMB: m.layersMB, jsHeapMB: m.jsHeapMB });
  }
  out.reopenMs = times; out.mem = mem;
  out.identical = photoSig() === sig;
  const heap = mem.map((m) => m.jsHeapMB).filter((x) => x != null);
  out.memBounded = mem.every((m) => m.layersMB === mem[0].layersMB) && (!heap.length || heap[heap.length - 1] - heap[0] < 200);
  return { pass: out.identical && out.memBounded, out };
}

// ── Video ──────────────────────────────────────────────────────────────────
const V = () => window.__qcVideo;
const vfile = async () => new File([await (await fetch("/_test/zz_h264.mp4")).blob()], "zz_h264.mp4", { type: "video/mp4", lastModified: 1000 });
const vstate = () => { const s = V().state(); return JSON.stringify({ P: s.P, sel: s.sel, C: s.C, tl: +s.tl.toFixed(3) }); };
export async function videoA() {
  const out = {}, fails = [];
  const ok = (n, c, info) => { out[n] = c ? true : info ?? false; if (!c) fails.push(n); };
  await until(() => V());
  const file = await vfile();
  const n0 = V().opens.length;
  V().openFile(file, undefined, { P: [{ start: 1, end: 4, speed: 1, volume: 1 }, { start: 6, end: 9, speed: 2, volume: 0.5 }, { start: 12, end: 15, speed: 0.5, volume: 1.5 }], sel: [1], C: { M: [0, -1, 1, 0], rect: { x: 20, y: 10, w: 400, h: 300 }, aspect: "Free" }, tl: 2.5, name: "cut" });
  await until(() => V().opens.length > n0);
  ok("thumbs + waveform made", await until(() => V().thumbCount() > 5 && V().peaksDone(), 60000), [V().thumbCount(), V().peaksDone()]);
  const s0 = vstate();
  // Save project → open it (re-linked to the same file): same edit, timeline caches there at once
  const blob = await V().projectBlob("best");
  out.bytes = blob.size;
  const asks0 = V().thumbAsks || 0, n1 = V().opens.length;
  const t0 = performance.now();
  await V().openProject(blob, { relink: async () => file });
  await until(() => V().opens.length > n1);
  out.openMs = Math.round(performance.now() - t0);
  ok("project same edit", vstate() === s0, [vstate(), s0]);
  await wait(300);
  ok("cached thumbnails", V().thumbCount() > 5, V().thumbCount());
  ok("cached waveform", V().peaksDone());
  // relink: a different file is refused, the right one accepted
  const wrong = new File([new Uint8Array(1000)], "zz_h264.mp4", { type: "video/mp4" });
  document.querySelector(".toasts")?.replaceChildren();
  const pick = window.showOpenFilePicker;
  window.showOpenFilePicker = async () => [{ kind: "file", getFile: async () => wrong }];
  await V().openProject(blob, { relink: async () => null });
  await wait(100);
  ok("wrong file refused", /^That isn't/.test(lastToast()?.textContent || ""), lastToast()?.textContent);
  window.showOpenFilePicker = async () => [{ kind: "file", getFile: async () => file }];
  const n2 = V().opens.length;
  await V().openProject(blob, { relink: async () => null });
  ok("asked file accepted", await until(() => V().opens.length > n2) && vstate() === s0);
  window.showOpenFilePicker = pick;
  // (the fake picker's handle can't be stored: open it once more without one)
  const n3 = V().opens.length;
  await V().openProject(blob, { relink: async () => file });
  await until(() => V().opens.length > n3);
  // corrupt / foreign: a short error toast, the edit stays
  const u8 = new Uint8Array(await blob.arrayBuffer()); u8[Math.floor(u8.length / 2)] ^= 1;
  document.querySelector(".toasts")?.replaceChildren();
  await V().openProject(new Blob([u8]), { relink: async () => file });
  await wait(100);
  ok("corrupt refused", lastToast()?.textContent.trim() === "Can't open project" && vstate() === s0, lastToast()?.textContent);
  // the session is saved (flush on pagehide is covered by sessiontest); wait for the autosave
  await wait(2500);
  localStorage.setItem("qc.projecttest.v", s0);
  return { pass: !fails.length, fails, out };
}
export async function videoB() {
  const out = {}, fails = [];
  const ok = (n, c, info) => { out[n] = c ? true : info ?? false; if (!c) fails.push(n); };
  await until(() => V());
  const s0 = localStorage.getItem("qc.projecttest.v");
  const v = document.getElementById("view-video");
  await until(() => v.querySelector(".resume-go"));
  const file = await vfile();
  // no handle and no copy (the video is never stored): QuickCut asks for it and checks it
  const pick = window.showOpenFilePicker;
  window.showOpenFilePicker = async () => [{ kind: "file", getFile: async () => file }];
  const n0 = V().opens.length, t0 = performance.now();
  v.querySelector(".resume-go").click();
  ok("continue", await until(() => V().opens.length > n0));
  out.continueMs = Math.round(performance.now() - t0);
  ok("continue same edit", vstate() === s0, [vstate(), s0]);
  await wait(200);
  ok("continue cached thumbnails", V().thumbCount() > 5, V().thumbCount());
  // the Recent
  const b = [...v.querySelectorAll(".recents .recent")].find((x) => x.querySelector(".name").textContent === "zz_h264.mp4");
  ok("recent listed", !!b);
  if (b) {
    const n1 = V().opens.length;
    b.click();
    ok("recent same edit", (await until(() => V().opens.length > n1)) && vstate() === s0, vstate());
  }
  // a Video project opened in Photo switches to Video
  const vb = await V().projectBlob("quick");
  location.hash = "#photo";
  await until(() => document.getElementById("view-photo")?._qc);
  const n2 = V().opens.length;
  await document.getElementById("view-photo")._qc.openProject(vb);
  ok("photo → video", (await until(() => location.hash === "#video" && V().opens.length > n2)) && vstate() === s0, [location.hash, vstate()]);
  window.showOpenFilePicker = pick;
  localStorage.removeItem("qc.projecttest.v");
  return { pass: !fails.length, fails, out };
}

// ── migration: old sessions (PNG per layer / the edit as JSON) become projects once ──
const png = (w, h, color) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = color; g.fillRect(0, 0, w, h); g.fillStyle = "#123456"; g.fillRect(5, 5, w / 2, h / 3); return new Promise((r) => c.toBlob(r, "image/png")); };
export async function migA() {
  const { session, recents } = await import("../shared/ui.js");
  const file = new File([await png(300, 200, "#ff8800")], "old.png", { type: "image/png", lastModified: 5 });
  const mask = await png(120, 80, "#ffffff");
  const state = {
    v: 2, name: "old.png", size: file.size, type: "image/png", w: 300, h: 200, w0: 300, h0: 200, note: "", sel: 2,
    layers: [
      { id: 1, parent: null, name: "Background", named: false, kind: "image", x: 0, y: 0, opacity: 1, blend: "normal", visible: true, clip: false, text: null, px: { b: file } },
      { id: 2, parent: 9, name: "Top", named: true, kind: "image", x: 40, y: 30, ta: 0.5, tb: 0, tc: 0, td: 0.5, opacity: 0.8, blend: "multiply", visible: true, clip: false, text: null, px: { b: await png(120, 80, "#00aa44") }, mask: { px: { b: mask }, on: true, shift: 0, soft: 0, base: null } },
    ],
    groups: [{ id: 9, parent: null, name: "Group 1", opacity: 1, blend: "pass", visible: true }], collapsed: [], multi: [], selection: { kind: "rect", x: 10, y: 10, w: 50, h: 40 },
    tool: "move", selShape: "rect", view: { fitted: true, cap: true }, brush: {}, eraser: {}, textOpts: {}, crop: null, docCrop: null,
  };
  await session.save("photo", { name: "old.png", sub: "300×200", thumb: await png(32, 21, "#ff8800"), state });
  const vfile = new File([new Uint8Array(4096).fill(7)], "old.mp4", { type: "video/mp4", lastModified: 6 });
  await session.save("video", { name: "old.mp4", size: vfile.size, sub: "", thumb: null, file: vfile, state: { P: [{ start: 1, end: 2, speed: 1, volume: 1 }], sel: [0], C: { M: [1, 0, 0, 1], rect: null, aspect: "Free" }, tl: 0.5, zoom: 0.3, scroll: 0, name: "old_trim" } });
  // an old Recent (no project): still opens its file
  await recents.add("photo", { file: new File([await png(64, 48, "#3366ff")], "oldrecent.png", { type: "image/png", lastModified: 7 }), thumb: await png(8, 6, "#3366ff"), sub: "64×48" });
  return { pass: true };
}
export async function migB() {
  const out = {}, fails = [];
  const ok = (n, c, info) => { out[n] = c ? true : info ?? false; if (!c) fails.push(n); };
  const { session } = await import("../shared/ui.js");
  await until(async () => (await session.load("photo"))?.project);
  const ps = await session.load("photo");
  ok("photo converted", !!ps.project && !ps.state && ps.pid === "photo:session", Object.keys(ps));
  const q = P(), v = document.getElementById("view-photo");
  await until(() => v.querySelector(".resume-go"));
  v.querySelector(".resume-go").click();
  await until(() => q.doc?.name === "old.png");
  await wait(200);
  const D = q.doc, top = D.layers.find((l) => l.name === "Top");
  ok("photo restored", D.layers.length === 2 && D.groups.length === 1 && top?.parent === 9 && top.blend === "multiply" && q.lm(top)[0] === 0.5 && !!top.mask && q.selection?.w === 50, D.layers.map((l) => l.name));
  // old Recent without a project: opens the file as before
  const b = [...v.querySelectorAll(".recents .recent")].find((x) => x.querySelector(".name").textContent === "oldrecent.png");
  if (b) { b.click(); await until(() => q.doc?.name === "oldrecent.png"); }
  ok("old recent opens file", q.doc?.name === "oldrecent.png" && q.doc.layers.length === 1, q.doc?.name);
  // the old video session: the copy is gone, the video is asked for and checked
  location.hash = "#video"; // the Video tool converts its own session when it starts
  await until(async () => V() && (await session.load("video"))?.project);
  const vs = await session.load("video");
  ok("video converted", !!vs.project && !vs.state && !vs.file, Object.keys(vs));
  const f = await import("../shared/qcut.js"), pf = await f.read(vs.project), pd = await pf.loadAll();
  ok("video project", pd.edit.pieces.length === 1 && pd.edit.name === "old_trim" && /^sha256:/.test(pd.source.hash), pd.source);
  return { pass: !fails.length, fails, out };
}

// ── leaving the page right after an edit: the pagehide flush writes it in that same task ──
// (headless Chrome drops every IndexedDB write made while a page unloads, old code and new alike, so the
// flush is checked by dispatching pagehide; its transaction must start synchronously, see sessiontest)
export async function flush() {
  const q = P(), { session } = await import("../shared/ui.js");
  await q.openNew([await mk(320, 240, 77, "flush.png")]);
  await saved();
  q.ops.new();
  const { drag } = pointer();
  key({ key: "b", code: "KeyB" });
  drag(10, 10, 300, 200);
  key({ key: "v", code: "KeyV" });
  const want = photoSig(), tr = IDBDatabase.prototype.transaction;
  let started = 0;
  IDBDatabase.prototype.transaction = function (...a) { if ([a[0]].flat().includes("sessions") && a[1] === "readwrite") started++; return tr.apply(this, a); };
  try { dispatchEvent(new Event("pagehide")); } finally { IDBDatabase.prototype.transaction = tr; }
  await wait(400);
  const rec = await session.load("photo");
  await q.openProject(rec.project);
  return { pass: started > 0 && photoSig() === want, started, layers: q.doc.layers.length };
}
