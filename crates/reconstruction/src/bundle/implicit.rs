// The implicit solve (S never stored): the Jacobian cache and the product S·x through the
// points, for PCG in the LM steps and for the lens σ after them.

#[allow(unused_imports)]
use crate::linalg::*;
#[allow(unused_imports)]
use crate::par::{for_each_index, SyncPtr, CHUNK};
#[allow(unused_imports)]
use super::*;

/// The Jacobian cache at the given linearisation (Plan::use_jcache).
pub(crate) fn fill_jcache(m: &Model, plan: &Plan, st: &State, dh: f64, jcache: &mut Vec<f32>) {
    let (n_obs, jstride, jk) = (m.p.obs.len(), plan.jstride, plan.jk);
    jcache.resize(jstride * n_obs, 0.0);
    let jp = SyncPtr::of(jcache);
    for_each_index(n_obs.div_ceil(CHUNK), |k| {
        for o in k * CHUNK..((k + 1) * CHUNK).min(n_obs) {
            // SAFETY: observation o belongs to chunk k alone.
            let row = unsafe { jp.slice(o * jstride, jstride) };
            let Some(j) = m.jac(o, st, dh) else { row.fill(0.0); continue };
            let (su, sv) = (j.wu.max(0.0).sqrt(), j.wv.max(0.0).sqrt());
            for a in 0..6 { row[a] = (su * j.ju[a]) as f32; row[6 + a] = (sv * j.jv[a]) as f32; }
            for k in 0..3 { row[12 + k] = (su * j.jpu[k]) as f32; row[15 + k] = (sv * j.jpv[k]) as f32; }
            for a in 0..jk { row[18 + a] = (su * j.jku[a]) as f32; row[18 + jk + a] = (sv * j.jkv[a]) as f32; }
        }
    });
}

/// y = S·x = B·x − Σ_p E_p·C_p⁻¹·E_pᵀ·x, a point chunk at a time, each into its own share
/// (`shares`: Work::share_r's buffers, free while the implicit solve runs), added in chunk
/// order. `b`: B as the solve has it (damped); `cinv_store`: the points' C⁻¹.
#[allow(clippy::too_many_arguments)]
pub(crate) fn implicit_product(m: &Model, plan: &Plan, b: &[f64], cinv_store: &[Option<M3>], jcache: &[f32],
                               shares: &mut [Vec<f64>], st: &State, dh: f64, x: &[f64], y: &mut [f64]) {
    let (p, l) = (m.p, m.l);
    let (n_pts, n, kdim, group_off) = (p.n_pts, l.n, l.kdim, l.group_off);
    let (obs, pt_start, pt_obs, pb, slot, grp) = (&p.obs, &p.pt_start, &p.pt_obs, &p.pb, &l.slot, &l.grp);
    let (use_jcache, jstride, jk) = (plan.use_jcache, plan.jstride, plan.jk);
    for v in shares.iter_mut() { v.fill(0.0); }
    let ps: Vec<SyncPtr<f64>> = shares.iter_mut().map(|v| SyncPtr::of(v)).collect();
    for_each_index(plan.point_chunks, |c| {
        let p = ps[c];
        let mut el = EList::default();
        for pi in plan.chunk_range(c, n_pts) {
            let Some(cinv) = cinv_store[pi] else { continue };
            if use_jcache {
                // E_o = √w·J_varᵀ ⊗ √w·J_p over the point's observations o.
                let qs = pt_start[pi] as usize..pt_start[pi + 1] as usize;
                let at = |o: usize| { let ci = obs[o].0 as usize; (slot[pb[ci]], group_off + if jk > 0 { grp[ci] * kdim } else { 0 }) };
                let mut t = [0f64; 3];
                for q in qs.clone() {
                    let o = pt_obs[q] as usize;
                    let j = &jcache[o * jstride..(o + 1) * jstride];
                    let (sc, go) = at(o);
                    let (mut su, mut sv) = (0.0, 0.0);
                    if sc != FIXED { for a in 0..6 { su += j[a] as f64 * x[6 * sc + a]; sv += j[6 + a] as f64 * x[6 * sc + a]; } }
                    for a in 0..jk { su += j[18 + a] as f64 * x[go + a]; sv += j[18 + jk + a] as f64 * x[go + a]; }
                    for k in 0..3 { t[k] += j[12 + k] as f64 * su + j[15 + k] as f64 * sv; }
                }
                let z = mat3_vec(&cinv, &t);
                for q in qs {
                    let o = pt_obs[q] as usize;
                    let j = &jcache[o * jstride..(o + 1) * jstride];
                    let (sc, go) = at(o);
                    let pu = j[12] as f64 * z[0] + j[13] as f64 * z[1] + j[14] as f64 * z[2];
                    let pv = j[15] as f64 * z[0] + j[16] as f64 * z[1] + j[17] as f64 * z[2];
                    // SAFETY: chunk c alone writes its share.
                    if sc != FIXED { for a in 0..6 { unsafe { *p.at(6 * sc + a) += j[a] as f64 * pu + j[6 + a] as f64 * pv; } } }
                    for a in 0..jk { unsafe { *p.at(go + a) += j[18 + a] as f64 * pu + j[18 + jk + a] as f64 * pv; } }
                }
                continue;
            }
            m.eblocks(pi, st, dh, &mut el);
            let mut t = [0f64; 3];
            for eb in &el.blocks { let rows = el.rows_of(eb); for a in 0..eb.dim { for k in 0..3 { t[k] += rows[a][k] * x[eb.off + a]; } } }
            let z = mat3_vec(&cinv, &t);
            // SAFETY: chunk c alone writes its share.
            for eb in &el.blocks { let rows = el.rows_of(eb); for a in 0..eb.dim {
                unsafe { *p.at(eb.off + a) += rows[a][0]*z[0] + rows[a][1]*z[1] + rows[a][2]*z[2]; }
            } }
        }
    });
    plan.pattern.matvec(b, x, y);
    for v in shares.iter() { for i in 0..n { y[i] -= v[i]; } }
}
