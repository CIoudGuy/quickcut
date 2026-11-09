# Exact · File size: how QuickCut hits a size limit

Goal: the user picks a maximum size; the file is never larger, lands close to it (aim 90–98 %),
and looks as good as that many bytes allow. Code: `fit.js` (the maths), `job.js` (the control
loop), `worker.js` (per-part bit rate, frame-rate drop, audio, size check), `video.js` (UI).

## What the browser gives us

- **WebCodecs `VideoEncoder`** has three `bitrateMode`s ([W3C WebCodecs][wc]): `"constant"`,
  `"variable"` (the default) and `"quantizer"` (a per-frame QP passed in the codec-specific encode
  options, e.g. AV1 `quantizer` 0–255 ([AV1 registration][av1reg]), VP9 0–63, AVC/HEVC 0–51).
  There is no two-pass mode and no "max size" option. `configure()` may be called again on a
  configured encoder, so the bit rate can change between parts. `keyFrame: true` forces a key
  frame.
- Support differs by browser, codec and GPU and must be probed with `isConfigSupported`. Measured
  here (Chrome 152/156, Windows, a GPU with AV1/HEVC encoders):
  - hardware: AV1 and HEVC up to 3840×2160 (CBR, VBR and quantizer modes), H.264 up to 1080p
    (`avc1.640028`; higher levels are refused); no hardware VP9 encoder;
  - software: AV1 (libaom), VP9 (libvpx), H.264 (OpenH264, ≤ 1080p at that level); no software
    HEVC (Chrome never ships one);
  - audio: **AAC only at 96, 128, 160 and 192 kb/s** (the Windows Media Foundation AAC encoder;
    lower rates and HE-AAC are refused), Opus at any rate (6–510 kb/s).
  Firefox and Safari ship WebCodecs encoders too, with fewer codecs (Safari: H.264/HEVC through
  VideoToolbox; Firefox: H.264/VP8/VP9/AV1 via its platform/software encoders), so everything
  here is probed, never assumed.

## Rate control: how accurate are the encoders? (measured)

Same 78 s 5K screen recording, AV1 hardware, 480p, per-part bit rates, 14 parts of ~5 s:

| mode       | actual ÷ requested per part (min / median / max) | file vs 10 MB target | PSNR (Y, 16 frames) |
|------------|---------------------------------------------------|----------------------|---------------------|
| `variable` | 0.71 / 1.32 / 2.88                                | 103.5 % → re-encoded 2 parts → 98.3 % | 29.17 dB |
| `constant` | 0.43 / 1.00 / 1.03                                | 96.5 % first time     | 29.15 dB |

Hardware VBR overshoots a lot on short parts (each part restarts the rate control on a key
frame); CBR lands on the request and never pads (it undershoots on static scenes). Picture
quality at the same size was the same (0.02 dB). So the export uses **`constant` per part**,
and gets the variable-bit-rate effect *between* parts from the allocation below. `quantizer`
mode would need a model of bits per QP for each part (a real first pass); not worth it here.

## Budget

```
video bytes = target × 0.975 − container overhead − audio bytes
```

- **Units**: 1 MB = 1,000,000 bytes, 1 GB = 10⁹. A file under "10 MB" then fits limits counted
  either way (10 MiB = 10,485,760 is larger).
- **Container overhead** (estimated, then measured exactly before writing): MP4 `moov` sample
  tables cost ~4 bytes per sample in `stsz`, plus `stco`/`co64` chunk offsets, `stss` key-frame
  entries and `stts` runs (ISO/IEC 14496-12); Matroska/WebM costs ~8–12 bytes per SimpleBlock
  plus Cluster headers and Cues per key frame. Estimate: 4 KB + 16 B per video frame + 10 B per
  audio packet (MP4), 4 KB + 14 B / 12 B (WebM/MKV). Measured: 68.9 KB for 78 s at 30 fps with
  AAC (estimate 78 KB).
