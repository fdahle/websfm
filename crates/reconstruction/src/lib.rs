use wasm_bindgen::prelude::*;

// ── Types ─────────────────────────────────────────────────────────────────────
type M3 = [[f64; 3]; 3];
type M34 = [[f64; 4]; 3]; // 3×4 projection matrix
type V3 = [f64; 3];

// ── Basic linear algebra ──────────────────────────────────────────────────────

fn mat3_mul(a: &M3, b: &M3) -> M3 {
    let mut c = [[0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                c[i][j] += a[i][k] * b[k][j];
            }
        }
    }
    c
}

fn mat3_transpose(a: &M3) -> M3 {
    let mut t = [[0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            t[i][j] = a[j][i];
        }
    }
    t
}

fn mat3_vec(m: &M3, v: &V3) -> V3 {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn dot3(a: &V3, b: &V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross3(a: &V3, b: &V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn norm3(v: &V3) -> f64 {
    dot3(v, v).sqrt()
}

fn normalize3(v: &V3) -> V3 {
    let n = norm3(v);
    if n < 1e-12 { return [0.0, 0.0, 1.0]; }
    [v[0] / n, v[1] / n, v[2] / n]
}

// Build 3×4 from rotation (row-major 9 floats) and translation (3 floats).
fn make_p34(r: &M3, t: &V3) -> M34 {
    [
        [r[0][0], r[0][1], r[0][2], t[0]],
        [r[1][0], r[1][1], r[1][2], t[1]],
        [r[2][0], r[2][1], r[2][2], t[2]],
    ]
}

// Project world point X via K * P (K is embedded as [fx,0,cx; 0,fy,cy; 0,0,1]).
fn project(p: &M34, fx: f64, fy: f64, cx: f64, cy: f64, x: &V3) -> (f64, f64) {
    let xc = p[0][0] * x[0] + p[0][1] * x[1] + p[0][2] * x[2] + p[0][3];
    let yc = p[1][0] * x[0] + p[1][1] * x[1] + p[1][2] * x[2] + p[1][3];
    let zc = p[2][0] * x[0] + p[2][1] * x[1] + p[2][2] * x[2] + p[2][3];
    if zc.abs() < 1e-12 { return (f64::NAN, f64::NAN); }
    (fx * xc / zc + cx, fy * yc / zc + cy)
}

// Depth of world point X in camera P (unsigned).
fn depth_in_camera(p: &M34, x: &V3) -> f64 {
    p[2][0] * x[0] + p[2][1] * x[1] + p[2][2] * x[2] + p[2][3]
}

// ── Jacobi eigendecomposition for symmetric N×N matrices ─────────────────────
// Adapted from the matching crate. Returns (eigenvalues, eigenvectors as columns).

macro_rules! make_jacobi {
    ($name:ident, $n:expr) => {
        fn $name(a: &mut [[f64; $n]; $n]) -> [[f64; $n]; $n] {
            let mut v = [[0f64; $n]; $n];
            for i in 0..$n { v[i][i] = 1.0; }
            for _ in 0..200 {
                let mut max_off = 0f64;
                let (mut p, mut q) = (0, 1);
                for i in 0..$n {
                    for j in (i + 1)..$n {
                        let a_ij = a[i][j].abs();
                        if a_ij > max_off { max_off = a_ij; p = i; q = j; }
                    }
                }
                if max_off < 1e-14 { break; }
                let theta = 0.5 * (a[q][q] - a[p][p]) / a[p][q];
                let t = if theta >= 0.0 {
                    1.0 / (theta + (1.0 + theta * theta).sqrt())
                } else {
                    -1.0 / (-theta + (1.0 + theta * theta).sqrt())
                };
                let c = 1.0 / (1.0 + t * t).sqrt();
                let s = t * c;
                let tau = s / (1.0 + c);
                // Update a
                let apq = a[p][q];
                a[p][q] = 0.0; a[q][p] = 0.0;
                a[p][p] -= t * apq; a[q][q] += t * apq;
                for r in 0..$n {
                    if r == p || r == q { continue; }
                    let arp = a[r][p]; let arq = a[r][q];
                    a[r][p] = arp - s * (arq + tau * arp);
                    a[p][r] = a[r][p];
                    a[r][q] = arq + s * (arp - tau * arq);
                    a[q][r] = a[r][q];
                }
                // Update eigenvectors
                for r in 0..$n {
                    let vrp = v[r][p]; let vrq = v[r][q];
                    v[r][p] = vrp - s * (vrq + tau * vrp);
                    v[r][q] = vrq + s * (vrp - tau * vrq);
                }
            }
            v
        }
    };
}

make_jacobi!(jacobi3, 3);
make_jacobi!(jacobi4, 4);
make_jacobi!(jacobi12, 12);

// SVD of a 3×3 matrix A = U * S * V^T via eigendecomposition of A^T*A.
// Returns (U, singular_values_descending, V) where columns of U and V are
// the left/right singular vectors. Only S and V are needed for most uses here.
fn svd3(a: &M3) -> (M3, [f64; 3], M3) {
    // V: right singular vectors from eigen(A^T A)
    let mut ata = [[0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                ata[i][j] += a[k][i] * a[k][j]; // a^T * a
            }
        }
    }
    let v_cols = jacobi3(&mut ata); // columns of V
    // singular values = sqrt of eigenvalues (diagonal of ata after Jacobi)
    let mut sv: [(f64, usize); 3] = [(ata[0][0].max(0.0).sqrt(), 0),
                                      (ata[1][1].max(0.0).sqrt(), 1),
                                      (ata[2][2].max(0.0).sqrt(), 2)];
    sv.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());

    let mut s = [0f64; 3];
    let mut v = [[0f64; 3]; 3];
    for (new_j, &(sigma, old_j)) in sv.iter().enumerate() {
        s[new_j] = sigma;
        for i in 0..3 { v[i][new_j] = v_cols[i][old_j]; }
    }

    // U: left singular vectors U_j = (1/s_j) * A * v_j
    let mut u = [[0f64; 3]; 3];
    for j in 0..3 {
        if s[j] < 1e-12 {
            // degenerate: fill with something orthogonal
            let col = [v[0][j], v[1][j], v[2][j]];
            let perp = normalize3(&cross3(&col, &[1.0, 0.0, 0.0]));
            for i in 0..3 { u[i][j] = perp[i]; }
        } else {
            let vj = [v[0][j], v[1][j], v[2][j]];
            let avj = mat3_vec(a, &vj);
            for i in 0..3 { u[i][j] = avj[i] / s[j]; }
        }
    }
    (u, s, v)
}

// ── SVD of arbitrary m×n matrix via AtA ──────────────────────────────────────
// Only needed for the 4×4 DLT null-space (smallest singular vector of a 4-col matrix).
// We use a 4×4 Jacobi instead of a general SVD.

// Null space (last column of V) of a matrix with 4 columns by eigendecomposition of AtA.
fn null4(rows: &[[f64; 4]]) -> [f64; 4] {
    let mut ata = [[0f64; 4]; 4];
    for r in rows {
        for i in 0..4 {
            for j in 0..4 {
                ata[i][j] += r[i] * r[j];
            }
        }
    }
    let v = jacobi4(&mut ata);
    // find column of v with smallest eigenvalue
    let eigs = [ata[0][0], ata[1][1], ata[2][2], ata[3][3]];
    let min_idx = eigs.iter().enumerate()
        .min_by(|a, b| a.1.partial_cmp(b.1).unwrap())
        .map(|(i, _)| i)
        .unwrap_or(3);
    [v[0][min_idx], v[1][min_idx], v[2][min_idx], v[3][min_idx]]
}

// Null space (last column of V) for a matrix with 12 columns — used in PnP DLT.
fn null12(rows: &[[f64; 12]]) -> [f64; 12] {
    let mut ata = [[0f64; 12]; 12];
    for r in rows {
        for i in 0..12 {
            for j in 0..12 {
                ata[i][j] += r[i] * r[j];
            }
        }
    }
    let v = jacobi12(&mut ata);
    let eigs: Vec<f64> = (0..12).map(|i| ata[i][i]).collect();
    let min_idx = eigs.iter().enumerate()
        .min_by(|a, b| a.1.partial_cmp(b.1).unwrap())
        .map(|(i, _)| i)
        .unwrap_or(11);
    let mut out = [0f64; 12];
    for i in 0..12 { out[i] = v[i][min_idx]; }
    out
}

// ── Rotation matrix utilities ─────────────────────────────────────────────────

// Re-orthogonalize a 3×3 matrix to the nearest rotation (det=+1) via SVD.
fn nearest_rotation(m: &M3) -> M3 {
    let (u, _s, v) = svd3(m);
    // R = U * V^T, but ensure det = +1
    let vt = mat3_transpose(&v);
    let mut r = mat3_mul(&u, &vt);
    // Check determinant
    let det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1])
            - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
            + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
    if det < 0.0 {
        // flip sign of last column of U and redo
        let mut u2 = u;
        for i in 0..3 { u2[i][2] = -u2[i][2]; }
        r = mat3_mul(&u2, &vt);
    }
    r
}

