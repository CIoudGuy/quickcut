// QuickCut Color: pick colours from images. Open one or several images, hover for a colour chip,
// click (or press Enter) to pick, keep a history per image, extract a palette, export it as a
// picture in Palette Studio. Everything stays in the browser.
//
// Speed: the image lives in one GPU canvas that is only ever scaled by CSS. The colour readout reads
// only the one pixel under the cursor, never the whole image. Palette extraction runs in a Worker on a small downscaled copy.
import {
  h, $, esc, icon, isPhone, fmtAgo, baseName, toast, intake, pickFiles, recents, thumbOf, copyText, mod, isTyping, topLayer, syncSlider, openLayer, session, renderResume, makeMovable,
} from "../shared/ui.js";
import { createKeys, baseKey } from "../shared/keys.js";
import * as store from "./store.js";
import { screenPickKind, pickFromScreen } from "./screenpick.js";

const CSS = new URL("color.css", import.meta.url).href;
const IMAGE_NAME = /\.(png|jpe?g|webp|gif|bmp|avif|ico|jfif)$/i;
const isImage = (f) => f && (/^image\//.test(f.type) || IMAGE_NAME.test(f.name || ""));
const PICK_TYPES = [{ description: "Images", accept: { "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"] } }];
const MAX_DOCS = 30, MAX_PIXELS = 64e6, MAX_SIDE = 16384;
const PAL_SIZE = 160;
const K = createKeys({ id: "color", title: "Color" });

// ── colour maths ────────────────────────────────────────────────────────────
const hex2 = (n) => n.toString(16).padStart(2, "0");
const toHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();
const rgbOf = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
function hslOf(hex) {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let hh = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    hh = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh *= 60;
  }
  return [Math.round(hh) % 360, Math.round(s * 100), Math.round(l * 100)];
}

