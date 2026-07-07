# handover_gpu — WASM + WebGPU compute review & improvement plan

> **ARCHIVED 2026-07-07 — not the plan.** Per the three-doc rule, the open
> items here were folded into `TODO.md` (Now ▸ G1 correctness batch, Backlog ▸
> GPU/WASM dense perf) and the verification record into `HANDOVER.md`'s done
> log. This file survives only as the detailed deep-dive reference (§4 code
> map, §5 verification recipe are still accurate). Do not add work here.

Date: 2026-07-07 · Reviewed at commit `89977ee` (branch `main`)
Scope: the dense-MVS depth-map backends — Rust/WASM (`crates/reconstruction/src/mvs.rs`),
WebGPU (`src/workers/gpu/`), the JS reference kernel (`src/core/dense/planeCost.js`),
their orchestration (`src/core/dense/mvs.js`, `src/workers/ops/dense.js`), and the
WASM boundary generally (`src/core/sfm/reconstruction.js`, build setup).

Read `CLAUDE.md`, `src/workers/gpu/README.md`, and `crates/README.md` first — the
invariants there (three-kernel lockstep, `R + t·nᵀ/d` homography sign, the build
ritual) are all still accurate and load-bearing.

---

## 1. Verification status (what was checked, and how)

Checked in this environment:

