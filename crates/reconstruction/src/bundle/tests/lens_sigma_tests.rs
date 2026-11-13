use super::*;

// Three nadir strips 50–62 m over hilly ground (±8 m), f 1000 px on a 1000 × 750 frame:
// relief and varied heights fix the focal well enough for first-order propagation.
const F: f64 = 1000.0;
const W: f64 = 1000.0;
const H: f64 = 750.0;

struct Rng(u64);
impl Rng {
    // SplitMix64: Box–Muller on consecutive LCG outputs gave correlated pairs (the
    // solved focals alternated low and high from one trial to the next).
    fn uniform(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^= z >> 31;
        ((z >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }
    fn gauss(&mut self) -> f64 { (-2.0 * self.uniform().ln()).sqrt() * (std::f64::consts::TAU * self.uniform()).cos() }
}

// `tilt_deg`: each photo pitched forward or back by this much, alternately. With every
// optical axis parallel (0) a z-stretch of the scene with the focal scaled alike
// leaves every image point where it was: the focal is then fixed only by control.
fn truth(tilt_deg: f64) -> (Vec<(M3, V3)>, Vec<V3>) {
    let nadir: M3 = [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]];
    let mut cams = Vec::new();
    for strip in 0..3 {
        for k in 0..8 {
            let a = tilt_deg.to_radians() * if (k + strip) % 2 == 0 { 1.0 } else { -1.0 };
            let r = mat3_mul(&[[1.0, 0.0, 0.0], [0.0, a.cos(), -a.sin()], [0.0, a.sin(), a.cos()]], &nadir);
            let c = [8.0 * k as f64, 15.0 * strip as f64, 50.0 + 6.0 * ((k + strip) % 3) as f64];
            let t = mat3_vec(&r, &c);
            cams.push((r, [-t[0], -t[1], -t[2]]));
        }
    }
    let mut pts = Vec::new();
    for ix in 0..20 { for iy in 0..14 {
        let (x, y) = (-12.0 + 4.0 * ix as f64, -14.0 + 4.2 * iy as f64);
        pts.push([x, y, 8.0 * (0.15 * x).sin() * (0.2 * y).cos()]);
    }}
    (cams, pts)
}

// One solve from the truth with σ px noise on every observation (and σ_c m on every
// camera prior, when there are priors): the solved fx and the reported σ of fx.
fn trial(rng: &mut Rng, sigma_px: f64, prior_sigma: Option<f64>, tilt_deg: f64) -> (f64, f64) {
    let (cams, pts) = truth(tilt_deg);
    let (n_cam, n_pts) = (cams.len(), pts.len());
    let (mut obs_idx, mut obs_px) = (Vec::new(), Vec::new());
    for (ci, (r, t)) in cams.iter().enumerate() {
        for (pi, x) in pts.iter().enumerate() {
            let p = mat3_vec(r, x);
            let c = [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
            let (u, v) = (F * c[0] / c[2] + W / 2.0, F * c[1] / c[2] + H / 2.0);
            if u < 0.0 || u > W || v < 0.0 || v > H { continue; }
            obs_idx.extend_from_slice(&[ci as u32, pi as u32]);
            obs_px.extend_from_slice(&[(u + sigma_px * rng.gauss()) as f32, (v + sigma_px * rng.gauss()) as f32]);
        }
    }
    let cam_flat: Vec<f32> = cams.iter().flat_map(|(r, t)| r.iter().flatten().chain(t.iter()).map(|&v| v as f32).collect::<Vec<_>>()).collect();
    let k_flat: Vec<f32> = (0..n_cam).flat_map(|_| [F as f32, F as f32, (W / 2.0) as f32, (H / 2.0) as f32]).collect();
    let pt_flat: Vec<f32> = pts.iter().flat_map(|x| x.map(|v| v as f32)).collect();
    // Each term weighted by its own noise (1/σ²): only then is the solve the
    // maximum-likelihood one whose spread its Hessian predicts.
    let obs_w = vec![(1.0 / (sigma_px * sigma_px)) as f32; obs_px.len()];
    let mut prior_flat = Vec::new();
    if let Some(sc) = prior_sigma {
        for (ci, (r, t)) in cams.iter().enumerate() {
            let c = mat3_vec(&mat3_transpose(r), t);
            prior_flat.push(ci as f32);
            for k in 0..3 { prior_flat.push((-c[k] + sc * rng.gauss()) as f32); }
            let w = (1.0 / (sc * sc)) as f32;
            prior_flat.extend_from_slice(&[w, 0.0, 0.0, 0.0, w, 0.0, 0.0, 0.0, w]);
            prior_flat.extend(std::iter::repeat(0f32).take(18));
        }
    }
    let mut solver = vec![f32::NAN; 10];
    solver[8] = 0.0; // plain least squares: Gaussian noise has no outliers to bound
    solver[9] = 1.0;
    let sensor = vec![0i32; n_cam];
    let out = bundle_adjust(&cam_flat, &k_flat, &pt_flat, &obs_idx, &obs_px, &obs_w, &[], &[], &prior_flat, 50, &sensor,
                            1, &solver, &[], &[]);
    let fx = out[n_cam * 12 + n_pts * 3] as f64;
    let at = n_cam * 12 + n_pts * 3 + n_cam * 8 + 4 + BA_STATS_LEN;
    assert_eq!(out[at], 1.0, "one lens group");
    let sigma = out[at + 1] as f64;
    assert!(out[at + 2].is_nan(), "cx was not refined");
    (fx, sigma)
}

// The reported σ of the focal is the spread the focal actually has: over 40 noise
// draws, the solved focals' standard deviation and the mean reported σ agree.
fn check(sigma_px: f64, prior_sigma: Option<f64>, tilt_deg: f64) {
    let mut rng = Rng(7);
    let runs: Vec<(f64, f64)> = (0..40).map(|_| trial(&mut rng, sigma_px, prior_sigma, tilt_deg)).collect();
    let mean = runs.iter().map(|r| r.0).sum::<f64>() / runs.len() as f64;
    let spread = (runs.iter().map(|r| (r.0 - mean).powi(2)).sum::<f64>() / (runs.len() - 1) as f64).sqrt();
    let reported = runs.iter().map(|r| r.1).sum::<f64>() / runs.len() as f64;
    assert!((mean - F).abs() < 3.0 * spread, "unbiased: mean {mean}, spread {spread}");
    let ratio = reported / spread;
    // 40 draws pin a standard deviation to about ±11 % (1σ).
    assert!((0.7..1.4).contains(&ratio), "reported σ {reported:.3} vs observed spread {spread:.3} px (×{ratio:.2})");
}

#[test]
fn the_focal_sigma_is_its_spread_with_camera_priors() { check(0.5, Some(0.03), 0.0); }

// Without control the photos' tilt fixes the focal; the datum the σ needs (one camera
// and one baseline's scale held) is the solve's own business.
#[test]
fn the_focal_sigma_is_its_spread_without_control() { check(0.5, None, 10.0); }

// A nadir block without control cannot fix its focal at all, and says so: its σ is
// larger than the focal is uncertain on any block that has control.
#[test]
fn a_nadir_block_without_control_reports_its_focal_undetermined() {
    let (_, free) = trial(&mut Rng(3), 0.5, None, 0.0);
    let (_, held) = trial(&mut Rng(3), 0.5, Some(0.03), 0.0);
    assert!(free > 50.0 * held, "nadir, no control: σ {free:.2} px vs {held:.2} px with priors");
}
