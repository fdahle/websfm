// Screened Poisson surface reconstruction → WASM. Wraps the vendored (rayon-free)
// `poisson_reconstruction` crate behind flat-buffer wasm-bindgen entry points,
// matching the byte-buffer style of the other crates. Input is the dense cloud's
// oriented per-point normals (the reused PatchMatch plane normals) plus an optional
// per-sample support weight; output is one indexed triangle mesh.
//
// The solve itself is upstream's. What this file adds is everything PoissonRecon
// ships as a *second* program (SurfaceTrimmer) plus a floater filter, because a
// screened-Poisson surface over a photogrammetric cloud is not usable without them:
//   1. **Density trimming.** Every input sample — including a lone stray point — gets
//      octree leaves, and the solver's adaptive splat puts a sparse sample on a
//      *coarser* layer with a *larger* weight (Kazhdan's area weighting, right for an
//      under-sampled real surface). A floater therefore becomes a closed blob a few
//      coarse cells wide, and the watertight solution also extrapolates a hull far past
//      the data. Both lie where the samples' *support* is low, so we splat each
//      sample's support weight (how many raw points it stands for) onto a coarse grid
//      and drop triangles whose support falls below a fraction of the median sample's.
//   2. **Hole refill.** A small trimmed region that is closed and entirely surrounded by
//      kept surface is a hole the solve legitimately bridged; it goes back in
//      (PoissonRecon's `--aRatio`).
//   3. **Small-component removal.** What survives trimming but is not attached to the
//      main surface (a dense leftover cluster) is dropped by area share.
// The distance trim (`trim_dist`) predates these and is kept: it removes extrapolated
// sheets, but cannot remove a floater blob, which by construction lies within any trim
// radius of its own floater points.
//
// NOTE on parameters: the classic PoissonRecon `--samplesPerNode` knob is not
// exposed by this library; its closest quality lever is the *screening* weight.

use nalgebra::{Point3, Vector3};
use poisson_reconstruction::{PoissonBuilder, PoissonReconstruction};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

// Density estimation runs this many octree levels coarser than max depth — a couple
// of levels back keeps the kernel robust to sampling holes without losing detail.
const DENSITY_DEPTH_BACKOFF: usize = 2;
// Conjugate-gradient iteration cap per multigrid level. A cap, not a count: the solve
// stops at a relative residual of 1e-6, which takes ≤ 10 on the test spheres.
const RELAXATION_ITERS: usize = 50;
// The trimming support grid is this many octree levels coarser than the leaves (cell =
// leaf · 2^backoff), the same backoff the solver uses for its own density estimate. One
// leaf would make the support field as patchy as the sampling itself; four leaves
// averages ~16 surface samples per cell, which is what lets a single stray sample stand
// out against the surface by an order of magnitude.
const TRIM_DENSITY_BACKOFF: i32 = 2;

/// Post-solve cleanup. Every field ≤ 0 disables that stage, so `Default` is the raw,
/// untrimmed Poisson surface.
#[derive(Clone, Copy, Debug, Default)]
pub struct MeshOptions {
    /// World-unit radius: drop a triangle all of whose vertices are farther than this
    /// from every sample.
    pub trim_dist: f64,
    /// Drop a triangle whose mean vertex support is below this fraction of the median
    /// sample's support. Unit-free, so one value means the same on every scene.
    pub density_ratio: f64,
    /// Re-add a density-trimmed region that is closed, bordered by kept surface, and
    /// smaller than this fraction of the kept area (a hole the solve bridged).
    pub hole_area_ratio: f64,
    /// Drop a connected component smaller than this fraction of the largest one's area.
    pub min_component_share: f64,
}

/// What each cleanup stage did, for the caller's log and run record. Exposed to JS as a
/// flat `Float64Array` in [`MeshStats::to_vec`] order.
#[derive(Clone, Copy, Debug, Default)]
pub struct MeshStats {
    pub extracted_tris: usize,
    pub distance_removed_tris: usize,
    pub density_removed_tris: usize,
    pub holes_filled: usize,
    pub hole_tris: usize,
    pub components: usize,
    pub components_dropped: usize,
    pub component_dropped_tris: usize,
    pub kept_tris: usize,
    pub median_support: f64,
    pub leaf_width: f64,
}

impl MeshStats {
    /// `[extractedTris, distanceRemovedTris, densityRemovedTris, holesFilled, holeTris,
    ///   components, componentsDropped, componentDroppedTris, keptTris, medianSupport,
    ///   leafWidth]` — the order `src/core/products/mesh.js` `parseMeshStats` reads.
    pub fn to_vec(&self) -> Vec<f64> {
        vec![
            self.extracted_tris as f64,
            self.distance_removed_tris as f64,
            self.density_removed_tris as f64,
            self.holes_filled as f64,
            self.hole_tris as f64,
            self.components as f64,
            self.components_dropped as f64,
            self.component_dropped_tris as f64,
            self.kept_tris as f64,
            self.median_support,
            self.leaf_width,
        ]
    }
}

fn to_nalgebra(pos: &[f32], nrm: &[f32]) -> (Vec<Point3<f64>>, Vec<Vector3<f64>>) {
    let n = pos.len() / 3;
    (
        (0..n)
            .map(|i| Point3::new(pos[i * 3] as f64, pos[i * 3 + 1] as f64, pos[i * 3 + 2] as f64))
            .collect(),
        (0..n)
            .map(|i| Vector3::new(nrm[i * 3] as f64, nrm[i * 3 + 1] as f64, nrm[i * 3 + 2] as f64))
            .collect(),
    )
}

// Per-sample support weights; anything but exactly one per sample means "all 1"
// (represented as an empty vec, which every consumer reads as 1).
fn to_weights(wgt: &[f32], n: usize) -> Vec<f64> {
    if wgt.len() != n {
        return Vec::new();
    }
    wgt.iter().map(|&w| if w.is_finite() && w > 0.0 { w as f64 } else { 0.0 }).collect()
}

