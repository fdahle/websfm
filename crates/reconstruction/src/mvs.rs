// Dense reconstruction: PatchMatch multi-view-stereo depth maps (slanted-plane
// hypotheses, red-black propagation, plane-induced-homography ZNCC).
use wasm_bindgen::prelude::*;
use crate::linalg::*;
use crate::par::{for_each_index, SyncPtr};

// ── Dense reconstruction: PatchMatch multi-view stereo ──────────────────────────
// Estimate a per-pixel depth map for one reference image from N neighbouring
// source views whose relative pose to the reference is known (from the sparse
// model). Slanted-plane PatchMatch (Bleyer et al. / COLMAP-style): each pixel
// holds a depth + surface-normal hypothesis defining a 3D plane; we score the
// plane by warping the reference patch into each source via the plane-induced
// homography and taking ZNCC, then improve hypotheses by red-black spatial
// propagation + random refinement. Photometric only — cross-view geometric
// consistency is enforced later at fusion time (core/mvs.js), which needs all
// views' depth maps together.
//
// The geometric-consistency *filtering* is done in JS fusion; here we just emit
// depth + a per-pixel cost (lower = more confident) so fusion can threshold.

// Bilinear grayscale sample at (x, y) in an image plane; edge-clamped. Returns
// 0..255 as f64. Out-of-bounds-by-a-lot still clamps (callers also range-check).
pub(crate) fn sample_gray(img: &[u8], w: usize, h: usize, x: f64, y: f64) -> f64 {
    if w == 0 || h == 0 { return 0.0; }
    let xc = x.clamp(0.0, (w - 1) as f64);
    let yc = y.clamp(0.0, (h - 1) as f64);
    let x0 = xc.floor() as usize;
    let y0 = yc.floor() as usize;
    let x1 = (x0 + 1).min(w - 1);
    let y1 = (y0 + 1).min(h - 1);
    let fx = xc - x0 as f64;
    let fy = yc - y0 as f64;
    let p00 = img[y0 * w + x0] as f64;
    let p10 = img[y0 * w + x1] as f64;
    let p01 = img[y1 * w + x0] as f64;
    let p11 = img[y1 * w + x1] as f64;
    let a = p00 + (p10 - p00) * fx;
    let b = p01 + (p11 - p01) * fx;
    a + (b - a) * fy
}

// One source view: its working pixels, dimensions, intrinsics, and pose relative
// to the reference camera (x_src = R·x_ref + t, both in their camera frames).
pub(crate) struct SrcView<'a> {
    gray: &'a [u8],
    // Per-pixel exclusion mask (0/1, 1 = masked frame/fiducial), same dims as `gray`.
    // Empty slice means "no mask". A patch warping onto a masked texel is rejected.
    mask: &'a [u8],
    w: usize,
    h: usize,
    fx: f64, fy: f64, cx: f64, cy: f64,
    r: M3,
    t: V3,
}

// Sentinel: a source that provides no measurement (warp OOB / masked / <4 px /
// textureless REFERENCE patch). `agg_cost` excludes these instead of averaging a max cost 2.0 in
// (adaptive best-K over *valid* sources). Test with `>= INVALID_THRESH`.
pub(crate) const INVALID: f64 = 1e9;
const INVALID_THRESH: f64 = 1e8;
// Per-patch intensity-variance floor (0..255 scale, σ < 1e-3 grey levels). A flat
// REFERENCE patch is unmeasurable ⇒ INVALID; a textured reference warped onto a
// flat SOURCE patch (saturated snow, sky, shadow) is evidence against the
// hypothesis ⇒ max cost 2.0 — as INVALID it would drop out of best-K and let a
// wrong depth win on the one remaining source's chance correlation.
// Identical in planeCost.js and patchmatch.wgsl (VAR_FLOOR).
const VAR_FLOOR: f64 = 1e-6;

// Bilateral-weighted NCC (COLMAP's patch cost): each window sample counts with
// exp(−d²/2σs² − Δ²/2σc²), d its distance from the centre (px), Δ its grey difference
// from the centre pixel (0..255) — at a depth edge the other side of the edge, a
// different colour, barely counts, so the window does not smear the edge. COLMAP:
// σs = the window radius, σc = 0.2 of the intensity range; WebSfM's default σc is 25 grey
// levels (DENSE_TUNING.bilateralSigmaColor, measured on ETH3D). `color` ≤ 0 = off: every
// weight exactly 1.0, so every sum is the unweighted one bit for bit. Same in
// planeCost.js and patchmatch.wgsl.
// The patch a hypothesis is scored on: its half-size, the step between its samples (1 =
// every pixel; 2 = every other row and column, as COLMAP and ACMM sample a larger window
// for the cost of a smaller one; the centre row and column are kept), and the bilateral
// weights. Same in planeCost.js and patchmatch.wgsl.
#[derive(Clone, Copy)]
pub(crate) struct Patch { radius: i32, step: i32, bil: Bilateral }

impl Patch {
    pub(crate) fn new(radius: i32, step: i32, bil: Bilateral) -> Self {
        Patch { radius, step: step.max(1), bil }
    }
    // The window offsets along one axis: −r, −r + step, …, kept symmetric about 0 so
    // the centre is a sample whatever the step.
    #[inline(always)]
    fn first(&self) -> i32 { -((self.radius / self.step) * self.step) }
}

#[derive(Clone, Copy)]
pub(crate) struct Bilateral { inv2s2: f64, inv2c2: f64, on: bool }

impl Bilateral {
    pub(crate) fn new(spatial: f64, color: f64) -> Self {
        if color > 0.0 && spatial > 0.0 {
            Bilateral { inv2s2: 0.5 / (spatial * spatial), inv2c2: 0.5 / (color * color), on: true }
        } else {
            Bilateral { inv2s2: 0.0, inv2c2: 0.0, on: false }
        }
    }
    #[inline(always)]
    fn weight(&self, x: i32, y: i32, dc: f64) -> f64 {
        if !self.on { return 1.0; }
        (-((x * x + y * y) as f64) * self.inv2s2 - dc * dc * self.inv2c2).exp()
    }
}
// The worker and WebGPU kernel share this source-view ceiling. Keeping the robust
// best-K candidates in a stack array avoids a heap allocation + full sort for every
// PatchMatch hypothesis (many times per pixel on the CPU/WASM backend).
const MAX_SOURCES: usize = 16;

#[inline]
fn mean_best_costs(costs: impl Iterator<Item = f64>, best_k: usize) -> f64 {
    let target = best_k.max(1).min(MAX_SOURCES);
    let mut lowest = [f64::INFINITY; MAX_SOURCES];
    let mut kept = 0usize;
    for c in costs {
        if c >= INVALID_THRESH { continue; }
        if kept == target && c >= lowest[target - 1] { continue; }
        let end = kept.min(target - 1);
        let mut pos = end;
        while pos > 0 && c < lowest[pos - 1] {
            if pos < target { lowest[pos] = lowest[pos - 1]; }
            pos -= 1;
        }
        if pos < target { lowest[pos] = c; }
        if kept < target { kept += 1; }
    }
    if kept == 0 { return 2.0; }
    lowest[..kept].iter().sum::<f64>() / kept as f64
}

