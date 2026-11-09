//! QuickCut `.qcut` tile codec PRED+ANS (codec 5), built to `web/app/shared/qcut-codec.wasm`.
//! The bitstream is specified in `web/QCUT_FORMAT.md`; `web/app/shared/qcut-codec.js` holds the
//! same codec in JavaScript (the fallback where WebAssembly is off, and the reference in tests).
//!
//! Everything read from a file is untrusted. The decoder is safe Rust: every index is
//! bounds-checked, every length read from the data is checked before use, the work is fixed by
//! the tile size (no loops driven by the data), and a stream must end exactly where it says.
//! Bad data returns an error code; a bug at worst traps, which the caller reports as damage.

const BITS: u32 = 12;
const M: u32 = 1 << BITS;
const L: u32 = 1 << 16; // rANS state in [L, 2^32): one 16-bit renormalisation at most per symbol
const NTOK: usize = 24;
const K: usize = 12;
const F_ALPHA: u8 = 1;
const F_SG: u8 = 2;

const GQ: [u8; 2048] = {
    let b = [1, 2, 3, 5, 7, 10, 15, 22, 32, 48, 80];
    let mut q = [0u8; 2048];
    let (mut i, mut k) = (0, 0);
    while i < 2048 {
        while k < b.len() && i >= b[k] {
            k += 1;
        }
        q[i] = k as u8;
        i += 1;
    }
    q
};
const TOK: [u8; 256] = {
    let mut t = [0u8; 256];
    let mut u = 0u32;
    while u < 256 {
        t[u as usize] = if u < 16 { u as u8 } else { let n = 31 - u.leading_zeros(); (16 + ((n - 4) << 1) + ((u >> (n - 1)) & 1)) as u8 };
        u += 1;
    }
    t
};
const NBX: [u8; 256] = {
    let mut t = [0u8; 256];
    let mut u = 16u32;
    while u < 256 {
        t[u as usize] = (30 - u.leading_zeros()) as u8;
        u += 1;
    }
    t
};
const TBASE: [u32; 32] = {
    let mut t = [0u32; 32];
    let mut k = 0;
    while k < NTOK {
        t[k] = if k < 16 { k as u32 } else { let n = 4 + ((k as u32 - 16) >> 1); (2 | ((k as u32 - 16) & 1)) << (n - 1) };
        k += 1;
    }
    t
};
const TNB: [u32; 32] = {
    let mut t = [0u32; 32];
    let mut k = 16;
    while k < NTOK {
        t[k] = 3 + ((k as u32 - 16) >> 1);
        k += 1;
    }
    t
};

#[derive(Debug, PartialEq)]
pub enum Err {
    Header = -1,
    Table = -2,
    Short = -3,
    Data = -4,
    Length = -5,
}

/// MED prediction and gradient context of sample `i` at (`x`, `y`).
#[inline(always)]
fn pred_ctx(pl: &[i16], i: usize, x: usize, y: usize, w: usize) -> (i32, usize) {
    if y == 0 {
        (if x > 0 { pl[i - 1] as i32 } else { 0 }, 0)
    } else if x == 0 {
        (pl[i - w] as i32, 0)
    } else {
        let a = pl[i - 1] as i32;
        let b = pl[i - w] as i32;
        let c = pl[i - w - 1] as i32;
        let d = if x + 1 < w { pl[i - w + 1] as i32 } else { b };
        let p = (a + b - c).clamp(a.min(b), a.max(b)); // MED = median(a, b, a + b − c), branch-free
        let g = ((a - c).abs() + (b - c).abs() + (d - b).abs()).min(2047);
        (p, GQ[g as usize] as usize)
    }
}

// ── encoder ──────────────────────────────────────────────────────────────────
struct BitW {
    b: Vec<u8>,
    acc: u64,
    n: u32,
}
impl BitW {
    #[inline(always)]
    fn put(&mut self, v: u32, n: u32) {
        self.acc |= (v as u64) << self.n;
        self.n += n;
        while self.n >= 8 {
            self.b.push(self.acc as u8);
            self.acc >>= 8;
            self.n -= 8;
        }
    }
    fn end(mut self) -> Vec<u8> {
        if self.n > 0 {
            self.b.push(self.acc as u8);
        }
        self.b
    }
}

