# websfm — TODO / Roadmap

Browser-based Structure-from-Motion app ("Metashape in a browser"). Vue 3 +
Vite, with Rust/wasm compute crates (SIFT, matching, reconstruction). Supports
non-WGS84 / polar CRS (Antarctica use case) — CRS correctness matters throughout.

> Status: the architecture work below (Phases 1–3) is **done**. The active list
> is **Phase 4 onward** plus the follow-ups in "Backlog / ideas". A global
> undo/redo command layer was **considered and rejected** — Metashape has none;
> per-entity delete/edit (already supported by the stores) is enough.

---

## Done

### Pinia migration (done)
All shared domain state moved from composables to Pinia stores under `src/stores/`
(projects, images, sensors, matches, reconstruction, gcps, footprints, poses,
modals). A project-store **registry** (`stores/projectStores.js`) collapses the
restore/clear fan-out in `App.vue`; sensors + images restore manually (ordering /
bespoke signature), the rest via the registry. Old composables deleted.

### Phase 1 — `src/core/` extraction + TypeScript foundation (done)
- The 8 pure modules (`reconstruction`, `crs`, `gcp`, `sensor`, `pose`,
  `matching`, `metadata`, `geojson`) moved `src/utils/` → `src/core/`; all imports
  updated. UI-touching helpers (`icons`, `exportCsv`, `resizableColumns`, plus
  `camera`/`importKind`/`detection`/`image`) stayed in `utils/`.
- **Rule: core imports no Vue/Pinia.**
- `tsconfig.json` scoped to `src/core/**/*.ts`, `typescript` devDep, `npm run
  typecheck`. `src/core/types.ts` holds value types: `Vec2/3`, row-major `Mat3`,
  `Intrinsics`, `Pose {R,t}`, `Camera`, `Point3`, `Observation`, `Sensor`, and
  CRS-tagged `CrsCoord<C>` + `asCrs`. JS core modules opt into TS incrementally by
  renaming to `.ts` (only `.ts` is type-checked today).

### Phase 2 — Test harness (done)
- Vitest (`npm test`). Node env; wasm loaded from bytes in a `beforeAll`.
- `core/reconstruction.test.js` (triangulation, pose recovery, `fundamentalToEssential`),
  `core/crs.test.js` (round-trips incl. polar EPSG:3031), `core/sfm.test.js`
  (synthetic 3-view end-to-end).
- **Bug found & fixed along the way:** the wasm essential-matrix decomposition
  (`crates/reconstruction/src/lib.rs`) recovered a wrong rotation. `svd3`'s
  degenerate column filled the wrong vector, and `decompose_essential` didn't
  force det(U)=det(V)=+1 before the U·W·Vᵀ trick. Fixed + rebuilt wasm; the
  ground-truth pose test now passes to 3 decimals.

### Phase 3 — Web Workers for compute (done)
All heavy wasm runs off the main thread, so the UI no longer freezes.
- `src/workers/compute.worker.js` (module worker) + `computeClient.js` (small
  round-robin pool, promise RPC, drop-in API). Ops: `detect` (SIFT via
  OffscreenCanvas), `match`/`verify` (reuse `core/matching.js`), `reconstruct`.
- The ~400-line reconstruction orchestration was extracted verbatim into pure
  `src/core/sfm.js` (side effects via `onLog`/`onProgress` hooks); the store is now
  a thin serialise → call worker → apply + persist wrapper. The `reconstruct` op
  streams log/progress back as intermediate messages.

### Camera intrinsics + sensor table (done)
- **Film-camera intrinsics.** `resolveK` (`core/reconstruction.js`) gained a
  focal-mm + film/sensor-format-mm path (`fx = focal / formatMm × widthPx`),
  ranked above EXIF guesses — the natural input for scanned aerial film. Sensor
  table has a per-sensor px/mm focal toggle plus `pixel size (mm)` and
  `format (mm)` columns (dimmed when focal is px); `Sensor.sensorWidthMm` added to
  the type + store. Unit-tested in `reconstruction.test.js`. Follow-up fix: the
  new `sensorWidthMm` field was initially dropped from the per-image sensor
  payload `reconstruct()` posts to the worker, so the format width never reached
  `resolveK` (K stayed default-FOV) — now forwarded.
