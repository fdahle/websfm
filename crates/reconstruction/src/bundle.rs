// Sparse bundle adjustment: Levenberg–Marquardt with the Schur complement
// (points eliminated against the cameras) and adaptive Huber robustification.
use wasm_bindgen::prelude::*;
use crate::linalg::*;
use crate::par::{for_each_index, map_indexed, SyncPtr, CHUNK};

// The parts (bundle/): the linear algebra, the camera model, the Schur assembly helpers.
mod solve;
mod camera;
mod schur;
pub(crate) use solve::*;
pub(crate) use camera::*;
use schur::*;

// LM damping: its floor and cap, and how many tries one iteration may take to reach
// the cap (×4 each try, 31 from the floor). A step under PARAM_TOL of the model's size
// ends the run like a step rejected at the cap: past it nothing measurable changes
// (Ceres' parameter_tolerance).
const LAMBDA_MIN: f64 = 1e-9;
const LAMBDA_MAX: f64 = 1e8;
const LM_MAX_TRIES: usize = 32;
const PARAM_TOL: f64 = 1e-8;

// The LM stopping rule's floor when the direct solve runs (see bundle_adjust), and
// for a re-solve of an already converged model (`warm`).
pub(crate) const DIRECT_FUNCTION_TOL: f64 = 1e-5;
pub(crate) const WARM_FUNCTION_TOL: f64 = 1e-4;

// Phase timers for the native timing test (bundle_adjust_timing); no-ops in the app.
#[cfg(test)]
pub(crate) mod prof {
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;
    pub static T: [AtomicU64; 5] = [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)];
    thread_local! { static LAST: Cell<Option<Instant>> = const { Cell::new(None) }; }
    pub fn start() { LAST.with(|l| l.set(Some(Instant::now()))) }
    pub fn mark(i: usize) {
        LAST.with(|l| {
            let now = Instant::now();
            if let Some(t) = l.get() { T[i].fetch_add((now - t).as_micros() as u64, Ordering::Relaxed); }
            l.set(Some(now));
        })
    }
    pub fn take() -> [f64; 5] {
        let mut out = [0.0; 5];
        for (i, t) in T.iter().enumerate() { out[i] = t.swap(0, Ordering::Relaxed) as f64 / 1e6 }
        out
    }
}
#[cfg(not(test))]
pub(crate) mod prof {
    #[inline(always)] pub fn start() {}
    #[inline(always)] pub fn mark(_: usize) {}
}

/// Bundle adjustment by sparse Levenberg–Marquardt with the Schur complement.
///
/// Jointly refines every camera pose (6-DOF: left-perturbed so(3) rotation +
/// translation) and every 3D point, and — when `refine_mode > 0` — a small set of
/// shared per-sensor intrinsic parameters (self-calibration). Points are always
/// eliminated by the Schur complement; the reduced system holds the camera poses
/// plus the intrinsic groups, stored block-sparse (a camera couples only with the
/// cameras it shares points with) and solved by block-Jacobi PCG when large, dense
/// Cholesky when small (`solve_reduced_with`, `DENSE_MAX_N`). Huber robustification (an
/// adaptive threshold tracking the residual median) keeps surviving gross
/// mis-triangulations from dragging the solution.
///
/// Intrinsic self-calibration is opt-in and modest: each sensor group carries a
/// focal **scale** `s` (init 1, multiplying every member camera's fx/fy) and,
/// for `refine_mode == 2`, shared principal-point offsets `dcx, dcy`. Modelling
/// the focal as a scale (not an absolute) preserves any per-camera differences in
/// the seed intrinsics while still sharing one degree of freedom across the group.
///
/// GCP support: `anchor_flat`/`anchor_weight` optionally pull specific 3D points
/// toward a known target position (e.g. a GCP triangulated in this same SfM
/// frame) with an extra quadratic residual `Σ_axis w_axis·(pt − target)²`. This only ever
/// touches that point's own 3×3 block (gradient + diagonal Hessian) — no camera
/// Jacobian, no new coupling — so it folds into the existing per-point Schur
/// elimination for free. Empty anchor arrays reduce to today's behaviour exactly.
/// Camera-pose support: `camera_prior_flat` optionally pulls camera centres
/// `C = -R^T t` and rotations toward known poses in this same SfM frame. Position
/// rows carry a full 3×3 precision matrix in solver axes: the survey's per-axis σ
/// (E, N, Up) rotated into the SfM frame, `s²·Rᵀ·diag(1/σ²)·R`, so a vertical σ stays
/// vertical whatever pair seeded the model. Orientation uses
/// the tangent residual `Log(R R_target^T)` and a full 3×3 precision matrix,
/// allowing the caller to transform per-OPK uncertainties into solver axes.
///
/// # Inputs
/// - `cameras_flat`: n_cam × 12 floats `[R(9)|t(3), …]`
/// - `intrinsics_flat`: n_cam × 4 floats `[fx,fy,cx,cy, …]` (the seed / base K)
/// - `pts_flat`: n_pts × 3 floats `[x,y,z, …]`
/// - `obs_index`: n_obs × 2 u32 `[cam_i, pt_i, …]` and `obs_px`: n_obs × 2 floats
///   `[pixel_x, pixel_y, …]`. Indices are integers on purpose: as f32 they were exact
///   only to 2²⁴, so above 16.7 M points observations silently attached to the wrong
///   point (TODO ▸ SC-6).
/// - `anchor_flat`: n_anchor × 4 doubles `[pt_i, target_x, target_y, target_z, …]`
/// - `observation_weight`: n_obs × 2 inverse-variance pixel weights (X/Y);
///   tie points use one detection pixel (1/f², baObservations.js tieWeightOf), GCP
///   marks their declared pixel variances
/// - `anchor_weight`: n_anchor × 9 floats, row-major 3×3 precision matrices
/// - `camera_prior_flat`: n_prior × 31 floats
///   `[cam_i, target_x, target_y, target_z, position_precision(9),
///     target_R(9), orientation_precision(9), …]`, matrices row-major. An all-zero
///   orientation precision matrix makes the row position-only.
/// - `max_iters`: outer LM iterations
/// - `sensor_of_cam`: n_cam ints — per-camera sensor id (shared → shared focal);
///   `< 0` (or a short/empty list) ⇒ that camera is its own group
/// - `refine_mask`: **bitmask** of the shared per-sensor intrinsics to self-calibrate:
///   1 = focal scale s, 2 = principal point (dcx,dcy), 4 = radial k1, 8 = k2, 16 = k3,
///   32 = k4 (fisheye only). 0 ⇒ poses+points only. The per-group param vector is the
///   ordered subset `[s?, dcx?, dcy?, k1?, k2?, k3?, k4?, τ?]` (kdim ≤ 8; τ: bundle_adjust_rs). fy stays locked
///   to fx (single scale). A coefficient a group's lens does not have (k4 on a Brown
///   group, k3 on a two-term fisheye) is held at its seed.
/// - `fixed_cam`: n_cam bytes, non-zero ⇒ that camera's pose is held fixed (local BA:
///   the cameras outside the window keep their observations as constraints but are
///   not variables). Empty ⇒ every camera is free, the original behaviour exactly.
/// - `solver_flat`: solver policy `[pcg_min_n, rel_tol, max_iter, accept_partial,
///   function_tol, precond, direct, warm, huber]`; empty / NaN slots ⇒
///   `SolverOpts::DEFAULT` (see there).
/// - `fisheye_flat`: n_cam × 5 floats `[terms, k1, k2, k3, k4, …]`. `terms` 0 ⇒ the
///   camera is pinhole (+ the Brown self-cal residual) and its observations are in the
///   undistorted frame; its k1…k3 slots seed that residual (the app passes zeros; the
///   BAL bench, examples/bal.rs, the problems' own k1, k2); `terms` 1–4 ⇒ a Kannala–Brandt fisheye with those seed
///   coefficients, observed in the pixels the lens recorded, of which the first `terms`
///   may be self-calibrated (the k bits then refine the fisheye's own polynomial).
///   Cameras sharing a sensor group must share a lens. Empty ⇒ every camera pinhole,
///   the original behaviour exactly.
///
/// # Output
/// `[cameras_flat(n_cam×12), pts_flat(n_pts×3), intrinsics_flat(n_cam×8),
///   cost_before, cost_after, anchor_rms_after, camera_prior_rms_after,
///   solver stats (BA_STATS_LEN), cost_trace…]` — the returned
/// intrinsics are the **refined** effective K per camera as `[fx,fy,cx,cy,k1,k2,k3,k4]`
/// — for a pinhole camera the self-calibrated Brown residual (0 for the bits not set
/// in `refine_mask`, k4 always 0), for a fisheye camera its full refined Kannala–Brandt
/// coefficients (the seed when nothing was refined); cost_before/cost_after are RMS reprojection error in
/// pixels (anchors do not affect them); anchor_rms_after is the RMS anchor
/// residual in the caller's world units, and camera_prior_rms_after is the RMS
/// camera-centre residual (both 0 when their respective prior list is empty).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn bundle_adjust(
    cameras_flat: &[f32], intrinsics_flat: &[f32], pts_flat: &[f32], obs_index: &[u32], obs_px: &[f32],
    observation_weight: &[f32], anchor_flat: &[f64], anchor_weight: &[f32], camera_prior_flat: &[f32],
    max_iters: u32, sensor_of_cam: &[i32], refine_mask: u32, solver_flat: &[f32], fixed_cam: &[u8],
    fisheye_flat: &[f32],
) -> Vec<f32> {
    bundle_adjust_impl(cameras_flat, intrinsics_flat, pts_flat, obs_index, obs_px, observation_weight, anchor_flat,
        anchor_weight, camera_prior_flat, max_iters, sensor_of_cam, refine_mask, solver_flat, fixed_cam, fisheye_flat, &[],
        &[], &[])
}

/// `bundle_adjust` with a rolling-shutter model (rsh, plan-after-0.7 ▸ RSH). A camera
/// whose rows are read one after another over the readout time τ sees each row from
/// a slightly different place: from C + τ·s·v, where v is the camera centre's velocity
/// (model units per second) and s = (row − cy)/H the row's time from the principal row
/// as a fraction of the readout. The solver takes the observed row for s (exact to
/// first order) and applies the shift to the point instead: x_cam = R·(X − τ·s·v) + t,
/// so the pose and point Jacobians keep their form and τ adds one column, −s·R·v.
/// The pose is the one at the principal row (what the camera-centre priors constrain).
///
/// - `rs_flat`: n_cam × 5 floats `[vx, vy, vz, H, τ0, …]`; H ≤ 0 (or a short list) ⇒
///   that camera reads all rows at once. τ0 is the readout time in seconds; with refine
///   bit 64 the group's τ is refined from its first camera's τ0 (the slot follows k4).
///
/// Output: `bundle_adjust`'s, with n_cam floats — each camera's τ after the solve —
/// between the solver stats and the cost trace.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn bundle_adjust_rs(
    cameras_flat: &[f32], intrinsics_flat: &[f32], pts_flat: &[f32], obs_index: &[u32], obs_px: &[f32],
    observation_weight: &[f32], anchor_flat: &[f64], anchor_weight: &[f32], camera_prior_flat: &[f32],
    max_iters: u32, sensor_of_cam: &[i32], refine_mask: u32, solver_flat: &[f32], fixed_cam: &[u8],
    fisheye_flat: &[f32], rs_flat: &[f32],
) -> Vec<f32> {
    bundle_adjust_impl(cameras_flat, intrinsics_flat, pts_flat, obs_index, obs_px, observation_weight, anchor_flat,
        anchor_weight, camera_prior_flat, max_iters, sensor_of_cam, refine_mask, solver_flat, fixed_cam, fisheye_flat, rs_flat,
        &[], &[])
}

