// QuickCut Video: "Fit to size", the maths (no DOM, no WebCodecs; used by the page and the job).
// Why these numbers: see SIZE_TARGET.md next to this file.

/** Size presets (bytes; 1 MB = 1,000,000 bytes, so a file fits limits counted either way). */
export const FIT_PRESETS = [10e6, 25e6, 50e6, 100e6, 500e6, 1e9];
/** Share of the target the plan spends; the rest is slack for the encoders' rate control. */
export const MARGIN = 0.975;
/** Bits each codec needs for the same quality as H.264 (hardware encoders, conservative). */
export const EFF = { h264: 1, vp9: 0.8, hevc: 0.72, av1: 0.62 };
/** Auto codec order: best compression first. */
export const AUTO_ORDER = ["av1", "hevc", "vp9", "h264"];

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/**
 * The video bit rate expressed as "H.264 at 1080p30" (b/s): the quality yardstick. Bits scale with
 * pixels^0.75 and frame rate^0.585 (60 fps needs ~1.5x the bits of 30 fps).
 */
export function equiv(vbps, v, w, h, fps) {
  return (vbps / (EFF[v] || 1)) * Math.pow(2073600 / (w * h), 0.75) * Math.pow(30 / Math.max(1, fps), 0.585);
}
/** Inverse of equiv: the bit rate that gives `E` for this codec, size and frame rate. */
export function bpsFor(E, v, w, h, fps) {
  return E * (EFF[v] || 1) * Math.pow((w * h) / 2073600, 0.75) * Math.pow(Math.max(1, fps) / 30, 0.585);
}
export const E_EXCELLENT = 6e6, E_GOOD = 3e6, E_FAIR = 1.5e6;
/** Pick the largest size/frame rate that still reaches this. */
export const E_LADDER = 3e6;
/** Below this, even at the smallest size, the target is not worth it ("impossible"). */
export const E_FLOOR = 0.9e6;
/** Above this, more bits don't show: the file comes out smaller than the target. */
export const E_CAP = 16e6;
export function tier(E) { return E >= E_EXCELLENT ? "Excellent" : E >= E_GOOD ? "Good" : E >= E_FAIR ? "Fair" : "Low"; }

/**
 * Bits per pixel per frame below which an encoder stops following the requested rate (it hits its
 * finest quantizer): a 5120x1440 AV1 export asked for 0.005 came out at 0.0065 whatever the request,
 * 5 MB over the size target (a 2560x720 60 fps one, at 0.010, too). Scaled by the codec's efficiency (AV1 0.0075),
 * x1.6 above 40 fps.
 */
export const BPP_AV1 = 0.0075;
export const bppMin = (v) => (BPP_AV1 * (EFF[v] || 1)) / EFF.av1;

/** Output sizes and frame rates to choose from, best first (score: pixels, then frame rate). */
export function ladder(cw, ch, srcFps) {
  const short = Math.min(cw, ch);
  const sizes = [{ w: cw, h: ch }];
  // scaled sizes on a multiple of 8 (hardware encoders work in 8/16-pixel blocks)
  const m8 = (v) => Math.max(8, Math.round(v / 8) * 8);
  for (const s of [2160, 1440, 1080, 720, 540, 480, 360, 240]) if (s < short - 8) { const f = s / short; sizes.push({ w: m8(cw * f), h: m8(ch * f) }); }
  const rates = [srcFps || 30];
  if (srcFps > 40) rates.push(srcFps / 2);
  const out = [];
  for (const z of sizes) for (const fps of rates) out.push({ ...z, fps, half: fps !== rates[0], score: Math.log2(z.w * z.h) + 0.5 * Math.log2(fps) });
  return out.sort((a, b) => b.score - a.score);
}

/** Container overhead estimate (bytes): headers + per-frame and per-packet index entries. */
export function overhead(container, frames, packets) {
  return container === "webm" || container === "mkv" ? 4096 + 14 * frames + 12 * packets : 4096 + 16 * frames + 10 * packets;
}

const ASTEPS = [24e3, 32e3, 48e3, 64e3, 96e3, 128e3, 160e3, 192e3];
/** Audio bit rate worth spending out of `totalBps`: ~8 %, 24–160 kb/s, on a step. */
export function audioWant(totalBps) {
  const a = clamp(totalBps * 0.08, 24e3, 160e3);
  return ASTEPS.filter((x) => x <= a + 1).pop();
}
/**
 * How to make the audio: copy it, or encode it at a chosen bit rate.
 *  src: {codec, bps, channels, rate} of the source track; plain: no speed/volume changes;
 *  aacRates: AAC bit rates this browser encodes; opusOk: Opus encodes.
 * Returns {copy: true, bps} or {codec, bitrate, channels, bps} (bps: what it costs).
 */
