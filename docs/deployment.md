# Deploying WebSfM

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
WebSfM's own export (fabio-sim ships ALIKED only fused with its matcher); the script's
header says how to reproduce them and checks them against the PyTorch models.

**SuperPoint is not distributed.** Its pretrained weights carry Magic Leap's
academic / non-commercial research license, so do not host `superpoint.onnx`: users
who qualify download it themselves from the link in the app's download dialog and
hand the file over once. A local copy in `public/models/` is fine for development:
the build leaves it out, and `npm run check:release` fails if a build contains it.

Place them wherever `VITE_MODEL_BASE_URL` (or the default `public/models/`)
points. The first time a user runs a learned backend, a modal asks to download
the required file(s) and shows progress; nothing is fetched until they agree.

## Cloudflare (websfm.app)

websfm.app runs on Cloudflare Workers: static assets serve `dist/`, and an R2 bucket
holds what static assets refuse (files over 25 MiB: the model weights and ORT's
WebGPU wasm). [`deploy/cloudflare/worker.js`](../deploy/cloudflare/worker.js) serves
those under their usual paths on the same origin, so the build needs no
`VITE_MODEL_BASE_URL`. [`public/_headers`](../public/_headers) sets the
cross-origin isolation and caching headers for the static assets.

Two sites, from one Worker config ([`wrangler.jsonc`](../deploy/cloudflare/wrangler.jsonc)):

| Site | Shows | Deployed when |
| --- | --- | --- |
| websfm.app | released versions | a version tag (`v0.5.0`) is pushed |
| dev.websfm.app | the latest `main`, behind a login | `main` is pushed |

GitHub Actions deploys both (the `deploy` job in
[`.github/workflows/verify.yml`](../.github/workflows/verify.yml)), after the tests
pass. A release is then:

```bash
npm run release                       # 0.4.0 → 0.5.0: changelog, package.json, commit + tag
git push && git push origin v0.5.0    # main → dev.websfm.app, the tag → websfm.app
```

The production job refuses a tag that is not the version in `package.json`. Each run
shows under the repository's **Actions** tab, and the last deploy of each site under
**Environments** (`dev`, `production`).

### Once: Cloudflare and GitHub

1. **R2** → create the bucket `websfm-data`.
2. **API token** (My Profile → API Tokens → Create Token): the **Edit Cloudflare
   Workers** template, limited to your account and the `websfm.app` zone.
3. **GitHub** → the repository's Settings → Secrets and variables → Actions → New
   repository secret, twice: `CLOUDFLARE_API_TOKEN` (the token) and
   `CLOUDFLARE_ACCOUNT_ID` (Workers & Pages → the account ID on the right, or
   `npx wrangler@4 whoami`).
4. The first deploy, and every model or ONNX Runtime change, uploads the large files
   to R2 by hand. Log Wrangler in once (`npx wrangler@4 login`), then:

   ```bash
   npm run fetch:models && npm run fetch:examples && npm run build:release
   node scripts/deploy-cloudflare.mjs --upload
   ```

   Both sites share the bucket. The first deploy creates the custom domains
   `websfm.app` and `dev.websfm.app`.

### Deploying by hand

The same commands the workflow runs, for when GitHub is not an option:

```bash
npm run fetch:models && npm run fetch:examples && npm run build:release
node scripts/deploy-cloudflare.mjs --dry-run         # check only
node scripts/deploy-cloudflare.mjs                   # websfm.app
node scripts/deploy-cloudflare.mjs --env dev         # dev.websfm.app
```

### dev.websfm.app behind a login

Cloudflare Access puts a login page in front of the site; only the email addresses
in its policy get through, with a one-time code sent to them.

1. Cloudflare dashboard → **Zero Trust**. The first time, choose a team name and the
   Free plan (up to 50 users).
2. **Access → Applications → Add an application → Self-hosted.** Name `websfm dev`,
   domain: subdomain `dev`, domain `websfm.app`. Session duration: as long as you like
   to stay logged in (24 hours, a month).
3. **Policy:** name `only me`, action **Allow**, include **Emails** → your address.
   To let a tester in, add theirs here.
4. **Login methods:** keep **One-time PIN**.
5. Check in a private window: dev.websfm.app shows the Cloudflare login, and
   websfm.app does not.

The Workers have no `*.workers.dev` or preview URL (`wrangler.jsonc`), so the login
cannot be bypassed. The dev origin has its own projects, model cache and service
worker: projects from websfm.app do not show there.

**Moving from another host.** Projects (OPFS) and downloaded models belong to an
origin: export each project as a `.websfm` file on the old address and import it on
the new one. Then redirect the old address (a Cloudflare Redirect Rule, 301 to
`https://websfm.app/${1}`).

Check the live headers as above, with the R2 paths among them:

```bash
curl -I https://websfm.app/
curl -I https://websfm.app/models/disk.onnx
curl -I https://websfm.app/ort/1.27.0/ort-wasm-simd-threaded.jsep.wasm
```
