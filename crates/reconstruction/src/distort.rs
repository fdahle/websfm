// Brown–Conrady undistortion of many keypoints at once: the self-calibration fold
// (src/core/sfm/selfCalFold.js) moves every keypoint of a sensor's images on each
// self-calibrating solve, 2.5 M points per pass on a 347-image block.
//
// The arithmetic is src/core/sfm/distortion.js `undistortPixel` → `undistortBrown`,
// operation for operation, so the results are the same bits as the JS path (wasm
// does not contract a·b + c into a fused multiply-add). Keep the two in step.

use wasm_bindgen::prelude::*;

use crate::par::{for_each_index, SyncPtr};

/// The forward model: ideal normalised (x, y) → distorted normalised.
/// `d` = [k1, k2, k3, k4, k5, k6, p1, p2].
#[inline(always)]
fn brown_forward(x: f64, y: f64, d: &[f64; 8]) -> (f64, f64) {
    let [k1, k2, k3, k4, k5, k6, p1, p2] = *d;
    let r2 = x * x + y * y;
    let radial = (1.0 + r2 * (k1 + r2 * (k2 + r2 * k3))) / (1.0 + r2 * (k4 + r2 * (k5 + r2 * k6)));
    let xy = x * y;
    let xd = x * radial + 2.0 * p1 * xy + p2 * (r2 + 2.0 * x * x);
    let yd = y * radial + p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * xy;
    (xd, yd)
}

/// Newton with backtracking on the forward model (distortion.js `undistortBrown`).
fn undistort_normalized(xd: f64, yd: f64, d: &[f64; 8], iters: u32) -> (f64, f64) {
    let [k1, k2, k3, k4, k5, k6, p1, p2] = *d;
    let (mut x, mut y) = (xd, yd);
    let (fx0, fy0) = brown_forward(x, y, d);
    let (mut ex, mut ey) = (fx0 - xd, fy0 - yd);
    let mut err = ex * ex + ey * ey;
    let mut i = 0;
    while i < iters && err > 1e-26 {
        let r2 = x * x + y * y;
        let num = 1.0 + r2 * (k1 + r2 * (k2 + r2 * k3));
        let den = 1.0 + r2 * (k4 + r2 * (k5 + r2 * k6));
        let dnum = k1 + r2 * (2.0 * k2 + 3.0 * k3 * r2);
        let dden = k4 + r2 * (2.0 * k5 + 3.0 * k6 * r2);
        let radial = num / den;
        let g = (dnum * den - num * dden) / (den * den);
        let a = radial + 2.0 * x * x * g + 2.0 * p1 * y + 6.0 * p2 * x;
        let b = 2.0 * x * y * g + 2.0 * p1 * x + 2.0 * p2 * y;
        let c = b;
        let e = radial + 2.0 * y * y * g + 6.0 * p1 * y + 2.0 * p2 * x;
        let det = a * e - b * c;
        if !(det.abs() > 1e-15) { break; }
        let sx = (e * ex - b * ey) / det;
        let sy = (a * ey - c * ex) / det;
        let mut t = 1.0;
        let mut improved = false;
        for _ in 0..8 {
            let nx = x - t * sx;
            let ny = y - t * sy;
            let (fx, fy) = brown_forward(nx, ny, d);
            let (rx, ry) = (fx - xd, fy - yd);
            let nerr = rx * rx + ry * ry;
            if nerr < err {
                x = nx;
                y = ny;
                ex = rx;
                ey = ry;
                err = nerr;
                improved = true;
                break;
            }
            t *= 0.5;
        }
        if !improved { break; }
        i += 1;
    }
    (x, y)
}

