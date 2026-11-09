// QuickCut project files (.qcut): one container for Photo documents and Video projects.
// Layout, limits and the benchmark that chose the codecs: web/QCUT_FORMAT.md.
//
//   const blob = await qcut.write({ type: "photo", doc, preview });   // doc: JSON data + pixel/blob values
//   await qcut.write(p, { mode: "quick", rev: (src) => layerVersion.get(src) });  // autosave
//   const f = await qcut.read(blob);       // header, index and doc only (fast; validates everything)
//   const thumb = await f.preview();       // the small preview image, before any layer
//   const img = await f.doc.layers[0].px.load();          // one layer: ImageData (pixel-identical)
//   await ref.load({ into: canvas, focus: viewRect });    // draw tiles as they land, visible ones first
//   const all = await f.loadAll();         // or the whole doc with every value loaded
//
// Values in `doc` that become chunks: ImageData, canvases, ImageBitmaps, {width,height,data,channels}
// (pixels, lossless), EncodedPixels (from encodePixels(), cacheable between saves), Blob/File (stored
// as-is), ArrayBuffer/typed arrays (deflated, byte-shuffled when that is smaller). Everything else
// must be plain JSON.
//
// Saving again is incremental: each pixel source remembers its tiles, and only tiles whose pixels
// changed are encoded again (`rev` skips even the check). Identical tiles are stored once per file.
import { QcutError, crc32, hash2, solidOf as solidOfSync, deflate, inflate, runTask, C_SOLID, C_QOI, C_ANS, C_RAW, C_REF } from "./qcut-codec.js";
export { QcutError };

export const MIME = "application/x-quickcut";
export const EXT = ".qcut";
export const VERSION = Object.freeze({ major: 2, minor: 0 });
const MAGIC = [0x89, 0x51, 0x43, 0x55, 0x54, 0x0d, 0x0a, 0x1a]; // "\x89QCUT\r\n\x1a"
const HEAD = 40, ENTRY = 32, DIR_HEAD = 16, DIR_ENTRY = 16;
const T_BYTES = 1, T_PIXELS = 2;
const E_STORE = 0, E_DEFLATE = 1, E_SHUF2 = 2, E_SHUF4 = 3, E_SHUF8 = 4; // SHUFn: n-byte elements XOR the previous one, byte planes, deflate
const F_NOCRC = 1; // chunk flag: CRC not computed (only writeSync, for blobs it could not read in time)
const KNOWN_REQUIRED = 0; // required-feature bits this reader understands
const TILE_LOG2 = 9; // 512×512 tiles (benchmarked: best mix of size, parallelism and overhead)
const CODECS = new Set([C_SOLID, C_QOI, C_ANS, C_RAW, C_REF]);
export const LIMITS = Object.freeze({
  chunks: 100000, // chunks in one file
  meta: 32 * 2 ** 20, // the JSON index
  bytes: 2 ** 31 - 1, // one stored blob / array (stored and decoded size)
  side: 32768, // pixel layer width or height
  area: 2 ** 28, // pixel layer w×h (as browsers' canvas limit)
  depth: 64, // JSON nesting
  nodes: 2000000, // JSON values
});
const TYPED = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array };
const PREVIEW_TYPES = new Set(["image/webp", "image/jpeg", "image/png", "image/avif"]);
const bad = (msg) => new QcutError("corrupt", msg);

// ── worker pool ──────────────────────────────────────────────────────────────
let POOL_N = Math.max(1, Math.min(16, ((globalThis.navigator?.hardwareConcurrency) || 4) - 1));
let SLOTS = POOL_N * 2; // tiles in flight at once, all files together (bounds memory)
/** Set the number of workers (default: logical cores − 1, at most 16). Takes effect when the pool next starts. */
export function configure({ workers } = {}) {
  if (Number.isInteger(workers) && workers >= 1 && workers <= 64) { POOL_N = workers; SLOTS = workers * 2; if (pool && !active) { pool.ws.forEach((w) => w.terminate()); pool = null; poolP = null; } }
  return { workers: POOL_N };
}
let pool = null, poolP = null, idleT = 0, seq = 0, active = 0;
const waiting = [];
async function startPool() {
  if (typeof Worker === "undefined") return null;
  try {
    const ws = Array.from({ length: POOL_N }, () => new Worker(new URL("./qcut-worker.js", import.meta.url), { type: "module" }));
    const alive = await Promise.race([
      Promise.all(ws.map((w) => new Promise((res, rej) => { w.onmessage = () => res(); w.onerror = (e) => { e.preventDefault?.(); rej(e); }; w.postMessage({ op: "ping", id: 0 }); }))).then(() => true, () => false),
      new Promise((r) => setTimeout(() => r(false), 5000)),
    ]);
    if (!alive) { ws.forEach((w) => w.terminate()); return null; }
    const p = { ws, n: ws.map(() => 0), cb: new Map() };
    ws.forEach((w) => {
      w.onmessage = (e) => { const c = p.cb.get(e.data.id); if (c) { p.cb.delete(e.data.id); c(e.data); } };
      w.onerror = (e) => { e.preventDefault?.(); for (const c of p.cb.values()) c({ error: { code: "error", message: "worker failed" } }); p.cb.clear(); };
    });
    return p;
  } catch { return null; }
}
async function slot() {
  if (active < SLOTS) { active++; return; }
  await new Promise((r) => waiting.push(r));
}
function release() { const r = waiting.shift(); if (r) r(); else active--; }
/** Run one tile task in a worker (or here, if workers can't start). */
async function task(msg, transfer = []) {
  clearTimeout(idleT);
  poolP ||= startPool().then((p) => (pool = p));
  const p = await poolP;
  let res;
  if (!p) {
    try { [res] = await runTask(msg); } catch (e) { throw e instanceof QcutError ? e : bad(String(e?.message || e)); }
  } else {
    let k = 0;
    for (let i = 1; i < p.ws.length; i++) if (p.n[i] < p.n[k]) k = i;
    p.n[k]++;
    const id = ++seq;
    const data = await new Promise((r) => { p.cb.set(id, r); p.ws[k].postMessage({ ...msg, id }, transfer); });
    p.n[k]--;
    if (data.error) throw new QcutError(data.error.code === "unsupported" ? "unsupported" : "corrupt", data.error.message);
    res = data.out;
  }
  if (!active) idleT = setTimeout(() => { if (pool && !active) { pool.ws.forEach((w) => w.terminate()); pool = null; poolP = null; } }, 15000);
  return res;
}

