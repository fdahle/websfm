// Two-view & PnP pose estimation: P3P (Lambda-Twist), Procrustes alignment,
// Gauss–Newton pose refinement, and the wasm entry points recover_pose,
// triangulate_dlt and solve_pnp.
use wasm_bindgen::prelude::*;
use crate::linalg::*;

// ── P3P (Lambda-Twist) ────────────────────────────────────────────────────────
// Minimal 3-point pose solver. Given three world points and three *unit* bearing
// vectors (calibrated rays in the camera frame), returns up to four (R, t) with
// world → camera convention: x_cam = R·X_world + t.
//
// Reference: Persson & Nordberg, "Lambda Twist: An Accurate Fast Robust
// Perspective Three Point (P3P) Solver", ECCV 2018. We recover per-point depths
// λᵢ along the bearings, reconstruct the points in the camera frame, then align
// to the world points with a rigid Procrustes fit. Far more stable than DLT on
// near-planar scenes — the reason aerial cameras now register.
pub(crate) fn p3p_lambda_twist(world: &[V3; 3], bearings: &[V3; 3]) -> Vec<(M3, V3)> {
    let (b1, b2, b3) = (bearings[0], bearings[1], bearings[2]);
    let (x1, x2, x3) = (world[0], world[1], world[2]);

    let sub = |a: &V3, b: &V3| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let d12 = sub(&x1, &x2);
    let d13 = sub(&x1, &x3);
    let d23 = sub(&x2, &x3);
    let a12 = dot3(&d12, &d12);
    let a13 = dot3(&d13, &d13);
    let a23 = dot3(&d23, &d23);
    if a12 < 1e-12 || a13 < 1e-12 || a23 < 1e-12 { return vec![]; }

    let b12 = dot3(&b1, &b2);
    let b13 = dot3(&b1, &b3);
    let b23 = dot3(&b2, &b3);

    // Pairwise distance-constraint quadratic forms in λ = (λ1, λ2, λ3):
    //   λᵀ·M·λ = aᵢⱼ  ⟺  λᵢ² + λⱼ² − 2·cos·λᵢλⱼ = aᵢⱼ.
    let m1: M3 = [[1.0, -b12, 0.0], [-b12, 1.0, 0.0], [0.0, 0.0, 0.0]]; // pair (1,2), = a12
    let m2: M3 = [[1.0, 0.0, -b13], [0.0, 0.0, 0.0], [-b13, 0.0, 1.0]]; // pair (1,3), = a13
    let m3: M3 = [[0.0, 0.0, 0.0], [0.0, 1.0, -b23], [0.0, -b23, 1.0]]; // pair (2,3), = a23

    // Homogeneous combinations vanishing on the solution (constants cancel):
    //   D1 = a23·M1 − a12·M3,  D2 = a23·M2 − a13·M3.
    let mut d1 = [[0f64; 3]; 3];
    let mut d2 = [[0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            d1[i][j] = a23 * m1[i][j] - a12 * m3[i][j];
            d2[i][j] = a23 * m2[i][j] - a13 * m3[i][j];
        }
    }

    // Find γ making D0 = D1 + γ·D2 rank-2 (a pair of planes): det(D1 + γ·D2) = 0.
    // Columns of D1/D2 → cubic coefficients via multilinearity of the determinant.
    let col = |m: &M3, j: usize| [m[0][j], m[1][j], m[2][j]];
    let det_cols = |c0: &V3, c1: &V3, c2: &V3| dot3(c0, &cross3(c1, c2));
    let (a0, a1c, a2c) = (col(&d1, 0), col(&d1, 1), col(&d1, 2));
    let (g0, g1c, g2c) = (col(&d2, 0), col(&d2, 1), col(&d2, 2));
    let e0 = det_cols(&a0, &a1c, &a2c);
    let e1 = det_cols(&g0, &a1c, &a2c) + det_cols(&a0, &g1c, &a2c) + det_cols(&a0, &a1c, &g2c);
    let e2 = det_cols(&a0, &g1c, &g2c) + det_cols(&g0, &a1c, &g2c) + det_cols(&g0, &g1c, &a2c);
    let e3 = det_cols(&g0, &g1c, &g2c);
    let gammas = solve_cubic(e3, e2, e1, e0);

    let mut solutions: Vec<(M3, V3)> = Vec::new();

    for gamma in gammas {
        if !gamma.is_finite() { continue; }
        // Symmetric rank-2 quadric D0 = D1 + γ·D2.
        let mut d0 = [[0f64; 3]; 3];
        for i in 0..3 {
            for j in 0..3 { d0[i][j] = d1[i][j] + gamma * d2[i][j]; }
        }
        // Eigen-decompose: D0 = Σ σₖ·vₖ·vₖᵀ. A real pair of planes has two nonzero
        // eigenvalues of opposite sign; the third (≈0) is the planes' shared line.
        let mut work = d0;
        let vecs = jacobi3(&mut work);
        let evals = [work[0][0], work[1][1], work[2][2]];
        // Index of the smallest-magnitude eigenvalue (the degenerate direction).
        let mut zi = 0;
        for i in 1..3 { if evals[i].abs() < evals[zi].abs() { zi = i; } }
        let (pi, qi) = match zi { 0 => (1, 2), 1 => (0, 2), _ => (0, 1) };
        let (sp, sq) = (evals[pi], evals[qi]);
        if sp * sq >= 0.0 { continue; } // not a real pair of planes
        let vp = [vecs[0][pi], vecs[1][pi], vecs[2][pi]];
        let vq = [vecs[0][qi], vecs[1][qi], vecs[2][qi]];
        let kp = sp.abs().sqrt();
        let kq = sq.abs().sqrt();
        // Two plane normals n± with n±·λ = 0:  √|σp|·vp ± √|σq|·vq.
        let planes = [
            [kp * vp[0] + kq * vq[0], kp * vp[1] + kq * vq[1], kp * vp[2] + kq * vq[2]],
            [kp * vp[0] - kq * vq[0], kp * vp[1] - kq * vq[1], kp * vp[2] - kq * vq[2]],
        ];

        for n in &planes {
            // Orthonormal basis (p_b, q_b) of the plane n·λ = 0.
            let nn = normalize3(n);
            let axis = {
                let ax = nn[0].abs();
                let ay = nn[1].abs();
                let az = nn[2].abs();
                if ax <= ay && ax <= az { [1.0, 0.0, 0.0] }
                else if ay <= az { [0.0, 1.0, 0.0] }
                else { [0.0, 0.0, 1.0] }
            };
            let dotn = dot3(&axis, &nn);
            let p_b = normalize3(&[axis[0] - dotn * nn[0], axis[1] - dotn * nn[1], axis[2] - dotn * nn[2]]);
            let q_b = cross3(&nn, &p_b);

            // λ = α·p_b + β·q_b. On the solution λᵀ·D1·λ = 0 (homogeneous) gives a
            // quadratic in the ratio α:β → up to two directions on the plane.
            let quad = |m: &M3, u: &V3, v: &V3| {
                let mu = mat3_vec(m, v);
                dot3(u, &mu)
            };
            let aa = quad(&d1, &p_b, &p_b);
            let bb = 2.0 * quad(&d1, &p_b, &q_b);
            let cc = quad(&d1, &q_b, &q_b);
            let dir_ratios: Vec<(f64, f64)> = if aa.abs() < 1e-14 {
                if bb.abs() < 1e-14 { vec![] } else { vec![(1.0, -cc / bb)] }
            } else {
                let disc = bb * bb - 4.0 * aa * cc;
                if disc < 0.0 { vec![] } else {
                    let s = disc.sqrt();
                    vec![((-bb + s) / (2.0 * aa), 1.0), ((-bb - s) / (2.0 * aa), 1.0)]
                }
            };

            for (ar, br) in dir_ratios {
                // Direction λ̂ on the plane; fix scale via the metric constraint
                // λᵀ·M1·λ = a12 (M1 is positive-definite for valid bearings).
                let dir = [ar * p_b[0] + br * q_b[0], ar * p_b[1] + br * q_b[1], ar * p_b[2] + br * q_b[2]];
                let denom = {
                    let mu = mat3_vec(&m1, &dir);
                    dot3(&dir, &mu)
                };
                if denom <= 1e-12 { continue; }
                let scale = (a12 / denom).sqrt();
                let lam = [scale * dir[0], scale * dir[1], scale * dir[2]];
                if lam[0] <= 0.0 || lam[1] <= 0.0 || lam[2] <= 0.0 { continue; } // depths must be positive

                // Camera-frame points cᵢ = λᵢ·bᵢ, then rigid Procrustes world → camera.
                let c1p = [lam[0] * b1[0], lam[0] * b1[1], lam[0] * b1[2]];
                let c2p = [lam[1] * b2[0], lam[1] * b2[1], lam[1] * b2[2]];
                let c3p = [lam[2] * b3[0], lam[2] * b3[1], lam[2] * b3[2]];
                if let Some((r, t)) = procrustes3(&[x1, x2, x3], &[c1p, c2p, c3p]) {
                    solutions.push((r, t));
                }
            }
        }
    }
    solutions
}

