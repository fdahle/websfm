use crate::conjugate_gradient::solve_conjugate_gradient;
use crate::hgrid::HGrid;
use crate::poisson_vector_field::PoissonVectorField;
use crate::polynomial::TriQuadraticBspline;
use crate::{
    poisson::{self, CellWithId},
    polynomial, Real,
};
use na::{vector, DVector, Point3, Vector3};
use nalgebra_sparse::{CooMatrix, CscMatrix};
use parry::bounding_volume::Aabb;
use parry::partitioning::Qbvh;
use std::collections::HashMap;

#[derive(Clone)]
pub struct PoissonLayer {
    pub grid: HGrid<usize>,
    pub cells_qbvh: Qbvh<CellWithId>,
    pub grid_node_idx: HashMap<Point3<i64>, usize>,
    pub ordered_nodes: Vec<Point3<i64>>,
    pub node_weights: DVector<Real>,
}

impl PoissonLayer {
    pub fn cell_width(&self) -> Real {
        self.grid.cell_width()
    }

    /// Would enumerating this layer's cells over the `[mins, maxs]` lattice range cost
    /// less than a linear scan of its node list? `HGrid::cells_intersecting_aabb` walks
    /// every integer cell in the range (one hash probe each) regardless of how few are
    /// occupied, so a box far larger than the cell width is better answered by scanning.
    /// (Vendored patch — see the note on `PoissonVectorField::build_rhs`.)
    pub(crate) fn range_is_cheaper_than_scan(
        &self,
        mins: &Point3<Real>,
        maxs: &Point3<Real>,
    ) -> bool {
        let start = self.grid.key(mins);
        let end = self.grid.key(maxs);
        let mut volume: u128 = 1;
        for dim in 0..3 {
            volume *= (end[dim] - start[dim] + 1).max(0) as u128;
        }
        volume <= self.ordered_nodes.len() as u128
    }
}

impl PoissonLayer {
    pub fn from_points(
        points: &[Point3<Real>],
        grid_origin: Point3<Real>,
        cell_width: Real,
    ) -> Self {
        let mut grid = HGrid::new(grid_origin, cell_width);
        let mut grid_node_idx = HashMap::new();
        let mut ordered_nodes = vec![];

        // for pt in points {
        //     let ref_node = grid.key(pt);
        //
        //     for corner_shift in CORNERS.iter() {
        //         let node = ref_node + corner_shift;
        //         let _ = grid_node_idx.entry(node).or_insert_with(|| {
        //             let center = grid.cell_center(&node);
        //             grid.insert(&center, 0);
        //             ordered_nodes.push(node);
        //             ordered_nodes.len() - 1
        //         });
        //     }
        // }

        // TODO: do we still need this when using the multigrid solver?
        for (pid, pt) in points.iter().enumerate() {
            let ref_node = grid.key(pt);
            let ref_center = grid.cell_center(&ref_node);
            grid.insert(&ref_center, pid);

            for i in -2..=2 {
                for j in -2..=2 {
                    for k in -2..=2 {
                        let node = ref_node + vector![i, j, k];
                        let center = grid.cell_center(&node);
                        let _ = grid_node_idx.entry(node).or_insert_with(|| {
                            grid.insert(&center, usize::MAX);
                            ordered_nodes.push(node);
                            ordered_nodes.len() - 1
                        });
                    }
                }
            }
        }

        Self::from_populated_grid(grid, grid_node_idx, ordered_nodes)
    }

    pub fn from_next_layer(points: &[Point3<Real>], layer: &Self) -> Self {
        let cell_width = layer.cell_width() * 2.0;
        let mut grid = HGrid::new(*layer.grid.origin(), cell_width);
        let mut grid_node_idx = HashMap::new();
        let mut ordered_nodes = vec![];

        // Add nodes to the new grid to form a comforming "octree".
        for sub_node_key in &layer.ordered_nodes {
            let pt = layer.grid.cell_center(sub_node_key);
            let my_key = grid.key(&pt);
            let my_center = grid.cell_center(&my_key);
            let quadrant = pt - my_center;

            let range = |x| {
                if x < 0.0 {
                    -2..=1
                } else {
                    -1..=2
                }
            };

            for i in range(quadrant.x) {
                for j in range(quadrant.y) {
                    for k in range(quadrant.z) {
                        let adj_key = my_key + vector![i, j, k];

                        let _ = grid_node_idx.entry(adj_key).or_insert_with(|| {
                            let adj_center = grid.cell_center(&adj_key);
                            grid.insert(&adj_center, usize::MAX);
                            ordered_nodes.push(adj_key);
                            ordered_nodes.len() - 1
                        });
                    }
                }
            }
        }

        for (pid, pt) in points.iter().enumerate() {
            let ref_node = grid.key(pt);
            let ref_center = grid.cell_center(&ref_node);
            grid.insert(&ref_center, pid);
        }

        Self::from_populated_grid(grid, grid_node_idx, ordered_nodes)
    }

