// .qcut format tests: round trips (pixel-identical), corrupt / truncated / hostile files, versions,
// and speed. Open /_test/qcut/ (runs everything), or in a console on the dev server:
//   (await import("/_test/qcut/qcuttest.js")).run()            → { pass, fails, n, ms }
//   (await import("/_test/qcut/qcuttest.js")).speed()          → timings table
import * as qcut from "../../shared/qcut.js";
import { crc32, deflate, encodeTile, decodeTile, qoiEncode, qoiDecode, ansEncodeJS, ansDecodeJS, ansEncode, ansDecode, wasmCodec, C_SOLID, C_QOI, C_ANS, C_RAW, C_REF } from "../../shared/qcut-codec.js";

// ── test content ─────────────────────────────────────────────────────────────
let photoSrc = null;
let rs = 1;
const rnd = () => ((rs = (rs * 1103515245 + 12345) >>> 0) / 4294967296);
async function photoBitmap() { return (photoSrc ||= await createImageBitmap(await (await fetch(new URL("../rv_photo.png", import.meta.url))).blob())); }
/** Layer content: "photo" (real photo, mirror-tiled + mild noise), "ui", "sparse" (cut-out, soft edge), "text" (strokes + text), "alpha" (random RGBA). */
export async function make(type, W, H) {
  rs = 7;
  const c = new OffscreenCanvas(W, H), g = c.getContext("2d");
  if (type === "photo" || type === "sparse") {
    const src = await photoBitmap(), m = type === "sparse" ? new OffscreenCanvas(W, H) : c, mg = m.getContext("2d");
    for (let y = 0, ty = 0; y < H; y += src.height, ty++) for (let x = 0, tx = 0; x < W; x += src.width, tx++) {
      mg.save(); mg.translate(x + (tx & 1 ? src.width : 0), y + (ty & 1 ? src.height : 0)); mg.scale(tx & 1 ? -1 : 1, ty & 1 ? -1 : 1); mg.drawImage(src, 0, 0); mg.restore();
    }
    if (type === "photo") {
      for (let y = 0; y < H; y += 256) {
        const h = Math.min(256, H - y), id = g.getImageData(0, y, W, h), d = id.data;
        for (let i = 0; i < d.length; i += 4) { const n = ((rnd() + rnd()) * 3 - 3) | 0; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
        g.putImageData(id, 0, y);
      }
    } else {
      mg.globalCompositeOperation = "destination-in"; mg.filter = `blur(${Math.max(1, Math.round(W / 400))}px)`;
      mg.beginPath(); mg.ellipse(W * 0.6, H * 0.55, W * 0.16, H * 0.24, 0.3, 0, Math.PI * 2); mg.fill();
      g.drawImage(m, 0, 0);
    }
  } else if (type === "ui") {
    const s = W / 1920;
    g.fillStyle = "#f4f5f7"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#1f2430"; g.fillRect(0, 0, W, 64 * s);
    for (let i = 0; i < 40; i++) {
      const x = rnd() * W * 0.8, y = 80 * s + rnd() * H * 0.8, w = (80 + rnd() * 400) * s, h = (40 + rnd() * 240) * s;
      g.fillStyle = ["#ffffff", "#e3e8ef", "#3b82f6", "#10b981", "#f59e0b", "#111827"][i % 6];
      g.beginPath(); g.roundRect(x, y, w, h, 12 * s); g.fill();
      if (i % 5 === 0) { const gr = g.createLinearGradient(x, y, x + w, y + h); gr.addColorStop(0, "#6366f1"); gr.addColorStop(1, "#ec4899"); g.fillStyle = gr; g.fill(); }
      g.fillStyle = "#374151"; g.font = `${Math.max(6, Math.round(14 * s))}px sans-serif`; g.fillText("Button label " + i, x + 12 * s, y + 24 * s);
    }
  } else if (type === "text") {
    const s = W / 1920;
    g.lineCap = "round"; g.lineJoin = "round";
    for (let i = 0; i < 12; i++) {
      g.strokeStyle = `hsla(${i * 30},80%,50%,${0.5 + rnd() * 0.5})`; g.lineWidth = (4 + rnd() * 30) * s;
      g.beginPath(); g.moveTo(rnd() * W, rnd() * H); for (let k = 0; k < 6; k++) g.quadraticCurveTo(rnd() * W, rnd() * H, rnd() * W, rnd() * H); g.stroke();
    }
    g.fillStyle = "#111"; g.font = `bold ${Math.max(8, Math.round(72 * s))}px serif`; g.fillText("Summer Sale 2026", 120 * s, 200 * s);
    g.font = `${Math.max(6, Math.round(28 * s))}px sans-serif`;
    for (let l = 0; l < 8; l++) g.fillText("The quick brown fox jumps over the lazy dog " + l, 120 * s, (300 + l * 44) * s);
  } else if (type === "alpha") {
    const id = new ImageData(W, H);
    for (let i = 0; i < id.data.length; i++) id.data[i] = (rnd() * 256) | 0;
    g.putImageData(id, 0, 0);
  }
  return c;
}
const pixelsOf = (c) => new Uint8Array(c.getContext("2d").getImageData(0, 0, c.width, c.height).data.buffer);
/** A decoded layer as a canvas would hold it (canvases keep premultiplied pixels; that's what must match). */
function viaCanvas(img) { const c = new OffscreenCanvas(img.width, img.height); c.getContext("2d").putImageData(img, 0, 0); return pixelsOf(c); }
function eq(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
async function preview(c) {
  const s = Math.min(1, 512 / Math.max(c.width, c.height)), p = new OffscreenCanvas(Math.max(1, Math.round(c.width * s)), Math.max(1, Math.round(c.height * s)));
  p.getContext("2d").drawImage(c, 0, 0, p.width, p.height);
  return p.convertToBlob({ type: "image/webp", quality: 0.8 });
}
/** Rewrite the header CRC after editing header/table/meta bytes (so the edit reaches the deeper checks). */
function fixHeadCrc(u8) {
  const dv = new DataView(u8.buffer), N = dv.getUint32(16, true), J = dv.getUint32(20, true), end = 40 + 32 * N + J;
  dv.setUint32(32, crc32(u8.subarray(36, end), crc32(u8.subarray(0, 32))), true);
  return u8;
}
function parseHead(u8) {
  const dv = new DataView(u8.buffer), N = dv.getUint32(16, true), J = dv.getUint32(20, true);
  const chunks = [];
  for (let i = 0; i < N; i++) { const e = 40 + 32 * i; chunks.push({ e, off: Number(dv.getBigUint64(e, true)), len: Number(dv.getBigUint64(e + 8, true)), type: u8[e + 20] }); }
  return { N, J, chunks, metaAt: 40 + 32 * N, meta: JSON.parse(new TextDecoder().decode(u8.subarray(40 + 32 * N, 40 + 32 * N + J))) };
}
/** Replace the meta JSON (re-lays out the file: chunk offsets shift). */
function withMeta(u8, meta) {
  const h = parseHead(u8), m = new TextEncoder().encode(JSON.stringify(meta)), shift = m.length - h.J;
  const out = new Uint8Array(u8.length + shift);
  out.set(u8.subarray(0, h.metaAt)); out.set(m, h.metaAt); out.set(u8.subarray(h.metaAt + h.J), h.metaAt + m.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(20, m.length, true); dv.setBigUint64(24, BigInt(out.length), true);
  for (const c of h.chunks) dv.setBigUint64(c.e, BigInt(c.off + shift), true);
  return fixHeadCrc(out);
}
const blobOf = (u8) => new Blob([u8]);
async function fullLoad(blob) { const f = await qcut.read(blob); await f.preview(); return f.loadAll(); }
/** Expect a QcutError (with one of `codes`), never another error, never wrong data, within `ms`. */
async function expectFail(ok, what, fn, codes = null, ms = 10000) {
  const t0 = performance.now();
  let err = null;
  try { await Promise.race([fn(), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]); } catch (e) { err = e; }
  ok(err instanceof qcut.QcutError && (!codes || codes.includes(err.code)), `${what}: expected QcutError${codes ? " " + codes : ""}, got ${err ? `${err.name} ${err.code || ""} ${err.message}` : "success"} (${Math.round(performance.now() - t0)} ms)`);
}

// ── the tests ────────────────────────────────────────────────────────────────
export async function run({ quick = false } = {}) {
  const fails = [];
  let n = 0;
  const t0 = performance.now();
  const ok = (cond, what) => { n++; if (!cond) fails.push(what); };
  const log = (...a) => console.log("[qcut]", ...a);

  // 1. tile codecs on their own
  {
    const W = 300, H = 200, c = await make("alpha", W, H), px = pixelsOf(c);
    ok(eq(qoiDecode(qoiEncode(px, W * H), W * H), px), "QOI round trip");
    // PRED+ANS: the wasm and JS coders write the same bytes and read each other's
    const wasm = await wasmCodec();
    ok(!!wasm, "PRED+ANS wasm module loads");
    const g = px.filter((_, i) => i % 4 === 1), op = px.slice(); for (let i = 3; i < op.length; i += 4) op[i] = 255;
    for (const [what, data, ch, w, h] of [["RGBA", px, 4, W, H], ["opaque", op, 4, W, H], ["1 channel", g, 1, W, H], ["photo", pixelsOf(await make("photo", 257, 129)), 4, 257, 129], ["1×1", px.subarray(0, 4), 4, 1, 1], ["1×9", g.subarray(0, 9), 1, 1, 9]]) {
      const js = ansEncodeJS(data, w, h, ch), wa = await ansEncode(data, w, h, ch);
      ok(eq(js, wa), `PRED+ANS ${what}: wasm and JS encoders agree`);
      ok(eq(ansDecodeJS(wa, w, h, ch), data), `PRED+ANS ${what}: JS decodes`);
      ok(eq(await ansDecode(js, w, h, ch), data), `PRED+ANS ${what}: wasm decodes`);
    }
    // with WebAssembly off, tiles are written and read by the JS coder, and stay interchangeable
    {
      const ph = pixelsOf(await make("photo", 300, 200));
      await wasmCodec(false);
      const r = await encodeTile(ph.slice(), 300, 200, 4), back = await decodeTile(r.codec, r.value, r.bytes, 300, 200, 4, r.crc);
      await wasmCodec(true);
      ok(r.codec === C_ANS && eq(back, ph) && eq(await decodeTile(r.codec, r.value, r.bytes, 300, 200, 4, r.crc), ph), "no-wasm fallback: JS-written tile reads back with and without wasm");
    }
    // both decoders reject the same damage (bit flips, truncation, junk), never crash or loop
    {
      const enc = ansEncodeJS(pixelsOf(await make("photo", 64, 48)), 64, 48, 4);
      let agree = 0, n2 = quick ? 100 : 600;
      for (let k = 0; k < n2; k++) {
        let x = enc.slice();
        if (k % 3 === 0) x[(rnd() * x.length) | 0] ^= 1 << ((rnd() * 8) | 0);
        else if (k % 3 === 1) x = x.subarray(0, (rnd() * x.length) | 0);
        else for (let i = 2 + ((rnd() * 40) | 0); i < x.length; i += 1 + ((rnd() * 50) | 0)) x[i] = (rnd() * 256) | 0;
        let a = null, b = null;
        try { a = ansDecodeJS(x, 64, 48, 4); } catch (e) { a = e; }
        try { b = await ansDecode(x, 64, 48, 4); } catch (e) { b = e; }
        const errA = a instanceof qcut.QcutError, errB = b instanceof qcut.QcutError;
        if ((errA && errB) || (!errA && !errB && eq(a, b))) agree++;
        else ok(false, `PRED+ANS damage #${k}: JS ${errA ? a.message : "ok"} / wasm ${errB ? b.message : "ok"}`);
        if (a && !errA && !(a instanceof Uint8Array)) ok(false, `PRED+ANS damage #${k}: JS threw ${a}`);
      }
      ok(agree === n2, `PRED+ANS decoders agree on ${agree}/${n2} damaged tiles`);
    }
    for (const [what, data] of [["noise", px], ["flat", new Uint8Array(W * H * 4).fill(9)], ["photo", pixelsOf(await make("photo", W, H))], ["ui", pixelsOf(await make("ui", W, H))]]) {
      const r = await encodeTile(data.slice(), W, H, 4);
      const back = await decodeTile(r.codec, r.value, r.bytes, W, H, 4, r.crc);
      ok(eq(back, data), `tile ${what} (codec ${r.codec}) round trip`);
      const fast = await encodeTile(data.slice(), W, H, 4, { mode: "fast" });
      ok(fast.codec === C_RAW || fast.codec === C_SOLID, `fast mode stores raw (${what})`);
    }
    // a decoder fed garbage fails cleanly (QcutError), never loops or reads out of bounds
    for (const codec of [C_QOI, C_ANS, C_RAW]) {
      for (let k = 0; k < 20; k++) {
        const junk = new Uint8Array(1 + ((rnd() * 4000) | 0)).map(() => (rnd() * 256) | 0);
        await expectFail(ok, `garbage tile codec ${codec} #${k}`, () => decodeTile(codec, 0, junk, 64, 64, 4, 0));
      }
    }
    await expectFail(ok, "unknown tile codec", () => decodeTile(77, 0, new Uint8Array(4), 4, 4, 4, 0), ["unsupported"]);
    await expectFail(ok, "REF is not a tile codec on its own", () => decodeTile(C_REF, 0, new Uint8Array(4), 4, 4, 4, 0), ["unsupported"]);
  }

  // 2. round trips: every content type, odd sizes, canvas / ImageData / 1-channel sources
  const sizes = quick ? [[1920, 1080]] : [[1920, 1080], [513, 257], [1, 1], [1000, 1], [1, 700], [4000, 3000]];
  const codecsSeen = new Set();
  for (const [W, H] of sizes) {
    for (const type of W * H > 5e6 ? ["photo", "sparse"] : ["photo", "ui", "sparse", "text", "alpha"]) {
      const c = await make(type, W, H), want = pixelsOf(c);
      const blob = await qcut.write({ type: "photo", doc: { layers: [{ name: type, px: c }] } });
      const f = await qcut.read(blob);
      const ref = f.doc.layers[0].px;
      ok(ref instanceof qcut.Ref && ref.width === W && ref.height === H && ref.channels === 4, `${type} ${W}x${H}: ref`);
      const img = await ref.load();
      ok(img instanceof ImageData && eq(viaCanvas(img), want), `${type} ${W}x${H}: pixel-identical (ImageData put into a canvas)`);
      const into = new OffscreenCanvas(W, H);
      let tiles = 0;
      await ref.load({ into, onTile: () => tiles++ });
      ok(eq(pixelsOf(into), want), `${type} ${W}x${H}: pixel-identical (drawn into a canvas)`);
      ok(tiles === Math.ceil(W / 512) * Math.ceil(H / 512), `${type} ${W}x${H}: onTile per tile`);
      // which codecs were chosen
      const u8 = new Uint8Array(await blob.arrayBuffer()), h = parseHead(u8), pc = h.chunks[0], dv = new DataView(u8.buffer, pc.off);
      for (let i = 0; i < dv.getUint32(12, true); i++) codecsSeen.add(u8[pc.off + 16 + i * 16 + 12]);
    }
  }
  ok(codecsSeen.has(C_SOLID) && codecsSeen.has(C_QOI) && codecsSeen.has(C_ANS), `codecs used: ${[...codecsSeen]}`);
  {
    // raw ImageData with values a canvas can't hold (alpha 0 with colour) survive byte for byte
    const W = 700, H = 600, id = new ImageData(W, H);
    for (let i = 0; i < id.data.length; i++) id.data[i] = (rnd() * 256) | 0;
    for (let i = 3; i < id.data.length; i += 16) id.data[i] = 0;
    const g1 = { width: 333, height: 222, channels: 1, data: new Uint8Array(333 * 222).map((_, i) => (i * 13) & 255) };
    const blob = await qcut.write({ type: "photo", doc: { a: id, m: g1, solid: new ImageData(1024, 1024) } });
    const all = await (await qcut.read(blob)).loadAll();
    ok(eq(new Uint8Array(all.a.data.buffer), new Uint8Array(id.data.buffer)), "ImageData source: byte-identical");
    ok(all.m.channels === 1 && all.m.width === 333 && eq(all.m.data, g1.data), "1-channel source: byte-identical");
    ok(all.solid.data.every((v) => v === 0), "empty layer: all transparent");
    const empty = await qcut.write({ type: "photo", doc: { solid: new ImageData(4096, 4096) } });
    ok(empty.size < 2000, `empty 4096² layer costs ~nothing (solid tiles): ${empty.size} bytes`);
    // encodePixels result can be cached and reused; writeSync (page closing) round-trips too
    const c = await make("text", 900, 700), want = pixelsOf(c), e = await qcut.encodePixels(c);
    const b2 = await qcut.write({ type: "photo", doc: { x: e, y: e } }), all2 = await (await qcut.read(b2)).loadAll();
    ok(eq(viaCanvas(all2.x), want) && eq(viaCanvas(all2.y), want), "EncodedPixels reused");
    const b3 = qcut.writeSync({ type: "photo", doc: { x: c, arr: new Float32Array([1.5, -2]), f: new File(["hi"], "a.txt") } });
    const all3 = await (await qcut.read(b3)).loadAll();
    ok(eq(viaCanvas(all3.x), want) && all3.arr[1] === -2 && (await all3.f.text()) === "hi", "writeSync round trip");
    // a canvas changed right after write() starts doesn't tear the saved layer
    const live = await make("ui", 1500, 1100), before = pixelsOf(live);
    const p = qcut.write({ type: "photo", doc: { x: live } });
    live.getContext("2d").fillRect(0, 0, 1500, 1100);
    const all4 = await (await qcut.read(await p)).loadAll();
    ok(eq(viaCanvas(all4.x), before), "snapshot at write(): later drawing doesn't leak in");
  }

  // 3. the doc: JSON, files, arrays, preview
  const base = await (async () => {
    const c = await make("text", 1200, 900);
    const src = new File([new Uint8Array(5000).map((_, i) => i & 255)], "source.jpg", { type: "image/jpeg", lastModified: 1700000000000 });
    const doc = { name: "Poster", w: 1200, h: 900, layers: [{ id: 1, kind: "image", px: c, x: -3.5, opacity: 0.8, blend: "multiply", src }, { id: 2, kind: "text", text: { s: "Hi ✓", size: 40 } }], keys: new Float64Array([0, 1.25, 2.5]), wave: new Float32Array(1000).map((_, i) => Math.sin(i)), raw: new Uint8Array([1, 2, 3]).buffer, nested: [[1, [2, { a: null }]]], when: new Date(0), skip: undefined };
    const pv = await preview(c);
    const blob = await qcut.write({ type: "photo", doc, preview: pv });
    return { c, src, doc, pv, blob };
  })();
  {
    const f = await qcut.read(base.blob);
    ok(f.type === "photo" && f.version.major === qcut.VERSION.major && qcut.VERSION.major === 2, "type and version");
    const pv = await f.preview();
    ok(pv && pv.type === "image/webp" && eq(new Uint8Array(await pv.arrayBuffer()), new Uint8Array(await base.pv.arrayBuffer())), "preview bytes");
    const all = await f.loadAll();
    ok(all.name === "Poster" && all.layers[0].x === -3.5 && all.layers[0].blend === "multiply" && all.layers[1].text.s === "Hi ✓", "JSON fields");
    ok(all.layers[0].src instanceof File && all.layers[0].src.name === "source.jpg" && all.layers[0].src.type === "image/jpeg" && all.layers[0].src.lastModified === 1700000000000 && eq(new Uint8Array(await all.layers[0].src.arrayBuffer()), new Uint8Array(await base.src.arrayBuffer())), "File kept byte for byte with name/type/date");
    ok(all.keys instanceof Float64Array && eq(new Uint8Array(all.keys.buffer), new Uint8Array(base.doc.keys.buffer)), "Float64Array");
    ok(all.wave instanceof Float32Array && eq(new Uint8Array(all.wave.buffer), new Uint8Array(base.doc.wave.buffer)), "Float32Array");
    ok(all.raw instanceof ArrayBuffer && eq(new Uint8Array(all.raw), new Uint8Array([1, 2, 3])), "ArrayBuffer");
    ok(JSON.stringify(all.nested) === JSON.stringify([[1, [2, { a: null }]]]) && all.when === "1970-01-01T00:00:00.000Z" && !("skip" in all), "nested / Date / undefined");
    ok(eq(viaCanvas(all.layers[0].px), pixelsOf(base.c)), "layer pixels in doc");
    // video source link: fingerprint is stable, changes with the content, reads only ~3 MiB of a big file
    const big = new Uint8Array(9 * 2 ** 20).map((_, i) => (i * 31) & 255), fA = new File([big], "clip.mp4", { type: "video/mp4", lastModified: 1 });
    const big2 = big.slice(); big2[big2.length - 5] ^= 1;
    const [a1, a2, b1] = await Promise.all([qcut.fingerprint(fA), qcut.fingerprint(new File([big], "renamed.mp4")), qcut.fingerprint(new File([big2], "clip.mp4"))]);
    ok(a1.hash === a2.hash && a1.hash !== b1.hash && a1.hash.startsWith("sha256:") && a1.size === big.length && a1.name === "clip.mp4", "fingerprint");
    ok(await qcut.sniff(base.blob) &&!(await qcut.sniff(new Blob(["hello world, not a project file at all!!!!!!"]))), "sniff");
    // writer rejects what it can't store
    for (const [what, doc] of [["Map", { m: new Map() }], ["$c key", { $c: 1 }], ["class", { x: new (class Foo {})() }], ["DataView", { d: new DataView(new ArrayBuffer(4)) }]]) {
      let threw = false; try { await qcut.write({ type: "photo", doc }); } catch (e) { threw = e instanceof TypeError; }
      ok(threw, `write rejects ${what}`);
    }
  }

  // 4. versions and forward compatibility
  const u8 = new Uint8Array(await base.blob.arrayBuffer());
  {
    const v2 = u8.slice(); new DataView(v2.buffer).setUint16(8, 3, true);
    await expectFail(ok, "major 3", () => qcut.read(blobOf(fixHeadCrc(v2))), ["newer"]);
    const v1 = u8.slice(); new DataView(v1.buffer).setUint16(8, 1, true);
    await expectFail(ok, "major 1 (pre-release format)", () => qcut.read(blobOf(fixHeadCrc(v1))), ["unsupported"]);
    const v0 = u8.slice(); new DataView(v0.buffer).setUint16(8, 0, true);
    await expectFail(ok, "major 0", () => qcut.read(blobOf(fixHeadCrc(v0))), ["unsupported"]);
    const req = u8.slice(); new DataView(req.buffer).setUint32(12, 1, true);
    await expectFail(ok, "unknown required feature", () => qcut.read(blobOf(fixHeadCrc(req))), ["newer"]);
    const minor = u8.slice(); new DataView(minor.buffer).setUint16(10, 99, true);
    const fm = await qcut.read(blobOf(fixHeadCrc(minor)));
    ok(fm.version.minor === 99 && eq(viaCanvas(await fm.doc.layers[0].px.load()), pixelsOf(base.c)), "newer minor reads fine");
    // unknown meta fields are ignored; an unknown chunk type is fine until something loads it
    const h = parseHead(u8);
    const extra = withMeta(u8, { ...h.meta, future: { x: 1 }, doc: { ...h.meta.doc, newField: [1, 2] } });
    ok((await (await qcut.read(blobOf(extra))).loadAll()).newField[1] === 2, "unknown meta fields kept/ignored");
    const ut = u8.slice(), tk = h.chunks.findIndex((c) => c.type === 1 && c.len === 5000);
    ut[h.chunks[tk].e + 20] = 9;
    const fu = await qcut.read(blobOf(fixHeadCrc(ut)));
    const r9 = fu.refs.find((r) => r.index === tk);
    await expectFail(ok, "unknown chunk type on load", () => r9.load(), ["unsupported"]);
    ok(eq(viaCanvas(await fu.doc.layers[0].px.load()), pixelsOf(base.c)), "other chunks still load next to an unknown one");
    const ue = u8.slice(); ue[h.chunks[tk].e + 21] = 7;
    await expectFail(ok, "unknown byte encoding", async () => (await qcut.read(blobOf(fixHeadCrc(ue)))).refs.find((r) => r.index === tk).load(), ["unsupported"]);
  }

  // 5. corrupt, truncated and hostile files
  {
    await expectFail(ok, "empty", () => qcut.read(new Blob([])), ["not-qcut"]);
    await expectFail(ok, "text file", () => qcut.read(new Blob(["x".repeat(100)])), ["not-qcut"]);
    await expectFail(ok, "PNG file", async () => qcut.read(await base.c.convertToBlob()), ["not-qcut"]);
    await expectFail(ok, "magic only", () => qcut.read(blobOf(u8.slice(0, 20))), ["truncated"]);
    // truncation at every structural boundary and at random points
    const h = parseHead(u8), cuts = new Set([39, 40, 41, h.metaAt, h.metaAt + 1, h.metaAt + h.J - 1, h.metaAt + h.J, u8.length - 1]);
    for (const c of h.chunks) { cuts.add(c.off); cuts.add(c.off + 1); cuts.add(c.off + c.len - 1); }
    for (let k = 0; k < (quick ? 10 : 40); k++) cuts.add(40 + ((rnd() * (u8.length - 41)) | 0));
    for (const at of cuts) await expectFail(ok, `truncated at ${at}`, () => fullLoad(blobOf(u8.slice(0, at))), ["truncated", "corrupt", "not-qcut"]);
    // single-bit flips anywhere: always caught (every byte is covered by a CRC or a check)
    let flips = 0;
    for (let k = 0; k < (quick ? 40 : 300); k++) {
      const x = u8.slice(), at = (rnd() * x.length) | 0;
      x[at] ^= 1 << ((rnd() * 8) | 0);
      let err = null, res = null;
      try { res = await fullLoad(blobOf(x)); } catch (e) { err = e; }
      if (err) { ok(err instanceof qcut.QcutError, `bit flip at ${at}: ${err.name} ${err.message}`); flips++; }
      else ok(false, `bit flip at ${at} went unnoticed`);
      void res;
    }
    log(`bit flips caught: ${flips}`);
    // appended junk / wrong total length
    const junk = new Uint8Array(u8.length + 10); junk.set(u8);
    await expectFail(ok, "appended junk", () => qcut.read(blobOf(junk)), ["corrupt"]);
    // hostile index values with a valid CRC (so they reach the deeper checks)
    const set = (fn) => { const x = u8.slice(); fn(new DataView(x.buffer), x); return blobOf(fixHeadCrc(x)); };
    const set2 = (fn) => { const x = u8.slice(); fn(new DataView(x.buffer), x); return blobOf(x); };
    await expectFail(ok, "huge chunk count", () => qcut.read(set2((dv) => dv.setUint32(16, 0xffffffff, true))), ["corrupt"]);
    await expectFail(ok, "huge meta length", () => qcut.read(set2((dv) => dv.setUint32(20, 0xffffffff, true))), ["corrupt"]);
    await expectFail(ok, "file length 2^60", () => qcut.read(set2((dv) => dv.setBigUint64(24, 2n ** 60n, true))), ["corrupt", "truncated"]);
    await expectFail(ok, "chunk offset past the end", () => qcut.read(set((dv) => dv.setBigUint64(40, 2n ** 40n, true))), ["corrupt"]);
    await expectFail(ok, "chunk length past the end", () => qcut.read(set((dv) => dv.setBigUint64(48, 2n ** 33n, true))), ["corrupt"]);
    await expectFail(ok, "chunk inside the index", () => qcut.read(set((dv) => dv.setBigUint64(40, 0n, true))), ["corrupt"]);
    await expectFail(ok, "overlapping chunks", () => qcut.read(set((dv) => dv.setBigUint64(40 + 32, dv.getBigUint64(40, true), true))), ["corrupt"]);
    const hm = h.meta;
    const mk = (meta) => blobOf(withMeta(u8, meta));
    await expectFail(ok, "ref out of range", () => qcut.read(mk({ ...hm, doc: { a: { $c: 999 } } })), ["corrupt"]);
    await expectFail(ok, "ref not an integer", () => qcut.read(mk({ ...hm, doc: { a: { $c: "0" } } })), ["corrupt"]);
    const pxi = h.chunks.findIndex((c) => c.type === 2);
    await expectFail(ok, "layer size lies", () => qcut.read(mk({ ...hm, doc: { a: { $c: pxi, w: 1201, h: 900, ch: 4 } } })), ["corrupt"]);
    await expectFail(ok, "layer size huge", () => qcut.read(mk({ ...hm, doc: { a: { $c: pxi, w: 1e9, h: 1e9, ch: 4 } } })), ["corrupt"]);
    await expectFail(ok, "bad array type", () => qcut.read(mk({ ...hm, doc: { a: { $c: 0, as: "Function" } } })), ["corrupt"]);
    let deep = "1"; for (let i = 0; i < 200; i++) deep = `[${deep}]`;
    await expectFail(ok, "deep nesting", () => qcut.read(mk({ ...hm, doc: JSON.parse(deep) })), ["corrupt"]);
    {
      const evil = new TextEncoder().encode(JSON.stringify({ ...hm, doc: { a: 1 } }).replace('"doc":{"a":1}', '"doc":{"a":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"p2":1}}}'));
      const x = withMeta(u8, hm); const h2 = parseHead(x);
      const y = new Uint8Array(x.length - h2.J + evil.length); y.set(x.subarray(0, h2.metaAt)); y.set(evil, h2.metaAt); y.set(x.subarray(h2.metaAt + h2.J), h2.metaAt + evil.length);
      const dv = new DataView(y.buffer), shift = evil.length - h2.J; dv.setUint32(20, evil.length, true); dv.setBigUint64(24, BigInt(y.length), true);
      for (const c of h2.chunks) dv.setBigUint64(c.e, BigInt(c.off + shift), true);
      const f = await qcut.read(blobOf(fixHeadCrc(y)));
      ok(f.doc.a === 1 && !Object.prototype.hasOwnProperty.call(f.doc, "__proto__") && ({}).polluted === undefined && Object.getPrototypeOf(f.doc) === Object.prototype && !Object.prototype.hasOwnProperty.call(f.doc, "constructor"), "__proto__/constructor keys dropped");
    }
    // a pixel directory that lies (valid directory CRC, so the tile checks must catch it)
    const pc = h.chunks[pxi];
    const dirEdit = (fn) => { const x = u8.slice(), dv = new DataView(x.buffer, pc.off); fn(dv, x); const n2 = dv.getUint32(12, true), len = Math.min(16 + 16 * n2, pc.len); const crc = crc32(x.subarray(pc.off, pc.off + len)); new DataView(x.buffer).setUint32(pc.e + 16, crc, true); return blobOf(fixHeadCrc(x)); };
    const loadPx = (b) => async () => (await qcut.read(b)).refs.find((r) => r.kind === "pixels").load();
    let ti = 0; while (u8[pc.off + 16 + ti * 16 + 12] === C_SOLID) ti++;
    const te = 16 + ti * 16; // a tile with data
    await expectFail(ok, "dir width lies", loadPx(dirEdit((dv) => dv.setUint32(0, 5000, true))), ["corrupt"]);
    await expectFail(ok, "dir tile count lies", loadPx(dirEdit((dv) => dv.setUint32(12, 1, true))), ["corrupt"]);
    await expectFail(ok, "dir tile size 2^30", loadPx(dirEdit((dv, x) => { x[pc.off + 9] = 30; })), ["corrupt"]);
    await expectFail(ok, "tile offset past the layer", loadPx(dirEdit((dv) => dv.setUint32(te, 0x7fffffff, true))), ["corrupt"]);
    await expectFail(ok, "tile length huge", loadPx(dirEdit((dv) => dv.setUint32(te + 4, 0x7fffffff, true))), ["corrupt"]);
    await expectFail(ok, "unknown tile codec", loadPx(dirEdit((dv, x) => { x[pc.off + te + 12] = 200; })), ["unsupported"]);
    await expectFail(ok, "tile pixel CRC wrong", loadPx(dirEdit((dv) => dv.setUint32(te + 8, dv.getUint32(te + 8, true) ^ 1, true))), ["corrupt"]);
    // zip bomb: a tile whose deflate stream would inflate to 64 MiB stops at the tile size
    {
      const W = 512, H = 512, small = await qcut.write({ type: "photo", doc: { a: await make("photo", W, H) } });
      const x = new Uint8Array(await small.arrayBuffer()), hh = parseHead(x), c = hh.chunks[0], dv = new DataView(x.buffer, c.off);
      const bomb = await deflate(new Uint8Array(64 * 2 ** 20));
      const tileOff = c.off + 16 + 16;
      const y = new Uint8Array(tileOff + bomb.length); y.set(x.subarray(0, tileOff)); y.set(bomb, tileOff);
      const dy = new DataView(y.buffer);
      dy.setUint32(c.off + 16 + 4, bomb.length, true); y[c.off + 16 + 12] = C_QOI;
      dy.setBigUint64(c.e + 8, BigInt(16 + 16 + bomb.length), true); dy.setBigUint64(24, BigInt(y.length), true);
      dy.setUint32(c.e + 16, crc32(y.subarray(c.off, c.off + 32)), true);
      void dv;
      const t1 = performance.now();
      await expectFail(ok, "zip bomb tile", loadPx(blobOf(fixHeadCrc(y))), ["corrupt"]);
      ok(performance.now() - t1 < 3000, `zip bomb stopped fast (${Math.round(performance.now() - t1)} ms)`);
    }
  }
  // 6. never redo work: incremental saves, shared tiles, prioritised open; typed-array encodings
  {
    const tileBytes = async (e, i) => { const t = e.tiles[i], d = 16 + 16 * e.tiles.length; return new Uint8Array(await e.blob.slice(d + t.off, d + t.off + t.len).arrayBuffer()); };
    const W = 1600, H = 1100, c = await make("photo", W, H);
    let t = performance.now();
    const e1 = await qcut.encodePixels(c);
    const tFull = performance.now() - t;
    t = performance.now();
    const e2 = await qcut.encodePixels(c);
    const tSame = performance.now() - t;
    ok(eq(new Uint8Array(await e2.blob.arrayBuffer()), new Uint8Array(await e1.blob.arrayBuffer())), "unchanged canvas: identical encoding");
    log(`incremental: full encode ${Math.round(tFull)} ms, unchanged ${Math.round(tSame)} ms`);
    c.getContext("2d").fillStyle = "#e02"; c.getContext("2d").fillRect(600, 100, 40, 40); // inside tile 1 only
    const e3 = await qcut.encodePixels(c), back = await (await qcut.read(await qcut.write({ type: "photo", doc: { x: e3 } }))).doc.x.load();
    ok(eq(viaCanvas(back), pixelsOf(c)), "incremental: edited canvas round-trips");
    let reused = 0;
    for (let i = 0; i < e3.tiles.length; i++) if (i !== 1 && eq(await tileBytes(e3, i), await tileBytes(e1, i)) && e3.tiles[i].codec === e1.tiles[i].codec) reused++;
    ok(reused === e3.tiles.length - 1 && !eq(await tileBytes(e3, 1), await tileBytes(e1, 1)), `incremental: only the changed tile re-encoded (${reused}/${e3.tiles.length - 1} kept)`);
    // rev: the caller's version number skips reading pixels
    const r1 = await qcut.encodePixels(c, { rev: 7 }), r2 = await qcut.encodePixels(c, { rev: 7 });
    ok(r1 === r2, "same rev: last encoding returned as is");
    c.getContext("2d").fillRect(0, 0, 10, 10);
    const r3 = await qcut.encodePixels(c, { rev: 8 });
    ok(r3 !== r1 && eq(viaCanvas(await (await qcut.read(await qcut.write({ type: "photo", doc: { x: r3 } }))).doc.x.load()), pixelsOf(c)), "new rev: changes picked up");
    const viaWrite = await qcut.write({ type: "photo", doc: { x: c } }, { rev: () => 8 });
    ok(viaWrite.size < W * H * 4 / 2, "write({rev}) reuses the encoding");
    // a weaker earlier encoding is never reused for a stronger mode
    const id = new ImageData(W, H); id.data.set(pixelsOf(c));
    const ef = await qcut.encodePixels(id, { mode: "fast" }), eb = await qcut.encodePixels(id);
    ok(ef.tiles.every((x) => x.codec === C_RAW || x.codec === C_SOLID) && eb.tiles.some((x) => x.codec === C_ANS), "fast encoding not reused for best");
    // quick mode (autosave) round-trips; writeSync reuses an up-to-date compressed encoding
    const qb = await qcut.write({ type: "photo", doc: { x: await make("text", 900, 700) } }, { mode: "quick" });
    ok(eq(viaCanvas((await (await qcut.read(qb)).loadAll()).x), pixelsOf(await make("text", 900, 700))), "quick mode round trip");
    const ws = qcut.writeSync({ type: "photo", doc: { x: c } });
    ok(ws.size < W * H * 4 / 2 && eq(viaCanvas(await (await qcut.read(ws)).doc.x.load()), pixelsOf(c)), `writeSync reuses the compressed tiles (${ws.size} bytes)`);
  }
  {
    // shared tiles: the same layer twice, and a repeated tile inside one layer, are stored once
    const c = await make("photo", 1024, 1024), want = pixelsOf(c);
    const one = await qcut.write({ type: "photo", doc: { a: c } }), two = await qcut.write({ type: "photo", doc: { a: c, b: c } });
    ok(two.size < one.size + 1000, `same layer twice costs ~nothing (${one.size} → ${two.size})`);
    const all = await (await qcut.read(two)).loadAll();
    ok(eq(viaCanvas(all.a), want) && eq(viaCanvas(all.b), want), "shared tiles round trip");
    const d = await make("photo", 1024, 1024), g = d.getContext("2d");
    g.putImageData(g.getImageData(0, 0, 512, 512), 512, 512);
    const rb = await qcut.write({ type: "photo", doc: { a: d } }), ru8 = new Uint8Array(await rb.arrayBuffer()), rh = parseHead(ru8), rc = rh.chunks[0];
    ok(ru8[rc.off + 16 + 3 * 16 + 12] === C_REF && eq(viaCanvas(await (await qcut.read(rb)).doc.a.load()), pixelsOf(d)), "repeated tile inside a layer: shared and exact");
    // hostile shared-tile entries (valid directory CRC): each must fail cleanly
    const crop = new OffscreenCanvas(700, 700); crop.getContext("2d").drawImage(c, 0, 0);
    const hb = await qcut.write({ type: "photo", doc: { f: new Blob(["x".repeat(100)]), a: c, b: crop } });
    const hu = new Uint8Array(await hb.arrayBuffer()), hh = parseHead(hu), pcs = hh.chunks.map((x, i) => i).filter((i) => hh.chunks[i].type === 2);
    const [ia, ib] = pcs, bc = hh.chunks[ib], fi = hh.chunks.findIndex((x) => x.type === 1);
    ok(hu[bc.off + 16 + 12] === C_REF, "cropped layer shares its first tile");
    const refEdit = (tile, rcIdx, rt, codec = C_REF) => {
      const x = hu.slice(), dv = new DataView(x.buffer, bc.off), e = 16 + tile * 16;
      dv.setUint32(e, rcIdx, true); dv.setUint32(e + 4, rt, true); x[bc.off + e + 12] = codec;
      const n2 = dv.getUint32(12, true); new DataView(x.buffer).setUint32(bc.e + 16, crc32(x.subarray(bc.off, bc.off + 16 + 16 * n2)), true);
      return blobOf(fixHeadCrc(x));
    };
    const loadB = (b) => async () => (await qcut.read(b)).doc.b.load();
    ok(eq(viaCanvas(await (await qcut.read(refEdit(0, ia, 0))).doc.b.load()), pixelsOf(crop)), "REF edit helper keeps a valid file valid");
    await expectFail(ok, "REF to itself", loadB(refEdit(0, ib, 0)), ["corrupt"]);
    await expectFail(ok, "REF forward in the same layer", loadB(refEdit(0, ib, 2)), ["corrupt"]);
    await expectFail(ok, "REF to a later layer", loadB(refEdit(0, ib + 1, 0)), ["corrupt"]);
    await expectFail(ok, "REF to a bytes chunk", loadB(refEdit(0, fi, 0)), ["corrupt"]);
    await expectFail(ok, "REF chunk out of range", loadB(refEdit(0, 0xffffffff, 0)), ["corrupt"]);
    await expectFail(ok, "REF tile out of range", loadB(refEdit(0, ia, 99)), ["corrupt"]);
    await expectFail(ok, "REF to a tile of another size", loadB(refEdit(1, ia, 0)), ["corrupt"]);
    await expectFail(ok, "REF to a REF", loadB(refEdit(2, ib, 0)), ["corrupt"]);
    await expectFail(ok, "REF to a tile with other pixels", loadB(refEdit(0, ia, 1)), ["corrupt"]);
    // prioritised open: the tile under `focus` lands first
    // (one worker, so tiles finish in the order they are sent)
    const f = await qcut.read(two), order = [], before = qcut.configure().workers;
    qcut.configure({ workers: 1 });
    try { await f.doc.a.load({ focus: { x: 700, y: 900, w: 10, h: 10 }, onTile: (x, y) => order.push(`${x},${y}`) }); }
    finally { qcut.configure({ workers: before }); }
    ok(order[0] === "512,512" && order.length === 4, `focus tile decoded first (${order})`);
  }
  {
    // typed arrays: byte-delta + byte planes when that is smaller; exact round trip for every type
    const keys = new Float64Array(3000).map((_, i) => i * 2.002 + (i % 7 === 0 ? 0.5 : 0)), peaks = new Float32Array(20000).map((_, i) => Math.abs(Math.sin(i / 50)) * 0.8);
    const arrs = { keys, peaks, i16: new Int16Array(1001).map((_, i) => i * 3 - 900), big: new BigInt64Array([1n, -2n, 3n ** 30n]), odd: new Uint8Array([1, 2, 3]), buf: new Uint8Array(500).fill(7).buffer, tiny: new Float32Array([0.5]) };
    const b = await qcut.write({ type: "video", doc: arrs }), all = await (await qcut.read(b)).loadAll();
    for (const [k, v] of Object.entries(arrs)) {
      const got = all[k], gb = got instanceof ArrayBuffer ? new Uint8Array(got) : new Uint8Array(got.buffer, got.byteOffset, got.byteLength), wb = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      ok(got.constructor === v.constructor && eq(gb, wb), `array ${k} round trip`);
    }
    const u8 = new Uint8Array(await b.arrayBuffer()), h = parseHead(u8);
    const encOf = (i) => u8[h.chunks[i].e + 21];
    ok(encOf(0) === 4 && h.chunks[0].len < (await deflate(new Uint8Array(keys.buffer))).length * 0.7, `keyframe times: shuffled, ${h.chunks[0].len} bytes`);
    log(`arrays: keys ${keys.byteLength} → ${h.chunks[0].len}, peaks ${peaks.byteLength} → ${h.chunks[1].len}`);
  }

  const ms = Math.round(performance.now() - t0);
  log(`${n - fails.length}/${n} passed in ${ms} ms`);
  if (fails.length) console.warn("[qcut] FAILS", fails);
  return { pass: !fails.length, n, fails, ms };
}

// ── speed: a 4-layer document, .qcut against the PNG-per-layer sessions used before ──
export async function speed({ W = 4000, H = 3000, types = ["photo", "ui", "sparse", "text"], reps = 2 } = {}) {
  const layers = [];
  for (const t of types) layers.push({ name: t, c: await make(t, W, H) });
  const comp = new OffscreenCanvas(W, H), g = comp.getContext("2d");
  for (const l of layers) g.drawImage(l.c, 0, 0);
  const pv = await preview(comp);
  const copy = (c) => { const d = new OffscreenCanvas(W, H); d.getContext("2d").drawImage(c, 0, 0); return d; };
  const doc = (ls) => ({ name: "Bench", w: W, h: H, layers: ls.map((l) => ({ name: l.name, px: l.c })) });
  const rows = [];
  const best = (a, b) => (!a || b < a ? b : a);
  let q = {}, p = {};
  for (let r = 0; r < reps; r++) {
    // .qcut: first save (new canvases, nothing cached), then saves again
    const fresh = layers.map((l) => ({ name: l.name, c: copy(l.c) }));
    let t = performance.now();
    const blob = await qcut.write({ type: "photo", doc: doc(fresh), preview: pv });
    q.save = best(q.save, performance.now() - t); q.size = blob.size;
    t = performance.now(); await qcut.write({ type: "photo", doc: doc(fresh), preview: pv }); q["re-save, unchanged"] = best(q["re-save, unchanged"], performance.now() - t);
    await qcut.write({ type: "photo", doc: doc(fresh), preview: pv }, { rev: () => 1 }); // tags each layer with rev 1
    t = performance.now(); await qcut.write({ type: "photo", doc: doc(fresh), preview: pv }, { rev: () => 1 }); q["re-save, same rev"] = best(q["re-save, same rev"], performance.now() - t);
    fresh[0].c.getContext("2d").fillRect(100, 100, 300, 200); // a brush stroke's worth of change
    t = performance.now(); await qcut.write({ type: "photo", doc: doc(fresh), preview: pv }); q["re-save, 1 tile edited"] = best(q["re-save, 1 tile edited"], performance.now() - t);
    const stored = await storeIdb(blob), opfs = await storeOpfs(blob);
    for (const [where, get] of [["memory", async () => blob], ["IndexedDB", stored.get], ["OPFS", opfs.get]]) {
      t = performance.now();
      const b = await get(), f = await qcut.read(b), pb = await f.preview(), bm = await createImageBitmap(pb);
      const tPrev = performance.now() - t;
      const outs = layers.map(() => new OffscreenCanvas(W, H));
      await Promise.all(f.doc.layers.map((l, i) => l.px.load({ into: outs[i] })));
      outs[0].getContext("2d").getImageData(0, 0, 1, 1);
      const tOpen = performance.now() - t;
      bm.close();
      q["preview " + where] = best(q["preview " + where], tPrev); q["open " + where] = best(q["open " + where], tOpen);
    }
    t = performance.now(); await stored.put(blob); q.idbPut = best(q.idbPut, performance.now() - t);
    t = performance.now(); await opfs.put(blob); q.opfsPut = best(q.opfsPut, performance.now() - t);
    await stored.drop(); await opfs.drop();
    // before: one PNG per layer through a worker canvas (as the Continue session saves)
    t = performance.now();
    const pngs = await Promise.all(layers.map(async (l) => { const bm = await createImageBitmap(l.c); const c = new OffscreenCanvas(W, H); c.getContext("2d").drawImage(bm, 0, 0); return c.convertToBlob({ type: "image/png" }); }));
    p.save = best(p.save, performance.now() - t); p.size = pngs.reduce((s, b) => s + b.size, 0);
    t = performance.now();
    await Promise.all(pngs.map(async (b) => { const bm = await createImageBitmap(b); const c = new OffscreenCanvas(W, H); c.getContext("2d").drawImage(bm, 0, 0); c.getContext("2d").getImageData(0, 0, 1, 1); bm.close(); }));
    p.open = best(p.open, performance.now() - t);
  }
  const R = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === "size" ? +(v / 1e6).toFixed(2) + " MB" : Math.round(v) + " ms"]));
  rows.push({ what: `.qcut ${W}x${H} × ${types.length} layers`, ...R(q) }, { what: "PNG per layer (old sessions)", ...R(p) });
  console.table(rows);
  return rows;
}
/** One layer per content type and size: size as % of raw RGBA, save and open (drawn into a canvas) in ms, best of `reps`. */
export async function bench({ sizes = [[1920, 1080], [4000, 3000], [8000, 6000]], types = ["photo", "ui", "text", "sparse"], reps = 3, opts = {} } = {}) {
  const rows = [];
  for (const [W, H] of sizes) for (const type of types) {
    const c = await make(type, W, H);
    let save = Infinity, open = Infinity, size = 0;
    for (let r = 0; r < reps; r++) {
      const fresh = new OffscreenCanvas(W, H); fresh.getContext("2d").drawImage(c, 0, 0); // a new source each time: no incremental reuse
      let t = performance.now();
      const blob = await qcut.write({ type: "photo", doc: { px: fresh } }, opts);
      save = Math.min(save, performance.now() - t); size = blob.size;
      t = performance.now();
      const f = await qcut.read(blob), out = new OffscreenCanvas(W, H);
      await f.doc.px.load({ into: out });
      out.getContext("2d").getImageData(0, 0, 1, 1);
      open = Math.min(open, performance.now() - t);
    }
    rows.push({ what: `${type} ${W}x${H}`, pct: +(100 * size / (W * H * 4)).toFixed(2), save: Math.round(save), open: Math.round(open), bytes: size });
  }
  console.table(rows);
  return rows;
}
async function storeIdb(blob) {
  const db = await new Promise((res, rej) => { const r = indexedDB.open("qcut-test", 1); r.onupgradeneeded = () => r.result.createObjectStore("f"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = (mode, fn) => new Promise((res, rej) => { const t = db.transaction("f", mode), q = fn(t.objectStore("f")); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); });
  const put = (b) => tx("readwrite", (s) => s.put({ b }, 1));
  await put(blob);
  return { put, get: async () => (await tx("readonly", (s) => s.get(1))).b, drop: async () => { db.close(); await new Promise((r) => { const q = indexedDB.deleteDatabase("qcut-test"); q.onsuccess = q.onerror = q.onblocked = r; }); } };
}
async function storeOpfs(blob) {
  const root = await navigator.storage.getDirectory();
  const put = async (b) => { const fh = await root.getFileHandle("qcut-test.qcut", { create: true }), w = await fh.createWritable(); await w.write(b); await w.close(); };
  await put(blob);
  return { put, get: async () => (await root.getFileHandle("qcut-test.qcut")).getFile(), drop: () => root.removeEntry("qcut-test.qcut").catch(() => {}) };
}
