// Sparse bundle adjustment: Levenberg–Marquardt with the Schur complement
// (points eliminated against the cameras) and adaptive Huber robustification.
use wasm_bindgen::prelude::*;
use crate::linalg::*;

// ── Dense linear algebra for bundle adjustment ────────────────────────────────

// Inverse of a 3×3 matrix via cofactors; None if (near-)singular.
pub(crate) fn inv3(m: &M3) -> Option<M3> {
    let det = det3(m);
    if det.abs() < 1e-20 { return None; }
    let id = 1.0 / det;
    Some([
        [(m[1][1]*m[2][2]-m[1][2]*m[2][1])*id, (m[0][2]*m[2][1]-m[0][1]*m[2][2])*id, (m[0][1]*m[1][2]-m[0][2]*m[1][1])*id],
        [(m[1][2]*m[2][0]-m[1][0]*m[2][2])*id, (m[0][0]*m[2][2]-m[0][2]*m[2][0])*id, (m[0][2]*m[1][0]-m[0][0]*m[1][2])*id],
        [(m[1][0]*m[2][1]-m[1][1]*m[2][0])*id, (m[0][1]*m[2][0]-m[0][0]*m[2][1])*id, (m[0][0]*m[1][1]-m[0][1]*m[1][0])*id],
    ])
}

// Solve a symmetric positive-definite dense system A·x = b (A row-major n×n) by
// Cholesky factorisation. None if A is not positive-definite — the LM caller then
// raises the damping and retries. This dense solve is the piece to swap for an
// iterative (preconditioned-CG) Schur solve at very large camera counts.
pub(crate) fn chol_solve(n: usize, a: &[f64], b: &[f64]) -> Option<Vec<f64>> {
    let mut l = vec![0f64; n * n];
    for j in 0..n {
        let mut d = a[j*n + j];
        for k in 0..j { d -= l[j*n + k] * l[j*n + k]; }
        if d <= 1e-18 { return None; }
        let dj = d.sqrt();
        l[j*n + j] = dj;
        for i in (j+1)..n {
            let mut s = a[i*n + j];
            for k in 0..j { s -= l[i*n + k] * l[j*n + k]; }
            l[i*n + j] = s / dj;
        }
    }
    let mut y = vec![0f64; n]; // forward solve L·y = b
    for i in 0..n {
        let mut s = b[i];
        for k in 0..i { s -= l[i*n + k] * y[k]; }
        y[i] = s / l[i*n + i];
    }
    let mut x = vec![0f64; n]; // back solve Lᵀ·x = y
    for i in (0..n).rev() {
        let mut s = y[i];
        for k in (i+1)..n { s -= l[k*n + i] * x[k]; }
        x[i] = s / l[i*n + i];
    }
    Some(x)
}

// Pinhole projection with the shared radial polynomial (Brown, no tangential):
// d = 1 + k1·r² + k2·r⁴ + k3·r⁶, u = fx·a·d + cx, v = fy·b·d + cy, with a,b =
// normalised camera coords (xc/zc, yc/zc). All coeffs 0 ⇒ plain pinhole.
fn project_full(r: &M3, t: &V3, fx: f64, fy: f64, cx: f64, cy: f64, k1: f64, k2: f64, k3: f64, x: &V3) -> (f64, f64) {
    let pc = mat3_vec(r, x);
    let (xc, yc, zc) = (pc[0] + t[0], pc[1] + t[1], pc[2] + t[2]);
    if zc.abs() < 1e-9 { return (f64::NAN, f64::NAN); }
    let a = xc / zc; let b = yc / zc;
    let r2 = a * a + b * b; let r4 = r2 * r2;
    let d = 1.0 + k1 * r2 + k2 * r4 + k3 * r4 * r2;
    (fx * a * d + cx, fy * b * d + cy)
}

// Principal rotation vector Log(R), with magnitude in [0, π]. Camera orientation
// priors use Log(R_current R_targetᵀ), so the residual is continuous around the
// target and avoids Euler-angle wraparound inside the optimiser.
pub(crate) fn so3_log(r: &M3) -> V3 {
    let cos_theta = ((r[0][0] + r[1][1] + r[2][2] - 1.0) * 0.5).clamp(-1.0, 1.0);
    let theta = cos_theta.acos();
    let vee = [r[2][1] - r[1][2], r[0][2] - r[2][0], r[1][0] - r[0][1]];
    if theta < 1e-8 { return [0.5*vee[0], 0.5*vee[1], 0.5*vee[2]]; }
    let sin_theta = theta.sin();
    if sin_theta.abs() > 1e-7 {
        let scale = theta / (2.0 * sin_theta);
        return [scale*vee[0], scale*vee[1], scale*vee[2]];
    }
    let mut axis = [
        ((r[0][0] + 1.0) * 0.5).max(0.0).sqrt(),
        ((r[1][1] + 1.0) * 0.5).max(0.0).sqrt(),
        ((r[2][2] + 1.0) * 0.5).max(0.0).sqrt(),
    ];
    if axis[0] >= axis[1] && axis[0] >= axis[2] && axis[0] > 1e-8 {
        axis[1] = (r[0][1] + r[1][0]) / (4.0 * axis[0]);
        axis[2] = (r[0][2] + r[2][0]) / (4.0 * axis[0]);
    } else if axis[1] >= axis[2] && axis[1] > 1e-8 {
        axis[0] = (r[0][1] + r[1][0]) / (4.0 * axis[1]);
        axis[2] = (r[1][2] + r[2][1]) / (4.0 * axis[1]);
    } else if axis[2] > 1e-8 {
        axis[0] = (r[0][2] + r[2][0]) / (4.0 * axis[2]);
        axis[1] = (r[1][2] + r[2][1]) / (4.0 * axis[2]);
    }
    let norm = (axis[0]*axis[0] + axis[1]*axis[1] + axis[2]*axis[2]).sqrt().max(1e-12);
    [theta*axis[0]/norm, theta*axis[1]/norm, theta*axis[2]/norm]
}

