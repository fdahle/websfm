// Hand-rolled, dependency-free (only wasm-bindgen) Structure-from-Motion compute,
// compiled to WASM. Split into focused modules; crate-internal items are re-exported
// here so the integration tests (and any in-crate caller) see a flat namespace.
//
//   linalg  — math/geometry primitives        pose    — P3P / PnP / two-view pose
//   bundle  — bundle adjustment               mvs     — dense PatchMatch stereo

mod linalg;
mod pose;
mod bundle;
mod mvs;

#[allow(unused_imports)] pub(crate) use linalg::*;
#[allow(unused_imports)] pub(crate) use pose::*;
#[allow(unused_imports)] pub(crate) use bundle::*;
#[allow(unused_imports)] pub(crate) use mvs::*;

#[cfg(test)]
mod tests {
    use super::*;

    // Frobenius distance between two 3×3 matrices.
    fn mat_diff(a: &M3, b: &M3) -> f64 {
        let mut s = 0.0;
        for i in 0..3 { for j in 0..3 { s += (a[i][j] - b[i][j]).powi(2); } }
        s.sqrt()
    }

    fn vec_diff(a: &V3, b: &V3) -> f64 {
        ((a[0]-b[0]).powi(2) + (a[1]-b[1]).powi(2) + (a[2]-b[2]).powi(2)).sqrt()
    }

    // Project world point X through a known (R, t) and intrinsics to a pixel.
    fn project_px(r: &M3, t: &V3, fx: f64, fy: f64, cx: f64, cy: f64, x: &V3) -> (f64, f64) {
        let p = mat3_vec(r, x);
        let xc = p[0] + t[0]; let yc = p[1] + t[1]; let zc = p[2] + t[2];
        (fx * xc / zc + cx, fy * yc / zc + cy)
    }

