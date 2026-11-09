// QuickCut Video worker. Kinds of instance:
//  - the "probe" worker of an open file: file info, key-frame thumbnails, waveform peaks, Instant
//    estimates and layouts, Exact plans. Lives as long as the file is open.
//  - Exact export workers (terminated to cancel): several "segment" workers (WebCodecs decode →
//    crop/rotate/scale → WebCodecs encode → OPFS), one "audio" worker, then one "mux" worker
//    that writes the final file from the finished parts (wasm muxer, chunks to the page).
// The file is read with FileReaderSync on Blob slices through small read-ahead windows, so a
// multi-GB file is never loaded at once.
import init, { Media, Mux, stretch, av1c, last_panic } from "./pkg/qc_wasm.js";
import { encoderConfig, colorCodes } from "./codecs.js";

const ready = init();
// pieces faster than this export without sound (video.js MUTE_ABOVE says so in the panel)
const MUTE_ABOVE = 16;
let media = null, info = null, file = null;

// ── reading ─────────────────────────────────────────────────────────────────
// One read-ahead window per consumer (thumbnails, audio, video…) so they don't evict each other.
const fr = new FileReaderSync();
const windows = {};
let cur = "main";
function use(name) { cur = name; }
function read(off, len) {
  const w = (windows[cur] ||= { buf: null, start: 0, size: cur === "thumb" ? 1 << 20 : 4 << 20 });
  if (w.buf && off >= w.start && off + len <= w.start + w.buf.length) return w.buf.subarray(off - w.start, off - w.start + len);
  const end = Math.min(file.size, off + Math.max(len, w.size));
  w.buf = new Uint8Array(fr.readAsArrayBuffer(file.slice(off, end)));
  w.start = off;
  return w.buf.subarray(0, len);
}

function table(track) {
  const s = media.samples(track);
  const n = s.length / 3;
  const pts = new Float64Array(n), dur = new Float64Array(n), key = new Uint8Array(n);
  for (let i = 0; i < n; i++) { pts[i] = s[i * 3]; dur[i] = s[i * 3 + 1]; key[i] = s[i * 3 + 2]; }
  return { n, pts, dur, key };
}

async function openFile(f) {
  await ready;
  file = f;
  use("main");
  media = new Media(read, f.size);
  info = JSON.parse(media.info());
  return info;
}

const post = (m, t) => self.postMessage(m, t || []);
const wait = (target, ev) => new Promise((r) => target.addEventListener(ev, r, { once: true }));

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.op === "open") {
      const i = await openFile(m.file);
      let keys = new Float64Array(0);
      if (i.video >= 0) {
        const t = table(i.video);
        const k = [];
        for (let j = 0; j < t.n; j++) if (t.key[j]) k.push([t.pts[j], j]);
        k.sort((a, b) => a[0] - b[0]);
        keys = Float64Array.from(k.map((x) => x[0]));
        vt = t;
        keyIdx = k.map((x) => x[1]);
      }
      post({ op: "info", info: i, keys });
    } else if (m.op === "thumbs") { thumbQueue = m.list; thumbH = m.h; pumpThumbs(); }
    else if (m.op === "thumbForget") { for (const k of m.list) thumbDone.delete(k); } // the page dropped them (bounded cache)
    else if (m.op === "wave") waveform().catch((err) => post({ op: "waveOff", why: String(err?.message || err) }));
    else if (m.op === "estimate") {
      let r = [0, 0];
      try { use("main"); r = media.instant_estimate(Float64Array.from(m.pieces)); } catch {}
      post({ op: "estimate", id: m.id, dur: r[0], bytes: r[1] });
    } else if (m.op === "layout") await instantLayout(m);
    else if (m.op === "copy") await instantCopy(m);
    else if (m.op === "plan") {
      if (!media) await openFile(m.file);
      const r = planExact(m.pieces, m.fps, m);
      post({ op: "plan", id: m.id, ...r }, r.segs.map((x) => x.buffer));
    } else if (m.op === "segInit") await segInit(m);
    else if (m.op === "seg") {
      try { await segRun(m); } catch (err) { post({ op: "segFail", i: m.i, why: String(err?.message || err), hw: S?.hw }); }
    } else if (m.op === "audio") await audioJob(m);
    else if (m.op === "mux") await muxJob(m);
  } catch (err) {
    let why = String(err?.message || err);
    if (/unreachable|RuntimeError/i.test(why)) { let p = ""; try { p = last_panic(); } catch {} why = p ? `internal error: ${p}` : "internal error (out of memory?)"; }
    post({ op: "error", what: m.op, why });
  }
};

// ── thumbnails: decode key frames only, one at a time, small ────────────────
let vt = null, keyIdx = [], thumbQueue = [], thumbH = 96, thumbBusy = false, vdec = null, thumbsOff = false, lastThumb = null;
const thumbDone = new Set();

async function thumbDecoder() {
  if (vdec) return vdec;
  const tr = info.tracks[info.video];
  if (!self.VideoDecoder || !tr.codecString) throw new Error("no decoder");
  const config = { codec: tr.codecString, optimizeForLatency: true };
  const d = media.description(info.video);
  if (d.length) config.description = d;
  const sup = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!sup.supported) throw new Error(`${tr.codecString} can't be decoded here`);
  vdec = new VideoDecoder({
    output: (f) => { lastThumb?.close(); lastThumb = f; },
    error: () => { vdec = null; },
  });
  vdec.configure(config);
  return vdec;
}

async function pumpThumbs() {
  if (thumbBusy || thumbsOff) return;
  thumbBusy = true;
  try {
    const tr = info.tracks[info.video];
    while (thumbQueue.length) {
      const k = thumbQueue.shift();
      if (thumbDone.has(k) || k < 0 || k >= keyIdx.length) continue;
      thumbDone.add(k);
      const d = await thumbDecoder();
      const i = keyIdx[k];
      use("thumb");
      const data = media.read(info.video, i);
      d.decode(new EncodedVideoChunk({ type: "key", timestamp: Math.round(vt.pts[i] * 1e6), data }));
      await d.flush();
      const f = lastThumb;
      lastThumb = null;
      if (!f) { thumbDone.delete(k); continue; } // no picture came out: a later ask tries it again
      const bmp = await smallBitmap(f, tr.rotation, thumbH);
      f.close();
      post({ op: "thumb", k, bmp }, [bmp]);
    }
  } catch (err) {
    thumbsOff = true;
    post({ op: "thumbsOff", why: String(err?.message || err) });
  }
  thumbBusy = false;
}

