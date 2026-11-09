# Background remover (Photo)

One click (**Remove background** in the Layers footer or the Move bar, or **Shift B**) cuts the
subject out of the selected layer as a **layer mask**: the layer's pixels stay, the mask hides the
background, and undo, the mask switch, Delete mask and the Keep / Remove brush (**Q**) all work on
it. Everything runs in the browser in a worker (`bg.js`); the models and the ONNX Runtime
WebAssembly binary come from this site only (`../models/`, `../vendor/ort/`, see
`../models/README.md`).

## Models (all MIT, 4-bit MatMul weights)

| Quality | Model | Download | Needs |
|---|---|---|---|
| **Fast** | BiRefNet 512×512 (`birefnet-512`, file `birefnet-512-v2/`) | 194 MB | anything (WebGPU, else CPU) |
| **High detail** | BiRefNet general 1024×1024 (`birefnet-1024`) | 210 MB, optional | WebGPU with 16-bit floats, ≥ 1 GB buffers, ≥ 8 GB RAM |
| **Hair & fur** | BiRefNet-matting 1024×1024 (`birefnet-matting-1024`) | 208 MB, optional | as High detail |

Rule: permissive licence only (MIT / Apache-2.0 / BSD). Out: RMBG-1.4 (BRIA non-commercial),
RMBG-2.0 (CC BY-NC 4.0), BEN2 full (commercial), the onnx-community ISNet export (AGPL).

### Why the 1024 models run now (they "ran out of WebAssembly memory" before)

ONNX Runtime's WebGPU backend has no float16 `Sum` kernel. The exported deformable convolutions
end in 4-input `Sum` nodes, so those ran on the CPU in float32 with an inserted cast for every
input: at 1024² that is 4 × 822 MB per Sum, and the run died with `std::bad_alloc`. `fetch.py`
rewrites each Sum as Adds (same maths), so everything stays on the GPU. The same fix on the 512
model (`birefnet-512-v2`) made Fast **3× faster** (inference 0.99 → 0.34 s) and shrank the worker
from **2.1 GB to 0.7 GB** at 12 MP (the "High memory usage" the owner saw); its masks are the same
(metrics equal to 3 digits; at most 12/255 difference on single pixels from float16 rounding).
Also needed: wide Split/Concat rewritten as trees (WebGPU allows 16 storage buffers per shader),
and the fp32 matting export converted to fp16 with its internal Cast nodes fixed.

### What was tried (Chrome, ONNX Runtime Web 1.31.1, WebGPU on an RTX 5080, 2026-11-09)

| Model | Runs? | 12 MP, warm | GPU memory at peak | Notes |
|---|---|---|---|---|
| BiRefNet 512, old file (Sum on CPU) | yes | 1.8–2.6 s | ≈ +2.4 GB | worker 2.1 GB |
| **BiRefNet 512 v2 (Fast)** | yes | **1.2–1.6 s** | ≈ +2.4 GB | worker 0.7 GB |
| BiRefNet 512 + 2×2/3×3 tiles (old High detail) | yes | 12.1–13.2 s | ≈ +2.4 GB | |
| **BiRefNet general 1024 (High detail)** | **yes** | **1.6–2.0 s** (+4–5 s to start the model) | ≈ +5.5 GB | chosen |
| BiRefNet general 1024 + tiles | yes | 6.1–6.6 s | ≈ +6 GB | better boundaries, 4× slower (not used) |
| BiRefNet-matting 1024 | yes | 1.7–2.1 s | ≈ +5.5–8 GB | soft hair/fur/glass, see-through patches on illustrations |
| BiRefNet HR general 2048 (q4, 273 MB) | yes | ≈ 5 s inference alone | ≈ +12 GB | too much GPU memory for normal desktops |
| BiRefNet HR-matting 2048, BEN2 base, lite 1024 | earlier | | | worse on our set / not tried again |

GPU memory is `nvidia-smi` "used" during the run minus before it; other programs on this PC move
it by ±1 GB, so read it as approximate. Setting ONNX Runtime's WebGPU buffer cache to "simple" or
"disabled" didn't help (higher peak / buffer-destroyed error); the default "bucket" stays.

### Measured quality

