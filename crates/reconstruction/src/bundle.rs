// Sparse bundle adjustment: Levenberg–Marquardt with the Schur complement
// (points eliminated against the cameras) and adaptive Huber robustification.
use wasm_bindgen::prelude::*;
use crate::linalg::*;
use crate::par::{for_each_index, map_indexed, SyncPtr, CHUNK};

// ── Dense linear algebra for bundle adjustment ────────────────────────────────

// inv3's singularity test: det / (m00·m11·m22) below this is a block too thin to invert
// in f64 (condition ~10¹⁴ and up).
const INV3_MIN_RATIO: f64 = 1e-14;
// chol_solve's: a pivot below this share of its diagonal entry is a matrix not
// positive-definite to f64 precision.
const CHOL_MIN_PIVOT_RATIO: f64 = 1e-14;

// Inverse of a symmetric positive-definite 3×3 matrix (a point's block) via cofactors;
// None if it is (near-)singular. The test is scale-free: det against the product of the
// diagonal, which bounds it for such a matrix (Hadamard), so the ratio is 1 for a
// diagonal block and ~1/condition for a thin one. An absolute det < 1e-20 had refused
// the block of every far point (its entries ~(f/z)², 1e-6 on BAL's Dubrovnik), and one
// such point failed every LM iteration's first try: the damping never fell, and the
// whole model crept (dubrovnik-173: +1.3 % of Ceres' cost after 100 iterations).
pub(crate) fn inv3(m: &M3) -> Option<M3> {
    let det = det3(m);
    let diag = m[0][0] * m[1][1] * m[2][2];
    if !(diag > 0.0) || !(det > INV3_MIN_RATIO * diag) { return None; }
    let id = 1.0 / det;
    Some([
        [(m[1][1]*m[2][2]-m[1][2]*m[2][1])*id, (m[0][2]*m[2][1]-m[0][1]*m[2][2])*id, (m[0][1]*m[1][2]-m[0][2]*m[1][1])*id],
        [(m[1][2]*m[2][0]-m[1][0]*m[2][2])*id, (m[0][0]*m[2][2]-m[0][2]*m[2][0])*id, (m[0][2]*m[1][0]-m[0][0]*m[1][2])*id],
        [(m[1][0]*m[2][1]-m[1][1]*m[2][0])*id, (m[0][1]*m[2][0]-m[0][0]*m[2][1])*id, (m[0][0]*m[1][1]-m[0][1]*m[1][0])*id],
    ])
}

// Solve a symmetric positive-definite dense system A·x = b (A row-major n×n) by
// Cholesky factorisation. None if A is not positive-definite — the LM caller then
// raises the damping and retries. Used only up to DENSE_MAX_N; larger reduced
// systems are solved by PCG over the block-sparse storage.
pub(crate) fn chol_solve(n: usize, a: &[f64], b: &[f64]) -> Option<Vec<f64>> {
    let mut l = vec![0f64; n * n];
    for j in 0..n {
        let mut d = a[j*n + j];
        for k in 0..j { d -= l[j*n + k] * l[j*n + k]; }
        // Scale-free, as inv3: a pivot against its own diagonal entry, not an absolute
        // floor that the small entries of a far scene fall under.
        if !(d > CHOL_MIN_PIVOT_RATIO * a[j*n + j]) { return None; }
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

// Reduced systems at least this large go to `pcg_solve` first. A dense Cholesky is
// n³/3 flops: ~10¹⁰ at 522 cameras (n ≈ 3,140), about 7 s per LM try in wasm, which
// made bundle adjustment 2,100 of 2,550 s on the 538-image Monster set. One CG
// iteration on the same dense matrix is n² flops.
pub(crate) const PCG_MIN_N: usize = 600;

// How the reduced system is solved. The caller can override every field through
// bundle_adjust's `solver_flat` = [pcg_min_n, rel_tol, max_iter, accept_partial]
// (a missing or NaN slot keeps the default below, so an empty slice is today's
// behaviour). This exists so a bench can compare policies on real blocks without a
// rebuild: quarry (347 cameras) ran slower with PCG than without it (692 vs 579 s),
// most likely because CG hit its iteration cap and then paid for Cholesky as well.
//   pcg_min_n       reduced size from which PCG is tried (∞ ⇒ always Cholesky)
//   rel_tol         CG stops at ‖r‖ ≤ rel_tol·‖b‖ (1e-10 is near-exact; an
//                   inexact-Newton LM, as Ceres' iterative Schur, uses ~1e-6…1e-1)
//   max_iter        CG iteration cap (capped at n)
//   accept_partial  at the cap, return the CG iterate instead of falling back to
//                   Cholesky. Safe for LM: every CG iterate from x₀ = 0 lowers the
//                   quadratic model, so it is a descent step, and LM still only
//                   accepts it if the true cost falls (else it raises damping, which
//                   also makes the next CG solve better conditioned).
//   precond         0 = block-Jacobi (one 6×6 block per camera), 1 = block incomplete
//                   Cholesky IC(0) on the sparse camera pattern (falls back to
//                   block-Jacobi when the factorisation breaks down). Opt-in while
//                   the bench decides (plan-parity PAR-2.1).
//   direct          1 = solve the reduced system by a sparse block Cholesky
//                   (sparse_chol.rs) wherever PCG would run, exactly instead of to a
//                   capped tolerance: on a large aerial block block-Jacobi PCG stalls
//                   at its cap (plan-sfm-scale ▸ S2). The ordering is computed once per
//                   call; a fill past SPARSE_MAX_BYTES keeps PCG.
//   function_tol    stop LM once an accepted step lowers the robust cost by less than
//                   this fraction of it (Ceres' function_tolerance). 0 ⇒ run until no
//                   step is accepted or `max_iters` — the original behaviour, which on
//                   a converged model spends every remaining iteration on a full
//                   Schur build for a negligible improvement.
//   warm            1 = the model is already converged (a re-solve after a filter or
//                   a retriangulation): with the direct solve, stop at
//                   WARM_FUNCTION_TOL instead of DIRECT_FUNCTION_TOL.
//   huber           the robust loss: absent / NaN ⇒ the adaptive Huber threshold (2.5 ×
//                   the median residual, ≥ 1 px); 0 ⇒ none, plain least squares (to
//                   compare with another solver on the same objective: the BAL bench,
//                   examples/bal.rs); > 0 ⇒ Huber at that fixed threshold (px).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SolverOpts {
    pub pcg_min_n: usize, pub rel_tol: f64, pub max_iter: usize, pub accept_partial: bool, pub function_tol: f64,
    pub precond: u8, pub direct: u8, pub warm: u8, pub huber: Option<f64>,
    // Slot 9: also report each lens group's standard deviations (lens_sigmas).
    pub covariance: bool,
}

impl SolverOpts {
    pub(crate) const DEFAULT: SolverOpts = SolverOpts { pcg_min_n: PCG_MIN_N, rel_tol: 1e-10, max_iter: 2000, accept_partial: false, function_tol: 0.0, precond: 0, direct: 0, warm: 0, huber: None, covariance: false };

    pub(crate) fn from_flat(f: &[f32]) -> SolverOpts {
        let d = SolverOpts::DEFAULT;
        let slot = |i: usize| f.get(i).map(|&v| v as f64).filter(|v| !v.is_nan() && *v >= 0.0);
        SolverOpts {
            // `as usize` saturates, so +∞ means "never".
            pcg_min_n: slot(0).map_or(d.pcg_min_n, |v| v as usize),
            rel_tol: slot(1).filter(|v| *v > 0.0).map_or(d.rel_tol, |v| v),
            max_iter: slot(2).filter(|v| *v >= 1.0).map_or(d.max_iter, |v| v as usize),
            accept_partial: slot(3).map_or(d.accept_partial, |v| v != 0.0),
            function_tol: slot(4).map_or(d.function_tol, |v| v),
            precond: slot(5).filter(|v| *v == 1.0).map_or(d.precond, |_| 1),
            direct: slot(6).map_or(d.direct, |v| if v == 1.0 { 1 } else { 0 }),
            warm: slot(7).map_or(d.warm, |v| if v == 1.0 { 1 } else { 0 }),
            huber: slot(8).or(d.huber),
            covariance: slot(9).map_or(d.covariance, |v| v == 1.0),
        }
    }
}

// What the reduced solves of one bundle_adjust call did, returned to the caller in a
// fixed block of the output (see BA_STATS_LEN) so a run can say where its time went.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct SolveStats {
    pub solves: u32,        // reduced solves attempted (one per LM try)
    pub cholesky: u32,      // solved directly (below pcg_min_n)
    pub pcg_converged: u32, // PCG reached rel_tol
    pub pcg_partial: u32,   // PCG hit the cap; its iterate was used (accept_partial)
    pub pcg_fallback: u32,  // PCG hit the cap; fell back to Cholesky
    pub pcg_npd: u32,       // PCG found the system not positive-definite
    pub pcg_iters: u64,     // CG iterations summed over all PCG attempts
    pub pcg_iters_max: u32, // most CG iterations in one attempt
}

// Output floats after [cost_before, cost_after, anchor_rms, prior_rms]:
// [n, solves, cholesky, pcg_converged, pcg_partial, pcg_fallback, pcg_npd,
//  pcg_iters, pcg_iters_max], then, when the solver's slot 9 asks for it, the lens
// groups' standard deviations ([groups, then LENS_SIGMA_LEN per group]), then the
// readout times (bundle_adjust_rs), then the per-iteration RMS trace.
pub(crate) const BA_STATS_LEN: usize = 9;
// Per lens group: σ of fx, cx, cy, k1, k2, k3, k4, p1, p2 (pixels for the first three);
// NaN for a term the call did not refine.
pub(crate) const LENS_SIGMA_LEN: usize = 9;

// Solve the reduced system: preconditioned CG when it is large, dense Cholesky
// otherwise or whenever CG does not converge (unless `accept_partial`), so the worst
// case is the old cost plus the wasted CG iterations. `blocks` are the diagonal
// (offset, size) blocks used as the preconditioner: one 6×6 per camera, one per
// intrinsics group. None ⇒ not positive-definite.
#[cfg(test)]
pub(crate) fn solve_reduced(n: usize, a: &[f64], b: &[f64], blocks: &[(usize, usize)],
                            opts: &SolverOpts, stats: &mut SolveStats) -> Option<Vec<f64>> {
    let diag = dense_diag_blocks(n, a, blocks);
    solve_reduced_with(n, |x, y| dense_matvec(n, a, x, y), &diag, None, || a.to_vec(), true, b, opts, stats)
}

// The largest reduced system that may be factorised densely. A dense copy plus its
// Cholesky factor are 16·n² bytes (256 MiB here, ~680 cameras); above it the solve is
// PCG only, and a capped CG iterate is used as the step (see `accept_partial`), since
// a 3,000-camera dense matrix alone (2.6 GB) would exhaust the 4 GiB wasm32 memory.
pub(crate) const DENSE_MAX_N: usize = 4096;

// The largest sparse Cholesky factor allowed (bytes of L); past it the solve stays PCG.
pub(crate) const SPARSE_MAX_BYTES: usize = 1 << 30;

// LM damping: its floor and cap, and how many tries one iteration may take to reach
// the cap (×4 each try, 31 from the floor). A step under PARAM_TOL of the model's size
// ends the run like a step rejected at the cap: past it nothing measurable changes
// (Ceres' parameter_tolerance).
const LAMBDA_MIN: f64 = 1e-9;
const LAMBDA_MAX: f64 = 1e8;
const LM_MAX_TRIES: usize = 32;
const PARAM_TOL: f64 = 1e-8;

// The LM stopping rule's floor when the direct solve runs (see bundle_adjust), and
// for a re-solve of an already converged model (`warm`).
pub(crate) const DIRECT_FUNCTION_TOL: f64 = 1e-5;
pub(crate) const WARM_FUNCTION_TOL: f64 = 1e-4;

// Phase timers for the native timing test (bundle_adjust_timing); no-ops in the app.
#[cfg(test)]
pub(crate) mod prof {
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;
    pub static T: [AtomicU64; 5] = [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)];
    thread_local! { static LAST: Cell<Option<Instant>> = const { Cell::new(None) }; }
    pub fn start() { LAST.with(|l| l.set(Some(Instant::now()))) }
    pub fn mark(i: usize) {
        LAST.with(|l| {
            let now = Instant::now();
            if let Some(t) = l.get() { T[i].fetch_add((now - t).as_micros() as u64, Ordering::Relaxed); }
            l.set(Some(now));
        })
    }
    pub fn take() -> [f64; 5] {
        let mut out = [0.0; 5];
        for (i, t) in T.iter().enumerate() { out[i] = t.swap(0, Ordering::Relaxed) as f64 / 1e6 }
        out
    }
}
#[cfg(not(test))]
pub(crate) mod prof {
    #[inline(always)] pub fn start() {}
    #[inline(always)] pub fn mark(_: usize) {}
}

// The dispatcher behind both storage forms: `matvec` and the diagonal blocks are the
// matrix as PCG sees it, `to_dense` builds the n×n copy only when Cholesky runs.
pub(crate) fn solve_reduced_with(n: usize, matvec: impl Fn(&[f64], &mut [f64]), diag: &[(usize, usize, Vec<f64>)],
                                 ic: Option<&BlockIc>, to_dense: impl FnOnce() -> Vec<f64>, dense_ok: bool, b: &[f64],
                                 opts: &SolverOpts, stats: &mut SolveStats) -> Option<Vec<f64>> {
    stats.solves += 1;
    if n >= opts.pcg_min_n || !dense_ok {
        let res = pcg_core_with(n, matvec, diag, ic, b, opts.rel_tol, n.min(opts.max_iter));
        let iters = res.iters();
        stats.pcg_iters += iters as u64;
        stats.pcg_iters_max = stats.pcg_iters_max.max(iters as u32);
        match res {
            PcgResult::Converged(x, _) => { stats.pcg_converged += 1; return Some(x); }
            PcgResult::NotPositiveDefinite(_) => { stats.pcg_npd += 1; return None; }
            PcgResult::Stalled(x, _) if opts.accept_partial || !dense_ok => { stats.pcg_partial += 1; return Some(x); }
            PcgResult::Stalled(..) => stats.pcg_fallback += 1, // fall back to the exact factorisation
        }
    } else {
        stats.cholesky += 1;
    }
    chol_solve(n, &to_dense(), b)
}

#[cfg(test)]
fn dense_matvec(n: usize, a: &[f64], x: &[f64], y: &mut [f64]) {
    for i in 0..n {
        let row = &a[i * n..(i + 1) * n];
        let mut s = 0.0;
        for j in 0..n { s += row[j] * x[j]; }
        y[i] = s;
    }
}

#[cfg(test)]
fn dense_diag_blocks(n: usize, a: &[f64], blocks: &[(usize, usize)]) -> Vec<(usize, usize, Vec<f64>)> {
    blocks.iter().map(|&(off, dim)| {
        let mut blk = vec![0f64; dim * dim];
        for i in 0..dim { for j in 0..dim { blk[i * dim + j] = a[(off + i) * n + off + j]; } }
        (off, dim, blk)
    }).collect()
}

// ── Block-sparse reduced camera system ───────────────────────────────────────
// One block per camera (6 rows) and per intrinsics group (kdim rows); a block (r, c)
// exists when the two share a point (or are a camera and its own group), so a camera
// row holds its co-visible cameras, not all of them. Storage is full (both
// triangles), each block row-major at `val_at`, columns ascending within a row: the
// matvec then visits a row's nonzeros in the same order as a dense row, and every
// entry receives the same additions in the same order as the dense assembly did, so
// small systems solve bit-identically to the former dense path.
pub(crate) struct BlockPattern {
    pub dims: Vec<usize>,
    pub offs: Vec<usize>,
    pub row_ptr: Vec<usize>,
    pub cols: Vec<u32>,
    pub val_at: Vec<usize>,
    pub diag_at: Vec<usize>,
    pub n_vals: usize,
    pub n: usize,
}

