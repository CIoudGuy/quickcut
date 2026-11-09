//! QuickCut Video's WebAssembly helpers, used from a Web Worker:
//!
//! - [`Media`]: open an MP4/MOV/MKV/WebM through a synchronous reader (the worker reads `Blob`
//!   slices with `FileReaderSync`, so a multi-GB file is never loaded at once), describe it, list
//!   its samples, read one sample, and cut it losslessly (Instant export: the cutter in
//!   `lossless.rs`).
//! - [`Mux`]: put encoded WebCodecs frames into an MP4 (H.264/HEVC + AAC/Opus) or a WebM
//!   (VP9 + Opus).
//! - [`stretch`]: change audio speed without changing its pitch.
//!
//! Output goes to a JS `write(bytes, position)` callback in large chunks (the muxers seek back
//! once at the end to patch sizes).

use std::io::{self, Seek, SeekFrom, Write};

use js_sys::{Function, Uint8Array};
use wasm_bindgen::prelude::*;

pub mod core;

#[allow(dead_code, clippy::all)]
mod lossless;

/// Counters the Instant cutter (`lossless.rs`) reports to: written / total samples, and a cancel flag.
#[derive(Default, Debug)]
pub struct Progress {
    pub done: std::sync::atomic::AtomicU64,
    pub total: std::sync::atomic::AtomicU64,
    pub cancel: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
mod tests;

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// `read(offset, length) -> Uint8Array` from JS.
struct JsSrc {
    read: Function,
    len: u64,
}

impl JsSrc {
    fn read_into(&self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
        if buf.is_empty() {
            return Ok(());
        }
        if offset.checked_add(buf.len() as u64).is_none_or(|e| e > self.len) {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "read past the end of the file"));
        }
        let r = self
            .read
            .call2(&JsValue::NULL, &JsValue::from_f64(offset as f64), &JsValue::from_f64(buf.len() as f64))
            .map_err(|_| io::Error::other("the file could not be read (was it moved or deleted?)"))?;
        let a: Uint8Array = r.dyn_into().map_err(|_| io::Error::other("reader returned no bytes"))?;
        if a.length() as usize != buf.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "short read"));
        }
        a.copy_to(buf);
        Ok(())
    }
}
impl craft_media::ByteSource for JsSrc {
    fn len(&self) -> u64 {
        self.len
    }
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
        self.read_into(offset, buf)
    }
}

/// `write(bytes, position)` to JS, in chunks of up to 4 MB.
struct JsSink {
    f: Function,
    pos: u64,
    end: u64,
    buf: Vec<u8>,
    buf_pos: u64,
}

const CHUNK: usize = 4 << 20;

impl JsSink {
    fn new(f: Function) -> Self {
        JsSink { f, pos: 0, end: 0, buf: Vec::with_capacity(CHUNK), buf_pos: 0 }
    }
    fn send(&mut self) -> io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let a = Uint8Array::from(self.buf.as_slice());
        self.f.call2(&JsValue::NULL, &a, &JsValue::from_f64(self.buf_pos as f64)).map_err(|_| io::Error::other("the output could not be written"))?;
        self.buf.clear();
        Ok(())
    }
}
impl Write for JsSink {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        if self.buf.is_empty() {
            self.buf_pos = self.pos;
        } else if self.buf_pos + self.buf.len() as u64 != self.pos {
            self.send()?;
            self.buf_pos = self.pos;
        }
        self.buf.extend_from_slice(b);
        self.pos += b.len() as u64;
        self.end = self.end.max(self.pos);
        if self.buf.len() >= CHUNK {
            self.send()?;
        }
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.send()
    }
}
impl Seek for JsSink {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.send()?;
        let p = match to {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::End(d) => self.end as i128 + d as i128,
            SeekFrom::Current(d) => self.pos as i128 + d as i128,
        };
        if p < 0 {
            return Err(io::Error::other("seek before the start"));
        }
        self.pos = p as u64;
        Ok(self.pos)
    }
}

/// An open media file.
#[wasm_bindgen]
pub struct Media {
    c: core::Container,
    src: JsSrc,
    info: core::Info,
}

#[wasm_bindgen]
impl Media {
    /// Open a file of `len` bytes read through `read(offset, length) -> Uint8Array`.
    #[wasm_bindgen(constructor)]
    pub fn new(read: Function, len: f64) -> Result<Media, JsError> {
        let src = JsSrc { read, len: len as u64 };
        let c = core::open(&src).map_err(err)?;
        let info = core::info(&c);
        Ok(Media { c, src, info })
    }

    /// The file's description as JSON (container, duration, tracks, why Instant is off).
    pub fn info(&self) -> String {
        core::info_json(&self.info)
    }

    /// WebCodecs `description` of a track (avcC, hvcC, AudioSpecificConfig, OpusHead…).
    pub fn description(&self, track: usize) -> Vec<u8> {
        core::description(&self.c, track)
    }

    /// `[pts, duration, key]` per sample in decode order (seconds).
    pub fn samples(&self, track: usize) -> Vec<f64> {
        core::samples(&self.c, track)
    }

    /// One sample's bytes.
    pub fn read(&self, track: usize, index: usize) -> Result<Vec<u8>, JsError> {
        core::read_sample(&self.c, &self.src, track, index).map_err(err)
    }

    /// `[seconds, bytes]` an Instant cut of `pieces` (`[start, end, …]` seconds) would produce.
    pub fn instant_estimate(&self, pieces: Vec<f64>) -> Result<Vec<f64>, JsError> {
        let (d, b) = core::instant_estimate(&self.c, &pieces).map_err(err)?;
        Ok(vec![d, b as f64])
    }

