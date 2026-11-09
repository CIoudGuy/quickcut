// QuickCut Video: Exact export as a resumable, parallel job.
//
// The output frames are planned in segments of a few seconds cut at source key frames. Several
// worker instances (each with its own decoder + encoder) take segments from one queue and write
// each finished segment into the origin's private storage (OPFS, `qcv-jobs/<id>/seg-N.bin` +
// `.idx`), next to a small journal (`journal.json`: settings, source identity, finished
// segments). A muxer worker then writes the final file from the parts. If the page reloads or
// crashes, the journal says what is done: "Continue export" re-opens the source (its file handle
// is kept in IndexedDB) and only encodes what is missing.
//
// Workers: start with two, add one at a time up to min(4, cores/2) while the total frame rate
// keeps rising (≥ 10 %), back off when it doesn't or when the GPU refuses another encoder.
// A worker whose hardware encoder fails is retired when others run; the last one falls back to
// the software encoder of the same codec.
//
// Storage hygiene: a finished, cancelled or discarded job deletes its folder; leftovers are
// deleted when older than 3 days, when a new export starts, and when the origin's storage use is
// high.

import { weights, partRate, redoParts } from "./fit.js";

const DIR = "qcv-jobs";
const DAY = 86400e3;

async function root() { return navigator.storage.getDirectory(); }
async function jobsDir() { return (await root()).getDirectoryHandle(DIR, { create: true }); }

// ── file handles (source + output) live in IndexedDB; the journal in OPFS ──────────────
let dbp = null;
function db() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open("quickcut-video", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("jobs", { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  });
  return dbp;
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction("jobs", mode);
    const out = fn(t.objectStore("jobs"));
    t.oncomplete = () => res(out instanceof IDBRequest ? out.result : undefined);
    t.onerror = () => rej(t.error);
  });
}

