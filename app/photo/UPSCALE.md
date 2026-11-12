# Upscale (Photo)

**Upscale** in the Move bar (image layers; the arrow next to it picks the model and the scale) enlarges
the document ×2 or ×4 with an AI model. The selected layer gets the AI's pixels, every other layer scales
like **Resize image** (smart layers: matrix only), text is redrawn. One undo step; a mask grows with its
layer. Everything runs in the browser in a worker (`upscale.js`); the models and the ONNX Runtime
WebAssembly binary come from this site only (`../models/`, `../vendor/ort/`, see `../models/README.md`).
The page side (button, picker, progress card, how the result enters the document) is `upscale-ui.js`;
`photo.js` only creates it and gives it the document, undo and the worker pool.

Status: wired **locally**, nothing uploaded or published (2026-11-09).

## The models

| | Model | Licence (code and weights) | Download | Needs |
|---|---|---|---|---|
| **Fast** | 4xLSDIRCompactC3, Philip Hofmann (SRVGGNetCompact, 0.6 M parameters) | CC BY 4.0 (weights), BSD-3-Clause (network, Real-ESRGAN) | 2.5 MB | anything: WebGPU, else CPU (WASM) |
| **Max** | SwinIR-L real-world ×4 GAN (28 M parameters, `003_realSR_BSRGAN_DFOWMFC_s64w8_SwinIR-L_x4_GAN`) | Apache-2.0 (code and weights, official release) | 64 MB (float16) | WebGPU with 16-bit floats, ≥ 8 GB RAM |

Both are ×4 networks. ×2 is the same network with its output averaged 2×2 (cost per input pixel is the
same; there is no cheaper ×2 network of this quality). Both run through **seamless tiles**: 128×128
input tiles, 16 px overlap, mirrored context at the picture's edges, each tile blended into the output
with a linear ramp across the overlap. Memory therefore does not depend on the picture size (a 5000×4000
photo ×2 = 80 MP output worked, 19 s on Fast). Alpha is resized smoothly and re-applied (the network sees colour only).

