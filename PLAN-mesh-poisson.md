# PLAN — Mesh from dense cloud via screened Poisson (Route B)

Goal: a **vertex-colored triangle mesh** product generated in-browser from the dense
point cloud, using screened Poisson surface reconstruction (Rust→WASM), rendered in
Viewer3D, persisted to OPFS, exportable as PLY + GLB.

Read CLAUDE.md first (layering, invariants, doc conventions). This plan is written
to be executed phase by phase; each phase is independently landable and testable.
Run `npm test` + `npm run typecheck` after every phase; rebuild WASM
(`npm run build:wasm`) and commit `src/wasm/*` with any `crates/` change.

## Why this design (context for the executor)

Screened Poisson needs **oriented per-point normals**. Normally that means k-NN PCA
estimation + orientation propagation — but this pipeline already *computes* normals
and throws them away: PatchMatch estimates a per-pixel plane `(depth, normal)`.

- The **GPU backend already returns them**: `src/workers/gpu/depthMapGpu.js` returns
  `{ depth, cost, width, height, normals }` (camera-frame unit normals, `nz < 0`,
  i.e. facing the camera). The A/B validation in `depthMapForImage`
  (`src/core/dense/mvs.js:284`) already reads `dm.normals`.
- The **WASM backend discards them**: `compute_depth_map`
  (`crates/reconstruction/src/mvs.rs:169`) packs its output as
  `[depth ×npix, cost ×npix]` (`out[i]`, `out[npix+i]` around line 329) even though
  each pixel's converged plane normal exists internally.

So Phase 1 is plumbing normals end-to-end (kernel → op → store cache → fusion →
voxel accumulator → `DenseCloud.nrm`), and Phase 2+ is the Poisson solve + product
integration. Camera-facing normals are consistently outward-oriented for aerial
coverage, which is exactly what Poisson needs.

## Hard invariants (violating any of these is a bug)

1. `src/core/**` stays PURE (no Vue/Pinia/OPFS/DOM; side effects via
   `onLog`/`onProgress` hooks only).
2. Never materialize a per-point/per-vertex **object** list for dense-scale data
   (the 2026-07 OOM). Everything stays flat typed arrays end-to-end; worker results
   list their buffers in `transfer`.
3. `crates/reconstruction` stays dependency-free (wasm-bindgen only). The Poisson
   solver goes in a **new crate** so its dependencies don't leak in.
4. The three PatchMatch kernels stay in lockstep — this plan must NOT change any
   plane/cost math; it only *exports* an already-computed value from `mvs.rs`.
5. Default settings: user-facing knobs in `src/core/defaults.user.js` (modal
   prefills from it AND core falls back to it), internal knobs in
   `src/core/tuning.js`.
6. Heavy `onLog` instrumentation: every derived/auto value gets an auditable line.
7. Browser-runtime behavior (viewer rendering, OPFS restore, modal) cannot be fully
   verified headlessly — after implementing, SAY SO explicitly and list the manual
   steps; do not claim verification you didn't do.

---

## Phase 1 — Normals through the dense pipeline

**1a. WASM kernel exports normals.** In `crates/reconstruction/src/mvs.rs`
`compute_depth_map`, widen the output from `2·npix` to `5·npix`:
`[depth ×npix, cost ×npix, nx ny nz interleaved ×3npix]`. Normals are the final
converged plane normals, camera-frame, unit length (they already are internally).
Add/extend a Rust test: synthetic slanted plane → recovered normals within a few
degrees (there is an existing slanted-plane convergence test culture in
`planeCost.test.js`; mirror it crate-side).

**1b. JS unwrapper.** `src/core/sfm/reconstruction.js` (~line 382–393) currently
slices `depth`/`cost` and length-checks `npix*2`. Update to slice `normals:
raw.slice(npix*2, npix*5)` with the length check at `npix*5`. Now both backends
return the same shape (`depthMapGpu.js` already documents its normals as the same
camera-frame convention — verify, don't assume: compare first-image normals GPU vs
WASM in the existing A/B hook and log the RMS angular difference).

