// ─── MAGSAC++ two-view verification ──────────────────────────────────────────
// MAGSAC++ (Barath, Noskova, Ivashechkin & Matas, CVPR 2020), the alternative to
// the RANSAC + LO path in lib.rs for the fundamental matrix and the H-vs-F
// homography. Two changes against RANSAC, same minimal samples and seeds:
//
// 1. Scoring. RANSAC counts the points under one threshold, so a model whose
//    residuals all sit at 0.1 px scores the same as one whose residuals sit at
//    1.9 px. MAGSAC++ instead treats the noise scale σ as unknown, uniform on
//    [0, σ_max], and scores a model by the loss ρ obtained by marginalising a
//    χ-distributed residual (ν = 4 dimensions, the 4D correspondence) over σ. With
//    a = (ν−1)/2, K = k²/2 and U = r²/(2σ_max²), the IRLS weight and loss are
//        w(r) = Γ(a, U) − Γ(a, K)
//        ρ(r) = r²/2 · w(r) + σ_max² · γ(a+1, U)      (so ρ'(r) = r·w(r))
//    for r below the cut-off r_max = k·σ_max, and ρ(r_max) for every point
//    beyond it (an outlier costs the same however far out it is). Γ / γ are the
//    upper / lower incomplete gamma functions; for a = 3/2 they reduce to erfc
//    and exp. k = 3.64 is the 0.99 quantile of the χ distribution with 4 degrees
//    of freedom, as in the reference implementation. The user's threshold is
//    r_max: the same Sampson / transfer distance that bounds RANSAC's inliers.
//    The loss is stored normalised (0 at r = 0, 1 at and beyond r_max).
// 2. σ-consensus++. A promising model is polished by iteratively reweighted least
//    squares: refit by the weighted 8-point / DLT with weights w(r) on the points
//    within r_max, re-score, repeat while the loss drops. Points near the model
//    pull hard, points near the cut-off barely, so no hard inlier boundary decides
//    the fit. Two departures from the reference code: the weights are divided by
//    the squared gradient of the algebraic residual (Sampson's denominator for F,
//    (H·x)₃² for H), so the weighted fit minimises the weighted *geometric*
//    residual the loss is defined on rather than the algebraic one (the exact IRLS
//    step; on the synthetic pairs in lib.rs's tests it is a wash against plain
//    algebraic weights: median error 0.297 vs 0.330 px at a 3 px gate, 0.227 vs
//    0.218 at 5 px); and up to four unweighted refits on the
//    points within r_max run first, kept only when they lower the loss — from a
//    rough minimal-sample model the weights alone move too slowly (they trust only
//    what the rough model already explains), and MAGSAC++ without them ended worse
//    than LO-RANSAC. A sample is polished when it beats the best on loss or on
//    inlier count (RANSAC's trigger: a rough model's near-inliers cost almost as
//    much as outliers, so its raw loss undersells it); it becomes the best only
//    if its polished loss is lower.
//
// The pair's inlier set is still the points within the threshold of the final
// model, so inlier counts, the ratio gate and the H/F ratio mean what they mean
// for RANSAC. The adaptive stop uses that count too. Deterministic: the sampler is
// the seeded Xorshift of the RANSAC path, and the loss table is built from
// closed-form values the same way on every run.

use crate::{
    adaptive_iters, fundamental_8pt_w, homography_dlt_w, sample4, sample8, sampson_sq, transfer_sq,
    Xorshift, M3, RANSAC_CONFIDENCE,
};
use std::sync::OnceLock;

/// 0.99 quantile of the χ distribution with 4 degrees of freedom: √13.2767.
const K_CHI: f64 = 3.64;
/// IRLS rounds per new best model (σ-consensus++); it usually settles in 2–4.
const IRLS_ROUNDS: usize = 10;
/// Unweighted refits before the IRLS (see `sigma_consensus_pp`).
const HARD_ROUNDS: usize = 4;
/// Loss / weight table resolution over q = r²/r_max² ∈ [0, 1].
const LUT_N: usize = 4096;

// erfc, Numerical Recipes' Chebyshev fit (fractional error < 1.2e-7 everywhere):
// plenty for a score, and the same bits on every run.
fn erfc(x: f64) -> f64 {
    let z = x.abs();
    let t = 1.0 / (1.0 + 0.5 * z);
    let ans = t * (-z * z - 1.26551223
        + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
        + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223
        + t * 0.17087277))))))))).exp();
    if x >= 0.0 { ans } else { 2.0 - ans }
}

const SQRT_PI: f64 = 1.772_453_850_905_516;

// Γ(3/2, x) = (√π/2)·erfc(√x) + √x·e^{−x}
fn upper_gamma_3_2(x: f64) -> f64 {
    let s = x.sqrt();
    0.5 * SQRT_PI * erfc(s) + s * (-x).exp()
}