- `npm test` — **340/340 pass** (32 files), including the ground-truth homography
  test (`planeCost.test.js` "bottoms out at the TRUE depth through a non-zero
  baseline") and the coarse-to-fine pyramid tests in `mvs.test.js`.
- `npm run typecheck` — clean.
- `src/wasm/*` artifacts and `crates/` sources last changed in the **same commit**
  (`45318d5`), so the committed WASM is in sync with the Rust.
- SIMD128 is enabled for all wasm crates (`crates/.cargo/config.toml`).

Verified by line-by-line comparison of the three kernels
(`patchmatch.wgsl` ↔ `planeCost.js` ↔ `mvs.rs`):

- **Cost math is in lockstep.** Plane setup (`d = n·P`, `|d| < 1e-9 → 2.0`),
  homography `R·ray + t·(n·ray)/d` with the correct `+` sign, OOB-warp /
  masked-texel / `cnt < 4` / `denom < 1e-6` → `INVALID` sentinel (1e9, tested
  `≥ 1e8`), ZNCC clamp to `[-1,1]`, cost `1 − ncc` — identical in all three.
- **Best-K aggregation** (exclude INVALID, mean of k smallest valid, 2.0 when none
  valid) matches across `aggCost` (WGSL), `aggregateValidCosts` (JS), `agg_cost` (Rust).
- **GPU struct layouts are byte-correct.** `Params` (64 B) and `Src` (96 B, with
  the two u32 pads after `w,h`) match the `DataView` packing in
  `depthMapGpu.js` (`writeSrc`, params buffer) offset-for-offset.
- **Red-black in-place semantics match**: a parity sweep reads only other-parity
  neighbours, so the GPU's one-dispatch-per-parity equals Rust's sequential sweeps.
- **Bilinear sampling agrees at edges**: the GPU's `clamp(su, 0, sw−1)` + the
  `(cu+0.5)/maxW` normalized coordinate reproduces the CPU's floor-based,
  edge-clamped bilinear, including sources smaller than the array layer (never
  samples the zero padding). Residual difference is the hardware sampler's
  fixed-point weights — that is what the 5e-3 RMS tolerance absorbs.
- **`queue.writeBuffer(ctrlBuf) → submit` interleaving is spec-correct** (queue
  operations execute in enqueue order), so reusing one ctrl buffer across the
  init + 2·iters dispatches is fine.
- **Fallback paths**: no adapter → WASM at run start; GPU throw mid-run →
  WASM for that image and all following (`workers/ops/dense.js` catch).

**NOT verified here** (needs a manual browser run with WebGPU): the WGSL actually
executing, the `GPU validate: … RMS …` log line, and the buffer-limit pre-flight.
Vitest/tsc cannot exercise any of it — see `src/workers/gpu/README.md` §Testing.

**Conclusion: the code is working as intended at the level static analysis + the
test suite can show.** The issues below are real but secondary (silent-divergence
edge cases, robustness, perf) — none invalidates current results at default settings.

---

## 2. Issues found (ordered by severity)

### 2.1 GPU silently truncates sources to 16; CPU paths don't
`depthMapGpu.js` → `const srcList = sources.slice(0, MAX_SRC)` (MAX_SRC = 16, matching
the WGSL `MAX_SRC` and the fixed `costs : array<f32, 16>`). The WASM kernel and the
CPU validation reference (`aggRef` in `core/dense/mvs.js`) use **all** sources.
`DepthMapsModal.vue` sets `max="16"` on the input, but `v-model.number` doesn't
enforce HTML max — a typed 20 goes through. Consequences with >16 sources: GPU and
WASM produce different aggregations, and the first-image A/B validation compares
different source sets → spurious RMS warning.
**Fix**: clamp `maxSources` where settings are resolved in `workers/ops/dense.js`
(one clamp covers both backends + validation), and/or log when truncating.
Cheap, do first.

### 2.2 No texture-dimension pre-flight or limit request
`device.js` requests the adapter's max `maxBufferSize` / `maxStorageBufferBindingSize`,
and `depthMapGpu.js` pre-flights the state buffer against them — good. But **texture
limits are neither requested nor checked**: `maxTextureDimension2D` stays at the
default 8192. Quality *ultra* uses native resolution; any camera > 8192 px on the
long side makes `createTexture` fail validation → caught → WASM fallback, but with
an opaque error instead of the clear "lower maxDim" message the buffer path gives.
`maxTextureArrayLayers` (default 256) is safe at MAX_SRC 16.
**Fix**: request `maxTextureDimension2D` up to the adapter limit in `initDevice()`,
and extend the pre-flight in `computeDepthMapGPU` to check `max(refW, refH, maxW,
maxH)` against it with the same style of actionable error.

### 2.3 Mid-run GPU→WASM fallback drops the logging hooks
`workers/ops/dense.js` catch block: the retry call is
`depthMapForImage(ref, sources, points, {…}, backend)` — **no `hooks` arg** — so the
retried image loses its coarse-to-fine plan log. One-line fix: pass
`{ onLog: hooks.onLog }` (not `validate` — backend is now WASM).

### 2.4 GPU kernel doesn't clamp the depth range like Rust does
`mvs.rs`: `dmin = depth_min.max(1e-4)`, `dmax = dmax.max(dmin*1.001)`. The GPU path
uses `depthMin`/`depthMax` as-is (defaults 0/0). Today the only caller,
`depthMapForImage`, guards this (`seedDepthFromSparse` floors at 1e-4 and bails when
`depthMax <= depthMin`), but the two backends advertise the same contract
("drop-in alternative") and don't honour it identically. **Fix**: mirror the two
clamps in `computeDepthMapGPU` before packing params.

### 2.5 Minor / hygiene
- `mvs.rs:188` comment "≤ 7×7 window (32-sample cap)" is stale — the 32-sample cap
  was removed (see the comment at ~line 89 that says so). Delete the stale half.
- `computeDepthMap` (reconstruction.js) docstring says `window=2` default;
  the dense pipeline passes 3 everywhere. Harmless, but align the doc.
- No `pushErrorScope`/`popErrorScope` around GPU resource creation — validation
  errors currently surface only indirectly (failed mapAsync / lost device).
  Wrapping setup in an error scope would turn "map async was not successful"
  into the actual validation message for the fallback log.
- `memBudget.js` GPU estimate (`nSources * 4 * npix`) doesn't model that source
  layers are padded to maxW×maxH (r8unorm gray + mask = 2 B/px/source, but on
  padded dims). Currently conservative enough; revisit if 2.2's pre-flight lands.

---

## 3. Improvement plan (prioritized)

Each item is self-contained; do them in order. **After any `crates/` change:
`npm run build:wasm` and commit `src/wasm/*` with it** (see crates/README.md).
Anything touching WGSL or device.js needs a manual browser run — check the
`GPU validate: … RMS …` line stays `< 5e-3` (and remember that check proves
agreement, not correctness; homography changes need a ground-truth warp test,
which exists in `planeCost.test.js` for the JS reference).

### P1 — Correctness / robustness (small, ship together)
1. Clamp `maxSources` to 16 in `workers/ops/dense.js` (issue 2.1).
2. Texture-limit request + pre-flight (issue 2.2).
3. Pass `onLog` hook through the mid-run fallback retry (issue 2.3).
4. Mirror Rust's depth-range clamps in `computeDepthMapGPU` (issue 2.4).
5. Comment fixes (issue 2.5, first two bullets).

### P2 — GPU diagnosability
6. Error scopes around resource creation + first dispatch in `computeDepthMapGPU`;
   include the scope's message in the thrown error so the worker's fallback log
   says *why* the GPU path failed.

### P3 — GPU performance (biggest wins first; current cost ≈ 0.1 s/img, so only
worth it when image counts grow — measure before/after per HANDOVER.md convention)
7. **Half-grid dispatch for parity sweeps.** Each sweep currently dispatches the
   full grid and half the threads early-return. Dispatch `ceil(W/2)` in x and map
   `u = 2*gid.x + ((v + parity) & 1)` in the shader → 2× occupancy on sweeps.