/// Counts → frequencies summing to M (every seen token keeps at least 1). Returns tokens used.
fn norm(hist: &[u32], f: &mut [u32]) -> usize {
    let tot: u64 = hist.iter().map(|&c| c as u64).sum();
    let used = hist.iter().rposition(|&c| c != 0).map_or(0, |p| p + 1);
    if tot == 0 {
        return 0;
    }
    let (mut sum, mut big) = (0i64, 0usize);
    for t in 0..used {
        let c = hist[t] as u64;
        let v = if c == 0 { 0 } else { (((c * M as u64) as f64 / tot as f64).round() as u32).max(1) };
        f[t] = v;
        sum += v as i64;
        if v > f[big] {
            big = t;
        }
    }
    let mut d = M as i64 - sum;
    if d > 0 || f[big] as i64 + d >= 1 {
        f[big] = (f[big] as i64 + d) as u32;
    } else {
        while d < 0 {
            for t in 0..used {
                if d < 0 && f[t] > 1 {
                    f[t] -= 1;
                    d += 1;
                }
            }
        }
    }
    used
}

/// Encode a tile: `px` is w×h×ch bytes (RGBA or one channel). Same output as the JS encoder.
pub fn encode(px: &[u8], w: usize, h: usize, ch: usize) -> Vec<u8> {
    let n = w * h;
    let mut flags = 0u8;
    let mut planes: Vec<Vec<i16>> = Vec::new();
    if ch == 1 {
        planes.push(px[..n].iter().map(|&v| v as i16).collect());
    } else {
        let alpha = px[..n * 4].chunks_exact(4).any(|p| p[3] != 255);
        let (mut g, mut r, mut b) = (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
        for p in px[..n * 4].chunks_exact(4) {
            let gg = p[1] as i16;
            g.push(gg);
            r.push(p[0] as i16 - gg);
            b.push(p[2] as i16 - gg);
        }
        planes.push(g);
        planes.push(r);
        planes.push(b);
        flags |= F_SG;
        if alpha {
            planes.push(px[..n * 4].chunks_exact(4).map(|p| p[3] as i16).collect());
            flags |= F_ALPHA;
        }
    }
    let mut out = Vec::with_capacity(n * planes.len() / 2 + 4096);
    out.push(flags);
    out.push(0);
    let mut sym = vec![0u16; n];
    let mut ans = vec![0u8; n * 2 + 16];
    for pl in &planes {
        let mut hist = [0u32; K * 32];
        let mut bw = BitW { b: Vec::with_capacity(n / 2), acc: 0, n: 0 };
        let mut i = 0;
        for y in 0..h {
            for x in 0..w {
                let (p, k) = pred_ctx(pl, i, x, y, w);
                let e = ((pl[i] as i32 - p) << 24) >> 24;
                let u = if e >= 0 { (e << 1) as usize } else { (-(e << 1) - 1) as usize };
                let t = TOK[u];
                if t >= 16 {
                    let nb = NBX[u] as u32;
                    bw.put(u as u32 & ((1 << nb) - 1), nb);
                }
                let s = (k << 5) | t as usize;
                sym[i] = s as u16;
                hist[s] += 1;
                i += 1;
            }
        }
        let extra = bw.end();
        let mut f = [0u32; K * 32];
        let mut c = [0u32; K * 32];
        for k in 0..K {
            let used = norm(&hist[k * 32..k * 32 + NTOK], &mut f[k * 32..k * 32 + NTOK]);
            out.push(used as u8);
            let mut cum = 0;
            for t in 0..used {
                let v = f[k * 32 + t];
                c[k * 32 + t] = cum;
                cum += v;
                if v < 128 {
                    out.push(v as u8);
                } else {
                    out.push(128 | (v & 127) as u8);
                    out.push((v >> 7) as u8);
                }
            }
        }
        // rANS, backwards
        let mut o = ans.len();
        let mut x = L;
        for i in (0..n).rev() {
            let s = sym[i] as usize;
            let (fs, cs) = (f[s], c[s]);
            let xmax = (((L >> BITS) as u64) << 16) * fs as u64;
            if x as u64 >= xmax {
                o -= 2;
                ans[o..o + 2].copy_from_slice(&(x as u16).to_le_bytes());
                x >>= 16;
            }
            x = ((x / fs) << BITS) + (x % fs) + cs;
        }
        o -= 4;
        ans[o..o + 4].copy_from_slice(&x.to_le_bytes());
        out.extend_from_slice(&(extra.len() as u32).to_le_bytes());
        out.extend_from_slice(&((ans.len() - o) as u32).to_le_bytes());
        out.extend_from_slice(&extra);
        out.extend_from_slice(&ans[o..]);
    }
    out
}

// ── decoder ──────────────────────────────────────────────────────────────────
struct Dec {
    f: [u32; K * 32],
    c: [u32; K * 32],
    dt: Vec<u8>,
    x: u32,
    ip: usize,
    iend: usize,
    pad: Vec<u8>,
    used: usize,
    xl: usize,
}

#[inline(always)]
fn rd32(s: &[u8], p: usize) -> Result<u32, Err> {
    s.get(p..p + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])).ok_or(Err::Short)
}

