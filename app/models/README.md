# Background remover files

The Photo tool's background remover runs entirely in the visitor's browser. It needs large files
that are **not in git** (git ignores them); `fetch.py` downloads them from pinned upstream URLs,
checks their SHA-256, prepares the models and writes them here in parts of at most 20 MiB:

| File | Size | Used for | Licence | Source |
|---|---|---|---|---|
| `birefnet-512-v2/model_q4.onnx.*` | 194 MB | Fast | MIT | BiRefNet 512×512 ([ZhengPeng7/BiRefNet](https://github.com/ZhengPeng7/BiRefNet)), ONNX export [onnx-community/BiRefNet_512x512-ONNX](https://huggingface.co/onnx-community/BiRefNet_512x512-ONNX) @ `b0b30af` |
| `birefnet-1024/model_q4.onnx.*` | 210 MB | High detail (optional download, needs WebGPU) | MIT | BiRefNet general 1024×1024, ONNX export [onnx-community/BiRefNet-ONNX](https://huggingface.co/onnx-community/BiRefNet-ONNX) @ `534d3c8` |
| `birefnet-matting-1024/model_q4.onnx.*` | 208 MB | Hair & fur (optional download, needs WebGPU) | MIT | BiRefNet-matting 1024×1024, ONNX file `BiRefNet-matting-epoch_100.onnx` of the [BiRefNet v1 release](https://github.com/ZhengPeng7/BiRefNet/releases/tag/v1) |
| `birefnet-portrait-1024/model_q4.onnx.*` | 208 MB | People (optional download, needs WebGPU) | MIT | BiRefNet-portrait 1024×1024 (trained on people only), ONNX file `BiRefNet-portrait-epoch_150.onnx` of the [BiRefNet v1 release](https://github.com/ZhengPeng7/BiRefNet/releases/tag/v1) (tag `v1` = commit `a0cf992`; model page [ZhengPeng7/BiRefNet-portrait](https://huggingface.co/ZhengPeng7/BiRefNet-portrait) @ `b656196`, MIT) |
| `birefnet-dis-1024/model_q4.onnx.*` | 208 MB | Fine detail (optional download, needs WebGPU) | MIT | BiRefNet-DIS 1024×1024 (trained on DIS5K: trees, bikes, chairs, fences), ONNX file `BiRefNet-DIS-epoch_590.onnx` of the same release (model page [ZhengPeng7/BiRefNet-DIS5K](https://huggingface.co/ZhengPeng7/BiRefNet-DIS5K) @ `343602b`, MIT) |
| `ort/ort-wasm-simd-threaded.asyncify.wasm.*` | 29 MB | all | MIT | ONNX Runtime Web 1.31.1 ([microsoft/onnxruntime](https://github.com/microsoft/onnxruntime)) |

All models are prepared the same way (wide Split/Concat rewritten for WebGPU, the deformable
convolutions' Sum nodes rewritten as Adds so they stay on the GPU, MatMul weights 4-bit; the
matting, portrait and DIS models are converted from fp32 to fp16 first). Details in `fetch.py`.

`manifest.json` (in git) lists every part with the whole file's size and SHA-256. The page
fetches the parts only when someone first uses a quality that needs them, verifies the checksum and
keeps the file in Cache Storage (`quickcut-models-v1`), so later uses are instant and work offline.
The small JavaScript parts of ONNX Runtime live in `../vendor/ort/` (in git, MIT, `LICENSE` there).

## Hosting

Serve `models/` as plain static files next to the rest of the site (same URLs as locally); any static
host works. The files are large, so a CDN in front helps. Parts never change once published: a model
whose prepared bytes change gets a new folder name (e.g. `birefnet-512` to `birefnet-512-v2`).

## Recreate

```
pip install onnx==1.23.2 onnxruntime==1.23.2 onnxconverter-common==1.16.0 numpy
python models/fetch.py
```

It prints `ok: ort 28.7 MB in 2 parts, birefnet-512 193.7 MB in 10 parts, birefnet-1024 210.0 MB
in 11 parts, birefnet-matting-1024 208.4 MB in 10 parts, birefnet-portrait-1024 208.4 MB in 10 parts,
birefnet-dis-1024 208.4 MB in 10 parts`. The prepared files' SHA-256 values are
in `fetch.py` (`prepared_sha256`; checked: re-running gives the same bytes with the versions
above). The script says so if a value differs and writes the actual one into `manifest.json`.

Why these models and how they were measured: `../photo/BG_REMOVER.md`.

BiRefNet licence: MIT, Copyright (c) 2024 ZhengPeng.