8. **Overlap CPU and GPU across images.** The per-image loop in
   `computeDepthMaps` awaits rasterize → GPU → readback serially. Rasterizing /
   undistorting image i+1 while image i's GPU work runs hides most of the CPU cost.
   Keep the memory ledger honest (one extra image's rasters resident).
9. **On-GPU pyramid.** `depthMapForImage` runs the coarse-to-fine loop by calling
   the backend once per level: full texture upload + full readback per level, with
   the seed upsample on the CPU. Upload all levels once (or mip the textures),
   implement the nearest-neighbour depth upsample as a tiny compute pass, and read
   back only the finest level. Removes ~half the transfer traffic. Note the
   backend contract (`computeDepthMapFn` per level) would change — coordinate
   with the WASM path (which can keep the JS pyramid loop).
10. **Fewer submits.** One command encoder can hold the init + all sweep passes if
    ctrl becomes a dynamic-offset uniform (one buffer, 2·iters+1 slots) — cuts
    per-submit overhead. Low value until 7–9 are done.

### P4 — WASM performance
11. **f32 hot loop in `mvs.rs`.** `plane_cost`/`agg_cost` run in f64; the GPU runs
    the same math in f32 and stays within 5e-3 of the f64 JS reference, so f32 is
    demonstrably sufficient. Expect a solid speedup with SIMD128 already enabled
    (better auto-vectorisation width). Keep the JS reference in f64 — it is the
    precision anchor both backends are validated against.
12. (Bigger lift, only if CPU path stays the default for anyone) wasm threads via
    rayon — requires COOP/COEP headers, worker-pool changes, and SharedArrayBuffer;
    park unless there's demand. The GPU path is the intended fast path.

### P5 — Quality (algorithmic, larger scope)
13. Geometric-consistency term inside Stage A (COLMAP-style: penalise forward-
    backward depth disagreement during PatchMatch, not just at fusion). Needs
    neighbour depth maps resident → interacts with the memory budget; design first.
14. View-selection weighting per pixel (currently per-image best-K only).

---

## 4. Map of the code (for the next model)

| File | Role |
|---|---|
| `crates/reconstruction/src/mvs.rs` | WASM CPU kernel — `compute_depth_map`, f64, scanline red-black |
| `src/workers/gpu/patchmatch.wgsl` | GPU kernel — one `main`, `ctrl.mode` 0=init / 1=sweep |
| `src/workers/gpu/depthMapGpu.js` | GPU host — packing, dispatch loop, readback, limit pre-flight |
| `src/workers/gpu/device.js` | lazy device singleton, limit requests, loss handling |
| `src/core/dense/planeCost.js` | pure JS reference kernel (f64) — the validation anchor |
| `src/core/dense/mvs.js` | backend-agnostic orchestration: source selection, sparse seeding, coarse-to-fine pyramid, A/B validation (`hooks.validate`), speckle filter, fusion |
| `src/workers/ops/dense.js` | worker op: rasterize/undistort, backend selection (`settings.useGpu`), memory pre-flight, per-image loop + fallback |
| `src/core/sfm/reconstruction.js` (`computeDepthMap`) | JS↔WASM marshalling for the CPU backend |
| `src/components/modals/DepthMapsModal.vue` | user settings incl. "Use GPU (experimental)" |

Key invariants (do not weaken):
- **Three kernels, one algorithm** — change all three + the `aggRef` closure in
  `core/dense/mvs.js` in lockstep or not at all.
- Homography sign `R + t·nᵀ/d` (the 2026-07 freckle bug — see kernel comments).
- A/B RMS < 5e-3 proves *agreement only*; homography changes need ground truth.
- `core/*` stays pure — never import `workers/gpu/*` from it (touches `navigator.gpu`).
- Both backends share the exact call contract:
  `(refGray, refW, refH, refK, sources, opts) → { depth, cost, width, height, normals? }`
  (WASM returns no `normals`; validation handles that with `[0,0,-1]`).

## 5. How to verify work here

- `npm test` + `npm run typecheck` per change.
- WASM change → `npm run build:wasm`, rerun tests, commit `src/wasm/*` alongside.
- GPU change → manual browser run (Chrome/Edge with WebGPU): load a project,
  Dense ▸ Build Depth Maps with "Use GPU (experimental)" on, watch the DevConsole
  'Dense' category for `backend = WebGPU …` and `GPU validate: … RMS …` (< 5e-3,
  median final cost well below ~1.0). Then re-run with GPU off and compare the
  per-image "% with depth / cost median" lines between backends.
- This environment cannot run the browser — say so explicitly rather than
  claiming GPU verification.