impl BlockPattern {
    // `rows[r]` lists the column blocks of row r (any order, may repeat; r itself is
    // added).
    pub(crate) fn new(dims: Vec<usize>, mut rows: impl FnMut(usize, &mut dyn FnMut(usize))) -> BlockPattern {
        let nb = dims.len();
        let mut offs = Vec::with_capacity(nb);
        let mut n = 0;
        for &d in &dims { offs.push(n); n += d; }
        let mut mark = vec![u32::MAX; nb];
        let mut row_ptr = Vec::with_capacity(nb + 1);
        row_ptr.push(0);
        let mut cols: Vec<u32> = Vec::new();
        let mut scratch: Vec<u32> = Vec::new();
        for r in 0..nb {
            scratch.clear();
            mark[r] = r as u32; scratch.push(r as u32);
            rows(r, &mut |c: usize| if mark[c] != r as u32 { mark[c] = r as u32; scratch.push(c as u32); });
            scratch.sort_unstable();
            cols.extend_from_slice(&scratch);
            row_ptr.push(cols.len());
        }
        let mut val_at = Vec::with_capacity(cols.len());
        let mut diag_at = vec![0usize; nb];
        let mut n_vals = 0;
        for r in 0..nb {
            for k in row_ptr[r]..row_ptr[r + 1] {
                let c = cols[k] as usize;
                if c == r { diag_at[r] = n_vals; }
                val_at.push(n_vals);
                n_vals += dims[r] * dims[c];
            }
        }
        BlockPattern { dims, offs, row_ptr, cols, val_at, diag_at, n_vals, n }
    }

    // Value offset of block (r, c); it must be in the pattern.
    pub(crate) fn at(&self, r: usize, c: usize) -> usize {
        let row = &self.cols[self.row_ptr[r]..self.row_ptr[r + 1]];
        let k = row.binary_search(&(c as u32)).expect("block outside the reduced-system pattern");
        self.val_at[self.row_ptr[r] + k]
    }

    pub(crate) fn matvec(&self, vals: &[f64], x: &[f64], y: &mut [f64]) {
        for r in 0..self.dims.len() {
            let (ro, rd) = (self.offs[r], self.dims[r]);
            for i in 0..rd {
                let mut s = 0.0;
                for k in self.row_ptr[r]..self.row_ptr[r + 1] {
                    let c = self.cols[k] as usize;
                    let (co, cd) = (self.offs[c], self.dims[c]);
                    let blk = &vals[self.val_at[k] + i * cd..self.val_at[k] + (i + 1) * cd];
                    for j in 0..cd { s += blk[j] * x[co + j]; }
                }
                y[ro + i] = s;
            }
        }
    }

    pub(crate) fn diag_blocks(&self, vals: &[f64]) -> Vec<(usize, usize, Vec<f64>)> {
        (0..self.dims.len()).map(|r| {
            let d = self.dims[r];
            (self.offs[r], d, vals[self.diag_at[r]..self.diag_at[r] + d * d].to_vec())
        }).collect()
    }

    pub(crate) fn to_dense(&self, vals: &[f64]) -> Vec<f64> {
        let n = self.n;
        let mut a = vec![0f64; n * n];
        for r in 0..self.dims.len() {
            let (ro, rd) = (self.offs[r], self.dims[r]);
            for k in self.row_ptr[r]..self.row_ptr[r + 1] {
                let c = self.cols[k] as usize;
                let (co, cd) = (self.offs[c], self.dims[c]);
                for i in 0..rd { for j in 0..cd { a[(ro + i) * n + co + j] = vals[self.val_at[k] + i * cd + j]; } }
            }
        }
        a
    }
}

// Each variant carries the CG iterations it ran; Stalled also carries the last iterate.
pub(crate) enum PcgResult { Converged(Vec<f64>, usize), NotPositiveDefinite(usize), Stalled(Vec<f64>, usize) }

impl PcgResult {
    fn iters(&self) -> usize {
        match self { PcgResult::Converged(_, k) | PcgResult::NotPositiveDefinite(k) | PcgResult::Stalled(_, k) => *k }
    }
}

// Conjugate gradients on a dense SPD system, block-Jacobi preconditioned. Converged
// when ‖r‖ ≤ rel_tol·‖b‖. A non-positive curvature pᵀAp ≤ 0 (or a non-PD diagonal
// block) means A is not positive-definite — the same signal chol_solve gives, which
// makes the LM caller raise its damping.
#[cfg(test)]
pub(crate) fn pcg_solve(n: usize, a: &[f64], b: &[f64], blocks: &[(usize, usize)], rel_tol: f64, max_iter: usize) -> PcgResult {
    pcg_core(n, |x, y| dense_matvec(n, a, x, y), &dense_diag_blocks(n, a, blocks), b, rel_tol, max_iter)
}

// The same CG over any storage: `matvec` computes y = A·x, `diag` holds the diagonal
// blocks (offset, size, row-major values) the preconditioner inverts.
#[cfg(test)]
pub(crate) fn pcg_core(n: usize, matvec: impl Fn(&[f64], &mut [f64]), diag: &[(usize, usize, Vec<f64>)],
                       b: &[f64], rel_tol: f64, max_iter: usize) -> PcgResult {
    pcg_core_with(n, matvec, diag, None, b, rel_tol, max_iter)
}

// `ic`, when given, replaces the block-Jacobi preconditioner built from `diag`.
pub(crate) fn pcg_core_with(n: usize, matvec: impl Fn(&[f64], &mut [f64]), diag: &[(usize, usize, Vec<f64>)],
                            ic: Option<&BlockIc>, b: &[f64], rel_tol: f64, max_iter: usize) -> PcgResult {
    // Preconditioner: the inverse of each diagonal block, via its own small Cholesky.
    let mut inv_blocks: Vec<(usize, usize, Vec<f64>)> = Vec::with_capacity(diag.len());
    for (off, dim, blk) in if ic.is_some() { &diag[..0] } else { diag } {
        let (off, dim) = (*off, *dim);
        let mut inv = vec![0f64; dim * dim];
        for c in 0..dim {
            let mut e = vec![0f64; dim]; e[c] = 1.0;
            match chol_solve(dim, blk, &e) {
                Some(col) => for r in 0..dim { inv[r * dim + c] = col[r]; },
                None => return PcgResult::NotPositiveDefinite(0),
            }
        }
        inv_blocks.push((off, dim, inv));
    }
    let apply_m = |r: &[f64], z: &mut [f64]| {
        if let Some(ic) = ic { return ic.apply(r, z); }
        z.copy_from_slice(r); // variables outside every block: identity
        for (off, dim, inv) in &inv_blocks {
            for i in 0..*dim {
                let mut s = 0.0;
                for j in 0..*dim { s += inv[i * dim + j] * r[off + j]; }
                z[off + i] = s;
            }
        }
    };
    let b_norm = b.iter().map(|v| v * v).sum::<f64>().sqrt();
    let mut x = vec![0f64; n];
    if b_norm == 0.0 { return PcgResult::Converged(x, 0); }
    let mut r = b.to_vec();
    let mut z = vec![0f64; n];
    apply_m(&r, &mut z);
    let mut p = z.clone();
    let mut rz: f64 = r.iter().zip(&z).map(|(u, v)| u * v).sum();
    let mut ap = vec![0f64; n];
    for k in 0..max_iter {
        matvec(&p, &mut ap);
        let pap: f64 = p.iter().zip(&ap).map(|(u, v)| u * v).sum();
        if !(pap > 0.0) { return PcgResult::NotPositiveDefinite(k + 1); }
        let alpha = rz / pap;
        for i in 0..n { x[i] += alpha * p[i]; r[i] -= alpha * ap[i]; }
        let r_norm = r.iter().map(|v| v * v).sum::<f64>().sqrt();
        if r_norm <= rel_tol * b_norm { return PcgResult::Converged(x, k + 1); }
        apply_m(&r, &mut z);
        let rz_new: f64 = r.iter().zip(&z).map(|(u, v)| u * v).sum();
        let beta = rz_new / rz;
        rz = rz_new;
        for i in 0..n { p[i] = z[i] + beta * p[i]; }
    }
    PcgResult::Stalled(x, max_iter)
}

// Block incomplete Cholesky IC(0) of a BlockPattern matrix: L has S's lower block
// pattern and L·Lᵀ = S on that pattern. A much stronger preconditioner than the
// diagonal blocks when cameras couple along a 2-D flight grid, where block-Jacobi's
// CG needs hundreds of iterations per solve. None when a pivot block is not positive
// definite (IC(0) can break down on an indefinite remainder); the caller then keeps
// block-Jacobi.
pub(crate) struct BlockIc<'a> { pat: &'a BlockPattern, l: Vec<f64> }

// In-place lower Cholesky of a d×d row-major block; false when not positive definite.
fn chol_block(d: usize, a: &mut [f64]) -> bool {
    for j in 0..d {
        let mut s = a[j * d + j];
        for k in 0..j { s -= a[j * d + k] * a[j * d + k]; }
        if !(s > 1e-300) { return false; }
        let ljj = s.sqrt();
        a[j * d + j] = ljj;
        for i in (j + 1)..d {
            let mut t = a[i * d + j];
            for k in 0..j { t -= a[i * d + k] * a[j * d + k]; }
            a[i * d + j] = t / ljj;
        }
        for i in 0..j { a[i * d + j] = 0.0; }
    }
    true
}

