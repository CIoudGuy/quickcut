// Colour extraction, off the main thread. Receives a small ImageBitmap (already downscaled by the
// page), counts its colours in a 5-bit histogram, then runs weighted k-means in CIE Lab seeded
// farthest-first, so the palette is the same every time for the same image.
self.onmessage = (e) => {
  const { id, bitmap, n } = e.data;
  try {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    self.postMessage({ id, colors: extract(d, n) });
  } catch (err) {
    self.postMessage({ id, colors: [], error: String(err && err.message || err) });
  }
};

function srgbToLin(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
function toLab(r, g, b) {
  const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b);
  let x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  let y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  let z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function extract(d, n) {
  // histogram over 5 bits per channel
  const cnt = new Uint32Array(32768), sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    cnt[k]++; sr[k] += r; sg[k] += g; sb[k] += b;
  }
  const bins = [];
  for (let k = 0; k < 32768; k++) {
    if (!cnt[k]) continue;
    const r = sr[k] / cnt[k], g = sg[k] / cnt[k], b = sb[k] / cnt[k];
    bins.push({ w: cnt[k], r, g, b, lab: toLab(r, g, b) });
  }
  if (!bins.length) return [];
  const k = Math.min(n, bins.length);
  const dist = (a, b) => { const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return x * x + y * y + z * z; };

  // farthest-first seeding, weighted by sqrt(count) so rare specks don't win
  const centres = [bins.reduce((m, b) => (b.w > m.w ? b : m)).lab.slice()];
  const near = bins.map((b) => dist(b.lab, centres[0]));
  while (centres.length < k) {
    let best = -1, score = -1;
    for (let i = 0; i < bins.length; i++) {
      const s = near[i] * Math.sqrt(bins[i].w);
      if (s > score) { score = s; best = i; }
    }
    if (best < 0 || score <= 0) break;
    centres.push(bins[best].lab.slice());
    for (let i = 0; i < bins.length; i++) near[i] = Math.min(near[i], dist(bins[i].lab, centres[centres.length - 1]));
  }

  const assign = new Int32Array(bins.length);
  for (let it = 0; it < 12; it++) {
    let moved = false;
    for (let i = 0; i < bins.length; i++) {
      let bi = 0, bd = Infinity;
      for (let j = 0; j < centres.length; j++) {
        const dd = dist(bins[i].lab, centres[j]);
        if (dd < bd) { bd = dd; bi = j; }
      }
      if (assign[i] !== bi) { assign[i] = bi; moved = true; }
    }
    const acc = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < bins.length; i++) {
      const a = acc[assign[i]], w = bins[i].w;
      a[0] += bins[i].lab[0] * w; a[1] += bins[i].lab[1] * w; a[2] += bins[i].lab[2] * w; a[3] += w;
    }
    acc.forEach((a, j) => { if (a[3]) centres[j] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
    if (!moved) break;
  }

  // each cluster's colour = the average of its pixels' real RGB
  const out = centres.map(() => ({ r: 0, g: 0, b: 0, w: 0 }));
  for (let i = 0; i < bins.length; i++) {
    const o = out[assign[i]], w = bins[i].w;
    o.r += bins[i].r * w; o.g += bins[i].g * w; o.b += bins[i].b * w; o.w += w;
  }
  const res = out.filter((o) => o.w).map((o) => {
    const r = Math.round(o.r / o.w), g = Math.round(o.g / o.w), b = Math.round(o.b / o.w);
    return { hex: "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase(), L: toLab(r, g, b)[0] };
  });
  res.sort((a, b) => b.L - a.L); // light to dark
  const seen = new Set();
  return res.filter((c) => (seen.has(c.hex) ? false : seen.add(c.hex))).map((c) => c.hex);
}