// γ(5/2, x) = Γ(5/2) − Γ(5/2, x), with Γ(5/2, x) = 3/2·Γ(3/2, x) + x^{3/2}·e^{−x}
fn lower_gamma_5_2(x: f64) -> f64 {
    0.75 * SQRT_PI - 1.5 * upper_gamma_3_2(x) - x * x.sqrt() * (-x).exp()
}

struct Lut {
    loss: Vec<f64>,
    weight: Vec<f64>,
}

// Normalised loss ρ(q)/ρ(1) and weight w(q)/w(0) at q = r²/r_max², where
// U = q·K. With σ_max = r_max/k both depend on q only, so one table serves every
// threshold.
fn lut() -> &'static Lut {
    static LUT: OnceLock<Lut> = OnceLock::new();
    LUT.get_or_init(|| {
        let big_k = K_CHI * K_CHI / 2.0;
        let g_k = upper_gamma_3_2(big_k);
        let l_k = lower_gamma_5_2(big_k);
        let w0 = upper_gamma_3_2(0.0) - g_k;
        let mut loss = Vec::with_capacity(LUT_N + 1);
        let mut weight = Vec::with_capacity(LUT_N + 1);
        for i in 0..=LUT_N {
            let u = big_k * i as f64 / LUT_N as f64;
            let w = upper_gamma_3_2(u) - g_k;
            loss.push((u * w + lower_gamma_5_2(u)) / l_k);
            weight.push((w / w0).max(0.0));
        }
        // Pin the ends exactly: no loss at r = 0, the outlier cost at r_max.
        loss[0] = 0.0;
        loss[LUT_N] = 1.0;
        weight[LUT_N] = 0.0;
        Lut { loss, weight }
    })
}

#[inline]
fn interp(table: &[f64], q: f64) -> f64 {
    let x = q * LUT_N as f64;
    let i = (x as usize).min(LUT_N - 1);
    let f = x - i as f64;
    table[i] + f * (table[i + 1] - table[i])
}

/// Normalised MAGSAC++ loss of a squared residual, given 1/r_max²: 0 at r = 0,
/// 1 at and beyond the cut-off.
#[inline]
pub(crate) fn loss(r_sq: f64, inv_thr_sq: f64) -> f64 {
    let q = r_sq * inv_thr_sq;
    if q < 1.0 { interp(&lut().loss, q) } else { 1.0 }
}

/// IRLS weight of a squared residual (1 at r = 0, 0 at and beyond the cut-off).
#[inline]
pub(crate) fn weight(r_sq: f64, inv_thr_sq: f64) -> f64 {
    let q = r_sq * inv_thr_sq;
    if q < 1.0 { interp(&lut().weight, q) } else { 0.0 }
}

/// The two models verification estimates.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Model {
    Fundamental,
    Homography,
}

impl Model {
    fn sample_size(self) -> usize {
        match self { Model::Fundamental => 8, Model::Homography => 4 }
    }
    #[inline]
    fn residual_sq(self, m: &M3, pa: (f64, f64), pb: (f64, f64)) -> f64 {
        match self { Model::Fundamental => sampson_sq(m, pa, pb), Model::Homography => transfer_sq(m, pa, pb) }
    }
    fn fit(self, a: &[(f64, f64)], b: &[(f64, f64)], w: Option<&[f64]>) -> Option<M3> {
        match self { Model::Fundamental => fundamental_8pt_w(a, b, w), Model::Homography => homography_dlt_w(a, b, w) }
    }
    // Scale between the fit's algebraic residual and the geometric one, squared, at
    // the current model: Sampson r² = e²/g² for F, and the DLT rows are the
    // transfer error times (H·x_a)₃ for H. Up to one constant for all points (the
    // Hartley normalisation and F's scale), so 1/g² turns a weighted algebraic fit
    // into a weighted geometric one about the current model.
    #[inline]
    fn algebraic_to_geometric(self, m: &M3, pa: (f64, f64), pb: (f64, f64)) -> f64 {
        match self {
            Model::Fundamental => {
                let fx1 = [m[0][0] * pa.0 + m[0][1] * pa.1 + m[0][2], m[1][0] * pa.0 + m[1][1] * pa.1 + m[1][2]];
                let ftx2 = [m[0][0] * pb.0 + m[1][0] * pb.1 + m[2][0], m[0][1] * pb.0 + m[1][1] * pb.1 + m[2][1]];
                let g2 = fx1[0] * fx1[0] + fx1[1] * fx1[1] + ftx2[0] * ftx2[0] + ftx2[1] * ftx2[1];
                if g2 > 1e-300 { 1.0 / g2 } else { 0.0 }
            }
            Model::Homography => {
                let w = m[2][0] * pa.0 + m[2][1] * pa.1 + m[2][2];
                if w.abs() > 1e-150 { 1.0 / (w * w) } else { 0.0 }
            }
        }
    }
    // The RANSAC path's seeds, so both verifiers draw the same samples.
    fn seed(self, n: usize) -> u32 {
        match self { Model::Fundamental => n as u32 * 1031 + 7, Model::Homography => n as u32 * 2657 + 13 }
    }
}

