//! Plain-Rust core (no JS): open a file, describe it, list its samples, cut it losslessly, mux
//! encoded frames into MP4 or WebM, and stretch audio without changing its pitch. The wasm
//! bindings in `lib.rs` wrap these; the tests run them natively.

use std::io::{self, Seek, SeekFrom, Write};

use craft_media::matroska as mkv;
use craft_media::isobmff::{
    AacConfig, AvcConfig, Brand, CodecConfig, FourCc, HevcConfig, Mp4File, Mp4Writer, OpusConfig, SampleEntry, TrackConfig, TrackKind, WriteSample,
    WriterOptions,
};

use crate::lossless;

/// A random-access byte source usable by both demuxers (craft-media has one `ByteSource` for all).
pub trait Src: craft_media::ByteSource {}
impl<T: craft_media::ByteSource> Src for T {}

/// Bytes in memory as a source (tests).
pub struct Mem(pub Vec<u8>);
impl craft_media::ByteSource for Mem {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
        craft_media::ByteSource::read_at(&self.0, offset, buf)
    }
}

pub enum Container {
    Mp4(Box<Mp4File>),
    Mkv(Box<mkv::MkvFile>),
}

/// Open an MP4/MOV or Matroska/WebM file (sniffed from its first bytes).
pub fn open<S: Src>(src: &S) -> Result<Container, String> {
    let len = craft_media::ByteSource::len(src);
    if len < 16 {
        return Err("The file is empty or too short.".into());
    }
    let mut head = [0u8; 12];
    craft_media::ByteSource::read_at(src, 0, &mut head).map_err(|e| e.to_string())?;
    if head[..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        let f = mkv::open(src).map_err(|e| format!("Can't read this file: {e}"))?;
        return Ok(Container::Mkv(Box::new(f)));
    }
    let f = craft_media::isobmff::open(src).map_err(|e| format!("Can't read this file: {e}"))?;
    Ok(Container::Mp4(Box::new(f)))
}

// ── description ─────────────────────────────────────────────────────────────

/// What JS needs to know about one track.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TrackInfo {
    /// "video", "audio" or "other".
    pub kind: &'static str,
    /// Short name: h264, hevc, vp9, av1, aac, opus…
    pub codec: String,
    /// WebCodecs codec string ("" when WebCodecs has no name for it).
    pub codec_string: String,
    /// WebCodecs `description` (avcC, hvcC, av1C, AudioSpecificConfig, OpusHead…).
    pub description: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Clockwise quarter turns to display the video upright.
    pub rotation: u8,
    pub fps: f64,
    /// Media timescale (ticks per second) of the track.
    pub timescale: u32,
    pub frames: usize,
    pub sample_rate: u32,
    pub channels: u32,
    /// Seconds the track lasts.
    pub duration: f64,
    /// Bytes of all samples.
    pub bytes: u64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Info {
    /// mp4, mov, webm or mkv.
    pub container: &'static str,
    pub duration: f64,
    pub tracks: Vec<TrackInfo>,
    /// Index of the first video / audio track.
    pub video: Option<usize>,
    pub audio: Option<usize>,
    /// Why Instant (lossless) export can't cut this file; None when it can.
    pub instant_off: Option<String>,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// `avc1.PPCCLL`.
pub fn avc_string(c: &AvcConfig) -> String {
    format!("avc1.{}", hex(&[c.profile, c.compatibility, c.level]))
}

/// `hvc1.1.6.L153.B0` (ISO/IEC 14496-15 Annex E).
pub fn hevc_string(fourcc: &str, c: &HevcConfig) -> String {
    let space = ["", "A", "B", "C"][usize::from(c.general_profile_space & 3)];
    let compat = c.general_profile_compatibility_flags.reverse_bits();
    let tier = if c.general_tier_flag { 'H' } else { 'L' };
    let mut s = format!("{fourcc}.{space}{}.{compat:X}.{tier}{}", c.general_profile_idc, c.general_level_idc);
    let bytes = c.general_constraint_indicator_flags.to_be_bytes();
    let cons = &bytes[2..8];
    let n = cons.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1);
    for b in &cons[..n] {
        s.push_str(&format!(".{b:X}"));
    }
    s
}

fn av1_string(c: &craft_media::isobmff::Av1Config) -> String {
    let depth = if c.twelve_bit { 12 } else if c.high_bitdepth { 10 } else { 8 };
    format!("av01.{}.{:02}{}.{depth:02}", c.seq_profile, c.seq_level_idx_0, if c.seq_tier_0 { 'H' } else { 'M' })
}

/// OpusHead (RFC 7845 §5.1, little-endian) from an MP4 `dOps` config.
pub fn opus_head(c: &OpusConfig) -> Vec<u8> {
    let mut b = b"OpusHead".to_vec();
    b.push(1);
    b.push(c.output_channels);
    b.extend_from_slice(&c.pre_skip.to_le_bytes());
    b.extend_from_slice(&c.input_sample_rate.to_le_bytes());
    b.extend_from_slice(&c.output_gain.to_le_bytes());
    b.push(c.channel_mapping_family);
    b.extend_from_slice(&c.channel_mapping);
    b
}

/// The MP4 `dOps` config from an OpusHead.
pub fn opus_config(head: &[u8]) -> Option<OpusConfig> {
    if head.len() < 19 || &head[..8] != b"OpusHead" {
        return None;
    }
    Some(OpusConfig {
        output_channels: head[9],
        pre_skip: u16::from_le_bytes([head[10], head[11]]),
        input_sample_rate: u32::from_le_bytes([head[12], head[13], head[14], head[15]]),
        output_gain: i16::from_le_bytes([head[16], head[17]]),
        channel_mapping_family: head[18],
        channel_mapping: head[19..].to_vec(),
    })
}

