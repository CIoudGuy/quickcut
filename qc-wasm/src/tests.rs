//! Native tests of the core: a synthetic H.264 + AAC MP4 (sample payloads carry their own index)
//! is probed, cut losslessly and read back; the muxers' output is read back with the demuxers.

use std::io::{Cursor, Seek, SeekFrom, Write};

use craft_media::isobmff::{AvcConfig, Brand, HevcConfig, Mp4Writer, SampleEntry, TrackConfig, WriteSample, WriterOptions};

use crate::core::{self, Mem};

const FPS: u32 = 30;
const SECS: u32 = 6;
const GOP: u32 = 30;

fn avcc() -> AvcConfig {
    AvcConfig::new(vec![vec![0x67, 0x64, 0x00, 0x28, 0xAC, 0xD9, 0x40]], vec![vec![0x68, 0xEB, 0xE3, 0xCB]], 4)
}

/// 6 s of 30 fps "video" (keyframe every second) and 48 kHz "AAC" (1024-sample frames).
fn fixture() -> Vec<u8> {
    let mut o = WriterOptions::new(Brand::Mp4);
    o.movie_timescale = 1000;
    let mut m = Mp4Writer::new(Cursor::new(Vec::new()), o).unwrap();
    let v = m.add_track(TrackConfig::new(SampleEntry::avc(avcc(), 320, 240), FPS * 100)).unwrap();
    let a = m.add_track(TrackConfig::new(SampleEntry::aac(core::aac_lc_asc(48_000, 2), 2, 48_000), 48_000)).unwrap();
    let frames = FPS * SECS;
    let aframes = 48_000 * SECS / 1024;
    let (mut vi, mut ai) = (0u32, 0u32);
    while vi < frames || ai < aframes {
        let vt = f64::from(vi) / f64::from(FPS);
        let at = f64::from(ai) * 1024.0 / 48_000.0;
        if vi < frames && (vt <= at || ai >= aframes) {
            let data = [0u8, 0, 0, 4, 0x65, (vi >> 8) as u8, vi as u8, 0xAA];
            m.write_sample(v, WriteSample { data: &data, duration: 100, composition_offset: 0, is_sync: vi % GOP == 0 }).unwrap();
            vi += 1;
        } else {
            let data = [0x21, (ai >> 8) as u8, ai as u8];
            m.write_sample(a, WriteSample { data: &data, duration: 1024, composition_offset: 0, is_sync: true }).unwrap();
            ai += 1;
        }
    }
    m.finish().unwrap().into_inner()
}

fn frame_no(b: &[u8]) -> u32 {
    (u32::from(b[5]) << 8) | u32::from(b[6])
}

#[test]
fn probes_an_mp4() {
    let src = Mem(fixture());
    let c = core::open(&src).unwrap();
    let i = core::info(&c);
    assert_eq!(i.container, "mp4");
    assert!((i.duration - 6.0).abs() < 0.01, "{}", i.duration);
    let v = &i.tracks[i.video.unwrap()];
    assert_eq!((v.codec.as_str(), v.codec_string.as_str(), v.width, v.height), ("h264", "avc1.640028", 320, 240));
    assert!((v.fps - 30.0).abs() < 1e-6);
    assert_eq!(v.frames, 180);
    let a = &i.tracks[i.audio.unwrap()];
    assert_eq!((a.codec.as_str(), a.codec_string.as_str(), a.sample_rate, a.channels), ("aac", "mp4a.40.2", 48_000, 2));
    assert_eq!(i.instant_off, None);
    let json = core::info_json(&i);
    assert!(json.contains("\"codecString\":\"avc1.640028\"") && json.contains("\"instantOff\":null"), "{json}");
    // samples: [pts, dur, key]
    let s = core::samples(&c, i.video.unwrap());
    assert_eq!(s.len(), 180 * 3);
    assert_eq!((s[0], s[2], s[5], s[30 * 3 + 2]), (0.0, 1.0, 0.0, 1.0));
    assert!((s[3] - 1.0 / 30.0).abs() < 1e-9);
    assert_eq!(frame_no(&core::read_sample(&c, &src, i.video.unwrap(), 77).unwrap()), 77);
    assert_eq!(core::description(&c, i.video.unwrap()), avcc().to_bytes());
}

