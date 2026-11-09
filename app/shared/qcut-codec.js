// .qcut tile codecs (see web/QCUT_FORMAT.md). Used by qcut-worker.js and, when no worker can
// start, by qcut.js on the main thread. Every decoder is bounds-checked and verifies the tile's
// pixel CRC, so a corrupt or hostile file fails with an error, never with wrong pixels.
//
// PRED+ANS runs in WebAssembly (qcut-codec.wasm, built from web/qcut-wasm, safe Rust) and, where
// WebAssembly is off, in the JavaScript below: the same bitstream, byte for byte.

export const C_SOLID = 0, C_QOI = 1, C_ANS = 2, C_RAW = 3, C_REF = 4;

export class QcutError extends Error {
  constructor(code, msg) { super(msg || code); this.name = "QcutError"; this.code = code; }
}
const bad = (msg) => new QcutError("corrupt", msg);

// ── CRC-32 (IEEE, as zlib/PNG), slicing-by-4 ─────────────────────────────────
const T0 = new Int32Array(256), T1 = new Int32Array(256), T2 = new Int32Array(256), T3 = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T0[n] = c; }
for (let n = 0; n < 256; n++) { T1[n] = (T0[n] >>> 8) ^ T0[T0[n] & 255]; T2[n] = (T1[n] >>> 8) ^ T0[T1[n] & 255]; T3[n] = (T2[n] >>> 8) ^ T0[T2[n] & 255]; }
export function crc32(u8, crc = 0) {
  let c = ~crc, i = 0;
  const n = u8.length, n4 = n - (n & 3);
  for (; i < n4; i += 4) {
    c ^= u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24);
    c = T3[c & 255] ^ T2[(c >>> 8) & 255] ^ T1[(c >>> 16) & 255] ^ T0[c >>> 24];
  }
  for (; i < n; i++) c = T0[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}
/** A second, independent 32-bit hash (multiply-rotate over words). With the CRC it gives a 64-bit
 *  identity for a tile: used only to skip re-encoding and to share identical tiles when writing. */
