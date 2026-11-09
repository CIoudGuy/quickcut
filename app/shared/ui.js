// QuickCut shared UI helpers. Plain ES module, no dependencies. Every tool imports from here so
// popovers, sheets, toasts, file intake, recents and downloads behave the same everywhere.

// ── icons (16×16 strokes from the design) ───────────────────────────────────
export const IC = {
  undo: "M5.5 3.5L2.5 6.5l3 3M2.5 6.5h7a3.5 3.5 0 0 1 0 7h-2",
  redo: "M10.5 3.5l3 3-3 3M13.5 6.5h-7a3.5 3.5 0 0 0 0 7h2",
  exp: "M8 10V2.5M5 5.5l3-3 3 3M2.5 9.5v4h11v-4",
  download: "M8 2.5V10M5 7l3 3 3-3M2.5 13.5h11",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  folder: "M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z",
  film: "M2.5 2.5h11v11h-11zM5 2.5v11M11 2.5v11M2.5 5.5H5M2.5 10.5H5M11 5.5h2.5M11 10.5h2.5",
  image: "M2.5 2.5h11v11h-11zM2.5 11l3.5-3.5 3 3 2-2 2.5 2.5M9.5 5.5a1 1 0 1 0 2 0a1 1 0 1 0-2 0",
  lock: "M4 7.5h8v6H4zM5.5 7.5V5.3a2.5 2.5 0 0 1 5 0v2.2",
  resize: "M2.5 9.5v4h4M13.5 6.5v-4h-4M2.5 13.5l4.5-4.5M13.5 2.5L9 7",
  link: "M6.5 9.5l3-3M7 4.8l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1M9 11.2l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1",
  crop: "M4.5 1.5v10h10M1.5 4.5h10v10",
  rotate: "M2.5 7a5 5 0 0 1 9.2-2.7M12.5 1.8v2.9H9.6M3.5 9.5h6v4h-6z",
  flipH: "M8 1.5v13M6 4L2.5 12H6zM10 4l3.5 8H10z",
  flipV: "M1.5 8h13M4 6l8-3.5V6zM4 10l8 3.5V10z",
  straighten: "M2 12.5h12M3.5 12.5L12 5M9.5 12.5a3 3 0 0 0-.8-2.1",
  play: "M5 3.5v9l7.5-4.5z",
  pause: "M5 3.5v9M11 3.5v9",
  stepBack: "M11.5 4L6.5 8l5 4zM4.5 4v8",
  stepFwd: "M4.5 4l5 4-5 4zM11.5 4v8",
  loop: "M3 7V6a2 2 0 0 1 2-2h7.5M10.5 2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H3.5M5.5 14l-2-2 2-2",
  vol: "M2.5 6h2.5l3.5-3v10L5 10H2.5zM11 5.5a3.5 3.5 0 0 1 0 5",
  mute: "M2.5 6h2.5l3.5-3v10L5 10H2.5zM11 6l3 4M14 6l-3 4",
  chev: "M4.5 6.5L8 10l3.5-3.5",
  chevR: "M6.5 4.5L10 8l-3.5 3.5",
  razor: "M3 4.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M3 11.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M5.7 5.4L13.5 12M5.7 10.6L13.5 4",
  trash: "M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9",
  fit: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10",
  bolt: "M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z",
  target: "M2.5 8a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0M8 2.5v11M2.5 8h11",
  x: "M4 4l8 8M12 4l-8 8",
  check: "M3 8.5l3.2 3L13 4.5",
  info: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M8 7.5v3M8 5.2v.1",
  alert: "M8 4v5M8 11.5v.5",
  plus: "M8 3v10M3 8h10",
  minus: "M3.5 8h9",
  layers: "M8 2L14 5.2 8 8.4 2 5.2zM2 8l6 3.2L14 8M2 10.8L8 14l6-3.2",
  move: "M8 1.5v13M1.5 8h13M6 3.5l2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2",
  select: "M2.5 4.5v-2h2M7 2.5h2M11.5 2.5h2v2M13.5 7v2M13.5 11.5v2h-2M9 13.5H7M4.5 13.5h-2v-2M2.5 9V7",
  brush: "M13.5 2.5L7.5 8.5M8.8 9.8L6.2 7.2c-1.6 0-2.7 1-2.7 2.6 0 1.3-.5 2.2-1.5 2.9 2.7.6 6.3.2 6.8-2.9z",
  eraser: "M5.5 13.5h8M9.2 2.8l4 4-6.7 6.7H4.3L2.2 11.4a1.4 1.4 0 0 1 0-2zM5.8 6.2l4 4",
  text: "M3 4V3h10v1M8 3v10M6 13h4",
  eyedrop: "M10 2.8a1.8 1.8 0 0 1 2.6 0l.6.6a1.8 1.8 0 0 1 0 2.6L11.5 7.7 8.3 4.5zM9.3 5.5l-6 6v2.2h2.2l6-6",
  eye: "M1.5 8S3.8 3.5 8 3.5 14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8zM6 8a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
  eyeOff: "M2 2l12 12M6.6 6.6a2 2 0 0 0 2.8 2.8M4.2 4.8C2.6 6 1.5 8 1.5 8s2.3 4.5 6.5 4.5c1.2 0 2.3-.4 3.2-.9M7 3.6c.3 0 .7-.1 1-.1 4.2 0 6.5 4.5 6.5 4.5s-.5 1-1.4 2.1",
  clip: "M5 3v5.5h6.5M9.5 6.5l2 2-2 2",
  dup: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  merge: "M8 2.5v7M5 6.5l3 3 3-3M2.5 13.5h11",
  flatten: "M2 6l6-3.5L14 6l-6 3.5zM2 10l6 3.5 6-3.5",
  palette: "M8 1.5a6.5 6.5 0 1 0 0 13c1 0 1.5-.6 1.5-1.4 0-1-.9-1.3-.9-2.1 0-.8.6-1.3 1.4-1.3H12a2.5 2.5 0 0 0 2.5-2.5C14.5 4.2 11.6 1.5 8 1.5zM4.8 7.2h.01M6.5 4.5h.01M10 4.5h.01",
  cloud: "M4.5 12.5a3 3 0 0 1-.4-6A4.5 4.5 0 0 1 12.7 6a3.3 3.3 0 0 1-.2 6.5z",
  external: "M6 3.5H3.5v9h9V10M9 3h4v4M13 3L7.5 8.5",
  // simple outline of a code repository (not a brand logo)
  github: "M3.5 2.5h7l2 2v9h-9zM10.5 2.5v2h2M6.2 7.2L4.8 8.6l1.4 1.4M9.8 7.2l1.4 1.4-1.4 1.4",
};

