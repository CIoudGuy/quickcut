// QuickCut shell: one page, three tools. Each tool is an ES module loaded the first time its tab
// opens (and prefetched when the browser is idle), mounted into its own <section>, and kept alive
// afterwards so switching back is instant. Hidden tools stop their work (`hide()`).
//
// Tool module contract (photo/photo.js, video/video.js, color/color.js):
//   export function mount(root: HTMLElement): {
//     show?(): void,      // the tab became visible
//     hide?(): void,      // the tab was hidden: pause playback, stop animation loops
//     back?(): boolean,   // mouse Back with no popover open (e.g. leave crop mode); true = handled
//   }
import { globalKeys } from "./shared/keys.js";
import { mod, setBackHandler, isTyping, syncSlider, h, icon, openLayer, topLayer, closeTop, toast } from "./shared/ui.js";

const TOOLS = ["photo", "video", "color"];
const STORE = "quickcut.tab";
const tabs = Object.fromEntries(TOOLS.map((t) => [t, document.getElementById(`tab-${t}`)]));
const views = Object.fromEntries(TOOLS.map((t) => [t, document.getElementById(`view-${t}`)]));
const pill = document.querySelector(".pill");
const mounted = {};
const loading = {};
let active = null;

function load(tool) {
  loading[tool] ||= import(`./${tool}/${tool}.js`).then((m) => {
    views[tool].classList.remove("boot");
    mounted[tool] = m.mount(views[tool]) || {};
    return mounted[tool];
  }).catch((e) => {
    console.error(e);
    views[tool].classList.remove("boot");
    views[tool].innerHTML = `<div class="empty"><p class="small">This tool failed to load. Reload the page to try again.</p></div>`;
  });
  return loading[tool];
}

async function show(tool, { focus = false } = {}) {
  if (!TOOLS.includes(tool) || tool === active) return;
  const prev = active;
  active = tool;
  for (const t of TOOLS) {
    const on = t === tool;
    tabs[t].setAttribute("aria-selected", String(on));
    tabs[t].tabIndex = on ? 0 : -1;
    views[t].hidden = !on;
  }
  movePill();
  document.title = `${tabs[tool].textContent} · QuickCut`;
  try { localStorage.setItem(STORE, tool); } catch {}
  if (location.hash.slice(1) !== tool) history.replaceState(null, "", `#${tool}`);
  if (prev) mounted[prev]?.hide?.();
  if (!mounted[tool]) views[tool].classList.add("boot");
  const m = await load(tool);
  if (active === tool) m?.show?.();
  if (focus) tabs[tool].focus();
  idle(prefetch);
}

let pillPlaced = false;
function movePill() {
  const i = TOOLS.indexOf(active);
  document.documentElement.dataset.tool = active;
  // first placement (page load / refresh): no slide; later tab switches slide
  if (!pillPlaced) {
    document.documentElement.classList.add("no-anim");
    pill.style.transform = `translateX(${i * 100}%)`;
    requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove("no-anim")));
    pillPlaced = true;
    return;
  }
  pill.style.transform = `translateX(${i * 100}%)`;
}

function remembered() {
  const h = location.hash.slice(1);
  if (TOOLS.includes(h)) return h;
  try { const t = localStorage.getItem(STORE); if (TOOLS.includes(t)) return t; } catch {}
  return "photo";
}

const idle = (fn) => (window.requestIdleCallback || ((cb) => setTimeout(cb, 1200)))(fn, { timeout: 3000 });
let prefetched = false;
function prefetch() {
  if (prefetched) return;
  prefetched = true;
  const c = navigator.connection;
  if (c && (c.saveData || /(^|-)2g$|^3g$/.test(c.effectiveType || ""))) return;
  // download the other tools' code without running it
  for (const t of TOOLS) {
    if (t === active || loading[t]) continue;
    const l = document.createElement("link");
    l.rel = "modulepreload";
    l.href = `${t}/${t}.js`;
    document.head.append(l);
  }
}

