// Palette Studio: turn the palette into a PNG (Stripes, Grid, Dots, Honeycomb, Poster).
// The preview and the exported file are drawn by the same function; the PNG is encoded by the
// browser off the main thread (OffscreenCanvas.convertToBlob) and kept ready while you change options.
import { topLayer, h, esc, icon, openLayer, toast, saveFile, copyImage, isPhone, fmtBytes, baseName, doneCard } from "../shared/ui.js";

const NAMES = [
  ["#000000", "Black"], ["#1B1B1F", "Ink"], ["#36363C", "Charcoal"], ["#6B6B73", "Slate"], ["#A3A3AB", "Silver"], ["#D4D4D8", "Fog"], ["#F4F4F5", "Cloud"], ["#FFFFFF", "White"],
  ["#7A1F2B", "Wine"], ["#B3261E", "Brick"], ["#E5484D", "Red"], ["#F26B5B", "Coral"], ["#F2A877", "Peach"], ["#E8833A", "Orange"], ["#C98F68", "Clay"], ["#8A5A3C", "Chestnut"], ["#5B3A29", "Cocoa"],
  ["#F6C79A", "Sand"], ["#E2C08D", "Straw"], ["#D9B26F", "Honey"], ["#F5B83D", "Amber"], ["#F2D94E", "Yellow"], ["#FFF0CC", "Cream"], ["#FBEFE3", "Linen"], ["#EDE6DA", "Ivory"], ["#9A8F80", "Taupe"],
  ["#B7D36B", "Lime"], ["#7DBA5A", "Leaf"], ["#3F9B58", "Green"], ["#35614F", "Pine"], ["#A9C8B5", "Sage"], ["#1F5F4A", "Forest"], ["#6FD1B8", "Mint"], ["#2BA6A0", "Teal"],
  ["#8DB3CF", "Sky"], ["#5BA4E6", "Azure"], ["#2F6FEB", "Blue"], ["#2C5A78", "Harbour"], ["#1E3F56", "Deep"], ["#1F3550", "Navy"], ["#3E4C66", "Dusk blue"], ["#5C6F99", "Steel"], ["#D6E4F0", "Ice"],
  ["#6F5F86", "Dusk"], ["#8B6FD1", "Violet"], ["#B79AE8", "Lilac"], ["#5A3E8C", "Grape"], ["#D86FB0", "Orchid"], ["#F29BC1", "Rose"], ["#E8B4C8", "Blush"], ["#9C3D6B", "Plum"], ["#3A3740", "Graphite"],
];
const NAME_RGB = NAMES.map(([x, n]) => [parseInt(x.slice(1, 3), 16), parseInt(x.slice(3, 5), 16), parseInt(x.slice(5, 7), 16), n]);

/** Friendly names for a palette: the nearest name of a small table, never the same name twice. */
export function colorNames(hexes) {
  const used = new Set();
  return hexes.map((hex) => {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    let best = null, bd = Infinity;
    for (const c of NAME_RGB) {
      if (used.has(c[3])) continue;
      const rm = (r + c[0]) / 2, dr = r - c[0], dg = g - c[1], db = b - c[2];
      const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
      if (d < bd) { bd = d; best = c[3]; }
    }
    used.add(best);
    return best;
  });
}
const lum = (hex) => {
  const f = (i) => { const v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(1) + 0.7152 * f(3) + 0.0722 * f(5);
};
const fgFor = (hex) => (lum(hex) > 0.4 ? "#18181B" : "#FFFFFF");

const STYLES = [
  ["stripes", "Stripes", "M2.5 2.5h11v11h-11zM6 2.5v11M9.5 2.5v11"],
  ["grid", "Grid", "M2.5 2.5h11v11h-11zM8 2.5v11M2.5 8h11"],
  ["dots", "Dots", "M3 5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M10 5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M3 11a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M10 11a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0"],
  ["honeycomb", "Honeycomb", "M5 2l3 1.7v3.5L5 9 2 7.2V3.7zM11 2l3 1.7v3.5L11 9 8 7.2V3.7zM8 7.2l3 1.8v3.4L8 14.2 5 12.4V9"],
  ["poster", "Poster", "M3 1.5h10v13H3zM3 9.5h10M5.5 12h5"],
];
const size = (style) => (style === "poster" ? [1000, 1400] : [1400, 1000]);
const SANS = '"Inter", system-ui, sans-serif', MONO = '"JetBrains Mono", ui-monospace, Consolas, monospace';

function rr(ctx, x, y, w, hh, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, hh, r); else ctx.rect(x, y, w, hh);
}
/** Largest font size (≤ start) at which `text` fits `maxW`. */
function fit(ctx, text, weight, family, start, maxW, min = 9) {
  let px = start;
  for (; px > min; px -= 1) { ctx.font = `${weight} ${px}px ${family}`; if (ctx.measureText(text).width <= maxW) break; }
  ctx.font = `${weight} ${px}px ${family}`;
  return px;
}
function label(ctx, c, o, x, y, maxW, fg, align = "left", px = 30) {
  // draws name and/or hex with the baseline of the last line at y
  ctx.fillStyle = fg;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  let yy = y;
  if (o.hex) {
    const s = fit(ctx, c.hex, 400, MONO, px * 0.88, maxW);
    ctx.globalAlpha = 0.86;
    ctx.fillText(c.hex, x, yy);
    ctx.globalAlpha = 1;
    yy -= s * 1.45;
  }
  if (o.names) {
    fit(ctx, c.name, 600, SANS, px, maxW);
    ctx.fillText(c.name, x, yy);
  }
}

