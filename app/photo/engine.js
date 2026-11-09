// QuickCut Photo engine: matrices, layer compositing and image header sniffing. Plain ES module
// used by the page (display) and by the worker (export), so both draw exactly the same picture.
// Compositing is canvas 2D on the GPU: most blend modes are `globalCompositeOperation`, the rest a
// WebGL2 pass; clipping groups and layer groups are composited in offscreen buffers.
import { composite as compositePx, compositeAtop, dissolveNoise } from "./blend.js";

// ── 2D affine matrices as [a, b, c, d, e, f] (same order as ctx.setTransform) ─────────────────
export const I = [1, 0, 0, 1, 0, 0];
export const mul = (A, B) => [
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
];
export const T = (x, y) => [1, 0, 0, 1, x, y];
export const S = (x, y = x) => [x, 0, 0, y, 0, 0];
export const R = (deg) => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, 0, 0]; };
export const ap = (A, x, y) => [A[0] * x + A[2] * y + A[4], A[1] * x + A[3] * y + A[5]];
export function inv(A) {
  const det = A[0] * A[3] - A[1] * A[2] || 1e-12;
  return [A[3] / det, -A[1] / det, -A[2] / det, A[0] / det, (A[2] * A[5] - A[3] * A[4]) / det, (A[1] * A[4] - A[0] * A[5]) / det];
}
export const isTranslate = (A) => Math.abs(A[0] - 1) < 1e-9 && Math.abs(A[3] - 1) < 1e-9 && Math.abs(A[1]) < 1e-9 && Math.abs(A[2]) < 1e-9;

// ── blend modes ─────────────────────────────────────────────────────────────
// Photoshop's full set, in its menu order (groups of the menu split by null). [id, label, short]
// Modes Canvas 2D has natively (the W3C formulas, which are Photoshop's) use
// `globalCompositeOperation`; the rest go through a small WebGL2 pass (GPU) with the formulas of
// blend.js (ported from PhotoCraft), or blend.js itself on the CPU when there's no WebGL2.
export const BLEND_MENU = [
  [["normal", "Normal", "Norm"], ["dissolve", "Dissolve", "Diss"]],
  [["darken", "Darken", "Dark"], ["multiply", "Multiply", "Mult"], ["color-burn", "Color Burn", "Burn"], ["linear-burn", "Linear Burn", "LBrn"], ["darker-color", "Darker Color", "Dkr"]],
  [["lighten", "Lighten", "Lite"], ["screen", "Screen", "Scrn"], ["color-dodge", "Color Dodge", "Dodg"], ["linear-dodge", "Linear Dodge (Add)", "Add"], ["lighter-color", "Lighter Color", "Ltr"]],
  [["overlay", "Overlay", "Ovr"], ["soft-light", "Soft Light", "Soft"], ["hard-light", "Hard Light", "Hard"], ["vivid-light", "Vivid Light", "Vivd"], ["linear-light", "Linear Light", "LLit"], ["pin-light", "Pin Light", "Pin"], ["hard-mix", "Hard Mix", "HMix"]],
  [["difference", "Difference", "Diff"], ["exclusion", "Exclusion", "Excl"], ["subtract", "Subtract", "Sub"], ["divide", "Divide", "Div"]],
  [["hue", "Hue", "Hue"], ["saturation", "Saturation", "Sat"], ["color", "Color", "Col"], ["luminosity", "Luminosity", "Lum"]],
];
export const PASS = ["pass", "Pass Through", "Pass"]; // groups only: the children blend straight into what's below
export const BLENDS = BLEND_MENU.flat();
const NATIVE = {
  normal: "source-over", darken: "darken", multiply: "multiply", "color-burn": "color-burn", lighten: "lighten", screen: "screen", "color-dodge": "color-dodge",
  overlay: "overlay", "soft-light": "soft-light", "hard-light": "hard-light", difference: "difference", exclusion: "exclusion",
  hue: "hue", saturation: "saturation", color: "color", luminosity: "luminosity",
};
// GPU modes: shader family (one program each, compiled on first use) and the mode number in it
const GPU = {
  "linear-burn": [0, 1], "linear-dodge": [0, 2], "vivid-light": [0, 3], "linear-light": [0, 4], "pin-light": [0, 5], "hard-mix": [0, 6], subtract: [0, 7], divide: [0, 8],
  "darker-color": [1, 9], "lighter-color": [1, 10], dissolve: [2, 11],
};
export const isNative = (m) => !!NATIVE[m];

