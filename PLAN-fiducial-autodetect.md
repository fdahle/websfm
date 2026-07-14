# PLAN — auto-detect fiducial marks on film scans (executable spec)

Status: not started. This file is a self-contained implementation spec; execute the
steps in order. Read CLAUDE.md first (layering rules, worker conventions, the
four-docs rule). Delete this file when the feature ships (fold the done-log line
into HANDOVER.md per the four-docs rule).

## Goal & approach

Marking fiducials manually on every scanned film image is tedious. Let the user
mark all fiducials on **one reference image per film sensor**, then auto-detect the
same marks on every other image of that sensor by **ZNCC template matching**
(the HSfM / MicMac-Kugelhupf approach: within one scan batch the film frame lands
in nearly the same scan position every time, so a template cut from the reference
image + a small search window finds each mark). QC gates flag failures for manual
fixing instead of silently writing bad observations.

Out of scope (do NOT build): template-free / CNN detection, certificate-distortion
fitting, cross-project template reuse.

## Existing code you build on (read these before starting)

- `src/core/sfm/fiducials.js` — pure interior-orientation math. You will reuse
  `fitFiducialAffine(obs)` (QC gate: its `rmsUm`) and `mmToScan(xMm, yMm, A)`
  (window prediction when a target image already has ≥3 obs).
- Sensor model (`useSensorsStore`): a film sensor has `kind:'film'` and
  `s.fiducials = { marks: [{id, xMm, yMm}], ppxMm, ppyMm, focalMm }`.
- Image model (`useImagesStore`): `img.sensorId` links image→sensor;
  `img.fiducialObs = [{ fidId, px, py }]` in **scan pixels**;
  `setFiducialObservation(imageId, fidId, px, py)` upserts one (and syncs per
  call — see step 3 for the bulk path). `whenComputeReady(img)` +
  `img.computeUrl ?? img.url` is mandatory before rasterizing (film scans are
  TIFFs; `img.url` is a lossy display JPEG).
- Worker plumbing: `src/workers/compute.worker.js` merges op registries
  (`...makeDetectOps({ rasterize })`); `src/workers/computeClient.js` `call(op,
  args, { transfer, onEvent, worker })` + thin exported wrappers.
  `rasterize(url, maxDim)` → `{ data:Uint8ClampedArray RGBA, width, height,
  scale, natW, natH }` (downscales to maxDim; cannot crop).
- `rgbaToGray` lives in `src/core/sfm/geometry.js`.
- UI conventions: modal open flags in `src/stores/useModalsStore.js`; user-facing
  defaults in `src/core/defaults.user.js` (modal prefills from it AND core falls
  back to it); Ribbon commands dispatched in `App.vue`; every derived value gets
  an `onLog` line (category `'Fiducial'`).

---

## Step 1 — pure core module `src/core/sfm/fiducialDetect.js` (+ tests)

Pure, worker-safe (no Vue/Pinia/DOM). Plain typed arrays in/out. Co-locate the
internal tuning defaults at the top of this module (the self-contained-module
exception in CLAUDE.md), exported as `FIDUCIAL_DETECT_TUNING` so tests can read
them:

```js
export const FIDUCIAL_DETECT_TUNING = {
  templateHalf: 32,     // template = (2·half+1)² px cut from the reference image
  coarseScale: 1 / 8,   // coarse-pass downscale of window + template
  refineHalf: 48,       // full-res refine window half-size around the coarse peak
}
```

Exported API (all grayscale images are `{ data: Float32Array, width, height }`,
row-major, values 0..255):

1. `grayFromRgba(rgba, width, height)` → gray image. Delegate the per-pixel math
   to `rgbaToGray` from `geometry.js` if its signature fits; otherwise implement
   the standard 0.299/0.587/0.114 luma here (check `geometry.js` first).
2. `extractPatch(gray, cx, cy, half)` → `{ data: Float32Array, size: 2*half+1 }`,
   center rounded to int px. Out-of-bounds source pixels → edge-clamp. Returns
   `null` if the center is outside the image.
3. `downscalePatch(patch, scale)` → box-filter downscale (used for the coarse
   template and coarse window). Simple average pooling is fine.
