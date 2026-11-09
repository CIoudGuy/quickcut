// Copyright (c) 2026 QuickCut contributors. Licensed under MIT OR Apache-2.0 (see LICENSE-MIT, LICENSE-APACHE).
//
// Written for QuickCut against the ISO BMFF demuxer/muxer in craft-media (`craft_media::isobmff`,
// storytold/craft-libs, MIT OR Apache-2.0; also re-exported by FilmCraft's `filmcraft-isobmff`).
// It was developed alongside FilmCraft's editor sources but is not part of the upstream
// storytold/filmcraft repository, so it lives here.

//! Instant export: copy the compressed samples of an MP4/MOV without re-encoding, with the
//! ISO BMFF demuxer and muxer.
//!
//! The first piece starts exactly on its In point: decoding starts on the keyframe before it and
//! the edit list hides the lead-in. Later pieces of a joined file start on their keyframe, because
//! most players honour only the first entry of an edit list.

use std::io::{Seek, Write};
use std::sync::atomic::Ordering;

use crate::Progress;
use craft_media::isobmff::{Brand, Edit, Mp4File, Mp4Writer, TrackConfig, TrackKind, WriteSample, WriterOptions};

/// Samples of one track picked for one piece: a decode-order index range and where the piece
/// starts in that track's raw media time.
struct Pick {
    first: usize,
    /// Exclusive.
    end: usize,
    media_in: i64,
}

/// The video samples of a piece. `exact_start`: start decoding on the keyframe before In and let
/// the edit list hide the lead-in; otherwise the piece starts on that keyframe. `closed`: end the
/// piece where nothing presented after Out is needed (B-frames), so the next piece joins cleanly.
/// Returns the pick and the piece's actual (start, end) in seconds.
fn pick_video(t: &craft_media::isobmff::Track, in_s: f64, out_s: f64, exact_start: bool, closed: bool) -> Option<(Pick, f64, f64)> {
    let n = t.samples.len();
    if n == 0 {
        return None;
    }
    let ts = f64::from(t.timescale.max(1));
    let off = t.edit_offset;
    let mut media_in = (in_s * ts).round() as i64 - off;
    let media_out = (out_s * ts).round() as i64 - off;
    let first = t.sync_sample_before(t.sample_at_pts(media_in)?);
    if !exact_start {
        media_in = t.samples[first].pts;
    }
    // look at samples up to well past Out in decode order
    let limit = t.samples.iter().enumerate().skip(first).find(|(_, s)| s.dts > media_out + ts as i64 * 4).map_or(n, |(i, _)| i);
    let win = &t.samples[first..limit];
    let (end, out_eff) = if closed {
        // largest cut e where every sample before it is presented before Out and before every
        // sample after it
        let mut suffix_min = vec![i64::MAX; win.len() + 1];
        for i in (0..win.len()).rev() {
            suffix_min[i] = suffix_min[i + 1].min(win[i].pts);
        }
        let (mut best, mut best_end) = (1usize, win[0].pts + i64::from(win[0].duration));
        let mut max_pts = i64::MIN;
        let mut max_end = 0i64;
        for e in 1..=win.len() {
            let s = &win[e - 1];
            if s.pts > max_pts {
                max_pts = s.pts;
                max_end = s.pts + i64::from(s.duration);
            }
            if max_pts >= media_out {
                break;
            }
            if max_pts < suffix_min[e] {
                best = e;
                best_end = max_end;
            }
        }
        (first + best, ((best_end + off) as f64 / ts).min(out_s.max(in_s)))
    } else {
        let last = win.iter().rposition(|s| s.pts < media_out).map_or(0, |i| i);
        (first + last + 1, out_s)
    };
    Some((Pick { first, end: end.min(n), media_in }, (media_in + off) as f64 / ts, out_eff))
}