fn parse(src: &[u8], p: &mut usize) -> Result<Dec, Err> {
    let mut d = Dec { f: [0; K * 32], c: [0; K * 32], dt: vec![31u8; K << BITS], x: 0, ip: 0, iend: 0, pad: Vec::new(), used: 0, xl: 0 };
    let next = |p: &mut usize| -> Result<u32, Err> {
        let v = *src.get(*p).ok_or(Err::Short)?;
        *p += 1;
        Ok(v as u32)
    };
    for k in 0..K {
        let used = next(p)? as usize;
        if used > NTOK {
            return Err(Err::Table);
        }
        let mut cum = 0u32;
        for t in 0..used {
            let mut v = next(p)?;
            if v & 128 != 0 {
                v = (v & 127) | (next(p)? << 7);
            }
            if v > M - cum {
                return Err(Err::Table);
            }
            d.f[k * 32 + t] = v;
            d.c[k * 32 + t] = cum;
            let base = (k << BITS) + cum as usize;
            d.dt[base..base + v as usize].fill(t as u8);
            cum += v;
        }
        if used > 0 && cum != M {
            return Err(Err::Table);
        }
    }
    let xl = rd32(src, *p)? as usize;
    let al = rd32(src, *p + 4)? as usize;
    *p += 8;
    if xl > src.len() || al > src.len() || *p + xl + al > src.len() || al < 4 {
        return Err(Err::Short);
    }
    let bend = *p + xl;
    d.pad = Vec::with_capacity(xl + 8);
    d.pad.extend_from_slice(&src[*p..bend]);
    d.pad.extend_from_slice(&[0; 8]);
    d.xl = xl;
    d.ip = bend + 4;
    d.iend = bend + al;
    d.x = rd32(src, bend)?;
    if d.x < L || al & 1 != 0 {
        return Err(Err::Data);
    }
    *p = d.iend;
    Ok(d)
}