export function mount(root) {
  if (!document.querySelector(`link[href="${CSS}"]`)) document.head.append(h(`<link rel="stylesheet" href="${CSS}">`));
  root.classList.add("cl");
  root.innerHTML = `
    <div class="empty cl-empty">
      <section class="cl-cloud" role="status" aria-label="Old cloud data" hidden></section>
      <div class="resume-box" hidden></div>
      <button class="drop cl-drop" type="button">
        <span class="glyph">${icon("eyedrop", 22)}</span>
        <span class="title">Open images</span>
        <span class="hint">JPG, PNG, WebP, AVIF, GIF, BMP, ICO</span>
      </button>
      <section class="recents" aria-label="Recent images" hidden><span class="label">Recent</span><div class="grid"></div></section>
      <div class="cl-oldcloud" hidden><button class="btn-g sm cl-oldbtn" type="button" aria-haspopup="dialog">Old cloud colors</button></div>
      <a class="credit-phone" href="https://github.com/CIoudGuy/quickcut" target="_blank" rel="noopener">Open source</a>
    </div>
    <div class="cl-edit" hidden>
      <div class="actions">
        <button class="ib cl-undo" type="button" data-kact="undo" aria-label="Undo" title="Undo" disabled>${icon("undo")}</button>
        <button class="ib cl-redo" type="button" data-kact="redo" aria-label="Redo" title="Redo" disabled>${icon("redo")}</button>
        <button class="ib cl-more-a phone-only" type="button" aria-label="Undo and redo" title="Undo and redo" aria-haspopup="dialog" aria-expanded="false">${icon("M3 8a.9.9 0 1 0 1.8 0a.9.9 0 1 0-1.8 0M7.1 8a.9.9 0 1 0 1.8 0a.9.9 0 1 0-1.8 0M11.2 8a.9.9 0 1 0 1.8 0a.9.9 0 1 0-1.8 0")}</button>
        <span class="sep cl-sep-u"></span>
        <button class="btn-2 cl-add" type="button" data-kact="open" aria-label="Add images" title="Add images">${icon("plus")}<span class="desk-only">Add images</span></button>
        <button class="ib cl-screen" type="button" data-kact="pickScreen" aria-label="Pick from screen" title="Pick from screen" hidden>${icon("eyedrop")}</button>
        <span class="file phone-only"><span class="n cl-name"></span></span>
        <span class="spacer desk-only"></span>
        <span class="sep desk-only" style="margin:0 4px"></span>
        <button class="btn-p cl-studio" type="button" data-kact="studio" title="Palette Studio" aria-haspopup="dialog" aria-expanded="false">${icon("palette")}<span class="desk-only">Palette Studio</span><span class="phone-only">Studio</span></button>
        <button class="ib cl-keysb desk-only" type="button" data-kact="sheet" aria-label="Shortcuts" title="Shortcuts">?</button>
      </div>
      <div class="cl-body">
        <div class="cl-left">
          <section class="cl-stage" aria-label="Image" data-wheel-zoom>
            <div class="cl-edge"></div>
            <div class="cl-box"></div>
            <span class="cl-cur" aria-hidden="true" hidden></span>
            <canvas class="cl-grid" aria-hidden="true"></canvas>
            <span class="cl-chip mono" hidden></span>
            <div class="cl-zoomchip float" role="group" aria-label="Image zoom">
              <button class="ib sm cl-zo" type="button" data-kact="zoomOut" aria-label="Zoom out" title="Zoom out">${icon("minus")}</button>
              <button class="cl-zp mono" type="button" data-kact="actual" title="Actual size" aria-label="Actual size">100%</button>
              <button class="ib sm cl-zi" type="button" data-kact="zoomIn" aria-label="Zoom in" title="Zoom in">${icon("plus")}</button>
              <span class="sep cl-zsep" aria-hidden="true"></span>
              <button class="btn-g sm cl-zf" type="button" data-kact="fit" title="Fit">Fit</button>
            </div>
          </section>
          <div class="cl-thumbs" role="tablist" aria-label="Images"></div>
        </div>
        <aside class="cl-panel">
          <section class="cl-pick" aria-label="Picked colour">
            <span class="cl-swatch"></span>
            <div class="cl-values"></div>
          </section>
          <section class="cl-sec" aria-label="History">
            <div class="cl-sec-head"><span class="label">History</span><span class="cl-badge mono cl-hcount" hidden></span><span class="spacer"></span>
              <button class="ib sm cl-save" type="button" aria-label="Save this history" title="Save">${icon("M4 2.5h8v11l-4-3-4 3z")}</button>
              <button class="ib sm cl-clear" type="button" aria-label="Clear this history" title="Clear this history">${icon("trash")}</button></div>
            <div class="cl-hist"></div>
          </section>
          <section class="cl-sec desk-only cl-savedsec" aria-label="Saved histories" hidden>
            <button class="cl-savedtoggle" type="button" aria-expanded="false"><span class="label">Saved</span><span class="cl-badge mono cl-scount"></span><span class="spacer"></span><span class="chev">${icon("chevR", 14)}</span></button>
            <div class="cl-saved" hidden></div>
          </section>
          <section class="cl-sec" aria-label="Palette">
            <div class="cl-sec-head"><span class="label">Palette</span><span class="spacer"></span>
              <div class="cl-count" role="group" aria-label="Number of colours"><button class="ib sm cl-fewer" type="button" aria-label="Fewer colours">${icon("minus", 12)}</button><span class="mono cl-n" aria-live="polite"></span><button class="ib sm cl-more" type="button" aria-label="More colours">${icon("plus", 12)}</button></div></div>
            <div class="cl-pal"></div>
          </section>
        </aside>
      </div>
    </div>`;

  const q = (s) => root.querySelector(s);
  const emptyEl = q(".cl-empty"), editEl = q(".cl-edit"), dropBtn = q(".cl-drop"), cloudBox = q(".cl-cloud"), recentsBox = q(".recents"), resumeBox = q(".resume-box");
  const stage = q(".cl-stage"), box = q(".cl-box"), edge = q(".cl-edge"), curEl = q(".cl-cur"), chip = q(".cl-chip"), gridCv = q(".cl-grid");
  makeMovable(q(".cl-zoomchip"), "color.zoom");
  const zo = q(".cl-zo"), zi = q(".cl-zi"), zp = q(".cl-zp"), zf = q(".cl-zf");
  const thumbsEl = q(".cl-thumbs"), swatch = q(".cl-swatch"), valuesEl = q(".cl-values"), histEl = q(".cl-hist"), savedEl = q(".cl-saved"), palEl = q(".cl-pal");
  const nEl = q(".cl-n");
  const nameEl = q(".cl-name"), studioBtn = q(".cl-studio");

  let docs = [], cur = null, active = false;
  let palN = store.prefs.paletteN();
  let H = store.loadHistories();
  // undo / redo of saved histories change the screen at once; the (possibly large) localStorage write follows in the background
  let hTimer = 0;
  const flushH = () => { if (hTimer) { clearTimeout(hTimer); hTimer = 0; store.saveHistories(H); } };
  const persistH = () => { clearTimeout(hTimer); hTimer = setTimeout(flushH, 250); };
  addEventListener("pagehide", flushH);

  // ── undo / redo ───────────────────────────────────────────────────────────
  // A linear stack of steps {label, undo, redo, done, drop?}. In memory only (100 steps). Every step
  // changes the same state the tool saves (the session, localStorage), so a reload shows the undone
  // state. View state (zoom, pan, which image is shown) is never a step. Steps that take an
  // image out of the tool keep its canvas alive until the step falls off the stack (drop).
  const UNDO_MAX = 100;
  const ustack = [];
  let uptr = 0;
  let justOpened = false, opened = [], openedResumed = false; // see markOpened
  const undoBtn = q(".cl-undo"), redoBtn = q(".cl-redo");
  function syncUndo() {
    const u = ustack[uptr - 1], r = ustack[uptr];
    undoBtn.disabled = !u && !justOpened; redoBtn.disabled = !r;
    undoBtn.title = K.tip(u ? `Undo ${u.label}` : "Undo", "undo");
    undoBtn.setAttribute("aria-label", u ? `Undo ${u.label}` : "Undo");
    redoBtn.title = K.tip(r ? `Redo ${r.label}` : "Redo", "redo");
    redoBtn.setAttribute("aria-label", r ? `Redo ${r.label}` : "Redo");
  }
  function record(label, undoFn, redoFn, extra) {
    const e = { label, undo: undoFn, redo: redoFn, done: true, ...extra };
    justOpened = false;
    for (const x of ustack.splice(uptr)) x.drop?.(false);
    ustack.push(e);
    while (ustack.length > UNDO_MAX) ustack.shift().drop?.(true);
    uptr = ustack.length;
    syncUndo();
    return e;
  }
  function undo() {
    if (justOpened) { closeOpened(); return; }
    const e = ustack[uptr - 1];
    if (!e || e.undo() === false) return;
    e.done = false; uptr--; syncUndo();
  }
  function redo() {
    notJustOpened();
    const e = ustack[uptr];
    if (!e || e.redo() === false) return;
    e.done = true; uptr++; syncUndo();
  }
  /** the toast's Undo button: only while that step is still the latest one */
  const undoIf = (e) => { if (ustack[uptr - 1] === e) undo(); };
  function clearUndo() { for (const x of ustack.splice(0)) x.drop?.(x.done); uptr = 0; syncUndo(); }
  undoBtn.onclick = undo; redoBtn.onclick = redo;
  // on phones the two buttons don't fit the row: they live in the "more" menu
  q(".cl-more-a").onclick = (ev) => {
    const el = h(`<section role="dialog" aria-label="Undo and redo" class="cl-undomenu"><button class="btn-2 big um-u" type="button">${icon("undo")}<span></span></button><button class="btn-2 big um-r" type="button">${icon("redo")}<span></span></button></section>`);
    const u = ustack[uptr - 1], r = ustack[uptr];
    const bu = el.querySelector(".um-u"), br = el.querySelector(".um-r");
    bu.querySelector("span").textContent = u ? `Undo ${u.label}` : justOpened ? "Undo" : "Nothing to undo"; bu.disabled = !u && !justOpened;
    br.querySelector("span").textContent = r ? `Redo ${r.label}` : "Nothing to redo"; br.disabled = !r;
    const layer = openLayer(el, { anchor: ev.currentTarget, width: 300 });
    bu.onclick = () => { layer.close(); undo(); };
    br.onclick = () => { layer.close(); redo(); };
  };
  addEventListener("pagehide", () => { for (let i = 0; i < uptr; i++) ustack[i].leave?.(); });
  // Opened the wrong image: the first Undo right after opening from the start screen (nothing done
  // yet) closes it again and shows the start screen. Anything else (a step, a click, a key, the
  // wheel) ends that chance; adding from the start screen is no undo step, so undoing later never
  // goes back to the start screen by accident.
  function notJustOpened() { if (!justOpened) return; justOpened = false; opened = []; syncUndo(); }
  function markOpened(list, resumed) {
    for (const x of ustack.splice(uptr)) x.drop?.(false); // a redo must not bring back what was there before
    justOpened = true; opened = list; openedResumed = resumed;
    syncUndo();
  }
  function closeOpened() {
    const list = opened.filter((d) => docs.includes(d));
    justOpened = false; opened = [];
    if (!list.length) { syncUndo(); return; }
    if (openedResumed) { // a Continue keeps its session
      for (const d of list) docs.splice(docs.indexOf(d), 1);
      cur = null;
      if (docs.length) select(docs[0]); else showEmpty();
    } else detach(list);
    list.forEach(disposeDoc);
    syncUndo();
  }
  const UNDO_SEL = '[data-kact="undo"], .cl-more-a, .cl-undomenu .um-u';
  document.addEventListener("keydown", (e) => { if (justOpened && baseKey(e) && K.match(e)?.a.id !== "undo") notJustOpened(); }, true);
  document.addEventListener("pointerdown", (e) => { if (justOpened && !e.target.closest?.(UNDO_SEL)) notJustOpened(); }, true);
  document.addEventListener("wheel", notJustOpened, { capture: true, passive: true });
  /** a step for the colour list of one image */
  function recordColors(doc, label, before) {
    const after = { colors: [...doc.colors], sel: doc.sel };
    const apply = (st) => {
      doc.colors = [...st.colors]; doc.sel = Math.min(st.sel, doc.colors.length - 1);
      if (!docs.includes(doc)) return;
      if (cur !== doc) select(doc); else { renderValues(); renderHistory(); }
    };
    return record(label, () => apply(before), () => apply(after));
  }

  // ── intake ────────────────────────────────────────────────────────────────
  const choose = async () => { const f = await pickFiles({ accept: "image/*", multiple: true, types: PICK_TYPES }); if (f.length) addFiles(f); };
  dropBtn.onclick = choose;
  q(".cl-add").onclick = choose;
  intake(root, (items) => addFiles(items), { isActive: () => active, filter: isImage });

  async function decode(file) {
    let bmp = await createImageBitmap(file);
    const { width: w, height: hh } = bmp;
    const s = Math.min(1, MAX_SIDE / Math.max(w, hh), Math.sqrt(MAX_PIXELS / (w * hh)));
    if (s < 1) {
      const r = await createImageBitmap(bmp, { resizeWidth: Math.max(1, Math.round(w * s)), resizeHeight: Math.max(1, Math.round(hh * s)), resizeQuality: "high" });
      bmp.close();
      bmp = r;
    }
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width; canvas.height = bmp.height;
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Image. Move the pointer to see the colour, click or press Enter to pick, arrow keys nudge one pixel.");
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    const out = { canvas, w: bmp.width, h: bmp.height, fullW: w, fullH: hh };
    bmp.close();
    return out;
  }

  async function addFiles(items) {
    items = items.filter((it) => isImage(it.file));
    if (!items.length) { toast("That isn't an image I can open.", { bad: true }); return; }
    const fromStart = !cur && !docs.length;
    let first = null, bad = 0;
    const added = [];
    for (const { file, handle } of items) {
      if (docs.length >= MAX_DOCS) { toast(`QuickCut Color keeps ${MAX_DOCS} images open at once. Close some to add more.`, { bad: true }); break; }
      try {
        const img = await decode(file);
        const key = await store.historyKey(file);
        const saved = H[key] ? store.view(key, H[key]) : null;
        const doc = newDoc({ name: file.name, ...img, key, colors: saved ? [...saved.colors] : [] });
        doc.file = file; doc.handle = handle;
        added.push(doc);
        first ||= doc;
        if (!doc.thumb) doc.thumb = await thumbOf(doc.canvas, 160);
        setThumb(doc);
        recents.add("color", { file, handle, thumb: await thumbOf(doc.canvas, 320), sub: `${doc.fullW} × ${doc.fullH}` });
        if (!cur) select(doc); else renderThumbs();
      } catch {
        bad++;
        toast(`Couldn't open ${file.name || "that file"}. It may be damaged or not an image this browser can read.`, { bad: true });
      }
    }
    if (first && cur !== first && items.length) select(first);
    if (bad && !docs.length) showEmpty();
    if (fromStart && added.length) markOpened(added, false); else recordAdd(added);
  }
  async function addFromUrl(name, dataUrl, key, colors) {
    const file = new File([await (await fetch(dataUrl)).blob()], name, { type: (dataUrl.match(/^data:([^;,]+)/) || [])[1] || "image/png" });
    const img = await decode(file);
    const doc = newDoc({ name, ...img, key, colors });
    doc.file = file;
    doc.thumb = await thumbOf(doc.canvas, 160);
    setThumb(doc);
    return doc;
  }
  function newDoc(d) {
    const doc = { id: Math.random().toString(36).slice(2), sel: d.colors.length ? 0 : -1, palette: null, palFor: 0, view: { x: 0, y: 0, w: 1, h: 1 }, ...d };
    docs.push(doc);
    return doc;
  }
  const setThumb = (doc) => { doc.thumbUrl = URL.createObjectURL(doc.thumb); };

  /** take images out of the tool without freeing them (undo can bring them back); returns the first one's position */
  function detach(list) {
    const wasCur = list.includes(cur);
    let first = -1;
    for (const d of list) { const i = docs.indexOf(d); if (i < 0) continue; if (first < 0) first = i; docs.splice(i, 1); }
    if (first < 0) return -1;
    if (wasCur) {
      cur = null;
      if (docs.length) select(docs[Math.min(first, docs.length - 1)]); else { session.clear("color"); showEmpty(); }
    } else { renderThumbs(); touchSession(); }
    return first;
  }
  function disposeDoc(doc) {
    if (doc.thumbUrl) URL.revokeObjectURL(doc.thumbUrl);
    doc.canvas.width = doc.canvas.height = 0;
  }
  function recordAdd(list) {
    if (!list.length) return;
    record(list.length > 1 ? "Add images" : "Add image", () => { detach(list); }, () => {
      const n = list.filter((d) => !docs.includes(d)).length;
      if (docs.length + n > MAX_DOCS) { toast(`QuickCut Color keeps ${MAX_DOCS} images open at once. Close some first.`, { bad: true }); return false; }
      for (const d of list) if (!docs.includes(d)) docs.push(d);
      select(list[0]);
    }, { drop: (done) => { if (!done) list.forEach(disposeDoc); } });
  }
  function closeDoc(doc) {
    let at = detach([doc]);
    if (at < 0) return;
    const e = record("Close image", () => {
      if (docs.length >= MAX_DOCS) { toast(`QuickCut Color keeps ${MAX_DOCS} images open at once. Close some first.`, { bad: true }); return false; }
      docs.splice(Math.min(at, docs.length), 0, doc);
      select(doc);
    }, () => { at = detach([doc]); }, { drop: (done) => { if (done) disposeDoc(doc); } });
    toast(`Closed ${doc.name}`, { action: "Undo", onAction: () => undoIf(e) });
  }

  // ── screens ───────────────────────────────────────────────────────────────
  function showEmpty() {
    cur = null; pos = null;
    editEl.hidden = true; emptyEl.hidden = false;
    refreshRecents();
    renderResume(resumeBox, "color", (rec) => restore(rec.state));
  }
  function select(doc, keepView) {
    cur = doc; pos = null;
    if (!keepView) Object.assign(doc.view, { z: 1, tx: 0, ty: 0 }); // a new or switched image starts at "fit", like the original
    emptyEl.hidden = true; editEl.hidden = false;
    box.replaceChildren(doc.canvas);
    doc.canvas.classList.add("cl-canvas");
    hideChip(); stopZoomAnim();
    layout();
    renderAll();
    ensurePalette();
  }

  // ── stage: zoom, pan, pointer to image pixel ──────────────────────────────
  // The canvas is laid out once to fit the stage ("base"); zoom and pan are only a CSS transform
  // on its box (GPU), so nothing is redrawn or read back while zooming. Pixel lookups use the
  // canvas' transformed on-screen rectangle, so picking stays exact at any zoom. The view works like
  // QuickCut Photo: wheel / pinch zoom around the pointer (x1.1 per notch, eased), double-click
  // toggles fit <-> 100%, free panning in every direction.
  let pos = null; // {x, y, cx?, cy?, kbd?, hex?}: image pixel under the pointer (cx, cy: client point)
  let pointer = null; // "mouse" | "touch"
  let spaceDown = false, lastTap = null, zanim = null;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const zk = () => { const r = stage.getBoundingClientRect(); return r.width / (stage.offsetWidth || 1) || 1; };
  const stagePt = (cx, cy) => { const r = stage.getBoundingClientRect(), k = r.width / (stage.offsetWidth || 1) || 1; return { x: (cx - r.left) / k, y: (cy - r.top) / k }; };
  // zoom is shown as % of actual pixels: 1% to 12800%. v.z is relative to "fit" (what a session stores)
  const MIN_ABS = 0.01, MAX_ABS = 128, KEEP = 64, GRID_FROM = 8, ZKEY = 1.25;
  const fitScale = () => cur.view.w / cur.w;
  const zlim = () => { const s = fitScale() || 1; return [MIN_ABS / s, MAX_ABS / s]; };
  function layout() {
    if (!cur) return;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const pad = isPhone() ? 12 : 32;
    const s = Math.min((sw - pad * 2) / cur.w, (sh - pad * 2) / cur.h);
    const w = Math.max(1, Math.round(cur.w * s)), hh = Math.max(1, Math.round(cur.h * s));
    const v = cur.view;
    Object.assign(v, { x: Math.round((sw - w) / 2), y: Math.round((sh - hh) / 2), w, h: hh });
    v.z ||= 1; v.tx ||= 0; v.ty ||= 0;
    Object.assign(box.style, { left: `${v.x}px`, top: `${v.y}px`, width: `${w}px`, height: `${hh}px` });
    applyView();
  }
  /** free panning: any position is fine as long as at least 64 px of the image stay on screen */
  function clampPan() {
    const v = cur.view, sw = stage.clientWidth, sh = stage.clientHeight, W = v.w * v.z, Hh = v.h * v.z;
    const kx = Math.min(KEEP, W), ky = Math.min(KEEP, Hh);
    v.tx = clamp(v.x + v.tx, kx - W, sw - kx) - v.x;
    v.ty = clamp(v.y + v.ty, ky - Hh, sh - ky) - v.y;
  }
  const isFit = () => { const v = cur.view; return Math.abs(v.z - 1) < 1e-6 && Math.abs(v.tx) < 0.5 && Math.abs(v.ty) < 0.5; };
  function applyView() {
    const v = cur.view, [zmin, zmax] = zlim();
    v.z = clamp(v.z, zmin, zmax);
    clampPan();
    box.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.z})`;
    // the faint edge, glow and transparency checkerboard sit on an unscaled element behind the image
    { const sw = stage.clientWidth, sh = stage.clientHeight, L = v.x + v.tx, T = v.y + v.ty, W = v.w * v.z, Hh = v.h * v.z;
      const cl = Math.max(L, -40), ct = Math.max(T, -40), cr = Math.min(L + W, sw + 40), cb = Math.min(T + Hh, sh + 40);
      Object.assign(edge.style, { transform: `translate(${cl}px, ${ct}px)`, width: `${Math.max(0, cr - cl)}px`, height: `${Math.max(0, cb - ct)}px`, backgroundPosition: `${L - cl}px ${T - ct}px` }); }
    const abs = fitScale() * v.z;
    cur.canvas.style.imageRendering = abs >= 2 ? "pixelated" : "auto";
    const pc = abs * 100;
    zp.textContent = `${pc >= 10 ? Math.round(pc) : pc.toFixed(1)}%`;
    zo.disabled = v.z <= zmin * 1.0005; zi.disabled = v.z >= zmax * 0.9995;
    scheduleDraw();
    touchSession();
  }
  /** zoom to relative z, keeping the stage point (sx, sy) fixed */
  function zoomAt(z, sx, sy) {
    if (!cur) return;
    const v = cur.view, [zmin, zmax] = zlim();
    z = clamp(z, zmin, zmax);
    const r = z / v.z;
    v.tx = sx - (sx - (v.x + v.tx)) * r - v.x;
    v.ty = sy - (sy - (v.y + v.ty)) * r - v.y;
    v.z = z;
    applyView();
  }
  /** eased zoom by factor f (a mouse notch, a key press, a button): about 80 ms, like Photo */
  function smoothZoom(f, sx, sy) {
    if (!cur) return;
    const [zmin, zmax] = zlim();
    const to = clamp((zanim ? zanim.to : cur.view.z) * f, zmin, zmax);
    if (!zanim) { zanim = { to, sx, sy, last: performance.now(), timer: 0 }; requestAnimationFrame(stepZoom); }
    else Object.assign(zanim, { to, sx, sy });
    clearTimeout(zanim.timer);
    // if frames aren't running (hidden page), land on the target anyway
    zanim.timer = setTimeout(() => { if (zanim) { const a = zanim; zanim = null; zoomAt(a.to, a.sx, a.sy); } }, 160);
  }
  function stepZoom(now) {
    const a = zanim;
    if (!a) return;
    if (!cur) { clearTimeout(a.timer); zanim = null; return; }
    const dt = Math.max(1, now - a.last);
    a.last = now;
    const z = cur.view.z, r = a.to / z, done = Math.abs(Math.log(r)) < 0.002;
    zoomAt(done ? a.to : z * Math.exp(Math.log(r) * Math.min(1, dt / 45)), a.sx, a.sy);
    if (done) { clearTimeout(a.timer); zanim = null; return; }
    requestAnimationFrame(stepZoom);
  }
  const stopZoomAnim = () => { if (zanim) { clearTimeout(zanim.timer); zanim = null; } };
  /** stage position of the centre of image pixel p */
  function imgPt(p) {
    const v = cur.view;
    return { x: v.x + v.tx + ((p.x + 0.5) / cur.w) * v.w * v.z, y: v.y + v.ty + ((p.y + 0.5) / cur.h) * v.h * v.z };
  }
  /** where view buttons and keys zoom around: the pointer if it is over the image, else the middle */
  const anchor = () => (pos && cur ? (pos.cx != null && !pos.kbd ? stagePt(pos.cx, pos.cy) : imgPt(pos)) : { x: stage.clientWidth / 2, y: stage.clientHeight / 2 });
  const fitView = () => { if (cur) { stopZoomAnim(); cur.view.z = 1; cur.view.tx = cur.view.ty = 0; applyView(); } };
  const actualView = (a = anchor()) => { if (cur) { stopZoomAnim(); zoomAt(cur.w / cur.view.w, a.x, a.y); } };
  const zoomBy = (f) => { if (cur) { const a = anchor(); smoothZoom(f, a.x, a.y); } };
  new ResizeObserver(layout).observe(stage);
  addEventListener("quickcut:zoom", layout);
  zo.onclick = () => zoomBy(1 / ZKEY);
  zi.onclick = () => zoomBy(ZKEY);
  zp.onclick = () => actualView();
  zf.onclick = fitView;

  /** image pixel under a client point, or null outside the image */
  function pixelAt(cx, cy) {
    if (!cur) return null;
    const r = cur.canvas.getBoundingClientRect();
    const fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height;
    if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return null;
    return { x: Math.min(cur.w - 1, Math.floor(fx * cur.w)), y: Math.min(cur.h - 1, Math.floor(fy * cur.h)) };
  }

  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const pctx = probe.getContext("2d", { willReadFrequently: true });
  /** colour at (x, y): reads exactly one pixel, never the whole image */
  function sample(x, y) {
    pctx.clearRect(0, 0, 1, 1);
    pctx.drawImage(cur.canvas, x, y, 1, 1, 0, 0, 1, 1);
    const d = pctx.getImageData(0, 0, 1, 1).data;
    return toHex(d[0], d[1], d[2]);
  }

  let raf = 0;
  const scheduleDraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawGrid(); drawChip(); }); };
  function hideChip() {
    chip.hidden = curEl.hidden = true;
    pos = null;
  }
  /** a subtle pixel grid from 800%: only the lines in the visible part of the image */
  let gridOn = false;
  function drawGrid() {
    if (!cur || !active) return;
    const v = cur.view, cell = fitScale() * v.z;
    if (cell < GRID_FROM) { if (gridOn) { gridCv.width = gridCv.height = 0; gridOn = false; } return; }
    const sw = stage.clientWidth, sh = stage.clientHeight, r = stage.getBoundingClientRect();
    const dpr = devicePixelRatio || 1, kx = (r.width * dpr) / sw || 1;
    const dw = Math.max(1, Math.round(r.width * dpr)), dh = Math.max(1, Math.round(r.height * dpr));
    if (gridCv.width !== dw || gridCv.height !== dh) { gridCv.width = dw; gridCv.height = dh; }
    gridCv.style.width = `${sw}px`; gridCv.style.height = `${sh}px`;
    gridOn = true;
    const ctx = gridCv.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, dw, dh);
    const L = v.x + v.tx, T = v.y + v.ty, R = L + cur.w * cell, B = T + cur.h * cell;
    const x0 = Math.max(0, L), x1 = Math.min(sw, R), y0 = Math.max(0, T), y1 = Math.min(sh, B);
    if (x1 <= x0 || y1 <= y0) return;
    const i0 = Math.max(0, Math.floor((x0 - L) / cell)), i1 = Math.min(cur.w, Math.ceil((x1 - L) / cell));
    const j0 = Math.max(0, Math.floor((y0 - T) / cell)), j1 = Math.min(cur.h, Math.ceil((y1 - T) / cell));
    ctx.globalAlpha = Math.min(1, (cell - GRID_FROM) / 8 + 0.4);
    ctx.lineWidth = 1;
    for (const [col, off] of [["rgba(0,0,0,0.22)", 0], ["rgba(255,255,255,0.14)", 1]]) {
      ctx.strokeStyle = col;
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) { const X = Math.round((L + i * cell) * kx) + off + 0.5; if (X < x0 * kx - 2 || X > x1 * kx + 2) continue; ctx.moveTo(X, y0 * kx); ctx.lineTo(X, y1 * kx); }
      for (let j = j0; j <= j1; j++) { const Y = Math.round((T + j * cell) * kx) + off + 0.5; if (Y < y0 * kx - 2 || Y > y1 * kx + 2) continue; ctx.moveTo(x0 * kx, Y); ctx.lineTo(x1 * kx, Y); }
      ctx.stroke();
    }
  }
  /** the hex chip next to the pointer (above the finger on touch); a ring marks the pixel for keys and touch */
  function drawChip() {
    if (!cur || !pos || !active) return;
    if (pos.cx != null && !pos.kbd) { // the pointer stays still while the view moves: look the pixel up again
      const p = pixelAt(pos.cx, pos.cy);
      if (!p) { hideChip(); return; }
      pos.x = p.x; pos.y = p.y;
    }
    const hex = sample(pos.x, pos.y);
    pos.hex = hex;
    chip.textContent = hex;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const g = imgPt(pos);
    const a = pos.cx != null && !pos.kbd ? stagePt(pos.cx, pos.cy) : g;
    let ty = pointer === "touch" ? a.y - 64 : a.y + 22;
    if (ty < 8) ty = a.y + (pointer === "touch" ? 64 : 22);
    if (ty > sh - 30) ty = a.y - 40;
    Object.assign(chip.style, { left: `${Math.max(40, Math.min(sw - 40, a.x))}px`, top: `${ty}px` });
    const ring = pointer === "touch" || pos.kbd;
    Object.assign(curEl.style, { left: `${a.x}px`, top: `${a.y}px` });
    curEl.hidden = !ring;
    chip.hidden = false;
  }

  // mouse, pen and touch on the stage
  const touches = new Map();
  let panning = null, gesture = null, tapStart = null;
  const inChip = (e) => e.target.closest?.(".cl-zoomchip");
  const setPos = (e, kind) => {
    const p = pixelAt(e.clientX, e.clientY);
    if (!p) return false;
    pointer = kind;
    pos = { ...p, cx: e.clientX, cy: e.clientY };
    return true;
  };
  stage.addEventListener("pointermove", (e) => {
    if (!cur) return;
    if (panning && e.pointerId === panning.id) {
      const k = zk();
      cur.view.tx += e.clientX / k - panning.x; cur.view.ty += e.clientY / k - panning.y;
      panning.x = e.clientX / k; panning.y = e.clientY / k;
      applyView();
      return;
    }
    if (e.pointerType === "touch") {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gesture) { pinch(); return; }
      if (pointer !== "touch") return;
      if (tapStart && Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) > 6) tapStart.moved = true;
    }
    if (inChip(e)) return;
    if (!setPos(e, e.pointerType === "touch" ? "touch" : "mouse")) { if (e.pointerType !== "touch") hideChip(); return; }
    scheduleDraw();
  });
  stage.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch" && !panning) hideChip(); });
  function pinch() {
    const [a, b] = [...touches.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const m = stagePt((a.x + b.x) / 2, (a.y + b.y) / 2);
    zoomAt(cur.view.z * (d / gesture.d), m.x, m.y);
    cur.view.tx += m.x - gesture.mx; cur.view.ty += m.y - gesture.my;
    applyView();
    Object.assign(gesture, { d, mx: m.x, my: m.y });
  }
  /** a second tap / click near the first one within 320 ms toggles fit <-> 100% (as in Photo) */
  function doubleAt(e) {
    const k = zk(), t = e.timeStamp;
    if (lastTap && t - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) / k < 24) {
      lastTap = null;
      const p = stagePt(e.clientX, e.clientY);
      stopZoomAnim();
      if (isFit()) actualView(p); else fitView();
      return true;
    }
    lastTap = { t, x: e.clientX, y: e.clientY };
    return false;
  }
  stage.addEventListener("pointerdown", (e) => {
    if (!cur || inChip(e)) return;
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { stage.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
      if (touches.size >= 2) { // two fingers: zoom and pan, no picking
        hideChip(); pointer = null; lastTap = null; stopZoomAnim();
        const [a, b] = [...touches.values()], m = stagePt((a.x + b.x) / 2, (a.y + b.y) / 2);
        gesture = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: m.x, my: m.y };
        return;
      }
      tapStart = { x: e.clientX, y: e.clientY, moved: false };
      if (setPos(e, "touch")) scheduleDraw();
      else pointer = "touch";
      return;
    }
    if (e.button === 1 || (e.button === 0 && spaceDown)) { // pan
      e.preventDefault();
      try { stage.setPointerCapture(e.pointerId); } catch {}
      const k = zk();
      panning = { id: e.pointerId, x: e.clientX / k, y: e.clientY / k };
      stage.classList.add("panning");
      hideChip();
      return;
    }
    if (e.button > 0) return;
    if (doubleAt(e)) return;
    if (setPos(e, "mouse")) { drawChip(); pick(); }
  });
  const endPointer = (e) => {
    if (panning && e.pointerId === panning.id) { panning = null; stage.classList.remove("panning"); return; }
    if (e.pointerType !== "touch") return;
    const wasPick = pointer === "touch" && !gesture && touches.has(e.pointerId);
    touches.delete(e.pointerId);
    if (touches.size < 2) gesture = null;
    if (wasPick && e.type === "pointerup") {
      const moved = tapStart?.moved;
      if (moved) lastTap = null;
      if (!(!moved && doubleAt(e)) && setPos(e, "touch")) { drawChip(); pick(); }
    }
    if (!touches.size || wasPick) { hideChip(); pointer = null; }
  };
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);
  stage.addEventListener("contextmenu", (e) => { if (pointer === "touch") e.preventDefault(); });
  // wheel, as in Photo: the wheel (or Ctrl + wheel) zooms around the pointer, x1.1 per mouse notch eased
  // over ~80 ms; a trackpad pinch (Ctrl + fractional deltas) follows the fingers exactly; Shift + wheel pans
  stage.addEventListener("wheel", (e) => {
    if (!cur) return;
    e.preventDefault();
    const p = stagePt(e.clientX, e.clientY);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
    const dy = e.deltaY * unit;
    if (e.shiftKey && !e.ctrlKey) { cur.view.tx -= e.deltaX * unit || dy; applyView(); return; }
    if (!dy) return;
    const pinchy = e.ctrlKey && !Number.isInteger(e.deltaY);
    if (pinchy) { stopZoomAnim(); zoomAt(cur.view.z * clamp(Math.exp(-dy * 0.01), 0.5, 2), p.x, p.y); }
    else smoothZoom(clamp(Math.exp(-dy * 0.00095), 0.6, 1.6), p.x, p.y);
  }, { passive: false });

  // ── picking ───────────────────────────────────────────────────────────────
  function pick() {
    if (!cur || !pos) return;
    addPicked(pos.hex || sample(pos.x, pos.y));
  }
  /** a picked colour goes into the history of the current image (undo, copy), wherever it came from */
  function addPicked(hex) {
    if (!cur) return;
    const i = cur.colors.indexOf(hex);
    const before = { colors: [...cur.colors], sel: cur.sel };
    if (i >= 0) cur.sel = i;
    else { cur.colors.unshift(hex); cur.sel = 0; recordColors(cur, "Pick colour", before); }
    renderValues(); renderHistory();
    copyValue(0, hex, true);
  }

  // ── pick from screen (EyeDropper API, or a one-frame screen snapshot; hidden where neither exists) ──
  const screenBtn = q(".cl-screen");
  let screenBusy = false;
  async function screenPick() {
    if (screenBusy || !cur) return;
    screenBusy = true; screenBtn.disabled = true;
    hideChip();
    try {
      const r = await pickFromScreen();
      if (r.hex) addPicked(r.hex);
      else if (r.error) toast(r.error, { bad: true });
    } finally { screenBusy = false; screenBtn.disabled = false; }
  }
  if (screenPickKind()) {
    screenBtn.hidden = false;
    screenBtn.onclick = screenPick;
  }

  // ── panel ─────────────────────────────────────────────────────────────────
  const rows = ["HEX", "RGB", "HSL"].map((k) => {
    const r = h(`<div class="cl-row"><span class="k">${k}</span><span class="v mono">–</span><span class="cd" hidden role="status">${icon("check", 14, { stroke: 2 })}Copied</span><button class="ib sm cp" type="button" aria-label="Copy ${k}" title="${K.tip(`Copy ${k}`, k === "HEX" ? "copyHex" : k === "RGB" ? "copyRgb" : "")}">${icon("copy", 14)}</button></div>`);
    valuesEl.append(r);
    return r;
  });
  const valueTexts = (hex) => {
    const [r, g, b] = rgbOf(hex), [hh, s, l] = hslOf(hex);
    return [
      { show: hex, copy: hex },
      { show: `${r}, ${g}, ${b}`, copy: `rgb(${r}, ${g}, ${b})` },
      { show: `${hh}°, ${s}%, ${l}%`, copy: `hsl(${hh}, ${s}%, ${l}%)` },
    ];
  };
  const curHex = () => (cur && cur.sel >= 0 ? cur.colors[cur.sel] : null);
  const flashTimers = [];
  async function copyValue(i, text, flashAll) {
    const ok = await copyText(text);
    if (!ok) { toast("Couldn't copy here. Select the value and press Ctrl C.", { bad: true }); return; }
    flash(i);
  }
  function flash(i) {
    const r = rows[i];
    r.querySelector(".cd").hidden = false; r.querySelector(".cp").hidden = true;
    clearTimeout(flashTimers[i]);
    flashTimers[i] = setTimeout(() => { r.querySelector(".cd").hidden = true; r.querySelector(".cp").hidden = false; }, 1600);
  }
  rows.forEach((r, i) => {
    r.querySelector(".cp").onclick = () => { const hex = curHex(); if (hex) copyValue(i, valueTexts(hex)[i].copy); };
    r.querySelector(".v").onclick = () => { const hex = curHex(); if (hex) copyValue(i, valueTexts(hex)[i].copy); };
  });
  function renderValues() {
    const hex = curHex();
    swatch.style.background = hex || "";
    swatch.classList.toggle("none", !hex);
    swatch.title = hex ? K.tip(`Copy ${hex}`, "copyHex") : "";
    touchSession();
    const t = hex ? valueTexts(hex) : null;
    rows.forEach((r, i) => {
      r.querySelector(".v").textContent = t ? t[i].show : "–";
      r.querySelector(".cp").disabled = !hex;
      r.querySelectorAll(".cd").forEach((x) => { if (!hex) x.hidden = true; });
      if (!hex) r.querySelector(".cp").hidden = false;
    });
  }
  swatch.onclick = () => { const hex = curHex(); if (hex) copyValue(0, hex); };

  function renderHistory() {
    nameEl.textContent = cur ? cur.name : "";
    const n = cur ? cur.colors.length : 0;
    const cnt = q(".cl-hcount");
    cnt.hidden = !n; cnt.textContent = n;
    const frag = document.createDocumentFragment();
    if (!n) for (let i = 0; i < 6; i++) frag.append(h(`<span class="cl-sw slot" aria-hidden="true"></span>`));
    else cur.colors.forEach((c, i) => {
      const b = h(`<button type="button" class="cl-sw" title="${c}" aria-label="${c}"></button>`);
      b.style.background = c;
      if (i === cur.sel) b.classList.add("sel");
      b.onclick = () => { cur.sel = i; renderValues(); renderHistory(); copyValue(0, c); };
      frag.append(b);
    });
    histEl.replaceChildren(frag);
    histEl.querySelector(".sel")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function renderSaved() {
    const list = Object.entries(H).map(([k, e]) => store.view(k, e)).filter((v) => v.colors.length || v.hasImage)
      .sort((a, b) => b.at - a.at).slice(0, 40);
    q(".cl-savedsec").hidden = !list.length;
    q(".cl-scount").textContent = list.length;
    savedEl.replaceChildren(...list.map((v) => {
      const row = h(`<div class="cl-saved-row"><button type="button" class="open"><span class="strip"></span><span class="nm"></span><span class="n mono"></span></button><button type="button" class="ib sm rm" aria-label="Delete this history">${icon("x", 12)}</button></div>`);
      const strip = row.querySelector(".strip");
      v.colors.slice(0, 5).forEach((c) => { const s = document.createElement("span"); s.style.background = c; strip.append(s); });
      if (!v.colors.length) strip.classList.add("empty");
      row.querySelector(".nm").textContent = v.name;
      row.querySelector(".n").textContent = v.colors.length;
      row.querySelector(".open").title = v.name;
      row.querySelector(".open").onclick = () => openEntry(v);
      row.querySelector(".rm").onclick = () => removeEntry(v);
      return row;
    }));
  }

  const savedBtn = q(".cl-savedtoggle");
  const setSavedOpen = (o) => { savedBtn.setAttribute("aria-expanded", o); savedEl.hidden = !o; store.prefs.setSavedOpen(o); };
  savedBtn.onclick = () => setSavedOpen(savedBtn.getAttribute("aria-expanded") !== "true");
  { const o = store.prefs.savedOpen(); savedBtn.setAttribute("aria-expanded", o); savedEl.hidden = !o; }

  function renderPalette() {
    nEl.textContent = palN;
    q(".cl-fewer").disabled = palN <= 2; q(".cl-more").disabled = palN >= 12;
    const p = cur?.palette;
    const list = p && p.n === palN ? p.colors : null;
    palEl.classList.toggle("loading", !list);
    const frag = document.createDocumentFragment();
    if (list) {
      list.forEach((c) => {
        const b = h(`<button type="button" class="cl-pc" aria-label="Copy ${c}" title="Copy ${c}"><span class="blk"></span><span class="hx mono">${c}</span></button>`);
        b.querySelector(".blk").style.background = c;
        b.onclick = () => { copyText(c).then((ok) => toast(ok ? `Copied ${c}` : "Couldn't copy here.", { bad: !ok })); };
        frag.append(b);
      });
    } else {
      for (let i = 0; i < Math.min(palN, 6); i++) frag.append(h(`<span class="cl-pc ghost"><span class="blk"></span></span>`));
    }
    palEl.replaceChildren(frag);
  }

  function renderThumbs() {
    thumbsEl.replaceChildren(...docs.map((d) => {
      const b = h(`<button type="button" role="tab" class="cl-th"><img alt="" draggable="false"><span class="x" role="button" aria-label="Close image" title="Close image">${icon("x", 10, { stroke: 2 })}</span></button>`);
      b.setAttribute("aria-selected", d === cur);
      b.tabIndex = d === cur ? 0 : -1;
      b.setAttribute("aria-label", d.name);
      b.title = d.name;
      b.querySelector("img").src = d.thumbUrl;
      b.onclick = (e) => { if (e.target.closest(".x")) { e.stopPropagation(); closeDoc(d); } else if (d !== cur) select(d); };
      return b;
    }), h(`<button type="button" class="cl-th add" aria-label="Add images">${icon("plus")}</button>`));
    thumbsEl.lastChild.onclick = choose;
    thumbsEl.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  thumbsEl.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.stopPropagation();
    const i = docs.indexOf(cur), n = docs[(i + (e.key === "ArrowRight" ? 1 : -1) + docs.length) % docs.length];
    if (n && n !== cur) { select(n); thumbsEl.querySelector('[aria-selected="true"]')?.focus(); }
    e.preventDefault();
  });

  function renderAll() { renderThumbs(); renderValues(); renderHistory(); renderSaved(); renderPalette(); }

  // ── history: save, clear, open ────────────────────────────────────────────
  async function snapshot(doc) {
    try {
      const s = Math.min(1, 1600 / Math.max(doc.w, doc.h));
      const c = new OffscreenCanvas(Math.max(1, Math.round(doc.w * s)), Math.max(1, Math.round(doc.h * s)));
      c.getContext("2d").drawImage(doc.canvas, 0, 0, c.width, c.height);
      const blob = await c.convertToBlob({ type: "image/webp", quality: 0.85 });
      return await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(blob); });
    } catch { return null; }
  }
  q(".cl-save").onclick = async () => {
    const d = cur;
    if (!d) return;
    if (!d.colors.length) { toast("No colours to save", { info: true }); return; }
    flushH(); H = store.loadHistories();
    const prev = H[d.key];
    let entry;
    if (prev && prev.isMultiImage) entry = { ...prev, colors: [...d.colors], updatedAt: Date.now() };
    else entry = {
      ...(prev || {}), name: d.name, updatedAt: Date.now(), colors: [...d.colors],
      imageDataUrl: prev?.imageDataUrl || (await snapshot(d)),
      ...(d.file ? { originalFileName: d.file.name, originalFileSize: d.file.size, originalLastModified: d.file.lastModified } : {}),
    };
    H[d.key] = entry;
    const r = store.saveHistories(H);
    renderSaved();
    if (r.ok) {
      const key = d.key, before = prev ? { ...prev } : null;
      const put = (v) => { if (v) H[key] = { ...v }; else delete H[key]; renderSaved(); persistH(); };
      record("Save history", () => put(before), () => put(entry));
    }
    if (!r.ok) toast("Couldn't save: the browser's storage for this site is full.", { bad: true });
    else toast(r.droppedImages ? "Saved. Storage was nearly full, so some older stored images were removed." : `Saved ${d.colors.length} colour${d.colors.length === 1 ? "" : "s"}`);
  };
  q(".cl-clear").onclick = () => {
    const d = cur;
    if (!d || !d.colors.length) return;
    const before = { colors: [...d.colors], sel: d.sel };
    d.colors = []; d.sel = -1;
    if (cur === d) { renderValues(); renderHistory(); }
    const e = recordColors(d, "Clear history", before);
    toast("Cleared history", { action: "Undo", onAction: () => undoIf(e) });
  };

  async function openEntry(v) {
    const open = docs.find((d) => d.key === v.key);
    if (open) { select(open); return; }
    if (!v.hasImage) {
      if (!cur) { toast("This history has no image saved with it.", { bad: true }); return; }
      let added = 0;
      const before = { colors: [...cur.colors], sel: cur.sel };
      for (const c of [...v.colors].reverse()) if (!cur.colors.includes(c)) { cur.colors.unshift(c); added++; }
      if (cur.sel < 0 && cur.colors.length) cur.sel = 0;
      renderValues(); renderHistory();
      if (added) recordColors(cur, "Add colours", before);
      toast(added ? `Added ${added} colour${added === 1 ? "" : "s"} from ${v.name}` : "Those colours are already in this history");
      return;
    }
    const n0 = docs.length;
    try {
      if (v.multi) {
        let first = null;
        for (let i = 0; i < v.e.images.length; i++) {
          const im = v.e.images[i];
          const url = im?.dataUrl || (await store.multiImage(v.key, i));
          if (!url) continue;
          const doc = await addFromUrl(im?.name || `${v.name} ${i + 1}`, url, i === 0 ? v.key : `${v.key}#${i}`, i === 0 ? [...v.colors] : []);
          first ||= doc;
        }
        if (!first) { toast("The images of this history aren't stored on this device.", { bad: true }); return; }
        select(first);
      } else {
        select(await addFromUrl(v.name, v.e.imageDataUrl, v.key, [...v.colors]));
      }
    } catch { toast(`Couldn't open ${v.name}.`, { bad: true }); }
    recordAdd(docs.slice(n0));
  }
  function removeEntry(v) {
    flushH(); H = store.loadHistories();
    const saved = H[v.key];
    if (!saved) return;
    delete H[v.key];
    store.saveHistories(H);
    renderSaved();
    const key = v.key;
    const put = (x) => { if (x) H[key] = x; else delete H[key]; renderSaved(); persistH(); };
    // the images of a multi-image history stay in IndexedDB while this step can still be undone
    const wipe = () => { flushH(); if (!store.loadHistories()[key]) store.deleteMultiImages(key); };
    const e = record("Delete saved history", () => put(saved), () => put(null), { drop: (done) => { if (done) wipe(); }, leave: wipe });
    toast(`Deleted ${v.name}`, { action: "Undo", onAction: () => undoIf(e) });
  }

  // ── palette ───────────────────────────────────────────────────────────────
  let worker = null, wid = 0;
  const pending = new Map();
  function getWorker() {
    if (worker) return worker;
    worker = new Worker(new URL("./palette-worker.js", import.meta.url));
    worker.onmessage = (e) => { const f = pending.get(e.data.id); if (f) { pending.delete(e.data.id); f(e.data.colors || []); } };
    worker.onerror = () => { for (const f of pending.values()) f([]); pending.clear(); worker = null; };
    return worker;
  }
  async function extractFor(doc, n) {
    const s = Math.min(1, PAL_SIZE / Math.max(doc.w, doc.h));
    const bmp = await createImageBitmap(doc.canvas, { resizeWidth: Math.max(1, Math.round(doc.w * s)), resizeHeight: Math.max(1, Math.round(doc.h * s)), resizeQuality: "medium" });
    return new Promise((res) => { const id = ++wid; pending.set(id, res); getWorker().postMessage({ id, bitmap: bmp, n }, [bmp]); });
  }
  async function ensurePalette() {
    const d = cur, n = palN;
    if (!d || (d.palette && d.palette.n === n) || d.palBusy === n) { renderPalette(); return d?.palette?.n === n; }
    renderPalette();
    d.palBusy = n;
    const colors = await extractFor(d, n);
    if (d.palBusy === n) d.palBusy = 0;
    if (!docs.includes(d)) return false;
    d.palette = { n, colors };
    if (cur === d && palN === n) renderPalette();
    return true;
  }
  const bumpPal = (dn) => {
    const n = Math.max(2, Math.min(12, palN + dn));
    if (n === palN) return;
    const old = palN;
    setPalN(n);
    record("Palette count", () => setPalN(old), () => setPalN(n));
  };
  const setPalN = (n) => { palN = n; store.prefs.setPaletteN(n); renderPalette(); ensurePalette(); };
  q(".cl-fewer").onclick = () => bumpPal(-1);
  q(".cl-more").onclick = () => bumpPal(1);

  studioBtn.onclick = async () => {
    if (!cur) return;
    await ensurePalette();
    const d = cur;
    const colors = d.palette?.colors || [];
    if (!colors.length) { toast("Couldn't read colours from this image.", { bad: true }); return; }
    const { openStudio } = await import("./studio.js");
    openStudio({ colors, name: d.name, source: d.canvas, anchor: studioBtn, record });
  };

  // ── keyboard ──────────────────────────────────────────────────────────────
  // Actions live in the shared registry (shared/keys.js): the user's own keys are used from here on.
  const onCtl = (e) => e.target.closest?.("button, a, [role=tab]");
  const here = () => !!cur && !topLayer();
  const kb = (id, keys, group, label, run, when, extra) => K.add({ id, keys, group, label, run, when, ...extra });
  const info = (shown, group, label) => K.info(shown, group, label);
  kb("pickHere", "Enter", "Colours", "Pick", () => pick(), (e) => here() && !onCtl(e) && !!pos);
  kb("pickScreen", "I", "Colours", "Pick from screen", () => screenPick(), (e) => here() && !screenBtn.hidden && !onCtl(e));
  kb("copyHex", "C|Ctrl+C", "Colours", "Copy HEX", () => copyValue(0, curHex()), (e) => here() && !!curHex() && (mod(e) ? !String(getSelection()) : !onCtl(e)));
  kb("copyRgb", "Shift+C", "Colours", "Copy RGB", () => copyValue(1, valueTexts(curHex())[1].copy), (e) => here() && !!curHex() && !onCtl(e));
  kb("remove", "Delete|Backspace", "Colours", "Remove", () => removeSwatch(), (e) => here() && !!curHex() && !e.target.closest?.(".cl-saved"));
  info("Click · touch", "Colours", "Pick");
  for (const [id, label, key, dx, dy] of [["Left", "←", "Left", -1, 0], ["Right", "→", "Right", 1, 0], ["Up", "↑", "Up", 0, -1], ["Down", "↓", "Down", 0, 1]]) {
    const when = (e) => here() && !e.target.closest?.(".cl-thumbs, .cl-saved, .cl-hist");
    kb(`nudge${id}`, key, "Colours", `Nudge ${label}`, () => nudgePointer(dx, dy), when);
    kb(`nudge${id}10`, `Shift+${key}`, "Colours", `Nudge ${label} 10`, () => nudgePointer(dx * 10, dy * 10), when);
  }
  kb("open", "Ctrl+O", "Edit", "Add images", () => choose());
  kb("undo", "Ctrl+Z", "Edit", "Undo", () => undo(), null, { typing: (t) => /^(checkbox|radio|range|button)$/.test(t.type || "") });
  kb("redo", "Ctrl+Shift+Z|Ctrl+Y", "Edit", "Redo", () => redo(), null, { typing: (t) => /^(checkbox|radio|range|button)$/.test(t.type || "") });
  // P and Ctrl E open Palette Studio; pressed again while it is the open dialog they close it
  kb("studio", "P|Ctrl+E", "Edit", "Palette Studio", () => { const top = topLayer(); if (top) top.close(); else studioBtn.click(); }, () => { const top = topLayer(); return top ? top.el.classList.contains("studio") : !!cur; });
  kb("zoomIn", "=|Shift+=", "View", "Zoom in", () => zoomBy(ZKEY), here);
  kb("zoomOut", "-|Shift+-", "View", "Zoom out", () => zoomBy(1 / ZKEY), here);
  kb("actual", "1|Shift+0", "View", "100%", () => actualView(), here);
  kb("fit", "Shift+1", "View", "Fit", () => fitView(), here);
  kb("pan", "Space", "View", "Pan", () => { spaceDown = true; stage.classList.add("pan"); }, (e) => here() && !onCtl(e), { hold: true, up: () => { spaceDown = false; stage.classList.remove("pan"); } });
  // next / previous image: only from the image itself and only until the last one, so the keyboard can always move on
  const imageStep = (d) => { const n = docs[docs.indexOf(cur) + d]; if (!n) return false; select(n); n.canvas.focus({ preventScroll: true }); };
  const onImage = (e) => here() && docs.length > 1 && (e.target === document.body || e.target === cur.canvas);
  kb("nextImage", "Tab", "View", "Next image", () => imageStep(1), onImage);
  kb("prevImage", "Shift+Tab", "View", "Previous image", () => imageStep(-1), onImage);
  info("Wheel · pinch", "View", "Zoom");
  info("Double-click", "View", "Fit ↔ 100%");
  info("Middle drag", "View", "Pan");
  info("Shift wheel", "View", "Pan sideways");
  kb("sheet", "Shift+/", "Other", "Shortcuts", () => K.openSheet(), () => !topLayer());
  function nudgePointer(dx, dy) {
    pointer = "mouse";
    const base = pos || { x: Math.floor(cur.w / 2), y: Math.floor(cur.h / 2) };
    pos = { x: Math.max(0, Math.min(cur.w - 1, base.x + (pos ? dx : 0))), y: Math.max(0, Math.min(cur.h - 1, base.y + (pos ? dy : 0))), kbd: true };
    { // keep the nudged pixel on screen
      const g = imgPt(pos), m = 24, sw = stage.clientWidth, sh = stage.clientHeight;
      const mx = g.x < m ? m - g.x : g.x > sw - m ? sw - m - g.x : 0, my = g.y < m ? m - g.y : g.y > sh - m ? sh - m - g.y : 0;
      if (mx || my) { cur.view.tx += mx; cur.view.ty += my; applyView(); }
    }
    drawChip();
  }
  document.addEventListener("keydown", (e) => {
    if (!active || e.defaultPrevented) return;
    K.dispatch(e);
  });
  // labels built by hand follow the user's keys
  K.onChange(() => { K.refresh(root); syncUndo(); if (cur) renderValues(); });
  K.refresh(root);
  function removeSwatch() {
    const d = cur;
    if (!d || d.sel < 0) return;
    const before = { colors: [...d.colors], sel: d.sel }, hex = d.colors[d.sel];
    d.colors.splice(d.sel, 1);
    d.sel = d.colors.length ? Math.min(d.sel, d.colors.length - 1) : -1;
    renderValues(); renderHistory();
    recordColors(d, `Remove ${hex}`, before);
  }

  addEventListener("blur", () => { spaceDown = false; stage.classList.remove("pan"); });

  // ── recent images ─────────────────────────────────────────────────────────
  let recentURLs = [];
  async function refreshRecents() {
    const rs = await Promise.race([recents.list("color"), new Promise((r) => setTimeout(() => r([]), 1500))]);
    flushH(); H = store.loadHistories();
    const views = Object.entries(H).map(([k, e]) => store.view(k, e));
    const items = rs.map((r) => {
      const v = views.find((x) => x.e.originalFileName === r.name && x.e.originalFileSize === r.size);
      return { at: r.at, name: r.name, sub: v ? `${v.colors.length} colour${v.colors.length === 1 ? "" : "s"}` : r.sub, thumb: r.thumb, rec: r };
    });
    const names = new Set(rs.map((r) => r.name));
    for (const v of views) if (v.hasImage && !names.has(v.name)) items.push({ at: v.at, name: v.name, sub: `${v.colors.length} colour${v.colors.length === 1 ? "" : "s"}`, v });
    items.sort((a, b) => b.at - a.at);
    const shown = items.slice(0, 8);
    for (const u of recentURLs) URL.revokeObjectURL(u);
    recentURLs = [];
    recentsBox.hidden = !shown.length;
    q(".recents .grid").replaceChildren(...shown.map((it) => {
      const wrap = h(`<div class="recent-wrap"><button class="ib sm recent-x" type="button" aria-label="Remove from Recent">${icon("x", 12)}</button></div>`);
      const b = h(`<button class="recent" type="button"><span class="thumb"></span><span class="meta"><span class="name"></span><span class="sub"></span></span></button>`);
      wrap.prepend(b);
      let url = null;
      if (it.rec) wrap.querySelector(".recent-x").onclick = async () => {
        await recents.remove(it.rec.id); wrap.remove();
        if (url) { URL.revokeObjectURL(url); recentURLs = recentURLs.filter((u) => u !== url); }
      };
      else wrap.querySelector(".recent-x").remove();
      b.querySelector(".name").textContent = it.name;
      b.querySelector(".sub").textContent = [it.sub, it.at ? fmtAgo(it.at) : ""].filter(Boolean).join(" · ");
      b.title = it.name;
      const th = b.querySelector(".thumb");
      if (it.thumb) { url = URL.createObjectURL(it.thumb); recentURLs.push(url); th.style.backgroundImage = `url("${url}")`; }
      else if (it.v && !it.v.multi && it.v.e.imageDataUrl) th.style.backgroundImage = `url("${it.v.e.imageDataUrl}")`;
      else if (it.v?.colors.length) { th.classList.add("two"); th.innerHTML = `<span style="background:${it.v.colors[0]}"></span><span style="background:${it.v.colors[1] || it.v.colors[0]}"></span>`; }
      b.onclick = async () => {
        if (it.rec) {
          const f = await recents.open(it.rec);
          if (f) addFiles([{ file: f, handle: it.rec.handle || undefined }]);
          else { toast(`Can't open ${it.name} any more. Choose it again.`, { bad: true }); recents.remove(it.rec.id); refreshRecents(); }
        } else openEntry(it.v);
      };
      return wrap;
    }));
  }

  // ── where the user left off ───────────────────────────────────────────────
  let restoring = false;
  const SESSION_MAX = 100 * 1024 * 1024;
  async function sessionCopy(d) {
    try {
      const sc = Math.min(1, 4096 / Math.max(d.w, d.h));
      const c = new OffscreenCanvas(Math.max(1, Math.round(d.w * sc)), Math.max(1, Math.round(d.h * sc)));
      c.getContext("2d").drawImage(d.canvas, 0, 0, c.width, c.height);
      return await c.convertToBlob({ type: "image/webp", quality: 0.9 });
    } catch { return null; }
  }
  function touchSession() {
    if (!docs.length || restoring) return;
    session.saveSoon("color", async () => {
      if (!docs.length || !cur) return null;
      // the saved copy of each image is a WebP of at most 4096 px; all copies together stay under 100 MB
      // (the current image first; images that would not fit are left out of the session)
      const kept = [], order = [cur, ...docs.filter((d) => d !== cur)];
      let total = 0;
      for (const d of order) {
        d.sessBlob ||= await sessionCopy(d);
        if (!d.sessBlob || total + d.sessBlob.size > SESSION_MAX) continue;
        total += d.sessBlob.size;
        kept.push(d);
      }
      if (!kept.length) return null;
      kept.sort((a, b) => docs.indexOf(a) - docs.indexOf(b));
      const n = kept.reduce((t, d) => t + d.colors.length, 0);
      return {
        name: cur.name, thumb: cur.thumb, sub: `${kept.length} image${kept.length === 1 ? "" : "s"} · ${n} colour${n === 1 ? "" : "s"}`,
        state: { cur: Math.max(0, kept.indexOf(cur)), docs: kept.map((d) => ({ name: d.name, key: d.key, file: d.sessBlob, colors: d.colors, sel: d.sel, z: d.view.z || 1, tx: d.view.tx || 0, ty: d.view.ty || 0 })) },
      };
    });
  }
  async function restore(st) {
    if (!st?.docs?.length) return;
    clearUndo();
    restoring = true;
    let sel = null;
    for (let i = 0; i < st.docs.length; i++) {
      const d = st.docs[i];
      try {
        const img = await decode(d.file);
        const doc = newDoc({ name: d.name, ...img, key: d.key, colors: d.colors || [] });
        doc.file = new File([d.file], d.name, { type: d.file.type });
        doc.sessBlob = d.file;
        doc.sel = Math.min(d.sel ?? -1, doc.colors.length - 1);
        doc.thumb = await thumbOf(doc.canvas, 160);
        setThumb(doc);
        Object.assign(doc.view, { z: d.z || 1, tx: d.tx || 0, ty: d.ty || 0 });
        if (i === st.cur) sel = doc;
      } catch { /* that image is gone */ }
    }
    restoring = false;
    if (!docs.length) { toast("Couldn't restore your images.", { bad: true }); return; }
    select(sel || docs[0], true);
    markOpened([...docs], true);
  }

  // ── old cloud notice (only for people still signed in to it) ──────────────
  const oldChanged = () => { flushH(); H = store.loadHistories(); renderSaved(); refreshRecents(); refreshOldLink(); };
  // the one quiet link for people whose sign-in is gone: only until the deletion date, and only when
  // the old cloud's notice isn't already showing
  async function refreshOldLink() {
    q(".cl-oldcloud").hidden = true;
    emptyEl.classList.toggle("has-notice", !cloudBox.hidden);
    if (!cloudBox.hidden) return;
    // only browsers that came from the old site (or still hold its sign-in) ever see the link
    let fromOld = false;
    try { fromOld = localStorage.getItem("quickcut.color.fromOld") === "1"; } catch {}
    if (!fromOld && !store.loadSession()) return;
    try {
      const sun = await (await import("./cloud.js")).getSunset();
      const end = sun && !sun.closed && sun.deleteAt ? Date.parse(sun.deleteAt) : NaN;
      q(".cl-oldcloud").hidden = !(end > Date.now()) || !cloudBox.hidden;
    } catch { /* no link */ }
  }
  q(".cl-oldbtn").onclick = async () => {
    try {
      const m = await import("./cloud.js");
      // hidden notice with a sign-in still here: just show it again
      if (m.hasSession()) { await m.mountNotice(cloudBox, oldChanged, { force: true }); refreshOldLink(); return; }
      if (await m.signIn(cloudBox, oldChanged)) { emptyEl.classList.add("has-notice"); q(".cl-oldcloud").hidden = true; }
    } catch { toast("Couldn't open the old cloud sign-in.", { bad: true }); }
  };
  if (store.loadSession()) {
    import("./cloud.js").then((m) => m.mountNotice(cloudBox, oldChanged)).then(refreshOldLink, refreshOldLink);
  } else refreshOldLink();

  H = store.loadHistories();
  refreshRecents();
  renderResume(resumeBox, "color", (rec) => restore(rec.state));

  return {
    show() { active = true; if (!cur) { refreshRecents(); renderResume(resumeBox, "color", (rec) => restore(rec.state)); } else layout(); },
    hide() { active = false; hideChip(); stopZoomAnim(); },
    back() { return false; },
  };
}