// Rigid transform (R, t) aligning three world points to three camera-frame
// points: camᵢ ≈ R·worldᵢ + t (Kabsch on the 3-point set, no scale).
pub(crate) fn procrustes3(world: &[V3; 3], cam: &[V3; 3]) -> Option<(M3, V3)> {
    let mut cw = [0f64; 3];
    let mut cc = [0f64; 3];
    for i in 0..3 {
        for k in 0..3 { cw[k] += world[i][k]; cc[k] += cam[i][k]; }
    }
    for k in 0..3 { cw[k] /= 3.0; cc[k] /= 3.0; }
    // H = Σ (camᵢ − c̄_cam)·(worldᵢ − c̄_world)ᵀ ; R = nearest_rotation(H) = U·Vᵀ.
    let mut h = [[0f64; 3]; 3];
    for i in 0..3 {
        let cwd = [cam[i][0] - cc[0], cam[i][1] - cc[1], cam[i][2] - cc[2]];
        let wwd = [world[i][0] - cw[0], world[i][1] - cw[1], world[i][2] - cw[2]];
        for r in 0..3 {
            for c in 0..3 { h[r][c] += cwd[r] * wwd[c]; }
        }
    }
    let r = nearest_rotation(&h);
    if !r[0][0].is_finite() { return None; }
    // t = c̄_cam − R·c̄_world.
    let rcw = mat3_vec(&r, &cw);
    let t = [cc[0] - rcw[0], cc[1] - rcw[1], cc[2] - rcw[2]];
    Some((r, t))
}