    /// Instant (lossless) cut of `pieces` into `write(bytes, position)`; `progress(done, total)`.
    /// Returns `[seconds, bytes]`.
    pub fn instant(&self, pieces: Vec<f64>, write: Function, progress: Function) -> Result<Vec<f64>, JsError> {
        let (_, d, b) = core::instant(&self.c, &self.src, &pieces, JsSink::new(write), |done, total| {
            let _ = progress.call2(&JsValue::NULL, &JsValue::from_f64(done as f64), &JsValue::from_f64(total as f64));
        })
        .map_err(err)?;
        Ok(vec![d, b as f64])
    }

    /// Instant cut planned for a direct copy: write `head()`, then copy each `runs()` pair
    /// `[source offset, length]` from the source file, in order. Moov first (fast start).
    pub fn instant_layout(&self, pieces: Vec<f64>) -> Result<InstantLayout, JsError> {
        let l = core::instant_layout(&self.c, &pieces, self.src.len).map_err(err)?;
        Ok(InstantLayout { l })
    }
}

/// See [`Media::instant_layout`].
#[wasm_bindgen]
pub struct InstantLayout {
    l: core::Layout,
}

#[wasm_bindgen]
impl InstantLayout {
    pub fn head(&self) -> Vec<u8> {
        self.l.head.clone()
    }
    /// `[offset, length, offset, length, …]` (bytes in the source file).
    pub fn runs(&self) -> Vec<f64> {
        self.l.runs.iter().flat_map(|&(o, n)| [o as f64, n as f64]).collect()
    }
    pub fn duration(&self) -> f64 {
        self.l.duration
    }
    /// Size of the whole output file in bytes.
    pub fn size(&self) -> f64 {
        self.l.size as f64
    }
}

/// A muxer for encoded frames.
#[wasm_bindgen]
pub struct Mux {
    m: Option<core::Muxer<JsSink>>,
}

#[wasm_bindgen]
impl Mux {
    /// `container`: mp4, mov, webm or mkv. Output goes to `write(bytes, position)`.
    #[wasm_bindgen(constructor)]
    pub fn new(container: &str, write: Function) -> Result<Mux, JsError> {
        Ok(Mux { m: Some(core::Muxer::new(container, JsSink::new(write)).map_err(err)?) })
    }
    fn m(&mut self) -> Result<&mut core::Muxer<JsSink>, JsError> {
        self.m.as_mut().ok_or_else(|| JsError::new("muxer finished"))
    }
    /// `color`: `[primaries, transfer, matrix, full_range]` (ISO/IEC 23091-2 codes), or empty.
    pub fn add_video(&mut self, codec: &str, width: u32, height: u32, description: Vec<u8>, timescale: u32, color: Vec<u16>) -> Result<usize, JsError> {
        let c = (color.len() == 4).then(|| (color[0], color[1], color[2], color[3] != 0));
        self.m()?.add_video(codec, width, height, &description, timescale, c).map_err(err)
    }
    /// `start`: leading ticks not played (AAC priming / cut inside the first packet), see core.
    pub fn add_audio(&mut self, codec: &str, sample_rate: u32, channels: u32, description: Vec<u8>, start: u32) -> Result<usize, JsError> {
        self.m()?.add_audio(codec, sample_rate, channels, &description, start).map_err(err)
    }
    pub fn write(&mut self, track: usize, data: &[u8], pts: f64, key: bool) -> Result<(), JsError> {
        self.m()?.write(track, data, pts, key).map_err(err)
    }
    /// Close the file; `last_dur` is each track's last frame duration (s). Returns its size.
    pub fn finish(&mut self, last_dur: Vec<f64>) -> Result<f64, JsError> {
        let m = self.m.take().ok_or_else(|| JsError::new("muxer finished"))?;
        let mut s = m.finish(&last_dur).map_err(err)?;
        s.flush().map_err(err)?;
        Ok(s.end as f64)
    }
}

/// An `av1C` record for an AV1 track (from the first key frame's sequence header).
#[wasm_bindgen]
pub fn av1c(profile: u8, level: u8, high_tier: bool, bit_depth: u8, frame: &[u8]) -> Vec<u8> {
    core::av1c(profile, level, high_tier, bit_depth, frame)
}

thread_local! {
    static LAST_PANIC: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}
/// Keep a panic's message (a wasm trap only says "unreachable"); read it with [`last_panic`].
#[wasm_bindgen(start)]
pub fn start() {
    std::panic::set_hook(Box::new(|info| {
        let msg = info.to_string();
        LAST_PANIC.with(|p| *p.borrow_mut() = msg);
    }));
}
/// The last panic's message ("" if none).
#[wasm_bindgen]
pub fn last_panic() -> String {
    LAST_PANIC.with(|p| p.borrow().clone())
}

/// Speed change keeping the pitch. `planar` holds `channels` equal-length channels one after
/// another; returns the same layout, about `1 / speed` as long.
#[wasm_bindgen]
pub fn stretch(planar: Vec<f32>, channels: usize, rate: u32, speed: f64) -> Vec<f32> {
    let ch = channels.max(1);
    let n = planar.len() / ch;
    let chans: Vec<Vec<f32>> = (0..ch).map(|c| planar[c * n..(c + 1) * n].to_vec()).collect();
    core::stretch(&chans, rate, speed).concat()
}