/// `bundle_adjust_rs` for the cameras of a rig (plan-after-0.7 ▸ MSP-1): a multispectral
/// camera's lenses, triggered together. The photos of one capture share one pose, the
/// capture's (its reference lens's), and each lens sees from a fixed offset to it:
/// x_cam = R_o·(R_c·X + t_c) + t_o, the offset the same for every capture. The solver
/// keeps one pose block per capture; with refine bit 128 each sensor group's offset
/// rotation is refined (three slots after τ, ω: R_o = Exp(ω)·R_o⁰), its lever arm t_o
/// kept (a few centimetres, too short to resolve from the photos). A group none of
/// whose cameras has an offset (the reference lens, or photos outside the rig) has no ω.
///
/// - `capture_of_cam`: n_cam ints; cameras with the same non-negative value share a pose
///   block, a negative value (or a short list) is a pose of its own.
/// - `offset_flat`: n_cam × 13 floats `[has, R_o(9), t_o(3), …]`; `has` 0 (or a short
///   list) ⇒ no offset: the camera's pose is its capture's.
///
/// A capture's pose starts from a camera without an offset where it has one, else from
/// its first camera with the offset taken off; it is held fixed only when every camera
/// in it is. A camera-centre prior acts on the capture's pose: give one per capture.
/// Output: `bundle_adjust_rs`'s, each camera's pose being its composed pose.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn bundle_adjust_rig(
    cameras_flat: &[f32], intrinsics_flat: &[f32], pts_flat: &[f32], obs_index: &[u32], obs_px: &[f32],
    observation_weight: &[f32], anchor_flat: &[f64], anchor_weight: &[f32], camera_prior_flat: &[f32],
    max_iters: u32, sensor_of_cam: &[i32], refine_mask: u32, solver_flat: &[f32], fixed_cam: &[u8],
    fisheye_flat: &[f32], rs_flat: &[f32], capture_of_cam: &[i32], offset_flat: &[f32],
) -> Vec<f32> {
    bundle_adjust_impl(cameras_flat, intrinsics_flat, pts_flat, obs_index, obs_px, observation_weight, anchor_flat,
        anchor_weight, camera_prior_flat, max_iters, sensor_of_cam, refine_mask, solver_flat, fixed_cam, fisheye_flat, rs_flat,
        capture_of_cam, offset_flat)
}