#[test]
fn instant_cut_of_three_pieces_in_any_order() {
    let src = Mem(fixture());
    let c = core::open(&src).unwrap();
    // three pieces, the last one earlier in the source than the second
    let pieces = [0.5, 1.5, 3.0, 4.0, 2.0, 2.5];
    let (est_d, est_b) = core::instant_estimate(&c, &pieces).unwrap();
    let mut calls = 0;
    let (out, d, size) = core::instant(&c, &src, &pieces, Cursor::new(Vec::new()), |_, _| calls += 1).unwrap();
    assert!(calls >= 1);
    let bytes = out.into_inner();
    assert_eq!(size, bytes.len() as u64);
    assert_eq!(d, est_d);
    assert!(est_b > 0 && est_b < size);
    // first piece exact (1.0 s); later pieces start on their keyframe (3.0 and 2.0) and end on Out
    assert!((d - 2.5).abs() < 0.04, "{d}");
    let o = core::open(&Mem(bytes.clone())).unwrap();
    let core::Container::Mp4(m) = &o else { panic!() };
    let vt = &m.tracks[0];
    let frames: Vec<u32> = (0..vt.samples.len()).map(|i| frame_no(&m.read_sample(&bytes, 0, i).unwrap())).collect();
    // piece 1 decodes from the keyframe at 0 (edit list hides 0..0.5), then 90.. and 60..
    assert_eq!(frames[0], 0);
    assert!(frames.contains(&90) && frames.contains(&60));
    let at90 = frames.iter().position(|&f| f == 90).unwrap();
    let at60 = frames.iter().position(|&f| f == 60).unwrap();
    assert!(at90 < at60, "pieces keep their order");
    assert!(vt.samples[at90].is_sync && vt.samples[at60].is_sync);
    assert_eq!(vt.edit_offset, -(15 * 100), "the first 0.5 s are hidden by the edit list");
    assert_eq!(m.tracks.len(), 2);
}

#[test]
fn instant_keeps_the_display_rotation() {
    let mut f = fixture();
    let quarter = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x4000_0000];
    crate::lossless::patch_matrix(&mut f, &quarter).unwrap();
    let src = Mem(f);
    let c = core::open(&src).unwrap();
    assert_eq!(core::info(&c).tracks[0].rotation, 1);
    let (out, _, _) = core::instant(&c, &src, &[1.0, 2.0], Cursor::new(Vec::new()), |_, _| {}).unwrap();
    let o = core::open(&Mem(out.into_inner())).unwrap();
    assert_eq!(core::info(&o).tracks[0].rotation, 1);
}

#[test]
fn instant_refuses_matroska() {
    let src = Mem(webm_bytes());
    let c = core::open(&src).unwrap();
    assert!(core::info(&c).instant_off.unwrap().contains("WEBM"));
    assert!(core::instant_estimate(&c, &[0.0, 1.0]).is_err());
}

#[test]
fn muxes_mp4_from_encoded_frames() {
    let mut m = core::Muxer::mp4(Cursor::new(Vec::new())).unwrap();
    let v = m.add_video("h264", 640, 360, &avcc().to_bytes(), 30_000, Some((1, 1, 1, false))).unwrap();
    let a = m.add_audio("aac", 48_000, 2, &[], 0).unwrap();
    for i in 0..60u32 {
        let t = f64::from(i) / 30.0;
        if i % 2 == 0 {
            m.write(a, &[1, 2, 3], f64::from(i / 2) * 1024.0 / 48_000.0, true).unwrap();
        }
        m.write(v, &[0, 0, 0, 2, 0x65, i as u8], t, i % 30 == 0).unwrap();
    }
    let bytes = m.finish(&[1.0 / 30.0, 1024.0 / 48_000.0]).unwrap().into_inner();
    let c = core::open(&Mem(bytes)).unwrap();
    let i = core::info(&c);
    let vt = &i.tracks[i.video.unwrap()];
    assert_eq!((vt.frames, vt.width, vt.height, vt.codec.as_str()), (60, 640, 360, "h264"));
    assert!((vt.duration - 2.0).abs() < 1e-3, "{}", vt.duration);
    assert!((vt.fps - 30.0).abs() < 0.01);
    let s = core::samples(&c, i.video.unwrap());
    assert_eq!((s[2], s[5], s[30 * 3 + 2]), (1.0, 0.0, 1.0));
    let at = &i.tracks[i.audio.unwrap()];
    assert_eq!((at.frames, at.sample_rate, at.codec_string.as_str()), (30, 48_000, "mp4a.40.2"));
}

