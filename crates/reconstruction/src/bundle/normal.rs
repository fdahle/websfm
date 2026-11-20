// The normal equations of one LM iteration: how the reduced system is stored and solved
// (`Plan`), its buffers (`Work`), the assembly of the undamped blocks, the Schur
// elimination of the points at a damping λ, and the points' back-substitution.

#[allow(unused_imports)]
use crate::linalg::*;
#[allow(unused_imports)]
use crate::par::{for_each_index, SyncPtr, CHUNK};
#[allow(unused_imports)]
use super::*;

pub(crate) struct Plan {
    pub pattern: BlockPattern,
    // The sparse direct solve's ordering, when it runs.
    pub direct: Option<crate::sparse_chol::Symbolic>,
    // S never stored: products through the points instead (PCG).
    pub implicit: bool,
    // The LM stopping rule.
    pub function_tol: f64,
    // The direct solve reads the lower triangle only (sparse_chol.rs `factor`).
    pub lower_only: bool,
    // How the lower-triangle Schur step splits over threads; the full-matrix paths keep
    // point chunks.
    pub range_plan: Option<RangePlan>,
    pub point_chunks: usize,
    // The implicit solve's Jacobian cache: on or not, the intrinsics columns in it (0
    // without self-calibration), and its floats per observation.
    pub use_jcache: bool,
    pub jk: usize,
    pub jstride: usize,
    // Under self-calibration, each camera's cross blocks with its group in S: the value
    // offsets of (group, camera) and (camera, group); (0, 0) for a camera held fixed.
    pub cam_grp_at: Vec<(usize, usize)>,
    // Whether the observations' residuals are kept from one iteration to the next (they
    // fit the memory budget beside what the solve holds).
    pub keep_res: bool,
}

