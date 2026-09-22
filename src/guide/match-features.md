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

## Ratio threshold
<!-- param: ratioThreshold  default: 0.75 -->
Lowe's ratio test keeps a match only when the best descriptor match is clearly
closer than the second-best — specifically, when `best / second-best` is below this
threshold. **Lower is stricter**: fewer matches, but the ones that survive are more
trustworthy.

Raise it toward `0.9` if you are getting too few matches on low-texture imagery
(snow, ice, uniform terrain); lower it toward `0.6` on repetitive structure
(building façades, sea-ice floes, crop rows) where near-identical descriptors would
otherwise produce confident-looking false matches. Only applies to the brute-force
matcher; LightGlue decides acceptance internally.

## Min matches per pair
<!-- param: minMatches  default: 15 -->
After matching and verification, discard any image pair left with fewer than this
many matches. A pair with only a handful of correspondences rarely yields a stable
two-view geometry and tends to inject noise into the reconstruction graph. Lower it
only if your overlap is genuinely marginal and you would rather have a weak link
than none.

## Min inlier ratio
<!-- param: minInlierRatio  default: 0.15 -->
Once RANSAC fits a fundamental matrix, this rejects the whole pair when the fraction
of raw matches that survive as inliers falls below the threshold. It is the main
defence against a *spurious* epipolar fit: on repetitive structure RANSAC can find a
fundamental matrix that explains a minority of matches while most are wrong. A
healthy pair usually retains well above `0.15`; raise it to be more aggressive about
dropping questionable pairs.

## RANSAC threshold
<!-- param: ransacThreshPx  default: 2.0 -->
The Sampson-distance tolerance for calling a match an inlier during
fundamental-matrix estimation. Think of it as the same idea as
[reprojection error](help:reprojection-error): tighter means only well-localized
correspondences pass. Too tight throws away good matches; too loose lets outliers
masquerade as inliers.

The unit is **detection pixels** — pixels at the resolution the detector actually
ran at, which is capped by the detection step's *Max dimension*. You do not need to
loosen this by hand for large images: keypoints are reported in full-resolution
coordinates, so websfm multiplies your value by the downscaling factor before use
and logs the result. A 10000 px scan detected at 2400 px gets a gate about 4×
wider in image pixels, because that is how coarsely its keypoints were measured in
the first place. Images detected at full resolution are unaffected.

`1–2 px` suits most imagery. Raise it if matching is rejecting pairs you can see
overlap; lower it if obviously wrong pairs are being accepted.

## RANSAC iterations
<!-- param: maxIters  default: 1000 -->
How many random minimal samples RANSAC draws while searching for the best
fundamental matrix. More iterations raise the chance of finding the correct model
when the inlier ratio is low, at a linear cost in time. The default is ample for
typical overlap; increase it only for hard pairs with many outliers.

## Neighbours per image
<!-- param: maxNeighbors  default: 10 -->
Used by the **Preselect** strategy: instead of matching every pair (an $O(N^2)$
explosion on large blocks), match each image only to its N nearest neighbours by
EXIF-derived or imported camera position. Lower N is faster but risks missing real overlap on
cross-strip or looping flight lines; raise it when the flight geometry is dense or
irregular. Needs imported poses — images without one fall back to exhaustive
matching.

## Following images
<!-- param: sequentialOverlap  default: 10 -->
Used by the **Sequential** strategy when GPS or imported camera positions are not
available. Each image is matched to the next N images in capture order, retaining
overlapping views while reducing exhaustive $O(N^2)$ matching to approximately
$O(N \cdot w)$ for a window of $w$ images. Ten is a good starting point for a smoothly captured orbit.
Enable **Close capture loop** when the sequence makes a complete circuit so the
last frames also match the first frames. This assumes the image list follows
capture order (normally filename/EXIF order).
