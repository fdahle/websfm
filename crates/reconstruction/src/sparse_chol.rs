//! Sparse block Cholesky of the reduced camera system (plan-sfm-scale ▸ S2).
//!
//! The reduced system of a bundle adjustment is sparse: a camera couples only with the
//! cameras it shares points with (`BlockPattern`). Above a few hundred cameras the
//! dense factorisation is out of reach and PCG with a block-Jacobi preconditioner
//! stalls at its iteration cap (1,600 aerial cameras: 22 of 23 solves capped). A
//! sparse factorisation is exact and its cost follows the fill, not n³: on an aerial
//! block the camera graph is a 2-D mesh, whose fill a minimum-degree ordering keeps
//! near n·√n.
//!
//! Three steps, the first reused for every LM iteration of one bundle adjustment
//! (the pattern does not change between them):
//! - `Symbolic::new`: a minimum-degree elimination order on the block graph and the
//!   block pattern of L it implies;
//! - `Symbolic::factor`: right-looking numeric factorisation in 6×6 (or intrinsics-
//!   sized) dense blocks; `None` when the matrix is not positive-definite, the signal
//!   the LM loop answers with more damping;
//! - `Factor::solve`: forward and back substitution.

use crate::bundle::BlockPattern;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

pub(crate) struct Symbolic {
    order: Vec<usize>,          // position → block
    pos: Vec<usize>,            // block → position
    dims: Vec<usize>,           // by position
    col_ptr: Vec<usize>,        // column k's off-diagonal rows: rows[col_ptr[k]..col_ptr[k+1]]
    rows: Vec<u32>,             // ascending positions > k
    val_at: Vec<usize>,         // value offset of each off-diagonal block (dims[row] × dims[k], row-major)
    diag_at: Vec<usize>,        // value offset of each diagonal block (dims[k]²)
    n_vals: usize,
    #[allow(dead_code)] // reported by the timing test
    pub(crate) fill_blocks: usize, // off-diagonal blocks of L (A's lower triangle + fill)
}

pub(crate) struct Factor<'a> {
    sym: &'a Symbolic,
    vals: Vec<f64>,
}

impl Symbolic {
    /// Minimum-degree order and the pattern of L. `max_blocks` bounds the fill: past it
    /// the factorisation would cost more memory than it is worth, and `None` says so.
    pub(crate) fn new(pat: &BlockPattern, max_blocks: usize) -> Option<Symbolic> {
        let nb = pat.dims.len();
        // The block graph, without self loops, as sorted neighbour lists.
        let mut adj: Vec<Vec<u32>> = (0..nb).map(|r| {
            pat.cols[pat.row_ptr[r]..pat.row_ptr[r + 1]].iter().copied().filter(|&c| c as usize != r).collect()
        }).collect();
        let mut alive = vec![true; nb];
        let mut heap: BinaryHeap<Reverse<(usize, usize)>> = (0..nb).map(|v| Reverse((adj[v].len(), v))).collect();
        let mut order = Vec::with_capacity(nb);
        let mut cols: Vec<Vec<u32>> = vec![Vec::new(); nb]; // block → its later neighbours at elimination
        let mut mark = vec![usize::MAX; nb];
        let mut total = 0usize;
        while let Some(Reverse((deg, v))) = heap.pop() {
            if !alive[v] || deg != adj[v].len() { continue } // stale heap entry
            alive[v] = false;
            order.push(v);
            let nbrs: Vec<u32> = adj[v].iter().copied().filter(|&u| alive[u as usize]).collect();
            total += nbrs.len();
            if total > max_blocks { return None }
            // Eliminating v joins its neighbours into a clique.
            for &u in &nbrs {
                let u = u as usize;
                for &w in &adj[u] { mark[w as usize] = u }
                let mut grown: Vec<u32> = adj[u].iter().copied().filter(|&w| w as usize != v && alive[w as usize]).collect();
                for &w in &nbrs { if w as usize != u && mark[w as usize] != u { grown.push(w) } }
                grown.sort_unstable();
                adj[u] = grown;
                heap.push(Reverse((adj[u].len(), u)));
            }
            cols[v] = nbrs;
            adj[v] = Vec::new();
        }
        let mut pos = vec![0usize; nb];
        for (k, &b) in order.iter().enumerate() { pos[b] = k }
        let dims: Vec<usize> = order.iter().map(|&b| pat.dims[b]).collect();
        let mut col_ptr = Vec::with_capacity(nb + 1);
        col_ptr.push(0);
        let mut rows = Vec::with_capacity(total);
        for &b in &order {
            let mut r: Vec<u32> = cols[b].iter().map(|&u| pos[u as usize] as u32).collect();
            r.sort_unstable();
            rows.extend_from_slice(&r);
            col_ptr.push(rows.len());
        }
        let mut val_at = Vec::with_capacity(rows.len());
        let mut diag_at = vec![0usize; nb];
        let mut n_vals = 0;
        for k in 0..nb {
            diag_at[k] = n_vals;
            n_vals += dims[k] * dims[k];
            for &r in &rows[col_ptr[k]..col_ptr[k + 1]] {
                val_at.push(n_vals);
                n_vals += dims[r as usize] * dims[k];
            }
        }
        Some(Symbolic { order, pos, dims, col_ptr, rows, val_at, diag_at, n_vals, fill_blocks: total })
    }

