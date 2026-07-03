use wasm_bindgen::prelude::*;

const DESC: usize = 128;

// ─── Descriptor matching ──────────────────────────────────────────────────────

// Squared-L2 distance between two 128-d descriptors, exiting early once the
// partial sum already exceeds `limit` (safe for the ratio test, where `limit` is
// the current second-best). The brute-force NN scan over every pair of
// descriptors is the matcher's hot loop, so this is the function to vectorise.

// SIMD path: 128 dims = 4 blocks of 32 (8× f32x4). Accumulate squared diffs in a
// vector, fold to scalar after each block, and bail when the running distance
// crosses `limit`. Four early-exit checkpoints instead of the scalar path's
// per-element check — far fewer instructions per element, at the cost of letting
// a doomed candidate run up to 31 extra dims before bailing. Summation order
// differs from the scalar path, so distances can differ by float rounding; that
// only matters for borderline ratio-test ties, which RANSAC then re-filters.
#[cfg(target_feature = "simd128")]
fn l2_sq_early(a: &[f32], b: &[f32], limit: f32) -> f32 {
    use core::arch::wasm32::*;
    let mut d = 0.0f32;
    // SAFETY: callers always pass full 128-float descriptor rows; wasm v128 loads
    // are unaligned-safe (alignment is only a hint in the wasm spec).
    unsafe {
        let (pa, pb) = (a.as_ptr(), b.as_ptr());
        let mut k = 0usize;
        while k < DESC {
            let mut acc = f32x4_splat(0.0);
            let block_end = k + 32;
            while k < block_end {
                let diff = f32x4_sub(
                    v128_load(pa.add(k) as *const v128),
                    v128_load(pb.add(k) as *const v128),
                );
                acc = f32x4_add(acc, f32x4_mul(diff, diff));
                k += 4;
            }
            d += f32x4_extract_lane::<0>(acc) + f32x4_extract_lane::<1>(acc)
               + f32x4_extract_lane::<2>(acc) + f32x4_extract_lane::<3>(acc);
            if d >= limit {
                return d;
            }
        }
    }
    d
}

// Scalar fallback for non-SIMD targets (e.g. native `cargo test`/`cargo check`).
#[cfg(not(target_feature = "simd128"))]
fn l2_sq_early(a: &[f32], b: &[f32], limit: f32) -> f32 {
    let mut d = 0.0f32;
    for k in 0..DESC {
        d += (a[k] - b[k]) * (a[k] - b[k]);
        if d >= limit {
            return d;
        }
    }
    d
}

// Returns (best_idx, best_sq, second_sq) for descriptor q against database db.
fn nn2(q: &[f32], db: &[f32], n_db: usize) -> (usize, f32, f32) {
    let mut best_i = 0;
    let mut best = f32::MAX;
    let mut second = f32::MAX;
    for j in 0..n_db {
        let d = l2_sq_early(q, &db[j * DESC..(j + 1) * DESC], second);
        if d < best {
            second = best;
            best = d;
            best_i = j;
        } else if d < second {
            second = d;
        }
    }
    (best_i, best, second)
}

/// Match 128-d SIFT descriptors using Lowe's ratio test.
///
/// `desc_a` / `desc_b`: flat `Float32Array`s — one row of 128 floats per keypoint.
/// Returns flat `[idx_a, idx_b, dist, ...]` triples as a `Float32Array`.
/// `cross_check = true` requires mutual nearest-neighbour consistency.
#[wasm_bindgen]
pub fn match_descriptors(
    desc_a: &[f32],
    desc_b: &[f32],
    ratio_threshold: f32,
    cross_check: bool,
) -> Vec<f32> {
    let n_a = desc_a.len() / DESC;
    let n_b = desc_b.len() / DESC;
    if n_a == 0 || n_b == 0 {
        return vec![];
    }
    let ratio_sq = ratio_threshold * ratio_threshold;

    // A → B
    let mut fwd_j = vec![0usize; n_a];
    let mut fwd_d = vec![0.0f32; n_a];
    let mut fwd_ok = vec![false; n_a];
    for i in 0..n_a {
        let (j, d1, d2) = nn2(&desc_a[i * DESC..(i + 1) * DESC], desc_b, n_b);
        if d1 < ratio_sq * d2 {
            fwd_j[i] = j;
            fwd_d[i] = d1.sqrt();
            fwd_ok[i] = true;
        }
    }

    if !cross_check {
        let mut out = Vec::new();
        for i in 0..n_a {
            if fwd_ok[i] {
                out.push(i as f32);
                out.push(fwd_j[i] as f32);
                out.push(fwd_d[i]);
            }
        }
        return out;
    }

    // B → A
    let mut bwd_i = vec![0usize; n_b];
    let mut bwd_ok = vec![false; n_b];
    for j in 0..n_b {
        let (i, d1, d2) = nn2(&desc_b[j * DESC..(j + 1) * DESC], desc_a, n_a);
        if d1 < ratio_sq * d2 {
            bwd_i[j] = i;
            bwd_ok[j] = true;
        }
    }

    // Mutual NN filter
    let mut out = Vec::new();
    for i in 0..n_a {
        if fwd_ok[i] {
            let j = fwd_j[i];
            if bwd_ok[j] && bwd_i[j] == i {
                out.push(i as f32);
                out.push(j as f32);
                out.push(fwd_d[i]);
            }
        }
    }
    out
}

