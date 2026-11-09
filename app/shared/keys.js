// QuickCut keyboard registry: every tool registers its actions here; one dispatcher runs them; the
// user can change any key in the ? sheet and the choice is remembered.
//
//   import { createKeys } from "../shared/keys.js";
//   const K = createKeys({ id: "photo", title: "Photo" });
//   K.add({ id: "undo", label: "Undo", group: "Edit", keys: "Ctrl+Z", run: (e, combo) => undo() });
//     keys: "Ctrl+Shift+Z|Ctrl+Y" (alternatives split by "|") or an array. Combos are written
//       Ctrl+Alt+Shift+Key (Ctrl = Cmd on a Mac); Key is A-Z, 0-9, F1-F12, Space, Enter, Esc, Tab,
//       Delete, Backspace, Home, End, PageUp, PageDown, Left/Right/Up/Down or a punctuation key.
//       Letters follow the keyboard layout, everything else is the physical key.
//     when(e): extra condition (the first action of a combo whose when() holds runs).
//     ctx: a name for actions that share a key because their when()s never overlap (Esc: crop /
//       selection); two actions on one key are a conflict unless both have different ctx.
//     typing: true (or fn(target)) = also fires while a text field has the focus.
//     hold: true + up(e): spring-loaded key; up() runs when the key is released (or on blur).
//     run returns false = leave the browser default alone.
//   K.info("Wheel", "View", "Zoom")        mouse/gesture row in the sheet (not editable)
//   K.dispatch(e)    -> true when an action took the key (the tool's own keydown handler calls it
//                       after its own guards); K.match(e) only looks
//   K.label(id)      -> "Ctrl Z" (current first key, "" when none); K.tip("Undo", "undo") -> "Undo (Ctrl Z)"
//   K.refresh(root)  -> rewrites title / aria-label / .kbd of [data-kact="id"] elements
//   K.onChange(fn)   -> after a key was changed (re-render labels you built by hand)
//   K.openSheet()    -> the ? sheet
// `globalKeys` is the scope every tool's sheet shows as "Global" (shell: tabs, interface size).
// Saved in localStorage "quickcut.keys" as {v, k: {"photo.undo": ["Ctrl+Z"], ...}}; only changed
// actions are stored, so defaults added later reach everybody.
import { h, icon, isPhone, openLayer, isTyping as isTypingDefault, mod } from "./ui.js";

const STORE = "quickcut.keys", VER = 1;
const CSS_ID = "ks-css";
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || "");