// ── pixels ───────────────────────────────────────────────────────────────────
/**
 * A layer's pixels, encoded (lossless) and ready to go into any number of files. Cache it per layer
 * version. `tiles[i]`: { codec, value, crc, h2, off, len } (off from the end of the directory).
 */
export class EncodedPixels {
  constructor(width, height, channels, blob, dirCrc, tiles = null, mode = "best") { Object.assign(this, { width, height, channels, blob, dirCrc, tiles, mode }); Object.freeze(this); }
  get size() { return this.blob.size; }
}
const isCanvas = (s) => (typeof OffscreenCanvas !== "undefined" && s instanceof OffscreenCanvas) || (typeof HTMLCanvasElement !== "undefined" && s instanceof HTMLCanvasElement) || (typeof ImageBitmap !== "undefined" && s instanceof ImageBitmap);
const isPixelData = (s) => s && typeof s === "object" && !ArrayBuffer.isView(s) && Number.isInteger(s.width) && Number.isInteger(s.height) && (s.data instanceof Uint8Array || s.data instanceof Uint8ClampedArray);
const isPixels = (s) => s instanceof EncodedPixels || (typeof ImageData !== "undefined" && s instanceof ImageData) || isCanvas(s) || isPixelData(s);
function checkDims(w, h) {
  if (!(w >= 1 && h >= 1 && w <= LIMITS.side && h <= LIMITS.side && w * h <= LIMITS.area)) throw new QcutError("too-big", `layer size ${w}×${h} is out of range`);
}
function tileGrid(w, h, log2) {
  const T = 1 << log2, out = [];
  for (let y = 0; y < h; y += T) for (let x = 0; x < w; x += T) out.push({ x, y, w: Math.min(T, w - x), h: Math.min(T, h - y) });
  return out;
}
function cut(data, W, ch, t) {
  const px = new Uint8Array(t.w * t.h * ch), row = t.w * ch;
  for (let y = 0; y < t.h; y++) { const s = ((t.y + y) * W + t.x) * ch; px.set(data.subarray(s, s + row), y * row); }
  return px;
}
/**
 * Directory + data for one layer. `results[i]`: { codec, value, crc, h2, bytes: Uint8Array|Blob|null }
 * or, for a shared tile, { codec: C_REF, chunk, tile, crc }. → { parts, dirCrc, tiles }
 */
function buildDir(w, h, ch, results) {
  const dir = new Uint8Array(DIR_HEAD + DIR_ENTRY * results.length), dv = new DataView(dir.buffer);
  dv.setUint32(0, w, true); dv.setUint32(4, h, true); dir[8] = ch; dir[9] = TILE_LOG2; dv.setUint32(12, results.length, true);
  const parts = [dir], tiles = [];
  let off = 0;
  results.forEach((r, i) => {
    const e = DIR_HEAD + i * DIR_ENTRY;
    if (r.codec === C_SOLID) { dv.setUint32(e, r.value, true); dv.setUint32(e + 4, 0, true); tiles.push({ codec: C_SOLID, value: r.value, crc: r.crc, h2: r.h2, off: 0, len: 0 }); }
    else if (r.codec === C_REF) { dv.setUint32(e, r.chunk, true); dv.setUint32(e + 4, r.tile, true); tiles.push({ codec: C_REF, value: 0, crc: r.crc, h2: r.h2, off: 0, len: 0 }); }
    else {
      const len = r.bytes.length ?? r.bytes.size;
      dv.setUint32(e, off, true); dv.setUint32(e + 4, len, true);
      tiles.push({ codec: r.codec, value: 0, crc: r.crc, h2: r.h2, off, len });
      off += len; parts.push(r.bytes);
    }
    if (off > 0xffffffff) throw new QcutError("too-big", "layer data over 4 GiB");
    dv.setUint32(e + 8, r.crc, true); dir[e + 12] = r.codec;
  });
  return { parts, dirCrc: crc32(dir), tiles };
}
// Incremental saves: source object → its last encoding. A later save sends each tile's identity
// (CRC-32 + a second 32-bit hash) along; the worker reads the pixels and, if they still match,
// answers "same" without encoding. With a matching `rev` nothing is read at all.
const lastEnc = new WeakMap();
const STRENGTH = { fast: 0, quick: 1, best: 2 };
/**
 * Encode pixels losslessly into tiles (in workers). `src`: canvas / OffscreenCanvas / ImageBitmap /
 * ImageData / {width, height, data, channels: 1|4}. A canvas is snapshotted when this is called, so
 * later drawing doesn't tear the result. `mode`: "best" (default), "quick" (autosave) or "fast"
 * (no compression). `rev`: the caller's version number for `src`; when it equals the one from the
 * last call, the last result is returned without reading any pixels.
 */