// ── Reduced-variable coupling blocks (Schur assembly) ─────────────────────────

// One point's merged Jvarᵀ·Jp coupling block, keyed by its reduced-variable offset
// (a camera's 6 rows, or an intrinsic group's 1–3 rows). Fixed 6-row storage (the
// max block height) keeps assembly allocation-free; only `dim` rows are used.
struct EBlock { off: usize, dim: usize, rows: [[f64; 3]; 6] }

// Accumulate a coupling block into a point's E-list, merging by offset so that two
// cameras sharing an intrinsic group fold into that group's single block.
fn add_eblock(list: &mut Vec<EBlock>, off: usize, dim: usize, rows: &[[f64; 3]; 6]) {
    if let Some(eb) = list.iter_mut().find(|e| e.off == off) {
        for a in 0..dim { for b in 0..3 { eb.rows[a][b] += rows[a][b]; } }
    } else {
        list.push(EBlock { off, dim, rows: *rows });
    }
}

// Map each camera to an intrinsic-group slot. Cameras sharing a non-negative sensor
// id share a slot; unassigned cameras (id < 0, or a short/empty id list) each get
// their own slot. Returns the per-camera slot vector and the slot count.
fn build_groups(ids: &[i32], n_cam: usize) -> (Vec<usize>, usize) {
    use std::collections::HashMap;
    let mut map: HashMap<i32, usize> = HashMap::new();
    let mut grp = vec![0usize; n_cam];
    let mut next = 0usize;
    for c in 0..n_cam {
        let id = ids.get(c).copied().unwrap_or(-1);
        if id < 0 {
            grp[c] = next; next += 1;
        } else {
            grp[c] = *map.entry(id).or_insert_with(|| { let g = next; next += 1; g });
        }
    }
    (grp, next)
}