fn pick_audio(t: &craft_media::isobmff::Track, in_s: f64, out_s: f64) -> Option<Pick> {
    if t.samples.is_empty() {
        return None;
    }
    let ts = f64::from(t.timescale.max(1));
    let media_in = (in_s * ts).round() as i64 - t.edit_offset;
    let media_out = (out_s * ts).round() as i64 - t.edit_offset;
    let first = t.sample_at_pts(media_in)?;
    let end = t.samples.iter().enumerate().skip(first).take_while(|(_, s)| s.pts < media_out).last().map_or(first + 1, |(i, _)| i + 1);
    Some(Pick { first, end, media_in })
}

/// What to copy: the kept tracks, each track's samples per piece, and the output layout.
pub struct Plan {
    /// Source track indices: the first video track, then every audio track.
    keep: Vec<usize>,
    /// `picks[k][piece]` for `keep[k]`.
    picks: Vec<Vec<Pick>>,
    /// Each piece's actual (start, end) in seconds.
    spans: Vec<(f64, f64)>,
    movie_ts: u32,
    vid: usize,
}

impl Plan {
    /// Samples to write, in output order: `(keep index, source track, sample index)`. Within a
    /// piece, tracks interleave by decode time (a good streaming layout).
    pub fn order(&self, mp4: &Mp4File) -> Vec<(usize, usize, usize)> {
        let mut all = Vec::new();
        for pi in 0..self.spans.len() {
            let mut order: Vec<(f64, usize, usize)> = Vec::new();
            for (k, &ti) in self.keep.iter().enumerate() {
                let t = &mp4.tracks[ti];
                let p = &self.picks[k][pi];
                let ts = f64::from(t.timescale.max(1));
                for i in p.first..p.end {
                    order.push((t.samples[i].dts as f64 / ts, k, i));
                }
            }
            order.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
            all.extend(order.into_iter().map(|(_, k, i)| (k, self.keep[k], i)));
        }
        all
    }

    /// Output length in seconds.
    pub fn duration(&self) -> f64 {
        self.spans.iter().map(|(a, b)| b - a).sum()
    }
}

/// Work out the cut of `pieces` (presentation seconds, in order).
///
/// One piece: starts exactly on In (an edit list hides the frames from the keyframe before it).
/// Several pieces joined: the first starts exactly on In; later ones start on the keyframe at or
/// before their In, because most players honour only the first entry of an edit list.
pub fn plan(mp4: &Mp4File, pieces: &[(f64, f64)]) -> Result<Plan, String> {
    if pieces.is_empty() {
        return Err("nothing to cut".into());
    }
    if mp4.fragmented {
        return Err("fragmented MP4: use Export for this file".into());
    }
    let vid = mp4.track_of_kind(TrackKind::Video).ok_or("no video track")?;
    let mut keep = vec![vid];
    keep.extend(mp4.tracks.iter().enumerate().filter(|(_, t)| t.kind == TrackKind::Audio && !t.samples.is_empty()).map(|(i, _)| i));
    // video decides where each piece really starts and ends; audio follows
    let last = pieces.len() - 1;
    let mut vpicks = Vec::new();
    let mut spans = Vec::new();
    for (k, &(a, b)) in pieces.iter().enumerate() {
        let (p, a2, b2) = pick_video(&mp4.tracks[vid], a, b, k == 0, k != last).ok_or("no video in the range")?;
        vpicks.push(p);
        spans.push((a2, b2.max(a2)));
    }
    let mut picks: Vec<Vec<Pick>> = vec![vpicks];
    for &ti in &keep[1..] {
        let t = &mp4.tracks[ti];
        let mut v = Vec::new();
        for &(a, b) in &spans {
            v.push(pick_audio(t, a, b).ok_or_else(|| format!("track {} has no samples in the range", t.id))?);
        }
        picks.push(v);
    }
    let movie_ts = mp4.tracks[vid].timescale.clamp(600, 1_000_000);
    Ok(Plan { keep, picks, spans, movie_ts, vid })
}

