// Projection-guided track extension's search (src/core/sfm/guidedExtension.js): for each
// registered camera, project every point it may see, take the unused keypoints within
// the gate and keep the best by descriptor distance when it passes the threshold and the
// ratio test. Cameras are independent, so they run on the thread pool, each into its own
// list; JS concatenates them in camera order and resolves the proposals.
//
// The arithmetic is the JS search's, operation for operation (the projection, the floors
// that place a keypoint in its cell, the early-exit distance), so the proposals are the
// same as the JS path's whatever the thread count. Keep the two in step.

use wasm_bindgen::prelude::*;

use crate::par::{for_each_index, SyncPtr};

const DIM: usize = 128;
// guidedExtension.js GRID_MAX_CELLS.
const GRID_MAX_CELLS: f64 = (1u32 << 22) as f64;
// No distance yet (JS Infinity): above any sum of 128 squared byte differences.
const NONE: u32 = u32::MAX;

/// guidedExtension.js `dist2Below`: the squared distance, but it stops once the sum
/// passes `bound` and returns that partial sum (still above the bound).
#[inline(always)]
fn dist2_below(a: &[u8], b: &[u8], bound: u32) -> u32 {
    let mut s = 0u32;
    for i in (0..DIM).step_by(16) {
        for j in i..i + 16 {
            let d = a[j] as i32 - b[j] as i32;
            s += (d * d) as u32;
        }
        if s > bound { return s; }
    }
    s
}

#[inline(always)]
fn floor_div(a: f64, g: f64) -> i64 { (a / g).floor() as i64 }

/// The points every camera may observe, held for the searches of one extension run.
#[wasm_bindgen]
pub struct GuidedSearch {
    pos: Vec<f64>,
    ref_start: Vec<u32>,
    refs: Vec<u8>,
    view_start: Vec<u32>,
    view_img: Vec<u32>,
    cell_start: Vec<u32>,
    cell_pts: Vec<u32>,
    gate: f64,
    tau2: f64,
    ratio2: f64,
}

#[wasm_bindgen]
impl GuidedSearch {
    /// `pos`: x, y, z per point; `ref_start`/`refs`: each point's reference descriptors
    /// (128 bytes each; n_points + 1 offsets, in descriptors); `view_start`/`view_img`:
    /// the images that already observe each point; `cell_start`/`cell_pts`: the points
    /// of each cull cell, ascending. `tau2`: the squared distance threshold; `ratio2`:
    /// the squared ratio the best must beat the runner-up by.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        pos: &[f64], ref_start: &[u32], refs: &[u8], view_start: &[u32], view_img: &[u32],
        cell_start: &[u32], cell_pts: &[u32], gate_px: f64, tau2: f64, ratio2: f64,
    ) -> GuidedSearch {
        GuidedSearch {
            pos: pos.to_vec(), ref_start: ref_start.to_vec(), refs: refs.to_vec(),
            view_start: view_start.to_vec(), view_img: view_img.to_vec(),
            cell_start: cell_start.to_vec(), cell_pts: cell_pts.to_vec(),
            gate: gate_px, tau2, ratio2,
        }
    }

    /// Search a group of cameras. Per camera c: `imgs[c]`, its image index; `p[16c..]`,
    /// R (row-major), t, fx, fy, cx, cy; `kp_start`, its keypoints in `xy` (n_cams + 1
    /// offsets, in keypoints); `desc_start`, its descriptors in `desc` (in bytes; a
    /// keypoint past the camera's share has none); `used`, 1 per keypoint already in a
    /// track; `cc_start`/`cc`, the cull cells it may see. Returns [windows, then
    /// (point, camera, keypoint, squared distance) per proposal], cameras in order.
    #[allow(clippy::too_many_arguments)]
    pub fn search(
        &self, imgs: &[u32], p: &[f64], kp_start: &[u32], xy: &[f64], desc_start: &[u32],
        desc: &[u8], used: &[u8], cc_start: &[u32], cc: &[u32],
    ) -> Vec<f64> {
        let n = imgs.len();
        let mut per: Vec<(f64, Vec<f64>)> = vec![(0.0, Vec::new()); n];
        let out = SyncPtr::of(&mut per);
        for_each_index(n, |c| {
            let k0 = kp_start[c] as usize;
            let k1 = kp_start[c + 1] as usize;
            let d0 = desc_start[c] as usize;
            let d1 = desc_start[c + 1] as usize;
            let r = self.camera(
                imgs[c], &p[16 * c..16 * c + 16], &xy[2 * k0..2 * k1], &desc[d0..d1], &used[k0..k1],
                &cc[cc_start[c] as usize..cc_start[c + 1] as usize], c as f64,
            );
            // SAFETY: camera c alone writes element c.
            unsafe { *out.at(c) = r; }
        });
        let total: usize = per.iter().map(|(_, v)| v.len()).sum();
        let mut res = Vec::with_capacity(1 + total);
        res.push(per.iter().map(|(w, _)| *w).sum());
        for (_, v) in &per { res.extend_from_slice(v); }
        res
    }
}

