// Screened Poisson surface reconstruction → WASM. Wraps the vendored (rayon-free)
// `poisson_reconstruction` crate behind one flat-buffer wasm-bindgen entry point,
// matching the byte-buffer style of the other crates. Input is the dense cloud's
// oriented per-point normals (the reused PatchMatch plane normals); output is one
// indexed triangle mesh, trimmed of Poisson's hallucinated far-from-data bulges.
//
// NOTE on parameters: the classic PoissonRecon `--samplesPerNode` knob is not
// exposed by this library; its closest quality lever is the *screening* weight
// (point-fitting strength). The middle wasm parameter is therefore `screening`, not
// samples-per-node — a naming deviation from the plan's fixed signature, flagged
// here and in the handover.

use nalgebra::{Point3, Vector3};
use poisson_reconstruction::{PoissonBuilder, PoissonReconstruction};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

// Density estimation runs this many octree levels coarser than max depth — a couple
// of levels back keeps the kernel robust to sampling holes without losing detail.
const DENSITY_DEPTH_BACKOFF: usize = 2;
// Conjugate-gradient relaxation iterations per multigrid level; ~10 suffices.
const RELAXATION_ITERS: usize = 10;

/// Screened Poisson mesh from oriented points. `pos`/`nrm` are flat `3·N` f32
/// (world-space; `nrm` unit). `max_depth` is the octree depth (detail vs cost),
/// `screening` the point-fitting weight (0 disables), `trim_dist` the world-unit
/// radius past which a triangle entirely far from the input cloud is culled (≤0
/// disables trimming). Returns ONE byte buffer, little-endian:
///   header  [u32 nVerts, u32 nTris]
///   f32     positions  (3·nVerts)
///   u32     indices    (3·nTris)
/// An empty / degenerate result returns a header of zeros.
#[wasm_bindgen]
pub fn poisson_mesh(
    pos: &[f32],
    nrm: &[f32],
    max_depth: u32,
    screening: f32,
    trim_dist: f32,
) -> Vec<u8> {
    let n = pos.len() / 3;
    if n == 0 || nrm.len() < n * 3 || max_depth == 0 {
        return empty_mesh();
    }

    let points: Vec<Point3<f64>> = (0..n)
        .map(|i| Point3::new(pos[i * 3] as f64, pos[i * 3 + 1] as f64, pos[i * 3 + 2] as f64))
        .collect();
    let normals: Vec<Vector3<f64>> = (0..n)
        .map(|i| Vector3::new(nrm[i * 3] as f64, nrm[i * 3 + 1] as f64, nrm[i * 3 + 2] as f64))
        .collect();

    let max_depth = max_depth as usize;
    let density_depth = max_depth.saturating_sub(DENSITY_DEPTH_BACKOFF).max(1).min(max_depth);

    let poisson = PoissonReconstruction::from_points_and_normals(
        &points,
        &normals,
        screening as f64,
        density_depth,
        max_depth,
        RELAXATION_ITERS,
    );
    finalize_mesh(&poisson, &points, trim_dist)
}

/// Extract, trim, and encode a mesh from a solved reconstruction. Shared by the
/// one-shot [`poisson_mesh`] and the staged [`PoissonMesher::finish`].
fn finalize_mesh(poisson: &PoissonReconstruction, points: &[Point3<f64>], trim_dist: f32) -> Vec<u8> {
    // Extract at the sample-average iso, not 0: screened Poisson's true surface is the
    // average of the implicit function at the input points, so extracting at 0 inflates
    // the surface (an ~8% radius bias on a test sphere). Kazhdan's PoissonRecon does the
    // same. Guard against a degenerate (empty) average.
    let iso = if points.is_empty() {
        0.0
    } else {
        points.iter().map(|p| poisson.eval(p)).sum::<f64>() / points.len() as f64
    };
    let buffers = poisson.reconstruct_mesh_buffers_iso(iso);
    let verts: Vec<[f64; 3]> = buffers.vertices().iter().map(|p| [p.x, p.y, p.z]).collect();
    let tris: Vec<u32> = buffers.indices().to_vec();
    if verts.is_empty() || tris.len() < 3 {
        return empty_mesh();
    }

    // Trim Poisson's extrapolated bulges: drop any triangle all of whose vertices lie
    // farther than `trim_dist` from every input point, then compact the vertex list.
    let (verts, tris) = if trim_dist > 0.0 {
        trim_far_triangles(&verts, &tris, points, trim_dist as f64)
    } else {
        (verts, tris)
    };
    if verts.is_empty() || tris.len() < 3 {
        return empty_mesh();
    }

    encode_mesh(&verts, &tris)
}

