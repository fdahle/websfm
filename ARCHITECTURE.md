# Architecture

A map of the codebase for anyone who wants to read it or send a pull request. For
what the app does, see the [README](README.md). For the methods behind each stage,
see [docs/METHODS.md](docs/METHODS.md) and the in-app glossary (**Other ▸ Glossary**),
whose source is in [`src/glossary/`](src/glossary/). How to run and test the code is
in [docs/development.md](docs/development.md).

## The big picture

WebSfM is a static web app with no server. A Vue 3 front end drives a pool of web
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
than stored. [docs/project-format.md](docs/project-format.md) lists every file, and how
a change to one keeps older projects opening (format migrations).

## Following one operation through the code

Every pipeline step takes the same path. Here is **Products ▸ DEM**, from the button
to the algorithm; the other steps differ only in file names.

| Layer | File | What it does there |
| --- | --- | --- |
| Ribbon button | `core/help/ribbonTabs.js` (`gen-dem`) | label, icon, and the prerequisites that grey it out |
| Command | `composables/useCommandDispatch.js` | the button's id opens the dialog |
| Dialog | `components/modals/products/DemModal.vue` | the settings, starting from `DEM_DEFAULTS` in `core/defaults.user.js` |
| Run | `composables/useDialogRuns.js` → `composables/usePipeline.js` | closes the dialog, opens the progress bar, wires up Cancel |
| Store | `stores/reconstruction/productRuns.js` (`generateDem`) | gathers the inputs as plain arrays, saves the result to the project |
| Worker call | `workers/computeClient.js` | a typed async call into the worker pool |
| Worker op | `workers/ops/products.js` | unpacks the message, reports progress |
| Algorithm | `core/products/dem.js` (+ `dem.test.js`) | the computation: plain data in, plain data out |
| Help | `src/guide/dem.md`, `src/glossary/` | the guide article and the concepts it links |

## Where to change what

| To … | Start in | Also touch |
| --- | --- | --- |
| change an algorithm | `core/<stage>/` or `crates/<crate>/` | its `*.test.js`; `npm run build:wasm` for Rust; [docs/METHODS.md](docs/METHODS.md) if the method changes |
| add or change a setting | the `*_DEFAULTS` in `core/defaults.user.js` and the dialog in `components/modals/` | the guide section in `src/guide/` (see [CONTRIBUTING](CONTRIBUTING.md#keep-the-in-app-help-in-step)) |
| tune an internal threshold | `core/tuning.js` | the test that pins it |
| add a ribbon command | `core/help/ribbonTabs.js` | `composables/useCommandDispatch.js`; it becomes a console command automatically (`core/help/commands.js`) |
| add or change a keyboard shortcut | its entry in `core/help/shortcuts.js` | the handler asks `matches(e, id)`, a tooltip shows `keyLabel(id)` (`utils/shortcutLabels.js`); the Shortcuts dialog lists it by itself |
| add an import format | a reader in `core/io/` | `composables/useImportRouting.js` (and `core/io/importKind.js` for dropped files) |
| add an export format | a writer in `core/products/exporters.js` or `core/io/` | `components/modals/products/ExportModal.vue`, `workers/ops/export.js` |
| add per-project state | a store in `stores/` | register it with `registerProjectStore` (`stores/projectStores.js`) so it saves and reopens with the project |
| change a WebGPU kernel | `workers/gpu/` | the PatchMatch cost exists three times (WGSL, JS, Rust) and changes in all three ([`workers/gpu/README.md`](src/workers/gpu/README.md)) |
| explain a concept | a new entry in `src/glossary/<category>/` | aliases auto-link it in all help text |
| add an example dataset | `core/examples.js` | `scripts/examples/make-example.py`, `scripts/fetch-examples.mjs`, a walkthrough in `src/guide/` |

## Conventions worth knowing

- **Coordinates and cameras** follow OpenCV: world-to-camera `R, t`, the camera looks
  down +z, image +y points down. Conversions to other tools' conventions (COLMAP,
  nerfstudio/3DGS `transforms.json`) each live in one place with a round-trip test.
- **Large data lives in typed arrays**, never in one JavaScript object per point,
  keypoint or match. The V8 heap has a limit of about 4 GB per page or worker;
  typed-array storage and WASM memory don't count against it. Chrome caps one
  ArrayBuffer at 2 GiB and a tab's ArrayBuffers at 16 GiB together; an array that may
  pass either comes from `core/bigArray.js` (`localArray` for one that stays in its
  worker, `shareableArray` for one that crosses), which puts it in WebAssembly memory,
  where neither limit applies. Its `.buffer` is longer than the array, and a shared one
  must not be in a transfer list (the compute client and worker filter them out).
- **Default settings have one home.** User-facing defaults are in
  `src/core/defaults.user.js` and internal tuning values in `src/core/tuning.js`.
  The dialogs and the core code read the same objects.
- **The Ribbon chooses; a floating toolbox runs.** Ribbon commands open a dialog or
  start a tool. The controls for a running tool live in its toolbox over the view.
- **Keyboard shortcuts have one home.** `core/help/shortcuts.js` names every key and
  modifier gesture. Handlers test `matches(e, id)` rather than `e.key`, tooltips show
  `keyLabel(id)`, and the Shortcuts dialog (`?`) lists the table, so the three agree.
- **Heavy CPU work uses every core.** `workers/computeClient.js` runs a pool of up to
  eight workers. A stage made of independent items spreads them over the pool (matching
  by pair, detection by image, depth maps and the ortho by chunks, each worker with its
  share of the memory budget), and bundle adjustment runs on WASM threads. Where a stage
  stays on one worker (a GPU path, or fusion, which is bound by reads), a comment says
  why.
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