impl Plan {
    pub(crate) fn new(m: &Model, solver: &SolverOpts) -> Plan {
        let (p, l) = (m.p, m.l);
        let (n_pts, n_free, n) = (p.n_pts, l.n_free, l.n);
        let (obs, pt_start, pt_obs, pb, slot) = (&p.obs, &p.pt_start, &p.pt_obs, &p.pb, &l.slot);
        let mut pattern = l.pattern(p, true);
        // The sparse direct solve's ordering, once for every LM iteration of this call, when
        // the direct solve fits the memory (`direct_bytes`, solver slot 10): the ordering is
        // given what is left once the reduced matrix and the per-observation and per-point
        // data are counted, and gives up past it. Otherwise the reduced matrix is never
        // stored (`implicit`): on a dense camera graph S alone outgrows wasm32 (BAL
        // final-1936, 1,936 cameras that nearly all see each other: 2.2 GB, held twice).
        let large = pattern.n >= solver.pcg_min_n || pattern.n > DENSE_MAX_N;
        let mut parts = 0u64;
        let (direct, implicit) = if solver.direct == 2 && large { (None, true) }
        else if solver.direct == 1 && large {
            let room = solver.memory.saturating_sub(direct_bytes(pattern.n_vals, 0, 0, obs.len(), n_pts));
            // The factor and the group partials share one buffer: each must fit the room.
            parts = 8 * range_parts_len(&pattern, n_free) as u64;
            let max_blocks = (room / (8 * 36)).min(usize::MAX as u64) as usize;
            let sym = if max_blocks == 0 || parts > room { None } else {
                crate::sparse_chol::Symbolic::new(&pattern, max_blocks).filter(|sym| sym.factor_bytes() as u64 <= room)
            };
            let implicit = sym.is_none();
            (sym, implicit)
        } else { (None, false) };
        if implicit { pattern = l.pattern(p, false); }
        // Exact steps keep finding improvements of a few 10⁻⁶ of the cost long after the
        // model has stopped changing (1,600 aerial cameras: all 30 iterations ran, RMS
        // 0.46 px from the 13th on); a 10⁻⁵ stop ends them with the same final model.
        // A re-solve of a converged model after a filter or a retriangulation (`warm`)
        // stops at 10⁻⁴: quarry the same RTK camera error, South Building the same
        // residuals. Not every solve: interim solves stopped that early hand the first
        // global BA a model it then needs 44 instead of 25 solves for (1,600 cameras).
        // Only where the direct solve runs: an inexact PCG step needs the tighter rule.
        let function_tol = match direct {
            Some(_) => solver.function_tol.max(if solver.warm != 0 { WARM_FUNCTION_TOL } else { DIRECT_FUNCTION_TOL }),
            None => solver.function_tol,
        };
        let lower_only = direct.is_some();
        // With it, the Schur elimination visits the points grouped by their first camera, so
        // consecutive points write nearby blocks of S (21 MB at 1,600 cameras: scattered
        // writes were the cost). The full-matrix paths keep the index order (and their bits).
        let schur_order: Vec<usize> = if lower_only {
            let mut key: Vec<(usize, usize)> = (0..n_pts).map(|pi| {
                ((pt_start[pi] as usize..pt_start[pi + 1] as usize).map(|q| pb[obs[pt_obs[q] as usize].0 as usize]).min().unwrap_or(usize::MAX), pi)
            }).collect();
            key.sort_unstable();
            key.into_iter().map(|(_, pi)| pi).collect()
        } else { (0..n_pts).collect() };
        let range_plan = if lower_only { Some(RangePlan::new(&pattern, n_free, &schur_order, |pi, visit: &mut dyn FnMut(usize)| {
            for q in pt_start[pi] as usize..pt_start[pi + 1] as usize {
                let sl = slot[pb[obs[pt_obs[q] as usize].0 as usize]];
                if sl != FIXED { visit(sl); }
            }
        })) } else { None };
        // The full-matrix paths (no RangePlan: the dense and PCG solves, below ~128 cameras)
        // split the assembly and the Schur step over points instead: `point_chunks`
        // contiguous chunks, each summing into its own share of S and the right-hand side,
        // the shares added in chunk order after. The count follows the problem's size (2,048
        // points a chunk, at most 16, the shares at most 128 MB together), never the thread
        // count, so both builds give the same bits. One loop had kept these blocks on one
        // thread in the threaded build too (Aukerman, 42 cameras: BA 13.6 of SfM's 20 s).
        let point_chunks = if range_plan.is_some() { 1 } else {
            let share = (pattern.n_vals + n) * 8;
            let mut c = n_pts.div_ceil(2048).clamp(1, 16);
            while c > 1 && c * share > 128 << 20 { c -= 1; }
            c
        };
        // The implicit solve's Jacobian cache: each observation's rows with its weight's root
        // folded in (ju, jv, jpu, jpv, then jku, jkv over the group's kdim), in f32, filled
        // once per iteration (the linearisation holds through every try and CG iteration).
        // A product then reads them instead of re-deriving the projection: re-deriving made a
        // CG iteration ~3× Ceres' (BAL trafalgar-257). Only when it fits the memory budget
        // beside the rest; otherwise each product calls `eblocks`.
        let jk = if l.refine { l.kdim } else { 0 };
        let jstride = 18 + 2 * jk;
        let use_jcache = implicit
            && 2 * 8 * pattern.n_vals as u64 + MEM_PER_OBS * obs.len() as u64 + MEM_PER_POINT * n_pts as u64
                + 4 * (jstride * obs.len()) as u64 <= solver.memory;
        let cam_grp_at = if !l.refine { Vec::new() } else {
            (0..p.n_cam).map(|ci| {
                let (sc, g) = (slot[pb[ci]], n_free + l.grp[ci]);
                if sc == FIXED { (0, 0) } else { (pattern.at(g, sc), pattern.at(sc, g)) }
            }).collect()
        };
        // What the chosen solve holds besides what follows (the same accounting as the
        // decisions above; the dense solve's copy and factor below DENSE_MAX_N). The kept
        // residuals and the Jacobian cache change no result, only whether a pass is
        // repeated, so they are on only when they fit beside it and never sway a decision.
        let n_obs = obs.len() as u64;
        let held = match direct.as_ref() {
            Some(sym) => direct_bytes(pattern.n_vals, sym.factor_bytes() as u64, parts, obs.len(), n_pts),
            None if implicit => 2 * 8 * pattern.n_vals as u64 + MEM_PER_OBS * n_obs + MEM_PER_POINT * n_pts as u64
                + if use_jcache { 4 * (jstride as u64) * n_obs } else { 0 },
            None => direct_bytes(pattern.n_vals, if n <= DENSE_MAX_N { 16 * (n * n) as u64 } else { 0 }, 0, obs.len(), n_pts),
        };
        let keep_res = held + RES_PER_OBS * n_obs <= solver.memory;
        Plan { pattern, direct, implicit, function_tol, lower_only, range_plan, point_chunks, use_jcache, jk, jstride, cam_grp_at, keep_res }
    }

    /// The points of chunk c (`point_chunks`).
    #[inline]
    pub(crate) fn chunk_range(&self, c: usize, n_pts: usize) -> std::ops::Range<usize> {
        (c * n_pts / self.point_chunks)..((c + 1) * n_pts / self.point_chunks)
    }
}

/// The reduced system's buffers, allocated once for every iteration and try (see
/// sparse_chol.rs `factor_reusing`): the undamped assembly, the damped and reduced copy,
/// the implicit solve's B, and `work`: the ranges' group partials during a Schur step,
/// then the factor's storage (never both at once: the peak is the larger). The point
/// chunks' shares of S and the right-hand side, and the implicit solve's Jacobian cache
/// (filled at iteration `jcache_outer`).
pub(crate) struct Work {
    pub smat: Vec<f64>,
    pub s: Vec<f64>,
    pub b_damped: Vec<f64>,
    pub work: Vec<f64>,
    pub share_s: Vec<Vec<f64>>,
    pub share_r: Vec<Vec<f64>>,
    pub jcache: Vec<f32>,
    pub jcache_outer: u32,
    // The accepted state's residuals and the trial's (Plan::keep_res, Model::fill_residuals).
    pub res: Vec<[f64; 2]>,
    pub res_trial: Vec<[f64; 2]>,
}

