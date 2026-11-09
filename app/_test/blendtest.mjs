// Blend-mode formulas (photo/blend.js) against PhotoCraft's own test vectors
// (crates/color/src/blend/tests.rs and crates/compose/src/psblend.rs tests).
// Run: node app/_test/blendtest.mjs   (also importable in the browser: run() returns {pass, fails})
import { channel as ch, blendRGB, composite, compositeAtop, lum } from "../photo/blend.js";

const MODES = ["normal", "dissolve", "darken", "multiply", "color-burn", "linear-burn", "darker-color", "lighten", "screen", "color-dodge", "linear-dodge", "lighter-color",
  "overlay", "soft-light", "hard-light", "vivid-light", "linear-light", "pin-light", "hard-mix", "difference", "exclusion", "subtract", "divide", "hue", "saturation", "color", "luminosity"];
const SEPARABLE = MODES.filter((m) => !["hue", "saturation", "color", "luminosity", "darker-color", "lighter-color"].includes(m));

export function run() {
  const fails = [];
  let n = 0;
  const E = 1e-5;
  const ok = (cond, what) => { n++; if (!cond) fails.push(what); };
  const close = (a, b, what, e = E) => ok(Math.abs(a - b) < e, `${what}: ${a} vs ${b}`);
  const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

  // normal_is_source
  for (const [b, s] of [[0.2, 0.7], [1, 0], [0, 1]]) close(ch("normal", b, s), s, `normal ${b},${s}`);
  // identities_with_white_and_black
  for (const b of [0, 0.1, 0.5, 0.9, 1]) {
    close(ch("multiply", b, 1), b, "multiply white"); close(ch("screen", b, 0), b, "screen black");
    close(ch("linear-dodge", b, 0), b, "add black"); close(ch("darken", b, 1), b, "darken white");
    close(ch("lighten", b, 0), b, "lighten black"); close(ch("difference", b, 0), b, "difference black");
    close(ch("subtract", b, 0), b, "subtract black"); close(ch("linear-burn", b, 1), b, "linear burn white");
    close(ch("exclusion", b, 0), b, "exclusion black");
    close(ch("hard-light", b, 0.5), b, "hard light grey"); close(ch("soft-light", b, 0.5), b, "soft light grey"); close(ch("linear-light", b, 0.5), b, "linear light grey");
  }
  // known_values
  const kv = [["multiply", 0.5, 0.5, 0.25], ["screen", 0.5, 0.5, 0.75], ["overlay", 0.25, 0.5, 0.25], ["overlay", 0.75, 1, 1], ["color-dodge", 0.5, 0.5, 1], ["color-burn", 0.5, 0.5, 0],
    ["color-burn", 1, 0, 1], ["color-dodge", 0, 1, 0], ["divide", 0.25, 0.5, 0.5], ["divide", 0, 0, 0], ["divide", 0.3, 0, 1], ["exclusion", 0.5, 0.5, 0.5],
    ["pin-light", 0.8, 0.2, 0.4], ["pin-light", 0.1, 0.9, 0.8], ["hard-mix", 0.6, 0.4, 1], ["hard-mix", 0.6, 0.3, 0]];
  for (const [m, b, s, want] of kv) close(ch(m, b, s), want, `${m}(${b}, ${s})`);
  // soft_light_follows_photoshop_over_dark_backdrops (measured Photoshop levels, ±7)
  for (const [b, s, ps] of [[4, 247, 11], [6, 254, 19], [9, 252, 25], [10, 237, 32], [14, 253, 46]]) close(ch("soft-light", b / 255, s / 255) * 255, ps, `soft light PS ${b},${s}`, 7);
  // soft_light_is_the_w3c_formula
  const D = (b) => (b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b));
  const w3c = (b, s) => (s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (D(b) - b));
  for (let b = 0; b <= 255; b += 3) for (let s = 0; s <= 255; s += 5) close(ch("soft-light", b / 255, s / 255), w3c(b / 255, s / 255), `soft light w3c ${b},${s}`);
  close(ch("soft-light", 0.25, 1), 0.5, "soft light continuous");
  close(ch("soft-light", -0.1, 1), 0, "soft light negative backdrop");
  // vivid_light_source_extremes_and_interior_values
  for (const b of [0, 0.25, 0.5, 0.75, 1]) { ok(ch("vivid-light", b, 0) === 0, `vivid ${b},0`); ok(ch("vivid-light", b, 1) === 1, `vivid ${b},1`); }
  close(ch("vivid-light", 0.75, 0.25), 0.5, "vivid .75,.25"); close(ch("vivid-light", 0.25, 0.75), 0.5, "vivid .25,.75");
  // psblend: vivid_light_source_extremes_win
  ok(ch("vivid-light", 0, 1) === 1 && ch("vivid-light", 1, 0) === 0, "vivid extremes");
  close(ch("vivid-light", 0.5, 0.75), 1, "vivid .5,.75"); close(ch("vivid-light", 0.5, 0.25), 0, "vivid .5,.25");
  // hard_mix_matches_photoshop_extremes_and_interior_values + psblend hard_mix_edges_match_photoshop
  for (const [b, s, want] of [[1, 0, 1], [0, 1, 0], [1 - 1e-5, 0, 1], [1e-5, 1, 0], [0.6, 0.4, 1], [0.6, 0.3, 0], [0.6, 0.6, 1], [0.3, 0.3, 0]]) ok(ch("hard-mix", b, s) === want, `hard mix ${b},${s}`);
  // psblend: burn_and_dodge_treat_near_extremes_as_exact
  ok(ch("color-burn", 1 - 1e-6, 0) === 1, "burn near white"); ok(ch("color-dodge", 1e-6, 1) === 0, "dodge near black");
  close(ch("color-burn", 0.5, 0.5), 0, "burn .5"); close(ch("color-dodge", 0.25, 0.5), 0.5, "dodge .25,.5");
  // vivid_light_and_hard_mix_composite_extremes
  eq(composite("vivid-light", [1, 1, 1, 1], [0, 0, 0, 1]), [0, 0, 0, 1], "VL white←black");
  eq(composite("vivid-light", [0, 0, 0, 1], [1, 1, 1, 1]), [1, 1, 1, 1], "VL black←white");
  eq(composite("hard-mix", [0, 0, 0, 1], [1, 1, 1, 1]), [0, 0, 0, 1], "HM black←white");
  eq(composite("hard-mix", [1, 1, 1, 1], [0, 0, 0, 1]), [1, 1, 1, 1], "HM white←black");
  // separable_outputs_stay_in_unit_range (all 27 modes through blendRGB)
  for (const m of MODES) for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) {
    const b = i / 20, s = j / 20;
    for (const c of blendRGB(m, [b, s, 0.5], [s, b, 0.25])) ok(c >= -E && c <= 1 + E, `${m} range ${b},${s} → ${c}`);
  }
  // add_and_divide_clip_at_integer_depths
  ok(ch("linear-dodge", 2, 0.5) === 1 && ch("linear-dodge", 0.75, 0.5) === 1, "add clips"); ok(ch("divide", 2, 0.5) === 1 && ch("divide", 0.5, 0.25) === 1, "divide clips");
  // luminosity_and_color_swap_components
  const cb = [0.8, 0.2, 0.2], cs = [0.1, 0.1, 0.9];
  close(lum(blendRGB("luminosity", cb, cs)), lum(cs), "luminosity keeps source lum");
  close(lum(blendRGB("color", cb, cs)), lum(cb), "color keeps backdrop lum");
  close(lum(blendRGB("hue", cb, cs)), lum(cb), "hue keeps backdrop lum");
  const sg = blendRGB("saturation", cb, [0.5, 0.5, 0.5]);
  ok(Math.abs(sg[0] - sg[1]) < E && Math.abs(sg[1] - sg[2]) < E, "saturation of grey desaturates");
  // darker_lighter_color_pick_whole_pixel
  const A = [0.9, 0.1, 0.1], B = [0.2, 0.6, 0.2];
  eq(blendRGB("darker-color", A, B), lum(B) < lum(A) ? B : A, "darker color"); eq(blendRGB("lighter-color", A, B), lum(B) > lum(A) ? B : A, "lighter color");
  // composite_alpha_rules
  const bg = [0.2, 0.4, 0.6, 1];
  eq(composite("multiply", bg, [1, 0, 0, 0]), bg, "transparent source");
  let r = composite("normal", bg, [1, 0, 0, 1]); close(r[0], 1, "opaque normal r"); close(r[3], 1, "opaque normal a");
  r = composite("normal", bg, [1, 1, 1, 1], 0.5); close(r[0], 0.6, "half lerp r"); close(r[1], 0.7, "half lerp g"); close(r[2], 0.8, "half lerp b");
  r = composite("multiply", [0, 0, 0, 0], [0.3, 0.5, 0.7, 1]); close(r[0], 0.3, "over nothing r"); close(r[2], 0.7, "over nothing b"); close(r[3], 1, "over nothing a");
  close(composite("screen", [0, 0, 0, 0.5], [0, 0, 0, 0.5])[3], 0.75, "alpha accumulates");
  // composite_atop_keeps_alpha_and_moves_colour_by_source_alpha
  r = compositeAtop("normal", [1, 1, 1, 0.5], [0, 0, 0, 1], 0.5); ok(Math.abs(r[0] - 0.5) < E && r[3] === 0.5, "atop normal");
  r = compositeAtop("multiply", [1, 1, 1, 0.5], [0, 0, 0, 1], 0.5); ok(Math.abs(r[0] - 0.5) < E && r[3] === 0.5, "atop multiply");
  const op = [0.2, 0.4, 0.6, 1], a1 = compositeAtop("screen", op, [0.5, 0.5, 0.5, 0.7], 0.8), a2 = composite("screen", op, [0.5, 0.5, 0.5, 0.7], 0.8);
  ok(a1.every((v, i) => Math.abs(v - a2[i]) < E), "atop = over on opaque backdrop");
  eq(compositeAtop("normal", [1, 1, 1, 0.5], [0, 0, 0, 0]), [1, 1, 1, 0.5], "atop transparent source");
  // non_separable_modes_unchanged_on_integer_inputs: equal to the plain ISO 32000 ClipColor on 8-bit data
  const specClip = (c) => {
    const l = lum(c), lo = Math.min(...c), hi = Math.max(...c);
    let o = c;
    if (lo < 0) { const d = l - lo; o = o.map((v) => (Math.abs(d) < 1e-12 ? l : l + ((v - l) * l) / d)); }
    if (hi > 1) { const d = hi - l; o = o.map((v) => (Math.abs(d) < 1e-12 ? l : l + ((v - l) * (1 - l)) / d)); }
    return o;
  };
  const specLum = (c, l) => { const d = l - lum(c); return specClip([c[0] + d, c[1] + d, c[2] + d]); };
  const sat = (c) => Math.max(...c) - Math.min(...c);
  const setSat = (c, s) => { const i = [0, 1, 2].sort((a, b) => c[a] - c[b]), o = [0, 0, 0]; if (c[i[2]] > c[i[0]]) { o[i[1]] = ((c[i[1]] - c[i[0]]) * s) / (c[i[2]] - c[i[0]]); o[i[2]] = s; } return o; };
  const spec = { hue: (b, s) => specLum(setSat(s, sat(b)), lum(b)), saturation: (b, s) => specLum(setSat(b, sat(s)), lum(b)), color: (b, s) => specLum(s, lum(b)), luminosity: (b, s) => specLum(b, lum(s)) };
  let seed = 0x12345678, worst = 0;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return ((seed >>> 8) % 256) / 255; };
  const cols = [];
  for (const r0 of [0, 1 / 255, 0.5, 254 / 255, 1]) for (const g0 of [0, 0.25, 0.75, 1]) for (const b0 of [0, 1 / 255, 0.5, 1]) cols.push([r0, g0, b0]);
  for (let i = 0; i < 600; i++) cols.push([next(), next(), next()]);
  cols.forEach((b, i) => { for (let j = i % 7; j < cols.length; j += 7) for (const m of Object.keys(spec)) { const g = blendRGB(m, b, cols[j]), w = spec[m](b, cols[j]); for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(g[k] - w[k])); } });
  ok(worst <= 1e-6, `non-separable vs ISO 32000 on 8-bit inputs: worst ${worst}`);
  // every separable mode is per channel (blendRGB agrees with channel())
  for (const m of SEPARABLE) { const o = blendRGB(m, [0.2, 0.5, 0.9], [0.7, 0.1, 0.4]); ok(o[0] === ch(m, 0.2, 0.7) && o[2] === ch(m, 0.9, 0.4), `${m} separable`); }
  return { pass: fails.length === 0, checks: n, fails: fails.slice(0, 20) };
}

if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("blendtest.mjs")) {
  const r = run();
  console.log(r.pass ? `blend formulas: all ${r.checks} PhotoCraft checks pass` : `FAIL (${r.fails.length}):\n${r.fails.join("\n")}`);
  process.exitCode = r.pass ? 0 : 1;
}
