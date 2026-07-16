# websfm — architecture & orientation

Browser-based Structure-from-Motion / photogrammetry app. Vue 3 + Pinia front end,
heavy CV math in Rust→WASM, everything runs client-side (no server). Targets polar /
non-WGS84 projects (Antarctica), so CRS handling is first-class.

## The four docs (keep the roles strict)
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
When an item ships: delete it from TODO.md, add one done-log line to HANDOVER.md
(date · what · where it lives), fold any *evergreen* code lesson into this file, and
if the *method* changed, update METHODS.md.

## Stack
- **UI**: Vue 3 (`<script setup>`), Pinia stores, OpenLayers (map), Three.js (3D).
- **Compute**: five Rust crates compiled to WASM
  (`crates/{sift,matching,reconstruction,mesh,imagecodec}`),
  run **off the main thread** in a worker. `crates/mesh` is screened-Poisson meshing;
  it vendors a **rayon-stripped** copy of Dimforge's `poisson_reconstruction` under
  `crates/mesh/vendor/` (rayon's worker threads panic on threadless wasm) with a
  marching-cubes iso patch — it is one of two crates allowed a dependency, kept isolated
  so it doesn't leak into `crates/reconstruction` (which stays wasm-bindgen-only).
  Its Rust tests need release mode (`cargo test -p mesh --release`; debug is ~40× slower).
  `crates/imagecodec` is the other dep-carrying crate: the `tiff` crate as a native TIFF
  decoder that replaces the slow pure-JS geotiff.js decode at ingest (see the TIFF gotcha),
  likewise isolated from `reconstruction`.
- **Persistence**: OPFS (Origin Private File System) via `src/utils/opfs.js`. Per-project
  directory tree; everything recomputable is recomputed rather than stored — the one
  exception is **dense Stage A depth maps** (minutes/image to rebuild), persisted to
  `depthmaps/` and loaded lazily; see `core/dense/depthMapCodec.js`.
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
  `core/features/` (detectors `sift.js` / `superpoint.js`, matchers `bruteforce.js` /
  `lightglue.js`, shared geometric gate `verify.js` — F-RANSAC + inlierSpread — plus
  `ort.js`, `preselect.js`, and `tiling.js` — pure tile-grid/seam-NMS/auto-size math
  behind tiled detection; the per-tile detector loop lives in `workers/ops/detect.js`),
  `core/sfm/`
  (`sfm.js` incremental SfM orchestrator, `register.js` the incremental-resection
  stage lifted out of it — next-best-view ordering + two-gate PnP + interleaved BA,
  `registerImages(ctx)` mutating the caller's model in place, `reconstruction.js` JS↔WASM
  marshalling, `geometry.js` shared pinhole-camera helpers — cameraCenter, project*,
  triangulationAngle, scaleK, rgbaToGray — `distortion.js`, `cameraEstimated.js`),
  `core/dense/` (`mvs.js` dense MVS orchestrator, `planeCost.js`, `memBudget.js`,
  `depthMapCodec.js` — pure depth-map↔sidecar (de)serialization + index stamping/
  staleness for the persisted Stage A output),
  `core/products/` (`dem.js`, `ortho.js`, `mesh.js` screened-Poisson mesh orchestrator
  — byte-buffer parse + nearest-voxel vertex-colour transfer, wasm solver injected,
  `projection.js`, `georef.js`, `exporters.js` — cloud/mesh/DEM/ortho writers incl.
  `prepareCloudForExport` (georef-then-voxel-downsample, streams the dense
  accumulator — no per-point objects) + `meshToObj`/`meshToStl`, `geotiff.js`
  (sync writer; DEFLATE via an injected `deflate` callback since `CompressionStream`
  is DOM/worker-only — the pure path never compresses), `wkt.js` — minimal OGC WKT1
  for `.prj` (WGS84 geographic + UTM zones formulaic, else null → caller writes the
  raw proj4/EPSG string), `colormap.js`), `core/io/` (`gcp.js`, `pose.js`, `sensor.js`,
  `geojson.js`, `metadata.js`, `cameraKind.js`, `importKind.js` — filename/content
  sniffing incl. `isColmapFile` + text-xyz cloud sniff, `colmapModel.js`
  — pure COLMAP text **and** binary model read/write: R↔quaternion +
  `serialize/parseColmapModel` (txt) + `serialize/parseColmapModelBin` (LE, same
  ColmapModel struct) + websfm↔ColmapModel adapters both ways (`buildColmapModel`
  export; `readColmapModel`→`colmapToSparse` import via `makeNameResolver` name→uuid
  matching, dropping unmatched images/observations), `las.js` — LAS 1.2 writer
  (point format 2) + reader (formats 0–3/6–8, **stride is header-authoritative** —
  read `headerSize`/`offsetToPointData`/`pointDataRecordLength`, never assume from
  the format id; LAZ rejected), `cloudText.js` — XYZ writer/reader, `ply.js` —
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
  point-count shape); cross-cutting stragglers stay flat at
  `core/` root (`crs.js`, `footprint.js`, `mask.js`, `types.ts`).
- **`src/stores/*.js`** own reactive state + OPFS persistence. They marshal reactive
  state into **plain** arrays/objects before posting to the worker (Vue Proxies can't be
  structured-cloned — a recurring footgun; see the `.map(row => [...row])` patterns).
- **`workers/computeClient.js`** is the typed async client (worker pool, request/response
  with streaming `ev` events); **`compute.worker.js`** keeps the OffscreenCanvas pixel
  decoder (`rasterize`), the message loop, and the merged op registry. The op handlers
  live in **`workers/ops/<domain>.js`** (`detect`/`match`/`sfm`/`dense`/`products`/`mesh`/`io`),
  each a factory `makeXOps(deps)` returning `{ opName: handler }`; `rasterize` is injected
  into the two that need it (detect + dense), everything else is domain-local. `mesh`
  owns the mesh wasm module (lazy init, like `reconstruction.js`); `io` (`parseCloud`)
  parses an imported PLY/LAS/XYZ file off-thread (a 500 MB LAS on the UI thread is the
  trap it avoids), buffers in `transfer`. Handlers call
  `core/*` and keep their `transfer` lists next to them.
- **`App.vue`** is layout + store wiring + the Ribbon command dispatch; self-contained
  concerns are extracted to **`composables/*`** (`useTabDrag`, `useSidebarResize`,
  `useImportRouting` = dropped/picked-file funnel, `useExports` = camera-params/product
  export, `useModalEscape` = Escape-closes-top-modal, `useImageViewSettings` = the image
  view's overlay/edit toggles, plus `usePipeline`/`useTabs`/etc.). Those image-view
  toggles (keypoints/mask/depth/GCPs/fiducials + mask-edit/gcp-edit) are **global, not
  per-tab**: one localStorage-persisted ref every image tab renders from, so switching
  images never changes them and a tab stays a bare image reference. The single per-image
  gate is keypoints (drawable only once `kpStatus === 'done'`), applied at render rather
  than stored on the pref.
  **`Sidebar.vue`** is a shell (drop-zone + section open/close + re-emit); each
  collapsible section is a component under **`components/layout/sidebar/`**
  (`ImagesSection`/`SensorsSection`/`MatchesSection`/`GcpsSection`/`CloudsSection`/
  `ProductsSection`), sharing `sidebar-sections.css` (via `<style scoped src>`) and
  `composables/useContextMenu.js` for the mutually-exclusive right-click menus.
- **Shared modal framework** (`components/modals/ui/`): every pipeline-stage modal builds
  from `ModalShell` (overlay/header/close/footer; preserves esc + click-backdrop close, so
  `useModalEscape` is unchanged), `SettingsField`/`SettingsGroup`/`AdvancedDisclosure`/
  `SegmentedControl`/`WarnBox`/`PresetCards`, all consuming a shared `modal.css` via
  `<style scoped src>`. `.btn`/`.btn-primary` live in global `style.css`. **Gotcha**: a
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
  `{ count, pos:Float32Array(3N), col:Uint8Array(3N), nrm?:Float32Array(3N) }`
  (`DenseCloud` in `types.ts`), no per-point objects (millions of fused points as
  objects was the OOM's main-thread tail); a `kind:'mesh'` cloud is a flat indexed
  triangle mesh — `{ count /* triangles */, nVerts, pos:Float32Array(3·nVerts),
  idx:Uint32Array(3·count), col:Uint8Array(3·nVerts) }` (`MeshCloud`). Every dense
  consumer branches on kind (`Viewer3D` hands `pos` straight to Three.js as
  `THREE.Points`, or builds an indexed `THREE.Mesh` for `'mesh'`;
  `cloudToPly`/DEM marshalling/persist accept dense+sparse, `meshToPly`/`meshToGlb`
  handle mesh; sidebar count = points, or triangles for a mesh; DEM/ortho/densify
  input pickers select `kind:'dense'` so mesh clouds are never a source). On-disk
  dense/mesh `pos` is widened to Float64 to share the sparse sidecar format; dense
  `nrm` (Float32 3N world-space normals, the Poisson mesh input — reused PatchMatch
  plane normals) and mesh `idx` are extra per-cloud sidecar bins (`nrm`/`idx` keys),
  **absent on old projects ⇒ undefined, do NOT heal** (legacy object-shape dense
  clouds still heal via a back-compat path on restore). An **imported** dense/mesh
  cloud (`importCloud`, from a dropped/picked PLY/LAS/XYZ — parsed by the `io`
  worker op, transformed by `applyImportTransform`) carries `imported:true` (persisted)
  and is never touched by a re-fuse/re-mesh (`upsertDense/MeshCloud` skip `imported`
  clouds) — coordinates land verbatim in the current frame, no CRS reprojection.
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
   (`core/features/preselect.js`, k-nearest by imported camera position) prunes pairs
   before matching *when poses exist*; the **subset gate**
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
   seed init/cycle-filter/triangulation. `verifiedPairs`/`matchStats` exclude weak.
3. **Sparse SfM** (`core/sfm/sfm.js`): a **rotation-cycle consistency filter**
   (`rotationCycleFilter`) first prunes verified-but-false pairs — spurious epipolar
   fits on repetitive structure that clear every count/ratio gate but whose relative
   rotation is inconsistent with the match graph (each triangle's `R_ik⁻¹·R_jk·R_ij`
   must be ≈ identity; greedily drop the edge that fails most of its triangles). The
   filter weights each triangle's verdict by its weakest edge's inlier count, adapts
   the pass/fail angle to the graph's median cycle error, and shields high-inlier
   edges — all of which auto-disable on a uniform-quality graph (no/equal inlier
   counts), recovering the plain unweighted filter. Because it runs **before** self-cal,
   uncorrected distortion can make it drop TRUE edges, so dropped edges are stashed and
   **re-admitted after the first self-cal fold** (`reevaluateDroppedEdges` + a final
   second-chance sweep in `sfm.js`: re-fit F on folded keypoints, recompute rotations for
   candidates AND survivors with the refined Kmap, re-admit the consistent ones, then one
   more `registerImages` sweep). Then
   pick init pair (inliers + parallax + lowest init reprojection) and grow the model
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
   filtering. Brown–Conrady distortion (`core/sfm/distortion.js`) is removed once at
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
   An explicit comma string bypasses staging. **Pinhole-fold invariant**: radial coeffs must
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
4. **Dense MVS** (`core/dense/mvs.js` + `crates/reconstruction/src/mvs.rs`): Stage A build
   per-image PatchMatch depth maps → optional `filterDepthMap` (median/speckle cleanup)
   → Stage B `fuseDepthMaps` (cross-view geometric consistency, then a **spatial
   dedupe**). Stage B also runs three **opt-out geometric outlier filters**
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
   (SoA typed-array sums, numeric packed cell keys sized from a coarse scene bbox
   — `mergePointsSpatial` is the equivalent-but-batch reference kept for tests) and
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
   colour). Optional georeferencing via `core/products/georef.js` (Horn 7-param similarity,
   SfM centres ↔ imported poses). Exports in `core/products/exporters.js` +
   `core/products/geotiff.js` (PLY, model JSON, DEM GeoTIFF/.asc, ortho GeoTIFF/PNG+.wld)
   through `ExportModal.vue`. Products persist to OPFS (`products/…`).
6. **Mesh** (`core/products/mesh.js` + `crates/mesh`): **screened Poisson** over the
   main dense cloud, reusing its per-point normals (`DenseCloud.nrm`, the PatchMatch
   plane normals — no separate normal estimation). The wasm `poisson_mesh` returns one
   flat byte buffer `[u32 nVerts, u32 nTris, f32 pos, u32 idx]`; the crate extracts at
   the **sample-average iso** (not 0 — the naive iso inflates the surface ~8%) and
   **trims** triangles farther than `trimFactor × mergeCell` from any input point.
   Vertex colour is transferred from the nearest dense voxel cell. Output is a
   `kind:'mesh'` cloud (`useReconstructionStore.generateMesh`), shown as a lit
   `THREE.Mesh`, exported PLY (faces) / GLB. Non-destructive: the worker round-trips
   the dense buffers home.

## In-app glossary (help)
Cross-linked term explanations. **Content**: `src/glossary/**/*.md` (organised into
topic sub-folders — `algorithms/`, `camera-sensor/`, `core-sfm/`,
`dense-reconstruction/`, `products/` — the flat `id` is the key, so entries
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
you want an explicit hover affordance.

## CRS / GCP / poses
Per-project working CRS (proj4). GCPs, footprints, and camera poses store positions in
the project CRS and are reprojected on CRS change (`handleSetCrs` in App.vue). See memory
`gcp-crs-architecture` and `works-in-antarctica`.

A GCP has surveyed ground coords (`x/y/z` + per-axis `accuracyX/Y/Z`), pixel
`observations` (`[{ imageId, imageName, px, py }]`, with per-axis image accuracy
`accuracyImgX/Y`), and an `enabled` flag; there is no control/check role (every
enabled GCP is used). GCPs are created three ways: CSV import (`GcpImportModal`),
the GCP table's "+ Add GCP" (a blank GCP at the origin, edited inline —
`useGcpsStore.addGcp`), or **right-click in the image view**. That right-click
opens `ViewerImage.vue`'s general context menu (copy pixel/colour, zoom, fit)
whose "Add GCP here…" entry switches the same popup to a new-vs-existing chooser
("New GCP here" → `add-gcp`; an existing name → `mark-gcp`), both landing in
`setObservation`. The image view also shows a magnifier **loupe** (when the GCP
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
gcpGuides(imageId)` is the store entry point, App.vue keeps a `activeImageGcpGuides`
ref refreshed on tab/marks/cloud change, and `ViewerImage.vue` draws them dashed
green under the real markers (lines only for the *selected* GCP — all of them at
once is a spider web). Guides are **advisory, never inputs to the fit**, and share
`gcpAccuracyReport`'s raw-pixel/pinhole frame (see METHODS.md §6.4) — consistent
with the reprojection numbers, approximate on a heavily distorted lens.
**Never add snap-to-guide.** A guide comes *from* the reconstruction, so snapping a
mark to it feeds the model's estimate back in as ground truth; GCPs must stay
independent evidence that can correct the model, and the guide-vs-click gap is the
diagnostic — it matters most exactly when the reconstruction is wrong (METHODS.md
§6.4).

`core/sfm/gcpTriangulation.js` 2-view-DLT-triangulates a GCP's registered-image
observations into the current SfM frame; `core/products/georef.js`'s Horn
similarity fit then pairs those against the GCP's surveyed CRS position
(`useReconstructionStore.georeference()` prefers this over the pose-based fit
whenever ≥3 GCPs triangulate), and `gcpAccuracyReport()` reports per-GCP CRS
residual + per-observation reprojection px. GCPs also constrain **bundle
adjustment** directly, not just this post-hoc fit: `bundle_adjust`
(`crates/reconstruction/src/bundle.rs`) takes an `anchor_flat`/`anchor_weight`
pair injecting a `Σ w·‖pt−target‖²` residual on specific 3D points (their own
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

## Conventions, invariants & gotchas
- `markRaw`/`shallowRef` for big typed arrays (keypoints, descriptors, depth planes):
  reactivity is wasteful AND a Vue Proxy can't be `postMessage`d to the worker.
- Worker results transfer ArrayBuffers (see each op's `transfer`).
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
  input regresses. The two canvas encodes (display JPEG + lossless compute PNG)
  are cheap and stay in JS. The original
  still lives in OPFS but is **only** ever read back to regenerate the display
  blob on restore — nothing compute-side reads it. `canDecodeTiffNatively()`
  skips the transcode entirely on engines that can already decode TIFF (Safari).
  Detection (SIFT/SuperPoint) and dense MVS both read pixels back out of the
  image via `rasterize`/`getRaster`, so the transcode produces **two** blobs
  from one decode: `image.url` (JPEG, fast, display-only) and `image.computeUrl`
  (lossless PNG) — every raster-consuming call (`detectKeypoints`, the dense-op
  image marshalling in `useReconstructionStore`) must read `img.computeUrl ??
  img.url`, never `img.url` alone, or JPEG artifacts leak into keypoints/depth.
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
- **Descriptor width is per-detector, never a constant**: 128 (SIFT) vs 256
  (SuperPoint), carried as `descDim` on the feature bundle / OPFS blob and passed
  as `dim` into `crates/matching`. A wrong dim mis-slices the flat buffer into
  phantom rows whose indices overflow the keypoint arrays downstream.
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
  Exception: a self-contained pure sub-module (e.g. `core/sfm/initPair.js`,
  `core/sfm/cycleFilter.js`) keeps its own defaults co-located with its algorithm —
  `tuning.js` points to it rather than duplicating the value. **All pipeline-stage
  modals are wired**: detection (`DETECT_SIFT_DEFAULTS`/`DETECT_SUPERPOINT_DEFAULTS`),
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
- `useImagesStore.sync()` rewrites the whole `project.json` and is fired from many
  concurrent callbacks; it **coalesces** writes (≤1 in flight, one trailing re-run) so
  concurrent callers don't race the file. Persistence is gated by `projects.isPersisting`
  (a getter on the projects store; each store keeps a thin `isPersisting()` alias).
- Re-detecting or clearing an image's keypoints renumbers indices, so
  `useImagesStore` calls `matchesStore.removeMatchesForImage(uuid)` to drop now-stale
  matches (also on image removal).
- Rotation matrices are row-major `[[…],[…],[…]]`; `t` is `[x,y,z]`; camera centre
  `C = -Rᵀt`; projection matrices are flat 12-elem `[R|t]` (no K). websfm is
  OpenCV-convention (world-to-cam R,t; camera looks down **+z**, image **+y down**).
  Interop conversions are the #1 bug source, so each lives in one place with a
  convention comment + a round-trip test: COLMAP's qvec/tvec **is** websfm R,t
  (only R↔quaternion); `transforms.json` needs camera-to-world **OpenGL** (looks
  down −z, +y up) — negate rot columns 1,2 of `c2w_cv=[Rᵀ|C]`.
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
- Keep the heavy logging style — every derived/auto value gets a log line the user
  can audit. The dev console keeps only a **capped display tail** in memory
  (`useLog` `MAX_BUFFER`), but every line is streamed to an **append-only OPFS
  NDJSON** file (`log.ndjson`, owned by `useLogStore`) — that file is the full
  record (scroll-back prepends older chunks from it; Save TXT exports all of it),
  so the buffer cap is a view limit, never data loss.

## Verification
Per change: `npm test` + `npm run typecheck`. WASM changes: rebuild + rerun.
Browser-runtime work (WGSL, OPFS, modals) needs a manual browser run this
environment may not support — say so explicitly rather than claiming verification.

## Where things live
- Models / on-disk shapes: docstrings at the top of each `opfs.js` section.
- SfM tuning knobs: destructured `cfg` in `core/sfm/sfm.js` (init/BA/filter) and
  `core/sfm/register.js` (PnP-gate + interim-BA knobs).
- Type hints: `src/core/types.ts` (+ `npm run typecheck`).
- The plan: `TODO.md`. Baselines + done log: `HANDOVER.md`.
