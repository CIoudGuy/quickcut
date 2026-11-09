// Pixel check of the real compositor (engine.js: Canvas 2D modes + the WebGL2 pass) against the
// blend.js reference (PhotoCraft's formulas), for every mode, plain and clipped, and for groups.
// Run in the page: (await import("/_test/blendpix.js")).run()
import { composite, buffers, tree, BLENDS, I, gpuReady } from "../photo/engine.js";
import { composite as ref, compositeAtop, dissolveNoise } from "../photo/blend.js";

const N = 48;
function canvas(fill) {
  const c = new OffscreenCanvas(N, N), g = c.getContext("2d"), d = new ImageData(N, N);
  for (let y = 0, i = 0; y < N; y++) for (let x = 0; x < N; x++, i += 4) { const p = fill(x, y); d.data.set(p, i); }
  g.putImageData(d, 0, 0);
  return c;
}
const px = (c) => c.getContext("2d").getImageData(0, 0, N, N).data;
const f = (d, i) => [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, d[i + 3] / 255];
// a canvas stores colours premultiplied in 8 bits: the colour the compositor really has
const fp = (d, i) => { const a = d[i + 3]; return a ? [0, 1, 2].map((k) => Math.round((d[i + k] * a) / 255) / a).concat(a / 255) : [0, 0, 0, 0]; };
// compare premultiplied (what the eye sees over any matte), in 8-bit levels
const diff = (a, b) => Math.max(...[0, 1, 2].map((k) => Math.abs(a[k] * a[3] - b[k] * b[3]) * 255), Math.abs(a[3] - b[3]) * 255);

export function run() {
  // backdrop: smooth ramps (opaque, one semi-transparent band); source: other ramps with varied alpha
  const B = canvas((x, y) => [x * 5.3, y * 5.3, (x * y) % 256, y < 6 ? 128 : 255]);
  const S = canvas((x, y) => [255 - y * 5, (x * 7) % 256, (x + y) * 2.6, x < 4 ? 0 : x < 10 ? 100 : 255]);
  const b = px(B), s = px(S);
  const buf = buffers();
  buf.size(N, N);
  const out = new OffscreenCanvas(N, N).getContext("2d");
  const lay = (src, o) => ({ src, x: 0, y: 0, opacity: 1, blend: "normal", visible: true, clip: false, ...o });
  const res = { gpu: gpuReady(), modes: {}, worst: 0, fails: [] };
  const check = (name, want, tol = 2) => {
    const o = px(out.canvas);
    let worst = 0;
    for (let i = 0; i < o.length; i += 4) worst = Math.max(worst, diff(f(o, i), want(i)));
    res.worst = Math.max(res.worst, worst);
    if (worst > tol) res.fails.push(`${name}: ${worst.toFixed(1)} levels`);
    return +worst.toFixed(2);
  };
  const draw = (nodes) => { out.clearRect(0, 0, N, N); composite(out, nodes, I, buf); };
  for (const [mode] of BLENDS) {
    // plain: source at 80% opacity over the backdrop
    draw([lay(B), lay(S, { blend: mode, opacity: 0.8 })]);
    const plain = check(mode, (i) => {
      const sp = fp(s, i);
      if (mode !== "dissolve") return ref(mode, f(b, i), sp, 0.8);
      const x = (i / 4) % N, y = Math.floor(i / 4 / N);
      return ref("normal", f(b, i), [sp[0], sp[1], sp[2], dissolveNoise(x, y) < sp[3] * 0.8 ? 1 : 0]);
    });
    // clipped to the backdrop (checked where the base is opaque: the clipping math is exact there)
    draw([lay(B), lay(S, { blend: mode, opacity: 0.8, clip: true })]);
    const o = px(out.canvas);
    let worst = 0;
    for (let i = 0; i < o.length; i += 4) {
      if (b[i + 3] < 255) continue;
      const sp = fp(s, i), x = (i / 4) % N, y = Math.floor(i / 4 / N);
      const want = mode === "dissolve" ? compositeAtop("normal", f(b, i), [sp[0], sp[1], sp[2], dissolveNoise(x, y) < sp[3] * 0.8 ? 1 : 0]) : compositeAtop(mode, f(b, i), sp, 0.8);
      worst = Math.max(worst, diff(f(o, i), want));
    }
    if (worst > 2) res.fails.push(`${mode} clipped: ${worst.toFixed(1)} levels`);
    res.modes[mode] = [plain, +worst.toFixed(2)];
  }
  // groups: isolated (Multiply group over the backdrop: the child is first composited on nothing)
  const G = (o, children) => ({ group: true, opacity: 1, blend: "pass", visible: true, clip: false, children, ...o });
  draw([lay(B), G({ blend: "multiply" }, [lay(S, { blend: "screen" })])]);
  res.groupIsolated = check("group isolated multiply", (i) => ref("multiply", f(b, i), ref("screen", [0, 0, 0, 0], f(s, i))));
  // pass-through: the child blends straight into the backdrop
  draw([lay(B), G({}, [lay(S, { blend: "linear-burn" })])]);
  res.groupPass = check("group pass-through", (i) => ref("linear-burn", f(b, i), f(s, i)));
  // pass-through at 50%: the backdrop mixed with the result
  draw([lay(B), G({ opacity: 0.5 }, [lay(S, { blend: "difference" })])]);
  res.groupPassHalf = check("group pass-through 50%", (i) => {
    const a = f(b, i), r = ref("difference", a, f(s, i)), al = a[3] * 0.5 + r[3] * 0.5;
    return al ? [0, 1, 2].map((k) => (a[k] * a[3] * 0.5 + r[k] * r[3] * 0.5) / al).concat(al) : [0, 0, 0, 0];
  });
  // a group as a clipping base, and a clipped group (tree() from flat records, as the app does)
  const items = [{ id: 1, parent: 9, ...lay(B) }, { id: 2, parent: null, ...lay(S, { clip: true, blend: "vivid-light" }) }];
  draw(tree(items, [{ id: 9, group: true, parent: null, opacity: 1, blend: "normal", visible: true, clip: false }]));
  res.groupAsBase = check("group as clip base", (i) => (b[i + 3] < 255 ? f(out.getImageData(0, 0, N, N).data, i) : compositeAtop("vivid-light", f(b, i), f(s, i))));
  res.pass = res.fails.length === 0;
  buf.drop();
  return res;
}
