use crate::poisson_layer::PoissonLayer;
use crate::polynomial::TriQuadraticBspline;
use crate::{poisson, Real};
use itertools::multizip;
use na::{vector, DVector, Point3, Vector3};
use parry::bounding_volume::Aabb;

const CORNERS: [Vector3<i64>; 8] = [
    vector![0, 0, 0],
    vector![1, 0, 0],
    vector![1, 1, 0],
    vector![0, 1, 0],
    vector![0, 0, 1],
    vector![1, 0, 1],
    vector![1, 1, 1],
    vector![0, 1, 1],
];

fn trilinear_coefficients(bcoords: Vector3<Real>) -> [Real; 8] {
    let map = |vals: Vector3<i64>| {
        vals.zip_map(&bcoords, |v, b| if v == 0 { 1.0 - b } else { b })
            .product()
    };

    [
        map(CORNERS[0]),
        map(CORNERS[1]),
        map(CORNERS[2]),
        map(CORNERS[3]),
        map(CORNERS[4]),
        map(CORNERS[5]),
        map(CORNERS[6]),
        map(CORNERS[7]),
    ]
}

pub struct PoissonVectorField {
    pub(crate) densities: Vec<Real>,
    layers_normals: Vec<Vec<Vector3<Real>>>,
    /// Per layer, the node ids that actually received a normal splat. Every other node
    /// contributes nothing to the right-hand side, and there are at most 8 of these per
    /// input sample across all layers (one trilinear splat = 8 corners) — which is what
    /// lets [`Self::build_rhs`] iterate sources instead of probing for them. (Vendored
    /// patch — see crate header.)
    nonzero_normals: Vec<Vec<usize>>,
}

impl PoissonVectorField {
    pub fn new(
        layers: &[PoissonLayer],
        points: &[Point3<Real>],
        normals: &[Vector3<Real>],
        density_estimation_depth: usize,
    ) -> Self {
        // Compute sample densities.
        let mut densities = vec![1.0; points.len()];
        let density_layer = &layers[density_estimation_depth];
        let mut splat_values = vec![0.0; density_layer.ordered_nodes.len()];

        for pt in points {
            let half_width = Vector3::repeat(density_layer.cell_width() / 2.0);
            // Subtract half-width so the ref_node is the bottom-left node of the trilinear interpolation.
            let ref_node = density_layer.grid.key(&(pt - half_width));

            // Barycentric coordinates of the points for trilinear interpolation.
            let cell_origin = density_layer.grid.cell_center(&ref_node);
            let bcoords = (pt - cell_origin) / density_layer.cell_width();
            let coeffs = trilinear_coefficients(bcoords);

            for (corner_shift, coeff) in CORNERS.iter().zip(coeffs.iter()) {
                let node = ref_node + corner_shift;
                let id = density_layer.grid_node_idx[&node];
                splat_values[id] += *coeff;
            }
        }

        for (pt, weight) in points.iter().zip(densities.iter_mut()) {
            *weight = poisson::eval_triquadratic(
                pt,
                &density_layer.grid,
                &density_layer.grid_node_idx,
                &splat_values,
            );
        }

        let avg_density = densities.iter().copied().sum::<Real>() / (points.len() as Real);
        let samples_depths: Vec<_> = densities
            .iter()
            .map(|d| {
                (((layers.len() - 1) as Real + (*d / avg_density).log(4.0))
                    .round()
                    .max(0.0) as usize)
                    .min(layers.len() - 1)
            })
            .collect();

        let mut layers_normals = vec![];

        for (layer_id, layer) in layers.iter().enumerate() {
            // Splat the normals into the grid.
            let mut grid_normals = vec![Vector3::zeros(); layer.ordered_nodes.len()];

            for (pt, n, w, depth) in multizip((points, normals, &densities, &samples_depths)) {
                if *depth == layer_id {
                    let half_width = Vector3::repeat(layer.grid.cell_width() / 2.0);
                    let ref_node = layer.grid.key(&(pt - half_width));

                    // Barycentric coordinates of the points for trilinear interpolation.
                    let cell_origin = layer.grid.cell_center(&ref_node);
                    let bcoords = (pt - cell_origin) / layer.grid.cell_width();
                    let coeffs = trilinear_coefficients(bcoords);

                    for (corner_shift, coeff) in CORNERS.iter().zip(coeffs.iter()) {
                        let node = ref_node + corner_shift;
                        let id = layer.grid_node_idx[&node];
                        grid_normals[id] += *n * *coeff / *w;
                    }
                }
            }

            layers_normals.push(grid_normals);
        }

        let nonzero_normals = layers_normals
            .iter()
            .map(|normals| {
                normals
                    .iter()
                    .enumerate()
                    .filter(|(_, n)| **n != Vector3::zeros())
                    .map(|(id, _)| id)
                    .collect()
            })
            .collect();

        Self {
            densities,
            layers_normals,
            nonzero_normals,
        }
    }

