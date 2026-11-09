#!/usr/bin/env python3
"""Fetch and prepare the background-remover files (they are too big for the git repo).

    pip install onnx==1.23.2 onnxruntime==1.23.2 onnxconverter-common==1.16.0 numpy
    python models/fetch.py

Downloads pinned upstream files, checks their SHA-256, prepares the model for the browser and
writes them in parts of at most 20 MiB (small enough for any static host or CDN) plus
models/manifest.json, which the page reads. Nothing here is fetched by visitors from anywhere
but the site itself. Re-running is safe: finished files are checked and kept.

Upstream (all permissively licensed):
  * BiRefNet 512×512 (MIT, github.com/ZhengPeng7/BiRefNet), ONNX export by onnx-community
    (huggingface.co/onnx-community/BiRefNet_512x512-ONNX, MIT), fp16.
  * BiRefNet general 1024×1024 (MIT), ONNX export by onnx-community
    (huggingface.co/onnx-community/BiRefNet-ONNX), fp16: "High detail".
  * BiRefNet-matting 1024×1024 (MIT), ONNX export from the BiRefNet v1 release (fp32): soft alpha
    for hair, fur and glass.
  * BiRefNet-DIS 1024×1024 (MIT), ONNX export from the same v1 release (fp32): "Fine detail"
    (DIS5K: trees, bikes, fences). (BiRefNet-portrait was measured as "People" and left out:
    no better than High detail on people, see ../photo/BG_REMOVER.md.)
  * ONNX Runtime Web 1.31.1 WebAssembly binary (MIT, github.com/microsoft/onnxruntime).

Preparation of the model (deterministic):
  1. Split/Concat nodes with more than 8 outputs/inputs are rewritten as small trees: WebGPU lets a
     shader bind only 16 storage buffers, so ONNX Runtime's WebGPU backend can't run a 16-way Split.
  2. Identity nodes on weights are removed (consumers read the weight directly).
  3. MatMul weights are quantised to 4 bits (MatMulNBits, block 32, symmetric): 473 MB → 194 MB,
     same quality on our test set (mask MSE within ±0.02e-3 of fp16).
  0. (fp32 sources, "fp16") converted to float16 first (inputs/outputs stay float32), and the
     Cast-to-float32 nodes inside the graph are pointed at float16 (the converter leaves them,
     which ONNX Runtime rejects as a type mismatch).
  4. ("sum_to_add", all models) the 4-input Sum nodes of the exported deformable convolutions
     become trees of Add. ONNX Runtime's WebGPU backend has no float16 Sum kernel, so these ran on
     the CPU in float32: at 1024² that is 4 × 822 MB per Sum and the run died with std::bad_alloc
     (the 4 GB WebAssembly limit); at 512² they "only" grew the worker to 2.1 GB and cost time.
     As Adds they stay on the GPU. Same maths (a + b + c + d).
"""
import hashlib, json, os, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
PART = 20 * 1024 * 1024

