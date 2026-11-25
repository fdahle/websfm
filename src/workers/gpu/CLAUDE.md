# Notes for agents: WebGPU kernels

Read [README.md](README.md) ▸ *Invariants* before touching the maths.

- PatchMatch exists twice, in WGSL here and in Rust (`crates/reconstruction`, `mvs.rs`).
  A change to one is a change to both; `tests/bench/patchmatchCases.js` holds both to
  the same accuracy.
- The unit tests and the Playwright suite run on SwiftShader (software WebGPU): they
  check results, never speed. Time a kernel headed, on the real GPU
  (`scripts/bench/checks/gpu-depth-check.mjs`, or the bench).
- Firefox answers `onSubmittedWorkDone()` and `mapAsync` on a 100 ms timer. A loop that
  waits once per item, or times work by those waits, is 100 ms per item slower there;
  the depth-map band timing subtracts the wait.