- **Audio**: about 8 % of the total rate, 24–160 kb/s, on steps (24/32/48/64/96/128/160).
  - Copied untouched when the pieces have no speed/volume change, the container holds the codec
    and the source rate is within ~1.3× of that share (no generation loss, no time).
  - Otherwise encoded: AAC at the highest supported rate not above the share (MP4/MOV/MKV);
    when that is below the AAC encoder's minimum (Windows: 96 kb/s), Opus (MP4/MKV/WebM), mono
    at ≤ 32 kb/s, 60 ms packets at ≤ 48 kb/s (a third of the packets: less container overhead),
    5.1 folded down to stereo. Opus stays good down to ~32 kb/s stereo / 24 kb/s mono for speech
    and mixed content ([Opus codec docs][opus]); AAC-LC falls apart much earlier.
  - The real audio size replaces the estimate as soon as the audio is done.

## Resolution and frame rate (the ladder)

Quality yardstick: the video rate converted to "H.264 at 1080p30" (`E`):

```
E = rate / eff(codec) × (1920·1080 / pixels)^0.75 × (30 / fps)^0.585
```

- `eff`: bits for the same quality relative to H.264, for hardware encoders: HEVC 0.72, AV1
  0.62, VP9 0.8. Apple's HLS ladder spends 4.5 vs 6 Mb/s (HEVC vs H.264) at 1080p and 2.4 vs
  3 Mb/s at 720p, i.e. 0.75–0.8 ([Apple HLS authoring spec][hls]); AV1 is typically ~30 %
  below HEVC in published comparisons, less with real-time hardware encoders.
- Pixels^0.75: bigger frames need fewer bits per pixel (Apple's HEVC ladder: 1080p 4.5–5.8 Mb/s,
  2160p 11.6–16.8 Mb/s for 4× the pixels).
- fps^0.585: 60 fps needs ~1.5× the bits of 30 fps (YouTube's upload guidance: 1080p 8 Mb/s at
  24–30 fps, 12 Mb/s at 48–60 fps).
- Tiers: Excellent ≥ 6 Mb/s, Good ≥ 3, Fair ≥ 1.5, Low below (Apple's ladder holds E ≈ 4.5–8 at
  every rung; hardware encoders need a little more than x264).

Candidates: the full (cropped) size, then 2160/1440/1080/720/540/480/360/240 on the short side
(multiples of 8), each at the source rate and, above 40 fps, half of it (60 → 30: exactly every
other frame). Ordered by `log2(pixels) + 0.5·log2(fps)` (so 1080p30 beats 720p60). The first
candidate with `E ≥ 3 Mb/s` wins; this is the "convex hull" idea of per-title encoding: below
some bits per pixel a smaller picture upscaled looks better than a blocky big one.

**Content adapts the thresholds.** The source's own rate in the same units (`srcE`) says how many
bits this content needs: a static screen recording at 3.3 Mb/s for 5K60 has `srcE` ≈ 1.2 Mb/s and
looks fine. Thresholds are scaled by `min(1, srcE × 1.2 / 3 Mb/s)` (never up), and spending more
than `max(2 Mb/s, 2 × srcE)` is pointless (the result is capped and comes out smaller than the
limit, said in the UI). Measured on that recording at 10 MB: 1706×480 (fixed thresholds) gave
26.6 dB against the source at 2560×720, 2560×720 (adapted) gave 43.1 dB.

**A short content probe** covers sources whose bit rate says nothing (recorders often spend a
fixed rate on a still screen). When the File size settings open, three 2-second samples of the
edit (at 1/6, 1/2 and 5/6) are encoded at ~720p with a *constant* rate meant for "Excellent"
(`E` = 6 Mb/s). A CBR hardware encoder that can't spend it has hit its finest quantizer, so
`content` = bits used ÷ bits offered measures how easy the picture is (1 = normal). Thresholds
scale by `min(1, content / 0.8)` (floor 0.1). Cost: ~1.6 s on a 5K60 HEVC source. Measured on a
3-minute stretch of a 7-hour 5K60 desktop recording: `content` = 0.25. Without the probe the
plan picked 856×240 for 10 MB and the encoder used only 15 % of the bits it was offered (file at
45 % of the target); see the report for the result with it.

