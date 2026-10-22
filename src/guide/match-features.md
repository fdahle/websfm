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
-->
---
id: match-features
title: Match Features
summary: Finds corresponding keypoints between image pairs and verifies each pair geometrically before it reaches reconstruction.
category: Reconstruction pipeline
order: 30
---
Matching takes the [keypoint](help:keypoint)s that Detect found and, for every
image pair, works out which keypoints describe the same physical point. Each
surviving correspondence becomes evidence for a [tie point](help:tie-point) in the
sparse reconstruction, so a false match here quietly poisons
[bundle adjustment](help:bundle-adjustment) downstream — which is why the defaults
lean strict and every pair is checked with [RANSAC](help:ransac) before it counts.

## How the settings fit together
Matching runs four steps, and the dialog is laid out in that order: **choose image
pairs** (pairing strategy), **match descriptors** (brute-force or LightGlue), **verify
geometry** (RANSAC), and **accept the pair** (minimum matches and inlier ratio). Each
step states what it will do with the current settings. The pairing step shows how many
pairs the run will match, for example `127 images → at most 1,270 pairs (16 % of all 8,001)` with Preselect at 10 neighbours.
Fields that would be ignored by the current choices are either hidden or greyed with
the reason, so every visible number is one that changes the run.

## Pairing
<!-- param: strategy  default: Preselect when images have camera positions, Sequential for video frames, otherwise Exhaustive -->
Decides which image pairs are matched at all. **Exhaustive** matches every pair, which
is safe for any unordered set but grows as $O(N^2)$. **Sequential** matches each image
to the next few in capture order and needs no metadata: use it for video, orbits and
single flight strips. **Preselect** uses camera positions or image footprints to match
only the pairs likely to overlap; see [pair preselection](help:preselection).

The dialog starts on Preselect when at least two matched images have positions, on
Sequential when most images are frames from [Import Video](guide:video-import), and on
Exhaustive otherwise, and suggests a strategy for the dataset under the control. Fewer
pairs make matching faster, but a pair that is never matched can never connect two
images: if part of the block stays unregistered, widen the window or match exhaustively.

## Following images
<!-- param: sequentialOverlap  default: 10 -->
Used by the **Sequential** strategy when GPS or imported camera positions are not
available. Each image is matched to the next N images in capture order, retaining
overlapping views while reducing exhaustive $O(N^2)$ matching to approximately
$O(N \cdot w)$ for a window of $w$ images. Ten is a good starting point for a smoothly captured orbit.
This assumes the image list follows capture order (normally filename/EXIF order; for video frames, their time in the video).
The window cannot reach a second pass over the same place: if the capture comes back
to an area later (a second lap around a building, a re-flown strip), those images are
never paired with the first pass and reconstruct as a separate model. Match such a
set with **Exhaustive** instead.

## Close capture loop
<!-- param: sequentialLoopClosure  default: off -->
Sequential pairing only. The window wraps around the end of the list, so the last
images are also matched to the first ones and a complete orbit closes into a ring
instead of a chain with two loose ends. Without it, small errors accumulate around the
loop and the two ends need not meet. Turn it on only when the capture really returns to
where it started; on an open strip it adds pairs that cannot overlap.

## Preselect by
<!-- param: preselectMethod  default: Camera position -->
**Camera position** keeps each image's nearest cameras, from EXIF GPS or imported
[camera poses](help:camera-pose). It is the usual choice for nadir aerial blocks.
**Footprint overlap** keeps pairs whose ground footprints overlap, which follows where
each camera is looking rather than where it stands: better for oblique or converging
views, where two nearby cameras can face away from each other. Each option is greyed
out when fewer than two images carry the information it needs.

## Neighbours per image
<!-- param: maxNeighbors  default: 10 -->
Used by the **Preselect** strategy: instead of matching every pair (an $O(N^2)$
explosion on large blocks), match each image only to its N nearest neighbours by
camera position, from EXIF GPS or imported poses. Lower N is faster but risks missing real overlap on
cross-strip or looping flight lines; raise it when the flight geometry is dense or
irregular. An image without a position keeps all its pairs; with fewer than two
positioned images the run matches exhaustively.