/** Draw the palette onto ctx at W×H (logical units). `scale` is device scale for crisp previews. */
export function drawPalette(ctx, W, H, style, o, colors, src, title) {
  const n = colors.length;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  if (!n) { ctx.fillStyle = "#222"; ctx.fillRect(0, 0, W, H); ctx.restore(); return; }
  if (style === "stripes") {
    const sw = W / n;
    colors.forEach((c, i) => {
      ctx.fillStyle = c.hex; ctx.fillRect(Math.floor(i * sw), 0, Math.ceil(sw) + 1, H);
      const pad = Math.min(36, sw * 0.12);
      label(ctx, c, o, i * sw + pad, H - pad - 4, sw - pad * 2, fgFor(c.hex), "left", Math.min(40, sw * 0.17));
    });
  } else if (style === "grid") {
    ctx.fillStyle = "#F4F4F5"; ctx.fillRect(0, 0, W, H);
    const cols = n <= 3 ? n : n <= 4 ? 2 : n <= 6 ? 3 : 4, rows = Math.ceil(n / cols);
    const m = 70, gap = 36, textH = o.names || o.hex ? 100 : 0;
    const cw = (W - m * 2 - gap * (cols - 1)) / cols, chh = (H - m * 2 - gap * (rows - 1)) / rows;
    colors.forEach((c, i) => {
      const x = m + (i % cols) * (cw + gap), y = m + Math.floor(i / cols) * (chh + gap);
      ctx.fillStyle = c.hex; rr(ctx, x, y, cw, chh - textH, 18); ctx.fill();
      label(ctx, c, o, x + 4, y + chh - 14 - (o.names && o.hex ? 0 : 0), cw - 8, "#18181B", "left", Math.min(34, cw * 0.14));
    });
  } else if (style === "dots") {
    ctx.fillStyle = "#151516"; ctx.fillRect(0, 0, W, H);
    const cols = n <= 4 ? n : n <= 8 ? Math.ceil(n / 2) : Math.ceil(n / 3), rows = Math.ceil(n / cols);
    const m = 60, cw = (W - m * 2) / cols, chh = (H - m * 2) / rows;
    colors.forEach((c, i) => {
      const cx = m + (i % cols) * cw + cw / 2, cy = m + Math.floor(i / cols) * chh + chh / 2;
      const hasText = o.names || o.hex;
      const r = Math.min(cw * 0.4, (chh - (hasText ? 90 : 0)) * 0.46);
      ctx.fillStyle = c.hex; ctx.beginPath(); ctx.arc(cx, cy - (hasText ? 30 : 0), r, 0, Math.PI * 2); ctx.fill();
      label(ctx, c, o, cx, cy + r - (hasText ? 30 : 0) + (o.names && o.hex ? 78 : 56), cw - 20, "#EDEDEF", "center", Math.min(30, cw * 0.14));
    });
  } else if (style === "honeycomb") {
    ctx.fillStyle = "#EDEDEF"; ctx.fillRect(0, 0, W, H);
    const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.25))), rows = Math.ceil(n / cols), m = 70, s3 = Math.sqrt(3);
    const R = Math.min((W - m * 2) / (s3 * (cols + (rows > 1 ? 0.5 : 0))), (H - m * 2) / (1.5 * rows + 0.5));
    const gw = s3 * R * (cols + (rows > 1 ? 0.5 : 0)), gh = R * (1.5 * rows + 0.5);
    const ox = (W - gw) / 2, oy = (H - gh) / 2;
    colors.forEach((c, i) => {
      const r = Math.floor(i / cols), q = i % cols;
      const cx = ox + s3 * R / 2 + q * s3 * R + (r % 2 ? s3 * R / 2 : 0), cy = oy + R + r * 1.5 * R;
      ctx.fillStyle = c.hex; ctx.beginPath();
      for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + k * Math.PI / 3; const px = cx + (R - 4) * Math.cos(a), py = cy + (R - 4) * Math.sin(a); k ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
      ctx.closePath(); ctx.fill();
      const lines = (o.names ? 1 : 0) + (o.hex ? 1 : 0);
      if (lines) label(ctx, c, o, cx, cy + (lines === 2 ? 12 : 10), R * 1.5, fgFor(c.hex), "center", Math.min(30, R * 0.24));
    });
  } else { // poster
    ctx.fillStyle = "#F5F3EF"; ctx.fillRect(0, 0, W, H);
    const m = 70, iw = W - m * 2, ih = 700;
    if (src && src.width) {
      const s = Math.max(iw / src.width, ih / src.height), sw = iw / s, sh = ih / s;
      ctx.save(); ctx.beginPath(); ctx.rect(m, m, iw, ih); ctx.clip();
      ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, m, m, iw, ih);
      ctx.restore();
    } else { ctx.fillStyle = colors[0].hex; ctx.fillRect(m, m, iw, ih); }
    ctx.fillStyle = "#18181B"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    fit(ctx, title || "Palette", 600, SANS, 52, iw);
    ctx.fillText(title || "Palette", m, m + ih + 84);
    const per = Math.min(n, 6), rowsN = Math.ceil(n / per), gap = 16, cw = (iw - gap * (per - 1)) / per;
    const top = m + ih + 130, rowH = (H - m - top) / rowsN;
    colors.forEach((c, i) => {
      const x = m + (i % per) * (cw + gap), y = top + Math.floor(i / per) * rowH;
      const sh = rowH - (o.names || o.hex ? 78 : 14);
      ctx.fillStyle = c.hex; rr(ctx, x, y, cw, sh, 6); ctx.fill();
      if (o.names || o.hex) label(ctx, c, o, x, y + sh + (o.names && o.hex ? 60 : 36), cw, "#18181B", "left", Math.min(26, cw * 0.13));
    });
  }
  ctx.restore();
}