export function hash2(u8) {
  let h = 0x2545f491 ^ u8.length;
  const n4 = u8.length >> 2, u32 = (u8.byteOffset & 3) === 0 ? new Uint32Array(u8.buffer, u8.byteOffset, n4) : null;
  for (let i = 0; i < n4; i++) {
    const v = u32 ? u32[i] : u8[i * 4] | (u8[i * 4 + 1] << 8) | (u8[i * 4 + 2] << 16) | (u8[i * 4 + 3] << 24);
    h = Math.imul(h ^ v, 0x9e3779b1); h = (h << 15) | (h >>> 17);
  }
  for (let i = n4 * 4; i < u8.length; i++) { h = Math.imul(h ^ u8[i], 0x9e3779b1); h = (h << 15) | (h >>> 17); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  return h >>> 0;
}

// ── deflate-raw through the browser's own zlib (CompressionStream) ───────────
export async function deflate(u8) {
  const cs = new CompressionStream("deflate-raw"), w = cs.writable.getWriter();
  w.write(u8).catch(() => {}); w.close().catch(() => {});
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
/** Inflate to exactly `expect` bytes (or at most, when `exact` is false); more, less or junk → error (no zip bombs). */
export async function inflate(u8, expect, exact = true) {
  const ds = new DecompressionStream("deflate-raw"), w = ds.writable.getWriter(), r = ds.readable.getReader();
  w.write(u8).catch(() => {}); w.close().catch(() => {});
  const out = new Uint8Array(expect);
  let o = 0;
  try {
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      if (o + value.length > expect) { r.cancel().catch(() => {}); throw bad("tile data is too long"); }
      out.set(value, o); o += value.length;
    }
  } catch (e) { throw e instanceof QcutError ? e : bad("compressed data is damaged"); }
  if (exact && o !== expect) throw bad("tile data is too short");
  return exact ? out : out.subarray(0, o);
}

// ── one colour? ──────────────────────────────────────────────────────────────
/** The tile's single value (RGBA as little-endian u32, or the gray byte), or -1. */
export function solidOf(px, ch) {
  if (ch === 1) { const v = px[0]; for (let i = 1; i < px.length; i++) if (px[i] !== v) return -1; return v; }
  const u = new Uint32Array(px.buffer, px.byteOffset, px.length >> 2), v = u[0];
  for (let i = 1; i < u.length; i++) if (u[i] !== v) return -1;
  return v >>> 0;
}
function fillSolid(n, ch, v) {
  const px = new Uint8Array(n * ch);
  if (ch === 1) px.fill(v & 255); else new Uint32Array(px.buffer).fill(v);
  return px;
}

// ── QOI (from the public QOI spec) for flat / graphic tiles ────────────────────
let qoiBusy = 0; // pixels the last qoiEncode wrote as a colour change with the same alpha (photo-like)
export function qoiEncode(px, n) {
  const out = new Uint8Array(n * 5), idx = new Uint32Array(64);
  let o = 0, pr = 0, pg = 0, pb = 0, pa = 255, run = 0, busy = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = px[j], g = px[j + 1], b = px[j + 2], a = px[j + 3];
    if (r === pr && g === pg && b === pb && a === pa) {
      if (++run === 62) { out[o++] = 0xc0 | 61; run = 0; }
      continue;
    }
    if (run) { out[o++] = 0xc0 | (run - 1); run = 0; }
    const v = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0, h = (r * 3 + g * 5 + b * 7 + a * 11) & 63;
    if (idx[h] === v) out[o++] = h;
    else {
      idx[h] = v;
      if (a === pa) {
        const vr = ((r - pr + 128) & 255) - 128, vg = ((g - pg + 128) & 255) - 128, vb = ((b - pb + 128) & 255) - 128;
        const vgr = vr - vg, vgb = vb - vg;
        if (vr > -3 && vr < 2 && vg > -3 && vg < 2 && vb > -3 && vb < 2) out[o++] = 0x40 | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2);
        else if (vgr > -9 && vgr < 8 && vg > -33 && vg < 32 && vgb > -9 && vgb < 8) { out[o++] = 0x80 | (vg + 32); out[o++] = ((vgr + 8) << 4) | (vgb + 8); busy++; }
        else { out[o++] = 0xfe; out[o++] = r; out[o++] = g; out[o++] = b; busy++; }
      } else { out[o++] = 0xff; out[o++] = r; out[o++] = g; out[o++] = b; out[o++] = a; }
    }
    pr = r; pg = g; pb = b; pa = a;
  }
  if (run) out[o++] = 0xc0 | (run - 1);
  qoiBusy = busy;
  return out.subarray(0, o);
}
export function qoiDecode(src, n) {
  const px = new Uint8Array(n * 4), idx = new Uint8Array(256), L = src.length;
  let p = 0, r = 0, g = 0, b = 0, a = 255, run = 0;
  for (let j = 0, e = n * 4; j < e; j += 4) {
    if (run) run--;
    else {
      if (p >= L) throw bad("tile data ends early");
      const b1 = src[p++];
      if (b1 === 0xfe) { if (p + 3 > L) throw bad("tile data ends early"); r = src[p++]; g = src[p++]; b = src[p++]; }
      else if (b1 === 0xff) { if (p + 4 > L) throw bad("tile data ends early"); r = src[p++]; g = src[p++]; b = src[p++]; a = src[p++]; }
      else if (b1 < 0x40) { const k = b1 * 4; r = idx[k]; g = idx[k + 1]; b = idx[k + 2]; a = idx[k + 3]; }
      else if (b1 < 0x80) { r = (r + ((b1 >> 4) & 3) - 2) & 255; g = (g + ((b1 >> 2) & 3) - 2) & 255; b = (b + (b1 & 3) - 2) & 255; }
      else if (b1 < 0xc0) { if (p >= L) throw bad("tile data ends early"); const b2 = src[p++], vg = (b1 & 63) - 32; r = (r + vg - 8 + (b2 >> 4)) & 255; g = (g + vg) & 255; b = (b + vg - 8 + (b2 & 15)) & 255; }
      else run = b1 & 63;
      const k = ((r * 3 + g * 5 + b * 7 + a * 11) & 63) * 4;
      idx[k] = r; idx[k + 1] = g; idx[k + 2] = b; idx[k + 3] = a;
    }
    px[j] = r; px[j + 1] = g; px[j + 2] = b; px[j + 3] = a;
  }
  if (run || p !== L) throw bad("tile data has the wrong length");
  return px;
}