**1c. Depth-map op + cache + transfers.** Normals must survive the full round trip,
because fusion runs later, possibly in a different op call:

- `src/workers/ops/dense.js` (computeDepthMaps handler): keep `dm.normals` on the
  returned per-image map; add the buffer to that op's `transfer` list. The
  no-measurement cull / `filterDepthMap` / mask steps zero **depth** only — holes
  are defined by `depth <= 0` everywhere downstream, so stale normals under a
  zeroed depth are fine and must not be "cleaned up".
- `src/stores/useReconstructionStore.js`: the depth-map cache (`shallowRef`, not
  persisted) keeps `normals`; the **densify** marshalling adds the normals buffer
  to the transferred set (both directions — the op round-trips buffers home for
  ortho reuse; keep that symmetric).
- `src/core/dense/memBudget.js` `projectDensifyPeakBytes`: count the normals
  buffers (+12 bytes/px input side). Update `memBudget.test.js` expectations.

**1d. Fusion accumulates world-space normals.** In `src/core/dense/mvs.js`:

- `fuseDepthMaps`: for each kept pixel, rotate the camera-frame normal to world
  (`n_world = Rᵀ · n_cam`, same row-major convention as `unproject`) and stream it
  into the accumulator. If a map has no `normals` (stale cache from an older
  session), pass the view direction `(C − P)` normalized as fallback — never skip.
- `createVoxelAccumulator`: add `snx/sny/snz` Float64 sum arrays; `add(...)` takes
  the 3 extra components; `finalizeFlat()` keeps the existing 6-float wire format
  **unchanged** and additionally returns a separate `Float32Array(3N)` of
  normalized averaged normals (expose as e.g. `finalizeNormals()` or attach to the
  returned object — pick one, keep the flat 6-float buffer's shape stable for
  existing consumers). Near-zero averaged vectors (views disagree) fall back to
  the dominant contributor or `(0,0,1)` — log a count.
- `mergePointsSpatial` is the batch reference for tests — extend it identically
  and extend `mvs.test.js` to assert accumulator ≡ reference including normals.

**1e. `DenseCloud` grows optional `nrm`.** `src/core/types.ts`: add
`nrm?: Float32Array /* 3N, unit, world-space */`. Wire it through the densify op
return (+ transfer), the store's `upsertSparseCloud`-equivalent dense path, and the
OPFS sidecar persist/restore in `src/utils/opfs.js` (one more sidecar bin per dense
cloud; absent on old projects ⇒ `nrm` undefined — back-compat, do NOT heal). Dense
`pos` is widened to Float64 on disk; `nrm` can stay Float32 on disk (it's unit
scale). Update `cloudToPly` in `src/core/products/exporters.js` to optionally emit
`nx ny nz` properties when `nrm` exists (both point-object and flat branches).

Phase 1 acceptance: `npm test` green including new accumulator/normal tests; a
densify run (manual, browser) produces a dense cloud whose PLY export contains
plausible normals (aerial scene ⇒ predominantly up-facing after Z-up orient).

---

## Phase 2 — `crates/mesh`: screened Poisson in WASM

New crate `crates/mesh` (do NOT add dependencies to `crates/reconstruction`).

- Use Dimforge's `poisson_reconstruction` crate (screened Poisson, pure Rust).
  Check its feature flags for wasm compatibility — disable anything
  thread/rayon-based; it must compile with `wasm-pack build --target web`. If it
  does not compile to wasm32 cleanly, first try vendoring/patching; only if that
  fails, fall back to implementing FSSR-style or ball-pivot — but STOP and flag
  the tradeoff in your summary rather than silently shipping a different
  algorithm.