// Skew-symmetric matrix [t]_x
fn skew(t: &V3) -> M3 {
    [[0.0, -t[2], t[1]],
     [t[2],  0.0, -t[0]],
     [-t[1], t[0],  0.0]]
}

// ── Essential matrix → (R, t) candidates ─────────────────────────────────────

fn decompose_essential(e: &M3) -> [(M3, V3); 4] {
    let (u, _s, v) = svd3(e);
    // W and W^T rotation helpers
    let w: M3 = [[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]];
    let wt: M3 = [[0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, 1.0]];
    let vt = mat3_transpose(&v);

    let r1 = nearest_rotation(&mat3_mul(&mat3_mul(&u, &w), &vt));
    let r2 = nearest_rotation(&mat3_mul(&mat3_mul(&u, &wt), &vt));
    // translation is last column of U (the null space of E^T)
    let t = [u[0][2], u[1][2], u[2][2]];
    let nt = [-t[0], -t[1], -t[2]];
    [(r1, t), (r1, nt), (r2, t), (r2, nt)]
}

// ── Triangulation (linear DLT, single point pair) ────────────────────────────

fn triangulate_point(
    xa: f64, ya: f64, pa: &M34,
    xb: f64, yb: f64, pb: &M34,
) -> V3 {
    // A * X_h = 0, where X_h is homogeneous 3D point
    let rows: [[f64; 4]; 4] = [
        [xa * pa[2][0] - pa[0][0], xa * pa[2][1] - pa[0][1],
         xa * pa[2][2] - pa[0][2], xa * pa[2][3] - pa[0][3]],
        [ya * pa[2][0] - pa[1][0], ya * pa[2][1] - pa[1][1],
         ya * pa[2][2] - pa[1][2], ya * pa[2][3] - pa[1][3]],
        [xb * pb[2][0] - pb[0][0], xb * pb[2][1] - pb[0][1],
         xb * pb[2][2] - pb[0][2], xb * pb[2][3] - pb[0][3]],
        [yb * pb[2][0] - pb[1][0], yb * pb[2][1] - pb[1][1],
         yb * pb[2][2] - pb[1][2], yb * pb[2][3] - pb[1][3]],
    ];
    let h = null4(&rows);
    if h[3].abs() < 1e-12 {
        return [f64::NAN, f64::NAN, f64::NAN];
    }
    [h[0] / h[3], h[1] / h[3], h[2] / h[3]]
}

