// Linear-algebra & geometry primitives shared across the crate: fixed-size matrix
// and vector ops, Jacobi eigendecomposition, 3×3 SVD, rotation utilities,
// essential-matrix decomposition, single-point triangulation, an xorshift RNG,
// and small real-root/6×6 solvers. No wasm — pure math, used by every other module.

// ── Types ─────────────────────────────────────────────────────────────────────
pub(crate) type M3 = [[f64; 3]; 3];
pub(crate) type M34 = [[f64; 4]; 3]; // 3×4 projection matrix
pub(crate) type V3 = [f64; 3];

// ── Basic linear algebra ──────────────────────────────────────────────────────

pub(crate) fn mat3_mul(a: &M3, b: &M3) -> M3 {
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

pub(crate) fn det3(m: &M3) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

pub(crate) fn mat3_transpose(a: &M3) -> M3 {
    let mut t = [[0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            t[i][j] = a[j][i];
        }
    }
    t
}

pub(crate) fn mat3_vec(m: &M3, v: &V3) -> V3 {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

pub(crate) fn dot3(a: &V3, b: &V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn cross3(a: &V3, b: &V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(crate) fn norm3(v: &V3) -> f64 {
    dot3(v, v).sqrt()
}

pub(crate) fn normalize3(v: &V3) -> V3 {
    let n = norm3(v);
    if n < 1e-12 { return [0.0, 0.0, 1.0]; }
    [v[0] / n, v[1] / n, v[2] / n]
}

// Build 3×4 from rotation (row-major 9 floats) and translation (3 floats).
pub(crate) fn make_p34(r: &M3, t: &V3) -> M34 {
    [
        [r[0][0], r[0][1], r[0][2], t[0]],
        [r[1][0], r[1][1], r[1][2], t[1]],
        [r[2][0], r[2][1], r[2][2], t[2]],
    ]
}

// Project world point X via K * P (K is embedded as [fx,0,cx; 0,fy,cy; 0,0,1]).
pub(crate) fn project(p: &M34, fx: f64, fy: f64, cx: f64, cy: f64, x: &V3) -> (f64, f64) {
    let xc = p[0][0] * x[0] + p[0][1] * x[1] + p[0][2] * x[2] + p[0][3];
    let yc = p[1][0] * x[0] + p[1][1] * x[1] + p[1][2] * x[2] + p[1][3];
    let zc = p[2][0] * x[0] + p[2][1] * x[1] + p[2][2] * x[2] + p[2][3];
    if zc.abs() < 1e-12 { return (f64::NAN, f64::NAN); }
    (fx * xc / zc + cx, fy * yc / zc + cy)
}

// Depth of world point X in camera P (unsigned).
pub(crate) fn depth_in_camera(p: &M34, x: &V3) -> f64 {
    p[2][0] * x[0] + p[2][1] * x[1] + p[2][2] * x[2] + p[2][3]
}

// ── Jacobi eigendecomposition for symmetric N×N matrices ─────────────────────
// Adapted from the matching crate. Returns (eigenvalues, eigenvectors as columns).

macro_rules! make_jacobi {
    ($name:ident, $n:expr) => {
        pub(crate) fn $name(a: &mut [[f64; $n]; $n]) -> [[f64; $n]; $n] {
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

// SVD of a 3×3 matrix A = U * S * V^T via eigendecomposition of A^T*A.
// Returns (U, singular_values_descending, V) where columns of U and V are
// the left/right singular vectors. Only S and V are needed for most uses here.
pub(crate) fn svd3(a: &M3) -> (M3, [f64; 3], M3) {
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

    // U: left singular vectors U_j = (1/s_j) * A * v_j for non-degenerate s_j.
    // A near-zero singular value gives no usable A·v_j direction; defer those.
    let mut u = [[0f64; 3]; 3];
    let mut degenerate = [false; 3];
    for j in 0..3 {
        if s[j] < 1e-9 {
            degenerate[j] = true;
        } else {
            let vj = [v[0][j], v[1][j], v[2][j]];
            let avj = mat3_vec(a, &vj);
            for i in 0..3 { u[i][j] = avj[i] / s[j]; }
        }
    }
    // Complete any degenerate column as the cross product of the other two, so U
    // stays orthonormal AND U[:,2] is the genuine left null vector (= ±t for an
    // essential matrix). The previous fill used cross(v_j, x̂), which produced an
    // arbitrary vector unrelated to the null space and broke pose recovery.
    // (Handles the single-degenerate case used here — rank-2 essential matrices
    // and full-rank re-orthogonalisation; two zero singular values are not hit.)
    for j in 0..3 {
        if !degenerate[j] { continue; }
        let (p, q) = match j { 0 => (1, 2), 1 => (0, 2), _ => (0, 1) };
        let cp = [u[0][p], u[1][p], u[2][p]];
        let cq = [u[0][q], u[1][q], u[2][q]];
        let cr = normalize3(&cross3(&cp, &cq));
        for i in 0..3 { u[i][j] = cr[i]; }
    }
    (u, s, v)
}

// ── SVD of arbitrary m×n matrix via AtA ──────────────────────────────────────
// Only needed for the 4×4 DLT null-space (smallest singular vector of a 4-col matrix).
// We use a 4×4 Jacobi instead of a general SVD.

// Null space (last column of V) of a matrix with 4 columns by eigendecomposition of AtA.
pub(crate) fn null4(rows: &[[f64; 4]]) -> [f64; 4] {
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

// ── Rotation matrix utilities ─────────────────────────────────────────────────

// Re-orthogonalize a 3×3 matrix to the nearest rotation (det=+1) via SVD.
pub(crate) fn nearest_rotation(m: &M3) -> M3 {
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
pub(crate) fn skew(t: &V3) -> M3 {
    [[0.0, -t[2], t[1]],
     [t[2],  0.0, -t[0]],
     [-t[1], t[0],  0.0]]
}

// ── Essential matrix → (R, t) candidates ─────────────────────────────────────

pub(crate) fn decompose_essential(e: &M3) -> [(M3, V3); 4] {
    let (mut u, _s, mut v) = svd3(e);

    // The R = U·W·Vᵀ construction is only a valid rotation when U and V are
    // PROPER rotations (det = +1). svd3 may hand back reflections (det = -1);
    // negate the last column (tied to the zero singular value, so U·S·Vᵀ is
    // unchanged) to fix the handedness. Doing this here — instead of forcing the
    // product through nearest_rotation — is what makes r1/r2 the *correct*
    // rotations rather than an arbitrary nearby one.
    if det3(&u) < 0.0 { for i in 0..3 { u[i][2] = -u[i][2]; } }
    if det3(&v) < 0.0 { for i in 0..3 { v[i][2] = -v[i][2]; } }

    // W and W^T rotation helpers
    let w: M3 = [[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]];
    let wt: M3 = [[0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, 1.0]];
    let vt = mat3_transpose(&v);

    let r1 = mat3_mul(&mat3_mul(&u, &w), &vt);
    let r2 = mat3_mul(&mat3_mul(&u, &wt), &vt);
    // translation is last column of U (the left null vector of E, i.e. ±t)
    let t = [u[0][2], u[1][2], u[2][2]];
    let nt = [-t[0], -t[1], -t[2]];
    [(r1, t), (r1, nt), (r2, t), (r2, nt)]
}

// ── Triangulation (linear DLT, single point pair) ────────────────────────────

pub(crate) fn triangulate_point(
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

pub(crate) struct Xorshift(pub(crate) u32);
impl Xorshift {
    pub(crate) fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        self.0 = x; x
    }
    pub(crate) fn usize_below(&mut self, n: usize) -> usize {
        (self.next() as usize) % n
    }
    // k distinct indices in [0, n). PnP draws the 3-point minimal sets the
    // Lambda-Twist P3P solver needs for each RANSAC hypothesis.
    pub(crate) fn sample_k(&mut self, n: usize, k: usize) -> Vec<usize> {
        let mut s: Vec<usize> = Vec::with_capacity(k);
        while s.len() < k {
            let r = self.usize_below(n);
            if !s.contains(&r) { s.push(r); }
        }
        s
    }
}

// ── Cubic solver (real roots) ─────────────────────────────────────────────────
// Real roots of c3·x³ + c2·x² + c1·x + c0 = 0 (degrades gracefully to a
// quadratic/linear when leading coefficients vanish). Uses the depressed-cubic
// form with the trigonometric branch for three real roots — robust enough for
// the P3P discriminant cubic.
pub(crate) fn solve_cubic(c3: f64, c2: f64, c1: f64, c0: f64) -> Vec<f64> {
    if c3.abs() < 1e-14 {
        // Quadratic c2·x² + c1·x + c0.
        if c2.abs() < 1e-14 {
            if c1.abs() < 1e-14 { return vec![]; }
            return vec![-c0 / c1];
        }
        let disc = c1 * c1 - 4.0 * c2 * c0;
        if disc < 0.0 { return vec![]; }
        let s = disc.sqrt();
        return vec![(-c1 + s) / (2.0 * c2), (-c1 - s) / (2.0 * c2)];
    }
    // Monic: x³ + a·x² + b·x + c. Depress with x = t − a/3 → t³ + p·t + q.
    let a = c2 / c3;
    let b = c1 / c3;
    let c = c0 / c3;
    let p = b - a * a / 3.0;
    let q = 2.0 * a * a * a / 27.0 - a * b / 3.0 + c;
    let shift = a / 3.0;
    let disc = q * q / 4.0 + p * p * p / 27.0;
    if disc > 1e-14 {
        let s = disc.sqrt();
        let u = (-q / 2.0 + s).cbrt();
        let v = (-q / 2.0 - s).cbrt();
        vec![u + v - shift]
    } else if disc < -1e-14 {
        // Three distinct real roots (Viète's trigonometric solution).
        let r = (-(p * p * p) / 27.0).sqrt();
        let phi = (-q / (2.0 * r)).clamp(-1.0, 1.0).acos();
        let m = 2.0 * (-p / 3.0).sqrt();
        let tau = std::f64::consts::PI;
        vec![
            m * (phi / 3.0).cos() - shift,
            m * ((phi + 2.0 * tau) / 3.0).cos() - shift,
            m * ((phi + 4.0 * tau) / 3.0).cos() - shift,
        ]
    } else {
        // Discriminant ≈ 0 → repeated roots.
        let u = (-q / 2.0).cbrt();
        vec![2.0 * u - shift, -u - shift]
    }
}

// Exponential map so(3) → SO(3) (Rodrigues): rotation by |ω| about ω̂.
pub(crate) fn so3_exp(w: &V3) -> M3 {
    let theta = norm3(w);
    if theta < 1e-12 {
        return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    }
    let k = [w[0] / theta, w[1] / theta, w[2] / theta];
    let kx = skew(&k);
    let kx2 = mat3_mul(&kx, &kx);
    let s = theta.sin();
    let c1 = 1.0 - theta.cos();
    let mut r = [[0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            r[i][j] = (if i == j { 1.0 } else { 0.0 }) + s * kx[i][j] + c1 * kx2[i][j];
        }
    }
    r
}

// Solve a 6×6 linear system A·x = b by Gaussian elimination with partial
// pivoting. Returns None if A is (near-)singular.
pub(crate) fn solve6(a: &[[f64; 6]; 6], b: &[f64; 6]) -> Option<[f64; 6]> {
    let mut m = [[0f64; 7]; 6];
    for i in 0..6 {
        for j in 0..6 { m[i][j] = a[i][j]; }
        m[i][6] = b[i];
    }
    for col in 0..6 {
        // Partial pivot.
        let mut piv = col;
        let mut best = m[col][col].abs();
        for r in (col + 1)..6 {
            if m[r][col].abs() > best { best = m[r][col].abs(); piv = r; }
        }
        if best < 1e-15 { return None; }
        if piv != col { m.swap(piv, col); }
        let d = m[col][col];
        for r in 0..6 {
            if r == col { continue; }
            let f = m[r][col] / d;
            if f == 0.0 { continue; }
            for j in col..7 { m[r][j] -= f * m[col][j]; }
        }
    }
    let mut x = [0f64; 6];
    for i in 0..6 { x[i] = m[i][6] / m[i][i]; }
    Some(x)
}
