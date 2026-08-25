# Plan — kill sky/vegetation freckles at the depth map, not at fusion

> **Status (2026-08-17): Stage A′ shipped 2026-07-17, unmeasured on real data.**
> Stages 1+2 turned out to be one small pure-JS change, not a kernel workstream —
> see "What actually shipped" at the bottom before reading the rest.
> Open work: TODO ▸ Now ▸ DF (retune the defaults *from* the measurements).
> Owed manual checks: `VERIFICATION.csv` ▸ `DEN-02`…`DEN-04`, `DEN-13`.
> Delete this file once DF closes.

## Problem

PatchMatch emits a depth for **every** pixel, including regions where depth is not a
meaningful quantity: sky (no parallax, no rigid surface) and vegetation (textured but
non-rigid, self-occluding, view-dependent). Those pixels survive into the dense cloud as
a freckled mess, and — because the orthophoto reuses the cached depth maps as its
z-buffer — into the ortho as well.

Today every real outlier filter runs at **Stage B fusion** (`fuseDepthMaps`, maxCost /
minTriAngleDeg / maxIncidenceDeg / removeIsolated). Stage A ships a dirty plane: the only
cleanup is `filterDepthMap`'s local speckle median, which is a *neighbourhood* test and
cannot see cross-view disagreement. So the freckles are filtered late, per-point, after
the information needed to reject them cheaply has already been thrown away.

## What COLMAP and Metashape actually do

Neither skips computing. Both compute everything, then discard aggressively **inside
Stage A**, writing zeros into the depth map itself.

COLMAP (`PatchMatchOptions`, `patch_match.cc`) runs dense in two passes:

1. `geom_consistency = false` — photometric only. This is what we have.
2. `geom_consistency = true` — re-runs PatchMatch with the cost extended by a
   **forward–backward reprojection error** against the *neighbours' first-pass depth
   maps* (`geom_consistency_regularizer`, capped at `geom_consistency_max_cost`). A pixel
   whose depth disagrees with what its neighbours independently believe is actively
   penalised **during optimisation**, not just rejected afterwards.

Then `filter = true` drops each pixel on four independent tests:

| COLMAP option | default | kills |
|---|---|---|
| `filter_min_ncc` | 0.1 | textureless (flat sky) |
| `filter_min_triangulation_angle` | 3.0° | zero-parallax (sky, distant haze) |
| `filter_min_num_consistent` | 2 | pixels no other view agrees with |
| `filter_geom_consistency_max_cost` | 1.0 | geometrically inconsistent (vegetation) |

Metashape ships the same idea as one preset — "Depth filtering: mild / moderate /
aggressive" — plus **manual masking** for sky. Neither has built-in sky segmentation.

**Conclusion: we already have COLMAP's four filters. We run them in the wrong place
(fusion, per-point) and one pass too late (no geometric-consistency pass at all).**

## Why one knob can't fix both symptoms

These are two different failure modes and they respond to different levers:

- **Sky** — textureless ⇒ ZNCC has no minimum, so PatchMatch keeps whatever hypothesis
  random refinement last drew. Flat sky already dies on our `INVALID` sentinel
  (`denom < 1e-6`, `mvs.rs:140`). But a **gradient sky or clouds correlates well at any
  depth** — high NCC, arbitrary depth. It sails through every cost gate we own. What
  kills it is **triangulation angle** (~0°) and geometric inconsistency.
- **Vegetation** — genuinely high texture ⇒ genuinely high NCC. **No cost gate will ever
  reject a bush.** It fails only because the depth is inconsistent *between views*. Only
  a cross-view geometric check sees this.

So `maxCost` is a sky-ish lever that misses gradient sky, and is useless on vegetation.
The geometric-consistency term is the one mechanism that addresses both.

## Plan

Ordered by payoff-per-unit-risk. Each stage is independently shippable and independently
measurable.

### Stage 1 — move the existing filters into Stage A (low risk, no new math)

Add a `filterDepthMapGeometric(dm, opts)` beside `filterDepthMap` in
`core/dense/mvs.js`, run after Stage A per image, zeroing rejected pixels in place:

