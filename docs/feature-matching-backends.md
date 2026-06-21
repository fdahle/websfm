# Feature Matching Backends — Implementation Plan

## Goal

Offer multiple detector/matcher backends selectable by the user, rather than committing to one pipeline. The current SIFT approach stays as the default (offline-capable, zero download, fast). Neural backends are opt-in.

| Backend | Detector | Matcher | Quality | Extra download |
|---|---|---|---|---|
| **SIFT** (current) | SIFT (Rust WASM) | Ratio test + RANSAC (Rust WASM) | Decent | None |
| **SIFT + LightGlue** | SIFT (Rust WASM) | LightGlue ONNX | Good | ~30 MB |
| **SuperPoint + LightGlue** | SuperPoint ONNX | LightGlue ONNX | Best | ~35 MB |

---

## What is ONNX Runtime Web?

**ONNX** (Open Neural Network Exchange) is a standard file format for ML models. PyTorch/TensorFlow models can be exported to `.onnx`. `onnxruntime-web` is Microsoft's browser runtime for executing them — no server needed.

It has three execution backends, tried in priority order:
- **WebGPU** — GPU-accelerated, modern browsers only, fastest
- **WebGL** — GPU-accelerated, wider support
- **WASM** — CPU fallback, works everywhere

Install: `npm install onnxruntime-web`