// ── Gauss-Newton pose refinement ──────────────────────────────────────────────
// Minimise Σ‖proj(R·X+t) − obs‖² over the 6-DOF pose (left-perturbed rotation
// exp(ω)·R plus translation), using analytic Jacobians and light LM damping.
// Run on the RANSAC inliers after P3P to polish the minimal-sample estimate.
pub(crate) fn refine_pose(
    r0: M3, t0: V3,
    pts3: &[[f64; 3]], pts2: &[[f64; 2]], inliers: &[bool],
    fx: f64, fy: f64, cx: f64, cy: f64,
    iters: usize,
) -> (M3, V3) {
    let mut r = r0;
    let mut t = t0;
    for _ in 0..iters {
        let mut h = [[0f64; 6]; 6];
        let mut g = [0f64; 6];
        for i in 0..pts3.len() {
            if !inliers[i] { continue; }
            let x = pts3[i];
            let p = mat3_vec(&r, &x); // R·X
            let xc = p[0] + t[0];
            let yc = p[1] + t[1];
            let zc = p[2] + t[2];
            if zc.abs() < 1e-9 { continue; }
            let inv = 1.0 / zc;
            let u = fx * xc * inv + cx;
            let v = fy * yc * inv + cy;
            let ru = u - pts2[i][0];
            let rv = v - pts2[i][1];
            // ∂proj/∂x_cam.
            let dudc = [fx * inv, 0.0, -fx * xc * inv * inv];
            let dvdc = [0.0, fy * inv, -fy * yc * inv * inv];
            // ∂x_cam/∂t = I ; ∂x_cam/∂ω = −[p]_×  (left perturbation).
            let sp = skew(&p);
            let mut ju = [0f64; 6];
            let mut jv = [0f64; 6];
            for k in 0..3 { ju[k] = dudc[k]; jv[k] = dvdc[k]; }
            for k in 0..3 {
                let colk = [-sp[0][k], -sp[1][k], -sp[2][k]];
                ju[3 + k] = dudc[0] * colk[0] + dudc[1] * colk[1] + dudc[2] * colk[2];
                jv[3 + k] = dvdc[0] * colk[0] + dvdc[1] * colk[1] + dvdc[2] * colk[2];
            }
            for a in 0..6 {
                g[a] += ju[a] * ru + jv[a] * rv;
                for b in 0..6 { h[a][b] += ju[a] * ju[b] + jv[a] * jv[b]; }
            }
        }
        for a in 0..6 { h[a][a] *= 1.0 + 1e-3; } // LM damping
        match solve6(&h, &g) {
            // Gauss-Newton step is −H⁻¹·g.
            Some(delta) => {
                t = [t[0] - delta[0], t[1] - delta[1], t[2] - delta[2]];
                let dw = [-delta[3], -delta[4], -delta[5]];
                r = mat3_mul(&so3_exp(&dw), &r);
                let step = norm3(&[delta[0], delta[1], delta[2]]) + norm3(&dw);
                if step < 1e-9 { break; }
            }
            None => break,
        }
    }
    (r, t)
}