fn new_builder(
    points: &[Point3<f64>],
    normals: &[Vector3<f64>],
    max_depth: usize,
    screening: f64,
) -> PoissonBuilder {
    let density_depth = max_depth.saturating_sub(DENSITY_DEPTH_BACKOFF).max(1).min(max_depth);
    PoissonBuilder::new(points, normals, screening, density_depth, max_depth, RELAXATION_ITERS)
}

/// Screened Poisson mesh from oriented points, distance trim only. `pos`/`nrm` are flat
/// `3·N` f32 (world-space; `nrm` unit). `max_depth` is the octree depth (detail vs cost),
/// `screening` the point-fitting weight (0 disables), `trim_dist` the world-unit radius
/// past which a triangle entirely far from the input cloud is culled (≤0 disables).
/// Returns ONE byte buffer, little-endian:
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
    let opts = MeshOptions { trim_dist: trim_dist as f64, ..Default::default() };
    poisson_mesh_with(pos, nrm, &[], max_depth, screening, &opts).0
}

/// [`poisson_mesh`] with support weights and the full cleanup. Rust-side entry for the
/// tests; the app drives the staged [`PoissonMesher`].
pub fn poisson_mesh_with(
    pos: &[f32],
    nrm: &[f32],
    wgt: &[f32],
    max_depth: u32,
    screening: f32,
    opts: &MeshOptions,
) -> (Vec<u8>, MeshStats) {
    let n = pos.len() / 3;
    if n == 0 || nrm.len() < n * 3 || max_depth == 0 {
        return (empty_mesh(), MeshStats::default());
    }
    let (points, normals) = to_nalgebra(pos, nrm);
    let weights = to_weights(wgt, n);
    let builder = new_builder(&points, &normals, max_depth as usize, screening as f64);
    let (poisson, points, iso) = builder.finish_weighted(&weights);
    finalize_mesh(&poisson, &points, &weights, iso, opts)
}

const KEEP: u8 = 0;
const FAR: u8 = 1; // distance-trimmed — final
const LOW: u8 = 2; // density-trimmed — may come back as a hole
const SMALL: u8 = 3; // dropped with a small component

/// Extract, clean up, and encode a mesh from a solved reconstruction. Shared by the
/// one-shot entry points and the staged [`PoissonMesher::finish`].
fn finalize_mesh(
    poisson: &PoissonReconstruction,
    points: &[Point3<f64>],
    weights: &[f64],
    iso: f64,
    opts: &MeshOptions,
) -> (Vec<u8>, MeshStats) {
    let mut stats = MeshStats::default();
    let leaf = poisson.leaf_cell_width();
    stats.leaf_width = leaf;
    // `iso` is the sample-average iso, not 0: screened Poisson's true surface is the
    // average of the implicit function at the input samples, so extracting at 0 inflates
    // the surface (an ~8% radius bias on a test sphere). Kazhdan's PoissonRecon does the
    // same. It is support-weighted (`finish_weighted`), so stray samples don't move it.
    let trimming = opts.trim_dist > 0.0;
    let support = (opts.density_ratio > 0.0 && leaf > 0.0)
        .then(|| SupportDensity::new(points, weights, leaf * 2f64.powi(TRIM_DENSITY_BACKOFF)));

    // Bound the isosurface walk by what the cleanup will keep, so extraction stops
    // chasing the extrapolated hull into empty space instead of generating millions of
    // triangles for us to discard. A triangle survives only if it passes every active
    // trim, so the tightest active reach is a valid bound. Each reach is conservative: a
    // cell's triangles lie inside its AABB, hence `+ half the cell diagonal`. The support
    // field is exactly zero beyond `support_radius` of every sample, and a kept triangle
    // has a vertex with non-zero support. Holes that will be refilled lie within the
    // support reach of their rim, so the bound extracts them whole; a region the bound
    // does clip ends in an open edge and is never mistaken for a hole.
    let half_diag = leaf * 3f64.sqrt() / 2.0;
    let mut reach = f64::INFINITY;
    if trimming {
        reach = reach.min(opts.trim_dist + half_diag);
    }
    if let Some(s) = &support {
        reach = reach.min(s.support_radius() + half_diag);
    }
    let buffers = if reach.is_finite() {
        let reach_near = PointProximity::new(points, reach);
        poisson.reconstruct_mesh_buffers_iso_within(iso, &|c| reach_near.near(c.x, c.y, c.z))
    } else {
        poisson.reconstruct_mesh_buffers_iso(iso)
    };
    let verts: Vec<[f64; 3]> = buffers.vertices().iter().map(|p| [p.x, p.y, p.z]).collect();
    let tris: Vec<u32> = buffers.indices().to_vec();
    stats.extracted_tris = tris.len() / 3;
    if verts.is_empty() || tris.len() < 3 {
        return (empty_mesh(), stats);
    }

    let mut class = vec![KEEP; tris.len() / 3];

    // Distance trim: drop any triangle all of whose vertices lie farther than
    // `trim_dist` from every input point.
    if trimming {
        let near = PointProximity::new(points, opts.trim_dist);
        let vert_near: Vec<bool> = verts.iter().map(|v| near.near(v[0], v[1], v[2])).collect();
        for (ti, t) in tris.chunks_exact(3).enumerate() {
            if t.iter().all(|&v| !vert_near[v as usize]) {
                class[ti] = FAR;
                stats.distance_removed_tris += 1;
            }
        }
    }

    // Density trim, then refill the holes it opened.
    if let Some(s) = &support {
        let median = s.median_at(points);
        stats.median_support = median;
        let thr = opts.density_ratio * median;
        let vs: Vec<f64> = verts.iter().map(|v| s.eval(v[0], v[1], v[2])).collect();
        for (ti, t) in tris.chunks_exact(3).enumerate() {
            if class[ti] != KEEP {
                continue;
            }
            let mean = (vs[t[0] as usize] + vs[t[1] as usize] + vs[t[2] as usize]) / 3.0;
            if mean < thr {
                class[ti] = LOW;
                stats.density_removed_tris += 1;
            }
        }
        if opts.hole_area_ratio > 0.0 {
            refill_holes(&verts, &tris, &mut class, opts.hole_area_ratio, &mut stats);
        }
    }

    if opts.min_component_share > 0.0 {
        // Two leaves: a sample on the surface is within a leaf of an extracted vertex.
        let reach = 2.0 * leaf;
        drop_small_components(
            &verts, &tris, &mut class, opts.min_component_share, points, weights, reach, &mut stats,
        );
    }

    let (verts, tris) = compact(&verts, &tris, |ti| class[ti] == KEEP);
    stats.kept_tris = tris.len() / 3;
    if verts.is_empty() || tris.len() < 3 {
        return (empty_mesh(), stats);
    }
    (encode_mesh(&verts, &tris), stats)
}

