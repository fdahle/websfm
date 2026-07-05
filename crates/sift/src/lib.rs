use wasm_bindgen::prelude::*;

const N_HIST: usize = 4;   // 4×4 spatial grid
const N_ORI:  usize = 8;   // 8 orientation bins per cell
const DESC_LEN: usize = N_HIST * N_HIST * N_ORI; // 128

/// Output stride per keypoint: x, y, scale, response, angle, desc[128]
const STRIDE: usize = 5 + DESC_LEN; // 133

/// Near-duplicate suppression radius (input pixels). A strong blob fires as a DoG
/// extremum at several adjacent scale levels and again in the next octave; mapped
/// back through the octave scale factor those land several keypoints within a pixel
/// of each other. Keep only the strongest at each visual location.
const DEDUP_RADIUS_PX: f32 = 2.0;

/// Detect SIFT keypoints and compute 128-d descriptors.
///
/// Returns a flat `Float32Array` with `STRIDE` (133) values per keypoint:
/// `[x, y, scale, response, angle, d0..d127, ...]`
/// where `x`/`y` are in input-image pixel coordinates, followed by TWO trailing
/// values: `raw_found` = keypoints surviving near-duplicate suppression but *before*
/// the `max_keypoints` cap (so callers can report how many were dropped to the cap),
/// then `suppressed` = keypoints dropped as near-duplicate positions (multiple
/// scale/octave DoG extrema collapsing onto one visual location). A degenerate input
/// (zero-size / short buffer) returns an empty vec; a valid image with no extrema
/// returns `[0.0, 0.0]`. Parse as `kept = floor((len - 2) / STRIDE)`,
/// `raw = flat[len-2]`, `suppressed = flat[len-1]`.
#[wasm_bindgen]
pub fn detect_sift(
    rgba: &[u8],
    width: usize,
    height: usize,
    contrast_threshold: f32,
    max_keypoints: usize,
) -> Vec<f32> {
    if width == 0 || height == 0 || rgba.len() < width * height * 4 {
        return Vec::new();
    }

    let gray = to_gray(rgba, width, height);
    let kps = sift_keypoints(&gray, width, height, contrast_threshold);
    let detected = kps.len(); // total extrema, before dedup and before the cap

    // Response-desc first so near-duplicate suppression keeps the strongest at each
    // location, then feeds the max_keypoints cap the best survivors.
    let mut kps = kps;
    kps.sort_by(|a, b| b.response.partial_cmp(&a.response).unwrap_or(std::cmp::Ordering::Equal));
    let mut kps = suppress_duplicate_positions(kps, DEDUP_RADIUS_PX);
    let suppressed = detected - kps.len();
    let raw_found = kps.len(); // post-dedup, before the max_keypoints cap
    if max_keypoints > 0 && kps.len() > max_keypoints {
        kps.truncate(max_keypoints);
    }

    let mut out = Vec::with_capacity(kps.len() * STRIDE + 1);
    for k in kps {
        out.push(k.x);
        out.push(k.y);
        out.push(k.scale);
        out.push(k.response);
        out.push(k.angle);
        out.extend_from_slice(&k.desc);
    }
    out.push(raw_found as f32); // trailing sentinels: post-dedup count …
    out.push(suppressed as f32); // … then near-duplicates suppressed
    out
}

/// Drop near-duplicate keypoints: for a response-desc–sorted list, keep a keypoint
/// only when no already-kept (stronger) one lies within `radius` px. A spatial hash
/// (cell = `radius`) keeps this ~O(n): a candidate only compares against kept points
/// in its own and adjacent cells. See `DEDUP_RADIUS_PX` for why duplicates arise.
fn suppress_duplicate_positions(kps: Vec<Kp>, radius: f32) -> Vec<Kp> {
    if kps.is_empty() {
        return kps;
    }
    let r2 = radius * radius;
    let cell = radius.max(1.0);
    let mut grid: std::collections::HashMap<(i32, i32), Vec<usize>> =
        std::collections::HashMap::new();
    let mut kept: Vec<Kp> = Vec::with_capacity(kps.len());
    for kp in kps {
        let cx = (kp.x / cell).floor() as i32;
        let cy = (kp.y / cell).floor() as i32;
        let mut dup = false;
        'search: for gx in cx - 1..=cx + 1 {
            for gy in cy - 1..=cy + 1 {
                if let Some(idxs) = grid.get(&(gx, gy)) {
                    for &i in idxs {
                        let dx = kept[i].x - kp.x;
                        let dy = kept[i].y - kp.y;
                        if dx * dx + dy * dy <= r2 {
                            dup = true;
                            break 'search;
                        }
                    }
                }
            }
        }
        if dup {
            continue;
        }
        let idx = kept.len();
        grid.entry((cx, cy)).or_default().push(idx);
        kept.push(kp);
    }
    kept
}

