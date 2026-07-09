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

// Pinhole projection with one shared radial term k1 (Brown r² model):
// u = fx·a·(1+k1·r²)+cx, v = fy·b·(1+k1·r²)+cy, with a,b = normalised camera
// coords (xc/zc, yc/zc). k1 = 0 reduces to the plain pinhole projection.
fn project_k1(r: &M3, t: &V3, fx: f64, fy: f64, cx: f64, cy: f64, k1: f64, x: &V3) -> (f64, f64) {
    let pc = mat3_vec(r, x);
    let (xc, yc, zc) = (pc[0] + t[0], pc[1] + t[1], pc[2] + t[2]);
    if zc.abs() < 1e-9 { return (f64::NAN, f64::NAN); }
    let a = xc / zc; let b = yc / zc;
    let r2 = a * a + b * b; let d = 1.0 + k1 * r2;
    (fx * a * d + cx, fy * b * d + cy)
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
/// frame) with an extra quadratic residual `w·‖pt − target‖²`. This only ever
/// touches that point's own 3×3 block (gradient + diagonal Hessian) — no camera
/// Jacobian, no new coupling — so it folds into the existing per-point Schur
/// elimination for free. Empty anchor arrays reduce to today's behaviour exactly.
///
/// # Inputs
/// - `cameras_flat`: n_cam × 12 floats `[R(9)|t(3), …]`
/// - `intrinsics_flat`: n_cam × 4 floats `[fx,fy,cx,cy, …]` (the seed / base K)
/// - `pts_flat`: n_pts × 3 floats `[x,y,z, …]`
/// - `obs_flat`: n_obs × 4 floats `[cam_i, pt_i, pixel_x, pixel_y, …]`
/// - `anchor_flat`: n_anchor × 4 floats `[pt_i, target_x, target_y, target_z, …]`
/// - `anchor_weight`: n_anchor floats, one `1/sigma²` weight per anchor (aligned
///   with `anchor_flat`'s rows; missing entries default to weight 1)
/// - `max_iters`: outer LM iterations
/// - `sensor_of_cam`: n_cam ints — per-camera sensor id (shared → shared focal);
///   `< 0` (or a short/empty list) ⇒ that camera is its own group
/// - `refine_mode`: 0 = none (poses+points only), 1 = focal, 2 = focal + cx,cy,
///   3 = focal + a shared radial k1 (Brown r² distortion)
///
/// # Output
/// `[cameras_flat(n_cam×12), pts_flat(n_pts×3), intrinsics_flat(n_cam×5),
///   cost_before, cost_after, anchor_rms_after, cost_trace…]` — the returned
/// intrinsics are the **refined** effective K per camera as `[fx,fy,cx,cy,k1]`
/// (k1 = 0 unless `refine_mode == 3`, identical to the input K when
/// `refine_mode == 0`); cost_before/cost_after are RMS reprojection error in
/// pixels (anchors do not affect them); anchor_rms_after is the RMS anchor
/// residual in the caller's world units (0 when there are no anchors).
#[wasm_bindgen]
pub fn bundle_adjust(
    cameras_flat: &[f32],
    intrinsics_flat: &[f32],
    pts_flat: &[f32],
    obs_flat: &[f32],
    anchor_flat: &[f32],
    anchor_weight: &[f32],
    max_iters: u32,
    sensor_of_cam: &[i32],
    refine_mode: u32,
) -> Vec<f32> {
    let n_cam = cameras_flat.len() / 12;
    let n_pts = pts_flat.len() / 3;
    let n_obs = obs_flat.len() / 4;
    if n_cam == 0 || n_pts == 0 || n_obs == 0 { return vec![]; }

    // Anchors: (point_idx, target position, weight). Points outside range are
    // dropped rather than panicking on a malformed caller payload.
    let n_anchor = anchor_flat.len() / 4;
    let anchors: Vec<(usize, V3, f64)> = (0..n_anchor).map(|i| {
        let b = i * 4;
        let pi = anchor_flat[b] as usize;
        let target: V3 = [anchor_flat[b+1] as f64, anchor_flat[b+2] as f64, anchor_flat[b+3] as f64];
        let w = anchor_weight.get(i).copied().unwrap_or(1.0) as f64;
        (pi, target, w)
    }).filter(|&(pi, _, _)| pi < n_pts).collect();
    let mut anchored = vec![false; n_pts];
    for &(pi, _, _) in &anchors { anchored[pi] = true; }
    let anchor_sse = |pts: &Vec<V3>| -> f64 {
        let mut sum = 0.0f64;
        for &(pi, target, w) in &anchors {
            let dx = pts[pi][0] - target[0]; let dy = pts[pi][1] - target[1]; let dz = pts[pi][2] - target[2];
            sum += w * (dx*dx + dy*dy + dz*dz);
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
    let obs: Vec<(usize, usize, f64, f64)> = (0..n_obs).map(|i| {
        let b = i * 4;
        (obs_flat[b] as usize, obs_flat[b+1] as usize, obs_flat[b+2] as f64, obs_flat[b+3] as f64)
    }).filter(|&(ci, pi, _, _)| ci < n_cam && pi < n_pts).collect();

    // Per-point observation lists — the structure the Schur reduction iterates.
    let mut pt_obs: Vec<Vec<(usize, f64, f64)>> = vec![vec![]; n_pts];
    for &(ci, pi, ox, oy) in &obs { pt_obs[pi].push((ci, ox, oy)); }

    // ── Intrinsic self-calibration setup ─────────────────────────────────────────
    // refine_mode: 1 = focal only [s]; 2 = focal + principal point [s, dcx, dcy];
    // 3 = focal + shared radial k1 [s, k1]. Per-group params are stored in a fixed
    // [f64;3] slot; the layout depends on kdim (1 → [s], 2 → [s,k1], 3 → [s,dcx,dcy]).
    let kdim = match refine_mode { 1 => 1, 2 => 3, 3 => 2, _ => 0 };
    let (grp, g_count) = if kdim > 0 { build_groups(sensor_of_cam, n_cam) } else { (vec![0usize; n_cam], 0) };
    let refine = kdim > 0 && g_count > 0;
    let group_off = 6 * n_cam;            // intrinsic params follow the camera poses
    let n = group_off + if refine { g_count * kdim } else { 0 };
    // Per-group params: s multiplies fx/fy; for kdim==3 slots 1,2 are dcx,dcy; for
    // kdim==2 slot 1 is the shared radial k1 (init 0 = no distortion).
    let mut gpar = vec![[1.0f64, 0.0, 0.0]; g_count.max(1)];

    // Effective K + radial k1 for a camera under the current group params.
    let eff = |ci: usize, gpar: &Vec<[f64; 3]>| -> (f64, f64, f64, f64, f64) {
        let (fx0, fy0, cx0, cy0) = ks[ci];
        if !refine { return (fx0, fy0, cx0, cy0, 0.0); }
        let p = gpar[grp[ci]];
        let (dcx, dcy) = if kdim == 3 { (p[1], p[2]) } else { (0.0, 0.0) };
        let k1 = if kdim == 2 { p[1] } else { 0.0 };
        (p[0] * fx0, p[0] * fy0, cx0 + dcx, cy0 + dcy, k1)
    };

    // Plain RMS reprojection error over all observations (reported to the caller).
    let rms = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; 3]>| -> f64 {
        let mut sse = 0.0f64; let mut cnt = 0usize;
        for &(ci, pi, ox, oy) in &obs {
            let (r, t) = &cams[ci];
            let (fx, fy, cx, cy, k1) = eff(ci, gpar);
            let (px, py) = project_k1(r, t, fx, fy, cx, cy, k1, &pts[pi]);
            if px.is_nan() { continue; }
            sse += (px - ox).powi(2) + (py - oy).powi(2); cnt += 1;
        }
        if cnt == 0 { 0.0 } else { (sse / cnt as f64).sqrt() }
    };

    // Huber-robustified cost Σ ρ(‖r‖) at pixel threshold δ, plus the (unrobustified,
    // quadratic) GCP anchor term — same total objective the LM step below descends.
    let robust_cost = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; 3]>, dh: f64| -> f64 {
        let mut sum = 0.0f64;
        for &(ci, pi, ox, oy) in &obs {
            let (r, t) = &cams[ci];
            let (fx, fy, cx, cy, k1) = eff(ci, gpar);
            let (px, py) = project_k1(r, t, fx, fy, cx, cy, k1, &pts[pi]);
            if px.is_nan() { sum += dh * dh; continue; }
            let e2 = (px - ox).powi(2) + (py - oy).powi(2);
            let e = e2.sqrt();
            sum += if e <= dh { e2 } else { 2.0 * dh * e - dh * dh };
        }
        sum + anchor_sse(pts)
    };

    // Adaptive Huber threshold: a multiple of the residual median, so it tracks the
    // noise floor as the model tightens. Recomputed once per outer iteration.
    let huber_threshold = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; 3]>| -> f64 {
        let mut es: Vec<f64> = Vec::with_capacity(obs.len());
        for &(ci, pi, ox, oy) in &obs {
            let (r, t) = &cams[ci];
            let (fx, fy, cx, cy, k1) = eff(ci, gpar);
            let (px, py) = project_k1(r, t, fx, fy, cx, cy, k1, &pts[pi]);
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

        // GCP anchors: gradient/Hessian of w·‖pt−target‖² touches only that
        // point's own 3×3 block — no camera coupling, so it's just added here.
        for &(pi, target, w) in &anchors {
            gpv[pi][0] += w * (pts[pi][0] - target[0]);
            gpv[pi][1] += w * (pts[pi][1] - target[1]);
            gpv[pi][2] += w * (pts[pi][2] - target[2]);
            cmat[pi][0][0] += w; cmat[pi][1][1] += w; cmat[pi][2][2] += w;
        }

        for pi in 0..n_pts {
            for &(ci, ox, oy) in &pt_obs[pi] {
                let (r, t) = &cams[ci];
                let (fx, fy, cx, cy, k1) = eff(ci, &gpar);
                let pc = mat3_vec(r, &pts[pi]); // R·X
                let xc = pc[0] + t[0]; let yc = pc[1] + t[1]; let zc = pc[2] + t[2];
                if zc.abs() < 1e-9 { continue; }
                let inv = 1.0 / zc;
                // Normalised coords + the shared radial factor d = 1 + k1·r² (d ≡ 1,
                // and every derivative below reduces to the pinhole case, when k1 = 0).
                let a = xc * inv; let b = yc * inv;
                let r2 = a * a + b * b; let d = 1.0 + k1 * r2;
                let ru = fx * a * d + cx - ox;
                let rv = fy * b * d + cy - oy;
                // ∂proj/∂x_cam (2×3) including the radial term (exact analytic):
                //   ∂u/∂xc = (fx/zc)(d+2k1·a²), ∂u/∂yc = (fx/zc)(2k1·a·b),
                //   ∂u/∂zc = −(fx·a/zc)(d+2k1·r²)  (and symmetrically for v).
                let dudc = [fx * inv * (d + 2.0*k1*a*a), fx * inv * (2.0*k1*a*b), -fx * a * inv * (d + 2.0*k1*r2)];
                let dvdc = [fy * inv * (2.0*k1*a*b), fy * inv * (d + 2.0*k1*b*b), -fy * b * inv * (d + 2.0*k1*r2)];
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
                // Intrinsic Jacobian Jk (2×kdim). Focal scale s: ∂/∂s = (fx0·a·d, fy0·b·d).
                // kdim==3 → dcx,dcy: (1,0),(0,1). kdim==2 → radial k1: ∂/∂k1 = (fx·a·r², fy·b·r²).
                let mut jku = [0f64; 3]; let mut jkv = [0f64; 3];
                if refine {
                    let (fx0, fy0, _, _) = ks[ci];
                    jku[0] = fx0 * a * d; jkv[0] = fy0 * b * d;
                    if kdim == 3 { jku[1] = 1.0; jkv[2] = 1.0; }
                    if kdim == 2 { jku[1] = fx * a * r2; jkv[1] = fy * b * r2; }
                }
                // Huber IRLS weight.
                let e = (ru*ru + rv*rv).sqrt();
                let w = if e <= dh { 1.0 } else { dh / e };

                let coff = 6 * ci;
                for a in 0..6 {
                    gr[coff + a] += w * (ju[a]*ru + jv[a]*rv);
                    for b in 0..6 { smat[(coff+a)*n + coff+b] += w * (ju[a]*ju[b] + jv[a]*jv[b]); }
                }
                if refine {
                    let goff = group_off + grp[ci] * kdim;
                    for a in 0..kdim {
                        gr[goff + a] += w * (jku[a]*ru + jkv[a]*rv);
                        for b in 0..kdim { smat[(goff+a)*n + goff+b] += w * (jku[a]*jku[b] + jkv[a]*jkv[b]); }
                        // Cross term camera(coff) ↔ group(goff), both triangles.
                        for b in 0..6 {
                            let v = w * (jku[a]*ju[b] + jkv[a]*jv[b]);
                            smat[(goff+a)*n + coff+b] += v;
                            smat[(coff+b)*n + goff+a] += v;
                        }
                    }
                }
                for a in 0..3 {
                    gpv[pi][a] += w * (jpu[a]*ru + jpv[a]*rv);
                    for b in 0..3 { cmat[pi][a][b] += w * (jpu[a]*jpu[b] + jpv[a]*jpv[b]); }
                }
                // Coupling blocks E (Jvarᵀ·Jp) for this point: camera then group.
                let mut cblk = [[0f64; 3]; 6];
                for a in 0..6 { for b in 0..3 { cblk[a][b] = w * (ju[a]*jpu[b] + jv[a]*jpv[b]); } }
                add_eblock(&mut emap[pi], coff, 6, &cblk);
                if refine {
                    let goff = group_off + grp[ci] * kdim;
                    let mut kblk = [[0f64; 3]; 6];
                    for a in 0..kdim { for b in 0..3 { kblk[a][b] = w * (jku[a]*jpu[b] + jkv[a]*jpv[b]); } }
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

    // Pack output: cameras (12 each), points (3 each), refined effective intrinsics
    // (5 each: fx,fy,cx,cy,k1 — k1 is the shared radial coeff, 0 unless refine_mode==3),
    // [cost_before, cost_after, anchor_rms_after], then the RMS convergence trace.
    let mut out = Vec::with_capacity(n_cam * 12 + n_pts * 3 + n_cam * 5 + 3 + trace.len());
    for (r, t) in &cams {
        for row in r { for &v in row { out.push(v as f32); } }
        for &v in t { out.push(v as f32); }
    }
    for pt in &pts {
        for &v in pt { out.push(v as f32); }
    }
    for c in 0..n_cam {
        let (fx, fy, cx, cy, k1) = eff(c, &gpar);
        out.push(fx as f32); out.push(fy as f32); out.push(cx as f32); out.push(cy as f32); out.push(k1 as f32);
    }
    out.push(cost_before as f32);
    out.push(cost_after as f32);
    out.push(anchor_rms_after as f32);
    for &c in &trace { out.push(c as f32); }
    out
}
