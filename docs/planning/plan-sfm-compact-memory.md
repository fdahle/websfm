# SfM worker: compact keypoints and tracks (TODO ▸ MEM)

Status: **not started — for review** (written 2026-10-08). `TODO.md` ▸ MEM is the source
of truth for whether/when; this file is the *how*. It covers MEM items 1–3 and folds in
the RV structure items that touch the same code (`core/sfm/ingest.js`, one shared
`buildBaObservations`), because doing them first shrinks every later diff.

## Why

The Monster run (538 images, 4.5 M keypoints, 7.7 M matches, 705 k points) passed the
sparse preflight at 3.42 of 3.52 GB, then its SfM worker died silently in guided track
extension (HANDOVER ▸ B-bench ▸ Monster). A page cannot raise the ~4 GB per-isolate
heap ceiling, so the only fix is to need less. The worker's data model is the reason it
needs so much: every keypoint and every track observation is a JS object or Map entry.

## Where the memory goes today

Mapped 2026-10-08 (file:line refs are against `d80d9a5`).

**Keypoints.**
- **Shape.** Each keypoint is `{ x, y, color:[r,g,b] }`, built per keypoint at
  `useReconstructionStore.js:1762`. `memBudget.js` charges 104 B each.
- **The worker holds several copies:**
  1. The postMessage clone, kept pristine for seed retries and secondary models.
  2. The working clone (`cloneSfmInput`, `sfm.js:1766`).
  3. For every self-calibrated image, a snapshot taken before the first fold
     (`pristineKpByUuid`, `sfm.js:1035`). The preflight does not model this one.
- **Edits replace, never patch.** Ingest undistortion, film remap and every self-cal fold
  allocate a fresh array of fresh objects (`sfm.js:397`, `:503`, `:1042`), so each fold
  briefly doubles the working copy as well.

**Tracks.**
- **Points.** Each point is `{ x, y, z, views: Map<imageUuid, kpIdx> }`.
- **Reverse index.** A nested reverse index `viewIndex: Map<uuid, Map<kpIdx, point>>`
  (`sfm.js:650`) is rebuilt from scratch at seven call sites. `tracks.js` builds private
  copies of it.
- **What the budget charges.** `memBudget.js` lumps tracks with BA scratch at
  260 B per observation + 68 B per keypoint.

**Bundle-adjustment observations.**
- **Per-call objects.** Each BA call builds one `{camIdx, ptIdx, x, y}` object per
  observation (`sfm.js:805`, `:1140`, `:1215`). `reconstruction.js:338` then flattens them
  with a temporary array each.
- **A linear lookup per observation.** Each observation's image is found by
  `imageByUuid`, a linear `images.find` (`sfm.js:188`). The same lookup runs once per
  candidate keypoint in guided extension (`sfm.js:1463`).

**Matches.** These are packed `Uint32Array`s already, but the `Uint32PairList` iterator
yields a fresh `[a, b]` array per element (`matchCodec.js:14`). `filter`/`map`
materialise arrays at `register.js:425` and `tracks.js:64`.

**Estimated worker peak for Monster.** From the `memBudget.js` constants, not a
measurement; the ×1.25 margin is applied to every row. It includes the self-cal
snapshot the preflight does not count, which is why it exceeds the 3.42 GB the
preflight projected.

| item | today | after Phase 1–2 |
| --- | --- | --- |
| keypoints (2 copies + self-cal snapshot) | 1.75 GB | 0.21 GB |
| tracks + BA observation records | 1.61 GB | 0.25 GB |
| matches (2 copies) | 0.15 GB | 0.15 GB |
| uint8 descriptors (guided extension) | 0.72 GB | 0.72 GB |
| **total** | **~4.2 GB** | **~1.3 GB** |

Descriptors become the largest item afterwards, which is what Phase 5 is for.

## Ground rules

1. **Bit-identical output is the acceptance gate for Phases 0–3.** These phases change
   representation, not maths. Same input must give the same cameras, points and track
   lists, in the same order, down to the float.
   - **Map order must survive.** Map iteration order is insertion order, and observation
     order sets BA summation order, so every replacement structure must preserve it.
   - **First, prove the gate is achievable.** Run one bench variant twice on the current
     build and confirm the two runs are identical. If they are not, find the
     nondeterminism (an unseeded RNG, a `Date.now()` seed) before anything else.
2. **Keep core pure.** No Vue, no DOM. The new structures live in `core/sfm/` and are
   plain typed arrays plus functions.
