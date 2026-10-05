use wasm_bindgen::prelude::*;

const N_HIST: usize = 4;   // 4×4 spatial grid
const N_ORI:  usize = 8;   // 8 orientation bins per cell
const DESC_LEN: usize = N_HIST * N_HIST * N_ORI; // 128

/// Output stride per keypoint: x, y, scale, response, angle, desc[128]
const STRIDE: usize = 5 + DESC_LEN; // 133

/// Near-duplicate suppression radius (input pixels). A strong blob fires as a DoG
/// extremum at several adjacent scale levels and again in the next octave; mapped
/// back through the octave scale factor those land several keypoints within a pixel
/// of each other. Keep only the strongest at each visual location.
const DEDUP_RADIUS_PX: f32 = 2.0;

/// A secondary orientation-histogram peak becomes its own keypoint when it reaches
/// this fraction of the dominant peak (Lowe 2004 §5; VLFeat and COLMAP use 0.8).
const ORI_PEAK_RATIO: f32 = 0.8;
/// Hard ceiling on orientations per extremum (the smoothed histogram rarely has more).
const MAX_ORIENTATIONS: usize = 4;

/// Detect SIFT keypoints and compute 128-d descriptors.
///
/// `max_orientations` (1..=4; 0 is treated as 1): every scale-space extremum yields
/// its dominant orientation plus up to `max_orientations - 1` further histogram peaks
/// within ORI_PEAK_RATIO of it, each as a separate keypoint with its own descriptor at
/// the SAME x, y, scale and response ("siblings"). 1 reproduces the single-orientation
/// detector exactly. Siblings count toward `max_keypoints` and the counts below, as in
/// COLMAP (`max_num_orientations`, default 2).
///
/// Returns a flat `Float32Array` with `STRIDE` (133) values per keypoint:
/// `[x, y, scale, response, angle, d0..d127, ...]`
/// where `x`/`y` are in input-image pixel coordinates, followed by TWO trailing
/// values: `raw_found` = keypoints surviving near-duplicate suppression but *before*
/// the `max_keypoints` cap (so callers can report how many were dropped to the cap),
/// then `suppressed` = keypoints dropped as near-duplicate positions (multiple
/// scale/octave DoG extrema collapsing onto one visual location). A degenerate input
/// (zero-size / short buffer) returns an empty vec; a valid image with no extrema
/// returns `[0.0, 0.0]`. Parse as `kept = floor((len - 2) / STRIDE)`,
/// `raw = flat[len-2]`, `suppressed = flat[len-1]`.
#[wasm_bindgen]
pub fn detect_sift(
    rgba: &[u8],
    width: usize,
    height: usize,
    contrast_threshold: f32,
    max_keypoints: usize,
    max_orientations: usize,
) -> Vec<f32> {
    if width == 0 || height == 0 || rgba.len() < width * height * 4 {
        return Vec::new();
    }

    let gray = to_gray(rgba, width, height);
    let max_orientations = max_orientations.clamp(1, MAX_ORIENTATIONS);
    let kps = sift_keypoints(&gray, width, height, contrast_threshold, max_orientations);
    let detected = kps.len(); // total extrema, before dedup and before the cap

    // Response-desc first so near-duplicate suppression keeps the strongest at each
    // location, then feeds the max_keypoints cap the best survivors.
    let mut kps = kps;
    kps.sort_by(|a, b| b.response.partial_cmp(&a.response).unwrap_or(std::cmp::Ordering::Equal));
    let mut kps = suppress_duplicate_positions(kps, DEDUP_RADIUS_PX);
    let suppressed = detected - kps.len();
    let raw_found = kps.len(); // post-dedup, before the max_keypoints cap
    if max_keypoints > 0 && kps.len() > max_keypoints {
        kps.truncate(max_keypoints);
    }

    let mut out = Vec::with_capacity(kps.len() * STRIDE + 1);
    for k in kps {
        out.push(k.x);
        out.push(k.y);
        out.push(k.scale);
        out.push(k.response);
        out.push(k.angle);
        out.extend_from_slice(&k.desc);
    }
    out.push(raw_found as f32); // trailing sentinels: post-dedup count …
    out.push(suppressed as f32); // … then near-duplicates suppressed
    out
}

/// Drop near-duplicate keypoints: for a response-desc–sorted list, keep a keypoint
/// only when no already-kept (stronger) one lies within `radius` px. A spatial hash
/// (cell = `radius`) keeps this ~O(n): a candidate only compares against kept points
/// in its own and adjacent cells. See `DEDUP_RADIUS_PX` for why duplicates arise.
///
/// Orientation siblings (same extremum => bit-identical x, y, scale) are NOT
/// duplicates of each other: a sibling is kept iff no NON-sibling within `radius` was
/// kept, so the siblings of a suppressed extremum go with it. The stable response
/// sort keeps the dominant orientation ahead of its siblings (equal response).
fn suppress_duplicate_positions(kps: Vec<Kp>, radius: f32) -> Vec<Kp> {
    if kps.is_empty() {
        return kps;
    }
    let r2 = radius * radius;
    let cell = radius.max(1.0);
    let mut grid: std::collections::HashMap<(i32, i32), Vec<usize>> =
        std::collections::HashMap::new();
    let mut kept: Vec<Kp> = Vec::with_capacity(kps.len());
    for kp in kps {
        let cx = (kp.x / cell).floor() as i32;
        let cy = (kp.y / cell).floor() as i32;
        let mut dup = false;
        'search: for gx in cx - 1..=cx + 1 {
            for gy in cy - 1..=cy + 1 {
                if let Some(idxs) = grid.get(&(gx, gy)) {
                    for &i in idxs {
                        if is_sibling(&kept[i], &kp) { continue; }
                        let dx = kept[i].x - kp.x;
                        let dy = kept[i].y - kp.y;
                        if dx * dx + dy * dy <= r2 {
                            dup = true;
                            break 'search;
                        }
                    }
                }
            }
        }
        if dup {
            continue;
        }
        let idx = kept.len();
        grid.entry((cx, cy)).or_default().push(idx);
        kept.push(kp);
    }
    kept
}

