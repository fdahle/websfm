# HANDOVER — SfM quality overhaul (COLMAP/Metashape parity + modal UI framework)

**For the executing agent.** This is your entry point. The full technical plan lives in
[`.claude/plans/modular-cuddling-beaver.md`](modular-cuddling-beaver.md) — read it in full
before touching code; this document tells you how to execute it, what has already been
verified, what needs Felix, and where the traps are. Do not duplicate work: check `git log`
and `TODO.md` first in case a phase already shipped.

> Naming note: the repo root `HANDOVER.md` is the project's baseline/done-log record
> (see CLAUDE.md "four docs" contract) — it is NOT this document. You will *append* to it
> when phases ship; never replace it with this.

---

## 0. Read-first list (in order)

1. `CLAUDE.md` — layering rules, invariants, gotchas. Non-negotiable.
2. `.claude/plans/modular-cuddling-beaver.md` — the approved plan (WS1–WS5). Scope is fixed.
3. `METHODS.md` — the science doc you must update when methods change.
4. Skim: `src/core/sfm/sfm.js`, `src/core/sfm/register.js`, `src/stores/useMatchesStore.js`,
   `crates/reconstruction/src/bundle.rs`, `src/core/dense/mvs.js` — the five files carrying
   most of the change.

## 1. Mission in one paragraph

websfm loses cameras and calibration accuracy vs Metashape on two reference datasets
(50-image building set, 5-image TMA film scans) and produces sky/vegetation noise in dense.
Root causes are known and the fixes are approved: decouple the match-acceptance gates and
add COLMAP-style "weak pairs" (WS1); extend BA self-calibration from `f,k1` to
`f,cx,cy,k1,k2,k3` with a correct pristine-keypoint fold (WS2); stop the rotation-cycle
filter from permanently severing true edges — bridge protection + post-self-cal re-admission
(WS3); add three geometric dense-fusion filters (WS4); and consolidate ~16 hand-rolled modals
into a shared UI framework with quality presets (WS5). No backward compatibility required.
No segmentation model, no p1/p2 tangential — those were explicitly rejected.

## 2. Current state of the tree (as of 2026-07-15)

- Branch `main`, **dirty working tree**: uncommitted changes in `DenseModal.vue`,
  `initPair.js`, `register.js`, `sfm.js`, `tuning.js`, `useReconstructionStore.js`,
  `.claude/settings.local.json`.
- **First action**: inspect that diff (`git diff`), understand it, and commit it as its own
  commit (or get Felix to) BEFORE starting Phase 1. Do not mix it into overhaul commits.
- **Line numbers in the plan were written against this dirty tree and will drift.**
  Anchors re-verified 2026-07-15:
  - `minMatches: 15` → `src/core/defaults.user.js:38` ✓
  - `REFINE_MODE` map → `src/core/sfm/reconstruction.js:265` ✓
  - inconsistent `kdim` map → `crates/reconstruction/src/bundle.rs:227` ✓
  - additive-k1 fold → `src/core/sfm/sfm.js` ~L761–795 (plan says L810 — already drifted;
    find it via `undistortPixel(kp.x, kp.y, rk, { k1 })`).
  Treat every other line ref in the plan as a hint; grep for the quoted symbol instead of
  trusting the number.

## 3. Operating rules (repo contracts — violating these is a failed handover)

- **Layering**: `src/core/**` stays PURE (no Vue/Pinia/OPFS/DOM; side effects only via
  injected `onLog`/`onProgress`). New modules `pairGate.js`, `selfCalSchedule.js`,
  `selfCalCompose.js` are core → pure, with co-located defaults that `tuning.js` *points to*
  (the `initPair.js`/`cycleFilter.js` pattern), never duplicates.
- **Defaults split**: user-visible knobs in `defaults.user.js` (modal prefills from the same
  object core falls back to); dev-only knobs in `tuning.js`. Never hardcode a knob in two
  places. Modals that hold UI-unit values do the transform in their own `run()`.
- **After any `crates/` change**: `npm run build:wasm` and commit `src/wasm/*` **in the same
  commit** as the Rust source. Rust mesh tests need `--release`; reconstruction tests are fine
  in debug via the JS test suite.
- **Per-phase verification**: `npm test` + `npm run typecheck`. Browser-runtime work (modals,
  WGSL, OPFS) needs a manual browser pass **you cannot do** — say so explicitly in the commit
  /report, never claim it verified.
- **Logging style**: every derived/auto value gets an auditable `onLog` line (the plan
  specifies several new ones — deferred self-cal stages, re-admission counts, cull breakdown).
- **Commits**: one commit per plan sub-item or modal migration, message says which WS/phase.
  Keep the tree green (tests pass) at every commit.
