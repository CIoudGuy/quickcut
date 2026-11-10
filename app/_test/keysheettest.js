// The ? shortcuts sheet stays smooth while the pointer moves over its rows: applying a row's hover
// styles (the real :hover rules of keys.css, copied onto a class) must not cost a long frame.
// Needs a visible page at desktop width (two-column sheet). Run on a fresh page:
// (await import("/_test/keysheettest.js")).run()
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  const c = new OffscreenCanvas(3000, 2000); c.getContext("2d").fillStyle = "#468"; c.getContext("2d").fillRect(0, 0, 3000, 2000);
  await q.openNew([new File([await c.convertToBlob({ type: "image/png" })], "keys.png", { type: "image/png" })]);
  await wait(500);
  v.querySelector('[data-kact="sheet"]').click();
  await wait(600);
  const sheet = document.querySelector(".ks");
  ok("sheet open", !!sheet);
  // the sheet's own :hover / :focus-within rules, applied through a class instead of the pointer
  const css = [...document.styleSheets].find((s) => s.href?.includes("keys.css"));
  // a copy of the whole sheet with :hover → .qc-hv, used instead of the original while measuring
  const rules = [...css.cssRules].map((r) => r.cssText.replace(/:hover/g, ".qc-hv"));
  const st = document.createElement("style"); st.textContent = rules.join("\n"); document.head.append(st);
  css.disabled = true;
  const rows = [...sheet.querySelectorAll(".ks-row:not(.info)")].slice(0, 12);
  const costs = [];
  for (const r of rows) {
    await raf(); await raf();
    const t0 = performance.now();
    rows.forEach((x) => x.classList.toggle("qc-hv", x === r));
    await raf(); await raf();
    costs.push(Math.round(performance.now() - t0));
  }
  rows.forEach((x) => x.classList.remove("qc-hv"));
  // two frames are ~33 ms at 60 Hz; a long repaint on every row change shows as 80 ms+
  const worst = Math.max(...costs.slice(1)), med = costs.slice(1).sort((a, b) => a - b)[Math.floor(costs.length / 2)];
  out.costs = costs.join(" ");
  ok("hovering rows stays smooth", med < 50, `median ${med} ms, worst ${worst} ms`);
  // the + (add key) control still appears on hover and can be clicked
  const add = rows[0].querySelector(".ks-c.add");
  const hid = getComputedStyle(add).color;
  rows[0].classList.add("qc-hv"); await raf();
  const cs = getComputedStyle(add);
  ok("+ shows on hover", cs.visibility !== "hidden" && cs.opacity !== "0" && cs.color !== "rgba(0, 0, 0, 0)", cs.color);
  ok("+ hidden otherwise (desktop)", innerWidth < 600 || hid === "rgba(0, 0, 0, 0)" || getComputedStyle(add).opacity === "0", hid);
  st.remove(); css.disabled = false; rows[0].classList.remove("qc-hv");
  add.click(); await raf();
  ok("+ starts recording", add.isConnected ? false : !!sheet.querySelector(".ks-c.add.rec"));
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  await wait(100);
  sheet.querySelector(".ks-x")?.click();
  return { pass: !fails.length, fails, out };
}
