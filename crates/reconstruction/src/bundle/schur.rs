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

// One point's merged Jvarᵀ·Jp coupling block, keyed by its reduced-variable offset
// (a camera's 6 rows, or an intrinsic group's 1–8 rows). Fixed BLK_MAX-row storage
// keeps assembly allocation-free; only `dim` rows are used.
// `blk` is the block's id in the reduced-system pattern (camera c, or n_cam + group).
pub(crate) struct EBlock { pub blk: usize, pub off: usize, pub dim: usize, pub rows: [[f64; 3]; BLK_MAX] }

// Accumulate a coupling block into a point's E-list, merging by block so that two
// cameras sharing an intrinsic group fold into that group's single block.
pub(crate) fn add_eblock(list: &mut Vec<EBlock>, blk: usize, off: usize, dim: usize, rows: &[[f64; 3]; BLK_MAX]) {
    if let Some(eb) = list.iter_mut().find(|e| e.blk == blk) {
        for a in 0..dim { for b in 0..3 { eb.rows[a][b] += rows[a][b]; } }
    } else {
        list.push(EBlock { blk, off, dim, rows: *rows });
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
    // Group × group blocks: (value offset in S, length), and each one's offset in a
    // range's partial; the group right-hand side follows them in the partial.
    pub gg: Vec<(usize, usize)>,
    pub gg_at: std::collections::HashMap<usize, usize>,
    pub gg_len: usize,
    pub group_rows: usize,
    pub group_off: usize,
}

impl RangePlan {
    pub(crate) fn new(pattern: &BlockPattern, n_free: usize, schur_order: &[usize],
           cams_of: impl Fn(usize, &mut dyn FnMut(usize))) -> RangePlan {
        let n = (n_free / RANGE_MIN_CAMS).clamp(1, RANGE_MAX);
        let range = |b: usize| if n_free == 0 { 0 } else { b * n / n_free };
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
        let mut gg_at = std::collections::HashMap::new();
        let mut gg_len = 0;
        for r in n_free..pattern.dims.len() {
            for k in pattern.row_ptr[r]..pattern.row_ptr[r + 1] {
                let c = pattern.cols[k] as usize;
                if c < n_free || c > r { continue; }
                let len = pattern.dims[r] * pattern.dims[c];
                gg_at.insert(pattern.val_at[k], gg_len);
                gg.push((pattern.val_at[k], len));
                gg_len += len;
            }
        }
        let group_off = if n_free < pattern.dims.len() { pattern.offs[n_free] } else { pattern.n };
        let points_by_index = points.iter().map(|l| { let mut v = l.clone(); v.sort_unstable(); v }).collect();
        RangePlan { n, n_free, points, points_by_index, owner, gg, gg_at, gg_len, group_rows: pattern.n - group_off, group_off }
    }
    pub(crate) fn range(&self, b: usize) -> usize { if self.n_free == 0 { 0 } else { b * self.n / self.n_free } }
    pub(crate) fn part_len(&self) -> usize { self.gg_len + self.group_rows }
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