async function smallBitmap(frame, rot, h) {
  const w0 = frame.displayWidth, h0 = frame.displayHeight;
  const turned = rot % 2 === 1;
  const oh = h, ow = Math.max(1, Math.round(h * (turned ? h0 / w0 : w0 / h0)));
  const c = new OffscreenCanvas(ow, oh);
  const g = c.getContext("2d");
  g.translate(ow / 2, oh / 2);
  g.rotate((rot * Math.PI) / 2);
  const sw = turned ? oh : ow, sh = turned ? ow : oh;
  g.drawImage(frame, -sw / 2, -sh / 2, sw, sh);
  return c.transferToImageBitmap();
}

// ── waveform: peaks per 10 ms, computed progressively ───────────────────────
async function waveform() {
  if (info.audio < 0) { post({ op: "waveOff", why: "no audio" }); return; }
  const tr = info.tracks[info.audio];
  if (!self.AudioDecoder || !tr.codecString) throw new Error("no audio decoder");
  const config = { codec: tr.codecString, sampleRate: tr.sampleRate || 48000, numberOfChannels: tr.channels || 2 };
  const d = media.description(info.audio);
  if (d.length) config.description = d;
  const sup = await AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!sup.supported) throw new Error(`${tr.codecString} can't be decoded here`);
  const RATE = 100;
  const total = Math.ceil(Math.max(info.duration, tr.duration) * RATE) + 2;
  const peaks = new Float32Array(total);
  let lo = Infinity, hi = 0, last = performance.now();
  const flushOut = (force) => {
    if (hi <= lo || (!force && performance.now() - last < 250)) return;
    last = performance.now();
    const part = peaks.slice(lo, hi);
    post({ op: "wave", start: lo, peaks: part, total }, [part.buffer]);
    lo = Infinity; hi = 0;
  };
  let tmp = new Float32Array(4096);
  const dec = new AudioDecoder({
    output: (a) => {
      const n = a.numberOfFrames, rate = a.sampleRate, t0 = a.timestamp / 1e6;
      if (tmp.length < n) tmp = new Float32Array(n);
      const chs = Math.min(a.numberOfChannels, 2);
      for (let c = 0; c < chs; c++) {
        a.copyTo(tmp, { planeIndex: c, format: "f32-planar" });
        for (let j = 0; j < n; j++) {
          const b = Math.floor((t0 + j / rate) * RATE);
          if (b < 0 || b >= total) continue;
          const v = Math.abs(tmp[j]);
          if (v > peaks[b]) peaks[b] = v;
          if (b < lo) lo = b;
          if (b + 1 > hi) hi = b + 1;
        }
      }
      a.close();
      flushOut(false);
    },
    error: () => {},
  });
  dec.configure(config);
  const t = table(info.audio);
  for (let i = 0; i < t.n; i++) {
    use("audio");
    dec.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round(t.pts[i] * 1e6), duration: Math.round(t.dur[i] * 1e6), data: media.read(info.audio, i) }));
    if (dec.decodeQueueSize > 48) await wait(dec, "dequeue");
  }
  await dec.flush();
  dec.close();
  flushOut(true);
  post({ op: "waveDone" });
}

// ── output ──────────────────────────────────────────────────────────────────
const chunk = (data, pos) => post({ op: "chunk", pos, data }, [data.buffer]);
let lastProg = 0;
function progress(done, total, stage, force) {
  const now = performance.now();
  if (!force && now - lastProg < 100) return;
  lastProg = now;
  post({ op: "progress", done, total, stage });
}

// ── Instant: the plan only. Rust lays out ftyp + moov (final offsets, moov first) + the mdat
// header; the page then copies the sample bytes straight from the source file in large runs.
async function instantLayout(m) {
  if (!media) await openFile(m.file);
  use("main");
  const l = media.instant_layout(Float64Array.from(m.pieces));
  const head = l.head(), runs = l.runs();
  post({ op: "layout", id: m.id, head, runs, size: l.size(), dur: l.duration() }, [head.buffer, runs.buffer]);
  l.free();
}

// The copy (its own worker, so the page never waits): the head, then the runs. Runs next to each
// other in the source are read as one window (one read, 32 MB) and assembled in memory; big runs
// go straight from a Blob slice. Writes are 32 MB.
async function instantCopy(m) {
  const { file: f, head, runs, size } = m;
  const w = await m.handle.createWritable();
  try {
    await w.write(head);
    let done = head.length;
    const OUT = 32 << 20, SPAN = 48 << 20;
    let out = new Uint8Array(OUT), fill = 0;
    // one write in flight while the next buffer is read and assembled (reads ~1 GB/s, the
    // browser's file writer ~300 MB/s: this hides the reads)
    let inflight = Promise.resolve();
    const put = async (data, n) => { await inflight; inflight = w.write(data); done += n; progress(done, size, "Copying"); };
    const flush = async () => { if (fill) { await put(out.subarray(0, fill), fill); fill = 0; out = new Uint8Array(OUT); } };
    for (let k = 0; k < runs.length;) {
      const o = runs[k], n = runs[k + 1];
      if (n >= 4 << 20) { await flush(); await put(f.slice(o, o + n), n); k += 2; continue; }
      // a group of runs whose source span is compact: read it once
      let lo = o, hi = o + n, j = k + 2, bytes = n;
      while (j < runs.length) {
        const o2 = runs[j], n2 = runs[j + 1];
        if (n2 >= 4 << 20 || fill + bytes + n2 > OUT) break;
        const lo2 = Math.min(lo, o2), hi2 = Math.max(hi, o2 + n2);
        if (hi2 - lo2 > SPAN || hi2 - lo2 > 2 * (bytes + n2) + (1 << 20)) break;
        lo = lo2; hi = hi2; bytes += n2; j += 2;
      }
      const win = new Uint8Array(fr.readAsArrayBuffer(f.slice(lo, hi)));
      for (let q = k; q < j; q += 2) { out.set(win.subarray(runs[q] - lo, runs[q] - lo + runs[q + 1]), fill); fill += runs[q + 1]; }
      k = j;
      if (fill > OUT - (4 << 20)) await flush();
    }
    await flush();
    await inflight;
    progress(size, size, "Saving", true);
    await w.close();
  } catch (err) { try { await w.abort(); } catch {} throw err; }
  post({ op: "done", bytes: size });
}