fn webm_bytes() -> Vec<u8> {
    let mut m = core::Muxer::webm(Cursor::new(Vec::new()));
    let v = m.add_video("vp9", 320, 180, &[], 0, None).unwrap();
    let a = m.add_audio("opus", 48_000, 2, &[], 0).unwrap();
    for i in 0..50u32 {
        let t = f64::from(i) * 0.02;
        if i % 2 == 0 {
            m.write(v, &[0x82, 0x49, 0x83, i as u8], t, i % 10 == 0).unwrap();
        }
        m.write(a, &[0xFC, i as u8], t, true).unwrap();
    }
    m.finish(&[0.04, 0.02]).unwrap().into_inner()
}

#[test]
fn muxes_webm_from_encoded_frames() {
    let c = core::open(&Mem(webm_bytes())).unwrap();
    let i = core::info(&c);
    assert_eq!(i.container, "webm");
    let vt = &i.tracks[i.video.unwrap()];
    assert_eq!((vt.frames, vt.width, vt.codec.as_str()), (25, 320, "vp9"));
    assert!((vt.fps - 25.0).abs() < 0.01, "{}", vt.fps);
    let at = &i.tracks[i.audio.unwrap()];
    assert_eq!((at.frames, at.codec.as_str(), at.channels), (50, "opus", 2));
    assert!((i.duration - 1.0).abs() < 0.03, "{}", i.duration);
    let s = core::samples(&c, i.video.unwrap());
    assert_eq!((s[2], s[5], s[5 * 3 + 2]), (1.0, 0.0, 1.0));
}

#[test]
fn codec_strings() {
    let mut h = HevcConfig { general_profile_idc: 1, general_profile_compatibility_flags: 0x6000_0000, general_level_idc: 153, ..Default::default() };
    h.general_constraint_indicator_flags = 0xB000_0000_0000;
    assert_eq!(core::hevc_string("hvc1", &h), "hvc1.1.6.L153.B0");
    h.general_tier_flag = true;
    h.general_profile_idc = 2;
    h.general_profile_compatibility_flags = 0x2000_0000;
    h.general_constraint_indicator_flags = 0;
    assert_eq!(core::hevc_string("hev1", &h), "hev1.2.4.H153");
    assert_eq!(core::aac_lc_asc(48_000, 2), vec![0x11, 0x90]);
    assert_eq!(core::aac_lc_asc(44_100, 1), vec![0x12, 0x08]);
    let head = core::default_opus_head(2, 48_000, 312);
    let cfg = core::opus_config(&head).unwrap();
    assert_eq!((cfg.output_channels, cfg.pre_skip, cfg.input_sample_rate), (2, 312, 48_000));
    assert_eq!(core::opus_head(&cfg), head);
}

#[test]
fn stretch_keeps_pitch_and_halves_length() {
    let sr = 48_000u32;
    let tone: Vec<f32> = (0..sr as usize).map(|i| (2.0 * std::f64::consts::PI * 440.0 * i as f64 / f64::from(sr)).sin() as f32 * 0.5).collect();
    let out = core::stretch(&[tone.clone(), tone], sr, 2.0);
    assert_eq!(out.len(), 2);
    assert!((out[0].len() as i64 - 24_000).abs() <= 1, "{}", out[0].len());
    let mid = &out[0][2_000..22_000];
    let crossings = mid.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count() as f64 * f64::from(sr) / mid.len() as f64;
    assert!((crossings - 440.0).abs() < 8.0, "{crossings}");
    let rms = (mid.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / mid.len() as f64).sqrt();
    assert!((rms - 0.5 / 2f64.sqrt()).abs() < 0.03, "{rms}");
    // slow down to half speed: twice as long
    let slow = core::stretch(&[vec![0.1f32; 4800]], sr, 0.5);
    assert_eq!(slow[0].len(), 9600);
    // speed 1 is a copy
    assert_eq!(core::stretch(&[vec![0.25f32; 10]], sr, 1.0)[0], vec![0.25f32; 10]);
}