// Reprojection error squared for a single observation (pixel space).
pub(crate) fn reprj_err2(r: &M3, t: &V3, fx: f64, fy: f64, cx: f64, cy: f64,
              x3: &V3, obs_x: f64, obs_y: f64) -> f64 {
    let p = make_p34(r, t);
    let (px, py) = project(&p, fx, fy, cx, cy, x3);
    if px.is_nan() { return 1e18; }
    let dx = px - obs_x; let dy = py - obs_y;
    dx * dx + dy * dy
}

// ── Exported WASM functions ───────────────────────────────────────────────────

/// Recover camera pose from the essential matrix E using a cheirality check.
///
/// # Inputs
/// - `pts_a`: flat N×2 pixel coords [x0,y0,x1,y1,…] for camera A
/// - `pts_b`: flat N×2 pixel coords for camera B
/// - `e_flat`: 9 floats, E matrix row-major
/// - `fx,fy,cx,cy`: intrinsics of camera A (used for back-projection in cheirality)
///
/// # Output
/// `[R00…R22, tx, ty, tz]` = 12 floats (R for camera B relative to A, t unit vector),
/// or empty Vec on failure.
#[wasm_bindgen]
pub fn recover_pose(
    pts_a: &[f32], pts_b: &[f32],
    e_flat: &[f32],
    fx: f32, fy: f32, cx: f32, cy: f32,
) -> Vec<f32> {
    let n = pts_a.len() / 2;
    if n < 5 || e_flat.len() < 9 { return vec![]; }

    let e: M3 = [
        [e_flat[0] as f64, e_flat[1] as f64, e_flat[2] as f64],
        [e_flat[3] as f64, e_flat[4] as f64, e_flat[5] as f64],
        [e_flat[6] as f64, e_flat[7] as f64, e_flat[8] as f64],
    ];
    let candidates = decompose_essential(&e);

    // Camera A: identity
    let ra: M3 = [[1.0,0.0,0.0],[0.0,1.0,0.0],[0.0,0.0,1.0]];
    let ta: V3 = [0.0, 0.0, 0.0];
    let pa = make_p34(&ra, &ta);

    let (fx64, fy64, cx64, cy64) = (fx as f64, fy as f64, cx as f64, cy as f64);

    let mut best_count = 0i32;
    let mut best_r = ra;
    let mut best_t = ta;

    // Use up to 50 point pairs for cheirality
    let step = (n / 50).max(1);

    for (rb, tb) in &candidates {
        let pb = make_p34(rb, tb);
        let mut pos_count = 0i32;
        for k in (0..n).step_by(step) {
            let xa = pts_a[k*2] as f64; let ya = pts_a[k*2+1] as f64;
            let xb = pts_b[k*2] as f64; let yb = pts_b[k*2+1] as f64;
            // Back-project to normalised coords
            let xan = (xa - cx64) / fx64;
            let yan = (ya - cy64) / fy64;
            let xbn = (xb - cx64) / fx64;
            let ybn = (yb - cy64) / fy64;
            let pt = triangulate_point(xan, yan, &pa, xbn, ybn, &pb);
            if pt[2].is_nan() { continue; }
            let depth_a = depth_in_camera(&pa, &pt);
            let depth_b = depth_in_camera(&pb, &pt);
            if depth_a > 0.0 && depth_b > 0.0 { pos_count += 1; }
        }
        if pos_count > best_count {
            best_count = pos_count;
            best_r = *rb;
            best_t = *tb;
        }
    }

    if best_count == 0 { return vec![]; }

    let mut out = Vec::with_capacity(12);
    for row in &best_r { for &v in row { out.push(v as f32); } }
    for &v in &best_t { out.push(v as f32); }
    out
}