impl Work {
    pub(crate) fn new(plan: &Plan, n: usize) -> Work {
        let chunked = plan.range_plan.is_none();
        let share_s = if chunked { (0..plan.point_chunks).map(|_| vec![0f64; plan.pattern.n_vals]).collect() } else { Vec::new() };
        let share_r = if chunked { (0..plan.point_chunks).map(|_| vec![0f64; n]).collect() } else { Vec::new() };
        Work { smat: Vec::new(), s: Vec::new(), b_damped: Vec::new(), work: Vec::new(), share_s, share_r, jcache: Vec::new(),
               jcache_outer: u32::MAX, res: Vec::new(), res_trial: Vec::new() }
    }
}

/// The undamped normal equations besides S (in `Work::smat`): the reduced gradient, and
/// each point's C (3×3) and gradient.
pub(crate) struct Normal {
    pub gr: Vec<f64>,
    pub cmat: Vec<M3>,
    pub gpv: Vec<V3>,
}

/// The Schur-reduced system at a damping: whether every point's C could be inverted, the
/// right-hand side, and the points' C⁻¹ (S itself is in `Work::s`).
pub(crate) struct Reduced {
    pub ok: bool,
    pub rhs: Vec<f64>,
    pub cinv_store: Vec<Option<M3>>,
}