// ── combos ──────────────────────────────────────────────────────────────────
const NAMED = { Space: "Space", Enter: "Enter", NumpadEnter: "Enter", Escape: "Esc", Delete: "Delete", Backspace: "Backspace", Tab: "Tab", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down" };
const PUNCT = { BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Minus: "-", Equal: "=", Backquote: "`", NumpadAdd: "=", NumpadSubtract: "-", NumpadDecimal: ".", NumpadDivide: "/" };
const BY_KEY = { " ": "Space", Escape: "Esc", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", "+": "=", "?": "/", "_": "-", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "~": "`" };
const NAMES = new Set([...Object.values(NAMED), ...Object.values(PUNCT)]);

/** The key itself, without modifiers ("A", "5", "Left", "="), or null for modifier-only / unknown keys. */
export function baseKey(e) {
  const c = e.code || "", k = e.key || "";
  if (/^Key[A-Z]$/.test(c)) return /^[a-z]$/i.test(k) ? k.toUpperCase() : c[3];
  if (/^(Digit|Numpad)\d$/.test(c)) return c.slice(-1);
  if (/^F\d{1,2}$/.test(c)) return c;
  if (NAMED[c]) return NAMED[c];
  if (PUNCT[c]) return PUNCT[c];
  if (c) return null;
  // synthetic events without a code
  if (/^[a-z]$/i.test(k)) return k.toUpperCase();
  if (/^\d$/.test(k)) return k;
  if (/^F\d{1,2}$/.test(k)) return k;
  const n = BY_KEY[k] || k;
  return NAMED[k] || NAMES.has(n) ? NAMED[k] || n : null;
}
/** "Ctrl+Alt+Shift+K" for a key event, or null. */
export function comboOf(e) {
  const key = baseKey(e);
  return key && `${mod(e) ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${key}`;
}
const VALID = /^(Ctrl\+)?(Alt\+)?(Shift\+)?([A-Z0-9]|F\d{1,2}|Space|Enter|Esc|Tab|Delete|Backspace|Home|End|PageUp|PageDown|Insert|Left|Right|Up|Down|[[\]\\;',./\-=`])$/;
const splitKeys = (k) => (Array.isArray(k) ? k : k ? String(k).split("|") : []).filter((c) => VALID.test(c));

const SHOWN = { Left: "←", Right: "→", Up: "↑", Down: "↓", Delete: "Del", "-": "−", "=": "+" };
/** "Ctrl Shift Z", "←", "?" */
export function fmtCombo(c) {
  if (c === "Shift+/") return "?";
  return c.split("+").map((x) => (x === "Ctrl" && MAC ? "Cmd" : SHOWN[x] || x)).join(" ");
}

// Combos the browser or the system keeps for itself: a page never receives them reliably.
const RESERVED = new Set(["Ctrl+T", "Ctrl+W", "Ctrl+N", "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+Shift+T", "Ctrl+Shift+N", "Ctrl+Shift+W", "Ctrl+PageUp", "Ctrl+PageDown",
  "Ctrl+R", "Ctrl+Shift+R", "Ctrl+F5", "F5", "Shift+F5", "F11", "F12", "F1", "Alt+F4", "Alt+Tab", "Ctrl+Q", "Ctrl+Shift+Q", "Ctrl+Shift+Delete", "Alt+Home", "Ctrl+Alt+Delete",
  ...Array.from({ length: 9 }, (_, i) => `Ctrl+${i + 1}`)]);
export const isReserved = (c) => RESERVED.has(c);

// ── saved choices ───────────────────────────────────────────────────────────
let saved = {}; // full id → combos (only the ones that differ from the default)
function load() {
  try {
    const j = JSON.parse(localStorage.getItem(STORE) || "null");
    saved = {};
    if (j && typeof j === "object" && j.v <= VER && j.k && typeof j.k === "object") {
      for (const [id, v] of Object.entries(j.k)) if (Array.isArray(v)) saved[id] = splitKeys(v);
    }
  } catch { saved = {}; }
}
function persist() {
  try {
    if (Object.keys(saved).length) localStorage.setItem(STORE, JSON.stringify({ v: VER, k: saved }));
    else localStorage.removeItem(STORE);
  } catch {}
}
load();

const scopes = new Map(); // scope id → K
let gen = 0; // bumps on every change (indexes rebuild lazily)
const fire = () => { gen++; for (const K of scopes.values()) K._changed(); };
addEventListener("storage", (e) => { if (e.key === STORE) { load(); fire(); } });

// ── hold keys ───────────────────────────────────────────────────────────────
const holds = new Map(); // base key → action (running until the key goes up)
function release(key) {
  const a = holds.get(key);
  if (!a) return;
  holds.delete(key);
  a.up?.();
}
addEventListener("keyup", (e) => {
  const key = baseKey(e);
  if (key && holds.has(key)) { release(key); if (!isTypingDefault(e.target)) e.preventDefault(); }
}, true);
addEventListener("blur", () => { for (const k of [...holds.keys()]) release(k); });

// ── scopes ──────────────────────────────────────────────────────────────────
const sameKeys = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const ctxClash = (a, b) => !(a.ctx && b.ctx && a.ctx !== b.ctx);

export function createKeys({ id, title = id, typing } = {}) {
  if (scopes.has(id)) return scopes.get(id);
  const items = []; // actions and info rows in order
  const acts = new Map();
  const listeners = [];
  let index = null, indexGen = -1;
  const isTyp = typing || isTypingDefault;
  const K = {
    id, title, items, acts,
    add(o) {
      const a = { ...o, scope: K, full: `${id}.${o.id}`, defaults: splitKeys(o.keys), kind: "act" };
      acts.set(o.id, a);
      items.push(a);
      index = null;
      return a;
    },
    info(shown, group, label) { items.push({ kind: "info", shown, group, label }); },
    /** Current combos of an action. A saved choice wins; a default another action's saved choice took over is dropped. */
    keysOf(aid) {
      const a = acts.get(aid);
      if (!a) return [];
      if (saved[a.full]) return saved[a.full];
      return a.defaults.filter((c) => !takenBySaved(a, c));
    },
    label(aid) { const k = K.keysOf(aid)[0]; return k ? fmtCombo(k) : ""; },
    tip(text, aid) { const l = K.label(aid); return l ? `${text} (${l})` : text; },
    refresh(root = document) {
      for (const el of root.querySelectorAll("[data-kact]")) {
        const l = K.label(el.dataset.kact);
        if (el.classList.contains("kbd")) { el.textContent = l; el.hidden = !l; continue; }
        for (const at of ["title", "aria-label"]) {
          if (!el.hasAttribute(at)) continue;
          const v = el.getAttribute(at).replace(/\s*\([^()]*\)\s*$/, "");
          el.setAttribute(at, l ? `${v} (${l})` : v);
        }
      }
    },
    onChange(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    _changed() { index = null; for (const fn of listeners) fn(); },
    match(e) {
      const combo = comboOf(e);
      if (!combo) return null;
      if (!index || indexGen !== gen) {
        index = new Map();
        for (const a of acts.values()) for (const c of K.keysOf(a.id)) { if (!index.has(c)) index.set(c, []); index.get(c).push(a); }
        indexGen = gen;
      }
      const typingNow = isTyp(e.target);
      for (const a of index.get(combo) || []) {
        if (typingNow && !(a.typing === true || (typeof a.typing === "function" && a.typing(e.target)))) continue;
        if (a.when && !a.when(e)) continue;
        return { a, combo };
      }
      return null;
    },
    /** Runs the action for a key event; true when one took it. */
    dispatch(e, before) {
      const m = K.match(e);
      if (!m) return false;
      before?.(m.a, e);
      if (m.a.hold) holds.set(baseKey(e), m.a);
      if (m.a.run(e, m.combo) !== false) e.preventDefault();
      return true;
    },
    openSheet: () => openSheet(K),
    setKeys(aid, list) { setKeys(acts.get(aid), list); },
    reset(aid) { resetOne(acts.get(aid)); },
  };
  scopes.set(id, K);
  return K;
}

export const globalKeys = createKeys({ id: "global", title: "Global" });

function takenBySaved(a, combo) {
  for (const K of scopes.values()) for (const b of K.acts.values()) {
    if (b === a || !saved[b.full] || !saved[b.full].includes(combo)) continue;
    if (b.scope === a.scope ? ctxClash(a, b) : (b.scope === globalKeys || a.scope === globalKeys)) return true;
  }
  return false;
}
function setKeys(a, list) {
  if (!a) return;
  list = [...new Set(splitKeys(list))];
  if (sameKeys(list, a.defaults)) delete saved[a.full]; else saved[a.full] = list;
  persist(); fire();
}
function resetOne(a) { if (a && saved[a.full]) { delete saved[a.full]; persist(); fire(); } }
function resetScope(...Ks) {
  let n = 0;
  for (const K of Ks) for (const a of K.acts.values()) if (saved[a.full]) { delete saved[a.full]; n++; }
  if (n) { persist(); fire(); }
}
/** Other actions already on this combo (same tool, or global against any tool). */
function conflictsOf(a, combo) {
  const out = [];
  const pool = a.scope === globalKeys ? [...scopes.values()] : [a.scope, globalKeys];
  for (const K of pool) for (const b of K.acts.values()) {
    if (b === a || !K.keysOf(b.id).includes(combo)) continue;
    if (b.scope === a.scope && !ctxClash(a, b)) continue;
    out.push(b);
  }
  return out;
}
/** Used by tests: change a key without the sheet (checks reserved keys and conflicts). */
export function bindKey(K, aid, combo, { slot = 0, onConflict = "none" } = {}) {
  const a = K.acts.get(aid);
  if (!a || !VALID.test(combo)) return { ok: false, why: "invalid" };
  if (isReserved(combo)) return { ok: false, why: "reserved" };
  const cur = [...K.keysOf(aid)];
  const cf = conflictsOf(a, combo);
  if (cf.length) {
    if (onConflict === "none") return { ok: false, why: "conflict", with: cf.map((b) => b.full) };
    if (onConflict === "swap") { const old = cur[slot]; for (const b of cf) setKeys(b, b.scope.keysOf(b.id).map((c) => (c === combo ? old : c)).filter(Boolean)); }
    else for (const b of cf) setKeys(b, b.scope.keysOf(b.id).filter((c) => c !== combo));
  }
  if (slot >= 0 && slot < cur.length) cur[slot] = combo; else cur.push(combo);
  setKeys(a, cur);
  return { ok: true };
}

// ── the ? sheet ─────────────────────────────────────────────────────────────
const I_RESET = "M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3";
let openFor = null;
function openSheet(K) {
  if (openFor) { openFor.layer.close(); return; }
  if (!document.getElementById(CSS_ID)) {
    const l = document.createElement("link");
    l.id = CSS_ID; l.rel = "stylesheet"; l.href = new URL("./keys.css", import.meta.url).href;
    document.head.append(l);
  }
  const el = h(`<section class="ks" role="dialog" aria-label="Keyboard shortcuts">
    <div class="pop-head"><span class="pop-title">Keyboard shortcuts</span>
      <button class="btn-g sm ks-all" type="button">Reset all</button>
      <button class="ib ks-x" type="button" aria-label="Close (Esc)">${icon("x")}</button></div>
    <div class="ks-bar" hidden></div>
    <div class="ks-grid" tabindex="-1"></div>
  </section>`);
  const grid = el.querySelector(".ks-grid"), bar = el.querySelector(".ks-bar");
  let rec = null; // {a, idx}
  let pend = null; // {a, idx, combo, cf}
  const groupsOf = (S) => {
    const m = new Map();
    for (const it of S.items) { const g = it.group; if (!m.has(g)) m.set(g, []); m.get(g).push(it); }
    return m;
  };
  function row(it) {
    if (it.kind === "info") {
      const r = h(`<div class="ks-row info"><span class="ks-w"></span><span class="ks-k"></span></div>`);
      r.querySelector(".ks-w").textContent = it.label;
      r.querySelector(".ks-k").textContent = it.shown;
      return r;
    }
    const a = it, keys = a.scope.keysOf(a.id), changed = !!saved[a.full];
    const r = h(`<div class="ks-row"><span class="ks-w"></span><span class="ks-k"></span><button class="ib sm ks-r" type="button" aria-label="Reset" title="Reset">${icon(I_RESET, 14)}</button></div>`);
    r.dataset.a = a.full;
    r.querySelector(".ks-w").textContent = a.label;
    const kz = r.querySelector(".ks-k");
    keys.forEach((c, i) => {
      const b = h(`<button class="kbd ks-c" type="button" data-i="${i}"></button>`);
      const on = rec && rec.a === a && rec.idx === i;
      b.textContent = on ? "…" : fmtCombo(c);
      b.title = on ? "Esc · Backspace" : fmtCombo(c);
      b.classList.toggle("rec", !!on);
      b.dataset.combo = c;
      kz.append(b);
    });
    const add = h(`<button class="kbd ks-c add" type="button" data-i="-1" aria-label="Add key" title="Add key"></button>`);
    const on = rec && rec.a === a && rec.idx === -1;
    add.textContent = on ? "…" : keys.length ? "+" : "—";
    add.classList.toggle("rec", !!on);
    if (on) add.title = "Esc · Backspace";
    kz.append(add);
    const rs = r.querySelector(".ks-r");
    rs.hidden = !changed;
    return r;
  }
  function render() {
    const top = grid.scrollTop;
    grid.replaceChildren();
    const all = [K, ...(K === globalKeys ? [] : [globalKeys])];
    for (const S of all) {
      for (const [g, list] of groupsOf(S)) {
        const sec = h(`<div class="sec"><span class="label"></span></div>`);
        sec.firstChild.textContent = S === globalKeys && K !== globalKeys ? "Global" : g;
        if (S === globalKeys && K !== globalKeys) {
          // all global rows in one "Global" section
          if (grid.querySelector('.sec[data-global]')) continue;
          sec.dataset.global = "1";
          for (const gl of globalKeys.items) sec.append(row(gl));
        } else for (const it of list) sec.append(row(it));
        grid.append(sec);
      }
    }
    grid.scrollTop = top;
  }
  function showBar() {
    if (!pend) { bar.hidden = true; bar.replaceChildren(); return; }
    const { a, idx, combo, cf } = pend;
    bar.hidden = false;
    bar.innerHTML = `<span class="ks-msg"><span class="kbd"></span> <b></b></span><span class="ks-btns"></span>`;
    bar.querySelector(".kbd").textContent = fmtCombo(combo);
    bar.querySelector("b").textContent = cf.map((b) => b.label).join(", ");
    const btns = bar.querySelector(".ks-btns");
    const mk = (t, fn, cls = "btn-g sm") => { const b = h(`<button class="${cls}" type="button"></button>`); b.textContent = t; b.onclick = fn; btns.append(b); };
    const old = idx >= 0 ? a.scope.keysOf(a.id)[idx] : null;
    if (old && cf.length === 1) mk("Swap", () => commit("swap"), "btn-2 sm");
    mk("Replace", () => commit("replace"), "btn-2 sm");
    mk("Cancel", () => { pend = null; showBar(); });
  }
  function commit(how) {
    const { a, idx, combo } = pend;
    pend = null;
    bindKey(a.scope, a.id, combo, { slot: idx, onConflict: how });
    showBar();
  }
  function stop() { rec = null; window.removeEventListener("keydown", onKey, true); render(); }
  function onKey(e) {
    if (!rec) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (e.repeat || ["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"].includes(e.key)) return;
    const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    const { a, idx } = rec;
    if (e.key === "Escape" && bare) { stop(); return; }
    if (e.key === "Backspace" && bare) {
      const cur = a.scope.keysOf(a.id);
      if (idx >= 0) setKeys(a, cur.filter((_, i) => i !== idx));
      stop();
      return;
    }
    const combo = comboOf(e);
    if (!combo) return;
    const chip = grid.querySelector(`[data-a="${a.full}"] .rec`);
    if (isReserved(combo)) { chip?.classList.remove("bad"); void chip?.offsetWidth; chip?.classList.add("bad"); if (chip) chip.title = "Reserved"; return; }
    const cur = a.scope.keysOf(a.id);
    if (idx >= 0 && cur[idx] === combo) { stop(); return; }
    if (cur.includes(combo)) { stop(); return; }
    const cf = conflictsOf(a, combo);
    if (cf.length) { pend = { a, idx, combo, cf }; stop(); showBar(); return; }
    bindKey(a.scope, a.id, combo, { slot: idx });
    stop();
  }
  grid.addEventListener("click", (e) => {
    const r = e.target.closest(".ks-row");
    if (!r?.dataset.a) return;
    const a = [...scopes.values()].flatMap((S) => [...S.acts.values()]).find((x) => x.full === r.dataset.a);
    if (e.target.closest(".ks-r")) { resetOne(a); return; }
    const c = e.target.closest(".ks-c");
    if (!c) return;
    pend = null; showBar();
    rec = { a, idx: +c.dataset.i };
    window.addEventListener("keydown", onKey, true);
    render();
    grid.querySelector(".rec")?.focus({ preventScroll: true });
  });
  el.querySelector(".ks-all").onclick = () => { pend = null; showBar(); resetScope(K, globalKeys); };
  const offs = [K, globalKeys].map((S) => S.onChange(render));
  render();
  const layer = openLayer(el, {
    center: true, width: 660, reopen: false,
    onClose: () => { window.removeEventListener("keydown", onKey, true); rec = null; openFor = null; for (const off of offs) off(); },
  });
  openFor = { layer };
  el.querySelector(".ks-x").onclick = () => layer.close();
  return layer;
}