// Total loss of a model over every correspondence, or None as soon as it reaches
// `bail` (the best so far): the loss only grows, so the rest cannot rescue it.
fn score(model: Model, m: &M3, pa: &[(f64, f64)], pb: &[(f64, f64)], inv_thr_sq: f64, bail: f64) -> Option<f64> {
    let mut s = 0.0;
    for i in 0..pa.len() {
        s += loss(model.residual_sq(m, pa[i], pb[i]), inv_thr_sq);
        if s >= bail {
            return None;
        }
    }
    Some(s)
}

// Total loss and the number of points within the threshold, over every point.
fn score_count(model: Model, m: &M3, pa: &[(f64, f64)], pb: &[(f64, f64)], inv_thr_sq: f64) -> (f64, usize) {
    let (mut s, mut count) = (0.0, 0usize);
    for i in 0..pa.len() {
        let q = model.residual_sq(m, pa[i], pb[i]) * inv_thr_sq;
        if q < 1.0 {
            s += interp(&lut().loss, q);
            count += 1;
        } else {
            s += 1.0;
        }
    }
    (s, count)
}

/// σ-consensus++: polish a model by IRLS with the MAGSAC++ weights, keeping each
/// refit only while it lowers the total loss. Returns the polished model and score.
pub(crate) fn sigma_consensus_pp(
    model: Model,
    pa: &[(f64, f64)],
    pb: &[(f64, f64)],
    inv_thr_sq: f64,
    m: M3,
    s: f64,
) -> (M3, f64) {
    let (mut m, mut s) = (m, s);
    let (mut sa, mut sb, mut w) = (Vec::new(), Vec::new(), Vec::new());
    // Inner local optimisation first: unweighted refits on the points within the
    // threshold, each kept only if it lowers the loss. From a minimal-sample model
    // the IRLS weights alone move slowly (they trust the points the rough model
    // already explains, and barely see the rest), so this takes the large first steps
    // and IRLS does the fine ones.
    for _ in 0..HARD_ROUNDS {
        sa.clear();
        sb.clear();
        for i in 0..pa.len() {
            if model.residual_sq(&m, pa[i], pb[i]) * inv_thr_sq < 1.0 {
                sa.push(pa[i]);
                sb.push(pb[i]);
            }
        }
        if sa.len() < model.sample_size() {
            break;
        }
        let Some(m2) = model.fit(&sa, &sb, None) else { break };
        let Some(s2) = score(model, &m2, pa, pb, inv_thr_sq, s) else { break };
        m = m2;
        s = s2;
    }
    for _ in 0..IRLS_ROUNDS {
        sa.clear();
        sb.clear();
        w.clear();
        for i in 0..pa.len() {
            let wi = weight(model.residual_sq(&m, pa[i], pb[i]), inv_thr_sq)
                * model.algebraic_to_geometric(&m, pa[i], pb[i]);
            if wi > 0.0 {
                sa.push(pa[i]);
                sb.push(pb[i]);
                w.push(wi);
            }
        }
        if sa.len() < model.sample_size() {
            break;
        }
        let Some(m2) = model.fit(&sa, &sb, Some(&w)) else { break };
        let Some(s2) = score(model, &m2, pa, pb, inv_thr_sq, s) else { break };
        let settled = s - s2 <= 1e-9 * s;
        m = m2;
        s = s2;
        if settled {
            break;
        }
    }
    (m, s)
}

fn inlier_mask(model: Model, m: &M3, pa: &[(f64, f64)], pb: &[(f64, f64)], thresh_sq: f64) -> (Vec<bool>, usize) {
    let mut count = 0;
    let mask = (0..pa.len())
        .map(|i| {
            let ok = model.residual_sq(m, pa[i], pb[i]) < thresh_sq;
            count += ok as usize;
            ok
        })
        .collect();
    (mask, count)
}

