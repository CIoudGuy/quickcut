// QuickCut Photo: the Upscale action (UI side). The AI itself runs in upscale.js (a Worker); this file
// is its panel in the Size dialog (Fast / Max, scale), the progress card and how the result goes into the document.
// photo.js hands in what it owns (document, undo, worker calls, popups) as `a`; see UPSCALE.md.
import { icon, h, esc, toast } from "../shared/ui.js";

const IC = "M2.5 7.5h6v6h-6zM7 9l6.5-6.5M9.5 2.5h4v4"; // a small square growing into a big one
const QUALITIES = [["fast", "Fast"], ["max", "Max"]];
const SCALES = [2, 4];
const fmtMB = (b) => `${Math.round(b / 1e6)} MB`;
const store = {
  get(k, d) { try { return localStorage.getItem("quickcut.photo." + k) || d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("quickcut.photo." + k, v); } catch {} },
};

export function createUpscale(a) {
  const st = { job: null, el: null, info: null };
  const quality = () => (store.get("upq", "fast") === "max" ? "max" : "fast");
  const scale = () => (store.get("ups", "2") === "4" ? 4 : 2);
  /** Where the AI runs: shared with the background remover's choice (GPU unless the user picked CPU). */
  const ep = () => { try { return new URLSearchParams(location.search).get("bgep") || (localStorage.getItem("quickcut.photo.bgep") === "wasm" ? "wasm" : "auto"); } catch { return "auto"; } };
  const imageLayer = (l) => l && !l.group && l.kind !== "text";

  async function status(model = quality()) { st.info = await a.call("up", { op: "status", model }); return st.info; }

  /** Why a quality can't run here ("" when it can). */
  function whyNot(q, info = st.info) {
    if (q === "fast") return "";
    if (a.lowMem()) return "Not enough memory";
    if (ep() === "wasm") return "Needs the GPU (Run on: GPU)";
    return info?.models?.[q]?.unfit || "";
  }
  const pickQuality = () => (whyNot(quality()) ? "fast" : quality());
  /** The largest output side/area the document can take: ×4 of a big photo doesn't fit, ×2 may. */
  const fits = (l, s) => !a.tooBig(Math.round(l.canvas.width * s), Math.round(l.canvas.height * s)) && !a.tooBig(Math.round(a.doc().w * s), Math.round(a.doc().h * s));
  const sizeOf = (q) => {
    const m = st.info?.models?.[q];
    if (!m) return "";
    return m.bytes ? `${icon("download", 12)}${fmtMB(m.bytes)}` : fmtMB(m.size);
  };

  // ── the picker ───────────────────────────────────────────────────────────
  const qualityHtml = () => {
    const cur = pickQuality();
    return `<div class="field-label ph-q"><span class="row-between">Quality</span><div class="ph-qlist" role="radiogroup" aria-label="Quality">${QUALITIES.map(([id, n]) => { const no = whyNot(id); return `<button type="button" role="radio" data-uq="${id}" aria-checked="${cur === id}" ${no ? `aria-disabled="true" data-no="${esc(no)}" title="${n}: ${esc(no)}"` : `title="${n}"`}><span class="n">${n}</span><span class="sz">${sizeOf(id)}</span></button>`; }).join("")}</div></div>`;
  };
  const scaleHtml = () => {
    const l = a.selLayer(), cur = scale();
    return `<div class="field-label"><span class="row-between">Scale</span><div class="seg fill" role="radiogroup" aria-label="Scale">${SCALES.map((s) => { const no = l && !fits(l, s) ? "Too big" : ""; return `<button type="button" role="radio" data-us="${s}" aria-checked="${cur === s}" ${no ? `aria-disabled="true" data-no="${no}" title="×${s}: ${no}"` : `title="×${s}"`}>×${s}</button>`; }).join("")}</div></div>`;
  };
  const epHtml = () => {
    const cur = ep() === "wasm" ? "wasm" : "auto", g = st.info?.gpu, noGpu = g && (!g.webgpu || g.fallback) ? "No GPU access in this browser" : "";
    return `<div class="field-label"><span class="row-between">Run on</span><div class="seg fill" role="radiogroup" aria-label="Run on">${[["auto", "GPU", noGpu], ["wasm", "CPU", ""]].map(([id, n, no]) => `<button type="button" role="radio" data-uep="${id}" aria-checked="${cur === id}" ${no ? `aria-disabled="true" data-no="${esc(no)}" title="${n}: ${esc(no)}"` : `title="${n}"`}>${n}</button>`).join("")}</div></div>`;
  };
  function storedRows(el) {
    const box = h(`<div class="ph-stored"></div>`);
    const fill = () => {
      const ms = Object.entries(st.info?.models || {}).filter(([, m]) => m.cached);
      box.replaceChildren(...ms.map(([id, m]) => {
        const r = h(`<div class="row-between small"><span class="t"></span><button class="btn-g sm" type="button">Remove</button></div>`);
        r.querySelector(".t").textContent = `Downloaded model (${QUALITIES.find((x) => x[0] === id)?.[1] || id}) · ${fmtMB(m.size)}`;
        r.querySelector("button").onclick = async () => {
          r.querySelector("button").disabled = true;
          if (st.job) cancel();
          try { await a.call("up", { op: "remove", models: [id] }); } catch (err) { toast(`Couldn't remove it: ${err.message}`, { bad: true }); }
          a.kill("up");
          toast("Model removed", { info: true, ms: 1500 });
          try { await status(); } catch {}
          fill();
          refresh(el);
        };
        return r;
      }));
      box.hidden = !ms.length;
    };
    fill();
    return box;
  }
  function refresh(el) {
    el.querySelector(".ph-q").outerHTML = qualityHtml();
    el.querySelector('[data-us]')?.closest(".field-label").replaceWith(h(scaleHtml()));
  }
  function bindPicker(el, onChange) {
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-uq],[data-us],[data-uep]");
      if (!b) return;
      if (b.getAttribute("aria-disabled") === "true") { toast(b.dataset.no || "Not available here", { info: true, ms: 4000 }); return; }
      if (b.dataset.uq) store.set("upq", b.dataset.uq);
      else if (b.dataset.us) store.set("ups", b.dataset.us);
      else {
        // the same switch as the background remover's (one "where the AI runs" for the whole tool)
        try { if (b.dataset.uep === "wasm") localStorage.setItem("quickcut.photo.bgep", "wasm"); else localStorage.removeItem("quickcut.photo.bgep"); } catch {}
        if (!st.job) { a.kill("up"); a.kill("bg"); }
      }
      const sel = (attr, v) => { for (const x of el.querySelectorAll(`[${attr}]`)) x.setAttribute("aria-checked", String(x.getAttribute(attr) === String(v))); };
      sel("data-uq", pickQuality()); sel("data-us", scale()); sel("data-uep", ep() === "wasm" ? "wasm" : "auto");
      onChange?.();
    });
  }
  /** The Upscale side of the Size dialog (photo.js puts it next to Resize): quality, scale, where the
   *  AI runs, downloaded models and the button. `close` closes the dialog. */
  function panel(close) {
    const el = h(`<div class="ph-up" hidden>${qualityHtml()}${scaleHtml()}${epHtml()}<button class="btn-p big" type="button" data-b="go"></button></div>`);
    const goBtn = el.querySelector('[data-b="go"]');
    const label = () => {
      const m = st.info?.models?.[pickQuality()];
      goBtn.innerHTML = m?.bytes ? `${icon("download")}Download ${fmtMB(m.bytes)} and upscale<span class="kbd desk-only">↵</span>` : `${icon(IC)}Upscale<span class="kbd desk-only">↵</span>`;
    };
    label();
    bindPicker(el, label);
    const go = () => { close(); try { navigator.storage?.persist?.().catch(() => {}); } catch {} start(); };
    goBtn.onclick = go;
    let loaded = false;
    /** Called when the panel is shown: what is downloaded, what this device can run. */
    const show = async () => {
      warm();
      if (loaded) return;
      loaded = true;
      try { await status(); } catch { loaded = false; return; }
      if (!el.isConnected) return;
      el.querySelector(".ph-q").outerHTML = qualityHtml();
      el.querySelector("[data-us]").closest(".field-label").outerHTML = scaleHtml();
      el.querySelector("[data-uep]").closest(".field-label").outerHTML = epHtml();
      goBtn.before(storedRows(el));
      label();
    };
    return { el, show, go };
  }

  // ── progress card (same look as the background remover's) ────────────────
  function card() {
    if (st.el) return st.el;
    st.el = h(`<div class="ph-bgjob float" role="status" aria-live="polite">
      <span class="t"><b>Upscaling</b><span class="s">Starting…</span></span>
      <span class="progress"><span></span></span>
      <button class="btn-g sm" type="button">Cancel<span class="kbd desk-only">Esc</span></button></div>`);
    st.el.querySelector("button").onclick = cancel;
    a.stage.append(st.el);
    return st.el;
  }
  function prog(text, f) {
    const el = card();
    el.querySelector(".s").textContent = text;
    const pr = el.querySelector(".progress");
    pr.classList.toggle("indeterminate", f == null);
    pr.firstElementChild.style.width = f == null ? "" : `${Math.round(f * 100)}%`;
  }
  function end() { st.job = null; st.el?.remove(); st.el = null; a.sync(); }
  function cancel() {
    if (!st.job) return false;
    st.job.cancelled = true;
    a.kill("up");
    end();
    toast("Cancelled", { info: true, ms: 1500 });
    return true;
  }
  const busy = () => !!st.job;

  // ── the action ───────────────────────────────────────────────────────────
  /** Hovering the button starts the AI (if it was downloaded before), so the click is quick. */
  function warm() {
    if (st.job || st.warm) return;
    st.warm = a.call("up", { op: "warm", model: pickQuality(), ep: ep() }).catch(() => null).finally(() => { st.warm = null; });
  }
  async function start() {
    const l = a.selLayer();
    if (!imageLayer(l)) { toast("Pick a photo layer", { bad: true }); return; }
    if (st.job) return;
    a.commit();
    const job = (st.job = { cancelled: false, t0: performance.now() });
    prog("Starting…", null);
    a.sync();
    let info;
    try { info = await status(pickQuality()); }
    catch (e) { if (job.cancelled) return; end(); toast(e.message || "Not available", { bad: true }); return; }
    if (job.cancelled) return;
    const q = pickQuality();
    let s = scale();
    if (!fits(l, s)) { const alt = SCALES.filter((x) => x < s && fits(l, x)).pop(); if (!alt) { end(); toast(a.tooBigMsg(l.canvas.width * 2, l.canvas.height * 2), { bad: true }); return; } s = alt; }
    work(l, q, s, job);
  }
  async function work(l, q, s, job) {
    // after the background remover the layer has two copies of its pixels (the photo and the one with
    // cleaned edge colours): the AI upscales the photo, and both copies come out at the new size
    const pair = l.preBg && l.bgFixed && (l.canvas === l.preBg || l.canvas === l.bgFixed) ? { photo: l.preBg, clean: l.bgFixed, on: l.canvas === l.bgFixed } : null;
    const d = a.doc(), layerId = l.id, src = pair ? pair.photo : l.canvas;
    // what to try, in order: the chosen model; if the GPU fails, the small one on the GPU, then on the CPU
    const tries = [{ model: q, ep: ep() }];
    if (q !== "fast") tries.push({ model: "fast", ep: ep() });
    if (ep() !== "wasm") tries.push({ model: "fast", ep: "wasm" });
    let r = null, used = null, lastErr = null;
    for (const t of tries) {
      if (job.cancelled) return;
      try {
        const ini = await a.call("up", { op: "init", model: t.model, ep: t.ep }, [], (p) => { if (p.stage === "download") prog("Downloading model", p.total ? p.loaded / p.total : null); else if (p.stage === "load") prog("Loading model", null); });
        if (job.cancelled) return;
        if (t.model !== "fast" && ini.ep !== "webgpu") throw new Error("GPU unavailable");
        const bmp = await createImageBitmap(src);
        r = await a.call("up", { op: "run", bitmap: bmp, scale: s }, [bmp], (p) => { if (p.stage === "run") prog(`Upscaling · ${Math.round((p.f || 0) * 100)}%`, p.f ?? null); });
        used = { ...t, ini };
        break;
      } catch (e) {
        if (job.cancelled || e.message === "cancelled") return;
        lastErr = e; console.warn("upscale:", t, e);
        a.kill("up");
      }
    }
    if (job.cancelled) return;
    if (!r) { end(); toast(`Couldn't upscale: ${lastErr?.message || "failed"}`, { bad: true }); return; }
    try {
      if (a.doc() !== d || !d.layers.some((x) => x.id === layerId)) { r.bitmap.close(); end(); return; }
      const NW = r.w, NH = r.h, big = a.blank(NW, NH);
      big.getContext("2d").drawImage(r.bitmap, 0, 0);
      r.bitmap.close();
      // every layer scales with the document; this one gets the AI's pixels instead of a resampled copy,
      // and its matrix stays the same (4× the pixels, so 1/s of the scale it would otherwise have)
      const tweak = (x) => {
        if (x.id !== layerId) return;
        if (pair && x.preBg === pair.photo && x.bgFixed === pair.clean) {
          // the cleaned copy = the upscaled photo with the cleaned pixels (only the edge band differs
          // from the photo) resampled over it; hiding the mask or Keep still shows the upscaled photo
          const w0 = pair.photo.width, h0 = pair.photo.height;
          const pd = pair.photo.getContext("2d").getImageData(0, 0, w0, h0).data, ci = pair.clean.getContext("2d").getImageData(0, 0, w0, h0), cd = ci.data;
          for (let i = 0; i < cd.length; i += 4) if (cd[i] === pd[i] && cd[i + 1] === pd[i + 1] && cd[i + 2] === pd[i + 2]) cd[i + 3] = 0;
          const band = a.blank(w0, h0);
          band.getContext("2d").putImageData(ci, 0, 0);
          const clean = a.blank(NW, NH), cg = clean.getContext("2d");
          cg.drawImage(big, 0, 0);
          cg.imageSmoothingQuality = "high";
          cg.drawImage(band, 0, 0, NW, NH);
          x.preBg = big; x.bgFixed = clean; x.canvas = pair.on ? clean : big;
        } else { x.canvas = big; delete x.preBg; delete x.bgFixed; }
        a.setLm(x, [...a.lin(x).map((v) => v / s), x.x, x.y]);
        if (x.mask) {
          const m = a.blank(NW, NH), mg = m.getContext("2d");
          mg.imageSmoothingQuality = "high";
          mg.drawImage(x.mask, 0, 0, NW, NH);
          Object.assign(x, { mask: m, maskBase: a.alphaOf(m), maskShift: 0, maskSoft: 0 });
        }
      };
      const ok = a.resize(Math.round(d.w * s), Math.round(d.h * s), tweak, `Upscale ×${s}`);
      const ms = performance.now() - job.t0;
      st.stats = { ...r.ms, ep: r.ep, tiles: r.tiles, wall: Math.round(ms), w: r.w, h: r.h, scale: s, quality: used.model, requested: q, fellBack: used.model !== q || used.ep !== tries[0].ep };
      end();
      if (!ok) { toast("Couldn't upscale", { bad: true }); return; }
      const note = used.model !== q ? ` (${QUALITIES.find((x) => x[0] === q)[1]} didn't fit this device, so Fast was used)` : "";
      toast(`Upscaled ×${s} · ${(ms / 1000).toFixed(1)} s${note}`, { ms: 6000, action: "Undo", onAction: a.undo });
    } catch (e) {
      end();
      toast(`Couldn't upscale: ${e.message}`, { bad: true });
    }
  }
  return { panel, start, warm, cancel, busy, status: () => status(), get stats() { return st.stats; } };
}