/// Same extremum, different orientation: x, y and scale are copied verbatim from one
/// refined extremum, so exact float equality is the identity test.
fn is_sibling(a: &Kp, b: &Kp) -> bool {
    a.x == b.x && a.y == b.y && a.scale == b.scale
}

struct Kp {
    x:        f32,
    y:        f32,
    scale:    f32,
    response: f32,
    angle:    f32,
    desc:     [f32; DESC_LEN],
}

// ── Image helpers ─────────────────────────────────────────────────────────────

fn to_gray(rgba: &[u8], w: usize, h: usize) -> Vec<f32> {
    let mut g = vec![0f32; w * h];
    for i in 0..w * h {
        let r  = rgba[i * 4]     as f32;
        let gr = rgba[i * 4 + 1] as f32;
        let b  = rgba[i * 4 + 2] as f32;
        g[i] = (0.299 * r + 0.587 * gr + 0.114 * b) / 255.0;
    }
    g
}

fn clampi(v: i32, lo: i32, hi: i32) -> i32 {
    v.max(lo).min(hi)
}

fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let radius = (3.0 * sigma).ceil().max(1.0) as i32;
    let mut k = Vec::with_capacity((2 * radius + 1) as usize);
    let mut sum = 0.0f32;
    for i in -radius..=radius {
        let v = (-(i * i) as f32 / (2.0 * sigma * sigma)).exp();
        k.push(v);
        sum += v;
    }
    for v in k.iter_mut() { *v /= sum; }
    k
}

/// `acc[i] += src[i] * kv` over all of `acc`. The vertical blur pass's hot loop:
/// `kv` is loop-invariant and both slices are contiguous, so this is a clean f32x4
/// multiply-add. (The naive `for y { for x { for ki } }` vertical loop strides by `w`
/// on its innermost index and LLVM will not vectorise it.)
#[cfg(target_feature = "simd128")]
fn fma_scaled(acc: &mut [f32], src: &[f32], kv: f32) {
    use core::arch::wasm32::*;
    let n = acc.len().min(src.len());
    let n4 = n & !3;
    unsafe {
        let kvv = f32x4_splat(kv);
        let pa = acc.as_mut_ptr();
        let ps = src.as_ptr();
        let mut i = 0;
        while i < n4 {
            let a = v128_load(pa.add(i) as *const v128);
            let s = v128_load(ps.add(i) as *const v128);
            v128_store(pa.add(i) as *mut v128, f32x4_add(a, f32x4_mul(s, kvv)));
            i += 4;
        }
    }
    for i in n4..n {
        acc[i] += src[i] * kv;
    }
}

/// Scalar fallback (native `cargo test`/`cargo check`; no simd128 feature).
#[cfg(not(target_feature = "simd128"))]
fn fma_scaled(acc: &mut [f32], src: &[f32], kv: f32) {
    let n = acc.len().min(src.len());
    for i in 0..n {
        acc[i] += src[i] * kv;
    }
}

/// One clamp-to-edge convolution tap sum at `x` — used only for the ≤`radius`
/// border columns, where the clamp makes the read index data-dependent.
fn conv_clamped(row: &[f32], w: usize, x: usize, k: &[f32], radius: usize) -> f32 {
    let mut acc = 0.0f32;
    for (ki, &kv) in k.iter().enumerate() {
        let sx = clampi(x as i32 + ki as i32 - radius as i32, 0, w as i32 - 1) as usize;
        acc += row[sx] * kv;
    }
    acc
}

/// Horizontal convolution of the interior columns `radius..w-radius`, where every
/// tap is in-bounds and the clamp drops out — so the window reads are contiguous and
/// vectorise 4 output columns at a time. Border columns are the caller's job.
#[cfg(target_feature = "simd128")]
fn conv_row_interior(row: &[f32], out: &mut [f32], k: &[f32], radius: usize) {
    use core::arch::wasm32::*;
    let w = row.len();
    if w < 2 * radius + 1 {
        return; // no interior; caller's border sweep covers the whole row
    }
    let hi = w - radius;
    let n4 = radius + ((hi - radius) & !3);
    unsafe {
        let ps = row.as_ptr();
        let po = out.as_mut_ptr();
        let mut x = radius;
        while x < n4 {
            let base = x - radius;
            let mut acc = f32x4_splat(0.0);
            for (ki, &kv) in k.iter().enumerate() {
                // Widest read is base+ki+3 ≤ (n4-4-radius)+2·radius+3 ≤ w-1.
                acc = f32x4_add(
                    acc,
                    f32x4_mul(v128_load(ps.add(base + ki) as *const v128), f32x4_splat(kv)),
                );
            }
            v128_store(po.add(x) as *mut v128, acc);
            x += 4;
        }
    }
    for x in n4..hi {
        let mut acc = 0.0f32;
        for (ki, &kv) in k.iter().enumerate() {
            acc += row[x - radius + ki] * kv;
        }
        out[x] = acc;
    }
}

/// Scalar fallback (native `cargo test`/`cargo check`; no simd128 feature).
#[cfg(not(target_feature = "simd128"))]
fn conv_row_interior(row: &[f32], out: &mut [f32], k: &[f32], radius: usize) {
    let w = row.len();
    if w < 2 * radius + 1 {
        return;
    }
    for x in radius..w - radius {
        let mut acc = 0.0f32;
        for (ki, &kv) in k.iter().enumerate() {
            acc += row[x - radius + ki] * kv;
        }
        out[x] = acc;
    }
}