/// A minimal OpusHead for `channels` (mapping family 0 handles 1–2 channels).
pub fn default_opus_head(channels: u8, rate: u32, pre_skip: u16) -> Vec<u8> {
    opus_head(&OpusConfig { output_channels: channels, pre_skip, input_sample_rate: rate, output_gain: 0, channel_mapping_family: 0, channel_mapping: vec![] })
}

fn mp4_codec(e: &SampleEntry) -> (String, String, Vec<u8>) {
    let fourcc = String::from_utf8_lossy(&e.format.0).to_string();
    match &e.codec {
        CodecConfig::Avc(c) => ("h264".into(), avc_string(c), c.to_bytes()),
        CodecConfig::Hevc(c) => ("hevc".into(), hevc_string(if fourcc == "hev1" { "hev1" } else { "hvc1" }, c), c.to_bytes()),
        CodecConfig::Av1(c) => ("av1".into(), av1_string(c), c.to_bytes()),
        CodecConfig::Vp9(c) => ("vp9".into(), format!("vp09.{:02}.{:02}.{:02}", c.profile, c.level, c.bit_depth), Vec::new()),
        CodecConfig::Aac(c) => ("aac".into(), format!("mp4a.40.{}", c.object_type.max(1)), c.asc.clone()),
        CodecConfig::Mp3 => ("mp3".into(), "mp3".into(), Vec::new()),
        CodecConfig::Opus(c) => ("opus".into(), "opus".into(), opus_head(c)),
        CodecConfig::Flac(_) => ("flac".into(), "flac".into(), Vec::new()),
        other => (other.name().into(), String::new(), Vec::new()),
    }
}

fn mkv_codec(t: &mkv::Track) -> (String, String, Vec<u8>) {
    use mkv::Codec as C;
    match &t.codec {
        C::Avc { avcc } => match AvcConfig::parse(avcc) {
            Ok(c) => ("h264".into(), avc_string(&c), avcc.clone()),
            Err(_) => ("h264".into(), String::new(), avcc.clone()),
        },
        C::Hevc { hvcc } => match HevcConfig::parse(hvcc) {
            Ok(c) => ("hevc".into(), hevc_string("hvc1", &c), hvcc.clone()),
            Err(_) => ("hevc".into(), String::new(), hvcc.clone()),
        },
        C::Vp8 => ("vp8".into(), "vp8".into(), Vec::new()),
        C::Vp9 { .. } => ("vp9".into(), "vp09.00.10.08".into(), Vec::new()),
        C::Av1 { av1c } => match craft_media::isobmff::Av1Config::parse(av1c) {
            Ok(c) => ("av1".into(), av1_string(&c), av1c.clone()),
            Err(_) => ("av1".into(), "av01.0.08M.08".into(), av1c.clone()),
        },
        C::Aac { asc } => {
            let ot = craft_media::isobmff::parse_asc(asc).map_or(2, |(o, _, _)| o);
            ("aac".into(), format!("mp4a.40.{ot}"), asc.clone())
        }
        C::Opus { head } => ("opus".into(), "opus".into(), head.clone()),
        C::Vorbis { .. } => ("vorbis".into(), "vorbis".into(), t.codec_private.clone()),
        C::Flac { private } => ("flac".into(), "flac".into(), private.clone()),
        C::Mp3 => ("mp3".into(), "mp3".into(), Vec::new()),
        other => (other.name(), String::new(), Vec::new()),
    }
}

/// Frames per second from the median sample duration (robust against a short last frame).
fn fps_of(durs: &mut [f64]) -> f64 {
    if durs.is_empty() {
        return 0.0;
    }
    durs.sort_by(f64::total_cmp);
    let d = durs[durs.len() / 2];
    if d > 0.0 { 1.0 / d } else { 0.0 }
}

