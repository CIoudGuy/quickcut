// One time-based progress model for an Exact export. Work is counted in OUTPUT seconds (decode
// skipping at 16-100x makes frames per second uneven; output seconds per second is what the encoder
// really delivers), converted to time with the measured rate. The time left is the sum of what
// remains: this pass, the size-correction rounds still expected, the size checks, the final file.
// Shown: the time left is a smoothed estimate that ticks down with the clock and eases toward the
// new one (it never disappears once there is data); % = elapsed / (elapsed + time left), only ever
// increasing and eased, so it is roughly linear in time.
const WINDOW = 30e3, MIN_WORK = 2500, EASE_LEFT = 6, EASE_FRAC = 1.5;

export function makeProgress(t0 = performance.now()) {
  let samples = [], passT0 = t0, passRate = 0, lastDry = 0;
  let left = null, frac = 0, lastT = t0;
  let prior = 0; // a correction round starts from the first pass's rate and moves to its own as it measures
  const rateNow = (now, done) => {
    if (prior > 0) return (prior * 4 + done) / (4 + (now - passT0) / 1000);
    const [a, da] = samples[0] || [now, done];
    if (now - a >= 3000 && done > da) return ((done - da) * 1000) / (now - a);
    const el = now - passT0;
    return el >= MIN_WORK && done > 0 ? (done * 1000) / el : passRate;
  };
  return {
    /** A new encoding pass starts (a correction round). */
    newPass(now = performance.now(), round = false) { samples = []; passT0 = now; prior = round ? passRate : 0; },
    /** The pass is over: its rate prices a later round. */
    endPass(now, done) { const r = rateNow(now, done); if (r > 0 && !prior) passRate = r; },
    setDry(ms) { lastDry = ms; },
    /**
     * i: {now, phase: "encode"|"check"|"redo"|"final", done, total (output s of this pass), round,
     * fit (size target), passLeft/roundCost (s, redo: from the parts' first-pass times), firstWall (s), audio (0..1), audioT0, muxFrac, muxT0, muxEst (s)}
     * Returns {frac, left (s; null = not enough data yet), rate (output s per s)}.
     */
    update(i) {
      const { now, phase } = i;
      samples.push([now, i.done]);
      while (samples.length > 2 && now - samples[0][0] > WINDOW) samples.shift();
      const rate = rateNow(now, i.done);
      const muxEst = i.muxEst ?? 1;
      const dry = lastDry ? lastDry / 1000 : 1;
      const price = passRate || rate; // output s per s of a pass
      let target = null;
      if (phase === "final") {
        target = i.muxFrac > 0.05 ? (((now - i.muxT0) / 1000) * (1 - i.muxFrac)) / i.muxFrac : muxEst * (1 - i.muxFrac);
      } else if (phase === "check") {
        // typically 0-2 rounds: expect a fraction of one (half a round expected; a round re-encodes the biggest parts, ~80 % of a pass)
        if (i.firstWall > 0) target = dry + (i.fit ? 0.4 * i.firstWall : 0) + muxEst;
        else if (price > 0) target = dry + (i.fit ? (0.4 * i.total) / price : 0) + muxEst;
      } else if (phase === "redo" && i.passLeft != null) {
        // priced by what these parts cost in the first pass (the biggest parts are the slowest ones: the first pass's rate says little)
        target = i.passLeft + dry + (i.round < 2 ? 0.3 * i.roundCost + dry : 0) + muxEst;
      } else if (rate > 0) {
        const pass = Math.max(0, i.total - i.done) / rate;
        const round = (phase === "redo" ? i.total : 0.8 * i.total) / price; // seconds one round takes (the biggest parts: ~80 % of a pass)
        const further = !i.fit ? 0 : phase === "redo" ? (i.round < 2 ? 0.3 * round + dry : 0) : 0.5 * round;
        target = pass + (i.fit ? dry : 0) + further + muxEst;
      }
      // audio runs alongside the video: it only matters if it ends later
      if (target != null && i.audio < 1 && i.audio > 0.02) target = Math.max(target, (((now - i.audioT0) / 1000) * (1 - i.audio)) / i.audio);
      const dt = Math.max(0, (now - lastT) / 1000);
      lastT = now;
      if (now - t0 >= MIN_WORK && target != null) {
        if (left == null) left = target;
        else { const ticked = Math.max(0, left - dt); left = ticked + (target - ticked) * (1 - Math.exp(-dt / EASE_LEFT)); }
        const el = (now - t0) / 1000;
        const tf = Math.min(0.99, el / (el + left));
        frac = Math.max(frac, frac + (tf - frac) * (1 - Math.exp(-dt / EASE_FRAC)));
      } else if (left != null) left = Math.max(0, left - dt); // no data this tick: keep counting down, never blank
      return { frac, left: left == null ? null : Math.max(1, left), rate }; // (never "0 s left" while still working)
    },
    done() { frac = 1; left = 0; return { frac: 1, left: 0, rate: passRate }; },
  };
}