// ZNCC of the reference patch around (u, v) against the source patch obtained by
// mapping each reference sample through the plane (depth at (u,v), unit normal n)
// induced homography. `radius` is the half-window; step keeps it cheap. Returns a
// matching *cost* in [0, 2]: 0 = perfect correlation, 2 = anti-correlated. A
// degenerate plane or a flat source patch (bad hypothesis) scores the max cost
// 2.0; when the source provides no measurement (warp OOB / masked / <4 px /
// textureless reference patch) it returns the INVALID sentinel so `agg_cost` can exclude it rather than average it in.
// The reference agg_cost is checked against (tests); the kernel runs window_cost.
#[cfg_attr(not(test), allow(dead_code))]
#[allow(clippy::too_many_arguments)]
pub(crate) fn plane_cost(
    refimg: &[u8], rw: usize, rh: usize,
    rfx: f64, rfy: f64, rcx: f64, rcy: f64,
    src: &SrcView,
    u: usize, v: usize, depth: f64, n: &V3, patch: Patch,
) -> f64 {
    // Plane in reference camera frame: n·X = d, through the back-projected point
    // P = depth · K_r⁻¹ [u,v,1]. d = n·P.
    let pu = (u as f64 - rcx) / rfx;
    let pv = (v as f64 - rcy) / rfy;
    let p = [pu * depth, pv * depth, depth];
    let d = dot3(n, &p);
    if d.abs() < 1e-9 { return 2.0; }

    // H = K_s (R + t·nᵀ/d) K_r⁻¹, accumulated directly per reference pixel.
    // Plane convention: n·X = d with d = n·P (below), so the induced homography is
    // R + t·nᵀ/d — NOT the Hartley–Zisserman R − t·nᵀ/d, which assumes n·X + d = 0
    // (the opposite sign of d). A previous "−" here mirrored the warp across the
    // epipolar line, so PatchMatch never bottomed out at the true depth (freckle).
    // For a reference pixel (x,y): ray = K_r⁻¹[x,y,1]; warped = K_s (R·ray + t·(n·ray)/d).
    // ZNCC needs only running sums, so the full window contributes regardless of
    // size (a previous fixed 32-sample buffer silently truncated window≥3 to a
    // top-biased patch). Values are SHIFTED by the first contributing sample
    // (ZNCC is shift-invariant) so the sums stay small — mandatory in the f32 GPU
    // kernel (raw Σx² minus n·mean² cancels on bright low-contrast patches), kept
    // here so the three kernels are the same math.
    let mut sum_r = 0.0; let mut sum_s = 0.0;
    let mut sum_rr = 0.0; let mut sum_ss = 0.0; let mut sum_rs = 0.0;
    let mut cnt = 0.0; let mut sum_w = 0.0;
    let mut k_r = 0.0; let mut k_s = 0.0;
    let rc = refimg[v * rw + u] as f64;
    let (radius, step) = (patch.radius, patch.step);
    let mut y = patch.first();
    while y <= radius {
        let mut x = patch.first();
        while x <= radius {
            let xi = u as f64 + x as f64;
            let yi = v as f64 + y as f64;
            if xi < 0.0 || yi < 0.0 || xi >= rw as f64 || yi >= rh as f64 {
                x += step; continue;
            }
            let wt = patch.bil.weight(x, y, refimg[yi as usize * rw + xi as usize] as f64 - rc);
            let ray = [(xi - rcx) / rfx, (yi - rcy) / rfy, 1.0];
            let nr = dot3(n, &ray);
            // X_src direction = R·ray − t·(n·ray)/d  (up to the plane scale).
            let xs = [
                src.r[0][0]*ray[0] + src.r[0][1]*ray[1] + src.r[0][2]*ray[2] + src.t[0]*nr/d,
                src.r[1][0]*ray[0] + src.r[1][1]*ray[1] + src.r[1][2]*ray[2] + src.t[1]*nr/d,
                src.r[2][0]*ray[0] + src.r[2][1]*ray[1] + src.r[2][2]*ray[2] + src.t[2]*nr/d,
            ];
            if xs[2].abs() < 1e-9 { x += step; continue; }
            let su = src.fx * (xs[0] / xs[2]) + src.cx;
            let sv_ = src.fy * (xs[1] / xs[2]) + src.cy;
            if su < 0.0 || sv_ < 0.0 || su >= src.w as f64 || sv_ >= src.h as f64 {
                return INVALID; // warp left the source — no measurement from this view
            }
            // Masked source texel (frame/fiducial) — reject like an out-of-bounds warp
            // so the reference can't falsely correlate against a neighbour's border.
            if !src.mask.is_empty() {
                let mi = sv_ as usize * src.w + su as usize;
                if mi < src.mask.len() && src.mask[mi] != 0 { return INVALID; }
            }
            let r0 = refimg[yi as usize * rw + xi as usize] as f64;
            let s0 = sample_gray(src.gray, src.w, src.h, su, sv_);
            if cnt == 0.0 { k_r = r0; k_s = s0; }
            let rval = r0 - k_r;
            let sval = s0 - k_s;
            sum_r += wt*rval; sum_s += wt*sval;
            sum_rr += wt*rval*rval; sum_ss += wt*sval*sval; sum_rs += wt*rval*sval;
            cnt += 1.0; sum_w += wt;
            x += step;
        }
        y += step;
    }
    if cnt < 4.0 { return INVALID; } // too little overlap — no measurement
    let mean_r = sum_r / sum_w;
    let mean_s = sum_s / sum_w;
    let var_r = sum_rr / sum_w - mean_r*mean_r;
    let var_s = sum_ss / sum_w - mean_s*mean_s;
    let cov = sum_rs / sum_w - mean_r*mean_s;
    if var_r < VAR_FLOOR { return INVALID; } // textureless REFERENCE patch — no measurement
    if var_s < VAR_FLOOR { return 2.0; }     // textured ref onto flat source — bad hypothesis
    let denom = (var_r * var_s).sqrt();
    let ncc = (cov / denom).clamp(-1.0, 1.0);
    1.0 - ncc // cost in [0, 2]
}

// Aggregate the plane cost over the best-K source views (robust to occlusion:
// a surface point is typically visible in only a subset of neighbours).
#[allow(clippy::too_many_arguments)]
pub(crate) fn agg_cost(
    refimg: &[u8], rw: usize, rh: usize,
    rfx: f64, rfy: f64, rcx: f64, rcy: f64,
    srcs: &[SrcView], best_k: usize,
    u: usize, v: usize, depth: f64, n: &V3, patch: Patch,
) -> f64 {
    if depth <= 0.0 { return 2.0; }
    // plane_cost's degenerate plane: every source scores 2.0, so the mean of the best is 2.0.
    let Some((win, m, d)) = plane_window(refimg, rw, rh, rfx, rfy, rcx, rcy, u, v, depth, n, patch) else {
        return 2.0;
    };
    // Retain only the lowest requested K costs as we visit the sources. K is at
    // most MAX_SOURCES by the public worker contract; unlike collect()+sort(), this
    // performs no allocation in the innermost PatchMatch scoring loop.
    mean_best_costs(srcs.iter().map(|src| window_cost(src, &win[..m], d)), best_k)
}

