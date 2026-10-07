use crate::hgrid::HGrid;
use crate::marching_cubes::{march_cube_idx, MeshBuffers};
use crate::poisson_layer::PoissonLayer;
use crate::poisson_vector_field::PoissonVectorField;
use crate::polynomial::{eval_bspline, eval_bspline_diff};
use crate::Real;
use na::{vector, Point3, Vector3};
use parry::bounding_volume::{Aabb, BoundingVolume};
use parry::partitioning::IndexedData;
use parry::shape::{TriMesh, TriMeshFlags};
use crate::fast_hash::FastMap;
use std::ops::{AddAssign, Mul};

/// An implicit surface reconstructed with the Screened Poisson reconstruction algorithm.
#[derive(Clone)]
pub struct PoissonReconstruction {
    layers: Vec<PoissonLayer>,
    isovalue: Real,
}

#[derive(Copy, Clone, PartialEq, Eq)]
pub struct CellWithId {
    pub cell: Point3<i64>,
    pub id: usize,
}

impl IndexedData for CellWithId {
    fn default() -> Self {
        Self {
            cell: Point3::default(),
            id: 0,
        }
    }

    fn index(&self) -> usize {
        self.id
    }
}

impl PoissonReconstruction {
    /// Reconstruct a surface using the Screened Poisson reconstruction algorithm,
    /// given a set of sample points and normals at these points.
    ///
    /// # Parameters
    /// - `points`: the sample points.
    /// - `normals`: the normals at the sample points. Must have the same length as `points`.
    /// - `screening`: the screening coefficient. Larger values increase the fitting of the
    ///   reconstructed surface relative to the sample point’s positions. Setting this to `0.0`
    ///   disables screening (but reduces computation times).
    /// - `density_estimation_depth`: the depth on the multigrid solver where point density estimation
    ///   is calculated. The estimation kernel radius will be equal to the maximum extent of the
    ///   input point’s AABB, divided by `2.pow(max_depth)`. Smaller value of this parameter results
    ///   in more robustness wrt. occasional holes and sampling irregularities, but reduces the
    ///   detail accuracies.
    /// - `max_depth`: the max depth of the multigrid solver. Larger values result in higher accuracy
    ///   (which requires higher sampling densities, or a `density_estimation_depth` set to a smaller
    ///   value). Higher values increases computation times.
    /// - `max_relaxation_iters`: the maximum number of iterations for the internal
    ///   conjugate-gradient solver. Values around `10` should be enough for most cases.
    pub fn from_points_and_normals(
        points: &[Point3<Real>],
        normals: &[Vector3<Real>],
        screening: Real,
        density_estimation_depth: usize,
        max_depth: usize,
        max_relaxation_iters: usize,
    ) -> Self {
        // Convenience wrapper over the staged [`PoissonBuilder`]: build the multigrid
        // octree + vector field, solve every layer, then finalize — all in one go. The
        // staged builder exists so a single-threaded (wasm, rayon-stripped) caller can
        // report progress between multigrid levels; this path just runs them straight
        // through.
        let (recon, _points, _sample_iso) = PoissonBuilder::new(
            points,
            normals,
            screening,
            density_estimation_depth,
            max_depth,
            max_relaxation_iters,
        )
        .finish();
        recon
    }

    /// Every layer's solved node coefficients, coarsest first. Node order is the octree
    /// build order, which is deterministic, so two solves of the same input compare
    /// entry by entry — how a restructured assembly is checked against the one it
    /// replaced. (Vendored patch, test support.)
    #[doc(hidden)]
    pub fn layer_weights(&self) -> Vec<Vec<Real>> {
        self.layers.iter().map(|l| l.node_weights.as_slice().to_vec()).collect()
    }

    /// The domain where the surface’s implicit function is defined.
    pub fn aabb(&self) -> &Aabb {
        self.layers.last().unwrap().cells_qbvh.root_aabb()
    }

