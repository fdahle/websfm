// The robust loss in σ units (SolverOpts::sigma_units, Model::sig, Problem::w_ref).
use super::*;
use super::f32_entry::{bundle_adjust, wide};

// Two cameras at x = 0 and x = 1 looking down +z (f 1000 px, principal point 0), 20 points
// at z = 10. Every observation weighs 1 and sits 0.5 px off in x, so the median error is
// 0.5 px and the adaptive threshold 2.5 × 0.5 = 1.25 px; then two more on point 0:
// X weighs 1/16 (σ 4 px) and sits 4 px off (1 σ), Y weighs 16 (σ 0.25 px) and sits 1 px
// off (4 σ). Returns the problem, its start and the indices of X and Y.
fn two_sigma_problem() -> (Problem, State, usize, usize) {
    let cams: Vec<f32> = [0.0f32, -1.0].iter().flat_map(|&tx| [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, tx, 0.0, 0.0]).collect();
    let intr = [1000.0f32, 1000.0, 0.0, 0.0].repeat(2);
    let (mut pts, mut idx, mut px, mut wt) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let obs = |c: u32, p: u32, x: [f64; 3], dx: f64, w: f32, idx: &mut Vec<u32>, px: &mut Vec<f32>, wt: &mut Vec<f32>| {
        let u = 1000.0 * (x[0] - c as f64) / x[2] + dx;
        let v = 1000.0 * x[1] / x[2];
        idx.extend_from_slice(&[c, p]);
        px.extend_from_slice(&[u as f32, v as f32]);
        wt.extend_from_slice(&[w, w]);
        idx.len() / 2 - 1
    };
    for p in 0..20u32 {
        // Exact in f32, so the pixels below carry only the offsets put on them.
        let x = [0.25 * p as f64, 0.5, 10.0];
        pts.extend(x.iter().map(|&v| v as f32));
        for c in 0..2 { obs(c, p, x, if p % 2 == 0 { 0.5 } else { -0.5 }, 1.0, &mut idx, &mut px, &mut wt); }
    }
    let x0 = [0.0, 0.5, 10.0];
    let ox = obs(0, 0, x0, 4.0, 1.0 / 16.0, &mut idx, &mut px, &mut wt);
    let oy = obs(1, 0, x0, 1.0, 16.0, &mut idx, &mut px, &mut wt);
    let (problem, cams, pts) = Problem::parse(&wide(&cams), &wide(&intr), &wide(&pts), &idx, &px, &wt, &[], &[], &[], &[], &[], &[], &[]).unwrap();
    (problem, State { cams, pts, gpar: Vec::new() }, ox, oy)
}

fn model<'a>(p: &'a Problem, l: &'a Layout, sigma_units: bool) -> Model<'a> {
    Model { p, l, huber: None, sig: if sigma_units { p.w_ref } else { None } }
}

#[test]
fn the_robust_loss_reads_each_observation_in_its_own_sigma() {
    let (p, mut st, ox, oy) = two_sigma_problem();
    let l = Layout::new(&p, &[], 0, &[]);
    assert_eq!(p.w_ref, Some(1.0), "the median weight");
    for sigma_units in [true, false] {
        let m = model(&p, &l, sigma_units);
        st.gpar = m.initial_gpar();
        let dh = m.huber_threshold(&st);
        assert!((dh - 1.25).abs() < 1e-3, "threshold {dh}");
        let (jx, jy) = (m.jac(ox, &st, dh).unwrap(), m.jac(oy, &st, dh).unwrap());
        // Huber's IRLS weight: full up to δ, δ/e past it, times the observation's weight.
        let (ex, ey) = if sigma_units { (1.0, 4.0) } else { (4.0, 1.0) };
        let irls = |e: f64| if e <= dh { 1.0 } else { dh / e };
        assert!((jx.wu - irls(ex) / 16.0).abs() < 1e-4 / 16.0, "X: {} (σ units {sigma_units})", jx.wu);
        assert!((jy.wu - irls(ey) * 16.0).abs() < 1e-4 * 16.0, "Y: {} (σ units {sigma_units})", jy.wu);
        // The loss: X's 1 σ is quadratic in σ units; Y's 4 σ is Huber's linear branch,
        // w₀·(2δe − δ²) with e in σ units, continuous with its quadratic part.
        let rx = m.resid(ox, &st);
        let ry = m.resid(oy, &st);
        let rho_x = rho(rx, dh);
        let rho_y = rho(ry, dh);
        if sigma_units {
            assert!((rho_x - rx[0]).abs() < 1e-9, "X quadratic: {rho_x} vs q {}", rx[0]);
            assert!((rho_y - (2.0 * dh * 4.0 - dh * dh)).abs() < 1e-3, "Y linear: {rho_y}");
        } else {
            assert!((rho_y - ry[0]).abs() < 1e-9, "Y quadratic in px: {rho_y}");
            assert!(rho_x < rx[0] - 0.1, "X past δ in px: {rho_x} vs q {}", rx[0]);
        }
        // The robust cost the LM step judges agrees with the kept residuals' sum.
        let mut res = Vec::new();
        m.fill_residuals(&st, &mut res);
        assert_eq!(m.robust_cost(&st, dh).to_bits(), m.robust_cost_of(&res, &st, dh).to_bits());
        assert_eq!(m.huber_threshold(&st).to_bits(), m.huber_threshold_of(&res).to_bits());
    }
}

