use crate::Real;
use na::{Point3, Vector3};
use std::ops::{Add, Div, Mul, Neg};

// The direct definition. The assembly reads tabulated coefficients (`OverlapTable`); this
// stays as the reference those tables are tested against. (Vendored patch.)
#[allow(dead_code)]
#[derive(Copy, Clone, PartialEq, Debug)]
pub struct TriQuadraticBspline {
    center: Point3<Real>,
    width: Real,
}

#[allow(dead_code)]
impl TriQuadraticBspline {
    pub fn new(center: Point3<Real>, width: Real) -> Self {
        Self { center, width }
    }

    pub fn eval(&self, pt: Point3<Real>) -> Real {
        let mut result = 1.0;

        for i in 0..3 {
            result *= eval_bspline(pt[i], self.center[i], self.width)
        }

        result
    }

    pub fn grad_grad(self, rhs: Self, diff1: bool, diff2: bool) -> Vector3<Real> {
        let dcenter = rhs.center - self.center;
        let mut result_int = [0.0; 3];
        let mut result_diff_diff_int = [0.0; 3];

        for dim in 0..3 {
            match overlap_1d(dcenter[dim], self.width, rhs.width, diff1, diff2) {
                Some((int, diff_diff_int)) => {
                    result_int[dim] = int;
                    result_diff_diff_int[dim] = diff_diff_int;
                }
                None => return Vector3::zeros(), // no overlap along this dimension
            }
        }

        Vector3::new(
            result_diff_diff_int[0] * result_int[1] * result_int[2],
            result_int[0] * result_diff_diff_int[1] * result_int[2],
            result_int[0] * result_int[1] * result_diff_diff_int[2],
        )
    }
}

/// One axis of [`TriQuadraticBspline::grad_grad`]: for a quadratic B-spline of width
/// `w1` at 0 and one of width `w2` at `dc`, returns `(∫B₁B₂, ∫B₁'B₂')` (each factor
/// differentiated only when its flag is set), or `None` when the supports do not
/// overlap. (Vendored patch: lifted out of `grad_grad` unchanged so the tabulated
/// assembly in [`GradGradTable`] computes exactly what `grad_grad` computes.)
pub fn overlap_1d(dc: Real, w1: Real, w2: Real, diff1: bool, diff2: bool) -> Option<(Real, Real)> {
    if dc.abs() >= (w1 + w2) * 1.5 {
        return None;
    }
    let poly1 = bspline::<6>(0.0, w1);
    let poly_diff1 = if diff1 {
        [poly1[0].derivative(), poly1[1].derivative(), poly1[2].derivative()]
    } else {
        poly1
    };
    // We have to check the splines domain pieces to multiply together
    // the correct polynomials.
    let sub1 = [-1.5 * w1, -0.5 * w1, 0.5 * w1, 1.5 * w1];
    let sub2 = [dc - 1.5 * w2, dc - 0.5 * w2, dc + 0.5 * w2, dc + 1.5 * w2];
    let poly2 = bspline::<6>(dc, w2);
    let poly_diff2 = if diff2 {
        [poly2[0].derivative(), poly2[1].derivative(), poly2[2].derivative()]
    } else {
        poly2
    };

    let mut int = 0.0;
    let mut diff_diff_int = 0.0;
    // Compute the 9 potential interval intersections.
    for i in 0..3 {
        for j in 0..3 {
            let start = sub1[i].max(sub2[j]);
            let end = sub1[i + 1].min(sub2[j + 1]);
            if end > start {
                let primitive = (poly1[i] * poly2[j]).primitive();
                int += primitive.eval(end) - primitive.eval(start);

                let primitive_diff_diff = (poly_diff1[i] * poly_diff2[j]).primitive();
                diff_diff_int += primitive_diff_diff.eval(end) - primitive_diff_diff.eval(start);
            }
        }
    }
    Some((int, diff_diff_int))
}

