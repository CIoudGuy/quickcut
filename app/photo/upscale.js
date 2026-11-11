// QuickCut Photo upscaler (Worker). Everything runs on the device, like bg.js (the background remover):
// 1. the model and the ONNX Runtime WebAssembly binary come from our own site (parts of ≤ 20 MiB, see
//    ../models/README.md), are checked against their SHA-256 and only then kept in Cache Storage;
// 2. the model runs on the GPU (WebGPU) or, for the small one, the CPU (WASM);
// 3. big images go through the model in overlapping tiles, blended with a linear ramp across the
//    overlap, so there are no seams and the memory use does not depend on the image size.
// Models (manifest.json → "upscale"): Fast (small, 4× network, any device) and Max (a transformer,
// WebGPU with 16-bit floats). Both are ×4 networks; ×2 is the same network, its result averaged 2×2.
// Memory: one session at a time, released (and {idle: true} posted) after IDLE_MS without work.
const VENDOR = new URL("../vendor/ort/", import.meta.url).href;
const MODELS = new URL("../models/", import.meta.url).href;
const CACHE = "quickcut-upscale-v1"; // own cache: bg.js's housekeeping can't touch these files
const BG_CACHE = "quickcut-models-v1"; // the ONNX Runtime binary may already be here (shared, read only)
const IDLE_MS = 60000;
let ort = null;
let session = null, sessionKey = "", usedEp = "", man = null, warmed = false, curModel = null;
let aborter = new AbortController();
let cancelFlag = false;
let idleTimer = 0, busy = 0;
const mem = new Map(); // files Cache Storage refused to keep (private window, full disk)
let unsaved = false;

