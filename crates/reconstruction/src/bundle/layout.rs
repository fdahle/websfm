// The reduced system's variables: which pose blocks are free (6 slots each, in order),
// then each sensor group's self-calibration parameters (kdim slots each), and the block
// sparsity between them.

#[allow(unused_imports)]
use crate::linalg::*;
#[allow(unused_imports)]
use super::*;

// The slot of a pose block held fixed: it has none.
pub(crate) const FIXED: usize = usize::MAX;

pub(crate) struct Layout {
    // The per-group param vector is the ordered subset [s?, dcx?, dcy?, k1?, k2?, k3?, k4?,
    // p1?, p2?, τ?, ω?] of the refine bits; `idx_*` is a param's slot in it (−1: bit clear).
    pub kdim: usize,
    pub idx_s: isize,
    pub idx_dcx: isize,
    pub idx_dcy: isize,
    pub idx_k: [isize; 4],
    pub idx_p1: isize,
    pub idx_p2: isize,
    pub idx_rs: isize,
    // The offset rotation ω: three consecutive slots from here.
    pub idx_rig: isize,
    // Each camera's sensor group, and how many groups.
    pub grp: Vec<usize>,
    pub g_count: usize,
    // Self-calibration on: some param is refined and there is a group.
    pub refine: bool,
    // Each group's lens (its first camera's; a sensor group shares one).
    pub group_lens: Vec<(usize, [f64; 4], [f64; 2])>,
    // Each group's seed readout time (its first rolling-shutter camera's τ0).
    pub group_tau0: Vec<f64>,
    // Which groups have a lens offset to refine (the others' ω slots are pinned).
    pub group_has_off: Vec<bool>,
    // Reduced slot of each pose block (FIXED: none); with no fixed camera the slot is the
    // block index, so the system is exactly the all-free one. A block is fixed when all
    // its cameras are.
    pub slot: Vec<usize>,
    pub free_cams: Vec<usize>,
    pub n_free: usize,
    // Where the intrinsic params start (after the poses), the system's size, and the
    // number of group blocks in it (0 without self-calibration).
    pub group_off: usize,
    pub n: usize,
    pub n_groups: usize,
}

impl Layout {
    /// `refine_mask`: 1 = f, 2 = cx/cy, 4 = k1, 8 = k2, 16 = k3, 32 = k4, 64 = τ
    /// (bundle_adjust_rs), 128 = ω (bundle_adjust_rig), 256 = p1, p2.
    pub(crate) fn new(p: &Problem, sensor_of_cam: &[i32], refine_mask: u32, fixed_cam: &[u8]) -> Layout {
        let n_cam = p.n_cam;
        let has_f = refine_mask & 1 != 0;
        let has_cxcy = refine_mask & 2 != 0;
        let has_k1 = refine_mask & 4 != 0;
        let has_k2 = refine_mask & 8 != 0;
        let has_k3 = refine_mask & 16 != 0;
        let has_k4 = refine_mask & 32 != 0;
        let has_p = refine_mask & 256 != 0;
        let has_rs = refine_mask & 64 != 0 && p.rs_any;
        let has_rig = refine_mask & 128 != 0 && p.off.iter().any(|o| o.is_some());
        let mut kdim = 0usize;
        let mut alloc = |on: bool| -> isize { if on { let i = kdim as isize; kdim += 1; i } else { -1 } };
        let idx_s   = alloc(has_f);
        let idx_dcx = alloc(has_cxcy);
        let idx_dcy = alloc(has_cxcy);
        let idx_k1  = alloc(has_k1);
        let idx_k2  = alloc(has_k2);
        let idx_k3  = alloc(has_k3);
        let idx_k4  = alloc(has_k4);
        let idx_p1  = alloc(has_p);
        let idx_p2  = alloc(has_p);
        let idx_rs  = alloc(has_rs);
        let idx_rig = alloc(has_rig); alloc(has_rig); alloc(has_rig);
        let idx_k = [idx_k1, idx_k2, idx_k3, idx_k4];
        let (grp, g_count) = if kdim > 0 { build_groups(sensor_of_cam, n_cam) } else { (vec![0usize; n_cam], 0) };
        let refine = kdim > 0 && g_count > 0;
        let mut group_lens: Vec<(usize, [f64; 4], [f64; 2])> = vec![(0, [0.0; 4], [0.0; 2]); g_count];
        { let mut seen = vec![false; g_count];
          for c in 0..n_cam { if refine && !seen[grp[c]] { seen[grp[c]] = true; group_lens[grp[c]] = p.lens[c]; } } }
        let mut group_tau0 = vec![0.0f64; g_count];
        { let mut seen = vec![false; g_count];
          for c in 0..n_cam { if refine && !seen[grp[c]] { if let Some((_, _, t0)) = p.rs[c] { seen[grp[c]] = true; group_tau0[grp[c]] = t0; } } } }
        let mut group_has_off = vec![false; g_count];
        for c in 0..n_cam { if refine && p.off[c].is_some() { group_has_off[grp[c]] = true; } }

        let n_pb = p.n_pb;
        let mut slot = vec![FIXED; n_pb];
        let mut free_cams: Vec<usize> = Vec::with_capacity(n_pb);
        let mut block_free = vec![false; n_pb];
        for c in 0..n_cam { if fixed_cam.get(c).copied().unwrap_or(0) == 0 { block_free[p.pb[c]] = true; } }
        for b in 0..n_pb {
            if block_free[b] { slot[b] = free_cams.len(); free_cams.push(b); }
        }
        let n_free = free_cams.len();
        let group_off = 6 * n_free;
        let n = group_off + if refine { g_count * kdim } else { 0 };
        let n_groups = if refine { g_count } else { 0 };
        Layout {
            kdim, idx_s, idx_dcx, idx_dcy, idx_k, idx_p1, idx_p2, idx_rs, idx_rig, grp, g_count, refine, group_lens,
            group_tau0, group_has_off, slot, free_cams, n_free, group_off, n, n_groups,
        }
    }

