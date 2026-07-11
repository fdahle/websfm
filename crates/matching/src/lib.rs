use wasm_bindgen::prelude::*;

// ─── Descriptor matching ──────────────────────────────────────────────────────

// Nearest-neighbour matching via the GEMM identity. The brute-force NN scan over
// every descriptor pair is the matcher's hot loop; expressing the squared-L2
// distance as
//     ‖a − b‖² = ‖a‖² + ‖b‖² − 2·(a·b)
// turns it into precomputed row norms plus a dot product. The dot is a branch-free
// multiply-add (no per-candidate early-exit test to mispredict), so it vectorises
// fully and register-blocks: four queries are matched against each database row at
// once, reusing that row's SIMD load across all four. Row norms are computed once.
// `dim` is the descriptor width — 128 (SIFT) / 256 (SuperPoint), both multiples of
// 4 so the f32x4 loop covers them; a non-multiple tail is handled scalar.
//
// The distance search runs in "s-space": s(a,b) = ‖b‖² − 2·(a·b), dropping the
// query norm ‖a‖² (a per-query constant that can't change which database row is
// nearest). ‖a‖² is added back only when materialising the true squared distance
// for the ratio test and the reported distance. Because this is a difference of
// larger magnitudes rather than a direct diff-square, it can round differently
// (and go slightly negative for near-identical rows — clamped to 0); as before,
// that only perturbs borderline ratio-test ties, which RANSAC then re-filters.

const BQ: usize = 4; // queries matched per database-row load (register blocking)

// ‖row‖² for each of `n` descriptor rows.
fn descriptor_norms(desc: &[f32], n: usize, dim: usize) -> Vec<f32> {
    let mut norms = vec![0.0f32; n];
    for (i, norm) in norms.iter_mut().enumerate() {
        let row = &desc[i * dim..(i + 1) * dim];
        *norm = row.iter().map(|&x| x * x).sum();
    }
    norms
}

#[cfg(target_feature = "simd128")]
#[inline]
fn hsum(v: core::arch::wasm32::v128) -> f32 {
    use core::arch::wasm32::*;
    f32x4_extract_lane::<0>(v) + f32x4_extract_lane::<1>(v)
        + f32x4_extract_lane::<2>(v) + f32x4_extract_lane::<3>(v)
}

// Fill `out[0..bq]` (bq ≤ BQ) with the dot products of each query row against `b`.
// SIMD path: the bq==BQ case reuses each `b` load across four accumulators.
#[cfg(target_feature = "simd128")]
fn dots_tile(qs: &[&[f32]], b: &[f32], dim: usize, out: &mut [f32]) {
    use core::arch::wasm32::*;
    let blocks = dim - dim % 4;
    // SAFETY: every `qs[t]` and `b` is a `dim`-float row; v128 loads stay within
    // `blocks` (≤ dim) and are unaligned-safe on wasm.
    if qs.len() == BQ {
        let (mut a0, mut a1, mut a2, mut a3) =
            (f32x4_splat(0.0), f32x4_splat(0.0), f32x4_splat(0.0), f32x4_splat(0.0));
        unsafe {
            let pb = b.as_ptr();
            let (p0, p1, p2, p3) =
                (qs[0].as_ptr(), qs[1].as_ptr(), qs[2].as_ptr(), qs[3].as_ptr());
            let mut k = 0usize;
            while k < blocks {
                let bv = v128_load(pb.add(k) as *const v128);
                a0 = f32x4_add(a0, f32x4_mul(v128_load(p0.add(k) as *const v128), bv));
                a1 = f32x4_add(a1, f32x4_mul(v128_load(p1.add(k) as *const v128), bv));
                a2 = f32x4_add(a2, f32x4_mul(v128_load(p2.add(k) as *const v128), bv));
                a3 = f32x4_add(a3, f32x4_mul(v128_load(p3.add(k) as *const v128), bv));
                k += 4;
            }
            out[0] = hsum(a0); out[1] = hsum(a1); out[2] = hsum(a2); out[3] = hsum(a3);
            while k < dim {
                let bk = b[k];
                out[0] += qs[0][k] * bk; out[1] += qs[1][k] * bk;
                out[2] += qs[2][k] * bk; out[3] += qs[3][k] * bk;
                k += 1;
            }
        }
        return;
    }
    // Remainder tile (1..BQ-1 queries): one branch-free SIMD dot each.
    for (t, &q) in qs.iter().enumerate() {
        let mut acc = f32x4_splat(0.0);
        unsafe {
            let (pq, pb) = (q.as_ptr(), b.as_ptr());
            let mut k = 0usize;
            while k < blocks {
                acc = f32x4_add(
                    acc,
                    f32x4_mul(v128_load(pq.add(k) as *const v128), v128_load(pb.add(k) as *const v128)),
                );
                k += 4;
            }
            let mut s = hsum(acc);
            while k < dim { s += q[k] * b[k]; k += 1; }
            out[t] = s;
        }
    }
}