#[test]
fn tail_keeps_only_what_follows_the_size_patch() {
    // Instant wrote the whole output into memory before this fix (a 1.7 GB export trapped)
    let mut t = core::Tail::new(Cursor::new(Vec::new()));
    t.write_all(&vec![7u8; 1 << 20]).unwrap();
    assert!(t.tail.is_empty(), "nothing is kept before the first seek");
    t.seek(SeekFrom::Start(4)).unwrap();
    t.write_all(&[1, 2, 3, 4]).unwrap();
    t.seek(SeekFrom::Start(1 << 20)).unwrap();
    t.write_all(b"moov").unwrap();
    assert_eq!((t.tail_pos, t.tail.as_slice()), (1 << 20, &b"moov"[..]));
}

#[test]
fn muxes_mov_and_mkv_with_pcm() {
    for container in ["mov", "mkv"] {
        let mut m = core::Muxer::new(container, Cursor::new(Vec::new())).unwrap();
        let v = m.add_video("h264", 320, 240, &avcc().to_bytes(), 600, Some((1, 1, 1, false))).unwrap();
        let a = m.add_audio("pcm", 48_000, 2, &[], 0).unwrap();
        for i in 0..30u32 {
            let t = f64::from(i) / 30.0;
            m.write(a, &vec![0u8; 1600 * 6], t, true).unwrap();
            m.write(v, &[0, 0, 0, 2, 0x65, i as u8], t, i == 0).unwrap();
        }
        assert!(m.write(a, &[0u8; 5], 1.0, true).is_err(), "PCM must be whole frames");
        let bytes = m.finish(&[1.0 / 30.0, 1600.0 / 48_000.0]).unwrap().into_inner();
        let c = core::open(&Mem(bytes)).unwrap();
        let i = core::info(&c);
        assert_eq!(i.container, container);
        let vt = &i.tracks[i.video.unwrap()];
        assert_eq!((vt.frames, vt.codec.as_str()), (30, "h264"), "{container}");
        assert!((vt.duration - 1.0).abs() < 0.01, "{container} {}", vt.duration);
        let at = &i.tracks[i.audio.unwrap()];
        assert!(at.codec.starts_with("pcm"), "{container} {}", at.codec);
        assert_eq!((at.sample_rate, at.channels), (48_000, 2), "{container}");
    }
}

#[test]
fn av1_config_from_the_first_key_frame() {
    let seq = [0x0A, 0x05, 0x00, 0x00, 0x00, 0x24, 0xC4];
    let frame = [&[0x12u8, 0x00][..], &seq[..], &[0x32, 0x02, 0xAA, 0xBB][..]].concat();
    let c = core::av1c(0, 8, false, 8, &frame);
    assert_eq!(&c[4..], &seq[..], "the sequence header OBU is kept");
    let mut m = core::Muxer::mp4(Cursor::new(Vec::new())).unwrap();
    let v = m.add_video("av1", 64, 64, &c, 0, None).unwrap();
    m.write(v, &frame, 0.0, true).unwrap();
    let bytes = m.finish(&[0.04]).unwrap().into_inner();
    let i = core::info(&core::open(&Mem(bytes)).unwrap());
    assert_eq!(i.tracks[0].codec_string, "av01.0.08M.08");
    // AAC in MKV
    let mut m = core::Muxer::new("mkv", Cursor::new(Vec::new())).unwrap();
    let v = m.add_video("h264", 64, 64, &avcc().to_bytes(), 0, None).unwrap();
    let a = m.add_audio("aac", 44_100, 2, &core::aac_lc_asc(44_100, 2), 0).unwrap();
    m.write(a, &[0x21, 1], 0.0, true).unwrap();
    m.write(v, &[0, 0, 0, 1, 0x65], 0.0, true).unwrap();
    let bytes = m.finish(&[0.04, 0.023]).unwrap().into_inner();
    let i = core::info(&core::open(&Mem(bytes)).unwrap());
    assert_eq!((i.container, i.tracks[1].codec.as_str()), ("mkv", "aac"));
}

/// The direct-copy layout: head + copied runs must give the same cut as the streamed Instant
/// export, with moov in front of mdat.
fn assemble(src: &[u8], l: &core::Layout) -> Vec<u8> {
    let mut out = l.head.clone();
    for &(o, n) in &l.runs {
        out.extend_from_slice(&src[o as usize..(o + n) as usize]);
    }
    out
}