struct Kp {
    x:        f32,
    y:        f32,
    scale:    f32,
    response: f32,
    angle:    f32,
    desc:     [f32; DESC_LEN],
}

// ── Image helpers ─────────────────────────────────────────────────────────────

fn to_gray(rgba: &[u8], w: usize, h: usize) -> Vec<f32> {
    let mut g = vec![0f32; w * h];
    for i in 0..w * h {
        let r  = rgba[i * 4]     as f32;
        let gr = rgba[i * 4 + 1] as f32;
        let b  = rgba[i * 4 + 2] as f32;
        g[i] = (0.299 * r + 0.587 * gr + 0.114 * b) / 255.0;
    }
    g
}

fn clampi(v: i32, lo: i32, hi: i32) -> i32 {
    v.max(lo).min(hi)
}

fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let radius = (3.0 * sigma).ceil().max(1.0) as i32;
    let mut k = Vec::with_capacity((2 * radius + 1) as usize);
    let mut sum = 0.0f32;
    for i in -radius..=radius {
        let v = (-(i * i) as f32 / (2.0 * sigma * sigma)).exp();
        k.push(v);
        sum += v;
    }
    for v in k.iter_mut() { *v /= sum; }
    k
}

/// Separable Gaussian blur with clamp-to-edge borders.
fn blur(src: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    let k = gaussian_kernel(sigma);
    let radius = (k.len() / 2) as i32;

    let mut tmp = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0f32;
            for (ki, &kv) in k.iter().enumerate() {
                let sx = clampi(x as i32 + ki as i32 - radius, 0, w as i32 - 1) as usize;
                acc += src[y * w + sx] * kv;
            }
            tmp[y * w + x] = acc;
        }
    }

    let mut out = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0f32;
            for (ki, &kv) in k.iter().enumerate() {
                let sy = clampi(y as i32 + ki as i32 - radius, 0, h as i32 - 1) as usize;
                acc += tmp[sy * w + x] * kv;
            }
            out[y * w + x] = acc;
        }
    }
    out
}

/// Halve resolution by taking every other pixel.
fn downsample(src: &[f32], w: usize, h: usize) -> (Vec<f32>, usize, usize) {
    let nw = w / 2;
    let nh = h / 2;
    let mut out = vec![0f32; nw * nh];
    for y in 0..nh {
        for x in 0..nw {
            out[y * nw + x] = src[(y * 2) * w + (x * 2)];
        }
    }
    (out, nw, nh)
}

// ── Orientation ───────────────────────────────────────────────────────────────

/// Returns the dominant gradient orientation at (kx, ky) in `gauss`.
fn compute_orientation(gauss: &[f32], w: usize, h: usize, kx: f32, ky: f32, scale: f32) -> f32 {
    let radius   = (3.0 * scale).round().max(1.0) as i32;
    let sigma_sq = (1.5 * scale) * (1.5 * scale);
    let mut hist = [0.0f32; 36];

    for dy in -radius..=radius {
        let py = ky as i32 + dy;
        if py < 1 || py >= h as i32 - 1 { continue; }
        for dx in -radius..=radius {
            let px = kx as i32 + dx;
            if px < 1 || px >= w as i32 - 1 { continue; }

            let gx = gauss[py as usize * w + px as usize + 1]
                   - gauss[py as usize * w + px as usize - 1];
            let gy = gauss[(py as usize + 1) * w + px as usize]
                   - gauss[(py as usize - 1) * w + px as usize];
            let mag = (gx * gx + gy * gy).sqrt();
            let ori = gy.atan2(gx); // -π..π

            let dist_sq = (dx * dx + dy * dy) as f32;
            let weight  = (-dist_sq / (2.0 * sigma_sq)).exp();

            let bin_f = (ori + std::f32::consts::PI) / (2.0 * std::f32::consts::PI) * 36.0;
            let bin   = (bin_f as usize).min(35);
            hist[bin] += mag * weight;
        }
    }

    // Smooth histogram 6 times with a [0.25, 0.5, 0.25] kernel.
    for _ in 0..6 {
        let h0 = hist;
        for i in 0..36 {
            hist[i] = 0.25 * h0[(i + 35) % 36]
                    + 0.50 * h0[i]
                    + 0.25 * h0[(i +  1) % 36];
        }
    }

    // Find dominant peak, then interpolate sub-bin with a parabola.
    let (peak_bin, peak_val) = hist.iter().enumerate()
        .fold((0, 0.0f32), |(bi, bv), (i, &v)| if v > bv { (i, v) } else { (bi, bv) });

    let l = hist[(peak_bin + 35) % 36];
    let r = hist[(peak_bin +  1) % 36];
    let denom  = l - 2.0 * peak_val + r;
    let offset = if denom.abs() > 1e-6 { 0.5 * (l - r) / denom } else { 0.0 };

    ((peak_bin as f32 + 0.5 + offset) / 36.0) * 2.0 * std::f32::consts::PI
        - std::f32::consts::PI
}

