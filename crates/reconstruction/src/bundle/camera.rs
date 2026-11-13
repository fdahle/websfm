// Bundle adjustment's camera model: the Brown and Kannala–Brandt lens factor and its
// Jacobians, the full projection, and Log(R) for the orientation priors.

#[allow(unused_imports)]
use crate::linalg::*;
#[allow(unused_imports)]
use crate::par::{for_each_index, map_indexed, SyncPtr, CHUNK};
#[allow(unused_imports)]
use super::*;

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
pub(crate) fn lens_factor(r2: f64, k: &[f64; 4], fisheye: bool) -> (f64, f64, [f64; 4]) {
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
pub(crate) fn distort_norm(a: f64, b: f64, m: f64, p: &[f64; 2]) -> (f64, f64) {
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
pub(crate) fn project_full(r: &M3, t: &V3, fx: f64, fy: f64, cx: f64, cy: f64, k: &[f64; 4], p: &[f64; 2], fisheye: bool, x: &V3) -> (f64, f64) {
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
