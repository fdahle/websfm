//! Sparse supernodal Cholesky of the reduced camera system (plan-sfm-scale ▸ S2).
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
//! - `Symbolic::new`: a minimum-degree elimination order on the block graph; the
//!   columns of L grouped into supernodes (consecutive columns with nearly the same
//!   rows below them, a few explicit zeros allowed), and each supernode's rows;
//! - `Symbolic::factor`: left-looking numeric factorisation of dense supernode panels
//!   (each takes its sources' updates in ascending order, which is what a right-looking
//!   factor applies). On the pool, the elimination tree's disjoint subtrees factor side
//!   by side, then the supernodes above them in waves, and a big one in row chunks (see
//!   `factor_panels`).
//!   An update is a run of long dot products over a panel's contiguous rows, where a
//!   column-by-column factor did many separate 6×6 products (1,600 aerial cameras,
//!   native: 0.83 s by columns); `None` when the matrix is not positive-definite, the
//!   signal the LM loop answers with more damping;
//! - `Factor::solve`: forward and back substitution.

use crate::bundle::BlockPattern;
use crate::par::{for_each_index, SyncPtr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::cmp::Reverse;
use std::collections::BinaryHeap;

// Supernode amalgamation: a column joins the supernode before it when it is that
// supernode's next row (its elimination-tree parent) and the explicit zeros the merge
// adds stay within this many blocks, or this share of the merged panel.
const RELAX_ZERO_BLOCKS: usize = 4;
const RELAX_ZERO_SHARE: f64 = 0.08;
const MAX_SUPERNODE_BLOCKS: usize = 96;
// A supernode's updates and row solves go to the pool from about this much work (a
// rough multiply count), below it the pool's dispatch would cost more than it saves.
const PAR_UPDATE_FLOPS: f64 = 2.0e6;
// The elimination tree is cut into subtree tasks of at most this share of the factor's
// work each (`Symbolic::schedule`).
const TASK_SHARE: f64 = 1.0 / 64.0;

thread_local! {
    // A pool thread's product buffer, kept between tasks.
    static SCRATCH: std::cell::RefCell<Vec<f64>> = const { std::cell::RefCell::new(Vec::new()) };
}

pub(crate) struct Symbolic {
    order: Vec<usize>,      // position → block
    dims: Vec<usize>,       // by position
    off: Vec<usize>,        // scalar offset of each position (nb + 1)
    sn_start: Vec<usize>,   // supernode s holds positions sn_start[s]..sn_start[s+1]
    sn_of: Vec<usize>,      // position → supernode
    rows_ptr: Vec<usize>,   // supernode s's rows below its columns: rows[rows_ptr[s]..rows_ptr[s+1]]
    rows: Vec<u32>,         // ascending positions
    rows_soff: Vec<usize>,  // scalar offset of each such row within its supernode's lower part
    width: Vec<usize>,      // scalar columns of supernode s
    height: Vec<usize>,     // scalar rows below them
    panel_at: Vec<usize>,   // value offset of supernode s's panel ((width + height) × width, row-major)
    // The updates each supernode t receives, in ascending source order: (s, i, j), s's
    // rows i..j being t's columns (src_ptr[t]..src_ptr[t+1] into src).
    src_ptr: Vec<usize>,
    src: Vec<(u32, u32, u32)>,
    n_vals: usize,
    #[allow(dead_code)] // reported by the timing test
    pub(crate) fill_blocks: usize, // blocks of L below the diagonal blocks, explicit zeros included
    sched: Sched,
}

// The order `factor_panels` runs the supernodes in (`Symbolic::schedule`): subtree tasks,
// each its supernodes ascending (task k: task_sn[task_ptr[k]..task_ptr[k + 1]]), then the
// supernodes above them in waves (a wave's supernodes have every child done).
#[derive(Default)]
struct Sched {
    task_ptr: Vec<usize>,
    task_sn: Vec<u32>,
    wave_ptr: Vec<usize>,
    wave_sn: Vec<u32>,
}

pub(crate) struct Factor<'a> {
    sym: &'a Symbolic,
    vals: Vec<f64>,
}