    /// Bytes the numeric factor holds.
    pub(crate) fn factor_bytes(&self) -> usize { self.n_vals * 8 }

    pub(crate) fn factor(&self, pat: &BlockPattern, a: &[f64]) -> Option<Factor<'_>> {
        let nb = self.order.len();
        let mut v = vec![0f64; self.n_vals];
        // Scatter A's lower triangle (in elimination order) into L's pattern.
        for r in 0..nb {
            let pr = self.pos[r];
            for k in pat.row_ptr[r]..pat.row_ptr[r + 1] {
                let c = pat.cols[k] as usize;
                let pc = self.pos[c];
                if pr < pc { continue }
                let (rd, cd) = (pat.dims[r], pat.dims[c]);
                let src = &a[pat.val_at[k]..pat.val_at[k] + rd * cd];
                let dst = if pr == pc { self.diag_at[pc] } else { self.block_at(pr, pc) };
                v[dst..dst + rd * cd].copy_from_slice(src);
            }
        }
        // Right-looking: finish column k, then subtract its outer product from the later ones.
        let mut slot = vec![usize::MAX; nb]; // row position → value offset within the current target column
        for k in 0..nb {
            let dk = self.dims[k];
            let d0 = self.diag_at[k];
            if !chol_in_place(dk, &mut v[d0..d0 + dk * dk]) { return None }
            let (lo, hi) = (self.col_ptr[k], self.col_ptr[k + 1]);
            // L_ik = W_ik · L_kkᵀ⁻¹ (each row solved against the lower factor).
            for e in lo..hi {
                let di = self.dims[self.rows[e] as usize];
                let o = self.val_at[e];
                let (diag, blk) = split_pair(&mut v, d0, o, dk * dk, di * dk);
                for row in 0..di { trsv_lower_row(dk, diag, &mut blk[row * dk..(row + 1) * dk]) }
            }
            // W_ij −= L_ik · L_jkᵀ for rows i ≥ j of column k.
            for ej in lo..hi {
                let j = self.rows[ej] as usize;
                let dj = self.dims[j];
                for e in self.col_ptr[j]..self.col_ptr[j + 1] { slot[self.rows[e] as usize] = self.val_at[e] }
                let oj = self.val_at[ej];
                for ei in ej..hi {
                    let i = self.rows[ei] as usize;
                    let di = self.dims[i];
                    let oi = self.val_at[ei];
                    let target = if i == j { self.diag_at[j] } else { slot[i] };
                    debug_assert!(target != usize::MAX, "fill outside the symbolic pattern");
                    if di == 6 && dj == 6 && dk == 6 {
                        // Camera × camera: fixed sizes the compiler unrolls (nearly all the work).
                        let a: [f64; 36] = v[oi..oi + 36].try_into().unwrap();
                        let b: [f64; 36] = v[oj..oj + 36].try_into().unwrap();
                        let t: &mut [f64; 36] = (&mut v[target..target + 36]).try_into().unwrap();
                        sub_abt6(t, &a, &b);
                    } else {
                        for r in 0..di {
                            for c in 0..dj {
                                let mut s = 0.0;
                                for t in 0..dk { s += v[oi + r * dk + t] * v[oj + c * dk + t] }
                                v[target + r * dj + c] -= s;
                            }
                        }
                    }
                }
                for e in self.col_ptr[j]..self.col_ptr[j + 1] { slot[self.rows[e] as usize] = usize::MAX }
            }
        }
        Some(Factor { sym: self, vals: v })
    }

    fn block_at(&self, row: usize, col: usize) -> usize {
        let rs = &self.rows[self.col_ptr[col]..self.col_ptr[col + 1]];
        let k = rs.binary_search(&(row as u32)).expect("block outside L's pattern");
        self.val_at[self.col_ptr[col] + k]
    }
}