/// Write the planned cut to `w`. `read(track, sample)` supplies each sample's bytes, in
/// [`Plan::order`]. Returns the writer; the rotation is fixed up separately ([`patch_matrix`]).
pub fn write<W: Write + Seek>(
    plan: &Plan,
    mp4: &Mp4File,
    w: W,
    mut read: impl FnMut(usize, usize) -> Result<Vec<u8>, String>,
    progress: &Progress,
) -> Result<W, String> {
    let mut opts = WriterOptions::new(if mp4.is_quicktime { Brand::Mov } else { Brand::Mp4 });
    opts.movie_timescale = plan.movie_ts;
    let mut mux = Mp4Writer::new(w, opts).map_err(|e| e.to_string())?;
    // one edit per track: start at the first piece's In, run for all pieces
    let seg = (plan.duration() * f64::from(plan.movie_ts)).round().max(1.0) as u64;
    let mut out_tracks = Vec::new();
    for (k, &ti) in plan.keep.iter().enumerate() {
        let t = &mp4.tracks[ti];
        let entry = t.entries.first().cloned().ok_or("track without a sample description")?;
        let mut cfg = TrackConfig::new(entry, t.timescale);
        cfg.language = t.language.clone();
        let p0 = &plan.picks[k][0];
        let media_time = (p0.media_in - t.samples[p0.first].dts).max(0);
        cfg.edits.push(Edit { segment_duration: seg, media_time, media_rate: 0x10000 });
        out_tracks.push(mux.add_track(cfg).map_err(|e| e.to_string())?);
    }
    let order = plan.order(mp4);
    let total = order.len() as u64;
    progress.total.store(total.max(1), Ordering::Relaxed);
    progress.done.store(0, Ordering::Relaxed);
    for (done, (k, ti, i)) in order.into_iter().enumerate() {
        if progress.cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let s = mp4.tracks[ti].samples[i];
        let data = read(ti, i)?;
        let cto = i32::try_from(s.pts - s.dts).unwrap_or(0);
        mux.write_sample(out_tracks[k], WriteSample { data: &data, duration: s.duration, composition_offset: cto, is_sync: s.is_sync })
            .map_err(|e| e.to_string())?;
        if done % 256 == 255 {
            progress.done.store(done as u64 + 1, Ordering::Relaxed);
        }
    }
    let out = mux.finish().map_err(|e| e.to_string())?;
    progress.done.store(total, Ordering::Relaxed);
    Ok(out)
}

/// The source's display matrix when it is not upright (phone videos are stored rotated); the
/// muxer always writes an upright one.
pub fn rotation(plan: &Plan, mp4: &Mp4File) -> Option<[i32; 9]> {
    let m = mp4.tracks[plan.vid].matrix;
    (m != [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x4000_0000]).then_some(m)
}

/// Cut `pieces` of the file `src` into a new file at `out` (desktop).
#[cfg(not(target_arch = "wasm32"))]
pub fn cut(src: &std::path::Path, pieces: &[(f64, f64)], out: &std::path::Path, progress: &Progress) -> Result<(), String> {
    let file = std::fs::File::open(src).map_err(|e| format!("{}: {e}", src.display()))?;
    let mp4 = craft_media::isobmff::open(&file).map_err(|e| format!("reading {}: {e}", src.display()))?;
    let plan = plan(&mp4, pieces)?;
    let out_file = std::fs::File::create(out).map_err(|e| format!("{}: {e}", out.display()))?;
    let w = write(&plan, &mp4, std::io::BufWriter::with_capacity(4 << 20, out_file), |ti, i| mp4.read_sample(&file, ti, i).map_err(|e| e.to_string()), progress)?;
    let mut f = w.into_inner().map_err(|e| e.to_string())?;
    if let Some(m) = rotation(&plan, &mp4) {
        patch_matrix_file(&mut f, &m).map_err(|e| format!("rotation: {e}"))?;
    }
    Ok(())
}

/// Child boxes of `b`: `(offset, size, type)`.
fn children(b: &[u8]) -> Vec<(usize, usize, [u8; 4])> {
    let mut v = Vec::new();
    let mut p = 0usize;
    while p + 8 <= b.len() {
        let size = u32::from_be_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]) as usize;
        if size < 8 || p + size > b.len() {
            break;
        }
        v.push((p, size, [b[p + 4], b[p + 5], b[p + 6], b[p + 7]]));
        p += size;
    }
    v
}

