# PLAN — more Auto-Mask strategies (executable spec)

> **Status (audited 2026-09-01): not started.** Open work: TODO ▸ Next ▸ M4.
> Owed manual checks: none yet — add rows to `VERIFICATION.csv` when it ships.

Self-contained implementation spec; execute the steps in order. Read CLAUDE.md
first (layering rules, worker conventions, the docs roles). Delete this file when
the implementation ships (done-log line into HANDOVER.md; manual checks move to
VERIFICATION.csv).

## Goal

The Auto-Mask modal currently has one strategy: exclude a fixed-px border. Add
content-based strategies so masks can be *generated from the image* instead of
hand-tuned numbers. Target use cases (this project's imagery: scanned aerial
film, polar scenes):

1. **Detect frame** — find the dark (or light) film border / scanner bed per
   image instead of guessing one px value for a whole group. Border widths vary
   per scan; a fixed 40 px either leaks frame into features or eats image.
2. **Colour / luminance key** — mask everything near a reference colour or
   beyond a brightness cut (near-black backgrounds, blown-out highlights,
   scanner white). With morphological cleanup so it doesn't produce salt-noise
   masks.
3. **Low-texture regions** — mask uniform areas (sky in obliques, open water,
   featureless snow). These contribute no stable features and are where garbage
   matches on glint / gradient noise come from.

Out of scope (do NOT build now — park in TODO.md):
- SAM2-based auto-masking (grid-prompted "segment everything", or propagating a
  Smart Select mask across a group by template matching). Smart Select already
  covers per-image semantic masking interactively.
- Moving-object / cloud-shadow masking.
- Any per-strategy persistence beyond the resulting mask PNG (masks stay the
  single source of truth; strategies are regenerable).

## Existing code you build on (read before starting)

- `src/core/mask.js` — mask convention (opaque red = excluded, alpha test),
  `paintBorderExclude` (pure) + `buildBorderMask(w, h, sides, base)` (canvas,
  worker-safe via OffscreenCanvas). New strategies keep this exact split: pure
  typed-array math + a thin canvas wrapper.
- `src/components/modals/AutoMaskModal.vue` — the modal. Groups images by
  dimensions, merge/replace semantics for existing masks, CSS `inset` +
  box-shadow preview trick for the border overlay.
- Worker plumbing: `workers/compute.worker.js` merges op registries
  (`...makeXOps(deps)`); `rasterize(url, maxDim)` → `{ data: RGBA, width,
  height, scale, natW, natH }` is injected into ops that read pixels.
  **Mandatory**: `await imagesStore.whenComputeReady(img)` then rasterize
  `img.computeUrl ?? img.url` (film scans are TIFFs; `img.url` is lossy JPEG).
- `rgbaToGray` in `src/core/sfm/geometry.js`.
- `useImagesStore.updateMask(id, dataUrl)`; defaults in
  `src/core/defaults.user.js`; modal flags in `useModalsStore`; log everything
  derived via `onLog` (category `'Mask'`).

## Architecture decision

Border stays main-thread (no pixels read). The three new strategies read image
pixels → they run in the **worker** as a new op registry
`workers/ops/mask.js` (`makeMaskOps({ rasterize })`, op `autoMask`), analysing
a **downscaled** raster (default `maxDim: 1024`) and returning either four
margins (frame detect) or a coarse binary mask that the store-side canvas
wrapper scales up to full res. Scaling a binary mask up is fine here — masks
are exclusion hints, and every strategy has a dilate/pad param that covers the
resampling fuzz. Per-image work → the modal gets progress + cancel (reuse the
computeClient pool pattern; concurrency like detect).

---

## Step 1 — pure core module `src/core/maskAuto.js` (+ tests)

Pure, worker-safe, plain typed arrays. Grayscale input `Uint8Array`/
`Float32Array` (w·h) from `rgbaToGray`. Co-locate tuning defaults at top,
export as `AUTOMASK_TUNING` (self-contained-module exception in CLAUDE.md).

Shared binary-mask helpers (Uint8Array 0/1, w, h):
- `dilateMask(mask, w, h, r)` / `erodeMask(...)` — square structuring element,
  two-pass separable (rows then cols) so r=8 on 1024² stays cheap.
- `openClose(mask, w, h, r)` — close then open; the standard denoise for
  threshold masks.
- `keepBorderConnected(mask, w, h)` — flood fill from all border pixels, keep
  only components touching the border. This is the safety rail that stops the
  colour-key and low-texture strategies from masking dark shadows or smooth
  surfaces in the scene interior (frame/sky/background always touch an edge);
  exposed as a per-strategy toggle, default ON for colour key, ON for
  low-texture "sky mode".

Strategy cores:

1. `detectFrameMargins(gray, w, h, opts)` → `{ top, right, bottom, left,
   polarity }` in *analysis* px (caller rescales by `1/scale`).
   Row/column mean luminance profiles from each edge inward; the border is the
   contiguous run whose mean is beyond a threshold derived from the image
   itself (compare against the interior median — e.g. run continues while
   `rowMean < 0.5·interiorMedian` for a dark frame, mirrored test for light).
   Polarity auto-detected from the outermost 2 rows/cols vs interior median;
   search capped at `maxFrac` (default 0.25) of each dimension; per-side
   independent (data strips are one-sided). Add `pad` px after detection.
   Return per-side confidence (contrast of run vs interior) so the modal can
   flag "no frame found on left" instead of silently masking 0.