- **Estimated-table fix.** The sensor table read the *selected* cloud's cameras,
  so selecting/building a dense cloud (empty camera Map) blanked the
  Estimated/Diff tabs. `useReconstructionStore` now exposes `sparseCameras`
  (always the sparse model) and `App.vue` feeds that to the sensor modal.
- **View-track persistence.** `serialize`/`restore` now round-trip per-point
  `views` so dense MVS runs on a restored project (see Dense MVS section).

---

## Active plan

### Phase 4 — Persistence interface + versioned schema  ← **next**
- Put `utils/opfs.js` (~423 lines) behind a `ProjectStore` interface (so the
  storage backend is swappable and mockable in tests — today nothing tests OPFS).
- Add `schemaVersion` to project files + a migration step on load; formalise the
  ad-hoc `normalize()` backfill currently in the gcps store into the migration
  path. Write a round-trip test (save → load → equal) and a migration test
  (old fixture → current shape).
- While here: define the on-disk shapes as TS types in `core/` (project doc,
  reconstruction.json, matches) so save/load is type-checked.

### Phase 5 — Bundle polish, then resume features
- Code-split the ~1.3 MB main bundle: lazy-load the 3D/map viewers and the wasm so
  first paint isn't blocked by Three.js + OpenLayers.
- Then the next pipeline stages (dense cloud → mesh → DEM) on the new foundation.

---

## Dense reconstruction (MVS) — DONE (runtime-tested)

> Status: the two-stage pipeline below is **implemented and runtime-tested** on
> real aerial film data (Build Depth Maps → Densify both run end-to-end from the
> UI). View-tracks now **persist** in `reconstruction.json` (serialize/restore in
> `useReconstructionStore`), so depth maps run on a *restored* project without
> rebuilding the sparse model (legacy models saved before this still need one
> Reconstruct re-run). The original design notes are kept below as the record.
> **Active dense work is now the WebGPU backend** (next section) and the tuning
> follow-ups under "Backlog / ideas → Reconstruction quality".

Turn the sparse cloud into a dense point cloud via Multi-View Stereo. Mirrors
Metashape's order: Align (sparse) → **Build Depth Maps** → **Build Point Cloud
(dense)**. Depth maps are a SEPARATE, cacheable stage (their own pipeline op),
not part of alignment — both densification and a future mesh/DEM reuse them.

The cloud list already accepts `kind:'dense'` (useReconstructionStore: serialize /
restore / sidebar / viewer all handle it with no new plumbing). Per-image depth-map
storage already exists (useImagesStore `updateDepth` / opfs `saveDepth`/`deleteDepth`,
image viewer `showDepth` toggle) — today import/clear only; reuse for COMPUTED depth.

Two standalone stages:

**Stage A — Compute Depth Maps** (own op, does NOT produce a cloud)
1. Get image pixels into the worker — decode via OffscreenCanvas like `detect`
   does (no main-thread block, no giant structured-clone). Default half-res.
2. View selection (`core/mvs.js`, new): per reference image pick N source views
   (4–6) sharing the most sparse tracks with healthy triangulation angle, from
   the match graph + sparse tracks.
3. PatchMatch stereo in Rust→WASM (`compute_depth_map` in
   crates/reconstruction/src/lib.rs, kept DEPENDENCY-FREE). Inputs: ref + N source
   grayscale buffers, each K, relative pose ref→source, per-pixel [dmin,dmax]
   seeded from sparse points. COLMAP/Gipuma-style: random depth+normal init
   (sparse tracks as strong seeds) → red-black checkerboard propagation →
   plane-induced-homography NCC/ZNCC photometric cost (best-K source aggregation
   for occlusion) → random refinement → geometric-consistency pass (fwd-back
   reprojection penalty). Output depth + per-pixel confidence.
   Defaults for cost realism: half-res, 5×5 window, 2–3 iters; all as settings.
   Store each result via `updateDepth`.