    /// Does the given AABB intersect any of the smallest grid cells of the reconstruction?
    pub fn leaf_cells_intersect_aabb(&self, aabb: &Aabb) -> bool {
        let mut intersections = vec![];
        self.layers
            .last()
            .unwrap()
            .cells_qbvh
            .intersect_aabb(aabb, &mut intersections);
        !intersections.is_empty()
    }

    /// Evaluates the value of the implicit function at the given 3D point.
    ///
    /// In order to get a meaningful value, the point must be located inside of [`Self::aabb`].
    pub fn eval(&self, pt: &Point3<Real>) -> Real {
        let mut result = 0.0;

        for layer in &self.layers {
            result += layer.eval_triquadratic(pt);
        }

        result - self.isovalue
    }

    /// Evaluates the value of the implicit function’s gradient at the given 3D point.
    ///
    /// In order to get a meaningful value, the point must be located inside of [`Self::aabb`].
    pub fn eval_gradient(&self, pt: &Point3<Real>) -> Vector3<Real> {
        let mut result = Vector3::zeros();

        for layer in &self.layers {
            result += layer.eval_triquadratic_gradient(pt);
        }

        result
    }

    /// Reconstructs a mesh from this implicit function using a simple marching-cubes, extracting
    /// the isosurface at 0.
    #[deprecated = "use `reconstruct_mesh_buffers` or `reconstruct_trimesh` instead"]
    pub fn reconstruct_mesh(&self) -> Vec<Point3<Real>> {
        self.reconstruct_mesh_buffers().result_as_triangle_soup()
    }

    /// Reconstructs a `TriMesh` from this implicit function using a simple marching-cubes, extracting
    /// the isosurface at 0.
    pub fn reconstruct_trimesh(&self, flags: TriMeshFlags) -> Option<TriMesh> {
        self.reconstruct_mesh_buffers().result(flags)
    }

    /// Reconstructs a mesh from this implicit function using a simple marching-cubes, extracting
    /// the isosurface at 0.
    pub fn reconstruct_mesh_buffers(&self) -> MeshBuffers {
        self.reconstruct_mesh_buffers_iso(0.0)
    }

    /// Like [`Self::reconstruct_mesh_buffers`] but extracts the isosurface at an
    /// arbitrary `iso` level. The screened-Poisson solution's true surface is not the
    /// zero level set but the *average of the implicit function at the input samples*;
    /// extracting at 0 systematically offsets (inflates/deflates) the surface, so the
    /// caller passes that sample-average iso here. (Vendored patch — see crate header.)
    pub fn reconstruct_mesh_buffers_iso(&self, iso: Real) -> MeshBuffers {
        self.reconstruct_mesh_buffers_iso_within(iso, &|_| true)
    }

    /// The width of one leaf (finest-layer) cell. Callers sizing a bound for
    /// [`Self::reconstruct_mesh_buffers_iso_within`] need it. (Vendored patch.)
    pub fn leaf_cell_width(&self) -> Real {
        self.layers.last().map_or(0.0, |l| l.cell_width())
    }

