// Sparse bundle adjustment: Levenberg–Marquardt with the Schur complement
// (points eliminated against the cameras) and adaptive Huber robustification.
use wasm_bindgen::prelude::*;
use crate::linalg::*;

// The parts (bundle/): the linear algebra, the camera model, the Schur assembly helpers,
// and the solve's own pieces in the order bundle_adjust_impl uses them.
mod solve;
mod camera;
mod schur;
mod problem;
mod layout;
mod model;
mod normal;
mod implicit;
mod sigma;
pub(crate) use solve::*;
pub(crate) use camera::*;
use schur::*;
use problem::*;
use layout::*;
use model::*;
use normal::*;
use implicit::*;
use sigma::*;

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

// Below this many observations the threaded build runs a bundle adjustment on the
// calling thread alone: the pool's hand-offs and the data left in other cores' caches
// cost more than the work they share. Measured natively, the pool's 20 threads against
// the calling thread alone (the timing test's grid, BA_PTS for more points): with point
// chunks (the dense and PCG solves, under ~100 cameras) 24k observations 0.11 against
// 0.064 s, 48k 0.115 against 0.084 s, 84k 0.354 against 0.374 s, 96k 0.18 against 0.21 s;
// with camera ranges (the sparse direct solve) 27k 0.085 against 0.072 s, 33k 0.111
// against 0.116 s, 39k 0.131 against 0.142 s, 53k 0.117 against 0.152 s. The bits are the
// same either way.
const POOL_MIN_OBS_CHUNKS: usize = 64_000;
const POOL_MIN_OBS_RANGES: usize = 32_000;

// Phase timers for the native timing test (bundle_adjust_timing); no-ops in the app.
// Slots 0–4 are the LM phases (`mark`), the rest the setup of a call (`add` from a `now`):
// the parse, Layout::new, the pattern, the minimum-degree ordering, the supernodes, the
// Schur order, the RangePlan, the rest of Plan::new, Work::new and the output packing.
#[cfg(test)]
pub(crate) mod prof {
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;
    pub const N: usize = 15;
    pub const SETUP: [&str; 10] = ["parse", "layout", "pattern", "min_degree", "supernodes", "schur_order", "range_plan",
        "plan_rest", "work_new", "packing"];
    pub static T: [AtomicU64; N] = [const { AtomicU64::new(0) }; N];
    thread_local! { static LAST: Cell<Option<Instant>> = const { Cell::new(None) }; }
    pub fn start() { LAST.with(|l| l.set(Some(Instant::now()))) }
    pub fn mark(i: usize) {
        LAST.with(|l| {
            let now = Instant::now();
            if let Some(t) = l.get() { T[i].fetch_add((now - t).as_micros() as u64, Ordering::Relaxed); }
            l.set(Some(now));
        })
    }
    pub fn now() -> Instant { Instant::now() }
    pub fn add(i: usize, since: Instant) { T[i].fetch_add(since.elapsed().as_micros() as u64, Ordering::Relaxed); }
    pub fn take() -> [f64; N] {
        let mut out = [0.0; N];
        for (i, t) in T.iter().enumerate() { out[i] = t.swap(0, Ordering::Relaxed) as f64 / 1e6 }
        out
    }
}
#[cfg(not(test))]
pub(crate) mod prof {
    #[inline(always)] pub fn start() {}
    #[inline(always)] pub fn mark(_: usize) {}
    pub struct Now;
    #[inline(always)] pub fn now() -> Now { Now }
    #[inline(always)] pub fn add(_: usize, _: Now) {}
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
    // The parts (bundle/): the inputs parsed (problem.rs), the reduced system's variables
    // (layout.rs), the observation model (model.rs), the normal equations and their Schur
    // reduction (normal.rs, implicit.rs), the lens σ (sigma.rs). This is the LM loop.
    let t0 = prof::now();
    let Some((problem, cams, pts)) = Problem::parse(cameras_flat, intrinsics_flat, pts_flat, obs_index, obs_px,
        observation_weight, anchor_flat, anchor_weight, camera_prior_flat, fisheye_flat, rs_flat, capture_of_cam,
        offset_flat) else { return vec![] };
    prof::add(5, t0);
    let t0 = prof::now();
    let layout = Layout::new(&problem, sensor_of_cam, refine_mask, fixed_cam);
    prof::add(6, t0);
    let solver = SolverOpts::from_flat(solver_flat);
    let m = Model { p: &problem, l: &layout, huber: solver.huber };
    let plan = Plan::new(&m, &solver);
    // A small problem runs on this thread alone (par.rs `Inline`), see POOL_MIN_OBS.
    let pool_min = if plan.range_plan.is_some() { POOL_MIN_OBS_RANGES } else { POOL_MIN_OBS_CHUNKS };
    let _inline = crate::par::Inline::new(problem.obs.len() < pool_min);
    let (n, n_pts, refine) = (layout.n, problem.n_pts, layout.refine);
    let mut solve_stats = SolveStats::default();
    let mut st = State { cams, pts, gpar: m.initial_gpar() };