/// [`TriQuadraticBspline::grad_grad`] between a node of one layer (width `wa`, the
/// `self` spline) and a node of another (width `wb`, the `rhs` spline), tabulated by
/// **integer lattice offset**. (Vendored patch.)
///
/// All layers share one grid origin and centre their cells at `(k + ½)·width`, and their
/// widths differ by powers of two. With `u = min(wa, wb)`, `sa = wa/u`, `sb = wb/u`, the
/// centre offset along an axis is `(d + ½(sb − sa))·u` with `d = k_b·sb − k_a·sa` an
/// integer. The per-axis integrals therefore take a few hundred distinct values per
/// layer pair, while the assembly asks for them millions of times per layer — computing
/// each by piecewise polynomial multiplication and integration dominated the solve.
/// Entries come from [`overlap_1d`] on the exact lattice offset rather than on two
/// differenced absolute centres, so they agree with the direct call to rounding.
pub struct OverlapTable {
    sa: i64,
    sb: i64,
    offset: i64,
    // Per-axis (∫B₁B₂, ∫B₁'B₂') by d + offset; (0, 0) where the supports are disjoint.
    axis: Vec<(Real, Real)>,
}

impl OverlapTable {
    pub fn new(wa: Real, wb: Real, diff1: bool, diff2: bool) -> Self {
        let u = wa.min(wb);
        let sa = (wa / u).round() as i64;
        let sb = (wb / u).round() as i64;
        let shift = 0.5 * (sb - sa) as Real;
        // |dc| < 1.5(wa + wb) ⇒ |d + shift| < 1.5(sa + sb).
        let offset = (1.5 * (sa + sb) as Real + shift.abs()).ceil() as i64 + 1;
        let axis = (-offset..=offset)
            .map(|d| {
                let dc = (d as Real + shift) * u;
                overlap_1d(dc, wa, wb, diff1, diff2).unwrap_or((0.0, 0.0))
            })
            .collect();
        Self { sa, sb, offset, axis }
    }

    #[inline]
    fn axes(&self, ka: &Point3<i64>, kb: &Point3<i64>) -> Option<[(Real, Real); 3]> {
        let mut i = [(0.0, 0.0); 3];
        for dim in 0..3 {
            let d = kb[dim] * self.sb - ka[dim] * self.sa + self.offset;
            if d < 0 || d as usize >= self.axis.len() {
                return None;
            }
            i[dim] = self.axis[d as usize];
        }
        Some(i)
    }

    /// `grad_grad(a, b, ..)` for node keys `ka` (layer of width `wa`), `kb` (`wb`).
    #[inline]
    pub fn grad_grad(&self, ka: &Point3<i64>, kb: &Point3<i64>) -> Vector3<Real> {
        match self.axes(ka, kb) {
            Some([(ix, dx), (iy, dy), (iz, dz)]) => {
                Vector3::new(dx * iy * iz, ix * dy * iz, ix * iy * dz)
            }
            None => Vector3::zeros(),
        }
    }

    /// `grad_grad(a, b, ..).sum()`, without building the vector.
    #[inline]
    pub fn grad_grad_sum(&self, ka: &Point3<i64>, kb: &Point3<i64>) -> Real {
        match self.axes(ka, kb) {
            Some([(ix, dx), (iy, dy), (iz, dz)]) => dx * iy * iz + ix * dy * iz + ix * iy * dz,
            None => 0.0,
        }
    }
}


#[derive(Copy, Clone, Debug, PartialEq)]
pub struct PoissonQuadraticBsplineCoeffs {
    pub laplacian: [[[Real; 5]; 5]; 5],
    pub normal_div: [[[[Real; 5]; 5]; 5]; 3],
}

impl Default for PoissonQuadraticBsplineCoeffs {
    fn default() -> Self {
        Self {
            laplacian: [[[0.0; 5]; 5]; 5],
            normal_div: [[[[0.0; 5]; 5]; 5]; 3],
        }
    }
}