impl Symbolic {
    /// Minimum-degree order, supernodes and their rows. `max_blocks` bounds the fill:
    /// past it the factorisation would cost more memory than it is worth, and `None`
    /// says so.
    pub(crate) fn new(pat: &BlockPattern, max_blocks: usize) -> Option<Symbolic> {
        let nb = pat.dims.len();
        let graph: Vec<Vec<u32>> = (0..nb).map(|r| {
            pat.cols[pat.row_ptr[r]..pat.row_ptr[r + 1]].iter().copied().filter(|&c| c as usize != r).collect()
        }).collect();
        // Minimum degree. (Nested dissection by breadth-first level separators was tried
        // and gave 10–15 % more work on aerial camera graphs: a camera couples with
        // neighbours several cells away, so a level is a thick separator.)
        let (order, cols) = min_degree(&graph, max_blocks)?;
        let mut pos = vec![0usize; nb];
        for (k, &b) in order.iter().enumerate() { pos[b] = k }
        let dims: Vec<usize> = order.iter().map(|&b| pat.dims[b]).collect();
        let mut off = vec![0usize; nb + 1];
        for k in 0..nb { off[k + 1] = off[k] + dims[k] }
        // Column patterns in positions, ascending.
        let colpat: Vec<Vec<u32>> = order.iter().map(|&b| {
            let mut r: Vec<u32> = cols[b].iter().map(|&u| pos[u as usize] as u32).collect();
            r.sort_unstable();
            r
        }).collect();

        // ── Supernodes: consecutive columns, merged while the added zeros stay small.
        let mut sn_start = vec![0usize];
        let mut cur: Vec<u32> = colpat.first().cloned().unwrap_or_default(); // rows below the current supernode
        let mut width_blocks = 1usize;
        for k in 1..nb {
            let joinable = cur.first() == Some(&(k as u32)) && width_blocks < MAX_SUPERNODE_BLOCKS;
            if joinable {
                let rest = &cur[1..];
                let merged = union(rest, &colpat[k]);
                // Zeros: rows new to the existing columns, and rows column k lacks.
                let zeros = (merged.len() - rest.len()) * width_blocks + (merged.len() - colpat[k].len());
                let size = (width_blocks + 1) * (width_blocks + 1) / 2 + merged.len() * (width_blocks + 1);
                if zeros <= RELAX_ZERO_BLOCKS || (zeros as f64) <= RELAX_ZERO_SHARE * size as f64 {
                    cur = merged;
                    width_blocks += 1;
                    continue;
                }
            }
            sn_start.push(k);
            cur = colpat[k].clone();
            width_blocks = 1;
        }
        sn_start.push(nb);
        let n_sn = sn_start.len() - 1;
        let mut sn_of = vec![0usize; nb];
        for s in 0..n_sn { for k in sn_start[s]..sn_start[s + 1] { sn_of[k] = s } }

        // ── Supernode rows: the members' rows below the supernode, then closed under the
        // updates (an explicit zero in a panel still updates the rows it meets).
        let mut srows: Vec<Vec<u32>> = (0..n_sn).map(|s| {
            let last = sn_start[s + 1] as u32;
            let mut r: Vec<u32> = Vec::new();
            for k in sn_start[s]..sn_start[s + 1] { r = union(&r, &colpat[k]) }
            r.retain(|&x| x >= last);
            r
        }).collect();
        let mut blocks = 0usize;
        for s in 0..n_sn {
            let rs = std::mem::take(&mut srows[s]);
            // Group the rows by the supernode they fall in; each group's target needs every
            // later row of rs below its own columns.
            let mut i = 0;
            while i < rs.len() {
                let t = sn_of[rs[i] as usize];
                let last_t = sn_start[t + 1] as u32;
                let mut j = i;
                while j < rs.len() && sn_of[rs[j] as usize] == t { j += 1 }
                let below: Vec<u32> = rs[j..].iter().copied().filter(|&x| x >= last_t).collect();
                if !below.is_empty() { srows[t] = union(&srows[t], &below) }
                i = j;
            }
            blocks += rs.len() * (sn_start[s + 1] - sn_start[s]);
            if blocks > max_blocks { return None }
            srows[s] = rs;
        }

        let mut rows_ptr = Vec::with_capacity(n_sn + 1);
        rows_ptr.push(0);
        let mut rows = Vec::new();
        let mut rows_soff = Vec::new();
        let mut width = Vec::with_capacity(n_sn);
        let mut height = Vec::with_capacity(n_sn);
        let mut panel_at = Vec::with_capacity(n_sn);
        let mut n_vals = 0usize;
        for s in 0..n_sn {
            let w = off[sn_start[s + 1]] - off[sn_start[s]];
            let mut h = 0;
            for &r in &srows[s] { rows.push(r); rows_soff.push(h); h += dims[r as usize] }
            rows_ptr.push(rows.len());
            width.push(w);
            height.push(h);
            panel_at.push(n_vals);
            n_vals += (w + h) * w;
        }
        let mut by_t: Vec<Vec<(u32, u32, u32)>> = vec![Vec::new(); n_sn];
        for s in 0..n_sn {
            let (lo, hi) = (rows_ptr[s], rows_ptr[s + 1]);
            let mut i = lo;
            while i < hi {
                let t = sn_of[rows[i] as usize];
                let mut j = i;
                while j < hi && sn_of[rows[j] as usize] == t { j += 1 }
                by_t[t].push((s as u32, i as u32, j as u32));
                i = j;
            }
        }
        let mut src_ptr = vec![0usize];
        let mut src = Vec::new();
        for list in by_t { src.extend(list); src_ptr.push(src.len()) }
        let mut sym = Symbolic { order, dims, off, sn_start, sn_of, rows_ptr, rows, rows_soff, width, height, panel_at, src_ptr, src, n_vals,
            fill_blocks: blocks, sched: Sched::default() };
        sym.sched = sym.schedule(TASK_SHARE);
        Some(sym)
    }

    // Cut the elimination tree into subtree tasks of at most `share` of the work each (the
    // largest such subtrees), the supernodes above them into waves by height. Depends on
    // the tree alone, not on the thread count (the bits do not depend on it either way).
    fn schedule(&self, share: f64) -> Sched {
        let n_sn = self.width.len();
        let (parent, work) = self.tree();
        let mut sub = work.clone();
        for s in 0..n_sn { if let Some(p) = parent[s] { sub[p] += sub[s] } }
        let cut = share * sub.iter().zip(&parent).filter(|(_, p)| p.is_none()).map(|(w, _)| w).sum::<f64>();
        // A supernode is in the top when its subtree is over the cut (then so is its
        // parent's); a task is a subtree under the cut whose parent is in the top, or a root.
        let in_top: Vec<bool> = sub.iter().map(|&w| w > cut).collect();
        let mut task_of = vec![u32::MAX; n_sn];
        let mut task_root: Vec<usize> = Vec::new();
        for s in (0..n_sn).rev() {
            if in_top[s] { continue }
            match parent[s] {
                Some(p) if !in_top[p] => task_of[s] = task_of[p],
                _ => { task_of[s] = task_root.len() as u32; task_root.push(s) }
            }
        }
        // Tasks largest first (the pool balances better), each one's supernodes ascending.
        let mut rank: Vec<usize> = (0..task_root.len()).collect();
        rank.sort_by(|&a, &b| sub[task_root[b]].total_cmp(&sub[task_root[a]]).then(a.cmp(&b)));
        let mut pos = vec![0usize; task_root.len()];
        for (k, &r) in rank.iter().enumerate() { pos[r] = k }
        let mut task_ptr = vec![0usize; task_root.len() + 1];
        for s in 0..n_sn { if !in_top[s] { task_ptr[pos[task_of[s] as usize] + 1] += 1 } }
        for k in 0..task_root.len() { task_ptr[k + 1] += task_ptr[k] }
        let mut fill = task_ptr.clone();
        let mut task_sn = vec![0u32; task_ptr[task_root.len()]];
        for s in 0..n_sn { if !in_top[s] { let k = pos[task_of[s] as usize]; task_sn[fill[k]] = s as u32; fill[k] += 1 } }
        // Waves: a top supernode's height is one more than its highest top child's.
        let mut height = vec![0usize; n_sn];
        let mut n_waves = 0;
        for s in 0..n_sn {
            if !in_top[s] { continue }
            height[s] += 1;
            n_waves = n_waves.max(height[s]);
            if let Some(p) = parent[s] { height[p] = height[p].max(height[s]) }
        }
        let mut wave_ptr = vec![0usize; n_waves + 1];
        for s in 0..n_sn { if in_top[s] { wave_ptr[height[s]] += 1 } }
        for k in 0..n_waves { wave_ptr[k + 1] += wave_ptr[k] }
        let mut fill = wave_ptr.clone();
        let mut wave_sn = vec![0u32; wave_ptr[n_waves]];
        for s in 0..n_sn { if in_top[s] { let k = height[s] - 1; wave_sn[fill[k]] = s as u32; fill[k] += 1 } }
        Sched { task_ptr, task_sn, wave_ptr, wave_sn }
    }