// What plane_cost computes before it reads the source — the plane, and per window
// sample the reference ray, n·ray and the reference value — is the same for every
// source, so it is computed once per hypothesis, in the same expressions, and each
// source runs plane_cost's per-sample loop on it (window_cost): the same costs, bit for
// bit (plane_cost stays as the reference the tests compare against). None for a
// degenerate plane (n ⟂ the pixel's ray).
#[allow(clippy::too_many_arguments)]
fn plane_window(
    refimg: &[u8], rw: usize, rh: usize,
    rfx: f64, rfy: f64, rcx: f64, rcy: f64,
    u: usize, v: usize, depth: f64, n: &V3, patch: Patch,
) -> Option<([WinSample; 121], usize, f64)> {
    let pu = (u as f64 - rcx) / rfx;
    let pv = (v as f64 - rcy) / rfy;
    let p = [pu * depth, pv * depth, depth];
    let d = dot3(n, &p);
    if d.abs() < 1e-9 { return None; }
    let mut win = [WinSample::default(); 121];
    let mut m = 0usize;
    let rc = refimg[v * rw + u] as f64;
    let (radius, step) = (patch.radius, patch.step);
    let mut y = patch.first();
    while y <= radius {
        let mut x = patch.first();
        while x <= radius {
            let xi = u as f64 + x as f64;
            let yi = v as f64 + y as f64;
            if !(xi < 0.0 || yi < 0.0 || xi >= rw as f64 || yi >= rh as f64) {
                let ray = [(xi - rcx) / rfx, (yi - rcy) / rfy, 1.0];
                let nr = dot3(n, &ray);
                let r0 = refimg[yi as usize * rw + xi as usize] as f64;
                win[m] = WinSample { ray, nr, r0, wt: patch.bil.weight(x, y, r0 - rc) };
                m += 1;
            }
            x += step;
        }
        y += step;
    }
    Some((win, m, d))
}

// Per-source photometric costs of one hypothesis, a source without a measurement at
// the max cost 2 (ACMH's cost matrix; patchmatch.wgsl sourceCosts).
#[allow(clippy::too_many_arguments)]
fn source_costs(
    refimg: &[u8], rw: usize, rh: usize,
    rfx: f64, rfy: f64, rcx: f64, rcy: f64,
    srcs: &[SrcView], u: usize, v: usize, depth: f64, n: &V3, patch: Patch,
) -> [f64; MAX_SOURCES] {
    let mut out = [2.0; MAX_SOURCES];
    if depth <= 0.0 { return out; }
    let Some((win, m, d)) = plane_window(refimg, rw, rh, rfx, rfy, rcx, rcy, u, v, depth, n, patch) else {
        return out;
    };
    for (k, src) in srcs.iter().take(MAX_SOURCES).enumerate() {
        let c = window_cost(src, &win[..m], d);
        out[k] = if c >= INVALID_THRESH { 2.0 } else { c };
    }
    out
}

fn weighted_cost(c: &[f64; MAX_SOURCES], w: &[f64; MAX_SOURCES], ns: usize) -> f64 {
    let (mut sw, mut sc) = (0.0, 0.0);
    for s in 0..ns { sw += w[s]; sc += w[s] * c[s]; }
    if sw > 0.0 { sc / sw } else { 2.0 }
}

// ACMH (Xu & Tao, CVPR 2019): adaptive checkerboard sampling and multi-hypothesis joint
// view selection, the paper's {τ0, τ1, α, β, n1, n2} = {0.8, 1.2, 90, 0.3, 2, 3}. Same
// steps as patchmatch.wgsl acmhSweep (see there); the random draws differ by backend.
const ACMH_TAU0: f64 = 0.8;
const ACMH_ALPHA: f64 = 90.0;
const ACMH_BAD: f64 = 1.2;
const ACMH_N1: usize = 2;
const ACMH_N2: usize = 3;
const ACMH_BETA: f64 = 0.3;

// The k-th sample offset of region r (0..3 near V up/down/left/right, 7 samples; 4..7
// far strips, 11 samples out to 23 px); every offset is on the other checkerboard colour.
fn acmh_region_size(r: usize) -> usize { if r < 4 { 7 } else { 11 } }
fn acmh_region_offset(r: usize, k: usize) -> (i64, i64) {
    let (mut ox, mut oy) = if r < 4 {
        let kk = k as i64;
        let row = (kk + 1) / 2;
        let side = if kk & 1 == 1 { 1 } else { -1 };
        (if kk == 0 { 0 } else { side * row }, -(row + 1))
    } else {
        (0, -(3 + 2 * k as i64))
    };
    match r % 4 {
        1 => { ox = -ox; oy = -oy; }
        2 => { let t = ox; ox = oy; oy = t; }
        3 => { let t = ox; ox = -oy; oy = -t; }
        _ => {}
    }
    (ox, oy)
}

// One reference window sample, as plane_cost forms it: the ray, n·ray, the value.
#[derive(Clone, Copy, Default)]
struct WinSample { ray: V3, nr: f64, r0: f64, wt: f64 }

// plane_cost's per-sample loop over a precomputed window (agg_cost), same arithmetic.
fn window_cost(src: &SrcView, win: &[WinSample], d: f64) -> f64 {
    let mut sum_r = 0.0; let mut sum_s = 0.0;
    let mut sum_rr = 0.0; let mut sum_ss = 0.0; let mut sum_rs = 0.0;
    let mut cnt = 0.0; let mut sum_w = 0.0;
    let mut k_r = 0.0; let mut k_s = 0.0;
    for w in win {
        let (ray, nr) = (&w.ray, w.nr);
        let xs = [
            src.r[0][0]*ray[0] + src.r[0][1]*ray[1] + src.r[0][2]*ray[2] + src.t[0]*nr/d,
            src.r[1][0]*ray[0] + src.r[1][1]*ray[1] + src.r[1][2]*ray[2] + src.t[1]*nr/d,
            src.r[2][0]*ray[0] + src.r[2][1]*ray[1] + src.r[2][2]*ray[2] + src.t[2]*nr/d,
        ];
        if xs[2].abs() < 1e-9 { continue; }
        let su = src.fx * (xs[0] / xs[2]) + src.cx;
        let sv_ = src.fy * (xs[1] / xs[2]) + src.cy;
        if su < 0.0 || sv_ < 0.0 || su >= src.w as f64 || sv_ >= src.h as f64 {
            return INVALID;
        }
        if !src.mask.is_empty() {
            let mi = sv_ as usize * src.w + su as usize;
            if mi < src.mask.len() && src.mask[mi] != 0 { return INVALID; }
        }
        let (r0, wt) = (w.r0, w.wt);
        let s0 = sample_gray(src.gray, src.w, src.h, su, sv_);
        if cnt == 0.0 { k_r = r0; k_s = s0; }
        let rval = r0 - k_r;
        let sval = s0 - k_s;
        sum_r += wt*rval; sum_s += wt*sval;
        sum_rr += wt*rval*rval; sum_ss += wt*sval*sval; sum_rs += wt*rval*sval;
        cnt += 1.0; sum_w += wt;
    }
    if cnt < 4.0 { return INVALID; }
    let mean_r = sum_r / sum_w;
    let mean_s = sum_s / sum_w;
    let var_r = sum_rr / sum_w - mean_r*mean_r;
    let var_s = sum_ss / sum_w - mean_s*mean_s;
    let cov = sum_rs / sum_w - mean_r*mean_s;
    if var_r < VAR_FLOOR { return INVALID; }
    if var_s < VAR_FLOOR { return 2.0; }
    let denom = (var_r * var_s).sqrt();
    let ncc = (cov / denom).clamp(-1.0, 1.0);
    1.0 - ncc
}