// ── Descriptor ────────────────────────────────────────────────────────────────

/// Compute the 128-d SIFT descriptor for a keypoint.
///
/// Samples a 4×4 grid of 4×4-pixel cells from `gauss` around (kx, ky),
/// rotated by `angle`, and builds an 8-bin gradient histogram per cell.
/// The result is L2-normalised, clamped at 0.2, and re-normalised.
fn compute_descriptor(
    gauss: &[f32],
    w: usize,
    h: usize,
    kx: f32,
    ky: f32,
    scale: f32,
    angle: f32,
) -> [f32; DESC_LEN] {
    let hist_width = 3.0 * scale;           // pixels per histogram cell
    let half       = N_HIST as f32 / 2.0;  // 2.0

    let cos_t = angle.cos();
    let sin_t = angle.sin();

    // Radius of the sampling window (rotate-safe)
    let radius   = (hist_width * (half + 0.5) * std::f32::consts::SQRT_2).ceil() as i32;
    let sigma_sq = (half * hist_width) * (half * hist_width);

    let mut hist = [0.0f32; DESC_LEN];

    for dy in -radius..=radius {
        let py = ky as i32 + dy;
        if py < 1 || py >= h as i32 - 1 { continue; }
        for dx in -radius..=radius {
            let px = kx as i32 + dx;
            if px < 1 || px >= w as i32 - 1 { continue; }

            // Rotate into the keypoint's reference frame, normalise by cell width.
            let dx_f = dx as f32;
            let dy_f = dy as f32;
            let rx = ( cos_t * dx_f + sin_t * dy_f) / hist_width;
            let ry = (-sin_t * dx_f + cos_t * dy_f) / hist_width;

            if rx < -(half + 1.0) || rx >= half + 1.0 || ry < -(half + 1.0) || ry >= half + 1.0 {
                continue;
            }

            let gx = gauss[py as usize * w + px as usize + 1]
                   - gauss[py as usize * w + px as usize - 1];
            let gy = gauss[(py as usize + 1) * w + px as usize]
                   - gauss[(py as usize - 1) * w + px as usize];
            let mag = (gx * gx + gy * gy).sqrt();

            // Gradient orientation relative to the keypoint's angle.
            let ori = (gy.atan2(gx) - angle)
                      .rem_euclid(2.0 * std::f32::consts::PI)
                      / (2.0 * std::f32::consts::PI)
                      * N_ORI as f32;

            // Gaussian weight over the whole descriptor window.
            let w_exp = (-(dx_f * dx_f + dy_f * dy_f) / (2.0 * sigma_sq)).exp();
            let contrib = mag * w_exp;

            // Trilinear interpolation into the histogram array.
            let rx0 = rx + half - 0.5;
            let ry0 = ry + half - 0.5;

            let rxi = rx0.floor() as i32;
            let ryi = ry0.floor() as i32;
            let oi  = ori.floor() as i32;

            let rxw = rx0 - rxi as f32;
            let ryw = ry0 - ryi as f32;
            let ow  = ori  - oi  as f32;

            for dr in 0..2i32 {
                let wr = if dr == 0 { 1.0 - ryw } else { ryw };
                let ri = ryi + dr;
                if ri < 0 || ri >= N_HIST as i32 { continue; }
                for dc in 0..2i32 {
                    let wc = if dc == 0 { 1.0 - rxw } else { rxw };
                    let ci = rxi + dc;
                    if ci < 0 || ci >= N_HIST as i32 { continue; }
                    for do_ in 0..2i32 {
                        let wo  = if do_ == 0 { 1.0 - ow } else { ow };
                        let obi = ((oi + do_) as usize).rem_euclid(N_ORI);
                        let idx = (ri as usize * N_HIST + ci as usize) * N_ORI + obi;
                        hist[idx] += contrib * wr * wc * wo;
                    }
                }
            }
        }
    }

    // L2-normalise → clamp → re-normalise
    let norm = hist.iter().map(|&v| v * v).sum::<f32>().sqrt().max(1e-10);
    for v in hist.iter_mut() { *v /= norm; }
    for v in hist.iter_mut() { *v = v.min(0.2); }
    let norm2 = hist.iter().map(|&v| v * v).sum::<f32>().sqrt().max(1e-10);
    for v in hist.iter_mut() { *v /= norm2; }

    hist
}