/// Assemble the undamped blocks at the state. S is the reduced-variable Hessian (camera
/// poses + intrinsic groups) in the block-sparse pattern; gr its gradient; per point C and gp.
pub(crate) fn assemble(m: &Model, plan: &Plan, st: &State, dh: f64, w: &mut Work) -> Normal {
    let (p, l) = (m.p, m.l);
    let (n_pts, n_free, n, kdim, group_off, refine) = (p.n_pts, l.n_free, l.n, l.kdim, l.group_off, l.refine);
    let (obs, pt_start, pt_obs, pb, slot, grp) = (&p.obs, &p.pt_start, &p.pt_obs, &p.pb, &l.slot, &l.grp);
    let pattern = &plan.pattern;
    let cams = &st.cams;
    let pts = &st.pts;
    w.smat.clear();
    w.smat.resize(pattern.n_vals, 0.0);
    let mut gr = vec![0f64; n];
    let mut cmat = vec![[[0f64; 3]; 3]; n_pts];
    let mut gpv = vec![[0f64; 3]; n_pts];
    let smat = &mut w.smat;

    // GCP anchors: gradient/Hessian of Σ_axis w_axis·(pt−target)² touches only that
    // point's own 3×3 block — no camera coupling, so it's just added here.
    for &(pi, target, precision) in &p.anchors {
        let d = [pts[pi][0]-target[0], pts[pi][1]-target[1], pts[pi][2]-target[2]];
        let pd = mat3_vec(&precision, &d);
        for a in 0..3 {
            gpv[pi][a] += pd[a];
            for b in 0..3 { cmat[pi][a][b] += precision[a][b]; }
        }
    }

    // Camera-centre priors contribute directly to the reduced camera blocks.
    // For C=-R^Tt and update (t+=dt, R=Exp(dw)R), J=[-R^T|-R^T[t]_x].
    for &(ci, target, weight, orientation) in &p.camera_priors {
        if slot[ci] == FIXED { continue; }
        let (r, t) = &cams[ci];
        let centre = camera_center(&cams[ci]);
        let st = skew(t);
        let mut j = [[0.0f64; 6]; 3];
        for row in 0..3 {
            for col in 0..3 {
                j[row][col] = -r[col][row];
                j[row][3 + col] = -(r[0][row]*st[0][col]
                    + r[1][row]*st[1][col] + r[2][row]*st[2][col]);
            }
        }
        let residual = [centre[0] - target[0], centre[1] - target[1], centre[2] - target[2]];
        let off = 6 * slot[ci];
        let dc = pattern.diag_at[slot[ci]];
        // Jᵀ·W·r and Jᵀ·W·J with the full position precision W.
        let wr = mat3_vec(&weight, &residual);
        let mut wj = [[0.0f64; 6]; 3];
        for row in 0..3 { for a in 0..6 {
            wj[row][a] = (0..3).map(|k| weight[row][k] * j[k][a]).sum::<f64>();
        }}
        for a in 0..6 {
            for axis in 0..3 { gr[off+a] += j[axis][a] * wr[axis]; }
            for b in 0..6 {
                for axis in 0..3 {
                    smat[dc + a*6 + b] += j[axis][a] * wj[axis][b];
                }
            }
        }

        // Orientation residual e=Log(R R_targetᵀ). A small central finite-
        // difference Jacobian is used for the three rotation variables. It
        // is exact for the actual left-multiplicative update convention and
        // avoids a fragile closed-form inverse-Jacobian near large rotations.
        if let Some((target_r, precision)) = orientation {
            let e = orientation_residual(r, &target_r);
            let eps = 1e-6;
            let mut j = [[0.0f64; 3]; 3];
            for col in 0..3 {
                let mut dw_plus = [0.0; 3]; dw_plus[col] = eps;
                let mut dw_minus = [0.0; 3]; dw_minus[col] = -eps;
                let rp = mat3_mul(&so3_exp(&dw_plus), r);
                let rm = mat3_mul(&so3_exp(&dw_minus), r);
                let ep = orientation_residual(&rp, &target_r);
                let em = orientation_residual(&rm, &target_r);
                for row in 0..3 { j[row][col] = (ep[row] - em[row]) / (2.0*eps); }
            }
            let pe = mat3_vec(&precision, &e);
            for a in 0..3 {
                let ia = off + 3 + a;
                for row in 0..3 { gr[ia] += j[row][a] * pe[row]; }
                for b in 0..3 {
                    for row in 0..3 { for col in 0..3 {
                        smat[dc + (3 + a)*6 + 3 + b] += j[row][a] * precision[row][col] * j[col][b];
                    }}
                }
            }
        }
    }

    if let Some(rp) = plan.range_plan.as_ref() {
        // Range by range as the Schur step (RangePlan): a camera's blocks and gradient by
        // its range, a point's C and gp by its owner, the group diagonal and gradient by
        // the owner (range 0 directly, the others into a partial added in range order);
        // each range's points in index order, the loop's.
        let (sm_p, gr_p) = (SyncPtr::of(smat), SyncPtr::of(&mut gr));
        let (cm_p, gp_p) = (SyncPtr::of(&mut cmat), SyncPtr::of(&mut gpv));
        // The other ranges' group partials, range r at (r − 1)·pl of `work`.
        let pl = rp.part_len();
        let work = &mut w.work;
        work.clear();
        work.resize(if refine { (rp.n - 1) * pl } else { 0 }, 0.0);
        let parts_p: Vec<SyncPtr<f64>> = (0..rp.n)
            .map(|r| if r == 0 || !refine { SyncPtr::of(&mut []) } else { SyncPtr::of(&mut work[(r - 1) * pl..r * pl]) })
            .collect();
        for_each_index(rp.n, |r| {
            let part = parts_p[r];
            for &pi in &rp.points_by_index[r] {
                let pi = pi as usize;
                let owner = rp.owner[pi] as usize == r;
                for q in pt_start[pi]..pt_start[pi + 1] {
                    let o = pt_obs[q as usize] as usize;
                    let sc = slot[pb[obs[o].0 as usize]];
                    let free = sc != FIXED;
                    let mine = free && rp.range(sc) == r;
                    if !mine && !owner { continue; }
                    let Some(Jac { ru, rv, wu, wv, ju, jv, jpu, jpv, jku, jkv, ci }) = m.jac(o, st, dh)
                        else { continue };
                    // SAFETY (all writes below): RangePlan gives each element one writing range.
                    if mine {
                        let (coff, dc) = (6 * sc, pattern.diag_at[sc]);
                        for a in 0..6 {
                            unsafe { *gr_p.at(coff + a) += wu*ju[a]*ru + wv*jv[a]*rv; }
                            for b in 0..6 { unsafe { *sm_p.at(dc + a*6 + b) += wu*ju[a]*ju[b] + wv*jv[a]*jv[b]; } }
                        }
                    }
                    if refine {
                        let g = grp[ci];
                        let goff = group_off + g * kdim;
                        let dg = pattern.diag_at[n_free + g];
                        let (gc, cg) = plan.cam_grp_at[ci];
                        for a in 0..kdim {
                            if owner {
                                let gv = wu*jku[a]*ru + wv*jkv[a]*rv;
                                if r == 0 { unsafe { *gr_p.at(goff + a) += gv; } }
                                else { unsafe { *part.at(rp.gg_len + goff + a - rp.group_off) += gv; } }
                                let at = if r == 0 { dg } else { rp.gg_diag[g] };
                                let dst = if r == 0 { sm_p } else { part };
                                for b in 0..kdim { unsafe { *dst.at(at + a*kdim + b) += wu*jku[a]*jku[b] + wv*jkv[a]*jkv[b]; } }
                            }
                            // Cross term camera(coff) ↔ group(goff), both triangles.
                            if mine { for b in 0..6 {
                                let v = wu*jku[a]*ju[b] + wv*jkv[a]*jv[b];
                                unsafe { *sm_p.at(gc + a*6 + b) += v; *sm_p.at(cg + b*kdim + a) += v; }
                            } }
                        }
                    }
                    if owner {
                        let (gp, cm) = unsafe { (gp_p.at(pi), cm_p.at(pi)) };
                        for a in 0..3 {
                            gp[a] += wu*jpu[a]*ru + wv*jpv[a]*rv;
                            for b in 0..3 { cm[a][b] += wu*jpu[a]*jpu[b] + wv*jpv[a]*jpv[b]; }
                        }
                    }
                }
            }
        });
        if refine {
            for part in work.chunks(pl.max(1)).take(rp.n - 1) {
                for &(base, len, o) in &rp.gg {
                    for i in 0..len { smat[base + i] += part[o + i]; }
                }
                for i in 0..rp.group_rows { gr[rp.group_off + i] += part[rp.gg_len + i]; }
            }
        }
    } else {
        // Point chunks (`point_chunks`): a chunk's camera and group terms go to its own
        // shares, its points' C and gp straight to them (a point is in one chunk).
        for v in w.share_s.iter_mut() { v.fill(0.0); }
        for v in w.share_r.iter_mut() { v.fill(0.0); }
        let sm_ps: Vec<SyncPtr<f64>> = w.share_s.iter_mut().map(|v| SyncPtr::of(v)).collect();
        let gr_ps: Vec<SyncPtr<f64>> = w.share_r.iter_mut().map(|v| SyncPtr::of(v)).collect();
        let (cm_p, gp_p) = (SyncPtr::of(&mut cmat), SyncPtr::of(&mut gpv));
        for_each_index(plan.point_chunks, |c| {
            let (sm_p, gr_p) = (sm_ps[c], gr_ps[c]);
            for pi in plan.chunk_range(c, n_pts) {
                // SAFETY (all writes below): chunk c alone writes its shares and its points.
                let (gp, cm) = unsafe { (gp_p.at(pi), cm_p.at(pi)) };
                for q in pt_start[pi]..pt_start[pi + 1] {
                    let Some(Jac { ci, ru, rv, wu, wv, ju, jv, jpu, jpv, jku, jkv }) = m.jac(pt_obs[q as usize] as usize, st, dh)
                        else { continue };
                    let sc = slot[pb[ci]];
                    let free = sc != FIXED;
                    let coff = if free { 6 * sc } else { 0 };
                    if free {
                        let dc = pattern.diag_at[sc];
                        for a in 0..6 {
                            unsafe { *gr_p.at(coff + a) += wu*ju[a]*ru + wv*jv[a]*rv; }
                            for b in 0..6 { unsafe { *sm_p.at(dc + a*6 + b) += wu*ju[a]*ju[b] + wv*jv[a]*jv[b]; } }
                        }
                    }
                    if refine {
                        let g = grp[ci];
                        let goff = group_off + g * kdim;
                        let dg = pattern.diag_at[n_free + g];
                        let (gc, cg) = plan.cam_grp_at[ci];
                        for a in 0..kdim {
                            unsafe { *gr_p.at(goff + a) += wu*jku[a]*ru + wv*jkv[a]*rv; }
                            for b in 0..kdim { unsafe { *sm_p.at(dg + a*kdim + b) += wu*jku[a]*jku[b] + wv*jkv[a]*jkv[b]; } }
                            // Cross term camera(coff) ↔ group(goff), both triangles.
                            if free { for b in 0..6 {
                                let v = wu*jku[a]*ju[b] + wv*jkv[a]*jv[b];
                                unsafe { *sm_p.at(gc + a*6 + b) += v; *sm_p.at(cg + b*kdim + a) += v; }
                            } }
                        }
                    }
                    for a in 0..3 {
                        gp[a] += wu*jpu[a]*ru + wv*jpv[a]*rv;
                        for b in 0..3 { cm[a][b] += wu*jpu[a]*jpu[b] + wv*jpv[a]*jpv[b]; }
                    }
                }
            }
        });
        for c in 0..plan.point_chunks {
            for (x, v) in smat.iter_mut().zip(&w.share_s[c]) { *x += v; }
            for (x, v) in gr.iter_mut().zip(&w.share_r[c]) { *x += v; }
        }
    }

    // A k slot the group's lens does not have has no Jacobian: pin it (unit
    // diagonal, zero gradient) so its offset solves to exactly 0 instead of
    // resting on the 1e-12 damping floor.
    if refine {
        for g in 0..l.g_count {
            let dg = pattern.diag_at[n_free + g];
            for j in 0..4 {
                if l.idx_k[j] >= 0 && !l.k_live(g, j) { let a = l.idx_k[j] as usize; smat[dg + a*kdim + a] += 1.0; }
            }
            if l.idx_p1 >= 0 && !l.p_live(g) {
                for a in [l.idx_p1 as usize, l.idx_p2 as usize] { smat[dg + a*kdim + a] += 1.0; }
            }
            // Likewise ω for a group with no lens offset (the rig's reference lens).
            if l.idx_rig >= 0 && !l.group_has_off[g] {
                for k in 0..3 { let a = l.idx_rig as usize + k; smat[dg + a*kdim + a] += 1.0; }
            }
        }
    }
    Normal { gr, cmat, gpv }
}

