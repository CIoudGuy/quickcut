// Inverting a layer mask: Ctrl+Shift+I (no selection), Ctrl+I and the mask bar's Invert button;
// undo/redo; with a selection Ctrl+Shift+I still inverts the selection and leaves the mask alone.
// Run on a fresh page: (await import("/_test/maskinvtest.js")).run()
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  const key = (o) => document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...o }));
  const W = 200, H = 100;
  const c = new OffscreenCanvas(W, H), g = c.getContext("2d");
  g.fillStyle = "#3a7"; g.fillRect(0, 0, W, H);
  await q.openNew([new File([await c.convertToBlob({ type: "image/png" })], "maskinv.png", { type: "image/png" })]);
  await wait(300);
  q.addMask();
  // a known mask: left half shows (255), right half hidden (0)
  const l = () => q.doc.layers.at(-1);
  {
    const L = l(), base = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) base[y * W + x] = 255;
    const mc = new OffscreenCanvas(W, H), d = new ImageData(W, H);
    for (let i = 0; i < base.length; i++) { d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = 255; d.data[i * 4 + 3] = base[i]; }
    mc.getContext("2d").putImageData(d, 0, 0);
    Object.assign(L, { mask: mc, maskBase: base, maskShift: 0, maskSoft: 0, maskOn: true });
  }
  const at = (x, y) => l().mask.getContext("2d").getImageData(x, y, 1, 1).data[3];
  const state = () => `${at(10, 50)}/${at(190, 50)} base ${l().maskBase[50 * W + 10]}/${l().maskBase[50 * W + 190]}`;
  ok("starts left shown, right hidden", state() === "255/0 base 255/0", state());

  key({ key: "I", code: "KeyI", ctrlKey: true, shiftKey: true });
  await wait(100);
  ok("Ctrl+Shift+I inverts the mask (no selection)", state() === "0/255 base 0/255", state());
  document.querySelector('[aria-label^="Undo"]').click();
  await wait(100);
  ok("undo restores the mask", state() === "255/0 base 255/0", state());
  document.querySelector('[aria-label^="Redo"]').click();
  await wait(100);
  ok("redo inverts again", state() === "0/255 base 0/255", state());

  key({ key: "i", code: "KeyI", ctrlKey: true });
  await wait(100);
  ok("Ctrl+I inverts the mask", state() === "255/0 base 255/0", state());

  v.querySelector('[data-tool="mask"]').click();
  await wait(100);
  const btn = v.querySelector('[data-p="maskinv"]');
  ok("mask bar has Invert", !!btn && !btn.disabled);
  btn?.click();
  await wait(100);
  ok("Invert button inverts the mask", state() === "0/255 base 0/255", state());

  key({ key: "a", code: "KeyA", ctrlKey: true });
  await wait(50);
  const before = state();
  key({ key: "I", code: "KeyI", ctrlKey: true, shiftKey: true });
  await wait(100);
  ok("with a selection Ctrl+Shift+I inverts the selection", q.selection?.kind === "inv", q.selection?.kind);
  ok("…and leaves the mask alone", state() === before, `${before} -> ${state()}`);
  return { pass: !fails.length, fails, out };
}
