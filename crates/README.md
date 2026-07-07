# crates — Rust → WASM compute

Cargo workspace; every member compiles to WASM and runs **off the main thread**
in the compute worker. Members (see `Cargo.toml`):

- `sift/` (`lib.rs`) — SIFT detection → keypoints (+colours) + 128-d descriptors.
  Suppresses near-duplicate keypoints at detection; output carries **two**
  trailing sentinels (`raw_found`, `suppressed`), so parse
  `kept = floor((len − 2) / STRIDE)`.
- `matching/` (`lib.rs`) — Lowe ratio test + RANSAC fundamental-matrix
  verification.
- `reconstruction/` — the big one:
  - `pose.rs` — incremental PnP registration (P3P + MSAC + Gauss-Newton polish).
  - `bundle.rs` — LM bundle adjustment (Schur complement, analytic Jacobians,
    adaptive Huber; optional shared per-sensor intrinsics refinement).
  - `mvs.rs` — dense PatchMatch depth maps (one of the **three lockstep
    kernels** — see `src/workers/gpu/README.md`).
  - `linalg.rs`, `lib.rs` — glue + linear algebra.

## The build ritual (don't skip)

The compiled artifacts in `src/wasm/*` are **committed to the repo** — the app
imports them directly and does not build Rust at runtime. So after *any* change
under `crates/`:

```
npm run build:wasm        # needs wasm-pack; writes src/wasm/{detection,matching,reconstruction}
```

then **commit `src/wasm/*` together with the `crates/` source change** in the
same commit. A source edit without the rebuilt wasm is a silent no-op at runtime.

`build:wasm` runs `wasm-pack build … --target web` for all three crates and
strips the generated `.gitignore` files so the output stays tracked.

## Profiles

Release profile (`opt-level=3`, `lto`, `codegen-units=1`, `panic="abort"`) lives
in this workspace root `Cargo.toml` — Cargo ignores `[profile.*]` in member
manifests, so keep it here.

## Adding a crate

Create `crates/<name>/`, add it to `members` in `Cargo.toml`, and add a
`wasm-pack build` step + `src/wasm/<name>` out-dir to the `build:wasm` script in
`package.json`.
