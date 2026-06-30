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

## Dense reconstruction (MVS) — IN PROGRESS

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

## Backlog / ideas

**Compute & workers**
- **Parallelise the detect/match loops** across the worker pool (today they're
  sequential — responsive but not faster). Blocked on two concurrency hazards:
  the match store replaces the whole `matchStore` Map for reactivity (concurrent
  `matchPair` calls would clobber each other), and `useImagesStore.sync()` writes
  the shared project doc per image (concurrent OPFS writes can corrupt). Fix those
  (mutate-in-place reactivity + debounced/serialised sync), then bump `POOL_SIZE`.
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

## Verify (still not runtime click-tested)
Build + tests + typecheck are green, but the runtime paths haven't been exercised
end-to-end. Worth a click-through: create project → import images → detect (SIFT)
→ match → reconstruct → import GCPs → switch project → change CRS (reprojection).
Watch the stores in Vue Devtools and confirm the worker keeps the UI responsive
during detect/match/reconstruct.

## State of the tree
- All changes are in the working tree, **not committed**. Branch: `main`.
- Dev deps added: `pinia`, `typescript`, `vitest`. Scripts: `test`, `test:watch`,
  `typecheck`.