**Stage B — Densify (fuse)** (own op, consumes Stage A output)
4. Read stored depth maps, reproject pixels to 3D, keep points consistent across
   ≥k views, colour from reference pixel (point.color already plumbed). Produce
   `[{x,y,z,color}]` → `upsertDenseCloud(points)` (mirror upsertSparseCloud,
   kind:'dense'). Refuse to run if depth maps missing.

**Wiring (both stages)**
- New worker ops `computeDepthMaps` + `densify`; computeClient wrappers;
  orchestration in `core/mvs.js` (onLog/onProgress hooks like sfm.js).
- `usePipeline` `runComputeDepthMaps()` + `runDensify()`; Ribbon buttons after
  Reconstruct; reuse ProgressModal + cancel.
- Rebuild wasm: `npm run build:wasm` after the Rust change.

Risks: MVS cost (downscale, cap source views, per-image progress); memory
(tile/downscale full-res depth); Rayon/SIMD speedup later would break the
dependency-free constraint — deliberate exception if taken.

---

## Products — DEM + Orthophoto — DONE (needs runtime test on real data)

Metashape-style products after the dense cloud: **Build DEM → Build Orthophoto**,
with in-app preview (file export deferred). Follows the usual pipeline shape
(pure `core/*` → worker op → `computeClient` → store → modal → command).

- **Projection frame** (`core/projection.js`, tested): the SfM frame is arbitrary,
  so a DEM needs a *vertical*. `buildLocalFrame` estimates "up" from the mean
  camera viewing direction (nadir sets) with a PCA-of-cloud fallback, and returns
  a `frame` with `fromSfm`/`toSfm` maps. Georeferencing is OPTIONAL and drops in
  through the same contract.
- **Georeference** (`core/georef.js`, tested): `fitSimilarity` is Horn's
  closed-form 7-param (scale+rot+trans) fit, no SVD dep. The store fits SfM camera
  centres ↔ imported camera poses (both in the project CRS) on demand; result
  persists in `reconstruction.json` (`georef`). Ribbon **Auto Georef** (Tools)
  runs it; the DEM modal's CRS selector offers "Local" always and the project CRS
  when a fit is possible.
- **DEM** (`core/dem.js`, tested): `rasterizeDem` bins framed points to a
  top-left-origin height grid (max=DSM default, +median/mean/min), IDW hole-fill,
  auto GSD (√(area/n)), `maxGrid` cap. Worker bakes a hillshaded colormap PNG.
- **Orthophoto** (`core/ortho.js`, tested) — **true image reprojection reusing the
  cached depth maps**: each DEM cell → ground point → reproject into every depth
  map; the map's own depth plane is the occlusion z-buffer, its RGB plane the
  colour. Best-view (lowest cost) or averaged blend. No image re-decode needed.
- **UI**: `DemModal` (CRS/GSD/aggregate/fill), `OrthoModal` (blend/occlusion tol/
  cost gate), `ProductPreviewModal` (DEM↔ortho toggle + metadata). Ribbon
  Products: DEM / Ortho / Preview, gated on cloud / DEM+depth-maps / product.
  `usePipeline` `runGenerateDem`/`runGenerateOrtho`, store `generateDem`/
  `generateOrtho` (transient `shallowRef` rasters, not persisted).
- **Products in the sidebar + tabs**: a "Products" sidebar section lists the DEM
  and orthophoto; double-click (or on build) opens each in its own tab
  (`ProductViewer.vue`) with image-style pan/zoom and a hover status bar reading
  out elevation (+ frame X/Y) for the DEM / RGB for the ortho.
- **Persistence**: products persist to OPFS (`products/{kind}.json` + `.bin`
  arrays; see `opfs.saveProduct`/`loadProduct`), restored on project open, purged
  on clear; a DEM rebuild deletes the now-stale ortho.