// σ units are normalised to the median weight: an observation of that weight reads its
// error in plain pixels to the bit, so a project whose ties all weigh the same solves as
// it did before, and one with equal weights everywhere never enters the σ path at all.
#[test]
fn an_observation_of_the_reference_weight_reads_plain_pixels_to_the_bit() {
    let (p, mut st, ox, oy) = two_sigma_problem();
    let l = Layout::new(&p, &[], 0, &[]);
    let (on, off) = (model(&p, &l, true), model(&p, &l, false));
    st.gpar = on.initial_gpar();
    let dh = off.huber_threshold(&st);
    for o in 0..p.obs.len() {
        if o == ox || o == oy { continue; }
        let (a, b) = (on.resid(o, &st), off.resid(o, &st));
        assert_eq!(a.map(f64::to_bits), b.map(f64::to_bits), "observation {o}");
        let (ja, jb) = (on.jac(o, &st, dh).unwrap(), off.jac(o, &st, dh).unwrap());
        assert_eq!((ja.wu.to_bits(), ja.wv.to_bits()), (jb.wu.to_bits(), jb.wv.to_bits()), "observation {o}");
    }
    // Equal weights, whatever their value: no reference weight, the pixel path.
    let obs: Vec<(u32, u32, f32, f32, f32, f32)> = (0..6).map(|i| (0, i, 0.0, 0.0, 0.189, 0.189)).collect();
    assert_eq!(problem::reference_weight(&obs), None);
    let mixed: Vec<_> = obs.iter().enumerate().map(|(i, o)| if i == 5 { (o.0, o.1, o.2, o.3, 0.189, 0.05) } else { *o }).collect();
    assert_eq!(problem::reference_weight(&mixed), Some(0.189f32 as f64));
    // Slot 11: off unless asked for.
    let mut flat = [f32::NAN; 12];
    assert!(!SolverOpts::from_flat(&flat).sigma_units);
    flat[11] = 1.0;
    assert!(SolverOpts::from_flat(&flat).sigma_units);
    flat[11] = 0.0;
    assert!(!SolverOpts::from_flat(&flat).sigma_units);
}

// End to end: a point seen by six cameras, five of them coarse keypoints (σ 2 px) that
// agree on its truth, one a fine keypoint (σ 0.5 px) 3 px off in y (6 σ). In pixels the
// fine one, under the 1 px threshold once the point has moved most of the way to it,
// outweighs the five; in σ units it stays an outlier and pulls with Huber's bounded force:
// the coarse ones end ≈ 1.6 px off instead of ≈ 2.3 (a y shift moves every view alike,
// so nothing else can absorb it).
#[test]
fn a_fine_keypoint_far_off_its_sigma_pulls_less_in_sigma_units() {
    let n_cam = 6;
    let cams: Vec<f32> = (0..n_cam).flat_map(|c| [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, -(c as f32), 0.0, 0.0]).collect();
    let intr = [1000.0f32, 1000.0, 0.0, 0.0].repeat(n_cam);
    let (mut pts, mut idx, mut px, mut wt) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    // 40 points that every camera sees exactly (they set the median and hold the cameras),
    // and point 40, the test.
    for p in 0..41u32 {
        let x = [0.5 + 0.1 * p as f64, 0.2 + 0.01 * p as f64, 10.0 + 0.05 * p as f64];
        pts.extend(x.iter().map(|&v| v as f32));
        for c in 0..n_cam {
            let mut u = 1000.0 * (x[0] - c as f64) / x[2];
            let mut v = 1000.0 * x[1] / x[2];
            let w: f32 = if p == 40 && c == 0 { 4.0 } else if p == 40 { 0.25 } else { 1.0 };
            if p == 40 && c == 0 { v += 3.0; }
            // The other points: ±0.4 px of noise, so the threshold is 2.5 × 0.4 = 1 px.
            if p < 40 { u += if (p + c as u32).is_multiple_of(2) { 0.4 } else { -0.4 }; }
            idx.extend_from_slice(&[c as u32, p]);
            px.extend_from_slice(&[u as f32, v as f32]);
            wt.extend_from_slice(&[w, w]);
        }
    }
    // Two cameras fixed (the gauge); the 40 other points hold the rest.
    let fixed = [1u8, 1, 0, 0, 0, 0];
    let err = |sigma_units: bool| {
        let mut policy = [f32::NAN; 12];
        policy[11] = if sigma_units { 1.0 } else { 0.0 };
        let out = bundle_adjust(&cams, &intr, &pts, &idx, &px, &wt, &[], &[], &[], 20, &[], 0, &policy, &fixed, &[]);
        let q = &out[n_cam * 12 + 120..n_cam * 12 + 123];
        // The coarse views' RMS residual through the solved cameras.
        let sse: f64 = (1..n_cam).map(|c| {
            let (r, o) = (&out[c * 12..c * 12 + 12], 40 * n_cam + c);
            let xc: Vec<f64> = (0..3).map(|i| (0..3).map(|k| r[3 * i + k] as f64 * q[k] as f64).sum::<f64>() + r[9 + i] as f64).collect();
            (1000.0 * xc[0] / xc[2] - px[2 * o] as f64).powi(2) + (1000.0 * xc[1] / xc[2] - px[2 * o + 1] as f64).powi(2)
        }).sum();
        (sse / (n_cam - 1) as f64).sqrt()
    };
    let (sig, pix) = (err(true), err(false));
    // Huber's balance in σ units: the fine view pulls with 2·w₀·δ·√w = 4 per px, the five
    // coarse ones with 5 · 0.25 · 2 · r: r = 1.6 px. In pixels the fine view keeps weight 4
    // and the coarse ones go past δ themselves: r ≈ 2.7 px.
    println!("coarse views: σ units {sig:.3} px, pixels {pix:.3} px");
    assert!((sig - 1.6).abs() < 0.15 && pix > 2.3, "coarse views' residual: σ units {sig} px, pixels {pix} px");
}