// ── Detection + description ───────────────────────────────────────────────────

/// Solve a 3×3 linear system `A · x = b` by Cramer's rule.
/// Returns `None` for a (near-)singular matrix.
fn solve3(a: [[f32; 3]; 3], b: [f32; 3]) -> Option<[f32; 3]> {
    let det3 = |m: &[[f32; 3]; 3]| {
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
      - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
      + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    };
    let det = det3(&a);
    if det.abs() < 1e-12 { return None; }
    let inv = 1.0 / det;
    let mut out = [0f32; 3];
    for c in 0..3 {
        let mut m = a;
        for r in 0..3 { m[r][c] = b[r]; }
        out[c] = det3(&m) * inv;
    }
    Some(out)
}

/// Refine a discrete DoG extremum to sub-pixel / sub-scale position via the
/// standard Lowe quadratic fit (Lowe §4). Iteratively fits a 3D quadratic to
/// the DoG around `(x0, y0, s0)` and solves `H · offset = -gradient` for the
/// peak; if the offset exceeds half a sample the search re-centres on the
/// nearest neighbour and retries. Returns the refined octave-local `(x, y)`,
/// the fractional scale-layer index, and the interpolated DoG contrast, or
/// `None` if it walks outside the valid interior or fails to converge.
fn refine_extremum(
    dog: &[Vec<f32>],
    w: usize,
    h: usize,
    x0: usize,
    y0: usize,
    s0: usize,
) -> Option<(f32, f32, f32, f32)> {
    const MAX_ITERS: usize = 5;
    let s_lo = 1i32;
    let s_hi = dog.len() as i32 - 2;

    let mut x = x0 as i32;
    let mut y = y0 as i32;
    let mut s = s0 as i32;

    for _ in 0..MAX_ITERS {
        let (xi, yi, si) = (x as usize, y as usize, s as usize);
        let at = |ss: usize, yy: usize, xx: usize| dog[ss][yy * w + xx];
        let c = at(si, yi, xi);

        // 3D gradient (central differences in x, y, scale).
        let gx = 0.5 * (at(si, yi, xi + 1) - at(si, yi, xi - 1));
        let gy = 0.5 * (at(si, yi + 1, xi) - at(si, yi - 1, xi));
        let gs = 0.5 * (at(si + 1, yi, xi) - at(si - 1, yi, xi));

        // 3D Hessian.
        let dxx = at(si, yi, xi + 1) + at(si, yi, xi - 1) - 2.0 * c;
        let dyy = at(si, yi + 1, xi) + at(si, yi - 1, xi) - 2.0 * c;
        let dss = at(si + 1, yi, xi) + at(si - 1, yi, xi) - 2.0 * c;
        let dxy = 0.25 * (at(si, yi + 1, xi + 1) - at(si, yi + 1, xi - 1)
                        - at(si, yi - 1, xi + 1) + at(si, yi - 1, xi - 1));
        let dxs = 0.25 * (at(si + 1, yi, xi + 1) - at(si + 1, yi, xi - 1)
                        - at(si - 1, yi, xi + 1) + at(si - 1, yi, xi - 1));
        let dys = 0.25 * (at(si + 1, yi + 1, xi) - at(si + 1, yi - 1, xi)
                        - at(si - 1, yi + 1, xi) + at(si - 1, yi - 1, xi));

        let offset = solve3(
            [[dxx, dxy, dxs],
             [dxy, dyy, dys],
             [dxs, dys, dss]],
            [-gx, -gy, -gs],
        )?;
        let (ox, oy, os) = (offset[0], offset[1], offset[2]);

        // Converged: peak lies within half a sample of the current point.
        if ox.abs() < 0.5 && oy.abs() < 0.5 && os.abs() < 0.5 {
            let contrast = c + 0.5 * (gx * ox + gy * oy + gs * os);
            return Some((xi as f32 + ox, yi as f32 + oy, si as f32 + os, contrast));
        }

        // Otherwise re-centre on the nearest sample and retry.
        if ox >  0.5 { x += 1; } else if ox < -0.5 { x -= 1; }
        if oy >  0.5 { y += 1; } else if oy < -0.5 { y -= 1; }
        if os >  0.5 { s += 1; } else if os < -0.5 { s -= 1; }

        if x < 1 || x >= w as i32 - 1
        || y < 1 || y >= h as i32 - 1
        || s < s_lo || s > s_hi {
            return None;
        }
    }
    None
}

