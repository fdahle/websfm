// The bundle adjustment's inputs, parsed once from the flat arrays the caller passes
// (bundle_adjust's doc lists them): pose blocks (a rig's captures), lens, rolling shutter,
// anchors, camera priors and the observations. The solve reads them and never changes them.

#[allow(unused_imports)]
use crate::linalg::*;
#[allow(unused_imports)]
use super::*;

pub(crate) struct Problem {
    pub n_cam: usize,
    pub n_pts: usize,
    // Rig (bundle_adjust_rig): each camera's lens offset and pose block. Without one, block
    // c is camera c and no offset is composed: the plain solve, bit for bit.
    pub off: Vec<Option<(M3, V3)>>,
    pub pb: Vec<usize>,
    pub n_pb: usize,
    // Anchors: (point, target position, 3×3 precision).
    pub anchors: Vec<(usize, V3, M3)>,
    pub anchored: Vec<bool>,
    // Camera-pose priors: pose block, target centre, position precision, and an optional
    // (target rotation, orientation precision) pair.
    pub camera_priors: Vec<(usize, V3, M3, Option<(M3, M3)>)>,
    // Base (seed) intrinsics, held fixed; refinement is relative to these.
    pub ks: Vec<(f64, f64, f64, f64)>,
    // Floats a camera in `fisheye_flat`: 5, or 7 with the decentring pair.
    pub lens_stride: usize,
    // Per camera: (refinable fisheye terms, seed coefficients, Brown p1/p2).
    pub lens: Vec<(usize, [f64; 4], [f64; 2])>,
    // Rolling shutter per camera: (velocity, frame height, seed readout time), or None.
    pub rs: Vec<Option<(V3, f64, f64)>>,
    pub rs_any: bool,
    // (camera, point, u, v, weight u, weight v), kept as the caller gave them (u32, f32):
    // 24 bytes an observation instead of 40 (48 natively) in f64 and usize. `ob` reads one
    // back widened.
    pub obs: Vec<(u32, u32, f32, f32, f32, f32)>,
    // Per-point observations as indices into `obs`, in `obs` order (CSR): the structure the
    // Schur reduction iterates.
    pub pt_start: Vec<u32>,
    pub pt_obs: Vec<u32>,
    // Some point is seen twice from one pose block (two lenses of a rig capture, or a
    // repeated observation): only then do a point's camera coupling blocks merge.
    pub pb_dup: bool,
}

/// A camera's centre C = −Rᵀ·t.
pub(crate) fn camera_center(cam: &(M3, V3)) -> V3 {
    let (r, t) = cam;
    [-(r[0][0]*t[0] + r[1][0]*t[1] + r[2][0]*t[2]),
     -(r[0][1]*t[0] + r[1][1]*t[1] + r[2][1]*t[2]),
     -(r[0][2]*t[0] + r[1][2]*t[1] + r[2][2]*t[2])]
}

/// The orientation prior's residual Log(R·R_targetᵀ).
pub(crate) fn orientation_residual(r: &M3, target_r: &M3) -> V3 {
    so3_log(&mat3_mul(r, &mat3_transpose(target_r)))
}

