# Notes for agents: Rust crates

Read [README.md](README.md) ▸ *The build ritual* before the first change here.

- After any change under `crates/`, run `npm run build:wasm` and commit `src/wasm/` in
  the same commit (CI's `check:wasm` compares the stamp). It also rebuilds the threaded
  (`src/wasm/reconstruction-mt`) and Memory64 builds and rewrites the crate list of the
  third-party notices.
- `cargo test --manifest-path crates/Cargo.toml --workspace --release` and clippy
  (`Cargo.toml` lists the allowed lints) before calling it done.
- A change to `sift`, `matching` or `reconstruction` that can change results runs the
  regression gate (`npm run gate`, ~15 min GPU) and quotes its table in the commit. A
  faster version of a step counts as a change in results until the gate says otherwise
  (aed1dc2, a speed fix, halved ETH3D playground's cameras).
- PatchMatch (`reconstruction/src/mvs.rs`) has a WGSL twin in `src/workers/gpu/`:
  change both.
- wasm32 has a 4 GB memory: a solver whose memory grows with the camera count needs a
  plan for large blocks (README ▸ *Memory64*).