#[allow(clippy::too_many_arguments)]
fn bundle_adjust_impl(
    cameras_flat: &[f32],
    intrinsics_flat: &[f32],
    pts_flat: &[f32],
    obs_index: &[u32],
    obs_px: &[f32],
    observation_weight: &[f32],
    anchor_flat: &[f64],
    anchor_weight: &[f32],
    camera_prior_flat: &[f32],
    max_iters: u32,
    sensor_of_cam: &[i32],
    refine_mask: u32,
    solver_flat: &[f32],
    fixed_cam: &[u8],
    fisheye_flat: &[f32],
    rs_flat: &[f32],
    capture_of_cam: &[i32],
    offset_flat: &[f32],
) -> Vec<f32> {
    let n_cam = cameras_flat.len() / 12;
    let n_pts = pts_flat.len() / 3;
    let n_obs = (obs_index.len() / 2).min(obs_px.len() / 2);
    if n_cam == 0 || n_pts == 0 || n_obs == 0 { return vec![]; }

    // Rig (bundle_adjust_rig): each camera's pose block and lens offset. Without one,
    // block c is camera c and no offset is composed: the plain solve, bit for bit.
    let off: Vec<Option<(M3, V3)>> = (0..n_cam).map(|c| {
        let b = c * 13;
        if offset_flat.len() < b + 13 || !(offset_flat[b] > 0.5) { return None; }
        let v = |i: usize| offset_flat[b + i] as f64;
        let r: M3 = [[v(1), v(2), v(3)], [v(4), v(5), v(6)], [v(7), v(8), v(9)]];
        let t: V3 = [v(10), v(11), v(12)];
        if r.iter().flatten().chain(t.iter()).any(|x| !x.is_finite()) { return None; }
        Some((r, t))
    }).collect();
    let (pb, n_pb) = {
        let mut map: std::collections::HashMap<i32, usize> = std::collections::HashMap::new();
        let mut pb = vec![0usize; n_cam];
        let mut next = 0usize;
        for c in 0..n_cam {
            let id = capture_of_cam.get(c).copied().unwrap_or(-1);
            pb[c] = if id < 0 { next += 1; next - 1 } else { *map.entry(id).or_insert_with(|| { next += 1; next - 1 }) };
        }
        (pb, next)
    };

    // Anchors: (point_idx, target position, per-axis weights). Points outside range are
    // dropped rather than panicking on a malformed caller payload.
    let n_anchor = anchor_flat.len() / 4;
    let anchors: Vec<(usize, V3, M3)> = (0..n_anchor).filter_map(|i| {
        let b = i * 4;
        let pi = anchor_flat[b] as usize;
        let target: V3 = [anchor_flat[b+1], anchor_flat[b+2], anchor_flat[b+3]];
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
    let n_camera_prior = camera_prior_flat.len() / 31;
    let camera_priors: Vec<(usize, V3, M3, Option<(M3, M3)>)> = (0..n_camera_prior).filter_map(|i| {
        let b = i * 31;
        let ci = camera_prior_flat[b] as usize;
        let target = [camera_prior_flat[b+1] as f64, camera_prior_flat[b+2] as f64,
                      camera_prior_flat[b+3] as f64];
        let mut weight: M3 = [0,1,2].map(|row| [0,1,2].map(|col|
            camera_prior_flat[b + 4 + 3*row + col] as f64));
        for row in 0..3 { for col in (row+1)..3 {
            let v = 0.5 * (weight[row][col] + weight[col][row]);
            weight[row][col] = v; weight[col][row] = v;
        }}
        let wdet2 = weight[0][0]*weight[1][1] - weight[0][1]*weight[1][0];
        if ci >= n_cam || target.iter().any(|v| !v.is_finite())
            || weight.iter().flatten().any(|v| !v.is_finite())
            || !(weight[0][0] > 0.0 && wdet2 > 0.0 && det3(&weight) > 0.0) { return None; }
        let target_r: M3 = [0,1,2].map(|row| [0,1,2].map(|col|
            camera_prior_flat[b + 13 + 3*row + col] as f64));
        let mut precision: M3 = [0,1,2].map(|row| [0,1,2].map(|col|
            camera_prior_flat[b + 22 + 3*row + col] as f64));
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
        // On the camera's pose block: a capture's prior moves the capture.
        Some((pb[ci], target, weight, orientation))
    }).collect();

    // Unpack cameras / base intrinsics / points / observations.
    let cams_in: Vec<(M3, V3)> = (0..n_cam).map(|c| {
        let b = c * 12;
        let r: M3 = [[cameras_flat[b]   as f64, cameras_flat[b+1] as f64, cameras_flat[b+2]  as f64],
                     [cameras_flat[b+3] as f64, cameras_flat[b+4] as f64, cameras_flat[b+5]  as f64],
                     [cameras_flat[b+6] as f64, cameras_flat[b+7] as f64, cameras_flat[b+8]  as f64]];
        let t: V3 = [cameras_flat[b+9] as f64, cameras_flat[b+10] as f64, cameras_flat[b+11] as f64];
        (r, t)
    }).collect();
    // One pose per block: a capture starts from a camera without an offset where it has
    // one, else from its first camera with the offset taken off (R_c = R_oᵀ·R,
    // t_c = R_oᵀ·(t − t_o)).
    let mut cams: Vec<(M3, V3)> = vec![([[0.0; 3]; 3], [0.0; 3]); n_pb];
    { let mut seeded = vec![0u8; n_pb];
      for c in 0..n_cam {
          let rank = if off[c].is_none() { 2 } else { 1 };
          if seeded[pb[c]] >= rank { continue; }
          seeded[pb[c]] = rank;
          let (r, t) = cams_in[c];
          cams[pb[c]] = match off[c] {
              None => (r, t),
              Some((ro, to)) => {
                  let rot = mat3_transpose(&ro);
                  (mat3_mul(&rot, &r), mat3_vec(&rot, &[t[0] - to[0], t[1] - to[1], t[2] - to[2]]))
              }
          };
      } }
    // Base (seed) intrinsics — held fixed; refinement is expressed relative to these.
    let ks: Vec<(f64, f64, f64, f64)> = (0..n_cam).map(|c| {
        let b = c * 4;
        (intrinsics_flat[b] as f64, intrinsics_flat[b+1] as f64,
         intrinsics_flat[b+2] as f64, intrinsics_flat[b+3] as f64)
    }).collect();
    // Per-camera lens: (refinable fisheye terms, seed coefficients, Brown p1/p2). terms 0
    // ⇒ Brown (pinhole when every coefficient is 0). `fisheye_flat` has 5 floats a camera,
    // or 7 with the decentring pair (`lens_stride`); a 7-float list also returns p1/p2.
    let lens_stride = if n_cam > 0 && fisheye_flat.len() >= n_cam * 7 { 7 } else { 5 };
    let lens: Vec<(usize, [f64; 4], [f64; 2])> = (0..n_cam).map(|c| {
        let b = c * lens_stride;
        let val = |j: usize| -> f64 {
            let v = fisheye_flat.get(b + j).copied().unwrap_or(0.0) as f64;
            if v.is_finite() { v } else { 0.0 }
        };
        let terms = fisheye_flat.get(b).copied().unwrap_or(0.0);
        let k = [1, 2, 3, 4].map(val);
        let p = if lens_stride == 7 { [val(5), val(6)] } else { [0.0; 2] };
        // A Brown camera's slots seed its k1…k3 and p1/p2.
        if !(terms >= 1.0) { return (0, [k[0], k[1], k[2], 0.0], p); }
        ((terms as usize).min(4), k, [0.0; 2])
    }).collect();
    // Rolling shutter per camera: (velocity, frame height, seed readout time), or None.
    let rs: Vec<Option<(V3, f64, f64)>> = (0..n_cam).map(|c| {
        let b = c * 5;
        let h = rs_flat.get(b + 3).copied().unwrap_or(0.0) as f64;
        if !(h > 0.0) { return None; }
        let v = [0, 1, 2].map(|j| rs_flat.get(b + j).copied().unwrap_or(0.0) as f64);
        let tau0 = rs_flat.get(b + 4).copied().unwrap_or(0.0) as f64;
        if v.iter().any(|x| !x.is_finite()) || !tau0.is_finite() { return None; }
        Some((v, h, tau0))
    }).collect();
    let rs_any = rs.iter().any(|r| r.is_some());
    let mut pts: Vec<V3> = (0..n_pts).map(|i| {
        [pts_flat[i*3] as f64, pts_flat[i*3+1] as f64, pts_flat[i*3+2] as f64]
    }).collect();
    // (camera, point, u, v, weight u, weight v), kept as the caller gave them (u32, f32):
    // 24 bytes an observation instead of 40 (48 natively) in f64 and usize. `ob` reads one
    // back widened.
    let obs: Vec<(u32, u32, f32, f32, f32, f32)> = (0..n_obs).map(|i| {
        let b = i * 2;
        let wx = observation_weight.get(b).copied().unwrap_or(1.0);
        let wy = observation_weight.get(b + 1).copied().unwrap_or(1.0);
        (obs_index[b], obs_index[b + 1], obs_px[b], obs_px[b + 1],
         if wx.is_finite() && wx > 0.0 { wx } else { 1.0 }, if wy.is_finite() && wy > 0.0 { wy } else { 1.0 })
    }).filter(|&(ci, pi, _, _, _, _)| (ci as usize) < n_cam && (pi as usize) < n_pts).collect();
    let ob = |o: usize| -> (usize, usize, f64, f64, f64, f64) {
        let (ci, pi, u, v, wx, wy) = obs[o];
        (ci as usize, pi as usize, u as f64, v as f64, wx as f64, wy as f64)
    };

    // Per-point observations as indices into `obs`, in `obs` order (CSR) — the
    // structure the Schur reduction iterates.
    let (pt_start, pt_obs) = csr(n_pts, obs.iter().map(|o| o.1 as usize));

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
            let d = [c[0] - target[0], c[1] - target[1], c[2] - target[2]];
            let position = dot3(&d, &mat3_vec(&weight, &d));
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
    // `refine_mask` is a bitmask (1=f, 2=cxcy, 4=k1, 8=k2, 16=k3, 32=k4, 256=p1,p2). The
    // per-group param vector is the ordered subset [s?, dcx?, dcy?, k1?, k2?, k3?, k4?,
    // p1?, p2?, τ?, ω?]; `idx_*` is each param's slot in that vector (−1 when its bit is
    // clear). kdim ≤ BLK_MAX (64 = τ, bundle_adjust_rs; 128 = ω, bundle_adjust_rig).
    let has_f = refine_mask & 1 != 0;
    let has_cxcy = refine_mask & 2 != 0;
    let has_k1 = refine_mask & 4 != 0;
    let has_k2 = refine_mask & 8 != 0;
    let has_k3 = refine_mask & 16 != 0;
    let has_k4 = refine_mask & 32 != 0;
    let has_p = refine_mask & 256 != 0;
    let has_rs = refine_mask & 64 != 0 && rs_any;
    let has_rig = refine_mask & 128 != 0 && off.iter().any(|o| o.is_some());
    let mut kdim = 0usize;
    let mut alloc = |on: bool| -> isize { if on { let i = kdim as isize; kdim += 1; i } else { -1 } };
    let idx_s   = alloc(has_f);
    let idx_dcx = alloc(has_cxcy);
    let idx_dcy = alloc(has_cxcy);
    let idx_k1  = alloc(has_k1);
    let idx_k2  = alloc(has_k2);
    let idx_k3  = alloc(has_k3);
    let idx_k4  = alloc(has_k4);
    let idx_p1  = alloc(has_p);
    let idx_p2  = alloc(has_p);
    let idx_rs  = alloc(has_rs);
    // The offset rotation ω: three consecutive slots.
    let idx_rig = alloc(has_rig); alloc(has_rig); alloc(has_rig);
    let idx_k = [idx_k1, idx_k2, idx_k3, idx_k4];
    let (grp, g_count) = if kdim > 0 { build_groups(sensor_of_cam, n_cam) } else { (vec![0usize; n_cam], 0) };
    let refine = kdim > 0 && g_count > 0;
    // Each group's lens (its first camera's — a sensor group shares one), and which
    // of its k slots exist: k1–k3 for Brown, the first `terms` for a fisheye.
    let mut group_lens: Vec<(usize, [f64; 4], [f64; 2])> = vec![(0, [0.0; 4], [0.0; 2]); g_count];
    { let mut seen = vec![false; g_count];
      for c in 0..n_cam { if refine && !seen[grp[c]] { seen[grp[c]] = true; group_lens[grp[c]] = lens[c]; } } }
    // Each group's seed readout time (its first rolling-shutter camera's τ0).
    let mut group_tau0 = vec![0.0f64; g_count];
    { let mut seen = vec![false; g_count];
      for c in 0..n_cam { if refine && !seen[grp[c]] { if let Some((_, _, t0)) = rs[c] { seen[grp[c]] = true; group_tau0[grp[c]] = t0; } } } }
    // Which groups have a lens offset to refine (the others' ω slots are pinned).
    let mut group_has_off = vec![false; g_count];
    for c in 0..n_cam { if refine && off[c].is_some() { group_has_off[grp[c]] = true; } }
    let k_live = |g: usize, j: usize| -> bool {
        let terms = group_lens[g].0;
        if terms == 0 { j < 3 } else { j < terms }
    };
    // The decentring pair is Brown's: a fisheye group has none.
    let p_live = |g: usize| -> bool { group_lens[g].0 == 0 };
    // Reduced slot of each free camera (fixed ones have none); with no fixed camera the
    // slot is the camera index, so the system is exactly the all-free one.
    const FIXED: usize = usize::MAX;
    // (Slots and `free_cams` are per pose block; a block is fixed when all its cameras are.)
    let mut slot = vec![FIXED; n_pb];
    let mut free_cams: Vec<usize> = Vec::with_capacity(n_pb);
    let mut block_free = vec![false; n_pb];
    for c in 0..n_cam { if fixed_cam.get(c).copied().unwrap_or(0) == 0 { block_free[pb[c]] = true; } }
    for b in 0..n_pb {
        if block_free[b] { slot[b] = free_cams.len(); free_cams.push(b); }
    }
    let n_free = free_cams.len();
    let group_off = 6 * n_free;           // intrinsic params follow the camera poses
    let n = group_off + if refine { g_count * kdim } else { 0 };
    let n_groups = if refine { g_count } else { 0 };
    // The reduced system's sparsity: camera c couples with every camera that shares a
    // point with it, and with those cameras' intrinsics groups; a group with whatever
    // its cameras couple with. Built once, the observations do not change. Uncoupled
    // (`coupled` false) it is B's alone, the reduced variables before the points are
    // eliminated: a camera with its own group, a group with its cameras (the implicit
    // solve keeps only that).
    let build_pattern = |coupled: bool| {
        let (cam_start, cam_obs) = csr(n_cam, obs.iter().map(|o| o.0 as usize));
        let (grp_start, grp_cams) = csr(n_groups, (0..if refine { n_cam } else { 0 }).map(|c| grp[c]));
        let (blk_start, blk_cams) = csr(n_pb, (0..n_cam).map(|c| pb[c]));
        let mut dims = vec![6usize; n_free];
        dims.extend(std::iter::repeat(kdim).take(n_groups));
        BlockPattern::new(dims, |r, touch| {
            let visit = |c: usize, touch: &mut dyn FnMut(usize)| {
                if n_groups > 0 { touch(n_free + grp[c]); }
                if !coupled {
                    if slot[pb[c]] != FIXED { touch(slot[pb[c]]); }
                    return;
                }
                for k in cam_start[c]..cam_start[c + 1] {
                    let p = obs[cam_obs[k as usize] as usize].1 as usize;
                    for q in pt_start[p]..pt_start[p + 1] {
                        let c2 = obs[pt_obs[q as usize] as usize].0 as usize;
                        if slot[pb[c2]] != FIXED { touch(slot[pb[c2]]); }
                        if n_groups > 0 { touch(n_free + grp[c2]); }
                    }
                }
            };
            if r < n_free {
                let b = free_cams[r];
                for k in blk_start[b]..blk_start[b + 1] { visit(blk_cams[k as usize] as usize, &mut *touch); }
            }
            else { for k in grp_start[r - n_free]..grp_start[r - n_free + 1] { visit(grp_cams[k as usize] as usize, &mut *touch); } }
        })
    };
    let mut pattern = build_pattern(true);
    let solver = SolverOpts::from_flat(solver_flat);
    let mut solve_stats = SolveStats::default();
    // The sparse direct solve's ordering, once for every LM iteration of this call, when
    // the direct solve fits the memory (`direct_bytes`, solver slot 10): the ordering is
    // given what is left once the reduced matrix and the per-observation and per-point
    // data are counted, and gives up past it. Otherwise the reduced matrix is never
    // stored (`implicit`): on a dense camera graph S alone outgrows wasm32 (BAL
    // final-1936, 1,936 cameras that nearly all see each other: 2.2 GB, held twice).
    let large = pattern.n >= solver.pcg_min_n || pattern.n > DENSE_MAX_N;
    let (direct, implicit) = if solver.direct == 2 && large { (None, true) }
    else if solver.direct == 1 && large {
        let room = solver.memory.saturating_sub(direct_bytes(pattern.n_vals, 0, 0, obs.len(), n_pts));
        // The factor and the group partials share one buffer: each must fit the room.
        let parts = 8 * range_parts_len(&pattern, n_free) as u64;
        let max_blocks = (room / (8 * 36)).min(usize::MAX as u64) as usize;
        let sym = if max_blocks == 0 || parts > room { None } else {
            crate::sparse_chol::Symbolic::new(&pattern, max_blocks).filter(|sym| sym.factor_bytes() as u64 <= room)
        };
        let implicit = sym.is_none();
        (sym, implicit)
    } else { (None, false) };
    if implicit { pattern = build_pattern(false); }
    // Exact steps keep finding improvements of a few 10⁻⁶ of the cost long after the
    // model has stopped changing (1,600 aerial cameras: all 30 iterations ran, RMS
    // 0.46 px from the 13th on); a 10⁻⁵ stop ends them with the same final model.
    // A re-solve of a converged model after a filter or a retriangulation (`warm`)
    // stops at 10⁻⁴: quarry the same RTK camera error, South Building the same
    // residuals. Not every solve: interim solves stopped that early hand the first
    // global BA a model it then needs 44 instead of 25 solves for (1,600 cameras).
    // Only where the direct solve runs: an inexact PCG step needs the tighter rule.
    let function_tol = match direct {
        Some(_) => solver.function_tol.max(if solver.warm != 0 { WARM_FUNCTION_TOL } else { DIRECT_FUNCTION_TOL }),
        None => solver.function_tol,
    };
    // The direct solve reads the lower triangle only (sparse_chol.rs `factor`).
    let lower_only = direct.is_some();
    // With it, the Schur elimination visits the points grouped by their first camera, so
    // consecutive points write nearby blocks of S (21 MB at 1,600 cameras: scattered
    // writes were the cost). The full-matrix paths keep the index order (and their bits).
    let schur_order: Vec<usize> = if lower_only {
        let mut key: Vec<(usize, usize)> = (0..n_pts).map(|p| {
            ((pt_start[p] as usize..pt_start[p + 1] as usize).map(|q| pb[obs[pt_obs[q] as usize].0 as usize]).min().unwrap_or(usize::MAX), p)
        }).collect();
        key.sort_unstable();
        key.into_iter().map(|(_, p)| p).collect()
    } else { (0..n_pts).collect() };
    // How the lower-triangle Schur step splits over threads (RangePlan). Only there:
    // the full-matrix paths keep their single loop.
    let range_plan = if lower_only { Some(RangePlan::new(&pattern, n_free, &schur_order, |p, visit: &mut dyn FnMut(usize)| {
        for q in pt_start[p] as usize..pt_start[p + 1] as usize {
            let sl = slot[pb[obs[pt_obs[q] as usize].0 as usize]];
            if sl != FIXED { visit(sl); }
        }
    })) } else { None };
    // Per-group params, one [f64;7] slot each. The focal-scale slot (if present) inits
    // to 1 (multiplies fx/fy); every distortion/principal-point slot inits to 0 — a
    // fisheye group's k slots are offsets from its seed coefficients.
    let mut gpar = vec![[0.0f64; BLK_MAX]; g_count.max(1)];
    if idx_s >= 0 { for g in gpar.iter_mut() { g[idx_s as usize] = 1.0; } }

    // Effective K + lens coefficients (k1..k4) and whether the camera is a fisheye,
    // under the current group params. Pinhole: the Brown residual; fisheye: seed + offset.
    struct Eff { fx: f64, fy: f64, cx: f64, cy: f64, k: [f64; 4], p: [f64; 2], fisheye: bool }
    let eff = |ci: usize, gpar: &Vec<[f64; BLK_MAX]>| -> Eff {
        let (fx0, fy0, cx0, cy0) = ks[ci];
        let (terms, k0, p0) = lens[ci];
        let fisheye = terms > 0;
        if !refine { return Eff { fx: fx0, fy: fy0, cx: cx0, cy: cy0, k: k0, p: p0, fisheye }; }
        let g = gpar[grp[ci]];
        let get = |idx: isize| -> f64 { if idx >= 0 { g[idx as usize] } else { 0.0 } };
        let s = if idx_s >= 0 { g[idx_s as usize] } else { 1.0 };
        let k = [0, 1, 2, 3].map(|j| k0[j] + get(idx_k[j]));
        let p = if fisheye { [0.0; 2] } else { [p0[0] + get(idx_p1), p0[1] + get(idx_p2)] };
        Eff { fx: s * fx0, fy: s * fy0, cx: cx0 + get(idx_dcx), cy: cy0 + get(idx_dcy), k, p, fisheye }
    };
    // A camera's readout time under the current group params (0 without rolling shutter).
    let tau_of = |ci: usize, gpar: &Vec<[f64; BLK_MAX]>| -> f64 {
        match rs[ci] {
            None => 0.0,
            Some((_, _, t0)) => if idx_rs >= 0 && refine { group_tau0[grp[ci]] + gpar[grp[ci]][idx_rs as usize] } else { t0 },
        }
    };
    // A camera's lens offset under the current group params, (Exp(ω)·R_o, t_o), or None.
    let offset_rot = |ci: usize, gpar: &Vec<[f64; BLK_MAX]>| -> Option<(M3, V3)> {
        let (ro, to) = off[ci]?;
        if idx_rig >= 0 && refine {
            let (p, i) = (gpar[grp[ci]], idx_rig as usize);
            Some((mat3_mul(&so3_exp(&[p[i], p[i + 1], p[i + 2]]), &ro), to))
        } else { Some((ro, to)) }
    };
    // A camera's pose: its capture's, composed with its offset when it has one.
    let pose_of = |ci: usize, cams: &Vec<(M3, V3)>, gpar: &Vec<[f64; BLK_MAX]>| -> (M3, V3) {
        let (r, t) = cams[pb[ci]];
        match offset_rot(ci, gpar) {
            None => (r, t),
            Some((ro, to)) => {
                let rt = mat3_vec(&ro, &t);
                (mat3_mul(&ro, &r), [rt[0] + to[0], rt[1] + to[1], rt[2] + to[2]])
            }
        }
    };
    // The point an observation sees: X − τ·s·v (rolling shutter), or X itself, and the
    // shift direction −s·v (for τ's Jacobian).
    let seen_point = |o: usize, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>| -> (V3, V3) {
        let (ci, pi, _, oy, _, _) = ob(o);
        match rs[ci] {
            None => (pts[pi], [0.0; 3]),
            Some((v, h, _)) => {
                let s = (oy - ks[ci].3) / h;
                let tau = tau_of(ci, gpar);
                let x = pts[pi];
                ([x[0] - tau * s * v[0], x[1] - tau * s * v[1], x[2] - tau * s * v[2]], [-s * v[0], -s * v[1], -s * v[2]])
            }
        }
    };

    // Plain RMS reprojection error over all observations (reported to the caller).
    // The per-observation loops below run on the pool (par.rs map_indexed) and are summed
    // here in observation order, so they give the plain loop's bits.
    // One observation's squared reprojection error, NaN when it projects nowhere.
    let sq_err = |o: usize, cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>| -> f64 {
        let (ci, pi, ox, oy, _, _) = ob(o);
        let pose = pose_of(ci, cams, gpar);
        let (r, t) = &pose;
        let e = eff(ci, gpar);
        let x = if rs_any { seen_point(o, pts, gpar).0 } else { pts[pi] };
        let (px, py) = project_full(r, t, e.fx, e.fy, e.cx, e.cy, &e.k, &e.p, e.fisheye, &x);
        if px.is_nan() { f64::NAN } else { (px - ox).powi(2) + (py - oy).powi(2) }
    };
    let rms = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>| -> f64 {
        let mut sse = 0.0f64; let mut cnt = 0usize;
        for v in map_indexed(obs.len(), |o| sq_err(o, cams, pts, gpar)) {
            if v.is_nan() { continue; }
            sse += v; cnt += 1;
        }
        if cnt == 0 { 0.0 } else { (sse / cnt as f64).sqrt() }
    };

    // Huber-robustified cost Σ ρ(‖r‖) at pixel threshold δ, plus the (unrobustified,
    // quadratic) GCP anchor term — same total objective the LM step below descends.
    let robust_cost = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>, dh: f64| -> f64 {
        let terms = map_indexed(obs.len(), |o| {
            let (ci, pi, ox, oy, wx, wy) = ob(o);
            let pose = pose_of(ci, cams, gpar);
            let (r, t) = &pose;
            let e = eff(ci, gpar);
            let x = if rs_any { seen_point(o, pts, gpar).0 } else { pts[pi] };
            let (px, py) = project_full(r, t, e.fx, e.fy, e.cx, e.cy, &e.k, &e.p, e.fisheye, &x);
            if px.is_nan() { return dh * dh; }
            let dx=px-ox; let dy=py-oy; let e=(dx*dx+dy*dy).sqrt();
            // The Huber loss the IRLS weight r = δ/e actually descends: ρ = q·(2r − r²)
            // (= 2δe − δ² for unit weights), continuous with q at e = δ. Evaluating
            // r·q (= δe) instead halved the outlier slope relative to the step model
            // and the anchor/prior terms, so step acceptance judged a different cost.
            let q = wx*dx*dx + wy*dy*dy;
            if e <= dh { q } else { let r = dh/e; q * (2.0*r - r*r) }
        });
        let mut sum = 0.0f64;
        for v in terms { sum += v; }
        sum + anchor_sse(pts) + camera_prior_sse(cams)
    };

    // Adaptive Huber threshold: a multiple of the residual median, so it tracks the
    // noise floor as the model tightens. Recomputed once per outer iteration.
    let huber_threshold = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>| -> f64 {
        let mut es: Vec<f64> = map_indexed(obs.len(), |o| sq_err(o, cams, pts, gpar).sqrt());
        es.retain(|v| !v.is_nan());
        if es.is_empty() { return 1.0; }
        // The median by selection: the same element a full sort puts there.
        let mid = es.len() / 2;
        let (_, m, _) = es.select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
        (2.5 * *m).max(1.0)
    };
    // SolverOpts::huber: a fixed threshold, or none (a δ no residual reaches: an
    // observation on the camera plane still costs δ², finite).
    let huber_threshold = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>| -> f64 {
        match solver.huber {
            Some(d) if d > 0.0 => d,
            Some(_) => NO_LOSS_DELTA,
            None => huber_threshold(cams, pts, gpar),
        }
    };

    // One observation linearised at the given state: its residual, IRLS weights and
    // the camera (6), point (3) and intrinsics (kdim) Jacobian rows. None when the
    // point sits on the camera plane. The assembly and the Schur steps both call it
    // (identically), instead of keeping each point's coupling blocks between them —
    // those were 160 B per observation, the largest term at thousands of cameras.
    struct Jac { ci: usize, ru: f64, rv: f64, wu: f64, wv: f64, ju: [f64; 6], jv: [f64; 6], jpu: [f64; 3], jpv: [f64; 3], jku: [f64; BLK_MAX], jkv: [f64; BLK_MAX] }
    let jac = |o: usize, cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>, dh: f64| -> Option<Jac> {
        let (ci, pi, ox, oy, obs_wx, obs_wy) = ob(o);
        let (r, t) = &cams[pb[ci]];
        let Eff { fx, fy, cx, cy, k, p: tp, fisheye } = eff(ci, gpar);
        let (xs, sdir) = if rs_any { seen_point(o, pts, gpar) } else { (pts[pi], [0.0; 3]) };
        let pc = mat3_vec(r, &xs); // R·X (the rolling-shutter-shifted X)
        // A lens with an offset sees R_o·q + t_o of the capture-frame point q = R·X + t
        // (`rq` = R_o·q, for ω's Jacobian).
        let ro_o = offset_rot(ci, gpar);
        let (xc, yc, zc, rq) = match ro_o {
            None => (pc[0] + t[0], pc[1] + t[1], pc[2] + t[2], [0.0; 3]),
            Some((ro, to)) => {
                let rq = mat3_vec(&ro, &[pc[0] + t[0], pc[1] + t[1], pc[2] + t[2]]);
                (rq[0] + to[0], rq[1] + to[1], rq[2] + to[2], rq)
            }
        };
        if zc.abs() < 1e-9 { return None; }
        let inv = 1.0 / zc;
        // Normalised coords and the lens's radial factor m (lens_factor): m ≡ 1, and
        // every derivative reduces to the pinhole case, for a pinhole with all k = 0.
        let a = xc * inv; let b = yc * inv;
        let DistJac { xd, yd, j: [[xa, xb], [ya, yb]], dk, dp } = distort_jac(a, b, &k, &tp, fisheye);
        let ru = fx * xd + cx - ox;
        let rv = fy * yd + cy - oy;
        // ∂proj/∂x_cam (2×3), exact analytic: the distorted point's 2×2 Jacobian in (a, b)
        // (distort_jac) through ∂a/∂(xc,yc,zc) = (1, 0, −a)/zc, ∂b/… = (0, 1, −b)/zc.
        let dudc = [fx * inv * xa, fx * inv * xb, -fx * inv * (xa*a + xb*b)];
        let dvdc = [fy * inv * ya, fy * inv * yb, -fy * inv * (ya*a + yb*b)];
        // Through a lens offset ∂x_cam/∂q = R_o: the capture's and the point's Jacobians
        // see ∂proj/∂x_cam · R_o (the same rows when there is none).
        let vm = |v: &[f64; 3], m: &M3| -> [f64; 3] { [0, 1, 2].map(|k| v[0]*m[0][k] + v[1]*m[1][k] + v[2]*m[2][k]) };
        let (dqu, dqv) = match ro_o { None => (dudc, dvdc), Some((ro, _)) => (vm(&dudc, &ro), vm(&dvdc, &ro)) };
        // Camera Jacobian Jc (2×6): [I | −[pc]_×] through ∂proj/∂x_cam.
        let sp = skew(&pc);
        let mut ju = [0f64; 6]; let mut jv = [0f64; 6];
        for k in 0..3 { ju[k] = dqu[k]; jv[k] = dqv[k]; }
        for k in 0..3 {
            let colk = [-sp[0][k], -sp[1][k], -sp[2][k]];
            ju[3 + k] = dqu[0]*colk[0] + dqu[1]*colk[1] + dqu[2]*colk[2];
            jv[3 + k] = dqv[0]*colk[0] + dqv[1]*colk[1] + dqv[2]*colk[2];
        }
        // Point Jacobian Jp (2×3) = ∂proj/∂x_cam · R.
        let mut jpu = [0f64; 3]; let mut jpv = [0f64; 3];
        for k in 0..3 {
            jpu[k] = dqu[0]*r[0][k] + dqu[1]*r[1][k] + dqu[2]*r[2][k];
            jpv[k] = dqv[0]*r[0][k] + dqv[1]*r[1][k] + dqv[2]*r[2][k];
        }
        // Intrinsic Jacobian Jk (2×kdim), filled by slot (idx_* is the param's
        // position in [s?,dcx?,dcy?,k1?,k2?,k3?,k4?]). ∂/∂s = (fx0·a·m, fy0·b·m);
        // ∂/∂dcx = (1,0), ∂/∂dcy = (0,1); ∂/∂kj = (fx·a·∂m/∂kj, fy·b·∂m/∂kj) — r^{2j}
        // for Brown, θ^{2j+1}/r for a fisheye. A slot the group's lens lacks stays 0.
        let mut jku = [0f64; BLK_MAX]; let mut jkv = [0f64; BLK_MAX];
        if refine {
            let (fx0, fy0, _, _) = ks[ci];
            if idx_s   >= 0 { jku[idx_s   as usize] = fx0 * xd; jkv[idx_s   as usize] = fy0 * yd; }
            if idx_dcx >= 0 { jku[idx_dcx as usize] = 1.0; }
            if idx_dcy >= 0 { jkv[idx_dcy as usize] = 1.0; }
            for j in 0..4 {
                if idx_k[j] >= 0 && k_live(grp[ci], j) {
                    jku[idx_k[j] as usize] = fx * a * dk[j]; jkv[idx_k[j] as usize] = fy * b * dk[j];
                }
            }
            // ∂/∂p1 = (fx·2ab, fy·(r² + 2b²)), ∂/∂p2 = (fx·(r² + 2a²), fy·2ab): Brown only.
            if idx_p1 >= 0 && p_live(grp[ci]) {
                jku[idx_p1 as usize] = fx * dp[0][0]; jkv[idx_p1 as usize] = fy * dp[1][0];
                jku[idx_p2 as usize] = fx * dp[0][1]; jkv[idx_p2 as usize] = fy * dp[1][1];
            }
            // ∂/∂τ: the camera-frame point moves by R·(−s·v) per unit τ.
            if idx_rs >= 0 && rs[ci].is_some() {
                let rd = mat3_vec(r, &sdir);
                jku[idx_rs as usize] = dqu[0]*rd[0] + dqu[1]*rd[1] + dqu[2]*rd[2];
                jkv[idx_rs as usize] = dqv[0]*rd[0] + dqv[1]*rd[1] + dqv[2]*rd[2];
            }
            // ∂/∂ω (left perturbation of the offset rotation): −[R_o·q]_× through ∂proj/∂x_cam.
            if idx_rig >= 0 && ro_o.is_some() {
                let sq = skew(&rq);
                for k in 0..3 {
                    let colk = [-sq[0][k], -sq[1][k], -sq[2][k]];
                    jku[idx_rig as usize + k] = dudc[0]*colk[0] + dudc[1]*colk[1] + dudc[2]*colk[2];
                    jkv[idx_rig as usize + k] = dvdc[0]*colk[0] + dvdc[1]*colk[1] + dvdc[2]*colk[2];
                }
            }
        }
        // Huber IRLS weight.
        let e = (ru*ru + rv*rv).sqrt();
        let w = if e <= dh { 1.0 } else { dh / e };
        Some(Jac { ci, ru, rv, wu: w * obs_wx, wv: w * obs_wy, ju, jv, jpu, jpv, jku, jkv })
    };
    // A point's coupling blocks E (Jvarᵀ·Jp): camera then group, per observation.
    let eblocks = |pi: usize, cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>, dh: f64, list: &mut Vec<EBlock>| {
        list.clear();
        for q in pt_start[pi]..pt_start[pi + 1] {
            let Some(j) = jac(pt_obs[q as usize] as usize, cams, pts, gpar, dh) else { continue };
            let mut cblk = [[0f64; 3]; BLK_MAX];
            for a in 0..6 { for b in 0..3 { cblk[a][b] = j.wu*j.ju[a]*j.jpu[b] + j.wv*j.jv[a]*j.jpv[b]; } }
            let sj = slot[pb[j.ci]];
            if sj != FIXED { add_eblock(list, sj, 6 * sj, 6, &cblk); }
            if refine {
                let g = grp[j.ci];
                let mut kblk = [[0f64; 3]; BLK_MAX];
                for a in 0..kdim { for b in 0..3 { kblk[a][b] = j.wu*j.jku[a]*j.jpu[b] + j.wv*j.jkv[a]*j.jpv[b]; } }
                add_eblock(list, n_free + g, group_off + g * kdim, kdim, &kblk);
            }
        }
    };

    let cost_before = rms(&cams, &pts, &gpar);
    // For the lens σ (solver slot 9): once the solve has ended, one more pass assembles
    // the reduced matrix at the solution without damping (`cov_pass`), keeps it and stops.
    // The last accepted step's own matrix will not do: a converged solve rejects steps to
    // rounding, raising λ, and may then accept a last tiny one at a large λ.
    let want_cov = solver.covariance && refine;
    let mut cov_pass = false;
    let mut last_s: Option<Vec<f64>> = None;
    // The implicit solve's counterpart: B, S's diagonal blocks, the points' C⁻¹.
    let mut last_implicit: Option<(Vec<f64>, Vec<f64>, Vec<Option<M3>>)> = None;
    let mut lambda = 1e-3f64;              // LM damping
    let mut trace: Vec<f64> = Vec::new();  // RMS after each accepted iteration
    // The full-matrix paths (no RangePlan: the dense and PCG solves, below ~128 cameras)
    // split the assembly and the Schur step over points instead: `point_chunks`
    // contiguous chunks, each summing into its own share of S and the right-hand side,
    // the shares added in chunk order after. The count follows the problem's size (2,048
    // points a chunk, at most 16, the shares at most 128 MB together), never the thread
    // count, so both builds give the same bits. One loop had kept these blocks on one
    // thread in the threaded build too (Aukerman, 42 cameras: BA 13.6 of SfM's 20 s).
    let point_chunks = if range_plan.is_some() { 1 } else {
        let share = (pattern.n_vals + n) * 8;
        let mut c = n_pts.div_ceil(2048).clamp(1, 16);
        while c > 1 && c * share > 128 << 20 { c -= 1; }
        c
    };
    let chunk_range = |c: usize| (c * n_pts / point_chunks)..((c + 1) * n_pts / point_chunks);
    let mut share_s: Vec<Vec<f64>> = if range_plan.is_some() { Vec::new() } else { (0..point_chunks).map(|_| vec![0f64; pattern.n_vals]).collect() };
    let mut share_r: Vec<Vec<f64>> = if range_plan.is_some() { Vec::new() } else { (0..point_chunks).map(|_| vec![0f64; n]).collect() };
    // The implicit solve's Jacobian cache: each observation's rows with its weight's root
    // folded in (ju, jv, jpu, jpv, then jku, jkv over the group's kdim), in f32, filled
    // once per iteration (the linearisation holds through every try and CG iteration).
    // A product then reads them instead of re-deriving the projection: re-deriving made a
    // CG iteration ~3× Ceres' (BAL trafalgar-257). Only when it fits the memory budget
    // beside the rest; otherwise each product calls `eblocks`.
    let jk = if refine { kdim } else { 0 };
    let jstride = 18 + 2 * jk;
    let use_jcache = implicit
        && 2 * 8 * pattern.n_vals as u64 + MEM_PER_OBS * obs.len() as u64 + MEM_PER_POINT * n_pts as u64
            + 4 * (jstride * obs.len()) as u64 <= solver.memory;
    let mut jcache: Vec<f32> = Vec::new();
    let mut jcache_outer = u32::MAX;
    // The implicit solve's pieces, as functions of the state they read (also used for the
    // lens σ after the loop). `fill_jcache`: the Jacobian cache at the given linearisation.
    let fill_jcache = |jcache: &mut Vec<f32>, cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>, dh: f64| {
        jcache.resize(jstride * obs.len(), 0.0);
        let jp = SyncPtr::of(jcache);
        for_each_index(obs.len().div_ceil(CHUNK), |k| {
            for o in k * CHUNK..((k + 1) * CHUNK).min(obs.len()) {
                // SAFETY: observation o belongs to chunk k alone.
                let row = unsafe { jp.slice(o * jstride, jstride) };
                let Some(j) = jac(o, cams, pts, gpar, dh) else { row.fill(0.0); continue };
                let (su, sv) = (j.wu.max(0.0).sqrt(), j.wv.max(0.0).sqrt());
                for a in 0..6 { row[a] = (su * j.ju[a]) as f32; row[6 + a] = (sv * j.jv[a]) as f32; }
                for k in 0..3 { row[12 + k] = (su * j.jpu[k]) as f32; row[15 + k] = (sv * j.jpv[k]) as f32; }
                for a in 0..jk { row[18 + a] = (su * j.jku[a]) as f32; row[18 + jk + a] = (sv * j.jkv[a]) as f32; }
            }
        });
    };
    // y = S·x = B·x − Σ_p E_p·C_p⁻¹·E_pᵀ·x, a point chunk at a time, each into its own
    // share (`shares`: `share_r`'s buffers, free while the implicit solve runs), added in
    // chunk order. `b`: B as the solve has it (damped); `cinv_store`: the points' C⁻¹.
    #[allow(clippy::too_many_arguments)]
    let implicit_product = |b: &[f64], cinv_store: &[Option<M3>], jcache: &[f32], shares: &mut Vec<Vec<f64>>,
                            cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>, dh: f64, x: &[f64], y: &mut [f64]| {
        for v in shares.iter_mut() { v.fill(0.0); }
        let ps: Vec<SyncPtr<f64>> = shares.iter_mut().map(|v| SyncPtr::of(v)).collect();
        for_each_index(point_chunks, |c| {
            let p = ps[c];
            let mut el: Vec<EBlock> = Vec::new();
            for pi in chunk_range(c) {
                let Some(cinv) = cinv_store[pi] else { continue };
                if use_jcache {
                    // E_o = √w·J_varᵀ ⊗ √w·J_p over the point's observations o.
                    let qs = pt_start[pi] as usize..pt_start[pi + 1] as usize;
                    let at = |o: usize| { let ci = obs[o].0 as usize; (slot[pb[ci]], group_off + if jk > 0 { grp[ci] * kdim } else { 0 }) };
                    let mut t = [0f64; 3];
                    for q in qs.clone() {
                        let o = pt_obs[q] as usize;
                        let j = &jcache[o * jstride..(o + 1) * jstride];
                        let (sc, go) = at(o);
                        let (mut su, mut sv) = (0.0, 0.0);
                        if sc != FIXED { for a in 0..6 { su += j[a] as f64 * x[6 * sc + a]; sv += j[6 + a] as f64 * x[6 * sc + a]; } }
                        for a in 0..jk { su += j[18 + a] as f64 * x[go + a]; sv += j[18 + jk + a] as f64 * x[go + a]; }
                        for k in 0..3 { t[k] += j[12 + k] as f64 * su + j[15 + k] as f64 * sv; }
                    }
                    let z = mat3_vec(&cinv, &t);
                    for q in qs {
                        let o = pt_obs[q] as usize;
                        let j = &jcache[o * jstride..(o + 1) * jstride];
                        let (sc, go) = at(o);
                        let pu = j[12] as f64 * z[0] + j[13] as f64 * z[1] + j[14] as f64 * z[2];
                        let pv = j[15] as f64 * z[0] + j[16] as f64 * z[1] + j[17] as f64 * z[2];
                        // SAFETY: chunk c alone writes its share.
                        if sc != FIXED { for a in 0..6 { unsafe { *p.at(6 * sc + a) += j[a] as f64 * pu + j[6 + a] as f64 * pv; } } }
                        for a in 0..jk { unsafe { *p.at(go + a) += j[18 + a] as f64 * pu + j[18 + jk + a] as f64 * pv; } }
                    }
                    continue;
                }
                eblocks(pi, cams, pts, gpar, dh, &mut el);
                let mut t = [0f64; 3];
                for eb in &el { for a in 0..eb.dim { for k in 0..3 { t[k] += eb.rows[a][k] * x[eb.off + a]; } } }
                let z = mat3_vec(&cinv, &t);
                // SAFETY: chunk c alone writes its share.
                for eb in &el { for a in 0..eb.dim {
                    unsafe { *p.at(eb.off + a) += eb.rows[a][0]*z[0] + eb.rows[a][1]*z[1] + eb.rows[a][2]*z[2]; }
                } }
            }
        });
        pattern.matvec(b, x, y);
        for v in shares.iter() { for i in 0..n { y[i] -= v[i]; } }
    };

    // The reduced system's buffers, allocated once for every iteration and try (see
    // sparse_chol.rs `factor_reusing`): the undamped assembly, the damped and reduced copy,
    // the implicit solve's B, and `work`: the ranges' group partials during a Schur step,
    // then the factor's storage (never both at once: the peak is the larger).
    let (mut smat, mut s, mut b_damped, mut work): (Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>) = Default::default();
    for outer in 0.. {
        if outer >= max_iters && !cov_pass {
            if !want_cov { break; }
            cov_pass = true;
        }
        if cov_pass { lambda = 0.0; }
        prof::start();
        let dh = huber_threshold(&cams, &pts, &gpar);
        let mut cost = robust_cost(&cams, &pts, &gpar, dh);
        let cost_at_start = cost; // this iteration's robust cost, for the function-tolerance stop
        prof::mark(0);

        // ── Assemble undamped blocks ────────────────────────────────────────────
        // S is the reduced-variable Hessian (camera poses + intrinsic groups) in the
        // block-sparse `pattern`; gr its gradient; per-point C (3×3) and gp (3).
        smat.clear();
        smat.resize(pattern.n_vals, 0.0);
        let mut gr = vec![0f64; n];
        let mut cmat = vec![[[0f64; 3]; 3]; n_pts];
        let mut gpv = vec![[0f64; 3]; n_pts];

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
            if slot[ci] == FIXED { continue; }
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
            let off = 6 * slot[ci];
            let dc = pattern.diag_at[slot[ci]];
            // Jᵀ·W·r and Jᵀ·W·J with the full position precision W.
            let wr = mat3_vec(&weight, &residual);
            let mut wj = [[0.0f64; 6]; 3];
            for row in 0..3 { for a in 0..6 {
                wj[row][a] = (0..3).map(|k| weight[row][k] * j[k][a]).sum::<f64>();
            }}
            for a in 0..6 {
                for axis in 0..3 { gr[off+a] += j[axis][a] * wr[axis]; }
                for b in 0..6 {
                    for axis in 0..3 {
                        smat[dc + a*6 + b] += j[axis][a] * wj[axis][b];
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
                        for row in 0..3 { for col in 0..3 {
                            smat[dc + (3 + a)*6 + 3 + b] += j[row][a] * precision[row][col] * j[col][b];
                        }}
                    }
                }
            }
        }

        if let Some(rp) = range_plan.as_ref() {
            // Range by range as the Schur step below (RangePlan): a camera's blocks and
            // gradient by its range, a point's C and gp by its owner, the group diagonal
            // and gradient by the owner (range 0 directly, the others into a partial
            // added in range order); each range's points in index order, the loop's.
            let (sm_p, gr_p) = (SyncPtr::of(&mut smat), SyncPtr::of(&mut gr));
            let (cm_p, gp_p) = (SyncPtr::of(&mut cmat), SyncPtr::of(&mut gpv));
            // The other ranges' group partials, range r at (r − 1)·pl of `work`.
            let pl = rp.part_len();
            work.clear();
            work.resize(if refine { (rp.n - 1) * pl } else { 0 }, 0.0);
            let parts_p: Vec<SyncPtr<f64>> = (0..rp.n)
                .map(|r| if r == 0 || !refine { SyncPtr::of(&mut []) } else { SyncPtr::of(&mut work[(r - 1) * pl..r * pl]) })
                .collect();
            for_each_index(rp.n, |r| {
                let part = parts_p[r];
                for &pi in &rp.points_by_index[r] {
                    let pi = pi as usize;
                    let owner = rp.owner[pi] as usize == r;
                    for q in pt_start[pi]..pt_start[pi + 1] {
                        let o = pt_obs[q as usize] as usize;
                        let sc = slot[pb[obs[o].0 as usize]];
                        let free = sc != FIXED;
                        let mine = free && rp.range(sc) == r;
                        if !mine && !owner { continue; }
                        let Some(Jac { ru, rv, wu, wv, ju, jv, jpu, jpv, jku, jkv, ci }) = jac(o, &cams, &pts, &gpar, dh)
                            else { continue };
                        // SAFETY (all writes below): RangePlan gives each element one writing range.
                        if mine {
                            let (coff, dc) = (6 * sc, pattern.diag_at[sc]);
                            for a in 0..6 {
                                unsafe { *gr_p.at(coff + a) += wu*ju[a]*ru + wv*jv[a]*rv; }
                                for b in 0..6 { unsafe { *sm_p.at(dc + a*6 + b) += wu*ju[a]*ju[b] + wv*jv[a]*jv[b]; } }
                            }
                        }
                        if refine {
                            let g = grp[ci];
                            let goff = group_off + g * kdim;
                            let dg = pattern.diag_at[n_free + g];
                            let (gc, cg) = if mine { (pattern.at(n_free + g, sc), pattern.at(sc, n_free + g)) } else { (0, 0) };
                            for a in 0..kdim {
                                if owner {
                                    let gv = wu*jku[a]*ru + wv*jkv[a]*rv;
                                    if r == 0 { unsafe { *gr_p.at(goff + a) += gv; } }
                                    else { unsafe { *part.at(rp.gg_len + goff + a - rp.group_off) += gv; } }
                                    let at = if r == 0 { dg } else { rp.gg_at[&dg] };
                                    let dst = if r == 0 { sm_p } else { part };
                                    for b in 0..kdim { unsafe { *dst.at(at + a*kdim + b) += wu*jku[a]*jku[b] + wv*jkv[a]*jkv[b]; } }
                                }
                                // Cross term camera(coff) ↔ group(goff), both triangles.
                                if mine { for b in 0..6 {
                                    let v = wu*jku[a]*ju[b] + wv*jkv[a]*jv[b];
                                    unsafe { *sm_p.at(gc + a*6 + b) += v; *sm_p.at(cg + b*kdim + a) += v; }
                                } }
                            }
                        }
                        if owner {
                            let (gp, cm) = unsafe { (gp_p.at(pi), cm_p.at(pi)) };
                            for a in 0..3 {
                                gp[a] += wu*jpu[a]*ru + wv*jpv[a]*rv;
                                for b in 0..3 { cm[a][b] += wu*jpu[a]*jpu[b] + wv*jpv[a]*jpv[b]; }
                            }
                        }
                    }
                }
            });
            if refine {
                for part in work.chunks(pl.max(1)).take(rp.n - 1) {
                    for &(base, len) in &rp.gg {
                        let o = rp.gg_at[&base];
                        for i in 0..len { smat[base + i] += part[o + i]; }
                    }
                    for i in 0..rp.group_rows { gr[rp.group_off + i] += part[rp.gg_len + i]; }
                }
            }
        } else {
            // Point chunks (`point_chunks`): a chunk's camera and group terms go to its own
            // shares, its points' C and gp straight to them (a point is in one chunk).
            for v in share_s.iter_mut() { v.fill(0.0); }
            for v in share_r.iter_mut() { v.fill(0.0); }
            let sm_ps: Vec<SyncPtr<f64>> = share_s.iter_mut().map(|v| SyncPtr::of(v)).collect();
            let gr_ps: Vec<SyncPtr<f64>> = share_r.iter_mut().map(|v| SyncPtr::of(v)).collect();
            let (cm_p, gp_p) = (SyncPtr::of(&mut cmat), SyncPtr::of(&mut gpv));
            for_each_index(point_chunks, |c| {
                let (sm_p, gr_p) = (sm_ps[c], gr_ps[c]);
                for pi in chunk_range(c) {
                    // SAFETY (all writes below): chunk c alone writes its shares and its points.
                    let (gp, cm) = unsafe { (gp_p.at(pi), cm_p.at(pi)) };
                    for q in pt_start[pi]..pt_start[pi + 1] {
                        let Some(Jac { ci, ru, rv, wu, wv, ju, jv, jpu, jpv, jku, jkv }) = jac(pt_obs[q as usize] as usize, &cams, &pts, &gpar, dh)
                            else { continue };
                        let sc = slot[pb[ci]];
                        let free = sc != FIXED;
                        let coff = if free { 6 * sc } else { 0 };
                        if free {
                            let dc = pattern.diag_at[sc];
                            for a in 0..6 {
                                unsafe { *gr_p.at(coff + a) += wu*ju[a]*ru + wv*jv[a]*rv; }
                                for b in 0..6 { unsafe { *sm_p.at(dc + a*6 + b) += wu*ju[a]*ju[b] + wv*jv[a]*jv[b]; } }
                            }
                        }
                        if refine {
                            let g = grp[ci];
                            let goff = group_off + g * kdim;
                            let dg = pattern.diag_at[n_free + g];
                            let (gc, cg) = if free { (pattern.at(n_free + g, sc), pattern.at(sc, n_free + g)) } else { (0, 0) };
                            for a in 0..kdim {
                                unsafe { *gr_p.at(goff + a) += wu*jku[a]*ru + wv*jkv[a]*rv; }
                                for b in 0..kdim { unsafe { *sm_p.at(dg + a*kdim + b) += wu*jku[a]*jku[b] + wv*jkv[a]*jkv[b]; } }
                                // Cross term camera(coff) ↔ group(goff), both triangles.
                                if free { for b in 0..6 {
                                    let v = wu*jku[a]*ju[b] + wv*jkv[a]*jv[b];
                                    unsafe { *sm_p.at(gc + a*6 + b) += v; *sm_p.at(cg + b*kdim + a) += v; }
                                } }
                            }
                        }
                        for a in 0..3 {
                            gp[a] += wu*jpu[a]*ru + wv*jpv[a]*rv;
                            for b in 0..3 { cm[a][b] += wu*jpu[a]*jpu[b] + wv*jpv[a]*jpv[b]; }
                        }
                    }
                }
            });
            for c in 0..point_chunks {
                for (x, v) in smat.iter_mut().zip(&share_s[c]) { *x += v; }
                for (x, v) in gr.iter_mut().zip(&share_r[c]) { *x += v; }
            }
        }

        // A k slot the group's lens does not have has no Jacobian: pin it (unit
        // diagonal, zero gradient) so its offset solves to exactly 0 instead of
        // resting on the 1e-12 damping floor.
        if refine {
            for g in 0..g_count {
                let dg = pattern.diag_at[n_free + g];
                for j in 0..4 {
                    if idx_k[j] >= 0 && !k_live(g, j) { let a = idx_k[j] as usize; smat[dg + a*kdim + a] += 1.0; }
                }
                if idx_p1 >= 0 && !p_live(g) {
                    for a in [idx_p1 as usize, idx_p2 as usize] { smat[dg + a*kdim + a] += 1.0; }
                }
                // Likewise ω for a group with no lens offset (the rig's reference lens).
                if idx_rig >= 0 && !group_has_off[g] {
                    for k in 0..3 { let a = idx_rig as usize + k; smat[dg + a*kdim + a] += 1.0; }
                }
            }
        }

        prof::mark(1);
        // ── LM step with damping retries ────────────────────────────────────────
        // A rejected step raises the damping ×4 and tries again, up to its cap: only a
        // step rejected at the cap (one barely off the gradient, ×10⁻⁸ of it) ends the run.
        // Giving up after a fixed 8 tries left a model with a bad start where its first
        // iteration took it (×28 Ceres' cost on the largest BAL Ladybug problems), since
        // 8 tries raise λ only from its working level to ~20 (docs/METHODS.md §4.5).
        let mut accepted = false;
        for _try in 0..LM_MAX_TRIES {
            // Damp the reduced diagonal, then Schur-eliminate the (λ-damped) points:
            // S ← (S+λ) − Σ_p E·(C+λ)⁻¹·Eᵀ,  rhs ← −gr + Σ_p E·(C+λ)⁻¹·gp.
            s.clone_from(&smat);
            let mut rhs = vec![0f64; n];
            for i in 0..n { rhs[i] = -gr[i]; }
            for b in 0..pattern.dims.len() {
                let (d, base) = (pattern.dims[b], pattern.diag_at[b]);
                for i in 0..d { s[base + i*d + i] = s[base + i*d + i] * (1.0 + lambda) + 1e-12; }
            }

            let mut cinv_store: Vec<Option<M3>> = vec![None; n_pts];
            // The implicit solve: B damped, before the points' diagonal-block terms turn
            // `s` into its preconditioner (S's diagonal blocks).
            let ok;
            if let Some(rp) = range_plan.as_ref() {
                // Range by range, on the thread pool when there is one (RangePlan: every
                // element has one writer, and gets its terms in Schur order).
                let failed = std::sync::atomic::AtomicBool::new(false);
                let (s_p, rhs_p) = (SyncPtr::of(&mut s), SyncPtr::of(&mut rhs));
                let ci_p = SyncPtr::of(&mut cinv_store);
                // The other ranges' group partials in `work`, which the factor reuses next.
                let pl = rp.part_len();
                work.clear();
                work.resize((rp.n - 1) * pl, 0.0);
                let parts_p: Vec<SyncPtr<f64>> = (0..rp.n)
                    .map(|r| if r == 0 { SyncPtr::of(&mut []) } else { SyncPtr::of(&mut work[(r - 1) * pl..r * pl]) })
                    .collect();
                for_each_index(rp.n, |r| {
                    let part = parts_p[r];
                    let mut el: Vec<EBlock> = Vec::new();
                    let mut ms: Vec<[[f64; 3]; BLK_MAX]> = Vec::new();
                    for &pi in &rp.points[r] {
                        if failed.load(std::sync::atomic::Ordering::Relaxed) { return; }
                        let pi = pi as usize;
                        eblocks(pi, &cams, &pts, &gpar, dh, &mut el);
                        if el.is_empty() && !anchored[pi] { continue; }
                        let mut cp = cmat[pi];
                        for i in 0..3 { cp[i][i] = cp[i][i] * (1.0 + lambda) + 1e-12; }
                        let cinv = match inv3(&cp) { Some(m) => m, None => { failed.store(true, std::sync::atomic::Ordering::Relaxed); return; } };
                        let tmp = mat3_vec(&cinv, &gpv[pi]); // C⁻¹·gp
                        let owner = rp.owner[pi] as usize == r;
                        // SAFETY (all writes below): RangePlan gives each element one writing range.
                        if owner { unsafe { *ci_p.at(pi) = Some(cinv); } }
                        for eb in &el {
                            let camera = eb.blk < rp.n_free;
                            if !(if camera { rp.range(eb.blk) == r } else { owner }) { continue; }
                            for a in 0..eb.dim {
                                let v = eb.rows[a][0]*tmp[0] + eb.rows[a][1]*tmp[1] + eb.rows[a][2]*tmp[2];
                                if camera || r == 0 { unsafe { *rhs_p.at(eb.off + a) += v; } }
                                else { unsafe { *part.at(rp.gg_len + eb.off + a - rp.group_off) += v; } }
                            }
                        }
                        ms.clear();
                        ms.extend(el.iter().map(|eb| {
                            let mut m = [[0f64; 3]; BLK_MAX];
                            for a in 0..eb.dim {
                                for k in 0..3 {
                                    m[a][k] = eb.rows[a][0]*cinv[0][k] + eb.rows[a][1]*cinv[1][k] + eb.rows[a][2]*cinv[2][k];
                                }
                            }
                            m
                        }));
                        for (i1, eb1) in el.iter().enumerate() {
                            let m = &ms[i1];
                            for eb2 in &el {
                                if eb2.blk > eb1.blk { continue; }
                                // Row eb1's owner for a camera row; the column camera's owner
                                // for a group row; the point's owner for group × group.
                                let (mine, direct) = if eb1.blk < rp.n_free { (rp.range(eb1.blk) == r, true) }
                                    else if eb2.blk < rp.n_free { (rp.range(eb2.blk) == r, true) }
                                    else { (owner, r == 0) };
                                if !mine { continue; }
                                let base = pattern.at(eb1.blk, eb2.blk);
                                let at = if direct { base } else { rp.gg_at[&base] };
                                let dst = if direct { s_p } else { part };
                                for a in 0..eb1.dim {
                                    for b in 0..eb2.dim {
                                        let v = m[a][0]*eb2.rows[b][0] + m[a][1]*eb2.rows[b][1] + m[a][2]*eb2.rows[b][2];
                                        if direct { unsafe { *dst.at(at + a*eb2.dim + b) -= v; } }
                                        else { unsafe { *dst.at(at + a*eb2.dim + b) += v; } }
                                    }
                                }
                            }
                        }
                    }
                });
                ok = !failed.load(std::sync::atomic::Ordering::Relaxed);
                // The other ranges' group shares, in range order.
                for part in work.chunks(pl.max(1)).take(rp.n - 1) {
                    for &(base, len) in &rp.gg {
                        let o = rp.gg_at[&base];
                        for i in 0..len { s[base + i] -= part[o + i]; }
                    }
                    for i in 0..rp.group_rows { rhs[rp.group_off + i] += part[rp.gg_len + i]; }
                }
            } else {
                // Point chunks (`point_chunks`; schur_order is the index order here): each
                // chunk subtracts into its own shares of S and adds into its share of the
                // right-hand side, added in chunk order after.
                for v in share_s.iter_mut() { v.fill(0.0); }
                for v in share_r.iter_mut() { v.fill(0.0); }
                let failed = std::sync::atomic::AtomicBool::new(false);
                let s_ps: Vec<SyncPtr<f64>> = share_s.iter_mut().map(|v| SyncPtr::of(v)).collect();
                let r_ps: Vec<SyncPtr<f64>> = share_r.iter_mut().map(|v| SyncPtr::of(v)).collect();
                let ci_p = SyncPtr::of(&mut cinv_store);
                for_each_index(point_chunks, |c| {
                    let (s_p, r_p) = (s_ps[c], r_ps[c]);
                    let mut el: Vec<EBlock> = Vec::new();
                    let mut ms: Vec<[[f64; 3]; BLK_MAX]> = Vec::new();
                    for pi in chunk_range(c) {
                        if failed.load(std::sync::atomic::Ordering::Relaxed) { return; }
                        eblocks(pi, &cams, &pts, &gpar, dh, &mut el);
                        // An anchored point with no camera coupling (edge case: every
                        // observing camera failed cheirality) still needs its C⁻¹·gp
                        // computed so the back-substitution below moves it toward the anchor.
                        if el.is_empty() && !anchored[pi] { continue; }
                        let mut cp = cmat[pi];
                        for i in 0..3 { cp[i][i] = cp[i][i] * (1.0 + lambda) + 1e-12; }
                        let cinv = match inv3(&cp) { Some(m) => m, None => { failed.store(true, std::sync::atomic::Ordering::Relaxed); return; } };
                        let tmp = mat3_vec(&cinv, &gpv[pi]); // C⁻¹·gp
                        // SAFETY (all writes below): chunk c alone writes its shares and its points.
                        unsafe { *ci_p.at(pi) = Some(cinv); }
                        for eb in &el {
                            for a in 0..eb.dim {
                                unsafe { *r_p.at(eb.off + a) += eb.rows[a][0]*tmp[0] + eb.rows[a][1]*tmp[1] + eb.rows[a][2]*tmp[2]; }
                            }
                        }
                        // M_v = E_v·C⁻¹ (dim×3); then S -= Σ_{v1,v2} M_{v1}·E_{v2}ᵀ.
                        ms.clear();
                        ms.extend(el.iter().map(|eb| {
                            let mut m = [[0f64; 3]; BLK_MAX];
                            for a in 0..eb.dim {
                                for k in 0..3 {
                                    m[a][k] = eb.rows[a][0]*cinv[0][k] + eb.rows[a][1]*cinv[1][k] + eb.rows[a][2]*cinv[2][k];
                                }
                            }
                            m
                        }));
                        for (i1, eb1) in el.iter().enumerate() {
                            let m = &ms[i1];
                            for eb2 in &el {
                                if lower_only && eb2.blk > eb1.blk { continue; }
                                if implicit && eb2.blk != eb1.blk { continue; }
                                let base = pattern.at(eb1.blk, eb2.blk);
                                if eb1.dim == 6 && eb2.dim == 6 {
                                    // Camera × camera, fixed size (the same sums as below).
                                    for a in 0..6 {
                                        for b in 0..6 {
                                            let v = m[a][0]*eb2.rows[b][0] + m[a][1]*eb2.rows[b][1] + m[a][2]*eb2.rows[b][2];
                                            unsafe { *s_p.at(base + a*6 + b) -= v; }
                                        }
                                    }
                                } else {
                                    for a in 0..eb1.dim {
                                        for b in 0..eb2.dim {
                                            let v = m[a][0]*eb2.rows[b][0] + m[a][1]*eb2.rows[b][1] + m[a][2]*eb2.rows[b][2];
                                            unsafe { *s_p.at(base + a*eb2.dim + b) -= v; }
                                        }
                                    }
                                }
                            }
                        }
                    }
                });
                ok = !failed.load(std::sync::atomic::Ordering::Relaxed);
                if ok && implicit { b_damped.clone_from(&s); }
                if ok {
                    for c in 0..point_chunks {
                        for (x, v) in s.iter_mut().zip(&share_s[c]) { *x += v; }
                        for (x, v) in rhs.iter_mut().zip(&share_r[c]) { *x += v; }
                    }
                }
            }
            if cov_pass {
                if ok {
                    if implicit { last_implicit = Some((std::mem::take(&mut b_damped), std::mem::take(&mut s), cinv_store)); }
                    else { last_s = Some(std::mem::take(&mut s)); }
                }
                break;
            }
            if !ok { lambda = (lambda * 4.0).min(LAMBDA_MAX); continue; }

            prof::mark(2);
            let dsol = if let Some(sym) = direct.as_ref() {
                solve_stats.solves += 1;
                solve_stats.cholesky += 1;
                match sym.factor_reusing(&pattern, &s, std::mem::take(&mut work)) {
                    Ok(f) => { let x = f.solve(&pattern, &rhs); work = f.into_vals(); x }
                    Err(buf) => { work = buf; lambda = (lambda * 4.0).min(LAMBDA_MAX); continue; }
                }
            } else if implicit {
                if use_jcache && jcache_outer != outer {
                    fill_jcache(&mut jcache, &cams, &pts, &gpar, dh);
                    jcache_outer = outer;
                }
                let shares = std::cell::RefCell::new(std::mem::take(&mut share_r));
                let matvec = |x: &[f64], y: &mut [f64]| {
                    implicit_product(&b_damped, &cinv_store, &jcache, &mut shares.borrow_mut(), &cams, &pts, &gpar, dh, x, y)
                };
                let res = pcg_truncated(n, matvec, &pattern.diag_blocks(&s), &rhs, IMPLICIT_ETA, IMPLICIT_MAX_ITER);
                share_r = shares.into_inner();
                solve_stats.solves += 1;
                solve_stats.implicit += 1;
                let iters = res.iters();
                solve_stats.pcg_iters += iters as u64;
                solve_stats.pcg_iters_max = solve_stats.pcg_iters_max.max(iters as u32);
                match res {
                    PcgResult::Converged(x, _) => { solve_stats.pcg_converged += 1; x }
                    PcgResult::Stalled(x, _) => { solve_stats.pcg_partial += 1; x }
                    PcgResult::NotPositiveDefinite(_) => {
                        solve_stats.pcg_npd += 1;
                        lambda = (lambda * 4.0).min(LAMBDA_MAX);
                        continue;
                    }
                }
            } else {
                let ic = if solver.precond == 1 && (n >= solver.pcg_min_n || n > DENSE_MAX_N) { BlockIc::new(&pattern, &s) } else { None };
                match solve_reduced_with(n, |x, y| pattern.matvec(&s, x, y), &pattern.diag_blocks(&s), ic.as_ref(),
                                         || pattern.to_dense(&s), n <= DENSE_MAX_N, &rhs, &solver, &mut solve_stats) {
                    Some(x) => x,
                    None => { lambda = (lambda * 4.0).min(LAMBDA_MAX); continue; }
                }
            };

            prof::mark(3);
            // Back-substitute points: δp = −C⁻¹·gp − C⁻¹·(Σ_v E_vᵀ·δv).
            // Every point on its own: on the pool, CHUNK points per task. δp is written
            // where the tentative points will be (`tent_pts`, turned into X + δX below),
            // so the step needs no array of its own; C⁻¹·gp is recomputed, not kept.
            let mut tent_pts = vec![[0f64; 3]; n_pts];
            let dp_p = SyncPtr::of(&mut tent_pts);
            for_each_index(n_pts.div_ceil(CHUNK), |k| {
                let mut el: Vec<EBlock> = Vec::new();
                for pi in k * CHUNK..((k + 1) * CHUNK).min(n_pts) {
                    let cinv = match cinv_store[pi] { Some(m) => m, None => continue };
                    eblocks(pi, &cams, &pts, &gpar, dh, &mut el);
                    let mut acc = [0f64; 3];
                    for eb in &el {
                        for k in 0..3 {
                            let mut sdot = 0.0;
                            for a in 0..eb.dim { sdot += eb.rows[a][k] * dsol[eb.off + a]; }
                            acc[k] += sdot;
                        }
                    }
                    let ca = mat3_vec(&cinv, &acc);
                    // SAFETY: point pi belongs to chunk k alone.
                    let d = unsafe { dp_p.at(pi) };
                    let tmp = mat3_vec(&cinv, &gpv[pi]); // C⁻¹·gp, as the Schur step had it
                    for k in 0..3 { d[k] = -tmp[k] - ca[k]; }
                }
            });

            // Tentative update: t += δt, R = exp(δω)·R, X += δX, group params += δ.
            let mut tent_cams = cams.clone();
            for (k, &c) in free_cams.iter().enumerate() {
                let (r0, t0) = cams[c];
                let dt = [dsol[6*k], dsol[6*k+1], dsol[6*k+2]];
                let dw = [dsol[6*k+3], dsol[6*k+4], dsol[6*k+5]];
                tent_cams[c] = (mat3_mul(&so3_exp(&dw), &r0), [t0[0]+dt[0], t0[1]+dt[1], t0[2]+dt[2]]);
            }
            let mut tent_gpar = gpar.clone();
            if refine {
                for g in 0..g_count {
                    let goff = group_off + g * kdim;
                    // Slots are contiguous per group; kdim picks how many (1–8).
                    for a in 0..kdim { tent_gpar[g][a] += dsol[goff + a]; }
                }
            }
            // |δX|² first (for the step-size stop), then X + δX in place (= δX + X exactly).
            let dp_sq = tent_pts.iter().map(|d| dot3(d, d)).sum::<f64>();
            for pi in 0..n_pts { for k in 0..3 { tent_pts[pi][k] += pts[pi][k]; } }

            let new_cost = robust_cost(&tent_cams, &tent_pts, &tent_gpar, dh);
            prof::mark(4);
            if new_cost < cost {
                cams = tent_cams;
                pts = tent_pts;
                gpar = tent_gpar;
                cost = new_cost;
                lambda = (lambda * 0.3).max(LAMBDA_MIN);
                accepted = true;
                break;
            } else {
                if lambda >= LAMBDA_MAX { break; }
                // A rejected step too small to change the model ends it too: a converged
                // model rejects every step to rounding, and more damping only shrinks them.
                let step2 = dsol.iter().map(|v| v * v).sum::<f64>() + dp_sq;
                let size2 = pts.iter().map(|x| dot3(x, x)).sum::<f64>()
                    + free_cams.iter().map(|&c| dot3(&cams[c].1, &cams[c].1)).sum::<f64>()
                    + if refine { gpar.iter().map(|g| g.iter().map(|v| v * v).sum::<f64>()).sum::<f64>() } else { 0.0 };
                if step2.sqrt() <= PARAM_TOL * (size2.sqrt() + PARAM_TOL) { break; }
                lambda = (lambda * 4.0).min(LAMBDA_MAX);
            }
        }
        if cov_pass { break; }
        // No step lowers the cost, even at the largest damping.
        let done = if !accepted { true } else {
            trace.push(rms(&cams, &pts, &gpar));
            // Compared within one iteration only: the Huber threshold is re-derived from
            // the residuals at the top of each iteration, so costs of different iterations
            // sit on different scales.
            function_tol > 0.0 && cost_at_start - cost <= function_tol * cost_at_start
        };
        if done {
            if !want_cov { break; }
            cov_pass = true;
        }
    }

    let cost_after = rms(&cams, &pts, &gpar);
    let anchor_rms_after = anchor_rms(&pts);
    let camera_prior_rms_after = camera_prior_rms(&cams);

    // ── The lens's standard deviations (solver slot 9) ───────────────────────────
    // σ² = σ0²·(S⁻¹)_ii on the reduced system of the last accepted step (S with the
    // points eliminated, so each σ is marginal over every pose and point; damped by a
    // factor 1 + λ that convergence has taken near 1), σ0² = the final cost over the
    // redundancy. Without control (no camera prior, no anchor, fewer than two fixed
    // cameras) S is singular along the 7 similarity directions; no lens term moves
    // under a similarity, so a minimal datum leaves their marginals as they are: hold
    // one camera and the scale along one baseline.
    // In the implicit solve, S is B less the points' terms: the datum holds below go into
    // B (the product) and S's diagonal blocks (the preconditioner) alike.
    let cov_state = if !want_cov { None } else if let Some(s) = last_s.take() { Some((s, None)) }
        else { last_implicit.take().map(|(b, pre, cinv)| (pre, Some((b, cinv)))) };
    let lens_sigmas: Vec<f64> = if let Some((mut s, mut imp)) = cov_state {
        let n_fixed = n_pb - n_free;
        if camera_priors.is_empty() && anchors.is_empty() && n_fixed < 2 && n_free >= 2 {
            let hold = |s: &mut Vec<f64>, imp: &mut Option<(Vec<f64>, Vec<Option<M3>>)>, k: usize, dir: Option<V3>| {
                let base = pattern.diag_at[k];
                let big = 1e8 * (0..6).map(|i| s[base + i * 6 + i].abs()).fold(1.0, f64::max);
                for m in std::iter::once(&mut *s).chain(imp.as_mut().map(|(b, _)| b)) {
                    match dir {
                        None => for i in 0..6 { m[base + i * 6 + i] += big; },
                        Some(u) => for a in 0..3 { for b in 0..3 { m[base + a * 6 + b] += big * u[a] * u[b]; } },
                    }
                }
            };
            // The datum camera: a fixed one if there is one (its slot is gone already),
            // else the first free one; the scale along the free camera farthest from it.
            let anchor_pb = (0..n_pb).find(|&b| slot[b] == FIXED).unwrap_or(free_cams[0]);
            if slot[anchor_pb] != FIXED { hold(&mut s, &mut imp, slot[anchor_pb], None); }
            let ca = camera_center(&cams[anchor_pb]);
            let far = free_cams.iter().copied().filter(|&b| b != anchor_pb)
                .max_by(|&a, &b| {
                    let d = |x: usize| { let c = camera_center(&cams[x]); (0..3).map(|i| (c[i] - ca[i]).powi(2)).sum::<f64>() };
                    d(a).total_cmp(&d(b))
                });
            if let Some(b) = far {
                // dC = −Rᵀ·dt, so the scale's motion (C − C_a) is R·(C − C_a) in −dt.
                let c = camera_center(&cams[b]);
                let u = normalize3(&mat3_vec(&cams[b].0, &[c[0] - ca[0], c[1] - ca[1], c[2] - ca[2]]));
                hold(&mut s, &mut imp, slot[b], Some(u));
            }
        }
        let n_lens = g_count * kdim;
        let mut var = vec![f64::NAN; n_lens];
        let unit = |i: usize| { let mut e = vec![0f64; n]; e[group_off + i] = 1.0; e };
        let mut st = SolveStats::default();
        if let Some((b, cinv)) = imp.as_ref() {
            // PCG on the implicit S at the solution, one solve per lens term; a term whose
            // solve does not converge keeps NaN.
            let dh = huber_threshold(&cams, &pts, &gpar);
            if use_jcache { fill_jcache(&mut jcache, &cams, &pts, &gpar, dh); }
            let shares = std::cell::RefCell::new(std::mem::take(&mut share_r));
            let diag = pattern.diag_blocks(&s);
            for i in 0..n_lens {
                let matvec = |x: &[f64], y: &mut [f64]| {
                    implicit_product(b, cinv, &jcache, &mut shares.borrow_mut(), &cams, &pts, &gpar, dh, x, y)
                };
                if let PcgResult::Converged(x, _) = pcg_core_with(n, matvec, &diag, None, &unit(i), IMPLICIT_SIGMA_TOL, IMPLICIT_SIGMA_MAX_ITER) {
                    var[i] = x[group_off + i];
                }
            }
        } else if let Some(f) = direct.as_ref().and_then(|sym| sym.factor(&pattern, &s)) {
            for i in 0..n_lens { var[i] = f.solve(&pattern, &unit(i))[group_off + i]; }
        } else {
            let ic = if solver.precond == 1 && (n >= solver.pcg_min_n || n > DENSE_MAX_N) { BlockIc::new(&pattern, &s) } else { None };
            let exact = SolverOpts { accept_partial: false, rel_tol: 1e-10, max_iter: 2000, ..solver };
            for i in 0..n_lens {
                if let Some(x) = solve_reduced_with(n, |x, y| pattern.matvec(&s, x, y), &pattern.diag_blocks(&s), ic.as_ref(),
                                                    || pattern.to_dense(&s), n <= DENSE_MAX_N, &unit(i), &exact, &mut st) {
                    var[i] = x[group_off + i];
                }
            }
        }
        // σ0²: the weighted residual sum over the redundancy (observations, anchor and
        // prior axes, less the unknowns).
        let dh = huber_threshold(&cams, &pts, &gpar);
        let n_valid = map_indexed(obs.len(), |o| sq_err(o, &cams, &pts, &gpar)).iter().filter(|v| !v.is_nan()).count();
        let m = 2 * n_valid + 3 * anchors.len()
            + camera_priors.iter().map(|p| if p.3.is_some() { 6 } else { 3 }).sum::<usize>();
        let unknowns = 6 * n_free + 3 * n_pts + n_lens;
        let s0 = if m > unknowns { robust_cost(&cams, &pts, &gpar, dh) / (m - unknowns) as f64 } else { f64::NAN };
        // Per group in the output's order; the focal slot is a scale on fx.
        let mut out = vec![f64::NAN; g_count * LENS_SIGMA_LEN];
        let first_cam = |g: usize| (0..n_cam).find(|&c| grp[c] == g).unwrap_or(0);
        for g in 0..g_count {
            let sd = |idx: isize| if idx >= 0 { (s0 * var[g * kdim + idx as usize]).max(0.0).sqrt() } else { f64::NAN };
            let o = &mut out[g * LENS_SIGMA_LEN..(g + 1) * LENS_SIGMA_LEN];
            o[0] = sd(idx_s) * ks[first_cam(g)].0;
            o[1] = sd(idx_dcx);
            o[2] = sd(idx_dcy);
            for j in 0..4 { o[3 + j] = if k_live(g, j) { sd(idx_k[j]) } else { f64::NAN }; }
            if p_live(g) { o[7] = sd(idx_p1); o[8] = sd(idx_p2); }
        }
        out
    } else { Vec::new() };

    // Pack output: cameras (12 each), points (3 each), refined effective intrinsics
    // (8 each: fx,fy,cx,cy,k1,k2,k3,k4 — a pinhole camera's Brown residual, 0 for the
    // bits not in refine_mask; a fisheye's full Kannala–Brandt coefficients),
    // [cost_before, cost_after, anchor_rms_after, camera_prior_rms_after], then trace.
    let intr_stride = if lens_stride == 7 { 10 } else { 8 };
    let mut out = Vec::with_capacity(n_cam * 12 + n_pts * 3 + n_cam * intr_stride + 4 + BA_STATS_LEN + trace.len());
    for c in 0..n_cam {
        let (r, t) = pose_of(c, &cams, &gpar);
        for row in &r { for &v in row { out.push(v as f32); } }
        for &v in &t { out.push(v as f32); }
    }
    for pt in &pts {
        for &v in pt { out.push(v as f32); }
    }
    for c in 0..n_cam {
        let e = eff(c, &gpar);
        out.push(e.fx as f32); out.push(e.fy as f32); out.push(e.cx as f32); out.push(e.cy as f32);
        for j in 0..4 { out.push(e.k[j] as f32); }
        if intr_stride == 10 { out.push(e.p[0] as f32); out.push(e.p[1] as f32); }
    }
    out.push(cost_before as f32);
    out.push(cost_after as f32);
    out.push(anchor_rms_after as f32);
    out.push(camera_prior_rms_after as f32);
    let st = &solve_stats;
    for v in [n as f64, st.solves as f64, st.cholesky as f64, st.pcg_converged as f64, st.pcg_partial as f64,
              st.pcg_fallback as f64, st.pcg_npd as f64, st.pcg_iters as f64, st.pcg_iters_max as f64, st.implicit as f64] {
        out.push(v as f32);
    }
    if solver.covariance {
        // An empty section (no lens refined, or no accepted step) is [0].
        out.push((lens_sigmas.len() / LENS_SIGMA_LEN) as f32);
        for &v in &lens_sigmas { out.push(v as f32); }
    }
    if !rs_flat.is_empty() { for c in 0..n_cam { out.push(tau_of(c, &gpar) as f32); } }
    for &c in &trace { out.push(c as f32); }
    out
}

#[cfg(test)]
#[path = "bundle/tests/reduced_solve_tests.rs"]
mod reduced_solve_tests;
#[cfg(test)]
#[path = "bundle/tests/rolling_shutter_tests.rs"]
mod rolling_shutter_tests;
#[cfg(test)]
#[path = "bundle/tests/rig_tests.rs"]
mod rig_tests;
#[cfg(test)]
#[path = "bundle/tests/lens_sigma_tests.rs"]
mod lens_sigma_tests;