// ── interface size ──────────────────────────────────────────────────────────
// CSS zoom on <html>, 70–160 % in 10 % steps; 110 % by default on computers, 100 % on phones.
// The browser's own page zoom (Ctrl +/−, Ctrl+wheel) is replaced so nothing jumps to a huge size;
// Ctrl+wheel and pinch inside a canvas belong to that tool (it zooms the image/timeline).
const ZOOM_KEY = "quickcut.zoom", ZMIN = 0.7, ZMAX = 1.6;
const zoomOut = document.getElementById("zoom-value");
const defaultZoom = () => (matchMedia("(max-width: 599px)").matches ? 1 : 1.1);
let zoom = parseFloat(document.documentElement.style.zoom) || defaultZoom();
function setZoom(z) {
  zoom = Math.round(Math.min(ZMAX, Math.max(ZMIN, z)) * 10) / 10;
  const r = document.documentElement;
  r.style.zoom = zoom;
  r.style.setProperty("--zoom", zoom);
  zoomOut.textContent = `${Math.round(zoom * 100)}%`;
  try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch {}
  dispatchEvent(new Event("quickcut:zoom"));
}
document.querySelector(".zoom").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.z) setZoom(zoom + Number(b.dataset.z) * 0.1);
  else setZoom(defaultZoom());
});
// Ctrl+wheel (and trackpad pinch, which browsers report as Ctrl+wheel) sizes the interface in the
// same 10% steps as the − / + buttons, everywhere except canvases that zoom their own content
// (marked data-wheel-zoom: the image, the timeline). Small trackpad deltas add up to one step.
let wheelAcc = 0, wheelT = 0;
addEventListener("wheel", (e) => {
  if (!e.ctrlKey || e.target.closest?.("[data-wheel-zoom]")) return;
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  const now = performance.now();
  if (now - wheelT > 300) wheelAcc = 0; // a new gesture
  wheelT = now;
  wheelAcc += dy;
  const STEP = 60; // ≈ half a mouse notch; trackpad pinches need a deliberate movement
  if (Math.abs(wheelAcc) < STEP) return;
  const dir = wheelAcc < 0 ? 1 : -1;
  wheelAcc = 0;
  setZoom(zoom + dir * 0.1);
}, { passive: false });

// ── keys ────────────────────────────────────────────────────────────────────
// Global keys live in the shared registry (shared/keys.js) so the ? sheet of every tool lists them
// in a "Global" group and the user can change them. They also work while a field has the focus.
const G = globalKeys;
TOOLS.forEach((t, i) => G.add({ id: `tab.${t}`, label: tabs[t].textContent, group: "Global", keys: `Alt+${i + 1}`, typing: true, run: () => show(t) }));
G.add({ id: "zoom.in", label: "Interface +", group: "Global", keys: "Ctrl+=|Ctrl+Shift+=", typing: true, run: () => setZoom(zoom + 0.1) });
G.add({ id: "zoom.out", label: "Interface −", group: "Global", keys: "Ctrl+-|Ctrl+Shift+-", typing: true, run: () => setZoom(zoom - 0.1) });
G.add({ id: "zoom.reset", label: "Interface 100%", group: "Global", keys: "Ctrl+0", typing: true, run: () => setZoom(defaultZoom()) });
addEventListener("keydown", (e) => { G.dispatch(e); }, true);
// the browser's own zoom keys stay blocked even when rebound (a stray Ctrl+Plus must not resize the page)
addEventListener("keydown", (e) => {
  if (!mod(e) || e.altKey) return;
  if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "0" || e.code === "NumpadAdd" || e.code === "NumpadSubtract" || e.code === "Numpad0") e.preventDefault();
}, true);