Model source: [`Kololu2/lightglue-onnx`](https://huggingface.co/Kololu2/lightglue-onnx) on HuggingFace has pre-exported SuperPoint and LightGlue-SuperPoint ONNX files with documented tensor shapes.

---

## Current Architecture (reference)

### Data flow
```
Image upload
  → useImages.detectOne()
  → detectKeypoints(url)         ← src/utils/sift.js
  → WASM detect_sift(RGBA)       ← crates/sift/src/lib.rs
  → Float32Array (STRIDE=133 per keypoint)
     [x, y, scale, response, angle, d0..d127]
  → stored in image object + OPFS

matchPair(imgA, imgB)
  → match_descriptors()          ← crates/matching/src/lib.rs (Lowe ratio test)
  → verify_matches()             ← crates/matching/src/lib.rs (RANSAC + fundamental matrix)
  → { matches: [[ia,ib],...], F, inlierCount } stored in OPFS
```

### Key files
- `src/utils/sift.js` — wraps WASM detection, handles image rasterization + scaling
- `src/utils/matching.js` — wraps WASM ratio test + RANSAC
- `src/composables/useMatches.js` — orchestrates the matching pipeline
- `src/composables/useImages.js` — calls detection, stores results
- `crates/sift/src/lib.rs` — SIFT DoG detector
- `crates/matching/src/lib.rs` — descriptor matching + RANSAC

---

## Proposed Architecture

### Backend abstraction

Introduce a thin interface that both the current WASM approach and the ONNX approach conform to:

```js
// src/utils/detectors/interface.js (conceptual, not a real file needed)
// A detector returns:
{
  keypoints: Float32Array,  // [x, y, scale, response, angle] per point
  descriptors: Float32Array // [N × D] row-major, D=128 for SIFT, D=256 for SuperPoint
}

// A matcher takes two sets of keypoints+descriptors and returns:
{
  matches: [[ia, ib], ...]  // matched index pairs (pre-RANSAC)
}
```

### New files to create

```
src/utils/detectors/
  sift.js          ← move existing src/utils/sift.js here
  superpoint.js    ← new: ONNX SuperPoint

src/utils/matchers/
  ratiotest.js     ← move existing matching.js descriptor-match part here
  lightglue.js     ← new: ONNX LightGlue

src/utils/ort.js   ← new: shared onnxruntime-web session factory
```

`useMatches.js` and `useImages.js` select the appropriate module based on user settings.

### Settings store addition

```js
// In whatever settings composable/store you have:
detectorBackend: 'sift' | 'superpoint'   // default: 'sift'
matcherBackend: 'ratiotest' | 'lightglue' // default: 'ratiotest'
// Note: superpoint requires lightglue; sift can use either matcher
```

---

## Implementation Phases

### Phase 1 — `onnxruntime-web` setup (~2 hours)

1. `npm install onnxruntime-web`
2. Configure Vite — onnxruntime ships its own WASM files that Vite needs to serve correctly:
   ```js
   // vite.config.js addition
   import { viteStaticCopy } from 'vite-plugin-static-copy'
   // copy ort-wasm*.wasm files from node_modules/onnxruntime-web/dist to public/
   ```
   Or use the CDN path option: `env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/'`
3. Write `src/utils/ort.js`:
   - Initialize with WebGPU → WebGL → WASM fallback
   - Export a `createSession(modelUrl)` factory that caches sessions by URL
4. Write a small smoke test (load a tiny ONNX model, run inference)

### Phase 2 — Model caching in OPFS (~1-2 hours)

Models are 5–30 MB and should only download once. OPFS is already used in the project for image/descriptor persistence.

```js
// src/utils/modelCache.js
async function getModel(url, filename) {
  // 1. Check OPFS for cached file
  // 2. If missing: fetch + write to OPFS
  // 3. Return blob URL for ort.createSession()
}
```

Expose download progress so the UI can show a first-run progress bar.

### Phase 3 — SuperPoint detector (~4-6 hours)

File: `src/utils/detectors/superpoint.js`

**Model input:**
- Tensor shape: `[1, 1, H, W]` float32, pixel values normalized to [0, 1]
- Image must be grayscale
- Resize to a fixed size or keep original (check the specific ONNX export's constraints)

**Model output (from `Kololu2/lightglue-onnx`):**
- `keypoints`: `[1, N, 2]` — (x, y) in pixel coords
- `scores`: `[1, N]`
- `descriptors`: `[1, N, 256]`

**Steps:**
1. Convert image to grayscale float tensor (can reuse the canvas rasterization from current `sift.js`)
2. Run SuperPoint session
3. Apply score threshold (e.g. keep top 2048 keypoints by score)
4. Return in the same format as `sift.js` but with 256-dim descriptors

**Breaking change:** OPFS-stored descriptors are 128-dim for SIFT, 256-dim for SuperPoint. Add a `descriptorDim` field to the stored image metadata so the app knows which format each image uses. Prevent cross-backend matching (SIFT descriptors can't be matched against SuperPoint descriptors).

### Phase 4 — LightGlue matcher (~4-6 hours)

File: `src/utils/matchers/lightglue.js`

LightGlue **replaces the ratio test entirely** — it takes keypoints + descriptors from both images and directly outputs match pairs. It uses a transformer to reason about geometry and appearance jointly.

**Model input (LightGlue-SuperPoint ONNX):**
- `kpts0`: `[1, N, 2]` — keypoints image A, normalized to [-1, 1] by image size
- `kpts1`: `[1, M, 2]` — keypoints image B
- `desc0`: `[1, N, 256]` — SuperPoint descriptors A
- `desc1`: `[1, M, 256]` — SuperPoint descriptors B

**Model output:**
- `matches0`: `[1, N]` — for each kpt in A, index of match in B (or -1 if unmatched)
- `mscores0`: `[1, N]` — match confidence scores

**Steps:**
1. Normalize keypoint coordinates by image dimensions
2. Run LightGlue session
3. Parse `matches0` → convert to `[[ia, ib], ...]` pairs (filter `-1` entries)
4. Optionally filter by `mscores0` threshold

Keep calling `verify_matches()` (Rust RANSAC) afterward — still needed for the fundamental matrix used in reconstruction.

**Note for SIFT + LightGlue:** There is also a LightGlue-SIFT ONNX model in the same HuggingFace repo. Input descriptors are 128-dim in that case. This backend combination lets you improve matching quality without changing the detector.

### Phase 5 — UI integration (~2-3 hours)

- Add backend selector to Settings modal (or a dedicated "Pipeline" section in the Ribbon)
- Show model download progress on first use (progress bar, size indicator)
- Disable cross-backend matching in `useMatches.js` with a clear error message
- Consider a "Re-detect with current backend" action per image for when the user switches backends

---

## Key Decisions to Make Later

1. **LightGlue-SIFT as an intermediate option?** Easy win — keeps the Rust WASM detector, only adds the matcher model download. Good stepping stone before full SuperPoint.
2. **Max keypoints cap** — SuperPoint + LightGlue is slower per pair than SIFT + ratio test. May need a configurable cap (default 1024 or 2048) to keep matching times reasonable in the browser.
3. **ONNX model version pinning** — HuggingFace model files can be updated. Pin to a specific commit hash in the download URL.
4. **Vite WASM conflict** — both the Rust WASM modules and onnxruntime-web ship `.wasm` files. Make sure Vite's WASM handling config doesn't apply to onnxruntime's files (they self-load via their own fetch).

---

## Resources

- ONNX models: `https://huggingface.co/Kololu2/lightglue-onnx`
- LightGlue paper / repo: `https://github.com/cvg/LightGlue`
- SuperPoint paper: MagicLeap 2018, weights widely available
- `onnxruntime-web` docs: `https://onnxruntime.ai/docs/tutorials/web/`
- Vite static copy plugin (for WASM assets): `vite-plugin-static-copy`