/// Damp the reduced diagonal, then Schur-eliminate the (λ-damped) points:
/// S ← (S+λ) − Σ_p E·(C+λ)⁻¹·Eᵀ,  rhs ← −gr + Σ_p E·(C+λ)⁻¹·gp. S goes to `Work::s`; the
/// implicit solve keeps B damped (before the points' diagonal-block terms turn `s` into
/// its preconditioner, S's diagonal blocks) in `Work::b_damped`.
pub(crate) fn eliminate(m: &Model, plan: &Plan, st: &State, dh: f64, lambda: f64, nrm: &Normal, w: &mut Work) -> Reduced {
    let (p, n_pts, n) = (m.p, m.p.n_pts, m.l.n);
    let pattern = &plan.pattern;
    let (cmat, gpv, anchored) = (&nrm.cmat, &nrm.gpv, &p.anchored);
    let s = &mut w.s;
    s.clone_from(&w.smat);
    let mut rhs = vec![0f64; n];
    for i in 0..n { rhs[i] = -nrm.gr[i]; }
    for b in 0..pattern.dims.len() {
        let (d, base) = (pattern.dims[b], pattern.diag_at[b]);
        for i in 0..d { s[base + i*d + i] = s[base + i*d + i] * (1.0 + lambda) + 1e-12; }
    }

    let mut cinv_store: Vec<Option<M3>> = vec![None; n_pts];
    let ok;
    if let Some(rp) = plan.range_plan.as_ref() {
        // Range by range, on the thread pool when there is one (RangePlan: every
        // element has one writer, and gets its terms in Schur order).
        let failed = std::sync::atomic::AtomicBool::new(false);
        let (s_p, rhs_p) = (SyncPtr::of(s), SyncPtr::of(&mut rhs));
        let ci_p = SyncPtr::of(&mut cinv_store);
        // The other ranges' group partials in `work`, which the factor reuses next.
        let pl = rp.part_len();
        let work = &mut w.work;
        work.clear();
        work.resize((rp.n - 1) * pl, 0.0);
        let parts_p: Vec<SyncPtr<f64>> = (0..rp.n)
            .map(|r| if r == 0 { SyncPtr::of(&mut []) } else { SyncPtr::of(&mut work[(r - 1) * pl..r * pl]) })
            .collect();
        for_each_index(rp.n, |r| {
            let part = parts_p[r];
            let mut el = EList::default();
            let mut ms: Vec<[f64; 3]> = Vec::new();
            for &pi in &rp.points[r] {
                if failed.load(std::sync::atomic::Ordering::Relaxed) { return; }
                let pi = pi as usize;
                m.eblocks(pi, st, dh, &mut el);
                if el.is_empty() && !anchored[pi] { continue; }
                let mut cp = cmat[pi];
                for i in 0..3 { cp[i][i] = cp[i][i] * (1.0 + lambda) + 1e-12; }
                let cinv = match inv3(&cp) { Some(m) => m, None => { failed.store(true, std::sync::atomic::Ordering::Relaxed); return; } };
                let tmp = mat3_vec(&cinv, &gpv[pi]); // C⁻¹·gp
                let owner = rp.owner[pi] as usize == r;
                // SAFETY (all writes below): RangePlan gives each element one writing range.
                if owner { unsafe { *ci_p.at(pi) = Some(cinv); } }
                for eb in &el.blocks {
                    let camera = eb.blk < rp.n_free;
                    if !(if camera { rp.range(eb.blk) == r } else { owner }) { continue; }
                    let rows = el.rows_of(eb);
                    for a in 0..eb.dim {
                        let v = rows[a][0]*tmp[0] + rows[a][1]*tmp[1] + rows[a][2]*tmp[2];
                        if camera || r == 0 { unsafe { *rhs_p.at(eb.off + a) += v; } }
                        else { unsafe { *part.at(rp.gg_len + eb.off + a - rp.group_off) += v; } }
                    }
                }
                ms.clear();
                ms.extend(el.rows.iter().map(|e| [0, 1, 2].map(|k| e[0]*cinv[0][k] + e[1]*cinv[1][k] + e[2]*cinv[2][k])));
                for eb1 in &el.blocks {
                    let m = &ms[eb1.at..eb1.at + eb1.dim];
                    // Row eb1 of the pattern, searched for each eb2.
                    let k0 = pattern.row_ptr[eb1.blk];
                    let row = &pattern.cols[k0..pattern.row_ptr[eb1.blk + 1]];
                    for eb2 in &el.blocks {
                        if eb2.blk > eb1.blk { continue; }
                        // Row eb1's owner for a camera row; the column camera's owner
                        // for a group row; the point's owner for group × group.
                        let (mine, direct) = if eb1.blk < rp.n_free { (rp.range(eb1.blk) == r, true) }
                            else if eb2.blk < rp.n_free { (rp.range(eb2.blk) == r, true) }
                            else { (owner, r == 0) };
                        if !mine { continue; }
                        let k = k0 + row.binary_search(&(eb2.blk as u32)).expect("block outside the reduced-system pattern");
                        let at = if direct { pattern.val_at[k] } else { rp.gg_part[k - rp.gg_k0] };
                        let dst = if direct { s_p } else { part };
                        let e2 = el.rows_of(eb2);
                        if eb1.blk < rp.n_free && eb2.blk < rp.n_free {
                            // Camera × camera (direct: a camera row), the same sums as below.
                            sub_mt6(unsafe { s_p.slice(at, 36) }, m.try_into().unwrap(), e2.try_into().unwrap());
                            continue;
                        }
                        for a in 0..eb1.dim {
                            for b in 0..eb2.dim {
                                let v = m[a][0]*e2[b][0] + m[a][1]*e2[b][1] + m[a][2]*e2[b][2];
                                if direct { unsafe { *dst.at(at + a*eb2.dim + b) -= v; } }
                                else { unsafe { *dst.at(at + a*eb2.dim + b) += v; } }
                            }
                        }
                    }
                }
            }
        });
        ok = !failed.load(std::sync::atomic::Ordering::Relaxed);
        // The other ranges' group shares, in range order.
        for part in work.chunks(pl.max(1)).take(rp.n - 1) {
            for &(base, len, o) in &rp.gg {
                for i in 0..len { s[base + i] -= part[o + i]; }
            }
            for i in 0..rp.group_rows { rhs[rp.group_off + i] += part[rp.gg_len + i]; }
        }
    } else {
        // Point chunks (`point_chunks`; the Schur order is the index order here): each
        // chunk subtracts into its own shares of S and adds into its share of the
        // right-hand side, added in chunk order after.
        let (lower_only, implicit) = (plan.lower_only, plan.implicit);
        for v in w.share_s.iter_mut() { v.fill(0.0); }
        for v in w.share_r.iter_mut() { v.fill(0.0); }
        let failed = std::sync::atomic::AtomicBool::new(false);
        let s_ps: Vec<SyncPtr<f64>> = w.share_s.iter_mut().map(|v| SyncPtr::of(v)).collect();
        let r_ps: Vec<SyncPtr<f64>> = w.share_r.iter_mut().map(|v| SyncPtr::of(v)).collect();
        let ci_p = SyncPtr::of(&mut cinv_store);
        for_each_index(plan.point_chunks, |c| {
            let (s_p, r_p) = (s_ps[c], r_ps[c]);
            let mut el = EList::default();
            let mut ms: Vec<[f64; 3]> = Vec::new();
            for pi in plan.chunk_range(c, n_pts) {
                if failed.load(std::sync::atomic::Ordering::Relaxed) { return; }
                m.eblocks(pi, st, dh, &mut el);
                // An anchored point with no camera coupling (edge case: every
                // observing camera failed cheirality) still needs its C⁻¹·gp
                // computed so the back-substitution moves it toward the anchor.
                if el.is_empty() && !anchored[pi] { continue; }
                let mut cp = cmat[pi];
                for i in 0..3 { cp[i][i] = cp[i][i] * (1.0 + lambda) + 1e-12; }
                let cinv = match inv3(&cp) { Some(m) => m, None => { failed.store(true, std::sync::atomic::Ordering::Relaxed); return; } };
                let tmp = mat3_vec(&cinv, &gpv[pi]); // C⁻¹·gp
                // SAFETY (all writes below): chunk c alone writes its shares and its points.
                unsafe { *ci_p.at(pi) = Some(cinv); }
                for eb in &el.blocks {
                    let rows = el.rows_of(eb);
                    for a in 0..eb.dim {
                        unsafe { *r_p.at(eb.off + a) += rows[a][0]*tmp[0] + rows[a][1]*tmp[1] + rows[a][2]*tmp[2]; }
                    }
                }
                // M_v = E_v·C⁻¹ (dim×3); then S -= Σ_{v1,v2} M_{v1}·E_{v2}ᵀ.
                ms.clear();
                ms.extend(el.rows.iter().map(|e| [0, 1, 2].map(|k| e[0]*cinv[0][k] + e[1]*cinv[1][k] + e[2]*cinv[2][k])));
                for eb1 in &el.blocks {
                    let m = &ms[eb1.at..eb1.at + eb1.dim];
                    let k0 = pattern.row_ptr[eb1.blk];
                    let row = &pattern.cols[k0..pattern.row_ptr[eb1.blk + 1]];
                    for eb2 in &el.blocks {
                        if lower_only && eb2.blk > eb1.blk { continue; }
                        if implicit && eb2.blk != eb1.blk { continue; }
                        let base = pattern.val_at[k0 + row.binary_search(&(eb2.blk as u32)).expect("block outside the reduced-system pattern")];
                        let e2 = el.rows_of(eb2);
                        if eb1.dim == 6 && eb2.dim == 6 {
                            // Camera × camera, fixed size (the same sums as below).
                            sub_mt6(unsafe { s_p.slice(base, 36) }, m.try_into().unwrap(), e2.try_into().unwrap());
                        } else {
                            for a in 0..eb1.dim {
                                for b in 0..eb2.dim {
                                    let v = m[a][0]*e2[b][0] + m[a][1]*e2[b][1] + m[a][2]*e2[b][2];
                                    unsafe { *s_p.at(base + a*eb2.dim + b) -= v; }
                                }
                            }
                        }
                    }
                }
            }
        });
        ok = !failed.load(std::sync::atomic::Ordering::Relaxed);
        if ok && implicit { w.b_damped.clone_from(s); }
        if ok {
            for c in 0..plan.point_chunks {
                for (x, v) in s.iter_mut().zip(&w.share_s[c]) { *x += v; }
                for (x, v) in rhs.iter_mut().zip(&w.share_r[c]) { *x += v; }
            }
        }
    }
    Reduced { ok, rhs, cinv_store }
}