// ─── Linear algebra (f64 for numerical stability) ────────────────────────────

type M3 = [[f64; 3]; 3];
type V3 = [f64; 3];

fn mat3_mul(a: M3, b: M3) -> M3 {
    let mut c = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                c[i][j] += a[i][k] * b[k][j];
            }
        }
    }
    c
}

fn mat3_t(a: M3) -> M3 {
    let mut b = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            b[i][j] = a[j][i];
        }
    }
    b
}

fn mat3_v(a: &M3, v: V3) -> V3 {
    [
        a[0][0] * v[0] + a[0][1] * v[1] + a[0][2] * v[2],
        a[1][0] * v[0] + a[1][1] * v[1] + a[1][2] * v[2],
        a[2][0] * v[0] + a[2][1] * v[1] + a[2][2] * v[2],
    ]
}

fn dot3(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Jacobi symmetric eigendecomposition — generated for N=3 and N=9.
/// Modifies `a` in-place (becomes diagonal, eigenvalues on diagonal).
/// Returns eigenvector matrix V (column k = eigenvector for eigenvalue a[k][k]).
macro_rules! make_jacobi {
    ($name:ident, $n:expr) => {
        fn $name(a: &mut [[f64; $n]; $n]) -> [[f64; $n]; $n] {
            let mut v = [[0.0f64; $n]; $n];
            for i in 0..$n {
                v[i][i] = 1.0;
            }
            'sweep: for _ in 0..200 {
                let mut max_off = 0.0f64;
                for i in 0..$n {
                    for j in (i + 1)..$n {
                        let x = a[i][j].abs();
                        if x > max_off {
                            max_off = x;
                        }
                    }
                }
                if max_off < 1e-14 {
                    break 'sweep;
                }
                for p in 0..$n {
                    for q in (p + 1)..$n {
                        let apq = a[p][q];
                        if apq.abs() < 1e-15 {
                            continue;
                        }
                        let tau = (a[q][q] - a[p][p]) / (2.0 * apq);
                        let t = if tau >= 0.0 {
                            1.0 / (tau + (1.0 + tau * tau).sqrt())
                        } else {
                            -1.0 / (-tau + (1.0 + tau * tau).sqrt())
                        };
                        let c = 1.0 / (1.0 + t * t).sqrt();
                        let s = t * c;
                        a[p][p] -= t * apq;
                        a[q][q] += t * apq;
                        a[p][q] = 0.0;
                        a[q][p] = 0.0;
                        for r in 0..$n {
                            if r == p || r == q {
                                continue;
                            }
                            let arp = a[r][p];
                            let arq = a[r][q];
                            a[r][p] = c * arp - s * arq;
                            a[p][r] = a[r][p];
                            a[r][q] = s * arp + c * arq;
                            a[q][r] = a[r][q];
                        }
                        for r in 0..$n {
                            let vrp = v[r][p];
                            let vrq = v[r][q];
                            v[r][p] = c * vrp - s * vrq;
                            v[r][q] = s * vrp + c * vrq;
                        }
                    }
                }
            }
            v
        }
    };
}

make_jacobi!(jacobi_eig_3, 3);
make_jacobi!(jacobi_eig_9, 9);