#[test]
fn instant_layout_matches_the_streamed_cut_with_moov_first() {
    let mut f = fixture();
    let quarter = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x4000_0000];
    crate::lossless::patch_matrix(&mut f, &quarter).unwrap();
    let src = Mem(f.clone());
    let c = core::open(&src).unwrap();
    for pieces in [vec![0.5, 1.5, 3.0, 4.0, 2.0, 2.5], vec![0.0, 6.0], vec![1.2, 4.7]] {
        let (want, d, _) = core::instant(&c, &src, &pieces, Cursor::new(Vec::new()), |_, _| {}).unwrap();
        let l = core::instant_layout(&c, &pieces, f.len() as u64).unwrap();
        let got = assemble(&f, &l);
        assert_eq!(got.len() as u64, l.size);
        assert_eq!(l.duration, d);
        // moov before mdat
        let moov = got.windows(4).position(|w| w == b"moov").unwrap();
        let mdat = got.windows(4).position(|w| w == b"mdat").unwrap();
        assert!(moov < mdat, "fast start");
        let want = want.into_inner();
        let (a, b) = (core::open(&Mem(want.clone())).unwrap(), core::open(&Mem(got.clone())).unwrap());
        assert_eq!(core::info(&a), core::info(&b));
        let (core::Container::Mp4(ma), core::Container::Mp4(mb)) = (&a, &b) else { panic!() };
        for t in 0..ma.tracks.len() {
            assert_eq!(ma.tracks[t].samples.len(), mb.tracks[t].samples.len());
            assert_eq!(ma.tracks[t].edit_offset, mb.tracks[t].edit_offset);
            for i in 0..ma.tracks[t].samples.len() {
                assert_eq!(ma.read_sample(&want, t, i).unwrap(), mb.read_sample(&got, t, i).unwrap(), "track {t} sample {i}");
                assert_eq!((ma.tracks[t].samples[i].pts, ma.tracks[t].samples[i].duration), (mb.tracks[t].samples[i].pts, mb.tracks[t].samples[i].duration));
            }
        }
        assert_eq!(core::info(&b).tracks[0].rotation, 1);
    }
}

#[test]
fn chunk_offsets_past_4_gb_become_co64() {
    let f = fixture();
    let at = f.windows(4).position(|w| w == b"moov").unwrap() - 4;
    let moov = &f[at..];
    let shift = 5_000_000_000u64;
    let moved = core::shift_offsets(moov, shift, false, 0).unwrap();
    assert!(moved.windows(4).any(|w| w == b"co64") && !moved.windows(4).any(|w| w == b"stco"));
    // the moved moov parses and its offsets are the old ones + shift
    let mut file = f[..at].to_vec();
    file.extend_from_slice(&moved);
    let old = craft_media::isobmff::open(&f).unwrap();
    let new = craft_media::isobmff::open(&file).unwrap();
    for t in 0..old.tracks.len() {
        for (a, b) in old.tracks[t].samples.iter().zip(&new.tracks[t].samples) {
            assert_eq!(a.offset + shift, b.offset);
        }
    }
    // a small shift keeps stco
    let small = core::shift_offsets(moov, 100, false, 0).unwrap();
    assert_eq!(small.len(), moov.len());
}

#[test]
fn audio_start_becomes_an_edit_list() {
    let mut m = core::Muxer::mp4(Cursor::new(Vec::new())).unwrap();
    let v = m.add_video("h264", 640, 360, &avcc().to_bytes(), 30_000, None).unwrap();
    let a = m.add_audio("aac", 48_000, 2, &[], 1024).unwrap();
    for i in 0..30u32 {
        m.write(a, &[1, 2, 3], f64::from(i) * 1024.0 / 48_000.0, true).unwrap();
        m.write(v, &[0, 0, 0, 2, 0x65, i as u8], f64::from(i) / 30.0, i == 0).unwrap();
    }
    let bytes = m.finish(&[1.0 / 30.0, 1024.0 / 48_000.0]).unwrap().into_inner();
    let c = core::open(&Mem(bytes)).unwrap();
    let i = core::info(&c);
    let s = core::samples(&c, i.audio.unwrap());
    // the first packet starts 1024 samples before the movie's time 0
    assert!((s[0] + 1024.0 / 48_000.0).abs() < 1e-9, "{}", s[0]);
    let vs = core::samples(&c, i.video.unwrap());
    assert_eq!(vs[0], 0.0);
}