// ── PRED+ANS: prediction, context modelling and rANS (photo-like tiles, masks) ──
// Planes: G, R−G, B−G (signed), A (left out when every alpha is 255), or the one plane of a
// 1-channel layer. Each sample is predicted with MED (LOCO-I; = median(W, N, W+N−NW)), the
// residual is taken mod 256 and zigzagged to u (0…255). Its context is a bucket (12) of the local
// gradient |W−NW|+|N−NW|+|NE−N|. u is coded as a token (u < 16: u; above: 16 + 2·(⌊log2 u⌋−4) +
// the next bit; 24 tokens) plus raw low bits. Per plane: frequency tables (12-bit), a raw bit
// stream for the low bits, and a 32-bit rANS stream with 16-bit renormalisation.
// Layout: u8 flags (1 = alpha plane, 2 = G/R−G/B−G), u8 0 (reserved), then per plane:
// 12 × [u8 tokens used, then each frequency as 1 or 2 bytes (7 bits + 8 bits)], u32 extra-bit
// length X, u32 rANS length A, X bytes of low bits (LSB first), A bytes of rANS (final state first).
const ANS_BITS = 12, ANS_M = 1 << ANS_BITS, ANS_L = 1 << 16, NTOK = 24, KCTX = 12;
const GQ = new Uint8Array(2048);
{ const b = [1, 2, 3, 5, 7, 10, 15, 22, 32, 48, 80]; let k = 0; for (let i = 0; i < 2048; i++) { while (k < b.length && i >= b[k]) k++; GQ[i] = k; } }
const A_ALPHA = 1, A_SG = 2;
const TOK8 = new Uint8Array(256), NBX8 = new Uint8Array(256), TBASE = new Int32Array(32), TNB = new Int32Array(32);
for (let u = 0; u < 256; u++) { if (u < 16) TOK8[u] = u; else { const n = 31 - Math.clz32(u); TOK8[u] = 16 + ((n - 4) << 1) + ((u >> (n - 1)) & 1); NBX8[u] = n - 1; } }
for (let t = 0; t < NTOK; t++) { if (t < 16) { TBASE[t] = t; continue; } const n = 4 + ((t - 16) >> 1); TBASE[t] = (2 | ((t - 16) & 1)) << (n - 1); TNB[t] = n - 1; }