- **Docs on ship** (per phase, not at the very end): remove the item from `TODO.md`, add a
  done-log line to root `HANDOVER.md`, update `METHODS.md` when the *method* changed
  (self-cal model, weak pairs, fusion filters), and fold evergreen lessons into `CLAUDE.md`
  (bitmask refine modes, pristine-fold invariant, `modals/ui/` framework).

## 4. What needs Felix (do not fake these)

- **Phase 0 baselines**: the two dataset runs happen in a browser with Felix's local imagery.
  You cannot run them. Ask Felix to run both datasets at **default settings** at the
  pre-overhaul commit and hand you `log.ndjson`; you extract the yardstick numbers
  (registered cams, post-BA median px, %≥3-view tracks, fx + k1, cycle drops, fused count +
  cull breakdown) and park them for root `HANDOVER.md`. **Phase 0 must not block Phase 1** —
  code work can start in parallel; baselines only need to exist before end-to-end verification.
- **End-to-end verification runs** (after Phase 4, again after 5): same — Felix runs, you
  analyse logs against the acceptance numbers in the plan's Verification section
  (building: ≥45/50 registered, fx 2983±1%, distortion-**curve** deviation ≲1px vs Metashape
  k1 −0.1367 / k2 +0.1007 / k3 −0.027 @ f 2983; TMA: 5/5, 33↔34 accepted, 58.8° abort still
  fires). Write the curve-comparison scratch script yourself (Δr(r) = f·r·(k1r²+k2r⁴+k3r⁶)
  over r∈[0, corner]) — put it in the session scratchpad, not the repo.
- **Per-modal visual QA in Phase 5** and the dense sky/bush before/after look: manual browser,
  Felix's job — flag each explicitly.
- **Tell Felix** (if not already done): the baseline runs used a user-set `minMatches=500`
  (+ `minInlierRatio 0.4` on building) — the default is 15. The bad numbers are partly
  settings, but the robustness work is still justified (one knob currently severs the graph).

## 5. Execution order & phase checkpoints

Follow the plan phases in order: **1 (WS1 matching) → 2 (WS2 self-cal) → 3 (WS3 cycle filter)
→ 4 (WS4 dense) → 5 (WS5 modals)**. Phase 3 depends on Phase 2's fold rework (`{folded}`
return, refined Kmap); Phase 5 goes last so WS1/WS4 controls land once in the new components.
Full technical detail per phase is in the plan — this is the checkpoint list:

### Phase 1 — WS1 matching (plan §1)
- Ship: decoupled `rawSkipFloor` (clamped `min(rawSkipFloor, minMatches)`), `entry.weak` flag
  end-to-end (store → marshalling → sfm.js partition → `collectCorrespondences` only),
  modal warn-box + max 100, run-summary log line, `core/features/pairGate.js` +
  `evaluatePairAcceptance()` with unit tests.
- Invariants: `hSkipBelow ≤ accept floor` (CLAUDE.md); weak pairs NEVER seed init, feed the
  cycle filter, or triangulate fresh structure — PnP only; `verifiedPairs`/`matchStats`
  exclude weak; spread-degenerate pairs stay hard-rejected (never weak).
- Done when: new tests + full suite + typecheck pass; sfm.test.js proves a weak pair
  registers a third camera via PnP without contributing structure.

### Phase 2 — WS2 self-calibration (plan §2)
- Ship: bundle.rs bitmask refine modes (1=f,2=cxcy,4=k1,8=k2,16=k3; kdim≤6; gpar/jku/jkv
  →[f64;6]; `project_full` with k1r²+k2r⁴+k3r⁶; Jacobians via g≡k1+2k2r²+3k3r⁴; output
  **nCam×7**), wasm rebuild committed with the source; `refineModeMask()` parser + stride-7
  unpack in reconstruction.js; `selfCalSchedule.js` staged schedule (f,k1 @6 cams → +k2 @8
  cams/10k obs → +cx,cy @10 / +k3 @20 cams/30k obs; explicit user strings bypass);
  **pristine-keypoint fold** (`selfCalCompose.js` grid-fit of composed total, refold from
  pristine, model coeffs reset to 0, cx/cy stay on K, k3-runaway guard: reject non-monotonic
  curve or corner |Δr|>50px); dense consumption of the `selfCal` bag applied **after** `dist`
  in `workers/ops/dense.js`.
- Invariants: fy locked to fx (single scale); the fold's forward model must be the exact
  inverse of BA's projection (extend the existing k1 fold comment contract at
  sfm.js ~L761); `summary.selfCalDistortion` becomes `[{sensorId,k1,k2,k3,fitRmsPx}]` — the
  dense marshalling in `useReconstructionStore.js` reads it, so update both sides in one
  commit; Brown-calibrated + forced self-cal ⇒ residual bag applied sequentially after the
  calibrated bag.