/// MAGSAC++ estimate of `model` from the putative correspondences. Returns the
/// model, its inlier mask (residual below the threshold, as RANSAC's) and the
/// number of samples drawn; None with fewer than a minimal sample of inliers.
pub(crate) fn magsac(
    model: Model,
    pa: &[(f64, f64)],
    pb: &[(f64, f64)],
    thresh_sq: f64,
    max_iters: usize,
) -> Option<(M3, Vec<bool>, usize)> {
    let n = pa.len().min(pb.len());
    let ss = model.sample_size();
    if n < ss || !(thresh_sq > 0.0) {
        return None;
    }
    let (pa, pb) = (&pa[..n], &pb[..n]);
    let inv_thr_sq = 1.0 / thresh_sq;
    let mut rng = Xorshift::new(model.seed(n));
    let mut best: Option<M3> = None;
    let mut best_score = f64::INFINITY;
    let mut best_count = 0usize;
    let mut limit = max_iters;
    let mut iters = 0usize;
    let (mut sub_a, mut sub_b) = (Vec::with_capacity(ss), Vec::with_capacity(ss));
    while iters < limit {
        iters += 1;
        sub_a.clear();
        sub_b.clear();
        match model {
            Model::Fundamental => sample8(&mut rng, n).iter().for_each(|&i| { sub_a.push(pa[i]); sub_b.push(pb[i]); }),
            Model::Homography => sample4(&mut rng, n).iter().for_each(|&i| { sub_a.push(pa[i]); sub_b.push(pb[i]); }),
        }
        let Some(m) = model.fit(&sub_a, &sub_b, None) else { continue };
        // A minimal-sample model is rough: its true inliers sit anywhere inside the
        // threshold and cost nearly as much as outliers, so its loss alone rarely
        // beats an already polished best even when it would polish to a better one.
        // It is worth polishing when it beats the best on loss OR on inlier count
        // (RANSAC's criterion); the polished model must then win on loss.
        let (s, count) = score_count(model, &m, pa, pb, inv_thr_sq);
        if !(s < best_score || count > best_count) {
            continue;
        }
        let (m, s) = sigma_consensus_pp(model, pa, pb, inv_thr_sq, m, s);
        if !(s < best_score) {
            continue;
        }
        best = Some(m);
        best_score = s;
        best_count = inlier_mask(model, &m, pa, pb, thresh_sq).1;
        limit = max_iters.min(adaptive_iters(best_count as f64 / n as f64, ss as u32, RANSAC_CONFIDENCE));
    }
    let m = best?;
    let (mask, count) = inlier_mask(model, &m, pa, pb, thresh_sq);
    if count < ss {
        return None;
    }
    Some((m, mask, iters))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The closed forms against direct numerical integration of their definitions.
    #[test]
    fn incomplete_gammas_match_quadrature() {
        let quad = |f: &dyn Fn(f64) -> f64, a: f64, b: f64| {
            let n = 200_000;
            let h = (b - a) / n as f64;
            (0..n).map(|i| f(a + (i as f64 + 0.5) * h)).sum::<f64>() * h
        };
        for &x in &[0.0, 0.05, 0.5, 1.7, 4.0, 6.6248] {
            let upper = quad(&|t: f64| t.sqrt() * (-t).exp(), x, 60.0);
            let lower = quad(&|t: f64| t * t.sqrt() * (-t).exp(), 0.0, x);
            assert!((upper_gamma_3_2(x) - upper).abs() < 1e-6, "Γ(3/2,{x}): {} vs {upper}", upper_gamma_3_2(x));
            assert!((lower_gamma_5_2(x) - lower).abs() < 1e-6, "γ(5/2,{x}): {} vs {lower}", lower_gamma_5_2(x));
        }
    }

    // The loss is 0 at r = 0, rises monotonically to exactly 1 at the cut-off and
    // stays there; the weight falls from 1 to 0; and ρ' = r·w (the IRLS identity),
    // checked on the normalised table by finite differences.
    #[test]
    fn loss_and_weight_shape() {
        let thr_sq = 4.0;
        let inv = 1.0 / thr_sq;
        assert_eq!(loss(0.0, inv), 0.0);
        assert_eq!(loss(thr_sq, inv), 1.0);
        assert_eq!(loss(100.0, inv), 1.0);
        assert!((weight(0.0, inv) - 1.0).abs() < 1e-12);
        assert_eq!(weight(thr_sq, inv), 0.0);
        let mut prev_l = -1.0;
        let mut prev_w = 2.0;
        for i in 0..=400 {
            let r_sq = thr_sq * i as f64 / 400.0;
            let (l, w) = (loss(r_sq, inv), weight(r_sq, inv));
            assert!(l >= prev_l && w <= prev_w, "not monotone at r²={r_sq}");
            prev_l = l;
            prev_w = w;
        }
        // ρ'(r)/r ∝ w(r): the ratio is the same constant along the curve.
        let ratio = |r: f64| {
            let h = 1e-4;
            let d = (loss((r + h) * (r + h), inv) - loss((r - h) * (r - h), inv)) / (2.0 * h);
            d / (r * weight(r * r, inv))
        };
        let c = ratio(0.5);
        for &r in &[0.3, 0.8, 1.2, 1.6] {
            assert!((ratio(r) / c - 1.0).abs() < 1e-3, "ρ'/(r·w) varies at r={r}: {} vs {c}", ratio(r));
        }
    }
}