// Browser defaults that collide with editor shortcuts (Ctrl+E search bar, Ctrl+S save page,
// Ctrl+O open file, Ctrl+P print, Ctrl+D bookmark, Ctrl+G find next, Ctrl+J downloads, Ctrl+H
// history, Ctrl+K search, Ctrl+U view source, Ctrl+B/I bookmarks/… , Ctrl+A select page,
// Ctrl+Shift+C/I/J devtools-ish, Ctrl+Y history on some systems) are blocked so QuickCut gets them.
// Runs last (window, bubble phase): tools handle the key first and may also preventDefault.
// Not blocked: typing in fields keeps native editing (Ctrl+A/C/V/X/Z in a text box), and keys the
// browser reserves anyway (Ctrl+T/W/N, Ctrl+Shift+N/T, Ctrl+Tab) can't be taken by any page.
const CLAIM = new Set(["e", "s", "o", "p", "d", "g", "j", "h", "k", "u", "b", "i", "m", "y", "a", "f12"]);
const CLAIM_SHIFT = new Set(["c", "e", "s", "m", "v", "z", "x", "d", "i", "j", "o"]);
const CLAIM_ALT = new Set(["e", "f", "d"]); // browser menu accelerators on Windows
addEventListener("keydown", (e) => {
  if (isTyping(e.target)) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  if (mod(e) && !e.altKey && (e.shiftKey ? CLAIM_SHIFT.has(k) : CLAIM.has(k))) e.preventDefault();
  else if (e.altKey && !mod(e) && !e.shiftKey && CLAIM_ALT.has(k)) e.preventDefault();
  else if (e.key === "F1" || e.key === "F3" || e.key === "F7") e.preventDefault(); // help, find, caret browsing
  else if (e.key === "/" && !mod(e) && !e.altKey) e.preventDefault(); // Firefox quick find
  else if (e.key === "'" && !mod(e) && !e.altKey) e.preventDefault(); // Firefox quick link find
});

document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (b) show(b.dataset.tool);
});
document.querySelector(".tabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const i = (TOOLS.indexOf(active) + (e.key === "ArrowRight" ? 1 : 2)) % 3;
  show(TOOLS[i], { focus: true });
});
addEventListener("hashchange", () => show(location.hash.slice(1)));

// the "Open source" chip in the top bar is a plain link to the GitHub repo (index.html)
setBackHandler(() => mounted[active]?.back?.());

zoomOut.textContent = `${Math.round(zoom * 100)}%`;
for (const s of document.querySelectorAll(".slider")) syncSlider(s);
show(remembered());
// a tool can switch tabs (e.g. "pick colours from this photo"): dispatchEvent(new CustomEvent("quickcut:open", {detail: "color"}))
addEventListener("quickcut:open", (e) => show(e.detail));
// a project opened in the other tool (a Video .qcut dropped on Photo, …): that tool opens it
addEventListener("quickcut:project", async (e) => {
  const { tool, file, handle } = e.detail || {};
  if (!TOOLS.includes(tool)) return;
  await show(tool);
  (await load(tool))?.openProject?.(file, handle);
});