pub fn info(c: &Container) -> Info {
    match c {
        Container::Mp4(m) => {
            let mut out = Info { container: if m.is_quicktime { "mov" } else { "mp4" }, ..Default::default() };
            for (i, t) in m.tracks.iter().enumerate() {
                let ts = f64::from(t.timescale.max(1));
                let (codec, codec_string, description) = t.entries.first().map(mp4_codec).unwrap_or_default();
                let kind = match t.kind {
                    TrackKind::Video => "video",
                    TrackKind::Audio => "audio",
                    _ => "other",
                };
                let mut durs: Vec<f64> = t.samples.iter().map(|s| f64::from(s.duration) / ts).collect();
                let end = t.samples.iter().map(|s| s.pts + t.edit_offset + i64::from(s.duration)).max().unwrap_or(0);
                let start = t.samples.iter().map(|s| s.pts + t.edit_offset).min().unwrap_or(0).max(0);
                let mut ti = TrackInfo {
                    kind,
                    codec,
                    codec_string,
                    description,
                    timescale: t.timescale,
                    frames: t.samples.len(),
                    duration: (end - start).max(0) as f64 / ts,
                    bytes: t.samples.iter().map(|s| u64::from(s.size)).sum(),
                    ..Default::default()
                };
                if kind == "video" {
                    let v = t.video();
                    ti.width = v.map_or(t.width, |v| u32::from(v.width));
                    ti.height = v.map_or(t.height, |v| u32::from(v.height));
                    ti.rotation = t.display_rotation().unwrap_or(0);
                    ti.fps = fps_of(&mut durs);
                    out.video.get_or_insert(i);
                } else if kind == "audio" {
                    let a = t.audio();
                    ti.sample_rate = a.map_or(t.timescale, |a| a.sample_rate.round() as u32);
                    ti.channels = a.map_or(2, |a| a.channels);
                    if let Some(CodecConfig::Aac(c)) = t.codec() {
                        if c.sample_rate > 0 {
                            ti.sample_rate = c.sample_rate;
                        }
                        if c.channels() > 0 {
                            ti.channels = c.channels();
                        }
                    }
                    if !t.samples.is_empty() {
                        out.audio.get_or_insert(i);
                    }
                }
                out.tracks.push(ti);
            }
            let movie = if m.timescale > 0 { m.duration as f64 / f64::from(m.timescale) } else { 0.0 };
            let vdur = out.video.map_or(0.0, |v| out.tracks[v].duration);
            out.duration = if vdur > 0.0 { vdur } else { movie.max(out.tracks.iter().map(|t| t.duration).fold(0.0, f64::max)) };
            out.instant_off = if m.fragmented {
                Some("Instant can't cut fragmented MP4 files.".into())
            } else {
                match out.video.map(|v| out.tracks[v].codec.as_str()) {
                    None => Some("Instant needs a video track.".into()),
                    Some("h264" | "hevc") => None,
                    Some(c) => Some(format!("Instant cuts H.264 and HEVC; this video is {}.", c.to_uppercase())),
                }
            };
            out
        }
        Container::Mkv(m) => {
            let mut out = Info { container: if m.is_webm() { "webm" } else { "mkv" }, ..Default::default() };
            for (i, t) in m.tracks.iter().enumerate() {
                let (codec, codec_string, description) = mkv_codec(t);
                let kind = match t.kind {
                    mkv::TrackKind::Video => "video",
                    mkv::TrackKind::Audio => "audio",
                    _ => "other",
                };
                let ns = |x: i64| t.ticks_to_ns(x) as f64 / 1e9;
                let mut pts: Vec<f64> = t.samples.iter().map(|s| ns(s.pts)).collect();
                let end = t.samples.iter().map(|s| ns(s.pts + s.duration as i64)).fold(0.0, f64::max);
                let start = pts.iter().copied().fold(f64::INFINITY, f64::min);
                let mut ti = TrackInfo {
                    kind,
                    codec,
                    codec_string,
                    description,
                    frames: t.samples.len(),
                    duration: if start.is_finite() { (end - start.max(0.0)).max(0.0) } else { 0.0 },
                    bytes: t.samples.iter().map(|s| u64::from(s.size)).sum(),
                    ..Default::default()
                };
                if kind == "video" {
                    if let Some(v) = &t.video {
                        ti.width = v.pixel_width;
                        ti.height = v.pixel_height;
                        ti.rotation = v.display_rotation().unwrap_or(0);
                    }
                    ti.fps = match t.default_duration_ns {
                        Some(d) if d > 0 => 1e9 / d as f64,
                        _ => {
                            pts.sort_by(f64::total_cmp);
                            let mut d: Vec<f64> = pts.windows(2).map(|w| w[1] - w[0]).filter(|d| *d > 0.0).collect();
                            fps_of(&mut d)
                        }
                    };
                    out.video.get_or_insert(i);
                } else if kind == "audio" {
                    if let Some(a) = &t.audio {
                        ti.sample_rate = a.output_sampling_frequency.unwrap_or(a.sampling_frequency).round() as u32;
                        ti.channels = a.channels as u32;
                    }
                    if !t.samples.is_empty() {
                        out.audio.get_or_insert(i);
                    }
                }
                out.tracks.push(ti);
            }
            out.duration = m.duration_ns().map_or(0.0, |d| d as f64 / 1e9);
            if out.duration <= 0.0 {
                out.duration = out.tracks.iter().map(|t| t.duration).fold(0.0, f64::max);
            }
            out.instant_off = Some(format!("Instant cuts MP4 and MOV files; this one is {}.", out.container.to_uppercase()));
            out
        }
    }
}

fn js_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn num(x: f64) -> String {
    if x.is_finite() { format!("{x}") } else { "0".into() }
}

/// [`Info`] as JSON (descriptions are fetched separately).
pub fn info_json(i: &Info) -> String {
    let tracks: Vec<String> = i
        .tracks
        .iter()
        .map(|t| {
            format!(
                "{{\"kind\":{},\"codec\":{},\"codecString\":{},\"width\":{},\"height\":{},\"rotation\":{},\"fps\":{},\"timescale\":{},\"frames\":{},\"sampleRate\":{},\"channels\":{},\"duration\":{},\"bytes\":{}}}",
                js_str(t.kind),
                js_str(&t.codec),
                js_str(&t.codec_string),
                t.width,
                t.height,
                t.rotation,
                num(t.fps),
                t.timescale,
                t.frames,
                t.sample_rate,
                t.channels,
                num(t.duration),
                t.bytes
            )
        })
        .collect();
    let opt = |o: Option<usize>| o.map_or("-1".to_string(), |v| v.to_string());
    format!(
        "{{\"container\":{},\"duration\":{},\"video\":{},\"audio\":{},\"instantOff\":{},\"tracks\":[{}]}}",
        js_str(i.container),
        num(i.duration),
        opt(i.video),
        opt(i.audio),
        i.instant_off.as_deref().map_or("null".to_string(), js_str),
        tracks.join(",")
    )
}

pub fn description(c: &Container, track: usize) -> Vec<u8> {
    match c {
        Container::Mp4(m) => m.tracks.get(track).and_then(|t| t.entries.first()).map(|e| mp4_codec(e).2).unwrap_or_default(),
        Container::Mkv(m) => m.tracks.get(track).map(|t| mkv_codec(t).2).unwrap_or_default(),
    }
}