export async function encodePixels(src, { mode = "best", rev } = {}) {
  if (src instanceof EncodedPixels) return src;
  if (!isPixels(src)) throw new TypeError("encodePixels: not a pixel source");
  if (!(mode in STRENGTH)) throw new TypeError(`encodePixels: unknown mode ${mode}`);
  const W = src.width, H = src.height, canvas = isCanvas(src);
  checkDims(W, H);
  const ch = canvas || (typeof ImageData !== "undefined" && src instanceof ImageData) ? 4 : src.channels === 1 ? 1 : 4;
  const prev0 = lastEnc.get(src);
  const prev = prev0 && prev0.enc.width === W && prev0.enc.height === H && prev0.enc.channels === ch && STRENGTH[prev0.enc.mode] >= STRENGTH[mode] ? prev0 : null;
  if (prev && rev !== undefined && prev.rev === rev) return prev.enc;
  let data = null, snap = null;
  if (canvas) snap = await snapshot(src, W, H);
  else {
    data = src.data instanceof Uint8Array ? src.data : new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.length);
    if (data.length !== W * H * ch) throw new TypeError("encodePixels: data length doesn't match the size");
  }
  const tiles = tileGrid(W, H, TILE_LOG2);
  const opts = { mode };
  const dataStart = prev ? DIR_HEAD + DIR_ENTRY * prev.enc.tiles.length : 0;
  try {
    const results = await Promise.all(tiles.map(async (t, i) => {
      const old = prev?.enc.tiles[i];
      const same = old && old.codec !== C_REF ? { crc: old.crc, h2: old.h2 } : undefined;
      await slot();
      let r;
      try {
        if (snap && snap.data) { const px = cut(snap.data, W, 4, t); r = await task({ op: "enc", px: px.buffer, w: t.w, h: t.h, ch, opts, same }, [px.buffer]); }
        else if (snap) { const bitmap = await createImageBitmap(snap.bitmap, t.x, t.y, t.w, t.h); r = await task({ op: "enc", bitmap, w: t.w, h: t.h, ch, opts, same }, [bitmap]); }
        else { const px = cut(data, W, ch, t); r = await task({ op: "enc", px: px.buffer, w: t.w, h: t.h, ch, opts, same }, [px.buffer]); }
      } finally { release(); }
      if (r.same) return old.codec === C_SOLID ? { ...old } : { codec: old.codec, value: 0, crc: old.crc, h2: old.h2, bytes: prev.enc.blob.slice(dataStart + old.off, dataStart + old.off + old.len) };
      return r;
    }));
    const { parts, dirCrc, tiles: meta } = buildDir(W, H, ch, results);
    const enc = new EncodedPixels(W, H, ch, new Blob(parts), dirCrc, Object.freeze(meta), mode);
    lastEnc.set(src, { enc, rev });
    return enc;
  } finally { snap?.bitmap?.close?.(); }
}
/** A consistent copy of a canvas now: a GPU-side ImageBitmap (cheap), or its pixels where bitmaps can't be cropped. */
async function snapshot(src, W, H) {
  if (typeof createImageBitmap === "function") {
    try { return { bitmap: await createImageBitmap(src) }; } catch {}
  }
  let c = src;
  if (!src.getContext) { c = new OffscreenCanvas(W, H); c.getContext("2d").drawImage(src, 0, 0); }
  return { data: new Uint8Array(c.getContext("2d").getImageData(0, 0, W, H).data.buffer) };
}
/**
 * Synchronous encoding (for the moment the page closes): uncompressed, except that when every tile
 * still matches the source's last compressed encoding, that one is reused. Canvases are read with
 * getImageData.
 */
export function encodePixelsSync(src) {
  if (src instanceof EncodedPixels) return src;
  if (!isPixels(src) || (typeof ImageBitmap !== "undefined" && src instanceof ImageBitmap)) throw new TypeError("encodePixelsSync: not a pixel source");
  const W = src.width, H = src.height;
  checkDims(W, H);
  let ch = 4, data;
  if (isCanvas(src)) data = new Uint8Array(src.getContext("2d").getImageData(0, 0, W, H).data.buffer);
  else { ch = src instanceof ImageData || src.channels !== 1 ? 4 : 1; data = new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.length); }
  if (data.length !== W * H * ch) throw new TypeError("encodePixelsSync: data length doesn't match the size");
  const tiles = tileGrid(W, H, TILE_LOG2);
  const results = tiles.map((t) => { const px = cut(data, W, ch, t); return { codec: C_RAW, value: 0, bytes: px, crc: crc32(px), h2: hash2(px) }; });
  const prev = lastEnc.get(src)?.enc;
  if (prev && prev.width === W && prev.height === H && prev.channels === ch && results.every((r, i) => prev.tiles[i].codec !== C_REF && r.crc === prev.tiles[i].crc && r.h2 === prev.tiles[i].h2)) return prev;
  const { parts, dirCrc, tiles: meta } = buildDir(W, H, ch, results.map((r) => { const s = solidOfSync(r.bytes, ch); return s >= 0 ? { codec: C_SOLID, value: s, crc: r.crc, h2: r.h2 } : r; }));
  return new EncodedPixels(W, H, ch, new Blob(parts), dirCrc, Object.freeze(meta), "fast");
}