2. `colorKeyMask(rgba, w, h, { ref: [r,g,b], tol, mode })` → Uint8Array.
   Distance in RGB (max-channel diff is fine, no colour science needed);
   `mode: 'color' | 'dark' | 'bright'` where dark/bright are luminance cuts
   (presets that skip the eyedropper). Then `openClose(r=2)`, optional
   `keepBorderConnected`, then `dilateMask(pad)`.
3. `lowTextureMask(gray, w, h, { window, thresh })` → Uint8Array.
   Gradient magnitude (simple central differences — no Sobel needed), box-mean
   over `window` (default 15 at analysis scale, separable), mask where below
   `thresh`. Then optional `keepBorderConnected` ("sky/background mode",
   default ON) or unrestricted ("mask all flat areas"), open/close, dilate.

Tests (Vitest, synthetic rasters): frame with asymmetric dark border + one
data strip → exact margins ± 1 px, both polarities, no-frame image → zero
margins with low confidence; colour key on a synthetic two-tone image with
speckle → speckle removed, interior blob dropped when border-connected is on;
low-texture on flat-top/textured-bottom gradient image → top masked, bottom
kept; morphology round-trips (dilate∘erode identity on solid blob).

## Step 2 — worker op `workers/ops/mask.js`

`makeMaskOps({ rasterize })` returning `{ autoMask }`:
- args: `{ url, maxDim, strategy, params }`.
- rasterize → `rgbaToGray` where needed → strategy core.
- returns for `frame`: `{ margins (full-res px, rescaled + rounded outward),
  confidence }` — the store then reuses the existing `buildBorderMask`.
- returns for `colorKey`/`lowTexture`: `{ mask: Uint8Array, w, h, scale,
  excludedFrac }`, transfer the buffer.
- Log one line per image: strategy, derived values (margins/threshold/
  excluded %), duration.

Store side (`useImagesStore` or a small `composables/useAutoMask.js` used by
the modal — prefer the composable; the store shouldn't grow strategy logic):
`applyAutoMask(images, strategy, params, { existing, onProgress })` —
per image: `whenComputeReady` → op call → upscale coarse mask into a full-res
OffscreenCanvas (add `maskFromCoarse(mask, w, h, natW, natH, base)` next to
`buildBorderMask` in `core/mask.js`, drawing `base` first for merge mode) →
`updateMask`. Guard: refuse to write a mask whose `excludedFrac > 0.9`
(strategy misfire — log + report as skipped, don't destroy the image).

## Step 3 — modal UI

Rework `AutoMaskModal.vue` into a strategy picker (radio row or segmented
control: **Border · Detect frame · Colour key · Low texture**) with one params
section per strategy; merge/replace row and the group list stay shared.

- **Border**: unchanged.
- **Detect frame**: `pad` px, polarity `auto|dark|light`, `maxFrac` hidden
  (tuning). Preview = run the op on the group's first image only, show the
  detected margins with the existing inset overlay + per-side confidence.
- **Colour key**: mode preset (near-black / near-white / pick colour), `tol`
  slider, `pad`, border-connected toggle. Pick-colour = eyedropper on the
  preview thumb (canvas click → rgba).
- **Low texture**: sensitivity slider (maps to `thresh`), border-connected
  toggle, `pad`.
- Preview for the pixel strategies: run on first image of group, composite the
  returned coarse mask as a red overlay on the thumb (small canvas, cheap).
  Debounce param changes.
- Bulk apply gets a progress bar + cancel (per-image loop is awaitable, so a
  `cancelled` flag between images suffices; no pool terminate needed).
- Per-image failures (low confidence, >90 % excluded) collect into a summary
  line: "applied 41, skipped 3 (see log)".

## Step 4 — defaults, docs, bookkeeping

- `AUTOMASK_DEFAULTS` in `defaults.user.js` (strategy + per-strategy
  user-facing params; the modal prefills from it, the composable falls back to
  it). Internal knobs (`maxDim`, `maxFrac`, morphology radii) stay in
  `AUTOMASK_TUNING` in `maskAuto.js`.
- Update the mask glossary entry (or add `masking-strategies`) describing the
  four strategies and when to use which.
- CLAUDE.md: one-line update where `mask.js` is described (new `maskAuto.js` +
  `ops/mask.js`). METHODS.md only if you consider low-texture masking a
  *method* statement (one paragraph: why texture-less regions are excluded).
- TODO.md: remove the auto-mask item, add the parked SAM2-propagation idea.
  HANDOVER.md: done-log line. Delete this file.

## Verification

`npm test` + `npm run typecheck` per step. The modal/eyedropper/preview and
the worker round-trip need a manual browser run — verify on a real film-scan
project: (a) Detect frame on a group with varying border widths, compare
against a hand-drawn mask; (b) Colour key near-black on the same set; (c) Low
texture on an oblique with sky. Confirm detect/dense actually respect the new
masks (keypoint count drops in the border region).
