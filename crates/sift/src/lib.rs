//! Minimal SIFT keypoint detector for the browser.
//!
//! This implements the *detection* half of SIFT (the Difference-of-Gaussians
//! scale-space extrema, with contrast and edge-response rejection). Orientation
//! assignment and the 128-d descriptor are intentionally left out for now — they
//! come when we add feature *matching*. The goal here is: find tie-point
//! candidates and visualize them.
//!
//! Input is raw RGBA bytes (as produced by a canvas `getImageData`), so the
//! WASM module needs no image decoder and stays tiny.

use wasm_bindgen::prelude::*;

/// Detect SIFT keypoints.
///
/// Returns a flat `Float32Array` with 4 values per keypoint:
/// `[x, y, scale, response, x, y, scale, response, ...]`
/// where `x`/`y` are in input-image pixel coordinates.
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
    let mut kps = sift_keypoints(&gray, width, height, contrast_threshold);

    // Strongest responses first, then cap the count.
    kps.sort_by(|a, b| b.response.partial_cmp(&a.response).unwrap_or(std::cmp::Ordering::Equal));
    if max_keypoints > 0 && kps.len() > max_keypoints {
        kps.truncate(max_keypoints);
    }

    let mut out = Vec::with_capacity(kps.len() * 4);
    for k in kps {
        out.push(k.x);
        out.push(k.y);
        out.push(k.scale);
        out.push(k.response);
    }
    out
}

struct Kp {
    x: f32,
    y: f32,
    scale: f32,
    response: f32,
}

fn to_gray(rgba: &[u8], w: usize, h: usize) -> Vec<f32> {
    let mut g = vec![0f32; w * h];
    for i in 0..w * h {
        let r = rgba[i * 4] as f32;
        let gr = rgba[i * 4 + 1] as f32;
        let b = rgba[i * 4 + 2] as f32;
        // Rec. 601 luma, normalized to [0, 1].
        g[i] = (0.299 * r + 0.587 * gr + 0.114 * b) / 255.0;
    }
    g
}

fn clampi(v: i32, lo: i32, hi: i32) -> i32 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let radius = (3.0 * sigma).ceil().max(1.0) as i32;
    let mut k = Vec::with_capacity((2 * radius + 1) as usize);
    let mut sum = 0.0f32;
    for i in -radius..=radius {
        let v = (-((i * i) as f32) / (2.0 * sigma * sigma)).exp();
        k.push(v);
        sum += v;
    }
    for v in k.iter_mut() {
        *v /= sum;
    }
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

fn sift_keypoints(gray: &[f32], width: usize, height: usize, contrast_threshold: f32) -> Vec<Kp> {
    let scales_per_octave = 3usize;
    let k = 2f32.powf(1.0 / scales_per_octave as f32);
    let sigma0 = 1.6f32;
    let num_gauss = scales_per_octave + 3; // -> (num_gauss - 1) DoG layers
    let max_octaves = 5usize;
    let edge_threshold = 10.0f32;

    let mut kps = Vec::new();

    let mut cur = gray.to_vec();
    let mut w = width;
    let mut h = height;
    let mut octave = 0usize;

    while octave < max_octaves && w >= 16 && h >= 16 {
        // Gaussian scale space for this octave.
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

        // Scan the interior DoG layers for scale-space extrema.
        let scale_factor = (1usize << octave) as f32;
        for s in 1..dog.len() - 1 {
            for y in 1..h - 1 {
                for x in 1..w - 1 {
                    let v = dog[s][y * w + x];
                    if v.abs() < contrast_threshold {
                        continue;
                    }

                    // Compare against the 26 spatial+scale neighbors.
                    let mut is_max = true;
                    let mut is_min = true;
                    'cmp: for ds in -1i32..=1 {
                        let layer = &dog[(s as i32 + ds) as usize];
                        for dy in -1i32..=1 {
                            for dx in -1i32..=1 {
                                if ds == 0 && dy == 0 && dx == 0 {
                                    continue;
                                }
                                let nv = layer[((y as i32 + dy) as usize) * w
                                    + (x as i32 + dx) as usize];
                                if nv >= v {
                                    is_max = false;
                                }
                                if nv <= v {
                                    is_min = false;
                                }
                                if !is_max && !is_min {
                                    break 'cmp;
                                }
                            }
                        }
                    }
                    if !(is_max || is_min) {
                        continue;
                    }

                    // Reject edge responses using the 2x2 Hessian of the DoG.
                    let c = dog[s][y * w + x];
                    let dxx = dog[s][y * w + x + 1] + dog[s][y * w + x - 1] - 2.0 * c;
                    let dyy = dog[s][(y + 1) * w + x] + dog[s][(y - 1) * w + x] - 2.0 * c;
                    let dxy = (dog[s][(y + 1) * w + x + 1] - dog[s][(y + 1) * w + x - 1]
                        - dog[s][(y - 1) * w + x + 1]
                        + dog[s][(y - 1) * w + x - 1])
                        * 0.25;
                    let tr = dxx + dyy;
                    let det = dxx * dyy - dxy * dxy;
                    if det <= 0.0 {
                        continue;
                    }
                    let r = edge_threshold;
                    if tr * tr / det >= (r + 1.0) * (r + 1.0) / r {
                        continue;
                    }

                    kps.push(Kp {
                        x: x as f32 * scale_factor,
                        y: y as f32 * scale_factor,
                        scale: sigma0 * k.powi(s as i32) * scale_factor,
                        response: v.abs(),
                    });
                }
            }
        }

        // Next octave starts from the gaussian at the base sigma, halved.
        let (ds, nw, nh) = downsample(&gauss[scales_per_octave], w, h);
        cur = ds;
        w = nw;
        h = nh;
        octave += 1;
    }

    kps
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A few bright blobs on a dark field should yield keypoints near them.
    #[test]
    fn detects_blobs() {
        let (w, h) = (96usize, 96usize);
        let mut rgba = vec![0u8; w * h * 4];
        for p in 0..w * h {
            rgba[p * 4 + 3] = 255; // opaque
        }
        // Paint three filled squares of different sizes.
        let blobs = [(24usize, 24usize, 6usize), (64, 40, 4), (40, 70, 8)];
        for &(cx, cy, r) in &blobs {
            for y in cy - r..cy + r {
                for x in cx - r..cx + r {
                    let i = (y * w + x) * 4;
                    rgba[i] = 255;
                    rgba[i + 1] = 255;
                    rgba[i + 2] = 255;
                }
            }
        }

        let out = detect_sift(&rgba, w, h, 0.02, 1000);
        assert_eq!(out.len() % 4, 0, "output must be groups of 4");
        assert!(!out.is_empty(), "expected some keypoints on blobs");

        // Every keypoint should sit inside the image bounds.
        for chunk in out.chunks(4) {
            assert!(chunk[0] >= 0.0 && chunk[0] < w as f32);
            assert!(chunk[1] >= 0.0 && chunk[1] < h as f32);
            assert!(chunk[3] > 0.0, "response should be positive");
        }
    }

    #[test]
    fn empty_on_flat_image() {
        let (w, h) = (48usize, 48usize);
        let rgba = vec![128u8; w * h * 4];
        let out = detect_sift(&rgba, w, h, 0.03, 1000);
        assert!(out.is_empty(), "a flat image has no extrema");
    }
}
