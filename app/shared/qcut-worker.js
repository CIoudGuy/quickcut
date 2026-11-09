// .qcut tile worker: encodes and decodes tiles off the main thread (see qcut-codec.js).
import { runTask } from "./qcut-codec.js";

onmessage = async (e) => {
  const m = e.data;
  try {
    const [out, transfer] = await runTask(m);
    postMessage({ id: m.id, out }, transfer);
  } catch (err) {
    postMessage({ id: m.id, error: { code: err?.code || "error", message: String(err?.message || err) } });
  }
};