/**
 * Layers and groups as a tree, in stacking order (bottom first). `items` are layers (bottom first,
 * each with `parent`: a group id or null); `groups` are {id, parent, blend, opacity, visible, clip, …}.
 * A group sits where its first layer is (a group without layers isn't drawn).
 */
export function tree(items, groups = []) {
  const G = new Map(), root = [], made = new Map();
  for (const g of groups) G.set(g.id, g);
  const into = (gid, depth = 0) => {
    const g = gid == null ? null : G.get(gid);
    if (!g || depth > 64) return root;
    let n = made.get(gid);
    if (!n) { n = { ...g, group: true, ref: g, children: [] }; made.set(gid, n); into(g.parent, depth + 1).push(n); }
    return n.children;
  };
  for (const it of items) into(it.parent).push(it);
  return root;
}

const shown = (n) => n.visible && n.opacity > 0 && (!n.group || n.children.length > 0);
/**
 * Draw layers (a flat list, or a `tree` with groups) into `out` (a 2D context) through the matrix
 * `M` (doc → target).
 * Layer: {src (drawable), x, y, m? (layer → doc matrix; replaces x, y: a smart layer's scale/rotation),
 *   opacity, blend, visible, clip, stroke?: {src, alpha, erase},
 *   mask?: {src (alpha = how much shows), sx?, sy? (src scale vs the layer), stroke?}}
 * Group: {group: true, children, opacity, blend ("pass" = pass through), visible, clip}
 * `buf(name)` returns a cleared target-sized 2D context for temporary work.
 * A clipped node is drawn only where its base (the nearest unclipped node below it in the same
 * group) has pixels; the base's opacity and blend mode then apply to the whole clipping group.
 * An isolated group composites its children on transparency, then blends as one layer; a
 * pass-through group's children blend straight into the backdrop.
 */
