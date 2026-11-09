// QuickCut dockable panels (like Roblox Studio / VS Code panels). One panel per call:
//
//   import { createDock } from "../shared/dock.js";
//   const panel = createDock({
//     id: "video.piece",                 // remembered under localStorage "quickcut.dock.video.piece"
//     root,                               // the workspace: position:relative; floating panels and
//                                         // the drop targets live in it
//     slots: [                            // places the panel can dock into (the host's own flex
//       { id: "right", label: "Right", container: rowEl, at: "end", hint: () => root, edge: "right", ws: true },
//       { id: "above-tl", label: "Above the timeline", container: colEl, before: () => tlRow, hint: () => tlRow, edge: "top" },
//       …                                 //   containers: a flex row (panel sized by width) or a
//     ],                                  //   flex column (sized by height), see `dir`)
//     defaults: { slot: "right", size: 264, collapsed: false, float: { x: 40, y: 40, w: 280, h: 340 } },
//     limits: { w: [220, 480], h: [120, 360] },
//     title: "Panel", icon: "<svg…>",
//     onChange: (state) => {},            // after every dock / float / resize / collapse
//     onReset: () => {},                  // "Reset layout" in the menu (reset the tool's other panels)
//   });
//   panel.body                            // fill this with the panel's content
//   panel.setTitle("Piece 2", "0:04.2")   // header text
//   panel.openSheet()                     // phones: the body in a bottom sheet (no docking < 600 px)
//   panel.reset()                         // default layout
//
// A slot: {id, label, container, dir: "row" | "column" (default: the container's flex-direction;
// give it when the host's CSS may not be loaded yet),
// at: "start" | "end" (default "end") or before: () => element, hint: () => element whose edge
// shows the drop target, edge: "left" | "right" | "top" | "bottom", ws: true for the workspace
// sides (their targets form the compass in the middle), split: the panel side with the splitter
// (default: the side facing the content), enabled: () => bool (e.g. "above the timeline" only
// while the timeline is docked)}.
// More options: slim (a thin header, e.g. for a timeline), phoneSlot (phones: always docked
// there, no header, instead of a bottom sheet), minFloat {w, h}.
// Dragging the header shows the targets and a translucent preview of where the panel lands; drop
// outside any target = floating; Esc cancels. Floating panels move, resize from edges and corners,
// snap to the workspace edges and to other panels, and stay reachable (clamped on resize and on
// interface zoom). Docked panels have a splitter. Moves use transforms, batched per frame.
import { icon, h, isPhone, openLayer, closeLayer } from "./ui.js";

const CSS_ID = "dk-css";
const KEY = (id) => `quickcut.dock.${id}`;
const SNAP = 10;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const load = (id) => { try { return JSON.parse(localStorage.getItem(KEY(id)) || "null"); } catch { return null; } };
const save = (id, st) => { try { localStorage.setItem(KEY(id), JSON.stringify(st)); } catch {} };
const I_FLOAT = "M3 5.5h7.5v7.5H3zM6 3h7v7";
const I_DOCK = "M2.5 3h11v10h-11zM9.5 3v10";
const I_MORE = "M3.5 8h.01M8 8h.01M12.5 8h.01";
const all = new Set(); // every panel (snapping to other floating panels)