    /// Floating-point operations of one numeric factorisation (the timing test).
    #[allow(dead_code)]
    pub(crate) fn flops(&self) -> f64 {
        let mut f = 0.0;
        for s in 0..self.width.len() {
            let (w, h) = (self.width[s] as f64, self.height[s] as f64);
            f += w * w * w / 3.0 + h * w * w;
            let (lo, hi) = (self.rows_ptr[s], self.rows_ptr[s + 1]);
            let mut i = lo;
            while i < hi {
                let t = self.sn_of[self.rows[i] as usize];
                let mut j = i;
                while j < hi && self.sn_of[self.rows[j] as usize] == t { j += 1 }
                let r0 = self.rows_soff[i] as f64;
                let c_end = if j < hi { self.rows_soff[j] as f64 } else { h };
                let (m, gc) = (h - r0, c_end - r0);
                f += 2.0 * (m * gc - gc * gc / 2.0) * w;
                i = j;
            }
        }
        f
    }

    /// Supernode count and mean width in blocks (the timing test reports them).
    #[allow(dead_code)]
    pub(crate) fn supernode_stats(&self) -> (usize, f64) {
        let n = self.width.len();
        (n, self.order.len() as f64 / n.max(1) as f64)
    }

    /// Bytes the numeric factor holds.
    pub(crate) fn factor_bytes(&self) -> usize { self.n_vals * 8 }

    // Each supernode's parent in the elimination tree (the supernode of its first row
    // below; None for a root), and the work it does: its own Cholesky and row solves and
    // the updates it takes from its sources (`flops` counts the same, by source).
    fn tree(&self) -> (Vec<Option<usize>>, Vec<f64>) {
        let n_sn = self.width.len();
        let parent = (0..n_sn).map(|s| (self.rows_ptr[s] < self.rows_ptr[s + 1]).then(|| self.sn_of[self.rows[self.rows_ptr[s]] as usize])).collect();
        let mut work: Vec<f64> = (0..n_sn).map(|t| { let (w, h) = (self.width[t] as f64, self.height[t] as f64); w * w * w / 3.0 + h * w * w }).collect();
        for t in 0..n_sn {
            for &(s, i, j) in &self.src[self.src_ptr[t]..self.src_ptr[t + 1]] {
                let (s, i, j) = (s as usize, i as usize, j as usize);
                let (ws, hs) = (self.width[s] as f64, self.height[s]);
                let r0 = self.rows_soff[i] as f64;
                let c_end = if j < self.rows_ptr[s + 1] { self.rows_soff[j] as f64 } else { hs as f64 };
                let (m, gc) = (hs as f64 - r0, c_end - r0);
                work[t] += 2.0 * (m * gc - gc * gc / 2.0) * ws;
            }
        }
        (parent, work)
    }

    /// The shape of the supernodal elimination tree, for the timing tests: how much of the
    /// factor's work could run side by side.
    #[allow(dead_code)]
    pub(crate) fn tree_shape(&self) -> String {
        let n_sn = self.width.len();
        let (parent, work) = self.tree();
        let total: f64 = work.iter().sum();
        // Depth from the root, subtree work, and the critical path (the most work on one
        // chain from a leaf to a root): a child precedes its parent.
        let mut depth = vec![0usize; n_sn];
        for s in (0..n_sn).rev() { if let Some(p) = parent[s] { depth[s] = depth[p] + 1 } }
        let mut sub = work.clone();
        let mut cp = work.clone();
        let mut kids = vec![0usize; n_sn];
        for s in 0..n_sn {
            if let Some(p) = parent[s] {
                sub[p] += sub[s];
                kids[p] += 1;
                if cp[s] + work[p] > cp[p] { cp[p] = cp[s] + work[p] }
            }
        }
        let roots: Vec<usize> = (0..n_sn).filter(|&s| parent[s].is_none()).collect();
        let crit = roots.iter().map(|&r| cp[r]).fold(0.0, f64::max);
        let max_depth = depth.iter().copied().max().unwrap_or(0);
        let big: f64 = (0..n_sn).filter(|&t| work[t] >= PAR_UPDATE_FLOPS).map(|t| work[t]).sum();
        let mut out = format!("{n_sn} supernodes, {} roots, work {:.3} GFLOP, depth {max_depth}, critical path {:.3} GFLOP ({:.1}% of the work, bound {:.1}×); supernodes ≥ PAR_UPDATE_FLOPS hold {:.1}%; branching nodes {}\n",
            roots.len(), total / 1e9, crit / 1e9, 100.0 * crit / total, total / crit.max(1.0), 100.0 * big / total,
            kids.iter().filter(|&&k| k > 1).count());
        // Work by depth, in ten bands of equal depth.
        let bands = 10usize;
        let mut by = vec![(0.0f64, 0usize); bands];
        for s in 0..n_sn { let b = (depth[s] * bands / (max_depth + 1)).min(bands - 1); by[b].0 += work[s]; by[b].1 += 1 }
        out += "  work by depth band (root first): ";
        for (b, &(w, c)) in by.iter().enumerate() { out += &format!("{}–{}: {:.1}% ({c}) ", b * (max_depth + 1) / bands, (b + 1) * (max_depth + 1) / bands, 100.0 * w / total) }
        out += "\n";
        // Cut into subtree tasks of at most total / k work: the top (supernodes above
        // every task) runs as today.
        for k in [8usize, 16, 32, 64, 128] {
            let cut = total / k as f64;
            let mut top = 0.0;
            let mut in_top = vec![false; n_sn];
            let mut tasks: Vec<f64> = Vec::new();
            let mut stack = roots.clone();
            let mut children: Vec<Vec<usize>> = vec![Vec::new(); n_sn];
            for s in 0..n_sn { if let Some(p) = parent[s] { children[p].push(s) } }
            while let Some(s) = stack.pop() {
                if sub[s] <= cut { tasks.push(sub[s]) } else { top += work[s]; in_top[s] = true; stack.extend(&children[s]) }
            }
            // The top's own critical path, and its height (waves of supernodes whose
            // children are done).
            let (mut cpt, mut ht) = (vec![0.0f64; n_sn], vec![0usize; n_sn]);
            let (mut top_cp, mut waves) = (0.0f64, 0usize);
            for s in 0..n_sn {
                if !in_top[s] { continue }
                cpt[s] += work[s];
                ht[s] += 1;
                top_cp = top_cp.max(cpt[s]);
                waves = waves.max(ht[s]);
                if let Some(p) = parent[s] { cpt[p] = cpt[p].max(cpt[s]); ht[p] = ht[p].max(ht[s]) }
            }
            let largest = tasks.iter().copied().fold(0.0, f64::max);
            out += &format!("  cut total/{k}: {} tasks holding {:.1}% (largest {:.1}%), top {:.1}% in {} supernodes, its critical path {:.1}%, {waves} waves\n", tasks.len(),
                100.0 * (total - top) / total, 100.0 * largest / total, 100.0 * top / total, in_top.iter().filter(|&&b| b).count(), 100.0 * top_cp / total);
        }
        out
    }

