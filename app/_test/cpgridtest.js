// Color Picker zoomed in: the blocks on screen are the image's own pixels, drawn with the same numbers
// as the pixel grid and as picking, so block, grid cell and picked pixel always agree.
// Run on a fresh page with the Color Picker tab open: (await import("/_test/cpgridtest.js")).run()
export async function run() {
  const v = document.getElementById("view-color"), q = v._qc;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  // 37 × 23 pixels, every pixel its own colour (computed from x and y)
  const W = 37, H = 23, col = (x, y) => [(x * 7) & 255, (y * 11) & 255, ((x + y) * 5) & 255];
  const c = new OffscreenCanvas(W, H), g = c.getContext("2d"), d = g.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, gg, b] = col(x, y), i = (y * W + x) * 4; d.data[i] = r; d.data[i + 1] = gg; d.data[i + 2] = b; d.data[i + 3] = 255; }
  g.putImageData(d, 0, 0);
  await q.addFiles([new File([await c.convertToBlob({ type: "image/png" })], "pixels.png", { type: "image/png" })]);
  await wait(500);
  for (const abs of [12, 61.35]) {
    q.zoomAbs(abs, 18, 11);
    await wait(150);
    q.drawNow();
    const cv = q.grid, gx = cv.getContext("2d"), sr = q.stage.getBoundingClientRect(), k = cv.width / (q.stage.clientWidth || 1);
    let checked = 0, wrongColour = [], wrongPick = [];
    for (const [px, py] of [[18, 11], [17, 11], [19, 12], [18, 10], [16, 9], [20, 13]]) {
      const p = q.centreOf(px, py); // stage coordinates of the pixel's centre
      if (p.x < 0 || p.y < 0 || p.x >= q.stage.clientWidth || p.y >= q.stage.clientHeight) continue;
      checked++;
      const s = gx.getImageData(Math.floor(p.x * k), Math.floor(p.y * k), 1, 1).data, [r, gg, b] = col(px, py);
      if (Math.abs(s[0] - r) > 2 || Math.abs(s[1] - gg) > 2 || Math.abs(s[2] - b) > 2 || s[3] < 250) wrongColour.push(`${px},${py}: ${s[0]},${s[1]},${s[2]},${s[3]} vs ${r},${gg},${b}`);
      const zk = sr.width / (q.stage.clientWidth || 1), hit = q.pixelAt(sr.left + p.x * zk, sr.top + p.y * zk);
      if (!hit || hit.x !== px || hit.y !== py) wrongPick.push(`${px},${py} -> ${hit && `${hit.x},${hit.y}`}`);
    }
    ok(`${abs * 100}%: pixels checked`, checked >= 4, checked);
    ok(`${abs * 100}%: each block shows its own pixel's colour`, !wrongColour.length, wrongColour.join(" | "));
    ok(`${abs * 100}%: picking at a block's centre gives that pixel`, !wrongPick.length, wrongPick.join(" | "));
  }
  return { pass: !fails.length, fails, out };
}
