# Restructuring plan (executable)

Goal: reorganise `src/` so files sit in meaningful folders, break up the god
files (`App.vue` 1641 ln, `core/sfm.js` 1417 ln, `Sidebar.vue` 1118 ln,
`compute.worker.js` 694 ln), and resolve the `core/` vs `utils/` blur —
**without changing any behaviour**. Every phase is mechanical-plus-small-splits;
no algorithm changes anywhere in this plan.

## Ground rules for the executor

- **One phase = one commit.** Use `git mv` for every move so history follows.
- **Commit the current working tree first** (or have the user do it) — there are
  many uncommitted changes; never mix restructuring into that diff.
- After every phase: `npm test` && `npm run typecheck` && `npm run build`
  (build catches broken dynamic imports / globs that vitest doesn't).
- Tests are colocated (`x.test.js` next to `x.js`) — always move them together.
- No public-API changes: exported function names and signatures stay identical;
  only file paths change. Splits extract code verbatim (keep comments, keep the
  heavy `onLog` instrumentation).
- No path alias exists (`vite.config.js` has no `resolve.alias`); update
  relative imports directly. Do **not** introduce an `@/` alias in this pass —
  that's a separate decision, and mixing it in doubles the diff.
- `import.meta.glob` in `core/glossary.js` / `core/guide.js` uses absolute
  `/src/help/**` / `/src/guide/**` paths — unaffected by moving core files, but
  re-check after Phase 1 moves those two files.
- CLAUDE.md's layering diagram and "Where things live" section must be updated
  in the same commit as each phase that changes paths.

---

## Phase 1 — subfolder `src/core/` (pure moves, no code edits)

`core/` has ~28 modules covering five unrelated concerns. Group by pipeline
stage; the "pure compute, no Vue/Pinia/OPFS/DOM" rule applies to the whole tree
unchanged. Each `*.test.js` moves with its module. `types.ts` stays at
`core/types.ts`.

| New folder | Files (from `core/`) |
|---|---|
| `core/features/` | `matching.js` (split/renamed in Phase 2), `superpoint.js`, `lightglue.js`, `ort.js`, `preselect.js` |
| `core/sfm/` | `sfm.js`, `reconstruction.js`, `geometry.js`, `distortion.js` |
| `core/dense/` | `mvs.js`, `planeCost.js`, `memBudget.js` |
| `core/products/` | `dem.js`, `ortho.js`, `projection.js`, `georef.js`, `exporters.js`, `geotiff.js`, `colormap.js` |
| `core/io/` | `gcp.js`, `pose.js`, `sensor.js`, `geojson.js`, `metadata.js` |
| `core/help/` | `glossary.js`, `guide.js`, `commands.js` |
| stay at `core/` root | `crs.js`, `footprint.js`, `mask.js`, `types.ts` |

Rationale for the stragglers: `crs.js` is cross-cutting (7 importers),
`footprint.js` is pose-derived map geometry that fits neither io nor products
cleanly, `mask.js` is shared by worker + two UI surfaces. Leaving them flat is
fine; don't force them.

Then fix imports. Importers live in `stores/`, `workers/`, `components/`,
`composables/`, `utils/`, and within `core/` itself. Find them with:

```
grep -rn "core/\(matching\|superpoint\|lightglue\|ort\|preselect\|sfm\|reconstruction\|geometry\|distortion\|mvs\|planeCost\|memBudget\|dem\|ortho\|projection\|georef\|exporters\|geotiff\|colormap\|gcp\|pose\|sensor\|geojson\|metadata\|glossary\|guide\|commands\)\(\.js\)\?['\"]" src
```

Also check `src/core/types.ts` and any JSDoc `@typedef import(...)` path strings
— `npm run typecheck` catches these.

## Phase 2 — dissolve the `utils/` grab-bag

`utils/` mixes pure compute (belongs in `core/`) with DOM/browser helpers
(stays). Apply the rule from CLAUDE.md: pure → `core/`, browser/DOM → `utils/`.

First, fix the misleading generic names in `core/features/` so the classic and
learned paths are symmetric. `matching.js` is not an orchestrator (that's
`matchAll` in `useMatchesStore`); it bundles one classic-specific function with
two shared ones. Split it:
- `core/features/bruteforce.js` — `matchDescriptors` (brute-force NN + Lowe
  ratio, wasm). The classic counterpart of `lightglue.js`; keep the wasm
  `ensureWasm` lazy-init here.
- `core/features/verify.js` — `verifyMatches` (F-RANSAC) + `inlierSpread`.
  Shared by BOTH pipelines (LightGlue output flows through these too — see the
  `lightglue.js` header). Needs its own `ensureWasm` for `verify_matches_hf`
  (same `init` from `wasm/matching`; calling init twice is safe — it's a cached
  promise inside the wasm-bindgen glue, but keep each file's local
  `initPromise` pattern for consistency).
- Delete `core/features/matching.js` after the split; update every importer
  (`useMatchesStore`, `compute.worker.js`, tests). Split `matching.test.js`
  along the same line.

Naming result: detectors `sift.js` / `superpoint.js`, matchers
`bruteforce.js` / `lightglue.js`, shared gate `verify.js`.

Moves:
- `utils/detection.js` → `core/features/sift.js` — it's the SIFT wasm wrapper
  (twin of `superpoint.js`); it was always core-shaped, and `detection.js` says
  nothing. Note `compute.worker.js` also calls `detect_sift` directly (line
  ~121) — while touching this, check whether that's a duplicate of the wrapper
  and if so route it through `core/features/sift.js` instead (behaviour must
  stay identical, including the two-trailing-sentinels parse).
- `utils/camera.js` → `core/io/cameraKind.js` — pure sensor-vs-pose classifier
  built on `core/io/gcp.js` parsing. Rename because `camera.js` says nothing.
- `utils/importKind.js` → `core/io/importKind.js` — pure dropped-file
  classifier, same family.
- `utils/cameraEstimated.js` → `core/sfm/cameraEstimated.js` — pure extraction
  of BA'd camera params.

Stays in `utils/` (browser/DOM by nature): `opfs.js`, `download.js`,
`image.js` (object URLs), `icons.js`, `resizableColumns.js`, `exportCsv.js`
(check: if it's a pure encoder, move to `core/products/`; if it triggers
downloads, it stays).

## Phase 3 — split `core/sfm/sfm.js` (1417 ln, `reconstruct()` alone is ~1100)

Extract along the existing `// ──` section boundaries. All extractions are
**verbatim function lifts** — the new modules take explicit params (no shared
module state) and `onLog`/`onProgress` keep threading through as arguments.

- `core/sfm/rotations.js` — the 3×3 helpers: `matMul3`, `matT3`, `rotAngleDeg`,
  `eigSym3`, `essentialSingularValues`, `I3` (lines ~26–120 today).
- `core/sfm/cycleFilter.js` — `rotationCycleFilter` (already pure + exported).
- `core/sfm/tracks.js` — `buildViewIndex`, `reprojErr`, `retriangulatePairs`,
  `mergeSplitTracks` (already pure + exported).
- `core/sfm/initPair.js` — extract the "Select initial pair" block (~line 576+)
  from inside `reconstruct()` into an exported `selectInitPair({...}, hooks)`
  returning exactly what the orchestrator consumed. This is the only extraction
  that cuts *inside* `reconstruct()` — do it carefully: identify every variable
  the block reads/writes, pass/return them explicitly.
- `sfm.js` keeps `reconstruct()` (orchestrator) + small local helpers
  (`projDepth`, `numStats`, `fmtStats`, `toNorm`, `camToP34flat`), importing the
  rest. Re-export `rotationCycleFilter`, `retriangulatePairs`,
  `mergeSplitTracks` from `sfm.js` so `sfm.test.js` and any other importer keep
  working unchanged; split `sfm.test.js` per-module only if it's trivial.

Stop there. Do NOT try to break the incremental-registration main loop into
pieces in this pass — it's stateful and instrumented; splitting it risks subtle
behaviour drift for little gain. If desired later, file it separately.

## Phase 4 — decompose `App.vue` (1641 ln)

App.vue should end as layout + store wiring + the command dispatch. Extract the
self-contained concerns into composables (each already delimited by a `// ──`
section header):

- `composables/useTabDrag.js` — tab drag-reorder + tab context menu
  (`onTabDragStart/Over/Drop/End`, `onTabRightClick`, `closeTabCtx`).
- `composables/useSidebarResize.js` — sidebar width + resize handlers +
  localStorage persistence.
- `composables/useImportRouting.js` — the whole dropped/picked-file import
  funnel: `openImportFile`, `openDroppedImport`, `routeImport`,
  `onImportKindChosen`, `onImportSwitchKind`, `openCameraImport`,
  `onCameraImport`, `onGcpImport`, `onFootprintImport`, pickers. It talks to
  stores + modals store; pass those in (or import stores directly inside the
  composable — match the style of `composables/usePipeline.js`).
- `composables/useModalEscape.js` — the Escape-closes-topmost-modal stack
  (`closeTopModal` + key handler). Alternatively fold into `useModalsStore`;
  pick whichever needs fewer cross-references.
- Project lifecycle (`onMounted` bootstrap, `openProject`,
  `handleCreateProject`, `handleSetCrs`) can stay in App.vue — CLAUDE.md
  documents App.vue as the driver of the sensors-before-images restore order;
  keep that logic visible where the doc says it lives.

Target: App.vue under ~800 lines. Verify by running the app in a browser
(imports, drag-drop, tab reorder, Escape) — this phase is browser-runtime and
vitest won't cover it; say so in the commit message if not manually verified.

## Phase 5 — split `Sidebar.vue` (1118 ln)

One child component per collapsible section, under
`components/layout/sidebar/`: `ImagesSection.vue`, `SensorsSection.vue`,
`MatchesSection.vue`, `GcpsSection.vue`, `CloudsSection.vue` (point clouds +
context menu), `ProductsSection.vue`. `Sidebar.vue` keeps the section
open/closed state, the drop-zone handling, and emits — pass data down as props,
bubble actions up as emits (don't have leaf sections import App-level handlers).
The three context menus (cloud/image/sensor) share a pattern — extract a tiny
`useContextMenu.js` composable if it falls out naturally; don't force it.

Also browser-runtime verification only.

## Phase 6 — split `workers/compute.worker.js` (694 ln)

Move each op handler into `workers/ops/<domain>.js` (`detect.js`, `match.js`,
`sfm.js`, `dense.js`, `products.js`), each exporting `{ opName: handler }`;
`compute.worker.js` keeps the message loop, pixel decoding helpers
(OffscreenCanvas), the memory ledger, and merges the registries. Keep the
`transfer` lists next to each handler. Careful: the worker is where the GPU
backend swap (`settings.useGpu`) and the GPU↔CPU A/B validation live — keep
that logic intact inside the dense op module.

## Explicitly out of scope (do not do in this pass)

- **No `@/` path alias**, no barrel/`index.js` files — barrels hide the
  dependency graph and hurt tree-shaking for the wasm-adjacent modules.
- **No renames beyond those listed in Phase 2**; renaming while moving doubles
  review difficulty.
- **No splitting of `useReconstructionStore` (715 ln)** — it's big but coherent
  (one store, one domain). Revisit only if it grows past ~1000.
- **No new wasm ports** — see assessment below.

## Assessment: "should more code move into wasm for speed?"

**No — not now.** The hot inner loops are already off JS: SIFT (`crates/sift`),
descriptor matching + F-RANSAC (`crates/matching`), P3P/MSAC/GN pose, LM bundle
adjustment, PatchMatch depth + fusion (`crates/reconstruction`), plus the WebGPU
PatchMatch path. What remains in JS is orchestration (`sfm.js`, `mvs.js` —
per-image/per-pair loops around wasm calls, negligible), marshalling
(`reconstruction.js`), and one-shot product rasters (`dem.js`, `ortho.js`).

Porting more has real costs here: every `crates/` change requires
`npm run build:wasm` + committing `src/wasm/*` in lockstep (CLAUDE.md), the
JS↔wasm boundary copies typed arrays (marshalling can eat the win for
call-per-pair shapes), and wasm code is harder to instrument with the
per-decision `onLog` audit trail this project treats as a feature.

If dense/products ever feel slow, **profile first** (DevTools performance tab on
the worker); the plausible candidates, in order of likely payoff:
1. `core/products/dem.js` binning + IDW fill (per-pixel over full DEM raster),
2. `core/products/ortho.js` reprojection warp,
3. `retriangulatePairs` / `mergeSplitTracks` loops in `core/sfm/tracks.js`.
Only port one after a measurement shows it dominating a run, and record the
before/after in HANDOVER.md. Note `core/planeCost.js` must stay in JS regardless
— it's the CPU reference for the three-kernel lockstep rule.

## Loose end to flag to the user (decision, not part of this plan)

`public/models/*.onnx` is 49 MB and currently untracked. Committing it bloats
the repo permanently. Options: `.gitignore` + a `scripts/fetch-models` download
step (README note), or Git LFS. Ask the user before Phase 1's "commit current
tree" step.

## Wrap-up

After the last phase: update CLAUDE.md's layering diagram, "Stores", and "Where
things live" sections to the new paths; add one done-log line to HANDOVER.md;
delete the RESTRUCT entry from TODO.md and delete this file.