let saving = Promise.resolve();
const removed = new Set();
export const jobs = {
  newId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  /** Write the journal (saves run one after another, so the newest always lands last). */
  save(j) {
    const run = async () => {
      if (removed.has(j.id)) return; // cancelled/discarded: never re-create its folder
      j.updated = Date.now();
      const dir = await (await jobsDir()).getDirectoryHandle(j.id, { create: true });
      const fh = await dir.getFileHandle("journal.json", { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify(j));
      await w.close();
    };
    const p = saving.then(run, run);
    saving = p.catch(() => {});
    return p;
  },
  async setHandles(id, h) { try { await idb("readwrite", (s) => s.put({ id, ...h })); } catch {} },
  async handles(id) { try { return (await idb("readonly", (s) => s.get(id))) || {}; } catch { return {}; } },
  /** Unfinished jobs, newest first: [{id, j (journal)}]. */
  async list() {
    const out = [];
    try {
      for await (const [name, h] of (await jobsDir()).entries()) {
        if (h.kind !== "directory") continue;
        try {
          const f = await (await h.getFileHandle("journal.json")).getFile();
          const j = JSON.parse(await f.text());
          if (j && j.id === name && j.state !== "done") out.push({ id: name, j });
          else out.push({ id: name, j: null });
        } catch { out.push({ id: name, j: null }); }
      }
    } catch {}
    return out.sort((a, b) => (b.j?.updated || 0) - (a.j?.updated || 0));
  },
  /** Delete a job's folder. Stopped workers may still hold a file open for a moment, and a
   * journal save may be on its way: wait for it, and retry a few times. */
  async remove(id) {
    removed.add(id);
    await saving;
    for (let k = 0; k < 8; k++) {
      try { await (await jobsDir()).removeEntry(id, { recursive: true }); break; }
      catch (e) { if (e?.name === "NotFoundError") break; await new Promise((r) => setTimeout(r, 150 * (k + 1))); }
    }
    try { await idb("readwrite", (s) => s.delete(id)); } catch {}
  },
  /**
   * Delete leftovers: `all` (a new export starts), or those older than 3 days, or everything
   * when storage use is high. `keep`: the id of a running job. Also old temporary outputs.
   */
  async cleanup({ all = false, keep = null } = {}) {
    let heavy = false;
    try { const e = await navigator.storage.estimate(); heavy = e.quota > 0 && e.usage / e.quota > 0.6; } catch {}
    for (const { id, j } of await jobs.list()) {
      if (id === keep) continue;
      if (all || heavy || !j || Date.now() - (j.updated || 0) > 3 * DAY) await jobs.remove(id);
    }
    // temporary outputs of browsers without a save dialog (downloaded long ago)
    try {
      for await (const [name, h] of (await root()).entries()) {
        if (h.kind !== "file" || !name.startsWith("qcv-out-")) continue;
        const t = parseInt(name.slice(8), 10);
        if (all || heavy || !(t > 0) || Date.now() - t > 10 * 60e3) { try { await (await root()).removeEntry(name); } catch {} }
      }
    } catch {}
    return heavy;
  },
};

// ── the job ──────────────────────────────────────────────────────────────────
/**
 * Run (or continue) an Exact export.
 *   o.j: the journal ({id, s: settings, src, done: {}, ...}); saved as it goes
 *   o.file: the source File; o.probe: a worker that has the file open (for the plan)
 *   o.out: {push(pos, data)} for the final file's bytes
 *   o.onProgress({frac, stage, left}); o.workers: fixed worker count (tests)
 * Returns {promise, cancel}. The promise resolves to {bytes, dur, frames, stats}.
 *
 * Size target (s.fit = {target, margin, over, aEst, cap, min}): each part asks for its own bit
 * rate so the whole lands on the budget (fit.js partRate: real bytes of finished parts, the
 * encoders' measured overshoot, complexity weights from the source). Before the final file is
 * written its exact size is measured (a muxer run that writes nothing); if it is over the target,
 * the biggest parts are encoded again at a lower rate (up to 4 rounds). A file over the target
 * is never written.
 */
export function runExact(o) {
  const J = o.j, s = J.s;
  const live = new Set();
  let cancelled = false, failed = null;
  const stats = { workers: [], started: performance.now(), rates: [], events: [] };
  const note = (what) => { if (stats.events.length < 200) stats.events.push([Math.round((performance.now() - stats.started) / 100) / 10, what]); };
  const spawn = () => { const w = new Worker(o.workerUrl, { type: "module" }); live.add(w); return w; };
  const kill = (w) => { try { w.terminate(); } catch {} live.delete(w); };
  const cancel = () => { cancelled = true; for (const w of [...live]) kill(w); };

  const promise = (async () => {
    // 1. the plan (same source + settings = same plan, so a continued job lines up)
    const plan = await new Promise((res, rej) => {
      const id = Math.random();
      const h = (e) => { if (e.data.op === "plan" && e.data.id === id) { o.probe.removeEventListener("message", h); res(e.data); } else if (e.data.op === "error" && e.data.what === "plan") { o.probe.removeEventListener("message", h); rej(new Error(e.data.why)); } };
      o.probe.addEventListener("message", h);
      o.probe.postMessage({ op: "plan", id, pieces: s.pieces, fps: s.fps, file: o.file, segSecs: s.segSecs, cap: !!s.capFps, weights: !!s.fit && !J.fitState });
    });
    if (cancelled) throw new Error("cancelled");
    const count = plan.segs.length;
    if (J.plan && (J.plan.count !== count || J.plan.frames !== plan.frames)) throw new Error("The source file is not the same as before. Export again.");
    J.plan = { count, frames: plan.frames, totalOut: plan.totalOut };
    J.done ||= {};
    const segFrames = plan.segs.map((x) => x.length / 2);
    // size target: the budget state lives in the journal (a continued job keeps it)
    const F = s.fit ? (J.fitState ||= (() => {
      const d = segFrames.map((n) => n / (s.fps || 30));
      return { d, w: weights(plan.density, d), req: {}, fixed: {}, round: 0, sizes: [] };
    })()) : null;
    // video bytes to spend: the target minus slack, container and audio (the real audio size once
    // known); at most what top quality needs (vmax)
    const fitBudget = () => Math.min(s.fit.vmax || Infinity, s.fit.target * s.fit.margin - s.fit.over - (J.audio ? J.audio.bytes ?? s.fit.aEst : s.fit.aEst));
    if (F) { F.budget = fitBudget(); F.cap = s.fit.cap; F.min = s.fit.min; }
    await o.save(J);
    const needAudio = o.hasAudio && J.audio === undefined;
    if (F) stats.fit = { target: s.fit.target, parts: count, rounds: [], log: [] };

    // progress: audio 2 %, video 93 %, final file 5 %; never goes backwards. A size correction
    // round adds its frames to the total.
    const prog = { inSeg: new Map(), audio: J.audio !== undefined || !o.hasAudio ? 1 : 0, mux: 0, max: 0, stage: "Encoding video", extra: 0, extraDone: 0 };
    const doneFrames = () => Object.values(J.done).reduce((a, d) => a + d.frames, 0);
    const samples = []; // [time, frames encoded so far] for the rate
    let lastReport = 0;
    const report = (force) => {
      const now = performance.now();
      if (!force && now - lastReport < 150) return;
      lastReport = now;
      let f = doneFrames() + prog.extraDone;
      for (const n of prog.inSeg.values()) f += n;
      const all = plan.frames + prog.extra;
      samples.push([now, f]);
      while (samples.length > 2 && now - samples[0][0] > 6000) samples.shift();
      const frac = Math.min(1, 0.02 * prog.audio + 0.93 * (f / Math.max(1, all)) + 0.05 * prog.mux);
      prog.max = Math.max(prog.max, frac);
      // time left: frames still to encode at the recent rate, plus the final file (~ 1 GB/s)
      const [t0, f0] = samples[0];
      const rate = now - t0 > 1500 ? ((f - f0) * 1000) / (now - t0) : 0;
      stats.rate = rate;
      const outBytes = s.fit ? s.fit.target : (s.bitrate / 8) * plan.totalOut;
      const left = prog.mux > 0 ? null : rate > 0 ? Math.max(0, all - f) / rate + outBytes / 1e9 : null;
      o.onProgress({ frac: prog.max, stage: prog.stage, left: prog.mux > 0 ? (prog.muxLeft ?? null) : left, fps: rate });
    };

    // 2. audio, alongside the video
    const audioDone = needAudio ? new Promise((res, rej) => {
      const w = spawn();
      w.onmessage = async (e) => {
        const m = e.data;
        if (m.op === "audioProg") { prog.audio = m.f; report(); }
        else if (m.op === "audioDone") {
          kill(w); J.audio = m.meta ? { ...m.meta, desc: [...(m.meta.desc || [])] } : null; prog.audio = 1;
          if (F) F.budget = fitBudget(); // the real audio size replaces the estimate
          await o.save(J); res();
        } else if (m.op === "error") { kill(w); rej(new Error(m.why)); }
      };
      w.onerror = (e) => { kill(w); rej(new Error(e.message || "the audio worker failed")); };
      w.postMessage({ op: "audio", job: J.id, file: o.file, pieces: s.pieces, container: s.container, pcm: s.pcm, afit: s.afit || null });
    }) : Promise.resolve();

    // 3. video segments (a size target may run this again for parts that must shrink)
    const maxN = o.workers || Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
    const fixed = !!o.workers;
    let softwareOnly = !!s.software;
    const encodeParts = (queue) => new Promise((resolveVideo, rejectVideo) => {
      const tries = new Map();
      let target = fixed ? maxN : Math.min(2, maxN);
      const active = new Set(); // segment workers {w, seg, retire, hw}
      const byCount = new Map(); // workers → best rate seen with that many
      let lastAdd = performance.now(), ramping = !fixed, over = false, ramp = 0;
      const end = () => { over = true; clearInterval(ramp); };
      const finishIfDone = () => { if (!over && !queue.length && [...active].every((a) => a.seg == null)) { for (const a of [...active]) { kill(a.w); active.delete(a); } end(); resolveVideo(); } };
      const fail = (err) => { failed ||= err; end(); rejectVideo(err); };
      const running = () => [...active].filter((a) => a.seg != null).map((a) => a.seg);
      const next = (a) => {
        if (a.retire || cancelled || failed) { kill(a.w); active.delete(a); if (!active.size && queue.length && !failed && !cancelled) startWorker(); finishIfDone(); return; }
        const i = queue.shift();
        if (i == null) { a.seg = null; finishIfDone(); return; }
        let bitrate;
        if (F) { bitrate = partRate(F, i, J.done, running()); F.req[i] = bitrate; }
        a.seg = i;
        prog.inSeg.set(i, 0);
        a.w.postMessage({ op: "seg", i, frames: plan.segs[i], bitrate });
      };
      const startWorker = () => {
        const w = spawn();
        const a = { w, seg: null, retire: false, hw: false, t0: performance.now() };
        active.add(a);
        stats.workers.push({ at: Math.round(performance.now() - stats.started) });
        w.onmessage = async (e) => {
          const m = e.data;
          if (m.op === "segReady") { a.hw = m.hw; next(a); }
          else if (m.op === "segProg") { prog.inSeg.set(m.i, m.n); report(); }
          else if (m.op === "segDone") {
            prog.inSeg.delete(m.i);
            stats.decoded = (stats.decoded || 0) + (m.decoded || 0); // source frames decoded (fast pieces skip most)
            J.done[m.i] = { frames: m.n, bytes: m.bytes, desc: m.desc ? [...m.desc] : null, codec: m.codec, color: m.color || null };
            if (F && stats.fit.log.length < 4000) stats.fit.log.push([m.i, m.bitrate, Math.round((m.bytes * 8) / F.d[m.i])]);
            a.seg = null;
            try { await o.save(J); } catch {}
            report(true);
            next(a);
          } else if (m.op === "segFail") {
            note(`part ${m.i + 1} failed: ${m.why}`);
            prog.inSeg.delete(m.i);
            a.seg = null;
            const n = (tries.get(m.i) || 0) + 1;
            tries.set(m.i, n);
            queue.unshift(m.i);
            if (/storage is full|QuotaExceeded/i.test(m.why)) { fail(new Error("The browser's storage is full. Free some disk space and continue the export.")); return; }
            if (n > 3) { fail(new Error(m.why)); return; }
            // the GPU refused (or lost) this encoder: retire this worker while others run; the last
            // one switches to the software encoder
            kill(w); active.delete(a);
            target = Math.max(1, active.size);
            ramping = false;
            if (!active.size) { if (m.hw) softwareOnly = true; startWorker(); }
          } else if (m.op === "error") {
            note(`worker failed: ${m.why}`);
            kill(w); active.delete(a);
            if (a.seg != null) queue.unshift(a.seg);
            if (active.size) { target = active.size; ramping = false; finishIfDone(); }
            else if (!softwareOnly) { softwareOnly = true; startWorker(); }
            else fail(new Error(m.why));
          }
        };
        w.onerror = (e) => { e.preventDefault?.(); w.onmessage({ data: { op: "error", why: e.message || "an export worker failed" } }); };
        w.postMessage({ op: "segInit", job: J.id, file: o.file, s, software: softwareOnly });
      };
      if (!queue.length) { end(); resolveVideo(); return; }
      // ramp: one more worker while the total rate keeps rising
      ramp = setInterval(() => {
        report(true);
        const now = performance.now();
        const r = stats.rate || 0;
        if (stats.rates.length < 900) stats.rates.push([Math.round((now - stats.started) / 1000), active.size, Math.round(r)]);
        if (!ramping || cancelled || failed || now - lastAdd < 7000 || !r) return;
        const k = active.size;
        byCount.set(k, Math.max(byCount.get(k) || 0, r));
        const prev = byCount.get(k - 1);
        if (prev && r < prev * 1.1) {
          // the last one didn't help: back off (it stops after its current segment)
          const newest = [...active].pop();
          if (newest && k > 1) { newest.retire = true; note(`${k} workers no faster than ${k - 1}: back to ${k - 1}`); }
          ramping = false;
          return;
        }
        if (k < maxN && queue.length > 0) { target = k + 1; startWorker(); lastAdd = now; }
        else ramping = false;
      }, 1000);
      for (let k = 0; k < Math.min(target, queue.length); k++) startWorker();
    });
    const first = [];
    for (let i = 0; i < count; i++) if (!J.done[i]) first.push(i);
    await Promise.all([encodeParts(first), audioDone]);
    if (cancelled) throw new Error("cancelled");
    stats.encodeSecs = (performance.now() - stats.started) / 1000;

    // 4. the final file
    const audio = J.audio ? { ...J.audio, desc: Uint8Array.from(J.audio.desc || []) } : null;
    const segList = () => {
      const segs = [];
      for (let i = 0; i < count; i++) { const d = J.done[i]; if (d && d.frames) segs.push({ i, n: d.frames, desc: d.desc ? Uint8Array.from(d.desc) : null, codec: d.codec, color: d.color }); }
      return segs;
    };
    const mux = (dry) => new Promise((res, rej) => {
      const w = spawn();
      const t0 = performance.now();
      w.onmessage = (e) => {
        const m = e.data;
        if (m.op === "chunk") { if (!dry) o.out.push(m.pos, m.data); }
        else if (m.op === "progress") {
          if (dry) return;
          prog.mux = m.done / Math.max(1, m.total);
          const el = (performance.now() - t0) / 1000;
          prog.muxLeft = prog.mux > 0.05 ? (el * (1 - prog.mux)) / prog.mux : null;
          report();
        } else if (m.op === "done") { kill(w); res(m); }
        else if (m.op === "error") { kill(w); rej(new Error(m.why)); }
      };
      w.onerror = (e) => { kill(w); rej(new Error(e.message || "the muxer failed")); };
      w.postMessage({ op: "mux", job: J.id, s, segs: segList(), audio, totalOut: plan.totalOut, dry });
    });
    if (F) {
      // the exact size first (a muxer run that writes nothing); shrink the biggest parts until
      // the file fits
      prog.stage = "Checking the size";
      report(true);
      for (;;) {
        const t0 = performance.now();
        const { bytes } = await mux(true);
        if (cancelled) throw new Error("cancelled");
        const payload = Object.values(J.done).reduce((a, d) => a + d.bytes, 0) + (J.audio?.bytes || 0);
        stats.fit.rounds.push({ bytes, overhead: bytes - payload, ms: Math.round(performance.now() - t0) });
        F.sizes.push(bytes);
        if (bytes <= s.fit.target) break;
        if (F.round >= 4) throw new Error(`The result is still ${fmtMB(bytes)}, over ${fmtMB(s.fit.target)}. Try a larger size.`);
        const redo = redoParts(F, J.done, bytes - s.fit.target * 0.985, F.round);
        F.round++;
        const list = Object.keys(redo).map(Number).sort((a, b) => a - b);
        note(`over by ${bytes - s.fit.target} bytes: ${list.length} part(s) again`);
        let again = 0;
        for (const i of list) { F.fixed[i] = redo[i]; again += J.done[i].frames; delete J.done[i]; }
        await o.save(J);
        prog.stage = "Fitting to size";
        prog.extra += again; prog.extraDone += again;
        samples.length = 0;
        await encodeParts(list);
        if (cancelled) throw new Error("cancelled");
        for (const i of list) delete F.fixed[i];
      }
    }
    prog.stage = "Finishing";
    const res = await mux(false);
    if (cancelled) throw new Error("cancelled");
    // (can't happen: the same parts as measured; never hand over a file over the limit)
    if (s.fit && res.bytes > s.fit.target) throw new Error("The result came out over the size limit.");
    prog.mux = 1; report(true);
    stats.totalSecs = (performance.now() - stats.started) / 1000;
    return { ...res, stats };
  })();
  promise.catch(() => {}).finally(() => { for (const w of [...live]) kill(w); });
  return { promise, cancel };
}
const fmtMB = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