/// Sample table of `track` in decode order, flattened: `[pts, duration, key]` per sample, pts and
/// duration in presentation seconds, key 1 for a sync sample.
pub fn samples(c: &Container, track: usize) -> Vec<f64> {
    let mut v = Vec::new();
    match c {
        Container::Mp4(m) => {
            if let Some(t) = m.tracks.get(track) {
                let ts = f64::from(t.timescale.max(1));
                v.reserve(t.samples.len() * 3);
                for s in &t.samples {
                    v.push((s.pts + t.edit_offset) as f64 / ts);
                    v.push(f64::from(s.duration) / ts);
                    v.push(if s.is_sync { 1.0 } else { 0.0 });
                }
            }
        }
        Container::Mkv(m) => {
            if let Some(t) = m.tracks.get(track) {
                v.reserve(t.samples.len() * 3);
                for s in &t.samples {
                    v.push(t.ticks_to_ns(s.pts) as f64 / 1e9);
                    v.push(t.ticks_to_ns(s.duration as i64) as f64 / 1e9);
                    v.push(if s.keyframe { 1.0 } else { 0.0 });
                }
            }
        }
    }
    v
}

pub fn read_sample<S: Src>(c: &Container, src: &S, track: usize, i: usize) -> Result<Vec<u8>, String> {
    match c {
        Container::Mp4(m) => m.read_sample(src, track, i).map_err(|e| e.to_string()),
        Container::Mkv(m) => m.read_sample(src, track, i).map_err(|e| e.to_string()),
    }
}

// ── Instant (lossless) cut ──────────────────────────────────────────────────

/// Pieces as `[start, end, start, end, …]` seconds.
fn pairs(p: &[f64]) -> Vec<(f64, f64)> {
    p.chunks_exact(2).map(|c| (c[0], c[1])).collect()
}

/// Output length (s) and size (bytes, without the index) of an Instant cut.
pub fn instant_estimate(c: &Container, pieces: &[f64]) -> Result<(f64, u64), String> {
    let Container::Mp4(m) = c else { return Err("Instant cuts MP4 and MOV files only.".into()) };
    let plan = lossless::plan(m, &pairs(pieces))?;
    let bytes = plan.order(m).iter().map(|&(_, ti, i)| u64::from(m.tracks[ti].samples[i].size)).sum();
    Ok((plan.duration(), bytes))
}

/// Records what is written after the last seek: the `moov`, which the muxer writes last, so the
/// display matrix can be patched without reading the output back.
pub struct Tail<W> {
    pub w: W,
    pub pos: u64,
    pub tail_pos: u64,
    pub tail: Vec<u8>,
    /// Nothing is kept before the first seek (that is the media data: it may be gigabytes).
    seeks: u32,
}

impl<W: Write + Seek> Tail<W> {
    pub fn new(w: W) -> Self {
        Tail { w, pos: 0, tail_pos: 0, tail: Vec::new(), seeks: 0 }
    }
}
impl<W: Write + Seek> Write for Tail<W> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        let n = self.w.write(b)?;
        if self.seeks > 0 {
            self.tail.extend_from_slice(&b[..n]);
        }
        self.pos += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.w.flush()
    }
}
impl<W: Write + Seek> Seek for Tail<W> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.pos = self.w.seek(to)?;
        self.seeks += 1;
        self.tail_pos = self.pos;
        self.tail.clear();
        Ok(self.pos)
    }
}

/// Cut `pieces` of an MP4/MOV into `w` without re-encoding (FilmCraft's Instant cutter).
/// `progress(done, total)` is called every few samples. Returns the writer, the output length in
/// seconds and its size in bytes.
pub fn instant<S: Src, W: Write + Seek>(c: &Container, src: &S, pieces: &[f64], w: W, mut progress: impl FnMut(u64, u64)) -> Result<(W, f64, u64), String> {
    let Container::Mp4(m) = c else { return Err("Instant cuts MP4 and MOV files only.".into()) };
    let plan = lossless::plan(m, &pairs(pieces))?;
    let total = plan.order(m).len() as u64;
    let mut done = 0u64;
    let p = crate::Progress::default();
    let mut out = lossless::write(
        &plan,
        m,
        Tail::new(w),
        |ti, i| {
            done += 1;
            if done % 128 == 0 {
                progress(done, total);
            }
            m.read_sample(src, ti, i).map_err(|e| e.to_string())
        },
        &p,
    )?;
    if let Some(mat) = lossless::rotation(&plan, m) {
        let mut moov = std::mem::take(&mut out.tail);
        lossless::patch_matrix(&mut moov, &mat)?;
        out.w.seek(SeekFrom::Start(out.tail_pos)).map_err(|e| e.to_string())?;
        out.w.write_all(&moov).map_err(|e| e.to_string())?;
        out.w.flush().map_err(|e| e.to_string())?;
    }
    progress(total, total);
    let size = out.w.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
    Ok((out.w, plan.duration(), size))
}

// ── Instant, index first: the plan only (JS copies the sample bytes) ────────

/// An Instant cut laid out for a direct copy: `head` (ftyp + moov with its final chunk offsets +
/// the mdat header) is written first, then `runs` (`(source offset, length)`, in output order,
/// adjacent samples merged) are copied straight from the source file. Moov comes before mdat
/// ("fast start"); chunk offsets use co64 when they pass 4 GB and the mdat header has a 64-bit
/// size when the media data does.
pub struct Layout {
    pub head: Vec<u8>,
    pub runs: Vec<(u64, u64)>,
    pub duration: f64,
    pub size: u64,
}

/// A writer that keeps what the muxer writes except the media data: header, size patches and
/// the moov. The data bytes are counted, not stored.
#[derive(Default)]
struct Probe {
    pos: u64,
    end: u64,
    /// Discard writes (set while the samples are written; a seek ends it).
    skip: bool,
    /// Where the sample data starts (the header's length).
    head_len: Option<u64>,
    patches: Vec<(u64, Vec<u8>)>,
}
#[derive(Clone, Default)]
struct ProbeRef(std::rc::Rc<std::cell::RefCell<Probe>>);
impl Write for ProbeRef {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        let mut p = self.0.borrow_mut();
        if !p.skip {
            let pos = p.pos;
            p.patches.push((pos, b.to_vec()));
        }
        p.pos += b.len() as u64;
        p.end = p.end.max(p.pos);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Seek for ProbeRef {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let mut p = self.0.borrow_mut();
        let n = match to {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::End(d) => p.end as i128 + d as i128,
            SeekFrom::Current(d) => p.pos as i128 + d as i128,
        };
        p.pos = u64::try_from(n).map_err(|_| io::Error::other("seek before the start"))?;
        p.skip = false;
        Ok(p.pos)
    }
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|x| u32::from_be_bytes([x[0], x[1], x[2], x[3]]))
}