/// Bundle adjustment by sparse Levenberg–Marquardt with the Schur complement.
///
/// Jointly refines every camera pose (6-DOF: left-perturbed so(3) rotation +
/// translation) and every 3D point, and — when `refine_mode > 0` — a small set of
/// shared per-sensor intrinsic parameters (self-calibration). Points are always
/// eliminated by the Schur complement; the reduced system holds the camera poses
/// plus the intrinsic groups, solved by dense Cholesky. Huber robustification (an
/// adaptive threshold tracking the residual median) keeps surviving gross
/// mis-triangulations from dragging the solution.
///
/// Intrinsic self-calibration is opt-in and modest: each sensor group carries a
/// focal **scale** `s` (init 1, multiplying every member camera's fx/fy) and,
/// for `refine_mode == 2`, shared principal-point offsets `dcx, dcy`. Modelling
/// the focal as a scale (not an absolute) preserves any per-camera differences in
/// the seed intrinsics while still sharing one degree of freedom across the group.
///
/// At large camera counts the dense reduced-camera Cholesky (`chol_solve`) is the
/// only part that needs swapping for an iterative Schur solve.
///
/// GCP support: `anchor_flat`/`anchor_weight` optionally pull specific 3D points
/// toward a known target position (e.g. a GCP triangulated in this same SfM
/// frame) with an extra quadratic residual `Σ_axis w_axis·(pt − target)²`. This only ever
/// touches that point's own 3×3 block (gradient + diagonal Hessian) — no camera
/// Jacobian, no new coupling — so it folds into the existing per-point Schur
/// elimination for free. Empty anchor arrays reduce to today's behaviour exactly.
/// Camera-pose support: `camera_prior_flat` optionally pulls camera centres
/// `C = -R^T t` and rotations toward known poses in this same SfM frame. Position
/// rows carry independent inverse-variance weights for X/Y/Z. Orientation uses
/// the tangent residual `Log(R R_target^T)` and a full 3×3 precision matrix,
/// allowing the caller to transform per-OPK uncertainties into solver axes.
///
/// # Inputs
/// - `cameras_flat`: n_cam × 12 floats `[R(9)|t(3), …]`
/// - `intrinsics_flat`: n_cam × 4 floats `[fx,fy,cx,cy, …]` (the seed / base K)
/// - `pts_flat`: n_pts × 3 floats `[x,y,z, …]`
/// - `obs_flat`: n_obs × 4 floats `[cam_i, pt_i, pixel_x, pixel_y, …]`
/// - `anchor_flat`: n_anchor × 4 floats `[pt_i, target_x, target_y, target_z, …]`
/// - `observation_weight`: n_obs × 2 inverse-variance pixel weights (X/Y);
///   feature observations use 1, GCP marks use their declared pixel variances
/// - `anchor_weight`: n_anchor × 9 floats, row-major 3×3 precision matrices
/// - `camera_prior_flat`: n_prior × 25 floats
///   `[cam_i, target_x, target_y, target_z, weight_x, weight_y, weight_z,
///     target_R(9), orientation_precision(9), …]`. An all-zero orientation
///   precision matrix makes the row position-only.
/// - `max_iters`: outer LM iterations
/// - `sensor_of_cam`: n_cam ints — per-camera sensor id (shared → shared focal);
///   `< 0` (or a short/empty list) ⇒ that camera is its own group
/// - `refine_mask`: **bitmask** of the shared per-sensor intrinsics to self-calibrate:
///   1 = focal scale s, 2 = principal point (dcx,dcy), 4 = radial k1, 8 = k2, 16 = k3.
///   0 ⇒ poses+points only. The per-group param vector is the ordered subset
///   `[s?, dcx?, dcy?, k1?, k2?, k3?]` (kdim ≤ 6). fy stays locked to fx (single scale).
///
/// # Output
/// `[cameras_flat(n_cam×12), pts_flat(n_pts×3), intrinsics_flat(n_cam×7),
///   cost_before, cost_after, anchor_rms_after, camera_prior_rms_after,
///   cost_trace…]` — the returned
/// intrinsics are the **refined** effective K per camera as `[fx,fy,cx,cy,k1,k2,k3]`
/// (radial coeffs 0 for the bits not set in `refine_mask`, identical to the input K
/// when `refine_mask == 0`); cost_before/cost_after are RMS reprojection error in
/// pixels (anchors do not affect them); anchor_rms_after is the RMS anchor
/// residual in the caller's world units, and camera_prior_rms_after is the RMS
/// camera-centre residual (both 0 when their respective prior list is empty).
#[wasm_bindgen]
pub fn bundle_adjust(
    cameras_flat: &[f32],
    intrinsics_flat: &[f32],
    pts_flat: &[f32],
    obs_flat: &[f32],
    observation_weight: &[f32],
    anchor_flat: &[f32],
    anchor_weight: &[f32],
    camera_prior_flat: &[f32],
    max_iters: u32,
    sensor_of_cam: &[i32],
    refine_mask: u32,
) -> Vec<f32> {
    let n_cam = cameras_flat.len() / 12;
    let n_pts = pts_flat.len() / 3;
    let n_obs = obs_flat.len() / 4;
    if n_cam == 0 || n_pts == 0 || n_obs == 0 { return vec![]; }

    // Anchors: (point_idx, target position, per-axis weights). Points outside range are
    // dropped rather than panicking on a malformed caller payload.
    let n_anchor = anchor_flat.len() / 4;
    let anchors: Vec<(usize, V3, M3)> = (0..n_anchor).filter_map(|i| {
        let b = i * 4;
        let pi = anchor_flat[b] as usize;
        let target: V3 = [anchor_flat[b+1] as f64, anchor_flat[b+2] as f64, anchor_flat[b+3] as f64];
        let wb = i * 9;
        let precision: M3 = [0,1,2].map(|r| [0,1,2].map(|c| {
            anchor_weight.get(wb + 3*r + c).copied().unwrap_or(if r == c { 1.0 } else { 0.0 }) as f64
        }));
        if pi >= n_pts || precision.iter().flatten().any(|v| !v.is_finite()) { return None; }
        Some((pi, target, precision))
    }).collect();
    let mut anchored = vec![false; n_pts];
    for &(pi, _, _) in &anchors { anchored[pi] = true; }
    let anchor_sse = |pts: &Vec<V3>| -> f64 {
        let mut sum = 0.0f64;
        for &(pi, target, precision) in &anchors {
            let d = [pts[pi][0]-target[0], pts[pi][1]-target[1], pts[pi][2]-target[2]];
            let pd = mat3_vec(&precision, &d);
            sum += d[0]*pd[0] + d[1]*pd[1] + d[2]*pd[2];
        }
        sum
    };
    let anchor_rms = |pts: &Vec<V3>| -> f64 {
        if anchors.is_empty() { return 0.0; }
        let mut sse = 0.0f64;
        for &(pi, target, _) in &anchors {
            let dx = pts[pi][0] - target[0]; let dy = pts[pi][1] - target[1]; let dz = pts[pi][2] - target[2];
            sse += dx*dx + dy*dy + dz*dz;
        }
        (sse / anchors.len() as f64).sqrt()
    };

    // Camera-pose priors: camera index, target centre, position weights, and an
    // optional (target rotation, full orientation precision) pair.
    let n_camera_prior = camera_prior_flat.len() / 25;
    let camera_priors: Vec<(usize, V3, V3, Option<(M3, M3)>)> = (0..n_camera_prior).filter_map(|i| {
        let b = i * 25;
        let ci = camera_prior_flat[b] as usize;
        let target = [camera_prior_flat[b+1] as f64, camera_prior_flat[b+2] as f64,
                      camera_prior_flat[b+3] as f64];
        let weight = [camera_prior_flat[b+4] as f64, camera_prior_flat[b+5] as f64,
                      camera_prior_flat[b+6] as f64];
        if ci >= n_cam || target.iter().any(|v| !v.is_finite())
            || weight.iter().any(|v| !v.is_finite() || *v <= 0.0) { return None; }
        let target_r: M3 = [0,1,2].map(|row| [0,1,2].map(|col|
            camera_prior_flat[b + 7 + 3*row + col] as f64));
        let mut precision: M3 = [0,1,2].map(|row| [0,1,2].map(|col|
            camera_prior_flat[b + 16 + 3*row + col] as f64));
        for row in 0..3 { for col in (row+1)..3 {
            let v = 0.5 * (precision[row][col] + precision[col][row]);
            precision[row][col] = v; precision[col][row] = v;
        }}
        let det2 = precision[0][0]*precision[1][1] - precision[0][1]*precision[1][0];
        let orientation = if target_r.iter().flatten().all(|v| v.is_finite())
            && precision.iter().flatten().all(|v| v.is_finite())
            && precision[0][0] > 0.0 && det2 > 0.0 && det3(&precision) > 0.0 {
            Some((target_r, precision))
        } else { None };
        Some((ci, target, weight, orientation))
    }).collect();

    // Unpack cameras / base intrinsics / points / observations.
    let mut cams: Vec<(M3, V3)> = (0..n_cam).map(|c| {
        let b = c * 12;
        let r: M3 = [[cameras_flat[b]   as f64, cameras_flat[b+1] as f64, cameras_flat[b+2]  as f64],
                     [cameras_flat[b+3] as f64, cameras_flat[b+4] as f64, cameras_flat[b+5]  as f64],
                     [cameras_flat[b+6] as f64, cameras_flat[b+7] as f64, cameras_flat[b+8]  as f64]];
        let t: V3 = [cameras_flat[b+9] as f64, cameras_flat[b+10] as f64, cameras_flat[b+11] as f64];
        (r, t)
    }).collect();
    // Base (seed) intrinsics — held fixed; refinement is expressed relative to these.
    let ks: Vec<(f64, f64, f64, f64)> = (0..n_cam).map(|c| {
        let b = c * 4;
        (intrinsics_flat[b] as f64, intrinsics_flat[b+1] as f64,
         intrinsics_flat[b+2] as f64, intrinsics_flat[b+3] as f64)
    }).collect();
    let mut pts: Vec<V3> = (0..n_pts).map(|i| {
        [pts_flat[i*3] as f64, pts_flat[i*3+1] as f64, pts_flat[i*3+2] as f64]
    }).collect();
    let obs: Vec<(usize, usize, f64, f64, f64, f64)> = (0..n_obs).map(|i| {
        let b = i * 4;
        let wb = i * 2;
        let wx = observation_weight.get(wb).copied().unwrap_or(1.0) as f64;
        let wy = observation_weight.get(wb+1).copied().unwrap_or(1.0) as f64;
        (obs_flat[b] as usize, obs_flat[b+1] as usize, obs_flat[b+2] as f64, obs_flat[b+3] as f64,
         if wx.is_finite() && wx > 0.0 { wx } else { 1.0 }, if wy.is_finite() && wy > 0.0 { wy } else { 1.0 })
    }).filter(|&(ci, pi, _, _, _, _)| ci < n_cam && pi < n_pts).collect();

    // Per-point observation lists — the structure the Schur reduction iterates.
    let mut pt_obs: Vec<Vec<(usize, f64, f64, f64, f64)>> = vec![vec![]; n_pts];
    for &(ci, pi, ox, oy, wx, wy) in &obs { pt_obs[pi].push((ci, ox, oy, wx, wy)); }

    let camera_center = |cam: &(M3, V3)| -> V3 {
        let (r, t) = cam;
        [-(r[0][0]*t[0] + r[1][0]*t[1] + r[2][0]*t[2]),
         -(r[0][1]*t[0] + r[1][1]*t[1] + r[2][1]*t[2]),
         -(r[0][2]*t[0] + r[1][2]*t[1] + r[2][2]*t[2])]
    };
    let orientation_residual = |r: &M3, target_r: &M3| -> V3 {
        so3_log(&mat3_mul(r, &mat3_transpose(target_r)))
    };
    let camera_prior_sse = |cams: &Vec<(M3, V3)>| -> f64 {
        camera_priors.iter().map(|&(ci, target, weight, orientation)| {
            let c = camera_center(&cams[ci]);
            let position = (0..3).map(|k| weight[k] * (c[k] - target[k]).powi(2)).sum::<f64>();
            let rotation = orientation.map(|(target_r, precision)| {
                let e = orientation_residual(&cams[ci].0, &target_r);
                let pe = mat3_vec(&precision, &e);
                dot3(&e, &pe)
            }).unwrap_or(0.0);
            position + rotation
        }).sum()
    };
    let camera_prior_rms = |cams: &Vec<(M3, V3)>| -> f64 {
        if camera_priors.is_empty() { return 0.0; }
        let sse: f64 = camera_priors.iter().map(|&(ci, target, _, _)| {
            let c = camera_center(&cams[ci]);
            (0..3).map(|k| (c[k] - target[k]).powi(2)).sum::<f64>()
        }).sum();
        (sse / camera_priors.len() as f64).sqrt()
    };

    // ── Intrinsic self-calibration setup ─────────────────────────────────────────
    // `refine_mask` is a bitmask (1=f, 2=cxcy, 4=k1, 8=k2, 16=k3). The per-group param
    // vector is the ordered subset [s?, dcx?, dcy?, k1?, k2?, k3?]; `idx_*` is each
    // param's slot in that vector (−1 when its bit is clear). kdim ≤ 6.
    let has_f = refine_mask & 1 != 0;
    let has_cxcy = refine_mask & 2 != 0;
    let has_k1 = refine_mask & 4 != 0;
    let has_k2 = refine_mask & 8 != 0;
    let has_k3 = refine_mask & 16 != 0;
    let mut kdim = 0usize;
    let mut alloc = |on: bool| -> isize { if on { let i = kdim as isize; kdim += 1; i } else { -1 } };
    let idx_s   = alloc(has_f);
    let idx_dcx = alloc(has_cxcy);
    let idx_dcy = alloc(has_cxcy);
    let idx_k1  = alloc(has_k1);
    let idx_k2  = alloc(has_k2);
    let idx_k3  = alloc(has_k3);
    let (grp, g_count) = if kdim > 0 { build_groups(sensor_of_cam, n_cam) } else { (vec![0usize; n_cam], 0) };
    let refine = kdim > 0 && g_count > 0;
    let group_off = 6 * n_cam;            // intrinsic params follow the camera poses
    let n = group_off + if refine { g_count * kdim } else { 0 };
    // Per-group params, one [f64;6] slot each. The focal-scale slot (if present) inits
    // to 1 (multiplies fx/fy); every distortion/principal-point slot inits to 0.
    let mut gpar = vec![[0.0f64; 6]; g_count.max(1)];
    if idx_s >= 0 { for g in gpar.iter_mut() { g[idx_s as usize] = 1.0; } }

    // Effective K + radial coeffs (k1,k2,k3) for a camera under the current group params.
    let eff = |ci: usize, gpar: &Vec<[f64; 6]>| -> (f64, f64, f64, f64, f64, f64, f64) {
        let (fx0, fy0, cx0, cy0) = ks[ci];
        if !refine { return (fx0, fy0, cx0, cy0, 0.0, 0.0, 0.0); }
        let p = gpar[grp[ci]];
        let get = |idx: isize| -> f64 { if idx >= 0 { p[idx as usize] } else { 0.0 } };
        let s = if idx_s >= 0 { p[idx_s as usize] } else { 1.0 };
        (s * fx0, s * fy0, cx0 + get(idx_dcx), cy0 + get(idx_dcy), get(idx_k1), get(idx_k2), get(idx_k3))
    };

    // Plain RMS reprojection error over all observations (reported to the caller).
    let rms = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; 6]>| -> f64 {
        let mut sse = 0.0f64; let mut cnt = 0usize;
        for &(ci, pi, ox, oy, _, _) in &obs {
            let (r, t) = &cams[ci];
            let (fx, fy, cx, cy, k1, k2, k3) = eff(ci, gpar);
            let (px, py) = project_full(r, t, fx, fy, cx, cy, k1, k2, k3, &pts[pi]);
            if px.is_nan() { continue; }
            sse += (px - ox).powi(2) + (py - oy).powi(2); cnt += 1;
        }
        if cnt == 0 { 0.0 } else { (sse / cnt as f64).sqrt() }
    };

    // Huber-robustified cost Σ ρ(‖r‖) at pixel threshold δ, plus the (unrobustified,
    // quadratic) GCP anchor term — same total objective the LM step below descends.
    let robust_cost = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; 6]>, dh: f64| -> f64 {
        let mut sum = 0.0f64;
        for &(ci, pi, ox, oy, wx, wy) in &obs {
            let (r, t) = &cams[ci];
            let (fx, fy, cx, cy, k1, k2, k3) = eff(ci, gpar);
            let (px, py) = project_full(r, t, fx, fy, cx, cy, k1, k2, k3, &pts[pi]);
            if px.is_nan() { sum += dh * dh; continue; }
            let dx=px-ox; let dy=py-oy; let e=(dx*dx+dy*dy).sqrt();
            // The Huber loss the IRLS weight r = δ/e actually descends: ρ = q·(2r − r²)
            // (= 2δe − δ² for unit weights), continuous with q at e = δ. Evaluating
            // r·q (= δe) instead halved the outlier slope relative to the step model
            // and the anchor/prior terms, so step acceptance judged a different cost.
            let q = wx*dx*dx + wy*dy*dy;
            sum += if e <= dh { q } else { let r = dh/e; q * (2.0*r - r*r) };
        }
        sum + anchor_sse(pts) + camera_prior_sse(cams)
    };

    // Adaptive Huber threshold: a multiple of the residual median, so it tracks the
    // noise floor as the model tightens. Recomputed once per outer iteration.
    let huber_threshold = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; 6]>| -> f64 {
        let mut es: Vec<f64> = Vec::with_capacity(obs.len());
        for &(ci, pi, ox, oy, _, _) in &obs {
            let (r, t) = &cams[ci];
            let (fx, fy, cx, cy, k1, k2, k3) = eff(ci, gpar);
            let (px, py) = project_full(r, t, fx, fy, cx, cy, k1, k2, k3, &pts[pi]);
            if px.is_nan() { continue; }
            es.push(((px - ox).powi(2) + (py - oy).powi(2)).sqrt());
        }
        if es.is_empty() { return 1.0; }
        es.sort_by(|a, b| a.partial_cmp(b).unwrap());
        (2.5 * es[es.len() / 2]).max(1.0)
    };

    let cost_before = rms(&cams, &pts, &gpar);
    let mut lambda = 1e-3f64;              // LM damping
    let mut trace: Vec<f64> = Vec::new();  // RMS after each accepted iteration

    for _outer in 0..max_iters {
        let dh = huber_threshold(&cams, &pts, &gpar);
        let mut cost = robust_cost(&cams, &pts, &gpar, dh);

        // ── Assemble undamped blocks ────────────────────────────────────────────
        // S (n×n) is the reduced-variable Hessian (camera poses + intrinsic groups);
        // gr its gradient; per-point C (3×3), gp (3); and E-blocks coupling each
        // point to every reduced variable that observes it.
        let mut smat = vec![0f64; n * n];
        let mut gr = vec![0f64; n];
        let mut cmat = vec![[[0f64; 3]; 3]; n_pts];
        let mut gpv = vec![[0f64; 3]; n_pts];
        let mut emap: Vec<Vec<EBlock>> = (0..n_pts).map(|_| Vec::new()).collect();

        // GCP anchors: gradient/Hessian of Σ_axis w_axis·(pt−target)² touches only that
        // point's own 3×3 block — no camera coupling, so it's just added here.
        for &(pi, target, precision) in &anchors {
            let d = [pts[pi][0]-target[0], pts[pi][1]-target[1], pts[pi][2]-target[2]];
            let pd = mat3_vec(&precision, &d);
            for a in 0..3 {
                gpv[pi][a] += pd[a];
                for b in 0..3 { cmat[pi][a][b] += precision[a][b]; }
            }
        }

        // Camera-centre priors contribute directly to the reduced camera blocks.
        // For C=-R^Tt and update (t+=dt, R=Exp(dw)R), J=[-R^T|-R^T[t]_x].
        for &(ci, target, weight, orientation) in &camera_priors {
            let (r, t) = &cams[ci];
            let centre = camera_center(&cams[ci]);
            let st = skew(t);
            let mut j = [[0.0f64; 6]; 3];
            for row in 0..3 {
                for col in 0..3 {
                    j[row][col] = -r[col][row];
                    j[row][3 + col] = -(r[0][row]*st[0][col]
                        + r[1][row]*st[1][col] + r[2][row]*st[2][col]);
                }
            }
            let residual = [centre[0] - target[0], centre[1] - target[1], centre[2] - target[2]];
            let off = 6 * ci;
            for a in 0..6 {
                for axis in 0..3 { gr[off+a] += weight[axis] * j[axis][a] * residual[axis]; }
                for b in 0..6 {
                    for axis in 0..3 {
                        smat[(off+a)*n + off+b] += weight[axis] * j[axis][a] * j[axis][b];
                    }
                }
            }

            // Orientation residual e=Log(R R_targetᵀ). A small central finite-
            // difference Jacobian is used for the three rotation variables. It
            // is exact for the actual left-multiplicative update convention and
            // avoids a fragile closed-form inverse-Jacobian near large rotations.
            if let Some((target_r, precision)) = orientation {
                let e = orientation_residual(r, &target_r);
                let eps = 1e-6;
                let mut j = [[0.0f64; 3]; 3];
                for col in 0..3 {
                    let mut dw_plus = [0.0; 3]; dw_plus[col] = eps;
                    let mut dw_minus = [0.0; 3]; dw_minus[col] = -eps;
                    let rp = mat3_mul(&so3_exp(&dw_plus), r);
                    let rm = mat3_mul(&so3_exp(&dw_minus), r);
                    let ep = orientation_residual(&rp, &target_r);
                    let em = orientation_residual(&rm, &target_r);
                    for row in 0..3 { j[row][col] = (ep[row] - em[row]) / (2.0*eps); }
                }
                let pe = mat3_vec(&precision, &e);
                for a in 0..3 {
                    let ia = off + 3 + a;
                    for row in 0..3 { gr[ia] += j[row][a] * pe[row]; }
                    for b in 0..3 {
                        let ib = off + 3 + b;
                        for row in 0..3 { for col in 0..3 {
                            smat[ia*n + ib] += j[row][a] * precision[row][col] * j[col][b];
                        }}
                    }
                }
            }
        }

        for pi in 0..n_pts {
            for &(ci, ox, oy, obs_wx, obs_wy) in &pt_obs[pi] {
                let (r, t) = &cams[ci];
                let (fx, fy, cx, cy, k1, k2, k3) = eff(ci, &gpar);
                let pc = mat3_vec(r, &pts[pi]); // R·X
                let xc = pc[0] + t[0]; let yc = pc[1] + t[1]; let zc = pc[2] + t[2];
                if zc.abs() < 1e-9 { continue; }
                let inv = 1.0 / zc;
                // Normalised coords + the shared radial factor d = 1 + k1·r² + k2·r⁴ + k3·r⁶
                // (d ≡ 1, and every derivative reduces to the pinhole case, when all k = 0).
                let a = xc * inv; let b = yc * inv;
                let r2 = a * a + b * b; let r4 = r2 * r2;
                let d = 1.0 + k1 * r2 + k2 * r4 + k3 * r4 * r2;
                // g ≡ d'(r²) = k1 + 2k2·r² + 3k3·r⁴ — the k1 of the pinhole+k1 Jacobians
                // generalises to g for the full polynomial (∂d/∂a = 2a·g, ∂d/∂b = 2b·g).
                let g = k1 + 2.0*k2*r2 + 3.0*k3*r4;
                let ru = fx * a * d + cx - ox;
                let rv = fy * b * d + cy - oy;
                // ∂proj/∂x_cam (2×3), exact analytic with the radial term (k1→g):
                //   ∂u/∂xc = (fx/zc)(d+2g·a²), ∂u/∂yc = (fx/zc)(2g·a·b),
                //   ∂u/∂zc = −(fx·a/zc)(d+2g·r²)  (and symmetrically for v).
                let dudc = [fx * inv * (d + 2.0*g*a*a), fx * inv * (2.0*g*a*b), -fx * a * inv * (d + 2.0*g*r2)];
                let dvdc = [fy * inv * (2.0*g*a*b), fy * inv * (d + 2.0*g*b*b), -fy * b * inv * (d + 2.0*g*r2)];
                // Camera Jacobian Jc (2×6): [I | −[pc]_×] through ∂proj/∂x_cam.
                let sp = skew(&pc);
                let mut ju = [0f64; 6]; let mut jv = [0f64; 6];
                for k in 0..3 { ju[k] = dudc[k]; jv[k] = dvdc[k]; }
                for k in 0..3 {
                    let colk = [-sp[0][k], -sp[1][k], -sp[2][k]];
                    ju[3 + k] = dudc[0]*colk[0] + dudc[1]*colk[1] + dudc[2]*colk[2];
                    jv[3 + k] = dvdc[0]*colk[0] + dvdc[1]*colk[1] + dvdc[2]*colk[2];
                }
                // Point Jacobian Jp (2×3) = ∂proj/∂x_cam · R.
                let mut jpu = [0f64; 3]; let mut jpv = [0f64; 3];
                for k in 0..3 {
                    jpu[k] = dudc[0]*r[0][k] + dudc[1]*r[1][k] + dudc[2]*r[2][k];
                    jpv[k] = dvdc[0]*r[0][k] + dvdc[1]*r[1][k] + dvdc[2]*r[2][k];
                }
                // Intrinsic Jacobian Jk (2×kdim), filled by slot (idx_* is the param's
                // position in [s?,dcx?,dcy?,k1?,k2?,k3?]). ∂/∂s = (fx0·a·d, fy0·b·d);
                // ∂/∂dcx = (1,0), ∂/∂dcy = (0,1); ∂/∂kj = (fx·a·r^{2j}, fy·b·r^{2j}).
                let mut jku = [0f64; 6]; let mut jkv = [0f64; 6];
                if refine {
                    let (fx0, fy0, _, _) = ks[ci];
                    if idx_s   >= 0 { jku[idx_s   as usize] = fx0 * a * d; jkv[idx_s   as usize] = fy0 * b * d; }
                    if idx_dcx >= 0 { jku[idx_dcx as usize] = 1.0; }
                    if idx_dcy >= 0 { jkv[idx_dcy as usize] = 1.0; }
                    if idx_k1  >= 0 { jku[idx_k1  as usize] = fx * a * r2;      jkv[idx_k1  as usize] = fy * b * r2; }
                    if idx_k2  >= 0 { jku[idx_k2  as usize] = fx * a * r4;      jkv[idx_k2  as usize] = fy * b * r4; }
                    if idx_k3  >= 0 { jku[idx_k3  as usize] = fx * a * r4 * r2; jkv[idx_k3  as usize] = fy * b * r4 * r2; }
                }
                // Huber IRLS weight.
                let e = (ru*ru + rv*rv).sqrt();
                let w = if e <= dh { 1.0 } else { dh / e };
                let wu = w * obs_wx; let wv = w * obs_wy;

                let coff = 6 * ci;
                for a in 0..6 {
                    gr[coff + a] += wu*ju[a]*ru + wv*jv[a]*rv;
                    for b in 0..6 { smat[(coff+a)*n + coff+b] += wu*ju[a]*ju[b] + wv*jv[a]*jv[b]; }
                }
                if refine {
                    let goff = group_off + grp[ci] * kdim;
                    for a in 0..kdim {
                        gr[goff + a] += wu*jku[a]*ru + wv*jkv[a]*rv;
                        for b in 0..kdim { smat[(goff+a)*n + goff+b] += wu*jku[a]*jku[b] + wv*jkv[a]*jkv[b]; }
                        // Cross term camera(coff) ↔ group(goff), both triangles.
                        for b in 0..6 {
                            let v = wu*jku[a]*ju[b] + wv*jkv[a]*jv[b];
                            smat[(goff+a)*n + coff+b] += v;
                            smat[(coff+b)*n + goff+a] += v;
                        }
                    }
                }
                for a in 0..3 {
                    gpv[pi][a] += wu*jpu[a]*ru + wv*jpv[a]*rv;
                    for b in 0..3 { cmat[pi][a][b] += wu*jpu[a]*jpu[b] + wv*jpv[a]*jpv[b]; }
                }
                // Coupling blocks E (Jvarᵀ·Jp) for this point: camera then group.
                let mut cblk = [[0f64; 3]; 6];
                for a in 0..6 { for b in 0..3 { cblk[a][b] = wu*ju[a]*jpu[b] + wv*jv[a]*jpv[b]; } }
                add_eblock(&mut emap[pi], coff, 6, &cblk);
                if refine {
                    let goff = group_off + grp[ci] * kdim;
                    let mut kblk = [[0f64; 3]; 6];
                    for a in 0..kdim { for b in 0..3 { kblk[a][b] = wu*jku[a]*jpu[b] + wv*jkv[a]*jpv[b]; } }
                    add_eblock(&mut emap[pi], goff, kdim, &kblk);
                }
            }
        }

        // ── LM step with damping retries ────────────────────────────────────────
        let mut accepted = false;
        for _try in 0..8 {
            // Damp the reduced diagonal, then Schur-eliminate the (λ-damped) points:
            // S ← (S+λ) − Σ_p E·(C+λ)⁻¹·Eᵀ,  rhs ← −gr + Σ_p E·(C+λ)⁻¹·gp.
            let mut s = smat.clone();
            let mut rhs = vec![0f64; n];
            for i in 0..n { rhs[i] = -gr[i]; s[i*n + i] = s[i*n + i] * (1.0 + lambda) + 1e-12; }

            let mut cinv_store: Vec<Option<M3>> = vec![None; n_pts];
            let mut tmp_store: Vec<V3> = vec![[0.0; 3]; n_pts];
            let mut ok = true;
            for pi in 0..n_pts {
                // An anchored point with no camera coupling (edge case: every
                // observing camera failed cheirality) still needs its C⁻¹·gp
                // computed so the back-substitution below moves it toward the anchor.
                if emap[pi].is_empty() && !anchored[pi] { continue; }
                let mut cp = cmat[pi];
                for i in 0..3 { cp[i][i] = cp[i][i] * (1.0 + lambda) + 1e-12; }
                let cinv = match inv3(&cp) { Some(m) => m, None => { ok = false; break; } };
                let tmp = mat3_vec(&cinv, &gpv[pi]); // C⁻¹·gp
                cinv_store[pi] = Some(cinv);
                tmp_store[pi] = tmp;
                for eb in &emap[pi] {
                    for a in 0..eb.dim {
                        rhs[eb.off + a] += eb.rows[a][0]*tmp[0] + eb.rows[a][1]*tmp[1] + eb.rows[a][2]*tmp[2];
                    }
                }
                // M_v = E_v·C⁻¹ (dim×3); then S -= Σ_{v1,v2} M_{v1}·E_{v2}ᵀ.
                let ms: Vec<[[f64; 3]; 6]> = emap[pi].iter().map(|eb| {
                    let mut m = [[0f64; 3]; 6];
                    for a in 0..eb.dim {
                        for k in 0..3 {
                            m[a][k] = eb.rows[a][0]*cinv[0][k] + eb.rows[a][1]*cinv[1][k] + eb.rows[a][2]*cinv[2][k];
                        }
                    }
                    m
                }).collect();
                for (i1, eb1) in emap[pi].iter().enumerate() {
                    for eb2 in &emap[pi] {
                        for a in 0..eb1.dim {
                            for b in 0..eb2.dim {
                                let v = ms[i1][a][0]*eb2.rows[b][0] + ms[i1][a][1]*eb2.rows[b][1] + ms[i1][a][2]*eb2.rows[b][2];
                                s[(eb1.off + a)*n + eb2.off + b] -= v;
                            }
                        }
                    }
                }
            }
            if !ok { lambda = (lambda * 4.0).min(1e8); continue; }

            let dsol = match chol_solve(n, &s, &rhs) {
                Some(x) => x,
                None => { lambda = (lambda * 4.0).min(1e8); continue; }
            };

            // Back-substitute points: δp = −C⁻¹·gp − C⁻¹·(Σ_v E_vᵀ·δv).
            let mut dp = vec![[0f64; 3]; n_pts];
            for pi in 0..n_pts {
                let cinv = match cinv_store[pi] { Some(m) => m, None => continue };
                let mut acc = [0f64; 3];
                for eb in &emap[pi] {
                    for k in 0..3 {
                        let mut sdot = 0.0;
                        for a in 0..eb.dim { sdot += eb.rows[a][k] * dsol[eb.off + a]; }
                        acc[k] += sdot;
                    }
                }
                let ca = mat3_vec(&cinv, &acc);
                for k in 0..3 { dp[pi][k] = -tmp_store[pi][k] - ca[k]; }
            }

            // Tentative update: t += δt, R = exp(δω)·R, X += δX, group params += δ.
            let mut tent_cams = cams.clone();
            for c in 0..n_cam {
                let (r0, t0) = cams[c];
                let dt = [dsol[6*c], dsol[6*c+1], dsol[6*c+2]];
                let dw = [dsol[6*c+3], dsol[6*c+4], dsol[6*c+5]];
                tent_cams[c] = (mat3_mul(&so3_exp(&dw), &r0), [t0[0]+dt[0], t0[1]+dt[1], t0[2]+dt[2]]);
            }
            let mut tent_gpar = gpar.clone();
            if refine {
                for g in 0..g_count {
                    let goff = group_off + g * kdim;
                    // Slots are contiguous per group; kdim picks how many (1/2/3).
                    for a in 0..kdim { tent_gpar[g][a] += dsol[goff + a]; }
                }
            }
            let mut tent_pts = pts.clone();
            for pi in 0..n_pts { for k in 0..3 { tent_pts[pi][k] += dp[pi][k]; } }

            let new_cost = robust_cost(&tent_cams, &tent_pts, &tent_gpar, dh);
            if new_cost < cost {
                cams = tent_cams;
                pts = tent_pts;
                gpar = tent_gpar;
                cost = new_cost;
                lambda = (lambda * 0.3).max(1e-9);
                accepted = true;
                break;
            } else {
                lambda = (lambda * 4.0).min(1e8);
            }
        }
        if !accepted { break; } // converged or stuck at this damping
        trace.push(rms(&cams, &pts, &gpar));
    }

    let cost_after = rms(&cams, &pts, &gpar);
    let anchor_rms_after = anchor_rms(&pts);
    let camera_prior_rms_after = camera_prior_rms(&cams);

    // Pack output: cameras (12 each), points (3 each), refined effective intrinsics
    // (7 each: fx,fy,cx,cy,k1,k2,k3 — radial coeffs 0 for the bits not in refine_mask),
    // [cost_before, cost_after, anchor_rms_after, camera_prior_rms_after], then trace.
    let mut out = Vec::with_capacity(n_cam * 12 + n_pts * 3 + n_cam * 7 + 4 + trace.len());
    for (r, t) in &cams {
        for row in r { for &v in row { out.push(v as f32); } }
        for &v in t { out.push(v as f32); }
    }
    for pt in &pts {
        for &v in pt { out.push(v as f32); }
    }
    for c in 0..n_cam {
        let (fx, fy, cx, cy, k1, k2, k3) = eff(c, &gpar);
        out.push(fx as f32); out.push(fy as f32); out.push(cx as f32); out.push(cy as f32);
        out.push(k1 as f32); out.push(k2 as f32); out.push(k3 as f32);
    }
    out.push(cost_before as f32);
    out.push(cost_after as f32);
    out.push(anchor_rms_after as f32);
    out.push(camera_prior_rms_after as f32);
    for &c in &trace { out.push(c as f32); }
    out
}
