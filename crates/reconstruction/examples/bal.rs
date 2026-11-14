// The bundle adjustment on a BAL problem (Bundle Adjustment in the Large, Agarwal et al.
// 2010, grail.cs.washington.edu/projects/bal), for comparing it with Ceres on the same
// objective (scripts/bench/bal/run.mjs). Prints one JSON line.
//
//   cargo run --release --features threads --example bal -- <problem.txt> [app|pcg|implicit] [max_iters]
//
// BAL's camera: x_c = R·X + t (R from an angle-axis), p = −x_c / z_c, a pixel f·d(p)·p
// with d = 1 + k1·|p|² + k2·|p|⁴, the origin at the image centre. That is this crate's
// pinhole with its own focal, k1 and k2 per camera (each camera its own intrinsics group,
// refine bits focal | k1 | k2) and the principal point at 0, once the camera is turned
// half a turn about x (x_c → (x, −y, −z)), which leaves u and negates v. The cost is
// Ceres': ½·Σ‖r‖², no robust loss (solver slot `huber` 0). `final_cost` is the solver's
// own; BAL's formula on the f32-rounded start checks the mapping (`mapping_ok`).
// BAL_TRACE=1 prints the cost after each iteration on stderr.
//
// Configurations: `app` is the app's solver policy (core/tuning.js SFM_TUNING.baSolver:
// the sparse direct solve of the reduced system, a function tolerance of 1e-6 floored at
// 1e-5 for exact steps); `pcg` the inexact one before it (block-Jacobi CG to 1e-6, at most
// 200 iterations, the capped iterate taken); `implicit` the app's solve past its memory
// budget (PCG on the reduced system without storing it, solver slot 6 = 2).

use reconstruction::bundle_adjust;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

// Bytes allocated now and at the peak, so a run can say what the solve held at most
// (`peak_alloc_mb`: the peak during `bundle_adjust`, above what was allocated before it).
// The wasm build holds about the same: its f64 data dominates, only its pointers are
// half as wide.
struct Counting;
static NOW: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() { PEAK.fetch_max(NOW.fetch_add(l.size(), Relaxed) + l.size(), Relaxed); }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        NOW.fetch_sub(l.size(), Relaxed);
    }
}
#[global_allocator]
static ALLOC: Counting = Counting;

struct Bal { n_cam: usize, n_pts: usize, obs: Vec<(u32, u32, f64, f64)>, cams: Vec<[f64; 9]>, pts: Vec<[f64; 3]> }

fn read_bal(path: &str) -> Bal {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let mut it = text.split_ascii_whitespace();
    let mut num = || -> f64 { it.next().expect("BAL file ends early").parse().expect("BAL number") };
    let (n_cam, n_pts, n_obs) = (num() as usize, num() as usize, num() as usize);
    let obs = (0..n_obs).map(|_| (num() as u32, num() as u32, num(), num())).collect();
    let cams = (0..n_cam).map(|_| std::array::from_fn(|_| num())).collect();
    let pts = (0..n_pts).map(|_| std::array::from_fn(|_| num())).collect();
    Bal { n_cam, n_pts, obs, cams, pts }
}

// Rodrigues: the rotation matrix of an angle-axis vector (Ceres' AngleAxisToRotationMatrix).
fn rot(w: &[f64]) -> [[f64; 3]; 3] {
    let th = (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]).sqrt();
    if th < 1e-12 {
        return [[1.0, -w[2], w[1]], [w[2], 1.0, -w[0]], [-w[1], w[0], 1.0]];
    }
    let (k, c, s) = ([w[0] / th, w[1] / th, w[2] / th], th.cos(), th.sin());
    let v = 1.0 - c;
    [
        [c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s],
        [k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s],
        [k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v],
    ]
}