    let t0 = prof::now();
    let mut w = Work::new(&plan, n);
    prof::add(13, t0);
    // The accepted state's residuals, when kept (Plan::keep_res): one projection per
    // iteration instead of four (threshold, start cost, trial cost, trace), same sums.
    let keep = plan.keep_res;
    let cost_before = if keep { m.fill_residuals(&st, &mut w.res); Model::rms_of(&w.res) } else { m.rms(&st) };
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
    for outer in 0.. {
        if outer >= max_iters && !cov_pass {
            if !want_cov { break; }
            cov_pass = true;
        }
        if cov_pass { lambda = 0.0; }
        prof::start();
        let dh = if keep { m.huber_threshold_of(&w.res) } else { m.huber_threshold(&st) };
        let mut cost = if keep { m.robust_cost_of(&w.res, &st, dh) } else { m.robust_cost(&st, dh) };
        let cost_at_start = cost; // this iteration's robust cost, for the function-tolerance stop
        prof::mark(0);
        let nrm = assemble(&m, &plan, &st, dh, &mut w);
        prof::mark(1);

        // ── LM step with damping retries ────────────────────────────────────────
        // A rejected step raises the damping ×4 and tries again, up to its cap: only a
        // step rejected at the cap (one barely off the gradient, ×10⁻⁸ of it) ends the run.
        // Giving up after a fixed 8 tries left a model with a bad start where its first
        // iteration took it (×28 Ceres' cost on the largest BAL Ladybug problems), since
        // 8 tries raise λ only from its working level to ~20 (docs/METHODS.md §4.5).
        let mut accepted = false;
        for _try in 0..LM_MAX_TRIES {
            let Reduced { ok, rhs, cinv_store } = eliminate(&m, &plan, &st, dh, lambda, &nrm, &mut w);
            if cov_pass {
                if ok {
                    if plan.implicit { last_implicit = Some((std::mem::take(&mut w.b_damped), std::mem::take(&mut w.s), cinv_store)); }
                    else { last_s = Some(std::mem::take(&mut w.s)); }
                }
                break;
            }
            if !ok { lambda = (lambda * 4.0).min(LAMBDA_MAX); continue; }

            prof::mark(2);
            let pattern = &plan.pattern;
            let dsol = if let Some(sym) = plan.direct.as_ref() {
                solve_stats.solves += 1;
                solve_stats.cholesky += 1;
                match sym.factor_reusing(pattern, &w.s, std::mem::take(&mut w.work)) {
                    Ok(f) => { let x = f.solve(pattern, &rhs); w.work = f.into_vals(); x }
                    Err(buf) => { w.work = buf; lambda = (lambda * 4.0).min(LAMBDA_MAX); continue; }
                }
            } else if plan.implicit {
                if plan.use_jcache && w.jcache_outer != outer {
                    fill_jcache(&m, &plan, &st, dh, &mut w.jcache);
                    w.jcache_outer = outer;
                }
                let shares = std::cell::RefCell::new(std::mem::take(&mut w.share_r));
                let matvec = |x: &[f64], y: &mut [f64]| {
                    implicit_product(&m, &plan, &w.b_damped, &cinv_store, &w.jcache, &mut shares.borrow_mut(), &st, dh, x, y)
                };
                let res = pcg_truncated(n, matvec, &pattern.diag_blocks(&w.s), &rhs, IMPLICIT_ETA, IMPLICIT_MAX_ITER);
                w.share_r = shares.into_inner();
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
                let s = &w.s;
                let ic = if solver.precond == 1 && (n >= solver.pcg_min_n || n > DENSE_MAX_N) { BlockIc::new(pattern, s) } else { None };
                match solve_reduced_with(n, |x, y| pattern.matvec(s, x, y), &pattern.diag_blocks(s), ic.as_ref(),
                                         || pattern.to_dense(s), n <= DENSE_MAX_N, &rhs, &solver, &mut solve_stats) {
                    Some(x) => x,
                    None => { lambda = (lambda * 4.0).min(LAMBDA_MAX); continue; }
                }
            };

            prof::mark(3);
            // δX is written where the tentative points will be, turned into X + δX below,
            // so the step needs no array of its own.
            let mut tent_pts = back_substitute(&m, &plan, &w, &st, dh, &cinv_store, &nrm.gpv, &dsol);

            // Tentative update: t += δt, R = exp(δω)·R, X += δX, group params += δ.
            let mut tent_cams = st.cams.clone();
            for (k, &c) in layout.free_cams.iter().enumerate() {
                let (r0, t0) = st.cams[c];
                let dt = [dsol[6*k], dsol[6*k+1], dsol[6*k+2]];
                let dw = [dsol[6*k+3], dsol[6*k+4], dsol[6*k+5]];
                tent_cams[c] = (mat3_mul(&so3_exp(&dw), &r0), [t0[0]+dt[0], t0[1]+dt[1], t0[2]+dt[2]]);
            }
            let mut tent_gpar = st.gpar.clone();
            if refine {
                let (kdim, group_off) = (layout.kdim, layout.group_off);
                for g in 0..layout.g_count {
                    let goff = group_off + g * kdim;
                    // Slots are contiguous per group; kdim picks how many.
                    for a in 0..kdim { tent_gpar[g][a] += dsol[goff + a]; }
                }
            }
            // |δX|² first (for the step-size stop), then X + δX in place (= δX + X exactly).
            let dp_sq = tent_pts.iter().map(|d| dot3(d, d)).sum::<f64>();
            for pi in 0..n_pts { for k in 0..3 { tent_pts[pi][k] += st.pts[pi][k]; } }
            let tent = State { cams: tent_cams, pts: tent_pts, gpar: tent_gpar };

            let new_cost = if keep { m.fill_residuals(&tent, &mut w.res_trial); m.robust_cost_of(&w.res_trial, &tent, dh) }
                else { m.robust_cost(&tent, dh) };
            prof::mark(4);
            if new_cost < cost {
                st = tent;
                if keep { std::mem::swap(&mut w.res, &mut w.res_trial); }
                cost = new_cost;
                lambda = (lambda * 0.3).max(LAMBDA_MIN);
                accepted = true;
                break;
            } else {
                if lambda >= LAMBDA_MAX { break; }
                // A rejected step too small to change the model ends it too: a converged
                // model rejects every step to rounding, and more damping only shrinks them.
                let step2 = dsol.iter().map(|v| v * v).sum::<f64>() + dp_sq;
                let size2 = st.pts.iter().map(|x| dot3(x, x)).sum::<f64>()
                    + layout.free_cams.iter().map(|&c| dot3(&st.cams[c].1, &st.cams[c].1)).sum::<f64>()
                    + if refine { st.gpar.iter().map(|g| g.iter().map(|v| v * v).sum::<f64>()).sum::<f64>() } else { 0.0 };
                if step2.sqrt() <= PARAM_TOL * (size2.sqrt() + PARAM_TOL) { break; }
                lambda = (lambda * 4.0).min(LAMBDA_MAX);
            }
        }
        if cov_pass { break; }
        // No step lowers the cost, even at the largest damping.
        let done = if !accepted { true } else {
            trace.push(if keep { Model::rms_of(&w.res) } else { m.rms(&st) });
            // Compared within one iteration only: the Huber threshold is re-derived from
            // the residuals at the top of each iteration, so costs of different iterations
            // sit on different scales.
            plan.function_tol > 0.0 && cost_at_start - cost <= plan.function_tol * cost_at_start
        };
        if done {
            if !want_cov { break; }
            cov_pass = true;
        }
    }

