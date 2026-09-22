# Plan: fix the 2-camera registration stall (building baselines)

> **Status (audited 2026-09-01): WS-A + WS-C shipped 2026-07-16; unproven on real data.**
> The synthetic scene cannot reproduce the stall (a noise-free co-visible rig absorbs
> even k1 = −0.35), so `register.test.js` pins the *guard*, not the recovery.
> Open work (all conditional on the runs): TODO ▸ Now ▸ SFM.
> Owed manual checks: `VERIFICATION.csv` ▸ `SFM-03`…`SFM-06`.
> Delete this file once the runs settle the WS-B/follow-up decisions; the rows stay
> in `VERIFICATION.csv` until they are signed off.

Executor plan. Read CLAUDE.md first (layering rules, "pure core", verification policy).
Everything here is inside `src/core/sfm/` + `src/core/tuning.js`, so `npm test` +
`npm run typecheck` cover it; the full-pipeline confirmation needs a manual browser
run (say so explicitly in your report rather than claiming it).

## Context — what the baselines showed

Four baseline logs (building 50-image Canon set, TMA 5-image film-scan set, each with
SIFT/brute-force and SuperPoint/LightGlue):

| Run | Matching | Reconstruction |
|---|---|---|
| building + SIFT | 166/1225 pairs, 13k inliers | **2/50 cams** |
| building + LightGlue | 1112/1225 pairs, 163k inliers | **2/50 cams** |
| TMA + SIFT | 6/10 pairs, 391 inliers | 2/5 cams |
| TMA + LightGlue | 8/10 pairs, 1445 inliers | **5/5 cams** (rescue fired) → dense OK |

Matching quality moved 12× between the two building runs and the reconstruction
result did not move at all — the bottleneck is registration, not matching.

