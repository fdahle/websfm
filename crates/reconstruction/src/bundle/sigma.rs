// The lens's standard deviations (solver slot 9), from the reduced system at the solution.

#[allow(unused_imports)]
use crate::linalg::*;
#[allow(unused_imports)]
use crate::par::map_indexed;
#[allow(unused_imports)]
use super::*;

/// σ² = σ0²·(S⁻¹)_ii on the reduced system of the last pass (S with the points
/// eliminated, so each σ is marginal over every pose and point; damped by a factor 1 + λ
/// that convergence has taken near 1), σ0² = the final cost over the redundancy. Without
/// control (no camera prior, no anchor, fewer than two fixed cameras) S is singular along
/// the 7 similarity directions; no lens term moves under a similarity, so a minimal datum
/// leaves their marginals as they are: hold one camera and the scale along one baseline.
/// In the implicit solve (`imp`: B and the points' C⁻¹), S is B less the points' terms:
/// the datum holds go into B (the product) and S's diagonal blocks (`s`, the
/// preconditioner) alike. Returns LENS_SIGMA_LEN floats per sensor group.
#[allow(clippy::too_many_arguments)]
pub(crate) fn lens_sigmas(m: &Model, plan: &Plan, st: &State, solver: &SolverOpts, mut s: Vec<f64>,
                          mut imp: Option<(Vec<f64>, Vec<Option<M3>>)>, w: &mut Work) -> Vec<f64> {
    let (p, l) = (m.p, m.l);
    let (n, n_free, group_off, kdim, g_count) = (l.n, l.n_free, l.group_off, l.kdim, l.g_count);
    let (pattern, slot, free_cams, cams) = (&plan.pattern, &l.slot, &l.free_cams, &st.cams);
    let n_fixed = p.n_pb - n_free;
    if p.camera_priors.is_empty() && p.anchors.is_empty() && n_fixed < 2 && n_free >= 2 {
        let hold = |s: &mut Vec<f64>, imp: &mut Option<(Vec<f64>, Vec<Option<M3>>)>, k: usize, dir: Option<V3>| {
            let base = pattern.diag_at[k];
            let big = 1e8 * (0..6).map(|i| s[base + i * 6 + i].abs()).fold(1.0, f64::max);
            for m in std::iter::once(&mut *s).chain(imp.as_mut().map(|(b, _)| b)) {
                match dir {
                    None => for i in 0..6 { m[base + i * 6 + i] += big; },
                    Some(u) => for a in 0..3 { for b in 0..3 { m[base + a * 6 + b] += big * u[a] * u[b]; } },
                }
            }
        };
        // The datum camera: a fixed one if there is one (its slot is gone already),
        // else the first free one; the scale along the free camera farthest from it.
        let anchor_pb = (0..p.n_pb).find(|&b| slot[b] == FIXED).unwrap_or(free_cams[0]);
        if slot[anchor_pb] != FIXED { hold(&mut s, &mut imp, slot[anchor_pb], None); }
        let ca = camera_center(&cams[anchor_pb]);
        let far = free_cams.iter().copied().filter(|&b| b != anchor_pb)
            .max_by(|&a, &b| {
                let d = |x: usize| { let c = camera_center(&cams[x]); (0..3).map(|i| (c[i] - ca[i]).powi(2)).sum::<f64>() };
                d(a).total_cmp(&d(b))
            });
        if let Some(b) = far {
            // dC = −Rᵀ·dt, so the scale's motion (C − C_a) is R·(C − C_a) in −dt.
            let c = camera_center(&cams[b]);
            let u = normalize3(&mat3_vec(&cams[b].0, &[c[0] - ca[0], c[1] - ca[1], c[2] - ca[2]]));
            hold(&mut s, &mut imp, slot[b], Some(u));
        }
    }
    let n_lens = g_count * kdim;
    let mut var = vec![f64::NAN; n_lens];
    let unit = |i: usize| { let mut e = vec![0f64; n]; e[group_off + i] = 1.0; e };
    let mut stats = SolveStats::default();
    if let Some((b, cinv)) = imp.as_ref() {
        // PCG on the implicit S at the solution, one solve per lens term; a term whose
        // solve does not converge keeps NaN.
        let dh = m.huber_threshold(st);
        if plan.use_jcache { fill_jcache(m, plan, st, dh, &mut w.jcache); }
        let shares = std::cell::RefCell::new(std::mem::take(&mut w.share_r));
        let diag = pattern.diag_blocks(&s);
        for i in 0..n_lens {
            let matvec = |x: &[f64], y: &mut [f64]| {
                implicit_product(m, plan, b, cinv, &w.jcache, &mut shares.borrow_mut(), st, dh, x, y)
            };
            if let PcgResult::Converged(x, _) = pcg_core_with(n, matvec, &diag, None, &unit(i), IMPLICIT_SIGMA_TOL, IMPLICIT_SIGMA_MAX_ITER) {
                var[i] = x[group_off + i];
            }
        }
        w.share_r = shares.into_inner();
    } else if let Some(f) = plan.direct.as_ref().and_then(|sym| sym.factor(pattern, &s)) {
        for i in 0..n_lens { var[i] = f.solve(pattern, &unit(i))[group_off + i]; }
    } else {
        let ic = if solver.precond == 1 && (n >= solver.pcg_min_n || n > DENSE_MAX_N) { BlockIc::new(pattern, &s) } else { None };
        let exact = SolverOpts { accept_partial: false, rel_tol: 1e-10, max_iter: 2000, ..*solver };
        for i in 0..n_lens {
            if let Some(x) = solve_reduced_with(n, |x, y| pattern.matvec(&s, x, y), &pattern.diag_blocks(&s), ic.as_ref(),
                                                || pattern.to_dense(&s), n <= DENSE_MAX_N, &unit(i), &exact, &mut stats) {
                var[i] = x[group_off + i];
            }
        }
    }
    // σ0²: the weighted residual sum over the redundancy (observations, anchor and
    // prior axes, less the unknowns).
    let dh = m.huber_threshold(st);
    let n_valid = map_indexed(p.obs.len(), |o| m.sq_err(o, st)).iter().filter(|v| !v.is_nan()).count();
    let mm = 2 * n_valid + 3 * p.anchors.len()
        + p.camera_priors.iter().map(|c| if c.3.is_some() { 6 } else { 3 }).sum::<usize>();
    let unknowns = 6 * n_free + 3 * p.n_pts + n_lens;
    let s0 = if mm > unknowns { m.robust_cost(st, dh) / (mm - unknowns) as f64 } else { f64::NAN };
    // Per group in the output's order; the focal slot is a scale on fx.
    let mut out = vec![f64::NAN; g_count * LENS_SIGMA_LEN];
    let first_cam = |g: usize| (0..p.n_cam).find(|&c| l.grp[c] == g).unwrap_or(0);
    for g in 0..g_count {
        let sd = |idx: isize| if idx >= 0 { (s0 * var[g * kdim + idx as usize]).max(0.0).sqrt() } else { f64::NAN };
        let o = &mut out[g * LENS_SIGMA_LEN..(g + 1) * LENS_SIGMA_LEN];
        o[0] = sd(l.idx_s) * p.ks[first_cam(g)].0;
        o[1] = sd(l.idx_dcx);
        o[2] = sd(l.idx_dcy);
        for j in 0..4 { o[3 + j] = if l.k_live(g, j) { sd(l.idx_k[j]) } else { f64::NAN }; }
        if l.p_live(g) { o[7] = sd(l.idx_p1); o[8] = sd(l.idx_p2); }
    }
    out
}