    /// Accumulate the vector field's divergence against every node of `curr_layer`.
    ///
    /// **Vendored patch — scatter, not gather.** The original walked, for every node of
    /// `curr_layer` and every other layer, the cells of an AABB in that layer's grid.
    /// [`HGrid::cells_intersecting_aabb`] iterates every *integer cell in the coordinate
    /// range* and only filters to occupied cells afterwards, so its cost is the box
    /// VOLUME, not the occupancy. With a coarse `curr_layer` against the finest layer
    /// that box spans `3·2^max_depth + 3` cells per axis — 771³ ≈ 4.6e8 hash probes per
    /// node at depth 8, and 8× that per extra depth level. It dominated everything else
    /// by orders of magnitude and is why a depth-8 mesh took hours.
    ///
    /// The non-zero entries of `layers_normals` are the only sources that can contribute,
    /// and there are at most 8 per input sample, so we iterate *those* and scatter into
    /// the nodes they reach. Whichever enumeration of the target nodes is cheaper wins:
    /// the grid range when it is small (the usual case — a fine source into a coarse
    /// layer touches ~4³ cells), else a linear scan of the layer's own node list.
    ///
    /// This is an exact restructuring, not an approximation: [`TriQuadraticBspline::
    /// grad_grad`] returns zero as soon as the two supports are disjoint along any axis,
    /// so both formulations enumerate a superset of the same non-zero node pairs. Only
    /// the floating-point summation order changes.
    pub fn build_rhs(
        &self,
        layers: &[PoissonLayer],
        curr_layer_id: usize,
        rhs: &mut DVector<Real>,
    ) {
        let curr_layer = &layers[curr_layer_id];
        let curr_width = curr_layer.cell_width();

        for (other_layer_id, other_layer) in layers.iter().enumerate() {
            let other_width = other_layer.cell_width();
            let reach = Vector3::repeat(curr_width * 1.5 + other_width * 1.5);

            for &other_node_id in &self.nonzero_normals[other_layer_id] {
                let normal = self.layers_normals[other_layer_id][other_node_id];
                let other_node = other_layer.ordered_nodes[other_node_id];
                let other_node_center = other_layer.grid.cell_center(&other_node);
                let poly1 = TriQuadraticBspline::new(other_node_center, other_width);
                let aabb = Aabb::from_half_extents(other_node_center, reach);

                let mut accumulate = |curr_node_center: Point3<Real>, rhs_id: usize| {
                    let poly2 = TriQuadraticBspline::new(curr_node_center, curr_width);
                    let coeff = poly1.grad_grad(poly2, false, true);
                    rhs[rhs_id] += normal.dot(&coeff);
                };

                if curr_layer.range_is_cheaper_than_scan(&aabb.mins, &aabb.maxs) {
                    for (curr_node, _) in
                        curr_layer.grid.cells_intersecting_aabb(&aabb.mins, &aabb.maxs)
                    {
                        // A grid cell is not necessarily a node (points live in the same
                        // grid), so look up rather than index.
                        if let Some(&rhs_id) = curr_layer.grid_node_idx.get(&curr_node) {
                            accumulate(curr_layer.grid.cell_center(&curr_node), rhs_id);
                        }
                    }
                } else {
                    // The source is much coarser than this layer, so its reach spans a
                    // huge cell range. Walking the node list is then the cheaper way to
                    // find the same overlaps.
                    for (rhs_id, curr_node) in curr_layer.ordered_nodes.iter().enumerate() {
                        let curr_node_center = curr_layer.grid.cell_center(curr_node);
                        let d = curr_node_center - other_node_center;
                        if d.x.abs() < reach.x && d.y.abs() < reach.y && d.z.abs() < reach.z {
                            accumulate(curr_node_center, rhs_id);
                        }
                    }
                }
            }
        }
    }

    pub fn area_approximation(&self) -> Real {
        self.densities.iter().map(|d| 1.0 / *d).sum()
    }
}