// ── write ────────────────────────────────────────────────────────────────────
const blobCrc = new WeakMap(); // Blob → crc32 (files are re-saved often; read each once)
async function crcOfBlob(b) {
  let c = blobCrc.get(b);
  if (c === undefined) {
    c = b.size > 4 * 2 ** 20 ? (await task({ op: "crc", blob: b })).crc : crc32(new Uint8Array(await b.arrayBuffer()));
    blobCrc.set(b, c);
  }
  return c;
}
/** Walk the doc: JSON-able copy with chunk refs; `add(kind, value)` → chunk index. */
function walk(v, add, depth = 0) {
  if (depth > LIMITS.depth) throw new TypeError("qcut: doc nests too deep");
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v === undefined || typeof v === "function" || typeof v === "symbol") return undefined;
  if (typeof v === "bigint") throw new TypeError("qcut: BigInt values aren't supported in the doc");
  if (isPixels(v)) { const i = add("px", v); return { $c: i, w: v.width, h: v.height, ch: v instanceof EncodedPixels ? v.channels : isCanvas(v) || v instanceof ImageData || v.channels !== 1 ? 4 : 1 }; }
  if (v instanceof Blob) {
    const r = { $c: add("blob", v) };
    if (v.type) r.mime = v.type;
    if (typeof File !== "undefined" && v instanceof File) { r.name = v.name; r.lm = v.lastModified; }
    return r;
  }
  if (v instanceof ArrayBuffer) return { $c: add("arr", new Uint8Array(v), 1), as: "ArrayBuffer" };
  if (ArrayBuffer.isView(v)) {
    const as = v.constructor?.name;
    if (!TYPED[as] || TYPED[as] !== v.constructor) throw new TypeError(`qcut: ${as} isn't supported in the doc`);
    return { $c: add("arr", new Uint8Array(v.buffer, v.byteOffset, v.byteLength), v.BYTES_PER_ELEMENT), as };
  }
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => { const y = walk(x, add, depth + 1); return y === undefined ? null : y; });
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`qcut: ${proto?.constructor?.name || "this object"} can't be saved in the doc`);
  const o = {};
  for (const k of Object.keys(v)) {
    if (k === "$c") throw new TypeError('qcut: "$c" is a reserved key');
    const y = walk(v[k], add, depth + 1);
    if (y !== undefined) o[k] = y;
  }
  return o;
}
function assemble(type, metaDoc, previewRef, chunks) {
  const meta = new TextEncoder().encode(JSON.stringify({ app: "QuickCut", type, doc: metaDoc, preview: previewRef }));
  if (meta.length > LIMITS.meta) throw new QcutError("too-big", "the project index is too big");
  if (chunks.length > LIMITS.chunks) throw new QcutError("too-big", "too many layers and files");
  const head = new Uint8Array(HEAD + ENTRY * chunks.length + meta.length), dv = new DataView(head.buffer);
  head.set(MAGIC, 0);
  dv.setUint16(8, VERSION.major, true); dv.setUint16(10, VERSION.minor, true);
  dv.setUint32(12, 0, true); dv.setUint32(16, chunks.length, true); dv.setUint32(20, meta.length, true);
  let off = head.length;
  chunks.forEach((c, i) => {
    const e = HEAD + i * ENTRY;
    dv.setBigUint64(e, BigInt(off), true); dv.setBigUint64(e + 8, BigInt(c.blob.size), true);
    dv.setUint32(e + 16, c.crc ?? 0, true); head[e + 20] = c.type; head[e + 21] = c.enc; dv.setUint16(e + 22, c.crc === null ? F_NOCRC : 0, true);
    dv.setBigUint64(e + 24, BigInt(c.raw), true);
    off += c.blob.size;
  });
  head.set(meta, HEAD + ENTRY * chunks.length);
  dv.setBigUint64(24, BigInt(off), true);
  const c0 = crc32(head.subarray(0, 32));
  dv.setUint32(32, crc32(head.subarray(36), c0), true); // covers everything in the head except the CRC itself
  return new Blob([head, ...chunks.map((c) => c.blob)], { type: MIME });
}
function collect(doc, preview) {
  const vals = [];
  const add = (kind, v, esize = 1) => { vals.push({ kind, v, esize }); return vals.length - 1; };
  let previewRef = null;
  if (preview != null) {
    if (!(preview instanceof Blob) || !PREVIEW_TYPES.has(preview.type)) throw new TypeError("qcut: preview must be a WebP/JPEG/PNG/AVIF Blob");
    previewRef = { $c: add("blob", preview), mime: preview.type };
  }
  const metaDoc = walk(doc, add);
  return { vals, metaDoc, previewRef };
}
// Typed arrays (keyframe times, waveform peaks, …): each byte minus the same byte of the previous
// element, byte planes one after another, then deflate. Smooth or evenly spaced numbers turn into
// long runs (measured: keyframe times 49% smaller than plain deflate, thumbnail times 89%).
const SHUF = { 2: E_SHUF2, 4: E_SHUF4, 8: E_SHUF8 }, SHUF_SIZE = { [E_SHUF2]: 2, [E_SHUF4]: 4, [E_SHUF8]: 8 };
function shuffle(u8, k) {
  const n = u8.length / k, out = new Uint8Array(u8.length);
  for (let j = 0; j < k; j++) { let prev = 0; for (let i = 0, o = j * n; i < n; i++, o++) { const v = u8[i * k + j]; out[o] = v - prev; prev = v; } }
  return out;
}
function unshuffle(s, k) {
  const n = s.length / k, out = new Uint8Array(s.length);
  for (let j = 0; j < k; j++) { let prev = 0; for (let i = 0, o = j * n; i < n; i++, o++) { prev = (prev + s[o]) & 255; out[i * k + j] = prev; } }
  return out;
}
async function encodeArray(v, esize, mode) {
  if (v.length > LIMITS.bytes) throw new QcutError("too-big", "an array in the project is over 2 GiB");
  const tries = [deflate(v).then((z) => [E_DEFLATE, z])];
  if (SHUF[esize] && v.length >= 64 && v.length % esize === 0 && mode !== "fast") tries.push(deflate(shuffle(v, esize)).then((z) => [SHUF[esize], z]));
  let best = [E_STORE, v.slice()];
  for (const [enc, z] of await Promise.all(tries)) if (z.length < best[1].length) best = [enc, z];
  return { type: T_BYTES, enc: best[0], blob: new Blob([best[1]]), crc: crc32(best[1]), raw: v.length };
}
/** Identical tiles anywhere in the file are stored once: later copies become C_REF entries. */
function shareTiles(chunks) {
  const seen = new Map();
  chunks.forEach((c, ci) => {
    const e = c.px;
    if (!e || !e.tiles) return;
    const grid = tileGrid(e.width, e.height, TILE_LOG2), dataStart = DIR_HEAD + DIR_ENTRY * e.tiles.length;
    let shared = 0;
    const results = e.tiles.map((t, ti) => {
      if (t.codec === C_SOLID || t.codec === C_REF || t.h2 === undefined) return t;
      const key = `${t.crc}:${t.h2}:${grid[ti].w}:${grid[ti].h}:${e.channels}`, first = seen.get(key);
      if (first) { shared++; return { codec: C_REF, chunk: first[0], tile: first[1], crc: t.crc, h2: t.h2 }; }
      seen.set(key, [ci, ti]);
      return t;
    });
    if (!shared) return;
    const { parts, dirCrc } = buildDir(e.width, e.height, e.channels, results.map((t) => (t.codec === C_SOLID || t.codec === C_REF ? t : { ...t, bytes: e.blob.slice(dataStart + t.off, dataStart + t.off + t.len) })));
    c.blob = new Blob(parts); c.crc = dirCrc;
  });
  return chunks;
}
const pxChunk = (e) => ({ type: T_PIXELS, enc: 0, blob: e.blob, crc: e.dirCrc, raw: e.width * e.height * e.channels, px: e });
/**
 * Write a project file. `type`: "photo" | "video" | …; `doc`: the project (see top of file);
 * `preview`: a small image Blob shown before anything else loads. → Blob (application/x-quickcut)
 * `mode`: "best" (default; explicit saves), "quick" (autosave: one codec per tile) or "fast" (no
 * compression). `rev(src)`: optional; returns the app's version number for a pixel source, so an
 * unchanged layer is reused without reading its pixels (see encodePixels).
 */