// ── OPFS: an Exact export keeps its finished parts in qcv-jobs/<id>/ ──────────
async function jobDir(id) {
  const root = await navigator.storage.getDirectory();
  const jobs = await root.getDirectoryHandle("qcv-jobs", { create: true });
  return jobs.getDirectoryHandle(id, { create: true });
}
/** An append-only file through a sync access handle (fast, worker only). */
async function openSink(dir, name) {
  const fh = await dir.getFileHandle(name, { create: true });
  const ah = await fh.createSyncAccessHandle();
  ah.truncate(0);
  return {
    ah, off: 0,
    write(b) { let n = 0; while (n < b.length) { const k = this.ah.write(n ? b.subarray(n) : b, { at: this.off + n }); if (k <= 0) throw new Error("The browser's storage is full."); n += k; } this.off += b.length; },
    close() { try { this.ah.flush(); } finally { this.ah.close(); } },
  };
}
async function writeWhole(dir, name, bytes) { const s = await openSink(dir, name); try { s.write(bytes); } finally { s.close(); } }
async function readWhole(dir, name) {
  const fh = await dir.getFileHandle(name);
  const ah = await fh.createSyncAccessHandle();
  try { const b = new Uint8Array(ah.getSize()); ah.read(b, { at: 0 }); return b; } finally { ah.close(); }
}

// ── Exact plan: every source frame inside a piece becomes one output frame with its own time
// (so 59.94, 29.97 and variable frame rates stay exact; nothing is dropped or doubled). Faster
// pieces keep at most the source frame rate (frames that would land in the same output frame
// slot are skipped); slower pieces stretch the frame times. Fast pieces (4× and up) show a key
// frame where one falls inside the slot (at the slot's time): a key frame decodes alone, so at
// 100× most groups of frames are never decoded at all (segRun). The frames are cut into
// segments of a few seconds at source key frames: each segment decodes and encodes on its own
// (in parallel, and a finished one never has to be redone).
export const FAST_KEYS = 4;
function keptFrames(vtab, p, outBase, fps, cap) {
  const order = Array.from({ length: vtab.n }, (_, i) => i).sort((a, b) => vtab.pts[a] - vtab.pts[b]);
  const out = [];
  let pre = -1, lastSlot = -Infinity;
  const fast = p.speed >= FAST_KEYS;
  for (const i of order) {
    const t = vtab.pts[i];
    if (t < p.start - 1e-6) { pre = i; continue; }
    if (t >= p.end - 1e-6) break;
    if (!out.length && t > p.start + 1e-6 && pre >= 0) { out.push({ src: vtab.pts[pre], out: outBase, key: !!vtab.key[pre] }); lastSlot = 0; }
    const rel = (t - p.start) / p.speed;
    if (p.speed > 1) {
      const slot = Math.floor(rel * fps + 1e-3);
      if (slot === lastSlot) {
        const last = out[out.length - 1];
        if (fast && vtab.key[i] && !last.key) { last.src = t; last.key = true; }
        continue;
      }
      lastSlot = slot;
      out.push({ src: t, out: outBase + rel, key: !!vtab.key[i] });
      continue;
    }
    // a lower output frame rate (60 → 30 fps for a size target): one frame per output slot, the
    // slot edges a quarter frame early so millisecond-rounded source times don't jitter the pick
    else if (cap) { const slot = Math.floor(rel * fps + 0.25); if (slot === lastSlot) continue; lastSlot = slot; }
    out.push({ src: t, out: outBase + rel });
  }
  if (!out.length && pre >= 0) out.push({ src: vtab.pts[pre], out: outBase });
  return out;
}
// o (optional): segSecs (part length, default 4), cap (output fps below the source's: drop
// frames), weights (also measure each part's source bytes per second: MP4/MOV only).
function planExact(pieces, fps, o = {}) {
  const vtab = table(info.video);
  const keys = new Set();
  for (let i = 0; i < vtab.n; i++) if (vtab.key[i]) keys.add(Math.round(vtab.pts[i] * 1e6));
  const target = Math.max(60, Math.round((fps || 30) * (o.segSecs || 4)));
  const segs = [];
  let base = 0;
  for (const p of pieces) {
    const f = keptFrames(vtab, p, base, fps, !!o.cap);
    let cur = [];
    for (const x of f) {
      // cut at a source key frame once the segment has ~4 s (or anywhere after ~12 s: very long
      // GOPs only cost a little extra decoding)
      if (cur.length >= target && (keys.has(Math.round(x.src * 1e6)) || cur.length >= target * 3)) { segs.push(cur); cur = []; }
      cur.push(x);
    }
    if (cur.length) segs.push(cur);
    base += (p.end - p.start) / p.speed;
  }
  const out = { segs: segs.map((s) => Float64Array.from(s.flatMap((x) => [x.src, x.out]))), totalOut: base, frames: segs.reduce((a, s) => a + s.length, 0) };
  if (o.weights) out.density = segDensity(segs);
  return out;
}
// Source bytes per second of each part (video only: the audio track's average is taken off), from
// the Instant cutter's estimate of the part's source range. Long files: neighbouring parts are
// measured together (at most ~600 estimates), so this stays well under a second.
function segDensity(segs) {
  try {
    if (info.container !== "mp4" && info.container !== "mov") return null;
    const at = info.audio >= 0 ? info.tracks[info.audio] : null;
    const aRate = at && at.duration > 0 ? at.bytes / at.duration : 0;
    const vt = info.tracks[info.video];
    const fd = vt.fps > 0 ? 1 / vt.fps : 1 / 30;
    const span = (s) => { let lo = Infinity, hi = -Infinity; for (const x of s) { lo = Math.min(lo, x.src); hi = Math.max(hi, x.src); } return [lo, hi + fd]; };
    const group = Math.max(1, Math.ceil(segs.length / 600));
    const out = new Array(segs.length).fill(0);
    use("main");
    for (let g = 0; g < segs.length; g += group) {
      const part = segs.slice(g, g + group).map(span);
      const pcs = part.flatMap(([a, b]) => [a, b]);
      const [d, bytes] = media.instant_estimate(Float64Array.from(pcs));
      const secs = part.reduce((a, [x, y]) => a + (y - x), 0);
      const v = Math.max(1, bytes - aRate * (d || secs)) / Math.max(1e-3, secs);
      for (let k = g; k < Math.min(segs.length, g + group); k++) out[k] = v;
    }
    return out;
  } catch { return null; }
}

