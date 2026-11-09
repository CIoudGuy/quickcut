// QuickCut Photo background remover (Worker). Everything runs on the device:
// 1. the model and the ONNX Runtime WebAssembly binary are fetched once from our own site (in parts
//    of ≤ 20 MiB), checked against their SHA-256 and only then kept in Cache Storage (offline
//    afterwards; a cancelled or damaged download never leaves anything behind);
// 2. the model runs at its native size (512² Fast, 1024² High detail) on the GPU (WebGPU) or,
//    without it, on the CPU (WASM);
// 3. its mask is refined at full resolution with a colour guided filter (edges follow the photo's
//    own edges, so 4K+ photos stay crisp) and the edge colours are decontaminated (blur-fusion
//    foreground estimation), so no halo of the old background is left in hair and soft edges.
// Memory: one model session at a time; after IDLE_MS without work the session (and its GPU
// buffers) is released and {idle: true} is posted, so the page can end the worker (that also frees
// the WebAssembly heap, which can't shrink); it restarts from Cache Storage in a few seconds.
import { boxF, alphaToImageData } from "./maskops.js";

const VENDOR = new URL("../vendor/ort/", import.meta.url).href;
const MODELS = new URL("../models/", import.meta.url).href;
const CACHE = "quickcut-models-v1";
const WORK = 1024; // long side of the refinement grid (the full-res pass samples it)
const IDLE_MS = 60000;
let ort = null; // ONNX Runtime is loaded on first use (status answers without it, so the page hears back at once)
let session = null, sessionKey = "", usedEp = "", man = null, warmed = false, curModel = null;
let aborter = new AbortController(); // cancels the downloads in flight ({op: "cancel"})
let idleTimer = 0, busy = 0;

// one job at a time (a warm-up and a click must not load the model twice); "cancel" jumps the queue
let queue = Promise.resolve();
onmessage = (e) => {
  const m = e.data;
  clearTimeout(idleTimer);
  if (m.op === "cancel") { aborter.abort(); aborter = new AbortController(); return reply(m.id, { cancelled: true }); }
  // a sign of life within a frame of the click, before any queued work or module loading
  if (m.op === "init" || m.op === "run" || m.op === "warm") progress(m.id, { stage: "start" });
  busy++;
  queue = queue.then(() => handle(m)).finally(() => { if (--busy === 0) idleTimer = setTimeout(goIdle, IDLE_MS); });
};
async function goIdle() {
  if (busy) return;
  if (session) { try { await session.release(); } catch {} }
  session = null; sessionKey = ""; warmed = false; curModel = null;
  postMessage({ idle: true });
}
async function handle(m) {
  try {
    if (m.op === "status") return reply(m.id, await status(m));
    if (m.op === "remove") return reply(m.id, await remove(m));
    if (m.op === "init") return reply(m.id, await init(m));
    if (m.op === "warm") {
      // start the model and compile its GPU shaders ahead of the click (only when it's already cached)
      const st = await status(m);
      if (!st.cached || st.models[st.model].unfit) return reply(m.id, { warmed: false });
      const r = await init(m);
      if (!warmed) { warmed = true; const md = session.inputMetadata?.[0], S0 = md?.shape?.[2]; await infer(new OffscreenCanvas(8, 8), typeof S0 === "number" ? S0 : 1024); }
      return reply(m.id, { warmed: true, ...r });
    }
    if (m.op === "run") {
      const r = await run(m);
      return reply(m.id, r, [r.mask, r.alpha.buffer, r.color].filter(Boolean));
    }
  } catch (err) {
    postMessage({ id: m.id, error: String(err?.message || err), cancelled: !!err?.cancelled });
  }
}
const reply = (id, out, transfer = []) => postMessage({ id, ...out }, transfer);
const progress = (id, o) => postMessage({ id, progress: true, ...o });

