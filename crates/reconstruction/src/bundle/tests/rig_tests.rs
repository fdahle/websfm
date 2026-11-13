use super::*;

// A three-lens rig (reference + two bands, each turned a fraction of a degree and a
// few centimetres off) flown in two nadir strips 50 m above a rolling field.
const F: f64 = 1000.0;
const W: f64 = 1000.0;
const H: f64 = 750.0;

fn nadir() -> M3 { [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]] }
fn offsets() -> Vec<Option<(M3, V3)>> {
    vec![None, Some((so3_exp(&[0.004, -0.006, 0.003]), [0.05, 0.0, 0.0])), Some((so3_exp(&[-0.005, 0.002, -0.004]), [0.0, 0.05, 0.002]))]
}
fn compose(r: &M3, t: &V3, o: &Option<(M3, V3)>) -> (M3, V3) {
    match o {
        None => (*r, *t),
        Some((ro, to)) => { let rt = mat3_vec(ro, t); (mat3_mul(ro, r), [rt[0] + to[0], rt[1] + to[1], rt[2] + to[2]]) }
    }
}

struct Rig { caps: Vec<(M3, V3)>, pts: Vec<V3>, obs_idx: Vec<u32>, obs_px: Vec<f32> }

// Camera 3·k + b is band b of capture k.
fn rig() -> Rig { rig_of(2, 7) }
fn rig_of(strips: usize, per_strip: usize) -> Rig {
    let r = nadir();
    let mut caps = Vec::new();
    for strip in 0..strips { for k in 0..per_strip {
        let c = [8.0 * k as f64, 18.0 * strip as f64, 50.0 + 0.5 * k as f64];
        let t = mat3_vec(&r, &c);
        caps.push((r, [-t[0], -t[1], -t[2]]));
    }}
    let mut pts = Vec::new();
    for ix in 0..(16 + 2 * per_strip) { for iy in 0..(5 * strips) {
        let (x, y) = (-10.0 + 4.5 * ix as f64, -12.0 + 4.2 * iy as f64);
        pts.push([x, y, 1.5 * (0.2 * x).sin() * (0.3 * y).cos()]);
    }}
    let (mut obs_idx, mut obs_px) = (Vec::new(), Vec::new());
    for (k, (r, t)) in caps.iter().enumerate() {
        for (b, o) in offsets().iter().enumerate() {
            let (ri, ti) = compose(r, t, o);
            for (pi, x) in pts.iter().enumerate() {
                let pc = mat3_vec(&ri, x);
                let c = [pc[0] + ti[0], pc[1] + ti[1], pc[2] + ti[2]];
                let (u, v) = (F * c[0] / c[2] + W / 2.0, F * c[1] / c[2] + H / 2.0);
                if c[2] > 0.0 && u >= 0.0 && u <= W && v >= 0.0 && v <= H {
                    obs_idx.extend_from_slice(&[(3 * k + b) as u32, pi as u32]);
                    obs_px.extend_from_slice(&[u as f32, v as f32]);
                }
            }
        }
    }
    Rig { caps, pts, obs_idx, obs_px }
}

// Inputs: every camera's own (perturbed) pose, intrinsics, points, capture ids,
// band sensors, and offsets seeded with `seed_err` added to each band's rotation.
fn inputs(g: &Rig, seed_err: f64) -> (Vec<f32>, Vec<f32>, Vec<f32>, Vec<i32>, Vec<i32>, Vec<f32>) {
    let (mut cf, mut capture, mut sensor, mut of) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (k, (r, t)) in g.caps.iter().enumerate() {
        let w = [0.002 * (k as f64).sin(), -0.002 * (k as f64).cos(), 0.001];
        let (rp, tp) = (mat3_mul(&so3_exp(&w), r), [t[0] + 0.05, t[1] - 0.04, t[2] + 0.06]);
        for (b, o) in offsets().iter().enumerate() {
            let (ri, ti) = compose(&rp, &tp, o);
            for row in &ri { for &v in row { cf.push(v as f32); } }
            for &v in &ti { cf.push(v as f32); }
            capture.push(k as i32);
            sensor.push(b as i32);
            match o {
                None => of.extend(std::iter::repeat(0.0f32).take(13)),
                Some((ro, to)) => {
                    let rs = mat3_mul(&so3_exp(&[seed_err, -seed_err, 0.5 * seed_err]), ro);
                    of.push(1.0);
                    for row in &rs { for &v in row { of.push(v as f32); } }
                    for &v in to { of.push(v as f32); }
                }
            }
        }
    }
    let n = cf.len() / 12;
    let kf: Vec<f32> = (0..n).flat_map(|_| [F as f32, F as f32, (W / 2.0) as f32, (H / 2.0) as f32]).collect();
    let pf: Vec<f32> = g.pts.iter().enumerate().flat_map(|(i, x)| {
        let d = 0.05 * (i as f64).sin();
        [(x[0] + d) as f32, (x[1] - d) as f32, (x[2] + d) as f32]
    }).collect();
    (cf, kf, pf, capture, sensor, of)
}