SOURCES = {
    "ort": {
        "url": "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.asyncify.wasm",
        "sha256": "ca319e9539cd0f1e291cf56074760121eaf39650f5dbf84b6e52c07f4b2944ec",
        "out": "ort/ort-wasm-simd-threaded.asyncify.wasm",
    },
    "birefnet-512": {
        "url": "https://huggingface.co/onnx-community/BiRefNet_512x512-ONNX/resolve/b0b30aff33d009f6bcd7dacdc3cdcf2f8f42175b/onnx/model_fp16.onnx",
        "sha256": "1b254749feb1edf83667a4c9da710cc1962a1980b8d0b2f4432100278c9ac0af",
        # v2 (2026-11-09): + Sum→Add (step 4). v1 (birefnet-512/, without it) stays published
        # unchanged: parts are immutable once uploaded, so a changed file gets a new folder.
        "out": "birefnet-512-v2/model_q4.onnx",
        "prepare": True,
        "sum_to_add": True,
        # SHA-256 of the prepared file with onnx 1.23.2 + onnxruntime 1.23.2 (informational)
        "prepared_sha256": "90fd0f5500431725bad7e2e14b0168c5dc9a063f845414253ed85dc31755cbfe",
    },
    # BiRefNet general 1024×1024 (MIT), onnx-community export, fp16 (490 MB) → 4-bit (210 MB)
    "birefnet-1024": {
        "url": "https://huggingface.co/onnx-community/BiRefNet-ONNX/resolve/534d3c82d3bb8b2f0867db6dfbc3a525b8e42f67/onnx/model_fp16.onnx",
        "sha256": "3654c741eb80bd926ada8fed1713b506ccf8d30eb1f6487e87eb9f234f33df09",
        "out": "birefnet-1024/model_q4.onnx",
        "prepare": True,
        "sum_to_add": True,
        "prepared_sha256": "07126345049e34e3f654b88fd578e32d7e33dabb5cf0acbdfa79bf7b18a96ca6",
    },
    # BiRefNet-matting 1024×1024 (MIT), BiRefNet v1 release, fp32 (973 MB) → fp16 → 4-bit (210 MB)
    "birefnet-matting-1024": {
        "url": "https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-matting-epoch_100.onnx",
        "sha256": "6065d27c615ea27308f5b88598dd8db116eb07436c7a323ca40d13b2866c309e",
        "out": "birefnet-matting-1024/model_q4.onnx",
        "prepare": True,
        "fp16": True,
        "sum_to_add": True,
        "prepared_sha256": "235d5b2f45b96848d350d63168f4efe23f7b6668cc853e200f84fdd5b66356f0",
    },
    # BiRefNet-DIS 1024×1024 (MIT; trained on DIS5K: very detailed objects such as trees, bikes,
    # chairs, fences), BiRefNet v1 release, fp32 (973 MB) → fp16 → 4-bit: "Fine detail".
    # MIT also on huggingface.co/ZhengPeng7/BiRefNet-DIS5K @ 343602b.
    "birefnet-dis-1024": {
        "url": "https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-DIS-epoch_590.onnx",
        "sha256": "6470117bac6f8d82a3f62921056f52d0f5c4d36d1d832096331d5ea38a03acb5",
        "out": "birefnet-dis-1024/model_q4.onnx",
        "prepare": True,
        "fp16": True,
        "sum_to_add": True,
        "prepared_sha256": "7f0d187c29f346a799047f98c9d4a5abf80903ad8551011ec7c4f1cef3980479",
    },
}
MODELS = {
    "birefnet-512": {"file": "birefnet-512", "name": "BiRefNet 512 (4-bit)", "license": "MIT", "input": 512},
    # "gpu": needs WebGPU (≈ 5 GB of GPU memory at the peak of a run, measured on an RTX 5080);
    # "tiles": False = no extra tile pass for "High detail" (the model already sees 1024²)
    "birefnet-1024": {"file": "birefnet-1024", "name": "BiRefNet 1024 (4-bit)", "license": "MIT", "input": 1024, "gpu": True, "tiles": False},
    "birefnet-matting-1024": {"file": "birefnet-matting-1024", "name": "BiRefNet matting 1024 (4-bit)", "license": "MIT", "input": 1024, "gpu": True, "tiles": False},
    "birefnet-dis-1024": {"file": "birefnet-dis-1024", "name": "BiRefNet DIS 1024 (4-bit)", "license": "MIT", "input": 1024, "gpu": True, "tiles": False},
}
# small runtime files that live in the repo (vendor/ort); checked here so a version mismatch shows
VENDOR = {
    "ort.webgpu.min.mjs": "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.webgpu.min.mjs",
    "ort-wasm-simd-threaded.asyncify.mjs": "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.asyncify.mjs",
}


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def download(url, dst, want=None):
    if os.path.exists(dst) and (want is None or sha(dst) == want):
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    print("download", url)
    tmp = dst + ".part"
    for attempt in range(4):  # GitHub release downloads sometimes answer 504 at first
        try:
            with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    f.write(b)
            break
        except OSError as e:
            if attempt == 3:
                raise
            print("retry", e)
            time.sleep(5 * (attempt + 1))
    if want and sha(tmp) != want:
        os.remove(tmp)
        sys.exit(f"checksum mismatch for {url}")
    os.replace(tmp, dst)


