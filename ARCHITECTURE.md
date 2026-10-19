# Architecture

A map of the codebase for anyone who wants to read it or send a pull request. For
what the app does, see the [README](README.md). For the methods behind each stage,
see the in-app glossary (**Other ▸ Glossary**), whose source is in
[`src/glossary/`](src/glossary/).

## The big picture

websfm is a static web app with no server. A Vue 3 front end drives a pool of web
workers, and the workers run the numerical work in Rust compiled to WebAssembly.
Projects are stored in the browser's Origin Private File System (OPFS) or, in
Chromium, in a folder on disk that the user picks.

```
components/*.vue ──► stores/*.js ──► workers/computeClient.js ──► compute.worker.js
                         │                                              │
                         ▼                                              ▼
                    utils/opfs.js                              core/*.js (pure)  ──► wasm/*
```

- **`src/components/`**: the UI (Vue 3 `<script setup>`). OpenLayers draws the 2D
  map and Three.js the 3D view.
- **`src/stores/`**: Pinia stores. They own the reactive state and its persistence,
  and they turn reactive data into plain arrays before posting it to a worker.
- **`src/workers/`**: `computeClient.js` is a typed async client over a worker pool.
  The op handlers live in `workers/ops/<domain>.js` (detect, match, sfm, dense,
  products, mesh, io, export). WebGPU kernels are in `workers/gpu/`.
- **`src/core/`**: pure computation with no Vue, Pinia, OPFS or DOM. It takes plain
  data in and returns plain data, and reports through injected `onLog`/`onProgress`
  hooks. That is what lets the same code run in a worker and in Node tests. It is
  grouped by pipeline stage:

  | Folder | Contents |
  | --- | --- |
  | `core/features/` | detectors (SIFT, learned ONNX detectors), matchers, geometric verification, pair selection |
  | `core/sfm/` | incremental SfM, registration, tracks, self-calibration, film-scan fiducials, GCP triangulation |
  | `core/dense/` | PatchMatch depth-map orchestration, cross-view filtering, fusion, memory budgeting |
  | `core/products/` | DEM, orthophoto, mesh, georeferencing, scale, exporters (GeoTIFF/COG, PLY, LAS, 3D Tiles, …) |
  | `core/io/` | importers and format readers (COLMAP, LAS/LAZ, PLY, GeoTIFF, GCP/pose CSV, `.websfm` archives) |
  | `core/lod/` | level-of-detail octrees of big clouds: the build, and the cloud sources the viewer and tools read nodes from (our octree, or a COPC file read in place) |
  | `core/eval/` | the statistics behind the Quality Report |
  | `core/help/` | glossary, user guide and the ribbon command tables |

- **`crates/`**: six Rust crates compiled to WASM: `sift`, `matching`,
  `reconstruction` (PnP, bundle adjustment, PatchMatch), `mesh` (screened Poisson),
  `imagecodec` (TIFF decode) and `lazcodec` (LAZ). See [`crates/README.md`](crates/README.md).
  The generated bindings in `src/wasm/` are committed, so the front end runs without
  a Rust toolchain.

## The pipeline

1. **Detect**: SIFT in Rust, or a learned detector (ALIKED, DISK, SuperPoint) through ONNX
   Runtime Web. Large images can be detected in tiles.
2. **Match**: brute-force nearest neighbour with a ratio test (WASM, or WebGPU), or
   LightGlue, then RANSAC fundamental-matrix verification. Pairs can be preselected
   from camera positions or a capture-order window.
3. **Sparse SfM**: initial pair selection, incremental registration (P3P + robust
   PnP), Levenberg–Marquardt bundle adjustment with optional self-calibration, track
   completion and filtering. Lens distortion and film-scan geometry are removed once
   at the start, so everything after works in a pinhole camera model.
4. **Dense MVS**: per-image PatchMatch depth maps (WASM or WebGPU), a cross-view
   consistency filter, then fusion into a point cloud with a voxel-based dedupe.
   Depth maps are the one intermediate result stored on disk, because they take
   minutes per image to compute.
5. **Products**: DEM, true orthophoto (onto a DEM, mesh or plane), screened-Poisson
   mesh, and point-cloud editing tools.
6. **Georeferencing**: ground control points, camera position priors and reference
   rasters, in any proj4 coordinate reference system. Control points can also
   constrain the bundle adjustment directly.

## Storage

The per-project directory (`project.json`, `images/`, `matches/`, reconstruction
files, …) *is* the project format. A `.websfm` file is a streamed zip of that
directory, and a folder-backed project is the same layout written to a folder the
user picked. Anything that can be recomputed cheaply is recomputed on open rather
than stored.

## Conventions worth knowing

- **Coordinates and cameras** follow OpenCV: world-to-camera `R, t`, the camera looks
  down +z, image +y points down. Conversions to other tools' conventions (COLMAP,
  nerfstudio/3DGS `transforms.json`) each live in one place with a round-trip test.
- **Large data lives in typed arrays**, never in one JavaScript object per point,
  keypoint or match. The V8 heap has a limit of about 4 GB per page or worker;
  typed-array storage and WASM memory don't count against it.
- **Default settings have one home.** User-facing defaults are in
  `src/core/defaults.user.js` and internal tuning values in `src/core/tuning.js`.
  The dialogs and the core code read the same objects.
- **The Ribbon chooses; a floating toolbox runs.** Ribbon commands open a dialog or
  start a tool. The controls for a running tool live in its toolbox over the view.
- **Log derived values with their inputs.** Every automatically chosen value gets a
  log line, so a run can be reproduced from its log.
- **User-visible changes update the user guide** in `src/guide/` in the same change.

## Tests

```bash
npm test             # Vitest: src/core, src/utils, src/stores
npm run typecheck    # TypeScript, Vue template bindings, ESLint
npm run test:browser # Playwright, Chromium
cargo test           # Rust crates (crates/mesh needs --release)
```

Tests run in Node without a DOM, so Vue components and browser APIs are covered by
the Playwright suite and by manual checks. End-to-end pipeline quality is measured
with a headless browser bench (`scripts/bench/`, see its README) that runs the real
app on real datasets.