    /// Like [`Self::reconstruct_mesh_buffers_iso`], but stops the isosurface walk from
    /// entering cells whose centre fails `in_bounds`. (Vendored patch.)
    ///
    /// After seeding from the octree leaves, extraction floods outward through every
    /// neighbouring cell that shows a sign change. The Poisson solution is defined over
    /// all space — the coarse layers' basis functions have support far wider than the
    /// data — so that walk chases extrapolated sheets a long way past the samples: on a
    /// 129k-node depth-7 octree it visited 17.4M cells, 134× the data, and made
    /// extraction the slowest phase of the pipeline. A caller that is going to discard
    /// far-from-data triangles anyway can say so here and skip generating them.
    ///
    /// The predicate must be *conservative*: it takes a cell centre and must accept any
    /// cell that could contain a triangle the caller intends to keep. A cell's triangles
    /// lie within its AABB, so a keep-radius `r` around the samples means passing
    /// `r + half the cell diagonal` here.
    pub fn reconstruct_mesh_buffers_iso_within(
        &self,
        iso: Real,
        in_bounds: &dyn Fn(&Point3<Real>) -> bool,
    ) -> MeshBuffers {
        let mut result = MeshBuffers::default();
        let mut visited: FastMap<Point3<i64>, bool> = FastMap::default();
        // Corner cache (vendored patch): every cube corner is shared by up to 8
        // neighbouring cells, and one `eval` sums a tri-quadratic over ~27 nodes of
        // *every* layer — the single most expensive thing in extraction. Corners sit
        // exactly on the leaf lattice (cell centre ± half a width), so rounding
        // `(corner − origin) / width` recovers an exact integer key to memoize on.
        // Upstream left this as a `PERF:` note.
        let mut corners: FastMap<Point3<i64>, Real> = FastMap::default();

        if let Some(last_layer) = self.layers.last() {
            let grid_origin = *last_layer.grid.origin();
            let leaf_width = last_layer.grid.cell_width();
            // Check all the existing leaves.
            let mut eval_cell = |key: Point3<i64>,
                                 visited: &mut FastMap<Point3<i64>, bool>,
                                 corners: &mut FastMap<Point3<i64>, Real>| {
                let cell_center = last_layer.grid.cell_center(&key);
                let cell_width = Vector3::repeat(last_layer.grid.cell_width() / 2.0);
                let aabb = Aabb::from_half_extents(cell_center, cell_width);
                let mut vertex_values = [0.0; 8];

                for (pt, val) in aabb.vertices().iter().zip(vertex_values.iter_mut()) {
                    let corner_key = Point3::from(
                        (pt - grid_origin).map(|e| (e / leaf_width).round() as i64),
                    );
                    *val = *corners.entry(corner_key).or_insert_with(|| self.eval(pt));
                }

                let len_before = result.indices().len();
                march_cube_idx(
                    &aabb,
                    &vertex_values,
                    key.cast::<i32>().into(),
                    iso,
                    &mut result,
                );
                let has_sign_change = result.indices().len() != len_before;
                visited.insert(key, has_sign_change);
                has_sign_change
            };

            for cell in last_layer.cells_qbvh.raw_proxies() {
                // let aabb = last_layer.cells_qbvh.node_aabb(cell.node).unwrap();
                eval_cell(cell.data.cell, &mut visited, &mut corners);
            }

            // Checking only the leaves isn’t enough, isosurfaces might escape leaves through levels
            // at a coarser level. So we also check adjacent leaves that experienced a sign change.
            // PERF: instead of traversing ALL the adjacent leaves, only traverse the ones adjacent
            //       to an edge that actually experienced a sign change.
            // PERF: don’t re-evaluate vertices that were already evaluated.
            let mut stack: Vec<_> = visited
                .iter()
                .filter(|(_key, sign_change)| **sign_change)
                .map(|e| *e.0)
                .collect();

            while let Some(cell) = stack.pop() {
                for i in -1..=1 {
                    for j in -1..=1 {
                        for k in -1..=1 {
                            let new_cell = cell + Vector3::new(i, j, k);

                            if !visited.contains_key(&new_cell) {
                                // Don't chase the isosurface into regions the caller is
                                // going to discard anyway (vendored patch — see
                                // `reconstruct_mesh_buffers_iso_within`).
                                if !in_bounds(&last_layer.grid.cell_center(&new_cell)) {
                                    continue;
                                }
                                let has_sign_change =
                                    eval_cell(new_cell, &mut visited, &mut corners);
                                if has_sign_change {
                                    stack.push(new_cell);
                                }
                            }
                        }
                    }
                }
            }
        }

        result
    }
}

/// Staged driver for the Screened Poisson solve. [`PoissonReconstruction::from_points_and_normals`]
/// runs build → per-layer solve → finish in one call; this type exposes those phases
/// separately so a caller that cannot use threads (the wasm build strips rayon) can
/// report progress between multigrid levels and keep the largest uninterruptible unit
/// of work down to a single layer solve.
pub struct PoissonBuilder {
    layers: Vec<PoissonLayer>,
    vector_field: PoissonVectorField,
    points: Vec<Point3<Real>>,
    normals: Vec<Vector3<Real>>,
    screening: Real,
    max_relaxation_iters: usize,
    next_layer: usize,
    // Σ of the solved layers' implicit function at each sample (vendored patch — see
    // the screening note in `PoissonLayer::solve`).
    coarse_at_points: Vec<Real>,
    // Every solved layer's solution in the next layer's basis (vendored patch — see
    // `PoissonLayer::prolong`).
    prolonged: FastMap<Point3<i64>, Real>,
}

