// The "layers here" menu (right-click on the picture): one at a time, only where there is a choice,
// only for a deliberate right-click with the Move tool (not while painting, not for a pen button or a
// long press, not right after a drag).
// Run on a fresh page: (await import("/_test/layermenutest.js")).run()
export async function run() {
  const v = document.getElementById("view-photo"), q = v._qc, cv = v.querySelector(".ph-canvas");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], out = {};
  const ok = (name, cond, info) => { out[name] = cond ? true : info ?? false; if (!cond) fails.push(name); };
  const c = new OffscreenCanvas(300, 200); c.getContext("2d").fillStyle = "#468"; c.getContext("2d").fillRect(0, 0, 300, 200);
  await q.openNew([new File([await c.convertToBlob({ type: "image/png" })], "menu.png", { type: "image/png" })]);
  await wait(300);
  const r = cv.getBoundingClientRect(), at = (x, y) => ({ clientX: r.left + q.view.ox + x * q.view.z, clientY: r.top + q.view.oy + y * q.view.z });
  const rc = (x, y, o = {}) => cv.dispatchEvent(new PointerEvent("contextmenu", { button: 2, buttons: 0, pointerType: "mouse", bubbles: true, cancelable: true, ...at(x, y), ...o }));
  const menus = () => document.querySelectorAll(".ph-menu").length;
  const esc = async () => { for (let i = 0; i < 4 && menus(); i++) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); await wait(250); } };
  const tool = async (t) => { v.querySelector(`[data-tool="${t}"]`).click(); await wait(150); document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); await wait(150); };

  await tool("move");
  await wait(300);
  rc(150, 100); await wait(250);
  ok("one layer under the pointer: no menu (nothing to choose)", menus() === 0, menus());
  await esc();
  q.ops.dup(); await wait(300);
  await tool("move");
  await wait(300);
  rc(150, 100); await wait(250);
  ok("two layers, Move tool, right-click: the menu", menus() === 1 && document.querySelectorAll(".ph-menu button").length === 2, `${menus()} menus`);
  rc(100, 60); await wait(350);
  ok("a second right-click: still one menu", menus() === 1, menus());
  rc(200, 140); await wait(350);
  ok("a third: still one", menus() === 1, menus());
  await esc();
  ok("Esc closes it", menus() === 0, menus());
  rc(150, 100, { pointerType: "pen" }); await wait(250);
  ok("a pen's button: no menu", menus() === 0, menus());
  await esc();
  rc(150, 100, { pointerType: "touch" }); await wait(250);
  ok("a long press: no menu", menus() === 0, menus());
  await esc();
  rc(150, 100, { buttons: 1 }); await wait(250);
  ok("with the left button down: no menu", menus() === 0, menus());
  await esc();
  cv.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, pointerType: "mouse", button: 0, bubbles: true, ...at(150, 100) }));
  rc(150, 100); await wait(250);
  ok("right after a drag ended: no menu", menus() === 0, menus());
  await esc();
  for (const t of ["brush", "eraser", "select"]) {
    await tool(t); await wait(300);
    rc(150, 100); await wait(250);
    ok(`${t} tool: no menu`, menus() === 0, menus());
    await esc();
  }
  await tool("move"); await wait(300);
  rc(150, 100); await wait(250);
  ok("back on the Move tool: the menu again", menus() === 1, menus());
  await esc();
  return { pass: !fails.length, fails, out };
}