fn bspline03<const DEG: usize>() -> [Polynomial<DEG>; 3] {
    [
        Polynomial::<DEG>::quadratic(0.0, 0.0, 0.5), // x in [0, 1)
        Polynomial::<DEG>::quadratic(-1.5, 3.0, -1.0), // x in [1, 2)
        Polynomial::<DEG>::quadratic(4.5, -3.0, 0.5), // x in [2, 3)
    ]
}

fn bspline<const DEG: usize>(origin: Real, width: Real) -> [Polynomial<DEG>; 3] {
    let b = bspline03::<DEG>();

    [
        b[0].scale_shift(origin - 1.5 * width, width) / width,
        b[1].scale_shift(origin - 1.5 * width, width) / width,
        b[2].scale_shift(origin - 1.5 * width, width) / width,
    ]
}

pub fn eval_bspline(x: Real, origin: Real, width: Real) -> Real {
    // Bring the value between [0, 3)
    let val = (x - origin) / width + 1.5;
    let [b0, b1, b2] = bspline03::<3>();

    if val < 0.0 {
        0.0
    } else if val < 1.0 {
        b0.eval(val) / width
    } else if val < 2.0 {
        b1.eval(val) / width
    } else if val < 3.0 {
        b2.eval(val) / width
    } else {
        0.0
    }
}

pub fn eval_bspline_diff(x: Real, origin: Real, width: Real) -> Real {
    // Bring the value between [0, 3)
    let val = (x - origin) / width + 1.5;
    let [b0, b1, b2] = bspline03::<3>();

    if val < 0.0 {
        0.0
    } else if val < 1.0 {
        b0.derivative().eval(val) / width
    } else if val < 2.0 {
        b1.derivative().eval(val) / width
    } else if val < 3.0 {
        b2.derivative().eval(val) / width
    } else {
        0.0
    }
}