// Scalar fallback (native `cargo test`/`cargo check`; no simd128 feature). Same
// math and tiling as the SIMD path, so the search/ratio logic is exercised here.
#[cfg(not(target_feature = "simd128"))]
fn dots_tile(qs: &[&[f32]], b: &[f32], dim: usize, out: &mut [f32]) {
    for (t, &q) in qs.iter().enumerate() {
        let mut s = 0.0f32;
        for k in 0..dim {
            s += q[k] * b[k];
        }
        out[t] = s;
    }
}

// Best/second nearest neighbour of every query against `db`, in s-space
// (s = ‖b‖² − 2·a·b). Returns per-query (best_idx, best_s, second_s). Queries are
// register-blocked in tiles of BQ; each tile streams the whole database once.
fn nn2_all(
    queries: &[f32],
    n_q: usize,
    db: &[f32],
    n_db: usize,
    dim: usize,
    norms_db: &[f32],
) -> (Vec<usize>, Vec<f32>, Vec<f32>) {
    let mut best_j = vec![0usize; n_q];
    let mut best_s = vec![f32::MAX; n_q];
    let mut second_s = vec![f32::MAX; n_q];
    let mut dots = [0.0f32; BQ];
    let mut qrefs: Vec<&[f32]> = Vec::with_capacity(BQ);

    let mut q0 = 0usize;
    while q0 < n_q {
        let bq = BQ.min(n_q - q0);
        qrefs.clear();
        for t in 0..bq {
            qrefs.push(&queries[(q0 + t) * dim..(q0 + t + 1) * dim]);
        }
        for j in 0..n_db {
            let brow = &db[j * dim..(j + 1) * dim];
            dots_tile(&qrefs, brow, dim, &mut dots[..bq]);
            let nb = norms_db[j];
            for t in 0..bq {
                let s = nb - 2.0 * dots[t];
                let qi = q0 + t;
                if s < best_s[qi] {
                    second_s[qi] = best_s[qi];
                    best_s[qi] = s;
                    best_j[qi] = j;
                } else if s < second_s[qi] {
                    second_s[qi] = s;
                }
            }
        }
        q0 += bq;
    }
    (best_j, best_s, second_s)
}

// Ratio-test survivors A→B: (best_j, dist, ok) per query, with the query norm
// folded back in to recover true squared distances for the comparison.
fn ratio_pass(
    queries: &[f32],
    n_q: usize,
    db: &[f32],
    n_db: usize,
    dim: usize,
    norms_q: &[f32],
    norms_db: &[f32],
    ratio_sq: f32,
) -> (Vec<usize>, Vec<f32>, Vec<bool>) {
    let (best_j, best_s, second_s) = nn2_all(queries, n_q, db, n_db, dim, norms_db);
    let mut ok = vec![false; n_q];
    let mut dist = vec![0.0f32; n_q];
    for i in 0..n_q {
        let d1 = (norms_q[i] + best_s[i]).max(0.0);
        let d2 = (norms_q[i] + second_s[i]).max(0.0);
        if d1 < ratio_sq * d2 {
            ok[i] = true;
            dist[i] = d1.sqrt();
        }
    }
    (best_j, dist, ok)
}