// Depth-proposal half-span as a fraction of the current depth at refinement scale 1
// (COLMAP: perturbation 1/2^(iter+1) ⇒ ±50 % on the first sweep). Same in patchmatch.wgsl.
const DEPTH_PERTURB_REL: f64 = 0.5;

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn compute_depth_map(
    ref_gray: &[u8], ref_w: u32, ref_h: u32, ref_k: &[f32],
    src_gray: &[u8], src_dims: &[u32], src_k: &[f32], src_rel: &[f32], src_mask: &[u8],
    seed_depth: &[f32],
    depth_min: f32, depth_max: f32,
    window: u32, iterations: u32, best_k: u32,
    seed: u32,
    perturb_start: f32,
    // Bilateral-weighted NCC (see Bilateral): σs in px, σc in grey levels; σc ≤ 0 = off.
    sigma_spatial: f32, sigma_color: f32,
    // View selection: 0 = best-K, 1 = ACMH (acmh_region_offset, ACMH_*).
    view_selection: u32,
    // Step between window samples (see Patch); 0 or 1 = every pixel.
    window_step: u32,
) -> Vec<f32> {
    let rw = ref_w as usize;
    let rh = ref_h as usize;
    let npix = rw * rh;
    if npix == 0 || ref_gray.len() < npix || ref_k.len() < 4 { return vec![]; }
    let n_src = src_dims.len() / 2;
    if n_src == 0 { return vec![]; }

    let (rfx, rfy, rcx, rcy) =
        (ref_k[0] as f64, ref_k[1] as f64, ref_k[2] as f64, ref_k[3] as f64);
    let dmin = depth_min.max(1e-4) as f64;
    let dmax = (depth_max as f64).max(dmin * 1.001);
    // Half-window, up to 11×11. The old ≤3 cap dated to a fixed 32-sample buffer
    // that no longer exists (ZNCC now accumulates running sums, so any window size
    // contributes in full); film scans / low-texture surfaces need the larger window.
    let radius = (window.max(1) as i32).min(5);

    // Unpack source views (slice the concatenated pixel buffer by dimensions).
    let mut srcs: Vec<SrcView> = Vec::with_capacity(n_src);
    let mut off = 0usize;
    for s in 0..n_src {
        let w = src_dims[s*2] as usize;
        let h = src_dims[s*2+1] as usize;
        let len = w * h;
        if off + len > src_gray.len() || src_k.len() < (s+1)*4 || src_rel.len() < (s+1)*12 {
            return vec![];
        }
        let r = [
            [src_rel[s*12] as f64, src_rel[s*12+1] as f64, src_rel[s*12+2] as f64],
            [src_rel[s*12+3] as f64, src_rel[s*12+4] as f64, src_rel[s*12+5] as f64],
            [src_rel[s*12+6] as f64, src_rel[s*12+7] as f64, src_rel[s*12+8] as f64],
        ];
        // Mask is optional: use the matching slice only when src_mask covers all
        // sources (same concatenated layout as src_gray), else treat as unmasked.
        let mask: &[u8] = if src_mask.len() >= src_gray.len() { &src_mask[off..off+len] } else { &[] };
        srcs.push(SrcView {
            gray: &src_gray[off..off+len], mask, w, h,
            fx: src_k[s*4] as f64, fy: src_k[s*4+1] as f64,
            cx: src_k[s*4+2] as f64, cy: src_k[s*4+3] as f64,
            r, t: [src_rel[s*12+9] as f64, src_rel[s*12+10] as f64, src_rel[s*12+11] as f64],
        });
        off += len;
    }

    let bk = best_k.max(1) as usize;
    let bil = Bilateral::new(sigma_spatial as f64, sigma_color as f64);
    let patch = Patch::new(radius, window_step.max(1) as i32, bil);
    let acmh = view_selection == 1;
    // ACMH: each pixel's most important view of the previous sweep (u32::MAX = none).
    let mut sel_view = if acmh { vec![u32::MAX; npix] } else { Vec::new() };
    let ns = n_src.min(MAX_SOURCES);
    // One random stream per pixel and sweep half, seeded from (seed, pixel, sweep, colour),
    // as patchmatch.wgsl seeds its own: a pixel's draws do not depend on which thread
    // ran it or in what order, so the threaded build gives the same map.
    let pixel_rng = |i: usize, it: u32, parity: u32| {
        let mut h = (seed as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (i as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
        h ^= ((it as u64) << 32 | parity as u64).wrapping_mul(0x1656_67B1_9E37_79F9);
        h ^= h >> 29; h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9); h ^= h >> 32;
        Xorshift((h as u32) | 1)
    };
    // Random f64 in [0,1).
    let randf = |r: &mut Xorshift| (r.next() as f64) / (u32::MAX as f64 + 1.0);

    // Per-pixel state.
    let mut depth = vec![0.0f64; npix];
    let mut nx = vec![0.0f64; npix];
    let mut ny = vec![0.0f64; npix];
    let mut nz = vec![1.0f64; npix];
    let mut cost = vec![2.0f64; npix];
    // The sweeps write a pixel only from its own task and read the other checkerboard
    // colour, which no task of the same half-sweep writes: shared through raw pointers.
    let (pd, pnx, pny, pnz, pc) =
        (SyncPtr::of(&mut depth), SyncPtr::of(&mut nx), SyncPtr::of(&mut ny), SyncPtr::of(&mut nz), SyncPtr::of(&mut cost));
    let psel = SyncPtr::of(&mut sel_view);
    // SAFETY (rd / wr): in bounds; see above for who writes what when.
    #[inline(always)] fn rd<T: Copy>(p: SyncPtr<T>, i: usize) -> T { unsafe { *p.0.add(i) } }
    #[inline(always)] fn wr<T>(p: SyncPtr<T>, i: usize, v: T) { unsafe { *p.at(i) = v } }

    // A reasonable random unit normal facing the camera (nz < 0 in camera frame
    // means facing the camera; we keep nz negative so planes face the viewer).
    let rand_normal = |r: &mut Xorshift| -> V3 {
        let a = randf(r) * std::f64::consts::PI - std::f64::consts::FRAC_PI_2; // ±90°
        let b = randf(r) * std::f64::consts::PI - std::f64::consts::FRAC_PI_2;
        let n = normalize3(&[a.sin() * 0.5, b.sin() * 0.5, -1.0]);
        n
    };

    // Init: seeded depth where the sparse cloud projected, else random in range.
    let have_seed = seed_depth.len() >= npix;
    for_each_index(rh, |v| for u in 0..rw {
        let i = v * rw + u;
        let mut rng = pixel_rng(i, 0, 2);
        let seeded = if have_seed { seed_depth[i] as f64 } else { 0.0 };
        let d0 = if seeded > 0.0 { seeded.clamp(dmin, dmax) }
                 else { dmin + randf(&mut rng) * (dmax - dmin) };
        let n0 = rand_normal(&mut rng);
        wr(pd, i, d0); wr(pnx, i, n0[0]); wr(pny, i, n0[1]); wr(pnz, i, n0[2]);
        wr(pc, i, agg_cost(ref_gray, rw, rh, rfx, rfy, rcx, rcy, &srcs, bk, u, v, d0, &n0, patch));
    });

    // Red-black checkerboard PatchMatch sweeps.
    // Refinement scale s = perturb_start · 0.5^it. Depth proposals span
    // ±DEPTH_PERTURB_REL·s·min(depth, range): the pixel's OWN depth (COLMAP's
    // PerturbDepth) on a deep scene, where a range-sized step is useless to a near pixel
    // (it clamps or lands far off) and left near surfaces unrefined; the range on a
    // shallow one, where ±50 % of depth would be coarser than the search interval itself. perturb_start continues the decay
    // across pyramid levels (core/dense/refineSchedule.js) instead of restarting each
    // seeded level at full scale. ≤ 0 / NaN ⇒ 1 (an unseeded, single-level start).
    // Kept in lockstep with patchmatch.wgsl.
    let s0 = if perturb_start > 0.0 { perturb_start as f64 } else { 1.0 };
    let iters = iterations.max(1);
    for it in 0..iters {
        let shrink = s0 * 0.5f64.powi(it as i32); // refinement magnitude decays
        for parity in 0..2u32 {
            for_each_index(rh, |v| {
                for u in 0..rw {
                    if ((u + v) as u32 & 1) != parity { continue; }
                    let i = v * rw + u;
                    let mut rng = pixel_rng(i, it + 1, parity);
                    if acmh {
                        // 1. Hypotheses: the own plane, then the cheapest sample of each
                        // region, transferred onto this pixel's ray.
                        let mut hd = [0.0f64; 9];
                        let mut hn = [[0.0f64; 3]; 9];
                        hd[0] = rd(pd, i);
                        hn[0] = [rd(pnx, i), rd(pny, i), rd(pnz, i)];
                        let mut nh = 1usize;
                        let rx_i = (u as f64 - rcx) / rfx;
                        let ry_i = (v as f64 - rcy) / rfy;
                        for r in 0..8 {
                            let mut best = f64::INFINITY;
                            let mut bj = usize::MAX;
                            for k in 0..acmh_region_size(r) {
                                let (ox, oy) = acmh_region_offset(r, k);
                                let (nu, nv) = (u as i64 + ox, v as i64 + oy);
                                if nu < 0 || nv < 0 || nu >= rw as i64 || nv >= rh as i64 { continue; }
                                let j = nv as usize * rw + nu as usize;
                                let cj = rd(pc, j);
                                if cj < best { best = cj; bj = j; }
                            }
                            if bj == usize::MAX { continue; }
                            let cand_n = [rd(pnx, bj), rd(pny, bj), rd(pnz, bj)];
                            let (ju, jv) = ((bj % rw) as f64, (bj / rw) as f64);
                            let d_plane = rd(pd, bj) * (cand_n[0] * (ju - rcx) / rfx + cand_n[1] * (jv - rcy) / rfy + cand_n[2]);
                            let denom = cand_n[0] * rx_i + cand_n[1] * ry_i + cand_n[2];
                            if denom.abs() < 1e-9 { continue; }
                            let cand_d = d_plane / denom;
                            if cand_d <= dmin || cand_d >= dmax { continue; }
                            hd[nh] = cand_d;
                            hn[nh] = cand_n;
                            nh += 1;
                        }
                        // 2. The cost matrix and the view weights (paper eqs. 2–5).
                        let mut cm = [[2.0f64; MAX_SOURCES]; 9];
                        for h in 0..nh {
                            cm[h] = source_costs(ref_gray, rw, rh, rfx, rfy, rcx, rcy, &srcs, u, v, hd[h], &hn[h], patch);
                        }
                        let t = it as f64;
                        let tau = ACMH_TAU0 * (-t * t / ACMH_ALPHA).exp();
                        let prev = rd(psel, i);
                        let mut w = [0.0f64; MAX_SOURCES];
                        let mut any_sel = false;
                        for s in 0..ns {
                            let (mut good, mut bad, mut sum_imp) = (0usize, 0usize, 0.0f64);
                            for row in cm.iter().take(nh).skip(1) {
                                let c = row[s];
                                if c < tau { good += 1; sum_imp += (-c * c / (2.0 * ACMH_BETA * ACMH_BETA)).exp(); }
                                if c > ACMH_BAD { bad += 1; }
                            }
                            let is_prev = if s as u32 == prev { 1.0 } else { 0.0 };
                            if good > ACMH_N1 && bad < ACMH_N2 {
                                w[s] = (is_prev + 1.0) * sum_imp / good as f64;
                                any_sel = true;
                            } else {
                                w[s] = 0.2 * is_prev;
                            }
                        }
                        if !any_sel {
                            // No view passes the vote (early sweeps, weak texture): weigh each
                            // by its best match among the hypotheses, the remembered view still
                            // doubled, rather than score the pixel on that one view alone.
                            for s in 0..ns {
                                let m = cm.iter().take(nh).map(|row| row[s]).fold(2.0f64, f64::min);
                                let is_prev = if s as u32 == prev { 1.0 } else { 0.0 };
                                w[s] = (is_prev + 1.0) * (-m * m / (2.0 * ACMH_BETA * ACMH_BETA)).exp();
                            }
                        }
                        let mut top = u32::MAX;
                        let mut top_w = 0.0;
                        for s in 0..ns { if w[s] > top_w { top_w = w[s]; top = s as u32; } }
                        wr(psel, i, top);
                        // 3. The cheapest hypothesis under those weights (eq. 6).
                        let mut best_h = 0;
                        let mut best_c = weighted_cost(&cm[0], &w, ns);
                        for h in 1..nh {
                            let c = weighted_cost(&cm[h], &w, ns);
                            if c < best_c { best_c = c; best_h = h; }
                        }
                        let (mut best_d, mut best_n) = (hd[best_h], hn[best_h]);
                        // 4. Refinement (§4.4): random and perturbed depth and normal,
                        // the 6 combinations with the current ones.
                        let dspan = best_d.min(dmax - dmin) * DEPTH_PERTURB_REL * shrink;
                        let d_rand = dmin + randf(&mut rng) * (dmax - dmin);
                        let n_rand = rand_normal(&mut rng);
                        let d_pert = (best_d + (randf(&mut rng) * 2.0 - 1.0) * dspan).clamp(dmin, dmax);
                        let n_pert = normalize3(&[
                            best_n[0] + (randf(&mut rng) * 2.0 - 1.0) * 0.5 * shrink,
                            best_n[1] + (randf(&mut rng) * 2.0 - 1.0) * 0.5 * shrink,
                            (best_n[2] - randf(&mut rng) * 0.3 * shrink).min(-0.1),
                        ]);
                        let (d0, n0) = (best_d, best_n);
                        for (dk, nk) in [(d_rand, n0), (d0, n_rand), (d_rand, n_rand), (d_pert, n0), (d0, n_pert), (d_pert, n_pert)] {
                            let c = weighted_cost(
                                &source_costs(ref_gray, rw, rh, rfx, rfy, rcx, rcy, &srcs, u, v, dk, &nk, patch), &w, ns);
                            if c < best_c { best_c = c; best_d = dk; best_n = nk; }
                        }
                        wr(pd, i, best_d); wr(pnx, i, best_n[0]); wr(pny, i, best_n[1]); wr(pnz, i, best_n[2]);
                        wr(pc, i, best_c);
                        continue;
                    }
                    let mut best_d = rd(pd, i);
                    let mut best_n = [rd(pnx, i), rd(pny, i), rd(pnz, i)];
                    let mut best_c = rd(pc, i);

                    // 1. Spatial propagation from the 4-neighbours' PLANES. The
                    // neighbour holds a plane (its depth + normal); the correct
                    // hypothesis at THIS pixel is where this pixel's viewing ray
                    // pierces that plane — NOT the neighbour's raw depth (which only
                    // holds on a fronto-parallel surface). Copying the raw depth means
                    // the true depth can never propagate across any slanted surface, so
                    // pixels converge to per-pixel noise (the depth-map "freckles").
                    //   ray_i = ((u−cx)/fx, (v−cy)/fy, 1);  plane_j: n·X = n·P_j,
                    //   P_j = depth[j]·ray_j;  cand_d = (n·P_j)/(n·ray_i).
                    let rx_i = (u as f64 - rcx) / rfx;
                    let ry_i = (v as f64 - rcy) / rfy;
                    let neigh = [
                        (u.wrapping_sub(1), v), (u + 1, v),
                        (u, v.wrapping_sub(1)), (u, v + 1),
                    ];
                    // The planes tried so far for this pixel (its own first), as bits: a
                    // plane already scored scores the same again, and a strict `<` keeps
                    // the first, so it is not scored twice (converged regions hand one
                    // plane around).
                    let key = |d: f64, n: &V3| [d.to_bits(), n[0].to_bits(), n[1].to_bits(), n[2].to_bits()];
                    let mut tried = [[0u64; 4]; 5];
                    tried[0] = key(best_d, &best_n);
                    let mut n_tried = 1;
                    for (nu, nv) in neigh {
                        if nu >= rw || nv >= rh { continue; }
                        let j = nv * rw + nu;
                        let cand_n = [rd(pnx, j), rd(pny, j), rd(pnz, j)];
                        let rx_j = (nu as f64 - rcx) / rfx;
                        let ry_j = (nv as f64 - rcy) / rfy;
                        let d_plane = rd(pd, j) * (cand_n[0] * rx_j + cand_n[1] * ry_j + cand_n[2]);
                        let denom = cand_n[0] * rx_i + cand_n[1] * ry_i + cand_n[2];
                        if denom.abs() < 1e-9 { continue; }
                        let cand_d = d_plane / denom;
                        if cand_d <= dmin || cand_d >= dmax { continue; } // ≤0 / out of range
                        let k = key(cand_d, &cand_n);
                        if tried[..n_tried].contains(&k) { continue; }
                        tried[n_tried] = k;
                        n_tried += 1;
                        let c = agg_cost(ref_gray, rw, rh, rfx, rfy, rcx, rcy, &srcs, bk, u, v, cand_d, &cand_n, patch);
                        if c < best_c { best_c = c; best_d = cand_d; best_n = cand_n; }
                    }

                    // 2. Refinement. A single joint depth+normal perturbation couples
                    // the two and converges slowly, so also try the two decoupled
                    // hypotheses COLMAP uses: (a) keep depth, draw a fresh random
                    // normal; (b) keep normal, perturb depth only.
                    let dspan = best_d.min(dmax - dmin) * DEPTH_PERTURB_REL * shrink;
                    // (a) current depth + random new normal.
                    let rand_n = rand_normal(&mut rng);
                    let c = agg_cost(ref_gray, rw, rh, rfx, rfy, rcx, rcy, &srcs, bk, u, v, best_d, &rand_n, patch);
                    if c < best_c { best_c = c; best_n = rand_n; }
                    // (b) current normal + perturbed depth.
                    let pert_d_only = (best_d + (randf(&mut rng) * 2.0 - 1.0) * dspan).clamp(dmin, dmax);
                    let c = agg_cost(ref_gray, rw, rh, rfx, rfy, rcx, rcy, &srcs, bk, u, v, pert_d_only, &best_n, patch);
                    if c < best_c { best_c = c; best_d = pert_d_only; }
                    // (c) joint perturbation (kept — helps escape coupled local minima).
                    let pert_d = (best_d + (randf(&mut rng) * 2.0 - 1.0) * dspan).clamp(dmin, dmax);
                    let pert_n = normalize3(&[
                        best_n[0] + (randf(&mut rng) * 2.0 - 1.0) * 0.5 * shrink,
                        best_n[1] + (randf(&mut rng) * 2.0 - 1.0) * 0.5 * shrink,
                        (best_n[2] - randf(&mut rng) * 0.3 * shrink).min(-0.1),
                    ]);
                    let c = agg_cost(ref_gray, rw, rh, rfx, rfy, rcx, rcy, &srcs, bk, u, v, pert_d, &pert_n, patch);
                    if c < best_c { best_c = c; best_d = pert_d; best_n = pert_n; }

                    wr(pd, i, best_d); wr(pnx, i, best_n[0]); wr(pny, i, best_n[1]); wr(pnz, i, best_n[2]);
                    wr(pc, i, best_c);
                }
            });
        }
    }

    // ACMH searched on view-weighted costs; what it hands on is the best-K photometric cost
    // of the plane it found, as the best-K kernel would report it (patchmatch.wgsl mode 2).
    if acmh {
        for i in 0..npix {
            let n = [nx[i], ny[i], nz[i]];
            cost[i] = agg_cost(ref_gray, rw, rh, rfx, rfy, rcx, rcy, &srcs, bk, i % rw, i / rw, depth[i], &n, patch);
        }
    }

    // Emit depth plane, cost plane, then interleaved converged plane normals
    // (nx ny nz per pixel, camera-frame, unit length, nz<0 = facing the camera).
    // Downstream (fusion → Poisson) reuses these instead of re-estimating normals.
    let mut out = vec![0.0f32; npix * 5];
    for i in 0..npix {
        out[i] = depth[i] as f32;
        out[npix + i] = cost[i] as f32;
        out[npix * 2 + i * 3] = nx[i] as f32;
        out[npix * 2 + i * 3 + 1] = ny[i] as f32;
        out[npix * 2 + i * 3 + 2] = nz[i] as f32;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEPTH_DIGEST: u64 = 0x4b86_7c84_e1da_957f;
    const DEPTH_DIGEST_ACMH: u64 = 0x29d9_e732_9d02_906f;

    #[test]
    fn mean_best_costs_keeps_only_lowest_valid_k_without_allocation() {
        let costs = [0.8, INVALID, 0.2, 0.5, 0.1, 0.9];
        assert!((mean_best_costs(costs.into_iter(), 3) - (0.1 + 0.2 + 0.5) / 3.0).abs() < 1e-12);
        assert!((mean_best_costs([0.4, INVALID].into_iter(), 3) - 0.4).abs() < 1e-12);
        assert_eq!(mean_best_costs([INVALID].into_iter(), 3), 2.0);
    }

    // Mirrors planeCost.test.js: identity pose, frontal plane ⇒ every reference
    // pixel warps onto itself, so the source patch is exactly the given image.
    fn cost_against(refimg: &[u8], srcimg: &[u8]) -> f64 {
        let (w, h) = (16usize, 16usize);
        let src = SrcView {
            gray: srcimg, mask: &[], w, h,
            fx: 20.0, fy: 20.0, cx: 8.0, cy: 8.0,
            r: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            t: [0.0, 0.0, 0.0],
        };
        plane_cost(refimg, w, h, 20.0, 20.0, 8.0, 8.0, &src, 8, 8, 5.0, &[0.0, 0.0, -1.0], Patch::new(2, 1, Bilateral::new(0.0, 0.0)))
    }

    fn ramp() -> Vec<u8> {
        (0..256).map(|i| (((i % 16) * 7 + (i / 16) * 13) % 256) as u8).collect()
    }

    // agg_cost precomputes the window once per hypothesis; it must give exactly what
    // scoring each source with plane_cost gives, out-of-bounds warps, masks, flat
    // patches and degenerate planes included.
    #[test]
    fn agg_cost_is_plane_cost_per_source_bit_for_bit() {
        let mut st = 0x9E3779B9u32;
        let mut rnd = move || { st ^= st << 13; st ^= st >> 17; st ^= st << 5; st as f64 / u32::MAX as f64 };
        let (w, h) = (40usize, 30usize);
        let imgs: Vec<Vec<u8>> = (0..4).map(|k| (0..w * h).map(|i| {
            let (x, y) = ((i % w) as f64, (i / w) as f64);
            (128.0 + 100.0 * (x * 0.37 + k as f64).sin() * (y * 0.23).cos()) as u8
        }).collect()).collect();
        let flat = vec![200u8; w * h];
        let mask: Vec<u8> = (0..w * h).map(|i| (i % w < 3) as u8).collect();
        let rot = |a: f64| [[a.cos(), 0.0, a.sin()], [0.0, 1.0, 0.0], [-a.sin(), 0.0, a.cos()]];
        let srcs = vec![
            SrcView { gray: &imgs[1], mask: &[], w, h, fx: 30.0, fy: 31.0, cx: 20.0, cy: 15.0, r: rot(0.05), t: [0.3, 0.0, 0.02] },
            SrcView { gray: &imgs[2], mask: &mask, w, h, fx: 29.0, fy: 29.0, cx: 19.5, cy: 15.5, r: rot(-0.08), t: [-0.4, 0.1, 0.0] },
            SrcView { gray: &flat, mask: &[], w, h, fx: 30.0, fy: 30.0, cx: 20.0, cy: 15.0, r: rot(0.0), t: [0.1, 0.0, 0.0] },
            SrcView { gray: &imgs[3], mask: &[], w, h, fx: 30.0, fy: 30.0, cx: 20.0, cy: 15.0, r: rot(0.3), t: [2.0, 0.0, 0.5] },
        ];
        let refimg = &imgs[0];
        let mut n_valid = 0;
        for _ in 0..4000 {
            let (u, v) = ((rnd() * w as f64) as usize, (rnd() * h as f64) as usize);
            let depth = 0.5 + rnd() * 8.0;
            let nrm = normalize3(&[rnd() - 0.5, rnd() - 0.5, -0.2 - rnd()]);
            let radius = 1 + (rnd() * 4.99) as i32;
            // Plain and bilateral-weighted NCC (Bilateral), every pixel and every other one.
            for patch in [
                Patch::new(radius, 1, Bilateral::new(0.0, 0.0)),
                Patch::new(radius, 1, Bilateral::new(radius as f64, 51.0)),
                Patch::new(radius, 2, Bilateral::new(radius as f64, 51.0)),
            ] {
            for bk in [1usize, 2, 3] {
                let got = agg_cost(refimg, w, h, 30.0, 30.0, 20.0, 15.0, &srcs, bk, u, v, depth, &nrm, patch);
                let want = mean_best_costs(srcs.iter().map(|s|
                    plane_cost(refimg, w, h, 30.0, 30.0, 20.0, 15.0, s, u, v, depth, &nrm, patch)), bk);
                assert_eq!(got.to_bits(), want.to_bits(), "u {u} v {v} depth {depth} n {nrm:?} r {radius} k {bk}");
                if got < 2.0 { n_valid += 1; }
            }
            }
        }
        assert!(n_valid > 1000, "the scene must exercise real correlations ({n_valid})");
        // The degenerate plane (n ⟂ the pixel's ray).
        let nrm = normalize3(&[1.0, 0.0, 0.0]);
        let (u, v) = (20usize, 15usize); // on the axis: the ray is (0, 0, 1)
        assert_eq!(agg_cost(refimg, w, h, 30.0, 30.0, 20.0, 15.0, &srcs, 2, u, v, 3.0, &nrm, Patch::new(2, 1, Bilateral::new(0.0, 0.0))), 2.0);
    }

    // A whole depth map on a textured plane seen by three views, pinned (best-K and ACMH).
    // The same bits in the single-threaded and the threaded build (`cargo test --features
    // threads`): every pixel draws from its own random stream, seeded by pixel and sweep,
    // and reads only the other checkerboard colour. Re-pinned 2026-10-26 when the stream
    // became per pixel; before that, a skip of already-scored planes left it unchanged.
    #[test]
    fn depth_map_bits_are_pinned() {
        let (w, h) = (48usize, 36usize);
        let tex = |x: f64, y: f64| (128.0 + 90.0 * (x * 0.31).sin() * (y * 0.27).cos() + 30.0 * (x * 0.9 + y * 0.4).sin()) as u8;
        let refg: Vec<u8> = (0..w * h).map(|i| tex((i % w) as f64, (i / w) as f64)).collect();
        let (f, cx, cy) = (40.0f32, 24.0f32, 18.0f32);
        let mut src = Vec::new();
        let mut dims = Vec::new();
        let mut ks = Vec::new();
        let mut rel = Vec::new();
        for (k, tx) in [0.25f32, -0.3, 0.45].iter().enumerate() {
            // A fronto-parallel plane at depth 4: the source sees the texture shifted.
            let shift = (f * tx / 4.0) as f64;
            src.extend((0..w * h).map(|i| tex((i % w) as f64 + shift, (i / w) as f64 + 0.1 * k as f64)));
            dims.extend([w as u32, h as u32]);
            ks.extend([f, f, cx, cy]);
            rel.extend([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, *tx, 0.0, 0.0]);
        }
        let digest_of = |vs: u32| {
            let out = compute_depth_map(&refg, w as u32, h as u32, &[f, f, cx, cy], &src, &dims, &ks, &rel, &[], &[], 2.0, 8.0, 2, 3, 2, 7, 1.0, 0.0, 0.0, vs, 1);
            assert_eq!(out.len(), w * h * 5);
            out.iter().fold(0u64, |a, v| a.wrapping_mul(1_000_003).wrapping_add(v.to_bits() as u64))
        };
        let (bk, acmh) = (digest_of(0), digest_of(1));
        assert_eq!(bk, DEPTH_DIGEST, "depth map bits changed: {bk:#x}");
        assert_eq!(acmh, DEPTH_DIGEST_ACMH, "ACMH depth map bits changed: {acmh:#x}");
    }

    // Bilateral off is every weight 1.0 exactly; on, a sample of another colour than the
    // centre, or far from it, counts less.
    #[test]
    fn bilateral_weights() {
        let off = Bilateral::new(0.0, 0.0);
        assert_eq!(off.weight(3, -2, 80.0), 1.0);
        let on = Bilateral::new(5.0, 51.0);
        assert_eq!(on.weight(0, 0, 0.0), 1.0);
        assert!((on.weight(5, 0, 0.0) - (-0.5f64).exp()).abs() < 1e-12);
        assert!((on.weight(0, 0, 51.0) - (-0.5f64).exp()).abs() < 1e-12);
        assert!(on.weight(1, 1, 120.0) < 0.1);
    }

    // The 8 ACMH regions: 4 V-shapes of 7 near samples, 4 strips of 11 out to 23 px, every
    // sample on the other checkerboard colour, each region pointing its own way.
    #[test]
    fn acmh_regions_sample_the_other_colour() {
        let mut seen = std::collections::HashSet::new();
        for r in 0..8 {
            assert_eq!(acmh_region_size(r), if r < 4 { 7 } else { 11 });
            for k in 0..acmh_region_size(r) {
                let (ox, oy) = acmh_region_offset(r, k);
                assert_eq!((ox + oy).rem_euclid(2), 1, "region {r} sample {k} ({ox},{oy}) is the same colour");
                assert!(ox.abs().max(oy.abs()) <= 23);
                assert!(seen.insert((ox, oy)), "({ox},{oy}) sampled twice");
            }
        }
        assert_eq!(acmh_region_offset(0, 0), (0, -1));
        assert_eq!(acmh_region_offset(1, 0), (0, 1));
        assert_eq!(acmh_region_offset(2, 0), (-1, 0));
        assert_eq!(acmh_region_offset(3, 0), (1, 0));
        assert_eq!(acmh_region_offset(4, 10), (0, -23));
    }

    // ACMH on a textured fronto-parallel plane: it converges onto the plane faster and
    // further than best-K, and reports the best-K photometric cost of what it found.
    #[test]
    fn acmh_converges_on_a_textured_plane() {
        let (w, h) = (48usize, 36usize);
        // Smoothed value noise: textured like a photo, not periodic (a sum of sines lets a
        // wrong depth match single views as well as the true one).
        let hash = |x: i64, y: i64| { let mut h = (x * 374761393 + y * 668265263) as u64; h = (h ^ (h >> 13)).wrapping_mul(1274126177); ((h >> 16) & 255) as f64 };
        let tex = |x: f64, y: f64| {
            let (x0, y0) = (x.floor(), y.floor());
            let (fx, fy) = (x - x0, y - y0);
            let (xi, yi) = (x0 as i64, y0 as i64);
            let a = hash(xi, yi) * (1.0 - fx) + hash(xi + 1, yi) * fx;
            let b = hash(xi, yi + 1) * (1.0 - fx) + hash(xi + 1, yi + 1) * fx;
            (a * (1.0 - fy) + b * fy) as u8
        };
        let refg: Vec<u8> = (0..w * h).map(|i| tex((i % w) as f64, (i / w) as f64)).collect();
        let (f, cx, cy) = (40.0f32, 24.0f32, 18.0f32);
        let (mut src, mut dims, mut ks, mut rel) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        // A fronto-parallel plane at depth 4 seen by sources translated by tx: a point at
        // reference pixel u lands on source pixel u + f·tx/4, so the source shows
        // tex(x − f·tx/4).
        for tx in [0.25f32, -0.3, 0.45] {
            let shift = (f * tx / 4.0) as f64;
            src.extend((0..w * h).map(|i| tex((i % w) as f64 - shift, (i / w) as f64)));
            dims.extend([w as u32, h as u32]);
            ks.extend([f, f, cx, cy]);
            rel.extend([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, tx, 0.0, 0.0]);
        }
        let run_it = |vs: u32, it: u32| compute_depth_map(&refg, w as u32, h as u32, &[f, f, cx, cy], &src, &dims, &ks, &rel, &[], &[],
            2.0, 8.0, 2, it, 2, 7, 1.0, 0.0, 0.0, vs, 1);
        let run = |vs: u32| run_it(vs, 5);
        let npix = w * h;
        let within = |o: &[f32]| (8..h - 8).flat_map(|v| (8..w - 8).map(move |u| v * w + u))
            .filter(|&i| (o[i] - 4.0).abs() < 0.04).count() as f64 / ((w - 16) * (h - 16)) as f64;
        let (bk, ac) = (run(0), run(1));
        // Measured: within 1 % after 2 / 5 / 12 sweeps, best-K 0.51 / 0.71 / 0.78, ACMH
        // 0.71 / 0.78 / 0.91 — the 8 regions spread a good plane faster.
        assert!(within(&ac) > 0.75, "ACMH within 1 %: {}", within(&ac));
        assert!(within(&ac) > within(&bk), "ACMH {} vs best-K {}", within(&ac), within(&bk));
        assert!(within(&run_it(1, 2)) > within(&run_it(0, 2)) + 0.1);
        // The reported cost is the best-K photometric cost of the final plane.
        let i = 18 * w + 24;
        let n = [ac[2 * npix + 3 * i] as f64, ac[2 * npix + 3 * i + 1] as f64, ac[2 * npix + 3 * i + 2] as f64];
        let srcs: Vec<SrcView> = (0..3).map(|k| SrcView {
            gray: &src[k * npix..(k + 1) * npix], mask: &[], w, h,
            fx: f as f64, fy: f as f64, cx: cx as f64, cy: cy as f64,
            r: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            t: [rel[12 * k + 9] as f64, 0.0, 0.0],
        }).collect();
        let want = agg_cost(&refg, w, h, f as f64, f as f64, cx as f64, cy as f64, &srcs, 2, 24, 18, ac[i] as f64, &n, Patch::new(2, 1, Bilateral::new(0.0, 0.0)));
        assert!((ac[npix + i] as f64 - want).abs() < 1e-6);
    }

    #[test]
    fn flat_source_is_max_cost_not_invalid() {
        let textured = ramp();
        let flat = vec![255u8; 256]; // saturated snow
        assert_eq!(cost_against(&textured, &flat), 2.0);
    }

    #[test]
    fn flat_reference_is_invalid() {
        let textured = ramp();
        let flat = vec![255u8; 256];
        assert_eq!(cost_against(&flat, &textured), INVALID);
        assert_eq!(cost_against(&flat, &flat), INVALID);
    }

    #[test]
    fn wrong_hypothesis_on_flat_sources_loses_best_k() {
        // Wrong depth: two sources land on flat areas (now 2.0), one chance 0.25.
        // True depth: three honest-but-noisy matches. Previously the flat sources
        // were INVALID and the wrong hypothesis scored 0.25 < 0.35.
        let wrong = mean_best_costs([2.0, 2.0, 0.25].into_iter(), 3);
        let truth = mean_best_costs([0.30, 0.35, 0.40].into_iter(), 3);
        assert!(truth < wrong);
        let wrong_old = mean_best_costs([INVALID, INVALID, 0.25].into_iter(), 3);
        assert!(wrong_old < truth); // documents the old failure
    }

    #[test]
    fn shifted_sums_match_unshifted_textured_cost() {
        // Bright, low-contrast patch: shifted and naive f64 formulations agree.
        let refimg: Vec<u8> = (0..256).map(|i| 238 + ((i * 7 + i / 16) % 4) as u8).collect();
        let srcimg: Vec<u8> = (0..256).map(|i| 238 + ((i * 5 + i / 16) % 4) as u8).collect();
        let c = cost_against(&refimg, &srcimg);
        // Naive reference over the same 5×5 window.
        let (mut sr, mut ss, mut srr, mut sss, mut srs) = (0.0f64, 0.0, 0.0, 0.0, 0.0);
        for y in 6..=10 { for x in 6..=10 {
            let a = refimg[y * 16 + x] as f64; let b = srcimg[y * 16 + x] as f64;
            sr += a; ss += b; srr += a * a; sss += b * b; srs += a * b;
        } }
        let n = 25.0;
        let (mr, ms) = (sr / n, ss / n);
        let naive = 1.0 - ((srs / n - mr * ms) / ((srr / n - mr * mr) * (sss / n - ms * ms)).sqrt()).clamp(-1.0, 1.0);
        assert!((c - naive).abs() < 1e-9, "{c} vs {naive}");
    }
}