export function createDock(o) {
  if (!document.getElementById(CSS_ID)) {
    const l = document.createElement("link");
    l.id = CSS_ID; l.rel = "stylesheet"; l.href = new URL("./dock.css", import.meta.url).href;
    l.onload = () => { for (const p of all) p.relayout?.(); };
    document.head.append(l);
  }
  const { id, root, slots, limits = { w: [200, 520], h: [110, 420] } } = o;
  const defaults = { slot: slots[0]?.id || null, size: 264, collapsed: false, float: { x: 24, y: 24, w: 280, h: 320 }, ...o.defaults };
  const fresh = () => ({ slot: defaults.slot, last: defaults.slot, size: {}, collapsed: defaults.collapsed, float: { ...defaults.float } });
  let st = { ...fresh(), ...(load(id) || {}) };
  if (st.slot && !slots.some((s) => s.id === st.slot)) st.slot = defaults.slot;
  if (!slots.some((s) => s.id === st.last)) st.last = defaults.slot;

  const el = h(`<section class="dk-panel float" aria-label="${o.title || "Panel"}">
    <div class="dk-head" tabindex="0" role="group" aria-roledescription="Panel header">
      <span class="dk-ico">${o.icon || ""}</span><span class="dk-title"></span><span class="dk-sub"></span>
      <span class="dk-btns">
        <button class="ib sm dk-b-more" type="button" aria-label="Options" title="Options">${icon(I_MORE, 14)}</button>
        <button class="ib sm dk-b-float" type="button"></button>
        <button class="ib sm dk-b-col" type="button"></button>
      </span>
    </div>
    <div class="dk-body"></div>
    <span class="dk-split" aria-hidden="true"></span>
    ${["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((d) => `<span class="dk-rz" data-d="${d}" aria-hidden="true"></span>`).join("")}
  </section>`);
  const head = el.querySelector(".dk-head"), body = el.querySelector(".dk-body");
  const titleEl = el.querySelector(".dk-title"), subEl = el.querySelector(".dk-sub");
  const bFloat = el.querySelector(".dk-b-float"), bCol = el.querySelector(".dk-b-col"), bMore = el.querySelector(".dk-b-more");
  titleEl.textContent = o.title || "";
  const me = { el, body };
  all.add(me);

  // defaults.size: a number (width when docked in a row; 60 % of it as a height) or {row, column}
  const defSize = (dir) => (typeof defaults.size === "object" ? defaults.size[dir] : dir === "row" ? defaults.size : Math.round(defaults.size * 0.6));
  const slotOf = (sid) => slots.find((s) => s.id === sid && (!s.enabled || s.enabled())) || null;
  const splitOf = (s) => s.split || ({ left: "right", right: "left", top: "bottom", bottom: "top" })[s.edge];
  if (o.slim) el.classList.add("dk-slim");
  const dirOf = (s) => s.dir || (getComputedStyle(s.container).flexDirection.startsWith("column") ? "column" : "row");
  const zoomOf = () => { const r = root.getBoundingClientRect(); return root.offsetWidth ? r.width / root.offsetWidth : 1; };
  const notify = () => { save(id, st); o.onChange?.({ ...st }); };

  // ── layout ──
  let raf = 0;
  function apply() {
    const phone = isPhone();
    const ps = phone && o.phoneSlot ? slots.find((x) => x.id === o.phoneSlot) : null;
    el.classList.toggle("dk-phone", phone && !ps);
    el.classList.toggle("dk-phone-docked", !!ps);
    if (phone && !ps) { if (el.parentNode !== root) root.append(el); return; }
    const s = ps || (st.slot ? slotOf(st.slot) || slotOf(defaults.slot) : null);
    el.classList.toggle("floating", !s);
    el.classList.toggle("collapsed", !!st.collapsed);
    el.style.transform = ""; el.style.width = ""; el.style.height = ""; el.style.flexBasis = "";
    if (s) {
      const dir = dirOf(s);
      el.dataset.dir = dir; el.dataset.at = s.before ? "before" : s.at || "end";
      el.dataset.edge = s.edge || ""; el.dataset.split = splitOf(s) || "";
      el.classList.toggle("dk-wide", dir === "column");
      let ref = s.before ? s.before() : s.at === "start" ? s.container.firstElementChild : null;
      if (ref === el) ref = null;
      if (s.at === "start" && !s.before) { if (el.parentNode !== s.container || el !== s.container.firstElementChild) s.container.insertBefore(el, s.container.firstElementChild); }
      else if (ref && ref.parentNode === s.container) { if (el.nextElementSibling !== ref) s.container.insertBefore(el, ref); }
      else if (el.parentNode !== s.container || el !== s.container.lastElementChild) s.container.append(el);
      const lim = dir === "row" ? limits.w : limits.h;
      const size = clamp(st.size[dir] || defSize(dir), lim[0], lim[1]);
      if (!st.collapsed) el.style.flexBasis = `${size}px`;
    } else {
      el.dataset.dir = ""; el.dataset.edge = ""; el.dataset.split = "";
      el.classList.remove("dk-wide");
      if (el.parentNode !== root) root.append(el);
      clampFloat();
      const f = st.float;
      el.style.width = `${f.w}px`;
      if (!st.collapsed) el.style.height = `${f.h}px`;
      el.style.transform = `translate(${f.x}px, ${f.y}px)`;
    }
    bFloat.innerHTML = icon(s ? I_FLOAT : I_DOCK, 14);
    const fl = s ? "Float" : "Dock";
    bFloat.setAttribute("aria-label", fl); bFloat.title = fl;
    bCol.innerHTML = icon("chev", 14);
    const cl = st.collapsed ? "Expand" : "Collapse";
    bCol.setAttribute("aria-label", cl); bCol.title = cl;
    bCol.setAttribute("aria-expanded", String(!st.collapsed));
  }
  /** Keep a floating panel inside the workspace (its header at least reachable). */
  function clampFloat() {
    const W = root.clientWidth, H = root.clientHeight;
    if (!W || !H) return;
    const f = st.float, mw = o.minFloat?.w || limits.w[0], mh = o.minFloat?.h || limits.h[0];
    f.w = clamp(f.w, mw, Math.max(mw, Math.min(o.maxFloat?.w || limits.w[1], W)));
    f.h = clamp(f.h, mh, Math.max(mh, H));
    f.x = clamp(f.x, 0, Math.max(0, W - f.w));
    f.y = clamp(f.y, 0, Math.max(0, H - 40));
  }
  const relayout = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { raf = 0; apply(); }); };
  addEventListener("resize", relayout);
  addEventListener("quickcut:zoom", relayout);
  new ResizeObserver(() => { if (!st.slot) relayout(); }).observe(root);

  function dockTo(sid) { st.slot = sid; st.last = sid; apply(); notify(); }
  function floatAt(f) { if (st.slot) st.last = st.slot; st.slot = null; if (f) st.float = { ...st.float, ...f }; apply(); notify(); }
  function toggleFloat() {
    if (st.slot) {
      // float where it is now (same size), slightly inset
      const r = rel(el.getBoundingClientRect());
      floatAt({ x: r.x + 8, y: r.y + 8, w: clamp(r.w, o.minFloat?.w || limits.w[0], o.maxFloat?.w || limits.w[1]), h: clamp(st.collapsed ? st.float.h : r.h, o.minFloat?.h || limits.h[0], limits.h[1] * 1.5) });
    } else dockTo(st.last || defaults.slot);
  }
  function collapse(v = !st.collapsed) { st.collapsed = v; apply(); notify(); }
  function reset() { st = fresh(); apply(); notify(); }
  /** A client rect → CSS px relative to the root (CSS zoom aware). */
  function rel(r) { const R = root.getBoundingClientRect(), z = zoomOf(); return { x: (r.left - R.left) / z, y: (r.top - R.top) / z, w: r.width / z, h: r.height / z }; }

  bCol.onclick = () => collapse();
  bFloat.onclick = () => toggleFloat();
  bMore.onclick = () => {
    const m = h(`<div class="dk-menu" role="menu">
      ${slots.filter((s) => !s.enabled || s.enabled()).map((s) => `<button type="button" role="menuitemradio" aria-checked="${st.slot === s.id}" data-s="${s.id}">${s.label}</button>`).join("")}
      <button type="button" role="menuitemradio" aria-checked="${!st.slot}" data-s="">Floating</button>
      <span class="dk-mline"></span>
      <button type="button" role="menuitem" data-r="1">Reset layout</button></div>`);
    const lay = openLayer(m, { anchor: bMore, width: 240, reopen: false });
    m.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      closeLayer(lay, { remember: false });
      if (b.dataset.r) { reset(); o.onReset?.(); } else if (b.dataset.s) dockTo(b.dataset.s); else floatAt();
      head.focus({ preventScroll: true });
    };
  };
  head.addEventListener("dblclick", (e) => { if (!e.target.closest("button")) toggleFloat(); });
  head.addEventListener("keydown", (e) => {
    if (e.target !== head) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); collapse(); }
    else if (e.key === "F" || e.key === "f") { e.preventDefault(); toggleFloat(); }
  });

  // ── drag the header: float, and dock where it is dropped ──
  let drag = null;
  head.addEventListener("pointerdown", (e) => {
    if (e.button > 0 || e.target.closest("button") || isPhone()) return;
    const r = el.getBoundingClientRect();
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, on: false, before: { ...st, float: { ...st.float }, size: { ...st.size } }, w: r.width, h: r.height };
    // window listeners, not pointer capture: the panel moves to another parent when it floats,
    // and a moved element loses its capture
    addEventListener("pointermove", onMove, true);
    addEventListener("pointerup", endDrag, true);
    addEventListener("pointercancel", endDrag, true);
  });
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
      startDrag();
    }
    e.preventDefault();
    drag.cx = e.clientX; drag.cy = e.clientY;
    if (!drag.raf) drag.raf = requestAnimationFrame(moveDrag);
  };
  const unlisten = () => { removeEventListener("pointermove", onMove, true); removeEventListener("pointerup", endDrag, true); removeEventListener("pointercancel", endDrag, true); };
  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    unlisten();
    const d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    if (!d.on) return;
    finishDrag(d, e?.type === "pointercancel");
  };
  const onKey = (e) => { if (drag?.on && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); const d = drag; drag = null; cancelAnimationFrame(d.raf); unlisten(); finishDrag(d, true); } };
  addEventListener("keydown", onKey, true);

  let overlay = null, preview = null, targets = [];
  function startDrag() {
    const d = drag;
    d.on = true;
    // float at the pointer with the floating size (a docked panel keeps its width)
    const z = zoomOf();
    const fw = st.slot ? clamp(d.w / z, o.minFloat?.w || limits.w[0], o.maxFloat?.w || limits.w[1]) : st.float.w;
    const fh = st.float.h;
    if (st.slot) st.last = st.slot;
    st.slot = null;
    st.float.w = fw; st.float.h = fh;
    d.dx = Math.min(d.dx, fw * z - 40);
    apply();
    el.classList.add("dragging");
    // drop targets: the compass (workspace sides) in the middle, edge targets on their elements
    const R = root.getBoundingClientRect();
    overlay = h(`<div class="dk-overlay"><div class="dk-preview"></div></div>`);
    preview = overlay.firstChild;
    root.append(overlay);
    targets = [];
    const cx = R.left + R.width / 2, cy = R.top + R.height / 2, gap = 46 * z;
    const at = { left: [-gap, 0], right: [gap, 0], top: [0, -gap], bottom: [0, gap] };
    const center = h(`<button type="button" class="dk-t dk-t-c" tabindex="-1" aria-label="Floating"><i></i></button>`);
    overlay.append(center);
    targets.push({ el: center, x: cx, y: cy, slot: null });
    for (const s of slots) {
      if (s.enabled && !s.enabled()) continue;
      const b = h(`<button type="button" class="dk-t" data-edge="${s.edge}" tabindex="-1" aria-label="${s.label}"><i></i></button>`);
      let x, y;
      if (s.ws) [x, y] = [cx + at[s.edge][0], cy + at[s.edge][1]];
      else {
        const hr = s.hint().getBoundingClientRect();
        const mx = hr.left + hr.width / 2, my = hr.top + hr.height / 2;
        const inset = 26 * z;
        [x, y] = s.edge === "left" ? [hr.left + inset, my] : s.edge === "right" ? [hr.right - inset, my] : s.edge === "top" ? [mx + (s.shift || 0) * z, hr.top + inset] : [mx + (s.shift || 0) * z, hr.bottom - inset];
      }
      overlay.append(b);
      targets.push({ el: b, x, y, slot: s });
    }
    for (const t of targets) {
      t.el.style.transform = `translate(${(t.x - R.left) / z - 18}px, ${(t.y - R.top) / z - 18}px)`;
      t.el.title = t.el.getAttribute("aria-label");
    }
    // other floating panels and the workspace edges, for snapping
    d.snapX = [0, root.clientWidth]; d.snapY = [0, root.clientHeight];
    for (const p of all) if (p !== me && p.el.classList.contains("floating") && p.el.isConnected) { const q = rel(p.el.getBoundingClientRect()); d.snapX.push(q.x, q.x + q.w); d.snapY.push(q.y, q.y + q.h); }
    requestAnimationFrame(() => overlay?.classList.add("in"));
  }
  function moveDrag() {
    const d = drag;
    if (!d) return;
    d.raf = 0;
    const R = root.getBoundingClientRect(), z = zoomOf();
    const f = st.float;
    let x = (d.cx - d.dx - R.left) / z, y = (d.cy - d.dy - R.top) / z;
    // snap the panel's edges to the workspace edges and to other floating panels
    let bx = SNAP, by = SNAP, sx = x, sy = y;
    for (const v of d.snapX) { if (Math.abs(v - x) < bx) { bx = Math.abs(v - x); sx = v; } if (Math.abs(v - (x + f.w)) < bx) { bx = Math.abs(v - (x + f.w)); sx = v - f.w; } }
    for (const v of d.snapY) { if (Math.abs(v - y) < by) { by = Math.abs(v - y); sy = v; } if (Math.abs(v - (y + f.h)) < by) { by = Math.abs(v - (y + f.h)); sy = v - f.h; } }
    f.x = sx; f.y = sy;
    clampFloat();
    el.style.transform = `translate(${f.x}px, ${f.y}px)`;
    // the target under the pointer (36 px buttons, a little slack)
    let hit = null;
    for (const t of targets) if (Math.abs(d.cx - t.x) <= 22 * z && Math.abs(d.cy - t.y) <= 22 * z) hit = t;
    for (const t of targets) t.el.classList.toggle("on", t === hit);
    d.hit = hit;
    if (hit?.slot) {
      const p = landing(hit.slot);
      preview.style.transform = `translate(${p.x}px, ${p.y}px)`;
      preview.style.width = `${p.w}px`; preview.style.height = `${p.h}px`;
      preview.classList.add("on");
    } else preview.classList.remove("on");
  }
  /** Where a slot puts the panel (CSS px in the root), for the preview. */
  function landing(s) {
    const dir = dirOf(s), lim = dir === "row" ? limits.w : limits.h;
    const size = clamp(st.size[dir] || defSize(dir), lim[0], lim[1]);
    const r = rel((s.ws ? s.container : s.hint()).getBoundingClientRect());
    const e = s.edge;
    if (dir === "row") return { x: e === "left" ? r.x : r.x + r.w - size, y: r.y, w: size, h: r.h };
    return { x: r.x, y: e === "top" ? (s.ws ? r.y : r.y - size) : (s.ws ? r.y + r.h - size : r.y + r.h - size), w: r.w, h: size };
  }
  /** A floating panel never covers another floating panel: move it the shortest way out. */
  function unOverlap() {
    const f = st.float;
    for (const p of all) {
      if (p === me || !p.el.classList.contains("floating") || !p.el.isConnected) continue;
      const q = rel(p.el.getBoundingClientRect());
      if (f.x >= q.x + q.w || f.x + f.w <= q.x || f.y >= q.y + q.h || f.y + f.h <= q.y) continue;
      const opts = [{ x: q.x - f.w, y: f.y }, { x: q.x + q.w, y: f.y }, { x: f.x, y: q.y - f.h }, { x: f.x, y: q.y + q.h }]
        .filter((c) => c.x >= 0 && c.y >= 0 && c.x + f.w <= root.clientWidth && c.y + 40 <= root.clientHeight);
      const best = opts.sort((a, b) => Math.hypot(a.x - f.x, a.y - f.y) - Math.hypot(b.x - f.x, b.y - f.y))[0];
      if (best) { f.x = best.x; f.y = best.y; }
    }
  }
  function finishDrag(d, cancel) {
    overlay?.remove(); overlay = preview = null; targets = [];
    el.classList.remove("dragging");
    if (cancel) { st = d.before; apply(); return; }
    if (d.hit?.slot) dockTo(d.hit.slot.id);
    else { unOverlap(); apply(); notify(); }
    head.focus({ preventScroll: true });
  }

  // ── splitter (docked) and edges / corners (floating) ──
  el.addEventListener("pointerdown", (e) => {
    const sp = e.target.closest(".dk-split"), rz = e.target.closest(".dk-rz");
    if ((!sp && !rz) || e.button > 0) return;
    e.preventDefault(); e.stopPropagation();
    const t = e.target;
    try { t.setPointerCapture(e.pointerId); } catch {}
    const z = zoomOf(), x0 = e.clientX, y0 = e.clientY;
    const s = st.slot && slotOf(st.slot), dir = s ? dirOf(s) : null;
    const r0 = el.getBoundingClientRect(), f0 = { ...st.float };
    const size0 = dir === "row" ? r0.width / z : r0.height / z;
    let q = 0, cx = x0, cy = y0;
    el.classList.add("sizing");
    const step = () => {
      q = 0;
      const dx = (cx - x0) / z, dy = (cy - y0) / z;
      if (sp && s) {
        // the splitter is on the side facing the content: dragging away from the edge grows it
        const sign = splitOf(s) === "right" || splitOf(s) === "bottom" ? 1 : -1;
        const lim = dir === "row" ? limits.w : limits.h;
        st.size[dir] = Math.round(clamp(size0 + sign * (dir === "row" ? dx : dy), lim[0], lim[1]));
        el.style.flexBasis = `${st.size[dir]}px`;
      } else if (rz) {
        const dd = rz.dataset.d, f = st.float;
        let { x, y, w, h: hh } = f0;
        if (dd.includes("e")) w = f0.w + dx;
        if (dd.includes("s")) hh = f0.h + dy;
        if (dd.includes("w")) { w = f0.w - dx; x = f0.x + dx; }
        if (dd.includes("n")) { hh = f0.h - dy; y = f0.y + dy; }
        const W = clamp(w, o.minFloat?.w || limits.w[0], o.maxFloat?.w || limits.w[1]), Hh = clamp(hh, o.minFloat?.h || limits.h[0], root.clientHeight);
        if (dd.includes("w")) x += w - W;
        if (dd.includes("n")) y += hh - Hh;
        // snap the moved edges to the workspace edges
        Object.assign(f, { x, y, w: W, h: Hh });
        if (Math.abs(f.x + f.w - root.clientWidth) < SNAP && dd.includes("e")) f.w = root.clientWidth - f.x;
        if (Math.abs(f.y + f.h - root.clientHeight) < SNAP && dd.includes("s")) f.h = root.clientHeight - f.y;
        if (f.x < SNAP && dd.includes("w")) { f.w += f.x; f.x = 0; }
        if (f.y < SNAP && dd.includes("n")) { f.h += f.y; f.y = 0; }
        el.style.width = `${f.w}px`; el.style.height = `${f.h}px`;
        el.style.transform = `translate(${f.x}px, ${f.y}px)`;
      }
    };
    const mv = (ev) => { cx = ev.clientX; cy = ev.clientY; if (!q) q = requestAnimationFrame(step); };
    const up = () => { cancelAnimationFrame(q); step(); el.classList.remove("sizing"); t.removeEventListener("pointermove", mv); t.removeEventListener("pointerup", up); t.removeEventListener("pointercancel", up); notify(); };
    t.addEventListener("pointermove", mv);
    t.addEventListener("pointerup", up);
    t.addEventListener("pointercancel", up);
  });

  // ── phones: no docking, a bottom sheet ──
  let sheet = null;
  function openSheet() {
    if (sheet) return sheet;
    const s = h(`<section class="dk-sheet" aria-label="${o.title || "Panel"}"><div class="pop-head"><span class="pop-title"></span><button class="ib dk-x" type="button" aria-label="Close">${icon("x")}</button></div></section>`);
    s.querySelector(".pop-title").textContent = [titleEl.textContent, subEl.textContent].filter(Boolean).join(" · ");
    s.append(body);
    const lay = openLayer(s, { sheet: true, onClose: () => { el.insertBefore(body, el.querySelector(".dk-split")); sheet = null; o.onSheet?.(false); } });
    s.querySelector(".dk-x").onclick = () => closeLayer(lay);
    sheet = { lay, el: s };
    o.onSheet?.(true);
    return sheet;
  }

  apply();
  return Object.assign(me, {
    setTitle(t, sub = "") { titleEl.textContent = t; subEl.textContent = sub; if (sheet) sheet.el.querySelector(".pop-title").textContent = [t, sub].filter(Boolean).join(" · "); },
    dockTo, float: floatAt, collapse, reset, openSheet,
    closeSheet() { if (sheet) closeLayer(sheet.lay); },
    state: () => ({ ...st, float: { ...st.float }, size: { ...st.size } }),
    get collapsed() { return !!st.collapsed; },
    get sheetOpen() { return !!sheet; },
    relayout: apply,
    destroy() { removeEventListener("keydown", onKey, true); removeEventListener("resize", relayout); all.delete(me); el.remove(); },
  });
}