// ── Exact, one segment worker: decode → transform → encode → OPFS ───────────────
let S = null;
async function segInit(m) {
  await openFile(m.file);
  const v = info.video;
  if (!self.VideoEncoder || !self.VideoDecoder) throw new Error("This browser can't re-encode video (no WebCodecs). Try Chrome or Edge.");
  if (v < 0) throw new Error("No video track to export.");
  const vtr = info.tracks[v];
  const decConf = { codec: vtr.codecString };
  const desc = media.description(v);
  if (desc.length) decConf.description = desc;
  if (!vtr.codecString || !(await VideoDecoder.isConfigSupported(decConf).catch(() => ({}))).supported) throw new Error(`This browser can't decode ${vtr.codec.toUpperCase()} video.`);
  const { outW, outH, vcodec, bitrate, fps, tenBit } = m.s;
  const conf = await encoderConfig(vcodec, outW, outH, fps, bitrate, { forceSoftware: !!m.software, tenBit, mode: m.s.rateMode || "variable" });
  if (!conf) throw new Error(`This browser can't encode ${vcodec.toUpperCase()} at ${outW}×${outH}.`);
  const A = m.s.A, crop = m.s.crop, s = outW / crop.w;
  const upright = A[0] === 1 && A[1] === 0 && A[2] === 0 && A[3] === 1;
  const ident = upright && Math.abs(crop.x) < 0.5 && Math.abs(crop.y) < 0.5 && outW === vtr.width && outH === vtr.height;
  // crop only, at full size: a view into the decoded frame (no copy; keeps 10-bit)
  const viewCrop = !ident && upright && outW === Math.round(crop.w) && outH === Math.round(crop.h) && Math.round(crop.x) % 2 === 0 && Math.round(crop.y) % 2 === 0;
  const canvas = ident || viewCrop ? null : new OffscreenCanvas(outW, outH);
  const g = canvas?.getContext("2d", { alpha: false, desynchronized: true });
  if (g) { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = s < 0.75 ? "high" : "medium"; }
  S = { m, vtr, vtab: table(v), dir: await jobDir(m.job), decConf, conf, hw: conf.hardwareAcceleration === "prefer-hardware", ident, viewCrop, canvas, g, A, crop, s, desc: null, color: null, cur: null, failure: null, enc: null };
  makeEncoder();
  post({ op: "segReady", hw: S.hw, codec: conf.codec });
}
function makeEncoder() {
  const st = S;
  st.enc = new VideoEncoder({
    output: (c, meta) => {
      try {
        const cur = st.cur;
        const b = new Uint8Array(c.byteLength);
        c.copyTo(b);
        const dd = meta?.decoderConfig?.description;
        if (dd) st.desc = dd instanceof ArrayBuffer ? new Uint8Array(dd.slice(0)) : new Uint8Array(dd.buffer.slice(dd.byteOffset, dd.byteOffset + dd.byteLength));
        if (meta?.decoderConfig?.colorSpace) st.color = meta.decoderConfig.colorSpace;
        cur.sink.write(b);
        cur.idx.push(c.timestamp / 1e6, c.type === "key" ? 1 : 0, b.length);
        cur.n++;
        if (cur.n === 1 || performance.now() - cur.tp > 100) { cur.tp = performance.now(); post({ op: "segProg", i: cur.i, n: cur.n }); }
      } catch (err) { st.failure ||= err; }
    },
    error: (err) => { st.failure ||= err; },
  });
  st.enc.configure(st.conf);
}
const waitAny = (list, ms) => Promise.race([...list.map(([t, ev]) => wait(t, ev)), new Promise((r) => setTimeout(r, ms))]);