Default: Fast (Max is an optional download, like the background remover's bigger models). The
choice and the scale are remembered (`quickcut.photo.upq`, `quickcut.photo.ups`); where it runs (GPU /
CPU) is the background remover's switch (`quickcut.photo.bgep`). If Max fails on the GPU, Fast runs on
the GPU, then on the CPU: there is always a result. A ×4 that doesn't fit the canvas limit
(16384 px side, 80 MP) becomes ×2 if that fits.

## Strength, and a third quality that was tried (2026-11-11)

Max and Fast are trained to look sharp, and on faces, skin and fur that reads as an "AI look": smooth,
waxy surfaces and texture the picture never had.

- **Strength** (10–100 %, any quality): below 100 % the plain, smooth resize is mixed back in
  (in the worker, colour only), which tones down whatever the network added.
- **"Natural"**, a third quality (4xBHI_dat2_real, Philip Hofmann, CC BY 4.0, 54 MB): of the models
  tried it keeps the most of the picture's own grain and texture while still sharpening, and it handles
  JPEG input. It was live for a day and taken out again at the owner's request: two choices (Fast, Max)
  and the Strength slider. Its numbers are kept below; adding it back is one `fetch.py` entry and one
  line in `upscale-ui.js`.

Measured in the browser (WebGPU, the real worker): four 1200×800 photos (a portrait, a dog, a castle, a
lion) and a crop of a game thumbnail, shrunk ×4 and upscaled ×4; PSNR against the original (higher =
closer to it). "JPEG" = the small picture saved as JPEG quality 60 first.

| | portrait | dog | castle | lion | thumbnail | portrait JPEG | castle JPEG |
|---|---|---|---|---|---|---|---|
| plain resize | 40.06 | 29.40 | 26.41 | 29.77 | 25.51 | 36.34 | 25.49 |
| Fast | 37.87 | 28.74 | 25.23 | 28.47 | 29.55 | 35.84 | 24.63 |
| Max (SwinIR-L GAN) | 36.53 | 25.14 | 24.78 | 28.24 | 27.99 | 34.75 | 24.14 |
| "Natural" (BHI dat2, removed) | 38.68 | 27.18 | 25.88 | 28.72 | **31.58** | 35.38 | 24.42 |
| SwinIR-L real-world PSNR weights | 38.55 | 28.73 | 26.54 | 30.26 | 30.06 | 36.34 | 25.79 |
| SwinIR-M classical ×4 (DF2K) | **41.24** | **30.84** | **26.65** | 30.09 | 30.57 | 35.86 | 25.21 |

By eye:
- **"Natural"**: closer to the original than Max on all seven; skin keeps its grain, the castle's windows
  and the lion's fur are crisp without Max's smoothing. On the dog's short fur it draws a faint woven
  pattern (Strength 70 % softens it).
- **SwinIR-L PSNR weights** (same network as Max, the release's non-GAN file): good numbers, but the
  result looks painted: flat, smeared areas with sharp outlines. Not added.
- **SwinIR-M classical** (trained on clean bicubic pairs only): the closest on clean photos, but it
  amplifies JPEG blocks into a grid and doubles hard edges on drawn art, so it is unsafe as a general
  choice. It also overflows in float16 (black output) and needs the 60 MB float32 file. Not added.

Speed on the same GPU: "Natural" 4.9 s and Max 4.5 s for 680×384 → 2720×1536.

## What was measured

Test sets (all deleted afterwards; downloaded from Hugging Face / ETH, not shipped):
- **RealSR v3** (Canon + Nikon, ×4 *real* low/high pairs from a camera's focal lengths; `Xeno73/RealSR`):
  every 4th of the 100 test pairs = **25 photos** (signs, text, foliage, facades, fabric, faces on posters).
  The pairs are not pixel-aligned and differ in colour a little, so PSNR/SSIM punish sharp output: plain
  bicubic gets the best PSNR there. Read LPIPS/DISTS first.
- **DIV2K-JPEG**: 20 DIV2K validation photos, centre 1024² crop, downscaled ×4 (bicubic) and JPEG-compressed
  at quality 55: web-style input with ground truth.
- A 9-image mixed set (7 RealSR, 2 JPEG), see the end.
PSNR/SSIM on the Y channel, 4 px shaved; LPIPS (AlexNet) and DISTS on RGB. PyTorch fp32, tiles of 192.

### RealSR, 25 real photo pairs

| Model | Params | PSNR | SSIM | LPIPS ↓ | DISTS ↓ | Licence |
|---|---|---|---|---|---|---|
| bicubic | | 26.81 | 0.753 | 0.474 | 0.241 | |
| realesr-general-x4v3 | 1.2 M | 24.57 | 0.772 | 0.306 | 0.211 | BSD-3 |
| 4xLSDIRCompact | 0.6 M | 27.05 | 0.763 | 0.402 | 0.211 | CC BY 4.0 |
| 4xLSDIRCompactC | 0.6 M | 27.01 | 0.766 | 0.353 | 0.207 | CC BY 4.0 |
| **4xLSDIRCompactC3 (Fast)** | 0.6 M | 26.97 | 0.766 | 0.360 | 0.209 | CC BY 4.0 |
| 4xLSDIRCompactCR3 | 0.6 M | 26.91 | 0.764 | 0.333 | 0.218 | CC BY 4.0 |
| 4xLSDIRCompactN / R / R3 | 0.6 M | 27.06 / 23.90 / 23.81 | 0.763 / 0.688 / 0.695 | 0.400 / 0.394 / 0.375 | 0.211 / 0.246 / 0.237 | CC BY 4.0 |
| 4xNomosUni_span_multijpg (SPAN) | 2.2 M | 26.59 | 0.759 | 0.339 | 0.223 | CC BY 4.0 (net Apache-2.0) |
| 4xNomosWebPhoto_RealPLKSR | 7.4 M | 25.57 | 0.739 | 0.291 | 0.197 | "CC-BY-0.4" (typo, unclear) |
| Real-ESRGAN x4plus | 16.7 M | 25.34 | 0.759 | 0.281 | 0.177 | BSD-3 |
| 4xNomosWebPhoto_esrgan | 16.7 M | 24.90 | 0.691 | 0.375 | 0.223 | "CC-BY-0.4" (unclear) |
| 4xRealWebPhoto_v4_dat2 (DAT-2) | 11.2 M | 26.47 | 0.775 | 0.281 | 0.183 | CC-BY-4.0 |
| 4xBHI_dat2_real (DAT-2) | 11.2 M | **27.11** | **0.790** | 0.276 | 0.173 | CC-BY-4.0 |
| 4xNomos8k_atd_jpg (ATD) | 20.3 M | 26.68 | 0.771 | 0.267 | 0.176 | CC BY 4.0 |
| 4xRealWebPhoto_v4_drct-l (DRCT-L) | 27.6 M | 26.21 | 0.770 | 0.286 | 0.181 | "CC-BY-0.4" (unclear) |
| **SwinIR-L real GAN (Max)** | 28.0 M | 26.00 | 0.778 | **0.254** | **0.159** | Apache-2.0 |

### DIV2K-JPEG (×4, quality 55), 20 photos

| Model | PSNR | SSIM | LPIPS ↓ | DISTS ↓ |
|---|---|---|---|---|
| bicubic | 25.66 | 0.674 | 0.629 | 0.277 |
| realesr-general-x4v3 | 23.95 | 0.680 | 0.373 | 0.204 |
| 4xLSDIRCompact | 25.09 | 0.651 | 0.449 | 0.226 |
| **4xLSDIRCompactC3 (Fast)** | 25.02 | 0.658 | 0.326 | 0.178 |
| SPAN-NomosUni | 24.90 | 0.661 | 0.355 | 0.207 |
| RealPLKSR | 23.72 | 0.623 | 0.324 | 0.171 |
| Real-ESRGAN x4plus | 24.05 | 0.665 | 0.298 | 0.163 |
| RealWebPhoto-dat2 | 24.76 | 0.658 | 0.284 | 0.160 |
| BHI-dat2-real | 24.57 | 0.668 | 0.286 | 0.170 |
| Nomos8k-atd-jpg | 25.13 | 0.672 | 0.289 | 0.177 |
| DRCT-L | 23.80 | 0.633 | 0.337 | 0.179 |
| **SwinIR-L (Max)** | 24.39 | 0.675 | **0.279** | **0.151** |

### Looking at it (faces, text, foliage, fur, JPEG, crops compared by eye)

- **SwinIR-L**: the cleanest edges and text without halos, natural fur and foliage; best DISTS and LPIPS on both sets and on
  the 9-image mixed set (below). BHI-dat2 is a little softer but has the best PSNR/SSIM; ATD and DRCT-L land between.
- **Real-ESRGAN x4plus** and **general-x4v3**: crisp, but darker/heavier text strokes, and general-x4v3 turns fur and
  hair into smooth "plastic" on JPEG input (the penguin crop of DIV2K 0801).
- **LSDIRCompactC3**: calm and faithful (+1 to +2.4 dB PSNR over general-x4v3), keeps fur texture and
  removes JPEG blocks, but is softer on thin text than general-x4v3.
- RealPLKSR shows checkerboard artefacts on flat areas.

### Why these two

- **Max = SwinIR-L.** Best perceptual scores on both real and JPEG sets, a clean Apache-2.0 licence
  (official weights, no attribution beyond the NOTICE), and it is **faster in WebGPU than the DAT-2 models** despite 2.5× the
  parameters (DAT's many small operations): 42 ms per 64² tile vs 57 ms for BHI-dat2, both float16, on an RTX 5080.
  BHI-dat2 is the runner-up (best PSNR/SSIM, smaller: 11 M).
- **Fast = LSDIRCompactC3.** 2.5 MB, 7 ms per 128² tile on the GPU and 105 ms on 8 CPU threads (general-x4v3: 9 ms and 205 ms),
  better on JPEG input than general-x4v3 on every metric, equal DISTS and a worse LPIPS (0.360 vs 0.306) on real photos.
  It is a close call: **realesr-general-x4v3 (BSD-3, no attribution needed) is the runner-up** and a one-line swap in
  `fetch.py` if crisper (and plastic-er) results are preferred. Real-ESRGAN x4plus needs 67 MB for less than SwinIR-L.

### Not tested, and why (all as of November 2026)

- **One-step diffusion** (OSEDiff, TSD-SR, InvSR, PiSA-SR, SeedVR2, SUPIR, HYPIR): not run, too heavy for a browser and/or licence.
  OSEDiff (Apache-2.0 code) needs Stable Diffusion 2.1's UNet + text encoder; TSD-SR needs SD3-medium (Stability community
  licence); SeedVR2 (Apache-2.0) is a 3B/7B diffusion transformer; each is several GB of weights and many GB of GPU
  memory per tile, orders of magnitude beyond a 64 MB model. InvSR and CodeFormer: S-Lab licence (non-commercial);
  SUPIR and HYPIR: "SupPixel Software License Agreement" (not open); DiffBIR Apache-2.0 but SD-based and slow. Diffusion
  upscalers also invent detail (faces, text), which is a different product from a faithful upscale.
- **NTIRE 2026 efficient SR** (winner SPANV2 per a Xiaomi article, code MIT in `Amazingren/NTIRE2026_ESR`): bicubic-trained, PSNR-oriented
  ×4 for clean inputs; they cannot undo JPEG and camera noise (SPAN, its 2025 relatives, was tested above via Phhofm's real-world SPAN).
- **Newer transformers** (HAT-L, ATD, DRCT-L, DAT-2, SwinIR-L tested; MambaIR/MambaIRv2, HMA, SRFormer not): Mamba needs custom CUDA scan kernels
  (no ONNX/WebGPU path). **ATD** didn't export (`torch.sort` with `out=`); its PyTorch numbers are above.
  **HAT-L** (4xNomos8kHAT-L_otf, CC BY 4.0, 165 MB) was started but stalled on the shared GPU (minutes per photo) and was
  stopped: **no HAT-L numbers**. 4xNomosWebPhoto_atd (same network as Nomos8k_atd_jpg) was also cut for the same reason.
- OpenModelDB models with **CC BY-NC** or unknown licences (4x-UltraSharp, many "Nomos" variants under non-commercial
  terms, …) were not used. Every Phhofm model above is "CC BY 4.0" in its release text; three releases say "CC-BY-0.4",
  which is not a licence (a typo): those were measured but not picked.
- Weights' training data: Real-ESRGAN, SwinIR and Phhofm's models were trained on DF2K/LSDIR/OST/Nomos/BHI image sets with
  research or mixed licences. The repositories' own licences allow commercial use; the datasets' terms are not part of this check.

### Browser (Chrome 156, WebGPU on an RTX 5080, ONNX Runtime Web 1.31.1, 2026-11-09, shared GPU)

Same weights, exported as `export_upscale.py` does, one tile in the worker's runtime against PyTorch:

| | file | tile | WebGPU per tile (warm) | CPU, 8 threads per tile | match with PyTorch |
|---|---|---|---|---|---|
| Fast | 2.5 MB float32 | 128² | 6–9 ms | 105 ms | max error 1.3e-6 (120 dB) |
| general-x4v3 (runner-up) | 4.9 MB float32 | 128² | 8–9 ms | 205 ms | 3e-6 |
| Max | 64 MB float16 | 128² | 125–137 ms | (not offered) | 52.6 dB, largest single-pixel error 0.043 (11/255) |
| Max | | 96² / 64² | 80 ms / 42 ms (worse per pixel) | | |
| BHI-dat2 (runner-up) | 42 MB float16 | 64² | 57 ms | | 57 dB |

Through the real page and worker (a textured test picture, one run each, the GPU was shared with another job):

| | input → output | tiles | time | GPU process / page memory (private bytes) |
|---|---|---|---|---|
| Fast ×4, GPU | 0.5 MP → 2000² | 25 | 3.2 s (1.0 s of it the model) | 0.17 GB / 0.32 GB |
| Fast ×4, GPU | 1 MP → 4000² | 81 | 3.0 s | 0.29 GB / 0.43 GB |
| Fast ×4, CPU 8 threads | 1 MP → 4000² | 81 | 12.4 s | |
| Fast ×4, CPU 1 thread (no cross-origin isolation, e.g. Safari) | 1 MP → 4000² | 81 | 66.8 s | |
| Fast ×2, GPU | 3 MP → 4000×3000 | 252 | 6.7 s | 0.85 GB / 0.69 GB |
| Fast ×2, GPU | 20 MP → 10000×8000 (80 MP) | 1620 | 19.4 s | 0.89 GB / 0.66 GB |
| Max ×4, GPU | 0.5 MP → 2000² | 25 | 9.1 s | 0.83 GB / 0.79 GB |
| Max ×4, GPU | 1 MP → 4000² | 81 | 15–19 s | 0.54–0.86 GB / 0.72–0.75 GB |
| Max ×2, GPU | 3 MP → 4000×3000 | 252 | 36.9 s | 0.78 GB / 1.0 GB |

Max costs about 0.12 s per 128² tile whatever the output scale, i.e. roughly 15 s per megapixel of input on this GPU.
Weak and integrated GPUs, phones and Safari were not available to test; the Fast model's CPU time (above) is the only
evidence for them. Memory numbers are the browser's process private bytes (the GPU process holds the weights and
activations); the browser can't report VRAM.

## Tests and how they were run

`../_test/upscaletest.js` (real worker, real models from `../models/`, headless Chrome with WebGPU):
`(await import("/_test/upscaletest.js")).run()` → **31 checks, all pass**: Fast ×2 and ×4 (sizes, matrix unchanged, one undo
step, redo), colours and white text kept, a smooth gradient and a dense texture through 9–12 tiles show no seams (the join
steps measure 1.18 and 1.29 with blending; with the blend ramp removed they measure 1.40 and 1.74, and the test's limits
1.3 / 1.5 fail then), transparency kept, a mask grows with its layer, Max ×2 ran on WebGPU as Max and undoes.

## Files

- `photo/upscale.js` (worker), `photo/upscale-ui.js` (button, picker, progress, applying the result), `photo/UPSCALE.md`,
  `_test/upscaletest.js`.
- `models/fetch.py` (+ `export_upscale.py`, `manifest.json` → `upscale`, `.gitignore`, `README.md`), `NOTICE.txt` (attributions).
- `photo/photo.js`: import, worker name `up`, `resizeImage(w, h, tweak, label)` (returns true/false), the button
  in the Move bar, three click cases, hover warm-up, Esc, `_qc.up`.
- Cache Storage `quickcut-upscale-v1` (the models; the ONNX Runtime binary is shared with the background remover's cache
  when it is there). `sw-manifest.js` must be regenerated before shipping (two new scripts).

## Sources

- SwinIR: [JingyunLiang/SwinIR](https://github.com/JingyunLiang/SwinIR) (Apache-2.0), [weights release v0.0](https://github.com/JingyunLiang/SwinIR/releases/tag/v0.0)
- Real-ESRGAN: [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) (BSD-3-Clause), [v0.2.5.0 (general-x4v3)](https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0)
- Philip Hofmann's models: [Phhofm/models](https://github.com/Phhofm/models) ([4xLSDIRCompact3](https://github.com/Phhofm/models/releases/tag/4xLSDIRCompact3), [4xBHI_dat2_real](https://github.com/Phhofm/models/releases/tag/4xBHI_dat2_real), [4xNomos8k_atd_jpg](https://github.com/Phhofm/models/releases/tag/4xNomos8k_atd_jpg))
- Architectures: [DAT](https://github.com/zhengchen1999/DAT) (Apache-2.0), [HAT](https://github.com/XPixelGroup/HAT) (Apache-2.0), [DRCT](https://github.com/ming053l/DRCT) (MIT), [ATD](https://github.com/LabShuHangGU/Adaptive-Token-Dictionary) (Apache-2.0), [SPAN](https://github.com/hongyuanyu/SPAN) (Apache-2.0), [spandrel](https://github.com/chaiNNer-org/spandrel) (MIT, used to load them)
- Data: [RealSR v3 on Hugging Face](https://huggingface.co/datasets/Xeno73/RealSR), [DIV2K](https://data.vision.ee.ethz.ch/cvl/DIV2K/)
- Diffusion SR: [OSEDiff](https://github.com/cswry/OSEDiff), [TSD-SR](https://github.com/Microtreei/TSD-SR), [SeedVR2](https://github.com/ByteDance-Seed/SeedVR), [InvSR](https://github.com/zsyOAOA/InvSR) (S-Lab licence), [SUPIR](https://github.com/Fanghua-Yu/SUPIR), [HYPIR](https://github.com/XPixelGroup/HYPIR)
- NTIRE 2026 efficient SR: [report](https://arxiv.org/abs/2604.03198), [code](https://github.com/Amazingren/NTIRE2026_ESR)
- Context only (no primary source for their models): [Picsart's upscaler page](https://picsart.com/image-upscale) (2× / 4×, "advanced AI models"; its API lists Topaz models, [pricing page](https://picsart.com/api-platform/models/topaz-upscale-image/pricing)), [Photoshop Super Resolution](https://gigazine.net/gsc_news/en/20210322-adobe-photoshop-super-resolution/) (a CNN trained on a million+ pairs by Adobe, 2× per side)

## Mixed set (9 images)

A 9-image set with ground truth (7 RealSR pairs: faces, text, foliage, fur; 2 JPEG-compressed DIV2K crops), ×4.
It was made for a comparison with Picsart's upscaler, which was dropped; no Picsart outputs were made.

| Model (9 images) | PSNR | SSIM | LPIPS ↓ | DISTS ↓ |
|---|---|---|---|---|
| bicubic | 25.57 | 0.683 | 0.559 | 0.260 |
| realesr-general-x4v3 | 23.74 | 0.708 | 0.346 | 0.216 |
| LSDIRCompactC3 (Fast) | 25.41 | 0.685 | 0.375 | 0.220 |
| Real-ESRGAN x4plus | 24.26 | 0.697 | 0.295 | 0.187 |
| BHI-dat2-real | 25.28 | 0.706 | 0.324 | 0.197 |
| SwinIR-L (Max) | 24.51 | 0.707 | 0.271 | 0.167 |

No claim is made about Picsart or Photoshop: neither was measured.