// ── Simple xorshift RNG ───────────────────────────────────────────────────────

struct Xorshift(u32);
impl Xorshift {
    fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        self.0 = x; x
    }
    fn usize_below(&mut self, n: usize) -> usize {
        (self.next() as usize) % n
    }
    // k distinct indices in [0, n). Used for PnP: a few more than the 6-point
    // minimum stabilises the (normalised) DLT on near-planar samples.
    fn sample_k(&mut self, n: usize, k: usize) -> Vec<usize> {
        let mut s: Vec<usize> = Vec::with_capacity(k);
        while s.len() < k {
            let r = self.usize_below(n);
            if !s.contains(&r) { s.push(r); }
        }
        s
    }
}

// ── PnP DLT (calibrated, at least 6 points) ──────────────────────────────────
// Solves for P = [R|t] given K and N≥6 2D-3D correspondences.
// Returns Some((R, t)) or None.
fn pnp_dlt(pts3: &[[f64; 3]], pts2: &[[f64; 2]], fx: f64, fy: f64, cx: f64, cy: f64) -> Option<(M3, V3)> {
    let n = pts3.len();
    if n < 6 { return None; }
    // Normalise 2D points by K^{-1} to get normalised image coords
    let pts2n: Vec<[f64; 2]> = pts2.iter().map(|p| {
        [(p[0] - cx) / fx, (p[1] - cy) / fy]
    }).collect();

    // ── Hartley normalisation ──────────────────────────────────────────────
    // Centre + isotropically scale both the 3D points and the (K^{-1}-applied)
    // 2D points so the DLT system is well-conditioned. Without this the 12×12
    // normal matrix spans a huge dynamic range and the null vector is garbage —
    // which makes PnP fail on near-planar scenes (e.g. aerial terrain).
    let nf = n as f64;
    let mut c3 = [0.0f64; 3];
    for p in pts3 { c3[0] += p[0]; c3[1] += p[1]; c3[2] += p[2]; }
    c3[0] /= nf; c3[1] /= nf; c3[2] /= nf;
    let mut d3 = 0.0f64;
    for p in pts3 {
        let dx = p[0]-c3[0]; let dy = p[1]-c3[1]; let dz = p[2]-c3[2];
        d3 += (dx*dx + dy*dy + dz*dz).sqrt();
    }
    d3 /= nf;
    if d3 < 1e-12 { return None; }
    let s3 = (3.0f64).sqrt() / d3;

    let mut c2 = [0.0f64; 2];
    for p in &pts2n { c2[0] += p[0]; c2[1] += p[1]; }
    c2[0] /= nf; c2[1] /= nf;
    let mut d2 = 0.0f64;
    for p in &pts2n {
        let dx = p[0]-c2[0]; let dy = p[1]-c2[1];
        d2 += (dx*dx + dy*dy).sqrt();
    }
    d2 /= nf;
    if d2 < 1e-12 { return None; }
    let s2 = (2.0f64).sqrt() / d2;

    // Build 2N × 12 DLT matrix on the normalised correspondences.
    let mut rows: Vec<[f64; 12]> = Vec::with_capacity(2 * n);
    for i in 0..n {
        let x = (pts3[i][0]-c3[0]) * s3;
        let y = (pts3[i][1]-c3[1]) * s3;
        let z = (pts3[i][2]-c3[2]) * s3;
        let u = (pts2n[i][0]-c2[0]) * s2;
        let v = (pts2n[i][1]-c2[1]) * s2;
        rows.push([x, y, z, 1.0, 0.0, 0.0, 0.0, 0.0, -u*x, -u*y, -u*z, -u]);
        rows.push([0.0, 0.0, 0.0, 0.0, x, y, z, 1.0, -v*x, -v*y, -v*z, -v]);
    }
    let p_flat = null12(&rows);
    let pn: M34 = [
        [p_flat[0], p_flat[1],  p_flat[2],  p_flat[3]],
        [p_flat[4], p_flat[5],  p_flat[6],  p_flat[7]],
        [p_flat[8], p_flat[9],  p_flat[10], p_flat[11]],
    ];

    // ── Denormalise: P = T_inv · P' · U ────────────────────────────────────
    // T_inv (3×3) undoes the 2D normalisation; U (4×4) applies the 3D one.
    let ti = [[1.0/s2, 0.0, c2[0]], [0.0, 1.0/s2, c2[1]], [0.0, 0.0, 1.0]];
    let mut m = [[0.0f64; 4]; 3]; // M = T_inv · P'
    for r in 0..3 {
        for col in 0..4 {
            m[r][col] = ti[r][0]*pn[0][col] + ti[r][1]*pn[1][col] + ti[r][2]*pn[2][col];
        }
    }
    let u_mat = [
        [s3,  0.0, 0.0, -s3*c3[0]],
        [0.0, s3,  0.0, -s3*c3[1]],
        [0.0, 0.0, s3,  -s3*c3[2]],
        [0.0, 0.0, 0.0, 1.0],
    ];
    let mut p34 = [[0.0f64; 4]; 3]; // P = M · U
    for r in 0..3 {
        for col in 0..4 {
            let mut acc = 0.0;
            for k in 0..4 { acc += m[r][k] * u_mat[k][col]; }
            p34[r][col] = acc;
        }
    }

    // Extract R and t: P = [R|t] in normalised coords
    let r_raw: M3 = [[p34[0][0], p34[0][1], p34[0][2]],
                     [p34[1][0], p34[1][1], p34[1][2]],
                     [p34[2][0], p34[2][1], p34[2][2]]];
    // Scale: norm of first row should be 1 after re-orthogonalisation
    let scale = norm3(&[p34[2][0], p34[2][1], p34[2][2]]);
    if scale < 1e-12 { return None; }
    let sign = if p34[2][3] / scale > 0.0 { 1.0 } else { -1.0 };
    let r = nearest_rotation(&r_raw);
    let t = [sign * p34[0][3] / scale,
             sign * p34[1][3] / scale,
             sign * p34[2][3] / scale];
    Some((r, t))
}

