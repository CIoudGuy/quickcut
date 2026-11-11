// QuickCut Photo: crop, layers, brush, text and export, all on the device.
// Layers are GPU canvases (OffscreenCanvas 2D); the view composites only what is on screen, at
// screen resolution, and only when something changed. Decoding and export run in a Worker.
import {
  icon, h, $$, esc, isPhone, fmtBytes, baseName, openLayer, topLayer, toast, pickFiles, intake,
  recents, renderRecents, session, renderResume, thumbOf, makeMovable, groupBar, doneCard, download, copyText, copyImage, mod, isTyping, syncSlider,
  recentId, MAX_KEEP_BYTES,
} from "../shared/ui.js";
import * as qcut from "../shared/qcut.js";
import { createKeys, baseKey } from "../shared/keys.js";
import { composite, tree, buffers, mul, T, S, R, ap, inv, scaleOf, reduced, BLENDS, BLEND_MENU, PASS, canvasLimit, fitScale, I } from "./engine.js";
import { deriveMask, alphaToImageData } from "./maskops.js";
import { createUpscale } from "./upscale-ui.js";

const cssHref = new URL("./photo.css", import.meta.url).href;
if (!document.querySelector(`link[href="${cssHref}"]`)) document.head.append(h(`<link rel="stylesheet" href="${cssHref}">`));

// local icons the shared set doesn't have
const PI = {
  ellipse: "M8 3c3.3 0 5.5 2.2 5.5 5S11.3 13 8 13 2.5 10.8 2.5 8 4.7 3 8 3z",
  lasso: "M8 2.8c3.2 0 5.5 1.6 5.5 3.7S11.2 10.2 8 10.2 2.5 8.6 2.5 6.5 4.8 2.8 8 2.8zM5.2 9.6c-.6.9-.8 1.8-.4 2.6.5.9 1.6 1 2.4.6",
  alignL: "M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7",
  alignC: "M2.5 3.5h11M4.5 6.5h7M2.5 9.5h11M4.5 12.5h7",
  alignR: "M2.5 3.5h11M6.5 6.5h7M2.5 9.5h11M6.5 12.5h7",
  magnet: "M3.5 2.5h3v5.2a1.5 1.5 0 0 0 3 0V2.5h3v5.2a4.5 4.5 0 0 1-9 0zM3.5 5h3M9.5 5h3",
  mask: "M2.5 2.5h11v11h-11zM8 4.8a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM4.6 13.5c.5-1.9 1.8-2.9 3.4-2.9s2.9 1 3.4 2.9",
  cutout: "M8 4.6a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM4.6 13c.5-2.1 1.8-3.1 3.4-3.1s2.9 1 3.4 3.1M2.5 5V2.5H5M11 2.5h2.5V5M13.5 11v2.5H11M5 13.5H2.5V11",
  selNew: "M3 3h10v10H3z",
  selAdd: "M2.5 5.5h7v7h-7zM11.5 1.5v5M9 4h5",
  selSub: "M2.5 5.5h7v7h-7zM9 4h5",
  selInt: "M2.5 2.5h7v7h-7zM6.5 6.5h7v7h-7z",
};
const ACCEPT = "image/*,.heic,.heif,.avif,.qcut";
const TYPES = [{ description: "Images", accept: { "image/*": [".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".bmp", ".heic", ".heif"], [qcut.MIME]: [qcut.EXT] } }];
const isImage = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|avif|gif|bmp|heic|heif)$/i.test(f.name);
// a project (.qcut, recognised by its first bytes): any file that isn't plainly an image or a video
const maybeProject = (f) => !isImage(f) && !/^(video|audio|text)\//.test(f.type);
const LIM = canvasLimit(navigator.userAgent);
// undo memory: 384 MB on an 8 GB device (192 MB at 4 GB, at least 128 MB); the oldest steps go first
const BUDGET = Math.max(128, Math.min(384, (navigator.deviceMemory || 8) * 48)) * 1024 * 1024;
// [tool, name, shortcut action]
const TOOLS = [
  ["move", "Move", "move"], ["select", "Select", "marquee"], ["crop", "Crop", "crop"],
  ["brush", "Brush", "brush"], ["eraser", "Eraser", "eraser"], ["mask", "Refine mask", "mask"], ["text", "Text", "text"], ["eyedrop", "Eyedropper", "eyedrop"],
];
const K = createKeys({ id: "photo", title: "Photo" });
const ASPECTS = [["Free", 0], ["1:1", 1], ["4:5", 4 / 5], ["16:9", 16 / 9], ["9:16", 9 / 16], ["Original", -1]];
const FORMATS = { png: ["PNG", "image/png", "png"], jpeg: ["JPG", "image/jpeg", "jpg"], webp: ["WebP", "image/webp", "webp"] };
const SHAPES = [["rect", "Rectangle", "select"], ["ellipse", "Ellipse", PI.ellipse], ["lasso", "Lasso", PI.lasso]];
const FONT_ASC = 0.96875, FONT_DESC = 0.2421875; // Inter metrics, so canvas text sits where the editor's text is
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// always give the canvas its 2D context: createImageBitmap() fails on a context-less OffscreenCanvas
const blank = (w, h) => { const c = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h))); c.getContext("2d"); return c; };

// ── workers ─────────────────────────────────────────────────────────────────
const pool = {};
const onIdle = {}; // name → called when that worker said it's idle and was ended
function worker(name) {
  if (pool[name]) return pool[name];
  // "bg" is the background remover, "up" the upscaler (each: model + ONNX Runtime); every other name is a photo worker
  const url = name === "bg" ? "./bg.js" : name === "up" ? "./upscale.js" : "./worker.js";
  const w = { wk: new Worker(new URL(url, import.meta.url), { type: "module" }), pending: new Map(), seq: 0, docVer: -1 };
  w.wk.onmessage = (e) => {
    // an idle worker (the background remover, after a minute without work) is ended: that frees
    // its memory (the WebAssembly heap can't shrink); it restarts on the next use
    if (e.data.idle) { if (!w.pending.size && pool[name] === w) { w.wk.terminate(); delete pool[name]; onIdle[name]?.(); } return; }
    const p = w.pending.get(e.data.id);
    if (!p) return;
    if (e.data.progress) { p.onProgress?.(e.data); return; }
    w.pending.delete(e.data.id);
    e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data);
  };
  w.wk.onerror = (e) => {
    e.preventDefault?.();
    for (const p of w.pending.values()) p.reject(new Error(e.message || "worker failed"));
    w.pending.clear();
    if (pool[name] === w) { w.wk.terminate(); delete pool[name]; }
  };
  return (pool[name] = w);
}
function call(name, msg, transfer = [], onProgress = null) {
  const w = worker(name);
  return new Promise((resolve, reject) => {
    const id = ++w.seq;
    w.pending.set(id, { resolve, reject, onProgress });
    w.wk.postMessage({ ...msg, id }, transfer);
  });
}
function kill(name) {
  const w = pool[name];
  if (!w) return;
  w.wk.terminate();
  delete pool[name];
  for (const p of w.pending.values()) p.reject(new Error("cancelled"));
}

export function mount(root) {
  root.innerHTML = `
<div class="ph">
  <div class="empty">
    <div class="resume-box" hidden></div>
    <button class="drop" type="button">
      <span class="glyph">${icon("image", 22)}</span>
      <span class="title">Open photo</span>
      <span class="hint">JPG, PNG, WebP, AVIF, GIF, BMP, HEIC, QCUT</span>
    </button>
    <section class="recents" aria-label="Recent files" hidden><span class="label">Recent</span><div class="grid"></div></section>
    <a class="credit-phone" href="https://github.com/CIoudGuy/quickcut" target="_blank" rel="noopener">QuickCut is open source on GitHub</a>
  </div>
  <div class="ph-doc" hidden>
    <div class="actions">
      <button class="ib" type="button" data-a="undo" data-kact="undo" aria-label="Undo" title="Undo">${icon("undo")}</button>
      <button class="ib" type="button" data-a="redo" data-kact="redo" aria-label="Redo" title="Redo">${icon("redo")}</button>
      <span class="sep"></span>
      <span class="file"><span class="n"></span><span class="m"></span></span>
      <button class="btn-g" type="button" data-a="resize" aria-haspopup="dialog" aria-expanded="false" aria-label="Size" title="Size">${icon("resize")}<span class="desk-only">Size</span></button>
      <button class="btn-g phone-only" type="button" data-a="crop-cancel" hidden>Cancel</button>
      <button class="btn-p phone-only" type="button" data-a="crop-apply" hidden>Apply</button>
      <button class="btn-p exp" type="button" data-a="export" aria-haspopup="dialog" aria-expanded="false">${icon("exp")}Export<span class="kbd desk-only" data-kact="export"></span></button>
    </div>
    <main class="ph-stage" data-wheel-zoom>
      <canvas class="ph-canvas" role="img" aria-label="Photo"></canvas>
      <canvas class="ph-ants" aria-hidden="true"></canvas>
      <span class="ph-chip" hidden></span>
      <textarea class="ph-text" hidden spellcheck="false" aria-label="Text"></textarea>
      <div class="ph-props ph-crop float" role="toolbar" aria-label="Crop options" hidden><div class="pp"></div></div>
      <div class="ph-props ph-prop float" role="toolbar"><div class="pp"></div></div>
      <div class="ph-tools float" role="toolbar" aria-label="Tools"><div class="tt"></div></div>
      <section class="ph-layers float" aria-label="Layers">
        <button class="head" type="button" aria-expanded="true">Layers<span class="n"></span>${icon("chev", 14)}</button>
        <div class="ly-body"><div class="ly-list" role="list"></div><div class="ly-foot"></div></div>
      </section>
      <button class="ph-layers-btn float" type="button" aria-expanded="false">${icon("layers")}Layers<span class="n"></span></button>
      <div class="ph-zoom float"><button class="zv" type="button" data-kact="zoom100" title="Zoom to 100%">100%</button><button class="zf" type="button" data-kact="fit" aria-label="Fit" title="Fit">${icon("fit", 14)}</button><button class="zk desk-only" type="button" data-kact="sheet" aria-label="Shortcuts" title="Shortcuts">?</button></div>
    </main>
  </div>
</div>`;
  const q = (s) => root.querySelector(s);
  const ph = q(".ph"), resumeBox = q(".resume-box"), emptyEl = q(".empty"), dropBtn = q(".drop"), recentsBox = q(".recents"), docEl = q(".ph-doc");
  const stage = q(".ph-stage"), cv = q(".ph-canvas"), chip = q(".ph-chip"), ta = q(".ph-text");
  const cropBar = q(".ph-crop"), propBar = q(".ph-prop"), ppAll = [q(".ph-crop .pp"), q(".ph-prop .pp")];
  let props = ppAll[1];
  const activeBar = () => (crop ? cropBar : propBar);
  const toolsEl = q(".ph-tools"), toolsIn = q(".ph-tools .tt"), card = q(".ph-layers"), cardBtn = q(".ph-layers-btn");
  const lyBody = q(".ly-body"), lyList = q(".ly-list"), lyFoot = q(".ly-foot"), zoomV = q(".zv");
  const fileN = q(".file .n"), fileM = q(".file .m");
  const btn = (a) => q(`[data-a="${a}"]`);
  const ctx = cv.getContext("2d", { alpha: false, desynchronized: true });
  const antsCv = q(".ph-ants"), actx = antsCv.getContext("2d");

  makeMovable(cropBar, "photo.crop");
  makeMovable(propBar, "photo.props");
  groupBar(cropBar);
  groupBar(propBar);
  makeMovable(toolsEl, "photo.tools", { vertical: true });
  makeMovable(card, "photo.layers", { vertical: true });
  makeMovable(q(".ph-zoom"), "photo.zoom");

  // ── state ─────────────────────────────────────────────────────────────────
  let doc = null, visible = false;
  const view = { z: 1, ox: 0, oy: 0, fitted: true, cap: true };
  let rect = { left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1 }, k = 1, zf = 1;
  let tool = "move", selShape = "rect", selMode = "new";
  const brush = { size: 40, hard: 80, opacity: 100, color: "#FFFFFF", bg: "#000000" };
  const eraser = { size: 80, hard: 80, opacity: 100 };
  const isPaint = () => tool === "brush" || tool === "eraser" || tool === "mask";
  const optsOf = (t) => (t === "brush" ? brush : t === "mask" ? maskBrush : eraser);
  const textOpts = { size: 120, color: "#FFFFFF", weight: 600, align: "left", font: "Inter", italic: false, ps: null, style: "Semibold" };
  let selection = null, crop = null, stroke = null, gesture = null, pinch = null, editing = null, picked = null;
  const pointers = new Map();
  let space = false, hover = null, seq = 1;
  const vb = buffers();
  let vctx = null, dirty = true, raf = 0, bg = "#0E0E0F", acc = "#2F6FEB";
  const stats = { open: [], frame: [], latency: [], exports: [] };
  let lastInput = 0, preview = null;
  /** Show the brush (or text size) on the canvas while a control changes; fades ~600 ms after the last change. */
  function showPreview(kind) { preview = { kind, until: performance.now() + 600 }; invalidate(); }

  // ── snapping ──────────────────────────────────────────────────────────────
  // Edges and centres snap to the image edges/centre (and thirds while cropping) and to other
  // layers' edges/centres. Alt or Ctrl while dragging bypasses it; N or Shift+; toggles it.
  let snapOn = true, guides = null;
  const snapTol = () => (7 * zf) / view.z;
  const bypass = (ev) => !snapOn || !!(ev && (ev.altKey || (!quickDrag && (ev.ctrlKey || ev.metaKey))));
  function snapAxis(cands, targets, tol) {
    let best = null;
    for (const c of cands) for (const t of targets) { const d = t - c; if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t }; }
    return best;
  }
  /** Snap targets in document space (or work space through `M` while cropping). */
  function snapTargets(exclude, M = null, thirds = false) {
    const W = M ? workSize().w : doc.w, H = M ? workSize().h : doc.h;
    const xs = [0, W / 2, W], ys = [0, H / 2, H];
    if (thirds) { xs.push(W / 3, (2 * W) / 3); ys.push(H / 3, (2 * H) / 3); }
    for (const l of doc.layers) {
      if (l === exclude || !l.visible) continue;
      const bb = aabb(l);
      let x0 = bb.x, y0 = bb.y, x1 = bb.x + bb.w, y1 = bb.y + bb.h;
      if (x0 <= 0 && y0 <= 0 && x1 >= doc.w && y1 >= doc.h) continue; // covers everything: nothing new
      if (M) {
        const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => ap(M, x, y));
        x0 = Math.min(...pts.map((q) => q[0])); x1 = Math.max(...pts.map((q) => q[0]));
        y0 = Math.min(...pts.map((q) => q[1])); y1 = Math.max(...pts.map((q) => q[1]));
      }
      xs.push(x0, (x0 + x1) / 2, x1);
      ys.push(y0, (y0 + y1) / 2, y1);
    }
    return { xs, ys };
  }
  /** Snap one point; returns [x, y] and sets the guides. */
  function snapPoint(x, y, ev, t, sx = true, sy = true) {
    if (bypass(ev)) { guides = null; return [x, y]; }
    const tol = snapTol();
    const bx = sx ? snapAxis([x], t.xs, tol) : null, by = sy ? snapAxis([y], t.ys, tol) : null;
    guides = bx || by ? { x: bx ? [bx.t] : [], y: by ? [by.t] : [] } : null;
    return [x + (bx?.d || 0), y + (by?.d || 0)];
  }
  /** Snap a box (its edges and centre); returns [dx, dy] and sets the guides. */
  function snapBox(x, y, w, hh, ev, t) {
    if (bypass(ev)) { guides = null; return [0, 0]; }
    const tol = snapTol();
    const bx = snapAxis([x, x + w / 2, x + w], t.xs, tol), by = snapAxis([y, y + hh / 2, y + hh], t.ys, tol);
    guides = bx || by ? { x: bx ? [bx.t] : [], y: by ? [by.t] : [] } : null;
    return [bx?.d || 0, by?.d || 0];
  }
  function drawGuides() {
    if (!guides) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#FF4FD8";
    const lw = Math.max(1, Math.round(k));
    for (const x of guides.x) ctx.fillRect(Math.round((view.ox + x * view.z) * k), 0, lw, cv.height);
    for (const y of guides.y) ctx.fillRect(0, Math.round((view.oy + y * view.z) * k), cv.width, lw);
  }
  function toggleSnap() {
    snapOn = !snapOn;
    for (const b of props.querySelectorAll('[data-p="snap"]')) b.setAttribute("aria-pressed", String(snapOn));
    savePrefs();
    toast(snapOn ? "Snapping on" : "Snapping off", { ms: 1200, info: true });
  }
  const snapBtn = () => `<button class="ib" type="button" data-p="snap" aria-pressed="${snapOn}" aria-label="${K.tip("Snap", "snap")}" title="${K.tip("Snap", "snap")}">${icon(PI.magnet)}</button>`;

  const selLayer = () => doc?.layers.find((l) => l.id === doc.sel) || null;
  const idx = (id) => doc.layers.findIndex((l) => l.id === id);

  // ── groups ────────────────────────────────────────────────────────────────
  // doc.layers holds the pixel layers in stacking order (bottom first); doc.groups the layer groups
  // {id, group: true, name, opacity, blend ("pass" or a mode), visible, clip, parent}. A layer's or
  // group's `parent` is the id of the group it's in (null at the top). A group's layers always sit
  // next to each other in doc.layers (normalize() keeps it so) and the group sits where they are.
  // doc.sel and the multi-selection hold layer or group ids.
  const grp = (id) => (id == null || !doc ? null : doc.groups.find((g) => g.id === id) || null);
  const nodeOf = (id) => doc?.layers.find((l) => l.id === id) || grp(id);
  const selNode = () => (doc ? nodeOf(doc.sel) : null);
  const selGroup = () => grp(doc?.sel);
  /** Whether `n` is inside group `gid` (at any depth). */
  function inside(n, gid) { for (let p = n.parent, i = 0; p != null && i < 64; p = grp(p)?.parent, i++) if (p === gid) return true; return false; }
  const covers = (n, l) => n === l || (!!n.group && inside(l, n.id));
  /** The pixel layers a node stands for (a group: all of its layers), bottom first. */
  const layersOf = (n) => (n.group ? doc.layers.filter((l) => inside(l, n.id)) : [n]);
  /** The node directly in `parent` (a group id or null) that holds layer `l`. */
  function childOf(parent, l) { for (let n = l, i = 0; n && i < 64; n = grp(n.parent), i++) if ((n.parent ?? null) === parent) return n; return null; }
  /** A group's (or the top level's) direct children, bottom first. */
  function kids(parent) { const out = []; for (const l of doc.layers) { const n = childOf(parent, l); if (n && out[out.length - 1] !== n) out.push(n); } return out; }
  const sibs = (n) => kids(n.parent ?? null);
  const below = (n) => { const s = sibs(n), i = s.indexOf(n); return i > 0 ? s[i - 1] : null; };
  const canClip = (n) => !!n && !!below(n);
  /** The outermost group `l` is in (itself when it's in none). */
  const outer = (l) => { let n = l; for (let i = 0; grp(n.parent) && i < 64; i++) n = grp(n.parent); return n; };
  /** After structure changes: drop groups without layers and broken links, keep each group's layers together, nothing clipped at the bottom of a group. */
  function normalize() {
    for (const g of doc.groups) for (let p = g.parent, i = 0; p != null; p = grp(p)?.parent, i++) if (p === g.id || i > 64) { g.parent = null; break; }
    for (const n of [...doc.layers, ...doc.groups]) if (n.parent != null && !grp(n.parent)) n.parent = null;
    const used = new Set();
    for (const l of doc.layers) for (let p = l.parent; p != null && !used.has(p); p = grp(p)?.parent) used.add(p);
    doc.groups = doc.groups.filter((g) => used.has(g.id));
    const order = [], fix = (ns) => {
      if (ns[0]) (ns[0].ref || ns[0]).clip = false;
      for (const n of ns) if (n.group) fix(n.children); else order.push(n);
    };
    fix(tree(doc.layers, doc.groups));
    doc.layers = order;
  }
  const newLayer = (o) => ({ id: seq++, name: "Layer", kind: "paint", canvas: null, x: 0, y: 0, opacity: 1, blend: "normal", visible: true, clip: false, ...o });
  function copyCanvas(src) { const c = blank(src.width, src.height); c.getContext("2d").drawImage(src, 0, 0); return c; }

  // ── smart layers: the source pixels + a transform ────────────────────────
  // A layer keeps its own pixels (`canvas`: the source, stored once at full size) and a matrix
  // layer → document: `x, y` (where its pixel (0, 0) lands) and, when it is scaled, rotated or
  // flipped, the linear part `ta tb tc td` (absent = none). The view, export, copies and thumbnails
  // resample from the source through it every time (high-quality filter, mip levels when small), so
  // scaling down and back up loses nothing, and undo keeps four numbers instead of pixels. Brush,
  // eraser and mask strokes go straight into the source (through the inverse matrix) while the
  // layer is scaled evenly (any rotation or flip) and at most 2× up; beyond that a stroke would be
  // coarser than what you see, so the layer has to be rasterized first (asked when you paint).
  const TF = ["ta", "tb", "tc", "td"];
  const lin = (l) => [l.ta ?? 1, l.tb ?? 0, l.tc ?? 0, l.td ?? 1];
  /** Layer pixels → document. */
  const lm = (l) => { const [a, b, c, d] = lin(l); return [a, b, c, d, l.x, l.y]; };
  const plain = (l) => l.ta === undefined;
  const tfOf = (l) => (plain(l) ? {} : { ta: l.ta, tb: l.tb, tc: l.tc, td: l.td });
  /** Set a layer's matrix (float drift from chained steps is snapped away, so 5% → 100% is exactly 1:1 again). */
  function setLm(l, A) {
    const q = (v) => (Math.abs(v) < 1e-9 ? 0 : Math.abs(v - 1) < 1e-9 ? 1 : Math.abs(v + 1) < 1e-9 ? -1 : v);
    const r = (v) => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : v);
    const [a, b, c, d] = [A[0], A[1], A[2], A[3]].map(q);
    l.x = r(A[4]); l.y = r(A[5]);
    if (a === 1 && b === 0 && c === 0 && d === 1) { for (const key of TF) delete l[key]; return; }
    Object.assign(l, { ta: a, tb: b, tc: c, td: d });
  }
  /** Move a layer by matrix N (document → new document). */
  const compose = (l, N) => setLm(l, mul(N, lm(l)));
  /** The layer's four corners in the document. */
  const quad = (l, A = lm(l)) => [[0, 0], [l.canvas.width, 0], [l.canvas.width, l.canvas.height], [0, l.canvas.height]].map(([x, y]) => ap(A, x, y));
  function aabb(l) {
    const p = quad(l), xs = p.map((v) => v[0]), ys = p.map((v) => v[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  /** Whole pixels covering a box. */
  const pxBox = (b) => { const x = Math.floor(b.x + 1e-6), y = Math.floor(b.y + 1e-6); return { x, y, w: Math.max(1, Math.ceil(b.x + b.w - 1e-6) - x), h: Math.max(1, Math.ceil(b.y + b.h - 1e-6) - y) }; };
  /** Whether document point (x, y) is on the layer's area. */
  const onLayer = (l, x, y) => { const [u, v] = ap(inv(lm(l)), x, y); return u >= 0 && v >= 0 && u <= l.canvas.width && v <= l.canvas.height; };
  /** Why strokes can't go straight into this layer's source (null: they can). */
  function unpaintable(l) {
    if (plain(l)) return null;
    const [a, b, c, d] = lin(l), s1 = Math.hypot(a, b), s2 = Math.hypot(c, d);
    if (Math.abs(s1 - s2) > 0.01 * Math.max(s1, s2) || Math.abs(a * c + b * d) > 0.01 * s1 * s2) return "stretched";
    return s1 > 2 ? "enlarged over 2×" : null;
  }
  function askRasterize(l, what) {
    toast(`Layer ${unpaintable(l)}`, { bad: true, action: "Rasterize", onAction: () => rasterize(l), ms: 7000 });
    return null;
  }
  /** After the background remover a layer holds two copies of its pixels: the photo (`preBg`) and the
   *  one with cleaned edge colours (`bgFixed`); `canvas` is one of them. Anything that replaces the
   *  layer's pixels goes through here so both copies get the same change. With only one of them
   *  changed, hiding the mask or painting Keep showed the cleaned colours as a halo on the photo. */
  const bgPair = (l) => !!(l.preBg && l.bgFixed && (l.canvas === l.preBg || l.canvas === l.bgFixed));
  function mapPx(l, fn) {
    if (!bgPair(l)) { l.canvas = fn(l.canvas); delete l.preBg; delete l.bgFixed; return; }
    const clean = l.canvas === l.bgFixed;
    l.preBg = fn(l.preBg); l.bgFixed = fn(l.bgFixed);
    l.canvas = clean ? l.bgFixed : l.preBg;
  }
  /** Turn a smart layer into plain pixels at the size it is seen (its mask too); one undo step. */
  function rasterize(l) {
    if (!l || l.group || plain(l)) return true;
    const b = pxBox(aabb(l));
    if (tooBig(b.w, b.h)) { toast(tooBigMsg(b.w, b.h), { bad: true }); return false; }
    const A = mul(T(-b.x, -b.y), lm(l));
    record("Rasterize layer", () => {
      remask(l, b.w, b.h, (mg, m) => { mg.setTransform(A[0], A[1], A[2], A[3], A[4], A[5]); mg.drawImage(m, 0, 0); });
      mapPx(l, (src) => {
        const red = reduced(src, scaleOf(A)), c = blank(b.w, b.h), g = c.getContext("2d"), D = red ? mul(A, S(red.sx, red.sy)) : A;
        g.imageSmoothingQuality = "high";
        g.setTransform(D[0], D[1], D[2], D[3], D[4], D[5]);
        g.drawImage(red ? red.src : src, 0, 0);
        return c;
      });
      for (const key of TF) delete l[key];
      l.x = b.x; l.y = b.y;
      if (l.kind === "text") { l.kind = "image"; delete l.text; }
    });
    return true;
  }
  /** Back to the source's own size (1:1), no rotation or flip, around the layer's centre. */
  function resetTransform(l) {
    if (!l || l.group || plain(l)) return;
    const w = l.canvas.width, hh = l.canvas.height, [cx, cy] = ap(lm(l), w / 2, hh / 2);
    record("Reset transform", () => setLm(l, [1, 0, 0, 1, Math.round(cx - w / 2), Math.round(cy - hh / 2)]));
  }

  // ── undo / redo ───────────────────────────────────────────────────────────
  // Structure and property changes keep before/after snapshots of the layer records (canvases are
  // shared, so they cost nothing unless replaced). Pixel edits keep only the changed rectangle.
  // Oldest steps are dropped once the total passes BUDGET.
  let hist = [], hi = 0, hbytes = 0, pendingBefore = null;
  const cbytes = (c) => c.width * c.height * 4;
  const cver = new WeakMap(); // canvas → pixel version (for the saved session: re-encode only what changed)
  const bump = (c) => cver.set(c, (cver.get(c) || 0) + 1);
  function push(e) {
    justOpened = false;
    for (const x of hist.splice(hi)) hbytes -= x.bytes;
    hist.push(e); hi++; hbytes += e.bytes;
    while (hbytes > BUDGET && hist.length > 1) { const x = hist.shift(); hi--; hbytes -= x.bytes; }
    syncUndo();
  }
  function undo() {
    if (gesture) return;
    if (justOpened && doc && !hist.length && !crop && !editing) { closeDoc(); return; }
    justOpened = false;
    // in Crop: first take back what was changed in Crop; nothing changed there = leave Crop and undo
    if (crop) {
      const changed = cropChanged();
      cancelCrop();
      if (changed) { enterCrop(); return; }
    }
    commitText();
    if (hi <= 0) return;
    const w = doc.w, hh = doc.h;
    hist[--hi].undo();
    afterHistory(w, hh);
  }
  function redo() {
    justOpened = false;
    if (gesture || hi >= hist.length) return;
    if (crop) cancelCrop();
    commitText();
    const w = doc.w, hh = doc.h;
    hist[hi++].redo();
    afterHistory(w, hh);
  }
  function afterHistory(w, hh) {
    for (const id of [...multi]) if (!nodeOf(id) || id === doc.sel) multi.delete(id);
    if (!nodeOf(doc.sel)) doc.sel = doc.layers[doc.layers.length - 1].id;
    if (doc.w !== w || doc.h !== hh) keepCentre(w, hh, doc.w, doc.h);
    changed({ structure: true });
  }
  function syncUndo() {
    if (!doc) return;
    btn("undo").disabled = hi <= 0 && !justOpened;
    btn("redo").disabled = hi >= hist.length;
    const u = hi > 0 ? `Undo ${hist[hi - 1].label}` : "Undo", r = hi < hist.length ? `Redo ${hist[hi].label}` : "Redo";
    btn("undo").title = K.tip(u, "undo"); btn("undo").setAttribute("aria-label", K.tip(u, "undo"));
    btn("redo").title = K.tip(r, "redo"); btn("redo").setAttribute("aria-label", K.tip(r, "redo"));
  }
  const snap = () => ({ w: doc.w, h: doc.h, crop: doc.crop, sel: doc.sel, note: doc.note, selection, layers: doc.layers.map((l) => ({ ...l })), groups: doc.groups.map((g) => ({ ...g })) });
  function restore(s) { doc.w = s.w; doc.h = s.h; doc.crop = s.crop; doc.sel = s.sel; doc.note = s.note; selection = s.selection; doc.layers = s.layers.map((l) => ({ ...l })); doc.groups = s.groups.map((g) => ({ ...g })); }
  /** Change the selection as its own undo step. */
  function setSelection(next, label) {
    const before = selection;
    selection = next;
    if (before !== next && doc) push({ label, bytes: 64, undo: () => { selection = before; }, redo: () => { selection = next; } });
    renderProps();
    invalidate();
  }
  // what a step holds that the other side doesn't: canvases (+ their zoomed-out copies) and mask bytes
  const objBytes = (o) => (o instanceof Uint8Array ? o.length : cbytes(o) * (o.width * o.height >= 4e6 ? 1.34 : 1));
  function diffBytes(a, b) {
    const cs = (s0) => new Set(s0.layers.flatMap((l) => [l.canvas, l.mask, l.maskBase, l.preBg, l.bgFixed].filter(Boolean)));
    const A = cs(a), B = cs(b);
    let n = 512;
    for (const c of A) if (!B.has(c)) n += objBytes(c);
    for (const c of B) if (!A.has(c)) n += objBytes(c);
    return n;
  }
  function sameSnap(a, b) {
    if (a.w !== b.w || a.h !== b.h || a.crop !== b.crop || a.layers.length !== b.layers.length || a.groups.length !== b.groups.length) return false;
    const same = (x, y) => x.every((l, i) => { const m = y[i]; return Object.keys({ ...l, ...m }).every((key) => l[key] === m[key]); });
    return same(a.layers, b.layers) && same(a.groups, b.groups);
  }
  /** Run `fn` (which changes the document) as one undo step. */
  function record(label, fn) {
    commitPending();
    const before = snap();
    if (fn() === false) return false;
    normalize();
    const after = snap();
    if (sameSnap(before, after)) return false;
    push({ label, bytes: diffBytes(before, after), undo: () => restore(before), redo: () => restore(after) });
    changed({ structure: true });
    return true;
  }
  // continuous edits (sliders, dragging, typing): begin once, end when the gesture ends
  function beginEdit() { if (!pendingBefore) pendingBefore = snap(); }
  function endEdit(label) {
    if (!pendingBefore || !doc) return;
    const before = pendingBefore;
    pendingBefore = null;
    const after = snap();
    if (sameSnap(before, after)) return;
    push({ label, bytes: diffBytes(before, after), undo: () => restore(before), redo: () => restore(after) });
  }
  let nudgeT = 0;
  let opT = 0; // wheel over a row's opacity: one undo step once it settles
  let blendT = 0; // Ctrl+wheel / Shift +/− on the blend mode: one undo step once it settles
  function commitPending() {
    if (nudgeT) { clearTimeout(nudgeT); nudgeT = 0; endEdit("Move layer"); }
    if (blendT) { clearTimeout(blendT); blendT = 0; endEdit("Blend mode"); }
    if (opT) { clearTimeout(opT); opT = 0; endEdit("Opacity"); }
  }
  function region(src, r) { const c = blank(r.w, r.h); c.getContext("2d").drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h); return c; }
  function put(dst, r, part) {
    const x = dst.getContext("2d");
    x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = "source-over";
    x.clearRect(r.x, r.y, r.w, r.h); x.drawImage(part, r.x, r.y);
    x.restore();
    bump(dst);
    pyrUpdate(dst, r);
  }
  /** Change pixels of one layer inside rectangle `r` (layer coordinates) as one undo step. */
  function pixelEdit(layer, r, label, fn) {
    const c = layer.canvas;
    const x0 = clamp(Math.floor(r.x), 0, c.width), y0 = clamp(Math.floor(r.y), 0, c.height);
    const x1 = clamp(Math.ceil(r.x + r.w), 0, c.width), y1 = clamp(Math.ceil(r.y + r.h), 0, c.height);
    if (x1 <= x0 || y1 <= y0) return;
    const rr = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    commitPending();
    // after the background remover: the same paint goes into the photo and the cleaned copy (see mapPx)
    const cs = bgPair(layer) ? [layer.preBg, layer.bgFixed] : [c];
    if (cs.length === 1) { delete layer.preBg; delete layer.bgFixed; }
    const before = cs.map((x) => region(x, rr));
    for (const x of cs) { const g = x.getContext("2d"); g.save(); fn(g, rr); g.restore(); bump(x); pyrUpdate(x, rr); }
    const after = cs.map((x) => region(x, rr));
    const all = (parts) => cs.forEach((x, i) => { put(x, rr, parts[i]); bump(x); pyrUpdate(x, rr); });
    push({ label, bytes: cbytes(before[0]) * 2 * cs.length, undo: () => all(before), redo: () => all(after) });
    changed();
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function measure() {
    const r = stage.getBoundingClientRect();
    rect = r;
    k = devicePixelRatio || 1;
    zf = stage.offsetWidth ? r.width / stage.offsetWidth : 1;
    const W = Math.max(1, Math.round(r.width * k)), H = Math.max(1, Math.round(r.height * k));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; dirty = true; }
    if (antsCv.width !== W || antsCv.height !== H) { antsCv.width = W; antsCv.height = H; antPath = null; }
    // the Layers list: at most ~12 rows or 70% of the stage height, then it scrolls (header and footer stay)
    const stageH = stage.offsetHeight;
    card.style.setProperty("--ly-max", `${Math.max(120, Math.min(12 * 38, Math.round(stageH * 0.7)))}px`);
    const cs = getComputedStyle(stage);
    bg = cs.backgroundColor;
    acc = cs.getPropertyValue("--acc").trim() || acc;
  }
  function invalidate(content = false) {
    if (content) dirty = true;
    if (!raf && visible && doc) raf = requestAnimationFrame(frame);
  }
  const viewM = () => [view.z * k, 0, 0, view.z * k, view.ox * k, view.oy * k];
  const docM = () => (crop ? mul(viewM(), workM()) : viewM()); // doc → device px
  const toDoc = (p) => ap(inv(docM()), p.x * k, p.y * k);
  const toWork = (p) => [(p.x - view.ox) / view.z, (p.y - view.oy) / view.z];
  // Big layers seen zoomed out are drawn from a smaller copy (a mip level near screen resolution),
  // so panning and zooming an 80 MP photo costs about what a screen-sized one does.
  const pyr = new WeakMap(); // canvas → {v, levels: [canvas, ½, ¼, …]}
  function levelFor(c, zk) {
    if (c.width * c.height < 4e6 || !(zk < 0.5)) return null;
    const n = Math.min(6, Math.floor(Math.log2(1 / zk)));
    if (n < 1) return null;
    const v = cver.get(c) || 0;
    let pp = pyr.get(c);
    if (!pp || pp.v !== v) { pp = { v, levels: [c] }; pyr.set(c, pp); }
    while (pp.levels.length <= n) {
      const prev = pp.levels[pp.levels.length - 1];
      const lv = blank(Math.ceil(prev.width / 2), Math.ceil(prev.height / 2)), g = lv.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(prev, 0, 0, lv.width, lv.height);
      pp.levels.push(lv);
    }
    const src = pp.levels[n];
    return { src, sx: c.width / src.width, sy: c.height / src.height };
  }
  /** Keep a layer's mip levels in step after pixels changed inside `r` (layer coordinates). */
  function pyrUpdate(c, r) {
    const pp = pyr.get(c);
    if (!pp) return;
    for (let i = 1; i < pp.levels.length; i++) {
      const src = pp.levels[i - 1], dst = pp.levels[i], f = 2 ** (i - 1);
      const a = Math.max(0, (Math.floor(r.x / f) - 4) & ~1), b = Math.min(src.width, Math.ceil((r.x + r.w) / f) + 4);
      const c0 = Math.max(0, (Math.floor(r.y / f) - 4) & ~1), d = Math.min(src.height, Math.ceil((r.y + r.h) / f) + 4);
      if (b <= a || d <= c0) break;
      const g = dst.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.clearRect(a / 2, c0 / 2, Math.ceil((b - a) / 2), Math.ceil((d - c0) / 2));
      g.drawImage(src, a, c0, b - a, d - c0, a / 2, c0 / 2, (b - a) / 2, (d - c0) / 2);
    }
    pp.v = cver.get(c) || 0;
  }
  // a smart layer seen small is drawn from the mip level for its own scale × the zoom
  const drawList = (withStroke = true, exact = false) => doc.layers.map((l) => {
    const m = lm(l), zk = view.z * k * scaleOf(m);
    return {
      ...((!exact && levelFor(l.canvas, zk)) || { src: l.canvas }),
      id: l.id, parent: l.parent ?? null, m, x: l.x, y: l.y, opacity: l.opacity, blend: l.blend, visible: l.visible, clip: l.clip,
      stroke: withStroke && stroke?.scr && stroke.layer === l && !stroke.onMask ? { src: stroke.scr, alpha: stroke.alpha, erase: stroke.erase, screen: true } : null,
      mask: l.mask && l.maskOn ? maskDraw(l, withStroke, exact, zk) : null,
    };
  });
  function maskDraw(l, withStroke = true, exact = false, zk = view.z * k * scaleOf(lm(l))) {
    const m = l.mask;
    return {
      ...((!exact && levelFor(m, zk)) || { src: m }),
      stroke: withStroke && stroke?.scr && stroke.onMask && stroke.layer === l ? { src: stroke.scr, alpha: stroke.alpha, erase: stroke.erase, screen: true } : null,
    };
  }
  /** "Show mask" view: the selected layer's mask in black and white. */
  const maskView = () => { const l = rb.view === "mask" && !crop ? selLayer() : null; return l?.mask ? l : null; };
  let checkerPat = null, checkerKey = "";
  function checker() {
    const th = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const key = th + k;
    if (checkerPat && checkerKey === key) return checkerPat;
    const s = Math.max(4, Math.round(8 * k)), c = new OffscreenCanvas(s * 2, s * 2), x = c.getContext("2d");
    const [a, b] = th === "light" ? ["#FFFFFF", "#ECECEE"] : ["#1D1D1F", "#242426"];
    x.fillStyle = a; x.fillRect(0, 0, s * 2, s * 2);
    x.fillStyle = b; x.fillRect(0, 0, s, s); x.fillRect(s, s, s, s);
    checkerPat = ctx.createPattern(c, "repeat");
    checkerKey = key;
    return checkerPat;
  }
  // Selection outline ("marching ants"): its own small canvas on top of the picture, so the dash
  // offset can move at ~14 fps without re-compositing or redrawing the document. The path is
  // rebuilt only when a frame is drawn (view or selection changed); the timer just re-strokes it.
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let antPath = null, antBox = null, antTimer = 0, antDrawn = false, antBand = null;
  const antsOn = () => !!(selection && !crop && doc && visible && !document.hidden);
  function strokeAnts() {
    const W = antsCv.width, H = antsCv.height;
    actx.setTransform(1, 0, 0, 1, 0, 0);
    actx.clearRect(0, 0, W, H);
    if (!antPath) return;
    const t0 = performance.now();
    actx.save();
    actx.clip(antBox);
    actx.lineWidth = k;
    actx.setLineDash([]);
    actx.strokeStyle = "rgba(255,255,255,0.95)";
    actx.stroke(antPath);
    actx.setLineDash([4 * k, 4 * k]);
    actx.lineDashOffset = reduceMotion.matches ? 0 : -((performance.now() / 1000) * 8 * k) % (8 * k);
    actx.strokeStyle = "#000000";
    actx.stroke(antPath);
    if (antBand) {
      // a combined selection: show only the outline pieces that are on its real edge
      actx.setTransform(1, 0, 0, 1, 0, 0);
      actx.globalCompositeOperation = "destination-in";
      actx.drawImage(antBand.c, 0, 0);
    }
    actx.restore();
    antDrawn = true;
    stats.ants = (stats.ants || 0) + 1;
    stats.antMs = (stats.antMs || 0) + (performance.now() - t0);
  }
  function drawAnts(M) {
    if (!antsOn()) { antPath = null; if (antDrawn) { actx.clearRect(0, 0, antsCv.width, antsCv.height); antDrawn = false; } stopAnts(); return; }
    // the outline never leaves the document
    antPath = new Path2D(); antBox = new Path2D();
    const unit = new Path2D();
    antPath.addPath(selPath(selection), new DOMMatrix(M));
    unit.rect(0, 0, doc.w, doc.h);
    antBox.addPath(unit, new DOMMatrix(M));
    antBand = needsBand(selection) ? bandFor(selection, M) : null;
    strokeAnts();
    if (!antTimer && !reduceMotion.matches) antTimer = setTimeout(antTick, 70);
  }
  const needsBand = (s) => s.kind === "set" || (s.kind === "inv" && needsBand(s.inner));
  /** Screen pixels within ~1 px of the combined selection's edge (dilated minus eroded coverage). Cached per view. */
  function bandFor(s, M) {
    const W = antsCv.width, H = antsCv.height, key = `${W}x${H}|${M.join(",")}`;
    if (antBand && antBand.s === s && antBand.key === key) return antBand;
    const m = selCanvas(W, H, M, s), r = Math.max(1, Math.round(k));
    const offs = [[-r, 0], [r, 0], [0, -r], [0, r], [-r, -r], [r, r], [-r, r], [r, -r]];
    const c = antBand?.c && antBand.c.width === W && antBand.c.height === H ? antBand.c : new OffscreenCanvas(W, H);
    const g = c.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, W, H);
    g.drawImage(m, 0, 0);
    for (const [dx, dy] of offs) g.drawImage(m, dx, dy);
    const e = new OffscreenCanvas(W, H).getContext("2d");
    e.drawImage(m, 0, 0);
    e.globalCompositeOperation = "destination-in";
    for (const [dx, dy] of offs) e.drawImage(m, dx, dy);
    g.globalCompositeOperation = "destination-out";
    g.drawImage(e.canvas, 0, 0);
    g.globalCompositeOperation = "source-over";
    m.width = m.height = 1; e.canvas.width = e.canvas.height = 1;
    return { s, key, c };
  }
  function antTick() {
    antTimer = 0;
    if (!antsOn() || reduceMotion.matches) return;
    strokeAnts();
    antTimer = setTimeout(antTick, 70);
  }
  function stopAnts() { if (antTimer) { clearTimeout(antTimer); antTimer = 0; } }
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopAnts(); else if (antsOn()) invalidate(); });
  reduceMotion.addEventListener?.("change", () => { stopAnts(); if (antsOn()) invalidate(); });
  function frame() {
    raf = 0;
    if (!doc || !visible) return;
    const t0 = performance.now();
    const W = cv.width, H = cv.height, M = docM();
    if (stroke) syncStroke(M);
    if (dirty || !vctx) {
      vb.size(W, H);
      const v = vb("v");
      v.save();
      v.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      v.beginPath(); v.rect(0, 0, doc.w, doc.h); v.clip();
      const mv = maskView();
      if (mv) {
        v.fillStyle = "#000000";
        v.fillRect(0, 0, doc.w, doc.h);
        const md = maskDraw(mv);
        composite(v, [{ src: md.src, sx: md.sx, sy: md.sy, m: lm(mv), x: mv.x, y: mv.y, opacity: 1, blend: "normal", visible: true, clip: false, stroke: md.stroke }], M, vb, { smooth: view.z * k < 1.99 });
      } else composite(v, tree(drawList(), doc.groups), M, vb, { smooth: view.z * k < 1.99 });
      v.restore();
      vctx = v;
      dirty = false;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    // the document: faint glow + checkerboard under it, image, then a 1 px edge so it never blends in
    const light = document.documentElement.dataset.theme === "light";
    const edge = new Path2D(), unit = new Path2D();
    unit.rect(0, 0, doc.w, doc.h);
    edge.addPath(unit, new DOMMatrix(M));
    ctx.save();
    ctx.shadowColor = light ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)";
    ctx.shadowBlur = 24 * k;
    ctx.fillStyle = rb.view === "color" && !crop ? rb.viewColor : checker();
    ctx.fill(edge);
    ctx.restore();
    ctx.drawImage(vctx.canvas, 0, 0);
    ctx.lineWidth = k;
    ctx.strokeStyle = light ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.10)";
    ctx.stroke(edge);
    overlays(M);
    const t1 = performance.now();
    stats.frame.push(t1 - t0);
    if (stats.frame.length > 240) stats.frame.shift();
    if (stroke && lastInput) { stats.latency.push(t1 - lastInput); if (stats.latency.length > 600) stats.latency.shift(); lastInput = 0; }
    if (editing) styleTA();
  }
  function overlays(M) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (crop) { drawAnts(M); cropOverlay(); drawGuides(); return; }
    drawGuides();
    chip.hidden = true;
    drawAnts(M);
    drawBox();
    if (gesture?.draft) drawDraft(gesture.draft, M);
    const mq = gesture?.marquee;
    if (mq) {
      const [a, b] = mq;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "rgba(47,111,235,0.12)";
      ctx.fillRect(Math.min(a.x, b.x) * k, Math.min(a.y, b.y) * k, Math.abs(b.x - a.x) * k, Math.abs(b.y - a.y) * k);
      ctx.lineWidth = k;
      ctx.strokeStyle = acc;
      ctx.strokeRect(Math.min(a.x, b.x) * k + 0.5, Math.min(a.y, b.y) * k + 0.5, Math.abs(b.x - a.x) * k, Math.abs(b.y - a.y) * k);
    }
    if (preview) {
      // live preview while a size/hardness/opacity/text-size control changes
      const now = performance.now(), a = clamp((preview.until - now) / 250, 0, 1);
      if (a <= 0) preview = null;
      else {
        const px = (hover ? hover.x : rect.width / 2) * k, py = (hover ? hover.y : rect.height / 2) * k;
        ctx.save();
        ctx.globalAlpha = a;
        if (preview.kind === "text") {
          const t = textOpts, fs = t.size * view.z * k;
          ctx.font = `${t.weight} ${fs}px Inter, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = t.color;
          ctx.strokeStyle = "rgba(0,0,0,0.35)";
          ctx.lineWidth = Math.max(1, k);
          ctx.strokeText("Aa", px, py);
          ctx.fillText("Aa", px, py);
        } else {
          const o = optsOf(preview.kind), d = Math.max(1, o.size * view.z * k);
          ctx.globalAlpha = a * (o.opacity / 100);
          ctx.drawImage(makeDab(o.size, o.hard / 100, preview.kind === "brush" ? brush.color : "#FFFFFF"), px - d / 2, py - d / 2, d, d);
          ctx.globalAlpha = a;
          ctx.lineWidth = k;
          ctx.beginPath(); ctx.arc(px, py, d / 2 + k, 0, Math.PI * 2); ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.stroke();
          ctx.beginPath(); ctx.arc(px, py, d / 2, 0, Math.PI * 2); ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.stroke();
        }
        ctx.restore();
        invalidate();
        return;
      }
    }
    if (hover && isPaint() && !pinch && !gesture?.pan && !space) {
      const r = Math.max(1, (optsOf(tool).size / 2) * view.z * k);
      ctx.lineWidth = k;
      ctx.beginPath(); ctx.arc(hover.x * k, hover.y * k, r + k, 0, Math.PI * 2); ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.stroke();
      ctx.beginPath(); ctx.arc(hover.x * k, hover.y * k, r, 0, Math.PI * 2); ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.stroke();
    }
  }

  // ── view: fit, zoom, pan ──────────────────────────────────────────────────
  function insets() {
    const s = rect, u = zf, R0 = (el) => el.getBoundingClientRect();
    const bar = activeBar(), propsShown = !bar.hidden && bar.offsetParent && !bar.classList.contains("moved");
    if (isPhone()) {
      const z = R0(q(".ph-zoom"));
      const bottomEdge = propsShown ? R0(bar).top : R0(toolsEl).top;
      return { l: 12 * u, r: 12 * u, t: z.bottom - s.top + 4 * u, b: s.bottom - bottomEdge + 4 * u };
    }
    const tl = R0(toolsEl);
    const compact = matchMedia("(max-width: 1199px)").matches;
    const cr = !compact && !card.classList.contains("moved") ? R0(card) : null;
    return {
      l: toolsEl.classList.contains("moved") ? 12 * u : tl.right - s.left + 16 * u,
      r: cr && cr.width ? s.right - cr.left + 20 * u : 12 * u,
      t: (propsShown ? R0(bar).bottom - s.top : 12 * u) + 8 * u,
      b: 48 * u,
    };
  }
  function fit(cap = false) {
    if (!doc) return;
    measure();
    const box = crop ? workSize() : { w: doc.w, h: doc.h };
    const n = insets();
    const aw = Math.max(16, rect.width - n.l - n.r), ah = Math.max(16, rect.height - n.t - n.b);
    let z = Math.min(aw / box.w, ah / box.h);
    if (cap) z = Math.min(z, 1);
    view.z = z;
    view.ox = n.l + (aw - box.w * z) / 2;
    view.oy = n.t + (ah - box.h * z) / 2;
    view.fitted = true;
    view.cap = cap;
    syncZoom();
    invalidate(true);
  }
  function zoomAt(f, px, py) {
    const z = clamp(view.z * f, 0.002, 64), r = z / view.z;
    view.ox = px - (px - view.ox) * r;
    view.oy = py - (py - view.oy) * r;
    view.z = z;
    view.fitted = false;
    syncZoom();
    invalidate(true);
  }
  let zanim = null;
  function smoothZoom(f, px, py) {
    const to = clamp((zanim ? zanim.to : view.z) * f, 0.002, 64);
    if (!zanim) { zanim = { to, px, py, last: performance.now(), timer: 0 }; requestAnimationFrame(stepZoom); }
    else Object.assign(zanim, { to, px, py });
    clearTimeout(zanim.timer);
    // if frames aren't running (hidden page), land on the target anyway
    zanim.timer = setTimeout(() => { if (zanim) { const z = zanim; zanim = null; zoomAt(z.to / view.z, z.px, z.py); } }, 160);
  }
  function stepZoom(now) {
    const a = zanim;
    if (!a) return;
    const dt = Math.max(1, now - a.last);
    a.last = now;
    const r = a.to / view.z, done = Math.abs(Math.log(r)) < 0.002;
    zoomAt(done ? r : Math.exp(Math.log(r) * Math.min(1, dt / 45)), a.px, a.py);
    if (done) { clearTimeout(a.timer); zanim = null; return; }
    requestAnimationFrame(stepZoom);
  }
  function pan(dx, dy) { view.ox += dx; view.oy += dy; view.fitted = false; invalidate(true); saveSession(); }
  function syncZoom() {
    const p = view.z * 100;
    zoomV.textContent = `${p >= 10 ? Math.round(p) : p.toFixed(1)}%`;
    saveSession();
  }

  // ── pointer input on the canvas ───────────────────────────────────────────
  const local = (e) => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  let lastTap = null;
  cv.addEventListener("pointerdown", (e) => {
    if (!doc) return;
    if (document.activeElement && document.activeElement !== document.body && document.activeElement !== ta) document.activeElement.blur?.();
    rect = stage.getBoundingClientRect();
    const p = local(e);
    pointers.set(e.pointerId, p);
    try { cv.setPointerCapture(e.pointerId); } catch {}
    if (pointers.size === 2) {
      if (gesture) { const g = gesture; gesture = null; g.cancel?.(); }
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, z: view.z, ox: view.ox, oy: view.oy };
      return;
    }
    if (pointers.size > 2 || pinch) return;
    if (e.button === 1 || (e.button === 0 && space)) {
      e.preventDefault();
      let last = p;
      stage.classList.add("c-grabbing");
      gesture = { pan: true, move(q2) { pan(q2.x - last.x, q2.y - last.y); last = q2; }, end() { stage.classList.remove("c-grabbing"); }, cancel() { stage.classList.remove("c-grabbing"); } };
      return;
    }
    if (e.button === 2 && e.altKey && isPaint() && !crop) {
      e.preventDefault();
      const o = optsOf(tool), s0 = o.size, h0 = o.hard;
      let axis = null; // locked by the first ~6 px: "x" = size only, "y" = hardness only
      hover = p;
      gesture = {
        move(q2) {
          const dx = q2.x - p.x, dy = q2.y - p.y;
          if (!axis) { if (Math.hypot(dx, dy) < 6) return; axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y"; }
          if (axis === "x") o.size = clamp(Math.round(s0 + (2 * dx) / view.z), 1, 1000);
          else o.hard = clamp(Math.round(h0 - dy * 0.5), 0, 100);
          hover = p; showPreview(tool);
        },
        end() { renderProps(); savePrefs(); },
      };
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    if (zoomKey) {
      let moved = false;
      gesture = {
        pan: true,
        move(q2) { if (!moved && Math.abs(q2.x - p.x) < 3) return; moved = true; const z0 = this.z0 ??= view.z; zoomAt((z0 * Math.exp((q2.x - p.x) * 0.01)) / view.z, p.x, p.y); },
        end(q2, ev) { if (!moved) smoothZoom(ev?.altKey ? 0.8 : 1.25, p.x, p.y); },
      };
      return;
    }
    // double-click / double-tap toggles fit ↔ 100% (with tools where a click doesn't paint or type)
    const tapOk = !crop && (tool === "move" || tool === "select" || tool === "eyedrop");
    if (tapOk && lastTap && e.timeStamp - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 24 * zf) {
      lastTap = null;
      const top = tool === "move" ? layersAt(...toDoc(p))[0] : null;
      if (top?.kind === "text") { selectLayers([top]); setTool("text"); startText(top, false); return; }
      if (view.fitted) zoomAt(1 / view.z, p.x, p.y); else fit();
      return;
    }
    lastTap = tapOk ? { t: e.timeStamp, x: p.x, y: p.y } : null;
    lastInput = e.timeStamp;
    gesture = startTool(p, e);
    invalidate();
  });
  cv.addEventListener("pointermove", (e) => {
    if (!doc) return;
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch) {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const z = clamp((pinch.z * d) / pinch.d, 0.002, 64);
      view.z = z;
      view.ox = mx - ((pinch.mx - pinch.ox) * z) / pinch.z;
      view.oy = my - ((pinch.my - pinch.oy) * z) / pinch.z;
      view.fitted = false;
      syncZoom();
      invalidate(true);
      return;
    }
    hover = e.pointerType === "touch" ? null : p;
    if (lastTap && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) > 6 * zf) lastTap = null; // a drag isn't a tap
    if (gesture) { lastInput = e.timeStamp; gesture.move?.(p, e); }
    else hoverCursor(p);
    if (isPaint()) invalidate();
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pinch) { if (!pointers.size) pinch = null; return; }
    if (gesture) {
      const g = gesture;
      gesture = null;
      if (e.type === "pointercancel") g.cancel?.(); else g.end?.(local(e), e);
      invalidate();
    }
  };
  cv.addEventListener("pointerup", up);
  cv.addEventListener("pointercancel", up);
  cv.addEventListener("pointerleave", () => { if (!gesture) { hover = null; invalidate(); } });
  cv.addEventListener("contextmenu", (e) => { e.preventDefault(); if (doc && !crop && !e.altKey && !gesture) layerMenu(e); });
  stage.addEventListener("wheel", (e) => {
    if (!doc || e.target !== cv) return;
    e.preventDefault();
    const p = local(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
    const dy = e.deltaY * unit;
    if (e.shiftKey && !e.ctrlKey) { pan(-(e.deltaX * unit || dy), 0); return; }
    // trackpad pinch arrives as Ctrl+wheel with fractional deltas: follow the fingers exactly;
    // a mouse notch (≈100 px) zooms ×1.1, eased over ~80 ms
    const pinchy = e.ctrlKey && !Number.isInteger(e.deltaY);
    if (pinchy) zoomAt(clamp(Math.exp(-dy * 0.01), 0.5, 2), p.x, p.y);
    else smoothZoom(clamp(Math.exp(-dy * 0.00095), 0.6, 1.6), p.x, p.y);
  }, { passive: false });

  let modOp = null; // Shift / Alt / both held with the Select tool: add / subtract / intersect
  function selCursor(op) {
    const b = { add: "M17 13v7M13.5 16.5h7", sub: "M13.5 16.5h7", int: "M14 13.5l6 6M20 13.5l-6 6" }[op];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" stroke-linecap="round"><g stroke="#000" stroke-width="3"><path d="M8 1.5v13M1.5 8h13"/><path d="${b}"/></g><g stroke="#fff" stroke-width="1.2"><path d="M8 1.5v13M1.5 8h13"/><path d="${b}"/></g></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 8 8, crosshair`;
  }
  function setCursor(c) {
    stage.classList.remove("c-move", "c-cross", "c-text", "c-grab");
    stage.style.cursor = "";
    if (space) { stage.classList.add("c-grab"); return; }
    if (c) { stage.style.cursor = c; return; }
    if (tool === "select" && !crop) { const op = modOp || (noMods() ? selMode : "new"); if (op !== "new") { stage.style.cursor = selCursor(op); return; } }
    const m = { move: "c-move", select: "c-cross", brush: "c-cross", eraser: "c-cross", mask: "c-cross", eyedrop: "c-cross", text: "c-text" }[tool];
    if (m) stage.classList.add(m);
  }
  function hoverCursor(p) {
    if (!crop) {
      const hm = { tl: "nwse-resize", br: "nwse-resize", tr: "nesw-resize", bl: "nesw-resize", l: "ew-resize", r: "ew-resize", t: "ns-resize", b: "ns-resize" };
      const hb = tool === "move" && !space ? hitBox(p) : null;
      if (hb) setCursor(hm[hb]); else if (stage.style.cursor) setCursor();
      return;
    }
    const hnd = hitHandle(p);
    const map = { tl: "nwse-resize", br: "nwse-resize", tr: "nesw-resize", bl: "nesw-resize", l: "ew-resize", r: "ew-resize", t: "ns-resize", b: "ns-resize", in: "move" };
    setCursor(map[hnd] || "crosshair");
  }

  function startTool(p, e) {
    if (!crop && mod(e)) return moveGesture(p, e, true); // Ctrl/Cmd+drag: move the layer under the cursor from any tool
    switch (crop ? "crop" : tool) {
      case "move": return moveGesture(p, e);
      case "select": return selectGesture(p, e);
      case "crop": return cropGesture(p);
      case "brush": if (e.altKey) { pick(p, true); return null; } return strokeGesture(p, e);
      case "eraser": return strokeGesture(p, e);
      case "mask": return strokeGesture(p, e);
      case "text": textGesture(p, e); return null;
      case "eyedrop": pick(p, false); return { move: (q2) => pick(q2, false), end: (q2) => pick(q2, true) };
    }
    return null;
  }

  // ── move ──────────────────────────────────────────────────────────────────
  // ── move tool: auto-select, multi-select, marquee, transform box ─────────
  // Click a visible pixel to pick (and drag) the topmost layer there; Shift+click adds/removes a
  // layer; dragging on empty canvas selects every layer the box touches. Ctrl+drag does this from
  // any tool. The selected layer shows a box with handles to scale it (Shift keeps the aspect).
  let autoSel = true, autoGroup = false, quickDrag = false;
  const multi = new Set();
  /** The selected layers and groups (the active one first). */
  const selNodes = () => { const a = selNode(), out = a ? [a] : []; for (const id of multi) { const n = nodeOf(id); if (n && n !== a) out.push(n); } return out; };
  /** The pixel layers the selection stands for (a selected group: its layers), bottom first. */
  const selected = () => { const set = new Set(selNodes().flatMap(layersOf)); return doc.layers.filter((l) => set.has(l)); };
  function alphaAt(l, x, y, exact = false) {
    const [u, v] = plain(l) ? [x - l.x, y - l.y] : ap(inv(lm(l)), x, y), lx = Math.floor(u), ly = Math.floor(v);
    if (lx < 0 || ly < 0 || lx >= l.canvas.width || ly >= l.canvas.height) return 0;
    if (l.kind === "text" && !exact) return 255; // text: the whole box counts, so gaps between letters still pick it
    const c = new OffscreenCanvas(1, 1).getContext("2d");
    c.drawImage(l.canvas, -lx, -ly);
    if (l.mask && l.maskOn) { c.globalCompositeOperation = "destination-in"; c.drawImage(l.mask, -lx, -ly); }
    return c.getImageData(0, 0, 1, 1).data[3];
  }
  const shownIn = (n) => { for (let i = 0; n && i < 64; n = grp(n.parent), i++) if (!n.visible || n.opacity <= 0) return false; return true; };
  /** Whether node `n` (a layer, or any layer of a group) has a visible pixel at (x, y). */
  const hasPixel = (n, x, y) => layersOf(n).some((l) => l.visible && alphaAt(l, x, y, true) > 10);
  /** Layers with a visible pixel at doc point (x, y), topmost first (hidden layers and groups, and clipping, respected). */
  function layersAt(x, y) {
    const out = [];
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (!shownIn(l) || alphaAt(l, x, y) <= 10) continue;
      // clipped (it, or a group it's in): its base must have pixels here
      let ok = true;
      for (let n = l, j = 0; n && ok && j < 64; n = grp(n.parent), j++) if (n.clip && canClip(n)) ok = hasPixel(baseOf(n), x, y);
      if (ok) out.push(l);
    }
    return out;
  }
  let explicitPick = null; // a layer picked in the Layers card or with Alt-click (wins over auto-select)
  function selectLayers(list, add = false) {
    explicitPick = null;
    if (!add) multi.clear();
    if (!list.length) return;
    const cur = selNode();
    if (!add || !cur) { doc.sel = list[0].id; for (const l of list.slice(1)) multi.add(l.id); }
    else for (const l of list) if (l !== cur) multi.add(l.id);
    multi.delete(doc.sel);
    renderLayers();
    renderProps();
  }
  function toggleInSelection(l) {
    if (l.id === doc.sel) {
      if (!multi.size) return;
      const next = [...multi][0];
      multi.delete(next);
      doc.sel = next;
    } else if (multi.has(l.id)) multi.delete(l.id);
    else multi.add(l.id);
    renderLayers();
    renderProps();
  }
  function unionBox(list) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const l of list) { const b = aabb(l); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const HANDLES = ["tl", "t", "tr", "r", "br", "b", "bl", "l"];
  const ROT_CURSOR = (() => {
    const d = "M6.5 13.5a6.5 6.5 0 1 1 2.6 5.2M3.5 10.8l3 3.2 3.4-2.9";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${d}" stroke="#000" stroke-width="3.6"/><path d="${d}" stroke="#fff" stroke-width="1.4"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
  })();
  /** Screen points (CSS px) of a box's corners and edge middles: a layer through its transform, or a document-space box. */
  function handlePts(o) {
    const A = o.canvas ? lm(o) : [1, 0, 0, 1, o.x, o.y], w = o.canvas ? o.canvas.width : o.w, hh = o.canvas ? o.canvas.height : o.h;
    const loc = { tl: [0, 0], t: [w / 2, 0], tr: [w, 0], r: [w, hh / 2], br: [w, hh], b: [w / 2, hh], bl: [0, hh], l: [0, hh / 2] }, out = {};
    for (const n in loc) { const [x, y] = ap(A, loc[n][0], loc[n][1]); out[n] = [view.ox + x * view.z, view.oy + y * view.z]; }
    return out;
  }
  /** A handle of the selected layer's box under `p`: a scale handle, or "rot" just outside a corner (not text). */
  function hitBox(p) {
    const l = selLayer();
    if (!l || multi.size || tool !== "move" || crop) return null;
    const pts = handlePts(l), tol = (isPhone() ? 16 : 7) * zf;
    // the nearest handle (on a small layer they overlap; corners win ties)
    let best = null, bd = Infinity;
    for (const n of HANDLES) { const dx = Math.abs(p.x - pts[n][0]), dy = Math.abs(p.y - pts[n][1]), d = Math.hypot(dx, dy) + (n.length === 1 ? 0.01 : 0); if (dx <= tol && dy <= tol && d < bd) { best = n; bd = d; } }
    if (best) return best;
    if (l.kind !== "text" && !onLayer(l, ...toDoc(p))) for (const n of ["tl", "tr", "br", "bl"]) if (Math.hypot(p.x - pts[n][0], p.y - pts[n][1]) <= tol * 3.5) return "rot";
    return null;
  }
  function drawBox() {
    if (crop || !doc || editing || (tool !== "move" && !gesture?.moving)) return;
    const list = selected();
    if (!list.length) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = k;
    ctx.strokeStyle = acc;
    const one = list.length === 1 && tool === "move" && selLayer(); // handles scale/rotate one layer (not a group)
    const pts = handlePts(one || unionBox(list));
    ctx.beginPath();
    ["tl", "tr", "br", "bl"].forEach((n, i) => { const x = Math.round(pts[n][0] * k) + 0.5, y = Math.round(pts[n][1] * k) + 0.5; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.stroke();
    if (!one) return;
    const s = 8 * zf * k;
    for (const n of HANDLES) {
      const [x, y] = pts[n];
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(x * k - s / 2, y * k - s / 2, s, s);
      ctx.strokeRect(x * k - s / 2 + 0.5, y * k - s / 2 + 0.5, s - 1, s - 1);
    }
  }
  /** The base of `n`'s clipping group (itself when it isn't clipped): the nearest unclipped node below it in its group. */
  function baseOf(n) {
    const s = sibs(n);
    let i = s.indexOf(n);
    while (i > 0 && s[i].clip) i--;
    return s[Math.max(0, i)] || n;
  }
  /** A base node and every node clipped to it, bottom first. */
  function groupOf(base) {
    const s = sibs(base), i = s.indexOf(base), out = [base];
    for (let j = i + 1; j < s.length && s[j].clip; j++) out.push(s[j]);
    return out;
  }
  /** What a move drags: the selected nodes, a base with what's clipped to it, as pixel layers. */
  const moversOf = (list, carry = true) => [...new Set((carry ? list.flatMap((n) => (n.clip ? [n] : groupOf(n))) : list).flatMap(layersOf))];
  function moveGesture(p, e, quick = false) {
    commitPending();
    if (!quick) { const hnd = hitBox(p); if (hnd) return hnd === "rot" ? rotateGesture(p) : scaleGesture(hnd); }
    const [x0, y0] = toDoc(p);
    const auto = autoSel || quick;
    const deep = e.altKey && !e.shiftKey; // Alt+click: the topmost actual layer, clipped ones included
    const hits = auto || e.shiftKey || deep ? layersAt(x0, y0) : [];
    let hit = hits[0] || null;
    // a clipped layer picked on purpose (in the Layers card, or with Alt-click) keeps the drag while
    // the pointer is over its pixels
    const cur = selNode();
    const keep = !deep && !e.shiftKey && cur?.clip && cur.id === explicitPick && !multi.size && hits.some((x) => covers(cur, x));
    // on the canvas a hit picks its outermost group ("Auto-select: Group"), or inside a clipping
    // group the group's base (the clipping group moves as one)
    if (hit && !deep && !keep) { if (autoGroup) hit = outer(hit); if (hit.clip) hit = baseOf(hit); }
    if (keep) { /* explicit selection wins */ }
    else if (hit && e.shiftKey) toggleInSelection(hit);
    else if (hit && deep) { selectLayers([hit]); explicitPick = hit.id; }
    // a click on something already selected keeps the selection (to drag it all); inside a selected
    // group only when the group was picked in the Layers card or with others
    else if (hit) { if (!selNodes().some((n) => n === hit || (covers(n, hit) && (n.id === explicitPick || multi.size > 0)))) selectLayers([hit]); }
    else if (auto || e.shiftKey) return marqueeGesture(p, e.shiftKey);
    // moving a base carries the nodes clipped to it (unless one of them was picked on its own)
    const movers = moversOf(selNodes(), !deep && !keep);
    if (!movers.length) return null;
    quickDrag = quick;
    beginEdit();
    const start = movers.map((l) => [l, l.x, l.y]), box0 = unionBox(movers);
    const targets = snapTargets(movers);
    let moved = false;
    return {
      moving: true,
      move(q2, ev) {
        if (!moved && Math.hypot(q2.x - p.x, q2.y - p.y) < 3) return;
        moved = true;
        const [x, y] = toDoc(q2);
        let dx = x - x0, dy = y - y0;
        const [sx, sy] = snapBox(box0.x + dx, box0.y + dy, box0.w, box0.h, ev, targets);
        dx = Math.round(dx + sx); dy = Math.round(dy + sy);
        for (const [l, ox, oy] of start) { l.x = ox + dx; l.y = oy + dy; }
        invalidate(true);
      },
      end() { guides = null; quickDrag = false; endEdit(movers.length > 1 ? "Move layers" : "Move layer"); changed(); },
      cancel() { guides = null; quickDrag = false; for (const [l, ox, oy] of start) { l.x = ox; l.y = oy; } pendingBefore = null; invalidate(true); },
    };
  }
  function marqueeGesture(p, add) {
    let q0 = p;
    return {
      marquee: null,
      move(q2) { q0 = q2; this.marquee = [p, q2]; invalidate(); },
      end() {
        const g = this;
        g.marquee = null;
        if (Math.hypot(q0.x - p.x, q0.y - p.y) < 3) { if (!add) { multi.clear(); renderLayers(); } invalidate(); return; }
        const [ax, ay] = toDoc(p), [bx, by] = toDoc(q0);
        const r = { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
        const hits = doc.layers.filter((l) => { if (!shownIn(l)) return false; const b = aabb(l); return b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y; }).reverse();
        selectLayers(autoGroup ? [...new Set(hits.map(outer))] : hits, add);
        invalidate();
      },
      cancel() { this.marquee = null; invalidate(); },
    };
  }
  /**
   * Drag a handle: the layer's box is resized in its own (rotated) frame, the opposite side staying
   * put; Shift keeps the aspect (text always does: its font size changes on release). Only the
   * matrix changes, so any size can be taken back exactly. Within a few screen pixels of the
   * source's own size it snaps to exactly 1:1 (Alt: no snapping).
   */
  function scaleGesture(hnd) {
    const l = selLayer(), A0 = lm(l), Ai = inv(A0), w = l.canvas.width, hh = l.canvas.height, targets = snapTargets([l]);
    const n1 = Math.hypot(A0[0], A0[1]), n2 = Math.hypot(A0[2], A0[3]), axis = !A0[1] && !A0[2];
    const text = l.kind === "text", t0 = l.text;
    beginEdit();
    return {
      moving: true,
      move(q2, ev) {
        let [x, y] = toDoc(q2);
        if (axis) [x, y] = snapPoint(x, y, ev, targets, /[lr]/.test(hnd), /[tb]/.test(hnd));
        const [u, v] = ap(Ai, x, y);
        let L = 0, Tt = 0, Rr = w, B = hh;
        if (hnd.includes("l")) L = Math.min(u, Rr - 1 / n1);
        if (hnd.includes("r")) Rr = Math.max(u, L + 1 / n1);
        if (hnd.includes("t")) Tt = Math.min(v, B - 1 / n2);
        if (hnd.includes("b")) B = Math.max(v, Tt + 1 / n2);
        let su = (Rr - L) / w, sv = (B - Tt) / hh;
        // near the source's own size: exactly 1:1
        const tol = Math.max(0.75, (3 * zf) / view.z);
        const one = (f, nrm, len) => (!bypass(ev) && Math.abs(f * nrm * len - len) < tol ? 1 / nrm : f);
        if (ev.shiftKey || text) {
          let f = hnd.length === 2 ? Math.max(su, sv) : hnd === "l" || hnd === "r" ? su : sv;
          if (Math.abs(n1 - n2) < 1e-9) f = one(f, n1, Math.max(w, hh));
          su = sv = f;
          if (hnd === "l" || hnd === "r") { Tt = hh / 2 - (hh * sv) / 2; B = Tt + hh * sv; }
          if (hnd === "t" || hnd === "b") { L = w / 2 - (w * su) / 2; Rr = L + w * su; }
        } else { su = one(su, n1, w); sv = one(sv, n2, hh); }
        if (hnd.includes("l")) L = Rr - w * su; else if (hnd.includes("r")) Rr = L + w * su;
        if (hnd.includes("t")) Tt = B - hh * sv; else if (hnd.includes("b")) B = Tt + hh * sv;
        setLm(l, mul(A0, mul(T(L, Tt), S(su, sv))));
        if (plain(l)) { l.x = Math.round(l.x); l.y = Math.round(l.y); } // 1:1 again: on whole pixels, sharp
        invalidate(true);
      },
      end() {
        guides = null;
        if (text) {
          // text: the new size goes into the font (drawn sharp), the box keeps its corner
          const f = Math.hypot(l.tc ?? 0, l.td ?? 1) / n2;
          setLm(l, [A0[0], A0[1], A0[2], A0[3], l.x, l.y]);
          if (Math.abs(f - 1) > 1e-6) { l.text = { ...t0, size: Math.max(2, t0.size * f) }; renderText(l); }
        }
        endEdit("Scale layer");
        changed({ structure: true });
      },
      cancel() { guides = null; setLm(l, A0); pendingBefore = null; invalidate(true); },
    };
  }
  /** Drag just outside a corner: rotate the layer around its centre (Shift: 15° steps). */
  function rotateGesture(p) {
    const l = selLayer(), A0 = lm(l), w = l.canvas.width, hh = l.canvas.height, [cx, cy] = ap(A0, w / 2, hh / 2);
    const [x0, y0] = toDoc(p), a0 = Math.atan2(y0 - cy, x0 - cx), cur = Math.atan2(A0[1], A0[0]);
    beginEdit();
    return {
      moving: true,
      move(q2, ev) {
        const [x, y] = toDoc(q2);
        let d = Math.atan2(y - cy, x - cx) - a0;
        if (ev.shiftKey) { const st = Math.PI / 12; d = Math.round((cur + d) / st) * st - cur; }
        const L = mul(R((d * 180) / Math.PI), [A0[0], A0[1], A0[2], A0[3], 0, 0]);
        setLm(l, [L[0], L[1], L[2], L[3], cx - (L[0] * w + L[2] * hh) / 2, cy - (L[1] * w + L[3] * hh) / 2]);
        invalidate(true);
      },
      end() { endEdit("Rotate layer"); changed({ structure: true }); },
      cancel() { setLm(l, A0); pendingBefore = null; invalidate(true); },
    };
  }
  function nudge(dx, dy) {
    const list = moversOf(selNodes());
    if (!list.length) return;
    beginEdit();
    for (const l of list) { l.x += dx; l.y += dy; }
    invalidate(true);
    clearTimeout(nudgeT);
    nudgeT = setTimeout(() => { nudgeT = 0; endEdit("Move layer"); changed(); }, 500);
  }
  function layerMenu(e) {
    const [x, y] = toDoc(local(e)), list = layersAt(x, y);
    if (!list.length) return;
    const el = h(`<div class="ph-menu" role="menu" aria-label="Layers here"></div>`);
    let lay = null;
    for (const l of list) {
      const b = h(`<button type="button" role="menuitemradio" aria-checked="${l.id === doc.sel}"><span class="ck">${l.id === doc.sel ? icon("check", 14, { stroke: 2 }) : ""}</span></button>`);
      b.append(l.name);
      b.onclick = () => { lay.close(); selectLayers([l]); invalidate(); };
      el.append(b);
    }
    lay = openLayer(el, { width: 200, reopen: false });
    if (!isPhone()) {
      const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      el.style.left = `${Math.min(e.clientX / zoom, innerWidth / zoom - 212)}px`;
      el.style.top = `${e.clientY / zoom}px`;
    }
  }

  // ── selection ─────────────────────────────────────────────────────────────
  // A selection is a shape {kind: rect|ellipse|lasso}, an inverted selection {kind: "inv", inner}
  // or a combination {kind: "set", parts: [{op: add|sub|int, s}]} built with Shift (add), Alt
  // (subtract), Shift+Alt (intersect) or the mode switch in the Select bar. Operations rasterise it
  // (canvas compositing on the GPU) only over the area they touch.
  const isShape = (s) => s.kind === "rect" || s.kind === "ellipse" || s.kind === "lasso";
  function shapePath(s) {
    const p = new Path2D();
    if (s.kind === "rect") p.rect(s.x, s.y, s.w, s.h);
    else if (s.kind === "ellipse") p.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2);
    else { s.pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath(); }
    return p;
  }
  /** Every outline of the selection (for the marching ants). */
  function selPath(s) {
    if (isShape(s)) return shapePath(s);
    const p = new Path2D();
    if (s.kind === "inv") { p.rect(0, 0, doc.w, doc.h); p.addPath(selPath(s.inner)); return p; }
    for (const part of s.parts) p.addPath(selPath(part.s));
    return p;
  }
  /**
   * Draw the selection's coverage into `g` (cleared, transform = doc → its pixels) with the
   * composite operation `gco` (source-over to draw it, destination-out to cut it, destination-in
   * to intersect with it).
   */
  function selDraw(g, s, gco = "source-over") {
    const A = g.getTransform();
    if (isShape(s)) { g.globalCompositeOperation = gco; g.fillStyle = "#FFFFFF"; g.fill(shapePath(s)); g.globalCompositeOperation = "source-over"; return; }
    // a compound shape: build it in its own buffer, then apply that with `gco`
    const t = new OffscreenCanvas(g.canvas.width, g.canvas.height).getContext("2d");
    t.setTransform(A);
    if (s.kind === "inv") {
      t.fillStyle = "#FFFFFF";
      t.fillRect(0, 0, doc.w, doc.h);
      selDraw(t, s.inner, "destination-out");
    } else {
      s.parts.forEach((part, i) => selDraw(t, part.s, i === 0 ? "source-over" : { add: "source-over", sub: "destination-out", int: "destination-in" }[part.op]));
    }
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = gco;
    g.drawImage(t.canvas, 0, 0);
    g.restore();
    t.canvas.width = t.canvas.height = 1;
  }
  /** A W×H canvas whose alpha is the selection, through `M` (doc → canvas pixels). */
  function selCanvas(W, H, M = I, s = selection) {
    const c = new OffscreenCanvas(Math.max(1, Math.ceil(W)), Math.max(1, Math.ceil(H))), g = c.getContext("2d");
    g.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    selDraw(g, s);
    return c;
  }
  /** Keep (destination-in) or erase (destination-out) the selection in everything drawn on `g` so far. */
  function applySel(g, M, erase = false) {
    const c = selCanvas(g.canvas.width, g.canvas.height, M);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = erase ? "destination-out" : "destination-in";
    g.drawImage(c, 0, 0);
    g.restore();
    c.width = c.height = 1;
  }
  const boundsCache = new WeakMap();
  function selBounds(s) {
    if (s.kind === "inv") return { x: 0, y: 0, w: doc.w, h: doc.h };
    if (s.kind === "rect" || s.kind === "ellipse") return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
    if (s.kind === "lasso") {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of s.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    // a combination: rasterise at ≤ 2048 px and find the covered box (± one cell, so nothing is lost)
    if (boundsCache.has(s)) return boundsCache.get(s);
    const sc = Math.min(1, 2048 / Math.max(doc.w, doc.h)), W = Math.ceil(doc.w * sc), H = Math.ceil(doc.h * sc);
    const c = selCanvas(W, H, S(sc), s), d = c.getContext("2d").getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const b = x1 < 0 ? { x: 0, y: 0, w: 0, h: 0 } : (() => {
      const bx0 = Math.max(0, (x0 - 1) / sc), by0 = Math.max(0, (y0 - 1) / sc), bx1 = Math.min(doc.w, (x1 + 2) / sc), by1 = Math.min(doc.h, (y1 + 2) / sc);
      return sc === 1 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 };
    })();
    boundsCache.set(s, b);
    return b;
  }
  /** `before` combined with a new shape by `op` (new | add | sub | int). */
  function combine(before, op, shape) {
    if (op === "new") return shape;
    if (!before) return op === "add" ? shape : null; // nothing to subtract from or intersect with
    const parts = before.kind === "set" ? [...before.parts] : [{ op: "add", s: before }];
    return { kind: "set", parts: [...parts, { op, s: shape }] };
  }
  const SEL_OPS = [["new", "New selection"], ["add", "Add (Shift)"], ["sub", "Subtract (Alt)"], ["int", "Intersect (Shift Alt)"]];
  /** Touch-only devices have no Shift/Alt: there the Select bar keeps a mode switch (on desktop a remembered mode would be invisible). */
  const noMods = () => matchMedia("(hover: none) and (pointer: coarse)").matches;
  const opOf = (e) => (e.shiftKey && e.altKey ? "int" : e.shiftKey ? "add" : e.altKey ? "sub" : noMods() ? selMode : "new");
  function selectGesture(p, e) {
    const targets = snapTargets(null);
    const kind = selShape, before = selection, op = before ? opOf(e) : "new";
    const shiftStart = e.shiftKey;
    let shiftUp = false; // Shift pressed again after it chose "add" = keep the shape square
    const [x0, y0] = kind === "lasso" ? toDoc(p) : snapPoint(...toDoc(p), e, targets);
    let moved = false, shape = null;
    return {
      move(q2, ev) {
        if (!moved && Math.hypot(q2.x - p.x, q2.y - p.y) < 3) return;
        if (shiftStart && !ev.shiftKey) shiftUp = true;
        const [x, y] = kind === "lasso" ? toDoc(q2) : snapPoint(...toDoc(q2), ev, targets);
        if (kind === "lasso") {
          const inDoc = ([px, py]) => [clamp(px, 0, doc.w), clamp(py, 0, doc.h)];
          if (!moved) shape = { kind, pts: [inDoc([x0, y0])] };
          const evs = ev.getCoalescedEvents?.();
          for (const ce of evs?.length ? evs : [ev]) shape.pts.push(inDoc(toDoc(local(ce))));
          shape = { kind, pts: shape.pts }; // a new object each time: the ants rebuild
        } else {
          let w = x - x0, hh = y - y0;
          if (ev.shiftKey && (!shiftStart || shiftUp)) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; }
          // the box is clipped to the canvas (a big drag over everything = the whole canvas)
          const ax = clamp(Math.min(x0, x0 + w), 0, doc.w), bx = clamp(Math.max(x0, x0 + w), 0, doc.w);
          const ay = clamp(Math.min(y0, y0 + hh), 0, doc.h), by = clamp(Math.max(y0, y0 + hh), 0, doc.h);
          shape = kind === "rect" ? { kind, x: ax, y: ay, w: bx - ax, h: by - ay } : { kind, x: x0, y: y0, w, h: hh };
        }
        moved = true;
        // the previous selection keeps its ants; the shape being drawn gets its own live outline
        // (a combined outline would hide a shape drawn inside the selection)
        this.draft = shape;
        invalidate();
      },
      end() {
        guides = null;
        this.draft = null;
        let s = moved ? shape : null;
        if (s && s.kind !== "lasso") { const b = selBounds(s); s = { kind, ...b }; }
        if (s) {
          const b = selBounds(s);
          const off = b.x >= doc.w || b.y >= doc.h || b.x + b.w <= 0 || b.y + b.h <= 0;
          if (off || b.w < 1 || b.h < 1 || (s.kind === "lasso" && s.pts.length < 3)) s = null;
        }
        let after;
        if (!s) after = op === "new" ? null : before; // a click: New deselects, the other modes keep it
        else {
          after = combine(before, op, s);
          if (after && !isShape(after)) { const b = selBounds(after); if (b.w < 1 || b.h < 1) after = null; }
        }
        selection = before;
        if (after === before) { invalidate(); return; }
        setSelection(after, !after ? "Deselect" : op === "add" ? "Add to selection" : op === "sub" ? "Subtract from selection" : op === "int" ? "Intersect selection" : "Select");
      },
      cancel() { this.draft = null; selection = before; invalidate(); },
    };
  }
  /** The outline of a selection shape being drawn (dashed, on top of everything). */
  function drawDraft(s, M) {
    const p = new Path2D();
    p.addPath(shapePath(s), new DOMMatrix(M));
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = k;
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.stroke(p);
    ctx.setLineDash([4 * k, 4 * k]);
    ctx.strokeStyle = "#000000";
    ctx.stroke(p);
    ctx.restore();
  }
  function selectAll() { setSelection({ kind: "rect", x: 0, y: 0, w: doc.w, h: doc.h }, "Select all"); }
  function deselect() { if (selection) setSelection(null, "Deselect"); }
  function invertSelection() { setSelection(selection ? (selection.kind === "inv" ? selection.inner : { kind: "inv", inner: selection }) : null, "Invert selection"); }
  function clearSelected() {
    const n = selNode();
    if (!n) return;
    if (!selection || n.group) { if (!selection) layerOps.del(); return; }
    const l = n;
    if (l.kind === "text") {
      record("Clear selection", () => { const c = copyCanvas(l.canvas); applySel(c.getContext("2d"), inv(lm(l)), true); l.canvas = c; l.kind = "image"; delete l.text; });
      return;
    }
    // the selection's box in the layer's own pixels (a smart layer: through its inverse matrix)
    const Li = inv(lm(l)), sb = selBounds(selection), pts = [[sb.x, sb.y], [sb.x + sb.w, sb.y], [sb.x, sb.y + sb.h], [sb.x + sb.w, sb.y + sb.h]].map(([x, y]) => ap(Li, x, y));
    const bx = Math.min(...pts.map((v) => v[0])), by = Math.min(...pts.map((v) => v[1]));
    pixelEdit(l, { x: bx - 1, y: by - 1, w: Math.max(...pts.map((v) => v[0])) - bx + 2, h: Math.max(...pts.map((v) => v[1])) - by + 2 }, "Clear selection", (g, rr) => {
      // only the touched rectangle is rasterised
      const c = selCanvas(rr.w, rr.h, mul(T(-rr.x, -rr.y), Li));
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = "destination-out";
      g.drawImage(c, rr.x, rr.y);
      c.width = c.height = 1;
    });
  }
  function copyToLayer() {
    if (!selection) { layerOps.dup(); return; }
    const l = selLayer();
    if (!l) return;
    const c = maskedCopy(l), g = c.getContext("2d");
    applySel(g, inv(lm(l)));
    addLayer(newLayer({ name: nextName(), kind: "image", canvas: c, x: l.x, y: l.y, ...tfOf(l) }), "Copy to new layer");
  }

  // ── crop, rotate, flip, straighten ────────────────────────────────────────
  // The crop is non-destructive. `doc.crop` = {bw, bh: the whole picture it was made on, r (90°
  // turns), fx, fy (flips), a (straighten), rect (in the turned/flipped/straightened "work" space),
  // preset} or null. Applying a crop moves every layer by one matrix (smart layers: nothing is
  // resampled or cut off; what's outside stays in the layers). Opening Crop again moves them back:
  // the whole picture shows with the current crop on it (outside dimmed); Reset goes back to the
  // whole picture. Export and copy use the document as cropped.
  const workSize = () => (crop.r % 2 ? { w: doc.h, h: doc.w } : { w: doc.w, h: doc.h });
  function workM() {
    const ws = workSize();
    return mul(T(ws.w / 2, ws.h / 2), mul(R(crop.a), mul(S(crop.fx, crop.fy), mul(R(crop.r * 90), T(-doc.w / 2, -doc.h / 2)))));
  }
  /** Whole picture → cropped document, for crop `c`. */
  function cropN(c) {
    const ws = c.r % 2 ? { w: c.bh, h: c.bw } : { w: c.bw, h: c.bh };
    return mul(T(-c.rect.x, -c.rect.y), mul(T(ws.w / 2, ws.h / 2), mul(R(c.a), mul(S(c.fx, c.fy), mul(R(c.r * 90), T(-c.bw / 2, -c.bh / 2))))));
  }
  const cropSize = (c) => [Math.max(1, Math.round(c.rect.w)), Math.max(1, Math.round(c.rect.h))];
  /** Whether rectangle `r` (work space of crop `c`) lies on its whole picture. */
  function onPicture(c, r) {
    const Mi = inv(mul(T(c.rect.x, c.rect.y), cropN(c))), e = 0.01;
    return [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]].every(([x, y]) => { const [u, v] = ap(Mi, x, y); return u >= -e && v >= -e && u <= c.bw + e && v <= c.bh + e; });
  }
  /** Move every layer by N (document → new document) and make the document w × h. */
  function xformDoc(N, w, hh) { for (const l of doc.layers) compose(l, N); doc.w = w; doc.h = hh; }
  function validRect(r) {
    const Mi = inv(workM()), e = 0.01;
    for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
      const [u, v] = ap(Mi, x, y);
      if (u < -e || v < -e || u > doc.w + e || v > doc.h + e) return false;
    }
    return true;
  }
  const lerpR = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t });
  function bisect(a, b) {
    let lo = 0, hi2 = 1;
    for (let i = 0; i < 22; i++) { const m = (lo + hi2) / 2; if (validRect(lerpR(a, b, m))) lo = m; else hi2 = m; }
    return lerpR(a, b, lo);
  }
  function shrinkToFit(r) {
    if (validRect(r)) return r;
    let cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const at = (s) => ({ x: cx - (r.w * s) / 2, y: cy - (r.h * s) / 2, w: r.w * s, h: r.h * s });
    if (!validRect(at(0.001))) { const ws = workSize(); cx = ws.w / 2; cy = ws.h / 2; }
    let lo = 0, hi2 = 1;
    for (let i = 0; i < 24; i++) { const m = (lo + hi2) / 2; if (validRect(at(m))) lo = m; else hi2 = m; }
    return at(lo);
  }
  const cropRatio = () => (crop.lock ? crop.ratio : 0);
  function enterCrop() {
    if (crop || !doc) return;
    commitText();
    commitPending();
    const prev = doc.crop;
    let off = [0, 0];
    if (prev) {
      // back to the whole picture, the current crop on it; the kept part stays where it is on screen
      off = [prev.rect.x, prev.rect.y];
      xformDoc(inv(cropN(prev)), prev.bw, prev.bh);
      crop = { r: prev.r, fx: prev.fx, fy: prev.fy, a: prev.a, rect: { ...prev.rect }, base: null, preset: prev.preset || "Free", ratio: 0, lock: false };
      if (crop.preset !== "Free") { crop.lock = true; crop.ratio = prev.rect.w / prev.rect.h; }
      view.ox -= off[0] * view.z; view.oy -= off[1] * view.z;
    } else crop = { r: 0, fx: 1, fy: 1, a: 0, rect: { x: 0, y: 0, w: doc.w, h: doc.h }, base: null, preset: "Free", ratio: 0, lock: false };
    // with a selection the crop box starts at its bounding box (clamped to the picture)
    if (selection) {
      const sb = selBounds(selection), ws = workSize();
      const x0 = clamp(Math.floor(sb.x + off[0]), 0, ws.w), y0 = clamp(Math.floor(sb.y + off[1]), 0, ws.h);
      const x1 = clamp(Math.ceil(sb.x + sb.w + off[0]), 0, ws.w), y1 = clamp(Math.ceil(sb.y + sb.h + off[1]), 0, ws.h);
      if (x1 - x0 >= 1 && y1 - y0 >= 1) Object.assign(crop, { rect: shrinkToFit({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }), preset: "Free", lock: false, ratio: 0 });
    }
    selection = null;
    crop.base = { ...crop.rect };
    crop.entry = cropState();
    syncCropUI();
    if (prev && view.fitted) fit(view.cap);
    if (prev) saveSession();
    invalidate(true);
  }
  const cropState = () => JSON.stringify({ r: crop.r, fx: crop.fx, fy: crop.fy, a: crop.a, preset: crop.preset, rect: ["x", "y", "w", "h"].map((k) => Math.round(crop.rect[k] * 100) / 100) });
  /** Whether anything was changed since Crop opened (box, turn, flip, straighten, preset). */
  const cropChanged = () => !!crop && cropState() !== crop.entry;
  /** Keep the picture's centre where it is on screen when the working area changes size (same zoom). */
  function keepCentre(w0, h0, w1, h1) { view.ox += ((w0 - w1) / 2) * view.z; view.oy += ((h0 - h1) / 2) * view.z; view.fitted = false; }
  function exitCrop() {
    crop = null;
    if (tool === "crop") tool = "move";
    chip.hidden = true;
    syncCropUI();
    invalidate(true);
  }
  /** Leave Crop without changes: the document as it was (with the crop it had). */
  function cancelCrop() {
    if (!crop) return;
    const prev = doc.crop, ws = workSize();
    if (prev) {
      xformDoc(cropN(prev), ...cropSize(prev));
      view.ox += prev.rect.x * view.z; view.oy += prev.rect.y * view.z;
      saveSession();
    } else keepCentre(ws.w, ws.h, doc.w, doc.h);
    exitCrop();
    if (view.fitted) fit(view.cap);
  }
  const sameCrop = (a, b) => (!a || !b ? a === b : a.bw === b.bw && a.bh === b.bh && a.r === b.r && a.fx === b.fx && a.fy === b.fy && a.a === b.a && ["x", "y", "w", "h"].every((key) => a.rect[key] === b.rect[key]));
  function applyCrop() {
    if (!crop) return;
    const prev = doc.crop, bw = doc.w, bh = doc.h, r = crop.rect, ws = workSize();
    const x = Math.round(r.x), y = Math.round(r.y), w = Math.max(1, Math.round(r.w)), hh = Math.max(1, Math.round(r.h));
    const turned = crop.r || crop.fx < 0 || crop.fy < 0 || crop.a;
    const all = !crop.a && x === 0 && y === 0 && w === Math.round(ws.w) && hh === Math.round(ws.h);
    const next = all && !turned ? null : { bw, bh, r: crop.r, fx: crop.fx, fy: crop.fy, a: crop.a, rect: { x, y, w, h: hh }, preset: crop.preset };
    if (sameCrop(prev, next)) { cancelCrop(); return; }
    // the kept area stays exactly where it is on screen
    const keepX = view.ox + r.x * view.z, keepY = view.oy + r.y * view.z;
    // back to the crop as it was first (that's what undo returns to), then one step to the new one
    const Np = prev ? cropN(prev) : I;
    if (prev) xformDoc(Np, ...cropSize(prev));
    const label = crop.preset !== "Free" && crop.preset !== "Original" ? crop.preset : "";
    record(!next ? "Reset crop" : all ? "Rotate" : "Crop", () => {
      xformDoc(mul(next ? cropN(next) : I, inv(Np)), next ? w : bw, next ? hh : bh);
      doc.crop = next;
      doc.note = !next ? "" : all ? "rotated" : `cropped${label ? " " + label : ""}`;
    });
    exitCrop();
    view.ox = keepX + (x - r.x) * view.z; view.oy = keepY + (y - r.y) * view.z;
    view.fitted = false;
    invalidate(true);
  }
  /** Crop bar "Reset": the whole picture, not turned, flipped or straightened (Apply to keep it). */
  function resetCrop() {
    if (!crop) return;
    const w0 = workSize();
    Object.assign(crop, { r: 0, fx: 1, fy: 1, a: 0, preset: "Free", ratio: 0, lock: false, rect: { x: 0, y: 0, w: doc.w, h: doc.h } });
    crop.base = { ...crop.rect };
    const ws = workSize();
    keepCentre(w0.w, w0.h, ws.w, ws.h);
    renderProps();
    invalidate(true);
  }
  function applyPreset(label) {
    const ws = workSize();
    const v = ASPECTS.find((a) => a[0] === label)?.[1] ?? 0;
    crop.preset = label;
    if (v === 0) { crop.ratio = 0; crop.lock = false; }
    else {
      crop.ratio = v === -1 ? (crop.r % 2 ? doc.h0 / doc.w0 : doc.w0 / doc.h0) : v;
      crop.lock = true;
      let w = ws.w, hh = w / crop.ratio;
      if (hh > ws.h) { hh = ws.h; w = hh * crop.ratio; }
      crop.rect = shrinkToFit({ x: (ws.w - w) / 2, y: (ws.h - hh) / 2, w, h: hh });
    }
    crop.base = { ...crop.rect };
    syncCropFields();
    invalidate();
  }
  function rotate90() {
    if (!crop) return;
    const w0 = workSize();
    crop.r = (crop.r + (crop.fx * crop.fy < 0 ? 3 : 1)) % 4;
    const ws = workSize();
    keepCentre(w0.w, w0.h, ws.w, ws.h);
    crop.rect = { x: 0, y: 0, w: ws.w, h: ws.h };
    crop.base = { ...crop.rect };
    if (crop.preset !== "Free") applyPreset(crop.preset);
    else crop.rect = shrinkToFit(crop.rect);
    invalidate(true);
    syncCropFields();
  }
  function flip(hor) {
    if (!crop) return;
    const ws = workSize();
    if (hor) crop.fx *= -1; else crop.fy *= -1;
    crop.a = -crop.a;
    for (const r of [crop.rect, crop.base]) { if (hor) r.x = ws.w - r.x - r.w; else r.y = ws.h - r.y - r.h; }
    syncCropFields(true);
    invalidate(true);
  }
  function straighten(a) {
    crop.a = a;
    crop.rect = shrinkToFit({ ...crop.base });
    syncCropFields();
    invalidate(true);
  }
  function setCropRect(c, isMove) {
    if (!(c.w >= 1 && c.h >= 1)) return;
    let r = c;
    if (!validRect(r)) {
      const ws = workSize();
      if (isMove && !crop.a) r = { ...c, x: clamp(c.x, 0, ws.w - c.w), y: clamp(c.y, 0, ws.h - c.h) };
      if (!validRect(r)) r = bisect(crop.rect, c);
    }
    crop.rect = r;
    crop.base = { ...r };
    syncCropFields();
    invalidate();
  }
  function resizeRect(r0, hnd, x, y) {
    const ws = workSize();
    if (!crop.a) { x = clamp(x, 0, ws.w); y = clamp(y, 0, ws.h); }
    let L = r0.x, Tp = r0.y, Rr = r0.x + r0.w, B = r0.y + r0.h;
    if (hnd.includes("l")) L = Math.min(x, Rr - 1);
    if (hnd.includes("r")) Rr = Math.max(x, L + 1);
    if (hnd.includes("t")) Tp = Math.min(y, B - 1);
    if (hnd.includes("b")) B = Math.max(y, Tp + 1);
    let w = Rr - L, hh = B - Tp;
    const ratio = cropRatio();
    if (!ratio) return { x: L, y: Tp, w, h: hh };
    if (hnd.length === 2) {
      if (w / hh > ratio) hh = w / ratio; else w = hh * ratio;
      return { x: hnd.includes("l") ? Rr - w : L, y: hnd.includes("t") ? B - hh : Tp, w, h: hh };
    }
    if (hnd === "l" || hnd === "r") { hh = w / ratio; return { x: L, y: r0.y + r0.h / 2 - hh / 2, w, h: hh }; }
    w = hh * ratio;
    return { x: r0.x + r0.w / 2 - w / 2, y: Tp, w, h: hh };
  }
  function hitHandle(p) {
    const r = crop.rect, tol = (isPhone() ? 22 : 12) * zf;
    const x0 = view.ox + r.x * view.z, y0 = view.oy + r.y * view.z, x1 = x0 + r.w * view.z, y1 = y0 + r.h * view.z;
    const nx0 = Math.abs(p.x - x0) < tol, nx1 = Math.abs(p.x - x1) < tol, ny0 = Math.abs(p.y - y0) < tol, ny1 = Math.abs(p.y - y1) < tol;
    const inX = p.x > x0 - tol && p.x < x1 + tol, inY = p.y > y0 - tol && p.y < y1 + tol;
    if (nx0 && ny0) return "tl";
    if (nx1 && ny0) return "tr";
    if (nx0 && ny1) return "bl";
    if (nx1 && ny1) return "br";
    if (nx0 && inY) return "l";
    if (nx1 && inY) return "r";
    if (ny0 && inX) return "t";
    if (ny1 && inX) return "b";
    if (p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1) return "in";
    return null;
  }
  function cropGesture(p) {
    const hnd = hitHandle(p), r0 = { ...crop.rect }, [wx0, wy0] = toWork(p);
    const targets = snapTargets(null, crop.a ? null : workM(), true);
    if (crop.a) { targets.xs.length = 7; targets.ys.length = 7; } // rotated: image lines only
    const end = () => { guides = null; invalidate(); };
    if (hnd === "in") return {
      move(q2, ev) {
        const [x, y] = toWork(q2);
        const nx = r0.x + x - wx0, ny = r0.y + y - wy0;
        const [dx, dy] = snapBox(nx, ny, r0.w, r0.h, ev, targets);
        setCropRect({ ...r0, x: nx + dx, y: ny + dy }, true);
      },
      end,
    };
    if (hnd) return {
      move(q2, ev) {
        const [x, y] = snapPoint(...toWork(q2), ev, targets, /[lr]/.test(hnd), /[tb]/.test(hnd));
        setCropRect(resizeRect(r0, hnd, x, y));
      },
      end,
    };
    // outside the box: draw a new one
    const ws = workSize();
    const [ax, ay] = snapPoint(crop.a ? wx0 : clamp(wx0, 0, ws.w), crop.a ? wy0 : clamp(wy0, 0, ws.h), null, targets);
    return {
      move(q2, ev) {
        if (Math.hypot(q2.x - p.x, q2.y - p.y) < 4) return;
        const [x, y] = snapPoint(...toWork(q2), ev, targets);
        const hnd2 = (y < ay ? "t" : "b") + (x < ax ? "l" : "r");
        setCropRect(resizeRect({ x: ax, y: ay, w: 0, h: 0 }, hnd2, x, y));
      },
      end,
    };
  }
  function setCropSize(w, hh) {
    const r = crop.rect, ratio = cropRatio();
    if (ratio) { if (w !== Math.round(r.w)) hh = w / ratio; else w = hh * ratio; }
    const ws = workSize();
    w = clamp(w, 1, ws.w); hh = clamp(hh, 1, ws.h);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    let c = { x: clamp(cx - w / 2, 0, ws.w - w), y: clamp(cy - hh / 2, 0, ws.h - hh), w, h: hh };
    c = shrinkToFit(c);
    crop.rect = c;
    crop.base = { ...c };
    syncCropFields(true);
    invalidate();
  }
  function cropOverlay() {
    const r = crop.rect, u = zf * k, ph2 = isPhone();
    const Wm = docM();
    const quad = [[0, 0], [doc.w, 0], [doc.w, doc.h], [0, doc.h]].map(([x, y]) => ap(Wm, x, y));
    const x0 = (view.ox + r.x * view.z) * k, y0 = (view.oy + r.y * view.z) * k;
    const x1 = x0 + r.w * view.z * k, y1 = y0 + r.h * view.z * k;
    ctx.beginPath();
    quad.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fill("evenodd");
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    for (const f of [1 / 3, 2 / 3]) {
      ctx.fillRect(Math.round(x0 + (x1 - x0) * f), y0, Math.max(1, Math.round(k)), y1 - y0);
      ctx.fillRect(x0, Math.round(y0 + (y1 - y0) * f), x1 - x0, Math.max(1, Math.round(k)));
    }
    ctx.lineWidth = 1.5 * k;
    ctx.strokeStyle = acc;
    ctx.strokeRect(x0 + 0.75 * k, y0 + 0.75 * k, x1 - x0 - 1.5 * k, y1 - y0 - 1.5 * k);
    const L = (ph2 ? 22 : 16) * u, Th = (ph2 ? 4 : 3) * u;
    const bars = [];
    for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
      bars.push([sx > 0 ? cx - Th : cx - L + Th, sy > 0 ? cy - Th : cy, L, Th]);
      bars.push([sx > 0 ? cx - Th : cx, sy > 0 ? cy - Th : cy - L + Th, Th, L]);
    }
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    bars.push([mx - L / 2, y0 - Th, L, Th], [mx - L / 2, y1, L, Th], [x0 - Th, my - L / 2, Th, L], [x1, my - L / 2, Th, L]);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    for (const [x, y, w, hh] of bars) ctx.fillRect(x - k, y - k, w + 2 * k, hh + 2 * k);
    ctx.fillStyle = "#FFFFFF";
    for (const [x, y, w, hh] of bars) ctx.fillRect(x, y, w, hh);
    // size chip
    chip.hidden = false;
    chip.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}${crop.preset !== "Free" ? ` · ${crop.preset}` : ""}`;
    chip.style.left = `${(x0 + x1) / 2 / k / zf}px`;
    chip.style.top = `${Math.max(y0 / k / zf + 6, y1 / k / zf - 34)}px`;
  }

  // ── brush and eraser ──────────────────────────────────────────────────────
  const dabCache = new Map();
  function makeDab(size, hard, color) {
    const key = `${size}|${hard}|${color}`;
    if (dabCache.has(key)) return dabCache.get(key);
    if (dabCache.size > 16) dabCache.clear();
    const n = Math.min(1024, Math.max(4, Math.ceil(size)));
    const c = new OffscreenCanvas(n, n), x = c.getContext("2d");
    const [r, g, b] = hexRgb(color);
    const gr = x.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    gr.addColorStop(0, `rgba(${r},${g},${b},1)`);
    gr.addColorStop(Math.min(0.98, Math.max(0, hard)), `rgba(${r},${g},${b},1)`);
    gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = gr;
    x.fillRect(0, 0, n, n);
    dabCache.set(key, c);
    return c;
  }
  // A stroke is a list of dabs (layer coordinates). While painting, the dabs are drawn into a
  // screen-sized buffer (cheap to show every frame); on release they are replayed once at full
  // resolution and applied to the layer with the stroke's opacity, as one undo step.
  function strokeGesture(p, e) {
    let l = selLayer();
    if (!l) { if (selGroup()) toast("Pick a layer", { bad: true }); return null; }
    const onMask = tool === "mask";
    if (!l.visible) { toast("Layer hidden", { bad: true }); return null; }
    if (onMask) {
      if (l.kind === "text") { toast("Text has no mask", { bad: true }); return null; }
      if (unpaintable(l)) return askRasterize(l, "refine its mask");
      if (!l.mask) { addMask(l); l = selLayer(); }
      if (!l.maskOn) record("Show mask", () => { l.maskOn = true; });
    } else if (l.kind === "text") {
      if (tool === "eraser") { toast("Can't erase text", { bad: true }); return null; }
      l = addLayer(newLayer({ name: nextName(), canvas: blank(doc.w, doc.h) }), "New layer");
    } else if (unpaintable(l)) return askRasterize(l, tool === "brush" ? "paint on it" : "erase on it");
    commitPending();
    const o = onMask ? maskBrush : tool === "brush" ? brush : eraser;
    const erase = onMask ? maskBrush.mode === "remove" : tool === "eraser";
    stroke = {
      layer: l, alpha: o.opacity / 100, erase, size: o.size, sel: selection, onMask,
      dab: makeDab(o.size, o.hard / 100, onMask ? "#FFFFFF" : tool === "brush" ? o.color : "#000000"), last: null, rest: 0,
      dabs: [], drawn: 0, scr: null, scrKey: "", canvas: null, selScr: null,
      box: [Infinity, Infinity, -Infinity, -Infinity], tool,
      // a smart layer: dabs go into its source (layer pixels), sized for its scale
      inv: inv(lm(l)), ks: scaleOf(lm(l)),
    };
    if (e.shiftKey && lastPaint && lastPaint.layer === l) stroke.last = [lastPaint.x, lastPaint.y, 1];
    addPoint(p, e);
    invalidate(true);
    return {
      move(q2, ev) {
        const evs = ev.getCoalescedEvents?.();
        if (evs?.length) for (const ce of evs) addPoint(local(ce), ce); else addPoint(q2, ev);
        invalidate(true);
      },
      end() { commitStroke(); },
      cancel() { stroke = null; invalidate(true); },
    };
  }
  /**
   * Zoomed in (a layer pixel covers 2+ screen pixels): the live stroke is drawn at the layer's own
   * resolution, over the visible part of the layer only, and shown as blocks, exactly as it will look
   * once applied. (A screen-resolution preview would be smooth while painting and turn blocky on release.)
   */
  function syncStrokePixels(M, L) {
    const s = stroke, W = cv.width, H = cv.height, lw = s.layer.canvas.width, lh = s.layer.canvas.height;
    const Li = inv(L), pts = [[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => ap(Li, x, y));
    const rx = clamp(Math.floor(Math.min(...pts.map((q) => q[0]))) - 1, 0, lw), ry = clamp(Math.floor(Math.min(...pts.map((q) => q[1]))) - 1, 0, lh);
    const rw = clamp(Math.ceil(Math.max(...pts.map((q) => q[0]))) + 1, 0, lw) - rx, rh = clamp(Math.ceil(Math.max(...pts.map((q) => q[1]))) + 1, 0, lh) - ry;
    if (!s.scr || s.scr.width !== W || s.scr.height !== H) s.scr = blank(W, H);
    const key = `px|${W}x${H}|${L.join(",")}`;
    if (key !== s.scrKey || !s.px || s.px.rx !== rx || s.px.ry !== ry || s.px.c.width !== Math.max(1, rw) || s.px.c.height !== Math.max(1, rh)) {
      s.px = { rx, ry, c: blank(Math.max(1, rw), Math.max(1, rh)) };
      s.drawn = 0;
      s.scrKey = key;
    }
    if (s.drawn < s.dabs.length) {
      const pg = s.px.c.getContext("2d");
      pg.setTransform(1, 0, 0, 1, -rx, -ry);
      for (let i = s.drawn; i < s.dabs.length; i++) { const [x, y, d] = s.dabs[i]; pg.drawImage(s.dab, x - d / 2, y - d / 2, d, d); }
      s.drawn = s.dabs.length;
    }
    const g = s.scr.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, W, H);
    g.imageSmoothingEnabled = false;
    g.setTransform(L[0], L[1], L[2], L[3], L[4], L[5]);
    g.drawImage(s.px.c, rx, ry);
    if (s.sel) {
      const sk = `${W}x${H}|${M.join(",")}`;
      if (!s.selScr || s.selScr.key !== sk) s.selScr = { key: sk, c: selCanvas(W, H, M, s.sel) };
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = "destination-in";
      g.drawImage(s.selScr.c, 0, 0);
      g.globalCompositeOperation = "source-over";
    }
  }
  /** Bring the screen-space stroke buffer up to date for the current view (called by frame()). */
  function syncStroke(M) {
    const s = stroke, W = cv.width, H = cv.height;
    const L = mul(M, lm(s.layer));
    if (scaleOf(L) >= 2) { syncStrokePixels(M, L); return; }
    s.px = null;
    const key = `${W}x${H}|${L.join(",")}`;
    if (!s.scr || s.scr.width !== W || s.scr.height !== H) { s.scr = blank(W, H); s.scrKey = ""; }
    const g = s.scr.getContext("2d");
    g.imageSmoothingEnabled = true;
    if (key !== s.scrKey) {
      // view changed: redraw every dab
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, H);
      s.drawn = 0;
      s.scrKey = key;
    }
    if (s.drawn >= s.dabs.length) return;
    g.save();
    g.setTransform(L[0], L[1], L[2], L[3], L[4], L[5]);
    for (let i = s.drawn; i < s.dabs.length; i++) { const [x, y, d] = s.dabs[i]; g.drawImage(s.dab, x - d / 2, y - d / 2, d, d); }
    if (s.sel) {
      // painting stays inside the selection (any shape, also combined ones)
      const sk = `${W}x${H}|${M.join(",")}`;
      if (!s.selScr || s.selScr.key !== sk) s.selScr = { key: sk, c: selCanvas(W, H, M, s.sel) };
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = "destination-in";
      g.drawImage(s.selScr.c, 0, 0);
    }
    g.restore();
    s.drawn = s.dabs.length;
  }
  function dabAt(x, y, pr) {
    const s = stroke, d = Math.max(0.5, (s.size * pr) / s.ks);
    s.dabs.push([x, y, d]);
    const b = s.box;
    b[0] = Math.min(b[0], x - d / 2 - 2); b[1] = Math.min(b[1], y - d / 2 - 2);
    b[2] = Math.max(b[2], x + d / 2 + 2); b[3] = Math.max(b[3], y + d / 2 + 2);
  }
  function addPoint(p, e) {
    const s = stroke;
    if (!s) return;
    const [x, y] = ap(s.inv, ...toDoc(p));
    const pr = e.pointerType === "pen" ? Math.max(0.05, e.pressure || 0.5) : 1;
    if (!s.last) { dabAt(x, y, pr); s.last = [x, y, pr]; return; }
    const [lx, ly, lp] = s.last, d = Math.hypot(x - lx, y - ly);
    const step = Math.max(0.5, (s.size * 0.08) / s.ks);
    let pos = step - s.rest;
    while (pos <= d) { const f = pos / d; dabAt(lx + (x - lx) * f, ly + (y - ly) * f, lp + (pr - lp) * f); pos += step; }
    s.rest = d - (pos - step);
    s.last = [x, y, pr];
  }
  let lastPaint = null;
  function commitStroke() {
    const s = stroke;
    if (!s) return;
    if (s.last) lastPaint = { layer: s.layer, x: s.last[0], y: s.last[1] };
    stroke = null;
    // only the part on the layer (a big brush on a small source would otherwise make a huge buffer)
    const [bx0, by0, bx1, by1] = s.box, cw = s.layer.canvas.width, ch = s.layer.canvas.height;
    const x0 = clamp(Math.floor(bx0), 0, cw), y0 = clamp(Math.floor(by0), 0, ch), w = clamp(Math.ceil(bx1), 0, cw) - x0, hh = clamp(Math.ceil(by1), 0, ch) - y0;
    if (w <= 0 || hh <= 0) return;
    // replay the dabs at full resolution, only over the stroke's bounding box
    const buf = blank(w, hh), g = buf.getContext("2d");
    g.setTransform(1, 0, 0, 1, -x0, -y0);
    for (const [x, y, d] of s.dabs) g.drawImage(s.dab, x - d / 2, y - d / 2, d, d);
    if (s.sel) applySel(g, mul(T(-x0, -y0), s.inv));
    if (s.onMask) { maskStroke(s.layer, { x: x0, y: y0, w, h: hh }, buf, s.alpha, s.erase); invalidate(true); return; }
    pixelEdit(s.layer, { x: x0, y: y0, w, h: hh }, s.tool === "brush" ? "Brush" : "Eraser", (lg) => {
      lg.globalAlpha = s.alpha;
      lg.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
      lg.drawImage(buf, x0, y0);
    });
    invalidate(true);
  }

  // ── layer masks ───────────────────────────────────────────────────────────
  // A layer mask hides parts of a layer without changing its pixels: `l.mask` is a canvas the size
  // of the layer (white pixels; alpha = how much shows), `l.maskBase` the same alpha as bytes
  // before the edge controls (`l.maskShift` px grow/shrink, `l.maskSoft` px feather). Keep/Remove
  // strokes change the base; the edge controls are then re-applied around the stroke only.
  const maskBrush = { size: 60, hard: 70, opacity: 100, mode: "keep" };
  const MASK_KEYS = ["mask", "maskBase", "maskOn", "maskShift", "maskSoft", "preBg", "bgFixed"];
  function dropMask(o) { for (const key of MASK_KEYS) delete o[key]; return o; }
  function putAlpha(c, alpha, w, h, x = 0, y = 0, rw = w, rh = h) { c.getContext("2d").putImageData(alphaToImageData(alpha, w, h, x, y, rw, rh), x, y); }
  function alphaOf(c) {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data, a = new Uint8Array(c.width * c.height);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    return a;
  }
  function addMask(l) {
    record("Add mask", () => {
      const w = l.canvas.width, hh = l.canvas.height, a = new Uint8Array(w * hh).fill(255), c = blank(w, hh);
      putAlpha(c, a, w, hh);
      Object.assign(l, { mask: c, maskBase: a, maskOn: true, maskShift: 0, maskSoft: 0 });
    });
  }
  /** Invert a layer's mask: what was hidden shows and the other way round (undoable). New arrays and
   *  canvases, never edited in place, so undo keeps the old ones. The edge controls stay meaningful:
   *  growing the old mask = shrinking the new one. After the background remover, the part that now
   *  shows uses the photo's original colours (the cleaned edge colours belong to the old cut-out). */
  function invertMask(l) {
    if (!l?.mask) return false;
    return record("Invert mask", () => {
      const W = l.mask.width, H = l.mask.height, base = new Uint8Array(l.maskBase.length);
      for (let i = 0; i < base.length; i++) base[i] = 255 - l.maskBase[i];
      const cur = alphaOf(l.mask);
      for (let i = 0; i < cur.length; i++) cur[i] = 255 - cur[i];
      const c = blank(W, H);
      putAlpha(c, cur, W, H);
      Object.assign(l, { mask: c, maskBase: base, maskShift: -(l.maskShift || 0) || 0, maskOn: true });
      if (l.preBg && l.bgFixed) l.canvas = l.canvas === l.bgFixed ? l.preBg : l.bgFixed;
    });
  }
  /** The layer's pixels with its mask applied (a new canvas). */
  function maskedCopy(l) {
    const c = copyCanvas(l.canvas);
    if (l.mask && l.maskOn) { const g = c.getContext("2d"); g.globalCompositeOperation = "destination-in"; g.drawImage(l.mask, 0, 0); }
    return c;
  }
  /** After a geometry change (crop, rotate, scale) the mask is redrawn the same way; its edges are baked in. */
  function remask(l, w, hh, drawFn) {
    if (!l.mask) return;
    const c = blank(w, hh), g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    drawFn(g, l.mask);
    Object.assign(l, { mask: c, maskBase: alphaOf(c), maskShift: 0, maskSoft: 0 });
  }
  /** Re-apply the edge controls inside rectangle `r` of the mask from its base. */
  function rederiveRect(mask, base, shift, soft, r) {
    const W = mask.width, H = mask.height;
    if (!shift && !soft) { putAlpha(mask, base, W, H, r.x, r.y, r.w, r.h); return; }
    const p = Math.ceil(Math.abs(shift) + soft * 2) + 2;
    const X0 = Math.max(0, r.x - p), Y0 = Math.max(0, r.y - p), X1 = Math.min(W, r.x + r.w + p), Y1 = Math.min(H, r.y + r.h + p), sw = X1 - X0, sh = Y1 - Y0;
    const sub = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) sub.set(base.subarray((Y0 + y) * W + X0, (Y0 + y) * W + X1), y * sw);
    const d = deriveMask(sub, sw, sh, shift, soft);
    mask.getContext("2d").putImageData(alphaToImageData(d, sw, sh, r.x - X0, r.y - Y0, r.w, r.h), r.x, r.y);
  }
  function maskStroke(l, r0, buf, alpha, remove) {
    const mask = l.mask, base = l.maskBase, W = mask.width, H = mask.height;
    const x0 = clamp(r0.x, 0, W), y0 = clamp(r0.y, 0, H), x1 = clamp(r0.x + r0.w, 0, W), y1 = clamp(r0.y + r0.h, 0, H);
    if (x1 <= x0 || y1 <= y0) return;
    commitPending();
    const shift = l.maskShift || 0, soft = l.maskSoft || 0, pad = Math.ceil(Math.abs(shift) + soft * 2) + 2;
    const rr = { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad) };
    rr.w = Math.min(W, x1 + pad) - rr.x; rr.h = Math.min(H, y1 + pad) - rr.y;
    const grab = () => { const o = new Uint8Array(rr.w * rr.h); for (let r = 0; r < rr.h; r++) o.set(base.subarray((rr.y + r) * W + rr.x, (rr.y + r) * W + rr.x + rr.w), r * rr.w); return o; };
    const back = (o) => { for (let r = 0; r < rr.h; r++) base.set(o.subarray(r * rr.w, (r + 1) * rr.w), (rr.y + r) * W + rr.x); };
    const beforeBase = grab(), beforeMask = region(mask, rr);
    const sw = x1 - x0, sd = buf.getContext("2d").getImageData(x0 - r0.x, y0 - r0.y, sw, y1 - y0).data;
    // Keep paints the photo back. After the background remover the layer shows a copy whose edge
    // colours were cleaned for the cut-out (bgFixed); a kept pixel there moves towards the photo's
    // own colour by the stroke's strength, as if the photo were painted over the cut-out
    // (premultiplied: P += s·(I − P)). Without this, restored areas show the cleaned colours.
    const fixed = !remove && l.preBg && l.bgFixed && l.bgFixed.width === W && l.bgFixed.height === H ? l.bgFixed : null;
    const rc = { x: x0, y: y0, w: sw, h: y1 - y0 };
    const fImg = fixed ? fixed.getContext("2d").getImageData(x0, y0, rc.w, rc.h) : null, fd = fImg?.data;
    const pd = fixed ? l.preBg.getContext("2d").getImageData(x0, y0, rc.w, rc.h).data : null;
    let recol = false;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = ((y - y0) * sw + (x - x0)) * 4, s = (sd[o + 3] / 255) * alpha;
      if (!s) continue;
      const i = y * W + x, b = base[i];
      base[i] = Math.round(remove ? b * (1 - s) : b + (255 - b) * s);
      if (fd && (fd[o] !== pd[o] || fd[o + 1] !== pd[o + 1] || fd[o + 2] !== pd[o + 2])) {
        const m0 = b / 255, m1 = m0 + (1 - m0) * s;
        for (let ch = 0; ch < 3; ch++) { const p0 = fd[o + ch] * m0; fd[o + ch] = Math.round((p0 + s * (pd[o + ch] - p0)) / m1); }
        recol = true;
      }
    }
    const beforeFix = recol ? region(fixed, rc) : null;
    if (recol) { fixed.getContext("2d").putImageData(fImg, x0, y0); bump(fixed); pyrUpdate(fixed, rc); }
    const afterFix = recol ? region(fixed, rc) : null;
    rederiveRect(mask, base, shift, soft, rr);
    const afterBase = grab(), afterMask = region(mask, rr);
    bump(mask); pyrUpdate(mask, rr); bump(base);
    const fix = (part) => { if (recol) { put(fixed, rc, part); bump(fixed); pyrUpdate(fixed, rc); } };
    push({
      label: remove ? "Remove (mask)" : "Keep (mask)", bytes: rr.w * rr.h * 10 + (recol ? rc.w * rc.h * 8 : 0),
      undo: () => { back(beforeBase); put(mask, rr, beforeMask); bump(base); fix(beforeFix); },
      redo: () => { back(afterBase); put(mask, rr, afterMask); bump(base); fix(afterFix); },
    });
    changed();
  }
  /** Edge controls for the whole mask (in a worker: big photos take a moment). */
  let edgeSeq = 0;
  async function setMaskEdges(l, shift, soft) {
    if (!l?.mask) return;
    const my = ++edgeSeq, base = l.maskBase, W = l.mask.width, H = l.mask.height;
    let c;
    if (!shift && !soft) { c = blank(W, H); putAlpha(c, base, W, H); }
    else {
      const r = await call("msk", { op: "derive", base: base.slice(), w: W, h: H, shift, soft });
      if (my !== edgeSeq || !doc?.layers.some((x) => x.maskBase === base)) { r.bitmap.close(); return; }
      c = blank(W, H);
      c.getContext("2d").drawImage(r.bitmap, 0, 0);
      r.bitmap.close();
    }
    const cur = doc.layers.find((x) => x.maskBase === base);
    if (!cur) return;
    beginEdit();
    Object.assign(cur, { mask: c, maskShift: shift, maskSoft: soft });
    invalidate(true);
  }
  function toggleMask(l) { if (l?.mask) record(l.maskOn ? "Hide mask" : "Show mask", () => { l.maskOn = !l.maskOn; }); }
  function deleteMask(l) {
    if (!l?.mask) return;
    record("Delete mask", () => { if (l.preBg) l.canvas = l.preBg; dropMask(l); });
    if (tool === "mask") setTool("move");
  }
  function setCleanEdges(l, on) {
    if (!l?.preBg || !l.bgFixed) return;
    record(on ? "Clean edge colours" : "Original edge colours", () => { l.canvas = on ? l.bgFixed : l.preBg; });
  }

  // ── remove background (AI in a worker; see BG_REMOVER.md) ─ ─────────────
  const rb = { job: null, view: "photo", color: "#FFFFFF", viewColor: "#FFFFFF", el: null, st: null };
  onIdle.bg = () => { rb.warm = null; };
  // phones and low-memory devices: no high-detail pass and no big model (they hold several big buffers at once)
  const lowMem = (navigator.deviceMemory && navigator.deviceMemory <= 4) || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  // Upscale (AI in a worker; see UPSCALE.md): the button, picker and progress card are in upscale-ui.js
  const upscaler = createUpscale({
    doc: () => doc, selLayer: () => selLayer(), call, kill, stage, lowMem: () => lowMem, tooBig: (w, hh) => tooBig(w, hh), tooBigMsg: (w, hh) => tooBigMsg(w, hh), blank, alphaOf, lin, setLm, undo: () => undo(), sync: () => syncFoot(),
    commit: () => { commitText(); if (crop) applyCrop(); }, resize: (w, hh, tweak, label) => resizeImage(w, hh, tweak, label),
  });
  // Fast: BiRefNet 512 + full-resolution edge refinement. High detail: BiRefNet 1024, a bigger model
  // (own download, no tiling). Hair & fur: BiRefNet matting 1024 (own download). See BG_REMOVER.md
  // (People and Fine detail were tried and taken out: no better than High detail).
  const QUALITIES = [
    ["fast", "Fast", "Fast"],
    ["hq", "High detail", "High detail"],
    ["soft", "Hair & fur", "Hair & fur"],
  ];
  const MODEL_OF = { fast: "birefnet-512", hq: "birefnet-1024", soft: "birefnet-matting-1024" };
  rb.quality = "fast"; rb.speed = {};
  try { rb.quality = localStorage.getItem("quickcut.photo.bgq") || ""; rb.speed = JSON.parse(localStorage.getItem("quickcut.photo.bgspeed") || "{}"); } catch {}
  /** Why a quality can't run here ("" when it can), from feature detection of the GPU. */
  function whyNot(qv, st = rb.st) {
    if (qv === "fast") return "";
    if (lowMem) return "Not enough memory";
    // the big models don't fit the CPU engine's memory (WebAssembly: at most 4 GB per page)
    if (epPref() === "wasm") return "Needs the GPU (Run on: GPU)";
    if (st && !st.models?.[MODEL_OF[qv]]) return "Not installed";
    return st?.models?.[MODEL_OF[qv]]?.unfit || "";
  }
  /** The remembered choice, or the best default for this device (Fast; the others are opt-in: slower). */
  const pickQuality = () => (QUALITIES.some((x) => x[0] === rb.quality) && !whyNot(rb.quality) ? rb.quality : "fast");
  function setQuality(qv) { if (whyNot(qv)) return; rb.quality = qv; try { localStorage.setItem("quickcut.photo.bgq", qv); } catch {} }
  /** "≈ 3 s here" for the selected layer, from the last run of that quality on this device. */
  function bgEstimate(qv) {
    const l = selLayer(), v = rb.speed[qv];
    if (!l || !v) return "";
    const s0 = (v.base + (v.perMP * l.canvas.width * l.canvas.height) / 1e6) / 1000;
    return `≈ ${s0 < 1 ? "1" : Math.round(s0)} s here`;
  }
  // (the download size is on each quality's row, so only the time estimate goes here)
  const qualityNote = (qv) => bgEstimate(qv);
  /** A quality's size in the picker: what a first use downloads (with the download icon), else the model's size. */
  function qualitySize(qv) {
    const m = rb.st?.models?.[MODEL_OF[qv]];
    if (!m) return "";
    return m.bytes ? `${icon("download", 12)}${fmtMB(m.bytes)}` : fmtMB(m.size);
  }
  // a list (five qualities don't fit one row of a 300 px popup): name left, size right
  const qualitySeg = () => {
    const cur = pickQuality();
    return `<div class="field-label ph-q"><span class="row-between">Quality<span class="v" data-v="est">${qualityNote(cur)}</span></span>
      <div class="ph-qlist" role="radiogroup" aria-label="Quality">${QUALITIES.map(([id, n, t]) => { const no = whyNot(id); return `<button type="button" role="radio" data-q="${id}" aria-checked="${cur === id}" ${no ? `aria-disabled="true" data-no="${esc(no)}" title="${n}: ${esc(no)}"` : `title="${t}"`}><span class="n">${n}</span><span class="sz">${qualitySize(id)}</span></button>`; }).join("")}</div></div>`;
  };
  function bindQuality(el, onChange) {
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-q]");
      if (!b) return;
      // a quality this device can't run: say why (a tooltip alone is easy to miss)
      if (b.getAttribute("aria-disabled") === "true") { toast(b.dataset.no || "Not available here", { info: true, ms: 4000 }); return; }
      setQuality(b.dataset.q);
      for (const x of el.querySelectorAll("[data-q]")) x.setAttribute("aria-checked", String(x.dataset.q === rb.quality));
      const est = el.querySelector('[data-v="est"]');
      if (est) est.textContent = qualityNote(rb.quality);
      onChange?.();
    });
  }
  const bgEp = () => { try { return new URLSearchParams(location.search).get("bgep") || localStorage.getItem("quickcut.photo.bgep") || "auto"; } catch { return "auto"; } };
  /** Where the AI runs, as the user chose it (GPU by default; remembered). */
  const epPref = () => { try { return localStorage.getItem("quickcut.photo.bgep") === "wasm" ? "wasm" : "auto"; } catch { return "auto"; } };
  function setEp(ep) {
    try { if (ep === "wasm") localStorage.setItem("quickcut.photo.bgep", "wasm"); else localStorage.removeItem("quickcut.photo.bgep"); } catch {}
    if (!rb.job) { kill("bg"); rb.warm = null; } // the next run starts the AI where it was asked to
  }
  const epSeg = () => {
    const cur = epPref(), noGpu = rb.st?.gpu && (!rb.st.gpu.webgpu || rb.st.gpu.fallback) ? (rb.st.gpu.api ? "GPU unavailable right now. Restart the browser" : "No GPU access in this browser") : "";
    return `<div class="field-label ph-ep"><span class="row-between">Run on</span><div class="seg fill" role="radiogroup" aria-label="Run on">${[["auto", "GPU", noGpu], ["wasm", "CPU", ""]].map(([id, n, no]) => `<button type="button" role="radio" data-ep="${id}" aria-checked="${cur === id}" ${no ? `aria-disabled="true" data-no="${esc(no)}" title="${n}: ${esc(no)}"` : `title="${n}"`}>${n}</button>`).join("")}</div></div>`;
  };
  function bindEp(el) {
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-ep]");
      if (!b) return;
      if (b.getAttribute("aria-disabled") === "true") { toast(b.dataset.no, { info: true, ms: 4000 }); return; }
      setEp(b.dataset.ep);
      for (const x of el.querySelectorAll("[data-ep]")) x.setAttribute("aria-checked", String(x.dataset.ep === epPref()));
      // the qualities this choice allows (High detail / Hair & fur need the GPU)
      const qs = el.querySelector(".ph-q");
      if (qs) qs.outerHTML = qualitySeg();
    });
  }
  const fmtMB = (b) => `${Math.round(b / 1e6)} MB`;
  async function bgStatus(model) { rb.st = await call("bg", { op: "status", model }); return rb.st; }
  /** Hovering a Remove background button starts the AI (if it was downloaded before), so the click is quick. */
  function warmBg() {
    if (rb.job || rb.warm) return;
    rb.warm = call("bg", { op: "warm", model: MODEL_OF[pickQuality()], ep: bgEp() }).catch(() => null);
  }
  async function removeBackground({ quality, agreed = false } = {}) {
    if (!doc) return;
    const l = selLayer();
    if (!l || l.kind === "text") { toast("Pick a photo layer", { bad: true }); return; }
    if (rb.job) return;
    commitText();
    if (crop) applyCrop();
    // the progress card shows in the same frame as the click, before anything is awaited
    const job = (rb.job = { cancelled: false, t0: performance.now() });
    bgProgress("Starting…", null);
    syncFoot();
    let st;
    try { st = await bgStatus(MODEL_OF[quality || pickQuality()]); }
    catch (e) { if (job.cancelled) return; endBg(); syncFoot(); toast(e.message || "Not available", { bad: true }); return; }
    if (job.cancelled) return;
    const qv = quality || pickQuality();
    const m = st.models[MODEL_OF[qv]];
    if (m?.bytes && !agreed) { endBg(); syncFoot(); askDownload(() => removeBackground({ quality: pickQuality(), agreed: true })); return; }
    runBg(l, qv, job);
  }
  /** "Downloaded model · N MB · Remove" rows (one per model on this device), with an inline confirm. */
  function storedRows(el) {
    const box = h(`<div class="ph-stored"></div>`);
    const fill = () => {
      const st = rb.st, ms = st?.stored > 0 ? Object.entries(st.models || {}).filter(([, m]) => m.cached) : [];
      box.replaceChildren(...ms.map(([id, m]) => {
        const name = QUALITIES.find((x) => MODEL_OF[x[0]] === id)?.[1];
        const r = h(`<div class="row-between small"><span class="t"></span><button class="btn-g sm" type="button">Remove</button></div>`);
        r.querySelector(".t").textContent = `Downloaded model${name ? ` (${name})` : ""} · ${fmtMB(m.size)}`;
        r.querySelector("button").onclick = () => {
          r.querySelector(".t").textContent = `Remove ${fmtMB(m.size)}?`;
          const keep = h(`<span class="acts"><button class="btn-g sm" type="button" data-s="rm">Remove</button><button class="btn-g sm" type="button" data-s="keep">Keep</button></span>`);
          r.querySelector("button").replaceWith(keep);
          keep.querySelector('[data-s="rm"]').focus();
          keep.onclick = async (e) => {
            const b = e.target.closest("[data-s]");
            if (!b) return;
            if (b.dataset.s === "keep") { fill(); return; }
            for (const x of keep.querySelectorAll("button")) x.disabled = true;
            if (rb.job) cancelBg();
            try { await call("bg", { op: "remove", models: [id] }); } catch (err) { toast(`Couldn't remove it: ${err.message}`, { bad: true }); }
            kill("bg"); rb.warm = null; rb.st = null;
            toast("Model removed", { info: true, ms: 1500 });
            try { await bgStatus(MODEL_OF[pickQuality()]); } catch {}
            fill();
            const est = el.querySelector('[data-v="est"]');
            if (est) est.textContent = qualityNote(pickQuality());
          };
        };
        return r;
      }));
      box.hidden = !ms.length;
    };
    fill();
    return box;
  }
  /** The arrow next to Remove background: pick the default AI model, remove downloaded ones. */
  async function openBgMenu(anchor) {
    const el = h(`<section class="ph-pop ph-bgmenu" role="dialog" aria-label="AI model">${qualitySeg()}${epSeg()}</section>`);
    bindQuality(el);
    bindEp(el);
    // open at once; sizes, availability and the downloaded models fill in when the worker answers
    if (openLayer(el, { anchor, width: 320, reopen: false }).toggledOff) return;
    try { await bgStatus(MODEL_OF[pickQuality()]); } catch {}
    if (!el.isConnected) return;
    el.querySelector(".ph-q").outerHTML = qualitySeg();
    el.querySelector(".ph-ep").outerHTML = epSeg();
    el.append(storedRows(el));
  }
  function askDownload(go) {
    const el = h(`<section class="ph-pop ph-bgask" role="dialog" aria-label="Remove background">
      <div class="pop-head"><span class="pop-title">Remove background</span><button class="ib" type="button" data-b="close" aria-label="Close">${icon("x")}</button></div>
      ${qualitySeg()}
      <button class="btn-p big" type="button" data-b="go" autofocus></button>
      <button class="btn-g big" type="button" data-b="close">Not now</button>
    </section>`);
    const goBtn = el.querySelector('[data-b="go"]');
    const label = () => {
      const m = rb.st?.models?.[MODEL_OF[pickQuality()]];
      goBtn.innerHTML = m?.bytes ? `${icon("download")}Download ${fmtMB(m.bytes)} and remove<span class="kbd desk-only">↵</span>` : `${icon(PI.cutout)}Remove background<span class="kbd desk-only">↵</span>`;
    };
    label();
    bindQuality(el, label);
    el.querySelector('[data-b="close"].big').before(storedRows(el));
    const L = openLayer(el, { center: true, width: 380, reopen: false });
    // ask the browser to keep the download (not cleared when the disk gets full); some browsers ask the user
    const goNow = () => { L.close(); try { navigator.storage?.persist?.().catch(() => {}); } catch {} go(); };
    el.addEventListener("click", (e) => { const b = e.target.closest("[data-b]"); if (!b) return; if (b.dataset.b === "go") goNow(); else L.close(); });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); goNow(); } });
    requestAnimationFrame(() => goBtn.focus());
  }
  function bgCard() {
    if (rb.el) return rb.el;
    rb.el = h(`<div class="ph-bgjob float" role="status" aria-live="polite">
      <span class="t"><b>Removing background</b><span class="s">Starting…</span></span>
      <span class="progress"><span></span></span>
      <button class="btn-g sm" type="button">Cancel<span class="kbd desk-only">Esc</span></button></div>`);
    rb.el.querySelector("button").onclick = cancelBg;
    stage.append(rb.el);
    return rb.el;
  }
  function bgProgress(text, f) {
    const el = bgCard();
    el.querySelector(".s").textContent = text;
    const pr = el.querySelector(".progress");
    pr.classList.toggle("indeterminate", f == null);
    pr.firstElementChild.style.width = f == null ? "" : `${Math.round(f * 100)}%`;
  }
  function cancelBg() {
    if (!rb.job) return false;
    rb.job.cancelled = true;
    kill("bg");
    rb.warm = null;
    endBg();
    toast("Cancelled", { info: true, ms: 1500 });
    return true;
  }
  function endBg() { rb.job = null; rb.el?.remove(); rb.el = null; }
  /**
   * The part of a layer's own pixels that shows in the (cropped) document, with a small margin, or
   * null when that's (nearly) all of it. The background remover looks only at this part: what was
   * cropped away mustn't decide what the subject is, and the kept part gets more of the model's pixels.
   */
  function visibleRegion(l, src) {
    const W = src.width, H = src.height, Mi = inv(lm(l));
    const pts = [[0, 0], [doc.w, 0], [0, doc.h], [doc.w, doc.h]].map(([x, y]) => ap(Mi, x, y));
    const m = Math.round(Math.max(W, H) * 0.02);
    const x0 = clamp(Math.floor(Math.min(...pts.map((p) => p[0]))) - m, 0, W), y0 = clamp(Math.floor(Math.min(...pts.map((p) => p[1]))) - m, 0, H);
    const x1 = clamp(Math.ceil(Math.max(...pts.map((p) => p[0]))) + m, 0, W), y1 = clamp(Math.ceil(Math.max(...pts.map((p) => p[1]))) + m, 0, H);
    if (x1 - x0 < 8 || y1 - y0 < 8) return null;
    if ((x1 - x0) * (y1 - y0) >= 0.9 * W * H) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const BIG_MP = 24; // from this size High detail adds the tile pass
  async function runBg(l, quality, job = (rb.job = { cancelled: false, t0: performance.now() })) {
    const d = doc, src = l.preBg || l.canvas, layerId = l.id, reg = visibleRegion(l, src);
    syncFoot();
    // what to try, in order: the chosen quality; if the GPU fails (driver error, lost device, out of
    // memory), the fast model on the GPU, then on the CPU (WebAssembly): always a result, maybe slower
    // (the retries also use the smaller working size of low-memory devices)
    // very large photos on High detail (GPU): an extra pass over overlapping tiles for more detail,
    // used only around the edges (about 4× the time, so not for ordinary sizes)
    const mp = (reg ? reg.w * reg.h : src.width * src.height) / 1e6;
    const big = quality === "hq" && !lowMem && bgEp() !== "wasm" && mp >= BIG_MP;
    const tries = [{ model: MODEL_OF[quality], ep: bgEp(), hq: big, big, q: quality, small: lowMem }];
    tries.push({ model: MODEL_OF.fast, ep: bgEp(), hq: false, q: "fast", small: true });
    if (bgEp() !== "wasm") tries.push({ model: MODEL_OF.fast, ep: "wasm", hq: false, q: "fast", small: true });
    let r = null, ini = null, used = null, lastErr = null;
    for (const t of tries) {
      if (job.cancelled) return;
      try {
        bgProgress(lastErr ? "Retrying…" : "Starting the AI…", null);
        ini = await call("bg", { op: "init", model: t.model, ep: t.ep }, [], (p) => {
          if (p.stage === "download") bgProgress(`Downloading · ${fmtMB(p.loaded)} / ${fmtMB(p.total)}`, p.total ? p.loaded / p.total : null);
          else if (p.stage === "load") bgProgress("Starting the AI…", null);
        });
        if (job.cancelled) return;
        bgProgress(ini.ep !== "webgpu" ? "Finding subject…" : "Finding subject…", null);
        const bitmap = reg ? await createImageBitmap(src, reg.x, reg.y, reg.w, reg.h) : await createImageBitmap(src);
        if (ini?.unsaved && !rb.unsavedShown) { rb.unsavedShown = true; toast("Model not saved: storage full or private window", { info: true, ms: 5000 }); }
        // a GPU driver that resets under load can leave the run hanging: no sign of life for 90 s
        // on the GPU = give up on it (the worker is restarted) and go on with the next way
        let alive = performance.now();
        const dog = ini.ep === "webgpu" ? setInterval(() => { if (performance.now() - alive > 90000) { clearInterval(dog); kill("bg"); rb.warm = null; } }, 2000) : 0;
        try {
          r = await call("bg", { op: "run", bitmap, opts: { hq: t.hq, big: !!t.big, lowMem: t.small } }, [bitmap], (p) => {
            alive = performance.now();
            if (p.stage === "hq") bgProgress("Detail pass…", p.f);
            else if (p.stage === "refine") bgProgress("Refining edges…", p.f ?? null);
          });
        } finally { clearInterval(dog); }
        used = t;
        break;
      } catch (e) {
        if (job.cancelled) return;
        lastErr = e;
        console.warn("bg: attempt failed", t, e);
        // the next try starts in a fresh worker: a WebAssembly heap never shrinks, so after an
        // out-of-memory failure the same worker can't even load the smaller model
        kill("bg"); rb.warm = null;
        if (/isn't installed|download/i.test(e.message)) break; // a missing or broken download won't get better
      }
    }
    if (job.cancelled) return;
    if (!r) { endBg(); toast(`Couldn't remove the background: ${lastErr?.message || "unknown error"}`, { bad: true }); syncFoot(); return; }
    try {
      if (doc !== d) { r.mask.close(); r.color?.close(); endBg(); return; }
      const cur = doc.layers.find((x) => x.id === layerId);
      if (!cur || (cur.preBg || cur.canvas) !== src) { r.mask.close(); r.color?.close(); endBg(); toast("Layer changed. Try again", { bad: true }); return; }
      // the result covers the visible part; the rest of the layer (cropped away) counts as removed
      const W = src.width, H = src.height, ox = reg ? reg.x : 0, oy = reg ? reg.y : 0;
      const mc = blank(W, H);
      mc.getContext("2d").drawImage(r.mask, ox, oy);
      r.mask.close();
      if (reg) {
        const full = new Uint8Array(W * H);
        for (let y = 0; y < r.h; y++) full.set(r.alpha.subarray(y * r.w, (y + 1) * r.w), (y + oy) * W + ox);
        r.alpha = full;
      }
      let fixed = null;
      if (r.color) {
        fixed = blank(W, H);
        const fg = fixed.getContext("2d");
        if (reg) { fg.drawImage(src, 0, 0); fg.clearRect(ox, oy, r.w, r.h); }
        fg.drawImage(r.color, ox, oy);
        r.color.close();
      }
      const prevTool = tool;
      const did = record(used.q === "fast" ? "Remove background" : `Remove background (${QUALITIES.find((x) => x[0] === used.q)?.[1].toLowerCase() || used.q})`, () => {
        Object.assign(cur, { mask: mc, maskBase: r.alpha, maskOn: true, maskShift: 0, maskSoft: 0 });
        if (fixed) { cur.preBg = src; cur.bgFixed = fixed; cur.canvas = fixed; }
        else { if (cur.preBg) cur.canvas = cur.preBg; delete cur.preBg; delete cur.bgFixed; }
      });
      // the remover switches to the mask tool below; undo goes back to the tool the user had, redo
      // to the mask tool again (otherwise undo leaves "Refine mask" open on a layer without a mask)
      if (did && prevTool !== "mask") {
        const e = hist[hi - 1], u = e.undo, rd = e.redo;
        e.undo = () => { u(); if (tool === "mask") setTool(prevTool); };
        e.redo = () => { rd(); if (tool !== "mask") setTool("mask"); };
      }
      const ms = performance.now() - job.t0;
      stats.bg = { ...r.ms, ep: r.ep, init: ini, wall: Math.round(ms), w: r.w, h: r.h, quality: used.q, model: used.model, fellBack: used.q !== quality || used.ep !== tries[0].ep };
      // remember this device's speed for the estimates (worker time: model + edges, per megapixel)
      try {
        const mp = (r.w * r.h) / 1e6, base = r.ms.infer;
        if (r.ep === "webgpu" || bgEp() === "wasm") rb.speed[used.q] = { base, perMP: Math.max(0, r.ms.total - base) / Math.max(0.05, mp) };
        localStorage.setItem("quickcut.photo.bgspeed", JSON.stringify(rb.speed));
      } catch {}
      endBg();
      syncFoot();
      if (tool !== "mask") setTool("mask");
      const note = used.q !== quality ? ` (${QUALITIES.find((x) => x[0] === quality)[1]} didn't fit this device, so Fast was used)` : "";
      toast(`Background removed · ${(ms / 1000).toFixed(1)} s${note}`, { ms: 6000, action: "Undo", onAction: undo });
      if (epPref() !== "wasm" && r.ep === "wasm" && rb.st?.gpu?.webgpu && !rb.cpuHinted) {
        rb.cpuHinted = true;
        setTimeout(() => toast("GPU failed · ran on CPU", { info: true, ms: 8000, action: "Always CPU", onAction: () => { setEp("wasm"); toast("AI runs on CPU", { info: true, ms: 2000 }); } }), 1200);
      }
    } catch (e) {
      endBg();
      toast(`Couldn't remove the background: ${e.message}`, { bad: true });
    }
  }
  /** A colour or a blurred copy of the photo under the cut-out (a normal layer named "Backdrop …"). */
  function setBackdrop(l, kind, value) {
    if (!l) return;
    const old = doc.layers.find((x) => x.backdropFor === l.id);
    if (kind === "none") { if (old) record("Remove backdrop", () => { doc.layers = doc.layers.filter((x) => x !== old); doc.sel = l.id; }); return; }
    const c = blank(doc.w, doc.h), g = c.getContext("2d");
    if (kind === "color") { g.fillStyle = value; g.fillRect(0, 0, doc.w, doc.h); }
    else {
      // blur by scaling down and back up (GPU, works in every browser); `value` = strength 1…100
      const src = l.preBg || l.canvas, f = Math.max(2, Math.round(2 + value / 3));
      const sw = Math.max(1, Math.round(src.width / f)), sh = Math.max(1, Math.round(src.height / f));
      const small = blank(sw, sh), sg = small.getContext("2d");
      sg.imageSmoothingQuality = "high";
      sg.drawImage(src, 0, 0, sw, sh);
      const tiny = blank(Math.max(1, sw >> 2), Math.max(1, sh >> 2)), tg = tiny.getContext("2d");
      tg.imageSmoothingQuality = "high";
      tg.drawImage(small, 0, 0, tiny.width, tiny.height);
      sg.clearRect(0, 0, sw, sh);
      sg.drawImage(tiny, 0, 0, sw, sh);
      g.imageSmoothingQuality = "high";
      const A = lm(l);
      g.setTransform(A[0], A[1], A[2], A[3], A[4], A[5]);
      g.drawImage(small, 0, 0, src.width, src.height);
    }
    const name = kind === "color" ? "Backdrop colour" : "Backdrop blur";
    record(name, () => {
      if (old) doc.layers = doc.layers.filter((x) => x !== old);
      const at = doc.layers.findIndex((x) => x.id === l.id);
      const nl = newLayer({ name, named: true, kind: "image", canvas: c, backdropFor: l.id, backdrop: { kind, value }, parent: l.parent ?? null });
      doc.layers.splice(at, 0, nl);
      doc.layers[0].clip = false;
      doc.sel = l.id;
    });
  }
  async function openEdge(anchor) {
    const l = selLayer();
    if (!l?.mask) return;
    try { await bgStatus(MODEL_OF[pickQuality()]); } catch {}
    if (selLayer() !== l) return;
    const max = Math.max(4, Math.round(Math.max(l.canvas.width, l.canvas.height) / 200));
    const el = h(`<section class="ph-pop" role="dialog" aria-label="Mask edge">
      <div class="pop-head"><span class="pop-title">Edge</span><button class="ib" type="button" data-e="close" aria-label="Close">${icon("x")}</button></div>
      <label class="field-label"><span class="row-between">Shift edge<span class="v" data-v="shift">${l.maskShift || 0} px</span></span><input class="slider neutral" type="range" min="${-max}" max="${max}" step="1" value="${l.maskShift || 0}" data-default="0" data-e="shift" aria-label="Shift edge" autofocus></label>
      <label class="field-label"><span class="row-between">Softness<span class="v" data-v="soft">${l.maskSoft || 0} px</span></span><input class="slider" type="range" min="0" max="${max}" step="0.5" value="${l.maskSoft || 0}" data-default="0" data-e="soft" aria-label="Softness"></label>
      ${l.preBg ? `<label class="switch"><input type="checkbox" data-e="clean" ${l.canvas === l.bgFixed ? "checked" : ""}><span class="track"></span>Clean edge colours</label>` : ""}
      ${qualitySeg()}
      <button class="btn-2 big" type="button" data-e="redo">${icon("target")}Run again</button>
      <button class="btn-g big" type="button" data-e="del">${icon("trash")}Delete mask</button>
    </section>`);
    for (const s of el.querySelectorAll(".slider")) syncSlider(s);
    bindQuality(el);
    el.append(storedRows(el));
    let t = 0;
    const vals = () => [+el.querySelector('[data-e="shift"]').value, +el.querySelector('[data-e="soft"]').value];
    el.addEventListener("input", (e) => {
      const n = e.target.dataset.e;
      if (n !== "shift" && n !== "soft") return;
      const [sh, so] = vals();
      el.querySelector(`[data-v="${n}"]`).textContent = `${n === "shift" ? sh : so} px`;
      clearTimeout(t);
      t = setTimeout(() => setMaskEdges(selLayer(), sh, so), 90);
    });
    el.addEventListener("change", (e) => {
      const n = e.target.dataset.e;
      if (n === "clean") { setCleanEdges(selLayer(), e.target.checked); return; }
      if (n !== "shift" && n !== "soft") return;
      clearTimeout(t);
      const [sh, so] = vals();
      setMaskEdges(selLayer(), sh, so).then(() => { endEdit("Edge"); changed(); });
    });
    const L = openLayer(el, { anchor, width: 300, reopen: false });
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-e]");
      if (!b) return;
      if (b.dataset.e === "close") L.close();
      if (b.dataset.e === "redo") { L.close(); removeBackground(); }
      if (b.dataset.e === "del") { L.close(); deleteMask(selLayer()); }
    });
  }
  function openBackdrop(anchor) {
    const l = selLayer();
    if (!l) return;
    const cur = doc.layers.find((x) => x.backdropFor === l.id)?.backdrop || { kind: "none" };
    const cv0 = cur.kind === "color" ? cur.value : rb.color, bv0 = cur.kind === "blur" ? cur.value : 40;
    const el = h(`<section class="ph-pop" role="dialog" aria-label="New background">
      <div class="pop-head"><span class="pop-title">New background</span><button class="ib" type="button" data-k="close" aria-label="Close">${icon("x")}</button></div>
      <div class="seg fill" role="radiogroup" aria-label="Background">${[["none", "Transparent"], ["color", "Colour"], ["blur", "Blur"]].map(([k2, n]) => `<button type="button" role="radio" data-k="${k2}" aria-checked="${cur.kind === k2}"${cur.kind === k2 ? " autofocus" : ""}>${n}</button>`).join("")}</div>
      <div class="row-between" data-row="color" ${cur.kind === "color" ? "" : "hidden"}>Colour<label class="ph-swatch" style="background:${cv0}"><input type="color" data-k="cval" value="${cv0}" aria-label="Background colour"></label></div>
      <label class="field-label" data-row="blur" ${cur.kind === "blur" ? "" : "hidden"}><span class="row-between">Blur<span class="v" data-v="blur">${bv0}</span></span><input class="slider" type="range" min="1" max="100" value="${bv0}" data-default="40" data-k="bval" aria-label="Blur"></label>
    </section>`);
    for (const s of el.querySelectorAll(".slider")) syncSlider(s);
    const L = openLayer(el, { anchor, width: 300, reopen: false });
    const show = (k2) => { for (const r of el.querySelectorAll("[data-row]")) r.hidden = r.dataset.row !== k2; for (const b of el.querySelectorAll("[role=radio]")) b.setAttribute("aria-checked", String(b.dataset.k === k2)); };
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-k]");
      if (!b) return;
      if (b.dataset.k === "close") { L.close(); return; }
      show(b.dataset.k);
      setBackdrop(selLayer(), b.dataset.k, b.dataset.k === "color" ? el.querySelector('[data-k="cval"]').value.toUpperCase() : +el.querySelector('[data-k="bval"]').value);
    });
    el.addEventListener("change", (e) => {
      const k2 = e.target.dataset.k;
      if (k2 === "cval") { rb.color = e.target.value.toUpperCase(); e.target.parentElement.style.background = rb.color; setBackdrop(selLayer(), "color", rb.color); }
      if (k2 === "bval") setBackdrop(selLayer(), "blur", +e.target.value);
    });
    el.addEventListener("input", (e) => { if (e.target.dataset.k === "bval") el.querySelector('[data-v="blur"]').textContent = e.target.value; });
  }
  function setBgView(v) { rb.view = v; renderProps(); invalidate(true); }

  // ── fonts: every font installed on the computer ──────────────────────────
  // Chrome/Edge: queryLocalFonts() (asks once, needs a click). The exact face the user picks is
  // loaded on demand as a FontFace from the font file. Elsewhere: bundled + common families, and
  // any installed family can be typed by name (checked by measuring that it really renders).
  const COMMON = ["Inter", "JetBrains Mono", "Arial", "Helvetica", "Segoe UI", "system-ui", "Times New Roman", "Georgia", "Verdana", "Tahoma", "Trebuchet MS", "Courier New", "Impact", "Comic Sans MS", "Calibri", "Cambria", "Garamond", "Palatino Linotype"];
  const STD_STYLES = [["Regular", 400, false], ["Italic", 400, true], ["Medium", 500, false], ["Semibold", 600, false], ["Bold", 700, false], ["Bold Italic", 700, true], ["Light", 300, false], ["Black", 900, false]];
  let localFams = null; // Map family → [{style, weight, italic, ps, data}]
  const faceAlias = new Map(); // postscript name → loaded FontFace family alias
  const FONT_RECENT = "quickcut.photo.fonts";
  const recentFonts = () => { try { return JSON.parse(localStorage.getItem(FONT_RECENT) || "[]"); } catch { return []; } };
  const rememberFont = (f) => { try { localStorage.setItem(FONT_RECENT, JSON.stringify([f, ...recentFonts().filter((x) => x !== f)].slice(0, 8))); } catch {} };
  function styleOf(name) {
    const s = name.toLowerCase();
    const weight = /thin|hairline/.test(s) ? 100 : /extra ?light|ultra ?light/.test(s) ? 200 : /light/.test(s) ? 300 : /medium/.test(s) ? 500 : /semi ?bold|demi/.test(s) ? 600 : /extra ?bold|ultra ?bold/.test(s) ? 800 : /black|heavy/.test(s) ? 900 : /bold/.test(s) ? 700 : 400;
    return { weight, italic: /italic|oblique/.test(s) };
  }
  async function loadLocalFonts(quiet = false) {
    if (localFams || !window.queryLocalFonts) return localFams;
    try {
      const list = await queryLocalFonts();
      localFams = new Map();
      for (const f of list) {
        const arr = localFams.get(f.family) || [];
        arr.push({ style: f.style, ps: f.postscriptName, data: f, ...styleOf(f.style) });
        localFams.set(f.family, arr);
      }
      for (const arr of localFams.values()) arr.sort((a, b) => a.italic - b.italic || a.weight - b.weight);
    } catch { localFams = null; if (!quiet) toast("No font access", { bad: true }); }
    return localFams;
  }
  /** CSS font-family list for a text layer's font (the exact loaded face when there is one). */
  const famCss = (t) => (t.ps && faceAlias.has(t.ps) ? `"${faceAlias.get(t.ps)}"` : `"${(t.font || "Inter").replace(/"/g, "")}", Inter, sans-serif`);
  const fontCss = (t, size) => `${t.italic && !(t.ps && faceAlias.has(t.ps)) ? "italic " : ""}${t.ps && faceAlias.has(t.ps) ? 400 : t.weight} ${size}px ${famCss(t)}`;
  async function loadFace(st) {
    if (!st?.ps || faceAlias.has(st.ps) || !st.data) return;
    try {
      const alias = `qc-${st.ps}`;
      const face = new FontFace(alias, await (await st.data.blob()).arrayBuffer());
      await face.load();
      document.fonts.add(face);
      faceAlias.set(st.ps, alias);
    } catch {}
  }
  /** Is this family really installed? Compare its width with two different fallbacks. */
  function installed(family) {
    const m = new OffscreenCanvas(1, 1).getContext("2d"), s = "mmmmmmmmmmlliWW@#1", w = (f) => { m.font = `72px ${f}`; return m.measureText(s).width; };
    return ["monospace", "serif"].some((fb) => Math.abs(w(`"${family}", ${fb}`) - w(fb)) > 0.5);
  }
  function stylesFor(family) {
    const arr = localFams?.get(family);
    return arr?.length ? arr.map((x) => ({ style: x.style, weight: x.weight, italic: x.italic, ps: x.ps, data: x.data })) : STD_STYLES.map(([style, weight, italic]) => ({ style, weight, italic, ps: null }));
  }
  async function applyFont(family, st) {
    rememberFont(family);
    if (st?.ps) await loadFace(st);
    const t = { font: family, weight: st?.weight ?? textOpts.weight, italic: !!st?.italic, ps: st?.ps || null, style: st?.style || "Regular" };
    Object.assign(textOpts, t);
    const l = selLayer();
    if (l?.kind === "text") {
      if (editing?.layer === l) { l.text = { ...l.text, ...t }; renderText(l); styleTA(); invalidate(true); }
      else record("Font", () => { l.text = { ...l.text, ...t }; renderText(l); });
    }
    renderProps();
    savePrefs();
  }
  function openFonts(anchor) {
    const cur = (selLayer()?.kind === "text" ? selLayer().text : textOpts).font || "Inter";
    const el = h(`<section class="ph-pop ph-fonts" role="dialog" aria-label="Font">
      <label class="field"><input type="search" placeholder="Search fonts" aria-label="Search fonts" spellcheck="false"></label>
      ${window.queryLocalFonts && !localFams ? `<button class="btn-p" type="button" data-f="local" title="All fonts">${icon("layers")}Use fonts on this computer</button>` : ""}
      <div class="fl" role="listbox" aria-label="Fonts"><div class="sp"></div></div>
      <div class="row-between"><span>Style</span><select data-f="style" aria-label="Style"></select></div>
      <div class="wh"><label class="field"><input type="text" data-f="typed" placeholder="Type a font name" aria-label="Type a font name" spellcheck="false"></label><button class="btn-2" type="button" data-f="use">Use</button></div>
    </section>`);
    const list = el.querySelector(".fl"), sp = el.querySelector(".sp"), search = el.querySelector("input[type=search]"), styleSel = el.querySelector('[data-f="style"]');
    const ROW = 32;
    let items = [], chosen = cur;
    const families = () => {
      const all = localFams ? [...localFams.keys()].sort((a, b) => a.localeCompare(b)) : COMMON;
      const rec = recentFonts().filter((f) => !localFams || localFams.has(f) || COMMON.includes(f));
      const q2 = search.value.trim().toLowerCase();
      const pool = q2 ? all.filter((f) => f.toLowerCase().includes(q2)) : all;
      return q2 ? pool : [...rec.map((f) => ({ f, recent: true })), ...pool.filter((f) => !rec.includes(f)).map((f) => ({ f }))];
    };
    const norm = (x) => (typeof x === "string" ? { f: x } : x);
    const draw = () => {
      // virtual list: only the rows in view exist in the DOM
      const top = list.scrollTop, n = Math.ceil(list.clientHeight / ROW) + 2, start = Math.max(0, Math.floor(top / ROW) - 1);
      for (const r of [...list.querySelectorAll(".fr")]) r.remove();
      for (let i = start; i < Math.min(items.length, start + n); i++) {
        const it = items[i];
        const b = h(`<button class="fr" type="button" role="option"></button>`);
        b.textContent = it.f;
        b.style.top = `${i * ROW}px`;
        b.style.fontFamily = `"${it.f}", Inter, sans-serif`;
        b.setAttribute("aria-selected", String(it.f === chosen));
        if (it.recent) b.classList.add("recent");
        b.onclick = () => pickFamily(it.f);
        list.append(b);
      }
    };
    const refill = () => { items = families().map(norm); sp.style.height = `${items.length * ROW}px`; draw(); };
    const fillStyles = () => {
      const sts = stylesFor(chosen), t = selLayer()?.kind === "text" ? selLayer().text : textOpts;
      styleSel.replaceChildren(...sts.map((s0, i) => { const o = h(`<option></option>`); o.value = i; o.textContent = s0.style; if (s0.style === t.style || (!t.style && s0.weight === t.weight && s0.italic === !!t.italic)) o.selected = true; return o; }));
    };
    const pickFamily = (f) => {
      chosen = f;
      const sts = stylesFor(f), t = selLayer()?.kind === "text" ? selLayer().text : textOpts;
      const st = sts.find((s0) => s0.weight === t.weight && s0.italic === !!t.italic) || sts.find((s0) => s0.weight === 400 && !s0.italic) || sts[0];
      applyFont(f, st);
      fillStyles();
      draw();
    };
    list.addEventListener("scroll", draw, { passive: true });
    search.addEventListener("input", () => { list.scrollTop = 0; refill(); });
    styleSel.addEventListener("change", () => applyFont(chosen, stylesFor(chosen)[+styleSel.value]));
    el.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-f]");
      if (!b) return;
      if (b.dataset.f === "local") { b.disabled = true; if (await loadLocalFonts()) { b.remove(); refill(); fillStyles(); } else b.disabled = false; }
      if (b.dataset.f === "use") {
        const name = el.querySelector('[data-f="typed"]').value.trim();
        if (!name) return;
        if (!installed(name)) { toast(`“${name}” isn't installed on this computer.`, { bad: true }); return; }
        pickFamily(name);
      }
    });
    el.querySelector('[data-f="typed"]').addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.querySelector('[data-f="use"]').click(); } });
    const L = openLayer(el, { anchor, width: 300, reopen: false });
    if (L.toggledOff) return;
    refill();
    fillStyles();
    const i = items.findIndex((x) => x.f === cur);
    if (i > 4) list.scrollTop = (i - 3) * ROW;
    draw();
  }

  // ── text ──────────────────────────────────────────────────────────────────
  const textPad = (t) => Math.ceil(t.size * 0.12);
  function renderText(l) {
    const t = l.text, pad = textPad(t), lh = t.size * 1.25;
    const font = fontCss(t, t.size);
    const m = new OffscreenCanvas(1, 1).getContext("2d");
    m.font = font;
    const lines = t.str.split("\n");
    const widths = lines.map((s) => m.measureText(s).width);
    const w = Math.max(t.size * 0.5, ...widths) + pad * 2, hh = lines.length * lh + pad * 2;
    const c = blank(Math.ceil(w), Math.ceil(hh)), g = c.getContext("2d");
    g.font = font;
    g.fillStyle = t.color;
    g.textAlign = t.align;
    g.textBaseline = "alphabetic";
    const x = t.align === "center" ? c.width / 2 : t.align === "right" ? c.width - pad : pad;
    lines.forEach((s, i) => g.fillText(s, x, pad + i * lh + lh / 2 + ((FONT_ASC - FONT_DESC) / 2) * t.size));
    l.canvas = c;
  }
  function textGesture(p, e) {
    const [x, y] = toDoc(p);
    if (editing) {
      // a click away from the text being typed ends typing (a new text box takes another click)
      const l = editing.layer;
      if (onLayer(l, x, y)) return;
      commitText();
      return;
    }
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (l.kind === "text" && l.visible && onLayer(l, x, y)) {
        doc.sel = l.id;
        renderLayers();
        startText(l, false);
        return;
      }
    }
    commitPending();
    beginEdit();
    const t = { str: "", ...textOpts };
    const [snx, sny] = snapPoint(x, y, e, snapTargets(null));
    guides = null;
    const l = newLayer({ kind: "text", name: "Text", text: t, x: Math.round(snx), y: Math.round(sny - t.size * 0.62 - textPad(t)) });
    renderText(l);
    const [i, parent] = slot();
    l.parent = parent;
    doc.layers.splice(i, 0, l);
    doc.sel = l.id;
    renderLayers();
    startText(l, true);
  }
  function startText(l, isNew) {
    if (!isNew) { commitPending(); beginEdit(); }
    editing = { layer: l, isNew };
    ta.hidden = false;
    ta.value = l.text.str;
    styleTA();
    renderProps();
    requestAnimationFrame(() => { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); });
    invalidate(true);
  }
  function styleTA() {
    const l = editing?.layer;
    if (!l) return;
    const t = l.text, sc = view.z / zf, pad = textPad(t);
    Object.assign(ta.style, {
      left: `${(view.ox + l.x * view.z) / zf - 1}px`, top: `${(view.oy + l.y * view.z) / zf - 1}px`,
      width: `${l.canvas.width * sc + 2}px`, height: `${l.canvas.height * sc + 2}px`,
      font: fontCss(t, t.size * sc).replace(/px /, `px/${t.size * 1.25 * sc}px `),
      padding: `${pad * sc}px`, textAlign: t.align,
    });
  }
  function commitText() {
    if (!editing) return;
    const { layer: l, isNew } = editing;
    editing = null;
    ta.hidden = true;
    if (document.activeElement === ta) ta.blur();
    if (!l.text.str.trim()) {
      doc.layers = doc.layers.filter((x) => x !== l);
      normalize();
      if (!nodeOf(doc.sel)) doc.sel = doc.layers[doc.layers.length - 1]?.id;
      if (isNew) pendingBefore = null; else endEdit("Delete text");
    } else endEdit(isNew ? "Add text" : "Edit text");
    changed({ structure: true });
  }
  ta.addEventListener("input", () => {
    const l = editing?.layer;
    if (!l) return;
    l.text = { ...l.text, str: ta.value };
    if (!l.named) l.name = ta.value.split("\n")[0].trim().slice(0, 40) || "Text";
    renderText(l);
    styleTA();
    invalidate(true);
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || (e.key === "Enter" && mod(e))) { e.preventDefault(); e.stopPropagation(); commitText(); }
  });
  ta.addEventListener("blur", () => setTimeout(() => {
    if (editing && document.activeElement !== ta && !props.contains(document.activeElement)) commitText();
  }, 0));
  function setTextProp(key, val, live = false) {
    textOpts[key] = val;
    const l = selLayer();
    if (l?.kind !== "text") return;
    if (editing?.layer === l) { l.text = { ...l.text, [key]: val }; renderText(l); styleTA(); invalidate(true); return; }
    if (live) { beginEdit(); l.text = { ...l.text, [key]: val }; renderText(l); invalidate(true); return; }
    record("Text style", () => { l.text = { ...l.text, [key]: val }; renderText(l); });
  }

  // ── eyedropper ────────────────────────────────────────────────────────────
  const sbuf = buffers();
  sbuf.size(1, 1);
  function sample(p) {
    const [x, y] = toDoc(p);
    if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return null;
    const c = new OffscreenCanvas(1, 1).getContext("2d");
    composite(c, drawList(false, true), T(-Math.floor(x), -Math.floor(y)), sbuf, { smooth: false });
    const d = c.getImageData(0, 0, 1, 1).data;
    if (!d[3]) return null;
    return "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  function pick(p, done) {
    const c = sample(p);
    if (!c) return;
    picked = c;
    brush.color = c;
    textOpts.color = c;
    const sw = props.querySelector(".ph-pick");
    if (sw) { sw.querySelector(".hex").textContent = c; sw.querySelector(".ph-swatch").style.background = c; }
    else if (tool === "brush") renderProps();
    if (done) toast(`Picked ${c}`, { action: "Copy", onAction: () => copyText(c) });
  }

  // ── layers ────────────────────────────────────────────────────────────────
  function nextName() {
    const names = new Set(doc.layers.map((l) => l.name));
    let i = doc.layers.length, n;
    do n = `Layer ${i++}`; while (names.has(n));
    return n;
  }
  /** Where a new layer goes: above the selected layer (in its group), or at the top inside a selected group. */
  function slot() {
    const g = selGroup();
    if (g) { const ls = layersOf(g); return [idx(ls[ls.length - 1].id) + 1, g.id]; }
    const l = selLayer();
    return l ? [idx(l.id) + 1, l.parent ?? null] : [doc.layers.length, null];
  }
  function addLayer(l, label) {
    record(label, () => { const [i, parent] = slot(); l.parent = parent; doc.layers.splice(i, 0, l); doc.sel = l.id; });
    return doc.layers.find((x) => x.id === l.id);
  }
  /** Composite draw items (asDraw) with the document's groups (or `groups`) into a document-sized canvas. */
  function flatCanvas(list, groups = doc.groups, box = { x: 0, y: 0, w: doc.w, h: doc.h }) {
    const c = blank(box.w, box.h), b = buffers();
    b.size(box.w, box.h);
    composite(c.getContext("2d"), tree(list, groups), T(-box.x, -box.y), b);
    b.drop();
    return c;
  }
  /** A layer as a draw item; a smart layer drawn much smaller than its source comes from a reduced copy (no aliasing). */
  /** The pixels a layer shows: with its mask hidden, a background-removed layer shows the original
   *  photo (the cleaned edge colours only belong with the cut-out). */
  const shownPx = (l) => (l.mask && !l.maskOn && l.preBg && l.canvas === l.bgFixed ? l.preBg : l.canvas);
  const asDraw = (l, o = {}) => {
    const src = shownPx(l), m = lm(l), k0 = scaleOf(m), r = reduced(src, k0), mr = l.mask && l.maskOn ? reduced(l.mask, k0) : null;
    return { id: l.id, parent: l.parent ?? null, src, ...r, m, x: l.x, y: l.y, opacity: l.opacity, blend: l.blend, visible: l.visible, clip: l.clip, mask: l.mask && l.maskOn ? (mr || { src: l.mask }) : null, ...o };
  };
  /** Pixels covering some layers (what's outside the canvas too), or the canvas if that would be too big. */
  function mergeBox(ls) { const b = pxBox(unionBox(ls)); return tooBig(b.w, b.h) ? { x: 0, y: 0, w: doc.w, h: doc.h } : b; }
  /** Move node `n` (a layer, or a group with all its layers) into group `parent` (or the top), its layers going to index `at` of doc.layers as it is now. */
  function moveNode(n, parent, at) {
    const block = layersOf(n), set = new Set(block);
    const before = doc.layers.slice(0, at).filter((l) => !set.has(l)).length;
    const rest = doc.layers.filter((l) => !set.has(l));
    rest.splice(before, 0, ...block);
    doc.layers = rest;
    n.parent = parent;
  }
  /** Top end (in doc.layers) of a node's layers: inserting there puts something right above it. */
  const topOf = (n) => { const ls = layersOf(n); return idx(ls[ls.length - 1].id) + 1; };
  const nextGroupName = () => { const names = new Set(doc.groups.map((g) => g.name)); let i = 1; while (names.has(`Group ${i}`)) i++; return `Group ${i}`; };
  /** A deep copy of a group (new ids), placed right above it. */
  function dupGroup(g0) {
    const ids = new Map(), copyG = (g) => { const c = { ...g, id: seq++, name: g === g0 ? `${g.name} copy` : g.name }; ids.set(g.id, c.id); return c; };
    const groups = doc.groups.filter((g) => g === g0 || inside(g, g0.id)).map(copyG);
    for (const g of groups) if (ids.has(g.parent)) g.parent = ids.get(g.parent);
    const layers = layersOf(g0).map((l) => {
      const d = { ...l, id: seq++, parent: ids.get(l.parent) };
      mapPx(d, copyCanvas);
      delete d.backdropFor; delete d.backdrop;
      if (l.mask) { d.mask = copyCanvas(l.mask); d.maskBase = l.maskBase.slice(); }
      return d;
    });
    const at = topOf(g0);
    doc.groups.push(...groups);
    doc.layers.splice(at, 0, ...layers);
    return groups[0];
  }
  const layerOps = {
    new: () => addLayer(newLayer({ name: nextName(), canvas: blank(doc.w, doc.h) }), "New layer"),
    dup: () => {
      const g = selGroup();
      if (g) { record("Duplicate group", () => { doc.sel = dupGroup(g).id; multi.clear(); }); return; }
      const l = selLayer();
      if (!l) return;
      const d = { ...l, id: seq++, name: `${l.name} copy`, named: true };
      mapPx(d, copyCanvas);
      delete d.backdropFor; delete d.backdrop;
      if (l.mask) { d.mask = copyCanvas(l.mask); d.maskBase = l.maskBase.slice(); }
      addLayer(d, "Duplicate layer");
    },
    clip: () => { const n = selNode(); if (canClip(n)) record(n.clip ? "Release clipping mask" : "Clip to layer below", () => { n.clip = !n.clip; }); },
    // Ctrl+G: the selected layers and groups (with what's clipped to them) into a new group, where the topmost one was
    group: () => {
      const sel = selNodes().filter((n, _, all) => !all.some((m) => m !== n && m.group && inside(n, m.id)));
      if (!sel.length) return;
      const nodes = [...new Set(sel.flatMap((n) => (n.clip ? [n] : groupOf(n))))];
      const top = nodes.reduce((a, b) => (topOf(b) > topOf(a) ? b : a));
      record("Group layers", () => {
        const g = { id: seq++, group: true, name: nextGroupName(), opacity: 1, blend: "pass", visible: true, clip: false, parent: top.parent ?? null };
        const at = topOf(top), moving = new Set(nodes.flatMap(layersOf));
        const block = doc.layers.filter((l) => moving.has(l)), rest = doc.layers.filter((l) => !moving.has(l));
        rest.splice(doc.layers.slice(0, at).filter((l) => !moving.has(l)).length, 0, ...block);
        doc.layers = rest;
        for (const n of nodes) n.parent = g.id;
        doc.groups.push(g);
        doc.sel = g.id;
        multi.clear();
        collapsed.delete(g.id);
      });
    },
    // Ctrl+Shift+G: a selected group lets its contents go (where it was); a layer in a group leaves it (just above it)
    ungroup: () => {
      const g = selGroup(), l = selLayer();
      if (g) {
        const inner = kids(g.id);
        record("Ungroup", () => {
          for (const n of inner) n.parent = g.parent ?? null;
          doc.groups = doc.groups.filter((x) => x !== g);
          doc.sel = inner[inner.length - 1].id;
          multi.clear();
          for (const n of inner.slice(0, -1)) multi.add(n.id);
        });
      } else if (l && grp(l.parent)) {
        const p = grp(l.parent);
        record("Move out of group", () => { moveNode(l, p.parent ?? null, topOf(p)); l.clip = false; });
      }
    },
    merge: () => {
      const g = selGroup();
      if (g) {
        // Merge group: its layers composited on their own, as one layer with the group's opacity and mode
        record("Merge group", () => {
          const ls = layersOf(g), groups = doc.groups.map((x) => (x === g ? { ...x, parent: null, opacity: 1, blend: "normal", visible: true, clip: false } : x));
          const box = mergeBox(ls), c = flatCanvas(ls.map((l) => asDraw(l)), groups, box);
          const m = newLayer({ name: g.name, named: true, kind: "image", canvas: c, x: box.x, y: box.y, parent: g.parent ?? null, opacity: g.opacity, blend: g.blend === "pass" ? "normal" : g.blend, visible: g.visible, clip: g.clip });
          doc.layers.splice(idx(ls[0].id), ls.length, m);
          doc.sel = m.id;
        });
        return;
      }
      const up2 = selLayer(), lo = up2 && below(up2);
      if (!lo || lo.group) return;
      const i = idx(up2.id);
      record("Merge down", () => {
        // both clipped to the same base: merge them as plain layers (the result stays clipped to that base);
        // otherwise the lower layer is the upper one's base
        const box = mergeBox([lo, up2]);
        const c = flatCanvas([asDraw(lo, { parent: null, opacity: 1, blend: "normal", visible: true, clip: false }), asDraw(up2, { parent: null, clip: up2.clip && !lo.clip })], [], box);
        const m = dropMask({ ...lo, canvas: c, x: box.x, y: box.y, kind: "image" });
        delete m.text;
        for (const key of TF) delete m[key];
        doc.layers.splice(i - 1, 2, m);
        doc.sel = m.id;
      });
    },
    flatten: () => {
      if (doc.layers.length < 2 && !doc.groups.length) return;
      record("Flatten", () => {
        const c = flatCanvas(doc.layers.map((l) => asDraw(l)));
        const l = newLayer({ name: "Background", kind: "image", canvas: c });
        doc.layers = [l];
        doc.groups = [];
        doc.sel = l.id;
      });
    },
    del: () => {
      const n = selNode();
      if (!n || layersOf(n).length >= doc.layers.length) return;
      record(n.group ? "Delete group" : "Delete layer", () => {
        const s = sibs(n), i = s.indexOf(n), gone = new Set(layersOf(n));
        // deleting a base releases the nodes clipped to it
        if (!n.clip) for (let j = i + 1; j < s.length && s[j].clip; j++) s[j].clip = false;
        const next = s[i - 1] || s[i + 1] || grp(n.parent);
        doc.layers = doc.layers.filter((l) => !gone.has(l));
        if (n.group) doc.groups = doc.groups.filter((g) => g !== n);
        doc.sel = next && next !== n ? next.id : doc.layers[doc.layers.length - 1].id;
        multi.clear();
      });
    },
  };
  layerOps.bg = () => removeBackground();
  const FOOT = [["new", "New layer", "newLayer", "plus"], ["group", "Group", "group", "folder"], ["dup", "Duplicate", "duplicate", "dup"], ["clip", "Clip", "clip", "clip"], ["merge", "Merge down", "merge", "merge"], ["flatten", "Flatten", "flatten", "flatten"], ["del", "Delete layer", "delete", "trash"]];
  const footBtns = () => FOOT.map(([id, label, act, ic]) => `<button type="button" data-op="${id}" aria-label="${K.tip(label, act)}" title="${K.tip(label, act)}">${icon(ic)}</button>`).join("");
  lyFoot.innerHTML = footBtns();
  lyFoot.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && doc) { commitText(); layerOps[b.dataset.op](); } });
  function syncFoot() {
    const n = selNode(), l = selLayer(), g = selGroup();
    const f = (id, dis, title) => { const b = lyFoot.querySelector(`[data-op="${id}"]`); b.disabled = dis; if (title) { b.title = title; b.setAttribute("aria-label", title); } return b; };
    f("clip", !canClip(n), !canClip(n) ? "Clip" : K.tip(n.clip ? "Release clip" : "Clip", "clip")).setAttribute("aria-pressed", String(!!n?.clip));
    const lo = l && below(l);
    f("merge", g ? false : !lo || lo.group, K.tip(g ? "Merge group" : "Merge down", "merge"));
    f("flatten", doc.layers.length < 2 && !doc.groups.length);
    f("del", !n || layersOf(n).length >= doc.layers.length, K.tip(g ? "Delete group" : "Delete layer", "delete"));
    f("group", !n);
  }
  // ── Layers card: rows top-first, groups as folders (collapse, indent), clipping guide lines ──
  const collapsed = new Set(); // group ids shown closed (view state, not an undo step)
  const modesOf = (n) => (n.group ? [PASS, ...BLENDS] : BLENDS);
  const modeOf = (n) => modesOf(n).find((b) => b[0] === n.blend) || modesOf(n)[0];
  const isDefMode = (n) => n.blend === (n.group ? "pass" : "normal");
  const chipHtml = (n) => `<button class="bm${isDefMode(n) ? " def" : ""}" type="button" data-p="blend" aria-haspopup="menu" aria-expanded="false" aria-label="Blend mode: ${modeOf(n)[1]}" title="Blend mode: ${modeOf(n)[1]}"><span class="bl">${modeOf(n)[1]}</span></button>`;
  const opHtml = (n) => `<span class="op${n.opacity < 1 ? " show" : ""}" data-p="op" role="spinbutton" tabindex="0" aria-label="Opacity" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(n.opacity * 100)}" title="Opacity">${Math.round(n.opacity * 100)}%</span>`;
  function renderLayers() {
    if (!doc) return;
    for (const el of [card, cardBtn]) el.querySelector(".n").textContent = doc.layers.length;
    const rows = [], on = new Set([doc.sel, ...multi]);
    const selBases = new Set([...on].map(nodeOf).filter(Boolean).map(baseOf));
    const walk = (nodes, depth) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i].ref || nodes[i], up = nodes[i + 1] && (nodes[i + 1].ref || nodes[i + 1]), g = !!n.group, open = g && !collapsed.has(n.id);
        const base = !n.clip && !!up?.clip, top = n.clip && !up?.clip;
        const cls = `${n.clip ? " clipped" : ""}${top ? " cl-top" : ""}${base ? " clip-base" : ""}${(n.clip || base) && selBases.has(baseOf(n)) ? " grp-sel" : ""}${g ? " grp" : ""}`;
        rows.push(h(`<div class="ly-row${cls}${on.has(n.id) ? " sel" : ""}${n.visible ? "" : " off"}" role="listitem" data-id="${n.id}" aria-current="${on.has(n.id)}" style="--ind:${depth * 12}px"${g ? ` aria-expanded="${open}"` : ""}>
          ${n.clip ? `<span class="clip-ic" role="img" aria-label="Clipped to layer below" title="Clipped to layer below">${icon("clip", 14)}</span>` : ""}
          ${g ? `<button class="tw" type="button" aria-label="${open ? "Collapse" : "Expand"} ${esc(n.name)}" title="${open ? "Collapse" : "Expand"} (click)">${icon(open ? "chev" : "chevR", 12)}</button>` : ""}
          <button class="eye" type="button" aria-label="${n.visible ? "Hide" : "Show"} ${esc(n.name)}">${icon(n.visible ? "eye" : "eyeOff", 14)}</button>
          ${g ? `<span class="fd">${icon("folder", 16)}</span>` : n.kind === "text" ? `<span class="tg">T</span>` : `<canvas class="th"></canvas>`}
          ${n.mask ? `<button class="mk${n.maskOn ? "" : " off"}" type="button" aria-pressed="${!!n.maskOn}" aria-label="Layer mask ${n.maskOn ? "on" : "off"}" title="Layer mask">${icon(PI.mask, 14)}</button>` : ""}
          <span class="nm" title="Double-click to rename">${esc(n.name)}</span>${chipHtml(n)}${opHtml(n)}</div>`));
        if (open) walk(nodes[i].children, depth + 1);
      }
    };
    walk(tree(doc.layers, doc.groups), 0);
    lyList.replaceChildren(...rows);
    lyList.querySelector(".ly-row.sel")?.scrollIntoView({ block: "nearest" });
    drawThumbs();
    syncFoot();
  }
  // Layer thumbnails: each layer's pixels (with its mask) are scaled down once per pixel change and
  // kept small, so redrawing the Layers card (every undo, every change) never re-reads a big canvas.
  const thumbCache = new WeakMap(); // layer canvas → {key, c}
  function smallOf(l, s) {
    const px = shownPx(l);
    const key = `${s}|${verOf(px)}|${l.mask && l.maskOn ? `${verOf(l.mask)}|${thumbMaskId(l.mask)}` : "-"}`;
    const hit = thumbCache.get(px);
    if (hit && hit.key === key) return hit.c;
    const w = Math.max(1, Math.ceil(px.width * s)), hh = Math.max(1, Math.ceil(px.height * s));
    const c = hit?.c && hit.c.width === w && hit.c.height === hh ? hit.c : new OffscreenCanvas(w, hh), t = c.getContext("2d");
    t.globalCompositeOperation = "copy";
    t.imageSmoothingQuality = "high";
    // big layers: from their small mip level (already kept for the view) when there is one
    const src = levelFor(px, Math.max(s, 1e-6) * 1.5)?.src || px;
    t.drawImage(src, 0, 0, w, hh);
    if (l.mask && l.maskOn) { t.globalCompositeOperation = "destination-in"; t.drawImage(levelFor(l.mask, Math.max(s, 1e-6) * 1.5)?.src || l.mask, 0, 0, w, hh); }
    thumbCache.set(px, { key, c });
    return c;
  }
  const maskIds = new WeakMap();
  let maskIdSeq = 0;
  const thumbMaskId = (m) => { if (!maskIds.has(m)) maskIds.set(m, ++maskIdSeq); return maskIds.get(m); };
  function drawThumb(c, l, px) {
    const d = Math.round(px * (devicePixelRatio || 1));
    if (c.width !== d) { c.width = d; c.height = d; }
    const g = c.getContext("2d");
    g.clearRect(0, 0, d, d);
    const s = Math.min(d / doc.w, d / doc.h), ox = (d - doc.w * s) / 2, oy = (d - doc.h * s) / 2;
    g.save();
    g.fillStyle = "#3A3A3E";
    g.fillRect(ox, oy, doc.w * s, doc.h * s);
    g.beginPath(); g.rect(ox, oy, doc.w * s, doc.h * s); g.clip();
    const A = mul([s, 0, 0, s, ox, oy], lm(l));
    g.setTransform(A[0], A[1], A[2], A[3], A[4], A[5]);
    g.drawImage(smallOf(l, s * scaleOf(lm(l))), 0, 0, l.canvas.width, l.canvas.height);
    g.restore();
  }
  function drawThumbs() {
    if (!doc) return;
    for (const row of lyList.children) {
      const c = row.querySelector("canvas.th"), l = doc.layers.find((x) => x.id === +row.dataset.id);
      if (c && l) drawThumb(c, l, 24);
    }
    const pt = props.querySelector("canvas.lthumb"), l = selLayer();
    if (pt && l) drawThumb(pt, l, 20);
  }
  let thumbT = 0;
  const scheduleThumbs = () => { clearTimeout(thumbT); thumbT = setTimeout(drawThumbs, 180); };
  /** Shift+click in the list: every visible row between the active one and this one. */
  function rangeSelect(id) {
    const ids = [...lyList.children].map((r) => +r.dataset.id), a = ids.indexOf(doc.sel), b = ids.indexOf(id);
    if (a < 0 || b < 0 || a === b) { setSel(id); return; }
    const span = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
    multi.clear();
    for (const x of span) {
      let p = nodeOf(x)?.parent, nested = false;
      for (let i = 0; p != null && i < 64; i++, p = grp(p)?.parent) if (span.has(p)) { nested = true; break; }
      if (x !== doc.sel && !nested) multi.add(x);
    }
    renderLayers();
    renderProps();
  }
  function setSel(id) {
    if (!doc || doc.sel === id) return;
    commitText();
    commitPending();
    doc.sel = id;
    multi.clear();
    // update the rows in place (a drag may be starting on one of them)
    const selB = baseOf(selNode());
    for (const row of lyList.children) {
      const rid = +row.dataset.id, n = nodeOf(rid);
      row.classList.toggle("sel", rid === id);
      row.setAttribute("aria-current", String(rid === id));
      row.classList.toggle("grp-sel", !!n && (row.classList.contains("clipped") || row.classList.contains("clip-base")) && baseOf(n) === selB);
    }
    syncFoot();
    renderProps();
  }
  const rowNode = (el) => nodeOf(+el.closest(".ly-row").dataset.id);
  const rowOf = (id) => lyList.querySelector(`.ly-row[data-id="${id}"]`);
  /** Make a row's node part of the selection (a click on its controls), without dropping a multi-selection it is in. */
  const touchRow = (n) => { if (n.id !== doc.sel && !multi.has(n.id)) setSel(n.id); };
  // ── opacity in the row: drag to scrub (Shift: fine), wheel, click to type, double-click for 100%, touch: popover ──
  /** Live opacity change (0..100): updates the row's text and the canvas only. */
  function setOpacity(n, pct) {
    pct = clamp(Math.round(pct), 0, 100);
    n.opacity = pct / 100;
    doc.ver++;
    const el = rowOf(n.id)?.querySelector(".op");
    if (el && !el.querySelector("input")) { el.textContent = `${pct}%`; el.classList.toggle("show", pct < 100); el.setAttribute("aria-valuenow", pct); }
    invalidate(true);
    return pct;
  }
  let opPt = "mouse";
  lyList.addEventListener("pointerdown", (e) => {
    const op = e.target.closest(".op");
    if (!op || !doc || e.button !== 0 || e.target.tagName === "INPUT") return;
    const n = rowNode(op);
    if (!n) return;
    opPt = e.pointerType;
    touchRow(n);
    if (e.pointerType !== "mouse" || isPhone()) return; // touch: the click opens the popover
    commitPending();
    const x0 = e.clientX, v0 = Math.round(n.opacity * 100);
    let lastX = x0, acc = 0, moved = false;
    op.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      if (!moved) { moved = true; beginEdit(); op.classList.add("scrub"); }
      acc += (ev.clientX - lastX) * (ev.shiftKey ? 0.2 : 1);
      lastX = ev.clientX;
      const v = clamp(Math.round(v0 + acc), 0, 100);
      if (v !== Math.round(n.opacity * 100)) setOpacity(n, v);
    };
    const end = (ev) => {
      op.removeEventListener("pointermove", move);
      op.removeEventListener("pointerup", end);
      op.removeEventListener("pointercancel", end);
      op.classList.remove("scrub");
      if (moved) { endEdit("Opacity"); changed({ structure: true }); }
      else if (ev.type === "pointerup") editOpacity(op, n);
    };
    op.addEventListener("pointermove", move);
    op.addEventListener("pointerup", end);
    op.addEventListener("pointercancel", end);
    e.preventDefault();
  });
  function editOpacity(op, n) {
    if (op.querySelector("input")) return;
    commitPending();
    const input = h(`<input type="text" inputmode="numeric" maxlength="4" aria-label="Opacity, percent">`);
    input.value = Math.round(n.opacity * 100);
    op.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      input._finish = null;
      const v = parseFloat(input.value.replace(",", "."));
      if (ok && isFinite(v) && clamp(Math.round(v), 0, 100) !== Math.round(n.opacity * 100)) record("Opacity", () => { n.opacity = clamp(Math.round(v), 0, 100) / 100; });
      else if (op.isConnected) op.textContent = `${Math.round(n.opacity * 100)}%`;
    };
    input._finish = finish;
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); input.value = clamp((parseFloat(input.value) || 0) + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1), 0, 100); input.select(); }
    });
    input.addEventListener("blur", () => finish(true));
  }
  // keyboard on a focused value: arrows +/-1 (Shift: 10), Enter types
  lyList.addEventListener("keydown", (e) => {
    const op = e.target.closest?.(".op");
    if (!op || e.target.tagName === "INPUT" || !doc) return;
    const n = rowNode(op);
    if (!n) return;
    if (e.key === "Enter") { e.preventDefault(); editOpacity(op, n); return; }
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const id = n.id, v = clamp(Math.round(n.opacity * 100) + d * (e.shiftKey ? 10 : 1), 0, 100);
    record("Opacity", () => { n.opacity = v / 100; });
    rowOf(id)?.querySelector(".op")?.focus();
  });
  function openOpacityPop(anchor, n) {
    commitPending();
    const v0 = Math.round(n.opacity * 100);
    const el = h(`<section class="ph-pop ph-oppop" aria-label="Opacity"><div class="pop-head"><span class="pop-title">Opacity<span class="pop-sub">${esc(n.name)}</span></span><span class="num"><input type="text" inputmode="numeric" maxlength="3" value="${v0}" aria-label="Opacity, percent"><span class="unit">%</span></span></div>
      <input class="slider" type="range" min="0" max="100" step="1" value="${v0}" data-default="100" aria-label="Opacity">
      <div class="ph-opq">${[0, 25, 50, 75, 100].map((v) => `<button class="btn-2 big" type="button" data-v="${v}">${v}%</button>`).join("")}</div></section>`);
    const sl = el.querySelector(".slider"), num = el.querySelector(".num input");
    let began = false;
    const set = (v, from) => {
      v = clamp(Math.round(v) || 0, 0, 100);
      if (!began) { began = true; beginEdit(); }
      setOpacity(n, v);
      if (from !== "s") { sl.value = v; syncSlider(sl); }
      if (from !== "n") num.value = v;
    };
    sl.addEventListener("input", () => set(+sl.value, "s"));
    num.addEventListener("input", () => { if (num.value.trim() !== "") set(parseFloat(num.value), "n"); });
    num.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") lay.close(); });
    el.querySelector(".ph-opq").addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (b) set(+b.dataset.v); });
    const lay = openLayer(el, { anchor, width: 260, reopen: false, sheet: isPhone() || coarse(), onClose: () => { if (began) { endEdit("Opacity"); changed({ structure: true }); } } });
    syncSlider(sl);
  }
  // ── the row's actions (right-click, or a long press on touch) ──
  function openRowMenu(row, n) {
    if (!doc || !n) return;
    commitText();
    commitPending();
    touchRow(n);
    const off = (op) => !!lyFoot.querySelector(`[data-op="${op}"]`)?.disabled;
    const items = [
      ["rename", "Rename", false],
      ["vis", n.visible ? "Hide" : "Show", false],
      ["op", "Opacity…", false],
      ["blend", "Blend mode…", false],
      ["clip", n.clip ? "Release clipping mask" : "Clip to layer below", off("clip")],
      ["dup", "Duplicate", false],
      ["group", "Group", off("group")],
      ["merge", n.group ? "Merge group" : "Merge down", off("merge")],
      ["del", n.group ? "Delete group" : "Delete layer", off("del")],
    ];
    const el = h(`<div class="ph-menu" role="menu" aria-label="${esc(n.name)}"></div>`);
    for (const [id, label, dis] of items) {
      const b = h(`<button type="button" role="menuitem" data-a="${id}"${dis ? " disabled" : ""}></button>`);
      b.textContent = label;
      el.append(b);
    }
    const lay = openLayer(el, { anchor: row, width: 200, reopen: false, sheet: isPhone() || coarse() });
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-a]");
      if (!b || b.disabled) return;
      lay.close();
      const a = b.dataset.a, id = n.id;
      if (a === "rename") { const nm = rowOf(id)?.querySelector(".nm"); if (nm) rename(nm); }
      else if (a === "vis") record(`${n.visible ? "Hide" : "Show"} ${n.group ? "group" : "layer"}`, () => { n.visible = !n.visible; });
      else if (a === "op") { const o = rowOf(id)?.querySelector(".op"); if (o) openOpacityPop(o, n); }
      else if (a === "blend") { const o = rowOf(id)?.querySelector(".bm"); if (o) openBlendMenu(o, n); }
      else layerOps[a]();
    });
  }
  let lpAt = -1e9;
  lyList.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".ly-row");
    if (!row || !doc) return;
    e.preventDefault();
    if (e.target.closest("input")) return;
    if (performance.now() - lpAt < 900) return; // the long press already opened it
    openRowMenu(row, nodeOf(+row.dataset.id));
  });
  lyList.addEventListener("click", (e) => {
    if (!doc) return;
    const bm = e.target.closest(".bm");
    if (bm) { const n = rowNode(bm); if (n) { touchRow(n); openBlendMenu(bm, n); } return; }
    const opEl = e.target.closest(".op");
    if (opEl) {
      // touch / phone: a tap opens the slider popover (the mouse path starts on pointerdown)
      if (e.target.tagName !== "INPUT" && (opPt !== "mouse" || isPhone())) { const n = rowNode(opEl); if (n) openOpacityPop(opEl, n); }
      return;
    }
    const tw = e.target.closest(".tw");
    if (tw) { const g = rowNode(tw); if (g) { if (collapsed.has(g.id)) collapsed.delete(g.id); else collapsed.add(g.id); renderLayers(); saveSession(); } return; }
    const mk = e.target.closest(".mk");
    if (mk) {
      const l = rowNode(mk);
      if (!l) return;
      if (e.altKey) { setSel(l.id); if (tool !== "mask") setTool("mask"); setBgView(rb.view === "mask" ? "photo" : "mask"); return; }
      toggleMask(l);
      return;
    }
    const eye = e.target.closest(".eye");
    if (!eye) return;
    const n = rowNode(eye);
    if (n) record(`${n.visible ? "Hide" : "Show"} ${n.group ? "group" : "layer"}`, () => { n.visible = !n.visible; });
  });
  lyList.addEventListener("dblclick", (e) => {
    const op = e.target.closest(".op");
    if (op) {
      const n = rowNode(op);
      op.querySelector("input")?._finish?.(false);
      if (n && n.opacity !== 1) record("Opacity", () => { n.opacity = 1; });
      return;
    }
    const tg = e.target.closest(".tg");
    if (tg) { const l = rowNode(tg); if (l?.kind === "text") { setTool("text"); setSel(l.id); startText(l, false); } return; }
    const nm = e.target.closest(".nm");
    if (nm) rename(nm);
  });
  function rename(nm) {
    const l = rowNode(nm);
    if (!l) return;
    const input = h(`<input type="text" aria-label="${l.group ? "Group" : "Layer"} name">`);
    input.value = l.name;
    nm.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (ok && v && v !== l.name) record(l.group ? "Rename group" : "Rename layer", () => { l.name = v; l.named = true; });
      else renderLayers();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }
  // select, Alt-click to clip, drag to reorder: between rows, or onto a group's row to put it inside
  lyList.addEventListener("pointerdown", (e) => {
    const row = e.target.closest(".ly-row");
    if (!row || !doc || e.button !== 0 || e.target.closest(".eye, .mk, .tw, .op, .bm, input")) return;
    const id = +row.dataset.id, mv = nodeOf(id);
    if (!mv) return;
    if (e.altKey) {
      if (canClip(mv)) record(mv.clip ? "Release clipping mask" : "Clip to layer below", () => { mv.clip = !mv.clip; });
      return;
    }
    if (e.ctrlKey || e.metaKey) { toggleInSelection(mv); invalidate(); return; }
    if (e.shiftKey) { rangeSelect(id); invalidate(); return; }
    setSel(id);
    explicitPick = id;
    invalidate();
    const y0 = e.clientY;
    let started = false, drop = null, into = null, lpT = 0;
    if (e.pointerType !== "mouse") lpT = setTimeout(() => { // long press: the row's actions
      lpT = 0;
      if (started) return;
      lpAt = performance.now();
      end();
      openRowMenu(row, mv);
    }, 480);
    const rows = [...lyList.children].filter((r) => r.classList.contains("ly-row")), nodes = rows.map((r) => nodeOf(+r.dataset.id));
    const off = (n) => !n || n === mv || covers(mv, n); // the dragged node and what's inside it
    const depth = (r) => parseFloat(r.style.getPropertyValue("--ind")) / 12 || 0;
    // While dragging, the row (with everything inside it) lifts and follows the pointer, the other rows
    // slide apart to open a gap where it will land (indented to the level it will land at), and a
    // group's row lights up when the drop goes inside it. Hit-testing uses the rows' positions from
    // the start of the drag, so the sliding never feeds back into where the drop goes.
    let ghost = null, slot = null, lastEv = null, scrollRaf = 0, grabDy = 0, cancelled = false, lay = null, shown = [];
    const measure = () => {
      const lr = lyList.getBoundingClientRect(), z = lr.width / lyList.offsetWidth || 1, st = lyList.scrollTop;
      const tops = [], hts = [];
      for (const r of rows) { const b = r.getBoundingClientRect(); tops.push((b.top - lr.top) / z + st); hts.push(b.height / z); }
      const block = rows.map((r, i) => i).filter((i) => nodes[i] && off(nodes[i]));
      const bTop = tops[block[0]], bEnd = tops[block.at(-1)] + hts[block.at(-1)];
      const gap = rows.length > 1 ? Math.max(0, tops[1] - tops[0] - hts[0]) : 2;
      const bH = bEnd - bTop + gap;
      const others = rows.map((r, i) => i).filter((i) => !block.includes(i));
      const vt = others.map((i) => tops[i] - (tops[i] > bTop ? bH : 0));
      shown = others.map((i) => tops[i]); // where each other row is drawn right now
      return { tops, hts, block, others, vt, bH, z, gap };
    };
    const onKey = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancelled = true; end(); } };
    const start = (ev) => {
      started = true;
      lay = measure();
      const rr = row.getBoundingClientRect(), z = lay.z;
      grabDy = (ev.clientY - rr.top) / z;
      ghost = h(`<div class="ly-ghost" aria-hidden="true"></div>`);
      for (const i of lay.block) {
        const c = rows[i].cloneNode(true), src = rows[i].querySelectorAll("canvas"), dst = c.querySelectorAll("canvas");
        dst.forEach((d, k) => { try { d.getContext("2d").drawImage(src[k], 0, 0); } catch {} });
        ghost.append(c);
      }
      ghost.style.width = `${rr.width / z}px`;
      ghost.style.left = `${rr.left / z}px`;
      document.body.append(ghost);
      for (const i of lay.block) rows[i].classList.add("drag-src");
      lyList.classList.add("dragging");
      document.documentElement.classList.add("ly-dragging");
      slot = h(`<span class="ly-slot" aria-hidden="true"></span>`);
      lyList.append(slot);
      addEventListener("keydown", onKey, true);
      scrollRaf = requestAnimationFrame(autoScroll);
    };
    // near the list's top or bottom edge the list scrolls, faster the closer the pointer is
    const autoScroll = () => {
      scrollRaf = 0;
      if (!started || !lastEv) return;
      const lr = lyList.getBoundingClientRect(), edge = 28 * lay.z;
      const dy = lastEv.clientY < lr.top + edge ? -(lr.top + edge - lastEv.clientY) : lastEv.clientY > lr.bottom - edge ? lastEv.clientY - (lr.bottom - edge) : 0;
      if (dy) { const before = lyList.scrollTop; lyList.scrollTop += Math.max(-14, Math.min(14, dy / 2)); if (lyList.scrollTop !== before) place(lastEv); }
      scrollRaf = requestAnimationFrame(autoScroll);
    };
    const place = (ev) => {
      const { tops, hts, others, vt, bH, z } = lay;
      const lr = lyList.getBoundingClientRect(), py = (ev.clientY - lr.top) / z + lyList.scrollTop;
      ghost.style.top = `${ev.clientY / z - grabDy}px`;
      into?.classList.remove("drop-in");
      into = null;
      // onto the middle of a group's row: into that group (at its top); no gap opens
      // hit-testing follows the rows where the user sees them (they slide while dragging)
      const hit = others.findIndex((i, k) => py >= shown[k] + hts[i] * 0.3 && py <= shown[k] + hts[i] * 0.7);
      let s;
      if (hit >= 0 && nodes[others[hit]]?.group && !off(nodes[others[hit]])) {
        into = rows[others[hit]];
        into.classList.add("drop-in");
        drop = { parent: nodes[others[hit]].id, at: topOf(nodes[others[hit]]) };
        s = -1;
      } else {
        s = others.filter((i, k) => shown[k] + hts[i] / 2 < py).length;
        const upI = others[s - 1], dnI = others[s], up = nodes[upI], dn = nodes[dnI];
        // between a deeper row (above) and a shallower one (below): the pointer's x picks the level
        const deep = up && (dnI === undefined || depth(rows[upI]) > depth(rows[dnI])) && !(up.group && !collapsed.has(up.id)) && (ev.clientX - lr.left) / z > 24 + depth(rows[upI]) * 12;
        if (deep) drop = { parent: up.parent ?? null, at: idx(layersOf(up)[0].id), ind: depth(rows[upI]) };
        else if (dn) drop = { parent: dn.parent ?? null, at: topOf(dn), ind: depth(rows[dnI]) };
        else drop = { parent: null, at: 0, ind: 0 };
      }
      // slide the other rows: the dragged rows' space closes, a gap opens at the drop (none when into a group)
      others.forEach((i, k) => {
        const shift = vt[k] - tops[i] + (s >= 0 && k >= s ? bH : 0);
        rows[i].style.transform = shift ? `translateY(${shift}px)` : "";
        shown[k] = tops[i] + shift;
      });
      if (s >= 0) {
        const gapTop = s < others.length ? shown[s] - bH : others.length ? shown[others.length - 1] + hts[others.at(-1)] + lay.gap : 0;
        slot.hidden = false;
        slot.style.top = `${gapTop}px`;
        slot.style.height = `${bH - lay.gap}px`;
        slot.style.left = `${4 + (drop.ind || 0) * 12}px`;
      } else slot.hidden = true;
    };
    const move = (ev) => {
      if (!started && Math.abs(ev.clientY - y0) < 5) return;
      if (lpT) { clearTimeout(lpT); lpT = 0; }
      if (!started) start(ev);
      lastEv = ev;
      place(ev);
    };
    const end = () => {
      if (lpT) { clearTimeout(lpT); lpT = 0; }
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      removeEventListener("keydown", onKey, true);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (!started) return;
      started = false;
      ghost?.remove();
      slot?.remove();
      into?.classList.remove("drop-in");
      for (const r of rows) { r.style.transform = ""; r.classList.remove("drag-src"); }
      lyList.classList.remove("dragging");
      document.documentElement.classList.remove("ly-dragging");
      if (cancelled || !drop || (drop.parent != null && (drop.parent === mv.id || inside(grp(drop.parent), mv.id)))) return;
      const baseId = mv.clip ? baseOf(mv).id : null, n = doc.layers.length;
      record(drop.parent !== (mv.parent ?? null) ? (drop.parent == null ? "Move out of group" : "Move into group") : "Reorder layers", () => {
        moveNode(mv, drop.parent, drop.at);
        normalize();
        // dropped inside a clipping group (a clipped node right above it) → clipped; dropped outside its group → released
        const s = sibs(mv), i = s.indexOf(mv), above = s[i + 1], lower = s[i - 1];
        if (above?.clip) mv.clip = true;
        else if (mv.clip && !(lower && (lower.clip || lower.id === baseId))) mv.clip = false;
        if (doc.layers.length !== n) throw new Error("reorder");
      });
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
  });
  // card: collapse on desktop, open/close on tablets, sheet on phones
  card.querySelector(".head").addEventListener("click", () => {
    if (matchMedia("(max-width: 1199px)").matches) { card.classList.remove("open"); cardBtn.setAttribute("aria-expanded", "false"); return; }
    const c = card.classList.toggle("collapsed");
    savePrefs();
    card.querySelector(".head").setAttribute("aria-expanded", String(!c));
  });
  cardBtn.addEventListener("click", () => { card.classList.add("open"); cardBtn.setAttribute("aria-expanded", "true"); drawThumbs(); });
  function openLayersSheet() {
    const el = h(`<section class="ph-pop" aria-label="Layers"><div class="pop-head"><span class="pop-title">Layers</span><button class="ib" type="button" aria-label="Close">${icon("x")}</button></div></section>`);
    el.append(lyBody);
    const L = openLayer(el, { sheet: true, reopen: false, onClose: () => { card.append(lyBody); } });
    el.querySelector(".pop-head .ib").onclick = () => L.close();
    drawThumbs();
  }

  // ── properties bar ────────────────────────────────────────────────────────
  const sliderRow = (label, p, min, max, val, txt, w = 88, def = max) =>
    `<label class="lbl">${label}<input class="slider" type="range" min="${min}" max="${max}" step="1" value="${val}" data-default="${def}" data-p="${p}" aria-label="${label}" style="width:${w}px"><span class="val" data-v="${p}">${txt}</span></label>`;
  const sizeToSlider = (s) => Math.round(Math.sqrt((s - 1) / 999) * 100);
  const sliderToSize = (v) => Math.max(1, Math.round(1 + 999 * (v / 100) ** 2));
  /** "37%" / "50 × 80%" and the rotation of a smart layer. */
  function tfLabel(l) {
    const [a, b, c, d] = lin(l), s1 = Math.hypot(a, b), s2 = Math.hypot(c, d), pc = (v) => +(v * 100).toFixed(v < 0.1 ? 1 : 0);
    const rot = (Math.atan2(b, a) * 180) / Math.PI, flip = a * d - b * c < 0;
    const txt = `${Math.abs(s1 - s2) < 1e-3 ? `${pc(s1)}%` : `${pc(s1)} × ${pc(s2)}%`}${Math.abs(rot) > 0.05 ? ` · ${+rot.toFixed(1)}°` : ""}${flip ? " · flipped" : ""}`;
    return `<span class="small">${txt}</span>`;
  }
  function renderProps() {
    if (!doc) return;
    if (props.contains(document.activeElement) && document.activeElement.tagName === "INPUT" && document.activeElement.type !== "range") return;
    const mode = crop ? "crop" : tool;
    props = crop ? ppAll[0] : ppAll[1];
    let html = "";
    if (mode === "crop") {
      html = `<span class="grp"><button class="btn-2 ph-aspect" type="button" data-p="aspect" aria-haspopup="menu" aria-expanded="false" aria-label="Aspect ratio: ${esc(crop.preset)}" title="Aspect ratio"><span class="v">${esc(crop.preset)}</span>${icon("chev", 12)}</button></span>
        <span class="grp" role="group" aria-label="Rotate and flip">
        <button class="ib" type="button" data-p="rot" aria-label="${K.tip("Rotate 90°", "rotate")}" title="${K.tip("Rotate 90°", "rotate")}">${icon("rotate")}</button>
        <button class="ib" type="button" data-p="fliph" aria-label="Flip horizontal" title="Flip horizontal">${icon("flipH")}</button>
        <button class="ib" type="button" data-p="flipv" aria-label="Flip vertical" title="Flip vertical">${icon("flipV")}</button>
        <label class="lbl ph-straighten" title="Straighten"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Straighten"><path d="M2 12.5h12M3.5 12.5L12 5M9.5 12.5a3 3 0 0 0-.8-2.1"/></svg><span class="ph-straight"><input class="slider neutral" type="range" min="-45" max="45" step="0.1" value="${crop.a}" data-default="0" data-p="angle" aria-label="Straighten"></span><span class="val" data-v="angle"></span></label></span>
        <span class="grp" role="group" aria-label="Size"><span class="ph-wh"><label>W<input type="text" inputmode="numeric" data-p="cw" aria-label="Crop width"></label><button class="ib" type="button" data-p="lock" aria-label="Keep aspect ratio" title="Keep aspect ratio">${icon("link", 14)}</button><label>H<input type="text" inputmode="numeric" data-p="ch" aria-label="Crop height"></label><span class="unit">px</span></span>
        ${snapBtn()}</span>
        <span class="grp end"><button class="btn-g" type="button" data-p="creset" title="Reset">Reset</button>
        <button class="btn-g desk-only" type="button" data-p="cancel" title="Cancel (Esc)">Cancel<span class="kbd">Esc</span></button>
        <button class="btn-p desk-only" type="button" data-p="apply" title="Apply (Enter)">Apply<span class="kbd">↵</span></button></span>`;
    } else if (mode === "move") {
      const l = selNode();
      html = l ? `<span class="grp"><span class="lname">${l.group ? `<span class="lthumb fd">${icon("folder", 16)}</span>` : l.kind === "text" ? `<span class="tg lthumb" style="display:inline-flex;align-items:center;justify-content:center;background:#3A3A3E;color:#fff;font:600 11px var(--font)">T</span>` : `<canvas class="lthumb"></canvas>`}<span>${l.kind === "text" && !l.named ? "Text layer" : esc(l.name)}</span></span></span>
        <span class="grp">${snapBtn()}</span>
        ${!l.group && !plain(l) ? `<span class="grp" role="group" aria-label="Transform">${tfLabel(l)}<button class="btn-g" type="button" data-p="tfreset" title="Reset transform">Reset</button><button class="btn-g" type="button" data-p="raster" title="Rasterize">Rasterize</button></span>` : ""}
        ${l.kind && l.kind !== "text" ? `<span class="grp end">${l.mask ? `<button class="btn-2" type="button" data-p="refine" title="${K.tip("Refine mask", "mask")}">${icon(PI.mask)}Refine mask</button>` : `<span class="ph-split"><button class="btn-2" type="button" data-p="rmbg" title="${K.tip("Remove background", "removeBg")}">${icon(PI.cutout)}Remove background</button><button class="btn-2 ph-caret" type="button" data-p="bgmenu" aria-haspopup="dialog" aria-label="AI model" title="AI model">${icon("chev")}</button></span>`}</span>` : ""}`
        : "";
    } else if (mode === "select") {
      html = `${noMods() ? `<span class="grp"><div class="seg ph-selmode" role="radiogroup" aria-label="Selection mode">${SEL_OPS.map(([id, label]) => `<button type="button" role="radio" data-sm="${id}" aria-checked="${selMode === id}" aria-label="${label}" title="${label}">${icon(PI[{ new: "selNew", add: "selAdd", sub: "selSub", int: "selInt" }[id]], 16)}</button>`).join("")}</div></span>` : ""}
        <span class="grp"><button class="btn-g" type="button" data-p="all" title="${K.tip("Select all", "selectAll")}">All</button>
        <button class="btn-g" type="button" data-p="desel" title="${K.tip("Deselect", "deselect")}" ${selection ? "" : "disabled"}>Deselect</button>
        <button class="btn-g" type="button" data-p="inv" title="${K.tip("Invert", "invert")}" ${selection ? "" : "disabled"}>Invert</button></span>
        <span class="grp"><button class="btn-g" type="button" data-p="tolayer" title="${K.tip("Copy to layer", "duplicate")}" ${selection ? "" : "disabled"}>Copy to layer</button>
        <button class="btn-g" type="button" data-p="clear" title="${K.tip("Clear", "delete")}" ${selection ? "" : "disabled"}>Clear</button></span>`;
    } else if (mode === "mask") {
      const l = selLayer(), has = !!l?.mask, o = maskBrush;
      const views = [["photo", "Photo", "Photo"], ["mask", "Mask", "Mask (\\)"], ["color", "Colour", "Colour"]];
      html = `<span class="grp"><div class="seg" role="radiogroup" aria-label="Brush">${[["keep", "Keep", K.tip("Keep", "keepRemove")], ["remove", "Remove", K.tip("Remove", "keepRemove")]].map(([id, n, t]) => `<button type="button" role="radio" data-mb="${id}" aria-checked="${o.mode === id}" title="${t}">${n}</button>`).join("")}</div></span>
        <span class="grp ph-sliders">${sliderRow("Size", "size", 0, 100, sizeToSlider(o.size), `${o.size} px`, 80, sizeToSlider(60))}
        ${sliderRow("Hardness", "hard", 0, 100, o.hard, `${o.hard}%`, 64, 70)}</span>
        <span class="grp"><div class="seg" role="radiogroup" aria-label="View">${views.map(([id, n, t]) => `<button type="button" role="radio" data-bv="${id}" aria-checked="${rb.view === id}" title="${t}">${n}</button>`).join("")}</div>
        ${rb.view === "color" ? `<label class="ph-swatch" title="View colour" style="background:${rb.viewColor}"><input type="color" data-p="viewcolor" value="${rb.viewColor}" aria-label="View colour"></label>` : ""}</span>
        <span class="grp"><button class="btn-g" type="button" data-p="maskinv" ${has ? "" : "disabled"} title="${K.tip("Invert mask", "invertMask")}">Invert</button>
        <button class="btn-2" type="button" data-p="edge" aria-haspopup="dialog" ${has ? "" : "disabled"} title="Edge">Edge${icon("chev", 12)}</button>
        <button class="btn-2" type="button" data-p="backdrop" aria-haspopup="dialog" title="Background">Background${icon("chev", 12)}</button>
        ${has ? `<label class="switch" title="Mask"><input type="checkbox" data-p="maskon" ${l.maskOn ? "checked" : ""}><span class="track"></span>Mask</label>` : ""}</span>
        ${has ? "" : `<span class="grp end"><button class="btn-p" type="button" data-p="rmbg" title="Remove background (Shift B)">${icon(PI.cutout)}Remove background</button></span>`}`;
    } else if (mode === "brush" || mode === "eraser") {
      const o = mode === "brush" ? brush : eraser;
      html = `<span class="grp ph-sliders">${sliderRow("Size", "size", 0, 100, sizeToSlider(o.size), `${o.size} px`, 88, sizeToSlider(mode === "brush" ? 40 : 80))}
        ${sliderRow("Hardness", "hard", 0, 100, o.hard, `${o.hard}%`, 72, 80)}
        ${sliderRow("Opacity", "bop", 1, 100, o.opacity, `${o.opacity}%`, 72)}</span>
        ${mode === "brush" ? `<span class="grp ph-colours"><label class="ph-swatch" title="Brush colour" style="background:${brush.color}"><input type="color" data-p="color" value="${brush.color}" aria-label="Brush colour"></label><label class="ph-swatch bg" title="Background colour (X)" style="background:${brush.bg}"><input type="color" data-p="bgcolor" value="${brush.bg}" aria-label="Background colour"></label></span>` : ""}`;
    } else if (mode === "text") {
      const l = selLayer(), t = l?.kind === "text" ? l.text : textOpts;
      html = `<span class="grp"><button class="btn-2 ph-fontbtn" type="button" data-p="font" aria-haspopup="dialog" title="Font"><span style="font-family:'${esc((t.font || "Inter").replace(/'/g, ""))}', Inter, sans-serif">${esc(t.font || "Inter")}</span><span class="small">${esc(t.style || "")}</span>${icon("chev", 12)}</button></span>
        <span class="grp"><label class="lbl">Size<span class="num sm"><input type="text" inputmode="numeric" data-p="tsize" value="${Math.round(t.size)}" aria-label="Font size"><span class="unit">px</span></span></label>
        <label class="ph-swatch" title="Text colour" style="background:${t.color}"><input type="color" data-p="tcolor" value="${t.color}" aria-label="Text colour"></label></span>
        <span class="grp"><div class="seg" role="radiogroup" aria-label="Alignment">${[["left", PI.alignL], ["center", PI.alignC], ["right", PI.alignR]].map(([a, d]) => `<button type="button" role="radio" data-align="${a}" aria-checked="${t.align === a}" aria-label="Align ${a}" title="Align ${a}">${icon(d, 14)}</button>`).join("")}</div></span>
`;
    } else if (mode === "eyedrop") {
      const c = picked || brush.color;
      html = `<span class="grp"><span class="ph-pick"><span class="ph-swatch" style="background:${c}"></span><span class="hex">${c}</span></span></span>
        <span class="grp"><button class="btn-g" type="button" data-p="copyhex" title="Copy">${icon("copy")}Copy</button></span>
`;
    }
    props.innerHTML = html;
    activeBar().hidden = !html;
    (crop ? propBar : cropBar).hidden = true;
    if (crop) ppAll[1].innerHTML = ""; else ppAll[0].innerHTML = "";
    activeBar().setAttribute("aria-label", { crop: "Crop options", move: "Layer properties", select: "Selection", brush: "Brush", eraser: "Eraser", mask: "Refine mask", text: "Text", eyedrop: "Eyedropper" }[mode] || "Properties");
    for (const s of props.querySelectorAll(".slider")) syncSlider(s);
    if (mode === "crop") syncCropFields(true);
    const lt = props.querySelector("canvas.lthumb"), l = selLayer();
    if (lt && l) drawThumb(lt, l, 20);
  }
  function syncCropFields(force = false) {
    if (!crop) return;
    const r = crop.rect;
    const cw = props.querySelector('[data-p="cw"]'), chh = props.querySelector('[data-p="ch"]');
    if (cw && (force || document.activeElement !== cw)) cw.value = Math.round(r.w);
    if (chh && (force || document.activeElement !== chh)) chh.value = Math.round(r.h);
    const ap = props.querySelector('[data-p="aspect"]');
    if (ap) { ap.querySelector(".v").textContent = crop.preset; ap.setAttribute("aria-label", `Aspect ratio: ${crop.preset}`); }
    const lk = props.querySelector('[data-p="lock"]');
    if (lk) { lk.setAttribute("aria-pressed", String(crop.lock)); lk.setAttribute("aria-label", `Keep aspect ratio (${crop.lock ? "on" : "off"})`); }
    const an = props.querySelector('[data-p="angle"]');
    if (an && (force || document.activeElement !== an)) { an.value = crop.a; syncSlider(an); }
    saveSession();
    const av = props.querySelector('[data-v="angle"]');
    if (av) av.textContent = `${crop.a < 0 ? "−" : ""}${Math.abs(crop.a).toFixed(1)}°`;
  }
  function openAspectMenu(anchor) {
    if (!crop) return;
    const el = h(`<div class="ph-menu" role="menu" aria-label="Aspect ratio">${ASPECTS.map(([a]) => `<button type="button" role="menuitemradio" data-aspect="${a}" aria-checked="${crop.preset === a}"><span class="ck">${crop.preset === a ? icon("check", 14, { stroke: 2 }) : ""}</span>${a}</button>`).join("")}</div>`);
    const L = openLayer(el, { anchor, width: 148, reopen: false, sheet: isPhone() || coarse() });
    el.addEventListener("click", (e) => { const b = e.target.closest("[data-aspect]"); if (b) { L.close(); if (crop) applyPreset(b.dataset.aspect); } });
  }
  function syncCropUI() {
    const on = !!crop;
    btn("crop-cancel").hidden = !on;
    btn("crop-apply").hidden = !on;
    btn("export").classList.toggle("phone-hide", on);
    btn("export").classList.toggle("btn-p", !on);
    btn("export").classList.toggle("btn-2", on);
    btn("export").hidden = on && isPhone();
    btn("resize").hidden = on;
    renderTools();
    renderProps();
    setCursor();
  }
  for (const pp of ppAll) pp.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !doc) return;
    if (b.dataset.aspect && crop) return applyPreset(b.dataset.aspect);
    if (b.dataset.shape) { selShape = b.dataset.shape; renderTools(); renderProps(); return; }
    if (b.dataset.sm) { selMode = b.dataset.sm; renderProps(); setCursor(); savePrefs(); return; }
    if (b.dataset.mb) { maskBrush.mode = b.dataset.mb; renderProps(); savePrefs(); return; }
    if (b.dataset.bv) { setBgView(b.dataset.bv); return; }
    if (b.dataset.weight) { setTextProp("weight", +b.dataset.weight); renderProps(); return; }
    if (b.dataset.align) { setTextProp("align", b.dataset.align); renderProps(); return; }
    switch (b.dataset.p) {
      case "snap": return toggleSnap();
      case "rmbg": return removeBackground();
      case "bgmenu": return openBgMenu(b);
      case "refine": return setTool("mask");
      case "edge": return openEdge(b);
      case "backdrop": return openBackdrop(b);
      case "font": return openFonts(b);
      case "aspect": return openAspectMenu(b);
      case "rot": return rotate90();
      case "fliph": return flip(true);
      case "flipv": return flip(false);
      case "lock": crop.lock = !crop.lock; crop.ratio = crop.lock ? crop.rect.w / crop.rect.h : 0; if (!crop.lock) crop.preset = "Free"; return syncCropFields();
      case "cancel": return cancelCrop();
      case "creset": return resetCrop();
      case "tfreset": return resetTransform(selLayer());
      case "raster": return rasterize(selLayer());
      case "apply": return applyCrop();
      case "all": return selectAll();
      case "desel": return deselect();
      case "inv": return invertSelection();
      case "maskinv": return invertMask(selLayer());
      case "tolayer": return copyToLayer();
      case "clear": return clearSelected();
      case "copyhex": copyText(picked || brush.color).then((ok) => toast(ok ? `Copied ${picked || brush.color}` : "Couldn't copy", { bad: !ok })); return;
    }
  });
  for (const pp of ppAll) pp.addEventListener("input", (e) => {
    const t = e.target, p = t.dataset.p, l = selNode();
    const out = (v) => { const s = props.querySelector(`[data-v="${p}"]`); if (s) s.textContent = v; };
    if (p === "angle" && crop) return straighten(+t.value);
    const o = optsOf(tool);
    if (p === "size") { o.size = sliderToSize(+t.value); out(`${o.size} px`); showPreview(tool); return; }
    if (p === "hard") { o.hard = +t.value; out(`${o.hard}%`); showPreview(tool); return; }
    if (p === "bop") { o.opacity = +t.value; out(`${o.opacity}%`); showPreview(tool); return; }
    if (p === "tsize") { const v = Math.round(+t.value.replace(/[^\d.]/g, "")); if (v >= 4 && v <= 4000 && selLayer()?.kind !== "text") { textOpts.size = v; showPreview("text"); } return; }
    if (p === "color") { brush.color = t.value.toUpperCase(); t.parentElement.style.background = t.value; savePrefs(); return; }
    if (p === "bgcolor") { brush.bg = t.value.toUpperCase(); t.parentElement.style.background = t.value; savePrefs(); return; }
    if (p === "viewcolor") { rb.viewColor = t.value.toUpperCase(); t.parentElement.style.background = t.value; invalidate(true); savePrefs(); return; }
    if (p === "tcolor") { t.parentElement.style.background = t.value; setTextProp("color", t.value.toUpperCase(), true); }
    savePrefs();
  });
  for (const pp of ppAll) pp.addEventListener("change", (e) => {
    const t = e.target, p = t.dataset.p, l = selLayer();
    if (p === "maskon" && l) { if (!!l.maskOn !== t.checked) toggleMask(l); return; }
    if (p === "tcolor") { endEdit("Text colour"); changed({ structure: true }); return; }
    if ((p === "cw" || p === "ch") && crop) {
      const v = Math.round(+t.value.replace(/[^\d.]/g, ""));
      if (!(v >= 1)) { syncCropFields(true); return; }
      setCropSize(p === "cw" ? v : crop.rect.w, p === "ch" ? v : crop.rect.h);
      return;
    }
    if (p === "tsize") {
      const v = clamp(Math.round(+t.value.replace(/[^\d.]/g, "")) || textOpts.size, 4, 4000);
      t.value = v;
      setTextProp("size", v);
      if (selLayer()?.kind !== "text") showPreview("text");
    }
  });
  for (const pp of ppAll) pp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type === "text") { e.preventDefault(); e.target.dispatchEvent(new Event("change", { bubbles: true })); e.target.blur(); }
  });
  // Blend mode: a menu grouped like Photoshop's (hovering a mode previews it on the photo; leaving
  // the menu or Esc puts it back); Ctrl+wheel over the button and Shift + / − (Move tool) step through them.
  function syncBlendUI(n) {
    const row = lyList.querySelector(`.ly-row[data-id="${n.id}"]`), b = row?.querySelector(".bm");
    if (!b) return;
    b.querySelector(".bl").textContent = modeOf(n)[1];
    b.title = `Blend mode: ${modeOf(n)[1]}`;
    b.setAttribute("aria-label", `Blend mode: ${modeOf(n)[1]}`);
    b.classList.toggle("def", isDefMode(n));
  }
  const coarse = () => matchMedia("(pointer: coarse)").matches;
  function openBlendMenu(anchor, n) {
    if (!n) return;
    commitPending();
    const orig = n.blend;
    let chosen = null;
    const el = h(`<div class="ph-menu ph-blend" role="menu" aria-label="Blend mode"></div>`);
    (n.group ? [[PASS], ...BLEND_MENU] : BLEND_MENU).forEach((list, i) => {
      if (i) el.append(h(`<span class="msep" role="separator"></span>`));
      for (const [id, label] of list) el.append(h(`<button type="button" role="menuitemradio" data-mode="${id}" aria-checked="${orig === id}"><span class="ck">${orig === id ? icon("check", 14, { stroke: 2 }) : ""}</span>${label}</button>`));
    });
    const show = (id) => { if (n.blend !== id) { n.blend = id; invalidate(true); } };
    el.addEventListener("pointerover", (e) => { const b = e.target.closest("[data-mode]"); if (b && e.pointerType !== "touch") show(b.dataset.mode); });
    el.addEventListener("pointerleave", () => show(orig));
    el.addEventListener("focusin", (e) => { const b = e.target.closest("[data-mode]"); if (b?.matches(":focus-visible")) show(b.dataset.mode); });
    el.addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b) { chosen = b.dataset.mode; lay.close(); } });
    const lay = openLayer(el, {
      anchor, width: 196, reopen: false, sheet: isPhone() || coarse(),
      onClose: () => {
        n.blend = orig;
        if (chosen && chosen !== orig && nodeOf(n.id) === n) record("Blend mode", () => { n.blend = chosen; });
        else invalidate(true);
      },
    });
    el.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: "nearest" });
  }
  /** Step the blend mode (live; one undo step once it settles). */
  function cycleBlend(n, dir) {
    if (!n) return;
    const list = modesOf(n), i = list.findIndex((b) => b[0] === n.blend);
    beginEdit();
    n.blend = list[(Math.max(0, i) + dir + list.length) % list.length][0];
    doc.ver++; // an export started before it settles sees it too
    syncBlendUI(n);
    invalidate(true);
    clearTimeout(blendT);
    blendT = setTimeout(() => { blendT = 0; endEdit("Blend mode"); changed(); }, 500);
  }
  let wheelAcc = 0, wheelAt = 0, opAcc = 0, opAt = 0;
  const wheelDir = (e, acc, at) => {
    if (e.timeStamp - at > 250) acc = 0;
    acc += (e.deltaMode ? (e.deltaY || e.deltaX) * 40 : e.deltaY || e.deltaX);
    return acc;
  };
  lyList.addEventListener("wheel", (e) => {
    if (!doc) return;
    const bm = e.target.closest(".bm"), op = e.target.closest(".op");
    if (bm && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      wheelAcc = wheelDir(e, wheelAcc, wheelAt);
      wheelAt = e.timeStamp;
      if (Math.abs(wheelAcc) < 30) return; // trackpads send small steps: about one mode per notch
      cycleBlend(rowNode(bm), wheelAcc > 0 ? 1 : -1);
      wheelAcc = 0;
    } else if (op && !op.querySelector("input") && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      opAcc = wheelDir(e, opAcc, opAt);
      opAt = e.timeStamp;
      if (Math.abs(opAcc) < 30) return;
      const n = rowNode(op);
      if (n) {
        if (blendT) { clearTimeout(blendT); blendT = 0; endEdit("Blend mode"); }
        beginEdit();
        setOpacity(n, Math.round(n.opacity * 100) + (opAcc < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1));
        clearTimeout(opT);
        opT = setTimeout(() => { opT = 0; endEdit("Opacity"); changed({ structure: true }); }, 400);
      }
      opAcc = 0;
    }
  }, { passive: false });

  // ── tool strip ────────────────────────────────────────────────────────────
  function renderTools() {
    const list = [...TOOLS];
    if (isPhone()) list.push(["layers", "Layers", ""]);
    const cur = crop ? "crop" : tool;
    toolsIn.innerHTML = list.map(([id, name, act]) => {
      const label = act ? K.tip(name, act) : name;
      const d = id === "select" ? (SHAPES.find((s) => s[0] === selShape)[2]) : id === "eyedrop" ? "eyedrop" : id === "mask" ? PI.mask : id;
      return `<button type="button" data-tool="${id}" aria-label="${label}" title="${label}" aria-pressed="${id === cur}">${icon(d, 18, { stroke: 1.4 })}${id === "select" || id === "move" ? `<span class="fly"></span>` : ""}</button>`;
    }).join("");
  }
  toolsEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tool]");
    if (!b) return;
    if (b.dataset.tool === "select" && tool === "select" && !crop) return openShapes(b);
    if (b.dataset.tool === "move" && tool === "move" && !crop) return openMoveOpts(b);
    setTool(b.dataset.tool);
  });
  toolsEl.addEventListener("contextmenu", (e) => {
    const b = e.target.closest('[data-tool="select"], [data-tool="move"]');
    if (!b) return;
    e.preventDefault();
    setTool(b.dataset.tool);
    (b.dataset.tool === "move" ? openMoveOpts : openShapes)(toolsIn.querySelector(`[data-tool="${b.dataset.tool}"]`) || b);
  });
  /** Next to the tool strip on desktop (a sheet on phones). */
  function besideTool(el, anchor) {
    if (isPhone()) return;
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1, r = anchor.getBoundingClientRect();
    el.style.left = `${r.right / zoom + 6}px`;
    el.style.top = `${r.top / zoom}px`;
  }
  /** The Move tool's options: whether a click on the photo picks the layer (or group) under it. */
  function openMoveOpts(anchor) {
    const el = h(`<div class="ph-menu ph-moveopts" role="dialog" aria-label="Move tool options">
      <label class="switch" title="Click to pick layer"><input type="checkbox" data-mo="pick" ${autoSel ? "checked" : ""} autofocus><span class="track"></span>Click to pick layer</label>
      <div class="row-between"><span>Pick</span><div class="seg" role="radiogroup" aria-label="A click picks">${[["layer", "Layer", "the layer"], ["group", "Group", "its outermost group"]].map(([id, n, t]) => `<button type="button" role="radio" data-mo="${id}" aria-checked="${autoGroup === (id === "group")}" title="A click picks ${t}">${n}</button>`).join("")}</div></div>
    </div>`);
    const sync = () => { for (const b of el.querySelectorAll("[role=radio]")) { b.setAttribute("aria-checked", String(autoGroup === (b.dataset.mo === "group"))); b.disabled = !autoSel; } };
    sync();
    el.addEventListener("change", (e) => { if (e.target.dataset.mo === "pick") { autoSel = e.target.checked; sync(); savePrefs(); } });
    el.addEventListener("click", (e) => { const b = e.target.closest("button[data-mo]"); if (b) { autoGroup = b.dataset.mo === "group"; sync(); savePrefs(); } });
    openLayer(el, { anchor, width: 230, reopen: false });
    besideTool(el, anchor);
  }
  function openShapes(anchor) {
    const el = h(`<div class="ph-menu" role="menu" aria-label="Selection shape"></div>`);
    let lay = null;
    for (const [id, label, d] of SHAPES) {
      const b = h(`<button type="button" role="menuitemradio" aria-checked="${selShape === id}">${icon(d, 16)}${label}<span class="kbd k">${K.label({ rect: "marquee", ellipse: "ellipse", lasso: "lasso" }[id])}</span></button>`);
      b.onclick = () => { selShape = id; if (id !== "lasso") marquee = id; lay.close(); renderTools(); renderProps(); savePrefs(); };
      el.append(b);
    }
    lay = openLayer(el, { anchor, width: 180, reopen: false });
    besideTool(el, anchor);
  }
  function setTool(id) {
    if (!doc) return;
    savePrefs();
    saveSession();
    if (id === "layers") { openLayersSheet(); return; }
    commitText();
    if (id === "crop") { tool = "crop"; enterCrop(); return; }
    if (crop) { applyCrop(); }
    tool = id;
    renderTools();
    renderProps();
    setCursor();
    invalidate();
  }

  // ── resize ────────────────────────────────────────────────────────────────
  const tooBig = (w, hh) => w > LIM.side || hh > LIM.side || w * hh > LIM.area;
  /** "Too big · max 7311 × 10958 px": the largest size of the same shape that fits (side and pixel-count limits). */
  const tooBigMsg = (w, hh) => { const f = fitScale(w, hh, LIM); return `Too big · max ${Math.max(1, Math.floor(w * f))} × ${Math.max(1, Math.floor(hh * f))} px`; };
  // Resize image is smart: every layer keeps its source and only its matrix is scaled (it's
  // resampled from the source when drawn), so going back up to the old size is exact. Text is
  // redrawn at the new font size (sharp) when the scale is even.
  // `tweak(layer)` (Upscale) runs after a layer's matrix is scaled and may swap its pixels for a bigger copy.
  function resizeImage(w, hh, tweak, label = "Resize image") {
    if (tooBig(w, hh)) { toast(tooBigMsg(w, hh), { bad: true }); return false; }
    const sx = w / doc.w, sy = hh / doc.h, even = Math.abs(sx - sy) < 1e-9;
    record(label, () => {
      for (const l of doc.layers) {
        if (l.kind === "text" && even && l.text.size * sy >= 1) {
          l.text = { ...l.text, size: l.text.size * sy };
          renderText(l);
          setLm(l, [...lin(l), l.x * sx, l.y * sy]);
        } else { compose(l, S(sx, sy)); tweak?.(l); }
      }
      // the crop's whole picture scales too (a straightened crop can only follow an even scale)
      const c = doc.crop;
      if (c && c.a && !even) doc.crop = null;
      else if (c) { const [bx, by] = c.r % 2 ? [sy, sx] : [sx, sy]; doc.crop = { ...c, bw: c.bw * bx, bh: c.bh * by, rect: { x: c.rect.x * sx, y: c.rect.y * sy, w: c.rect.w * sx, h: c.rect.h * sy } }; }
      doc.w = w; doc.h = hh;
      doc.note = "resized";
    });
    selection = null;
    keepCentre(w / sx, hh / sy, w, hh);
    invalidate(true);
    return true;
  }
  function resizeCanvas(w, hh) {
    if (tooBig(w, hh)) { toast(tooBigMsg(w, hh), { bad: true }); return; }
    const dx = Math.round((w - doc.w) / 2), dy = Math.round((hh - doc.h) / 2);
    record("Canvas size", () => {
      // layers keep what's now outside the canvas (it comes back if the canvas grows again)
      for (const l of doc.layers) { l.x += dx; l.y += dy; }
      // with a crop: the new canvas is the new crop box while it's on the whole picture; bigger than that, it becomes the whole picture
      const c = doc.crop, nr = c && { x: c.rect.x - dx, y: c.rect.y - dy, w, h: hh };
      if (c) doc.crop = onPicture(c, nr) ? { ...c, rect: nr } : null;
      doc.w = w; doc.h = hh;
      doc.note = "canvas resized";
    });
    selection = null;
    keepCentre(w - 2 * dx, hh - 2 * dy, w, hh);
    invalidate(true);
  }
  let resizeLay = null;
  function openResize() {
    if (!doc || crop) return;
    if (resizeLay) { resizeLay.close(); return; }
    commitText();
    // one dialog for the picture's size: Resize (every layer, resampled), Canvas (the frame only) and
    // Upscale (the AI gives the selected layer more pixels; its panel is upscale-ui.js)
    // (it opens where it was last used: Resize, Canvas or Upscale)
    let last = "image";
    try { const m = localStorage.getItem("quickcut.photo.sizemode"); if (m === "canvas" || m === "up") last = m; } catch {}
    const st = { mode: last, w: doc.w, h: doc.h, lock: true };
    const el = h(`<section class="ph-pop" role="dialog" aria-label="Size">
      <div class="pop-head"><span class="pop-title">Size<span class="pop-sub">Now ${doc.w} × ${doc.h} px</span></span><button class="ib" type="button" data-r="close" aria-label="Close (Esc)">${icon("x")}</button></div>
      <div class="seg fill" role="radiogroup" aria-label="How"><button type="button" role="radio" data-m="image" aria-checked="true">Resize</button><button type="button" role="radio" data-m="canvas" aria-checked="false">Canvas</button><button type="button" role="radio" data-m="up" aria-checked="false">Upscale</button></div>
      <div class="ph-rs">
      <div class="wh"><label class="field"><span class="unit">W</span><input type="text" inputmode="numeric" data-r="w" aria-label="Width"><span class="unit">px</span></label>
        <button class="ib" type="button" data-r="lock" aria-pressed="true" aria-label="Keep aspect ratio" title="Keep aspect ratio">${icon("link")}</button>
        <label class="field"><span class="unit">H</span><input type="text" inputmode="numeric" data-r="h" aria-label="Height"><span class="unit">px</span></label></div>
      <label class="field"><input type="text" inputmode="decimal" data-r="pct" aria-label="Percent"><span class="unit">%</span></label>
      <button class="btn-p big" type="button" data-r="apply" autofocus>Apply<span class="kbd">↵</span></button>
      </div>
    </section>`);
    const up = upscaler.panel(() => resizeLay?.close());
    el.append(up.el);
    const f = (n) => el.querySelector(`[data-r="${n}"]`);
    const sync = (except) => {
      if (except !== "w") f("w").value = Math.round(st.w);
      if (except !== "h") f("h").value = Math.round(st.h);
      if (except !== "pct") f("pct").value = +((st.w / doc.w) * 100).toFixed(1);
      f("lock").setAttribute("aria-pressed", String(st.lock));
      for (const b of el.querySelectorAll("[data-m]")) b.setAttribute("aria-checked", String(b.dataset.m === st.mode));
      el.querySelector(".ph-rs").hidden = st.mode === "up";
      if (up.el.hidden !== (st.mode !== "up")) { up.el.hidden = st.mode !== "up"; if (st.mode === "up") up.show(); }
    };
    sync();
    const num = (v) => Math.round(+String(v).replace(/[^\d.]/g, ""));
    el.addEventListener("input", (e) => {
      const n = e.target.dataset.r;
      if (n === "w") { st.w = num(e.target.value) || 1; if (st.lock) st.h = Math.max(1, (st.w * doc.h) / doc.w); }
      if (n === "h") { st.h = num(e.target.value) || 1; if (st.lock) st.w = Math.max(1, (st.h * doc.w) / doc.h); }
      if (n === "pct") { const p = +e.target.value.replace(/[^\d.]/g, "") || 100; st.w = Math.max(1, (doc.w * p) / 100); st.h = Math.max(1, (doc.h * p) / 100); }
      sync(n);
    });
    const apply = () => {
      if (st.mode === "up") return up.go();
      const w = Math.max(1, Math.round(st.w)), hh = Math.max(1, Math.round(st.h));
      resizeLay?.close();
      if (w === doc.w && hh === doc.h) return;
      if (st.mode === "image") resizeImage(w, hh); else resizeCanvas(w, hh);
    };
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.m) { st.mode = b.dataset.m; try { localStorage.setItem("quickcut.photo.sizemode", st.mode); } catch {} sync(); }
      if (b.dataset.r === "lock") { st.lock = !st.lock; if (st.lock) st.h = (st.w * doc.h) / doc.w; sync(); }
      if (b.dataset.r === "apply") apply();
      if (b.dataset.r === "close") resizeLay?.close();
    });
    resizeLay = openLayer(el, { anchor: btn("resize"), width: 300, onClose: () => { resizeLay = null; } });
  }

  // ── export ────────────────────────────────────────────────────────────────
  const ex = { fmt: "jpeg", q: 85, size: "100", cw: 0, ch: 0, lock: true, name: "", phase: "form", blob: null, file: "", ms: 0, lay: null, el: null, estSeq: 0, rate: { png: 45, jpeg: 12, webp: 60 }, timer: 0, matte: "#FFFFFF" };
  function outSize() {
    if (ex.size === "50") return [Math.max(1, Math.round(doc.w / 2)), Math.max(1, Math.round(doc.h / 2))];
    if (ex.size === "custom") return [clamp(Math.round(ex.cw) || doc.w, 1, LIM.side), clamp(Math.round(ex.ch) || doc.h, 1, LIM.side)];
    return [doc.w, doc.h];
  }
  const defaultName = () => baseName(doc.name) + (doc.note?.startsWith("cropped") ? "_crop" : hist.length ? "_edit" : "");
  async function syncWorkerDoc(name) {
    const w = worker(name);
    if (w.docVer === doc.ver) return;
    const ver = doc.ver;
    const layers = await Promise.all(doc.layers.map(async (l) => ({
      id: l.id, parent: l.parent ?? null, src: l.visible ? await createImageBitmap(l.canvas) : null, x: l.x, y: l.y, m: lm(l), opacity: l.opacity, blend: l.blend, visible: l.visible, clip: l.clip,
      mask: l.visible && l.mask && l.maskOn ? { src: await createImageBitmap(l.mask) } : null,
    })));
    const groups = doc.groups.map((g) => ({ ...g }));
    await call(name, { op: "doc", ver, w: doc.w, h: doc.h, layers, groups }, layers.flatMap((l) => [l.src, l.mask?.src]).filter(Boolean));
    if (pool[name] === w) w.docVer = ver;
  }
  function openExport() {
    if (!doc) return;
    if (ex.lay) { ex.lay.close(); return; }
    commitText();
    if (crop) applyCrop();
    if (ex.phase !== "busy") ex.phase = "form";
    if (!ex.name) ex.name = defaultName();
    ex.el = h(`<section class="ph-pop" role="dialog" aria-label="Export image"></section>`);
    renderExport();
    // closing it lets the export worker go (it holds a full-size copy of every layer)
    ex.lay = openLayer(ex.el, { anchor: btn("export"), width: 320, onClose: () => { ex.lay = null; ex.el = null; if (ex.phase === "done") ex.phase = "form"; if (ex.phase !== "busy") kill("exp"); } });
    if (ex.phase === "form") estimate();
  }
  function renderExport() {
    const el = ex.el;
    if (!el) return;
    const f = FORMATS[ex.fmt], [w, hh] = outSize();
    const head = (t) => `<div class="pop-head"><span class="pop-title">${t}</span><button class="ib" type="button" data-x="close" aria-label="Close (Esc or mouse Back)">${icon("x")}</button></div>`;
    if (ex.phase === "form") {
      el.innerHTML = `${head("Export image")}
        <div class="seg fill" role="radiogroup" aria-label="Format">${Object.entries(FORMATS).map(([id, [n]]) => `<button type="button" role="radio" data-fmt="${id}" aria-checked="${ex.fmt === id}">${n}</button>`).join("")}</div>
        <div class="row-between" ${ex.fmt === "jpeg" ? "" : "hidden"} title="Matte">Background<label class="ph-swatch" style="background:${ex.matte}"><input type="color" data-x="matte" value="${ex.matte}" aria-label="Background colour for JPG"></label></div>
        <label class="field-label" ${ex.fmt === "png" ? "hidden" : ""}><span class="row-between">Quality<span class="v" data-v="q">${ex.q}</span></span><input class="slider" type="range" min="1" max="100" value="${ex.q}" data-default="85" data-x="q" aria-label="Quality"></label>
        <div class="field-label"><span class="row-between">Size<span class="v" data-v="size">${w} × ${hh} px</span></span>
          <div class="seg fill" role="radiogroup" aria-label="Size">${[["100", "100%"], ["50", "50%"], ["custom", "Custom"]].map(([id, n]) => `<button type="button" role="radio" data-size="${id}" aria-checked="${ex.size === id}">${n}</button>`).join("")}</div>
          <div class="wh" ${ex.size === "custom" ? "" : "hidden"}><label class="field"><span class="unit">W</span><input type="text" inputmode="numeric" data-x="cw" value="${w}" aria-label="Width"></label>
            <button class="ib" type="button" data-x="lock" aria-pressed="${ex.lock}" aria-label="Keep aspect ratio" title="Keep aspect ratio">${icon("link")}</button>
            <label class="field"><span class="unit">H</span><input type="text" inputmode="numeric" data-x="ch" value="${hh}" aria-label="Height"></label></div></div>
        <label class="field-label">File name<span class="field"><input type="text" data-x="name" value="${esc(ex.name)}" aria-label="File name" spellcheck="false"><span class="unit">.${f[2]}</span></span></label>
        <div class="row-between">Estimated<span class="est" data-v="est">≈ …</span></div>
        <button class="btn-p big" type="button" data-x="download" autofocus>${icon("download")}Download<span class="kbd desk-only">↵</span></button>
        <button class="btn-2 big" type="button" data-x="copy">${icon("copy")}Copy to clipboard</button>
        <button class="btn-g big" type="button" data-x="project" title="Save project${K.label("saveProject") ? ` (${K.label("saveProject")})` : ""}">${icon("download")}Save project</button>`;
      for (const s of el.querySelectorAll(".slider")) syncSlider(s);
    } else if (ex.phase === "busy") {
      el.innerHTML = `${head("Exporting…")}
        <span class="busy-line">${esc(ex.file)} · ${f[0]}${ex.fmt === "png" ? "" : ` ${ex.q}`} · ${w} × ${hh}</span>
        <span class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></span>
        <div class="row-between">Encoding<span class="v" data-v="pct">0%</span></div>
        <button class="btn-2 big" type="button" data-x="cancel" autofocus>Cancel</button>`;
    } else {
      el.innerHTML = `${head("Done")}
        <div class="done-row"><span class="ok">${icon("check", 16, { stroke: 2 })}</span><span class="t"><b>Saved · ${fmtBytes(ex.blob.size)} · ${ex.ms < 100 ? `${Math.max(1, Math.round(ex.ms))} ms` : `${(ex.ms / 1000).toFixed(1)} s`}</b><span>${esc(ex.file)}</span></span></div>
        <button class="btn-2 big" type="button" data-x="again" autofocus>${icon("download")}Download again</button>
        <button class="btn-g big" type="button" data-x="copy">${icon("copy")}Copy to clipboard</button>`;
    }
    // a re-render (busy, done) keeps the focus on its main button
    if (el.contains(document.activeElement) || document.activeElement === document.body) el.querySelector("[autofocus]")?.focus({ preventScroll: true });
    el.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      savePrefs();
      if (b.dataset.fmt) { ex.fmt = b.dataset.fmt; prefFmt = true; renderExport(); estimate(); return; }
      if (b.dataset.size) { ex.size = b.dataset.size; if (ex.size === "custom" && !ex.cw) { ex.cw = doc.w; ex.ch = doc.h; } renderExport(); estimate(); return; }
      switch (b.dataset.x) {
        case "close": ex.lay?.close(); return;
        case "lock": ex.lock = !ex.lock; b.setAttribute("aria-pressed", String(ex.lock)); return;
        case "download": startExport(); return;
        case "copy": copyOut(); return;
        case "cancel": cancelExport(); return;
        case "again": download(ex.blob, ex.file); return;
        case "project": saveProject(); return;
      }
    };
    el.oninput = (e) => {
      const t = e.target, x = t.dataset.x;
      if (x === "q") { ex.q = +t.value; el.querySelector('[data-v="q"]').textContent = ex.q; estimate(); }
      if (x === "matte") { ex.matte = t.value.toUpperCase(); t.parentElement.style.background = ex.matte; }
      savePrefs();
      if (x === "name") ex.name = t.value.replace(/[\\/:*?"<>|]/g, "");
      if (x === "cw" || x === "ch") {
        const v = Math.round(+t.value.replace(/[^\d]/g, ""));
        if (!(v >= 1)) return;
        if (x === "cw") { ex.cw = v; if (ex.lock) { ex.ch = Math.max(1, Math.round((v * doc.h) / doc.w)); el.querySelector('[data-x="ch"]').value = ex.ch; } }
        else { ex.ch = v; if (ex.lock) { ex.cw = Math.max(1, Math.round((v * doc.w) / doc.h)); el.querySelector('[data-x="cw"]').value = ex.cw; } }
        const [w2, h2] = outSize();
        el.querySelector('[data-v="size"]').textContent = `${w2} × ${h2} px`;
        estimate();
      }
    };
    el.onkeydown = (e) => { if (e.key === "Enter" && ex.phase === "form" && e.target.tagName === "INPUT") { e.preventDefault(); startExport(); } };
  }
  let estT = 0;
  function estimate() {
    clearTimeout(estT);
    const my = ++ex.estSeq;
    const out = () => ex.el?.querySelector('[data-v="est"]');
    if (out()) out().textContent = "≈ …";
    estT = setTimeout(async () => {
      if (!ex.el) return; // closed meanwhile: don't start the export worker again
      try {
        await syncWorkerDoc("exp");
        const [w, hh] = outSize();
        const r = await call("exp", { op: "estimate", w, h: hh, type: FORMATS[ex.fmt][1], quality: ex.q / 100, matte: ex.matte });
        if (my === ex.estSeq && out()) out().textContent = `≈ ${fmtBytes(r.bytes)}`;
      } catch {
        if (my === ex.estSeq && out()) out().textContent = "–";
      }
    }, 200);
  }
  async function startExport() {
    if (ex.phase === "busy") return;
    const [w, hh] = outSize(), f = FORMATS[ex.fmt];
    if (tooBig(w, hh)) { toast(tooBigMsg(w, hh), { bad: true }); return; }
    ex.name = (ex.name || defaultName()).trim() || "photo";
    ex.file = `${ex.name}.${f[2]}`;
    ex.phase = "busy";
    ex.estSeq++;
    renderExport();
    const t0 = performance.now(), mp = (w * hh) / 1e6, expect = 80 + mp * ex.rate[ex.fmt];
    const tick = () => {
      const el = ex.el, t = performance.now() - t0, p = Math.min(0.95, t / expect);
      if (el) {
        const bar = el.querySelector(".progress > span"), pc = el.querySelector('[data-v="pct"]');
        if (bar) { bar.style.width = `${p * 100}%`; bar.parentElement.setAttribute("aria-valuenow", Math.round(p * 100)); }
        const left = Math.max(0, expect - t) / 1000;
        if (pc) pc.textContent = `${Math.round(p * 100)}% · ${left < 1 ? "under 1 s left" : `about ${Math.ceil(left)} s left`}`;
      }
      ex.timer = requestAnimationFrame(tick);
    };
    tick();
    try {
      await syncWorkerDoc("exp");
      const r = await call("exp", { op: "export", w, h: hh, type: f[1], quality: ex.q / 100, matte: ex.matte });
      cancelAnimationFrame(ex.timer);
      ex.blob = r.blob;
      ex.ms = performance.now() - t0;
      ex.rate[ex.fmt] = Math.max(2, (r.ms - 20) / Math.max(0.05, mp));
      stats.exports.push({ fmt: ex.fmt, w, h: hh, ms: Math.round(ex.ms), workerMs: Math.round(r.ms), bytes: r.blob.size, type: r.blob.type });
      download(ex.blob, ex.file);
      // the result shows in the corner and goes away by itself; the popover closes
      ex.phase = "form";
      ex.lay?.close();
      const blob = ex.blob, file = ex.file;
      doneCard({
        title: `Saved · ${fmtBytes(blob.size)} · ${ex.ms < 100 ? `${Math.max(1, Math.round(ex.ms))} ms` : `${(ex.ms / 1000).toFixed(1)} s`}`, file,
        actions: [
          { label: "Download again", icon: "download", run: () => download(blob, file) },
          { label: "Copy", icon: "copy", run: async () => toast((await copyImage(blob)) ? "Copied" : "Couldn't copy", { bad: false }) },
        ],
      });
    } catch (err) {
      cancelAnimationFrame(ex.timer);
      ex.phase = "form";
      if (err.message !== "cancelled") toast(`Export failed: ${err.message}`, { bad: true });
      if (ex.el) { renderExport(); estimate(); }
    }
  }
  function cancelExport() {
    kill("exp");
    cancelAnimationFrame(ex.timer);
    ex.phase = "form";
    if (ex.el) { renderExport(); estimate(); }
  }
  function copyOut() {
    const [w, hh] = outSize();
    const png = (async () => {
      if (ex.phase === "done" && ex.blob?.type === "image/png") return ex.blob;
      await syncWorkerDoc("exp");
      return (await call("exp", { op: "export", w, h: hh, type: "image/png" })).blob;
    })();
    const ok = () => toast("Copied");
    const bad = () => toast("Couldn't copy", { bad: true });
    try {
      navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(ok, async () => { (await copyImage(await png)) ? ok() : bad(); });
    } catch {
      png.then(copyImage).then((r) => (r ? ok() : bad()), bad);
    }
  }

  // ── opening files ─────────────────────────────────────────────────────────
  async function decodeViaImg(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const w0 = img.naturalWidth, h0 = img.naturalHeight, s = fitScale(w0, h0, LIM);
      const bitmap = await createImageBitmap(img, s < 1 ? { resizeWidth: Math.floor(w0 * s), resizeHeight: Math.floor(h0 * s), resizeQuality: "high" } : {});
      return { bitmap, w0, h0 };
    } finally { URL.revokeObjectURL(url); }
  }
  async function decode(file) {
    try { return await call("dec", { op: "decode", file, lim: LIM }); }
    catch {
      try { return await decodeViaImg(file); }
      catch {
        const heic = /\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type);
        throw new Error(heic
          ? "HEIC not supported here"
          : `Can't open ${file.name}`);
      }
    }
  }
  function setBusy(on) {
    dropBtn.classList.toggle("busy", on);
    dropBtn.querySelector(".title").textContent = on ? "Opening…" : "Open photo";
    let pr = dropBtn.querySelector(".progress");
    if (on && !pr) dropBtn.querySelector(".title").after((pr = h(`<span class="progress indeterminate"><span></span></span>`)));
    if (!on) pr?.remove();
  }
  async function openFiles(items, { asLayers = !!doc } = {}) {
    // a project replaces the document (the first one, if several come at once)
    for (const x of items) if (x?.file && maybeProject(x.file) && (await qcut.sniff(x.file))) { await openProjectFile(x.file, x.handle); return; }
    const files = items.filter((x) => x?.file && isImage(x.file));
    if (!files.length) { toast("Not an image", { bad: true }); return; }
    let i = 0;
    if (!asLayers) { if (!(await openDoc(files[0]))) return; i = 1; }
    for (; i < files.length; i++) await addImageLayer(files[i].file);
  }
  // Opened the wrong picture: the first Undo right after opening (nothing done yet) closes it again
  // and shows the start screen. Anything else (an edit, a click, a key, the wheel) ends that chance.
  let justOpened = false, openedResumed = false, resuming = false;
  const notJustOpened = () => { if (!justOpened) return; justOpened = false; syncUndo(); };
  document.addEventListener("keydown", (e) => { if (justOpened && baseKey(e) && K.match(e)?.a.id !== "undo") notJustOpened(); }, true);
  document.addEventListener("pointerdown", (e) => { if (justOpened && !e.target.closest?.('[data-kact="undo"]')) notJustOpened(); }, true);
  document.addEventListener("wheel", notJustOpened, { capture: true, passive: true });
  /** Back to the start screen as if the document had never been opened (its file stays in Recents). */
  function closeDoc() {
    justOpened = false;
    commitText();
    if (ex.lay) ex.lay.close();
    clearTimeout(saveT); saveT = 0; savedSeq = editSeq;
    crop = null; selection = null; stroke = null; gesture = null; pendingBefore = null;
    hist = []; hi = 0; hbytes = 0;
    multi.clear(); collapsed.clear();
    doc = null;
    stopAnts();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    // the workers keep a copy of the document: end them (they start again when needed)
    for (const n of Object.keys(pool)) if (!pool[n].pending.size) kill(n);
    lyList.replaceChildren();
    for (const pp of ppAll) pp.innerHTML = "";
    Object.assign(ex, { name: "", phase: "form", blob: null });
    docEl.hidden = true;
    emptyEl.hidden = false;
    showRecents();
    // a new file replaced the saved session: it goes too (a Continue keeps its session)
    if (openedResumed) showResume(); else session.clear("photo").then(showResume, showResume);
  }
  /** Switch to a new document (history, export state and view start fresh). */
  function enterDoc(d, { toolName = "move", cropState = null, viewState = null } = {}) {
    commitText();
    if (ex.lay) ex.lay.close();
    crop = null; selection = null; stroke = null; gesture = null; pendingBefore = null;
    hist = []; hi = 0; hbytes = 0;
    justOpened = true; openedResumed = resuming;
    doc = d;
    doc.groups ||= [];
    multi.clear();
    collapsed.clear();
    for (const id of d.collapsed || []) collapsed.add(id);
    for (const n in pool) pool[n].docVer = -1;
    Object.assign(ex, { name: "", phase: "form", blob: null });
    if (ex.size === "custom") { ex.cw = d.w; ex.ch = d.h; }
    setBusy(false);
    emptyEl.hidden = true;
    docEl.hidden = false;
    tool = toolName === "crop" ? "move" : toolName;
    syncCropUI();
    renderLayers();
    syncMeta();
    syncUndo();
    measure();
    if (cropState) { tool = "crop"; crop = cropState; syncCropUI(); }
    if (viewState && !viewState.fitted) { Object.assign(view, viewState); syncZoom(); invalidate(true); } else fit(viewState ? viewState.cap : true);
    frame();
  }
  async function openDoc({ file, handle }) {
    const t0 = performance.now();
    if (!doc) setBusy(true);
    let r;
    try { r = await decode(file); }
    catch (e) { setBusy(false); toast(e.message, { bad: true }); return false; }
    try {
      const canvas = blank(r.bitmap.width, r.bitmap.height);
      canvas.getContext("2d").drawImage(r.bitmap, 0, 0);
      r.bitmap.close?.();
      const l = newLayer({ name: "Background", kind: "image", canvas });
      if (file.size <= canvas.width * canvas.height * 4) knownPx(canvas, file); // the session keeps the file itself
      if (!prefFmt) ex.fmt = /png|gif|bmp/.test(file.type) || /\.(png|gif|bmp)$/i.test(file.name) ? "png" : /webp/.test(file.type) ? "webp" : "jpeg";
      // a new document replaces the saved session
      session.clear("photo");
      const d = { name: file.name, size: file.size, type: file.type, w: canvas.width, h: canvas.height, w0: r.w0, h0: r.h0, crop: null, layers: [l], groups: [], sel: l.id, ver: 1, note: "", pid: recentId("photo", file), handle: handle || null, src: file, fp: null };
      enterDoc(d);
      qcut.fingerprint(file).then((fp) => { d.fp = fp; }, () => {});
      saveSession();
      requestAnimationFrame(() => stats.open.push({ name: file.name, w: canvas.width, h: canvas.height, ms: Math.round(performance.now() - t0) }));
      if (canvas.width !== r.w0) toast(`Opened at ${Math.round((canvas.width / r.w0) * 100)}% · ${r.w0} × ${r.h0}`, { ms: 6000, info: true });
      thumbOf(canvas).then((thumb) => recents.add("photo", { file, handle, thumb, sub: `${r.w0}×${r.h0}`, copy: false })).catch(() => {}); // the project keeps the file
      return true;
    } catch (e) {
      console.error(e);
      setBusy(false);
      toast(`Can't open ${file.name}: ${e.message}`, { bad: true });
      return false;
    }
  }

  // ── saved session, Recents and project files (.qcut) ─────────────────────
  // The whole document is kept exactly, as a QuickCut project (shared/qcut.js): every layer (pixels,
  // mask, mask edges, the full-size source of a smart layer and its matrix, the before/after edge
  // colours), groups, order, names, settings, text (and its font), the crop, the selection, the
  // picked layers, the view. Pixels are lossless; a layer that is still exactly the opened file is
  // kept as the file's own bytes. Layers are encoded in workers and only when they changed (`rev`:
  // the canvas version); a save runs shortly after each change (at least every 2 s while changes keep
  // coming) and right away when the page is hidden; on leaving the page anything not encoded yet goes
  // in uncompressed, so the last change is never lost. The project is the Continue session and the
  // file's Recent at once (one record, see shared/ui.js). Over MAX_KEEP_BYTES the opened file is left
  // out of it and re-linked when it opens again.
  const blobCache = new WeakMap(); // canvas → {v, b}: the file (or blob) it still is exactly
  const encCache = new WeakMap(); // pixel source (canvas / mask bytes) → {v, e: EncodedPixels}
  const alphaSrc = new WeakMap(); // mask bytes → the 1-channel {width, height, data, channels} given to qcut
  let sessCap = 1024 * 1024 * 1024;
  try { navigator.storage?.estimate?.().then((e) => { if (e?.quota) sessCap = clamp(e.quota * 0.4, 256 * 2 ** 20, 4 * 2 ** 30); }, () => {}); } catch {}
  const verOf = (o) => cver.get(o) || 0;
  /** Remember that `c` (not changed since) is exactly this file/blob. */
  const knownPx = (c, b) => { if (b) blobCache.set(c, { v: verOf(c), b }); };
  const fileOf = (c) => { if (c instanceof Uint8Array) return null; const hit = blobCache.get(c); return hit && hit.v === verOf(c) ? hit.b : null; };
  const srcOf = (o, w, hh) => {
    if (!(o instanceof Uint8Array)) return o;
    let s = alphaSrc.get(o);
    if (!s || s.width !== w || s.height !== hh) { s = { width: w, height: hh, data: o, channels: 1 }; alphaSrc.set(o, s); }
    return s;
  };
  const fresh = (o) => { const e = encCache.get(o); return e && e.v === verOf(o) ? e.e : null; };
  const ready = (o) => !!(fileOf(o) || fresh(o));
  async function encode(o, w, hh, mode) {
    const v = verOf(o);
    const e = await qcut.encodePixels(srcOf(o, w, hh), { mode, rev: v });
    const old = encCache.get(o);
    if (!old || old.v <= v) encCache.set(o, { v, e });
    return e;
  }
  /** Every pixel source of a document: [object, w, h]. */
  function pxSources(d) {
    const out = [];
    for (const l of d.layers) {
      if (l.kind !== "text") out.push([l.canvas, l.canvas.width, l.canvas.height]);
      if (l.mask) { out.push([l.mask, l.mask.width, l.mask.height]); if (l.maskShift || l.maskSoft) out.push([l.maskBase, l.mask.width, l.mask.height]); }
      for (const c of [l.preBg, l.bgFixed]) if (c && c !== l.canvas) out.push([c, c.width, c.height]);
    }
    return out;
  }
  /** Encode what changed (in the workers, all at once); false if the document keeps changing. */
  async function encodeAll(d, mode) {
    for (let pass = 0; pass < 4; pass++) {
      const todo = pxSources(d).filter(([o]) => !fileOf(o) && (mode === "best" ? fresh(o)?.mode !== "best" : !fresh(o)));
      if (!todo.length) return true;
      await Promise.all(todo.map(([o, w, hh]) => encode(o, w, hh, mode)));
      if (d !== doc) return false;
    }
    return false;
  }
  /** The view state saved with a document. */
  const uiNow = () => ({
    collapsed: [...collapsed], multi: [...multi], selection, tool: crop ? "crop" : tool, selShape, view: { ...view }, brush: { ...brush }, eraser: { ...eraser }, textOpts: { ...textOpts },
    crop: crop ? { ...crop, rect: { ...crop.rect }, base: { ...crop.base } } : null,
  });
  /**
   * The project doc. Pixel sources are their encodings (or the file they still are); `sync` (page
   * closing): sources not encoded yet go in as they are (written uncompressed, a few MB at most; a big
   * one keeps its last saved version); `lite`: the opened file is left out (re-linked on open).
   */
  function docOf(d, ui, { sync = false, lite = false } = {}) {
    let rawLeft = 12 * 2 ** 20;
    const px = (o, w, hh) => {
      if (!o) return null;
      const f = fileOf(o);
      if (f) return lite && f === d.src ? { link: 1 } : f;
      const e = fresh(o);
      if (e) return e;
      if (!sync) throw new Error("not encoded");
      const n = o instanceof Uint8Array ? o.length : o.width * o.height * 4, old = encCache.get(o)?.e;
      if (n <= rawLeft || !old) { rawLeft -= n; return srcOf(o, w, hh); }
      return old;
    };
    const layers = d.layers.map((l) => {
      // a smart layer: its source pixels + its matrix (ta tb tc td with x, y)
      const rec = { id: l.id, parent: l.parent ?? null, name: l.name, named: !!l.named, kind: l.kind, x: l.x, y: l.y, ...tfOf(l), opacity: l.opacity, blend: l.blend, visible: l.visible, clip: !!l.clip, text: l.text ? { ...l.text } : null };
      if (l.kind !== "text") rec.px = px(l.canvas, l.canvas.width, l.canvas.height);
      if (l.mask) {
        const W = l.mask.width, H = l.mask.height, edges = !!(l.maskShift || l.maskSoft);
        rec.mask = { px: px(l.mask, W, H), on: !!l.maskOn, shift: l.maskShift || 0, soft: l.maskSoft || 0, base: edges ? px(l.maskBase, W, H) : null };
      }
      if (l.preBg) rec.preBg = l.preBg === l.canvas ? "canvas" : px(l.preBg, l.preBg.width, l.preBg.height);
      if (l.bgFixed) rec.bgFixed = l.bgFixed === l.canvas ? "canvas" : px(l.bgFixed, l.bgFixed.width, l.bgFixed.height);
      if (l.backdropFor) { rec.backdropFor = l.backdropFor; rec.backdrop = l.backdrop; }
      return rec;
    });
    return {
      v: 3, name: d.name, size: d.size, type: d.type, w: d.w, h: d.h, w0: d.w0, h0: d.h0, note: d.note, sel: d.sel, layers,
      groups: d.groups.map((g) => ({ ...g })), ...ui,
      // the applied crop (while Crop is open, the layers are saved uncropped and `crop` is being edited)
      docCrop: d.crop ? { ...d.crop, rect: { ...d.crop.rect } } : null,
      source: d.fp || null,
    };
  }
  const subOf = (d) => `${d.w}×${d.h}${d.layers.length > 1 ? ` · ${d.layers.length} layers` : ""}`;
  const previewOf = (b) => (b && /^image\/(webp|jpeg|png|avif)$/.test(b.type) ? b : null);
  /** The project as a Blob (everything encoded first). Over MAX_KEEP_BYTES the opened file is linked instead (if that is smaller). */
  async function writeProject(d, mode, { fit = true } = {}) {
    const ui = uiNow();
    if (!(await encodeAll(d, mode))) return null;
    const preview = previewOf(await docThumb());
    if (d !== doc || pxSources(d).some(([o]) => !ready(o))) return null;
    let blob = await qcut.write({ type: "photo", doc: docOf(d, ui), preview }, { mode });
    if (fit && blob.size > MAX_KEEP_BYTES && d.src && d.fp) {
      const lite = await qcut.write({ type: "photo", doc: docOf(d, ui, { lite: true }), preview }, { mode });
      if (lite.size < blob.size) blob = lite;
    }
    lastThumb = preview;
    return blob;
  }
  const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 1000 }) : setTimeout(r, 0)));
  let saveT = 0, saveFirst = 0, saving = false, saveAgain = false, editSeq = 0, savedSeq = 0, lastThumb = null, toldBig = false;
  function saveSession() {
    if (!doc) return;
    editSeq++;
    const now = performance.now();
    if (!saveT) saveFirst = now;
    clearTimeout(saveT);
    saveT = setTimeout(runSave, Math.max(0, Math.min(300, saveFirst + 1500 - now)));
  }
  const sessRec = (d, project) => ({ name: d.name, sub: subOf(d), thumb: lastThumb, pid: d.pid, handle: d.handle || null, project });
  async function runSave() {
    clearTimeout(saveT);
    saveT = 0;
    if (saving) { saveAgain = true; return; }
    const d = doc, my = editSeq;
    if (!d || my <= savedSeq) return;
    saving = true;
    try {
      await idle();
      const project = d === doc ? await writeProject(d, "quick") : null;
      if (!project || d !== doc || my <= savedSeq) return; // changed meanwhile: saved next time
      if (project.size > sessCap) {
        if (!toldBig) { toldBig = true; toast("Too big to keep. Export it", { bad: true, ms: 8000 }); }
        return;
      }
      // counted as saved once it is written (a page closing meanwhile writes it again, synchronously)
      await session.save("photo", sessRec(d, project));
      savedSeq = Math.max(savedSeq, my);
    } catch (e) { console.warn("photo: session not saved", e); }
    finally {
      saving = false;
      if (saveAgain || (doc && editSeq > savedSeq && !saveT)) { saveAgain = false; if (doc && editSeq > savedSeq) saveT = setTimeout(runSave, 300); }
    }
  }
  /** Save right now without waiting (the page is going away): anything not encoded yet goes in uncompressed. */
  function flushSession() {
    if (!doc || editSeq <= savedSeq) return;
    clearTimeout(saveT);
    saveT = 0;
    try {
      const project = qcut.writeSync({ type: "photo", doc: docOf(doc, uiNow(), { sync: true }), preview: previewOf(lastThumb) });
      savedSeq = editSeq;
      session.save("photo", sessRec(doc, project)); // the write starts in this task (the database is already open)
    } catch (e) { console.warn("photo: session not saved", e); }
  }
  addEventListener("pagehide", flushSession);
  document.addEventListener("visibilitychange", () => { if (document.hidden && doc && editSeq > savedSeq) runSave(); });
  /** Save project: downloads name.qcut (best compression, everything in it). */
  async function saveProject() {
    if (!doc) return;
    commitText();
    const d = doc;
    try {
      const blob = await writeProject(d, "best", { fit: false });
      if (!blob) { toast("Still changing. Try again", { bad: true }); return; }
      download(blob, `${baseName(d.name) || "project"}${qcut.EXT}`);
      toast(`Saved · ${fmtBytes(blob.size)}`);
    } catch (e) { console.error(e); toast("Can't save project", { bad: true }); }
  }
  /** A saved pixel source of an old (pre-.qcut) session back as a canvas (raw pixels, or an image file / PNG / WebP). */
  async function pxLegacy(p) {
    if (p.r) {
      const buf = await p.b.arrayBuffer(), c = blank(p.r.w, p.r.h);
      if (p.r.a) return { c, alpha: new Uint8Array(buf) };
      c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(buf), p.r.w, p.r.h), 0, 0);
      return { c };
    }
    const r = await decode(p.b);
    const c = blank(r.bitmap.width, r.bitmap.height);
    c.getContext("2d").drawImage(r.bitmap, 0, 0);
    r.bitmap.close?.();
    if (p.b instanceof File) knownPx(c, p.b); // the opened file itself (a PNG/WebP copy is re-encoded losslessly)
    return { c };
  }
  function docThumb() {
    const s = Math.min(1, 320 / Math.max(doc.w, doc.h));
    const c = blank(doc.w * s, doc.h * s), b = buffers();
    b.size(c.width, c.height);
    composite(c.getContext("2d"), tree(drawList(false), doc.groups), S(c.width / doc.w, c.height / doc.h), b);
    b.drop();
    return c.convertToBlob({ type: "image/webp", quality: 0.8 });
  }
  /** Fonts the saved text layers use: the exact faces from this computer (if allowed before) and the bundled ones. */
  async function loadFontsFor(texts) {
    if (texts.some((t) => t.ps) && window.queryLocalFonts) {
      try { if ((await navigator.permissions.query({ name: "local-fonts" })).state === "granted") await loadLocalFonts(true); } catch {}
      for (const t of texts) {
        if (!t.ps || faceAlias.has(t.ps)) continue;
        const st = localFams?.get(t.font)?.find((x) => x.ps === t.ps);
        if (st) await loadFace(st);
      }
    }
    await Promise.all(texts.map((t) => document.fonts.load(fontCss(t, 32)).catch(() => null)));
  }
  const LAYER_KEYS = ["id", "parent", "name", "named", "kind", "x", "y", "ta", "tb", "tc", "td", "opacity", "blend", "visible", "clip", "text", "backdropFor", "backdrop"];
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  /**
   * A saved document back (not shown yet): `st` is a project doc or an old session's state, `load(v)`
   * turns one saved pixel value into {c} (a canvas) or {alpha} (mask bytes). → {d, ui}
   */
  // A project file is untrusted: everything from it that reaches the page (tool settings, text, layer
  // and group fields, crop, view) is checked against what it may be; anything else is dropped.
  const HEXC = /^#[0-9A-Fa-f]{6}$/;
  const BLEND_IDS = new Set(BLENDS.map((b) => b[0]));
  const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : undefined);
  /** the checked fields `c`, in the order the file had them (fields only in `c` go last) */
  const inOrder = (src, c) => { const o = {}; for (const k of Object.keys(src)) if (k in c) o[k] = c[k]; for (const k of Object.keys(c)) if (!(k in o)) o[k] = c[k]; return o; };
  /** brush / eraser / textOpts / text: known keys with the right kinds of values only */
  function cleanOpts(o, isText = false) {
    if (!o || typeof o !== "object") return undefined;
    const r = {};
    for (const k of ["color", "bg"]) if (HEXC.test(o[k])) r[k] = o[k];
    for (const k of ["size", "hard", "opacity", "weight"]) if (num(o[k])) r[k] = o[k];
    if (isText) {
      if (typeof o.str === "string") r.str = o.str.slice(0, 20000);
      for (const k of ["font", "style", "ps"]) if (typeof o[k] === "string") r[k] = o[k].slice(0, 120);
      if (o.ps === null) r.ps = null;
      if (["left", "center", "right"].includes(o.align)) r.align = o.align;
      if (typeof o.italic === "boolean") r.italic = o.italic;
    }
    return inOrder(o, r);
  }
  function cleanCrop(c) {
    if (!c || typeof c !== "object" || !c.rect || !["x", "y", "w", "h"].every((k) => num(c.rect[k]))) return null;
    if (![c.r, c.fx, c.fy, c.a].every((v) => v === undefined || num(v))) return null;
    if (c.bw !== undefined && !num(c.bw) || c.bh !== undefined && !num(c.bh)) return null;
    const out = { ...c, rect: { x: c.rect.x, y: c.rect.y, w: c.rect.w, h: c.rect.h } };
    if (c.base) out.base = ["x", "y", "w", "h"].every((k) => num(c.base[k])) ? { x: c.base.x, y: c.base.y, w: c.base.w, h: c.base.h } : null;
    if (!ASPECTS.some((a) => a[0] === c.preset)) out.preset = "Free";
    for (const k of ["ratio"]) if (out[k] !== undefined && !num(out[k])) out[k] = 0;
    if (c.lock !== undefined) out.lock = !!c.lock;
    return out;
  }
  async function restoreDoc(st, load) {
    if (!st || !Array.isArray(st.layers) || !st.layers.length || !Number.isInteger(st.w) || !Number.isInteger(st.h) || st.w < 1 || st.h < 1) throw new Error("not a document");
    const texts = [...st.layers.map((l) => l?.text).filter((t) => t && typeof t === "object"), st.textOpts].filter(Boolean);
    await loadFontsFor(texts);
    const layers = await Promise.all(st.layers.map(async (s0) => {
      const { px, blob, maskBlob, maskOn, mask, orig, preBg, bgFixed } = s0;
      const rest = {};
      for (const k of LAYER_KEYS) if (s0[k] !== undefined) rest[k] = s0[k];
      if (!Number.isInteger(rest.id) || !["x", "y", "opacity", "ta", "tb", "tc", "td"].every((k) => rest[k] === undefined || num(rest[k]))) throw new Error("bad layer");
      if (rest.parent !== undefined && rest.parent !== null && !Number.isInteger(rest.parent)) delete rest.parent;
      if (rest.name !== undefined) rest.name = str(rest.name) ?? "Layer";
      if (rest.blend !== undefined && !BLEND_IDS.has(rest.blend)) rest.blend = "normal";
      if (!["image", "text", undefined].includes(rest.kind)) delete rest.kind;
      for (const k of ["named", "visible", "clip"]) if (rest[k] !== undefined) rest[k] = !!rest[k];
      if (rest.text !== undefined) {
        rest.text = cleanOpts(rest.text, true);
        if (!rest.text || typeof rest.text.str !== "string") { delete rest.text; if (rest.kind === "text") throw new Error("bad layer"); }
        else { if (!HEXC.test(rest.text.color)) rest.text.color = "#FFFFFF"; if (!(rest.text.size > 0)) rest.text.size = 120; if (!rest.text.font) rest.text.font = "Inter"; }
      }
      if (rest.backdropFor !== undefined && !Number.isInteger(rest.backdropFor)) delete rest.backdropFor;
      if (rest.backdrop !== undefined && (typeof rest.backdrop !== "object" || rest.backdrop === null)) delete rest.backdrop;
      const l = newLayer(rest);
      if (l.kind === "text" && l.text) renderText(l);
      else l.canvas = (await load(px || { b: blob })).c;
      if (!l.canvas) throw new Error("bad layer");
      const m = mask || (maskBlob ? { px: { b: maskBlob }, on: maskOn !== false } : null); // v1: maskBlob + maskOn
      if (m) {
        const mc = (await load(m.px)).c;
        if (mc && mc.width === l.canvas.width && mc.height === l.canvas.height) {
          const base = m.base ? await load(m.base) : null;
          const ba = base ? base.alpha || alphaOf(base.c) : null;
          const okBase = ba && ba.length === mc.width * mc.height;
          Object.assign(l, { mask: mc, maskBase: okBase ? ba : alphaOf(mc), maskOn: m.on !== false, maskShift: okBase && num(m.shift) ? m.shift : 0, maskSoft: okBase && num(m.soft) ? m.soft : 0 });
        }
      }
      if (orig && !l.mask && l.kind !== "text") {
        // saved before smart layers: a layer scaled to fit kept its full-size original too; that becomes its source
        const oc = (await load(orig)).c;
        setLm(l, mul(lm(l), S(l.canvas.width / oc.width, l.canvas.height / oc.height)));
        l.canvas = oc;
      }
      if (preBg) l.preBg = preBg === "canvas" ? l.canvas : (await load(preBg)).c;
      if (bgFixed) l.bgFixed = bgFixed === "canvas" ? l.canvas : (await load(bgFixed)).c;
      if (!l.preBg || !l.bgFixed) { delete l.preBg; delete l.bgFixed; }
      return l;
    }));
    const groups = (Array.isArray(st.groups) ? st.groups : []).filter((g) => g && Number.isInteger(g.id)).map((g) => {
      const c = {
        id: g.id, group: true, parent: Number.isInteger(g.parent) ? g.parent : null, name: str(g.name) ?? "Group", ...(g.named !== undefined && { named: !!g.named }),
        opacity: num(g.opacity) ? g.opacity : 1, blend: g.blend === PASS[0] || BLEND_IDS.has(g.blend) ? g.blend : PASS[0], visible: g.visible !== false, clip: !!g.clip,
      };
      return inOrder(g, c); // unknown fields are dropped
    });
    const has = (id) => layers.some((l) => l.id === id) || groups.some((g) => g.id === id);
    const sel = has(st.sel) ? st.sel : layers[layers.length - 1].id;
    const d = { name: str(st.name) || "Untitled", size: num(st.size) ? st.size : 0, type: str(st.type, 80) || "", w: st.w, h: st.h, w0: num(st.w0) ? st.w0 : st.w, h0: num(st.h0) ? st.h0 : st.h, crop: cleanCrop(st.docCrop), layers, groups, collapsed: Array.isArray(st.collapsed) ? st.collapsed.filter(Number.isInteger) : [], sel, ver: 1, note: str(st.note, 120) || "" };
    const vw = st.view && typeof st.view === "object" && ["ox", "oy", "z"].every((k) => num(st.view[k])) && st.view.z > 0 ? { ox: st.view.ox, oy: st.view.oy, z: st.view.z, fitted: !!st.view.fitted, cap: st.view.cap !== false } : null;
    const ui = { tool: TOOLS.some((t) => t[0] === st.tool) ? st.tool : "move", crop: cleanCrop(st.crop), view: vw, multi: (Array.isArray(st.multi) ? st.multi : []).filter((id) => has(id) && id !== sel), selection: st.selection || null, brush: cleanOpts(st.brush), eraser: cleanOpts(st.eraser), textOpts: cleanOpts(st.textOpts, true), selShape: ["rect", "ellipse", "lasso"].includes(st.selShape) ? st.selShape : undefined };
    return { d, ui };
  }
  /** Show a restored document. */
  function enterRestored({ d, ui }) {
    seq = Math.max(seq, ...d.layers.map((l) => l.id), ...d.groups.map((g) => g.id)) + 1;
    Object.assign(brush, ui.brush); Object.assign(eraser, ui.eraser); Object.assign(textOpts, ui.textOpts);
    if (ui.selShape) selShape = ui.selShape;
    enterDoc(d, { toolName: ui.tool, cropState: ui.crop, viewState: ui.view });
    for (const id of ui.multi) multi.add(id);
    selection = ui.selection;
    savedSeq = editSeq; // what's on screen is what's saved
    renderLayers(); renderProps(); invalidate(true);
  }
  let busyOpen = false;
  const qErr = (e) => (e?.code === "newer" ? "Needs a newer QuickCut" : "Can't open project");
  /**
   * Open a project (.qcut Blob/File). `pid`: the Recent / session it is stored as; `relink()`: the
   * opened file, for a project saved without it (checked against its fingerprint; else asked for).
   */
  async function openProject(blob, { pid = null, handle = null, relink = null } = {}) {
    if (busyOpen) return false;
    let f;
    try { f = await qcut.read(blob); } catch (e) { toast(qErr(e), { bad: true }); return false; }
    if (f.type !== "photo") {
      if (f.type === "video") { dispatchEvent(new CustomEvent("quickcut:project", { detail: { tool: "video", file: blob, handle } })); return false; }
      toast(qErr(), { bad: true }); return false;
    }
    busyOpen = true;
    if (!doc) setBusy(true);
    const t0 = performance.now();
    try {
      const st = f.doc;
      let src = null, srcP = null;
      const source = st?.source && typeof st.source === "object" ? st.source : null;
      const same = async (file) => file && (!source?.hash || (await qcut.fingerprint(file)).hash === source.hash);
      const getSrc = () => (srcP ||= (async () => {
        let file = relink ? await relink() : null;
        if (!(await same(file))) {
          toast(`Choose ${source?.name || st.name} again`, { info: true, ms: 5000 });
          file = (await pickFiles({ accept: ACCEPT, types: TYPES }))[0]?.file || null;
          if (!(await same(file))) throw Object.assign(new Error("relink"), { why: file ? `That isn't ${source?.name || st.name}` : "" });
        }
        return file;
      })());
      const decodeTo = async (b) => {
        const r = await decode(b);
        const c = blank(r.bitmap.width, r.bitmap.height);
        c.getContext("2d").drawImage(r.bitmap, 0, 0);
        r.bitmap.close?.();
        knownPx(c, b);
        return c;
      };
      const load = async (v) => {
        if (v instanceof qcut.Ref) {
          if (v.kind === "pixels" && v.channels === 4) { const c = blank(v.width, v.height); await v.load({ into: c }); return { c }; }
          if (v.kind === "pixels") return { alpha: (await v.load()).data };
          if (v.kind === "bytes") {
            const b = await v.load();
            if (!src && v.name && v.name === source?.name) src = b; // the opened file (kept so a later save can link it)
            return { c: await decodeTo(b) };
          }
        }
        if (v && typeof v === "object" && v.link) { const file = await getSrc(); src = file; return { c: await decodeTo(file) }; }
        throw new Error("bad layer");
      };
      const r = await restoreDoc(st, load);
      Object.assign(r.d, { pid: pid || `photo:${r.d.name}:project`, handle, src, fp: source });
      commitText();
      enterRestored(r);
      lastThumb = previewOf(await f.preview());
      // the Continue card now points at this project (stored under `pid`)
      session.save("photo", { name: r.d.name, sub: subOf(r.d), thumb: lastThumb, pid: r.d.pid, handle });
      requestAnimationFrame(() => stats.open.push({ name: r.d.name, w: r.d.w, h: r.d.h, ms: Math.round(performance.now() - t0), project: true }));
      return true;
    } catch (e) {
      if (!(e instanceof qcut.QcutError) && e?.message !== "relink") console.error(e);
      setBusy(false);
      if (e?.message !== "relink" || e.why) toast(e?.why || qErr(e), { bad: true });
      return false;
    } finally { busyOpen = false; }
  }
  /** A .qcut file opened by the user (drop, picker, Ctrl+O): shown, and remembered as a Recent. */
  async function openProjectFile(file, handle) {
    if (!(file instanceof File)) { await openProject(file, { handle }); return; } // (no name: not remembered)
    const pid = recentId("photo", file);
    if (!(await openProject(file, { pid, handle }))) return;
    const d = doc;
    await recents.add("photo", { file, handle, thumb: lastThumb, sub: subOf(d), copy: false });
    await recents.saveProject(pid, file);
  }
  /** Continue: the saved session (a project, or an old session's state). */
  async function resume(rec) {
    resuming = true;
    try { return await resumeIn(rec); } finally { resuming = false; }
  }
  async function resumeIn(rec) {
    if (rec?.project) return openProject(rec.project, { pid: rec.pid, handle: rec.handle || null, relink: () => session.file(rec) });
    const st = rec?.state;
    if (!st?.layers?.length) { toast("Couldn't restore that session.", { bad: true }); return; }
    setBusy(true);
    try {
      const r = await restoreDoc(st, pxLegacy);
      r.d.pid = "photo:session";
      enterRestored(r);
      lastThumb = rec.thumb || null;
    } catch (e) {
      console.error(e);
      setBusy(false);
      toast("Couldn't restore that session.", { bad: true });
    }
  }
  /** Once: an old session (PNG per layer) becomes a project; the old record stays until that worked. */
  async function migrate() {
    const rec = await session.load("photo");
    if (!rec?.state?.layers?.length || rec.project) return;
    try {
      const { d, ui } = await restoreDoc(rec.state, pxLegacy);
      for (const [o, w, hh] of pxSources(d)) if (!fileOf(o)) await encode(o, w, hh, "best");
      const project = await qcut.write({ type: "photo", doc: docOf(d, ui), preview: previewOf(rec.thumb) });
      const now = await session.load("photo");
      if (now?.at !== rec.at) return; // something newer was saved meanwhile
      await session.save("photo", { name: rec.name, sub: rec.sub, thumb: rec.thumb || null, pid: "photo:session", project });
    } catch (e) { console.warn("photo: old session not converted (kept as it is)", e); }
  }

  // ── preferences (localStorage) ────────────────────────────────────────────
  const PREF = "quickcut.photo";
  let prefFmt = false, prefT = 0;
  try {
    const p = JSON.parse(localStorage.getItem(PREF) || "{}");
    Object.assign(brush, p.brush); Object.assign(eraser, p.eraser); Object.assign(textOpts, p.text);
    if (p.ex) { Object.assign(ex, { q: p.ex.q ?? ex.q, size: p.ex.size || ex.size, lock: p.ex.lock ?? true }); if (p.ex.fmt) { ex.fmt = p.ex.fmt; prefFmt = true; } }
    if (p.selShape) selShape = p.selShape;
    if (SEL_OPS.some((o) => o[0] === p.selMode)) selMode = p.selMode;
    if (p.mask) Object.assign(maskBrush, p.mask);
    if (p.viewColor) rb.viewColor = p.viewColor;
    if (p.ex?.matte) ex.matte = p.ex.matte;
    if (p.snap === false) snapOn = false;
    // "Click to pick layer" is on unless it was turned off in its new place (the old top-bar
    // "Auto-select" setting isn't carried over: it was off by default before)
    if (p.pick) { autoSel = p.pick.on !== false; autoGroup = !!p.pick.group; } else if (p.autoGroup) autoGroup = true;
    if (p.cardCollapsed) { card.classList.add("collapsed"); card.querySelector(".head").setAttribute("aria-expanded", "false"); }
  } catch {}
  function savePrefs() {
    clearTimeout(prefT);
    prefT = setTimeout(() => {
      try {
        localStorage.setItem(PREF, JSON.stringify({
          brush, eraser, mask: maskBrush, text: textOpts, selShape, selMode, viewColor: rb.viewColor, snap: snapOn, pick: { on: autoSel, group: autoGroup }, cardCollapsed: card.classList.contains("collapsed"),
          ex: { fmt: prefFmt ? ex.fmt : null, q: ex.q, size: ex.size, lock: ex.lock, matte: ex.matte },
        }));
      } catch {}
    }, 300);
  }
  async function addImageLayer(file) {
    let r;
    try { r = await decode(file); } catch (e) { toast(e.message, { bad: true }); return; }
    if (crop) applyCrop(); // like pasting: the new layer and its undo step belong to the cropped document
    const bw = r.bitmap.width, bh = r.bitmap.height, s = Math.min(1, doc.w / bw, doc.h / bh);
    const full = blank(bw, bh);
    full.getContext("2d").drawImage(r.bitmap, 0, 0);
    r.bitmap.close?.();
    if (file.size <= bw * bh * 4) knownPx(full, file);
    commitText();
    // a smart layer: the full image is kept once, scaled to fit by its matrix (scaling it up later stays sharp)
    addLayer(newLayer({ name: baseName(file.name), named: true, kind: "image", canvas: full, x: Math.round((doc.w - bw * s) / 2), y: Math.round((doc.h - bh * s) / 2), ...(s < 1 ? { ta: s, tb: 0, tc: 0, td: s } : {}) }), "Add image");
    toast(s < 1 ? `Added · ${Math.round(s * 100)}%` : "Added");
  }
  async function choose(asLayers = !!doc) {
    const items = await pickFiles({ accept: ACCEPT, multiple: true, types: TYPES });
    if (items.length) openFiles(items, { asLayers });
  }
  dropBtn.addEventListener("click", () => choose(false));
  intake(ph, (items) => openFiles(items), { isActive: () => visible, filter: (f) => isImage(f) || maybeProject(f) });

  function syncMeta() {
    if (!doc) return;
    fileN.textContent = doc.name;
    fileN.title = doc.name;
    fileM.textContent = `${doc.w} × ${doc.h} · ${doc.note || fmtBytes(doc.size)}`;
  }
  function changed(o = {}) {
    if (!doc) return;
    doc.ver++;
    invalidate(true);
    if (o.structure) { renderLayers(); renderProps(); }
    scheduleThumbs();
    syncMeta();
    syncUndo();
    saveSession();
  }

  // ── buttons, keys, resizing ───────────────────────────────────────────────
  q(".actions").addEventListener("click", (e) => {
    const b = e.target.closest("[data-a]");
    if (!b) return;
    ({ undo, redo, resize: openResize, export: openExport, "crop-cancel": cancelCrop, "crop-apply": applyCrop })[b.dataset.a]?.();
  });
  q(".zf").addEventListener("click", () => fit());
  q(".zk").addEventListener("click", () => K.openSheet());
  zoomV.addEventListener("click", () => {
    if (Math.abs(view.z - 1) < 1e-3) fit();
    else zoomAt(1 / view.z, rect.width / 2, rect.height / 2);
  });
  // ── keyboard (pro-editor shortcuts; none fire while typing in a field) ────
  // Every shortcut is one row of KEYMAP below: the handler and the ? sheet both read it, so keys can
  // be remapped later in one place. Photoshop's keys where the browser allows them. Taken by the
  // browser/page and so not used: Ctrl+N/T/W/R (+Shift), Ctrl +/−/0 (interface size), Alt+1–3 (tabs).
  // Deliberate differences from Photoshop: Ctrl+E is Export (QuickCut's design; Photoshop: Merge
  // Down, here Ctrl+Shift+M), Ctrl+Shift+E flattens (Photoshop: Merge Visible), Ctrl+C copies what you
  // see (Ctrl+Alt+C: only the active layer), Shift+1 / Shift+0 fit / 100% (Ctrl+0/1 are the browser's
  // zoom keys), Ctrl+Alt+N / Ctrl+Shift+L new layer (Ctrl+Shift+N is the browser's), Ctrl+Alt+T shows
  // the transform box (Ctrl+T is the browser's), Q is the mask brush (Photoshop: Quick Mask), H and Z
  // work while held (spring-loaded hand / zoom: there's no separate hand or zoom tool).
  // A row: K.add({id, label, group, keys ("Ctrl+Shift+Z|Ctrl+Y"), run(e), when(), ctx, hold/up}). The key handler, the
  // tooltips and the ? sheet all read the registry (shared/keys.js), where the user's own keys live.
  const kb = (id, keys, group, label, run, when, extra) => K.add({ id, keys, group, label, run, when, ...extra });
  const info = (shown, group, label) => K.info(shown, group, label);
  // Tools
  kb("move", "V", "Tools", "Move", () => setTool("move"));
  kb("marquee", "M", "Tools", "Marquee", () => { if (selShape === "lasso") selShape = marquee; setTool("select"); renderTools(); savePrefs(); });
  kb("ellipse", "Shift+M", "Tools", "Rect ↔ ellipse", () => { selShape = marquee = selShape === "rect" ? "ellipse" : "rect"; setTool("select"); renderTools(); savePrefs(); });
  kb("lasso", "L", "Tools", "Lasso select", () => { selShape = "lasso"; setTool("select"); renderTools(); savePrefs(); });
  kb("crop", "C", "Tools", "Crop", () => setTool("crop"));
  kb("brush", "B", "Tools", "Brush", () => setTool("brush"));
  kb("eraser", "E", "Tools", "Eraser", () => setTool("eraser"));
  kb("mask", "Q", "Tools", "Refine mask", () => setTool("mask"));
  kb("text", "T", "Tools", "Text", () => setTool("text"));
  kb("eyedrop", "I", "Tools", "Eyedropper", () => setTool("eyedrop"));
  // View
  kb("pan", "Space", "View", "Pan", () => { if (!space && !gesture) { space = true; setCursor(); invalidate(); } }, null, { hold: true, up: () => { if (space === true) { space = false; setCursor(); invalidate(); } } });
  kb("pan2", "H", "View", "Pan", () => { if (!space && !gesture) { space = "h"; setCursor(); invalidate(); } }, null, { hold: true, up: () => { if (space === "h") { space = false; setCursor(); invalidate(); } } });
  kb("zoomHold", "Z", "View", "Zoom", () => { if (!zoomKey) { zoomKey = true; setCursor("zoom-in"); } }, null, { hold: true, up: () => { if (zoomKey) { zoomKey = false; setCursor(); } } });
  info("Wheel · pinch", "View", "Zoom");
  kb("zoomIn", "=|Shift+=", "View", "Zoom in", () => smoothZoom(1.25, rect.width / 2, rect.height / 2), (e) => !(e.shiftKey && tool === "move"), { ctx: "zoom" });
  kb("zoomOut", "-|Shift+-", "View", "Zoom out", () => smoothZoom(0.8, rect.width / 2, rect.height / 2), (e) => !(e.shiftKey && tool === "move"), { ctx: "zoom" });
  kb("fit", "Shift+1", "View", "Fit", () => fit());
  kb("zoom100", "Shift+0", "View", "100%", () => zoomTo100());
  info("Double-click", "View", "Fit ↔ 100%");
  // Edit
  kb("undo", "Ctrl+Z", "Edit", "Undo", () => undo());
  kb("redo", "Ctrl+Shift+Z|Ctrl+Y", "Edit", "Redo", () => redo());
  kb("copy", "Ctrl+C", "Edit", "Copy", () => copyOut2("seen"));
  kb("copyLayer", "Ctrl+Alt+C", "Edit", "Copy layer", () => copyOut2("active"));
  kb("copyMerged", "Ctrl+Shift+C", "Edit", "Copy merged", () => copyOut2("all"));
  kb("cut", "Ctrl+X", "Edit", "Cut", () => cut());
  kb("paste", "Ctrl+V", "Edit", "Paste", () => pasteKey(false));
  kb("pasteInPlace", "Ctrl+Shift+V", "Edit", "Paste in place", () => pasteKey(true));
  kb("export", "Ctrl+E|Ctrl+Shift+S", "Edit", "Export", () => openExport(), null, { typing: true });
  kb("resize", "Ctrl+Alt+I", "Edit", "Size", () => openResize());
  kb("open", "Ctrl+O", "Edit", "Open", () => choose(false));
  kb("saveProject", "Ctrl+S", "Edit", "Save project", () => saveProject());
  // Layers
  info("Ctrl+drag (any tool)", "Layers", "Move layer");
  info("Ctrl click", "Layers", "Pick layer");
  info("Alt click", "Layers", "Pick exact layer");
  info("Shift click", "Layers", "Add to picked");
  info("Double-click a name", "Layers", "Rename");
  info("Right-click", "Layers", "Layers here");
  kb("duplicate", "Ctrl+J", "Layers", "Duplicate", () => copyToLayer());
  kb("newLayer", "Ctrl+Alt+N|Ctrl+Shift+L", "Layers", "New layer", () => layerOps.new());
  kb("group", "Ctrl+G", "Layers", "Group", () => layerOps.group());
  kb("ungroup", "Ctrl+Shift+G", "Layers", "Ungroup", () => layerOps.ungroup());
  kb("clip", "Ctrl+Alt+G", "Layers", "Clip", () => layerOps.clip());
  const blendStep = (d) => { const n = selNode(); if (n) { cycleBlend(n, d); toast(`Blend mode: ${modeOf(n)[1]}`, { ms: 900, info: true }); } };
  kb("blendNext", "Shift+=", "Layers", "Next blend mode", () => blendStep(1), () => tool === "move", { ctx: "blend" });
  kb("blendPrev", "Shift+-", "Layers", "Previous blend mode", () => blendStep(-1), () => tool === "move", { ctx: "blend" });
  info("Ctrl+wheel", "Layers", "Blend mode");
  info("Drag · wheel", "Layers", "Opacity");
  info("Right-click · long-press", "Layers", "Layer menu");
  kb("merge", "Ctrl+Shift+M", "Layers", "Merge down", () => layerOps.merge());
  kb("flatten", "Ctrl+Shift+E", "Layers", "Flatten", () => layerOps.flatten());
  kb("delete", "Delete|Backspace", "Layers", "Delete", () => clearSelected());
  for (let n = 1; n <= 10; n++) kb(`opacity${n * 10}`, String(n % 10), "Layers", `Opacity ${n * 10}%`, () => setOpacityKey(n % 10));
  for (const [id, label, key, dx, dy] of [["Left", "←", "Left", -1, 0], ["Right", "→", "Right", 1, 0], ["Up", "↑", "Up", 0, -1], ["Down", "↓", "Down", 0, 1]]) {
    kb(`nudge${id}`, key, "Layers", `Nudge ${label}`, () => nudge(dx, dy), () => tool === "move");
    kb(`nudge${id}10`, `Shift+${key}`, "Layers", `Nudge ${label} 10`, () => nudge(dx * 10, dy * 10), () => tool === "move");
  }
  kb("transform", "Ctrl+Alt+T", "Layers", "Transform", () => setTool("move"));
  // Selection
  info("Shift drag", "Selection", "Add");
  info("Alt drag", "Selection", "Subtract");
  info("Shift Alt drag", "Selection", "Intersect");
  kb("selectAll", "Ctrl+A", "Selection", "Select all", () => selectAll());
  kb("deselect", "Ctrl+D", "Selection", "Deselect", () => deselect());
  // with no selection, the usual "invert" key inverts the layer's mask (people reach for it after removing a background)
  kb("invert", "Ctrl+Shift+I", "Selection", "Invert", () => { if (!selection && selLayer()?.mask) invertMask(selLayer()); else invertSelection(); });
  kb("invertMask", "Ctrl+I", "Selection", "Invert mask", () => { if (selLayer()?.mask) invertMask(selLayer()); });
  kb("deselectEsc", "Esc", "Selection", "Deselect", () => deselect(), () => !!selection && !crop && !rb.job, { ctx: "sel" });
  info("Shift (while dragging)", "Selection", "Square / circle");
  // Background remover
  kb("removeBg", "Shift+B", "Background remover", "Remove background", () => removeBackground());
  kb("keepRemove", "X", "Background remover", "Keep ↔ Remove", () => { maskBrush.mode = maskBrush.mode === "keep" ? "remove" : "keep"; renderProps(); savePrefs(); }, () => tool === "mask", { ctx: "mask" });
  kb("showMask", "\\", "Background remover", "Show mask", () => { if (selLayer()?.mask) setBgView(rb.view === "mask" ? "photo" : "mask"); });
  kb("cancelBg", "Esc", "Background remover", "Cancel", () => cancelBg(), () => !!rb.job, { ctx: "bg" });
  kb("cancelUp", "Esc", "Upscale", "Cancel", () => upscaler.cancel(), () => upscaler.busy(), { ctx: "bg" });
  // Brush & eraser
  kb("brushSmaller", "[", "Brush & eraser", "Smaller", () => brushKey(false, false), () => isPaint(), { ctx: "paint" });
  kb("brushLarger", "]", "Brush & eraser", "Larger", () => brushKey(true, false), () => isPaint(), { ctx: "paint" });
  kb("brushSofter", "Shift+[", "Brush & eraser", "Softer", () => brushKey(false, true), () => isPaint(), { ctx: "paint" });
  kb("brushHarder", "Shift+]", "Brush & eraser", "Harder", () => brushKey(true, true), () => isPaint(), { ctx: "paint" });
  kb("swapColors", "X", "Brush & eraser", "Swap colours", () => swapColors(), () => tool !== "mask", { ctx: "paint" });
  kb("defaultColors", "D", "Brush & eraser", "Default colours", () => resetColors());
  info("Alt click", "Brush & eraser", "Pick colour");
  info("Shift click", "Brush & eraser", "Straight line");
  info("Alt + right-drag", "Brush & eraser", "Size / hardness");
  // Crop
  kb("rotate", "R", "Crop", "Rotate 90°", () => rotate90(), () => !!crop, { ctx: "crop" });
  kb("applyCrop", "Enter", "Crop", "Apply", () => applyCrop(), () => !!crop, { ctx: "crop" });
  kb("cancelCrop", "Esc", "Crop", "Cancel", () => cancelCrop(), () => !!crop, { ctx: "crop" });
  // Other
  kb("snap", "N|Shift+;", "Other", "Snap", () => toggleSnap());
  info("Alt (while dragging)", "Other", "No snap");
  kb("sheet", "Shift+/", "Other", "Shortcuts", () => K.openSheet());
  // labels built by hand follow the user's keys
  const keyLabels = () => { K.refresh(root); renderTools(); lyFoot.innerHTML = footBtns(); if (doc) { syncFoot(); syncUndo(); renderProps(); } };
  K.onChange(keyLabels);
  keyLabels();
  let marquee = "rect"; // the last marquee shape (M goes back to it from the lasso)
  function brushKey(up, hard) {
    const o = optsOf(tool);
    if (hard) o.hard = clamp(o.hard + (up ? 10 : -10), 0, 100);
    else o.size = clamp(Math.round(o.size * (up ? 1.15 : 1 / 1.15)) + (up ? 1 : -1), 1, 1000);
    renderProps(); showPreview(tool); savePrefs();
  }
  /** Ctrl+V: the browser delivers the paste event (it carries OS images); if it doesn't come, read the clipboard. */
  function pasteKey(inPlace) {
    pasteWant = { inPlace, at: performance.now() };
    const mine = pasteWant;
    setTimeout(() => { if (pasteWant === mine) { pasteWant = null; pasteFallback(mine.inPlace); } }, 250);
    return false; // don't block the browser's paste
  }
  // ── copy, cut, paste ──────────────────────────────────────────────────────
  let clip = null; // in-app copy {canvas, x, y, size (PNG bytes, to recognise it on the OS clipboard)}
  let pasteWant = null; // {inPlace, at} set by Ctrl+V; the paste event or a fallback read finishes it
  /** mode: "seen" (default: what you see, or the layers picked in the Layers card, merged), "all" (every visible layer), "active" (only the active layer's pixels). */
  function copyOut2(mode = "seen") {
    if (crop) applyCrop();
    const b = selection ? selBounds(selection) : null;
    let src, ox, oy;
    const sg = selGroup(), merged = (mode !== "active" && (mode === "all" || multi.size > 0 || doc.layers.length > 1)) || (sg && mode !== "all");
    if (merged) {
      // picked in the Layers card (several, or a group): those merged, shown even if hidden
      const picked = mode !== "all" && (multi.size > 0 || !!sg), nodes = new Set(selNodes());
      const groups = picked ? doc.groups.map((x) => (nodes.has(x) ? { ...x, visible: true } : x)) : doc.groups;
      src = flatCanvas((picked ? selected() : doc.layers).map((l) => asDraw(l, picked && nodes.has(l) ? { visible: true } : {})), groups); ox = 0; oy = 0;
    } else {
      const l = selLayer();
      if (!l) return null;
      if (plain(l)) { src = l.mask && l.maskOn ? maskedCopy(l) : l.canvas; ox = l.x; oy = l.y; }
      else { const bx = pxBox(aabb(l)); src = flatCanvas([asDraw(l, { parent: null, opacity: 1, blend: "normal", visible: true, clip: false })], [], bx); ox = bx.x; oy = bx.y; }
    }
    let x0 = ox, y0 = oy, w = src.width, hh = src.height;
    if (b) {
      x0 = Math.max(Math.floor(b.x), ox, 0); y0 = Math.max(Math.floor(b.y), oy, 0);
      const x1 = Math.min(Math.ceil(b.x + b.w), ox + src.width, doc.w), y1 = Math.min(Math.ceil(b.y + b.h), oy + src.height, doc.h);
      w = x1 - x0; hh = y1 - y0;
      if (w <= 0 || hh <= 0) { toast("Nothing selected", { bad: true }); return null; }
    }
    const c = blank(w, hh), g = c.getContext("2d");
    g.setTransform(1, 0, 0, 1, ox - x0, oy - y0);
    g.drawImage(src, 0, 0);
    if (b) applySel(g, T(-x0, -y0)); // any selection shape, combined ones included
    clip = { canvas: c, x: x0, y: y0, size: -1 };
    const mine = clip;
    const png = c.convertToBlob({ type: "image/png" }).then((bl) => { mine.size = bl.size; return bl; });
    try {
      navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(() => toast(merged ? "Copied (layers merged)" : "Copied"), () => toast("Copied"));
    } catch { toast("Copied"); }
    return clip;
  }
  function cut() {
    const l = selLayer();
    if (!l || !copyOut2("active")) return;
    if (selection) clearSelected();
    else record("Cut", () => { l.canvas = blank(l.canvas.width, l.canvas.height); delete l.preBg; delete l.bgFixed; if (l.kind === "text") { l.kind = "image"; delete l.text; } });
  }
  function pasteCanvas(c, { x, y, name, inPlace } = {}) {
    if (crop) applyCrop(); // the new layer and its undo step belong to the cropped document
    // bigger than the canvas: kept at full size (a smart layer), scaled to fit by its matrix
    const s = !inPlace && (c.width > doc.w || c.height > doc.h) ? Math.min(doc.w / c.width, doc.h / c.height) : 1, scaled = s < 1;
    const w = c.width * s, hh = c.height * s;
    if (x === undefined) {
      // centre of what's on screen, kept on the canvas
      const [cx, cy] = toDoc({ x: rect.width / 2, y: rect.height / 2 });
      x = clamp(Math.round(cx - w / 2), Math.min(0, doc.w - w), Math.max(0, doc.w - w));
      y = clamp(Math.round(cy - hh / 2), Math.min(0, doc.h - hh), Math.max(0, doc.h - hh));
    }
    commitText();
    addLayer(newLayer({ name: name || nextName(), named: !!name, kind: "image", canvas: c, x, y, ...(scaled ? { ta: s, tb: 0, tc: 0, td: s } : {}) }), "Paste");
    if (scaled) toast(`Pasted · ${Math.round(s * 100)}%`, { info: true });
  }
  async function pasteFile(file, inPlace) {
    let r;
    try { r = await decode(file); } catch (e) { toast(e.message, { bad: true }); return; }
    const c = blank(r.bitmap.width, r.bitmap.height);
    c.getContext("2d").drawImage(r.bitmap, 0, 0);
    r.bitmap.close?.();
    if (file.size <= c.width * c.height * 4) knownPx(c, file);
    if (clip && file.type === "image/png" && file.size === clip.size) { pasteCanvas(copyCanvas(clip.canvas), { x: clip.x, y: clip.y, inPlace: true }); return; }
    pasteCanvas(c, { inPlace, x: inPlace ? Math.round((doc.w - c.width) / 2) : undefined, y: inPlace ? Math.round((doc.h - c.height) / 2) : undefined, name: file.name && !/^image\.\w+$/.test(file.name) ? baseName(file.name) : "" });
  }
  // our own paste handler runs before the page-wide drop/paste intake while a photo is open
  addEventListener("paste", (e) => {
    if (!visible || !doc || isTyping(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const inPlace = !!pasteWant?.inPlace;
    pasteWant = null;
    const files = [...(e.clipboardData?.files || [])].filter(isImage);
    if (files.length) { for (const f of files) pasteFile(f, inPlace); return; }
    if (clip) { pasteCanvas(copyCanvas(clip.canvas), { x: clip.x, y: clip.y, inPlace: true }); return; }
    toast("Clipboard empty", { bad: true });
  }, true);
  async function pasteFallback(inPlace) {
    // no paste event came (some browsers when nothing is focused): read the clipboard ourselves
    try {
      const items = await Promise.race([navigator.clipboard.read(), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 1500))]);
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith("image/"));
        if (type) { const b = await it.getType(type); await pasteFile(new File([b], `image.${type.split("/")[1]}`, { type }), inPlace); return; }
      }
    } catch {}
    if (clip) pasteCanvas(copyCanvas(clip.canvas), { x: clip.x, y: clip.y, inPlace: true });
    else toast("Clipboard empty", { bad: true });
  }

  // brush colours: foreground (the brush) and background
  function swapColors() { [brush.color, brush.bg] = [brush.bg, brush.color]; renderProps(); savePrefs(); }
  function resetColors() { brush.color = "#000000"; brush.bg = "#FFFFFF"; renderProps(); savePrefs(); }
  function setOpacityKey(n) {
    const v = n === 0 ? 100 : n * 10;
    if (isPaint()) { optsOf(tool).opacity = v; renderProps(); showPreview(tool); savePrefs(); return; }
    const list = selNodes();
    if (list.length && tool === "move") record("Opacity", () => { for (const l of list) l.opacity = v / 100; });
  }
  function zoomTo100() { const c = { x: rect.width / 2, y: rect.height / 2 }; smoothZoom(1 / view.z, c.x, c.y); }

  let zoomKey = false;
  document.addEventListener("keydown", (e) => {
    if (!visible) return;
    if (!doc) {
      const id = K.match(e)?.a.id;
      if (id === "open") { e.preventDefault(); choose(false); }
      else if (id === "sheet" && !topLayer()) { e.preventDefault(); K.openSheet(); }
      return;
    }
    // Ctrl+E toggles the export popover (also from its file name field); Enter in it = Download
    if (!e.defaultPrevented && K.match(e)?.a.id === "export") { e.preventDefault(); openExport(); return; }
    if (ex.lay && ex.phase === "form" && e.key === "Enter" && !e.defaultPrevented && !e.repeat && !mod(e) && topLayer() === ex.lay) {
      const t = e.target;
      // a text field already handles Enter itself (el.onkeydown); other buttons keep their own Enter
      if (!(t.tagName === "INPUT" && t.type !== "range") && !(t.tagName === "BUTTON" && t.dataset.x) && t.tagName !== "SELECT") { e.preventDefault(); startExport(); }
      return;
    }
    if (e.defaultPrevented || topLayer() || isTyping(e.target)) return;
    K.dispatch(e, () => { if (mod(e)) commitText(); });
  });
  addEventListener("keydown", (e) => { if ((e.key === "Control" || e.key === "Meta") && visible && doc && !crop && !isTyping(e.target) && tool !== "move") setCursor("move"); }, true);
  addEventListener("keyup", (e) => { if ((e.key === "Control" || e.key === "Meta") && visible && doc) setCursor(); }, true);
  addEventListener("blur", () => { if (space) { space = false; setCursor(); } if (modOp) { modOp = null; setCursor(); } });
  // Select tool: show + / − / × next to the cursor while Shift / Alt / both are held
  const trackMods = (e) => {
    if (!visible || !doc) return;
    const op = tool === "select" && !crop && (e.shiftKey || e.altKey) ? (e.shiftKey && e.altKey ? "int" : e.shiftKey ? "add" : "sub") : null;
    if (op !== modOp) { modOp = op; if (!gesture) setCursor(); }
  };
  addEventListener("keydown", trackMods, true);
  addEventListener("keyup", trackMods, true);

  const onResize = () => {
    if (!visible || !doc) return;
    const was = isPhone();
    measure();
    if (view.fitted) fit(view.cap); else invalidate(true);
    if (was !== lastPhone) { lastPhone = was; renderTools(); renderProps(); syncCropUI(); }
  };
  let lastPhone = isPhone();
  new ResizeObserver(onResize).observe(stage);
  addEventListener("quickcut:zoom", () => { checkerPat = null; onResize(); });
  new MutationObserver(() => { checkerPat = null; measure(); invalidate(true); if (doc) drawThumbs(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const warmOn = (e) => { if (doc && e.target.closest?.('[data-p="rmbg"], [data-op="bg"], [data-p="refine"]')) warmBg(); };
  root.addEventListener("pointerover", warmOn);
  root.addEventListener("focusin", warmOn);
  const showResume = () => renderResume(resumeBox, "photo", (rec) => resume(rec));
  const openRecentProject = async (rec) => {
    const blob = await recents.project(rec.id);
    if (blob) { openProject(blob, { pid: rec.id, handle: rec.handle || null, relink: () => recents.open(rec) }); return; }
    const file = await recents.open(rec);
    if (file) openFiles([{ file, handle: rec.handle || undefined }], { asLayers: false });
    else { toast(`Can't open ${rec.name} any more. Choose it again.`, { bad: true }); choose(false); }
  };
  const showRecents = () => renderRecents(recentsBox, "photo", (file, rec) => openFiles([{ file, handle: rec.handle || undefined }], { asLayers: false }), { pickAgain: () => choose(false), onProject: openRecentProject });
  showRecents();
  migrate().finally(showResume);

  // test hook: lets an automated check feed files the same way a drop does
  root._qc = { up: upscaler, open: (files) => openFiles(files.map((file) => ({ file }))), openNew: (files) => openFiles(files.map((file) => ({ file })), { asLayers: false }), stats, get doc() { return doc; }, get view() { return view; }, get selection() { return selection; }, ops: layerOps, cycleBlend: (d) => cycleBlend(selNode(), d), select: (id) => { setSel(id); renderLayers(); }, get last() { return ex.blob; }, renderNow: () => { if (raf) cancelAnimationFrame(raf); raf = 0; frame(); },
    get collapsed() { return [...collapsed]; }, toggleCollapsed: (id) => { if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id); renderLayers(); saveSession(); },
    addMask: () => addMask(selLayer()),
    get tool() { return tool; },
    drawnPx: (l) => asDraw(l).src,
    strokePreview: () => stroke && { scr: stroke.scr, L: mul(docM(), lm(stroke.layer)) },
    // smart layers / crop / resize / session (tests)
    get crop() { return crop; }, lm: (l) => lm(l), resizeImage: (w, hh) => resizeImage(w, hh), resizeCanvas: (w, hh) => resizeCanvas(w, hh),
    rasterize: () => rasterize(selLayer()), resetTransform: () => resetTransform(selLayer()), setCrop: (o) => { Object.assign(crop, o); crop.base = { ...crop.rect }; invalidate(true); },
    undo: () => undo(), redo: () => redo(), get isOpen() { return !!doc && !docEl.hidden; },
    async record() { const d = doc, project = await writeProject(d, "quick"); return project && sessRec(d, project); }, resume: (rec) => resume(rec),
    openProject: (blob, o) => openProject(blob, o), saveProject: () => saveProject(), writeProject: (mode = "best") => writeProject(doc, mode, { fit: false }), flush: () => runSave(),
    /** Memory self-check: what the document, its undo steps and the workers hold (+ the browser's own figure where it gives one). */
    async mem() {
      const seen = new Set();
      let layers = 0;
      for (const l of doc?.layers || []) for (const o of [l.canvas, l.mask, l.maskBase, l.preBg, l.bgFixed]) if (o && !seen.has(o)) { seen.add(o); layers += objBytes(o); }
      let ua = null;
      try { if (crossOriginIsolated && performance.measureUserAgentSpecificMemory) ua = (await performance.measureUserAgentSpecificMemory()).bytes; } catch {}
      return { layersMB: +(layers / 2 ** 20).toFixed(1), undoMB: +(hbytes / 2 ** 20).toFixed(1), undoBudgetMB: BUDGET / 2 ** 20, steps: hist.length, workers: Object.keys(pool), jsHeapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 2 ** 20).toFixed(1) : null, uaMB: ua && +(ua / 2 ** 20).toFixed(1) };
    }, get hist() { return { n: hist.length, i: hi, bytes: hbytes } }, get prefs() { return { autoSel, autoGroup, selMode, selShape } } };

  return {
    openProject: (file, handle) => openProjectFile(file, handle),
    show() {
      visible = true;
      if (!doc) { showRecents(); showResume(); return; }
      measure();
      if (view.fitted) fit(view.cap); else invalidate(true);
    },
    hide() {
      visible = false;
      stopAnts();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (gesture) { const g = gesture; gesture = null; g.cancel?.(); }
      pointers.clear();
      pinch = null;
      space = false;
      commitText();
    },
    back() {
      if (rb.job) return cancelBg();
      if (upscaler.busy()) return upscaler.cancel();
      if (editing) { commitText(); return true; }
      if (crop) { cancelCrop(); return true; }
      if (selection) { deselect(); return true; }
      return false;
    },
  };
}

function hexRgb(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex) || [0, "ff", "ff", "ff"];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
