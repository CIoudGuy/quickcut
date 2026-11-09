// QuickCut Video: cut a video into pieces, trim, reorder, crop/rotate and export.
//
// Speed first:
// - Preview is two native <video> elements on one object URL (hardware decode). Scrubbing keeps
//   one seek in flight and lands on the exact frame on release. Playback plays each piece's
//   source range in order; the second element waits, already seeked, at the next piece's start,
//   so the switch is a swap.
// - The file is probed, its key frames decoded into small thumbnails and its audio turned into
//   waveform peaks in a worker (worker.js + qc-wasm), progressively; nothing waits on them.
// - The timeline is one canvas, redrawn only when something changed (one rAF per change).
// - Exports run in their own worker: Instant (lossless, FilmCraft's cutter in wasm) or Exact
//   (WebCodecs re-encode).
import {
  icon, h, $, esc, isPhone, isTouch, fmtBytes, fmtTime, baseName, openLayer, closeLayer, topLayer, toast,
  pickFiles, intake, recents, renderRecents, thumbOf, download, mod, session, renderResume, syncSlider, resetSlider, makeMovable, groupBar, doneCard, fmtAgo,
  recentId,
} from "../shared/ui.js";
import * as qcut from "../shared/qcut.js";
import { createDock } from "../shared/dock.js";
import { createKeys } from "../shared/keys.js";
import { FORMATS, fmtById, EXT, MIME, QUALITIES, bitrateFor, encoderConfig, isTenBit } from "./codecs.js";
import { jobs, runExact } from "./job.js";
import { FIT_PRESETS, MARGIN, AUTO_ORDER, planFit, audioChoice, audioWant, bpsFor, equiv } from "./fit.js";

const CSS_ID = "qv-css";
const VIDEO_TYPES = [{ description: "Videos", accept: { "video/*": [".mp4", ".mov", ".m4v", ".webm", ".mkv"] } }];
const OPEN_TYPES = [{ description: "Videos", accept: { ...VIDEO_TYPES[0].accept, [qcut.MIME]: [qcut.EXT] } }];
const isVideo = (f) => /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name);
// a project (.qcut, recognised by its first bytes): any file that isn't plainly a video or an image
const maybeProject = (f) => !isVideo(f) && !/^(image|audio|text)\//.test(f.type);
const previewOf = (b) => (b && /^image\/(webp|jpeg|png|avif)$/.test(b.type) ? b : null);
const qErr = (e) => (e?.code === "newer" ? "Needs a newer QuickCut" : "Can't open project");
const num = (v) => typeof v === "number" && Number.isFinite(v);
const WORKER_URL = new URL("./worker.js", import.meta.url);
const ASPECTS = ["Free", "1:1", "4:5", "16:9", "9:16", "Original"];
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];
// Speed range of a piece. Above MUTE_ABOVE the export has no sound for that piece (a time stretch
// that fast is only noise) and the panel says so. Very fast pieces export only some source frames
// (one per output frame, key frames where they fall in the frame's slot: see worker.js).
const MIN_SPEED = 0.1, MAX_SPEED = 100, MUTE_ABOVE = 16;
// a speedometer (the piece panel)
const SPEED_ICON = "M2.5 11.5a5.5 5.5 0 1 1 11 0M8 11.5l2.8-3.3M4.6 8.2l.9.6M8 6v1M11.4 8.2l-.9.6";
const MAGNET = "M3.5 2.5h3v5.5a1.5 1.5 0 0 0 3 0V2.5h3V8a4.5 4.5 0 0 1-9 0zM3.5 5.5h3M9.5 5.5h3";
/** "1.37", "137%", "2x", "2×" → speed, clamped to 0.1–100; null when unreadable. */
function parseSpeed(v) {
  let t = String(v).trim().toLowerCase().replace(",", ".");
  const pct = t.endsWith("%");
  t = t.replace(/[%x×\s]/g, "");
  if (!/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(t)) return null;
  let n = parseFloat(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (pct) n /= 100;
  return Math.max(MIN_SPEED, Math.min(MAX_SPEED, Math.round(n * 100) / 100));
}
const fmtSpeed = (v) => `${+(+v).toFixed(2)}`;
// <video> plays 0.0625×–16× (Chrome); faster previews step through key frames instead (see play)
const vrate = (x) => Math.max(0.0625, Math.min(16, x));
// ── keyboard shortcuts: the one table ─────────────────────────────────────────
// [action, key combos, group, what it does]. The keydown handler, the tooltips and the ? sheet all read
// the registry built from this table (shared/keys.js: the user's own keys live there). Conventions follow
// Premiere / Resolve / CapCut where they agree: Space, J K L, ←/→ frames, Shift ←/→ 1 s, ↑/↓ cuts,
// S or Ctrl K / Ctrl B split, Del / Shift Del ripple delete, Ctrl Z / Ctrl Shift Z / Ctrl Y,
// + / − zoom, Shift Z or \ fit. Combos: "Ctrl+Shift+Z" (Ctrl = Cmd on a Mac).
const SHORTCUTS = [
  ["play", ["Space"], "Playback", "Play / pause"],
  ["shuttleBack", ["J"], "Playback", "Reverse"],
  ["stop", ["K"], "Playback", "Pause"],
  ["shuttleFwd", ["L"], "Playback", "Forward"],
  ["prevFrame", ["Left"], "Playback", "Previous frame"],
  ["nextFrame", ["Right"], "Playback", "Next frame"],
  ["back1s", ["Shift+Left"], "Playback", "Back 1 s"],
  ["fwd1s", ["Shift+Right"], "Playback", "Forward 1 s"],
  ["prevCut", ["Up"], "Playback", "Previous cut"],
  ["nextCut", ["Down"], "Playback", "Next cut"],
  ["home", ["Home"], "Playback", "Start"],
  ["end", ["End"], "Playback", "End"],
  ["loop", ["Shift+L"], "Playback", "Loop"],
  ["mute", ["M"], "Playback", "Mute"],
  ["slower", ["["], "Playback", "Slower"],
  ["faster", ["]"], "Playback", "Faster"],
  ["split", ["S", "Ctrl+K", "Ctrl+B"], "Edit", "Split"],
  ["delete", ["Delete", "Backspace", "Shift+Delete"], "Edit", "Delete"],
  ["selectAll", ["Ctrl+A"], "Edit", "Select all"],
  ["deselect", ["Esc"], "Edit", "Deselect"],
  ["undo", ["Ctrl+Z"], "Edit", "Undo"],
  ["redo", ["Ctrl+Shift+Z", "Ctrl+Y"], "Edit", "Redo"],
  ["crop", ["C"], "Edit", "Crop & rotate"],
  ["export", ["Ctrl+E", "Ctrl+M"], "Edit", "Export"],
  ["open", ["Ctrl+O"], "Edit", "Open"],
  ["saveProject", ["Ctrl+S"], "Edit", "Save project"],
  ["zoomIn", ["=", "Shift+="], "View", "Zoom in"],
  ["zoomOut", ["-", "Shift+-"], "View", "Zoom out"],
  ["zoomFit", ["Shift+Z", "\\"], "View", "Fit"],
  ["snap", ["N"], "View", "Snap"],
  ["keys", ["Shift+/"], "Other", "Shortcuts"],
];
// a focused slider, button or the page itself all count as "not typing"
const typing = (t) => t && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || (t.tagName === "INPUT" && !/^(range|checkbox|radio|button|submit|reset|color|file)$/i.test(t.type)));
const K = createKeys({ id: "video", title: "Video", typing });
let ACT = {}; // what each action does; set by mount()
for (const [id, keys, group, label] of SHORTCUTS) K.add({ id, keys, group, label, typing: id === "export", run: (e) => ACT[id]?.(e) });
K.info("Click · Shift · Ctrl", "Edit", "Select");
K.info("Ctrl wheel · pinch", "View", "Zoom");
K.info("Alt", "View", "No snap");
/** The first key of an action, as shown ("Ctrl Shift Z"); "" when it has none. */
const kl = (a) => K.label(a);
const QUALITY = { Smaller: 1, Balanced: 2, Best: 3 };
const I2 = [1, 0, 0, 1];
const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]];
const ROT = [0, -1, 1, 0], FLIPH = [-1, 0, 0, 1], FLIPV = [1, 0, 0, -1];
const same = (a, b) => a.every((x, i) => x === b[i]);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
let nextId = 1;

/** "01:58.1" */
const fmtTenth = (s) => { const t = fmtTime(s); return t.slice(0, -1); };
const fmtFps = (f) => (f ? String(Math.round(f * 100) / 100) : "–");
const resLabel = (w, hgt) => { const s = Math.min(w, hgt); return s >= 4000 ? "8K" : s >= 2000 ? "4K" : `${[480, 720, 1080, 1440].reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a))}p`; };

