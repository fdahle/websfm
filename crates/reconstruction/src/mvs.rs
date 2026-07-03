// Dense reconstruction: PatchMatch multi-view-stereo depth maps (slanted-plane
// hypotheses, red-black propagation, plane-induced-homography ZNCC).
use wasm_bindgen::prelude::*;
use crate::linalg::*;

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
// textureless). `agg_cost` excludes these instead of averaging a max cost 2.0 in
// (adaptive best-K over *valid* sources). Test with `>= INVALID_THRESH`.
pub(crate) const INVALID: f64 = 1e9;
const INVALID_THRESH: f64 = 1e8;

// ZNCC of the reference patch around (u, v) against the source patch obtained by
// mapping each reference sample through the plane (depth at (u,v), unit normal n)
// induced homography. `radius` is the half-window; step keeps it cheap. Returns a
// matching *cost* in [0, 2]: 0 = perfect correlation, 2 = anti-correlated. A
// degenerate plane (bad hypothesis) scores the max cost 2.0; when the source
// provides no measurement (warp OOB / masked / <4 px / textureless) it returns
// the INVALID sentinel so `agg_cost` can exclude it rather than average it in.
#[allow(clippy::too_many_arguments)]
pub(crate) fn plane_cost(
    refimg: &[u8], rw: usize, rh: usize,
    rfx: f64, rfy: f64, rcx: f64, rcy: f64,
    src: &SrcView,
    u: usize, v: usize, depth: f64, n: &V3, radius: i32,
) -> f64 {
    // Plane in reference camera frame: n·X = d, through the back-projected point
    // P = depth · K_r⁻¹ [u,v,1]. d = n·P.
    let pu = (u as f64 - rcx) / rfx;
    let pv = (v as f64 - rcy) / rfy;
    let p = [pu * depth, pv * depth, depth];
    let d = dot3(n, &p);
    if d.abs() < 1e-9 { return 2.0; }

    // H = K_s (R − t·nᵀ/d) K_r⁻¹, accumulated directly per reference pixel.
    // For a reference pixel (x,y): ray = K_r⁻¹[x,y,1]; warped = K_s (R·ray − t·(n·ray)/d).
    // ZNCC needs only running sums, so the full window contributes regardless of
    // size (a previous fixed 32-sample buffer silently truncated window≥3 to a
    // top-biased patch).
    let mut sum_r = 0.0; let mut sum_s = 0.0;
    let mut sum_rr = 0.0; let mut sum_ss = 0.0; let mut sum_rs = 0.0;
    let mut cnt = 0.0;
    let mut y = -radius;
    while y <= radius {
        let mut x = -radius;
        while x <= radius {
            let xi = u as f64 + x as f64;
            let yi = v as f64 + y as f64;
            if xi < 0.0 || yi < 0.0 || xi >= rw as f64 || yi >= rh as f64 {
                x += 1; continue;
            }
            let ray = [(xi - rcx) / rfx, (yi - rcy) / rfy, 1.0];
            let nr = dot3(n, &ray);
            // X_src direction = R·ray − t·(n·ray)/d  (up to the plane scale).
            let xs = [
                src.r[0][0]*ray[0] + src.r[0][1]*ray[1] + src.r[0][2]*ray[2] - src.t[0]*nr/d,
                src.r[1][0]*ray[0] + src.r[1][1]*ray[1] + src.r[1][2]*ray[2] - src.t[1]*nr/d,
                src.r[2][0]*ray[0] + src.r[2][1]*ray[1] + src.r[2][2]*ray[2] - src.t[2]*nr/d,
            ];
            if xs[2].abs() < 1e-9 { x += 1; continue; }
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
            let rval = refimg[yi as usize * rw + xi as usize] as f64;
            let sval = sample_gray(src.gray, src.w, src.h, su, sv_);
            sum_r += rval; sum_s += sval;
            sum_rr += rval*rval; sum_ss += sval*sval; sum_rs += rval*sval;
            cnt += 1.0;
            x += 1;
        }
        y += 1;
    }
    if cnt < 4.0 { return INVALID; } // too little overlap — no measurement
    let mean_r = sum_r / cnt;
    let mean_s = sum_s / cnt;
    let var_r = sum_rr / cnt - mean_r*mean_r;
    let var_s = sum_ss / cnt - mean_s*mean_s;
    let cov = sum_rs / cnt - mean_r*mean_s;
    let denom = (var_r * var_s).sqrt();
    if denom < 1e-6 { return INVALID; } // textureless patch — no measurement
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
    u: usize, v: usize, depth: f64, n: &V3, radius: i32,
) -> f64 {
    if depth <= 0.0 { return 2.0; }
    // Collect only *valid* per-source costs; exclude no-measurement sources
    // (INVALID sentinel) rather than averaging their max cost in.
    let mut costs: Vec<f64> = srcs.iter()
        .map(|s| plane_cost(refimg, rw, rh, rfx, rfy, rcx, rcy, s, u, v, depth, n, radius))
        .filter(|c| *c < INVALID_THRESH)
        .collect();
    if costs.is_empty() { return 2.0; } // no source measured this pixel
    costs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let k = best_k.min(costs.len()).max(1);
    costs[..k].iter().sum::<f64>() / k as f64
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn compute_depth_map(
    ref_gray: &[u8], ref_w: u32, ref_h: u32, ref_k: &[f32],
    src_gray: &[u8], src_dims: &[u32], src_k: &[f32], src_rel: &[f32], src_mask: &[u8],
    seed_depth: &[f32],
    depth_min: f32, depth_max: f32,
    window: u32, iterations: u32, best_k: u32,
    seed: u32,
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
    let radius = (window.max(1) as i32).min(3); // ≤ 7×7 window (32-sample cap)

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
    let mut rng = Xorshift(seed | 1);
    // Random f64 in [0,1).
    let randf = |r: &mut Xorshift| (r.next() as f64) / (u32::MAX as f64 + 1.0);

    // Per-pixel state.
    let mut depth = vec![0.0f64; npix];
    let mut nx = vec![0.0f64; npix];
    let mut ny = vec![0.0f64; npix];
    let mut nz = vec![1.0f64; npix];
    let mut cost = vec![2.0f64; npix];

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
    for i in 0..npix {
        let seeded = if have_seed { seed_depth[i] as f64 } else { 0.0 };
        let d0 = if seeded > 0.0 { seeded.clamp(dmin, dmax) }
                 else { dmin + randf(&mut rng) * (dmax - dmin) };
        let n0 = rand_normal(&mut rng);
        depth[i] = d0; nx[i] = n0[0]; ny[i] = n0[1]; nz[i] = n0[2];
        let u = i % rw; let v = i / rw;
        cost[i] = agg_cost(ref_gray, rw, rh, rfx, rfy, rcx, rcy, &srcs, bk, u, v, d0, &n0, radius);
    }

    // Red-black checkerboard PatchMatch sweeps.
    let iters = iterations.max(1);
    for it in 0..iters {
        let shrink = 0.5f64.powi(it as i32); // refinement magnitude decays
        for parity in 0..2u32 {
            for v in 0..rh {
                for u in 0..rw {
                    if ((u + v) as u32 & 1) != parity { continue; }
                    let i = v * rw + u;
                    let mut best_d = depth[i];
                    let mut best_n = [nx[i], ny[i], nz[i]];
                    let mut best_c = cost[i];

                    // 1. Spatial propagation from the 4-neighbours' planes.
                    let neigh = [
                        (u.wrapping_sub(1), v), (u + 1, v),
                        (u, v.wrapping_sub(1)), (u, v + 1),
                    ];
                    for (nu, nv) in neigh {
                        if nu >= rw || nv >= rh { continue; }
                        let j = nv * rw + nu;
                        let cand_d = depth[j];
                        let cand_n = [nx[j], ny[j], nz[j]];
                        let c = agg_cost(ref_gray, rw, rh, rfx, rfy, rcx, rcy, &srcs, bk, u, v, cand_d, &cand_n, radius);
                        if c < best_c { best_c = c; best_d = cand_d; best_n = cand_n; }
                    }

                    // 2. Random refinement: perturb depth and normal at decaying scale.
                    let dspan = (dmax - dmin) * 0.5 * shrink;
                    let pert_d = (best_d + (randf(&mut rng) * 2.0 - 1.0) * dspan).clamp(dmin, dmax);
                    let pert_n = normalize3(&[
                        best_n[0] + (randf(&mut rng) * 2.0 - 1.0) * 0.5 * shrink,
                        best_n[1] + (randf(&mut rng) * 2.0 - 1.0) * 0.5 * shrink,
                        (best_n[2] - randf(&mut rng) * 0.3 * shrink).min(-0.1),
                    ]);
                    let c = agg_cost(ref_gray, rw, rh, rfx, rfy, rcx, rcy, &srcs, bk, u, v, pert_d, &pert_n, radius);
                    if c < best_c { best_c = c; best_d = pert_d; best_n = pert_n; }

                    depth[i] = best_d; nx[i] = best_n[0]; ny[i] = best_n[1]; nz[i] = best_n[2];
                    cost[i] = best_c;
                }
            }
        }
    }

    // Emit depth plane followed by cost plane.
    let mut out = vec![0.0f32; npix * 2];
    for i in 0..npix {
        out[i] = depth[i] as f32;
        out[npix + i] = cost[i] as f32;
    }
    out
}

