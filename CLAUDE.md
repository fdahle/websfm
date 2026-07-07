# websfm — architecture & orientation

Browser-based Structure-from-Motion / photogrammetry app. Vue 3 + Pinia front end,
heavy CV math in Rust→WASM, everything runs client-side (no server). Targets polar /
non-WGS84 projects (Antarctica), so CRS handling is first-class.

## The three docs (keep the roles strict)
- **CLAUDE.md** (this file) — evergreen architecture, layering, invariants, "where
  things live". No status, no tasks; if a sentence can go stale, it belongs elsewhere.
- **TODO.md** — the single prioritized plan: Now → Next → Backlog → Parked. All open
  work lives there, nowhere else.
- **HANDOVER.md** — the record: measured baselines (before/after yardsticks) and a
  reverse-chronological done log.
When an item ships: delete it from TODO.md, add one done-log line to HANDOVER.md
(date · what · where it lives), and fold any *evergreen* lesson into this file.

## Stack
- **UI**: Vue 3 (`<script setup>`), Pinia stores, OpenLayers (map), Three.js (3D).
- **Compute**: three Rust crates compiled to WASM (`crates/{sift,matching,reconstruction}`),
  run **off the main thread** in a worker.
- **Persistence**: OPFS (Origin Private File System) via `src/utils/opfs.js`. Per-project
  directory tree; everything recomputable is recomputed rather than stored.
- **Build/test**: Vite, Vitest (`npm test`), `tsc --noEmit` (`npm run typecheck`),
  `npm run build:wasm` (needs `wasm-pack`).

## Layering (important — keep these boundaries)
```
components/*.vue ──► stores/*.js ──► workers/computeClient.js ──► compute.worker.js
                         │                                              │
                         ▼                                              ▼
                    utils/opfs.js                              core/*.js (pure)  ──► wasm/*
```
- **`src/core/*.js` is PURE compute**: no Vue/Pinia/OPFS/DOM. Plain data in, plain data
  out, side effects via injected `onLog`/`onProgress` hooks. This is what lets the same
  code run inside the worker. `sfm.js` (incremental SfM) and `mvs.js` (dense MVS) are the
  big orchestrators; `reconstruction.js` is the JS↔WASM marshalling layer; `geometry.js`
  holds the shared pinhole-camera helpers (cameraCenter, project*, triangulationAngle,
  scaleK, rgbaToGray) used by both pipelines.
- **`src/stores/*.js`** own reactive state + OPFS persistence. They marshal reactive
  state into **plain** arrays/objects before posting to the worker (Vue Proxies can't be
  structured-cloned — a recurring footgun; see the `.map(row => [...row])` patterns).
- **`workers/computeClient.js`** is the typed async client (worker pool, request/response
  with streaming `ev` events); **`compute.worker.js`** decodes pixels (OffscreenCanvas)
  and calls `core/*`.

## Stores (`src/stores/`)
- **`projectStores.js`** — registry. Project-scoped stores register via
  `registerProjectStore()` and implement `restore(ctx)` / `clear(opts)`;
  `restoreProjectStores` / `clearProjectStores` fan out. `images` + `sensors` are NOT in
  the registry (bespoke signatures + strict order) — App.vue drives them manually:
  **sensors restore before images** (EXIF auto-grouping reacts to the image list).
- `useImagesStore` — source images, keypoints, masks, depth maps, sensor assignments.
  `sync()` writes the whole `project.json`.
- `useMatchesStore` — pairwise matches; `pairId = sorted([uuidA,uuidB]).join('--')`.
  Entries carry a persisted `disabled` flag (`setPairDisabled`) — a reversible user
  exclusion of an obviously-wrong pair; disabled pairs are filtered out where
  reconstruction reads the store (`useReconstructionStore` pair marshalling) and
  don't count as `verified` in `matchStats`. Toggled from `MatchListModal` (list
  row / preview / graph-edge double-click; `MatchGraph.vue` is the graph view).
- `useReconstructionStore` — clouds (sparse + dense), depth-map cache (`shallowRef`,
  not persisted), georef fit, run summaries; runs reconstruct / computeDepthMaps /
  densify / generateDem / generateOrtho.
- `useSensorsStore`, `useProjectsStore`, `useGcpsStore`, `useFootprintsStore`,
  `usePosesStore`, `useModalsStore`.

## Pipelines
1. **Detect** (SIFT, `crates/sift`) → keypoints (+colours) + 128-d descriptors.
   Near-duplicate keypoints (one strong blob firing as a DoG extremum across
   adjacent scales/octaves → several index-distinct points within ~2px) are
   suppressed at detection (`suppress_duplicate_positions`, response-desc NMS);
   `detect_sift` output carries **two** trailing sentinels (`raw_found`,
   `suppressed`), so parse `kept = floor((len-2)/STRIDE)`.