/// Where the first video `tkhd` matrix sits inside a `moov` payload.
fn matrix_offset(moov: &[u8]) -> Option<usize> {
    for (tp, tsize, kind) in children(moov) {
        if &kind != b"trak" {
            continue;
        }
        let trak = moov.get(tp + 8..tp + tsize)?;
        if !trak.windows(4).any(|w| w == b"vide") {
            continue;
        }
        let (kp, _, _) = children(trak).into_iter().find(|c| &c.2 == b"tkhd")?;
        let k = tp + 8 + kp;
        let version = *moov.get(k + 8)?;
        // header(8) + version/flags(4) + times/ids/duration + reserved(8) + layer, group, volume, reserved(8)
        let fields = if version == 1 { 8 + 8 + 4 + 4 + 8 } else { 4 + 4 + 4 + 4 + 4 };
        let at = k + 12 + fields + 8 + 8;
        return (at + 36 <= moov.len()).then_some(at);
    }
    None
}

fn matrix_bytes(m: &[i32; 9]) -> Vec<u8> {
    m.iter().flat_map(|v| v.to_be_bytes()).collect()
}

/// Set the video track's display matrix in a finished MP4 held in memory (web).
pub fn patch_matrix(file: &mut [u8], m: &[i32; 9]) -> Result<(), String> {
    let mut pos = 0usize;
    while pos + 8 <= file.len() {
        let mut size = u32::from_be_bytes([file[pos], file[pos + 1], file[pos + 2], file[pos + 3]]) as usize;
        let mut head = 8;
        if size == 1 && pos + 16 <= file.len() {
            let mut b = [0u8; 8];
            b.copy_from_slice(&file[pos + 8..pos + 16]);
            size = usize::try_from(u64::from_be_bytes(b)).map_err(|_| "box too large")?;
            head = 16;
        } else if size == 0 {
            size = file.len() - pos;
        }
        if size < head || pos + size > file.len() {
            break;
        }
        if &file[pos + 4..pos + 8] == b"moov" {
            let moov = &mut file[pos + head..pos + size];
            let at = matrix_offset(moov).ok_or("no video tkhd")?;
            moov[at..at + 36].copy_from_slice(&matrix_bytes(m));
            return Ok(());
        }
        pos += size;
    }
    Err("no moov".into())
}

/// The same for a finished file on disk (desktop): only the `moov` is read and rewritten.
#[cfg(not(target_arch = "wasm32"))]
fn patch_matrix_file(f: &mut std::fs::File, m: &[i32; 9]) -> std::io::Result<()> {
    use std::io::{Read, SeekFrom};
    let len = f.metadata()?.len();
    let mut pos = 0u64;
    let mut hdr = [0u8; 16];
    let (moov, moov_end) = loop {
        if pos + 8 > len {
            return Err(std::io::Error::other("no moov"));
        }
        f.seek(SeekFrom::Start(pos))?;
        f.read_exact(&mut hdr[..8])?;
        let mut size = u64::from(u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]));
        let mut head = 8;
        if size == 1 {
            f.read_exact(&mut hdr[8..16])?;
            let mut b = [0u8; 8];
            b.copy_from_slice(&hdr[8..16]);
            size = u64::from_be_bytes(b);
            head = 16;
        } else if size == 0 {
            size = len - pos;
        }
        if &hdr[4..8] == b"moov" {
            break (pos + head, pos + size);
        }
        pos += size.max(8);
    };
    f.seek(SeekFrom::Start(moov))?;
    let mut buf = vec![0u8; usize::try_from(moov_end - moov).map_err(std::io::Error::other)?];
    f.read_exact(&mut buf)?;
    let at = matrix_offset(&buf).ok_or_else(|| std::io::Error::other("no video tkhd"))?;
    f.seek(SeekFrom::Start(moov + at as u64))?;
    f.write_all(&matrix_bytes(m))
}

#[cfg(test)]
pub(crate) fn patch_matrix_for_test(path: &std::path::Path, m: &[i32; 9]) {
    let mut f = std::fs::OpenOptions::new().read(true).write(true).open(path).unwrap();
    patch_matrix_file(&mut f, m).unwrap();
}