export function audioChoice(want, src, container, plain, aacRates, opusOk) {
  const fits = (src.codec === "aac" && container !== "webm") || (src.codec === "opus" && container !== "mov");
  if (plain && fits && src.bps > 0 && src.bps <= Math.max(want * 1.3, want + 32e3)) return { copy: true, bps: src.bps };
  const ch = Math.min(2, src.channels || 2);
  if (container === "webm" || (!aacRates.length && opusOk && container !== "mov")) return opusPick(want, ch);
  const aac = aacRates.filter((r) => r <= want + 1).pop();
  if (aac) return { codec: "aac", bitrate: aac, channels: ch, bps: aac };
  // below the AAC encoder's lowest rate (Windows: 96 kb/s): Opus where the container holds it
  if (opusOk && container !== "mov") return opusPick(want, ch);
  const lo = aacRates[0] || 128e3;
  return { codec: "aac", bitrate: lo, channels: ch, bps: lo };
}
function opusPick(want, ch) {
  const channels = want <= 32e3 ? 1 : ch;
  // 60 ms packets at low rates: a third of the packets, so less container overhead per second
  return { codec: "opus", bitrate: want, channels, bps: want, frameMs: want <= 48e3 ? 60 : 20 };
}

/**
 * The plan. `o`: {target (bytes), dur (s), cw, ch (crop size), fps (source), frames (output
 * frames at the source rate), container (null = auto), codecs (list to try, best first),
 * codecAt(v, w, h, fps) → {hw} | null | undefined (undefined: still checking), audio(totalBps,
 * container) → audioChoice result | null (no audio)}.
 * Returns {ok, w, h, fps, half, v, container, hw, vbps, audio, E, tier, bytes, capped} or
 * {ok: false, pending} / {ok: false, minBytes}.
 */
export function planFit(o) {
  const cands = ladder(o.cw, o.ch, o.fps);
  let pending = false, last = null;
  // A source that looks fine at a low bit rate (static screen, slides, a still camera) needs fewer
  // bits than the defaults assume: its own H.264-equivalent rate (srcE) scales the thresholds
  // down (never up), and spending more than ~2x what the source has buys nothing.
  // `content` (measured, see video.js contentProbe): bits the encoder actually used of a rate
  // meant for "excellent"; below ~0.8 the content is easier than usual by about that factor.
  const kc = o.content > 0 ? Math.min(1, Math.max(0.1, o.content / 0.8)) : 1;
  const k = Math.max(0.1, Math.min(kc, o.srcE > 0 ? Math.min(1, Math.max(0.15, (o.srcE * 1.2) / E_LADDER)) : 1));
  const thr = (o.eLadder || E_LADDER) * k, floor = E_FLOOR * k;
  // easy content saturates: the probe offered E = 6 Mb/s and the encoder used `content` of it
  const eCap = Math.min(o.srcE > 0 ? Math.min(E_CAP, Math.max(2e6, o.srcE * 2)) : E_CAP, o.content > 0 && o.content < 0.8 ? Math.max(1e6, 6e6 * o.content) : E_CAP);
  const evalAt = (c) => {
    // hardware first (best compression first), then software; wait until every codec is checked
    const got = o.codecs.map((v) => [v, o.codecAt(v, c.w, c.h, c.fps)]);
    if (got.some(([, r]) => r === undefined)) { pending = true; return "pending"; }
    const hit = got.find(([, r]) => r && r.hw) || got.find(([, r]) => r);
    if (!hit) return null;
    const pick = { v: hit[0], hw: hit[1].hw };
    const container = o.container || (pick.v === "vp9" ? "webm" : "mp4");
    const frames = o.frames * (c.fps / o.fps);
    const total = (8 * o.target * MARGIN) / o.dur;
    const audio = o.audio(total, container);
    const abps = audio ? audio.bps : 0;
    const packets = audio ? (o.dur * 1000) / (audio.frameMs || (audio.codec === "opus" ? 20 : 21.33)) : 0;
    const over = overhead(container, frames, packets);
    let vbps = ((o.target * MARGIN - over) * 8) / o.dur - abps;
    const cap = bpsFor(eCap, pick.v, c.w, c.h, c.fps);
    const capped = vbps > cap;
    if (capped) vbps = cap;
    vbps = Math.min(vbps, 400e6);
    const E = equiv(vbps, pick.v, c.w, c.h, c.fps);
    const bytes = ((vbps + abps) * o.dur) / 8 + over;
    const bpp = vbps / (c.w * c.h * c.fps);
    return { ok: true, bpp, w: c.w, h: c.h, fps: c.fps, half: c.half, v: pick.v, hw: pick.hw, container, vbps: Math.round(vbps), audio, over, E, tier: tier(E / k), bytes, capped, cap };
  };
  // o.stepDown: rungs further down than the plan would pick (the first pass showed the encoder can't reach the size there)
  let first = -1;
  for (let i = 0; i < cands.length; i++) {
    const p = evalAt(cands[i]);
    if (p === "pending") return { ok: false, pending: true };
    if (!p) continue;
    last = p;
    if ((p.E >= thr || p.capped) && p.bpp >= bppMin(p.v) * (p.fps > 40 ? 1.6 : 1) * (o.bppScale ?? 1)) { first = i; break; } // (bppScale: tests)
  }
  if (first >= 0 && o.stepDown > 0) {
    for (let i = Math.min(cands.length - 1, first + o.stepDown); i > first; i--) {
      const p = evalAt(cands[i]);
      if (p === "pending") return { ok: false, pending: true };
      if (p && p.bpp >= 0) return { ...p, step: i - first };
    }
    return { ok: false, floor: true }; // already at the smallest size
  }
  if (first >= 0) return last;
  if (pending && !last) return { ok: false, pending: true };
  if (!last) return { ok: false, none: true };
  if (last.E >= floor && last.vbps > 30e3) return last;
  // impossible: the smallest size where the lowest rung reaches the floor
  const c = cands[cands.length - 1];
  const vmin = Math.max(30e3, bpsFor(floor, last.v, c.w, c.h, c.fps));
  const amin = last.audio ? Math.min(last.audio.bps, o.audioMin ?? last.audio.bps) : 0;
  const minBytes = (((vmin + amin) * o.dur) / 8 + last.over) / MARGIN;
  return { ok: false, minBytes: niceUp(minBytes), pending };
}
/** Round up to 2 significant digits (in MB/GB terms). */
export function niceUp(b) {
  const mb = b / 1e6;
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(mb, 0.01))) - 1);
  return Math.ceil(mb / p) * p * 1e6;
}

