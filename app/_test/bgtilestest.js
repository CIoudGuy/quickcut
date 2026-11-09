// High detail on a very large photo (≥ 24 MP, GPU) adds the tile detail pass; ordinary sizes don't.
// Uses the real remover (downloads High detail once). Run on a fresh page:
// (await import("/_test/bgtilestest.js")).run()
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  localStorage.setItem("quickcut.photo.bgq", "hq");
  localStorage.removeItem("quickcut.photo.bgep");
  async function once(W, H) {
    const c = new OffscreenCanvas(W, H), g = c.getContext("2d");
    g.fillStyle = "#cfe0ee"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#7a2f1d"; g.beginPath(); g.ellipse(W / 2, H * 0.55, W * 0.2, H * 0.32, 0, 0, 7); g.fill();
    await q.openNew([new File([await c.convertToBlob({ type: "image/png" })], `${W}x${H}.png`, { type: "image/png" })]);
    await wait(400);
    v.querySelector('[data-tool="move"]').click(); await wait(150);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); await wait(150);
    // choose High detail in the AI model menu, as a user does
    v.querySelector('[data-p="bgmenu"]').click(); await wait(2500);
    document.querySelector('.ph-bgmenu [data-q="hq"]').click(); await wait(200);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); await wait(200);
    v.querySelector('[data-p="rmbg"]').click();
    await wait(1500);
    document.querySelector('.ph-bgask [data-b="go"]')?.click();
    let sawPass = false;
    const t0 = performance.now();
    while (!q.doc.layers.at(-1).mask && performance.now() - t0 < 240000) {
      if (/Detail pass/.test(document.querySelector(".ph-bgjob")?.textContent || "")) sawPass = true;
      await wait(100);
    }
    const L = q.doc.layers.at(-1), a = (x, y) => L.mask.getContext("2d").getImageData(x, y, 1, 1).data[3];
    return { done: !!L.mask, sawPass, quality: q.stats.bg?.quality, wall: q.stats.bg?.wall, inside: L.mask && a(W / 2, H * 0.55), outside: L.mask && a(W * 0.05, H * 0.05) };
  }
  const big = await once(6000, 4200); // 25.2 MP
  ok("25 MP: removed with High detail", big.done && big.quality === "hq", big.quality);
  ok("25 MP: detail pass ran", big.sawPass);
  ok("25 MP: subject kept, background removed", big.inside > 200 && big.outside < 40, `${big.inside}/${big.outside}`);
  out.bigWall = big.wall;
  const small = await once(4000, 3000); // 12 MP
  ok("12 MP: removed with High detail", small.done && small.quality === "hq", small.quality);
  ok("12 MP: no detail pass", !small.sawPass);
  out.smallWall = small.wall;
  localStorage.removeItem("quickcut.photo.bgq");
  return { pass: !fails.length, fails, out };
}
