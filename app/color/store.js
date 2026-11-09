// Colour tool storage. Reads and writes the same formats as the old Color Picker site so saved
// histories and images moved over from there (see transfer.html) show up unchanged:
//   localStorage  chromaPick.imageHistories  { "<name>|<type>|<size>|<modified>|<hash>": entry }
//                 entry = { name, updatedAt, colors: ["#RRGGBB", newest first], imageDataUrl?,
//                           isMultiImage?, images?: [{ dataUrl?, name?, cloud* ... }], cloud* ... }
//                 (an older format stored just the colour array)
//   IndexedDB     chromaPickHandles v3, store multiImageBlobs: "<historyKey>:<index>" -> data URL
// Entries are kept as parsed (unknown fields survive a save), only validated when read.

export const KEYS = {
  histories: "chromaPick.imageHistories",
  session: "chromaPick.cloudSession",
};
const PALETTE_N = "quickcut.color.paletteN";
const HEX = /^#[0-9A-Fa-f]{6}$/;

const num = (k) => {
  try { const v = Number(localStorage.getItem(k)); return Number.isFinite(v) && localStorage.getItem(k) !== null ? v : null; } catch { return null; }
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const prefs = {
  savedOpen: () => { try { return localStorage.getItem("quickcut.color.savedOpen") === "1"; } catch { return false; } },
  setSavedOpen: (v) => { try { localStorage.setItem("quickcut.color.savedOpen", v ? "1" : "0"); } catch {} },

  paletteN: () => clamp(Math.round(num(PALETTE_N) ?? 6), 2, 12),
  setPaletteN: (v) => { try { localStorage.setItem(PALETTE_N, String(v)); } catch {} },
};

// ── histories ───────────────────────────────────────────────────────────────
export function colorList(list) {
  const out = [], seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    if (typeof c !== "string" || !HEX.test(c)) continue;
    const u = c.toUpperCase();
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

/** The raw store: { key: entry }. Old array entries are upgraded in place. */
export function loadHistories() {
  try {
    const raw = localStorage.getItem(KEYS.histories);
    const p = raw ? JSON.parse(raw) : {};
    if (!p || typeof p !== "object" || Array.isArray(p)) return {};
    for (const [k, v] of Object.entries(p)) {
      if (Array.isArray(v)) p[k] = { name: keyName(k), updatedAt: 0, colors: colorList(v) };
      else if (!v || typeof v !== "object") delete p[k];
    }
    return p;
  } catch { return {}; }
}

/** Write all histories. If the storage is full, drops the oldest stored images until it fits. */
export function saveHistories(all) {
  const tryWrite = () => { try { localStorage.setItem(KEYS.histories, JSON.stringify(all)); return true; } catch { return false; } };
  if (tryWrite()) return { ok: true, droppedImages: 0 };
  const byAge = Object.entries(all).filter(([, e]) => typeof e.imageDataUrl === "string").sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
  let dropped = 0;
  for (const [, e] of byAge) {
    e.imageDataUrl = null;
    dropped++;
    if (tryWrite()) return { ok: true, droppedImages: dropped };
  }
  return { ok: false, droppedImages: dropped };
}

export const keyName = (key) => {
  const n = String(key).split("|")[0].trim();
  return n || "Untitled image";
};

/** A history entry ready to show: validated colours, a name, how many images it holds. */
export function view(key, e) {
  const colors = colorList(e.colors);
  const multi = e.isMultiImage === true && Array.isArray(e.images);
  const hasImage = multi ? e.images.length > 0 : typeof e.imageDataUrl === "string" && e.imageDataUrl.startsWith("data:image/");
  return {
    key, e, colors, multi, hasImage,
    name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : keyName(key),
    at: Number.isFinite(e.updatedAt) ? e.updatedAt : 0,
  };
}

/** "name|type|size|modified|hash": the old site's key format. Hash = FNV-1a over the first and last 2 KB of the file. */
export async function historyKey(file) {
  const buf = new Uint8Array(await file.slice(0, 2048).arrayBuffer());
  const tail = file.size > 2048 ? new Uint8Array(await file.slice(Math.max(2048, file.size - 2048)).arrayBuffer()) : new Uint8Array();
  let h = 2166136261;
  for (const part of [buf, tail]) for (let i = 0; i < part.length; i++) { h ^= part[i]; h = Math.imul(h, 16777619); }
  const hash = (h >>> 0).toString(16).padStart(8, "0");
  return `${file.name || "clipboard"}|${file.type || "image/unknown"}|${file.size || 0}|${file.lastModified || 0}|${hash}`;
}

// ── images of multi-image histories (IndexedDB) ─────────────────────────────
const IDB_NAME = "chromaPickHandles", IDB_VERSION = 3, STORE = "multiImageBlobs";
let dbp = null;
function idb() {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB_NAME, IDB_VERSION);
    r.onupgradeneeded = () => {
      for (const s of ["handles", "cipherCache", STORE]) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => { r.result.close(); dbp = null; };
      resolve(r.result);
    };
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
/** data URL of image `i` of a multi-image history, or null. */
export async function multiImage(key, i) {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const q = db.transaction(STORE, "readonly").objectStore(STORE).get(`${key}:${i}`);
      q.onsuccess = () => resolve(typeof q.result === "string" ? q.result : null);
      q.onerror = () => resolve(null);
    });
  } catch { return null; }
}
export async function deleteMultiImages(key) {
  try {
    const db = await idb();
    await new Promise((resolve) => {
      const st = db.transaction(STORE, "readwrite").objectStore(STORE);
      const c = st.openKeyCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return resolve();
        if (typeof cur.key === "string" && cur.key.startsWith(`${key}:`)) st.delete(cur.key);
        cur.continue();
      };
      c.onerror = () => resolve();
    });
  } catch {}
}

// ── old cloud session ───────────────────────────────────────────────────────
export function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(KEYS.session) || "null");
    if (!s?.sessionToken || !s?.email || !s?.emailHash) return null;
    if (Number.isFinite(s.expiresAt) && s.expiresAt < Date.now()) return null;
    return s;
  } catch { return null; }
}
export function saveSession(s) {
  try { localStorage.setItem(KEYS.session, JSON.stringify({ sessionToken: s.sessionToken, email: s.email, emailHash: s.emailHash, expiresAt: s.expiresAt })); } catch {}
}
export function clearSession() {
  try {
    for (const k of [KEYS.session, "chromaPick.cloudPendingUploads", "chromaPick.cloudUsageCache", "chromaPick.cloudKeepUnlockedDays"]) localStorage.removeItem(k);
  } catch {}
}
