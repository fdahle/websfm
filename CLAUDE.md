# websfm — architecture & orientation

Browser-based Structure-from-Motion / photogrammetry app. Vue 3 + Pinia front end,
heavy CV math in Rust→WASM, everything runs client-side (no server). Targets polar /
non-WGS84 projects (Antarctica), so CRS handling is first-class.

## The docs (keep the roles strict)
- **CLAUDE.md** (this file) — evergreen *code* architecture, layering, invariants,
  "where things live". No status, no tasks; if a sentence can go stale, it belongs
  elsewhere.
- **METHODS.md** — the *SfM/photogrammetry science*: which algorithms and why
  (which bundle adjustment, which distortion model, which P3P, how georeferencing
  works). Implementation-light, method-heavy — the doc to read before talking to a
  photogrammetry colleague. Update it when a *method* changes, not on code churn.
- **TODO.md** — the single prioritized plan: Now → Next → Backlog → Parked. All open
  work lives there, nowhere else.
- **HANDOVER.md** — the record: measured baselines (before/after yardsticks) and a
  reverse-chronological done log.
- **VERIFICATION.csv** — the manual-check register: one row per check this
  environment cannot run (browser runtime, real datasets, external applications),
  with its pass criteria and columns for status/result/date. It exists because
  "shipped" and "verified" diverged badly once the code outran the browser runs;
  checklists must live there, not scattered through TODO.md and the plan files.
- **`src/guide/*.md`** — the in-app, user-facing guide: task-oriented instructions
  and parameter advice for the functionality people use. **A user-visible function
  change is incomplete until its guide article is updated in the same change** (or
  a new article is added). This includes changed workflows, prerequisites, defaults,
  labels, supported formats, side effects, and output behaviour.
- **`docs/planning/`** — executable specs for open implementation work (the
  step-by-step *how*; TODO.md stays the source of truth for *whether/when*), indexed
  by `docs/planning/README.md`. Delete a plan once its implementation closes; any
  unsigned browser/external checks remain solely in `VERIFICATION.csv`.
When an item ships: delete it from TODO.md, add one done-log line to HANDOVER.md
(date · what · where it lives), add any owed manual checks as VERIFICATION.csv rows,
fold any *evergreen* code lesson into this file, and if the *method* changed, update
METHODS.md. A measured number from a verification run goes to HANDOVER §Baselines.