/// `moov` with every stco/co64 chunk offset moved by `shift`; stco becomes co64 where an offset
/// would pass 4 GB (or everywhere with `force64`). Box sizes are rebuilt.
pub(crate) fn shift_offsets(b: &[u8], shift: u64, force64: bool, depth: u32) -> Result<Vec<u8>, String> {
    const CONTAINERS: [&[u8; 4]; 5] = [b"moov", b"trak", b"mdia", b"minf", b"stbl"];
    if depth > 8 {
        return Err("moov nests too deep".into());
    }
    let mut out = Vec::with_capacity(b.len() + 64);
    let mut p = 0usize;
    while p + 8 <= b.len() {
        let size32 = be32(b, p).ok_or("bad box")? as u64;
        let kind: [u8; 4] = b[p + 4..p + 8].try_into().map_err(|_| "bad box")?;
        let (hdr, size) = match size32 {
            0 => (8usize, (b.len() - p) as u64),
            1 => {
                let s = b.get(p + 8..p + 16).ok_or("bad box")?;
                (16, u64::from_be_bytes(s.try_into().map_err(|_| "bad box")?))
            }
            s => (8, s),
        };
        let end = usize::try_from(size).ok().and_then(|s| p.checked_add(s)).filter(|&e| e <= b.len() && e >= p + hdr).ok_or("box past the end of moov")?;
        let body = &b[p + hdr..end];
        if CONTAINERS.contains(&&kind) {
            let inner = shift_offsets(body, shift, force64, depth + 1)?;
            out.extend_from_slice(&((inner.len() + 8) as u32).to_be_bytes());
            out.extend_from_slice(&kind);
            out.extend_from_slice(&inner);
        } else if &kind == b"stco" || &kind == b"co64" {
            let wide = &kind == b"co64";
            let n = be32(body, 4).ok_or("bad chunk table")? as usize;
            let w = if wide { 8 } else { 4 };
            if body.len() < 8 + n.saturating_mul(w) {
                return Err("chunk table past its box".into());
            }
            let offs: Vec<u64> = (0..n)
                .map(|i| {
                    let q = 8 + i * w;
                    let o = if wide { u64::from_be_bytes(body[q..q + 8].try_into().unwrap_or([0; 8])) } else { u64::from(be32(body, q).unwrap_or(0)) };
                    o + shift
                })
                .collect();
            let as64 = wide || force64 || offs.iter().any(|&o| o > u64::from(u32::MAX));
            let len = 8 + 8 + n * if as64 { 8 } else { 4 };
            out.extend_from_slice(&(len as u32).to_be_bytes());
            out.extend_from_slice(if as64 { b"co64" } else { b"stco" });
            out.extend_from_slice(&body[..4]); // version + flags
            out.extend_from_slice(&(n as u32).to_be_bytes());
            for o in offs {
                if as64 {
                    out.extend_from_slice(&o.to_be_bytes());
                } else {
                    out.extend_from_slice(&(o as u32).to_be_bytes());
                }
            }
        } else {
            out.extend_from_slice(&b[p..end]);
        }
        p = end;
    }
    Ok(out)
}

/// Plan an Instant cut for a direct copy (see [`Layout`]). Same cut as [`instant`]. `src_len`: the
/// source file's length; every sample of the cut must lie inside it.
pub fn instant_layout(c: &Container, pieces: &[f64], src_len: u64) -> Result<Layout, String> {
    let Container::Mp4(m) = c else { return Err("Instant cuts MP4 and MOV files only.".into()) };
    let plan = lossless::plan(m, &pairs(pieces))?;
    // the layout below allocates each sample's declared size: a damaged (or hostile) index must not
    // make a small file claim gigabyte samples
    for (_, ti, i) in plan.order(m) {
        let s = m.tracks.get(ti).and_then(|t| t.samples.get(i)).ok_or("no such sample")?;
        if s.offset.checked_add(u64::from(s.size)).is_none_or(|e| e > src_len) {
            return Err("The file is damaged: a frame lies past its end.".into());
        }
    }
    let probe = ProbeRef::default();
    let p = crate::Progress::default();
    let flag = probe.clone();
    lossless::write(
        &plan,
        m,
        probe.clone(),
        |ti, i| {
            // the header is written: from here on the muxer writes sample data (not kept)
            let mut f = flag.0.borrow_mut();
            if f.head_len.is_none() {
                f.head_len = Some(f.pos);
            }
            f.skip = true;
            drop(f);
            let s = m.tracks.get(ti).and_then(|t| t.samples.get(i)).ok_or("no such sample")?;
            Ok(vec![0u8; s.size as usize])
        },
        &p,
    )?;
    let pr = probe.0.borrow();
    // the header: everything written before the first sample, with the size patches applied
    let head_len = pr.head_len.ok_or("nothing to copy")?;
    let order = plan.order(m);
    let mut runs: Vec<(u64, u64)> = Vec::new();
    let mut data = 0u64;
    for (_, ti, i) in order {
        let s = m.tracks.get(ti).and_then(|t| t.samples.get(i)).ok_or("no such sample")?;
        data += u64::from(s.size);
        match runs.last_mut() {
            Some(r) if r.0 + r.1 == s.offset => r.1 += u64::from(s.size),
            _ => runs.push((s.offset, u64::from(s.size))),
        }
    }
    let data_end = head_len + data;
    let mut head = vec![0u8; usize::try_from(head_len).map_err(|_| "header too big")?];
    let mut moov = vec![0u8; usize::try_from(pr.end.saturating_sub(data_end)).map_err(|_| "index too big")?];
    for (pos, b) in &pr.patches {
        for (k, &x) in b.iter().enumerate() {
            let at = pos + k as u64;
            if at < head_len {
                head[at as usize] = x;
            } else if at >= data_end {
                if let Some(d) = moov.get_mut((at - data_end) as usize) {
                    *d = x;
                }
            }
        }
    }
    if moov.get(4..8) != Some(b"moov") {
        return Err("the index was not where it was expected".into());
    }
    if let Some(mat) = lossless::rotation(&plan, m) {
        lossless::patch_matrix(&mut moov, &mat)?;
    }
    // moov goes in front of the placeholder/mdat header, right after ftyp: every offset moves
    let ftyp = be32(&head, 0).ok_or("no ftyp")? as usize;
    let mut moved = shift_offsets(&moov, moov.len() as u64, false, 0)?;
    if moved.len() != moov.len() {
        moved = shift_offsets(&moov, 0, true, 0)?; // size with co64 everywhere (shift-independent)
        moved = shift_offsets(&moov, moved.len() as u64, true, 0)?;
    }
    if ftyp > head.len() {
        return Err("bad ftyp".into());
    }
    let mut out = Vec::with_capacity(head.len() + moved.len());
    out.extend_from_slice(&head[..ftyp]);
    out.extend_from_slice(&moved);
    out.extend_from_slice(&head[ftyp..]);
    let size = out.len() as u64 + data;
    Ok(Layout { head: out, runs, duration: plan.duration(), size })
}