function planesOf(px, n, ch) {
  if (ch === 1) return { flags: 0, planes: [Int16Array.from(px.subarray(0, n))] };
  let alpha = false;
  for (let j = 3; j < n * 4; j += 4) if (px[j] !== 255) { alpha = true; break; }
  const G = new Int16Array(n), R = new Int16Array(n), B = new Int16Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { const g = px[j + 1]; G[i] = g; R[i] = px[j] - g; B[i] = px[j + 2] - g; }
  const planes = [G, R, B];
  if (alpha) { const A = new Int16Array(n); for (let i = 0, j = 3; i < n; i++, j += 4) A[i] = px[j]; planes.push(A); }
  return { flags: A_SG | (alpha ? A_ALPHA : 0), planes };
}
/** Counts → frequencies summing to ANS_M (every seen token keeps ≥ 1). → tokens used */
function normFreqs(hist, base, F) {
  let tot = 0, used = 0;
  for (let t = 0; t < NTOK; t++) { const c = hist[base + t]; tot += c; if (c) used = t + 1; }
  if (!tot) return 0;
  let sum = 0, big = 0;
  for (let t = 0; t < used; t++) {
    const c = hist[base + t], f = c ? Math.max(1, Math.round((c * ANS_M) / tot)) : 0;
    F[base + t] = f; sum += f; if (f > F[base + big]) big = t;
  }
  let d = ANS_M - sum;
  if (d > 0 || F[base + big] + d >= 1) F[base + big] += d;
  else while (d < 0) for (let t = 0; t < used && d < 0; t++) if (F[base + t] > 1) { F[base + t]--; d++; }
  return used;
}
/** PRED+ANS encoder in JavaScript (the fallback; qcut-codec.wasm gives the same bytes). */
export function ansEncodeJS(px, w, h, ch) {
  const n = w * h, { flags, planes } = planesOf(px, n, ch);
  const parts = [Uint8Array.of(flags, 0)];
  const sym = new Uint16Array(n), ans = new Uint8Array(n * 2 + 16), xb = new Uint8Array(n + 16);
  for (const pl of planes) {
    const hist = new Uint32Array(KCTX << 5);
    let xo = 0, acc = 0, nacc = 0;
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        let p, g = 0;
        if (y === 0) p = x ? pl[i - 1] : 0;
        else if (x === 0) p = pl[i - w];
        else {
          const a = pl[i - 1], b = pl[i - w], c = pl[i - w - 1], d = x + 1 < w ? pl[i - w + 1] : b;
          const mn = a < b ? a : b, mx = a < b ? b : a, q = a + b - c;
          p = q < mn ? mn : q > mx ? mx : q;
          const g1 = a - c, g2 = b - c, g3 = d - b;
          g = (g1 < 0 ? -g1 : g1) + (g2 < 0 ? -g2 : g2) + (g3 < 0 ? -g3 : g3);
          if (g > 2047) g = 2047;
        }
        const e = ((pl[i] - p) << 24) >> 24, u = e >= 0 ? e << 1 : -(e << 1) - 1, t = TOK8[u];
        if (t >= 16) { const nb = NBX8[u]; acc |= (u & ((1 << nb) - 1)) << nacc; nacc += nb; while (nacc >= 8) { xb[xo++] = acc & 255; acc >>>= 8; nacc -= 8; } }
        const s = (GQ[g] << 5) | t;
        sym[i] = s; hist[s]++;
      }
    }
    if (nacc) xb[xo++] = acc & 255;
    const F = new Uint32Array(KCTX << 5), C = new Uint32Array(KCTX << 5), tab = new Uint8Array(KCTX * (1 + NTOK * 2) + 8);
    let to = 0;
    for (let k = 0; k < KCTX; k++) {
      const used = normFreqs(hist, k << 5, F);
      tab[to++] = used;
      for (let t = 0, cum = 0; t < used; t++) {
        const f = F[(k << 5) + t]; C[(k << 5) + t] = cum; cum += f;
        if (f < 128) tab[to++] = f; else { tab[to++] = 128 | (f & 127); tab[to++] = f >> 7; }
      }
    }
    // rANS, backwards; state in [2^16, 2^32), at most one 16-bit word out per symbol
    let o = ans.length, x = ANS_L;
    for (let i = n - 1; i >= 0; i--) {
      const s = sym[i], f = F[s];
      if (x >= 1048576 * f) { ans[--o] = x >>> 8 & 255; ans[--o] = x & 255; x = x >>> 16; }
      const q = Math.floor(x / f);
      x = q * ANS_M + (x - q * f) + C[s];
    }
    ans[--o] = x >>> 24; ans[--o] = (x >>> 16) & 255; ans[--o] = (x >>> 8) & 255; ans[--o] = x & 255;
    const al = ans.length - o, lens = new Uint8Array(8), dv = new DataView(lens.buffer);
    dv.setUint32(0, xo, true); dv.setUint32(4, al, true);
    tab.set(lens, to); to += 8;
    parts.push(tab.slice(0, to), xb.slice(0, xo), ans.slice(o));
  }
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** PRED+ANS decoder in JavaScript (the fallback; same checks as the wasm decoder). → Uint8Array */
export function ansDecodeJS(src, w, h, ch) {
  const n = w * h, L = src.length;
  if (L < 2 || !n) throw bad("tile data ends early");
  const flags = src[0];
  if (src[1] !== 0 || (flags & ~(A_ALPHA | A_SG)) || (ch === 1 ? flags !== 0 : !(flags & A_SG))) throw bad("tile header is invalid");
  const P = ch === 1 ? 1 : flags & A_ALPHA ? 4 : 3;
  const secs = [];
  let p = 2;
  for (let q = 0; q < P; q++) {
    const F = new Int32Array(KCTX << 5), C = new Int32Array(KCTX << 5), DT = new Uint8Array(KCTX << ANS_BITS).fill(31);
    for (let k = 0; k < KCTX; k++) {
      if (p >= L) throw bad("tile data ends early");
      const used = src[p++];
      if (used > NTOK) throw bad("tile table is invalid");
      let cum = 0;
      for (let t = 0; t < used; t++) {
        if (p >= L) throw bad("tile data ends early");
        let f = src[p++];
        if (f & 128) { if (p >= L) throw bad("tile data ends early"); f = (f & 127) | (src[p++] << 7); }
        if (f > ANS_M - cum) throw bad("tile table is invalid");
        F[(k << 5) + t] = f; C[(k << 5) + t] = cum;
        DT.fill(t, (k << ANS_BITS) + cum, (k << ANS_BITS) + cum + f);
        cum += f;
      }
      if (used && cum !== ANS_M) throw bad("tile table is invalid");
    }
    if (p + 8 > L) throw bad("tile data ends early");
    const xl = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0, al = (src[p + 4] | (src[p + 5] << 8) | (src[p + 6] << 16) | (src[p + 7] << 24)) >>> 0;
    p += 8;
    if (xl > L || al > L || p + xl + al > L || al < 4 || (al & 1)) throw bad("tile data ends early");
    const bend = p + xl, x0 = (src[bend] | (src[bend + 1] << 8) | (src[bend + 2] << 16) | (src[bend + 3] << 24)) >>> 0;
    if (x0 < ANS_L) throw bad("tile data is damaged");
    secs.push({ F, C, DT, bp: p, bend, x: x0, ip: bend + 4, iend: bend + al });
    p = bend + al;
  }
  if (p !== L) throw bad("tile data has the wrong length");
  const planes = [];
  for (let q = 0; q < P; q++) {
    const { F, C, DT, bend, iend } = secs[q], pl = new Int16Array(n), signed = ch === 4 && (q === 1 || q === 2), G = planes[0];
    let x = secs[q].x, ip = secs[q].ip, bp = secs[q].bp, acc = 0, nacc = 0;
    for (let y = 0, i = 0; y < h; y++) {
      for (let xx = 0; xx < w; xx++, i++) {
        let pr, g = 0;
        if (y === 0) pr = xx ? pl[i - 1] : 0;
        else if (xx === 0) pr = pl[i - w];
        else {
          const a = pl[i - 1], b = pl[i - w], c = pl[i - w - 1], d = xx + 1 < w ? pl[i - w + 1] : b;
          const mn = a < b ? a : b, mx = a < b ? b : a, qq = a + b - c;
          pr = qq < mn ? mn : qq > mx ? mx : qq;
          const g1 = a - c, g2 = b - c, g3 = d - b;
          g = (g1 < 0 ? -g1 : g1) + (g2 < 0 ? -g2 : g2) + (g3 < 0 ? -g3 : g3);
          if (g > 2047) g = 2047;
        }
        const k = GQ[g], slot = x & (ANS_M - 1), t = DT[(k << ANS_BITS) | slot], s = (k << 5) | t, f = F[s];
        if (!f) throw bad("tile data is damaged");
        x = f * Math.floor(x / ANS_M) + slot - C[s];
        if (x < ANS_L) { if (ip + 2 > iend) throw bad("tile data ends early"); x = x * 65536 + (src[ip] | (src[ip + 1] << 8)); ip += 2; }
        let u = TBASE[t];
        const nb = TNB[t];
        if (nb) {
          while (nacc < nb) { if (bp >= bend) throw bad("tile data ends early"); acc |= src[bp++] << nacc; nacc += 8; }
          u |= acc & ((1 << nb) - 1); acc >>>= nb; nacc -= nb;
        }
        const e = (u >> 1) ^ -(u & 1);
        let v = (pr + e) & 255;
        if (signed) { const gg = G[i]; v = ((gg + v) & 255) - gg; }
        pl[i] = v;
      }
    }
    if (x !== ANS_L || ip !== iend || bp !== bend || nacc >= 8) throw bad("tile data has the wrong length");
    planes.push(pl);
  }
  if (ch === 1) { const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = planes[0][i]; return out; }
  const out = new Uint8Array(n * 4), [G, R, B, A] = planes;
  for (let i = 0, j = 0; i < n; i++, j += 4) { const g = G[i]; out[j] = R[i] + g; out[j + 1] = g; out[j + 2] = B[i] + g; out[j + 3] = A ? A[i] : 255; }
  return out;
}

