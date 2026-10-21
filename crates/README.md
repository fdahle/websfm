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

## Threads

`reconstruction` is built twice. `src/wasm/reconstruction` is the plain build;
`src/wasm/reconstruction-mt` is the same crate with `--features threads`
(`scripts/build-wasm-mt.mjs`, run by `build:wasm`): wasm atomics, a shared memory of
up to 4 GiB, and a rayon pool that `initThreadPool(n)` starts as Web Workers sharing
that memory (wasm-bindgen-rayon). The bundle adjustment's assembly, Schur step, cost,
back-substitution and sparse Cholesky run on it (`par.rs`). The Cholesky is
left-looking: a supernode gathers its sources' updates in ascending order, the same
subtractions a right-looking factor makes, and a big one is cut into row chunks
(`sparse_chol.rs`; a test holds it to the old right-looking factor bit for bit).
Spreading a right-looking supernode's updates over its targets instead was slower.

`core/sfm/reconstruction.js` uses the threaded build for `bundleAdjust` only in a
worker of a cross-origin isolated page (shared memory, and a thread may block in
`Atomics.wait`, which a page's main thread may not), up to `SFM_TUNING.baSolver.threads`
threads; anywhere else, Node tests included, it uses the plain build. Both give the
**same bits**, whatever the thread count: the work is cut into ranges fixed by the
camera count alone, every element of the reduced system has one writing range and gets
its terms in a fixed order (`bundle.rs` `RangePlan`), and every sum over observations
is taken in index order. Keep it that way: a parallel reduction whose order depends on
the thread count would make a reconstruction differ between machines. (Against the
single loop before threads: the same bits without self-calibration; with it, the
shared intrinsics blocks are summed range by range and may round differently.)
`tests/browser/ba-scale.spec.js` (opt-in, `BA_SCALE=40`) checks the bits and times
both builds on 1,600 synthetic cameras.

The threaded build needs **nightly** Rust (it rebuilds `std` with atomics):

```
rustup toolchain install nightly
rustup component add rust-src --toolchain nightly
rustup target add wasm32-unknown-unknown --toolchain nightly
```

Built with `rustc 1.101.0-nightly (2026-10-20)`. The link flags (shared, imported
memory; the TLS and heap symbols) are in the script because recent Rust no longer adds
them for `+atomics`, and wasm-bindgen refuses the module without them.

## Profiles

Release profile (`opt-level=3`, `lto`, `codegen-units=1`, `panic="abort"`) lives
in this workspace root `Cargo.toml` — Cargo ignores `[profile.*]` in member
manifests, so keep it here.

## Adding a crate

Create `crates/<name>/`, add it to `members` in `Cargo.toml`, and add a
`wasm-pack build` step + `src/wasm/<name>` out-dir to the `build:wasm` script in
`package.json`.
