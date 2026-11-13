use super::*;

// Two nadir strips flown along +x at 10 m/s, 50 m above a gently rolling field:
// f 1000 px on a 1000 × 750 frame, so 30 ms of readout moves a row ±0.15 m (±3 px).
const F: f64 = 1000.0;
const W: f64 = 1000.0;
const H: f64 = 750.0;
const V: V3 = [10.0, 0.0, 0.0];

struct Block { cams: Vec<(M3, V3)>, pts: Vec<V3>, obs_idx: Vec<u32>, obs_px: Vec<f32> }

fn nadir() -> M3 { [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]] }

// A point seen by a rolling-shutter camera: the row decides when, and when decides
// where the camera was, so solve the projection by fixed point from the middle row.
fn project_rs(r: &M3, t: &V3, x: &V3, tau: f64) -> Option<(f64, f64)> {
    let (cx, cy) = (W / 2.0, H / 2.0);
    let mut s = 0.0;
    let mut uv = (0.0, 0.0);
    for _ in 0..8 {
        let xs = [x[0] - tau * s * V[0], x[1] - tau * s * V[1], x[2] - tau * s * V[2]];
        let pc = mat3_vec(r, &xs);
        let c = [pc[0] + t[0], pc[1] + t[1], pc[2] + t[2]];
        if c[2] <= 0.0 { return None; }
        uv = (F * c[0] / c[2] + cx, F * c[1] / c[2] + cy);
        s = (uv.1 - cy) / H;
    }
    if uv.0 < 0.0 || uv.0 > W || uv.1 < 0.0 || uv.1 > H { None } else { Some(uv) }
}

fn block(tau: f64) -> Block {
    let r = nadir();
    let mut cams = Vec::new();
    for strip in 0..2 {
        for k in 0..7 {
            let c = [8.0 * k as f64, 18.0 * strip as f64, 50.0 + 0.5 * k as f64];
            let t = mat3_vec(&r, &c);
            cams.push((r, [-t[0], -t[1], -t[2]]));
        }
    }
    let mut pts = Vec::new();
    for ix in 0..16 { for iy in 0..10 {
        let (x, y) = (-10.0 + 4.5 * ix as f64, -12.0 + 4.2 * iy as f64);
        pts.push([x, y, 1.5 * (0.2 * x).sin() * (0.3 * y).cos()]);
    }}
    let (mut obs_idx, mut obs_px) = (Vec::new(), Vec::new());
    for (ci, (r, t)) in cams.iter().enumerate() {
        for (pi, x) in pts.iter().enumerate() {
            if let Some((u, v)) = project_rs(r, t, x, tau) {
                obs_idx.extend_from_slice(&[ci as u32, pi as u32]);
                obs_px.extend_from_slice(&[u as f32, v as f32]);
            }
        }
    }
    Block { cams, pts, obs_idx, obs_px }
}

fn flat(b: &Block, perturb: bool) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let mut cam_flat = Vec::new();
    for (ci, (r, t)) in b.cams.iter().enumerate() {
        let (rp, tp) = if perturb {
            let w = [0.002 * (ci as f64).sin(), -0.002 * (ci as f64).cos(), 0.001];
            (mat3_mul(&so3_exp(&w), r), [t[0] + 0.05, t[1] - 0.04, t[2] + 0.06])
        } else { (*r, *t) };
        for row in &rp { for &v in row { cam_flat.push(v as f32); } }
        for &v in &tp { cam_flat.push(v as f32); }
    }
    let k_flat: Vec<f32> = (0..b.cams.len()).flat_map(|_| [F as f32, F as f32, (W / 2.0) as f32, (H / 2.0) as f32]).collect();
    let pt_flat: Vec<f32> = b.pts.iter().enumerate().flat_map(|(i, x)| {
        let d = if perturb { 0.05 * (i as f64).sin() } else { 0.0 };
        [(x[0] + d) as f32, (x[1] - d) as f32, (x[2] + d) as f32]
    }).collect();
    (cam_flat, k_flat, pt_flat)
}

fn rs_flat(n_cam: usize, tau0: f64, h: f64) -> Vec<f32> {
    (0..n_cam).flat_map(|_| [V[0] as f32, V[1] as f32, V[2] as f32, h as f32, tau0 as f32]).collect()
}

fn cost_after(out: &[f32], n_cam: usize, n_pts: usize) -> f32 { out[n_cam * 12 + n_pts * 3 + n_cam * 8 + 1] }
fn taus(out: &[f32], n_cam: usize, n_pts: usize) -> Vec<f32> {
    let b = n_cam * 12 + n_pts * 3 + n_cam * 8 + 4 + BA_STATS_LEN;
    out[b..b + n_cam].to_vec()
}

