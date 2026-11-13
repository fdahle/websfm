use super::*;

// Deterministic pseudo-random numbers in [-1, 1).
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
    }
}

// A reduced-camera-like system: 6×6 camera blocks coupled through shared points
// (each "point" links a few cameras), two intrinsics groups coupled to every
// camera, plus LM-style damping on the diagonal. A = JᵀJ + damping, SPD.
fn ba_like(n_cam: usize, seed: u64) -> (usize, Vec<f64>, Vec<f64>, Vec<(usize, usize)>) {
    let kdim = 6;
    let n = 6 * n_cam + 2 * kdim;
    let mut rng = Lcg(seed);
    let mut a = vec![0f64; n * n];
    let mut add_row = |row: &[(usize, f64)], a: &mut Vec<f64>| {
        for &(i, vi) in row { for &(j, vj) in row { a[i * n + j] += vi * vj; } }
    };
    for p in 0..n_cam * 40 {
        let c0 = p % n_cam;
        let cams = [c0, (c0 + 1 + p % 3) % n_cam, (c0 + 5 + p % 7) % n_cam];
        for _ in 0..2 {
            let mut row = Vec::new();
            for &c in &cams { for k in 0..6 { row.push((6 * c + k, rng.next())); } }
            let g = 6 * n_cam + (p % 2) * kdim;
            for k in 0..kdim { row.push((g + k, 0.3 * rng.next())); }
            add_row(&row, &mut a);
        }
    }
    for i in 0..n { a[i * n + i] = a[i * n + i] * 1.001 + 1e-3; }
    let b: Vec<f64> = (0..n).map(|_| rng.next()).collect();
    let blocks = (0..n_cam).map(|c| (6 * c, 6))
        .chain((0..2).map(|g| (6 * n_cam + g * kdim, kdim))).collect();
    (n, a, b, blocks)
}

#[test]
fn pcg_matches_cholesky_on_a_reduced_camera_system() {
    let (n, a, b, blocks) = ba_like(100, 7);
    assert!(n >= PCG_MIN_N);
    let exact = chol_solve(n, &a, &b).unwrap();
    let x = match pcg_solve(n, &a, &b, &blocks, 1e-10, 2000) {
        PcgResult::Converged(x, _) => x,
        _ => panic!("PCG did not converge"),
    };
    let err = x.iter().zip(&exact).map(|(u, v)| (u - v) * (u - v)).sum::<f64>().sqrt();
    let norm = exact.iter().map(|v| v * v).sum::<f64>().sqrt();
    assert!(err <= 1e-7 * norm, "relative error {}", err / norm);
    // And through the dispatcher, which takes the PCG path at this size.
    let mut st = SolveStats::default();
    let y = solve_reduced(n, &a, &b, &blocks, &SolverOpts::DEFAULT, &mut st).unwrap();
    let err2 = y.iter().zip(&exact).map(|(u, v)| (u - v) * (u - v)).sum::<f64>().sqrt();
    assert!(err2 <= 1e-7 * norm);
    assert_eq!((st.solves, st.pcg_converged, st.cholesky, st.pcg_fallback), (1, 1, 0, 0));
    assert!(st.pcg_iters > 0 && st.pcg_iters as u32 == st.pcg_iters_max);
}

#[test]
fn solver_opts_parse_with_per_slot_defaults() {
    assert_eq!(SolverOpts::from_flat(&[]), SolverOpts::DEFAULT);
    assert_eq!(SolverOpts::from_flat(&[f32::NAN, f32::NAN, f32::NAN, f32::NAN]), SolverOpts::DEFAULT);
    let o = SolverOpts::from_flat(&[f32::INFINITY, 1e-6, 200.0, 1.0]);
    assert_eq!(o.pcg_min_n, usize::MAX); // "never PCG"
    assert!((o.rel_tol - 1e-6).abs() < 1e-12);
    assert_eq!((o.max_iter, o.accept_partial), (200, true));
    // Nonsense values keep the default rather than producing a degenerate solver.
    let bad = SolverOpts::from_flat(&[-1.0, 0.0, 0.0, f32::NAN]);
    assert_eq!(bad, SolverOpts::DEFAULT);
    // The function tolerance is the fifth slot; absent, NaN or negative ⇒ 0 (off).
    assert!((SolverOpts::from_flat(&[f32::NAN, f32::NAN, f32::NAN, f32::NAN, 1e-6]).function_tol - 1e-6).abs() < 1e-12);
    assert_eq!(SolverOpts::from_flat(&[f32::NAN, f32::NAN, f32::NAN, f32::NAN, -1.0]).function_tol, 0.0);
    // The direct solve is the seventh slot: 1 on, anything else off.
    assert_eq!(SolverOpts::from_flat(&[f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, 1.0]).direct, 1);
    assert_eq!(SolverOpts::from_flat(&[f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, 0.0]).direct, 0);
    assert_eq!(SolverOpts::from_flat(&[f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, 1.0]).warm, 1);
    assert_eq!(SolverOpts::from_flat(&[f32::NAN; 7]).warm, 0);
    // The robust loss is the ninth slot: absent / NaN / negative ⇒ adaptive (None),
    // 0 ⇒ none, > 0 ⇒ a fixed threshold.
    assert_eq!(SolverOpts::from_flat(&[f32::NAN; 8]).huber, None);
    assert_eq!(SolverOpts::from_flat(&[f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, -1.0]).huber, None);
    assert_eq!(SolverOpts::from_flat(&[f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, 0.0]).huber, Some(0.0));
    assert_eq!(SolverOpts::from_flat(&[f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, 2.0]).huber, Some(2.0));
}