// Reprojection error squared for a single observation (pixel space).
fn reprj_err2(r: &M3, t: &V3, fx: f64, fy: f64, cx: f64, cy: f64,
              x3: &V3, obs_x: f64, obs_y: f64) -> f64 {
    let p = make_p34(r, t);
    let (px, py) = project(&p, fx, fy, cx, cy, x3);
    if px.is_nan() { return 1e18; }
    let dx = px - obs_x; let dy = py - obs_y;
    dx * dx + dy * dy
}

// ── Exported WASM functions ───────────────────────────────────────────────────

/// Recover camera pose from the essential matrix E using a cheirality check.
///
/// # Inputs
/// - `pts_a`: flat N×2 pixel coords [x0,y0,x1,y1,…] for camera A
/// - `pts_b`: flat N×2 pixel coords for camera B
/// - `e_flat`: 9 floats, E matrix row-major
/// - `fx,fy,cx,cy`: intrinsics of camera A (used for back-projection in cheirality)
///
/// # Output
/// `[R00…R22, tx, ty, tz]` = 12 floats (R for camera B relative to A, t unit vector),
/// or empty Vec on failure.
#[wasm_bindgen]
pub fn recover_pose(
    pts_a: &[f32], pts_b: &[f32],
    e_flat: &[f32],
    fx: f32, fy: f32, cx: f32, cy: f32,
) -> Vec<f32> {
    let n = pts_a.len() / 2;
    if n < 5 || e_flat.len() < 9 { return vec![]; }

    let e: M3 = [
        [e_flat[0] as f64, e_flat[1] as f64, e_flat[2] as f64],
        [e_flat[3] as f64, e_flat[4] as f64, e_flat[5] as f64],
        [e_flat[6] as f64, e_flat[7] as f64, e_flat[8] as f64],
    ];
    let candidates = decompose_essential(&e);

    // Camera A: identity
    let ra: M3 = [[1.0,0.0,0.0],[0.0,1.0,0.0],[0.0,0.0,1.0]];
    let ta: V3 = [0.0, 0.0, 0.0];
    let pa = make_p34(&ra, &ta);

    let (fx64, fy64, cx64, cy64) = (fx as f64, fy as f64, cx as f64, cy as f64);

    let mut best_count = 0i32;
    let mut best_r = ra;
    let mut best_t = ta;

    // Use up to 50 point pairs for cheirality
    let step = (n / 50).max(1);

    for (rb, tb) in &candidates {
        let pb = make_p34(rb, tb);
        let mut pos_count = 0i32;
        for k in (0..n).step_by(step) {
            let xa = pts_a[k*2] as f64; let ya = pts_a[k*2+1] as f64;
            let xb = pts_b[k*2] as f64; let yb = pts_b[k*2+1] as f64;
            // Back-project to normalised coords
            let xan = (xa - cx64) / fx64;
            let yan = (ya - cy64) / fy64;
            let xbn = (xb - cx64) / fx64;
            let ybn = (yb - cy64) / fy64;
            let pt = triangulate_point(xan, yan, &pa, xbn, ybn, &pb);
            if pt[2].is_nan() { continue; }
            let depth_a = depth_in_camera(&pa, &pt);
            let depth_b = depth_in_camera(&pb, &pt);
            if depth_a > 0.0 && depth_b > 0.0 { pos_count += 1; }
        }
        if pos_count > best_count {
            best_count = pos_count;
            best_r = *rb;
            best_t = *tb;
        }
    }

    if best_count == 0 { return vec![]; }

    let mut out = Vec::with_capacity(12);
    for row in &best_r { for &v in row { out.push(v as f32); } }
    for &v in &best_t { out.push(v as f32); }
    out
}