// ── muxing encoded frames (Exact export) ────────────────────────────────────

struct Held {
    data: Vec<u8>,
    pts: f64,
    key: bool,
}

enum Out<W: Write + Seek> {
    Mp4(Option<Mp4Writer<W>>, bool),
    /// The Matroska writer needs every track up front: it starts at the first frame.
    Mkv { w: Option<W>, specs: Vec<mkv::TrackSpec>, writer: Option<mkv::MkvWriter<W>>, webm: bool },
}

/// MP4 / MOV / WebM / MKV muxer for frames from WebCodecs encoders (each track's frames come in
/// presentation order = decode order; durations come from the next frame's time, so variable
/// frame rates are kept).
pub struct Muxer<W: Write + Seek> {
    out: Out<W>,
    /// Per track: timescale (MP4/MOV), PCM bytes per frame, and the frame held back until the
    /// next one gives its duration.
    scale: Vec<u32>,
    pcm: Vec<Option<u32>>,
    held: Vec<Option<Held>>,
}

/// An `av1C` record: profile/level/tier/bit depth from the encoder's codec string, the sequence
/// header OBU from the first key frame (WebCodecs gives no description for AV1).
pub fn av1c(profile: u8, level: u8, high_tier: bool, bit_depth: u8, frame: &[u8]) -> Vec<u8> {
    let mut obus = Vec::new();
    let mut p = 0usize;
    while p < frame.len() {
        let h0 = frame[p];
        let kind = (h0 >> 3) & 0xF;
        let ext = (h0 >> 2) & 1 == 1;
        let has_size = (h0 >> 1) & 1 == 1;
        let mut q = p + 1 + usize::from(ext);
        let size = if has_size {
            let mut v = 0usize;
            let mut i = 0;
            loop {
                let Some(&b) = frame.get(q) else { break };
                v |= usize::from(b & 0x7F) << (7 * i);
                q += 1;
                i += 1;
                if b & 0x80 == 0 || i == 8 {
                    break;
                }
            }
            v
        } else {
            frame.len() - q
        };
        let end = (q + size).min(frame.len());
        if kind == 1 {
            obus.extend_from_slice(&frame[p..end]);
            break;
        }
        p = end.max(p + 1);
    }
    craft_media::isobmff::Av1Config {
        seq_profile: profile,
        seq_level_idx_0: level,
        seq_tier_0: high_tier,
        high_bitdepth: bit_depth > 8,
        twelve_bit: bit_depth == 12,
        monochrome: false,
        chroma_subsampling_x: profile != 1,
        chroma_subsampling_y: profile == 0,
        chroma_sample_position: 0,
        initial_presentation_delay_minus_one: None,
        config_obus: obus,
    }
    .to_bytes()
}

impl<W: Write + Seek> Muxer<W> {
    /// `container`: mp4, mov, webm or mkv.
    pub fn new(container: &str, w: W) -> Result<Self, String> {
        let out = match container {
            "mp4" | "mov" => {
                let mov = container == "mov";
                let mut o = WriterOptions::new(if mov { Brand::Mov } else { Brand::Mp4 });
                o.movie_timescale = 1000;
                Out::Mp4(Some(Mp4Writer::new(w, o).map_err(|e| e.to_string())?), mov)
            }
            "webm" | "mkv" => Out::Mkv { w: Some(w), specs: vec![], writer: None, webm: container == "webm" },
            c => return Err(format!("unknown container {c}")),
        };
        Ok(Muxer { out, scale: vec![], pcm: vec![], held: vec![] })
    }
    pub fn mp4(w: W) -> Result<Self, String> {
        Self::new("mp4", w)
    }
    pub fn webm(w: W) -> Self {
        Muxer { out: Out::Mkv { w: Some(w), specs: vec![], writer: None, webm: true }, scale: vec![], pcm: vec![], held: vec![] }
    }

    fn push(&mut self, scale: u32, pcm: Option<u32>) -> usize {
        self.scale.push(scale);
        self.pcm.push(pcm);
        self.held.push(None);
        self.scale.len() - 1
    }