/// Staged, JS-driven wrapper around the screened-Poisson solve. Exposes the phases the
/// worker steps through so it can paint per-layer progress (the whole solve is a single
/// blocking wasm call otherwise — the "stuck at Poisson solve" symptom) and keep the
/// largest uninterruptible unit of work down to one multigrid layer:
///
/// ```text
///   let m = PoissonMesher.build(pos, nrm, depth, screening)   // build octree + field
///   for _ in 0..m.num_layers() { m.solve_step() }             // solve, report progress
///   let bytes = m.finish(trim_dist)                            // extract + trim + encode
///   m.free()
/// ```
///
/// The one-shot [`poisson_mesh`] free function is kept for the Rust tests (which run
/// natively and cannot construct a JS driver).
#[wasm_bindgen]
pub struct PoissonMesher {
    builder: Option<PoissonBuilder>,
}

#[wasm_bindgen]
impl PoissonMesher {
    /// Build the multigrid octree + vector field (no layer solved yet). `pos`/`nrm` are
    /// flat `3·N` f32 (world-space; `nrm` unit); `max_depth`/`screening` as in
    /// [`poisson_mesh`]. An empty / degenerate input yields a mesher with zero layers
    /// whose `finish` returns an empty mesh.
    pub fn build(pos: &[f32], nrm: &[f32], max_depth: u32, screening: f32) -> PoissonMesher {
        let n = pos.len() / 3;
        if n == 0 || nrm.len() < n * 3 || max_depth == 0 {
            return PoissonMesher { builder: None };
        }
        let points: Vec<Point3<f64>> = (0..n)
            .map(|i| Point3::new(pos[i * 3] as f64, pos[i * 3 + 1] as f64, pos[i * 3 + 2] as f64))
            .collect();
        let normals: Vec<Vector3<f64>> = (0..n)
            .map(|i| Vector3::new(nrm[i * 3] as f64, nrm[i * 3 + 1] as f64, nrm[i * 3 + 2] as f64))
            .collect();
        let max_depth = max_depth as usize;
        let density_depth = max_depth.saturating_sub(DENSITY_DEPTH_BACKOFF).max(1).min(max_depth);
        let builder = PoissonBuilder::new(
            &points,
            &normals,
            screening as f64,
            density_depth,
            max_depth,
            RELAXATION_ITERS,
        );
        PoissonMesher { builder: Some(builder) }
    }

    /// Number of multigrid layers to solve (`== max_depth + 1`, or 0 for a degenerate
    /// build). Drives the caller's progress denominator.
    pub fn num_layers(&self) -> usize {
        self.builder.as_ref().map_or(0, |b| b.num_layers())
    }

    /// Solve the next multigrid layer (coarsest first). Returns `true` while more layers
    /// remain. A no-op (`false`) once every layer is solved or on a degenerate build.
    pub fn solve_step(&mut self) -> bool {
        self.builder.as_mut().map_or(false, |b| b.solve_step())
    }

    /// Solve any remaining layers, then extract, trim (world-unit `trim_dist`; ≤0
    /// disables), and encode the mesh to the little-endian wire buffer described on
    /// [`poisson_mesh`]. Consumes the internal builder — call once.
    pub fn finish(&mut self, trim_dist: f32) -> Vec<u8> {
        let Some(builder) = self.builder.take() else {
            return empty_mesh();
        };
        let (poisson, points) = builder.finish();
        finalize_mesh(&poisson, &points, trim_dist)
    }
}

fn empty_mesh() -> Vec<u8> {
    vec![0u8; 8] // two u32 zeros
}

