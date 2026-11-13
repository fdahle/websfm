// Bundle adjustment's linear algebra: the 3×3 point-block inverse, dense Cholesky,
// the solver options, the block-sparse reduced camera system and its PCG with the
// block-Jacobi and block IC(0) preconditioners.

#[allow(unused_imports)]
use crate::linalg::*;
#[allow(unused_imports)]
use crate::par::{for_each_index, map_indexed, SyncPtr, CHUNK};
#[allow(unused_imports)]
use super::*;

// ── Dense linear algebra for bundle adjustment ────────────────────────────────

// inv3's singularity test: det / (m00·m11·m22) below this is a block too thin to invert
// in f64 (condition ~10¹⁴ and up).
pub(crate) const INV3_MIN_RATIO: f64 = 1e-14;
// chol_solve's: a pivot below this share of its diagonal entry is a matrix not
// positive-definite to f64 precision.
pub(crate) const CHOL_MIN_PIVOT_RATIO: f64 = 1e-14;

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
pub(crate) fn dense_matvec(n: usize, a: &[f64], x: &[f64], y: &mut [f64]) {
    for i in 0..n {
        let row = &a[i * n..(i + 1) * n];
        let mut s = 0.0;
        for j in 0..n { s += row[j] * x[j]; }
        y[i] = s;
    }
}

#[cfg(test)]
pub(crate) fn dense_diag_blocks(n: usize, a: &[f64], blocks: &[(usize, usize)]) -> Vec<(usize, usize, Vec<f64>)> {
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
    pub(crate) fn iters(&self) -> usize {
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
pub(crate) struct BlockIc<'a> { pub pat: &'a BlockPattern, pub l: Vec<f64> }

// In-place lower Cholesky of a d×d row-major block; false when not positive definite.
pub(crate) fn chol_block(d: usize, a: &mut [f64]) -> bool {
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