3. **One phase per commit series, each shippable.** Never leave `main` with half an API.
4. **Measure, don't model.** Phase 0 adds a measured worker peak; Phase 4 recalibrates
   `memBudget.js` from it.

## Phase 0 — groundwork (hours; no representation change)

- **0.1 Measured worker heap in the bench.** `tests/bench` already drives Chrome via
  Playwright. Attach to the worker target over CDP and sample `Runtime.getHeapUsage`
  at each stage boundary (`markStage` already names them; post a tiny `ev` per stage).
  Run Monster once with `--js-flags=--max-old-space-size=8192` (bench only) so it
  completes, and record the real per-stage peak in HANDOVER ▸ Baselines. **This is
  the before-number for the whole plan.**
- **0.2 `imageByUuid` → Map.** Build `Map(uuid → image)` once per run; refresh it
  wherever `img.keypoints` is replaced (it is the image object that is looked up, so
  only image-list changes matter). O(1) instead of O(images) per observation; should
  be a measurable SfM speed-up on 500+ images by itself.
- **0.3 Shared `buildBaObservations(points3d, camIdxOf, keypointsOf)`** (RV structure
  item). One function for the three BA sites (`sfm.js:799`, `:1140`, `:1215`),
  returning flat `Float32Array` obs/weights directly; let `bundleAdjust` accept them
  pre-flattened (skip its per-observation `[...]` temporaries). Removes the duplicated
  loops before Phase 2 has to change them.
- **0.4 Extract `core/sfm/ingest.js`** (RV structure item; `sfm.js` ~304–508: film
  remap, Brown undistortion, GCP mark moves). Pure move + tests; Phase 1 then changes
  one small module instead of the middle of `sfm.js`.
- **0.5 Secondary jobs clone only their images.** `sfm.js:1944` clones the whole input,
  then overrides images/pairs. Clone the job's subset directly.

Acceptance: all tests green, bench SB/building/TMA cameras/points identical to before.

## Phase 1 — keypoints as typed arrays (1–2 days)

New module `core/sfm/keypointSet.js`:

```js
// One image's keypoints: positions in native pixel-centre coordinates.
// { n, xy: Float64Array(2n), rgb: Uint8Array(3n) | null, hasColor: Uint8Array(n) | null }
export function keypointSetFrom(objects)     // tests + legacy callers
export function kpX(set, k), kpY(set, k)     // hot-path accessors (inlined by V8)
export function mapPositions(set, fn)        // ingest / fold: NEW xy array, shared rgb
```

- **Float64, not Float32.** The current JS objects hold doubles; Float64 keeps
  Phase 1 bit-identical. Float32 would save another 8 B/kp but changes every fold by
  ~1e-3 px, which breaks the gate for no visible gain at this stage.
- **Store → worker.** Build the set from `img.keypoints` (`useReconstructionStore.js:1762`)
  and **transfer** its buffers instead of cloning objects. That also drops the
  renderer's 104 B/kp input copy.
- **Immutability is kept.** `mapPositions` returns a new `xy` and shares `rgb`, exactly
  like today's `{...kp, x, y}`. So the pristine copy for retries stays valid by
  construction: keep the original set, never write into it.
- **The self-cal snapshot** becomes a reference to the pre-fold `xy` array (zero cost),
  since folds never write in place.
- **Readers.** Every `img.keypoints[k].x` site listed in the 2026-10-08 map moves to
  `kpX(img.kp, k)`:
  - `sfm.js`: ~20 sites
  - `tracks.js`, `register.js`, `initPair.js`, `guidedExtension.js`, `selfCalCompose.js`
  - `fundamental.js`: `fitFundamental` / `sampsonRmsPx` take arrays of points; give them
    a strided variant.
- **Tests.** Fixtures keep writing `keypoints: [{x, y}]`; the test helpers wrap them
  with `keypointSetFrom`. Expect churn in about 13 `sfm.test.js` literals plus
  `guidedExtension.test.js`, `register.test.js` and `initPair.test.js`.

Acceptance: bit-identical bench output; worker peak (0.1) drops by ~1.5 GB on Monster.

## Phase 2 — tracks as an observation arena (2–3 days)

Two steps, so the risky one is isolated:

**2a. Introduce a `TrackStore` API, backed by today's Maps.** A pure refactor that
moves every consumer onto the API.

```js
// core/sfm/trackStore.js
addPoint(x, y, z, [[img, kp], …]) → p
addView(p, img, kp)
removeView(p, img)
forEachView(p, (img, kp) => …)   // insertion order
viewCount(p)
pointAt(img, kp) → p | -1        // replaces viewIndex
position(p) / setPosition(p, x, y, z)
liveCount()
compact()
```