fn sift_keypoints(gray: &[f32], width: usize, height: usize, contrast_threshold: f32) -> Vec<Kp> {
    let scales_per_octave = 3usize;
    let k        = 2f32.powf(1.0 / scales_per_octave as f32);
    let sigma0   = 1.6f32;
    let num_gauss = scales_per_octave + 3; // one extra on each end for clean DoG
    let max_octaves  = 5usize;
    let edge_threshold = 10.0f32;

    let mut kps = Vec::new();
    let mut cur = gray.to_vec();
    let mut w = width;
    let mut h = height;

    for octave in 0..max_octaves {
        if w < 16 || h < 16 { break; }

        let scale_factor = (1usize << octave) as f32;

        // Gaussian scale-space for this octave.
        let mut gauss: Vec<Vec<f32>> = Vec::with_capacity(num_gauss);
        for i in 0..num_gauss {
            let sigma = sigma0 * k.powi(i as i32);
            gauss.push(blur(&cur, w, h, sigma));
        }

        // Difference of Gaussians.
        let mut dog: Vec<Vec<f32>> = Vec::with_capacity(num_gauss - 1);
        for i in 0..num_gauss - 1 {
            let mut d = vec![0f32; w * h];
            for p in 0..w * h {
                d[p] = gauss[i + 1][p] - gauss[i][p];
            }
            dog.push(d);
        }

        // Scan interior DoG layers for scale-space extrema.
        for s in 1..dog.len() - 1 {
            for y in 1..h - 1 {
                for x in 1..w - 1 {
                    let v = dog[s][y * w + x];
                    if v.abs() < contrast_threshold { continue; }

                    // 26-neighbour extremum check.
                    let mut is_max = true;
                    let mut is_min = true;
                    'cmp: for ds in -1i32..=1 {
                        let layer = &dog[(s as i32 + ds) as usize];
                        for dy in -1i32..=1 {
                            for dx in -1i32..=1 {
                                if ds == 0 && dy == 0 && dx == 0 { continue; }
                                let nv = layer[((y as i32 + dy) as usize) * w
                                             + (x as i32 + dx) as usize];
                                if nv >= v { is_max = false; }
                                if nv <= v { is_min = false; }
                                if !is_max && !is_min { break 'cmp; }
                            }
                        }
                    }
                    if !(is_max || is_min) { continue; }

                    // Sub-pixel / sub-scale localization: fit a 3D quadratic to
                    // the DoG around the discrete extremum and solve for the
                    // true peak offset.
                    let (rx, ry, rs, contrast) = match refine_extremum(&dog, w, h, x, y, s) {
                        Some(r) => r,
                        None    => continue, // failed to converge inside the volume
                    };
                    // Low-contrast rejection on the *interpolated* DoG value.
                    if contrast.abs() < contrast_threshold { continue; }

                    // Edge-response rejection (2×2 spatial Hessian of the DoG).
                    let c   = dog[s][y * w + x];
                    let dxx = dog[s][y * w + x + 1] + dog[s][y * w + x - 1] - 2.0 * c;
                    let dyy = dog[s][(y + 1) * w + x] + dog[s][(y - 1) * w + x] - 2.0 * c;
                    let dxy = (dog[s][(y + 1) * w + x + 1] - dog[s][(y + 1) * w + x - 1]
                             - dog[s][(y - 1) * w + x + 1] + dog[s][(y - 1) * w + x - 1])
                             * 0.25;
                    let tr  = dxx + dyy;
                    let det = dxx * dyy - dxy * dxy;
                    if det <= 0.0 { continue; }
                    let r = edge_threshold;
                    if tr * tr / det >= (r + 1.0) * (r + 1.0) / r { continue; }

                    // Refined octave-local position and (fractional) scale.
                    let kx     = rx;
                    let ky     = ry;
                    let kscale = sigma0 * k.powf(rs);

                    let angle = compute_orientation(&gauss[s], w, h, kx, ky, kscale);
                    let desc  = compute_descriptor(&gauss[s], w, h, kx, ky, kscale, angle);

                    kps.push(Kp {
                        x:        kx * scale_factor,
                        y:        ky * scale_factor,
                        scale:    kscale * scale_factor,
                        response: contrast.abs(),
                        angle,
                        desc,
                    });
                }
            }
        }

        // Next octave's base is the octave's mid-point Gaussian, halved.
        let (ds, nw, nh) = downsample(&gauss[scales_per_octave], w, h);
        cur = ds;
        w   = nw;
        h   = nh;
    }

    kps
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_blobs() {
        let (w, h) = (96usize, 96usize);
        let mut rgba = vec![0u8; w * h * 4];
        for p in 0..w * h { rgba[p * 4 + 3] = 255; }

        for &(cx, cy, r) in &[(24usize, 24usize, 6usize), (64, 40, 4), (40, 70, 8)] {
            for y in cy - r..cy + r {
                for x in cx - r..cx + r {
                    let i = (y * w + x) * 4;
                    rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255;
                }
            }
        }

        let out = detect_sift(&rgba, w, h, 0.02, 1000);
        // Two trailing sentinels (raw_found, suppressed) ⇒ (len - 2) is a STRIDE multiple.
        assert_eq!((out.len() - 2) % STRIDE, 0, "output must be groups of {} + 2", STRIDE);
        let kept = (out.len() - 2) / STRIDE;
        assert!(kept > 0, "expected keypoints on blobs");
        let raw = out[out.len() - 2];
        let suppressed = out[out.len() - 1];
        assert!(raw >= kept as f32, "raw-found count must be ≥ kept count");
        assert!(suppressed >= 0.0, "suppressed count must be non-negative");

        // No two kept keypoints may sit within the dedup radius of each other.
        let kps: Vec<(f32, f32)> = out[..out.len() - 2]
            .chunks(STRIDE)
            .map(|c| (c[0], c[1]))
            .collect();
        for i in 0..kps.len() {
            for j in i + 1..kps.len() {
                let d = (kps[i].0 - kps[j].0).hypot(kps[i].1 - kps[j].1);
                assert!(d > DEDUP_RADIUS_PX, "kept keypoints {i},{j} within dedup radius: {d}");
            }
        }

        for chunk in out[..out.len() - 2].chunks(STRIDE) {
            assert!(chunk[0] >= 0.0 && chunk[0] < w as f32, "x out of bounds");
            assert!(chunk[1] >= 0.0 && chunk[1] < h as f32, "y out of bounds");
            assert!(chunk[3] > 0.0, "response should be positive");
            // Descriptor values should be in [0, 1] after normalisation.
            for &d in &chunk[5..] {
                assert!(d >= 0.0 && d <= 1.0001, "descriptor value out of range: {}", d);
            }
        }
    }

    #[test]
    fn empty_on_flat_image() {
        let (w, h) = (48usize, 48usize);
        let rgba = vec![128u8; w * h * 4];
        let out = detect_sift(&rgba, w, h, 0.03, 1000);
        // No extrema ⇒ just the two trailing sentinels (raw_found, suppressed), both 0.
        assert_eq!(out.len(), 2, "a flat image yields only the trailing sentinels");
        assert_eq!(out[0], 0.0, "raw-found count should be 0 on a flat image");
        assert_eq!(out[1], 0.0, "suppressed count should be 0 on a flat image");
    }
}