impl GuidedSearch {
    #[allow(clippy::too_many_arguments)]
    fn camera(&self, img: u32, pm: &[f64], xy: &[f64], desc: &[u8], used: &[u8], cells: &[u32], cam: f64) -> (f64, Vec<f64>) {
        let gate = self.gate;
        let r2 = gate * gate;
        let n = used.len();
        let mut out = Vec::new();
        let mut windows = 0.0;
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for i in 0..n {
            let (x, y) = (xy[2 * i], xy[2 * i + 1]);
            if x < min_x { min_x = x; }
            if y < min_y { min_y = y; }
            if x > max_x { max_x = x; }
            if y > max_y { max_y = y; }
        }
        if n == 0 || cells.is_empty() || !(max_x >= min_x && max_y >= min_y) { return (0.0, out); }
        let gx0 = floor_div(min_x, gate);
        let gy0 = floor_div(min_y, gate);
        let ngx = floor_div(max_x, gate) - gx0 + 1;
        let ngy = floor_div(max_y, gate) - gy0 + 1;
        let f = (((ngx as f64) * (ngy as f64) / GRID_MAX_CELLS).sqrt().ceil() as i64).max(1);
        let nx = (ngx - 1).div_euclid(f) + 1;
        let ny = (ngy - 1).div_euclid(f) + 1;
        let ncell = (nx * ny) as usize;
        // Counting sort by cell: keypoints stay in index order within a cell.
        let cell_of = |i: usize| -> i64 {
            let (x, y) = (xy[2 * i], xy[2 * i + 1]);
            if x.is_nan() || y.is_nan() { return -1; }
            (floor_div(x, gate) - gx0).div_euclid(f) * ny + (floor_div(y, gate) - gy0).div_euclid(f)
        };
        let mut start = vec![0u32; ncell + 1];
        for i in 0..n {
            let c = cell_of(i);
            if c >= 0 { start[c as usize + 1] += 1; }
        }
        for c in 0..ncell { start[c + 1] += start[c]; }
        let mut fill = start[..ncell].to_vec();
        let mut cell_kp = vec![0u32; start[ncell] as usize];
        for i in 0..n {
            let c = cell_of(i);
            if c >= 0 {
                cell_kp[fill[c as usize] as usize] = i as u32;
                fill[c as usize] += 1;
            }
        }
        let has_desc = |i: usize| (i + 1) * DIM <= desc.len();
        let mut cand: Vec<u32> = Vec::new();
        for &cell in cells {
            let cell = cell as usize;
            for &j in &self.cell_pts[self.cell_start[cell] as usize..self.cell_start[cell + 1] as usize] {
                let j = j as usize;
                let (px, py, pz) = (self.pos[3 * j], self.pos[3 * j + 1], self.pos[3 * j + 2]);
                let zc = pm[6] * px + pm[7] * py + pm[8] * pz + pm[11];
                if !(zc > 1e-9) { continue; }
                let u = pm[12] * ((pm[0] * px + pm[1] * py + pm[2] * pz + pm[9]) / zc) + pm[14];
                let v = pm[13] * ((pm[3] * px + pm[4] * py + pm[5] * pz + pm[10]) / zc) + pm[15];
                if u < min_x || u > max_x || v < min_y || v > max_y { continue; }
                if self.view_img[self.view_start[j] as usize..self.view_start[j + 1] as usize].contains(&img) { continue; }
                let cx = floor_div(u, gate);
                let cy = floor_div(v, gate);
                cand.clear();
                let x0 = (cx - 1 - gx0).div_euclid(f).max(0);
                let x1 = (cx + 1 - gx0).div_euclid(f).min(nx - 1);
                let y0 = (cy - 1 - gy0).div_euclid(f).max(0);
                let y1 = (cy + 1 - gy0).div_euclid(f).min(ny - 1);
                for bx in x0..=x1 {
                    for by in y0..=y1 {
                        let b = (bx * ny + by) as usize;
                        for &i in &cell_kp[start[b] as usize..start[b + 1] as usize] {
                            let (kx, ky) = (xy[2 * i as usize], xy[2 * i as usize + 1]);
                            let gx = floor_div(kx, gate);
                            let gy = floor_div(ky, gate);
                            if gx < cx - 1 || gx > cx + 1 || gy < cy - 1 || gy > cy + 1 { continue; }
                            if (kx - u) * (kx - u) + (ky - v) * (ky - v) > r2 { continue; }
                            cand.push(i);
                        }
                    }
                }
                if cand.is_empty() { continue; }
                // A coarse cell holds several gate cells: put the candidates in gate-cell order.
                if f > 1 && cand.len() > 1 {
                    cand.sort_by_key(|&i| (floor_div(xy[2 * i as usize], gate), floor_div(xy[2 * i as usize + 1], gate), i));
                }
                let refs = &self.refs[DIM * self.ref_start[j] as usize..DIM * self.ref_start[j + 1] as usize];
                let (mut best, mut second, mut best_kp, mut any) = (NONE, NONE, 0u32, false);
                for &i in &cand {
                    let iu = i as usize;
                    if used[iu] != 0 || !has_desc(iu) { continue; }
                    any = true;
                    let cd = &desc[DIM * iu..DIM * iu + DIM];
                    let mut d = NONE;
                    for rf in refs.chunks_exact(DIM) { d = d.min(dist2_below(rf, cd, d.min(second))); }
                    if d < best {
                        second = best;
                        best = d;
                        best_kp = i;
                    } else if d < second {
                        second = d;
                    }
                }
                if !any { continue; }
                windows += 1.0;
                if (best as f64) <= self.tau2 && (second == NONE || (best as f64) <= self.ratio2 * second as f64) {
                    out.extend_from_slice(&[j as f64, cam, best_kp as f64, best as f64]);
                }
            }
        }
        (windows, out)
    }
}