#[test]
fn capped_pcg_falls_back_or_returns_its_iterate() {
    let (n, a, b, blocks) = ba_like(100, 7);
    let exact = chol_solve(n, &a, &b).unwrap();
    let rel = |x: &[f64]| {
        let e = x.iter().zip(&exact).map(|(u, v)| (u - v) * (u - v)).sum::<f64>().sqrt();
        e / exact.iter().map(|v| v * v).sum::<f64>().sqrt()
    };
    // A 3-iteration cap cannot reach 1e-10: the default falls back to Cholesky…
    let capped = SolverOpts { max_iter: 3, ..SolverOpts::DEFAULT };
    let mut st = SolveStats::default();
    let x = solve_reduced(n, &a, &b, &blocks, &capped, &mut st).unwrap();
    assert_eq!((st.pcg_fallback, st.pcg_partial, st.pcg_iters), (1, 0, 3));
    assert!(rel(&x) < 1e-9);
    // …while accept_partial returns the CG iterate: inexact, but a descent step for
    // the quadratic model ½xᵀAx − bᵀx (lower than at x = 0), which is all LM needs.
    let mut st = SolveStats::default();
    let y = solve_reduced(n, &a, &b, &blocks, &SolverOpts { accept_partial: true, ..capped }, &mut st).unwrap();
    assert_eq!((st.pcg_fallback, st.pcg_partial), (0, 1));
    assert!(rel(&y) > 1e-6);
    let model = |x: &[f64]| {
        let mut q = 0.0;
        for i in 0..n { let ax: f64 = (0..n).map(|j| a[i * n + j] * x[j]).sum(); q += 0.5 * x[i] * ax - b[i] * x[i]; }
        q
    };
    assert!(model(&y) < 0.0);
    // pcg_min_n = ∞ keeps everything on Cholesky.
    let mut st = SolveStats::default();
    let z = solve_reduced(n, &a, &b, &blocks, &SolverOpts { pcg_min_n: usize::MAX, ..SolverOpts::DEFAULT }, &mut st).unwrap();
    assert_eq!(z, exact);
    assert_eq!((st.cholesky, st.pcg_iters), (1, 0));
}

#[test]
fn pcg_reports_an_indefinite_matrix() {
    let n = 3;
    let a = vec![1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 1.0];
    let blocks = [(0usize, 1usize), (1, 1), (2, 1)];
    assert!(matches!(pcg_solve(n, &a, &[1.0, 1.0, 1.0], &blocks, 1e-10, 10), PcgResult::NotPositiveDefinite(_)));
}

// cargo test -p reconstruction --release -- --ignored --nocapture reduced_solve_timing
#[test]
#[ignore]
fn reduced_solve_timing() {
    let (n, a, b, blocks) = ba_like(522, 11);
    let t = std::time::Instant::now();
    let exact = chol_solve(n, &a, &b).unwrap();
    let chol = t.elapsed();
    let t = std::time::Instant::now();
    let x = solve_reduced(n, &a, &b, &blocks, &SolverOpts::DEFAULT, &mut SolveStats::default()).unwrap();
    let pcg = t.elapsed();
    let err = x.iter().zip(&exact).map(|(u, v)| (u - v).abs()).fold(0.0, f64::max);
    println!("n = {n}: cholesky {chol:?}, pcg {pcg:?}, max |dx| {err:e}");
}

