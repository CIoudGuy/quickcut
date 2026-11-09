// QuickCut Photo mask maths (alpha masks as one byte per pixel). Plain ES module used by the page
// and by the background-remover worker: box blur, grey-level dilate/erode and the edge controls.

/** Separable box filter of a Float32 map in place (edge-normalised mean over a (2r+1)² window). */
export function boxF(a, w, h, r, tmp = new Float32Array(w * h)) {
  if (r < 1) return a;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    const r1 = Math.min(r, w - 1);
    for (let x = 0; x <= r1; x++) s += a[o + x];
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r);
      tmp[o + x] = s / (hi - lo + 1);
      if (x + r + 1 < w) s += a[o + x + r + 1];
      if (x - r >= 0) s -= a[o + x - r];
    }
  }
  const col = new Float32Array(h);
  for (let x = 0; x < w; x++) {
    let s = 0;
    const r1 = Math.min(r, h - 1);
    for (let y = 0; y <= r1; y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r);
      col[y] = s / (hi - lo + 1);
      if (y + r + 1 < h) s += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) s -= tmp[(y - r) * w + x];
    }
    for (let y = 0; y < h; y++) a[y * w + x] = col[y];
  }
  return a;
}

/** Grey-level dilation (max) or erosion (min) of a byte map with a square of radius r (van Herk/Gil-Werman). */
export function morph(src, w, h, r, max) {
  if (r < 1) return src;
  const out = new Uint8Array(w * h), n = Math.max(w, h), k = 2 * r + 1;
  const f = new Uint8Array(n + k), g = new Uint8Array(n + k), line = new Uint8Array(n + 2 * r);
  const pick = max ? (a, b) => (a > b ? a : b) : (a, b) => (a < b ? a : b);
  const pad = max ? 0 : 255;
  const pass = (get, set, len) => {
    for (let i = 0; i < r; i++) { line[i] = pad; line[len + r + i] = pad; }
    for (let i = 0; i < len; i++) line[r + i] = get(i);
    const L = len + 2 * r;
    for (let b = 0; b < L; b += k) {
      const e = Math.min(L, b + k);
      f[b] = line[b];
      for (let i = b + 1; i < e; i++) f[i] = pick(f[i - 1], line[i]);
      g[e - 1] = line[e - 1];
      for (let i = e - 2; i >= b; i--) g[i] = pick(g[i + 1], line[i]);
    }
    for (let i = 0; i < len; i++) set(i, pick(g[i], f[Math.min(L - 1, i + 2 * r)]));
  };
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) { const o = y * w; pass((i) => src[o + i], (i, v) => { tmp[o + i] = v; }, w); }
  for (let x = 0; x < w; x++) pass((i) => tmp[i * w + x], (i, v) => { out[i * w + x] = v; }, h);
  return out;
}

/**
 * Edge controls: shift (px; > 0 grows the kept area, < 0 shrinks it) then softness (px blur).
 * `base` is w×h bytes; returns a new byte map (or `base` itself when nothing changes).
 */
export function deriveMask(base, w, h, shift = 0, soft = 0) {
  let m = base;
  const s = Math.round(Math.abs(shift));
  if (s >= 1) m = morph(m, w, h, s, shift > 0);
  const r = soft / 1.6; // three box passes ≈ a Gaussian with σ ≈ soft / 2
  if (r >= 0.5) {
    const f = new Float32Array(w * h), t = new Float32Array(w * h);
    for (let i = 0; i < f.length; i++) f[i] = m[i];
    const rr = Math.max(1, Math.round(r));
    boxF(f, w, h, rr, t); boxF(f, w, h, rr, t); boxF(f, w, h, rr, t);
    const out = new Uint8Array(w * h);
    for (let i = 0; i < f.length; i++) out[i] = f[i] + 0.5;
    m = out;
  }
  return m;
}

/** White pixels carrying `alpha` as their alpha (how masks are stored on canvases). */
export function alphaToImageData(alpha, w, h, x0 = 0, y0 = 0, rw = w, rh = h) {
  const d = new ImageData(rw, rh), p = d.data;
  for (let y = 0; y < rh; y++) {
    let i = (y0 + y) * w + x0, o = y * rw * 4;
    for (let x = 0; x < rw; x++, i++, o += 4) { p[o] = 255; p[o + 1] = 255; p[o + 2] = 255; p[o + 3] = alpha[i]; }
  }
  return d;
}