async function segRun(m) {
  const st = S;
  const fr = m.frames, nf = fr.length / 2;
  const want = new Map();
  for (let k = 0; k < nf; k++) want.set(Math.round(fr[2 * k] * 1e6), fr[2 * k + 1]);
  const srcFirst = fr[0], srcLast = fr[2 * (nf - 1)];
  st.cur = { i: m.i, sink: await openSink(st.dir, `seg-${m.i}.bin`), idx: [], n: 0, tp: 0 };
  st.failure = null;
  // a size target asks each part for its own bit rate (the encoder is idle between parts: the
  // last one was flushed, and every part starts on a key frame)
  if (m.bitrate && Math.round(m.bitrate) !== st.conf.bitrate) {
    st.conf = { ...st.conf, bitrate: Math.round(m.bitrate) };
    try { st.enc.configure(st.conf); } catch { try { st.enc.close(); } catch {} makeEncoder(); }
  }
  const keyInt = st.m.s.keyInt || 2;
  let first = true, lastKeyOut = -Infinity;
  const emit = (frame, outT) => {
    const timestamp = Math.round(outT * 1e6);
    let out;
    if (st.ident) out = new VideoFrame(frame, { timestamp });
    else if (st.viewCrop) out = new VideoFrame(frame, { timestamp, visibleRect: { x: Math.round(st.crop.x), y: Math.round(st.crop.y), width: st.m.s.outW, height: st.m.s.outH } });
    else {
      const { g, A, crop, s } = st, outW = st.m.s.outW, outH = st.m.s.outH;
      const ws = frame.displayWidth, hs = frame.displayHeight;
      const Wo = A[0] === 0 ? hs : ws, Ho = A[0] === 0 ? ws : hs;
      const L = A.map((x) => x * s);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = "#000"; g.fillRect(0, 0, outW, outH);
      g.setTransform(L[0], L[2], L[1], L[3], s * (Wo / 2 - crop.x) - (L[0] * ws) / 2 - (L[1] * hs) / 2, s * (Ho / 2 - crop.y) - (L[2] * ws) / 2 - (L[3] * hs) / 2);
      g.drawImage(frame, 0, 0, ws, hs);
      out = new VideoFrame(st.canvas, { timestamp });
    }
    // every segment starts on a key frame (it decodes alone); then one every 2 s (size target:
    // every ~5 s, fewer costly key frames)
    const key = first || outT - lastKeyOut >= keyInt - 1e-6;
    if (key) lastKeyOut = outT;
    first = false;
    st.enc.encode(out, { keyFrame: key });
    out.close();
  };
  const dec = new VideoDecoder({
    output: (f) => {
      try {
        st.color ||= f.colorSpace?.toJSON?.() || null;
        const o = want.get(f.timestamp);
        if (o !== undefined) { want.delete(f.timestamp); emit(f, o); }
      } catch (err) { st.failure ||= err; }
      f.close();
    },
    error: (err) => { st.failure ||= err; },
  });
  dec.configure(st.decConf);
  const vt = st.vtab, v = info.video;
  let d0 = 0;
  for (let i = 0; i < vt.n; i++) if (vt.key[i] && vt.pts[i] <= srcFirst + 1e-6) d0 = i;
  let past = 0, end = vt.n;
  for (let i = d0; i < vt.n; i++) if (vt.pts[i] > srcLast + 1e-6) { past++; if (vt.key[i] || past > 16) { end = i; break; } }
  const todo = decodeList(vt, d0, end, want);
  try {
    for (const i of todo) {
      use("video");
      dec.decode(new EncodedVideoChunk({ type: vt.key[i] ? "key" : "delta", timestamp: Math.round(vt.pts[i] * 1e6), duration: Math.round(vt.dur[i] * 1e6), data: media.read(v, i) }));
      // backpressure: a few frames in flight per stage, never a pile of decoded frames
      while (dec.decodeQueueSize > 3 || st.enc.encodeQueueSize > 4) await waitAny([[dec, "dequeue"], [st.enc, "dequeue"]], 30);
      if (st.failure) throw st.failure;
    }
    await dec.flush();
    if (st.failure) throw st.failure;
    await st.enc.flush();
    if (st.failure) throw st.failure;
  } catch (err) {
    try { dec.close(); } catch {}
    try { st.cur.sink.close(); } catch {}
    // a failed encoder can't be reused: a fresh one for the next segment
    try { st.enc.close(); } catch {}
    makeEncoder();
    throw err;
  }
  dec.close();
  if (want.size) { st.cur.sink.close(); throw new Error(`${want.size} frames of part ${m.i + 1} did not decode`); }
  const idx = Float64Array.from(st.cur.idx);
  const bytes = st.cur.sink.off, n = st.cur.n;
  st.cur.sink.close();
  await writeWhole(st.dir, `seg-${m.i}.idx`, new Uint8Array(idx.buffer));
  st.cur = null;
  post({ op: "segDone", i: m.i, bytes, n, decoded: todo.length, desc: st.desc, codec: st.conf.codec, color: st.color, hw: st.hw, bitrate: st.conf.bitrate });
}

/** Frames of [d0, end) (decode order) to decode for the wanted frames (`want`: µs pts). A group
 * of frames (a key frame up to the next) is decoded whole when it holds a wanted frame that is
 * not its key frame; only its key frame when that alone is wanted (fast pieces pick key frames);
 * not at all when nothing in it is wanted. Leading frames (shown before their group's key frame)
 * may lean on the group before: that one is then decoded whole too. Normal speed wants every
 * frame, so everything is decoded, as before. */
function decodeList(vt, d0, end, want) {
  const gops = [];
  for (let i = d0; i < end; i++) if (i === d0 || vt.key[i]) gops.push({ a: i, b: end, mode: 0 });
  for (let g = 0; g < gops.length; g++) {
    const G = gops[g];
    if (g + 1 < gops.length) G.b = gops[g + 1].a;
    const kp = vt.pts[G.a];
    for (let i = G.a; i < G.b; i++) {
      if (!want.has(Math.round(vt.pts[i] * 1e6))) continue;
      if (i === G.a) { G.mode = Math.max(G.mode, 1); continue; }
      G.mode = 2;
      if (vt.pts[i] < kp && g > 0) gops[g - 1].lead = true;
    }
  }
  const out = [];
  for (const G of gops) {
    const mode = G.lead ? 2 : G.mode;
    if (mode === 2) for (let i = G.a; i < G.b; i++) out.push(i);
    else if (mode === 1) out.push(G.a);
  }
  return out;
}

// ── Exact: audio into OPFS (audio.bin + audio.idx [pts, size] per packet) ─────────
async function audioJob(m) {
  await openFile(m.file);
  const dir = await jobDir(m.job);
  if (info.audio < 0) { post({ op: "audioDone", meta: null }); return; }
  const sink = await openSink(dir, "audio.bin");
  const idx = [];
  const put = (data, pts) => { sink.write(data); idx.push(pts, data.length); };
  let meta;
  try { meta = await exactAudio(m, put, (f) => post({ op: "audioProg", f })); }
  finally { sink.close(); }
  if (meta) meta.bytes = sink.off;
  await writeWhole(dir, "audio.idx", new Uint8Array(Float64Array.from(idx).buffer));
  post({ op: "audioDone", meta });
}

