// QuickCut Photo worker: decoding and full-size export run here so the page never freezes.
import { composite, tree, buffers, sniff, fitScale, mul, T, S, scaleOf, reduced } from "./engine.js";
import { deriveMask, alphaToImageData } from "./maskops.js";

let doc = null; // {ver, w, h, layers: [{src: ImageBitmap, parent, ...}], groups, nodes (the tree)}
const buf = buffers();

onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.op === "decode") return post(m.id, await decode(m.file, m.lim));
    if (m.op === "doc") {
      for (const l of doc?.layers || []) { l.src?.close?.(); l.mask?.src?.close?.(); }
      doc = { ver: m.ver, w: m.w, h: m.h, layers: m.layers, nodes: tree(m.layers, m.groups || []) };
      return post(m.id, { ok: true });
    }
    if (m.op === "export") return post(m.id, await render(m));
    if (m.op === "estimate") return post(m.id, await estimate(m));
    if (m.op === "derive") {
      // a layer mask's edge controls (shift, softness) over the whole mask
      const a = deriveMask(m.base, m.w, m.h, m.shift, m.soft), c = new OffscreenCanvas(m.w, m.h), g = c.getContext("2d");
      const strip = Math.max(1, Math.floor(4e6 / m.w));
      for (let y = 0; y < m.h; y += strip) { const sh = Math.min(strip, m.h - y); g.putImageData(alphaToImageData(a, m.w, m.h, 0, y, m.w, sh), 0, y); }
      return post(m.id, { bitmap: c.transferToImageBitmap() });
    }
    if (m.op === "encode") {
      // one layer for the saved session: photos as WebP (small; alpha kept), painted layers as PNG
      const c = new OffscreenCanvas(m.bitmap.width, m.bitmap.height);
      c.getContext("2d").drawImage(m.bitmap, 0, 0);
      m.bitmap.close();
      return post(m.id, { blob: await c.convertToBlob(m.type ? { type: m.type, quality: m.quality } : { type: "image/png" }) });
    }
  } catch (err) {
    postMessage({ id: m.id, error: String(err?.message || err) });
  }
};
function post(id, out, transfer = []) {
  if (out?.bitmap) transfer.push(out.bitmap);
  postMessage({ id, ...out }, transfer);
}

async function decode(file, lim) {
  const head = sniff(await file.slice(0, 512 * 1024).arrayBuffer());
  if (head?.w && head?.h) {
    const s = fitScale(head.w, head.h, lim);
    if (s < 1) {
      const bitmap = await createImageBitmap(file, { resizeWidth: Math.max(1, Math.floor(head.w * s)), resizeHeight: Math.max(1, Math.floor(head.h * s)), resizeQuality: "high", imageOrientation: "from-image" });
      return { bitmap, w0: head.w, h0: head.h, type: head.type };
    }
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const s = fitScale(bitmap.width, bitmap.height, lim);
  if (s < 1) {
    const small = await createImageBitmap(bitmap, { resizeWidth: Math.floor(bitmap.width * s), resizeHeight: Math.floor(bitmap.height * s), resizeQuality: "high" });
    const w0 = bitmap.width, h0 = bitmap.height;
    bitmap.close();
    return { bitmap: small, w0, h0, type: head?.type };
  }
  return { bitmap, w0: bitmap.width, h0: bitmap.height, type: head?.type };
}

/** Composite the document at w×h (optionally only the tile tx,ty,tw,th of it) into a canvas. */
function draw(w, h, tile, opaque, matte = "#FFFFFF") {
  const tw = tile ? tile.w : w, th = tile ? tile.h : h;
  const out = new OffscreenCanvas(tw, th);
  const ctx = out.getContext("2d");
  let M = S(w / doc.w, h / doc.h);
  if (tile) M = mul(T(-tile.x, -tile.y), M);
  buf.size(tw, th);
  const back = shrink(M);
  try {
    if (opaque) {
      // JPG has no transparency: composite first, then put it on the matte colour (blend modes stay correct)
      const c = buf("o");
      composite(c, doc.nodes, M, buf);
      ctx.fillStyle = /^#[\da-f]{6}$/i.test(matte) ? matte : "#FFFFFF";
      ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(c.canvas, 0, 0);
    } else composite(ctx, doc.nodes, M, buf);
  } finally { back(); }
  return out;
}
/**
 * Smart layers drawn much smaller than their source (a big photo scaled down): draw them from a
 * halved copy (high-quality filter) so the export doesn't alias. Returns a function that puts the
 * full-size sources back and frees the copies.
 */
function shrink(M) {
  const saved = [];
  for (const l of doc.layers) {
    if (!l.src) continue;
    const k = scaleOf(mul(M, l.m || T(l.x, l.y)));
    const r = reduced(l.src, k), mr = l.mask?.src ? reduced(l.mask.src, k) : null;
    if (!r && !mr) continue;
    saved.push([l, l.src, l.mask, r, mr]);
    if (r) { l.src = r.src; l.sx = r.sx; l.sy = r.sy; }
    if (mr) l.mask = { ...l.mask, src: mr.src, sx: mr.sx, sy: mr.sy };
  }
  return () => {
    for (const [l, src, mask, r, mr] of saved) {
      l.src = src; l.mask = mask; delete l.sx; delete l.sy;
      for (const x of [r, mr]) if (x) { x.src.width = 1; x.src.height = 1; }
    }
  };
}

async function render({ w, h, type, quality, matte }) {
  const t0 = performance.now();
  const out = draw(w, h, null, type === "image/jpeg", matte);
  buf.drop();
  const blob = await out.convertToBlob({ type, quality });
  out.width = out.height = 1;
  return { blob, ms: performance.now() - t0 };
}

// Size estimate: encode a full-resolution tile from the middle and scale by area, so detail
// density matches the real export.
async function estimate({ w, h, type, quality, matte }) {
  const side = 640;
  const tw = Math.min(w, side), th = Math.min(h, side);
  const tile = { x: Math.floor((w - tw) / 2), y: Math.floor((h - th) / 2), w: tw, h: th };
  const out = draw(w, h, tile, type === "image/jpeg", matte);
  const blob = await out.convertToBlob({ type, quality });
  return { bytes: Math.round(blob.size * ((w * h) / (tw * th))) };
}