export function mount(root) {
  if (!document.getElementById(CSS_ID)) {
    const l = document.createElement("link");
    l.id = CSS_ID; l.rel = "stylesheet"; l.href = new URL("./video.css", import.meta.url).href;
    document.head.append(l);
  }
  root.classList.add("qv");
  root.innerHTML = "";

  // ── empty state ──────────────────────────────────────────────────────────
  const empty = h(`<div class="empty">
    <div class="resume-box" hidden></div>
    <button class="drop" type="button">
      <span class="glyph">${icon("film", 22)}</span>
      <span class="title">Open a video</span>
      <span class="hint">MP4, MOV, M4V, WebM, MKV, QCUT</span>
    </button>
    <section class="recents" aria-label="Recent files" hidden><span class="label">Recent</span><div class="grid"></div></section>
    <a class="credit-phone" href="https://github.com/CIoudGuy/quickcut" target="_blank" rel="noopener">QuickCut is open source on GitHub</a>
  </div>`);
  const recentBox = $(".recents", empty), resumeBox = $(".resume-box", empty);
  const choose = async () => { const f = await pickFiles({ accept: "video/*,.mkv,.mov,.qcut", types: OPEN_TYPES }); if (f[0]) openAny(f[0].file, f[0].handle); };
  $(".drop", empty).onclick = choose;

  // ── editor ───────────────────────────────────────────────────────────────
  const ed = h(`<div class="qv-ed" hidden>
    <div class="actions">
      <button class="ib" data-a="undo" aria-label="Undo (${kl("undo")})" title="Undo (${kl("undo")})">${icon("undo")}</button>
      <button class="ib" data-a="redo" aria-label="Redo (${kl("redo")})" title="Redo (${kl("redo")})">${icon("redo")}</button>
      <span class="sep lead"></span>
      <span class="file"><span class="n"></span><span class="m"></span></span>
      <button class="btn-g qv-cropb" data-a="crop" aria-pressed="false" title="Crop &amp; rotate (${kl("crop")})">${icon("crop")}<span class="desk-only">Crop &amp; rotate</span><span class="kbd desk-only">${kl("crop")}</span></button>
      <button class="btn-g phone-only qv-pc" data-a="cropCancel" hidden>Cancel</button>
      <button class="btn-p phone-only qv-pc" data-a="cropApply" hidden>Apply</button>
      <button class="btn-p qv-exp" data-a="export" aria-haspopup="dialog" aria-expanded="false" title="Export (${kl("export")})">${icon("exp")}Export<span class="kbd desk-only">${kl("export")}</span></button>
      <button class="ib desk-only" data-a="keys" aria-label="Shortcuts" title="Shortcuts">?</button>
    </div>
    <div class="qv-workc"><div class="qv-work"><div class="qv-col">
    <section class="qv-stage" aria-label="Preview">
      <div class="qv-box"><video class="a" playsinline preload="auto"></video><video class="b off" playsinline preload="auto"></video></div>
      <span class="qv-chip" hidden>${icon("crop", 14)}<span></span></span>
      <span class="qv-busy" hidden></span>
    </section>
    <div class="qv-trans" role="toolbar" aria-label="Playback">
      <button class="ib qv-play" data-a="play" aria-label="Play (${kl("play")})" title="Play (${kl("play")})">${icon("play", 18, { fill: true })}</button>
      <button class="ib" data-a="back1" aria-label="Previous frame (${kl("prevFrame")})" title="Previous frame (${kl("prevFrame")})">${icon("stepBack")}</button>
      <button class="ib" data-a="fwd1" aria-label="Next frame (${kl("nextFrame")})" title="Next frame (${kl("nextFrame")})">${icon("stepFwd")}</button>
      <span class="qv-time">00:00.00 <span>/ 00:00.00</span></span>
      <span class="spacer"></span>
      <button class="btn-g qv-loop" data-a="loop" aria-pressed="true" aria-label="Loop (${kl("loop")})" title="Loop (${kl("loop")})">${icon("loop")}<span class="desk-only">Loop</span></button>
      <button class="ib desk-only" data-a="mute" aria-label="Mute (${kl("mute")})" title="Mute (${kl("mute")})">${icon("vol")}</button>
    </div>
    </div></div></div>
    <div class="qv-tlrow"><section class="qv-tl" aria-label="Timeline">
      <div class="qv-tlbar" role="toolbar" aria-label="Timeline actions">
        <span class="grp">
          <button class="btn-g" data-a="split" title="Split (${kl("split")})">${icon("razor")}Split<span class="kbd">${kl("split")}</span></button>
          <button class="btn-g" data-a="delete" title="Delete (${kl("delete")})">${icon("trash")}Delete<span class="kbd">${kl("delete")}</span></button>
        </span>
        <span class="grp phone-only">
          <button class="btn-g qv-svb" data-a="svSheet" aria-haspopup="dialog">${icon(SPEED_ICON, 14)}Speed &amp; vol</button>
        </span>
        <span class="grp end">
          <button class="ib qv-snap" data-a="snap" aria-pressed="true" aria-label="Snap (${kl("snap")})" title="Snap (${kl("snap")})">${icon(MAGNET)}</button>
        </span>
        <span class="grp">
          <span class="qv-zoom desk-only" style="display:inline-flex;align-items:center;gap:4px">
            <button class="ib" data-a="zout" aria-label="Zoom out (${kl("zoomOut")})" title="Zoom out (${kl("zoomOut")})">${icon("minus", 14)}</button>
            <input class="slider neutral" type="range" min="0" max="1000" value="0" data-default="0" aria-label="Timeline zoom">
            <button class="ib" data-a="zin" aria-label="Zoom in (${kl("zoomIn")})" title="Zoom in (${kl("zoomIn")})">${icon("plus", 14)}</button>
          </span>
          <button class="btn-2 qv-fit" data-a="fit" title="Fit (${kl("zoomFit")})">${icon("fit", 14)}<span class="desk-only">Fit</span></button>
        </span>
      </div>
      <div class="qv-track" data-wheel-zoom>
        <canvas></canvas>
        <span class="qv-hov" hidden></span><span class="qv-hchip" hidden></span>
        <span class="qv-ph"></span><span class="qv-pchip phone-only"></span>
      </div>
    </section></div>
  </div>`);
  root.append(empty, ed);

  const q = (s) => $(s, ed);
  groupBar(q(".qv-tlbar"));
  const stage = q(".qv-stage"), box = q(".qv-box"), V = [q("video.a"), q("video.b")];
  const chip = q(".qv-chip"), busyEl = q(".qv-busy");
  const timeEl = q(".qv-time"), playBtn = q(".qv-play"), loopBtn = q(".qv-loop");
  const track = q(".qv-track"), cv = $("canvas", track), g = cv.getContext("2d");
  const phEl = q(".qv-ph"), pchip = q(".qv-pchip"), hov = q(".qv-hov"), hchip = q(".qv-hchip");
  const zslider = q(".qv-zoom .slider"), svBox = h(`<div class="qv-sv"></div>`);
  const workc = q(".qv-workc"), work = q(".qv-work"), tlRow = q(".qv-tlrow");
  // ── docking (shared/dock.js): the timeline (bottom by default, or top, or floating; a vertical
  // timeline would need its own drawing, so no left/right) and the piece panel (right of the
  // preview by default; left, top, bottom, above or beside the timeline, or floating). Both are
  // flex children of the workspace, so docked panels never overlap; floating ones are moved off
  // each other when dropped. Phones: the timeline stays at the bottom, the panel is a sheet.
  const tlDock = createDock({
    id: "video.timeline", root: workc, title: "Timeline", slim: true, phoneSlot: "bottom",
    slots: [
      { id: "bottom", label: "Bottom", dir: "column", container: workc, at: "end", hint: () => workc, edge: "bottom", ws: true },
      { id: "top", label: "Top", dir: "column", container: workc, at: "start", hint: () => workc, edge: "top", ws: true },
    ],
    defaults: { slot: "bottom", size: { row: 400, column: 250 }, float: { x: 24, y: 220, w: 960, h: 250 } },
    limits: { w: [480, 4000], h: [200, 460] }, minFloat: { w: 480, h: 200 }, maxFloat: { w: 4000, h: 2000 },
    onChange: () => pieceDock.relayout(), // "above the timeline" follows the timeline
    onReset: () => pieceDock.reset(),
  });
  tlDock.el.classList.add("qv-tlpanel");
  tlDock.body.append(tlRow);
  const pieceDock = createDock({
    id: "video.piece", root: workc, title: "Speed & volume", icon: icon(SPEED_ICON, 14),
    slots: [
      { id: "right", label: "Right", dir: "row", container: work, at: "end", hint: () => workc, edge: "right", ws: true },
      { id: "left", label: "Left", dir: "row", container: work, at: "start", hint: () => workc, edge: "left", ws: true },
      { id: "top", label: "Top", dir: "column", container: workc, at: "start", hint: () => workc, edge: "top", ws: true },
      { id: "bottom", label: "Bottom", dir: "column", container: workc, at: "end", hint: () => workc, edge: "bottom", ws: true },
      { id: "above-tl", label: "Above timeline", dir: "column", container: workc, before: () => tlDock.el, hint: () => tlDock.el, edge: "top", split: "top", shift: -60, enabled: () => tlDock.el.parentNode === workc && !tlDock.el.classList.contains("floating") },
      { id: "beside-tl", label: "Beside timeline", dir: "row", container: tlRow, at: "end", hint: () => tlRow, edge: "right", split: "left" },
    ],
    defaults: { slot: "right", size: { row: 264, column: 170 }, float: { x: 24, y: 24, w: 280, h: 300 } },
    limits: { w: [220, 420], h: [120, 320] },
    onSheet: () => renderSV(),
    onReset: () => tlDock.reset(),
  });
  pieceDock.el.classList.add("qv-piecepanel");
  pieceDock.body.append(svBox);
  const expBtn = q(".qv-exp"), cropBtn = q(".qv-cropb");
  const btn = (a) => $(`[data-a="${a}"]`, ed);

  // ── state ────────────────────────────────────────────────────────────────
  const PREFS = "quickcut.video.prefs";
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(PREFS) || "{}") || {}; } catch {}
  const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify({ mode: lastForm.touched ? lastForm.mode : prefs.mode, fmt: lastForm.fmt, pcm: lastForm.pcm, q: lastForm.q, size: lastForm.size, fitT: lastForm.fitT, fitFmt: lastForm.fitFmt, muted, loopOn, zoom: zoomZ, snap: snapOn })); } catch {} };
  let active = false;
  let doc = null; // {file, handle, url, name, info, dur, fps, W, H (display), srcRot, keys, worker}
  let P = []; // pieces: {id, start, end, speed, volume}
  let selIds = []; // selected pieces (ids)
  let anchorId = null; // Shift-click extends from here
  let snapOn = prefs.snap ?? true;
  let guideT = null; // timeline snap guide
  let C = { M: I2, rect: null, aspect: "Free" }; // applied crop & rotate
  let past = [], future = [];
  // just opened (a wrong file dropped or pasted): the first Undo, with nothing to undo, goes back to the start screen;
  // anything else the user does first clears it for good
  let justOpened = false;
  let L = null; // layout
  let tl = 0; // playhead, timeline seconds
  let loopOn = prefs.loopOn ?? true, muted = !!prefs.muted;
  let playing = false, act = 0, pi = -1, raf = 0;
  let shuttle = 1, revTimer = 0, revSpeed = 0; // J/K/L
  let cropping = null; // draft {M, rect, aspect}
  let exportLayer = null, job = null, lastForm = { mode: prefs.mode === "exact" ? "exact" : "instant", touched: prefs.mode === "exact", fmt: fmtById(prefs.fmt) ? prefs.fmt : "same", pcm: !!prefs.pcm, q: QUALITY[prefs.q] ? prefs.q : "Balanced", res: 0, name: "",
    // size target ("File size" in Exact): the size in bytes and the format ("auto" or a format id)
    size: !!prefs.size, fitT: prefs.fitT > 0 ? prefs.fitT : 25e6, fitFmt: fmtById(prefs.fitFmt) ? prefs.fitFmt : "auto", fitUnit: prefs.fitT >= 1e9 ? "GB" : "MB" };
  // key index → ImageBitmap, least recently drawn first. Bounded: a 7-hour file has ~26 000 key
  // frames, and zooming, scrolling and speed changes keep asking for new ones (each 30–200 KB).
  const thumbs = new Map(), THUMB_MAX = 600;
  let thumbKeys = null; // the cached key indices, sorted (rebuilt when the set changes)
  function addThumb(k, bmp) {
    const old = thumbs.get(k);
    if (old && old !== bmp) old.close?.();
    thumbs.delete(k);
    thumbs.set(k, bmp);
    if (!old) thumbKeys = null;
    if (thumbs.size <= THUMB_MAX) return;
    const gone = [];
    for (const [k2, b2] of thumbs) { if (thumbs.size <= THUMB_MAX - 50) break; b2.close?.(); thumbs.delete(k2); gone.push(k2); }
    thumbKeys = null;
    doc?.worker?.postMessage({ op: "thumbForget", list: gone });
    lastThumbAsk = "";
  }
  /** The thumbnail of key `ki`, else (while it is being made) the nearest one already there. */
  function thumbFor(ki) {
    const b = thumbs.get(ki);
    if (b) { thumbs.delete(ki); thumbs.set(ki, b); return { b, exact: true }; }
    // the nearest one however far: a tile never stays empty while any picture exists (a long file's
    // pictures arrive one by one, and cuts at high speed ask for keys far from the ones decoded)
    if (!thumbs.size) return { b: null, exact: false };
    const ks = thumbKeys || (thumbKeys = [...thumbs.keys()].sort((a, c) => a - c));
    let lo = 0, hi = ks.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ks[m] < ki) lo = m + 1; else hi = m; }
    const n = lo > 0 && Math.abs(ks[lo - 1] - ki) <= Math.abs(ks[lo] - ki) ? ks[lo - 1] : ks[lo];
    return { b: thumbs.get(n), exact: false };
  }
  let peaks = null, coarse = null, waveDone = false; // waveform: max |sample| per 10 ms and per second (waveDone: all of it is there)
  let lastThumbAsk = "";
  // read-only numbers for checking the tool (seek and open times, the edit)
  // (tests) set the pieces like an edit would: [[start, end, speed, volume], …]
  const setPieces = (list) => { commit("Edit"); P = list.map(([start, end, speed = 1, volume = 1]) => ({ id: nextId++, start, end, speed, volume })); selIds = []; changed(); };
  const stats = (window.__qcVideo = { setPieces, justOpened: () => justOpened, thumbCount: () => thumbs.size, keys: () => doc?.keys?.length, mode: () => ({ stepMode, shuttle }), zoomInfo: () => ({ pps, fit: fitPps(), scrollX, guideT, padL: G.padL, zf, snapOn }), seeks: [], opens: [], state: () => ({ P: P.map((p) => [+p.start.toFixed(3), +p.end.toFixed(3), p.speed, p.volume]), sel: selIds.map((id) => P.findIndex((p) => p.id === id)), C, tl, total: L?.total, playing, job: job && { state: job.state, mode: job.mode, frac: job.frac, stage: job.stage, left: job.left, fps: job.fps }, lastDone: lastDone && { name: lastDone.name, bytes: lastDone.bytes, secs: lastDone.secs }, unfinished: () => unfinished.map((u) => ({ id: u.id, name: u.j.name, pct: jobPct(u.j) })) }) });

  // ── open a file ──────────────────────────────────────────────────────────
  intake(root, (files) => openDropped(files), { isActive: () => active && !job, filter: (f) => isVideo(f) || maybeProject(f) });
  /** A dropped / picked file: a project (.qcut) or a video. */
  async function openAny(file, handle) { return openDropped([{ file, handle }]); }
  /**
   * Dropped files: a project (with its video dropped alongside, if any), or a video. A video dropped
   * while a project waits for its video links it (when it's the right one).
   */
  async function openDropped(items) {
    let proj = null;
    for (const it of items) if (maybeProject(it.file) && (await qcut.sniff(it.file))) { proj = it; break; }
    const vids = items.filter((it) => isVideo(it.file));
    if (proj) { openProject(proj.file, { handle: null, also: vids }); return; }
    if (!vids[0]) return;
    if (relinkWait && (await relinkWith(vids[0].file, vids[0].handle, true))) return;
    relinkWait = null;
    openFile(vids[0].file, vids[0].handle);
  }
  // a project opened without its video: the next dropped (or chosen) video that matches it is used
  let relinkWait = null;
  /** Use `file` for the waiting project; false when it isn't that project's video. */
  async function relinkWith(file, handle, quiet = false) {
    const w = relinkWait;
    if (!w) return false;
    if (!(await w.same(file))) { if (!quiet) toast(`That isn't ${w.name}`, { bad: true, ms: 5000 }); return false; }
    if (relinkWait !== w) return false;
    relinkWait = null;
    w.finish(file, handle);
    return true;
  }
  const openRecentProject = async (rec) => {
    const blob = await recents.project(rec.id);
    if (blob) { openProject(blob, { handle: rec.handle || null, relink: () => recents.open(rec) }); return; }
    const f = await recents.open(rec);
    if (f) openFile(f, rec.handle || undefined);
    else { toast(`Can't open ${rec.name} any more. Choose it again.`, { bad: true }); choose(); }
  };
  const showRecents = async () => {
    renderRecents(recentBox, "video", (f, rec) => openFile(f, rec?.handle || undefined), { pickAgain: choose, onProject: openRecentProject });
    await migrating;
    const saved = await session.load("video");
    if (!saved?.name || !(saved.project || saved.state?.P?.length)) { resumeBox.hidden = true; resumeBox.replaceChildren(); return; }
    renderResume(resumeBox, "video", async (rec) => {
      if (rec.project) { openProject(rec.project, { handle: rec.handle || null, relink: () => session.file(rec) }); return; }
      let f = await session.file(rec), hd = rec.handle || undefined;
      if (!f) {
        // big files are not copied into the session (and some browsers give no file handle):
        // ask for the same file again (same name and size) and restore the edit onto it
        toast(`Choose ${rec.name} again to continue.`, { ms: 5000, info: true });
        const got = await pickFiles({ accept: "video/*,.mkv,.mov", types: VIDEO_TYPES });
        if (!got[0]) return;
        if (got[0].file.name !== rec.name || (rec.size && got[0].file.size !== rec.size)) { toast(`That isn't ${rec.name}${rec.size ? ` (${fmtBytes(rec.size)})` : ""}. Choose the same file.`, { bad: true, ms: 5000 }); return; }
        f = got[0].file; hd = got[0].handle;
      }
      openFile(f, hd, rec.state);
    });
  };
  const migrating = migrate();
  showRecents();

  // ── projects (.qcut): the edit, its settings and the timeline caches; never the video itself ──
  /** Once: an old session (the edit as JSON, maybe a copy of the video) becomes a project; the old record stays until that worked. */
  async function migrate() {
    const rec = await session.load("video");
    const st = rec?.state;
    if (!st?.P?.length || rec.project) return;
    try {
      const fp = rec.file ? await qcut.fingerprint(rec.file) : null;
      const pdoc = { source: fp || { name: rec.name, size: rec.size || 0, hash: null }, edit: { pieces: st.P, sel: st.sel, crop: st.C, name: st.name }, view: { tl: st.tl, zoom: st.zoom, scroll: st.scroll }, cache: null };
      const project = await qcut.write({ type: "video", doc: pdoc, preview: previewOf(rec.thumb) });
      const now = await session.load("video");
      if (now?.at !== rec.at) return; // something newer was saved meanwhile
      await session.save("video", { name: rec.name, size: rec.size, sub: rec.sub, thumb: rec.thumb || null, pid: rec.file ? recentId("video", rec.file) : "video:session", handle: rec.handle || null, project });
    } catch (e) { console.warn("video: old session not converted (kept as it is)", e); }
  }
  const okCrop = (c) => c && typeof c === "object" && Array.isArray(c.M) && c.M.length === 4 && c.M.every(num) && (c.rect === null || (c.rect && ["x", "y", "w", "h"].every((k) => num(c.rect[k])))) && typeof c.aspect === "string";
  /** The timeline caches of a project, checked (anything odd is left out: it is only a cache). */
  function okCache(c) {
    if (!c || typeof c !== "object" || !num(c.dur) || c.dur <= 0) return null;
    const keys = c.keys instanceof Float64Array && c.keys.length && c.keys.every((k, i) => Number.isFinite(k) && (i === 0 || k >= c.keys[i - 1])) ? c.keys : null;
    const peaks = c.peaks instanceof Float32Array && c.peaks.length ? c.peaks : null;
    const t = c.thumbs;
    const thumbsOk = keys && t && t.sprite instanceof Blob && Number.isInteger(t.cols) && t.cols > 0 && Array.isArray(t.cell) && t.cell.length === 2 && t.cell.every((x) => Number.isInteger(x) && x > 0 && x <= 512) && t.times instanceof Float64Array;
    return { dur: c.dur, fps: num(c.fps) && c.fps > 0 ? c.fps : 30, w: Number.isInteger(c.w) ? c.w : 0, h: Number.isInteger(c.h) ? c.h : 0, srcRot: num(c.srcRot) ? c.srcRot : 0, keysReal: !!c.keysReal && !!keys, keys, peaks, thumbs: thumbsOk ? t : null };
  }
  /**
   * Open a project: read it, find its video (the handle / file `relink()` gives, else ask for it; checked by
   * size and fingerprint) and restore the edit onto it. A Photo project goes to Photo.
   */
  async function openProject(blob, { handle = null, relink = null, also = [] } = {}) {
    if (job) { toast("Export running", { bad: true }); return; }
    let f, pd;
    try { f = await qcut.read(blob); } catch (e) { toast(qErr(e), { bad: true }); return; }
    if (f.type !== "video") {
      if (f.type === "photo") dispatchEvent(new CustomEvent("quickcut:project", { detail: { tool: "photo", file: blob, handle } }));
      else toast(qErr(), { bad: true });
      return;
    }
    try { pd = await f.loadAll(); } catch (e) { toast(qErr(e), { bad: true }); return; }
    const src = pd?.source;
    if (!src || typeof src.name !== "string" || !num(src.size) || !pd.edit || !Array.isArray(pd.edit.pieces)) { toast(qErr(), { bad: true }); return; }
    const same = async (file) => !!file && file.size === src.size && (typeof src.hash === "string" && src.hash ? (await qcut.fingerprint(file)).hash === src.hash : file.name === src.name);
    const e = pd.edit, v = pd.view && typeof pd.view === "object" ? pd.view : {};
    const pieces = e.pieces.filter((p) => p && num(p.start) && num(p.end));
    if (!pieces.length) { toast(qErr(), { bad: true }); return; }
    const finish = (file, hd) => openFile(file, hd, { P: pieces, sel: Array.isArray(e.sel) ? e.sel.filter(Number.isInteger) : [], C: okCrop(e.crop) ? e.crop : null, name: typeof e.name === "string" ? e.name.slice(0, 200) : "", tl: num(v.tl) ? v.tl : 0, zoom: num(v.zoom) ? v.zoom : undefined, scroll: num(v.scroll) ? v.scroll : undefined }, okCache(pd.cache));
    // its video: the remembered one, one dropped with it, or the video that is open right now
    let file = null, hd = handle || undefined;
    try { file = relink ? await relink() : null; } catch {}
    if (!(await same(file))) {
      file = null;
      for (const c of [...also, doc && { file: doc.file, handle: doc.handle }].filter(Boolean)) if (await same(c.file)) { file = c.file; hd = c.handle; break; }
    }
    if (file) { relinkWait = null; finish(file, hd); return; }
    // not here: drop it anywhere on the editor, or choose it
    relinkWait = { name: src.name, same, finish };
    const choose = async () => { const got = await pickFiles({ accept: "video/*,.mkv,.mov", types: VIDEO_TYPES }); if (got[0]) relinkWith(got[0].file, got[0].handle); };
    toast(`Drop or choose ${src.name}`, { info: true, ms: 15000, action: "Choose", onAction: choose });
  }
  /** The project of the open video. `sprite`: the thumbnails as one picture (or null). */
  function projectDoc(d, sprite) {
    const f = d.file;
    return {
      source: d.fp || { name: f.name, size: f.size, lastModified: f.lastModified, type: f.type, hash: null },
      edit: { pieces: P.map(({ start, end, speed, volume }) => ({ start, end, speed, volume })), sel: selIds.map((id) => P.findIndex((p) => p.id === id)), crop: C, name: lastForm.name },
      view: { tl, zoom: zoomZ, scroll: scrollX },
      cache: { dur: d.dur, fps: d.fps, w: d.W, h: d.H, srcRot: d.srcRot, keysReal: !!d.keysReal, keys: d.keys || null, peaks: peaks && waveDone ? peaks : null, thumbs: sprite },
    };
  }
  // the key-frame thumbnails as one WebP (at most 256, 96 px high), rebuilt only when the set changed
  let spriteMemo = null;
  async function thumbSprite(d) {
    if (!d.keys || !thumbs.size) return null;
    const ks = [...thumbs.keys()].filter((k) => k >= 0 && k < d.keys.length).sort((a, b) => a - b);
    if (!ks.length) return null;
    const pick = ks.length <= 256 ? ks : Array.from({ length: 256 }, (_, i) => ks[Math.floor((i * ks.length) / 256)]);
    const key = pick.join(",");
    if (spriteMemo?.d === d && spriteMemo.key === key) return spriteMemo.out;
    const b0 = thumbs.get(pick[0]), s = Math.min(1, 96 / b0.height);
    const cw = Math.max(1, Math.round(b0.width * s)), ch = Math.max(1, Math.round(b0.height * s));
    const cols = Math.max(1, Math.min(pick.length, Math.floor(4096 / cw))), rows = Math.ceil(pick.length / cols);
    const c = new OffscreenCanvas(cols * cw, rows * ch), g = c.getContext("2d");
    pick.forEach((k, i) => { const b = thumbs.get(k); if (b?.width) g.drawImage(b, (i % cols) * cw, Math.floor(i / cols) * ch, cw, ch); });
    const out = { sprite: await c.convertToBlob({ type: "image/webp", quality: 0.7 }), cols, cell: [cw, ch], times: Float64Array.from(pick.map((k) => d.keys[k])) };
    spriteMemo = { d, key, out };
    return out;
  }
  /** Cached thumbnails back onto the timeline. */
  async function loadSprite(d, t) {
    try {
      const bmp = await createImageBitmap(t.sprite), [cw, ch] = t.cell;
      for (let i = 0; i < t.times.length && doc === d; i++) {
        const x = (i % t.cols) * cw, y = Math.floor(i / t.cols) * ch;
        if (x + cw > bmp.width || y + ch > bmp.height) break;
        let lo = 0, hi = d.keys.length - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (d.keys[m] < t.times[i]) lo = m + 1; else hi = m; }
        if (d.keys[lo] !== t.times[i] || thumbs.has(lo)) continue;
        addThumb(lo, await createImageBitmap(bmp, x, y, cw, ch));
      }
      bmp.close();
      if (doc === d) draw();
    } catch {}
  }
  /** Save project: downloads name.qcut (the edit; the video stays where it is). */
  async function saveProject() {
    const d = doc;
    if (!d || !L) return;
    try {
      await d.fpP;
      const blob = await qcut.write({ type: "video", doc: projectDoc(d, await thumbSprite(d)), preview: previewOf(d.thumb) }, { mode: "best" });
      download(blob, `${baseName(d.name) || "project"}${qcut.EXT}`);
      toast(`Saved · ${fmtBytes(blob.size)}`);
    } catch (e) { console.error(e); toast("Can't save project", { bad: true }); }
  }
  // (tests) the project as saved now, and opening one
  Object.assign(stats, { projectBlob: async (mode = "best") => { await doc.fpP; return qcut.write({ type: "video", doc: projectDoc(doc, await thumbSprite(doc)), preview: previewOf(doc.thumb) }, { mode }); }, openProject: (b, o) => openProject(b, o), openFile: (f, h, rs, c) => openFile(f, h, rs, c), peaksDone: () => !!peaks && waveDone });
  Object.defineProperty(stats, "doc", { get: () => doc, configurable: true }); // (tests) a live view, not a copy

  async function openFile(file, handle, restoreState, cache = null) {
    if (job) { toast("Export running", { bad: true }); return; }
    if (!isVideo(file)) { toast(`${file.name} isn't a video.`, { bad: true }); return; }
    const t0 = performance.now();
    closeDoc();
    const url = URL.createObjectURL(file);
    const d = { file, handle, url, name: file.name, info: null, dur: 0, fps: 30, W: 0, H: 0, srcRot: 0, keys: null, worker: null, t0, pid: recentId("video", file), fp: null };
    d.fpP = qcut.fingerprint(file).then((fp) => { d.fp = fp; }, () => {});
    doc = d;
    empty.hidden = true; ed.hidden = false;
    busyEl.hidden = false; busyEl.textContent = "Opening…";
    q(".file .n").textContent = file.name;
    q(".file .m").textContent = "";
    for (const v of V) { v.src = url; v.muted = muted; }
    const meta = new Promise((res, rej) => {
      V[0].addEventListener("loadedmetadata", res, { once: true });
      V[0].addEventListener("error", () => rej(new Error("play")), { once: true });
    });
    // probe in the worker at the same time
    const w = new Worker(WORKER_URL, { type: "module" });
    d.worker = w;
    const probed = new Promise((res) => {
      w.onmessage = (e) => onProbe(d, e.data, res);
      w.onerror = () => res(null);
    });
    w.postMessage({ op: "open", file });
    try { await meta; } catch {
      if (doc !== d) return;
      toast(`This browser can't play ${file.name}.`, { bad: true });
      closeDoc(); showEmpty(); return;
    }
    if (doc !== d) return;
    // a project's caches (key frames, waveform, thumbnails, frame rate): the timeline shows at once, the probe fills in later
    const info = cache ? null : await Promise.race([probed, new Promise((r) => setTimeout(() => r(null), 8000))]);
    if (doc !== d) return;
    d.dur = Number.isFinite(V[0].duration) && V[0].duration > 0 ? V[0].duration : info?.duration || cache?.dur || 0;
    d.W = V[0].videoWidth; d.H = V[0].videoHeight;
    const vt = info && info.video >= 0 ? info.tracks[info.video] : null;
    if (vt) { d.fps = vt.fps || 30; d.srcRot = vt.rotation || 0; }
    else if (cache) { d.fps = cache.fps; d.srcRot = cache.srcRot; if (!d.W) { d.W = cache.w; d.H = cache.h; } }
    if (!d.W && vt) { d.W = vt.rotation % 2 ? vt.height : vt.width; d.H = vt.rotation % 2 ? vt.width : vt.height; }
    if (cache) {
      if (!d.keys && cache.keys) { d.keys = cache.keys; d.keysReal = cache.keysReal; }
      if (cache.peaks) {
        peaks = cache.peaks; waveDone = true; coarse = new Float32Array(Math.ceil(peaks.length / 100) + 1);
        for (let i = 0; i < peaks.length; i++) { const b = Math.floor(i / 100); if (peaks[i] > coarse[b]) coarse[b] = peaks[i]; }
      }
      if (cache.thumbs && d.keys) loadSprite(d, cache.thumbs);
      probed.then((i) => { if (doc !== d) return; if (!i || !d.keys) fallbackThumbs(); else if (!peaks) w.postMessage({ op: "wave" }); });
    }
    q(".file .m").textContent = `${d.W}×${d.H} · ${fmtFps(info || cache ? d.fps : 0)} fps · ${fmtTime(d.dur, { cs: false })}`;
    busyEl.hidden = true;
    P = [{ id: nextId++, start: 0, end: d.dur, speed: 1, volume: 1 }];
    selIds = []; anchorId = null; C = { M: I2, rect: null, aspect: "Free" }; past = []; future = []; justOpened = true;
    tl = 0; zoomFit();
    lastForm.name = `${baseName(file.name)}_trim`;
    if (typeof prefs.zoom === "number" && prefs.zoom > 0) zoomZ = clamp(prefs.zoom, 0, 1);
    const rs = restoreState;
    if (rs && Array.isArray(rs.P) && rs.P.length) {
      P = rs.P.map((p) => ({ id: nextId++, start: clamp(+p.start, 0, d.dur), end: clamp(+p.end, 0, d.dur), speed: parseSpeed(p.speed) || 1, volume: clamp(+p.volume || 0, 0, 2) })).filter((p) => p.end - p.start > 1e-3);
      if (!P.length) P = [{ id: nextId++, start: 0, end: d.dur, speed: 1, volume: 1 }];
      selIds = (Array.isArray(rs.sel) ? rs.sel : [rs.sel]).filter((i) => P[i]).map((i) => P[i].id);
      if (rs.C) C = rs.C;
      if (rs.name) lastForm.name = rs.name;
      if (typeof rs.zoom === "number") zoomZ = clamp(rs.zoom, 0, 1);
    }
    changed();
    if (rs && typeof rs.scroll === "number") { scrollX = rs.scroll; clampScroll(); draw(); }
    tl = rs ? clamp(+rs.tl || 0, 0, L.total) : 0;
    seekTl(tl, true);
    if (!rs) session.clear("video");
    stats.opens.push({ name: file.name, ms: Math.round(performance.now() - t0) });
    if (!cache) { if (!info || !doc.keys) fallbackThumbs(); else w.postMessage({ op: "wave" }); }
    // recents
    V[0].addEventListener("seeked", async () => {
      if (doc !== d) return;
      try {
        const thumb = await thumbOf(V[0]);
        d.thumb = thumb;
        saveSession();
        await recents.add("video", { file, handle, thumb, sub: resLabel(d.W, d.H), dur: fmtTime(d.dur, { cs: false }), copy: false }); // the video itself is never stored
      } catch {}
    }, { once: true });
  }

  function onProbe(d, m, res) {
    if (doc !== d) return;
    if (m.op === "info") {
      d.info = m.info;
      if (m.info.video >= 0 && m.keys.length) { d.keys = m.keys; d.keysReal = true; }
      res(m.info);
    } else if (m.op === "error" && m.what === "open") res(null);
    else if (m.op === "thumb") { addThumb(m.k, m.bmp); draw(); }
    else if (m.op === "thumbsOff") fallbackThumbs();
    else if (m.op === "wave") {
      if (!peaks) { peaks = new Float32Array(m.total); coarse = new Float32Array(Math.ceil(m.total / 100) + 1); }
      const part = m.peaks.subarray(0, Math.max(0, Math.min(m.peaks.length, peaks.length - m.start)));
      peaks.set(part, m.start);
      for (let i = 0; i < m.peaks.length; i++) { const b = Math.floor((m.start + i) / 100); if (m.peaks[i] > coarse[b]) coarse[b] = m.peaks[i]; }
      draw();
    } else if (m.op === "waveDone") waveDone = true;
    else if (m.op === "estimate") estimates.get(m.id)?.(m);
  }

  function closeDoc() {
    pause();
    if (exportLayer) closeLayer(exportLayer, { remember: false });
    if (cropping) leaveCrop(false);
    if (doc) { doc.worker?.terminate(); URL.revokeObjectURL(doc.url); }
    fbVideo?.remove(); fbVideo = null;
    for (const b of thumbs.values()) b.close?.();
    thumbs.clear(); thumbKeys = null; peaks = coarse = null; waveDone = false; lastThumbAsk = ""; spriteMemo = null;
    for (const v of V) { v.removeAttribute("src"); v.load(); }
    doc = null;
  }
  // the session is a project (.qcut: the edit, its settings and the timeline caches), shared with the
  // video's Recent; the video itself is never stored (re-linked by its handle, or asked for and checked)
  function saveSession() {
    const d = doc;
    if (!d || !L) return;
    session.saveSoon("video", ({ sync = false } = {}) => {
      if (doc !== d) return null;
      const rec = { name: d.name, size: d.file.size, sub: `${resLabel(d.W, d.H)} · ${P.length} piece${P.length === 1 ? "" : "s"} · ${fmtTime(editDur(), { cs: false })}`, thumb: d.thumb || null, pid: d.pid, handle: d.handle || null };
      // closing the page: written now, with the thumbnails as last saved
      if (sync) return { ...rec, project: qcut.writeSync({ type: "video", doc: projectDoc(d, spriteMemo?.d === d ? spriteMemo.out : null), preview: previewOf(d.thumb) }) };
      return (async () => {
        await d.fpP;
        const sprite = await thumbSprite(d);
        if (doc !== d) return null;
        return { ...rec, project: await qcut.write({ type: "video", doc: projectDoc(d, sprite), preview: previewOf(d.thumb) }, { mode: "quick" }) };
      })();
    });
  }
  function showEmpty() { ed.hidden = true; empty.hidden = false; showRecents(); }

  // ── model ────────────────────────────────────────────────────────────────
  const snap = () => JSON.stringify({ P, selIds, C });
  // history: one step per edit (a drag is one step); each step names its action for the tooltips
  function pushHist(before, label) { clearJustOpened(); past.push({ s: before, label }); if (past.length > 300) past.shift(); future = []; }
  function commit(label) { pushHist(snap(), label); }
  function restore(s) { const o = JSON.parse(s); P = o.P; selIds = o.selIds || []; C = o.C; changed(); }
  function clearJustOpened() { if (justOpened) { justOpened = false; if (doc && L) changed(); } }
  function undo() {
    if (justOpened && !past.length) { justOpened = false; closeDoc(); showEmpty(); return; }
    clearJustOpened();
    if (!past.length) return;
    const e = past.pop(); future.push({ s: snap(), label: e.label }); restore(e.s); }
  function redo() { clearJustOpened(); if (!future.length) return; const e = future.pop(); past.push({ s: snap(), label: e.label }); restore(e.s); }
  const minLen = () => Math.max(1 / (doc?.fps || 30), 0.04);
  const sel = () => P.find((p) => selIds.includes(p.id)) || null;
  const selected = () => P.filter((p) => selIds.includes(p.id));

  function layout() {
    const segs = [];
    let t = 0;
    const p0 = P[0], pl = P[P.length - 1];
    let lo = 0, hi = doc.dur;
    for (const p of P) { if (p !== p0 && p.end <= p0.start + 1e-6) lo = Math.max(lo, p.end); if (p !== pl && p.start >= pl.end - 1e-6) hi = Math.min(hi, p.start); }
    if (p0.start - lo > 1e-6) { const d = (p0.start - lo) / p0.speed; segs.push({ ghost: true, src0: lo, src1: p0.start, speed: p0.speed, t0: 0, t1: d }); t = d; }
    for (const p of P) { const d = (p.end - p.start) / p.speed; segs.push({ p, src0: p.start, src1: p.end, speed: p.speed, t0: t, t1: t + d }); t += d; }
    const inT = segs.find((s) => s.p).t0, outT = t;
    if (hi - pl.end > 1e-6) { const d = (hi - pl.end) / pl.speed; segs.push({ ghost: true, src0: pl.end, src1: hi, speed: pl.speed, t0: t, t1: t + d }); t += d; }
    return { segs, total: t, inT, outT, lo, hi, pieces: segs.filter((s) => s.p) };
  }
  const segAt = (t) => L.segs.find((s) => t < s.t1 - 1e-9) || L.segs[L.segs.length - 1];
  const srcAt = (t) => { const s = segAt(t); return clamp(s.src0 + (t - s.t0) * s.speed, s.src0, s.src1); };
  const segOf = (p) => L.pieces.find((s) => s.p === p);
  const pieceIndexAt = (t) => { const s = segAt(t); return s.p ? P.indexOf(s.p) : -1; };

  function changed() {
    if (!doc) return;
    L = layout();
    tl = clamp(tl, 0, L.total);
    selIds = selIds.filter((id) => P.some((p) => p.id === id));
    btn("undo").disabled = !past.length && !justOpened;
    btn("redo").disabled = !future.length;
    btn("undo").title = past.length ? `Undo ${past[past.length - 1].label} (${kl("undo")})` : "Undo";
    btn("redo").title = future.length ? `Redo ${future[future.length - 1].label} (${kl("redo")})` : "Redo";
    btn("delete").disabled = !selIds.length || P.length - selIds.length < 1;
    renderSV();
    layoutStage();
    clampScroll();
    updateTime();
    draw();
    if (playing) resync();
    if (exportLayer) renderExport();
    saveSession();
  }

  // ── editing ──────────────────────────────────────────────────────────────
  /** Split the piece under timeline time `t` (no history); the new right piece, "edge" or null. */
  function splitAtT(t) {
    const s = segAt(t);
    if (!s.p || t <= s.t0 + 1e-6 || t >= s.t1 - 1e-6) return s.p ? "edge" : null;
    const f = doc.fps;
    const src = Math.round(srcAt(t) * f) / f;
    if (src - s.p.start < minLen() - 1e-6 || s.p.end - src < minLen() - 1e-6) return "edge";
    const p = s.p, i = P.indexOf(p);
    const b = { ...p, id: nextId++, start: src };
    p.end = src;
    P.splice(i + 1, 0, b);
    L = layout();
    return b;
  }
  function split() {
    if (!doc) return;
    if (!segAt(tl).p) { toast("Nothing to split", { info: true }); return; }
    const before = snap();
    const b = splitAtT(tl);
    if (!b || b === "edge") { toast("Too close to a cut", { info: true }); return; }
    pushHist(before, "Split");
    selIds = [b.id]; anchorId = b.id;
    changed();
  }
  function del() {
    const ps = selected();
    if (!ps.length) { toast("No piece selected", { info: true }); return; }
    if (P.length - ps.length < 1) { toast("One piece must stay", { info: true }); return; }
    commit(ps.length > 1 ? "Delete pieces" : "Delete");
    const i = P.indexOf(ps[0]);
    const t0 = segOf(ps[0]).t0;
    P = P.filter((p) => !ps.includes(p));
    selIds = [P[Math.min(i, P.length - 1)].id];
    pause();
    changed();
    tl = clamp(t0, L.inT, L.outT);
    seekTl(tl, true);
  }

  // ── preview: layout of the frame ─────────────────────────────────────────
  let boxRect = { x: 0, y: 0, w: 0, h: 0, s: 1, Wo: 0, Ho: 0 };
  function layoutStage() {
    if (!doc || !doc.W) return;
    const st = { w: stage.clientWidth, h: stage.clientHeight };
    const c = cropping || C;
    const M = c.M, turned = M[0] === 0;
    const Wd = doc.W, Hd = doc.H, Wo = turned ? Hd : Wd, Ho = turned ? Wd : Hd;
    const r = !cropping && C.rect ? C.rect : { x: 0, y: 0, w: 1, h: 1 };
    const cw = r.w * Wo, ch = r.h * Ho;
    const ph = isPhone(), px = ph ? 0 : 24, py = ph ? 0 : 12;
    let bottom = 0;
    if (cropping && ph) bottom = 52;
    const s = Math.max(0.01, Math.min((st.w - 2 * px) / cw, (st.h - 2 * py - bottom) / ch));
    const bw = cw * s, bh = ch * s;
    boxRect = { x: (st.w - bw) / 2, y: (st.h - bottom - bh) / 2, w: bw, h: bh, s, Wo, Ho };
    Object.assign(box.style, { left: `${boxRect.x}px`, top: `${boxRect.y}px`, width: `${bw}px`, height: `${bh}px` });
    box.classList.toggle("full", !!cropping);
    const cx = -r.x * Wo * s + (Wo * s) / 2, cy = -r.y * Ho * s + (Ho * s) / 2;
    for (const v of V) Object.assign(v.style, { width: `${Wd * s}px`, height: `${Hd * s}px`, left: `${cx - (Wd * s) / 2}px`, top: `${cy - (Hd * s) / 2}px`, transform: same(M, I2) ? "" : `matrix(${M[0]},${M[2]},${M[1]},${M[3]},0,0)` });
    // chip
    const on = !cropping && (C.rect || !same(C.M, I2));
    chip.hidden = !on;
    if (on) $("span", chip).textContent = C.rect ? `Crop ${C.aspect === "Free" ? "" : C.aspect + " "}on` : "Rotate on";
    if (cropping) renderCrop();
  }

  // ── playback ─────────────────────────────────────────────────────────────
  const vA = () => V[act], vB = () => V[1 - act];
  function setVol(v, p) { v.volume = clamp(p ? p.volume : 1, 0, 1); v.muted = muted || (p && p.volume === 0); }
  function swapVisible() { V[act].classList.remove("off"); V[1 - act].classList.add("off"); }
  const nextIndex = (i) => (i + 1 < P.length ? i + 1 : loopOn ? 0 : -1);
  const contiguous = (a, b) => b && Math.abs(b.start - a.end) < 1e-6 && b.speed === a.speed && P.indexOf(b) === P.indexOf(a) + 1;
  // A <video> decodes every source frame it plays: at 16× a 5K60 HEVC file asks the GPU for ~960
  // frames a second and drops 91 % of them (measured: 4× drops 20 %), and Chrome plays at most
  // 16×. So a piece faster than what the decoder keeps up with (by pixel rate, 4×–16×) is
  // previewed by showing key frames (one decode per shown frame) when they are dense enough;
  // above 16× always (exact frames where key frames are far apart).
  const nativeMax = () => clamp(2e9 / Math.max(1, doc.W * doc.H * (doc.fps || 30)), 4, 16);
  const keyGap = () => (doc.keysReal && doc.keys?.length > 1 ? doc.dur / doc.keys.length : Infinity);
  const effSpeed = (p) => p.speed * shuttle;
  const stepped = (p) => { const s = effSpeed(p); return s > 16 + 1e-9 || (s > nativeMax() && keyGap() / s <= 0.1); };
  let stepMode = false, stepLast = 0, stepShown = -1, stepSrc = 0, playTok = 0;
  function play() {
    if (!doc || playing) return;
    let t = tl, i = pieceIndexAt(t);
    if (i < 0 || t >= L.outT - 0.5 / doc.fps) { i = 0; t = L.inT; }
    playing = true;
    playBtn.innerHTML = icon("pause", 18, { fill: true });
    playBtn.setAttribute("aria-label", `Pause (${kl("play")})`);
    if (stepped(P[i])) startStep(i, t); else startNative(i, t);
  }
  function startNative(i, t) {
    stepMode = false;
    pi = i;
    const p = P[i], v = vA();
    const src = clamp(srcAt(t), p.start, p.end);
    v.playbackRate = vrate(effSpeed(p));
    setVol(v, p);
    if (Math.abs(v.currentTime - src) > 0.002) v.currentTime = src;
    // a play() cut short by a pause (an edit while playing restarts playback) rejects with
    // AbortError: that must not stop the playback that replaced it
    const tok = ++playTok;
    v.play().catch((e) => { if (e?.name !== "AbortError" && tok === playTok) pause(); });
    prepareNext();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
    frameCb();
  }
  /** Key-frame preview of a fast piece: the playhead runs in real time; the frame shown is the key
   * frame at or before it (exact where key frames are far apart); one seek in flight. No sound. */
  function startStep(i, t) {
    stepMode = true;
    pi = i; tl = t;
    for (const v of V) v.pause();
    stepLast = performance.now(); stepShown = -1;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(stepTick);
  }
  function stepTick(now) {
    if (!playing || !stepMode) return;
    tl += (Math.max(0, now - stepLast) / 1000) * shuttle;
    stepLast = now;
    if (tl >= L.outT - 1e-6) {
      if (!loopOn) { const last = P[P.length - 1]; pause(); seekTl(L.outT - 0.5 / doc.fps / last.speed, true); return; }
      tl = L.inT;
    }
    const i = pieceIndexAt(tl);
    if (i < 0) { tl = L.inT; raf = requestAnimationFrame(stepTick); return; }
    pi = i;
    if (!stepped(P[i])) { startNative(i, tl); return; }
    stepSrc = srcAt(tl);
    if (!seekBusy) {
      const k = doc.keysReal && doc.keys ? doc.keys[keyNear(stepSrc)] : -1;
      // the key frame while it is less than 0.1 s (of playback) behind, else the exact frame
      const want = k >= 0 && stepSrc - k <= 0.1 * effSpeed(P[i]) ? k + 1e-4 : stepSrc;
      if (want !== stepShown) { stepShown = want; seekSrc(want, false); }
    }
    updateTime();
    follow();
    raf = requestAnimationFrame(stepTick);
  }
  function pause() {
    if (!playing) return;
    playing = false;
    stepMode = false;
    cancelAnimationFrame(raf);
    for (const v of V) v.pause();
    playBtn.innerHTML = icon("play", 18, { fill: true });
    playBtn.setAttribute("aria-label", `Play (${kl("play")})`);
  }
  function prepareNext() {
    if (!playing || stepMode || pi < 0 || !P[pi]) return;
    const j = nextIndex(pi);
    if (j < 0 || contiguous(P[pi], P[j]) || stepped(P[j])) return;
    const s = vB();
    s.pause();
    if (Math.abs(s.currentTime - P[j].start) > 0.002) s.currentTime = P[j].start;
  }
  function frameCb() {
    const v = vA();
    if (!playing || stepMode || !v.requestVideoFrameCallback) return;
    v.requestVideoFrameCallback((now, meta) => { if (playing && !stepMode && v === vA()) { atMedia(meta.mediaTime); frameCb(); } });
  }
  function tick() {
    if (!playing || stepMode) return;
    atMedia(vA().currentTime);
    if (playing && !stepMode) raf = requestAnimationFrame(tick);
  }
  function atMedia(mt) {
    const p = P[pi];
    if (!p) { pause(); return; }
    if (mt >= p.end - 0.5 / doc.fps) {
      const j = nextIndex(pi);
      if (j < 0) { pause(); tl = L.outT; seekTl(L.outT - 0.5 / doc.fps / p.speed, true); updatePlayhead(); return; }
      const q2 = P[j];
      if (stepped(q2)) { vA().pause(); startStep(j, segOf(q2).t0); updateTime(); return; }
      if (contiguous(p, q2)) { pi = j; vA().playbackRate = vrate(effSpeed(q2)); setVol(vA(), q2); }
      else {
        const s = vB();
        if (Math.abs(s.currentTime - q2.start) > 0.05) s.currentTime = q2.start;
        s.playbackRate = vrate(effSpeed(q2));
        setVol(s, q2);
        s.play().catch(() => {});
        vA().pause();
        act = 1 - act;
        swapVisible();
        pi = j;
        frameCb();
      }
      prepareNext();
      mt = q2.start;
    }
    const sg = segOf(P[pi]);
    if (sg) tl = sg.t0 + (Math.max(mt, P[pi].start) - P[pi].start) / P[pi].speed;
    updateTime();
    follow();
  }
  /** After an edit while playing (undo/redo, speed, volume, split…): keep showing the same source
   * frame, at the pieces' new speeds and volumes (switching between <video> and key-frame preview
   * when a speed crosses the limit). */
  function resync() {
    if (!playing) return;
    const src = stepMode ? stepSrc : vA().currentTime;
    let i = pi;
    if (!P[i] || src < P[i].start - 1e-3 || src > P[i].end + 1e-3) i = P.findIndex((p) => src >= p.start - 1e-3 && src < p.end);
    if (i >= 0) { const sg = segOf(P[i]); tl = sg.t0 + (clamp(src, P[i].start, P[i].end) - P[i].start) / P[i].speed; }
    if (i < 0 || i !== pi || stepped(P[i]) !== stepMode) { pause(); play(); return; }
    if (!stepMode) { vA().playbackRate = vrate(effSpeed(P[i])); setVol(vA(), P[i]); prepareNext(); }
  }
  function togglePlay() { stopReverse(); shuttle = 1; playing ? pause() : play(); }
  function stopReverse() { clearInterval(revTimer); revTimer = 0; revSpeed = 0; }
  function shuttleKey(k) {
    if (k === "k") { stopReverse(); shuttle = 1; pause(); return; }
    if (k === "l") {
      stopReverse();
      if (playing) { shuttle = Math.min(8, shuttle * 2); resync(); } else { shuttle = 1; play(); }
      return;
    }
    // J: play backwards (stepping, as browsers can't play video in reverse)
    pause();
    revSpeed = revSpeed ? Math.min(8, revSpeed * 2) : 1;
    if (!revTimer) revTimer = setInterval(() => {
      const t = tl - 0.08 * revSpeed;
      if (t <= 0) { stopReverse(); seekTl(0, true); return; }
      seekTl(t, false); follow();
    }, 80);
  }
  function jumpCut(dir) {
    const cuts = [...new Set([...L.pieces.map((sg) => sg.t0), L.outT])].sort((a, b) => a - b);
    const t = dir < 0 ? [...cuts].reverse().find((c) => c < tl - 1e-3) : cuts.find((c) => c > tl + 1e-3);
    if (t == null) return;
    pause();
    seekTl(Math.min(t, L.outT - 0.5 / doc.fps), true);
    follow();
  }
  // [ and ]: these steps (from a typed speed in between: the next step)
  const SPEED_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8, 16, 32, 64, 100];
  function nudgeSpeed(dir) {
    const ps = selected();
    if (!ps.length) { toast("No piece selected", { info: true }); return; }
    const cur = ps[0].speed;
    const next = dir > 0 ? SPEED_STEPS.find((x) => x > cur + 1e-6) : [...SPEED_STEPS].reverse().find((x) => x < cur - 1e-6);
    if (next != null) applySpeed(next);
  }
  // seeking: one seek in flight; the latest wish wins; exact on release
  let seekBusy = false, seekWant = null, seekFast = false, seekT0 = 0, exactT = 0, lastKey = -1, lastSrc = -1;
  function seekSrc(src, exact) {
    clearTimeout(exactT);
    seekWant = src; seekFast = !exact;
    if (!seekBusy) doSeek();
  }
  /** Preview while dragging (trim edges, scrubbing): Chrome has no fastSeek, and an exact seek to
   * an arbitrary frame of 5K HEVC decodes a whole GOP (~230 ms here), which stalls the preview and
   * makes the GPU drop frames. So: show the nearest key frame in [lo, hi] (~10 ms), except when
   * moving forward inside the GOP already being shown (the decoder just continues); the exact
   * frame follows once the pointer rests for 120 ms, and on release (callers seek exact). */
  function previewSrc(src, lo = -Infinity, hi = Infinity) {
    const k = doc.keys;
    if (!doc.keysReal || !k || k.length < 2) { seekSrc(src, false); return; }
    const i = keyNear(src);
    if (i === lastKey && src >= lastSrc) { lastSrc = src; seekSrc(src, false); return; }
    const best = i + 1 < k.length && k[i + 1] - src < src - k[i] ? k[i + 1] : k[i];
    if (best < lo - 1e-6 || best > hi + 1e-6) { seekSrc(src, false); lastKey = i; lastSrc = src; return; }
    lastKey = keyNear(best + 1e-4); lastSrc = best + 1e-4;
    seekSrc(best + 1e-4, false);
    exactT = setTimeout(() => { lastKey = i; lastSrc = src; seekSrc(src, true); }, 120);
  }
  function doSeek() {
    if (seekWant == null) return;
    const v = vA(), s = seekWant;
    seekWant = null; seekBusy = true; seekT0 = performance.now();
    if (seekFast && v.fastSeek) v.fastSeek(s); else v.currentTime = s;
    // a seek whose "seeked" never comes (decoder reset, element swapped) must not freeze the preview
    clearTimeout(seekDog);
    seekDog = setTimeout(() => { if (seekBusy && performance.now() - seekT0 >= 1900) { seekBusy = false; doSeek(); } }, 2000);
  }
  let seekDog = 0;
  for (const v of V) v.addEventListener("seeked", () => {
    if (v !== vA() || !seekBusy) return;
    const ms = performance.now() - seekT0;
    if (stats.seeks.length > 500) stats.seeks.shift();
    stats.seeks.push(ms);
    seekBusy = false;
    doSeek();
  });
  function seekTl(t, exact) {
    if (!doc) return;
    tl = clamp(t, 0, L.total);
    const s = segAt(tl);
    // while dragging: key frame preview (see previewSrc); exact on release
    const src = srcAt(tl);
    if (exact) { lastKey = -1; seekSrc(src, true); } else previewSrc(src, s.src0, s.src1);
    if (s.p) setVol(vA(), s.p);
    updateTime();
  }
  function step(dir) {
    if (!doc) return;
    pause();
    const s = segAt(tl);
    const f = 1 / doc.fps;
    let src = Math.round(srcAt(tl) / f) * f + dir * f;
    let t = s.t0 + (src - s.src0) / s.speed;
    if (src < s.src0 - 1e-6 || src >= s.src1 - 1e-6) t = tl + (dir * f) / s.speed;
    seekTl(clamp(t, 0, L.total - f / 4), true);
    follow();
  }
  function updateTime() {
    if (!doc || !L) return;
    timeEl.firstChild.nodeValue = `${fmtTime(tl)} `;
    timeEl.lastChild.textContent = `/ ${fmtTime(L.total)}`;
    updatePlayhead();
  }

  // ── timeline geometry ────────────────────────────────────────────────────
  let W = 0, H = 0, zf = 1, pps = 10, scrollX = 0, zoomZ = 0;
  const geo = () => {
    const ph = isPhone(), compact = !matchMedia("(min-width: 1200px)").matches;
    // the pieces take the track's height (no hint line under them)
    const th = track.clientHeight || 180;
    const pieceH = ph ? clamp(th - 30 - 46, 120, 220) : clamp(th - 30 - 12, compact ? 84 : 92, 160);
    const hw = ph ? 22 : 10;
    return { ph, pieceTop: 30, pieceH, thumbH: Math.round(pieceH * 0.58), hw, tileW: ph ? 30 : 56, padL: Math.max(ph ? 8 : 12, hw + 4), padR: Math.max(ph ? 8 : 12, hw + 4) };
  };
  let G = geo();
  const fitPps = () => Math.max(1e-6, (W - G.padL - G.padR) / Math.max(L?.total || 1, 1e-3));
  const maxPps = () => Math.max(fitPps() * 1.01, (doc?.fps || 30) * 24);
  const xOf = (t) => G.padL + t * pps - scrollX;
  const tOf = (x) => (x + scrollX - G.padL) / pps;
  function setPps(p, anchorX) {
    const t = tOf(anchorX);
    pps = clamp(p, fitPps(), maxPps());
    zoomZ = Math.log(pps / fitPps()) / Math.log(maxPps() / fitPps()) || 0;
    zslider.value = String(Math.round(zoomZ * 1000));
    syncSlider(zslider);
    scrollX = G.padL + t * pps - anchorX;
    clampScroll();
    draw();
    zoomSaved();
  }
  function zoomFit() { zoomZ = 0; scrollX = 0; if (L) pps = fitPps(); zslider.value = "0"; syncSlider(zslider); draw(); zoomSaved(); }
  let zsT = 0;
  function zoomSaved() { clearTimeout(zsT); zsT = setTimeout(() => { savePrefs(); saveSession(); }, 400); }
  function clampScroll() {
    if (!L) return;
    const fp = fitPps();
    pps = fp * Math.pow(maxPps() / fp, zoomZ);
    if (zslider.value !== String(Math.round(zoomZ * 1000))) { zslider.value = String(Math.round(zoomZ * 1000)); syncSlider(zslider); }
    const content = G.padL + L.total * pps + G.padR;
    scrollX = clamp(scrollX, 0, Math.max(0, content - W));
  }
  function follow() {
    if (!playing) { updatePlayhead(); return; }
    const x = xOf(tl);
    if (x > W - G.padR || x < G.padL) { scrollX += x - G.padL - 40; clampScroll(); draw(); }
    else updatePlayhead();
  }
  function measure() {
    const r = track.getBoundingClientRect();
    W = track.clientWidth; H = track.clientHeight;
    zf = W ? r.width / W : 1;
    chipW.len = -1;
    G = geo();
    const dpr = devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(W * zf * dpr)), bh = Math.max(1, Math.round(H * zf * dpr));
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    clampScroll();
    draw();
    layoutStage();
  }
  const ro = new ResizeObserver(() => measure());
  ro.observe(track); ro.observe(stage);
  addEventListener("quickcut:zoom", () => measure());

  // theme colours, re-read when the theme changes
  let col = {};
  const readCols = () => {
    const s = getComputedStyle(document.documentElement);
    for (const k of ["bg-1", "bg-2", "bg-3", "tx-1", "tx-2", "tx-3", "acc", "trim", "on-trim", "wave", "border"]) col[k] = s.getPropertyValue(`--${k}`).trim()
    col.mono = s.getPropertyValue("--mono").trim();
  };
  readCols();
  new MutationObserver(() => { readCols(); draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ── timeline drawing ─────────────────────────────────────────────────────
  let drawQ = 0;
  function draw() { if (!drawQ) drawQ = requestAnimationFrame(paint); }
  const rr = (x, y, w, hh, r) => { g.beginPath(); g.roundRect(x, y, w, hh, r); };
  function keyNear(t) {
    const k = doc.keys;
    let lo = 0, hi = k.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (k[m] <= t) lo = m; else hi = m - 1; }
    return lo;
  }
  function paint() {
    drawQ = 0;
    if (!doc || !L || !W || ed.hidden) return;
    const dpr = devicePixelRatio || 1;
    g.setTransform(dpr * zf, 0, 0, dpr * zf, 0, 0);
    g.clearRect(0, 0, W, H);
    const { pieceTop: pt, pieceH: ph, thumbH, hw, tileW } = G;
    stats.tiles = 0; stats.tilesEmpty = 0;
    // ruler
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 900, 1800, 3600, 7200, 14400];
    const step = steps.find((s) => s * pps >= (s >= 3600 ? 96 : 80)) || 14400;
    const t0 = Math.max(0, Math.floor(tOf(0) / step) * step - step), t1 = tOf(W) + step;
    g.fillStyle = col["tx-3"];
    for (let s = t0; s <= Math.min(t1, L.total + step / 2); s += step / 2) {
      const major = Math.abs(s / step - Math.round(s / step)) < 1e-6;
      g.fillRect(Math.round(xOf(s)), major ? 16 : 20, 1, major ? 8 : 4);
    }
    g.font = `400 11px ${col.mono || "monospace"}`;
    g.fillStyle = col["tx-2"];
    g.textBaseline = "top";
    for (let s = Math.ceil(t0 / step) * step; s <= Math.min(t1, L.total); s += step) {
      const x = xOf(s);
      const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      const mm = hh ? `${hh}:${String(m).padStart(2, "0")}` : `${m}`;
      const txt = step < 1 ? `${mm}:${sec.toFixed(1).padStart(4, "0")}` : `${mm}:${String(Math.round(sec) % 60).padStart(2, "0")}`;
      if (x > -60 && x < W - 30) g.fillText(txt, x + 4, 2);
    }
    // ghosts (trimmed away): the same thumbnails and waveform, greyed
    const want = [];
    for (const s of L.segs) if (s.ghost) {
      const a = xOf(s.t0) + (s.t0 > 0 ? 2 : 0), b = xOf(s.t1) - (s.t1 < L.total ? 2 : 0);
      if (b - a < 1) continue;
      drawPiece(s, a - 1, b + 1, want, 0.42);
    }
    // pieces
    const drag = reorder;
    const order = drag ? drag.order : L.pieces;
    let tx = L.pieces[0].t0;
    const placed = [];
    for (const s of order) {
      const d = s.t1 - s.t0;
      if (drag && s === drag.seg) { placed.push({ s, x0: null }); tx += d; continue; }
      placed.push({ s, t0: tx }); tx += d;
    }
    for (const pl of placed) {
      if (pl.t0 == null) continue;
      drawPiece(pl.s, xOf(pl.t0), xOf(pl.t0 + pl.s.t1 - pl.s.t0), want, 1);
    }
    if (drag) drawPiece(drag.seg, drag.x, drag.x + (drag.seg.t1 - drag.seg.t0) * pps, want, 0.85);
    // trim outline and handles around the whole edit
    const fx = xOf(L.inT), lx = xOf(L.outT);
    if (!drag) {
      g.strokeStyle = col.trim; g.lineWidth = 2;
      rr(fx - 2 + 1, pt - 3 + 1, lx - fx + 4 - 2, ph + 6 - 2, 6); g.stroke();
      for (const [x, left] of [[fx - hw - 1, true], [lx + 1, false]]) {
        g.fillStyle = col.trim;
        rr(x, pt - 3, hw, ph + 6, left ? [6, 0, 0, 6] : [0, 6, 6, 0]); g.fill();
        g.fillStyle = col["on-trim"];
        const cx = x + hw / 2, cy = pt - 3 + (ph + 6) / 2 - 8;
        g.fillRect(cx - 2.75, cy, 1.5, 16); g.fillRect(cx + 1.25, cy, 1.5, 16);
      }
    }
    if (guideT != null) { g.fillStyle = col.acc; g.fillRect(Math.round(xOf(guideT)) - 0.5, 0, 1, pt + ph + 6); }
    // while an edge or a piece is being dragged the tiles' times shift on every move: asking the
    // worker each frame only queues decodes nobody sees (and competes with the preview's decoder),
    // so ask once the drag ends
    stats.miss = want.length;
    if (want.length && doc.keys && !(gesture && (gesture.kind === "trim" || gesture.kind === "reorder"))) {
      const c = xOf(tl);
      const ask = [...new Set(want.sort((a, b) => Math.abs(a[1] - c) - Math.abs(b[1] - c)).map((x) => x[0]))].filter((k) => !thumbs.has(k));
      const key = ask.join(",");
      if (key !== lastThumbAsk) { lastThumbAsk = key; stats.thumbAsks = (stats.thumbAsks || 0) + 1; if (fbVideo) fbAsk(ask); else doc.worker?.postMessage({ op: "thumbs", list: ask, h: Math.round((thumbH - 4) * dpr * zf) }); }
    }
    updatePlayhead();
  }

  function drawPiece(s, x0, x1, want, alpha) {
    const { pieceTop: pt, pieceH: ph, thumbH, tileW } = G;
    const a = x0 + 1, w = x1 - x0 - 2;
    if (a > W || a + w < 0 || w < 1) return;
    const ghost = !s.p;
    const p = s.p || { id: null, start: s.src0, speed: s.speed, volume: 1 };
    g.save();
    g.globalAlpha = alpha;
    g.fillStyle = col["bg-3"];
    rr(a, pt, w, ph, 4); g.fill();
    g.save(); rr(a, pt, w, ph, 4); g.clip();
    // thumbnails: tiles at fixed offsets; each shows the key frame nearest its time
    const tw = tileW, th = thumbH - 4;
    for (let k = 0, tx = a + 2; tx < a + w - 1; k++, tx += tw + 2) {
      if (tx + tw < 0) continue;
      if (tx > W) break;
      const t = p.start + ((tx - a + tw / 2) / pps) * p.speed;
      let bmp = null;
      if (doc.keys) {
        const ki = keyNear(t), r = thumbFor(ki);
        bmp = r.b;
        if (!r.exact) want.push([ki, tx]);
      }
      if (bmp) {
        const sc = Math.max(tw / bmp.width, th / bmp.height), sw = tw / sc, sh = th / sc;
        g.save(); rr(tx, pt + 2, tw, th, 2); g.clip();
        g.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, tx, pt + 2, tw, th);
        g.restore();
      } else { g.fillStyle = col["bg-2"]; rr(tx, pt + 2, tw, th, 2); g.fill(); stats.tilesEmpty++; }
      stats.tiles++;
    }
    // waveform
    g.fillStyle = col["bg-1"];
    g.fillRect(a, pt + thumbH, w, 1);
    const wy = pt + thumbH + 1, wh = ph - thumbH - 1, maxH = wh - 8;
    g.fillStyle = col.wave;
    const n = Math.floor((w - 6) / 3);
    for (let j = 0; j < n; j++) {
      const bx = a + 3 + j * 3;
      if (bx < -3 || bx > W) continue;
      let v = 0;
      if (peaks) {
        const sa = p.start + ((bx - a) / pps) * p.speed, sb = p.start + ((bx - a + 3) / pps) * p.speed;
        if (sb - sa > 4) { for (let i = Math.floor(sa), e = Math.min(coarse.length, Math.ceil(sb)); i < e; i++) if (coarse[i] > v) v = coarse[i]; }
        else { for (let i = Math.max(0, Math.floor(sa * 100)), e = Math.min(peaks.length, Math.ceil(sb * 100)); i < e; i++) if (peaks[i] > v) v = peaks[i]; }
        v = Math.min(1, Math.sqrt(v * Math.min(p.volume, 2)));
      }
      const bh = 3 + Math.round(v * maxH);
      rr(bx, wy + (wh - bh) / 2, 2, bh, 1); g.fill();
    }
    // speed / volume badge
    if (ghost) { g.globalAlpha = 0.45; g.fillStyle = col["bg-1"]; g.fillRect(a, pt, w, ph); }
    const tag = ghost ? "" : [p.speed !== 1 ? `${fmtSpeed(p.speed)}×` : "", p.speed > MUTE_ABOVE ? "no sound" : p.volume !== 1 ? `${Math.round(p.volume * 100)}%` : ""].filter(Boolean).join(" · ");
    if (tag && w > 40) {
      g.font = "500 11px Inter, sans-serif";
      const tw2 = g.measureText(tag).width + 10;
      g.fillStyle = "rgba(14,14,15,0.85)"; rr(a + 4, pt + 4, tw2, 18, 4); g.fill();
      g.fillStyle = "#EDEDEF"; g.textBaseline = "middle"; g.fillText(tag, a + 9, pt + 13.5);
    }
    g.restore();
    if (selIds.includes(p.id)) { g.strokeStyle = col.acc; g.lineWidth = 2; rr(a - 1, pt - 1, w + 2, ph + 2, 5); g.stroke(); }
    g.restore();
  }

  const chipW = { len: -1, w: 0 };
  function updatePlayhead() {
    if (!L || !W) return;
    const x = xOf(tl), lineH = G.pieceTop + G.pieceH + 6;
    const vis = x >= -2 && x <= W + 2;
    phEl.style.display = vis ? "" : "none";
    phEl.style.height = `${lineH}px`;
    phEl.style.transform = `translateX(${x}px)`;
    pchip.style.display = vis ? "" : "none";
    const txt = fmtTime(tl);
    if (pchip.firstChild?.nodeValue !== txt) pchip.textContent = txt;
    // reading offsetWidth forces a layout on every move; the chip's width only changes with the
    // number of characters (tabular digits), so measure it once per length
    if (vis && chipW.len !== txt.length) { chipW.len = txt.length; chipW.w = pchip.offsetWidth; }
    pchip.style.transform = `translate(${clamp(x - chipW.w / 2, 0, W - chipW.w)}px, ${G.pieceTop + G.pieceH + 12}px)`;
  }

  // ── timeline interaction ─────────────────────────────────────────────────
  let reorder = null; // {seg, order, x, dx}
  const pointers = new Map();
  let gesture = null;
  const local = (e) => { const r = track.getBoundingClientRect(); return { x: (e.clientX - r.left) / zf, y: (e.clientY - r.top) / zf }; };
  function hit(x, y) {
    const { pieceTop: pt, pieceH: ph, hw } = G;
    if (y >= pt - 6 && y <= pt + ph + 6) {
      const fx = xOf(L.inT), lx = xOf(L.outT);
      const slop = isTouch() ? 10 : 4;
      if (x >= fx - hw - 1 - slop && x <= fx + (isTouch() ? 6 : 2)) return { kind: "in" };
      if (x >= lx - (isTouch() ? 6 : 2) && x <= lx + hw + 1 + slop) return { kind: "out" };
    }
    if (y >= pt && y <= pt + ph) {
      const t = tOf(x);
      const s = L.pieces.find((s) => t >= s.t0 && t < s.t1);
      if (s) return { kind: "piece", seg: s };
    }
    return { kind: y < pt - 4 ? "ruler" : "empty" };
  }
  /** Snap timeline time `t` to piece edges, In/Out, the playhead and (zoomed
   * in) whole seconds, within 8 px. Alt or Ctrl bypasses. Sets the guide line. */
  function snapT(t, e, { lay = L, playhead = true, playheadT = tl } = {}) {
    guideT = null;
    if (!snapOn || e?.altKey || e?.ctrlKey || e?.metaKey) return t;
    const cand = [lay.inT, lay.outT];
    for (const sg of lay.segs) cand.push(sg.t0, sg.t1);
    if (playhead) cand.push(playheadT);
    if (pps >= 40) cand.push(Math.round(t));
    let best = t, bd = 8 / pps;
    for (const c of cand) { const d = Math.abs(c - t); if (d < bd) { bd = d; best = c; } }
    if (best !== t) guideT = best;
    return best;
  }

  // middle button: drag the timeline sideways at any zoom (no playhead move, no selection, no browser auto-scroll)
  let midPan = null; // {id, x0, s0}
  const midEnd = (e) => {
    if (!midPan || (e && e.pointerId !== midPan.id)) return;
    try { track.releasePointerCapture(midPan.id); } catch {}
    midPan = null; track.style.cursor = "";
  };
  track.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
  track.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
  track.addEventListener("pointerdown", (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    if (!doc || !L || midPan || gesture) return;
    try { track.setPointerCapture(e.pointerId); } catch {}
    hideHover();
    midPan = { id: e.pointerId, x0: local(e).x, s0: scrollX };
    track.style.cursor = "grabbing";
  });
  track.addEventListener("pointermove", (e) => {
    if (!midPan || e.pointerId !== midPan.id) return;
    scrollX = midPan.s0 - (local(e).x - midPan.x0); clampScroll(); draw();
  });
  track.addEventListener("pointerup", midEnd);
  track.addEventListener("pointercancel", midEnd);
  track.addEventListener("lostpointercapture", midEnd);
  track.addEventListener("pointerdown", (e) => {
    if (!doc || !L || e.button > 0) return;
    if (track.clientWidth !== W || track.clientHeight !== H) measure();
    try { track.setPointerCapture(e.pointerId); } catch {}
    const pt = local(e);
    pointers.set(e.pointerId, pt);
    hideHover();
    if (pointers.size === 2) {
      // pinch zoom
      clearTimeout(gesture?.timer);
      if (gesture?.kind === "trim" || gesture?.kind === "reorder") endGesture(true);
      const [a, b] = [...pointers.values()];
      gesture = { kind: "pinch", d: Math.abs(a.x - b.x) || 1, pps, mid: (a.x + b.x) / 2, t: tOf((a.x + b.x) / 2) };
      return;
    }
    if (pointers.size > 2) return;
    const hitr = hit(pt.x, pt.y);
    const touch = e.pointerType !== "mouse";
    const wasPlaying = playing;
    if (hitr.kind === "in" || hitr.kind === "out") {
      pause();
      gesture = { kind: "trim", which: hitr.kind, before: snap(), L0: L, x0: pt.x, wasPlaying, tl0: tl };
      return;
    }
    if (hitr.kind === "piece") {
      gesture = { kind: "piece", seg: hitr.seg, x0: pt.x, y0: pt.y, pt, wasPlaying, touch, moved: false, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
      if (touch) gesture.timer = setTimeout(() => { if (gesture?.kind === "piece" && !gesture.moved) { navigator.vibrate?.(15); startReorder(gesture.seg, gesture.pt.x); } }, 380);
      return;
    }
    if (touch && hitr.kind === "empty") { gesture = { kind: "pan", x0: pt.x, s0: scrollX, moved: false, pt }; return; }
    // scrub
    pause();
    gesture = { kind: "scrub", wasPlaying };
    scrubTo(pt.x, false, e);
  });
  track.addEventListener("pointermove", (e) => {
    if (!doc || !L || midPan) return;
    const pt = local(e);
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === "mouse") showHover(pt);
      return;
    }
    pointers.set(e.pointerId, pt);
    if (!gesture) return;
    if (gesture.kind === "pinch" && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.abs(a.x - b.x) || 1, mid = (a.x + b.x) / 2;
      pps = clamp(gesture.pps * (d / gesture.d), fitPps(), maxPps());
      zoomZ = Math.log(pps / fitPps()) / Math.log(maxPps() / fitPps()) || 0;
      zslider.value = String(Math.round(zoomZ * 1000));
      syncSlider(zslider);
      zoomSaved();
      scrollX = G.padL + gesture.t * pps - mid;
      clampScroll(); draw();
      return;
    }
    if (gesture.kind === "scrub") scrubTo(pt.x, false, e);
    else if (gesture.kind === "pan") {
      if (Math.abs(pt.x - gesture.x0) > 6) gesture.moved = true;
      scrollX = gesture.s0 - (pt.x - gesture.x0); clampScroll(); draw();
    } else if (gesture.kind === "piece") {
      const dx = pt.x - gesture.x0, dy = pt.y - gesture.y0;
      if (Math.hypot(dx, dy) > (gesture.touch ? 8 : 4)) {
        gesture.moved = true;
        clearTimeout(gesture.timer);
        if (gesture.touch) { gesture = { kind: "pan", x0: pt.x, s0: scrollX + dx, moved: true }; scrollX = gesture.s0 - (pt.x - gesture.x0); clampScroll(); draw(); }
        else startReorder(gesture.seg, gesture.x0);
      }
    } else if (gesture.kind === "reorder") moveReorder(pt.x);
    else if (gesture.kind === "trim") trimTo(pt.x, e);
  });
  const up = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (gesture?.kind === "pinch") { if (pointers.size < 2) gesture = pointers.size ? { kind: "none" } : null; return; }
    if (pointers.size) return;
    endGesture(e.type === "pointercancel", local(e));
  };
  track.addEventListener("pointerup", up);
  track.addEventListener("pointercancel", up);
  track.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hideHover(); });

  function endGesture(cancel, pt) {
    const gs = gesture;
    gesture = null;
    if (!gs) return;
    clearTimeout(gs.timer);
    if (guideT != null) { guideT = null; draw(); }
    if (gs.kind === "scrub") { if (!cancel) seekTl(tl, true); if (gs.wasPlaying) play(); }
    else if (gs.kind === "pan") { if (!gs.moved && pt) { pause(); seekTl(clamp(tOf(pt.x), 0, L.total), true); } }
    else if (gs.kind === "piece") {
      if (!gs.moved && pt) {
        const id = gs.seg.p.id;
        if (gs.ctrl) { selIds = selIds.includes(id) ? selIds.filter((x) => x !== id) : [...selIds, id]; anchorId = id; }
        else if (gs.shift && anchorId != null && P.some((q2) => q2.id === anchorId)) {
          const i0 = P.findIndex((q2) => q2.id === anchorId), i1 = P.indexOf(gs.seg.p);
          selIds = P.slice(Math.min(i0, i1), Math.max(i0, i1) + 1).map((q2) => q2.id);
        } else { selIds = [id]; anchorId = id; }
        pause();
        changed();
        seekTl(clamp(tOf(pt.x), 0, L.total), true);
        if (gs.wasPlaying) play();
      }
    } else if (gs.kind === "reorder") finishReorder(cancel);
    else if (gs.kind === "trim") {
      const now = snap();
      if (cancel) restore(gs.before);
      else if (now !== gs.before) { pushHist(gs.before, "Trim"); changed(); }
      draw();
      seekTl(gs.which === "in" ? L.inT : Math.max(L.inT, L.outT - 1 / doc.fps / P[P.length - 1].speed), true);
    }
  }

  function scrubTo(x, exact, e) {
    const t0 = clamp(tOf(x), 0, L.total);
    const t = snapT(t0, e, { playhead: false });
    seekTl(t, exact || t !== t0);
    if (guideT != null || t !== t0) draw();
    // keep scrolling while dragging at the edges
    if (x > W - 8 && pps > fitPps()) { scrollX += 12; clampScroll(); draw(); }
    else if (x < 8 && scrollX > 0) { scrollX -= 12; clampScroll(); draw(); }
  }

  function trimTo(x, e) {
    const gs = gesture, L0 = gs.L0;
    // the playhead follows the edge while trimming: snap to where it was before the drag
    // (snapping to the moving playhead made the edge stick to itself and jump 8 px at a time)
    const t = snapT(tOf(x), e, { lay: L0, playheadT: gs.tl0 });
    if (gs.which === "in") {
      const p = P[0], s0 = L0.segs.find((s) => s.p === p) || L0.segs[0];
      const head = L0.segs[0].ghost ? L0.segs[0] : null;
      const tStart = head ? head.t0 : s0.t0;
      const src = clamp(L0.lo + (t - tStart) * p.speed, L0.lo, p.end - minLen());
      p.start = Math.round(src * doc.fps) / doc.fps;
      if (p.start < L0.lo) p.start = L0.lo;
      L = layout();
      previewSrc(p.start, L0.lo, p.end);
      tl = L.inT;
    } else {
      const p = P[P.length - 1], s0 = L0.segs.find((s) => s.p === p);
      const src = clamp(s0.src0 + (t - s0.t0) * p.speed, p.start + minLen(), L0.hi);
      p.end = Math.min(L0.hi, Math.round(src * doc.fps) / doc.fps);
      L = layout();
      previewSrc(Math.max(p.start, p.end - 1 / doc.fps), p.start, L0.hi);
      tl = L.outT;
    }
    updateTime();
    draw();
  }

  function startReorder(seg, x0) {
    if (P.length < 2) { gesture = { kind: "none" }; return; }
    pause();
    selIds = [seg.p.id]; anchorId = seg.p.id;
    const x = xOf(seg.t0);
    reorder = { seg, order: [...L.pieces], x, dx: x0 - x, idx: L.pieces.indexOf(seg) };
    gesture = { kind: "reorder" };
    draw();
  }
  function moveReorder(px) {
    const r = reorder;
    r.x = px - r.dx;
    const mid = tOf(r.x + ((r.seg.t1 - r.seg.t0) * pps) / 2);
    const others = L.pieces.filter((s) => s !== r.seg);
    let t = L.inT, idx = others.length;
    for (let i = 0; i < others.length; i++) { const d = others[i].t1 - others[i].t0; if (mid < t + d / 2) { idx = i; break; } t += d; }
    others.splice(idx, 0, r.seg);
    r.order = others;
    r.idx = idx;
    if (px > W - 20) { scrollX += 10; clampScroll(); }
    if (px < 20) { scrollX -= 10; clampScroll(); }
    draw();
  }
  function finishReorder(cancel) {
    const r = reorder;
    reorder = null;
    const newP = r.order.map((s) => s.p);
    if (!cancel && newP.some((p, i) => p !== P[i])) { commit("Move piece"); P = newP; }
    changed();
    const s = segOf(r.seg.p);
    if (s) { tl = s.t0; seekTl(tl, true); }
  }

  function showHover(pt) {
    if (gesture || G.ph) return;
    const t = tOf(pt.x);
    if (t < 0 || t > L.total || pt.y > G.pieceTop + G.pieceH + 6) { hideHover(); return; }
    hov.hidden = false; hchip.hidden = false;
    hov.style.height = `${G.pieceTop + G.pieceH + 6}px`;
    hov.style.transform = `translateX(${pt.x}px)`;
    hchip.textContent = fmtTime(t);
    hchip.style.transform = `translateX(${Math.min(pt.x + 6, W - hchip.offsetWidth)}px)`;
    const hh = hit(pt.x, pt.y).kind;
    track.style.cursor = hh === "in" || hh === "out" ? "ew-resize" : hh === "piece" ? "grab" : "default";
  }
  function hideHover() { hov.hidden = true; hchip.hidden = true; }

  track.addEventListener("wheel", (e) => {
    if (!doc || !L) return;
    const pt = local(e);
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      // ×1.1 per mouse notch (100 px), proportional for trackpad pinch; eased over ~100 ms
      zoomTo((zoomGoal ?? pps) * clamp(Math.exp((-dy * Math.log(1.1)) / 100), 0.8, 1.25), pt.x);
      return;
    }
    const d = (e.shiftKey ? e.deltaY : 0) + e.deltaX + (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : 0);
    const dd = e.deltaMode === 1 ? d * 16 : d;
    const content = G.padL + L.total * pps + G.padR;
    if (content <= W + 1) return;
    e.preventDefault();
    scrollX += dd;
    clampScroll();
    draw();
    showHover(pt);
  }, { passive: false });

  let zoomGoal = null, zoomRaf = 0, zoomX = 0;
  function zoomTo(goal, x) {
    zoomGoal = clamp(goal, fitPps(), maxPps()); zoomX = x;
    if (zoomRaf) return;
    const stepZ = () => {
      const d = zoomGoal / pps;
      if (Math.abs(d - 1) < 0.003) { setPps(zoomGoal, zoomX); zoomGoal = null; zoomRaf = 0; return; }
      setPps(pps * Math.pow(d, 0.45), zoomX);
      zoomRaf = requestAnimationFrame(stepZ);
    };
    zoomRaf = requestAnimationFrame(stepZ);
  }
  zslider.addEventListener("input", () => {
    if (!L) return;
    zoomZ = +zslider.value / 1000;
    const fp = fitPps();
    setPps(fp * Math.pow(maxPps() / fp, zoomZ), clamp(xOf(tl), 0, W));
  });

  // ── speed & volume panel ─────────────────────────────────────────────────
  // A speed control: presets plus a field that takes "1.37", "137%" or "2x" (0.1×–100×). Enter
  // applies, Esc puts the current value back.
  function speedControl(value, onPick, label, onDone) {
    const el = h(`<span class="qv-speed"><span class="seg" role="radiogroup" aria-label="${esc(label)}">${SPEEDS.map((v) => `<button type="button" role="radio" data-v="${v}" aria-checked="${v === value}">${v}×</button>`).join("")}</span><span class="num"><input inputmode="decimal" aria-label="${esc(label)}, custom" value="${value == null ? "" : fmtSpeed(value)}" placeholder="–"><span class="unit">×</span></span></span>`);
    const input = $("input", el);
    $(".seg", el).onclick = (e) => { const b = e.target.closest("button"); if (b) onPick(+b.dataset.v); };
    // `value` follows what was applied: Enter applies and blurs, and the blur's "change" must not
    // apply the same value a second time (that was a second, empty undo step). The field shows
    // what was applied (a typed 999 becomes 100).
    const apply = () => { const v = parseSpeed(input.value); if (v == null) { input.value = value == null ? "" : fmtSpeed(value); toast(`Speed: ${MIN_SPEED}–${MAX_SPEED}`, { bad: true }); return; } value = v; input.value = fmtSpeed(v); onPick(v); };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); apply(); input.blur(); onDone?.(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); input.value = value == null ? "" : fmtSpeed(value); input.blur(); onDone?.(); }
    });
    input.addEventListener("change", () => { if (input.value.trim() && parseSpeed(input.value) !== value) apply(); });
    return el;
  }

  // Speed & volume apply to the selected pieces.
  let svVolArmed = null;
  function applySpeed(v) {
    const ps = selected();
    if (!ps.length) { toast("No piece selected", { info: true }); return; }
    if (ps.every((p2) => p2.speed === v)) return;
    const before = snap();
    const at = srcAt(tl), atPiece = segAt(tl).p;
    ps.forEach((p2) => (p2.speed = v));
    pushHist(before, `Speed ${fmtSpeed(v)}×`);
    // keep the playhead on the same source frame (the pieces before it changed length)
    const sg = atPiece && layout().pieces.find((s) => s.p === atPiece);
    if (sg && at >= atPiece.start && at <= atPiece.end) tl = sg.t0 + (at - atPiece.start) / atPiece.speed;
    changed();
  }
  const muteNote = () => "No sound";
  const shortDur = (s) => fmtTenth(s).replace(/^0(?=\d)/, "");
  /** The piece panel (dockable, shared/dock.js; a bottom sheet on phones): Speed and Volume of the
   * selected pieces, titled with the piece ("Piece 2 · 0:04.2"); a quiet note without a selection. */
  function renderSV() {
    const ps = selected();
    const i0 = ps.length ? P.indexOf(ps[0]) : -1;
    const dur = ps.reduce((a, p2) => a + (p2.end - p2.start) / p2.speed, 0);
    pieceDock.setTitle(ps.length > 1 ? `${ps.length} pieces` : ps.length ? `Piece ${i0 + 1}` : "Speed & volume", ps.length ? shortDur(dur) : "");
    if (svBox.contains(document.activeElement) && document.activeElement.tagName === "INPUT" && document.activeElement.type !== "range") return;
    const off = !ps.length; // no piece selected: the controls, disabled
    const sp = !off && ps.every((p2) => p2.speed === ps[0].speed) ? ps[0].speed : null;
    const vol = off ? 100 : Math.round(ps[0].volume * 100);
    const fast = ps.some((p2) => p2.speed > MUTE_ABOVE);
    svBox.innerHTML = `<div class="qv-sec qv-sp"><div class="qv-sech"><span class="lbl">Speed</span></div></div>
      <div class="qv-sec qv-vol"><div class="qv-sech"><span class="lbl">Volume</span><span class="val">${vol}%</span></div><input class="slider" type="range" min="0" max="200" step="5" value="${vol}" data-default="100" aria-label="Volume" ${off ? "disabled" : ""}></div>
      ${fast ? `<div class="qv-mutenote">${icon("mute", 14)}${esc(muteNote())}</div>` : ""}`;
    // (while the field has the focus the panel isn't rebuilt: once Enter is done, it is)
    const sc = speedControl(sp, applySpeed, "Speed", () => renderSV());
    const num = $(".num", sc);
    $(".qv-sech", $(".qv-sp", svBox)).append(num);
    $(".qv-sp", svBox).append(sc);
    svBox.classList.toggle("off", off);
    if (off) for (const b of svBox.querySelectorAll("button, input")) b.disabled = true;
    const s2 = $(".slider", svBox);
    syncSlider(s2);
    $(".val", svBox).ondblclick = () => resetSlider(s2);
    const arm = () => {
      if (svVolArmed) return;
      const t2 = selected();
      if (!t2.length) return;
      pushHist(snap(), "Volume");
      svVolArmed = t2;
    };
    // armed by the first real change ("input"), so a click that leaves the value as it was is no undo step
    s2.addEventListener("input", () => {
      arm();
      if (!svVolArmed) return;
      for (const p2 of svVolArmed) p2.volume = +s2.value / 100;
      $(".val", svBox).textContent = `${s2.value}%`;
      if (playing && !stepMode && P[pi]) setVol(vA(), P[pi]);
      draw();
    });
    s2.addEventListener("change", () => { svVolArmed = null; changed(); });
  }


  // ── crop & rotate ────────────────────────────────────────────────────────
  let cropEl = null, cropBar = null;
  const aspectOf = (a, c) => (a === "Free" ? null : a === "Original" ? (c.M[0] === 0 ? doc.H / doc.W : doc.W / doc.H) : (([x, y]) => x / y)(a.split(":").map(Number)));
  function fitAspect(c, center) {
    const k = aspectOf(c.aspect, c);
    if (!k) return;
    const { Wo, Ho } = orient(c.M);
    const r = c.rect || { x: 0, y: 0, w: 1, h: 1 };
    const cx = center ? 0.5 : r.x + r.w / 2, cy = center ? 0.5 : r.y + r.h / 2;
    // largest rect of aspect k (pixels) inside the frame, centred on the old centre
    let wpx = Wo, hpx = wpx / k;
    if (hpx > Ho) { hpx = Ho; wpx = hpx * k; }
    const w = wpx / Wo, hh = hpx / Ho;
    c.rect = { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - hh / 2, 0, 1 - hh), w, h: hh };
  }
  const orient = (M) => (M[0] === 0 ? { Wo: doc.H, Ho: doc.W } : { Wo: doc.W, Ho: doc.H });
  function enterCrop() {
    if (!doc || cropping) return;
    pause();
    if (exportLayer) closeLayer(exportLayer);
    cropping = { M: [...C.M], rect: C.rect ? { ...C.rect } : { x: 0, y: 0, w: 1, h: 1 }, aspect: C.aspect };
    cropBtn.setAttribute("aria-pressed", "true");
    cropBtn.classList.add("on");
    expBtn.classList.replace("btn-p", "btn-2");
    for (const b of ed.querySelectorAll(".qv-pc")) b.hidden = false;
    if (isPhone()) { cropBtn.hidden = true; expBtn.hidden = true; }
    cropBar = h(`<div class="qv-cropbar float" role="toolbar" aria-label="Crop options">
      <span class="grp"><span class="seg" role="radiogroup" aria-label="Aspect ratio">${ASPECTS.map((a) => `<button type="button" role="radio" data-asp="${a}">${a}</button>`).join("")}</span></span>
      <span class="grp">
        <button class="ib" data-c="rot" aria-label="Rotate 90°" title="Rotate 90°">${icon("rotate")}</button>
        <button class="ib" data-c="fh" aria-label="Flip horizontal" title="Flip horizontal">${icon("flipH")}</button>
        <button class="ib" data-c="fv" aria-label="Flip vertical" title="Flip vertical">${icon("flipV")}</button>
        <button class="btn-g qv-creset" data-c="reset">Reset</button>
      </span>
      <span class="grp">
        <button class="ib qv-snap" data-c="snap" aria-pressed="${snapOn}" aria-label="Snap (N)" title="Snap (${kl("snap")})">${icon(MAGNET)}</button>
      </span>
      <span class="grp end desk-only">
        <button class="btn-g" data-c="cancel">Cancel<span class="kbd">Esc</span></button>
        <button class="btn-p" data-c="apply">Apply<span class="kbd">↵</span></button>
      </span>
    </div>`);
    cropBar.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.asp) { cropping.aspect = b.dataset.asp; if (b.dataset.asp === "Free") {} else fitAspect(cropping, false); layoutStage(); }
      else if (b.dataset.c === "rot") turnCrop(ROT);
      else if (b.dataset.c === "fh") turnCrop(FLIPH);
      else if (b.dataset.c === "fv") turnCrop(FLIPV);
      else if (b.dataset.c === "reset") { cropping.M = I2; cropping.rect = { x: 0, y: 0, w: 1, h: 1 }; cropping.aspect = "Free"; layoutStage(); }
      else if (b.dataset.c === "snap") toggleSnap();
      else if (b.dataset.c === "cancel") leaveCrop(false);
      else if (b.dataset.c === "apply") leaveCrop(true);
    };
    cropEl = h(`<div class="qv-crop"><span class="scr"></span><span class="scr"></span><span class="scr"></span><span class="scr"></span>
      <div class="rect" data-h="move"><span class="third"></span><span class="third"></span><span class="third"></span><span class="third"></span></div>
      ${["n", "s", "e", "w"].map((d) => `<span class="ed" data-h="${d}" style="cursor:${d === "n" || d === "s" ? "ns" : "ew"}-resize"></span>`).join("")}
      ${["nw", "ne", "sw", "se"].map((d) => `<span class="hd" data-h="${d}" style="cursor:${d === "nw" || d === "se" ? "nwse" : "nesw"}-resize"><i></i><i></i></span>`).join("")}
    </div>`);
    stage.append(cropEl, cropBar);
    makeMovable(cropBar, "video.crop");
    groupBar(cropBar);
    cropEl.addEventListener("pointerdown", cropDown);
    layoutStage();
  }
  function turnCrop(op) {
    const c = cropping, r = c.rect;
    c.M = mul(op, c.M);
    if (op === ROT) c.rect = { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
    else if (op === FLIPH) c.rect = { ...r, x: 1 - r.x - r.w };
    else c.rect = { ...r, y: 1 - r.y - r.h };
    if (op === ROT && c.aspect !== "Free") fitAspect(c, false);
    layoutStage();
  }
  function leaveCrop(apply) {
    if (!cropping) return;
    const c = cropping;
    cropping = null;
    cropEl?.remove(); cropBar?.remove(); cropEl = cropBar = null;
    cropBtn.setAttribute("aria-pressed", "false");
    cropBtn.classList.remove("on");
    expBtn.classList.replace("btn-2", "btn-p");
    for (const b of ed.querySelectorAll(".qv-pc")) b.hidden = true;
    cropBtn.hidden = false; expBtn.hidden = false;
    if (apply) {
      const r = c.rect;
      const full = r.x < 0.002 && r.y < 0.002 && r.w > 0.996 && r.h > 0.996;
      const next = { M: c.M, rect: full ? null : r, aspect: full ? "Free" : c.aspect };
      if (JSON.stringify(next) !== JSON.stringify(C)) { commit("Crop & rotate"); C = next; }
    }
    changed();
  }
  function renderCrop() {
    if (!cropEl || !cropping) return;
    const b = boxRect, r = cropping.rect;
    const x = b.x + r.x * b.w, y = b.y + r.y * b.h, w = r.w * b.w, hh = r.h * b.h;
    const [s1, s2, s3, s4] = cropEl.querySelectorAll(".scr");
    const set = (el, l, t, ww, h2) => Object.assign(el.style, { left: `${l}px`, top: `${t}px`, width: `${Math.max(0, ww)}px`, height: `${Math.max(0, h2)}px` });
    set(s1, b.x, b.y, b.w, y - b.y);
    set(s2, b.x, y + hh, b.w, b.y + b.h - y - hh);
    set(s3, b.x, y, x - b.x, hh);
    set(s4, x + w, y, b.x + b.w - x - w, hh);
    set($(".rect", cropEl), x, y, w, hh);
    const th = cropEl.querySelectorAll(".third");
    set(th[0], w / 3 - 1, 0, 1, hh - 3); set(th[1], (2 * w) / 3 - 1, 0, 1, hh - 3);
    set(th[2], 0, hh / 3 - 1, w - 3, 1); set(th[3], 0, (2 * hh) / 3 - 1, w - 3, 1);
    const Lh = isPhone() ? 20 : 16, T = 3;
    for (const el of cropEl.querySelectorAll(".hd")) {
      const d = el.dataset.h, px = d.includes("w") ? x : x + w, py = d.includes("n") ? y : y + hh;
      Object.assign(el.style, { left: `${px}px`, top: `${py}px` });
      const [i1, i2] = el.querySelectorAll("i");
      const sx = d.includes("w") ? 1 : -1, sy = d.includes("n") ? 1 : -1;
      // L-shaped corner: one horizontal and one vertical bar, outside the rectangle
      Object.assign(i1.style, { width: `${Lh}px`, height: `${T}px`, left: `${14 + (sx > 0 ? -T : T - Lh)}px`, top: `${14 + (sy > 0 ? -T : 0)}px` });
      Object.assign(i2.style, { width: `${T}px`, height: `${Lh}px`, left: `${14 + (sx > 0 ? -T : 0)}px`, top: `${14 + (sy > 0 ? -T : T - Lh)}px` });
    }
    for (const el of cropEl.querySelectorAll(".ed")) {
      const d = el.dataset.h, t = 16;
      if (d === "n" || d === "s") set(el, x + 14, (d === "n" ? y : y + hh) - t / 2, w - 28, t);
      else set(el, (d === "w" ? x : x + w) - t / 2, y + 14, t, hh - 28);
    }
    for (const b2 of cropBar.querySelectorAll("[data-asp]")) b2.setAttribute("aria-checked", String(b2.dataset.asp === cropping.aspect));
  }
  function showGuides(gx, gy) {
    if (!cropEl) return;
    for (const el of cropEl.querySelectorAll(".guide")) el.remove();
    const b = boxRect;
    for (const v of gx) cropEl.append(h(`<span class="guide" style="left:${b.x + v * b.w - 0.5}px;top:${b.y}px;width:1px;height:${b.h}px"></span>`));
    for (const v of gy) cropEl.append(h(`<span class="guide" style="left:${b.x}px;top:${b.y + v * b.h - 0.5}px;width:${b.w}px;height:1px"></span>`));
  }
  function cropDown(e) {
    const kind = e.target.closest("[data-h]")?.dataset.h;
    if (!kind) return;
    e.preventDefault();
    try { cropEl.setPointerCapture(e.pointerId); } catch {}
    const st = stage.getBoundingClientRect();
    const z = st.width / stage.clientWidth || 1;
    const r0 = { ...cropping.rect }, b = boxRect;
    const x0 = e.clientX, y0 = e.clientY;
    const k = aspectOf(cropping.aspect, cropping);
    const minW = 32 / b.w, minH = 32 / b.h;
    // snapping: frame edges, centre lines and thirds (8 px); Alt or Ctrl bypasses
    const LINES = [0, 1 / 3, 0.5, 2 / 3, 1];
    let gx = [], gy = [];
    const sn = (v, th, out, on) => {
      if (!on) return v;
      let best = v, bd = th;
      for (const l of LINES) { const d = Math.abs(l - v); if (d < bd) { bd = d; best = l; } }
      if (best !== v) out.push(best);
      return best;
    };
    const move = (ev) => {
      const on = snapOn && !(ev.altKey || ev.ctrlKey || ev.metaKey);
      gx = []; gy = [];
      const tx = 8 / b.w, ty = 8 / b.h;
      const dx = (ev.clientX - x0) / z / b.w, dy = (ev.clientY - y0) / z / b.h;
      let { x, y, w, h: hh } = r0;
      if (kind === "move") {
        x = clamp(x + dx, 0, 1 - w); y = clamp(y + dy, 0, 1 - hh);
        if (on) {
          // centre to the frame centre, else an edge to a line
          if (Math.abs(x + w / 2 - 0.5) < tx) { x = 0.5 - w / 2; gx.push(0.5); }
          else { const l2 = sn(x, tx, gx, true); if (l2 !== x) x = l2; else { const r2 = sn(x + w, tx, gx, true); x = r2 - w; } }
          if (Math.abs(y + hh / 2 - 0.5) < ty) { y = 0.5 - hh / 2; gy.push(0.5); }
          else { const t2 = sn(y, ty, gy, true); if (t2 !== y) y = t2; else { const b2 = sn(y + hh, ty, gy, true); y = b2 - hh; } }
          x = clamp(x, 0, 1 - w); y = clamp(y, 0, 1 - hh);
        }
      } else {
        let l = x, t = y, r = x + w, bt = y + hh;
        if (kind.includes("w")) l = clamp(sn(l + dx, tx, gx, on), 0, r - minW);
        if (kind.includes("e")) r = clamp(sn(r + dx, tx, gx, on), l + minW, 1);
        if (kind.includes("n")) t = clamp(sn(t + dy, ty, gy, on), 0, bt - minH);
        if (kind.includes("s")) bt = clamp(sn(bt + dy, ty, gy, on), t + minH, 1);
        if (k) {
          // keep the aspect (k = width/height in pixels): drive by the dragged dimension
          const pk = (k * b.h) / b.w; // in normalized units
          let nw = r - l, nh = bt - t;
          if (kind === "n" || kind === "s") nw = nh * pk;
          else if (kind === "e" || kind === "w") nh = nw / pk;
          else if (nw / nh > pk) nh = nw / pk; else nw = nh * pk;
          const ax = kind.includes("w") ? r : kind.includes("e") ? l : (l + r) / 2;
          const ay = kind.includes("n") ? bt : kind.includes("s") ? t : (t + bt) / 2;
          const maxW = kind.includes("w") ? ax : kind.includes("e") ? 1 - ax : 2 * Math.min(ax, 1 - ax);
          const maxH = kind.includes("n") ? ay : kind.includes("s") ? 1 - ay : 2 * Math.min(ay, 1 - ay);
          const f = Math.min(1, maxW / nw, maxH / nh);
          nw *= f; nh *= f;
          l = kind.includes("w") ? ax - nw : kind.includes("e") ? ax : ax - nw / 2;
          t = kind.includes("n") ? ay - nh : kind.includes("s") ? ay : ay - nh / 2;
          r = l + nw; bt = t + nh;
        }
        x = l; y = t; w = r - l; hh = bt - t;
      }
      cropping.rect = { x, y, w, h: hh };
      renderCrop();
      showGuides(gx, gy);
    };
    const end = () => { showGuides([], []); cropEl.removeEventListener("pointermove", move); cropEl.removeEventListener("pointerup", end); cropEl.removeEventListener("pointercancel", end); };
    cropEl.addEventListener("pointermove", move);
    cropEl.addEventListener("pointerup", end);
    cropEl.addEventListener("pointercancel", end);
  }

  // ── export ───────────────────────────────────────────────────────────────
  const estimates = new Map();
  let estId = 0, est = null, estKey = "";
  function instantOff() {
    if (!doc) return "No video";
    if (!doc.info) return "MP4 / MOV only";
    if (doc.info.instantOff) return doc.info.instantOff;
    if (C.rect && !same(C.M, I2)) return "Crop & rotation";
    if (C.rect) return "Crop";
    if (!same(C.M, I2)) return "Rotation";
    if (P.some((p) => p.speed !== 1)) return "Speed change";
    if (P.some((p) => p.volume !== 1)) return "Volume change";
    return null;
  }
  function cropPx() {
    const A = mul(C.M, rotQ(doc.srcRot));
    const vt = doc.info?.tracks[doc.info.video];
    const sw = vt?.width || doc.W, sh = vt?.height || doc.H;
    const Wo = A[0] === 0 ? sh : sw, Ho = A[0] === 0 ? sw : sh;
    const r = C.rect || { x: 0, y: 0, w: 1, h: 1 };
    const even = (v) => Math.max(2, Math.round(v / 2) * 2);
    return { A, Wo, Ho, crop: { x: r.x * Wo, y: r.y * Ho, w: r.w * Wo, h: r.h * Ho }, w: even(r.w * Wo), h: even(r.h * Ho) };
  }
  const rotQ = (n) => { let m = I2; for (let i = 0; i < (n || 0); i++) m = mul(ROT, m); return m; };
  function resOptions() {
    const c = cropPx();
    const out = [{ w: c.w, h: c.h }];
    const short = Math.min(c.w, c.h);
    for (const s of [2160, 1440, 1080, 720, 480, 360]) if (s < short - 8) { const f = s / short; out.push({ w: Math.max(2, Math.round((c.w * f) / 2) * 2), h: Math.max(2, Math.round((c.h * f) / 2) * 2) }); }
    return out;
  }
  const editDur = () => P.reduce((s, p) => s + (p.end - p.start) / p.speed, 0);
  // "Same as source": the source's container and codec where this browser can encode them
  function sameAsSource() {
    const vt = doc.info?.tracks[doc.info.video];
    const c = doc.info?.container === "mov" ? "mov" : doc.info?.container === "mkv" ? "mkv" : doc.info?.container === "webm" ? "webm" : "mp4";
    const id = `${c}-${vt?.codec}`;
    const ok = (x) => fmtById(x) && support.get(supKey(fmtById(x).v)) !== false;
    return ok(id) ? id : ok(`mp4-${vt?.codec}`) ? `mp4-${vt?.codec}` : "mp4-h264";
  }
  const formatOf = (f) => fmtById(f.fmt === "same" ? sameAsSource() : f.fmt) || FORMATS[0];
  const support = new Map(); // "v@WxH@fps" → true/false (encoder config probe)
  const supKey = (v) => { const r = currentRes(); return `${v}@${r.w}x${r.h}@${Math.round(doc.fps)}`; };
  const currentRes = () => resOptions()[Math.min(lastForm.res, resOptions().length - 1)];
  let probing = false;
  async function probeFormats() {
    if (probing || !doc) return;
    const r = currentRes(), fps = doc.fps;
    const todo = [...new Set(FORMATS.map((x) => x.v))].filter((v) => !support.has(supKey(v)));
    if (!todo.length) return;
    probing = true;
    for (const v of todo) support.set(`${v}@${r.w}x${r.h}@${Math.round(fps)}`, !!(await encoderConfig(v, r.w, r.h, fps, bitrateFor(v, "Balanced", r.w, r.h, fps))));
    probing = false;
    if (exportLayer) renderExport();
  }
  function exactNumbers(f) {
    const r = currentRes();
    const fmt = formatOf(f);
    const fps = doc.fps || 30;
    const bitrate = bitrateFor(fmt.v, f.q, r.w, r.h, fps);
    const dur = editDur();
    const at = doc.info && doc.info.audio >= 0 ? doc.info.tracks[doc.info.audio] : null;
    const abps = !at ? 0 : f.pcm && fmt.c !== "mp4" && fmt.c !== "webm" ? at.sampleRate * at.channels * 24 : 320e3;
    const bytes = ((bitrate + abps) * dur) / 8;
    const vt = doc.info?.tracks[doc.info.video];
    const px = Math.max(r.w * r.h, (vt?.width || doc.W) * (vt?.height || doc.H));
    // measured (Chrome, Windows): hardware encoders take ≤ 1920 px; above that the software
    // encoder is bound by copying each frame off the GPU (~330 Mpx/s: 5K ≈ 45 fps, 2.5K ≈ 85 fps)
    const opx = r.w * r.h, hwSize = Math.max(r.w, r.h) <= 1920 && fmt.v !== "av1" && fmt.v !== "vp9";
    const encFps = clamp(hwSize ? 400 * (2073600 / opx) : (fmt.v === "h264" ? 3.3e8 : 1.5e8) / Math.max(opx, px * 0.5), 4, 600);
    return { r, fps, bitrate, bytes, fmt, secs: (dur * fps) / encFps + 0.5 };
  }

  // ── Exact · File size: the best quality that fits under a size (fit.js does the maths) ──
  // which encoders exist at each candidate size: "v@WxH@fps" → {hw} | null; undefined = checking
  const fitSup = new Map();
  let fitBusy = false;
  const fitTodo = [];
  function fitCodecAt(v, w, hgt, fps) {
    const k = `${v}@${w}x${hgt}@${Math.round(fps)}`;
    if (!fitSup.has(k)) { fitSup.set(k, undefined); fitTodo.push([k, v, w, hgt, fps]); pumpFit(); }
    return fitSup.get(k);
  }
  async function pumpFit() {
    if (fitBusy) return;
    fitBusy = true;
    while (fitTodo.length) {
      const [k, v, w, hgt, fps] = fitTodo.shift();
      let r = null;
      try { const c = await encoderConfig(v, w, hgt, fps, bpsFor(3e6, v, w, hgt, fps)); r = c ? { hw: c.hardwareAcceleration === "prefer-hardware" } : null; } catch {}
      fitSup.set(k, r);
    }
    fitBusy = false;
    if (exportLayer) renderExport();
  }
  // audio encoders: AAC bit rates (Windows' encoder takes only 96–192 kb/s) and Opus
  let acaps = null, acapsBusy = false;
  async function probeAudioCaps() {
    if (acapsBusy || acaps) return;
    acapsBusy = true;
    const at = audioTrack();
    const rate = at?.sampleRate || 48000, ch = Math.min(2, at?.channels || 2);
    const ok = async (c) => { try { return !!self.AudioEncoder && (await AudioEncoder.isConfigSupported(c)).supported; } catch { return false; } };
    const aac = [];
    for (const br of [24e3, 32e3, 48e3, 64e3, 96e3, 128e3, 160e3, 192e3]) if (await ok({ codec: "mp4a.40.2", sampleRate: rate, numberOfChannels: ch, bitrate: br })) aac.push(br);
    acaps = { aac, opus: await ok({ codec: "opus", sampleRate: 48000, numberOfChannels: ch, bitrate: 64e3 }) };
    acapsBusy = false;
    if (exportLayer) renderExport();
  }
  const audioTrack = () => (doc?.info && doc.info.audio >= 0 ? doc.info.tracks[doc.info.audio] : null);
  /** The plan for the current edit and size (see fit.js planFit), or {ok: false, pending}. */
  function fitPlanNow(step = 0) {
    const f = lastForm, at = audioTrack();
    if (at && !acaps) { probeAudioCaps(); return { ok: false, pending: true }; }
    const c = cropPx(), dur = editDur(), fps = doc.fps || 30;
    if (!(dur > 0)) return { ok: false, none: true };
    const fx = f.fitFmt === "auto" ? null : fmtById(f.fitFmt);
    const plain = P.every((p) => p.speed === 1 && p.volume === 1);
    const src = at ? { codec: at.codec, bps: at.duration > 0 ? (at.bytes * 8) / at.duration : 0, channels: at.channels, rate: at.sampleRate } : null;
    // the source's own rate as "H.264 at 1080p30" (how many bits this content needs to look fine)
    const vt = doc.info?.tracks[doc.info.video];
    // Measured on the edit's own range where the file allows (MP4/MOV: the Instant estimate's
    // bytes, minus the audio): a long recording is often busy in one place and still in another.
    let vbpsSrc = vt && vt.duration > 0 && vt.bytes > 0 ? (vt.bytes * 8) / vt.duration : 0;
    if (doc.info?.container === "mp4" || doc.info?.container === "mov") {
      if (!est || estKey !== JSON.stringify(P.map((p) => [p.start, p.end]))) return { ok: false, pending: true };
      if (est.bytes > 0 && est.dur > 0) vbpsSrc = Math.max(1e3, (est.bytes * 8) / est.dur - (src?.bps || 0));
    }
    const srcE = vt && vbpsSrc > 0 && vt.width ? equiv(vbpsSrc, vt.codec, vt.width, vt.height, vt.fps || fps) : 0;
    // how many bits this content takes, measured by encoding a few samples (see contentProbe)
    const pk = probeKey();
    if (!probes.has(pk)) contentProbe(pk);
    const content = probes.get(pk);
    if (content === undefined) return { ok: false, pending: true, probing: true };
    return planFit({
      content,
      target: f.fitT, dur, cw: c.w, ch: c.h, fps, frames: dur * fps, container: fx ? fx.c : null, codecs: fx ? [fx.v] : AUTO_ORDER, codecAt: fitCodecAt, audioMin: 24e3, srcE, eLadder: window.__qcFitE || 0, stepDown: step, bppScale: window.__qcBppScale, // (tests: another ladder threshold)
      audio: (total, container) => (src ? audioChoice(audioWant(total), src, container, plain, acaps.aac, acaps.opus) : null),
    });
  }
  // ── content probe: a free "first pass" for easy content ──
  // A static screen or a still shot needs far fewer bits than the defaults assume, and the source's
  // own bit rate doesn't tell (recorders often spend a fixed rate). So three 2-second samples of
  // the edit are encoded at a small size with a constant bit rate meant for "excellent" quality;
  // an encoder that can't spend it (it hits its finest quantizer) shows how easy the content is:
  // content = bits used ÷ bits offered (1 = normal, 0.1 = very easy). Cached per edit and crop.
  const probes = new Map(); // key → content (null: couldn't measure; undefined while measuring)
  const probeKey = () => JSON.stringify([P.map((p) => [p.start, p.end, p.speed]), C.rect, C.M]);
  // One probe at a time: each holds a decoder and an encoder; a newer edit stops the older probe.
  let probeRun = null;
  async function contentProbe(key) {
    if (probeRun) { try { probeRun.w?.terminate(); } catch {} probes.delete(probeRun.key); jobs.remove(probeRun.id); }
    probes.set(key, undefined);
    let content = null, w = null;
    const id = `probe-${jobs.newId()}`;
    const me = probeRun = { key, id, w: null };
    try {
      const c = cropPx(), fps = Math.min(doc.fps || 30, 30);
      const k = Math.min(1, 720 / Math.min(c.w, c.h));
      const ow = Math.max(8, Math.round((c.w * k) / 8) * 8), oh = Math.max(8, Math.round((c.h * k) / 8) * 8);
      let v = null, conf = null;
      for (const x of AUTO_ORDER) { conf = await encoderConfig(x, ow, oh, fps, 1e6, { hwOnly: true }); if (conf) { v = x; break; } }
      if (!v) for (const x of ["h264", "vp9"]) { conf = await encoderConfig(x, ow, oh, fps, 1e6); if (conf) { v = x; break; } }
      if (!v) throw new Error("no encoder");
      // three samples at 1/6, 3/6 and 5/6 of the edit (output time → source time)
      const dur = editDur(), slices = [];
      for (const q of [1 / 6, 3 / 6, 5 / 6]) {
        let t = q * dur;
        for (const p of P) { const d = (p.end - p.start) / p.speed; if (t <= d || p === P[P.length - 1]) { const a = Math.min(p.end - 0.05, p.start + t * p.speed); slices.push({ start: a, end: Math.min(p.end, a + 2), speed: 1, volume: 1 }); break; } t -= d; }
      }
      const bps = bpsFor(6e6, v, ow, oh, fps);
      if (probeRun !== me) return;
      w = me.w = new Worker(WORKER_URL, { type: "module" });
      // every step has a deadline: the probe must never hold up the export (then: no measurement)
      const ask = (msg, want) => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`probe step ${msg.op} timed out`)), 20000);
        w.onmessage = (e) => { const m = e.data; if (m.op === want) { clearTimeout(t); res(m); } else if (m.op === "error" || m.op === "segFail") { clearTimeout(t); rej(new Error(m.why)); } };
        w.onerror = (e) => rej(new Error(e.message || "probe failed"));
        w.postMessage(msg);
      });
      const plan = await ask({ op: "plan", id: 1, pieces: slices, fps, file: doc.file, segSecs: 1000, cap: (doc.fps || 30) > fps + 1 }, "plan");
      const s = { outW: ow, outH: oh, vcodec: v, bitrate: bps, fps, A: c.A, crop: c.crop, rateMode: "constant", keyInt: 1000, tenBit: false };
      await ask({ op: "segInit", job: id, file: doc.file, s }, "segReady");
      let bytes = 0, frames = 0;
      for (let i = 0; i < plan.segs.length; i++) { const r = await ask({ op: "seg", i, frames: plan.segs[i] }, "segDone"); bytes += r.bytes; frames += r.n; }
      if (frames > 0) content = Math.max(0.05, Math.min(1, (bytes * 8) / ((frames / fps) * bps)));
      stats.probe = { content, v, ow, oh, frames, bytes, bps: Math.round(bps) };
    } catch (e) { if (probeRun === me) stats.probe = { error: String(e?.message || e) }; }
    if (probeRun !== me) return; // stopped by a newer probe (which cleaned up after this one)
    probeRun = null;
    try { w?.terminate(); } catch {}
    jobs.remove(id);
    probes.set(key, content);
    if (exportLayer) renderExport();
  }
  /** Seconds a re-encode takes. Hardware (measured, Chrome/Windows): decoding ~2.6 Gpx/s of
   * source frames (every source frame is decoded, also those a lower frame rate drops), encoding
   * ~600 Mpx/s, whichever is slower; software: see exactNumbers. */
  function encSecs(w, hgt, v, hw, fps, dur) {
    const vt = doc.info?.tracks[doc.info.video];
    const spx = (vt?.width || doc.W) * (vt?.height || doc.H), opx = w * hgt;
    if (hw) return Math.max((dur * (doc.fps || 30) * spx) / 2.6e9, (dur * fps * opx) / 6e8) + 1;
    const encFps = clamp((v === "h264" ? 3.3e8 : 1.5e8) / Math.max(opx, spx * 0.5), 4, 600);
    return (dur * fps) / encFps + 0.5;
  }
  /** Decimal sizes (1 MB = 1,000,000 bytes), as the limits are stated. */
  const sizeLbl = (b) => (b >= 1e9 ? `${+(b / 1e9).toFixed(2)} GB` : b >= 1e7 ? `${Math.round(b / 1e6)} MB` : `${+(b / 1e6).toFixed(1)} MB`);
  const fmtRate = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} Mb/s` : `${Math.round(b / 1e3)} kb/s`);
  /** Would an Instant export (lossless) already fit? (sample bytes + its index, generously) */
  const instantFits = () => !instantOff() && est && est.bytes + 64e3 + 20 * editDur() * ((doc.fps || 30) + 50) <= lastForm.fitT;

  function openExport() {
    if (!doc || !L) return;
    if (cropping) leaveCrop(true);
    if (exportLayer) { closeLayer(exportLayer); return; }
    const el = h(`<section class="qv-pop" role="dialog" aria-label="Export video"></section>`);
    const lay = openLayer(el, { anchor: expBtn, width: 440, onClose: () => { if (exportLayer?.el === el) exportLayer = null; } });
    if (lay.toggledOff) { exportLayer = null; return; }
    exportLayer = lay;
    renderExport();
    focusGo();
  }
  // the popover opens with the focus on its main button (Enter exports), never on the close X;
  // openLayer focuses its first button a tick later, so this runs after that
  // mouse Forward re-opens the popover as a new layer (shared/ui.js): take it back as the export
  // popover (else Enter, progress and the focus would not reach it). Runs after ui.js's handler.
  addEventListener("mouseup", (e) => {
    if (e.button !== 4 || !active || exportLayer) return;
    const t = topLayer();
    if (t?.el?.classList.contains("qv-pop")) { exportLayer = t; renderExport(); focusGo(); }
  }, true);
  function focusGo() { setTimeout(() => { if (!isTouch()) $(".qv-go", exportLayer?.el || document.createElement("i"))?.focus({ preventScroll: true }); }, 0); }
  function renderExport() {
    const el = exportLayer?.el;
    if (!el || !doc) return;
    const grab = $(".grab", el);
    const off = instantOff();
    const f = lastForm;
    if (off && f.mode === "instant") f.mode = "exact";
    if (!off && !f.touched) f.mode = "instant";
    const n = P.length;
    const sub = `${n} piece${n === 1 ? "" : "s"} · ${fmtTenth(editDur())} of ${fmtTenth(doc.dur)}`;
    const title = job ? "Exporting…" : "Export video";
    let body = "";
    if (!job) {
      const vt = doc.info?.tracks[doc.info.video], at = doc.info && doc.info.audio >= 0 ? doc.info.tracks[doc.info.audio] : null;
      const sizeMode = f.mode === "exact" && f.size;
      const fp = sizeMode ? fitPlanNow() : null;
      const ext = f.mode === "instant" ? (doc.info?.container === "mov" ? ".mov" : ".mp4") : sizeMode ? EXT[fp.ok ? fp.container : fmtById(f.fitFmt)?.c || "mp4"] : EXT[formatOf(f).c];
      const name = (f.name || "export").replace(/\.(mp4|mov|webm|mkv)$/i, "");
      if (f.mode === "exact" && !sizeMode) probeFormats();
      if (f.mode === "instant" || sizeMode) {
        const key = JSON.stringify(P.map((p) => [p.start, p.end]));
        if (key !== estKey) {
          estKey = key; est = null;
          const id = ++estId;
          estimates.set(id, (m) => { estimates.delete(id); if (id === estId) { est = m; renderExport(); } });
          doc.worker?.postMessage({ op: "estimate", id, pieces: P.flatMap((p) => [p.start, p.end]) });
        }
      }
      const ex = f.mode === "exact" ? exactNumbers(f) : null;
      const estTxt = f.mode === "instant" ? (est ? `≈ ${fmtBytes(est.bytes)} · about ${fmtSecs(est.bytes / 240e6 + 0.3)}` : "…")
        : sizeMode ? (fp.ok ? `≈ ${sizeLbl(fp.bytes)} of ${sizeLbl(f.fitT)} · about ${fmtSecs(encSecs(fp.w, fp.h, fp.v, fp.hw, fp.fps, editDur()))}` : "–")
        : `≈ ${fmtBytes(ex.bytes)} · about ${fmtSecs(ex.secs)}`;
      const tgt = `<div class="row-between">Target<div class="seg fill qv-tgt" role="radiogroup" aria-label="Export target"><button type="button" role="radio" data-tg="q" aria-checked="${!sizeMode}">Quality</button><button type="button" role="radio" data-tg="size" aria-checked="${sizeMode}">File size</button></div></div>`;
      const opts = f.mode === "exact" ? resOptions() : [];
      const u = unfinished[0];
      body = `${u ? `<div class="qv-cont"><span class="t"><b>Unfinished export · ${jobPct(u.j)}%</b><span class="pop-sub">${esc(u.j.name)} · ${esc(u.j.src.name)}</span></span><button class="btn-g sm qv-discard" type="button">Discard</button><button class="btn-p sm qv-continue" type="button">Continue</button></div>` : ""}
        <div class="qv-modes" role="radiogroup" aria-label="Export mode">
          <button class="qv-card" type="button" role="radio" data-mode="instant" aria-checked="${f.mode === "instant"}" aria-disabled="${!!off}" ${off ? `title="${esc(off)}"` : ""}><span class="t">${icon("bolt")}Instant</span></button>
          <button class="qv-card" type="button" role="radio" data-mode="exact" aria-checked="${f.mode === "exact"}"><span class="t">${icon("target")}Exact</span></button>
        </div>
        ${f.mode === "instant"
          ? `<span class="pop-sub">${esc((doc.info?.container || "mp4").toUpperCase())} · ${esc(codecName(vt?.codec))}${at ? ` + ${esc(codecName(at.codec))}` : ""} · ${doc.W}×${doc.H} · same as source</span>`
          : sizeMode ? fitHtml(f, fp, tgt) : `<div class="qv-exact">
              ${tgt}
              <div class="row-between">Format<button class="btn-2 qv-fmtb" type="button" aria-haspopup="menu">${f.fmt === "same" ? `Same as source · ${esc(ex.fmt.label)}` : esc(ex.fmt.label)}${icon("chev", 12)}</button></div>
              ${support.get(supKey(ex.fmt.v)) === false ? `<span class="qv-why">${icon("info", 14)}${esc(ex.fmt.label)} not supported here</span>` : ""}
              <div class="row-between">Resolution<button class="btn-2 qv-resb" type="button" aria-haspopup="menu">${ex.r.w} × ${ex.r.h}${icon("chev", 12)}</button></div>
              <div class="row-between">Quality<div class="seg fill qv-q" role="radiogroup" aria-label="Quality">${QUALITIES.map((k) => `<button type="button" role="radio" data-q="${k}" aria-checked="${f.q === k}">${k}</button>`).join("")}</div></div>
              ${sourceTenBit() && !tenBitOk(ex.fmt) ? `<span class="qv-why qv-warn">${icon("alert", 14)}10-bit → 8-bit${support.get(tenBitKey(ex.fmt, currentRes())) === null ? " (checking…)" : ""}</span>` : ""}
              ${at && (ex.fmt.c === "mov" || ex.fmt.c === "mkv") ? `<label class="switch"><input type="checkbox" class="qv-pcm" ${f.pcm ? "checked" : ""}><span class="track"></span>Lossless audio (PCM)</label>` : ""}
            </div>`}
        <label class="field-label">File name<span class="field"><input class="qv-name" value="${esc(name)}" spellcheck="false" autocomplete="off"><span class="unit">${ext}</span></span></label>
        <div class="row-between">Estimated<span class="v">${estTxt}</span></div>
        <button class="btn-p big qv-go" type="button">${icon("exp")}${f.mode === "instant" ? "Export instantly" : sizeMode ? `Export · max ${sizeLbl(f.fitT)}` : "Export exact"}<span class="kbd desk-only">↵</span></button>
        <button class="btn-g big qv-proj" type="button" title="Save project${kl("saveProject") ? ` (${kl("saveProject")})` : ""}">${icon("download")}Save project</button>`;
      if (opts.length) f.res = Math.min(f.res, opts.length - 1);
    } else {
      const pct = Math.floor(100 * (job.frac || 0));
      body = `<span class="pop-sub">${esc(job.name)} · ${job.mode === "instant" ? "Instant" : "Exact"}${job.est ? ` · ≈ ${fmtBytes(job.est)}` : ""}</span>
        <span class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></span>
        <div class="row-between">${esc(job.stage || "Starting")}<span class="v">${pct}%${job.left != null ? ` · ${fmtSecs(job.left)} left` : " · Estimating…"}</span></div>
        <button class="btn-2 big qv-cancel" type="button">Cancel</button>`;
    }
    // keep the focus (and caret) in a text field across the re-render
    const fcls = ["qv-name", "qv-size"].find((c) => document.activeElement?.classList.contains(c));
    const focused = !!fcls;
    const caret = focused ? document.activeElement.selectionStart : null;
    const goFocused = !!document.activeElement?.classList.contains("qv-go");
    el.innerHTML = `<div class="pop-head"><span class="pop-title">${title}<span class="pop-sub">${sub}</span></span><button class="ib qv-x" type="button" aria-label="Close (Esc or mouse Back)">${icon("x")}</button></div>${body}`;
    if (grab) el.prepend(grab);
    if (focused) { const i = $(`.${fcls}`, el); if (i) { i.focus(); i.setSelectionRange(caret, caret); } }
    else if (goFocused) $(".qv-go", el)?.focus({ preventScroll: true });
    $(".qv-x", el).onclick = () => closeLayer(exportLayer);
    const nm = $(".qv-name", el);
    if (nm) nm.oninput = () => { f.name = nm.value; saveSession(); };
    for (const b of el.querySelectorAll("[data-mode]")) b.onclick = () => { if (b.dataset.mode === "instant" && off) { toast(off, { info: true }); return; } f.mode = b.dataset.mode; f.touched = true; savePrefs(); renderExport(); };
    const fb = $(".qv-fmtb", el);
    if (fb) fb.onclick = () => {
      const cur = formatOf(f);
      const item = (id, label, v) => { const sup = support.get(supKey(v)); return `<button type="button" role="menuitemradio" data-f="${id}" aria-checked="${f.fmt === id}" ${sup === false ? `disabled title="Not supported"` : ""}>${esc(label)}${sup === false ? " · not supported here" : sup == null ? " · checking…" : ""}</button>`; };
      const m = h(`<div class="qv-menu" role="menu">${item("same", `Same as source (${cur && f.fmt === "same" ? cur.label : formatOf({ fmt: "same" }).label})`, formatOf({ fmt: "same" }).v)}${FORMATS.map((x) => item(x.id, x.label, x.v)).join("")}</div>`);
      const lay = openLayer(m, { anchor: fb, width: 300, reopen: false });
      m.onclick = (e) => { const b = e.target.closest("button"); if (!b || b.disabled) return; f.fmt = b.dataset.f; savePrefs(); closeLayer(lay, { remember: false }); renderExport(); };
    };
    const pc = $(".qv-pcm", el);
    if (pc) pc.onchange = () => { f.pcm = pc.checked; savePrefs(); renderExport(); };
    for (const b of el.querySelectorAll("[data-q]")) b.onclick = () => { f.q = b.dataset.q; savePrefs(); renderExport(); };
    const rb = $(".qv-resb", el);
    if (rb) rb.onclick = () => {
      const m = h(`<div class="qv-menu" role="menu">${resOptions().map((r, i) => `<button type="button" role="menuitemradio" data-i="${i}" aria-checked="${i === f.res}">${r.w} × ${r.h}${i === 0 ? " · full" : ""}</button>`).join("")}</div>`);
      const lay = openLayer(m, { anchor: rb, width: 200, reopen: false });
      m.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; f.res = +b.dataset.i; closeLayer(lay, { remember: false }); probeFormats(); renderExport(); };
    };
    bindFit(el, f);
    const go = $(".qv-go", el);
    if (go) go.onclick = startExport;
    const proj = $(".qv-proj", el);
    if (proj) proj.onclick = () => saveProject();
    const cancel = $(".qv-cancel", el);
    if (cancel) cancel.onclick = cancelExport;
    const cont = $(".qv-continue", el);
    if (cont) cont.onclick = () => continueJob(unfinished[0].id);
    const disc = $(".qv-discard", el);
    if (disc) disc.onclick = () => discardJob(unfinished[0].id);
  }
  // the File size settings: presets, a custom size, the format and the predicted result
  function fitHtml(f, fp, tgt) {
    const custom = f.fitRaw ?? (FIT_PRESETS.includes(f.fitT) ? "" : String(+(f.fitT / (f.fitUnit === "GB" ? 1e9 : 1e6)).toFixed(3) * 1));
    const fx = f.fitFmt === "auto" ? null : fmtById(f.fitFmt);
    const fmtTxt = fx ? fx.label : `Auto${fp.ok ? ` · ${fp.container.toUpperCase()} · ${codecName(fp.v)}` : " · best compression"}`;
    let pred;
    if (fp.ok) {
      const a = fp.audio;
      const aTxt = !a ? "" : a.copy ? ` · ${fmtRate(a.bps)} audio (original)` : ` · ${fmtRate(a.bps)} ${codecName(a.codec)}${a.channels === 1 ? " mono" : ""}`;
      pred = `<div class="qv-pred">
          <div class="row-between">Result<span class="v">${fp.w} × ${fp.h} · ${fmtFps(fp.fps)} fps · ${codecName(fp.v)}</span></div>
          <div class="row-between">Bit rate<span class="v">${fmtRate(fp.vbps)} video${aTxt}</span></div>
          <div class="row-between">Quality<span class="v qv-tier" data-tier="${fp.tier}">${fp.tier}</span></div>
        </div>