2. **Match** (`crates/matching`) → Lowe ratio test + RANSAC fundamental-matrix
   verification, with an inlier-**ratio** gate (rejects spurious epipolar fits on
   repetitive structure) and a **positional-spread** reject (`core/matching.js`
   `inlierSpread`, gated in `useMatchesStore`): drop a pair whose accepted inliers
   collapse to few unique locations (many-to-one convergence) or a pinhead region
   (epipole degeneracy) — signatures no count/ratio/H-F gate can see. Optional pair
   **preselection** (`core/preselect.js`, k-nearest by imported camera position)
   prunes the exhaustive O(N²) set; `matchAll` runs on a concurrency-limited worker
   pool with a per-run descriptor cache.
3. **Sparse SfM** (`core/sfm.js`): a **rotation-cycle consistency filter**
   (`rotationCycleFilter`) first prunes verified-but-false pairs — spurious epipolar
   fits on repetitive structure that clear every count/ratio gate but whose relative
   rotation is inconsistent with the match graph (each triangle's `R_ik⁻¹·R_jk·R_ij`
   must be ≈ identity; greedily drop the edge that fails most of its triangles). Then
   pick init pair (inliers + parallax + lowest init
   reprojection), incremental PnP registration (P3P + MSAC + Gauss-Newton polish in
   `crates/reconstruction/src/pose.rs`), track extension, then LM bundle adjustment
   (`bundle.rs`: Schur complement, analytic Jacobians, adaptive Huber; optional
   shared per-sensor intrinsics refinement via `refineIntrinsics`), retriangulation
   + split-track merging (`retriangulatePairs`/`mergeSplitTracks`), and 2-pass track
   filtering. Brown–Conrady distortion (`core/distortion.js`) is removed once at
   ingest so the whole pipeline stays pinhole — `projectPoint`, the track filter,
   reprojection stats and the dense/ortho warp all assume it. A sensor declares which
   coefficients it uses via a **distortion model** (`DISTORTION_MODELS`:
   pinhole/radial/radial2/brown; `distortionOf` applies only the active model's
   coefficients; undefined ⇒ all five, back-compat) — chosen in `SensorTable.vue`.
   Optional BA **self-calibration** of a shared radial `k1` (`refineIntrinsics:
   'f,k1'`) must never leave `k1` on the model (nothing downstream applies it): after
   each self-cal pass `runBundleAdjust` **folds** it back into the keypoints
   (`undistortPixel` is the exact inverse of BA's `project_k1`), resets the model `k1`
   to 0, and accumulates it per sensor into `summary.selfCalDistortion` so the dense
   stage can add it to that sensor's raster undistortion (dense's camera K is the
   BA-refined K the fold used, so the frame matches) — one single-source-of-truth for
   distortion, from ingest through dense. Heavily instrumented via `onLog` (toggle
   "Detail"/debug in DevConsole).
4. **Dense MVS** (`core/mvs.js` + `crates/reconstruction/src/mvs.rs`): Stage A build
   per-image PatchMatch depth maps → optional `filterDepthMap` (median/speckle cleanup)
   → Stage B `fuseDepthMaps` (cross-view geometric consistency). Both stages log
   per-image timing, depth range, cost distribution, and fusion cull breakdown ('Dense'
   category). **Perf**: cost scales with overlap×sources×pixels²; levers are
   `maxDim`/`maxSources`/`iterations`. **Quality** is gated by correct intrinsics —
   `resolveK` falling back to "default FOV" (fx=image width) directly distorts depth.
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
5. **Products**: local vertical frame (`core/projection.js`, aerial Z-up auto-orient) →
   DEM (`core/dem.js`, binned heights + IDW fill, hillshaded preview) → orthophoto
   (`core/ortho.js`, true reprojection reusing the cached depth maps as z-buffer +
   colour). Optional georeferencing via `core/georef.js` (Horn 7-param similarity,
   SfM centres ↔ imported poses). Exports in `core/exporters.js` +
   `core/geotiff.js` (PLY, model JSON, DEM GeoTIFF/.asc, ortho GeoTIFF/PNG+.wld)
   through `ExportModal.vue`. Products persist to OPFS (`products/…`).

