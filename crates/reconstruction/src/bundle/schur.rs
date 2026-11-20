// Bundle adjustment's Schur assembly helpers: the per-point coupling blocks, the
// camera ranges the assembly runs over in parallel, and the CSR and group indices.

#[allow(unused_imports)]
use crate::linalg::*;
#[allow(unused_imports)]
use crate::par::{for_each_index, map_indexed, SyncPtr, CHUNK};
#[allow(unused_imports)]
use super::*;

// ── Reduced-variable coupling blocks (Schur assembly) ─────────────────────────

// Largest reduced block: a camera's 6 rows, or an intrinsic group's
// [s, dcx, dcy, k1, k2, k3, k4, τ, ωx, ωy, ωz] (≤ 11; ω: bundle_adjust_rig).
pub(crate) const BLK_MAX: usize = 13;
// SolverOpts::huber 0: the Huber δ that makes the loss plain least squares.
pub(crate) const NO_LOSS_DELTA: f64 = 1e12;

// One point's merged Jvarᵀ·Jp coupling block: its id in the reduced-system pattern
// (camera slot, or n_free + group), its offset in the reduced variables, its rows (a
// camera's 6, a group's kdim) and where they start in its list's `rows`.
#[derive(Clone, Copy)]
pub(crate) struct EBlock { pub blk: usize, pub off: usize, pub dim: usize, pub at: usize }

// A point's coupling blocks in order, their rows one after another: a camera block takes
// its 6 rows, not a group's BLK_MAX. Reused from point to point (no allocation per point).
#[derive(Default)]
pub(crate) struct EList { pub blocks: Vec<EBlock>, pub rows: Vec<[f64; 3]> }

impl EList {
    pub(crate) fn clear(&mut self) { self.blocks.clear(); self.rows.clear(); }
    pub(crate) fn is_empty(&self) -> bool { self.blocks.is_empty() }
    #[inline]
    pub(crate) fn rows_of(&self, eb: &EBlock) -> &[[f64; 3]] { &self.rows[eb.at..eb.at + eb.dim] }
    // Add block `blk` with rows row(0), …, row(dim − 1): with `merge`, into the list's
    // block blk when there is one (the cameras of one intrinsics group, or of one rig
    // capture, fold into one block), else appended.
    #[inline]
    pub(crate) fn add(&mut self, blk: usize, off: usize, dim: usize, merge: bool, row: impl Fn(usize) -> [f64; 3]) {
        if merge {
            if let Some(at) = self.blocks.iter().find(|e| e.blk == blk).map(|e| e.at) {
                for a in 0..dim { let r = row(a); for b in 0..3 { self.rows[at + a][b] += r[b]; } }
                return;
            }
        }
        self.blocks.push(EBlock { blk, off, dim, at: self.rows.len() });
        for a in 0..dim { self.rows.push(row(a)); }
    }
}

// How the lower-triangle Schur step (and the assembly) is split over threads, so that
// the result is the same bits whatever the thread count, in both builds. The free
// cameras are cut into `n` contiguous ranges, a number fixed by the camera count alone:
// one per RANGE_MIN_CAMS cameras, at most RANGE_MAX (the app's thread cap). About as many
// ranges as threads is fastest: fewer leave cores idle, more repeat the work of the points
// several ranges share. On BAL (20 threads) the step took 1.4 s at 15 ranges against
// 3.8 s at the former one range per 64 cameras (trafalgar-126, 1 range), 2.3 against
// 4.1 s (trafalgar-225, 3); at 40+ ranges ladybug-646 and -1340 slowed by a third.
// Range r owns the block rows of its cameras (and their right-hand side), and the
// group-row blocks (g, c) of its cameras c: each such element is written by one range,
// from that range's points in Schur order, the order the single loop added them in.
// The group × group blocks and the group right-hand side sum over every point: each
// point's share goes to its owner range (the range of its lowest camera); range 0 writes
// its share directly, the others into a partial that is added in range order after.
// Without intrinsics groups (no self-calibration), or with one range (under
// 2·RANGE_MIN_CAMS free cameras), every sum is the single loop's, bit for bit; with them, the group blocks are
// summed range by range, which rounds differently from one loop.
pub(crate) const RANGE_MIN_CAMS: usize = 8;
pub(crate) const RANGE_MAX: usize = 16;
pub(crate) struct RangePlan {
    pub n: usize,
    pub n_free: usize,
    // Points each range visits (those touching one of its cameras, or owned by it), in
    // Schur order, and the same in index order (the assembly's).
    pub points: Vec<Vec<u32>>,
    pub points_by_index: Vec<Vec<u32>>,
    pub owner: Vec<u32>,
    // Group × group blocks: (value offset in S, length, offset in a range's partial); the
    // group right-hand side follows them in the partial. A block's partial offset by its
    // pattern position k (`gg_part[k − gg_k0]`, the group rows' positions from gg_k0), and
    // each group's diagonal block's (`gg_diag`).
    pub gg: Vec<(usize, usize, usize)>,
    pub gg_k0: usize,
    pub gg_part: Vec<usize>,
    pub gg_diag: Vec<usize>,
    pub gg_len: usize,
    pub group_rows: usize,
    pub group_off: usize,
}