// ── the same codec in WebAssembly (loaded on first use; JS fallback if it can't load) ──
let wasmP = null, wasmX = null;
/** Load qcut-codec.wasm once per thread → exports or null. `force: false` disables it (tests). */
export function wasmCodec(force) {
  if (force === false) { wasmP = Promise.resolve(null); wasmX = null; return wasmP; }
  if (force === true) wasmP = null;
  return (wasmP ||= (async () => {
    try {
      if (typeof WebAssembly !== "object") return null;
      const url = new URL("./qcut-codec.wasm", import.meta.url);
      let inst;
      try { inst = (await WebAssembly.instantiateStreaming(fetch(url), {})).instance; }
      catch { inst = (await WebAssembly.instantiate(await (await fetch(url)).arrayBuffer(), {})).instance; }
      const X = inst.exports;
      if (typeof X.qc_encode !== "function" || typeof X.qc_decode !== "function") return null;
      return (wasmX = X);
    } catch { return null; }
  })());
}
function wasmEncode(X, px, w, h, ch) {
  const n = w * h * ch, ip = X.qc_alloc(n);
  new Uint8Array(X.memory.buffer, ip, n).set(px.subarray(0, n));
  const r = X.qc_encode(ip, w, h, ch);
  X.qc_free(ip, n);
  const m = new Uint8Array(X.memory.buffer), len = (m[r] | (m[r + 1] << 8) | (m[r + 2] << 16) | (m[r + 3] << 24)) >>> 0;
  const out = m.slice(r + 4, r + 4 + len);
  X.qc_free(r, len + 4);
  return out;
}
function wasmDecode(X, src, w, h, ch) {
  const n = w * h * ch, sp = X.qc_alloc(src.length), dp = X.qc_alloc(n);
  new Uint8Array(X.memory.buffer, sp, src.length).set(src);
  const st = X.qc_decode(sp, src.length, w, h, ch, dp);
  const out = st === 0 ? new Uint8Array(X.memory.buffer).slice(dp, dp + n) : null;
  X.qc_free(sp, src.length); X.qc_free(dp, n);
  if (!out) throw bad("tile data is damaged");
  return out;
}
/** A trap (a bug, never expected) leaves the instance unusable: drop it and fall back to JS. */
function trapped(e) { if (e instanceof WebAssembly.RuntimeError) { wasmX = null; wasmP = Promise.resolve(null); return true; } return false; }
export async function ansEncode(px, w, h, ch) {
  const X = wasmX || (await wasmCodec());
  if (X) try { return wasmEncode(X, px, w, h, ch); } catch (e) { if (!trapped(e)) throw e; }
  return ansEncodeJS(px, w, h, ch);
}
export async function ansDecode(src, w, h, ch) {
  const X = wasmX || (await wasmCodec());
  if (X) try { return wasmDecode(X, src, w, h, ch); } catch (e) { if (trapped(e)) throw bad("tile data is damaged"); throw e; }
  return ansDecodeJS(src, w, h, ch);
}

