"""Prepare an upscaler for the browser (used by fetch.py).

    pip install torch spandrel onnx onnxruntime onnxconverter-common numpy

PyTorch weights -> ONNX (opset 17, fixed T x T input, float32 in and out) -> ONNX Runtime's basic
graph optimisation (constant folding, no device-specific fusions: all the shape arithmetic of the
window-attention models is folded away) -> optionally float16 inside (input and output stay float32).
The architecture code comes from spandrel (MIT; it carries each architecture's own implementation).
"""
import os


def dedupe(path):
    """Constant folding turns every shifted-window attention mask into its own weight (the same ones, over
    and over): keep one copy of each distinct initializer (file 346 MB -> about 120 MB for SwinIR-L)."""
    import hashlib
    import onnx

    m = onnx.load(path)
    first, rename = {}, {}
    for i in list(m.graph.initializer):
        key = (i.data_type, tuple(i.dims), hashlib.sha256(i.raw_data or i.SerializeToString()).hexdigest())
        if key in first and i.raw_data:
            rename[i.name] = first[key]
        else:
            first[key] = i.name
    if rename:
        keep = [i for i in m.graph.initializer if i.name not in rename]
        del m.graph.initializer[:]
        m.graph.initializer.extend(keep)
        for n in m.graph.node:
            for k, nm in enumerate(n.input):
                if nm in rename:
                    n.input[k] = rename[nm]
        onnx.save(m, path)
    return len(rename)


def export(weights, out, tile, fp16=False, optimize=True):
    import numpy as np
    import onnx
    import onnxruntime as ort
    import torch
    from spandrel import ModelLoader

    m = ModelLoader().load_from_file(weights).model.eval().float()
    x = torch.rand(1, 3, tile, tile)
    tmp = out + ".raw"
    with torch.no_grad():
        ref = m(x).numpy()
        torch.onnx.export(m, x, tmp, opset_version=17, input_names=["x"], output_names=["y"], dynamo=False)
    src = tmp
    if optimize:
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        so.optimized_model_filepath = out + ".opt"
        ort.InferenceSession(tmp, so, providers=["CPUExecutionProvider"])
        os.remove(tmp)
        src = out + ".opt"
        dedupe(src)
    if fp16:
        from onnxconverter_common import float16

        mm = float16.convert_float_to_float16(onnx.load(src), keep_io_types=True)
        outs = {o.name for o in mm.graph.output}
        for n in mm.graph.node:  # Cast-to-float32 nodes inside the graph must follow the float16 conversion
            if n.op_type == "Cast" and not n.name.startswith("graph_output_cast") and n.output[0] not in outs:
                for a in n.attribute:
                    if a.name == "to" and a.i == onnx.TensorProto.FLOAT:
                        a.i = onnx.TensorProto.FLOAT16
        del mm.graph.value_info[:]
        onnx.save(mm, out)
        os.remove(src)
    else:
        os.replace(src, out)
    # the exported file must agree with PyTorch (float16 files: loosely)
    if not fp16:
        y = ort.InferenceSession(out, providers=["CPUExecutionProvider"]).run(None, {"x": x.numpy()})[0]
        err = float(np.abs(y - ref).max())
        if err > 1e-3:
            raise SystemExit(f"export of {weights} differs from PyTorch by {err}")