/// Staged, JS-driven wrapper around the screened-Poisson solve. Exposes the phases the
/// worker steps through so it can paint per-layer progress (the whole solve is a single
/// blocking wasm call otherwise — the "stuck at Poisson solve" symptom) and keep the
/// largest uninterruptible unit of work down to one multigrid layer:
///
/// ```text
///   let m = PoissonMesher.build(pos, nrm, wgt, depth, screening) // octree + field
///   for _ in 0..m.num_layers() { m.solve_step() }                 // solve, report progress
///   let bytes = m.finish(trim, densityRatio, holeRatio, minShare)  // extract + clean + encode
///   let stats = m.stats()                                          // MeshStats::to_vec
///   m.free()
/// ```
#[wasm_bindgen]
pub struct PoissonMesher {
    builder: Option<PoissonBuilder>,
    weights: Vec<f64>,
    stats: MeshStats,
}

#[wasm_bindgen]
impl PoissonMesher {
    /// Build the multigrid octree + vector field (no layer solved yet). `pos`/`nrm` are
    /// flat `3·N` f32 (world-space; `nrm` unit); `wgt` is one support weight per sample
    /// (raw points it stands for) or empty for all-1; `max_depth`/`screening` as in
    /// [`poisson_mesh`]. An empty / degenerate input yields a mesher with zero layers
    /// whose `finish` returns an empty mesh.
    pub fn build(pos: &[f32], nrm: &[f32], wgt: &[f32], max_depth: u32, screening: f32) -> PoissonMesher {
        let n = pos.len() / 3;
        if n == 0 || nrm.len() < n * 3 || max_depth == 0 {
            return PoissonMesher { builder: None, weights: Vec::new(), stats: MeshStats::default() };
        }
        let (points, normals) = to_nalgebra(pos, nrm);
        let builder = new_builder(&points, &normals, max_depth as usize, screening as f64);
        PoissonMesher { builder: Some(builder), weights: to_weights(wgt, n), stats: MeshStats::default() }
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

    /// Solve any remaining layers, then extract, clean up (see [`MeshOptions`]; each
    /// argument ≤ 0 disables its stage) and encode the mesh to the little-endian wire
    /// buffer described on [`poisson_mesh`]. Consumes the internal builder — call once.
    pub fn finish(
        &mut self,
        trim_dist: f32,
        density_ratio: f32,
        hole_area_ratio: f32,
        min_component_share: f32,
    ) -> Vec<u8> {
        let Some(builder) = self.builder.take() else {
            return empty_mesh();
        };
        let opts = MeshOptions {
            trim_dist: trim_dist as f64,
            density_ratio: density_ratio as f64,
            hole_area_ratio: hole_area_ratio as f64,
            min_component_share: min_component_share as f64,
        };
        let (poisson, points, iso) = builder.finish_weighted(&self.weights);
        let (bytes, stats) = finalize_mesh(&poisson, &points, &self.weights, iso, &opts);
        self.stats = stats;
        bytes
    }

    /// What the last `finish` did, in [`MeshStats::to_vec`] order.
    pub fn stats(&self) -> Vec<f64> {
        self.stats.to_vec()
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

/// Keep the triangles `keep(ti)` accepts and renumber their vertices densely.
fn compact(
    verts: &[[f64; 3]],
    tris: &[u32],
    keep: impl Fn(usize) -> bool,
) -> (Vec<[f64; 3]>, Vec<u32>) {
    let mut remap = vec![u32::MAX; verts.len()];
    let mut out_verts: Vec<[f64; 3]> = Vec::new();
    let mut out_tris: Vec<u32> = Vec::with_capacity(tris.len());
    for (ti, t) in tris.chunks_exact(3).enumerate() {
        if !keep(ti) {
            continue;
        }
        for &vi in t {
            let vi = vi as usize;
            if remap[vi] == u32::MAX {
                remap[vi] = out_verts.len() as u32;
                out_verts.push(verts[vi]);
            }
            out_tris.push(remap[vi]);
        }
    }
    (out_verts, out_tris)
}

fn tri_area(verts: &[[f64; 3]], t: &[u32]) -> f64 {
    let a = verts[t[0] as usize];
    let b = verts[t[1] as usize];
    let c = verts[t[2] as usize];
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let x = u[1] * v[2] - u[2] * v[1];
    let y = u[2] * v[0] - u[0] * v[2];
    let z = u[0] * v[1] - u[1] * v[0];
    0.5 * (x * x + y * y + z * z).sqrt()
}

/// Union-find over vertex ids (path halving + union by size).
struct UnionFind {
    parent: Vec<u32>,
    size: Vec<u32>,
}

impl UnionFind {
    fn new(n: usize) -> Self {
        Self { parent: (0..n as u32).collect(), size: vec![1; n] }
    }
    fn find(&mut self, mut x: u32) -> u32 {
        while self.parent[x as usize] != x {
            let p = self.parent[x as usize];
            self.parent[x as usize] = self.parent[p as usize];
            x = self.parent[x as usize];
        }
        x
    }
    fn union(&mut self, a: u32, b: u32) {
        let (mut ra, mut rb) = (self.find(a), self.find(b));
        if ra == rb {
            return;
        }
        if self.size[ra as usize] < self.size[rb as usize] {
            std::mem::swap(&mut ra, &mut rb);
        }
        self.parent[rb as usize] = ra;
        self.size[ra as usize] += self.size[rb as usize];
    }
}

/// Re-add density-trimmed (`LOW`) regions that are holes the solve bridged: connected
/// (through shared vertices), **closed** — every edge shared by two non-distance-trimmed
/// triangles, so the region is not cut by the extraction bound or a distance trim — and
/// no larger than `ratio` × the area of the kept piece it borders.
///
/// The comparison is against the *bordering piece*, never the whole mesh: a floater
/// blob is also a closed low region attached to kept surface (the dense speck that
/// seeded it), and next to the whole mesh it is small — measured on the floater fixture,
/// refill against total area restored 9 of 29 blobs. Next to its own speck it is
/// enormous. A hole is the reverse: small against the surface around it. A lone blob
/// with no kept part borders nothing and stays out.
fn refill_holes(
    verts: &[[f64; 3]],
    tris: &[u32],
    class: &mut [u8],
    ratio: f64,
    stats: &mut MeshStats,
) {
    let mut edge_uses: HashMap<(u32, u32), u8> = HashMap::with_capacity(tris.len());
    let mut low = UnionFind::new(verts.len());
    let mut kept = UnionFind::new(verts.len());
    let mut on_kept = vec![false; verts.len()];
    for (ti, t) in tris.chunks_exact(3).enumerate() {
        if class[ti] == FAR {
            continue;
        }
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let e = edge_uses.entry((a.min(b), a.max(b))).or_insert(0);
            *e = e.saturating_add(1);
        }
        let uf = match class[ti] {
            KEEP => {
                for &v in t {
                    on_kept[v as usize] = true;
                }
                &mut kept
            }
            LOW => &mut low,
            _ => continue,
        };
        uf.union(t[0], t[1]);
        uf.union(t[1], t[2]);
    }
    let mut kept_area: HashMap<u32, f64> = HashMap::new();
    for (ti, t) in tris.chunks_exact(3).enumerate() {
        if class[ti] == KEEP {
            *kept_area.entry(kept.find(t[0])).or_insert(0.0) += tri_area(verts, t);
        }
    }

    #[derive(Default)]
    struct Region {
        area: f64,
        open: bool,
        border_area: f64, // largest kept piece this region touches
    }
    let mut regions: HashMap<u32, Region> = HashMap::new();
    for (ti, t) in tris.chunks_exact(3).enumerate() {
        if class[ti] != LOW {
            continue;
        }
        let r = regions.entry(low.find(t[0])).or_default();
        r.area += tri_area(verts, t);
        if !r.open {
            r.open = [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])]
                .iter()
                .any(|&(a, b)| edge_uses.get(&(a.min(b), a.max(b))).copied().unwrap_or(0) < 2);
        }
        for &v in t {
            if on_kept[v as usize] {
                let a = kept_area[&kept.find(v)];
                if a > r.border_area {
                    r.border_area = a;
                }
            }
        }
    }
    let mut filled: Vec<u32> = Vec::new();
    for (ti, t) in tris.chunks_exact(3).enumerate() {
        if class[ti] != LOW {
            continue;
        }
        let root = low.find(t[0]);
        let r = &regions[&root];
        if !r.open && r.border_area > 0.0 && r.area <= ratio * r.border_area {
            class[ti] = KEEP;
            stats.density_removed_tris -= 1;
            stats.hole_tris += 1;
            filled.push(root);
        }
    }
    filled.sort_unstable();
    filled.dedup();
    stats.holes_filled = filled.len();
}