export function composite(out, layers, M, buf, { smooth = true } = {}) {
  const R = { M, Mi: inv(M), buf, smooth };
  stack(out, layers, R, 0);
  out.globalAlpha = 1;
  out.globalCompositeOperation = "source-over";
}
function stack(out, nodes, R, d) {
  for (let i = 0; i < nodes.length;) {
    const base = nodes[i], from = ++i;
    let vis = 0;
    while (i < nodes.length && nodes[i].clip) if (shown(nodes[i++])) vis++;
    if (!shown(base)) continue;
    if (!vis) { put(out, base, base.opacity, base.blend, R, d); continue; }
    // a clipping group: the base on its own, the clipped nodes atop it, then the whole as the base
    const g = R.buf("g" + d), pass = base.group && base.blend === "pass";
    const iso = pass ? R.buf("i" + d) : g;
    content(iso, base, R, d);
    if (pass) blit(g, iso.canvas, 1, "source-over");
    for (let c = from; c < i; c++) if (shown(nodes[c])) atop(g, nodes[c], R, d);
    if (!pass) { blend(out, g.canvas, base.opacity, base.blend, R); continue; }
    // pass-through base: its children go straight onto the backdrop; the clipped layers' effect
    // (the group alone with them minus without them, at the group's opacity) is added on top
    // (PhotoCraft composite.rs: exact when the children blend Normal, close otherwise)
    put(out, base, base.opacity, "pass", R, d);
    run(out, 3, [out.canvas, g.canvas, iso.canvas], { k: base.opacity });
  }
}
/** A node onto `out` with its opacity and blend mode. */
function put(out, n, alpha, mode, R, d) {
  if (n.group) {
    if (mode === "pass") return pass(out, n, alpha, R, d);
    const t = R.buf("i" + d);
    stack(t, n.children, R, d + 1);
    return blend(out, t.canvas, alpha, mode, R);
  }
  if (NATIVE[mode] || !GPU[mode]) return drawLayer(out, n, R, alpha, NATIVE[mode] || "source-over");
  const x = R.buf("x");
  drawLayer(x, n, R, 1, "source-over");
  blend(out, x.canvas, alpha, mode, R);
}
function pass(out, n, alpha, R, d) {
  if (alpha >= 1) return stack(out, n.children, R, d + 1);
  // below 100%: mix the result with the backdrop as it was (premultiplied: before·(1−k) + after·k)
  const before = R.buf("p" + d);
  blit(before, out.canvas, 1, "source-over");
  stack(out, n.children, R, d + 1);
  const after = R.buf("x");
  blit(after, out.canvas, 1, "source-over");
  out.setTransform(1, 0, 0, 1, 0, 0);
  out.globalAlpha = 1;
  out.globalCompositeOperation = "source-over";
  out.clearRect(0, 0, out.canvas.width, out.canvas.height);
  blit(out, before.canvas, 1 - alpha, "source-over");
  blit(out, after.canvas, alpha, "lighter");
}
/** A node at full strength onto an empty `ctx` (a group: its children on transparency). */
function content(ctx, n, R, d) {
  if (n.group) stack(ctx, n.children, R, d + 1);
  else drawLayer(ctx, n, R, 1, "source-over");
}
/** A clipped node onto its clipping group `g` (keeps g's alpha). */
function atop(g, c, R, d) {
  const mode = c.group && c.blend === "pass" ? "normal" : c.blend || "normal";
  if (!c.group && mode === "normal") return drawLayer(g, c, R, c.opacity, "source-atop");
  const t = R.buf("t" + d);
  content(t, c, R, d);
  if (mode === "normal") return blit(g, t.canvas, c.opacity, "source-atop");
  if (GPU[mode]) return run(g, GPU[mode][0], [g.canvas, t.canvas], { mode, alpha: c.opacity, atop: true, R });
  t.setTransform(1, 0, 0, 1, 0, 0);
  blit(t, g.canvas, 1, "destination-in");
  blit(g, t.canvas, c.opacity, NATIVE[mode] || "source-over");
}
/** `src` (target-sized) onto `out` with alpha and blend mode. */
function blend(out, src, alpha, mode, R) {
  if (NATIVE[mode] || !GPU[mode]) return blit(out, src, alpha, NATIVE[mode] || "source-over");
  run(out, GPU[mode][0], [out.canvas, src], { mode, alpha, atop: false, R });
}
function blit(ctx, src, alpha, gco) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = gco;
  ctx.drawImage(src, 0, 0);
}
function drawLayer(ctx, l, R, alpha, gco) {
  const { M, buf, smooth } = R;
  if (!l.stroke && !l.mask) { draw(ctx, l.src, place(M, l), alpha, gco, smooth); return; }
  const LM = mul(M, l.m || T(l.x, l.y));
  // layer + the stroke being painted (painted at full strength, applied with the brush opacity),
  // then its layer mask (alpha), then onto the target with the layer's opacity and blend mode
  const s = buf("s");
  draw(s, l.src, place(M, l), 1, "source-over", smooth);
  // a `screen` stroke is already in target pixels (drawn by the page at view resolution)
  if (l.stroke) draw(s, l.stroke.src, l.stroke.screen ? I : LM, l.stroke.alpha, l.stroke.erase ? "destination-out" : "source-over", smooth, "low");
  const mk = l.mask;
  if (mk) {
    const A = mul(LM, S(mk.sx || 1, mk.sy || 1));
    if (mk.stroke) {
      // a Keep/Remove stroke being painted on the mask
      const m = buf("m");
      draw(m, mk.src, A, 1, "source-over", smooth);
      draw(m, mk.stroke.src, mk.stroke.screen ? I : LM, mk.stroke.alpha, mk.stroke.erase ? "destination-out" : "source-over", smooth, "low");
      draw(s, m.canvas, I, 1, "destination-in", smooth);
    } else draw(s, mk.src, A, 1, "destination-in", smooth);
  }
  blit(ctx, s.canvas, alpha, gco);
}
/** Layer → target: its matrix (or offset), and `sx/sy` when `src` is a smaller copy (mip level) of the layer. */
const place = (M, l) => mul(mul(M, l.m || T(l.x, l.y)), S(l.sx || 1, l.sy || 1));
/** The larger of a matrix's two axis scales (how much one source pixel is stretched at most). */
export const scaleOf = (A) => Math.max(Math.hypot(A[0], A[1]), Math.hypot(A[2], A[3]));
/**
 * A copy of `src` small enough to be drawn at `scale` (≤ 0.5) without aliasing: halved with the
 * high-quality filter until one more halving would go below the drawn size. {src, sx, sy} (sx/sy:
 * how much bigger the original is), or null when `src` itself is right.
 */