/** `<svg>` markup for an icon. `fill` draws the path filled (e.g. play). */
export function icon(name, size = 16, { fill = false, stroke = 1.5 } = {}) {
  const d = IC[name] || name;
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="${fill ? "currentColor" : "none"}" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

// ── DOM ─────────────────────────────────────────────────────────────────────
/** Build an element from an HTML string (one root). */
export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
export const isPhone = () => matchMedia("(max-width: 599px)").matches;
export const isTouch = () => matchMedia("(pointer: coarse)").matches;
/** Keep a `.slider`'s filled part in step with its value. */
export function syncSlider(input) {
  const min = +input.min || 0, max = +input.max || 100;
  input.style.setProperty("--p", `${((input.value - min) / (max - min || 1)) * 100}%`);
}
document.addEventListener("input", (e) => e.target.classList?.contains("slider") && syncSlider(e.target), true);
// Double-click (or double-tap) a slider to put it back to its default: `data-default` if set,
// else the value it was created with (the HTML value attribute). Fires input + change like a drag.
export function resetSlider(input) {
  const d = input.dataset.default ?? input.defaultValue;
  if (d === undefined || d === "" || String(input.value) === String(d)) return;
  input.value = d;
  syncSlider(input);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
document.addEventListener("dblclick", (e) => {
  if (e.target.classList?.contains("slider")) { e.preventDefault(); resetSlider(e.target); }
}, true);
{
  let lastTap = 0, lastEl = null;
  document.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "touch" || !e.target.classList?.contains("slider")) return;
    const now = performance.now();
    if (lastEl === e.target && now - lastTap < 300) { resetSlider(e.target); lastTap = 0; } else { lastTap = now; lastEl = e.target; }
  }, true);
}

