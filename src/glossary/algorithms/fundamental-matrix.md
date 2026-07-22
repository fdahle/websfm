---
id: fundamental-matrix
title: Fundamental Matrix
aliases: F matrix, fundamental matrices
summary: The 3×3 matrix encoding the epipolar geometry between two uncalibrated images; maps a point in one image to its epipolar line in the other.
---
The **fundamental matrix** $F$ is the algebraic form of
[epipolar geometry](help:epipolar-geometry) for two **uncalibrated** views. For
corresponding pixels $x$ and $x'$ it satisfies

$$x'^{\top} F \, x = 0,$$

which says exactly that $x'$ lies on the line $l' = F x$ — the epipolar line
induced in the second image by the point $x$ in the first. $F$ is 3×3, rank 2
(both epipoles are its null vectors), and defined only up to scale, leaving
**seven degrees of freedom**.

Unlike its calibrated cousin the [essential matrix](help:essential-matrix), $F$
needs no knowledge of [camera intrinsics](help:camera-intrinsics) — it absorbs
them, $F = K'^{-\top} E K^{-1}$. That is precisely why WebSfM verifies matches
with $F$ rather than $E$: pair verification runs before intrinsics are known to
be trustworthy, and before any self-calibration has happened.

<!-- TODO(image): assets/fundamental-matrix.svg - a point x in the left image, the ray it back-projects to, and that ray imaged in the right view as the epipolar line l' = Fx, with a correct match on the line and an outlier match flagged off it. -->

**Match verification** is its main job here. Given the putative matches of an
image pair, [RANSAC](help:ransac) samples 8 correspondences at a time, fits $F$,
and counts inliers by the distance from each point to its predicted epipolar
line. Matches far from the line are geometrically impossible for *any* rigid
camera motion, and are dropped.

Two failure modes deserve care, because both produce a confident-looking $F$
from bad data:

- **Degenerate scenes.** If the matched points all lie on one plane (or all
  cameras share a centre), a [homography](help:homography) explains them and $F$
  becomes underdetermined — the extra freedom fits noise. WebSfM measures this by
  fitting an H alongside the F and comparing inlier counts, but treats the result
  as a *seed-quality label only*, never as an accept/reject gate.
- **Repetitive structure.** A regular façade or a rippled snow surface can hand
  RANSAC a large, self-consistent set of wrong matches. A count or ratio gate
  cannot see this, so acceptance also requires that the inliers be spatially
  spread out, and, later, that the pair's implied relative rotation be consistent
  around cycles of the [match graph](help:match-graph).