- Done when: reconstruction.test.js recovers a rendered k1=−0.15/k2=+0.08 bag; sfm.test.js
  multi-pass composition test holds ≤0.01px; `selfCalCompose.test.js` passes; wasm rebuilt +
  full suite green.

### Phase 3 — WS3 cycle filter (plan §3)
- Ship: `protectBridges` union-find guard in `cycleFilter.js` (30° abort untouched);
  `reevaluateDroppedEdges()` (support ≥0.3, ≥minTriangles); sfm.js `reevaluateDroppedPairs()`
  — re-fit F on folded keypoints (reuse ingest 8-point path), recompute rotations for
  candidates AND survivors with the refined Kmap, re-admit into donePairs; latch hook off
  `runBundleAdjust` `{folded}` in register.js + `modelVersion++` cache invalidation; final
  second-chance sweep (`finalSweep: true`, rescue disabled) + one more BA/track-filter if
  anything registered.
- Trap: judging refit candidates against *unrefit* survivors re-creates the original bias —
  both sides get recomputed rotations. Weak pairs (WS1) are not cycle-filter input.
- Done when: cycleFilter.test.js bridge/re-admission cases pass; sfm.test.js synthetic
  distorted scene registers fully via re-admission.

### Phase 4 — WS4 dense filters (plan §4)
- Ship: `minTriAngleDeg` (default 2.0, 0 disables) in the consistency loop; `maxIncidenceDeg`
  (default 80, 0/90 disables — view-direction fallback normals are inert, log once);
  `filterIsolated` on `createVoxelAccumulator` (cnt≤2 cells only, 26-key arithmetic probe,
  before `finalizeFlat`); DenseModal Advanced section; cull-breakdown log gains
  `lowParallax`/`grazing`/`isolated`.
- **Regression guard is mandatory**: mvs.test.js must prove all-knobs-disabled reproduces
  today's output byte-exact. Respect the fusion invariant — never materialize per-pixel
  point objects; the isolated filter operates on accumulator cells, not points.
- Done when: the five plan tests pass + guard; browser sky/bush check flagged to Felix.

### Phase 5 — WS5 modal framework (plan §5)
- Ship: `src/components/modals/ui/` (ModalShell, SettingsField, SettingsSection,
  AdvancedDisclosure, SegmentedControl, WarnBox, PresetSelector, shared `modal.css` via
  `<style scoped src>`); `.btn/.btn-primary` → global `src/style.css`; `*_PRESETS` as deltas
  in defaults.user.js (medium ≡ defaults, UI-unit values); migrate one modal per commit in
  the plan's order (Reconstruct → … → Detect), ProgressModal/utility modals untouched.
- `useModalEscape` must keep working unchanged (store-flag based). Every migrated modal:
  typecheck + explicit "needs manual browser QA" flag.

## 6. Cross-cutting traps (from CLAUDE.md, filtered to this work)

- Stores marshal **plain** data to the worker — Vue Proxies don't structured-clone. Any new
  field you ship (weak flag, selfCal bag) follows the existing `.map(row => [...row])` style.
- Worker ops keep their `transfer` lists next to them — if you touch dense marshalling,
  don't break the depth/rgb buffer round-trip (buffers must come home for ortho reuse).
- `hSkipBelow` must stay ≤ the accept floor or still-accepted pairs get mislabelled
  non-degenerate (H/F ratio is a seed-quality label only, never a gate).
- Distortion has **one** source of truth from ingest through dense — the whole pipeline
  between is pinhole. The WS2 fold rework strengthens this; never leave coefficients on the
  model after a fold, never let dense re-fit what sparse recorded.
- Disabled pairs (`entry.disabled`) are filtered before reconstruction reads the store —
  weak-pair plumbing must not resurrect them.
- OPFS JSON helpers return `null`/`[]` on miss; absence == empty.
- No compat shims: plan says "no backward compatibility required" — but that means *don't
  build migration code*, not *break unrelated persisted state*. When in doubt, ask Felix.

## 7. Definition of done (whole handover)

1. All five phases committed, `npm test` + `npm run typecheck` green, wasm committed in sync.
2. Both end-to-end dataset runs (Felix-executed) meet the plan's Verification numbers, and
   the minMatches=100 robustness run does not sever the graph.
3. Docs contract satisfied: TODO.md pruned, root HANDOVER.md has baselines + done-log lines,
   METHODS.md reflects the new self-cal model / weak pairs / fusion filters, CLAUDE.md carries
   the new evergreen invariants.
4. Everything you could not verify (browser QA, dataset runs) is explicitly listed as
   outstanding, not silently claimed.
