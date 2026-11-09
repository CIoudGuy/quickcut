// Export formats and WebCodecs encoder configs, shared by the page (to probe what this
// browser/GPU can encode at the export's real size and frame rate) and the export worker.

export const FORMATS = [
  { id: "mp4-h264", c: "mp4", v: "h264", label: "MP4 · H.264" },
  { id: "mp4-hevc", c: "mp4", v: "hevc", label: "MP4 · HEVC (H.265)" },
  { id: "mp4-av1", c: "mp4", v: "av1", label: "MP4 · AV1" },
  { id: "webm-vp9", c: "webm", v: "vp9", label: "WebM · VP9" },
  { id: "webm-av1", c: "webm", v: "av1", label: "WebM · AV1" },
  { id: "mov-h264", c: "mov", v: "h264", label: "MOV · H.264" },
  { id: "mov-hevc", c: "mov", v: "hevc", label: "MOV · HEVC (H.265)" },
  { id: "mkv-h264", c: "mkv", v: "h264", label: "MKV · H.264" },
  { id: "mkv-hevc", c: "mkv", v: "hevc", label: "MKV · HEVC (H.265)" },
];
export const fmtById = (id) => FORMATS.find((f) => f.id === id);
export const EXT = { mp4: ".mp4", mov: ".mov", webm: ".webm", mkv: ".mkv" };
export const MIME = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska" };

// bits per pixel per frame for Smaller / Balanced / Best ("Best" aims at visually lossless)
const BPP = { h264: [0.06, 0.1, 0.18], hevc: [0.04, 0.065, 0.12], av1: [0.03, 0.05, 0.1], vp9: [0.035, 0.06, 0.11] };
export const QUALITIES = ["Smaller", "Balanced", "Best"];
export function bitrateFor(v, q, w, h, fps) {
  const bpp = BPP[v][Math.max(0, QUALITIES.indexOf(q))];
  return Math.round(Math.min(400e6, Math.max(300e3, bpp * w * h * Math.min(fps || 30, 120))));
}

function candidates(v, w, h, tenBit) {
  const px = w * h;
  if (tenBit) {
    // 10-bit: HEVC Main10, AV1 Main 10-bit, VP9 profile 2 (H.264 High 10 has no WebCodecs encoder)
    if (v === "hevc") return ["hvc1.2.4.L123.B0", "hvc1.2.4.L153.B0", "hvc1.2.4.L156.B0", "hvc1.2.4.L183.B0"].slice(px <= 2228224 ? 0 : px <= 8912896 ? 1 : 3);
    if (v === "av1") return ["av01.0.08M.10", "av01.0.12M.10", "av01.0.13M.10", "av01.0.16M.10"].slice(px <= 2228224 ? 0 : px <= 8912896 ? 1 : 3);
    if (v === "vp9") return ["vp09.02.40.10", "vp09.02.50.10", "vp09.02.10.10"];
    return [];
  }
  if (v === "h264") return ["avc1.640028", "avc1.640032", "avc1.640033", "avc1.640034", "avc1.64003C"].slice(px <= 2228224 ? 0 : px <= 3686400 ? 1 : px <= 8912896 ? 2 : 4);
  if (v === "hevc") return ["hvc1.1.6.L123.B0", "hvc1.1.6.L153.B0", "hvc1.1.6.L156.B0", "hvc1.1.6.L183.B0"].slice(px <= 2228224 ? 0 : px <= 8912896 ? 1 : 3);
  if (v === "av1") return ["av01.0.08M.08", "av01.0.12M.08", "av01.0.13M.08", "av01.0.16M.08"].slice(px <= 2228224 ? 0 : px <= 8912896 ? 1 : 3);
  return ["vp09.00.40.08", "vp09.00.50.08", "vp09.00.10.08"];
}

/** The first encoder config this browser supports (hardware first), or null. `forceSoftware`:
 * software only (the GPU refused another session, or tests). `tenBit`: 10-bit output. */
export async function encoderConfig(v, w, h, fps, bitrate, { forceSoftware = false, tenBit = false, mode = "variable", hwOnly = false } = {}) {
  if (!self.VideoEncoder) return null;
  for (const hw of forceSoftware ? ["prefer-software"] : hwOnly ? ["prefer-hardware"] : ["prefer-hardware", "no-preference"]) {
    for (const codec of candidates(v, w, h, tenBit)) {
      const c = { codec, width: w, height: h, framerate: fps || 30, bitrate: Math.round(bitrate), bitrateMode: mode, latencyMode: "quality", hardwareAcceleration: hw };
      if (v === "h264") c.avc = { format: "avc" };
      if (v === "hevc") c.hevc = { format: "hevc" };
      try { if ((await VideoEncoder.isConfigSupported(c)).supported) return c; } catch {}
    }
  }
  return null;
}

// colour: WebCodecs names → ISO/IEC 23091-2 codes (for the `colr` box)
const PRIM = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 };
const TRC = { bt709: 1, smpte170m: 6, linear: 8, "iec61966-2-1": 13, pq: 16, hlg: 18 };
const MAT = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, "bt2020-ncl": 9 };
export function colorCodes(cs) {
  if (!cs || !(cs.primaries in PRIM)) return [1, 1, 1, 0];
  return [PRIM[cs.primaries], TRC[cs.transfer] ?? 1, MAT[cs.matrix] ?? 1, cs.fullRange ? 1 : 0];
}

/** Is a source codec string 10-bit (or more)? hvc1.2… (Main10), av01.x.xxM.10, vp09.02/03…10. */
export function isTenBit(codecString) {
  const c = codecString || "";
  if (/^(hvc1|hev1)\.2\./.test(c)) return true;
  const av1 = c.match(/^av01\.\d\.\d+[MH]\.(\d+)/);
  if (av1) return +av1[1] > 8;
  const vp9 = c.match(/^vp09\.\d+\.\d+\.(\d+)/);
  if (vp9) return +vp9[1] > 8;
  return /^avc1\.6e/i.test(c); // H.264 High 10
}