impl<'a> BlockIc<'a> {
    pub(crate) fn new(pat: &'a BlockPattern, vals: &[f64]) -> Option<BlockIc<'a>> {
        let nb = pat.dims.len();
        let mut l = vec![0f64; pat.n_vals];
        let mut tmp: Vec<f64> = Vec::new();
        for r in 0..nb {
            let dr = pat.dims[r];
            let (r0, r1) = (pat.row_ptr[r], pat.row_ptr[r + 1]);
            for kr in r0..r1 {
                let c = pat.cols[kr] as usize;
                if c > r { break; }
                let dc = pat.dims[c];
                // tmp = S_rc − Σ_k L_rk·L_ckᵀ over k < c present in both rows.
                tmp.clear();
                tmp.extend_from_slice(&vals[pat.val_at[kr]..pat.val_at[kr] + dr * dc]);
                let (mut i, mut j) = (r0, pat.row_ptr[c]);
                while i < kr && j < pat.row_ptr[c + 1] {
                    let (ki, kj) = (pat.cols[i], pat.cols[j]);
                    if kj as usize >= c { break; }
                    if ki < kj { i += 1; continue; }
                    if kj < ki { j += 1; continue; }
                    let dk = pat.dims[ki as usize];
                    let (lr, lc) = (pat.val_at[i], pat.val_at[j]);
                    for a in 0..dr { for b in 0..dc {
                        let mut s = 0.0;
                        for t in 0..dk { s += l[lr + a * dk + t] * l[lc + b * dk + t]; }
                        tmp[a * dc + b] -= s;
                    }}
                    i += 1; j += 1;
                }
                if c == r {
                    if !chol_block(dr, &mut tmp) { return None; }
                } else {
                    // L_rc = tmp · L_cc⁻ᵀ: each row x solves L_cc·xᵀ = rowᵀ (forward).
                    let lcc = pat.diag_at[c];
                    for a in 0..dr {
                        for b in 0..dc {
                            let mut v = tmp[a * dc + b];
                            for t in 0..b { v -= l[lcc + b * dc + t] * tmp[a * dc + t]; }
                            tmp[a * dc + b] = v / l[lcc + b * dc + b];
                        }
                    }
                }
                l[pat.val_at[kr]..pat.val_at[kr] + dr * dc].copy_from_slice(&tmp);
            }
        }
        Some(BlockIc { pat, l })
    }

    // z = (L·Lᵀ)⁻¹·r: forward then backward block substitution.
    pub(crate) fn apply(&self, r: &[f64], z: &mut [f64]) {
        let p = self.pat;
        let nb = p.dims.len();
        z.copy_from_slice(r);
        for row in 0..nb {
            let (o, d) = (p.offs[row], p.dims[row]);
            for k in p.row_ptr[row]..p.row_ptr[row + 1] {
                let c = p.cols[k] as usize;
                if c >= row { break; }
                let (co, cd, at) = (p.offs[c], p.dims[c], p.val_at[k]);
                for a in 0..d { let mut s = 0.0; for b in 0..cd { s += self.l[at + a * cd + b] * z[co + b]; } z[o + a] -= s; }
            }
            let at = p.diag_at[row];
            for a in 0..d { let mut v = z[o + a]; for t in 0..a { v -= self.l[at + a * d + t] * z[o + t]; } z[o + a] = v / self.l[at + a * d + a]; }
        }
        for row in (0..nb).rev() {
            let (o, d) = (p.offs[row], p.dims[row]);
            let at = p.diag_at[row];
            for a in (0..d).rev() { let mut v = z[o + a]; for t in (a + 1)..d { v -= self.l[at + t * d + a] * z[o + t]; } z[o + a] = v / self.l[at + a * d + a]; }
            for k in p.row_ptr[row]..p.row_ptr[row + 1] {
                let c = p.cols[k] as usize;
                if c >= row { break; }
                let (co, cd, at) = (p.offs[c], p.dims[c], p.val_at[k]);
                for b in 0..cd { let mut s = 0.0; for a in 0..d { s += self.l[at + a * cd + b] * z[o + a]; } z[co + b] -= s; }
            }
        }
    }
}

// Both lens families project the normalised camera coords (a, b) = (xc/zc, yc/zc)
// by one radial factor m: u = fx·a·m + cx, v = fy·b·m + cy.
//   Brown radial (no tangential): m = 1 + k1·r² + k2·r⁴ + k3·r⁶ — the pinhole frame
//     the pipeline undistorts into, plus any self-calibrated residual.
//   Kannala–Brandt fisheye: m = θd/r with θ = atan r, θd = θ·(1 + k1θ² + k2θ⁴ + k3θ⁶ + k4θ⁸)
//     — the pixels the lens recorded (OpenCV fisheye / COLMAP OPENCV_FISHEYE).
// All coeffs 0 and not fisheye ⇒ plain pinhole.
//
// `lens_factor` returns (m, q, dm/dk) with q = (dm/dr)/r, the quantity every
// Jacobian below needs (∂m/∂a = q·a, ∂m/∂b = q·b), and dm/dk the four coefficient
// partials (k4's is 0 for Brown).
fn lens_factor(r2: f64, k: &[f64; 4], fisheye: bool) -> (f64, f64, [f64; 4]) {
    if !fisheye {
        let r4 = r2 * r2;
        let m = 1.0 + k[0] * r2 + k[1] * r4 + k[2] * r4 * r2;
        // dm/dr = 2r·g with g = k1 + 2k2·r² + 3k3·r⁴, so q = 2g.
        let g = k[0] + 2.0 * k[1] * r2 + 3.0 * k[2] * r4;
        return (m, 2.0 * g, [r2, r4, r4 * r2, 0.0]);
    }
    // Below ~1e-8 the ray is on the axis: θd/r → 1, its slope and the k partials → 0.
    if r2 < 1e-16 { return (1.0, 0.0, [0.0; 4]); }
    let r = r2.sqrt();
    let th = r.atan();
    let t2 = th * th;
    let p = 1.0 + t2 * (k[0] + t2 * (k[1] + t2 * (k[2] + t2 * k[3])));
    let dp = 1.0 + t2 * (3.0 * k[0] + t2 * (5.0 * k[1] + t2 * (7.0 * k[2] + t2 * 9.0 * k[3]))); // dθd/dθ
    let m = th * p / r;
    // dm/dr = (dθd/dθ · dθ/dr − m) / r, with dθ/dr = 1/(1 + r²).
    let q = (dp / (1.0 + r2) - m) / r2;
    let t3 = th * t2;
    (m, q, [t3 / r, t3 * t2 / r, t3 * t2 * t2 / r, t3 * t2 * t2 * t2 / r])
}

// Brown's decentring (tangential) terms, OpenCV's convention, added to the radially
// scaled point (a·m, b·m): Δx = 2p1·ab + p2·(r² + 2a²), Δy = p1·(r² + 2b²) + 2p2·ab.
// A fisheye has none (p = 0). → (xd, yd), the distorted normalised point.
fn distort_norm(a: f64, b: f64, m: f64, p: &[f64; 2]) -> (f64, f64) {
    let r2 = a * a + b * b;
    (a * m + 2.0 * p[0] * a * b + p[1] * (r2 + 2.0 * a * a), b * m + p[0] * (r2 + 2.0 * b * b) + 2.0 * p[1] * a * b)
}

// The distorted normalised point of (a, b) and its derivatives, for the solver's
// Jacobians: `j` = ∂(xd, yd)/∂(a, b) as [[∂xd/∂a, ∂xd/∂b], [∂yd/∂a, ∂yd/∂b]], `dk` the
// radial factor's coefficient partials (∂xd/∂kj = a·dk[j], ∂yd/∂kj = b·dk[j]), `dp`
// ∂(xd, yd)/∂(p1, p2) as [[∂xd/∂p1, ∂xd/∂p2], [∂yd/∂p1, ∂yd/∂p2]], and m, the radial
// factor (∂xd/∂s needs xd itself). Radial part with ∂m/∂a = q·a, ∂m/∂b = q·b
// (lens_factor); the decentring terms add 2p1·b + 6p2·a to ∂xd/∂a, 2p1·a + 2p2·b to
// ∂xd/∂b and ∂yd/∂a, 6p1·b + 2p2·a to ∂yd/∂b.
pub(crate) struct DistJac { pub xd: f64, pub yd: f64, pub j: [[f64; 2]; 2], pub dk: [f64; 4], pub dp: [[f64; 2]; 2] }
pub(crate) fn distort_jac(a: f64, b: f64, k: &[f64; 4], p: &[f64; 2], fisheye: bool) -> DistJac {
    let r2 = a * a + b * b;
    let (m, q, dk) = lens_factor(r2, k, fisheye);
    let (xd, yd) = distort_norm(a, b, m, p);
    let cross = q * a * b + 2.0 * p[0] * a + 2.0 * p[1] * b;
    DistJac {
        xd, yd,
        j: [[m + q * a * a + 2.0 * p[0] * b + 6.0 * p[1] * a, cross],
            [cross, m + q * b * b + 6.0 * p[0] * b + 2.0 * p[1] * a]],
        dk,
        dp: [[2.0 * a * b, r2 + 2.0 * a * a], [r2 + 2.0 * b * b, 2.0 * a * b]],
    }
}

#[allow(clippy::too_many_arguments)]
fn project_full(r: &M3, t: &V3, fx: f64, fy: f64, cx: f64, cy: f64, k: &[f64; 4], p: &[f64; 2], fisheye: bool, x: &V3) -> (f64, f64) {
    let pc = mat3_vec(r, x);
    let (xc, yc, zc) = (pc[0] + t[0], pc[1] + t[1], pc[2] + t[2]);
    if zc.abs() < 1e-9 { return (f64::NAN, f64::NAN); }
    let a = xc / zc; let b = yc / zc;
    let (m, _, _) = lens_factor(a * a + b * b, k, fisheye);
    let (xd, yd) = distort_norm(a, b, m, p);
    (fx * xd + cx, fy * yd + cy)
}

// Principal rotation vector Log(R), with magnitude in [0, π]. Camera orientation
// priors use Log(R_current R_targetᵀ), so the residual is continuous around the
// target and avoids Euler-angle wraparound inside the optimiser.
pub(crate) fn so3_log(r: &M3) -> V3 {
    let cos_theta = ((r[0][0] + r[1][1] + r[2][2] - 1.0) * 0.5).clamp(-1.0, 1.0);
    let theta = cos_theta.acos();
    let vee = [r[2][1] - r[1][2], r[0][2] - r[2][0], r[1][0] - r[0][1]];
    if theta < 1e-8 { return [0.5*vee[0], 0.5*vee[1], 0.5*vee[2]]; }
    let sin_theta = theta.sin();
    if sin_theta.abs() > 1e-7 {
        let scale = theta / (2.0 * sin_theta);
        return [scale*vee[0], scale*vee[1], scale*vee[2]];
    }
    let mut axis = [
        ((r[0][0] + 1.0) * 0.5).max(0.0).sqrt(),
        ((r[1][1] + 1.0) * 0.5).max(0.0).sqrt(),
        ((r[2][2] + 1.0) * 0.5).max(0.0).sqrt(),
    ];
    if axis[0] >= axis[1] && axis[0] >= axis[2] && axis[0] > 1e-8 {
        axis[1] = (r[0][1] + r[1][0]) / (4.0 * axis[0]);
        axis[2] = (r[0][2] + r[2][0]) / (4.0 * axis[0]);
    } else if axis[1] >= axis[2] && axis[1] > 1e-8 {
        axis[0] = (r[0][1] + r[1][0]) / (4.0 * axis[1]);
        axis[2] = (r[1][2] + r[2][1]) / (4.0 * axis[1]);
    } else if axis[2] > 1e-8 {
        axis[0] = (r[0][2] + r[2][0]) / (4.0 * axis[2]);
        axis[1] = (r[1][2] + r[2][1]) / (4.0 * axis[2]);
    }
    let norm = (axis[0]*axis[0] + axis[1]*axis[1] + axis[2]*axis[2]).sqrt().max(1e-12);
    [theta*axis[0]/norm, theta*axis[1]/norm, theta*axis[2]/norm]
}

// ── Reduced-variable coupling blocks (Schur assembly) ─────────────────────────

// Largest reduced block: a camera's 6 rows, or an intrinsic group's
// [s, dcx, dcy, k1, k2, k3, k4, τ, ωx, ωy, ωz] (≤ 11; ω: bundle_adjust_rig).
const BLK_MAX: usize = 13;
// SolverOpts::huber 0: the Huber δ that makes the loss plain least squares.
const NO_LOSS_DELTA: f64 = 1e12;

// One point's merged Jvarᵀ·Jp coupling block, keyed by its reduced-variable offset
// (a camera's 6 rows, or an intrinsic group's 1–8 rows). Fixed BLK_MAX-row storage
// keeps assembly allocation-free; only `dim` rows are used.
// `blk` is the block's id in the reduced-system pattern (camera c, or n_cam + group).
struct EBlock { blk: usize, off: usize, dim: usize, rows: [[f64; 3]; BLK_MAX] }

// Accumulate a coupling block into a point's E-list, merging by block so that two
// cameras sharing an intrinsic group fold into that group's single block.
fn add_eblock(list: &mut Vec<EBlock>, blk: usize, off: usize, dim: usize, rows: &[[f64; 3]; BLK_MAX]) {
    if let Some(eb) = list.iter_mut().find(|e| e.blk == blk) {
        for a in 0..dim { for b in 0..3 { eb.rows[a][b] += rows[a][b]; } }
    } else {
        list.push(EBlock { blk, off, dim, rows: *rows });
    }
}

// How the lower-triangle Schur step (and the assembly) is split over threads, so that
// the result is the same bits whatever the thread count, in both builds. The free
// cameras are cut into `n` contiguous ranges, a number fixed by the camera count alone:
// one per RANGE_MIN_CAMS cameras, at most RANGE_MAX (the app's thread cap). About as many
// ranges as threads is fastest: fewer leave cores idle, more repeat the work of the points
// several ranges share. On BAL (20 threads) the step took 1.4 s at 15 ranges against
// 3.8 s at the former one range per 64 cameras (trafalgar-126, 1 range), 2.3 against
// 4.1 s (trafalgar-225, 3); at 40+ ranges ladybug-646 and -1340 slowed by a third.
// Range r owns the block rows of its cameras (and their right-hand side), and the
// group-row blocks (g, c) of its cameras c: each such element is written by one range,
// from that range's points in Schur order, the order the single loop added them in.
// The group × group blocks and the group right-hand side sum over every point: each
// point's share goes to its owner range (the range of its lowest camera); range 0 writes
// its share directly, the others into a partial that is added in range order after.
// Without intrinsics groups (no self-calibration), or with one range (under
// 2·RANGE_MIN_CAMS free cameras), every sum is the single loop's, bit for bit; with them, the group blocks are
// summed range by range, which rounds differently from one loop.
const RANGE_MIN_CAMS: usize = 8;
const RANGE_MAX: usize = 16;
struct RangePlan {
    n: usize,
    n_free: usize,
    // Points each range visits (those touching one of its cameras, or owned by it), in
    // Schur order, and the same in index order (the assembly's).
    points: Vec<Vec<u32>>,
    points_by_index: Vec<Vec<u32>>,
    owner: Vec<u32>,
    // Group × group blocks: (value offset in S, length), and each one's offset in a
    // range's partial; the group right-hand side follows them in the partial.
    gg: Vec<(usize, usize)>,
    gg_at: std::collections::HashMap<usize, usize>,
    gg_len: usize,
    group_rows: usize,
    group_off: usize,
}

impl RangePlan {
    fn new(pattern: &BlockPattern, n_free: usize, schur_order: &[usize],
           cams_of: impl Fn(usize, &mut dyn FnMut(usize))) -> RangePlan {
        let n = (n_free / RANGE_MIN_CAMS).clamp(1, RANGE_MAX);
        let range = |b: usize| if n_free == 0 { 0 } else { b * n / n_free };
        let n_pts = schur_order.iter().copied().max().map_or(0, |m| m + 1);
        let mut owner = vec![0u32; n_pts];
        let mut points: Vec<Vec<u32>> = vec![Vec::new(); n];
        let mut seen: Vec<usize> = Vec::new();
        for &p in schur_order {
            seen.clear();
            let mut lowest = usize::MAX;
            cams_of(p, &mut |b| { lowest = lowest.min(b); seen.push(range(b)); });
            let own = if lowest == usize::MAX { 0 } else { range(lowest) };
            owner[p] = own as u32;
            seen.push(own);
            seen.sort_unstable();
            seen.dedup();
            for &r in &seen { points[r].push(p as u32); }
        }
        let mut gg = Vec::new();
        let mut gg_at = std::collections::HashMap::new();
        let mut gg_len = 0;
        for r in n_free..pattern.dims.len() {
            for k in pattern.row_ptr[r]..pattern.row_ptr[r + 1] {
                let c = pattern.cols[k] as usize;
                if c < n_free || c > r { continue; }
                let len = pattern.dims[r] * pattern.dims[c];
                gg_at.insert(pattern.val_at[k], gg_len);
                gg.push((pattern.val_at[k], len));
                gg_len += len;
            }
        }
        let group_off = if n_free < pattern.dims.len() { pattern.offs[n_free] } else { pattern.n };
        let points_by_index = points.iter().map(|l| { let mut v = l.clone(); v.sort_unstable(); v }).collect();
        RangePlan { n, n_free, points, points_by_index, owner, gg, gg_at, gg_len, group_rows: pattern.n - group_off, group_off }
    }
    fn range(&self, b: usize) -> usize { if self.n_free == 0 { 0 } else { b * self.n / self.n_free } }
    fn part_len(&self) -> usize { self.gg_len + self.group_rows }
}

// Group item indices 0..len by key (< n_keys), keeping item order within a key:
// (start offsets, n_keys + 1 entries; the grouped item indices).
fn csr(n_keys: usize, keys: impl Iterator<Item = usize> + Clone) -> (Vec<u32>, Vec<u32>) {
    let mut start = vec![0u32; n_keys + 1];
    let mut len = 0usize;
    for k in keys.clone() { start[k + 1] += 1; len += 1; }
    for i in 0..n_keys { start[i + 1] += start[i]; }
    let mut fill = start.clone();
    let mut items = vec![0u32; len];
    for (i, k) in keys.enumerate() { items[fill[k] as usize] = i as u32; fill[k] += 1; }
    (start, items)
}

// Map each camera to an intrinsic-group slot. Cameras sharing a non-negative sensor
// id share a slot; unassigned cameras (id < 0, or a short/empty id list) each get
// their own slot. Returns the per-camera slot vector and the slot count.
fn build_groups(ids: &[i32], n_cam: usize) -> (Vec<usize>, usize) {
    use std::collections::HashMap;
    let mut map: HashMap<i32, usize> = HashMap::new();
    let mut grp = vec![0usize; n_cam];
    let mut next = 0usize;
    for c in 0..n_cam {
        let id = ids.get(c).copied().unwrap_or(-1);
        if id < 0 {
            grp[c] = next; next += 1;
        } else {
            grp[c] = *map.entry(id).or_insert_with(|| { let g = next; next += 1; g });
        }
    }
    (grp, next)
}

/// Bundle adjustment by sparse Levenberg–Marquardt with the Schur complement.
///
/// Jointly refines every camera pose (6-DOF: left-perturbed so(3) rotation +
/// translation) and every 3D point, and — when `refine_mode > 0` — a small set of
/// shared per-sensor intrinsic parameters (self-calibration). Points are always
/// eliminated by the Schur complement; the reduced system holds the camera poses
/// plus the intrinsic groups, stored block-sparse (a camera couples only with the
/// cameras it shares points with) and solved by block-Jacobi PCG when large, dense
/// Cholesky when small (`solve_reduced_with`, `DENSE_MAX_N`). Huber robustification (an
/// adaptive threshold tracking the residual median) keeps surviving gross
/// mis-triangulations from dragging the solution.
///
/// Intrinsic self-calibration is opt-in and modest: each sensor group carries a
/// focal **scale** `s` (init 1, multiplying every member camera's fx/fy) and,
/// for `refine_mode == 2`, shared principal-point offsets `dcx, dcy`. Modelling
/// the focal as a scale (not an absolute) preserves any per-camera differences in
/// the seed intrinsics while still sharing one degree of freedom across the group.
///
/// GCP support: `anchor_flat`/`anchor_weight` optionally pull specific 3D points
/// toward a known target position (e.g. a GCP triangulated in this same SfM
/// frame) with an extra quadratic residual `Σ_axis w_axis·(pt − target)²`. This only ever
/// touches that point's own 3×3 block (gradient + diagonal Hessian) — no camera
/// Jacobian, no new coupling — so it folds into the existing per-point Schur
/// elimination for free. Empty anchor arrays reduce to today's behaviour exactly.
/// Camera-pose support: `camera_prior_flat` optionally pulls camera centres
/// `C = -R^T t` and rotations toward known poses in this same SfM frame. Position
/// rows carry independent inverse-variance weights for X/Y/Z. Orientation uses
/// the tangent residual `Log(R R_target^T)` and a full 3×3 precision matrix,
/// allowing the caller to transform per-OPK uncertainties into solver axes.
///
/// # Inputs
/// - `cameras_flat`: n_cam × 12 floats `[R(9)|t(3), …]`
/// - `intrinsics_flat`: n_cam × 4 floats `[fx,fy,cx,cy, …]` (the seed / base K)
/// - `pts_flat`: n_pts × 3 floats `[x,y,z, …]`
/// - `obs_index`: n_obs × 2 u32 `[cam_i, pt_i, …]` and `obs_px`: n_obs × 2 floats
///   `[pixel_x, pixel_y, …]`. Indices are integers on purpose: as f32 they were exact
///   only to 2²⁴, so above 16.7 M points observations silently attached to the wrong
///   point (TODO ▸ SC-6).
/// - `anchor_flat`: n_anchor × 4 doubles `[pt_i, target_x, target_y, target_z, …]`
/// - `observation_weight`: n_obs × 2 inverse-variance pixel weights (X/Y);
///   feature observations use 1, GCP marks use their declared pixel variances
/// - `anchor_weight`: n_anchor × 9 floats, row-major 3×3 precision matrices
/// - `camera_prior_flat`: n_prior × 25 floats
///   `[cam_i, target_x, target_y, target_z, weight_x, weight_y, weight_z,
///     target_R(9), orientation_precision(9), …]`. An all-zero orientation
///   precision matrix makes the row position-only.
/// - `max_iters`: outer LM iterations
/// - `sensor_of_cam`: n_cam ints — per-camera sensor id (shared → shared focal);
///   `< 0` (or a short/empty list) ⇒ that camera is its own group
/// - `refine_mask`: **bitmask** of the shared per-sensor intrinsics to self-calibrate:
///   1 = focal scale s, 2 = principal point (dcx,dcy), 4 = radial k1, 8 = k2, 16 = k3,
///   32 = k4 (fisheye only). 0 ⇒ poses+points only. The per-group param vector is the
///   ordered subset `[s?, dcx?, dcy?, k1?, k2?, k3?, k4?, τ?]` (kdim ≤ 8; τ: bundle_adjust_rs). fy stays locked
///   to fx (single scale). A coefficient a group's lens does not have (k4 on a Brown
///   group, k3 on a two-term fisheye) is held at its seed.
/// - `fixed_cam`: n_cam bytes, non-zero ⇒ that camera's pose is held fixed (local BA:
///   the cameras outside the window keep their observations as constraints but are
///   not variables). Empty ⇒ every camera is free, the original behaviour exactly.
/// - `solver_flat`: solver policy `[pcg_min_n, rel_tol, max_iter, accept_partial,
///   function_tol, precond, direct, warm, huber]`; empty / NaN slots ⇒
///   `SolverOpts::DEFAULT` (see there).
/// - `fisheye_flat`: n_cam × 5 floats `[terms, k1, k2, k3, k4, …]`. `terms` 0 ⇒ the
///   camera is pinhole (+ the Brown self-cal residual) and its observations are in the
///   undistorted frame; its k1…k3 slots seed that residual (the app passes zeros; the
///   BAL bench, examples/bal.rs, the problems' own k1, k2); `terms` 1–4 ⇒ a Kannala–Brandt fisheye with those seed
///   coefficients, observed in the pixels the lens recorded, of which the first `terms`
///   may be self-calibrated (the k bits then refine the fisheye's own polynomial).
///   Cameras sharing a sensor group must share a lens. Empty ⇒ every camera pinhole,
///   the original behaviour exactly.
///
/// # Output
/// `[cameras_flat(n_cam×12), pts_flat(n_pts×3), intrinsics_flat(n_cam×8),
///   cost_before, cost_after, anchor_rms_after, camera_prior_rms_after,
///   solver stats (BA_STATS_LEN), cost_trace…]` — the returned
/// intrinsics are the **refined** effective K per camera as `[fx,fy,cx,cy,k1,k2,k3,k4]`
/// — for a pinhole camera the self-calibrated Brown residual (0 for the bits not set
/// in `refine_mask`, k4 always 0), for a fisheye camera its full refined Kannala–Brandt
/// coefficients (the seed when nothing was refined); cost_before/cost_after are RMS reprojection error in
/// pixels (anchors do not affect them); anchor_rms_after is the RMS anchor
/// residual in the caller's world units, and camera_prior_rms_after is the RMS
/// camera-centre residual (both 0 when their respective prior list is empty).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn bundle_adjust(
    cameras_flat: &[f32], intrinsics_flat: &[f32], pts_flat: &[f32], obs_index: &[u32], obs_px: &[f32],
    observation_weight: &[f32], anchor_flat: &[f64], anchor_weight: &[f32], camera_prior_flat: &[f32],
    max_iters: u32, sensor_of_cam: &[i32], refine_mask: u32, solver_flat: &[f32], fixed_cam: &[u8],
    fisheye_flat: &[f32],
) -> Vec<f32> {
    bundle_adjust_impl(cameras_flat, intrinsics_flat, pts_flat, obs_index, obs_px, observation_weight, anchor_flat,
        anchor_weight, camera_prior_flat, max_iters, sensor_of_cam, refine_mask, solver_flat, fixed_cam, fisheye_flat, &[],
        &[], &[])
}