/// Triangulate N point pairs via linear DLT.
///
/// # Inputs
/// - `pts_a`: flat N×2 pixel coords (normalised image coords, i.e. after K^{-1})
/// - `pts_b`: flat N×2 pixel coords (normalised)
/// - `p_a`: 12 floats, 3×4 projection matrix for camera A (row-major, in normalised coords)
/// - `p_b`: 12 floats, 3×4 for camera B
///
/// # Output
/// Flat N×3 `[x,y,z, …]`. NaN triples for degenerate rows.
#[wasm_bindgen]
pub fn triangulate_dlt(
    pts_a: &[f32], pts_b: &[f32],
    p_a: &[f32], p_b: &[f32],
) -> Vec<f32> {
    if p_a.len() < 12 || p_b.len() < 12 { return vec![]; }
    let n = pts_a.len() / 2;

    let pa: M34 = [
        [p_a[0] as f64, p_a[1] as f64,  p_a[2] as f64,  p_a[3] as f64],
        [p_a[4] as f64, p_a[5] as f64,  p_a[6] as f64,  p_a[7] as f64],
        [p_a[8] as f64, p_a[9] as f64,  p_a[10] as f64, p_a[11] as f64],
    ];
    let pb: M34 = [
        [p_b[0] as f64, p_b[1] as f64,  p_b[2] as f64,  p_b[3] as f64],
        [p_b[4] as f64, p_b[5] as f64,  p_b[6] as f64,  p_b[7] as f64],
        [p_b[8] as f64, p_b[9] as f64,  p_b[10] as f64, p_b[11] as f64],
    ];

    let mut out = Vec::with_capacity(n * 3);
    for i in 0..n {
        let xa = pts_a[i*2] as f64; let ya = pts_a[i*2+1] as f64;
        let xb = pts_b[i*2] as f64; let yb = pts_b[i*2+1] as f64;
        let pt = triangulate_point(xa, ya, &pa, xb, yb, &pb);
        out.push(pt[0] as f32);
        out.push(pt[1] as f32);
        out.push(pt[2] as f32);
    }
    out
}

