# workers/gpu — WebGPU backends (depth maps, brute-force matching)

Automatically preferred when WebGPU is exposed, with a persisted user opt-out.
PatchMatch runs at ~0.1 s/img here versus minutes on the WASM CPU path. Worker-only:
everything here touches
`navigator.gpu`, so **never import from `core/*`** (which stays pure/DOM-free).

- `device.js` — lazy device singleton (`ensureDevice()`), mirrors the wasm
  `siftReady ??= initSift()` pattern. Returns `null` when GPU is unavailable so
  callers fall back to WASM.
- `depthMapGpu.js` — `computeDepthMapGPU`; slanted-plane init, red-black
  checkerboard sweeps (in-place, one dispatch per parity), decaying random
  refinement (PCG RNG), best-K aggregation. Sources packed into a
  `texture_2d_array` + per-source pose storage buffer; one `main` entry driven
  by `ctrl` (mode/parity/iter).
- `patchmatch.wgsl` — the kernel.

## Invariants (read before touching the math)

- **Two kernels, one algorithm.** `patchmatch.wgsl` and
  `crates/reconstruction/src/mvs.rs` implement the *same* PatchMatch (cost, best-K,
  propagation, ACMH, prior, geometric pass). Change both in lockstep or not at all.
  The Rust cost is the reference: `mvs.rs` `plane_costs` (JS `planeCosts` in
  `core/sfm/reconstruction.js`) is what the A/B check and `core/dense/planeCost.test.js`
  score against, so there is no third copy to keep in step.
- **Plane homography is `R + t·nᵀ/d`** for plane `n·X = d`, `d = n·P`. The `+` is
  load-bearing — a `−` (the Hartley–Zisserman convention for `n·X + d = 0`)
  mirrors the warp across the epipolar line and the cost never bottoms out at the
  true depth (the 2026-07 "freckle" bug).
- **The A/B check catches a broken GPU, not drift.** On a run's first map the worker
  scores the GPU's final planes with the Rust cost (`GPU validate: …`) and judges the
  **median** difference: over `DENSE_TUNING.gpuCheckWarn` the line warns, over
  `gpuCheckMax` the run (and later runs in the session) moves to WASM. The RMS is no
  guide: a hardware sampler's 8-bit filter weights put a correct kernel's RMS near 7e-3.
  The thresholds sit far above hardware rounding, so smaller drift between the kernels
  is the nightly suite's to catch (below).
- **Agreeing is not being right.** The check proves the kernels compute the same cost,
  not that the warp is correct; `tests/bench/patchmatchCases.js` holds both to the
  truth on synthetic scenes.
- Per-image fallback to WASM on any GPU error; sample coords are clamped to each
  array layer's valid `(w, h)`.

## Brute-force matcher (`matchGpu.js` + `match.wgsl`)

Drop-in for the WASM `match_descriptors`, selected by the same "Use GPU" setting.

- **The GPU produces only top-2 arrays.** Pass `nn2Tile` streams B past 64-row
  A blocks and keeps the per-row best/second (s-space, like the crate) plus one
  column partial per (row block, column); `colReduce` folds those into the
  per-column top-2. The ratio test and mutual filter run in JS —
  `core/features/nnSelect.js` `selectMatches` — so the decision rule exists once
  and is unit-tested against the crate. Readback is 16 B per keypoint.
- **Tie rule:** every reduction uses (s, index) lexicographic order with a
  multiset second (`merge` in the shader, `mergeTop2` in JS). That reproduces the
  crate's ascending strict-`<` scan in any reduction order; on integer
  descriptors (exact arithmetic) GPU and WASM agree bit for bit.
- **Indices are u32, floats are bitcast *into* u32** — never the reverse: a small
  index as f32 bits is a denormal, and drivers may flush denormals to zero.
- **One pinned worker** (`GPU_MATCH_WORKER`): each worker would otherwise get its
  own device and its own copy of the per-run descriptor cache (LRU by image uuid;
  a miss answers `{ needs }` and the caller resends). Calls interleave safely
  because everything from cache lookup to the last `submit` is synchronous and
  per-call buffers are private.
- Pairs are split into row-block chunks of ≤ 2³³ multiply-adds per dispatch to
  stay far from the OS GPU watchdog.
- The store-side router (`stores/matching/gpuMatchRun.js`) validates the first
  full and first subset-gate match of each run against WASM, moves the run to
  WASM on a failed check, and falls back per pair on any error.

## Testing

WGSL runs only in a browser with WebGPU — Vitest/`tsc` can't exercise it.

- **PatchMatch**: `tests/bench/patchmatchCases.js` holds six synthetic scenes with a
  known depth (best-K, ACMH, a shallow plane, the sparse window, the planar prior on a
  textureless strip, the geometric pass) and the depth accuracy both kernels must reach.
  `core/dense/patchmatchQuality.test.js` runs them on the Rust kernel with every
  `npm test`; `tests/browser/gpu-depth.spec.js` runs them on this kernel in the nightly
  browser suite, on Chrome's software WebGPU (SwiftShader, `--use-webgpu-adapter=swiftshader`,
  no GPU needed), where texture filtering is exact f32 and the cost must match the Rust
  cost to a median of 1e-5. `node scripts/bench/gpu-depth-check.mjs` runs the same cases
  on this machine's GPU (`--swiftshader` for the software one); run it after a kernel
  change, since a hardware sampler rounds differently.
- **Matcher**: `node scripts/bench/gpu-match-check.mjs` (below).

For kernel work before that browser run, the `webgpu` npm package (Dawn's Node
bindings — the same D3D12/Vulkan/Metal backends Chrome uses) runs these modules
headless on the local GPU: install it *outside* the repo, assign its `globals` and
a `navigator.gpu` from `create([])` to `globalThis`, and resolve `?raw` imports with
a two-line Node loader hook. The matcher was checked that way against the WASM crate
(2026-10-05); it is not a project dependency and proves nothing about other GPUs.