// Little-endian [nVerts u32][nTris u32][pos f32 ×3nVerts][idx u32 ×3nTris].
fn encode_mesh(verts: &[[f64; 3]], tris: &[u32]) -> Vec<u8> {
    let n_verts = verts.len() as u32;
    let n_tris = (tris.len() / 3) as u32;
    let mut out = Vec::with_capacity(8 + verts.len() * 12 + tris.len() * 4);
    out.extend_from_slice(&n_verts.to_le_bytes());
    out.extend_from_slice(&n_tris.to_le_bytes());
    for v in verts {
        out.extend_from_slice(&(v[0] as f32).to_le_bytes());
        out.extend_from_slice(&(v[1] as f32).to_le_bytes());
        out.extend_from_slice(&(v[2] as f32).to_le_bytes());
    }
    for &i in tris {
        out.extend_from_slice(&i.to_le_bytes());
    }
    out
}

// Voxel-hash proximity grid over the input points (cell = trim_dist), then keep a
// triangle if ANY of its vertices is within trim_dist of ANY input point. Same
// packed-cell idea as the JS fusion accumulator. Returns the compacted (verts,idx).
fn trim_far_triangles(
    verts: &[[f64; 3]],
    tris: &[u32],
    points: &[Point3<f64>],
    trim_dist: f64,
) -> (Vec<[f64; 3]>, Vec<u32>) {
    let inv = 1.0 / trim_dist;
    let cell = |x: f64, y: f64, z: f64| -> (i64, i64, i64) {
        ((x * inv).floor() as i64, (y * inv).floor() as i64, (z * inv).floor() as i64)
    };
    let mut grid: HashMap<(i64, i64, i64), Vec<usize>> = HashMap::new();
    for (i, p) in points.iter().enumerate() {
        grid.entry(cell(p.x, p.y, p.z)).or_default().push(i);
    }
    let d2 = trim_dist * trim_dist;
    // Is vertex v within trim_dist of any input point? Scan its cell + 26 neighbours.
    let near = |v: &[f64; 3]| -> bool {
        let (cx, cy, cz) = cell(v[0], v[1], v[2]);
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(ids) = grid.get(&(cx + dx, cy + dy, cz + dz)) {
                        for &i in ids {
                            let p = &points[i];
                            let (ex, ey, ez) = (p.x - v[0], p.y - v[1], p.z - v[2]);
                            if ex * ex + ey * ey + ez * ez <= d2 {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        false
    };

    // Per-vertex nearness, cached (each vertex is shared by several triangles).
    let vert_near: Vec<bool> = verts.iter().map(near).collect();

    let mut remap = vec![u32::MAX; verts.len()];
    let mut out_verts: Vec<[f64; 3]> = Vec::new();
    let mut out_tris: Vec<u32> = Vec::with_capacity(tris.len());
    for t in tris.chunks_exact(3) {
        let (a, b, c) = (t[0] as usize, t[1] as usize, t[2] as usize);
        // Drop only if ALL three vertices are far from the data.
        if !vert_near[a] && !vert_near[b] && !vert_near[c] {
            continue;
        }
        for &vi in &[a, b, c] {
            if remap[vi] == u32::MAX {
                remap[vi] = out_verts.len() as u32;
                out_verts.push(verts[vi]);
            }
            out_tris.push(remap[vi]);
        }
    }
    (out_verts, out_tris)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Decode the byte buffer back into (nVerts, nTris, positions, indices).
    fn decode(bytes: &[u8]) -> (u32, u32, Vec<[f32; 3]>, Vec<u32>) {
        let n_verts = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        let n_tris = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        let mut off = 8;
        let mut pos = Vec::new();
        for _ in 0..n_verts {
            let x = f32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
            let y = f32::from_le_bytes(bytes[off + 4..off + 8].try_into().unwrap());
            let z = f32::from_le_bytes(bytes[off + 8..off + 12].try_into().unwrap());
            pos.push([x, y, z]);
            off += 12;
        }
        let mut idx = Vec::new();
        for _ in 0..n_tris * 3 {
            idx.push(u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()));
            off += 4;
        }
        (n_verts, n_tris, pos, idx)
    }

    // A densely-sampled unit sphere with outward normals should reconstruct to a
    // closed surface centred at the origin whose vertices sit near radius 1. Run in
    // release (`cargo test -p mesh --release`) — the multigrid solve is far too slow
    // unoptimized. Kept small (depth 5, ~2k pts) so release runtime is a few seconds.
    #[test]
    fn reconstructs_sphere_near_unit_radius() {
        let mut pos: Vec<f32> = Vec::new();
        let mut nrm: Vec<f32> = Vec::new();
        // Fibonacci sphere for a near-uniform sampling.
        let n = 2000usize;
        let ga = std::f64::consts::PI * (3.0 - 5.0_f64.sqrt());
        for i in 0..n {
            let y = 1.0 - (i as f64 / (n - 1) as f64) * 2.0;
            let r = (1.0 - y * y).max(0.0).sqrt();
            let theta = ga * i as f64;
            let (x, z) = (theta.cos() * r, theta.sin() * r);
            pos.extend_from_slice(&[x as f32, y as f32, z as f32]);
            nrm.extend_from_slice(&[x as f32, y as f32, z as f32]); // outward = position on unit sphere
        }

        let bytes = poisson_mesh(&pos, &nrm, 5, 4.0, 0.0);
        let (n_verts, n_tris, verts, idx) = decode(&bytes);
        assert!(n_verts > 100, "too few vertices: {n_verts}");
        assert!(n_tris > 100, "too few triangles: {n_tris}");
        assert_eq!(idx.len(), (n_tris * 3) as usize);
        // Vertices should lie close to the unit sphere. Report mean radius (bias) and
        // RMS deviation (spread) — a systematic inflation would show in the mean.
        let mut sum_r = 0.0f64;
        let mut sse = 0.0f64;
        for v in &verts {
            let r = ((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) as f64).sqrt();
            sum_r += r;
            sse += (r - 1.0).powi(2);
        }
        let mean_r = sum_r / verts.len() as f64;
        let rms = (sse / verts.len() as f64).sqrt();
        eprintln!("sphere: {n_verts} verts, {n_tris} tris, mean radius {mean_r:.3}, RMS {rms:.3}");
        // This is a *sanity* check (is the surface roughly a unit sphere?), not a
        // precision benchmark. At this deliberately-low depth (5, for test speed) the
        // screened-Poisson surface is smoothed slightly outward — mean radius ≈ 1.08;
        // production depth 8 tightens it to ~1 cm on a 2 m sphere but is far too slow to
        // run here. A gross error (wrong normals, broken solve) blows well past these.
        assert!((mean_r - 1.0).abs() < 0.15, "sphere radius grossly wrong: mean {mean_r:.3}");
        assert!(rms < 0.25, "vertices not near unit sphere: RMS {rms:.3}");
    }

    // Trimming keeps the mesh over a well-sampled plane and never emits a triangle
    // whose vertices are all far from the input cloud.
    #[test]
    fn trim_drops_only_far_triangles() {
        // A dense flat grid on z=0 with +z normals.
        let mut pos: Vec<f32> = Vec::new();
        let mut nrm: Vec<f32> = Vec::new();
        let side = 40;
        for i in 0..side {
            for j in 0..side {
                let x = (i as f32 / side as f32) * 2.0 - 1.0;
                let y = (j as f32 / side as f32) * 2.0 - 1.0;
                pos.extend_from_slice(&[x, y, 0.0]);
                nrm.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
        }
        let trim = 0.2f32;
        let bytes = poisson_mesh(&pos, &nrm, 5, 4.0, trim);
        let (n_verts, n_tris, verts, idx) = decode(&bytes);
        assert!(n_tris > 0, "trim removed everything");
        // Every surviving triangle must have at least one vertex within `trim` of the
        // input plane (|z| small and within the [-1,1]² footprint, generously padded).
        for t in idx.chunks_exact(3) {
            let ok = t.iter().any(|&vi| {
                let v = verts[vi as usize];
                v[2].abs() <= trim + 1e-3 && v[0].abs() <= 1.0 + trim && v[1].abs() <= 1.0 + trim
            });
            assert!(ok, "a fully-far triangle survived trimming");
        }
        let _ = n_verts;
    }
}