let queue = Promise.resolve();
onmessage = (e) => {
  const m = e.data;
  clearTimeout(idleTimer);
  if (m.op === "cancel") { cancelFlag = true; aborter.abort(); aborter = new AbortController(); return reply(m.id, { cancelled: true }); }
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
      const st = await status(m);
      if (!st.models[st.model].cached || st.models[st.model].unfit) return reply(m.id, { warmed: false });
      const r = await init(m);
      if (!warmed) { warmed = true; await tile(new Float32Array(3 * curModel.tile * curModel.tile)); }
      return reply(m.id, { warmed: true, ...r });
    }
    if (m.op === "run") {
      cancelFlag = false;
      const r = await run(m);
      return reply(m.id, r, [r.bitmap]);
    }
  } catch (err) {
    postMessage({ id: m.id, error: String(err?.message || err), cancelled: !!err?.cancelled });
  }
}
const reply = (id, out, transfer = []) => postMessage({ id, ...out }, transfer);
const progress = (id, o) => postMessage({ id, progress: true, ...o });
const cancelled = () => Object.assign(new Error("cancelled"), { cancelled: true });

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
  } catch {
    const hit = await cache?.match(url);
    if (!hit) throw new Error("The upscaler isn't installed on this site yet (model files missing).");
    man = await hit.json();
  }
  if (!man.upscale) throw new Error("The upscaler isn't installed on this site yet (model files missing).");
  try { // housekeeping: drop cached files this manifest no longer lists
    const keep = new Set([url, ...Object.values(man.upscale.models).map((m) => keyOf(man.files[m.file])), keyOf(man.files[man.runtime])]);
    for (const req of (await cache?.keys()) || []) if (req.url.startsWith(MODELS) && !keep.has(req.url)) await cache.delete(req);
  } catch {}
  return man;
}
const keyOf = (f) => `${MODELS}${f.file}?sha256=${f.sha256}`;
async function isCached(f, caches_ = [CACHE]) {
  for (const n of caches_) { try { if (await (await caches.open(n)).match(keyOf(f))) return true; } catch {} }
  return false;
}
const have = async (f) => mem.has(keyOf(f)) || (await isCached(f, [CACHE, BG_CACHE]));
let gpuInfo = null;
async function gpuCaps() {
  if (gpuInfo) return gpuInfo;
  gpuInfo = { webgpu: false, api: !!self.navigator?.gpu };
  try {
    const ad = self.navigator?.gpu && (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }));
    if (ad) {
      const L = ad.limits;
      gpuInfo = { webgpu: true, f16: ad.features.has("shader-f16"), maxBuffer: L.maxBufferSize, maxBinding: L.maxStorageBufferBindingSize, vendor: ad.info?.vendor || "", architecture: ad.info?.architecture || "", fallback: !!ad.info?.isFallbackAdapter };
    }
  } catch {}
  return gpuInfo;
}
/** Why a model can't run on this device ("" when it can). Models marked `gpu` need WebGPU with 16-bit floats. */
function unfit(md, gpu) {
  if (!md.gpu) return "";
  if (gpu.api && (!gpu.webgpu || gpu.fallback)) return "GPU unavailable right now. Restart the browser";
  if (!gpu.webgpu || gpu.fallback) return "Needs GPU access (WebGPU), which this browser doesn't give";
  if (!gpu.f16) return "Needs a GPU with 16-bit float support";
  if (gpu.maxBuffer < 1 << 29 || gpu.maxBinding < 1 << 27) return "This GPU's memory limits are too small for it";
  if (self.navigator?.deviceMemory && navigator.deviceMemory < 8) return "Needs at least 8 GB of memory";
  return "";
}
async function status({ model }) {
  const mf = await manifest(), gpu = await gpuCaps();
  const rt = mf.files[mf.runtime], cr = await have(rt);
  const models = {};
  for (const [id, md] of Object.entries(mf.upscale.models)) {
    const f = mf.files[md.file], c = await have(f);
    models[id] = { ...md, size: f.size, cached: c, bytes: (c ? 0 : f.size) + (cr ? 0 : rt.size), unfit: unfit(md, gpu) };
  }
  const id = mf.upscale.models[model] ? model : mf.upscale.default;
  const stored = Object.values(models).reduce((a, m) => a + (m.cached ? m.size : 0), 0);
  return { model: id, models, stored, runtime: { size: rt.size, cached: cr }, gpu };
}
/** Uninstall: the given models (all when none are named) are deleted from Cache Storage. */
async function remove({ models: ids }) {
  const mf = await manifest();
  if (session) { try { await session.release(); } catch {} }
  session = null; sessionKey = ""; warmed = false; curModel = null;
  mem.clear();
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { return { freed: 0 }; }
  const all = Object.keys(mf.upscale.models), drop = ids?.length ? ids.filter((i) => mf.upscale.models[i]) : all;
  let freed = 0;
  for (const id of drop) { const f = mf.files[mf.upscale.models[id].file]; if (await cache.delete(keyOf(f))) freed += f.size; }
  const left = [];
  for (const id of all) if (!drop.includes(id) && (await isCached(mf.files[mf.upscale.models[id].file]))) left.push(id);
  if (!left.length) { const rt = mf.files[mf.runtime]; if (await cache.delete(keyOf(rt))) freed += rt.size; }
  return { freed, left };
}
async function hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** One file as bytes: from a cache, or downloaded part by part (progress, abortable), verified, then cached. */
async function getFile(f, onBytes, signal) {
  const key = keyOf(f);
  if (mem.has(key)) return mem.get(key);
  for (const n of [CACHE, BG_CACHE]) {
    let hit = null;
    try { hit = await (await caches.open(n)).match(key); } catch {}
    if (hit) {
      const b = new Uint8Array(await hit.arrayBuffer());
      if (b.length === f.size) return b;
      try { await (await caches.open(n)).delete(key); } catch {}
    }
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
  let saved = false;
  try {
    const cache = await caches.open(CACHE);
    for (const req of await cache.keys()) if (req.url.startsWith(MODELS + f.file + "?") && req.url !== key) await cache.delete(req);
    await cache.put(key, new Response(buf, { headers: { "content-type": "application/octet-stream", "content-length": String(f.size) } }));
    saved = true;
  } catch { /* storage full or private mode: kept in memory below */ }
  if (!saved) { mem.set(key, buf); unsaved = true; }
  return buf;
}

// ── session ──────────────────────────────────────────────────────────────
async function init({ id, model, ep = "auto" }) {
  const mf = await manifest();
  const name = mf.upscale.models[model] ? model : mf.upscale.default;
  const md = mf.upscale.models[name];
  const key = `${name}|${ep}`;
  if (session && sessionKey === key) return { ep: usedEp, model: name, ms: 0, cached: true, unsaved };
  const t0 = performance.now();
  const rt = mf.files[mf.runtime], mdf = mf.files[md.file];
  const total = ((await have(rt)) ? 0 : rt.size) + ((await have(mdf)) ? 0 : mdf.size);
  let got = 0, last = 0;
  const onBytes = (n) => {
    got += n;
    const now = performance.now();
    if (now - last > 100 || got === total) { last = now; progress(id, { stage: "download", loaded: got, total }); }
  };
  const signal = aborter.signal;
  const wasm = await getFile(rt, onBytes, signal);
  let bytes = await getFile(mdf, onBytes, signal);
  if (signal.aborted) throw cancelled();
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
    catch (err) { console.warn("upscale: WebGPU failed", err); session = null; gpuError = String(err?.message || err).slice(0, 300); }
  }
  if (!session) {
    if (md.gpu) throw new Error(gpuError ? `The GPU couldn't run this model (${gpuError})` : "This model needs the GPU");
    session = await ort.InferenceSession.create(bytes, { ...opts, executionProviders: ["wasm"] }); usedEp = "wasm";
  }
  bytes = null;
  if (signal.aborted) { try { await session.release(); } catch {} session = null; sessionKey = ""; throw cancelled(); }
  sessionKey = key;
  curModel = md;
  return { ep: usedEp, model: name, ms: performance.now() - t0, downloadMs: tDl - t0, loadMs: performance.now() - tDl, threads: ort.env.wasm.numThreads, adapter: adapterInfo, gpuError, unsaved };
}