// ── files: our own site → Cache Storage, verified ──────────────────────────
async function manifest() {
  if (man) return man;
  const url = MODELS + "manifest.json";
  let cache = null;
  try { cache = await caches.open(CACHE); } catch {}
  try {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    man = await r.clone().json();
    try { await cache?.put(url, r); } catch {}
  } catch (err) {
    const hit = await cache?.match(url);
    if (!hit) throw new Error("The background remover isn't installed on this site yet (model files missing).");
    man = await hit.json();
  }
  // housekeeping: drop cached files this manifest no longer lists (old versions, removed models)
  try {
    const keep = new Set([url, ...Object.values(man.files).map(keyOf)]);
    for (const req of (await cache?.keys()) || []) if (req.url.startsWith(MODELS) && !keep.has(req.url)) await cache.delete(req);
  } catch {}
  return man;
}
const keyOf = (f) => `${MODELS}${f.file}?sha256=${f.sha256}`;
async function isCached(f) {
  try { return !!(await (await caches.open(CACHE)).match(keyOf(f))); } catch { return false; }
}
/** What this device's GPU offers (feature detection; nothing is guessed from the browser name). */
let gpuInfo = null;
async function gpuCaps() {
  if (gpuInfo) return gpuInfo;
  gpuInfo = { webgpu: false };
  try {
    const ad = self.navigator?.gpu && (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }));
    if (ad) {
      const L = ad.limits;
      gpuInfo = { webgpu: true, f16: ad.features.has("shader-f16"), maxBuffer: L.maxBufferSize, maxBinding: L.maxStorageBufferBindingSize, maxBuffersPerStage: L.maxStorageBuffersPerShaderStage, vendor: ad.info?.vendor || "", architecture: ad.info?.architecture || "", fallback: !!ad.info?.isFallbackAdapter };
    }
  } catch {}
  return gpuInfo;
}
/** Why a model can't run on this device ("" when it can). Models marked `gpu` need WebGPU with 16-bit floats. */
function unfit(md, gpu) {
  if (!md.gpu) return "";
  if (!gpu.webgpu || gpu.fallback) return "Needs GPU access (WebGPU), which this browser doesn't give";
  if (!gpu.f16) return "Needs a GPU with 16-bit float support";
  if (gpu.maxBuffer < 1 << 30 || gpu.maxBinding < 1 << 30) return "This GPU's memory limits are too small for it";
  if (self.navigator?.deviceMemory && navigator.deviceMemory < 8) return "Needs at least 8 GB of memory";
  return "";
}
async function status({ model }) {
  const mf = await manifest();
  const gpu = await gpuCaps();
  const rt = mf.files[mf.runtime], cr = await isCached(rt);
  const models = {};
  for (const [id, md] of Object.entries(mf.models)) {
    const f = mf.files[md.file], c = await isCached(f);
    models[id] = { ...md, size: f.size, cached: c, bytes: (c ? 0 : f.size) + (cr ? 0 : rt.size), unfit: unfit(md, gpu) };
  }
  const id = mf.models[model] ? model : mf.default;
  // what is stored on this device (for "Downloaded · 210 MB · Remove"): each model, plus the runtime
  const stored = Object.values(models).reduce((a, m) => a + (m.cached ? m.size : 0), 0) + (cr ? rt.size : 0);
  return { cached: models[id].bytes === 0, bytes: models[id].bytes, model: id, models, stored, runtime: { size: rt.size, cached: cr }, gpu, threads: self.crossOriginIsolated };
}
/**
 * Uninstall: the given models (all when none are named) are deleted from Cache Storage, and the
 * ONNX Runtime binary too once no model is left. The session is released first (one job at a time,
 * so a running job has finished). The next use downloads again as on first use.
 */