    // Panel row of block position `b` in supernode `t` (its own columns first, then its rows).
    fn panel_row(&self, t: usize, b: usize) -> usize {
        if self.sn_of[b] == t { return self.off[b] - self.off[self.sn_start[t]] }
        let rs = &self.rows[self.rows_ptr[t]..self.rows_ptr[t + 1]];
        let e = rs.binary_search(&(b as u32)).expect("row outside the supernode's structure");
        self.width[t] + self.rows_soff[self.rows_ptr[t] + e]
    }

    // Supernode t's panel rows cut at its block boundaries into up to 32 chunks of about
    // equal height (a source's update to one block of t then lies in one chunk).
    fn row_chunks(&self, t: usize) -> Vec<(usize, usize)> {
        let (w, h) = (self.width[t], self.height[t]);
        let mut cuts = Vec::new();
        for k in self.sn_start[t]..self.sn_start[t + 1] { cuts.push(self.off[k] - self.off[self.sn_start[t]]) }
        for e in self.rows_ptr[t]..self.rows_ptr[t + 1] { cuts.push(w + self.rows_soff[e]) }
        let step = (w + h).div_ceil(32).max(1);
        let mut out = Vec::new();
        let mut lo = 0;
        for &c in &cuts[1..] {
            if c - lo >= step { out.push((lo, c)); lo = c }
        }
        out.push((lo, w + h));
        out
    }

    // Source s's update to supernode t (its rows i..j are t's columns), on t's panel rows
    // rows.0..rows.1 only: the dense product of s's rows from i on with rows i..j, then
    // scattered into t. `src` is s's panel; `dst` is t's panel.
    #[allow(clippy::too_many_arguments)]
    fn update(&self, src: &[f64], s: usize, i: usize, j: usize, t: usize, dst: SyncPtr<f64>, rows: (usize, usize), tmp: &mut Vec<f64>) {
        let (w, h) = (self.width[s], self.height[s]);
        let hi = self.rows_ptr[s + 1];
        let wt = self.width[t];
        let t0 = self.off[self.sn_start[t]];
        // The source rows whose destination lies in `rows` (ascending, so a run).
        let mut e_lo = i;
        while e_lo < hi && self.panel_row(t, self.rows[e_lo] as usize) < rows.0 { e_lo += 1 }
        let mut e_hi = e_lo;
        while e_hi < hi && self.panel_row(t, self.rows[e_hi] as usize) < rows.1 { e_hi += 1 }
        if e_lo == e_hi { return }
        let r0 = self.rows_soff[i];
        let c_end = if j < hi { self.rows_soff[j] } else { h };
        let gc = c_end - r0;
        let a_lo = (self.rows_soff[e_lo] - r0) & !1; // the row pairs of the whole product
        let a_hi = if e_hi < hi { self.rows_soff[e_hi] } else { h } - r0;
        tmp.clear();
        tmp.resize((a_hi - a_lo) * gc, 0.0);
        gemm_nt_rows(tmp, &src[w * w + r0 * w..w * w + h * w], &src[w * w + r0 * w..w * w + c_end * w], gc, w, a_lo, a_hi);
        for ec in i..j {
            let cb = self.rows[ec] as usize;
            let (cd, coff, cc) = (self.dims[cb], self.off[cb] - t0, self.rows_soff[ec] - r0);
            for er in ec.max(e_lo)..e_hi {
                let rd = self.dims[self.rows[er] as usize];
                let (rr, drow) = (self.rows_soff[er] - r0 - a_lo, self.panel_row(t, self.rows[er] as usize));
                for ii in 0..rd {
                    let out = (drow + ii) * wt + coff;
                    let from = (rr + ii) * gc + cc;
                    // SAFETY: t's rows `rows` are written by this call alone.
                    for jj in 0..cd { unsafe { *dst.at(out + jj) -= tmp[from + jj] } }
                }
            }
        }
    }