// ── Exact: the final file from the finished segments ─────────────────────────────
// Parameter sets: every segment comes from an encoder with the same settings, so they are
// normally identical; if one differs, its own SPS/PPS (VPS) go in-band before its first frame.
function paramNals(codec, d) {
  const out = [];
  try {
    if (codec === "h264") {
      let p = 5;
      const nsps = d[p++] & 31;
      for (let k = 0; k < nsps; k++) { const n = (d[p] << 8) | d[p + 1]; out.push(d.subarray(p + 2, p + 2 + n)); p += 2 + n; }
      const npps = d[p++];
      for (let k = 0; k < npps; k++) { const n = (d[p] << 8) | d[p + 1]; out.push(d.subarray(p + 2, p + 2 + n)); p += 2 + n; }
    } else if (codec === "hevc") {
      let p = 22;
      const arrays = d[p++];
      for (let a = 0; a < arrays; a++) {
        p++;
        const cnt = (d[p] << 8) | d[p + 1]; p += 2;
        for (let k = 0; k < cnt; k++) { const n = (d[p] << 8) | d[p + 1]; out.push(d.subarray(p + 2, p + 2 + n)); p += 2 + n; }
      }
    }
  } catch {}
  const lenSize = ((codec === "h264" ? d[4] : d[21]) & 3) + 1;
  const total = out.reduce((a, x) => a + lenSize + x.length, 0);
  const b = new Uint8Array(total);
  let o = 0;
  for (const x of out) { for (let k = lenSize - 1; k >= 0; k--) b[o++] = (x.length >> (8 * k)) & 255; b.set(x, o); o += x.length; }
  return b;
}
const sameBytes = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

async function muxJob(m) {
  await ready;
  const dir = await jobDir(m.job);
  const { s, segs, audio } = m;
  const totalFrames = segs.reduce((a, x) => a + x.n, 0) || 1;
  let mux = null, vTrack = -1, aTrack = -1, written = 0, lastPts = 0;
  let aIdx = null, aData = null, ai = 0, aOff = 0;
  if (audio) { aIdx = new Float64Array((await readWhole(dir, "audio.idx")).buffer); aData = await readWhole(dir, "audio.bin"); }
  const writeAudioUntil = (t) => {
    if (!aIdx) return;
    while (ai < aIdx.length && aIdx[ai] <= t) { const n = aIdx[ai + 1]; mux.write(aTrack, aData.subarray(aOff, aOff + n), aIdx[ai], true); aOff += n; ai += 2; }
  };
  const firstDesc = segs[0].desc ? new Uint8Array(segs[0].desc) : new Uint8Array(0);
  let buf = new Uint8Array(32 << 20);
  for (const sg of segs) {
    const idx = new Float64Array((await readWhole(dir, `seg-${sg.i}.idx`)).buffer);
    const fh = await dir.getFileHandle(`seg-${sg.i}.bin`);
    const ah = await fh.createSyncAccessHandle();
    try {
      let bufAt = 0, bufLen = 0, off = 0;
      const inband = (s.vcodec === "h264" || s.vcodec === "hevc") && sg.desc && !sameBytes(new Uint8Array(sg.desc), firstDesc) ? paramNals(s.vcodec, new Uint8Array(sg.desc)) : null;
      for (let k = 0; k < idx.length; k += 3) {
        const pts = idx[k], key = idx[k + 1] === 1, n = idx[k + 2];
        if (off + n > bufAt + bufLen) {
          if (buf.length < n) buf = new Uint8Array(n);
          bufAt = off;
          bufLen = ah.read(buf, { at: off });
          if (bufLen < n) throw new Error("A finished part of the export is damaged. Export again.");
        }
        let data = buf.subarray(off - bufAt, off - bufAt + n);
        off += n;
        if (!mux) {
          mux = new Mux(s.container, m.dry ? () => {} : chunk);
          let d = firstDesc;
          if (s.vcodec === "av1" && !d.length) { const [, prof, lvl, depth] = sg.codec.split("."); d = av1c(+prof, parseInt(lvl), lvl.endsWith("H"), +depth, data); }
          vTrack = mux.add_video(s.vcodec, s.outW, s.outH, d, s.timescale, Uint16Array.from(colorCodes(sg.color || segs.find((x) => x.color)?.color)));
          if (audio) aTrack = mux.add_audio(audio.codec, audio.rate, audio.channels, audio.desc, audio.start || 0);
        }
        if (inband && k === 0) { const b = new Uint8Array(inband.length + data.length); b.set(inband); b.set(data, inband.length); data = b; }
        writeAudioUntil(pts);
        mux.write(vTrack, data, pts, key);
        lastPts = pts;
        written++;
        if (written % 64 === 0 && !m.dry) progress(written, totalFrames, "Finishing");
      }
    } finally { ah.close(); }
  }
  if (!mux) throw new Error("Nothing was encoded.");
  writeAudioUntil(Infinity);
  const lastDur = Math.max(1 / (s.fps || 30), m.totalOut - lastPts);
  const bytes = mux.finish(Float64Array.from([lastDur, audio?.frameDur || 0.02]));
  post({ op: "done", dur: m.totalOut, bytes, frames: written });
}