## Minimum overlap %
<!-- param: minOverlap  default: 30 -->
Used by **Preselect by footprint overlap**: a pair is kept when the area the two
footprints share is at least this share of the *smaller* footprint. Lower it to keep
pairs at the edge of the block or across strips with little side-lap; raise it to drop
marginal pairs and match faster. Footprints are approximate, so a value close to the
real overlap can drop pairs that would have matched. An image without a footprint keeps
all its pairs, and with fewer than two footprints the run matches exhaustively.

## Matcher
<!-- param: matcher  default: Brute-force + RANSAC -->
**Brute-force** compares [descriptor](help:descriptor)s directly, keeps each match that
passes the [ratio test](help:lowe-ratio-test), and works with every detector.
**LightGlue** is a learned matcher. It needs every image detected with the same
learned detector (ALIKED, DISK or SuperPoint), and websfm loads the LightGlue weights trained
for that detector, downloading them on first use. If some images were detected with
another detector, matching stops and names them; re-detect those images with
**Overwrite**. Both are followed by the same geometric verification.

## Ratio threshold
<!-- param: ratioThreshold  default: 0.8 -->
Lowe's ratio test keeps a match only when the best descriptor match is clearly
closer than the second-best — specifically, when `best / second-best` is below this
threshold. **Lower is stricter**: fewer matches, but the ones that survive are more
trustworthy. The default, `0.8`, is COLMAP's; geometric verification removes the
extra false matches it lets through. The Lenient preset uses `0.85` and Strict `0.75`.

Raise it toward `0.9` if you are getting too few matches on low-texture imagery
(snow, ice, uniform terrain); lower it toward `0.6` on repetitive structure
(building façades, sea-ice floes, crop rows) where near-identical descriptors would
otherwise produce confident-looking false matches. Only applies to the brute-force
matcher; LightGlue decides acceptance internally.

## Matching density
<!-- param: density  default: Fast -->
LightGlue only; see [matching density](help:matching-density).
**Fast** matches the strongest *Keypoints per image* of each image in one pass.
**Full** first matches a coarse sample to align the two images, then matches every
detected keypoint in aligned tiles of at most *Keypoints per tile*. The dialog shows the
budget for the density you picked. With Full, the per-image number is used only as a
fallback when the coarse alignment fails for a pair; it then appears under Advanced as
*Fallback keypoints per image*. Full gives more tie points from images detected with many
keypoints, at a clear cost in time; it is best with the GPU and tiled detection.

## Keypoints per image
<!-- param: lgMaxKeypoints  default: 2048 -->
LightGlue with **Fast** density matches only this many of each image's strongest
keypoints; `0` removes the cap. LightGlue's attention compares every keypoint with every
other, so time grows with the square of this number. If detection stored more keypoints
than this, the dialog warns that the rest will not be matched; switch to **Full** rather
than raising the cap a long way. With **Full** density the same number is the
*Fallback keypoints per image*, used only for a pair whose coarse alignment fails.

## Keypoints per tile
<!-- param: lgTileBudget  default: 2048 -->
LightGlue with **Full** density: the most keypoints matched together in one aligned tile.
Tiles are sized so that an average tile holds about this many, so images with more
keypoints are cut into more tiles; an unusually dense tile keeps only this many. A higher
budget means fewer, larger tiles and more context per match, but each tile costs
quadratically more; lower it if the GPU runs out of memory.

## Cross-check (mutual NN)
<!-- param: crossCheck  default: on -->
Brute-force only. Keeps a match only when each keypoint is the other's nearest
neighbour, on top of the [ratio test](help:lowe-ratio-test). Without it, many keypoints
in one image can claim the same keypoint in the other; those many-to-one matches pad the
match count, lower every pair's inlier ratio and can let RANSAC fit a degenerate
geometry. It is on by default, as in COLMAP. Turning it off gives more matches and a
somewhat faster run, but expect more pairs rejected at verification.

## Ignore stationary points
<!-- param: filterStationary  default: off -->
Drops matches whose keypoint sits at almost the same pixel in both images, before
verification. A real scene point moves between two views with the
[baseline](help:baseline); a mark fixed to the camera or scanner does not: film
[fiducials](help:fiducial-marks), the frame edge and data strip, reseau crosses, scanner
dust or a lens blemish. Matched across every pair, such marks pull each pair's geometry
toward "no motion". On a set of unmasked 1978 film scans, 665 of 666 pairs were
accepted and the georeferencing missed by kilometres; with the filter on, all 37 cameras
registered and the checkpoints came within about 1 m.

