use crate::conjugate_gradient::solve_conjugate_gradient;
use crate::hgrid::HGrid;
use crate::poisson_vector_field::PoissonVectorField;
use crate::polynomial::OverlapTable;
use crate::{
    poisson::{self, CellWithId},
    polynomial, Real,
};
use na::{vector, DVector, Point3, Vector3};
use nalgebra_sparse::CscMatrix;
use parry::bounding_volume::Aabb;
use parry::partitioning::Qbvh;
use crate::fast_hash::FastMap;

#[derive(Clone)]
pub struct PoissonLayer {
    pub grid: HGrid<usize>,
    pub cells_qbvh: Qbvh<CellWithId>,
    pub grid_node_idx: FastMap<Point3<i64>, usize>,
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
        let mut grid_node_idx = FastMap::default();
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
        let mut grid_node_idx = FastMap::default();
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
        grid_node_idx: FastMap<Point3<i64>, usize>,
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
        // The coarser layers' solution at each point (Σ over layers < curr_layer of
        // `eval_triquadratic`), for the screening half of the coarse subtraction.
        coarse_at_points: &[Real],
        // The coarser layers' solution in this layer's basis, at every lattice point within
        // ±2 of a node ([`Self::prolong`]); empty for the coarsest layer.
        prolonged: &FastMap<Point3<i64>, Real>,
    ) -> DVector<Real> {
        let my_layer = &layers[curr_layer];
        let cell_width = my_layer.cell_width();
        assert_eq!(points.len(), normals.len());
        let convolution = polynomial::compute_quadratic_bspline_convolution_coeffs(cell_width);
        let num_nodes = my_layer.ordered_nodes.len();

        // Compute the gradient matrix, straight into CSC. (Vendored patch.) The matrix is
        // symmetric — Laplacian stencil plus the screening sum Σ_p B_n(p)·B_m(p), both
        // symmetric in (n, m) up to the order of the multiplies — so the row assembled for
        // node `nid` is also its column, in node order. Upstream pushed every entry into a
        // COO triplet list and converted: at depth 8 that was 51 M triplets (~1.2 GB)
        // plus a full CSC copy, the solve's peak memory, and ~3 s of sorting.
        let mut col_offsets: Vec<usize> = Vec::with_capacity(num_nodes + 1);
        let mut row_indices: Vec<usize> = Vec::new();
        let mut values: Vec<Real> = Vec::new();
        col_offsets.push(0);
        let mut row: Vec<(usize, Real)> = Vec::with_capacity(125);
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

        for node in my_layer.ordered_nodes.iter() {
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

                            row.push((*other_nid, laplacian));
                        }
                    }
                }
            }
            row.sort_unstable_by_key(|e| e.0);
            for &(j, v) in &row {
                row_indices.push(j);
                values.push(v);
            }
            row.clear();
            col_offsets.push(row_indices.len());
        }

        // Build rhs
        let mut rhs = DVector::zeros(my_layer.ordered_nodes.len());
        vector_field.build_rhs(layers, curr_layer, &mut rhs);

        // Subtract the results from the coarser layers: rhs_n −= Σ_m x_m·A_nm over every
        // coarser node m, where A_nm = ⟨∇B_n, ∇B_m⟩ + screen·Σ_p B_n(p)·B_m(p).
        //
        // (Vendored patch — two exact restructurings of that sum. Measured on a 65k-point
        // depth-8 terrain, the original spent 149 s of a 268 s solve in this loop.)
        // 1. The screening half is Σ_p B_n(p) · Σ_m x_m B_m(p), and the inner sum is just
        //    the coarser layers' solution evaluated at p — the caller accumulates it once
        //    per point per layer (`coarse_at_points`). The original evaluated every
        //    coarser basis at every nearby point for every node: nodes × ~64 coarser
        //    nodes × ~20 points × layers B-spline evaluations.
        // 2. The gradient half is ⟨∇B_n, ∇F⟩ for the coarser solution F, and a quadratic
        //    B-spline of width 2w is exactly a [1,3,3,1]/8 (per axis) combination of
        //    width-w ones. So F, prolonged layer by layer into this layer's basis
        //    (`prolonged`, see [`Self::prolong`]), turns the sum into the same-width
        //    5×5×5 stencil over F's coefficients next to n — instead of probing ~64
        //    nodes in every coarser layer.
        let my_width = my_layer.cell_width();
        if curr_layer > 0 {
            let same = OverlapTable::new(my_width, my_width, true, true);
            let zero = Point3::new(0i64, 0, 0);
            let mut stencil = [[[0.0; 5]; 5]; 5];
            for (i, plane) in stencil.iter_mut().enumerate() {
                for (j, line) in plane.iter_mut().enumerate() {
                    for (k, s) in line.iter_mut().enumerate() {
                        let d = Point3::new(i as i64 - 2, j as i64 - 2, k as i64 - 2);
                        *s = same.grad_grad_sum(&zero, &d);
                    }
                }
            }

            for rhs_id in 0..my_layer.ordered_nodes.len() {
                let node_key = my_layer.ordered_nodes[rhs_id];
                let node_center = my_layer.grid.cell_center(&node_key);

                if screening != 0.0 {
                    let mut screen = 0.0;
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
                                    let at_node =
                                        polynomial::eval_bspline(pt.x, node_center.x, my_width)
                                            * polynomial::eval_bspline(pt.y, node_center.y, my_width)
                                            * polynomial::eval_bspline(pt.z, node_center.z, my_width);
                                    screen += at_node * coarse_at_points[*pid];
                                }
                            }
                        }
                    }
                    rhs[rhs_id] -= screen_factor * screen;
                }

                let mut grad = 0.0;
                for (i, plane) in stencil.iter().enumerate() {
                    for (j, line) in plane.iter().enumerate() {
                        for (k, s) in line.iter().enumerate() {
                            let key = node_key + vector![i as i64 - 2, j as i64 - 2, k as i64 - 2];
                            if let Some(f) = prolonged.get(&key) {
                                grad += s * f;
                            }
                        }
                    }
                }
                rhs[rhs_id] -= grad;
            }
        }

        // Solve the sparse system.
        let lhs = CscMatrix::try_from_csc_data(num_nodes, num_nodes, col_offsets, row_indices, values)
            .expect("assembled CSC is well-formed: one sorted, duplicate-free column per node");
        solve_conjugate_gradient(&lhs, &mut rhs, niters);
        // let chol = CscCholesky::factor(&lhs).unwrap();
        // chol.solve_mut(&mut rhs);

        rhs
    }

    /// The solution of every layer up to and including `coarse` (its own solved weights
    /// plus `coarse_prolonged`, everything coarser already expressed in its basis),
    /// re-expressed in `fine`'s basis at every lattice point within ±2 of a `fine` node —
    /// exactly the coefficients [`Self::solve`]'s stencil reads. (Vendored patch.)
    ///
    /// Exact by the B-spline refinement relation: a normalised quadratic B-spline of
    /// width 2w centred on coarse cell K equals Σ_t r_t·B_w at fine cells 2K − 1 + t,
    /// t = 0..3, with r = [1, 3, 3, 1]/8 per axis. So fine coefficient k gathers from the
    /// two coarse cells per axis that refine onto it. Those parents lie within ±2 of a
    /// `coarse` node (each fine node's parent cell is one — see [`Self::from_next_layer`]),
    /// which is where `coarse_prolonged` is complete, so the induction holds layer to layer.
    pub(crate) fn prolong(
        fine: &Self,
        coarse: &Self,
        coarse_prolonged: &FastMap<Point3<i64>, Real>,
    ) -> FastMap<Point3<i64>, Real> {
        const R: [Real; 4] = [0.125, 0.375, 0.375, 0.125];
        let q = |k: &Point3<i64>| {
            coarse_prolonged.get(k).copied().unwrap_or(0.0)
                + coarse.grid_node_idx.get(k).map_or(0.0, |&id| coarse.node_weights[id])
        };
        // Per axis: the two coarse parents of fine index k and their refinement weights.
        let parents = |k: i64| {
            let hi = (k + 1).div_euclid(2);
            let t = (k - 2 * hi + 1) as usize; // 0 or 1; the lower parent has t + 2
            [(hi, R[t]), (hi - 1, R[t + 2])]
        };
        let mut out: FastMap<Point3<i64>, Real> = FastMap::default();
        out.reserve(fine.ordered_nodes.len() * 2);
        for node in &fine.ordered_nodes {
            for i in -2..=2 {
                for j in -2..=2 {
                    for k in -2..=2 {
                        let key = node + vector![i, j, k];
                        if out.contains_key(&key) {
                            continue;
                        }
                        let (px, py, pz) = (parents(key.x), parents(key.y), parents(key.z));
                        let mut v = 0.0;
                        for &(kx, rx) in &px {
                            for &(ky, ry) in &py {
                                for &(kz, rz) in &pz {
                                    v += rx * ry * rz * q(&Point3::new(kx, ky, kz));
                                }
                            }
                        }
                        out.insert(key, v);
                    }
                }
            }
        }
        out
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