**Test set** (`../_test/bg/`, regenerated 2026-11-09 by a script; deleted again afterwards, only
`compare.png` kept): 14 synthetic composites with exact mattes, 2400×1800: hair (dark on bokeh,
blond on sky), a fur animal on foliage, a dandelion (thin filaments) on dark and on a busy
picture, a racket (string grid with holes) on foliage, a wine glass (35 % opaque body) on light and
on bokeh, and the owner's three Picsart glove cut-outs over sky and foliage. Plus the owner's 4
originals compared with Picsart's results (Picsart is a reference, not ground truth).

Metrics (synthetic, mean of 14): alpha MSE ×1e3, MSE in the edge band (≤ 8 px from a soft or
boundary pixel), gradient error ×1e3 (Gaussian-derivative σ 1.4), boundary F-measure (α > 0.5
outlines, 3 px tolerance), "holes" = % of the surely-opaque interior that came out < 0.9.

| | MSE ↓ | edge MSE ↓ | grad ↓ | boundary F ↑ | holes % ↓ |
|---|---|---|---|---|---|
| Fast (512 + refinement) | 23.3 | 84.9 | 0.267 | 0.622 | 0.02 |
| old High detail (512 + tiles) | 16.7 | 70.5 | 0.244 | 0.635 | 0.02 |
| **High detail (1024 + refinement)** | 29.5 | 105.4 | 0.187 | **0.735** | **0.00** |
| 1024 + tiles | 26.5 | 91.0 | 0.157 | 0.766 | 0.00 |
| matting 1024 | **4.6** | **31.5** | 0.179 | 0.729 | 0.16 |
| HR general 2048 | 5.3 | 42.4 | 0.077 | 0.867 | 0.08 |

Against Picsart on the owner's originals (mean |alpha difference| ×1000 · IoU; lower/higher is
closer to Picsart):

| | glove (rainbow) | glove (green) | glove (fire) | sound wave |
|---|---|---|---|---|
| Fast | 15.0 · 0.963 | 3.5 · 0.992 | 2.8 · 0.994 | 70.9 · 0.791 |
| old High detail | 13.6 · 0.967 | 3.0 · 0.993 | 2.3 · 0.995 | 70.9 · 0.791 |
| **High detail (1024)** | **9.4 · 0.977** | **2.6 · 0.993** | **2.1 · 0.995** | **59.4 · 0.838** |
| matting 1024 | 25.9 · 0.950 | 6.3 · 0.983 | 2.5 · 0.994 | 100.2 · 0.589 |
| HR 2048 | 10.7 · 0.974 | 2.7 · 0.993 | 2.1 · 0.995 | 117.2 · 0.446 |

**Reading it honestly:** no model that fits a normal desktop GPU wins everything.
- **BiRefNet 1024 (High detail)** is the best on the owner's real images (closest to Picsart on all
  four, solid interiors, keeps the cat's whiskers in `compare.png`), has the best boundaries of the
  usable options, and is as fast as Fast. Its weakness: it is nearly binary, so loose hair and fur
  come out as an opaque "helmet" that keeps some old background colour between the strands (see the
  fur and hair rows of `compare.png`); that is why its alpha MSE on the synthetic hair/fur/dandelion
  cases is worse than the 512 model's (which is softer simply because it is blurrier).