/// Separable Gaussian blur with clamp-to-edge borders.
///
/// Both passes are split into clamped borders (scalar, ≤`radius` rows/columns) and an
/// unclamped interior (contiguous, vectorised). The vertical pass accumulates into a
/// single row buffer with the clamp hoisted out of the inner loop, which also keeps
/// only one source row in flight instead of `2·radius+1` rows strided across the image.
fn blur(src: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    let k = gaussian_kernel(sigma);
    let radius = k.len() / 2;

    let mut tmp = vec![0f32; w * h];
    for y in 0..h {
        let row  = &src[y * w..(y + 1) * w];
        let orow = &mut tmp[y * w..(y + 1) * w];
        let lo = radius.min(w);
        let hi = w.saturating_sub(radius).max(lo);
        for x in 0..lo  { orow[x] = conv_clamped(row, w, x, &k, radius); }
        for x in hi..w  { orow[x] = conv_clamped(row, w, x, &k, radius); }
        conv_row_interior(row, orow, &k, radius);
    }

    let mut out = vec![0f32; w * h];
    let mut accrow = vec![0f32; w];
    for y in 0..h {
        accrow.iter_mut().for_each(|v| *v = 0.0);
        for (ki, &kv) in k.iter().enumerate() {
            let sy = clampi(y as i32 + ki as i32 - radius as i32, 0, h as i32 - 1) as usize;
            fma_scaled(&mut accrow, &tmp[sy * w..(sy + 1) * w], kv);
        }
        out[y * w..(y + 1) * w].copy_from_slice(&accrow);
    }
    out
}

/// Halve resolution by taking every other pixel.
fn downsample(src: &[f32], w: usize, h: usize) -> (Vec<f32>, usize, usize) {
    let nw = w / 2;
    let nh = h / 2;
    let mut out = vec![0f32; nw * nh];
    for y in 0..nh {
        for x in 0..nw {
            out[y * nw + x] = src[(y * 2) * w + (x * 2)];
        }
    }
    (out, nw, nh)
}

// ── Orientation ───────────────────────────────────────────────────────────────

/// Orientations at (kx, ky) in `gauss`: the dominant one first, then up to
/// `max_n - 1` further peaks (see `orientation_peaks`).
fn compute_orientations(
    gauss: &[f32], w: usize, h: usize, kx: f32, ky: f32, scale: f32, max_n: usize,
) -> Vec<f32> {
    orientation_peaks(&orientation_histogram(gauss, w, h, kx, ky, scale), max_n)
}

/// 36-bin, Gaussian-weighted, 6x-smoothed gradient-orientation histogram.
fn orientation_histogram(gauss: &[f32], w: usize, h: usize, kx: f32, ky: f32, scale: f32) -> [f32; 36] {
    let radius   = (3.0 * scale).round().max(1.0) as i32;
    let sigma_sq = (1.5 * scale) * (1.5 * scale);
    let mut hist = [0.0f32; 36];

    for dy in -radius..=radius {
        let py = ky as i32 + dy;
        if py < 1 || py >= h as i32 - 1 { continue; }
        for dx in -radius..=radius {
            let px = kx as i32 + dx;
            if px < 1 || px >= w as i32 - 1 { continue; }

            let gx = gauss[py as usize * w + px as usize + 1]
                   - gauss[py as usize * w + px as usize - 1];
            let gy = gauss[(py as usize + 1) * w + px as usize]
                   - gauss[(py as usize - 1) * w + px as usize];
            let mag = (gx * gx + gy * gy).sqrt();
            let ori = gy.atan2(gx); // -π..π

            let dist_sq = (dx * dx + dy * dy) as f32;
            let weight  = (-dist_sq / (2.0 * sigma_sq)).exp();

            let bin_f = (ori + std::f32::consts::PI) / (2.0 * std::f32::consts::PI) * 36.0;
            let bin   = (bin_f as usize).min(35);
            hist[bin] += mag * weight;
        }
    }

    // Smooth histogram 6 times with a [0.25, 0.5, 0.25] kernel.
    for _ in 0..6 {
        let h0 = hist;
        for i in 0..36 {
            hist[i] = 0.25 * h0[(i + 35) % 36]
                    + 0.50 * h0[i]
                    + 0.25 * h0[(i +  1) % 36];
        }
    }

    hist
}

/// Dominant orientation (global maximum, first bin on ties: unchanged from the
/// single-orientation detector), then the other strict local maxima reaching
/// ORI_PEAK_RATIO x the dominant value, strongest first, up to `max_n` in total.
/// Each angle is sub-bin interpolated with a parabola through its neighbours.
fn orientation_peaks(hist: &[f32; 36], max_n: usize) -> Vec<f32> {
    let (peak_bin, peak_val) = hist.iter().enumerate()
        .fold((0, 0.0f32), |(bi, bv), (i, &v)| if v > bv { (i, v) } else { (bi, bv) });
    let mut out = vec![peak_angle(hist, peak_bin)];
    if max_n > 1 {
        let mut extra: Vec<(usize, f32)> = (0..36)
            .filter(|&i| {
                i != peak_bin
                    && hist[i] > hist[(i + 35) % 36]
                    && hist[i] > hist[(i + 1) % 36]
                    && hist[i] >= ORI_PEAK_RATIO * peak_val
            })
            .map(|i| (i, hist[i]))
            .collect();
        extra.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        out.extend(extra.into_iter().take(max_n - 1).map(|(i, _)| peak_angle(hist, i)));
    }
    out
}

/// Sub-bin interpolated angle (radians, -pi..pi) of histogram peak `bin`.
fn peak_angle(hist: &[f32; 36], bin: usize) -> f32 {
    let peak_val = hist[bin];
    let l = hist[(bin + 35) % 36];
    let r = hist[(bin +  1) % 36];
    let denom  = l - 2.0 * peak_val + r;
    let offset = if denom.abs() > 1e-6 { 0.5 * (l - r) / denom } else { 0.0 };

    ((bin as f32 + 0.5 + offset) / 36.0) * 2.0 * std::f32::consts::PI
        - std::f32::consts::PI
}

// ── Descriptor ────────────────────────────────────────────────────────────────