/// Drop kept triangles whose connected component (through shared vertices — the
/// marching-cubes output is welded) explains less than `share` of the support the
/// best-supported component explains.
///
/// A component's **support** is the summed weight of the input samples whose nearest
/// kept vertex (within `reach`) belongs to it — how much of the evidence that piece
/// accounts for. Not its area: Poisson inflates a 20-sample speck into a closed ball a
/// few cells across, and on the floater fixture those balls were each ~1 % of the main
/// surface's area while explaining 0.25 % of its samples. A piece no sample lies near
/// (an extrapolated sheet) has zero support and goes. If no component is supported at
/// all (degenerate input), fall back to area so the filter never empties a mesh.
fn drop_small_components(
    verts: &[[f64; 3]],
    tris: &[u32],
    class: &mut [u8],
    share: f64,
    points: &[Point3<f64>],
    weights: &[f64],
    reach: f64,
    stats: &mut MeshStats,
) {
    let mut uf = UnionFind::new(verts.len());
    let mut on_kept = vec![false; verts.len()];
    for (ti, t) in tris.chunks_exact(3).enumerate() {
        if class[ti] == KEEP {
            uf.union(t[0], t[1]);
            uf.union(t[1], t[2]);
            for &v in t {
                on_kept[v as usize] = true;
            }
        }
    }
    let mut area: HashMap<u32, f64> = HashMap::new();
    for (ti, t) in tris.chunks_exact(3).enumerate() {
        if class[ti] == KEEP {
            *area.entry(uf.find(t[0])).or_insert(0.0) += tri_area(verts, t);
        }
    }
    stats.components = area.len();
    if area.len() <= 1 {
        return;
    }

    // Each sample → its nearest kept vertex within `reach` → that vertex's component.
    let inv = 1.0 / reach;
    let key = |x: f64, y: f64, z: f64| {
        ((x * inv).floor() as i64, (y * inv).floor() as i64, (z * inv).floor() as i64)
    };
    let mut grid: HashMap<(i64, i64, i64), Vec<u32>> = HashMap::new();
    for (vi, v) in verts.iter().enumerate() {
        if on_kept[vi] {
            grid.entry(key(v[0], v[1], v[2])).or_default().push(vi as u32);
        }
    }
    let r2 = reach * reach;
    let mut support: HashMap<u32, f64> = HashMap::new();
    for (i, p) in points.iter().enumerate() {
        let w = weights.get(i).copied().unwrap_or(1.0);
        if w <= 0.0 {
            continue;
        }
        let (cx, cy, cz) = key(p.x, p.y, p.z);
        let mut best = (r2, u32::MAX);
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    let Some(ids) = grid.get(&(cx + dx, cy + dy, cz + dz)) else { continue };
                    for &vi in ids {
                        let v = verts[vi as usize];
                        let d2 = (v[0] - p.x).powi(2) + (v[1] - p.y).powi(2) + (v[2] - p.z).powi(2);
                        if d2 <= best.0 {
                            best = (d2, vi);
                        }
                    }
                }
            }
        }
        if best.1 != u32::MAX {
            *support.entry(uf.find(best.1)).or_insert(0.0) += w;
        }
    }

    let by_support = support.values().any(|&s| s > 0.0);
    let measure = |root: u32| -> f64 {
        if by_support {
            support.get(&root).copied().unwrap_or(0.0)
        } else {
            area[&root]
        }
    };
    let largest = area.keys().map(|&r| measure(r)).fold(0.0, f64::max);
    let min = share * largest;
    stats.components_dropped = area.keys().filter(|&&r| measure(r) < min).count();
    for (ti, t) in tris.chunks_exact(3).enumerate() {
        if class[ti] == KEEP && measure(uf.find(t[0])) < min {
            class[ti] = SMALL;
            stats.component_dropped_tris += 1;
        }
    }
}