/// `bundle_adjust` with a rolling-shutter model (rsh, plan-after-0.7 ▸ RSH). A camera
/// whose rows are read one after another over the readout time τ sees each row from
/// a slightly different place: from C + τ·s·v, where v is the camera centre's velocity
/// (model units per second) and s = (row − cy)/H the row's time from the principal row
/// as a fraction of the readout. The solver takes the observed row for s (exact to
/// first order) and applies the shift to the point instead: x_cam = R·(X − τ·s·v) + t,
/// so the pose and point Jacobians keep their form and τ adds one column, −s·R·v.
/// The pose is the one at the principal row (what the camera-centre priors constrain).
///
/// - `rs_flat`: n_cam × 5 floats `[vx, vy, vz, H, τ0, …]`; H ≤ 0 (or a short list) ⇒
///   that camera reads all rows at once. τ0 is the readout time in seconds; with refine
///   bit 64 the group's τ is refined from its first camera's τ0 (the slot follows k4).
///
/// Output: `bundle_adjust`'s, with n_cam floats — each camera's τ after the solve —
/// between the solver stats and the cost trace.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn bundle_adjust_rs(
    cameras_flat: &[f32], intrinsics_flat: &[f32], pts_flat: &[f32], obs_index: &[u32], obs_px: &[f32],
    observation_weight: &[f32], anchor_flat: &[f64], anchor_weight: &[f32], camera_prior_flat: &[f32],
    max_iters: u32, sensor_of_cam: &[i32], refine_mask: u32, solver_flat: &[f32], fixed_cam: &[u8],
    fisheye_flat: &[f32], rs_flat: &[f32],
) -> Vec<f32> {
    bundle_adjust_impl(cameras_flat, intrinsics_flat, pts_flat, obs_index, obs_px, observation_weight, anchor_flat,
        anchor_weight, camera_prior_flat, max_iters, sensor_of_cam, refine_mask, solver_flat, fixed_cam, fisheye_flat, rs_flat,
        &[], &[])
}

/// `bundle_adjust_rs` for the cameras of a rig (plan-after-0.7 ▸ MSP-1): a multispectral
/// camera's lenses, triggered together. The photos of one capture share one pose, the
/// capture's (its reference lens's), and each lens sees from a fixed offset to it:
/// x_cam = R_o·(R_c·X + t_c) + t_o, the offset the same for every capture. The solver
/// keeps one pose block per capture; with refine bit 128 each sensor group's offset
/// rotation is refined (three slots after τ, ω: R_o = Exp(ω)·R_o⁰), its lever arm t_o
/// kept (a few centimetres, too short to resolve from the photos). A group none of
/// whose cameras has an offset (the reference lens, or photos outside the rig) has no ω.
///
/// - `capture_of_cam`: n_cam ints; cameras with the same non-negative value share a pose
///   block, a negative value (or a short list) is a pose of its own.
/// - `offset_flat`: n_cam × 13 floats `[has, R_o(9), t_o(3), …]`; `has` 0 (or a short
///   list) ⇒ no offset: the camera's pose is its capture's.
///
/// A capture's pose starts from a camera without an offset where it has one, else from
/// its first camera with the offset taken off; it is held fixed only when every camera
/// in it is. A camera-centre prior acts on the capture's pose: give one per capture.
/// Output: `bundle_adjust_rs`'s, each camera's pose being its composed pose.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn bundle_adjust_rig(
    cameras_flat: &[f32], intrinsics_flat: &[f32], pts_flat: &[f32], obs_index: &[u32], obs_px: &[f32],
    observation_weight: &[f32], anchor_flat: &[f64], anchor_weight: &[f32], camera_prior_flat: &[f32],
    max_iters: u32, sensor_of_cam: &[i32], refine_mask: u32, solver_flat: &[f32], fixed_cam: &[u8],
    fisheye_flat: &[f32], rs_flat: &[f32], capture_of_cam: &[i32], offset_flat: &[f32],
) -> Vec<f32> {
    bundle_adjust_impl(cameras_flat, intrinsics_flat, pts_flat, obs_index, obs_px, observation_weight, anchor_flat,
        anchor_weight, camera_prior_flat, max_iters, sensor_of_cam, refine_mask, solver_flat, fixed_cam, fisheye_flat, rs_flat,
        capture_of_cam, offset_flat)
}