/// Compute the 128-d SIFT descriptor for a keypoint.
///
/// Samples a 4×4 grid of 4×4-pixel cells from `gauss` around (kx, ky),
/// rotated by `angle`, and builds an 8-bin gradient histogram per cell.
/// The result is L2-normalised, clamped at 0.2, and re-normalised.
fn compute_descriptor(
    gauss: &[f32],
    w: usize,
    h: usize,
    kx: f32,
    ky: f32,
    scale: f32,
    angle: f32,
) -> [f32; DESC_LEN] {
    let hist_width = 3.0 * scale;           // pixels per histogram cell
    let half       = N_HIST as f32 / 2.0;  // 2.0

    let cos_t = angle.cos();
    let sin_t = angle.sin();

    // Radius of the sampling window (rotate-safe)
    let radius   = (hist_width * (half + 0.5) * std::f32::consts::SQRT_2).ceil() as i32;
    let sigma_sq = (half * hist_width) * (half * hist_width);

    let mut hist = [0.0f32; DESC_LEN];

    for dy in -radius..=radius {
        let py = ky as i32 + dy;
        if py < 1 || py >= h as i32 - 1 { continue; }
        for dx in -radius..=radius {
            let px = kx as i32 + dx;
            if px < 1 || px >= w as i32 - 1 { continue; }

            // Rotate into the keypoint's reference frame, normalise by cell width.
            let dx_f = dx as f32;
            let dy_f = dy as f32;
            let rx = ( cos_t * dx_f + sin_t * dy_f) / hist_width;
            let ry = (-sin_t * dx_f + cos_t * dy_f) / hist_width;

            if rx < -(half + 1.0) || rx >= half + 1.0 || ry < -(half + 1.0) || ry >= half + 1.0 {
                continue;
            }

            let gx = gauss[py as usize * w + px as usize + 1]
                   - gauss[py as usize * w + px as usize - 1];
            let gy = gauss[(py as usize + 1) * w + px as usize]
                   - gauss[(py as usize - 1) * w + px as usize];
            let mag = (gx * gx + gy * gy).sqrt();

            // Gradient orientation relative to the keypoint's angle.
            let ori = (gy.atan2(gx) - angle)
                      .rem_euclid(2.0 * std::f32::consts::PI)
                      / (2.0 * std::f32::consts::PI)
                      * N_ORI as f32;

            // Gaussian weight over the whole descriptor window.
            let w_exp = (-(dx_f * dx_f + dy_f * dy_f) / (2.0 * sigma_sq)).exp();
            let contrib = mag * w_exp;

            // Trilinear interpolation into the histogram array.
            let rx0 = rx + half - 0.5;
            let ry0 = ry + half - 0.5;

            let rxi = rx0.floor() as i32;
            let ryi = ry0.floor() as i32;
            let oi  = ori.floor() as i32;

            let rxw = rx0 - rxi as f32;
            let ryw = ry0 - ryi as f32;
            let ow  = ori  - oi  as f32;

            for dr in 0..2i32 {
                let wr = if dr == 0 { 1.0 - ryw } else { ryw };
                let ri = ryi + dr;
                if ri < 0 || ri >= N_HIST as i32 { continue; }
                for dc in 0..2i32 {
                    let wc = if dc == 0 { 1.0 - rxw } else { rxw };
                    let ci = rxi + dc;
                    if ci < 0 || ci >= N_HIST as i32 { continue; }
                    for do_ in 0..2i32 {
                        let wo  = if do_ == 0 { 1.0 - ow } else { ow };
                        let obi = ((oi + do_) as usize).rem_euclid(N_ORI);
                        let idx = (ri as usize * N_HIST + ci as usize) * N_ORI + obi;
                        hist[idx] += contrib * wr * wc * wo;
                    }
                }
            }
        }
    }

    // L2-normalise → clamp → re-normalise
    let norm = hist.iter().map(|&v| v * v).sum::<f32>().sqrt().max(1e-10);
    for v in hist.iter_mut() { *v /= norm; }
    for v in hist.iter_mut() { *v = v.min(0.2); }
    let norm2 = hist.iter().map(|&v| v * v).sum::<f32>().sqrt().max(1e-10);
    for v in hist.iter_mut() { *v /= norm2; }

    hist
}

// ── Detection + description ───────────────────────────────────────────────────

/// Solve a 3×3 linear system `A · x = b` by Cramer's rule.
/// Returns `None` for a (near-)singular matrix.
fn solve3(a: [[f32; 3]; 3], b: [f32; 3]) -> Option<[f32; 3]> {
    let det3 = |m: &[[f32; 3]; 3]| {
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
      - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
      + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    };
    let det = det3(&a);
    if det.abs() < 1e-12 { return None; }
    let inv = 1.0 / det;
    let mut out = [0f32; 3];
    for c in 0..3 {
        let mut m = a;
        for r in 0..3 { m[r][c] = b[r]; }
        out[c] = det3(&m) * inv;
    }
    Some(out)
}