pub fn compute_quadratic_bspline_convolution_coeffs(width: Real) -> PoissonQuadraticBsplineCoeffs {
    let [mut b0, mut b1, mut b2] = bspline03::<6>();

    // Center and normalize each section of the b-spline.
    b0 = b0.scale_shift(0.0, width) / width; // x in [0, w)
    b1 = b1.scale_shift(-width, width) / width; // x in [0, w)
    b2 = b2.scale_shift(-2.0 * width, width) / width; // x in [0, w)
    let bdiff0 = b0.derivative();
    let bdiff1 = b1.derivative();
    let bdiff2 = b2.derivative();

    let primitives = [
        (b2 * b0).primitive(),
        (b1 * b0).primitive() + (b2 * b1).primitive(),
        (b0 * b0).primitive() + (b1 * b1).primitive() + (b2 * b2).primitive(),
        (b1 * b0).primitive() + (b2 * b1).primitive(),
        (b2 * b0).primitive(),
    ];
    let integrals = [
        primitives[0].eval(width) - primitives[0].eval(0.0),
        primitives[1].eval(width) - primitives[1].eval(0.0),
        primitives[2].eval(width) - primitives[2].eval(0.0),
        primitives[3].eval(width) - primitives[3].eval(0.0),
        primitives[4].eval(width) - primitives[4].eval(0.0),
    ];

    let primitives_diff = [
        (bdiff2 * b0).primitive(),
        (bdiff1 * b0).primitive() + (bdiff2 * b1).primitive(),
        (b0 * bdiff0).primitive() + (b1 * bdiff1).primitive() + (b2 * bdiff2).primitive(),
        (b1 * bdiff0).primitive() + (b2 * bdiff1).primitive(),
        (b2 * bdiff0).primitive(),
    ];
    let integrals_diff = [
        primitives_diff[0].eval(width) - primitives_diff[0].eval(0.0),
        primitives_diff[1].eval(width) - primitives_diff[1].eval(0.0),
        primitives_diff[2].eval(width) - primitives_diff[2].eval(0.0),
        primitives_diff[3].eval(width) - primitives_diff[3].eval(0.0),
        primitives_diff[4].eval(width) - primitives_diff[4].eval(0.0),
    ];

    let primitives_diff_diff = [
        (bdiff2 * bdiff0).primitive(),
        ((bdiff1 * bdiff0).primitive() + (bdiff2 * bdiff1).primitive()),
        ((bdiff0 * bdiff0).primitive()
            + (bdiff1 * bdiff1).primitive()
            + (bdiff2 * bdiff2).primitive()),
        ((bdiff1 * bdiff0).primitive() + (bdiff2 * bdiff1).primitive()),
        ((bdiff2 * bdiff0).primitive()),
    ];
    let integrals_diff_diff = [
        primitives_diff_diff[0].eval(width) - primitives_diff_diff[0].eval(0.0),
        primitives_diff_diff[1].eval(width) - primitives_diff_diff[1].eval(0.0),
        primitives_diff_diff[2].eval(width) - primitives_diff_diff[2].eval(0.0),
        primitives_diff_diff[3].eval(width) - primitives_diff_diff[3].eval(0.0),
        primitives_diff_diff[4].eval(width) - primitives_diff_diff[4].eval(0.0),
    ];

    let mut result = PoissonQuadraticBsplineCoeffs::default();

    for i in -2i32..=2 {
        for j in -2i32..=2 {
            for k in -2i32..=2 {
                let ia = (i + 2) as usize;
                let ja = (j + 2) as usize;
                let ka = (k + 2) as usize;

                result.laplacian[ia][ja][ka] =
                    integrals_diff_diff[ia] * integrals[ja] * integrals[ka]
                        + integrals[ia] * integrals_diff_diff[ja] * integrals[ka]
                        + integrals[ia] * integrals[ja] * integrals_diff_diff[ka];
                result.normal_div[0][ia][ja][ka] =
                    integrals_diff[ia] * integrals[ja] * integrals[ka];
                result.normal_div[1][ia][ja][ka] =
                    integrals[ia] * integrals_diff[ja] * integrals[ka];
                result.normal_div[2][ia][ja][ka] =
                    integrals[ia] * integrals[ja] * integrals_diff[ka];
            }
        }
    }

    result
}

#[derive(Copy, Clone, PartialEq, Debug)]
pub struct Polynomial<const N: usize> {
    pub coeffs: [Real; N],
}

impl<const N: usize> Default for Polynomial<N> {
    fn default() -> Self {
        Self { coeffs: [0.0; N] }
    }
}

impl<const N: usize> Polynomial<N> {
    pub fn eval(&self, x: Real) -> Real {
        let mut result = self.coeffs[N - 1];

        for i in (0..N - 1).rev() {
            result = result * x + self.coeffs[i];
        }

        result
    }

    #[must_use]
    pub fn quadratic(cst: Real, x: Real, xx: Real) -> Self {
        let mut coeffs = [0.0; N];
        coeffs[0] = cst;
        coeffs[1] = x;
        coeffs[2] = xx;
        Self { coeffs }
    }

    #[must_use]
    pub fn derivative(mut self) -> Self {
        for i in 0..N - 1 {
            self.coeffs[i] = self.coeffs[i + 1] * (i as Real + 1.0);
        }
        self.coeffs[N - 1] = 0.0;
        self
    }

    #[must_use]
    pub fn primitive(mut self) -> Self {
        assert_eq!(
            self.coeffs[N - 1],
            0.0,
            "Integration coefficient overflow. Increase the polynomial degree."
        );
        for i in (1..N).rev() {
            self.coeffs[i] = self.coeffs[i - 1] / (i as Real);
        }
        self.coeffs[0] = 0.0;
        self
    }

