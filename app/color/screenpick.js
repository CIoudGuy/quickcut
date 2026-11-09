// Pick a colour from anywhere on the screen. Two paths, chosen by feature detection (never by user agent):
//   1. EyeDropper API (Chrome, Edge, Opera on computers): the browser's own picker.
//   2. getDisplayMedia (Firefox, Safari on computers): the user chooses a screen or window, ONE frame is
//      grabbed and the capture stops right away; the frame is shown full-screen with a magnifier and the
//      user clicks the pixel they want. It is a snapshot, not live.
// Where neither exists (most phones and tablets) `screenPickKind()` is null and the button is hidden.
// Nothing leaves the browser; the snapshot only lives in memory until the picker closes.

const toHex = (r, g, b) => `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`.toUpperCase();

export function screenPickKind() {
  if (typeof window.EyeDropper === "function") return "eyedropper";
  if (window.isSecureContext && typeof navigator.mediaDevices?.getDisplayMedia === "function") return "capture";
  return null;
}

/** @returns {Promise<{hex: string}|{cancelled: true}|{error: string}>} */
export async function pickFromScreen(opts = {}) {
  const kind = screenPickKind();
  try {
    if (kind === "eyedropper") {
      const r = await new window.EyeDropper().open();
      const m = /^#([0-9a-f]{6})$/i.exec(r.sRGBHex || "");
      return m ? { hex: `#${m[1].toUpperCase()}` } : { error: "The browser returned an unexpected colour." };
    }
    if (kind === "capture") return await captureAndPick(opts);
    return { error: "This browser can't pick colours from the screen." };
  } catch (e) {
    // Esc in the EyeDropper, or "Cancel" / "Don't allow" in the capture prompt
    if (e && (e.name === "AbortError" || e.name === "NotAllowedError")) return { cancelled: true };
    console.error(e);
    return { error: "Couldn't pick from the screen." };
  }
}

async function grabFrame() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.srcObject = stream;
    await v.play();
    // wait for a real decoded frame
    await new Promise((res) => {
      let done = false;
      const fin = () => { if (!done) { done = true; res(); } };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(fin); else v.addEventListener("loadeddata", fin, { once: true });
      setTimeout(fin, 1500);
    });
    const w = v.videoWidth, hgt = v.videoHeight;
    if (!w || !hgt) throw new Error("no frame");
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = hgt;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(v, 0, 0);
    v.srcObject = null;
    return cv;
  } finally {
    stream.getTracks().forEach((t) => t.stop()); // capture ends immediately; only one frame is kept
  }
}

async function captureAndPick({ lens = 150, zoom = 8 } = {}) {
  const frame = await grabFrame();
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const ov = document.createElement("div");
    ov.className = "cl-snap";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-label", "Pick a colour from the screen snapshot");
    ov.innerHTML = `<div class="cl-snap-bar" role="status">Esc to cancel</div><canvas class="cl-snap-cv"></canvas><div class="cl-snap-lens" hidden><canvas></canvas></div><span class="cl-snap-chip mono" hidden></span>`;
    const cv = ov.querySelector(".cl-snap-cv"), lensEl = ov.querySelector(".cl-snap-lens"), lcv = lensEl.querySelector("canvas"), chip = ov.querySelector(".cl-snap-chip");
    cv.width = frame.width; cv.height = frame.height;
    cv.getContext("2d").drawImage(frame, 0, 0);
    const fctx = frame.getContext("2d", { willReadFrequently: true });
    const D = lens;
    lensEl.style.width = lensEl.style.height = `${D}px`;
    const dpr = devicePixelRatio || 1;

    const pixelAt = (cx, cy) => {
      const r = cv.getBoundingClientRect();
      const x = Math.floor(((cx - r.left) / r.width) * frame.width), y = Math.floor(((cy - r.top) / r.height) * frame.height);
      return x < 0 || y < 0 || x >= frame.width || y >= frame.height ? null : { x, y };
    };
    const hexOf = (x, y) => { const d = fctx.getImageData(x, y, 1, 1).data; return toHex(d[0], d[1], d[2]); };
    function move(cx, cy) {
      const p = pixelAt(cx, cy);
      if (!p) { lensEl.hidden = chip.hidden = true; return; }
      const orect = ov.getBoundingClientRect();
      const k = orect.width / ov.offsetWidth || 1; // CSS zoom on <html>
      const dev = Math.max(1, Math.round(D * k * dpr));
      if (lcv.width !== dev) lcv.width = lcv.height = dev;
      const c = lcv.getContext("2d");
      c.imageSmoothingEnabled = false;
      c.fillStyle = "#0E0E0F"; c.fillRect(0, 0, dev, dev);
      const span = D / zoom, sx = p.x + 0.5 - span / 2, sy = p.y + 0.5 - span / 2;
      c.drawImage(frame, sx, sy, span, span, 0, 0, dev, dev);
      const cell = dev / span, cs = Math.max(cell, 6), off = (cell - cs) / 2, o = (span / 2 - 0.5) * cell;
      c.lineWidth = 3.5; c.strokeStyle = "rgba(0,0,0,.6)"; c.strokeRect(o + off, o + off, cs, cs);
      c.lineWidth = 1.5; c.strokeStyle = "#fff"; c.strokeRect(o + off, o + off, cs, cs);
      let lx = (cx - orect.left) / k - D / 2, ly = (cy - orect.top) / k - D - 28;
      if (ly < 8) ly = (cy - orect.top) / k + 28;
      lx = Math.max(8, Math.min(ov.offsetWidth - D - 8, lx));
      lensEl.style.left = `${lx}px`; lensEl.style.top = `${ly}px`;
      chip.style.left = `${lx + D / 2}px`; chip.style.top = `${ly + D + 8}px`;
      chip.textContent = hexOf(p.x, p.y);
      lensEl.hidden = chip.hidden = false;
    }
    function finish(res) {
      removeEventListener("keydown", onKey, true);
      ov.remove();
      try { prevFocus?.focus?.({ preventScroll: true }); } catch { /* element is gone */ }
      resolve(res);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish({ cancelled: true }); }
      else { e.preventDefault(); e.stopPropagation(); } // the tool's own shortcuts must not fire behind the snapshot
    }
    ov.addEventListener("pointermove", (e) => move(e.clientX, e.clientY));
    ov.addEventListener("pointerdown", (e) => { e.preventDefault(); move(e.clientX, e.clientY); });
    ov.addEventListener("pointerup", (e) => {
      const p = pixelAt(e.clientX, e.clientY);
      if (p) finish({ hex: hexOf(p.x, p.y) });
    });
    ov.addEventListener("contextmenu", (e) => e.preventDefault());
    addEventListener("keydown", onKey, true);
    document.body.append(ov);
    ov.tabIndex = -1; ov.focus({ preventScroll: true });
  });
}
