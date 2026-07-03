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
   per-image PatchMatch depth maps → optional `filterDepthMap` (median/speckle cleanup)
   → Stage B `fuseDepthMaps` (cross-view geometric consistency). Both stages now log
   per-image timing, depth range, cost distribution, and fusion cull breakdown ('Dense'
   category). **Perf**: single-threaded WASM, cost scales with overlap×sources×pixels²;
   levers are `maxDim`/`maxSources`/`iterations`, or parallelism (not yet done). **Quality**
   is gated by correct intrinsics — `resolveK` falling back to "default FOV" (fx=image
   width) directly distorts depth.
   - **WebGPU backend (in progress)**: `src/workers/gpu/` (`device.js` lazy device
     singleton, `depthMapGpu.js`, `patchmatch.wgsl`). `depthMapForImage` takes the
     depth-map kernel as an injected arg (default = WASM); the worker swaps in
     `computeDepthMapGPU` when `settings.useGpu` is set and an adapter exists, with
     automatic per-image fallback to WASM on error. Modal exposes it as "Use GPU
     (experimental)", default off. **Phase 1 (current)**: `patchmatch.wgsl` ports the
     ZNCC `plane_cost` for a *single* source + frontal normal (no propagation/refine/
     best-K). `core/planeCost.js` is the pure JS reference (unit-tested); the worker
     A/B-validates GPU vs CPU cost on the first image and logs `GPU validate: … RMS …`
     (texels scaled ×255 in-shader so the textureless cutoff matches the reference).
     **Phase 2 complete**: full multi-source PatchMatch on GPU — slanted-plane init,
     red-black checkerboard sweeps (in-place; one dispatch per parity, no ping-pong),
     decaying random refinement (PCG RNG), best-K cost aggregation. Sources packed
     into a `texture_2d_array` (each in a maxW×maxH layer; sample coord clamped to the
     valid (w,h) so bilinear never reads zero padding) + per-source pose storage
     buffer. One `main` entry driven by `ctrl` (mode/parity/iter); state =
     `array<vec4<f32>>` (depth+normal) + cost. A/B logs cost-consistency RMS
     (recompute best-K on the CPU reference at the GPU's final depth+normal, expect
     ~e-3) + median final cost (convergence). On real data: ~0.1s/img GPU vs minutes
     on CPU. **Remaining (Phase 3)**: make GPU the default when available (still opt-in
     via the modal). Dense quality is now gated by intrinsics + fusion, not the kernel.

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
