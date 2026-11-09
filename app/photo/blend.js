// Photoshop blend modes, per pixel. Ported from PhotoCraft (MIT OR Apache-2.0):
// crates/color/src/blend.rs (W3C / ISO 32000 formulas) with the Photoshop variants of
// crates/compose/src/psblend.rs (Vivid Light, Hard Mix, Color Burn / Dodge edges).
// This is the reference the GPU shader in engine.js follows, and the CPU fallback when a browser
// has no WebGL2. `_test/blendtest.mjs` checks it against PhotoCraft's test vectors.
// Colours are straight (not premultiplied) 0..1.

export const EDGE = 1e-4; // backdrop values this close to 0 / 1 count as exact (psblend::EDGE)
const colorBurn = (b, s) => (b >= 1 - EDGE ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
const colorDodge = (b, s) => (b <= EDGE ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
const hardLight = (b, s) => (s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1));
function softLight(b, s) {
  if (s <= 0.5) return 2 * b * s + b * b * (1 - 2 * s);
  const x = Math.max(0, b), d = x <= 0.25 ? ((16 * x - 12) * x + 4) * x : Math.sqrt(x);
  return 2 * b * (1 - s) + d * (2 * s - 1);
}
// Photoshop's Vivid Light: the source extremes win (black source = 0 even over white)
const vivid = (b, s) => (s <= 0.5 ? (s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / (2 * s))) : s >= 1 ? 1 : Math.min(1, b / (2 * (1 - s))));
// the generic one (backdrop extremes win), thresholded for Hard Mix
function vividG(b, s) {
  if (s <= 0.5) return b >= 1 - EDGE ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / (2 * s));
  return b <= EDGE ? 0 : s >= 1 ? 1 : Math.min(1, b / (2 * (1 - s)));
}

/** Separable `B(cb, cs)` for one channel. */
export function channel(mode, b, s) {
  switch (mode) {
    case "darken": return Math.min(b, s);
    case "multiply": return b * s;
    case "color-burn": return colorBurn(b, s);
    case "linear-burn": return Math.max(0, b + s - 1);
    case "lighten": return Math.max(b, s);
    case "screen": return b + s - b * s;
    case "color-dodge": return colorDodge(b, s);
    case "linear-dodge": return Math.min(1, b + s);
    case "overlay": return hardLight(s, b);
    case "soft-light": return softLight(b, s);
    case "hard-light": return hardLight(b, s);
    case "vivid-light": return vivid(b, s);
    case "linear-light": return Math.min(1, Math.max(0, b + 2 * s - 1));
    case "pin-light": return s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1);
    case "hard-mix": return vividG(b, s) >= 0.5 - 1e-6 ? 1 : 0;
    case "difference": return Math.abs(b - s);
    case "exclusion": return b + s - 2 * b * s;
    case "subtract": return Math.max(0, b - s);
    case "divide": return s <= 0 ? (b <= 0 ? 0 : 1) : Math.min(1, b / s);
    default: return s; // normal, dissolve
  }
}

// ── non-separable (W3C Compositing Level 1, with PhotoCraft's out-of-range guard) ──
export const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
function clipColor(c) {
  const l = lum(c), n = Math.min(c[0], c[1], c[2]), x = Math.max(c[0], c[1], c[2]);
  let o = c;
  if (n < 0) { const d = l - n; o = o.map((v) => (l > 0 && d > 0 ? l + ((v - l) * l) / d : l)); }
  if (x > 1) { const d = x - l; o = o.map((v) => (l < 1 && d > 0 ? l + ((v - l) * (1 - l)) / d : l)); }
  return o;
}
export const setLum = (c, l) => { const d = l - lum(c); return clipColor([c[0] + d, c[1] + d, c[2] + d]); };
const sat = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c, s) {
  const i = [0, 1, 2].sort((a, b) => c[a] - c[b]), o = [0, 0, 0];
  if (c[i[2]] > c[i[0]]) { o[i[1]] = ((c[i[1]] - c[i[0]]) * s) / (c[i[2]] - c[i[0]]); o[i[2]] = s; }
  return o;
}

/** `B(Cb, Cs)` for an RGB triple, every mode. */
export function blendRGB(mode, cb, cs) {
  switch (mode) {
    case "hue": return setLum(setSat(cs, sat(cb)), lum(cb));
    case "saturation": return setLum(setSat(cb, sat(cs)), lum(cb));
    case "color": return setLum(cs, lum(cb));
    case "luminosity": return setLum(cb, lum(cs));
    case "darker-color": return lum(cs) < lum(cb) ? cs : cb;
    case "lighter-color": return lum(cs) > lum(cb) ? cs : cb;
    default: return [channel(mode, cb[0], cs[0]), channel(mode, cb[1], cs[1]), channel(mode, cb[2], cs[2])];
  }
}

/** Source over backdrop (straight RGBA) with mode and opacity: the W3C/PDF general formula. Dissolve is resolved by the caller. */
export function composite(mode, b, s, opacity = 1) {
  const ab = b[3], as = s[3] * opacity;
  if (as <= 0) return b.slice();
  const B = blendRGB(mode, b, s), ao = as + ab * (1 - as);
  if (ao <= 0) return [0, 0, 0, 0];
  const o = [0, 0, 0, ao];
  for (let i = 0; i < 3; i++) o[i] = ((1 - as) * ab * b[i] + (1 - ab) * as * s[i] + as * ab * B[i]) / ao;
  return o;
}
/** Clipped onto a base: the backdrop's alpha is kept, `Co = (1 − αs)·Cb + αs·B(Cb, Cs)`. */
export function compositeAtop(mode, b, s, opacity = 1) {
  const as = s[3] * opacity;
  if (as <= 0) return b.slice();
  const B = blendRGB(mode, b, s), o = b.slice();
  for (let i = 0; i < 3; i++) o[i] = (1 - as) * b[i] + as * B[i];
  return o;
}
/** Dissolve's per-pixel threshold (document coordinates, so it's the same at any zoom and in export). */
export function dissolveNoise(x, y) {
  let h = (Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ 0x9e3779b9) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return (h & 0xffff) / 65536;
}