#[allow(clippy::too_many_arguments)]
fn bundle_adjust_impl(
    cameras_flat: &[f32],
    intrinsics_flat: &[f32],
    pts_flat: &[f32],
    obs_index: &[u32],
    obs_px: &[f32],
    observation_weight: &[f32],
    anchor_flat: &[f64],
    anchor_weight: &[f32],
    camera_prior_flat: &[f32],
    max_iters: u32,
    sensor_of_cam: &[i32],
    refine_mask: u32,
    solver_flat: &[f32],
    fixed_cam: &[u8],
    fisheye_flat: &[f32],
    rs_flat: &[f32],
    capture_of_cam: &[i32],
    offset_flat: &[f32],
) -> Vec<f32> {
    let n_cam = cameras_flat.len() / 12;
    let n_pts = pts_flat.len() / 3;
    let n_obs = (obs_index.len() / 2).min(obs_px.len() / 2);
    if n_cam == 0 || n_pts == 0 || n_obs == 0 { return vec![]; }

    // Rig (bundle_adjust_rig): each camera's pose block and lens offset. Without one,
    // block c is camera c and no offset is composed: the plain solve, bit for bit.
    let off: Vec<Option<(M3, V3)>> = (0..n_cam).map(|c| {
        let b = c * 13;
        if offset_flat.len() < b + 13 || !(offset_flat[b] > 0.5) { return None; }
        let v = |i: usize| offset_flat[b + i] as f64;
        let r: M3 = [[v(1), v(2), v(3)], [v(4), v(5), v(6)], [v(7), v(8), v(9)]];
        let t: V3 = [v(10), v(11), v(12)];
        if r.iter().flatten().chain(t.iter()).any(|x| !x.is_finite()) { return None; }
        Some((r, t))
    }).collect();
    let (pb, n_pb) = {
        let mut map: std::collections::HashMap<i32, usize> = std::collections::HashMap::new();
        let mut pb = vec![0usize; n_cam];
        let mut next = 0usize;
        for c in 0..n_cam {
            let id = capture_of_cam.get(c).copied().unwrap_or(-1);
            pb[c] = if id < 0 { next += 1; next - 1 } else { *map.entry(id).or_insert_with(|| { next += 1; next - 1 }) };
        }
        (pb, next)
    };

    // Anchors: (point_idx, target position, per-axis weights). Points outside range are
    // dropped rather than panicking on a malformed caller payload.
    let n_anchor = anchor_flat.len() / 4;
    let anchors: Vec<(usize, V3, M3)> = (0..n_anchor).filter_map(|i| {
        let b = i * 4;
        let pi = anchor_flat[b] as usize;
        let target: V3 = [anchor_flat[b+1], anchor_flat[b+2], anchor_flat[b+3]];
        let wb = i * 9;
        let precision: M3 = [0,1,2].map(|r| [0,1,2].map(|c| {
            anchor_weight.get(wb + 3*r + c).copied().unwrap_or(if r == c { 1.0 } else { 0.0 }) as f64
        }));
        if pi >= n_pts || precision.iter().flatten().any(|v| !v.is_finite()) { return None; }
        Some((pi, target, precision))
    }).collect();
    let mut anchored = vec![false; n_pts];
    for &(pi, _, _) in &anchors { anchored[pi] = true; }
    let anchor_sse = |pts: &Vec<V3>| -> f64 {
        let mut sum = 0.0f64;
        for &(pi, target, precision) in &anchors {
            let d = [pts[pi][0]-target[0], pts[pi][1]-target[1], pts[pi][2]-target[2]];
            let pd = mat3_vec(&precision, &d);
            sum += d[0]*pd[0] + d[1]*pd[1] + d[2]*pd[2];
        }
        sum
    };
    let anchor_rms = |pts: &Vec<V3>| -> f64 {
        if anchors.is_empty() { return 0.0; }
        let mut sse = 0.0f64;
        for &(pi, target, _) in &anchors {
            let dx = pts[pi][0] - target[0]; let dy = pts[pi][1] - target[1]; let dz = pts[pi][2] - target[2];
            sse += dx*dx + dy*dy + dz*dz;
        }
        (sse / anchors.len() as f64).sqrt()
    };

    // Camera-pose priors: camera index, target centre, position weights, and an
    // optional (target rotation, full orientation precision) pair.
    let n_camera_prior = camera_prior_flat.len() / 25;
    let camera_priors: Vec<(usize, V3, V3, Option<(M3, M3)>)> = (0..n_camera_prior).filter_map(|i| {
        let b = i * 25;
        let ci = camera_prior_flat[b] as usize;
        let target = [camera_prior_flat[b+1] as f64, camera_prior_flat[b+2] as f64,
                      camera_prior_flat[b+3] as f64];
        let weight = [camera_prior_flat[b+4] as f64, camera_prior_flat[b+5] as f64,
                      camera_prior_flat[b+6] as f64];
        if ci >= n_cam || target.iter().any(|v| !v.is_finite())
            || weight.iter().any(|v| !v.is_finite() || *v <= 0.0) { return None; }
        let target_r: M3 = [0,1,2].map(|row| [0,1,2].map(|col|
            camera_prior_flat[b + 7 + 3*row + col] as f64));
        let mut precision: M3 = [0,1,2].map(|row| [0,1,2].map(|col|
            camera_prior_flat[b + 16 + 3*row + col] as f64));
        for row in 0..3 { for col in (row+1)..3 {
            let v = 0.5 * (precision[row][col] + precision[col][row]);
            precision[row][col] = v; precision[col][row] = v;
        }}
        let det2 = precision[0][0]*precision[1][1] - precision[0][1]*precision[1][0];
        let orientation = if target_r.iter().flatten().all(|v| v.is_finite())
            && precision.iter().flatten().all(|v| v.is_finite())
            && precision[0][0] > 0.0 && det2 > 0.0 && det3(&precision) > 0.0 {
            Some((target_r, precision))
        } else { None };
        // On the camera's pose block: a capture's prior moves the capture.
        Some((pb[ci], target, weight, orientation))
    }).collect();

    // Unpack cameras / base intrinsics / points / observations.
    let cams_in: Vec<(M3, V3)> = (0..n_cam).map(|c| {
        let b = c * 12;
        let r: M3 = [[cameras_flat[b]   as f64, cameras_flat[b+1] as f64, cameras_flat[b+2]  as f64],
                     [cameras_flat[b+3] as f64, cameras_flat[b+4] as f64, cameras_flat[b+5]  as f64],
                     [cameras_flat[b+6] as f64, cameras_flat[b+7] as f64, cameras_flat[b+8]  as f64]];
        let t: V3 = [cameras_flat[b+9] as f64, cameras_flat[b+10] as f64, cameras_flat[b+11] as f64];
        (r, t)
    }).collect();
    // One pose per block: a capture starts from a camera without an offset where it has
    // one, else from its first camera with the offset taken off (R_c = R_oᵀ·R,
    // t_c = R_oᵀ·(t − t_o)).
    let mut cams: Vec<(M3, V3)> = vec![([[0.0; 3]; 3], [0.0; 3]); n_pb];
    { let mut seeded = vec![0u8; n_pb];
      for c in 0..n_cam {
          let rank = if off[c].is_none() { 2 } else { 1 };
          if seeded[pb[c]] >= rank { continue; }
          seeded[pb[c]] = rank;
          let (r, t) = cams_in[c];
          cams[pb[c]] = match off[c] {
              None => (r, t),
              Some((ro, to)) => {
                  let rot = mat3_transpose(&ro);
                  (mat3_mul(&rot, &r), mat3_vec(&rot, &[t[0] - to[0], t[1] - to[1], t[2] - to[2]]))
              }
          };
      } }
    // Base (seed) intrinsics — held fixed; refinement is expressed relative to these.
    let ks: Vec<(f64, f64, f64, f64)> = (0..n_cam).map(|c| {
        let b = c * 4;
        (intrinsics_flat[b] as f64, intrinsics_flat[b+1] as f64,
         intrinsics_flat[b+2] as f64, intrinsics_flat[b+3] as f64)
    }).collect();
    // Per-camera lens: (refinable fisheye terms, seed coefficients, Brown p1/p2). terms 0
    // ⇒ Brown (pinhole when every coefficient is 0). `fisheye_flat` has 5 floats a camera,
    // or 7 with the decentring pair (`lens_stride`); a 7-float list also returns p1/p2.
    let lens_stride = if n_cam > 0 && fisheye_flat.len() >= n_cam * 7 { 7 } else { 5 };
    let lens: Vec<(usize, [f64; 4], [f64; 2])> = (0..n_cam).map(|c| {
        let b = c * lens_stride;
        let val = |j: usize| -> f64 {
            let v = fisheye_flat.get(b + j).copied().unwrap_or(0.0) as f64;
            if v.is_finite() { v } else { 0.0 }
        };
        let terms = fisheye_flat.get(b).copied().unwrap_or(0.0);
        let k = [1, 2, 3, 4].map(val);
        let p = if lens_stride == 7 { [val(5), val(6)] } else { [0.0; 2] };
        // A Brown camera's slots seed its k1…k3 and p1/p2.
        if !(terms >= 1.0) { return (0, [k[0], k[1], k[2], 0.0], p); }
        ((terms as usize).min(4), k, [0.0; 2])
    }).collect();
    // Rolling shutter per camera: (velocity, frame height, seed readout time), or None.
    let rs: Vec<Option<(V3, f64, f64)>> = (0..n_cam).map(|c| {
        let b = c * 5;
        let h = rs_flat.get(b + 3).copied().unwrap_or(0.0) as f64;
        if !(h > 0.0) { return None; }
        let v = [0, 1, 2].map(|j| rs_flat.get(b + j).copied().unwrap_or(0.0) as f64);
        let tau0 = rs_flat.get(b + 4).copied().unwrap_or(0.0) as f64;
        if v.iter().any(|x| !x.is_finite()) || !tau0.is_finite() { return None; }
        Some((v, h, tau0))
    }).collect();
    let rs_any = rs.iter().any(|r| r.is_some());
    let mut pts: Vec<V3> = (0..n_pts).map(|i| {
        [pts_flat[i*3] as f64, pts_flat[i*3+1] as f64, pts_flat[i*3+2] as f64]
    }).collect();
    let obs: Vec<(usize, usize, f64, f64, f64, f64)> = (0..n_obs).map(|i| {
        let b = i * 2;
        let wb = i * 2;
        let wx = observation_weight.get(wb).copied().unwrap_or(1.0) as f64;
        let wy = observation_weight.get(wb+1).copied().unwrap_or(1.0) as f64;
        (obs_index[b] as usize, obs_index[b+1] as usize, obs_px[b] as f64, obs_px[b+1] as f64,
         if wx.is_finite() && wx > 0.0 { wx } else { 1.0 }, if wy.is_finite() && wy > 0.0 { wy } else { 1.0 })
    }).filter(|&(ci, pi, _, _, _, _)| ci < n_cam && pi < n_pts).collect();

    // Per-point observations as indices into `obs`, in `obs` order (CSR) — the
    // structure the Schur reduction iterates.
    let (pt_start, pt_obs) = csr(n_pts, obs.iter().map(|o| o.1));

    let camera_center = |cam: &(M3, V3)| -> V3 {
        let (r, t) = cam;
        [-(r[0][0]*t[0] + r[1][0]*t[1] + r[2][0]*t[2]),
         -(r[0][1]*t[0] + r[1][1]*t[1] + r[2][1]*t[2]),
         -(r[0][2]*t[0] + r[1][2]*t[1] + r[2][2]*t[2])]
    };
    let orientation_residual = |r: &M3, target_r: &M3| -> V3 {
        so3_log(&mat3_mul(r, &mat3_transpose(target_r)))
    };
    let camera_prior_sse = |cams: &Vec<(M3, V3)>| -> f64 {
        camera_priors.iter().map(|&(ci, target, weight, orientation)| {
            let c = camera_center(&cams[ci]);
            let position = (0..3).map(|k| weight[k] * (c[k] - target[k]).powi(2)).sum::<f64>();
            let rotation = orientation.map(|(target_r, precision)| {
                let e = orientation_residual(&cams[ci].0, &target_r);
                let pe = mat3_vec(&precision, &e);
                dot3(&e, &pe)
            }).unwrap_or(0.0);
            position + rotation
        }).sum()
    };
    let camera_prior_rms = |cams: &Vec<(M3, V3)>| -> f64 {
        if camera_priors.is_empty() { return 0.0; }
        let sse: f64 = camera_priors.iter().map(|&(ci, target, _, _)| {
            let c = camera_center(&cams[ci]);
            (0..3).map(|k| (c[k] - target[k]).powi(2)).sum::<f64>()
        }).sum();
        (sse / camera_priors.len() as f64).sqrt()
    };

    // ── Intrinsic self-calibration setup ─────────────────────────────────────────
    // `refine_mask` is a bitmask (1=f, 2=cxcy, 4=k1, 8=k2, 16=k3, 32=k4, 256=p1,p2). The
    // per-group param vector is the ordered subset [s?, dcx?, dcy?, k1?, k2?, k3?, k4?,
    // p1?, p2?, τ?, ω?]; `idx_*` is each param's slot in that vector (−1 when its bit is
    // clear). kdim ≤ BLK_MAX (64 = τ, bundle_adjust_rs; 128 = ω, bundle_adjust_rig).
    let has_f = refine_mask & 1 != 0;
    let has_cxcy = refine_mask & 2 != 0;
    let has_k1 = refine_mask & 4 != 0;
    let has_k2 = refine_mask & 8 != 0;
    let has_k3 = refine_mask & 16 != 0;
    let has_k4 = refine_mask & 32 != 0;
    let has_p = refine_mask & 256 != 0;
    let has_rs = refine_mask & 64 != 0 && rs_any;
    let has_rig = refine_mask & 128 != 0 && off.iter().any(|o| o.is_some());
    let mut kdim = 0usize;
    let mut alloc = |on: bool| -> isize { if on { let i = kdim as isize; kdim += 1; i } else { -1 } };
    let idx_s   = alloc(has_f);
    let idx_dcx = alloc(has_cxcy);
    let idx_dcy = alloc(has_cxcy);
    let idx_k1  = alloc(has_k1);
    let idx_k2  = alloc(has_k2);
    let idx_k3  = alloc(has_k3);
    let idx_k4  = alloc(has_k4);
    let idx_p1  = alloc(has_p);
    let idx_p2  = alloc(has_p);
    let idx_rs  = alloc(has_rs);
    // The offset rotation ω: three consecutive slots.
    let idx_rig = alloc(has_rig); alloc(has_rig); alloc(has_rig);
    let idx_k = [idx_k1, idx_k2, idx_k3, idx_k4];
    let (grp, g_count) = if kdim > 0 { build_groups(sensor_of_cam, n_cam) } else { (vec![0usize; n_cam], 0) };
    let refine = kdim > 0 && g_count > 0;
    // Each group's lens (its first camera's — a sensor group shares one), and which
    // of its k slots exist: k1–k3 for Brown, the first `terms` for a fisheye.
    let mut group_lens: Vec<(usize, [f64; 4], [f64; 2])> = vec![(0, [0.0; 4], [0.0; 2]); g_count];
    { let mut seen = vec![false; g_count];
      for c in 0..n_cam { if refine && !seen[grp[c]] { seen[grp[c]] = true; group_lens[grp[c]] = lens[c]; } } }
    // Each group's seed readout time (its first rolling-shutter camera's τ0).
    let mut group_tau0 = vec![0.0f64; g_count];
    { let mut seen = vec![false; g_count];
      for c in 0..n_cam { if refine && !seen[grp[c]] { if let Some((_, _, t0)) = rs[c] { seen[grp[c]] = true; group_tau0[grp[c]] = t0; } } } }
    // Which groups have a lens offset to refine (the others' ω slots are pinned).
    let mut group_has_off = vec![false; g_count];
    for c in 0..n_cam { if refine && off[c].is_some() { group_has_off[grp[c]] = true; } }
    let k_live = |g: usize, j: usize| -> bool {
        let terms = group_lens[g].0;
        if terms == 0 { j < 3 } else { j < terms }
    };
    // The decentring pair is Brown's: a fisheye group has none.
    let p_live = |g: usize| -> bool { group_lens[g].0 == 0 };
    // Reduced slot of each free camera (fixed ones have none); with no fixed camera the
    // slot is the camera index, so the system is exactly the all-free one.
    const FIXED: usize = usize::MAX;
    // (Slots and `free_cams` are per pose block; a block is fixed when all its cameras are.)
    let mut slot = vec![FIXED; n_pb];
    let mut free_cams: Vec<usize> = Vec::with_capacity(n_pb);
    let mut block_free = vec![false; n_pb];
    for c in 0..n_cam { if fixed_cam.get(c).copied().unwrap_or(0) == 0 { block_free[pb[c]] = true; } }
    for b in 0..n_pb {
        if block_free[b] { slot[b] = free_cams.len(); free_cams.push(b); }
    }
    let n_free = free_cams.len();
    let group_off = 6 * n_free;           // intrinsic params follow the camera poses
    let n = group_off + if refine { g_count * kdim } else { 0 };
    let n_groups = if refine { g_count } else { 0 };
    // The reduced system's sparsity: camera c couples with every camera that shares a
    // point with it, and with those cameras' intrinsics groups; a group with whatever
    // its cameras couple with. Built once, the observations do not change.
    let pattern = {
        let (cam_start, cam_obs) = csr(n_cam, obs.iter().map(|o| o.0));
        let (grp_start, grp_cams) = csr(n_groups, (0..if refine { n_cam } else { 0 }).map(|c| grp[c]));
        let (blk_start, blk_cams) = csr(n_pb, (0..n_cam).map(|c| pb[c]));
        let mut dims = vec![6usize; n_free];
        dims.extend(std::iter::repeat(kdim).take(n_groups));
        BlockPattern::new(dims, |r, touch| {
            let visit = |c: usize, touch: &mut dyn FnMut(usize)| {
                if n_groups > 0 { touch(n_free + grp[c]); }
                for k in cam_start[c]..cam_start[c + 1] {
                    let p = obs[cam_obs[k as usize] as usize].1;
                    for q in pt_start[p]..pt_start[p + 1] {
                        let c2 = obs[pt_obs[q as usize] as usize].0;
                        if slot[pb[c2]] != FIXED { touch(slot[pb[c2]]); }
                        if n_groups > 0 { touch(n_free + grp[c2]); }
                    }
                }
            };
            if r < n_free {
                let b = free_cams[r];
                for k in blk_start[b]..blk_start[b + 1] { visit(blk_cams[k as usize] as usize, &mut *touch); }
            }
            else { for k in grp_start[r - n_free]..grp_start[r - n_free + 1] { visit(grp_cams[k as usize] as usize, &mut *touch); } }
        })
    };
    let solver = SolverOpts::from_flat(solver_flat);
    let mut solve_stats = SolveStats::default();
    // The sparse direct solve's ordering, once for every LM iteration of this call.
    let direct = if solver.direct == 1 && (pattern.n >= solver.pcg_min_n || pattern.n > DENSE_MAX_N) {
        crate::sparse_chol::Symbolic::new(&pattern, SPARSE_MAX_BYTES / (8 * 36))
            .filter(|sym| sym.factor_bytes() <= SPARSE_MAX_BYTES)
    } else { None };
    // Exact steps keep finding improvements of a few 10⁻⁶ of the cost long after the
    // model has stopped changing (1,600 aerial cameras: all 30 iterations ran, RMS
    // 0.46 px from the 13th on); a 10⁻⁵ stop ends them with the same final model.
    // A re-solve of a converged model after a filter or a retriangulation (`warm`)
    // stops at 10⁻⁴: quarry the same RTK camera error, South Building the same
    // residuals. Not every solve: interim solves stopped that early hand the first
    // global BA a model it then needs 44 instead of 25 solves for (1,600 cameras).
    // Only where the direct solve runs: an inexact PCG step needs the tighter rule.
    let function_tol = match direct {
        Some(_) => solver.function_tol.max(if solver.warm != 0 { WARM_FUNCTION_TOL } else { DIRECT_FUNCTION_TOL }),
        None => solver.function_tol,
    };
    // The direct solve reads the lower triangle only (sparse_chol.rs `factor`).
    let lower_only = direct.is_some();
    // With it, the Schur elimination visits the points grouped by their first camera, so
    // consecutive points write nearby blocks of S (21 MB at 1,600 cameras: scattered
    // writes were the cost). The full-matrix paths keep the index order (and their bits).
    let schur_order: Vec<usize> = if lower_only {
        let mut key: Vec<(usize, usize)> = (0..n_pts).map(|p| {
            ((pt_start[p] as usize..pt_start[p + 1] as usize).map(|q| pb[obs[pt_obs[q] as usize].0]).min().unwrap_or(usize::MAX), p)
        }).collect();
        key.sort_unstable();
        key.into_iter().map(|(_, p)| p).collect()
    } else { (0..n_pts).collect() };
    // How the lower-triangle Schur step splits over threads (RangePlan). Only there:
    // the full-matrix paths keep their single loop.
    let range_plan = if lower_only { Some(RangePlan::new(&pattern, n_free, &schur_order, |p, visit: &mut dyn FnMut(usize)| {
        for q in pt_start[p] as usize..pt_start[p + 1] as usize {
            let sl = slot[pb[obs[pt_obs[q] as usize].0]];
            if sl != FIXED { visit(sl); }
        }
    })) } else { None };
    // Per-group params, one [f64;7] slot each. The focal-scale slot (if present) inits
    // to 1 (multiplies fx/fy); every distortion/principal-point slot inits to 0 — a
    // fisheye group's k slots are offsets from its seed coefficients.
    let mut gpar = vec![[0.0f64; BLK_MAX]; g_count.max(1)];
    if idx_s >= 0 { for g in gpar.iter_mut() { g[idx_s as usize] = 1.0; } }

    // Effective K + lens coefficients (k1..k4) and whether the camera is a fisheye,
    // under the current group params. Pinhole: the Brown residual; fisheye: seed + offset.
    struct Eff { fx: f64, fy: f64, cx: f64, cy: f64, k: [f64; 4], p: [f64; 2], fisheye: bool }
    let eff = |ci: usize, gpar: &Vec<[f64; BLK_MAX]>| -> Eff {
        let (fx0, fy0, cx0, cy0) = ks[ci];
        let (terms, k0, p0) = lens[ci];
        let fisheye = terms > 0;
        if !refine { return Eff { fx: fx0, fy: fy0, cx: cx0, cy: cy0, k: k0, p: p0, fisheye }; }
        let g = gpar[grp[ci]];
        let get = |idx: isize| -> f64 { if idx >= 0 { g[idx as usize] } else { 0.0 } };
        let s = if idx_s >= 0 { g[idx_s as usize] } else { 1.0 };
        let k = [0, 1, 2, 3].map(|j| k0[j] + get(idx_k[j]));
        let p = if fisheye { [0.0; 2] } else { [p0[0] + get(idx_p1), p0[1] + get(idx_p2)] };
        Eff { fx: s * fx0, fy: s * fy0, cx: cx0 + get(idx_dcx), cy: cy0 + get(idx_dcy), k, p, fisheye }
    };
    // A camera's readout time under the current group params (0 without rolling shutter).
    let tau_of = |ci: usize, gpar: &Vec<[f64; BLK_MAX]>| -> f64 {
        match rs[ci] {
            None => 0.0,
            Some((_, _, t0)) => if idx_rs >= 0 && refine { group_tau0[grp[ci]] + gpar[grp[ci]][idx_rs as usize] } else { t0 },
        }
    };
    // A camera's lens offset under the current group params, (Exp(ω)·R_o, t_o), or None.
    let offset_rot = |ci: usize, gpar: &Vec<[f64; BLK_MAX]>| -> Option<(M3, V3)> {
        let (ro, to) = off[ci]?;
        if idx_rig >= 0 && refine {
            let (p, i) = (gpar[grp[ci]], idx_rig as usize);
            Some((mat3_mul(&so3_exp(&[p[i], p[i + 1], p[i + 2]]), &ro), to))
        } else { Some((ro, to)) }
    };
    // A camera's pose: its capture's, composed with its offset when it has one.
    let pose_of = |ci: usize, cams: &Vec<(M3, V3)>, gpar: &Vec<[f64; BLK_MAX]>| -> (M3, V3) {
        let (r, t) = cams[pb[ci]];
        match offset_rot(ci, gpar) {
            None => (r, t),
            Some((ro, to)) => {
                let rt = mat3_vec(&ro, &t);
                (mat3_mul(&ro, &r), [rt[0] + to[0], rt[1] + to[1], rt[2] + to[2]])
            }
        }
    };
    // The point an observation sees: X − τ·s·v (rolling shutter), or X itself, and the
    // shift direction −s·v (for τ's Jacobian).
    let seen_point = |o: usize, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>| -> (V3, V3) {
        let (ci, pi, _, oy, _, _) = obs[o];
        match rs[ci] {
            None => (pts[pi], [0.0; 3]),
            Some((v, h, _)) => {
                let s = (oy - ks[ci].3) / h;
                let tau = tau_of(ci, gpar);
                let x = pts[pi];
                ([x[0] - tau * s * v[0], x[1] - tau * s * v[1], x[2] - tau * s * v[2]], [-s * v[0], -s * v[1], -s * v[2]])
            }
        }
    };

    // Plain RMS reprojection error over all observations (reported to the caller).
    // The per-observation loops below run on the pool (par.rs map_indexed) and are summed
    // here in observation order, so they give the plain loop's bits.
    // One observation's squared reprojection error, NaN when it projects nowhere.
    let sq_err = |o: usize, cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>| -> f64 {
        let (ci, pi, ox, oy, _, _) = obs[o];
        let pose = pose_of(ci, cams, gpar);
        let (r, t) = &pose;
        let e = eff(ci, gpar);
        let x = if rs_any { seen_point(o, pts, gpar).0 } else { pts[pi] };
        let (px, py) = project_full(r, t, e.fx, e.fy, e.cx, e.cy, &e.k, &e.p, e.fisheye, &x);
        if px.is_nan() { f64::NAN } else { (px - ox).powi(2) + (py - oy).powi(2) }
    };
    let rms = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>| -> f64 {
        let mut sse = 0.0f64; let mut cnt = 0usize;
        for v in map_indexed(obs.len(), |o| sq_err(o, cams, pts, gpar)) {
            if v.is_nan() { continue; }
            sse += v; cnt += 1;
        }
        if cnt == 0 { 0.0 } else { (sse / cnt as f64).sqrt() }
    };

    // Huber-robustified cost Σ ρ(‖r‖) at pixel threshold δ, plus the (unrobustified,
    // quadratic) GCP anchor term — same total objective the LM step below descends.
    let robust_cost = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>, dh: f64| -> f64 {
        let terms = map_indexed(obs.len(), |o| {
            let (ci, pi, ox, oy, wx, wy) = obs[o];
            let pose = pose_of(ci, cams, gpar);
            let (r, t) = &pose;
            let e = eff(ci, gpar);
            let x = if rs_any { seen_point(o, pts, gpar).0 } else { pts[pi] };
            let (px, py) = project_full(r, t, e.fx, e.fy, e.cx, e.cy, &e.k, &e.p, e.fisheye, &x);
            if px.is_nan() { return dh * dh; }
            let dx=px-ox; let dy=py-oy; let e=(dx*dx+dy*dy).sqrt();
            // The Huber loss the IRLS weight r = δ/e actually descends: ρ = q·(2r − r²)
            // (= 2δe − δ² for unit weights), continuous with q at e = δ. Evaluating
            // r·q (= δe) instead halved the outlier slope relative to the step model
            // and the anchor/prior terms, so step acceptance judged a different cost.
            let q = wx*dx*dx + wy*dy*dy;
            if e <= dh { q } else { let r = dh/e; q * (2.0*r - r*r) }
        });
        let mut sum = 0.0f64;
        for v in terms { sum += v; }
        sum + anchor_sse(pts) + camera_prior_sse(cams)
    };

    // Adaptive Huber threshold: a multiple of the residual median, so it tracks the
    // noise floor as the model tightens. Recomputed once per outer iteration.
    let huber_threshold = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>| -> f64 {
        let mut es: Vec<f64> = map_indexed(obs.len(), |o| sq_err(o, cams, pts, gpar).sqrt());
        es.retain(|v| !v.is_nan());
        if es.is_empty() { return 1.0; }
        // The median by selection: the same element a full sort puts there.
        let mid = es.len() / 2;
        let (_, m, _) = es.select_nth_unstable_by(mid, |a, b| a.partial_cmp(b).unwrap());
        (2.5 * *m).max(1.0)
    };
    // SolverOpts::huber: a fixed threshold, or none (a δ no residual reaches: an
    // observation on the camera plane still costs δ², finite).
    let huber_threshold = |cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>| -> f64 {
        match solver.huber {
            Some(d) if d > 0.0 => d,
            Some(_) => NO_LOSS_DELTA,
            None => huber_threshold(cams, pts, gpar),
        }
    };

    // One observation linearised at the given state: its residual, IRLS weights and
    // the camera (6), point (3) and intrinsics (kdim) Jacobian rows. None when the
    // point sits on the camera plane. The assembly and the Schur steps both call it
    // (identically), instead of keeping each point's coupling blocks between them —
    // those were 160 B per observation, the largest term at thousands of cameras.
    struct Jac { ci: usize, ru: f64, rv: f64, wu: f64, wv: f64, ju: [f64; 6], jv: [f64; 6], jpu: [f64; 3], jpv: [f64; 3], jku: [f64; BLK_MAX], jkv: [f64; BLK_MAX] }
    let jac = |o: usize, cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>, dh: f64| -> Option<Jac> {
        let (ci, pi, ox, oy, obs_wx, obs_wy) = obs[o];
        let (r, t) = &cams[pb[ci]];
        let Eff { fx, fy, cx, cy, k, p: tp, fisheye } = eff(ci, gpar);
        let (xs, sdir) = if rs_any { seen_point(o, pts, gpar) } else { (pts[pi], [0.0; 3]) };
        let pc = mat3_vec(r, &xs); // R·X (the rolling-shutter-shifted X)
        // A lens with an offset sees R_o·q + t_o of the capture-frame point q = R·X + t
        // (`rq` = R_o·q, for ω's Jacobian).
        let ro_o = offset_rot(ci, gpar);
        let (xc, yc, zc, rq) = match ro_o {
            None => (pc[0] + t[0], pc[1] + t[1], pc[2] + t[2], [0.0; 3]),
            Some((ro, to)) => {
                let rq = mat3_vec(&ro, &[pc[0] + t[0], pc[1] + t[1], pc[2] + t[2]]);
                (rq[0] + to[0], rq[1] + to[1], rq[2] + to[2], rq)
            }
        };
        if zc.abs() < 1e-9 { return None; }
        let inv = 1.0 / zc;
        // Normalised coords and the lens's radial factor m (lens_factor): m ≡ 1, and
        // every derivative reduces to the pinhole case, for a pinhole with all k = 0.
        let a = xc * inv; let b = yc * inv;
        let DistJac { xd, yd, j: [[xa, xb], [ya, yb]], dk, dp } = distort_jac(a, b, &k, &tp, fisheye);
        let ru = fx * xd + cx - ox;
        let rv = fy * yd + cy - oy;
        // ∂proj/∂x_cam (2×3), exact analytic: the distorted point's 2×2 Jacobian in (a, b)
        // (distort_jac) through ∂a/∂(xc,yc,zc) = (1, 0, −a)/zc, ∂b/… = (0, 1, −b)/zc.
        let dudc = [fx * inv * xa, fx * inv * xb, -fx * inv * (xa*a + xb*b)];
        let dvdc = [fy * inv * ya, fy * inv * yb, -fy * inv * (ya*a + yb*b)];
        // Through a lens offset ∂x_cam/∂q = R_o: the capture's and the point's Jacobians
        // see ∂proj/∂x_cam · R_o (the same rows when there is none).
        let vm = |v: &[f64; 3], m: &M3| -> [f64; 3] { [0, 1, 2].map(|k| v[0]*m[0][k] + v[1]*m[1][k] + v[2]*m[2][k]) };
        let (dqu, dqv) = match ro_o { None => (dudc, dvdc), Some((ro, _)) => (vm(&dudc, &ro), vm(&dvdc, &ro)) };
        // Camera Jacobian Jc (2×6): [I | −[pc]_×] through ∂proj/∂x_cam.
        let sp = skew(&pc);
        let mut ju = [0f64; 6]; let mut jv = [0f64; 6];
        for k in 0..3 { ju[k] = dqu[k]; jv[k] = dqv[k]; }
        for k in 0..3 {
            let colk = [-sp[0][k], -sp[1][k], -sp[2][k]];
            ju[3 + k] = dqu[0]*colk[0] + dqu[1]*colk[1] + dqu[2]*colk[2];
            jv[3 + k] = dqv[0]*colk[0] + dqv[1]*colk[1] + dqv[2]*colk[2];
        }
        // Point Jacobian Jp (2×3) = ∂proj/∂x_cam · R.
        let mut jpu = [0f64; 3]; let mut jpv = [0f64; 3];
        for k in 0..3 {
            jpu[k] = dqu[0]*r[0][k] + dqu[1]*r[1][k] + dqu[2]*r[2][k];
            jpv[k] = dqv[0]*r[0][k] + dqv[1]*r[1][k] + dqv[2]*r[2][k];
        }
        // Intrinsic Jacobian Jk (2×kdim), filled by slot (idx_* is the param's
        // position in [s?,dcx?,dcy?,k1?,k2?,k3?,k4?]). ∂/∂s = (fx0·a·m, fy0·b·m);
        // ∂/∂dcx = (1,0), ∂/∂dcy = (0,1); ∂/∂kj = (fx·a·∂m/∂kj, fy·b·∂m/∂kj) — r^{2j}
        // for Brown, θ^{2j+1}/r for a fisheye. A slot the group's lens lacks stays 0.
        let mut jku = [0f64; BLK_MAX]; let mut jkv = [0f64; BLK_MAX];
        if refine {
            let (fx0, fy0, _, _) = ks[ci];
            if idx_s   >= 0 { jku[idx_s   as usize] = fx0 * xd; jkv[idx_s   as usize] = fy0 * yd; }
            if idx_dcx >= 0 { jku[idx_dcx as usize] = 1.0; }
            if idx_dcy >= 0 { jkv[idx_dcy as usize] = 1.0; }
            for j in 0..4 {
                if idx_k[j] >= 0 && k_live(grp[ci], j) {
                    jku[idx_k[j] as usize] = fx * a * dk[j]; jkv[idx_k[j] as usize] = fy * b * dk[j];
                }
            }
            // ∂/∂p1 = (fx·2ab, fy·(r² + 2b²)), ∂/∂p2 = (fx·(r² + 2a²), fy·2ab): Brown only.
            if idx_p1 >= 0 && p_live(grp[ci]) {
                jku[idx_p1 as usize] = fx * dp[0][0]; jkv[idx_p1 as usize] = fy * dp[1][0];
                jku[idx_p2 as usize] = fx * dp[0][1]; jkv[idx_p2 as usize] = fy * dp[1][1];
            }
            // ∂/∂τ: the camera-frame point moves by R·(−s·v) per unit τ.
            if idx_rs >= 0 && rs[ci].is_some() {
                let rd = mat3_vec(r, &sdir);
                jku[idx_rs as usize] = dqu[0]*rd[0] + dqu[1]*rd[1] + dqu[2]*rd[2];
                jkv[idx_rs as usize] = dqv[0]*rd[0] + dqv[1]*rd[1] + dqv[2]*rd[2];
            }
            // ∂/∂ω (left perturbation of the offset rotation): −[R_o·q]_× through ∂proj/∂x_cam.
            if idx_rig >= 0 && ro_o.is_some() {
                let sq = skew(&rq);
                for k in 0..3 {
                    let colk = [-sq[0][k], -sq[1][k], -sq[2][k]];
                    jku[idx_rig as usize + k] = dudc[0]*colk[0] + dudc[1]*colk[1] + dudc[2]*colk[2];
                    jkv[idx_rig as usize + k] = dvdc[0]*colk[0] + dvdc[1]*colk[1] + dvdc[2]*colk[2];
                }
            }
        }
        // Huber IRLS weight.
        let e = (ru*ru + rv*rv).sqrt();
        let w = if e <= dh { 1.0 } else { dh / e };
        Some(Jac { ci, ru, rv, wu: w * obs_wx, wv: w * obs_wy, ju, jv, jpu, jpv, jku, jkv })
    };
    // A point's coupling blocks E (Jvarᵀ·Jp): camera then group, per observation.
    let eblocks = |pi: usize, cams: &Vec<(M3, V3)>, pts: &Vec<V3>, gpar: &Vec<[f64; BLK_MAX]>, dh: f64, list: &mut Vec<EBlock>| {
        list.clear();
        for q in pt_start[pi]..pt_start[pi + 1] {
            let Some(j) = jac(pt_obs[q as usize] as usize, cams, pts, gpar, dh) else { continue };
            let mut cblk = [[0f64; 3]; BLK_MAX];
            for a in 0..6 { for b in 0..3 { cblk[a][b] = j.wu*j.ju[a]*j.jpu[b] + j.wv*j.jv[a]*j.jpv[b]; } }
            let sj = slot[pb[j.ci]];
            if sj != FIXED { add_eblock(list, sj, 6 * sj, 6, &cblk); }
            if refine {
                let g = grp[j.ci];
                let mut kblk = [[0f64; 3]; BLK_MAX];
                for a in 0..kdim { for b in 0..3 { kblk[a][b] = j.wu*j.jku[a]*j.jpu[b] + j.wv*j.jkv[a]*j.jpv[b]; } }
                add_eblock(list, n_free + g, group_off + g * kdim, kdim, &kblk);
            }
        }
    };

    let cost_before = rms(&cams, &pts, &gpar);
    // For the lens σ (solver slot 9): once the solve has ended, one more pass assembles
    // the reduced matrix at the solution without damping (`cov_pass`), keeps it and stops.
    // The last accepted step's own matrix will not do: a converged solve rejects steps to
    // rounding, raising λ, and may then accept a last tiny one at a large λ.
    let want_cov = solver.covariance && refine;
    let mut cov_pass = false;
    let mut last_s: Option<Vec<f64>> = None;
    let mut lambda = 1e-3f64;              // LM damping
    let mut trace: Vec<f64> = Vec::new();  // RMS after each accepted iteration
    // The full-matrix paths (no RangePlan: the dense and PCG solves, below ~128 cameras)
    // split the assembly and the Schur step over points instead: `point_chunks`
    // contiguous chunks, each summing into its own share of S and the right-hand side,
    // the shares added in chunk order after. The count follows the problem's size (2,048
    // points a chunk, at most 16, the shares at most 128 MB together), never the thread
    // count, so both builds give the same bits. One loop had kept these blocks on one
    // thread in the threaded build too (Aukerman, 42 cameras: BA 13.6 of SfM's 20 s).
    let point_chunks = if range_plan.is_some() { 1 } else {
        let share = (pattern.n_vals + n) * 8;
        let mut c = n_pts.div_ceil(2048).clamp(1, 16);
        while c > 1 && c * share > 128 << 20 { c -= 1; }
        c
    };
    let chunk_range = |c: usize| (c * n_pts / point_chunks)..((c + 1) * n_pts / point_chunks);
    let mut share_s: Vec<Vec<f64>> = if range_plan.is_some() { Vec::new() } else { (0..point_chunks).map(|_| vec![0f64; pattern.n_vals]).collect() };
    let mut share_r: Vec<Vec<f64>> = if range_plan.is_some() { Vec::new() } else { (0..point_chunks).map(|_| vec![0f64; n]).collect() };

    for outer in 0.. {
        if outer >= max_iters && !cov_pass {
            if !want_cov { break; }
            cov_pass = true;
        }
        if cov_pass { lambda = 0.0; }
        prof::start();
        let dh = huber_threshold(&cams, &pts, &gpar);
        let mut cost = robust_cost(&cams, &pts, &gpar, dh);
        let cost_at_start = cost; // this iteration's robust cost, for the function-tolerance stop
        prof::mark(0);

        // ── Assemble undamped blocks ────────────────────────────────────────────
        // S is the reduced-variable Hessian (camera poses + intrinsic groups) in the
        // block-sparse `pattern`; gr its gradient; per-point C (3×3) and gp (3).
        let mut smat = vec![0f64; pattern.n_vals];
        let mut gr = vec![0f64; n];
        let mut cmat = vec![[[0f64; 3]; 3]; n_pts];
        let mut gpv = vec![[0f64; 3]; n_pts];

        // GCP anchors: gradient/Hessian of Σ_axis w_axis·(pt−target)² touches only that
        // point's own 3×3 block — no camera coupling, so it's just added here.
        for &(pi, target, precision) in &anchors {
            let d = [pts[pi][0]-target[0], pts[pi][1]-target[1], pts[pi][2]-target[2]];
            let pd = mat3_vec(&precision, &d);
            for a in 0..3 {
                gpv[pi][a] += pd[a];
                for b in 0..3 { cmat[pi][a][b] += precision[a][b]; }
            }
        }

        // Camera-centre priors contribute directly to the reduced camera blocks.
        // For C=-R^Tt and update (t+=dt, R=Exp(dw)R), J=[-R^T|-R^T[t]_x].
        for &(ci, target, weight, orientation) in &camera_priors {
            if slot[ci] == FIXED { continue; }
            let (r, t) = &cams[ci];
            let centre = camera_center(&cams[ci]);
            let st = skew(t);
            let mut j = [[0.0f64; 6]; 3];
            for row in 0..3 {
                for col in 0..3 {
                    j[row][col] = -r[col][row];
                    j[row][3 + col] = -(r[0][row]*st[0][col]
                        + r[1][row]*st[1][col] + r[2][row]*st[2][col]);
                }
            }
            let residual = [centre[0] - target[0], centre[1] - target[1], centre[2] - target[2]];
            let off = 6 * slot[ci];
            let dc = pattern.diag_at[slot[ci]];
            for a in 0..6 {
                for axis in 0..3 { gr[off+a] += weight[axis] * j[axis][a] * residual[axis]; }
                for b in 0..6 {
                    for axis in 0..3 {
                        smat[dc + a*6 + b] += weight[axis] * j[axis][a] * j[axis][b];
                    }
                }
            }

            // Orientation residual e=Log(R R_targetᵀ). A small central finite-
            // difference Jacobian is used for the three rotation variables. It
            // is exact for the actual left-multiplicative update convention and
            // avoids a fragile closed-form inverse-Jacobian near large rotations.
            if let Some((target_r, precision)) = orientation {
                let e = orientation_residual(r, &target_r);
                let eps = 1e-6;
                let mut j = [[0.0f64; 3]; 3];
                for col in 0..3 {
                    let mut dw_plus = [0.0; 3]; dw_plus[col] = eps;
                    let mut dw_minus = [0.0; 3]; dw_minus[col] = -eps;
                    let rp = mat3_mul(&so3_exp(&dw_plus), r);
                    let rm = mat3_mul(&so3_exp(&dw_minus), r);
                    let ep = orientation_residual(&rp, &target_r);
                    let em = orientation_residual(&rm, &target_r);
                    for row in 0..3 { j[row][col] = (ep[row] - em[row]) / (2.0*eps); }
                }
                let pe = mat3_vec(&precision, &e);
                for a in 0..3 {
                    let ia = off + 3 + a;
                    for row in 0..3 { gr[ia] += j[row][a] * pe[row]; }
                    for b in 0..3 {
                        for row in 0..3 { for col in 0..3 {
                            smat[dc + (3 + a)*6 + 3 + b] += j[row][a] * precision[row][col] * j[col][b];
                        }}
                    }
                }
            }
        }

        if let Some(rp) = range_plan.as_ref() {
            // Range by range as the Schur step below (RangePlan): a camera's blocks and
            // gradient by its range, a point's C and gp by its owner, the group diagonal
            // and gradient by the owner (range 0 directly, the others into a partial
            // added in range order); each range's points in index order, the loop's.
            let (sm_p, gr_p) = (SyncPtr::of(&mut smat), SyncPtr::of(&mut gr));
            let (cm_p, gp_p) = (SyncPtr::of(&mut cmat), SyncPtr::of(&mut gpv));
            let mut parts: Vec<Vec<f64>> = (0..rp.n).map(|r| if r == 0 || !refine { Vec::new() } else { vec![0f64; rp.part_len()] }).collect();
            let parts_p: Vec<SyncPtr<f64>> = parts.iter_mut().map(|v| SyncPtr::of(v)).collect();
            for_each_index(rp.n, |r| {
                let part = parts_p[r];
                for &pi in &rp.points_by_index[r] {
                    let pi = pi as usize;
                    let owner = rp.owner[pi] as usize == r;
                    for q in pt_start[pi]..pt_start[pi + 1] {
                        let o = pt_obs[q as usize] as usize;
                        let sc = slot[pb[obs[o].0]];
                        let free = sc != FIXED;
                        let mine = free && rp.range(sc) == r;
                        if !mine && !owner { continue; }
                        let Some(Jac { ru, rv, wu, wv, ju, jv, jpu, jpv, jku, jkv, ci }) = jac(o, &cams, &pts, &gpar, dh)
                            else { continue };
                        // SAFETY (all writes below): RangePlan gives each element one writing range.
                        if mine {
                            let (coff, dc) = (6 * sc, pattern.diag_at[sc]);
                            for a in 0..6 {
                                unsafe { *gr_p.at(coff + a) += wu*ju[a]*ru + wv*jv[a]*rv; }
                                for b in 0..6 { unsafe { *sm_p.at(dc + a*6 + b) += wu*ju[a]*ju[b] + wv*jv[a]*jv[b]; } }
                            }
                        }
                        if refine {
                            let g = grp[ci];
                            let goff = group_off + g * kdim;
                            let dg = pattern.diag_at[n_free + g];
                            let (gc, cg) = if mine { (pattern.at(n_free + g, sc), pattern.at(sc, n_free + g)) } else { (0, 0) };
                            for a in 0..kdim {
                                if owner {
                                    let gv = wu*jku[a]*ru + wv*jkv[a]*rv;
                                    if r == 0 { unsafe { *gr_p.at(goff + a) += gv; } }
                                    else { unsafe { *part.at(rp.gg_len + goff + a - rp.group_off) += gv; } }
                                    let at = if r == 0 { dg } else { rp.gg_at[&dg] };
                                    let dst = if r == 0 { sm_p } else { part };
                                    for b in 0..kdim { unsafe { *dst.at(at + a*kdim + b) += wu*jku[a]*jku[b] + wv*jkv[a]*jkv[b]; } }
                                }
                                // Cross term camera(coff) ↔ group(goff), both triangles.
                                if mine { for b in 0..6 {
                                    let v = wu*jku[a]*ju[b] + wv*jkv[a]*jv[b];
                                    unsafe { *sm_p.at(gc + a*6 + b) += v; *sm_p.at(cg + b*kdim + a) += v; }
                                } }
                            }
                        }
                        if owner {
                            let (gp, cm) = unsafe { (gp_p.at(pi), cm_p.at(pi)) };
                            for a in 0..3 {
                                gp[a] += wu*jpu[a]*ru + wv*jpv[a]*rv;
                                for b in 0..3 { cm[a][b] += wu*jpu[a]*jpu[b] + wv*jpv[a]*jpv[b]; }
                            }
                        }
                    }
                }
            });
            if refine {
                for part in parts.iter().skip(1) {
                    for &(base, len) in &rp.gg {
                        let o = rp.gg_at[&base];
                        for i in 0..len { smat[base + i] += part[o + i]; }
                    }
                    for i in 0..rp.group_rows { gr[rp.group_off + i] += part[rp.gg_len + i]; }
                }
            }
        } else {
            // Point chunks (`point_chunks`): a chunk's camera and group terms go to its own
            // shares, its points' C and gp straight to them (a point is in one chunk).
            for v in share_s.iter_mut() { v.fill(0.0); }
            for v in share_r.iter_mut() { v.fill(0.0); }
            let sm_ps: Vec<SyncPtr<f64>> = share_s.iter_mut().map(|v| SyncPtr::of(v)).collect();
            let gr_ps: Vec<SyncPtr<f64>> = share_r.iter_mut().map(|v| SyncPtr::of(v)).collect();
            let (cm_p, gp_p) = (SyncPtr::of(&mut cmat), SyncPtr::of(&mut gpv));
            for_each_index(point_chunks, |c| {
                let (sm_p, gr_p) = (sm_ps[c], gr_ps[c]);
                for pi in chunk_range(c) {
                    // SAFETY (all writes below): chunk c alone writes its shares and its points.
                    let (gp, cm) = unsafe { (gp_p.at(pi), cm_p.at(pi)) };
                    for q in pt_start[pi]..pt_start[pi + 1] {
                        let Some(Jac { ci, ru, rv, wu, wv, ju, jv, jpu, jpv, jku, jkv }) = jac(pt_obs[q as usize] as usize, &cams, &pts, &gpar, dh)
                            else { continue };
                        let sc = slot[pb[ci]];
                        let free = sc != FIXED;
                        let coff = if free { 6 * sc } else { 0 };
                        if free {
                            let dc = pattern.diag_at[sc];
                            for a in 0..6 {
                                unsafe { *gr_p.at(coff + a) += wu*ju[a]*ru + wv*jv[a]*rv; }
                                for b in 0..6 { unsafe { *sm_p.at(dc + a*6 + b) += wu*ju[a]*ju[b] + wv*jv[a]*jv[b]; } }
                            }
                        }
                        if refine {
                            let g = grp[ci];
                            let goff = group_off + g * kdim;
                            let dg = pattern.diag_at[n_free + g];
                            let (gc, cg) = if free { (pattern.at(n_free + g, sc), pattern.at(sc, n_free + g)) } else { (0, 0) };
                            for a in 0..kdim {
                                unsafe { *gr_p.at(goff + a) += wu*jku[a]*ru + wv*jkv[a]*rv; }
                                for b in 0..kdim { unsafe { *sm_p.at(dg + a*kdim + b) += wu*jku[a]*jku[b] + wv*jkv[a]*jkv[b]; } }
                                // Cross term camera(coff) ↔ group(goff), both triangles.
                                if free { for b in 0..6 {
                                    let v = wu*jku[a]*ju[b] + wv*jkv[a]*jv[b];
                                    unsafe { *sm_p.at(gc + a*6 + b) += v; *sm_p.at(cg + b*kdim + a) += v; }
                                } }
                            }
                        }
                        for a in 0..3 {
                            gp[a] += wu*jpu[a]*ru + wv*jpv[a]*rv;
                            for b in 0..3 { cm[a][b] += wu*jpu[a]*jpu[b] + wv*jpv[a]*jpv[b]; }
                        }
                    }
                }
            });
            for c in 0..point_chunks {
                for (x, v) in smat.iter_mut().zip(&share_s[c]) { *x += v; }
                for (x, v) in gr.iter_mut().zip(&share_r[c]) { *x += v; }
            }
        }

        // A k slot the group's lens does not have has no Jacobian: pin it (unit
        // diagonal, zero gradient) so its offset solves to exactly 0 instead of
        // resting on the 1e-12 damping floor.
        if refine {
            for g in 0..g_count {
                let dg = pattern.diag_at[n_free + g];
                for j in 0..4 {
                    if idx_k[j] >= 0 && !k_live(g, j) { let a = idx_k[j] as usize; smat[dg + a*kdim + a] += 1.0; }
                }
                if idx_p1 >= 0 && !p_live(g) {
                    for a in [idx_p1 as usize, idx_p2 as usize] { smat[dg + a*kdim + a] += 1.0; }
                }
                // Likewise ω for a group with no lens offset (the rig's reference lens).
                if idx_rig >= 0 && !group_has_off[g] {
                    for k in 0..3 { let a = idx_rig as usize + k; smat[dg + a*kdim + a] += 1.0; }
                }
            }
        }

        prof::mark(1);
        // ── LM step with damping retries ────────────────────────────────────────
        // A rejected step raises the damping ×4 and tries again, up to its cap: only a
        // step rejected at the cap (one barely off the gradient, ×10⁻⁸ of it) ends the run.
        // Giving up after a fixed 8 tries left a model with a bad start where its first
        // iteration took it (×28 Ceres' cost on the largest BAL Ladybug problems), since
        // 8 tries raise λ only from its working level to ~20 (docs/METHODS.md ▸ BA vs Ceres).
        let mut accepted = false;
        for _try in 0..LM_MAX_TRIES {
            // Damp the reduced diagonal, then Schur-eliminate the (λ-damped) points:
            // S ← (S+λ) − Σ_p E·(C+λ)⁻¹·Eᵀ,  rhs ← −gr + Σ_p E·(C+λ)⁻¹·gp.
            let mut s = smat.clone();
            let mut rhs = vec![0f64; n];
            for i in 0..n { rhs[i] = -gr[i]; }
            for b in 0..pattern.dims.len() {
                let (d, base) = (pattern.dims[b], pattern.diag_at[b]);
                for i in 0..d { s[base + i*d + i] = s[base + i*d + i] * (1.0 + lambda) + 1e-12; }
            }

            let mut cinv_store: Vec<Option<M3>> = vec![None; n_pts];
            let mut tmp_store: Vec<V3> = vec![[0.0; 3]; n_pts];
            let ok;
            if let Some(rp) = range_plan.as_ref() {
                // Range by range, on the thread pool when there is one (RangePlan: every
                // element has one writer, and gets its terms in Schur order).
                let failed = std::sync::atomic::AtomicBool::new(false);
                let (s_p, rhs_p) = (SyncPtr::of(&mut s), SyncPtr::of(&mut rhs));
                let (ci_p, tmp_p) = (SyncPtr::of(&mut cinv_store), SyncPtr::of(&mut tmp_store));
                let mut parts: Vec<Vec<f64>> = (0..rp.n).map(|r| if r == 0 { Vec::new() } else { vec![0f64; rp.part_len()] }).collect();
                let parts_p: Vec<SyncPtr<f64>> = parts.iter_mut().map(|v| SyncPtr::of(v)).collect();
                for_each_index(rp.n, |r| {
                    let part = parts_p[r];
                    let mut el: Vec<EBlock> = Vec::new();
                    let mut ms: Vec<[[f64; 3]; BLK_MAX]> = Vec::new();
                    for &pi in &rp.points[r] {
                        if failed.load(std::sync::atomic::Ordering::Relaxed) { return; }
                        let pi = pi as usize;
                        eblocks(pi, &cams, &pts, &gpar, dh, &mut el);
                        if el.is_empty() && !anchored[pi] { continue; }
                        let mut cp = cmat[pi];
                        for i in 0..3 { cp[i][i] = cp[i][i] * (1.0 + lambda) + 1e-12; }
                        let cinv = match inv3(&cp) { Some(m) => m, None => { failed.store(true, std::sync::atomic::Ordering::Relaxed); return; } };
                        let tmp = mat3_vec(&cinv, &gpv[pi]); // C⁻¹·gp
                        let owner = rp.owner[pi] as usize == r;
                        // SAFETY (all writes below): RangePlan gives each element one writing range.
                        if owner { unsafe { *ci_p.at(pi) = Some(cinv); *tmp_p.at(pi) = tmp; } }
                        for eb in &el {
                            let camera = eb.blk < rp.n_free;
                            if !(if camera { rp.range(eb.blk) == r } else { owner }) { continue; }
                            for a in 0..eb.dim {
                                let v = eb.rows[a][0]*tmp[0] + eb.rows[a][1]*tmp[1] + eb.rows[a][2]*tmp[2];
                                if camera || r == 0 { unsafe { *rhs_p.at(eb.off + a) += v; } }
                                else { unsafe { *part.at(rp.gg_len + eb.off + a - rp.group_off) += v; } }
                            }
                        }
                        ms.clear();
                        ms.extend(el.iter().map(|eb| {
                            let mut m = [[0f64; 3]; BLK_MAX];
                            for a in 0..eb.dim {
                                for k in 0..3 {
                                    m[a][k] = eb.rows[a][0]*cinv[0][k] + eb.rows[a][1]*cinv[1][k] + eb.rows[a][2]*cinv[2][k];
                                }
                            }
                            m
                        }));
                        for (i1, eb1) in el.iter().enumerate() {
                            let m = &ms[i1];
                            for eb2 in &el {
                                if eb2.blk > eb1.blk { continue; }
                                // Row eb1's owner for a camera row; the column camera's owner
                                // for a group row; the point's owner for group × group.
                                let (mine, direct) = if eb1.blk < rp.n_free { (rp.range(eb1.blk) == r, true) }
                                    else if eb2.blk < rp.n_free { (rp.range(eb2.blk) == r, true) }
                                    else { (owner, r == 0) };
                                if !mine { continue; }
                                let base = pattern.at(eb1.blk, eb2.blk);
                                let at = if direct { base } else { rp.gg_at[&base] };
                                let dst = if direct { s_p } else { part };
                                for a in 0..eb1.dim {
                                    for b in 0..eb2.dim {
                                        let v = m[a][0]*eb2.rows[b][0] + m[a][1]*eb2.rows[b][1] + m[a][2]*eb2.rows[b][2];
                                        if direct { unsafe { *dst.at(at + a*eb2.dim + b) -= v; } }
                                        else { unsafe { *dst.at(at + a*eb2.dim + b) += v; } }
                                    }
                                }
                            }
                        }
                    }
                });
                ok = !failed.load(std::sync::atomic::Ordering::Relaxed);
                // The other ranges' group shares, in range order.
                for part in parts.iter().skip(1) {
                    for &(base, len) in &rp.gg {
                        let o = rp.gg_at[&base];
                        for i in 0..len { s[base + i] -= part[o + i]; }
                    }
                    for i in 0..rp.group_rows { rhs[rp.group_off + i] += part[rp.gg_len + i]; }
                }
            } else {
                // Point chunks (`point_chunks`; schur_order is the index order here): each
                // chunk subtracts into its own shares of S and adds into its share of the
                // right-hand side, added in chunk order after.
                for v in share_s.iter_mut() { v.fill(0.0); }
                for v in share_r.iter_mut() { v.fill(0.0); }
                let failed = std::sync::atomic::AtomicBool::new(false);
                let s_ps: Vec<SyncPtr<f64>> = share_s.iter_mut().map(|v| SyncPtr::of(v)).collect();
                let r_ps: Vec<SyncPtr<f64>> = share_r.iter_mut().map(|v| SyncPtr::of(v)).collect();
                let (ci_p, tmp_p) = (SyncPtr::of(&mut cinv_store), SyncPtr::of(&mut tmp_store));
                for_each_index(point_chunks, |c| {
                    let (s_p, r_p) = (s_ps[c], r_ps[c]);
                    let mut el: Vec<EBlock> = Vec::new();
                    let mut ms: Vec<[[f64; 3]; BLK_MAX]> = Vec::new();
                    for pi in chunk_range(c) {
                        if failed.load(std::sync::atomic::Ordering::Relaxed) { return; }
                        eblocks(pi, &cams, &pts, &gpar, dh, &mut el);
                        // An anchored point with no camera coupling (edge case: every
                        // observing camera failed cheirality) still needs its C⁻¹·gp
                        // computed so the back-substitution below moves it toward the anchor.
                        if el.is_empty() && !anchored[pi] { continue; }
                        let mut cp = cmat[pi];
                        for i in 0..3 { cp[i][i] = cp[i][i] * (1.0 + lambda) + 1e-12; }
                        let cinv = match inv3(&cp) { Some(m) => m, None => { failed.store(true, std::sync::atomic::Ordering::Relaxed); return; } };
                        let tmp = mat3_vec(&cinv, &gpv[pi]); // C⁻¹·gp
                        // SAFETY (all writes below): chunk c alone writes its shares and its points.
                        unsafe { *ci_p.at(pi) = Some(cinv); *tmp_p.at(pi) = tmp; }
                        for eb in &el {
                            for a in 0..eb.dim {
                                unsafe { *r_p.at(eb.off + a) += eb.rows[a][0]*tmp[0] + eb.rows[a][1]*tmp[1] + eb.rows[a][2]*tmp[2]; }
                            }
                        }
                        // M_v = E_v·C⁻¹ (dim×3); then S -= Σ_{v1,v2} M_{v1}·E_{v2}ᵀ.
                        ms.clear();
                        ms.extend(el.iter().map(|eb| {
                            let mut m = [[0f64; 3]; BLK_MAX];
                            for a in 0..eb.dim {
                                for k in 0..3 {
                                    m[a][k] = eb.rows[a][0]*cinv[0][k] + eb.rows[a][1]*cinv[1][k] + eb.rows[a][2]*cinv[2][k];
                                }
                            }
                            m
                        }));
                        for (i1, eb1) in el.iter().enumerate() {
                            let m = &ms[i1];
                            for eb2 in &el {
                                if lower_only && eb2.blk > eb1.blk { continue; }
                                let base = pattern.at(eb1.blk, eb2.blk);
                                if eb1.dim == 6 && eb2.dim == 6 {
                                    // Camera × camera, fixed size (the same sums as below).
                                    for a in 0..6 {
                                        for b in 0..6 {
                                            let v = m[a][0]*eb2.rows[b][0] + m[a][1]*eb2.rows[b][1] + m[a][2]*eb2.rows[b][2];
                                            unsafe { *s_p.at(base + a*6 + b) -= v; }
                                        }
                                    }
                                } else {
                                    for a in 0..eb1.dim {
                                        for b in 0..eb2.dim {
                                            let v = m[a][0]*eb2.rows[b][0] + m[a][1]*eb2.rows[b][1] + m[a][2]*eb2.rows[b][2];
                                            unsafe { *s_p.at(base + a*eb2.dim + b) -= v; }
                                        }
                                    }
                                }
                            }
                        }
                    }
                });
                ok = !failed.load(std::sync::atomic::Ordering::Relaxed);
                if ok {
                    for c in 0..point_chunks {
                        for (x, v) in s.iter_mut().zip(&share_s[c]) { *x += v; }
                        for (x, v) in rhs.iter_mut().zip(&share_r[c]) { *x += v; }
                    }
                }
            }
            if cov_pass { if ok { last_s = Some(s); } break; }
            if !ok { lambda = (lambda * 4.0).min(LAMBDA_MAX); continue; }

            prof::mark(2);
            let dsol = if let Some(sym) = direct.as_ref() {
                solve_stats.solves += 1;
                solve_stats.cholesky += 1;
                match sym.factor(&pattern, &s) {
                    Some(f) => f.solve(&pattern, &rhs),
                    None => { lambda = (lambda * 4.0).min(LAMBDA_MAX); continue; }
                }
            } else {
                let ic = if solver.precond == 1 && (n >= solver.pcg_min_n || n > DENSE_MAX_N) { BlockIc::new(&pattern, &s) } else { None };
                match solve_reduced_with(n, |x, y| pattern.matvec(&s, x, y), &pattern.diag_blocks(&s), ic.as_ref(),
                                         || pattern.to_dense(&s), n <= DENSE_MAX_N, &rhs, &solver, &mut solve_stats) {
                    Some(x) => x,
                    None => { lambda = (lambda * 4.0).min(LAMBDA_MAX); continue; }
                }
            };

            prof::mark(3);
            // Back-substitute points: δp = −C⁻¹·gp − C⁻¹·(Σ_v E_vᵀ·δv).
            // Every point on its own: on the pool, CHUNK points per task.
            let mut dp = vec![[0f64; 3]; n_pts];
            let dp_p = SyncPtr::of(&mut dp);
            for_each_index(n_pts.div_ceil(CHUNK), |k| {
                let mut el: Vec<EBlock> = Vec::new();
                for pi in k * CHUNK..((k + 1) * CHUNK).min(n_pts) {
                    let cinv = match cinv_store[pi] { Some(m) => m, None => continue };
                    eblocks(pi, &cams, &pts, &gpar, dh, &mut el);
                    let mut acc = [0f64; 3];
                    for eb in &el {
                        for k in 0..3 {
                            let mut sdot = 0.0;
                            for a in 0..eb.dim { sdot += eb.rows[a][k] * dsol[eb.off + a]; }
                            acc[k] += sdot;
                        }
                    }
                    let ca = mat3_vec(&cinv, &acc);
                    // SAFETY: point pi belongs to chunk k alone.
                    let d = unsafe { dp_p.at(pi) };
                    for k in 0..3 { d[k] = -tmp_store[pi][k] - ca[k]; }
                }
            });

            // Tentative update: t += δt, R = exp(δω)·R, X += δX, group params += δ.
            let mut tent_cams = cams.clone();
            for (k, &c) in free_cams.iter().enumerate() {
                let (r0, t0) = cams[c];
                let dt = [dsol[6*k], dsol[6*k+1], dsol[6*k+2]];
                let dw = [dsol[6*k+3], dsol[6*k+4], dsol[6*k+5]];
                tent_cams[c] = (mat3_mul(&so3_exp(&dw), &r0), [t0[0]+dt[0], t0[1]+dt[1], t0[2]+dt[2]]);
            }
            let mut tent_gpar = gpar.clone();
            if refine {
                for g in 0..g_count {
                    let goff = group_off + g * kdim;
                    // Slots are contiguous per group; kdim picks how many (1–8).
                    for a in 0..kdim { tent_gpar[g][a] += dsol[goff + a]; }
                }
            }
            let mut tent_pts = pts.clone();
            for pi in 0..n_pts { for k in 0..3 { tent_pts[pi][k] += dp[pi][k]; } }

            let new_cost = robust_cost(&tent_cams, &tent_pts, &tent_gpar, dh);
            prof::mark(4);
            if new_cost < cost {
                cams = tent_cams;
                pts = tent_pts;
                gpar = tent_gpar;
                cost = new_cost;
                lambda = (lambda * 0.3).max(LAMBDA_MIN);
                accepted = true;
                break;
            } else {
                if lambda >= LAMBDA_MAX { break; }
                // A rejected step too small to change the model ends it too: a converged
                // model rejects every step to rounding, and more damping only shrinks them.
                let step2 = dsol.iter().map(|v| v * v).sum::<f64>() + dp.iter().map(|d| dot3(d, d)).sum::<f64>();
                let size2 = pts.iter().map(|x| dot3(x, x)).sum::<f64>()
                    + free_cams.iter().map(|&c| dot3(&cams[c].1, &cams[c].1)).sum::<f64>()
                    + if refine { gpar.iter().map(|g| g.iter().map(|v| v * v).sum::<f64>()).sum::<f64>() } else { 0.0 };
                if step2.sqrt() <= PARAM_TOL * (size2.sqrt() + PARAM_TOL) { break; }
                lambda = (lambda * 4.0).min(LAMBDA_MAX);
            }
        }
        if cov_pass { break; }
        // No step lowers the cost, even at the largest damping.
        let done = if !accepted { true } else {
            trace.push(rms(&cams, &pts, &gpar));
            // Compared within one iteration only: the Huber threshold is re-derived from
            // the residuals at the top of each iteration, so costs of different iterations
            // sit on different scales.
            function_tol > 0.0 && cost_at_start - cost <= function_tol * cost_at_start
        };
        if done {
            if !want_cov { break; }
            cov_pass = true;
        }
    }

    let cost_after = rms(&cams, &pts, &gpar);
    let anchor_rms_after = anchor_rms(&pts);
    let camera_prior_rms_after = camera_prior_rms(&cams);

    // ── The lens's standard deviations (solver slot 9) ───────────────────────────
    // σ² = σ0²·(S⁻¹)_ii on the reduced system of the last accepted step (S with the
    // points eliminated, so each σ is marginal over every pose and point; damped by a
    // factor 1 + λ that convergence has taken near 1), σ0² = the final cost over the
    // redundancy. Without control (no camera prior, no anchor, fewer than two fixed
    // cameras) S is singular along the 7 similarity directions; no lens term moves
    // under a similarity, so a minimal datum leaves their marginals as they are: hold
    // one camera and the scale along one baseline.
    let lens_sigmas: Vec<f64> = if let (true, Some(mut s)) = (want_cov, last_s.take()) {
        let n_fixed = n_pb - n_free;
        if camera_priors.is_empty() && anchors.is_empty() && n_fixed < 2 && n_free >= 2 {
            let hold = |s: &mut Vec<f64>, k: usize, dir: Option<V3>| {
                let base = pattern.diag_at[k];
                let big = 1e8 * (0..6).map(|i| s[base + i * 6 + i].abs()).fold(1.0, f64::max);
                match dir {
                    None => for i in 0..6 { s[base + i * 6 + i] += big; },
                    Some(u) => for a in 0..3 { for b in 0..3 { s[base + a * 6 + b] += big * u[a] * u[b]; } },
                }
            };
            // The datum camera: a fixed one if there is one (its slot is gone already),
            // else the first free one; the scale along the free camera farthest from it.
            let anchor_pb = (0..n_pb).find(|&b| slot[b] == FIXED).unwrap_or(free_cams[0]);
            if slot[anchor_pb] != FIXED { hold(&mut s, slot[anchor_pb], None); }
            let ca = camera_center(&cams[anchor_pb]);
            let far = free_cams.iter().copied().filter(|&b| b != anchor_pb)
                .max_by(|&a, &b| {
                    let d = |x: usize| { let c = camera_center(&cams[x]); (0..3).map(|i| (c[i] - ca[i]).powi(2)).sum::<f64>() };
                    d(a).partial_cmp(&d(b)).unwrap()
                });
            if let Some(b) = far {
                // dC = −Rᵀ·dt, so the scale's motion (C − C_a) is R·(C − C_a) in −dt.
                let c = camera_center(&cams[b]);
                let u = normalize3(&mat3_vec(&cams[b].0, &[c[0] - ca[0], c[1] - ca[1], c[2] - ca[2]]));
                hold(&mut s, slot[b], Some(u));
            }
        }
        let n_lens = g_count * kdim;
        let mut var = vec![f64::NAN; n_lens];
        let unit = |i: usize| { let mut e = vec![0f64; n]; e[group_off + i] = 1.0; e };
        let mut st = SolveStats::default();
        if let Some(f) = direct.as_ref().and_then(|sym| sym.factor(&pattern, &s)) {
            for i in 0..n_lens { var[i] = f.solve(&pattern, &unit(i))[group_off + i]; }
        } else {
            let ic = if solver.precond == 1 && (n >= solver.pcg_min_n || n > DENSE_MAX_N) { BlockIc::new(&pattern, &s) } else { None };
            let exact = SolverOpts { accept_partial: false, rel_tol: 1e-10, max_iter: 2000, ..solver };
            for i in 0..n_lens {
                if let Some(x) = solve_reduced_with(n, |x, y| pattern.matvec(&s, x, y), &pattern.diag_blocks(&s), ic.as_ref(),
                                                    || pattern.to_dense(&s), n <= DENSE_MAX_N, &unit(i), &exact, &mut st) {
                    var[i] = x[group_off + i];
                }
            }
        }
        // σ0²: the weighted residual sum over the redundancy (observations, anchor and
        // prior axes, less the unknowns).
        let dh = huber_threshold(&cams, &pts, &gpar);
        let n_valid = map_indexed(obs.len(), |o| sq_err(o, &cams, &pts, &gpar)).iter().filter(|v| !v.is_nan()).count();
        let m = 2 * n_valid + 3 * anchors.len()
            + camera_priors.iter().map(|p| if p.3.is_some() { 6 } else { 3 }).sum::<usize>();
        let unknowns = 6 * n_free + 3 * n_pts + n_lens;
        let s0 = if m > unknowns { robust_cost(&cams, &pts, &gpar, dh) / (m - unknowns) as f64 } else { f64::NAN };
        // Per group in the output's order; the focal slot is a scale on fx.
        let mut out = vec![f64::NAN; g_count * LENS_SIGMA_LEN];
        let first_cam = |g: usize| (0..n_cam).find(|&c| grp[c] == g).unwrap_or(0);
        for g in 0..g_count {
            let sd = |idx: isize| if idx >= 0 { (s0 * var[g * kdim + idx as usize]).max(0.0).sqrt() } else { f64::NAN };
            let o = &mut out[g * LENS_SIGMA_LEN..(g + 1) * LENS_SIGMA_LEN];
            o[0] = sd(idx_s) * ks[first_cam(g)].0;
            o[1] = sd(idx_dcx);
            o[2] = sd(idx_dcy);
            for j in 0..4 { o[3 + j] = if k_live(g, j) { sd(idx_k[j]) } else { f64::NAN }; }
            if p_live(g) { o[7] = sd(idx_p1); o[8] = sd(idx_p2); }
        }
        out
    } else { Vec::new() };

    // Pack output: cameras (12 each), points (3 each), refined effective intrinsics
    // (8 each: fx,fy,cx,cy,k1,k2,k3,k4 — a pinhole camera's Brown residual, 0 for the
    // bits not in refine_mask; a fisheye's full Kannala–Brandt coefficients),
    // [cost_before, cost_after, anchor_rms_after, camera_prior_rms_after], then trace.
    let intr_stride = if lens_stride == 7 { 10 } else { 8 };
    let mut out = Vec::with_capacity(n_cam * 12 + n_pts * 3 + n_cam * intr_stride + 4 + BA_STATS_LEN + trace.len());
    for c in 0..n_cam {
        let (r, t) = pose_of(c, &cams, &gpar);
        for row in &r { for &v in row { out.push(v as f32); } }
        for &v in &t { out.push(v as f32); }
    }
    for pt in &pts {
        for &v in pt { out.push(v as f32); }
    }
    for c in 0..n_cam {
        let e = eff(c, &gpar);
        out.push(e.fx as f32); out.push(e.fy as f32); out.push(e.cx as f32); out.push(e.cy as f32);
        for j in 0..4 { out.push(e.k[j] as f32); }
        if intr_stride == 10 { out.push(e.p[0] as f32); out.push(e.p[1] as f32); }
    }
    out.push(cost_before as f32);
    out.push(cost_after as f32);
    out.push(anchor_rms_after as f32);
    out.push(camera_prior_rms_after as f32);
    let st = &solve_stats;
    for v in [n as f64, st.solves as f64, st.cholesky as f64, st.pcg_converged as f64, st.pcg_partial as f64,
              st.pcg_fallback as f64, st.pcg_npd as f64, st.pcg_iters as f64, st.pcg_iters_max as f64] {
        out.push(v as f32);
    }
    if solver.covariance {
        // An empty section (no lens refined, or no accepted step) is [0].
        out.push((lens_sigmas.len() / LENS_SIGMA_LEN) as f32);
        for &v in &lens_sigmas { out.push(v as f32); }
    }
    if !rs_flat.is_empty() { for c in 0..n_cam { out.push(tau_of(c, &gpar) as f32); } }
    for &c in &trace { out.push(c as f32); }
    out
}

#[cfg(test)]
mod reduced_solve_tests {
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
        let mut prior = vec![0f32; 25];
        prior[3] = -10.0; prior[4] = 1e4; prior[5] = 1e4; prior[6] = 1e4;
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
    // ×28 Ceres' cost (docs/METHODS.md ▸ BA vs Ceres).
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
        let mut prior = vec![0f32; 25];
        prior[1] = 0.0; prior[2] = 0.0; prior[3] = -10.0; prior[4] = 1e4; prior[5] = 1e4; prior[6] = 1e4;
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
}

#[cfg(test)]
mod rolling_shutter_tests {
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
}

#[cfg(test)]
mod rig_tests {
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
}

#[cfg(test)]
mod lens_sigma_tests {
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
                for _ in 0..3 { prior_flat.push((1.0 / (sc * sc)) as f32); }
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
}