## In-app glossary (help)
Cross-linked term explanations. **Content**: `src/help/**/*.md` (organised into
topic sub-folders — `algorithms/`, `camera-sensor/`, `core-sfm/`,
`dense-reconstruction/`, `products/` — but folders are authoring-only; the flat
`id` is the key, so entries link by id regardless of path), frontmatter
(`id`/`title`/`summary`/optional `aliases`) + markdown body; images under
`src/help/assets/`. `core/glossary.js` is the pure loader/renderer — parses
frontmatter, renders via `marked` + KaTeX (`$…$`/`$$…$$`), resolves `assets/*`
image URLs, and **auto-links** any occurrence of another entry's title/alias to
its tab (first hit per term; opt out one occurrence with
`<span class="no-help">…</span>`); also `getAllHelpEntries`/`searchGlossary`.
**UI**: `<GlossaryTerm id>` (`components/glossary/`) wraps inline keywords —
hover shows `GlossaryTooltip` with a border **progress ring** that, once filled,
**pins** the popup (interactive: cross-links + "Read more"). The term itself is
not clickable; "Read more" opens the single centered tabbed `GlossaryModal`
(home/index + search + one closeable tab per term), driven by `useGlossaryStore`
(`isOpen`/`tabs`/`activeId`). Ribbon *Other ▸ Glossary* → `open-glossary` opens
the home page. Highlighting is gated by the persisted `glossaryTermsEnabled`
toggle (`composables/useGlossarySettings.js`, Settings ▸ Display). **Adding a
term**: drop `src/help/<folder>/<id>.md` (auto-registered by the recursive glob) — it auto-links
wherever its title/aliases appear; wrap UI text in `<GlossaryTerm id>` only where
you want an explicit hover affordance.

## CRS / GCP / poses
Per-project working CRS (proj4). GCPs, footprints, and camera poses store positions in
the project CRS and are reprojected on CRS change (`handleSetCrs` in App.vue). See memory
`gcp-crs-architecture` and `works-in-antarctica`.

## Conventions, invariants & gotchas
- `markRaw`/`shallowRef` for big typed arrays (keypoints, descriptors, depth planes):
  reactivity is wasteful AND a Vue Proxy can't be `postMessage`d to the worker.
- Worker results transfer ArrayBuffers (see each op's `transfer`).
- OPFS JSON helpers swallow errors and return `null`/`[]` on miss — callers treat absence
  as empty.
- `useImagesStore.sync()` rewrites the whole `project.json` and is fired from many
  concurrent callbacks; it **coalesces** writes (≤1 in flight, one trailing re-run) so
  concurrent callers don't race the file. Persistence is gated by `projects.isPersisting`
  (a getter on the projects store; each store keeps a thin `isPersisting()` alias).
- Re-detecting or clearing an image's keypoints renumbers indices, so
  `useImagesStore` calls `matchesStore.removeMatchesForImage(uuid)` to drop now-stale
  matches (also on image removal).
- Rotation matrices are row-major `[[…],[…],[…]]`; `t` is `[x,y,z]`; camera centre
  `C = -Rᵀt`; projection matrices are flat 12-elem `[R|t]` (no K).
- The three PatchMatch kernels (`patchmatch.wgsl`, `core/planeCost.js`,
  `crates/reconstruction/src/mvs.rs`) implement the same math; the first-image
  GPU↔CPU A/B check must stay RMS < 5e-3. Change all three (and the `aggRef`
  closure in `core/mvs.js`) in lockstep or not at all. Their plane-induced
  homography is `R + t·nᵀ/d` for the plane `n·X = d` with `d = n·P` — the `+`
  is load-bearing (the Hartley–Zisserman `R − t·nᵀ/d` assumes the opposite
  `n·X + d = 0`; a `−` here mirrors the warp across the epipolar line and the
  cost never bottoms out at the true depth — the 2026-07 freckle bug). The A/B
  check only proves the three agree, NOT that the warp is correct, so validate
  any homography change against a non-zero-baseline ground-truth warp.
- After any `crates/` change: `npm run build:wasm`, commit `src/wasm/*` with the
  source change.
- Keep the heavy logging style — every derived/auto value gets a log line the user
  can audit.

## Verification
Per change: `npm test` + `npm run typecheck`. WASM changes: rebuild + rerun.
Browser-runtime work (WGSL, OPFS, modals) needs a manual browser run this
environment may not support — say so explicitly rather than claiming verification.

## Where things live
- Models / on-disk shapes: docstrings at the top of each `opfs.js` section.
- SfM tuning knobs: destructured `settings` in `core/sfm.js` (init/PnP/BA/filter).
- Type hints: `src/core/types.ts` (+ `npm run typecheck`).
- The plan: `TODO.md`. Baselines + done log: `HANDOVER.md`.