export function reduced(src, scale) {
  if (!(scale < 0.5)) return null;
  let cur = src;
  while (cur.width / 2 >= src.width * scale && cur.height / 2 >= src.height * scale && cur.width > 2 && cur.height > 2) {
    const half = new OffscreenCanvas(Math.ceil(cur.width / 2), Math.ceil(cur.height / 2)), g = half.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(cur, 0, 0, half.width, half.height);
    if (cur !== src) { cur.width = 1; cur.height = 1; }
    cur = half;
  }
  return cur === src ? null : { src: cur, sx: src.width / cur.width, sy: src.height / cur.height };
}
function draw(ctx, src, A, alpha, gco, smooth, quality = "high") {
  ctx.setTransform(A[0], A[1], A[2], A[3], A[4], A[5]);
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = gco;
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = quality;
  ctx.drawImage(src, 0, 0);
}

// ── GPU pass (WebGL2): the blend modes Canvas 2D lacks ─────────────────────
// Inputs are target-sized canvases uploaded premultiplied (exact: that's how canvases store
// pixels); the result replaces `out` (big targets go in tiles). Families: 0 separable modes,
// 1 Darker/Lighter Color, 2 Dissolve, 3 the pass-through clipping sum.
const FS = `
precision highp float; precision highp int;
uniform sampler2D uB, uS, uI; uniform int uMode, uH, uAtop; uniform float uOp; uniform mat3 uMi; uniform ivec2 uOff;
out vec4 o;
vec3 unp(vec4 p) { return p.a > 0.0 ? p.rgb / p.a : vec3(0.0); }
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
float vivid(float b, float s) { return s <= 0.5 ? (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / (2.0 * s))) : (s >= 1.0 ? 1.0 : min(1.0, b / (2.0 * (1.0 - s)))); }
float vividG(float b, float s) {
  if (s <= 0.5) return b >= 1.0 - 1e-4 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / (2.0 * s));
  return b <= 1e-4 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (2.0 * (1.0 - s)));
}
float ch(float b, float s) {
  if (uMode == 1) return max(b + s - 1.0, 0.0);
  if (uMode == 2) return min(b + s, 1.0);
  if (uMode == 3) return vivid(b, s);
  if (uMode == 4) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
  if (uMode == 5) return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0);
  if (uMode == 6) return vividG(b, s) >= 0.5 - 1e-6 ? 1.0 : 0.0;
  if (uMode == 7) return max(b - s, 0.0);
  if (uMode == 8) return s <= 0.0 ? (b <= 0.0 ? 0.0 : 1.0) : min(b / s, 1.0);
  return s;
}
float noise(ivec2 q) {
  uint h = (uint(q.x) * 0x8da6b343u) ^ (uint(q.y) * 0xd8163841u) ^ 0x9e3779b9u;
  h ^= h >> 15u; h *= 0x2c1b3c6du; h ^= h >> 12u;
  return float(h & 0xffffu) / 65536.0;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); p.y = uH - 1 - p.y;
  vec4 bp = texelFetch(uB, p, 0), sp = texelFetch(uS, p, 0);
#if FAM == 3
  vec4 r = bp + uOp * (sp - texelFetch(uI, p, 0));
  float a = clamp(r.a, 0.0, 1.0);
  o = vec4(clamp(r.rgb, 0.0, a), a);
#else
  float ab = bp.a, as = sp.a * uOp;
  vec3 cb = unp(bp), cs = unp(sp), B;
#if FAM == 2
  vec3 d = uMi * vec3(vec2(p + uOff) + 0.5, 1.0);
  as = noise(ivec2(floor(d.xy))) < as ? 1.0 : 0.0;
  B = cs;
#elif FAM == 1
  B = uMode == 9 ? (lum(cs) < lum(cb) ? cs : cb) : (lum(cs) > lum(cb) ? cs : cb);
#else
  B = vec3(ch(cb.r, cs.r), ch(cb.g, cs.g), ch(cb.b, cs.b));
#endif
  if (uAtop == 1) o = vec4(ab * ((1.0 - as) * cb + as * B), ab);
  else o = vec4((1.0 - as) * ab * cb + (1.0 - ab) * as * cs + as * ab * B, as + ab - as * ab);
  o.rgb = min(o.rgb, o.a);
#endif
}`;
const VS = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
let gpu; // undefined: not tried yet; null: no WebGL2 here
function gpuCtx() {
  if (gpu?.gl.isContextLost()) gpu = undefined;
  if (gpu !== undefined) return gpu;
  gpu = null;
  try {
    const cv = new OffscreenCanvas(1, 1);
    const gl = cv.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) return gpu;
    const tex = [0, 1, 2].map(() => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      return t;
    });
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    gpu = { gl, cv, tex, progs: [], tile: Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE), vp[0], vp[1]) };
  } catch { gpu = null; }
  return gpu;
}
function program(g, fam) {
  if (g.progs[fam]) return g.progs[fam];
  const { gl } = g, p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, `#version 300 es\n#define FAM ${fam}\n${FS}`]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`blend shader: ${gl.getProgramInfoLog(p)}`);
  const u = {};
  for (const n of ["uB", "uS", "uI", "uMode", "uH", "uAtop", "uOp", "uMi", "uOff"]) u[n] = gl.getUniformLocation(p, n);
  gl.useProgram(p);
  gl.uniform1i(u.uB, 0); gl.uniform1i(u.uS, 1); gl.uniform1i(u.uI, 2);
  return (g.progs[fam] = { p, u });
}
const mi = new Float32Array(9);
/** One blend pass over the whole of `out`: its result replaces `out`'s pixels. srcs[0] is the backdrop. */
function run(out, fam, srcs, { mode, alpha = 1, atop = false, R, k = 1 }) {
  const g = gpuCtx(), W = out.canvas.width, H = out.canvas.height;
  if (!g) return cpu(out, fam, srcs, mode, fam === 3 ? k : alpha, atop, R);
  const { gl, cv, tex } = g, P = program(g, fam);
  gl.useProgram(P.p);
  gl.uniform1i(P.u.uMode, GPU[mode]?.[1] || 0);
  gl.uniform1i(P.u.uAtop, atop ? 1 : 0);
  gl.uniform1f(P.u.uOp, fam === 3 ? k : alpha);
  if (fam === 2) {
    const A = R.Mi;
    mi[0] = A[0]; mi[1] = A[1]; mi[2] = 0; mi[3] = A[2]; mi[4] = A[3]; mi[5] = 0; mi[6] = A[4]; mi[7] = A[5]; mi[8] = 1;
    gl.uniformMatrix3fv(P.u.uMi, false, mi);
  }
  out.save();
  out.setTransform(1, 0, 0, 1, 0, 0);
  out.globalAlpha = 1;
  out.globalCompositeOperation = "source-over";
  out.imageSmoothingEnabled = false;
  for (let ty = 0; ty < H; ty += g.tile) {
    for (let tx = 0; tx < W; tx += g.tile) {
      const tw = Math.min(g.tile, W - tx), th = Math.min(g.tile, H - ty);
      if (cv.width !== tw || cv.height !== th) { cv.width = tw; cv.height = th; }
      gl.viewport(0, 0, tw, th);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, tx);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, ty);
      for (let i = 0; i < srcs.length; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, tex[i]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, srcs[i]);
      }
      gl.uniform1i(P.u.uH, th);
      gl.uniform2i(P.u.uOff, tx, ty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      out.clearRect(tx, ty, tw, th);
      out.drawImage(cv, 0, 0, tw, th, tx, ty, tw, th);
    }
  }
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  out.restore();
}
/** The same pass on the CPU (no WebGL2): blend.js per pixel. Slow, but the picture is the same. */
let scratch = null;
function cpu(out, fam, srcs, mode, a, atop, R) {
  const W = out.canvas.width, H = out.canvas.height;
  const px = srcs.map((c) => (c === out.canvas ? out : c.getContext("2d")).getImageData(0, 0, W, H).data);
  const [b, s, iso] = px, o = new ImageData(W, H), d = o.data, f = (v) => v / 255;
  for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i += 4) {
    if (fam === 3) {
      // premultiplied: P + k·(C − I)
      const pa = f(b[i + 3]), ca = f(s[i + 3]), ia = f(iso[i + 3]), al = Math.min(1, Math.max(0, pa + a * (ca - ia)));
      for (let c = 0; c < 3; c++) { const v = f(b[i + c]) * pa + a * (f(s[i + c]) * ca - f(iso[i + c]) * ia); d[i + c] = al > 0 ? Math.round((Math.min(al, Math.max(0, v)) / al) * 255) : 0; }
      d[i + 3] = Math.round(al * 255);
      continue;
    }
    const B = [f(b[i]), f(b[i + 1]), f(b[i + 2]), f(b[i + 3])], Sx = [f(s[i]), f(s[i + 1]), f(s[i + 2]), f(s[i + 3])];
    let m = mode, op = a;
    if (fam === 2) {
      const [dx, dy] = ap(R.Mi, x + 0.5, y + 0.5);
      Sx[3] = dissolveNoise(Math.floor(dx), Math.floor(dy)) < Sx[3] * a ? 1 : 0;
      m = "normal"; op = 1;
    }
    const r = atop ? compositeAtop(m, B, Sx, op) : compositePx(m, B, Sx, op);
    for (let c = 0; c < 4; c++) d[i + c] = Math.round(r[c] * 255);
  }
  if (!scratch || scratch.width !== W || scratch.height !== H) scratch = new OffscreenCanvas(W, H);
  scratch.getContext("2d").putImageData(o, 0, 0);
  out.save();
  out.setTransform(1, 0, 0, 1, 0, 0);
  out.globalAlpha = 1;
  out.globalCompositeOperation = "source-over";
  out.clearRect(0, 0, W, H);
  out.drawImage(scratch, 0, 0);
  out.restore();
}
/** For tests: whether blending runs on the GPU here. */
export const gpuReady = () => !!gpuCtx();