async function remove({ models: ids }) {
  const mf = await manifest();
  if (session) { try { await session.release(); } catch {} }
  session = null; sessionKey = ""; warmed = false; curModel = null;
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { return { freed: 0 }; }
  const all = Object.keys(mf.models), drop = new Set(ids?.length ? ids.filter((i) => mf.models[i]) : all);
  let freed = 0;
  const del = async (f) => { if (await cache.delete(keyOf(f))) freed += f.size; };
  for (const id of drop) await del(mf.files[mf.models[id].file]);
  const left = [];
  for (const id of all) if (!drop.has(id) && (await isCached(mf.files[mf.models[id].file]))) left.push(id);
  if (!left.length) {
    await del(mf.files[mf.runtime]);
    for (const req of await cache.keys()) if (req.url.startsWith(MODELS)) await cache.delete(req); // anything else of ours
  }
  return { freed, left };
}
function needed(mf, model) {
  const md = mf.models[model] || mf.models[mf.default];
  return [mf.files[mf.runtime], mf.files[md.file]];
}
async function hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const cancelled = () => Object.assign(new Error("cancelled"), { cancelled: true });
/**
 * One file as bytes: from the cache, or downloaded part by part (progress, abortable), verified,
 * then cached. Nothing is written to the cache before the whole file passed its SHA-256 check.
 */
async function getFile(f, onBytes, signal) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch {}
  const key = keyOf(f);
  const hit = await cache?.match(key);
  if (hit) {
    const b = new Uint8Array(await hit.arrayBuffer());
    if (b.length === f.size) return b;
    try { await cache.delete(key); } catch {} // incomplete entry (storage trouble): fetch it again
  }
  const buf = new Uint8Array(f.size);
  let off = 0;
  for (const part of f.parts || [f.file]) {
    if (signal.aborted) throw cancelled();
    let r;
    try { r = await fetch(MODELS + part, { cache: "no-store", signal }); }
    catch { if (signal.aborted) throw cancelled(); throw new Error("Couldn't download the model. Check the connection and try again."); }
    if (!r.ok) throw new Error(`Couldn't download the model (HTTP ${r.status}).`);
    const rd = r.body.getReader();
    try {
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        if (off + value.length > buf.length) throw new Error("The model download was damaged. Try again.");
        buf.set(value, off);
        off += value.length;
        onBytes(value.length);
      }
    } catch (err) { if (signal.aborted) throw cancelled(); throw err; }
  }
  if (off !== f.size) throw new Error("The model download was damaged. Try again.");
  if ((await hex(buf)) !== f.sha256) throw new Error("The model download was damaged (checksum mismatch). Try again.");
  if (signal.aborted) throw cancelled();
  if (cache) {
    try {
      // drop older versions of the same file, then keep this one
      for (const req of await cache.keys()) if (req.url.startsWith(MODELS + f.file + "?") && req.url !== key) await cache.delete(req);
      await cache.put(key, new Response(buf, { headers: { "content-type": "application/octet-stream", "content-length": String(f.size) } }));
    } catch { /* storage full or private mode: works this time, downloads again next time */ }
  }
  return buf;
}