    pub(crate) fn factor(&self, pat: &BlockPattern, a: &[f64]) -> Option<Factor<'_>> {
        self.factor_with(pat, a, PAR_UPDATE_FLOPS, true, Vec::new()).ok()
    }

    /// `factor` into `buf`'s storage (cleared first), handed back on failure: a solve that
    /// factors every LM try keeps one allocation instead of one per try. In wasm32's
    /// linear memory, which never shrinks, a fresh factor and a fresh copy of S each try
    /// fragmented it: BAL final-961 grew to 2.2 GB for a 1.8 GB peak.
    pub(crate) fn factor_reusing(&self, pat: &BlockPattern, a: &[f64], buf: Vec<f64>) -> Result<Factor<'_>, Vec<f64>> {
        self.factor_with(pat, a, PAR_UPDATE_FLOPS, true, buf)
    }

    // `par_flops`: the work from which a supernode is cut into row chunks (tests: 0);
    // `tree`: by the elimination tree's tasks and waves, else one supernode after another.
    fn factor_with(&self, pat: &BlockPattern, a: &[f64], par_flops: f64, tree: bool, buf: Vec<f64>) -> Result<Factor<'_>, Vec<f64>> {
        let mut v = self.scatter(pat, a, buf);
        if self.factor_panels(&mut v, par_flops, tree).is_none() { return Err(v) }
        Ok(Factor { sym: self, vals: v })
    }

    /// The timing tests: one factorisation's scatter and numeric factor in seconds, by the
    /// tree (`tree`) or one supernode after another.
    #[cfg(test)]
    pub(crate) fn factor_timed(&self, pat: &BlockPattern, a: &[f64], tree: bool) -> (f64, f64, Vec<f64>) {
        let t = std::time::Instant::now();
        let mut v = self.scatter(pat, a, Vec::new());
        let ts = t.elapsed().as_secs_f64();
        let t = std::time::Instant::now();
        self.factor_panels(&mut v, PAR_UPDATE_FLOPS, tree).unwrap();
        (ts, t.elapsed().as_secs_f64(), v)
    }

    #[cfg(test)]
    pub(crate) fn set_task_share(&mut self, share: f64) { self.sched = self.schedule(share) }

    #[cfg(test)]
    pub(crate) fn with_vals_solve(&self, vals: Vec<f64>, pat: &BlockPattern, b: &[f64]) -> (Vec<f64>, Vec<f64>) {
        let f = Factor { sym: self, vals };
        let x = f.solve(pat, b);
        (x, f.vals)
    }

    fn scatter(&self, pat: &BlockPattern, a: &[f64], mut v: Vec<f64>) -> Vec<f64> {
        let nb = self.order.len();
        v.clear();
        v.resize(self.n_vals, 0.0);
        let mut pos = vec![0usize; nb];
        for (k, &b) in self.order.iter().enumerate() { pos[b] = k }
        // Scatter A into the panels, reading only its lower triangle (block row ≥ block
        // column; the caller may leave the upper one empty): a block lands as it is when
        // its row comes later in the elimination order, transposed when its column does.
        for r in 0..nb {
            for k in pat.row_ptr[r]..pat.row_ptr[r + 1] {
                let c = pat.cols[k] as usize;
                if c > r { continue }
                let (rd, cd) = (pat.dims[r], pat.dims[c]);
                let blk = &a[pat.val_at[k]..pat.val_at[k] + rd * cd];
                let (pr, pc) = (pos[r], pos[c]);
                let (hi, lo, transposed) = if pr >= pc { (pr, pc, false) } else { (pc, pr, true) };
                let t = self.sn_of[lo];
                let w = self.width[t];
                let row0 = self.panel_row(t, hi);
                let col0 = self.off[lo] - self.off[self.sn_start[t]];
                let base = self.panel_at[t];
                if !transposed {
                    for i in 0..rd {
                        let dst = base + (row0 + i) * w + col0;
                        v[dst..dst + cd].copy_from_slice(&blk[i * cd..(i + 1) * cd]);
                    }
                } else {
                    // Block (c, r) = blockᵀ: cd rows of rd.
                    for i in 0..cd { for j in 0..rd { v[base + (row0 + i) * w + col0 + j] = blk[j * cd + i] } }
                }
            }
        }
        v
    }

    // Left-looking, by the elimination tree: a supernode reads only the panels of its
    // descendants, so the subtree tasks (`tasks`) factor side by side on the pool, then the
    // supernodes above them (`top`) in waves, each wave's supernodes once their children
    // are done. Every panel has one writer and takes its sources in ascending order, so
    // the bits are those of the loop over 0..n_sn, whatever runs where (`tree` false runs
    // that loop; the tests compare both).
    fn factor_panels(&self, v: &mut [f64], par_flops: f64, tree: bool) -> Option<()> {
        let vp = SyncPtr::of(v);
        if !tree {
            for t in 0..self.width.len() { if !self.factor_one(vp, t, par_flops) { return None } }
            return Some(())
        }
        let failed = AtomicBool::new(false);
        let sch = &self.sched;
        for_each_index(sch.task_ptr.len() - 1, |k| {
            for &t in &sch.task_sn[sch.task_ptr[k]..sch.task_ptr[k + 1]] {
                if failed.load(Ordering::Relaxed) { return }
                if !self.factor_one(vp, t as usize, par_flops) { failed.store(true, Ordering::Relaxed); return }
            }
        });
        for wv in 0..sch.wave_ptr.len() - 1 {
            if failed.load(Ordering::Relaxed) { return None }
            let wave = &sch.wave_sn[sch.wave_ptr[wv]..sch.wave_ptr[wv + 1]];
            if wave.len() == 1 {
                if !self.factor_one(vp, wave[0] as usize, par_flops) { return None }
            } else {
                for_each_index(wave.len(), |k| {
                    if !self.factor_one(vp, wave[k] as usize, par_flops) { failed.store(true, Ordering::Relaxed) }
                });
            }
        }
        (!failed.load(Ordering::Relaxed)).then_some(())
    }

    // Supernode t: its sources' updates in ascending order, then its dense Cholesky and
    // row solves; false when it is not positive-definite. Its panel is written here
    // alone, and its sources' panels are complete (they are its descendants).
    fn factor_one(&self, vp: SyncPtr<f64>, t: usize, par_flops: f64) -> bool {
        let (w, h, p) = (self.width[t], self.height[t], self.panel_at[t]);
        // SAFETY: t's panel has this one writer; nobody reads it until t is done.
        let panel = unsafe { vp.slice(p, (w + h) * w) };
        let sources = &self.src[self.src_ptr[t]..self.src_ptr[t + 1]];
        // SAFETY: a source is a descendant of t, finished before t starts, and only read.
        let src_panel = |s: usize| unsafe { vp.slice_ref(self.panel_at[s], (self.width[s] + self.height[s]) * self.width[s]) };
        // t's panel rows in blocks: its own columns, then its rows below.
        let work: f64 = sources.iter().map(|&(s, i, _)| {
            let (hs, ws) = (self.height[s as usize], self.width[s as usize]);
            ((hs - self.rows_soff[i as usize]) * ws) as f64
        }).sum::<f64>() * (w + h) as f64;
        let chunks = if work >= par_flops { self.row_chunks(t) } else { vec![(0, w + h)] };
        let dst = SyncPtr::of(panel);
        if chunks.len() > 1 {
            for_each_index(chunks.len(), |k| SCRATCH.with(|sc| {
                let tmp = &mut *sc.borrow_mut();
                for &(s, i, j) in sources { self.update(src_panel(s as usize), s as usize, i as usize, j as usize, t, dst, chunks[k], tmp) }
            }));
        } else {
            // No pool call while the scratch is borrowed (a waiting thread may run a task
            // that borrows it).
            SCRATCH.with(|sc| {
                let tmp = &mut *sc.borrow_mut();
                for &(s, i, j) in sources { self.update(src_panel(s as usize), s as usize, i as usize, j as usize, t, dst, (0, w + h), tmp) }
            });
        }
        // The diagonal part: a dense Cholesky.
        if !chol_in_place(w, &mut panel[..w * w]) { return false }
        // The rows below: x ← x · L⁻ᵀ, each row on its own.
        let (diag, below) = panel.split_at_mut(w * w);
        if work >= par_flops && h >= 64 {
            let (bp, n_chunk) = (SyncPtr::of(below), h.div_ceil(32));
            for_each_index(h.div_ceil(n_chunk), |k| {
                for r in k * n_chunk..((k + 1) * n_chunk).min(h) {
                    // SAFETY: row r belongs to chunk k alone.
                    let row = unsafe { bp.slice(r * w, w) };
                    trsv_lower_row(w, diag, row)
                }
            });
        } else {
            for r in 0..h { trsv_lower_row(w, diag, &mut below[r * w..(r + 1) * w]) }
        }
        true
    }
}