// ── formatting ──────────────────────────────────────────────────────────────
export function fmtBytes(n) {
  if (!(n >= 0)) return "–";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
/** 02:14.06 style (minutes:seconds.hundredths), or 1:02:14.06 past an hour. */
export function fmtTime(s, { cs = true } = {}) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
  const c = Math.floor((s % 1) * 100);
  const base = `${hh ? hh + ":" + String(mm).padStart(2, "0") : String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return cs ? `${base}.${String(c).padStart(2, "0")}` : base;
}
export function fmtAgo(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 172800) return "Yesterday";
  const date = new Date(t);
  if (d < 6 * 86400) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export const baseName = (name) => name.replace(/\.[^.]+$/, "");

// ── layers: popovers, sheets, dialogs ───────────────────────────────────────
// One stack for the whole page. Esc, a click outside and the mouse Back button close the top
// layer; mouse Forward re-opens the last one closed. On phones every popover is a bottom sheet.
const stack = [];
let lastClosed = null;

/**
 * Open a popover/sheet.
 * @param {HTMLElement} el      the `.pop` element (created by the caller, not yet in the DOM)
 * @param {object} o
 *   anchor: element to hang under (desktop popover; right-aligned to it)
 *   width: desktop width in px (320–440 per design)
 *   center: centred dialog with scrim on desktop
 *   sheet: force bottom sheet (always on phones)
 *   onClose: called after it closed
 * @returns {{close: Function, el: HTMLElement}}
 */
export function openLayer(el, o = {}) {
  // clicking the button of an open popover/menu closes it (a toggle), never opens a second copy
  const same = o.anchor && stack.find((l) => l.o.anchor === o.anchor);
  if (same) {
    closeLayer(same, { remember: false });
    return { close() {}, el: same.el, toggledOff: true };
  }
  const sheet = o.sheet || isPhone();
  const layer = { el, o, scrim: null, close: () => closeLayer(layer) };
  el.classList.add("pop");
  el.classList.toggle("sheet", sheet);
  el.classList.toggle("center", !sheet && !!o.center);
  if (!sheet && o.width) el.style.width = `${o.width}px`;
  if (sheet || o.center) {
    layer.scrim = h(`<div class="scrim"></div>`);
    layer.scrim.addEventListener("pointerdown", () => layer.close());
    document.body.append(layer.scrim);
  }
  if (!el.querySelector(".grab")) el.prepend(h(`<span class="grab" aria-hidden="true"></span>`));
  document.body.append(el);
  if (!sheet && !o.center && o.anchor) place(el, o.anchor);
  o.anchor?.setAttribute("aria-expanded", "true");
  stack.push(layer);
  requestAnimationFrame(() => { el.classList.add("in"); layer.scrim?.classList.add("in"); });
  const f = el.querySelector("[autofocus]") || el.querySelector("button, input");
  if (f && !isTouch()) setTimeout(() => f.focus({ preventScroll: true }), 0);
  return layer;
}
function place(el, anchor) {
  const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const r = anchor.getBoundingClientRect();
  const vw = innerWidth / zoom;
  const w = el.offsetWidth;
  const right = r.right / zoom;
  const left = Math.max(12, Math.min(vw - w - 12, right - w));
  el.style.left = `${left}px`;
  el.style.top = `${r.bottom / zoom + 6}px`;
}
export function closeLayer(layer, { remember = true } = {}) {
  const i = stack.indexOf(layer);
  if (i < 0) return;
  stack.splice(i, 1);
  layer.o.anchor?.setAttribute("aria-expanded", "false");
  layer.el.classList.add("closing");
  layer.el.classList.remove("in");
  layer.scrim?.classList.remove("in");
  const done = () => { layer.el.remove(); layer.scrim?.remove(); layer.el.classList.remove("closing"); };
  setTimeout(done, 160);
  if (remember && layer.o.reopen !== false) lastClosed = layer;
  layer.o.onClose?.();
}
export const topLayer = () => stack[stack.length - 1] || null;
export function closeTop() {
  const l = topLayer();
  if (!l) return false;
  closeLayer(l);
  return true;
}
function reopen() {
  const l = lastClosed;
  if (!l || stack.includes(l) || !l.o.anchor?.isConnected) return false;
  lastClosed = null;
  l.el.classList.remove("in", "closing");
  openLayer(l.el, l.o);
  return true;
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.defaultPrevented && closeTop()) e.preventDefault();
});
document.addEventListener("pointerdown", (e) => {
  const l = topLayer();
  if (!l || l.scrim || e.button !== 0) return;
  if (l.el.contains(e.target) || l.o.anchor?.contains(e.target)) return;
  closeLayer(l);
}, true);

// Mouse side buttons. Browsers go back/forward in history on these, which would leave the page
// and lose work: block that everywhere. Back closes the top layer, else asks the active tool
// (`onBack` hook) to step back (e.g. leave crop); Forward re-opens what Back closed.
let backHandler = null;
/** The active tool registers what mouse Back does when no popover is open. */
export function setBackHandler(fn) { backHandler = fn; }
for (const type of ["mousedown", "pointerdown", "auxclick"]) {
  addEventListener(type, (e) => { if (e.button === 3 || e.button === 4) { e.preventDefault(); e.stopPropagation(); } }, true);
}
addEventListener("mouseup", (e) => {
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.button === 3) closeTop() || backHandler?.();
  else reopen();
}, true);

// ── toasts ──────────────────────────────────────────────────────────────────
let toastBox = null;
/**
 * toast("Copied #F6C79A") · toast("Not supported", {bad: true}) · toast("Deleted", {action: "Undo", onAction})
 * Text is escaped unless `html: true`.
 */
export function toast(text, { bad = false, info = false, action, onAction, html = false, ms = 3000 } = {}) {
  if (!toastBox) { toastBox = h(`<div class="toasts" aria-live="polite"></div>`); document.body.append(toastBox); }
  while (toastBox.children.length >= 2) toastBox.firstElementChild.remove();
  // info: a neutral notice (nothing went wrong, nothing succeeded), e.g. "Too close to the edge to split"
  const el = h(`<div class="toast${bad ? " bad" : info ? " info" : ""}" role="${bad ? "alert" : "status"}"><span class="ic">${icon(bad ? "alert" : info ? "info" : "check", 14, { stroke: bad || !info ? 2 : 1.5 })}</span><span class="msg"></span></div>`);
  el.querySelector(".msg")[html ? "innerHTML" : "textContent"] = text;
  if (action) {
    const b = h(`<button class="act" type="button"></button>`);
    b.textContent = action;
    b.onclick = () => { onAction?.(); el.remove(); };
    el.append(b);
  }
  toastBox.append(el);
  requestAnimationFrame(() => el.classList.add("in"));
  setTimeout(() => { el.classList.remove("in"); setTimeout(() => el.remove(), 150); }, ms);
}

// ── files in: pick, drop, paste ─────────────────────────────────────────────
/**
 * Ask for files. Uses the File System Access picker when available (so Recent can reopen the
 * file later) and falls back to <input type=file>.
 * @returns {Promise<Array<{file: File, handle?: FileSystemFileHandle}>>}
 */
export async function pickFiles({ accept = "*/*", multiple = false, types } = {}) {
  if (window.showOpenFilePicker && types) {
    try {
      const handles = await showOpenFilePicker({ multiple, types, excludeAcceptAllOption: false });
      return Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
    } catch (e) {
      if (e.name === "AbortError") return [];
    }
  }
  return new Promise((resolve) => {
    const input = h(`<input type="file" hidden>`);
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => { resolve([...input.files].map((file) => ({ file }))); input.remove(); };
    input.oncancel = () => { resolve([]); input.remove(); };
    document.body.append(input);
    input.click();
  });
}

/**
 * Accept dropped and pasted files on `target` (paste is page-wide while `isActive()` says so).
 * `onFiles` receives [{file, handle?}].
 */
export function intake(target, onFiles, { isActive = () => true, filter = () => true } = {}) {
  let depth = 0;
  target.addEventListener("dragenter", (e) => { if (hasFiles(e)) { depth++; target.classList.add("over"); e.preventDefault(); } });
  target.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  target.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; target.classList.remove("over"); } });
  target.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    target.classList.remove("over");
    const items = [...e.dataTransfer.items].filter((i) => i.kind === "file");
    const out = await Promise.all(items.map(async (i) => {
      let handle;
      try { handle = i.getAsFileSystemHandle ? await i.getAsFileSystemHandle() : undefined; } catch {}
      const file = handle?.kind === "file" ? await handle.getFile() : i.getAsFile();
      return file ? { file, handle: handle?.kind === "file" ? handle : undefined } : null;
    }));
    const ok = out.filter((x) => x && filter(x.file));
    if (ok.length) onFiles(ok);
  });
  document.addEventListener("paste", (e) => {
    if (!isActive() || isTyping(e.target)) return;
    const files = [...(e.clipboardData?.files || [])].filter(filter);
    if (!files.length) return;
    e.preventDefault();
    onFiles(files.map((file) => ({ file })));
  });
}
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
export const isTyping = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

// ── recents (IndexedDB) ─────────────────────────────────────────────────────
// Each tool keeps its last few files: name, a small thumbnail, a line of info, the project (.qcut:
// layers or the edit) and a way back to the file (a FileSystemFileHandle where the browser has them,
// else the file itself if small). Projects live in their own store, keyed by the Recent's id; the
// Continue session of the same document points at the same one (one write per autosave).
const DB_NAME = "quickcut", DB_STORE = "recents", SESSION_STORE = "sessions", PROJ_STORE = "projects";
export const MAX_RECENTS = 8;
// Storage budget. Where the browser gives us a file handle (Chrome/Edge: drag-drop or the picker)
// we store only the handle + a tiny thumbnail + the project, never the file. Where it can't (Firefox,
// Safari, phones, pasted files), we keep a copy only of small files. Projects and copies together
// stay small; over the total, the oldest copies go first, then the oldest projects (never the one a
// Continue session uses). A project over MAX_KEEP_BYTES is written by its tool without the source
// file in it (the source is re-linked when it opens).
export const MAX_KEEP_BYTES = 48 * 1024 * 1024;  // one Recent's project, or its copy of the file
const MAX_KEEP_TOTAL = 200 * 1024 * 1024;        // all Recent projects and copies, every tool together
export const MAX_SESSION_FILE = 100 * 1024 * 1024; // a session's own copy of its source file (Color)
let dbp = null, dbh = null; // dbh: the open database once ready (a closing page must use it without awaiting)
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 3);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(DB_STORE)) d.createObjectStore(DB_STORE, { keyPath: "id" });
      if (!d.objectStoreNames.contains(SESSION_STORE)) d.createObjectStore(SESSION_STORE, { keyPath: "tool" });
      if (!d.objectStoreNames.contains(PROJ_STORE)) d.createObjectStore(PROJ_STORE, { keyPath: "id" });
    };
    r.onsuccess = () => {
      const d = r.result;
      // another tab (a newer version of the site) needs to upgrade: let it, reopen on next use
      d.onversionchange = () => { d.close(); dbp = null; dbh = null; };
      dbh = d;
      resolve(d);
    };
    r.onerror = () => { dbp = null; reject(r.error); };
    r.onblocked = () => { dbp = null; reject(new Error("QuickCut storage is busy in another tab")); };
  });
  return dbp;
}
/** One transaction. `store`: a name, or several (then `fn` gets {name: objectStore}). */
async function tx(mode, fn, store = DB_STORE) {
  // already open: the transaction starts in this task (no await first), so a page that is closing
  // still gets its write in
  const d = dbh || (await db());
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const out = fn(Array.isArray(store) ? Object.fromEntries(store.map((s) => [s, t.objectStore(s)])) : t.objectStore(store));
    // `out` is an IDBRequest (get/getAll) or nothing: resolve with the request's result, never
    // with the request itself (a missing record must come back as undefined)
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}
/** The id of a file's Recent (also the key of its project). */
export const recentId = (tool, file) => `${tool}:${file.name}:${file.size}:${file.lastModified}`;
/** Ids of the projects a Continue session uses (kept whatever the budget). */
async function sessionPids() {
  try { return new Set((await tx("readonly", (s) => s.getAll(), SESSION_STORE)).map((r) => r.pid).filter(Boolean)); } catch { return new Set(); }
}
/** Keep every tool's Recents to MAX_RECENTS and all copies + projects under MAX_KEEP_TOTAL. */
async function housekeep() {
  const [every, projs, keep] = await Promise.all([tx("readonly", (s) => s.getAll()), tx("readonly", (s) => s.getAll(), PROJ_STORE), sessionPids()]);
  every.sort((a, b) => b.at - a.at);
  const size = new Map(projs.map((p) => [p.id, p.blob?.size || 0]));
  const count = {}, gone = new Set();
  for (const r of every) { count[r.tool] = (count[r.tool] || 0) + 1; if (count[r.tool] > MAX_RECENTS) gone.add(r); }
  await tx("readwrite", ({ recents: s, projects: p }) => {
    for (const r of gone) { s.delete(r.id); if (!keep.has(r.id)) p.delete(r.id); }
    // over the total: the oldest copies go first (the entry stays; opening it asks for the file again), then the oldest projects
    let used = 0;
    const live = every.filter((r) => !gone.has(r));
    for (const r of live) used += (r.blob?.size || 0) + (size.get(r.id) || 0);
    for (const r of [...live].reverse()) { if (used <= MAX_KEEP_TOTAL) break; if (r.blob) { used -= r.blob.size; r.blob = null; s.put(r); } }
    for (const r of [...live].reverse()) { if (used <= MAX_KEEP_TOTAL) break; if (size.get(r.id) && !keep.has(r.id)) { used -= size.get(r.id); p.delete(r.id); } }
    // projects nobody points at any more
    const ids = new Set(live.map((r) => r.id));
    for (const pr of projs) if (!ids.has(pr.id) && !keep.has(pr.id)) p.delete(pr.id);
  }, [DB_STORE, PROJ_STORE]);
}
export const recents = {
  /** Newest first; each with `project` (the .qcut Blob) when it has one. */
  async list(tool) {
    try {
      const [all, projs] = await Promise.all([tx("readonly", (s) => s.getAll()), tx("readonly", (s) => s.getAllKeys(), PROJ_STORE)]);
      const has = new Set(projs);
      const list = all.filter((r) => r.tool === tool).sort((a, b) => b.at - a.at).slice(0, MAX_RECENTS);
      return list.map((r) => (has.has(r.id) ? { ...r, hasProject: true } : r));
    } catch { return []; }
  },
  /**
   * Remember a file. `thumb` is a small Blob (≈ 320 px JPEG/WebP), `sub` the info line, `dur` optional
   * duration chip. `copy: false` never keeps a copy of the file (a project holds it, or it is a video).
   */
  async add(tool, { file, handle, thumb, sub = "", dur = "", copy = true }) {
    try {
      const id = recentId(tool, file);
      const rec = { id, tool, name: file.name, size: file.size, at: Date.now(), thumb, sub, dur, handle: handle || null, blob: copy && !handle && file.size <= MAX_KEEP_BYTES ? file : null };
      await tx("readwrite", (s) => s.put(rec));
      await housekeep();
      return id;
    } catch { return null; }
  },
  /** The project of a Recent (a .qcut Blob) or null. */
  async project(id) {
    try { return (await tx("readonly", (s) => s.get(id), PROJ_STORE))?.blob || null; } catch { return null; }
  },
  /** Store a Recent's project (and its thumbnail / info line when given). */
  async saveProject(id, blob, { thumb, sub } = {}) {
    try {
      await tx("readwrite", ({ recents: s, projects: p }) => {
        p.put({ id, blob, at: Date.now() });
        if (thumb || sub) { const g = s.get(id); g.onsuccess = () => { const r = g.result; if (r) { if (thumb) r.thumb = thumb; if (sub) r.sub = sub; s.put(r); } }; }
      }, [DB_STORE, PROJ_STORE]);
      await housekeep();
    } catch (e) { console.warn("project not saved", e); }
  },
  async remove(id) {
    try {
      const keep = await sessionPids();
      await tx("readwrite", ({ recents: s, projects: p }) => { s.delete(id); if (!keep.has(id)) p.delete(id); }, [DB_STORE, PROJ_STORE]);
    } catch {}
  },
  /** Get the File back (asks for permission on a handle; needs a user gesture). null = gone. */
  async open(rec) {
    if (rec.handle) {
      try {
        if ((await rec.handle.queryPermission?.({ mode: "read" })) !== "granted" && (await rec.handle.requestPermission?.({ mode: "read" })) !== "granted") return null;
        return await rec.handle.getFile();
      } catch { return null; }
    }
    return rec.blob ? new File([rec.blob], rec.name, { type: rec.blob.type, lastModified: rec.blob.lastModified }) : null;
  },
};

// ── where the user left off (one saved session per tool) ────────────────────
// Each tool saves its working state while the user edits (debounced). Photo and Video save a
// project (.qcut): `pid` (the Recent's id) + `project` (the Blob), stored once in the projects store
// and shared with that Recent. Color saves `state` (structured-clonable, Blobs OK). The empty state
// then offers a one-click "Continue" card (a click is needed anyway: reopening a file handle asks
// the browser for permission).
//   session.save(tool, {name, sub, thumb, pid?, project?, file?, handle?, state?})
//   session.load(tool) → record (with `project` when it has one) | null        session.clear(tool)
//   session.saveSoon(tool, getRec): getRec({sync}) → record | Promise; on pagehide it is called with
//   {sync: true} and must return the record directly (the page won't wait for a promise)
const saveTimers = {}, savePending = {}; // tool → getRec of a save that hasn't run yet
export const session = {
  /** Save now; returns a promise. Big Blobs are fine (IndexedDB stores them on disk). */
  async save(tool, rec) {
    try {
      const file = rec.file && !rec.handle && rec.file.size <= MAX_SESSION_FILE ? rec.file : null;
      const { project, ...r } = rec;
      const row = { ...r, file: file || null, tool, at: Date.now() };
      if (!project) { await tx("readwrite", (s) => s.put(row), SESSION_STORE); return; }
      // the project goes in the shared store, and its Recent (if any) shows the same thumbnail
      row.pid ||= `${tool}:session`;
      await tx("readwrite", ({ sessions: s, projects: p, recents: rs }) => {
        s.put(row);
        p.put({ id: row.pid, blob: project, at: row.at });
        if (row.thumb || row.sub) { const g = rs.get(row.pid); g.onsuccess = () => { const x = g.result; if (x) { if (row.thumb) x.thumb = row.thumb; if (row.sub) x.sub = row.sub; rs.put(x); } }; }
      }, [SESSION_STORE, PROJ_STORE, DB_STORE]);
    } catch (e) { console.warn("session save failed", e); }
  },
  /** Save at most once per `ms` (call it on every change). */
  saveSoon(tool, getRec, ms = 800) {
    clearTimeout(saveTimers[tool]);
    savePending[tool] = getRec;
    db().catch(() => {}); // have the database open before the page might close
    saveTimers[tool] = setTimeout(() => runPending(tool), ms);
  },
  async load(tool) {
    try {
      const rec = (await tx("readonly", (s) => s.get(tool), SESSION_STORE)) || null;
      if (rec?.pid) rec.project = (await tx("readonly", (s) => s.get(rec.pid), PROJ_STORE))?.blob || null;
      return rec;
    } catch { return null; }
  },
  async clear(tool) {
    clearTimeout(saveTimers[tool]);
    delete savePending[tool];
    try {
      await tx("readwrite", ({ sessions: s, projects: p, recents: rs }) => {
        const g = s.get(tool);
        g.onsuccess = () => {
          const pid = g.result?.pid;
          s.delete(tool);
          // its project stays while a Recent still points at it
          if (pid) { const k = rs.getKey(pid); k.onsuccess = () => { if (k.result === undefined) p.delete(pid); }; }
        };
      }, [SESSION_STORE, PROJ_STORE, DB_STORE]);
    } catch {}
  },
  /** The session's file back (permission prompt for a handle; call from a click). */
  async file(rec) {
    if (rec.handle) {
      try {
        if ((await rec.handle.queryPermission?.({ mode: "read" })) !== "granted" && (await rec.handle.requestPermission?.({ mode: "read" })) !== "granted") return null;
        return await rec.handle.getFile();
      } catch { return null; }
    }
    return rec.file || null;
  },
};
/** Run a pending saveSoon now (a getRec that returns the record directly is saved in this same task). */
function runPending(tool, sync = false) {
  clearTimeout(saveTimers[tool]);
  const getRec = savePending[tool];
  delete savePending[tool];
  if (!getRec) return;
  try {
    const rec = getRec({ sync });
    if (rec && typeof rec.then === "function") rec.then((r) => r && session.save(tool, r), (e) => console.warn("session save failed", e));
    else if (rec) session.save(tool, rec);
  } catch (e) { console.warn("session save failed", e); }
}
// leaving the page: write the pending saves now instead of dropping them
addEventListener("pagehide", () => { for (const t of Object.keys(savePending)) runPending(t, true); });

const resumeURLs = new WeakMap(); // box → the blob URL of the thumbnail it shows (freed when redrawn)
/**
 * Render the "Continue" card into `box` (an element in the empty state, placed
 * above the drop zone). `onResume(rec)` is called on click; the tool restores `rec.project` / `rec.state`.
 */
export async function renderResume(box, tool, onResume) {
  const found = await session.load(tool);
  const old = resumeURLs.get(box);
  if (old) { URL.revokeObjectURL(old); resumeURLs.delete(box); }
  // only a real saved session of this tool (never another tool's, never an empty record)
  const rec = found && found.tool === tool && found.at && (found.state || found.project) ? found : null;
  box.hidden = !rec;
  box.replaceChildren();
  if (!rec) return;
  const b = h(`<div class="resume"><button class="resume-go" type="button"><span class="thumb"></span><span class="meta"><span class="k">Continue</span><span class="name"></span><span class="sub"></span></span><span class="cta">Continue ${icon("chevR", 14)}</span></button><button class="ib sm resume-x" type="button" aria-label="Forget this session">${icon("x", 14)}</button></div>`);
  b.querySelector(".name").textContent = rec.name || "Untitled";
  b.querySelector(".sub").textContent = [rec.sub, fmtAgo(rec.at)].filter(Boolean).join(" · ");
  if (rec.thumb) { const url = URL.createObjectURL(rec.thumb); resumeURLs.set(box, url); b.querySelector(".thumb").style.backgroundImage = `url("${url}")`; }
  b.querySelector(".resume-go").onclick = () => onResume(rec);
  b.querySelector(".resume-x").onclick = async () => { await session.clear(tool); box.hidden = true; };
  box.append(b);
}

const recentURLs = new WeakMap(); // box → the thumbnail blob URLs it shows (freed when redrawn or removed)
/**
 * Render the Recent section into `box` (up to 8; × forgets one). A Recent with a project calls
 * `onProject(rec)` (the tool reads `await recents.project(rec.id)` and re-links the file itself);
 * otherwise `onOpen(file, rec)` with the file.
 */
export async function renderRecents(box, tool, onOpen, { pickAgain, onProject } = {}) {
  const list = await recents.list(tool);
  for (const u of recentURLs.get(box) || []) URL.revokeObjectURL(u);
  const urls = new Set();
  recentURLs.set(box, urls);
  box.hidden = !list.length;
  const grid = box.querySelector(".grid");
  if (!list.length) { grid?.replaceChildren(); return; }
  grid.replaceChildren(...list.slice(0, MAX_RECENTS).map((r) => {
    let url = null;
    const wrap = h(`<div class="recent-wrap"><button class="ib sm recent-x" type="button" aria-label="Remove from Recent">${icon("x", 12)}</button></div>`);
    wrap.querySelector(".recent-x").onclick = async () => {
      await recents.remove(r.id);
      wrap.remove();
      if (url) { URL.revokeObjectURL(url); urls.delete(url); }
      if (!grid.children.length) box.hidden = true;
    };
    const b = h(`<button class="recent" type="button"><span class="thumb"></span><span class="meta"><span class="name"></span><span class="sub"></span></span></button>`);
    wrap.prepend(b);
    b.querySelector(".name").textContent = r.name;
    b.querySelector(".sub").textContent = [r.sub, fmtAgo(r.at)].filter(Boolean).join(" · ");
    if (r.thumb) {
      url = URL.createObjectURL(r.thumb);
      urls.add(url);
      b.querySelector(".thumb").style.backgroundImage = `url("${url}")`;
    }
    if (r.dur) b.querySelector(".thumb").append(h(`<span class="dur">${esc(r.dur)}</span>`));
    b.title = r.name;
    b.onclick = async () => {
      if (r.hasProject && onProject) { onProject(r); return; }
      const f = await recents.open(r);
      if (f) onOpen(f, r);
      else {
        toast(`Can't open ${r.name} any more. Choose it again.`, { bad: true });
        pickAgain?.();
      }
    };
    return wrap;
  }));
}