/**
 * Open the dialog.
 * @param {{colors: string[], name: string, source: HTMLCanvasElement, anchor: HTMLElement, onClose?: Function}} p
 */
let live = null; // sets the options of the open dialog
/** Set the remembered style / labels / hex choices (undo and redo); updates the dialog if it is open. */
export function setStudioOpts(o) {
  try { localStorage.setItem("quickcut.color.studio", JSON.stringify({ style: o.style, names: o.names, hex: o.hex })); } catch {}
  live?.(o);
}
export function openStudio(p) {
  const names = colorNames(p.colors);
  const colors = p.colors.map((hex, i) => ({ hex, name: names[i] }));
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("quickcut.color.studio") || "{}") || {}; } catch {}
  const state = { style: STYLES.some((x) => x[0] === saved.style) ? saved.style : "stripes", names: saved.names !== false, hex: saved.hex !== false, phase: "idle", blob: null, rendering: 0, name: baseName(p.name) };
  const remember = () => { try { localStorage.setItem("quickcut.color.studio", JSON.stringify({ style: state.style, names: state.names, hex: state.hex })); } catch {} };
  const phone = isPhone();
  const el = h(`<section role="dialog" aria-label="Palette Studio" class="studio">
    <div class="pop-head"><span class="pop-title" style="flex-direction:row;align-items:center">Palette Studio</span><button class="ib sm st-x" type="button" aria-label="Close (Esc or mouse Back)">${icon("x")}</button></div>
    <div class="st-body">
      <div class="st-preview" role="img"><canvas></canvas></div>
      <div class="st-side">
        <div class="st-styles" role="radiogroup" aria-label="Style"></div>
        <div class="st-sw"><label class="switch"><input type="checkbox" class="sw-names"${saved.names === false ? "" : " checked"}><span class="track"></span>Labels</label><label class="switch"><input type="checkbox" class="sw-hex"${saved.hex === false ? "" : " checked"}><span class="track"></span>Hex values</label></div>
        <div class="st-state"></div>
      </div>
    </div>
  </section>`);
  const styleBox = el.querySelector(".st-styles");
  for (const [id, text, d] of STYLES) {
    const b = h(`<button type="button" role="radio" class="st-style" data-s="${id}">${icon(d)}${esc(text)}</button>`);
    b.onclick = () => change("Studio style", () => { state.style = id; });
    styleBox.append(b);
  }
  styleBox.addEventListener("keydown", (e) => {
    const i = STYLES.findIndex((s) => s[0] === state.style);
    const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    state.style = STYLES[(i + d + STYLES.length) % STYLES.length][0];
    sync();
    styleBox.querySelector(`[data-s="${state.style}"]`).focus();
  });
  const prev = el.querySelector(".st-preview"), cv = prev.querySelector("canvas"), stateBox = el.querySelector(".st-state");
  el.querySelector(".sw-names").onchange = (e) => change("Studio labels", () => { state.names = e.target.checked; });
  el.querySelector(".sw-hex").onchange = (e) => change("Studio hex values", () => { state.hex = e.target.checked; });
  const opts = () => ({ style: state.style, names: state.names, hex: state.hex });
  // each change is one undo step of the tool; undo and redo come back through setStudioOpts
  function change(label, fn) {
    const before = opts();
    fn();
    const after = opts();
    sync();
    if (JSON.stringify(before) !== JSON.stringify(after)) p.record?.(label, () => setStudioOpts(before), () => setStudioOpts(after));
  }
  live = (o) => {
    Object.assign(state, { style: o.style, names: o.names, hex: o.hex });
    el.querySelector(".sw-names").checked = o.names; el.querySelector(".sw-hex").checked = o.hex;
    sync();
  };
  const layer = openLayer(el, { center: true, width: matchMedia("(max-width: 1199px)").matches ? 720 : 760, anchor: p.anchor, onClose: () => { closed = true; live = null; document.removeEventListener("keydown", onEnter); p.onClose?.(); } });
  el.querySelector(".st-x").onclick = () => layer.close();
  // initial focus = the primary action (Download), never the close X; it is queued after openLayer's own focus
  if (!matchMedia("(pointer: coarse)").matches) setTimeout(() => el.querySelector(".st-dl")?.focus({ preventScroll: true }), 0);
  let closed = false, raf = 0, timer = 0;
  // Enter = the primary action (Download), unless focus is in a text field or on another control
  function onEnter(e) {
    if (e.key !== "Enter" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !el.isConnected) return;
    if (topLayer()?.el !== el) return;
    const t = e.target;
    if (t.closest?.("input[type=text], input:not([type]), textarea, select, [contenteditable], button, a, [role=tab], [role=radio]") && !t.closest?.(".st-dl")) return;
    const b = el.querySelector(".st-dl");
    if (!b) return;
    e.preventDefault(); b.click();
  }
  document.addEventListener("keydown", onEnter);

  function drawPreview() {
    raf = 0;
    const [W, H] = size(state.style);
    const boxW = phone ? el.clientWidth - 32 : (matchMedia("(max-width: 1199px)").matches ? 380 : 420), boxH = phone ? 180 : 300;
    const s = Math.min(boxW / W, boxH / H);
    const cssW = Math.round(W * s), cssH = Math.round(H * s);
    prev.style.width = boxW + "px"; prev.style.height = boxH + "px";
    const k = (devicePixelRatio || 1) * (parseFloat(getComputedStyle(document.documentElement).zoom) || 1);
    cv.style.width = cssW + "px"; cv.style.height = cssH + "px";
    cv.width = Math.round(cssW * k); cv.height = Math.round(cssH * k);
    const ctx = cv.getContext("2d");
    ctx.scale(cv.width / W, cv.height / H);
    drawPalette(ctx, W, H, state.style, state, colors, p.source, state.name);
  }
  async function renderBlob() {
    const id = ++state.rendering;
    const [W, H] = size(state.style);
    const t0 = performance.now();
    await document.fonts.ready;
    const oc = new OffscreenCanvas(W, H);
    drawPalette(oc.getContext("2d"), W, H, state.style, state, colors, p.source, state.name);
    const blob = await oc.convertToBlob({ type: "image/png" });
    if (id !== state.rendering || closed) return;
    state.blob = blob; state.ms = performance.now() - t0;
    renderState();
    state.waiter?.();
  }
  function sync() {
    remember();
    styleBox.querySelectorAll("button").forEach((b) => { const on = b.dataset.s === state.style; b.setAttribute("aria-checked", on); b.tabIndex = on ? 0 : -1; });
    state.blob = null;
    state.phase = state.phase === "busy" ? "busy" : "idle";
    if (state.phase === "done") state.phase = "idle";
    if (!raf) raf = requestAnimationFrame(drawPreview);
    clearTimeout(timer);
    timer = setTimeout(renderBlob, 120);
    renderState();
  }
  function renderState() {
    const hadDl = el.contains(document.activeElement) && !!document.activeElement.closest?.(".st-dl");
    renderStateInner();
    if (hadDl) el.querySelector(".st-dl")?.focus({ preventScroll: true });
  }
  function renderStateInner() {
    const [W, H] = size(state.style);
    const dl = icon("download"), cp = icon("copy");
    if (state.phase === "busy") {
      stateBox.innerHTML = `<div class="progress ${state.progress ? "" : "indeterminate"}" role="progressbar" aria-label="Rendering PNG"><span style="width:${state.progress || 30}%"></span></div>
        <div class="row-between"><span>Rendering PNG</span><span class="mono" style="color:var(--tx-1)">under 1 s</span></div>
        <button class="btn-2 big st-cancel" type="button">Cancel</button>`;
      stateBox.querySelector(".st-cancel").onclick = () => { state.phase = "idle"; state.cancelled = true; renderState(); };
    } else if (state.phase === "done") {
      stateBox.innerHTML = `<div class="done-row"><span class="ok">${icon("check", 16, { stroke: 2 })}</span><span class="t"><b>Saved · ${esc(fmtBytes(state.saved.size))} · ${state.saved.secs} s</b><span class="mono small">${esc(state.name)}_palette.png</span></span></div>
        <button class="btn-2 big st-dl" type="button">${dl}Download again<span class="kbd desk-only">↵</span></button>`;
      stateBox.querySelector(".st-dl").onclick = download;
    } else {
      stateBox.innerHTML = `<div class="row-between">Image<span class="v">${W} × ${H} · ${state.blob ? "≈ " + esc(fmtBytes(state.blob.size)) : "…"}</span></div>
        <button class="btn-p big st-dl" type="button">${dl}Download PNG<span class="kbd desk-only">↵</span></button>
        <button class="btn-2 big st-cp" type="button">${cp}Copy image</button>`;
      stateBox.querySelector(".st-dl").onclick = download;
      stateBox.querySelector(".st-cp").onclick = async () => {
        const b = await ready();
        if (!b || closed) return;
        const ok = await copyImage(b);
        toast(ok ? "Image copied" : "Couldn't copy the image here. Use Download PNG.", { bad: !ok });
      };
    }
  }
  const ready = () => state.blob ? Promise.resolve(state.blob) : new Promise((res) => { state.waiter = () => res(state.blob); });
  async function download() {
    const t0 = performance.now();
    state.phase = "busy"; state.cancelled = false; state.progress = 0;
    renderState();
    const blob = await ready();
    if (state.cancelled || closed || !blob) return;
    const res = await saveFile(blob, `${state.name}_palette.png`, { types: [{ description: "PNG image", accept: { "image/png": [".png"] } }] });
    if (state.cancelled || closed) return;
    if (!res.saved) { state.phase = "idle"; renderState(); return; }
    const secs = Math.max(0.1, (performance.now() - t0) / 1000).toFixed(1), file = `${state.name}_palette.png`;
    state.saved = { size: blob.size, secs };
    state.phase = "idle";
    layer.close(); // the finished state is the corner card, not the dialog
    doneCard({ title: `Saved · ${fmtBytes(blob.size)} · ${secs} s`, file, actions: [{ label: "Download again", icon: "download", run: () => saveFile(blob, file, { types: [{ description: "PNG image", accept: { "image/png": [".png"] } }] }) }] });
  }
  sync();
  document.fonts.ready.then(() => { if (!closed && !raf) raf = requestAnimationFrame(drawPreview); });
  return layer;
}
