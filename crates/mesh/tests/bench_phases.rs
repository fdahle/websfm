// Phase timings for the screened-Poisson solve. `#[ignore]`d — this is a measurement
// harness, not a correctness test (crates/mesh/src/lib.rs holds those). Run with:
//   cargo test -p mesh --release --test bench_phases -- --ignored --nocapture
//
// It exists because the phases have wildly different scaling and the modal only shows
// one opaque bar: the octree build is O(N), the per-layer solve used to be O(nodes ·
// 8^depth) before the `build_rhs` scatter patch (see poisson_vector_field.rs), and
// marching cubes is O(occupied leaf cells). Print them separately or a regression in
// one hides inside the total.
use nalgebra::{Point3, Vector3};
use poisson_reconstruction::PoissonBuilder;
use std::collections::HashMap;
use std::time::Instant;

// Minimal stand-in for the mesh crate's private `PointProximity`, so extraction is
// measured the way production runs it (bounded to the region trimming would keep).
struct Near {
    grid: HashMap<(i64, i64, i64), Vec<usize>>,
    pts: Vec<Point3<f64>>,
    inv: f64,
    r2: f64,
}

impl Near {
    fn new(pts: &[Point3<f64>], radius: f64) -> Self {
        let inv = 1.0 / radius;
        let mut grid: HashMap<(i64, i64, i64), Vec<usize>> = HashMap::new();
        for (i, p) in pts.iter().enumerate() {
            let k = ((p.x * inv).floor() as i64, (p.y * inv).floor() as i64, (p.z * inv).floor() as i64);
            grid.entry(k).or_default().push(i);
        }
        Self { grid, pts: pts.to_vec(), inv, r2: radius * radius }
    }

    fn test(&self, p: &Point3<f64>) -> bool {
        let (cx, cy, cz) = (
            (p.x * self.inv).floor() as i64,
            (p.y * self.inv).floor() as i64,
            (p.z * self.inv).floor() as i64,
        );
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(ids) = self.grid.get(&(cx + dx, cy + dy, cz + dz)) {
                        for &i in ids {
                            if (self.pts[i] - p).norm_squared() <= self.r2 {
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

// A terrain-like surface: one point per leaf cell of a `side`×`side` grid, gently
// rolling. This is the shape core/products/mesh.js feeds the solver after its input
// voxel subsample (~one point per octree leaf cell).
fn terrain(side: usize, extent: f64) -> (Vec<Point3<f64>>, Vec<Vector3<f64>>) {
    let mut pts = Vec::with_capacity(side * side);
    let mut nrm = Vec::with_capacity(side * side);
    for i in 0..side {
        for j in 0..side {
            let x = (i as f64 / side as f64) * extent;
            let y = (j as f64 / side as f64) * extent;
            let z = 0.05 * extent * ((x * 0.02).sin() + (y * 0.017).cos());
            let dzdx = 0.05 * extent * 0.02 * (x * 0.02).cos();
            let dzdy = -0.05 * extent * 0.017 * (y * 0.017).sin();
            pts.push(Point3::new(x, y, z));
            nrm.push(Vector3::new(-dzdx, -dzdy, 1.0).normalize());
        }
    }
    (pts, nrm)
}

fn run(side: usize, depth: usize, screening: f64) {
    let (pts, nrm) = terrain(side, 500.0);
    println!("\n=== {} pts, depth {}, screening {}", pts.len(), depth, screening);
    let total = Instant::now();

    let t = Instant::now();
    let mut builder = PoissonBuilder::new(
        &pts,
        &nrm,
        screening,
        depth.saturating_sub(2).max(1),
        depth,
        10,
    );
    println!("  build (octree + vector field): {:.2}s", t.elapsed().as_secs_f64());

    let layers = builder.num_layers();
    let t = Instant::now();
    for i in 0..layers {
        let lt = Instant::now();
        builder.solve_step();
        println!("    layer {}/{}: {:.2}s", i + 1, layers, lt.elapsed().as_secs_f64());
    }
    println!("  solve (all layers): {:.2}s", t.elapsed().as_secs_f64());

    let t = Instant::now();
    let (recon, points, sample_iso) = builder.finish();
    println!("  finish + isovalue: {:.2}s", t.elapsed().as_secs_f64());

    // Extraction bounded exactly as `finalize_mesh` bounds it with the default support
    // trim: the support field reaches 2√3 support cells (4 leaves each) past a sample,
    // plus half a leaf-cell diagonal.
    let t = Instant::now();
    let leaf = recon.leaf_cell_width();
    let reach = Near::new(&points, 2.0 * 3.0_f64.sqrt() * 4.0 * leaf + leaf * 3.0_f64.sqrt() / 2.0);
    let bufs = recon.reconstruct_mesh_buffers_iso_within(sample_iso, &|c| reach.test(c));
    println!(
        "  marching cubes: {:.2}s -> {} verts / {} tris",
        t.elapsed().as_secs_f64(),
        bufs.vertices().len(),
        bufs.indices().len() / 3
    );
    println!("  TOTAL: {:.2}s", total.elapsed().as_secs_f64());
}

#[test]
#[ignore]
fn bench_depth7() {
    run(128, 7, 4.0);
}

#[test]
#[ignore]
fn bench_depth8() {
    run(256, 8, 4.0);
}

#[test]
#[ignore]
fn bench_depth10() {
    run(1024, 10, 4.0);
}