    #[test]
    fn p3p_recovers_known_pose() {
        let r_true = so3_exp(&[0.1, -0.2, 0.15]);
        let t_true = [0.5, -0.3, 4.0];
        let world = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.2], [0.0, 1.0, -0.1]];
        // Bearings = unit camera-frame rays.
        let mut bearings = [[0.0; 3]; 3];
        for i in 0..3 {
            let p = mat3_vec(&r_true, &world[i]);
            let cam = [p[0] + t_true[0], p[1] + t_true[1], p[2] + t_true[2]];
            bearings[i] = normalize3(&cam);
        }
        let sols = p3p_lambda_twist(&world, &bearings);
        assert!(!sols.is_empty(), "P3P returned no solutions");
        let best = sols.iter()
            .map(|(r, t)| mat_diff(r, &r_true) + vec_diff(t, &t_true))
            .fold(f64::INFINITY, f64::min);
        assert!(best < 1e-6, "P3P did not recover the true pose (best err {best})");
    }

    #[test]
    fn solve_pnp_recovers_pose_and_rejects_outliers() {
        let (fx, fy, cx, cy) = (800.0_f64, 800.0_f64, 320.0_f64, 240.0_f64);
        let r_true = so3_exp(&[0.05, 0.1, -0.08]);
        let t_true = [0.2, -0.1, 5.0];

        // Deterministic grid of world points (all in front of the camera given t.z=5).
        let mut world: Vec<V3> = Vec::new();
        for ix in -2..=2 {
            for iy in -2..=2 {
                let z = 0.3 * ((ix + iy) as f64).sin();
                world.push([ix as f64 * 0.8, iy as f64 * 0.8, z]);
            }
        }
        let n_in = world.len();

        let mut flat3: Vec<f32> = Vec::new();
        let mut flat2: Vec<f32> = Vec::new();
        for x in &world {
            let (u, v) = project_px(&r_true, &t_true, fx, fy, cx, cy, x);
            flat3.extend_from_slice(&[x[0] as f32, x[1] as f32, x[2] as f32]);
            flat2.extend_from_slice(&[u as f32, v as f32]);
        }
        // Append 5 gross outliers (same 3D points, pixels shifted far off).
        let n_out = 5;
        for k in 0..n_out {
            let x = world[k];
            let (u, v) = project_px(&r_true, &t_true, fx, fy, cx, cy, &x);
            flat3.extend_from_slice(&[x[0] as f32, x[1] as f32, x[2] as f32]);
            flat2.extend_from_slice(&[(u + 80.0) as f32, (v - 70.0) as f32]);
        }

        let out = solve_pnp(&flat3, &flat2, fx as f32, fy as f32, cx as f32, cy as f32, 2.0, 500);
        assert!(out.len() >= 12 + n_in + n_out, "solve_pnp failed to return a pose");

        let r_est: M3 = [
            [out[0] as f64, out[1] as f64, out[2] as f64],
            [out[3] as f64, out[4] as f64, out[5] as f64],
            [out[6] as f64, out[7] as f64, out[8] as f64],
        ];
        let t_est: V3 = [out[9] as f64, out[10] as f64, out[11] as f64];
        assert!(mat_diff(&r_est, &r_true) < 1e-3, "rotation off: {}", mat_diff(&r_est, &r_true));
        assert!(vec_diff(&t_est, &t_true) < 1e-3, "translation off: {}", vec_diff(&t_est, &t_true));

        let mask = &out[12..];
        let inlier_total: usize = mask[..n_in].iter().filter(|&&b| b > 0.5).count();
        let outlier_flagged: usize = mask[n_in..n_in + n_out].iter().filter(|&&b| b > 0.5).count();
        assert!(inlier_total >= n_in - 2, "too few true inliers kept: {inlier_total}/{n_in}");
        assert_eq!(outlier_flagged, 0, "an outlier was accepted as inlier");
    }

    #[test]
    fn bundle_adjust_reduces_reprojection() {
        let (fx, fy, cx, cy) = (800.0_f64, 800.0_f64, 320.0_f64, 240.0_f64);
        // Ground-truth cameras (a small arc looking toward the scene).
        let gt_cams: Vec<(M3, V3)> = vec![
            (so3_exp(&[0.0, 0.0, 0.0]),       [0.0, 0.0, 6.0]),
            (so3_exp(&[0.05, -0.1, 0.02]),    [0.5, 0.1, 6.2]),
            (so3_exp(&[-0.08, 0.06, -0.03]),  [-0.4, 0.2, 5.8]),
            (so3_exp(&[0.03, 0.12, 0.05]),    [0.2, -0.3, 6.1]),
        ];
        let n_cam = gt_cams.len();
        // Ground-truth points (a 5×5 grid with mild relief).
        let mut gt_pts: Vec<V3> = Vec::new();
        for ix in -2..=2 {
            for iy in -2..=2 {
                gt_pts.push([ix as f64 * 0.5, iy as f64 * 0.5, 0.2 * ((ix * iy) as f64).cos()]);
            }
        }
        let n_pts = gt_pts.len();

        // Noise-free observations: every camera sees every point.
        let mut obs: Vec<f32> = Vec::new();
        for (ci, (r, t)) in gt_cams.iter().enumerate() {
            for (pi, x) in gt_pts.iter().enumerate() {
                let (u, v) = project_px(r, t, fx, fy, cx, cy, x);
                obs.extend_from_slice(&[ci as f32, pi as f32, u as f32, v as f32]);
            }
        }
        let mut k_flat: Vec<f32> = Vec::new();
        for _ in 0..n_cam { k_flat.extend_from_slice(&[fx as f32, fy as f32, cx as f32, cy as f32]); }

        // Perturb the initial cameras and points away from ground truth.
        let mut cam_flat: Vec<f32> = Vec::new();
        for (ci, (r, t)) in gt_cams.iter().enumerate() {
            let w = [0.03 * (ci as f64 + 1.0).sin(), -0.025 * (ci as f64).cos(), 0.02];
            let rp = mat3_mul(&so3_exp(&w), r);
            let tp = [t[0] + 0.1, t[1] - 0.08, t[2] + 0.12];
            for row in &rp { for &v in row { cam_flat.push(v as f32); } }
            for &v in &tp { cam_flat.push(v as f32); }
        }
        let mut pt_flat: Vec<f32> = Vec::new();
        for (pi, x) in gt_pts.iter().enumerate() {
            let d = 0.08;
            pt_flat.push((x[0] + d * (pi as f64).sin()) as f32);
            pt_flat.push((x[1] - d * (pi as f64 * 1.3).cos()) as f32);
            pt_flat.push((x[2] + d * 0.5) as f32);
        }

        let out = bundle_adjust(&cam_flat, &k_flat, &pt_flat, &obs, 60);
        let base = n_cam * 12 + n_pts * 3;
        // cameras + points + [cost_before, cost_after] + per-iteration trace.
        assert!(out.len() >= base + 2, "unexpected BA output length");
        let cost_before = out[base];
        let cost_after = out[base + 1];
        let trace = &out[base + 2..];
        assert!(!trace.is_empty(), "no convergence trace emitted");
        assert!(*trace.last().unwrap() <= cost_after + 1e-3, "trace tail should match final RMS");
        assert!(cost_before > 1.0, "test setup too easy: before {cost_before}px");
        assert!(cost_after < cost_before * 0.1,
            "BA barely improved: {cost_before}px -> {cost_after}px");
        assert!(cost_after < 0.5, "BA did not converge: {cost_after}px");
    }

    // Noisy variant: perturbed cameras + points AND ±0.5px observation noise. The
    // LM solver must (a) never let an accepted step raise the cost — the whole
    // point of the guard the old finite-difference solver lacked — and (b) settle
    // near the injected noise floor rather than the >1px perturbed start.
    #[test]
    fn bundle_adjust_converges_under_noise() {
        let (fx, fy, cx, cy) = (800.0_f64, 800.0_f64, 320.0_f64, 240.0_f64);
        let gt_cams: Vec<(M3, V3)> = vec![
            (so3_exp(&[0.0, 0.0, 0.0]),       [0.0, 0.0, 6.0]),
            (so3_exp(&[0.05, -0.1, 0.02]),    [0.5, 0.1, 6.2]),
            (so3_exp(&[-0.08, 0.06, -0.03]),  [-0.4, 0.2, 5.8]),
            (so3_exp(&[0.03, 0.12, 0.05]),    [0.2, -0.3, 6.1]),
        ];
        let n_cam = gt_cams.len();
        let mut gt_pts: Vec<V3> = Vec::new();
        for ix in -2..=2 {
            for iy in -2..=2 {
                gt_pts.push([ix as f64 * 0.5, iy as f64 * 0.5, 0.2 * ((ix * iy) as f64).cos()]);
            }
        }
        let n_pts = gt_pts.len();

        // Deterministic LCG noise in [-0.5, 0.5) px on every observation.
        let mut seed: u64 = 0x1234_5678;
        let mut noise = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as f64 / (1u64 << 31) as f64 - 0.5
        };

        let mut obs: Vec<f32> = Vec::new();
        for (ci, (r, t)) in gt_cams.iter().enumerate() {
            for (pi, x) in gt_pts.iter().enumerate() {
                let (u, v) = project_px(r, t, fx, fy, cx, cy, x);
                obs.extend_from_slice(&[ci as f32, pi as f32, (u + noise()) as f32, (v + noise()) as f32]);
            }
        }
        let mut k_flat: Vec<f32> = Vec::new();
        for _ in 0..n_cam { k_flat.extend_from_slice(&[fx as f32, fy as f32, cx as f32, cy as f32]); }

        let mut cam_flat: Vec<f32> = Vec::new();
        for (ci, (r, t)) in gt_cams.iter().enumerate() {
            let w = [0.03 * (ci as f64 + 1.0).sin(), -0.025 * (ci as f64).cos(), 0.02];
            let rp = mat3_mul(&so3_exp(&w), r);
            let tp = [t[0] + 0.1, t[1] - 0.08, t[2] + 0.12];
            for row in &rp { for &v in row { cam_flat.push(v as f32); } }
            for &v in &tp { cam_flat.push(v as f32); }
        }
        let mut pt_flat: Vec<f32> = Vec::new();
        for (pi, x) in gt_pts.iter().enumerate() {
            let d = 0.08;
            pt_flat.push((x[0] + d * (pi as f64).sin()) as f32);
            pt_flat.push((x[1] - d * (pi as f64 * 1.3).cos()) as f32);
            pt_flat.push((x[2] + d * 0.5) as f32);
        }

        let out = bundle_adjust(&cam_flat, &k_flat, &pt_flat, &obs, 80);
        let base = n_cam * 12 + n_pts * 3;
        let cost_before = out[base];
        let cost_after = out[base + 1];
        let trace = &out[base + 2..];
        assert!(!trace.is_empty(), "no convergence trace emitted");
        // The accepted-step RMS trace is monotonically non-increasing (LM never
        // commits a worsening step — the property Q2's guard relies on).
        for w in trace.windows(2) {
            assert!(w[1] <= w[0] + 1e-4, "cost rose across an accepted step: {} -> {}", w[0], w[1]);
        }
        assert!(cost_after < cost_before, "BA did not reduce cost under noise: {cost_before} -> {cost_after}");
        // ±0.5px uniform noise ⇒ RMS floor ≈ 0.41px; converge near it, not the start.
        assert!(cost_after < 0.7, "BA did not reach the noise floor: {cost_after}px");
    }
}