/// Enforce rank-2 on a 3×3 matrix by zeroing the smallest singular value.
fn enforce_rank2(f: M3) -> M3 {
    let mut ftf = mat3_mul(mat3_t(f), f);
    let v3 = jacobi_eig_3(&mut ftf);
    let eig = [ftf[0][0], ftf[1][1], ftf[2][2]];

    // Sort indices descending by eigenvalue (bubble sort on 3 elements)
    let mut ord = [0usize, 1, 2];
    if eig[ord[0]] < eig[ord[1]] { ord.swap(0, 1); }
    if eig[ord[1]] < eig[ord[2]] { ord.swap(1, 2); }
    if eig[ord[0]] < eig[ord[1]] { ord.swap(0, 1); }

    // F_rank2 = sv_0 * u_0 * v_0^T + sv_1 * u_1 * v_1^T  (sv_2 := 0)
    let mut result = [[0.0f64; 3]; 3];
    for k in 0..2 {
        let sv = eig[ord[k]].max(0.0).sqrt();
        if sv < 1e-10 {
            continue;
        }
        let vk: V3 = [v3[0][ord[k]], v3[1][ord[k]], v3[2][ord[k]]];
        let u_raw = mat3_v(&f, vk);
        let uk: V3 = [u_raw[0] / sv, u_raw[1] / sv, u_raw[2] / sv];
        for i in 0..3 {
            for j in 0..3 {
                result[i][j] += sv * uk[i] * vk[j];
            }
        }
    }
    result
}

// ─── Fundamental matrix (8-point algorithm) ───────────────────────────────────

// Hartley normalization: translate to centroid, scale so avg distance = sqrt(2).
fn norm_matrix(pts: &[(f64, f64)]) -> M3 {
    let n = pts.len() as f64;
    let cx = pts.iter().map(|p| p.0).sum::<f64>() / n;
    let cy = pts.iter().map(|p| p.1).sum::<f64>() / n;
    let avg_d = pts
        .iter()
        .map(|p| {
            let dx = p.0 - cx;
            let dy = p.1 - cy;
            (dx * dx + dy * dy).sqrt()
        })
        .sum::<f64>()
        / n;
    let s = 2.0f64.sqrt() / avg_d.max(1e-10);
    [[s, 0.0, -s * cx], [0.0, s, -s * cy], [0.0, 0.0, 1.0]]
}

fn apply_t(t: &M3, p: (f64, f64)) -> (f64, f64) {
    (
        t[0][0] * p.0 + t[0][1] * p.1 + t[0][2],
        t[1][0] * p.0 + t[1][1] * p.1 + t[1][2],
    )
}

fn fundamental_8pt(pts_a: &[(f64, f64)], pts_b: &[(f64, f64)]) -> Option<M3> {
    let n = pts_a.len().min(pts_b.len());
    if n < 8 {
        return None;
    }
    let ta = norm_matrix(pts_a);
    let tb = norm_matrix(pts_b);

    // Build A^T * A where each row of A is [x2x1, x2y1, x2, y2x1, y2y1, y2, x1, y1, 1]
    let mut ata = [[0.0f64; 9]; 9];
    for k in 0..n {
        let (x1, y1) = apply_t(&ta, pts_a[k]);
        let (x2, y2) = apply_t(&tb, pts_b[k]);
        let row = [x2 * x1, x2 * y1, x2, y2 * x1, y2 * y1, y2, x1, y1, 1.0];
        for i in 0..9 {
            for j in 0..9 {
                ata[i][j] += row[i] * row[j];
            }
        }
    }

    let v9 = jacobi_eig_9(&mut ata);

    // Null vector = eigenvector of A^T*A with smallest eigenvalue
    let mut min_col = 0;
    for i in 1..9 {
        if ata[i][i] < ata[min_col][min_col] {
            min_col = i;
        }
    }

    let mut f_hat: M3 = [[0.0; 3]; 3];
    for r in 0..3 {
        for c in 0..3 {
            f_hat[r][c] = v9[r * 3 + c][min_col];
        }
    }

    // Enforce rank-2, then denormalize: F = Tb^T * F_hat * Ta
    Some(mat3_mul(mat3_t(tb), mat3_mul(enforce_rank2(f_hat), ta)))
}

// Squared Sampson (symmetric epipolar) distance.
fn sampson_sq(f: &M3, pa: (f64, f64), pb: (f64, f64)) -> f64 {
    let x1: V3 = [pa.0, pa.1, 1.0];
    let x2: V3 = [pb.0, pb.1, 1.0];
    let fx1 = mat3_v(f, x1);
    let ftx2 = mat3_v(&mat3_t(*f), x2);
    let num = dot3(x2, fx1);
    let den = fx1[0] * fx1[0] + fx1[1] * fx1[1] + ftx2[0] * ftx2[0] + ftx2[1] * ftx2[1];
    if den < 1e-14 {
        return 1e18;
    }
    num * num / den
}