/** A small thumbnail Blob from any drawable (ImageBitmap, video, canvas). */
export async function thumbOf(src, w = 320) {
  const sw = src.displayWidth || src.videoWidth || src.width, sh = src.displayHeight || src.videoHeight || src.height;
  if (!sw || !sh) return null;
  const s = Math.min(1, w / sw);
  const c = new OffscreenCanvas(Math.max(1, Math.round(sw * s)), Math.max(1, Math.round(sh * s)));
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c.convertToBlob({ type: "image/jpeg", quality: 0.8 });
}

// ── files out ───────────────────────────────────────────────────────────────
/** Save a Blob: the native save dialog where available (so "Show in folder" makes sense), else a download. */
export async function saveFile(blob, name, { types } = {}) {
  if (window.showSaveFilePicker && types) {
    try {
      const handle = await showSaveFilePicker({ suggestedName: name, types });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return { handle, saved: true };
    } catch (e) {
      if (e.name === "AbortError") return { saved: false };
    }
  }
  download(blob, name);
  return { saved: true };
}
export function download(blob, name) {
  const a = h(`<a hidden></a>`);
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
export async function copyImage(blob) {
  try {
    const png = blob.type === "image/png" ? blob : await toPng(blob);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch { return false; }
}
async function toPng(blob) {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close();
  return c.convertToBlob({ type: "image/png" });
}

// ── keyboard ────────────────────────────────────────────────────────────────
/** Ctrl on Windows/Linux, Cmd on Mac. */
export const mod = (e) => e.ctrlKey || e.metaKey;

// ── movable floating bars ───────────────────────────────────────────────────
// Floating bars (crop options, properties, tool strip, layers card, zoom chips) can be dragged
// anywhere inside their stage by a grip, on desktop and tablet. The position is remembered per
// bar; double-click the grip (or press it and Escape) to put the bar back where the design has it.
// Phones dock bars to the screen edges, so there they don't move.
//   makeMovable(bar, "photo.crop")                 grip added at the start of the bar
//   makeMovable(bar, "photo.tools", {vertical: true})   grip on top (vertical strips)
// The bar must be absolutely positioned inside a positioned stage (its offsetParent).
const MOVE_KEY = "quickcut.bars";
let barPos = {};
try { barPos = JSON.parse(localStorage.getItem(MOVE_KEY) || "{}") || {}; } catch {}
const saveBars = () => { try { localStorage.setItem(MOVE_KEY, JSON.stringify(barPos)); } catch {} };
// Grouped floating bars (ui.css .gbar): related controls sit in a .grp, a thin line separates the
// groups, and whole groups wrap. A group that starts a new row gets .row-start (its line hidden).
export function groupBar(bar) {
  bar.classList.add("gbar");
  let raf = 0;
  const mark = () => {
    raf = 0;
    let prev = null;
    for (const g of bar.querySelectorAll(".grp")) {
      if (g.parentElement.closest(".grp") || !g.getClientRects().length) continue;
      const r = g.getBoundingClientRect();
      // a new row, or the end group pushed away to the right: no line
      g.classList.toggle("row-start", !prev || r.top >= prev.bottom - 2 || (g.classList.contains("end") && r.left - prev.right > 24));
      prev = r;
    }
  };
  const soon = () => { if (!raf) raf = requestAnimationFrame(mark); };
  new ResizeObserver(soon).observe(bar);
  new MutationObserver(soon).observe(bar, { childList: true, subtree: true });
  addEventListener("quickcut:zoom", soon);
  return mark;
}
export function makeMovable(bar, key, { vertical = false } = {}) {
  if (bar.querySelector(":scope > .grip")) return;
  const grip = h(`<button class="grip${vertical ? " v" : ""}" type="button" aria-label="Move this bar (double-click to reset)" title="Drag to move · double-click to reset"><svg width="${vertical ? 14 : 8}" height="${vertical ? 8 : 14}" viewBox="0 0 ${vertical ? "14 8" : "8 14"}" fill="currentColor" aria-hidden="true">${vertical
    ? "<circle cx='2' cy='2' r='1.2'/><circle cx='7' cy='2' r='1.2'/><circle cx='12' cy='2' r='1.2'/><circle cx='2' cy='6' r='1.2'/><circle cx='7' cy='6' r='1.2'/><circle cx='12' cy='6' r='1.2'/>"
    : "<circle cx='2' cy='2' r='1.2'/><circle cx='6' cy='2' r='1.2'/><circle cx='2' cy='7' r='1.2'/><circle cx='6' cy='7' r='1.2'/><circle cx='2' cy='12' r='1.2'/><circle cx='6' cy='12' r='1.2'/>"}</svg></button>`);
  bar.prepend(grip);
  bar.classList.add("movable");
  const zoomOf = () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const apply = () => {
    const p = barPos[key];
    if (!p || isPhone()) { bar.classList.remove("moved"); bar.style.removeProperty("--mx"); bar.style.removeProperty("--my"); return; }
    const stage = bar.offsetParent;
    if (!stage) return;
    // stored as fractions of the free space, so the bar stays put proportionally when the window resizes
    const fx = Math.min(1, Math.max(0, p.x)), fy = Math.min(1, Math.max(0, p.y));
    const x = Math.round(fx * Math.max(0, stage.clientWidth - bar.offsetWidth));
    const y = Math.round(fy * Math.max(0, stage.clientHeight - bar.offsetHeight));
    bar.classList.add("moved");
    bar.style.setProperty("--mx", `${x}px`);
    bar.style.setProperty("--my", `${y}px`);
  };
  let drag = null;
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || isPhone()) return;
    e.preventDefault();
    const stage = bar.offsetParent;
    if (!stage) return;
    const z = zoomOf(), sr = stage.getBoundingClientRect(), br = bar.getBoundingClientRect();
    drag = { id: e.pointerId, dx: (e.clientX - br.left) / z, dy: (e.clientY - br.top) / z, sr, z, stage };
    grip.setPointerCapture(e.pointerId);
    bar.classList.add("dragging");
  });
  grip.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { sr, z, stage } = drag;
    const fw = Math.max(1, stage.clientWidth - bar.offsetWidth), fh = Math.max(1, stage.clientHeight - bar.offsetHeight);
    const x = Math.min(fw, Math.max(0, (e.clientX - sr.left) / z - drag.dx));
    const y = Math.min(fh, Math.max(0, (e.clientY - sr.top) / z - drag.dy));
    barPos[key] = { x: x / fw, y: y / fh };
    apply();
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    bar.classList.remove("dragging");
    saveBars();
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  const reset = () => { delete barPos[key]; saveBars(); apply(); };
  grip.addEventListener("dblclick", reset);
  grip.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (e.key === "Escape" || e.key === "Delete") { e.preventDefault(); e.stopPropagation(); reset(); return; }
    if (!arrows[e.key] || isPhone()) return;
    e.preventDefault();
    const stage = bar.offsetParent;
    const p = barPos[key] || (() => {
      const fw = Math.max(1, stage.clientWidth - bar.offsetWidth), fh = Math.max(1, stage.clientHeight - bar.offsetHeight);
      return { x: bar.offsetLeft / fw, y: bar.offsetTop / fh };
    })();
    barPos[key] = { x: p.x + arrows[e.key][0], y: p.y + arrows[e.key][1] };
    apply();
    saveBars();
  });
  new ResizeObserver(apply).observe(bar);
  if (bar.offsetParent) new ResizeObserver(apply).observe(bar.offsetParent);
  addEventListener("resize", apply);
  addEventListener("quickcut:zoom", apply);
  requestAnimationFrame(apply);
  return { reset, apply };
}

