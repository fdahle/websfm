// The observation model at a state of the solve: each camera's effective intrinsics and
// pose under the group params, the reprojection error, the robust cost the LM descends,
// and one observation's residual and Jacobian rows.

#[allow(unused_imports)]
use crate::linalg::*;
#[allow(unused_imports)]
use crate::par::map_indexed;
#[allow(unused_imports)]
use super::*;

/// What the solve moves: one pose per block, the points, and each group's params (the
/// focal-scale slot, if present, inits to 1 and multiplies fx/fy; every other slot inits
/// to 0, a fisheye group's k slots being offsets from its seed coefficients).
#[derive(Clone)]
pub(crate) struct State {
    pub cams: Vec<(M3, V3)>,
    pub pts: Vec<V3>,
    pub gpar: Vec<[f64; BLK_MAX]>,
}

/// The Huber loss of one observation's [q, s] (`Model::resid`) at threshold δ: the loss the
/// IRLS weight r = δ/e descends, ρ = q·(2r − r²) past e = √s > δ (see `robust_cost`); δ²
/// for one that projects nowhere.
#[inline]
pub(crate) fn rho([q, s]: [f64; 2], dh: f64) -> f64 {
    if s < 0.0 { return dh * dh; }
    let e = s.sqrt();
    if e <= dh { q } else { let r = dh / e; q * (2.0 * r - r * r) }
}

/// 2.5 × the median residual, at least 1 px (1 px with none).
fn median_threshold(mut es: Vec<f64>) -> f64 {
    if es.is_empty() { return 1.0; }
    // The median by selection: the same element a full sort puts there.
    let mid = es.len() / 2;
    let (_, m, _) = es.select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
    (2.5 * *m).max(1.0)
}

/// Effective K, lens coefficients (k1..k4, p1, p2) and whether the camera is a fisheye.
pub(crate) struct Eff { pub fx: f64, pub fy: f64, pub cx: f64, pub cy: f64, pub k: [f64; 4], pub p: [f64; 2], pub fisheye: bool }

/// One observation linearised: its residual, IRLS weights and the camera (6), point (3)
/// and intrinsics (kdim) Jacobian rows.
pub(crate) struct Jac {
    pub ci: usize, pub ru: f64, pub rv: f64, pub wu: f64, pub wv: f64, pub ju: [f64; 6], pub jv: [f64; 6],
    pub jpu: [f64; 3], pub jpv: [f64; 3], pub jku: [f64; BLK_MAX], pub jkv: [f64; BLK_MAX],
}

pub(crate) struct Model<'a> {
    pub p: &'a Problem,
    pub l: &'a Layout,
    // SolverOpts::huber.
    pub huber: Option<f64>,
}

