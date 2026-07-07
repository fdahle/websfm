# workers/gpu — WebGPU depth-map backend

Opt-in ("Use GPU (experimental)") PatchMatch depth-map kernel. ~0.1 s/img vs
minutes on the WASM CPU path. Worker-only: everything here touches
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

- **Three kernels, one algorithm.** `patchmatch.wgsl`, `core/dense/planeCost.js`,
  and `crates/reconstruction/src/mvs.rs` implement the *same* PatchMatch cost.
  Change all three (and the `aggRef` closure in `core/dense/mvs.js`) in lockstep
  or not at all.
- **Plane homography is `R + t·nᵀ/d`** for plane `n·X = d`, `d = n·P`. The `+` is
  load-bearing — a `−` (the Hartley–Zisserman convention for `n·X + d = 0`)
  mirrors the warp across the epipolar line and the cost never bottoms out at the
  true depth (the 2026-07 "freckle" bug).
- **The A/B check is necessary but not sufficient.** The worker validates GPU vs
  CPU on the first image (`GPU validate: … RMS …`); it must stay **RMS < 5e-3**.
  That only proves the three kernels *agree*, not that the warp is *correct* —
  validate any homography change against a non-zero-baseline ground-truth warp.
- Per-image fallback to WASM on any GPU error; sample coords are clamped to each
  array layer's valid `(w, h)`.

## Testing

WGSL runs only in a real browser with WebGPU — Vitest/`tsc` can't exercise it.
Changes here need a manual browser run and a look at the `GPU validate:` log line.
