# Development

How to run, test and build websfm from source. [ARCHITECTURE.md](../ARCHITECTURE.md)
explains how the code is organised, [METHODS.md](METHODS.md) the algorithms, and
[CONTRIBUTING.md](../CONTRIBUTING.md) what a pull request needs.

## Running it locally

You need [Node.js](https://nodejs.org/) 22, the version CI uses. 20.19 or later and
24 work too (`engines` in `package.json`; `.nvmrc` selects 22 for nvm users). The
generated WASM bindings in `src/wasm/**` are committed, so you do **not** need a Rust
toolchain just to run or develop the front end:

```bash
npm install
npm run dev
```

Two kinds of large files are not in the repository and are optional for development:

```bash
npm run fetch:examples   # the example datasets of "Try an example" (~50 MB)
npm run fetch:models     # learned-model weights (ALIKED, DISK, LightGlue, SAM2; ~300 MB)
```

Without the examples, **Try an example** reports that they are not on the server.
Without the models, the learned detectors and Smart Select ask for a download that
fails. SIFT, matching and everything after it work without either. See
[Model files](deployment.md#model-files) for what each model is for.

## Tests & type-checking

```bash
npm test                # unit and store regression tests (Vitest, Node)
npm run typecheck       # TypeScript, Vue template bindings, ESLint
npm run test:wasm       # real LAZ WASM round-trip across compressor chunks
npm run check:wasm      # Rust source / committed WASM freshness
npx playwright install chromium
npm run test:browser    # browser storage, keyboard, import/export and multi-tab tests
cargo test --manifest-path crates/Cargo.toml --workspace --release
```

Type checking is incremental: executable TypeScript currently includes packed-point
views and project-index merging, alongside the shared data types and migrated
confirmation/modal-shell components. Every Vue template is checked for undeclared
bindings; JavaScript implementations are checked for undefined variables and
unreachable code. This does not yet provide full static typing of every store.
GitHub Actions runs all of the above plus a production build. To use an installed
Chrome locally, set `PLAYWRIGHT_CHANNEL=chrome`.

## Running the whole pipeline headless

The unit tests run in Node without a browser, so they cannot cover WebGPU, OPFS or
the workers end to end. The headless bench does: it runs the real app on a folder
of images in headless Chrome and reports per-stage numbers. With the example data
fetched, this runs every stage from detection to the orthophoto:

```bash
node scripts/bench/run-bench.mjs --config scripts/bench/example-aukerman.json
```

Results land in `bench-out/` (gitignored). [`scripts/bench/README.md`](../scripts/bench/README.md)
lists every option, including accuracy checks against reference data. Your own
bench configs go in `scripts/bench/configs/`, which is gitignored because configs
name datasets by local path.

## Rebuilding the WASM crates

You only need this when you change Rust code under `crates/`. It requires the Rust
toolchain plus [`wasm-pack`](https://rustwasm.github.io/wasm-pack/). The threaded
bundle-adjustment build (`src/wasm/reconstruction-mt`) also needs nightly Rust with
`rust-src` and the wasm32 target.

```bash
# one-time, per machine:
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # macOS/Linux
cargo install wasm-pack
rustup toolchain install nightly
rustup component add rust-src --toolchain nightly
rustup target add wasm32-unknown-unknown --toolchain nightly

# build all crates into src/wasm/<crate>/ and update the build stamp:
npm run build:wasm
```

On Windows, install Rust via [`rustup-init.exe`](https://rustup.rs), then
`cargo install wasm-pack`. Commit the regenerated `src/wasm/*` bindings alongside
the Rust change so fresh clones keep working without a toolchain; CI checks that
they match. [`crates/README.md`](../crates/README.md) describes the crates.

## Storage and limits

Persistence uses immutable buffer generations with a final metadata commit for
reconstructions and raster products. Failed saves remain visible and block project
switching/export until retried. Tabs coordinate index edits and, where Web Locks
are available, allow one editing session per project. These locks do not coordinate
separate browsers or devices writing a shared folder.

SfM ZIP extraction runs in a worker with limits of 1 GiB compressed, 512 MiB
selected output, 256 MiB per entry, 20,000 entries and a 200:1 expansion ratio.
LAS/LAZ imports have a 1 GiB estimated working-memory budget; the WASM decompressor
also caps raw records at 512 MiB. DEM point staging (24 B per in-region point) and
the DEM grid share the memory budget set in Settings ▸ Compute. Split or subsample
larger inputs. CSV exports prefix potentially executable **text** with an
apostrophe; numerical coordinates remain numbers. That protective apostrophe is part
of the exported value when reimported.

## Tech stack

- **UI:** Vue 3 (`<script setup>`), Pinia, OpenLayers (map), Three.js (3D).
- **Compute:** six Rust crates (`sift`, `matching`, `reconstruction`, `mesh`,
  `imagecodec`, `lazcodec`) compiled to WASM and run off the main thread.
- **Learned models:** ONNX Runtime Web (WebGPU + WASM backends).
- **Storage:** OPFS; projects are self-contained on-disk directories, also
  exportable as `.websfm` archives.
- **Build/test:** Vite, Vitest, Playwright.

## Releases

What changed between versions is in [CHANGELOG.md](../CHANGELOG.md), which the app
shows as Help ▸ What's New. Every deploy is a release: before the release build, cut
one with

```bash
npm run release -- --dry-run   # what would happen
npm run release                # 0.4.0 → 0.5.0; or `-- patch`, `-- major`, `-- 1.0.0`
git push && git push origin v0.5.0
```

It lists the `feat` / `fix` / `perf` commits since the last tag (add an entry for any
user-visible one it is missing first), moves `[Unreleased]` under the new version with
today's date, sets the version in `package.json`, commits and tags `v<version>`.
Users who return after a deploy see a count of the new entries on **What's New**. A
test checks that `package.json` names the newest release in the changelog.

Releases up to 0.4.0 were split after the fact, by the date each entry entered the
changelog; 0.2.0 holds everything from 0.1.0-beta.1 until the changelog began on
2026-10-12.