/**
 * Per-part complexity weights from the source's own bytes per second in each part (a free
 * "first pass": the source encoder already spent bits where the picture is hard). Bits follow
 * complexity^0.6 (x264's qcomp), clamped to 0.4–2.5x, normalised so sum(w·d) = sum(d).
 */
export function weights(density, durs) {
  const n = durs.length;
  if (!density || density.length !== n || density.some((x) => !(x > 0))) return new Array(n).fill(1);
  const raw = density.map((x) => Math.pow(x, 0.6));
  const mean = raw.reduce((a, x, i) => a + x * durs[i], 0) / Math.max(1e-9, durs.reduce((a, b) => a + b, 0));
  const w = raw.map((x) => clamp(x / mean, 0.4, 2.5));
  const k = durs.reduce((a, b) => a + b, 0) / Math.max(1e-9, w.reduce((a, x, i) => a + x * durs[i], 0));
  return w.map((x) => x * k);
}

/**
 * The bit rate to ask for part `i`, so the whole lands on the budget. Parts done count with
 * their real bytes, parts being encoded with what they asked for times the encoder's measured
 * overshoot (rho), the rest share what is left by weight.
 *  F: {budget (video bytes), w[], d[] (s), req{}, fixed{}, cap, min}; done: {i: {bytes}};
 *  running: [i...].
 */
export function partRate(F, i, done, running) {
  if (F.fixed && F.fixed[i]) return F.fixed[i];
  let spent = 0, asked = 0, totalD = 0;
  for (let k = 0; k < F.d.length; k++) totalD += F.d[k];
  for (const k of Object.keys(done)) { spent += done[k].bytes; asked += ((F.req[k] || 0) * F.d[k]) / 8; }
  const nominalAll = (F.budget * 8) / Math.max(1e-6, totalD);
  const prior = (2 * F.budget) / Math.max(1, F.d.length);
  const rho = clamp((spent + prior) / (asked + prior), 0.6, 1.6);
  let inflight = 0;
  for (const k of running) if (k !== i && !done[k]) inflight += (((F.req[k] || nominalAll * F.w[k]) * F.d[k]) / 8) * rho;
  let restW = 0;
  const busy = new Set(running);
  for (let k = 0; k < F.d.length; k++) if (!done[k] && (!busy.has(k) || k === i)) restW += F.w[k] * F.d[k];
  const left = F.budget - spent - inflight;
  const nominal = nominalAll * F.w[i];
  let bps = left > 0 && restW > 0 ? ((left * F.w[i]) / restW) * 8 / rho : nominal * 0.3;
  bps = clamp(bps, nominal * 0.3, nominal * 2.5);
  bps = clamp(bps, F.min || 30e3, F.cap || 400e6);
  return Math.round(bps);
}

/**
 * The file came out over the target by `excess` bytes: which finished parts to encode again and
 * at what rate. Biggest parts first; each loses at most 45 % (more each round).
 */
export function redoParts(F, done, excess, round) {
  const list = Object.keys(done).map((k) => [+k, done[k].bytes]).sort((a, b) => b[1] - a[1]);
  const maxCut = Math.min(0.6, 0.3 + 0.1 * round);
  const want = excess * (1.15 + 0.1 * round);
  const picked = [];
  let sum = 0;
  for (const [k, b] of list) { picked.push(k); sum += b; if (sum * maxCut >= want) break; }
  const cut = Math.min(maxCut, want / Math.max(1, sum));
  const out = {};
  // the encoder lands each part near (what it asked) x (its own overshoot): asking (1 - cut)
  // times as much takes ~cut off that part
  const nominal = (F.budget * 8) / Math.max(1e-6, F.d.reduce((a, b) => a + b, 0));
  for (const k of picked) out[k] = Math.max(F.min || 30e3, Math.round((F.req[k] || nominal * F.w[k]) * (1 - cut)));
  return out;
}