- **Aerial auto-orient (Z-up)**: `projection.aerialUpRotation` +
  `rotateReconstruction` rotate the whole model into a canonical Z-up frame after
  SfM when `projects.currentSceneType === 'aerial'`, so cameras land above the
  ground (fixes the SfM flip ambiguity). Legacy models need one Reconstruct re-run
  to pick it up. Object scenes are left as-is (no coherent up).
- **Remaining**: runtime test on the real aerial set; GeoTIFF/world-file export
  (deferred by choice); a real-world map-viewer overlay; ortho GPU/WASM kernel if
  per-cell JS proves slow on large grids; optional manual "Flip Z" for object scenes.

## WebGPU dense backend — IN PROGRESS

Port the single-threaded-WASM PatchMatch depth-map kernel to WebGPU for a large
speedup (~0.1s/img GPU vs minutes on CPU on real data). Lives in
`src/workers/gpu/` (`device.js` lazy device singleton, `depthMapGpu.js`,
`patchmatch.wgsl`); `core/planeCost.js` is the pure-JS ZNCC reference (unit
tested). `depthMapForImage` takes the kernel as an injected arg (default = WASM);
the worker swaps in `computeDepthMapGPU` when `settings.useGpu` is set and an
adapter exists, with per-image fallback to WASM on error. Exposed in the modal as
"Use GPU (experimental)", default off.

- **Phase 1 — done.** `patchmatch.wgsl` ports the ZNCC `plane_cost` for a single
  source + frontal normal; worker A/B-validates GPU vs CPU on the first image
  (`GPU validate: … RMS …`).
- **Phase 2 — done.** Full multi-source PatchMatch on GPU: slanted-plane init,
  red-black checkerboard sweeps (in-place, one dispatch per parity), decaying
  random refinement (PCG RNG), best-K cost aggregation; sources in a
  `texture_2d_array` + per-source pose storage buffer; one `main` entry driven by
  `ctrl` (mode/parity/iter). A/B logs cost-consistency RMS + median final cost.
- **Large-image buffer limits — fixed.** `device.js` now requests the adapter's
  *max* `maxBufferSize` / `maxStorageBufferBindingSize` (defaults are 256/128 MiB;
  depth state is npix×16 B, so ~380 MB at maxDim≈5000 blew the cap and surfaced as
  a cryptic "map async was not successful"). `depthMapGpu.js` also pre-flights the
  state buffer against the device limit and throws a clear "exceeds GPU limit —
  lower maxDim" message (worker catches → WASM fallback). Note the WASM fallback
  is genuinely slow at large maxDim; keep maxDim ≈1500–2500 unless GPU stays on
  the GPU path.
- **Phase 3 — remaining.** Make GPU the default when an adapter is available
  (still opt-in via the modal until then). Dense quality is now gated by
  intrinsics + fusion, not the kernel.

---

## Backlog / ideas

**Compute & workers**
- **Faster matching.** Exhaustive matching is the felt bottleneck vs Metashape: the
  matcher (`crates/matching/src/lib.rs`) is a brute-force NN scan (`n_a·n_b·128`),
  and Metashape wins by doing it on the GPU, with overlap preselection, and
  multi-threaded. Levers, in order:
  1. **SIMD — done.** The L2 hot loop (`l2_sq_early`) now uses explicit `f32x4`
     intrinsics under `+simd128` (`.cargo/config.toml`); ~3–4× on the scan.
     Covered by `core/matching.test.js`.
  2. **Worker-pool parallelism** — see the next bullet (bump `POOL_SIZE` once the
     concurrency hazards are fixed); ~Ncores× on top of SIMD.
  3. **Pair preselection** — stop doing the full O(N²) matcher on every pair.
     Match downscaled thumbnails (or use GPS/pose/overlap) to decide which pairs
     plausibly overlap, then run the full matcher only on those. This is
     Metashape's "generic/reference preselection" and the biggest cut for large
     ordered sets — most of the 1225 pairs in a flight strip never overlap.
  4. **GPU matcher (WebGPU)** — compute the descriptor distance matrix in a compute
     shader, mirroring the MVS port (`src/workers/gpu/`, `device.js` already there).
     The real path to rivalling Metashape's matching throughput (100×+); largest
     effort. Pairs naturally with a GPU SIFT detector later.