// BAL's residual of one observation, in its own frame and formula.
fn bal_residual(r: &[[f64; 3]; 3], t: &[f64; 3], f: f64, k1: f64, k2: f64, x: &[f64; 3], ox: f64, oy: f64) -> (f64, f64) {
    let pc = [0, 1, 2].map(|i| r[i][0] * x[0] + r[i][1] * x[1] + r[i][2] * x[2] + t[i]);
    let (px, py) = (-pc[0] / pc[2], -pc[1] / pc[2]);
    let r2 = px * px + py * py;
    let d = 1.0 + r2 * (k1 + k2 * r2);
    (f * d * px - ox, f * d * py - oy)
}

// ½·Σ‖r‖² over the observations, cameras as (R, t, f, k1, k2).
fn bal_cost(b: &Bal, cams: &[([[f64; 3]; 3], [f64; 3], f64, f64, f64)], pts: &[[f64; 3]]) -> f64 {
    b.obs.iter().map(|&(c, p, ox, oy)| {
        let (r, t, f, k1, k2) = &cams[c as usize];
        let (ex, ey) = bal_residual(r, t, *f, *k1, *k2, &pts[p as usize], ox, oy);
        0.5 * (ex * ex + ey * ey)
    }).sum()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("usage: bal <problem.txt> [app|pcg|implicit] [max_iters]");
    let config = args.get(2).map(String::as_str).unwrap_or("app");
    let max_iters: u32 = args.get(3).and_then(|v| v.parse().ok()).unwrap_or(100);
    let t_read = Instant::now();
    let b = read_bal(path);
    let read_s = t_read.elapsed().as_secs_f64();

    let cams0: Vec<_> = b.cams.iter().map(|c| (rot(&c[0..3]), [c[3], c[4], c[5]], c[6], c[7], c[8])).collect();
    let cost0 = bal_cost(&b, &cams0, &b.pts);

    // To the crate's frame: R' = D·R, t' = D·t with D = diag(1, −1, −1); v' = −v.
    let mut cameras_flat = Vec::with_capacity(b.n_cam * 12);
    let mut intrinsics_flat = Vec::with_capacity(b.n_cam * 4);
    let mut lens_flat = Vec::with_capacity(b.n_cam * 5);
    for (r, t, f, k1, k2) in &cams0 {
        for (i, s) in [1.0, -1.0, -1.0].iter().enumerate() { cameras_flat.extend(r[i].iter().map(|v| (s * v) as f32)); }
        cameras_flat.extend([t[0] as f32, -t[1] as f32, -t[2] as f32]);
        intrinsics_flat.extend([*f as f32, *f as f32, 0.0, 0.0]);
        lens_flat.extend([0.0, *k1 as f32, *k2 as f32, 0.0, 0.0]);
    }
    let pts_flat: Vec<f32> = b.pts.iter().flat_map(|p| p.map(|v| v as f32)).collect();
    let obs_index: Vec<u32> = b.obs.iter().flat_map(|o| [o.0, o.1]).collect();
    let obs_px: Vec<f32> = b.obs.iter().flat_map(|o| [o.2 as f32, -o.3 as f32]).collect();
    let weight = vec![1.0f32; b.obs.len() * 2];
    let sensor_of_cam = vec![-1i32; b.n_cam]; // each camera its own focal, k1, k2
    let nan = f32::NAN;
    // [pcg_min_n, rel_tol, max_iter, accept_partial, function_tol, precond, direct, warm,
    //  huber, covariance, memory MiB]. BAL_MEMORY_MB sets the memory slot: 0 makes `app`
    // solve implicitly, a large value lets the direct solve take any size.
    let memory_mb: f32 = std::env::var("BAL_MEMORY_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(nan);
    let solver_flat: [f32; 11] = match config {
        "app" => [nan, 1e-6, 200.0, 1.0, 1e-6, nan, 1.0, nan, 0.0, nan, memory_mb],
        "pcg" => [nan, 1e-6, 200.0, 1.0, 1e-6, nan, 0.0, nan, 0.0, nan, memory_mb],
        "implicit" => [nan, 1e-6, 200.0, 1.0, 1e-6, nan, 2.0, nan, 0.0, nan, memory_mb],
        other => panic!("unknown configuration {other} (app, pcg, implicit)"),
    };
    let refine_mask = 1 | 4 | 8; // focal scale, k1, k2
    // The solver takes f32 in and gives f32 out (the app's arrays). Its own cost, in f64
    // on the problem as rounded, is what it reports; check the frame mapping on that
    // rounded start, where BAL's formula must give the solver's initial cost. Rounding the
    // output again would not be a fair score: a point close to a camera's plane turns 1e-7
    // of rounding into pixels (×10⁸ on the large Ladybug problems), and the app keeps
    // its own f64 state between iterations.
    let start: Vec<_> = (0..b.n_cam).map(|c| {
        let v = |i: usize| cameras_flat[c * 12 + i] as f64;
        let s = [1.0, -1.0, -1.0];
        let r = [0, 1, 2].map(|i| [0, 1, 2].map(|j| s[i] * v(i * 3 + j)));
        (r, [v(9), -v(10), -v(11)], intrinsics_flat[c * 4] as f64, lens_flat[c * 5 + 1] as f64, lens_flat[c * 5 + 2] as f64)
    }).collect();
    let start_pts: Vec<[f64; 3]> = pts_flat.chunks(3).map(|p| [p[0] as f64, p[1] as f64, p[2] as f64]).collect();
    let cost0_f32 = bal_cost(&b, &start, &start_pts);

    let base = NOW.load(Relaxed);
    PEAK.store(base, Relaxed);
    let t0 = Instant::now();
    let out = bundle_adjust(
        &cameras_flat, &intrinsics_flat, &pts_flat, &obs_index, &obs_px, &weight, &[], &[], &[],
        max_iters, &sensor_of_cam, refine_mask, &solver_flat, &[], &lens_flat,
    );
    let solve_s = t0.elapsed().as_secs_f64();
    let peak_alloc_mb = (PEAK.load(Relaxed) - base) as f64 / (1 << 20) as f64;
    assert!(!out.is_empty(), "bundle_adjust refused the problem");

    let (nc, np) = (b.n_cam, b.n_pts);
    let o_cost = nc * 12 + np * 3 + nc * 8;
    let (rms0, rms1) = (out[o_cost] as f64, out[o_cost + 1] as f64);
    let stats = &out[o_cost + 4..o_cost + 4 + 10]; // BA_STATS_LEN
    let trace = &out[o_cost + 4 + 10..];
    let n_obs = b.obs.len() as f64;
    // BAL_TRACE=1: the cost after each accepted iteration (½·Σ‖r‖², from the RMS trace),
    // to set beside `BAL_TRACE=1 ceres_bal`'s.
    if std::env::var_os("BAL_TRACE").is_some() {
        let costs: Vec<String> = trace.iter().map(|r| format!("{:.6e}", 0.5 * (*r as f64).powi(2) * n_obs)).collect();
        eprintln!("TRACE {}", costs.join(" "));
    }
    let (solver0, solver1) = (0.5 * rms0 * rms0 * n_obs, 0.5 * rms1 * rms1 * n_obs);
    // rms0 comes back as f32: agreement to its 1e-7, not to f64.
    let mapping_ok = ((solver0 - cost0_f32) / cost0_f32).abs() < 1e-5;
    println!(
        "{{\"file\":\"{}\",\"solver\":\"websfm-{}\",\"cameras\":{},\"points\":{},\"observations\":{},\
\"initial_cost\":{:.10e},\"start_cost_f32\":{:.10e},\"solver_initial_cost\":{:.10e},\"final_cost\":{:.10e},\
\"mapping_ok\":{},\"iterations\":{},\"linear_solves\":{},\"cholesky\":{},\"implicit\":{},\"pcg_iters\":{},\"solve_s\":{:.3},\"read_s\":{:.3},\"peak_alloc_mb\":{:.0},\"threads\":{}}}",
        path, config, nc, np, b.obs.len(), cost0, cost0_f32, solver0, solver1, mapping_ok,
        trace.len(), stats[1] as u32, stats[2] as u32, stats[9] as u32, stats[7] as u64, solve_s, read_s, peak_alloc_mb,
        if cfg!(feature = "threads") { std::thread::available_parallelism().map_or(1, |n| n.get()) } else { 1 },
    );
}