    /// `codec`: h264 (description = avcC), hevc (hvcC), av1 (av1C) or vp9. `color`: ISO/IEC
    /// 23091-2 primaries, transfer, matrix and full range (written as `colr` in MP4/MOV).
    pub fn add_video(&mut self, codec: &str, width: u32, height: u32, description: &[u8], timescale: u32, color: Option<(u16, u16, u16, bool)>) -> Result<usize, String> {
        let (w16, h16) = (u16::try_from(width).map_err(|_| "too wide")?, u16::try_from(height).map_err(|_| "too tall")?);
        let ts = if timescale == 0 { 90_000 } else { timescale };
        match &mut self.out {
            Out::Mp4(Some(m), mov) => {
                let mut entry = match codec {
                    "h264" => SampleEntry::avc(AvcConfig::parse(description).map_err(|e| format!("avcC: {e}"))?, w16, h16),
                    "hevc" => SampleEntry::hevc(HevcConfig::parse(description).map_err(|e| format!("hvcC: {e}"))?, w16, h16),
                    "av1" => SampleEntry::av1(craft_media::isobmff::Av1Config::parse(description).map_err(|e| format!("av1C: {e}"))?, w16, h16),
                    c => return Err(format!("{} can't hold {c} here", if *mov { "MOV" } else { "MP4" })),
                };
                if let (Some(v), Some((primaries, transfer, matrix, full_range))) = (entry.video.as_mut(), color) {
                    v.color = Some(if *mov { craft_media::isobmff::ColorInfo::Nclc { primaries, transfer, matrix } } else { craft_media::isobmff::ColorInfo::Nclx { primaries, transfer, matrix, full_range } });
                }
                m.add_track(TrackConfig::new(entry, ts)).map_err(|e| e.to_string())?;
            }
            Out::Mkv { specs, writer: None, webm, .. } => {
                let id = match (codec, *webm) {
                    ("vp9", _) => "V_VP9",
                    ("vp8", _) => "V_VP8",
                    ("av1", _) => "V_AV1",
                    ("h264", false) => "V_MPEG4/ISO/AVC",
                    ("hevc", false) => "V_MPEGH/ISO/HEVC",
                    (c, _) => return Err(format!("WebM can't hold {c}")),
                };
                let mut s = mkv::TrackSpec::new(mkv::TrackKind::Video, id);
                s.video_size = Some((width, height));
                s.codec_private = description.to_vec();
                specs.push(s);
            }
            _ => return Err("muxer already started".into()),
        }
        Ok(self.push(ts, None))
    }

    /// `codec`: aac (description = AudioSpecificConfig), opus (OpusHead, or empty) or pcm
    /// (24-bit little-endian interleaved; MOV and MKV). `start`: ticks (track timescale: the
    /// sample rate, 48 kHz for Opus) of the first frame that are not played (AAC encoder
    /// priming, or the part of the first copied packet before the cut); MP4/MOV write it as an
    /// edit list.
    pub fn add_audio(&mut self, codec: &str, sample_rate: u32, channels: u32, description: &[u8], start: u32) -> Result<usize, String> {
        let ch8 = u8::try_from(channels.clamp(1, 255)).unwrap_or(2);
        let rate = sample_rate.max(1);
        let mut pcm = None;
        match &mut self.out {
            Out::Mp4(Some(m), mov) => {
                let entry = match codec {
                    "aac" => {
                        let asc = if description.is_empty() { aac_lc_asc(rate, channels) } else { description.to_vec() };
                        let c = AacConfig::from_asc(asc.clone());
                        SampleEntry::aac(asc, channels, if c.sample_rate > 0 { c.sample_rate } else { rate })
                    }
                    "opus" => {
                        let head = if description.is_empty() { default_opus_head(ch8, rate, 312) } else { description.to_vec() };
                        let cfg = opus_config(&head).ok_or("bad OpusHead")?;
                        SampleEntry::audio(FourCc(*b"Opus"), CodecConfig::Opus(cfg), channels, 48_000.0, 16)
                    }
                    "pcm" => {
                        let c = craft_media::isobmff::PcmConfig { bits: 24, float: false, big_endian: false, signed: true, channels, sample_rate: f64::from(rate) };
                        pcm = Some(c.bytes_per_frame());
                        SampleEntry::pcm(c)
                    }
                    c => return Err(format!("{} can't hold {c} here", if *mov { "MOV" } else { "MP4" })),
                };
                let ts = if codec == "opus" { 48_000 } else { rate };
                let mut cfg = TrackConfig::new(entry, ts);
                if start > 0 {
                    cfg.media_start = Some(i64::from(start));
                }
                m.add_track(cfg).map_err(|e| e.to_string())?;
                return Ok(self.push(ts, pcm));
            }
            Out::Mkv { specs, writer: None, webm, .. } => {
                let mut s = match (codec, *webm) {
                    ("opus", _) => {
                        let head = if description.is_empty() { default_opus_head(ch8, rate, 312) } else { description.to_vec() };
                        let pre_skip = opus_config(&head).map_or(312, |c| c.pre_skip);
                        let mut s = mkv::TrackSpec::new(mkv::TrackKind::Audio, "A_OPUS");
                        s.codec_private = head;
                        s.audio = Some((48_000.0, u64::from(channels), None));
                        s.codec_delay_ns = u64::from(pre_skip) * 1_000_000_000 / 48_000;
                        s.seek_pre_roll_ns = 80_000_000;
                        s
                    }
                    ("aac", false) => {
                        let mut s = mkv::TrackSpec::new(mkv::TrackKind::Audio, "A_AAC");
                        s.codec_private = if description.is_empty() { aac_lc_asc(rate, channels) } else { description.to_vec() };
                        s.audio = Some((f64::from(rate), u64::from(channels), None));
                        s
                    }
                    ("pcm", false) => {
                        pcm = Some(3 * channels.max(1));
                        let mut s = mkv::TrackSpec::new(mkv::TrackKind::Audio, "A_PCM/INT/LIT");
                        s.audio = Some((f64::from(rate), u64::from(channels), Some(24)));
                        s
                    }
                    (c, _) => return Err(format!("WebM can't hold {c}")),
                };
                s.language = None;
                specs.push(s);
            }
            _ => return Err("muxer already started".into()),
        }
        Ok(self.push(rate, pcm))
    }