// The block-sparse system against the dense one it replaced: same nonzeros in the
// same order, so matvec, PCG and Cholesky must agree to the bit.
#[test]
fn block_sparse_solves_bit_identically_to_dense() {
    let n_cam = 120;
    let kdim = 3;
    let mut rng = Lcg(5);
    // Cameras couple in a ring of four neighbours; two intrinsics groups.
    let mut dims = vec![6usize; n_cam];
    dims.extend([kdim, kdim]);
    let pat = BlockPattern::new(dims, |r, touch| {
        // Every camera couples with both groups (as when each group's cameras
        // share points with all others), so the pattern is symmetric.
        if r < n_cam { for d in 1..=4 { touch((r + d) % n_cam); touch((r + n_cam - d) % n_cam); } }
        else { for c in 0..n_cam { touch(c); } }
        touch(n_cam); touch(n_cam + 1);
    });
    let n = pat.n;
    // A symmetric SPD fill: random blocks mirrored, then a dominant diagonal.
    let mut vals = vec![0f64; pat.n_vals];
    for r in 0..pat.dims.len() {
        for k in pat.row_ptr[r]..pat.row_ptr[r + 1] {
            let c = pat.cols[k] as usize;
            if c > r { continue; }
            let (rd, cd) = (pat.dims[r], pat.dims[c]);
            let (rc, cr) = (pat.val_at[k], pat.at(c, r));
            for i in 0..rd { for j in 0..cd {
                let v = if c == r && j < i { vals[rc + j * cd + i] } else { 0.1 * rng.next() };
                vals[rc + i * cd + j] = v;
                vals[cr + j * rd + i] = v;
            }}
        }
    }
    for r in 0..pat.dims.len() { let (d, b) = (pat.dims[r], pat.diag_at[r]); for i in 0..d { vals[b + i * d + i] += 40.0; } }
    let a = pat.to_dense(&vals);
    let x: Vec<f64> = (0..n).map(|_| rng.next()).collect();
    let (mut y1, mut y2) = (vec![0f64; n], vec![0f64; n]);
    pat.matvec(&vals, &x, &mut y1);
    dense_matvec(n, &a, &x, &mut y2);
    assert_eq!(y1, y2);
    let blocks: Vec<(usize, usize)> = (0..pat.dims.len()).map(|r| (pat.offs[r], pat.dims[r])).collect();
    for opts in [SolverOpts::DEFAULT, SolverOpts { pcg_min_n: 0, ..SolverOpts::DEFAULT }, SolverOpts { pcg_min_n: usize::MAX, ..SolverOpts::DEFAULT }] {
        let (mut s1, mut s2) = (SolveStats::default(), SolveStats::default());
        let dense = solve_reduced(n, &a, &x, &blocks, &opts, &mut s1).unwrap();
        let sparse = solve_reduced_with(n, |u, v| pat.matvec(&vals, u, v), &pat.diag_blocks(&vals), None,
                                        || pat.to_dense(&vals), true, &x, &opts, &mut s2).unwrap();
        assert_eq!(dense, sparse);
        assert_eq!(s1, s2);
    }
    // No dense fallback allowed: a capped CG returns its iterate instead.
    let mut st = SolveStats::default();
    let capped = SolverOpts { pcg_min_n: usize::MAX, max_iter: 2, ..SolverOpts::DEFAULT };
    assert!(solve_reduced_with(n, |u, v| pat.matvec(&vals, u, v), &pat.diag_blocks(&vals), None,
                               || panic!("dense copy built above DENSE_MAX_N"), false, &x, &capped, &mut st).is_some());
    assert_eq!((st.pcg_partial, st.cholesky, st.pcg_fallback), (1, 0, 0));
}

// A random SPD fill of a pattern (mirrored blocks, dominant diagonal).
fn spd_fill(pat: &BlockPattern, seed: u64, diag: f64) -> Vec<f64> {
    let mut rng = Lcg(seed);
    let mut vals = vec![0f64; pat.n_vals];
    for r in 0..pat.dims.len() {
        for k in pat.row_ptr[r]..pat.row_ptr[r + 1] {
            let c = pat.cols[k] as usize;
            if c > r { continue; }
            let (rd, cd) = (pat.dims[r], pat.dims[c]);
            let (rc, cr) = (pat.val_at[k], pat.at(c, r));
            for i in 0..rd { for j in 0..cd {
                let v = if c == r && j < i { vals[rc + j * cd + i] } else { 0.1 * rng.next() };
                vals[rc + i * cd + j] = v;
                vals[cr + j * rd + i] = v;
            }}
        }
    }
    // Diagonal = the row's absolute off-diagonal sum · (1 + diag): strictly dominant, so SPD.
    for r in 0..pat.dims.len() {
        let (d, b) = (pat.dims[r], pat.diag_at[r]);
        for i in 0..d {
            let mut sum = 0.0;
            for k in pat.row_ptr[r]..pat.row_ptr[r + 1] {
                let c = pat.cols[k] as usize; let cd = pat.dims[c];
                for j in 0..cd { if !(c == r && j == i) { sum += vals[pat.val_at[k] + i * cd + j].abs(); } }
            }
            vals[b + i * d + i] = sum * (1.0 + diag);
        }
    }
    vals
}