Turn it on for scanned film and satellite frames that have not been masked or cropped.
A match counts as stationary when it moves at most 1 % of the image diagonal, so a
near-duplicate view (a burst, a hover) loses its matches too, which costs nothing because
such a pair has no parallax. It is off by default while it is being measured on more
datasets; the run summary says how many matches it dropped.

## Subset gate (fast pre-test)
<!-- param: subsetGate  default: on -->
Brute-force with exhaustive pairing only. Before the full match, each pair matches a
small, evenly spread sample of both images' keypoints; if too few sample matches
survive, the pair is assumed not to overlap and is skipped. This saves most of the time
on large unordered sets, where most pairs share nothing, but now and then it skips a
pair that would have matched. After the run, images left with fewer than six matched
pairs re-test their skipped pairs on a 4× larger sample, and those that pass are
matched in full.

The gate only runs with at least 50 pairs. Sequential and Preselect pairing have already
chosen overlapping pairs, so the dialog greys it out there and says why. Turn it off when
matching is fast anyway (GPU, few keypoints) or when images that should connect stay
apart.

## Subset size
<!-- param: subsetGateSize  default: 200 -->
The smallest sample of keypoints per image the subset gate matches. The actual sample
grows with the two images' keypoint counts (4 % of their geometric mean, up to 1000), so
the gate judges sets detected with many keypoints as fairly as small ones; this value
only sets the floor. A larger floor makes the gate more reliable on images with few
keypoints and slower on every pair.

## Min subset matches
<!-- param: subsetGateThreshold  default: 8 -->
How many sample matches a pair needs in the subset gate to go on to the full match.
Lower it if pairs with real but modest overlap are being skipped (the debug log lists
each gated pair with its score); raise it to skip more pairs and finish sooner.
Because the sample scales with the keypoint count, the same value means the same
thing at any detection setting.

## RANSAC verification
<!-- param: geometricVerification  default: on -->
Checks every pair's matches against one [epipolar geometry](help:epipolar-geometry): a
[fundamental matrix](help:fundamental-matrix) is fitted with [RANSAC](help:ransac), and
matches that do not fit it are discarded. This removes most of the false matches that
descriptors alone let through, and it is what the minimum inlier ratio and the weak-pair
rule are measured against. Matches on a [fisheye](help:fisheye-lens) sensor's images are
checked in that sensor's pinhole frame, where epipolar lines are straight; matches more
than 75° off-axis are left out. Turn it off only to inspect raw matches: every putative
match is then kept, including the wrong ones, and a pair is kept on its raw match count
alone.

## Estimator
<!-- param: verifier  default: RANSAC -->
How the fundamental matrix, and the homography used for the planar-scene check, are
fitted to the matches. **RANSAC** keeps the model that the most matches fit within the
threshold, then refits it on those matches. **[MAGSAC++](help:magsac)** draws the same
samples, but scores each model by a loss that grows smoothly with a match's distance up
to the threshold, and refines the best one by weighted least squares, so matches close
to the model count more than those near the threshold. Its geometry depends less on the
exact threshold. Either way a pair keeps the matches within the threshold of the final
model, so the inlier counts and the ratio gate mean the same.

MAGSAC++ costs about a fifth more verification time. On South Building and the quarry
set the two gave the same registered cameras and camera accuracy within run-to-run
noise, so RANSAC stays the default.

## RANSAC threshold
<!-- param: ransacThreshPx  default: 2.0 -->
The Sampson-distance tolerance for calling a match an inlier during
fundamental-matrix estimation: how far a point may sit from the
[epipolar line](help:epipolar-geometry) its partner predicts. Think of it as the same idea as
[reprojection error](help:reprojection-error): tighter means only well-localized
correspondences pass. Too tight throws away good matches; too loose lets outliers
masquerade as inliers.

The unit is **detection pixels** — pixels at the resolution the detector actually
ran at, which is capped by the detection step's *Detection resolution*. You do not need to
loosen this by hand for large images: keypoints are reported in full-resolution
coordinates, so websfm multiplies your value by the downscaling factor before use
and logs the result. A 10000 px scan detected at 2400 px gets a gate about 4×
wider in image pixels, because that is how coarsely its keypoints were measured in
the first place. Images detected at full resolution are unaffected.