export async function write({ type, doc, preview = null }, { mode = "best", rev = null } = {}) {
  if (typeof type !== "string" || !type) throw new TypeError("qcut.write: type is required");
  const { vals, metaDoc, previewRef } = collect(doc, preview);
  const chunks = await Promise.all(vals.map(async ({ kind, v, esize }) => {
    if (kind === "px") return pxChunk(await encodePixels(v, { mode, rev: rev ? rev(v) : undefined }));
    if (kind === "blob") { if (v.size > LIMITS.bytes) throw new QcutError("too-big", "a file in the project is over 2 GiB"); return { type: T_BYTES, enc: E_STORE, blob: v, crc: await crcOfBlob(v), raw: v.size }; }
    return encodeArray(v, esize, mode);
  }));
  return assemble(type, metaDoc, previewRef, shareTiles(chunks));
}
/** Write without waiting (page closing): pixels uncompressed (or as last encoded, if unchanged), arrays stored, blobs unchecked unless hashed before. */
export function writeSync({ type, doc, preview = null }) {
  if (typeof type !== "string" || !type) throw new TypeError("qcut.writeSync: type is required");
  const { vals, metaDoc, previewRef } = collect(doc, preview);
  const chunks = vals.map(({ kind, v }) => {
    if (kind === "px") return pxChunk(encodePixelsSync(v));
    if (kind === "blob") return { type: T_BYTES, enc: E_STORE, blob: v, crc: blobCrc.has(v) ? blobCrc.get(v) : null, raw: v.size };
    const c = v.slice();
    return { type: T_BYTES, enc: E_STORE, blob: new Blob([c]), crc: crc32(c), raw: c.length };
  });
  return assemble(type, metaDoc, previewRef, shareTiles(chunks));
}

// ── read ─────────────────────────────────────────────────────────────────────
/** Is this a .qcut file? (reads 8 bytes) */
export async function sniff(blob) {
  if (!(blob instanceof Blob) || blob.size < HEAD) return false;
  const b = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  return MAGIC.every((m, i) => b[i] === m);
}
const u64 = (dv, o) => { const v = dv.getBigUint64(o, true); if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw bad("a size is out of range"); return Number(v); };
/** A value stored in the file: pixels or bytes. `load()` reads, checks and decodes it. */
export class Ref {
  constructor(file, i, info) { this._f = file; this.index = i; Object.assign(this, info); }
  load(opts) { return this._f._load(this, opts); }
}
const DANGER = new Set(["__proto__", "constructor", "prototype"]);
/**
 * Open a .qcut Blob/File. Reads only the header and index (checks magic, version, CRC, every offset and
 * length); layers load on demand. Throws QcutError: code "not-qcut", "newer", "truncated", "corrupt",
 * "too-big" or "unsupported".
 */