// An aerial block's camera graph: a rows×cols grid, each camera coupled with those
// within `radius` (Chebyshev), plus one intrinsics group coupled with all.
fn aerial_pattern(rows: usize, cols: usize, radius: isize, kdim: usize) -> BlockPattern {
    let n_cam = rows * cols;
    let mut dims = vec![6usize; n_cam];
    dims.push(kdim);
    BlockPattern::new(dims, |r, touch| {
        if r == n_cam { for c in 0..=n_cam { touch(c) } return }
        let (y, x) = ((r / cols) as isize, (r % cols) as isize);
        for dy in -radius..=radius { for dx in -radius..=radius {
            let (yy, xx) = (y + dy, x + dx);
            if yy >= 0 && xx >= 0 && (yy as usize) < rows && (xx as usize) < cols { touch(yy as usize * cols + xx as usize) }
        }}
        touch(n_cam);
    })
}

#[test]
fn sparse_cholesky_solves_as_the_dense_one() {
    use crate::sparse_chol::Symbolic;
    for (pat, seed) in [(aerial_pattern(9, 7, 2, 4), 3u64), (aerial_pattern(1, 40, 3, 6), 5)] {
        let vals = spd_fill(&pat, seed, 0.05);
        let n = pat.n;
        let mut rng = Lcg(seed + 1);
        let b: Vec<f64> = (0..n).map(|_| rng.next()).collect();
        let exact = chol_solve(n, &pat.to_dense(&vals), &b).unwrap();
        let sym = Symbolic::new(&pat, usize::MAX).unwrap();
        let x = sym.factor(&pat, &vals).unwrap().solve(&pat, &b);
        let err = x.iter().zip(&exact).map(|(u, v)| (u - v).abs()).fold(0.0, f64::max);
        let norm = exact.iter().map(|v| v.abs()).fold(0.0, f64::max);
        assert!(err <= 1e-10 * norm, "max error {err:e} of {norm:e}");
    }
    // Not positive-definite: no factor (the LM loop then raises its damping).
    let pat = aerial_pattern(4, 4, 1, 3);
    let mut vals = spd_fill(&pat, 9, 0.05);
    vals[pat.diag_at[5]] = -1.0;
    assert!(Symbolic::new(&pat, usize::MAX).unwrap().factor(&pat, &vals).is_none());
    // A fill bound refuses the ordering rather than blowing memory.
    assert!(Symbolic::new(&aerial_pattern(20, 20, 3, 4), 100).is_none());
}

// A realistic aerial bundle adjustment, timed by phase:
// cargo test -p reconstruction --release -- --ignored --nocapture bundle_adjust_timing
#[test]
#[ignore]
fn bundle_adjust_timing() {
    let side = 40usize;
    let n_cam = side * side;
    let mut rng = Lcg(17);
    let mut cams = Vec::new();
    let mut intr = Vec::new();
    for c in 0..n_cam {
        let (x, y) = ((c % side) as f32, (c / side) as f32);
        cams.extend_from_slice(&[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, -x, -y, 10.0]);
        intr.extend_from_slice(&[800.0, 800.0, 320.0, 240.0]);
    }
    let (mut pts, mut idx, mut px) = (Vec::new(), Vec::new(), Vec::new());
    let n_pts = n_cam * 70;
    for p in 0..n_pts {
        let (x, y, z) = (rng.next() * 0.5 * side as f64 + 0.5 * side as f64, rng.next() * 0.5 * side as f64 + 0.5 * side as f64, 0.5 * rng.next());
        let (cx0, cy0) = (x.round() as isize, y.round() as isize);
        let mut seen = 0;
        for dy in -1..=1 { for dx in -1..=1 {
            let (gx, gy) = (cx0 + dx, cy0 + dy);
            if gx < 0 || gy < 0 || gx >= side as isize || gy >= side as isize { continue }
            let c = gy as usize * side + gx as usize;
            let (u, v) = (800.0 * (x - gx as f64) / (z + 10.0) + 320.0, 800.0 * (y - gy as f64) / (z + 10.0) + 240.0);
            idx.extend_from_slice(&[c as u32, p as u32]);
            px.extend_from_slice(&[(u + 0.3 * rng.next()) as f32, (v + 0.3 * rng.next()) as f32]);
            seen += 1;
        }}
        assert!(seen > 0);
        pts.extend_from_slice(&[(x + 0.01 * rng.next()) as f32, (y + 0.01 * rng.next()) as f32, (z + 0.01 * rng.next()) as f32]);
    }
    let mut prior = vec![0f32; 31];
    prior[3] = -10.0; prior[4] = 1e4; prior[8] = 1e4; prior[12] = 1e4;
    let policy = [f32::NAN, 1e-6, 200.0, 1.0, 1e-6, f32::NAN, 1.0];
    let t = std::time::Instant::now();
    let out = bundle_adjust(&cams, &intr, &pts, &idx, &px, &[], &[], &[], &prior, 30, &[], 0, &policy, &[], &[]);
    let total = t.elapsed();
    let base = n_cam * 12 + n_pts * 3 + n_cam * 8;
    let ph = prof::take();
    println!("{n_cam} cameras, {n_pts} points, {} observations: {total:?}, rms {:.3} → {:.3}, {} solves",
        idx.len() / 2, out[base], out[base + 1], out[base + 5]);
    println!("  phases (s): cost {:.2}, assemble {:.2}, schur {:.2}, solve {:.2}, back-substitute + trial cost {:.2}", ph[0], ph[1], ph[2], ph[3], ph[4]);
}