def to_fp16(src, dst):
    import onnx
    from onnxconverter_common import float16
    m = float16.convert_float_to_float16(onnx.load(src), keep_io_types=True)
    outs = {o.name for o in m.graph.output}
    for n in m.graph.node:
        if n.op_type == "Cast" and not n.name.startswith("graph_output_cast") and n.output[0] not in outs:
            for a in n.attribute:
                if a.name == "to" and a.i == onnx.TensorProto.FLOAT:
                    a.i = onnx.TensorProto.FLOAT16
    del m.graph.value_info[:]
    onnx.save(m, dst)


def prepare(src, dst, sum_to_add=False):
    import numpy as np
    import onnx
    from onnx import helper, numpy_helper
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer, DefaultWeightOnlyQuantConfig

    MAX = 8
    m = onnx.load(src)
    g = m.graph
    consts = {i.name: numpy_helper.to_array(i) for i in g.initializer}
    for n in g.node:
        if n.op_type == "Constant":
            for a in n.attribute:
                if a.name == "value":
                    consts[n.output[0]] = numpy_helper.to_array(a.t)
    out = []
    for n in g.node:
        attr = {a.name: helper.get_attribute_value(a) for a in n.attribute}
        if n.op_type == "Concat" and len(n.input) > MAX:
            ins, lvl = list(n.input), 0
            while len(ins) > MAX:
                nxt = []
                for k in range(0, len(ins), MAX):
                    grp = ins[k:k + MAX]
                    if len(grp) == 1:
                        nxt.append(grp[0]); continue
                    nm = f"{n.name}__c{lvl}_{k // MAX}"
                    out.append(helper.make_node("Concat", grp, [nm], name=nm, axis=attr["axis"]))
                    nxt.append(nm)
                ins, lvl = nxt, lvl + 1
            out.append(helper.make_node("Concat", ins, list(n.output), name=n.name, axis=attr["axis"]))
            continue
        if n.op_type == "Split" and len(n.output) > MAX and len(n.input) > 1 and n.input[1] in consts:
            sizes = [int(v) for v in consts[n.input[1]].tolist()]
            axis = attr.get("axis", 0)
            groups = [list(range(k, min(len(sizes), k + MAX))) for k in range(0, len(sizes), MAX)]
            top = f"{n.name}__sizes"
            g.initializer.append(numpy_helper.from_array(np.array([sum(sizes[i] for i in grp) for grp in groups], dtype="int64"), top))
            mids = [f"{n.name}__g{j}" for j in range(len(groups))]
            out.append(helper.make_node("Split", [n.input[0], top], mids, name=n.name + "__top", axis=axis))
            for j, grp in enumerate(groups):
                sz = f"{n.name}__sizes{j}"
                g.initializer.append(numpy_helper.from_array(np.array([sizes[i] for i in grp], dtype="int64"), sz))
                if len(grp) == 1:
                    out.append(helper.make_node("Identity", [mids[j]], [n.output[grp[0]]], name=f"{n.name}__id{j}"))
                else:
                    out.append(helper.make_node("Split", [mids[j], sz], [n.output[i] for i in grp], name=f"{n.name}__s{j}", axis=axis))
            continue
        if sum_to_add and n.op_type == "Sum" and len(n.input) > 2:
            ins, k = list(n.input), 0
            while len(ins) > 2:
                nxt = []
                for i in range(0, len(ins) - 1, 2):
                    nm = f"{n.name}__a{k}"
                    k += 1
                    out.append(helper.make_node("Add", [ins[i], ins[i + 1]], [nm], name=nm))
                    nxt.append(nm)
                if len(ins) % 2:
                    nxt.append(ins[-1])
                ins = nxt
            out.append(helper.make_node("Add", ins, list(n.output), name=n.name))
            continue
        out.append(n)
    del g.node[:]
    g.node.extend(out)
    # weights read through Identity nodes: point the consumers at the weight itself
    init = {i.name for i in g.initializer}
    alias = {n.output[0]: n.input[0] for n in g.node if n.op_type == "Identity" and n.input[0] in init}
    keep = [n for n in g.node if not (n.op_type == "Identity" and n.output[0] in alias)]
    for n in keep:
        for k, i in enumerate(n.input):
            if i in alias:
                n.input[k] = alias[i]
    del g.node[:]
    g.node.extend(keep)
    q = MatMulNBitsQuantizer(m, algo_config=DefaultWeightOnlyQuantConfig(block_size=32, is_symmetric=True))
    q.process()
    q.model.save_model_to_file(dst, False)