- `minNcc` — reject `cost > 1 - minNcc`. A per-pixel absolute floor, distinct from
  fusion's adaptive p70 `maxCost`. Default ≈ COLMAP's 0.1 ⇒ `cost > 0.9`.
- `minTriAngleDeg` — needs the per-pixel best-source parallax. **This is the one piece
  Stage A does not currently retain**: `agg_cost` reduces over sources and discards which
  ones were valid. Requires the kernel to emit a per-pixel angle or source bitmask (see
  Stage 2 — they share the plumbing, so build them together).

Benefit even standalone: the persisted depth maps become clean, so the **ortho** improves,
fusion gets less garbage to chew, and `depthmaps/` sidecars shrink.

**Risk:** none to the three-kernel invariant — this is pure JS post-processing, no
`patchmatch.wgsl` / `planeCost.js` / `mvs.rs` change.

### Stage 2 — geometric-consistency pass (the real fix)

The main event. Implement COLMAP's second pass:

1. Stage A pass 1 as today ⇒ depth/normal/cost planes for all images.
2. Stage A pass 2 per image: re-run PatchMatch with the cost
   `photometric + λ · min(fwd_bwd_reproj_err_px, maxGeomCost)`, where the error projects
   the pixel into each source, samples that source's **pass-1 depth**, back-projects, and
   reprojects into the reference. This needs the source depth planes uploaded alongside
   the source grays.
3. Filter on `numConsistent >= 2` and `geomCost <= maxGeomCost`.