// cargo test -p reconstruction --release -- --ignored --nocapture sparse_cholesky_timing
#[test]
#[ignore]
fn sparse_cholesky_timing() {
    use crate::sparse_chol::Symbolic;
    for (rows, cols, radius) in [(30, 30, 3), (40, 40, 3), (50, 50, 3), (55, 55, 3)] {
        let pat = aerial_pattern(rows, cols, radius, 6);
        let vals = spd_fill(&pat, 1, 0.05);
        let mut rng = Lcg(2);
        let b: Vec<f64> = (0..pat.n).map(|_| rng.next()).collect();
        let t = std::time::Instant::now();
        let sym = Symbolic::new(&pat, usize::MAX).unwrap();
        let t_sym = t.elapsed();
        let t = std::time::Instant::now();
        let f = sym.factor(&pat, &vals).unwrap();
        let t_fac = t.elapsed();
        let t = std::time::Instant::now();
        let _x = f.solve(&pat, &b);
        let t_sol = t.elapsed();
        let a_blocks = pat.cols.len();
        let t = std::time::Instant::now();
        let mut y = vec![0f64; pat.n];
        for _ in 0..20 { pat.matvec(&vals, &b, &mut y) }
        let t_mv = t.elapsed() / 20;
        let (n_sn, mean_w) = sym.supernode_stats();
        println!("{} cameras (n {}): A {} blocks, L {} blocks ({:.0} MB), {n_sn} supernodes ({mean_w:.1} blocks wide); ordering {t_sym:?}, factor {t_fac:?} ({:.2} GFLOP/s of {:.2} GFLOP), solve {t_sol:?}; one matvec {t_mv:?}",
            rows * cols, pat.n, a_blocks, sym.fill_blocks, sym.factor_bytes() as f64 / 1e6,
            sym.flops() / t_fac.as_secs_f64() / 1e9, sym.flops() / 1e9);
    }
}

#[test]
fn block_ic0_is_exact_without_fill_and_beats_jacobi_with_it() {
    // A chain (block tridiagonal) has no fill: IC(0) is the Cholesky factor itself.
    let chain = BlockPattern::new(vec![6; 50], |r, touch| { if r > 0 { touch(r - 1); } if r + 1 < 50 { touch(r + 1); } });
    let vals = spd_fill(&chain, 3, 0.05);
    let b: Vec<f64> = (0..chain.n).map(|i| (i as f64 * 0.37).sin()).collect();
    let exact = chol_solve(chain.n, &chain.to_dense(&vals), &b).unwrap();
    let ic = BlockIc::new(&chain, &vals).expect("SPD chain factorises");
    match pcg_core_with(chain.n, |x, y| chain.matvec(&vals, x, y), &chain.diag_blocks(&vals), Some(&ic), &b, 1e-10, 50) {
        PcgResult::Converged(x, it) => {
            assert!(it <= 2, "IC(0) is exact on a chain, took {it} iterations");
            let err = x.iter().zip(&exact).map(|(u, v)| (u - v).abs()).fold(0.0, f64::max);
            assert!(err < 1e-9, "max error {err}");
        }
        _ => panic!("did not converge"),
    }
    // A ring with groups (fill dropped): same answer as Cholesky, fewer iterations.
    let n_cam = 200;
    let mut dims = vec![6usize; n_cam];
    dims.extend([3, 3]);
    let ring = BlockPattern::new(dims, |r, touch| {
        if r < n_cam { for d in 1..=6 { touch((r + d) % n_cam); touch((r + n_cam - d) % n_cam); } }
        else { for c in 0..n_cam { touch(c); } }
        touch(n_cam); touch(n_cam + 1);
    });
    let vals = spd_fill(&ring, 8, 0.02);
    let b: Vec<f64> = (0..ring.n).map(|i| (i as f64 * 0.11).cos()).collect();
    let exact = chol_solve(ring.n, &ring.to_dense(&vals), &b).unwrap();
    let iters = |ic: Option<&BlockIc>| match pcg_core_with(ring.n, |x, y| ring.matvec(&vals, x, y), &ring.diag_blocks(&vals), ic, &b, 1e-10, 5000) {
        PcgResult::Converged(x, it) => {
            let err = x.iter().zip(&exact).map(|(u, v)| (u - v).abs()).fold(0.0, f64::max);
            assert!(err < 1e-7, "max error {err}");
            it
        }
        _ => panic!("did not converge"),
    };
    let ic = BlockIc::new(&ring, &vals).expect("factorises");
    let (jac, icn) = (iters(None), iters(Some(&ic)));
    assert!(icn < jac, "IC(0) {icn} vs block-Jacobi {jac} iterations");
}