impl Factor<'_> {
    /// The factor's storage, for the next `factor_reusing`.
    pub(crate) fn into_vals(self) -> Vec<f64> { self.vals }

    /// x with A x = b (b, x in the BlockPattern's own unknown order).
    pub(crate) fn solve(&self, pat: &BlockPattern, b: &[f64]) -> Vec<f64> {
        let s = self.sym;
        let mut y = vec![0f64; pat.n];
        for (k, &blk) in s.order.iter().enumerate() {
            y[s.off[k]..s.off[k + 1]].copy_from_slice(&b[pat.offs[blk]..pat.offs[blk] + s.dims[k]]);
        }
        let v = &self.vals;
        let n_sn = s.width.len();
        let mut gather: Vec<f64> = Vec::new();
        // Forward: L z = y.
        for t in 0..n_sn {
            let (w, h, p) = (s.width[t], s.height[t], s.panel_at[t]);
            let y0 = s.off[s.sn_start[t]];
            for r in 0..w {
                let mut acc = y[y0 + r];
                for c in 0..r { acc -= v[p + r * w + c] * y[y0 + c] }
                y[y0 + r] = acc / v[p + r * w + r];
            }
            if h == 0 { continue }
            let ys: Vec<f64> = y[y0..y0 + w].to_vec();
            for e in s.rows_ptr[t]..s.rows_ptr[t + 1] {
                let rb = s.rows[e] as usize;
                let base = p + (w + s.rows_soff[e]) * w;
                for i in 0..s.dims[rb] { y[s.off[rb] + i] -= dot(&v[base + i * w..base + (i + 1) * w], &ys) }
            }
        }
        // Backward: Lᵀ x = z.
        for t in (0..n_sn).rev() {
            let (w, h, p) = (s.width[t], s.height[t], s.panel_at[t]);
            let y0 = s.off[s.sn_start[t]];
            if h > 0 {
                gather.clear();
                for e in s.rows_ptr[t]..s.rows_ptr[t + 1] {
                    let rb = s.rows[e] as usize;
                    gather.extend_from_slice(&y[s.off[rb]..s.off[rb] + s.dims[rb]]);
                }
                for c in 0..w {
                    let mut acc = 0.0;
                    for r in 0..h { acc += v[p + (w + r) * w + c] * gather[r] }
                    y[y0 + c] -= acc;
                }
            }
            for r in (0..w).rev() {
                let mut acc = y[y0 + r];
                for c in r + 1..w { acc -= v[p + c * w + r] * y[y0 + c] }
                y[y0 + r] = acc / v[p + r * w + r];
            }
        }
        let mut x = vec![0f64; pat.n];
        for (k, &blk) in s.order.iter().enumerate() {
            x[pat.offs[blk]..pat.offs[blk] + s.dims[k]].copy_from_slice(&y[s.off[k]..s.off[k + 1]]);
        }
        x
    }
}

// Minimum degree on the block graph: repeatedly eliminate a node of least current
// degree, joining its neighbours into a clique. → (order, each block's later neighbours
// at its elimination), None past `max_blocks` of fill.
fn min_degree(graph: &[Vec<u32>], max_blocks: usize) -> Option<(Vec<usize>, Vec<Vec<u32>>)> {
    let nb = graph.len();
    let mut adj: Vec<Vec<u32>> = graph.to_vec();
    let mut alive = vec![true; nb];
    let mut heap: BinaryHeap<Reverse<(usize, usize)>> = (0..nb).map(|v| Reverse((adj[v].len(), v))).collect();
    let mut order = Vec::with_capacity(nb);
    let mut cols: Vec<Vec<u32>> = vec![Vec::new(); nb];
    let mut mark = vec![usize::MAX; nb];
    let mut total = 0usize;
    while let Some(Reverse((deg, v))) = heap.pop() {
        if !alive[v] || deg != adj[v].len() { continue } // stale heap entry
        alive[v] = false;
        order.push(v);
        let nbrs: Vec<u32> = adj[v].iter().copied().filter(|&u| alive[u as usize]).collect();
        total += nbrs.len();
        if total > max_blocks { return None }
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
    Some((order, cols))
}

fn union(a: &[u32], b: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i] < b[j] { out.push(a[i]); i += 1 } else if b[j] < a[i] { out.push(b[j]); j += 1 } else { out.push(a[i]); i += 1; j += 1 }
    }
    out.extend_from_slice(&a[i..]);
    out.extend_from_slice(&b[j..]);
    out
}

// c[i·n + j] = Σ_k a[i·w + k] · b[j·w + k] (i < m, j < n, j ≤ i): the update
// product of a supernode, a and b runs of its panel's rows starting at the same row,
// so only the lower part is needed (the target reads nothing above its diagonal).
// 2×4 tiles share their loads; on wasm the k loop runs two at a time in SIMD lanes.
#[cfg(test)]
fn gemm_nt(c: &mut [f64], a: &[f64], b: &[f64], m: usize, n: usize, w: usize) {
    gemm_nt_rows(c, a, b, n, w, 0, m)
}

// Rows lo..hi of gemm_nt's product (c holds them from its row 0), computed exactly as the
// whole product computes them: `lo` must be even, so the row pairs are the same pairs.
fn gemm_nt_rows(c: &mut [f64], a: &[f64], b: &[f64], n: usize, w: usize, lo: usize, hi: usize) {
    debug_assert!(lo.is_multiple_of(2));
    let mut i = lo;
    while i + 2 <= hi {
        let (x0, x1) = (&a[i * w..(i + 1) * w], &a[(i + 1) * w..(i + 2) * w]);
        let (r0, r1) = ((i - lo) * n, (i + 1 - lo) * n);
        let mut j = 0;
        let n_row = n.min(i + 2); // columns this row pair needs (j ≤ i + 1)
        while j + 4 <= n_row {
            let y = [&b[j * w..(j + 1) * w], &b[(j + 1) * w..(j + 2) * w], &b[(j + 2) * w..(j + 3) * w], &b[(j + 3) * w..(j + 4) * w]];
            let s = tile_2x4(x0, x1, y, w);
            c[r0 + j..r0 + j + 4].copy_from_slice(&s[0]);
            c[r1 + j..r1 + j + 4].copy_from_slice(&s[1]);
            j += 4;
        }
        while j < n_row {
            let y = &b[j * w..(j + 1) * w];
            c[r0 + j] = dot(x0, y);
            c[r1 + j] = dot(x1, y);
            j += 1;
        }
        i += 2;
    }
    while i < hi {
        let x = &a[i * w..(i + 1) * w];
        for j in 0..n.min(i + 1) { c[(i - lo) * n + j] = dot(x, &b[j * w..(j + 1) * w]) }
        i += 1;
    }
}

