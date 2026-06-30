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

/// Bundle adjustment by sparse Levenberg–Marquardt with the Schur complement.
///
/// Jointly refines every camera pose (6-DOF: left-perturbed so(3) rotation +
/// translation; intrinsics held fixed) and every 3D point to minimise a
/// Huber-robustified reprojection error. The normal equations are reduced with
/// the Schur complement (points eliminated against the cameras) into a dense
/// reduced-camera system solved by Cholesky — true global BA, not the old
/// coordinate descent. The Huber threshold adapts to the residual median, so
/// surviving gross mis-triangulations cannot drag the solution.
///
/// At large camera counts the dense reduced-camera Cholesky (`chol_solve`) is the
/// only part that needs swapping for an iterative Schur solve; assembly and the
/// rest of the loop are size-independent.
///
/// # Inputs
/// - `cameras_flat`: n_cam × 12 floats `[R(9)|t(3), R(9)|t(3), …]`
/// - `intrinsics_flat`: n_cam × 4 floats `[fx,fy,cx,cy, …]`
/// - `pts_flat`: n_pts × 3 floats `[x,y,z, …]`
/// - `obs_flat`: n_obs × 4 floats `[cam_i, pt_i, pixel_x, pixel_y, …]`
/// - `max_iters`: outer LM iterations
///
/// # Output
/// `[cameras_flat(n_cam×12), pts_flat(n_pts×3), cost_before, cost_after]`
/// (cost_* are RMS reprojection error in pixels).
#[wasm_bindgen]
pub fn bundle_adjust(
    cameras_flat: &[f32],
    intrinsics_flat: &[f32],
    pts_flat: &[f32],
    obs_flat: &[f32],
    max_iters: u32,
) -> Vec<f32> {
    let n_cam = cameras_flat.len() / 12;
    let n_pts = pts_flat.len() / 3;
    let n_obs = obs_flat.len() / 4;
    if n_cam == 0 || n_pts == 0 || n_obs == 0 { return vec![]; }

    // Unpack cameras / intrinsics / points / observations.
    let mut cams: Vec<(M3, V3)> = (0..n_cam).map(|c| {
        let b = c * 12;
        let r: M3 = [[cameras_flat[b]   as f64, cameras_flat[b+1] as f64, cameras_flat[b+2]  as f64],
                     [cameras_flat[b+3] as f64, cameras_flat[b+4] as f64, cameras_flat[b+5]  as f64],
                     [cameras_flat[b+6] as f64, cameras_flat[b+7] as f64, cameras_flat[b+8]  as f64]];
        let t: V3 = [cameras_flat[b+9] as f64, cameras_flat[b+10] as f64, cameras_flat[b+11] as f64];
        (r, t)
    }).collect();
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

    // Plain RMS reprojection error over all observations (reported to the caller).
    let rms = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>| -> f64 {
        let mut sse = 0.0f64; let mut cnt = 0usize;
        for &(ci, pi, ox, oy) in &obs {
            let (r, t) = &cams[ci];
            let (fx, fy, cx, cy) = ks[ci];
            let (px, py) = project(&make_p34(r, t), fx, fy, cx, cy, &pts[pi]);
            if px.is_nan() { continue; }
            sse += (px - ox).powi(2) + (py - oy).powi(2); cnt += 1;
        }
        if cnt == 0 { 0.0 } else { (sse / cnt as f64).sqrt() }
    };

    // Huber-robustified cost Σ ρ(‖r‖) at pixel threshold δ.
    let robust_cost = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>, dh: f64| -> f64 {
        let mut sum = 0.0f64;
        for &(ci, pi, ox, oy) in &obs {
            let (r, t) = &cams[ci];
            let (fx, fy, cx, cy) = ks[ci];
            let (px, py) = project(&make_p34(r, t), fx, fy, cx, cy, &pts[pi]);
            if px.is_nan() { sum += dh * dh; continue; }
            let e2 = (px - ox).powi(2) + (py - oy).powi(2);
            let e = e2.sqrt();
            sum += if e <= dh { e2 } else { 2.0 * dh * e - dh * dh };
        }
        sum
    };

    // Adaptive Huber threshold: a multiple of the residual median, so it tracks
    // the noise floor as the model tightens (generous early, tight near
    // convergence). Recomputed once per outer iteration.
    let huber_threshold = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>| -> f64 {
        let mut es: Vec<f64> = Vec::with_capacity(obs.len());
        for &(ci, pi, ox, oy) in &obs {
            let (r, t) = &cams[ci];
            let (fx, fy, cx, cy) = ks[ci];
            let (px, py) = project(&make_p34(r, t), fx, fy, cx, cy, &pts[pi]);
            if px.is_nan() { continue; }
            es.push(((px - ox).powi(2) + (py - oy).powi(2)).sqrt());
        }
        if es.is_empty() { return 1.0; }
        es.sort_by(|a, b| a.partial_cmp(b).unwrap());
        (2.5 * es[es.len() / 2]).max(1.0)
    };

    let cost_before = rms(&cams, &pts);

    let n = 6 * n_cam;       // reduced (camera) system dimension
    let mut lambda = 1e-3f64; // LM damping
    let mut trace: Vec<f64> = Vec::new(); // RMS after each accepted iteration

    for _outer in 0..max_iters {
        let dh = huber_threshold(&cams, &pts);
        let mut cost = robust_cost(&cams, &pts, dh);

        // ── Assemble undamped blocks ────────────────────────────────────────
        // B (per-camera 6×6), gc (per-camera 6); per-point C (3×3), gp (3); and
        // the 6×3 coupling block E to each observing camera.
        let mut bmat = vec![[[0f64; 6]; 6]; n_cam];
        let mut gc = vec![[0f64; 6]; n_cam];
        let mut cmat = vec![[[0f64; 3]; 3]; n_pts];
        let mut gp = vec![[0f64; 3]; n_pts];
        let mut emap: Vec<Vec<(usize, [[f64; 3]; 6])>> = vec![vec![]; n_pts];

        for pi in 0..n_pts {
            for &(ci, ox, oy) in &pt_obs[pi] {
                let (r, t) = &cams[ci];
                let (fx, fy, cx, cy) = ks[ci];
                let pc = mat3_vec(r, &pts[pi]); // R·X
                let xc = pc[0] + t[0]; let yc = pc[1] + t[1]; let zc = pc[2] + t[2];
                if zc.abs() < 1e-9 { continue; }
                let inv = 1.0 / zc;
                let ru = fx * xc * inv + cx - ox;
                let rv = fy * yc * inv + cy - oy;
                // ∂proj/∂x_cam (2×3).
                let dudc = [fx * inv, 0.0, -fx * xc * inv * inv];
                let dvdc = [0.0, fy * inv, -fy * yc * inv * inv];
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
                // Huber IRLS weight.
                let e = (ru*ru + rv*rv).sqrt();
                let w = if e <= dh { 1.0 } else { dh / e };

                for a in 0..6 {
                    gc[ci][a] += w * (ju[a]*ru + jv[a]*rv);
                    for b in 0..6 { bmat[ci][a][b] += w * (ju[a]*ju[b] + jv[a]*jv[b]); }
                }
                for a in 0..3 {
                    gp[pi][a] += w * (jpu[a]*ru + jpv[a]*rv);
                    for b in 0..3 { cmat[pi][a][b] += w * (jpu[a]*jpu[b] + jpv[a]*jpv[b]); }
                }
                // Coupling E_{ci,pi} += w·Jcᵀ·Jp (6×3), merged per camera.
                let mut blk = [[0f64; 3]; 6];
                for a in 0..6 {
                    for b in 0..3 { blk[a][b] = w * (ju[a]*jpu[b] + jv[a]*jpv[b]); }
                }
                match emap[pi].iter_mut().find(|(c, _)| *c == ci) {
                    Some((_, ex)) => { for a in 0..6 { for b in 0..3 { ex[a][b] += blk[a][b]; } } }
                    None => emap[pi].push((ci, blk)),
                }
            }
        }

        // ── LM step with damping retries ────────────────────────────────────
        let mut accepted = false;
        for _try in 0..8 {
            // S·δc = rhs,  S = (B+λ) − Σ_p E·(C+λ)⁻¹·Eᵀ,  rhs = −gc + Σ_p E·(C+λ)⁻¹·gp.
            let mut s = vec![0f64; n * n];
            let mut rhs = vec![0f64; n];
            for c in 0..n_cam {
                let mut bc = bmat[c];
                for i in 0..6 { bc[i][i] = bc[i][i] * (1.0 + lambda) + 1e-12; }
                for i in 0..6 {
                    rhs[6*c + i] = -gc[c][i];
                    for j in 0..6 { s[(6*c + i)*n + 6*c + j] = bc[i][j]; }
                }
            }
            let mut cinv_store: Vec<Option<M3>> = vec![None; n_pts];
            let mut tmp_store: Vec<V3> = vec![[0.0; 3]; n_pts];
            let mut ok = true;
            for pi in 0..n_pts {
                if emap[pi].is_empty() { continue; }
                let mut cp = cmat[pi];
                for i in 0..3 { cp[i][i] = cp[i][i] * (1.0 + lambda) + 1e-12; }
                let cinv = match inv3(&cp) { Some(m) => m, None => { ok = false; break; } };
                let tmp = mat3_vec(&cinv, &gp[pi]); // C⁻¹·gp
                cinv_store[pi] = Some(cinv);
                tmp_store[pi] = tmp;
                for (c, ec) in &emap[pi] {
                    for i in 0..6 {
                        rhs[6*c + i] += ec[i][0]*tmp[0] + ec[i][1]*tmp[1] + ec[i][2]*tmp[2];
                    }
                }
                // S -= Σ E_{c1}·C⁻¹·E_{c2}ᵀ. Precompute M_c = E_c·C⁻¹ (6×3).
                let ms: Vec<(usize, [[f64; 3]; 6])> = emap[pi].iter().map(|(c, ec)| {
                    let mut m = [[0f64; 3]; 6];
                    for i in 0..6 {
                        for k in 0..3 {
                            m[i][k] = ec[i][0]*cinv[0][k] + ec[i][1]*cinv[1][k] + ec[i][2]*cinv[2][k];
                        }
                    }
                    (*c, m)
                }).collect();
                for (c1, m1) in &ms {
                    for (c2, e2) in &emap[pi] {
                        for i in 0..6 {
                            for j in 0..6 {
                                let v = m1[i][0]*e2[j][0] + m1[i][1]*e2[j][1] + m1[i][2]*e2[j][2];
                                s[(6*c1 + i)*n + 6*c2 + j] -= v;
                            }
                        }
                    }
                }
            }
            if !ok { lambda = (lambda * 4.0).min(1e8); continue; }

            let dc = match chol_solve(n, &s, &rhs) {
                Some(x) => x,
                None => { lambda = (lambda * 4.0).min(1e8); continue; }
            };

            // Back-substitute points: δp = −C⁻¹·gp − C⁻¹·(Σ_c E_cᵀ·δc_c).
            let mut dp = vec![[0f64; 3]; n_pts];
            for pi in 0..n_pts {
                let cinv = match cinv_store[pi] { Some(m) => m, None => continue };
                let mut acc = [0f64; 3];
                for (c, ec) in &emap[pi] {
                    for k in 0..3 {
                        let mut sdot = 0.0;
                        for i in 0..6 { sdot += ec[i][k] * dc[6*c + i]; }
                        acc[k] += sdot;
                    }
                }
                let ca = mat3_vec(&cinv, &acc);
                for k in 0..3 { dp[pi][k] = -tmp_store[pi][k] - ca[k]; }
            }

            // Tentative update: t += δt, R = exp(δω)·R, X += δX.
            let mut tent_cams = cams.clone();
            for c in 0..n_cam {
                let (r0, t0) = cams[c];
                let dt = [dc[6*c], dc[6*c+1], dc[6*c+2]];
                let dw = [dc[6*c+3], dc[6*c+4], dc[6*c+5]];
                tent_cams[c] = (mat3_mul(&so3_exp(&dw), &r0), [t0[0]+dt[0], t0[1]+dt[1], t0[2]+dt[2]]);
            }
            let mut tent_pts = pts.clone();
            for pi in 0..n_pts { for k in 0..3 { tent_pts[pi][k] += dp[pi][k]; } }

            let new_cost = robust_cost(&tent_cams, &tent_pts, dh);
            if new_cost < cost {
                cams = tent_cams;
                pts = tent_pts;
                cost = new_cost;
                lambda = (lambda * 0.3).max(1e-9);
                accepted = true;
                break;
            } else {
                lambda = (lambda * 4.0).min(1e8);
            }
        }
        if !accepted { break; } // converged or stuck at this damping
        trace.push(rms(&cams, &pts));
    }

    let cost_after = rms(&cams, &pts);

    // Pack output: cameras (12 each), points (3 each), [cost_before, cost_after],
    // then the per-iteration RMS convergence trace (variable length).
    let mut out = Vec::with_capacity(n_cam * 12 + n_pts * 3 + 2 + trace.len());
    for (r, t) in &cams {
        for row in r { for &v in row { out.push(v as f32); } }
        for &v in t { out.push(v as f32); }
    }
    for pt in &pts {
        for &v in pt { out.push(v as f32); }
    }
    out.push(cost_before as f32);
    out.push(cost_after as f32);
    for &c in &trace { out.push(c as f32); }
    out
}