// LM gives up only on a step rejected at the largest damping (or one too small to
// move the model): one iteration's tries reach LAMBDA_MAX from λ's floor. A fixed 8
// tries reached ~20 from λ's working level, and left BAL's largest Ladybug problems at
// ×28 Ceres' cost (docs/METHODS.md §4.5).
// The lens's derivatives against central differences of the projection itself, for
// Brown (radial + decentring) and Kannala–Brandt, over points across a wide frame.
#[test]
fn the_lens_jacobian_is_the_projections_derivative() {
    let value = |a: f64, b: f64, k: &[f64; 4], p: &[f64; 2], fe: bool| -> (f64, f64) {
        let (m, _, _) = lens_factor(a * a + b * b, k, fe);
        distort_norm(a, b, m, p)
    };
    let h = 1e-6;
    let cases: [([f64; 4], [f64; 2], bool); 3] = [
        ([-0.12, 0.05, -0.01, 0.0], [0.0021, -0.0008], false),
        ([0.04, -0.22, 0.33, 0.0], [-0.003, 0.0015], false),
        ([0.02, -0.01, 0.003, -0.0005], [0.0, 0.0], true),
    ];
    for (k, p, fe) in cases {
        for &(a, b) in &[(0.31, -0.22), (-0.6, 0.45), (0.05, 0.9), (-0.8, -0.7)] {
            let dj = distort_jac(a, b, &k, &p, fe);
            let (x0, y0) = value(a, b, &k, &p, fe);
            assert!((dj.xd - x0).abs() < 1e-15 && (dj.yd - y0).abs() < 1e-15);
            let near = |num: f64, ana: f64, what: &str| {
                assert!((num - ana).abs() < 1e-6 * (1.0 + ana.abs()), "{what} at ({a},{b}) fisheye {fe}: {num} vs {ana}");
            };
            let (xp, yp) = value(a + h, b, &k, &p, fe); let (xm, ym) = value(a - h, b, &k, &p, fe);
            near((xp - xm) / (2.0 * h), dj.j[0][0], "dxd/da"); near((yp - ym) / (2.0 * h), dj.j[1][0], "dyd/da");
            let (xp, yp) = value(a, b + h, &k, &p, fe); let (xm, ym) = value(a, b - h, &k, &p, fe);
            near((xp - xm) / (2.0 * h), dj.j[0][1], "dxd/db"); near((yp - ym) / (2.0 * h), dj.j[1][1], "dyd/db");
            for i in 0..4 {
                let (mut kp, mut km) = (k, k); kp[i] += h; km[i] -= h;
                let (xp, yp) = value(a, b, &kp, &p, fe); let (xm, ym) = value(a, b, &km, &p, fe);
                near((xp - xm) / (2.0 * h), a * dj.dk[i], "dxd/dk"); near((yp - ym) / (2.0 * h), b * dj.dk[i], "dyd/dk");
            }
            if !fe {
                for i in 0..2 {
                    let (mut pp, mut pm) = (p, p); pp[i] += h; pm[i] -= h;
                    let (xp, yp) = value(a, b, &k, &pp, fe); let (xm, ym) = value(a, b, &k, &pm, fe);
                    near((xp - xm) / (2.0 * h), dj.dp[0][i], "dxd/dp"); near((yp - ym) / (2.0 * h), dj.dp[1][i], "dyd/dp");
                }
            }
        }
    }
}

#[test]
fn lm_tries_reach_the_largest_damping() {
    let (mut lambda, mut tries) = (LAMBDA_MIN, 1);
    while lambda < LAMBDA_MAX { lambda = (lambda * 4.0).min(LAMBDA_MAX); tries += 1; }
    assert!(tries <= LM_MAX_TRIES, "{tries} tries from {LAMBDA_MIN:e} to {LAMBDA_MAX:e}, {LM_MAX_TRIES} allowed");
}