impl Problem {
    /// The inputs, and the starting state's poses (one per pose block) and points. None
    /// when there is nothing to solve.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn parse(
        cameras_flat: &[f32], intrinsics_flat: &[f32], pts_flat: &[f32], obs_index: &[u32], obs_px: &[f32],
        observation_weight: &[f32], anchor_flat: &[f64], anchor_weight: &[f32], camera_prior_flat: &[f32],
        fisheye_flat: &[f32], rs_flat: &[f32], capture_of_cam: &[i32], offset_flat: &[f32],
    ) -> Option<(Problem, Vec<(M3, V3)>, Vec<V3>)> {
        let n_cam = cameras_flat.len() / 12;
        let n_pts = pts_flat.len() / 3;
        let n_obs = (obs_index.len() / 2).min(obs_px.len() / 2);
        if n_cam == 0 || n_pts == 0 || n_obs == 0 { return None; }

        let off: Vec<Option<(M3, V3)>> = (0..n_cam).map(|c| {
            let b = c * 13;
            if offset_flat.len() < b + 13 || !(offset_flat[b] > 0.5) { return None; }
            let v = |i: usize| offset_flat[b + i] as f64;
            let r: M3 = [[v(1), v(2), v(3)], [v(4), v(5), v(6)], [v(7), v(8), v(9)]];
            let t: V3 = [v(10), v(11), v(12)];
            if r.iter().flatten().chain(t.iter()).any(|x| !x.is_finite()) { return None; }
            Some((r, t))
        }).collect();
        let (pb, n_pb) = {
            let mut map: std::collections::HashMap<i32, usize> = std::collections::HashMap::new();
            let mut pb = vec![0usize; n_cam];
            let mut next = 0usize;
            for c in 0..n_cam {
                let id = capture_of_cam.get(c).copied().unwrap_or(-1);
                pb[c] = if id < 0 { next += 1; next - 1 } else { *map.entry(id).or_insert_with(|| { next += 1; next - 1 }) };
            }
            (pb, next)
        };

        // Points outside range are dropped rather than panicking on a malformed payload.
        let n_anchor = anchor_flat.len() / 4;
        let anchors: Vec<(usize, V3, M3)> = (0..n_anchor).filter_map(|i| {
            let b = i * 4;
            let pi = anchor_flat[b] as usize;
            let target: V3 = [anchor_flat[b+1], anchor_flat[b+2], anchor_flat[b+3]];
            let wb = i * 9;
            let precision: M3 = [0,1,2].map(|r| [0,1,2].map(|c| {
                anchor_weight.get(wb + 3*r + c).copied().unwrap_or(if r == c { 1.0 } else { 0.0 }) as f64
            }));
            if pi >= n_pts || precision.iter().flatten().any(|v| !v.is_finite()) { return None; }
            Some((pi, target, precision))
        }).collect();
        let mut anchored = vec![false; n_pts];
        for &(pi, _, _) in &anchors { anchored[pi] = true; }

        let n_camera_prior = camera_prior_flat.len() / 31;
        let camera_priors: Vec<(usize, V3, M3, Option<(M3, M3)>)> = (0..n_camera_prior).filter_map(|i| {
            let b = i * 31;
            let ci = camera_prior_flat[b] as usize;
            let target = [camera_prior_flat[b+1] as f64, camera_prior_flat[b+2] as f64,
                          camera_prior_flat[b+3] as f64];
            let mut weight: M3 = [0,1,2].map(|row| [0,1,2].map(|col|
                camera_prior_flat[b + 4 + 3*row + col] as f64));
            for row in 0..3 { for col in (row+1)..3 {
                let v = 0.5 * (weight[row][col] + weight[col][row]);
                weight[row][col] = v; weight[col][row] = v;
            }}
            let wdet2 = weight[0][0]*weight[1][1] - weight[0][1]*weight[1][0];
            if ci >= n_cam || target.iter().any(|v| !v.is_finite())
                || weight.iter().flatten().any(|v| !v.is_finite())
                || !(weight[0][0] > 0.0 && wdet2 > 0.0 && det3(&weight) > 0.0) { return None; }
            let target_r: M3 = [0,1,2].map(|row| [0,1,2].map(|col|
                camera_prior_flat[b + 13 + 3*row + col] as f64));
            let mut precision: M3 = [0,1,2].map(|row| [0,1,2].map(|col|
                camera_prior_flat[b + 22 + 3*row + col] as f64));
            for row in 0..3 { for col in (row+1)..3 {
                let v = 0.5 * (precision[row][col] + precision[col][row]);
                precision[row][col] = v; precision[col][row] = v;
            }}
            let det2 = precision[0][0]*precision[1][1] - precision[0][1]*precision[1][0];
            let orientation = if target_r.iter().flatten().all(|v| v.is_finite())
                && precision.iter().flatten().all(|v| v.is_finite())
                && precision[0][0] > 0.0 && det2 > 0.0 && det3(&precision) > 0.0 {
                Some((target_r, precision))
            } else { None };
            // On the camera's pose block: a capture's prior moves the capture.
            Some((pb[ci], target, weight, orientation))
        }).collect();

        let cams_in: Vec<(M3, V3)> = (0..n_cam).map(|c| {
            let b = c * 12;
            let r: M3 = [[cameras_flat[b]   as f64, cameras_flat[b+1] as f64, cameras_flat[b+2]  as f64],
                         [cameras_flat[b+3] as f64, cameras_flat[b+4] as f64, cameras_flat[b+5]  as f64],
                         [cameras_flat[b+6] as f64, cameras_flat[b+7] as f64, cameras_flat[b+8]  as f64]];
            let t: V3 = [cameras_flat[b+9] as f64, cameras_flat[b+10] as f64, cameras_flat[b+11] as f64];
            (r, t)
        }).collect();
        // One pose per block: a capture starts from a camera without an offset where it has
        // one, else from its first camera with the offset taken off (R_c = R_oᵀ·R,
        // t_c = R_oᵀ·(t − t_o)).
        let mut cams: Vec<(M3, V3)> = vec![([[0.0; 3]; 3], [0.0; 3]); n_pb];
        { let mut seeded = vec![0u8; n_pb];
          for c in 0..n_cam {
              let rank = if off[c].is_none() { 2 } else { 1 };
              if seeded[pb[c]] >= rank { continue; }
              seeded[pb[c]] = rank;
              let (r, t) = cams_in[c];
              cams[pb[c]] = match off[c] {
                  None => (r, t),
                  Some((ro, to)) => {
                      let rot = mat3_transpose(&ro);
                      (mat3_mul(&rot, &r), mat3_vec(&rot, &[t[0] - to[0], t[1] - to[1], t[2] - to[2]]))
                  }
              };
          } }
        let ks: Vec<(f64, f64, f64, f64)> = (0..n_cam).map(|c| {
            let b = c * 4;
            (intrinsics_flat[b] as f64, intrinsics_flat[b+1] as f64,
             intrinsics_flat[b+2] as f64, intrinsics_flat[b+3] as f64)
        }).collect();
        // terms 0 ⇒ Brown (pinhole when every coefficient is 0). A 7-float list also
        // returns p1/p2.
        let lens_stride = if n_cam > 0 && fisheye_flat.len() >= n_cam * 7 { 7 } else { 5 };
        let lens: Vec<(usize, [f64; 4], [f64; 2])> = (0..n_cam).map(|c| {
            let b = c * lens_stride;
            let val = |j: usize| -> f64 {
                let v = fisheye_flat.get(b + j).copied().unwrap_or(0.0) as f64;
                if v.is_finite() { v } else { 0.0 }
            };
            let terms = fisheye_flat.get(b).copied().unwrap_or(0.0);
            let k = [1, 2, 3, 4].map(val);
            let p = if lens_stride == 7 { [val(5), val(6)] } else { [0.0; 2] };
            // A Brown camera's slots seed its k1…k3 and p1/p2.
            if !(terms >= 1.0) { return (0, [k[0], k[1], k[2], 0.0], p); }
            ((terms as usize).min(4), k, [0.0; 2])
        }).collect();
        let rs: Vec<Option<(V3, f64, f64)>> = (0..n_cam).map(|c| {
            let b = c * 5;
            let h = rs_flat.get(b + 3).copied().unwrap_or(0.0) as f64;
            if !(h > 0.0) { return None; }
            let v = [0, 1, 2].map(|j| rs_flat.get(b + j).copied().unwrap_or(0.0) as f64);
            let tau0 = rs_flat.get(b + 4).copied().unwrap_or(0.0) as f64;
            if v.iter().any(|x| !x.is_finite()) || !tau0.is_finite() { return None; }
            Some((v, h, tau0))
        }).collect();
        let rs_any = rs.iter().any(|r| r.is_some());
        let pts: Vec<V3> = (0..n_pts).map(|i| {
            [pts_flat[i*3] as f64, pts_flat[i*3+1] as f64, pts_flat[i*3+2] as f64]
        }).collect();
        let obs: Vec<(u32, u32, f32, f32, f32, f32)> = (0..n_obs).map(|i| {
            let b = i * 2;
            let wx = observation_weight.get(b).copied().unwrap_or(1.0);
            let wy = observation_weight.get(b + 1).copied().unwrap_or(1.0);
            (obs_index[b], obs_index[b + 1], obs_px[b], obs_px[b + 1],
             if wx.is_finite() && wx > 0.0 { wx } else { 1.0 }, if wy.is_finite() && wy > 0.0 { wy } else { 1.0 })
        }).filter(|&(ci, pi, _, _, _, _)| (ci as usize) < n_cam && (pi as usize) < n_pts).collect();
        let (pt_start, pt_obs) = csr(n_pts, obs.iter().map(|o| o.1 as usize));
        let pb_dup = {
            let mut last = vec![u32::MAX; n_pb];
            let mut dup = false;
            for pi in 0..n_pts {
                for &o in &pt_obs[pt_start[pi] as usize..pt_start[pi + 1] as usize] {
                    let b = pb[obs[o as usize].0 as usize];
                    dup |= last[b] == pi as u32;
                    last[b] = pi as u32;
                }
            }
            dup
        };

        let problem = Problem {
            n_cam, n_pts, off, pb, n_pb, anchors, anchored, camera_priors, ks, lens_stride, lens, rs, rs_any, obs,
            pt_start, pt_obs, pb_dup,
        };
        Some((problem, cams, pts))
    }

    /// Observation o, widened: (camera, point, u, v, weight u, weight v).
    #[inline]
    pub(crate) fn ob(&self, o: usize) -> (usize, usize, f64, f64, f64, f64) {
        let (ci, pi, u, v, wx, wy) = self.obs[o];
        (ci as usize, pi as usize, u as f64, v as f64, wx as f64, wy as f64)
    }

    /// The anchors' weighted squared residual Σ dᵀ·W·d.
    pub(crate) fn anchor_sse(&self, pts: &[V3]) -> f64 {
        let mut sum = 0.0f64;
        for &(pi, target, precision) in &self.anchors {
            let d = [pts[pi][0]-target[0], pts[pi][1]-target[1], pts[pi][2]-target[2]];
            let pd = mat3_vec(&precision, &d);
            sum += d[0]*pd[0] + d[1]*pd[1] + d[2]*pd[2];
        }
        sum
    }

    /// The anchors' RMS distance from their targets, in the caller's units.
    pub(crate) fn anchor_rms(&self, pts: &[V3]) -> f64 {
        if self.anchors.is_empty() { return 0.0; }
        let mut sse = 0.0f64;
        for &(pi, target, _) in &self.anchors {
            let dx = pts[pi][0] - target[0]; let dy = pts[pi][1] - target[1]; let dz = pts[pi][2] - target[2];
            sse += dx*dx + dy*dy + dz*dz;
        }
        (sse / self.anchors.len() as f64).sqrt()
    }

    /// The camera priors' weighted squared residual (position and orientation).
    pub(crate) fn camera_prior_sse(&self, cams: &[(M3, V3)]) -> f64 {
        self.camera_priors.iter().map(|&(ci, target, weight, orientation)| {
            let c = camera_center(&cams[ci]);
            let d = [c[0] - target[0], c[1] - target[1], c[2] - target[2]];
            let position = dot3(&d, &mat3_vec(&weight, &d));
            let rotation = orientation.map(|(target_r, precision)| {
                let e = orientation_residual(&cams[ci].0, &target_r);
                let pe = mat3_vec(&precision, &e);
                dot3(&e, &pe)
            }).unwrap_or(0.0);
            position + rotation
        }).sum()
    }

    /// The camera priors' RMS centre distance from their targets.
    pub(crate) fn camera_prior_rms(&self, cams: &[(M3, V3)]) -> f64 {
        if self.camera_priors.is_empty() { return 0.0; }
        let sse: f64 = self.camera_priors.iter().map(|&(ci, target, _, _)| {
            let c = camera_center(&cams[ci]);
            (0..3).map(|k| (c[k] - target[k]).powi(2)).sum::<f64>()
        }).sum();
        (sse / self.camera_priors.len() as f64).sqrt()
    }
}