export async function read(blob) {
  if (!(blob instanceof Blob)) throw new TypeError("qcut.read: expected a Blob or File");
  const size = blob.size;
  if (size < HEAD) throw new QcutError(size >= 8 && (await sniff2(blob)) ? "truncated" : "not-qcut", "not a QuickCut project");
  const first = new Uint8Array(await blob.slice(0, Math.min(size, 256 * 1024)).arrayBuffer());
  if (!MAGIC.every((m, i) => first[i] === m)) throw new QcutError("not-qcut", "not a QuickCut project");
  const dv0 = new DataView(first.buffer);
  const major = dv0.getUint16(8, true), minor = dv0.getUint16(10, true), required = dv0.getUint32(12, true);
  if (major > VERSION.major || (required & ~KNOWN_REQUIRED)) throw new QcutError("newer", "this project was made by a newer version of QuickCut");
  if (major < 2) throw new QcutError("unsupported", "unknown project version"); // 1.x was a pre-release format
  const N = dv0.getUint32(16, true), J = dv0.getUint32(20, true), total = u64(dv0, 24);
  if (N > LIMITS.chunks || J > LIMITS.meta || J < 2) throw bad("index sizes are out of range");
  if (total > size) throw new QcutError("truncated", "the project file is incomplete");
  if (total !== size) throw bad("the file length doesn't match");
  const headEnd = HEAD + ENTRY * N + J;
  if (headEnd > size) throw new QcutError("truncated", "the project file is incomplete");
  const head = headEnd <= first.length ? first.subarray(0, headEnd) : new Uint8Array(await blob.slice(0, headEnd).arrayBuffer());
  if (head.length !== headEnd) throw new QcutError("truncated", "the project file is incomplete");
  const dv = new DataView(head.buffer, head.byteOffset, head.length);
  if (crc32(head.subarray(36), crc32(head.subarray(0, 32))) !== dv.getUint32(32, true)) throw bad("the project index is damaged");
  const chunks = [];
  for (let i = 0; i < N; i++) {
    const e = HEAD + i * ENTRY;
    const c = { i, off: u64(dv, e), len: u64(dv, e + 8), crc: dv.getUint32(e + 16, true), type: head[e + 20], enc: head[e + 21], flags: dv.getUint16(e + 22, true), raw: u64(dv, e + 24) };
    if (c.off < headEnd || c.off + c.len > size) throw bad("a chunk lies outside the file");
    if (c.len > LIMITS.bytes * 1.25 || c.raw > Math.max(LIMITS.bytes, LIMITS.area * 4)) throw bad("a chunk is too big");
    chunks.push(c);
  }
  const sorted = [...chunks].sort((a, b) => a.off - b.off);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].off < sorted[i - 1].off + sorted[i - 1].len) throw bad("chunks overlap");
  let meta;
  try { meta = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(HEAD + ENTRY * N))); } catch { throw bad("the project index isn't valid"); }
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || typeof meta.type !== "string") throw bad("the project index isn't valid");
  return new QcutFile(blob, { major, minor }, meta, chunks);
}
async function sniff2(blob) { const b = new Uint8Array(await blob.slice(0, 8).arrayBuffer()); return MAGIC.every((m, i) => b[i] === m); }