/// Refine a discrete DoG extremum to sub-pixel / sub-scale position via the
/// standard Lowe quadratic fit (Lowe §4). Iteratively fits a 3D quadratic to
/// the DoG around `(x0, y0, s0)` and solves `H · offset = -gradient` for the
/// peak; if the offset exceeds half a sample the search re-centres on the
/// nearest neighbour and retries. Returns the refined octave-local `(x, y)`,
/// the fractional scale-layer index, and the interpolated DoG contrast, or
/// `None` if it walks outside the valid interior or fails to converge.
fn refine_extremum(
    dog: &[Vec<f32>],
    w: usize,
    h: usize,
    x0: usize,
    y0: usize,
    s0: usize,
) -> Option<(f32, f32, f32, f32)> {
    const MAX_ITERS: usize = 5;
    let s_lo = 1i32;
    let s_hi = dog.len() as i32 - 2;

    let mut x = x0 as i32;
    let mut y = y0 as i32;
    let mut s = s0 as i32;

    for _ in 0..MAX_ITERS {
        let (xi, yi, si) = (x as usize, y as usize, s as usize);
        let at = |ss: usize, yy: usize, xx: usize| dog[ss][yy * w + xx];
        let c = at(si, yi, xi);

        // 3D gradient (central differences in x, y, scale).
        let gx = 0.5 * (at(si, yi, xi + 1) - at(si, yi, xi - 1));
        let gy = 0.5 * (at(si, yi + 1, xi) - at(si, yi - 1, xi));
        let gs = 0.5 * (at(si + 1, yi, xi) - at(si - 1, yi, xi));

        // 3D Hessian.
        let dxx = at(si, yi, xi + 1) + at(si, yi, xi - 1) - 2.0 * c;
        let dyy = at(si, yi + 1, xi) + at(si, yi - 1, xi) - 2.0 * c;
        let dss = at(si + 1, yi, xi) + at(si - 1, yi, xi) - 2.0 * c;
        let dxy = 0.25 * (at(si, yi + 1, xi + 1) - at(si, yi + 1, xi - 1)
                        - at(si, yi - 1, xi + 1) + at(si, yi - 1, xi - 1));
        let dxs = 0.25 * (at(si + 1, yi, xi + 1) - at(si + 1, yi, xi - 1)
                        - at(si - 1, yi, xi + 1) + at(si - 1, yi, xi - 1));
        let dys = 0.25 * (at(si + 1, yi + 1, xi) - at(si + 1, yi - 1, xi)
                        - at(si - 1, yi + 1, xi) + at(si - 1, yi - 1, xi));

        let offset = solve3(
            [[dxx, dxy, dxs],
             [dxy, dyy, dys],
             [dxs, dys, dss]],
            [-gx, -gy, -gs],
        )?;
        let (ox, oy, os) = (offset[0], offset[1], offset[2]);

        // Converged: peak lies within half a sample of the current point.
        if ox.abs() < 0.5 && oy.abs() < 0.5 && os.abs() < 0.5 {
            let contrast = c + 0.5 * (gx * ox + gy * oy + gs * os);
            return Some((xi as f32 + ox, yi as f32 + oy, si as f32 + os, contrast));
        }

        // Otherwise re-centre on the nearest sample and retry.
        if ox >  0.5 { x += 1; } else if ox < -0.5 { x -= 1; }
        if oy >  0.5 { y += 1; } else if oy < -0.5 { y -= 1; }
        if os >  0.5 { s += 1; } else if os < -0.5 { s -= 1; }

        if x < 1 || x >= w as i32 - 1
        || y < 1 || y >= h as i32 - 1
        || s < s_lo || s > s_hi {
            return None;
        }
    }
    None
}