fn run<const P: usize>(src: &[u8], ds: &mut [Dec], buf: &mut [i16], w: usize, h: usize, sg: bool) -> Result<(), Err> {
    let n = w * h;
    let ds: &mut [Dec; P] = ds.try_into().map_err(|_| Err::Header)?;
    let mut bad = 0u32;
    for q in 0..P {
        let (g0, pl) = buf.split_at_mut(q * n);
        let pl = &mut pl[..n];
        let gp = &g0[..if q > 0 { n } else { 0 }];
        let d = &mut ds[q];
        let sgq = sg && (q == 1 || q == 2);
        // the coder state lives in locals for the whole plane (no stores per sample)
        let (dt, fq, cq, pad) = (&d.dt[..], &d.f, &d.c, &d.pad[..]);
        let (mut xs, mut ip, mut bp, mut acc, mut nacc, mut used) = (d.x, d.ip, 0usize, 0u64, 0u32, 0usize);
        let (iend, padmax) = (d.iend, pad.len() - 8);
        // decode one sample with prediction `p` and context `k`; yields the plane value
        macro_rules! sample {
            ($p:expr, $k:expr, $i:expr) => {{
                let (p, k): (i32, usize) = ($p, $k);
                let slot = xs & (M - 1);
                let t = dt[(k << BITS) | slot as usize] as usize;
                let s = (k << 5) | t;
                let f = fq[s];
                bad |= (f == 0) as u32;
                xs = (f * (xs >> BITS)).wrapping_add(slot).wrapping_sub(cq[s]);
                let ipc = ip.min(iend - 2);
                let wv = u16::from_le_bytes(src[ipc..ipc + 2].try_into().unwrap()) as u32;
                let need = (xs < L) as u32;
                xs = (xs << (need << 4)) | (wv & need.wrapping_neg());
                ip += (need as usize) << 1;
                let nb = TNB[t];
                let bq = bp.min(padmax);
                let v8 = u64::from_le_bytes(pad[bq..bq + 8].try_into().unwrap());
                acc |= v8 << nacc;
                bp += ((63 - nacc) >> 3) as usize;
                nacc |= 56;
                used += nb as usize;
                let u = (TBASE[t] | (acc as u32 & ((1u32 << nb) - 1))) as i32;
                acc >>= nb;
                nacc -= nb;
                let e = (u >> 1) ^ -(u & 1); // un-zigzag, branch-free
                let mut v = (p + e) & 255;
                if sgq {
                    let g = gp[$i] as i32;
                    v = ((g + v) & 255) - g;
                }
                v
            }};
        }
        // first row: W predicts, context 0
        let mut a = 0i32;
        for x in 0..w {
            a = sample!(a, 0, x);
            pl[x] = a as i16;
        }
        for y in 1..h {
            let (done, rest) = pl.split_at_mut(y * w);
            let prev = &done[(y - 1) * w..];
            let cur = &mut rest[..w];
            let gr = if sgq { &gp[y * w..(y + 1) * w] } else { &gp[..0] };
            let _ = gr;
            let mut a = sample!(prev[0] as i32, 0, y * w);
            cur[0] = a as i16;
            // interior and last column (NE = N there)
            for x in 1..w {
                let b = prev[x] as i32;
                let c = prev[x - 1] as i32;
                let dd = if x + 1 < w { prev[x + 1] as i32 } else { b };
                let p = (a + b - c).clamp(a.min(b), a.max(b));
                let g = ((a - c).abs() + (b - c).abs() + (dd - b).abs()).min(2047);
                a = sample!(p, GQ[g as usize] as usize, y * w + x);
                cur[x] = a as i16;
            }
        }
        d.x = xs;
        d.ip = ip;
        d.used = used;
    }
    if bad != 0 {
        return Err(Err::Data);
    }
    Ok(())
}

/// Decode a tile into `dst` (w×h×ch bytes).
pub fn decode(src: &[u8], w: usize, h: usize, ch: usize, dst: &mut [u8]) -> Result<(), Err> {
    let n = w * h;
    if src.len() < 2 || dst.len() != n * ch || n == 0 {
        return Err(Err::Header);
    }
    let flags = src[0];
    if src[1] != 0 || flags & !(F_ALPHA | F_SG) != 0 || if ch == 1 { flags != 0 } else { flags & F_SG == 0 } {
        return Err(Err::Header);
    }
    let np = if ch == 1 { 1 } else if flags & F_ALPHA != 0 { 4 } else { 3 };
    let mut p = 2;
    let mut ds = Vec::with_capacity(np);
    for _ in 0..np {
        ds.push(parse(src, &mut p)?);
    }
    if p != src.len() {
        return Err(Err::Length);
    }
    let mut buf = vec![0i16; n * np];
    match np {
        1 => run::<1>(src, &mut ds, &mut buf, w, h, false)?,
        3 => run::<3>(src, &mut ds, &mut buf, w, h, true)?,
        _ => run::<4>(src, &mut ds, &mut buf, w, h, true)?,
    }
    for d in &ds {
        if d.x != L || d.ip != d.iend || d.used.div_ceil(8) != d.xl {
            return Err(Err::Length);
        }
    }
    if ch == 1 {
        for (o, &v) in dst.iter_mut().zip(&buf[..n]) {
            *o = v as u8;
        }
    } else {
        let (g, r) = buf.split_at(n);
        let (r, b) = r.split_at(n);
        let (b, a) = b.split_at(n);
        for (i, o) in dst.chunks_exact_mut(4).enumerate() {
            let gg = g[i];
            o[0] = (r[i] + gg) as u8;
            o[1] = gg as u8;
            o[2] = (b[i] + gg) as u8;
            o[3] = if np == 4 { a[i] as u8 } else { 255 };
        }
    }
    Ok(())
}