- **Parallelise the detect/match loops** across the worker pool (today they're
  sequential — responsive but not faster). Blocked on two concurrency hazards:
  the match store replaces the whole `matchStore` Map for reactivity (concurrent
  `matchPair` calls would clobber each other), and `useImagesStore.sync()` writes
  the shared project doc per image (concurrent OPFS writes can corrupt). Fix those
  (mutate-in-place reactivity + debounced/serialised sync), then bump `POOL_SIZE`
  (capped at 2 today — raise toward `hardwareConcurrency`). Note matching now
  caches descriptors per-run in `matchAll` (load once per image, not per pair).
- **Stream partial reconstruction snapshots** back from the worker so the 3D
  viewer builds up live again (the `emit` channel already exists; just post
  periodic camera/point snapshots between stages).
- **Surface worker errors in the UI** — currently a per-request reject logs; an
  `onerror` fail-all path exists but isn't user-visible.

**Reconstruction quality**
- Bundle adjustment is finite-difference gradient descent and can *increase* cost
  (there's a warn path for that). Consider a proper Levenberg–Marquardt /
  Gauss–Newton solver with analytic Jacobians in the Rust crate.
- Add BA coverage to `sfm.test.js` (the integration test runs with
  `baIterations: 0`); assert cost decreases on a noisy synthetic scene.
- More CRS tests (additional projected/geographic cases, antimeridian, a UTM
  south case); matching/detection unit tests.
- **Dense MVS tuning for large/film scans** (follow-up to the film-camera
  intrinsics work). Once intrinsics are correct (`resolveK` now has a focal-mm +
  film-format-mm path; sensor table has a px/mm toggle + format column), the next
  dense-quality levers are the depth-map modal defaults:
  - `maxDim` (currently 800) is very low for ~10k-px aerial scans — expose/raise
    it (perf-gated; cost scales with pixels²).
  - Fusion `maxCost` (0.6) culled ~87% of pixels on real film data where achieved
    costs sat ~1.0 — retune once correct focal brings costs down, or expose it.
  Verify on the CA…V aerial set: correct focal should drop PatchMatch costs and
  raise the fused-point count without loosening gates.
- **Fiducial-mark interior orientation** (deferred): affine scan→image transform
  for historical film whose scans aren't cropped to the frame. Larger feature;
  only needed if format-width intrinsics prove insufficient.

**Georeferencing (Antarctica use case)**
- Fit a similarity transform (scale + rotation + translation) from the
  reconstruction frame to GCPs / the project CRS, so the sparse model lands in
  real-world polar coordinates. This is the bridge between the up-to-scale SfM
  output and the GCP/CRS machinery that already exists.

**TypeScript**
- Continue the core TS migration: rename `core/*.js` → `.ts` one module at a time
  (start with `pose`/`sensor`/`gcp` — pure parsers), wiring in `types.ts`.

**Hygiene**
- `utils/detection.js` is now unused (superseded by the worker) — safe to delete.
- Consider committing: the tree carries Phases 1–3, the svd3 fix, and a rebuilt
  `reconstruction_bg.wasm`, all uncommitted on `main`.

---

## Verify
Build + tests + typecheck are green. The core pipeline (detect → match →
reconstruct → dense depth maps → densify) and the dense WebGPU backend have been
exercised end-to-end on real aerial film data. Still worth a click-through for the
CRS/GCP paths: import GCPs → switch project → change CRS (reprojection), watching
the stores in Vue Devtools.

## State of the tree
- Many changes are in the working tree, **uncommitted**. Branch: `main`. Includes
  the dense MVS pipeline, the WebGPU backend (`src/workers/gpu/`, untracked), the
  film-camera intrinsics + sensor-table work, and view-track persistence.
- Dev deps added: `pinia`, `typescript`, `vitest`. Scripts: `test`, `test:watch`,
  `typecheck`.
