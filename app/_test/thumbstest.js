// Timeline thumbnails after many cuts and speed changes: every visible tile must show a picture.
// Run on #video in the page (paste, then `await thumbs()`); needs /_test/rv_hevc.mp4 (or any video at VIDEO below).
// Fails on the old code (tiles stay empty), passes once the page keeps asking for what is still missing.
const VIDEO = "/_test/rv_hevc.mp4";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { const t0 = performance.now(); while (!(await f())) { if (performance.now() - t0 > ms) return false; await wait(50); } return true; };
export async function thumbs() {
  const V = window.__qcVideo, out = {}, fails = [];
  const ok = (n, c, info) => { out[n] = c ? true : info ?? false; if (!c) fails.push(n); };
  const file = new File([await (await fetch(VIDEO)).blob()], "tt.mp4", { type: "video/mp4", lastModified: 1 });
  const n0 = V.opens.length;
  V.openFile(file);
  await until(() => V.opens.length > n0);
  await until(() => V.thumbCount() > 3, 60000);
  await until(() => V.doc?.worker && V.doc.keys && V.state().total > 0);
  const dur = V.state().total;
  // a long file: thousands of key frames of which only the first few are decoded so far (the worker
  // is held back) - every tile must still show the nearest picture there is
  const d = V.doc, post = d.worker.postMessage.bind(d.worker);
  d.worker.postMessage = (m, t) => (m && (m.op === "thumbs") ? undefined : post(m, t));
  d.keys = Float64Array.from({ length: 4000 }, (_, i) => (i * dur) / 4000);
  window.dispatchEvent(new Event("resize"));
  const settle = async () => { await wait(300); return until(() => V.tiles > 0 && V.tilesEmpty === 0, 15000); };
  const pieces = (n, speeds) => { const P = [], step = dur / n; for (let i = 0; i < n; i++) P.push([i * step, i * step + step * 0.8, speeds[i % speeds.length], 1]); return P; };
  // many short pieces at mixed speeds
  V.setPieces(pieces(40, [1, 100, 16, 2, 100, 50, 4]));
  ok("40 pieces: all tiles filled", await settle(), [V.tiles, V.tilesEmpty]);
  // zoom in and out, scroll
  for (const z of [3, 12, 1]) {
    document.querySelector("#view-video .tl-zoom, #view-video input[type=range]")?.dispatchEvent(new Event("input", { bubbles: true }));
  }
  // undo / redo
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true }));
  await wait(200);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "y", code: "KeyY", ctrlKey: true, bubbles: true }));
  ok("after undo/redo: all tiles filled", await settle(), [V.tiles, V.tilesEmpty]);
  // an eviction burst (the cache is bounded) must not leave visible tiles empty
  V.setPieces(pieces(25, [100, 1]));
  ok("25 pieces: all tiles filled", await settle(), [V.tiles, V.tilesEmpty]);
  d.worker.postMessage = post;
  out.fails = fails;
  return out;
}