impl Model<'_> {
    /// The starting group params.
    pub(crate) fn initial_gpar(&self) -> Vec<[f64; BLK_MAX]> {
        let mut gpar = vec![[0.0f64; BLK_MAX]; self.l.g_count.max(1)];
        if self.l.idx_s >= 0 { for g in gpar.iter_mut() { g[self.l.idx_s as usize] = 1.0; } }
        gpar
    }

    /// Camera ci's intrinsics under the group params. Pinhole: the Brown residual;
    /// fisheye: seed + offset.
    pub(crate) fn eff(&self, ci: usize, gpar: &[[f64; BLK_MAX]]) -> Eff {
        let l = self.l;
        let (fx0, fy0, cx0, cy0) = self.p.ks[ci];
        let (terms, k0, p0) = self.p.lens[ci];
        let fisheye = terms > 0;
        if !l.refine { return Eff { fx: fx0, fy: fy0, cx: cx0, cy: cy0, k: k0, p: p0, fisheye }; }
        let g = gpar[l.grp[ci]];
        let get = |idx: isize| -> f64 { if idx >= 0 { g[idx as usize] } else { 0.0 } };
        let s = if l.idx_s >= 0 { g[l.idx_s as usize] } else { 1.0 };
        let k = [0, 1, 2, 3].map(|j| k0[j] + get(l.idx_k[j]));
        let p = if fisheye { [0.0; 2] } else { [p0[0] + get(l.idx_p1), p0[1] + get(l.idx_p2)] };
        Eff { fx: s * fx0, fy: s * fy0, cx: cx0 + get(l.idx_dcx), cy: cy0 + get(l.idx_dcy), k, p, fisheye }
    }

    /// Camera ci's readout time under the group params (0 without rolling shutter).
    pub(crate) fn tau_of(&self, ci: usize, gpar: &[[f64; BLK_MAX]]) -> f64 {
        let l = self.l;
        match self.p.rs[ci] {
            None => 0.0,
            Some((_, _, t0)) => if l.idx_rs >= 0 && l.refine { l.group_tau0[l.grp[ci]] + gpar[l.grp[ci]][l.idx_rs as usize] } else { t0 },
        }
    }

    /// Camera ci's lens offset under the group params, (Exp(ω)·R_o, t_o), or None.
    pub(crate) fn offset_rot(&self, ci: usize, gpar: &[[f64; BLK_MAX]]) -> Option<(M3, V3)> {
        let l = self.l;
        let (ro, to) = self.p.off[ci]?;
        if l.idx_rig >= 0 && l.refine {
            let (p, i) = (gpar[l.grp[ci]], l.idx_rig as usize);
            Some((mat3_mul(&so3_exp(&[p[i], p[i + 1], p[i + 2]]), &ro), to))
        } else { Some((ro, to)) }
    }

    /// Camera ci's pose: its capture's, composed with its offset when it has one.
    pub(crate) fn pose_of(&self, ci: usize, cams: &[(M3, V3)], gpar: &[[f64; BLK_MAX]]) -> (M3, V3) {
        let (r, t) = cams[self.p.pb[ci]];
        match self.offset_rot(ci, gpar) {
            None => (r, t),
            Some((ro, to)) => {
                let rt = mat3_vec(&ro, &t);
                (mat3_mul(&ro, &r), [rt[0] + to[0], rt[1] + to[1], rt[2] + to[2]])
            }
        }
    }

    /// The point observation o sees: X − τ·s·v (rolling shutter), or X itself, and the
    /// shift direction −s·v (for τ's Jacobian).
    pub(crate) fn seen_point(&self, o: usize, pts: &[V3], gpar: &[[f64; BLK_MAX]]) -> (V3, V3) {
        let (ci, pi, _, oy, _, _) = self.p.ob(o);
        match self.p.rs[ci] {
            None => (pts[pi], [0.0; 3]),
            Some((v, h, _)) => {
                let s = (oy - self.p.ks[ci].3) / h;
                let tau = self.tau_of(ci, gpar);
                let x = pts[pi];
                ([x[0] - tau * s * v[0], x[1] - tau * s * v[1], x[2] - tau * s * v[2]], [-s * v[0], -s * v[1], -s * v[2]])
            }
        }
    }

    /// One observation's squared reprojection error, NaN when it projects nowhere.
    pub(crate) fn sq_err(&self, o: usize, st: &State) -> f64 {
        let (ci, pi, ox, oy, _, _) = self.p.ob(o);
        let pose = self.pose_of(ci, &st.cams, &st.gpar);
        let (r, t) = &pose;
        let e = self.eff(ci, &st.gpar);
        let x = if self.p.rs_any { self.seen_point(o, &st.pts, &st.gpar).0 } else { st.pts[pi] };
        let (px, py) = project_full(r, t, e.fx, e.fy, e.cx, e.cy, &e.k, &e.p, e.fisheye, &x);
        if px.is_nan() { f64::NAN } else { (px - ox).powi(2) + (py - oy).powi(2) }
    }

    /// One observation's weighted and plain squared errors at the state, [q, s] =
    /// [wx·dx² + wy·dy², dx² + dy²]; s = −1 when it projects nowhere. The robust cost, the
    /// Huber threshold and the RMS all follow from these (`rho`, `fill_residuals`).
    #[inline]
    pub(crate) fn resid(&self, o: usize, st: &State) -> [f64; 2] {
        let (ci, pi, ox, oy, wx, wy) = self.p.ob(o);
        let pose = self.pose_of(ci, &st.cams, &st.gpar);
        let (r, t) = &pose;
        let e = self.eff(ci, &st.gpar);
        let x = if self.p.rs_any { self.seen_point(o, &st.pts, &st.gpar).0 } else { st.pts[pi] };
        let (px, py) = project_full(r, t, e.fx, e.fy, e.cx, e.cy, &e.k, &e.p, e.fisheye, &x);
        if px.is_nan() { return [f64::NAN, -1.0]; }
        let dx = px - ox; let dy = py - oy;
        [wx*dx*dx + wy*dy*dy, dx*dx + dy*dy]
    }

    /// Every observation's [q, s] at the state into `buf` (on the pool when there is one).
    /// The LM loop keeps them for the accepted state, so an iteration projects once: the
    /// trial cost fills them, and the threshold, the start cost and the RMS trace read them.
    pub(crate) fn fill_residuals(&self, st: &State, buf: &mut Vec<[f64; 2]>) {
        let n_obs = self.p.obs.len();
        buf.resize(n_obs, [0.0; 2]);
        let bp = crate::par::SyncPtr::of(buf);
        crate::par::for_each_index(n_obs.div_ceil(crate::par::CHUNK), |k| {
            // SAFETY: chunk k alone writes observations k·CHUNK … (k+1)·CHUNK − 1.
            for o in k * crate::par::CHUNK..((k + 1) * crate::par::CHUNK).min(n_obs) { unsafe { *bp.at(o) = self.resid(o, st); } }
        });
    }

    /// `rms` from the residuals of `fill_residuals`: the same sum, in observation order.
    pub(crate) fn rms_of(res: &[[f64; 2]]) -> f64 {
        let mut sse = 0.0f64; let mut cnt = 0usize;
        for &[_, s] in res {
            if !(s >= 0.0) { continue; }
            sse += s; cnt += 1;
        }
        if cnt == 0 { 0.0 } else { (sse / cnt as f64).sqrt() }
    }

    /// `robust_cost` from the residuals of `fill_residuals` at the same state `st`.
    pub(crate) fn robust_cost_of(&self, res: &[[f64; 2]], st: &State, dh: f64) -> f64 {
        let mut sum = 0.0f64;
        for &r in res { sum += rho(r, dh); }
        sum + self.p.anchor_sse(&st.pts) + self.p.camera_prior_sse(&st.cams)
    }

    /// `huber_threshold` from the residuals of `fill_residuals`.
    pub(crate) fn huber_threshold_of(&self, res: &[[f64; 2]]) -> f64 {
        match self.huber {
            Some(d) if d > 0.0 => return d,
            Some(_) => return NO_LOSS_DELTA,
            None => {}
        }
        median_threshold(res.iter().filter(|r| r[1] >= 0.0).map(|r| r[1].sqrt()).collect())
    }

    /// Plain RMS reprojection error over all observations (reported to the caller). The
    /// per-observation loops run on the pool (par.rs map_indexed) and are summed here in
    /// observation order, so they give the plain loop's bits.
    pub(crate) fn rms(&self, st: &State) -> f64 {
        let mut sse = 0.0f64; let mut cnt = 0usize;
        for v in map_indexed(self.p.obs.len(), |o| self.sq_err(o, st)) {
            if v.is_nan() { continue; }
            sse += v; cnt += 1;
        }
        if cnt == 0 { 0.0 } else { (sse / cnt as f64).sqrt() }
    }

    /// Huber-robustified cost Σ ρ(‖r‖) at pixel threshold δ, plus the (unrobustified,
    /// quadratic) anchor and camera-prior terms: the objective the LM step descends.
    pub(crate) fn robust_cost(&self, st: &State, dh: f64) -> f64 {
        let terms = map_indexed(self.p.obs.len(), |o| {
            let (ci, pi, ox, oy, wx, wy) = self.p.ob(o);
            let pose = self.pose_of(ci, &st.cams, &st.gpar);
            let (r, t) = &pose;
            let e = self.eff(ci, &st.gpar);
            let x = if self.p.rs_any { self.seen_point(o, &st.pts, &st.gpar).0 } else { st.pts[pi] };
            let (px, py) = project_full(r, t, e.fx, e.fy, e.cx, e.cy, &e.k, &e.p, e.fisheye, &x);
            if px.is_nan() { return dh * dh; }
            let dx=px-ox; let dy=py-oy; let e=(dx*dx+dy*dy).sqrt();
            // The Huber loss the IRLS weight r = δ/e actually descends: ρ = q·(2r − r²)
            // (= 2δe − δ² for unit weights), continuous with q at e = δ. Evaluating
            // r·q (= δe) instead halved the outlier slope relative to the step model
            // and the anchor/prior terms, so step acceptance judged a different cost.
            let q = wx*dx*dx + wy*dy*dy;
            if e <= dh { q } else { let r = dh/e; q * (2.0*r - r*r) }
        });
        let mut sum = 0.0f64;
        for v in terms { sum += v; }
        sum + self.p.anchor_sse(&st.pts) + self.p.camera_prior_sse(&st.cams)
    }

    /// The Huber threshold: SolverOpts::huber's fixed one, or none (a δ no residual
    /// reaches: an observation on the camera plane still costs δ², finite), or by default
    /// a multiple of the residual median, so it tracks the noise floor as the model
    /// tightens. Recomputed once per outer iteration.
    pub(crate) fn huber_threshold(&self, st: &State) -> f64 {
        match self.huber {
            Some(d) if d > 0.0 => return d,
            Some(_) => return NO_LOSS_DELTA,
            None => {}
        }
        let mut es: Vec<f64> = map_indexed(self.p.obs.len(), |o| self.sq_err(o, st).sqrt());
        es.retain(|v| !v.is_nan());
        median_threshold(es)
    }

    /// Observation o linearised at the state. None when the point sits on the camera
    /// plane. The assembly and the Schur steps both call it (identically), instead of
    /// keeping each point's coupling blocks between them: those were 160 B per
    /// observation, the largest term at thousands of cameras.
    pub(crate) fn jac(&self, o: usize, st: &State, dh: f64) -> Option<Jac> {
        let (p, l) = (self.p, self.l);
        let gpar = &st.gpar;
        let (ci, pi, ox, oy, obs_wx, obs_wy) = p.ob(o);
        let (r, t) = &st.cams[p.pb[ci]];
        let Eff { fx, fy, cx, cy, k, p: tp, fisheye } = self.eff(ci, gpar);
        let (xs, sdir) = if p.rs_any { self.seen_point(o, &st.pts, gpar) } else { (st.pts[pi], [0.0; 3]) };
        let pc = mat3_vec(r, &xs); // R·X (the rolling-shutter-shifted X)
        // A lens with an offset sees R_o·q + t_o of the capture-frame point q = R·X + t
        // (`rq` = R_o·q, for ω's Jacobian).
        let ro_o = self.offset_rot(ci, gpar);
        let (xc, yc, zc, rq) = match ro_o {
            None => (pc[0] + t[0], pc[1] + t[1], pc[2] + t[2], [0.0; 3]),
            Some((ro, to)) => {
                let rq = mat3_vec(&ro, &[pc[0] + t[0], pc[1] + t[1], pc[2] + t[2]]);
                (rq[0] + to[0], rq[1] + to[1], rq[2] + to[2], rq)
            }
        };
        if zc.abs() < 1e-9 { return None; }
        let inv = 1.0 / zc;
        // Normalised coords and the lens's radial factor m (lens_factor): m ≡ 1, and
        // every derivative reduces to the pinhole case, for a pinhole with all k = 0.
        let a = xc * inv; let b = yc * inv;
        let DistJac { xd, yd, j: [[xa, xb], [ya, yb]], dk, dp } = distort_jac(a, b, &k, &tp, fisheye);
        let ru = fx * xd + cx - ox;
        let rv = fy * yd + cy - oy;
        // ∂proj/∂x_cam (2×3), exact analytic: the distorted point's 2×2 Jacobian in (a, b)
        // (distort_jac) through ∂a/∂(xc,yc,zc) = (1, 0, −a)/zc, ∂b/… = (0, 1, −b)/zc.
        let dudc = [fx * inv * xa, fx * inv * xb, -fx * inv * (xa*a + xb*b)];
        let dvdc = [fy * inv * ya, fy * inv * yb, -fy * inv * (ya*a + yb*b)];
        // Through a lens offset ∂x_cam/∂q = R_o: the capture's and the point's Jacobians
        // see ∂proj/∂x_cam · R_o (the same rows when there is none).
        let vm = |v: &[f64; 3], m: &M3| -> [f64; 3] { [0, 1, 2].map(|k| v[0]*m[0][k] + v[1]*m[1][k] + v[2]*m[2][k]) };
        let (dqu, dqv) = match ro_o { None => (dudc, dvdc), Some((ro, _)) => (vm(&dudc, &ro), vm(&dvdc, &ro)) };
        // Camera Jacobian Jc (2×6): [I | −[pc]_×] through ∂proj/∂x_cam.
        let sp = skew(&pc);
        let mut ju = [0f64; 6]; let mut jv = [0f64; 6];
        ju[..3].copy_from_slice(&dqu); jv[..3].copy_from_slice(&dqv);
        for k in 0..3 {
            let colk = [-sp[0][k], -sp[1][k], -sp[2][k]];
            ju[3 + k] = dqu[0]*colk[0] + dqu[1]*colk[1] + dqu[2]*colk[2];
            jv[3 + k] = dqv[0]*colk[0] + dqv[1]*colk[1] + dqv[2]*colk[2];
        }
        // Point Jacobian Jp (2×3) = ∂proj/∂x_cam · R.
        let mut jpu = [0f64; 3]; let mut jpv = [0f64; 3];
        for k in 0..3 {
            jpu[k] = dqu[0]*r[0][k] + dqu[1]*r[1][k] + dqu[2]*r[2][k];
            jpv[k] = dqv[0]*r[0][k] + dqv[1]*r[1][k] + dqv[2]*r[2][k];
        }
        // Intrinsic Jacobian Jk (2×kdim), filled by slot (idx_* is the param's
        // position in [s?,dcx?,dcy?,k1?,k2?,k3?,k4?]). ∂/∂s = (fx0·a·m, fy0·b·m);
        // ∂/∂dcx = (1,0), ∂/∂dcy = (0,1); ∂/∂kj = (fx·a·∂m/∂kj, fy·b·∂m/∂kj) — r^{2j}
        // for Brown, θ^{2j+1}/r for a fisheye. A slot the group's lens lacks stays 0.
        let mut jku = [0f64; BLK_MAX]; let mut jkv = [0f64; BLK_MAX];
        if l.refine {
            let (fx0, fy0, _, _) = p.ks[ci];
            let (idx_s, idx_dcx, idx_dcy, idx_k, idx_p1, idx_p2, idx_rs, idx_rig) =
                (l.idx_s, l.idx_dcx, l.idx_dcy, l.idx_k, l.idx_p1, l.idx_p2, l.idx_rs, l.idx_rig);
            if idx_s   >= 0 { jku[idx_s   as usize] = fx0 * xd; jkv[idx_s   as usize] = fy0 * yd; }
            if idx_dcx >= 0 { jku[idx_dcx as usize] = 1.0; }
            if idx_dcy >= 0 { jkv[idx_dcy as usize] = 1.0; }
            for j in 0..4 {
                if idx_k[j] >= 0 && l.k_live(l.grp[ci], j) {
                    jku[idx_k[j] as usize] = fx * a * dk[j]; jkv[idx_k[j] as usize] = fy * b * dk[j];
                }
            }
            // ∂/∂p1 = (fx·2ab, fy·(r² + 2b²)), ∂/∂p2 = (fx·(r² + 2a²), fy·2ab): Brown only.
            if idx_p1 >= 0 && l.p_live(l.grp[ci]) {
                jku[idx_p1 as usize] = fx * dp[0][0]; jkv[idx_p1 as usize] = fy * dp[1][0];
                jku[idx_p2 as usize] = fx * dp[0][1]; jkv[idx_p2 as usize] = fy * dp[1][1];
            }
            // ∂/∂τ: the camera-frame point moves by R·(−s·v) per unit τ.
            if idx_rs >= 0 && p.rs[ci].is_some() {
                let rd = mat3_vec(r, &sdir);
                jku[idx_rs as usize] = dqu[0]*rd[0] + dqu[1]*rd[1] + dqu[2]*rd[2];
                jkv[idx_rs as usize] = dqv[0]*rd[0] + dqv[1]*rd[1] + dqv[2]*rd[2];
            }
            // ∂/∂ω (left perturbation of the offset rotation): −[R_o·q]_× through ∂proj/∂x_cam.
            if idx_rig >= 0 && ro_o.is_some() {
                let sq = skew(&rq);
                for k in 0..3 {
                    let colk = [-sq[0][k], -sq[1][k], -sq[2][k]];
                    jku[idx_rig as usize + k] = dudc[0]*colk[0] + dudc[1]*colk[1] + dudc[2]*colk[2];
                    jkv[idx_rig as usize + k] = dvdc[0]*colk[0] + dvdc[1]*colk[1] + dvdc[2]*colk[2];
                }
            }
        }
        // Huber IRLS weight.
        let e = (ru*ru + rv*rv).sqrt();
        let w = if e <= dh { 1.0 } else { dh / e };
        Some(Jac { ci, ru, rv, wu: w * obs_wx, wv: w * obs_wy, ju, jv, jpu, jpv, jku, jkv })
    }

    /// `eblocks` from the rows the assembly cached (Plan::use_ecache): the same values.
    pub(crate) fn eblocks_cached(&self, pi: usize, ec: &[f64], ev: &[bool], es: usize, list: &mut EList) {
        let (p, l) = (self.p, self.l);
        list.clear();
        for q in p.pt_start[pi]..p.pt_start[pi + 1] {
            let o = p.pt_obs[q as usize] as usize;
            if !ev[o] { continue; }
            let (row, ci) = (&ec[o * es..(o + 1) * es], p.obs[o].0 as usize);
            let sj = l.slot[p.pb[ci]];
            if sj != FIXED { list.add(sj, 6 * sj, 6, p.pb_dup, |a| [row[a * 3], row[a * 3 + 1], row[a * 3 + 2]]); }
            if l.refine {
                let g = l.grp[ci];
                list.add(l.n_free + g, l.group_off + g * l.kdim, l.kdim, true, |a| [row[18 + a * 3], row[19 + a * 3], row[20 + a * 3]]);
            }
        }
    }

    /// Point pi's coupling blocks E (Jvarᵀ·Jp): camera then group, per observation.
    /// A camera block merges only where a point has two observations on one pose block
    /// (`Problem::pb_dup`); a group block with the point's other observations in its group.
    pub(crate) fn eblocks(&self, pi: usize, st: &State, dh: f64, list: &mut EList) {
        let (p, l) = (self.p, self.l);
        list.clear();
        for q in p.pt_start[pi]..p.pt_start[pi + 1] {
            let Some(j) = self.jac(p.pt_obs[q as usize] as usize, st, dh) else { continue };
            let sj = l.slot[p.pb[j.ci]];
            if sj != FIXED {
                list.add(sj, 6 * sj, 6, p.pb_dup, |a| [0, 1, 2].map(|b| j.wu*j.ju[a]*j.jpu[b] + j.wv*j.jv[a]*j.jpv[b]));
            }
            if l.refine {
                let g = l.grp[j.ci];
                list.add(l.n_free + g, l.group_off + g * l.kdim, l.kdim, true,
                         |a| [0, 1, 2].map(|b| j.wu*j.jku[a]*j.jpu[b] + j.wv*j.jkv[a]*j.jpv[b]));
            }
        }
    }
}