// ── one tile ─────────────────────────────────────────────────────────────────
/**
 * Encode one tile. `px`: w×h×ch bytes (RGBA as from getImageData, or 1 channel).
 * `mode`: "best" (default: PRED+ANS, or QOI+deflate where that is smaller), "quick" (one codec,
 * picked by a cheap guess; for autosave), "fast" (no compression; for when the page is closing).
 * → { codec, value, bytes|null, crc, h2 }
 */
export async function encodeTile(px, w, h, ch, { mode = "best" } = {}) {
  const crc = crc32(px), h2 = hash2(px), n = w * h;
  const s = solidOf(px, ch);
  if (s >= 0) return { codec: C_SOLID, value: s, bytes: null, crc, h2 };
  let codec = C_ANS, bytes = null;
  if (mode !== "fast") {
    const q = ch === 4 ? qoiEncode(px, n) : null;
    // flat / graphic tiles: QOI's runs and colour index win; photo-like ones: PRED+ANS. In between,
    // the share of pixels QOI wrote as colour changes (not runs, index hits or alpha edges) decides:
    // few → QOI; more → "best" tries both, "quick" takes PRED+ANS.
    if (q && (q.length < QOI_ONLY * px.length || (q.length < QOI_TRY * px.length && qoiBusy < (mode === "quick" ? QUICK_BUSY : BEST_BUSY) * n))) { codec = C_QOI; bytes = await deflate(q); }
    else if (q && q.length < QOI_TRY * px.length && mode !== "quick") {
      const [z, a] = await Promise.all([deflate(q), ansEncode(px, w, h, ch)]);
      if (z.length <= a.length) { codec = C_QOI; bytes = z; } else bytes = a;
    } else bytes = await ansEncode(px, w, h, ch);
  }
  // never more than raw (readers reject a tile over raw + 4 KiB)
  if (!bytes || bytes.length >= px.length) return { codec: C_RAW, value: 0, bytes: px, crc, h2 };
  return { codec, value: 0, bytes, crc, h2 };
}
const QOI_ONLY = 0.02, QOI_TRY = 0.3, QUICK_BUSY = 0.02, BEST_BUSY = 0.004;
/** Decode one tile and check its CRC. → Uint8Array w×h×ch */
export async function decodeTile(codec, value, bytes, w, h, ch, crc) {
  const n = w * h;
  let px;
  switch (codec) {
    case C_SOLID: if (bytes && bytes.length) throw bad("solid tile has data"); px = fillSolid(n, ch, value); break;
    case C_RAW: if (bytes.length !== n * ch) throw bad("raw tile has the wrong length"); px = bytes; break;
    case C_QOI: if (ch !== 4) throw bad("QOI tile in a 1-channel layer"); px = qoiDecode(await inflate(bytes, n * 5, false), n); break;
    case C_ANS: px = await ansDecode(bytes, w, h, ch); break;
    default: throw new QcutError("unsupported", `unknown tile codec ${codec}`);
  }
  if (crc32(px) !== crc) throw bad("tile pixels fail their checksum");
  return px;
}

