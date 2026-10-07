use crate::Real;
use na::DVector;
use nalgebra_sparse::CscMatrix;

/// Relative residual at which the solve stops early: `‖r‖ ≤ REL_TOL · ‖b‖`.
pub const REL_TOL: Real = 1e-6;

/// Solve `a·x = b` in place (`b` becomes `x`) by conjugate gradient, at most `niters`
/// iterations. Returns the number of iterations run.
///
/// (Vendored patch.) Upstream started from `x₀ = b` — the right-hand side, a vector of
/// divergences with nothing to do with the solution — and ran a fixed 10 iterations,
/// which cannot wash that guess out. On a clean, 8000-sample unit sphere at depth 6 the
/// extracted surface then had 444 components with 47 % of its area off the sphere
/// (vertex-radius RMS 0.094): the leftover residual is closed, cell-sized ripples of the
/// implicit function, the "rounded cube" blobs of the 2026-10-07 eagle mesh. Starting
/// from `x₀ = b` it takes ~100 iterations to reach RMS 0.0004; from `x₀ = 0` the
/// cascadic multigrid (each layer solves only the residual the coarser ones left) gets
/// there in ≤ 10, and the tolerance stop ends it early. Measured 2026-10-07, see the
/// crate's `sweep_cg_iterations`.
pub fn solve_conjugate_gradient(a: &CscMatrix<Real>, b: &mut DVector<Real>, niters: usize) -> usize {
    let mut r = b.clone();
    let bb = r.dot(&r);
    b.fill(0.0);
    if !(bb > 0.0) {
        return 0;
    }
    let stop = REL_TOL * REL_TOL * bb;
    let mut p = r.clone();
    let mut prev_rr = bb;

    for it in 0..niters {
        if prev_rr <= stop {
            return it;
        }
        let ap = a * &p;
        let pap = p.dot(&ap);
        if !(pap > 0.0) {
            return it; // lost positive-definiteness numerically — keep what we have
        }
        let alpha = prev_rr / pap;
        b.axpy(alpha, &p, 1.0);
        r.axpy(-alpha, &ap, 1.0);
        let rr = r.dot(&r);
        let beta = rr / prev_rr;
        prev_rr = rr;
        p.axpy(1.0, &r, beta);
    }
    niters
}