/// Match descriptors using Lowe's ratio test.
///
/// `desc_a` / `desc_b`: flat `Float32Array`s — one row of `dim` floats per keypoint
/// (`dim` = 128 for SIFT, 256 for SuperPoint). Returns flat `[idx_a, idx_b, dist,
/// ...]` triples as a `Float32Array`. `cross_check = true` requires mutual
/// nearest-neighbour consistency.
#[wasm_bindgen]
pub fn match_descriptors(
    desc_a: &[f32],
    desc_b: &[f32],
    dim: usize,
    ratio_threshold: f32,
    cross_check: bool,
) -> Vec<f32> {
    if dim == 0 {
        return vec![];
    }
    let n_a = desc_a.len() / dim;
    let n_b = desc_b.len() / dim;
    if n_a == 0 || n_b == 0 {
        return vec![];
    }
    let ratio_sq = ratio_threshold * ratio_threshold;
    let norms_a = descriptor_norms(desc_a, n_a, dim);
    let norms_b = descriptor_norms(desc_b, n_b, dim);

    // A → B
    let (fwd_j, fwd_d, fwd_ok) =
        ratio_pass(desc_a, n_a, desc_b, n_b, dim, &norms_a, &norms_b, ratio_sq);

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

    // B → A (only the argmin is needed for the mutual-consistency filter)
    let (bwd_i, _bwd_d, bwd_ok) =
        ratio_pass(desc_b, n_b, desc_a, n_a, dim, &norms_b, &norms_a, ratio_sq);

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

fn sample4(rng: &mut Xorshift, n: usize) -> [usize; 4] {
    let mut s = [0usize; 4];
    let mut k = 0;
    while k < 4 {
        let idx = rng.below(n);
        if s[..k].iter().all(|&x| x != idx) {
            s[k] = idx;
            k += 1;
        }
    }
    s
}

// Adaptive RANSAC stopping rule: the number of iterations needed to draw at least
// one all-inlier minimal sample with probability `p`, given inlier ratio `w` and
// sample size `s`:  N = ln(1−p) / ln(1−w^s). Returns `usize::MAX` when `w` is too
// small to bound the count (keep iterating up to the caller's cap); `1` once a
// single sample is essentially certain to be clean (`w^s ≈ 1`). A good pair with
// a high inlier ratio collapses this to well under 100 iterations.
fn adaptive_iters(w: f64, s: u32, p: f64) -> usize {
    if w <= 0.0 {
        return usize::MAX;
    }
    let ws = w.powi(s as i32);
    if ws >= 1.0 {
        return 1;
    }
    let denom = (1.0 - ws).ln();
    if denom >= 0.0 {
        return usize::MAX;
    }
    let n = (1.0 - p).ln() / denom;
    if !n.is_finite() || n < 0.0 {
        return usize::MAX;
    }
    (n.ceil() as usize).max(1)
}

// RANSAC confidence for the adaptive stop (probability of having sampled a clean
// minimal set). 0.99 is the COLMAP/OpenCV default.
const RANSAC_CONFIDENCE: f64 = 0.99;

fn ransac_fundamental(
    pa: &[(f64, f64)],
    pb: &[(f64, f64)],
    thresh_sq: f64,
    max_iters: usize,
) -> Option<(M3, Vec<bool>, usize)> {
    let n = pa.len().min(pb.len());
    if n < 8 {
        return None;
    }
    let mut rng = Xorshift::new(n as u32 * 1031 + 7);
    let mut best_count = 0usize;
    let mut best_mask = vec![false; n];
    let mut best_f: Option<M3> = None;

    // Adaptive termination: `limit` starts at the cap and shrinks as the best inlier
    // ratio improves. Monotone (best_count only grows), so recompute on each new best.
    let mut limit = max_iters;
    let mut iters = 0usize;
    while iters < limit {
        iters += 1;
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
            let w = best_count as f64 / n as f64;
            limit = max_iters.min(adaptive_iters(w, 8, RANSAC_CONFIDENCE));
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

    Some((f_ref, final_mask, iters))
}

// ─── Homography (4-point DLT + RANSAC) — H-vs-F degeneracy test ────────────────
// A homography explains a pair whose scene is planar or whose motion is a pure
// rotation. When H captures nearly as many inliers as F, the pair is degenerate
// for triangulation (a near-planar building façade, a spin-in-place). The ratio
// H_inliers / F_inliers is the signal COLMAP uses to down-rank such pairs as SfM
// seeds; we compute it here and let the store/reconstruction flag the pair.

// Inverse of a Hartley normalization matrix [[s,0,-s·cx],[0,s,-s·cy],[0,0,1]].
fn inv_norm_matrix(t: &M3) -> M3 {
    let s = t[0][0];
    let cx = -t[0][2] / s;
    let cy = -t[1][2] / s;
    [[1.0 / s, 0.0, cx], [0.0, 1.0 / s, cy], [0.0, 0.0, 1.0]]
}

// Homography H mapping pts_a → pts_b via the normalized DLT (2 rows/correspondence,
// null vector of AᵀA, then denormalized H = Tb⁻¹·Ĥ·Ta). Returns None if < 4 points.
fn homography_dlt(pts_a: &[(f64, f64)], pts_b: &[(f64, f64)]) -> Option<M3> {
    let n = pts_a.len().min(pts_b.len());
    if n < 4 {
        return None;
    }
    let ta = norm_matrix(pts_a);
    let tb = norm_matrix(pts_b);

    let mut ata = [[0.0f64; 9]; 9];
    for k in 0..n {
        let (x, y) = apply_t(&ta, pts_a[k]);
        let (xp, yp) = apply_t(&tb, pts_b[k]);
        let row1 = [-x, -y, -1.0, 0.0, 0.0, 0.0, xp * x, xp * y, xp];
        let row2 = [0.0, 0.0, 0.0, -x, -y, -1.0, yp * x, yp * y, yp];
        for i in 0..9 {
            for j in 0..9 {
                ata[i][j] += row1[i] * row1[j] + row2[i] * row2[j];
            }
        }
    }

    let v9 = jacobi_eig_9(&mut ata);
    let mut min_col = 0;
    for i in 1..9 {
        if ata[i][i] < ata[min_col][min_col] {
            min_col = i;
        }
    }
    let mut h_hat: M3 = [[0.0; 3]; 3];
    for r in 0..3 {
        for c in 0..3 {
            h_hat[r][c] = v9[r * 3 + c][min_col];
        }
    }
    Some(mat3_mul(inv_norm_matrix(&tb), mat3_mul(h_hat, ta)))
}

// Forward transfer squared error ‖(H·pa)_xy − pb‖² in pixel space — directly
// comparable to the Sampson threshold used for F inliers.
fn transfer_sq(h: &M3, pa: (f64, f64), pb: (f64, f64)) -> f64 {
    let hp = mat3_v(h, [pa.0, pa.1, 1.0]);
    if hp[2].abs() < 1e-12 {
        return 1e18;
    }
    let dx = hp[0] / hp[2] - pb.0;
    let dy = hp[1] / hp[2] - pb.1;
    dx * dx + dy * dy
}

// RANSAC homography; returns the best inlier count (the model itself is unused
// downstream — only the count feeds the H-vs-F degeneracy ratio).
fn ransac_homography(pa: &[(f64, f64)], pb: &[(f64, f64)], thresh_sq: f64, max_iters: usize) -> usize {
    let n = pa.len().min(pb.len());
    if n < 4 {
        return 0;
    }
    let mut rng = Xorshift::new(n as u32 * 2657 + 13);
    let mut best_count = 0usize;
    // Same adaptive stop as F-RANSAC, with the 4-point minimal-sample size.
    let mut limit = max_iters;
    let mut iters = 0usize;
    while iters < limit {
        iters += 1;
        let idx = sample4(&mut rng, n);
        let sub_a: Vec<_> = idx.iter().map(|&i| pa[i]).collect();
        let sub_b: Vec<_> = idx.iter().map(|&i| pb[i]).collect();
        let Some(h) = homography_dlt(&sub_a, &sub_b) else { continue };
        let mut count = 0;
        for i in 0..n {
            if transfer_sq(&h, pa[i], pb[i]) < thresh_sq {
                count += 1;
            }
        }
        if count > best_count {
            best_count = count;
            let w = best_count as f64 / n as f64;
            limit = max_iters.min(adaptive_iters(w, 4, RANSAC_CONFIDENCE));
        }
    }
    best_count
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

    let Some((f, mask, _iters)) = ransac_fundamental(&pa, &pb, thresh_sq, max_iters as usize) else {
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

/// Like `verify_matches`, but also fits a homography via RANSAC and reports its
/// inlier count so the caller can compute the H-vs-F degeneracy ratio.
///
/// `h_skip_below`: skip the (expensive) homography RANSAC entirely when the F
/// inlier count is below this value, reporting `h_inlier_count = 0`. The caller
/// MUST pass its own hard acceptance floor (`minMatches`): a pair below that floor
/// is rejected regardless of H, so its degeneracy label is never consulted, and the
/// H/F ratio of 0 (= "non-degenerate") can never mislabel a pair that survives.
/// Pass 0 (or ≤8) to disable the skip and reproduce the pre-adaptive behaviour.
///
/// Output layout: `[F00..F22, h_inlier_count, inlier_0, inlier_1, ...]` — the
/// fundamental matrix (9), then the homography inlier count (1), then the F
/// inlier flags (n). Empty if < 8 correspondences or RANSAC finds no F.
#[wasm_bindgen]
pub fn verify_matches_hf(
    pts_a: &[f32],
    pts_b: &[f32],
    ransac_thresh_px: f32,
    max_iters: u32,
    h_skip_below: u32,
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

    let Some((f, mask, _iters)) = ransac_fundamental(&pa, &pb, thresh_sq, max_iters as usize) else {
        return vec![];
    };
    // Skip H on a pair the caller will reject anyway (F inliers below its floor):
    // the H/F degeneracy label only matters for pairs that survive to seed SfM.
    let f_inliers = mask.iter().filter(|&&x| x).count();
    let h_inliers = if (f_inliers as u32) < h_skip_below {
        0
    } else {
        ransac_homography(&pa, &pb, thresh_sq, max_iters as usize)
    };

    let mut out = Vec::with_capacity(9 + 1 + n);
    for row in &f {
        for &v in row {
            out.push(v as f32);
        }
    }
    out.push(h_inliers as f32);
    for &flag in &mask {
        out.push(if flag { 1.0 } else { 0.0 });
    }
    out
}

// ─── Tests ────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    // Tiny deterministic LCG for reproducible synthetic scenes.
    struct Lcg(u64);
    impl Lcg {
        fn f(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((self.0 >> 33) as f64) / (1u64 << 31) as f64 // ∈ [0,1)
        }
        fn range(&mut self, a: f64, b: f64) -> f64 {
            a + (b - a) * self.f()
        }
    }

    fn roty(a: f64) -> M3 {
        [[a.cos(), 0.0, a.sin()], [0.0, 1.0, 0.0], [-a.sin(), 0.0, a.cos()]]
    }

    // Pinhole projection of a world point through (R, t) with focal f, principal c.
    fn proj(r: &M3, t: &V3, x: V3, f: f64, c: f64) -> (f64, f64) {
        let xc = mat3_v(r, x);
        let z = xc[2] + t[2];
        (f * (xc[0] + t[0]) / z + c, f * (xc[1] + t[1]) / z + c)
    }

    // Two-view scene: camera A at identity, camera B rotated + translated. `planar`
    // pins all points to one depth (near-planar → a homography fits the whole pair);
    // otherwise depth varies widely (general motion → no single homography fits).
    fn scene(planar: bool) -> (Vec<f32>, Vec<f32>) {
        let mut rng = Lcg(0x1234_5678);
        let ra: M3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let ta: V3 = [0.0, 0.0, 0.0];
        let rb = roty(0.12);
        let tb: V3 = [0.6, 0.0, 0.0];
        let (f, c) = (1000.0, 500.0);
        let (mut pa, mut pb) = (Vec::new(), Vec::new());
        for _ in 0..60 {
            let z = if planar { 6.0 + rng.range(-0.03, 0.03) } else { rng.range(3.0, 10.0) };
            let x: V3 = [rng.range(-2.0, 2.0), rng.range(-2.0, 2.0), z];
            let (ax, ay) = proj(&ra, &ta, x, f, c);
            let (bx, by) = proj(&rb, &tb, x, f, c);
            pa.push(ax as f32);
            pa.push(ay as f32);
            pb.push(bx as f32);
            pb.push(by as f32);
        }
        (pa, pb)
    }

    #[test]
    fn homography_dominates_on_planar_scene() {
        let (pa, pb) = scene(true);
        let out = verify_matches_hf(&pa, &pb, 2.0, 2000, 0);
        assert!(!out.is_empty(), "verification should succeed on a planar scene");
        let h = out[9];
        let f_inliers: f32 = out[10..].iter().sum();
        assert!(h / f_inliers > 0.9, "planar H/F ratio too low: {h} / {f_inliers}");
    }

    #[test]
    fn homography_underfits_general_scene() {
        let (pa, pb) = scene(false);
        let out = verify_matches_hf(&pa, &pb, 2.0, 2000, 0);
        assert!(!out.is_empty(), "verification should succeed on a general scene");
        let h = out[9];
        let f_inliers: f32 = out[10..].iter().sum();
        assert!(f_inliers > 40.0, "general F should fit most points: {f_inliers}");
        assert!(h / f_inliers < 0.8, "general H/F ratio too high: {h} / {f_inliers}");
    }

    // The adaptive-iters formula itself: high inlier ratio ⇒ tiny count; low ratio
    // ⇒ unbounded (fall back to the cap); saturated ratio ⇒ a single sample.
    #[test]
    fn adaptive_iters_shrinks_with_inlier_ratio() {
        // Clean pair (w=0.9, s=8): well under 100 iterations at 99% confidence.
        assert!(adaptive_iters(0.9, 8, 0.99) < 100);
        // Noisy pair (w=0.2, s=8): a huge finite count → clamped to the cap by the
        // caller (min(max_iters, …)), i.e. "keep going", never an early stop.
        assert!(adaptive_iters(0.2, 8, 0.99) > 100_000);
        // All inliers ⇒ one sample suffices; zero inliers ⇒ unbounded.
        assert_eq!(adaptive_iters(1.0, 8, 0.99), 1);
        assert_eq!(adaptive_iters(0.0, 8, 0.99), usize::MAX);
        // Monotone: a better ratio never needs more iterations.
        assert!(adaptive_iters(0.8, 8, 0.99) <= adaptive_iters(0.5, 8, 0.99));
    }

    // A high-inlier pair terminates in far fewer than max_iters, and its inlier set
    // is unchanged from a full-length run (adaptive stop only cuts wasted iterations).
    #[test]
    fn fundamental_terminates_early_on_clean_pair() {
        let (pa, pb) = scene(false); // general motion → most points are F inliers
        let n = pa.len() / 2;
        let a: Vec<(f64, f64)> =
            (0..n).map(|i| (pa[i * 2] as f64, pa[i * 2 + 1] as f64)).collect();
        let b: Vec<(f64, f64)> =
            (0..n).map(|i| (pb[i * 2] as f64, pb[i * 2 + 1] as f64)).collect();

        let (_, mask_cap, iters) = ransac_fundamental(&a, &b, 4.0, 5000).unwrap();
        assert!(iters < 200, "clean pair should stop early, took {iters} iters");
        // Same inlier set as a short run — adaptive stop is behaviour-preserving.
        let (_, mask_short, _) = ransac_fundamental(&a, &b, 4.0, iters.max(50)).unwrap();
        assert_eq!(mask_cap, mask_short, "adaptive stop changed the inlier set");
    }

    // ── Descriptor matching (GEMM kernel vs naive reference) ─────────────────

    fn random_descriptors(rng: &mut Lcg, n: usize, dim: usize) -> Vec<f32> {
        (0..n * dim).map(|_| rng.range(-1.0, 1.0) as f32).collect()
    }

    // Straightforward diff-square ratio-test matcher, the ground truth the GEMM
    // kernel must reproduce. Returns the sorted set of (i, j) matches.
    fn naive_match(
        a: &[f32], b: &[f32], dim: usize, ratio: f32, cross: bool,
    ) -> Vec<(usize, usize)> {
        let n_a = a.len() / dim;
        let n_b = b.len() / dim;
        let d2 = |x: &[f32], y: &[f32]| -> f32 {
            (0..dim).map(|k| (x[k] - y[k]) * (x[k] - y[k])).sum()
        };
        let nn2 = |q: &[f32], db: &[f32], n_db: usize| -> (usize, f32, f32) {
            let (mut bi, mut best, mut second) = (0usize, f32::MAX, f32::MAX);
            for j in 0..n_db {
                let d = d2(q, &db[j * dim..(j + 1) * dim]);
                if d < best { second = best; best = d; bi = j; }
                else if d < second { second = d; }
            }
            (bi, best, second)
        };
        let ratio_sq = ratio * ratio;
        let mut fwd = vec![None; n_a];
        for i in 0..n_a {
            let (j, d1, dd2) = nn2(&a[i * dim..(i + 1) * dim], b, n_b);
            if d1 < ratio_sq * dd2 { fwd[i] = Some(j); }
        }
        let mut out = Vec::new();
        if !cross {
            for i in 0..n_a {
                if let Some(j) = fwd[i] { out.push((i, j)); }
            }
        } else {
            let mut bwd = vec![None; n_b];
            for j in 0..n_b {
                let (i, d1, dd2) = nn2(&b[j * dim..(j + 1) * dim], a, n_a);
                if d1 < ratio_sq * dd2 { bwd[j] = Some(i); }
            }
            for i in 0..n_a {
                if let Some(j) = fwd[i] {
                    if bwd[j] == Some(i) { out.push((i, j)); }
                }
            }
        }
        out.sort_unstable();
        out
    }

    fn kernel_pairs(out: &[f32]) -> Vec<(usize, usize)> {
        let mut v: Vec<(usize, usize)> = out
            .chunks_exact(3)
            .map(|c| (c[0] as usize, c[1] as usize))
            .collect();
        v.sort_unstable();
        v
    }

    // On continuous random descriptors (ties are measure-zero), the GEMM kernel
    // must produce exactly the same match set as the naive diff-square matcher —
    // across cross-check on/off and a `dim` with a non-multiple-of-4 tail.
    #[test]
    fn match_descriptors_agrees_with_naive() {
        let mut rng = Lcg(0xC0FFEE);
        for &dim in &[128usize, 130, 8] {
            let a = random_descriptors(&mut rng, 37, dim);
            let b = random_descriptors(&mut rng, 41, dim);
            for &cross in &[false, true] {
                let got = kernel_pairs(&match_descriptors(&a, &b, dim, 0.8, cross));
                let want = naive_match(&a, &b, dim, 0.8, cross);
                assert_eq!(got, want, "dim={dim} cross={cross}");
            }
        }
    }

    // Reported distances are the true L2 (√ of squared) to each matched row.
    #[test]
    fn match_descriptors_reports_l2_distance() {
        let dim = 16;
        // Two A rows; B row 0 equals A row 0 (dist 0), B row 1 offset from A row 1.
        let a: Vec<f32> = (0..2 * dim).map(|k| (k % dim) as f32).collect();
        let mut b = a.clone();
        for k in 0..dim { b[dim + k] += 3.0; } // B row 1 = A row 1 + 3 per dim
        let out = match_descriptors(&a, &b, dim, 0.99, false);
        let pairs = kernel_pairs(&out);
        assert!(pairs.contains(&(0, 0)), "identical row should match itself");
        // Find the (0,0) triple and confirm distance ≈ 0.
        for c in out.chunks_exact(3) {
            if c[0] as usize == 0 && c[1] as usize == 0 {
                assert!(c[2].abs() < 1e-3, "self-match distance should be ~0, got {}", c[2]);
            }
        }
    }

    // h_skip_below suppresses the homography count once F inliers fall below the
    // floor, and leaves it intact above the floor.
    #[test]
    fn h_skip_below_suppresses_homography_on_weak_pairs() {
        let (pa, pb) = scene(true); // planar → strong H
        let full = verify_matches_hf(&pa, &pb, 2.0, 2000, 0);
        let f_inliers: f32 = full[10..].iter().sum();
        assert!(full[9] > 0.0, "baseline H should be non-zero on a planar pair");

        // Floor just above this pair's F-inlier count ⇒ H skipped ⇒ reported 0.
        let skipped = verify_matches_hf(&pa, &pb, 2.0, 2000, f_inliers as u32 + 1);
        assert_eq!(skipped[9], 0.0, "H should be skipped below the floor");
        // F side is untouched by the skip.
        assert_eq!(&skipped[10..], &full[10..], "skip must not affect F inliers");

        // Floor at/below the count ⇒ H still computed.
        let kept = verify_matches_hf(&pa, &pb, 2.0, 2000, f_inliers as u32);
        assert!(kept[9] > 0.0, "H should run when F inliers meet the floor");
    }
}