// ── drops anywhere: every file goes to the tool it belongs to ─────────────────
// Videos open in Video, images in Photo (or Color Picker when that's open), projects (.qcut) in the
// tool that made them. A drop on the wrong tab, or outside a tool's own drop area (top bar, …),
// switches tab and hands the files to that tool exactly like a drop on it; nothing ever makes the
// browser navigate to the dropped file.
const isVideoFile = (f) => /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name);
const isImageFile = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|avif|gif|bmp|heic|heif|svg)$/i.test(f.name);
const hasDropFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
let routing = false;
const dropZone = (tool) => views[tool].querySelector(".ph") || views[tool]; // where each tool listens for drops
function handTo(tool, files) {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  const target = dropZone(tool);
  routing = true;
  try { target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); } finally { routing = false; }
}
async function routeTo(tool, files) { await show(tool); await load(tool); handTo(tool, files); }
addEventListener("dragover", (e) => { if (hasDropFiles(e)) e.preventDefault(); });
// while files are dragged over the window, the open tool shows it's ready (shell.css: html.files-over)
let fileDrag = 0;
const filesOver = (on) => { if (!on) fileDrag = 0; document.documentElement.classList.toggle("files-over", on); };
addEventListener("dragenter", (e) => { if (hasDropFiles(e)) { fileDrag++; filesOver(true); } });
addEventListener("dragleave", (e) => { if (hasDropFiles(e) && --fileDrag <= 0) filesOver(false); });
addEventListener("drop", () => filesOver(false));
addEventListener("dragend", () => filesOver(false));
addEventListener("drop", (e) => {
  if (routing || !hasDropFiles(e)) return;
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  const vids = files.filter(isVideoFile), imgs = files.filter(isImageFile), other = files.filter((f) => !isVideoFile(f) && !isImageFile(f));
  const inActive = !!mounted[active] && dropZone(active).contains(e.target);
  let tool, list;
  if (vids.length) { tool = "video"; list = [...other, ...vids]; } // a project dropped with its video goes along
  else if (imgs.length && !other.length) { tool = active === "color" ? "color" : "photo"; list = imgs; }
  else if (other.length) {
    // maybe a project: Photo and Video read them (and pass each other's on); elsewhere, find its tool here
    if ((active === "photo" || active === "video") && inActive) return;
    e.preventDefault(); e.stopPropagation();
    (async () => {
      try {
        const q = await import("./shared/qcut.js");
        for (const f of other) {
          if (!(await q.sniff(f))) continue;
          const t = (await q.read(f)).type;
          if (t === "photo" || t === "video") { await routeTo(t, [f]); return; }
        }
        toast("Can't open that file", { bad: true });
      } catch { toast("Can't open that file", { bad: true }); }
    })();
    return;
  } else return;
  if (tool === active && inActive) return; // the tool's own drop area takes it
  e.preventDefault(); e.stopPropagation();
  routeTo(tool, list);
}, true);

// ── service worker (a speed-up only: repeat visits and offline use; nothing depends on it) ──
// Registered after the page has loaded and gone idle so it never competes with the first visit.
// If a newer version takes over while the page is open, say so quietly; nothing reloads by itself.
if ("serviceWorker" in navigator && window.isSecureContext) {
  const hadController = !!navigator.serviceWorker.controller;
  if (hadController) navigator.serviceWorker.addEventListener("controllerchange", () => toast("Updated. Reload to get the latest.", { info: true, ms: 6000 }));
  const reg = () => {
    const c = navigator.connection;
    if (c?.saveData) return;
    // while developing on this computer the files change all the time: only with localStorage.qcSw = "1"
    let dev = false;
    try { dev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && localStorage.getItem("qcSw") !== "1"; } catch { /* storage blocked */ }
    if (dev) return;
    navigator.serviceWorker.register("sw.js").catch(() => { /* blocked or unsupported: the site works the same */ });
  };
  if (document.readyState === "complete") idle(reg); else addEventListener("load", () => idle(reg), { once: true });
}

// ── "Open with QuickCut" from the installed app (File Handling API; an extra, nothing depends on it) ──
// Images open in Photo, videos in Video: handed to the tool exactly like a dropped file.
if ("launchQueue" in window) {
  launchQueue.setConsumer(async (params) => {
    try {
      const files = (await Promise.all((params.files || []).map((fh) => fh.getFile().catch(() => null)))).filter(Boolean);
      if (!files.length) return;
      const isVideo = (f) => /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name);
      const tool = isVideo(files[0]) ? "video" : "photo";
      const list = tool === "video" ? [files[0]] : files.filter((f) => !isVideo(f));
      await show(tool);
      await load(tool);
      const dt = new DataTransfer();
      for (const f of list) dt.items.add(f);
      const target = views[tool].querySelector(".ph") || views[tool];
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    } catch (e) { console.error(e); }
  });
}
export { isTyping };