## Stack
- **UI**: Vue 3 (`<script setup>`), Pinia stores, OpenLayers (map), Three.js (3D).
- **Compute**: six Rust crates compiled to WASM
  (`crates/{sift,matching,reconstruction,mesh,imagecodec,lazcodec}`),
  run **off the main thread** in a worker. `crates/mesh` is screened-Poisson meshing;
  it vendors a **rayon-stripped** copy of Dimforge's `poisson_reconstruction` under
  `crates/mesh/vendor/` (rayon's worker threads panic on threadless wasm) with a
  marching-cubes iso patch — it is one of the three crates allowed a dependency, kept isolated
  so it doesn't leak into `crates/reconstruction` (which stays wasm-bindgen-only).
  The vendored copy also carries **performance patches** (2026-08-11, see HANDOVER
  ▸ B-mesh): every one is an exact restructuring — same mesh out, only summation order
  and vertex numbering move — and each is marked `(Vendored patch)` at its site. The
  evergreen lesson behind them: **`HGrid::cells_intersecting_aabb` costs the box
  volume, not the occupancy.** It walks every integer cell in the range and only then
  filters to occupied ones, so an AABB query whose box is much larger than the cell
  width is a trap — it reads like a spatial index lookup and behaves like a dense scan.
  That one call made depth-8 meshing take hours. Where a query box can be large
  relative to the grid, either scatter from the sources instead or scan the node list
  (`PoissonLayer::range_is_cheaper_than_scan` picks per call). Second lesson, in the
  same file: **the Poisson solution is defined over all space** — the coarse multigrid
  layers' basis functions have support far wider than the finest layer's extent — so
  the isosurface walk runs a long way past the samples, and "bound it to the octree
  AABB" is *wrong* (it clips real surface). Bound it by proximity to the input points
  instead, which is exactly what the trim pass already enforces.
  Third lesson, the expensive one: **upstream's CG started every layer from `x₀ = b`
  and ran a fixed 10 iterations, so the solve never converged.** The residual was
  cell-sized closed ripples, the "blob field" mesh. It went unnoticed for months
  because the crate's own sphere test accepted mean radius 1.08 / RMS 0.19 as
  "smoothed outward at low depth". Converged, it is 1.0001 / 0.0004. Pin a solver's
  output to a precision it should reach, never to the error it happens to have.
  Assembly restructurings (the coarse-layer screening sum via the coarser solution at
  each sample, `OverlapTable` lattice-offset coefficient tables, B-spline prolongation
  of the coarser solution, direct CSC assembly, `fast_hash.rs`) must reproduce the
  solved coefficients. `solver_weights_reference` records them with the old code
  (`WEBSFM_WEIGHTS=write`, `WEBSFM_WEIGHTS_FILE=<path>`; WSL's `/tmp` does not survive
  between `wsl.exe` calls) and checks the new code (`=check`, ≤ 1e-9 relative).
  Its Rust tests need release mode (`cargo test -p mesh --release`; debug is ~40× slower).
  `crates/imagecodec` and `crates/lazcodec` are the other dep-carrying crates,
  likewise isolated from `reconstruction`: the `tiff` crate as a native TIFF decoder
  that replaces the slow pure-JS geotiff.js decode at ingest (see the TIFF gotcha),
  and the `laz` crate (LASzip) for LAZ read/write, which has no credible pure-JS
  writer. `lazcodec` does **only** the chunked arithmetic coding — the LAS header,
  VLR directory and point-record layout stay in JS (`core/io/las.js` +
  `core/io/laz.js`), so format knowledge lives on one side of the boundary.
- **Persistence**: OPFS (Origin Private File System) via `src/utils/opfs.js`. Per-project
  directory tree; everything recomputable is recomputed rather than stored — the one
  exception is **dense Stage A depth maps** (minutes/image to rebuild), persisted to
  `depthmaps/` and loaded lazily; see `core/dense/depthMapCodec.js`.
  **The per-project directory IS the project format** — that one fact carries both
  save/load and folder-backed storage (below), and is why neither invents a format.
- **Build/test**: Vite, Vitest (`npm test`), `tsc --noEmit` (`npm run typecheck`),
  `npm run build:wasm` (needs `wasm-pack`).

## Layering (important — keep these boundaries)
```
components/*.vue ──► stores/*.js ──► workers/computeClient.js ──► compute.worker.js
                         │                                              │
                         ▼                                              ▼
                    utils/opfs.js                              core/*.js (pure)  ──► wasm/*
```
- **`src/core/**/*.js` is PURE compute**: no Vue/Pinia/OPFS/DOM. Plain data in, plain
  data out, side effects via injected `onLog`/`onProgress` hooks. This is what lets the
  same code run inside the worker. Grouped by pipeline stage into subfolders:
  `core/features/` (detectors `sift.js` / `learnedDetect.js` — the one ONNX runner
  for every learned detector — with `learnedDetectors.js` its registry: per detector the
  weights, descriptor width, input channels (SuperPoint luma, DISK RGB), tile align and
  the LightGlue trained for it; code asks `isLearnedDetector`/`learnedDetector(id)`,
  never `=== 'superpoint'`, and `lightGlueModelFor(images)` picks the matcher weights,
  matchers `bruteforce.js` /
  `lightglue.js`, `nnSelect.js` — the brute-force ratio + mutual-NN decision over
  top-2 arrays, the JS twin of the crate's rule, shared geometric gate `verify.js` — F-RANSAC + inlierSpread — plus
  `ort.js`, `preselect.js`, `sequentialPairs.js` (capture-order window + optional orbit
  closure), and `tiling.js` — pure tile-grid/core-ownership/seam-NMS/auto-size math
  behind tiled detection; the per-tile detector loop lives in `workers/ops/detect.js`;
  `keypointCap.js` — which keypoints survive `maxKeypoints` (coarse-first/response);
  `siftDescriptors.js` — RootSIFT + the per-image descriptor space),
  `core/sfm/`
  (`sfm.js` incremental SfM orchestrator + primary/secondary driver,
  `multiModel.js` conservative stranded-component reconstruction and shared-camera
  similarity validation/merge, `register.js` the incremental-resection
  stage lifted out of it — next-best-view ordering + two-gate PnP + interleaved BA,
  `registerImages(ctx)` mutating the caller's model in place, `reconstruction.js` JS↔WASM
  marshalling, `geometry.js` shared pinhole-camera helpers — cameraCenter, project*,
  triangulationAngle, scaleK, rgbaToGray — `distortion.js`, `cameraEstimated.js`),
  `core/dense/` (`mvs.js` dense MVS orchestrator, `planeCost.js`, `memBudget.js`,
  `depthMapCodec.js` — pure depth-map↔sidecar (de)serialization + index stamping/
  staleness for the persisted Stage A output),
  `core/products/` (`dem.js`, `ortho.js`, `surface.js` — the height grid the ortho
  reprojects onto, from a mesh / fitted plane / resampled DEM (see Pipelines ▸ 5),
  `mesh.js` screened-Poisson mesh orchestrator
  — byte-buffer parse + nearest-voxel vertex-colour transfer, wasm solver injected,
  `projection.js`, `georef.js`, `scale.js` — the known-distance ("scale bar") fit:
  weighted-LSQ `fitScale` + `frameFromScaledLocal` (in projection.js) + the
  evidence digest, `exporters.js` — cloud/mesh/DEM/ortho writers incl.
  `prepareCloudForExport` (georef-then-voxel-downsample, streams the dense
  accumulator — no per-point objects) + `meshToObj`/`meshToStl`, `geotiff.js`
  (sync writers; DEFLATE via an injected `deflate` callback since `CompressionStream`
  is DOM/worker-only — the pure path never compresses. `writeGeoTiff` = baseline
  single-strip, the *export* path. `writeCog` = internally tiled + halving overviews
  for imported reference rasters; it takes a **TypedArray**, not raw bytes, because
  it must interpret pixels to tile and downsample, and is uncompressed — per-tile
  DEFLATE would need the async callback per tile per level. Overviews box-average
  with nodata skipped; a single-tile level keeps TileOffsets/TileByteCounts inline,
  since count·size ≤ 4 means a reader takes the field as the value, not a pointer),
  A **COG is written in two calls** — `planCog` (pure, sync: levels, tiles, write
  order) then `assembleCog` (layout once the real byte counts are known) — because
  compression is async and per-tile; `writeCogDeflate` is the wired-up form and
  `writeCog` the uncompressed one-shot. A tiled file's TileByteCounts *are* the
  compressed sizes, so layout cannot precede compression. It also emits the GDAL
  ghost area so readers report `LAYOUT=COG`),
  `undistort.js` — resampling a raster into the pinhole frame (bilinear
  `resampleRgba`, nearest `resampleMaskLut`, `pinholeFrameSize`, `validSampleRect`
  = COLMAP `blank_pixels=0`, `cropRgba`/`shiftPrincipalPoint`). The *map* always
  comes from `core/sfm/displayFrame.js` `makeSampleMap`; **dense MVS and the
  undistorted-image export share both**, so there is exactly one distortion
  composition in the app,
  `tiles3d.js` — Cesium 3D Tiles 1.1, **one tile** (`tileset.json` + a points
  `.glb`). Two conventions carry it: content is written **Y-up** while the tile
  frame and its bounding volume are **Z-up** (3D Tiles rotates glTF content on
  load; matching handedness tips the model on its side), and the ECEF transform is
  **measured** from probe points one project-CRS unit east/north rather than
  assuming grid axes are ENU — that shortcut is fine mid-latitude and badly wrong
  near the poles, where convergence approaches the longitude difference itself.
  The probes carry the projection scale factor k into the horizontal axes; the up
  axis must NOT inherit it (heights are not scaled by k — 2.6 % at 85°S), so it is
  the unit ellipsoid normal × metres per vertical unit,
  `wkt.js` — minimal OGC WKT1
  for `.prj` (WGS84 geographic + UTM zones formulaic, else null → caller writes the
  raw proj4/EPSG string), `colormap.js`, `report.js` — `buildReportHtml` assembles one
  self-contained (inline CSS, no external assets, no scripts) Quality Report HTML from a
  plain report object; the user prints it to PDF), `core/io/` (`gcp.js`, `pose.js`, `sensor.js`,
  `rasterKind.js` — pure DEM-vs-orthophoto classification of an imported GeoTIFF
  from extracted tags + a decimated sample → `{ kind, confidence, reasons }`,
  signals ordered by strength (float sampleformat / nodata tag / band count /
  bit depth / VerticalCSTypeGeoKey / histogram / filename);
  `rasterStyle.js` — pure band math for an imported raster (`needsStyling`
  gate, `defaultRasterStyle`/`resolveRasterStyle`, `bandsUsedBy`, percentile/
  min-max/manual `resolveRange`, `composeStyledRgba` for grey / RGB-composite /
  normalised-difference-index modes). Exists because geotiff's `readRGB()`
  scales by the DECLARED bit depth, so 16-bit Sentinel-2 reflectance (~3000 of
  65535) renders as pixel value ~19 — black. Anything >3 bands or deeper than
  8-bit takes the styled path; an 8-bit 1–3 band ortho keeps the old `readRGB`
  fast path untouched. An index renders on its own fixed −1…1 scale and is
  never stretched (a stretch would move the zero crossing that gives NDVI its
  meaning). Restyling uses a **32 MiB worker LRU of preview bands and percentile
  samples** (`useExternalStore.setRasterStyle`); a cache miss reads the retained
  original Blob. Styled full-resolution planes remain lazy derived data.
  `readRasterWindow` reads bounded raw-band windows directly from the original
  with explicit pixel offsets/scales, independent of display styling,
  `rasterSample.js` — **THE** raster sampler (bilinear + nodata/mask/NaN, plus
  `worldToPixel`/`pixelToWorld`/`rasterBounds`) over a
  `{ width, height, data, geoTransform }` descriptor — `core/eval/demCheck.js`
  is now a thin adapter over it, so there is exactly one half-pixel/nodata
  convention; `rasterSource.js` — the `RasterSource` accessor boundary
  (`{ meta, sampleAt, readWindow, previewDataUrl }`, `createFlatRasterSource`
  behind it) that consumers use instead of a public `data[]`, so a remote-COG
  source lands as a second implementation rather than a rewrite of every call
  site,
  `geojson.js`, `metadata.js`, `cameraKind.js`, `importKind.js` — filename/content
  sniffing incl. `isColmapFile` + text-xyz cloud sniff, `colmapModel.js`
  — pure COLMAP text **and** binary model read/write: R↔quaternion +
  `serialize/parseColmapModel` (txt) + `serialize/parseColmapModelBin` (LE, same
  ColmapModel struct) + websfm↔ColmapModel adapters both ways (`buildColmapModel`
  export; `readColmapModel`→`colmapToSparse` import via `makeNameResolver` name→uuid
  matching, dropping unmatched images/observations), `las.js` — LAS 1.2 writer
  (point format 2) + reader (formats 0–3/6–8, **stride is header-authoritative** —
  read `headerSize`/`offsetToPointData`/`pointDataRecordLength`, never assume from
  the format id). It is split so LAZ reuses it: `writeLasHeader`/`encodeLasPoints`
  on the way out, `readLasHeader`/`decodeLasPoints` on the way in. `laz.js` — the
  LAZ container (LASzip VLR 22204, the point-format high bit) with the **codec
  injected**, the same way `geotiff.js` takes its `deflate`, so it stays testable
  with no wasm; the codec is `crates/lazcodec` via `workers/ops/laz.js`. A .laz and
  a .las of one cloud differ in exactly two places — the high bit and the extra
  VLR — and quantize identically. **The sniff reads the high bit, not the
  extension**: LAZ is regularly shipped named `.las`, `cloudText.js` — XYZ writer/reader, `ply.js` —
  ascii + binary-LE reader (points + faces; unknown props skipped by computed
  stride; big-endian rejected), `cloudImport.js` — magic-byte format sniff +
  parser dispatch + the import transform (unit-scale / Y-up→Z-up proper rotation /
  voxel subsample), `transforms.js` — nerfstudio/3DGS `transforms.json` export
  (camera-to-world **OpenGL** poses: `c2w_cv = [Rᵀ|C]` then negate rot columns 1,2
  for the OpenCV→OpenGL axis flip)), `core/help/`
  (`glossary.js`, `guide.js`, `commands.js`), `core/segment/` (`sam2.js` — SAM2
  click-to-segment for the "Smart Select" mask tool: pure image→CHW-tensor /
  points→1024-space / logits→binary-mask math + ORT encoder/decoder glue, same
  lazy/cached/serialized-session pattern as LightGlue; encoder runs on WebGPU,
  decoder is WASM-pinned — ORT's WebGPU EP crashes on the per-click varying
  point-count shape); `core/models/` (`registry.js` — the ONNX-weight registry:
  id→{file,size} + `modelUrl(id)` URL resolution from `VITE_MODEL_BASE_URL`
  (default `<BASE_URL>models/`) + the Cache Storage bucket name; `modelCache.js`
  — cache-first `loadModelBytes(url)`/`isModelCached`. The weights are NOT in the
  repo (the SAM2 encoder alone is >GitHub's 100 MB limit) — they're **downloaded
  on demand with consent**: `stores/useModelsStore.js` `ensureReady([ids])` (main
  thread) opens `ModelDownloadModal.vue` for any uncached id, streams it into
  Cache Storage with progress, and the worker's core backends then read the
  cached bytes — the learned detectors/LightGlue/SAM2 resolve their URL via `registry.js`
  and load through `modelCache.js`, no re-download/re-consent. Both sides MUST
  resolve a model to the **identical** URL string or the worker's cache lookup
  misses. The dispatch gates live in `useImagesStore` detect (the learned detector's
  `modelId`), `useMatchesStore.matchAll` (its LightGlue), and `ViewerImage.ensureEncoded` (SAM2);
  a declined download returns `false` and the op aborts cleanly. **Every load path
  rejects a body that is not a model** (`modelBytesProblem`: HTML content type, a
  leading `<`, or < 64 kB) and evicts such a cached entry: a static host or the Vite
  dev server answers a missing `/models/x.onnx` with `index.html` and HTTP 200, which
  ORT reports only as "protobuf parsing failed". **A model's license is part of its
  record**: `redistributable: false` (SuperPoint — Magic Leap's non-commercial
  weights) means websfm never serves it. The consent modal instead links the upstream
  file (a plain link needs no CORS; GitHub release assets send none, so `fetch` cannot
  get it) and takes it via picker/drop (`useModelsStore.provideModelFile`), caching it
  under the same URL key, so no loader changes. `scripts/check-release.mjs` requires
  every redistributable model and fails a build that contains a restricted one (Vite
  copies `public/models/` wholesale). Dev keeps the
  files at `public/models/` (gitignored) so `loadModelBytes`' plain-fetch
  fallback needs no consent flow); `core/eval/` (pure read-only stats for the **Quality Report** hub
  — `reconStats.js` track-length histogram + reprojection stats, `imageStats.js`
  per-image residuals + `unregisteredReason` + `imageResidualVectors` (the image-view
  residual overlay — computed in the BA pinhole frame, so it takes an optional
  `toScan` mapper from `core/sfm/displayFrame.js` `makeCanonicalToScan` to land on
  the **raw** displayed image; without it a calibrated lens is off by its distortion
  and a film scan by the entire scan→canonical affine. `mag` stays the pinhole-frame
  error so the overlay agrees with the tables), `calibration.js` radial curve + focal delta, `matchGraph.js`
  union-find graph health + `bridgeEdges` (articulation edges / "fragile links") +
  `componentIndex`, `demCheck.js` bilinear DEM-at-GCP sampler, `positionCheck.js` — camera
  centres vs independent GNSS (7-parameter fit in a local ENU frame, optional antenna lever
  arm) + GCP checkpoints through that fit, the bench's accuracy metric, `coverage.js` top-down
  tie-point density grid, `compareRuns.js` run-to-run summary diff, and `health.js`
  — the **single** `EVAL_THRESHOLDS` warn/bad table (every hub tile that colours by
  tone reads it; no scattered magic numbers) + `projectHealth(snapshot)` → the Overview
  status rows; the tab's rule is **derive from the cloud, don't extend the summary** —
  recompute from `views`/`viewsPx` + cameras so the views also work on an imported
  COLMAP cloud with no run summary); cross-cutting stragglers stay flat at
  `core/` root (`crs.js`, `footprint.js`, `mask.js`, `types.ts`).
- **`src/stores/*.js`** own reactive state + OPFS persistence. They marshal reactive
  state into **plain** arrays/objects before posting to the worker (Vue Proxies can't be
  structured-cloned — a recurring footgun; see the `.map(row => [...row])` patterns).
- **`workers/computeClient.js`** is the typed async client (worker pool, request/response
  with streaming `ev` events). Pending calls retain their assigned worker: a
  worker-level crash rejects only that slot's calls and immediately replaces the
  slot; healthy workers and their in-flight calls continue. A call may pin a slot (`worker:`)
  — learned backends, SAM2, GPU matching: whatever holds per-worker state — or
  `avoid` one (WASM work during a GPU matching run keeps off `GPU_MATCH_WORKER`).
  **`compute.worker.js`**
  keeps the OffscreenCanvas pixel
  decoder (`rasterize`), the message loop, and the merged op registry. The op handlers
  live in **`workers/ops/<domain>.js`** (`detect`/`match`/`sfm`/`dense`/`products`/`mesh`/`io`),
  each a factory `makeXOps(deps)` returning `{ opName: handler }`; `rasterize` is injected
  into the two that need it (detect + dense), everything else is domain-local. `mesh`
  owns the mesh wasm module (lazy init, like `reconstruction.js`); `io` (`parseCloud`)
  parses an imported PLY/LAS/XYZ file off-thread (a 500 MB LAS on the UI thread is the
  trap it avoids), buffers in `transfer`. Handlers call
  `core/*` and keep their `transfer` lists next to them.
- **`App.vue`** is layout + store wiring + the Ribbon command dispatch. `handleCommand`
  keeps its trivial dispatches as **data** — `MODAL_COMMANDS` (command id → the modal
  ref it opens), `EVAL_SECTIONS` (Quality-hub deep links), a `view-preset-*` prefix
  rule — and reserves `switch` cases for commands with a guard, a toggle or a side
  effect, so the tables never hide behaviour. A new pipeline modal is one line in
  `MODAL_COMMANDS`. The Tools-tab dialogs share ONE slot instead of a flag each
  (`useModalsStore.toolModal` = the open tool's command id, `TOOL_MODALS` in App,
  one Escape entry); the ones that run through the store's edit path map dialog id
  → edit mode in `TOOL_EDIT_MODES`. **Verifying an App.vue refactor needs more than a green build**:
  `<script setup>` compiles a template identifier it can't resolve to `_ctx.foo`,
  which builds fine and is `undefined` at runtime. Compile the SFC before and after
  (`@vue/compiler-sfc` `compileScript` + `compileTemplate` with the script's
  `bindings`) and diff the `_ctx.*` sets — it must stay empty. Self-contained
  concerns are extracted to **`composables/*`** (`useTabDrag`, `useSidebarResize`,
  `useImportRouting` = dropped/picked-file funnel, `useExports` = camera-params/product
  export, `useProjectLifecycle` = open/create/switch/delete + folder-backed storage +
  `.websfm` save/load + the blocking load overlay (and `resetInMemoryProject`, the one
  spelling of "drop all in-memory project state"), `useConfirmations` = both
  confirm-before-destroy dialogs, `useModalEscape` = Escape-closes-top-modal,
  `useImageViewSettings` = the image view's overlay/edit toggles, plus
  `usePipeline`/`useTabs`/etc.). **The convention for these**: read the stores
  directly, inject only what genuinely lives in App.vue (tab management, the
  Three.js scene ref) — not a 15-argument dependency bag. Those image-view
  toggles (keypoints/mask/depth/GCPs/fiducials + mask-edit/gcp-edit) are **global, not
  per-tab**: one localStorage-persisted ref every image tab renders from, so switching
  images never changes them and a tab stays a bare image reference. The single per-image
  gate is keypoints (drawable only once `kpStatus === 'done'`), applied at render rather
  than stored on the pref.
  **`Sidebar.vue`** is a shell (drop-zone + section open/close + re-emit); each
  collapsible section is a component under **`components/layout/sidebar/`**
  (`ImagesSection`/`SensorsSection`/`MatchesSection`/`GcpsSection`/
  `ReconstructionSection`/`ProductsSection`/`ReferenceSection`), sharing
  `sidebar-sections.css` (via `<style scoped src>`) and
  `composables/useContextMenu.js` for the mutually-exclusive right-click menus.
  Those three cloud-bearing sections split by **provenance + role**, not data
  type: **Reconstruction** = every `kind:'sparse'` cloud (computed *or*
  COLMAP-imported — it's the *model*, and `mainSparseCloud` is a first-class role
  with a set-as-main action); **Products** = computed `dense`/`mesh` + DEM/ortho
  (the app made it, a re-fuse/rebuild may replace it); **Reference Data** =
  `imported:true` clouds + imported rasters (evidence; the pipeline never
  overwrites it). The discriminator is the already-persisted `imported` flag
  (now also set + persisted on a COLMAP-imported *sparse* cloud, which renders
  an "imported" chip). Sidebar computes the three lists and the sections stay
  dumb; the shared row rendering/rename/context-menu lives in one `CloudRows.vue`.
  The Ribbon stays as-is — its groups are verbs, not these nouns.
- **The ribbon CHOOSES; a floating toolbox RUNS.** The ribbon opens a dialog, enters
  a mode, toggles a display option or sets a display value (stepper). Everything
  done *inside* a running tool lives in that tool's toolbox over the view, built on
  `components/viewers/FloatingToolbox.vue` (title, drag, ×; body controls from
  `toolbox.css`): mask and point editing, 3D selection, raster measuring, Region,
  Orient model, point-pair alignment. Do not put command buttons on a viewer
  outside a toolbox; passive status (count, zoom %, legend) is fine. Keyboard
  shortcuts stay with the owning viewer/App, which order them (Esc clears a
  selection before it leaves the tool). The ribbon's command TABLES are pure data in
  `core/help/ribbonTabs.js` (Ribbon.vue only renders them): a menu (`menu: [...]`,
  PowerPoint's "Shapes ▾") per object family keeps the Tools tab a fixed width
  however many tools exist. A greyed row prints its reason inline and a menu never
  hides a row by state. The menu is teleported because `.ribbon-body` scrolls
  horizontally, which clips an absolute child. **Gating has ONE table**
  (`core/help/commands.js` `NEED_CHECKS`): commands declare `needs: [...]` and
  the ribbon and the console both read App's `commandState`, so they cannot
  disagree. `ribbonTabs.test.js` pins the keys, the icons and console parity.
  Tool-driven 3D picking is Viewer3D's `pickMode`/`markers` props + `pick` event
  (`core/products/screenPick.js`: front-most drawn point within a few px, reported
  as its exact Float64 source position); toolboxes for the 3D view go in its
  `#toolbox` slot.
- **Shared modal framework** (`components/modals/ui/`): every pipeline-stage modal builds
  from `ModalShell` (overlay/header/close/footer; preserves esc + click-backdrop close, so
  `useModalEscape` is unchanged), `SettingsField`/`SettingsGroup`/`AdvancedDisclosure`/
  `SegmentedControl`/`WarnBox`/`PresetCards`, all consuming a shared `modal.css` via
  `<style scoped src>`. The three tabular **file-import previewers**
  (`Camera`/`Gcp`/`FootprintImportModal`) are a **separate** family — wider own
  chrome, a header/rows table with per-column role assignment — sharing
  `ui/import-modal.css` the same way; don't try to fold them into `modal.css`.
  Rules a component never renders are inert (scoped CSS), so put anything genuinely
  shared in the shared file and let each modal declare only the selectors whose
  *values* differ (`.modal` width, the `.controls` grid). **A shared value plus a
  per-modal "undo" rule is worse than not sharing at all.** The **Evaluate** tab is one **Quality Report hub**
  (`QualityReportModal.vue` — wide own-chrome modal, left section nav + an Overview
  landing page; section bodies are `components/modals/eval/Eval*Section.vue`, NOT
  `ModalShell` wrappers, so each imports `../ui/modal.css` itself). A greyed nav entry
  (prerequisite data missing) with a hint IS the discoverability mechanism — there is no
  per-view ribbon gating any more; the ribbon buttons just deep-link into hub sections.
  Sections + the HTML export are assembled from ONE plain snapshot by
  `composables/useQualityReport.js` (Overview health rows + `buildExportReport`) so they
  can't drift. These read-only views share `ui/DataTable.vue` (sortable table,
  nulls-sort-last both directions, `cell-<key>` + `expanded` slots) and `ui/StatTiles.vue`
  (headline stat strip) — these are NOT settings modals, so `PresetCards`/`SettingsField`
  do not apply. `.btn`/`.btn-primary` live in global `style.css`. **Gotcha**: a
  field control (`.field-input`/`.field-select`) is passed as *slot content* — compiled in
  the parent modal's scope — so the modal must import `ui/modal.css` in its own
  `<style scoped src>` for those classes to apply (SettingsField's scoped styles don't reach
  slotted content). **Layout pattern** (redesign): `PresetCards` is the hero (label+blurb
  cards, one always active; deviation shows a "· modified · Reset" status, NOT a clickable
  Custom chip) → `AdvancedDisclosure` (its initial open state is the persisted
  `advancedSettingsExpanded` preference, `useUiSettings`, wired in Settings ▸ Display) →
  fields grouped under named `SettingsGroup` headings. Hints stay one line; long prose goes
  to the glossary (a `<GlossaryTerm>` in the label) or a per-selection hint, never an
  overflowing `<option>`. Presets are per-modal `*_PRESETS` deltas over the defaults +
  a `*_PRESET_META` card list (medium ≡ defaults); a modal with a first-class quality
  field instead of deltas (`DepthMapsModal`'s `quality`) drives `PresetCards` off that
  value directly (no Custom). `ReconstructModal` is the reference template. **GPU is not a
  per-modal knob**: the experimental WebGPU opt-in lives in Settings ▸ Compute
  (`useComputeSettings.useGpu`); MatchFeatures + DepthMaps inject it at `run()`.
  The same composable owns the machine-level dense memory gate: automatic values come
  from pure `deviceBudget` fed with optional browser readings, while a saved manual value
  remains an explicit override; dense modals consume its resolved `memBudgetBytes`.
  Dataset-derived modal prefills use one path: `useDatasetRecommendations` profiles the
  live stores (U1) and calls the C1-backed recommender (U2), which hands each stage a
  `{ knob: { value, reason } }` slice. **A recommendation is never its own banner** — a
  block above `PresetCards` competes with the hero for the same decision and restates
  fields the form already shows, with the reason (its only new information) truncated.
  It is surfaced *on the control it concerns*, three shapes, chosen by what was derived
  (`core/recommendUi.js` is the pure side, `composables/useRecommendedPreset.js` the glue):
  when the derived knobs are the ones the quality presets tune it becomes **one more
  preset card** (`recommendedPresetCard` → detection; checked first in the parent's
  `activePreset` loop since it is the more specific claim); when a card already exists per
  recommended value it **badges that card** (`badgePreset` + `PresetCards`' `note` →
  depth-map quality — a second card would offer the same setting twice); when the knob is
  orthogonal to the presets it is an **inline link under that field** (matching's pairing
  strategy). Selecting/applying is the only mutation and logs value + reason; nothing
  changes on open. Eligibility stays against the STATIC defaults, never the live modal
  values — a card whose contents depended on what the user already typed would change
  meaning under them. A stage with nothing derived (dense fusion, and SfM's
  `refineIntrinsics`, which only restates `auto`) gets **no** affordance; SfM's reason
  instead extends the self-cal field's hint, since it explains but can't offer an action.

## Project storage: `.websfm` files + folder-backed projects
Both features fall out of one fact — the per-project OPFS directory
(`project.json` + `images/` + `matches/` + `recon.*.bin` + …) is already a
self-contained, file-based project format.
- **UI home**: every project-*scoped* command (new, open file/folder, rename,
  save a copy, storage migration, delete) lives behind the project button's
  `ProjectPicker` — new/open in the footer, per-project actions in the row's
  `⋯` / right-click menu. The ribbon keeps exactly one entry, `Other ▸ Project ▸
  Save a Copy…`, and it is deliberately **not** labelled "Save": work is
  continuously autosaved into OPFS, so the only thing a user can "save" is a
  portable copy. Save/migrate act on the **open** project only (they need its
  root registered), so those menu entries are shown disabled with the reason on
  other rows rather than hidden. Don't re-add project I/O to the ribbon.
- **Save/load** (`Other ▸ Project ▸ Save a Copy…`, the picker row menu, or drop
  a `.websfm` on the window) is a
  zip/unzip of that directory: `core/io/projectArchive.js` holds the pure rules
  (manifest build/validate, what's included, per-entry compression, entry-path
  safety, the 4 GB pre-flight), `utils/projectFile.js` the fflate + OPFS + save-
  picker I/O, `useProjectsStore.exportProject/importProject` the index side.
  Both directions **stream** — a 3 GB project must never be assembled in memory;
  peak is one entry. Entry 0 is always `manifest.json`, which is what lets
  `peekArchiveManifest` validate (and reject a newer-format file, or a COLMAP
  `.zip`) after a few kB instead of a multi-GB unpack-then-reject. `log.ndjson`
  is never archived (session record, not project data); `images-derived/`,
  `depthmaps/`, `products/` are the opt-out "cached & derived" set — safe to drop
  precisely because restore heals all three. Import always lands in a **fresh**
  `crypto.randomUUID()` project (internal uuids are project-scoped, so nothing
  needs rewriting but `project.json`'s own id). **We write plain ZIP, not ZIP64**,
  hence the hard 4 GB ceiling and an explicit pre-flight rather than a corrupt
  file at the boundary.
- **Folder-backed projects** swap the root `FileSystemDirectoryHandle`: OPFS and
  `showDirectoryPicker()` handles expose the *identical* async API, so
  `opfs.setProjectRoot(id, handle)` is the whole mechanism and every other helper
  in opfs.js is untouched. The on-disk layout is byte-identical to the OPFS one,
  which is what makes the zip export, migration (a plain tree copy) and the single
  restore path all work unchanged. Chromium-only — `core/io/folderProject.js`
  `folderStorageSupported()` gates the UI, OPFS stays the default and the fallback.
  Invariants: the project **index** (`websfm/index.json`) always stays in OPFS
  (it must be readable before any folder permission exists); the directory handle
  lives in IndexedDB (`utils/handleStore.js` — localStorage physically cannot hold
  one, a handle is structured-cloneable, not a string); an index entry's
  `storage: 'opfs' | 'folder'` is absent on old projects ⇒ opfs. **Opening a
  folder project must consult `openPlan(id)` before `switchProject`** — it
  registers the root when permission is already granted and otherwise returns
  `reconnect` / `repick`, because `requestPermission` needs a **user gesture** and
  a silent retry is simply rejected (FolderReconnectModal supplies the button).
  **websfm never deletes files on the user's disk**: deleting a folder project
  forgets it (`opfs.deleteProject` enforces this, not the call site), and "move
  into browser storage" copies and detaches. Only the OPFS source tree is deleted
  after a migration, and only once `copyVerified` matches file count *and* bytes.

## Stores (`src/stores/`)
- **`projectStores.js`** — registry. Project-scoped stores register via
  `registerProjectStore()` and implement `restore(ctx)` / `clear(opts)`;
  `restoreProjectStores` / `clearProjectStores` fan out. `images` + `sensors` are NOT in
  the registry (bespoke signatures + strict order) — App.vue drives them manually:
  **sensors restore before images** (EXIF auto-grouping reacts to the image list).
- `useImagesStore` — source images, keypoints, masks, depth maps, sensor assignments.
  `sync()` writes the whole `project.json`.
- `useImagesStore.imageGroups` + per-image `groupId` (top-level `imageGroups` in
  project.json; absent ⇒ none) are **display-only folders** for the sidebar list
  (`utils/imageGroups.js`). The pipeline never reads them and they never reorder
  `images` — sequential matching takes that order as capture order. Sensors are the
  grouping that *does* reach the solve (shared intrinsics); keep the two separate.
- `useMatchesStore` — pairwise matches; `pairId = sorted([uuidA,uuidB]).join('--')`.
  Entries carry a persisted `disabled` flag (`setPairDisabled`) — a reversible user
  exclusion of an obviously-wrong pair; disabled pairs are filtered out where
  reconstruction reads the store (`useReconstructionStore` pair marshalling) and
  don't count as `verified` in `matchStats`. Toggled from `MatchListModal` (list
  row / preview / graph-edge double-click; `MatchGraph.vue` is the graph view).
- `useReconstructionStore` — the store file itself keeps cloud state, the pipeline
  runners (reconstruct / depth / densify / mesh / DEM / ortho / editClouds) and
  persist/restore; four concerns live beside it in **`stores/reconstruction/`** —
  `cloudSerde.js` (cloud ↔ on-disk shape, incl. the CSR view-track layout and the
  legacy readers; round-trip tested), `depthMapCache.js` (the lazy depth-map cache
  + its persistence), `georeferencing.js` (the SfM→CRS fit + accuracy reports),
  `scaling.js` (the scale-bar fit + per-bar residual report + staleness).
  They are composed *in place* of the code they replaced, so every consumer still
  sits below them — moving a factory call up will TDZ. Its public surface is
  unchanged by the split and 17 files depend on it: **treat the setup `return`
  block as the API** and diff it against HEAD after touching this store.
  Clouds (sparse + dense), depth-map cache (`shallowRef`,
  persisted + lazily loaded — see the depth-map persistence note under Pipelines ▸ 4),
  georef fit, run summaries; runs reconstruct / computeDepthMaps /
  densify / generateDem / generateOrtho. Multiple `kind:'sparse'` clouds can coexist
  (a computed reconstruction alongside a COLMAP import); `selectedCloudId` is *viewer
  focus*, but downstream stages (dense / DEM / ortho / export / the sensor table)
  consume the **main** sparse cloud — `mainSparseCloud` (getter: `mainSparseId` else
  first sparse). Invariant *exactly one sparse cloud is main whenever any exists*
  (`ensureMainSparse` after delete/restore; `setMainSparse` = sidebar "Set as main").
  `upsertSparseCloud(cams, pts, opts)`: reconstruct replaces the main in place
  (`replaceId` defaults to it); import passes `replaceId:null` to add a new cloud,
  `asMain` only when none exists. `mainSparseId` persists in `reconstruction.json`
  (absent ⇒ first sparse, back-compat). **Cloud shape differs by kind**: a
  `kind:'sparse'` cloud is an array of `{x,y,z,color,views,viewsPx}` point objects
  (it carries per-point tracks); a `kind:'dense'` cloud is **flat** —
  `{ count, pos:Float32Array|Float64Array(3N), col:Uint8Array(3N), nrm?:Float32Array(3N) }`
  (`DenseCloud` in `types.ts`), no per-point objects (millions of fused points as
  objects was the OOM's main-thread tail); a `kind:'mesh'` cloud is a flat indexed
  triangle mesh — `{ count /* triangles */, nVerts, pos:Float32Array|Float64Array(3·nVerts),
  idx:Uint32Array(3·count), col:Uint8Array(3·nVerts) }` (`MeshCloud`). Every dense
  consumer branches on kind (`Viewer3D` constructs relative Float32 render buffers
  for `THREE.Points` or an indexed `THREE.Mesh`; authoritative imported/global
  coordinates remain Float64 through editing and persistence;
  `cloudToPly`/DEM marshalling/persist accept dense+sparse, `meshToPly`/`meshToGlb`
  handle mesh; sidebar count = points, or triangles for a mesh; DEM/ortho/densify
  input pickers select `kind:'dense'` so mesh clouds are never a source). On-disk
  dense/mesh `pos` is widened to Float64 to share the sparse sidecar format;
  `posType` retains computed Float32 storage without narrowing Float64 imports.
  Reconstruction version 3 commits immutable sidecar generations through metadata
  (`binaryFiles`), while legacy inline/version-2 documents remain readable. Dense
  `nrm` (Float32 3N world-space normals, the Poisson mesh input — reused PatchMatch
  plane normals) and mesh `idx` are extra per-cloud sidecar bins (`nrm`/`idx` keys),
  **absent on old projects ⇒ undefined, do NOT heal** (legacy object-shape dense
  clouds still heal via a back-compat path on restore). An **imported** dense/mesh
  cloud (`importCloud`, from a dropped/picked PLY/LAS/XYZ — parsed by the `io`
  worker op, transformed by `applyImportTransform`) carries `imported:true` (persisted)
  and is never touched by a re-fuse/re-mesh (`upsertDense/MeshCloud` skip `imported`
  clouds) — coordinates land verbatim in the current frame, no CRS reprojection.
- **`useExternalStore`** — imported **reference rasters** (georeferenced DEMs /
  orthophotos the user brought in, never produced). Two invariants carry it:
  (1) **loading is lazy** — `restore` reads only `external/index.json` (metadata
  + a ≤1024 px preview PNG); `ensureRasterLoaded(id)` hydrates the plane from
  `external/{id}.bin` on first sample/draw, because a REMA tile is hundreds of
  MB and eager loading would undo the dense memory budget. So **any "do we have
  a reference DEM" gate reads `hasReferenceDem`/`rasters` (the index), never
  `sources`** (empty on a fresh reopen) — the same trap as `depthMapCount`.
  (2) **the raster keeps its native CRS and the *query* is reprojected**
  (`toRasterCoords`/`toProjectCoords`); warping the raster at import would
  resample once, cost minutes, and have to redo itself on every `handleSetCrs`.
  A failed projection lookup sets runtime-only `crsUnresolved` (never persisted);
  restore/use retries it and clears it on success. While unresolved, sampling and
  map placement return/refuse safely — never fall back to an identity transform.
  The original file is also kept (`external/{id}.src`) because "Treat as DEM /
  orthophoto" is a **re-decode**, not a relabel (a DEM plane is Float32
  elevations, an ortho plane is RGBA). `verticalDatum` + `verticalAccuracy` are
  first-class: `sampleReferenceDem` returns the declared σ alongside the value,
  and `useGcpsStore.fillZFromReferenceDem` **refuses** to fill a Z from a raster
  with no declared vertical accuracy rather than let a GCP claim survey-grade Z
  in the BA anchor / Horn fit.
  (3) **map display draws the preview, never the plane** — `onMap`/`opacity` are
  persisted view state (`setRasterOnMap`/`setRasterOpacity`, `mapRasters` getter),
  and `ViewerMap`'s raster `LayerGroup` renders each raster's `previewDataUrl`
  (already in the index) as an `ol/source/ImageStatic` over `rasterBounds` **in the
  raster's native CRS**, letting OL reproject on the fly. So the map layer calls
  `ensureRasterLoaded` never — showing a REMA tile costs no decode, and this
  survives `handleSetCrs` with no resampling, for the same reason the sampler
  reprojects the query. The group sits above the basemap and below every project
  vector layer, so GCPs/footprints stay legible; sidebar list order is draw order.
- `useProjectsStore` — the project *index* (not content): list, current id, CRS,
  plus `.websfm` export/import and the folder-backed-storage actions
  (`openPlan` / `reconnectProjectFolder` / `createFolderProject` /
  `adoptFolderProject` / `moveProjectTo{Folder,Browser}`). See
  "Project storage" above.
- **`useScaleBarsStore`** — scale-bar *evidence* (`scalebars.json`): items
  `{ id, name, a, b, knownDistanceM, accuracyM, displayUnit, enabled }` with each
  endpoint `{ kind:'marker'|'camera', id }`. Metres are canonical; `displayUnit`
  (mm/cm/m) only records what the user typed, and `updateBar` is the single
  conversion boundary. The derived fit is NOT here — see Scale & units.
- **`useWorkflowsStore`** — project-owned visual recipes + the latest 30 immutable
  run snapshots (`workflows.json`). Global templates are machine-level preferences
  in localStorage; applying one makes an independent project copy, so editing a
  template never mutates an old project. `core/workflow.js` is the versioned pure
  schema/registry/preflight/text boundary; `useWorkflowRunner` executes automatic
  blocks through `usePipeline` and pauses interactive blocks over the existing
  ribbon command—never duplicate a command modal or a stage runner in the builder.
- `useSensorsStore`, `useGcpsStore`, `useFootprintsStore`,
  `usePosesStore`, `useModalsStore`.

## Pipelines
1. **Detect** (SIFT, `crates/sift`) → keypoints (+colours) + 128-d descriptors.
   Near-duplicate keypoints (one strong blob firing as a DoG extremum across
   adjacent scales/octaves → several index-distinct points within ~2px) are
   suppressed at detection (`suppress_duplicate_positions`, response-desc NMS);
   `detect_sift` output carries **two** trailing sentinels (`raw_found`,
   `suppressed`), so parse `kept = floor((len-2)/STRIDE)`. An extremum with a
   second strong orientation peak yields **orientation siblings** — keypoints with
   bit-identical x, y, scale and their own descriptors (`max_orientations`,
   `DETECT_TUNING.siftMaxOrientations`; default 1, so siblings appear only when it is
   raised). Bit-identical position IS the sibling
   test everywhere: both duplicate suppressions (crate + tiled `nmsByPosition`) exempt
   siblings from each other, and `useMatchesStore` folds every putative onto the
   dominant index right after descriptor matching
   (`core/features/orientationSiblings.js`) — **nothing downstream of matching may
   see two indices for one physical point**, or a track splits into two the merge
   refuses to join.
2. **Match** (`crates/matching`) → Lowe ratio test + RANSAC fundamental-matrix
   verification (**adaptive termination**: after each new best model the iteration
   cap shrinks to `ln(1−0.99)/ln(1−wˢ)` for inlier ratio `w`, s=8 for F / 4 for H,
   so clean pairs finish in <100 iters and only junk runs the full cap), with an
   inlier-**ratio** gate (rejects spurious epipolar fits on repetitive structure)
   and a **positional-spread** reject (`core/features/verify.js` `inlierSpread`,
   gated in `useMatchesStore`): drop a pair whose accepted inliers collapse to few
   unique locations (many-to-one convergence) or a pinhead region (epipole
   degeneracy) — signatures no count/ratio/H-F gate can see. The H-vs-F degeneracy
   count is a **seed-quality label only, never an accept gate** — so
   `verify_matches_hf`'s `h_skip_below` (wired to the store's `minMatches`,
   `verify.js` `hSkipBelow`) skips H entirely for pairs below the hard acceptance
   floor: they're rejected regardless of H, and the resulting H/F ratio of 0 is
   never read. Keep that param ≤ `minMatches`, or a still-accepted pair (incl. the
   low-ratio absolute-inlier override) gets mislabelled non-degenerate. Two cheap
   prefilters cut the exhaustive O(N²) cost: **preselection**
   (`core/features/preselect.js`, horizontal k-nearest by imported or EXIF-derived
   camera position; geographic coordinates first enter one local metric frame) prunes
   pairs before matching *when poses exist*; the **subset gate**
   (`core/features/subsetGate.js`, brute-force only) handles the no-poses case —
   before the full match, match a small spatially-uniform keypoint subset
   (`pickSpreadIndices` grid-buckets so a repetitive façade doesn't collapse the
   sample onto its few strong blobs) and skip the O(Na·Nb) full match if too few
   survive, keeping exhaustive *coverage* (loop closures still found anywhere in the
   graph) at a fraction of the per-pair cost. `matchAll` runs on a concurrency-limited
   worker pool with a per-run descriptor cache. The accept/weak/reject decision is a pure
   function (`core/features/pairGate.js` `evaluatePairAcceptance`); its floors are
   **decoupled** (`minMatches` = accept + H-skip floor; `MATCH_TUNING.rawSkipFloor`, clamped
   ≤ minMatches, = the raw-putative skip) so raising one never severs the graph. A valid-F
   pair with ≥ `weakMinInliers` inliers but below the accept gate is kept flagged **`weak`**
   (persisted, marshalled) — a **PnP registration bridge only**: `sfm.js` feeds it to
   `register.js` correspondence collection (`corrPairs = strong + weak`) but never lets it
   seed init/triangulation. `verifiedPairs`/`matchStats` exclude weak.
   **Brute-force NN has two backends with one decision rule.** WASM (`crates/matching`
   `match_descriptors`) does it all; WebGPU (`workers/gpu/matchGpu.js` + `match.wgsl`,
   behind Settings ▸ Compute "Use GPU") returns only per-row/per-column top-2 and
   `core/features/nnSelect.js` `selectMatches` applies the crate's rule (s-space, f32,
   lowest-index ties, ratio on squared distances). Both read cross-check's B→A
   column-wise off the **same** A·Bᵀ — never a second scan. A change to the rule goes
   to the crate and `nnSelect.js` together; `nnSelect.test.js` pins them bit-exactly on
   integer descriptors. The store-side router (`stores/matching/gpuMatchRun.js`)
   validates each run's first pair against WASM, sends each image's descriptors to the
   pinned GPU worker once (per-run LRU; a miss returns `{ needs }`), and falls back to
   WASM per pair on any error. RANSAC verification is WASM either way.