fn pose(out: &[f32], c: usize) -> (M3, V3) {
    let v = |i: usize| out[c * 12 + i] as f64;
    ([[v(0), v(1), v(2)], [v(3), v(4), v(5)], [v(6), v(7), v(8)]], [v(9), v(10), v(11)])
}
fn cost_after(out: &[f32], n_cam: usize, n_pts: usize) -> f32 { out[n_cam * 12 + n_pts * 3 + n_cam * 8 + 1] }
// The offset rotation a solve ended with: band pose · reference poseᵀ, per capture.
fn offset_of(out: &[f32], k: usize, b: usize) -> M3 {
    mat3_mul(&pose(out, 3 * k + b).0, &mat3_transpose(&pose(out, 3 * k).0))
}
fn angle(a: &M3, b: &M3) -> f64 { let w = so3_log(&mat3_mul(a, &mat3_transpose(b))); dot3(&w, &w).sqrt() }

#[test]
fn a_capture_moves_as_one_and_its_bands_keep_their_offsets() {
    let g = rig();
    let (cf, kf, pf, capture, sensor, of) = inputs(&g, 0.0);
    let (n_cam, n_pts) = (cf.len() / 12, g.pts.len());
    let ones = vec![1.0f32; g.obs_px.len()];
    let out = bundle_adjust_rig(&cf, &kf, &pf, &g.obs_idx, &g.obs_px, &ones, &[], &[], &[], 40, &sensor, 0, &[], &[], &[], &[],
                                &capture, &of);
    assert!(cost_after(&out, n_cam, n_pts) < 0.01, "residual {} px", cost_after(&out, n_cam, n_pts));
    for k in 0..g.caps.len() { for (b, o) in offsets().iter().enumerate().skip(1) {
        let ro = o.unwrap().0;
        assert!(angle(&offset_of(&out, k, b), &ro) < 1e-5, "capture {k} band {b} kept its offset");
        // The lever arm too: t_band = R_o·t_ref + t_o.
        let (_, tr) = pose(&out, 3 * k);
        let (_, tb) = pose(&out, 3 * k + b);
        let want = { let rt = mat3_vec(&ro, &tr); [rt[0] + o.unwrap().1[0], rt[1] + o.unwrap().1[1], rt[2] + o.unwrap().1[2]] };
        for i in 0..3 { assert!((tb[i] - want[i]).abs() < 1e-4); }
    }}
}

#[test]
fn a_wrong_offset_is_refined_from_the_photos() {
    let g = rig();
    // Each band's rotation seeded 0.3° off.
    let (cf, kf, pf, capture, sensor, of) = inputs(&g, 0.0052);
    let (n_cam, n_pts) = (cf.len() / 12, g.pts.len());
    let ones = vec![1.0f32; g.obs_px.len()];
    let fixed = bundle_adjust_rig(&cf, &kf, &pf, &g.obs_idx, &g.obs_px, &ones, &[], &[], &[], 40, &sensor, 0, &[], &[], &[], &[],
                                  &capture, &of);
    let refined = bundle_adjust_rig(&cf, &kf, &pf, &g.obs_idx, &g.obs_px, &ones, &[], &[], &[], 40, &sensor, 128, &[], &[], &[], &[],
                                    &capture, &of);
    assert!(cost_after(&fixed, n_cam, n_pts) > 1.0, "a wrong offset cannot fit: {} px", cost_after(&fixed, n_cam, n_pts));
    assert!(cost_after(&refined, n_cam, n_pts) < 0.01, "refined: {} px", cost_after(&refined, n_cam, n_pts));
    for (b, o) in offsets().iter().enumerate().skip(1) {
        let e = angle(&offset_of(&refined, 5, b), &o.unwrap().0);
        assert!(e < 2e-5, "band {b}: offset {e} rad from the truth");
    }
}

#[test]
fn a_large_rig_takes_the_threaded_schur_path_alike() {
    // 150 captures, 450 cameras: the direct solve's range-split Schur step.
    let g = rig_of(5, 30);
    let (cf, kf, pf, capture, sensor, of) = inputs(&g, 0.0052);
    let (n_cam, n_pts) = (cf.len() / 12, g.pts.len());
    let ones = vec![1.0f32; g.obs_px.len()];
    let solver = [64.0f32, f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, 1.0, f32::NAN];
    let out = bundle_adjust_rig(&cf, &kf, &pf, &g.obs_idx, &g.obs_px, &ones, &[], &[], &[], 40, &sensor, 128, &solver, &[], &[],
                                &[], &capture, &of);
    assert!(cost_after(&out, n_cam, n_pts) < 0.01, "residual {} px", cost_after(&out, n_cam, n_pts));
    for (b, o) in offsets().iter().enumerate().skip(1) {
        assert!(angle(&offset_of(&out, 70, b), &o.unwrap().0) < 2e-5);
    }
}

#[test]
fn without_captures_or_offsets_it_is_bundle_adjust_exactly() {
    let g = rig();
    let (cf, kf, pf, _, sensor, _) = inputs(&g, 0.0);
    let ones = vec![1.0f32; g.obs_px.len()];
    let n_cam = cf.len() / 12;
    let own: Vec<i32> = (0..n_cam as i32).collect();
    let none = vec![0.0f32; n_cam * 13];
    let plain = bundle_adjust(&cf, &kf, &pf, &g.obs_idx, &g.obs_px, &ones, &[], &[], &[], 15, &sensor, 1, &[], &[], &[]);
    let rig = bundle_adjust_rig(&cf, &kf, &pf, &g.obs_idx, &g.obs_px, &ones, &[], &[], &[], 15, &sensor, 1 | 128, &[], &[], &[], &[],
                                &own, &none);
    assert_eq!(plain, rig);
}