    fn from_populated_grid(
        grid: HGrid<usize>,
        grid_node_idx: HashMap<Point3<i64>, usize>,
        ordered_nodes: Vec<Point3<i64>>,
    ) -> Self {
        let cell_width = grid.cell_width();
        let mut cells_qbvh = Qbvh::new();
        cells_qbvh.clear_and_rebuild(
            ordered_nodes.iter().map(|key| {
                let center = grid.cell_center(key);
                let id = grid_node_idx[key];
                let half_width = Vector3::repeat(cell_width / 2.0);
                (
                    CellWithId { cell: *key, id },
                    Aabb::from_half_extents(center, half_width),
                )
            }),
            0.0,
        );

        let node_weights = DVector::zeros(grid_node_idx.len());

        Self {
            grid,
            cells_qbvh,
            ordered_nodes,
            grid_node_idx,
            node_weights,
        }
    }

    pub(crate) fn solve(
        layers: &[Self],
        curr_layer: usize,
        vector_field: &PoissonVectorField,
        points: &[Point3<Real>],
        normals: &[Vector3<Real>],
        screening: Real,
        niters: usize,
    ) -> DVector<Real> {
        let my_layer = &layers[curr_layer];
        let cell_width = my_layer.cell_width();
        assert_eq!(points.len(), normals.len());
        let convolution = polynomial::compute_quadratic_bspline_convolution_coeffs(cell_width);
        let num_nodes = my_layer.ordered_nodes.len();

        // Compute the gradient matrix.
        let mut grad_matrix = CooMatrix::new(num_nodes, num_nodes);
        let screen_factor =
            (2.0 as Real).powi(curr_layer as i32) * screening * vector_field.area_approximation()
                / (points.len() as Real);

        // Screening scratch (vendored patch): the points near the node currently being
        // assembled, each carrying the separable B-spline factors of the whole ±2
        // stencil. The original re-scanned the 27 neighbouring cells and rebuilt both
        // splines inside the stencil loop — paying the point gather 125× per node and
        // two full tri-quadratic evaluations per (neighbour, point). A tri-quadratic
        // B-spline is a product of three one-dimensional ones, so 15 evaluations per
        // point cover every stencil neighbour at once: the factor for offset (i,j,k) is
        // bx[i+2]·by[j+2]·bz[k+2]. Same arithmetic, ~20× fewer spline evaluations and
        // one gather per node instead of 125.
        struct ScreenPoint {
            at_node: Real, // the assembled node's own basis at this point
            bx: [Real; 5], // per-axis basis of the stencil offsets -2..=2
            by: [Real; 5],
            bz: [Real; 5],
        }
        let mut screen_stencil: Vec<ScreenPoint> = Vec::new();

        for (nid, node) in my_layer.ordered_nodes.iter().enumerate() {
            if screening != 0.0 {
                // Stencil-neighbour centres per axis. Read from the grid rather than
                // formed as center1 + offset·width so they stay bit-identical to the
                // centres the original built inside the stencil loop.
                let mut cx = [0.0; 5];
                let mut cy = [0.0; 5];
                let mut cz = [0.0; 5];
                for t in 0..5 {
                    let d = t as i64 - 2;
                    cx[t] = my_layer.grid.cell_center(&(node + vector![d, 0, 0])).x;
                    cy[t] = my_layer.grid.cell_center(&(node + vector![0, d, 0])).y;
                    cz[t] = my_layer.grid.cell_center(&(node + vector![0, 0, d])).z;
                }

                screen_stencil.clear();
                for si in -1..=1 {
                    for sj in -1..=1 {
                        for sk in -1..=1 {
                            let adj = node + vector![si, sj, sk];
                            let Some(pt_ids) = my_layer.grid.cell(&adj) else {
                                continue;
                            };
                            for pid in pt_ids {
                                // Use get to ignore the sentinel.
                                let Some(pt) = points.get(*pid) else {
                                    continue;
                                };
                                let mut bx = [0.0; 5];
                                let mut by = [0.0; 5];
                                let mut bz = [0.0; 5];
                                for t in 0..5 {
                                    bx[t] = polynomial::eval_bspline(pt.x, cx[t], cell_width);
                                    by[t] = polynomial::eval_bspline(pt.y, cy[t], cell_width);
                                    bz[t] = polynomial::eval_bspline(pt.z, cz[t], cell_width);
                                }
                                let at_node = bx[2] * by[2] * bz[2];
                                // Zero here zeroes every product this point appears in.
                                if at_node != 0.0 {
                                    screen_stencil.push(ScreenPoint { at_node, bx, by, bz });
                                }
                            }
                        }
                    }
                }
            }

            for i in -2..=2 {
                for j in -2..=2 {
                    for k in -2..=2 {
                        let other_node = node + vector![i, j, k];

                        if let Some(other_nid) = my_layer.grid_node_idx.get(&other_node) {
                            let ii = (i + 2) as usize;
                            let jj = (j + 2) as usize;
                            let kk = (k + 2) as usize;

                            let mut laplacian = convolution.laplacian[ii][jj][kk];

                            for p in &screen_stencil {
                                laplacian +=
                                    screen_factor * p.at_node * (p.bx[ii] * p.by[jj] * p.bz[kk]);
                            }

                            grad_matrix.push(nid, *other_nid, laplacian);
                        }
                    }
                }
            }
        }

        // Build rhs
        let mut rhs = DVector::zeros(my_layer.ordered_nodes.len());
        vector_field.build_rhs(layers, curr_layer, &mut rhs);

        // Subtract the results from the coarser layers.
        //
        // Screening scratch (vendored patch): which points sit near this node, and this
        // node's own basis at each of them, do not depend on *which* coarser node is
        // being subtracted — but the original re-gathered the 27 cells and re-evaluated
        // `poly1` inside that loop. Gather once per node instead.
        let mut screen_coarse: Vec<(Point3<Real>, Real)> = Vec::new();

        for rhs_id in 0..my_layer.ordered_nodes.len() {
            let node_key = my_layer.ordered_nodes[rhs_id];
            let node_center = my_layer.grid.cell_center(&node_key);
            let poly1 = TriQuadraticBspline::new(node_center, my_layer.cell_width());

            if screening != 0.0 && curr_layer > 0 {
                screen_coarse.clear();
                for si in -1..=1 {
                    for sj in -1..=1 {
                        for sk in -1..=1 {
                            let adj = node_key + vector![si, sj, sk];
                            let Some(pt_ids) = my_layer.grid.cell(&adj) else {
                                continue;
                            };
                            for pid in pt_ids {
                                // Use get to ignore the sentinel.
                                let Some(pt) = points.get(*pid) else {
                                    continue;
                                };
                                let at_node = poly1.eval(*pt);
                                // Zero here zeroes every product this point appears in.
                                if at_node != 0.0 {
                                    screen_coarse.push((*pt, at_node));
                                }
                            }
                        }
                    }
                }
            }

            for coarser_layer in &layers[0..curr_layer] {
                let aabb = Aabb::from_half_extents(
                    node_center,
                    Vector3::repeat(
                        my_layer.cell_width() * 1.5 + coarser_layer.cell_width() * 1.5,
                    ),
                );

                for (coarser_node_key, _) in coarser_layer
                    .grid
                    .cells_intersecting_aabb(&aabb.mins, &aabb.maxs)
                {
                    let coarser_node_center = coarser_layer.grid.cell_center(&coarser_node_key);
                    let poly2 =
                        TriQuadraticBspline::new(coarser_node_center, coarser_layer.cell_width());
                    let mut coeff = poly1.grad_grad(poly2, true, true).sum();
                    let coarser_rhs_id = coarser_layer.grid_node_idx[&coarser_node_key];

                    for (pt, at_node) in &screen_coarse {
                        coeff += screen_factor * *at_node * poly2.eval(*pt);
                    }

                    rhs[rhs_id] -= coarser_layer.node_weights[coarser_rhs_id] * coeff;
                }
            }
        }

        // Solve the sparse system.
        let lhs = CscMatrix::from(&grad_matrix);
        solve_conjugate_gradient(&lhs, &mut rhs, niters);
        // let chol = CscCholesky::factor(&lhs).unwrap();
        // chol.solve_mut(&mut rhs);

        rhs
    }

    pub fn eval_triquadratic(&self, pt: &Point3<Real>) -> Real {
        poisson::eval_triquadratic(
            pt,
            &self.grid,
            &self.grid_node_idx,
            self.node_weights.as_slice(),
        )
    }

    pub fn eval_triquadratic_gradient(&self, pt: &Point3<Real>) -> Vector3<Real> {
        poisson::eval_triquadratic_gradient(
            pt,
            &self.grid,
            &self.grid_node_idx,
            self.node_weights.as_slice(),
        )
    }
}