// ── tooltips ────────────────────────────────────────────────────────────────
// Every `title` in QuickCut shows as a styled tooltip (design: bg-3, 12px, 120 ms) instead of the
// browser's plain box. Tools just keep using `title="Crop (C)"`; a trailing "(key)" becomes a key
// chip. Mouse/pen only (touch has no hover); hidden on press, scroll, key or leave.
{
  let tipEl = null, timer = 0, cur = null, warm = 0;
  const hide = () => {
    clearTimeout(timer);
    cur = null;
    tipEl?.classList.remove("in");
  };
  const showFor = (el) => {
    const text = el.dataset.tip;
    if (!text || !el.isConnected) return;
    tipEl ||= document.body.appendChild(h(`<div class="tip" role="tooltip"></div>`));
    const m = text.match(/^(.*?)\s*\(([^()]{1,24})\)$/);
    tipEl.innerHTML = m ? `${esc(m[1])}<span class="kbd">${esc(m[2])}</span>` : esc(text);
    const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const r = el.getBoundingClientRect();
    const vw = innerWidth / z, vh = innerHeight / z;
    tipEl.style.left = "0px"; tipEl.style.top = "0px";
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    const L = r.left / z, R = r.right / z, T = r.top / z, B = r.bottom / z;
    // vertical tool strips: to the right; everything else: below (above if no room)
    const side = r.height > r.width * 1.6 || el.closest("[data-tip-side='right']") ? "right" : (B + 8 + th > vh ? "top" : "bottom");
    let x, y;
    if (side === "right") { x = R + 8; y = (T + B) / 2 - th / 2; }
    else { x = (L + R) / 2 - tw / 2; y = side === "top" ? T - th - 8 : B + 8; }
    tipEl.style.left = `${Math.max(6, Math.min(vw - tw - 6, x))}px`;
    tipEl.style.top = `${Math.max(6, Math.min(vh - th - 6, y))}px`;
    tipEl.classList.add("in");
    warm = performance.now();
  };
  // no tooltips while a button is held (dragging a bar, a slider, a layer) or just after release
  let pressed = 0, quietUntil = 0;
  addEventListener("pointerdown", () => { pressed++; }, true);
  const release = () => { pressed = 0; quietUntil = performance.now() + 400; };
  addEventListener("pointerup", release, true);
  addEventListener("pointercancel", release, true);
  addEventListener("dragstart", () => { pressed = 1; }, true);
  addEventListener("dragend", release, true);
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    if (pressed || e.buttons || performance.now() < quietUntil) { hide(); return; }
    const el = e.target.closest?.("[title], [data-tip]");
    if (el === cur) return;
    hide();
    if (!el) return;
    // the title moves to data-tip for good (a later `el.title = …` update is picked up next hover);
    // aria-label keeps the name for screen readers
    if (el.title) { el.dataset.tip = el.title; if (!el.hasAttribute("aria-label") && !el.textContent.trim()) el.setAttribute("aria-label", el.title); el.removeAttribute("title"); }
    cur = el;
    // quick after a tooltip was just shown (moving along a toolbar), else a short delay
    timer = setTimeout(() => cur === el && !pressed && showFor(el), performance.now() - warm < 600 ? 60 : 450);
  }, true);
  document.addEventListener("pointerout", (e) => { if (cur && !cur.contains(e.relatedTarget)) hide(); }, true);
  for (const t of ["pointerdown", "wheel", "keydown", "scroll"]) addEventListener(t, hide, { capture: true, passive: true });
  addEventListener("blur", hide);
}