- Exported API (wasm-bindgen), mirroring the existing crates' flat-buffer style:
  `poisson_mesh(pos: &[f32], nrm: &[f32], depth: u32, samples_per_node: f32,
  trim_dist: f32) -> Vec<u8>` returning ONE byte buffer:
  header `[u32 nVerts, u32 nTris]` + `f32 positions (3·nVerts)` +
  `u32 indices (3·nTris)`. (Bytes, not `Vec<f32>` — indices above 2^24 are not
  f32-exact.) JS parses with typed-array views. Empty result ⇒ header zeros.
- Inside the crate, after the solve:
  - **Weld** duplicate vertices if the library returns triangle soup (hash on
    quantized position).
  - **Trim** Poisson's hallucinated bulges: drop triangles whose every vertex is
    farther than `trim_dist` from any input point (voxel-hash proximity grid —
    same packed-key idea as `createVoxelAccumulator`), then drop unreferenced
    vertices. `trim_dist` in world units; caller passes `k × mergeCell`.
- Rust tests: synthetic noisy sphere with outward normals → closed-ish mesh,
  vertex RMS distance to unit sphere small; trim test: outlier-free cube cloud
  keeps ~0 far triangles.
- `package.json` `build:wasm`: append the `crates/mesh → src/wasm/mesh` wasm-pack
  step (same pattern as the existing three). Commit `src/wasm/mesh/*`.

---

## Phase 3 — Pure JS orchestrator + color transfer

New `src/core/products/mesh.js` (pure; meshing is a products-stage concern like
DEM/ortho):

