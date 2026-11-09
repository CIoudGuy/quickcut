// Exact export with a size target (job.js runExact), against a fake worker: the progress must keep
// moving through the "Fitting to size" rounds (it used to sit at 95 % until the last round ended),
// never go backwards, end at 100 %, and Cancel must stop the job at every stage.
// Run on any page of the app: (await import("/_test/exporttest.js")).run()
import { runExact } from "/video/job.js";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { const t0 = performance.now(); while (!(await f())) { if (performance.now() - t0 > ms) return false; await wait(20); } return true; };
const TARGET = 1e6;
function make(extra = {}, J0 = null) {
  const segs = Array.from({ length: 6 }, (_, i) => Array.from({ length: 200 }, (_, k) => (k % 2 ? 0.05 : i)));
  const frames = 6 * 100;
  const probe = new EventTarget();
  probe.postMessage = (m) => { if (m.op === "plan") setTimeout(() => { const ev = new Event("message"); ev.data = { op: "plan", id: m.id, segs, frames, totalOut: 20, density: null }; probe.dispatchEvent(ev); }, 10); };
  const J = J0 || { id: "t" + Math.random(), s: { pieces: [], fps: 30, container: "mp4", bitrate: 1e6, fit: { target: TARGET, margin: 0.98, over: 0, aEst: 1000, cap: 50e6, min: 30e3 }, ...extra }, done: {} };
  const log = [];
  const run = runExact({ j: J, file: new Blob([]), probe, out: { push() {} }, workerUrl: "/_test/fakeexportworker.js", hasAudio: true, workers: 2, save: async () => {}, onProgress: (p) => log.push({ ...p, t: performance.now() }) });
  return { run, log, J };
}
export async function run() {
  const out = {}, fails = [];
  const ok = (n, c, info) => { out[n] = c ? true : info ?? false; if (!c) fails.push(n); };
  const bc = new BroadcastChannel("fakeexport");
  let calls = 0, answers = [1.5 * TARGET, 1.2 * TARGET, 0.9 * TARGET];
  bc.onmessage = (e) => { if (e.data.mux) { const b = e.data.dry ? answers[Math.min(calls++, answers.length - 1)] : answers[answers.length - 1]; bc.postMessage({ bytes: b }); } };
  // 1. two correction rounds, then it fits
  {
    const { run, log } = make();
    const r = await Promise.race([run.promise.then(() => true, (e) => String(e)), wait(30000).then(() => "timeout")]);
    ok("fits and finishes", r === true, r);
    const fr = log.map((p) => p.frac);
    ok("never backwards", fr.every((f, i) => !i || f >= fr[i - 1] - 1e-9));
    ok("ends at 100 %", fr[fr.length - 1] === 1, fr[fr.length - 1]);
    // while "Fitting to size": the bar moves (not one value for the whole stage), and the time left is not frozen
    const fit = log.filter((p) => p.stage === "Fitting to size");
    const distinct = new Set(fit.map((p) => p.frac.toFixed(3))).size;
    ok("bar moves while fitting", fit.length > 3 && distinct >= 4, { n: fit.length, distinct });
    ok("fitting stays below 100 %", fit.every((p) => p.frac < 1), Math.max(...fit.map((p) => p.frac)));
  }
  // 1b. the numbers over time (a sample every 0.5 s): % only up and in small steps, the time left always
  // there once it shows, never jumping, the stage names short; 1 and 2 correction rounds
  for (const rounds of [1, 2]) {
    calls = 0;
    answers = rounds === 1 ? [1.4 * TARGET, 0.9 * TARGET] : [1.5 * TARGET, 1.2 * TARGET, 0.9 * TARGET];
    const { run, log } = make();
    await run.promise;
    const t0 = log[0].t, samples = [];
    for (let k = 0; k * 500 <= log[log.length - 1].t - t0; k++) { const p = [...log].reverse().find((q) => q.t - t0 <= k * 500); if (p) samples.push(p); }
    const tag = rounds + " round(s): ";
    ok(tag + "% never down", samples.every((p, i) => !i || p.frac >= samples[i - 1].frac));
    const firstLeft = samples.findIndex((p) => p.left != null);
    const steps = samples.map((p, i) => (i ? p.frac - samples[i - 1].frac : 0));
    ok(tag + "% no big steps", Math.max(...steps.slice(firstLeft + 2, -1)) < 0.2, Math.max(...steps.slice(firstLeft + 2, -1)).toFixed(3));
    ok(tag + "time left appears early", firstLeft >= 0 && firstLeft <= 8, firstLeft);
    ok(tag + "time left never goes away", samples.slice(firstLeft).every((p) => p.left != null), samples.map((p) => p.left == null ? "-" : p.left.toFixed(1)).join(" "));
    const l = samples.slice(firstLeft).map((p) => p.left ?? 0);
    const jumps = l.map((x, i) => (i ? Math.abs(x - (l[i - 1] - 0.5)) : 0));
    ok(tag + "time left smooth", Math.max(...jumps) < 4, jumps.map((x) => x.toFixed(1)).join(" "));
    ok(tag + "ends at 100 %", samples[samples.length - 1].frac === 1 || log[log.length - 1].frac === 1);
    ok(tag + "stage names", log.every((p) => ["Encoding", "Checking size", "Fitting to size", "Finishing"].includes(p.stage)), [...new Set(log.map((p) => p.stage))]);
    out["trace " + rounds] = samples.map((p) => `${(p.t - t0) / 1000 | 0}s ${Math.round(p.frac * 100)}% ${p.left == null ? "-" : p.left.toFixed(1)}s ${p.stage}`).filter((_, i) => i % 2 === 0);
  }
  // 1c. the encoder cannot get smaller (the size hardly moves between rounds): a short error after 2 rounds, not 4
  {
    calls = 0; let dry = 0;
    answers = [1.5 * TARGET, 1.45 * TARGET, 1.44 * TARGET, 1.44 * TARGET, 1.44 * TARGET, 1.44 * TARGET];
    bc.onmessage = (e) => { if (e.data.mux) { if (e.data.dry) dry++; bc.postMessage({ bytes: answers[Math.min(calls++, answers.length - 1)] }); } };
    const { run } = make();
    const r = await Promise.race([run.promise.then(() => "resolved", (e) => String(e.message)), wait(40000).then(() => "timeout")]);
    ok("stuck size: short error", /can't get below/.test(r), r);
    ok("stuck size: gives up after 2 rounds", dry <= 3, dry);
    answers = [1.5 * TARGET, 1.2 * TARGET, 0.9 * TARGET];
    bc.onmessage = (e) => { if (e.data.mux) { const b = e.data.dry ? answers[Math.min(calls++, answers.length - 1)] : answers[answers.length - 1]; bc.postMessage({ bytes: b }); } };
  }
  // 2. cancel at every stage: no more progress after it, no worker left running
  const stages = ["Encoding", "Checking size", "Fitting to size", "Finishing"];
  for (const stage of stages) {
    calls = 0;
    const { run, log } = make();
    const hit = await until(() => log.some((p) => p.stage === stage), 20000);
    ok("reached " + stage, hit);
    run.cancel();
    const n = log.length;
    await wait(600);
    ok("cancel at " + stage + ": no progress after", log.length === n, [n, log.length]);
    const r = await Promise.race([run.promise.then(() => "resolved", (e) => String(e.message)), wait(1500).then(() => "pending")]);
    ok("cancel at " + stage + ": the job settles", r === "cancelled", r);
  }
  // 3. a job stopped in the middle of a correction round (some parts deleted) continues and finishes
  for (const stage of ["Fitting to size", "Checking size"]) {
    calls = 0;
    const a = make();
    await until(() => a.log.some((p) => p.stage === stage), 20000);
    a.run.cancel();
    await wait(300);
    const b = make({}, a.J);
    const r = await Promise.race([b.run.promise.then(() => true, (e) => String(e.message)), wait(15000).then(() => "timeout")]);
    ok("continue after stop in " + stage, r === true, r);
    ok("continued bar ends at 100 %", b.log.length && b.log[b.log.length - 1].frac === 1, b.log.length && b.log[b.log.length - 1].frac);
  }
  bc.close();
  out.fails = fails;
  return out;
}