/// Undistort the pixels of several images through one Brown bag.
///
/// `xy`: every image's keypoints, [x0, y0, x1, y1, …], image after image; `starts`: the
/// first point of each image, plus the total (n_images + 1 entries); `k`: [fx, fy, cx, cy]
/// per image, the K each image's pixels are normalised about; `d`: [k1, k2, k3, k4, k5,
/// k6, p1, p2]; `iters`: the Newton step cap. A point whose x is NaN (a missing
/// keypoint) stays NaN. The images run on the thread pool in the threaded build.
#[wasm_bindgen]
pub fn undistort_brown_pixels(xy: &[f64], starts: &[u32], k: &[f64], d: &[f64], iters: u32) -> Vec<f64> {
    let n_img = starts.len().saturating_sub(1);
    let mut out = vec![f64::NAN; xy.len()];
    if n_img == 0 || k.len() < 4 * n_img || d.len() < 8 { return out; }
    // Each image writes its own range of `out` from its thread, so the ranges must not
    // overlap: `starts` from the caller must not decrease. Refuse it otherwise.
    if starts.windows(2).any(|w| w[1] < w[0]) { return out; }
    let bag: [f64; 8] = [d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]];
    let p = SyncPtr::of(&mut out);
    for_each_index(n_img, |im| {
        let (a, b) = (starts[im] as usize, (starts[im + 1] as usize).min(xy.len() / 2));
        if b <= a { return; }
        let (fx, fy, cx, cy) = (k[4 * im], k[4 * im + 1], k[4 * im + 2], k[4 * im + 3]);
        // SAFETY: image im alone writes its points a..b.
        let dst = unsafe { p.slice(2 * a, 2 * (b - a)) };
        for (j, q) in (a..b).enumerate() {
            let (u, v) = (xy[2 * q], xy[2 * q + 1]);
            if u.is_nan() { continue; } // stays NaN
            let (x, y) = undistort_normalized((u - cx) / fx, (v - cy) / fy, &bag, iters);
            dst[2 * j] = fx * x + cx;
            dst[2 * j + 1] = fy * y + cy;
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::distort_jac;

    // The lens model is written three times: here (undistortion, the self-calibration
    // fold), in bundle/camera.rs (the solver's projection and its Jacobians) and in
    // src/core/sfm/distortion.js. That this file gives distortion.js's bits is checked in
    // src/core/sfm/reconstruction.test.js (undistortBrownPixels); these check the
    // solver's model against this file, and its fisheye branch against Kannala–Brandt.
    fn close(a: f64, b: f64) -> bool { (a - b).abs() <= 1e-13 * (1.0 + b.abs()) }

    #[test]
    fn the_solver_distorts_as_the_undistortion_inverts() {
        // [k1, k2, k3, p1, p2]: barrel, pincushion with decentring, none.
        let bags = [[-0.2, 0.05, -0.01, 0.0, 0.0], [0.12, -0.03, 0.004, 1e-3, -5e-4], [0.0; 5]];
        for bag in bags {
            for i in 0..21 {
                for j in 0..21 {
                    let (a, b) = (-0.6 + 0.06 * i as f64, -0.45 + 0.045 * j as f64);
                    let (xd, yd) = brown_forward(a, b, &[bag[0], bag[1], bag[2], 0.0, 0.0, 0.0, bag[3], bag[4]]);
                    let s = distort_jac(a, b, &[bag[0], bag[1], bag[2], 0.0], &[bag[3], bag[4]], false);
                    assert!(close(s.xd, xd) && close(s.yd, yd), "{bag:?} at ({a}, {b}): solver ({}, {}), undistortion's forward ({xd}, {yd})", s.xd, s.yd);
                }
            }
        }
    }

    #[test]
    fn the_solver_fisheye_is_kannala_brandt() {
        // θd = θ·(1 + k1θ² + k2θ⁴ + k3θ⁶ + k4θ⁸), θ = atan r; the point moves along its ray.
        let k = [0.03, -0.01, 0.002, -1e-4];
        for i in 1..40 {
            let r = 0.05 * i as f64;
            for j in 0..8 {
                let phi = 0.7 * j as f64;
                let (a, b) = (r * phi.cos(), r * phi.sin());
                let th = r.atan();
                let thd = th * (1.0 + k[0] * th.powi(2) + k[1] * th.powi(4) + k[2] * th.powi(6) + k[3] * th.powi(8));
                let s = distort_jac(a, b, &k, &[0.0, 0.0], true);
                assert!(close(s.xd, a * thd / r) && close(s.yd, b * thd / r), "r {r}, φ {phi}");
            }
        }
        let s = distort_jac(0.0, 0.0, &k, &[0.0, 0.0], true);
        assert_eq!((s.xd, s.yd), (0.0, 0.0));
    }
}