// RMS distance of the solved points from the truth after the best similarity
// (Umeyama): the shape error, whatever datum the free solve settled in.
fn shape_rms(out: &[f32], n_cam: usize, truth: &[V3]) -> f64 {
    let n = truth.len();
    let est: Vec<V3> = (0..n).map(|i| { let b = n_cam * 12 + i * 3; [out[b] as f64, out[b + 1] as f64, out[b + 2] as f64] }).collect();
    let mean = |v: &[V3]| { let mut m = [0.0; 3]; for p in v { for k in 0..3 { m[k] += p[k] / n as f64; } } m };
    let (me, mt) = (mean(&est), mean(truth));
    let mut cov = [[0.0; 3]; 3];
    let mut var = 0.0;
    for i in 0..n {
        let x = [est[i][0] - me[0], est[i][1] - me[1], est[i][2] - me[2]];
        let y = [truth[i][0] - mt[0], truth[i][1] - mt[1], truth[i][2] - mt[2]];
        for a in 0..3 { for c in 0..3 { cov[a][c] += y[a] * x[c]; } }
        var += dot3(&x, &x);
    }
    let r = nearest_rotation(&cov);
    let mut s_num = 0.0;
    for i in 0..n {
        let x = [est[i][0] - me[0], est[i][1] - me[1], est[i][2] - me[2]];
        let y = [truth[i][0] - mt[0], truth[i][1] - mt[1], truth[i][2] - mt[2]];
        s_num += dot3(&y, &mat3_vec(&r, &x));
    }
    let sc = s_num / var;
    let mut sse = 0.0;
    for i in 0..n {
        let x = [est[i][0] - me[0], est[i][1] - me[1], est[i][2] - me[2]];
        let rx = mat3_vec(&r, &x);
        for k in 0..3 { sse += (sc * rx[k] + mt[k] - truth[i][k]).powi(2); }
    }
    (sse / n as f64).sqrt()
}

#[test]
fn the_model_keeps_the_shape_a_global_shutter_bends() {
    // A global-shutter solve explains the pixels about as well (every camera moves
    // alike, so the block shears as a whole); the damage is in the shape. That is
    // what a check point sees, and what the readout time puts right.
    let b = block(0.03);
    let (n_cam, n_pts) = (b.cams.len(), b.pts.len());
    let (cf, kf, pf) = flat(&b, true);
    let ones = vec![1.0f32; b.obs_px.len()];
    let global = bundle_adjust(&cf, &kf, &pf, &b.obs_idx, &b.obs_px, &ones, &[], &[], &[], 60, &[], 0, &[], &[], &[]);
    let rolling = bundle_adjust_rs(&cf, &kf, &pf, &b.obs_idx, &b.obs_px, &ones, &[], &[], &[], 60, &[], 0, &[], &[], &[],
                                   &rs_flat(n_cam, 0.03, H));
    let (g, r) = (shape_rms(&global, n_cam, &b.pts), shape_rms(&rolling, n_cam, &b.pts));
    assert!(cost_after(&rolling, n_cam, n_pts) < 0.01);
    assert!(r < 0.002, "the true readout time keeps the shape: {r} m");
    assert!(g > 0.02 && g > 10.0 * r, "a global-shutter solve bends it: {g} m vs {r} m");
    assert_eq!(taus(&rolling, n_cam, n_pts)[0], 0.03f32);
}

#[test]
fn the_readout_time_is_recovered_by_self_calibration() {
    let b = block(0.03);
    let (n_cam, n_pts) = (b.cams.len(), b.pts.len());
    let (cf, kf, pf) = flat(&b, true);
    let ones = vec![1.0f32; b.obs_px.len()];
    let sensors = vec![0i32; n_cam];
    let out = bundle_adjust_rs(&cf, &kf, &pf, &b.obs_idx, &b.obs_px, &ones, &[], &[], &[], 60, &sensors, 64, &[], &[], &[],
                               &rs_flat(n_cam, 0.0, H));
    let tau = taus(&out, n_cam, n_pts);
    assert!((tau[0] - 0.03).abs() < 0.002, "readout time {} s, not 0.030", tau[0]);
    assert!(tau.iter().all(|&t| t == tau[0]), "one group shares one readout time");
    assert!(cost_after(&out, n_cam, n_pts) < 0.02, "residual {} px", cost_after(&out, n_cam, n_pts));
}

#[test]
fn without_rolling_shutter_cameras_it_is_bundle_adjust_exactly() {
    let b = block(0.0);
    let (n_cam, n_pts) = (b.cams.len(), b.pts.len());
    let (cf, kf, pf) = flat(&b, true);
    let ones = vec![1.0f32; b.obs_px.len()];
    let plain = bundle_adjust(&cf, &kf, &pf, &b.obs_idx, &b.obs_px, &ones, &[], &[], &[], 20, &[], 1, &[], &[], &[]);
    let off = bundle_adjust_rs(&cf, &kf, &pf, &b.obs_idx, &b.obs_px, &ones, &[], &[], &[], 20, &[], 1 | 64, &[], &[], &[],
                               &rs_flat(n_cam, 0.03, 0.0));
    let head = n_cam * 12 + n_pts * 3 + n_cam * 8 + 4 + BA_STATS_LEN;
    assert_eq!(&plain[..head], &off[..head]);
    assert_eq!(&plain[head..], &off[head + n_cam..]);
    assert!(taus(&off, n_cam, n_pts).iter().all(|&t| t == 0.0));
}