// ── "Done" notification ─────────────────────────────────────────────────────
// After an export, the popover closes and a small card appears in the bottom-right corner
// (above the bottom bar on phones): check, "Saved · 13 KB · 0.2 s", file name, and up to two
// actions. It goes away by itself after a few seconds (paused while hovered or focused), or with ×.
//   doneCard({ title: "Saved · 13 KB · 0.2 s", file: "harbour_crop.jpg",
//              actions: [{label: "Download again", icon: "download", run}, {label: "Copy", icon: "copy", run}] })
let doneBox = null;
export function doneCard({ title, file = "", actions = [], ms = 6000 } = {}) {
  if (!doneBox) { doneBox = h(`<div class="done-cards" aria-live="polite"></div>`); document.body.append(doneBox); }
  while (doneBox.children.length >= 2) doneBox.firstElementChild.remove();
  const el = h(`<section class="done-card" role="status">
    <span class="ok">${icon("check", 16, { stroke: 2 })}</span>
    <span class="t"><b></b><span class="f"></span></span>
    <button class="ib sm x" type="button" aria-label="Dismiss">${icon("x", 14)}</button>
    <div class="acts"></div>
    <span class="bar" aria-hidden="true"></span>
  </section>`);
  el.querySelector("b").textContent = title;
  el.querySelector(".f").textContent = file;
  el.querySelector(".f").title = file;
  const acts = el.querySelector(".acts");
  for (const a of actions.slice(0, 2)) {
    const b = h(`<button class="btn-g sm" type="button">${a.icon ? icon(a.icon, 14) : ""}<span></span></button>`);
    b.querySelector("span").textContent = a.label;
    b.onclick = async () => { await a.run?.(); };
    acts.append(b);
  }
  if (!actions.length) acts.remove();
  let left = ms, started = performance.now(), timer = 0;
  const bar = el.querySelector(".bar");
  const close = () => { clearTimeout(timer); el.classList.remove("in"); setTimeout(() => el.remove(), 160); };
  const run = () => {
    started = performance.now();
    timer = setTimeout(close, left);
    bar.style.transition = `transform ${left}ms linear`;
    bar.style.transform = "scaleX(0)";
  };
  const pause = () => {
    clearTimeout(timer);
    left = Math.max(1200, left - (performance.now() - started));
    const s = getComputedStyle(bar).transform;
    bar.style.transition = "none";
    bar.style.transform = s === "none" ? "scaleX(1)" : s;
  };
  el.addEventListener("pointerenter", pause);
  el.addEventListener("pointerleave", run);
  el.addEventListener("focusin", pause);
  el.addEventListener("focusout", (e) => { if (!el.contains(e.relatedTarget)) run(); });
  el.querySelector(".x").onclick = close;
  doneBox.append(el);
  requestAnimationFrame(() => { el.classList.add("in"); requestAnimationFrame(run); });
  return { close };
}