    fn emit(&mut self, track: usize, h: Held, end: f64) -> Result<(), String> {
        let scale = f64::from(self.scale[track]);
        match &mut self.out {
            Out::Mp4(Some(m), _) => {
                let a = (h.pts * scale).round() as i64;
                let b = (end * scale).round() as i64;
                let dur = u32::try_from((b - a).max(1)).unwrap_or(1);
                m.write_sample(track, WriteSample { data: &h.data, duration: dur, composition_offset: 0, is_sync: h.key }).map_err(|e| e.to_string())
            }
            Out::Mkv { w, specs, writer, webm } => {
                if writer.is_none() {
                    let o = mkv::MuxOptions { doc_type: if *webm { "webm" } else { "matroska" }.into(), writing_app: "QuickCut".into(), ..Default::default() };
                    let ww = w.take().ok_or("muxer finished")?;
                    *writer = Some(mkv::MkvWriter::new(ww, std::mem::take(specs), o).map_err(|e| e.to_string())?);
                }
                let wr = writer.as_mut().ok_or("muxer finished")?;
                let pts_ns = (h.pts * 1e9).round() as i64;
                let dur_ns = ((end - h.pts) * 1e9).round().max(0.0) as u64;
                wr.write_frame(track, pts_ns.max(0), h.key, &h.data, Some(dur_ns)).map_err(|e| e.to_string())
            }
            Out::Mp4(None, _) => Err("muxer finished".into()),
        }
    }

    /// Add a frame (seconds). Frames of one track come in presentation order; the caller
    /// interleaves tracks by time.
    pub fn write(&mut self, track: usize, data: &[u8], pts: f64, key: bool) -> Result<(), String> {
        if track >= self.held.len() {
            return Err("no such track".into());
        }
        if let Some(fb) = self.pcm[track]
            && !data.len().is_multiple_of(fb as usize)
        {
            return Err("PCM data is not a whole number of frames".into());
        }
        if let Some(prev) = self.held[track].take() {
            let end = pts.max(prev.pts);
            self.emit(track, prev, end)?;
        }
        self.held[track] = Some(Held { data: data.to_vec(), pts, key });
        Ok(())
    }

    /// Write the held frames (`last_dur[track]` seconds each) and close the file.
    pub fn finish(mut self, last_dur: &[f64]) -> Result<W, String> {
        for t in 0..self.held.len() {
            if let Some(h) = self.held[t].take() {
                let end = h.pts + last_dur.get(t).copied().unwrap_or(0.02).max(1e-4);
                self.emit(t, h, end)?;
            }
        }
        match self.out {
            Out::Mp4(Some(m), _) => m.finish().map_err(|e| e.to_string()),
            Out::Mkv { writer: Some(w), .. } => w.finish().map_err(|e| e.to_string()),
            _ => Err("nothing was written".into()),
        }
    }
}

/// AudioSpecificConfig for AAC-LC.
pub fn aac_lc_asc(rate: u32, channels: u32) -> Vec<u8> {
    const RATES: [u32; 13] = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    let idx = RATES.iter().position(|&r| r == rate).unwrap_or(4) as u16;
    let v: u16 = (2 << 11) | (idx << 7) | ((channels.min(7) as u16) << 3);
    v.to_be_bytes().to_vec()
}

// ── speed change that keeps the pitch ───────────────────────────────────────

/// Play `planar` (one Vec per channel) at `speed` (2 = twice as fast) without changing its pitch
/// (WSOLA, FilmCraft's time stretch). Output length ≈ input / speed.
pub fn stretch(planar: &[Vec<f32>], rate: u32, speed: f64) -> Vec<Vec<f32>> {
    let n = planar.first().map_or(0, Vec::len);
    if n == 0 || !(speed > 0.0) || (speed - 1.0).abs() < 1e-6 {
        return planar.to_vec();
    }
    let w = filmcraft_audio_dsp::stretch::Wsola::new(rate);
    let h = w.hop();
    // mono guide for alignment
    let guide: Vec<f32> = (0..n).map(|i| planar.iter().map(|c| c[i]).sum::<f32>() / planar.len() as f32).collect();
    let out_len = (n as f64 / speed).round() as usize;
    let hops = out_len.div_ceil(h);
    let mut pos = Vec::with_capacity(hops + 2);
    pos.push(0i64);
    for k in 1..=hops + 1 {
        let nominal = (k as f64 * h as f64 * speed).round() as i64;
        let prev = *pos.last().unwrap_or(&0);
        pos.push(w.align(&guide, prev + h as i64, nominal));
    }
    let get = |c: &Vec<f32>, p: i64, len: usize| -> Vec<f32> { (0..len).map(|t| usize::try_from(p + t as i64).ok().and_then(|i| c.get(i)).copied().unwrap_or(0.0)).collect() };
    planar
        .iter()
        .map(|c| {
            let mut out = vec![0f32; hops * h];
            for k in 0..hops {
                // hop k: grain k's falling half (one hop in) crossfaded into grain k+1's rising half
                let prev = get(c, pos[k] + h as i64, h);
                let cur = get(c, pos[k + 1], h);
                w.overlap(&prev, &cur, &mut out[k * h..(k + 1) * h]);
            }
            out.truncate(out_len);
            out
        })
        .collect()
}