// ── wasm interface (raw memory; the JS side owns every length it passes) ────
#[cfg(target_arch = "wasm32")]
mod ffi {
    use super::*;
    #[unsafe(no_mangle)]
    pub extern "C" fn qc_alloc(n: usize) -> *mut u8 {
        let mut v = Vec::<u8>::with_capacity(n.max(1));
        let p = v.as_mut_ptr();
        core::mem::forget(v);
        p
    }
    /// # Safety: `p`, `n` from `qc_alloc`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn qc_free(p: *mut u8, n: usize) {
        drop(unsafe { Vec::from_raw_parts(p, 0, n.max(1)) });
    }
    /// Encode; returns a buffer from `qc_alloc` laid out as [u32 length][bytes] (free with length + 4).
    /// # Safety: `px` holds w×h×ch bytes.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn qc_encode(px: *const u8, w: usize, h: usize, ch: usize) -> *mut u8 {
        let src = unsafe { core::slice::from_raw_parts(px, w * h * ch) };
        let enc = encode(src, w, h, ch);
        let p = qc_alloc(enc.len() + 4);
        let out = unsafe { core::slice::from_raw_parts_mut(p, enc.len() + 4) };
        out[..4].copy_from_slice(&(enc.len() as u32).to_le_bytes());
        out[4..].copy_from_slice(&enc);
        p
    }
    /// Decode; 0 = ok, < 0 = damaged data. # Safety: `src` holds `len` bytes, `dst` w×h×ch.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn qc_decode(src: *const u8, len: usize, w: usize, h: usize, ch: usize, dst: *mut u8) -> i32 {
        let s = unsafe { core::slice::from_raw_parts(src, len) };
        let d = unsafe { core::slice::from_raw_parts_mut(dst, w * h * ch) };
        match decode(s, w, h, ch, d) {
            Ok(()) => 0,
            Err(e) => e as i32,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rng(s: &mut u32) -> u32 {
        *s = s.wrapping_mul(1103515245).wrapping_add(12345);
        *s >> 16
    }
    #[test]
    fn round_trip_and_fuzz() {
        let mut s = 1u32;
        for &(w, h, ch) in &[(1, 1, 4), (7, 3, 4), (64, 64, 4), (33, 17, 1), (512, 9, 4)] {
            let mut px = vec![0u8; w * h * ch];
            for (i, v) in px.iter_mut().enumerate() {
                *v = if i % 3 == 0 { (rng(&mut s) & 255) as u8 } else { (i / 7) as u8 };
            }
            let e = encode(&px, w, h, ch);
            let mut d = vec![0u8; px.len()];
            decode(&e, w, h, ch, &mut d).unwrap();
            assert_eq!(d, px);
            for k in 0..2000 {
                let mut x = e.clone();
                match k % 3 {
                    0 => { let at = rng(&mut s) as usize % x.len(); x[at] ^= 1 << (rng(&mut s) & 7); }
                    1 => { x.truncate(rng(&mut s) as usize % x.len()); }
                    _ => { for v in x.iter_mut().skip(2) { *v = rng(&mut s) as u8; } }
                }
                let _ = decode(&x, w, h, ch, &mut d); // must return, never panic
            }
        }
    }
}
#[cfg(test)]
mod speed {
    #[test]
    #[ignore]
    fn speed() {
        let (w, h) = (512, 512);
        let mut px = vec![0u8; w * h * 4];
        let mut s = 7u32;
        for y in 0..h { for x in 0..w { let i = (y * w + x) * 4; s = s.wrapping_mul(1103515245).wrapping_add(12345); let n = ((s >> 16) % 7) as i32 - 3;
            let base = ((x as f32 * 0.05).sin() * 60.0 + (y as f32 * 0.03).cos() * 50.0 + 128.0) as i32;
            px[i] = (base + n).clamp(0, 255) as u8; px[i + 1] = (base / 2 + 40 + n).clamp(0, 255) as u8; px[i + 2] = (255 - base + n).clamp(0, 255) as u8; px[i + 3] = 255; } }
        let t = std::time::Instant::now();
        let e = super::encode(&px, w, h, 4);
        let te = t.elapsed();
        let mut d = vec![0u8; px.len()];
        let t = std::time::Instant::now();
        for _ in 0..10 { super::decode(&e, w, h, 4, &mut d).unwrap(); }
        println!("size {} enc {:?} dec {:?}", e.len(), te, t.elapsed() / 10);
        assert_eq!(d, px);
    }
}