- `generateMesh(dense, settings, onLog, hooks)` — takes the flat dense cloud
  (`pos`, `col`, `nrm`; error loudly if `nrm` missing: "re-run Densify to compute
  normals"), calls the wasm `poisson_mesh`, parses the byte buffer.
- **Color transfer**: Poisson vertices are new points, not input points. Build a
  voxel hash of the dense cloud at `mergeCell` (reuse/extract the packed-key
  helper from `mvs.js` rather than reimplementing) and color each vertex from the
  nearest occupied cell (search 3³ neighborhood, nearest by distance; miss ⇒ gray
  + counted + logged). Output `col: Uint8Array(3·nVerts)`.
- Defaults: `MESH_DEFAULTS` in `src/core/defaults.user.js` (octree `depth` — start
  8, `samplesPerNode`, `trimFactor` (× mergeCell), `colorize: true`); internal
  knobs (voxel-hash neighborhood, gray fallback color) in `tuning.js` under a
  `MESH_TUNING` group. Core merges `{ ...MESH_DEFAULTS, ...MESH_TUNING,
  ...settings }` caller-last.
- Log: input points, solve time, raw verts/tris, trimmed count, welded count,
  color-miss count.
- Vitest: color transfer on a tiny synthetic cloud; byte-buffer parser round-trip.

Worker op: add `meshify` to `src/workers/ops/products.js` (or a new
`workers/ops/mesh.js` if products.js is crowded — follow the `makeXOps(deps)`
factory + local `transfer` pattern). Input: dense `pos`/`col`/`nrm` (transferred);
output: mesh `pos`/`idx`/`col` (transferred). Round-trip the dense buffers home
(same convention as densify) since the store keeps using them.

---

## Phase 4 — Store, viewer, sidebar

- `src/core/types.ts`: `MeshCloud { kind:'mesh', count /* triangles */, nVerts,
  pos: Float32Array, idx: Uint32Array, col: Uint8Array }`.
- `useReconstructionStore.generateMesh()`: consumes the **main dense cloud**
  (mirror how DEM/ortho pick their input; if there's no main-dense concept, use
  the selected/first dense cloud — check how `generateDem` resolves its source and
  copy that), calls the op with progress events, upserts a `kind:'mesh'` cloud.
  Audit EVERY place that branches on cloud `kind` (CLAUDE.md: "every dense
  consumer branches on kind") and handle `'mesh'`: sidebar count label
  (triangles), persist/restore, delete, export enumeration, and make sure
  DEM/ortho/densify input pickers **exclude** mesh clouds.
- Persistence: `reconstruction.json` entry + OPFS sidecars `pos`/`idx`/`col` per
  mesh cloud, following the existing per-cloud sidecar naming + 
  `removeStaleReconBins` keep-list (see the sidecar docstring around
  `src/utils/opfs.js:561`).
- `Viewer3D.vue`: `kind:'mesh'` ⇒ indexed `THREE.BufferGeometry` (position +
  color attrs, `setIndex`), `MeshStandardMaterial({ vertexColors: true, side:
  THREE.DoubleSide })`, `geometry.computeVertexNormals()` (cheaper than shipping
  normals to the viewer; the scene already has Directional + Ambient lights,
  `Viewer3D.vue:128–131`). Same disposal/rebuild path as the points branch.
- Sidebar `CloudsSection.vue`: mesh row (icon distinct from point clouds,
  "N tris"), delete via existing context-menu pattern.

---

## Phase 5 — UI entry + export

- `MeshModal.vue` (copy the structure of `DemModal.vue`): prefill from
  `MESH_DEFAULTS`, expose depth / samplesPerNode / trimFactor / colorize, run via
  the store with `ProgressModal` wiring. Ribbon command (next to DEM/Ortho) +
  `App.vue` dispatch + `useModalsStore` registration. Disable/explain when no
  dense cloud with `nrm` exists.
- Export (`src/core/products/exporters.js` + `useExports.js` + `ExportModal.vue`):
  - `meshToPly(mesh)` — binary PLY with `element face` (extend, don't duplicate,
    the existing PLY writer plumbing).
  - `meshToGlb(mesh)` — minimal hand-rolled binary glTF 2.0: one buffer, one mesh
    primitive, `POSITION` (f32) + `COLOR_0` (u8 normalized) + indices (u32),
    correct 4-byte alignment + min/max on POSITION accessor. No library needed;
    ~100 lines. Vitest: parse the output's JSON chunk, validate structure +
    accessor counts against a golden tiny mesh.
  - Wire both into `EXPORT_DEFAULTS`/ExportModal for `kind:'mesh'`.

---

## Phase 6 (optional, separate commit) — Decimation

Poisson output at depth 9–10 can be millions of triangles. Add npm dependency
`meshoptimizer` (official JS/WASM build) and run `MeshoptSimplifier.simplify`
behind a `targetTriangles` knob in MeshModal (0 ⇒ off). Runs in the worker op
after color transfer. Log before/after counts + error bound. If bundling the
meshoptimizer wasm in the worker fights Vite, note it and keep this phase parked
rather than hacking the build.

---

## Docs & bookkeeping (per CLAUDE.md conventions — do this as you land phases)

- `TODO.md`: add the phases under Now/Next before starting; delete items as they
  ship.
- `HANDOVER.md`: one done-log line per shipped phase (date · what · where), plus
  any measured baseline (e.g. mesh time / triangle count on the reference
  dataset).
- `METHODS.md`: new section — PatchMatch plane normals reused as Poisson input
  (why that's valid), screened Poisson choice + trimming rationale.
- `CLAUDE.md`: fold in only the evergreen facts (normals in the dense wire format,
  `crates/mesh`, `kind:'mesh'` cloud shape, where mesh code lives).

## Verification checklist (final)

1. `npm test` + `npm run typecheck` green.
2. `npm run build:wasm` rebuilt; `src/wasm/*` committed with crate sources.
3. Rust tests in both crates pass (`cargo test` in `crates/reconstruction` and
   `crates/mesh`).
4. Manual browser run (state explicitly if not performed): detect → match →
   reconstruct → depth maps → densify → Generate Mesh → mesh visible & lit in
   Viewer3D → reload project (OPFS restore keeps the mesh) → export PLY opens in
   CloudCompare/MeshLab, GLB opens in a glTF viewer.
5. GPU-vs-WASM normal agreement logged on the first depth map (Phase 1b) — angular
   RMS should be small; a large value means the two backends' normal conventions
   diverged: stop and fix before building on top.
