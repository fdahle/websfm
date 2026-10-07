# websfm

**Structure-from-Motion and photogrammetry, entirely in your browser.**

websfm turns overlapping photographs into 3D reconstructions — sparse and dense
point clouds, meshes, digital elevation models and orthophotos — without
installing anything and **without uploading your images anywhere**. All the
computation runs locally: the heavy numerical work (feature detection, matching,
bundle adjustment, dense multi-view stereo) is written in Rust, compiled to
WebAssembly, and executed in a background worker thread. Your photos never leave
your machine.

It is built with a focus on **polar / non-WGS84 projects** (e.g. historical
aerial imagery of Antarctica), so coordinate-reference-system handling and ground
control are first-class throughout.

> ⚠️ **Early test release.** This is a first public build put out to gather
> feedback. Expect rough edges. Please report anything that breaks or feels wrong
> using the **🐞 button** in the bottom-right corner of the app, or open an issue
> directly at
> [github.com/fdahle/websfm/issues](https://github.com/fdahle/websfm/issues).

---

## What it does

A full photogrammetry pipeline, stage by stage:

1. **Detect** – SIFT (Rust/WASM) or the learned SuperPoint detector.
2. **Match** – brute-force descriptor matching or the learned LightGlue matcher,
   with fundamental-matrix RANSAC verification.
3. **Sparse SfM** – incremental reconstruction with P3P resection, LM bundle
   adjustment, self-calibration, and track filtering.
4. **Dense MVS** – PatchMatch depth maps fused into a dense point cloud
   (CPU/WASM, or an experimental WebGPU backend).
5. **Products** – DEM, true orthophoto, and screened-Poisson mesh.
6. **Georeferencing** – ground control points, camera poses, and reference DEMs,
   with reprojection into any project CRS (proj4).

There's also an in-app glossary, a quality-report hub, point-cloud editing, and
COLMAP / PLY / LAS / GeoTIFF import & export.

## Browser requirements

- A **Chromium-based browser** (Chrome, Edge, Brave, …) is recommended. The app
  uses [OPFS](https://developer.mozilla.org/docs/Web/API/File_System_API/Origin_private_file_system)
  for local project storage; folder-backed projects and WebGPU acceleration are
  Chromium-only. Firefox and Safari work with reduced acceleration.
- The learned backends (SuperPoint, LightGlue, Smart Select) download their model
  weights on first use — you'll be asked to confirm, and each file is cached
  locally afterwards (see [Model files](#model-files)).

---

## Running it locally

The generated WASM bindings in `src/wasm/**` are committed, so you do **not** need
a Rust toolchain just to run or develop the front end:

```bash
npm install
npm run dev
```

The ONNX model files are **not** committed (they are large). To exercise the
learned backends locally, drop the `.onnx` files into `public/models/` — see
[Model files](#model-files).

### Tests & type-checking

```bash
npm test                # unit and store regression tests
npm run typecheck       # TypeScript, Vue bindings, JavaScript correctness lint
npm run test:wasm       # real LAZ WASM round-trip across compressor chunks
npm run check:wasm      # Rust source / committed WASM freshness
npx playwright install chromium
npm run test:browser    # browser storage, keyboard, import/export and multi-tab tests
```

Type checking is incremental: executable TypeScript currently includes packed-point
views and project-index merging, alongside the shared data types and migrated
confirmation/modal-shell components. Every Vue template is checked for undeclared
bindings; JavaScript implementations are checked for undefined variables and
unreachable code. This does not yet provide full static typing of every store.
GitHub Actions runs these checks, native Rust tests, a production build and Chromium
regressions. To use an installed Chrome locally, set `PLAYWRIGHT_CHANNEL=chrome`.
After Rust changes, run `npm run build:wasm`; its final step updates the build stamp.

Persistence uses immutable buffer generations with a final metadata commit for
reconstructions and raster products. Existing projects remain readable; new
reconstruction saves use version 3 and require this application version or newer.
Failed saves remain visible and block project switching/export until retried.
Tabs coordinate index edits and, where Web Locks are available, allow one editing
session per project. These locks do not coordinate separate browsers or devices
writing a shared folder.

SfM ZIP extraction runs in a worker with limits of 1 GiB compressed, 512 MiB
selected output, 256 MiB per entry, 20,000 entries and a 200:1 expansion ratio.
LAS/LAZ imports have a 1 GiB estimated working-memory budget; the WASM decompressor
also caps raw records at 512 MiB. DEM staging and raster allocations each have a
512 MiB budget. Split or subsample larger inputs. CSV exports prefix potentially
executable **text** with an apostrophe; numerical coordinates remain numbers.
That protective apostrophe is part of the exported value when reimported.

---

## Building & self-hosting

```bash
npm ci
npm run build:release  # build dist/ and verify all release assets
npm run preview    # serve the production build locally
```

`dist/` is a static site and can be hosted on any static file server. Deploy it
over **HTTPS**: the browser storage APIs used for projects require a secure context
(plain HTTP is only suitable for local development on `localhost`).

The default build is for the domain root, such as `https://websfm.example/`. If the
app will live below a path, include that path at build time, with both slashes:

```bash
VITE_BASE_PATH=/websfm/ npm run build:release
# deploy dist/ at https://example.com/websfm/
```

Configure the production host as follows:

- **Model files.** Serve the redistributable `.onnx` weights (see below) at `<site>/models/`,
  or point the app elsewhere at build time with
  `VITE_MODEL_BASE_URL=https://your-cdn/models/ npm run build`.

  A separate model host must allow browser requests from the app origin, for
  example with `Access-Control-Allow-Origin: https://websfm.example`. Serve ONNX
  files as `application/octet-stream`.

- **Cross-origin isolation (optional, for speed).** For multi-threaded ONNX
  (~3× faster matching) the host must send these two response headers:

  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
  ```

  These are already set for `npm run dev` / `npm run preview`. Without them the
  app still works, single-threaded (the same graceful path as Safari).

- **Static file types.** Serve `.wasm` as `application/wasm` and `.mjs` as
  `text/javascript`. An incorrect WASM type disables streaming compilation and an
  incorrect MJS type prevents ONNX Runtime from loading.

- **Caching and compression.** The files below `assets/` have content hashes and
  can use `Cache-Control: public, max-age=31536000, immutable`. Keep `index.html`
  on `no-cache` so a release can point browsers at its new hashes. ORT runtime files
  live under `ort/<installed-onnxruntime-version>/`; revalidate unversioned `.mjs`,
  `.wasm` and `.onnx` files. When replacing model weights under the same name, also
  bump `MODEL_CACHE_NAME` in `src/core/models/registry.js` to invalidate Cache Storage.
  Enable Brotli or
  gzip for HTML, JavaScript and CSS; do not recompress `.wasm` or `.onnx` unless the
  server is configured to do so efficiently.

Before sharing a release, verify the real production URL rather than only the Vite
preview server:

```bash
curl -I https://websfm.example/
curl -I https://websfm.example/assets/NAME.wasm
curl -I https://websfm.example/ort/1.27.0/ort-wasm-simd-threaded.wasm
curl -I https://websfm.example/models/disk.onnx
```

Then perform one cold browser smoke test: create a project, import photographs, run
SIFT detection/matching/reconstruction, refresh and reopen the project, download a
learned model, and export/re-import a `.websfm` project.

### Model files

The learned-model weights are downloaded on demand and cached in the browser
(Cache Storage), so they are **not** part of the repository. The app fetches them
from `<site>/models/` by default. The files are:

| File | Used by | Size | Source (rename to the file name) |
| --- | --- | --- | --- |
| `disk.onnx` | DISK detector | 4 MB | [LightGlue-ONNX v1.0.0](https://github.com/fabio-sim/LightGlue-ONNX/releases/tag/v1.0.0) `disk.onnx` |
| `lightglue_disk.onnx` | LightGlue for DISK | 46 MB | same release, `disk_lightglue_fused_cpu.onnx` |
| `lightglue.onnx` | LightGlue for SuperPoint | 46 MB | same release, `superpoint_lightglue_fused_cpu.onnx` |
| `sam2_encoder.onnx` | Smart Select (SAM2) | 134 MB | [onnx-community/sam2-hiera-tiny](https://huggingface.co/onnx-community/sam2-hiera-tiny) `onnx/vision_encoder.onnx` |
| `sam2_decoder.onnx` | Smart Select (SAM2) | 21 MB | same repo, `onnx/prompt_encoder_mask_decoder.onnx` |

The two SAM2 files need their internal `value_info` entries removed before ONNX
Runtime accepts them (see `src/core/segment/README.md`).

**SuperPoint is not distributed.** Its pretrained weights carry Magic Leap's
academic / non-commercial research license, so do not host `superpoint.onnx`: users
who qualify download it themselves from the link in the app's download dialog and
hand the file over once. `npm run check:release` fails if the build contains it, and
Vite copies everything in `public/models/`, so remove a local copy before a release
build.

Place them wherever `VITE_MODEL_BASE_URL` (or the default `public/models/`)
points. The first time a user runs a learned backend, a modal asks to download
the required file(s) and shows progress; nothing is fetched until they agree.

---

## Rebuilding the WASM crates

You only need this when you change Rust code under `crates/`. It requires the Rust
toolchain plus [`wasm-pack`](https://rustwasm.github.io/wasm-pack/).

```bash
# one-time, per machine:
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # macOS/Linux
cargo install wasm-pack

# build all crates into src/wasm/<crate>/:
npm run build:wasm
```

On Windows, install Rust via [`rustup-init.exe`](https://rustup.rs), then
`cargo install wasm-pack`. Commit the regenerated `src/wasm/*` bindings alongside
the Rust change so fresh clones keep working without a toolchain.

---

## Tech stack

- **UI:** Vue 3 (`<script setup>`), Pinia, OpenLayers (map), Three.js (3D).
- **Compute:** six Rust crates (`sift`, `matching`, `reconstruction`, `mesh`,
  `imagecodec`, `lazcodec`) compiled to WASM and run off the main thread.
- **Learned models:** ONNX Runtime Web (WebGPU + WASM backends).
- **Storage:** OPFS; projects are self-contained on-disk directories, also
  exportable as `.websfm` archives.
- **Build/test:** Vite, Vitest.

Architecture notes for contributors live in [`CLAUDE.md`](CLAUDE.md) (code layout)
and [`METHODS.md`](METHODS.md) (the photogrammetry/SfM methods). Open work is in
[`TODO.md`](TODO.md), the record of what shipped and what it measured is in
[`HANDOVER.md`](HANDOVER.md), and [`VERIFICATION.csv`](VERIFICATION.csv) tracks
which manual/real-data checks have actually been run. Planning docs are under
[`docs/planning/`](docs/planning/).

## Development & AI assistance

I want to be upfront about how this is built. websfm is developed with substantial
help from AI coding tools (primarily [Claude Code](https://claude.com/claude-code);
AI-assisted commits are marked as such in the git history). The **direction, the
photogrammetry/SfM methods, and the review of every change are mine** — the tools
accelerate implementation, they don't decide what the software should do or vouch
for whether it's correct.

What that means for you:

- Treat outputs as you would from any early research tool: **verify reconstructions
  and measurements** before relying on them, and sanity-check georeferenced results
  against known control.
- Not all code paths have been exercised on real data yet; bug reports are genuinely
  useful and very welcome.
- The methods behind each stage are documented in [`METHODS.md`](METHODS.md) so you
  can see *what* the algorithms do and judge them on their merits, independent of how
  the code was written.

If this approach affects whether you'd use or trust the tool, I'd rather you know
than guess.

## Feedback

Found a bug or have a suggestion? Use the 🐞 button in the app, or open an issue:
**[github.com/fdahle/websfm/issues](https://github.com/fdahle/websfm/issues)**.