/// Estimate camera pose from 3D-2D correspondences via RANSAC + DLT PnP.
///
/// # Inputs
/// - `pts_3d`: flat N×3 world points `[x,y,z,…]`
/// - `pts_2d`: flat N×2 pixel observations `[x,y,…]`
/// - `fx,fy,cx,cy`: camera intrinsics
/// - `ransac_thresh_px`: inlier reprojection threshold (pixels)
/// - `max_iters`: RANSAC iterations
///
/// # Output
/// `[R00…R22, tx,ty,tz, inlier_0, inlier_1, …, inlier_N]` = 12 + N floats,
/// or empty Vec on failure.
#[wasm_bindgen]
pub fn solve_pnp(
    pts_3d: &[f32], pts_2d: &[f32],
    fx: f32, fy: f32, cx: f32, cy: f32,
    ransac_thresh_px: f32,
    max_iters: u32,
) -> Vec<f32> {
    let n = pts_3d.len() / 3;
    if n < 6 { return vec![]; }
    let m = pts_2d.len() / 2;
    if m < n { return vec![]; }

    let (fx64, fy64, cx64, cy64) = (fx as f64, fy as f64, cx as f64, cy as f64);
    let thresh2 = (ransac_thresh_px as f64) * (ransac_thresh_px as f64);

    let pts3: Vec<[f64; 3]> = (0..n).map(|i| [pts_3d[i*3] as f64, pts_3d[i*3+1] as f64, pts_3d[i*3+2] as f64]).collect();
    let pts2: Vec<[f64; 2]> = (0..n).map(|i| [pts_2d[i*2] as f64, pts_2d[i*2+1] as f64]).collect();

    let mut rng = Xorshift(n as u32 * 1000 + 7);
    let mut best_inliers: Vec<bool> = vec![false; n];
    let mut best_count = 0usize;
    let mut best_r = [[1.0,0.0,0.0],[0.0,1.0,0.0],[0.0,0.0,1.0]];
    let mut best_t = [0.0f64; 3];

    // A few more than the 6-point minimum makes each (now normalised) DLT
    // hypothesis far more stable when the scene is close to planar.
    let sample_n = n.min(8).max(6);
    for _ in 0..max_iters {
        let idx = rng.sample_k(n, sample_n);
        let s3: Vec<[f64; 3]> = idx.iter().map(|&i| pts3[i]).collect();
        let s2: Vec<[f64; 2]> = idx.iter().map(|&i| pts2[i]).collect();

        if let Some((r, t)) = pnp_dlt(&s3, &s2, fx64, fy64, cx64, cy64) {
            let mut count = 0usize;
            let mut inliers = vec![false; n];
            for i in 0..n {
                let e2 = reprj_err2(&r, &t, fx64, fy64, cx64, cy64, &pts3[i], pts2[i][0], pts2[i][1]);
                if e2 < thresh2 { inliers[i] = true; count += 1; }
            }
            if count > best_count {
                best_count = count;
                best_inliers = inliers;
                best_r = r;
                best_t = t;
            }
        }
    }

    if best_count < 6 { return vec![]; }

    // Refit on all inliers
    let in3: Vec<[f64; 3]> = (0..n).filter(|&i| best_inliers[i]).map(|i| pts3[i]).collect();
    let in2: Vec<[f64; 2]> = (0..n).filter(|&i| best_inliers[i]).map(|i| pts2[i]).collect();
    if let Some((r, t)) = pnp_dlt(&in3, &in2, fx64, fy64, cx64, cy64) {
        best_r = r;
        best_t = t;
        // Recompute inliers with refined pose
        for i in 0..n {
            let e2 = reprj_err2(&best_r, &best_t, fx64, fy64, cx64, cy64, &pts3[i], pts2[i][0], pts2[i][1]);
            best_inliers[i] = e2 < thresh2;
        }
    }

    let mut out = Vec::with_capacity(12 + n);
    for row in &best_r { for &v in row { out.push(v as f32); } }
    for &v in &best_t { out.push(v as f32); }
    for b in &best_inliers { out.push(if *b { 1.0 } else { 0.0 }); }
    out
}

