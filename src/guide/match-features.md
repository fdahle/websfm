<!--
  Guide doc schema (documented once here, applies to every file in src/guide/):

  ---
  id: kebab-case-id     # required, matches the filename; the Guide tab/home key
  title: Display Title  # required, tab + index heading
  summary: One or two sentences shown on the Guide home index. Keep it short.
  category: Pipeline    # home-screen group
  order: 30             # lower appears first
  ---
  Intro prose about the operation (everything before the first `## ` heading).

  ## Human Label
  <!-- param: settingsKey  default: 0.75 -->
  Body explaining how to choose this parameter. `param:` binds the section to the
  field's settings key so `<FieldHelp param="settingsKey">` resolves here; the
  optional `default:` is fallback text only — prefer passing the live value via
  `:default-value` from the modal so docs can't drift from code.

  Cross-link glossary concepts with [label](help:entry-id) and other operations
  with [label](guide:op-id). Glossary terms also auto-link on first occurrence.
  Math ($…$) and images (![alt](assets/foo.png)) work as in the glossary.

  Write for the user, briefly: what the setting does and when to change it, about
  80 words a section (CONTRIBUTING.md ▸ Keep the in-app help in step).
-->
---
id: match-features
title: Match Features
summary: Finds corresponding keypoints between image pairs and verifies each pair geometrically before it reaches reconstruction.
category: Reconstruction pipeline
order: 30
---
Matching finds which [keypoint](help:keypoint)s of two images show the same point. The
verified matches become the [tie point](help:tie-point)s of the sparse
reconstruction. A false match harms [bundle adjustment](help:bundle-adjustment), so
every pair is checked with [RANSAC](help:ransac).

## Only some images
Right-click images ▸ **Match features…** matches only the pairs that include them, among
the pairs the strategy chooses. Every other pair keeps its result.

## How the settings fit together
The dialog follows the run: **choose image pairs**, **match descriptors**, **verify
geometry**, **accept the pair**. Each step says what it will do with the current
settings, for example how many pairs will be matched. Settings the current choices
ignore are hidden or greyed with the reason.

## Pairing
<!-- param: strategy  default: Preselect when images have camera positions, Sequential for video frames, otherwise Exhaustive -->
Which pairs are matched. **Exhaustive** matches every pair: safe, but the time grows
with the square of the image count. **Sequential** matches each image to the next few
in capture order: for video, orbits and single strips. **Preselect** uses camera
positions or footprints to match only pairs likely to overlap
([pair preselection](help:preselection)). If part of the block stays unregistered,
widen the window or match exhaustively.

## Following images
<!-- param: sequentialOverlap  default: 10 -->
**Sequential**: each image is matched to this many following images in capture order.
Ten suits a smooth orbit. Images from a second pass over the same place are never
paired with the first; use Exhaustive for such a capture.

## Close capture loop
<!-- param: sequentialLoopClosure  default: off -->
**Sequential**: also matches the last images to the first, so a complete orbit closes
into a ring. Turn it on only when the capture returns to its start.

## Preselect by
<!-- param: preselectMethod  default: Camera position -->
**Camera position** pairs each image with its nearest cameras (GPS or imported
[camera poses](help:camera-pose)): the usual choice for nadir blocks. **Footprint
overlap** pairs images whose ground footprints overlap, which suits oblique or
converging views.

## Neighbours per image
<!-- param: maxNeighbors  default: 10 -->
**Preselect by camera position**: how many nearest cameras each image is matched with.
Raise it for dense, cross-strip or irregular flights; lower it to match faster. Images
without a position keep all their pairs.

## Minimum overlap %
<!-- param: minOverlap  default: 30 -->
**Preselect by footprint overlap**: a pair is kept when its shared area is at least
this share of the smaller footprint. Lower it for little side-lap; raise it to match
faster. Footprints are approximate, so keep a margin.

## Match only new pairs
<!-- param: onlyNewPairs  default: on when some images with features are in no pair yet, otherwise off -->
Pairs that already have a result keep it, and only the others are matched: after adding
photos, only the new ones are matched with the rest. Turn it off to match every pair
again with these settings. Then run [Sparse Reconstruction](guide:sparse-reconstruction)
with **Add to the model**.

## Matcher
<!-- param: matcher  default: Brute-force + RANSAC -->
**Brute-force** compares [descriptor](help:descriptor)s with a
[ratio test](help:lowe-ratio-test) and works with every detector. **LightGlue** is a
learned matcher for images detected with ALIKED, DISK or SuperPoint, all with the same
one; its weights download on first use.

## Ratio threshold
<!-- param: ratioThreshold  default: 0.8 -->
Brute-force keeps a match only when the best descriptor is clearly closer than the
second best. Lower is stricter. Raise it toward 0.9 for low-texture images (snow,
uniform fields); lower it toward 0.7 for repetitive structure (façades, crop rows).