// Audio for Exact. Unchanged audio is copied bit for bit when the container can hold its codec
// (each piece takes the packets nearest its cut, so sync stays within half a packet at every
// join and never drifts; the encoder delay and the cut inside the first packet go into an edit
// list, exact at the start); otherwise it is decoded, volume and speed applied (speed keeps the
// pitch: WSOLA time stretch), and encoded at the highest quality this browser offers: AAC up
// to 320 kb/s (MP4/MOV/MKV), Opus 510 kb/s (WebM), or 24-bit PCM (MOV/MKV, "lossless audio").
// Sample rate and channels are kept (Opus needs 48 kHz: other rates are resampled, WebM only).
async function exactAudio(m, put, onProgress) {
  const { pieces, container } = m;
  const tr = info.tracks[info.audio];
  const at = table(info.audio);
  const outDur = pieces.map((p) => (p.end - p.start) / p.speed);
  const plain = pieces.every((p) => p.speed === 1 && p.volume === 1);
  const fits = (tr.codec === "aac" && container !== "webm") || (tr.codec === "opus" && container !== "mov");
  const srcRate = tr.sampleRate || 48000, ch = tr.channels || 2;
  const afit = m.afit && !m.afit.copy ? m.afit : null; // size target: encode at a chosen rate
  if (plain && fits && !m.pcm && !afit) {
    const rate = tr.codec === "opus" ? 48000 : srcRate; // the track's tick rate
    const order = Array.from({ length: at.n }, (_, i) => i).sort((a, b) => at.pts[a] - at.pts[b]);
    const P = order.map((i) => at.pts[i]);
    const near = (s) => { let lo = 0, hi = P.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (P[mid] <= s) lo = mid; else hi = mid - 1; } return lo; };
    let W = null; // ticks written so far, counted from the movie's time 0 (negative = before it)
    let start = 0, base = 0;
    pieces.forEach((p, k) => {
      let j;
      if (W === null) {
        j = near(p.start + 1e-9); // the packet holding the In point
        // Matroska has no edit list (and no negative times): start on the first whole packet
        // after In instead, at its exact time (a few ms of silence, never a shift)
        if ((container === "mkv" || container === "webm") && P[j] < p.start - 1e-6 && j + 1 < P.length) j++;
        start = Math.max(0, Math.round((p.start - P[j]) * rate));
        W = -start;
        if (P[j] > p.start) W = Math.round((P[j] - p.start) * rate);
      } else {
        const s = p.start + (W / rate - base); // where the next packet should start in the source
        j = near(s);
        if (j + 1 < P.length && Math.abs(P[j + 1] - s) < Math.abs(P[j] - s)) j++;
      }
      const endT = Math.round((base + outDur[k]) * rate);
      for (; j < order.length; j++) {
        const d = Math.round(at.dur[order[j]] * rate);
        if (W + d / 2 > endT) break;
        use("audio");
        put(media.read(info.audio, order[j]), W / rate);
        W += d;
      }
      base += outDur[k];
    });
    onProgress(1);
    const fd = at.n ? at.dur[order[order.length - 1]] : 1024 / rate;
    return { codec: tr.codec, rate: srcRate, channels: ch, desc: media.description(info.audio), frameDur: fd, start };
  }
  if (!self.AudioDecoder || !tr.codecString) return null;
  const decConf = { codec: tr.codecString, sampleRate: srcRate, numberOfChannels: ch };
  const dsc = media.description(info.audio);
  if (dsc.length) decConf.description = dsc;
  if (!(await AudioDecoder.isConfigSupported(decConf).catch(() => ({}))).supported) return null;
  let codec, rate = srcRate, encConf = null, outCh = ch, step = 1024;
  const sup = async (c) => (await AudioEncoder.isConfigSupported(c).catch(() => ({}))).supported;
  if (afit) {
    codec = afit.codec; outCh = Math.min(ch, afit.channels || ch);
    if (codec === "opus") {
      rate = 48000; step = (afit.frameMs || 20) * 48;
      encConf = { codec: "opus", sampleRate: 48000, numberOfChannels: outCh, bitrate: afit.bitrate, opus: { frameDuration: step * 1000 / 48, complexity: 10 } };
      if (!(await sup(encConf))) { delete encConf.opus; step = 960; }
    } else encConf = { codec: "mp4a.40.2", sampleRate: rate, numberOfChannels: outCh, bitrate: afit.bitrate };
  } else if (m.pcm && container !== "webm" && container !== "mp4") codec = "pcm";
  else if (container === "webm") { codec = "opus"; rate = 48000; encConf = { codec: "opus", sampleRate: 48000, numberOfChannels: ch, bitrate: 510000 }; }
  else {
    // AAC at the highest bit rate this browser's encoder takes (Windows' tops out at 192 kb/s)
    codec = "aac";
    for (const br of [320000, 288000, 256000, 224000, 192000, 160000, 128000]) {
      const c = { codec: "mp4a.40.2", sampleRate: rate, numberOfChannels: ch, bitrate: br };
      if (await sup(c)) { encConf = c; break; }
    }
    if (!encConf) { codec = "opus"; rate = 48000; encConf = { codec: "opus", sampleRate: 48000, numberOfChannels: ch, bitrate: 510000 }; }
  }
  if (encConf && !(await sup(encConf))) throw new Error(`This browser can't encode ${codec.toUpperCase()} audio with ${outCh} channels.`);
  let desc = new Uint8Array(0), failure = null, enc = null, encoded = 0;
  if (!afit) step = codec === "opus" ? 960 : 1024;
  if (encConf) {
    enc = new AudioEncoder({
      output: (c, meta) => {
        const d = meta?.decoderConfig?.description;
        if (d && !desc.length) desc = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
        const b = new Uint8Array(c.byteLength);
        c.copyTo(b);
        // packets back to back: AAC 1024 / Opus 960 samples each
        put(b, (encoded * step) / rate);
        encoded++;
      },
      error: (e) => { failure ||= e; },
    });
    enc.configure(encConf);
  }
  const total = Math.round(outDur.reduce((a, b) => a + b, 0) * rate);
  let written = 0, base = 0;
  for (let k = 0; k < pieces.length; k++) {
    const p = pieces[k];
    const pieceOutEnd = Math.round((base + outDur[k]) * rate);
    // seconds of source per block: 60, and at most 60 s of output (a 0.1× piece would otherwise
    // stretch 60 s into 600 s: ~230 MB per channel set in one go); faster than MUTE_ABOVE: silence
    // (a time stretch that fast is only noise), in blocks of 60 s of output, nothing decoded
    const mute = p.speed > MUTE_ABOVE;
    const BLOCK = mute ? 60 * p.speed : 60 * Math.min(1, p.speed);
    for (let b0 = p.start; b0 < p.end - 1e-6; b0 += BLOCK) {
      const b1 = Math.min(p.end, b0 + BLOCK);
      let pcm;
      if (mute) pcm = Array.from({ length: ch }, () => new Float32Array(0));
      else pcm = await decodeRange(decConf, at, b0, b1, srcRate, ch);
      if (p.volume !== 1 && !mute) for (const c of pcm) for (let i = 0; i < c.length; i++) c[i] = Math.max(-1, Math.min(1, c[i] * p.volume));
      if (p.speed !== 1 && !mute) {
        const flat = new Float32Array(pcm[0].length * ch);
        pcm.forEach((c, i) => flat.set(c, i * c.length));
        const out = stretch(flat, ch, srcRate, p.speed);
        const n = out.length / ch;
        pcm = pcm.map((_, i) => out.subarray(i * n, (i + 1) * n));
      }
      if (outCh < ch) pcm = downmix(pcm, outCh);
      if (srcRate !== rate) pcm = pcm.map((c) => resample(c, srcRate, rate));
      const want = (b1 >= p.end - 1e-6 ? pieceOutEnd : Math.round((base + (b1 - p.start) / p.speed) * rate)) - written;
      pcm = pcm.map((c) => fit(c, Math.max(0, want)));
      const chunkN = codec === "pcm" ? 1024 : rate;
      for (let off = 0; off < want; off += chunkN) {
        const n = Math.min(chunkN, want - off);
        if (codec === "pcm") {
          const b = new Uint8Array(n * ch * 3);
          for (let j = 0, o = 0; j < n; j++) for (let c = 0; c < ch; c++, o += 3) {
            const v = Math.round(Math.max(-1, Math.min(1, pcm[c][off + j])) * 8388607);
            b[o] = v & 255; b[o + 1] = (v >> 8) & 255; b[o + 2] = (v >> 16) & 255;
          }
          put(b, (written + off) / rate);
        } else {
          const data = new Float32Array(n * outCh);
          pcm.forEach((c, i) => data.set(c.subarray(off, off + n), i * n));
          const ad = new AudioData({ format: "f32-planar", sampleRate: rate, numberOfFrames: n, numberOfChannels: outCh, timestamp: Math.round(((written + off) / rate) * 1e6), data });
          enc.encode(ad);
          ad.close();
          if (enc.encodeQueueSize > 16) await wait(enc, "dequeue");
        }
      }
      written += Math.max(0, want);
      onProgress(written / Math.max(1, total));
      if (failure) throw failure;
    }
    base += outDur[k];
  }
  if (enc) { await enc.flush(); enc.close(); }
  if (failure) throw failure;
  // the AAC encoder's delay (priming), measured, so the edit list hides it
  const start = codec === "aac" ? await encoderDelay(encConf, desc) : 0;
  const fd = codec === "pcm" ? 1024 / rate : step / rate;
  return { codec, rate, channels: codec === "pcm" ? ch : outCh, desc, frameDur: fd, start };
}