// ── hostile input ───────────────────────────────────────────────────────────

/// One EBML element with an 8-byte size field.
fn el(id: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut v = id.to_vec();
    v.push(0x01);
    v.extend_from_slice(&(payload.len() as u64).to_be_bytes()[1..]);
    v.extend_from_slice(payload);
    v
}

fn uint(id: &[u8], n: u64) -> Vec<u8> {
    el(id, &n.to_be_bytes())
}

/// A tiny Matroska file whose one video track lists `encodings` ContentEncoding entries
/// (header stripping, as a muxer would write; a hostile file can list thousands).
fn mkv_with_encodings(encodings: usize) -> Vec<u8> {
    let one = |i: u64| {
        let comp = [el(&[0x42, 0x54], &[3]), el(&[0x42, 0x55], &[1])].concat();
        el(&[0x62, 0x40], &[uint(&[0x50, 0x31], i), uint(&[0x50, 0x32], 1), uint(&[0x50, 0x33], 0), el(&[0x50, 0x34], &comp)].concat())
    };
    let encs: Vec<u8> = (0..encodings as u64).flat_map(one).collect();
    let video = el(&[0xE0], &[uint(&[0xB0], 320), uint(&[0xBA], 180)].concat());
    let track = el(&[0xAE], &[uint(&[0xD7], 1), uint(&[0x73, 0xC5], 1), uint(&[0x83], 1), el(&[0x86], b"V_VP9"), video, el(&[0x6D, 0x80], &encs)].concat());
    let block = el(&[0xA3], &[0x81, 0x00, 0x00, 0x80, 1, 2, 3, 4]);
    let cluster = el(&[0x1F, 0x43, 0xB6, 0x75], &[uint(&[0xE7], 0), block].concat());
    let seg = [el(&[0x15, 0x49, 0xA9, 0x66], &uint(&[0x2A, 0xD7, 0xB1], 1_000_000)), el(&[0x16, 0x54, 0xAE, 0x6B], &track), cluster].concat();
    [el(&[0x1A, 0x45, 0xDF, 0xA3], &el(&[0x42, 0x82], b"matroska")), el(&[0x18, 0x53, 0x80, 0x67], &seg)].concat()
}

#[test]
fn matroska_track_with_thousands_of_content_encodings_is_handled() {
    // a sane chain opens and reads normally
    let ok = core::open(&Mem(mkv_with_encodings(2))).unwrap();
    assert_eq!(core::info(&ok).tracks.len(), 1);
    // a hostile chain (craft-media caps it at 16 entries and treats the rest as unsupported
    // compression) is probed cleanly: no panic, no runaway work
    let t0 = std::time::Instant::now();
    let hostile = Mem(mkv_with_encodings(20_000));
    let c = core::open(&hostile).expect("a long encoding chain must not make the file unreadable");
    let i = core::info(&c);
    assert_eq!(i.container, "mkv");
    assert!(i.instant_off.is_some(), "Instant never applies to Matroska");
    if let Some(v) = i.video {
        let _ = core::samples(&c, v);
        let _ = core::read_sample(&c, &hostile, v, 0);
    }
    // the parsed chain itself is capped to one placeholder entry
    let f = craft_media::matroska::open(&hostile).unwrap();
    assert!(f.tracks.iter().all(|t| t.encodings.len() <= 16), "{:?}", f.tracks.iter().map(|t| t.encodings.len()).collect::<Vec<_>>());
    assert!(t0.elapsed().as_secs() < 5);
}

#[test]
fn instant_layout_refuses_samples_past_the_end_of_the_file() {
    // a damaged or hostile index: one frame claims 4 GB in a small file. The layout must refuse it
    // instead of allocating the claimed size.
    let f = fixture();
    let src = Mem(f.clone());
    let mut c = core::open(&src).unwrap();
    let core::Container::Mp4(m) = &mut c else { panic!() };
    m.tracks[0].samples[3].size = u32::MAX;
    let e = core::instant_layout(&c, &[0.0, 6.0], f.len() as u64).err().expect("refused");
    assert!(e.contains("past its end"), "{e}");
    // an untouched file still lays out
    let c = core::open(&src).unwrap();
    assert!(core::instant_layout(&c, &[0.0, 6.0], f.len() as u64).is_ok());
}
