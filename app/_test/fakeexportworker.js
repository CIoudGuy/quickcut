// A stand-in export worker for exporttest.js. Parts take a few tens of ms; the muxed size is
// answered by the test over a BroadcastChannel (so it can say "too big" twice, then "fits").
const bc = new BroadcastChannel("fakeexport");
const ask = (dry) => new Promise((res) => { bc.onmessage = (e) => res(e.data.bytes); bc.postMessage({ mux: true, dry }); });
self.onmessage = async (e) => {
  const m = e.data, wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (m.op === "segInit") self.postMessage({ op: "segReady", hw: false });
  else if (m.op === "audio") { await wait(50); self.postMessage({ op: "audioDone", meta: { bytes: 1000, desc: [] } }); }
  else if (m.op === "seg") {
    const n = m.frames.length / 2;
    // uneven: some parts (long runs of 100x pieces) take several times longer than others
    for (let k = 1; k <= 4; k++) { await wait(150 + (m.i % 3) * 220); self.postMessage({ op: "segProg", i: m.i, n: Math.round((n * k) / 4) }); }
    self.postMessage({ op: "segDone", i: m.i, n, bytes: 100000, bitrate: m.bitrate, desc: null, codec: "avc1", decoded: n });
  } else if (m.op === "mux") {
    const total = m.segs.reduce((a, s) => a + s.n, 0);
    const bytes = await ask(m.dry);
    if (!m.dry) for (let k = 1; k <= 4; k++) { await wait(150); self.postMessage({ op: "progress", done: k, total: 4 }); }
    self.postMessage({ op: "done", bytes, dur: total / 30, frames: total });
  }
};