/// Triangulate N point pairs via linear DLT.
///
/// # Inputs
/// - `pts_a`: flat N×2 pixel coords (normalised image coords, i.e. after K^{-1})
/// - `pts_b`: flat N×2 pixel coords (normalised)
/// - `p_a`: 12 floats, 3×4 projection matrix for camera A (row-major, in normalised coords)
/// - `p_b`: 12 floats, 3×4 for camera B
///
/// # Output
/// Flat N×3 `[x,y,z, …]`. NaN triples for degenerate rows.
#[wasm_bindgen]
pub fn triangulate_dlt(
    pts_a: &[f32], pts_b: &[f32],
    p_a: &[f32], p_b: &[f32],
) -> Vec<f32> {
    if p_a.len() < 12 || p_b.len() < 12 { return vec![]; }
    let n = pts_a.len() / 2;

    let pa: M34 = [
        [p_a[0] as f64, p_a[1] as f64,  p_a[2] as f64,  p_a[3] as f64],
        [p_a[4] as f64, p_a[5] as f64,  p_a[6] as f64,  p_a[7] as f64],
        [p_a[8] as f64, p_a[9] as f64,  p_a[10] as f64, p_a[11] as f64],
    ];
    let pb: M34 = [
        [p_b[0] as f64, p_b[1] as f64,  p_b[2] as f64,  p_b[3] as f64],
        [p_b[4] as f64, p_b[5] as f64,  p_b[6] as f64,  p_b[7] as f64],
        [p_b[8] as f64, p_b[9] as f64,  p_b[10] as f64, p_b[11] as f64],
    ];

    let mut out = Vec::with_capacity(n * 3);
    for i in 0..n {
        let xa = pts_a[i*2] as f64; let ya = pts_a[i*2+1] as f64;
        let xb = pts_b[i*2] as f64; let yb = pts_b[i*2+1] as f64;
        let pt = triangulate_point(xa, ya, &pa, xb, yb, &pb);
        out.push(pt[0] as f32);
        out.push(pt[1] as f32);
        out.push(pt[2] as f32);
    }
    out
}