/** Samples of delay an AAC encode + decode round trip adds (priming): encode a click, find it. */
let delayCache = null;
async function encoderDelay(conf, desc) {
  if (delayCache != null) return delayCache;
  const rate = conf.sampleRate, ch = conf.numberOfChannels, N = 1024 * 12, at = 4096;
  const pk = [];
  const enc = new AudioEncoder({ output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); pk.push(b); }, error: () => {} });
  enc.configure(conf);
  const data = new Float32Array(N * ch);
  for (let c = 0; c < ch; c++) for (let k = 0; k < 64; k++) data[c * N + at + k] = Math.sin((k / 64) * Math.PI) * 0.8;
  const ad = new AudioData({ format: "f32-planar", sampleRate: rate, numberOfFrames: N, numberOfChannels: ch, timestamp: 0, data });
  enc.encode(ad); ad.close();
  await enc.flush(); enc.close();
  const outS = [];
  const dec = new AudioDecoder({ output: (a) => { const t = new Float32Array(a.numberOfFrames); a.copyTo(t, { planeIndex: 0, format: "f32-planar" }); outS.push(t); a.close(); }, error: () => {} });
  const dc = { codec: "mp4a.40.2", sampleRate: rate, numberOfChannels: ch };
  if (desc.length) dc.description = desc;
  dec.configure(dc);
  pk.forEach((b, i) => dec.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round((i * 1024 * 1e6) / rate), data: b })));
  await dec.flush(); dec.close();
  let best = -1, bv = 0, pos = 0;
  for (const s of outS) { for (let k = 0; k < s.length; k++) if (Math.abs(s[k]) > bv) { bv = Math.abs(s[k]); best = pos + k; } pos += s.length; }
  delayCache = best < 0 ? 0 : Math.max(0, Math.round(best - (at + 32)));
  return delayCache;
}

async function decodeRange(conf, at, t0, t1, rate, ch) {
  const n = Math.max(0, Math.round((t1 - t0) * rate));
  const out = Array.from({ length: ch }, () => new Float32Array(n));
  let tmp = new Float32Array(4096);
  const dec = new AudioDecoder({
    output: (a) => {
      const len = a.numberOfFrames, ts = a.timestamp / 1e6;
      const at0 = Math.round((ts - t0) * rate);
      if (tmp.length < len) tmp = new Float32Array(len);
      for (let c = 0; c < ch; c++) {
        a.copyTo(tmp, { planeIndex: Math.min(c, a.numberOfChannels - 1), format: "f32-planar" });
        const o = out[c];
        for (let j = 0; j < len; j++) { const k = at0 + j; if (k >= 0 && k < n) o[k] = tmp[j]; }
      }
      a.close();
    },
    error: () => {},
  });
  dec.configure(conf);
  for (let i = 0; i < at.n; i++) {
    const t = at.pts[i];
    if (t + at.dur[i] < t0 - 0.2 || t > t1 + 0.1) continue;
    use("audio");
    dec.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round(t * 1e6), duration: Math.round(at.dur[i] * 1e6), data: media.read(info.audio, i) }));
    if (dec.decodeQueueSize > 48) await wait(dec, "dequeue");
  }
  await dec.flush();
  dec.close();
  return out;
}

/** Fewer channels: mono = the average; stereo from 5.1 (L R C LFE Ls Rs) = ITU-style fold-down. */
function downmix(pcm, n) {
  const len = pcm[0].length, ch = pcm.length;
  if (n === 1) { const o = new Float32Array(len); for (const c of pcm) for (let i = 0; i < len; i++) o[i] += c[i] / ch; return [o]; }
  if (ch >= 6) {
    const k = 0.7071, g = 1 / (1 + 2 * k), L = new Float32Array(len), R = new Float32Array(len);
    for (let i = 0; i < len; i++) { L[i] = (pcm[0][i] + k * pcm[2][i] + k * pcm[4][i]) * g; R[i] = (pcm[1][i] + k * pcm[2][i] + k * pcm[5][i]) * g; }
    return [L, R];
  }
  return pcm.slice(0, n);
}
function resample(x, from, to) {
  const n = Math.round((x.length * to) / from), y = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * r, k = Math.floor(p), f = p - k;
    y[i] = (x[k] ?? 0) * (1 - f) + (x[k + 1] ?? x[k] ?? 0) * f;
  }
  return y;
}
function fit(x, n) {
  if (x.length === n) return x;
  const y = new Float32Array(n);
  y.set(x.subarray(0, Math.min(n, x.length)));
  return y;
}
