// Upscale (Fast and Max): the real worker and models (downloaded from models/ once), through the page.
//  - Fast ×2 and ×4: document and layer sizes, undo / redo (one step each), the layer's matrix unchanged
//  - tiles: a smooth gradient through many tiles has no seams (error at tile joins ≈ error elsewhere)
//  - alpha: a cut-out keeps its transparency
//  - a layer with a mask: the mask grows with it
//  - Max ×2 (when this browser has WebGPU with 16-bit floats): sizes + a detail check against the plain resize
// Run on a fresh page: (await import("/_test/upscaletest.js")).run()
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  const until = async (fn, ms) => { const t = performance.now(); while (performance.now() - t < ms) { if (fn()) return true; await wait(100); } return false; };
  const png = async (c, name) => new File([await c.convertToBlob({ type: "image/png" })], name, { type: "image/png" });
  const px = (c) => c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  const set = (k, val) => localStorage.setItem("quickcut.photo." + k, val);
  localStorage.removeItem("quickcut.photo.bgep");

  async function fresh(W, H, paint, name = "up.png") {
    const c = new OffscreenCanvas(W, H), g = c.getContext("2d");
    paint(g, W, H);
    await q.openNew([await png(c, name)]);
    await wait(400);
    v.querySelector('[data-tool="move"]').click();
    await wait(150);
  }
  const doc = () => q.doc, layer = () => q.doc.layers.at(-1);
  const upscale = async (quality, scale, ms = 240000) => {
    set("upq", quality); set("ups", String(scale));
    const before = doc();
    const w0 = before.w;
    v.querySelector('[data-a="resize"]').click(); await wait(250);
    const dlg = document.querySelector('.ph-pop[aria-label="Size"]');
    dlg.querySelector('[data-m="up"]').click(); await wait(150);
    dlg.querySelector('.ph-up [data-b="go"]').click();
    const done = await until(() => doc().w !== w0 && !q.up.busy(), ms);
    return done;
  };
  const undo = async () => { document.querySelector('[aria-label^="Undo"]').click(); await wait(300); };
  const redo = async () => { document.querySelector('[aria-label^="Redo"]').click(); await wait(300); };

  // a photo-like test picture: shapes, an edge, a bit of text
  const art = (g, W, H) => {
    const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, "#385a7a"); gr.addColorStop(1, "#d7c9a8");
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.fillStyle = "#b33a2c"; g.beginPath(); g.ellipse(W * 0.4, H * 0.55, W * 0.2, H * 0.28, 0, 0, 7); g.fill();
    g.fillStyle = "#fff"; g.font = `bold ${Math.round(H / 6)}px sans-serif`; g.fillText("Aa 12", W * 0.55, H * 0.3);
  };

  // ── Fast ×2 and ×4, undo / redo ────────────────────────────────────────────
  await fresh(160, 120, art);
  const l0 = layer(), cv0 = l0.canvas, M0 = [l0.ta, l0.tb, l0.tc, l0.td, l0.x, l0.y];
  ok("start size", doc().w === 160 && doc().h === 120, `${doc().w}x${doc().h}`);
  // Upscale lives in the Size dialog (top bar), next to Resize and Canvas
  ok("no Upscale button in the Move bar", !v.querySelector('[data-p="upscale"]'));
  localStorage.removeItem("quickcut.photo.sizemode");
  v.querySelector('[data-a="resize"]').click(); await wait(300);
  {
    const dlg = document.querySelector('.ph-pop[aria-label="Size"]');
    ok("Size dialog: Resize, Canvas, Upscale", !!dlg && [...dlg.querySelectorAll("[data-m]")].map((x) => x.textContent).join("|") === "Resize|Canvas|Upscale", dlg && [...dlg.querySelectorAll("[data-m]")].map((x) => x.textContent).join("|"));
    ok("Size dialog opens on Resize", !!dlg && !dlg.querySelector(".ph-rs").hidden && dlg.querySelector(".ph-up").hidden);
    dlg?.querySelector('[data-m="up"]').click(); await wait(1500);
    ok("Upscale: its options replace the resize fields", !!dlg && dlg.querySelector(".ph-rs").hidden && !dlg.querySelector(".ph-up").hidden && [...dlg.querySelectorAll(".ph-up [data-uq]")].map((x) => x.dataset.uq).join() === "fast,max" && dlg.querySelectorAll(".ph-up [data-us]").length === 2);
    ok("Upscale: one button to start", /upscale/i.test(dlg?.querySelector('.ph-up [data-b="go"]')?.textContent || ""), dlg?.querySelector('.ph-up [data-b="go"]')?.textContent);
    dlg?.querySelector('[data-m="image"]').click(); await wait(100);
    ok("back to Resize", !!dlg && !dlg.querySelector(".ph-rs").hidden && dlg.querySelector(".ph-up").hidden);
    dlg?.querySelector('[data-r="close"]').click(); await wait(200);
  }
  // the dialog opens where it was last used
  {
    const open = async () => { v.querySelector('[data-a="resize"]').click(); await wait(300); return document.querySelector('.ph-pop[aria-label="Size"]'); };
    const cur = (d) => d.querySelector('[data-m][aria-checked="true"]')?.dataset.m;
    let d = await open();
    d.querySelector('[data-m="up"]').click(); await wait(150);
    d.querySelector('[data-r="close"]').click(); await wait(250);
    d = await open();
    ok("reopens on Upscale after Upscale was used", cur(d) === "up" && !d.querySelector(".ph-up").hidden && d.querySelector(".ph-rs").hidden, cur(d));
    d.querySelector('[data-m="canvas"]').click(); await wait(100);
    d.querySelector('[data-r="close"]').click(); await wait(250);
    d = await open();
    ok("reopens on Canvas after Canvas was used", cur(d) === "canvas" && !d.querySelector(".ph-rs").hidden, cur(d));
    d.querySelector('[data-m="image"]').click(); await wait(100);
    d.querySelector('[data-r="close"]').click(); await wait(250);
  }
  ok("Fast ×2 finishes", await upscale("fast", 2, 300000));
  ok("document is 2× bigger", doc().w === 320 && doc().h === 240, `${doc().w}x${doc().h}`);
  ok("layer has 2× the pixels", layer().canvas.width === 320 && layer().canvas.height === 240, `${layer().canvas.width}x${layer().canvas.height}`);
  ok("layer is shown at scale 1 (matrix unchanged)", layer().ta === undefined && layer().x === 0 && layer().y === 0, JSON.stringify([layer().ta, layer().x, layer().y]));
  const s2 = q.up.stats;
  ok("ran in a worker, stats kept", !!s2 && s2.scale === 2 && s2.quality === "fast", JSON.stringify(s2));
  // plausible output: its mean colour is near the input's, and it has detail (not a flat fill)
  {
    const d = px(layer().canvas); let r = 0, n = 0, hi = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; n++; if (d[i] > 240 && d[i + 1] > 240) hi++; }
    const d0 = (() => { const c = new OffscreenCanvas(160, 120), g = c.getContext("2d"); art(g, 160, 120); return px(c); })();
    let r0 = 0; for (let i = 0; i < d0.length; i += 4) r0 += d0[i];
    ok("colours preserved", Math.abs(r / n - r0 / (d0.length / 4)) < 6, `${(r / n).toFixed(1)} vs ${(r0 / (d0.length / 4)).toFixed(1)}`);
    ok("white text still white", hi > 50, hi);
  }
  await undo();
  ok("undo: size back", doc().w === 160 && doc().h === 120, `${doc().w}x${doc().h}`);
  ok("undo: original pixels back", layer().canvas === cv0 && layer().ta === M0[0] && layer().x === M0[4]);
  await redo();
  ok("redo: 2× again", doc().w === 320 && layer().canvas.width === 320, `${doc().w}`);
  await undo();
  ok("Fast ×4 finishes", await upscale("fast", 4, 300000));
  ok("document is 4× bigger", doc().w === 640 && doc().h === 480 && layer().canvas.width === 640, `${doc().w}x${doc().h}`);
  ok("one undo step for the whole thing", (await undo(), doc().w === 160));

  // ── tiles: no seams ────────────────────────────────────────────────────────
  // a smooth diagonal gradient (the network should leave it alone): the error against the plain
  // enlargement must not peak at the tile joins. 400×300 is 3×3 tiles of 128 (overlap 16).
  const gradient = (g, W, H) => { const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, "#202830"); gr.addColorStop(0.5, "#8a7a5a"); gr.addColorStop(1, "#e8e0d0"); g.fillStyle = gr; g.fillRect(0, 0, W, H); };
  await fresh(400, 300, gradient, "grad.png");
  ok("gradient ×2 finishes", await upscale("fast", 2, 300000));
  {
    const W = 800, H = 600, d = px(layer().canvas);
    const ref = new OffscreenCanvas(W, H), rg = ref.getContext("2d"); gradient(rg, W, H); const r = px(ref);
    // error per column and per row; the join columns/rows of the tile grid (stride 112 → output ×2) vs the rest
    const colErr = new Float64Array(W), rowErr = new Float64Array(H);
    for (let y = 4; y < H - 4; y++) for (let x = 4; x < W - 4; x++) { const i = (y * W + x) * 4, e = Math.abs(d[i] - r[i]) + Math.abs(d[i + 1] - r[i + 1]) + Math.abs(d[i + 2] - r[i + 2]); colErr[x] += e; rowErr[y] += e; }
    const mean = (a, from, to) => { let s = 0; for (let i = from; i < to; i++) s += a[i]; return s / (to - from); };
    const base = mean(colErr, 8, W - 8) + 1e-6, peakC = Math.max(...[...colErr.subarray(8, W - 8)]), peakR = Math.max(...[...rowErr.subarray(8, H - 8)]);
    // a seam would be a column whose error stands far above the neighbours'
    let worst = 0;
    for (let x = 12; x < W - 12; x++) { const nb = (colErr[x - 6] + colErr[x + 6]) / 2 + 1e-6; worst = Math.max(worst, colErr[x] / nb); }
    for (let y = 12; y < H - 12; y++) { const nb = (rowErr[y - 6] + rowErr[y + 6]) / 2 + 1e-6; worst = Math.max(worst, rowErr[y] / nb); }
    ok("no seams (worst column/row error vs its neighbours < 1.3; 1.18 with blending, 1.40 without)", worst < 1.3, worst.toFixed(2));
    out.seamWorst = +worst.toFixed(3); out.peakCol = +(peakC / base).toFixed(2); out.peakRow = +(peakR / (mean(rowErr, 8, H - 8) + 1e-6)).toFixed(2);
    ok("gradient stays a gradient (mean abs error ≤ 6 levels)", mean(colErr, 8, W - 8) / ((H - 8) * 3) < 6, (mean(colErr, 8, W - 8) / ((H - 8) * 3)).toFixed(2));
  }
  out.tiles = q.up.stats?.tiles;

  // a dense texture (seeded, the same everywhere): the step between neighbouring columns/rows at the joins of the
  // tile grid must look like any other place. (Tile grid of the worker: tile 128, overlap 16, picture padded by 8.)
  {
    const W = 360, H = 300;
    await fresh(W, H, (g) => {
      let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      g.fillStyle = "#808080"; g.fillRect(0, 0, W, H);
      for (let i = 0; i < 1400; i++) { g.fillStyle = `hsl(${Math.floor(rnd() * 360)} 45% ${30 + Math.floor(rnd() * 45)}%)`; g.beginPath(); g.ellipse(rnd() * W, rnd() * H, 2 + rnd() * 9, 2 + rnd() * 9, rnd() * 3, 0, 7); g.fill(); }
    }, "texture.png");
    ok("texture ×2 finishes", await upscale("fast", 2, 300000));
    const OW = W * 2, OH = H * 2, d = px(layer().canvas);
    const dc = new Float64Array(OW), dr = new Float64Array(OH);
    for (let y = 1; y < OH; y++) for (let x = 1; x < OW; x++) { const i = (y * OW + x) * 4, a = (y * OW + x - 1) * 4, b = ((y - 1) * OW + x) * 4; const ex = Math.abs(d[i] - d[a]) + Math.abs(d[i + 1] - d[a + 1]) + Math.abs(d[i + 2] - d[a + 2]), ey = Math.abs(d[i] - d[b]) + Math.abs(d[i + 1] - d[b + 1]) + Math.abs(d[i + 2] - d[b + 2]); dc[x] += ex; dr[y] += ey; }
    const starts = (len) => { const T = 128, ov = 16, s = []; if (len <= T) return [0]; for (let p = 0; ; p += T - ov) { if (p + T >= len) { s.push(len - T); break; } s.push(p); } return s; };
    const joins = (len, n) => starts(len + 16).slice(1).map((p) => (p - 8) * 2).filter((c) => c > 8 && c < n - 8);
    let worst = 0;
    const check = (arr, cols) => { for (const c of cols) { let nb = 0, k = 0; for (let o = -10; o <= 10; o++) { if (Math.abs(o) < 3) continue; nb += arr[c + o]; k++; } worst = Math.max(worst, arr[c] / (nb / k), arr[c + 1] / (nb / k)); } };
    check(dc, joins(W, OW)); check(dr, joins(H, OH));
    out.textureSeam = +worst.toFixed(3);
    ok("no step at the tile joins on texture (< 1.5× the neighbourhood; 1.3 with blending, 1.7 without)", worst < 1.5, worst.toFixed(3));
  }
  ok("several tiles were used", (q.up.stats?.tiles || 0) >= 9, q.up.stats?.tiles);

  // ── transparency ───────────────────────────────────────────────────────────
  await fresh(120, 90, (g, W, H) => { g.fillStyle = "#c0392b"; g.beginPath(); g.ellipse(W / 2, H / 2, 40, 30, 0, 0, 7); g.fill(); }, "alpha.png");
  ok("cut-out ×2 finishes", await upscale("fast", 2, 300000));
  {
    const c = layer().canvas, g = c.getContext("2d"), a = (x, y) => g.getImageData(x, y, 1, 1).data[3];
    ok("transparent corner stays transparent", a(4, 4) < 8, a(4, 4));
    ok("shape stays opaque", a(c.width / 2, c.height / 2) > 247, a(c.width / 2, c.height / 2));
  }

  // ── Strength: below 100 % the plain resize is mixed back in ────────────────
  {
    const dist = (c, ref) => { const a = c.getContext("2d").getImageData(0, 0, c.width, c.height).data, b = ref.getContext("2d").getImageData(0, 0, c.width, c.height).data; let t = 0; for (let i = 0; i < a.length; i += 4) t += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return t / (a.length / 4); };
    await fresh(96, 96, art, "strength.png");
    const plain = new OffscreenCanvas(192, 192), pg = plain.getContext("2d");
    pg.imageSmoothingQuality = "high"; pg.drawImage(layer().canvas, 0, 0, 192, 192);
    set("upst", "100");
    ok("strength 100 finishes", await upscale("fast", 2, 300000));
    const full = dist(layer().canvas, plain);
    q.undo(); await wait(300);
    set("upst", "10");
    ok("strength 10 finishes", await upscale("fast", 2, 300000));
    const low = dist(layer().canvas, plain);
    set("upst", "100");
    out.strength = `${full.toFixed(2)} → ${low.toFixed(2)}`;
    ok("strength 10 % is much closer to the plain resize", full > 0.5 && low < full * 0.35, out.strength);
    v.querySelector('[data-a="resize"]').click(); await wait(250);
    const dlg = document.querySelector('.ph-pop[aria-label="Size"]');
    dlg.querySelector('[data-m="up"]').click(); await wait(200);
    ok("Strength slider in the Upscale options", !!dlg.querySelector(".ph-up [data-ust]") && dlg.querySelector('.ph-up [data-v="upst"]').textContent === "100%", dlg.querySelector('.ph-up [data-v="upst"]')?.textContent);
    ok("Strength slider: the filled track matches the value", getComputedStyle(dlg.querySelector(".ph-up [data-ust]")).getPropertyValue("--p").trim() === "100%", getComputedStyle(dlg.querySelector(".ph-up [data-ust]")).getPropertyValue("--p"));
    dlg.querySelector('[data-r="close"]').click(); await wait(200);
  }

  // ── a layer with a mask ────────────────────────────────────────────────────
  await fresh(100, 80, art, "mask.png");
  {
    const l = layer(), mc = new OffscreenCanvas(l.canvas.width, l.canvas.height), mg = mc.getContext("2d");
    mg.fillStyle = "#fff"; mg.beginPath(); mg.ellipse(50, 40, 30, 24, 0, 0, 7); mg.fill();
    const a8 = new Uint8Array(mc.width * mc.height), md = mg.getImageData(0, 0, mc.width, mc.height).data;
    for (let i = 0; i < a8.length; i++) a8[i] = md[i * 4 + 3];
    Object.assign(l, { mask: mc, maskBase: a8, maskOn: true, maskShift: 0, maskSoft: 0 });
  }
  if (layer().mask) {
    ok("mask layer ×2 finishes", await upscale("fast", 2, 300000));
    ok("mask grew with the layer", layer().mask && layer().mask.width === layer().canvas.width && layer().mask.height === layer().canvas.height, layer().mask && `${layer().mask.width}x${layer().mask.height} vs ${layer().canvas.width}`);
  }

  // ── a layer the background remover cut out: it has two copies of its pixels (the photo and the one
  //    with cleaned edge colours); both must come out at the new size, or hiding the mask shows a halo
  await fresh(100, 80, (g, W, H) => { g.fillStyle = "rgb(200,40,40)"; g.fillRect(0, 0, W, H); }, "cut.png");
  {
    const l = layer(), W0 = l.canvas.width, H0 = l.canvas.height;
    const mc = new OffscreenCanvas(W0, H0), mg = mc.getContext("2d");
    mg.fillStyle = "#fff"; mg.fillRect(0, 0, 60, H0);
    const a8 = new Uint8Array(W0 * H0), md = mg.getImageData(0, 0, W0, H0).data;
    for (let i = 0; i < a8.length; i++) a8[i] = md[i * 4 + 3];
    const fixed = new OffscreenCanvas(W0, H0), fg = fixed.getContext("2d");
    fg.drawImage(l.canvas, 0, 0); fg.fillStyle = "rgb(20,20,220)"; fg.fillRect(40, 0, 20, H0);
    Object.assign(l, { mask: mc, maskBase: a8, maskOn: true, maskShift: 0, maskSoft: 0, preBg: l.canvas, bgFixed: fixed, canvas: fixed });
  }
  ok("cut-out ×2 finishes", await upscale("fast", 2, 300000));
  {
    const l = layer(), at = (c, x, y) => [...c.getContext("2d").getImageData(x, y, 1, 1).data.slice(0, 3)];
    const near = (p, c, t = 30) => p.every((n, i) => Math.abs(n - c[i]) <= t);
    const both = !!l.preBg && !!l.bgFixed;
    ok("cut-out: both copies at the new size", both && l.canvas === l.bgFixed && l.preBg.width === 200 && l.bgFixed.width === 200, `photo ${!!l.preBg}, cleaned ${!!l.bgFixed}`);
    ok("cut-out: the cleaned band is still cleaned", both && near(at(l.bgFixed, 100, 80), [20, 20, 220]), both ? at(l.bgFixed, 100, 80).join() : "gone");
    ok("cut-out: the photo copy is the upscaled photo", both && near(at(l.preBg, 100, 80), [200, 40, 40]), both ? at(l.preBg, 100, 80).join() : "gone");
    l.maskOn = false;
    ok("cut-out: mask off shows the photo", near(at(q.drawnPx(l), 100, 80), [200, 40, 40]), at(q.drawnPx(l), 100, 80).join());
    l.maskOn = true;
  }

  // ── Max (WebGPU + 16-bit floats only) ──────────────────────────────────────
  const info = await q.up.status?.();
  const maxOk = info?.models?.max && !info.models.max.unfit;
  out.maxAvailable = !!maxOk;
  if (maxOk) {
    await fresh(120, 90, art, "max.png");
    ok("Max ×2 finishes", await upscale("max", 2, 600000));
    ok("Max: document 2× bigger", doc().w === 240 && doc().h === 180, `${doc().w}x${doc().h}`);
    ok("Max ran as Max (not the fallback)", q.up.stats?.quality === "max" && q.up.stats?.ep === "webgpu", JSON.stringify(q.up.stats));
    out.maxMs = q.up.stats?.ms;
    await undo();
    ok("Max undo", doc().w === 120);
  }
  return { pass: !fails.length, fails, out };
}
