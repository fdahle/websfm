# websfm — architecture & orientation

Browser-based Structure-from-Motion / photogrammetry app. Vue 3 + Pinia front end,
heavy CV math in Rust→WASM, everything runs client-side (no server). Targets polar /
non-WGS84 projects (Antarctica), so CRS handling is first-class.

## Stack
- **UI**: Vue 3 (`<script setup>`), Pinia stores, OpenLayers (map), Three.js (3D).
- **Compute**: three Rust crates compiled to WASM (`crates/{sift,matching,reconstruction}`),
  run **off the main thread** in a worker.
- **Persistence**: OPFS (Origin Private File System) via `src/utils/opfs.js`. Per-project
  directory tree; everything recomputable is recomputed rather than stored.
- **Build/test**: Vite, Vitest (`npm test`), `tsc --noEmit` (`npm run typecheck`),
  `npm run build:wasm` (needs `wasm-pack`). Tests + typecheck currently green.

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
- `useReconstructionStore` — clouds (sparse + dense), depth-map cache (`shallowRef`,
  not persisted), runs reconstruct / computeDepthMaps / densify.
- `useSensorsStore`, `useProjectsStore`, `useGcpsStore`, `useFootprintsStore`,
  `usePosesStore`, `useModalsStore`.

## Pipelines
1. **Detect** (SIFT, `crates/sift`) → keypoints (+colours) + 128-d descriptors.
2. **Match** (`crates/matching`) → ratio test + RANSAC fundamental-matrix verification,
   with an inlier-**ratio** gate (rejects spurious epipolar fits on repetitive structure).
3. **Sparse SfM** (`core/sfm.js`): pick init pair (inliers + parallax + lowest init
   reprojection), incremental PnP registration with an **adaptive** gate, track
   extension, then bundle adjustment + 2-pass track filtering. Heavily instrumented via
   `onLog` (toggle "Detail"/debug in DevConsole).
4. **Dense MVS** (`core/mvs.js` + `crates/reconstruction/src/mvs.rs`): Stage A build
   per-image PatchMatch depth maps; Stage B fuse with cross-view geometric consistency.

## CRS / GCP / poses
Per-project working CRS (proj4). GCPs, footprints, and camera poses store positions in
the project CRS and are reprojected on CRS change (`handleSetCrs` in App.vue). See memory
`gcp-crs-architecture` and `works-in-antarctica`.

## Conventions & gotchas
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

## Where things live
- Models / on-disk shapes: docstrings at the top of each `opfs.js` section.
- SfM tuning knobs: destructured `settings` in `core/sfm.js` (init/PnP/BA/filter).
- Type hints: `src/core/types.ts` (+ `npm run typecheck`).
- `TODO.md` and `HANDOVER` notes track in-flight work and the roadmap.
</content>
</invoke>