**Root cause (building):** uncorrected radial distortion (24mm full-frame lens; the
run's own self-cal later measures k1 ≈ −0.025, ~58px corner shift). The 2-view seed
absorbs distortion into point positions (init reproj median 1.77px looks perfect),
then every third-view PnP fails the acceptance gates: inlier ratios 10–29% vs the
30% gate, and the "pose fits loosely" defers show ~half the correspondences holding
at the 8px gate but not at the 4px recheck (e.g. IMG_4326: 259/596 @ 8px, only
128 within 4px). That radial gradient is exactly what `register.js`'s D3 comment
(line ~81) predicts — the designed mitigation is interim-BA self-cal at
`distortionCalMinCams = 6` cameras, but the model never reaches 3 cameras, so it
never engages. Chicken-and-egg.

**The unreachable rescue:** the stalled-strip rescue (focal solve + retriangulation +
one relaxed-recheck sweep) is exactly what saved the TMA LightGlue run — but its
guard is `cameras.size >= 3` ([register.js:461]). A stall at the 2-camera seed,
which is what both building runs did, can never be rescued.

Numbers that matter for the fix: the relaxed retry admits at
`pnpThresh` (= reprjThreshold 4.0 × pnpGateScale 2 = 8px) with
`rescueRefineRatio = 0.2` (tuning.js:67). The building defer logs show many images
at 20–43% within 8px — they would pass a relaxed sweep.

## WS-A (Now): let the rescue fire at a 2-camera stall

**Change:** in `src/core/sfm/register.js` line ~461, relax the rescue guard from
`cameras.size >= 3` to `cameras.size >= 2`.

That one change is deliberately self-limiting: the inner BA guard at line ~469
(`cameras.size >= 3`) still skips the focal solve at 2 cameras — correct, since
f/k1 are weakly observable from 2 views — so a 2-camera rescue is just
retriangulation + one relaxed sweep. Sequence that should then unfold on the
building set:

1. Pass 1 registers nothing → rescue fires (48 linked images exist).
2. Relaxed sweep admits poses at 8px / 20% — many building images qualify.
3. As cameras accumulate, interim BA (`interimBaEvery`) runs; once
   `cameras.size >= distortionCalMinCams` (6) it refines f,k1 and
   `runBundleAdjust` folds distortion out of the keypoints (existing D3 machinery).
4. Subsequent strict sweeps run against pinhole geometry and should register the rest.

**Watch-outs:**
- `rescued` is one-shot. If the model registers a handful of cameras in the relaxed
  sweep and then stalls again *before* reaching 6 cameras (pre-fold), it's stuck
  again. If baselines show this, add a second trigger: allow one more rescue after
  the first distortion fold has happened (track "folded since last rescue" in the
  loop; keep it bounded — max 2 rescues total). Do NOT make rescue unbounded.
- Loose poses enter a distorted model. The interim BA + track filter + merge steps
  interleaved in the sweep are the designed cleanup; verify final median/p95 in the
  re-run rather than adding new gates preemptively.
- Update the comment block above the rescue (lines ~456–460) to describe the
  2-camera case, and the D3 comment (~line 87) which currently says registration
  "has already stalled" is the failure mode being prevented.

**Tests:** follow the existing test conventions around `src/core/sfm` (look for
existing `register`/`sfm` tests with `Glob src/core/sfm/*.test.js` or the repo's
test dir pattern). Add a regression: synthetic scene with radial distortion applied
to observations of ≥6 cameras where the seed pair fits cleanly but third-view PnP
fails the 30% ratio at 4px — assert that registration recovers ≥N cameras with the
new guard and stalls at 2 without it. If constructing that synthetically is too
heavy, minimally unit-test that the rescue block triggers at `cameras.size === 2`
(mock ctx, spy on the log/retriangulate path).

## WS-B (Now, only if WS-A alone doesn't fully register the building set): earlier f,k1

Make the distortion self-cal engagement obs-aware instead of camera-count-only:
in `register.js`, `distortionRefine(n)` / `rescueRefine(n)` currently gate on
`n >= distortionCalMinCams` (6). Change to engage f,k1 when
`cameras.size >= 4 && totalObservations >= ~2000` (pick the constant in
`tuning.js` next to `distortionCalMinCams`, with a rationale comment, per the
"internal dev-tuning knobs live in tuning.js" rule). The building relaxed sweep
will have thousands of observations by 4 cameras. Do not go below 3 cameras —
the D3 comment's warning about 2–3-view k1 fits stands.

## WS-C (Next): self-cal stability + TMA sensor config

1. **Post-filter self-cal on tiny models is fitting noise.** Both TMA runs show k1
   oscillating between passes (+0.032 → −0.010; −0.049 → −0.005) and every composed
   fit trips the "corner shift exceeds 50px" runaway warning. In `sfm.js`'s
   post-filter self-cal passes, skip the f,k1 refine+fold when `cameras.size < 3`
   (keep 'none'), and log why. This becomes mostly moot once WS-A lands (models
   won't end at 2 cams), but it protects genuinely tiny projects.
2. **TMA pixel pitch:** both TMA runs warn `implied film width 253mm is not a
   standard aerial format (~230/240mm)`. Trace where K is derived for film sensors
   (`core/io/sensor.js` / the `resolveK` path referenced in the warning text in
   sfm.js) and check whether the sensor table's film-format (mm) field, when set,
   takes precedence over pixel-pitch-derived width. If it already does, this is a
   dataset-config note, not code — record that in TODO.md and stop. If pitch wins
   over an explicit film format, flip the precedence.

## WS-D (Last): re-baseline + bookkeeping

1. Re-run all four baselines in the browser (manual step — flag for Felix if you
   cannot run a browser): building×{SIFT, SP+LightGlue}, TMA×{SIFT, SP+LightGlue}.
   Success criteria:
   - building + LightGlue: ≥45/50 cameras registered, post-BA median ≤ ~1px.
   - building + SIFT: materially more than 2 cameras (SIFT's 166-pair graph is
     sparse; full registration may not be reachable — report, don't force).
   - TMA + LightGlue: still 5/5 (no regression), fusion kept-fraction not worse.
   - rotation-cycle filter: check whether median cycle error drops below the 30°
     ceiling on the re-runs once distortion folds earlier — if it starts engaging,
     note it; if it still always skips, add a TODO.md item to revisit it (it is
     currently dead weight on every dataset).
2. Update `TODO.md` (remove shipped items, add the follow-ups discovered above) and
   add one done-log line per shipped workstream to `HANDOVER.md` with the
   before/after camera counts as the yardstick. If the registration *method*
   changed in a way a photogrammetry colleague would care about (rescue at 2-view
   stall = yes), add a sentence to METHODS.md's registration section.

## Verification checklist (per CLAUDE.md)

- `npm test` and `npm run typecheck` after each workstream.
- No `crates/` changes are expected; if you end up touching Rust, rebuild wasm and
  commit `src/wasm/*` with it.
- Keep the heavy `onLog` style: any new branch (2-cam rescue, obs-gated self-cal,
  skipped tiny-model fold) gets an auditable log line.
- Browser-runtime verification (the actual baseline re-runs) cannot be done
  headlessly here — state explicitly what was and wasn't verified.