3. **Sparse SfM** (`core/sfm/sfm.js`): **no pre-SfM pair filter.** A rotation-cycle
   consistency filter (drop pairs whose relative rotation fails the graph's triangles)
   was removed 2026-10-06 after an audit against finished models: the pairwise rotation
   it judged (E from a matching-time F and the nominal K) is wrong on many *true* pairs,
   so it dropped 51 true pairs for 0 false on South Building and changed no point count.
   A false pair is caught downstream instead — the two-gate PnP, the track filter and
   the robust BA. Do not reintroduce a graph filter on F-derived rotations without
   re-auditing it against a final model (HANDOVER ▸ B-bench). Pick init pair (`core/sfm/initPair.js`: score = cheirality-surviving points ×
   graph connectivity ÷ a gentle init-reprojection penalty, with **parallax as a
   gate, not a ranking** — flat between a soft band above `minInitAngleDeg` and a
   grazing knee; a ranked parallax term near the floor swings scores 4.7× on
   sub-degree differences and picked B4's 19-camera seed over its 122) and grow the model
   by **incremental registration** (`core/sfm/register.js`, `registerImages(ctx)`):
   each pass orders the unregistered images by a next-best-view score
   (correspondences to well-triangulated, spatially-spread points) and registers by
   two-gate PnP — a P3P + MSAC + Gauss-Newton solve (`crates/reconstruction/src/pose.rs`)
   accepted only if it clears an inlier-**ratio** gate at the PnP threshold AND, after
   the pose polish, a second ratio gate at the *tight* reprojection threshold (a pose
   that only holds at the loose gate is deferred to a later, better-constrained pass).
   Correspondences are swept once per pass and cached (reused for scoring + the attempt
   until a registration grows the model). If a sweep stalls with images still linked to
   the model (short film strips), a one-shot **rescue** runs a focal-only BA +
   retriangulation and retries once with a relaxed recheck (`rescueStalled`). Then track extension, then LM bundle adjustment
   (`bundle.rs`: Schur complement, analytic Jacobians, adaptive Huber; optional
   shared per-sensor intrinsics refinement via `refineIntrinsics`), retriangulation
   + split-track merging (`retriangulatePairs`/`mergeSplitTracks`), and 2-pass track
   filtering. A verified match has three cases and each has ONE home in
   `core/sfm/tracks.js`: both endpoints on points → `mergeSplitTracks`; neither →
   `retriangulatePairs`; exactly one → `completeTracks` (registration's
   `foldOneEndpointMatches` is one round of it over the live index; the final stage
   runs it to a fixpoint). Brown–Conrady distortion (`core/sfm/distortion.js`) is removed once at
   ingest so the whole pipeline stays pinhole — `projectPoint`, the track filter,
   reprojection stats and the dense/ortho warp all assume it. A sensor declares which
   coefficients it uses via a **distortion model** (`DISTORTION_MODELS`:
   pinhole/radial/radial2/brown; `distortionOf` applies only the active model's
   coefficients; undefined ⇒ all five, back-compat) — chosen in `SensorTable.vue`.
   BA **self-calibration** is **on by default**. `bundle_adjust`'s refine terms are a
   **bitmask** (`bundle.rs` `refine_mask`: 1=f, 2=cxcy, 4=k1, 8=k2, 16=k3; JS parses a
   comma string via `refineModeMask` — output intrinsics are nCam×7 `[fx,fy,cx,cy,k1,k2,k3]`).
   `refineIntrinsics` defaults to `'auto'` (`defaults.user.js`): when no sensor carries a
   calibrated distortion model (EXIF-only / film scans) `sfm.js` runs a **staged schedule**
   (`core/sfm/selfCalSchedule.js`) — base `f,k1` during registration, escalating to
   `k2`/`cx,cy`/`k3` in the post-filter passes as cam+obs counts clear each gate; `'none'`
   when a calibrated Brown model already removed distortion at ingest (don't double-correct).
   An explicit comma string bypasses staging. **Camera count never decides whether a radial
   term is refined** — only multi-view track redundancy does (`distortionIdentifiable`): a
   2-view track absorbs any k1 into its own depth and fits perfectly, so a model can sit far
   past any camera threshold and still constrain nothing. BA then *lowers its cost* while the
   focal runs away (B4's P1180211 seed: fx 2389 → 4796), which `runBundleAdjust`'s cost-only
   divergence guard cannot catch, and the fold bakes it into the keypoints. There are **two**
   BA call sites and the guard must be at both — `sfm.js`'s post-filter passes and
   `register.js`'s interim/rescue solves (`distortionCalMinCams` is a cheap pre-filter there,
   not the decision). **Pinhole-fold invariant**: radial coeffs must
   never be left on the model (nothing downstream applies them). After each self-cal pass
   `runBundleAdjust` **folds the full `{k1,k2,k3}` bag** out of the keypoints (`undistortPixel`
   is the exact inverse of BA's forward model), resets the model coeffs to 0 (cx/cy stay on
   K), and records the **composed** distortion per sensor via a pristine-keypoint snapshot +
   linear-LSQ fit (`core/sfm/selfCalCompose.js` — NOT an additive per-pass k1 sum, which is
   wrong beyond first order) into `summary.selfCalDistortion` (`[{sensorId,k1,k2,k3,fitRmsPx}]`).
   Dense reproduces it as a **second bag** applied after any calibrated `dist` (`workers/ops/
   dense.js` `distortComposed`), so the raster frame matches the sparse cloud. Heavily
   instrumented via `onLog` (toggle "Detail"/debug in DevConsole).
   - **Film-scan interior orientation** (F4, `core/sfm/fiducials.js`): scan
     geometry, like lens distortion, is removed **once at ingest** — a `kind:'film'`
     sensor's calibrated fiducial marks (mm) + each image's clicked scan-pixel
     observations fit a per-image affine `scan px → mm`, from which one **canonical
     pixel frame per sensor** (median fitted pitch) gives a single shared K. Sparse
     ingest moves the worker's keypoint copy `scanToCanonical` (store keypoints stay
     in **scan space** — viewer/GCP marking assume it), stashes the canonical K on
     `sensor._fiducialK` (resolveK **path 0**), remaps GCP observations the same way,
     and records each `{A, frame}` in `summary.fiducialTransforms`. Dense reproduces
     that exact transform (never re-fits) via `canonicalToScan` composed into its
     raster+mask sample map. Everything between stays pinhole.
     Detection and calibration are now separate domains. Anonymous scan-pixel
     centres live in `image.fiducialDetections[{slot,px,py,...}]`; metric identity,
     camera coordinates, focal/principal point and the slot map live in
     `sensor.fiducialCalibration`. `core/sfm/fiducialDetection.js` must remain free
     of calibration/layout imports: it searches declared corner/side slots with
     Generic/right-angle/45°/Frame image prototypes, then the worker refines native
     crops. `useImagesStore.detectFiducialsForSensor` learns anonymous batch donors,
     queues uncertain candidates for review and can derive border masks. The
     independent `FiducialCalibrateModal` imports certificate coordinates or
     estimates a batch layout; `core/sfm/fiducialCalibration.js` validates
     conformal/affine/projective fits. Reconstruction is the join point via
     `calibratedFiducialPairs`; detections without calibration never alter SfM.
     Legacy `fiducialObs`/`sensor.fiducials` migrate on restore (the old
     layout-driven detector was deleted 2026-10-04). `fiducialDetection.js`
     (anonymous slots) is a **policy** over the primitives in
     `core/sfm/fiducialPrimitives.js` — analytic prototype, film-frame estimate,
     best ZNCC peak; `fiducialDetect.js` is the ZNCC template matcher behind the
     batch retry. Two policies once kept forked copies of those primitives and
     drifted into two live bugs; add shared math to the primitives, never a policy.
     **A wrong-but-confident mark is caught by geometry, never by its own score**
     (`core/sfm/fiducialConsensus.js`, run by `detectFiducialsForSensor` once the
     whole batch is in) — its ZNCC looks healthy. Two independent checks: across
     images, a slot sits at the same frame-relative place in every scan of a flight,
     so a data-strip blob disagrees with the batch (`fiducialBatchConsensus`, ≥4
     images); within one image, the layout is centrally symmetric and an affine scan
     keeps midpoints, so opposite marks' midpoints must coincide
     (`fiducialShapeCheck`). Both demote to the review queue, never delete, and both
     judge the same unfiltered snapshot; donor templates come only from marks that
     pass both (a confident wrong donor becomes every retry's template). Same two rules as the
     dense cross-view filter: every slot's consensus is computed **before** anything
     is demoted (else image i is judged against i−1's already-thinned set, making the
     result order-dependent), and the batch uses **one** normalisation basis —
     frame-relative when every row has a usable film frame (one the detector itself
     trusts: `minFrameConfidence`), else raster-relative for all, since comparing the
     two is meaningless.
     **A ZNCC template must be odd-sized** — `znccAt` derives
     `half = (size−1)/2`, and an even size makes every pixel read a fractional
     index, i.e. `undefined` → NaN → a score of 0 that looks like an honest
     "no match" (`downscalePatch` forces odd; 65px ÷ 8 → 8 was the live bug).
     **A peak's ambiguity margin is measured against a spatially DISTINCT
     runner-up**: adjacent prototype sizes/variants all lock onto the same mark and
     score alike, so without the distance guard an unambiguous mark reports margin
     ≈ 0 and is rejected as `'two-peaks'`. Tests that neutralise the gate
     (`minPeakMargin: -1`) cannot see this — keep at least one case at the shipped
     default.
4. **Dense MVS** (`core/dense/mvs.js` + `crates/reconstruction/src/mvs.rs`): Stage A build
   per-image PatchMatch depth maps → optional `filterDepthMap` (median/speckle cleanup)
   → `filterDepthMapsGeometric` (cross-view consistency) → Stage B `fuseDepthMaps`
   (cross-view geometric consistency, then a **spatial dedupe**).
   `filterDepthMapsGeometric` is COLMAP's `filter` pass and the **only** filter that
   removes sky/vegetation: both have genuinely high NCC (a bush is strongly textured;
   gradient sky correlates at *any* depth), so no cost gate can ever reject them — they
   give themselves away only by cross-view depth *disagreement*. Per pixel it runs a
   forward–backward reprojection (unproject → project into a source → unproject **that
   source's own depth at that one pixel** → reproject home; error ≤ `maxGeomCost` px ⇒
   that view is consistent) and needs `minConsistent` such views, plus an absolute
   `minNcc` floor. A view also only votes at ≥ `minGeomAngleDeg` parallax: at ~0° the
   round trip returns home for any depth, so a near-duplicate view vouches for sky. Sampling one source pixel is what makes it strict, and is the
   difference from `fuseDepthMaps`' own check, which searches a
   (2·`consistencyPx`+1)² window and accepts if *any* pixel there is within tolerance —
   a noisy depth cloud (vegetation) passes that by chance. Fusion's check stays as a
   cheap second line of defence. It runs **once after the whole Stage A loop** (it needs
   every map's depth) and zeroes rejected pixels **in the maps**, so the persisted depth
   maps — and the ortho that reuses them as a z-buffer — are cleaned too, not just the
   fused cloud. **Invariant: evidence is read from the unfiltered planes** — rejections
   go to per-map masks applied only after every map is judged; filtering in place would
   make map i+1 judge itself against map i's already-thinned depths, cascading drops in
   map order (order-dependent, irreproducible). Its candidate views are culled per
   64 px block (frustum slice vs raster — an *exact* test) and walked nearest-first;
   neither may change a verdict, and `cull:false` is the reference a test pins it to.
   Do not speed it up by restricting candidates to `selectSourceViews`: that changes
   which pixels survive. The display PNGs are rendered pre-filter
   and are deliberately still the raw plane. Stage B also runs three **opt-out geometric outlier filters**
   (`DENSE_FUSE_DEFAULTS`): a **min-triangulation-angle** gate (widest parallax among
   agreeing views must clear `minTriAngleDeg`, kills ~0°-parallax sky), a
   **grazing-incidence** reject (`|n·(C−P)|` below `cos(maxIncidenceDeg)`; view-direction
   fallback normals are inert), and a post-fusion **isolated-cell removal**
   (`createVoxelAccumulator.filterIsolated` — lone low-support cells with too few occupied
   26-neighbours; the finalizers compact around zeroed cells). Both stages log per-image
   timing, depth range, cost distribution, and fusion cull breakdown ('Dense' category). A surface seen by k views yields k
   near-coincident "shell" points, collapsed in world space to one averaged point
   per voxel cell, sized by `autoMergeCell` at the median GSD (depth/fx ≈ one
   ground-pixel footprint). **Invariant — fusion must never materialize a
   per-pixel point-object list** (25–30 M boxed `{x,y,z,color}` ≈ 3 GB was the
   2026-07-12 OOM). Kept pixels stream **directly** into `createVoxelAccumulator`
   (SoA typed-array sums, numeric packed cell keys sized from a coarse scene bbox;
   a point outside that bbox spills into an exact string-keyed overflow map, never a
   clamp into the border cell, which collapsed thin tall features. Exact bounds are not
   the fix: one sky flyer would stretch the box and `clampCellForBounds` would coarsen
   the whole merge — `mergePointsSpatial` is the equivalent-but-batch reference kept for tests) and
   finalize straight to the flat wire buffer `[x,y,z,r,g,b]` per point. This makes
   `step` a **speed lever, not the density knob** — density is controlled by the
   merge cell in world units, and `step` defaults to 1 (full res in, dedupe out).
   Progress: depth maps emit fractional within-image ticks (pyramid-level weighted);
   fusion emits per-map (throttled). A **Stage B pre-flight**
   (`projectDensifyPeakBytes`, `memBudget.js`) projects the fusion peak (input +
   accumulator + output) from the real maps and the store refuses over budget
   **before transferring** the buffers (so a refusal keeps the depth maps). The
   store↔worker densify **transfers** the depth/cost/rgb buffers (no clone; strips
   `displayDataUrl`) and the op round-trips them home for ortho reuse. **Perf**:
   cost scales with overlap×sources×pixels²; levers are `maxDim`/`maxSources`/
   `iterations` (and `step` for the fusion sweep). **Quality** is gated by correct
   intrinsics — `resolveK` falling back to "default FOV" (fx=image width) directly
   distorts depth.
   - **Depth maps persist** (`depthmaps/`, the sole exception to "recompute rather
     than store" — Stage A is minutes/image). Pure codec: `core/dense/depthMapCodec.js`;
     I/O: `utils/opfs.js`; wiring: `useReconstructionStore`. A tiny `index.json`
     (dims/K/R/t per map + the stamp) plus per-image binary sidecars
     `{uuid}.{depth|cost|nrm|rgb}.bin`. **Load is lazy and that's load-bearing**:
     `restore` reads only the index into `depthMapsMeta`, and `ensureDepthMapsLoaded()`
     (called by densify + ortho) hydrates the planes on first use — eagerly loading
     hundreds of MB on every project open would undo the fusion memory budget. So
     **`depthMapCount` is a store getter over `depthMaps.size || depthMapsMeta.length`**;
     anything gating on "are there depth maps" must use it, never `depthMaps.size`
     (which is 0 on a fresh reopen). **Staleness**: depth lives in the main sparse
     cloud's frame, so the index stamps that cloud's `id` **and `createdAt`** —
     `upsertSparseCloud` carries the id forward on a rebuild but refreshes `createdAt`,
     so `createdAt` is the part that actually detects a re-run; a mismatch (or an
     unstamped index) discards the set. A map whose sidecars are **missing** (its image
     was removed) drops alone; a **corrupt** one (truncated / wrong size for the
     recorded dims) discards the whole set — a partial plane fuses into a silently
     wrong cloud. Writing does not detach buffers, so persisting after Stage A leaves
     the live cache usable for densify's transfer.
   - **Two depth-map backends**: WASM (CPU, default) and WebGPU (opt-in "Use GPU
     (experimental)" in the modal; ~0.1s/img vs minutes on CPU). `depthMapForImage`
     takes the kernel as an injected arg; the worker swaps in `computeDepthMapGPU`
     when `settings.useGpu` is set and an adapter exists, with per-image fallback to
     WASM on error. Lives in `src/workers/gpu/` (`device.js` lazy device singleton,
     `depthMapGpu.js`, `patchmatch.wgsl`): slanted-plane init, red-black checkerboard
     sweeps (in-place, one dispatch per parity), decaying random refinement (PCG RNG),
     best-K aggregation; sources packed into a `texture_2d_array` (sample coords
     clamped to each layer's valid (w,h)) + per-source pose storage buffer; one `main`
     entry driven by `ctrl` (mode/parity/iter). The worker A/B-validates GPU vs CPU on
     the first image and logs `GPU validate: … RMS …`.
5. **Products**: local vertical frame (`core/products/projection.js`, aerial Z-up auto-orient) →
   DEM (`core/products/dem.js`, binned heights + IDW fill, hillshaded preview) → orthophoto
   (`core/products/ortho.js`, true reprojection reusing the cached depth maps as z-buffer +
   colour). **The ortho reprojects onto a SURFACE, and the DEM is only one of them**
   (Metashape's Build Orthomosaic ▸ Surface): `orthorectify` walks a
   `{width,height,gsd,originX,originY,data,mask}` grid, so `core/products/surface.js`
   builds that same grid from the **mesh** (`meshSurface`, a from-above z-buffer
   rasterisation of the Poisson triangles — watertight ⇒ a dense mask, which is the
   cure for a patchy ortho, since every DEM hole is a transparent ortho cell) or from a
   robust least-squares **plane** (`fitPlane`/`planeSurface`, flat scenes), plus
   `resampleSurface` so the ortho's GSD is independent of the surface's (a coarse
   surface reprojects fine; the ortho wants image detail). The store's `orthoSurfaces`
   getter is the single source of what's available — the modal renders it and
   `generateOrtho` consumes it, exactly like `demSource`/DemModal. Two consequences:
   an ortho **carries its own geotransform** (`gsd`/`originX`/`originY`/`frame`/`crs`;
   the exporters must read it there, not off the DEM — older persisted orthos have
   none and fall back), and rebuilding a DEM only invalidates an ortho whose
   `surface` was the DEM. A mesh/plane surface's `{kind:'local'}` frame spec is a
   *request*, not a descriptor, so the payload must also carry cameras + a point
   sample — `buildLocalFrame` derives the up-vector from the scene.
   Optional georeferencing via `core/products/georef.js` (Horn 7-param similarity,
   SfM centres ↔ imported poses), or, for a project with no CRS, a **scale
   constraint** (see Scale & units below). Exports in `core/products/exporters.js` +
   `core/products/geotiff.js` (PLY, model JSON, DEM GeoTIFF/.asc, ortho GeoTIFF/PNG+.wld)
   through `ExportModal.vue`. Products persist to OPFS (`products/…`).
6. **Cloud editing** (`core/products/cloudEdit.js` + `workers/ops/cloud.js`, Tools ▸
   Point Cloud): crop (axis-aligned box, invertible, per-side-nullable bounds),
   filter (an **ordered** method chain — `range` → `voxel` → `isolated` → `sor`,
   each stage feeding the next, so the O(N·27-cell) neighbour sweep runs last over
   the smallest cloud), merge (concat + optional seam dedupe). Three invariants:
   (1) **dense clouds only** — a `kind:'sparse'` cloud's points carry the
   view-tracks dense/ortho/COLMAP-export read, so thinning one would silently
   invalidate the depth-map staleness stamp and the track stats; cropping the
   *model* is a different operation from cropping a *product*. (2) **Non-destructive**
   — every edit ADDS a cloud flagged `derived: true` (persisted; absent ⇒ false),
   which `upsertDenseCloud` skips exactly as it skips `imported`, while `imported`
   is *inherited* from the source so the sidebar's Products-vs-Reference split still
   holds. The one exception is the 3D viewer's rectangle/lasso selection
   (`mode:'mask'`, `core/products/screenSelect.js`): on a cloud that is *already*
   derived it replaces that cloud in place, because interactive cleanup is many small
   strokes and a full copy per stroke exhausts memory. Computed/imported clouds are
   still never touched — their first mask edit forks a derived copy. The mask is
   computed over the Float32 **render** buffer and the matrix that drew it (never
   re-derived from the Float64 source), so the highlight is the selection. (3) **`editCloud` never throws**: the store transfers the source buffers
   in, so a rejected call would leave the user's cloud detached — failures return
   `{ cloud: null, error }` with the inputs round-tripped home under `home[]`, and
   the store re-attaches those *before* any early return. `removeIsolated` is the
   standalone cousin of the dense accumulator's `filterIsolated` — it scores
   occupancy on a grid but keeps the original points (a cleanup, not a resample).
   The same op and store path (`editClouds` → `workers/ops/cloud.js` `MODES`) carry
   every Point Cloud ▾ / Mesh ▾ tool: normals, transform, ICP and distance (the last
   two take `[source, reference]`, the reference a cloud or a mesh —
   `REFERENCE_MODES`), section, and the mesh modes (`MESH_EDIT_MODES`). **Mesh edits
   obey the same three invariants**: a result with `idx` lands through
   `addDerivedMesh` as a `derived:true` mesh that `upsertMeshCloud` (a re-mesh) never
   replaces, and the flag is persisted for meshes too (`cloudSerde`). It was dropped
   on restore once, which would have let a re-mesh overwrite edited work. A tool that
   opens its result on a colouring passes `style`, or `style(extra)` to see the
   worker's small result record (the distance spread). **There is one neighbour
   search: `core/products/knn.js`** (an exact k-d tree). Normals, ICP and distances
   all use it. The grid in `cloudEdit.js` is for the filters' near-data sweeps only;
   far queries (another epoch, an unaligned ICP start) are what the tree is for.
   Lengths a tool shows or takes go through `core/products/cloudUnits.js`: model
   units for a computed cloud (metres via the frame), file units for an imported one.
7. **Mesh** (`core/products/mesh.js` + `crates/mesh`): **screened Poisson** over a
   dense cloud with per-point normals (`DenseCloud.nrm`, the PatchMatch plane normals —
   no separate normal estimation). **The source is `meshSource`/`meshSources`** (same
   contract as `demSource`: the modal renders it, the run consumes it). It defaults to
   the selected dense cloud, else the newest `derived` edit, else the first. Never mesh
   "the first dense cloud": edits are non-destructive copies, and that pick ignored
   every cleanup. JS conditions the input (spacing from the merge cell, or estimated for
   an imported cloud; robust-extent box; depth capped by spacing; stray pre-filter;
   voxel thinning that keeps each sample's **support weight** = raw points per voxel;
   positions relative to a local origin so Float64 survey coordinates survive the f32
   solve). The staged wasm `PoissonMesher` returns the flat buffer
   `[u32 nVerts, u32 nTris, f32 pos, u32 idx]` plus `stats()`, and its `finish` runs the
   cleanup that makes Poisson usable on photogrammetry (`MeshOptions`). That is support
   trimming relative to the median sample, hole refill relative to the *bordering*
   piece, and floating-piece removal by *samples explained*, not area (Poisson inflates
   a speck into a ball). Extraction is bounded by the support reach, so the hull is
   never built. Vertex colour is transferred from the nearest dense voxel cell. Output
   is a `kind:'mesh'` cloud carrying a persisted `meshSummary` run record (absent ⇒
   unknown), shown as a lit `THREE.Mesh`, exported PLY (faces) / GLB. Non-destructive:
   the worker round-trips the dense buffers home.

## In-app glossary (help)
Cross-linked term explanations. **Content**: `src/glossary/**/*.md` (organised into
topic sub-folders — `algorithms/`, `camera-sensor/`, `core-sfm/`,
`dense-reconstruction/`, `georeferencing/`, `products/` — the flat `id` is the key, so entries
link by id regardless of path, but the folder is kept as the entry's `topic`:
the modal home renders a **pipeline map** — stage cards (label/icon/blurb from
`GLOSSARY_TOPICS`) joined by arrows in workflow order, terms as clickable chips;
unknown folders appended after as plain sections), frontmatter
(`id`/`title`/`summary`/optional `aliases`) + markdown body; images under
`src/glossary/assets/`. `core/help/glossary.js` is the pure loader/renderer — parses
frontmatter, renders via `marked` + KaTeX (`$…$`/`$$…$$`), resolves `assets/*`
image URLs, and **auto-links** any occurrence of another entry's title/alias to
its tab (first hit per term; opt out one occurrence with
`<span class="no-help">…</span>`); also `getAllGlossaryEntries`/
`getGlossaryEntriesByTopic`/`searchGlossary`. (The `core/help/` *code* dir stays
"help" — it's a shared umbrella for glossary + `guide.js` + `commands.js`, and the
`help:` cross-link scheme + `renderHelpMarkdown` renderer are shared with Guide;
only the glossary-specific content folder and symbols carry the "glossary" name.)
**UI**: `<GlossaryTerm id>` (`components/glossary/`) wraps inline keywords —
hover shows `GlossaryTooltip` with a border **progress ring** that, once filled,
**pins** the popup (interactive: cross-links + "Read more"). The term itself is
not clickable; "Read more" opens the single centered tabbed `GlossaryModal`
(home/index + search + one closeable tab per term), driven by `useGlossaryStore`
(`isOpen`/`tabs`/`activeId`). Ribbon *Other ▸ Glossary* → `open-glossary` opens
the home page. Highlighting is gated by the persisted `glossaryTermsEnabled`
toggle (`composables/useGlossarySettings.js`, Settings ▸ Display). **Adding a
term**: drop `src/glossary/<folder>/<id>.md` (auto-registered by the recursive glob) — it auto-links
wherever its title/aliases appear; wrap UI text in `<GlossaryTerm id>` only where
you want an explicit hover affordance. **Wanted figures** are recorded in-place as
`<!-- TODO(image): assets/NAME.svg - what it must show -->` comments (grep them to
find the backlog); such a comment must contain no `>`, since `autoLinkHtml` walks
the rendered HTML as a tag/text stream and would end the pseudo-tag early — and the
schema block at the top of `reprojection-error.md` must contain no comment-*closing*
sequence either, since `stripLeadingComment` is non-greedy and would end the schema
block there, pushing the rest above the frontmatter (i.e. "missing frontmatter").
`glossary.test.js` pins both, plus id↔filename, a non-empty title/summary/body, and
that every explicit `help:` id resolves.

## Scale & units
An SfM model is up to scale. Four invariants carry the fix (METHODS.md §6.6):
- **Scale lives in the FRAME, never in the coordinates.** `frameFromScaledLocal`
  (`core/products/projection.js`) wraps a local frame with a scalar —
  `fromSfm(p) = s·base.fromSfm(p)`, `toSfm(c) = base.toSfm(c/s)` — and the basis
  stays **orthonormal**; scaling `east/north/up` makes `fromSfm`/`toSfm` stop
  being inverses, since `makeFrame` uses them in both directions. Rescaling the
  cloud instead would invalidate the depth-map staleness stamp and contradict
  every recorded `summary.*` number. The frame descriptor kind is
  `scaled-local` (worker: `workers/ops/products.js` `rebuildFrame`).
- **One resolver, `useReconstructionStore.effectiveFrameSpec`.** Evidence rank is
  `CRS georeference > scale constraints > none`; it returns
  `{ frameSpec, unit, scale, source, crs, stamp }` and every product builder,
  readout, report and export asks it. A scalar-only getter would not do —
  horizontal distance and Δz also need the resolved orientation. Two parallel
  unit systems is the failure mode this exists to prevent.
- **A fit is a CACHE, so it is stamped.** `reconstruction.json.scaleFit` carries
  `sourceStamp {id, createdAt}` of the main sparse cloud plus an
  `evidenceDigest` over the enabled bars and the marks of the markers they
  reference (`scaleEvidenceDigest`); `stores/reconstruction/scaling.js`
  `scaleFitStatus` refuses it when either moves, and `productFrameStatus` flags a
  DEM/ortho built in a frame the project has since left. Stale metres are worse
  than honest model units.
- **Never print a bare number, and never fabricate a metre.** With no scale a
  length reads `… model units`; a scale-bar project is **metric with NO CRS**, a
  combination that did not exist before — export paths write metric values and no
  CRS identifier (`crsInfo` returns null for `crs:'local'`, `geoKeysForEpsg(null)`
  writes user-defined). Never attach the project CRS just because the numbers are
  metres.
- **Orientation and region are model-frame data under the same rules.** A user
  orientation (Tools ▸ Model ▾ ▸ Orient model, `core/products/orientation.js`) is
  an explicit `origin/east/north/up` basis the resolver spreads onto the `local` /
  `scaled-local` frame spec (`frames.js` `orientationBasis` dep): it lives in the
  frame, never in the coordinates, a georeference outranks it, and its basis is part
  of `frameKey`. The region (`core/products/region.js`) is a model-frame box that
  bounds depth seeding, fusion and mesh/DEM input. Both are persisted in
  `reconstruction.json` with the main sparse cloud's `{id, createdAt}` stamp and are
  IGNORED when stale. Unlike the scale fit, a rebuild does not delete them: they
  stay visible as stale so the user can reapply them. Neither ever cuts an imported
  cloud, which is in its own frame.
Evidence vs derived state is split the same way GCPs are: the bar *records* live
in `useScaleBarsStore` / `scalebars.json`, the fit in `reconstruction.json`.
Bars **always** report a residual — including bars a georeference outranks (they
become checks), bars the user unchecked, and bars that cannot be measured (with
the reason). Nothing is dropped from the report, only from the fit.

## CRS / GCP / poses
Per-project working CRS (proj4). GCPs, footprints, and camera poses store positions in
the project CRS and are reprojected on CRS change (`handleSetCrs` in App.vue). See memory
`gcp-crs-architecture` and `works-in-antarctica`.

There are **three roles**, and the difference is a *constraint* boundary, not a
label: `control` (constrains georeferencing + anchored BA), `check` (surveyed,
deliberately withheld) and `marker` (image observations, **no** surveyed
position — a scale-bar endpoint). `core/io/gcp.js` **`isGroundControl`** is the
one gate every constraint site asks (georef fit, its LOO prediction, anchored BA,
the worker marshalling); it tests `role === 'control'` **explicitly**. Null
coordinates on a marker are useful representation, **not** the safety boundary —
a migrated/imported/edited marker with finite numbers must still not constrain
anything. `normalizeGcpRole` therefore round-trips `'marker'`, and
`useGcpsStore.addPoint({ role })` seeds a marker's x/y/z all null. **Never create
a control point and re-role it** — it keeps the coordinates it was born with,
which is why every create affordance is two explicit actions.

A GCP has surveyed ground coords (`x/y/z` + per-axis `accuracyX/Y/Z`), optional
XY/XZ/YZ correlations, accuracy provenance and vertical datum. Pixel observations
store `{ imageId, imageName, px, py, accuracyX, accuracyY }`; `accuracyImgX/Y`
are defaults for new marks. Enabled controls constrain the solve, checkpoints are
reported independently, and unknown/invalid covariance never constrains. GCPs are
created three ways: CSV import (`GcpImportModal`, surveyed ground control only —
that command stays aerial-only), the **Control & Markers** table's "+ Add control" /
"+ Add marker" (a control seeds `x/y = 0` with **`z = null`** until measured or
filled — zero is a valid sea-level elevation, never a missing-value sentinel; a
marker seeds all three null), edited inline — `useGcpsStore.addPoint({ role })`),
or **right-click in the image view**. That right-click opens `ViewerImage.vue`'s
general context menu (copy pixel/colour, zoom, fit) whose "Add control/marker
here…" entry switches the same popup to a new-vs-existing chooser ("New control
point here" / "New marker here" → `add-gcp` with the role; an existing name →
`mark-gcp`), both landing in `setObservation`. `sceneType` only **orders** the two
create actions (object ⇒ marker first); both are always one click away, because
the alternative — create then re-role — is the coordinate hazard above. The image view also shows a magnifier **loupe** (when the GCP
overlay is on) and each marker's **live reprojection error** from the accuracy
report; the sidebar's GCP detail lists per-image observations (jump-to-image +
remove), flags GCPs with <2 marks (unusable), and right-clicking a GCP row
removes it (`useContextMenu`). GCPs are removed only from the sidebar
right-click or the table's × — there is no add/remove button in the sidebar.
An observation's `imageId` is the authoritative "does this image exist" flag:
resolved by name at import/marking, then **re-resolved on every image-list
change** (`useGcpsStore.reconcileObservationImageIds`, a `watch` on the image
ids+names) so an observation for a not-yet-loaded image backfills its id (and
its jump-to-image link activates) the moment that image is added — and clears it
if the image is removed. The sidebar renders an observation as a clickable link
only when `imageId != null`, else a dimmed non-clickable label.
**Double-clicking a GCP** opens a multi-image inspector tab
(`components/viewers/ViewerGcp.vue`, `type:'gcp'` in `useTabs.openGcpTab`): one
panel per registered observation, each cropped + zoomed (shared zoom) to centre
the marked pixel under a crosshair, with the observation's reprojection error and
a jump-to-image link. Read-only — marking still happens in the full image view.
Removing a GCP closes its inspector tab (`removeGcpAndCloseTab` in App.vue).

**Guided marking** (`core/sfm/gcpGuides.js`, pure): once cameras are posed, a GCP
already marked elsewhere is constrained in every other registered image — to an
**epipolar line** (1 other observation; `fundamentalFromCams` builds F from the two
world→cam poses) or to a **single predicted pixel** (≥2, triangulate + reproject).
`gcpGuidesForImage` returns guides only for GCPs *not yet* marked on the target
image (a marked one already shows its reprojection error); `useReconstructionStore.
gcpGuides(imageId)` is the store entry point — it returns guides for *every*
unmarked GCP and the selection filter is applied at **draw** time, so switching the
selected GCP never re-triangulates. App.vue keeps a
`activeImageGcpGuides` ref refreshed on tab/marks/cloud/selection change, and
`ViewerImage.vue` draws them dashed green under the real markers (lines only for the
*selected* GCP — all of them at once is a spider web). Both the compute and the draw
gate on **`gcpEdit` alone, never `showGcps`**: a guide aids *placing* a mark, and
since enabling gcpEdit force-enables showGcps, an `||` of the two leaves guides on
screen after the user leaves edit mode. Two watchers feed one refresh (a shallow one
for tab/mode/cameras — `sparseCameras` must never be deep-watched — plus a deep one
for marks), and a single user action trips both, so the refresh is **coalesced to one
per tick** (`queueGcpGuidesRefresh`). `gcpGuides()` is **silent**: it recomputes on
every tab switch and re-render, so logging there narrates the app, not the user. The
one line worth emitting is App.vue's `logGcpMark`, fired per *placed mark* (the caller
grabs the guide before `setObservation` retires it) and reporting the **guide-vs-click
gap**; a debug-level companion brackets the mark with `gcpEstimateForImage` (store:
`gcpEstimate`) to show how far that mark moved the model's estimate, and which way.
That function is **not a guide and must never be drawn as one** — it *includes* the
target image's own mark, so it's the fitted estimate, not an independent prediction;
it exists only because the guide on the marked image retires, making this the one way
to observe the refinement where the user is looking. A "did not move" reading usually
means the robust fit **rejected** the new mark, not that refinement is stuck.
Guides are **advisory, never inputs to the fit**. **Marks are pixel-EDGE, keypoints
pixel-CENTRE**: a click on the middle of pixel i is stored as i + ½ (the viewer's
`toImagePixel`), while keypoints, K and projections put it at i. The half pixel is
applied only at the boundary — `displayFrame.js` `makeScanToPinhole` and sfm.js's
GCP ingest take marks in (−½), `makePinholeToMark` takes camera-frame positions out
(+½) for guides, estimates and Find-GCPs candidates. Storage never changes. (Worth
1 cm on GeoScan checkpoints; keypoint and residual overlays are still drawn ½ px
up-left.) **Marks live in scan pixels, cameras in the pinhole/canonical frame**: every GCP/marker triangulation (guides,
georef fit, accuracy report, scale bars, anchored BA) maps marks through
`core/sfm/displayFrame.js` `gcpsInPinholeFrame` first, and guides come back through
`guideToScan`. The per-image chain comes from ONE join, `makeFrameModelResolver`
(summary + sensors → `{ dist, selfCal, fiducial }`) — copies of that join had
drifted. Inside `sfm.js`, whatever moves an image's keypoints (ingest
undistortion, the self-cal fold) must move its GCP marks too (`moveGcpObs`).
**Never add snap-to-guide.** A guide comes *from* the reconstruction, so snapping a
mark to it feeds the model's estimate back in as ground truth; GCPs must stay
independent evidence that can correct the model, and the guide-vs-click gap is the
diagnostic — it matters most exactly when the reconstruction is wrong (METHODS.md
§6.4).

`core/sfm/gcpTriangulation.js` triangulates a GCP's registered-image observations
into the current SfM frame: a widest-baseline 2-view DLT **seeds** a Gauss-Newton
refinement (`refineGcpPoint`, pure JS) over *every* observation, so each extra mark
tightens the point. `opts.robust` adds outlier rejection — a Huber/IRLS fit, then a
median cut on **its** residuals (never on a plain-LSQ fit's: the outlier drags that
fit toward itself until it no longer looks like an outlier — see METHODS.md §6.5,
which records the measured numbers). Robust is **opt-in and correctly asymmetric**:
`gcpGuides.js` wants it (a misclick must not drag the aiming guide in every other
image); the georef fit / `gcpAccuracyReport` must NOT (dropping a mark from the fit
would hide the very disagreement the report exists to surface). Rejection is scoped to
the single prediction, so user-facing text says "7 of 9 marks", never "2 ignored" —
which reads as if the GCP were discarded. `core/products/georef.js`'s Horn
similarity fit then pairs those against the GCP's surveyed CRS position
(`useReconstructionStore.georeference()` prefers this over the pose-based fit
whenever ≥3 GCPs triangulate), and `gcpAccuracyReport()` reports per-GCP CRS
residual + per-observation reprojection px. GCPs also constrain **bundle
adjustment** directly, not just this post-hoc fit: `bundle_adjust`
(`crates/reconstruction/src/bundle.rs`) takes an `anchor_flat`/`anchor_weight`
pair injecting a full-covariance `δᵀPδ` residual on specific 3D points (their own
point-index space, appended after the normal SIFT points, each with normal
reprojection observations of its own) — the anchor only touches that point's own
3×3 Schur block, no camera-side Jacobian, so it's free to add and a no-op with
empty arrays. `core/sfm/sfm.js`'s `runGcpAnchoredBundleAdjust` runs this after
the main pipeline settles: triangulate GCPs → Horn-fit → inverse-transform
(`toSfm`) each GCP's CRS position into the SfM frame as the anchor target →
re-run BA with the GCPs injected → repeat once more (hard-coded) as insurance
against a poor seed fit. The *final* georeference used for DEM/ortho is still a
fresh post-hoc fit against whatever cameras this leaves in the sparse cloud, not
this pass's scratch state — anchoring only needs to be "good enough to help
convergence".
**A similarity to a projected CRS is fitted in a local metric frame, never in grid
units** (`core/products/localFrame.js`): grid E/N carry the point scale factor k and
no curvature, which left metres of error on error-free polar control. The frame rides
on the fit as `sim.local`, so every consumer must go through `applySimilarity` /
`frameFromSimilarity` — applying `s·R·x + t` by hand silently drops it. A fit without
`sim.local` is the legacy grid fit and still valid. BA uses the same idea: GCP anchors
and camera priors are converted into ONE survey frame (`cameraPriors.js`
`surveyFrameFor`) before marshalling, and the constraint builders live in
`core/sfm/surveyConstraints.js` — any BA that refines a surveyed model (gradual
selection today) must reuse them, or it can undo the survey correction while its
reprojection cost drops. Raster measurements likewise divide grid values by k (areas
and volumes by k², heights never).
GCP pixel marks are inverse-variance weighted in N-view triangulation and BA.
Horn seeds a seven-parameter generalized least-squares refinement under each
GCP's full precision matrix. Accuracy reporting includes Mahalanobis residuals
and leave-one-control-out predictions when no checkpoints exist; CRS changes
propagate covariance rather than retaining stale numeric sigmas.

## Conventions, invariants & gotchas
- `markRaw`/`shallowRef` for big typed arrays (keypoints, descriptors, depth planes):
  reactivity is wasteful AND a Vue Proxy can't be `postMessage`d to the worker.
- Worker results transfer ArrayBuffers (see each op's `transfer`).
- **`createWritable()` does not write in place — it stages a `<name>.crswap`
  sibling and renames it on `close()`.** Two writables open on the *same* file
  therefore collide on that one swap name and the loser throws **"Failed to create
  swap file"**. `utils/opfs.js` owns the fix: every write in that module goes
  through `writeFileIn`, which queues per path (same file ⇒ ordered, different
  files ⇒ still parallel) and reads an append offset *inside* the lock. Do not add
  a raw `createWritable` call beside it. Store-level coalescing
  (`useImagesStore.sync`, `useSensorsStore.save`, `usePosesStore.save`) stays, but
  it is about not queueing N redundant rewrites — it cannot make one store's write
  safe against another's. Folder-backed projects lose this race far more often than
  OPFS ones: real-disk latency widens the window. `core/crs.js`'s fetched-def cache
  reaches the same queue through `readAppJson`/`writeAppJson` (files in the
  `websfm/` root that belong to the installation, not a project). The **only**
  `createWritable` outside opfs.js is the `.websfm` archive sink in
  `utils/projectFile.js` — a just-picked handle, written once, streamed, with no
  second writer.
- **A `blob:` URL is a handle to a FILE, not a copy of the bytes.** `img.url` is
  `createObjectURL` over a `File`: the user's original on disk for an in-session
  image (`utils/image.js`), the OPFS copy (`getFile()`) for a restored one. The
  browser re-validates that file on every read, so the URL can die mid-session —
  the original is moved/renamed/re-synced, best-effort OPFS is evicted — and the
  symptom is `net::ERR_FILE_NOT_FOUND`, not an exception. Nothing in the pipeline
  notices on its own (matching reads descriptors, not pixels), so **every `<img>`
  bound to `img.url` must carry `@error="imagesStore.reportImageLoadError(img.id)"`**
  — the store re-creates the URL from the OPFS copy (one shared attempt per image
  per session, validated by a 1-byte read so a heal can't hand back a second dead
  URL) and only then sets `previewFailed` + `previewFailReason: 'source-lost'`.
  Related: OPFS is *best-effort* storage unless asked otherwise, so
  `opfs.ensureDurableStorage()` is requested once on project create/open.
- **`image.url` must always be a browser-native raster** (JPEG/PNG/…): the
  viewer `<img>`, the metadata dimension probe (`new Image()`), and the worker's
  `rasterize` (`createImageBitmap`) all decode it through the browser. TIFF is
  the trap — only Safari/WebKit decodes it (system ImageIO); Chrome/Firefox
  don't. `utils/tiff.js` transcodes at ingest + restore (off-main-thread, via a
  `workers/ops/tiff.js` op) so nothing downstream ever sees a TIFF. **Decode is
  the dominant cost** (~87% of ingest on 97 MP scans), so the op injects a native
  Rust/WASM decoder (`crates/imagecodec`, the `tiff` crate → interleaved 8-bit
  RGBA) into `tiffToDisplayBlob`; on any wasm decode failure (exotic photometric /
  JPEG-in-TIFF / float) it **falls back to the pure-JS geotiff.js path**, so no
  input regresses. **A 16-bit source is stretched, not cut to its high byte**:
  both paths map its 0.5 / 99.5 % levels onto 0–255 (`core/io/tonalStretch.js`, the
  crate's `percentile_range`/`stretch_lut`; a parity case is pinned on each side, and
  the two must change together). The high byte gave MicaSense pan frames half the
  contrast and 1/14 of the SIFT keypoints. Safari skips the transcode and so the
  stretch. The two canvas encodes (display JPEG + lossless compute PNG)
  are cheap and stay in JS. The original
  still lives in OPFS but is **only** ever read back to regenerate the display
  blob on restore — nothing compute-side reads it. `canDecodeTiffNatively()`
  skips the transcode entirely on engines that can already decode TIFF (Safari).
  Detection (SIFT and the learned detectors) and dense MVS both read pixels back out of the
  image via `rasterize`/`getRaster`, so the transcode produces **two** blobs
  from one decode: `image.url` (JPEG, fast, display-only) and `image.computeUrl`
  (lossless PNG) — every raster-consuming call (`detectKeypoints`, the dense-op
  image marshalling in `useReconstructionStore`) must read `img.computeUrl ??
  img.url`, never `img.url` alone, or JPEG artifacts leak into keypoints/depth.
  **A TIFF is not necessarily a photo**: `useImagesStore` ingests any TIFF as a
  source image, and a dropped `.tif` arrives with MIME `image/tiff`, so it
  reaches the image path before any importer sees it. Every dropped/picked image
  batch is therefore forked FIRST through `useImportRouting.addImagesRouted` →
  `forkGeoreferencedRasters`: a TIFF carrying GeoTIFF geolocation tags
  (`ModelTiepoint`+`ModelPixelScale`, or `ModelTransformation` — probed
  header-only by `utils/tiff.js` `isGeoreferencedTiff`, no pixel decode) is a
  **reference raster**, not a source photo. Aerial film scans carry no geokeys,
  so the split is clean in practice; the import modal offers "import as a source
  image instead" for the rare georeferenced photo. Any new image entry point
  must route through `addImagesRouted`, not `addImages`. The sniff is a **guess
  with an escape hatch in both directions**, because a GeoTIFF can be written
  with geolocation tags `geotiff.js` won't read: raster→image is
  `onRasterImportAsImage` (the import modal's link), image→raster is the image
  row's right-click **"Convert to reference data"** (`convertImageToRaster`,
  TIFF-named images only) — it re-reads the ORIGINAL from OPFS, imports it with
  `alwaysConfirm` (a sniff that already misrouted the file hasn't earned a
  silent DEM-vs-ortho verdict), and removes the image **only if the raster
  import returned a record**, so a file with no geotransform stays put instead
  of vanishing from both sections. The fork also logs which tags were missing
  (`probeTiffGeoTags`) whenever it sends a TIFF down the photo path — the
  verdict is otherwise undebuggable without the file.
- Imported raster geometry is currently axis-aligned
  (`originX/originY/scaleX/scaleY`). A `ModelTransformation` containing rotation,
  shear, or perspective is rejected explicitly by the IO worker; never collapse
  it through `getResolution()` and silently move pixels. Full affine support
  requires changing sampling, bounds, display, and persistence together.
- **NEVER read a geotiff IFD tag by property access.** geotiff 3.x made the
  file directory lazy: `image.getFileDirectory()` returns an
  `ImageFileDirectory` holding tags in internal Maps, fetched on demand. So
  `fd.ModelTiepoint` is **always `undefined`** — it does not throw, it silently
  reads a field that isn't there, and every `fd.Foo?.[0] ?? fallback` quietly
  becomes the fallback. Use `utils/tiff.js` **`readTiffTag(fd, name)`** (async;
  falls back to property access on older/eager geotiff), or better an accessor
  *method* (`getWidth`/`getSamplesPerPixel`/`getBitsPerSample`/`getGeoKeys`/
  `getOrigin`/`getResolution`) — those resolve deferred fields internally, which
  is why they kept working while the raw reads silently broke. This bit twice at
  once: `isGeoreferencedTiff` declared every GeoTIFF a source photo, and
  `parseRaster` fed `classifyRasterKind` "uint8, no nodata" for every raster.
  Any new source format the browser can't decode needs the same treatment. Both
  transcode outputs are **cached in OPFS** (`images-derived/{uuid}.display|.compute`,
  `opfs.saveImageDerived`/`loadImageDerivedBlob`/`deleteImageDerived`) at ingest;
  restore reads the cache and skips the (multi-second) re-decode+re-encode,
  transcoding + backfilling only on a miss (older projects heal on reopen — both
  blobs required, a partial cache re-transcodes). The original TIFF stays the
  source of truth; the cache assumes fixed transcode params. Ingest encodes
  **display-first** (`tiffToDisplayBlob` serial JPEG→PNG, streams a `display`
  event) so the viewer is usable while the slower PNG encodes; a TIFF's
  `computeUrl` is therefore briefly null after ingest, so the two compute entry
  points `await imagesStore.whenComputeReady(img)` first (a per-uuid promise,
  rejected if the transcode failed — detection/dense error loudly rather than
  fall back to the lossy JPEG). Non-TIFF/native-decode/restored images are ready
  immediately.
- **Never `watch` an array-returning getter to detect a change** —
  `watch(() => [a, b], cb)` builds a new array on every evaluation, so it fires
  whenever any dependency re-triggers, including a parent re-render that merely
  recreates an object prop. Use the multi-source form `watch([() => a, () => b])`,
  which compares each source. It bit RasterMeasurements: once the Ribbon displayed
  the active tool, choosing a tool re-rendered App, recreated `frameStatus`, and
  the "raster changed" watch reset the tool to Pan immediately.
- **NEVER spread a typed array into a variadic call** — `Math.max(...plane)`,
  `Math.min(...)`, `arr.push(...big)`. V8 throws `RangeError: Maximum call stack
  size exceeded` past ~124k arguments, and every pixel plane in this app is far
  bigger (a fiducial gray is `maxDim` 1536 ⇒ ~2.4M). It reads as the obvious
  spelling and unit tests never catch it, because fixtures are tiny — it shipped
  broken in `estimateFilmBounds` and killed the whole fiducial-bootstrap op. Write
  the loop. (Spreading a small derived array — per-image stats, a handful of
  scales — is fine; the rule is about per-pixel data.)
- **Tiled detection merges by OWNERSHIP, never by deduplicating the union.** Each tile
  keeps only keypoints in its core (`core/features/tiling.js` `tileOwns`; cores cut at
  overlap midpoints partition the image), so one blob comes from one tile, ≥ overlap/2
  from any cut. Merging every tile's output and NMS-ing left ~2/3 of SIFT keypoints with a
  near-identical twin: bit-identical twins pass as orientation siblings, coarse twins sit
  beyond any small radius. **A duplicate descriptor is worse than a missing one** — the
  ratio test rejects both copies, because the feature's nearest and second-nearest
  neighbours are the same blob (MAT-12: 4× fewer correspondences from *more* keypoints).
  Tile origins sit on the coarsest octave's decimation grid (16 px for SIFT), so away
  from cuts a tile reproduces the untiled detector exactly.
- **Image name → image id has ONE home: `core/io/nameMatch.js`.** GCP observations,
  camera poses, footprint polygons and COLMAP import all associate a foreign tool's
  filename with a loaded image, and they must agree. `makeNameResolver(entries,
  {key})` indexes four tiers (exact → basename → lowercase basename → lowercase
  stem) and only falls to a looser tier when every stricter one missed — a linear
  "exact OR stem" scan decides per *candidate* instead, so an earlier stem hit beats
  a later exact hit. Build it once per image-list change (a `computed` in each
  store), never per lookup. **Re-linking after an image-list change is id-first**
  (`relinkImageRecord`): a record whose `imageId` still exists keeps it and adopts
  the image's current name; only an unlinked record resolves by name. Re-resolving
  every record by its stored name silently detached all marks/poses/footprints of a
  *renamed* image (rename is label-only, the id is the link).
- **A canvas overlay redraw is rAF-coalesced, never called per event.**
  `ViewerImage.vue`'s `drawOverlay()` schedules; `renderOverlay()` draws and is
  private. 18 prop watchers feed it and one user action commonly trips several, so
  a direct call means several full repaints per tick (and one per mousemove during
  a drag). Same reason as App.vue's `queueGcpGuidesRefresh`. Per-point `fillStyle`
  is the other trap: a style change flushes the 2D context, so colour-coded
  keypoints batch into one `Path2D` per hue bucket and cull off-screen points.
  The two side canvases it blits come from composables — `useDepthOverlay`
  (depth map) and `useSmartSelect` (the SAM2 cyan candidate) — as `shallowRef`s;
  reading `.value` in `renderOverlay` tracks nothing, since the draw runs from
  rAF rather than a reactive effect. **Mask *editing* deliberately stays in the
  component**: paint/undo/rect/invert is a three-way coupling between pointer
  input, the mask canvas and the renderer, so a `useMaskEditor` would need ~28
  exports and ~8 deps — indirection without decoupling. `useSmartSelect` works
  precisely because it has a narrow seam: it hands back
  `buildCommitCanvas(w, h)` and never touches the mask canvas or undo stack.
- **A per-item reactive notification inside a long loop is O(items²).** Every
  trigger re-runs each consumer that walks the whole collection, so a run that logs
  or `touch()`es once per pair gets slower as it fills — the 2026-10-05 SB matching
  run went from ~33 to ~90 ms/pair that way (and a full 5000-line deep-`ref` log
  buffer cost 5.6 ms per line on its own). The rule: append to plain data in place
  and notify in batches — `useLog`'s buffer is a `shallowRef` triggered ≤20 Hz and
  trimmed in chunks; `useMatchesStore.matchPair` throttles `touch()` to ≤10 Hz and
  `matchAll` flushes once at the end. Never `deep`-watch such a buffer. A
  module-level singleton that Pinia stores capture at setup (the `useLog` buffer)
  keeps its state in `import.meta.hot.data`: otherwise a dev hot-update of that file
  hands re-mounted components a fresh instance while the stores keep the old one,
  and the two silently stop talking (the console went blank, 2026-10-05).
- **Progress is a monotonic 0..1 `fraction`, never a work counter.** `usePipeline`
  owns the whole display contract: it ingests every `onProgress(done, total, label,
  fraction?)` into a plain object and flushes to refs on a rAF at ≤10 Hz (worker
  events arrive far faster than anyone reads them — `matchAll` emits once per *pair*),
  clamps the fraction monotonically, and lands on 100% exactly once via
  `closeProgress()`. `ProgressModal` caps in-flight progress at **99%** — a bar that
  shows 100% while work continues is what teaches users the bar lies. So: **`done`/
  `total` are the numeric readout only**; a stage whose counter maxes out before the
  work does must supply an explicit `fraction`. Two shapes recur and both need one:
  a **post-loop phase** (dense Stage A's cross-view filter needs every map, so the
  per-image loop owns only a slice of the bar — sized from the *measured* loop time vs
  the filter's modelled per-pixel cost, `geomFilterLoopShare`, because a fixed split
  is wrong by an order of magnitude between the WASM and GPU backends) and a **nested
  sub-run** (SfM seed retries / secondary models re-run the whole pipeline —
  `core/sfm/progressPlan.js` `scopeProgress` remaps each child's honest 0..1 into a
  slice of the parent's range). SfM's own bar is a weighted phase walk there, NOT the
  registered-camera count: registration is ~45% of the run, and counting cameras put
  the bar at 100% with BA, retriangulation and track filtering still to come. A stage
  with no countable work at all (DEM, cloud edit) opens `{ indeterminate: true }` and
  resolves automatically if a real `total > 1` ever arrives.
- **A workflow is orchestration, not another pipeline.** `core/workflow.js`
  block ids are the existing ribbon/console dispatch ids. Automatic reconstruction
  blocks resolve the same defaults/preset deltas/unit conversions as their modal and
  call `usePipeline`; interactive blocks open that command and wait. Output reuse asks
  the live stores after every block—their existing invalidation/staleness rules define
  “valid”, never a second workflow-owned cache flag. The visual builder and generated
  recipe text are views over the same versioned JSON; when editable text lands it must
  round-trip losslessly into that schema rather than become a second source of truth.
- **Elapsed and remaining are formatted differently on purpose** (`utils/timeFormat.js`):
  elapsed is *measured*, so `formatClock` shows M:SS (the ticking seconds double as the
  liveness signal on a long run); remaining is *estimated*, so `formatRemaining` rounds
  coarser the further out it looks (<1 min → "less than a minute", <10 min → nearest
  minute, <1 h → nearest 5, ≥1 h → nearest 10). Second-level precision on an EMA
  estimate is a false claim, and a bucketed value stops the number twitching on every
  250 ms tick. Both guard the "60 minutes" boundary — pinned by tests.
- **A progress label must name the image, never its uuid.** Depth maps carry
  `name: img.name` from `workers/ops/dense.js`, but it is NOT in the depth-map
  sidecar/index — the densify marshalling in `useReconstructionStore` re-derives
  uuid→name from the image list each run (the list is the authority; a rename must not
  leave a stale copy on disk). `core/dense/mvs.js` keeps `m.name ?? m.uuid?.slice(0,8)`
  as the fallback for a map whose image was removed.
- **Descriptor width is per-detector, never a constant**: 128 (SIFT, DISK) vs 256
  (SuperPoint), carried as `descDim` on the feature bundle / OPFS blob and passed
  as `dim` into `crates/matching`. A wrong dim mis-slices the flat buffer into
  phantom rows whose indices overflow the keypoint arrays downstream.
- **SIFT descriptors have a SPACE, stamped per image** (`descNorm`, persisted;
  `core/features/siftDescriptors.js`). Detection stores RootSIFT ('root'). An unstamped
  websfm SIFT image is legacy L2, and an unstamped COLMAP import is RootSIFT, because
  that is COLMAP's default. Every consumer goes through `toMatchSpace`
  (`useMatchesStore` loadDesc, the COLMAP database export), which converts legacy L2 into
  a **new** array. Converting in place would double-convert the live in-memory copy on
  the next run. Mixed spaces raise no error: the ratio test still runs, just on wrong
  distances. The cap rule (`core/features/keypointCap.js`) runs in JS after masking
  and the tile merge; `runSift` calls the crate uncapped, and the kept set is returned
  in response order, because LightGlue's prefix cap and guided tiles assume best-first.
- **ORT `InferenceSession`s are NOT reentrant** — two concurrent `session.run()`
  on one wasm session deadlock/corrupt. LightGlue (`core/features/lightglue.js`)
  is pinned to worker 0 with one heavy session, so runs are serialized two ways:
  a module-scoped promise-chain mutex (`serialized`) wraps every run, and the
  store dispatches the LightGlue matcher at concurrency 1 (`useMatchesStore.matchAll`;
  brute-force keeps the pool). The tiled path (`matchLightGlueTiled`) holds the
  mutex for its whole coarse+tiles run and must never call the public
  `matchLightGlue` (re-entering the same mutex would deadlock) — it runs prefixes
  through the already-open session. Match Cancel hard-terminates the pool
  (`terminateAll`) so a wedged/long run actually aborts.
- OPFS JSON helpers swallow errors and return `null`/`[]` on miss — callers treat absence
  as empty.
- **Default settings have one home, split by audience.** *User-tunable* defaults (knobs
  a modal exposes) live in `src/core/defaults.user.js`; the modal prefills from it AND
  core falls back to the same object, so the two can't drift — never hardcode such a knob
  in both. *Internal dev-tuning* knobs (never shown to the user, swept during
  development) live in `src/core/tuning.js`, grouped by stage, with their rationale
  comment moved next to the value. Core merges them caller-last
  (`{ ...RECONSTRUCT_DEFAULTS, ...SFM_TUNING, ...settings }`) so `settings` still wins.
  Exception: a self-contained pure sub-module (e.g. `core/sfm/initPair.js`) keeps its own defaults co-located with its algorithm —
  `tuning.js` points to it rather than duplicating the value. **All pipeline-stage
  modals are wired**: detection (`DETECT_DEFAULTS_BY_DETECTOR` / `DETECT_PRESETS_BY_DETECTOR`),
  matching (`MatchFeaturesModal`↔`useMatchesStore`, `MATCH_DEFAULTS`+`MATCH_TUNING`),
  sparse SfM (`ReconstructModal`↔`core/sfm/sfm.js`, `RECONSTRUCT_DEFAULTS`+`SFM_TUNING`),
  dense depth/fuse (`DepthMapsModal`/`DenseModal`, `DEPTHMAP_DEFAULTS`/`DENSE_FUSE_DEFAULTS`
  +`DENSE_TUNING` in `core/dense/mvs.js`), DEM/ortho (`DemModal`/`OrthoModal`,
  `DEM_DEFAULTS`/`ORTHO_DEFAULTS`), mesh (`MeshModal`↔`core/products/mesh.js`,
  `MESH_DEFAULTS`+`MESH_TUNING`), export (`ExportModal`, `EXPORT_DEFAULTS`; `format`
  stays dynamic per kind), footprints (`FootprintFromPosesModal`, `FOOTPRINT_DEFAULTS`).
  Note: modals holding UI-unit values transform them in their own `run()` (e.g. a `%`
  ÷100, `0`⇒`Infinity`), so those defaults must live in the modal-facing constant, not a
  store-side merge that would double-apply the transform.
- **A threshold is only a constant if its unit is.** Two classes of default in this
  app are *not* scale-free, and hardcoding them meant one number with different
  meanings on different inputs:
  - **Pixel thresholds.** Detection runs at `maxDim` (scale `s = min(1, maxDim/nativeMax)`),
    but `workers/ops/detect.js` maps keypoints back to **native** px, so every
    downstream gate is denominated in native px while the measurement quantum is
    `1/s` native px. A 10137px scan at `maxDim` 2400 is quantized to ~4.2px against
    a 2.0px F-RANSAC gate — *tighter than the noise floor*. `core/scaleContext.js`
    owns the fix: gates are configured in **detection px** and resolved to native px
    per run (`buildScaleContext`/`pairScaleContext`/`resolveScaledPx`). Matching
    resolves **per pair** (coarser image wins — it sets the epipolar noise floor);
    SfM resolves **once per run** in `reconstruct()` and injects `detectScaleFactor`
    into `settings`, so seed retries and secondary models cannot re-derive a
    different factor from their subset and become incomparable at merge time. The
    scale rides on the image as `detectScale` (persisted; **absent ⇒ 1 ⇒ no
    correction**, never healed from meta × the current modal value).
  - **Counts drawn from a sample.** `core/features/subsetGate.js` compares
    `subsetGateThreshold` against putatives from an `s`-keypoint sample, whose
    expected yield is `(s/Na)(s/Nb)·M` — so a *fixed* `s` makes the gate ~1/N more
    severe as keypoint budgets rise (at the Detailed preset a fixed 200 vetoes
    nearly every pair and silently severs the graph). `resolveSubsetGateSize` holds
    `s/√(Na·Nb)` constant instead; the user's `subsetGateSize` is the **floor**, and
    the cost ceiling outranks it. Scaling the *threshold* down is not the
    alternative — a threshold of 1 on an expectation of 0.6 is a coin flip.
  Derivation rules: derive from **measurements**, never from decisions (`refineIntrinsics:
  'auto'` reads a fact and is correctly auto; `blend: 'best'` is intent and must not be);
  log every derived value **with its inputs**, or the run is not reproducible; and keep
  presets **static deltas** — resolve data-dependence *after* the preset, or the test
  matrix becomes presets × input characteristics and nothing is pinnable.
  `core/features/detectResolution.js` is the same idea applied to `maxDim` itself
  (fraction of native, clamped into a per-preset band) — opt-in via `maxDimMode`,
  and its band **floor is that preset's absolute value**, which is what makes
  "auto can only add resolution, never remove it" true and testable.
- `useImagesStore.sync()` rewrites the whole `project.json` and is fired from many
  concurrent callbacks; it **coalesces** writes (≤1 in flight, one trailing re-run) so
  concurrent callers don't race the file. Persistence is gated by `projects.isPersisting`
  (a getter on the projects store; each store keeps a thin `isPersisting()` alias).
- Re-detecting or clearing an image's keypoints renumbers indices, so
  `useImagesStore` calls `matchesStore.removeMatchesForImage(uuid)` to drop now-stale
  matches (also on image removal).
- **Pixel coordinates across resolutions are centre-aligned**: pixel i is centred
  on i, and every resample (canvas `drawImage`, the dense pyramid's box halving)
  keeps centres aligned, so a native x sits at `(x + ½)·s − ½` on a grid scaled by
  s. Go through `core/sfm/geometry.js` `toScaledPx`/`fromScaledPx` and `scaleK`
  (which moves cx/cy the same way) — never `x·s` or `x/s`. Detection's keypoint
  back-mapping, `makeSampleMap`, the dense K and the undistorted export all use them.
  The naive form is 0.75 native px off at s = 0.4, and it went unnoticed because
  detection and dense made the same error, and SfM alone absorbs a constant shift
  into the principal point. It shows only against independent pixels: GCP marks, a
  calibrated principal point. Fiducial detection still maps its coarse fallback with
  `/scale` (native refinement normally replaces it).
- Rotation matrices are row-major `[[…],[…],[…]]`; `t` is `[x,y,z]`; camera centre
  `C = -Rᵀt`; projection matrices are flat 12-elem `[R|t]` (no K). websfm is
  OpenCV-convention (world-to-cam R,t; camera looks down **+z**, image **+y down**).
  Interop conversions are the #1 bug source, so each lives in one place with a
  convention comment + a round-trip test: COLMAP's qvec/tvec **is** websfm R,t
  (only R↔quaternion); `transforms.json` needs camera-to-world **OpenGL** (looks
  down −z, +y up) — negate rot columns 1,2 of `c2w_cv=[Rᵀ|C]`. A Metashape GNSS
  antenna offset is in the same y-up/z-back camera axes, so it is (x, −y, −z) in ours
  (`scripts/bench/reference.mjs`). As written it left a 36 cm residual; converted, Metashape's
  own cameras fit the RTK file at 2.3 cm. The app stores it per sensor as
  `gnssLeverArm` in **our** axes (OpenCV, metres); `cameraPriors.js` attaches it to each
  prior and `surveyConstraints.js` is the one place it is applied (the antenna sits at
  `C + Rᵀ·a`, i.e. `Rᵀ·a / s` in the SfM frame).
- **WGSL: bitcast floats into u32, never indices into f32.** A small integer's bits
  read as f32 are a denormal, and a driver may flush it to zero on any float
  load/store — an index packed into a float record silently becomes 0 on some GPUs.
  `match.wgsl` keeps records as `vec4<u32>` for this reason.
- The three PatchMatch kernels (`patchmatch.wgsl`, `core/dense/planeCost.js`,
  `crates/reconstruction/src/mvs.rs`) implement the same math; the first-image
  GPU↔CPU A/B check must stay RMS < 5e-3. Change all three (and the `aggRef`
  closure in `core/dense/mvs.js`) in lockstep or not at all. Their plane-induced
  homography is `R + t·nᵀ/d` for the plane `n·X = d` with `d = n·P` — the `+`
  is load-bearing (the Hartley–Zisserman `R − t·nᵀ/d` assumes the opposite
  `n·X + d = 0`; a `−` here mirrors the warp across the epipolar line and the
  cost never bottoms out at the true depth — the 2026-07 freckle bug). The A/B
  check only proves the three agree, NOT that the warp is correct, so validate
  any homography change against a non-zero-baseline ground-truth warp. **Spatial
  propagation** likewise lives in the sweep of `mvs.rs` + `patchmatch.wgsl` (not
  planeCost.js, which is only the cost fn): it intersects *this* pixel's viewing ray
  with the neighbour's **plane** — `cand_d = depth[j]·(n·ray_j)/(n·ray_i)` — never
  the neighbour's raw depth (that only holds fronto-parallel and is the depth-map
  "freckle" bug; a slanted-plane convergence test lives in `planeCost.test.js`). The
  ZNCC half-window cap is 5 (11×11) in both kernels — keep them equal.
- After any `crates/` change: `npm run build:wasm`, commit `src/wasm/*` with the
  source change.
- **`cargo test` does NOT exercise the SIMD kernels.** `simd128` is enabled for the
  wasm target only (`.cargo/config.toml`), so a native `cargo test` compiles the
  `#[cfg(not(target_feature = "simd128"))]` scalar fallbacks — the `f32x4` paths in
  `crates/sift` (`blur`) and `crates/matching` (L2 hot loop) are unrun, `unsafe`
  pointer math included. Keep every SIMD kernel paired with a scalar fallback that a
  native test pins to a naive reference, and verify the *real* build with
  `scripts/simd-parity.mjs`: it runs the built wasm under Node (V8, same engine as
  Chrome) on the same fixed input as the crate's `#[ignore]`d `parity_digest` test —
  the two digests must match exactly — with one caveat: the SIMD and scalar blur sum
  in different orders, so keypoint positions differ by ~1e-5 px and `sumX`/`sumY`
  can differ in the 4th printed decimal purely by rounding. Identical `kept`/`raw`/
  `sup` with a last-digit gap is that; anything more is a bug — dump the per-keypoint
  rows from both sides to tell (2026-10-05: same 9 keypoints, same siblings, angles to
  1e-6). `cargo check --target wasm32-unknown-unknown`
  at minimum proves the intrinsics still compile.
- **A BA is judged by the cost it minimised.** The crate descends a Huber cost but
  reports plain RMS. Plain RMS can rise on a correct robust solve, because the
  down-weighted outliers drift. Rejecting on it kept freshly registered cameras
  unrefined and seeded the next blow-up. `runBundleAdjust` therefore re-evaluates one
  fixed-δ Huber cost (`core/sfm/baAcceptance.js`). A prior-constrained solve trades
  image residual for geometry on purpose, so it uses the bounded-increase rule instead.
- **Geometry solver tolerances are relative, and their tests are randomized.** A
  3×3 SVD via eig(AᵀA) reports a rank-2 matrix's s₃ as ≈ √ε·s₁, never 0, so an
  absolute "near zero" cut silently passed noise into U — P3P recovered 24% of random
  poses and essential decomposition returned non-rotations, while the single-pose
  unit tests passed by luck. Pin a solver with a few thousand random, well-posed
  instances at realistic magnitudes (‖E‖ ≈ 3–4 for E = KᵀFK), not one hand-picked case.
- SIFT's scale-space is built **incrementally** and each octave's base already carries
  σ0 — do not re-blur it (see METHODS.md §2; re-blurring flattens DoG contrast and
  silently eats coarse-scale keypoints). Kernel radius is 3σ, so blur cost is dominated
  by the *absolute* sigmas: keep the increments, not the full σ_i, in the inner loop.
- **A stage's run record travels with its result, not only in the log.** A measured
  number without the settings that produced it is not a baseline, so each stage
  persists what it was *asked* to do next to what it achieved: `summary.config` /
  `gates` / `initPair` (+`attempts`) / `selfCal` / `intrinsics` /
  `timings` from `core/sfm/sfm.js`, `image.detectSettings` per image (persisted;
  **absent ⇒ null ⇒ "unknown"**, never back-filled from the current modal — the same
  rule as `detectScale`), `depthSummary` from `workers/ops/dense.js` (persisted in
  `reconstruction.json` beside `denseSummary`). The one exception is
  `useMatchesStore.matchRun`, which is **session-scoped**: match *pairs* persist per
  file and there is no run-level file, so a reopened project has no run to describe.
  `core/eval/summaryDigest.js` renders all of it (Debug ▸ Project Summary, which also
  streams the markdown into `log.ndjson` at debug level) — it is a *view*, so it must
  never compute a figure a producer could have recorded. Two rules keep it honest: an
  unknown setting renders as **absent**, never as its default (a digest must not claim
  settings the run didn't use), and a heterogeneous batch says so (`detect.mixed`)
  rather than presenting one image's values as the run's.
  **The digest is the run's record; `core/sfm/verdict.js` is its alarm — they have
  different bars and the difference is load-bearing.** The digest prints an observation
  unconditionally, including when the news is good (a 0% degenerate share, a tight gate);
  the verdict fires only when something is actionable. That is why verdict's
  contributing-cause rules (`gate-headroom`, `keypoint-cap`) are
  gated on another finding having already fired: each describes a run *shape*, not a
  defect — a run can saturate the keypoint cap and leave
  the track filter inert while still being an excellent reconstruction, and turning that
  green run yellow is a false alarm. Put a new observation in the digest first; promote it
  to a verdict rule only once it is shown to *explain* a failure. Related: a threshold
  duplicated across the two (`KP_CAP_NOTE_PCT`/`KP_CAP_WARN_PCT`,
  `GATE_HEADROOM_NOTE`/`GATE_HEADROOM_WARN`) must move together, since the digest's ⚠ and
  the verdict's finding appear on the same screen. These live in their own modules rather
  than `EVAL_THRESHOLDS` because they are shape/cross-field tests (a ratio between two
  figures, a share of a population), not the single-value tiles that table colours.
- Keep the heavy logging style — every derived/auto value gets a log line the user
  can audit. The dev console keeps only a **capped display tail** in memory
  (`useLog` `MAX_BUFFER`), but every line is streamed to an **append-only OPFS
  NDJSON** file (`log.ndjson`, owned by `useLogStore`) — that file is the full
  record (scroll-back prepends older chunks from it; Save TXT exports it),
  so the buffer cap is a view limit, never data loss.
  - Every entry carries a **`channel`** (`log(msg, level, source, { channel })`):
    `'pipeline'` (default — the scientific/process record) vs `'activity'` (a
    one-line confirmation that the *user* toggled/edited something reversible —
    exclude a match, enable/add/remove a GCP, set-as-main, rename/remove a cloud).
    `core/*` `onLog` output is always pipeline; only stores emit `activity`. The
    console shows them in **Pipeline / Activity / All** tabs, and Save TXT exports
    **pipeline, non-debug** by default (activity + debug are opt-in checkboxes) — so
    user-action noise never clogs the exported record. Absent `channel` ⇒ pipeline.
  - A log message must **not** restate its own `source` — the console renders the
    source as a coloured badge. `utils/logFormat.js` `stripSourcePrefix` removes a
    stray leading `"<source>: "` at render + export as a safety net, but write
    messages without the prefix (a *different* sub-stage label like `"Mesh:"` under
    source `Products` is fine — it's not a duplicate).
- **Attribution/licenses have one home: `src/core/help/licenses.js`.** When you add
  any dependency whose license requires its notice to travel with the shipped app —
  a bundled npm package, a crate compiled into a WASM module (including vendored code
  under `crates/*/vendor/`), or a downloadable model weight — add an entry to
  `THIRD_PARTY` there (real SPDX id + upstream URL; paste the full text into `notice`
  for attribution-heavy/copyleft licenses). A model weight ALSO carries its own
  `license` in `core/models/registry.js` `MODELS` (shown at the download prompt). The
  About modal renders `licenses.js`; there is no build-time scanner, so a stale file
  = an incomplete legal notice. Courtesy credit for *ideas*/prior art (no legal duty)
  goes in the same file's `ACKNOWLEDGMENTS`. Our own code stays MIT — that is separate
  from and unaffected by bundled third-party licenses; never relabel a third party's
  license as ours.

## Interactive raster and sparse tools

- `RasterMeasurements.vue` consumes `core/products/measure.js` in the active
  ProductViewer. Tools are chosen from the Ribbon's contextual raster tab
  (Measure group, `measure-*` commands); the viewer only draws (drawing bar,
  result card, saved list) and reports its state up through ProductViewer's
  `measureState` → App's `activeRasterTab.measure`. `useMeasurementsStore` persists named snapshots to
  `measurements.json`; source identity, generation and frame stamps flag stale
  results. Vertices use the recorded raster frame. Profiles retain nodata gaps.
- `FindGcpsModal.vue` consumes bounded reference reads, worker SIFT/homography
  matching and `core/sfm/referenceGcps.js`. Accepted candidates retain measured
  sparse observations; raw photo coordinates undo recorded calibration. Unknown
  elevation/covariance must remain unknown until user review.
- Sparse gradual selection uses packed disposable worker input, fixed-intrinsics
  BA and one successful store commit. Keep self-calibration and film transforms
  when retiring obsolete run statistics; invalidate all computed dependents.
  Optimize cameras is the same path (`refineMainSparse` in the store,
  `constrainedRefine` in `core/sfm/gradualSelection.js`) with focal/principal point
  free per sensor. It never frees a radial term, because the pinhole-fold invariant
  would need the fold + composed-bag bookkeeping, and it refuses a > 20 % focal move
  as a runaway.
- SIFT batch concurrency is bounded by pool size, four jobs and an explicit
  decode/pyramid memory estimate. Learned detection stays serial. Batch logs
  measure wall time; the estimate is not an observed browser peak.

## Verification
Per change: `npm test` + `npm run typecheck`. WASM changes: rebuild + rerun.
Browser-runtime work (WGSL, OPFS, modals) needs a manual browser run this
environment may not support — say so explicitly rather than claiming verification.

**Pipeline quality is measured with the headless bench** (`scripts/bench/`, README
there). It runs ingest → detect → match → SfM through the real stores, workers and
WebGPU matcher in headless Chrome, with a fresh OPFS per run. On the development
machine headless Chrome exposes the same WebGPU adapter as the desktop browser. A run
executes a **frozen build snapshot**, because the dev server hot-reloads the page when
any imported source changes. Pipeline rows in VERIFICATION.csv (South Building, the
building set, TMA) can be run this way. UI-only checks (modals, viewers, OPFS reopen)
still need a person. Compare runs one variable at a time: a config's `variants` reuse
one detection and set of matches for SfM-only changes. Point counts alone can reward a
wrong change, so give a config `reference` data whenever a set has it: RTK camera
positions and GCP marks. Then judge accuracy with `posePriors: false` (otherwise the
solve has already seen the positions). The configs hold machine-specific dataset paths.

Test globs are `src/core/**`, `src/utils/**`, `src/stores/**` (`vitest.config.js`).
A test file outside those **silently never runs** — check the glob before concluding
"the tests pass" for new code under `composables/` or `workers/`. The environment is
node with no Vue plugin, so those globs cover plain `.js` only: no `.vue` SFCs, no
DOM, no live Pinia. Importing Vue's reactivity (`markRaw`, `ref`) is fine.

**A green build is not verification for `<script setup>` or CSS refactors.** Two
failure modes build cleanly and break at runtime, so check them directly:
- an unresolved template identifier compiles to `_ctx.foo` → compile the SFC before
  and after (`@vue/compiler-sfc` `compileScript` + `compileTemplate` with the
  script's `bindings`) and diff the `_ctx.*` sets;
- a moved CSS rule changes the cascade → build both versions, then diff the emitted
  per-scope rules (merging duplicate selectors in document order, since a base rule
  and an override are two records for the same selector).
For a store, diff the setup `return` block against HEAD — that is its API.

## Where things live
- Models / on-disk shapes: docstrings at the top of each `opfs.js` section.
- SfM tuning knobs: destructured `cfg` in `core/sfm/sfm.js` (init/BA/filter) and
  `core/sfm/register.js` (PnP-gate + interim-BA knobs).
- Type hints: `src/core/types.ts` (+ `npm run typecheck`).
- The plan: `TODO.md`. Baselines + done log: `HANDOVER.md`.

- Saved dense maps travel to workers as File handles. `depthMapInput()` validates
  sidecar sizes; streamed fusion keeps a reference and comparison map, streamed
  ortho keeps one map. Never reintroduce whole-set hydration to compute products.
- Imported ortho display uses Blob range reads and WebGL tiles. COG compression
  assembles Blob parts, not a second full-resolution typed array. Raw originals
  remain authoritative; shader ranges and gamma never alter their sample values.
- Matching RPC timing separates sender serialization from worker execution;
  round-trip remainder includes scheduling and transport, not just copying.