def main():
    files = {}
    tmpdir = os.path.join(HERE, "_src")
    try:
        with open(os.path.join(HERE, "manifest.json")) as f:
            old = json.load(f).get("files", {})
    except (OSError, ValueError):
        old = {}
    for key, s in SOURCES.items():
        out = os.path.join(HERE, s["out"])
        o = old.get(key)
        if o and o.get("file") == s["out"] and not os.path.exists(out) and all(os.path.exists(os.path.join(HERE, p)) for p in o["parts"])                 and sum(os.path.getsize(os.path.join(HERE, p)) for p in o["parts"]) == o["size"]:
            h = hashlib.sha256()
            for p in o["parts"]:
                with open(os.path.join(HERE, p), "rb") as f:
                    h.update(f.read())
            if h.hexdigest() == o["sha256"]:
                files[key] = o  # already prepared and split
                continue
        if s.get("prepare"):
            raw = os.path.join(tmpdir, key + ".onnx")
            if not os.path.exists(out):
                download(s["url"], raw, s["sha256"])
                print("prepare", key)
                os.makedirs(os.path.dirname(out), exist_ok=True)
                if s.get("fp16"):
                    half = raw + ".fp16"
                    to_fp16(raw, half)
                    os.remove(raw)
                    raw = half
                prepare(raw, out, s.get("sum_to_add", False))
                os.remove(raw)  # the upstream file isn't served; free the disk
            got = sha(out)
            if s["prepared_sha256"] and got != s["prepared_sha256"]:
                print(f"note: {key} prepared SHA-256 is {got} (expected {s['prepared_sha256']}); the manifest uses the new one")
        else:
            download(s["url"], out, s["sha256"])
        # parts of ≤ 20 MiB
        size = os.path.getsize(out)
        parts = []
        with open(out, "rb") as f:
            i = 0
            while True:
                b = f.read(PART)
                if not b:
                    break
                name = f"{s['out']}.{i:03d}"
                p = os.path.join(HERE, name)
                if not (os.path.exists(p) and os.path.getsize(p) == len(b)):
                    with open(p, "wb") as w:
                        w.write(b)
                parts.append(name)
                i += 1
        files[key] = {"file": s["out"], "size": size, "sha256": sha(out), "parts": parts}
        os.remove(out)  # only the parts are served
    try:
        os.rmdir(tmpdir)
    except OSError:
        pass
    for name, url in VENDOR.items():
        download(url, os.path.join(APP, "vendor", "ort", name))
    manifest = {
        "runtime": "ort",
        "default": "birefnet-512",
        "files": files,
        "models": MODELS,
    }
    with open(os.path.join(HERE, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print("ok:", ", ".join(f"{k} {v['size'] / 1e6:.1f} MB in {len(v['parts'])} parts" for k, v in files.items()))


if __name__ == "__main__":
    main()