#[cfg(target_arch = "wasm32")]
#[inline(always)]
fn tile_2x4(x0: &[f64], x1: &[f64], y: [&[f64]; 4], w: usize) -> [[f64; 4]; 2] {
    use core::arch::wasm32::*;
    let z = f64x2_splat(0.0);
    let mut acc = [[z; 4]; 2];
    let mut k = 0;
    // SAFETY: every load reads two f64 at k, k+1 < w within slices of length w.
    unsafe {
        while k + 2 <= w {
            let a0 = v128_load(x0.as_ptr().add(k) as *const v128);
            let a1 = v128_load(x1.as_ptr().add(k) as *const v128);
            for (q, yq) in y.iter().enumerate() {
                let bq = v128_load(yq.as_ptr().add(k) as *const v128);
                acc[0][q] = f64x2_add(acc[0][q], f64x2_mul(a0, bq));
                acc[1][q] = f64x2_add(acc[1][q], f64x2_mul(a1, bq));
            }
            k += 2;
        }
    }
    let mut out = [[0f64; 4]; 2];
    for r in 0..2 { for q in 0..4 { out[r][q] = f64x2_extract_lane::<0>(acc[r][q]) + f64x2_extract_lane::<1>(acc[r][q]) } }
    if k < w {
        for q in 0..4 { out[0][q] += x0[k] * y[q][k]; out[1][q] += x1[k] * y[q][k] }
    }
    out
}

#[cfg(not(target_arch = "wasm32"))]
#[inline(always)]
fn tile_2x4(x0: &[f64], x1: &[f64], y: [&[f64]; 4], w: usize) -> [[f64; 4]; 2] {
    let mut out = [[0f64; 4]; 2];
    for k in 0..w {
        let (p, q) = (x0[k], x1[k]);
        for (t, yt) in y.iter().enumerate() { out[0][t] += p * yt[k]; out[1][t] += q * yt[k] }
    }
    out
}

// Four independent sums, so the compiler can keep them in vector lanes.
#[inline(always)]
fn dot(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len().min(b.len());
    let (a, b) = (&a[..n], &b[..n]);
    let mut s = [0f64; 4];
    let mut k = 0;
    while k + 4 <= n {
        s[0] += a[k] * b[k]; s[1] += a[k + 1] * b[k + 1]; s[2] += a[k + 2] * b[k + 2]; s[3] += a[k + 3] * b[k + 3];
        k += 4;
    }
    let mut t = (s[0] + s[1]) + (s[2] + s[3]);
    while k < n { t += a[k] * b[k]; k += 1 }
    t
}

// Dense Cholesky of a d×d row-major block, lower factor in place (upper left as is).
fn chol_in_place(d: usize, m: &mut [f64]) -> bool {
    for j in 0..d {
        let s = m[j * d + j] - dot(&m[j * d..j * d + j], &m[j * d..j * d + j]);
        if !(s > 0.0) || !s.is_finite() { return false }
        let l = s.sqrt();
        m[j * d + j] = l;
        for i in j + 1..d {
            let t = m[i * d + j] - dot(&m[i * d..i * d + j], &m[j * d..j * d + j]);
            m[i * d + j] = t / l;
        }
    }
    true
}

// row ← row · L⁻ᵀ: solve x Lᵀ = row for x (L lower, d×d).
fn trsv_lower_row(d: usize, l: &[f64], row: &mut [f64]) {
    for c in 0..d {
        let t = row[c] - dot(&row[..c], &l[c * d..c * d + c]);
        row[c] = t / l[c * d + c];
    }
}

// Measurement hook (cargo feature `bench`, never in the app's build): factor an aerial
// block's reduced system (rows × cols cameras, coupled within `radius`, one intrinsics
// group) `reps` times, so the wasm factorisation can be timed from JS.
#[cfg(feature = "bench")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn bench_sparse_chol(rows: usize, cols: usize, radius: isize, reps: usize) -> f64 {
    let n_cam = rows * cols;
    let mut dims = vec![6usize; n_cam];
    dims.push(6);
    let pat = BlockPattern::new(dims, |r, touch| {
        if r == n_cam { for c in 0..=n_cam { touch(c) } return }
        let (y, x) = ((r / cols) as isize, (r % cols) as isize);
        for dy in -radius..=radius { for dx in -radius..=radius {
            let (yy, xx) = (y + dy, x + dx);
            if yy >= 0 && xx >= 0 && (yy as usize) < rows && (xx as usize) < cols { touch(yy as usize * cols + xx as usize) }
        }}
        touch(n_cam);
    });
    // A diagonally dominant fill (the cost does not depend on the values).
    let mut vals = vec![0f64; pat.n_vals];
    let mut seed = 1u64;
    for r in 0..pat.dims.len() {
        for k in pat.row_ptr[r]..pat.row_ptr[r + 1] {
            let c = pat.cols[k] as usize;
            if c > r { continue }
            let (rd, cd) = (pat.dims[r], pat.dims[c]);
            let (rc, cr) = (pat.val_at[k], pat.at(c, r));
            for i in 0..rd { for j in 0..cd {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                let v = if c == r && j < i { vals[rc + j * cd + i] } else { ((seed >> 40) as f64 / (1u64 << 24) as f64 - 0.5) * 0.1 };
                vals[rc + i * cd + j] = v;
                vals[cr + j * rd + i] = v;
            }}
        }
    }
    for r in 0..pat.dims.len() { let (d, b) = (pat.dims[r], pat.diag_at[r]); for i in 0..d { vals[b + i * d + i] += 400.0 } }
    let sym = Symbolic::new(&pat, usize::MAX).unwrap();
    let mut check = 0.0;
    for _ in 0..reps { check += sym.factor(&pat, &vals).map_or(0.0, |f| f.vals[0]) }
    check
}

#[cfg(test)]
mod tests {
    use super::*;