    // For a polynomial up to degree 2, this computes the polynomial
    // representation of P(X) = P((x - center) / width)
    #[must_use]
    pub fn scale_shift(self, center: Real, width: Real) -> Self {
        for k in 3..N {
            assert_eq!(
                self.coeffs[k], 0.0,
                "Only implemented for polynomials with degrees up to 2."
            );
        }

        let a = self.coeffs[0];
        let b = self.coeffs[1];
        let c = self.coeffs[2];
        let w = width;
        let ww = w * w;

        let mut result = Self::default();
        result.coeffs[0] = a - center * b / w + c * center * center / ww;
        result.coeffs[1] = b / w - 2.0 * c * center / ww;
        result.coeffs[2] = c / ww;
        result
    }
}

impl<const N: usize> Neg for Polynomial<N> {
    type Output = Self;
    fn neg(mut self) -> Self {
        for i in 0..N {
            self.coeffs[i] = -self.coeffs[i];
        }
        self
    }
}

impl<const N: usize> Div<Real> for Polynomial<N> {
    type Output = Self;
    fn div(mut self, rhs: Real) -> Self {
        for i in 0..N {
            self.coeffs[i] /= rhs;
        }
        self
    }
}

impl<const N: usize> Mul<Polynomial<N>> for Polynomial<N> {
    type Output = Self;
    fn mul(self, rhs: Self) -> Self {
        let mut result = Self::default();
        for i in 0..N {
            for j in 0..N {
                let val = self.coeffs[i] * rhs.coeffs[j];
                if j + i >= N {
                    assert_eq!(
                        val, 0.0,
                        "The result of the product must have a degree smaller than N"
                    );
                } else {
                    result.coeffs[j + i] += self.coeffs[i] * rhs.coeffs[j];
                }
            }
        }
        result
    }
}

impl<const N: usize> Add<Polynomial<N>> for Polynomial<N> {
    type Output = Self;
    fn add(mut self, rhs: Self) -> Self {
        for i in 0..N {
            self.coeffs[i] += rhs.coeffs[i];
        }
        self
    }
}

#[cfg(test)]
mod test {
    use crate::polynomial::Polynomial;