/// Estimate camera pose from 3D-2D correspondences via P3P (Lambda-Twist) inside
/// an MSAC loop, then a Gauss-Newton polish on the inliers.
///
/// The minimal 3-point P3P sampler is dramatically more stable than the old
/// 6-point DLT on near-planar / aerial scenes (the geometry that previously
/// failed to register), MSAC scoring picks a cleaner consensus than plain inlier
/// counting, and the analytic-Jacobian refinement drives the pose to the true
/// minimum rather than the best minimal-sample estimate.
///
/// # Inputs
/// - `pts_3d`: flat N×3 world points `[x,y,z,…]`
/// - `pts_2d`: flat N×2 pixel observations `[x,y,…]`
/// - `fx,fy,cx,cy`: camera intrinsics
/// - `ransac_thresh_px`: inlier reprojection threshold (pixels)
/// - `max_iters`: RANSAC iterations
///
/// # Output
/// `[R00…R22, tx,ty,tz, inlier_0, inlier_1, …, inlier_N]` = 12 + N floats,
/// or empty Vec on failure.
#[wasm_bindgen]
pub fn solve_pnp(
    pts_3d: &[f32], pts_2d: &[f32],
    fx: f32, fy: f32, cx: f32, cy: f32,
    ransac_thresh_px: f32,
    max_iters: u32,
) -> Vec<f32> {
    let n = pts_3d.len() / 3;
    if n < 4 { return vec![]; }
    let m = pts_2d.len() / 2;
    if m < n { return vec![]; }

    let (fx64, fy64, cx64, cy64) = (fx as f64, fy as f64, cx as f64, cy as f64);
    let thresh2 = (ransac_thresh_px as f64) * (ransac_thresh_px as f64);

    let pts3: Vec<[f64; 3]> = (0..n).map(|i| [pts_3d[i*3] as f64, pts_3d[i*3+1] as f64, pts_3d[i*3+2] as f64]).collect();
    let pts2: Vec<[f64; 2]> = (0..n).map(|i| [pts_2d[i*2] as f64, pts_2d[i*2+1] as f64]).collect();
    // Unit bearing vectors (calibrated rays) for the P3P minimal solver.
    let bearings: Vec<V3> = (0..n).map(|i| {
        normalize3(&[(pts2[i][0] - cx64) / fx64, (pts2[i][1] - cy64) / fy64, 1.0])
    }).collect();

    // Per-observation squared reprojection error WITH a cheirality gate: a point
    // behind the camera (z ≤ 0) projects to a deceptively plausible pixel, so we
    // reject it outright rather than let a mirror pose accrue false inliers.
    let chei_err2 = |r: &M3, t: &V3, i: usize| -> f64 {
        let p = make_p34(r, t);
        if depth_in_camera(&p, &pts3[i]) <= 0.0 { return f64::INFINITY; }
        reprj_err2(r, t, fx64, fy64, cx64, cy64, &pts3[i], pts2[i][0], pts2[i][1])
    };

    let mut rng = Xorshift(n as u32 * 1000 + 7);
    let mut best_cost = f64::INFINITY; // MSAC: Σ min(e², τ²) — lower is better
    let mut best_count = 0usize;
    let mut best_r = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut best_t = [0.0f64; 3];

    let iters = max_iters.max(1);
    for _ in 0..iters {
        let idx = rng.sample_k(n, 3);
        let world = [pts3[idx[0]], pts3[idx[1]], pts3[idx[2]]];
        let brs = [bearings[idx[0]], bearings[idx[1]], bearings[idx[2]]];
        for (r, t) in p3p_lambda_twist(&world, &brs) {
            let mut cost = 0.0;
            let mut count = 0usize;
            for i in 0..n {
                let e2 = chei_err2(&r, &t, i);
                if e2 < thresh2 { count += 1; cost += e2; } else { cost += thresh2; }
            }
            if cost < best_cost {
                best_cost = cost;
                best_count = count;
                best_r = r;
                best_t = t;
            }
        }
    }

    if best_count < 4 { return vec![]; }

    // Gauss-Newton polish on the inliers, re-selecting the inlier set after the
    // first refinement so a slightly-off seed can still recruit its true support.
    let mut inliers = vec![false; n];
    for i in 0..n { inliers[i] = chei_err2(&best_r, &best_t, i) < thresh2; }
    for _ in 0..2 {
        let (r, t) = refine_pose(best_r, best_t, &pts3, &pts2, &inliers, fx64, fy64, cx64, cy64, 10);
        best_r = r;
        best_t = t;
        for i in 0..n { inliers[i] = chei_err2(&best_r, &best_t, i) < thresh2; }
    }

    if inliers.iter().filter(|&&b| b).count() < 4 { return vec![]; }

    let mut out = Vec::with_capacity(12 + n);
    for row in &best_r { for &v in row { out.push(v as f32); } }
    for &v in &best_t { out.push(v as f32); }
    for b in &inliers { out.push(if *b { 1.0 } else { 0.0 }); }
    out
}