fn sift_keypoints(
    gray: &[f32], width: usize, height: usize, contrast_threshold: f32, max_orientations: usize,
) -> Vec<Kp> {
    let scales_per_octave = 3usize;
    let k        = 2f32.powf(1.0 / scales_per_octave as f32);
    let sigma0   = 1.6f32;
    let num_gauss = scales_per_octave + 3; // one extra on each end for clean DoG
    let max_octaves  = 5usize;
    let edge_threshold = 10.0f32;

    let mut kps = Vec::new();
    let mut cur = gray.to_vec();
    let mut w = width;
    let mut h = height;

    for octave in 0..max_octaves {
        if w < 16 || h < 16 { break; }

        let scale_factor = (1usize << octave) as f32;

        // Gaussian scale-space for this octave, built INCREMENTALLY: level i is level
        // i-1 blurred by just the increment that takes σ_{i-1} → σ_i, rather than the
        // octave base re-blurred by the full σ_i. Gaussians compose in quadrature
        // (blur(σa)∘blur(σb) ≡ blur(√(σa²+σb²))), so the levels are the same, but the
        // increments are √(k²−1) ≈ 0.77× the absolute sigmas and the kernel radius is
        // 3σ — which cuts the octave from ~124 taps to ~82 (~71 for octaves 1+).
        //
        // The octave base already carries σ0: octave 0's is the σ0-blurred input, and
        // octaves 1+ inherit it from `gauss[scales_per_octave]` (σ = σ0·k³ = 2σ0)
        // halved by `downsample`. So level 0 IS the base — do not blur it again.
        let mut gauss: Vec<Vec<f32>> = Vec::with_capacity(num_gauss);
        gauss.push(if octave == 0 { blur(&cur, w, h, sigma0) } else { cur.clone() });
        for i in 1..num_gauss {
            let sigma_prev = sigma0 * k.powi(i as i32 - 1);
            let increment  = sigma_prev * (k * k - 1.0).sqrt();
            let prev = &gauss[i - 1];
            gauss.push(blur(prev, w, h, increment));
        }

        // Difference of Gaussians.
        let mut dog: Vec<Vec<f32>> = Vec::with_capacity(num_gauss - 1);
        for i in 0..num_gauss - 1 {
            let mut d = vec![0f32; w * h];
            for p in 0..w * h {
                d[p] = gauss[i + 1][p] - gauss[i][p];
            }
            dog.push(d);
        }

        // Scan interior DoG layers for scale-space extrema.
        for s in 1..dog.len() - 1 {
            for y in 1..h - 1 {
                for x in 1..w - 1 {
                    let v = dog[s][y * w + x];
                    if v.abs() < contrast_threshold { continue; }

                    // 26-neighbour extremum check.
                    let mut is_max = true;
                    let mut is_min = true;
                    'cmp: for ds in -1i32..=1 {
                        let layer = &dog[(s as i32 + ds) as usize];
                        for dy in -1i32..=1 {
                            for dx in -1i32..=1 {
                                if ds == 0 && dy == 0 && dx == 0 { continue; }
                                let nv = layer[((y as i32 + dy) as usize) * w
                                             + (x as i32 + dx) as usize];
                                if nv >= v { is_max = false; }
                                if nv <= v { is_min = false; }
                                if !is_max && !is_min { break 'cmp; }
                            }
                        }
                    }
                    if !(is_max || is_min) { continue; }

                    // Sub-pixel / sub-scale localization: fit a 3D quadratic to
                    // the DoG around the discrete extremum and solve for the
                    // true peak offset.
                    let (rx, ry, rs, contrast) = match refine_extremum(&dog, w, h, x, y, s) {
                        Some(r) => r,
                        None    => continue, // failed to converge inside the volume
                    };
                    // Low-contrast rejection on the *interpolated* DoG value.
                    if contrast.abs() < contrast_threshold { continue; }

                    // Edge-response rejection (2×2 spatial Hessian of the DoG).
                    let c   = dog[s][y * w + x];
                    let dxx = dog[s][y * w + x + 1] + dog[s][y * w + x - 1] - 2.0 * c;
                    let dyy = dog[s][(y + 1) * w + x] + dog[s][(y - 1) * w + x] - 2.0 * c;
                    let dxy = (dog[s][(y + 1) * w + x + 1] - dog[s][(y + 1) * w + x - 1]
                             - dog[s][(y - 1) * w + x + 1] + dog[s][(y - 1) * w + x - 1])
                             * 0.25;
                    let tr  = dxx + dyy;
                    let det = dxx * dyy - dxy * dxy;
                    if det <= 0.0 { continue; }
                    let r = edge_threshold;
                    if tr * tr / det >= (r + 1.0) * (r + 1.0) / r { continue; }

                    // Refined octave-local position and (fractional) scale.
                    let kx     = rx;
                    let ky     = ry;
                    let kscale = sigma0 * k.powf(rs);

                    // One keypoint per orientation; siblings share x/y/scale/response.
                    let angles = compute_orientations(&gauss[s], w, h, kx, ky, kscale, max_orientations);
                    for angle in angles {
                        let desc = compute_descriptor(&gauss[s], w, h, kx, ky, kscale, angle);
                        kps.push(Kp {
                            x:        kx * scale_factor,
                            y:        ky * scale_factor,
                            scale:    kscale * scale_factor,
                            response: contrast.abs(),
                            angle,
                            desc,
                        });
                    }
                }
            }
        }

        // Next octave's base is the octave's mid-point Gaussian, halved.
        let (ds, nw, nh) = downsample(&gauss[scales_per_octave], w, h);
        cur = ds;
        w   = nw;
        h   = nh;
    }

    kps
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_blobs() {
        let (w, h) = (96usize, 96usize);
        let mut rgba = vec![0u8; w * h * 4];
        for p in 0..w * h { rgba[p * 4 + 3] = 255; }

        for &(cx, cy, r) in &[(24usize, 24usize, 6usize), (64, 40, 4), (40, 70, 8)] {
            for y in cy - r..cy + r {
                for x in cx - r..cx + r {
                    let i = (y * w + x) * 4;
                    rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255;
                }
            }
        }

        let out = detect_sift(&rgba, w, h, 0.02, 1000, 2);
        // Two trailing sentinels (raw_found, suppressed) ⇒ (len - 2) is a STRIDE multiple.
        assert_eq!((out.len() - 2) % STRIDE, 0, "output must be groups of {} + 2", STRIDE);
        let kept = (out.len() - 2) / STRIDE;
        assert!(kept > 0, "expected keypoints on blobs");
        let raw = out[out.len() - 2];
        let suppressed = out[out.len() - 1];
        assert!(raw >= kept as f32, "raw-found count must be ≥ kept count");
        assert!(suppressed >= 0.0, "suppressed count must be non-negative");

        // No two kept keypoints may sit within the dedup radius of each other, except
        // orientation siblings (bit-identical x, y, scale).
        let kps: Vec<(f32, f32, f32)> = out[..out.len() - 2]
            .chunks(STRIDE)
            .map(|c| (c[0], c[1], c[2]))
            .collect();
        for i in 0..kps.len() {
            for j in i + 1..kps.len() {
                let sib = kps[i] == kps[j];
                let d = (kps[i].0 - kps[j].0).hypot(kps[i].1 - kps[j].1);
                assert!(sib || d > DEDUP_RADIUS_PX, "kept keypoints {i},{j} within dedup radius: {d}");
            }
        }

        for chunk in out[..out.len() - 2].chunks(STRIDE) {
            assert!(chunk[0] >= 0.0 && chunk[0] < w as f32, "x out of bounds");
            assert!(chunk[1] >= 0.0 && chunk[1] < h as f32, "y out of bounds");
            assert!(chunk[3] > 0.0, "response should be positive");
            // Descriptor values should be in [0, 1] after normalisation.
            for &d in &chunk[5..] {
                assert!(d >= 0.0 && d <= 1.0001, "descriptor value out of range: {}", d);
            }
        }
    }

    /// The pre-optimisation blur: naive, fully clamped, no border/interior split.
    /// Kept as the reference `blur` must reproduce.
    fn blur_naive(src: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
        let k = gaussian_kernel(sigma);
        let radius = (k.len() / 2) as i32;
        let mut tmp = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut acc = 0.0f32;
                for (ki, &kv) in k.iter().enumerate() {
                    let sx = clampi(x as i32 + ki as i32 - radius, 0, w as i32 - 1) as usize;
                    acc += src[y * w + sx] * kv;
                }
                tmp[y * w + x] = acc;
            }
        }
        let mut out = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut acc = 0.0f32;
                for (ki, &kv) in k.iter().enumerate() {
                    let sy = clampi(y as i32 + ki as i32 - radius, 0, h as i32 - 1) as usize;
                    acc += tmp[sy * w + x] * kv;
                }
                out[y * w + x] = acc;
            }
        }
        out
    }

    fn ramp_image(w: usize, h: usize) -> Vec<f32> {
        (0..w * h)
            .map(|i| {
                let (x, y) = ((i % w) as f32, (i / w) as f32);
                (x * 0.7).sin() * (y * 0.3).cos() + x * 0.01
            })
            .collect()
    }

    /// The border/interior split and the row-accumulator vertical pass must be exactly
    /// the old naive blur. Sizes deliberately straddle the SIMD tail and the
    /// `w < 2·radius+1` no-interior case.
    #[test]
    fn blur_matches_naive_reference() {
        for &(w, h) in &[(37usize, 23usize), (64, 64), (9, 40), (5, 5)] {
            let src = ramp_image(w, h);
            for &sigma in &[0.8f32, 1.6, 3.2] {
                let got  = blur(&src, w, h, sigma);
                let want = blur_naive(&src, w, h, sigma);
                for i in 0..w * h {
                    assert!(
                        (got[i] - want[i]).abs() < 1e-4,
                        "blur mismatch at {i} ({w}×{h}, σ={sigma}): {} vs {}",
                        got[i], want[i]
                    );
                }
            }
        }
    }

    /// Gaussians compose in quadrature — the identity the incremental scale-space
    /// relies on. Blurring by σ0 then the increment must equal one blur by σ0·k.
    #[test]
    fn incremental_blur_composes_in_quadrature() {
        let (w, h) = (48usize, 48usize);
        // Deliberately smooth/low-frequency: the quadrature identity is exact for a
        // true Gaussian, so any gap here is 3σ-kernel truncation. A high-frequency
        // image would measure that truncation instead of the identity under test.
        let src: Vec<f32> = (0..w * h)
            .map(|i| {
                let (x, y) = ((i % w) as f32, (i / w) as f32);
                let (dx, dy) = (x - 24.0, y - 24.0);
                (-(dx * dx + dy * dy) / (2.0 * 9.0 * 9.0)).exp()
            })
            .collect();
        let sigma0 = 1.6f32;
        let k = 2f32.powf(1.0 / 3.0);

        let increment = sigma0 * (k * k - 1.0).sqrt();
        let staged = blur(&blur(&src, w, h, sigma0), w, h, increment);
        let direct = blur(&src, w, h, sigma0 * k);

        // Interior only: clamp-to-edge borders are not quadrature-exact.
        let m = 12;
        for y in m..h - m {
            for x in m..w - m {
                let i = y * w + x;
                assert!(
                    (staged[i] - direct[i]).abs() < 2e-3,
                    "staged vs direct blur diverge at ({x},{y}): {} vs {}",
                    staged[i], direct[i]
                );
            }
        }
    }

    /// Not a correctness test — a stopwatch for the two blur optimisations.
    /// `cargo test --release -- --ignored --nocapture bench`
    #[test]
    #[ignore]
    fn bench_pyramid() {
        use std::time::Instant;

        let (w, h) = (2048usize, 2048usize);
        let src = ramp_image(w, h);
        let sigma0 = 1.6f32;
        let k = 2f32.powf(1.0 / 3.0);
        let num_gauss = 6;

        // Old: every level re-blurred from the octave base with its full absolute σ.
        let abs_sigmas: Vec<f32> = (0..num_gauss).map(|i| sigma0 * k.powi(i)).collect();
        // New: level 0 is the base; each later level adds only the increment.
        let inc_sigmas: Vec<f32> = (1..num_gauss)
            .map(|i| sigma0 * k.powi(i - 1) * (k * k - 1.0).sqrt())
            .collect();

        let taps = |ss: &[f32]| -> usize {
            ss.iter().map(|&s| gaussian_kernel(s).len()).sum()
        };
        println!("\n  taps/octave: old {} → new {} (+{} for octave 0's base σ0)",
                 taps(&abs_sigmas), taps(&inc_sigmas), gaussian_kernel(sigma0).len());

        let t = Instant::now();
        for &s in &abs_sigmas { std::hint::black_box(blur_naive(&src, w, h, s)); }
        let old_ms = t.elapsed().as_secs_f64() * 1e3;

        let t = Instant::now();
        let mut prev = blur(&src, w, h, sigma0);
        for &s in &inc_sigmas { prev = blur(&prev, w, h, s); }
        std::hint::black_box(prev);
        let new_ms = t.elapsed().as_secs_f64() * 1e3;

        // Isolate the two effects: same σ, old vs new blur = the restructure/SIMD win.
        let t = Instant::now();
        std::hint::black_box(blur_naive(&src, w, h, sigma0));
        let naive_one = t.elapsed().as_secs_f64() * 1e3;
        let t = Instant::now();
        std::hint::black_box(blur(&src, w, h, sigma0));
        let new_one = t.elapsed().as_secs_f64() * 1e3;

        println!("  one blur σ=1.6 @ {w}×{h}: naive {naive_one:.1}ms → new {new_one:.1}ms  ({:.2}×)",
                 naive_one / new_one);
        println!("  full octave  @ {w}×{h}: old {old_ms:.1}ms → new {new_ms:.1}ms  ({:.2}×)\n",
                 old_ms / new_ms);
    }

    /// Deterministic integer-only test image, byte-identical to the JS twin in
    /// `scripts/simd-parity.mjs` — the shared input for the wasm-SIMD parity check.
    /// Integer-only so both languages produce the same bytes exactly; blobs at several
    /// radii so the digest covers keypoints from every octave, not just fine texture.
    fn parity_image(w: usize, h: usize) -> Vec<u8> {
        let mut rgba = vec![0u8; w * h * 4];
        let blobs: [(usize, usize, usize); 7] = [
            (20, 18, 3), (48, 30, 5), (95, 22, 8), (130, 60, 12),
            (35, 80, 6), (75, 95, 4), (120, 100, 9),
        ];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                // Mild deterministic texture so flat regions still carry gradient.
                let mut v = 40 + ((x * 3 + y * 5 + ((x * y) % 17) * 2) % 24);
                for &(cx, cy, r) in &blobs {
                    let dx = x as i64 - cx as i64;
                    let dy = y as i64 - cy as i64;
                    if dx * dx + dy * dy < (r * r) as i64 {
                        v += 170;
                    }
                }
                let v = v.min(255) as u8;
                rgba[i] = v;
                rgba[i + 1] = ((v as usize * 3 + x) % 256) as u8;
                rgba[i + 2] = ((v as usize * 5 + y) % 256) as u8;
                rgba[i + 3] = 255;
            }
        }
        rgba
    }

    /// Prints a digest of `detect_sift` on a fixed input. The scalar-fallback half of
    /// the SIMD parity check: the wasm build must reproduce these numbers.
    /// `cargo test --release -- --ignored --nocapture parity_digest`
    #[test]
    #[ignore]
    fn parity_digest() {
        // Not a multiple of 4: exercises the f32x4 tail and the border/interior split.
        let (w, h) = (157usize, 113usize);
        let out = detect_sift(&parity_image(w, h), w, h, 0.02, 1000, 2);
        let kept = (out.len() - 2) / STRIDE;
        let sx: f64 = out[..out.len() - 2].chunks(STRIDE).map(|c| c[0] as f64).sum();
        let sy: f64 = out[..out.len() - 2].chunks(STRIDE).map(|c| c[1] as f64).sum();
        let sd: f64 = out[..out.len() - 2]
            .chunks(STRIDE)
            .map(|c| c[5..].iter().map(|&v| v as f64).sum::<f64>())
            .sum();
        println!(
            "\n  DIGEST kept={kept} raw={} sup={} sumX={sx:.4} sumY={sy:.4} sumDesc={sd:.4}\n",
            out[out.len() - 2], out[out.len() - 1]
        );
    }

    #[test]
    fn empty_on_flat_image() {
        let (w, h) = (48usize, 48usize);
        let rgba = vec![128u8; w * h * 4];
        let out = detect_sift(&rgba, w, h, 0.03, 1000, 2);
        // No extrema ⇒ just the two trailing sentinels (raw_found, suppressed), both 0.
        assert_eq!(out.len(), 2, "a flat image yields only the trailing sentinels");
        assert_eq!(out[0], 0.0, "raw-found count should be 0 on a flat image");
        assert_eq!(out[1], 0.0, "suppressed count should be 0 on a flat image");
    }

    // ── Multiple orientations per extremum (Lowe §5 / COLMAP max_num_orientations) ──

    fn hist_with(peaks: &[(usize, f32)]) -> [f32; 36] {
        let mut h = [0.1f32; 36];
        for &(b, v) in peaks { h[b] = v; }
        h
    }

    #[test]
    fn orientation_peaks_picks_dominant_then_strong_secondaries() {
        // Dominant at bin 5, a secondary at 85 % (bin 20) and a weak one at 70 % (bin 30).
        let h = hist_with(&[(5, 1.0), (20, 0.85), (30, 0.7)]);
        let one = orientation_peaks(&h, 1);
        let two = orientation_peaks(&h, 2);
        let four = orientation_peaks(&h, 4);
        assert_eq!(one.len(), 1);
        assert_eq!(two.len(), 2);
        assert_eq!(four.len(), 2, "a 70 % peak is below ORI_PEAK_RATIO");
        assert_eq!(two[0], one[0], "the dominant angle is unchanged by max_n");
        let bin_of = |a: f32| (((a + std::f32::consts::PI) / (2.0 * std::f32::consts::PI)) * 36.0) as usize;
        assert_eq!(bin_of(two[0]), 5);
        assert_eq!(bin_of(two[1]), 20);
        // Strongest secondaries first, capped at max_n.
        let h3 = hist_with(&[(2, 1.0), (12, 0.81), (24, 0.95)]);
        let p = orientation_peaks(&h3, 2);
        assert_eq!(bin_of(p[1]), 24, "the stronger secondary wins the one extra slot");
        // A flat histogram has no secondary peaks.
        assert_eq!(orientation_peaks(&[0.0f32; 36], 4).len(), 1);
    }

    #[test]
    fn single_orientation_output_is_a_subset_of_multi() {
        // max_orientations = 1 is the old detector; with 2, every one of its keypoints
        // must still be there (cap not binding), identical in every value.
        let (w, h) = (157usize, 113usize);
        let img = parity_image(w, h);
        let one = detect_sift(&img, w, h, 0.02, 0, 1);
        let two = detect_sift(&img, w, h, 0.02, 0, 2);
        let rows = |o: &Vec<f32>| -> Vec<Vec<u32>> {
            o[..o.len() - 2].chunks(STRIDE).map(|c| c.iter().map(|v| v.to_bits()).collect()).collect()
        };
        let (r1, r2) = (rows(&one), rows(&two));
        assert!(r2.len() > r1.len(), "expected some secondary orientations ({} vs {})", r2.len(), r1.len());
        let set2: std::collections::HashSet<Vec<u32>> = r2.into_iter().collect();
        for r in &r1 {
            assert!(set2.contains(r), "a single-orientation keypoint is missing from the multi output");
        }
        // 0 is treated as 1.
        assert_eq!(detect_sift(&img, w, h, 0.02, 0, 0), one);
    }

    #[test]
    fn siblings_share_position_and_differ_in_angle() {
        let (w, h) = (157usize, 113usize);
        let out = detect_sift(&parity_image(w, h), w, h, 0.02, 0, 2);
        let rows: Vec<&[f32]> = out[..out.len() - 2].chunks(STRIDE).collect();
        let mut groups: std::collections::HashMap<(u32, u32, u32), Vec<&[f32]>> = Default::default();
        for r in &rows { groups.entry((r[0].to_bits(), r[1].to_bits(), r[2].to_bits())).or_default().push(r); }
        let multi = groups.values().filter(|g| g.len() > 1).count();
        assert!(multi > 0, "the parity image should produce orientation siblings");
        for g in groups.values() {
            assert!(g.len() <= 2, "max_orientations = 2 caps each extremum at two keypoints");
            if g.len() == 2 {
                assert_eq!(g[0][3], g[1][3], "siblings share the response");
                let mut d = (g[0][4] - g[1][4]).abs();
                if d > std::f32::consts::PI { d = 2.0 * std::f32::consts::PI - d; }
                // Distinct local maxima of the 36-bin histogram are >= 2 bins apart.
                assert!(d > 1.5 * (2.0 * std::f32::consts::PI / 36.0), "sibling angles too close: {d}");
                assert_ne!(&g[0][5..], &g[1][5..], "siblings need their own descriptors");
            }
        }
    }

    #[test]
    fn duplicate_suppression_keeps_siblings_but_drops_them_with_their_extremum() {
        let kp = |x: f32, y: f32, scale: f32, response: f32, angle: f32| Kp {
            x, y, scale, response, angle, desc: [0.0; DESC_LEN],
        };
        // Response-desc order, as detect_sift feeds it: A + sibling, then B (+ sibling)
        // 1 px away from A at another scale (a second extremum of the same blob), then C far away.
        let list = vec![
            kp(10.0, 10.0, 2.0, 0.9, 0.1), kp(10.0, 10.0, 2.0, 0.9, 1.5),
            kp(11.0, 10.0, 3.0, 0.5, 0.2), kp(11.0, 10.0, 3.0, 0.5, 2.0),
            kp(40.0, 40.0, 2.0, 0.3, 0.0),
        ];
        let kept = suppress_duplicate_positions(list, DEDUP_RADIUS_PX);
        let angles: Vec<f32> = kept.iter().map(|k| k.angle).collect();
        assert_eq!(angles, vec![0.1, 1.5, 0.0]);
    }
}