// ─── RANSAC ───────────────────────────────────────────────────────────────────

struct Xorshift {
    state: u32,
}

impl Xorshift {
    fn new(seed: u32) -> Self {
        Self { state: if seed == 0 { 0x9e3779b9 } else { seed } }
    }
    fn next(&mut self) -> u32 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.state = x;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() as usize) % n
    }
}

fn sample8(rng: &mut Xorshift, n: usize) -> [usize; 8] {
    let mut s = [0usize; 8];
    let mut k = 0;
    while k < 8 {
        let idx = rng.below(n);
        if s[..k].iter().all(|&x| x != idx) {
            s[k] = idx;
            k += 1;
        }
    }
    s
}

fn ransac_fundamental(
    pa: &[(f64, f64)],
    pb: &[(f64, f64)],
    thresh_sq: f64,
    max_iters: usize,
) -> Option<(M3, Vec<bool>)> {
    let n = pa.len().min(pb.len());
    if n < 8 {
        return None;
    }
    let mut rng = Xorshift::new(n as u32 * 1031 + 7);
    let mut best_count = 0usize;
    let mut best_mask = vec![false; n];
    let mut best_f: Option<M3> = None;

    for _ in 0..max_iters {
        let idx = sample8(&mut rng, n);
        let sub_a: Vec<_> = idx.iter().map(|&i| pa[i]).collect();
        let sub_b: Vec<_> = idx.iter().map(|&i| pb[i]).collect();
        let Some(f) = fundamental_8pt(&sub_a, &sub_b) else { continue };

        let mut mask = vec![false; n];
        let mut count = 0;
        for i in 0..n {
            if sampson_sq(&f, pa[i], pb[i]) < thresh_sq {
                mask[i] = true;
                count += 1;
            }
        }

        if count > best_count {
            best_count = count;
            best_mask = mask;
            best_f = Some(f);
        }
    }

    if best_count < 8 {
        return None;
    }

    // Refit F on the full inlier set for a better estimate
    let pa_in: Vec<_> = (0..n).filter(|&i| best_mask[i]).map(|i| pa[i]).collect();
    let pb_in: Vec<_> = (0..n).filter(|&i| best_mask[i]).map(|i| pb[i]).collect();
    let f_ref = fundamental_8pt(&pa_in, &pb_in).or(best_f)?;

    let final_mask: Vec<bool> = (0..n)
        .map(|i| sampson_sq(&f_ref, pa[i], pb[i]) < thresh_sq)
        .collect();
    let final_count = final_mask.iter().filter(|&&x| x).count();
    if final_count < 8 {
        return None;
    }

    Some((f_ref, final_mask))
}

// ─── Exported WASM API ────────────────────────────────────────────────────────

/// RANSAC fundamental matrix estimation on a set of putative matches.
///
/// `pts_a` / `pts_b`: flat `[x0, y0, x1, y1, ...]` pixel coordinates.
/// Returns `[F00..F22, inlier_0, inlier_1, ...]` — first 9 values are the fundamental
/// matrix (row-major, f32), the rest are 1.0/0.0 inlier flags.
/// Returns empty if < 8 correspondences or RANSAC finds no valid solution.
#[wasm_bindgen]
pub fn verify_matches(
    pts_a: &[f32],
    pts_b: &[f32],
    ransac_thresh_px: f32,
    max_iters: u32,
) -> Vec<f32> {
    let n = pts_a.len() / 2;
    if n != pts_b.len() / 2 || n < 8 {
        return vec![];
    }
    let pa: Vec<(f64, f64)> =
        (0..n).map(|i| (pts_a[i * 2] as f64, pts_a[i * 2 + 1] as f64)).collect();
    let pb: Vec<(f64, f64)> =
        (0..n).map(|i| (pts_b[i * 2] as f64, pts_b[i * 2 + 1] as f64)).collect();
    let thresh_sq = (ransac_thresh_px as f64).powi(2);

    let Some((f, mask)) = ransac_fundamental(&pa, &pb, thresh_sq, max_iters as usize) else {
        return vec![];
    };

    let mut out = Vec::with_capacity(9 + n);
    for row in &f {
        for &v in row {
            out.push(v as f32);
        }
    }
    for &flag in &mask {
        out.push(if flag { 1.0 } else { 0.0 });
    }
    out
}