- **Image identity becomes a dense int** (`imgIdx`, assigned at ingest). It is mapped
  back to uuids only in `done()` / `compactPointRecords`. This removes the string-keyed
  Maps everywhere.
- **Consumers to move,** each either mutating or read-only:
  - `sfm.js`: `filterTracks`, `modelResiduals`, `trackHist`, the BA builders,
    `pointColor`, the per-camera table
  - `tracks.js` (all four functions)
  - `register.js`: correspondence collection, track extension, triangulation
  - `guidedExtension.js`, `initPair.js`
  - `resultCodec.compactPointRecords`

**2b. Swap the implementation to typed arrays.** The API stays fixed.

- **Positions.** Float64 `pos` (3/point), grown by doubling.
- **Observation pool.** `obsImg` Int32, `obsKp` Int32, `obsNext` Int32 (a singly
  linked list per point, appended at a `tail` so insertion order is preserved), plus
  `head`, `tail` and `count` per point, and a free list for removed observations.
- **Reverse index.** `trackOf[imgIdx]`: one Int32Array(n) per image, −1 for none. It
  replaces `viewIndex` and all seven rebuilds, because it is maintained incrementally.
- **Merging.** `mergeSplitTracks`' transient `_dead` flag becomes a tombstone bit;
  `compact()` renumbers.
- **Cost.** About 12 B per observation + 4 B per keypoint + 24 B per point, against
  hundreds of bytes per observation today.

Acceptance:
- 2a: bit-identical, zero memory change expected.
- 2b: bit-identical; worker peak drops by another ~1.3 GB on Monster; SfM wall time no
  worse on SB.
- Unit tests pin insertion order through add/remove/merge cycles, and the free list
  under churn.

## Phase 3 — matches without per-pair arrays (hours)

Replace `for (const [a, b] of pair.matches)` with indexed loops over the packed
`Uint32Array` (`matches.a(i)`, `matches.b(i)`), and `filter` / `map` with index lists.
Small, mechanical, and removes the remaining per-match garbage.

## Phase 4 — preflight that measures and degrades (hours; was MEM-1)

- **Recalibrate `memBudget.js`** from the measured peaks (0.1, after Phases 1–3):
  - new per-keypoint and per-observation constants;
  - add guided extension's own term (grid + proposals);
  - drop the pristine-snapshot term if Phase 1 made it free.
- **Degrade instead of dying.** When the projection exceeds the budget, switch guided
  extension off (or run it in batches; see Phase 5) and log the reason with the
  numbers. A run that would die must instead finish with a warning in the verdict.

## Phase 5 — guided extension in image batches (optional; was MEM-3)

Today guided extension needs every registered image's descriptors resident at once:
0.58 GB on Monster (0.72 GB with the margin), the largest item left after Phase 2. Process cameras in spatial
batches. Load and release `descU8` per batch from the store (or keep them on the main
thread and request per batch), so the worker holds one batch of descriptors at a time.
Only worth doing if Phase 4's measurements still show guided extension near the limit.

## Out of scope

- Main-thread keypoint storage (`useImagesStore` objects with `nx, ny, scale,
  response`). This is a separate store rework; Phase 1 only stops the renderer making
  a third copy for the worker input.
- Splitting very large blocks into sub-models (MEM item 4) and Memory64 (item 5).

## Decisions for review

1. **Bit-identical as the gate for Phases 0–3?** Recommended. It is the only way to
   refactor the SfM core this deeply without re-running every accuracy benchmark after
   each step. The cost: Float64 keypoints, and preserving insertion order everywhere.
2. **Float64 keypoints (16 B) over Float32 (8 B)?** Recommended for now; a Float32
   switch can come later as its own measured change.
3. **Phase 0 refactors first?** Recommended. They are low-risk, mostly mechanical, and
   make Phase 1–2 diffs reviewable.
4. **2a before 2b?** Recommended. It separates the API migration (wide, safe) from the
   data-structure swap (narrow, risky).

## Verification owed

- Bench (headless, `SFM-*` rows):
  - SB, building and TMA: bit-identical after each phase.
  - Monster: completes at defaults after Phase 2 (or Phase 4 at the latest).
  - Record worker peak per stage before and after.
- Browser (`VERIFICATION.csv`): one large SIFT project reconstructs with the tab's
  memory watched (`SFM-20` already covers the preflight side).
