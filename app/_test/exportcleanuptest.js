// Video: with no File System Access API an Exact export goes through a temporary file in the origin's
// private storage, deleted a minute after the download. A second export deletes the first one's file
// early; the first export's delayed clean-up then finds nothing and must not leave an unhandled rejection.
// Needs an H.264 video at /_test/zz_h264.mp4 (copy any; not kept in the repo), on #video.
// Run: (await import("/_test/exportcleanuptest.js")).run()
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 30000) => { const t0 = performance.now(); while (!(await f())) { if (performance.now() - t0 > ms) return false; await wait(30); } return true; };

export async function run() {
  const V = window.__qcVideo, v = document.getElementById("view-video");
  const file = new File([await (await fetch("/_test/zz_h264.mp4")).blob()], "zz_h264.mp4", { type: "video/mp4", lastModified: 1000 });
  const n0 = V.opens.length;
  V.openFile(file);
  await until(() => V.opens.length > n0);
  V.setPieces([[0, 1, 1, 1]]);
  const rejections = [], onRej = (e) => rejections.push(String(e.reason?.name || e.reason));
  addEventListener("unhandledrejection", onRej);
  const st = setTimeout, ssp = window.showSaveFilePicker;
  window.showSaveFilePicker = undefined;
  window.setTimeout = (fn, ms, ...a) => st(fn, ms >= 60000 ? 1500 : ms, ...a); // "a minute later" becomes 1.5 s
  const out = {};
  try {
    for (let i = 0; i < 2; i++) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "e", code: "KeyE", ctrlKey: true, bubbles: true, cancelable: true }));
      await until(() => [...document.querySelectorAll(".pop button")].some((b) => /Export/.test(b.textContent) && b.offsetParent), 5000);
      const exact = [...document.querySelectorAll(".pop [data-mode=exact]")][0];
      exact?.click();
      await wait(100);
      const go = [...document.querySelectorAll(".pop button")].find((b) => /^Export/.test(b.textContent.trim()));
      go.click();
      out["export" + i] = await until(() => !V.state().job && V.state().lastDone && V.state().lastDone.name, 60000);
      await wait(200);
    }
    await wait(3500); // both delayed clean-ups have run
  } finally {
    window.setTimeout = st;
    window.showSaveFilePicker = ssp;
    removeEventListener("unhandledrejection", onRej);
  }
  out.rejections = rejections;
  return { pass: !!(out.export0 && out.export1) && !rejections.length, out };
}