// ── session ──────────────────────────────────────────────────────────────
async function init({ id, model, ep = "auto" }) {
  const mf = await manifest();
  const name = mf.models[model] ? model : mf.default;
  const key = `${name}|${ep}`;
  if (session && sessionKey === key) return { ep: usedEp, model: name, ms: 0, cached: true };
  const t0 = performance.now();
  const [rt, mdf] = needed(mf, name);
  const total = (await isCached(rt) ? 0 : rt.size) + (await isCached(mdf) ? 0 : mdf.size);
  let got = 0, last = 0;
  const onBytes = (n) => {
    got += n;
    const now = performance.now();
    if (now - last > 100 || got === total) { last = now; progress(id, { stage: "download", loaded: got, total }); }
  };
  const signal = aborter.signal;
  const wasm = await getFile(rt, onBytes, signal);
  let bytes = await getFile(mdf, onBytes, signal);
  if (signal.aborted) throw cancelled(); // (a verified, complete file may stay cached: it's not junk)
  const tDl = performance.now();
  progress(id, { stage: "load" });
  ort ??= await import("../vendor/ort/ort.webgpu.min.mjs");
  ort.env.wasm.wasmBinary = wasm;
  ort.env.wasm.wasmPaths = VENDOR;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = "error";
  if (session) { try { await session.release(); } catch {} session = null; }
  warmed = false;
  // laptops/desktops with two GPUs: ask for the fast one (the low-power one is often the default)
  let gpu = false, adapterInfo = null, gpuError = null;
  if (ep !== "wasm" && self.navigator?.gpu) {
    try {
      const ad = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (ad) { gpu = true; adapterInfo = { vendor: ad.info?.vendor || "", architecture: ad.info?.architecture || "" }; ort.env.webgpu.adapter = ad; ort.env.webgpu.powerPreference = "high-performance"; }
    } catch {}
  }
  const opts = { graphOptimizationLevel: "all" };
  if (gpu) {
    try { session = await ort.InferenceSession.create(bytes, { ...opts, executionProviders: ["webgpu"] }); usedEp = "webgpu"; }
    catch (err) { console.warn("bg: WebGPU failed, using the CPU", err); session = null; gpuError = String(err?.message || err).slice(0, 300); }
  }
  if (!session) { session = await ort.InferenceSession.create(bytes, { ...opts, executionProviders: ["wasm"] }); usedEp = "wasm"; }
  bytes = null; // the session holds the weights now; don't keep the file's bytes around
  if (signal.aborted) { try { await session.release(); } catch {} session = null; sessionKey = ""; throw cancelled(); }
  sessionKey = key;
  curModel = mf.models[name];
  logits = null; // decided again for this model on its first run
  return { ep: usedEp, model: name, ms: performance.now() - t0, downloadMs: tDl - t0, loadMs: performance.now() - tDl, threads: ort.env.wasm.numThreads, adapter: adapterInfo, gpuError };
}