impl RangePlan {
    pub(crate) fn new(pattern: &BlockPattern, n_free: usize, schur_order: &[usize],
           cams_of: impl Fn(usize, &mut dyn FnMut(usize))) -> RangePlan {
        let n = (n_free / RANGE_MIN_CAMS).clamp(1, RANGE_MAX);
        let range = |b: usize| (b * n).checked_div(n_free).unwrap_or(0);
        let n_pts = schur_order.iter().copied().max().map_or(0, |m| m + 1);
        let mut owner = vec![0u32; n_pts];
        let mut points: Vec<Vec<u32>> = vec![Vec::new(); n];
        let mut seen: Vec<usize> = Vec::new();
        for &p in schur_order {
            seen.clear();
            let mut lowest = usize::MAX;
            cams_of(p, &mut |b| { lowest = lowest.min(b); seen.push(range(b)); });
            let own = if lowest == usize::MAX { 0 } else { range(lowest) };
            owner[p] = own as u32;
            seen.push(own);
            seen.sort_unstable();
            seen.dedup();
            for &r in &seen { points[r].push(p as u32); }
        }
        let mut gg = Vec::new();
        let gg_k0 = pattern.row_ptr[n_free.min(pattern.dims.len())];
        let mut gg_part = vec![usize::MAX; pattern.cols.len() - gg_k0];
        let mut gg_diag = vec![usize::MAX; pattern.dims.len() - n_free.min(pattern.dims.len())];
        let mut gg_len = 0;
        for r in n_free..pattern.dims.len() {
            for k in pattern.row_ptr[r]..pattern.row_ptr[r + 1] {
                let c = pattern.cols[k] as usize;
                if c < n_free || c > r { continue; }
                let len = pattern.dims[r] * pattern.dims[c];
                gg_part[k - gg_k0] = gg_len;
                if c == r { gg_diag[r - n_free] = gg_len; }
                gg.push((pattern.val_at[k], len, gg_len));
                gg_len += len;
            }
        }
        let group_off = if n_free < pattern.dims.len() { pattern.offs[n_free] } else { pattern.n };
        let points_by_index = points.iter().map(|l| { let mut v = l.clone(); v.sort_unstable(); v }).collect();
        RangePlan { n, n_free, points, points_by_index, owner, gg, gg_k0, gg_part, gg_diag, gg_len, group_rows: pattern.n - group_off, group_off }
    }
    pub(crate) fn range(&self, b: usize) -> usize { (b * self.n).checked_div(self.n_free).unwrap_or(0) }
    pub(crate) fn part_len(&self) -> usize { self.gg_len + self.group_rows }
}

// The values a RangePlan's partials hold together ((n − 1)·part_len: every range but the
// first keeps its own copy of the group × group blocks and the group gradient), from the
// pattern alone, before any plan exists: the memory decision needs it. Large only when
// there are many lens groups (BAL gives each camera its own: 474 MB on final-961).
pub(crate) fn range_parts_len(pattern: &BlockPattern, n_free: usize) -> usize {
    let n = (n_free / RANGE_MIN_CAMS).clamp(1, RANGE_MAX);
    let mut gg_len = 0;
    for r in n_free..pattern.dims.len() {
        for k in pattern.row_ptr[r]..pattern.row_ptr[r + 1] {
            let c = pattern.cols[k] as usize;
            if c >= n_free && c <= r { gg_len += pattern.dims[r] * pattern.dims[c]; }
        }
    }
    let group_off = if n_free < pattern.dims.len() { pattern.offs[n_free] } else { pattern.n };
    (n - 1) * (gg_len + pattern.n - group_off)
}

// Group item indices 0..len by key (< n_keys), keeping item order within a key:
// (start offsets, n_keys + 1 entries; the grouped item indices).
pub(crate) fn csr(n_keys: usize, keys: impl Iterator<Item = usize> + Clone) -> (Vec<u32>, Vec<u32>) {
    let mut start = vec![0u32; n_keys + 1];
    let mut len = 0usize;
    for k in keys.clone() { start[k + 1] += 1; len += 1; }
    for i in 0..n_keys { start[i + 1] += start[i]; }
    let mut fill = start.clone();
    let mut items = vec![0u32; len];
    for (i, k) in keys.enumerate() { items[fill[k] as usize] = i as u32; fill[k] += 1; }
    (start, items)
}

// Map each camera to an intrinsic-group slot. Cameras sharing a non-negative sensor
// id share a slot; unassigned cameras (id < 0, or a short/empty id list) each get
// their own slot. Returns the per-camera slot vector and the slot count.
pub(crate) fn build_groups(ids: &[i32], n_cam: usize) -> (Vec<usize>, usize) {
    use std::collections::HashMap;
    let mut map: HashMap<i32, usize> = HashMap::new();
    let mut grp = vec![0usize; n_cam];
    let mut next = 0usize;
    for c in 0..n_cam {
        let id = ids.get(c).copied().unwrap_or(-1);
        if id < 0 {
            grp[c] = next; next += 1;
        } else {
            grp[c] = *map.entry(id).or_insert_with(|| { let g = next; next += 1; g });
        }
    }
    (grp, next)
}