**This is the change that kills vegetation**, and it kills gradient sky as a free side
effect (nothing agrees about sky's depth either).

**Costs and risks — be honest about these:**

- **~2× Stage A wall clock.** Already minutes/image on CPU. The GPU backend makes this
  tolerable; on the WASM backend it may need to be opt-out or quality-gated.
- **Touches all three PatchMatch kernels** (`mvs.rs`, `patchmatch.wgsl`, `planeCost.js`)
  — the lockstep invariant applies, and the first-image GPU↔CPU A/B check must stay
  RMS < 5e-3. This is the expensive, careful part of the plan.
- **Memory:** source depth planes resident during pass 2. Extend `memBudget.js`
  (`projectDensifyPeakBytes` currently models only the fusion peak — this adds a Stage A
  peak it does not know about).
- **Ordering:** pass 2 needs *all* pass-1 maps, so it cannot stay inside the current
  per-image loop. Persistence already gives us this for free (maps land in `depthmaps/`),
  but the orchestration in `mvs.js` becomes two phases.

### Stage 3 — sky masking (the actual "don't compute at all")

This is the only proposal that literally skips computation, and we are unusually well
placed for it: **SAM2 is already wired** (`core/segment/sam2.js`), masks already flow
into dense (`workers/ops/dense.js:405-411` zeroes masked depth; `mvs.rs:118` rejects
masked source texels from ZNCC).

Two variants:

- **Manual** — nearly free. The mask tool already exists; this is a docs/UX nudge plus
  perhaps a "mask sky" preset. Matches what Metashape users actually do today.
- **Automatic** — a sky-segmentation model per image, or a heuristic seed (top-of-frame +
  blue/luminance + no-parallax) fed to SAM2. New model weights, new failure modes
  (snow/ice vs sky is genuinely ambiguous — and this is an **Antarctica-targeted app**,
  so a naive brightness/blue prior is actively dangerous here).

Note the mask path currently zeroes depth *after* computing it (`dense.js:411`). Skipping
the compute is a pure speed win, worth doing while in there, but it is not the quality
lever — the quality lever is that masked pixels are already excluded as *source* texels.

**Vegetation is not a masking problem.** Don't chase it here; bushes are real geometry
that the user often wants, just badly reconstructed. Stage 2 is the answer, not a mask.

### Stage 4 — expose it

`DEPTHMAP_DEFAULTS` in `core/defaults.user.js` + `DepthMapsModal.vue`, following the
`PresetCards` → `AdvancedDisclosure` → `SettingsGroup` template (`ReconstructModal` is
the reference):

```js
geomConsistency: true,   // second PatchMatch pass w/ cross-view depth agreement
maxGeomCost: 1.0,        // px; fwd-bwd reprojection error cap
minConsistent: 2,        // min agreeing views to keep a pixel
minNcc: 0.1,             // absolute per-pixel photometric floor
```

Internal knobs (`geomRegularizer` λ) → `DENSE_TUNING`. A Metashape-style
mild/moderate/aggressive delta set over these is the natural preset shape.

## Recommendation

**Stages 1+2 together, as one workstream** — they share the per-pixel-source plumbing,
and Stage 1 alone will not touch the bushes (high-NCC by construction). Stage 3 manual is
a cheap parallel win; Stage 3 automatic is a separate project with real Antarctic-specific
risk. Stage 4 rides along with 2.

Keep the fusion filters as-is throughout. They are a correct second line of defence and
the isolated-cell removal catches things no per-image pass can see.

## Measurement

Per CLAUDE.md, baselines land in HANDOVER.md. Before/after on a sky-heavy and a
vegetation-heavy set:

- dense point count, and count in a hand-boxed sky region (should → ~0)
- Stage A wall clock per image, both backends (the ~2× claim needs a real number)
- fusion cull breakdown (`Dense` log category — the existing per-filter percentages)
- ortho visual check over vegetation

## Open questions

- Pass 2 at full resolution, or coarse-only to halve the cost?
- Do we re-persist pass-2 maps over pass-1, or keep both? (Staleness stamping in
  `depthMapCodec.js` assumes one set per sparse cloud — one set, overwritten, is simpler
  and matches COLMAP's `.geometric.bin` superseding `.photometric.bin` in practice.)
- Is `minTriAngleDeg` at Stage A redundant once geometric consistency runs? COLMAP keeps
  both; cheap enough to keep.

---

## What actually shipped (2026-07-17)

Reading the fusion loop before writing code changed the plan substantially. **The
estimate above was wrong in a useful direction** — the freckle fix needed no kernel work
at all.

**The root cause was more specific than "filters run too late".** `fuseDepthMaps` already
had a cross-view consistency check, so the plan's framing ("we have COLMAP's filters, just
in the wrong place") did not explain why vegetation survived it. It survived because that
check is *too weak*: `mvs.js:767-776` searches a `(2·consistencyPx+1)²` = 5×5 window in
each source and accepts if **any** pixel there has a depth within 1%. A bush is a cloud of
depths spanning a range — some pixel in a 5×5 window is near the right depth by chance. It
was never a real forward–backward reprojection test.

**Consequence: the plan's Stage 1 / Stage 2 split dissolved.** Stage 1 was going to be
"move the existing filters to Stage A", blocked on per-pixel triangulation angle from the
kernel, with Stage 2 as the expensive lockstep change. In fact the *filtering* half of
COLMAP's geometric consistency — the half that removes freckles — is **pure JS over the
pass-1 depth planes**. It needs no per-pixel source bitmask, no kernel change, no second
PatchMatch pass, and no `memBudget.js` work. So Stages 1+2 collapsed into one function,
`filterDepthMapsGeometric`, and the plan's headline risks (2× Stage A, three-kernel
lockstep, GPU↔CPU A/B) do not apply to what shipped.

What remains of Stage 2 is only COLMAP's `geom_consistency` **optimisation** pass, which
buys *completeness*, not precision. Deferred (TODO ▸ DF) — it is worth doing only if the
baseline shows holes rather than freckles.

**One design point the plan didn't anticipate:** the filter must judge every map against
the *unfiltered* planes. Zeroing map *i* in place makes map *i+1* judge itself against
already-thinned evidence, cascading rejections in map order — an order-dependent,
irreproducible cloud. Rejections are staged into per-map masks and applied afterwards;
`mvs.test.js` pins it both ways round.

**Stage 3 (masking) and Stage 4 (UI):** Stage 4 shipped (four knobs in
`DEPTHMAP_DEFAULTS` + `DepthMapsModal`); the preset set is deliberately *not* invented
until real numbers exist. Stage 3 automatic is closed as "not doing" — the Antarctic
snow-vs-sky ambiguity makes a brightness prior actively dangerous, and manual masking
already works.

**Verification status:** `npm test` (626 pass, 6 new) + `npm run typecheck` green. The
before/after baseline on real imagery is **owed** — this environment cannot run the
browser dense pipeline, so nothing here is confirmed against actual sky or bushes yet.
