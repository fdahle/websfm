# Plan: Evaluate tab → Quality Report hub (restructure + content fixes + additions)

Executor plan. Read CLAUDE.md first (layering rules, "pure core", the Evaluate-tab
rule *derive from the cloud, don't extend the summary*, verification policy).
Everything UI-side needs a manual browser run this environment may not support —
say so explicitly in the report rather than claiming verification; the pure
`core/eval/*` additions are covered by `npm test` + `npm run typecheck`.

## Context — what exists and what's wrong

Shipped (PLAN-eval-views): 8 ribbon buttons in 4 groups
([Ribbon.vue:152-187](src/components/layout/Ribbon.vue#L152-L187)), each opening
one isolated modal (`ReconReportModal`, `ImageErrorsModal`, `CalibrationModal`,
`GcpAccuracyModal`, `PoseResidualsModal`, `MatchGraphHealthModal`,
`DepthCoverageModal`, `DemGcpCheckModal`), backed by pure `core/eval/*`
(`reconStats`, `imageStats`, `calibration`, `matchGraph`, `demCheck`) + store
reports (`gcpAccuracyReport`, `poseResidualReport`). Shared UI:
`ui/StatTiles.vue`, `ui/DataTable.vue`.

Problems (agreed with Felix 2026-07-17):

1. **No overview.** Nothing answers "is my project healthy, where is it bad?" —
   the user must open 8 modals to find out. This is the main "confusing" driver.
2. **Grouping is by internal stage, not user question**, and out of workflow
   order (Matching group sits after Georeferencing).
3. **Isolated modals block the workspace** — read-heavy views the user wants to
   cross-reference (worst image → look at the image).
4. **Content inconsistencies**: Recon Report shows a *different tile set*
   depending on run-summary presence; warn thresholds are hardcoded ad-hoc
   (1 px, 1 m, 5 % focal, `FIT_RMS_WARN 0.05`) with no rationale surfaced;
   Depth Coverage mixes per-map coverage with the fusion cull breakdown and its
   GSD is a depth-midpoint approximation; Graph Health reports component *count*
   but not membership or bridge edges; Image Errors can't say *why* an image is
   unregistered.

Decisions (Felix): **one Quality Hub modal** (overview landing page +
section tabs, ribbon shrinks); **fix content and UI together**; all four
additions wanted: **residual overlay in image view, overlap/coverage map, run
comparison, exportable report** (the last is TODO F8).

## Design rules that must hold throughout

- The eval tab rule stays: **derive from the cloud** (`views`/`viewsPx` +
  cameras), so every view also works on an imported COLMAP cloud. Run-summary
  numbers are *extras*, always labelled, never the only path.
- Everything computational is a pure `core/eval/*` function with a test; hub
  components only marshal reactive state to plain data and render.
- A section whose prerequisite data is missing renders an **informative empty
  state** ("Run matching first", "Build a DEM first") instead of disappearing —
  the overview lists it greyed. That replaces the per-button `needsSparse`/
  `needsGcps`/… gating as the discoverability mechanism.
- All warn/bad thresholds live in **one exported table** with a rationale
  comment each (`core/eval/health.js` `EVAL_THRESHOLDS`) and every tile that
  colours by tone shows its threshold in the hint ("warn > 1.0 px"). No more
  scattered magic numbers.

## WS0 — Hub shell (the structural win; ship first)

New `components/modals/QualityReportModal.vue`: one wide `ModalShell` with a
left section nav (or top tabs — match `GlossaryModal`'s pattern) and sections:

```
Overview | Matching | Sparse | Calibration | Accuracy | Dense | Coverage*
```
(*Coverage arrives in WS4; Accuracy = GCP Accuracy + Pose Residuals + DEM vs
GCPs stacked/sub-tabbed — they answer one question, "how accurate is the
georeferenced result".)

- Extract each existing modal's **body** into a section component under
  `components/modals/eval/` (e.g. `EvalSparseSection.vue` = Recon Report +
  Image Errors merged, `EvalAccuracySection.vue`, …). Keep
  `<style scoped src="./ui/modal.css">` per component (the slotted-content CSS
  gotcha in CLAUDE.md applies to sections too). Delete the 8 old modal wrappers
  when the hub renders everything they did.
- `useModalsStore`: replace the 8 `eval*Open` refs with `qualityOpen` +
  `qualitySection` (string). App.vue dispatch: `eval-overview` (new) opens the
  hub on Overview; keep the old command ids mapping to hub sections so muscle
  memory / logs stay valid.
- Ribbon Evaluate tab shrinks to one group, ~4 buttons deep-linking into the
  hub: **Quality Report** (overview), **Matching**, **Sparse**, **Accuracy**,
  **Dense** — or fewer if it still feels busy; the hub nav makes extra buttons
  redundant. Order = workflow order.
- Cross-navigation stays: Image Errors row → open image tab (close hub);
  Graph Health → Match List. Row-click behaviours move into the sections
  unchanged (`emit('open', …)` funnels through the hub to App.vue).

## WS1 — Overview page (with WS0)

New pure `core/eval/health.js`:

- `EVAL_THRESHOLDS` — the single threshold table (reproj median warn/bad px,
  GCP RMSE, DEM ΔZ, coverage %, fit RMS, focal Δ%, …), each with a one-line
  rationale comment.
- `projectHealth(snapshot) → rows` where `snapshot` is plain data the store
  assembles (match pair list, cameras size / image count, derived reproj stats,
  graph health, gcp report, pose report, dem check, depth meta, dense summary;
  each nullable) and each row is
  `{ id, section, label, value, unit, status: 'ok'|'warn'|'bad'|'missing', hint }`.
  Rows: registered %, reproj median, ≥3-view track %, graph components +
  isolated, self-cal fit RMS, GCP RMSE, pose RMSE, DEM ΔZ RMSE, depth-map
  coverage %. `missing` rows render greyed with the prerequisite as hint.
- Overview renders the rows as a status list (dot + label + value + hint),
  click → jump to section. `gcpAccuracyReport` is async — compute lazily on
  open with a loading state, cache per open, invalidate on refit (the GCP
  toggle already refits; have it bump a `healthDirty` flag).

## WS2 — Per-view content fixes (piecemeal, each independently shippable)

1. **Sparse section**: one consistent tile set, always derived
   (registered, points, reproj median/P95/max, observations). Run-summary
   extras (pre-BA P95, post-BA median, run date) become a clearly-labelled
   secondary "Run summary" strip shown only when a summary exists. Kill the
   two-personality tiles.
2. **Image Errors table**: add per-image keypoint count and accepted-edge
   degree columns (join images store + `graphHealth.degrees`) so "why is this
   image bad" is answerable in one table. Unregistered list: annotate each
   image with the first derivable reason — no keypoints → "no features",
   degree 0 → "no accepted pairs", in a non-largest component → "disconnected
   (component N)". Pure helper in `core/eval/imageStats.js` + test.
3. **Graph Health**: extend `core/eval/matchGraph.js` with component
   *membership* (list images per component, expandable) and **bridge edges**
   (articulation edges via DFS low-link — a bridge pair failing would split the
   graph; surface as "fragile links" with inlier counts). Per-image row gets a
   component column. Test with a two-component + single-bridge fixture.
4. **Depth Coverage**: split into two labelled groups — "Per-map coverage"
   (table) and "Fusion cull breakdown" (tiles, only when `denseSummary`
   exists). Persist the per-map **median valid depth** in the depth-map index
   at Stage A (codec version bump in `core/dense/depthMapCodec.js`;
   back-compat: absent ⇒ current midpoint fallback, label "~") so GSD is real.
   Codec test for the new field + old-index fallback.
5. **Pose Residuals**: add RMSE XY vs RMSE Z tiles (horizontal/vertical split —
   the aerial-relevant decomposition).
6. **Thresholds**: sweep every hardcoded tone threshold in the sections into
   `EVAL_THRESHOLDS`; hints show the threshold. Unit labels come from the
   georef CRS as today.

## WS3 — Residual overlay in the image view

The classic spatial diagnostic: per-observation reprojection residual vectors
drawn on the image — a radial pattern = distortion misfit, a coherent
translation = bad pose, random = fine.

- Pure: extend `core/eval/imageStats.js` with
  `imageResidualVectors(cam, points, uuid) → [{ px, py, du, dv, mag }]`
  (observation pixel + residual vector, BA pinhole frame — same frame the
  keypoints/cameras are in, consistent with everything else). Test against a
  synthetic cam.
- UI: new global overlay toggle `showResiduals` in `useImageViewSettings`
  (global-not-per-tab pattern), drawn in `ViewerImage.vue` as amplified vectors
  (fixed ×25 amplification, magnitude-coloured, tiny legend "×25, red > 2 px").
  Only renders when the image is registered and a sparse cloud exists.
- Hook-up: Image Errors row click opens the image *and* enables the overlay
  (it's global, so setting it is legitimate).

## WS4 — Overlap / coverage map (new hub section)

Answers "where is my survey thin" — top-down 2D density map of the sparse frame.

- Pure `core/eval/coverage.js`: bin tie points into an XY grid (auto cell from
  bbox), per cell: point count + **max view count** (images seeing the cell);
  also return camera centres. Plain typed-array grid out; test on a synthetic
  strip.
- UI: canvas render in `EvalCoverageSection.vue` — cells coloured by image
  count (the photogrammetric quantity; 2 = minimum, ≥3 comfortable), camera
  centres as dots, GCPs as crosses when present. Uses the georef frame when one
  exists (axes in CRS units), else the SfM frame. Aerial-oriented via the
  existing local-vertical auto-orient (`core/products/projection.js`) so
  "top-down" is meaningful.
- Later (backlog, not this plan): dense-cloud variant.

## WS5 — Run comparison

"Did that settings tweak help?"

- `useReconstructionStore`: keep `summaryHistory` — the last ~5 run summaries
  (small JSON) in `reconstruction.json`; on each successful reconstruct, push
  the outgoing summary. Back-compat: absent ⇒ empty.
- Pure `core/eval/compareRuns.js`: `diffSummaries(cur, prev)` → per-metric
  `{ label, cur, prev, delta, better|worse|same }` for registered, points,
  ≥3-view %, post-BA median, pre-BA P95.
- UI: Overview gets a compact "vs previous run" strip (delta arrows); Sparse
  section a small comparison table with a run picker over the history.
- Note: history is summaries only (cheap); no cloud diffing.

## WS6 — Exportable report (= TODO F8)

- Pure `core/products/report.js`: assemble one **self-contained HTML** (inline
  CSS, inline SVG charts, project name + date) from the *same plain snapshot +
  pure fns the hub uses* — sections mirror the hub, so the two can't drift.
  No external assets. PDF = the user prints the HTML.
- Entry points: "Export report" button in the hub footer + an entry in
  `ExportModal` (`EXPORT_DEFAULTS` untouched — no knobs beyond filename).
- On ship: delete F8 from TODO.md, HANDOVER done-log line, CLAUDE.md products
  section gets one line.

## Sequencing

WS0+WS1 first (the structural win, one PR-sized chunk). WS2 items are
independent and small — fold 1/2/6 into the WS0 extraction where cheap, do
3/4/5 after. WS3–WS6 are independent of each other; suggested order
WS3 → WS5 → WS4 → WS6 (report last so it can include the new sections).

## Bookkeeping

- TODO.md: add this plan under Now (pointer to this file), remove the shipped
  eval-views placeholder note in Ribbon.vue's comment when the hub lands.
- On each ship: HANDOVER done-log line; CLAUDE.md — update the Evaluate
  bullet in the modal-framework paragraph + `core/eval/` listing (new files);
  METHODS.md only if a *method* is added (bridge edges / coverage binning
  qualify for one line each in the QC section).
- Verification per change: `npm test` + `npm run typecheck`; hub/overlay/canvas
  need a manual browser run — report that explicitly.