impl PoissonBuilder {
    /// Build the multigrid octree layers and the Poisson vector field. No layer is
    /// solved yet; call [`Self::solve_step`] `num_layers()` times, or [`Self::finish`]
    /// (which solves any remaining layers).
    pub fn new(
        points: &[Point3<Real>],
        normals: &[Vector3<Real>],
        screening: Real,
        density_estimation_depth: usize,
        max_depth: usize,
        max_relaxation_iters: usize,
    ) -> Self {
        assert_eq!(
            points.len(),
            normals.len(),
            "Exactly one normal per point must be provided."
        );
        assert!(density_estimation_depth <= max_depth);
        let mut root_aabb = Aabb::from_points(points);
        let max_extent = root_aabb.extents().max();
        let leaf_cell_width = max_extent / (2.0 as Real).powi(max_depth as i32);
        root_aabb.loosen(leaf_cell_width);
        let grid_origin = root_aabb.mins;

        let mut layers = vec![];
        layers.push(PoissonLayer::from_points(points, grid_origin, leaf_cell_width));

        for i in 0..max_depth {
            let layer = PoissonLayer::from_next_layer(points, &layers[i]);
            layers.push(layer);
        }

        // Reverse so the coarser layers go first.
        layers.reverse();

        let vector_field =
            PoissonVectorField::new(&layers, points, normals, density_estimation_depth);

        Self {
            layers,
            vector_field,
            points: points.to_vec(),
            normals: normals.to_vec(),
            screening,
            max_relaxation_iters,
            next_layer: 0,
            coarse_at_points: vec![0.0; points.len()],
            prolonged: FastMap::default(),
        }
    }

    /// Number of multigrid layers (`== max_depth + 1`).
    pub fn num_layers(&self) -> usize {
        self.layers.len()
    }

    /// Solve the next unsolved multigrid layer (coarsest first). Returns `true` while
    /// more layers remain to be solved, `false` once the last layer has been solved.
    pub fn solve_step(&mut self) -> bool {
        if self.next_layer >= self.layers.len() {
            return false;
        }
        let i = self.next_layer;
        let result = PoissonLayer::solve(
            &self.layers,
            i,
            &self.vector_field,
            &self.points,
            &self.normals,
            self.screening,
            self.max_relaxation_iters,
            &self.coarse_at_points,
            &self.prolonged,
        );
        self.layers[i].node_weights = result;
        self.next_layer += 1;
        // Only the screening term reads it, and only for a layer still to come.
        if self.screening != 0.0 && self.next_layer < self.layers.len() {
            let layer = &self.layers[i];
            for (acc, pt) in self.coarse_at_points.iter_mut().zip(&self.points) {
                *acc += layer.eval_triquadratic(pt);
            }
        }
        if self.next_layer < self.layers.len() {
            self.prolonged =
                PoissonLayer::prolong(&self.layers[i + 1], &self.layers[i], &self.prolonged);
        }
        self.next_layer < self.layers.len()
    }

    /// Solve any remaining layers, compute the density-weighted isovalue, and return the
    /// reconstruction together with the input points (the caller needs them to trim far
    /// triangles) and the **sample-average iso level** to extract at.
    ///
    /// That last value is the vendored patch: the caller wants the plain (unweighted)
    /// average of the implicit function over the input samples, and used to obtain it
    /// with a second full `eval` pass over every point — the same ~27-nodes-per-layer
    /// evaluation this loop is already doing. It is accumulated here instead, in the
    /// pass that has to happen anyway. Returned already expressed relative to
    /// `isovalue`, so it can go straight to [`PoissonReconstruction::
    /// reconstruct_mesh_buffers_iso`].
    pub fn finish(self) -> (PoissonReconstruction, Vec<Point3<Real>>, Real) {
        self.finish_weighted(&[])
    }