/// Support density: each sample's weight (raw points it stands for) splatted trilinearly
/// onto a lattice of `cell` spacing, evaluated trilinearly. Exactly zero farther than
/// two cells along any axis from every sample — the property the extraction bound uses.
struct SupportDensity {
    inv: f64,
    cell: f64,
    nodes: HashMap<(i64, i64, i64), f64>,
}

impl SupportDensity {
    fn new(points: &[Point3<f64>], weights: &[f64], cell: f64) -> Self {
        let inv = 1.0 / cell;
        let mut nodes: HashMap<(i64, i64, i64), f64> = HashMap::with_capacity(points.len() * 2);
        for (i, p) in points.iter().enumerate() {
            let w = weights.get(i).copied().unwrap_or(1.0);
            if w <= 0.0 {
                continue;
            }
            let (base, f) = Self::locate(inv, p.x, p.y, p.z);
            for c in 0..8 {
                let (dx, dy, dz) = (c & 1, (c >> 1) & 1, (c >> 2) & 1);
                let k = Self::corner_weight(&f, dx, dy, dz);
                if k > 0.0 {
                    *nodes
                        .entry((base.0 + dx as i64, base.1 + dy as i64, base.2 + dz as i64))
                        .or_insert(0.0) += w * k;
                }
            }
        }
        Self { inv, cell, nodes }
    }

    fn locate(inv: f64, x: f64, y: f64, z: f64) -> ((i64, i64, i64), [f64; 3]) {
        let (gx, gy, gz) = (x * inv, y * inv, z * inv);
        let (bx, by, bz) = (gx.floor(), gy.floor(), gz.floor());
        ((bx as i64, by as i64, bz as i64), [gx - bx, gy - by, gz - bz])
    }

    fn corner_weight(f: &[f64; 3], dx: usize, dy: usize, dz: usize) -> f64 {
        let ax = if dx == 1 { f[0] } else { 1.0 - f[0] };
        let ay = if dy == 1 { f[1] } else { 1.0 - f[1] };
        let az = if dz == 1 { f[2] } else { 1.0 - f[2] };
        ax * ay * az
    }

    fn eval(&self, x: f64, y: f64, z: f64) -> f64 {
        let (base, f) = Self::locate(self.inv, x, y, z);
        let mut s = 0.0;
        for c in 0..8 {
            let (dx, dy, dz) = (c & 1, (c >> 1) & 1, (c >> 2) & 1);
            if let Some(v) = self
                .nodes
                .get(&(base.0 + dx as i64, base.1 + dy as i64, base.2 + dz as i64))
            {
                s += v * Self::corner_weight(&f, dx, dy, dz);
            }
        }
        s
    }

    /// Beyond this distance from every sample the field is exactly zero: a query's
    /// corner nodes and a sample's splat nodes can only coincide within two cells per
    /// axis.
    fn support_radius(&self) -> f64 {
        2.0 * self.cell * 3f64.sqrt()
    }

    /// Median of the field over the samples themselves — the "typical surface" level
    /// the trim ratio is relative to.
    fn median_at(&self, points: &[Point3<f64>]) -> f64 {
        let mut v: Vec<f64> = points.iter().map(|p| self.eval(p.x, p.y, p.z)).collect();
        if v.is_empty() {
            return 0.0;
        }
        let mid = v.len() / 2;
        let (_, m, _) = v.select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
        *m
    }
}

/// Voxel-hash proximity index over the input points: "is this position within `radius`
/// of any sample?". Cells are `radius`-sized so the answer is a scan of 27 cells. Same
/// packed-cell idea as the JS fusion accumulator.
struct PointProximity<'a> {
    grid: HashMap<(i64, i64, i64), Vec<usize>>,
    points: &'a [Point3<f64>],
    inv: f64,
    radius2: f64,
}

impl<'a> PointProximity<'a> {
    fn new(points: &'a [Point3<f64>], radius: f64) -> Self {
        let inv = 1.0 / radius;
        let mut grid: HashMap<(i64, i64, i64), Vec<usize>> = HashMap::new();
        for (i, p) in points.iter().enumerate() {
            let key = (
                (p.x * inv).floor() as i64,
                (p.y * inv).floor() as i64,
                (p.z * inv).floor() as i64,
            );
            grid.entry(key).or_default().push(i);
        }
        Self { grid, points, inv, radius2: radius * radius }
    }