// ── inference ────────────────────────────────────────────────────────────
const f16 = (() => {
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  return {
    from(x) { f[0] = x; const b = u[0], s = (b >>> 16) & 0x8000, e = ((b >>> 23) & 0xff) - 112, m = b & 0x7fffff; if (e <= 0) return s; if (e >= 31) return s | 0x7c00; return s | (e << 10) | (m >>> 13); },
    to(h) { const s = (h & 0x8000) << 16, e = (h >>> 10) & 0x1f, m = h & 0x3ff; if (!e) { f[0] = (m / 1024) * 2 ** -14; return s ? -f[0] : f[0]; } u[0] = s | ((e === 31 ? 255 : e + 112) << 23) | (m << 13); return f[0]; },
  };
})();
let logits = null; // does the model output logits (sigmoid applied here) or probabilities? decided on the first run
async function infer(bitmap, S, r = null) {
  const c = new OffscreenCanvas(S, S), g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#FFFFFF"; // transparent pixels read as white, not black
  g.fillRect(0, 0, S, S);
  g.imageSmoothingQuality = "high";
  if (r) g.drawImage(bitmap, r.x, r.y, r.w, r.h, 0, 0, S, S); else g.drawImage(bitmap, 0, 0, S, S);
  const px = g.getImageData(0, 0, S, S).data, N = S * S;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const name = session.inputNames[0];
  const meta = session.inputMetadata?.[0] || session.inputMetadata?.[name];
  const half = /float16/.test(meta?.type || "");
  const data = half ? new Uint16Array(3 * N) : new Float32Array(3 * N);
  for (let ch = 0; ch < 3; ch++) {
    const mu = mean[ch], sd = std[ch], o = ch * N;
    for (let i = 0; i < N; i++) { const v = (px[i * 4 + ch] / 255 - mu) / sd; data[o + i] = half ? f16.from(v) : v; }
  }
  const out = await session.run({ [name]: new ort.Tensor(half ? "float16" : "float32", data, [1, 3, S, S]) });
  const t = out[session.outputNames[session.outputNames.length - 1]];
  const raw = t.data, n = raw.length, side = Math.round(Math.sqrt(n));
  const prob = new Float32Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const v = raw instanceof Uint16Array ? f16.to(raw[i]) : raw[i]; prob[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (logits === null) logits = lo < -0.01 || hi > 1.01;
  if (logits) for (let i = 0; i < n; i++) prob[i] = 1 / (1 + Math.exp(-prob[i])); // logits
  for (const k in out) out[k].dispose?.();
  return { prob, side };
}

/** Bilinear resample of a w0×h0 Float32 map to w×h. */
function resample(src, w0, h0, w, h) {
  const out = new Float32Array(w * h), sx = w0 / w, sy = h0 / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(h0 - 1, Math.max(0, (y + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(h0 - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(w0 - 1, Math.max(0, (x + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(w0 - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * w0 + x0], b = src[y0 * w0 + x1], c = src[y1 * w0 + x0], d = src[y1 * w0 + x1];
      out[y * w + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

/**
 * Colour guided filter (He et al.) of `p` guided by I = (R, G, B) on the work grid. Returns the
 * box-averaged coefficients (aR, aG, aB, b): q = aR·R + aG·G + aB·B + b at any resolution
 * (the "fast guided filter": coefficients are smooth, so they upsample cleanly).
 */
function guided(R, G, B, p, w, h, r, eps) {
  const N = w * h, t = new Float32Array(N);
  const box = (a) => boxF(a, w, h, r, t);
  const mul = (a, b) => { const o = new Float32Array(N); for (let i = 0; i < N; i++) o[i] = a[i] * b[i]; return o; };
  const mR = box(Float32Array.from(R)), mG = box(Float32Array.from(G)), mB = box(Float32Array.from(B)), mp = box(Float32Array.from(p));
  const cR = box(mul(R, p)), cG = box(mul(G, p)), cB = box(mul(B, p));
  const vRR = box(mul(R, R)), vRG = box(mul(R, G)), vRB = box(mul(R, B)), vGG = box(mul(G, G)), vGB = box(mul(G, B)), vBB = box(mul(B, B));
  for (let i = 0; i < N; i++) {
    const r0 = mR[i], g0 = mG[i], b0 = mB[i], m = mp[i];
    const ir = cR[i] - r0 * m, ig = cG[i] - g0 * m, ib = cB[i] - b0 * m;
    const a11 = vRR[i] - r0 * r0 + eps, a12 = vRG[i] - r0 * g0, a13 = vRB[i] - r0 * b0;
    const a22 = vGG[i] - g0 * g0 + eps, a23 = vGB[i] - g0 * b0, a33 = vBB[i] - b0 * b0 + eps;
    // inverse of the symmetric 3×3 covariance
    const i11 = a22 * a33 - a23 * a23, i12 = a13 * a23 - a12 * a33, i13 = a12 * a23 - a13 * a22;
    const i22 = a11 * a33 - a13 * a13, i23 = a12 * a13 - a11 * a23, i33 = a11 * a22 - a12 * a12;
    const det = a11 * i11 + a12 * i12 + a13 * i13 || 1e-12;
    const aR = (ir * i11 + ig * i12 + ib * i13) / det, aG = (ir * i12 + ig * i22 + ib * i23) / det, aB = (ir * i13 + ig * i23 + ib * i33) / det;
    // reuse arrays: a goes into cR/cG/cB, b into mp
    cR[i] = aR; cG[i] = aG; cB[i] = aB; mp[i] = m - aR * r0 - aG * g0 - aB * b0;
  }
  return [box(cR), box(cG), box(cB), box(mp)];
}

/** Blur-fusion foreground estimation (Forte & Pitié 2021), one pass: returns blurred F and B. */
function blurFusion(I, F, Bk, alpha, w, h, r) {
  const N = w * h, t = new Float32Array(N);
  const box = (a) => boxF(a, w, h, r, t);
  const bA = box(Float32Array.from(alpha));
  const outF = [], outB = [];
  for (let c = 0; c < 3; c++) {
    const fa = new Float32Array(N), b1a = new Float32Array(N);
    for (let i = 0; i < N; i++) { fa[i] = F[c][i] * alpha[i]; b1a[i] = Bk[c][i] * (1 - alpha[i]); }
    box(fa); box(b1a);
    for (let i = 0; i < N; i++) { fa[i] /= bA[i] + 1e-5; b1a[i] /= 1 - bA[i] + 1e-5; }
    outF.push(fa); outB.push(b1a);
  }
  return [outF, outB];
}

async function run({ id, bitmap, opts = {} }) {
  if (!session) throw new Error("not ready");
  // "High detail" with a model that has enough pixels of its own (1024²): no tiles, no 2048 grid
  // (measured: tiles cost 4× the time for a small gain, the bigger grid gained nothing)
  if (curModel?.tiles === false) opts = { ...opts, hq: false };
  const W = bitmap.width, H = bitmap.height, t0 = performance.now();
  progress(id, { stage: "run" });
  const md = session.inputMetadata?.[0], S0 = md?.shape?.[2];
  const { prob, side } = await infer(bitmap, typeof S0 === "number" && S0 > 0 ? S0 : 1024);
  const tInfer = performance.now();
  progress(id, { stage: "refine" });
  // work grid: the photo at ≤ WORK px on the long side
  const s = Math.min(1, (opts.work || (opts.hq && !opts.lowMem ? 2048 : WORK)) / Math.max(W, H)), gw = Math.max(1, Math.round(W * s)), gh = Math.max(1, Math.round(H * s)), N = gw * gh;
  const wc = new OffscreenCanvas(gw, gh), wg = wc.getContext("2d", { willReadFrequently: true });
  wg.imageSmoothingQuality = "high";
  wg.drawImage(bitmap, 0, 0, gw, gh);
  const gp = wg.getImageData(0, 0, gw, gh).data;
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
  for (let i = 0; i < N; i++) { R[i] = gp[i * 4] / 255; G[i] = gp[i * 4 + 1] / 255; B[i] = gp[i * 4 + 2] / 255; }
  const p = resample(prob, side, side, gw, gh);
  if (opts.hq && !opts.lowMem && Math.max(W, H) >= side * 1.5) {
    // High quality: run the model again on overlapping tiles (more pixels per detail) and use
    // their result only in the uncertain band around the edges the whole-image pass found, so a
    // tile can't add or drop whole objects (it lacks the global context).
    const k = Math.min(3, Math.max(2, Math.round(Math.max(W, H) / (side * 2.5))));
    const tw = Math.min(W, Math.ceil((W / k) * 1.35)), th = Math.min(H, Math.ceil((H / k) * 1.35));
    const acc = new Float32Array(N), wsum = new Float32Array(N);
    let done = 0;
    for (let ty = 0; ty < k; ty++) for (let tx = 0; tx < k; tx++) {
      const x = Math.round(k === 1 ? 0 : ((W - tw) * tx) / (k - 1)), y = Math.round(k === 1 ? 0 : ((H - th) * ty) / (k - 1));
      const t = await infer(bitmap, side, { x, y, w: tw, h: th });
      progress(id, { stage: "hq", f: ++done / (k * k) });
      const gx0 = Math.floor(x * s), gy0 = Math.floor(y * s), gx1 = Math.min(gw, Math.ceil((x + tw) * s)), gy1 = Math.min(gh, Math.ceil((y + th) * s));
      const fw = gx1 - gx0, fh = gy1 - gy0;
      if (fw < 2 || fh < 2) continue;
      const tp = resample(t.prob, t.side, t.side, fw, fh);
      const ramp = Math.max(1, Math.min(fw, fh) * 0.15);
      for (let yy = 0; yy < fh; yy++) for (let xx = 0; xx < fw; xx++) {
        const d = Math.min(xx + 1, yy + 1, fw - xx, fh - yy), w = Math.min(1, d / ramp);
        const i = (gy0 + yy) * gw + gx0 + xx;
        acc[i] += w * tp[yy * fw + xx]; wsum[i] += w;
      }
    }
    const u = new Float32Array(N);
    for (let i = 0; i < N; i++) u[i] = 1 - Math.abs(2 * p[i] - 1);
    boxF(u, gw, gh, Math.max(2, Math.round(Math.max(gw, gh) / 128)));
    for (let i = 0; i < N; i++) if (wsum[i] > 0) { const w = Math.min(1, u[i] * 6); p[i] += (acc[i] / wsum[i] - p[i]) * w; }
  }
  const scale = Math.max(gw, gh) / 1024;
  const guide = opts.guided !== false;
  let coef = null, wgt = null;
  if (guide) {
    const r = Math.max(2, Math.round((opts.radius ?? 3) * Math.max(1, scale)));
    coef = guided(R, G, B, p, gw, gh, r, opts.eps ?? 1e-3);
    // trust the model where it is sure; use the guided result in the uncertain band around edges
    wgt = new Float32Array(N);
    for (let i = 0; i < N; i++) wgt[i] = 1 - Math.abs(2 * p[i] - 1);
    boxF(wgt, gw, gh, r * 2);
    for (let i = 0; i < N; i++) wgt[i] = Math.min(1, wgt[i] * (opts.band ?? 4));
  }
  // edge colours: blurred foreground/background estimates from the refined work-grid alpha
  let FB = null;
  // low-memory devices skip the colour clean-up on very big photos (it needs a second full-size image)
  if (opts.decon !== false && !(opts.lowMem && W * H > 12e6)) {
    const a = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let v = p[i];
      if (guide) { const q = coef[0][i] * R[i] + coef[1][i] * G[i] + coef[2][i] * B[i] + coef[3][i]; v += (q - v) * wgt[i]; }
      a[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    const I = [R, G, B];
    const r1 = Math.max(2, Math.round(45 * scale)), r2 = Math.max(1, Math.round(3 * scale));
    const [F1, B1] = blurFusion(I, I, I, a, gw, gh, r1);
    // the first pass's F is refined with the image (as in the paper) before the second pass
    for (let c = 0; c < 3; c++) for (let i = 0; i < N; i++) { const v = F1[c][i] + a[i] * (I[c][i] - a[i] * F1[c][i] - (1 - a[i]) * B1[c][i]); F1[c][i] = v < 0 ? 0 : v > 1 ? 1 : v; }
    FB = blurFusion(I, F1, B1, a, gw, gh, r2);
  }
  const tRef = performance.now();
  // full-resolution pass, in strips (bounded memory on 40+ MP photos)
  const alpha = new Uint8Array(W * H);
  const out = FB ? new OffscreenCanvas(W, H) : null, og = out?.getContext("2d");
  const strip = Math.max(1, Math.min(H, Math.floor(8e6 / W)));
  const sc = new OffscreenCanvas(W, strip), sg = sc.getContext("2d", { willReadFrequently: true });
  const fx = gw / W, fy = gh / H;
  // per-column bilinear lookup (same for every row)
  const cx0 = new Int32Array(W), cx1 = new Int32Array(W), ctx_ = new Float32Array(W);
  for (let x = 0; x < W; x++) { const v = Math.min(gw - 1, Math.max(0, (x + 0.5) * fx - 0.5)); cx0[x] = Math.floor(v); cx1[x] = Math.min(gw - 1, cx0[x] + 1); ctx_[x] = v - cx0[x]; }
  const maps = [p]; if (guide) maps.push(coef[0], coef[1], coef[2], coef[3], wgt); if (FB) maps.push(...FB[0], ...FB[1]);
  const v = new Float32Array(maps.length);
  // cells (bilinear quads of the work grid) that are surely background or surely subject: 0 / 255
  // without the per-pixel maths (most of a photo; makes the full-resolution pass several times faster)
  const flat = new Uint8Array(N); // 0 = compute, 1 = all 0, 2 = all 255
  {
    const sure = (i) => (wgt && wgt[i] > 0.002 ? 0 : p[i] < 0.002 ? 1 : p[i] > 0.998 ? 2 : 0);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x, a = sure(i), b = sure(y * gw + Math.min(gw - 1, x + 1)), c = sure(Math.min(gh - 1, y + 1) * gw + x), d = sure(Math.min(gh - 1, y + 1) * gw + Math.min(gw - 1, x + 1));
      flat[i] = a && a === b && a === c && a === d ? a : 0;
    }
  }
  let changed = 0;
  for (let y0 = 0; y0 < H; y0 += strip) {
    const sh = Math.min(strip, H - y0);
    sg.clearRect(0, 0, W, sh);
    sg.drawImage(bitmap, 0, y0, W, sh, 0, 0, W, sh);
    const img = sg.getImageData(0, 0, W, sh), d = img.data;
    for (let yy = 0; yy < sh; yy++) {
      const y = y0 + yy, gy = Math.min(gh - 1, Math.max(0, (y + 0.5) * fy - 0.5)), r0 = Math.floor(gy), r1 = Math.min(gh - 1, r0 + 1), ty = gy - r0;
      const o0 = r0 * gw, o1 = r1 * gw;
      for (let x = 0; x < W; x++) {
        const a0 = o0 + cx0[x];
        const fl = flat[a0];
        if (fl) { alpha[y * W + x] = fl === 2 ? 255 : 0; continue; }
        const a1 = o0 + cx1[x], b0 = o1 + cx0[x], b1 = o1 + cx1[x], tx = ctx_[x];
        const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
        for (let k = 0; k < maps.length; k++) { const M = maps[k]; v[k] = M[a0] * w00 + M[a1] * w01 + M[b0] * w10 + M[b1] * w11; }
        const o = (yy * W + x) * 4, Rr = d[o] / 255, Gg = d[o + 1] / 255, Bb = d[o + 2] / 255;
        let al = v[0];
        if (guide) { const q = v[1] * Rr + v[2] * Gg + v[3] * Bb + v[4]; al += (q - al) * v[5]; }
        al = al < 0 ? 0 : al > 1 ? 1 : al;
        const ab = Math.round(al * 255);
        alpha[y * W + x] = ab;
        if (FB && ab < 252 && ab > 0) {
          const j = guide ? 6 : 1;
          const c = [Rr, Gg, Bb];
          for (let ch = 0; ch < 3; ch++) {
            const bf = v[j + ch], bb = v[j + 3 + ch];
            let f = bf + al * (c[ch] - al * bf - (1 - al) * bb);
            f = f < 0 ? 0 : f > 1 ? 1 : f;
            d[o + ch] = Math.round(f * 255);
          }
          changed++;
        }
      }
    }
    if (og) og.putImageData(img, 0, y0);
    if (performance.now() - tRef > 200) progress(id, { stage: "refine", f: (y0 + sh) / H });
  }
  // the mask as white pixels with alpha (how masks are stored), built here so the page only draws it
  const mc = new OffscreenCanvas(W, H), mg = mc.getContext("2d");
  for (let y0 = 0; y0 < H; y0 += strip) { const sh = Math.min(strip, H - y0); mg.putImageData(alphaToImageData(alpha, W, H, 0, y0, W, sh), 0, y0); }
  const mask = mc.transferToImageBitmap();
  const color = out && changed ? out.transferToImageBitmap() : null;
  bitmap.close();
  const tEnd = performance.now();
  return { mask, alpha, color, w: W, h: H, ep: usedEp, ms: { infer: tInfer - t0, refine: tRef - tInfer, full: tEnd - tRef, total: tEnd - t0 } };
}
