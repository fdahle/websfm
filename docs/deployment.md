# Deploying websfm

```bash
npm ci
npm run fetch:models     # learned-model weights (see Model files)
npm run fetch:examples   # example datasets for the project picker
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
  can use `Cache-Control: public, max-age=31536000, immutable`. Keep `index.html`,
  `sw.js` and `manifest.webmanifest` on `no-cache` so a release can point browsers
  at its new hashes. ORT runtime files
  live under `ort/<installed-onnxruntime-version>/`; revalidate unversioned `.mjs`,
  `.wasm` and `.onnx` files. When replacing model weights under the same name, also
  bump `MODEL_CACHE_NAME` in `src/core/models/registry.js` to invalidate Cache Storage.
  Enable Brotli or
  gzip for HTML, JavaScript and CSS; do not recompress `.wasm` or `.onnx` unless the
  server is configured to do so efficiently.

- **Installable app and offline use.** The build includes a web app manifest and a
  service worker (`sw.js`) that stores the app in the browser, so it can be
  installed and started without a connection. Model weights are stored separately,
  after the user's download consent. Viewed basemap tiles up to zoom 12 are kept
  for offline use (about 50 MB at most; `src/core/offlineCache.js`). A new release
  installs in the background and asks the user to reload; it never reloads during
  a running task. The service worker only works over HTTPS (or on `localhost`).

- **Example datasets.** The project picker's **Try an example** downloads its images
  from `<site>/examples/<id>/` (see [`src/core/examples.js`](../src/core/examples.js)).
  Run `npm run fetch:examples` before the release build to put them in
  `public/examples/`, or point the app elsewhere with `VITE_EXAMPLE_BASE_URL`. The
  service worker does not precache them.

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

## Model files

The learned-model weights are downloaded on demand and cached in the browser
(Cache Storage), so they are **not** part of the repository. The app fetches them
from `<site>/models/` by default. The redistributable files are published as
assets of the [`models-v1` release](https://github.com/fdahle/websfm/releases/tag/models-v1);
on the host, run this before the release build:

```bash
npm run fetch:models   # downloads into public/models/ and verifies SHA-256
npm run build:release
```

Release assets send no CORS headers, so the app cannot load them from GitHub
directly; the host must serve its own copy. The files are:

| File | Used by | Size | Source (rename to the file name) |
| --- | --- | --- | --- |
| `disk.onnx` | DISK detector | 4 MB | [LightGlue-ONNX v1.0.0](https://github.com/fabio-sim/LightGlue-ONNX/releases/tag/v1.0.0) `disk.onnx` |
| `lightglue_disk.onnx` | LightGlue for DISK | 46 MB | same release, `disk_lightglue_fused_cpu.onnx` |
| `lightglue.onnx` | LightGlue for SuperPoint | 46 MB | same release, `superpoint_lightglue_fused_cpu.onnx` |
| `aliked.onnx` | ALIKED detector | 3 MB | exported by `scripts/models/export-aliked.py` from [cvg/LightGlue](https://github.com/cvg/LightGlue)'s ALIKED (aliked-n16) |
| `lightglue_aliked.onnx` | LightGlue for ALIKED | 46 MB | same script, cvg/LightGlue `aliked_lightglue` weights |
| `sam2_encoder.onnx` | Smart Select (SAM2) | 134 MB | [onnx-community/sam2-hiera-tiny](https://huggingface.co/onnx-community/sam2-hiera-tiny) `onnx/vision_encoder.onnx` |
| `sam2_decoder.onnx` | Smart Select (SAM2) | 21 MB | same repo, `onnx/prompt_encoder_mask_decoder.onnx` |

The two SAM2 files need their internal `value_info` entries removed before ONNX
Runtime accepts them (see [`src/core/segment/README.md`](../src/core/segment/README.md)). The two ALIKED files are
websfm's own export (fabio-sim ships ALIKED only fused with its matcher); the script's
header says how to reproduce them and checks them against the PyTorch models.

**SuperPoint is not distributed.** Its pretrained weights carry Magic Leap's
academic / non-commercial research license, so do not host `superpoint.onnx`: users
who qualify download it themselves from the link in the app's download dialog and
hand the file over once. A local copy in `public/models/` is fine for development:
the build leaves it out, and `npm run check:release` fails if a build contains it.

Place them wherever `VITE_MODEL_BASE_URL` (or the default `public/models/`)
points. The first time a user runs a learned backend, a modal asks to download
the required file(s) and shows progress; nothing is fetched until they agree.
