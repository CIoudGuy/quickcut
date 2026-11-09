// The AI quality picker: five qualities (Fast, High detail, Hair & fur, People, Fine detail) as a
// list with sizes, in the AI model menu and in the download prompt. People and Fine detail need the
// GPU (unavailable with Run on: CPU, reason on click), each is its own download, listed under
// "Downloaded model" and removable on its own. Uses the real remover (downloads People once).
// Needs WebGPU. Run on a fresh page: (await import("/_test/bgqualitytest.js")).run()
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  const esc = () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  localStorage.removeItem("quickcut.photo.bgq");
  localStorage.removeItem("quickcut.photo.bgep");
  // start without the People / Fine detail models on this device
  const w = new Worker("/photo/bg.js", { type: "module" });
  await new Promise((r) => { w.onmessage = (e) => { if (e.data.id === 1) r(); }; w.postMessage({ op: "remove", id: 1, models: ["birefnet-portrait-1024", "birefnet-dis-1024"] }); });
  w.terminate();
  const c = new OffscreenCanvas(640, 480), g = c.getContext("2d");
  g.fillStyle = "#dfe6ee"; g.fillRect(0, 0, 640, 480); g.fillStyle = "#2e6b3a"; g.beginPath(); g.ellipse(320, 260, 130, 170, 0, 0, 7); g.fill();
  await q.openNew([new File([await c.convertToBlob({ type: "image/png" })], "q.png", { type: "image/png" })]);
  await wait(300);
  v.querySelector('[data-tool="move"]').click(); await wait(150); esc(); await wait(150);

  const menu = async () => {
    if (!v.querySelector('[data-p="bgmenu"]')) { v.querySelector('[data-tool="move"]').click(); await wait(150); esc(); await wait(150); } // after a removal the mask tool is open
    v.querySelector('[data-p="bgmenu"]').click(); await wait(2500); return document.querySelector(".ph-bgmenu"); };
  let m = await menu();
  const rows = [...m.querySelectorAll(".ph-qlist [data-q]")];
  ok("menu: five qualities in a list", rows.length === 5, rows.length);
  ok("menu: names", rows.map((b) => b.querySelector(".n").textContent).join("|") === "Fast|High detail|Hair & fur|People|Fine detail", rows.map((b) => b.textContent).join("|"));
  ok("menu: every quality shows its size", rows.every((b) => /\d+ MB/.test(b.querySelector(".sz").textContent)), rows.map((b) => b.querySelector(".sz").textContent).join("|"));
  ok("menu: People not downloaded → download icon", !!m.querySelector('[data-q="people"] .sz svg'));
  const list = m.querySelector(".ph-qlist");
  ok("menu: list fits the menu (no overflow)", list.scrollWidth <= list.clientWidth && m.scrollWidth <= m.clientWidth, `${list.scrollWidth}/${list.clientWidth}`);
  const dis = (id) => m.querySelector(`[data-q="${id}"]`).getAttribute("aria-disabled") === "true";
  ok("GPU: People available", !dis("people"));
  ok("GPU: Fine detail available", !dis("fine"));
  m.querySelector('[data-ep="wasm"]').click(); await wait(200);
  ok("CPU: People unavailable", dis("people"));
  ok("CPU: Fine detail unavailable", dis("fine"));
  ok("CPU: Fast available", !dis("fast"));
  m.querySelector('[data-q="fine"]').click(); await wait(200);
  const t = [...document.querySelectorAll(".toast .msg")].map((x) => x.textContent).join("|");
  ok("CPU: click on Fine detail says why", /GPU/.test(t), t);
  ok("CPU: Fine detail not chosen", localStorage.getItem("quickcut.photo.bgq") !== "fine");
  m.querySelector('[data-ep="auto"]').click(); await wait(200);
  m.querySelector('[data-q="people"]').click(); await wait(200);
  ok("People chosen and remembered", m.querySelector('[data-q="people"]').getAttribute("aria-checked") === "true" && localStorage.getItem("quickcut.photo.bgq") === "people");
  esc(); await wait(200);

  // first use: the download prompt shows the same list, People selected, and its own download
  v.querySelector('[data-p="rmbg"]').click();
  await wait(2000);
  const ask = document.querySelector(".ph-bgask");
  ok("download prompt opened", !!ask);
  if (!ask) return { pass: false, fails, out };
  ok("prompt: five qualities", ask.querySelectorAll(".ph-qlist [data-q]").length === 5);
  ok("prompt: People selected", ask.querySelector('[data-q="people"]').getAttribute("aria-checked") === "true");
  ok("prompt: list fits", ask.querySelector(".ph-qlist").scrollWidth <= ask.querySelector(".ph-qlist").clientWidth);
  const go = ask.querySelector('[data-b="go"]');
  ok("prompt: download size on the button", /Download \d+ MB/.test(go.textContent), go.textContent);
  go.click();
  const t0 = performance.now();
  while (!q.doc.layers.at(-1).mask && performance.now() - t0 < 300000) await wait(300);
  ok("removal with People", !!q.doc.layers.at(-1).mask && q.stats.bg?.quality === "people" && q.stats.bg?.model === "birefnet-portrait-1024", q.stats.bg && `${q.stats.bg.quality} ${q.stats.bg.model} ${q.stats.bg.ep}`);
  ok("…on the GPU", q.stats.bg?.ep === "webgpu", q.stats.bg?.ep);

  // downloaded: listed on its own, no download icon any more, removable on its own
  // (undo first: the menu arrow is on the Move bar of a layer without a mask)
  document.querySelector('[aria-label^="Undo"]').click(); await wait(300);
  m = await menu();
  const stored = [...m.querySelectorAll(".ph-stored .t")].map((x) => x.textContent);
  ok("stored: People listed", stored.some((s) => /^Downloaded model \(People\) · \d+ MB$/.test(s)), stored.join("|"));
  ok("menu: People downloaded → no download icon", !m.querySelector('[data-q="people"] .sz svg'));
  const row = [...m.querySelectorAll(".ph-stored .row-between")].find((r) => /People/.test(r.textContent));
  row.querySelector("button").click(); await wait(100);
  row.querySelector('[data-s="rm"]').click(); await wait(2500);
  m = document.querySelector(".ph-bgmenu");
  const after = [...(m?.querySelectorAll(".ph-stored .t") || [])].map((x) => x.textContent);
  ok("stored: People removed", !after.some((s) => /People/.test(s)), after.join("|"));
  esc();
  localStorage.removeItem("quickcut.photo.bgq");
  return { pass: !fails.length, fails, out };
}