- **BiRefNet-matting 1024** gives by far the best soft alpha (hair, fur, glass: MSE 4.6 vs 16.7),
  but it makes light parts of solid subjects partly see-through (11 % of the rainbow glove's
  interior; the green glove's skull) and loses the cat's whiskers. Good as a separate "Hair & fur"
  choice, not as the default high-quality mode.
- Tiles on top of 1024 help a little (boundary F 0.735 → 0.766) for 4× the time (6+ s at 12 MP),
  so High detail doesn't use them (`"tiles": false` in the manifest).
- Fusing 1024 and matting (offline test: matting result, made solid inside the 1024 model's core)
  only gave a compromise (MSE 13–17, Picsart rainbow glove 17–22) for two downloads; dropped.

### Refinement (unchanged)

The model's mask is refined at **full resolution**: colour **guided filter** in the uncertain band
around edges, then **edge-colour clean-up** (blur-fusion foreground estimation, Forte & Pitié
2021). It helps every model (1024: MSE 32.7 → 29.5, boundary F 0.711 → 0.735; matting:
5.9 → 4.6).

## Speed and memory (RTX 5080, Chrome headless, 12 MP photo)

| | first click (model cached) | warm |
|---|---|---|
| Fast | ≈ 6–7 s (start 5–6 s) | 1.2–1.6 s |
| High detail | ≈ 6–7 s (start 4–5 s) | 1.6–2.0 s |

Memory of the test browser (private bytes; page loaded = 0.3 GB):

| | worker (renderer) | GPU process | total |
|---|---|---|---|
| after a 12 MP High detail run | 0.73 GB | 5.9 GB | 6.8 GB |
| 60 s later (session released by `bg.js`) | 0.68 GB | 0.6 GB | 1.5 GB |
| worker ended (what the page should do on `{idle}`) | 0.05 GB | 0.58 GB | 0.8 GB |
| after a 12 MP Fast run, old file | 2.1 GB | 2.4 GB | 4.7 GB |
| after a 12 MP Fast run, v2 | 0.69 GB | 3.1 GB | 3.9 GB |

## Worker protocol (`bg.js`)

- `status {model}` → `{cached, bytes, models: {id: {size, cached, bytes, unfit, …}}, stored, runtime, gpu}`.
  `unfit` is the reason a model can't run here ("" when it can); `stored` is what is on the device.
- `init {model, ep}`, `run {bitmap, opts}`, `warm {model, ep}`: as before. Each posts a
  `{progress, stage: "start"}` at once, before any queued work or module loading (ONNX Runtime
  itself is now imported on first use, so `status` answers quickly).
- `cancel` (not queued): aborts the downloads in flight; the pending `init` fails with
  `{error: "cancelled", cancelled: true}` and the worker stays usable.
- `remove {models?}`: releases the session and deletes those models (all when none given) from
  Cache Storage, and the runtime too once no model is left → `{freed, left}`. The next use
  downloads again.
- `{idle: true}` (no id): sent after 60 s without work, once the session (GPU buffers) is released.
  The page should end the worker then (frees the WebAssembly heap, which never shrinks).
- Cache rules: a file is written to Cache Storage only after its full SHA-256 check; a cached
  entry of the wrong size is deleted and downloaded again; files the manifest no longer lists are
  deleted when the worker starts.

Tested (headless Chrome): cancel at the first progress event (~26–35 %, a local download is fast),
at 100 % (during verification/caching) with `cancel` and with `terminate()`, and during a run;
Cache Storage never held a partial file, and a retry downloaded, verified and ran normally.
`remove` of one model freed 208 MB (`navigator.storage.estimate()` 641 → 432 MB), of all 432 MB
(→ 0 MB); the next High detail use downloaded again (0.7 s from localhost) and worked.

## Devices and fallbacks (feature detection only)

- WebGPU adapter requested with `powerPreference: "high-performance"` and handed to ONNX Runtime.
- High detail (and matting) need WebGPU with `shader-f16`, ≥ 1 GB buffers and ≥ 8 GB of device
  memory (`status.models[id].unfit` gives the reason). Browsers can't report GPU memory; on a GPU
  with less than ≈ 6 GB free, Windows pages GPU memory to system RAM (slower), and if the run fails
  the page falls back to Fast, then to the CPU: there is always a result.
- Phones / ≤ 4 GB devices: only Fast; big photos (> 12 MP) skip the colour clean-up.

## CPU: several threads, and why there is no "Lite" model (2026-11-09)

- The page is served cross-origin isolated (COOP `same-origin` + COEP `credentialless`), so ONNX Runtime's
  CPU path runs on up to 8 threads instead of 1. Measured on a 12 MP photo, Fast on the CPU: about 22 s
  → 8 s (4 threads) for the model run, no change in quality. Safari ignores COEP `credentialless` and
  keeps 1 thread. Users can choose where the AI runs (menu next to Remove background: GPU / CPU,
  remembered); a GPU run that falls back to the CPU offers "Always CPU".
- BiRefNet_lite (Swin-T, MIT), exported at 512×512 and prepared like the others (58 MB), was measured
  as a "Lite" option for weak devices and **not added**: 3–3.5× faster on the CPU once loaded, but only
  1.6–1.9× faster on a first click (model start dominates), and clearly worse cut-outs (edge MSE 215 vs
  120 on the synthetic set, whole-subject losses such as a dark head on a dark background, holes in
  solid areas 30× more often). Multi-threading gives most of its speed-up with no quality loss.

