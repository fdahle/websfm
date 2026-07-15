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

        let out = bundle_adjust(&cam_flat, &k_flat, &pt_flat, &obs, &[], &[], 60, &[], 0);
        let base = n_cam * 12 + n_pts * 3 + n_cam * 7;
        // cameras + points + intrinsics (7 each: fx,fy,cx,cy,k1,k2,k3) + [cost_before, cost_after] + trace.
        assert!(out.len() >= base + 3, "unexpected BA output length");
        let cost_before = out[base];
        let cost_after = out[base + 1];
        let trace = &out[base + 3..];
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

        let out = bundle_adjust(&cam_flat, &k_flat, &pt_flat, &obs, &[], &[], 80, &[], 0);
        let base = n_cam * 12 + n_pts * 3 + n_cam * 7;
        let cost_before = out[base];
        let cost_after = out[base + 1];
        let trace = &out[base + 3..];
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

    // Self-calibration (A2): a scene rendered with the TRUE focal, but BA seeded
    // with a focal 10% too small and asked to refine one shared focal
    // (refine_mode = 1, all cameras on sensor id 0). It must pull the focal back to
    // ~1.1× within 1% — the check the intrinsics-refinement path exists to pass.
    #[test]
    fn bundle_adjust_refines_shared_focal() {
        let (cx, cy) = (320.0_f64, 240.0_f64);
        let f_true = 880.0_f64;  // ground truth
        let f_seed = 800.0_f64;  // 10% low prior
        // Four genuinely different viewpoints so the focal is well observed (a
        // single strip would leave it degenerate with scene depth).
        let gt_cams: Vec<(M3, V3)> = vec![
            (so3_exp(&[0.0, 0.0, 0.0]),      [0.0, 0.0, 6.0]),
            (so3_exp(&[0.10, -0.14, 0.03]),  [0.8, 0.15, 6.3]),
            (so3_exp(&[-0.12, 0.10, -0.05]), [-0.7, 0.25, 5.7]),
            (so3_exp(&[0.05, 0.18, 0.06]),   [0.3, -0.4, 6.2]),
        ];
        let n_cam = gt_cams.len();
        let mut gt_pts: Vec<V3> = Vec::new();
        for ix in -2..=2 {
            for iy in -2..=2 {
                gt_pts.push([ix as f64 * 0.6, iy as f64 * 0.6, 0.3 * ((ix + 2 * iy) as f64).sin()]);
            }
        }
        let n_pts = gt_pts.len();

        let mut obs: Vec<f32> = Vec::new();
        for (ci, (r, t)) in gt_cams.iter().enumerate() {
            for (pi, x) in gt_pts.iter().enumerate() {
                let (u, v) = project_px(r, t, f_true, f_true, cx, cy, x);
                obs.extend_from_slice(&[ci as f32, pi as f32, u as f32, v as f32]);
            }
        }
        // Seed intrinsics 10% low; all cameras share sensor id 0 → one shared focal.
        let mut k_flat: Vec<f32> = Vec::new();
        for _ in 0..n_cam { k_flat.extend_from_slice(&[f_seed as f32, f_seed as f32, cx as f32, cy as f32]); }
        let sensor_of_cam: Vec<i32> = vec![0; n_cam];

        // Seed poses + points at ground truth (only the focal is wrong).
        let mut cam_flat: Vec<f32> = Vec::new();
        for (r, t) in &gt_cams {
            for row in r { for &v in row { cam_flat.push(v as f32); } }
            for &v in t { cam_flat.push(v as f32); }
        }
        let mut pt_flat: Vec<f32> = Vec::new();
        for x in &gt_pts { for &v in x { pt_flat.push(v as f32); } }

        let out = bundle_adjust(&cam_flat, &k_flat, &pt_flat, &obs, &[], &[], 100, &sensor_of_cam, 1);
        let intr_base = n_cam * 12 + n_pts * 3;
        let cost_after = out[intr_base + n_cam * 7 + 1];
        // Refined focal is returned per camera; sharing ⇒ all equal, ≈ f_true.
        for c in 0..n_cam {
            let fx = out[intr_base + c * 7] as f64;
            let fy = out[intr_base + c * 7 + 1] as f64;
            assert!((fx - f_true).abs() / f_true < 0.01, "focal not recovered: cam {c} fx {fx} vs {f_true}");
            assert!((fy - fx).abs() < 1e-3, "fx and fy diverged: {fx} vs {fy}");
        }
        assert!(cost_after < 0.2, "BA did not fit the refined focal: {cost_after}px");
    }

    // GCP anchor: a point pulled toward a known target position via the anchor
    // residual, on top of its normal reprojection observations. The scene is the
    // same 4-camera/25-point rig as `bundle_adjust_reduces_reprojection`, but one
    // point's *observations* are rendered from a slightly WRONG position (so
    // reprojection alone would settle it there) while the anchor pulls it back
    // toward the true position — this is exactly the GCP-in-BA use case: the
    // anchor should measurably win given a high weight.
    #[test]
    fn bundle_adjust_gcp_anchor_pulls_point() {
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

        // Point 0's true ("GCP") position, vs. a nearby but wrong position its
        // observations are actually rendered from (simulating a slightly
        // mis-triangulated SIFT track sharing that index).
        let anchor_target = gt_pts[0];
        let mut render_pts = gt_pts.clone();
        render_pts[0] = [anchor_target[0] + 0.3, anchor_target[1] - 0.2, anchor_target[2] + 0.1];

        let mut obs: Vec<f32> = Vec::new();
        for (ci, (r, t)) in gt_cams.iter().enumerate() {
            for (pi, x) in render_pts.iter().enumerate() {
                let (u, v) = project_px(r, t, fx, fy, cx, cy, x);
                obs.extend_from_slice(&[ci as f32, pi as f32, u as f32, v as f32]);
            }
        }
        let mut k_flat: Vec<f32> = Vec::new();
        for _ in 0..n_cam { k_flat.extend_from_slice(&[fx as f32, fy as f32, cx as f32, cy as f32]); }

        // Seed cameras/points at ground truth (so only point 0's error is at play).
        let mut cam_flat: Vec<f32> = Vec::new();
        for (r, t) in &gt_cams {
            for row in r { for &v in row { cam_flat.push(v as f32); } }
            for &v in t { cam_flat.push(v as f32); }
        }
        let mut pt_flat: Vec<f32> = Vec::new();
        for x in &render_pts { for &v in x { pt_flat.push(v as f32); } }

        let anchor_flat: Vec<f32> = vec![0.0, anchor_target[0] as f32, anchor_target[1] as f32, anchor_target[2] as f32];
        let anchor_weight: Vec<f32> = vec![1e4]; // heavily outweighs the ~4-observation reprojection pull

        let out_no_anchor = bundle_adjust(&cam_flat, &k_flat, &pt_flat, &obs, &[], &[], 60, &[], 0);
        let out_anchor = bundle_adjust(&cam_flat, &k_flat, &pt_flat, &obs, &anchor_flat, &anchor_weight, 60, &[], 0);

        let pts_base = n_cam * 12;
        let dist = |out: &Vec<f32>| -> f64 {
            let p = [out[pts_base] as f64, out[pts_base+1] as f64, out[pts_base+2] as f64];
            vec_diff(&p, &anchor_target)
        };
        let d_no_anchor = dist(&out_no_anchor);
        let d_anchor = dist(&out_anchor);
        assert!(d_anchor < d_no_anchor * 0.1,
            "anchor should pull point 0 much closer to the target: {d_anchor} vs (no anchor) {d_no_anchor}");
        assert!(d_anchor < 0.05, "anchored point not close enough to target: {d_anchor}");

        // anchor_rms_after is reported right after cost_after.
        let base = n_cam * 12 + n_pts * 3 + n_cam * 7;
        let anchor_rms_after = out_anchor[base + 2];
        assert!(anchor_rms_after < 0.05, "anchor_rms_after too high: {anchor_rms_after}");
        let anchor_rms_no_anchor = out_no_anchor[base + 2];
        assert_eq!(anchor_rms_no_anchor, 0.0, "anchor_rms_after must be 0 with no anchors");
    }

    // Dense MVS (Poisson prep): compute_depth_map must export per-pixel converged
    // plane normals in the trailing 3·npix f32 (camera-frame, unit, nz<0). Render a
    // slanted textured plane into a reference + one source view with known geometry,
    // seed the true depth, and check the recovered normals match the plane normal to
    // within a few degrees over the central region (borders clip the ZNCC window).
    #[test]
    fn compute_depth_map_exports_slanted_normals() {
        let (w, h) = (64usize, 48usize);
        let (fx, fy, cx, cy) = (80.0_f64, 80.0_f64, 32.0_f64, 24.0_f64);
        let npix = w * h;
        // Ground-truth plane normal in the reference/world frame (ref cam = identity
        // at origin). nz<0 ⇒ facing the camera; nonzero nx ⇒ slanted about the y axis.
        let n_true = normalize3(&[0.30, 0.0, -1.0]);
        // Plane n·X = c chosen so the principal ray hits depth 5.
        let c = 5.0 * n_true[2];

        // Deterministic surface texture as a function of the 3D point (world frame).
        let bright = |p: &V3| -> u8 {
            let s = 128.0 + 60.0 * (2.0 * p[0] + 1.0).sin()
                + 60.0 * (2.5 * p[1] - 0.5).sin()
                + 40.0 * (1.5 * (p[0] + p[1])).sin();
            s.clamp(0.0, 255.0) as u8
        };

        // Reference view: each pixel's ray hits the plane directly.
        let ray = |u: usize, v: usize| -> V3 {
            [(u as f64 - cx) / fx, (v as f64 - cy) / fy, 1.0]
        };
        let mut ref_gray = vec![0u8; npix];
        let mut seed = vec![0.0f32; npix];
        for v in 0..h {
            for u in 0..w {
                let r = ray(u, v);
                let depth = c / dot3(&n_true, &r); // n·(t·r)=c
                let p = [r[0] * depth, r[1] * depth, r[2] * depth];
                ref_gray[v * w + u] = bright(&p);
                seed[v * w + u] = depth as f32;
            }
        }

        // Source view: R = I, camera centre offset sideways (baseline). t = -R·C.
        let r_s: M3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let c_s: V3 = [-0.6, 0.1, 0.0];
        let t_s: V3 = [-c_s[0], -c_s[1], -c_s[2]];
        let r_st = mat3_transpose(&r_s);
        let mut src_gray = vec![0u8; npix];
        for v in 0..h {
            for u in 0..w {
                // Ray in source frame → world direction, intersect the plane.
                let rs = ray(u, v);
                let dir = mat3_vec(&r_st, &rs);
                let denom = dot3(&n_true, &dir);
                if denom.abs() < 1e-9 { continue; }
                let s = (c - dot3(&n_true, &c_s)) / denom;
                if s <= 0.0 { continue; }
                let p = [c_s[0] + s * dir[0], c_s[1] + s * dir[1], c_s[2] + s * dir[2]];
                src_gray[v * w + u] = bright(&p);
            }
        }

        let ref_k = [fx as f32, fy as f32, cx as f32, cy as f32];
        let src_dims = [w as u32, h as u32];
        let src_k = [fx as f32, fy as f32, cx as f32, cy as f32];
        let mut src_rel = Vec::new();
        for row in &r_s { for &x in row { src_rel.push(x as f32); } }
        for &x in &t_s { src_rel.push(x as f32); }

        let out = compute_depth_map(
            &ref_gray, w as u32, h as u32, &ref_k,
            &src_gray, &src_dims, &src_k, &src_rel, &[],
            &seed, 3.0, 8.0,
            3, 8, 1, 12345,
        );
        assert_eq!(out.len(), npix * 5, "output must be depth+cost+3·normals");

        // Average recovered normal over the central region; borders clip the window.
        let (mut ax, mut ay, mut az, mut cnt) = (0.0f64, 0.0f64, 0.0f64, 0usize);
        for v in 8..h - 8 {
            for u in 8..w - 8 {
                let i = v * w + u;
                let n = [
                    out[npix * 2 + i * 3] as f64,
                    out[npix * 2 + i * 3 + 1] as f64,
                    out[npix * 2 + i * 3 + 2] as f64,
                ];
                ax += n[0]; ay += n[1]; az += n[2]; cnt += 1;
            }
        }
        let avg = normalize3(&[ax / cnt as f64, ay / cnt as f64, az / cnt as f64]);
        let ang = dot3(&avg, &n_true).clamp(-1.0, 1.0).acos().to_degrees();
        assert!(ang < 12.0, "recovered normal off by {ang:.1}° (avg {avg:?} vs {n_true:?})");
    }

    // Self-calibration (R6): a scene rendered with a known radial distortion k1, but
    // BA seeded with a pinhole model (k1 = 0) and asked to refine one shared radial
    // coefficient (refine_mode = 3). It must recover k1 and drive the fit to sub-pixel
    // — the check the k1-refinement path exists to pass.
    #[test]
    fn bundle_adjust_refines_shared_k1() {
        let (fx, fy, cx, cy) = (800.0_f64, 800.0_f64, 320.0_f64, 240.0_f64);
        let k1_true = -0.15_f64; // barrel distortion
        let gt_cams: Vec<(M3, V3)> = vec![
            (so3_exp(&[0.0, 0.0, 0.0]),      [0.0, 0.0, 6.0]),
            (so3_exp(&[0.10, -0.14, 0.03]),  [0.8, 0.15, 6.3]),
            (so3_exp(&[-0.12, 0.10, -0.05]), [-0.7, 0.25, 5.7]),
            (so3_exp(&[0.05, 0.18, 0.06]),   [0.3, -0.4, 6.2]),
        ];
        let n_cam = gt_cams.len();
        let mut gt_pts: Vec<V3> = Vec::new();
        for ix in -2..=2 {
            for iy in -2..=2 {
                gt_pts.push([ix as f64 * 0.7, iy as f64 * 0.7, 0.3 * ((ix + 2 * iy) as f64).sin()]);
            }
        }
        let n_pts = gt_pts.len();

        // Distorted projection with the true k1 (Brown r² model; matches project_full).
        let proj_d = |r: &M3, t: &V3, x: &V3| -> (f64, f64) {
            let p = mat3_vec(r, x);
            let (xc, yc, zc) = (p[0] + t[0], p[1] + t[1], p[2] + t[2]);
            let (a, b) = (xc / zc, yc / zc);
            let d = 1.0 + k1_true * (a * a + b * b);
            (fx * a * d + cx, fy * b * d + cy)
        };
        let mut obs: Vec<f32> = Vec::new();
        for (ci, (r, t)) in gt_cams.iter().enumerate() {
            for (pi, x) in gt_pts.iter().enumerate() {
                let (u, v) = proj_d(r, t, x);
                obs.extend_from_slice(&[ci as f32, pi as f32, u as f32, v as f32]);
            }
        }
        // Seed intrinsics with the true focal but no distortion; one shared sensor.
        let mut k_flat: Vec<f32> = Vec::new();
        for _ in 0..n_cam { k_flat.extend_from_slice(&[fx as f32, fy as f32, cx as f32, cy as f32]); }
        let sensor_of_cam: Vec<i32> = vec![0; n_cam];

        // Seed poses + points at ground truth (only the distortion is unmodelled).
        let mut cam_flat: Vec<f32> = Vec::new();
        for (r, t) in &gt_cams {
            for row in r { for &v in row { cam_flat.push(v as f32); } }
            for &v in t { cam_flat.push(v as f32); }
        }
        let mut pt_flat: Vec<f32> = Vec::new();
        for x in &gt_pts { for &v in x { pt_flat.push(v as f32); } }

        // refine_mask 5 = f | k1 (bits 1 and 4).
        let out = bundle_adjust(&cam_flat, &k_flat, &pt_flat, &obs, &[], &[], 100, &sensor_of_cam, 5);
        let intr_base = n_cam * 12 + n_pts * 3;
        let cost_before = out[intr_base + n_cam * 7];
        let cost_after = out[intr_base + n_cam * 7 + 1];
        assert!(cost_before > 1.0, "test setup too easy: before {cost_before}px");
        // Refined k1 is returned per camera (index 4 of the 7-wide K); sharing ⇒ all equal.
        for c in 0..n_cam {
            let k1 = out[intr_base + c * 7 + 4] as f64;
            assert!((k1 - k1_true).abs() < 0.02, "k1 not recovered: cam {c} k1 {k1} vs {k1_true}");
        }
        assert!(cost_after < 0.2, "BA did not fit the refined k1: {cost_after}px");
    }

    // Full radial polynomial: recover k1 AND k2 from a scene rendered with both. Same
    // 4-view rig; refine_mask = f|k1|k2 (1|4|8 = 13). Guards the k2 Jacobian + the
    // nCam×7 output stride.
    #[test]
    fn bundle_adjust_refines_k1_k2() {
        let (fx, fy, cx, cy) = (800.0_f64, 800.0_f64, 320.0_f64, 240.0_f64);
        let (k1_true, k2_true) = (-0.15_f64, 0.05_f64);
        let gt_cams: Vec<(M3, V3)> = vec![
            (so3_exp(&[0.0, 0.0, 0.0]),      [0.0, 0.0, 6.0]),
            (so3_exp(&[0.10, -0.14, 0.03]),  [0.8, 0.15, 6.3]),
            (so3_exp(&[-0.12, 0.10, -0.05]), [-0.7, 0.25, 5.7]),
            (so3_exp(&[0.05, 0.18, 0.06]),   [0.3, -0.4, 6.2]),
        ];
        let n_cam = gt_cams.len();
        let mut gt_pts: Vec<V3> = Vec::new();
        for ix in -2..=2 {
            for iy in -2..=2 {
                gt_pts.push([ix as f64 * 0.7, iy as f64 * 0.7, 0.3 * ((ix + 2 * iy) as f64).sin()]);
            }
        }
        let n_pts = gt_pts.len();
        let proj_d = |r: &M3, t: &V3, x: &V3| -> (f64, f64) {
            let p = mat3_vec(r, x);
            let (xc, yc, zc) = (p[0] + t[0], p[1] + t[1], p[2] + t[2]);
            let (a, b) = (xc / zc, yc / zc);
            let r2 = a * a + b * b;
            let d = 1.0 + k1_true * r2 + k2_true * r2 * r2;
            (fx * a * d + cx, fy * b * d + cy)
        };
        let mut obs: Vec<f32> = Vec::new();
        for (ci, (r, t)) in gt_cams.iter().enumerate() {
            for (pi, x) in gt_pts.iter().enumerate() {
                let (u, v) = proj_d(r, t, x);
                obs.extend_from_slice(&[ci as f32, pi as f32, u as f32, v as f32]);
            }
        }
        let mut k_flat: Vec<f32> = Vec::new();
        for _ in 0..n_cam { k_flat.extend_from_slice(&[fx as f32, fy as f32, cx as f32, cy as f32]); }
        let sensor_of_cam: Vec<i32> = vec![0; n_cam];
        let mut cam_flat: Vec<f32> = Vec::new();
        for (r, t) in &gt_cams {
            for row in r { for &v in row { cam_flat.push(v as f32); } }
            for &v in t { cam_flat.push(v as f32); }
        }
        let mut pt_flat: Vec<f32> = Vec::new();
        for x in &gt_pts { for &v in x { pt_flat.push(v as f32); } }

        let out = bundle_adjust(&cam_flat, &k_flat, &pt_flat, &obs, &[], &[], 120, &sensor_of_cam, 13);
        let intr_base = n_cam * 12 + n_pts * 3;
        let cost_after = out[intr_base + n_cam * 7 + 1];
        for c in 0..n_cam {
            let k1 = out[intr_base + c * 7 + 4] as f64;
            let k2 = out[intr_base + c * 7 + 5] as f64;
            assert!((k1 - k1_true).abs() < 0.02, "k1 not recovered: cam {c} k1 {k1} vs {k1_true}");
            assert!((k2 - k2_true).abs() < 0.02, "k2 not recovered: cam {c} k2 {k2} vs {k2_true}");
        }
        assert!(cost_after < 0.2, "BA did not fit the refined k1,k2: {cost_after}px");
    }
}