/** A `buf(name)` factory: target-sized OffscreenCanvases, created once, cleared on each request. */
export function buffers() {
  const map = new Map();
  let W = 1, H = 1;
  const f = (name) => {
    let c = map.get(name);
    if (!c || c.canvas.width !== W || c.canvas.height !== H) {
      if (c) { c.canvas.width = W; c.canvas.height = H; } else {
        c = new OffscreenCanvas(W, H).getContext("2d");
        map.set(name, c);
      }
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = "source-over";
    c.clearRect(0, 0, W, H);
    return c;
  };
  f.size = (w, h) => { W = Math.max(1, w | 0); H = Math.max(1, h | 0); };
  f.drop = () => { for (const c of map.values()) { c.canvas.width = 1; c.canvas.height = 1; } map.clear(); };
  return f;
}

// ── image headers: size (and JPEG orientation) without decoding ─────────────
/** {w, h, type} from the first bytes of a file, or null. w/h are as displayed (EXIF orientation applied). */
export function sniff(buf) {
  const b = new Uint8Array(buf), v = new DataView(buf);
  const n = b.length;
  if (n < 16) return null;
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: "png", w: v.getUint32(16), h: v.getUint32(20) };
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { type: "gif", w: v.getUint16(6, true), h: v.getUint16(8, true) };
  // BMP
  if (b[0] === 0x42 && b[1] === 0x4d && n > 26) return { type: "bmp", w: Math.abs(v.getInt32(18, true)), h: Math.abs(v.getInt32(22, true)) };
  // WebP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && n > 30) {
    const fmt = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fmt === "VP8X") return { type: "webp", w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (fmt === "VP8 ") return { type: "webp", w: v.getUint16(26, true) & 0x3fff, h: v.getUint16(28, true) & 0x3fff };
    if (fmt === "VP8L") { const x = v.getUint32(21, true); return { type: "webp", w: (x & 0x3fff) + 1, h: ((x >> 14) & 0x3fff) + 1 }; }
    return null;
  }
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8) {
    let p = 2, orient = 1;
    while (p + 9 < n) {
      if (b[p] !== 0xff) { p++; continue; }
      const m = b[p + 1];
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { p += m === 0xff ? 1 : 2; continue; }
      const len = v.getUint16(p + 2);
      if (m === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78) orient = exifOrientation(v, p + 10, Math.min(n, p + 2 + len)) || 1;
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
        const h = v.getUint16(p + 5), w = v.getUint16(p + 7);
        return orient >= 5 && orient <= 8 ? { type: "jpeg", w: h, h: w } : { type: "jpeg", w, h };
      }
      p += 2 + len;
    }
    return null;
  }
  // AVIF / HEIC (ISO BMFF): look for the 'ispe' box
  if (String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp") {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    const type = /avi[fs]/.test(brand) ? "avif" : /hei|mif|hev/.test(brand) ? "heic" : "isobmff";
    for (let p = 12; p + 20 < n; p++) {
      if (b[p] === 0x69 && b[p + 1] === 0x73 && b[p + 2] === 0x70 && b[p + 3] === 0x65) return { type, w: v.getUint32(p + 8), h: v.getUint32(p + 12) };
    }
    return { type, w: 0, h: 0 };
  }
  return null;
}
function exifOrientation(v, start, end) {
  try {
    const le = v.getUint16(start) === 0x4949;
    const ifd = start + v.getUint32(start + 4, le);
    const count = v.getUint16(ifd, le);
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > end) break;
      if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le);
    }
  } catch {}
  return 1;
}

/** Largest canvas we open: browsers cap canvas size (Chrome ~16384 px a side / 268 MP; iOS Safari ~16 MP). */
export function canvasLimit(ua = "") {
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua));
  return ios ? { side: 4096 * 2, area: 16_777_216 } : { side: 16_384, area: 80_000_000 };
}
export function fitScale(w, h, lim) {
  return Math.min(1, lim.side / Math.max(w, h), Math.sqrt(lim.area / (w * h)));
}