    /// [`Self::finish`] with a per-sample **support weight** for the sample-average iso
    /// (vendored patch). `weights[i]` is how many raw points sample `i` stands for after
    /// the caller's voxel subsample; empty means every sample weighs 1, which is exactly
    /// `finish`. Without it a few hundred stray single-point samples count as much as
    /// the well-supported surface samples and pull the extraction level off the surface.
    /// Accumulated in the same pass that already evaluates every sample.
    pub fn finish_weighted(
        mut self,
        weights: &[Real],
    ) -> (PoissonReconstruction, Vec<Point3<Real>>, Real) {
        while self.solve_step() {}

        let mut result = PoissonReconstruction {
            layers: self.layers,
            isovalue: 0.0,
        };
        let mut isovalue = 0.0;
        let mut total_weight = 0.0;
        let mut support_sum = 0.0;
        let mut support_total = 0.0;
        for (i, (pt, w)) in self.points.iter().zip(self.vector_field.densities.iter()).enumerate() {
            // `isovalue` is still 0 here, so this is the raw implicit function.
            let value = result.eval(pt);
            isovalue += value / *w;
            total_weight += 1.0 / *w;
            let s = weights.get(i).copied().unwrap_or(1.0);
            support_sum += value * s;
            support_total += s;
        }
        result.isovalue = if total_weight != 0.0 {
            isovalue / total_weight
        } else {
            0.0
        };
        let sample_iso = if support_total > 0.0 {
            support_sum / support_total - result.isovalue
        } else {
            0.0
        };
        (result, self.points, sample_iso)
    }
}

pub fn eval_triquadratic<T: Mul<Real, Output = T> + AddAssign + Copy + Default>(
    pt: &Point3<Real>,
    grid: &HGrid<usize>,
    grid_node_idx: &FastMap<Point3<i64>, usize>,
    node_weights: &[T],
) -> T {
    let cell_width = grid.cell_width();
    let ref_cell = grid.key(pt);
    let mut result = T::default();

    for i in -1..=1 {
        for j in -1..=1 {
            for k in -1..=1 {
                let curr_cell = ref_cell + vector![i, j, k];

                if let Some(node_id) = grid_node_idx.get(&curr_cell) {
                    let spline_origin = grid.cell_center(&curr_cell);
                    let valx = eval_bspline(pt.x, spline_origin.x, cell_width);
                    let valy = eval_bspline(pt.y, spline_origin.y, cell_width);
                    let valz = eval_bspline(pt.z, spline_origin.z, cell_width);
                    result += node_weights[*node_id] * valx * valy * valz;
                }
            }
        }
    }

    result
}

pub fn eval_triquadratic_gradient(
    pt: &Point3<Real>,
    grid: &HGrid<usize>,
    grid_node_idx: &FastMap<Point3<i64>, usize>,
    node_weights: &[Real],
) -> Vector3<Real> {
    let cell_width = grid.cell_width();
    let ref_cell = grid.key(pt);
    let mut result = Vector3::default();

    for i in -1..=1 {
        for j in -1..=1 {
            for k in -1..=1 {
                let curr_cell = ref_cell + vector![i, j, k];

                if let Some(node_id) = grid_node_idx.get(&curr_cell) {
                    let spline_origin = grid.cell_center(&curr_cell);

                    let valx = eval_bspline(pt.x, spline_origin.x, cell_width);
                    let valy = eval_bspline(pt.y, spline_origin.y, cell_width);
                    let valz = eval_bspline(pt.z, spline_origin.z, cell_width);

                    let diffx = eval_bspline_diff(pt.x, spline_origin.x, cell_width);
                    let diffy = eval_bspline_diff(pt.y, spline_origin.y, cell_width);
                    let diffz = eval_bspline_diff(pt.z, spline_origin.z, cell_width);

                    result += Vector3::new(
                        diffx * valy * valz,
                        valx * diffy * valz,
                        valx * valy * diffz,
                    ) * node_weights[*node_id];
                }
            }
        }
    }

    result
}