    // The right-looking factor this file had before the left-looking one (2026-10-17):
    // the reference the new one must match bit for bit.
    fn factor_right_looking(sym: &Symbolic, pat: &BlockPattern, a: &[f64]) -> Option<Vec<f64>> {
        let this = sym;
        let mut v = this.scatter(pat, a, Vec::new());
        {
        let s_ = this;
        let _ = s_;
        }
        let n_sn = this.width.len();
        let mut dest: Vec<usize> = Vec::new();
        let mut tmp: Vec<f64> = Vec::new();
        for s in 0..n_sn {
            let (w, h, p) = (this.width[s], this.height[s], this.panel_at[s]);
            // The diagonal part: a dense Cholesky.
            if !chol_in_place(w, &mut v[p..p + w * w]) { return None }
            // The rows below: x ← x · L⁻ᵀ.
            {
                let (diag, below) = v[p..p + (w + h) * w].split_at_mut(w * w);
                for r in 0..h { trsv_lower_row(w, diag, &mut below[r * w..(r + 1) * w]) }
            }
            // Updates: for each target supernode t met by the rows, every row at or after
            // t's first one, against t's own columns among them.
            let (lo, hi) = (this.rows_ptr[s], this.rows_ptr[s + 1]);
            let (left, right) = v.split_at_mut(p + (w + h) * w);
            let src = &left[p..];
            let mut i = lo;
            while i < hi {
                let t = this.sn_of[this.rows[i] as usize];
                let mut j = i;
                while j < hi && this.sn_of[this.rows[j] as usize] == t { j += 1 }
                let wt = this.width[t];
                let tb = this.panel_at[t] - (p + (w + h) * w); // panel t within `right`
                // Destination rows in t's panel for every source row block from i on.
                dest.clear();
                for e in i..hi { dest.push(this.panel_row(t, this.rows[e] as usize)) }
                let t0 = this.off[this.sn_start[t]];
                // One dense product for the whole group: rows from i on × the group's rows
                // as columns, both contiguous in the panel; then scattered into t.
                let (r0, c_end) = (this.rows_soff[i], if j < hi { this.rows_soff[j] } else { h });
                let (m, gc) = (h - r0, c_end - r0);
                tmp.clear();
                tmp.resize(m * gc, 0.0);
                gemm_nt(&mut tmp, &src[w * w + r0 * w..w * w + h * w], &src[w * w + r0 * w..w * w + c_end * w], m, gc, w);
                for ec in i..j {
                    let cb = this.rows[ec] as usize;
                    let (cd, coff, cc) = (this.dims[cb], this.off[cb] - t0, this.rows_soff[ec] - r0);
                    for er in ec..hi {
                        let rd = this.dims[this.rows[er] as usize];
                        let (rr, drow) = (this.rows_soff[er] - r0, dest[er - i]);
                        for ii in 0..rd {
                            let out = tb + (drow + ii) * wt + coff;
                            let from = (rr + ii) * gc + cc;
                            for jj in 0..cd { right[out + jj] -= tmp[from + jj] }
                        }
                    }
                }
                i = j;
            }
        }

        Some(v)
    }

    // An aerial block's reduced system: rows × cols cameras coupled within `radius`, plus
    // one intrinsics group of `kdim` unknowns (odd, so the row pairs meet odd offsets).
    fn aerial(rows: usize, cols: usize, radius: isize, kdim: usize, seed0: u64) -> (BlockPattern, Vec<f64>) {
        let n_cam = rows * cols;
        let mut dims = vec![6usize; n_cam];
        dims.push(kdim);
        let pat = BlockPattern::new(dims, |r, touch| {
            if r == n_cam { for c in 0..=n_cam { touch(c) } return }
            let (y, x) = ((r / cols) as isize, (r % cols) as isize);
            for dy in -radius..=radius { for dx in -radius..=radius {
                let (yy, xx) = (y + dy, x + dx);
                if yy >= 0 && xx >= 0 && (yy as usize) < rows && (xx as usize) < cols { touch(yy as usize * cols + xx as usize) }
            }}
            touch(n_cam);
        });
        let mut vals = vec![0f64; pat.n_vals];
        let mut seed = seed0;
        for r in 0..pat.dims.len() {
            for k in pat.row_ptr[r]..pat.row_ptr[r + 1] {
                let c = pat.cols[k] as usize;
                if c > r { continue }
                let (rd, cd) = (pat.dims[r], pat.dims[c]);
                let (rc, cr) = (pat.val_at[k], pat.at(c, r));
                for i in 0..rd { for j in 0..cd {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                    let v = if c == r && j < i { vals[rc + j * cd + i] } else { ((seed >> 40) as f64 / (1u64 << 24) as f64 - 0.5) * 0.1 };
                    vals[rc + i * cd + j] = v;
                    vals[cr + j * rd + i] = v;
                }}
            }
        }
        for r in 0..pat.dims.len() { let (d, b) = (pat.dims[r], pat.diag_at[r]); for i in 0..d { vals[b + i * d + i] += 400.0 } }
        (pat, vals)
    }

    #[test]
    fn left_looking_factor_is_the_right_looking_one_bit_for_bit() {
        for &(rows, cols, radius, kdim, seed) in &[(6, 7, 1, 7, 1u64), (12, 12, 2, 3, 2), (20, 18, 2, 6, 3), (25, 25, 3, 5, 4)] {
            let (pat, vals) = aerial(rows, cols, radius, kdim, seed);
            let mut sym = Symbolic::new(&pat, usize::MAX).unwrap();
            let want = factor_right_looking(&sym, &pat, &vals).unwrap();
            // As the app runs it, one supernode after another, and with every supernode
            // cut into row chunks; by the elimination tree as the app cuts it, all in
            // waves, in a few larger tasks, and in one task.
            for share in [TASK_SHARE, 1e-12, 0.1, 1.0] {
                sym.sched = sym.schedule(share);
                let (tasks, waves) = (sym.sched.task_ptr.len() - 1, sym.sched.wave_ptr.len() - 1);
                if share == TASK_SHARE && rows >= 20 { assert!(tasks > 8 && waves > 2, "{rows}×{cols}: {tasks} tasks, {waves} waves") }
                if share < TASK_SHARE { assert!(tasks == 0 && waves > 4, "{rows}×{cols}: {tasks} tasks, {waves} waves") }
                for par in [PAR_UPDATE_FLOPS, 0.0] { for tree in [false, true] {
                    let got = sym.factor_with(&pat, &vals, par, tree, Vec::new()).ok().unwrap();
                    assert!(got.vals.iter().zip(&want).all(|(a, b)| a.to_bits() == b.to_bits()),
                        "{rows}×{cols} r{radius} k{kdim}, par_flops {par}, tree {tree}, share {share}: the factors differ");
                } }
            }
        }
    }
}