    let cost_after = if keep { Model::rms_of(&w.res) } else { m.rms(&st) };
    let anchor_rms_after = problem.anchor_rms(&st.pts);
    let camera_prior_rms_after = problem.camera_prior_rms(&st.cams);
    let cov_state = if !want_cov { None } else if let Some(s) = last_s.take() { Some((s, None)) }
        else { last_implicit.take().map(|(b, pre, cinv)| (pre, Some((b, cinv)))) };
    let sigmas = match cov_state {
        Some((s, imp)) => lens_sigmas(&m, &plan, &st, &solver, s, imp, &mut w),
        None => Vec::new(),
    };

    // Pack output: cameras (12 each), points (3 each), refined effective intrinsics
    // (8 each: fx,fy,cx,cy,k1,k2,k3,k4 — a pinhole camera's Brown residual, 0 for the
    // bits not in refine_mask; a fisheye's full Kannala–Brandt coefficients),
    // [cost_before, cost_after, anchor_rms_after, camera_prior_rms_after], then trace.
    let t0 = prof::now();
    let n_cam = problem.n_cam;
    let intr_stride = if problem.lens_stride == 7 { 10 } else { 8 };
    let mut out = Vec::with_capacity(n_cam * 12 + n_pts * 3 + n_cam * intr_stride + 4 + BA_STATS_LEN + trace.len());
    for c in 0..n_cam {
        let (r, t) = m.pose_of(c, &st.cams, &st.gpar);
        for row in &r { for &v in row { out.push(v as f32); } }
        for &v in &t { out.push(v as f32); }
    }
    for pt in &st.pts {
        for &v in pt { out.push(v as f32); }
    }
    for c in 0..n_cam {
        let e = m.eff(c, &st.gpar);
        out.push(e.fx as f32); out.push(e.fy as f32); out.push(e.cx as f32); out.push(e.cy as f32);
        for j in 0..4 { out.push(e.k[j] as f32); }
        if intr_stride == 10 { out.push(e.p[0] as f32); out.push(e.p[1] as f32); }
    }
    out.push(cost_before as f32);
    out.push(cost_after as f32);
    out.push(anchor_rms_after as f32);
    out.push(camera_prior_rms_after as f32);
    let ss = &solve_stats;
    for v in [n as f64, ss.solves as f64, ss.cholesky as f64, ss.pcg_converged as f64, ss.pcg_partial as f64,
              ss.pcg_fallback as f64, ss.pcg_npd as f64, ss.pcg_iters as f64, ss.pcg_iters_max as f64, ss.implicit as f64] {
        out.push(v as f32);
    }
    if solver.covariance {
        // An empty section (no lens refined, or no accepted step) is [0].
        out.push((sigmas.len() / LENS_SIGMA_LEN) as f32);
        for &v in &sigmas { out.push(v as f32); }
    }
    if !rs_flat.is_empty() { for c in 0..n_cam { out.push(m.tau_of(c, &st.gpar) as f32); } }
    for &c in &trace { out.push(c as f32); }
    prof::add(14, t0);
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