// ── inference: one tile ─────────────────────────────────────────────────
/** `px`: 3·T·T floats (planar RGB, 0…1) → 3·(4T)² floats (planar, 0…1, not clamped). */
async function tile(px) {
  const T = curModel.tile, name = session.inputNames[0];
  const out = await session.run({ [name]: new ort.Tensor("float32", px, [1, 3, T, T]) });
  const t = out[session.outputNames[0]], data = t.data;
  const res = data instanceof Float32Array ? data : Float32Array.from(data);
  for (const k in out) if (out[k] !== t) out[k].dispose?.();
  return res;
}

/** Tile start positions along a length: stride T-ov, the last tile pulled back inside (so it overlaps more). */
function starts(len, T, ov) {
  if (len <= T) return [0];
  const s = [];
  for (let p = 0; ; p += T - ov) { if (p + T >= len) { s.push(len - T); break; } s.push(p); }
  return s;
}

/**
 * Upscale a bitmap by `scale` (2 or 4) with the loaded model. Pixels outside the picture are mirrored
 * (so the borders get context); each tile's result is blended into the output with a linear ramp
 * across its overlap with the tiles before it.
 */
async function run({ id, bitmap, scale = 4 }) {
  if (!session) throw new Error("not ready");
  const t0 = performance.now(), W = bitmap.width, H = bitmap.height, T = curModel.tile, ov = curModel.overlap, M = curModel.scale || 4;
  const s = scale === 2 ? 2 : 4, k = M / s; // k: box-average factor (2 for ×2 from a ×4 network)
  if (M % s) throw new Error("bad scale");
  progress(id, { stage: "run", f: 0 });
  // the source as RGBA bytes (alpha is resized separately: the network sees colour only)
  const sc = new OffscreenCanvas(W, H), sg = sc.getContext("2d", { willReadFrequently: true });
  sg.drawImage(bitmap, 0, 0);
  const src = sg.getImageData(0, 0, W, H).data;
  let hasAlpha = false;
  for (let i = 3; i < src.length; i += 4) if (src[i] !== 255) { hasAlpha = true; break; }
  const OW = W * s, OH = H * s;
  const out = new Uint8ClampedArray(OW * OH * 4);
  // a tile covers padded coordinates; the picture sits at (pad, pad) so the outer tiles see mirrored context
  const pad = Math.min(ov >> 1, 8), PW = W + 2 * pad, PH = H + 2 * pad;
  const xs = starts(PW, T, ov), ys = starts(PH, T, ov);
  const mirror = (v, n) => { if (n === 1) return 0; const p = 2 * (n - 1); v = ((v % p) + p) % p; return v < n ? v : p - v; };
  const px = new Float32Array(3 * T * T), TS = T * M;
  const mx = new Int32Array(T), my = new Int32Array(T);
  const total = xs.length * ys.length;
  let n = 0, prevEndY = 0;
  const ramp = (d, ovl) => (ovl <= 0 ? 1 : Math.min(1, (d + 0.5) / ovl));
  for (let iy = 0; iy < ys.length; iy++) {
    let prevEndX = 0;
    for (let ix = 0; ix < xs.length; ix++) {
      if (cancelFlag) throw cancelled();
      const x0 = xs[ix], y0 = ys[iy];
      for (let i = 0; i < T; i++) { mx[i] = mirror(x0 + i - pad, W); my[i] = mirror(y0 + i - pad, H); }
      const N = T * T;
      for (let yy = 0; yy < T; yy++) {
        const row = my[yy] * W;
        for (let xx = 0; xx < T; xx++) {
          const o = (row + mx[xx]) * 4, j = yy * T + xx;
          px[j] = src[o] / 255; px[N + j] = src[o + 1] / 255; px[2 * N + j] = src[o + 2] / 255;
        }
      }
      const r = await tile(px);
      // overlap with the tile on the left / above, in output pixels
      const ovx = ix ? Math.round(((prevEndX - x0) * M) / k) : 0, ovy = iy ? Math.round(((prevEndY - y0) * M) / k) : 0;
      // output tile = box average (k×k) of the network's result; its top-left in the output image:
      const ts = T * s, ox0 = Math.round(((x0 - pad) * M) / k), oy0 = Math.round(((y0 - pad) * M) / k);
      const kk = k * k, NN = TS * TS;
      for (let yy = 0; yy < ts; yy++) {
        const oy = oy0 + yy;
        if (oy < 0 || oy >= OH) continue;
        const wy = iy ? ramp(yy, ovy) : 1;
        for (let xx = 0; xx < ts; xx++) {
          const ox = ox0 + xx;
          if (ox < 0 || ox >= OW) continue;
          const wx = ix ? ramp(xx, ovx) : 1, w = wx * wy, o = (oy * OW + ox) * 4;
          for (let ch = 0; ch < 3; ch++) {
            let v = 0;
            const base = ch * NN + yy * k * TS + xx * k;
            if (k === 1) v = r[base]; else { for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) v += r[base + a * TS + b]; v /= kk; }
            v = v * 255;
            out[o + ch] = w >= 1 ? v : out[o + ch] + (v - out[o + ch]) * w; // Uint8ClampedArray rounds and clamps
          }
          out[o + 3] = 255;
        }
      }
      prevEndX = x0 + T;
      progress(id, { stage: "run", f: ++n / total });
    }
    prevEndY = ys[iy] + T;
  }
  const tInfer = performance.now();
  const oc = new OffscreenCanvas(OW, OH), og = oc.getContext("2d");
  const STRIP = Math.max(1, Math.floor(8e6 / OW));
  for (let y = 0; y < OH; y += STRIP) { const h = Math.min(STRIP, OH - y); og.putImageData(new ImageData(out.subarray(y * OW * 4, (y + h) * OW * 4), OW, h), 0, y); }
  let result = oc;
  if (hasAlpha) {
    // the colour is the network's; the alpha is the original resized smoothly, applied with destination-in
    const ac = new OffscreenCanvas(OW, OH), ag = ac.getContext("2d");
    ag.imageSmoothingQuality = "high";
    ag.drawImage(bitmap, 0, 0, OW, OH);
    og.globalCompositeOperation = "destination-in";
    og.drawImage(ac, 0, 0);
    og.globalCompositeOperation = "source-over";
  }
  const outBitmap = result.transferToImageBitmap();
  bitmap.close();
  return { bitmap: outBitmap, w: OW, h: OH, ep: usedEp, tiles: total, ms: { infer: tInfer - t0, total: performance.now() - t0 } };
}
