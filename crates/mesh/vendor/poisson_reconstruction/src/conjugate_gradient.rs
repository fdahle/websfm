use crate::Real;
use na::DVector;
use nalgebra_sparse::CscMatrix;

pub fn solve_conjugate_gradient(a: &CscMatrix<Real>, b: &mut DVector<Real>, niters: usize) {
    let mut r = &*b - a * &*b;
    let mut p = r.clone();
    let mut prev_rr = r.dot(&r);

    for _ in 0..niters {
        // `prev_rr` already holds the current residual's `r·r` (set below each iter, and
        // seeded above), so reuse it instead of recomputing the dot product.
        if prev_rr <= 0.0 {
            break; // converged (or a degenerate/zero system) — nothing left to relax.
        }
        let ap = a * &p; // TODO: avoid the allocation.
        let alpha = prev_rr / p.dot(&ap);
        b.axpy(alpha, &p, 1.0);
        r.axpy(-alpha, &ap, 1.0);
        let rr = r.dot(&r);
        let beta = rr / prev_rr;
        prev_rr = rr;
        p.axpy(1.0, &r, beta);
    }
}