## Matching density
<!-- param: density  default: Fast -->
LightGlue ([matching density](help:matching-density)). **Fast** matches each image's
strongest keypoints in one pass. **Full** aligns the two images first, then matches
every keypoint in aligned tiles: more tie points from images with many keypoints, at a
clear cost in time. Full is best with a GPU.

## Keypoints per image
<!-- param: lgMaxKeypoints  default: 2048 -->
**Fast** density matches this many of each image's strongest keypoints (0 = all). Time
grows with its square, so prefer **Full** density over a much larger number. With Full
it is only the fallback for a pair that cannot be aligned.

## Keypoints per tile
<!-- param: lgTileBudget  default: 2048 -->
**Full** density: about how many keypoints one aligned tile matches. Higher means fewer,
larger tiles and more time per tile; lower it if the GPU runs out of memory.

## Cross-check (mutual NN)
<!-- param: crossCheck  default: on -->
Brute-force keeps a match only when each keypoint is the other's nearest neighbour.
Without it, many keypoints can claim the same partner, which lowers inlier ratios and
can mislead RANSAC. Off gives more, weaker matches.

## Ignore stationary points
<!-- param: filterStationary  default: off -->
Drops matches that sit at almost the same pixel in both images. A real point moves
between views; marks fixed to the camera or scanner do not: film
[fiducials](help:fiducial-marks), frame edges, data strips, reseau crosses, dust. Turn
it on for unmasked film scans and satellite frames.

## Subset gate (fast pre-test)
<!-- param: subsetGate  default: on -->
Brute-force with Exhaustive pairing: each pair first matches a small sample of
keypoints and is skipped when too few match. This saves most of the time on large
unordered sets but now and then skips a real pair (images left with few pairs are
tested again). Turn it off when matching is fast anyway, or when images that should
connect stay apart.

## Subset size
<!-- param: subsetGateSize  default: 200 -->
The smallest sample per image the subset gate matches; it grows with the keypoint
count. Larger is more reliable on images with few keypoints, and slower.

## Min subset matches
<!-- param: subsetGateThreshold  default: 8 -->
How many sample matches a pair needs to be matched in full. Lower it if pairs with real
overlap are skipped; raise it to finish sooner.

## RANSAC verification
<!-- param: geometricVerification  default: on -->
Fits one [epipolar geometry](help:epipolar-geometry) per pair with
[RANSAC](help:ransac) and discards matches that don't fit it, which removes most false
matches. Turn it off only to inspect raw matches.

## Estimator
<!-- param: verifier  default: RANSAC -->
How the geometry is fitted. **RANSAC** keeps the model most matches fit.
**[MAGSAC++](help:magsac)** weights matches by how well they fit, so it depends less on
the threshold, for about a fifth more verification time. Results are usually the same.

## RANSAC threshold
<!-- param: ransacThreshPx  default: 2.0 -->
How far, in pixels, a match may lie from its [epipolar line](help:epipolar-geometry)
and count as an inlier. The pixels are those of the detection resolution, so large
images detected smaller need no change. 1–2 px suits most images; raise it if pairs
with visible overlap are rejected, lower it if wrong pairs are accepted.

## RANSAC iterations
<!-- param: maxIters  default: 1000 -->
How many samples RANSAC tries. Raise it only for hard pairs with many outliers; time
grows linearly.

## Min matches per pair
<!-- param: minMatches  default: 15 -->
A pair needs at least this many verified matches to join the
[match graph](help:match-graph). Pairs below it that still have 15 inliers are kept as
weak pairs, which can place a camera but never start the model.

## Min inlier ratio
<!-- param: minInlierRatio  default: 0.15 -->
Rejects a pair when fewer than this share of its matches fit the geometry, the main
guard against a false fit on repetitive structure. Pairs with 30 or more inliers pass
anyway. Raise it to drop doubtful pairs more aggressively.

## Repair a split graph
<!-- param: repairSplits  default: on -->
Images from very different directions (nadir and oblique, façade and roof) can leave
the block in pieces, or with a piece hanging on by a few weak pairs, which
[sparse reconstruction](guide:sparse-reconstruction) cannot place together. With this
on, matching then retries the most promising pairs between each piece and the main
block with more lenient settings, still verified with RANSAC. The log says how many
pieces it joined.

## Detect gaps again at full size
<!-- param: gapRedetect  default: on -->
When pieces are still apart after the repair, their images and their best partners in
the main block are detected again at full size and matched again, to find the detail
that a reduced detection resolution lost. Only for SIFT images detected under 0.8× of
their size and matched by brute force, not on a selection, and not when more than half
the block is apart: detect everything at full size then.

## GPU acceleration
With **Use GPU** on (Settings → Compute), brute-force matching runs on the graphics
card, typically 10–100× faster with the same matches. The first pair is checked
against the CPU, and the run falls back to the CPU on any disagreement or error.
Geometric verification stays on the CPU. With fast GPU matching, consider turning the
subset gate off.

## Read the timing report
After matching, the log gives wall time and the summed time of each stage (loading,
matching, verification). Stage totals can exceed wall time because pairs run in
parallel.