// Points started at 1 % of their depth, on camera 0's rays: the first steps throw
// them far off, and LM has to damp its way back to the exact solution.
#[test]
fn lm_converges_from_points_started_near_a_camera() {
    let n_cam = 8;
    let mut rng = Lcg(5);
    let (mut cams, mut intr) = (Vec::new(), Vec::new());
    for c in 0..n_cam {
        cams.extend_from_slice(&[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, -(c as f32), 0.0, 0.0]);
        intr.extend_from_slice(&[1000.0, 1000.0, 0.0, 0.0]);
    }
    let (mut pts, mut idx, mut px) = (Vec::new(), Vec::new(), Vec::new());
    let n_pts = 200;
    for p in 0..n_pts {
        let truth = [3.5 + 4.0 * rng.next(), 3.0 * rng.next(), 10.0 + 2.0 * rng.next()];
        for c in 0..n_cam {
            let x = truth[0] - c as f64;
            idx.extend_from_slice(&[c as u32, p as u32]);
            px.extend_from_slice(&[(1000.0 * x / truth[2]) as f32, (1000.0 * truth[1] / truth[2]) as f32]);
        }
        // Every 10th point at 1 % of its depth along camera 0's ray; the rest close.
        let s = if p % 10 == 0 { 0.01 } else { 1.0 + 0.01 * rng.next() };
        pts.extend(truth.iter().map(|v| (v * s) as f32));
    }
    let mut fixed = vec![0u8; n_cam];
    fixed[0] = 1;
    fixed[1] = 1; // two fixed cameras hold the gauge, scale included
    let solver = [f32::NAN, f32::NAN, f32::NAN, f32::NAN, 1e-12, f32::NAN, f32::NAN, f32::NAN, 0.0];
    let out = bundle_adjust(&cams, &intr, &pts, &idx, &px, &[], &[], &[], &[], 100, &[], 0, &solver, &fixed, &[]);
    let base = n_cam * 12 + n_pts * 3 + n_cam * 8;
    let (before, after) = (out[base], out[base + 1]);
    assert!(after < 1e-2, "rms {before} → {after} px after {} iterations", out.len() - base - 4 - BA_STATS_LEN);
}

// A far point (its block's entries ~(f/z)² ≈ 1e-8) is as invertible as a near one:
// an absolute determinant floor refused it at every iteration's first try, so the
// damping never fell and the whole model crept. With the scale-free test LM reaches
// the exact solution in the iterations a model without the point needs.
#[test]
fn a_far_point_does_not_hold_back_the_damping() {
    let n_cam = 8;
    let run = |far: bool| {
        let mut rng = Lcg(11);
        let (mut cams, mut intr) = (Vec::new(), Vec::new());
        for c in 0..n_cam {
            cams.extend_from_slice(&[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, -(c as f32), 0.0, 0.0]);
            intr.extend_from_slice(&[1000.0, 1000.0, 0.0, 0.0]);
        }
        let (mut pts, mut idx, mut px) = (Vec::new(), Vec::new(), Vec::new());
        let mut truths: Vec<[f64; 3]> = (0..100).map(|_| [3.5 + 4.0 * rng.next(), 3.0 * rng.next(), 10.0 + 2.0 * rng.next()]).collect();
        if far { truths.push([2e5, 1e5, 1e7]); }
        for (p, truth) in truths.iter().enumerate() {
            for c in 0..n_cam {
                let x = truth[0] - c as f64;
                idx.extend_from_slice(&[c as u32, p as u32]);
                px.extend_from_slice(&[(1000.0 * x / truth[2]) as f32, (1000.0 * truth[1] / truth[2]) as f32]);
            }
            pts.extend(truth.iter().map(|v| (v * (1.0 + 0.01 * rng.next())) as f32));
        }
        let mut fixed = vec![0u8; n_cam];
        fixed[0] = 1;
        fixed[1] = 1;
        let solver = [f32::NAN, f32::NAN, f32::NAN, f32::NAN, 1e-12, f32::NAN, f32::NAN, f32::NAN, 0.0];
        let out = bundle_adjust(&cams, &intr, &pts, &idx, &px, &[], &[], &[], &[], 50, &[], 0, &solver, &fixed, &[]);
        let base = n_cam * 12 + truths.len() * 3 + n_cam * 8;
        (out[base + 1], out.len() - base - 4 - BA_STATS_LEN)
    };
    let ((near_rms, near_it), (far_rms, far_it)) = (run(false), run(true));
    assert!(near_rms < 1e-2 && far_rms < 1e-2, "rms {near_rms} / {far_rms} px");
    assert!(far_it <= near_it + 2, "{far_it} iterations with the far point, {near_it} without");
}

