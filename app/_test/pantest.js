// Video timeline: the middle mouse button drags it sideways (grabbing cursor, no playhead move, no
// selection, no browser auto-scroll); Shift+wheel pans too. Needs /_test/rv_hevc.mp4, on #video.
// Run: (await import("/_test/pantest.js")).run()
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { const t0 = performance.now(); while (!(await f())) { if (performance.now() - t0 > ms) return false; await wait(30); } return true; };
export async function run() {
  const V = window.__qcVideo, out = {}, fails = [];
  const ok = (n, c, info) => { out[n] = c ? true : info ?? false; if (!c) fails.push(n); };
  const file = new File([await (await fetch("/_test/rv_hevc.mp4")).blob()], "pan.mp4", { type: "video/mp4", lastModified: 1 });
  const n0 = V.opens.length;
  V.openFile(file);
  await until(() => V.opens.length > n0 && V.state().total > 0);
  const track = document.querySelector("#view-video .qv-track"), r = track.getBoundingClientRect();
  const slider = document.querySelector("#view-video .qv-zoom .slider");
  slider.value = "600"; slider.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(400);
  const sx = () => V.zoomInfo().scrollX;
  ok("zoomed in (can scroll)", V.zoomInfo().pps > V.zoomInfo().fit * 1.5, V.zoomInfo());
  const y = r.top + 20, x0 = r.left + r.width / 2;
  const ev = (type, x, extra = {}) => track.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: "mouse", button: 1, buttons: type === "pointerup" ? 0 : 4, bubbles: true, cancelable: true, clientX: x, clientY: y, ...extra }));
  const tl0 = V.state().tl, sel0 = JSON.stringify(V.state().sel), s0 = sx();
  const md = new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true, clientX: x0, clientY: y });
  track.dispatchEvent(md);
  ok("mousedown default prevented (no auto-scroll icon)", md.defaultPrevented);
  const down = ev("pointerdown", x0);
  ok("pointerdown prevented", down === false);
  ev("pointermove", x0 - 150);
  ok("cursor grabbing", track.style.cursor === "grabbing", track.style.cursor);
  await wait(50);
  ok("drag left scrolls right", sx() > s0 + 100, [s0, sx()]);
  ev("pointermove", x0 + 40);
  await wait(50);
  ok("drag right scrolls back", sx() < s0 + 100, sx());
  ev("pointerup", x0 + 40);
  ok("cursor reset", track.style.cursor === "", track.style.cursor);
  ok("playhead unmoved", V.state().tl === tl0, [tl0, V.state().tl]);
  ok("selection unchanged", JSON.stringify(V.state().sel) === sel0);
  const aux = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
  track.dispatchEvent(aux);
  ok("auxclick prevented", aux.defaultPrevented);
  // moves after release do nothing
  const s1 = sx();
  ev("pointermove", x0 - 300);
  await wait(50);
  ok("no pan after release", sx() === s1, [s1, sx()]);
  // shift + wheel
  const s2 = sx();
  track.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, shiftKey: true, bubbles: true, cancelable: true, clientX: x0, clientY: y }));
  await wait(50);
  ok("shift+wheel pans", sx() !== s2, [s2, sx()]);
  out.fails = fails;
  return out;
}