/// A 6×6 block of S (row-major in `dst`) less M·Eᵀ: element (a, b) less m[a]·e[b], its
/// three products summed in order, as the general loops do. On wasm two b at a time in
/// f64x2 lanes: each lane makes the same multiplications and additions in the same order
/// (wasm has no fused multiply-add), so the same bits.
#[inline(always)]
fn sub_mt6(dst: &mut [f64], m: &[[f64; 3]; 6], e: &[[f64; 3]; 6]) {
    let dst: &mut [f64; 36] = dst.try_into().unwrap();
    #[cfg(target_arch = "wasm32")]
    {
        use core::arch::wasm32::*;
        // E by column, b in pairs: c[k][h] = (e[2h][k], e[2h + 1][k]).
        let c: [[v128; 3]; 3] = [0, 1, 2].map(|k| [0, 1, 2].map(|h| f64x2(e[2 * h][k], e[2 * h + 1][k])));
        for a in 0..6 {
            let (m0, m1, m2) = (f64x2_splat(m[a][0]), f64x2_splat(m[a][1]), f64x2_splat(m[a][2]));
            for h in 0..3 {
                let v = f64x2_add(f64x2_add(f64x2_mul(m0, c[0][h]), f64x2_mul(m1, c[1][h])), f64x2_mul(m2, c[2][h]));
                // SAFETY: elements a·6 + 2h and a·6 + 2h + 1 are inside the 36.
                unsafe {
                    let p = dst.as_mut_ptr().add(a * 6 + 2 * h) as *mut v128;
                    v128_store(p, f64x2_sub(v128_load(p), v));
                }
            }
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    for a in 0..6 {
        for b in 0..6 {
            let v = m[a][0]*e[b][0] + m[a][1]*e[b][1] + m[a][2]*e[b][2];
            dst[a*6 + b] -= v;
        }
    }
}

/// Back-substitute the points: δp = −C⁻¹·gp − C⁻¹·(Σ_v E_vᵀ·δv). Every point on its own:
/// on the pool, CHUNK points per task. C⁻¹·gp is recomputed, not kept.
pub(crate) fn back_substitute(m: &Model, st: &State, dh: f64, cinv_store: &[Option<M3>], gpv: &[V3], dsol: &[f64]) -> Vec<V3> {
    let n_pts = m.p.n_pts;
    let mut dp = vec![[0f64; 3]; n_pts];
    let dp_p = SyncPtr::of(&mut dp);
    for_each_index(n_pts.div_ceil(CHUNK), |k| {
        let mut el = EList::default();
        for pi in k * CHUNK..((k + 1) * CHUNK).min(n_pts) {
            let cinv = match cinv_store[pi] { Some(m) => m, None => continue };
            m.eblocks(pi, st, dh, &mut el);
            let mut acc = [0f64; 3];
            for eb in &el.blocks {
                let rows = el.rows_of(eb);
                for k in 0..3 {
                    let mut sdot = 0.0;
                    for a in 0..eb.dim { sdot += rows[a][k] * dsol[eb.off + a]; }
                    acc[k] += sdot;
                }
            }
            let ca = mat3_vec(&cinv, &acc);
            // SAFETY: point pi belongs to chunk k alone.
            let d = unsafe { dp_p.at(pi) };
            let tmp = mat3_vec(&cinv, &gpv[pi]); // C⁻¹·gp, as the Schur step had it
            for k in 0..3 { d[k] = -tmp[k] - ca[k]; }
        }
    });
    dp
}