4. `rotatePatch90(patch, k)` → patch rotated k·90° CW (k ∈ 0..3).
5. `matchZNCC(gray, tpl, x0, y0, x1, y1)` — slide `tpl` over the inclusive
   center-position range `[x0..x1]×[y0..y1]` of `gray`, computing zero-mean
   normalized cross-correlation at each position:
   `zncc = Σ((I−Ī)(T−T̄)) / sqrt(Σ(I−Ī)² · Σ(T−T̄)²)`, guarding a zero
   denominator (flat patch) → score 0. Return
   `{ x, y, score, scores?: null }` for the best position. Precompute the
   template mean/energy once. O(window·tpl) brute force is fine (windows are
   small — see cost note below); do NOT add wasm.
6. `subpixelPeak(gray, tpl, px, py)` — evaluate ZNCC on the 3×3 integer
   neighbourhood of `(px,py)` and fit a 2D quadratic (separable parabola per
   axis: `dx = (s[-1]−s[+1]) / (2·(s[-1]−2·s[0]+s[+1]))`, clamp |dx|,|dy| ≤ 0.5,
   0 if degenerate). Return `{ x: px+dx, y: py+dy }`.
7. `detectFiducialsInImage(gray, templates, predictions, cfg)` — the per-image
   orchestrator. Args:
   - `templates`: `[{ fidId, patch }]` (full-res, from the reference image),
   - `predictions`: `[{ fidId, px, py, radius }]` in this image's scan px,
   - `cfg`: `{ ...FIDUCIAL_DETECT_TUNING, tryRotations: boolean }`.
   Algorithm:
   - If `tryRotations`: run the coarse pass for the **first** prediction with all
     four `rotatePatch90(tpl, k)` variants over the **whole image** at coarse
     scale (not just the window — a rotated scan moves the marks), pick the best
     k, remap every prediction `(px,py)` by the same k-rotation of image coords
     (`k=1: (x,y)→(H−1−y, x)` etc. — write the four mappings explicitly with a
     comment, this is a conventions bug magnet), and rotate all templates by k.
     If the best rotated score is not clearly better than k=0 (< 0.1 margin),
     keep k=0.
   - Per mark: coarse ZNCC (downscaled template over the downscaled window
     `±radius` around the prediction) → peak → full-res ZNCC over
     `±refineHalf` around the upscaled peak → `subpixelPeak`.
   - Return `[{ fidId, px, py, score, coarseScore, rotationK }]` — always all
     marks, gating happens in the store (the worker doesn't know thresholds or
     population stats).
8. Re-export nothing from `fiducials.js`; the affine QC runs store-side.

**Tests** (`src/core/sfm/fiducialDetect.test.js`, Vitest, synthetic rasters —
render a cross/dot pattern into a Float32Array):
- exact recovery: planted template found at the planted position, score > 0.95;
- sub-pixel: target shifted by (0.3, −0.4) px via bilinear resampling →
  recovered within 0.15 px;
- rotation: image rotated 90/180/270 → correct `rotationK`, positions map back;
- noise: additive gaussian noise σ=10 on 0..255 → still found, score > 0.7;
- absent mark (blank window) → score < 0.3;
- flat window (constant) → score 0, no NaN.

**Acceptance for step 1**: `npm test` green; no imports from vue/pinia/opfs.

## Step 2 — worker op + computeClient wrappers

In `src/workers/ops/detect.js` (inside `makeDetectOps({ rasterize })`, alongside
the existing detectors), add two ops:

- `prepareFiducialTemplates(url, obs, options)` — `obs = [{fidId, px, py}]` (the
  reference image's observations, plain objects). Fetch+decode the image **once
  at full resolution**: do NOT use `rasterize(url, Infinity)` blindly — a
  10k×10k RGBA raster is ~400 MB. Instead decode the blob to an `ImageBitmap`
  once and draw only a `(2·templateHalf+1)²` source-rect per mark into a small
  OffscreenCanvas (`ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh)`), then
  `grayFromRgba` + package. Return
  `{ templates: [{fidId, size, data: Float32Array}], natW, natH }` with every
  `data.buffer` in the op's `transfer` list.
- `detectFiducials(url, templates, predictions, options)` — decode the target
  image once to an ImageBitmap; build (a) one coarse full-image gray at
  `coarseScale` via a scaled drawImage, and (b) per-mark full-res gray crops of
  the refine windows via source-rect drawImage (same bounded-memory pattern).
  Adapt `detectFiducialsInImage` to consume these crops: simplest is to keep the
  core function operating on `{gray, originX, originY}` window structs — decide
  in step 1 and keep the core signature honest (the core stays pure; the
  *cropping* is the worker's job because only the worker has OffscreenCanvas).
  Return `{ results: [{fidId, px, py, score, coarseScore, rotationK}], ms }`
  (positions in native scan px — divide coarse coords by the actual drawn scale,
  don't trust `coarseScale` alone since drawImage rounds). Nothing big to
  transfer back. Templates arrive per call (they were transferred to the client
  once and are structured-cloned into each detect call — do NOT put the
  template buffers in this call's transfer list on the client side, they're
  reused across images).

In `src/workers/computeClient.js`, add mirroring the existing style:

```js
export function prepareFiducialTemplates(url, obs, options = {}) {
  return call('prepareFiducialTemplates', [url, obs, options])
}
export function detectFiducials(url, templates, predictions, options = {}) {
  return call('detectFiducials', [url, templates, predictions, options])
}
```

Round-robin is fine (no heavy per-worker runtime, no pinning).

**Acceptance for step 2**: typecheck green; ops registered (grep the merged
registry); a quick node-side unit test of the op handlers is NOT required
(OffscreenCanvas is browser-only — say so in the final report).

## Step 3 — store orchestration in `src/stores/useImagesStore.js`

Add `FIDUCIAL_DETECT_DEFAULTS` to `src/core/defaults.user.js`:

```js
export const FIDUCIAL_DETECT_DEFAULTS = {
  searchRadiusPct: 4,   // search window half-size, % of max(image w, h)
  minScore: 0.7,        // absolute ZNCC floor
  maxRmsUm: 30,         // affine-fit RMS gate (µm) — matches manual-marking quality
  overwrite: false,     // replace existing (manual) observations
  tryRotations: true,
}
```

Add to the images store:

```js
async function autoDetectFiducials({ sensor, refUuid, settings = {}, onProgress } = {})
```

- `cfg = { ...FIDUCIAL_DETECT_DEFAULTS, ...settings }`.
- Reference image = `imageById(refUuid)`; require ≥3 `fiducialObs` whose `fidId`s
  exist in `sensor.fiducials.marks`, else log+throw.
- `await whenComputeReady(refImg)`, call `prepareFiducialTemplates(refImg.computeUrl
  ?? refImg.url, plainObs, { templateHalf })`. Marshal `fiducialObs` to plain
  objects (`.map(o => ({...o}))`) — Vue proxies don't structured-clone.
- Targets = all images with `img.sensorId === sensor.id`, excluding `refUuid`;
  skip images that already have obs for **every** mark unless `cfg.overwrite`.
- Per target (concurrency: reuse the pattern `matchAll` uses — a simple
  promise-pool at `POOL_SIZE`; read `useMatchesStore.matchAll` and copy its
  loop shape): `await whenComputeReady(img)`; build predictions — if the target
  already has ≥3 obs, `fitFiducialAffine` + `mmToScan` per mark; else the
  reference image's own obs positions scaled by
  `(target natW / ref natW, natH ratio)` (dims from the image records);
  `radius = cfg.searchRadiusPct/100 · max(w,h)`. Call `detectFiducials`.
- **QC, in order** (all decisions logged per image, category `'Fiducial'`):
  1. per-mark absolute gate: `score < cfg.minScore` → mark rejected;
  2. after all images finish, population gate: for each `fidId`, median score
     across accepted detections; reject detections `> 0.2` below their mark's
     median (catches confident-wrong matches);
  3. per-image geometric gate: join surviving detections with the sensor's mm
     marks, `fitFiducialAffine`; if `rmsUm > cfg.maxRmsUm` drop the
     worst-residual mark and refit once; still over → image `status:'failed'`,
     write nothing for it.
  (Because gate 2 is population-wide, buffer all results and apply obs in a
  second pass — do not write during the detection loop.)
- Apply: for each surviving detection, upsert into `img.fiducialObs` directly
  (skip existing `fidId` unless `cfg.overwrite`) **without** calling
  `setFiducialObservation` per mark (it `sync()`s and logs per call — hundreds
  of writes). Mutate, log one summary line per image, then one `sync()` at the
  end. Respect `isPersisting()`.
- Return `{ perImage: [{ uuid, name, status: 'ok'|'partial'|'failed'|'skipped',
  applied, rejected, rmsUm, rotationK }] }` for the modal's results view.
- `onProgress(done, total)` per finished image.

**Acceptance for step 3**: a Vitest unit test for the QC/refit logic only
(factor gates 2+3 into a small pure helper — e.g. `gateFiducialDetections(
resultsPerImage, marks, cfg)` in `fiducialDetect.js` — so it's testable without
the store): planted outlier mark → dropped by refit; low-score image → failed.

## Step 4 — UI

1. `useModalsStore`: add `fiducialDetectOpen = ref(false)` and
   `fiducialDetectSensorId = ref(null)` (which sensor the modal targets); export
   both.
2. New `src/components/modals/FiducialDetectModal.vue` — copy the structure of an
   existing single-action modal (`DepthMapsModal.vue` is the closest shape:
   settings + run + progress). Contents:
   - reference-image `<select>` over the sensor's images, default = the image
     with the most `fiducialObs`; disabled state + hint when no image has ≥3 obs
     ("mark at least 3 fiducials on one image first");
   - inputs prefilled from `FIDUCIAL_DETECT_DEFAULTS`: search radius (%), min
     score, max RMS (µm); checkboxes: overwrite existing, try rotations;
   - Run → calls `imagesStore.autoDetectFiducials`, progress bar, then a results
     table (name, status chip, applied/rejected counts, RMS µm); clicking a row
     emits `open-image` (App.vue already opens image tabs — wire to the same
     handler ImageTable uses; find it by grepping `openImageTab` in App.vue).
     Review UX beyond that is the existing fiducial overlay in the image viewer.
   - Escape-close via the existing `useModalEscape` pattern (see how other
     modals register).
3. Entry points:
   - `SensorTable.vue`: in the expanded fiducial editor of a film sensor, add an
     "Auto-detect on all images…" button that emits a new
     `detect-fiducials(sensorId)` event; `SensorTableModal.vue` re-emits; App.vue
     sets `fiducialDetectSensorId` + `fiducialDetectOpen`. Disable (with title
     tooltip) when the sensor has <3 marks.
   - `Ribbon.vue`: no new command needed for v1 (the sensor table is the home of
     film-sensor actions); skip unless trivially cheap.
4. App.vue: mount the modal next to the other modals, pass the sensor +
   its images, wire `open-image`.

**Acceptance for step 4**: `npm run typecheck` + `npm test` green. The modal flow
needs a manual browser run this environment may not support — if you cannot run a
browser, state that explicitly in your final report per CLAUDE.md's Verification
policy; do NOT claim it verified.

## Step 5 — docs (the four-docs rule)

- METHODS.md: short "Automatic fiducial measurement" paragraph under the film /
  interior-orientation section: ZNCC template matching from one reference image,
  coarse-to-fine with sub-pixel quadratic peak, QC = absolute score floor +
  per-mark population median band + affine-RMS refit gate (approach follows
  HSfM, Knuth et al. 2023, and MicMac's Kugelhupf).
- CLAUDE.md: one sentence in the F4 film-scan bullet noting
  `fiducialDetect.js` + the two worker ops exist and where the defaults live.
- TODO.md: remove the item if present; HANDOVER.md: one done-log line.
- Delete this PLAN file.

## Cost & memory guardrails (why the numbers are what they are)

- Never materialize a full-res RGBA raster of a scan (10k×10k ≈ 400 MB); the
  ImageBitmap + source-rect-crop pattern in step 2 is the required shape.
- Per-mark work: coarse window (2·4%·10k·⅛ ≈ 100 px)² × coarse template (~8 px)²
  ≈ 6×10⁵ MACs, refine (96 px)² × (65 px)² ≈ 4×10⁷ — milliseconds in JS. If you
  find yourself wanting wasm, the windows are wrong.

## Gotchas checklist (from CLAUDE.md, all apply here)

- [ ] `img.computeUrl ?? img.url` + `await whenComputeReady(img)` at every
      raster consumer (both ops' call sites).
- [ ] Marshal store state to plain objects/arrays before `call()` (Vue proxies
      don't structured-clone).
- [ ] Transfer template buffers back from `prepareFiducialTemplates`; do NOT
      transfer them into per-image `detectFiducials` calls (reused).
- [ ] One `sync()` at the end of the run, not per observation.
- [ ] Every derived value (chosen rotation, predicted vs matched px, scores,
      RMS, gate verdicts) gets an `onLog`/store-log line, category `'Fiducial'`.
- [ ] Defaults live once: user knobs in `defaults.user.js`, algorithm tuning
      co-located in `fiducialDetect.js`; the modal prefills from the former.
- [ ] Coordinate mappings for the 4 rotations written out with a convention
      comment + covered by the rotation test (interop conversions are the #1
      bug source in this codebase).
