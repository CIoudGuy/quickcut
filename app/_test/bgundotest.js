// Undo after Remove background returns to the tool the user had (not the mask tool on a layer
// without a mask); redo goes back to the mask tool. Uses the real remover (downloads the Fast
// model once if this browser doesn't have it).
// Run on a fresh page: (await import("/_test/bgundotest.js")).run()
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  const activeTool = () => v.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool;
  const until = async (fn, ms) => { const t = performance.now(); while (performance.now() - t < ms) { if (fn()) return true; await wait(100); } return false; };

  const c = new OffscreenCanvas(480, 360), g = c.getContext("2d");
  g.fillStyle = "#dfe6ee"; g.fillRect(0, 0, 480, 360);
  g.fillStyle = "#c0392b"; g.beginPath(); g.ellipse(240, 200, 100, 130, 0, 0, 7); g.fill();
  await q.openNew([new File([await c.convertToBlob({ type: "image/png" })], "bgundo.png", { type: "image/png" })]);
  await wait(300);
  v.querySelector('[data-tool="move"]').click();
  await wait(100);
  ok("starts on move", activeTool() === "move", activeTool());

  v.querySelector('[data-p="rmbg"]').click();
  // a first run asks to download the model: accept it
  await until(() => document.querySelector(".ph-bgask") || q.doc.layers.at(-1).mask, 5000);
  const ask = document.querySelector('.ph-bgask [data-b="go"]');
  if (ask) ask.click();
  const done = await until(() => !!q.doc.layers.at(-1).mask, 180000);
  ok("background removed", done);
  ok("mask tool after removal", activeTool() === "mask", activeTool());

  document.querySelector('[aria-label^="Undo"]').click();
  await wait(300);
  ok("undo removes the mask", !q.doc.layers.at(-1).mask);
  ok("undo returns to move", activeTool() === "move", activeTool());

  document.querySelector('[aria-label^="Redo"]').click();
  await wait(300);
  ok("redo restores the mask", !!q.doc.layers.at(-1).mask);
  ok("redo returns to the mask tool", activeTool() === "mask", activeTool());

  return { pass: !fails.length, fails, out };
}