`1–2 px` suits most imagery. Raise it if matching is rejecting pairs you can see
overlap; lower it if obviously wrong pairs are being accepted. With the MAGSAC++
estimator it is the largest distance a match may have; matches well inside it shape the
model more than those near it.

## RANSAC iterations
<!-- param: maxIters  default: 1000 -->
How many random minimal samples RANSAC (or MAGSAC++) draws while searching for the best
fundamental matrix. More iterations raise the chance of finding the correct model
when the inlier ratio is low, at a linear cost in time. The default is ample for
typical overlap; increase it only for hard pairs with many outliers.

## Min matches per pair
<!-- param: minMatches  default: 15 -->
The accept floor for an image pair: with verification on, a pair needs at least this
many verified matches to become an edge of the [match graph](help:match-graph). A pair
with only a handful of correspondences rarely yields a stable two-view geometry. Pairs
below the floor that still keep 15 or more inliers are not thrown away: they are kept
as *weak* pairs: PnP may use them to register a camera, but they never start the
reconstruction or triangulate points. With verification off this value can only lower the 15-match floor
below which a pair is skipped; raising it has no effect there.

## Min inlier ratio
<!-- param: minInlierRatio  default: 0.15 -->
Once RANSAC fits a fundamental matrix, this rejects the whole pair when the fraction
of raw matches that survive as inliers falls below the threshold. It is the main
defence against a *spurious* epipolar fit: on repetitive structure RANSAC can find a
fundamental matrix that explains a minority of matches while most are wrong. A
healthy pair usually retains well above `0.15`; raise it to be more aggressive about
dropping questionable pairs. A pair with 30 or more verified inliers passes regardless
of its ratio: that many inliers is real geometry, not the small spurious fit this
gate targets.

## Repair a split graph
<!-- param: repairSplits  default: on -->
Images taken from very different directions match poorly with each other: the
vertical and oblique cameras of an aerial mapping flight, a facade and the roof above
it, two strips flown at different heights. One matching pass can then leave the block
in pieces that are connected inside but not to each other, and
[sparse reconstruction](guide:sparse-reconstruction) can only place them apart.

With this on, matching checks the [match graph](help:match-graph) when it has run. For
each piece of at least two images it takes the most promising pairs between that piece
and the largest one, and matches them again:

1. pairs that were rejected with at least 8 putative matches, the closest misses first;
2. pairs never tried, because preselection left them out, whose footprints overlap
   most (or whose cameras are closest);
3. the other rejected pairs.

Up to 12 pairs per piece and 48 in all are matched again, without the subset gate, with
a ratio test of 0.9 instead of 0.8, a minimum inlier ratio of 8 %, and the MAGSAC++
estimator; LightGlue gets twice the keypoints. F-RANSAC still verifies every pair, so a
pair is accepted only when its matches fit one epipolar geometry. While the main block
keeps growing this repeats, up to three rounds, each with pairs not tried before. The
log says how many pieces there were, how many pairs each round tried, and how large the
main block is afterwards.
A pair you excluded is never tried. Single images that match nothing are left alone:
they are usually blurred or show no overlapping ground.

## GPU acceleration
With **Use GPU** on (Settings → Compute; on by default when the browser offers
WebGPU), the brute-force matcher computes descriptor distances on the graphics
card — typically one to two orders of magnitude faster than the CPU path — and
gives the same matches. Geometric verification still runs on the CPU workers.

The first pair of every run is matched on both backends and the log prints a
**GPU validate** line comparing them. If they disagree beyond a few borderline ties,
the rest of the run switches to the CPU automatically; a GPU error on any single pair
also falls back to the CPU for that pair. The end-of-run **Matching GPU summary**
says how many pairs ran where. LightGlue uses its own GPU path and is unaffected.

Because exhaustive matching becomes cheap on the GPU, consider turning the **Subset gate (fast pre-test)**
off for unordered image sets: the gate saves time by skipping pairs that look
non-overlapping on a small sample, and occasionally skips a pair that would have
matched.

## Read the timing report
After matching, the log reports wall time and summed pair times for descriptor
loading, descriptor serialization, matching, and geometric verification. Worker
times include backend initialization when cold. Queue/transport time is reported
as the remaining round-trip time. Concurrent stage totals can exceed wall time;
use comparable image sets, worker counts and settings when judging a change.