    /// Whether group g's lens has k slot j: k1–k3 for Brown, the first `terms` for a fisheye.
    #[inline]
    pub(crate) fn k_live(&self, g: usize, j: usize) -> bool {
        let terms = self.group_lens[g].0;
        if terms == 0 { j < 3 } else { j < terms }
    }

    /// The decentring pair is Brown's: a fisheye group has none.
    #[inline]
    pub(crate) fn p_live(&self, g: usize) -> bool { self.group_lens[g].0 == 0 }

    /// The reduced system's sparsity: camera c couples with every camera that shares a
    /// point with it, and with those cameras' intrinsics groups; a group with whatever its
    /// cameras couple with. Built once, the observations do not change. Uncoupled
    /// (`coupled` false) it is B's alone, the reduced variables before the points are
    /// eliminated: a camera with its own group, a group with its cameras (the implicit
    /// solve keeps only that).
    pub(crate) fn pattern(&self, p: &Problem, coupled: bool) -> BlockPattern {
        let (n_cam, n_free, n_groups, refine) = (p.n_cam, self.n_free, self.n_groups, self.refine);
        let (grp, slot, pb, obs) = (&self.grp, &self.slot, &p.pb, &p.obs);
        let (pt_start, pt_obs) = (&p.pt_start, &p.pt_obs);
        let (cam_start, cam_obs) = csr(n_cam, obs.iter().map(|o| o.0 as usize));
        let (grp_start, grp_cams) = csr(n_groups, (0..if refine { n_cam } else { 0 }).map(|c| grp[c]));
        let (blk_start, blk_cams) = csr(p.n_pb, (0..n_cam).map(|c| pb[c]));
        let mut dims = vec![6usize; n_free];
        dims.extend(std::iter::repeat_n(self.kdim, n_groups));
        BlockPattern::new(dims, |r, touch| {
            let visit = |c: usize, touch: &mut dyn FnMut(usize)| {
                if n_groups > 0 { touch(n_free + grp[c]); }
                if !coupled {
                    if slot[pb[c]] != FIXED { touch(slot[pb[c]]); }
                    return;
                }
                for k in cam_start[c]..cam_start[c + 1] {
                    let pt = obs[cam_obs[k as usize] as usize].1 as usize;
                    for q in pt_start[pt]..pt_start[pt + 1] {
                        let c2 = obs[pt_obs[q as usize] as usize].0 as usize;
                        if slot[pb[c2]] != FIXED { touch(slot[pb[c2]]); }
                        if n_groups > 0 { touch(n_free + grp[c2]); }
                    }
                }
            };
            if r < n_free {
                let b = self.free_cams[r];
                for k in blk_start[b]..blk_start[b + 1] { visit(blk_cams[k as usize] as usize, &mut *touch); }
            }
            else { for k in grp_start[r - n_free]..grp_start[r - n_free + 1] { visit(grp_cams[k as usize] as usize, &mut *touch); } }
        })
    }
}