// A camera ring above DENSE_MAX_N (PCG only, no dense matrix ever built) still
// converges: 900 cameras, each point seen by 3–4 neighbours, noisy start.
#[test]
fn large_bundle_adjust_converges_without_a_dense_system() {
    let n_cam = 900;
    let mut rng = Lcg(9);
    let mut cams = Vec::new();
    let mut intr = Vec::new();
    for c in 0..n_cam {
        let x = c as f32 * 0.5;
        cams.extend_from_slice(&[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, -x, 0.0, 10.0]);
        intr.extend_from_slice(&[800.0, 800.0, 320.0, 240.0]);
    }
    let (mut pts, mut idx, mut px) = (Vec::new(), Vec::new(), Vec::new());
    let n_pts = n_cam * 6;
    for p in 0..n_pts {
        let c0 = p / 6;
        let (x, y, z) = (c0 as f64 * 0.5 + 0.2 * rng.next(), 2.0 * rng.next(), 1.0 * rng.next());
        for c in c0..(c0 + 3 + p % 2).min(n_cam) {
            let cx = c as f64 * 0.5;
            let (u, v) = (800.0 * (x - cx) / (z + 10.0) + 320.0, 800.0 * y / (z + 10.0) + 240.0);
            idx.extend_from_slice(&[c as u32, p as u32]);
            px.extend_from_slice(&[u as f32, v as f32]);
        }
        pts.extend_from_slice(&[(x + 0.02 * rng.next()) as f32, (y + 0.02 * rng.next()) as f32, (z + 0.02 * rng.next()) as f32]);
    }
    // The first camera's pose anchors the gauge loosely through a prior.
    let mut prior = vec![0f32; 31];
    prior[1] = 0.0; prior[2] = 0.0; prior[3] = -10.0; prior[4] = 1e4; prior[8] = 1e4; prior[12] = 1e4;
    let out = bundle_adjust(&cams, &intr, &pts, &idx, &px, &[], &[], &[], &prior, 10, &[], 0, &[], &[], &[]);
    let base = n_cam * 12 + n_pts * 3 + n_cam * 8;
    let (before, after) = (out[base], out[base + 1]);
    let n_red = out[base + 4] as usize;
    assert!(n_red > DENSE_MAX_N, "test must exercise the PCG-only path (n = {n_red})");
    assert_eq!(out[base + 6], 0.0, "no Cholesky solve above DENSE_MAX_N");
    assert!(after < 0.2 * before && after < 0.5, "rms {before} → {after}");
    // An all-zero fixed mask is the all-free solve, bit for bit.
    let zeros = vec![0u8; n_cam];
    assert_eq!(bundle_adjust(&cams, &intr, &pts, &idx, &px, &[], &[], &[], &prior, 10, &[], 0, &[], &zeros, &[]), out);
    // A local window: cameras outside 300..340 fixed. They keep their exact poses,
    // and the window still converges against them.
    let mut fixed = vec![1u8; n_cam];
    for c in 300..340 { fixed[c] = 0; }
    let loc = bundle_adjust(&cams, &intr, &pts, &idx, &px, &[], &[], &[], &[], 10, &[], 0, &[], &fixed, &[]);
    for c in [0usize, 299, 340, 899] { assert_eq!(&loc[c * 12..c * 12 + 12], &cams[c * 12..c * 12 + 12], "fixed camera {c} moved"); }
    assert_ne!(&loc[310 * 12..310 * 12 + 12], &cams[310 * 12..310 * 12 + 12], "a window camera should move");
    assert_eq!(loc[base + 4] as usize, 6 * 40, "the reduced system holds the window only");
    assert!(loc[base + 1] < loc[base], "window RMS {} → {}", loc[base], loc[base + 1]);
    // The IC(0) preconditioner (solver slot 5) converges too, with fewer CG iterations.
    let solver = [f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, 1.0];
    let ic = bundle_adjust(&cams, &intr, &pts, &idx, &px, &[], &[], &[], &prior, 10, &[], 0, &solver, &[], &[]);
    let after_ic = ic[base + 1];
    assert!(after_ic < 0.2 * before && after_ic < 0.5, "IC rms {before} → {after_ic}");
    assert!(ic[base + 11] < out[base + 11], "CG iterations: IC {} vs Jacobi {}", ic[base + 11], out[base + 11]);
    // The sparse direct solve (slot 6): converges, every solve direct, no CG at all.
    let direct = [f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, 1.0];
    let d = bundle_adjust(&cams, &intr, &pts, &idx, &px, &[], &[], &[], &prior, 10, &[], 0, &direct, &[], &[]);
    assert!(d[base + 1] < 0.2 * before && d[base + 1] < 0.5, "direct rms {before} → {}", d[base + 1]);
    assert_eq!(d[base + 6], d[base + 5], "every solve direct");
    assert_eq!(d[base + 11], 0.0, "no CG iterations");
}

#[test]
fn small_systems_stay_on_cholesky() {
    let (n, a, b, blocks) = ba_like(10, 3);
    assert!(n < PCG_MIN_N);
    let mut st = SolveStats::default();
    assert_eq!(solve_reduced(n, &a, &b, &blocks, &SolverOpts::DEFAULT, &mut st).unwrap(), chol_solve(n, &a, &b).unwrap());
    assert_eq!((st.solves, st.cholesky), (1, 1));
}