`;
    } else if (fp.pending) pred = `<span class="qv-why">${icon("info", 14)}${fp.probing ? "Measuring…" : "Checking…"}</span>`;
    else if (fp.minBytes) pred = `<div class="qv-cont qv-imp"><span class="t"><b>Too small</b><span class="pop-sub">Min ${sizeLbl(fp.minBytes)}</span></span><button class="btn-2 sm qv-usemin" type="button" data-b="${fp.minBytes}">Use ${sizeLbl(fp.minBytes)}</button></div>`;
    else pred = `<span class="qv-why qv-warn">${icon("alert", 14)}${fx ? `${esc(fx.label)}: not supported here` : "Can't encode here"}</span>`;
    const inst = instantFits() ? `<div class="qv-cont"><span class="t"><b>Instant fits</b><span class="pop-sub">≈ ${sizeLbl(est.bytes)}</span></span><button class="btn-p sm qv-useinst" type="button">Use Instant</button></div>` : "";
    return `<div class="qv-exact">
        ${tgt}
        <div class="qv-sizes" role="radiogroup" aria-label="Maximum file size">${FIT_PRESETS.map((b) => `<button type="button" role="radio" data-sz="${b}" aria-checked="${f.fitT === b && !f.fitRaw}">${sizeLbl(b)}</button>`).join("")}</div>
        <div class="row-between">Custom<span class="field qv-szf"><input class="qv-size" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="Custom maximum size" placeholder="Size" value="${esc(custom)}"><span class="seg qv-unit" role="radiogroup" aria-label="Unit">${["MB", "GB"].map((u) => `<button type="button" role="radio" data-u="${u}" aria-checked="${f.fitUnit === u}">${u}</button>`).join("")}</span></span></div>
        <div class="row-between">Format<button class="btn-2 qv-ffmt" type="button" aria-haspopup="menu">${esc(fmtTxt)}${icon("chev", 12)}</button></div>
        ${inst}${pred}
      </div>`;
  }
  function bindFit(el, f) {
    for (const b of el.querySelectorAll("[data-tg]")) b.onclick = () => { f.size = b.dataset.tg === "size"; savePrefs(); renderExport(); };
    for (const b of el.querySelectorAll("[data-sz]")) b.onclick = () => { f.fitT = +b.dataset.sz; f.fitRaw = undefined; f.fitUnit = f.fitT >= 1e9 ? "GB" : "MB"; savePrefs(); renderExport(); };
    const unitOf = () => (f.fitUnit === "GB" ? 1e9 : 1e6);
    const fromRaw = () => { const n = parseFloat(String(f.fitRaw || "").replace(",", ".")); if (n > 0 && n * unitOf() >= 0.1e6) f.fitT = Math.round(n * unitOf()); };
    const inp = $(".qv-size", el);
    if (inp) inp.oninput = () => { f.fitRaw = inp.value; fromRaw(); savePrefs(); renderExport(); };
    for (const b of el.querySelectorAll("[data-u]")) b.onclick = () => { f.fitUnit = b.dataset.u; if (f.fitRaw) fromRaw(); savePrefs(); renderExport(); };
    const um = $(".qv-usemin", el);
    if (um) um.onclick = () => { f.fitT = +um.dataset.b; f.fitRaw = undefined; f.fitUnit = f.fitT >= 1e9 ? "GB" : "MB"; savePrefs(); renderExport(); };
    const ui = $(".qv-useinst", el);
    if (ui) ui.onclick = () => { f.mode = "instant"; f.touched = true; savePrefs(); renderExport(); };
    const fb = $(".qv-ffmt", el);
    if (fb) fb.onclick = () => {
      const m = h(`<div class="qv-menu" role="menu"><button type="button" role="menuitemradio" data-f="auto" aria-checked="${f.fitFmt === "auto"}">Auto · best compression</button>${FORMATS.map((x) => `<button type="button" role="menuitemradio" data-f="${x.id}" aria-checked="${f.fitFmt === x.id}">${esc(x.label)}</button>`).join("")}</div>`);
      const lay = openLayer(m, { anchor: fb, width: 300, reopen: false });
      m.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; f.fitFmt = b.dataset.f; savePrefs(); closeLayer(lay, { remember: false }); renderExport(); };
    };
  }
  const codecName = (c) => ({ h264: "H.264", hevc: "HEVC", aac: "AAC", opus: "Opus", vp9: "VP9", av1: "AV1", mp3: "MP3" })[c] || (c || "").toUpperCase();
  const fmtSecs = (s) => (s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);
  async function jobFile(j) {
    if (!j) return null;
    if (j.blob) return j.blob;
    try { return await j.handle.getFile(); } catch { toast("The saved file can't be read any more.", { bad: true }); return null; }
  }

  // output: the save dialog first (it needs the click), then bytes streamed into the file;
  // without the File System Access API, an Exact export streams into the origin's private
  // storage (OPFS) and is downloaded from there; an Instant export is downloaded straight from a
  // Blob made of slices of the source file (nothing is copied into memory)
  class Out {
    constructor(writable) { this.w = writable; this.p = Promise.resolve(); this.chunks = []; this.end = 0; this.err = null; }
    push(pos, data) {
      if (this.w) { this.p = this.p.then(() => this.w.write({ type: "write", position: pos, data })).catch((e) => { this.err ||= e; }); this.end = Math.max(this.end, pos + data.length); return; }
      if (pos >= this.end) { this.chunks.push({ pos, data }); this.end = pos + data.length; return; }
      // an overwrite of bytes already written (sizes patched at the end)
      for (const c of this.chunks) {
        const a = Math.max(pos, c.pos), b = Math.min(pos + data.length, c.pos + c.data.length);
        if (a < b) c.data.set(data.subarray(a - pos, b - pos), a - c.pos);
      }
      if (pos + data.length > this.end) { const from = this.end - pos; this.chunks.push({ pos: this.end, data: data.slice(from) }); this.end = pos + data.length; }
    }
    async close() { if (this.w) { await this.p; if (this.err) throw this.err; await this.w.close(); return null; } return new Blob(this.chunks.map((c) => c.data), { type: "video/mp4" }); }
    async abort() { try { await this.p; await this.w?.abort(); } catch {} }
  }

  async function saveTarget(name, mime, ext) {
    if (window.showSaveFilePicker) {
      try {
        const handle = await showSaveFilePicker({ suggestedName: name, types: [{ description: "Video", accept: { [mime]: [ext] } }] });
        return { handle, writable: await handle.createWritable(), name: handle.name };
      } catch (e) { if (e.name === "AbortError") return null; }
    }
    return { handle: null, writable: null, name };
  }
  async function tempTarget(ext) {
    try {
      const dir = await navigator.storage.getDirectory();
      const handle = await dir.getFileHandle(`qcv-out-${Date.now()}${ext}`, { create: true });
      return { handle, writable: await handle.createWritable(), temp: true };
    } catch { return { handle: null, writable: null, temp: false }; }
  }
  const probeAsk = (msg, op) => new Promise((res, rej) => {
    const w = doc.worker, id = Math.random();
    const hnd = (e) => { const m = e.data; if (m.op === op && m.id === id) { w.removeEventListener("message", hnd); res(m); } else if (m.op === "error" && m.what === msg.op) { w.removeEventListener("message", hnd); rej(new Error(m.why)); } };
    w.addEventListener("message", hnd);
    w.postMessage({ ...msg, id, file: doc.file });
  });
  // the output's time base: one where every output frame lasts a whole number of ticks
  // (59.94 = 60000/1001 needs 60000, not 90000; a 0.5× piece doubles the frame duration)
  const timescaleFor = (fps) => {
    // frame rates are rounded in files (59.94006…): snap to the NTSC family first
    const ntsc = Math.abs(fps * 1.001 - Math.round(fps * 1.001)) < 0.005;
    const f = ntsc ? Math.round(fps * 1.001) / 1.001 : Math.abs(fps - Math.round(fps)) < 0.005 ? Math.round(fps) : fps;
    const d2 = [...new Set(P.map((p) => 1 / (f * p.speed)))];
    for (const ts of [60000, 90000, 48000, 120000, 30000, 24000, 96000]) if (d2.every((d) => Math.abs(ts * d - Math.round(ts * d)) < 1e-6)) return ts;
    return 90000;
  };
  const sourceTenBit = () => isTenBit(doc.info?.tracks[doc.info.video]?.codecString);
  // can this export keep 10 bits? (an encoder for it, and no rotation/scaling: the 2D canvas is 8-bit)
  const tenBitKey = (fmt, r) => `10@${fmt.v}@${r.w}x${r.h}`;
  function tenBitOk(fmt) {
    const c = cropPx(), r = currentRes();
    const upright = same(c.A, I2);
    if (!upright || r.w !== c.w || r.h !== c.h) return false;
    const k = tenBitKey(fmt, r);
    if (!support.has(k)) { support.set(k, null); encoderConfig(fmt.v, r.w, r.h, doc.fps, bitrateFor(fmt.v, "Balanced", r.w, r.h, doc.fps), { tenBit: true }).then((x) => { support.set(k, !!x); if (exportLayer) renderExport(); }); }
    return support.get(k) === true;
  }

  async function startExport(opts = {}) {
    if (job || !doc) return;
    const step = opts.step || 0;
    const f = lastForm;
    const off = instantOff();
    const mode = f.mode === "instant" && !off ? "instant" : "exact";
    let fp = mode === "exact" && f.size ? fitPlanNow(step) : null;
    // a step down needs the new size checked against the encoders first: wait for it
    for (let n = 0; step && fp && fp.pending && n < 60; n++) { await new Promise((r) => setTimeout(r, 500)); fp = fitPlanNow(step); }
    if (fp && !fp.ok && fp.floor) { toast(opts.err || "Choose a larger size.", { bad: true, ms: 6000 }); if (opts.tgt) removeOut(opts.tgt.handle); renderExport(); updateExpBtn(); refreshJobs(); return; }
    if (fp && !fp.ok) { toast(fp.pending ? "Still checking what this browser can encode. Try again in a moment." : fp.minBytes ? `${sizeLbl(f.fitT)} is too small for this edit. About ${sizeLbl(fp.minBytes)} is the smallest that works.` : "This browser can't encode video here. Pick another format.", { bad: true }); return; }
    const fmt = mode === "exact" ? (fp ? { c: fp.container, v: fp.v } : formatOf(f)) : null;
    if (fmt && !fp && support.get(supKey(fmt.v)) === false) { toast(`${fmt.label} isn't supported by this browser/GPU. Pick another format.`, { bad: true }); return; }
    const ext = mode === "instant" ? (doc.info?.container === "mov" ? ".mov" : ".mp4") : EXT[fmt.c];
    const name0 = `${(f.name || "export").trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\.(mp4|mov|webm|mkv)$/i, "") || "export"}${ext}`;
    const mime = MIME[mode === "instant" ? (ext === ".mov" ? "mov" : "mp4") : fmt.c];
    const tgt = opts.tgt || await saveTarget(name0, mime, ext);
    if (!tgt || !doc) return;
    if (step && fp) toast(`${fp.w} × ${fp.h}`, { info: true, ms: 4000 });
    if (mode === "instant") return instantExport(tgt, mime);
    await jobs.cleanup({ all: true }); // a new export replaces any unfinished one
    const ex = exactNumbers(f);
    const c = cropPx();
    const vt = doc.info?.tracks[doc.info.video];
    let tenBit = !fp && sourceTenBit() && tenBitOk(fmt);
    // size target: 10 bits when the output keeps the source's size and orientation (no canvas)
    if (fp && sourceTenBit() && same(c.A, I2) && fp.w === c.w && fp.h === c.h) tenBit = !!(await encoderConfig(fp.v, fp.w, fp.h, fp.fps, fp.vbps, { tenBit: true }));
    const dur = editDur();
    const fit = fp ? {
      outW: fp.w, outH: fp.h, container: fp.container, vcodec: fp.v, bitrate: fp.vbps, pcm: false, fps: fp.fps, capFps: fp.half, timescale: timescaleFor(fp.fps),
      segSecs: 5, keyInt: 5, rateMode: window.__qcFitMode || "constant",
      fit: { target: f.fitT, margin: MARGIN, over: fp.over, aEst: fp.audio ? (fp.audio.bps * dur) / 8 : 0, vmax: fp.capped ? (fp.vbps * dur) / 8 : 0, cap: fp.cap * 2.5, min: 30e3, pred: fp.bytes },
      afit: !fp.audio ? null : fp.audio.copy ? { copy: true } : { codec: fp.audio.codec, bitrate: fp.audio.bitrate, channels: fp.audio.channels, frameMs: fp.audio.frameMs || 20 },
    } : {};
    const J = {
      v: 1, id: jobs.newId(), created: Date.now(), state: "running", name: tgt.name, step,
      src: { name: doc.file.name, size: doc.file.size, lastModified: doc.file.lastModified },
      C, s: {
        pieces: P.map((p) => ({ start: p.start, end: p.end, speed: p.speed, volume: p.volume })), A: c.A, crop: c.crop, outW: ex.r.w, outH: ex.r.h,
        container: fmt.c, vcodec: fmt.v, bitrate: ex.bitrate, pcm: !!f.pcm && (fmt.c === "mov" || fmt.c === "mkv"), fps: doc.fps, timescale: timescaleFor(doc.fps), tenBit, software: !!window.__qcForceSoftware,
        ...fit,
      },
      done: {},
    };
    let t = tgt;
    if (!t.writable) t = { ...(await tempTarget(ext)), name: tgt.name };
    await jobs.setHandles(J.id, { src: doc.handle || null, out: t.temp ? null : t.handle });
    try { await jobs.save(J); } catch (e) { toast(`Couldn't start the export: ${e.message || e}`, { bad: true }); return; }
    runJob(J, t);
  }

  // Instant: Rust plans the cut (moov first, final offsets); the bytes go straight from slices of
  // the source file into the output, 64 MB per write
  async function instantExport(t, mime) {
    const me = job = { state: "busy", mode: "instant", name: t.name, handle: t.handle, temp: false, out: null, t0: performance.now(), frac: 0, stage: "Planning", left: null, est: est?.bytes };
    renderExport(); updateExpBtn();
    try {
      const L = await probeAsk({ op: "layout", pieces: P.flatMap((p) => [p.start, p.end]) }, "layout");
      if (job !== me) return;
      const file = doc.file, runs = L.runs;
      me.stage = "Copying";
      if (t.writable) {
        // the save dialog's writable isn't needed: the copy worker opens its own on the handle
        await t.writable.abort().catch(() => {});
        const w = me.worker = new Worker(WORKER_URL, { type: "module" });
        let tick = 0;
        await new Promise((res, rej) => {
          w.onmessage = (e) => {
            const m = e.data;
            if (m.op === "progress") {
              me.frac = m.done / Math.max(1, m.total); me.stage = m.stage;
              const now = performance.now(), el = (now - me.t0) / 1000;
              me.left = me.frac > 0.02 ? (el * (1 - me.frac)) / me.frac : null;
              if (now - tick > 120) { tick = now; renderExport(); updateExpBtn(); }
            } else if (m.op === "done") res();
            else if (m.op === "error") rej(new Error(m.why));
          };
          w.onerror = (e) => rej(new Error(e.message || "the copy failed"));
          w.postMessage({ op: "copy", file, handle: t.handle, head: L.head, runs, size: L.size }, [L.head.buffer, runs.buffer]);
        });
        w.terminate();
        if (job !== me) return;
        finished(me, { bytes: L.size, dur: L.dur });
      } else {
        const parts = [L.head];
        for (let k = 0; k < runs.length; k += 2) parts.push(file.slice(runs[k], runs[k] + runs[k + 1]));
        me.blob = new Blob(parts, { type: mime });
        download(me.blob, me.name);
        finished(me, { bytes: me.blob.size, dur: L.dur });
      }
    } catch (err) { fail(me, err); }
  }

  /** Run (or continue) an Exact job into the target `t` ({handle, writable, temp, name}). */
  function runJob(J, t) {
    const me = job = { state: "busy", mode: "exact", name: t.name, handle: t.handle, temp: !!t.temp, out: new Out(t.writable), t0: performance.now(), frac: 0, stage: "Starting", left: null, est: J.s.fit ? J.s.fit.pred : (J.s.bitrate / 8) * editDur(), jid: J.id, fitT: J.s.fit?.target || 0 };
    renderExport(); updateExpBtn();
    let tick = 0;
    const r = runExact({
      j: J, file: doc.file, probe: doc.worker, out: me.out, workerUrl: WORKER_URL, hasAudio: !!(doc.info && doc.info.audio >= 0), workers: window.__qcWorkers || 0, save: jobs.save,
      onProgress: (p) => {
        if (job !== me) return;
        me.frac = p.frac; me.stage = p.stage; me.left = p.left; me.fps = p.fps;
        const now = performance.now();
        if (now - tick > 150) { tick = now; renderExport(); updateExpBtn(); }
      },
    });
    me.cancelJob = r.cancel;
    r.promise.then(async (res) => {
      if (job !== me) return;
      try {
        const blob = await me.out.close();
        jobs.remove(J.id);
        finished(me, { ...res, blob });
      } catch (err) { fail(me, err); }
    }, (err) => {
      if (job !== me || /cancelled/.test(err?.message)) return;
      if (err?.floor && J.s.fit && (J.step || 0) < 4) { retryLower(me, J, t, err); return; }
      fail(me, err, { keepJob: /storage is full/i.test(err?.message || "") ? J.id : null });
    });
  }

  /** The size can't be reached at this output size: the same export one size down (never asks for a new file). */
  async function retryLower(me, J, t, err) {
    me.cancelJob?.();
    await me.out?.abort();
    try { await me.writable?.abort(); } catch {}
    await jobs.remove(J.id);
    let t2 = { handle: null, writable: null, name: t.name };
    try {
      if (t.temp) { await removeOut(t.handle); t2 = { ...(await tempTarget(EXT[J.s.container])), name: t.name }; }
      else if (t.handle) t2 = { handle: t.handle, writable: await t.handle.createWritable(), name: t.name };
    } catch {}
    job = null;
    await startExport({ step: (J.step || 0) + 1, tgt: t2, err: err.message });
  }

  /** The export is done: close the popover, show the corner card. */
  async function finished(me, res) {
    let blob = res.blob || me.blob || null;
    if (me.temp) {
      // the OPFS copy: download it, then delete it once the download has had time to read it
      blob = await me.handle.getFile();
      download(blob, me.name);
      const h = me.handle;
      setTimeout(async () => { try { await h.remove(); } catch { try { await (await navigator.storage.getDirectory()).removeEntry(h.name); } catch {} } }, Math.max(60e3, blob.size / 50e3));
    }
    me.secs = (performance.now() - me.t0) / 1000;
    me.bytes = blob ? blob.size : res.bytes;
    me.blob = blob;
    me.state = "done";
    stats.lastExport = { mode: me.mode, secs: me.secs, bytes: me.bytes, dur: res.dur, frames: res.frames, stats: res.stats, fitT: me.fitT || 0 };
    job = null;
    lastDone = me;
    if (exportLayer) closeLayer(exportLayer, { remember: false });
    updateExpBtn();
    doneCard({
      title: `Saved · ${me.fitT ? `${sizeLbl(me.bytes)} (max ${sizeLbl(me.fitT)})` : fmtBytes(me.bytes)} · ${me.secs < 10 ? me.secs.toFixed(1) : Math.round(me.secs)} s`, file: me.name, ms: 7000,
      actions: [
        { label: "Download again", icon: "download", run: async () => { const b = await jobFile(me); if (b) download(b, me.name); } },
        { label: "Open", icon: "external", run: async () => { const b = await jobFile(me); if (b) { const u = URL.createObjectURL(b); window.open(u, "_blank", "noopener"); setTimeout(() => URL.revokeObjectURL(u), 120_000); } } },
      ],
    });
  }
  let lastDone = null;
  // delete the (unfinished) output; a stopped worker may hold it open for a moment
  async function removeOut(hd) {
    if (!hd?.remove) return;
    for (let k = 0; k < 8; k++) { try { await hd.remove(); return; } catch (e) { if (e?.name === "NotFoundError") return; await new Promise((r) => setTimeout(r, 150 * (k + 1))); } }
  }
  async function fail(me, err, { keepJob = null } = {}) {
    if (job !== me) return;
    me.cancelJob?.();
    me.worker?.terminate();
    await me.out?.abort();
    try { await me.writable?.abort(); } catch {}
    await removeOut(me.handle);
    if (me.jid && me.jid !== keepJob) await jobs.remove(me.jid); // (before the list is read again: no "Unfinished" card for a job that failed)
    job = null;
    toast(`Couldn't export: ${err.message || err}`, { bad: true, ms: 6000 });
    renderExport();
    updateExpBtn();
    refreshJobs();
  }
  async function cancelExport() {
    const me = job;
    if (!me || me.state !== "busy") return;
    me.cancelJob?.();
    me.worker?.terminate();
    job = null;
    renderExport();
    updateExpBtn();
    await me.out?.abort();
    try { await me.writable?.abort(); } catch {}
    await removeOut(me.handle);
    if (me.jid) await jobs.remove(me.jid);
  }

  // ── unfinished Exact exports: "Continue export" ─────────────────────────────
  let unfinished = []; // [{id, j}]
  const jobPct = (j) => (j.plan ? Math.floor((100 * Object.values(j.done || {}).reduce((a, d) => a + d.frames, 0)) / Math.max(1, j.plan.frames)) : 0);
  async function refreshJobs() {
    unfinished = (await jobs.list()).filter((x) => x.j && x.j.v === 1 && x.id !== job?.jid);
    renderJobCard();
    if (exportLayer) renderExport();
  }
  const jobBox = h(`<div class="resume-box qv-jobbox" hidden></div>`);
  empty.insertBefore(jobBox, empty.firstChild);
  function renderJobCard() {
    const u = unfinished[0];
    jobBox.hidden = !u;
    jobBox.replaceChildren();
    if (!u) return;
    const b = h(`<div class="resume"><button class="resume-go" type="button"><span class="thumb qv-jobthumb">${icon("exp", 22)}</span><span class="meta"><span class="k">Unfinished export</span><span class="name"></span><span class="sub"></span></span><span class="cta">Continue export ${icon("chevR", 14)}</span></button><button class="ib sm resume-x" type="button" aria-label="Discard this export" title="Discard (deletes its finished parts)">${icon("x", 14)}</button></div>`);
    $(".name", b).textContent = u.j.name;
    $(".sub", b).textContent = `${jobPct(u.j)}% done · ${u.j.src.name} · ${fmtAgo(u.j.updated || u.j.created)}`;
    $(".resume-go", b).onclick = () => continueJob(u.id);
    $(".resume-x", b).onclick = () => discardJob(u.id);
    jobBox.append(b);
  }
  async function discardJob(id) { await jobs.remove(id); refreshJobs(); toast("Discarded"); }
  async function continueJob(id) {
    if (job) { toast("Export running", { bad: true }); return; }
    const u = unfinished.find((x) => x.id === id);
    if (!u) { refreshJobs(); return; }
    const j = u.j, hs = await jobs.handles(id);
    // the source: its handle (asks for permission), else the same file chosen again
    let file = null, fh = hs.src || null;
    const isSame = (x) => x && x.name === j.src.name && x.size === j.src.size;
    if (doc && isSame(doc.file)) { file = doc.file; fh = doc.handle; }
    if (!file && fh) {
      try {
        if ((await fh.queryPermission?.({ mode: "read" })) === "granted" || (await fh.requestPermission?.({ mode: "read" })) === "granted") file = await fh.getFile();
      } catch {}
      if (!isSame(file)) file = null;
    }
    if (!file) {
      toast(`Choose ${j.src.name} again to continue the export.`, { ms: 5000, info: true });
      const got = await pickFiles({ accept: "video/*,.mkv,.mov", types: VIDEO_TYPES });
      if (!got[0]) return;
      if (!isSame(got[0].file)) { toast(`That isn't ${j.src.name} (${fmtBytes(j.src.size)}). Choose the same file.`, { bad: true, ms: 5000 }); return; }
      file = got[0].file; fh = got[0].handle || null;
    }
    // the output: the same file (asks for permission), else a new save dialog
    let t = null;
    if (hs.out) {
      try {
        if ((await hs.out.queryPermission?.({ mode: "readwrite" })) === "granted" || (await hs.out.requestPermission?.({ mode: "readwrite" })) === "granted") t = { handle: hs.out, writable: await hs.out.createWritable(), name: hs.out.name };
      } catch { t = null; }
    }
    if (!t) {
      const ext = EXT[j.s.container], mime = MIME[j.s.container];
      t = await saveTarget(j.name, mime, ext);
      if (!t) return;
      if (!t.writable) t = { ...(await tempTarget(ext)), name: t.name };
    }
    if (!doc || doc.file !== file) {
      await openFile(file, fh || undefined, { P: j.s.pieces, C: j.C, name: baseName(j.name) });
      if (!doc || doc.file !== file) return;
    }
    await jobs.setHandles(id, { src: fh || hs.src || null, out: t.temp ? null : t.handle });
    unfinished = unfinished.filter((x) => x.id !== id);
    renderJobCard();
    runJob(j, t);
  }
  jobs.cleanup().then(refreshJobs); // leftovers older than 3 days / storage use high

  // closing the popover keeps the export going: the Export button shows its progress
  function updateExpBtn() {
    const busy = job?.state === "busy";
    const pct = busy ? Math.floor(100 * job.frac) : 0;
    let tag = expBtn.querySelector(".qv-pct");
    if (busy && !tag) { tag = h(`<span class="qv-pct mono"></span>`); expBtn.append(tag); }
    if (tag) { if (busy) tag.textContent = `${pct}%`; else tag.remove(); }
    expBtn.querySelector(".kbd")?.toggleAttribute("hidden", busy);
  }

  // ── buttons and keys ─────────────────────────────────────────────────────
  ed.addEventListener("click", (e) => {
    const b = e.target.closest("[data-a]");
    if (!b || b.disabled) return;
    switch (b.dataset.a) {
      case "undo": undo(); break;
      case "redo": redo(); break;
      case "crop": cropping ? leaveCrop(true) : enterCrop(); break;
      case "cropCancel": leaveCrop(false); break;
      case "cropApply": leaveCrop(true); break;
      case "export": openExport(); break;
      case "play": togglePlay(); break;
      case "back1": step(-1); break;
      case "fwd1": step(1); break;
      case "loop": toggleLoop(); break;
      case "mute": toggleMute(); break;
      case "split": split(); break;
      case "delete": del(); break;
      case "svSheet": pieceDock.openSheet(); renderSV(); break;
      case "zout": setPps(pps / 1.25, clamp(xOf(tl), 0, W)); break;
      case "zin": setPps(pps * 1.25, clamp(xOf(tl), 0, W)); break;
      case "fit": zoomFit(); break;
      case "snap": toggleSnap(); break;
      case "keys": K.openSheet(); break;
    }
  });
  function toggleSnap() {
    snapOn = !snapOn;
    for (const b of document.querySelectorAll(".qv-snap")) { b.setAttribute("aria-pressed", String(snapOn)); b.classList.toggle("on", snapOn); }
    savePrefs();
  }
  function toggleLoop() { loopOn = !loopOn; loopBtn.setAttribute("aria-pressed", String(loopOn)); if (playing) prepareNext(); savePrefs(); }
  function toggleMute() {
    muted = !muted;
    const b = btn("mute");
    b.innerHTML = icon(muted ? "mute" : "vol");
    b.setAttribute("aria-pressed", String(muted));
    const p = playing ? P[pi] : segAt(tl).p;
    setVol(vA(), p); vB().muted = true;
    savePrefs();
  }
  // what each action of the SHORTCUTS table does
  ACT = {
    play: () => togglePlay(),
    shuttleBack: () => shuttleKey("j"),
    stop: () => shuttleKey("k"),
    shuttleFwd: () => shuttleKey("l"),
    prevFrame: () => { stopReverse(); step(-1); },
    nextFrame: () => { stopReverse(); step(1); },
    back1s: () => { stopReverse(); pause(); seekTl(tl - 1, true); follow(); },
    fwd1s: () => { stopReverse(); pause(); seekTl(tl + 1, true); follow(); },
    prevCut: () => jumpCut(-1),
    nextCut: () => jumpCut(1),
    home: () => { pause(); seekTl(L.inT, true); follow(); },
    end: () => { pause(); seekTl(L.outT - 0.5 / doc.fps, true); follow(); },
    split: () => split(),
    delete: () => del(),
    selectAll: () => { selIds = P.map((p) => p.id); changed(); },
    deselect: () => { if (!selIds.length) return false; selIds = []; changed(); },
    slower: () => nudgeSpeed(-1),
    faster: () => nudgeSpeed(1),
    undo: () => undo(),
    redo: () => redo(),
    zoomIn: () => setPps(pps * 1.25, clamp(xOf(tl), 0, W)),
    zoomOut: () => setPps(pps / 1.25, clamp(xOf(tl), 0, W)),
    zoomFit: () => zoomFit(),
    snap: () => toggleSnap(),
    crop: () => (cropping ? leaveCrop(true) : enterCrop()),
    mute: () => toggleMute(),
    loop: () => toggleLoop(),
    export: () => openExport(),
    open: () => choose(),
    saveProject: () => saveProject(),
    keys: () => K.openSheet(),
  };
  // Keys go to the editor whenever the Video tab is shown and the focus is not in a text field
  // (a focused slider, button or the page itself all count as "not typing"). Every handled key
  // is preventDefault-ed so the browser never acts on it (Ctrl+E would focus its search bar).
  document.addEventListener("keydown", (e) => {
    if (!active || e.defaultPrevented) return;
    const k = e.key, m = K.match(e);
    // Export: also from a text field (it is no text-editing key)
    if (m?.a.id === "export") { e.preventDefault(); if (doc && !ed.hidden) openExport(); return; }
    if (m?.a.id === "keys" && !topLayer()) { e.preventDefault(); K.openSheet(); return; }
    if (m?.a.id === "open" && !topLayer() && !typing(e.target)) { e.preventDefault(); if (!job) choose(); return; }
    if (!doc || ed.hidden || typing(e.target) && !(e.key === "Enter" && (e.target.classList.contains("qv-name") || e.target.classList.contains("qv-size")))) return;
    // a focused slider keeps its own arrows / Home / End; every other key is the editor's
    if (e.target?.type === "range" && !mod(e) && /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(k)) return;
    const layer = topLayer();
    if (layer) {
      if (k === "Enter" && layer === exportLayer && !job) { e.preventDefault(); startExport(); }
      return;
    }
    if (cropping && !mod(e) && !e.altKey) {
      if (k === "Enter") { e.preventDefault(); leaveCrop(true); return; }
      if (k === "Escape") { e.preventDefault(); leaveCrop(false); return; }
    }
    // Enter on a focused button presses it (the browser's own behaviour)
    if (!m || (k === "Enter" && e.target?.tagName === "BUTTON")) return;
    K.dispatch(e);
  });
  // any other action (a key that is not Ctrl+Z, a press anywhere but on Undo, a wheel turn) ends "just opened"
  addEventListener("keydown", (e) => {
    if (!justOpened || /^(Control|Shift|Alt|Meta)$/.test(e.key)) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyZ") return;
    clearJustOpened();
  }, true);
  addEventListener("pointerdown", (e) => { if (justOpened && !e.target.closest?.('[data-a="undo"]')) clearJustOpened(); }, true);
  addEventListener("wheel", () => clearJustOpened(), { capture: true, passive: true });
  // labels built by hand follow the user's keys
  const KACT = { undo: "undo", redo: "redo", crop: "crop", export: "export", play: "play", back1: "prevFrame", fwd1: "nextFrame", loop: "loop", mute: "mute", split: "split", delete: "delete", snap: "snap", zout: "zoomOut", zin: "zoomIn", fit: "zoomFit", keys: "keys" };
  for (const [a, id] of Object.entries(KACT)) for (const el of ed.querySelectorAll(`[data-a="${a}"]`)) { el.dataset.kact = id; for (const kb of el.querySelectorAll(".kbd")) kb.dataset.kact = id; }
  const keyLabels = () => K.refresh(ed);
  K.onChange(keyLabels);

  // ── fallback thumbnails (no WebCodecs for this codec): seek a hidden <video> ──
  let fbVideo = null, fbBusy = false, fbQueue = [];
  function fallbackThumbs() {
    if (!doc || fbVideo) return;
    if (!doc.keys) { const n = Math.max(2, Math.ceil(doc.dur / 2)); doc.keys = Float64Array.from({ length: n }, (_, i) => (i * doc.dur) / n); }
    fbVideo = document.createElement("video");
    fbVideo.muted = true; fbVideo.preload = "auto"; fbVideo.src = doc.url;
    lastThumbAsk = "";
    draw();
    if (doc.info && doc.info.audio >= 0) doc.worker?.postMessage({ op: "wave" });
  }
  function fbAsk(list) { fbQueue = list.slice(0, 60); fbPump(); }
  async function fbPump() {
    if (fbBusy || !fbVideo) return;
    fbBusy = true;
    const v = fbVideo, d = doc;
    try {
      if (v.readyState < 1) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
      while (fbQueue.length && doc === d && fbVideo === v) {
        const k = fbQueue.shift();
        if (thumbs.has(k)) continue;
        v.currentTime = d.keys[k] + 0.001;
        await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
        const hh = Math.round((G.thumbH - 4) * (devicePixelRatio || 1));
        const bmp = await createImageBitmap(v, { resizeHeight: hh, resizeWidth: Math.round((hh * v.videoWidth) / v.videoHeight), resizeQuality: "low" });
        if (doc !== d) { bmp.close(); break; }
        addThumb(k, bmp);
        draw();
      }
    } catch {}
    fbBusy = false;
  }

  loopBtn.setAttribute("aria-pressed", String(loopOn));
  for (const b of document.querySelectorAll(".qv-snap")) b.setAttribute("aria-pressed", String(snapOn));
  if (muted) { btn("mute").innerHTML = icon("mute"); btn("mute").setAttribute("aria-pressed", "true"); }

  // ── tool contract ────────────────────────────────────────────────────────
  return {
    openProject: (file, handle) => openAny(file, handle),
    show() { active = true; measure(); if (ed.hidden) showRecents(); },
    hide() { active = false; stopReverse(); pause(); hideHover(); },
    back() { if (cropping) { leaveCrop(false); return true; } return false; },
  };
}