export class QcutFile {
  constructor(blob, version, meta, chunks) {
    this.blob = blob; this.version = version; this.type = meta.type; this._chunks = chunks; this.refs = [];
    let nodes = 0;
    const live = (v, depth) => {
      if (++nodes > LIMITS.nodes) throw bad("the project index is too big");
      if (depth > LIMITS.depth) throw bad("the project index nests too deep");
      if (v === null || typeof v !== "object") return v;
      if (Array.isArray(v)) return v.map((x) => live(x, depth + 1));
      if ("$c" in v) return this._ref(v);
      const o = {};
      for (const k of Object.keys(v)) if (!DANGER.has(k)) o[k] = live(v[k], depth + 1);
      return o;
    };
    this.doc = live(meta.doc ?? null, 0);
    this._preview = meta.preview && typeof meta.preview === "object" ? this._ref(meta.preview) : null;
    if (this._preview && (this._preview.kind !== "bytes" || !PREVIEW_TYPES.has(this._preview.mime))) this._preview = null;
  }
  _ref(v) {
    const i = v.$c, c = Number.isInteger(i) && i >= 0 && i < this._chunks.length ? this._chunks[i] : null;
    if (!c) throw bad("a reference points nowhere");
    let info;
    if (c.type === T_PIXELS) {
      const w = v.w, h = v.h, ch = v.ch;
      if (!Number.isInteger(w) || !Number.isInteger(h) || (ch !== 1 && ch !== 4)) throw bad("a layer's size is missing");
      checkDimsRead(w, h);
      if (c.raw !== w * h * ch) throw bad("a layer's size doesn't match");
      info = { kind: "pixels", width: w, height: h, channels: ch };
    } else if (c.type === T_BYTES) {
      const as = typeof v.as === "string" ? v.as : null;
      if (as && as !== "ArrayBuffer" && !TYPED[as]) throw bad("unknown array type");
      info = { kind: "bytes", size: c.raw, mime: typeof v.mime === "string" ? v.mime.slice(0, 200) : "", name: typeof v.name === "string" ? v.name.slice(0, 1024) : null, lastModified: Number.isFinite(v.lm) ? v.lm : undefined, as };
    } else info = { kind: "unknown" };
    const r = new Ref(this, i, info);
    this.refs.push(r);
    return r;
  }
  /** The preview image (Blob) or null; read straight after the index, before any layer. */
  async preview() {
    if (!this._preview) return null;
    try { return await this._preview.load(); } catch { return null; }
  }
  async _bytes(c) {
    const u8 = new Uint8Array(await this.blob.slice(c.off, c.off + c.len).arrayBuffer());
    if (u8.length !== c.len) throw new QcutError("truncated", "the project file is incomplete");
    return u8;
  }
  async _load(ref, opts = {}) {
    const c = this._chunks[ref.index];
    if (ref.kind === "pixels") return this._pixels(ref, c, opts);
    if (ref.kind !== "bytes") throw new QcutError("unsupported", "this part of the project needs a newer QuickCut");
    if (c.enc !== E_STORE && c.enc !== E_DEFLATE && !SHUF_SIZE[c.enc]) throw new QcutError("unsupported", "this part of the project needs a newer QuickCut");
    if (c.enc === E_STORE && c.len !== c.raw) throw bad("stored size doesn't match");
    let u8 = null;
    if (!(c.flags & F_NOCRC)) {
      if (c.enc === E_STORE && c.len > 4 * 2 ** 20) {
        const { crc } = await task({ op: "crc", blob: this.blob.slice(c.off, c.off + c.len) });
        if (crc !== c.crc) throw bad("a stored file is damaged");
      } else { u8 = await this._bytes(c); if (crc32(u8) !== c.crc) throw bad("a stored file is damaged"); }
    }
    if (c.enc !== E_STORE) u8 = await inflate(u8 || (await this._bytes(c)), c.raw);
    if (SHUF_SIZE[c.enc]) { if (c.raw % SHUF_SIZE[c.enc]) throw bad("array length doesn't fit its encoding"); u8 = unshuffle(u8, SHUF_SIZE[c.enc]); }
    if (ref.as) {
      u8 ||= await this._bytes(c);
      if (ref.as === "ArrayBuffer") return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length);
      const T = TYPED[ref.as];
      if (u8.length % T.BYTES_PER_ELEMENT) throw bad("array length doesn't fit its type");
      const a = u8.byteOffset % T.BYTES_PER_ELEMENT ? u8.slice() : u8;
      return new T(a.buffer, a.byteOffset, a.length / T.BYTES_PER_ELEMENT);
    }
    const blob = u8 ? new Blob([u8], { type: ref.mime }) : this.blob.slice(c.off, c.off + c.len, ref.mime);
    return ref.name !== null && typeof File !== "undefined" ? new File([blob], ref.name, { type: ref.mime, lastModified: ref.lastModified }) : blob;
  }
  /** Parse and check one PIXELS chunk's tile directory (cached). → { W, H, ch, tiles } */
  _dir(ci) {
    this._dirs ||= new Map();
    let p = this._dirs.get(ci);
    if (!p) { p = this._readDir(ci); this._dirs.set(ci, p); }
    return p;
  }
  async _readDir(ci) {
    const c = this._chunks[ci];
    if (c.type !== T_PIXELS || c.len < DIR_HEAD) throw bad("a layer is damaged");
    const h0 = new DataView(await this.blob.slice(c.off, c.off + DIR_HEAD).arrayBuffer());
    if (h0.byteLength !== DIR_HEAD) throw new QcutError("truncated", "the project file is incomplete");
    const W = h0.getUint32(0, true), H = h0.getUint32(4, true), ch = h0.getUint8(8), log2 = h0.getUint8(9), n = h0.getUint32(12, true);
    if (ch !== 1 && ch !== 4) throw bad("a layer's channel count is invalid");
    checkDimsRead(W, H);
    if (W * H * ch !== c.raw) throw bad("a layer's size doesn't match");
    if (log2 < 8 || log2 > 12) throw bad("a layer's tile size is out of range");
    const tiles = tileGrid(W, H, log2);
    if (n !== tiles.length) throw bad("a layer's tile count doesn't match");
    const dirLen = DIR_HEAD + DIR_ENTRY * n, dataLen = c.len - dirLen;
    if (dataLen < 0) throw bad("a layer is damaged");
    const dir = new Uint8Array(await this.blob.slice(c.off, c.off + dirLen).arrayBuffer());
    if (crc32(dir) !== c.crc) throw bad("a layer's index is damaged");
    const dv = new DataView(dir.buffer), base = c.off + dirLen;
    tiles.forEach((t, i) => {
      const e = DIR_HEAD + i * DIR_ENTRY;
      t.codec = dir[e + 12]; t.crc = dv.getUint32(e + 8, true);
      if (!CODECS.has(t.codec)) throw new QcutError("unsupported", "this layer needs a newer QuickCut");
      if (t.codec === C_QOI && ch !== 4) throw bad("a tile's codec doesn't fit the layer");
      if (t.codec === C_SOLID) { t.value = dv.getUint32(e, true); if (dv.getUint32(e + 4, true) !== 0) throw bad("a solid tile has data"); if (ch === 1 && t.value > 255) throw bad("a solid tile's value is out of range"); return; }
      if (t.codec === C_REF) { // a copy of an earlier tile: (chunk, tile) must come before this one
        t.rc = dv.getUint32(e, true); t.rt = dv.getUint32(e + 4, true);
        if (!(t.rc < ci || (t.rc === ci && t.rt < i)) || this._chunks[t.rc].type !== T_PIXELS) throw bad("a shared tile points nowhere");
        return;
      }
      const off = dv.getUint32(e, true), len = dv.getUint32(e + 4, true), raw = t.w * t.h * ch;
      if (off + len > dataLen || len === 0) throw bad("a tile lies outside its layer");
      if (len > raw + 4096 || (t.codec === C_RAW && len !== raw)) throw bad("a tile's length is out of range");
      t.off = base + off; t.len = len;
    });
    return { W, H, ch, tiles };
  }
  /** The tile whose data a tile uses: itself, or the one a shared (C_REF) tile points at. */
  async _source(t, ch) {
    if (t.codec !== C_REF) return t;
    const d = await this._dir(t.rc), s = d.tiles[t.rt];
    if (!s || s.codec === C_REF || s.w !== t.w || s.h !== t.h || d.ch !== ch) throw bad("a shared tile points nowhere");
    return s;
  }
  /**
   * Decode a pixel layer. Default → ImageData (4 channels) or {width, height, channels: 1, data}.
   * `into`: a canvas / OffscreenCanvas / 2D context to draw the tiles into (no extra full-size copy) → it.
   * `onTile(x, y, w, h)`: progress, called as each tile lands.
   * `focus`: {x, y, w, h} in layer pixels (e.g. the part on screen): those tiles are decoded first,
   * then the rest by distance from it.
   */
  async _pixels(ref, c, { into = null, onTile = null, focus = null } = {}) {
    const { W, H, ch, tiles: all } = await this._dir(ref.index);
    if (W !== ref.width || H !== ref.height || ch !== ref.channels) throw bad("a layer's size doesn't match");
    let tiles = all;
    if (focus && Number.isFinite(focus.x) && Number.isFinite(focus.y)) {
      const fx = focus.x + (focus.w || 0) / 2, fy = focus.y + (focus.h || 0) / 2, fw = (focus.w || 0) / 2, fh = (focus.h || 0) / 2;
      const dist = (t) => Math.max(0, Math.abs(t.x + t.w / 2 - fx) - fw - t.w / 2) + Math.max(0, Math.abs(t.y + t.h / 2 - fy) - fh - t.h / 2) + 1e-6 * (Math.abs(t.x + t.w / 2 - fx) + Math.abs(t.y + t.h / 2 - fy));
      tiles = [...all].sort((a, b) => dist(a) - dist(b));
    }
    let ctx = null, out = null;
    if (into) {
      if (ch !== 4) throw new TypeError("load({into}): only 4-channel layers draw into a canvas");
      ctx = typeof into.getContext === "function" ? into.getContext("2d") : into;
      if (!ctx || typeof ctx.putImageData !== "function") throw new TypeError("load({into}): needs a canvas or a 2D context");
    } else out = ch === 4 ? new ImageData(W, H) : { width: W, height: H, channels: 1, data: new Uint8Array(W * H) };
    const dst = out && (ch === 4 ? new Uint8Array(out.data.buffer) : out.data);
    await Promise.all(tiles.map(async (t) => {
      await slot();
      let r;
      try {
        const s = await this._source(t, ch);
        r = await task({ op: "dec", codec: s.codec, value: s.value ?? 0, crc: t.crc, w: t.w, h: t.h, ch, blob: s.codec === C_SOLID ? null : this.blob.slice(s.off, s.off + s.len) });
      } finally { release(); }
      const px = r.px;
      if (px.length !== t.w * t.h * ch) throw bad("a tile decoded to the wrong size");
      if (ctx) ctx.putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.length), t.w, t.h), t.x, t.y);
      else { const row = t.w * ch; for (let y = 0; y < t.h; y++) dst.set(px.subarray(y * row, (y + 1) * row), ((t.y + y) * W + t.x) * ch); }
      onTile?.(t.x, t.y, t.w, t.h);
    }));
    return into || out;
  }
  /** Every value in the doc loaded (pixels → ImageData / 1-channel object, bytes → Blob/File/array). */
  async loadAll({ onProgress = null } = {}) {
    let done = 0;
    const total = this.refs.length;
    const res = new Map();
    await Promise.all(this.refs.map(async (r) => { res.set(r, await r.load()); onProgress?.(++done, total); }));
    const swap = (v) => (v instanceof Ref ? res.get(v) : Array.isArray(v) ? v.map(swap) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v);
    return swap(this.doc);
  }
}
function checkDimsRead(w, h) { if (!(w >= 1 && h >= 1 && w <= LIMITS.side && h <= LIMITS.side && w * h <= LIMITS.area)) throw bad("a layer's size is out of range"); }

// ── video source link ────────────────────────────────────────────────────────
/**
 * A fingerprint to re-link a video (never copied into the project): name, size, date and a SHA-256
 * of its size + first, middle and last MiB (fast even for huge files).
 */
export async function fingerprint(file) {
  const S = 2 ** 20, n = file.size;
  const parts = n <= 3 * S ? [file] : [file.slice(0, S), file.slice(Math.floor(n / 2) - S / 2, Math.floor(n / 2) + S / 2), file.slice(n - S)];
  const sz = new Uint8Array(8); new DataView(sz.buffer).setBigUint64(0, BigInt(n), true);
  const data = new Uint8Array(await new Blob([sz, ...parts]).arrayBuffer());
  let hash;
  try { hash = "sha256:" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
  catch { hash = "crc32:" + crc32(data).toString(16).padStart(8, "0"); }
  return { name: file.name, size: n, lastModified: file.lastModified, type: file.type, hash };
}