**Impossible**: if even 240p at the lowest frame rate stays under `E = 0.9 Mb/s` (scaled the same
way), the UI says so and offers the smallest size that reaches it (rounded up).

**Instant first**: if an Instant (lossless copy) of the edit already fits, the UI recommends it.

## Codec choice ("Auto")

Hardware first, best compression first: AV1 > HEVC > VP9 > H.264, each checked with
`isConfigSupported` at the candidate's size and frame rate; software only when no hardware
encoder takes that size. MP4 for AV1/HEVC/H.264, WebM for VP9. An explicit format is respected.

## Keeping the size: the control loop

Parts of ~5 s cut at source key frames (encoded in parallel, 2–4 workers), one key frame per
part (every ~5 s instead of 2 s: key frames are expensive at low rates; still fine for seeking —
x264's default `keyint` is 250 frames).

1. **Complexity weights (a free first pass)**: the source's bytes per second in each part (from
   its sample tables; the audio's average is taken off). Bits follow complexity^0.6, the same
   compression x264 applies between scenes (`qcomp` 0.6), clamped to 0.4–2.5×.
2. **Each part's request** = (budget − bytes of finished parts − expected bytes of parts being
   encoded) × its share of the remaining weight, divided by the encoders' measured overshoot
   (`rho`: real ÷ requested so far, with a prior of 1.0 worth two parts, clamped 0.6–1.6),
   clamped to 0.3–2.5× its nominal rate.
3. **Exact size check**: before anything is written, the muxer runs once over the finished parts
   writing nothing and returns the exact file size. If it is over the target, the biggest parts
   are encoded again at a rate cut by just enough (30 % at most, more in later rounds), up to 4
   rounds; otherwise the export fails with a clear message. The written file is checked again.
   A file over the limit is never handed over.

Resume, cancel and progress keep working (the budget state lives in the job journal).

## Results (this PC, Chrome, AV1 hardware)

Sources: a 78 s 5K60 HEVC screen recording and a 7 h 5K60 HEVC desktop recording (both mostly
static content). Every output was decoded in full (all video and audio packets, no decoder
errors) with matching video/audio durations, both starting at 0.

| source / range | target | chosen | result | time |
|---|---|---|---|---|
| 78 s clip | 10 MB | 2560×720 · 30 fps · AV1 · 984 kb/s | 9.53 MB (95.3 %) | 17.5 s |
| 78 s clip | 25 MB | 5120×1440 · 30 fps · AV1 · 2.5 Mb/s | 21.3 MB (85.1 %) * | 49 s |
| 78 s clip, 2 pieces, volume change | 10 MB | 2560×720 · AV1 + Opus 64 kb/s | 9.23 MB (92.3 %) | 24 s |
| same, WebM · VP9 (software) | 5 MB | 1280×360 · VP9 + Opus 32 kb/s mono | 4.82 MB (96.4 %) | 22 s |
| 3 min of the 7 h file | 10 MB | 1920×544 · 30 fps · AV1 · 423 kb/s | 9.28 MB (92.8 %) | 49 s |
| 3 min | 25 MB | 3840×1080 · 30 fps · AV1 · 1.1 Mb/s | 23.4 MB (93.6 %) | 20 s |
| 3 min | 100 MB | 5120×1440 · 60 fps · AV1 (top quality, capped) | 48.0 MB (48 %) * | 240 s |
| 30 min of the 7 h file | 500 MB | 3840×1080 · 30 fps · AV1 · 2.2 Mb/s | 441.7 MB (88.3 %) | 174 s |

\* the encoder could not spend the bits: the content is that easy (it ran at its finest
quantizer). The UI says so for the capped case. None of the runs needed a correction round with
`constant` mode; with `variable` mode the 10 MB run first came out at 103.5 % and was fixed by
re-encoding 2 of 14 parts (final 98.3 %).

[wc]: https://www.w3.org/TR/webcodecs/
[av1reg]: https://w3c.github.io/webcodecs/av1_codec_registration.html
[hls]: https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices
[opus]: https://opus-codec.org/docs/