/// Simplified bundle adjustment via alternating minimisation.
///
/// Outer loop: fix cameras → refine each 3D point (linear DLT).
///             fix points  → refine each camera pose (gradient descent, finite differences).
///
/// # Inputs
/// - `cameras_flat`: n_cam × 12 floats `[R(9)|t(3), R(9)|t(3), …]`
/// - `intrinsics_flat`: n_cam × 4 floats `[fx,fy,cx,cy, …]`
/// - `pts_flat`: n_pts × 3 floats `[x,y,z, …]`
/// - `obs_flat`: n_obs × 4 floats `[cam_i, pt_i, pixel_x, pixel_y, …]`
/// - `max_iters`: outer iterations (typically 20–50)
///
/// # Output
/// `[cameras_flat(n_cam×12), pts_flat(n_pts×3)]`
#[wasm_bindgen]
pub fn bundle_adjust(
    cameras_flat: &[f32],
    intrinsics_flat: &[f32],
    pts_flat: &[f32],
    obs_flat: &[f32],
    max_iters: u32,
) -> Vec<f32> {
    let n_cam = cameras_flat.len() / 12;
    let n_pts = pts_flat.len() / 3;
    let n_obs = obs_flat.len() / 4;

    if n_cam == 0 || n_pts == 0 || n_obs == 0 { return vec![]; }

    // Unpack
    let mut cams: Vec<(M3, V3)> = (0..n_cam).map(|c| {
        let b = c * 12;
        let r: M3 = [[cameras_flat[b]   as f64, cameras_flat[b+1] as f64, cameras_flat[b+2]  as f64],
                     [cameras_flat[b+3] as f64, cameras_flat[b+4] as f64, cameras_flat[b+5]  as f64],
                     [cameras_flat[b+6] as f64, cameras_flat[b+7] as f64, cameras_flat[b+8]  as f64]];
        let t: V3 = [cameras_flat[b+9] as f64, cameras_flat[b+10] as f64, cameras_flat[b+11] as f64];
        (r, t)
    }).collect();

    let ks: Vec<(f64, f64, f64, f64)> = (0..n_cam).map(|c| {
        let b = c * 4;
        (intrinsics_flat[b] as f64, intrinsics_flat[b+1] as f64,
         intrinsics_flat[b+2] as f64, intrinsics_flat[b+3] as f64)
    }).collect();

    let mut pts: Vec<V3> = (0..n_pts).map(|i| {
        [pts_flat[i*3] as f64, pts_flat[i*3+1] as f64, pts_flat[i*3+2] as f64]
    }).collect();

    let obs: Vec<(usize, usize, f64, f64)> = (0..n_obs).map(|i| {
        let b = i * 4;
        (obs_flat[b] as usize, obs_flat[b+1] as usize,
         obs_flat[b+2] as f64, obs_flat[b+3] as f64)
    }).collect();

    // Build index: cam → list of (pt_idx, obs_x, obs_y)
    let mut cam_obs: Vec<Vec<(usize, f64, f64)>> = vec![vec![]; n_cam];
    // Build index: pt → list of (cam_idx, obs_x, obs_y)
    let mut pt_obs: Vec<Vec<(usize, f64, f64)>> = vec![vec![]; n_pts];
    for &(ci, pi, ox, oy) in &obs {
        if ci < n_cam && pi < n_pts {
            cam_obs[ci].push((pi, ox, oy));
            pt_obs[pi].push((ci, ox, oy));
        }
    }

    let eps = 1e-4; // finite-difference step for camera pose GD

    for _iter in 0..max_iters {
        // Step 1: Fix cameras, refine each 3D point via DLT (linear least squares)
        for pi in 0..n_pts {
            let views = &pt_obs[pi];
            if views.len() < 2 { continue; }
            let mut rows: Vec<[f64; 4]> = Vec::with_capacity(views.len() * 2);
            for &(ci, ox, oy) in views {
                let (r, t) = &cams[ci];
                let (fx, fy, cx, cy) = ks[ci];
                let p = make_p34(r, t);
                // Normalise obs
                let u = (ox - cx) / fx;
                let v = (oy - cy) / fy;
                rows.push([u*p[2][0]-p[0][0], u*p[2][1]-p[0][1], u*p[2][2]-p[0][2], u*p[2][3]-p[0][3]]);
                rows.push([v*p[2][0]-p[1][0], v*p[2][1]-p[1][1], v*p[2][2]-p[1][2], v*p[2][3]-p[1][3]]);
            }
            let h = null4(&rows);
            if h[3].abs() > 1e-12 {
                pts[pi] = [h[0]/h[3], h[1]/h[3], h[2]/h[3]];
            }
        }

        // Step 2: Fix points, refine each camera pose via gradient descent on reprojection error.
        for ci in 0..n_cam {
            let views = &cam_obs[ci];
            if views.is_empty() { continue; }
            let (fx, fy, cx, cy) = ks[ci];

            // Gradient descent on 12 params [R(9)|t(3)]. Small step to stay near valid rotation.
            // Compute current cost
            let cost = |r: &M3, t: &V3| -> f64 {
                let p = make_p34(r, t);
                views.iter().map(|&(pi, ox, oy)| {
                    let (px, py) = project(&p, fx, fy, cx, cy, &pts[pi]);
                    if px.is_nan() { 1e6 } else { (px-ox).powi(2) + (py-oy).powi(2) }
                }).sum()
            };

            let (r0, t0) = cams[ci];
            let c0 = cost(&r0, &t0);

            // Gradient w.r.t. t (3 params) — most impactful and well-conditioned
            let mut grad_t = [0f64; 3];
            for k in 0..3 {
                let mut tp = t0; tp[k] += eps;
                let cp = cost(&r0, &tp);
                grad_t[k] = (cp - c0) / eps;
            }

            // Gradient w.r.t. R parameterised as angle-axis increment
            // We perturb each of the 3 basis rotations slightly
            let mut best_r = r0; let mut best_t = t0; let mut best_c = c0;

            // Try gradient step on t
            let lr_t = 1.0; // step in pixels
            let step_scale = if c0 > 1.0 { 1.0 / c0.sqrt() } else { 1.0 };
            let nt: V3 = [t0[0] - lr_t * step_scale * grad_t[0],
                          t0[1] - lr_t * step_scale * grad_t[1],
                          t0[2] - lr_t * step_scale * grad_t[2]];
            let ct = cost(&r0, &nt);
            if ct < best_c { best_t = nt; best_c = ct; }

            // Try small axis-angle rotations
            let delta_angle = 0.005_f64; // ~0.3 degrees
            for axis in 0..3 {
                let omega: V3 = match axis {
                    0 => [delta_angle, 0.0, 0.0],
                    1 => [0.0, delta_angle, 0.0],
                    _ => [0.0, 0.0, delta_angle],
                };
                // Rodrigues: R_new = (I + [omega]_x) * R0, then re-orthogonalise
                let skw = skew(&omega);
                let incr: M3 = [[1.0+skw[0][0], skw[0][1], skw[0][2]],
                                 [skw[1][0], 1.0+skw[1][1], skw[1][2]],
                                 [skw[2][0], skw[2][1], 1.0+skw[2][2]]];
                let r_plus = nearest_rotation(&mat3_mul(&incr, &r0));
                let cp = cost(&r_plus, &best_t);
                let omega_neg: V3 = [-omega[0], -omega[1], -omega[2]];
                let skwn = skew(&omega_neg);
                let incrn: M3 = [[1.0+skwn[0][0], skwn[0][1], skwn[0][2]],
                                  [skwn[1][0], 1.0+skwn[1][1], skwn[1][2]],
                                  [skwn[2][0], skwn[2][1], 1.0+skwn[2][2]]];
                let r_minus = nearest_rotation(&mat3_mul(&incrn, &r0));
                let cm = cost(&r_minus, &best_t);
                if cp < best_c && cp <= cm { best_r = r_plus; best_c = cp; }
                else if cm < best_c { best_r = r_minus; best_c = cm; }
            }

            cams[ci] = (best_r, best_t);
        }
    }

    // Pack output
    let mut out = Vec::with_capacity(n_cam * 12 + n_pts * 3);
    for (r, t) in &cams {
        for row in r { for &v in row { out.push(v as f32); } }
        for &v in t { out.push(v as f32); }
    }
    for pt in &pts {
        for &v in pt { out.push(v as f32); }
    }
    out
}