async function pixelsOfTask(m) {
  if (!m.bitmap) return new Uint8Array(m.px);
  const c = new OffscreenCanvas(m.w, m.h), g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(m.bitmap, 0, 0); m.bitmap.close?.();
  return new Uint8Array(g.getImageData(0, 0, m.w, m.h).data.buffer);
}
/** Worker/inline task runner: {op:"enc"|"dec"|"crc", …} → result (+ transfer list). */
export async function runTask(m) {
  if (m.op === "enc") {
    const px = await pixelsOfTask(m);
    // incremental save: the tile still matches what was encoded last time → nothing to do
    if (m.same && crc32(px) === m.same.crc && hash2(px) === m.same.h2) return [{ same: true }, []];
    const r = await encodeTile(px, m.w, m.h, m.ch, m.opts);
    const bytes = r.bytes && (r.bytes.byteOffset || r.bytes.length !== r.bytes.buffer.byteLength ? r.bytes.slice() : r.bytes);
    return [{ codec: r.codec, value: r.value, crc: r.crc, h2: r.h2, bytes }, bytes ? [bytes.buffer] : []];
  }
  if (m.op === "dec") {
    const bytes = m.blob ? new Uint8Array(await m.blob.arrayBuffer()) : null;
    const px = await decodeTile(m.codec, m.value, bytes, m.w, m.h, m.ch, m.crc);
    const out = px.byteOffset || px.length !== px.buffer.byteLength ? px.slice() : px;
    return [{ px: out }, [out.buffer]];
  }
  if (m.op === "crc") return [{ crc: crc32(new Uint8Array(await m.blob.arrayBuffer())) }, []];
  if (m.op === "ping") return [{}, []];
  throw new QcutError("unsupported", "unknown task");
}