    fn near(&self, x: f64, y: f64, z: f64) -> bool {
        let cx = (x * self.inv).floor() as i64;
        let cy = (y * self.inv).floor() as i64;
        let cz = (z * self.inv).floor() as i64;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(ids) = self.grid.get(&(cx + dx, cy + dy, cz + dz)) {
                        for &i in ids {
                            let p = &self.points[i];
                            let (ex, ey, ez) = (p.x - x, p.y - y, p.z - z);
                            if ex * ex + ey * ey + ez * ez <= self.radius2 {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        false
    }
}

// Keep a triangle if ANY of its vertices is within trim_dist of ANY input point.
// Returns the compacted (verts, idx). The reference the bounded-extraction test
// compares `finalize_mesh` against.
#[cfg(test)]
fn trim_far_triangles(
    verts: &[[f64; 3]],
    tris: &[u32],
    near: &PointProximity,
) -> (Vec<[f64; 3]>, Vec<u32>) {
    let vert_near: Vec<bool> = verts.iter().map(|v| near.near(v[0], v[1], v[2])).collect();
    compact(verts, tris, |ti| {
        let t = &tris[ti * 3..ti * 3 + 3];
        t.iter().any(|&v| vert_near[v as usize])
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // A mesh as a sorted list of triangles, each a sorted triple of vertex positions —
    // identity that survives a renumbering of the vertex buffer. Bit patterns are used
    // as the sort key (positions are copied verbatim, never recomputed).
    fn canonical_triangles(pos: &[[f32; 3]], idx: &[u32]) -> Vec<[[u32; 3]; 3]> {
        let bits = |v: [f32; 3]| [v[0].to_bits(), v[1].to_bits(), v[2].to_bits()];
        let mut tris: Vec<[[u32; 3]; 3]> = idx
            .chunks_exact(3)
            .map(|t| {
                let mut v = [
                    bits(pos[t[0] as usize]),
                    bits(pos[t[1] as usize]),
                    bits(pos[t[2] as usize]),
                ];
                v.sort();
                v
            })
            .collect();
        tris.sort();
        tris
    }

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
        // The 1.08 / 0.19 this used to accept was the unconverged CG (x₀ = b, see the
        // vendored conjugate_gradient.rs): spurious cell-sized shells around the sphere.
        // Converged, depth 5 sits within a few thousandths of the unit sphere.
        assert!((mean_r - 1.0).abs() < 0.01, "sphere radius wrong: mean {mean_r:.4}");
        assert!(rms < 0.01, "vertices not near unit sphere: RMS {rms:.4}");
    }

    // Bounding the isosurface walk to the region trimming would keep must not change
    // the trimmed mesh — it may only skip work. This pins the equivalence claim behind
    // `reconstruct_mesh_buffers_iso_within`: extract bounded then trim (what
    // `finalize_mesh` does) against extract everywhere then trim (what it used to do).
    // A too-tight bound shows up here as a smaller mesh; the naive "stay inside the
    // octree AABB" bound fails it, because the coarse multigrid layers have support far
    // wider than the finest layer's extent.
    #[test]
    fn bounded_extraction_matches_unbounded_after_trimming() {
        // A hemisphere-ish cap: an open surface, so Poisson extrapolates hard past the
        // rim and there is genuinely far-from-data isosurface for the bound to skip.
        let mut pos: Vec<f32> = Vec::new();
        let mut nrm: Vec<f32> = Vec::new();
        let n = 3000usize;
        let ga = std::f64::consts::PI * (3.0 - 5.0_f64.sqrt());
        for i in 0..n {
            let y = 1.0 - (i as f64 / (n - 1) as f64); // upper half only
            let r = (1.0 - y * y).max(0.0).sqrt();
            let theta = ga * i as f64;
            let (x, z) = (theta.cos() * r, theta.sin() * r);
            pos.extend_from_slice(&[x as f32, y as f32, z as f32]);
            nrm.extend_from_slice(&[x as f32, y as f32, z as f32]);
        }

        let (points, normals) = to_nalgebra(&pos, &nrm);
        let (poisson, points, iso) = PoissonBuilder::new(&points, &normals, 4.0, 3, 5, 10).finish();
        let trim = 0.15f32;

        // What finalize_mesh produces: bounded extraction, then trim.
        let opts = MeshOptions { trim_dist: trim as f64, ..Default::default() };
        let (bounded, _) = finalize_mesh(&poisson, &points, &[], iso, &opts);

        // Reference: extract over the whole domain, then trim.
        let buffers = poisson.reconstruct_mesh_buffers_iso(iso);
        let verts: Vec<[f64; 3]> = buffers.vertices().iter().map(|p| [p.x, p.y, p.z]).collect();
        let tris: Vec<u32> = buffers.indices().to_vec();
        let near = PointProximity::new(&points, trim as f64);
        let (rverts, rtris) = trim_far_triangles(&verts, &tris, &near);
        let reference = encode_mesh(&rverts, &rtris);

        let (bv, bt, bpos, bidx) = decode(&bounded);
        let (rv, rt, rpos, ridx) = decode(&reference);
        eprintln!("bounded: {bv} verts / {bt} tris; unbounded+trim: {rv} verts / {rt} tris");
        assert!(bt > 100, "degenerate test fixture: only {bt} triangles survived");
        // Compare the geometry, not the buffer: skipping cells changes the order the
        // flood visits them in, so the same triangles come out under a different vertex
        // numbering. Canonicalize to a sorted list of sorted vertex triples.
        assert_eq!(
            canonical_triangles(&bpos, &bidx),
            canonical_triangles(&rpos, &ridx),
            "bounding the walk changed the trimmed mesh"
        );
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

    // ── Cleanup fixtures (density trim / hole refill / small components) ──────────

    // Deterministic xorshift64 so the fixtures are reproducible.
    struct Rng(u64);
    impl Rng {
        fn uniform(&mut self) -> f64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
        fn gauss(&mut self) -> f64 {
            let u = self.uniform().max(1e-12);
            let v = self.uniform();
            (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
        }
    }

    // Fibonacci unit sphere with outward normals and radial Gaussian noise `sigma`,
    // minus the points `skip` rejects.
    fn sphere_samples(
        n: usize,
        sigma: f64,
        rng: &mut Rng,
        skip: impl Fn(f64, f64, f64) -> bool,
        pos: &mut Vec<f32>,
        nrm: &mut Vec<f32>,
    ) {
        let ga = std::f64::consts::PI * (3.0 - 5.0_f64.sqrt());
        for i in 0..n {
            let y = 1.0 - (i as f64 / (n - 1) as f64) * 2.0;
            let r = (1.0 - y * y).max(0.0).sqrt();
            let theta = ga * i as f64;
            let (x, z) = (theta.cos() * r, theta.sin() * r);
            if skip(x, y, z) {
                continue;
            }
            let s = 1.0 + sigma * rng.gauss();
            pos.extend_from_slice(&[(x * s) as f32, (y * s) as f32, (z * s) as f32]);
            nrm.extend_from_slice(&[x as f32, y as f32, z as f32]);
        }
    }

    #[derive(Debug)]
    #[allow(dead_code)] // fields are read through the Debug print
    struct Report {
        tris: usize,
        components: usize,
        largest_share: f64, // largest component's share of the area
        off_share: f64,     // share of the area farther than 3 leaves from the unit sphere
        boundary_edges: usize,
        mean_r: f64,
    }

    fn analyse(bytes: &[u8], leaf: f64) -> Report {
        let (nv, nt, pos, idx) = decode(bytes);
        let verts: Vec<[f64; 3]> = pos.iter().map(|p| [p[0] as f64, p[1] as f64, p[2] as f64]).collect();
        let mut uf = UnionFind::new(nv as usize);
        let mut edges: HashMap<(u32, u32), u32> = HashMap::new();
        for t in idx.chunks_exact(3) {
            uf.union(t[0], t[1]);
            uf.union(t[1], t[2]);
            for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                *edges.entry((a.min(b), a.max(b))).or_insert(0) += 1;
            }
        }
        let (mut total, mut off) = (0.0, 0.0);
        let mut comp: HashMap<u32, f64> = HashMap::new();
        for t in idx.chunks_exact(3) {
            let a = tri_area(&verts, t);
            total += a;
            *comp.entry(uf.find(t[0])).or_insert(0.0) += a;
            let c: Vec<f64> = (0..3)
                .map(|k| t.iter().map(|&v| verts[v as usize][k]).sum::<f64>() / 3.0)
                .collect();
            let r = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
            if (r - 1.0).abs() > 3.0 * leaf {
                off += a;
            }
        }
        let mean_r = verts
            .iter()
            .map(|v| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt())
            .sum::<f64>()
            / verts.len().max(1) as f64;
        let largest = comp.values().copied().fold(0.0, f64::max);
        Report {
            tris: nt as usize,
            components: comp.len(),
            largest_share: if total > 0.0 { largest / total } else { 0.0 },
            off_share: if total > 0.0 { off / total } else { 0.0 },
            boundary_edges: edges.values().filter(|&&c| c == 1).count(),
            mean_r,
        }
    }

    // The eagle failure in miniature: a noisy sphere plus fusion-style noise off the
    // surface — lone strays and small coherent patches. Poisson closes each patch into a
    // blob; the cleanup must leave one component on the sphere.
    #[test]
    fn cleanup_removes_floater_blobs() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let (mut pos, mut nrm) = (Vec::new(), Vec::new());
        sphere_samples(8000, 0.003, &mut rng, |_, _, _| false, &mut pos, &mut nrm);
        let mut floaters = 0;
        while floaters < 320 {
            let p = [0, 1, 2].map(|_| (rng.uniform() * 2.0 - 1.0) * 1.6);
            let r = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
            if (r - 1.0).abs() < 0.2 {
                continue;
            }
            let n = [0, 1, 2].map(|_| rng.gauss());
            let nl = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-9);
            pos.extend(p.iter().map(|&v| v as f32));
            nrm.extend(n.iter().map(|&v| (v / nl) as f32));
            floaters += 1;
        }
        // Lone strays are not what survives fusion, though — a converged solve ignores
        // them. Fusion noise is small coherent patches (a speck of background fused from
        // a few pixels, normals consistent), and Poisson closes each into a blob. 30
        // discs of 20 samples, radius 0.06, off the sphere.
        let mut patches = 0;
        while patches < 30 {
            let c = [0, 1, 2].map(|_| (rng.uniform() * 2.0 - 1.0) * 1.5);
            let r = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
            if (r - 1.0).abs() < 0.3 {
                continue;
            }
            let n = [0, 1, 2].map(|_| rng.gauss());
            let nl = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-9);
            let n = n.map(|v| v / nl);
            // Two tangents spanning the disc.
            let a = if n[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
            let t1 = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
            let l1 = (t1[0] * t1[0] + t1[1] * t1[1] + t1[2] * t1[2]).sqrt();
            let t1 = t1.map(|v| v / l1);
            let t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];
            for _ in 0..20 {
                let (u, v) = loop {
                    let (u, v) = (rng.uniform() * 2.0 - 1.0, rng.uniform() * 2.0 - 1.0);
                    if u * u + v * v <= 1.0 {
                        break (u * 0.06, v * 0.06);
                    }
                };
                pos.extend((0..3).map(|k| (c[k] + u * t1[k] + v * t2[k]) as f32));
                nrm.extend(n.iter().map(|&v| v as f32));
            }
            patches += 1;
        }

        let (raw, raw_stats) = poisson_mesh_with(&pos, &nrm, &[], 6, 4.0, &MeshOptions::default());
        let raw_r = analyse(&raw, raw_stats.leaf_width);
        let opts = MeshOptions {
            density_ratio: 0.1,
            hole_area_ratio: 0.01,
            min_component_share: 0.01,
            ..Default::default()
        };
        let (clean, stats) = poisson_mesh_with(&pos, &nrm, &[], 6, 4.0, &opts);
        let clean_r = analyse(&clean, stats.leaf_width);
        eprintln!("floaters raw:   {raw_r:?}");
        eprintln!("floaters clean: {clean_r:?}\n  stats {stats:?}");

        assert!(raw_r.components > 1, "fixture no longer reproduces floater blobs: {raw_r:?}");
        assert_eq!(clean_r.components, 1, "floater pieces survived: {clean_r:?}");
        assert!(clean_r.off_share < 0.01, "off-surface area survived: {clean_r:?}");
        assert!(clean_r.largest_share > 0.99);
        assert!((clean_r.mean_r - 1.0).abs() < 0.15, "surface moved: {clean_r:?}");
        // The support bound may only skip work, never add triangles.
        assert!(stats.extracted_tris <= raw_stats.extracted_tris);
    }

    // A sphere with an unobserved cap: density trimming opens the bridged cap, hole
    // refill closes it again; without refill the trimmed mesh has a boundary.
    #[test]
    fn hole_refill_closes_a_bridged_cap() {
        let mut rng = Rng(7);
        let (mut pos, mut nrm) = (Vec::new(), Vec::new());
        let cap = 0.4f64.cos(); // angular radius 0.4 rad around +y (~4% of the sphere)
        sphere_samples(8000, 0.0, &mut rng, |_, y, _| y > cap, &mut pos, &mut nrm);

        let trim_only = MeshOptions { density_ratio: 0.1, ..Default::default() };
        let (open, open_stats) = poisson_mesh_with(&pos, &nrm, &[], 6, 4.0, &trim_only);
        let open_r = analyse(&open, open_stats.leaf_width);
        let refill = MeshOptions { hole_area_ratio: 0.1, ..trim_only };
        let (closed, closed_stats) = poisson_mesh_with(&pos, &nrm, &[], 6, 4.0, &refill);
        let closed_r = analyse(&closed, closed_stats.leaf_width);
        eprintln!("cap trimmed: {open_r:?}\ncap refilled: {closed_r:?}\n  stats {closed_stats:?}");

        assert!(open_stats.density_removed_tris > 0, "the cap was not trimmed");
        assert!(open_r.boundary_edges > 0, "trimming should open the cap");
        assert_eq!(closed_stats.holes_filled, 1);
        assert_eq!(closed_r.boundary_edges, 0, "the refilled cap is still open");
        assert_eq!(closed_r.components, 1);
    }

    // Solver-assembly equivalence harness. `WEBSFM_WEIGHTS=write` records every layer's
    // solved coefficients for a fixed noisy sphere (screening on) to a file; a later run
    // with `WEBSFM_WEIGHTS=check` compares against it. Used to show that a restructured
    // assembly solves the same system as the one it replaced. Run with
    //   WEBSFM_WEIGHTS=write cargo test -p mesh --release --lib solver_weights -- --ignored
    #[test]
    #[ignore]
    fn solver_weights_reference() {
        let mode = std::env::var("WEBSFM_WEIGHTS").unwrap_or_default();
        let path = std::env::var("WEBSFM_WEIGHTS_FILE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("websfm_mesh_weights.bin"));
        let mut rng = Rng(11);
        let (mut pos, mut nrm) = (Vec::new(), Vec::new());
        sphere_samples(6000, 0.01, &mut rng, |_, y, _| y > 0.9, &mut pos, &mut nrm);
        let (points, normals) = to_nalgebra(&pos, &nrm);
        let t0 = std::time::Instant::now();
        let (poisson, _, _) = new_builder(&points, &normals, 6, 4.0).finish();
        eprintln!("solve: {:.2}s", t0.elapsed().as_secs_f64());
        let w: Vec<f64> = poisson.layer_weights().into_iter().flatten().collect();
        match mode.as_str() {
            "write" => {
                let bytes: Vec<u8> = w.iter().flat_map(|v| v.to_le_bytes()).collect();
                std::fs::write(&path, bytes).unwrap();
                eprintln!("wrote {} weights to {}", w.len(), path.display());
            }
            "check" => {
                let bytes = std::fs::read(&path).unwrap();
                let r: Vec<f64> = bytes
                    .chunks_exact(8)
                    .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
                    .collect();
                assert_eq!(r.len(), w.len(), "node count changed");
                let scale = r.iter().fold(0.0f64, |m, v| m.max(v.abs()));
                let diff = r.iter().zip(&w).fold(0.0f64, |m, (a, b)| m.max((a - b).abs()));
                eprintln!("{} weights, max |Δ| = {diff:.3e} (max |w| = {scale:.3e})", w.len());
                assert!(diff <= 1e-9 * scale, "solution moved: {diff:e} vs {scale:e}");
            }
            _ => eprintln!("set WEBSFM_WEIGHTS=write|check"),
        }
    }

    #[test]
    #[ignore]
    fn sweep_cg_iterations() {
        let mut rng = Rng(7);
        let (mut pos, mut nrm) = (Vec::new(), Vec::new());
        sphere_samples(8000, 0.0, &mut rng, |_, _, _| false, &mut pos, &mut nrm);
        let (points, normals) = to_nalgebra(&pos, &nrm);
        for &iters in &[10usize, 30, 100] {
            let t0 = std::time::Instant::now();
            let b = PoissonBuilder::new(&points, &normals, 4.0, 4, 6, iters);
            let (poisson, pts, iso) = b.finish_weighted(&[]);
            let (bytes, st) = finalize_mesh(&poisson, &pts, &[], iso, &MeshOptions::default());
            let r = analyse(&bytes, st.leaf_width);
            let (_, _, vp, _) = decode(&bytes);
            let rms = (vp.iter().map(|v| {
                let rr = ((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) as f64).sqrt();
                (rr - 1.0).powi(2)
            }).sum::<f64>() / vp.len().max(1) as f64).sqrt();
            eprintln!("iters {iters:4}: {:.1}s rms {rms:.4} {r:?}", t0.elapsed().as_secs_f64());
        }
    }

    // All-1 support weights are the unweighted solve, bit for bit (the weighted iso
    // average must reduce to the plain mean the solver used before).
    #[test]
    fn unit_weights_match_unweighted() {
        let mut rng = Rng(3);
        let (mut pos, mut nrm) = (Vec::new(), Vec::new());
        sphere_samples(2000, 0.0, &mut rng, |_, _, _| false, &mut pos, &mut nrm);
        let ones = vec![1.0f32; pos.len() / 3];
        let opts = MeshOptions { density_ratio: 0.1, min_component_share: 0.01, ..Default::default() };
        let (a, _) = poisson_mesh_with(&pos, &nrm, &[], 5, 4.0, &opts);
        let (b, _) = poisson_mesh_with(&pos, &nrm, &ones, 5, 4.0, &opts);
        // Geometry, not buffer: extraction floods through a randomly seeded HashMap,
        // so vertex numbering differs run to run (see the bounded-extraction test).
        let (_, _, ap, ai) = decode(&a);
        let (_, _, bp, bi) = decode(&b);
        assert_eq!(canonical_triangles(&ap, &ai), canonical_triangles(&bp, &bi));
    }
}