impl Factor<'_> {
    /// x with A x = b (b, x in the BlockPattern's own unknown order).
    pub(crate) fn solve(&self, pat: &BlockPattern, b: &[f64]) -> Vec<f64> {
        let s = self.sym;
        let nb = s.order.len();
        // Gather b into elimination order.
        let mut off = vec![0usize; nb + 1];
        for k in 0..nb { off[k + 1] = off[k] + s.dims[k] }
        let mut y = vec![0f64; pat.n];
        for (k, &blk) in s.order.iter().enumerate() {
            y[off[k]..off[k + 1]].copy_from_slice(&b[pat.offs[blk]..pat.offs[blk] + s.dims[k]]);
        }
        let v = &self.vals;
        // Forward: L z = y.
        for k in 0..nb {
            let dk = s.dims[k];
            let d0 = s.diag_at[k];
            for r in 0..dk {
                let mut t = y[off[k] + r];
                for c in 0..r { t -= v[d0 + r * dk + c] * y[off[k] + c] }
                y[off[k] + r] = t / v[d0 + r * dk + r];
            }
            for e in s.col_ptr[k]..s.col_ptr[k + 1] {
                let i = s.rows[e] as usize;
                let o = s.val_at[e];
                for r in 0..s.dims[i] {
                    let mut t = 0.0;
                    for c in 0..dk { t += v[o + r * dk + c] * y[off[k] + c] }
                    y[off[i] + r] -= t;
                }
            }
        }
        // Backward: Lᵀ x = z.
        for k in (0..nb).rev() {
            let dk = s.dims[k];
            for e in s.col_ptr[k]..s.col_ptr[k + 1] {
                let i = s.rows[e] as usize;
                let o = s.val_at[e];
                for c in 0..dk {
                    let mut t = 0.0;
                    for r in 0..s.dims[i] { t += v[o + r * dk + c] * y[off[i] + r] }
                    y[off[k] + c] -= t;
                }
            }
            let d0 = s.diag_at[k];
            for r in (0..dk).rev() {
                let mut t = y[off[k] + r];
                for c in r + 1..dk { t -= v[d0 + c * dk + r] * y[off[k] + c] }
                y[off[k] + r] = t / v[d0 + r * dk + r];
            }
        }
        let mut x = vec![0f64; pat.n];
        for (k, &blk) in s.order.iter().enumerate() {
            x[pat.offs[blk]..pat.offs[blk] + s.dims[k]].copy_from_slice(&y[off[k]..off[k + 1]]);
        }
        x
    }
}

// t −= a · bᵀ for 6×6 row-major blocks.
#[inline(always)]
fn sub_abt6(t: &mut [f64; 36], a: &[f64; 36], b: &[f64; 36]) {
    for r in 0..6 {
        let ar = [a[r * 6], a[r * 6 + 1], a[r * 6 + 2], a[r * 6 + 3], a[r * 6 + 4], a[r * 6 + 5]];
        for c in 0..6 {
            let br = &b[c * 6..c * 6 + 6];
            t[r * 6 + c] -= ar[0] * br[0] + ar[1] * br[1] + ar[2] * br[2] + ar[3] * br[3] + ar[4] * br[4] + ar[5] * br[5];
        }
    }
}

// Two disjoint slices of one buffer: [a, a+la) and [b, b+lb), a < b.
fn split_pair(v: &mut [f64], a: usize, b: usize, la: usize, lb: usize) -> (&[f64], &mut [f64]) {
    debug_assert!(a + la <= b);
    let (left, right) = v.split_at_mut(b);
    (&left[a..a + la], &mut right[..lb])
}

// Dense Cholesky of a d×d row-major block, lower factor in place (upper left as is).
fn chol_in_place(d: usize, m: &mut [f64]) -> bool {
    for j in 0..d {
        let mut s = m[j * d + j];
        for k in 0..j { s -= m[j * d + k] * m[j * d + k] }
        if !(s > 0.0) || !s.is_finite() { return false }
        let l = s.sqrt();
        m[j * d + j] = l;
        for i in j + 1..d {
            let mut t = m[i * d + j];
            for k in 0..j { t -= m[i * d + k] * m[j * d + k] }
            m[i * d + j] = t / l;
        }
    }
    true
}

// row ← row · L⁻ᵀ: solve x Lᵀ = row for x (L lower, d×d).
fn trsv_lower_row(d: usize, l: &[f64], row: &mut [f64]) {
    for c in 0..d {
        let mut t = row[c];
        for k in 0..c { t -= row[k] * l[c * d + k] }
        row[c] = t / l[c * d + c];
    }
}