    // `OverlapTable` must reproduce the direct `grad_grad` for any two layers of a
    // shared-origin lattice, both flag combinations the assembly uses, and both width
    // orders (source finer or coarser than target). Randomized over a few thousand node
    // pairs near and beyond the support boundary, at a realistic absolute offset.
    #[test]
    fn overlap_table_matches_direct_grad_grad() {
        use super::{OverlapTable, TriQuadraticBspline};
        use na::Point3;
        let origin = Point3::new(-37.25, 12.5, 1003.75);
        let leaf = 0.0137;
        let center = |k: &Point3<i64>, w: f64| origin + k.coords.map(|x| x as f64 * w + w / 2.0);
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        let mut next = |n: i64| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % (2 * n as u64 + 1)) as i64 - n
        };
        for &(la, lb) in &[(0i32, 0i32), (0, 1), (0, 3), (2, 0), (5, 1), (0, 7)] {
            let (wa, wb) = (leaf * 2f64.powi(la), leaf * 2f64.powi(lb));
            for &(d1, d2) in &[(true, true), (false, true)] {
                let table = OverlapTable::new(wa, wb, d1, d2);
                let mut pairs = Vec::new();
                for _ in 0..2000 {
                    let ka = Point3::new(next(4000), next(4000), next(4000));
                    // kb: the cell of layer b holding ka's centre, jittered by up to 4/3 of the
                    // joint support widths — inside, at, and past the overlap boundary.
                    let reach = (2.0 * (wa + wb) / wb).ceil() as i64;
                    let ca = center(&ka, wa);
                    let kb = Point3::new(
                        ((ca.x - origin.x) / wb).floor() as i64 + next(reach),
                        ((ca.y - origin.y) / wb).floor() as i64 + next(reach),
                        ((ca.z - origin.z) / wb).floor() as i64 + next(reach),
                    );
                    let direct = TriQuadraticBspline::new(ca, wa)
                        .grad_grad(TriQuadraticBspline::new(center(&kb, wb), wb), d1, d2);
                    pairs.push((ka, kb, direct));
                }
                // Tolerance relative to the largest coefficient of this layer pair: the
                // table differs from the direct call only in how the centre offset is
                // rounded, which perturbs every entry by ~ε × that magnitude.
                let peak = pairs.iter().fold(0.0f64, |m, p| m.max(p.2.amax()));
                assert!(peak > 0.0, "fixture produced no overlapping pairs");
                let mut nonzero = 0;
                for (ka, kb, direct) in &pairs {
                    let tab = table.grad_grad(ka, kb);
                    assert!(
                        (direct - tab).amax() <= 1e-9 * peak,
                        "layers ({la},{lb}) flags ({d1},{d2}) ka {ka} kb {kb}: {direct:?} vs {tab:?}"
                    );
                    assert!((table.grad_grad_sum(ka, kb) - direct.sum()).abs() <= 1e-9 * peak);
                    nonzero += (direct.amax() > 0.0) as usize;
                }
                assert!(nonzero > 100, "too few overlapping pairs exercised: {nonzero}");
            }
        }
    }

    #[test]
    fn poly_eval() {
        let poly = Polynomial {
            coeffs: [1.0, 2.0, 3.0, 4.0, 5.0],
        };
        assert_eq!(
            poly.eval(2.0),
            1.0 + 2.0 * 2.0 + 3.0 * 4.0 + 4.0 * 8.0 + 5.0 * 16.0
        );
    }

    #[test]
    fn poly_add() {
        let poly1 = Polynomial {
            coeffs: [1.0, 2.0, 3.0, 4.0, 5.0],
        };
        let poly2 = Polynomial {
            coeffs: [10.0, 20.0, 30.0, 40.0, 50.0],
        };
        let expected = Polynomial {
            coeffs: [11.0, 22.0, 33.0, 44.0, 55.0],
        };
        assert_eq!(poly1 + poly2, expected);
    }

    #[test]
    fn poly_mul() {
        let poly1 = Polynomial {
            coeffs: [1.0, 2.0, 3.0, 0.0, 0.0],
        };
        let poly2 = Polynomial {
            coeffs: [10.0, 20.0, 30.0, 0.0, 0.0],
        };
        let expected = Polynomial {
            coeffs: [10.0, 40.0, 100.0, 120.0, 90.0],
        };
        assert_eq!(poly1 * poly2, expected);
    }

    #[test]
    fn poly_diff() {
        let poly = Polynomial {
            coeffs: [1.0, 2.0, 3.0, 4.0, 5.0],
        };
        let expected = Polynomial {
            coeffs: [2.0, 6.0, 12.0, 20.0, 0.0],
        };
        assert_eq!(poly.derivative(), expected);
    }

    #[test]
    fn poly_primitive() {
        let poly = Polynomial {
            coeffs: [1.0, 2.0, 3.0, 4.0, 0.0],
        };
        let expected = Polynomial {
            coeffs: [0.0, 1.0, 1.0, 1.0, 1.0],
        };
        assert_eq!(poly.primitive(), expected);
        assert_eq!(poly.primitive().derivative(), poly);
    }

    #[test]
    fn scale_shift() {
        let shift = 0.5;
        let width = 2.5;
        let poly = Polynomial {
            coeffs: [10.0, 20.0, 30.0, 0.0, 0.0],
        };
        let poly_scale_shifted = poly.scale_shift(shift, width);
        assert_eq!(
            poly.eval((11.0 - shift) / width),
            poly_scale_shifted.eval(11.0)
        );
        assert_eq!(poly.eval(0.0), poly_scale_shifted.eval(shift));
        assert!((poly.eval(-shift / width) - poly_scale_shifted.eval(0.0)).abs() < 1.0e-8);
    }
}
